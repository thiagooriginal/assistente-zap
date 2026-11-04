const crypto = require('crypto');

/**
 * RAIA AGENTES — TOTP (Time-based One-Time Password) Service
 * 
 * Complies with RFC 6238 (TOTP) and RFC 4226 (HOTP) using pure Node.js crypto.
 * Implements Proteção 01 & 09 (Independent Multi-Factor Authentication):
 * - Standard 30-second time window
 * - HMAC-SHA1 dynamic truncation
 * - 6-digit numeric codes
 * - Clock drift tolerance (window: ±1 step = ±30s)
 * - Base32 secret generation and decoding
 * - Secure hashed one-time recovery codes
 * - AES-256-GCM encryption at rest for TOTP secrets with key external to SQLite
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Returns the primary encryption key for MFA at rest.
 * In production, strictly requires its own independent MFA_ENCRYPTION_KEY (Proteção 01, 11).
 */
function getPrimaryMfaKey() {
  const isStaging = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging';
  const isProduction = process.env.NODE_ENV === 'production' && !isStaging;

  // In production, strictly require independent MFA_ENCRYPTION_KEY (no fallback to session secrets)
  if (isProduction) {
    const mfaSecret = (process.env.MFA_ENCRYPTION_KEY || '').trim();
    if (!mfaSecret || mfaSecret === 'raia-mfa-default-key-fallback' || mfaSecret.length < 16) {
      throw new Error('MFA_ENCRYPTION_KEY obrigatória e independente não configurada ou insuficiente em produção (mínimo 16 caracteres).');
    }
    if (mfaSecret === process.env.SESSION_SECRET || mfaSecret === process.env.CLIENT_AUTH_SECRET) {
      throw new Error('MFA_ENCRYPTION_KEY não pode reutilizar SESSION_SECRET ou CLIENT_AUTH_SECRET em produção.');
    }
    return crypto.createHash('sha256').update(mfaSecret).digest();
  }

  // Non-production (staging/dev/test): allow configured key or dev fallback
  const devSecret = (process.env.MFA_ENCRYPTION_KEY || process.env.SESSION_SECRET || process.env.CLIENT_AUTH_SECRET || '').trim();
  if (!devSecret || devSecret === 'raia-mfa-default-key-fallback') {
    return crypto.createHash('sha256').update('raia-mfa-dev-test-isolated-key').digest();
  }

  return crypto.createHash('sha256').update(devSecret).digest();
}

/**
 * Returns candidate decryption keys to preserve access to existing records
 * during key rotation or migrations without losing legitimate access.
 */
function getCandidateDecryptionKeys({ includeLegacy = true } = {}) {
  const isStaging = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging';
  const isProduction = process.env.NODE_ENV === 'production' && !isStaging;
  const keys = [];

  try {
    keys.push(getPrimaryMfaKey());
  } catch (_) {}

  // Candidate from MFA_ENCRYPTION_KEY
  if (process.env.MFA_ENCRYPTION_KEY) {
    const k = crypto.createHash('sha256').update(process.env.MFA_ENCRYPTION_KEY.trim()).digest();
    if (!keys.some(x => x.equals(k))) keys.push(k);
  }

  // Candidate from SESSION_SECRET (for historical records encrypted prior to key separation)
  if (process.env.SESSION_SECRET) {
    const k = crypto.createHash('sha256').update(process.env.SESSION_SECRET.trim()).digest();
    if (!keys.some(x => x.equals(k))) keys.push(k);
  }

  // Candidate from CLIENT_AUTH_SECRET
  if (process.env.CLIENT_AUTH_SECRET) {
    const k = crypto.createHash('sha256').update(process.env.CLIENT_AUTH_SECRET.trim()).digest();
    if (!keys.some(x => x.equals(k))) keys.push(k);
  }

  // Legacy fallback keys: strictly for migrating pre-existing records during transition
  const disableLegacy = process.env.MFA_DISABLE_LEGACY_KEYS === 'true';
  if (includeLegacy && !disableLegacy) {
    const legacyFallback = crypto.createHash('sha256').update('raia-mfa-default-key-fallback').digest();
    if (!keys.some(x => x.equals(legacyFallback))) keys.push(legacyFallback);

    if (!isProduction) {
      const devFallback = crypto.createHash('sha256').update('raia-mfa-dev-test-isolated-key').digest();
      if (!keys.some(x => x.equals(devFallback))) keys.push(devFallback);
    }
  }

  return keys;
}

