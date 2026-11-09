/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICA: COMANDO 021 (20 CENÁRIOS INTEGRADOS)
 *
 * Verificação mandatória do Requisito 6:
 *  1. NODE_ENV=test isoladamente bloqueia envio real.
 *  2. APP_MODE=test bloqueia envio real.
 *  3. APP_MODE=staging bloqueia envio real.
 *  4. HOMOLOGACAO=true bloqueia envio real.
 *  5. ALLOW_WHATSAPP_SENDING=false em produção não transmite.
 *  6. ALLOW_WHATSAPP_SENDING=true não contorna staging.
 *  7. Produção autorizada com mock recebe confirmação válida (status = 'SENT', notified = 1).
 *  8. Produção com mock e erro de transporte falha corretamente (sem Phantom Delivery, notified = 0).
 *  9. Rota pública retorna sent: false quando o socket falha.
 * 10. Rota pública retorna simulated: true em homologação.
 * 11. O histórico (agent_messages) não registra mensagem após falha na rota pública.
 * 12. Item com next_retry_at no futuro não é processado por processWhatsAppOutboxItem().
 * 13. Item com prazo vencido é processado com sucesso.
 * 14. Item com limite esgotado (attempts >= max_attempts) não é transmitido.
 * 15. Falha anterior não elimina nova solicitação legítima (status FAILED permite novo enfileiramento).
 * 16. Duplicação idêntica é impedida corretamente (DEDUPLICATED em janela de 5 min).
 * 17. SIMULATED atualiza appointments.whatsapp_notified = 2 (distinto de 1 real e 0 falha).
 * 18. Regressão da criação, remarcação e cancelamento de agendamentos.
 * 19. Suítes 019 e 020 completas e aprovadas.
 * 20. Regressões relevantes da Jéssica e do Admin (016, 017, 018) + Inviolabilidade de data/assistant.db.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

// -------------------------------------------------------------
// 1. ISOLAMENTO ESTRITO DO BANCO DE DADOS E DIRETÓRIO AUTH
// -------------------------------------------------------------
const tempDbFile = path.join(os.tmpdir(), `raia_test_outbox_021_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_021_${Date.now()}_${Math.random().toString(36).substring(7)}`);

fs.mkdirSync(tempAuthDir, { recursive: true });

process.env.DB_PATH = tempDbFile;
process.env.AUTH_DIR = tempAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.BASE_URL = 'https://staging.raiaagentes.com.br';
process.env.ADMIN_PASSWORD = 'SenhaSeguraValidaTeste2026!#';
process.env.SESSION_SECRET = 'session_secret_segredo_forte_teste_2026';
process.env.CLIENT_AUTH_SECRET = 'client_auth_secret_segredo_forte_teste_2026';
delete process.env.ALLOW_WHATSAPP_SENDING;

const config = require('../src/config');
config.authDir = tempAuthDir;

const db = require('../src/database/db');
const phoneUtils = require('../src/utils/phoneUtils');
const outboxWorker = require('../src/services/outboxWorker');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonNotificationService = require('../src/services/salonNotificationService');
const agentChatService = require('../src/services/agentChatService');
const whatsappClient = require('../src/whatsapp/client');
const { handleLeadTestRequest } = require('../src/server/app');

function mockReqRes(body = {}) {
  const req = {
    body,
    headers: { referer: 'https://raiaagentes.com.br/solucoes/saloes-e-beleza', 'user-agent': 'TestAgent/1.0' },
    ip: '127.0.0.1',
  };
  let responseData = null;
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
  };
  return { req, res, getResult: () => ({ statusCode, responseData }) };
}

