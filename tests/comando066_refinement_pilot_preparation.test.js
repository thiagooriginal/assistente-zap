/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS DO COMANDO 066
 * Validação dos Requisitos das ETAPAS 2, 3, 4, 5, 6 e 7:
 * - Cenário 1: Notificações da Gestão (salonNotificationService)
 * - Cenário 2: Captura Inteligente do Nome (salonIncomingDispatcher)
 * - Cenário 3: Alerta de Falha no Google Calendar (outboxWorker)
 * - Cenário 4: Isolamento Multi-Tenant e Ausência de IDOR
 * - Cenário 5: Prevenção contra Mensagens Duplicadas (processed_messages)
 *
 * Padrão Hermético: Banco SQLite isolado em os.tmpdir(), Mocks fail-closed, node:test e node:assert/strict.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 1. Configuração do ambiente 100% isolado em os.tmpdir() antes de carregar os módulos da aplicação
const testDbPath = path.join(os.tmpdir(), `test_c066_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'test_encryption_key_at_least_32_bytes_long_12345';
process.env.SESSION_SECRET = 'test_session_secret_for_c066_32bytes_long_12345';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_for_c066_32bytes_long_12345';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '1,2';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990001,5511999990002,5511999998888,5511999997777';

const db = require('../src/database/db');
const salonNotificationService = require('../src/services/salonNotificationService');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const outboxWorker = require('../src/services/outboxWorker');
const googleCalendarService = require('../src/services/googleCalendarService');

// Hook de limpeza hermética pós-execução
test.after(() => {
  try {
    salonIncomingDispatcher._resetForTesting();
  } catch (_) {}
  try {
    googleCalendarService.resetMockHandler();
  } catch (_) {}
  try {
    db.close();
  } catch (_) {}
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch (_) {}
});

// Inicialização da massa de dados multi-tenant
test.before(() => {
  db.prepare('DELETE FROM client_service_staff').run();
  db.prepare('DELETE FROM client_staff').run();
  db.prepare('DELETE FROM client_services').run();
  db.prepare('DELETE FROM client_salons').run();
  db.prepare('DELETE FROM customer_subscriptions').run();
  db.prepare('DELETE FROM users WHERE id IN (1, 2)').run();

  // Criação dos Usuários / Assinaturas
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, subscription_status, paid_until)
    VALUES 
      (1, '5511999990001', 'Dona Jéssica (Tenant 1)', 'USER', 'PRO', 'ACTIVE', datetime('now', '+30 days')),
      (2, '5511999990002', 'Salão Secundário (Tenant 2)', 'USER', 'PRO', 'ACTIVE', datetime('now', '+30 days'))
  `).run();

  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const prodId = jessicaProd ? jessicaProd.id : 1;

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, status, price_cents, paid_until)
    VALUES 
      (1, ?, 'ACTIVE', 8900, datetime('now', '+30 days')),
      (2, ?, 'ACTIVE', 8900, datetime('now', '+30 days'))
  `).run(prodId, prodId);

  // Configuração dos Salões
  db.prepare(`
    INSERT INTO client_salons (
      user_id, salon_name, phone, whatsapp_notification_phone,
      whatsapp_notifications_enabled, notify_new_appointment, notify_cancellation,
      notify_reschedule, notify_sync_failure, b2c_reminders_enabled
    ) VALUES 
      (1, 'Espaço Jéssica Beleza', '5511999990001', '5511999990001', 1, 1, 1, 1, 1, 0),
      (2, 'Studio Glamour', '5511999990002', '5511999990002', 1, 1, 1, 1, 1, 0)
  `).run();

  // Serviços
  db.prepare(`
    INSERT INTO client_services (id, user_id, name, price, duration_min, category, active)
    VALUES 
      (1, 1, 'Corte e Escova', 85.50, 45, 'Cabelo', 1),
      (2, 2, 'Manicure Especial', 40.00, 30, 'Unhas', 1)
  `).run();

  // Profissionais
  db.prepare(`
    INSERT INTO client_staff (id, user_id, name, specialty, active)
    VALUES 
      (1, 1, 'Jéssica Designer', 'Cabeleireira', 1),
      (2, 2, 'Camila Manicure', 'Manicure', 1)
  `).run();

  // Vinculação Serviço-Profissional
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES 
      (1, 1, 1, 1),
      (2, 2, 2, 1)
  `).run();
});

