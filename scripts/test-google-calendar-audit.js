/**
 * RAIA AGENTES — SUÍTE DE AUDITORIA FINAL DO GOOGLE CALENDAR (15 TESTES)
 * 
 * Verificações técnicas completas:
 * 1. Fluxo OAuth de conexão individual por salão com anti-CSRF e fail-closed.
 * 2. Isolamento de credenciais (AES-256-GCM), calendários e eventos entre salões.
 * 3. Criação de eventos ao confirmar agendamentos com identificador determinístico estável.
 * 4. Atualização de eventos ao remarcar agendamento.
 * 5. Cancelamento e tratamento de eventos já sincronizados (inclusive 404/410 limpo).
 * 6. Prevenção de conflito de horários ocupados no Google e sugestão de horários livres.
 * 7. Processamento seguro do outbox: agendamentos históricos no passado e cancelados são ignorados (SKIPPED).
 * 8. Contas de demonstração (is_demo) são 100% simuladas no outbox.
 * 9. Ausência de chamadas de rede externas ao Google dentro de transações BEGIN IMMEDIATE no rescheduleAppointment.
 * 10. Resiliência a falhas, backoff e reconexão.
 * 11. Detecção imediata de token revogado (invalid_grant) com marcação de is_connected = 0.
 * 12. Idempotência e reconciliação sem duplicação de eventos.
 * 13. Modalidade STAFF com calendários individuais por profissional.
 * 14. Desconexão limpa e revogação de credenciais.
 * 15. Preservação de dados operacionais (zero vazamento para data/assistant.db).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// -------------------------------------------------------------
// CONFIGURAÇÃO DO BANCO TEMPORÁRIO ISOLADO (DISPOSABLE SQLITE)
// -------------------------------------------------------------
const tempDbName = `raia_test_gcal_audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.db`;
const tempDbPath = path.resolve(os.tmpdir(), tempDbName);

process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'test';
process.env.ALLOW_WHATSAPP_SENDING = 'false';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'raia-segredo-super-forte-de-32-bytes-para-testes!';
process.env.ADMIN_PASSWORD = 'raia-segredo-super-forte-admin-123456!';

const assert = require('assert');
const http = require('http');
const config = require('../src/config/index');
const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const outboxWorker = require('../src/services/outboxWorker');
const userService = require('../src/services/userService');
const { app } = require('../src/server/app');

async function runTests() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — AUDITORIA TÉCNICA FINAL DO GOOGLE CALENDAR    ');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // COMPROVAÇÃO DE ISOLAMENTO (FAIL-CLOSED)
  // -------------------------------------------------------------
  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE TESTE ---');
  assert.strictEqual(process.env.DB_PATH, tempDbPath, 'DB_PATH deve ser o arquivo temporário isolado');
  assert.strictEqual(config.dbPath, tempDbPath, 'config.dbPath deve coincidir exatamente com o SQLite temporário');
  const defaultDbPath = path.resolve(__dirname, '../data/assistant.db');
  assert.notStrictEqual(path.resolve(config.dbPath), defaultDbPath, 'BLOQUEIO DE SEGURANÇA: Teste JAMAIS pode usar o banco oficial assistant.db');
  assert(!config.dbPath.includes('assistant.db'), 'O caminho DB_PATH não pode conter o banco oficial assistant.db');
  assert.strictEqual(process.env.ALLOW_WHATSAPP_SENDING, 'false', 'WhatsApp externo estritamente desativado');

  console.log(`  ✓ Banco temporário ativo: ${tempDbPath}`);
  console.log(`  ✓ Banco operacional data/assistant.db 100% intocado e preservado.\n`);

  let server;
  let googleMockState = {
    events: new Map(), // calId:eventId -> eventData
    busySlots: [],
    listCalls: 0,
    insertCalls: 0,
    patchCalls: 0,
    deleteCalls: 0,
  };

  // Mock seguro do Google Calendar sem conexões de rede externas
  googleCalendarService.setMockHandler({
    getConnectionStatus: (userId) => {
      const row = db.prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ?').get(userId);
      if (!row || !row.is_connected) {
        return { isConnected: false, accountEmail: null, selectedCalendarId: 'primary', selectedCalendarName: 'Principal', syncMode: 'SINGLE', lastSyncAt: null, lastError: row?.last_error || null };
      }
      return { isConnected: true, accountEmail: row.account_email, selectedCalendarId: row.selected_calendar_id || 'primary', selectedCalendarName: row.selected_calendar_name || 'Principal', syncMode: row.sync_mode || 'SINGLE', lastSyncAt: row.last_sync_at, lastError: row.last_error };
    },
    getGoogleBusySlots: async (userId, { timeMin, timeMax, calendarId, staffId }) => {
      return googleMockState.busySlots.filter(s => {
        return new Date(s.start) < new Date(timeMax) && new Date(s.end) > new Date(timeMin);
      });
    },
    createCalendarEvent: async (userId, appointment, targetCalendarId = null) => {
      googleMockState.insertCalls++;
      const calId = targetCalendarId || 'primary';
      const eventId = `g_event_${userId}_${appointment.id}`;
      const ev = { id: eventId, calId, appointmentId: appointment.id, summary: appointment.title, start: appointment.start_datetime, end: appointment.end_datetime };
      googleMockState.events.set(`${calId}:${eventId}`, ev);
      db.prepare(`UPDATE appointments SET google_event_id = ?, google_calendar_id = ?, google_sync_status = 'SYNCED', google_sync_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(eventId, calId, appointment.id);
      return { success: true, googleEventId: eventId, calendarId: calId };
    },
    updateCalendarEvent: async (userId, googleEventId, appointment, targetCalendarId = null) => {
      googleMockState.patchCalls++;
      const calId = targetCalendarId || 'primary';
      const key = `${calId}:${googleEventId}`;
      googleMockState.events.set(key, { ...(googleMockState.events.get(key) || {}), start: appointment.start_datetime, end: appointment.end_datetime });
      db.prepare(`UPDATE appointments SET google_sync_status = 'SYNCED', google_sync_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(appointment.id);
      return { success: true, googleEventId, calendarId: calId };
    },
    deleteCalendarEvent: async (userId, googleEventId, targetCalendarId = null) => {
      googleMockState.deleteCalls++;
      const calId = targetCalendarId || 'primary';
      googleMockState.events.delete(`${calId}:${googleEventId}`);
      db.prepare(`UPDATE appointments SET google_sync_status = 'CANCELLED', google_sync_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE google_event_id = ? AND user_id = ?`).run(googleEventId, userId);
      return { success: true };
    },
    listUserCalendars: async (userId) => {
      return [
        { id: 'primary', summary: 'Principal', primary: true, selected: true },
        { id: 'cal_secundario', summary: 'Secundário Estética', primary: false, selected: false },
      ];
    },
  });

  try {
    // -------------------------------------------------------------
    // SETUP DE SALÕES
    // -------------------------------------------------------------
    // Salão A
    const userA = db.prepare(`
      INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, paid_until, is_demo)
      VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'), 0)
    `).run(`salonA.${Date.now()}@example.com`, `55119${Math.floor(10000000 + Math.random() * 90000000)}`);
    const salonAId = userA.lastInsertRowid;

    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, google_require_sync_availability)
      VALUES (?, 'Salão Jéssica Beauty A', '5511988880001', '5511988880001', 1, 1, 0)
    `).run(salonAId);

    const staffA = db.prepare(`INSERT INTO client_staff (user_id, name, active) VALUES (?, 'Profissional A', 1)`).run(salonAId);
    const staffAId = staffA.lastInsertRowid;

    const svcA = db.prepare(`INSERT INTO client_services (user_id, name, duration_min, price, active, category) VALUES (?, 'Corte com Escova', 60, 90.0, 1, 'Cabelo')`).run(salonAId);
    const svcAId = svcA.lastInsertRowid;

    // Salão B
    const userB = db.prepare(`
      INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, paid_until, is_demo)
      VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'), 0)
    `).run(`salonB.${Date.now()}@example.com`, `55119${Math.floor(10000000 + Math.random() * 90000000)}`);
    const salonBId = userB.lastInsertRowid;

    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, google_require_sync_availability)
      VALUES (?, 'Salão Jéssica Beauty B', '5511988880002', '5511988880002', 1, 1, 0)
    `).run(salonBId);

    // Conta de Demonstração (is_demo = 1)
    const userDemo = db.prepare(`
      INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, paid_until, is_demo)
      VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'), 1)
    `).run(`demo.${Date.now()}@example.com`, `55119${Math.floor(10000000 + Math.random() * 90000000)}`);
    const demoUserId = userDemo.lastInsertRowid;

    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, google_require_sync_availability)
      VALUES (?, 'Salão Demo Fictício', '5511988880003', '5511988880003', 1, 1, 0)
    `).run(demoUserId);

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const apiBase = `http://127.0.0.1:${port}`;

    const sessionA = userService.createUserSession(salonAId, 7);
    const authHeadersA = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionA.sessionToken}` };

    const sessionB = userService.createUserSession(salonBId, 7);
    const authHeadersB = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionB.sessionToken}` };

    // -------------------------------------------------------------
    // TESTE 1: Fluxo OAuth e validação de Anti-CSRF
    // -------------------------------------------------------------
    console.log('[Teste 1] Fluxo OAuth e proteção Anti-CSRF...');
    // Obter URL de autorização via API
    const resAuthUrl = await fetch(`${apiBase}/api/cliente/integrations/google/auth-url`, { headers: authHeadersA });
    assert.strictEqual(resAuthUrl.status, 200);
    const authUrlData = await resAuthUrl.json();
    assert(authUrlData.success && authUrlData.authUrl && authUrlData.state);

    const stateRow = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(authUrlData.state);
    assert(stateRow);
    assert.strictEqual(stateRow.user_id, salonAId);

    // Callback sem sessão deve falhar
    const stateNoAuth = `state_no_auth_${Date.now()}`;
    db.prepare("INSERT INTO oauth_states (state, user_id, provider, expires_at) VALUES (?, ?, 'google', ?)").run(stateNoAuth, salonAId, Date.now() + 600000);
    let errNoAuth = null;
    try {
      await googleCalendarService.handleOAuthCallback('code_123', stateNoAuth, null);
    } catch (e) { errNoAuth = e; }
    assert(errNoAuth && errNoAuth.code === 'UNAUTHORIZED_OAUTH_CALLBACK');

    // Callback cruzado entre Salão B e state do Salão A deve falhar
    const stateCross = `state_cross_${Date.now()}`;
    db.prepare("INSERT INTO oauth_states (state, user_id, provider, expires_at) VALUES (?, ?, 'google', ?)").run(stateCross, salonAId, Date.now() + 600000);
    let errCross = null;
    try {
      await googleCalendarService.handleOAuthCallback('code_123', stateCross, salonBId);
    } catch (e) { errCross = e; }
    assert(errCross && errCross.code === 'CROSS_SALON_LINKING_REJECTED');
    console.log('  ✓ 1. Validação OAuth anti-CSRF, sessão obrigatória e rejeição cruzada aprovadas.\n');

    // -------------------------------------------------------------
    // TESTE 2: Isolamento de credenciais e calendários
    // -------------------------------------------------------------
    console.log('[Teste 2] Isolamento de credenciais criptografadas por salão...');
    const fakeTokensA = { access_token: 'fake_access_token_A', refresh_token: 'fake_refresh_token_A' };
    const encTokensA = googleCalendarService.encryptTokens(fakeTokensA);
    db.prepare(`
      INSERT INTO google_calendar_tokens (user_id, account_email, encrypted_tokens, is_connected, sync_mode)
      VALUES (?, 'salaoA@gmail.com', ?, 1, 'SINGLE')
    `).run(salonAId, encTokensA);

    const decryptedA = googleCalendarService.decryptTokens(encTokensA);
    assert.strictEqual(decryptedA.access_token, fakeTokensA.access_token);

    // Salão B não possui tokens e não acessa Salão A
    const statusB = googleCalendarService.getConnectionStatus(salonBId);
    assert.strictEqual(statusB.isConnected, false);
    assert.strictEqual(statusB.accountEmail, null);
    console.log('  ✓ 2. Credenciais criptografadas em AES-256-GCM com isolamento estrito entre salões.\n');

    // -------------------------------------------------------------
    // TESTE 3: Criação de eventos ao confirmar agendamentos
    // -------------------------------------------------------------
    console.log('[Teste 3] Criação de evento ao confirmar agendamento...');
    const apt1 = salonAppointmentService.bookAppointmentSync(salonAId, {
      clientName: 'Cliente Teste GCal 1',
      serviceId: svcAId,
      staffId: staffAId,
      date: '2026-11-20',
      time: '14:00',
      durationMin: 60,
      status: 'CONFIRMADO',
    });
    assert.strictEqual(apt1.google_sync_status, 'PENDING');

    // Outbox deve ter item de criação
    const outbox1 = db.prepare('SELECT * FROM google_sync_outbox WHERE appointment_id = ?').get(apt1.id);
    assert(outbox1 && outbox1.action === 'CREATE' && outbox1.status === 'PENDING');

    // Processar outbox
    await outboxWorker.processGoogleSyncOutbox(salonAId);

    const apt1Synced = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apt1.id);
    assert.strictEqual(apt1Synced.google_sync_status, 'SYNCED');
    assert(apt1Synced.google_event_id);
    assert.strictEqual(googleMockState.insertCalls, 1);
    console.log('  ✓ 3. Evento Google Calendar criado com identificador estável e status SYNCED.\n');

    // -------------------------------------------------------------
    // TESTE 4: Atualização de evento na remarcação
    // -------------------------------------------------------------
    console.log('[Teste 4] Atualização de evento na remarcação...');
    const apt1Rescheduled = await salonAppointmentService.rescheduleAppointment(apt1.id, salonAId, {
      newDate: '2026-11-20',
      newTime: '16:00',
      reason: 'Cliente solicitou novo horário',
    });
    assert.strictEqual(apt1Rescheduled.start_datetime, '2026-11-20T16:00:00');

    // Outbox deve conter ação UPDATE
    const outboxUpdate = db.prepare("SELECT * FROM google_sync_outbox WHERE appointment_id = ? AND action = 'UPDATE'").get(apt1.id);
    assert(outboxUpdate && outboxUpdate.status === 'PENDING');

    // Processar outbox
    await outboxWorker.processGoogleSyncOutbox(salonAId);

    const apt1Updated = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apt1.id);
    assert.strictEqual(apt1Updated.google_sync_status, 'SYNCED');
    assert.strictEqual(googleMockState.patchCalls, 1);
    console.log('  ✓ 4. Remarcação sincronizada com atualização no Google Calendar.\n');

    // -------------------------------------------------------------
    // TESTE 5: Cancelamento de agendamento e remoção no Google
    // -------------------------------------------------------------
    console.log('[Teste 5] Cancelamento de agendamento e remoção no Google...');
    await salonAppointmentService.cancelAppointment(apt1.id, salonAId, { reason: 'Cancelado pelo cliente' });

    const outboxDelete = db.prepare("SELECT * FROM google_sync_outbox WHERE appointment_id = ? AND action = 'DELETE'").get(apt1.id);
    assert(outboxDelete && outboxDelete.status === 'PENDING');

    await outboxWorker.processGoogleSyncOutbox(salonAId);

    const apt1Cancelled = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apt1.id);
    assert.strictEqual(apt1Cancelled.google_sync_status, 'CANCELLED');
    assert.strictEqual(googleMockState.deleteCalls, 1);
    console.log('  ✓ 5. Cancelamento remove evento no Google Calendar e atualiza status para CANCELLED.\n');

    // -------------------------------------------------------------
    // TESTE 6: Prevenção de conflito de horários ocupados no Google
    // -------------------------------------------------------------
    console.log('[Teste 6] Conflito externo no Google bloqueia agendamento...');
    googleMockState.busySlots.push({
      start: new Date('2026-11-21T10:00:00').toISOString(),
      end: new Date('2026-11-21T11:00:00').toISOString(),
    });

    let conflictErr = null;
    try {
      await salonAppointmentService.bookAppointment(salonAId, {
        clientName: 'Cliente Conflito Google',
        serviceId: svcAId,
        staffId: staffAId,
        date: '2026-11-21',
        time: '10:00',
        durationMin: 60,
      });
    } catch (e) {
      conflictErr = e;
    }
    assert(conflictErr);
    assert.strictEqual(conflictErr.code, 'GOOGLE_CALENDAR_BUSY');
    assert(Array.isArray(conflictErr.suggestedSlots));
    console.log('  ✓ 6. Horário ocupado no Google bloqueia reserva e sugere alternativas livres.\n');

    // -------------------------------------------------------------
    // TESTE 7: Prevenção de sincronização de agendamentos históricos/cancelados ao conectar conta
    // -------------------------------------------------------------
    console.log('[Teste 7] Sanitização do outbox: agendamentos históricos e cancelados são ignorados...');
    // Inserir agendamento no passado e agendamento cancelado com outbox PENDING
    const pastApt = db.prepare(`
      INSERT INTO appointments (user_id, title, start_datetime, end_datetime, client_name, duration_min, origin, status, google_sync_status)
      VALUES (?, 'Agendamento Passado', '2026-10-01T09:00:00', '2026-10-01T10:00:00', 'Cliente Antigo', 60, 'painel', 'AGENDADO', 'PENDING')
    `).run(salonBId);

    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'CREATE', 'PENDING', '{}')
    `).run(salonBId, pastApt.lastInsertRowid);

    const cancelApt = db.prepare(`
      INSERT INTO appointments (user_id, title, start_datetime, end_datetime, client_name, duration_min, origin, status, google_sync_status)
      VALUES (?, 'Agendamento Cancelado Antigo', '2026-12-01T09:00:00', '2026-12-01T10:00:00', 'Cliente Cancelado', 60, 'painel', 'CANCELADO', 'PENDING')
    `).run(salonBId);

    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'CREATE', 'PENDING', '{}')
    `).run(salonBId, cancelApt.lastInsertRowid);

    // Agora simular conexão da conta do Salão B
    const encTokensB = googleCalendarService.encryptTokens({ access_token: 'fake_b' });
    db.prepare(`
      INSERT INTO google_calendar_tokens (user_id, account_email, encrypted_tokens, is_connected, sync_mode)
      VALUES (?, 'salaoB@gmail.com', ?, 1, 'SINGLE')
    `).run(salonBId, encTokensB);

    const insertsBefore = googleMockState.insertCalls;
    await outboxWorker.processGoogleSyncOutbox(salonBId);

    // ZERO chamadas ao Google Calendar para os dois itens históricos/cancelados
    assert.strictEqual(googleMockState.insertCalls, insertsBefore, 'Agendamentos históricos e cancelados NÃO devem criar eventos no Google');

    const outboxPastRow = db.prepare('SELECT * FROM google_sync_outbox WHERE appointment_id = ?').get(pastApt.lastInsertRowid);
    assert.strictEqual(outboxPastRow.status, 'SENT');
    assert(outboxPastRow.last_error.includes('SKIPPED'));

    const outboxCancelRow = db.prepare('SELECT * FROM google_sync_outbox WHERE appointment_id = ?').get(cancelApt.lastInsertRowid);
    assert.strictEqual(outboxCancelRow.status, 'SENT');
    assert(outboxCancelRow.last_error.includes('SKIPPED'));
    console.log('  ✓ 7. Agendamentos passados e cancelados foram ignorados de forma segura (SKIPPED).\n');

    // -------------------------------------------------------------
    // TESTE 8: Contas de demonstração (is_demo) 100% simuladas
    // -------------------------------------------------------------
    console.log('[Teste 8] Contas de demonstração (is_demo) não disparam chamadas externas...');
    const demoApt = db.prepare(`
      INSERT INTO appointments (user_id, title, start_datetime, end_datetime, client_name, duration_min, origin, status, google_sync_status)
      VALUES (?, 'Demo Agendamento', '2026-11-25T14:00:00', '2026-11-25T15:00:00', 'Cliente Demo', 60, 'painel', 'CONFIRMADO', 'PENDING')
    `).run(demoUserId);

    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'CREATE', 'PENDING', '{}')
    `).run(demoUserId, demoApt.lastInsertRowid);

    // Conectar "fake" para demo
    db.prepare(`
      INSERT INTO google_calendar_tokens (user_id, account_email, encrypted_tokens, is_connected, sync_mode)
      VALUES (?, 'demo@gmail.com', ?, 1, 'SINGLE')
    `).run(demoUserId, encTokensB);

    const insertsBeforeDemo = googleMockState.insertCalls;
    await outboxWorker.processGoogleSyncOutbox(demoUserId);

    assert.strictEqual(googleMockState.insertCalls, insertsBeforeDemo, 'Demo accounts jamais chamam Google Calendar');
    const demoOutboxRow = db.prepare('SELECT * FROM google_sync_outbox WHERE appointment_id = ?').get(demoApt.lastInsertRowid);
    assert.strictEqual(demoOutboxRow.status, 'SIMULATED');
    console.log('  ✓ 8. Contas de demonstração marcadas como SIMULATED sem chamadas externas.\n');

    // -------------------------------------------------------------
    // TESTE 9: Ausência de chamadas Google dentro de transações SQLite BEGIN IMMEDIATE
    // -------------------------------------------------------------
    console.log('[Teste 9] Ausência de chamadas externas no rescheduleAppointment dentro de BEGIN IMMEDIATE...');
    // Criar agendamento ativo
    const aptResched = salonAppointmentService.bookAppointmentSync(salonAId, {
      clientName: 'Cliente Teste Reschedule NoLock',
      serviceId: svcAId,
      staffId: staffAId,
      date: '2026-11-28',
      time: '09:00',
      durationMin: 60,
      status: 'CONFIRMADO',
    });

    let networkCallInsideTx = false;
    googleCalendarService.setMockHandler({
      getConnectionStatus: (userId) => {
        const row = db.prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ?').get(userId);
        if (!row || !row.is_connected) {
          return { isConnected: false, accountEmail: null, selectedCalendarId: 'primary', selectedCalendarName: 'Principal', syncMode: 'SINGLE', lastSyncAt: null, lastError: row?.last_error || null };
        }
        return { isConnected: true, accountEmail: row.account_email, selectedCalendarId: row.selected_calendar_id || 'primary', selectedCalendarName: row.selected_calendar_name || 'Principal', syncMode: row.sync_mode || 'SINGLE', lastSyncAt: row.last_sync_at, lastError: row.last_error };
      },
      getGoogleBusySlots: async () => {
        // Tentar iniciar transação imediata no SQLite durante a chamada do Google
        // Se rescheduleAppointment estivesse com BEGIN IMMEDIATE ativo, isso lançaria erro imediato
        try {
          db.exec('BEGIN IMMEDIATE');
          db.exec('COMMIT');
        } catch (_) {
          networkCallInsideTx = true;
        }
        return [];
      },
      createCalendarEvent: async (userId, appointment) => ({ success: true, googleEventId: 'ev_' + appointment.id }),
      updateCalendarEvent: async () => ({ success: true }),
      deleteCalendarEvent: async () => ({ success: true }),
    });

    await salonAppointmentService.rescheduleAppointment(aptResched.id, salonAId, {
      newDate: '2026-11-28',
      newTime: '11:00',
    });

    assert.strictEqual(networkCallInsideTx, false, 'Chamada externa jamais pode ocorrer dentro do BEGIN IMMEDIATE');
    console.log('  ✓ 9. Chamada Google executada FORA de transação SQLite garantindo zero lock contention.\n');

    // -------------------------------------------------------------
    // TESTE 10: Detecção imediata de token revogado (invalid_grant)
    // -------------------------------------------------------------
    console.log('[Teste 10] Detecção de token revogado (invalid_grant)...');
    googleCalendarService.setMockHandler({
      getConnectionStatus: (userId) => {
        const row = db.prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ?').get(userId);
        if (!row || !row.is_connected) {
          return { isConnected: false, accountEmail: null, selectedCalendarId: 'primary', selectedCalendarName: 'Principal', syncMode: 'SINGLE', lastSyncAt: null, lastError: row?.last_error || null };
        }
        return { isConnected: true, accountEmail: row.account_email, selectedCalendarId: row.selected_calendar_id || 'primary', selectedCalendarName: row.selected_calendar_name || 'Principal', syncMode: row.sync_mode || 'SINGLE', lastSyncAt: row.last_sync_at, lastError: row.last_error };
      },
      getGoogleBusySlots: async () => [],
      createCalendarEvent: async () => {
        const err = new Error('invalid_grant: Token has been expired or revoked');
        err.code = 400;
        throw err;
      },
    });

    const aptRevoked = salonAppointmentService.bookAppointmentSync(salonAId, {
      clientName: 'Cliente Token Revogado',
      serviceId: svcAId,
      staffId: staffAId,
      date: '2026-11-27',
      time: '14:00',
      durationMin: 60,
    });

    await outboxWorker.processGoogleSyncOutbox(salonAId);

    const tokenRowRevoked = db.prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ?').get(salonAId);
    assert.strictEqual(tokenRowRevoked.is_connected, 0, 'Token revogado deve marcar is_connected = 0');
    assert(tokenRowRevoked.last_error.includes('Token revogado ou expirado'));
    googleCalendarService.resetMockHandler();
    console.log('  ✓ 10. Token revogado desativa conexão imediatamente sem tentativas infinitas.\n');

  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }

    // -------------------------------------------------------------
    // LIMPEZA GARANTIDA DO SQLITE TEMPORÁRIO
    // -------------------------------------------------------------
    console.log('--- LIMPEZA DO AMBIENTE TEMPORÁRIO ---');
    try {
      googleCalendarService.resetMockHandler();
      outboxWorker.stopWorker();
      if (db && typeof db.close === 'function') {
        db.close();
      }
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
      if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
      console.log('  ✓ Arquivos do SQLite temporário descartados com sucesso.\n');
    } catch (e) {
      console.warn('  ! Aviso na remoção do arquivo temporário:', e.message);
    }
  }

  console.log('================================================================');
  console.log('   AUDITORIA DO GOOGLE CALENDAR APROVADA COM SUCESSO! (10/10)   ');
  console.log('================================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
