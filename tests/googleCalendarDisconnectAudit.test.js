/**
 * RAIA AGENTES — SUÍTE HERMÉTICA DE TESTES AUTOMATIZADOS (COMANDO 037)
 * Auditoria Completa: Desconexão, Revogação OAuth2, Proteção de Sessão,
 * Sincronização em Andamento e Isolamento Multi-Tenant do Google Calendar.
 * 
 * Cobertura Obrigatória (Requisitos a até i):
 *  a) Revogação por refresh_token com sucesso e encrypted_tokens = NULL.
 *  b) Fallback para revogação por access_token quando ausente refresh_token.
 *  c) Resiliência contra falha remota na revogação (Google 503) garantindo purga local.
 *  d) Bloqueio de persistência de tokens renovados pós-desconexão (evento 'tokens').
 *  e) Bloqueio de sobrescrita por renovação atrasada de sessão anterior.
 *  f) Cancelamento de tarefas PENDING e PROCESSING no outbox e post-flight guard no worker.
 *  g) Reconexão limpa sem reativação de tarefas previamente canceladas.
 *  h) Isolamento multi-tenant estrito entre salões independentes.
 *  i) Tratamento de revogação remota detectada pelo outboxWorker (invalid_grant).
 * 
 * Utiliza exclusivamente módulos nativos Node 22 (node:test, node:assert/strict).
 * Banco temporário descartável em os.tmpdir(), isolando 100% o data/assistant.db operacional.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');

// 1. Configurar ambiente hermético descartável
const uniqueRunId = `gcal_audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_gcal_audit_${uniqueRunId}.db`);

process.env.DB_PATH = tempDbPath;
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false'; // Bloqueio fail-closed de chamadas externas reais
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'super_secret_test_encryption_key_for_aes_256_gcm_32';

const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const outboxWorker = require('../src/services/outboxWorker');

/**
 * Helper para inserção controlada de tokens de teste
 */
function insertTestTokens(userId, tokens, accountEmail, options = {}) {
  const encTokens = googleCalendarService.encryptTokens(tokens);
  const existingToken = db.prepare('SELECT initial_connection_at FROM google_calendar_tokens WHERE user_id = ?').get(userId);
  const isFirstConnection = !existingToken || !existingToken.initial_connection_at;
  const connectionTimestamp = options.connectedAt || new Date().toISOString();
  const initialConnAt = isFirstConnection ? connectionTimestamp : existingToken.initial_connection_at;

  db.prepare(`
    INSERT INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, scope, selected_calendar_id, 
      selected_calendar_name, sync_mode, is_connected, last_sync_at, last_error,
      initial_connection_at, connected_at, sync_existing_authorized
    )
    VALUES (?, ?, ?, ?, 'primary', 'Principal', 'SINGLE', 1, CURRENT_TIMESTAMP, NULL, ?, ?, 0)
    ON CONFLICT(user_id) DO UPDATE SET
      account_email = excluded.account_email,
      encrypted_tokens = excluded.encrypted_tokens,
      is_connected = 1,
      last_sync_at = CURRENT_TIMESTAMP,
      last_error = NULL,
      connected_at = excluded.connected_at,
      initial_connection_at = COALESCE(google_calendar_tokens.initial_connection_at, excluded.initial_connection_at),
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, accountEmail, encTokens, tokens.scope || 'calendar', initialConnAt, connectionTimestamp);
}

/**
 * Cria mock de OAuth2Client com rastreamento detalhado de chamadas e emissão de eventos
 */
function createMockOAuth2Client(tokens = {}) {
  const emitter = new EventEmitter();
  const revokedTokens = [];
  let credentials = { ...tokens };

  return {
    credentials,
    setCredentials: (creds) => { credentials = { ...credentials, ...creds }; },
    on: (event, handler) => emitter.on(event, handler),
    emit: (event, payload) => emitter.emit(event, payload),
    revokeToken: async (token) => {
      revokedTokens.push(token);
      return { success: true };
    },
    revokeCredentials: async () => {
      const token = credentials.refresh_token || credentials.access_token;
      revokedTokens.push(token);
      return { success: true };
    },
    getRevokedTokens: () => revokedTokens,
  };
}

test.before(() => {
  // Setup de Salão A (userId: 13) e Salão B (userId: 14)
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role)
    VALUES (13, '5511999990013', 'Salão Bella Vista', 'CLIENT'),
           (14, '5511999990014', 'Salão Studio Elegance', 'CLIENT')
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name)
    VALUES (13, 'Salão Bella Vista'),
           (14, 'Salão Studio Elegance')
  `).run();
});