// =============================================================================
// CENÁRIO 1: NOTIFICAÇÕES DA GESTÃO (salonNotificationService)
// =============================================================================

test('Cenário 1.1: buildNewAppointmentMessage deve conter cabeçalho oficial, #ID, valor formatado e self-chat note', () => {
  const msgWithSelf = salonNotificationService.buildNewAppointmentMessage({
    appointmentId: 101,
    clientName: 'Mariana Silva',
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-25T14:00:00-03:00',
    endDt: '2026-11-25T14:45:00-03:00',
    price: 85.50,
    isSelfChat: true,
  });

  assert.ok(msgWithSelf.includes('📢 AVISO DE GESTÃO — JÉSSICA'), 'Deve conter cabeçalho oficial de aviso');
  assert.ok(msgWithSelf.includes('#101'), 'Deve conter o identificador do agendamento (#ID)');
  assert.ok(msgWithSelf.includes('Mariana Silva'), 'Deve conter o nome da cliente');
  assert.ok(msgWithSelf.includes('Valor: R$ 85,50'), 'Deve conter o valor monetário formatado');
  assert.ok(msgWithSelf.includes('*(Mensagem enviada a você por ser o WhatsApp de gestão cadastrado deste salão)*'), 'Deve conter nota de auto-envio operacional quando isSelfChat for true');

  const msgWithoutSelf = salonNotificationService.buildNewAppointmentMessage({
    appointmentId: 101,
    clientName: 'Mariana Silva',
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-25T14:00:00-03:00',
    endDt: '2026-11-25T14:45:00-03:00',
    price: 85.50,
    isSelfChat: false,
  });
  assert.ok(!msgWithoutSelf.includes('*(Mensagem enviada a você por ser o WhatsApp de gestão cadastrado deste salão)*'), 'Não deve conter nota de auto-envio quando isSelfChat for false');
});

test('Cenário 1.2: buildCancellationMessage, buildRescheduleMessage, buildRescheduleRequestMessage e buildSyncFailureMessage devem conter cabeçalho e #ID', () => {
  // Cancelamento
  const cancelMsg = salonNotificationService.buildCancellationMessage({
    appointmentId: 102,
    clientName: 'Mariana Silva',
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-25T14:00:00-03:00',
    isSelfChat: true,
  });
  assert.ok(cancelMsg.includes('📢 AVISO DE GESTÃO — JÉSSICA'));
  assert.ok(cancelMsg.includes('#102'));
  assert.ok(cancelMsg.includes('*(Mensagem enviada a você por ser o WhatsApp de gestão cadastrado deste salão)*'));

  // Remarcação
  const reschedMsg = salonNotificationService.buildRescheduleMessage({
    appointmentId: 103,
    clientName: 'Mariana Silva',
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    newStartDt: '2026-11-26T15:00:00-03:00',
    oldStartDt: '2026-11-25T14:00:00-03:00',
    isSelfChat: true,
  });
  assert.ok(reschedMsg.includes('📢 AVISO DE GESTÃO — JÉSSICA'));
  assert.ok(reschedMsg.includes('#103'));
  assert.ok(reschedMsg.includes('*(Mensagem enviada a você por ser o WhatsApp de gestão cadastrado deste salão)*'));

  // Solicitação de remarcação (handoff)
  const reqMsg = salonNotificationService.buildRescheduleRequestMessage({
    appointmentId: 104,
    clientName: 'Mariana Silva',
    clientPhone: '5511999998888',
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-25T14:00:00-03:00',
    isSelfChat: false,
  });
  assert.ok(reqMsg.includes('📢 AVISO DE GESTÃO — JÉSSICA'));
  assert.ok(reqMsg.includes('#104'));
  assert.ok(!reqMsg.includes('*(Mensagem enviada a você por ser o WhatsApp de gestão cadastrado deste salão)*'));

  // Falha de Sincronização Google
  const syncFailMsg = salonNotificationService.buildSyncFailureMessage({
    appointmentId: 105,
    clientName: 'Mariana Silva',
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-25T14:00:00-03:00',
    error: 'Token revogado pelo usuário',
    isSelfChat: true,
  });
  assert.ok(syncFailMsg.includes('📢 AVISO DE GESTÃO — JÉSSICA'));
  assert.ok(syncFailMsg.includes('#105'));
  assert.ok(syncFailMsg.includes('*(Mensagem enviada a você por ser o WhatsApp de gestão cadastrado deste salão)*'));
});

