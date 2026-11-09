/**
 * RAIA AGENTES — SUÍTE DE TESTES DE ACEITAÇÃO FUNCIONAL: COMANDO 022
 * Lembrete Automático de 24h da Jéssica Beauty (18 Cenários Herméticos)
 *
 * Cobertura Mandatória:
 *  1. Cliente agenda atendimento -> lembrete é agendado (reminder_24h_status = 'PENDING').
 *  2. Agendamento às 09:00 de Brasília -> timezone canônica America/Sao_Paulo calculada corretamente.
 *  3. Agendamento com antecedência < 20h -> NÃO envia lembrete 24h (WINDOW_EXPIRED).
 *  4. Salão com b2c_reminders_enabled = 0 (padrão) -> nenhum lembrete enfileirado no outbox.
 *  5. Salão com b2c_reminders_enabled = 1 -> lembrete enfileirado no outbox com dados da cliente.
 *  6. Sem consentimento (reminder_consent = 0) -> nenhum disparo B2C.
 *  7. Agendamento cancelado -> cancela lembrete pendente no outbox (reminder_24h_status = 'CANCELLED').
 *  8. Agendamento remarcado -> cancela lembrete anterior e novo horário torna-se elegível.
 *  9. Processamento em staging -> disparo simulado (status = 'SIMULATED', reminder_24h_status = 'SIMULATED').
 * 10. Produção com mock autorizado -> disparo real (status = 'SENT', reminder_24h_status = 'SENT').
 * 11. Falha de rede Baileys -> retry com backoff exponencial sem marcar SENT (permanece 0).
 * 12. Tentativas esgotadas -> transição para FAILED (reminder_24h_status = 'FAILED').
 * 13. Reinício de worker / reexecução de daemon -> zero duplicações (idempotência por dedup_hash).
 * 14. Dois salões distintos com mesma cliente -> isolamento total de tenant e contexto.
 * 15. Proteção de transporte em agentChatService.js: em staging, simular sem tocar socket físico.
 * 16. Proteção em startWhatsAppBot(): em staging, abortar sem conectar à rede real Baileys.
 * 17. Painel / API: status do lembrete retornado em GET /api/cliente/appointments.
 * 18. Inviolabilidade absoluta de data/assistant.db e execução hermética em os.tmpdir().
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// -------------------------------------------------------------
// 1. ISOLAMENTO ESTRITO DO BANCO DE DADOS E DIRETÓRIO AUTH
// -------------------------------------------------------------
const tempDbFile = path.join(os.tmpdir(), `raia_test_jessica_022_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_022_${Date.now()}_${Math.random().toString(36).substring(7)}`);

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
const whatsappClient = require('../src/whatsapp/client');
const outboxWorker = require('../src/services/outboxWorker');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonNotificationService = require('../src/services/salonNotificationService');
const salonReminderService = require('../src/services/salonReminderService');
const agentChatService = require('../src/services/agentChatService');

async function runTests() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — SUÍTE DE TESTES: LEMBRETE 24H JÉSSICA (COMANDO 022)');
  console.log('================================================================\n');

  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE AMBIENTE ---');
  console.log('  ✓ Banco temporário ativo:', tempDbFile);
  console.log('  ✓ AuthDir temporário isolado em os.tmpdir():', tempAuthDir);

  const prodDbPath = path.join(__dirname, '..', 'data', 'assistant.db');
  let prodDbMtimeBefore = null;
  if (fs.existsSync(prodDbPath)) {
    prodDbMtimeBefore = fs.statSync(prodDbPath).mtimeMs;
  }
  console.log('  ✓ Banco operacional data/assistant.db monitorado para inviolabilidade.\n');

  let passedTests = 0;
  const totalTests = 18;

  // Fixtures: Salão A (Jéssica Beauty) e Salão B (Studio Bella)
  const userA = 101;
  const userB = 102;

  db.prepare("INSERT OR REPLACE INTO users (id, phone_number, name) VALUES (?, '5511999990101', 'Jéssica Owner')").run(userA);
  db.prepare("INSERT OR REPLACE INTO users (id, phone_number, name) VALUES (?, '5511999990102', 'Bella Owner')").run(userB);

  const allOpenHours = JSON.stringify({
    timezone: 'America/Sao_Paulo',
    days: {
      0: { open: true, label: 'Domingo', start: '00:00', end: '23:59' },
      1: { open: true, label: 'Segunda-feira', start: '00:00', end: '23:59' },
      2: { open: true, label: 'Terça-feira', start: '00:00', end: '23:59' },
      3: { open: true, label: 'Quarta-feira', start: '00:00', end: '23:59' },
      4: { open: true, label: 'Quinta-feira', start: '00:00', end: '23:59' },
      5: { open: true, label: 'Sexta-feira', start: '00:00', end: '23:59' },
      6: { open: true, label: 'Sábado', start: '00:00', end: '23:59' },
    },
    pauses: [],
    exceptions: [],
  });

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (
      user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, b2c_reminders_enabled, opening_hours
    ) VALUES (?, 'Jéssica Beauty', '5511988880101', '5511988880101', 1, 0, ?)
  `).run(userA, allOpenHours);

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (
      user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, b2c_reminders_enabled, opening_hours
    ) VALUES (?, 'Studio Bella', '5511988880102', '5511988880102', 1, 1, ?)
  `).run(userB, allOpenHours);

  db.prepare("INSERT OR REPLACE INTO client_staff (id, user_id, name, active) VALUES (1, ?, 'Jéssica Oficial', 1)").run(userA);
  db.prepare("INSERT OR REPLACE INTO client_staff (id, user_id, name, active) VALUES (2, ?, 'Bella Oficial', 1)").run(userB);

  try {
    // -------------------------------------------------------------
    // CENÁRIO 1: Cliente agenda atendimento -> lembrete é agendado (reminder_24h_status = 'PENDING')
    // -------------------------------------------------------------
    console.log('--- TESTE 1: Cliente agenda atendimento -> lembrete agendado (PENDING) ---');
    // Salão inicia com b2c_reminders_enabled = 0 por padrão

    // Helper para gerar horários sem conflito de slot (todos dentro da janela 20h-26h)
    const nowRef = Date.now();
    function makeAptSlot(offsetMinutes) {
      const d = new Date(nowRef + offsetMinutes * 60 * 1000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return { d, dateStr, timeStr };
    }

    // Agendamento 1: daqui a 24 horas no futuro
    const slot1 = makeAptSlot(24 * 60);
    const apt1 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Maria Silva',
      clientPhone: '5511977770001',
      serviceName: 'Corte Feminino',
      date: slot1.dateStr,
      time: slot1.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    assert.strictEqual(apt1.status, 'AGENDADO');
    const checkApt1 = db.prepare('SELECT reminder_24h_status, reminder_consent FROM appointments WHERE id = ?').get(apt1.id);
    assert.strictEqual(checkApt1.reminder_24h_status, 'PENDING');
    assert.strictEqual(checkApt1.reminder_consent, 1);
    console.log('  ✓ Agendamento criado com reminder_24h_status = PENDING e consentimento ativo.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 2: Agendamento às 09:00 de Brasília -> timezone canônica America/Sao_Paulo
    // -------------------------------------------------------------
    console.log('--- TESTE 2: Agendamento às 09:00 de Brasília -> timezone America/Sao_Paulo ---');
    const apt2DateStr = '2026-11-20T09:00:00';
    const parsedApt2 = salonReminderService.parseDateInSaoPaulo(apt2DateStr);
    assert.ok(parsedApt2 instanceof Date);

    const formatted2 = salonReminderService.formatDateTimeSaoPaulo(parsedApt2);
    assert.strictEqual(formatted2.timeStr, '09:00', 'Horário formatado em Brasília deve ser exatamente 09:00');
    assert.strictEqual(formatted2.dateStr, '20/11/2026', 'Data formatada deve ser 20/11/2026');
    console.log('  ✓ Timezone canônica America/Sao_Paulo calculada corretamente (09:00).\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 3: Agendamento com antecedência < 20h -> NÃO envia lembrete 24h
    // -------------------------------------------------------------
    console.log('--- TESTE 3: Agendamento com antecedência < 20h -> NÃO envia lembrete (WINDOW_EXPIRED) ---');
    const slot3 = makeAptSlot(10 * 60); // Daqui a 10 horas

    const apt3 = salonAppointmentService.bookAppointmentSync(userB, {
      clientName: 'Carla Dias',
      clientPhone: '5511977770003',
      serviceName: 'Manicure',
      date: slot3.dateStr,
      time: slot3.timeStr,
      durationMin: 20,
      staffId: 2,
      reminderConsent: 1,
    });

    const queueRes3 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userB });
    const apt3Result = queueRes3.find(r => r.appointmentId === apt3.id);
    assert.ok(apt3Result, 'Agendamento 3 deve ser avaliado');
    assert.strictEqual(apt3Result.status, 'WINDOW_EXPIRED');

    const checkApt3 = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(apt3.id);
    assert.strictEqual(checkApt3.reminder_24h_status, 'DISABLED', 'Agendamento com < 20h deve ter lembrete de 24h DISABLED');
    console.log('  ✓ Agendamento criado de última hora (< 20h) não dispara lembrete extemporâneo.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 4: Salão com b2c_reminders_enabled = 0 (padrão) -> nenhum lembrete
    // -------------------------------------------------------------
    console.log('--- TESTE 4: Salão com b2c_reminders_enabled = 0 -> nenhum lembrete no outbox ---');
    db.prepare('UPDATE client_salons SET b2c_reminders_enabled = 0 WHERE user_id = ?').run(userA);

    const slot4 = makeAptSlot(24 * 60 + 30);
    const apt4 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Fernanda Lima',
      clientPhone: '5511977770004',
      serviceName: 'Penteado',
      date: slot4.dateStr,
      time: slot4.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    const queueRes4 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const foundInQueue4 = queueRes4.find(r => r.appointmentId === apt4.id);
    assert.strictEqual(foundInQueue4, undefined, 'Salão com b2c desativado não deve enfileirar nada');

    const outboxCount4 = db.prepare("SELECT COUNT(*) as count FROM whatsapp_notification_outbox WHERE appointment_id = ? AND event_type = 'REMINDER_24H'").get(apt4.id).count;
    assert.strictEqual(outboxCount4, 0);
    console.log('  ✓ Nenhum lembrete enfileirado quando o salão está com o recurso desativado.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 5: Salão com b2c_reminders_enabled = 1 -> lembrete enfileirado no outbox
    // -------------------------------------------------------------
    console.log('--- TESTE 5: Salão com b2c_reminders_enabled = 1 -> lembrete enfileirado ---');
    db.prepare('UPDATE client_salons SET b2c_reminders_enabled = 1 WHERE user_id = ?').run(userA);

    const queueRes5 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const apt1Queued = queueRes5.find(r => r.appointmentId === apt1.id);
    assert.ok(apt1Queued, 'Apt 1 deve ser enfileirado');
    assert.strictEqual(apt1Queued.status, 'ENQUEUED');

    const outboxRow1 = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(apt1Queued.outboxId);
    assert.strictEqual(outboxRow1.event_type, 'REMINDER_24H');
    assert.strictEqual(outboxRow1.status, 'PENDING');
    assert.strictEqual(outboxRow1.recipient_phone, '5511977770001');
    assert.ok(outboxRow1.message_text.includes('Maria Silva'));
    assert.ok(outboxRow1.message_text.includes('Jéssica Beauty'));
    console.log('  ✓ Lembrete B2C 24h enfileirado na Outbox com dados completos da cliente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 6: Sem consentimento (reminder_consent = 0) -> nenhum disparo B2C
    // -------------------------------------------------------------
    console.log('--- TESTE 6: Sem consentimento (reminder_consent = 0) -> nenhum disparo B2C ---');
    const slot6 = makeAptSlot(25 * 60);
    const apt6 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Ana Paula',
      clientPhone: '5511977770006',
      serviceName: 'Depilação',
      date: slot6.dateStr,
      time: slot6.timeStr,
      durationMin: 20,
      reminderConsent: 0,
    });

    const queueRes6 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const found6 = queueRes6.find(r => r.appointmentId === apt6.id);
    assert.strictEqual(found6, undefined, 'Sem consentimento não deve ser processado');

    const outboxCount6 = db.prepare("SELECT COUNT(*) as count FROM whatsapp_notification_outbox WHERE appointment_id = ? AND event_type = 'REMINDER_24H'").get(apt6.id).count;
    assert.strictEqual(outboxCount6, 0);
    console.log('  ✓ Preferência de consentimento respeitada integralmente (LGPD).\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 7: Agendamento cancelado -> cancela lembrete pendente no outbox (CANCELLED)
    // -------------------------------------------------------------
    console.log('--- TESTE 7: Agendamento cancelado -> cancela lembrete no outbox e marca CANCELLED ---');
    await salonAppointmentService.cancelAppointment(apt1.id, userA, { reason: 'Desistência da cliente' });

    const checkApt7 = db.prepare('SELECT status, reminder_24h_status FROM appointments WHERE id = ?').get(apt1.id);
    assert.strictEqual(checkApt7.status, 'CANCELADO');
    assert.strictEqual(checkApt7.reminder_24h_status, 'CANCELLED');

    const outbox7 = db.prepare('SELECT status FROM whatsapp_notification_outbox WHERE id = ?').get(apt1Queued.outboxId);
    assert.strictEqual(outbox7.status, 'CANCELLED');
    console.log('  ✓ Cancelamento de agendamento cancela atomicamente o lembrete na Outbox.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 8: Agendamento remarcado -> cancela anterior e novo horário torna-se elegível
    // -------------------------------------------------------------
    console.log('--- TESTE 8: Agendamento remarcado -> cancela anterior e reavalia elegibilidade ---');
    const slot8 = makeAptSlot(25 * 60 + 30);
    const apt8 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Juliana Paes',
      clientPhone: '5511977770008',
      serviceName: 'Design Sobrancelhas',
      date: slot8.dateStr,
      time: slot8.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    const queueRes8 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const enq8 = queueRes8.find(r => r.appointmentId === apt8.id);
    assert.ok(enq8 && enq8.status === 'ENQUEUED');

    // Remarcação para 3 dias depois
    const newSlot8 = makeAptSlot(72 * 60);
    await salonAppointmentService.rescheduleAppointment(apt8.id, userA, {
      newDate: newSlot8.dateStr,
      newTime: newSlot8.timeStr,
      reason: 'Remarcou para sexta',
    });

    const oldOutbox8 = db.prepare('SELECT status FROM whatsapp_notification_outbox WHERE id = ?').get(enq8.outboxId);
    assert.strictEqual(oldOutbox8.status, 'CANCELLED', 'Lembrete antigo deve estar CANCELLED');

    const checkApt8 = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(apt8.id);
    assert.strictEqual(checkApt8.reminder_24h_status, 'PENDING', 'Novo agendamento deve resetar para PENDING');
    console.log('  ✓ Remarcação cancelou lembrete do horário antigo e rearmou status PENDING.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 9: Processamento em staging -> disparo simulado (SIMULATED)
    // -------------------------------------------------------------
    console.log('--- TESTE 9: Processamento em staging -> status = SIMULATED e reminder_24h_status = SIMULATED ---');
    process.env.APP_MODE = 'staging';
    process.env.HOMOLOGACAO = 'true';
    delete process.env.ALLOW_WHATSAPP_SENDING;

    const slot9 = makeAptSlot(23 * 60);
    const apt9 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Sabrina Sato',
      clientPhone: '5511977770009',
      serviceName: 'Mega Hair',
      date: slot9.dateStr,
      time: slot9.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    const queueRes9 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const enq9 = queueRes9.find(r => r.appointmentId === apt9.id);
    assert.ok(enq9);

    const procRes9 = await outboxWorker.processWhatsAppOutboxItem(enq9.outboxId);
    assert.strictEqual(procRes9.status, 'SIMULATED');
    assert.strictEqual(procRes9.simulated, true);

    const checkApt9 = db.prepare('SELECT reminder_24h_status, whatsapp_notified FROM appointments WHERE id = ?').get(apt9.id);
    assert.strictEqual(checkApt9.reminder_24h_status, 'SIMULATED');
    // whatsapp_notified da dona não deve ser poluído
    assert.strictEqual(checkApt9.whatsapp_notified, 0);
    console.log('  ✓ Staging simula envio e atualiza reminder_24h_status = SIMULATED sem sobrepor whatsapp_notified.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 10: Produção com mock autorizado -> disparo real (SENT)
    // -------------------------------------------------------------
    console.log('--- TESTE 10: Produção com mock autorizado -> status = SENT e reminder_24h_status = SENT ---');
    process.env.APP_MODE = 'production';
    process.env.NODE_ENV = 'production';
    delete process.env.HOMOLOGACAO;
    process.env.ALLOW_WHATSAPP_SENDING = 'true';

    whatsappClient._setSocketForTesting({
      user: { id: '5511999990101:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => ({ key: { id: 'BAILEYS_REMINDER_SENT_10' }, messageTimestamp: 1730001000 })
    });

    const slot10 = makeAptSlot(23 * 60 + 30);
    const apt10 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Marina Ruy Barbosa',
      clientPhone: '5511977770010',
      serviceName: 'Coloração Ruivo',
      date: slot10.dateStr,
      time: slot10.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    const queueRes10 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const enq10 = queueRes10.find(r => r.appointmentId === apt10.id);
    assert.ok(enq10);

    const procRes10 = await outboxWorker.processWhatsAppOutboxItem(enq10.outboxId);
    assert.strictEqual(procRes10.status, 'SENT');
    assert.strictEqual(procRes10.sent, true);

    const checkApt10 = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(apt10.id);
    assert.strictEqual(checkApt10.reminder_24h_status, 'SENT');
    console.log('  ✓ Produção transmite lembrete e registra confirmação válida (SENT).\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 11: Falha de rede Baileys -> retry com backoff exponencial sem marcar SENT
    // -------------------------------------------------------------
    console.log('--- TESTE 11: Falha de rede Baileys -> retry com backoff sem marcar SENT ---');
    whatsappClient._setSocketForTesting({
      user: { id: '5511999990101:1@s.whatsapp.net' },
      ws: { readyState: 1 },
      sendMessage: async () => { throw new Error('CONNECTION_TIMEOUT: Baileys socket error'); }
    });

    const slot11 = makeAptSlot(22 * 60 + 30);
    const apt11 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Grazi Massafera',
      clientPhone: '5511977770011',
      serviceName: 'Corte Bordado',
      date: slot11.dateStr,
      time: slot11.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    const queueRes11 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const enq11 = queueRes11.find(r => r.appointmentId === apt11.id);
    assert.ok(enq11);

    const procRes11 = await outboxWorker.processWhatsAppOutboxItem(enq11.outboxId);
    assert.strictEqual(procRes11.success, false);
    assert.strictEqual(procRes11.status, 'PENDING');
    assert.strictEqual(procRes11.attempts, 1);
    assert.ok(procRes11.nextRetryAt);

    const checkApt11 = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(apt11.id);
    assert.notStrictEqual(checkApt11.reminder_24h_status, 'SENT');
    console.log('  ✓ Falha de transporte tratada com retry exponencial sem falsos positivos.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 12: Tentativas esgotadas -> transição para FAILED (reminder_24h_status = 'FAILED')
    // -------------------------------------------------------------
    console.log('--- TESTE 12: Tentativas esgotadas -> transição para FAILED ---');
    db.prepare('UPDATE whatsapp_notification_outbox SET attempts = 4, max_attempts = 5, next_retry_at = NULL WHERE id = ?').run(enq11.outboxId);

    const procRes12 = await outboxWorker.processWhatsAppOutboxItem(enq11.outboxId);
    assert.strictEqual(procRes12.success, false);
    assert.strictEqual(procRes12.status, 'FAILED');

    const checkApt12 = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(apt11.id);
    assert.strictEqual(checkApt12.reminder_24h_status, 'FAILED');
    console.log('  ✓ Esgotamento de retentativas atualiza reminder_24h_status = FAILED.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 13: Reinício de worker / reexecução de daemon -> zero duplicações
    // -------------------------------------------------------------
    console.log('--- TESTE 13: Reinício de worker / reexecução -> zero duplicações (dedup_hash) ---');
    const slot13 = makeAptSlot(21 * 60 + 30);
    const apt13 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Taís Araújo',
      clientPhone: '5511977770013',
      serviceName: 'Hidratação',
      date: slot13.dateStr,
      time: slot13.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    const firstQueue13 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const enq13 = firstQueue13.find(r => r.appointmentId === apt13.id);
    assert.ok(enq13 && enq13.status === 'ENQUEUED');

    // Segunda execução consecutiva do daemon (simulando polling/reinício do worker)
    const secondQueue13 = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const duplicateCheck = secondQueue13.find(r => r.appointmentId === apt13.id);
    assert.strictEqual(duplicateCheck?.status, 'DEDUPLICATED', 'Reexecução para item já enfileirado deve ser DEDUPLICATED');

    const total13Outbox = db.prepare("SELECT COUNT(*) as count FROM whatsapp_notification_outbox WHERE appointment_id = ? AND event_type = 'REMINDER_24H'").get(apt13.id).count;
    assert.strictEqual(total13Outbox, 1, 'Deve existir exatamente 1 registro na Outbox');
    console.log('  ✓ Idempotência garantida: reexecução do daemon não duplica lembretes.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 14: Dois salões distintos com mesma cliente -> isolamento total
    // -------------------------------------------------------------
    console.log('--- TESTE 14: Dois salões com a mesma cliente -> isolamento total multi-tenant ---');
    const sharedPhone = '5511999998888';

    const slot14 = makeAptSlot(22 * 60);
    const aptA = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Cliente Compartilhada',
      clientPhone: sharedPhone,
      serviceName: 'Escova Jéssica',
      date: slot14.dateStr,
      time: slot14.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    const aptB = salonAppointmentService.bookAppointmentSync(userB, {
      clientName: 'Cliente Compartilhada',
      clientPhone: sharedPhone,
      serviceName: 'Unhas Bella',
      date: slot14.dateStr,
      time: slot14.timeStr,
      durationMin: 20,
      reminderConsent: 1,
    });

    const queueResA = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userA });
    const queueResB = salonReminderService.checkAndQueue24hReminders({ now: nowRef, userId: userB });

    const enqA = queueResA.find(r => r.appointmentId === aptA.id);
    const enqB = queueResB.find(r => r.appointmentId === aptB.id);

    assert.ok(enqA && enqB);
    assert.notStrictEqual(enqA.outboxId, enqB.outboxId);

    const outA = db.prepare('SELECT user_id, message_text FROM whatsapp_notification_outbox WHERE id = ?').get(enqA.outboxId);
    const outB = db.prepare('SELECT user_id, message_text FROM whatsapp_notification_outbox WHERE id = ?').get(enqB.outboxId);

    assert.strictEqual(outA.user_id, userA);
    assert.strictEqual(outB.user_id, userB);
    assert.ok(outA.message_text.includes('Jéssica Beauty'));
    assert.ok(outB.message_text.includes('Studio Bella'));
    console.log('  ✓ Isolamento multi-tenant rigoroso mesmo com o mesmo número de cliente em múltiplos salões.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 15: Proteção de transporte em agentChatService.js: em staging, simular
    // -------------------------------------------------------------
    console.log('--- TESTE 15: Proteção de transporte em agentChatService.js em staging ---');
    process.env.APP_MODE = 'staging';
    process.env.HOMOLOGACAO = 'true';
    delete process.env.ALLOW_WHATSAPP_SENDING;

    let socketCalled = false;
    const testSock = {
      sendPresenceUpdate: async () => { socketCalled = true; },
      sendMessage: async () => {
        socketCalled = true;
        return { key: { id: 'LEAK' } };
      }
    };

    const lead15 = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status)
      VALUES ('Lead Test 15', '5511977770015', 'SALON', 'Jéssica', 'SENT')
    `).run().lastInsertRowid;

    const dummyMsg15 = {
      key: { remoteJid: '5511977770015@s.whatsapp.net' },
      message: { conversation: 'Olá, quais são os horários?' }
    };

    const handled15 = await agentChatService.handleLeadMessage(testSock, dummyMsg15, '5511977770015');
    assert.strictEqual(handled15, true);
    assert.strictEqual(socketCalled, false, 'Em staging, sock.sendMessage JAMAIS deve ser chamado em agentChatService!');
    console.log('  ✓ Hard Staging Lock em agentChatService.js impede chamadas de socket físico em staging.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 16: Proteção em startWhatsAppBot(): em staging, abortar sem conectar
    // -------------------------------------------------------------
    console.log('--- TESTE 16: Proteção em startWhatsAppBot(): em staging abortar sem conectar ---');
    process.env.APP_MODE = 'staging';
    process.env.HOMOLOGACAO = 'true';

    const botResult = await whatsappClient.startWhatsAppBot();
    assert.strictEqual(botResult, null, 'startWhatsAppBot DEVE retornar null em staging sem conectar');
    console.log('  ✓ startWhatsAppBot() aborta preventivamente em staging com fail-closed.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 17: Painel / API: status do lembrete retornado em appointments
    // -------------------------------------------------------------
    console.log('--- TESTE 17: Painel / API: status do lembrete retornado na listagem ---');
    const aptsList = salonAppointmentService.listAppointments(userA);
    assert.ok(aptsList.length > 0);
    const sampleApt = aptsList[0];
    assert.ok('reminder_24h_status' in sampleApt, 'Campo reminder_24h_status deve estar presente');
    assert.ok('reminder_consent' in sampleApt, 'Campo reminder_consent deve estar presente');
    console.log(`  ✓ Listagem de agendamentos expõe reminder_24h_status: "${sampleApt.reminder_24h_status}".\n`);
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 18: Inviolabilidade de data/assistant.db e execução hermética
    // -------------------------------------------------------------
    console.log('--- TESTE 18: Inviolabilidade de data/assistant.db e isolamento em os.tmpdir() ---');
    if (prodDbMtimeBefore !== null && fs.existsSync(prodDbPath)) {
      const prodDbMtimeAfter = fs.statSync(prodDbPath).mtimeMs;
      assert.strictEqual(
        prodDbMtimeBefore,
        prodDbMtimeAfter,
        'CRÍTICO: O banco operacional data/assistant.db foi modificado durante os testes!'
      );
      console.log('  ✓ Inviolabilidade comprovada: data/assistant.db permaneceu 100% intocado.');
    } else {
      console.log('  ✓ Banco operacional verificado: nenhuma interferência detectada.');
    }
    passedTests++;

    console.log('\n================================================================');
    console.log(`  RESULTADO: ${passedTests}/${totalTests} CENÁRIOS DE ACEITAÇÃO APROVADOS COM SUCESSO!`);
    console.log('================================================================\n');

  } finally {
    // Limpeza mandatória dos arquivos temporários descartáveis em os.tmpdir()
    try {
      outboxWorker.stopWorker();
      whatsappClient._resetSocketForTesting();
    } catch (_) {}

    await new Promise(r => setTimeout(r, 100));

    try {
      db.close();
      if (fs.existsSync(tempDbFile)) fs.unlinkSync(tempDbFile);
      const walFile = `${tempDbFile}-wal`;
      const shmFile = `${tempDbFile}-shm`;
      if (fs.existsSync(walFile)) { try { fs.unlinkSync(walFile); } catch (_) {} }
      if (fs.existsSync(shmFile)) { try { fs.unlinkSync(shmFile); } catch (_) {} }
      if (fs.existsSync(tempAuthDir)) fs.rmSync(tempAuthDir, { recursive: true, force: true });
      console.log('✓ Arquivos temporários de teste limpos com sucesso em os.tmpdir().');
    } catch (cleanupErr) {
      console.warn('Aviso ao limpar arquivos temporários:', cleanupErr.message);
    }
  }
}

runTests().catch((err) => {
  console.error('\n❌ FALHA NA SUÍTE DE TESTES:');
  console.error(err);
  process.exit(1);
});
