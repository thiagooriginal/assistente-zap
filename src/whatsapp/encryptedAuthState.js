/**
 * RAIA AGENTES — ARMAZENAMENTO CIFRADO DE SESSÕES WHATSAPP (T9 / ENVELOPE KMS)
 * 
 * Implementa useEncryptedMultiFileAuthState compatível com o Baileys v7.
 * - Todos os arquivos de sessão possuem sufixo .enc (ex: creds.json.enc, pre-key-*.json.enc).
 * - Criptografia autenticada AES-256-GCM com AAD rígido: `wa:${tenantId}:${originalFileName}`.
 * - Cabeçalho binário: RAIAENC1 (8 bytes) + versão (1 byte: 0x01) + IV (12 bytes) + Tag (16 bytes) + Ciphertext.
 * - Gravação atômica: escrita em .tmp, fsync e rename atômico, com fsync de diretório.
 * - Concorrência serializada por arquivo e single-flight por tenant para obtenção de DEK.
 * - Proteção B1 contra recriação de credenciais sobre sessões existentes.
 * - Isolamento estrito de memória: DEK zerada via fill(0) ao desconectar.
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

// Single-flight de promessas de obtenção de DEK por tenant: tenantId -> Promise<Buffer>
const dekFlightMap = new Map();

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
    const err = new Error('ENCRYPTED_FILE_CORRUPT: Falha na integridade do arquivo cifrado.');
    err.code = 'ENCRYPTED_FILE_CORRUPT';
    throw err;
  }

  // Validação do Magic Header
  const magic = encBuffer.subarray(0, 8);
  if (!magic.equals(MAGIC_HEADER)) {
    const err = new Error('ENCRYPTED_FILE_CORRUPT: Falha na integridade do arquivo cifrado.');
    err.code = 'ENCRYPTED_FILE_CORRUPT';
    throw err;
  }

  // Validação de versão
  const version = encBuffer[8];
  if (version !== CURRENT_VERSION) {
    const err = new Error('ENCRYPTED_FILE_CORRUPT: Falha na integridade do arquivo cifrado.');
    err.code = 'ENCRYPTED_FILE_CORRUPT';
    throw err;
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
    const safeErr = new Error('ENCRYPTED_FILE_CORRUPT: Falha na integridade do arquivo cifrado.');
    safeErr.code = 'ENCRYPTED_FILE_CORRUPT';
    throw safeErr;
  }
}

/**
 * Remove apenas arquivos temporários órfãos de gravações anteriores
 * NUNCA remove arquivos .enc legítimos
 * @param {string} sessionDir
 */