test('Cenário 1.3: enqueueNotificationTx detecta auto-envio (clientPhone === notificationPhone) e injeta isSelfChat', () => {
  // Teste com cliente enviando com o próprio telefone cadastrado para notificações
  const resSelf = salonNotificationService.enqueueNotificationTx(1, 201, 'NEW_APPOINTMENT', {
    appointmentId: 201,
    clientName: 'Dona Jéssica Teste',
    clientPhone: '5511999990001', // Mesmo telefone da gestão
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-25T14:00:00-03:00',
    endDt: '2026-11-25T14:45:00-03:00',
    price: 85.50,
  });

  assert.strictEqual(resSelf.success, true);
  const rowSelf = db.prepare('SELECT message_text FROM whatsapp_notification_outbox WHERE id = ?').get(resSelf.outboxId);
  assert.ok(rowSelf.message_text.includes('*(Mensagem enviada a você por ser o WhatsApp de gestão cadastrado deste salão)*'));

  // Teste com cliente de telefone externo
  const resExternal = salonNotificationService.enqueueNotificationTx(1, 202, 'NEW_APPOINTMENT', {
    appointmentId: 202,
    clientName: 'Cliente Externa',
    clientPhone: '5511999998888', // Telefone externo
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-26T14:00:00-03:00',
    endDt: '2026-11-26T14:45:00-03:00',
    price: 85.50,
  });

  assert.strictEqual(resExternal.success, true);
  const rowExternal = db.prepare('SELECT message_text FROM whatsapp_notification_outbox WHERE id = ?').get(resExternal.outboxId);
  assert.ok(!rowExternal.message_text.includes('*(Mensagem enviada a você por ser o WhatsApp de gestão cadastrado deste salão)*'));
});

// =============================================================================
// CENÁRIO 2: CAPTURA INTELIGENTE DO NOME (salonIncomingDispatcher)
// =============================================================================

test('Cenário 2.1: isValidCustomerName deve validar nomes legítimos e rejeitar emojis puros, pontuações e placeholders genéricos', () => {
  const { isValidCustomerName } = salonIncomingDispatcher;

  // Válidos
  assert.strictEqual(isValidCustomerName('Juliana'), true);
  assert.strictEqual(isValidCustomerName('Mariana Silva'), true);
  assert.strictEqual(isValidCustomerName('Ana'), true);
  assert.strictEqual(isValidCustomerName('🌸 Mary 🌸'), true, 'Nome com emojis periféricos e letras suficientes deve ser aceito');

  // Inválidos
  assert.strictEqual(isValidCustomerName(null), false);
  assert.strictEqual(isValidCustomerName(undefined), false);
  assert.strictEqual(isValidCustomerName(''), false);
  assert.strictEqual(isValidCustomerName('   '), false);
  assert.strictEqual(isValidCustomerName('.'), false);
  assert.strictEqual(isValidCustomerName('...'), false);
  assert.strictEqual(isValidCustomerName('🌸'), false, 'Apenas emojis deve ser rejeitado');
  assert.strictEqual(isValidCustomerName('Cliente WhatsApp'), false, 'Placeholder genérico deve ser rejeitado');
  assert.strictEqual(isValidCustomerName('cliente whatsapp'), false);
  assert.strictEqual(isValidCustomerName('Unknown'), false);
  assert.strictEqual(isValidCustomerName('User'), false);
  assert.strictEqual(isValidCustomerName('usuário'), false);
  assert.strictEqual(isValidCustomerName('Contato'), false);
});

