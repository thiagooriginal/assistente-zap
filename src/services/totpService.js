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
 * - One-time recovery codes
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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
function generateToken(secretBase32, { stepDelta = 0, timestampMs = Date.now(), digits = 6 } = {}) {
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
function verifyToken(token, secretBase32, { window = 1, timestampMs = Date.now(), digits = 6 } = {}) {
  if (!token || !secretBase32) return { valid: false, reason: 'missing_parameters' };

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
 * Generate single-use alphanumeric recovery codes
 */
function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // 8-character hex code formatted as XXXX-XXXX
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

/**
 * Generate standard otpauth URI for QR code generators / Authenticator apps
 */
function generateOtpAuthUri({ secret, accountName = 'admin@raiaagentes.com.br', issuer = 'RAIA AGENTES' }) {
  const encIssuer = encodeURIComponent(issuer);
  const encAccount = encodeURIComponent(accountName);
  return `otpauth://totp/${encIssuer}:${encAccount}?secret=${secret}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  generateSecret,
  generateToken,
  verifyToken,
  generateRecoveryCodes,
  generateOtpAuthUri,
  base32Encode,
  base32Decode,
};
