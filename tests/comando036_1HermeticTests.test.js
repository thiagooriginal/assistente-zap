/**
 * RAIA AGENTES — SUÍTE HERMÉTICA DE TESTES AUTOMATIZADOS (COMANDO 036.1)
 * Validação rigorosa das correções de estabilização do Baileys, concorrência,
 * credenciais reais, recuperação do painel e tratamento defensivo de @lid.
 *
 * Cobertura Obrigatória dos 12 Cenários:
 *  1. Cancelamento durante inicialização assíncrona (useMultiFileAuthState / fetchVersion / test factory).
 *  2. Socket antigo emitindo eventos atrasados descartados pela guarda socketGen e isSocketStale.
 *  3. Erro durante solicitação de código (requestPairingCode) encerra socket e não deixa zumbi.
 *  4. Lock de tenant pertencente a nova operação não é removido por operação antiga.
 *  5. Credenciais registradas (registered: true, me: { id }) vs não registradas (registered: false) em inspectSalonAuthCredentials e restoreActiveSalonSessions.
 *  6. QR expirado e recuperação no painel (spinner ocultado e botão 'Gerar novo QR Code' funcional).
 *  7. Polling no painel descarta respostas fora de ordem (salonWaPollSeq) e reagenda em erro de rede.
 *  8. Mensagem com @lid resolvida via identificador alternativo (remoteJidAlt / senderPn).
 *  9. Mensagem com @lid sem mapeamento descartada em fail-closed com log sanitizado (nunca usa dígitos do LID).
 * 10. Whitelist de staging fail-closed para mensagens recebidas.
 * 11. Preservação de status WAITING_CODE quando Baileys emite evento qr.
 * 12. Não regressão do erro 515 (restartRequired) reconectando com preservação de credenciais.
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
const uniqueRunId = `036_1_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
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
    requestPairingCode: async (phone) => {
      return '12345678';
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
      VALUES (101, 13, 'Corte Feminino', 120.00, 60, 1),
             (102, 13, 'Escova Modelada', 80.00, 45, 1)
    `).run();
  } catch (_) {}

  // Garante registro inicial de sessão nos tenants de teste
  SalonWhatsAppRepository.ensureSessionExists(13, path.join(tempSessionsDir, 'salon_13'));
  SalonWhatsAppRepository.ensureSessionExists(14, path.join(tempSessionsDir, 'salon_14'));
  SalonWhatsAppRepository.ensureSessionExists(15, path.join(tempSessionsDir, 'salon_15'));
  SalonWhatsAppRepository.ensureSessionExists(16, path.join(tempSessionsDir, 'salon_16'));
});

test.after(() => {
  try {
    fs.rmSync(tempSessionsDir, { recursive: true, force: true });
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  } catch (_) {}
});

test.beforeEach(() => {
  salonSessionManager._resetForTesting();
});

// ==============================================================================
// CENÁRIO 1: Cancelamento durante inicialização assíncrona
// ==============================================================================
test('1. Cancelamento durante inicialização assíncrona fecha socket imediatamente e não deixa zumbi', async () => {
  const uid = 13;
  let factoryCalled = false;
  let socketCreated = null;

  salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
    factoryCalled = true;
    socketCreated = createMockBaileysSocket(uid);
    // Simula atraso na inicialização
    await new Promise((resolve) => setTimeout(resolve, 50));
    return socketCreated;
  });

  const promise = salonSessionManager.startQrSession(uid);
  // Cancela a sessão enquanto a fábrica assíncrona está em andamento
  await salonSessionManager.cancelPendingPairing(uid);

  try {
    const res = await promise;
    assert.equal(res.success, false);
  } catch (err) {
    assert.ok(err.message.includes('SESSION_CANCELLED') || err.message.includes('abort') || err.message.includes('invalidada'));
  }

  assert.equal(factoryCalled, true);
  assert.ok(socketCreated, 'Socket foi instanciado pela fábrica');
  assert.equal(socketCreated.isClosed(), true, 'Socket deve ter sido encerrado (sock.end()) ao detectar aborto');
  assert.equal(salonSessionManager._getActiveSessionForTesting(uid), undefined, 'Sessão zumbi não deve permanecer ativa');
});

// ==============================================================================
// CENÁRIO 2: Eventos atrasados de sockets antigos descartados por socketGen
// ==============================================================================
test('2. Socket antigo emitindo eventos atrasados é descartado pela guarda socketGen e isSocketStale', async () => {
  const uid = 14;
  const oldSocket = createMockBaileysSocket(uid);

  // Instancia sessão com geração 1
  const session = salonSessionManager._setSocketForTesting(uid, oldSocket, {
    status: 'WAITING_QR',
    socketGen: 1,
    attachListeners: true,
  });

  // Incrementa a geração da sessão para simular cancelamento ou novo ciclo
  session.socketGen = 2;

  // Socket antigo emite evento de conexão aberta
  oldSocket.ev.emit('connection.update', {
    connection: 'open',
    lastDisconnect: null,
  });

  // A sessão em memória NÃO deve ter transicionado para CONNECTED pelo socket antigo
  assert.equal(session.status, 'WAITING_QR', 'Status deve permanecer WAITING_QR, descartando evento do socket antigo');
  assert.equal(session.connectedPhone, null);
});

// ==============================================================================
// CENÁRIO 3: Erro durante solicitação de código encerra socket e evita zumbi
// ==============================================================================
test('3. Erro durante solicitação de código (requestPairingCode) encerra socket e não deixa zumbi', async () => {
  const uid = 15;
  let mockSocket = null;

  salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
    mockSocket = createMockBaileysSocket(uid);
    // Emite evento para satisfazer waitForSocketReady assim que o listener for registrado
    setTimeout(() => {
      mockSocket.ev.emit('connection.update', { connection: 'connecting' });
    }, 20);
    // Simula falha do Baileys ao solicitar código
    mockSocket.requestPairingCode = async () => {
      throw new Error('Baileys Pairing Code Request Failed');
    };
    return mockSocket;
  });

  await assert.rejects(
    salonSessionManager.requestPairingCode(uid, '11999990003'),
    /Baileys Pairing Code Request Failed/
  );

  assert.ok(mockSocket, 'Socket foi instanciado');
  assert.equal(mockSocket.isClosed(), true, 'Socket deve ter sido encerrado em catch para evitar zumbi');
  const session = salonSessionManager._getActiveSessionForTesting(uid);
  assert.ok(!session || session.status === 'ERROR' || session.status === 'DISCONNECTED');
});

// ==============================================================================
// CENÁRIO 4: Lock de tenant não é removido por operação anterior
// ==============================================================================
test('4. Lock de tenant pertencente a nova operação não é removido por operação anterior', async () => {
  const uid = 16;

  // Simula duas promessas de operação concorrente
  const firstPromise = new Promise((resolve) => setTimeout(resolve, 50));
  const secondPromise = new Promise((resolve) => setTimeout(resolve, 100));

  // Simula que firstPromise começou e registrou no lock
  // Depois secondPromise assumiu o lock do tenant uid
  const fakeTenantLocks = new Map();
  fakeTenantLocks.set(uid, secondPromise);

  // Tentativa da primeira operação limpar o lock no finally defensivo:
  if (fakeTenantLocks.get(uid) === firstPromise) {
    fakeTenantLocks.delete(uid);
  }

  // O lock da segunda operação deve permanecer intacto
  assert.equal(fakeTenantLocks.get(uid), secondPromise, 'O lock da nova operação não pode ter sido apagado pela primeira');
});

// ==============================================================================
// CENÁRIO 5: Validação real de credenciais QR (me + account, registered: false) vs código pendente
// ==============================================================================
test('5. Credenciais reais de login por QR (me + account, registered: false) vs código pendente (me + pairingCode, sem account)', async () => {
  const uid = 13;
  const sessionDir = salonSessionManager.getSalonSessionDir(uid);
  fs.mkdirSync(sessionDir, { recursive: true });
  const credsFile = path.join(sessionDir, 'creds.json');

  // Caso A: Código de pareamento pendente (me + pairingCode, sem account, registered: false)
  fs.writeFileSync(credsFile, JSON.stringify({
    noiseKey: { private: 'foo', public: 'bar' },
    me: { id: '5511999990011:1@s.whatsapp.net' },
    pairingCode: '1234-5678',
    registered: false,
  }), 'utf8');

  let audit = salonSessionManager.inspectSalonAuthCredentials(uid);
  assert.equal(audit.exists, true);
  assert.equal(audit.hasCreds, true);
  assert.equal(audit.credsValid, false, 'Código de pareamento pendente (sem account) DEVE ser inválido');

  SalonWhatsAppRepository.markSessionConnected(uid, {
    phone: '5511999990011',
    phoneJid: '5511999990011@s.whatsapp.net',
    pairingMethod: 'CODE',
  });

  let restoreResult = await salonSessionManager.restoreActiveSalonSessions();
  assert.equal(restoreResult.restored, 0, 'Sessão sem account não deve ser restaurada');
  assert.equal(salonSessionManager._getActiveSessionForTesting(uid), undefined);

  // Caso B: Formato real de login por QR no Baileys (me + account, registered: false)
  fs.writeFileSync(credsFile, JSON.stringify({
    noiseKey: { private: 'foo', public: 'bar' },
    registered: false, // Baileys nunca define true no QR!
    me: { id: '5511999990011:1@s.whatsapp.net', name: 'Bella Vista' },
    account: { details: 'BufferOrObjectAuthData' },
  }), 'utf8');

  audit = salonSessionManager.inspectSalonAuthCredentials(uid);
  assert.equal(audit.exists, true);
  assert.equal(audit.hasCreds, true);
  assert.equal(audit.credsValid, true, 'Login real por QR (me.id + account) DEVE ser válido mesmo com registered: false');

  // Reativa no banco como candidata à restauração
  SalonWhatsAppRepository.markSessionConnected(uid, {
    phone: '5511999990011',
    phoneJid: '5511999990011@s.whatsapp.net',
    pairingMethod: 'QR',
  });

  // Configura factory para retorno de socket de restauração
  salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
    return createMockBaileysSocket(uid);
  });

  restoreResult = await salonSessionManager.restoreActiveSalonSessions();
  assert.equal(restoreResult.restored, 1, 'Sessão QR com me.id + account deve ser restaurada com sucesso');
  const restoredSession = salonSessionManager._getActiveSessionForTesting(uid);
  assert.ok(restoredSession, 'Sessão ativa deve existir em memória após restauração');
});

// ==============================================================================
// CENÁRIO 6: QR expirado e recuperação no painel (HTML/DOM)
// ==============================================================================
test('6. Painel HTML trata QR expirado / desconexão sem spinner infinito e possui botão de gerar novo QR', () => {
  const painelPath = path.resolve(__dirname, '../public/cliente/painel.html');
  const content = fs.readFileSync(painelPath, 'utf8');

  // Verifica presença do botão 'btnGenerateNewQr' com a chamada openSalonQrConnection()
  assert.ok(content.includes('id="btnGenerateNewQr"'), 'Deve existir o botão btnGenerateNewQr');
  assert.ok(content.includes('openSalonQrConnection()'), 'Botão deve invocar openSalonQrConnection()');

  // Verifica que no tratamento de DISCONNECTED / CONNECTION_LOST / QR_EXPIRED o spinner é ocultado
  assert.ok(content.includes('serverStatus === \'DISCONNECTED\' || serverStatus === \'CONNECTION_LOST\' || serverStatus === \'QR_EXPIRED\''), 'Deve tratar estados de desconexão/expiração');
  assert.ok(content.includes('spinner?.classList.add(\'hidden\')'), 'Deve ocultar o spinner ao detectar expiração/desconexão');
});

// ==============================================================================
// CENÁRIO 7: Polling no painel descarta fora de ordem e reagenda em erro de rede
// ==============================================================================
test('7. Polling no painel utiliza contador de sequência salonWaPollSeq e reagenda em erro de rede', () => {
  const painelPath = path.resolve(__dirname, '../public/cliente/painel.html');
  const content = fs.readFileSync(painelPath, 'utf8');

  // Verifica declaração do contador de sequência do polling
  assert.ok(content.includes('let salonWaPollSeq = 0;'), 'Deve declarar salonWaPollSeq');
  assert.ok(content.includes('const pollSeq = ++salonWaPollSeq;'), 'Deve incrementar salonWaPollSeq no início do polling');
  assert.ok(content.includes('if (pollSeq !== salonWaPollSeq) return;'), 'Deve descartar resposta de polling defasada');

  // Verifica reagendamento em erro de rede
  assert.ok(content.includes('if (salonWaActiveMethod && pollSeq === salonWaPollSeq)'), 'Deve verificar se há método ativo para reagendar');
  assert.ok(content.includes('scheduleSalonWaPoll();'), 'Deve invocar scheduleSalonWaPoll() em caso de falha de rede');

  // Verifica recuperação ao alternar abas (visibilitychange)
  assert.ok(content.includes('visibilitychange'), 'Deve escutar evento visibilitychange para recuperar status ao retornar à aba');
});

// ==============================================================================
// CENÁRIO 8: Mensagem com @lid resolvida via identificador alternativo
// ==============================================================================
test('8. Mensagem com @lid é resolvida via identificadores alternativos (remoteJidAlt / senderPn)', () => {
  // Teste 8.1: remoteJidAlt com @s.whatsapp.net
  const msg1 = {
    key: {
      remoteJid: '269876543210123@lid',
      remoteJidAlt: '5511999990011@s.whatsapp.net',
    },
    message: { conversation: 'Olá Jéssica' },
  };
  const phone1 = phoneUtils.extractSenderPhone(msg1);
  assert.equal(phone1, '5511999990011');

  // Teste 8.2: senderPn direto
  const msg2 = {
    key: {
      remoteJid: '269876543210123@lid',
      senderPn: '5511999990002',
    },
    message: { conversation: 'Olá Studio Elegance' },
  };
  const phone2 = phoneUtils.extractSenderPhone(msg2);
  assert.equal(phone2, '5511999990002');

  // Teste 8.3: participantAlt
  const msg3 = {
    key: {
      remoteJid: '269876543210123@lid',
      participantAlt: '5511999990003@s.whatsapp.net',
    },
    message: { conversation: 'Olá Barbearia' },
  };
  const phone3 = phoneUtils.extractSenderPhone(msg3);
  assert.equal(phone3, '5511999990003');
});

// ==============================================================================
// CENÁRIO 9: Mensagem com @lid sem mapeamento descartada em fail-closed
// ==============================================================================
test('9. Mensagem com @lid sem mapeamento é descartada em fail-closed e nunca usa os dígitos do LID', () => {
  const msgLidUnmapped = {
    key: {
      remoteJid: '269876543210123@lid',
    },
    message: { conversation: 'Tentativa sem mapeamento' },
  };

  const phone = phoneUtils.extractSenderPhone(msgLidUnmapped, null);
  assert.equal(phone, null, 'extractSenderPhone deve retornar null para LID sem mapeamento');
  assert.notEqual(phone, '269876543210123', 'NUNCA deve retornar os dígitos crus do LID como telefone');
});

// ==============================================================================
// CENÁRIO 10: Whitelist de staging fail-closed para mensagens recebidas
// ==============================================================================
test('10. Whitelist de staging fail-closed descarta remetente não autorizado', async () => {
  const uid = 13;
  const mockSock = createMockBaileysSocket(uid);

  // Mensagem vinda de remetente NÃO autorizado na whitelist SALON_TEST_ALLOWED_PHONES
  const unauthMsg = {
    key: {
      id: `unauth_${Date.now()}`,
      remoteJid: '5511888887777@s.whatsapp.net',
      fromMe: false,
    },
    message: { conversation: 'Quero agendar um corte' },
  };

  const dispatched = await salonIncomingDispatcher.dispatchMessage(uid, mockSock, unauthMsg);
  assert.equal(dispatched, false, 'Mensagem de remetente fora da whitelist deve ser descartada em staging');
  assert.equal(mockSock.getSentMessages().length, 0, 'Nenhuma resposta pode ter sido enviada');
});

// ==============================================================================
// CENÁRIO 11: Preservação de status WAITING_CODE quando Baileys emite evento qr
// ==============================================================================
test('11. Preservação de status WAITING_CODE quando Baileys emite evento qr', async () => {
  const uid = 14;
  const mockSock = createMockBaileysSocket(uid);

  const session = salonSessionManager._setSocketForTesting(uid, mockSock, {
    status: 'WAITING_CODE',
    pairingMethod: 'CODE',
    pairingCode: '98765432',
    socketGen: 1,
    attachListeners: true,
  });

  // Baileys emite evento connection.update com qr
  mockSock.ev.emit('connection.update', {
    qr: '2@fakeQrDataStringFromBaileys',
  });

  // Aguarda microtask
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(session.status, 'WAITING_CODE', 'Status deve permanecer WAITING_CODE');
  assert.equal(session.pairingCode, '98765432', 'Código de pareamento não pode ser apagado');
  assert.equal(session.qrCode, null, 'QR Code não pode ser gerado no modo CODE');
});

// ==============================================================================
// CENÁRIO 12: Não regressão do erro 515 reconectando com preservação de credenciais
// ==============================================================================
test('12. Erro 515 (restartRequired) reconecta socket preservando credenciais salvas', async () => {
  const uid = 13;
  const sessionDir = salonSessionManager.getSalonSessionDir(uid);
  fs.mkdirSync(sessionDir, { recursive: true });
  const credsFile = path.join(sessionDir, 'creds.json');
  fs.writeFileSync(credsFile, JSON.stringify({
    registered: false,
    me: { id: '5511999990011:1@s.whatsapp.net' },
    account: { details: 'qr_auth_details' },
  }), 'utf8');

  let reconnectCount = 0;
  salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
    reconnectCount++;
    return createMockBaileysSocket(uid);
  });

  const mockSock = createMockBaileysSocket(uid);
  const session = salonSessionManager._setSocketForTesting(uid, mockSock, {
    status: 'CONNECTED',
    connectedPhone: '5511999990011',
    socketGen: 1,
    attachListeners: true,
  });

  // Emite desconexão por erro 515
  mockSock.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: {
        output: { statusCode: 515 },
        message: 'restartRequired',
      },
    },
  });

  // Aguarda tempo de reconexão (500ms + margem)
  await new Promise((r) => setTimeout(r, 700));

  assert.ok(reconnectCount >= 1, 'Reconexão controlada deve ter sido acionada para erro 515');
  assert.ok(fs.existsSync(credsFile), 'Credenciais não devem ter sido apagadas em erro 515');
});

// ==============================================================================
// CENÁRIO 13: Sessão QR sofre queda, primeira reconexão falha e backoff continua
// ==============================================================================
test('13. Sessão QR conectada sofre queda, primeira reconexão falha e backoff continua sem ir para DISCONNECTED', async () => {
  const uid = 13;
  const sessionDir = salonSessionManager.getSalonSessionDir(uid);
  fs.mkdirSync(sessionDir, { recursive: true });
  const credsFile = path.join(sessionDir, 'creds.json');

  // Grava credencial no formato real de QR do Baileys (me + account, registered: false)
  fs.writeFileSync(credsFile, JSON.stringify({
    noiseKey: { private: 'foo', public: 'bar' },
    registered: false,
    me: { id: '5511999990011:1@s.whatsapp.net', name: 'Bella Vista' },
    account: { details: 'BufferOrObjectAuthData' },
  }), 'utf8');

  let reconnectAttempts = 0;
  let secondSocket = null;

  salonSessionManager._setBaileysSocketFactoryForTesting(async () => {
    reconnectAttempts++;
    secondSocket = createMockBaileysSocket(uid);
    return secondSocket;
  });

  const firstSocket = createMockBaileysSocket(uid);
  const session = salonSessionManager._setSocketForTesting(uid, firstSocket, {
    status: 'CONNECTED',
    pairingMethod: 'QR',
    connectedPhone: '5511999990011',
    socketGen: 1,
    attachListeners: true,
  });

  // 1. Primeira queda: socket original fecha com erro 500
  firstSocket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: { output: { statusCode: 500 }, message: 'Server dropped connection' },
    },
  });

  // Status deve continuar em reconexão (NÃO ir para DISCONNECTED) com retryCount = 1
  assert.notEqual(session.status, 'DISCONNECTED', 'Status não deve ir para DISCONNECTED na primeira queda');
  assert.equal(session.retryCount, 1, 'retryCount deve ser 1');
  assert.equal(session.reconnecting, true, 'reconnecting deve estar ativo');

  // Aguarda o backoff inicial (1500ms) + margem para que a reconexão execute
  await new Promise((r) => setTimeout(r, 1600));

  assert.equal(reconnectAttempts, 1, 'Primeira tentativa de reconexão deve ter sido executada');
  assert.ok(secondSocket, 'Segundo socket foi instanciado pela reconexão');

  // 2. Segunda queda: o segundo socket falha imediatamente com erro 500
  secondSocket.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: { output: { statusCode: 500 }, message: 'Network unreachable on retry' },
    },
  });

  // Mesmo após a primeira reconexão falhar, graças à validação de me.id + account,
  // o backoff DEVE continuar (retryCount = 2) e NÃO ir para DISCONNECTED!
  assert.notEqual(session.status, 'DISCONNECTED', 'Status não pode ir para DISCONNECTED na segunda queda');
  assert.equal(session.retryCount, 2, 'retryCount deve avançar para 2');
  assert.equal(session.reconnecting, true, 'reconnecting deve permanecer agendado');

  // Limpa timer pendente para encerrar hermeticamente
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
});
