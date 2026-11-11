/**
 * RAIA AGENTES — SUÍTE HERMÉTICA DE TESTES AUTOMATIZADOS (COMANDO 036)
 * Validação rigorosa das correções das falhas bloqueantes B1, B2 e arquiteturais A1, A2, A5
 *
 * Cobertura Obrigatória dos 10 Cenários:
 *  1. QR real é entregue pela API aguardando conversão assíncrona do DataURL.
 *  2. Estado CONNECTING não cancela o socket após timeout inicial e retorna estado transitório.
 *  3. Expiração do QR não viola constraints do SQLite (grava DISCONNECTED sem violação de CHECK).
 *  4. Processo permanece ativo após expiração e cancelamento (robustez SQLite e repositório).
 *  5. Erro 500 não apaga credenciais em disco e agenda reconexão controlada.
 *  6. Logout formal (401 / disconnect) não inicia reconexão e encerra com segurança.
 *  7. Cancelamento durante a criação do socket limpa timers e não deixa socket zumbi.
 *  8. Eventos atrasados de sockets antigos são descartados pela guarda socketGen.
 *  9. Whitelist de staging e @lid não mapeado descartados em fail-closed no dispatcher da Jéssica.
 * 10. Frontend real trata corretamente estados transitórios (CONNECTING / polling) no painel.html.
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
const uniqueRunId = `036_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_db_${uniqueRunId}.db`);
const tempSessionsDir = path.join(os.tmpdir(), `raia_test_sessions_${uniqueRunId}`);
fs.mkdirSync(tempSessionsDir, { recursive: true });

process.env.DB_PATH = tempDbPath;
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '13,14,15,16,17,18,19,20';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990011,5511999990002,5511999990003,5511999990004';
process.env.ALLOW_WHATSAPP_SENDING = 'false';

const db = require('../src/database/db');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const SalonWhatsAppRepository = require('../src/database/salonWhatsAppRepository');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const phoneUtils = require('../src/utils/phoneUtils');

/**
 * Cria mock socket com emissor de eventos Baileys compatível e rastreamento de chamadas
 */
function createMockBaileysSocket(userId) {
  const emitter = new EventEmitter();
  let closed = false;
  let loggedOut = false;
  const sentMessages = [];

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
      closed = true;
    },
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: { id: `mock_msg_${Date.now()}` } };
    },
    isClosed: () => closed,
    isLoggedOut: () => loggedOut,
    getSentMessages: () => sentMessages,
  };
}

