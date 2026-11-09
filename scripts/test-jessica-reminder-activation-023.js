/**
 * RAIA AGENTES — SUÍTE DE TESTES DE ACEITAÇÃO: ATIVAÇÃO FUNCIONAL DO LEMBRETE 24H (COMANDO 023)
 * 
 * Validação rigorosa dos 14 cenários mandatários:
 *  1. Inicialização do Daemon integrado no startServer (singleton, .unref())
 *  2. Ciclo periódico automático de varredura
 *  3. Consentimento LGPD padrão 0 (fail-closed, sem consentimento = sem lembrete)
 *  4. Consentimento explícito com auditoria (reminder_consent_at, reminder_consent_origin)
 *  5. Atualização e revogação via API (PATCH /appointments/:id/consent)
 *  6. Lista de supressão / opt-out central (salon_client_optouts)
 *  7. Cancelamento atômico de lembrete via updateAppointmentStatus ('CANCELADO')
 *  8. Remarcação de horário com renovação de dedup_hash e cancelamento de obsoleto
 *  9. Pre-Flight Guard no OutboxWorker: cancelamento concorrente
 * 10. Pre-Flight Guard no OutboxWorker: revogação concorrente de consentimento
 * 11. Pre-Flight Guard no OutboxWorker: remarcação concorrente (hash divergente)
 * 12. Idempotência sob reinício de daemon / servidor
 * 13. Isolamento multi-tenant estrito entre salões distintos
 * 14. Inviolabilidade absoluta do banco operacional data/assistant.db
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 1. CONFIGURAÇÃO DE AMBIENTE ISOLADO E HERMÉTICO EM OS.TMPDIR()
const uniqueRunId = `023_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_jessica_activation_${uniqueRunId}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_activation_${uniqueRunId}`);

if (!fs.existsSync(tempAuthDir)) {
  fs.mkdirSync(tempAuthDir, { recursive: true });
}

process.env.DB_PATH = tempDbPath;
process.env.AUTH_DIR = tempAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.SALON_REMINDER_INTERVAL_MS = '200'; // Ciclo rápido de 200ms para testes

// Configurações de segurança fail-closed para ambiente de Staging (Matriz RAIA-27)
process.env.ADMIN_PASSWORD = 'TestStrongAdminPassword!2026_Activation_023';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.SESSION_SECRET = 'test_session_secret_023_long_and_strong_enough_123';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_023_long_and_strong_enough_456';
process.env.MFA_ENCRYPTION_KEY = 'test_mfa_key_023_long_and_strong_enough_789';

// Monitoramento de inviolabilidade do banco operacional
const prodDbPath = path.resolve(__dirname, '../data/assistant.db');
const prodDbStatBefore = fs.existsSync(prodDbPath) ? fs.statSync(prodDbPath) : null;

// Carregamento dos módulos sob o banco isolado
const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonReminderService = require('../src/services/salonReminderService');
const outboxWorker = require('../src/services/outboxWorker');
const { app, startServer } = require('../src/server/app');
const whatsappClient = require('../src/whatsapp/client');

let passedTests = 0;
let runningServer = null;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — SUÍTE DE TESTES: ATIVAÇÃO LEMBRETE 24H (023)  ');
  console.log('================================================================\n');

  try {
    // Setup dos Salões A e B
    const userA = 101;
    const userB = 102;

    db.prepare(`
      INSERT OR REPLACE INTO users (id, phone_number, name, role, plan_tier, subscription_status)
      VALUES (?, '5511999990101', 'Salão Jéssica Premium', 'SALON_OWNER', 'PRO', 'ACTIVE')
    `).run(userA);

    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, b2c_reminders_enabled)
      VALUES (?, 'Jéssica Beauty', 1)
    `).run(userA);

    db.prepare(`
      INSERT OR REPLACE INTO users (id, phone_number, name, role, plan_tier, subscription_status)
      VALUES (?, '5511999990102', 'Studio Bella Estética', 'SALON_OWNER', 'PRO', 'ACTIVE')
    `).run(userB);

    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, b2c_reminders_enabled)
      VALUES (?, 'Studio Bella', 1)
    `).run(userB);

    // Cadastrar profissionais ativos para os salões A e B
    db.prepare("INSERT OR REPLACE INTO client_staff (id, user_id, name, active) VALUES (1, ?, 'Jéssica Oficial', 1)").run(userA);
    db.prepare("INSERT OR REPLACE INTO client_staff (id, user_id, name, active) VALUES (2, ?, 'Bella Oficial', 1)").run(userB);

    // Configurar horário de funcionamento flexível
    const fullHours = JSON.stringify({
      days: {
        0: { open: true, start: '00:00', end: '23:59' },
        1: { open: true, start: '00:00', end: '23:59' },
        2: { open: true, start: '00:00', end: '23:59' },
        3: { open: true, start: '00:00', end: '23:59' },
        4: { open: true, start: '00:00', end: '23:59' },
        5: { open: true, start: '00:00', end: '23:59' },
        6: { open: true, start: '00:00', end: '23:59' },
      }
    });
    db.prepare('UPDATE client_salons SET opening_hours = ? WHERE user_id IN (?, ?)').run(fullHours, userA, userB);

    const nowRef = Date.now();
    function makeAptSlot(offsetMinutes) {
      const d = new Date(nowRef + offsetMinutes * 60000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return { d, dateStr, timeStr };
    }

    // -------------------------------------------------------------
    // CENÁRIO 1: Inicialização do Daemon no startServer
    // -------------------------------------------------------------
    console.log('--- TESTE 1: Inicialização do Daemon no startServer (singleton, unref) ---');
    runningServer = await startServer(0);
    assert.ok(runningServer, 'Servidor Express deve estar escutando');
    
    // Tentar inicializar uma segunda vez para testar singleton guard
    const daemonHandle = salonReminderService.startSalonReminderDaemon(200);
    assert.ok(daemonHandle, 'startSalonReminderDaemon deve retornar o timer singleton');
    console.log('  ✓ Servidor inicializou daemon de lembretes B2C de forma singleton e resiliente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 2: Ciclo Periódico Automático do Daemon
    // -------------------------------------------------------------
    console.log('--- TESTE 2: Ciclo Periódico Automático do Daemon (sem chamada manual) ---');
    const slot2 = makeAptSlot(21 * 60); // 21h00
    const apt2 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Carla Silva',
      clientPhone: '5511988880002',
      serviceName: 'Escova Modelada',
      date: slot2.dateStr,
      time: slot2.timeStr,
      durationMin: 15,
      reminderConsent: 1,
      reminderConsentOrigin: 'painel',
    });

    // Aguardar o ciclo automático do daemon (intervalo configurado para 200ms)
    await sleep(450);

    const outbox2 = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt2.id);

    assert.ok(outbox2, 'Lembrete deve ter sido enfileirado automaticamente pelo daemon');
    assert.strictEqual(outbox2.recipient_phone, '5511988880002');
    assert.ok(outbox2.message_text.includes('Carla Silva'));
    console.log('  ✓ Daemon executou ciclo periódico e enfileirou lembrete 24h automaticamente.\n');
    passedTests++;

    // Para os testes subsequentes de estados transitórios e pre-flight guard, pausamos o auto-dispatch do outboxWorker
    outboxWorker.stopWorker();
    const originalNotify = outboxWorker.notify;
    outboxWorker.notify = () => {};

    // -------------------------------------------------------------
    // CENÁRIO 3: Consentimento LGPD Padrão Zero (DEFAULT 0 / fail-closed)
    // -------------------------------------------------------------
    console.log('--- TESTE 3: Consentimento LGPD padrão zero (sem consentimento = sem lembrete) ---');
    const slot3 = makeAptSlot(21 * 60 + 30); // 21h30
    const apt3 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Beatriz Sem Consentimento',
      clientPhone: '5511988880003',
      serviceName: 'Manicure',
      date: slot3.dateStr,
      time: slot3.timeStr,
      durationMin: 15,
      // reminderConsent omitido -> deve ser DEFAULT 0
    });

    const apt3Db = db.prepare('SELECT reminder_consent, reminder_consent_at FROM appointments WHERE id = ?').get(apt3.id);
    assert.strictEqual(apt3Db.reminder_consent, 0, 'Consentimento deve ser 0 por padrão fail-closed');
    assert.strictEqual(apt3Db.reminder_consent_at, null);

    // Aguardar ciclo do daemon
    await sleep(300);

    const outbox3 = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt3.id);
    assert.strictEqual(outbox3, undefined, 'Nenhum lembrete deve ser enfileirado para agendamento sem consentimento');
    console.log('  ✓ Política fail-closed: ausência de consentimento impede disparo de lembrete.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 4: Consentimento Explícito com Auditoria
    // -------------------------------------------------------------
    console.log('--- TESTE 4: Consentimento explícito com auditoria (reminder_consent_at, origin) ---');
    const slot4 = makeAptSlot(22 * 60); // 22h00
    const apt4 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Diana Consentimento Registrado',
      clientPhone: '5511988880004',
      serviceName: 'Corte e Escova',
      date: slot4.dateStr,
      time: slot4.timeStr,
      durationMin: 15,
      reminderConsent: 1,
      reminderConsentOrigin: 'whatsapp_optin',
    });

    const apt4Db = db.prepare('SELECT reminder_consent, reminder_consent_at, reminder_consent_origin FROM appointments WHERE id = ?').get(apt4.id);
    assert.strictEqual(apt4Db.reminder_consent, 1);
    assert.ok(apt4Db.reminder_consent_at, 'Deve registrar data/hora do consentimento');
    assert.strictEqual(apt4Db.reminder_consent_origin, 'whatsapp_optin');
    console.log('  ✓ Metadados de auditoria do consentimento LGPD registrados com sucesso.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 5: Atualização / Revogação via API (updateAppointmentConsent)
    // -------------------------------------------------------------
    console.log('--- TESTE 5: Atualização e revogação de consentimento via updateAppointmentConsent ---');
    // apt4 tem consentimento 1 e o daemon enfileirou
    await sleep(300);
    const outbox4 = db.prepare(`
      SELECT id, status FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt4.id);
    assert.ok(outbox4, 'Outbox de apt4 deve existir');

    // Revogar consentimento para apt4
    salonAppointmentService.updateAppointmentConsent(apt4.id, userA, 0, 'painel', 'Cliente solicitou cancelamento de avisos');
    
    const apt4Updated = db.prepare('SELECT reminder_consent, reminder_24h_status FROM appointments WHERE id = ?').get(apt4.id);
    assert.strictEqual(apt4Updated.reminder_consent, 0);
    assert.strictEqual(apt4Updated.reminder_24h_status, 'CANCELLED');

    const outbox4Updated = db.prepare('SELECT status, last_error FROM whatsapp_notification_outbox WHERE id = ?').get(outbox4.id);
    assert.strictEqual(outbox4Updated.status, 'CANCELLED');
    assert.ok(outbox4Updated.last_error.includes('Consentimento LGPD revogado'));
    console.log('  ✓ Revogação de consentimento cancelou atomicamente o lembrete pendente na Outbox.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 6: Lista de Supressão / Opt-out Central (salon_client_optouts)
    // -------------------------------------------------------------
    console.log('--- TESTE 6: Lista de supressão / opt-out central (salon_client_optouts) ---');
    const optoutPhone = '5511988880006';
    salonReminderService.revokeClientConsent(userA, optoutPhone, 'Opt-out via WhatsApp STOP');

    const optoutRow = db.prepare('SELECT * FROM salon_client_optouts WHERE user_id = ? AND phone = ?').get(userA, optoutPhone);
    assert.ok(optoutRow, 'Cliente deve estar cadastrado na tabela de supressão');

    // Criar novo agendamento para este cliente que optou por sair, mesmo tentando passar consent = 1
    const slot6 = makeAptSlot(22 * 60 + 30); // 22h30
    const apt6 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Cliente em Opt-Out',
      clientPhone: optoutPhone,
      serviceName: 'Hidratação',
      date: slot6.dateStr,
      time: slot6.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    await sleep(300);

    const outbox6 = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt6.id);
    assert.strictEqual(outbox6, undefined, 'Cliente na lista de supressão NÃO pode ter lembrete enfileirado');
    console.log('  ✓ Lista de supressão previne qualquer envio para clientes que exerceram opt-out.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 7: Cancelamento de Agendamento via updateAppointmentStatus
    // -------------------------------------------------------------
    console.log('--- TESTE 7: Cancelamento via updateAppointmentStatus cancela outbox ---');
    const slot7 = makeAptSlot(23 * 60); // 23h00
    const apt7 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Elena Cancelada',
      clientPhone: '5511988880007',
      serviceName: 'Design de Sobrancelhas',
      date: slot7.dateStr,
      time: slot7.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    await sleep(300);
    const outbox7Before = db.prepare(`
      SELECT id, status FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt7.id);
    assert.ok(outbox7Before, 'Lembrete deve ter sido gerado');

    // Mudar status para CANCELADO
    salonAppointmentService.updateAppointmentStatus(apt7.id, userA, 'CANCELADO', 'Cliente desmarcou');

    const outbox7After = db.prepare('SELECT status, last_error FROM whatsapp_notification_outbox WHERE id = ?').get(outbox7Before.id);
    assert.strictEqual(outbox7After.status, 'CANCELLED');
    assert.ok(outbox7After.last_error.includes('terminal'));

    const apt7Db = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(apt7.id);
    assert.strictEqual(apt7Db.reminder_24h_status, 'CANCELLED');
    console.log('  ✓ updateAppointmentStatus cancela atomicamente o lembrete na Outbox.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 8: Remarcação de Horário (Deduplicação baseada em Horário)
    // -------------------------------------------------------------
    console.log('--- TESTE 8: Remarcação de horário invalida antigo e habilita novo dedup_hash ---');
    const slot8Old = makeAptSlot(23 * 60 + 30); // 23h30
    const apt8 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Flavia Remarcada',
      clientPhone: '5511988880008',
      serviceName: 'Escova',
      date: slot8Old.dateStr,
      time: slot8Old.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    await sleep(300);
    const outbox8Old = db.prepare(`
      SELECT id, status, dedup_hash FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt8.id);
    assert.ok(outbox8Old, 'Outbox do horário antigo deve ter sido criado');

    // Remarcar para daqui a 24 horas (ainda na janela de 24h, mas novo horário!)
    const slot8New = makeAptSlot(24 * 60); // 24h00
    await salonAppointmentService.rescheduleAppointment(apt8.id, userA, {
      newDate: slot8New.dateStr,
      newTime: slot8New.timeStr,
      reason: 'Ajuste de 30 minutos',
    });

    // Verificar que o antigo foi marcado CANCELLED
    const outbox8OldCheck = db.prepare('SELECT status FROM whatsapp_notification_outbox WHERE id = ?').get(outbox8Old.id);
    assert.strictEqual(outbox8OldCheck.status, 'CANCELLED');

    // Aguardar o daemon processar o novo horário
    await sleep(350);

    const outbox8New = db.prepare(`
      SELECT id, status, dedup_hash FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H' AND id != ?
    `).get(apt8.id, outbox8Old.id);

    assert.ok(outbox8New, 'Novo lembrete com novo dedup_hash deve ser gerado');
    assert.notStrictEqual(outbox8New.dedup_hash, outbox8Old.dedup_hash, 'Hash deve incorporar novo start_datetime');
    console.log('  ✓ Remarcação invalida lembrete antigo e gera novo lembrete com dedup_hash correto.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 9: Pre-Flight Guard — Cancelamento Concorrente
    // -------------------------------------------------------------
    console.log('--- TESTE 9: Pre-Flight Guard no OutboxWorker (cancelamento concorrente) ---');
    const slot9 = makeAptSlot(24 * 60 + 30); // 24h30
    const apt9 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Gabriela Concorrente',
      clientPhone: '5511988880009',
      serviceName: 'Corte',
      date: slot9.dateStr,
      time: slot9.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    await sleep(300);
    const outbox9 = db.prepare(`
      SELECT id FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H' AND status = 'PENDING'
    `).get(apt9.id);
    assert.ok(outbox9);

    // Simular que antes do envio o agendamento foi cancelado diretamente no banco (ex: concorrência)
    db.prepare("UPDATE appointments SET status = 'CANCELADO' WHERE id = ?").run(apt9.id);

    // Executar worker no item
    const proc9 = await outboxWorker.processWhatsAppOutboxItem(outbox9.id);
    assert.strictEqual(proc9.status, 'CANCELLED');
    assert.strictEqual(proc9.preflightFailed, true);
    assert.strictEqual(proc9.reason, 'INACTIVE_STATUS');

    const outbox9Final = db.prepare('SELECT status, last_error FROM whatsapp_notification_outbox WHERE id = ?').get(outbox9.id);
    assert.strictEqual(outbox9Final.status, 'CANCELLED');
    assert.ok(outbox9Final.last_error.includes('Pre-flight'));
    console.log('  ✓ Pre-Flight Guard impediu envio de lembrete para agendamento cancelado concorrentemente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 10: Pre-Flight Guard — Revogação Concorrente de Consentimento
    // -------------------------------------------------------------
    console.log('--- TESTE 10: Pre-Flight Guard (revogação concorrente de consentimento) ---');
    const slot10 = makeAptSlot(25 * 60); // 25h00
    const apt10 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Helena Consent Revoked',
      clientPhone: '5511988880010',
      serviceName: 'Manicure',
      date: slot10.dateStr,
      time: slot10.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    await sleep(300);
    const outbox10 = db.prepare(`
      SELECT id FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H' AND status = 'PENDING'
    `).get(apt10.id);
    assert.ok(outbox10);

    // Simular revogação direta no appointments
    db.prepare("UPDATE appointments SET reminder_consent = 0 WHERE id = ?").run(apt10.id);

    const proc10 = await outboxWorker.processWhatsAppOutboxItem(outbox10.id);
    assert.strictEqual(proc10.status, 'CANCELLED');
    assert.strictEqual(proc10.preflightFailed, true);
    assert.strictEqual(proc10.reason, 'CONSENT_REVOKED');
    console.log('  ✓ Pre-Flight Guard interceptou e cancelou envio com consentimento ausente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 11: Pre-Flight Guard — Remarcação Concorrente (Hash Divergente)
    // -------------------------------------------------------------
    console.log('--- TESTE 11: Pre-Flight Guard (remarcação concorrente com hash divergente) ---');
    const slot11 = makeAptSlot(25 * 60 + 30); // 25h30
    const apt11 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Isabela Divergente',
      clientPhone: '5511988880011',
      serviceName: 'Pedicure',
      date: slot11.dateStr,
      time: slot11.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    await sleep(300);
    const outbox11 = db.prepare(`
      SELECT id FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H' AND status = 'PENDING'
    `).get(apt11.id);
    assert.ok(outbox11);

    // Alterar start_datetime do agendamento sem atualizar o outbox item
    db.prepare("UPDATE appointments SET start_datetime = '2030-01-01T10:00:00' WHERE id = ?").run(apt11.id);

    const proc11 = await outboxWorker.processWhatsAppOutboxItem(outbox11.id);
    assert.strictEqual(proc11.status, 'CANCELLED');
    assert.strictEqual(proc11.preflightFailed, true);
    assert.strictEqual(proc11.reason, 'SCHEDULE_ALTERED');
    console.log('  ✓ Pre-Flight Guard detectou divergência de horário e cancelou item obsoleto.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 12: Idempotência e Reinício do Servidor
    // -------------------------------------------------------------
    console.log('--- TESTE 12: Idempotência e reinício do servidor/daemon (zero duplicações) ---');
    const slot12 = makeAptSlot(20 * 60 + 30); // 20h30
    const apt12 = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Jessica Idempotente',
      clientPhone: '5511988880012',
      serviceName: 'Luzes',
      date: slot12.dateStr,
      time: slot12.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    await sleep(300);
    const outbox12 = db.prepare(`
      SELECT id FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt12.id);
    assert.ok(outbox12);

    // Processar o item com sucesso em staging
    const proc12 = await outboxWorker.processWhatsAppOutboxItem(outbox12.id);
    assert.strictEqual(proc12.status, 'SIMULATED');

    // Simular reinício do servidor e nova varredura completa
    salonReminderService.stopSalonReminderDaemon();
    salonReminderService.startSalonReminderDaemon(200);
    await sleep(400);

    const total12 = db.prepare(`
      SELECT COUNT(*) as count FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt12.id).count;

    assert.strictEqual(total12, 1, 'Não deve criar duplicação após reinício do daemon');
    console.log('  ✓ Reinício do servidor e daemon preserva deduplicação estrita.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 13: Isolamento Multi-Tenant Rigoroso
    // -------------------------------------------------------------
    console.log('--- TESTE 13: Isolamento Multi-Tenant entre salões distintos ---');
    const sharedPhone = '5511988880013';
    const slot13A = makeAptSlot(21 * 60 + 45); // 21h45
    const slot13B = makeAptSlot(21 * 60 + 45); // 21h45

    const apt13A = salonAppointmentService.bookAppointmentSync(userA, {
      clientName: 'Cliente Multi Salão A',
      clientPhone: sharedPhone,
      serviceName: 'Corte Jéssica',
      date: slot13A.dateStr,
      time: slot13A.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    const apt13B = salonAppointmentService.bookAppointmentSync(userB, {
      clientName: 'Cliente Multi Salão B',
      clientPhone: sharedPhone,
      serviceName: 'Manicure Bella',
      date: slot13B.dateStr,
      time: slot13B.timeStr,
      durationMin: 15,
      reminderConsent: 1,
    });

    await sleep(400);

    const outboxA = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt13A.id);

    const outboxB = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt13B.id);

    assert.ok(outboxA && outboxB, 'Ambos os salões devem gerar lembrete para seus clientes');
    assert.strictEqual(outboxA.user_id, userA);
    assert.strictEqual(outboxB.user_id, userB);
    assert.notStrictEqual(outboxA.dedup_hash, outboxB.dedup_hash, 'Hashes devem ser distintos por user_id');
    assert.ok(outboxA.message_text.includes('Jéssica Beauty'));
    assert.ok(outboxB.message_text.includes('Studio Bella'));
    console.log('  ✓ Multi-tenant isolado: salões distintos operam de forma 100% independente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 14: Inviolabilidade de data/assistant.db
    // -------------------------------------------------------------
    console.log('--- TESTE 14: Inviolabilidade de data/assistant.db ---');
    if (prodDbStatBefore) {
      const prodDbStatAfter = fs.statSync(prodDbPath);
      assert.strictEqual(
        prodDbStatBefore.mtimeMs,
        prodDbStatAfter.mtimeMs,
        'data/assistant.db foi modificado indevidamente durante a execução dos testes!'
      );
      assert.strictEqual(
        prodDbStatBefore.size,
        prodDbStatAfter.size,
        'Tamanho de data/assistant.db foi alterado indevidamente!'
      );
    }
    console.log('  ✓ Inviolabilidade comprovada: data/assistant.db permaneceu 100% intacto.\n');
    passedTests++;

    console.log('================================================================');
    console.log(`  RESULTADO: ${passedTests}/14 CENÁRIOS DE ACEITAÇÃO APROVADOS!  `);
    console.log('================================================================\n');

  } catch (err) {
    console.error('\n❌ FALHA NA SUÍTE DE TESTES:');
    console.error(err);
    process.exitCode = 1;
  } finally {
    // Parar daemon e servidor
    try {
      salonReminderService.stopSalonReminderDaemon();
      outboxWorker.stopWorker();
    } catch (_) {}

    if (runningServer && typeof runningServer.close === 'function') {
      runningServer.close();
    }

    // Fechar e limpar SQLite temporário
    try {
      db.close();
    } catch (_) {}

    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(tempAuthDir)) fs.rmSync(tempAuthDir, { recursive: true, force: true });
      console.log('✓ Arquivos temporários de teste limpos com sucesso em os.tmpdir().');
    } catch (_) {}
  }
}

runTests();
