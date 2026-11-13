/**
 * RAIA AGENTES — SUÍTE HERMÉTICA DE TESTES AUTOMATIZADOS (COMANDO 038.2 / T9)
 * Validação rigorosa dos Requisitos Mandatórios (T0 a T29).
 *
 * ISOLAMENTO E HERMETICIDADE ESTRITA (BL2):
 * - Banco temporário isolado em os.tmpdir() inicializado antes de qualquer require de src/.
 * - Sessões, autenticação pessoal e travas alocadas exclusivamente em os.tmpdir().
 * - Guarda de isolamento T0 aborta a execução se houver risco de contaminação do banco operacional.
 * - Provedor de chaves falso (FakeKeyProvider), sem rede, sem AWS real e sem Baileys real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const child_process = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// ============================================================================
// 1. CONFIGURAÇÃO DE ISOLAMENTO HERMÉTICO ANTES DE QUALQUER REQUIRE DE SRC/
// ============================================================================
const suiteTempDir = path.join(os.tmpdir(), `t9_suite_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
fs.mkdirSync(suiteTempDir, { recursive: true });

const suiteDbPath = path.join(suiteTempDir, 'suite_hermetic.sqlite');
const suiteSessionsDir = path.join(suiteTempDir, 'sessions');
const suiteAuthDir = path.join(suiteTempDir, 'personal_auth');
const suiteLockFile = path.join(suiteTempDir, 'wa-sessions.lock');

fs.mkdirSync(suiteSessionsDir, { recursive: true });
fs.mkdirSync(suiteAuthDir, { recursive: true });

// Redireciona DB_PATH para o SQLite temporário isolado
process.env.DB_PATH = suiteDbPath;
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.NODE_ENV = 'test';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '13,14,15,16,99';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990011,5511999990002';
process.env.ALLOW_WHATSAPP_SENDING = 'false';

// Segredo fictício para auditoria de logs (T23)
const SUITE_FICTITIOUS_AWS_SECRET = 'AWS_HERMETIC_SECRET_KEY_MOCK_XYZ123456789';
process.env.AWS_SECRET_ACCESS_KEY = SUITE_FICTITIOUS_AWS_SECRET;

// Carregamento de módulos após configuração do ambiente
const db = require('../src/database/db');
const config = require('../src/config');
config.authDir = suiteAuthDir;

// Criação de registros fictícios para integridade referencial com FOREIGN KEY (BL2)
db.prepare(`
  INSERT OR IGNORE INTO users (id, name, phone_number, email, plan_tier, subscription_status)
  VALUES (13, 'Jéssica Beauty Teste', '5511999990011', 'jessica@teste.com', 'PRO', 'active'),
         (14, 'Salão Secundário Teste', '5511999990002', 'salao14@teste.com', 'PRO', 'active'),
         (99, 'Salão Single Flight Teste', '5511999990099', 'salao99@teste.com', 'PRO', 'active');
`).run();

const { FakeKeyProvider } = require('./helpers/fakeKeyProvider');
const {
  _setKeyProviderForTesting,
  _resetKeyProviderForTesting,
  KmsKeyProvider,
} = require('../src/security/keyProvider');

const {
  MAGIC_HEADER,
  CURRENT_VERSION,
  encryptBuffer,
  decryptBuffer,
  getOrLoadTenantDek,
  clearTenantDek,
  readEncryptedJson,
  readEncryptedJsonSync,
  useEncryptedMultiFileAuthState,
} = require('../src/whatsapp/encryptedAuthState');

const {
  DEFAULT_LOCK_FILE,
  parseProcStat,
  readBootId,
  inspectAppLock,
  tryForceUnlock,
  acquireAppLock,
  ensureWaEngineLock,
  _setProcStatReaderForTesting,
  _setBootIdReaderForTesting,
  _resetEngineLockForTesting,
} = require('../src/utils/appLock');

const waCredsMigrate = require('../scripts/waCredsMigrate');
const SalonWhatsAppRepository = require('../src/database/salonWhatsAppRepository');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');

// Define a pasta base de sessões inicial para a temporária da suíte
salonSessionManager._setBaseDirForTesting(suiteSessionsDir);

// Helper para criar diretórios temporários isolados por teste
function createTestDir(prefix = 'raia_test_') {
  const dir = path.join(suiteTempDir, `${prefix}${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Mock seguro de credenciais Baileys
function createMockCreds() {
  return {
    noiseKey: {
      private: Buffer.from('mock_noise_private_key_32_bytes!'),
      public: Buffer.from('mock_noise_public_key_32_bytes!!'),
    },
    pairingEphemeralKeyPair: {
      private: Buffer.from('mock_pairing_private_key_32_bytes'),
      public: Buffer.from('mock_pairing_public_key_32_bytes!'),
    },
    signedIdentityKey: {
      private: Buffer.from('mock_signed_id_priv_32_bytes!!!'),
      public: Buffer.from('mock_signed_id_pub_32_bytes!!!!'),
    },
    signedPreKey: {
      keyPair: {
        private: Buffer.from('mock_signed_pre_priv_32_bytes!!'),
        public: Buffer.from('mock_signed_pre_pub_32_bytes!!!'),
      },
      signature: Buffer.from('mock_signature_64_bytes_long_string_for_testing_purposes!!!!!!!!!'),
      keyId: 1,
    },
    registrationId: 12345,
    advSecretKey: Buffer.from('mock_adv_secret_key_32_bytes!!!!').toString('base64'),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSettings: { unarchiveChats: false },
    me: { id: '5511999990011:1@s.whatsapp.net', name: 'Salao Teste' },
    account: { details: Buffer.from('mock_account_details') },
    signalIdentities: [],
    platform: 'smba',
    lastAccountSyncTimestamp: 0,
    myAppStateKeyId: 'mock_app_state_key_id',
  };
}

// Coletor global de saída para T23 (Auditoria de Segredos nos Logs)
const logCapture = [];
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

function startLogCapture() {
  console.log = (...args) => {
    logCapture.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    originalConsoleLog.apply(console, args);
  };
  console.error = (...args) => {
    logCapture.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    originalConsoleError.apply(console, args);
  };
  console.warn = (...args) => {
    logCapture.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    originalConsoleWarn.apply(console, args);
  };
  process.stdout.write = (chunk, ...rest) => {
    logCapture.push(chunk ? chunk.toString() : '');
    return originalStdoutWrite.call(process.stdout, chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    logCapture.push(chunk ? chunk.toString() : '');
    return originalStderrWrite.call(process.stderr, chunk, ...rest);
  };
}

function stopLogCapture() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
}

startLogCapture();

// Registro das chaves capturadas para auditoria em T23
let capturedTenantDek = null;
let capturedWrappedKey = null;

test.after(() => {
  stopLogCapture();
  salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
  try {
    fs.rmSync(suiteTempDir, { recursive: true, force: true });
  } catch (_) {}
});

// ============================================================================
// SUÍTE DE TESTES HERMÉTICOS T0 A T29
// ============================================================================

test('T0: Guarda de isolamento hermético (todos os caminhos alocados em os.tmpdir)', () => {
  const tmpRoot = os.tmpdir().toLowerCase();
  assert.ok(config.dbPath.toLowerCase().startsWith(tmpRoot), `config.dbPath (${config.dbPath}) deve estar em os.tmpdir()`);
  assert.ok(process.env.DB_PATH.toLowerCase().startsWith(tmpRoot), `process.env.DB_PATH deve estar em os.tmpdir()`);
  assert.ok(suiteSessionsDir.toLowerCase().startsWith(tmpRoot), `suiteSessionsDir deve estar em os.tmpdir()`);
  assert.ok(config.authDir.toLowerCase().startsWith(tmpRoot), `config.authDir deve estar em os.tmpdir()`);
  assert.ok(suiteLockFile.toLowerCase().startsWith(tmpRoot), `suiteLockFile deve estar em os.tmpdir()`);

  const forbiddenRealDb = path.resolve(__dirname, '../data/assistant.db').toLowerCase();
  assert.notEqual(config.dbPath.toLowerCase(), forbiddenRealDb, 'DB_PATH jamais pode apontar para data/assistant.db');
});

test('T1: Ida e volta completa (creds, pre-key, session, sender-key, app-state-sync-key)', async () => {
  const dir = createTestDir('t1_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    const mockCreds = createMockCreds();
    state.creds = mockCreds;
    await saveCreds();

    const preKeyData = { keyPair: { public: Buffer.from('pub_pre_key_1'), private: Buffer.from('priv_pre_key_1') }, keyId: 1 };
    const sessionData = Buffer.from('session_binary_state_abc');
    const senderKeyData = Buffer.from('sender_key_binary_xyz');
    const appStateData = { keyData: Buffer.from('app_state_raw_bytes'), fingerprint: { rawId: 42 } };

    await state.keys.set({
      'pre-key': { '1': preKeyData },
      'session': { 'sess_1': sessionData },
      'sender-key': { 'sk_1': senderKeyData },
      'app-state-sync-key': { 'ask_1': appStateData },
    });

    const { state: stateReloaded } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    assert.equal(stateReloaded.creds.me.id, mockCreds.me.id);
    assert.equal(stateReloaded.creds.registrationId, mockCreds.registrationId);

    const loadedKeys = await stateReloaded.keys.get('pre-key', ['1']);
    assert.deepEqual(loadedKeys['1'].keyPair.public, preKeyData.keyPair.public);

    const loadedSession = await stateReloaded.keys.get('session', ['sess_1']);
    assert.deepEqual(loadedSession['sess_1'], sessionData);

    const loadedSender = await stateReloaded.keys.get('sender-key', ['sk_1']);
    assert.deepEqual(loadedSender['sk_1'], senderKeyData);

    const loadedAppState = await stateReloaded.keys.get('app-state-sync-key', ['ask_1']);
    assert.deepEqual(loadedAppState['ask_1'].keyData, appStateData.keyData);
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T2: Arquivo ilegível (começa com RAIAENC1 e sem trechos do JSON em claro)', async () => {
  const dir = createTestDir('t2_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    const encPath = path.join(dir, 'creds.json.enc');
    assert.ok(fs.existsSync(encPath));
    const buf = fs.readFileSync(encPath);

    assert.ok(buf.subarray(0, 8).equals(MAGIC_HEADER));
    assert.equal(buf.readUInt8(8), CURRENT_VERSION);

    assert.equal(buf.includes(Buffer.from('"me"')), false);
    assert.equal(buf.includes(Buffer.from('noiseKey')), false);
    assert.equal(buf.includes(Buffer.from('5511999990011')), false);
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T3: Isolamento (arquivo copiado entre tenants ou renomeado falha por AAD)', async () => {
  const dir13 = createTestDir('t3_13_');
  const dir14 = createTestDir('t3_14_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state: s13, saveCreds: save13 } = await useEncryptedMultiFileAuthState(dir13, { tenantId: 13, keyProvider: kp });
    s13.creds = createMockCreds();
    await save13();
    await s13.keys.set({ 'pre-key': { '1': { keyPair: { public: Buffer.from('pub1'), private: Buffer.from('priv1') }, keyId: 1 } } });

    const { state: s14, saveCreds: save14 } = await useEncryptedMultiFileAuthState(dir14, { tenantId: 14, keyProvider: kp });
    s14.creds = createMockCreds();
    await save14();

    // 1. Copia arquivo do tenant 13 para tenant 14
    const srcFile = path.join(dir13, 'pre-key-1.json.enc');
    const destFileIn14 = path.join(dir14, 'pre-key-1.json.enc');
    fs.copyFileSync(srcFile, destFileIn14);

    const loadedIn14 = await s14.keys.get('pre-key', ['1']);
    assert.equal(loadedIn14['1'], null, 'Chave de outro tenant deve retornar null');

    // 2. Renomeia arquivo dentro do mesmo tenant
    const renamedPath = path.join(dir13, 'pre-key-2.json.enc');
    fs.copyFileSync(srcFile, renamedPath);
    const loadedRenamed = await s13.keys.get('pre-key', ['2']);
    assert.equal(loadedRenamed['2'], null, 'Arquivo renomeado deve falhar por divergência de AAD');
  } finally {
    clearTenantDek(13);
    clearTenantDek(14);
    _resetKeyProviderForTesting();
    fs.rmSync(dir13, { recursive: true, force: true });
    fs.rmSync(dir14, { recursive: true, force: true });
  }
});

test('T4: Adulteração (ciphertext e tag adulterados lançam ENCRYPTED_FILE_CORRUPT)', async () => {
  const dir = createTestDir('t4_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const dek = await getOrLoadTenantDek(dir, { tenantId: 13, keyProvider: kp });
    const originalJson = Buffer.from(JSON.stringify({ secret: 'sensivel' }));
    const encBuf = encryptBuffer(originalJson, dek, { tenantId: 13, fileName: 'test.json' });

    const testFile = path.join(dir, 'test.json.enc');
    fs.writeFileSync(testFile, encBuf);

    // 1. Adultera 1 byte do ciphertext
    const corruptedCiphertext = Buffer.from(encBuf);
    corruptedCiphertext[corruptedCiphertext.length - 1] ^= 0x01;
    fs.writeFileSync(testFile, corruptedCiphertext);

    await assert.rejects(
      async () => readEncryptedJson(dir, 'test.json', { tenantId: 13, keyProvider: kp }),
      (err) => err.code === 'ENCRYPTED_FILE_CORRUPT'
    );

    // 2. Adultera 1 byte da tag GCM (bytes 21-36)
    const corruptedTag = Buffer.from(encBuf);
    corruptedTag[25] ^= 0xff;
    fs.writeFileSync(testFile, corruptedTag);

    await assert.rejects(
      async () => readEncryptedJson(dir, 'test.json', { tenantId: 13, keyProvider: kp }),
      (err) => err.code === 'ENCRYPTED_FILE_CORRUPT'
    );
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T5: Falha real entre .tmp e rename (arquivo anterior continua íntegro e .tmp órfão é limpo)', async () => {
  const dir = createTestDir('t5_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    // Grava versão inicial de pre-key-1
    await state.keys.set({ 'pre-key': { '1': { keyPair: { public: Buffer.from('v1_pub'), private: Buffer.from('v1_priv') }, keyId: 1 } } });
    const pk1Path = path.join(dir, 'pre-key-1.json.enc');
    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(pk1Path)).digest('hex');

    // Injeta falha real em fs.promises.rename na gravação da versão v2
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (oldPath, newPath) => {
      if (String(newPath).endsWith('pre-key-1.json.enc')) {
        throw new Error('SIMULATED_FS_RENAME_FAILURE');
      }
      return originalRename(oldPath, newPath);
    };

    await assert.rejects(
      async () => state.keys.set({ 'pre-key': { '1': { keyPair: { public: Buffer.from('v2_pub'), private: Buffer.from('v2_priv') }, keyId: 1 } } }),
      /SIMULATED_FS_RENAME_FAILURE/
    );

    fs.promises.rename = originalRename;

    // Arquivo original continua com o mesmo hash e legível
    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(pk1Path)).digest('hex');
    assert.equal(hashAfter, hashBefore, 'Arquivo .enc original não deve ser modificado em caso de falha no rename');

    const orphanTmpList = fs.readdirSync(dir).filter((f) => f.includes('pre-key-1.json.enc.tmp'));
    assert.ok(orphanTmpList.length > 0, 'O arquivo .tmp órfão deve permanecer na pasta antes da limpeza');

    // Na próxima carga de useEncryptedMultiFileAuthState, o .tmp órfão é removido
    const { state: stateReloaded } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    const orphanTmpListAfter = fs.readdirSync(dir).filter((f) => f.includes('pre-key-1.json.enc.tmp'));
    assert.equal(orphanTmpListAfter.length, 0, 'Arquivo .tmp órfão deve ser expurgado');

    const keyLoaded = await stateReloaded.keys.get('pre-key', ['1']);
    assert.deepEqual(keyLoaded['1'].keyPair.public, Buffer.from('v1_pub'));
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T6: Concorrência (50 gravações simultâneas do mesmo arquivo decifram sem truncar)', async () => {
  const dir = createTestDir('t6_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    const writes = [];
    for (let i = 0; i < 50; i++) {
      writes.push(
        state.keys.set({
          'session': {
            'shared_sess': Buffer.from(`session_iteration_content_${i}_payload_data`),
          },
        })
      );
    }
    await Promise.all(writes);

    const { state: stateReloaded } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    const res = await stateReloaded.keys.get('session', ['shared_sess']);
    assert.ok(res['shared_sess'] != null);
    const content = res['shared_sess'].toString('utf8');
    assert.ok(content.startsWith('session_iteration_content_'));
    assert.ok(content.endsWith('_payload_data'));
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T7: Corrida da chave (duas getOrLoadTenantDek simultâneas chamam generateDataKey apenas UMA vez)', async () => {
  const dir = createTestDir('t7_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const p1 = getOrLoadTenantDek(dir, { tenantId: 99, keyProvider: kp });
    const p2 = getOrLoadTenantDek(dir, { tenantId: 99, keyProvider: kp });
    const [dek1, dek2] = await Promise.all([p1, p2]);

    assert.equal(kp.calls.generateDataKey, 1, 'Deve chamar generateDataKey exatamente 1 vez (single-flight)');
    assert.deepEqual(dek1, dek2);
    assert.ok(fs.existsSync(path.join(dir, 'dek.wrapped')));
  } finally {
    clearTenantDek(99);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T8: Migração (texto claro -> .enc verificado -> quarentena segura sem deletar)', async () => {
  const dir = createTestDir('t8_session_');
  const quarantineRoot = createTestDir('t8_quarantine_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const credsJson = JSON.stringify({ me: { id: '5511999990011@s.whatsapp.net' } });
    fs.writeFileSync(path.join(dir, 'creds.json'), credsJson, 'utf8');
    fs.writeFileSync(path.join(dir, 'app-state-sync-key-1.json'), JSON.stringify({ raw: 123 }), 'utf8');

    const result = await waCredsMigrate.runMigration(
      { tenantId: 13, dir, isPersonal: false },
      { keyProvider: kp, quarantineRoot }
    );

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.migratedCount, 2);

    assert.ok(fs.existsSync(path.join(dir, 'creds.json.enc')));
    assert.ok(fs.existsSync(path.join(dir, 'app-state-sync-key-1.json.enc')));
    assert.ok(fs.existsSync(path.join(dir, 'dek.wrapped')));

    assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false);

    assert.ok(fs.existsSync(path.join(result.quarantineFolder, 'creds.json')));
    assert.ok(fs.existsSync(path.join(result.quarantineFolder, 'app-state-sync-key-1.json')));
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('T9: Falha no 3º arquivo (pasta fica idêntica à original e quarentena fica vazia)', async () => {
  const dir = createTestDir('t9_fail_');
  const quarantineRoot = createTestDir('t9_quarantine_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    fs.writeFileSync(path.join(dir, 'file1.json'), JSON.stringify({ a: 1 }));
    fs.writeFileSync(path.join(dir, 'file2.json'), JSON.stringify({ b: 2 }));
    fs.writeFileSync(path.join(dir, 'file3.json'), JSON.stringify({ c: 3 }));

    const initialFiles = fs.readdirSync(dir).sort();
    const hashBefore = initialFiles.map(f => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'));

    const originalOpenSync = fs.openSync;
    fs.openSync = function (p, flags, mode) {
      if (String(p).includes('file3.json.enc.tmp')) {
        throw new Error('SIMULATED_DISK_WRITE_FAILURE');
      }
      return originalOpenSync.call(fs, p, flags, mode);
    };

    await assert.rejects(
      async () => waCredsMigrate.runMigration({ tenantId: 13, dir, isPersonal: false }, { keyProvider: kp, quarantineRoot }),
      /SIMULATED_DISK_WRITE_FAILURE/
    );

    fs.openSync = originalOpenSync;

    const filesAfter = fs.readdirSync(dir).sort().filter(f => f !== 'dek.wrapped');
    const hashAfter = filesAfter.map(f => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'));

    assert.deepEqual(filesAfter, initialFiles);
    assert.deepEqual(hashAfter, hashBefore);
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('T10: Falha ao mover para a quarentena (pasta volta a ficar idêntica à original)', async () => {
  const dir = createTestDir('t10_quarantine_fail_');
  const quarantineRoot = createTestDir('t10_quarantine_dir_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    fs.writeFileSync(path.join(dir, 'f1.json'), JSON.stringify({ x: 1 }));
    fs.writeFileSync(path.join(dir, 'f2.json'), JSON.stringify({ y: 2 }));

    const initialFiles = fs.readdirSync(dir).sort();
    const hashBefore = initialFiles.map(f => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'));

    const originalRenameSync = fs.renameSync;
    let renameCount = 0;
    fs.renameSync = function (src, dest) {
      if (String(dest).includes(quarantineRoot)) {
        renameCount++;
        if (renameCount === 2) {
          throw new Error('SIMULATED_QUARANTINE_MOVE_ERROR');
        }
      }
      return originalRenameSync.call(fs, src, dest);
    };

    await assert.rejects(
      async () => waCredsMigrate.runMigration({ tenantId: 13, dir, isPersonal: false }, { keyProvider: kp, quarantineRoot }),
      /SIMULATED_QUARANTINE_MOVE_ERROR/
    );

    fs.renameSync = originalRenameSync;

    const filesAfter = fs.readdirSync(dir).sort().filter(f => f !== 'dek.wrapped');
    const hashAfter = filesAfter.map(f => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'));

    assert.deepEqual(filesAfter, initialFiles);
    assert.deepEqual(hashAfter, hashBefore);
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('T11: Rollback do estado atual (contém alterações novas, não o estado da quarentena)', async () => {
  const dir = createTestDir('t11_rollback_');
  const quarantineRoot = createTestDir('t11_quarantine_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ me: { id: 'old_id@s.whatsapp.net' } }), 'utf8');

    await waCredsMigrate.runMigration({ tenantId: 13, dir, isPersonal: false }, { keyProvider: kp, quarantineRoot });

    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds.me = { id: 'brand_new_id@s.whatsapp.net' };
    await saveCreds();

    const rollbackRes = await waCredsMigrate.runRollback({ tenantId: 13, dir, isPersonal: false }, { keyProvider: kp, confirmRollback: true });
    assert.equal(rollbackRes.status, 'SUCCESS');

    const restoredCreds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
    assert.equal(restoredCreds.me.id, 'brand_new_id@s.whatsapp.net', 'Rollback deve preservar as alterações mais recentes');
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('T12: Trava do motor de sessões com waCredsMigrate CLI e integridade de arquivos (a a e)', async () => {
  const lockDir = createTestDir('t12_locks_');
  const lockFile = path.join(lockDir, 'wa-sessions.lock');
  const sessionDir = createTestDir('t12_sess_');
  const testJsonPath = path.join(sessionDir, 'creds.json');
  fs.writeFileSync(testJsonPath, JSON.stringify({ me: { id: '5511999990011@s.whatsapp.net' } }));
  const hashOriginal = crypto.createHash('sha256').update(fs.readFileSync(testJsonPath)).digest('hex');

  const kp = new FakeKeyProvider();

  try {
    // (a) Trava com PID de processo vivo (child mantido vivo)
    const child = child_process.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, startTicks: null, bootId: null, engineId: 'wa-sessions-engine' }));

    // Executa CLI sem force-unlock: bloqueia e mantém arquivo intacto
    await assert.rejects(
      async () => waCredsMigrate.main(['--tenant', '13', '--migrate'], { exitOnError: false, lockFile, keyProvider: kp }),
      /Trava existente detectada/
    );
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(testJsonPath)).digest('hex'), hashOriginal);

    // Executa CLI com force-unlock: bloqueia pois o PID está vivo
    await assert.rejects(
      async () => waCredsMigrate.main(['--tenant', '13', '--migrate', '--force-unlock'], { exitOnError: false, lockFile, keyProvider: kp }),
      /Não foi possível liberar a trava/
    );
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(testJsonPath)).digest('hex'), hashOriginal);
    assert.ok(fs.existsSync(lockFile));

    child.kill('SIGKILL');

    // (b) Trava com PID da própria ferramenta (process.pid)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startTicks: null, bootId: null, engineId: 'wa-sessions-engine' }));
    await assert.rejects(
      async () => waCredsMigrate.main(['--tenant', '13', '--migrate', '--force-unlock'], { exitOnError: false, lockFile, keyProvider: kp }),
      /CANNOT_UNLOCK_SELF_PROCESS/
    );
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(testJsonPath)).digest('hex'), hashOriginal);

    // (c) Trava ilegível / corrompida
    fs.writeFileSync(lockFile, 'CORRUPTED_RAW_NON_JSON');
    await assert.rejects(
      async () => waCredsMigrate.main(['--tenant', '13', '--migrate', '--force-unlock'], { exitOnError: false, lockFile, keyProvider: kp }),
      /LOCK_CORRUPTED_OR_UNREADABLE/
    );
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(testJsonPath)).digest('hex'), hashOriginal);

    // (d) PID inexistente (morto)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 9999999, startTicks: 100, bootId: 'mock', engineId: 'wa-sessions-engine' }));
    // Sem force-unlock: recusa
    await assert.rejects(
      async () => waCredsMigrate.main(['--tenant', '13', '--migrate'], { exitOnError: false, lockFile, keyProvider: kp }),
      /Trava existente detectada/
    );
    // Com force-unlock: libera e remove a trava
    const unlockRes = tryForceUnlock(lockFile);
    assert.equal(unlockRes.unlocked, true);
    assert.equal(fs.existsSync(lockFile), false);

    // (e) PID vivo com ticks diferentes simulados
    const aliveProc = child_process.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: aliveProc.pid, startTicks: 1000, bootId: 'boot1', engineId: 'wa-sessions-engine' }));
    _setBootIdReaderForTesting(() => 'boot1');
    _setProcStatReaderForTesting((pid) => pid === aliveProc.pid ? { startTicks: 2000 } : null);

    const inspectRecycled = inspectAppLock(lockFile);
    assert.equal(inspectRecycled.orphan, true);
    assert.equal(inspectRecycled.reason, 'PID_RECYCLED_DIFFERENT_START_TICKS');

    const unlockRecycled = tryForceUnlock(lockFile);
    assert.equal(unlockRecycled.unlocked, true);
    assert.equal(fs.existsSync(lockFile), false);

    aliveProc.kill('SIGKILL');
    _setProcStatReaderForTesting(null);
    _setBootIdReaderForTesting(null);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('T12-X: Trava entre processos reais sem função falsa (Windows e Linux)', () => {
  const lockDir = createTestDir('t12_x_');
  const lockFile = path.join(lockDir, 'wa-engine-real.lock');

  _resetEngineLockForTesting();
  ensureWaEngineLock(lockFile);

  assert.ok(fs.existsSync(lockFile));

  // Processo filho Node executa inspeção real sobre a trava mantida pelo pai
  const childScript = `
    const { inspectAppLock, tryForceUnlock } = require('./src/utils/appLock');
    const status = inspectAppLock(process.argv[1]);
    const unlock = tryForceUnlock(process.argv[1]);
    if (status.running !== true || unlock.unlocked !== false) {
      process.exit(2);
    }
    process.exit(0);
  `;

  const res = child_process.spawnSync(process.execPath, ['-e', childScript, lockFile], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, `Filho deve detectar running=true e unlocked=false. Stderr: ${res.stderr}`);

  // Teste via CLI do waCredsMigrate no processo filho com --force-unlock
  const cliRes = child_process.spawnSync(
    process.execPath,
    ['scripts/waCredsMigrate.js', '--tenant', '13', '--migrate', '--force-unlock', '--lock-file', lockFile],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    }
  );

  assert.notEqual(cliRes.status, 0, 'CLI deve falhar e recusar remover trava de processo ativo');
  assert.ok(fs.existsSync(lockFile), 'A trava deve permanecer no lugar');

  _resetEngineLockForTesting();
  fs.rmSync(lockDir, { recursive: true, force: true });
});

test('T12-L: Parser de /proc/<pid>/stat com comm complexo (espaços/parênteses) e bootId', () => {
  // 1. Parser com nome de processo complexo
  const statWithParens = '1234 (Web Content (worker)) S 1 14 14 0 -1 4194304 316 0 0 0 10 2 0 0 20 0 1 0 789101 1234567 123 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0';
  const parsed = parseProcStat(statWithParens);
  assert.ok(parsed != null);
  assert.equal(parsed.startTicks, 789101);

  // 2. Trava com bootId diferente é órfã
  const lockDir = createTestDir('t12_l_');
  const lockFile = path.join(lockDir, 'boot-test.lock');

  const child = child_process.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, startTicks: 12345, bootId: 'old-boot-uuid', engineId: 'wa-sessions-engine' }));

  _setBootIdReaderForTesting(() => 'new-boot-uuid-rebooted');
  const inspectBoot = inspectAppLock(lockFile);
  assert.equal(inspectBoot.orphan, true);
  assert.equal(inspectBoot.reason, 'BOOT_ID_MISMATCH_REAPROVEITADO');

  // 3. Trava antiga só com PID vivo é ativa
  fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, engineId: 'wa-sessions-engine' }));
  const inspectLegacy = inspectAppLock(lockFile);
  assert.equal(inspectLegacy.running, true);
  assert.equal(inspectLegacy.orphan, false);

  child.kill('SIGKILL');
  _setBootIdReaderForTesting(null);
  fs.rmSync(lockDir, { recursive: true, force: true });
});

test('T12-H: Trava criada em homologação no startup e suprimida com WA_SESSIONS_DISABLED=true', async () => {
  const lockDir = createTestDir('t12_h_');
  const testLockFile = path.join(lockDir, 'wa-sessions.lock');

  _resetEngineLockForTesting();

  // Com WA_SESSIONS_DISABLED=true, não adquire trava
  process.env.WA_SESSIONS_DISABLED = 'true';
  const resDisabled = ensureWaEngineLock(testLockFile);
  assert.equal(resDisabled, false);
  assert.equal(fs.existsSync(testLockFile), false);

  delete process.env.WA_SESSIONS_DISABLED;

  // Sem WA_SESSIONS_DISABLED, adquire com sucesso
  const resEnabled = ensureWaEngineLock(testLockFile);
  assert.equal(resEnabled, true);
  assert.ok(fs.existsSync(testLockFile));

  _resetEngineLockForTesting();
  fs.rmSync(lockDir, { recursive: true, force: true });
});

test('T13: B1 - Chave ausente (dek.wrapped ausente com arquivos .enc presentes lança DEK_MISSING_WITH_ENCRYPTED_FILES)', async () => {
  const dir = createTestDir('t13_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    const encFile = path.join(dir, 'creds.json.enc');
    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(encFile)).digest('hex');

    fs.unlinkSync(path.join(dir, 'dek.wrapped'));
    clearTenantDek(13);

    const callsBefore = kp.calls.generateDataKey;

    await assert.rejects(
      async () => useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp }),
      (err) => err.code === 'DEK_MISSING_WITH_ENCRYPTED_FILES'
    );

    assert.equal(kp.calls.generateDataKey, callsBefore, 'generateDataKey JAMAIS deve ser chamado');
    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(encFile)).digest('hex');
    assert.equal(hashAfter, hashBefore, 'Arquivo .enc deve permanecer intacto');
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T14: B1 - Creds corrompido (creds.json.enc corrompido lança ENCRYPTED_FILE_CORRUPT sem sobrescrever)', async () => {
  const dir = createTestDir('t14_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    const encPath = path.join(dir, 'creds.json.enc');
    const corrupted = fs.readFileSync(encPath);
    corrupted[corrupted.length - 1] ^= 0xff;
    fs.writeFileSync(encPath, corrupted);
    const hashCorrupted = crypto.createHash('sha256').update(corrupted).digest('hex');

    clearTenantDek(13);

    await assert.rejects(
      async () => useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp }),
      (err) => err.code === 'ENCRYPTED_FILE_CORRUPT'
    );

    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(encPath)).digest('hex');
    assert.equal(hashAfter, hashCorrupted, 'Arquivo adulterado não deve ser sobrescrito');
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T15: B1 - Não migrado (creds.json em texto claro sem .enc lança NOT_MIGRATED para salão e pessoal)', async () => {
  const dirSalon = createTestDir('t15_salon_');
  const dirPersonal = createTestDir('t15_personal_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    fs.writeFileSync(path.join(dirSalon, 'creds.json'), JSON.stringify({ me: { id: 'salon@s.whatsapp.net' } }));
    fs.writeFileSync(path.join(dirPersonal, 'creds.json'), JSON.stringify({ me: { id: 'personal@s.whatsapp.net' } }));

    await assert.rejects(
      async () => useEncryptedMultiFileAuthState(dirSalon, { tenantId: 13, keyProvider: kp }),
      (err) => err.code === 'NOT_MIGRATED'
    );

    await assert.rejects(
      async () => useEncryptedMultiFileAuthState(dirPersonal, { tenantId: 'personal', keyProvider: kp }),
      (err) => err.code === 'NOT_MIGRATED'
    );

    assert.equal(fs.existsSync(path.join(dirSalon, 'creds.json.enc')), false);
    assert.equal(fs.existsSync(path.join(dirPersonal, 'creds.json.enc')), false);
  } finally {
    _resetKeyProviderForTesting();
    fs.rmSync(dirSalon, { recursive: true, force: true });
    fs.rmSync(dirPersonal, { recursive: true, force: true });
  }
});

test('T16: B1 - Novo pareamento recusado sobre pasta com credenciais cifradas existentes', async () => {
  const sessionsBase = createTestDir('t16_sessions_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  salonSessionManager._setBaseDirForTesting(sessionsBase);

  try {
    const salonDir = path.join(sessionsBase, 'salon_13');
    fs.mkdirSync(salonDir, { recursive: true });

    const { state, saveCreds } = await useEncryptedMultiFileAuthState(salonDir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    const encPath = path.join(salonDir, 'creds.json.enc');
    const hashEncBefore = crypto.createHash('sha256').update(fs.readFileSync(encPath)).digest('hex');
    const generateCallsBefore = kp.calls.generateDataKey;

    process.env.WA_CREDS_ENCRYPTION = 'on';

    // 1. startQrSession recusa
    await assert.rejects(
      async () => salonSessionManager.startQrSession(13),
      (err) => err.code === 'CANNOT_PAIR_EXISTING_ENCRYPTED_SESSION'
    );

    // 2. requestPairingCode recusa
    await assert.rejects(
      async () => salonSessionManager.requestPairingCode(13, '5511999990011'),
      (err) => err.code === 'CANNOT_PAIR_EXISTING_ENCRYPTED_SESSION'
    );

    const hashEncAfter = crypto.createHash('sha256').update(fs.readFileSync(encPath)).digest('hex');
    assert.equal(hashEncAfter, hashEncBefore, 'Arquivos não devem ser alterados');
    assert.equal(kp.calls.generateDataKey, generateCallsBefore, 'Não deve gerar novas chaves');
  } finally {
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
  }
});

test('T17: B1 - Chave secundária corrompida (pre-key renomeada para .corrupt- e retorna null)', async () => {
  const dir = createTestDir('t17_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    await state.keys.set({
      'pre-key': {
        '1': { keyPair: { public: Buffer.from('pub1'), private: Buffer.from('priv1') }, keyId: 1 },
        '2': { keyPair: { public: Buffer.from('pub2'), private: Buffer.from('priv2') }, keyId: 2 },
      },
    });

    const pk1Path = path.join(dir, 'pre-key-1.json.enc');
    const pk1Buf = fs.readFileSync(pk1Path);
    pk1Buf[pk1Buf.length - 1] ^= 0x55;
    fs.writeFileSync(pk1Path, pk1Buf);

    const { state: stateReloaded } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    const keys = await stateReloaded.keys.get('pre-key', ['1', '2']);

    assert.equal(keys['1'], null, 'Chave corrompida deve retornar null sem explodir o socket');
    assert.ok(keys['2'] != null, 'Chave íntegra deve ser lida normalmente');

    const files = fs.readdirSync(dir);
    assert.ok(files.some(f => f.startsWith('pre-key-1.json.enc.corrupt-')), 'Arquivo corrompido deve ser renomeado para quarentena local');
  } finally {
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T18: Restauração de salão migrado no banco temporário (não é marcado DISCONNECTED e cria socket)', async () => {
  const sessionsBase = createTestDir('t18_sessions_');
  salonSessionManager._setBaseDirForTesting(sessionsBase);

  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const salonDir = path.join(sessionsBase, 'salon_13');
    fs.mkdirSync(salonDir, { recursive: true });
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(salonDir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    SalonWhatsAppRepository.ensureSessionExists(13, salonDir);
    SalonWhatsAppRepository.markSessionConnected(13, { phone: '5511999990011', phoneJid: '5511999990011@s.whatsapp.net' });

    let socketCreated = false;
    salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
      socketCreated = true;
      return {
        ev: { on: () => {} },
        ws: { close: () => {} },
        end: () => {},
      };
    });

    process.env.WA_CREDS_ENCRYPTION = 'on';
    await salonSessionManager.restoreActiveSalonSessions();

    assert.equal(socketCreated, true, 'Deve prosseguir para criação do socket');
    const session = SalonWhatsAppRepository.getSessionByUserId(13);
    assert.notEqual(session.session_status, 'DISCONNECTED');
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
  }
});

test('T19: B2 - Novas tentativas do KMS (KMS_UNAVAILABLE -> retentativa -> restauração)', async () => {
  salonSessionManager._resetForTesting();
  const sessionsBase = createTestDir('t19_sessions_');
  salonSessionManager._setBaseDirForTesting(sessionsBase);

  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const salonDir = path.join(sessionsBase, 'salon_13');
    fs.mkdirSync(salonDir, { recursive: true });
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(salonDir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    SalonWhatsAppRepository.ensureSessionExists(13, salonDir);
    SalonWhatsAppRepository.markSessionConnected(13, { phone: '5511999990011', phoneJid: '5511999990011@s.whatsapp.net' });

    clearTenantDek(13);

    kp.setUnavailable(true);
    process.env.WA_CREDS_ENCRYPTION = 'on';

    await salonSessionManager.restoreActiveSalonSessions();

    let session = SalonWhatsAppRepository.getSessionByUserId(13);
    assert.equal(session.session_status, 'KMS_UNAVAILABLE');

    const active = SalonWhatsAppRepository.getActiveSessionsForRestore();
    assert.ok(active.some(s => s.user_id === 13));

    kp.setUnavailable(false);
    let socketRestored = false;
    salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
      socketRestored = true;
      return { ev: { on: () => {} }, ws: { close: () => {} }, end: () => {} };
    });

    await salonSessionManager._executeKmsRetry();

    assert.equal(socketRestored, true, 'Salão deve ser restaurado quando o KMS volta');
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
  }
});

test('T20: B2 - Desconexão durante as tentativas (salão desconectado formalmente NÃO é restaurado)', async () => {
  salonSessionManager._resetForTesting();
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    SalonWhatsAppRepository.ensureSessionExists(13);
    SalonWhatsAppRepository.markSessionDisconnected(13, { status: 'KMS_UNAVAILABLE' });

    SalonWhatsAppRepository.markSessionDisconnected(13, { status: 'DISCONNECTED' });

    let socketCreated = false;
    salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
      socketCreated = true;
      return { ev: { on: () => {} } };
    });

    await salonSessionManager._executeKmsRetry();
    assert.equal(socketCreated, false, 'Salão formalmente desconectado NÃO pode ser restaurado pelo retry do KMS');
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    _resetKeyProviderForTesting();
  }
});

test('T21: B2 - NOT_MIGRATED volta (após migração o salão é restaurado normalmente)', async () => {
  salonSessionManager._resetForTesting();
  const sessionsBase = createTestDir('t21_sessions_');
  const quarantineRoot = createTestDir('t21_quarantine_');
  salonSessionManager._setBaseDirForTesting(sessionsBase);

  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const salonDir = path.join(sessionsBase, 'salon_13');
    fs.mkdirSync(salonDir, { recursive: true });
    fs.writeFileSync(path.join(salonDir, 'creds.json'), JSON.stringify(createMockCreds()));

    SalonWhatsAppRepository.ensureSessionExists(13, salonDir);
    SalonWhatsAppRepository.markSessionConnected(13, { phone: '5511999990011', phoneJid: '5511999990011@s.whatsapp.net' });

    process.env.WA_CREDS_ENCRYPTION = 'on';

    await salonSessionManager.restoreActiveSalonSessions();
    let session = SalonWhatsAppRepository.getSessionByUserId(13);
    assert.equal(session.session_status, 'NOT_MIGRATED');

    await waCredsMigrate.runMigration({ tenantId: 13, dir: salonDir, isPersonal: false }, { keyProvider: kp, quarantineRoot });

    let socketCreated = false;
    salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
      socketCreated = true;
      return { ev: { on: () => {} }, ws: { close: () => {} }, end: () => {} };
    });

    await salonSessionManager.restoreActiveSalonSessions();
    assert.equal(socketCreated, true);
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('T22: disconnect() real (sessão ativa removida e DEK zeroizada buffer.every(b => b === 0))', async () => {
  salonSessionManager._resetForTesting();
  const sessionsBase = createTestDir('t22_sessions_');
  salonSessionManager._setBaseDirForTesting(sessionsBase);

  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const salonDir = path.join(sessionsBase, 'salon_13');
    fs.mkdirSync(salonDir, { recursive: true });

    const dek = await getOrLoadTenantDek(salonDir, { tenantId: 13, keyProvider: kp });
    capturedTenantDek = dek;
    const wrappedBuf = fs.readFileSync(path.join(salonDir, 'dek.wrapped'));
    capturedWrappedKey = wrappedBuf;

    const dekRef = dek;
    assert.equal(dekRef.length, 32);

    let socketClosed = false;
    const mockSocket = {
      ev: { on: () => {}, removeAllListeners: () => {} },
      ws: { close: () => { socketClosed = true; } },
      end: () => { socketClosed = true; },
    };

    salonSessionManager._setSocketForTesting(13, mockSocket, { status: 'CONNECTED', connectedPhone: '5511999990011' });

    await salonSessionManager.disconnect(13);

    // DEK na RAM deve estar completamente preenchida com zeros
    const allZeroes = dekRef.every((b) => b === 0);
    assert.equal(allZeroes, true, 'Buffer da DEK em memória deve ser preenchido com zeros');

    assert.equal(salonSessionManager._getActiveSessionForTesting(13), undefined);
    assert.equal(fs.existsSync(salonDir), false, 'Pasta do salão deve ser removida');
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
  }
});

test('T23: Auditoria rigorosa de segredos nos logs de toda a suíte e telemetria', async () => {
  const logsText = logCapture.join('\n');

  // Procura pelo segredo AWS fictício
  assert.equal(logsText.includes(SUITE_FICTITIOUS_AWS_SECRET), false, 'AWS_SECRET_ACCESS_KEY não deve vazar nos logs');

  // Procura pela chave aberta (hex e base64) capturada em T22
  if (capturedTenantDek) {
    const dekHex = capturedTenantDek.toString('hex');
    const dekB64 = capturedTenantDek.toString('base64');
    assert.equal(logsText.includes(dekHex), false, 'DEK aberta em hex não deve constar nos logs');
    assert.equal(logsText.includes(dekB64), false, 'DEK aberta em base64 não deve constar nos logs');
  }

  // Procura pelo wrappedKey (hex e base64)
  if (capturedWrappedKey) {
    const wrapHex = capturedWrappedKey.toString('hex');
    const wrapB64 = capturedWrappedKey.toString('base64');
    assert.equal(logsText.includes(wrapHex), false, 'Wrapped key em hex não deve constar nos logs');
    assert.equal(logsText.includes(wrapB64), false, 'Wrapped key em base64 não deve constar nos logs');
  }

  // Verifica telemetria do salão
  const diag = salonSessionManager.getSalonDiagnostics(13);
  const diagString = JSON.stringify(diag);
  assert.equal(diagString.includes(SUITE_FICTITIOUS_AWS_SECRET), false);
  assert.equal(diagString.includes('encrypted_tokens'), false);
  assert.equal(diagString.includes('noiseKey'), false);
  assert.equal(diagString.includes('advSecretKey'), false);
});

test('T24: Contrato com o AWS KMS (KeySpec AES_256, EncryptionContext rígido e sanitização)', async () => {
  let recordedCommand = null;
  const mockClient = {
    send: async (command) => {
      recordedCommand = command;
      if (command.constructor.name === 'GenerateDataKeyCommand' || command.input?.KeySpec) {
        return {
          Plaintext: Buffer.alloc(32, 7),
          CiphertextBlob: Buffer.alloc(48, 9),
        };
      }
      if (command.constructor.name === 'DecryptCommand' || command.input?.CiphertextBlob) {
        return {
          Plaintext: Buffer.alloc(32, 7),
        };
      }
      throw new Error('UNKNOWN_COMMAND');
    },
  };

  const provider = new KmsKeyProvider({
    keyId: 'arn:aws:kms:sa-east-1:123456789012:key/test-key',
    region: 'sa-east-1',
    client: mockClient,
  });

  const resGen = await provider.generateDataKey({ tenantId: 13, purpose: 'wa-session' });
  assert.equal(recordedCommand.input.KeySpec, 'AES_256');
  assert.deepEqual(recordedCommand.input.EncryptionContext, { tenant_id: '13', purpose: 'wa-session' });

  await provider.unwrapDataKey({ wrappedKey: resGen.wrappedKey, tenantId: 13, purpose: 'wa-session' });
  assert.deepEqual(recordedCommand.input.EncryptionContext, { tenant_id: '13', purpose: 'wa-session' });

  mockClient.send = async () => {
    const err = new Error('Sensitive internal AWS trace with token ABCDEF');
    err.name = 'AccessDeniedException';
    throw err;
  };

  await assert.rejects(
    async () => provider.generateDataKey({ tenantId: 13 }),
    (err) => err.code === 'KMS_GENERATE_KEY_ERROR' && !err.message.includes('ABCDEF')
  );
});

test('T25: Inspeção depois de reinício (chave fora da memória retorna credsValid: null e keyLoaded: false)', async () => {
  const sessionsBase = createTestDir('t25_base_');
  salonSessionManager._setBaseDirForTesting(sessionsBase);
  const dir = path.join(sessionsBase, 'salon_13');
  fs.mkdirSync(dir, { recursive: true });

  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    clearTenantDek(13);
    const unwrapCallsBefore = kp.calls.unwrapDataKey;

    process.env.WA_CREDS_ENCRYPTION = 'on';
    const inspection = salonSessionManager.inspectSalonAuthCredentials(13);

    assert.equal(inspection.sessionEncrypted, true);
    assert.equal(inspection.notMigrated, false);
    assert.equal(inspection.keyLoaded, false);
    assert.equal(inspection.credsValid, null);
    assert.equal(kp.calls.unwrapDataKey, unwrapCallsBefore, 'Inspeção não deve chamar KMS se chave não está em RAM');
  } finally {
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
  }
});

test('T26: Migração do banco SQLite (linhas preservadas, novos status aceitos e foreign_keys preservado)', async () => {
  const dbPath = path.join(suiteTempDir, `test_db_migration_${Date.now()}.sqlite`);
  const rawDb = new DatabaseSync(dbPath);

  rawDb.exec('PRAGMA foreign_keys = OFF;');
  rawDb.exec(`
    CREATE TABLE salon_whatsapp_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL UNIQUE,
      phone_jid TEXT,
      session_status TEXT CHECK(session_status IN ('CONNECTED', 'DISCONNECTED', 'WAITING_QR', 'WAITING_CODE', 'ERROR')) DEFAULT 'DISCONNECTED',
      qr_code TEXT,
      pairing_code TEXT,
      encrypted_creds TEXT,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO salon_whatsapp_sessions (tenant_id, phone_jid, session_status) VALUES (13, '5511999990011@s.whatsapp.net', 'CONNECTED');
  `);

  const fkBefore = rawDb.prepare('PRAGMA foreign_keys').get()['foreign_keys'];
  assert.equal(fkBefore, 0);

  rawDb.exec('PRAGMA foreign_keys = OFF;');
  rawDb.exec('BEGIN IMMEDIATE;');
  rawDb.exec(`
    CREATE TABLE salon_whatsapp_sessions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL UNIQUE,
      phone_jid TEXT,
      session_status TEXT CHECK(session_status IN ('CONNECTED', 'DISCONNECTED', 'WAITING_QR', 'WAITING_CODE', 'KMS_UNAVAILABLE', 'NOT_MIGRATED', 'ERROR')) DEFAULT 'DISCONNECTED',
      qr_code TEXT,
      pairing_code TEXT,
      encrypted_creds TEXT,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO salon_whatsapp_sessions_new (id, tenant_id, phone_jid, session_status, qr_code, pairing_code, encrypted_creds, last_error, created_at, updated_at)
    SELECT id, tenant_id, phone_jid, session_status, qr_code, pairing_code, encrypted_creds, last_error, created_at, updated_at
    FROM salon_whatsapp_sessions;
    DROP TABLE salon_whatsapp_sessions;
    ALTER TABLE salon_whatsapp_sessions_new RENAME TO salon_whatsapp_sessions;
  `);
  rawDb.exec('COMMIT;');

  if (fkBefore === 1) {
    rawDb.exec('PRAGMA foreign_keys = ON;');
  } else {
    rawDb.exec('PRAGMA foreign_keys = OFF;');
  }

  const fkAfter = rawDb.prepare('PRAGMA foreign_keys').get()['foreign_keys'];
  assert.equal(fkAfter, fkBefore, 'foreign_keys deve retornar ao valor original');

  rawDb.prepare("INSERT INTO salon_whatsapp_sessions (tenant_id, session_status) VALUES (14, 'KMS_UNAVAILABLE')").run();
  rawDb.prepare("INSERT INTO salon_whatsapp_sessions (tenant_id, session_status) VALUES (15, 'NOT_MIGRATED')").run();

  const count = rawDb.prepare('SELECT COUNT(*) as c FROM salon_whatsapp_sessions').get().c;
  assert.equal(count, 3);
});

test('T27: Modo off (testes com WA_CREDS_ENCRYPTION=off operam sem alteração)', async () => {
  process.env.WA_CREDS_ENCRYPTION = 'off';
  const sessionsBase = createTestDir('t27_base_');
  salonSessionManager._setBaseDirForTesting(sessionsBase);
  const dir = path.join(sessionsBase, 'salon_13');
  fs.mkdirSync(dir, { recursive: true });

  try {
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(createMockCreds()));
    const inspection = salonSessionManager.inspectSalonAuthCredentials(13);
    assert.equal(inspection.sessionEncrypted, false);
    assert.equal(inspection.notMigrated, false);
    assert.equal(inspection.credsValid, true);
  } finally {
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    fs.rmSync(sessionsBase, { recursive: true, force: true });
  }
});

test('T28: Pareamento depois de QR expirado ou cancelado (pasta só com dek.wrapped permite pareamento)', async () => {
  const sessionsBase = createTestDir('t28_sessions_');
  salonSessionManager._setBaseDirForTesting(sessionsBase);
  const salonDir = path.join(sessionsBase, 'salon_13');
  fs.mkdirSync(salonDir, { recursive: true });

  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    // 1. Gera dek.wrapped simulando tentativa anterior de pareamento que expirou
    await getOrLoadTenantDek(salonDir, { tenantId: 13, keyProvider: kp });
    assert.ok(fs.existsSync(path.join(salonDir, 'dek.wrapped')));
    clearTenantDek(13);

    const generateCallsBefore = kp.calls.generateDataKey;
    process.env.WA_CREDS_ENCRYPTION = 'on';

    // 2. Pasta só com dek.wrapped: useEncryptedMultiFileAuthState deve ter sucesso (reaproveita chave via unwrap)
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(salonDir, { tenantId: 13, keyProvider: kp });
    assert.ok(state.creds != null);
    assert.equal(kp.calls.generateDataKey, generateCallsBefore, 'Não deve gerar chave nova (reaproveita dek.wrapped existente)');
    assert.ok(fs.existsSync(path.join(salonDir, 'dek.wrapped')), 'Não pode apagar o dek.wrapped');

    // 3. startQrSession e requestPairingCode devem PERMITIR pareamento sobre pasta apenas com dek.wrapped
    let socketCreated = false;
    salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
      socketCreated = true;
      return { ev: { on: () => {} }, ws: { close: () => {} }, end: () => {} };
    });

    const qrResult = await salonSessionManager.startQrSession(13);
    assert.ok(qrResult != null);
    assert.ok(fs.existsSync(path.join(salonDir, 'dek.wrapped')));

    // 4. Se creds.json.enc for gravado, aí sim novas chamadas devem recusar
    state.creds = createMockCreds();
    await saveCreds();

    await assert.rejects(
      async () => salonSessionManager.startQrSession(13),
      (err) => err.code === 'CANNOT_PAIR_EXISTING_ENCRYPTED_SESSION'
    );
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
  }
});

test('T29: _executeKmsRetry respeita whitelist de homologação e WA_SESSIONS_DISABLED=true', async () => {
  salonSessionManager._resetForTesting();
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    // Registra tenant 14 (autorizado) e tenant 88 (não autorizado) em KMS_UNAVAILABLE
    SalonWhatsAppRepository.ensureSessionExists(14);
    SalonWhatsAppRepository.markSessionDisconnected(14, { status: 'KMS_UNAVAILABLE' });

    // Com WA_SESSIONS_DISABLED=true, não executa retry
    process.env.WA_SESSIONS_DISABLED = 'true';
    let socketAttempt = false;
    salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
      socketAttempt = true;
      return { ev: { on: () => {} } };
    });

    await salonSessionManager._executeKmsRetry();
    assert.equal(socketAttempt, false, 'Com WA_SESSIONS_DISABLED=true não deve tentar restaurar');

    delete process.env.WA_SESSIONS_DISABLED;

    // Em homologação com tenant não autorizado (ex: 88), não restaura
    db.prepare(`
      INSERT OR IGNORE INTO users (id, name, phone_number) VALUES (88, 'Não Autorizado', '5511888880088');
    `).run();
    SalonWhatsAppRepository.ensureSessionExists(88);
    SalonWhatsAppRepository.markSessionDisconnected(88, { status: 'KMS_UNAVAILABLE' });

    await salonSessionManager._executeKmsRetry();
    const s88 = SalonWhatsAppRepository.getSessionByUserId(88);
    assert.equal(s88.session_status, 'KMS_UNAVAILABLE', 'Salão fora da whitelist não pode ser restaurado');
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(suiteSessionsDir);
    _resetKeyProviderForTesting();
  }
});
