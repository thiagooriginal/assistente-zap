/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADOS HERMÉTICA (COMANDO 059)
 * Gatekeeper Quíntuplo de Homologação Real, Preservação de Fila e Anti-Primary Shield
 * 
 * Padrão Obrigatório:
 * - node:test e node:assert/strict (Node 22 nativo)
 * - Banco temporário isolado em os.tmpdir() com cleanup garantido em test.after()
 * - Mocks fail-closed com zero chamadas externas de rede
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 1. ISOLAMENTO MANDATÓRIO DO BANCO DE DADOS
const tempDbPath = path.join(os.tmpdir(), `test-gatekeeper-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.DB_PATH = tempDbPath;
process.env.APP_MODE = 'homologacao';
process.env.HOMOLOGACAO = 'true';
process.env.NODE_ENV = 'test';
process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';

// Constantes dos 5 pinos do Gatekeeper Quíntuplo
const AUTH_TENANT_ID = 101;
const AUTH_CALENDAR_ID = 'c_homologacao_segura_101@group.calendar.google.com';
const AUTH_APPOINTMENT_ID = 5001;
const AUTH_EMAIL = 'homologacao.real@raiaagentes.com.br';

process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = String(AUTH_TENANT_ID);
process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = AUTH_CALENDAR_ID;
process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = String(AUTH_APPOINTMENT_ID);
process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = AUTH_EMAIL;
process.env.GOOGLE_SYNC_ALLOWED_EMAILS = AUTH_EMAIL;
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'chave-ultra-segura-homologacao-32bytes!';

// Carregar módulos após isolamento do DB_PATH
const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const outboxWorker = require('../src/services/outboxWorker');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const gatekeeper = require('../src/services/googleCalendarGatekeeper');

// Harness de Mock Fail-Closed
const mockHarness = {
  createCalls: [],
  deleteCalls: [],
  reset() {
    this.createCalls = [];
    this.deleteCalls = [];
  },
};

test.before(() => {
  // Configurar mock handler fail-closed para simular o Google Calendar quando autorizado
  googleCalendarService.setMockHandler({
    createCalendarEvent: async (userId, appointment, targetCalendarId) => {
      mockHarness.createCalls.push({ userId, appointmentId: appointment.id, targetCalendarId });
      const googleEventId = `gcal_evt_real_${appointment.id}_${Date.now()}`;
      
      db.prepare(`
        UPDATE appointments
        SET google_event_id = ?, google_calendar_id = ?, google_sync_status = 'SYNCED', google_sync_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(googleEventId, targetCalendarId || AUTH_CALENDAR_ID, appointment.id, userId);

      return { success: true, googleEventId, calendarId: targetCalendarId || AUTH_CALENDAR_ID };
    },
    deleteCalendarEvent: async (userId, googleEventId, targetCalendarId) => {
      mockHarness.deleteCalls.push({ userId, googleEventId, targetCalendarId });

      db.prepare(`
        UPDATE appointments
        SET google_sync_status = 'CANCELLED', google_sync_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE google_event_id = ? AND user_id = ?
      `).run(googleEventId, userId);

      return { success: true };
    },
  });

  // Criar dados base para os testes
  // Tenant 101: Autorizado para homologação real
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, is_demo)
    VALUES (?, '5511999990101', 'Salão Autorizado 101', 'USER', 'PRO', 0)
  `).run(AUTH_TENANT_ID);

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, google_selected_calendar_id)
    VALUES (?, 'Salão Homologação Real', ?)
  `).run(AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  const encTokens101 = googleCalendarService.encryptTokens({ access_token: 'fake-live-token-101', refresh_token: 'fake-refresh-101' });
  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id, is_connected, sync_existing_authorized, initial_connection_at, connected_at
    ) VALUES (?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(AUTH_TENANT_ID, AUTH_EMAIL, encTokens101, AUTH_CALENDAR_ID);

  // Tenant 2: Conta Demo (is_demo = 1)
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, is_demo)
    VALUES (2, '5511999990002', 'Conta Demonstração', 'USER', 'FREE_TRIAL', 1)
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, google_selected_calendar_id)
    VALUES (2, 'Salão Demo Teste', ?)
  `).run(AUTH_CALENDAR_ID);

  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id, is_connected, sync_existing_authorized, initial_connection_at, connected_at
    ) VALUES (2, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(AUTH_EMAIL, encTokens101, AUTH_CALENDAR_ID);

  // Tenant 202: Tenant Legítimo mas NÃO Autorizado nesta rodada
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, is_demo)
    VALUES (202, '5511999990202', 'Salão Outro 202', 'USER', 'PRO', 0)
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, google_selected_calendar_id)
    VALUES (202, 'Salão Não Autorizado', ?)
  `).run(AUTH_CALENDAR_ID);

  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id, is_connected, sync_existing_authorized, initial_connection_at, connected_at
    ) VALUES (202, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run('outro.salao202@gmail.com', encTokens101, AUTH_CALENDAR_ID);

  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  if (jessicaProd) {
    db.prepare(`
      INSERT OR REPLACE INTO customer_subscriptions (
        user_id, product_id, status, price_cents, access_expires_at, paid_until
      ) VALUES (?, ?, 'ACTIVE', 9700, datetime('now', '+30 days'), datetime('now', '+30 days'))
    `).run(AUTH_TENANT_ID, jessicaProd.id);

    db.prepare(`
      INSERT OR REPLACE INTO customer_subscriptions (
        user_id, product_id, status, price_cents, access_expires_at, paid_until
      ) VALUES (202, ?, 'ACTIVE', 9700, datetime('now', '+30 days'), datetime('now', '+30 days'))
    `).run(jessicaProd.id);
  }
});

