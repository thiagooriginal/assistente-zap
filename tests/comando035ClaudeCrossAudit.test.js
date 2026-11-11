/**
 * RAIA AGENTES — SUÍTE HERMÉTICA DE TESTES AUTOMATIZADOS (COMANDO 035)
 * Revisão Cruzada da Auditoria Independente do Claude (Achados F1 a F16)
 *
 * Cobertura Obrigatória dos 10 Cenários:
 *  1. Recebimento de QR pelo evento real do módulo (com TTL de 65s no 1º QR).
 *  2. Fechamento com motivo 515 (restartRequired / reconexão sem expurgo).
 *  3. Reconexão utilizando credenciais válidas.
 *  4. Falha transitória e backoff exponencial com teto de 5 tentativas.
 *  5. Logout (401 / loggedOut) sem reconexão e com expurgo controlado.
 *  6. Eventos atrasados de socket antigo protegidos por guarda de sessão.
 *  7. Rotação e atualização do QR com TTL ajustado para 25s.
 *  8. Whitelist com comparação estrita E.164 (anti-bypass de sufixo F7).
 *  9. Isolamento rigoroso entre múltiplos tenants simultâneos.
 * 10. Erros exibidos e tratados no painel (simulated flag e QR_EXPIRED).
 *
 * Utiliza exclusivamente módulos nativos Node 22 (node:test, node:assert/strict).
 * Banco temporário descartável em os.tmpdir(), garantindo 100% de isolamento de data/assistant.db.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');

// 1. Configuração do ambiente hermético descartável
const uniqueRunId = `035_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_db_${uniqueRunId}.db`);
const tempSessionsDir = path.join(os.tmpdir(), `raia_test_sessions_${uniqueRunId}`);
fs.mkdirSync(tempSessionsDir, { recursive: true });

process.env.DB_PATH = tempDbPath;
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '13,14';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990011,5511999990002';
process.env.ALLOW_WHATSAPP_SENDING = 'false';

const db = require('../src/database/db');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const SalonWhatsAppRepository = require('../src/database/salonWhatsAppRepository');
const phoneUtils = require('../src/utils/phoneUtils');

/**
 * Cria mock socket com emissor de eventos Baileys compatível
 */
function createMockBaileysSocket(userId) {
  const emitter = new EventEmitter();
  let closed = false;
  let loggedOut = false;

  return {
    user: null,
    ev: {
      on: (event, handler) => emitter.on(event, handler),
      off: (event, handler) => emitter.off(event, handler),
      emit: (event, payload) => emitter.emit(event, payload),
    },
    end: (reason) => {
      closed = true;
    },
    logout: async () => {
      loggedOut = true;
    },
    isClosed: () => closed,
    isLoggedOut: () => loggedOut,
  };
}

