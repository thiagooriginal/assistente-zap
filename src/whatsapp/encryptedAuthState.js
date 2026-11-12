/**
 * RAIA AGENTES — ARMAZENAMENTO CIFRADO DE SESSÕES WHATSAPP (T9 / ENVELOPE KMS)
 * 
 * Implementa useEncryptedMultiFileAuthState compatível com o Baileys v7.
 * - Todos os arquivos de sessão possuem sufixo .enc (ex: creds.json.enc, pre-key-*.json.enc).
 * - Criptografia autenticada AES-256-GCM.
 * - Cabeçalho binário: RAIAENC1 (8 bytes) + versão (1 byte: 0x01) + IV (12 bytes) + Tag (16 bytes) + Ciphertext.
 * - AAD vincula rigidamente o tenantId e o nome do arquivo original: `wa:${tenantId}:${originalFileName}`.
 * - Gravação atômica: escrita em .tmp, fsync e rename atômico.
 * - Concorrência serializada por arquivo.
 * - Chave DEK mantida em memória por salão e zerada com .fill(0) na desconexão.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const { getKeyProvider } = require('../security/keyProvider');

const MAGIC_HEADER = Buffer.from('RAIAENC1', 'ascii'); // 8 bytes
const CURRENT_VERSION = 0x01; // 1 byte
const HEADER_LENGTH = 8 + 1 + 12 + 16; // 37 bytes: Magic(8) + Version(1) + IV(12) + Tag(16)

// Cache em memória de chaves abertas (DEK) por tenant: tenantId -> Buffer(32)
const tenantDekCache = new Map();

// Mutex simples por caminho de arquivo para serializar gravações concorrentes
const fileLocks = new Map();

/**
 * Serializador de promessas por caminho de arquivo
 * @param {string} filePath
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function withFileLock(filePath, fn) {
  let lockPromise = fileLocks.get(filePath) || Promise.resolve();
  let release;
  const nextLock = new Promise((resolve) => {
    release = resolve;
  });
  fileLocks.set(filePath, nextLock);

  try {
    await lockPromise;
    return await fn();
  } finally {
    release();
    if (fileLocks.get(filePath) === nextLock) {
      fileLocks.delete(filePath);
    }
  }
}

/**
 * Normaliza o nome do arquivo conforme convenção Baileys
 * @param {string} file
 * @returns {string}
 */
function fixFileName(file) {
  return file?.replace(/\//g, '__')?.replace(/:/g, '-');
}

/**
 * Constrói o Additional Authenticated Data (AAD) vinculando tenant e arquivo
 * @param {string|number} tenantId
 * @param {string} fileName Nome original do arquivo (sem extensão .enc)
 * @returns {Buffer}
 */
function buildAad(tenantId, fileName) {
  return Buffer.from(`wa:${tenantId}:${fileName}`, 'utf8');
}

/**
 * Cifra um buffer ou string utilizando a DEK do tenant com AAD
 * @param {Buffer|string} plaintext
 * @param {Buffer} dek Chave de 32 bytes
 * @param {{ tenantId: string|number, fileName: string }} options
 * @returns {Buffer}
 */
function encryptBuffer(plaintext, dek, { tenantId, fileName }) {
  if (!Buffer.isBuffer(dek) || dek.length !== 32) {
    throw new Error('INVALID_DEK: A chave DEK deve possuir exatamente 32 bytes.');
  }

  const inputBuffer = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const iv = crypto.randomBytes(12);
  const aad = buildAad(tenantId, fileName);

  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(inputBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  const versionBuf = Buffer.from([CURRENT_VERSION]);
  return Buffer.concat([MAGIC_HEADER, versionBuf, iv, tag, ciphertext]);
}

/**
 * Decifra um buffer cifrado no formato RAIAENC1
 * @param {Buffer} encBuffer
 * @param {Buffer} dek Chave de 32 bytes
 * @param {{ tenantId: string|number, fileName: string }} options
 * @returns {Buffer}
 */
function decryptBuffer(encBuffer, dek, { tenantId, fileName }) {
  if (!Buffer.isBuffer(dek) || dek.length !== 32) {
    throw new Error('INVALID_DEK: A chave DEK deve possuir exatamente 32 bytes.');
  }
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < HEADER_LENGTH) {
    throw new Error('CORRUPT_ENCRYPTED_FILE: Tamanho insuficiente para arquivo cifrado.');
  }

  // Validação do Magic Header
  const magic = encBuffer.subarray(0, 8);
  if (!magic.equals(MAGIC_HEADER)) {
    throw new Error('INVALID_FILE_HEADER: Cabeçalho mágico inválido (esperado RAIAENC1).');
  }

  // Validação de versão
  const version = encBuffer[8];
  if (version !== CURRENT_VERSION) {
    throw new Error(`UNSUPPORTED_VERSION: Versão de cifra não suportada (${version}).`);
  }

  const iv = encBuffer.subarray(9, 21);
  const tag = encBuffer.subarray(21, 37);
  const ciphertext = encBuffer.subarray(37);
  const aad = buildAad(tenantId, fileName);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    // Falha de autenticação (adulteração, AAD incorreto ou chave errada)
    const safeErr = new Error('AUTH_TAG_VERIFICATION_FAILED: Falha de autenticação ao decifrar arquivo de sessão.');
    safeErr.code = 'AUTH_TAG_VERIFICATION_FAILED';
    throw safeErr;
  }
}