test('Cenário 2.2: extractCleanCustomerName deve remover prefixos e afirmações coloquiais', () => {
  const { extractCleanCustomerName } = salonIncomingDispatcher;

  assert.strictEqual(extractCleanCustomerName('Meu nome é Juliana'), 'Juliana');
  assert.strictEqual(extractCleanCustomerName('me chamo Mariana Silva'), 'Mariana Silva');
  assert.strictEqual(extractCleanCustomerName('Sou a Ana.'), 'Ana');
  assert.strictEqual(extractCleanCustomerName('Sim, meu nome é Jéssica!'), 'Jéssica');
  assert.strictEqual(extractCleanCustomerName('Juliana'), 'Juliana');
});

test('Cenário 2.3: Fluxo conversacional quando cliente tem pushName inválido entra em AWAITING_NAME', async () => {
  salonIncomingDispatcher._resetForTesting();

  const sentReplies = [];
  const fakeSock = {
    sendMessage: async (jid, content) => {
      sentReplies.push({ jid, content });
      return true;
    },
  };

  const clientPhone = '5511999998888';
  const sessionKey = `1:${clientPhone}`;

  // 1. Mensagem inicial de cliente com emoji como pushName
  await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: 'MSG_INIT_1', remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: 'Olá, gostaria de cortar o cabelo' },
    pushName: '🌸',
  });

  const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
  assert.ok(session, 'Sessão deve ter sido criada em memória');
  assert.strictEqual(session.customerName, 'Cliente WhatsApp', 'PushName inválido deve receber fallback seguro');

  // Forçar estado de AWAITING_SLOT para testar a transição ao escolher o horário
  session.selectedService = { id: 1, name: 'Corte e Escova', price: 85.50, duration_min: 45 };
  session.selectedStaff = { id: 1, name: 'Jéssica Designer' };
  session.candidateSlots = [
    { number: 1, date: '2026-11-26', time: '14:00', dayLabel: 'Quinta-feira' }
  ];
  session.state = 'AWAITING_SLOT';

  // 2. Cliente escolhe o horário "1"
  sentReplies.length = 0;
  await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: 'MSG_SLOT_1', remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: '1' },
    pushName: '🌸',
  });

  assert.strictEqual(session.state, 'AWAITING_NAME', 'Como cliente não possui nome válido, deve entrar em AWAITING_NAME');
  const lastReply = sentReplies[sentReplies.length - 1]?.content?.text || '';
  assert.ok(lastReply.includes('Perfeito! Antes de confirmar, pode me informar seu nome, por favor? 😊'), 'Deve pedir o nome com a mensagem padrão de captação');
});

test('Cenário 2.4: Em AWAITING_NAME, se o cliente responde "Sim" ou "1", NÃO confirma e insiste na coleta do nome', async () => {
  const clientPhone = '5511999998888';
  const sessionKey = `1:${clientPhone}`;
  const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
  assert.strictEqual(session.state, 'AWAITING_NAME');

  const sentReplies = [];
  const fakeSock = {
    sendMessage: async (jid, content) => {
      sentReplies.push({ jid, content });
      return true;
    },
  };

  // Envia "Sim"
  await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: 'MSG_NAME_CONFIRM_TRY', remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: 'Sim' },
    pushName: '🌸',
  });

  assert.strictEqual(session.state, 'AWAITING_NAME', 'Estado deve permanecer AWAITING_NAME');
  let lastReply = sentReplies[sentReplies.length - 1]?.content?.text || '';
  assert.ok(lastReply.includes('Para eu deixar reservadinho na sua ficha, qual é o seu nome completo, por favor? 😊'));

  // Envia "1"
  sentReplies.length = 0;
  await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: 'MSG_NAME_NUM_TRY', remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: '1' },
    pushName: '🌸',
  });

  assert.strictEqual(session.state, 'AWAITING_NAME', 'Estado continua AWAITING_NAME ao enviar número sem nome');
  lastReply = sentReplies[sentReplies.length - 1]?.content?.text || '';
  assert.ok(lastReply.includes('Para eu deixar reservadinho na sua ficha, qual é o seu nome completo, por favor? 😊'));
});

