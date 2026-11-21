/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADOS HERMÉTICA (COMANDO 061.1)
 * Validação P0: Resolução do Live-Lock da Outbox Google Calendar sob Master Switch Desligado
 * Branch: security/raia-27-protecoes
 *
 * Padrão Hermético Obrigatório:
 * 1. Isolamento Mandatório: Banco SQLite temporário único em os.tmpdir(), destruído no teardown
 * 2. Módulos Nativos Node 22: node:test e node:assert/strict
 * 3. Fail-Closed de Rede: Mock fail-closed com spy de chamadas garantindo 0 requisições externas
 * 4. Determinismo, Idempotência e Preservação de Fila de Terceiros
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 1. ISOLAMENTO MANDATÓRIO DO BANCO DE DADOS EM os.tmpdir()
const tempDbPath = path.join(
  os.tmpdir(),
  `raia_test_comando061_1_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`
);
process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'homologacao';
process.env.HOMOLOGACAO = 'true';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'chave-ultra-segura-comando061-1-32bytes!';

// Parâmetros Oficiais de Homologação Autorizada
const AUTH_TENANT_ID = 3;
const AUTH_APPOINTMENT_ID = 16;
const AUTH_CALENDAR_ID = 'c_secondary_homolog_061@group.calendar.google.com';
const AUTH_EMAIL = 'homologacao.jessica@raiaagentes.com.br';

// Importação tardia após fixação de process.env.DB_PATH
const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const gatekeeper = require('../src/services/googleCalendarGatekeeper');
const outboxWorker = require('../src/services/outboxWorker');

// Spy de Rede Fail-Closed (Verificação de 0 Chamadas Externas)
const networkSpy = {
  createCalls: [],
  updateCalls: [],
  deleteCalls: [],
  reset() {
    this.createCalls = [];
    this.updateCalls = [];
    this.deleteCalls = [];
  },
  get totalCalls() {
    return this.createCalls.length + this.updateCalls.length + this.deleteCalls.length;
  },
};

// Fixtures e Helpers
function seedDatabase() {
  db.prepare('DELETE FROM google_sync_outbox').run();
  db.prepare('DELETE FROM appointments').run();
  db.prepare('DELETE FROM google_calendar_tokens').run();
  db.prepare('DELETE FROM client_salons').run();
  db.prepare('DELETE FROM users').run();

  // Tenant Autorizado (user_id = 3) com assinatura ativa do Módulo Jéssica
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, is_demo)
    VALUES (?, '5511999990003', 'Salão Jéssica Homologação', 'USER', 'PRO', 0)
  `).run(AUTH_TENANT_ID);

  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  if (jessicaProd) {
    db.prepare(`
      INSERT OR REPLACE INTO customer_subscriptions (
        user_id, product_id, status, price_cents, access_expires_at, paid_until
      ) VALUES (?, ?, 'ACTIVE', 9700, datetime('now', '+30 days'), datetime('now', '+30 days'))
    `).run(AUTH_TENANT_ID, jessicaProd.id);
  }

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, google_selected_calendar_id)
    VALUES (?, 'Salão Jéssica', ?)
  `).run(AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  const encTokens = googleCalendarService.encryptTokens({
    access_token: 'fake-token-test-061-1',
    refresh_token: 'fake-refresh-test-061-1',
  });

  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id, is_connected,
      sync_existing_authorized, initial_connection_at, connected_at
    ) VALUES (?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(AUTH_TENANT_ID, AUTH_EMAIL, encTokens, AUTH_CALENDAR_ID);

  // Tenant Terceiro Não Autorizado (user_id = 2)
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, is_demo)
    VALUES (2, '5511999990002', 'Outro Salão 2', 'USER', 'PRO', 0)
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, google_selected_calendar_id)
    VALUES (2, 'Outro Salão', 'c_outro_cal@group.calendar.google.com')
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id, is_connected,
      sync_existing_authorized, initial_connection_at, connected_at
    ) VALUES (2, 'outro@salao.com', ?, 'c_outro_cal@group.calendar.google.com', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(encTokens);
}

