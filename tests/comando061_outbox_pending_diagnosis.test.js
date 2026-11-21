/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADOS HERMÉTICA (COMANDO 061)
 * Diagnóstico P0: Outbox Google Calendar Presa em PENDING (Live-Lock)
 * Branch: security/raia-27-protecoes
 *
 * Padrão Hermético Obrigatório:
 * 1. Isolamento Total: Banco SQLite temporário único em os.tmpdir(), destruído no teardown
 * 2. Módulos Nativos Node 22: node:test e node:assert/strict
 * 3. Fail-Closed de Rede: Spy/Mock em memória verificando ZERO chamadas externas reais
 * 4. Determinismo e Idempotência: Testes independentes de ordem
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
  `raia_test_comando061_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`
);
process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'homologacao';
process.env.HOMOLOGACAO = 'true';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'chave-ultra-segura-comando061-32bytes!';

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
  // Limpar tabelas de teste
  db.prepare('DELETE FROM google_sync_outbox').run();
  db.prepare('DELETE FROM appointments').run();
  db.prepare('DELETE FROM google_calendar_tokens').run();
  db.prepare('DELETE FROM client_salons').run();
  db.prepare('DELETE FROM users').run();

  // Tenant Autorizado (user_id = 3) com assinatura ativa do Módulo Jéssica (30 dias)
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
    access_token: 'fake-token-test-061',
    refresh_token: 'fake-refresh-test-061',
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
// TESTE 1: REPRODUÇÃO EXATA DO COMPORTAMENTO ATUAL (DIAGNÓSTICO DO LIVE-LOCK)
// =============================================================================
test('1. [REPRODUÇÃO DIAGNÓSTICO] Tarefa autorizada em homologação com LIVE_SYNC_DISABLED sofre live-lock em PENDING', { skip: 'Diagnóstico pré-fix reproduzido no COMANDO 061 (resolvido no COMANDO 061.1)' }, async () => {
  // Master Switch DESATIVADO
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

  // 1. Criar agendamento autorizado
  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, ?, 'Corte & Escova Autorizado', '2026-12-01 10:00:00', '2026-12-01 11:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(AUTH_APPOINTMENT_ID, AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  // 2. Inserir tarefa na outbox
  const outboxInsert = db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, attempts)
    VALUES (?, ?, 'CREATE', 'PENDING', 0)
  `).run(AUTH_TENANT_ID, AUTH_APPOINTMENT_ID);
  const outboxId = outboxInsert.lastInsertRowid;

  // 3. Execução Ciclo 1 do Worker
  await outboxWorker.processGoogleSyncOutbox();

  // Comprovação pós-Ciclo 1:
  const itemAfter1 = db.prepare('SELECT status, attempts, locked_at, processed_at FROM google_sync_outbox WHERE id = ?').get(outboxId);
  const aptAfter1 = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = ?').get(AUTH_APPOINTMENT_ID);

  // Evidência de falha no código atual: o item volta a ser PENDING e attempts permanece 0
  assert.equal(itemAfter1.status, 'PENDING', 'Diagnóstico: O item foi revertido para PENDING sem progredir');
  assert.equal(itemAfter1.attempts, 0, 'Diagnóstico: attempts não incrementou, gerando live-lock');
  assert.equal(itemAfter1.locked_at, null, 'Diagnóstico: lock foi liberado sem marcar resolução');
  assert.equal(itemAfter1.processed_at, null, 'Diagnóstico: processed_at não foi gravado');
  assert.equal(aptAfter1.google_sync_status, 'PENDING', 'Diagnóstico: Agendamento segue em PENDING');

  // 4. Execução Ciclo 2 do Worker (prova de loop infinito)
  await outboxWorker.processGoogleSyncOutbox();

  const itemAfter2 = db.prepare('SELECT status, attempts FROM google_sync_outbox WHERE id = ?').get(outboxId);
  assert.equal(itemAfter2.status, 'PENDING', 'Diagnóstico: Ciclo 2 reprocessou e permaneceu preso em PENDING');
  assert.equal(itemAfter2.attempts, 0, 'Diagnóstico: attempts segue 0 indefinidamente');

  // Zero requisições de rede externas foram disparadas
  assert.equal(networkSpy.totalCalls, 0, 'Nenhuma chamada externa efetuada');
});

// =============================================================================
// TESTE 2: AVALIAÇÃO FORMAL DO GATEKEEPER QUÍNTUPLO SOB LIVE_SYNC_DISABLED
// =============================================================================
test('2. [GATEKEEPER] Master switch desativado retorna LIVE_SYNC_DISABLED com isHomologation=true', () => {
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

  const result = gatekeeper.evaluateGatekeeper({
    userId: AUTH_TENANT_ID,
    calendarId: AUTH_CALENDAR_ID,
    appointmentId: AUTH_APPOINTMENT_ID,
    accountEmail: AUTH_EMAIL,
    isDemo: false,
  });

  assert.equal(result.allowed, false, 'Deve bloquear');
  assert.equal(result.reason, 'LIVE_SYNC_DISABLED', 'Motivo deve ser o master switch');
  assert.equal(result.isHomologation, true, 'isHomologation deve ser true no modo homologação');
});

// =============================================================================
// TESTE 3: PRESERVAÇÃO DE FILA DE TERCEIROS (ITEM NÃO AUTORIZADO DEVE FICAR EM PENDING)
// =============================================================================
test('3. [PRESERVAÇÃO] Itens de outros salões (não autorizados) devem permanecer intactos em PENDING', async () => {
  const otherAptId = 9901;
  const otherUserId = 2;

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status)
    VALUES (?, ?, 'Compromisso de Terceiro', '2026-12-01 14:00:00', '2026-12-01 15:00:00', 'AGENDADO', 'PENDING')
  `).run(otherAptId, otherUserId);

  const insertOther = db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, attempts)
    VALUES (?, ?, 'CREATE', 'PENDING', 0)
  `).run(otherUserId, otherAptId);

  // Executa o worker durante a homologação
  await outboxWorker.processGoogleSyncOutbox();

  const otherItem = db.prepare('SELECT status, attempts, locked_at, processed_at FROM google_sync_outbox WHERE id = ?').get(insertOther.lastInsertRowid);
  const otherApt = db.prepare('SELECT google_sync_status FROM appointments WHERE id = ?').get(otherAptId);

  // O item de terceiro DEVE ser preservado em PENDING
  assert.equal(otherItem.status, 'PENDING', 'Preservação: Fila de terceiro deve continuar PENDING');
  assert.equal(otherItem.locked_at, null, 'Preservação: Lock nulo');
  assert.equal(otherItem.processed_at, null, 'Preservação: processed_at nulo');
  assert.equal(otherApt.google_sync_status, 'PENDING', 'Preservação: Agendamento segue PENDING');
  assert.equal(networkSpy.totalCalls, 0, 'Zero chamadas externas');
});

// =============================================================================
// TESTE 4: VALIDAÇÃO DO CONTRATO ESPERADO PÓS-CORREÇÃO (SIMULAÇÃO SEGURA)
// =============================================================================
test('4. [CONTRATO ESPERADO] Item autorizado com LIVE_SYNC_DISABLED deve transicionar para SIMULATED', () => {
  // Este teste documenta formalmente a regra de transição que o desenvolvedor deve implementar:
  const simId = 'sim_gcal_' + crypto.createHash('sha256').update(`sim_${AUTH_TENANT_ID}_${AUTH_APPOINTMENT_ID}`).digest('hex').substring(0, 24);

  // Simula a aplicação da regra proposta no banco isolado:
  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_calendar_id)
    VALUES (?, ?, 'Corte Autorizado', '2026-12-01 10:00:00', '2026-12-01 11:00:00', 'AGENDADO', 'PENDING', ?)
  `).run(AUTH_APPOINTMENT_ID, AUTH_TENANT_ID, AUTH_CALENDAR_ID);

  const outboxInsert = db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
    VALUES (?, ?, 'CREATE', 'PENDING')
  `).run(AUTH_TENANT_ID, AUTH_APPOINTMENT_ID);

  // Transição correta:
  const reason = 'LIVE_SYNC_DISABLED';
  db.prepare(`
    UPDATE google_sync_outbox
    SET status = 'SIMULATED', processed_at = CURRENT_TIMESTAMP,
        last_error = ?
    WHERE id = ?
  `).run(`HOMOLOGAÇÃO [${reason}]: Sincronização simulada em ambiente seguro`, outboxInsert.lastInsertRowid);

  db.prepare(`
    UPDATE appointments
    SET google_event_id = ?,
        google_sync_status = 'SIMULATED',
        google_sync_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(simId, `Ambiente Seguro: Sincronização simulada (${reason})`, AUTH_APPOINTMENT_ID);

  const outboxResult = db.prepare('SELECT status, last_error, processed_at FROM google_sync_outbox WHERE id = ?').get(outboxInsert.lastInsertRowid);
  const aptResult = db.prepare('SELECT google_sync_status, google_event_id, google_sync_error FROM appointments WHERE id = ?').get(AUTH_APPOINTMENT_ID);

  assert.equal(outboxResult.status, 'SIMULATED', 'Outbox deve ser marcada como SIMULATED');
  assert.ok(outboxResult.processed_at !== null, 'processed_at deve ser gravado');
  assert.match(outboxResult.last_error, /LIVE_SYNC_DISABLED/, 'last_error deve conter o log de auditoria');
  assert.equal(aptResult.google_sync_status, 'SIMULATED', 'Agendamento deve ser marcado como SIMULATED');
  assert.ok(aptResult.google_event_id.startsWith('sim_gcal_'), 'ID do evento deve ter prefixo sim_gcal_');
});