test('Cenário 2.5: Em AWAITING_NAME, ao fornecer nome legítimo, atualiza sessão e avança para AWAITING_CONFIRMATION', async () => {
  const clientPhone = '5511999998888';
  const sessionKey = `1:${clientPhone}`;
  const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);

  const sentReplies = [];
  const fakeSock = {
    sendMessage: async (jid, content) => {
      sentReplies.push({ jid, content });
      return true;
    },
  };

  await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: 'MSG_NAME_VALID', remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: 'Meu nome é Juliana' },
    pushName: '🌸',
  });

  assert.strictEqual(session.customerName, 'Juliana', 'Nome deve ser extraído e salvo com sucesso');
  assert.strictEqual(session.state, 'AWAITING_CONFIRMATION', 'Deve avançar imediatamente para AWAITING_CONFIRMATION');
  const lastReply = sentReplies[sentReplies.length - 1]?.content?.text || '';
  assert.ok(lastReply.includes('Obrigada, Juliana! 🥰 Agora sim, posso confirmar o seu agendamento'));
});

test('Cenário 2.6: Cliente com pushName legítimo pula direto para AWAITING_CONFIRMATION ao escolher horário', async () => {
  salonIncomingDispatcher._resetForTesting();

  const sentReplies = [];
  const fakeSock = {
    sendMessage: async (jid, content) => {
      sentReplies.push({ jid, content });
      return true;
    },
  };

  const clientPhone = '5511999997777';
  const sessionKey = `1:${clientPhone}`;

  // Cliente inicia conversa com pushName válido "Juliana Silva"
  await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: 'MSG_INIT_JULIANA', remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: 'Quero um horário para corte' },
    pushName: 'Juliana Silva',
  });

  const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
  assert.strictEqual(session.customerName, 'Juliana Silva');

  // Prepara estado AWAITING_SLOT
  session.selectedService = { id: 1, name: 'Corte e Escova', price: 85.50, duration_min: 45 };
  session.selectedStaff = { id: 1, name: 'Jéssica Designer' };
  session.candidateSlots = [
    { number: 1, date: '2026-11-27', time: '10:00', dayLabel: 'Sexta-feira' }
  ];
  session.state = 'AWAITING_SLOT';

  // Escolhe horário "1"
  sentReplies.length = 0;
  await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: 'MSG_SLOT_JULIANA', remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: '1' },
    pushName: 'Juliana Silva',
  });

  assert.strictEqual(session.state, 'AWAITING_CONFIRMATION', 'Pula direto para confirmação sem passar por AWAITING_NAME');
  const lastReply = sentReplies[sentReplies.length - 1]?.content?.text || '';
  assert.ok(lastReply.includes('Posso confirmar o seu agendamento? 🥰'));
});

// =============================================================================
// CENÁRIO 3: ALERTA DE FALHA NO GOOGLE CALENDAR (outboxWorker.js)
// =============================================================================