test.before(() => {
  seedDatabase();

  // Mock fail-closed estrito interceptando o serviço Google Calendar
  googleCalendarService.setMockHandler({
    createCalendarEvent: async (userId, apt, targetCalId) => {
      networkSpy.createCalls.push({ userId, aptId: apt.id, targetCalId });
      return { success: true, googleEventId: `gcal_live_${apt.id}`, calendarId: targetCalId };
    },
    updateCalendarEvent: async (userId, eventId, apt, targetCalId) => {
      networkSpy.updateCalls.push({ userId, eventId, aptId: apt.id, targetCalId });
      return { success: true, googleEventId: eventId, calendarId: targetCalId };
    },
    deleteCalendarEvent: async (userId, eventId, targetCalId) => {
      networkSpy.deleteCalls.push({ userId, eventId, targetCalId });
      return { success: true };
    },
  });
});

test.after(() => {
  googleCalendarService.resetMockHandler();
  try {
    db.close();
  } catch (_) {}

  // Excluir base SQLite temporária e arquivos de journaling
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDbPath + '-wal')) fs.unlinkSync(tempDbPath + '-wal');
    if (fs.existsSync(tempDbPath + '-shm')) fs.unlinkSync(tempDbPath + '-shm');
  } catch (_) {}
});

test.beforeEach(() => {
  networkSpy.reset();
  db.prepare('DELETE FROM google_sync_outbox').run();
  db.prepare('DELETE FROM appointments').run();

  // Configuração padrão de homologação
  process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
  process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = String(AUTH_TENANT_ID);
  process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = String(AUTH_APPOINTMENT_ID);
  process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = AUTH_CALENDAR_ID;
  process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = AUTH_EMAIL;
  process.env.GOOGLE_SYNC_ALLOWED_EMAILS = AUTH_EMAIL;
});

// =============================================================================
// CENÁRIO 1: Tenant 3 e Agendamento 16 autorizados com GOOGLE_SYNC_LIVE_ENABLED=false
// =============================================================================
test('1. Tarefa autorizada em homologação transiciona para SIMULATED em 1 único ciclo (Fim do Live-Lock)', async () => {
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

  // 1. Criar agendamento autorizado 16
  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, ?, 'Corte & Escova Autorizado', '2026-12-01 10:00:00', '2026-12-01 11:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(AUTH_APPOINTMENT_ID, AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  // 2. Inserir tarefa 21 na outbox
  const outboxInsert = db.prepare(`
    INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status, attempts)
    VALUES (21, ?, ?, 'CREATE', 'PENDING', 0)
  `).run(AUTH_TENANT_ID, AUTH_APPOINTMENT_ID);
  const outboxId = outboxInsert.lastInsertRowid;

  // 3. Execução do Worker (Ciclo 1)
  const processedCount = await outboxWorker.processGoogleSyncOutbox();

  // Validações estritas:
  assert.equal(processedCount, 1, 'Worker deve processar exatamente 1 tarefa em 1 ciclo');

  const itemAfter = db.prepare('SELECT status, attempts, locked_at, processed_at, last_error FROM google_sync_outbox WHERE id = ?').get(outboxId);
  const aptAfter = db.prepare('SELECT google_sync_status, google_event_id, google_sync_error FROM appointments WHERE id = ?').get(AUTH_APPOINTMENT_ID);

  // Asserções da tarefa na outbox
  assert.equal(itemAfter.status, 'SIMULATED', 'Outbox status deve transicionar para SIMULATED');
  assert.equal(itemAfter.locked_at, null, 'locked_at deve ser NULL após conclusão');
  assert.ok(itemAfter.processed_at !== null, 'processed_at deve ser NOT NULL');
  assert.match(itemAfter.last_error, /LIVE_SYNC_DISABLED/, 'last_error deve indicar LIVE_SYNC_DISABLED');

  // Asserções do agendamento correspondente
  assert.equal(aptAfter.google_sync_status, 'SIMULATED', 'Agendamento deve transicionar para SIMULATED');
  assert.ok(typeof aptAfter.google_event_id === 'string' && aptAfter.google_event_id.startsWith('sim_gcal_'), 'google_event_id deve iniciar com sim_gcal_');

  // Zero chamadas de rede externas
  assert.equal(networkSpy.totalCalls, 0, 'Zero chamadas de rede externas efetuadas');
});