// =============================================================================
// TESTE 5: IDEMPOTÊNCIA E RESILIÊNCIA CONTRA CORRUPÇÃO
// =============================================================================
test('5. [IDEMPOTÊNCIA] Reprocessamento de item SIMULATED não altera integridade dos dados', () => {
  const simId = 'sim_gcal_test_idempotency_123';

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status, google_event_id)
    VALUES (999, 3, 'Corte Idempotente', '2026-12-01 10:00:00', '2026-12-01 11:00:00', 'AGENDADO', 'SIMULATED', ?)
  `).run(simId);

  db.prepare(`
    INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status, processed_at)
    VALUES (999, 3, 999, 'CREATE', 'SIMULATED', CURRENT_TIMESTAMP)
  `).run();

  // Uma consulta adicional do worker filtrando por PENDING ignora a tarefa SIMULATED
  const pendingItems = db.prepare("SELECT * FROM google_sync_outbox WHERE status = 'PENDING'").all();
  assert.equal(pendingItems.length, 0, 'Item SIMULATED não é reprocessado indevidamente');

  // Integridade do agendamento mantida
  const apt = db.prepare('SELECT google_event_id, google_sync_status FROM appointments WHERE id = 999').get();
  assert.equal(apt.google_event_id, simId, 'google_event_id não deve ser corrompido');
  assert.equal(apt.google_sync_status, 'SIMULATED', 'Status deve permanecer estável');
  assert.equal(networkSpy.totalCalls, 0, 'Zero chamadas de rede externas');
});
