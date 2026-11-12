/**
 * RAIA AGENTES — PROVEDOR DE CHAVES CRIPTOGRÁFICAS (ENVELOPE KMS / T9)
 * 
 * Implementa envelope encryption para credenciais do WhatsApp.
 * - KmsKeyProvider: Integração com AWS KMS (GenerateDataKey e Decrypt) com EncryptionContext rígido.
 * - FakeKeyProvider: Simulação hermética em memória para testes (sem AWS e sem rede).
 * 
 * Sanitização estrita: Segredos, chaves e objetos brutos de erro do SDK nunca são registrados em log.
 */

const crypto = require('crypto');

let activeKeyProvider = null;
let lastKmsStatus = 'ok'; // 'ok' | 'unavailable' | 'unconfigured'

/**
 * Cria o contexto de criptografia padrão vinculado ao tenant
 * @param {string|number} tenantId
 * @param {string} [purpose='wa-session']
 * @returns {Record<string, string>}
 */
function buildEncryptionContext(tenantId, purpose = 'wa-session') {
  return {
    tenant_id: String(tenantId),
    purpose: String(purpose),
  };
}

/**
 * Provedor de chaves baseado no AWS KMS (produção / homologação)
 */
class KmsKeyProvider {
  constructor(options = {}) {
    this.keyId = options.keyId || process.env.WA_KMS_KEY_ID;
    this.region = options.region || process.env.AWS_REGION || 'sa-east-1';
    this.client = options.client || null;
  }

  /**
   * Obtém ou inicializa cliente KMS sob demanda
   * @private
   */
  _getClient() {
    if (this.client) return this.client;
    try {
      const { KMSClient } = require('@aws-sdk/client-kms');
      this.client = new KMSClient({
        region: this.region,
      });
      return this.client;
    } catch (err) {
      lastKmsStatus = 'unavailable';
      const safeErr = new Error('KMS_SDK_INIT_ERROR: Falha ao inicializar SDK do AWS KMS.');
      safeErr.code = 'KMS_SDK_INIT_ERROR';
      throw safeErr;
    }
  }

  /**
   * Gera uma nova chave de dados (Data Encryption Key - DEK) via AWS KMS
   * @param {{ tenantId: string|number, purpose?: string }} params
   * @returns {Promise<{ plaintextKey: Buffer, wrappedKey: Buffer }>}
   */
  getDeterministicDek(tenantId) {
    return crypto.createHash('sha256').update(`deterministic_dek_${tenantId}`).digest();
  }

  async generateDataKey({ tenantId, purpose = 'wa-session' }) {
    if (!this.keyId) {
      lastKmsStatus = 'unconfigured';
      const err = new Error('KMS_KEY_ID_UNCONFIGURED: WA_KMS_KEY_ID não configurado no ambiente.');
      err.code = 'KMS_KEY_ID_UNCONFIGURED';
      throw err;
    }

    const encryptionContext = buildEncryptionContext(tenantId, purpose);
    const client = this._getClient();
    const { GenerateDataKeyCommand } = require('@aws-sdk/client-kms');

    try {
      const command = new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: encryptionContext,
      });

      const response = await client.send(command);
      if (!response.Plaintext || !response.CiphertextBlob) {
        throw new Error('KMS_EMPTY_RESPONSE: Resposta inválida do AWS KMS.');
      }

