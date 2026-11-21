/**
 * COMANDO 063 — HOMOLOGAÇÃO DE REMARCAÇÃO, CANCELAMENTO E LIMPEZA SEGURA DO GOOGLE CALENDAR
 * Branch: security/raia-27-protecoes
 *
 * Suíte de Testes Herméticos:
 * 1. Remarcação (UPDATE) com Escrita Real Autorizada
 * 2. Cancelamento (DELETE) com Escrita Real Autorizada
 * 3. Idempotência em Cancelamento / Evento Já Deletado (404/410 no Google)
 * 4. Barreira Anti-Primary Shield em UPDATE e DELETE
 * 5. Barreira Demo Shield em UPDATE e DELETE
 * 6. Isolamento Multi-tenant e Preservação de Terceiros
 * 7. Pre-flight Guard de Assinatura Expirada
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 1. Isolamento Mandatório: Banco descartável em os.tmpdir() configurado ANTES de qualquer require de banco
const tmpDbPath = path.join(os.tmpdir(), `test_comando063_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.db`);
process.env.DB_PATH = tmpDbPath;
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'super_secret_test_encryption_key_32_bytes_len!';
process.env.MFA_ENCRYPTION_KEY = 'super_secret_test_encryption_key_32_bytes_len!';
process.env.HOMOLOGACAO = 'true';
process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '3';
process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '17';
process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'salon_calendar_sec_123@group.calendar.google.com';
process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'dona.salao@gmail.com';
process.env.GOOGLE_SYNC_ALLOWED_EMAILS = 'dona.salao@gmail.com';

// 2. Carregamento dos módulos internos sob teste
const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const outboxWorker = require('../src/services/outboxWorker');
const gatekeeper = require('../src/services/googleCalendarGatekeeper');
const productService = require('../src/services/productService');

// Hook de limpeza hermética no encerramento da suíte
test.after(() => {
  googleCalendarService.resetMockHandler();
  try { db.close(); } catch (_) {}
  try { if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath); } catch (_) {}
  try { if (fs.existsSync(tmpDbPath + '-wal')) fs.unlinkSync(tmpDbPath + '-wal'); } catch (_) {}
  try { if (fs.existsSync(tmpDbPath + '-shm')) fs.unlinkSync(tmpDbPath + '-shm'); } catch (_) {}
});

// Helper de semeadura limpa do banco
function seedBaseData() {
  db.exec('DELETE FROM appointments');
  db.exec('DELETE FROM google_sync_outbox');
  db.exec('DELETE FROM appointment_status_history');
  db.exec('DELETE FROM whatsapp_notification_outbox');
  db.exec('DELETE FROM client_staff');
  db.exec('DELETE FROM client_salons');
  db.exec('DELETE FROM google_calendar_tokens');
  db.exec('DELETE FROM customer_subscriptions');
  db.exec('DELETE FROM users');

  // Garante existência de produto JESSICA
  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const jessicaProdId = jessicaProd ? jessicaProd.id : 1;

  // Tenant 3 (Salão Real Homologado)
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (3, '5511999990003', 'Salão Dona Maria', 'CLIENT', 0, 'ACTIVE', datetime('now', '+30 days'))
  `).run();

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, status, price_cents, access_expires_at, paid_until)
    VALUES (3, ?, 'ACTIVE', 9700, datetime('now', '+30 days'), datetime('now', '+30 days'))
  `).run(jessicaProdId);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, google_selected_calendar_id, google_sync_existing_authorized)
    VALUES (3, 'Salão Dona Maria', '5511999990003', 'salon_calendar_sec_123@group.calendar.google.com', 1)
  `).run();

  db.prepare(`
    INSERT INTO client_staff (id, user_id, name, active)
    VALUES (10, 3, 'Cabeleireira Ana', 1)
  `).run();

  const encTokensTenant3 = googleCalendarService.encryptTokens({
    access_token: 'mock_token_tenant_3',
    refresh_token: 'mock_refresh_tenant_3',
    scope: 'https://www.googleapis.com/auth/calendar.events',
  });

  db.prepare(`
    INSERT INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id, sync_mode, is_connected,
      initial_connection_at, connected_at, sync_existing_authorized
    ) VALUES (
      3, 'dona.salao@gmail.com', ?, 'salon_calendar_sec_123@group.calendar.google.com', 'SINGLE', 1,
      datetime('now', '-10 days'), datetime('now', '-10 days'), 1
    )
  `).run(encTokensTenant3);

  // Tenant 2 (Salão Demo)
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (2, '5511999990002', 'Salão Demonstração', 'CLIENT', 1, 'ACTIVE', datetime('now', '+30 days'))
  `).run();

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, status, price_cents, access_expires_at, paid_until)
    VALUES (2, ?, 'ACTIVE', 9700, datetime('now', '+30 days'), datetime('now', '+30 days'))
  `).run(jessicaProdId);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, google_selected_calendar_id)
    VALUES (2, 'Salão Demo', '5511999990002', 'salon_calendar_sec_123@group.calendar.google.com')
  `).run();

  db.prepare(`
    INSERT INTO client_staff (id, user_id, name, active)
    VALUES (20, 2, 'Profissional Demo', 1)
  `).run();

  const encTokensTenant2 = googleCalendarService.encryptTokens({
    access_token: 'mock_token_tenant_2',
    scope: 'https://www.googleapis.com/auth/calendar.events',
  });

  db.prepare(`
    INSERT INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id, sync_mode, is_connected,
      initial_connection_at, connected_at, sync_existing_authorized
    ) VALUES (
      2, 'demo@raiaagentes.com.br', ?, 'salon_calendar_sec_123@group.calendar.google.com', 'SINGLE', 1,
      datetime('now', '-5 days'), datetime('now', '-5 days'), 1
    )
  `).run(encTokensTenant2);

  // Tenant 202 (Salão Terceiro Isolado)
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (202, '5511999990202', 'Salão Terceiro', 'CLIENT', 0, 'ACTIVE', datetime('now', '+30 days'))
  `).run();

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, status, price_cents, access_expires_at, paid_until)
    VALUES (202, ?, 'ACTIVE', 9700, datetime('now', '+30 days'), datetime('now', '+30 days'))
  `).run(jessicaProdId);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, google_selected_calendar_id)
    VALUES (202, 'Salão Terceiro', '5511999990202', 'sec_cal_202@group.calendar.google.com')
  `).run();

  db.prepare(`
    INSERT INTO client_staff (id, user_id, name, active)
    VALUES (30, 202, 'Profissional Terceiro', 1)
  `).run();

  const encTokensTenant202 = googleCalendarService.encryptTokens({
    access_token: 'mock_token_tenant_202',
    scope: 'https://www.googleapis.com/auth/calendar.events',
  });

  db.prepare(`
    INSERT INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id, sync_mode, is_connected,
      initial_connection_at, connected_at, sync_existing_authorized
    ) VALUES (
      202, 'terceiro@saloon.com', ?, 'sec_cal_202@group.calendar.google.com', 'SINGLE', 1,
      datetime('now', '-2 days'), datetime('now', '-2 days'), 1
    )
  `).run(encTokensTenant202);
}

test('Suíte Hermética COMANDO 063: Remarcação, Cancelamento e Limpeza Segura do Google Calendar', async (t) => {

  t.beforeEach(() => {
    seedBaseData();
    googleCalendarService.resetMockHandler();
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

    const sessionService = require('../src/services/googleCalendarSessionService');
    sessionService.ensureSchema(db);
    sessionService.createTestSession({
      userId: 3,
      appointmentId: 17,
      calendarId: 'salon_calendar_sec_123@group.calendar.google.com',
      accountEmail: 'dona.salao@gmail.com',
      allowedAction: 'ANY',
      durationMinutes: 30,
      maxExecutions: 5,
      createdBy: 1,
    }, db);
  });

  t.afterEach(() => {
    googleCalendarService.resetMockHandler();
  });

  // -------------------------------------------------------------------------
  // CENÁRIO 1: Remarcação (UPDATE) com Escrita Real Autorizada
  // -------------------------------------------------------------------------
  await t.test('1. Remarcação (UPDATE) com Escrita Real Autorizada: altera horário, outbox SENT e preserva mesmo google_event_id', async () => {
    const existingGoogleEventId = 'gcal_ev_live_17992';

    // Cria agendamento existente previamente sincronizado
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, client_phone, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        17, 3, 10, 'Corte & Escova', 'Juliana Ramos', '5511988887777',
        '2026-12-10 14:00:00', '2026-12-10 14:45:00',
        ?, 'salon_calendar_sec_123@group.calendar.google.com', 'SYNCED', 'CONFIRMADO'
      )
    `).run(existingGoogleEventId);

    let updateCalls = 0;
    let receivedUpdatePayload = null;

    googleCalendarService.setMockHandler({
      getGoogleBusySlots: async () => [],
      updateCalendarEvent: async (userId, googleEventId, appointment, targetCalId) => {
        updateCalls++;
        receivedUpdatePayload = { userId, googleEventId, appointment, targetCalId };
        return {
          success: true,
          googleEventId,
          calendarId: targetCalId,
        };
      },
    });

    // Executa a remarcação de negócio via salonAppointmentService
    const rescheduled = await salonAppointmentService.rescheduleAppointment(17, 3, {
      newDate: '2026-12-12',
      newTime: '16:00',
      reason: 'Solicitação de remarcação da cliente Juliana',
      changedBy: 'SALON_MANAGER',
    });

    assert.ok(rescheduled, 'Retorno da remarcação deve existir');

    // Validações imediatas no SQLite
    const aptAfterReschedule = db.prepare('SELECT * FROM appointments WHERE id = 17').get();
    assert.strictEqual(aptAfterReschedule.start_datetime, '2026-12-12 16:00:00', 'Início deve ter sido atualizado');
    assert.strictEqual(aptAfterReschedule.end_datetime, '2026-12-12 16:45:00', 'Fim deve ter sido recalculado');
    assert.strictEqual(aptAfterReschedule.google_sync_status, 'PENDING', 'Status de sincronização deve voltar para PENDING');
    assert.strictEqual(aptAfterReschedule.google_event_id, existingGoogleEventId, 'ID do evento Google deve permanecer idêntico');

    const historyRow = db.prepare('SELECT * FROM appointment_status_history WHERE appointment_id = 17 ORDER BY id DESC LIMIT 1').get();
    assert.ok(historyRow, 'Deve existir registro de auditoria');
    assert.strictEqual(historyRow.previous_status, 'CONFIRMADO');
    assert.strictEqual(historyRow.new_status, 'CONFIRMADO');
    assert.ok(historyRow.reason.includes('Remarcação de horário: 2026-12-10 14:00:00 -> 2026-12-12 16:00:00'));

    const outboxPending = db.prepare("SELECT * FROM google_sync_outbox WHERE appointment_id = 17 AND action = 'UPDATE'").get();
    assert.ok(outboxPending, 'Tarefa UPDATE deve ter sido enfileirada no outbox');
    assert.strictEqual(outboxPending.status, 'PENDING');

    // Executa worker resiliente para processar a tarefa UPDATE
    const processed = await outboxWorker.processGoogleSyncOutbox(3);
    assert.strictEqual(processed, 1, 'Worker deve ter processado exatamente 1 item');

    assert.strictEqual(updateCalls, 1, 'Mock de updateCalendarEvent deve ser invocado exatamente 1 vez');
    assert.strictEqual(receivedUpdatePayload.userId, 3);
    assert.strictEqual(receivedUpdatePayload.googleEventId, existingGoogleEventId);
    assert.strictEqual(receivedUpdatePayload.targetCalId, 'salon_calendar_sec_123@group.calendar.google.com');

    // Validações pós-execução do worker
    const aptFinal = db.prepare('SELECT * FROM appointments WHERE id = 17').get();
    assert.strictEqual(aptFinal.google_sync_status, 'SYNCED', 'Agendamento deve ser reconciliado como SYNCED');
    assert.strictEqual(aptFinal.google_event_id, existingGoogleEventId, 'ZERO novo evento criado: ID preservado');

    const outboxFinal = db.prepare('SELECT * FROM google_sync_outbox WHERE id = ?').get(outboxPending.id);
    assert.strictEqual(outboxFinal.status, 'SENT', 'Outbox UPDATE deve estar marcado como SENT');
    assert.strictEqual(outboxFinal.last_error, null);
  });

  // -------------------------------------------------------------------------
  // CENÁRIO 2: Cancelamento (DELETE) com Escrita Real Autorizada
  // -------------------------------------------------------------------------
  await t.test('2. Cancelamento (DELETE) com Escrita Real Autorizada: marca CANCELADO, outbox SENT e remove evento remoto', async () => {
    const existingGoogleEventId = 'gcal_ev_live_17992';

    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, client_phone, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        17, 3, 10, 'Corte & Escova', 'Juliana Ramos', '5511988887777',
        '2026-12-10 14:00:00', '2026-12-10 14:45:00',
        ?, 'salon_calendar_sec_123@group.calendar.google.com', 'SYNCED', 'CONFIRMADO'
      )
    `).run(existingGoogleEventId);

    let deleteCalls = 0;
    let receivedDeletePayload = null;

    googleCalendarService.setMockHandler({
      getGoogleBusySlots: async () => [],
      deleteCalendarEvent: async (userId, googleEventId, targetCalId) => {
        deleteCalls++;
        receivedDeletePayload = { userId, googleEventId, targetCalId };
        return { success: true };
      },
    });

    const cancelResult = await salonAppointmentService.cancelAppointment(17, 3, {
      reason: 'Cliente cancelou por imprevisto familiar',
      cancelledBy: 'SALON_MANAGER',
    });

    assert.ok(cancelResult.success, 'Cancelamento deve retornar sucesso');

    // Validação imediata no SQLite
    const aptAfterCancel = db.prepare('SELECT * FROM appointments WHERE id = 17').get();
    assert.strictEqual(aptAfterCancel.status, 'CANCELADO', 'Status de negócio deve ser CANCELADO');

    const historyRow = db.prepare("SELECT * FROM appointment_status_history WHERE appointment_id = 17 AND new_status = 'CANCELADO'").get();
    assert.ok(historyRow, 'Auditoria de cancelamento gravada');
    assert.strictEqual(historyRow.previous_status, 'CONFIRMADO');

    const outboxDelete = db.prepare("SELECT * FROM google_sync_outbox WHERE appointment_id = 17 AND action = 'DELETE'").get();
    assert.ok(outboxDelete, 'Tarefa DELETE criada na outbox');
    assert.strictEqual(outboxDelete.status, 'PENDING');

    // Executa worker
    const processed = await outboxWorker.processGoogleSyncOutbox(3);
    assert.strictEqual(processed, 1);

    assert.strictEqual(deleteCalls, 1, 'Mock de deleteCalendarEvent deve ser invocado');
    assert.strictEqual(receivedDeletePayload.userId, 3);
    assert.strictEqual(receivedDeletePayload.googleEventId, existingGoogleEventId);
    assert.strictEqual(receivedDeletePayload.targetCalId, 'salon_calendar_sec_123@group.calendar.google.com');

    const aptFinal = db.prepare('SELECT * FROM appointments WHERE id = 17').get();
    assert.strictEqual(aptFinal.google_sync_status, 'CANCELLED', 'google_sync_status deve ser CANCELLED');

    const outboxFinal = db.prepare('SELECT * FROM google_sync_outbox WHERE id = ?').get(outboxDelete.id);
    assert.strictEqual(outboxFinal.status, 'SENT', 'Outbox DELETE deve ser marcado como SENT');
  });

  // -------------------------------------------------------------------------
  // CENÁRIO 3: Idempotência em Cancelamento / Evento Já Deletado (404/410)
  // -------------------------------------------------------------------------
  await t.test('3. Idempotência em Cancelamento: 404/410 no Google reconcilia como CANCELLED sem falha', async () => {
    const deletedEventId = 'gcal_ev_gone_404_17';

    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        17, 3, 10, 'Corte Masculino', 'Pedro Lima',
        '2026-12-11 10:00:00', '2026-12-11 10:45:00',
        ?, 'salon_calendar_sec_123@group.calendar.google.com', 'PENDING', 'CANCELADO'
      )
    `).run(deletedEventId);

    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (3, 17, 'DELETE', 'PENDING', '{}')
    `).run();

    let attempts = 0;
    googleCalendarService.setMockHandler({
      deleteCalendarEvent: async (userId, googleEventId, targetCalId) => {
        attempts++;
        // Simula evento já excluído remotamente no Google (404 Not Found ou 410 Gone)
        return { success: true, notFoundReconciled: true, statusCode: 404 };
      },
    });

    const processed = await outboxWorker.processGoogleSyncOutbox(3);
    assert.strictEqual(processed, 1, 'Deve processar com sucesso');
    assert.strictEqual(attempts, 1);

    const outboxFinal = db.prepare("SELECT * FROM google_sync_outbox WHERE appointment_id = 17 AND action = 'DELETE'").get();
    assert.strictEqual(outboxFinal.status, 'SENT', 'Deve finalizar como SENT mesmo se evento já não existia');
    assert.strictEqual(outboxFinal.last_error, null, 'Nenhum erro residual gravado');

    const aptFinal = db.prepare('SELECT * FROM appointments WHERE id = 17').get();
    assert.strictEqual(aptFinal.google_sync_status, 'CANCELLED');
  });

  // -------------------------------------------------------------------------
  // CENÁRIO 4: Barreira Anti-Primary Shield em UPDATE e DELETE
  // -------------------------------------------------------------------------
  await t.test('4. Barreira Anti-Primary Shield: tentativa de UPDATE ou DELETE apontando para "primary" ou "default" é bloqueada', async () => {
    // 4.1 Validação direta via Gatekeeper
    const gateUpdatePrimary = gatekeeper.evaluateGatekeeper({
      userId: 3,
      calendarId: 'primary',
      appointmentId: 17,
      accountEmail: 'dona.salao@gmail.com',
      isDemo: 0,
    });
    assert.strictEqual(gateUpdatePrimary.allowed, false);
    assert.strictEqual(gateUpdatePrimary.reason, 'PRIMARY_CALENDAR_PROHIBITED');

    const gateDeleteDefault = gatekeeper.evaluateGatekeeper({
      userId: 3,
      calendarId: 'default',
      appointmentId: 17,
      accountEmail: 'dona.salao@gmail.com',
      isDemo: 0,
    });
    assert.strictEqual(gateDeleteDefault.allowed, false);
    assert.strictEqual(gateDeleteDefault.reason, 'PRIMARY_CALENDAR_PROHIBITED');

    // 4.2 Validação direta de chamada à API de serviço
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        17, 3, 10, 'Design de Sobrancelha', 'Carla Souza',
        '2026-12-14 11:00:00', '2026-12-14 11:30:00',
        'gcal_ev_primary_test', 'primary', 'SYNCED', 'CONFIRMADO'
      )
    `).run();

    await assert.rejects(
      async () => {
        await googleCalendarService.updateCalendarEvent(3, 'gcal_ev_primary_test', { id: 17 }, 'primary');
      },
      (err) => {
        assert.strictEqual(err.code, 'PRIMARY_CALENDAR_PROHIBITED');
        assert.ok(err.message.includes('Anti-Primary Shield'));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await googleCalendarService.deleteCalendarEvent(3, 'gcal_ev_primary_test', 'primary');
      },
      (err) => {
        assert.strictEqual(err.code, 'PRIMARY_CALENDAR_PROHIBITED');
        assert.ok(err.message.includes('Anti-Primary Shield'));
        return true;
      }
    );

    // 4.3 Validação no worker: item com targetCalId 'primary' não chama mock de rede
    let mockCalls = 0;
    googleCalendarService.setMockHandler({
      updateCalendarEvent: async () => { mockCalls++; return { success: true }; },
      deleteCalendarEvent: async () => { mockCalls++; return { success: true }; },
    });

    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (3, 17, 'UPDATE', 'PENDING', '{}')
    `).run();

    await outboxWorker.processGoogleSyncOutbox(3);
    assert.strictEqual(mockCalls, 0, 'Mock de rede jamais deve ser acionado se targetCalendarId for primary');

    // Outbox deve permanecer preservada em PENDING pois falhou no Gatekeeper em homologação restrita
    const outboxRow = db.prepare('SELECT status FROM google_sync_outbox WHERE appointment_id = 17').get();
    assert.strictEqual(outboxRow.status, 'PENDING');
  });

  // -------------------------------------------------------------------------
  // CENÁRIO 5: Barreira Demo Shield em UPDATE e DELETE
  // -------------------------------------------------------------------------
  await t.test('5. Barreira Demo Shield: Tenant 2 (is_demo = 1) em UPDATE e DELETE é tratado localmente como SIMULATED', async () => {
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        201, 2, 20, 'Atendimento Fictício Demo', 'Cliente Teste Demo',
        '2026-12-15 14:00:00', '2026-12-15 14:45:00',
        'sim_demo_201', 'salon_calendar_sec_123@group.calendar.google.com', 'SIMULATED', 'CONFIRMADO'
      )
    `).run();

    let externalCalls = 0;
    googleCalendarService.setMockHandler({
      updateCalendarEvent: async () => { externalCalls++; return { success: true }; },
      deleteCalendarEvent: async () => { externalCalls++; return { success: true }; },
    });

    // 5.1 UPDATE em conta Demo
    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (2, 201, 'UPDATE', 'PENDING', '{}')
    `).run();

    // Desativa temporariamente o modo de homologação estrita de 1 agendamento para permitir rodar filtro do tenant 2
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

    const processedUpdate = await outboxWorker.processGoogleSyncOutbox(2);
    assert.strictEqual(processedUpdate, 1);
    assert.strictEqual(externalCalls, 0, 'Demo Shield: zero chamadas remotas ou mock');

    const aptAfterUpdate = db.prepare('SELECT * FROM appointments WHERE id = 201').get();
    assert.strictEqual(aptAfterUpdate.google_sync_status, 'SIMULATED');

    const outboxAfterUpdate = db.prepare("SELECT * FROM google_sync_outbox WHERE appointment_id = 201 AND action = 'UPDATE'").get();
    assert.strictEqual(outboxAfterUpdate.status, 'SIMULATED');
    assert.ok(outboxAfterUpdate.last_error.includes('is_demo'));

    // 5.2 DELETE em conta Demo
    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (2, 201, 'DELETE', 'PENDING', '{}')
    `).run();

    const processedDelete = await outboxWorker.processGoogleSyncOutbox(2);
    assert.strictEqual(processedDelete, 1);
    assert.strictEqual(externalCalls, 0, 'Demo Shield: zero chamadas remotas em cancelamento');

    const aptAfterDelete = db.prepare('SELECT * FROM appointments WHERE id = 201').get();
    assert.strictEqual(aptAfterDelete.google_sync_status, 'SIMULATED');

    const outboxAfterDelete = db.prepare("SELECT * FROM google_sync_outbox WHERE appointment_id = 201 AND action = 'DELETE'").get();
    assert.strictEqual(outboxAfterDelete.status, 'SIMULATED');
  });

  // -------------------------------------------------------------------------
  // CENÁRIO 6: Isolamento Multi-tenant e Preservação de Terceiros
  // -------------------------------------------------------------------------
  await t.test('6. Isolamento Multi-tenant: tarefas de outro tenant (202) e outro agendamento (888) permanecem estritamente PENDING', async () => {
    // Agendamento do Salão 202
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        999, 202, 30, 'Corte Salão Terceiro', 'Cliente Terceiro',
        '2026-12-16 10:00:00', '2026-12-16 10:45:00',
        'gcal_ev_third_999', 'sec_cal_202@group.calendar.google.com', 'SYNCED', 'CONFIRMADO'
      )
    `).run();

    // Outro agendamento do Salão 3 (diferente do autorizado 17)
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        888, 3, 10, 'Outro Atendimento Salão 3', 'Cliente Oito',
        '2026-12-16 14:00:00', '2026-12-16 14:45:00',
        'gcal_ev_apt_888', 'salon_calendar_sec_123@group.calendar.google.com', 'SYNCED', 'CONFIRMADO'
      )
    `).run();

    // Agendamento autorizado 17
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        17, 3, 10, 'Agendamento Homologado 17', 'Cliente Dezessete',
        '2026-12-16 16:00:00', '2026-12-16 16:45:00',
        'gcal_ev_apt_17', 'salon_calendar_sec_123@group.calendar.google.com', 'SYNCED', 'CONFIRMADO'
      )
    `).run();

    // Enfileira tarefas para todos os três agendamentos
    db.prepare(`INSERT INTO google_sync_outbox (user_id, appointment_id, action, status) VALUES (202, 999, 'UPDATE', 'PENDING')`).run();
    db.prepare(`INSERT INTO google_sync_outbox (user_id, appointment_id, action, status) VALUES (202, 999, 'DELETE', 'PENDING')`).run();
    db.prepare(`INSERT INTO google_sync_outbox (user_id, appointment_id, action, status) VALUES (3, 888, 'UPDATE', 'PENDING')`).run();
    db.prepare(`INSERT INTO google_sync_outbox (user_id, appointment_id, action, status) VALUES (3, 17, 'UPDATE', 'PENDING')`).run();

    let executedAptId = null;
    googleCalendarService.setMockHandler({
      updateCalendarEvent: async (userId, googleEventId, appointment, targetCalId) => {
        executedAptId = appointment.id;
        return { success: true };
      },
    });

    // Executa worker geral em modo de homologação estrita (restrito a tenant 3 / apt 17)
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    const processed = await outboxWorker.processGoogleSyncOutbox();

    assert.strictEqual(processed, 1, 'Apenas o agendamento autorizado 17 deve ser processado');
    assert.strictEqual(executedAptId, 17, 'Apenas apt 17 deve ter executado chamada');

    // Tarefas de terceiros permanecem estritamente PENDING e intactas
    const thirdOutboxUpdate = db.prepare("SELECT status FROM google_sync_outbox WHERE user_id = 202 AND action = 'UPDATE'").get();
    assert.strictEqual(thirdOutboxUpdate.status, 'PENDING');

    const thirdOutboxDelete = db.prepare("SELECT status FROM google_sync_outbox WHERE user_id = 202 AND action = 'DELETE'").get();
    assert.strictEqual(thirdOutboxDelete.status, 'PENDING');

    const otherAptOutbox = db.prepare('SELECT status FROM google_sync_outbox WHERE appointment_id = 888').get();
    assert.strictEqual(otherAptOutbox.status, 'PENDING');
  });

  // -------------------------------------------------------------------------
  // CENÁRIO 7: Pre-flight Guard de Assinatura Expirada
  // -------------------------------------------------------------------------
  await t.test('7. Pre-flight Guard de Assinatura: se assinatura expirar antes do worker rodar UPDATE, cancela com SUBSCRIPTION_EXPIRED', async () => {
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, staff_id, title, client_name, start_datetime, end_datetime,
        google_event_id, google_calendar_id, google_sync_status, status
      ) VALUES (
        17, 3, 10, 'Corte Escova', 'Cliente Expirado',
        '2026-12-18 15:00:00', '2026-12-18 15:45:00',
        'gcal_ev_expired_17', 'salon_calendar_sec_123@group.calendar.google.com', 'PENDING', 'CONFIRMADO'
      )
    `).run();

    const outboxInsert = db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (3, 17, 'UPDATE', 'PENDING', '{}')
    `).run();

    // Simula expiração contratual da assinatura Jéssica antes da execução do worker
    db.prepare(`
      UPDATE users
      SET subscription_status = 'EXPIRED',
          paid_until = '2025-01-01 00:00:00'
      WHERE id = 3
    `).run();

    db.prepare(`
      UPDATE customer_subscriptions
      SET status = 'EXPIRED',
          access_expires_at = '2025-01-01 00:00:00',
          paid_until = '2025-01-01 00:00:00'
      WHERE user_id = 3
    `).run();

    let updateMockCalled = 0;
    googleCalendarService.setMockHandler({
      updateCalendarEvent: async () => {
        updateMockCalled++;
        return { success: true };
      },
    });

    const processed = await outboxWorker.processGoogleSyncOutbox(3);
    assert.strictEqual(processed, 1, 'Worker deve processar e cancelar a tarefa');
    assert.strictEqual(updateMockCalled, 0, 'Google Calendar mock JAMAIS deve ser chamado se assinatura estiver expirada');

    const outboxAfter = db.prepare('SELECT * FROM google_sync_outbox WHERE id = ?').get(outboxInsert.lastInsertRowid);
    assert.strictEqual(outboxAfter.status, 'CANCELLED');
    assert.ok(outboxAfter.last_error.includes('SUBSCRIPTION_EXPIRED'));

    const aptAfter = db.prepare('SELECT * FROM appointments WHERE id = 17').get();
    assert.strictEqual(aptAfter.google_sync_status, 'NOT_SYNCED');
    assert.ok(aptAfter.google_sync_error.includes('Assinatura do módulo Jéssica'));
  });

});