/**
 * Obtém ou carrega a DEK do tenant em memória (desembrulhando via KMS quando necessário)
 * @param {string} sessionDir
 * @param {{ tenantId: string|number, keyProvider: object }} options
 * @returns {Promise<Buffer>}
 */
async function getOrLoadTenantDek(sessionDir, { tenantId, keyProvider }) {
  const tenantKey = String(tenantId);
  if (tenantDekCache.has(tenantKey)) {
    return tenantDekCache.get(tenantKey);
  }

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const wrappedKeyPath = path.join(sessionDir, 'dek.wrapped');

  if (fs.existsSync(wrappedKeyPath)) {
    // Sessão preexistente: desembrulha a DEK utilizando o keyProvider
    const wrappedKey = fs.readFileSync(wrappedKeyPath);
    const plaintextKey = await keyProvider.unwrapDataKey({
      wrappedKey,
      tenantId,
      purpose: 'wa-session',
    });
    tenantDekCache.set(tenantKey, plaintextKey);
    return plaintextKey;
  }

  // Primeira sessão: gera nova DEK no KMS e persiste dek.wrapped atomicamente
  const { plaintextKey, wrappedKey } = await keyProvider.generateDataKey({
    tenantId,
    purpose: 'wa-session',
  });

  const tmpPath = `${wrappedKeyPath}.tmp`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, wrappedKey);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, wrappedKeyPath);

  tenantDekCache.set(tenantKey, plaintextKey);
  return plaintextKey;
}

/**
 * Zera em memória e remove a chave DEK do tenant
 * @param {string|number} tenantId
 */
function clearTenantDek(tenantId) {
  const tenantKey = String(tenantId);
  const key = tenantDekCache.get(tenantKey);
  if (key && Buffer.isBuffer(key)) {
    key.fill(0); // Limpeza de segurança em memória
  }
  tenantDekCache.delete(tenantKey);
}

/**
 * Lê e decifra sincronicamente um arquivo JSON de sessão (usado por inspeções/diagnósticos)
 * @param {string} sessionDir
 * @param {string} rawFileName Ex: 'creds.json'
 * @param {{ tenantId: string|number, keyProvider?: object }} options
 * @returns {any|null}
 */
function readEncryptedJsonSync(sessionDir, rawFileName, { tenantId, keyProvider = getKeyProvider() } = {}) {
  const fileName = fixFileName(rawFileName);
  const encFilePath = path.join(sessionDir, `${fileName}.enc`);

  if (!fs.existsSync(encFilePath)) {
    return null;
  }

  try {
    const tenantKey = String(tenantId);
    let dek = tenantDekCache.get(tenantKey);
    if (!dek) {
      const wrappedKeyPath = path.join(sessionDir, 'dek.wrapped');
      if (fs.existsSync(wrappedKeyPath) && keyProvider && typeof keyProvider.unwrapDataKeySync === 'function') {
        const wrappedKey = fs.readFileSync(wrappedKeyPath);
        dek = keyProvider.unwrapDataKeySync({
          wrappedKey,
          tenantId,
          purpose: 'wa-session',
        });
        tenantDekCache.set(tenantKey, dek);
      }
    }
    if (!dek) {
      return null;
    }

    const encBuffer = fs.readFileSync(encFilePath);
    const decryptedBuf = decryptBuffer(encBuffer, dek, { tenantId, fileName });
    return JSON.parse(decryptedBuf.toString('utf8'), BufferJSON.reviver);
  } catch (_) {
    return null;
  }
}

