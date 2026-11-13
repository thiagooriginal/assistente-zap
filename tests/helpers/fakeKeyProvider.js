/**
 * RAIA AGENTES — PROVEDOR FALSO DE CHAVES PARA TESTES HERMÉTICOS
 * 
 * Simula em memória o envelope encryption sem qualquer conexão à AWS ou rede.
 * Utilizado exclusivamente em suítes de teste herméticas.
 */

const crypto = require('crypto');
const { buildEncryptionContext } = require('../../src/security/keyProvider');

class FakeKeyProvider {
  constructor() {
    this.masterKey = crypto.randomBytes(32);
    this.unavailable = false;
    this.calls = {
      generateDataKey: 0,
      unwrapDataKey: 0,
    };
    this.lastContext = null;
  }

  setUnavailable(flag = true) {
    this.unavailable = Boolean(flag);
  }

  getDeterministicDek(tenantId) {
    return crypto.createHash('sha256').update(`deterministic_dek_${tenantId}`).digest();
  }

  async generateDataKey({ tenantId, purpose = 'wa-session' }) {
    this.calls.generateDataKey++;
    const context = buildEncryptionContext(tenantId, purpose);
    this.lastContext = context;

    if (this.unavailable) {
      const err = new Error('KMS_UNAVAILABLE: Simulação de indisponibilidade do serviço KMS.');
      err.code = 'KMS_UNAVAILABLE';
      throw err;
    }

    const plaintextKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const aad = Buffer.from(JSON.stringify(context), 'utf8');

    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrappedKey = Buffer.concat([iv, tag, encrypted]);

    return {
      plaintextKey,
      wrappedKey,
    };
  }

  async unwrapDataKey({ wrappedKey, tenantId, purpose = 'wa-session' }) {
    this.calls.unwrapDataKey++;
    const context = buildEncryptionContext(tenantId, purpose);
    this.lastContext = context;

    if (this.unavailable) {
      const err = new Error('KMS_UNAVAILABLE: Simulação de indisponibilidade do serviço KMS.');
      err.code = 'KMS_UNAVAILABLE';
      throw err;
    }

    if (!Buffer.isBuffer(wrappedKey) || wrappedKey.length < 28) {
      throw new Error('INVALID_WRAPPED_KEY: Chave cifrada inválida.');
    }

    const iv = wrappedKey.subarray(0, 12);
    const tag = wrappedKey.subarray(12, 28);
    const encrypted = wrappedKey.subarray(28);
    const aad = Buffer.from(JSON.stringify(context), 'utf8');

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (err) {
      const safeErr = new Error('KMS_CONTEXT_MISMATCH_OR_CORRUPT: Falha de autenticação ao decifrar chave.');
      safeErr.code = 'KMS_CONTEXT_MISMATCH_OR_CORRUPT';
      throw safeErr;
    }
  }
}

module.exports = {
  FakeKeyProvider,
};