test.after(async () => {
  // Limpeza hermética
  googleCalendarService.resetMockHandler();
  try {
    db.close();
  } catch (_) {}

  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDbPath + '-wal')) fs.unlinkSync(tempDbPath + '-wal');
    if (fs.existsSync(tempDbPath + '-shm')) fs.unlinkSync(tempDbPath + '-shm');
  } catch (_) {}
});

test.beforeEach(() => {
  mockHarness.reset();
  process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
  process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = String(AUTH_TENANT_ID);
  process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = AUTH_CALENDAR_ID;
  process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = String(AUTH_APPOINTMENT_ID);
  process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = AUTH_EMAIL;
  db.prepare("DELETE FROM google_sync_outbox").run();
});

// CENÁRIO 1: Preservação de Fila de Outros Tenants em Homologação
test('1. Preservação de Fila: Tarefas de tenants não autorizados permanecem intactas em PENDING (sem mutação para SIMULATED/CANCELLED)', async () => {
  const aptId = 8001;
  db.prepare(`
    INSERT OR REPLACE INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status)
    VALUES (?, 202, 'Corte Cabelo', '2026-12-01T14:00:00', '2026-12-01T15:00:00', 'AGENDADO', 'PENDING')
  `).run(aptId);

  db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
    VALUES (202, ?, 'CREATE', 'PENDING')
  `).run(aptId);

  // Executa o worker durante a homologação
  await outboxWorker.processGoogleSyncOutbox();

  const outboxItem = db.prepare('SELECT status, last_error, locked_at, processed_at FROM google_sync_outbox WHERE appointment_id = ?').get(aptId);
  const aptItem = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(aptId);

  // A tarefa de outro salão DEVE permanecer rigorosamente em PENDING e sem lock
  assert.equal(outboxItem.status, 'PENDING', 'Item de outro cliente NÃO pode ser alterado para SIMULATED/CANCELLED/SENT');
  assert.equal(outboxItem.locked_at, null, 'Lock deve ser nulo');
  assert.equal(outboxItem.processed_at, null, 'processed_at deve ser nulo');
  assert.equal(aptItem.google_sync_status, 'PENDING', 'Agendamento do outro salão continua PENDING');
  assert.equal(mockHarness.createCalls.length, 0, 'Zero chamadas externas');
});

// CENÁRIO 2: Anti-Primary Shield
test('2. Anti-Primary Shield: calendarId = "primary" ou "default" é bloqueado imediatamente (PRIMARY_CALENDAR_PROHIBITED)', async () => {
  const checkPrimary = gatekeeper.evaluateGatekeeper({
    userId: AUTH_TENANT_ID,
    calendarId: 'primary',
    appointmentId: AUTH_APPOINTMENT_ID,
    accountEmail: AUTH_EMAIL,
    isDemo: false,
  });

  assert.equal(checkPrimary.allowed, false);
  assert.equal(checkPrimary.reason, 'PRIMARY_CALENDAR_PROHIBITED');

  const checkDefault = gatekeeper.evaluateGatekeeper({
    userId: AUTH_TENANT_ID,
    calendarId: 'default',
    appointmentId: AUTH_APPOINTMENT_ID,
    accountEmail: AUTH_EMAIL,
    isDemo: false,
  });

  assert.equal(checkDefault.allowed, false);
  assert.equal(checkDefault.reason, 'PRIMARY_CALENDAR_PROHIBITED');
});

// CENÁRIO 3: Bloqueio de Calendário Divergente
test('3. Bloqueio de Calendário Divergente: calendarId != GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID gera status DIVERGENT_CALENDAR', async () => {
  const check = gatekeeper.evaluateGatekeeper({
    userId: AUTH_TENANT_ID,
    calendarId: 'c_outro_calendario_secundario@group.calendar.google.com',
    appointmentId: AUTH_APPOINTMENT_ID,
    accountEmail: AUTH_EMAIL,
    isDemo: false,
  });

  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'DIVERGENT_CALENDAR');
  assert.equal(mockHarness.createCalls.length, 0);
});

// CENÁRIO 4: Bloqueio de Agendamento Não Autorizado no Mesmo Tenant (Preservação de Fila)
test('4. Bloqueio de Agendamento Não Autorizado: outro agendamento do mesmo tenant permanece intacto em PENDING na fila', async () => {
  const unauthorizedAptId = 9999;
  db.prepare(`
    INSERT OR REPLACE INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, ?, 'Outro Agendamento', '2026-12-01T16:00:00', '2026-12-01T17:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(unauthorizedAptId, AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
    VALUES (?, ?, 'CREATE', 'PENDING')
  `).run(AUTH_TENANT_ID, unauthorizedAptId);

  await outboxWorker.processGoogleSyncOutbox(AUTH_TENANT_ID);

  const outboxItem = db.prepare('SELECT status, locked_at, processed_at FROM google_sync_outbox WHERE appointment_id = ?').get(unauthorizedAptId);
  assert.equal(outboxItem.status, 'PENDING', 'Agendamento não autorizado deve continuar intacto em PENDING');
  assert.equal(outboxItem.locked_at, null);
  assert.equal(mockHarness.createCalls.length, 0);
});

// CENÁRIO 5: Bloqueio de E-mail Divergente
test('5. Bloqueio de E-mail Divergente: accountEmail != GOOGLE_SYNC_AUTHORIZED_EMAIL gera DIVERGENT_EMAIL', async () => {
  const check = gatekeeper.evaluateGatekeeper({
    userId: AUTH_TENANT_ID,
    calendarId: AUTH_CALENDAR_ID,
    appointmentId: AUTH_APPOINTMENT_ID,
    accountEmail: 'outro.email@raiaagentes.com.br',
    isDemo: false,
  });

  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'DIVERGENT_EMAIL');
  assert.equal(mockHarness.createCalls.length, 0);
});

// CENÁRIO 6: Bloqueio Absoluto de Tenant Demo
test('6. Bloqueio Absoluto de Tenant Demo: Tenant 2 (is_demo = 1) bloqueado com DEMO_TENANT_BLOCKED mesmo com pinos idênticos', async () => {
  const check = gatekeeper.evaluateGatekeeper({
    userId: 2,
    calendarId: AUTH_CALENDAR_ID,
    appointmentId: AUTH_APPOINTMENT_ID,
    accountEmail: AUTH_EMAIL,
    isDemo: true,
  });

  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'DEMO_TENANT_BLOCKED', 'Prioridade máxima para bloqueio de conta demo');
});

// CENÁRIO 7: Ciclo Completo Autorizado (1-CREATE e 1-DELETE) com Preservação de Autorização até Confirmação
test('7. Ciclo Completo Autorizado (1-CREATE e 1-DELETE): 5 pinos coincidem -> CREATE (SENT/SYNCED) e cancelAppointment (SENT/CANCELLED)', async () => {
  // A. Criar agendamento elegível para os 5 pinos
  db.prepare(`
    INSERT OR REPLACE INTO appointments (
      id, user_id, title, client_name, start_datetime, end_datetime, status, google_sync_status, google_calendar_id
    ) VALUES (?, ?, 'Corte & Barba Vip', 'Cliente VIP', '2026-12-05T14:00:00', '2026-12-05T15:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(AUTH_APPOINTMENT_ID, AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
    VALUES (?, ?, 'CREATE', 'PENDING')
  `).run(AUTH_TENANT_ID, AUTH_APPOINTMENT_ID);

  // Processar CREATE
  await outboxWorker.processGoogleSyncOutbox(AUTH_TENANT_ID);

  assert.equal(mockHarness.createCalls.length, 1, 'CREATE deve ter sido transmitido ao mock');
  const createOutbox = db.prepare("SELECT status FROM google_sync_outbox WHERE appointment_id = ? AND action = 'CREATE'").get(AUTH_APPOINTMENT_ID);
  const createdApt = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(AUTH_APPOINTMENT_ID);

  assert.equal(createOutbox.status, 'SENT', 'Outbox CREATE transiciona para SENT');
  assert.equal(createdApt.google_sync_status, 'SYNCED', 'Appointment transiciona para SYNCED');
  assert.ok(createdApt.google_event_id.startsWith('gcal_evt_real_'));

  // B. Cancelar agendamento via salonAppointmentService.cancelAppointment
  const cancelResult = await salonAppointmentService.cancelAppointment(AUTH_APPOINTMENT_ID, AUTH_TENANT_ID, {
    reason: 'Desistência formal do cliente homologado',
    cancelledBy: 'SALON_MANAGER'
  });
  assert.equal(cancelResult.success, true);

  // Processar DELETE gerado pelo cancelamento (autorização do appointmentId preservada até o fim)
  await outboxWorker.processGoogleSyncOutbox(AUTH_TENANT_ID);

  assert.equal(mockHarness.deleteCalls.length, 1, 'DELETE deve ter sido transmitido ao mock');
  const deleteOutbox = db.prepare("SELECT status FROM google_sync_outbox WHERE appointment_id = ? AND action = 'DELETE'").get(AUTH_APPOINTMENT_ID);
  const cancelledApt = db.prepare('SELECT status, google_sync_status FROM appointments WHERE id = ?').get(AUTH_APPOINTMENT_ID);

  assert.equal(deleteOutbox.status, 'SENT', 'Outbox DELETE transiciona para SENT após exclusão remota confirmada');
  assert.equal(cancelledApt.status, 'CANCELADO', 'Status do compromisso cancelado');
  assert.equal(cancelledApt.google_sync_status, 'CANCELLED', 'Google Sync status cancelado');

  // C. Validação de Zero SQL Destrutivo e Preservação de Histórico de Auditoria
  const history = db.prepare('SELECT * FROM appointment_status_history WHERE appointment_id = ?').all(AUTH_APPOINTMENT_ID);
  assert.ok(history.length >= 1, 'Histórico de auditoria deve ser estritamente preservado');
  assert.equal(history[0].new_status, 'CANCELADO');
  assert.equal(history[0].changed_by, 'SALON_MANAGER');
  assert.match(history[0].reason, /Desistência formal/);
});

// CENÁRIO 8: Prova de Fila Mista — APENAS o autorizado sincroniza; os outros 2 permanecem INTACTOS em PENDING
test('8. Prova de Fila Mista: De 3 itens simultâneos de diferentes salões/agendamentos, APENAS o autorizado sincroniza; os outros 2 permanecem rigorosamente PENDING', async () => {
  // Item 1: Agendamento Autorizado (5 pinos)
  const apt1 = AUTH_APPOINTMENT_ID;
  db.prepare(`
    INSERT OR REPLACE INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, ?, 'Apt Autorizado', '2026-12-10T10:00:00', '2026-12-10T11:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(apt1, AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  // Item 2: Outro Tenant (Tenant 202)
  const apt2 = 7002;
  db.prepare(`
    INSERT OR REPLACE INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, 202, 'Apt Tenant 202', '2026-12-10T11:00:00', '2026-12-10T12:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(apt2, AUTH_CALENDAR_ID);

  // Item 3: Mesmo Tenant (101), mas outro agendamento não autorizado (7003)
  const apt3 = 7003;
  db.prepare(`
    INSERT OR REPLACE INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, ?, 'Apt Não Autorizado', '2026-12-10T12:00:00', '2026-12-10T13:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(apt3, AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  // Inserir os 3 itens na fila outbox simultaneamente com status PENDING
  db.prepare("INSERT INTO google_sync_outbox (user_id, appointment_id, action, status) VALUES (?, ?, 'CREATE', 'PENDING')").run(AUTH_TENANT_ID, apt1);
  db.prepare("INSERT INTO google_sync_outbox (user_id, appointment_id, action, status) VALUES (202, ?, 'CREATE', 'PENDING')").run(apt2);
  db.prepare("INSERT INTO google_sync_outbox (user_id, appointment_id, action, status) VALUES (?, ?, 'CREATE', 'PENDING')").run(AUTH_TENANT_ID, apt3);

  // Executar o worker global da fila em modo de homologação
  await outboxWorker.processGoogleSyncOutbox();

  // Verificação estrita: APENAS o agendamento autorizado foi tocado
  const res1 = db.prepare('SELECT status FROM google_sync_outbox WHERE appointment_id = ?').get(apt1);
  const res2 = db.prepare('SELECT status, locked_at, processed_at FROM google_sync_outbox WHERE appointment_id = ?').get(apt2);
  const res3 = db.prepare('SELECT status, locked_at, processed_at FROM google_sync_outbox WHERE appointment_id = ?').get(apt3);

  assert.equal(res1.status, 'SENT', 'Item autorizado deve transicionar para SENT');
  assert.equal(res2.status, 'PENDING', 'Item de outro tenant NÃO PODE ser mutado; DEVE continuar PENDING');
  assert.equal(res2.locked_at, null, 'Item 2 não pode ficar travado');
  assert.equal(res3.status, 'PENDING', 'Outro item do mesmo tenant NÃO PODE ser mutado; DEVE continuar PENDING');
  assert.equal(res3.locked_at, null, 'Item 3 não pode ficar travado');

  assert.equal(mockHarness.createCalls.length, 1, 'Exatamente 1 chamada externa permitida no lote inteiro');
  assert.equal(mockHarness.createCalls[0].appointmentId, AUTH_APPOINTMENT_ID, 'Chamada deve pertencer unicamente ao agendamento autorizado');
});

// CENÁRIO 9: Comprovação de que Produção Comercial NÃO depende do Gatekeeper de Homologação
test('9. Produção Comercial Desacoplada: Com GOOGLE_SYNC_HOMOLOGATION_MODE = false, qualquer salão sincroniza normalmente sem variáveis de tenant/appointment único', async () => {
  // Desativar o modo de homologação restrita
  process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';
  delete process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID;
  delete process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID;

  // Permitir e-mail do Salão 202 na allowlist geral de produção
  process.env.GOOGLE_SYNC_ALLOWED_EMAILS = 'outro.salao202@gmail.com';

  const prodAptId = 9101;
  db.prepare(`
    INSERT OR REPLACE INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, 202, 'Corte Produção', '2026-12-15T10:00:00', '2026-12-15T11:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(prodAptId, AUTH_CALENDAR_ID);

  db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
    VALUES (202, ?, 'CREATE', 'PENDING')
  `).run(prodAptId);

  // Executa o worker em modo de produção para o Salão 202
  await outboxWorker.processGoogleSyncOutbox(202);

  const outboxProd = db.prepare('SELECT status FROM google_sync_outbox WHERE appointment_id = ?').get(prodAptId);
  const aptProd = db.prepare('SELECT google_sync_status FROM appointments WHERE id = ?').get(prodAptId);

  assert.equal(outboxProd.status, 'SENT', 'Em produção, agendamento de qualquer salão sincroniza normalmente');
  assert.equal(aptProd.google_sync_status, 'SYNCED');
  assert.equal(mockHarness.createCalls.length, 1, 'Chamada transmitida via OAuth do próprio salão');
});

// CENÁRIO 10: Proteção Contra Chamadas Diretas (Defesa em Profundidade)
test('10. Proteção Contra Chamadas Diretas: Invocação direta a createCalendarEvent/deleteCalendarEvent é bloqueada em homologação se não autorizada', async () => {
  process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
  process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = String(AUTH_TENANT_ID);
  process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = String(AUTH_APPOINTMENT_ID);
  process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = AUTH_CALENDAR_ID;
  process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = AUTH_EMAIL;

  // Temporariamente remove o mock handler para testar a borda de validação do serviço
  googleCalendarService.resetMockHandler();

  // Tentativa direta com agendamento não autorizado (ID 99999)
  await assert.rejects(
    async () => {
      await googleCalendarService.createCalendarEvent(AUTH_TENANT_ID, { id: 99999, title: 'Invasão Direta' }, AUTH_CALENDAR_ID);
    },
    (err) => err.code === 'UNAUTHORIZED_APPOINTMENT' || err.message.includes('HOMOLOGACAO_BLOCKED')
  );

  // Tentativa direta com tenant não autorizado (ID 202)
  await assert.rejects(
    async () => {
      await googleCalendarService.createCalendarEvent(202, { id: AUTH_APPOINTMENT_ID, title: 'Tenant Invasor' }, AUTH_CALENDAR_ID);
    },
    (err) => err.code === 'UNAUTHORIZED_TENANT' || err.message.includes('HOMOLOGACAO_BLOCKED')
  );

  // Tentativa direta com calendário primary (Anti-Primary Shield)
  await assert.rejects(
    async () => {
      await googleCalendarService.createCalendarEvent(AUTH_TENANT_ID, { id: AUTH_APPOINTMENT_ID, title: 'Primary Direto' }, 'primary');
    },
    (err) => err.code === 'PRIMARY_CALENDAR_PROHIBITED' || err.message.includes('PRIMARY_CALENDAR_PROHIBITED')
  );
});