test('Cenário 3.1: Quando sincronização Google atinge falha definitiva, preserva agendamento CONFIRMED, marca google_sync_status=FAILED e enfileira SYNC_FAILURE', async () => {
  // Cria agendamento no banco para Tenant 1
  const aptResult = db.prepare(`
    INSERT INTO appointments (
      user_id, client_name, client_phone, title, start_datetime, end_datetime,
      status, google_sync_status
    ) VALUES (
      1, 'Mariana Costa', '5511999998888', 'Corte e Escova',
      datetime('now', '+2 days'), datetime('now', '+2 days', '+45 minutes'),
      'CONFIRMED', 'PENDING'
    )
  `).run();
  const appointmentId = aptResult.lastInsertRowid;

  // Cria token de conexão no banco para passar pela checagem de conta conectada
  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, is_connected, encrypted_tokens, selected_calendar_id, connected_at
    ) VALUES (
      1, 'gestao@salaojessica.com.br', 1, 'mock_encrypted_tokens_payload', 'primary', datetime('now')
    )
  `).run();

  // Enfileira item de sincronização na fila google_sync_outbox à beira de esgotar as tentativas (attempts = 4, max_attempts = 5)
  const gOutbox = db.prepare(`
    INSERT INTO google_sync_outbox (
      user_id, appointment_id, action, status, attempts, max_attempts, payload_json
    ) VALUES (
      1, ?, 'CREATE', 'PENDING', 4, 5, ?
    )
  `).run(appointmentId, JSON.stringify({ summary: 'Corte e Escova' }));

  // Injeta mock fail-closed no Google Calendar para simular falha definitiva de autenticação
  googleCalendarService.setMockHandler({
    createCalendarEvent: async () => {
      const err = new Error('invalid_grant: Token has been expired or revoked');
      err.code = 'invalid_grant';
      throw err;
    },
  });

  // Executa processamento da fila do outbox com LIVE_ENABLED ativado temporariamente no escopo do teste
  const prevLive = process.env.GOOGLE_SYNC_LIVE_ENABLED;
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
  try {
    await outboxWorker.processGoogleSyncOutbox(1);
  } finally {
    process.env.GOOGLE_SYNC_LIVE_ENABLED = prevLive;
  }

  // 1. O agendamento permanece CONFIRMADO no SQLite (nunca é cancelado pela falha do Google)
  const apt = db.prepare('SELECT status, google_sync_status, google_sync_error FROM appointments WHERE id = ?').get(appointmentId);
  assert.strictEqual(apt.status, 'CONFIRMED', 'Resiliência total: agendamento deve continuar confirmado');
  assert.ok(['FAILED', 'NOT_SYNCED'].includes(apt.google_sync_status), 'Status de sincronização Google deve ser FAILED ou NOT_SYNCED');

  // 2. Fila Google deve ter sido marcada como FAILED ou CANCELLED por revogação
  const outboxItem = db.prepare('SELECT status FROM google_sync_outbox WHERE id = ?').get(gOutbox.lastInsertRowid);
  assert.ok(['FAILED', 'CANCELLED'].includes(outboxItem.status));

  // 3. Notificação SYNC_FAILURE deve ter sido enfileirada na tabela whatsapp_notification_outbox
  const notifItem = db.prepare(`
    SELECT * FROM whatsapp_notification_outbox
    WHERE user_id = 1 AND appointment_id = ? AND event_type = 'SYNC_FAILURE'
    ORDER BY id DESC LIMIT 1
  `).get(appointmentId);

  assert.ok(notifItem, 'Notificação de falha de sincronização deve estar presente na fila');
  assert.ok(notifItem.message_text.includes('📢 AVISO DE GESTÃO — JÉSSICA'));
  assert.ok(notifItem.message_text.includes(`#${appointmentId}`));
  assert.ok(notifItem.message_text.includes('Falha na sincronização com o Google Calendar'));
});

test('Cenário 3.2: Deduplicação consciente impede notificações idênticas de falha de sync nos últimos 5 minutos', () => {
  // Tentativa imediata de enfileirar outra notificação SYNC_FAILURE idêntica
  const dedupRes = salonNotificationService.enqueueNotificationTx(1, 301, 'SYNC_FAILURE', {
    appointmentId: 301,
    clientName: 'Mariana Costa',
    clientPhone: '5511999998888',
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-28T10:00:00-03:00',
    error: 'Token expirado',
  });
  assert.strictEqual(dedupRes.success, true);
  assert.strictEqual(dedupRes.deduplicated, undefined);

  // Segunda chamada idêntica dentro de 5 minutos
  const secondRes = salonNotificationService.enqueueNotificationTx(1, 301, 'SYNC_FAILURE', {
    appointmentId: 301,
    clientName: 'Mariana Costa',
    clientPhone: '5511999998888',
    serviceName: 'Corte e Escova',
    staffName: 'Jéssica Designer',
    startDt: '2026-11-28T10:00:00-03:00',
    error: 'Token expirado',
  });
  assert.strictEqual(secondRes.success, true);
  assert.strictEqual(secondRes.deduplicated, true, 'Deve ser marcada como deduplicada sem novo insert redundante');
});