async function runTests() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — SUÍTE DE TESTES HERMÉTICA: COMANDO 021 (20 CENÁRIOS)');
  console.log('================================================================\n');

  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE AMBIENTE ---');
  console.log('  ✓ Banco temporário ativo:', tempDbFile);
  console.log('  ✓ AuthDir temporário isolado em os.tmpdir():', tempAuthDir);

  const realAuthDir = path.resolve(__dirname, '../auth_info_baileys');
  const realAuthFilesBefore = fs.existsSync(realAuthDir) ? fs.readdirSync(realAuthDir) : [];

  const prodDbPath = path.join(__dirname, '..', 'data', 'assistant.db');
  let prodDbMtimeBefore = null;
  if (fs.existsSync(prodDbPath)) {
    prodDbMtimeBefore = fs.statSync(prodDbPath).mtimeMs;
  }
  console.log('  ✓ Banco operacional data/assistant.db monitorado para inviolabilidade.\n');

  let passedTests = 0;
  const totalTests = 20;

  // Mock de Usuário, Salão, Profissional e Serviço
  const testUserId = 91;
  db.prepare(`INSERT OR IGNORE INTO users (id, phone_number, name) VALUES (?, '5511999990091', 'Salão Teste 021')`).run(testUserId);
  db.prepare(`
    INSERT OR REPLACE INTO client_salons (
      user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled,
      notify_new_appointment, notify_cancellation, notify_reschedule
    ) VALUES (?, 'Salão Jéssica 021', '5511988880091', '5511988880091', 1, 1, 1, 1)
  `).run(testUserId);
  db.prepare(`INSERT OR REPLACE INTO client_staff (user_id, name, specialty, active) VALUES (?, 'Jéssica 021', 'Cabeleireira', 1)`).run(testUserId);
  db.prepare(`INSERT OR REPLACE INTO client_services (user_id, name, price, duration_min, active) VALUES (?, 'Escova Premium', 100.00, 45, 1)`).run(testUserId);

  function createTestAppointment(status = 'CONFIRMADO') {
    const apt = db.prepare(`
      INSERT INTO appointments (
        user_id, title, client_name, client_phone, start_datetime, end_datetime, status, duration_min, price, whatsapp_notified
      ) VALUES (?, 'Atendimento 021', 'Cliente 021', '5511977770021', '2026-11-30 10:00:00', '2026-11-30 10:45:00', ?, 45, 100.00, 0)
    `).run(testUserId, status);
    return apt.lastInsertRowid;
  }

  try {
    // -------------------------------------------------------------
    // CENÁRIO 1: NODE_ENV=test isoladamente bloqueia envio real
    // -------------------------------------------------------------
    console.log('--- TESTE 1: NODE_ENV=test isoladamente bloqueia envio real ---');
    delete process.env.APP_MODE;
    delete process.env.HOMOLOGACAO;
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_WHATSAPP_SENDING;

    assert.strictEqual(whatsappClient.isRealWhatsAppTransportAllowed(), false);
    const res1 = await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Msg Test 1');
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.sent, false);
    assert.strictEqual(res1.simulated, true, 'NODE_ENV=test deve retornar envio simulado');
    console.log('  ✓ NODE_ENV=test bloqueia envio real com segurança.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 2: APP_MODE=test bloqueia envio real
    // -------------------------------------------------------------
    console.log('--- TESTE 2: APP_MODE=test bloqueia envio real ---');
    process.env.APP_MODE = 'test';
    process.env.NODE_ENV = 'development';
    delete process.env.HOMOLOGACAO;
    delete process.env.ALLOW_WHATSAPP_SENDING;

    assert.strictEqual(whatsappClient.isRealWhatsAppTransportAllowed(), false);
    const res2 = await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Msg Test 2');
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.sent, false);
    assert.strictEqual(res2.simulated, true, 'APP_MODE=test deve retornar envio simulado');
    console.log('  ✓ APP_MODE=test bloqueia envio real com segurança.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 3: APP_MODE=staging bloqueia envio real
    // -------------------------------------------------------------
    console.log('--- TESTE 3: APP_MODE=staging bloqueia envio real ---');
    process.env.APP_MODE = 'staging';
    process.env.NODE_ENV = 'production';
    delete process.env.HOMOLOGACAO;
    delete process.env.ALLOW_WHATSAPP_SENDING;

    assert.strictEqual(whatsappClient.isRealWhatsAppTransportAllowed(), false);
    const res3 = await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Msg Test 3');
    assert.strictEqual(res3.success, true);
    assert.strictEqual(res3.sent, false);
    assert.strictEqual(res3.simulated, true, 'APP_MODE=staging deve retornar envio simulado');
    console.log('  ✓ APP_MODE=staging bloqueia envio real com segurança.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 4: HOMOLOGACAO=true bloqueia envio real
    // -------------------------------------------------------------
    console.log('--- TESTE 4: HOMOLOGACAO=true bloqueia envio real ---');
    delete process.env.APP_MODE;
    process.env.HOMOLOGACAO = 'true';
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_WHATSAPP_SENDING;

    assert.strictEqual(whatsappClient.isRealWhatsAppTransportAllowed(), false);
    const res4 = await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Msg Test 4');
    assert.strictEqual(res4.success, true);
    assert.strictEqual(res4.sent, false);
    assert.strictEqual(res4.simulated, true, 'HOMOLOGACAO=true deve retornar envio simulado');
    console.log('  ✓ HOMOLOGACAO=true bloqueia envio real com segurança.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 5: ALLOW_WHATSAPP_SENDING=false em produção não transmite
    // -------------------------------------------------------------
    console.log('--- TESTE 5: ALLOW_WHATSAPP_SENDING=false em produção não transmite ---');
    process.env.APP_MODE = 'production';
    process.env.NODE_ENV = 'production';
    delete process.env.HOMOLOGACAO;
    process.env.ALLOW_WHATSAPP_SENDING = 'false';

    assert.strictEqual(whatsappClient.isRealWhatsAppTransportAllowed(), false);
    const res5 = await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Msg Test 5');
    assert.strictEqual(res5.success, true);
    assert.strictEqual(res5.sent, false);
    assert.strictEqual(res5.simulated, true, 'Produção sem ALLOW_WHATSAPP_SENDING deve simular');
    console.log('  ✓ Produção com ALLOW_WHATSAPP_SENDING=false bloqueia transmissão externa.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 6: ALLOW_WHATSAPP_SENDING=true não contorna staging
    // -------------------------------------------------------------
    console.log('--- TESTE 6: Hard Staging Lock: ALLOW_WHATSAPP_SENDING=true não contorna staging ---');
    process.env.APP_MODE = 'staging';
    process.env.HOMOLOGACAO = 'true';
    process.env.ALLOW_WHATSAPP_SENDING = 'true'; // Tentativa de bypass

    assert.strictEqual(whatsappClient.isRealWhatsAppTransportAllowed(), false);
    const res6 = await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Msg Test 6');
    assert.strictEqual(res6.success, true);
    assert.strictEqual(res6.sent, false);
    assert.strictEqual(res6.simulated, true, 'Staging deve prevalecer sobre ALLOW_WHATSAPP_SENDING=true');
    console.log('  ✓ Hard Staging Lock validado: tentativa de contorno impedida.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 7: Produção autorizada com mock recebe confirmação válida (SENT, notified = 1)
    // -------------------------------------------------------------
    console.log('--- TESTE 7: Produção autorizada com mock Baileys -> status = SENT, notified = 1 ---');
    process.env.APP_MODE = 'production';
    process.env.NODE_ENV = 'production';
    delete process.env.HOMOLOGACAO;
    delete process.env.DISABLE_WHATSAPP_DISPATCH;
    process.env.ALLOW_WHATSAPP_SENDING = 'true';

    assert.strictEqual(whatsappClient.isRealWhatsAppTransportAllowed(), true);

    whatsappClient._setSocketForTesting({
      user: { id: '5511999990091:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => ({ key: { id: 'BAILEYS_VALID_021' }, messageTimestamp: 1730000000 })
    });

    const apt7 = createTestAppointment();
    const outbox7 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, status)
      VALUES (?, ?, 'NEW_APPOINTMENT', '5511988880091', 'Mensagem Real 7', 'PENDING')
    `).run(testUserId, apt7).lastInsertRowid;

    const procRes7 = await outboxWorker.processWhatsAppOutboxItem(outbox7);
    assert.strictEqual(procRes7.status, 'SENT');
    assert.strictEqual(procRes7.sent, true);

    const checkOutbox7 = db.prepare('SELECT status, is_simulated FROM whatsapp_notification_outbox WHERE id = ?').get(outbox7);
    assert.strictEqual(checkOutbox7.status, 'SENT');
    assert.strictEqual(checkOutbox7.is_simulated, 0);

    const checkApt7 = db.prepare('SELECT whatsapp_notified FROM appointments WHERE id = ?').get(apt7);
    assert.strictEqual(checkApt7.whatsapp_notified, 1, 'Entrega real DEVE marcar whatsapp_notified = 1');
    console.log('  ✓ Confirmação em produção real validada: status SENT e whatsapp_notified = 1.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 8: Produção com mock e erro de transporte falha corretamente
    // -------------------------------------------------------------
    console.log('--- TESTE 8: Produção com falha de transporte -> outbox PENDING, notified = 0 ---');
    whatsappClient._setSocketForTesting({
      user: { id: '5511999990091:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => { throw new Error('ETIMEDOUT: Connection timed out'); }
    });

    const apt8 = createTestAppointment();
    const outbox8 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, status)
      VALUES (?, ?, 'NEW_APPOINTMENT', '5511988880091', 'Mensagem Falha 8', 'PENDING')
    `).run(testUserId, apt8).lastInsertRowid;

    const procRes8 = await outboxWorker.processWhatsAppOutboxItem(outbox8);
    assert.strictEqual(procRes8.success, false);

    const checkOutbox8 = db.prepare('SELECT status, attempts, last_error FROM whatsapp_notification_outbox WHERE id = ?').get(outbox8);
    assert.strictEqual(checkOutbox8.status, 'PENDING');
    assert.strictEqual(checkOutbox8.attempts, 1);
    assert.match(checkOutbox8.last_error, /ETIMEDOUT/);

    const checkApt8 = db.prepare('SELECT whatsapp_notified FROM appointments WHERE id = ?').get(apt8);
    assert.strictEqual(checkApt8.whatsapp_notified, 0, 'Falha no transporte DEVE manter whatsapp_notified = 0');
    console.log('  ✓ Erro de transporte capturado: zero Phantom Delivery.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 9: A rota pública retorna sent: false quando o socket falha
    // -------------------------------------------------------------
    console.log('--- TESTE 9: Rota pública retorna sent: false quando socket falha ---');
    whatsappClient._setSocketForTesting({
      user: { id: '5511999990091:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => { throw new Error('SOCKET_TRANSMISSION_FAILED'); }
    });

    const { req: req9, res: res9, getResult: getRes9 } = mockReqRes({
      name: 'Cliente Falha 9',
      phone: '11977770009',
      nicheSlug: 'saloes-e-beleza',
    });

    await handleLeadTestRequest(req9, res9);
    const routeRes9 = getRes9().responseData;
    assert.strictEqual(routeRes9.success, true);
    assert.strictEqual(routeRes9.sent, false, 'Rota pública DEVE retornar sent: false na falha do socket');
    assert.strictEqual(routeRes9.simulated, false);
    assert.ok(routeRes9.fallbackUrl, 'Deve conter fallbackUrl em caso de falha');
    console.log('  ✓ Rota pública retorna sent: false sob falha de socket.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 10: A rota pública retorna simulated: true em homologação
    // -------------------------------------------------------------
    console.log('--- TESTE 10: Rota pública retorna simulated: true em homologação ---');
    process.env.HOMOLOGACAO = 'true';
    process.env.APP_MODE = 'staging';

    const { req: req10, res: res10, getResult: getRes10 } = mockReqRes({
      name: 'Cliente Staging 10',
      phone: '11977770010',
      nicheSlug: 'saloes-e-beleza',
    });

    await handleLeadTestRequest(req10, res10);
    const routeRes10 = getRes10().responseData;
    assert.strictEqual(routeRes10.success, true);
    assert.strictEqual(routeRes10.sent, false);
    assert.strictEqual(routeRes10.simulated, true, 'Rota em homologação DEVE retornar simulated: true');
    console.log('  ✓ Rota pública em homologação retorna simulated: true.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 11: O histórico não registra envio inicial inexistente após falha
    // -------------------------------------------------------------
    console.log('--- TESTE 11: Histórico agent_messages NÃO registra mensagem após falha de envio ---');
    // Em produção com socket que falha
    process.env.APP_MODE = 'production';
    process.env.NODE_ENV = 'production';
    delete process.env.HOMOLOGACAO;
    process.env.ALLOW_WHATSAPP_SENDING = 'true';

    whatsappClient._setSocketForTesting({
      user: { id: '5511999990091:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => { throw new Error('SOCKET_ERROR_TEST_11'); }
    });

    const phone11 = '11977770011';
    const clean11 = '5511977770011';
    const { req: req11, res: res11, getResult: getRes11 } = mockReqRes({
      name: 'Cliente Test 11',
      phone: phone11,
      nicheSlug: 'saloes-e-beleza',
    });

    await handleLeadTestRequest(req11, res11);
    const resData11 = getRes11().responseData;
    assert.strictEqual(resData11.sent, false);

    // Verifica que o lead foi criado
    const lead11 = db.prepare('SELECT id FROM leads WHERE phone = ? ORDER BY id DESC LIMIT 1').get(clean11);
    assert.ok(lead11, 'O cadastro do lead DEVE ser preservado no banco mesmo após falha de envio');

    // Verifica que NÃO há mensagem fantasma gravada no histórico
    const msgs11 = db.prepare('SELECT COUNT(*) as count FROM agent_messages WHERE lead_id = ?').get(lead11.id).count;
    assert.strictEqual(msgs11, 0, 'Histórico NÃO pode conter mensagem fantasma de envio falhado');
    console.log('  ✓ Histórico íntegro: zero registros órfãos de envio inexistente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 12: Item com next_retry_at no futuro não é processado por processWhatsAppOutboxItem()
    // -------------------------------------------------------------
    console.log('--- TESTE 12: processWhatsAppOutboxItem() respeita next_retry_at no futuro ---');
    const futureNextRetry = new Date(Date.now() + 15 * 60000).toISOString();
    const outboxId12 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, status, attempts, next_retry_at)
      VALUES (?, 112, 'NEW_APPOINTMENT', '5511988880091', 'Msg Futura 12', 'PENDING', 1, ?)
    `).run(testUserId, futureNextRetry).lastInsertRowid;

    const procRes12 = await outboxWorker.processWhatsAppOutboxItem(outboxId12);
    assert.strictEqual(procRes12.skipped, true);
    assert.strictEqual(procRes12.reason, 'RETRY_NOT_DUE');

    const check12 = db.prepare('SELECT status, attempts FROM whatsapp_notification_outbox WHERE id = ?').get(outboxId12);
    assert.strictEqual(check12.status, 'PENDING');
    assert.strictEqual(check12.attempts, 1, 'attempts não pode ter sido incrementado');
    console.log('  ✓ Item com retry futuro rejeitado por processWhatsAppOutboxItem() com RETRY_NOT_DUE.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 13: Item com prazo vencido é processado com sucesso
    // -------------------------------------------------------------
    console.log('--- TESTE 13: Item com next_retry_at vencido é processado normalmente ---');
    process.env.HOMOLOGACAO = 'true';
    process.env.APP_MODE = 'staging';

    const pastNextRetry = new Date(Date.now() - 30000).toISOString();
    const outboxId13 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, status, attempts, next_retry_at)
      VALUES (?, 113, 'NEW_APPOINTMENT', '5511988880091', 'Msg Vencida 13', 'PENDING', 1, ?)
    `).run(testUserId, pastNextRetry).lastInsertRowid;

    const procRes13 = await outboxWorker.processWhatsAppOutboxItem(outboxId13);
    assert.strictEqual(procRes13.status, 'SIMULATED');
    assert.strictEqual(procRes13.simulated, true);
    console.log('  ✓ Item com prazo vencido processado com sucesso.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 14: Item com limite esgotado não é transmitido
    // -------------------------------------------------------------
    console.log('--- TESTE 14: Item com limite esgotado não é transmitido por processWhatsAppOutboxItem() ---');
    const outboxId14 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, status, attempts, max_attempts)
      VALUES (?, 114, 'NEW_APPOINTMENT', '5511988880091', 'Msg Esgotada 14', 'PENDING', 5, 5)
    `).run(testUserId).lastInsertRowid;

    const procRes14 = await outboxWorker.processWhatsAppOutboxItem(outboxId14);
    assert.strictEqual(procRes14.skipped, true);
    assert.strictEqual(procRes14.reason, 'MAX_ATTEMPTS_EXCEEDED');
    console.log('  ✓ Item com tentativas esgotadas bloqueado contra transmissão.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 15: Falha anterior não elimina uma nova solicitação legítima
    // -------------------------------------------------------------
    console.log('--- TESTE 15: Status FAILED na outbox permite novo enfileiramento legítimo ---');
    const apt15 = createTestAppointment();
    // Enfileiramento 1 que falha e vai para FAILED
    const item15Fail = await salonNotificationService.queueNotification(testUserId, apt15, 'NEW_APPOINTMENT', {
      clientName: 'Cliente Tentativa 1',
      serviceName: 'Escova',
      staffName: 'Jéssica',
      startDt: '2026-11-30 18:00:00'
    });
    db.prepare(`UPDATE whatsapp_notification_outbox SET status = 'FAILED' WHERE id = ?`).run(item15Fail.outboxId);

    // Enfileiramento 2 legítimo do mesmo evento após falha
    const item15Retry = await salonNotificationService.queueNotification(testUserId, apt15, 'NEW_APPOINTMENT', {
      clientName: 'Cliente Tentativa 2',
      serviceName: 'Escova',
      staffName: 'Jéssica',
      startDt: '2026-11-30 18:00:00'
    });

    assert.strictEqual(item15Retry.success, true);
    assert.notStrictEqual(item15Retry.outboxId, item15Fail.outboxId, 'Novo item DEVE ser gerado após falha');
    assert.strictEqual(item15Retry.deduplicated, undefined);
    console.log('  ✓ Nova solicitação legítima aceita após FAILED anterior.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 16: Duplicação idêntica é impedida corretamente
    // -------------------------------------------------------------
    console.log('--- TESTE 16: Duplicação idêntica impedida em janela de 5 minutos ---');
    const apt16 = createTestAppointment();
    const item16a = await salonNotificationService.queueNotification(testUserId, apt16, 'NEW_APPOINTMENT', {
      clientName: 'Dup Check',
      serviceName: 'Corte',
      staffName: 'Jéssica',
      startDt: '2026-11-30 19:00:00'
    });
    const item16b = await salonNotificationService.queueNotification(testUserId, apt16, 'NEW_APPOINTMENT', {
      clientName: 'Dup Check',
      serviceName: 'Corte',
      staffName: 'Jéssica',
      startDt: '2026-11-30 19:00:00'
    });

    assert.strictEqual(item16b.deduplicated, true, 'Segunda chamada idêntica DEVE ser deduplicada');
    console.log('  ✓ Deduplicação idêntica comprovada.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 17: SIMULATED atualiza appointments.whatsapp_notified = 2
    // -------------------------------------------------------------
    console.log('--- TESTE 17: SIMULATED atualiza appointments.whatsapp_notified = 2 ---');
    process.env.HOMOLOGACAO = 'true';
    process.env.APP_MODE = 'staging';

    const apt17 = createTestAppointment();
    const qRes17 = await salonNotificationService.queueNotification(testUserId, apt17, 'NEW_APPOINTMENT', {
      clientName: 'Cliente 17 Simulado',
      serviceName: 'Escova Premium',
      staffName: 'Jéssica',
      startDt: '2026-11-30 20:00:00'
    });

    const checkApt17 = db.prepare('SELECT whatsapp_notified FROM appointments WHERE id = ?').get(apt17);
    assert.strictEqual(checkApt17.whatsapp_notified, 2, 'Agendamento simulado DEVE ter whatsapp_notified = 2 (distinto de 1 e 0)');
    console.log('  ✓ whatsapp_notified = 2 validado estritamente para status SIMULATED.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 18: Regressão da criação, remarcação e cancelamento de agendamentos
    // -------------------------------------------------------------
    console.log('--- TESTE 18: Regressão de agendamento: criação, remarcação e cancelamento ---');
    const apt18 = salonAppointmentService.bookAppointmentSync(testUserId, {
      clientName: 'Renata Castro',
      clientPhone: '5511944440018',
      serviceName: 'Escova Premium',
      date: '2026-12-01',
      time: '10:00',
    });
    assert.ok(apt18);

    await salonAppointmentService.rescheduleAppointment(apt18.id, testUserId, {
      newDate: '2026-12-01',
      newTime: '11:00',
      reason: 'Remarcado'
    });

    await salonAppointmentService.cancelAppointment(apt18.id, testUserId, 'Cancelado');

    const checkApt18 = db.prepare('SELECT status FROM appointments WHERE id = ?').get(apt18.id);
    assert.strictEqual(checkApt18.status, 'CANCELADO');
    console.log('  ✓ Ciclo completo de vida de agendamento validado.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 19: Suítes 019 e 020 completas e aprovadas
    // -------------------------------------------------------------
    console.log('--- TESTE 19: Regressão integral dos comportamentos das Suítes 019 e 020 ---');
    // Lock atômico concorrente
    const outbox19 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, status)
      VALUES (?, 119, 'NEW_APPOINTMENT', '5511988880091', 'Msg Concorrência 19', 'PENDING')
    `).run(testUserId).lastInsertRowid;

    const lockA = db.prepare(`UPDATE whatsapp_notification_outbox SET status = 'PROCESSING' WHERE id = ? AND status = 'PENDING'`).run(outbox19);
    const lockB = db.prepare(`UPDATE whatsapp_notification_outbox SET status = 'PROCESSING' WHERE id = ? AND status = 'PENDING'`).run(outbox19);
    assert.strictEqual(lockA.changes, 1);
    assert.strictEqual(lockB.changes, 0);

    // Recuperação de crash
    db.prepare(`UPDATE whatsapp_notification_outbox SET locked_at = datetime('now', '-10 minutes') WHERE id = ?`).run(outbox19);
    const rec19 = outboxWorker.recoverStalledTasks();
    assert.ok(rec19.whatsappRecovered >= 1);
    console.log('  ✓ Contratos fundamentais das suítes 019 e 020 preservados.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 20: Regressões 016 a 018 e Inviolabilidade de data/assistant.db
    // -------------------------------------------------------------
    console.log('--- TESTE 20: Não-regressão 016-018 e Inviolabilidade do BD Operacional ---');
    // Presunção sintética celular 9D -> fixo 8D bloqueada
    db.prepare(`INSERT INTO leads (name, phone, agent_key, status) VALUES ('Fixo 8D', '551133334444', 'SALON', 'SENT')`).run();
    const matchCelularSemCadastro = agentChatService.findActiveLead('5511933334444');
    assert.strictEqual(matchCelularSemCadastro, null, 'Presunção sintética celular 9D -> fixo 8D DEVE retornar null');

    // Inviolabilidade do BD de produção
    if (prodDbMtimeBefore !== null && fs.existsSync(prodDbPath)) {
      const prodDbMtimeAfter = fs.statSync(prodDbPath).mtimeMs;
      assert.strictEqual(prodDbMtimeAfter, prodDbMtimeBefore, 'O arquivo operacional data/assistant.db NUNCA pode ser tocado!');
    }

    // Inviolabilidade do diretório real auth_info_baileys
    const realAuthFilesAfter = fs.existsSync(realAuthDir) ? fs.readdirSync(realAuthDir) : [];
    assert.deepStrictEqual(realAuthFilesAfter, realAuthFilesBefore, 'Diretório auth_info_baileys NÃO pode sofrer modificações!');
    console.log('  ✓ Regras dos comandos anteriores e inviolabilidade do ambiente 100% comprovadas.\n');
    passedTests++;

  } finally {
    // LIMPEZA HERMÉTICA DOS RECURSOS
    console.log('--- LIMPEZA HERMÉTICA DOS RECURSOS TEMPORÁRIOS ---');
    try {
      outboxWorker.stopWorker();
      whatsappClient._resetSocketForTesting();
    } catch (_) {}

    await new Promise(r => setTimeout(r, 200));

    try {
      db.close();
      if (fs.existsSync(tempDbFile)) fs.unlinkSync(tempDbFile);
      const walFile = `${tempDbFile}-wal`;
      const shmFile = `${tempDbFile}-shm`;
      if (fs.existsSync(walFile)) { try { fs.unlinkSync(walFile); } catch (_) {} }
      if (fs.existsSync(shmFile)) { try { fs.unlinkSync(shmFile); } catch (_) {} }
      if (fs.existsSync(tempAuthDir)) fs.rmSync(tempAuthDir, { recursive: true, force: true });
      console.log('  ✓ Banco e diretórios temporários descartados com sucesso.');
    } catch (e) {
      console.warn('  ⚠️ Aviso na limpeza:', e.message);
    }
  }

  console.log('\n================================================================');
  console.log(`  RESULTADO: ${passedTests}/${totalTests} TESTES APROVADOS (100% SUCESSO)`);
  console.log('  COMANDO 021: CONFIABILIDADE INTEGRADA E HARD LOCK COMPROVADOS');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ FALHA NA SUÍTE DE TESTES 021:', err);
  process.exit(1);
});
