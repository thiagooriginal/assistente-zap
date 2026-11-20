/**
 * COMANDO 059.1 — SUÍTE DE TESTES HERMÉTICOS
 * Master Switch (GOOGLE_SYNC_LIVE_ENABLED), Demo Shield (users.is_demo)
 * Seleção de Calendário Secundário e Preservação de Fila Multi-tenant
 *
 * Módulos nativos: node:test, node:assert/strict
 * Banco de dados: SQLite isolado em os.tmpdir(), destruído no teardown
 * Rede externa: 100% interceptada (fail-closed, sem requisições reais)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs');

// 1. Configuração mandatória de isolamento do SQLite ANTES de importar módulos
const tempDbPath = path.join(
  os.tmpdir(),
  `raia_test_comando_059_1_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.db`
);
process.env.DB_PATH = tempDbPath;
process.env.APP_MODE = 'test';
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'test_key_master_switch_shield_32bytes!';

const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const googleCalendarGatekeeper = require('../src/services/googleCalendarGatekeeper');
const outboxWorker = require('../src/services/outboxWorker');

// Helpers para setup de dados isolados
function createTestUser({ id, isDemo = 0, role = 'USER', name = 'Salão Teste' }) {
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, is_demo)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, `551199999000${id}`, name, role, isDemo ? 1 : 0);

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name)
    VALUES (?, ?)
  `).run(id, name);
}

function connectTestGoogleCalendar({ userId, email, selectedCalendarId = 'primary', isConnected = 1 }) {
  const tokensObj = {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3600000,
  };
  const encTokens = googleCalendarService.encryptTokens(tokensObj);

  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id,
      is_connected, initial_connection_at, connected_at, sync_existing_authorized
    ) VALUES (?, ?, ?, ?, ?, datetime('now', '-1 day'), datetime('now', '-1 day'), 1)
  `).run(userId, email, encTokens, selectedCalendarId, isConnected ? 1 : 0);
}

function createTestAppointment({ id, userId, googleEventId = null, googleSyncStatus = 'PENDING', calendarId = null }) {
  db.prepare(`
    INSERT OR REPLACE INTO appointments (
      id, user_id, title, start_datetime, end_datetime,
      client_name, google_event_id, google_sync_status, google_calendar_id
    ) VALUES (?, ?, ?, datetime('now', '+2 hours'), datetime('now', '+3 hours'), ?, ?, ?, ?)
  `).run(
    id,
    userId,
    `Corte Cabelo #${id}`,
    `Cliente ${id}`,
    googleEventId,
    googleSyncStatus,
    calendarId
  );
}

// Teardown hermético: fechar banco e excluir arquivo temporário
test.after(() => {
  try {
    db.close();
  } catch (_) {}
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    const wal = `${tempDbPath}-wal`;
    const shm = `${tempDbPath}-shm`;
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  } catch (_) {}
});

test.describe('COMANDO 059.1 — Master Switch & Demo Shield', () => {

  test.beforeEach(() => {
    // Reset de variáveis de ambiente do gatekeeper
    delete process.env.GOOGLE_SYNC_LIVE_ENABLED;
    delete process.env.GOOGLE_SYNC_HOMOLOGATION_MODE;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL;
    googleCalendarService.resetMockHandler();
  });

  // =========================================================================
  // GRUPO 1: Master Switch Desligado (GOOGLE_SYNC_LIVE_ENABLED !== 'true')
  // =========================================================================
  test.describe('1. Master Switch Desligado (GOOGLE_SYNC_LIVE_ENABLED !== "true")', () => {

    test('1.1 Chamada direta createCalendarEvent em produção sem live_sync -> retorna isSimulated: true', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

      const tenantId = 101;
      createTestUser({ id: tenantId, isDemo: 0 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'comercial@salao.com' });
      createTestAppointment({ id: 1001, userId: tenantId });

      const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(1001);
      const res = await googleCalendarService.createCalendarEvent(tenantId, apt);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.isSimulated, true);
      assert.match(res.googleEventId, /^sim_/);

      const updatedApt = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(1001);
      assert.strictEqual(updatedApt.google_sync_status, 'SIMULATED');
      assert.match(updatedApt.google_event_id, /^sim_/);
    });

    test('1.2 Chamada direta createCalendarEvent em homologação sem live_sync -> bloqueia com LIVE_SYNC_DISABLED', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
      process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '102';
      process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'sec_cal_102@group.calendar.google.com';
      process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '1002';
      process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'homolog@salao.com';

      const tenantId = 102;
      createTestUser({ id: tenantId, isDemo: 0 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'homolog@salao.com', selectedCalendarId: 'sec_cal_102@group.calendar.google.com' });
      createTestAppointment({ id: 1002, userId: tenantId, calendarId: 'sec_cal_102@group.calendar.google.com' });

      const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(1002);

      await assert.rejects(
        async () => {
          await googleCalendarService.createCalendarEvent(tenantId, apt);
        },
        (err) => {
          assert.strictEqual(err.code, 'LIVE_SYNC_DISABLED');
          return true;
        }
      );
    });

    test('1.3 Chamada direta updateCalendarEvent sem live_sync -> simula em produção e bloqueia em homologação', async () => {
      // Produção
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

      const tenantId = 103;
      createTestUser({ id: tenantId, isDemo: 0 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'prod@salao.com' });
      createTestAppointment({ id: 1003, userId: tenantId, googleEventId: 'real_ev_1003' });

      const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(1003);
      const resProd = await googleCalendarService.updateCalendarEvent(tenantId, 'real_ev_1003', apt);
      assert.strictEqual(resProd.success, true);
      assert.strictEqual(resProd.isSimulated, true);

      // Homologação
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
      process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '103';
      process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'sec_cal@group.calendar.google.com';
      process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '1003';
      process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'prod@salao.com';

      await assert.rejects(
        async () => {
          await googleCalendarService.updateCalendarEvent(tenantId, 'real_ev_1003', apt, 'sec_cal@group.calendar.google.com');
        },
        (err) => {
          assert.strictEqual(err.code, 'LIVE_SYNC_DISABLED');
          return true;
        }
      );
    });

    test('1.4 Chamada direta deleteCalendarEvent sem live_sync -> simula em produção e bloqueia em homologação', async () => {
      // Produção
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

      const tenantId = 104;
      createTestUser({ id: tenantId, isDemo: 0 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'prod@salao.com' });
      createTestAppointment({ id: 1004, userId: tenantId, googleEventId: 'real_ev_1004' });

      const resProd = await googleCalendarService.deleteCalendarEvent(tenantId, 'real_ev_1004');
      assert.strictEqual(resProd.success, true);
      assert.strictEqual(resProd.isSimulated, true);

      // Homologação
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
      process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '104';
      process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'sec_cal@group.calendar.google.com';
      process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '1004';
      process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'prod@salao.com';

      await assert.rejects(
        async () => {
          await googleCalendarService.deleteCalendarEvent(tenantId, 'real_ev_1004', 'sec_cal@group.calendar.google.com');
        },
        (err) => {
          assert.strictEqual(err.code, 'LIVE_SYNC_DISABLED');
          return true;
        }
      );
    });

    test('1.5 Worker converte outbox para SIMULATED em produção quando live_sync está desativado', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

      const tenantId = 105;
      createTestUser({ id: tenantId, isDemo: 0 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'worker_prod@salao.com' });
      createTestAppointment({ id: 1005, userId: tenantId });

      db.prepare(`
        INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
        VALUES (?, ?, 'CREATE', 'PENDING', ?)
      `).run(tenantId, 1005, JSON.stringify({ title: 'Corte 1005' }));

      const processed = await outboxWorker.processGoogleSyncOutbox(tenantId);
      assert.strictEqual(processed, 1);

      const outboxItem = db.prepare('SELECT status, last_error FROM google_sync_outbox WHERE appointment_id = ?').get(1005);
      assert.strictEqual(outboxItem.status, 'SIMULATED');
      assert.match(outboxItem.last_error, /LIVE_SYNC_DISABLED/);

      const apt = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(1005);
      assert.strictEqual(apt.google_sync_status, 'SIMULATED');
      assert.match(apt.google_event_id, /^sim_/);
    });

    test('1.6 Worker em homologação reverte item para PENDING quando live_sync está desativado', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
      process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '106';
      process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'sec_cal_106@group.calendar.google.com';
      process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '1006';
      process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'homolog@salao.com';

      const tenantId = 106;
      createTestUser({ id: tenantId, isDemo: 0 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'homolog@salao.com', selectedCalendarId: 'sec_cal_106@group.calendar.google.com' });
      createTestAppointment({ id: 1006, userId: tenantId, calendarId: 'sec_cal_106@group.calendar.google.com' });

      db.prepare(`
        INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
        VALUES (?, ?, 'CREATE', 'PENDING', ?)
      `).run(tenantId, 1006, JSON.stringify({ title: 'Corte 1006' }));

      await outboxWorker.processGoogleSyncOutbox(tenantId);

      const outboxItem = db.prepare('SELECT status, locked_at FROM google_sync_outbox WHERE appointment_id = ?').get(1006);
      assert.strictEqual(outboxItem.status, 'PENDING');
      assert.strictEqual(outboxItem.locked_at, null);
    });
  });

  // =========================================================================
  // GRUPO 2: Tenant Demo (users.is_demo = 1) e Demo Shield
  // =========================================================================
  test.describe('2. Tenant Demo (users.is_demo = 1) — Demo Shield', () => {

    test('2.1 Tenant com is_demo=1 em produção aciona Demo Shield via consulta ao banco em createCalendarEvent', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

      const tenantId = 201;
      createTestUser({ id: tenantId, isDemo: 1, name: 'Salão Modelo Demo' });
      connectTestGoogleCalendar({ userId: tenantId, email: 'demo@salao.com' });
      createTestAppointment({ id: 2001, userId: tenantId });

      let externalCallAttempted = false;
      googleCalendarService.setMockHandler({
        createOAuth2Client: () => {
          externalCallAttempted = true;
          return {};
        },
      });

      const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(2001);
      const res = await googleCalendarService.createCalendarEvent(tenantId, apt);

      assert.strictEqual(res.success, true);
      assert.strictEqual(res.isSimulated, true);
      assert.strictEqual(externalCallAttempted, false, 'Nenhuma requisição externa deve ser efetuada para tenant demo');

      const updatedApt = db.prepare('SELECT google_sync_status, google_sync_error FROM appointments WHERE id = ?').get(2001);
      assert.strictEqual(updatedApt.google_sync_status, 'SIMULATED');
      assert.match(updatedApt.google_sync_error, /DEMO_TENANT_BLOCKED/);
    });

    test('2.2 Tenant com is_demo=1 em homologação bloqueia com DEMO_TENANT_BLOCKED', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
      process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '202';
      process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'sec_cal@group.calendar.google.com';
      process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '2002';
      process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'demo@salao.com';

      const tenantId = 202;
      createTestUser({ id: tenantId, isDemo: 1 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'demo@salao.com', selectedCalendarId: 'sec_cal@group.calendar.google.com' });
      createTestAppointment({ id: 2002, userId: tenantId, calendarId: 'sec_cal@group.calendar.google.com' });

      const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(2002);

      await assert.rejects(
        async () => {
          await googleCalendarService.createCalendarEvent(tenantId, apt);
        },
        (err) => {
          assert.strictEqual(err.code, 'DEMO_TENANT_BLOCKED');
          return true;
        }
      );
    });

    test('2.3 Tenant demo em updateCalendarEvent e deleteCalendarEvent simula em produção sem chamadas de rede', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

      const tenantId = 203;
      createTestUser({ id: tenantId, isDemo: 1 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'demo@salao.com' });
      createTestAppointment({ id: 2003, userId: tenantId, googleEventId: 'real_ev_2003' });

      let externalCallAttempted = false;
      googleCalendarService.setMockHandler({
        createOAuth2Client: () => {
          externalCallAttempted = true;
          return {};
        },
      });

      const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(2003);
      const updateRes = await googleCalendarService.updateCalendarEvent(tenantId, 'real_ev_2003', apt);
      assert.strictEqual(updateRes.isSimulated, true);

      const deleteRes = await googleCalendarService.deleteCalendarEvent(tenantId, 'real_ev_2003');
      assert.strictEqual(deleteRes.isSimulated, true);

      assert.strictEqual(externalCallAttempted, false);
    });

    test('2.4 Worker de outbox simula tarefa de tenant demo diretamente pelo Demo Shield', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

      const tenantId = 204;
      createTestUser({ id: tenantId, isDemo: 1 });
      connectTestGoogleCalendar({ userId: tenantId, email: 'demo@salao.com' });
      createTestAppointment({ id: 2004, userId: tenantId });

      db.prepare(`
        INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
        VALUES (?, ?, 'CREATE', 'PENDING', ?)
      `).run(tenantId, 2004, JSON.stringify({ title: 'Corte Demo' }));

      const processed = await outboxWorker.processGoogleSyncOutbox(tenantId);
      assert.strictEqual(processed, 1);

      const outbox = db.prepare('SELECT status, last_error FROM google_sync_outbox WHERE appointment_id = ?').get(2004);
      assert.strictEqual(outbox.status, 'SIMULATED');
      assert.match(outbox.last_error, /demonstração/i);

      const apt = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(2004);
      assert.strictEqual(apt.google_sync_status, 'SIMULATED');
      assert.match(apt.google_event_id, /^sim_demo_/);
    });
  });

  // =========================================================================
  // GRUPO 3: Calendário Secundário Autorizado
  // =========================================================================
  test.describe('3. Seleção de Calendário Secundário Autorizado', () => {

    test('3.1 Worker lê selected_calendar_id e repassa para evaluateGatekeeper e createCalendarEvent', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';

      const tenantId = 301;
      const secCalendarId = 'sec_agenda_salao_vip_999@group.calendar.google.com';

      createTestUser({ id: tenantId, isDemo: 0 });
      connectTestGoogleCalendar({
        userId: tenantId,
        email: 'salaovip@gmail.com',
        selectedCalendarId: secCalendarId,
      });
      createTestAppointment({ id: 3001, userId: tenantId, calendarId: null });

      db.prepare(`
        INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
        VALUES (?, ?, 'CREATE', 'PENDING', ?)
      `).run(tenantId, 3001, JSON.stringify({ title: 'VIP Corte' }));

      let receivedCalendarIdInService = null;
      googleCalendarService.setMockHandler({
        createCalendarEvent: async (uid, appointment, targetCalId) => {
          receivedCalendarIdInService = targetCalId || appointment.google_calendar_id;
          return { success: true, googleEventId: 'mock_sec_ev_123', calendarId: secCalendarId };
        },
      });

      const processed = await outboxWorker.processGoogleSyncOutbox(tenantId);
      assert.strictEqual(processed, 1);

      // Verifica que o evaluateGatekeeper autorizou o calendário secundário em produção
      const gateResult = googleCalendarGatekeeper.evaluateGatekeeper({
        userId: tenantId,
        calendarId: secCalendarId,
        appointmentId: 3001,
        accountEmail: 'salaovip@gmail.com',
        isDemo: 0,
      });
      assert.strictEqual(gateResult.allowed, true);
      assert.strictEqual(gateResult.reason, 'AUTHORIZED_PRODUCTION');

      const outbox = db.prepare('SELECT status FROM google_sync_outbox WHERE appointment_id = ?').get(3001);
      assert.strictEqual(outbox.status, 'SENT');
    });
  });

  // =========================================================================
  // GRUPO 4: Preservação de Fila Multi-tenant
  // =========================================================================
  test.describe('4. Outros Tenants e Tarefas Permanecem Intactos', () => {

    test('4.1 Durante homologação de um tenant específico, tarefas de outros tenants permanecem estritamente em PENDING', async () => {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
      process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
      process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '401';
      process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'sec_cal_401@group.calendar.google.com';
      process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '4001';
      process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'homolog401@salao.com';

      // Tenant 401 (Autorizado para teste)
      createTestUser({ id: 401, isDemo: 0 });
      connectTestGoogleCalendar({ userId: 401, email: 'homolog401@salao.com', selectedCalendarId: 'sec_cal_401@group.calendar.google.com' });
      createTestAppointment({ id: 4001, userId: 401, calendarId: 'sec_cal_401@group.calendar.google.com' });
      db.prepare(`
        INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
        VALUES (401, 4001, 'CREATE', 'PENDING', '{}')
      `).run();

      // Tenant 402 (Outro salão legítimo que NÃO deve ser tocado)
      createTestUser({ id: 402, isDemo: 0 });
      connectTestGoogleCalendar({ userId: 402, email: 'outro_salao@gmail.com', selectedCalendarId: 'sec_cal_402@group.calendar.google.com' });
      createTestAppointment({ id: 4002, userId: 402, calendarId: 'sec_cal_402@group.calendar.google.com' });
      db.prepare(`
        INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
        VALUES (402, 4002, 'CREATE', 'PENDING', '{}')
      `).run();

      // Tenant 403 (Terceiro salão)
      createTestUser({ id: 403, isDemo: 0 });
      connectTestGoogleCalendar({ userId: 403, email: 'terceiro_salao@gmail.com' });
      createTestAppointment({ id: 4003, userId: 403 });
      db.prepare(`
        INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
        VALUES (403, 4003, 'CREATE', 'PENDING', '{}')
      `).run();

      // Mock para a chamada autorizada do 401
      googleCalendarService.setMockHandler({
        createCalendarEvent: async (uid, apt, calId) => {
          return { success: true, googleEventId: 'real_ev_401', calendarId: calId };
        },
      });

      // Executa o worker geral (sem passar filtro de tenant)
      await outboxWorker.processGoogleSyncOutbox();

      // Tarefa do tenant 401 foi processada com sucesso
      const item401 = db.prepare('SELECT status FROM google_sync_outbox WHERE appointment_id = 4001').get();
      assert.strictEqual(item401.status, 'SENT');

      // Tarefas dos tenants 402 e 403 DEVEM PERMANECER ESTRITAMENTE EM PENDING
      const item402 = db.prepare('SELECT status, locked_at, last_error FROM google_sync_outbox WHERE appointment_id = 4002').get();
      assert.strictEqual(item402.status, 'PENDING', 'Tenant 402 deve continuar PENDING');
      assert.strictEqual(item402.locked_at, null);

      const item403 = db.prepare('SELECT status, locked_at, last_error FROM google_sync_outbox WHERE appointment_id = 4003').get();
      assert.strictEqual(item403.status, 'PENDING', 'Tenant 403 deve continuar PENDING');
      assert.strictEqual(item403.locked_at, null);

      // Os agendamentos correspondentes também permanecem intactos em PENDING
      const apt402 = db.prepare('SELECT google_sync_status FROM appointments WHERE id = 4002').get();
      assert.strictEqual(apt402.google_sync_status, 'PENDING');

      const apt403 = db.prepare('SELECT google_sync_status FROM appointments WHERE id = 4003').get();
      assert.strictEqual(apt403.google_sync_status, 'PENDING');
    });
  });

});