// =============================================================================
// CENÁRIO 4: ISOLAMENTO MULTI-TENANT E AUSÊNCIA DE IDOR
// =============================================================================

test('Cenário 4.1: Tenant 1 não acessa ou visualiza configurações, outbox ou dados do Tenant 2', () => {
  // Configurações do Tenant 1
  const settingsTenant1 = salonNotificationService.getNotificationSettings(1);
  assert.strictEqual(settingsTenant1.notificationPhone, '5511999990001');
  assert.strictEqual(settingsTenant1.salonName, 'Espaço Jéssica Beleza');

  // Configurações do Tenant 2
  const settingsTenant2 = salonNotificationService.getNotificationSettings(2);
  assert.strictEqual(settingsTenant2.notificationPhone, '5511999990002');
  assert.strictEqual(settingsTenant2.salonName, 'Studio Glamour');

  // Inserção de notificação para Tenant 2
  salonNotificationService.enqueueNotificationTx(2, 401, 'NEW_APPOINTMENT', {
    appointmentId: 401,
    clientName: 'Cliente do Salão 2',
    clientPhone: '5511999998888',
    serviceName: 'Manicure Especial',
    staffName: 'Camila Manicure',
    startDt: '2026-11-29T10:00:00-03:00',
    endDt: '2026-11-29T10:30:00-03:00',
    price: 40.00,
  });

  // Query estrita de outbox pelo Tenant 1 jamais pode trazer registros do Tenant 2
  const tenant1Outbox = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE user_id = 1 AND appointment_id = 401').all();
  assert.strictEqual(tenant1Outbox.length, 0, 'Tenant 1 não deve enxergar notificação do agendamento 401 pertencente ao Tenant 2');

  const tenant2Outbox = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE user_id = 2 AND appointment_id = 401').all();
  assert.strictEqual(tenant2Outbox.length, 1, 'Tenant 2 deve enxergar sua notificação');
});

// =============================================================================
// CENÁRIO 5: PREVENÇÃO CONTRA MENSAGENS E AGENDAMENTOS DUPLICADOS
// =============================================================================

test('Cenário 5.1: processed_messages descarta webhook idêntico repetido (idempotência)', async () => {
  const fakeSock = { sendMessage: async () => true };
  const clientPhone = '5511999990001';
  const duplicateMsgKey = 'MSG_UNIQUE_KEY_9999';

  // 1. Primeiro envio
  const handledFirst = await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: duplicateMsgKey, remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: 'Olá, bom dia' },
    pushName: 'Dona Jéssica',
  });
  assert.strictEqual(handledFirst, true, 'Primeira mensagem deve ser processada');

  // 2. Registro gravado na tabela processed_messages
  const processedRecord = db.prepare('SELECT id FROM processed_messages WHERE id = ?').get(duplicateMsgKey);
  assert.ok(processedRecord, 'Chave da mensagem deve estar gravada em processed_messages');

  // 3. Reenvio da exata mesma mensagem (duplicata de rede do Baileys/Webhook)
  const handledSecond = await salonIncomingDispatcher.dispatchMessage(1, fakeSock, {
    key: { id: duplicateMsgKey, remoteJid: `${clientPhone}@s.whatsapp.net` },
    message: { conversation: 'Olá, bom dia' },
    pushName: 'Dona Jéssica',
  });
  assert.strictEqual(handledSecond, false, 'Reenvio com mesma chave deve ser descartado imediatamente sem duplicar processamento');
});