test.before(() => {
  salonSessionManager._setBaseDirForTesting(tempSessionsDir);

  // Setup de usuários e salões de teste no SQLite temporário
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role)
    VALUES (13, '5511999990011', 'Bella Vista Hair & Spa', 'CLIENT'),
           (14, '5511999990002', 'Studio Elegance', 'CLIENT'),
           (15, '5511999990003', 'Barbearia Imperial', 'CLIENT'),
           (16, '5511999990004', 'Espaço VIP', 'CLIENT'),
           (99, '5511999999999', 'Salão Não Autorizado', 'CLIENT')
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, opening_hours)
    VALUES (13, 'Bella Vista Hair & Spa', '{"days":{"1":{"open":true},"2":{"open":true},"3":{"open":true},"4":{"open":true},"5":{"open":true}}}'),
           (14, 'Studio Elegance', '{"days":{"1":{"open":true}}}'),
           (15, 'Barbearia Imperial', '{"days":{"1":{"open":true}}}'),
           (16, 'Espaço VIP', '{"days":{"1":{"open":true}}}'),
           (99, 'Salão Não Autorizado', '{"days":{"1":{"open":true}}}')
  `).run();

  // Garante tabela client_salon_services para testes conversacionais
  try {
    db.prepare(`
      INSERT OR REPLACE INTO client_salon_services (id, user_id, name, price, duration_min, is_active)
      VALUES (1, 13, 'Corte Feminino', 80.0, 45, 1)
    `).run();
  } catch (_) {}

  // Garante registro inicial de sessão nos tenants de teste
  SalonWhatsAppRepository.ensureSessionExists(13, path.join(tempSessionsDir, 'salon_13'));
  SalonWhatsAppRepository.ensureSessionExists(14, path.join(tempSessionsDir, 'salon_14'));
  SalonWhatsAppRepository.ensureSessionExists(15, path.join(tempSessionsDir, 'salon_15'));
  SalonWhatsAppRepository.ensureSessionExists(16, path.join(tempSessionsDir, 'salon_16'));
});

test.after(() => {
  salonSessionManager._resetForTesting();
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempSessionsDir)) fs.rmSync(tempSessionsDir, { recursive: true, force: true });
  } catch (_) {}
});

test.describe('COMANDO 036 — SUÍTE HERMÉTICA DE CORREÇÕES BLOQUEANTES (B1, B2, A1, A2, A5)', () => {

  test('Cenário 1 (B1): Entrega de QR Code real aguardando resolução assíncrona', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;
    const mockSock = createMockBaileysSocket(uid);

    salonSessionManager._setBaileysSocketFactoryForTesting(async () => mockSock);
    salonSessionManager._setQrInitTimeoutForTesting(3000);

    // Emite o evento QR após o socket ser inicializado e listeners anexados
    setTimeout(() => {
      mockSock.ev.emit('connection.update', { qr: '2@BaileysRealQrPayloadForDeliveryCheck123,key,data' });
    }, 50);

    const result = await salonSessionManager.startQrSession(uid);
    assert.strictEqual(result.success, true, 'startQrSession deve retornar sucesso');
    assert.ok(result.qrCode, 'qrCode não pode ser nulo quando emitido durante o wait');
    assert.ok(result.qrCode.startsWith('data:image/png;base64,'), 'Deve ser um DataURL base64 válido');
    assert.strictEqual(result.status, 'WAITING_QR');
  });

  test('Cenário 2 (B1): Estado CONNECTING não cancela socket e preserva conexão em andamento', async () => {
    salonSessionManager._resetForTesting();
    const uid = 14;
    const mockSock = createMockBaileysSocket(uid);

    salonSessionManager._setBaileysSocketFactoryForTesting(async () => mockSock);
    salonSessionManager._setQrInitTimeoutForTesting(60);

    // Não emite nenhum QR: força o timeout inicial do startQrSession
    const result = await salonSessionManager.startQrSession(uid);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'CONNECTING');
    assert.strictEqual(result.qrCode, null, 'qrCode deve ser nulo no estado de transição CONNECTING');

    // Crucial B1: O socket NÃO deve ter sido fechado pelo timeout!
    assert.strictEqual(mockSock.isClosed(), false, 'Socket não pode ter sido cancelado pelo timeout');
    const activeSession = salonSessionManager._getActiveSessionForTesting(uid);
    assert.ok(activeSession, 'Sessão deve permanecer ativa no activeSessions');
    assert.strictEqual(activeSession.sock, mockSock, 'Socket deve ser o mesmo objeto no activeSessions');
  });

  test('Cenário 3 (B2): Expiração do QR não viola CHECK constraints do SQLite e grava DISCONNECTED', async () => {
    salonSessionManager._resetForTesting();
    const uid = 15;
    const mockSock = createMockBaileysSocket(uid);

    salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      status: 'WAITING_QR',
    });

    // Simula desconexão com o QR pendente (timeout/fechamento antes do scan)
    mockSock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 408 },
          message: 'QR Timeout / Closed before pairing',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 40));

    // Consulta direta no banco de dados SQLite temporário para validar integridade da tabela
    const row = db.prepare('SELECT session_status, last_error FROM client_salon_whatsapp_sessions WHERE user_id = ?').get(uid);
    assert.ok(row, 'Registro de sessão deve existir no SQLite');
    assert.strictEqual(row.session_status, 'DISCONNECTED', 'Status persistido no banco DEVE ser DISCONNECTED (compatível com CHECK constraint)');
    assert.ok(row.last_error.includes('expirado') || row.last_error.includes('fechada'), 'last_error deve registrar o motivo da desconexão');

    // Valida que o log também foi gravado com event_type válido
    const logs = SalonWhatsAppRepository.getRecentLogs(uid, 5);
    assert.ok(logs.length > 0, 'Logs devem ter sido gravados');
    assert.strictEqual(logs[0].event_type, 'DISCONNECTED', 'Tipo do evento deve respeitar CHECK constraint de client_salon_whatsapp_logs');
    const metadata = JSON.parse(logs[0].metadata_json || '{}');
    assert.ok(
      metadata.reasonCode === 'QR_EXPIRED' || metadata.reasonCode === '[REDACTED_CREDENTIAL]',
      'reasonCode deve constar nos metadados ou ser sanitizado com segurança'
    );
  });

  test('Cenário 4 (B2): Processo e repositório permanecem resilientes após expiração e cancelamento', async () => {
    salonSessionManager._resetForTesting();
    const uid = 16;

    // Teste defensivo: passar status inválido no repositório não deve lançar exceção e deve cair para DISCONNECTED
    SalonWhatsAppRepository.markSessionDisconnected(uid, {
      status: 'STATUS_INVALIDO_INVENTADO',
      error: 'Erro de teste defensivo',
    });

    const row = db.prepare('SELECT session_status FROM client_salon_whatsapp_sessions WHERE user_id = ?').get(uid);
    assert.strictEqual(row.session_status, 'DISCONNECTED');

    // Chamar cancelPendingPairing repetidas vezes deve ser idempotente e seguro
    const cancel1 = await salonSessionManager.cancelPendingPairing(uid);
    assert.strictEqual(cancel1.success, true);
    const cancel2 = await salonSessionManager.cancelPendingPairing(uid);
    assert.strictEqual(cancel2.success, true);
  });

  test('Cenário 5 (A1): Erro 500 (badSession/falha transitória) preserva credenciais no disco', async () => {
    salonSessionManager._resetForTesting();
    const uid = 13;
    const sessionDir = salonSessionManager.getSalonSessionDir(uid);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const credsPath = path.join(sessionDir, 'creds.json');
    fs.writeFileSync(credsPath, JSON.stringify({ me: { id: '5511999990011:1@s.whatsapp.net' } }));

    const mockSock = createMockBaileysSocket(uid);
    salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      status: 'CONNECTED',
    });

    // Simula desconexão com erro 500 (badSession)
    mockSock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 500 },
          message: 'Internal Server Error / badSession',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 40));

    // Assegura que o arquivo creds.json NÃO foi excluído
    assert.strictEqual(fs.existsSync(credsPath), true, 'creds.json DEVE ser preservado em erro 500');
    assert.strictEqual(mockSock.isLoggedOut(), false, 'Não deve emitir logout em erro 500');

    const active = salonSessionManager._getActiveSessionForTesting(uid);
    assert.ok(active, 'Sessão deve estar viva aguardando reconnect');
    assert.strictEqual(active.reconnecting, true, 'Deve marcar flag reconnecting');
    assert.strictEqual(active.retryCount, 1, 'Deve incrementar contador de tentativas');
  });

  test('Cenário 6 (A1): Logout formal (401 / loggedOut) não inicia reconexão e encerra com segurança', async () => {
    salonSessionManager._resetForTesting();
    const uid = 14;
    const mockSock = createMockBaileysSocket(uid);
    salonSessionManager._setSocketForTesting(uid, mockSock, {
      attachListeners: true,
      status: 'CONNECTED',
    });

    // Simula logout legítimo (401)
    mockSock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 401 },
          message: 'Device Logged Out',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 40));

    const status = salonSessionManager.getSessionStatus(uid);
    assert.strictEqual(status.status, 'DISCONNECTED');

    // Ao ser deslogado formalmente com 401, a sessão ativa é expurgada e nenhuma reconexão ocorre
    const active = salonSessionManager._getActiveSessionForTesting(uid);
    assert.strictEqual(active, undefined, 'Sessão ativa deve ser desregistrada em logout formal');
  });

  test('Cenário 7 (A2): Cancelamento durante a criação do socket limpa timers e não deixa socket zumbi', async () => {
    salonSessionManager._resetForTesting();
    const uid = 15;
    const mockSock = createMockBaileysSocket(uid);

    const session = salonSessionManager._setSocketForTesting(uid, mockSock, {
      status: 'CONNECTING',
    });

    // Agenda um timer de reconexão falso para simular estado intermediário
    session.reconnectTimer = setTimeout(() => {}, 60000);

    // Executa cancelamento
    await salonSessionManager.cancelPendingPairing(uid);

    assert.strictEqual(mockSock.isClosed(), true, 'Socket Baileys deve ter sido fechado via sock.end()');
    assert.strictEqual(session.reconnectTimer, null, 'reconnectTimer deve ter sido cancelado');
    assert.strictEqual(session.socketGen, null, 'socketGen deve ter sido invalidado');
    assert.strictEqual(salonSessionManager._getActiveSessionForTesting(uid), undefined, 'activeSessions deve estar limpo');
  });

  test('Cenário 8 (A2): Eventos atrasados de sockets antigos são descartados pela guarda socketGen', async () => {
    salonSessionManager._resetForTesting();
    const uid = 16;

    // Geração 1
    const sockGen1 = createMockBaileysSocket(uid);
    const session1 = salonSessionManager._setSocketForTesting(uid, sockGen1, {
      attachListeners: true,
      status: 'CONNECTING',
      socketGen: 1,
    });
    assert.strictEqual(session1.socketGen, 1);

    // Geração 2 (iniciada para o mesmo tenant com socketGen 2)
    const sockGen2 = createMockBaileysSocket(uid);
    sockGen2.user = { id: '5511999990004:1@s.whatsapp.net' };
    const session2 = salonSessionManager._setSocketForTesting(uid, sockGen2, {
      attachListeners: true,
      status: 'CONNECTED',
      connectedPhone: '5511999990004',
      socketGen: 2,
    });
    assert.strictEqual(session2.socketGen, 2);

    // Socket antigo (Geração 1) dispara evento tardio de encerramento fatal (401)
    sockGen1.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: { output: { statusCode: 401 } },
      },
    });

    await new Promise((r) => setTimeout(r, 40));

    // A sessão ativa de Geração 2 NÃO deve ter sido afetada pelo socket obsoleto!
    const currentStatus = salonSessionManager.getSessionStatus(uid);
    assert.strictEqual(currentStatus.status, 'CONNECTED', 'Sessão nova deve continuar CONNECTED');
    assert.strictEqual(currentStatus.connectedPhone, phoneUtils.maskPhoneNumber('5511999990004'));
  });

  test('Cenário 9 (A5): Whitelist de staging e @lid não mapeado descartados em fail-closed pelo dispatcher', async () => {
    const uid = 13;
    const mockSock = createMockBaileysSocket(uid);

    // 1. Mensagem de número NÃO AUTORIZADO em staging
    const unauthorizedMsg = {
      key: {
        remoteJid: '5511888880000@s.whatsapp.net', // fora da whitelist SALON_TEST_ALLOWED_PHONES
        fromMe: false,
        id: 'msg_unauth_001',
      },
      message: {
        conversation: 'Olá, gostaria de agendar um corte',
      },
    };

    const processedUnauth = await salonIncomingDispatcher.dispatchMessage(uid, mockSock, unauthorizedMsg);
    assert.strictEqual(processedUnauth, false, 'Dispatcher deve retornar false para número não autorizado em staging');
    assert.strictEqual(mockSock.getSentMessages().length, 0, 'NENHUMA mensagem pode ser enviada a destinatário não autorizado');

    // 2. Mensagem vinda de @lid NÃO MAPEADO
    const unmappedLidMsg = {
      key: {
        remoteJid: '999888777666@lid', // LID fictício que não mapeia para nenhum telefone
        fromMe: false,
        id: 'msg_lid_002',
      },
      message: {
        conversation: 'Quero agendar horário',
      },
    };

    const processedLid = await salonIncomingDispatcher.dispatchMessage(uid, mockSock, unmappedLidMsg);
    assert.strictEqual(processedLid, false, 'Dispatcher deve retornar false para @lid não mapeado');
    assert.strictEqual(mockSock.getSentMessages().length, 0, 'NENHUMA mensagem pode ser enviada para @lid não mapeado');

    // 3. Mensagem vinda de número AUTORIZADO na whitelist (5511999990011)
    const authorizedMsg = {
      key: {
        remoteJid: '5511999990011@s.whatsapp.net',
        fromMe: false,
        id: 'msg_auth_003',
      },
      message: {
        conversation: '1',
      },
    };

    const processedAuth = await salonIncomingDispatcher.dispatchMessage(uid, mockSock, authorizedMsg);
    assert.strictEqual(processedAuth, true, 'Mensagem de remetente autorizado deve ser processada');
  });

  test('Cenário 10 (Frontend): Tratamento defensivo de CONNECTING e polling verificado no painel.html', () => {
    const painelPath = path.resolve(__dirname, '../public/cliente/painel.html');
    const htmlContent = fs.readFileSync(painelPath, 'utf8');

    // 1. Verifica suporte a CONNECTING e ausência de erro prematuro quando qrCode é null
    assert.ok(
      htmlContent.includes("data.status === 'CONNECTING'"),
      'painel.html deve tratar explicitamente o status CONNECTING'
    );
    assert.ok(
      htmlContent.includes("data.status === 'WAITING_QR'"),
      'painel.html deve tratar explicitamente o status WAITING_QR'
    );

    // 2. Verifica exibição de mensagem informativa de transição no spinner
    assert.ok(
      htmlContent.includes("'Gerando QR Code...'"),
      'painel.html deve atualizar o texto para "Gerando QR Code..." durante transição'
    );

    // 3. Verifica que o polling atualiza o QR assim que disponível
    assert.ok(
      htmlContent.includes('scheduleSalonWaPoll'),
      'painel.html deve agendar o polling contínuo de status'
    );
    assert.ok(
      htmlContent.includes('statusData.qrCode'),
      'painel.html deve renderizar a imagem do QR Code quando disponibilizada no polling'
    );
  });
});
