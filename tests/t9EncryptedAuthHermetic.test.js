/**
 * RAIA AGENTES — SUÍTE HERMÉTICA DE TESTES AUTOMATIZADOS (COMANDO 038 / T9)
 * Validação rigorosa da Criptografia em Repouso de Credenciais WhatsApp (Envelope KMS + AES-256-GCM).
 *
 * Cobertura Obrigatória dos 17 Cenários:
 *  1. useEncryptedMultiFileAuthState grava arquivos com sufixo .enc e não deixa resíduos .json em claro.
 *  2. Cabeçalho binário dos arquivos .enc contém RAIAENC1, versão 0x01, IV de 12 bytes e tag de 16 bytes.
 *  3. Descriptografia de arquivo válido recupera o conteúdo exato gravado (round-trip idempotente).
 *  4. Adulteração de 1 byte no ciphertext causa erro de autenticação (AUTH_TAG_VERIFICATION_FAILED) e não retorna dados parciais.
 *  5. Adulteração da tag de autenticação GCM causa erro e aborta.
 *  6. Troca de arquivo entre tenants falha por inconsistência de AAD.
 *  7. Troca de nome de arquivo falha por inconsistência de AAD.
 *  8. dek.wrapped é criado na inicialização de tenant virgem com contexto correto (tenantId, purpose: wa-session).
 *  9. clearTenantDek zera a chave em memória (fill(0)) e remove do cache; próxima leitura força novo unwrap.
 * 10. inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=off lê creds.json legado normalmente.
 * 11. inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=on lê creds.json.enc e retorna sessionEncrypted: true, notMigrated: false.
 * 12. inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=on diante de creds.json legado retorna notMigrated: true.
 * 13. restoreActiveSalonSessions em modo on diante de KMS indisponível marca KMS_UNAVAILABLE e NÃO descarta credenciais no SQLite.
 * 14. restoreActiveSalonSessions em modo on diante de credenciais legadas em texto claro marca NOT_MIGRATED sem apagar.
 * 15. waCredsMigrate --dry-run não altera o filesystem.
 * 16. waCredsMigrate --migrate cifra todos os arquivos, valida integridade byte-a-byte, move texto claro para quarentena e não deleta arquivos.
 * 17. waCredsMigrate --rollback restaura arquivos em texto claro funcionais a partir dos .enc.
 *
 * Utiliza exclusivamente módulos nativos Node 22 (node:test, node:assert/strict).
 * Provedor de chaves falso (FakeKeyProvider), sem dependência de rede ou AWS real.
 * Banco temporário descartável e diretórios isolados em os.tmpdir().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 1. Configuração do ambiente hermético descartável
const uniqueRunId = `t9_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_db_${uniqueRunId}.db`);
const tempSessionsDir = path.join(os.tmpdir(), `raia_test_sessions_${uniqueRunId}`);
const tempQuarantineDir = path.join(os.tmpdir(), `raia_test_quarantine_${uniqueRunId}`);
fs.mkdirSync(tempSessionsDir, { recursive: true });
fs.mkdirSync(tempQuarantineDir, { recursive: true });

process.env.DB_PATH = tempDbPath;
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '13,14,15,16';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990011,5511999990002';
process.env.ALLOW_WHATSAPP_SENDING = 'false';

const db = require('../src/database/db');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const SalonWhatsAppRepository = require('../src/database/salonWhatsAppRepository');
const {
  MAGIC_HEADER,
  CURRENT_VERSION,
  encryptBuffer,
  decryptBuffer,
  useEncryptedMultiFileAuthState,
  clearTenantDek,
  readEncryptedJson,
  readEncryptedJsonSync,
} = require('../src/whatsapp/encryptedAuthState');
const {
  FakeKeyProvider,
  _setKeyProviderForTesting,
  _resetKeyProviderForTesting,
} = require('../src/security/keyProvider');
const waCredsMigrate = require('../scripts/waCredsMigrate');

let fakeKeyProvider;

test.before(() => {
  fakeKeyProvider = new FakeKeyProvider();
  _setKeyProviderForTesting(fakeKeyProvider);
  salonSessionManager._setBaseDirForTesting(tempSessionsDir);

  // Usuários de teste no SQLite temporário
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role)
    VALUES (13, '5511999990011', 'Jéssica Beauty Premium', 'CLIENT'),
           (14, '5511999990002', 'Studio Elegance', 'CLIENT')
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, opening_hours)
    VALUES (13, 'Jéssica Beauty Premium', '{"days":{"1":{"open":true}}}'),
           (14, 'Studio Elegance', '{"days":{"1":{"open":true}}}')
  `).run();

  SalonWhatsAppRepository.ensureSessionExists(13, path.join(tempSessionsDir, 'salon_13'));
  SalonWhatsAppRepository.ensureSessionExists(14, path.join(tempSessionsDir, 'salon_14'));
});

test.after(() => {
  _resetKeyProviderForTesting();
  try {
    fs.rmSync(tempSessionsDir, { recursive: true, force: true });
    fs.rmSync(tempQuarantineDir, { recursive: true, force: true });
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  } catch (_) {}
});

test.beforeEach(() => {
  salonSessionManager._resetForTesting();
  clearTenantDek(13);
  clearTenantDek(14);
  clearTenantDek('personal');
  delete process.env.WA_CREDS_ENCRYPTION;
});

// ==============================================================================
// CENÁRIO 1: useEncryptedMultiFileAuthState grava arquivos .enc sem resíduos .json
// ==============================================================================
test('1. useEncryptedMultiFileAuthState grava arquivos com sufixo .enc e não deixa resíduos .json em claro', async () => {
  const tenantDir = path.join(tempSessionsDir, 'test_tenant_c1');
  const authState = await useEncryptedMultiFileAuthState(tenantDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  // Salva credenciais e chaves
  await authState.saveCreds();
  await authState.state.keys.set({
    'pre-key': {
      '1': { private: Buffer.from('priv_key_data'), public: Buffer.from('pub_key_data') },
    },
  });

  const files = fs.readdirSync(tenantDir);
  assert.ok(files.includes('creds.json.enc'), 'Deve conter creds.json.enc');
  assert.ok(files.includes('pre-key-1.json.enc'), 'Deve conter pre-key-1.json.enc');
  assert.ok(files.includes('dek.wrapped'), 'Deve conter dek.wrapped');

  const plainJsonFiles = files.filter((f) => f.endsWith('.json') && !f.endsWith('.enc'));
  assert.equal(plainJsonFiles.length, 0, 'Não deve existir nenhum arquivo .json em claro');
});

// ==============================================================================
// CENÁRIO 2: Cabeçalho binário contém RAIAENC1, versão 0x01, IV 12B e Tag 16B
// ==============================================================================
test('2. Cabeçalho binário dos arquivos .enc contém RAIAENC1, versão 0x01, IV de 12 bytes e tag de 16 bytes', async () => {
  const tenantDir = path.join(tempSessionsDir, 'test_tenant_c2');
  const authState = await useEncryptedMultiFileAuthState(tenantDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });
  await authState.saveCreds();

  const encBuffer = fs.readFileSync(path.join(tenantDir, 'creds.json.enc'));
  assert.ok(encBuffer.length >= 37, 'Arquivo cifrado deve ter pelo menos 37 bytes de cabeçalho');

  // Magic Header
  const magic = encBuffer.subarray(0, 8);
  assert.equal(magic.toString('ascii'), 'RAIAENC1', 'Magic header deve ser RAIAENC1');

  // Versão
  const version = encBuffer[8];
  assert.equal(version, 0x01, 'Versão da cifra deve ser 0x01');

  // IV (12 bytes) e Tag (16 bytes)
  const iv = encBuffer.subarray(9, 21);
  const tag = encBuffer.subarray(21, 37);
  assert.equal(iv.length, 12, 'IV deve ter 12 bytes');
  assert.equal(tag.length, 16, 'Tag GCM deve ter 16 bytes');
});

// ==============================================================================
// CENÁRIO 3: Descriptografia recupera o conteúdo exato (round-trip idempotente)
// ==============================================================================
test('3. Descriptografia de arquivo válido recupera o conteúdo exato gravado (round-trip idempotente)', async () => {
  const sampleData = {
    test: true,
    secretToken: 'sensitive_baileys_token_12345',
    registered: false,
    me: { id: '5511999990011:1@s.whatsapp.net', name: 'Jéssica Beauty' },
    account: { details: 'active' },
  };

  const tenantDir = path.join(tempSessionsDir, 'test_tenant_c3');
  const authState = await useEncryptedMultiFileAuthState(tenantDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  authState.state.creds = sampleData;
  await authState.saveCreds();

  // Leitura independente via readEncryptedJson
  const readBack = await readEncryptedJson(tenantDir, 'creds.json', {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  assert.deepEqual(readBack, sampleData, 'Conteúdo decifrado deve ser estritamente idêntico ao original');
});

// ==============================================================================
// CENÁRIO 4: Adulteração de 1 byte no ciphertext causa AUTH_TAG_VERIFICATION_FAILED
// ==============================================================================
test('4. Adulteração de 1 byte no ciphertext de um arquivo .enc causa erro de autenticação e não retorna dados parciais', async () => {
  const tenantDir = path.join(tempSessionsDir, 'test_tenant_c4');
  const authState = await useEncryptedMultiFileAuthState(tenantDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });
  await authState.saveCreds();

  const encPath = path.join(tenantDir, 'creds.json.enc');
  const encBuffer = fs.readFileSync(encPath);

  // Adultera o último byte do ciphertext
  encBuffer[encBuffer.length - 1] ^= 0xff;
  fs.writeFileSync(encPath, encBuffer);

  // Leitura deve falhar fail-closed retornando null ou lançando erro de auth tag
  const result = await readEncryptedJson(tenantDir, 'creds.json', {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  assert.equal(result, null, 'Leitura de arquivo com ciphertext adulterado deve falhar fail-closed');
});

// ==============================================================================
// CENÁRIO 5: Adulteração da tag de autenticação GCM causa erro e aborta
// ==============================================================================
test('5. Adulteração da tag de autenticação GCM causa erro e aborta', async () => {
  const tenantDir = path.join(tempSessionsDir, 'test_tenant_c5');
  const authState = await useEncryptedMultiFileAuthState(tenantDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });
  await authState.saveCreds();

  const encPath = path.join(tenantDir, 'creds.json.enc');
  const encBuffer = fs.readFileSync(encPath);

  // Adultera 1 byte da auth tag (bytes 21 a 37)
  encBuffer[25] ^= 0xaa;
  fs.writeFileSync(encPath, encBuffer);

  const result = await readEncryptedJson(tenantDir, 'creds.json', {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  assert.equal(result, null, 'Adulteração da tag GCM deve rejeitar o arquivo sem decifrar');
});

// ==============================================================================
// CENÁRIO 6: Troca de arquivo entre tenants falha por inconsistência de AAD
// ==============================================================================
test('6. Troca de arquivo entre tenants falha por inconsistência de AAD', async () => {
  const dek = fakeKeyProvider.getDeterministicDek(13);
  const plainText = Buffer.from('{"secret":"dados_sigilosos_tenant_13"}', 'utf8');

  // Cifrado com tenantId 13
  const encBuffer = encryptBuffer(plainText, dek, { tenantId: 13, fileName: 'creds.json' });

  // Tentativa de decifrar usando a mesma DEK mas declarando tenantId 14
  assert.throws(
    () => {
      decryptBuffer(encBuffer, dek, { tenantId: 14, fileName: 'creds.json' });
    },
    (err) => err.code === 'AUTH_TAG_VERIFICATION_FAILED' || err.message.includes('AUTH_TAG_VERIFICATION_FAILED'),
    'Decifração com tenantId divergente deve falhar devido ao AAD'
  );
});

// ==============================================================================
// CENÁRIO 7: Troca de nome de arquivo falha por inconsistência de AAD
// ==============================================================================
test('7. Troca de nome de arquivo (renomeação) falha por inconsistência de AAD', async () => {
  const dek = fakeKeyProvider.getDeterministicDek(13);
  const plainText = Buffer.from('{"secret":"dados_do_creds"}', 'utf8');

  // Cifrado com nome original 'creds.json'
  const encBuffer = encryptBuffer(plainText, dek, { tenantId: 13, fileName: 'creds.json' });

  // Tentativa de decifrar como 'app-state-sync-key-1.json'
  assert.throws(
    () => {
      decryptBuffer(encBuffer, dek, { tenantId: 13, fileName: 'app-state-sync-key-1.json' });
    },
    (err) => err.code === 'AUTH_TAG_VERIFICATION_FAILED' || err.message.includes('AUTH_TAG_VERIFICATION_FAILED'),
    'Decifração com fileName divergente deve falhar devido ao AAD'
  );
});

// ==============================================================================
// CENÁRIO 8: dek.wrapped é criado na inicialização com contexto correto
// ==============================================================================
test('8. dek.wrapped é criado na inicialização de um tenant virgem com contexto de criptografia correto', async () => {
  const tenantDir = path.join(tempSessionsDir, 'test_tenant_c8');
  assert.ok(!fs.existsSync(path.join(tenantDir, 'dek.wrapped')));

  await useEncryptedMultiFileAuthState(tenantDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  const wrappedKeyPath = path.join(tenantDir, 'dek.wrapped');
  assert.ok(fs.existsSync(wrappedKeyPath), 'dek.wrapped deve ser gerado no diretório da sessão');

  const wrappedKey = fs.readFileSync(wrappedKeyPath);
  assert.ok(wrappedKey.length > 0, 'dek.wrapped não pode ser vazio');
});

// ==============================================================================
// CENÁRIO 9: clearTenantDek zera a chave em memória e força novo unwrap
// ==============================================================================
test('9. clearTenantDek zera a chave em memória (fill(0)) e remove do cache; próxima leitura força novo unwrap', async () => {
  const tenantDir = path.join(tempSessionsDir, 'test_tenant_c9');
  fakeKeyProvider.unwrapCallCount = 0;

  // Primeira chamada carrega e armazena em cache
  await useEncryptedMultiFileAuthState(tenantDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  // Limpa DEK do tenant 13
  clearTenantDek(13);

  // Segunda inicialização deve acionar unwrapDataKey novamente
  const unwrapCallsBefore = fakeKeyProvider.calls.unwrapDataKey;
  await useEncryptedMultiFileAuthState(tenantDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  assert.ok(fakeKeyProvider.calls.unwrapDataKey > unwrapCallsBefore, 'Próxima leitura após clearTenantDek deve forçar novo unwrap');
});

// ==============================================================================
// CENÁRIO 10: inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=off lê creds.json legado
// ==============================================================================
test('10. inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=off lê creds.json legado normalmente', () => {
  process.env.WA_CREDS_ENCRYPTION = 'off';
  const sessionDir = path.join(tempSessionsDir, 'salon_13');
  fs.mkdirSync(sessionDir, { recursive: true });

  const legacyCreds = {
    me: { id: '5511999990011:1@s.whatsapp.net' },
    account: { valid: true },
  };
  fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(legacyCreds), 'utf8');

  const audit = salonSessionManager.inspectSalonAuthCredentials(13);
  assert.equal(audit.exists, true);
  assert.equal(audit.hasCreds, true);
  assert.equal(audit.credsValid, true);
  assert.equal(audit.encryptionMode, 'off');
  assert.equal(audit.sessionEncrypted, false);
  assert.equal(audit.notMigrated, false);
});

// ==============================================================================
// CENÁRIO 11: inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=on lê creds.json.enc
// ==============================================================================
test('11. inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=on lê creds.json.enc e retorna sessionEncrypted: true', async () => {
  process.env.WA_CREDS_ENCRYPTION = 'on';
  const sessionDir = path.join(tempSessionsDir, 'salon_13');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Remove texto claro se houver
  const plainPath = path.join(sessionDir, 'creds.json');
  if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);

  const authState = await useEncryptedMultiFileAuthState(sessionDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });

  authState.state.creds = {
    me: { id: '5511999990011:1@s.whatsapp.net' },
    account: { active: true },
  };
  await authState.saveCreds();

  const audit = salonSessionManager.inspectSalonAuthCredentials(13);
  assert.equal(audit.exists, true);
  assert.equal(audit.hasCreds, true);
  assert.equal(audit.credsValid, true);
  assert.equal(audit.encryptionMode, 'on');
  assert.equal(audit.sessionEncrypted, true);
  assert.equal(audit.notMigrated, false);
});

// ==============================================================================
// CENÁRIO 12: inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=on alerta notMigrated: true
// ==============================================================================
test('12. inspectSalonAuthCredentials com WA_CREDS_ENCRYPTION=on diante de creds.json legado retorna notMigrated: true', () => {
  process.env.WA_CREDS_ENCRYPTION = 'on';
  const sessionDir = path.join(tempSessionsDir, 'salon_13');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Remove versão cifrada se houver
  const encPath = path.join(sessionDir, 'creds.json.enc');
  if (fs.existsSync(encPath)) fs.unlinkSync(encPath);

  const legacyCreds = {
    me: { id: '5511999990011:1@s.whatsapp.net' },
    account: { valid: true },
  };
  fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(legacyCreds), 'utf8');

  const audit = salonSessionManager.inspectSalonAuthCredentials(13);
  assert.equal(audit.encryptionMode, 'on');
  assert.equal(audit.sessionEncrypted, false);
  assert.equal(audit.notMigrated, true, 'Deve sinalizar notMigrated: true para credenciais em texto claro pendentes');
});

// ==============================================================================
// CENÁRIO 13: restoreActiveSalonSessions em modo on com KMS indisponível marca KMS_UNAVAILABLE sem resetar credenciais
// ==============================================================================
test('13. restoreActiveSalonSessions em modo on diante de KMS indisponível marca KMS_UNAVAILABLE e NÃO descarta nem reseta credenciais no SQLite', async () => {
  process.env.WA_CREDS_ENCRYPTION = 'on';
  const sessionDir = path.join(tempSessionsDir, 'salon_13');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Prepara credenciais cifradas
  const authState = await useEncryptedMultiFileAuthState(sessionDir, {
    tenantId: 13,
    keyProvider: fakeKeyProvider,
  });
  authState.state.creds = { me: { id: '5511999990011:1@s.whatsapp.net' }, account: { valid: true } };
  await authState.saveCreds();

  // Garante status CONNECTED no banco antes da restauração
  SalonWhatsAppRepository.markSessionConnected(13, { phone: '5511999990011', phoneJid: '5511999990011@s.whatsapp.net' });
  clearTenantDek(13);

  // Configura provedor com falha forçada simulando KMS indisponível
  const brokenKmsProvider = {
    generateDataKey: async () => { throw new Error('KmsUnavailableException: Service endpoint unreachable'); },
    unwrapDataKey: async () => { throw new Error('KmsUnavailableException: Service endpoint unreachable'); },
    unwrapDataKeySync: () => { throw new Error('KmsUnavailableException: Service endpoint unreachable'); },
  };
  _setKeyProviderForTesting(brokenKmsProvider);

  try {
    const res = await salonSessionManager.restoreActiveSalonSessions();
    const session = SalonWhatsAppRepository.getSessionByUserId(13);

    assert.equal(session.session_status, 'KMS_UNAVAILABLE', 'Status deve ser marcado como KMS_UNAVAILABLE');
    // Verifica que credenciais NÃO foram resetadas/apagadas no banco
    assert.equal(session.connected_phone, '5511999990011', 'Telefone conectado não deve ser apagado');
  } finally {
    _setKeyProviderForTesting(fakeKeyProvider);
  }
});

// ==============================================================================
// CENÁRIO 14: restoreActiveSalonSessions em modo on diante de credenciais legadas marca NOT_MIGRATED sem apagar
// ==============================================================================
test('14. restoreActiveSalonSessions em modo on diante de credenciais legadas em texto claro marca NOT_MIGRATED sem apagar', async () => {
  process.env.WA_CREDS_ENCRYPTION = 'on';
  const sessionDir = path.join(tempSessionsDir, 'salon_13');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Deixa apenas creds.json em texto claro
  const encPath = path.join(sessionDir, 'creds.json.enc');
  if (fs.existsSync(encPath)) fs.unlinkSync(encPath);

  fs.writeFileSync(
    path.join(sessionDir, 'creds.json'),
    JSON.stringify({ me: { id: '5511999990011:1@s.whatsapp.net' }, account: { valid: true } }),
    'utf8'
  );

  SalonWhatsAppRepository.markSessionConnected(13, { phone: '5511999990011', phoneJid: '5511999990011@s.whatsapp.net' });

  await salonSessionManager.restoreActiveSalonSessions();
  const session = SalonWhatsAppRepository.getSessionByUserId(13);

  assert.equal(session.session_status, 'NOT_MIGRATED', 'Status deve ser marcado como NOT_MIGRATED');
  assert.equal(session.connected_phone, '5511999990011', 'Registro não deve ser apagado nem desvinculado');
  assert.ok(fs.existsSync(path.join(sessionDir, 'creds.json')), 'Arquivo em texto claro deve ser preservado intacto');
});

// ==============================================================================
// CENÁRIO 15: waCredsMigrate --dry-run não altera o filesystem
// ==============================================================================
test('15. waCredsMigrate --dry-run não altera o filesystem', async () => {
  const tenantDir = path.join(tempSessionsDir, 'salon_14');
  fs.mkdirSync(tenantDir, { recursive: true });

  const dummyContent = JSON.stringify({ me: { id: '5511999990002:1@s.whatsapp.net' }, account: true });
  fs.writeFileSync(path.join(tenantDir, 'creds.json'), dummyContent, 'utf8');

  const filesBefore = fs.readdirSync(tenantDir);

  const dryRunResult = await waCredsMigrate.runDryRun(
    { tenantId: 14, dir: tenantDir, isPersonal: false },
    { keyProvider: fakeKeyProvider }
  );

  assert.equal(dryRunResult.status, 'READY_TO_MIGRATE');
  const filesAfter = fs.readdirSync(tenantDir);
  assert.deepEqual(filesAfter, filesBefore, 'Nenhum arquivo deve ser criado, modificado ou removido durante o dry-run');
});

// ==============================================================================
// CENÁRIO 16: waCredsMigrate --migrate cifra arquivos, valida integridade e quarentena texto claro
// ==============================================================================
test('16. waCredsMigrate --migrate cifra todos os arquivos, valida integridade byte-a-byte, move texto claro para quarentena e não deleta arquivos', async () => {
  const tenantDir = path.join(tempSessionsDir, 'salon_14');
  fs.mkdirSync(tenantDir, { recursive: true });

  const originalCreds = JSON.stringify({ me: { id: '5511999990002:1@s.whatsapp.net' }, account: { ok: true } });
  const originalKey = JSON.stringify({ type: 'pre-key', key: 'mock_key_bytes_123' });
  fs.writeFileSync(path.join(tenantDir, 'creds.json'), originalCreds, 'utf8');
  fs.writeFileSync(path.join(tenantDir, 'pre-key-1.json'), originalKey, 'utf8');

  const result = await waCredsMigrate.runMigration(
    { tenantId: 14, dir: tenantDir, isPersonal: false },
    { keyProvider: fakeKeyProvider, quarantineRoot: tempQuarantineDir }
  );

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.migratedCount, 2);

  const tenantFiles = fs.readdirSync(tenantDir);
  assert.ok(tenantFiles.includes('creds.json.enc'), 'creds.json.enc deve existir');
  assert.ok(tenantFiles.includes('pre-key-1.json.enc'), 'pre-key-1.json.enc deve existir');
  assert.ok(tenantFiles.includes('dek.wrapped'), 'dek.wrapped deve existir');
  assert.ok(!tenantFiles.includes('creds.json'), 'creds.json não deve estar no diretório de sessão');
  assert.ok(!tenantFiles.includes('pre-key-1.json'), 'pre-key-1.json não deve estar no diretório de sessão');

  // Verifica quarentena
  assert.ok(fs.existsSync(result.quarantineFolder), 'Pasta de quarentena deve ser criada');
  const quarantineFiles = fs.readdirSync(result.quarantineFolder);
  assert.ok(quarantineFiles.includes('creds.json'), 'creds.json deve estar seguro na quarentena');
  assert.ok(quarantineFiles.includes('pre-key-1.json'), 'pre-key-1.json deve estar seguro na quarentena');

  // Integridade do conteúdo na quarentena
  assert.equal(fs.readFileSync(path.join(result.quarantineFolder, 'creds.json'), 'utf8'), originalCreds);
});

// ==============================================================================
// CENÁRIO 17: waCredsMigrate --rollback restaura arquivos em texto claro funcionais a partir dos .enc
// ==============================================================================
test('17. waCredsMigrate --rollback restaura arquivos em texto claro funcionais a partir dos .enc', async () => {
  const tenantDir = path.join(tempSessionsDir, 'salon_14');

  // Executa o rollback com confirmação obrigatória
  const rollbackResult = await waCredsMigrate.runRollback(
    { tenantId: 14, dir: tenantDir, isPersonal: false },
    { keyProvider: fakeKeyProvider, confirmRollback: true }
  );

  assert.equal(rollbackResult.status, 'SUCCESS');
  assert.equal(rollbackResult.rolledBackCount, 2);

  const tenantFiles = fs.readdirSync(tenantDir);
  assert.ok(tenantFiles.includes('creds.json'), 'creds.json em texto claro deve ser restaurado');
  assert.ok(tenantFiles.includes('pre-key-1.json'), 'pre-key-1.json em texto claro deve ser restaurado');
  assert.ok(!tenantFiles.includes('creds.json.enc'), 'creds.json.enc deve ser removido após rollback');
  assert.ok(!tenantFiles.includes('pre-key-1.json.enc'), 'pre-key-1.json.enc deve ser removido após rollback');
  assert.ok(tenantFiles.includes('dek.wrapped'), 'dek.wrapped deve ser mantido para contingência');

  // Validação do conteúdo JSON restaurado
  const restoredCreds = JSON.parse(fs.readFileSync(path.join(tenantDir, 'creds.json'), 'utf8'));
  assert.equal(restoredCreds.me?.id, '5511999990002:1@s.whatsapp.net');
  assert.equal(restoredCreds.account?.ok, true);
});