/**
 * Encrypt a plain Base32 secret at rest using AES-256-GCM with primary key
 */
function encryptSecret(plainBase32Secret) {
  if (!plainBase32Secret || typeof plainBase32Secret !== 'string') return plainBase32Secret;
  if (plainBase32Secret.startsWith('enc:v1:')) return plainBase32Secret; // Already encrypted
  const key = getPrimaryMfaKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainBase32Secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an AES-256-GCM encrypted TOTP secret using multi-key candidate resolution
 */
function decryptSecret(storedSecret) {
  if (!storedSecret || typeof storedSecret !== 'string') return storedSecret;
  if (!storedSecret.startsWith('enc:v1:')) return storedSecret; // Plain Base32 backwards-compatible

  const parts = storedSecret.split(':');
  if (parts.length !== 5) return null;
  const iv = Buffer.from(parts[2], 'hex');
  const authTag = Buffer.from(parts[3], 'hex');
  const encryptedText = parts[4];

  const candidateKeys = getCandidateDecryptionKeys();
  for (const key of candidateKeys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      if (decrypted && decrypted.length >= 16) {
        return decrypted;
      }
    } catch (_) {
      // Try next candidate key
    }
  }

  console.error('[TOTP Service] Falha ao descriptografar segredo TOTP com chaves disponíveis.');
  return null;
}

/**
 * Hash a recovery code for secure storage at rest (HMAC-SHA256 with pepper)
 */
function hashRecoveryCode(code, key = null) {
  if (!code || typeof code !== 'string') return '';
  const clean = code.toUpperCase().replace(/[\s-]/g, '').trim();
  const masterKey = key || getPrimaryMfaKey();
  return crypto.createHmac('sha256', masterKey).update(clean).digest('hex');
}

/**
 * Generate 8 random alphanumeric recovery codes with hashes
 */
function generateHashedRecoveryCodes(count = 8) {
  const plainCodes = [];
  const hashedCodes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    plainCodes.push(formatted);
    hashedCodes.push(hashRecoveryCode(formatted));
  }
  return { plainCodes, hashedCodes };
}

/**
 * Verify a user-submitted recovery code against an array of stored hashes with candidate key fallback
 */
function verifyRecoveryCode(candidateCode, hashedCodes) {
  if (!candidateCode || !Array.isArray(hashedCodes) || hashedCodes.length === 0) {
    return { valid: false, matchedIndex: -1 };
  }

  const candidateKeys = getCandidateDecryptionKeys();
  for (const key of candidateKeys) {
    const candidateHash = hashRecoveryCode(candidateCode, key);
    const candBuf = Buffer.from(candidateHash, 'hex');

    for (let i = 0; i < hashedCodes.length; i++) {
      const storedHash = hashedCodes[i];
      if (typeof storedHash !== 'string') continue;
      const storedBuf = Buffer.from(storedHash, 'hex');
      if (storedBuf.length === candBuf.length && crypto.timingSafeEqual(storedBuf, candBuf)) {
        return { valid: true, matchedIndex: i };
      }
    }
  }

  return { valid: false, matchedIndex: -1 };
}

/**
 * Encode a Buffer into a Base32 string (RFC 4648)
 */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decode a Base32 string into a Buffer (RFC 4648)
 */
function base32Decode(input) {
  if (!input || typeof input !== 'string') return Buffer.alloc(0);

  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue; // Skip invalid chars

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generate a random Base32 TOTP secret (20 bytes = 160 bits entropy)
 */
function generateSecret(byteLength = 20) {
  const randomBytes = crypto.randomBytes(byteLength);
  return base32Encode(randomBytes);
}

/**
 * Generate a 6-digit TOTP token for a given timestamp and secret
 */
function generateToken(secretBase32OrEncrypted, { stepDelta = 0, timestampMs = Date.now(), digits = 6 } = {}) {
  const secretBase32 = decryptSecret(secretBase32OrEncrypted);
  const key = base32Decode(secretBase32);
  if (!key || key.length === 0) return '';

  const step = Math.floor(timestampMs / 1000 / 30) + stepDelta;
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(step));

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % (10 ** digits);
  return String(otp).padStart(digits, '0');
}

