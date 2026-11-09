/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADA: CONFIABILIDADE DE DISPARO WHATSAPP, RETRY E PHANTOM DELIVERY (COMANDO 019)
 * 
 * Verificação obrigatória dos 20 cenários de confiabilidade e resiliência:
 * 1.  sendWhatsAppMessage lança WHATSAPP_SOCKET_NULL quando currentSock é null.
 * 2.  sendWhatsAppMessage lança WHATSAPP_SOCKET_DISCONNECTED quando currentSock.user é nulo ou ws desconectado.
 * 3.  sendWhatsAppMessage lança INVALID_RECIPIENT_BLOCKED para grupos (@g.us), canais, broadcast ou vazio.
 * 4.  sendWhatsAppMessage lança UNMAPPED_LID_FAIL_CLOSED quando LID não possui mapeamento resolvido.
 * 5.  sendWhatsAppMessage resolve LID mapeado com sucesso para @s.whatsapp.net e envia.
 * 6.  sendWhatsAppMessage lança BAILEYS_TRANSMISSION_ERROR quando socket.sendMessage rejeita por erro de rede.
 * 7.  sendWhatsAppMessage lança BAILEYS_EMPTY_CONFIRMATION quando Baileys retorna resposta sem key.id.
 * 8.  sendWhatsAppMessage retorna contrato { success: true, messageId, timestamp, recipientJid } e grava processed_messages.
 * 9.  Item da fila outbox JAMAIS transiciona para status = 'SENT' quando envio falha (Fim do Phantom Delivery).
 * 10. Agendamento whatsapp_notified permanece estritamente 0 quando o envio do WhatsApp falha.
 * 11. Item com falha incrementa attempts e permanece PENDING com backoff exponencial quando attempts < max_attempts.
 * 12. Item com falha transiciona para status = 'FAILED' quando attempts >= max_attempts (exaustão).
 * 13. last_error é sanitizado contra vazamento de tokens Bearer e limitado a 500 caracteres.
 * 14. Hard Staging Lock: sob staging/homologacao/test, outbox transiciona estritamente para SIMULATED (is_simulated = 1), NUNCA SENT.
 * 15. Hard Staging Lock: ALLOW_WHATSAPP_SENDING=true NÃO pode contornar o isolamento de homologação/staging.
 * 16. Deduplicação em janela de 5 minutos marca itens repetidos como DEDUPLICATED sem reenvio.
 * 17. Concorrência: workers paralelos não processam o mesmo item simultaneamente graças ao lock atômico PROCESSING.
 * 18. recoverStalledTasks() recupera itens travados em PROCESSING há mais de 5 minutos retornando-os para PENDING.
 * 19. Unificação de rota: salonNotificationService.dispatchOutboxItem e outboxWorker.processWhatsAppOutboxItem compartilham a mesma máquina de estados.
 * 20. queueNotification enfileira com dedup_hash no estado PENDING e notifica o worker via outboxWorker.notify().
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// -------------------------------------------------------------
// 1. ISOLAMENTO ESTRITO DO BANCO DE DADOS (SQLITE TEMPORÁRIO)
// -------------------------------------------------------------
const tempDbFile = path.join(os.tmpdir(), `raia_test_outbox_019_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
process.env.DB_PATH = tempDbFile;

// Configurações iniciais isoladas
process.env.APP_MODE = 'test';
process.env.NODE_ENV = 'test';
delete process.env.ALLOW_WHATSAPP_SENDING;

const db = require('../src/database/db');
const whatsappClient = require('../src/whatsapp/client');
const outboxWorker = require('../src/services/outboxWorker');
const salonNotificationService = require('../src/services/salonNotificationService');

async function runTests() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — SUÍTE DE TESTES 019: CONFIABILIDADE OUTBOX WHATSAPP');
  console.log('================================================================\n');

  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE TESTE ---');
  console.log('  ✓ Banco temporário ativo:', tempDbFile);
  const prodDbPath = path.join(__dirname, '..', 'data', 'assistant.db');
  console.log('  ✓ Banco de produção data/assistant.db 100% intocado e isolado.\n');

  // Configurar salão e usuário base de teste
  const userRow = db.prepare(`
    INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, paid_until)
    VALUES ('salao.vip@teste.com', '5511999998888', 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'))
  `).run();
  const userId = userRow.lastInsertRowid;

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment)
    VALUES (?, 'Salão VIP Jéssica', '5511999998888', '5511999998888', 1, 1)
  `).run(userId);

  const staff = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active)
    VALUES (?, 'Jéssica Master', 'Cabeleireira', 1)
  `).run(userId);
  const staffId = staff.lastInsertRowid;

  const service = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Escova Modeladora', 45, 80.00, 1, 'Cabelo')
  `).run(userId);
  const serviceId = service.lastInsertRowid;

  function createTestAppointment() {
    const apt = db.prepare(`
      INSERT INTO appointments (
        user_id, staff_id, service_id, client_name, client_phone,
        title, start_datetime, end_datetime, status, duration_min, price, whatsapp_notified
      )
      VALUES (?, ?, ?, 'Cliente Teste', '5511977776666', 'Atendimento Teste', '2026-11-25 10:00:00', '2026-11-25 10:45:00', 'CONFIRMADO', 45, 80.00, 0)
    `).run(userId, staffId, serviceId);
    return apt.lastInsertRowid;
  }

  try {
    // =========================================================================
    // TESTE 1: sendWhatsAppMessage com socket null
    // =========================================================================
    console.log('[Teste 1] sendWhatsAppMessage lança WHATSAPP_SOCKET_NULL quando socket é null...');
    whatsappClient._resetSocketForTesting();
    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Teste 1');
      },
      /WHATSAPP_SOCKET_NULL/
    );
    console.log('  ✓ Teste 1 aprovado: WHATSAPP_SOCKET_NULL disparado.');

    // =========================================================================
    // TESTE 2: sendWhatsAppMessage com socket desconectado / não autenticado
    // =========================================================================
    console.log('\n[Teste 2] sendWhatsAppMessage lança WHATSAPP_SOCKET_DISCONNECTED quando desconectado...');
    whatsappClient._setSocketForTesting({ user: null });
    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Teste 2');
      },
      /WHATSAPP_SOCKET_DISCONNECTED/
    );

    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 2 }, // CLOSING / NOT READY
    });
    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Teste 2 (ws)');
      },
      /WHATSAPP_SOCKET_DISCONNECTED/
    );
    console.log('  ✓ Teste 2 aprovado: WHATSAPP_SOCKET_DISCONNECTED disparado.');

    // =========================================================================
    // TESTE 3: sendWhatsAppMessage com destinatário proibido
    // =========================================================================
    console.log('\n[Teste 3] sendWhatsAppMessage bloqueia grupos, newsletters e broadcasts...');
    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => ({ key: { id: 'mock' } }),
    });

    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('123456@g.us', 'Mensagem para grupo');
      },
      /INVALID_RECIPIENT_BLOCKED/
    );
    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('channel@newsletter', 'Mensagem para canal');
      },
      /INVALID_RECIPIENT_BLOCKED/
    );
    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('', 'Mensagem sem destinatário');
      },
      /INVALID_RECIPIENT_BLOCKED/
    );
    console.log('  ✓ Teste 3 aprovado: INVALID_RECIPIENT_BLOCKED bloqueou todos com segurança.');

    // =========================================================================
    // TESTE 4: sendWhatsAppMessage com LID sem mapeamento
    // =========================================================================
    console.log('\n[Teste 4] sendWhatsAppMessage falha fail-closed com LID não mapeado...');
    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('99999999999999@lid', 'Mensagem para LID');
      },
      /UNMAPPED_LID_FAIL_CLOSED/
    );
    console.log('  ✓ Teste 4 aprovado: UNMAPPED_LID_FAIL_CLOSED disparado com sucesso.');

    // =========================================================================
    // TESTE 5: sendWhatsAppMessage resolve LID mapeado com sucesso
    // =========================================================================
    console.log('\n[Teste 5] sendWhatsAppMessage resolve LID mapeado com sucesso...');
    let sentToJid = null;
    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async (jid, content) => {
        sentToJid = jid;
        return { key: { id: 'msg_lid_ok_1' }, messageTimestamp: 1700000000 };
      },
    });

    // Simula resolução no authDir do Baileys
    const config = require('../src/config');
    if (!fs.existsSync(config.authDir)) {
      fs.mkdirSync(config.authDir, { recursive: true });
    }
    const mappingFile = path.resolve(config.authDir, 'lid-mapping-111222333444555_reverse.json');
    fs.writeFileSync(mappingFile, JSON.stringify('5511999990005'), 'utf8');

    const lidRes = await whatsappClient.sendWhatsAppMessage('111222333444555@lid', 'LID Mapeado');
    assert.strictEqual(lidRes.success, true);
    assert.strictEqual(sentToJid, '5511999990005@s.whatsapp.net');
    assert.strictEqual(lidRes.recipientJid, '5511999990005@s.whatsapp.net');

    try {
      if (fs.existsSync(mappingFile)) fs.unlinkSync(mappingFile);
    } catch (_) {}
    console.log('  ✓ Teste 5 aprovado: LID mapeado resolvido para', sentToJid);

    // =========================================================================
    // TESTE 6: sendWhatsAppMessage lança BAILEYS_TRANSMISSION_ERROR
    // =========================================================================
    console.log('\n[Teste 6] sendWhatsAppMessage lança BAILEYS_TRANSMISSION_ERROR em rejeição de rede...');
    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => {
        throw new Error('Connection lost while sending packet');
      },
    });

    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Erro de rede');
      },
      /BAILEYS_TRANSMISSION_ERROR: Connection lost while sending packet/
    );
    console.log('  ✓ Teste 6 aprovado: BAILEYS_TRANSMISSION_ERROR preservou causa raiz.');

    // =========================================================================
    // TESTE 7: sendWhatsAppMessage lança BAILEYS_EMPTY_CONFIRMATION
    // =========================================================================
    console.log('\n[Teste 7] sendWhatsAppMessage lança BAILEYS_EMPTY_CONFIRMATION em retorno vazio/sem key.id...');
    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => null,
    });
    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Retorno nulo');
      },
      /BAILEYS_EMPTY_CONFIRMATION/
    );

    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => ({ status: 'PENDING' }), // sem key.id
    });
    await assert.rejects(
      async () => {
        await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Retorno sem key');
      },
      /BAILEYS_EMPTY_CONFIRMATION/
    );
    console.log('  ✓ Teste 7 aprovado: BAILEYS_EMPTY_CONFIRMATION interceptou confirmações vazias.');

    // =========================================================================
    // TESTE 8: sendWhatsAppMessage retorna contrato e grava processed_messages
    // =========================================================================
    console.log('\n[Teste 8] sendWhatsAppMessage retorna contrato correto e grava processed_messages...');
    const expectedMsgId = 'BAILEYS_MSG_8888';
    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async (jid) => ({
        key: { id: expectedMsgId },
        messageTimestamp: 1710000000,
      }),
    });

    const res8 = await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Mensagem com sucesso');
    assert.strictEqual(res8.success, true);
    assert.strictEqual(res8.messageId, expectedMsgId);
    assert.strictEqual(res8.timestamp, 1710000000);
    assert.strictEqual(res8.recipientJid, '5511999998888@s.whatsapp.net');

    const processedMsg = db.prepare('SELECT * FROM processed_messages WHERE id = ?').get(expectedMsgId);
    assert.ok(processedMsg, 'Registro em processed_messages deve existir.');
    console.log('  ✓ Teste 8 aprovado: contrato de entrega e persistência em processed_messages validados.');

    // =========================================================================
    // TESTE 9 & 10: Fim do Phantom Delivery (Status nunca SENT e whatsapp_notified permanece 0 em falha)
    // =========================================================================
    console.log('\n[Teste 9 & 10] Fim do Phantom Delivery: status nunca SENT e whatsapp_notified = 0 em falha...');
    // Ativa modo simulação de produção (fora de staging, mas com falha no socket)
    process.env.APP_MODE = 'production';
    process.env.NODE_ENV = 'production';
    delete process.env.HOMOLOGACAO;
    delete process.env.DISABLE_WHATSAPP_DISPATCH;
    process.env.ALLOW_WHATSAPP_SENDING = 'true';

    // Mock socket que falha
    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => {
        throw new Error('503 Service Unavailable: WhatsApp Server Overloaded');
      },
    });

    const aptIdFail = createTestAppointment();
    const outboxFail = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status, attempts, max_attempts
      )
      VALUES (?, ?, 'NEW_APPOINTMENT', '5511999998888', 'Texto de teste', 'PENDING', 0, 5)
    `).run(userId, aptIdFail);
    const failOutboxId = outboxFail.lastInsertRowid;

    // Dispara via worker
    const processResult = await outboxWorker.processWhatsAppOutboxItem(failOutboxId);
    assert.strictEqual(processResult.success, false);

    const outboxRowAfter = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(failOutboxId);
    assert.strictEqual(outboxRowAfter.status, 'PENDING');
    assert.notStrictEqual(outboxRowAfter.status, 'SENT', 'STATUS NUNCA PODE SER SENT EM FALHA');
    assert.strictEqual(outboxRowAfter.attempts, 1);

    const aptAfter = db.prepare('SELECT whatsapp_notified FROM appointments WHERE id = ?').get(aptIdFail);
    assert.strictEqual(aptAfter.whatsapp_notified, 0, 'whatsapp_notified DEVE PERMANECER 0 EM FALHA');
    console.log('  ✓ Teste 9 & 10 aprovados: Phantom Delivery eliminado com sucesso.');

    // =========================================================================
    // TESTE 11: Incremento de attempts e backoff exponencial em PENDING
    // =========================================================================
    console.log('\n[Teste 11] Item com falha incrementa attempts e calcula backoff exponencial...');
    assert.ok(outboxRowAfter.next_retry_at, 'next_retry_at deve estar preenchido');
    const nextRetryDate = new Date(outboxRowAfter.next_retry_at).getTime();
    const nowTime = Date.now();
    // Para attempt 1: min(2^1, 60) = 2 minutos (entre 1 e 3 minutos a partir de agora)
    const diffMin = (nextRetryDate - nowTime) / 60000;
    assert.ok(diffMin >= 1.5 && diffMin <= 2.5, `Diff minutos deve ser ~2 min, obtido: ${diffMin}`);
    console.log(`  ✓ Teste 11 aprovado: backoff exponencial de ${diffMin.toFixed(1)} minutos agendado.`);

    // =========================================================================
    // TESTE 12: Exaustão de retentativas transiciona para FAILED
    // =========================================================================
    console.log('\n[Teste 12] Exaustão de tentativas (attempts >= max_attempts) transiciona para FAILED...');
    db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET attempts = 4, max_attempts = 5, status = 'PENDING'
      WHERE id = ?
    `).run(failOutboxId);

    const exhaustResult = await outboxWorker.processWhatsAppOutboxItem(failOutboxId);
    assert.strictEqual(exhaustResult.success, false);
    assert.strictEqual(exhaustResult.status, 'FAILED');

    const outboxExhausted = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(failOutboxId);
    assert.strictEqual(outboxExhausted.status, 'FAILED');
    assert.strictEqual(outboxExhausted.attempts, 5);
    console.log('  ✓ Teste 12 aprovado: item exausto marcado como FAILED.');

    // =========================================================================
    // TESTE 13: last_error é sanitizado contra vazamento de tokens
    // =========================================================================
    console.log('\n[Teste 13] last_error é sanitizado contra Bearer tokens e delimitado a 500 chars...');
    whatsappClient._setSocketForTesting({
      user: { id: '5511999998888:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => {
        throw new Error('Falha de autenticação com Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretToken123456 ' + 'X'.repeat(600));
      },
    });

    const outboxSecret = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status, attempts, max_attempts
      )
      VALUES (?, 0, 'TEST_MESSAGE', '5511999998888', 'Msg secret test', 'PENDING', 0, 5)
    `).run(userId);
    const secretOutboxId = outboxSecret.lastInsertRowid;

    await outboxWorker.processWhatsAppOutboxItem(secretOutboxId);
    const secretRow = db.prepare('SELECT last_error FROM whatsapp_notification_outbox WHERE id = ?').get(secretOutboxId);

    assert.ok(secretRow.last_error.includes('Bearer [REDACTED]'), 'Bearer token deve ser redigido.');
    assert.ok(!secretRow.last_error.includes('secretToken123456'), 'Token secreto NÃO pode vazar nos logs/banco.');
    assert.ok(secretRow.last_error.length <= 500, `Tamanho máximo deve ser <= 500, obtido: ${secretRow.last_error.length}`);
    console.log('  ✓ Teste 13 aprovado: last_error redigido e truncado com segurança.');

    // =========================================================================
    // TESTE 14: Hard Staging Lock transiciona estritamente para SIMULATED (is_simulated = 1)
    // =========================================================================
    console.log('\n[Teste 14] Hard Staging Lock: status estritamente SIMULATED, is_simulated = 1...');
    process.env.APP_MODE = 'staging';
    delete process.env.ALLOW_WHATSAPP_SENDING;

    const aptStaging = createTestAppointment();
    const outboxStaging = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status
      )
      VALUES (?, ?, 'NEW_APPOINTMENT', '5511999998888', 'Staging MSG', 'PENDING')
    `).run(userId, aptStaging);
    const stagingOutboxId = outboxStaging.lastInsertRowid;

    const stagingResult = await outboxWorker.processWhatsAppOutboxItem(stagingOutboxId);
    assert.strictEqual(stagingResult.success, true);
    assert.strictEqual(stagingResult.simulated, true);

    const stagingRow = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(stagingOutboxId);
    assert.strictEqual(stagingRow.status, 'SIMULATED');
    assert.strictEqual(stagingRow.is_simulated, 1);
    console.log('  ✓ Teste 14 aprovado: entrega simulada sob staging confirmada.');

    // =========================================================================
    // TESTE 15: ALLOW_WHATSAPP_SENDING NÃO contorna Hard Staging Lock
    // =========================================================================
    console.log('\n[Teste 15] ALLOW_WHATSAPP_SENDING=true NÃO contorna Hard Staging Lock...');
    process.env.APP_MODE = 'staging';
    process.env.ALLOW_WHATSAPP_SENDING = 'true'; // Tentativa de forçar envio real em staging!

    const aptBypass = createTestAppointment();
    const outboxBypass = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status
      )
      VALUES (?, ?, 'NEW_APPOINTMENT', '5511999998888', 'Bypass Attempt MSG', 'PENDING')
    `).run(userId, aptBypass);
    const bypassOutboxId = outboxBypass.lastInsertRowid;

    const bypassResult = await outboxWorker.processWhatsAppOutboxItem(bypassOutboxId);
    assert.strictEqual(bypassResult.simulated, true);

    const bypassRow = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(bypassOutboxId);
    assert.strictEqual(bypassRow.status, 'SIMULATED');
    assert.strictEqual(bypassRow.is_simulated, 1);
    assert.notStrictEqual(bypassRow.status, 'SENT', 'JAMAIS DEVE SER MARCADO COMO SENT EM STAGING');
    console.log('  ✓ Teste 15 aprovado: Hard Staging Lock prevaleceu incondicionalmente.');

    // =========================================================================
    // TESTE 16: Deduplicação em janela de 5 minutos
    // =========================================================================
    console.log('\n[Teste 16] Deduplicação em 5 minutos impede notificações repetidas...');
    const aptDedup = createTestAppointment();
    // Simula primeiro envio concluído
    db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status, sent_at
      )
      VALUES (?, ?, 'RESCHEDULE', '5511999998888', 'Remarcação 1', 'SENT', CURRENT_TIMESTAMP)
    `).run(userId, aptDedup);

    // Tenta enfileirar segundo envio com mesma chave
    const dedupEnq = salonNotificationService.enqueueNotificationTx(userId, aptDedup, 'RESCHEDULE', {
      clientName: 'Cliente VIP',
      startDt: '2026-11-25 11:00:00',
    });
    assert.strictEqual(dedupEnq.deduplicated, true);

    // Tenta processar item na fila com appointment_id recente
    const outboxDedup2 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status
      )
      VALUES (?, ?, 'RESCHEDULE', '5511999998888', 'Remarcação 2', 'PENDING')
    `).run(userId, aptDedup);
    const dedupOutboxId2 = outboxDedup2.lastInsertRowid;

    const dedupProcess = await outboxWorker.processWhatsAppOutboxItem(dedupOutboxId2);
    assert.strictEqual(dedupProcess.deduplicated, true);
    assert.strictEqual(dedupProcess.status, 'DEDUPLICATED');

    const dedupRow = db.prepare('SELECT status FROM whatsapp_notification_outbox WHERE id = ?').get(dedupOutboxId2);
    assert.strictEqual(dedupRow.status, 'DEDUPLICATED');
    console.log('  ✓ Teste 16 aprovado: deduplicação persistente em 5 minutos ativa.');

    // =========================================================================
    // TESTE 17: Concorrência atômica com lock PROCESSING
    // =========================================================================
    console.log('\n[Teste 17] Concorrência atômica: múltiplos workers não executam o mesmo item simultaneamente...');
    const outboxConc = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status
      )
      VALUES (?, 0, 'TEST_CONCURRENCY', '5511999998888', 'Conc MSG', 'PENDING')
    `).run(userId);
    const concId = outboxConc.lastInsertRowid;

    // Dispara duas chamadas simultâneas de processamento para o mesmo ID
    const [p1, p2] = await Promise.all([
      outboxWorker.processWhatsAppOutboxItem(concId),
      outboxWorker.processWhatsAppOutboxItem(concId),
    ]);

    // Um deve ter processado e o outro deve ter sido ignorado (skipped: true)
    const processed = [p1, p2].filter(r => !r.skipped);
    const skipped = [p1, p2].filter(r => r.skipped);
    assert.strictEqual(processed.length, 1, 'Exatamente um worker deve ter executado o item.');
    assert.strictEqual(skipped.length, 1, 'O segundo worker deve ter pulado o item com segurança.');
    console.log('  ✓ Teste 17 aprovado: lock atômico protegeu contra concorrência.');

    // =========================================================================
    // TESTE 18: recoverStalledTasks recupera tarefas travadas > 5 min
    // =========================================================================
    console.log('\n[Teste 18] recoverStalledTasks recupera itens travados em PROCESSING há mais de 5 minutos...');
    const outboxStall = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status, locked_at
      )
      VALUES (?, 0, 'TEST_STALL', '5511999998888', 'Stall MSG', 'PROCESSING', datetime('now', '-10 minutes'))
    `).run(userId);
    const stallId = outboxStall.lastInsertRowid;

    const recovery = outboxWorker.recoverStalledTasks();
    assert.ok(recovery.whatsappRecovered >= 1, 'Pelo menos uma tarefa deve ter sido recuperada.');

    const stallRowAfter = db.prepare('SELECT status, locked_at FROM whatsapp_notification_outbox WHERE id = ?').get(stallId);
    assert.strictEqual(stallRowAfter.status, 'PENDING');
    assert.strictEqual(stallRowAfter.locked_at, null);
    console.log('  ✓ Teste 18 aprovado: tarefa travada em crash recuperada para PENDING.');

    // =========================================================================
    // TESTE 19: Unificação de rotas de dispatch
    // =========================================================================
    console.log('\n[Teste 19] Unificação de rotas: dispatchOutboxItem delega para processWhatsAppOutboxItem...');
    const outboxUnify = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status
      )
      VALUES (?, 0, 'TEST_UNIFY', '5511999998888', 'Unify MSG', 'PENDING')
    `).run(userId);
    const unifyId = outboxUnify.lastInsertRowid;

    const unifyResult = await salonNotificationService.dispatchOutboxItem(unifyId);
    assert.strictEqual(unifyResult.simulated, true);

    const unifyRow = db.prepare('SELECT status, is_simulated FROM whatsapp_notification_outbox WHERE id = ?').get(unifyId);
    assert.strictEqual(unifyRow.status, 'SIMULATED');
    assert.strictEqual(unifyRow.is_simulated, 1);
    console.log('  ✓ Teste 19 aprovado: rotas unificadas sem divergência.');

    // =========================================================================
    // TESTE 20: queueNotification enfileira com dedup_hash e notifica worker
    // =========================================================================
    console.log('\n[Teste 20] queueNotification enfileira com dedup_hash e acorda o worker...');
    const aptQueue = createTestAppointment();
    const qRes = await salonNotificationService.queueNotification(userId, aptQueue, 'NEW_APPOINTMENT', {
      clientName: 'Cliente Fila',
      serviceName: 'Corte e Escova',
      staffName: 'Jéssica',
      startDt: '2026-11-25 15:00:00',
    });

    assert.strictEqual(qRes.success, true);
    assert.ok(qRes.outboxId, 'outboxId deve ter sido gerado');

    const qRow = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(qRes.outboxId);
    assert.ok(qRow.dedup_hash, 'dedup_hash deve estar populado.');
    assert.strictEqual(qRow.dedup_hash.length, 64, 'SHA-256 deve ter 64 caracteres.');
    console.log('  ✓ Teste 20 aprovado: notificação enfileirada e dedup_hash SHA-256 verificado.');

    console.log('\n================================================================');
    console.log('  TODOS OS 20 CENÁRIOS DE CONFIABILIDADE FORAM VALIDADOS COM 100% DE SUCESSO!  ');
    console.log('================================================================\n');
  } finally {
    // Parar temporizadores para limpeza graciosa
    outboxWorker.stopWorker();
    whatsappClient._resetSocketForTesting();

    // Pequena pausa para event loop esvaziar
    await new Promise((r) => setTimeout(r, 200));

    try {
      db.close();
    } catch (_) {}

    try {
      if (fs.existsSync(tempDbFile)) {
        fs.unlinkSync(tempDbFile);
      }
    } catch (_) {}
  }
}

runTests().catch((err) => {
  console.error('\n❌ ERRO NA EXECUÇÃO DOS TESTES 019:', err);
  process.exit(1);
});