/**
 * Lê e decifra um arquivo JSON de sessão específico
 * @param {string} sessionDir
 * @param {string} rawFileName Ex: 'creds.json'
 * @param {{ tenantId: string|number, keyProvider?: object }} options
 * @returns {Promise<any|null>}
 */
async function readEncryptedJson(sessionDir, rawFileName, { tenantId, keyProvider = getKeyProvider() }) {
  const fileName = fixFileName(rawFileName);
  const encFilePath = path.join(sessionDir, `${fileName}.enc`);

  if (!fs.existsSync(encFilePath)) {
    return null;
  }

  return withFileLock(encFilePath, async () => {
    const dek = await getOrLoadTenantDek(sessionDir, { tenantId, keyProvider });
    try {
      const encBuffer = await fs.promises.readFile(encFilePath);
      const decryptedBuf = decryptBuffer(encBuffer, dek, { tenantId, fileName });
      return JSON.parse(decryptedBuf.toString('utf8'), BufferJSON.reviver);
    } catch (err) {
      // Se falhar a decifração do arquivo ou JSON inválido, trata como corrompido
      return null;
    }
  });
}

/**
 * Grava e cifra um objeto de sessão atomicamente
 * @param {string} sessionDir
 * @param {string} rawFileName Ex: 'creds.json'
 * @param {any} data
 * @param {{ tenantId: string|number, keyProvider: object }} options
 */
async function writeEncryptedJson(sessionDir, rawFileName, data, { tenantId, keyProvider }) {
  const fileName = fixFileName(rawFileName);
  const encFilePath = path.join(sessionDir, `${fileName}.enc`);
  const tmpFilePath = `${encFilePath}.tmp`;

  await withFileLock(encFilePath, async () => {
    const dek = await getOrLoadTenantDek(sessionDir, { tenantId, keyProvider });
    const jsonStr = JSON.stringify(data, BufferJSON.replacer);
    const encBuffer = encryptBuffer(jsonStr, dek, { tenantId, fileName });

    // Escrita atômica com fsync
    const fd = await fs.promises.open(tmpFilePath, 'w');
    try {
      await fd.writeFile(encBuffer);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.promises.rename(tmpFilePath, encFilePath);
  });
}

/**
 * Remove um arquivo cifrado de sessão
 * @param {string} sessionDir
 * @param {string} rawFileName
 */
async function removeEncryptedJson(sessionDir, rawFileName) {
  const fileName = fixFileName(rawFileName);
  const encFilePath = path.join(sessionDir, `${fileName}.enc`);

  await withFileLock(encFilePath, async () => {
    try {
      await fs.promises.unlink(encFilePath);
    } catch (_) {}
  });
}

/**
 * Implementação de useMultiFileAuthState cifrada (drop-in replacement para o Baileys)
 * @param {string} sessionDir Diretório da sessão (ex: data/sessions/salon_13)
 * @param {{ tenantId: string|number, keyProvider?: object }} options
 * @returns {Promise<{ state: { creds: any, keys: object }, saveCreds: () => Promise<void> }>}
 */
async function useEncryptedMultiFileAuthState(sessionDir, { tenantId, keyProvider = getKeyProvider() } = {}) {
  if (!tenantId) {
    throw new Error('MISSING_TENANT_ID: tenantId obrigatório para auth state cifrado.');
  }
  if (!keyProvider) {
    throw new Error('MISSING_KEY_PROVIDER: keyProvider obrigatório para auth state cifrado.');
  }

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Inicializa ou carrega a DEK na inicialização
  await getOrLoadTenantDek(sessionDir, { tenantId, keyProvider });

  const creds = (await readEncryptedJson(sessionDir, 'creds.json', { tenantId, keyProvider })) || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await readEncryptedJson(sessionDir, `${type}-${id}.json`, { tenantId, keyProvider });
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          })
        );
        return data;
      },
      set: async (data) => {
        const tasks = [];
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            const file = `${category}-${id}.json`;
            if (value) {
              tasks.push(writeEncryptedJson(sessionDir, file, value, { tenantId, keyProvider }));
            } else {
              tasks.push(removeEncryptedJson(sessionDir, file));
            }
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      return writeEncryptedJson(sessionDir, 'creds.json', state.creds, { tenantId, keyProvider });
    },
  };
}

module.exports = {
  MAGIC_HEADER,
  CURRENT_VERSION,
  buildAad,
  encryptBuffer,
  decryptBuffer,
  getOrLoadTenantDek,
  clearTenantDek,
  readEncryptedJson,
  readEncryptedJsonSync,
  writeEncryptedJson,
  removeEncryptedJson,
  useEncryptedMultiFileAuthState,
};