function cleanOrphanTmpFiles(sessionDir) {
  try {
    if (!fs.existsSync(sessionDir)) return;
    const entries = fs.readdirSync(sessionDir);
    for (const file of entries) {
      if ((file.endsWith('.tmp') || file.includes('.enc.tmp') || file.includes('dek.wrapped.tmp')) && !file.endsWith('.enc')) {
        try {
          fs.unlinkSync(path.join(sessionDir, file));
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/**
 * Obtém ou carrega a DEK do tenant em memória com single-flight por inquilino
 * @param {string} sessionDir
 * @param {{ tenantId: string|number, keyProvider: object }} options
 * @returns {Promise<Buffer>}
 */
async function getOrLoadTenantDek(sessionDir, { tenantId, keyProvider }) {
  const tenantKey = String(tenantId);
  if (tenantDekCache.has(tenantKey)) {
    return tenantDekCache.get(tenantKey);
  }

  if (dekFlightMap.has(tenantKey)) {
    return await dekFlightMap.get(tenantKey);
  }

  const flightPromise = (async () => {
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

    // Se dek.wrapped não existe mas há qualquer arquivo .enc na pasta: BLOQUEIO B1
    const files = fs.readdirSync(sessionDir);
    const hasEncFiles = files.some((f) => f.endsWith('.enc'));
    if (hasEncFiles) {
      const err = new Error('DEK_MISSING_WITH_ENCRYPTED_FILES: dek.wrapped ausente em pasta com arquivos cifrados.');
      err.code = 'DEK_MISSING_WITH_ENCRYPTED_FILES';
      throw err;
    }

    // Geração de nova chave permitida exclusivamente quando NÃO há arquivos .enc
    const { plaintextKey, wrappedKey } = await keyProvider.generateDataKey({
      tenantId,
      purpose: 'wa-session',
    });

    const tmpPath = `${wrappedKeyPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 7)}`;
    const fd = fs.openSync(tmpPath, 'wx');
    try {
      fs.writeFileSync(fd, wrappedKey);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Verificação de concorrência antes do rename
    if (fs.existsSync(wrappedKeyPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      const existingWrapped = fs.readFileSync(wrappedKeyPath);
      const existingPlaintext = await keyProvider.unwrapDataKey({
        wrappedKey: existingWrapped,
        tenantId,
        purpose: 'wa-session',
      });
      tenantDekCache.set(tenantKey, existingPlaintext);
      return existingPlaintext;
    }

    fs.renameSync(tmpPath, wrappedKeyPath);

    // Fsync do diretório (com try/catch para compatibilidade Windows)
    try {
      const dirFd = fs.openSync(sessionDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (_) {}

    tenantDekCache.set(tenantKey, plaintextKey);
    return plaintextKey;
  })();

  dekFlightMap.set(tenantKey, flightPromise);
  try {
    return await flightPromise;
  } finally {
    dekFlightMap.delete(tenantKey);
  }
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
  dekFlightMap.delete(tenantKey);
}

/**
 * Lê sincronicamente um arquivo JSON de sessão quando a chave DEK já está em memória
 * Quando a chave não está em memória, reporta keyLoaded: false sem acionar unwrap síncrono
 * @param {string} sessionDir
 * @param {string} rawFileName Ex: 'creds.json'
 * @param {{ tenantId: string|number }} options
 * @returns {{ keyLoaded: boolean, data: any|null, error?: string }}
 */
function readEncryptedJsonSync(sessionDir, rawFileName, { tenantId } = {}) {
  const fileName = fixFileName(rawFileName);
  const encFilePath = path.join(sessionDir, `${fileName}.enc`);

  if (!fs.existsSync(encFilePath)) {
    return { keyLoaded: true, data: null };
  }

  const tenantKey = String(tenantId);
  const dek = tenantDekCache.get(tenantKey);
  if (!dek) {
    return { keyLoaded: false, data: null };
  }

  try {
    const encBuffer = fs.readFileSync(encFilePath);
    const decryptedBuf = decryptBuffer(encBuffer, dek, { tenantId, fileName });
    const parsed = JSON.parse(decryptedBuf.toString('utf8'), BufferJSON.reviver);
    return { keyLoaded: true, data: parsed };
  } catch (err) {
    return { keyLoaded: true, data: null, error: err.code || 'ENCRYPTED_FILE_CORRUPT' };
  }
}

/**
 * Lê e decifra um arquivo JSON de sessão específico
 * Distingue arquivo ausente (null) de corrupção/adulteração (lança ENCRYPTED_FILE_CORRUPT)
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
    const encBuffer = await fs.promises.readFile(encFilePath);
    const decryptedBuf = decryptBuffer(encBuffer, dek, { tenantId, fileName });
    try {
      return JSON.parse(decryptedBuf.toString('utf8'), BufferJSON.reviver);
    } catch (_) {
      const err = new Error('ENCRYPTED_FILE_CORRUPT: Falha na integridade do arquivo cifrado.');
      err.code = 'ENCRYPTED_FILE_CORRUPT';
      throw err;
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
  const tmpFilePath = `${encFilePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 6)}`;

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

    // Fsync do diretório pai (tolerante a falha em Windows)
    try {
      const dirFd = fs.openSync(sessionDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (_) {}
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
 * Implementação de useMultiFileAuthState cifrada com Proteções Bloqueantes B1 (Comando 038.1)
 * @param {string} sessionDir Diretório da sessão
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

  // 1. Limpeza preventiva de arquivos temporários órfãos
  cleanOrphanTmpFiles(sessionDir);

  // 2. Validações de integridade e não-sobrescrita (Proteção B1)
  const dirFiles = fs.readdirSync(sessionDir);
  const hasPlainCreds = dirFiles.includes('creds.json');
  const hasEncCreds = dirFiles.includes('creds.json.enc');
  const hasOtherEnc = dirFiles.some((f) => f.endsWith('.enc') && f !== 'creds.json.enc');
  const hasWrappedKey = dirFiles.includes('dek.wrapped');

  if (hasPlainCreds && !hasEncCreds) {
    const err = new Error('NOT_MIGRATED: Sessão em texto claro pendente de migração para armazenamento cifrado.');
    err.code = 'NOT_MIGRATED';
    throw err;
  }

  if (!hasEncCreds && hasOtherEnc) {
    const err = new Error('ENCRYPTED_STATE_INCONSISTENT: Estado cifrado inconsistente (creds.json.enc ausente com outros arquivos cifrados).');
    err.code = 'ENCRYPTED_STATE_INCONSISTENT';
    throw err;
  }

  // Inicializa ou carrega a DEK
  await getOrLoadTenantDek(sessionDir, { tenantId, keyProvider });

  let creds;
  if (hasEncCreds) {
    creds = await readEncryptedJson(sessionDir, 'creds.json', { tenantId, keyProvider });
    if (!creds) {
      const err = new Error('ENCRYPTED_FILE_CORRUPT: Falha na integridade do arquivo cifrado.');
      err.code = 'ENCRYPTED_FILE_CORRUPT';
      throw err;
    }
  } else {
    // Apenas permitido initAuthCreds quando diretório virgem
    creds = initAuthCreds();
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          ids.map(async (id) => {
            const rawFileName = `${type}-${id}.json`;
            let value = null;
            try {
              value = await readEncryptedJson(sessionDir, rawFileName, { tenantId, keyProvider });
            } catch (err) {
              if (err.code === 'ENCRYPTED_FILE_CORRUPT') {
                // Mover arquivo de chave corrompido para <nome>.enc.corrupt-<timestampUTC> sem derrubar socket
                const encFileName = `${fixFileName(rawFileName)}.enc`;
                const encFilePath = path.join(sessionDir, encFileName);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const corruptFilePath = path.join(sessionDir, `${encFileName}.corrupt-${timestamp}`);
                try {
                  if (fs.existsSync(encFilePath)) {
                    fs.renameSync(encFilePath, corruptFilePath);
                  }
                } catch (_) {}
                value = null;
              } else {
                throw err;
              }
            }

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
  cleanOrphanTmpFiles,
  readEncryptedJson,
  readEncryptedJsonSync,
  writeEncryptedJson,
  removeEncryptedJson,
  useEncryptedMultiFileAuthState,
};