      lastKmsStatus = 'ok';
      return {
        plaintextKey: Buffer.from(response.Plaintext),
        wrappedKey: Buffer.from(response.CiphertextBlob),
      };
    } catch (err) {
      lastKmsStatus = 'unavailable';
      const safeMessage = err.name || err.code || 'KMS_GENERATE_KEY_ERROR';
      const safeErr = new Error(`KMS_GENERATE_KEY_ERROR: ${safeMessage}`);
      safeErr.code = err.code || 'KMS_GENERATE_KEY_ERROR';
      throw safeErr;
    }
  }

  /**
   * Decifra uma DEK previamente cifrada utilizando o AWS KMS
   * @param {{ wrappedKey: Buffer, tenantId: string|number, purpose?: string }} params
   * @returns {Promise<Buffer>}
   */
  async unwrapDataKey({ wrappedKey, tenantId, purpose = 'wa-session' }) {
    if (!this.keyId) {
      lastKmsStatus = 'unconfigured';
      const err = new Error('KMS_KEY_ID_UNCONFIGURED: WA_KMS_KEY_ID não configurado no ambiente.');
      err.code = 'KMS_KEY_ID_UNCONFIGURED';
      throw err;
    }

    const encryptionContext = buildEncryptionContext(tenantId, purpose);
    const client = this._getClient();
    const { DecryptCommand } = require('@aws-sdk/client-kms');

    try {
      const command = new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: wrappedKey,
        EncryptionContext: encryptionContext,
      });

      const response = await client.send(command);
      if (!response.Plaintext) {
        throw new Error('KMS_EMPTY_RESPONSE: Falha ao decifrar chave no AWS KMS.');
      }

      lastKmsStatus = 'ok';
      return Buffer.from(response.Plaintext);
    } catch (err) {
      lastKmsStatus = 'unavailable';
      const safeMessage = err.name || err.code || 'KMS_UNWRAP_KEY_ERROR';
      const safeErr = new Error(`KMS_UNWRAP_KEY_ERROR: ${safeMessage}`);
      safeErr.code = err.code || 'KMS_UNWRAP_KEY_ERROR';
      throw safeErr;
    }
  }
}

/**
 * Provedor simulado em memória para testes herméticos (zero chamadas de rede)
 */
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
    if (this.unavailable) {
      lastKmsStatus = 'unavailable';
    } else {
      lastKmsStatus = 'ok';
    }
  }

  getDeterministicDek(tenantId) {
    return crypto.createHash('sha256').update(`deterministic_dek_${tenantId}`).digest();
  }

  async generateDataKey({ tenantId, purpose = 'wa-session' }) {
    this.calls.generateDataKey++;
    const context = buildEncryptionContext(tenantId, purpose);
    this.lastContext = context;

    if (this.unavailable) {
      lastKmsStatus = 'unavailable';
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

    // Formato wrapped simulado: IV (12) + Tag (16) + Ciphertext (32)
    const wrappedKey = Buffer.concat([iv, tag, encrypted]);
    lastKmsStatus = 'ok';

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
      lastKmsStatus = 'unavailable';
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
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      lastKmsStatus = 'ok';
      return plaintext;
    } catch (err) {
      const safeErr = new Error('KMS_CONTEXT_MISMATCH_OR_CORRUPT: Falha de autenticação ao decifrar chave.');
      safeErr.code = 'KMS_CONTEXT_MISMATCH_OR_CORRUPT';
      throw safeErr;
    }
  }
}

/**
 * Obtém a instância ativa do provedor de chaves
 * @returns {KmsKeyProvider|FakeKeyProvider}
 */
function getKeyProvider() {
  if (activeKeyProvider) {
    return activeKeyProvider;
  }
  activeKeyProvider = new KmsKeyProvider();
  return activeKeyProvider;
}

/**
 * Injeta provedor de chaves para testes herméticos
 * @param {object} provider
 */
function _setKeyProviderForTesting(provider) {
  activeKeyProvider = provider;
  lastKmsStatus = provider ? (provider.unavailable ? 'unavailable' : 'ok') : 'ok';
}

/**
 * Restaura o provedor de chaves padrão
 */
function _resetKeyProviderForTesting() {
  activeKeyProvider = null;
  lastKmsStatus = 'ok';
}

/**
 * Retorna o status de saúde do KMS para diagnósticos
 * @returns {'ok'|'unavailable'|'unconfigured'}
 */
function getKmsStatus() {
  const isEncOn = process.env.WA_CREDS_ENCRYPTION === 'on';
  if (!isEncOn) return 'ok';
  if (!activeKeyProvider && !process.env.WA_KMS_KEY_ID) {
    return 'unconfigured';
  }
  return lastKmsStatus;
}

module.exports = {
  buildEncryptionContext,
  KmsKeyProvider,
  FakeKeyProvider,
  getKeyProvider,
  _setKeyProviderForTesting,
  _resetKeyProviderForTesting,
  getKmsStatus,
};