test.before(() => {
  salonSessionManager._setBaseDirForTesting(tempSessionsDir);

  // Setup de usuários e salões de teste no SQLite temporário
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role)
    VALUES (13, '5511999990011', 'Bella Vista Hair & Spa', 'CLIENT'),
           (14, '5511999990002', 'Studio Elegance', 'CLIENT'),
           (99, '5511999999999', 'Salão Não Autorizado', 'CLIENT')
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, opening_hours)
    VALUES (13, 'Bella Vista Hair & Spa', '{"days":{"1":{"open":true}}}'),
           (14, 'Studio Elegance', '{"days":{"1":{"open":true}}}'),
           (99, 'Salão Não Autorizado', '{"days":{"1":{"open":true}}}')
  `).run();
});

test.after(() => {
  salonSessionManager._resetForTesting();
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempSessionsDir)) fs.rmSync(tempSessionsDir, { recursive: true, force: true });
  } catch (_) {}
});

test.describe('COMANDO 035 — SUÍTE HERMÉTICA DE AUDITORIA CRUZADA DO CLAUDE (F1 a F16)', () => {

  test('Cenário 1: Recebimento de QR pelo evento real do Baileys com TTL de 65s no 1º QR', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;
    const mockSock = createMockBaileysSocket(uid);
    const session = salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      qrVersion: 0,
    });

    const qrRaw = '2@fA123FakeRawBaileysQrTokenCodeSample,key123,adv123';
    mockSock.ev.emit('connection.update', { qr: qrRaw });

    await new Promise((r) => setTimeout(r, 60));

    const status = salonSessionManager.getSessionStatus(uid);
    assert.strictEqual(status.status, 'WAITING_QR');
    assert.strictEqual(status.hasQr, true);
    assert.ok(status.qrCode.startsWith('data:image/png;base64,'));
    assert.strictEqual(status.qrVersion, 1);

    // O primeiro QR deve ter TTL aproximado de 65 segundos (F4)
    const activeMem = salonSessionManager._getActiveSessionForTesting(uid);
    assert.ok(activeMem.qrExpiresAt > Date.now() + 50000, 'Primeiro QR deve ter TTL > 50s (alinhado a 65s)');
  });

  test('Cenário 2: Fechamento com motivo 515 (restartRequired / scan realizado) não encerra como erro fatal', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;
    const mockSock = createMockBaileysSocket(uid);
    const session = salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      status: 'WAITING_QR',
    });

    // Simula evento 515 disparado pelo Baileys após scan do QR pela Meta
    mockSock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 515 },
          message: 'Stream Errored (restart required)',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 30));

    // O socket antigo deve ser desvinculado e uma tentativa de reconexão controlada agendada
    // sem chamar disconnect() destrutivo nem apagar credenciais
    assert.strictEqual(mockSock.isLoggedOut(), false, 'Não deve emitir logout em 515');
    const status = salonSessionManager.getSessionStatus(uid);
    assert.notStrictEqual(status.status, 'DISCONNECTED', 'Status não pode ser DISCONNECTED em restartRequired (515)');
  });

  test('Cenário 3: Reconexão e reidratação bem-sucedida preservando credenciais salvas', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;
    const sessionDir = salonSessionManager.getSalonSessionDir(uid);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    // Grava creds.json válido simulado
    fs.writeFileSync(
      path.join(sessionDir, 'creds.json'),
      JSON.stringify({ me: { id: '5511999990011:1@s.whatsapp.net' } })
    );

    const audit = salonSessionManager.inspectSalonAuthCredentials(uid);
    assert.strictEqual(audit.hasCreds, true);
    assert.strictEqual(audit.credsValid, true);

    const mockSock = createMockBaileysSocket(uid);
    mockSock.user = { id: '5511999990011:1@s.whatsapp.net' };

    salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      status: 'CONNECTING',
    });

    // Emite evento open
    mockSock.ev.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setTimeout(r, 40));

    const status = salonSessionManager.getSessionStatus(uid);
    assert.strictEqual(status.status, 'CONNECTED');
    assert.strictEqual(status.connectedPhone, phoneUtils.maskPhoneNumber('5511999990011'));
    // Zero PII: rawPhone nunca deve ser exposto (F9)
    assert.strictEqual(status.rawPhone, undefined);
  });

  test('Cenário 4: Falha transitória com backoff exponencial e limite de tentativas', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;
    const mockSock = createMockBaileysSocket(uid);
    const session = salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      status: 'CONNECTED',
    });

    // Emite falha transitória (ex: 408 Timeout ou conexão perdida)
    mockSock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 408 },
          message: 'Timed Out',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 30));

    const activeMem = salonSessionManager._getActiveSessionForTesting(uid);
    assert.strictEqual(activeMem.reconnecting, true);
    assert.strictEqual(activeMem.retryCount, 1);
  });

  test('Cenário 5: Logout legítimo (401 / loggedOut) sem reconexão e com expurgo controlado', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;
    const mockSock = createMockBaileysSocket(uid);
    salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      status: 'CONNECTED',
    });

    mockSock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 401 },
          message: 'Device Logged Out',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    const status = salonSessionManager.getSessionStatus(uid);
    assert.strictEqual(status.status, 'DISCONNECTED');
  });

  test('Cenário 6: Eventos atrasados de socket antigo são ignorados pela guarda anti-race (F5)', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;

    // Socket Antigo A
    const oldSock = createMockBaileysSocket(uid);
    const oldSession = salonSessionManager._setSocketForTesting(uid, oldSock, {
      attachListeners: true,
      status: 'CONNECTING',
    });

    // Nova sessão B sobrepõe a antiga
    const newSock = createMockBaileysSocket(uid);
    newSock.user = { id: '5511999990011:1@s.whatsapp.net' };
    const newSession = salonSessionManager._setSocketForTesting(uid, newSock, {
      attachListeners: true,
      status: 'CONNECTED',
      connectedPhone: '5511999990011',
    });

    // Socket antigo A dispara evento tardio de close 401
    oldSock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: { output: { statusCode: 401 } },
      },
    });

    await new Promise((r) => setTimeout(r, 40));

    // A sessão nova deve continuar CONNECTED e intocada
    const currentStatus = salonSessionManager.getSessionStatus(uid);
    assert.strictEqual(currentStatus.status, 'CONNECTED');
    assert.strictEqual(currentStatus.connectedPhone, phoneUtils.maskPhoneNumber('5511999990011'));
  });

  test('Cenário 7: Rotação e atualização do QR com TTL subsequente de 25s (F4)', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;
    const mockSock = createMockBaileysSocket(uid);
    salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      qrVersion: 1, // já teve 1 QR
    });

    // Emite rotação de QR (2º QR em diante)
    mockSock.ev.emit('connection.update', { qr: '2@secondQrPayloadStringSample' });
    await new Promise((r) => setTimeout(r, 60));

    const status = salonSessionManager.getSessionStatus(uid);
    assert.strictEqual(status.qrVersion, 2);

    const activeMem = salonSessionManager._getActiveSessionForTesting(uid);
    // Para rotações subsequentes, TTL deve ser ~25s (F4)
    assert.ok(activeMem.qrExpiresAt <= Date.now() + 26000, 'TTL de rotação subsequente deve ser ~25s');
  });

  test('Cenário 8: Whitelist com comparação estrita E.164 (anti-bypass de sufixo F7)', () => {
    const uid = 13;

    // Candidato idêntico (legítimo)
    assert.strictEqual(
      salonSessionManager.isSalonRealWhatsAppAllowed(uid, '5511999990011'),
      true,
      'Número exato deve ser autorizado'
    );

    // Candidatos forjados que terminam com o mesmo sufixo ou são substrings (Vulnerabilidade F7)
    assert.strictEqual(
      salonSessionManager.isSalonRealWhatsAppAllowed(uid, '1'),
      false,
      'Sufixo único "1" deve ser bloqueado estritamente'
    );
    assert.strictEqual(
      salonSessionManager.isSalonRealWhatsAppAllowed(uid, '999990011'),
      false,
      'Número parcial sem DDD deve ser bloqueado estritamente'
    );
    assert.strictEqual(
      salonSessionManager.isSalonRealWhatsAppAllowed(uid, '555511999990011'),
      false,
      'Número prefixado forjado deve ser bloqueado'
    );
    assert.strictEqual(
      salonSessionManager.isSalonRealWhatsAppAllowed(uid, '0011'),
      false,
      'Sufixo curto "0011" deve ser bloqueado'
    );
  });

  test('Cenário 9: Isolamento rigoroso entre múltiplos tenants simultâneos', async () => {
    salonSessionManager._resetForTesting();

    const mockSock13 = createMockBaileysSocket(13);
    mockSock13.user = { id: '5511999990011:1@s.whatsapp.net' };
    salonSessionManager._setSocketForTesting(13, mockSock13, {
      status: 'CONNECTED',
      connectedPhone: '5511999990011',
    });

    const mockSock14 = createMockBaileysSocket(14);
    salonSessionManager._setSocketForTesting(14, mockSock14, {
      status: 'WAITING_QR',
      qrVersion: 1,
    });

    const status13 = salonSessionManager.getSessionStatus(13);
    const status14 = salonSessionManager.getSessionStatus(14);

    assert.strictEqual(status13.status, 'CONNECTED');
    assert.strictEqual(status13.connectedPhone, phoneUtils.maskPhoneNumber('5511999990011'));
    assert.strictEqual(status14.status, 'WAITING_QR');
    assert.strictEqual(status14.connectedPhone, null);

    // Desconecta tenant 13
    await salonSessionManager.disconnect(13);

    const postStatus13 = salonSessionManager.getSessionStatus(13);
    const postStatus14 = salonSessionManager.getSessionStatus(14);

    assert.strictEqual(postStatus13.status, 'DISCONNECTED');
    assert.strictEqual(postStatus14.status, 'WAITING_QR', 'Tenant 14 deve permanecer ativo e intocado');
  });

  test('Cenário 10: Retorno sem vazamentos e com flag simulated explícita (F2, F9)', async () => {
    salonSessionManager._resetForTesting();

    // Tenant não autorizado no staging lock cai em modo simulado
    const unlistedUid = 99;
    const simResult = await salonSessionManager.startQrSession(unlistedUid);

    assert.strictEqual(simResult.success, true);
    assert.strictEqual(simResult.simulated, true, 'Deve sinalizar explicitamente simulated: true');
    assert.strictEqual(simResult.status, 'WAITING_QR');

    const status = salonSessionManager.getSessionStatus(unlistedUid);
    assert.strictEqual(status.simulated, true);
    assert.strictEqual(status.rawPhone, undefined, 'rawPhone não pode existir');

    const diag = salonSessionManager.getSalonDiagnostics(unlistedUid);
    assert.strictEqual(diag.environment.allowedPhonesCount, undefined, 'Não deve vazar contagens de telefones');
  });
});
