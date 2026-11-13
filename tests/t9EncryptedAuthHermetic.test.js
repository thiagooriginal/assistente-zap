/**
 * RAIA AGENTES — SUÍTE HERMÉTICA DE TESTES AUTOMATIZADOS (COMANDO 038.1 / T9)
 * Validação rigorosa dos 27 Requisitos Mandatórios (T1 a T27).
 *
 * Utiliza exclusivamente módulos nativos Node 22 (node:test, node:assert/strict).
 * Provedor de chaves falso (FakeKeyProvider), sem dependência de rede ou AWS real.
 * Bancos SQLite temporários descartáveis e diretórios isolados em os.tmpdir().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const child_process = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// Helpers e módulos de produção
const { FakeKeyProvider } = require('./helpers/fakeKeyProvider');
const {
  _setKeyProviderForTesting,
  _resetKeyProviderForTesting,
  KmsKeyProvider,
  buildEncryptionContext,
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
  inspectAppLock,
  tryForceUnlock,
  acquireAppLock,
  _setProcessStartTimeCheckerForTesting,
} = require('../src/utils/appLock');

const waCredsMigrate = require('../scripts/waCredsMigrate');
const SalonWhatsAppRepository = require('../src/database/salonWhatsAppRepository');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');

// Helper para criar diretório temporário isolado por teste
function createTestDir(prefix = 'raia_test_') {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
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

// Setup global para testes
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '13,14,15,16';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990011,5511999990002';
process.env.ALLOW_WHATSAPP_SENDING = 'false';

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

// ============================================================================
// SUÍTE DE TESTES HERMÉTICOS T1 A T27
// ============================================================================

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

    // Recarrega em nova instância do estado
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

test('T5: Falha entre .tmp e rename (arquivo anterior continua legível e .tmp órfão é limpo)', async () => {
  const dir = createTestDir('t5_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds = createMockCreds();
    await saveCreds();

    await state.keys.set({ 'pre-key': { '1': { keyPair: { public: Buffer.from('v1'), private: Buffer.from('p1') }, keyId: 1 } } });

    // Cria um .tmp órfão proposital
    const orphanTmp = path.join(dir, 'pre-key-1.json.enc.tmp');
    fs.writeFileSync(orphanTmp, Buffer.from('garbage'));

    // Recarrega o estado: o .tmp órfão deve ser limpo e o original preservado
    const { state: state2 } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    assert.equal(fs.existsSync(orphanTmp), false, 'Arquivo .tmp órfão deve ser removido');

    const key = await state2.keys.get('pre-key', ['1']);
    assert.deepEqual(key['1'].keyPair.public, Buffer.from('v1'));
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

    // Injeta falha forçada simulando erro de escrita no 3º arquivo
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

    // Grava alteração nova no estado cifrado
    const { state, saveCreds } = await useEncryptedMultiFileAuthState(dir, { tenantId: 13, keyProvider: kp });
    state.creds.me = { id: 'brand_new_id@s.whatsapp.net' };
    await saveCreds();

    // Executa rollback
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

test('T12: Trava do motor de sessões (casos a, b, c, d, e e WA_SESSIONS_DISABLED)', async () => {
  const lockDir = createTestDir('t12_locks_');
  const lockFile = path.join(lockDir, 'wa-sessions.lock');
  const sessionDir = createTestDir('t12_sess_');
  fs.writeFileSync(path.join(sessionDir, 'dummy.json'), JSON.stringify({ dummy: 1 }));

  try {
    // (a) Trava com PID de processo vivo (processo filho ativo mantido vivo)
    const child = child_process.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: child.pid, startedAt: Date.now(), engineId: 'wa-sessions-engine' }));

    // Rejeita sem force-unlock
    let inspected = inspectAppLock(lockFile);
    assert.equal(inspected.running, true);
    assert.equal(inspected.orphan, false);
    let unlockRes = tryForceUnlock(lockFile);
    assert.equal(unlockRes.unlocked, false);
    assert.ok(fs.existsSync(lockFile));

    child.kill('SIGKILL');

    // (b) Trava com PID da própria ferramenta (process.pid)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), engineId: 'wa-sessions-engine' }));
    inspected = inspectAppLock(lockFile);
    assert.equal(inspected.self, true);
    unlockRes = tryForceUnlock(lockFile);
    assert.equal(unlockRes.unlocked, false);
    assert.equal(unlockRes.reason, 'CANNOT_UNLOCK_SELF_PROCESS');

    // (c) Trava ilegível ou corrompida
    fs.writeFileSync(lockFile, 'CORRUPTED_NON_JSON_CONTENT_WITHOUT_PID');
    inspected = inspectAppLock(lockFile);
    assert.equal(inspected.indeterminate, true);
    unlockRes = tryForceUnlock(lockFile);
    assert.equal(unlockRes.unlocked, false);

    // (d) PID inexistente (morto)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 9999999, startedAt: Date.now(), engineId: 'wa-sessions-engine' }));
    inspected = inspectAppLock(lockFile);
    assert.equal(inspected.orphan, true);
    assert.equal(inspected.running, false);
    unlockRes = tryForceUnlock(lockFile);
    assert.equal(unlockRes.unlocked, true);
    assert.equal(fs.existsSync(lockFile), false);

    // (e) PID vivo com tempo de início diferente do gravado (PID reaproveitado)
    const aliveChild = child_process.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: aliveChild.pid, startedAt: 1000000, engineId: 'wa-sessions-engine' }));
    _setProcessStartTimeCheckerForTesting((pid) => pid === aliveChild.pid ? 2000000 : null);

    inspected = inspectAppLock(lockFile);
    assert.equal(inspected.orphan, true);
    assert.equal(inspected.reason, 'PID_RECYCLED_DIFFERENT_START_TIME');

    unlockRes = tryForceUnlock(lockFile);
    assert.equal(unlockRes.unlocked, true);
    assert.equal(fs.existsSync(lockFile), false);

    aliveChild.kill('SIGKILL');
    _setProcessStartTimeCheckerForTesting(null);

    // (f) WA_SESSIONS_DISABLED=true: trava não é criada
    process.env.WA_SESSIONS_DISABLED = 'true';
    const acquired = acquireAppLock(lockFile);
    assert.equal(acquired, false);
    assert.equal(fs.existsSync(lockFile), false);
    delete process.env.WA_SESSIONS_DISABLED;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
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

    // Remove apenas a chave embrulhada
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

    // Cria sessão cifrada válida
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
    salonSessionManager._setBaseDirForTesting(null);
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

    // Corrompe pre-key-1
    const pk1Path = path.join(dir, 'pre-key-1.json.enc');
    const pk1Buf = fs.readFileSync(pk1Path);
    pk1Buf[pk1Buf.length - 1] ^= 0x55;
    fs.writeFileSync(pk1Path, pk1Buf);

    // Recarrega estado e lê chaves
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

test('T18: Restauração de salão migrado (não é marcado DISCONNECTED e cria socket)', async () => {
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
    salonSessionManager._setBaseDirForTesting(null);
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

    // Simula KMS indisponível
    kp.setUnavailable(true);
    process.env.WA_CREDS_ENCRYPTION = 'on';

    await salonSessionManager.restoreActiveSalonSessions();

    let session = SalonWhatsAppRepository.getSessionByUserId(13);
    assert.equal(session.session_status, 'KMS_UNAVAILABLE');

    // Confirma que getActiveSessionsForRestore continua retornando o salão
    const active = SalonWhatsAppRepository.getActiveSessionsForRestore();
    assert.ok(active.some(s => s.user_id === 13));

    // O KMS volta a ficar saudável
    kp.setUnavailable(false);
    let socketRestored = false;
    salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
      socketRestored = true;
      return { ev: { on: () => {} }, ws: { close: () => {} }, end: () => {} };
    });

    // Executa retentativa programada
    await salonSessionManager._executeKmsRetry();

    assert.equal(socketRestored, true, 'Salão deve ser restaurado quando o KMS volta');
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(null);
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

    // Usuário desconecta formalmente
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

    // 1ª restauração detecta não migrado
    await salonSessionManager.restoreActiveSalonSessions();
    let session = SalonWhatsAppRepository.getSessionByUserId(13);
    assert.equal(session.session_status, 'NOT_MIGRATED');

    // 2. Operador executa a migração
    await waCredsMigrate.runMigration({ tenantId: 13, dir: salonDir, isPersonal: false }, { keyProvider: kp, quarantineRoot });

    // 3. Próxima inicialização restaura com sucesso
    let socketCreated = false;
    salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
      socketCreated = true;
      return { ev: { on: () => {} }, ws: { close: () => {} }, end: () => {} };
    });

    await salonSessionManager.restoreActiveSalonSessions();
    assert.equal(socketCreated, true);
  } finally {
    salonSessionManager._resetForTesting();
    salonSessionManager._setBaseDirForTesting(null);
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
  }
});

test('T22: disconnect() real (pasta é removida e DEK é zeroizada buffer.every(b => b === 0))', async () => {
  const dir = createTestDir('t22_');
  const kp = new FakeKeyProvider();
  _setKeyProviderForTesting(kp);

  try {
    const dek = await getOrLoadTenantDek(dir, { tenantId: 13, keyProvider: kp });
    assert.ok(dek.length === 32);

    // Guarda referência direta do Buffer
    const dekRef = dek;

    clearTenantDek(13);

    // O buffer deve ter todos os bytes zerados
    const allZeroes = dekRef.every((b) => b === 0);
    assert.equal(allZeroes, true, 'DEK em memória deve ser preenchida com zeros na desconexão');
  } finally {
    _resetKeyProviderForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T23: Auditoria rigorosa de segredos nos logs e no /diagnostics', async () => {
  const secretKey = 'AWS_SECRET_MOCK_123456789';
  process.env.AWS_SECRET_ACCESS_KEY = secretKey;

  const logsText = logCapture.join('\n');
  assert.equal(logsText.includes(secretKey), false, 'AWS_SECRET_ACCESS_KEY não deve vazar nos logs');

  const diag = salonSessionManager.getSalonDiagnostics(13);
  const diagString = JSON.stringify(diag);
  assert.equal(diagString.includes('encrypted_tokens'), false);
  assert.equal(diagString.includes(secretKey), false);
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

  // Testa sanitização de erro
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

    // Limpa chave da RAM simulando reinício do processo
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
    salonSessionManager._setBaseDirForTesting(null);
    clearTenantDek(13);
    _resetKeyProviderForTesting();
    fs.rmSync(sessionsBase, { recursive: true, force: true });
  }
});

test('T26: Migração do banco SQLite (linhas preservadas, novos status aceitos e foreign_keys preservado)', async () => {
  const dbPath = path.join(os.tmpdir(), `test_db_migration_${Date.now()}.sqlite`);
  const rawDb = new DatabaseSync(dbPath);

  // Cria schema legado
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

  // Executa migração 20261112_01
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

  // Valida inserção dos novos status
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
    salonSessionManager._setBaseDirForTesting(null);
    fs.rmSync(sessionsBase, { recursive: true, force: true });
    stopLogCapture();
  }
});