// =============================================================================
// CENÁRIO 2: Tenant e Agendamento NÃO Autorizados em Homologação Restrita
// =============================================================================
test('2. Tenant e agendamento não autorizados têm lock liberado para PENDING e agendamento intacto', async () => {
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

  const otherUserId = 2;
  const otherAptId = 99;

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status)
    VALUES (?, ?, 'Compromisso Não Autorizado', '2026-12-01 14:00:00', '2026-12-01 15:00:00', 'AGENDADO', 'PENDING')
  `).run(otherAptId, otherUserId);

  const outboxInsert = db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, attempts)
    VALUES (?, ?, 'CREATE', 'PENDING', 0)
  `).run(otherUserId, otherAptId);
  const outboxId = outboxInsert.lastInsertRowid;

  // Execução do Worker em modo homologação restrita
  const processedCount = await outboxWorker.processGoogleSyncOutbox();

  assert.equal(processedCount, 0, 'Nenhuma tarefa de terceiro deve ser computada como processada');

  const otherItem = db.prepare('SELECT status, locked_at, processed_at FROM google_sync_outbox WHERE id = ?').get(outboxId);
  const otherApt = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(otherAptId);

  assert.equal(otherItem.status, 'PENDING', 'Fila de terceiro deve permanecer em PENDING');
  assert.equal(otherItem.locked_at, null, 'locked_at deve ser NULL');
  assert.equal(otherItem.processed_at, null, 'processed_at deve ser NULL');
  assert.equal(otherApt.google_sync_status, 'PENDING', 'Agendamento de terceiro não deve ser modificado para SIMULATED');
  assert.equal(otherApt.google_event_id, null, 'google_event_id deve permanecer inalterado');
  assert.equal(networkSpy.totalCalls, 0, 'Zero chamadas de rede externas');
});

// =============================================================================
// CENÁRIO 3: Reprocessamento Idempotente
// =============================================================================
test('3. Reprocessamento do worker sobre tarefa já SIMULATED resulta em processedCount = 0 sem efeitos colaterais', async () => {
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

  const simEventId = 'sim_gcal_f7b2c9e10a8d65432100aabb';
  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_event_id)
    VALUES (?, ?, 'Corte Idempotência', '2026-12-01 10:00:00', '2026-12-01 11:00:00', 'AGENDADO', 'SIMULATED', ?)
  `).run(AUTH_APPOINTMENT_ID, AUTH_TENANT_ID, simEventId);

  db.prepare(`
    INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status, locked_at, processed_at, last_error)
    VALUES (21, ?, ?, 'CREATE', 'SIMULATED', NULL, CURRENT_TIMESTAMP, 'HOMOLOGAÇÃO [LIVE_SYNC_DISABLED]: Sincronização simulada em ambiente seguro')
  `).run(AUTH_TENANT_ID, AUTH_APPOINTMENT_ID);

  // Executa o worker uma segunda vez
  const processedCount = await outboxWorker.processGoogleSyncOutbox();

  assert.equal(processedCount, 0, 'Reprocessamento sobre banco com tarefa SIMULATED não deve processar nada');

  const itemAfter = db.prepare('SELECT status, locked_at, processed_at FROM google_sync_outbox WHERE id = 21').get();
  const aptAfter = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(AUTH_APPOINTMENT_ID);

  assert.equal(itemAfter.status, 'SIMULATED', 'Status deve permanecer SIMULATED');
  assert.equal(itemAfter.locked_at, null, 'locked_at deve permanecer NULL');
  assert.equal(aptAfter.google_sync_status, 'SIMULATED', 'Agendamento deve permanecer SIMULATED');
  assert.equal(aptAfter.google_event_id, simEventId, 'google_event_id deve se manter inalterado');
  assert.equal(networkSpy.totalCalls, 0, 'Zero chamadas de rede externas');
});

// =============================================================================
// CENÁRIO 4: Preservação de Eventos Reais Anteriores
// =============================================================================
test('4. Agendamento com google_event_id real NÃO é sobrescrito por ID simulado em UPDATE sob Live Switch desligado', async () => {
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

  const REAL_EVENT_ID = 'real_google_evt_xyz_98765';

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_event_id, google_calendar_id)
    VALUES (?, ?, 'Corte com Evento Real', '2026-12-01 10:00:00', '2026-12-01 11:00:00', 'AGENDADO', 'SYNCED', ?, ?)
  `).run(AUTH_APPOINTMENT_ID, AUTH_TENANT_ID, REAL_EVENT_ID, AUTH_CALENDAR_ID);

  const outboxInsert = db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, attempts)
    VALUES (?, ?, 'UPDATE', 'PENDING', 0)
  `).run(AUTH_TENANT_ID, AUTH_APPOINTMENT_ID);
  const outboxId = outboxInsert.lastInsertRowid;

  const processedCount = await outboxWorker.processGoogleSyncOutbox();
  assert.equal(processedCount, 1, 'Worker deve processar a tarefa');

  const aptAfter = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(AUTH_APPOINTMENT_ID);
  const itemAfter = db.prepare('SELECT status FROM google_sync_outbox WHERE id = ?').get(outboxId);

  assert.equal(itemAfter.status, 'SIMULATED', 'Outbox transiciona para SIMULATED');
  assert.equal(aptAfter.google_event_id, REAL_EVENT_ID, 'O google_event_id real anterior NUNCA deve ser sobrescrito pelo ID simulado');
  assert.equal(aptAfter.google_sync_status, 'SIMULATED', 'Status de sincronização atualiza para SIMULATED');
  assert.equal(networkSpy.totalCalls, 0, 'Zero chamadas de rede externas');
});

// =============================================================================
// CENÁRIO 5: Zero Chamadas Externas de Rede com GOOGLE_SYNC_LIVE_ENABLED=false
// =============================================================================
test('5. Zero requisições externas para a API Google Calendar com GOOGLE_SYNC_LIVE_ENABLED=false', async () => {
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, ?, 'Corte Volume', '2026-12-01 10:00:00', '2026-12-01 11:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(AUTH_APPOINTMENT_ID, AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, attempts)
    VALUES (?, ?, 'CREATE', 'PENDING', 0)
  `).run(AUTH_TENANT_ID, AUTH_APPOINTMENT_ID);

  await outboxWorker.processGoogleSyncOutbox();

  assert.equal(networkSpy.totalCalls, 0, 'Rigor absoluto: zero chamadas efetuadas');
  assert.equal(networkSpy.createCalls.length, 0);
  assert.equal(networkSpy.updateCalls.length, 0);
  assert.equal(networkSpy.deleteCalls.length, 0);
});