/**
 * Verify a user-submitted TOTP code against a secret with window tolerance
 * window = 1 allows current step, 1 step back (-30s) and 1 step forward (+30s)
 */
function verifyToken(token, secretBase32OrEncrypted, { window = 1, timestampMs = Date.now(), digits = 6 } = {}) {
  if (!token || !secretBase32OrEncrypted) return { valid: false, reason: 'missing_parameters' };

  const secretBase32 = decryptSecret(secretBase32OrEncrypted);
  if (!secretBase32) return { valid: false, reason: 'invalid_secret' };

  const cleanToken = String(token).trim().replace(/\s+/g, '');
  if (cleanToken.length !== digits || !/^\d+$/.test(cleanToken)) {
    return { valid: false, reason: 'invalid_format' };
  }

  for (let delta = -window; delta <= window; delta++) {
    const expected = generateToken(secretBase32, { stepDelta: delta, timestampMs, digits });
    if (crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(expected))) {
      return { valid: true, stepDelta: delta };
    }
  }

  return { valid: false, reason: 'token_mismatch_or_expired' };
}

/**
 * Generate legacy single-use alphanumeric recovery codes (returns array of strings)
 */
function generateRecoveryCodes(count = 8) {
  const { plainCodes } = generateHashedRecoveryCodes(count);
  return plainCodes;
}

/**
 * Generate standard otpauth URI for QR code generators / Authenticator apps
 */
function generateOtpAuthUri({ secret, accountName = 'admin@raiaagentes.com.br', issuer = 'RAIA AGENTES' }) {
  const cleanSecret = decryptSecret(secret) || secret;
  const encIssuer = encodeURIComponent(issuer);
  const encAccount = encodeURIComponent(accountName);
  return `otpauth://totp/${encIssuer}:${encAccount}?secret=${cleanSecret}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Safe Migration and Re-encryption of existing MFA secrets under the primary key
 * Guarantees zero downtime and safe decommission of legacy fallback keys.
 */
function migrateMfaSecrets(dbInstance) {
  if (!dbInstance || typeof dbInstance.prepare !== 'function') {
    throw new Error('Database instance is required for MFA migration.');
  }

  const primaryKey = getPrimaryMfaKey();
  const users = dbInstance.prepare("SELECT id, totp_secret, totp_recovery_codes FROM users WHERE totp_secret IS NOT NULL").all();

  let scanned = 0;
  let migrated = 0;
  let alreadyCurrent = 0;
  let failed = 0;

  for (const user of users) {
    scanned++;
    const storedSecret = user.totp_secret;
    const decrypted = decryptSecret(storedSecret);

    if (!decrypted) {
      failed++;
      console.error(`[MFA Migration] ALERTA: Não foi possível descriptografar o segredo do usuário #${user.id}.`);
      continue;
    }

    // Check if storedSecret is already encrypted with the current primary key
    let isCurrent = false;
    if (storedSecret.startsWith('enc:v1:')) {
      const parts = storedSecret.split(':');
      if (parts.length === 5) {
        try {
          const iv = Buffer.from(parts[2], 'hex');
          const authTag = Buffer.from(parts[3], 'hex');
          const decipher = crypto.createDecipheriv('aes-256-gcm', primaryKey, iv);
          decipher.setAuthTag(authTag);
          let testDec = decipher.update(parts[4], 'hex', 'utf8');
          testDec += decipher.final('utf8');
          if (testDec === decrypted) {
            isCurrent = true;
          }
        } catch (_) {
          isCurrent = false;
        }
      }
    }

    if (isCurrent) {
      alreadyCurrent++;
      continue;
    }

    // Re-encrypt with primary key
    const newEncryptedSecret = encryptSecret(decrypted);
    dbInstance.prepare("UPDATE users SET totp_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newEncryptedSecret, user.id);
    migrated++;
  }

  return { scanned, migrated, alreadyCurrent, failed };
}

module.exports = {
  getPrimaryMfaKey,
  getCandidateDecryptionKeys,
  migrateMfaSecrets,
  encryptSecret,
  decryptSecret,
  hashRecoveryCode,
  generateHashedRecoveryCodes,
  verifyRecoveryCode,
  generateSecret,
  generateToken,
  generateCurrentTOTP: (secret) => generateToken(secret),
  verifyToken,
  generateRecoveryCodes,
  generateOtpAuthUri,
};