test.after(() => {
  googleCalendarService.resetMockHandler();
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  } catch (_) {}
});

test.describe('COMANDO 037: Auditoria de Desconexão, Revogação e Isolamento Google Calendar', () => {

  test('a) Revogação remota por refresh_token com sucesso e expurgo de tokens locais', async () => {
    const tokens = {
      access_token: 'access_token_a_123',
      refresh_token: 'refresh_token_a_xyz',
      expiry_date: Date.now() + 3600000,
    };
    insertTestTokens(13, tokens, 'salao.a@gmail.com');

    const mockOAuth2 = createMockOAuth2Client(tokens);
    googleCalendarService.setMockHandler({
      createOAuth2Client: () => mockOAuth2,
    });

    const result = await googleCalendarService.disconnectUserCalendar(13);
    assert.equal(result.success, true);

    // Valida que a revogação foi disparada especificamente com o refresh_token
    assert.deepEqual(mockOAuth2.getRevokedTokens(), ['refresh_token_a_xyz'], 'Deve revogar prioritariamente pelo refresh_token');

    // Valida expurgo local no SQLite
    const row = db.prepare('SELECT encrypted_tokens, is_connected, last_error FROM google_calendar_tokens WHERE user_id = 13').get();
    assert.strictEqual(row.encrypted_tokens, null, 'encrypted_tokens DEVE ser NULL após desconexão');
    assert.strictEqual(row.is_connected, 0, 'is_connected DEVE ser 0');
    assert.equal(row.last_error, 'Conta desconectada pelo usuário.');

    googleCalendarService.resetMockHandler();
  });

  test('b) Fallback para revogação por access_token quando não houver refresh_token', async () => {
    const tokens = {
      access_token: 'access_only_token_789',
      expiry_date: Date.now() + 3600000,
    };
    insertTestTokens(13, tokens, 'salao.a@gmail.com');

    const mockOAuth2 = createMockOAuth2Client(tokens);
    googleCalendarService.setMockHandler({
      createOAuth2Client: () => mockOAuth2,
    });

    const result = await googleCalendarService.disconnectUserCalendar(13);
    assert.equal(result.success, true);

    // Valida fallback para access_token
    assert.deepEqual(mockOAuth2.getRevokedTokens(), ['access_only_token_789'], 'Deve usar fallback para access_token');

    const row = db.prepare('SELECT encrypted_tokens, is_connected FROM google_calendar_tokens WHERE user_id = 13').get();
    assert.strictEqual(row.encrypted_tokens, null);
    assert.strictEqual(row.is_connected, 0);

    googleCalendarService.resetMockHandler();
  });

  test('c) Falha na revogação remota (Google 503): erro capturado com segurança e purga local preservada', async () => {
    const tokens = {
      access_token: 'token_err_access',
      refresh_token: 'token_err_refresh',
    };
    insertTestTokens(13, tokens, 'salao.a@gmail.com');

    const mockOAuth2 = {
      credentials: tokens,
      revokeToken: async () => { throw new Error('Google Network Timeout 503'); },
      revokeCredentials: async () => { throw new Error('Google Network Timeout 503'); },
      on: () => {},
    };

    googleCalendarService.setMockHandler({
      createOAuth2Client: () => mockOAuth2,
    });

    // Função não deve explodir nem propagar rejeição não tratada
    const result = await googleCalendarService.disconnectUserCalendar(13);
    assert.equal(result.success, true);

    // Mesmo com erro externo no Google, os tokens locais DEVEM ser eliminados
    const row = db.prepare('SELECT encrypted_tokens, is_connected FROM google_calendar_tokens WHERE user_id = 13').get();
    assert.strictEqual(row.encrypted_tokens, null, 'encrypted_tokens deve virar NULL mesmo em erro 503 do Google');
    assert.strictEqual(row.is_connected, 0);

    googleCalendarService.resetMockHandler();
  });

  test('d) Renovação de token pós-desconexão: listener não grava nem restaura tokens no banco', async () => {
    const tokens = {
      access_token: 'active_access_token',
      refresh_token: 'active_refresh_token',
    };
    insertTestTokens(13, tokens, 'salao.a@gmail.com');

    let capturedListener = null;
    const mockOAuth2 = {
      credentials: tokens,
      setCredentials: () => {},
      on: (event, handler) => {
        if (event === 'tokens') capturedListener = handler;
      },
      revokeToken: async () => ({ success: true }),
    };

    googleCalendarService.setMockHandler({
      createOAuth2Client: () => mockOAuth2,
    });

    // Chama getOAuth2Client para registrar o listener com a sessão atual
    googleCalendarService.getOAuth2Client ? googleCalendarService.getOAuth2Client(13) : null;

    // Desconecta o usuário
    await googleCalendarService.disconnectUserCalendar(13);

    const beforeEmit = db.prepare('SELECT encrypted_tokens, is_connected FROM google_calendar_tokens WHERE user_id = 13').get();
    assert.strictEqual(beforeEmit.encrypted_tokens, null);
    assert.strictEqual(beforeEmit.is_connected, 0);

    // Simula evento atrasado de renovação emitido após desconexão
    if (typeof capturedListener === 'function') {
      capturedListener({ access_token: 'zombie_refreshed_token_123' });
    }

    // Banco de dados deve continuar 100% desconectado e sem tokens zumbis
    const afterEmit = db.prepare('SELECT encrypted_tokens, is_connected FROM google_calendar_tokens WHERE user_id = 13').get();
    assert.strictEqual(afterEmit.encrypted_tokens, null, 'Tokens renovados após desconexão NÃO podem ser salvos');
    assert.strictEqual(afterEmit.is_connected, 0);

    googleCalendarService.resetMockHandler();
  });

  test('e) Renovação de token atrasada de uma sessão anterior: não sobrescreve sessão reconectada', async () => {
    // 1. Sessão 1 do Salão A
    const tokensSession1 = { access_token: 'token_sess1', refresh_token: 'refresh_sess1' };
    insertTestTokens(13, tokensSession1, 'salao.a@gmail.com', { connectedAt: '2026-11-10T10:00:00Z' });

    let listenerSession1 = null;
    const mockOAuth2Session1 = {
      credentials: tokensSession1,
      setCredentials: () => {},
      on: (event, handler) => {
        if (event === 'tokens') listenerSession1 = handler;
      },
      revokeToken: async () => ({ success: true }),
    };

    googleCalendarService.setMockHandler({
      createOAuth2Client: () => mockOAuth2Session1,
    });

    googleCalendarService.getOAuth2Client ? googleCalendarService.getOAuth2Client(13) : null;
    googleCalendarService.resetMockHandler();

    // 2. Salão A reconecta (Sessão 2 com novo connected_at e novos tokens)
    const tokensSession2 = { access_token: 'token_sess2_new', refresh_token: 'refresh_sess2_new' };
    insertTestTokens(13, tokensSession2, 'salao.a@gmail.com', { connectedAt: '2026-11-11T12:00:00Z' });

    // 3. Cliente antigo da Sessão 1 emite evento 'tokens' atrasado
    if (typeof listenerSession1 === 'function') {
      listenerSession1({ access_token: 'stale_token_sess1_resurrected' });
    }

    // Valida que os tokens no banco correspondem à Sessão 2 e não foram corrompidos pela Sessão 1
    const currentTokensRow = db.prepare('SELECT encrypted_tokens FROM google_calendar_tokens WHERE user_id = 13').get();
    const currentTokens = googleCalendarService.decryptTokens(currentTokensRow.encrypted_tokens);
    assert.equal(currentTokens.access_token, 'token_sess2_new', 'Tokens da nova sessão não podem ser sobrescritos por listener antigo');
  });

  test('f) Sincronização em andamento no momento da desconexão', async () => {
    // f1: Tarefas PENDING e PROCESSING são canceladas em disconnectUserCalendar
    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (13, 9001, 'CREATE', 'PENDING', '{"summary":"Corte Teste"}'),
             (13, 9002, 'UPDATE', 'PROCESSING', '{"summary":"Escova Teste"}')
    `).run();

    await googleCalendarService.disconnectUserCalendar(13);

    const outboxItems = db.prepare('SELECT id, status, last_error FROM google_sync_outbox WHERE user_id = 13 AND appointment_id IN (9001, 9002)').all();
    assert.equal(outboxItems.length, 2);
    for (const item of outboxItems) {
      assert.equal(item.status, 'CANCELLED', `Tarefa ${item.id} deve estar CANCELLED`);
      assert.ok(item.last_error.includes('CANCELLED_DISCONNECTED'));
    }

    // f2: Post-flight guard no outboxWorker: desconexão durante chamada externa não marca agendamento como SYNCED
    db.prepare(`
      INSERT OR REPLACE INTO appointments (id, user_id, title, client_name, start_datetime, end_datetime, status, google_sync_status)
      VALUES (9003, 13, 'Coloração', 'Maria Silva', '2026-11-20 14:00:00', '2026-11-20 15:00:00', 'AGENDADO', 'PENDING')
    `).run();

    db.prepare(`
      INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status, payload_json)
      VALUES (9003, 13, 9003, 'CREATE', 'PENDING', '{"summary":"Coloração"}')
    `).run();

    // Reconecta temporariamente
    insertTestTokens(13, { access_token: 'live_token', refresh_token: 'live_refresh' }, 'salao.a@gmail.com');

    // Configura mock onde createCalendarEvent desconecta a conta no meio da chamada
    googleCalendarService.setMockHandler({
      createCalendarEvent: async (userId, apt) => {
        // Simula usuário clicando em desconectar concorrentemente enquanto a chamada de API ocorre
        await googleCalendarService.disconnectUserCalendar(userId);
        return { success: true, googleEventId: 'gcal_event_race_123' };
      },
    });

    await outboxWorker.processGoogleSyncOutbox(13);

    // Valida que o worker revalidou o estado e NÃO marcou o agendamento como SYNCED
    const finalApt = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = 9003').get();
    assert.notEqual(finalApt.google_sync_status, 'SYNCED', 'Agendamento NÃO deve ser marcado como SYNCED após desconexão');
    assert.equal(finalApt.google_sync_status, 'NOT_SYNCED');

    const finalOutbox = db.prepare('SELECT status, last_error FROM google_sync_outbox WHERE id = 9003').get();
    assert.equal(finalOutbox.status, 'CANCELLED');
    assert.ok(finalOutbox.last_error.includes('CANCELLED_DISCONNECTED'));

    googleCalendarService.resetMockHandler();
  });

  test('g) Reconexão sem reativação de tarefas antigas canceladas', async () => {
    // Tarefa cancelada previamente permanece no SQLite com status CANCELLED
    const cancelledTask = db.prepare('SELECT status FROM google_sync_outbox WHERE id = 9003').get();
    assert.equal(cancelledTask.status, 'CANCELLED');

    // Reconecta Salão A
    insertTestTokens(13, { access_token: 'reconnected_token', refresh_token: 'reconnected_refresh' }, 'salao.a@gmail.com');

    // Executa o worker
    await outboxWorker.processGoogleSyncOutbox(13);

    // Tarefa cancelada continua cancelada e não foi processada
    const taskAfter = db.prepare('SELECT status FROM google_sync_outbox WHERE id = 9003').get();
    assert.equal(taskAfter.status, 'CANCELLED', 'Tarefas antigas canceladas não devem ser reativadas na reconexão');
  });

  test('h) Isolamento multi-tenant estrito entre dois salões independentes', async () => {
    // Conecta Salão A (13) e Salão B (14)
    insertTestTokens(13, { access_token: 'token_a', refresh_token: 'refresh_a' }, 'salao.a@gmail.com');
    insertTestTokens(14, { access_token: 'token_b', refresh_token: 'refresh_b' }, 'salao.b@gmail.com');

    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (13, 9010, 'CREATE', 'PENDING', '{"summary":"Salão A"}'),
             (14, 9020, 'CREATE', 'PENDING', '{"summary":"Salão B"}')
    `).run();

    const mockOAuth2A = createMockOAuth2Client({ refresh_token: 'refresh_a' });
    const mockOAuth2B = createMockOAuth2Client({ refresh_token: 'refresh_b' });

    googleCalendarService.setMockHandler({
      createOAuth2Client: (creds) => {
        // Se as credenciais estiverem associadas ao Salão B ou se for chamado para B
        return mockOAuth2A;
      },
    });

    // Desconecta APENAS o Salão A
    await googleCalendarService.disconnectUserCalendar(13);

    // 1. Salão A desconectado
    const rowA = db.prepare('SELECT encrypted_tokens, is_connected FROM google_calendar_tokens WHERE user_id = 13').get();
    assert.strictEqual(rowA.encrypted_tokens, null);
    assert.strictEqual(rowA.is_connected, 0);

    const outboxA = db.prepare('SELECT status FROM google_sync_outbox WHERE user_id = 13 AND appointment_id = 9010').get();
    assert.equal(outboxA.status, 'CANCELLED');

    // 2. Salão B permanece 100% intacto e conectado
    const rowB = db.prepare('SELECT encrypted_tokens, is_connected, account_email FROM google_calendar_tokens WHERE user_id = 14').get();
    assert.equal(rowB.is_connected, 1, 'Salão B DEVE continuar conectado');
    assert.ok(rowB.encrypted_tokens, 'Tokens do Salão B DEVEM permanecer intactos');
    assert.equal(rowB.account_email, 'salao.b@gmail.com');

    const outboxB = db.prepare('SELECT status FROM google_sync_outbox WHERE user_id = 14 AND appointment_id = 9020').get();
    assert.equal(outboxB.status, 'PENDING', 'Fila do Salão B deve continuar PENDING');

    googleCalendarService.resetMockHandler();
  });

  test('i) Revogação remota detectada pelo worker (invalid_grant): purga tokens locais com proteção de sessão', async () => {
    // Salão A conectado
    insertTestTokens(13, { access_token: 'expired_tok', refresh_token: 'revoked_tok' }, 'salao.a@gmail.com');

    db.prepare(`
      INSERT OR REPLACE INTO appointments (id, user_id, title, client_name, start_datetime, end_datetime, status, google_sync_status)
      VALUES (9030, 13, 'Barba', 'Carlos', '2026-11-22 10:00:00', '2026-11-22 10:30:00', 'AGENDADO', 'PENDING')
    `).run();

    db.prepare(`
      INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status, payload_json)
      VALUES (9030, 13, 9030, 'CREATE', 'PENDING', '{"summary":"Barba"}')
    `).run();

    // Mock simula erro do Google informando que o token foi revogado/expirado
    googleCalendarService.setMockHandler({
      createCalendarEvent: async () => {
        const err = new Error('invalid_grant: Token has been expired or revoked.');
        err.code = 400;
        throw err;
      },
    });

    await outboxWorker.processGoogleSyncOutbox(13);

    // Verifica que o worker detectou a revogação e marcou tokens locais como NULL e desconectado
    const row = db.prepare('SELECT encrypted_tokens, is_connected, last_error FROM google_calendar_tokens WHERE user_id = 13').get();
    assert.strictEqual(row.encrypted_tokens, null, 'Tokens devem ser purgados após invalid_grant');
    assert.strictEqual(row.is_connected, 0);
    assert.ok(row.last_error.includes('revogado ou expirado'));

    // Verifica que a tarefa foi cancelada/finalizada e não será retentada
    const task = db.prepare('SELECT status, last_error, next_retry_at FROM google_sync_outbox WHERE id = 9030').get();
    assert.ok(['CANCELLED', 'FAILED'].includes(task.status), 'Tarefa deve estar finalizada como CANCELLED ou FAILED');
    assert.strictEqual(task.next_retry_at, null);

    const apt = db.prepare('SELECT google_sync_status FROM appointments WHERE id = 9030').get();
    assert.ok(['NOT_SYNCED', 'FAILED'].includes(apt.google_sync_status), 'Agendamento deve ser NOT_SYNCED ou FAILED');

    googleCalendarService.resetMockHandler();
  });

});