// =============================================================================
// CENÁRIO 6: Reativação Futura da Escrita (GOOGLE_SYNC_LIVE_ENABLED=true)
// =============================================================================
test('6. Reativação futura da escrita ignora tarefas SIMULATED e trata novo agendamento com sim_ como createCalendarEvent', async () => {
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

  // 6.1 Tarefas anteriores com status='SIMULATED' não são selecionadas pelo worker
  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_event_id, google_calendar_id)
    VALUES (101, ?, 'Agendamento Anterior Simulado', '2026-12-02 10:00:00', '2026-12-02 11:00:00', 'AGENDADO', 'SIMULATED', 'sim_gcal_antigo', ?)
  `).run(AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  db.prepare(`
    INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status, processed_at)
    VALUES (101, ?, 101, 'CREATE', 'SIMULATED', CURRENT_TIMESTAMP)
  `).run(AUTH_TENANT_ID);

  // 6.2 Novo agendamento após ativação com evento prefixado por sim_
  // Quando action='UPDATE' e o evento atual for sim_*, o worker deve chamar createCalendarEvent (não updateCalendarEvent)
  process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '102';

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_event_id, google_calendar_id)
    VALUES (102, ?, 'Agendamento Transicionado', '2026-12-02 14:00:00', '2026-12-02 15:00:00', 'AGENDADO', 'SIMULATED', 'sim_gcal_temp102', ?)
  `).run(AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  db.prepare(`
    INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status, attempts)
    VALUES (102, ?, 102, 'UPDATE', 'PENDING', 0)
  `).run(AUTH_TENANT_ID);

  const processedCount = await outboxWorker.processGoogleSyncOutbox();

  assert.equal(processedCount, 1, 'Apenas o novo agendamento PENDING deve ser processado');

  assert.equal(networkSpy.createCalls.length, 1, 'Deve chamar createCalendarEvent para evento com prefixo sim_');
  assert.equal(networkSpy.updateCalls.length, 0, 'NÃO deve chamar updateCalendarEvent no Google para ID fictício');
  assert.equal(networkSpy.createCalls[0].aptId, 102);

  const apt101 = db.prepare('SELECT google_sync_status FROM appointments WHERE id = 101').get();
  assert.equal(apt101.google_sync_status, 'SIMULATED', 'Tarefa anterior 101 permaneceu SIMULATED');
});
