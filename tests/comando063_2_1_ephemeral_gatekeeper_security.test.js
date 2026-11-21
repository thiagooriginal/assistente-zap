/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS (COMANDO 063.2.1)
 * Correção de Segurança do Ephemeral Gatekeeper e Validação do ADMIN
 * Branch: security/raia-27-protecoes
 *
 * Cobertura mandatória dos 8 cenários de segurança:
 * 1. Master switch ativo + sem sessão + variáveis estáticas presentes => bloqueio NO_ACTIVE_HOMOLOGATION_SESSION
 * 2. Sessão expirada + variáveis estáticas presentes => bloqueio NO_ACTIVE_HOMOLOGATION_SESSION
 * 3. Action Pinning: sessão DELETE rejeita CREATE e UPDATE com UNAUTHORIZED_ACTION; falta de action rejeita com ACTION_REQUIRED
 * 4. Master switch desativado durante DELETE => não converte em sucesso simulado, agendamento NÃO vira CANCELLED, outbox fica PENDING
 * 5. Consumo de sessão (max_executions=1) => status vira COMPLETED, subsequente bloqueado com NO_ACTIVE_HOMOLOGATION_SESSION
 * 6. Isolamento estrito: outro tenant ou outro calendário bloqueado
 * 7. Endpoints administrativos (/api/admin/google-sync/*) exigem sessão interativa com MFA e proíbem ADMIN_API_KEY
 * 8. Proteção de dados: session_token é mascarado como session_token_masked em APIs e no histórico
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');

// 1. ISOLAMENTO MANDATÓRIO DE BANCO EM OS.TMPDIR()
const testDbPath = path.join(os.tmpdir(), `test_gatekeeper_sec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.ADMIN_PASSWORD = 'TestMasterPassword123!@#';
process.env.ADMIN_API_KEY = 'test_admin_api_key_secret_least_privilege_123';
process.env.SESSION_SECRET = 'test_session_secret_32_chars_long_entropy!';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_32_chars_long_entropy!';
process.env.DEMO_ACCOUNT_EMAIL = 'homologacao.hotmart@raiaagentes.com.br';
process.env.DEMO_ACCOUNT_PASSWORD = 'DemoPassword123#';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

// Módulos
const db = require('../src/database/db');
const sessionService = require('../src/services/googleCalendarSessionService');
const gatekeeper = require('../src/services/googleCalendarGatekeeper');
const outboxWorker = require('../src/services/outboxWorker');
const googleCalendarService = require('../src/services/googleCalendarService');
const { app } = require('../src/server/app');

let server = null;
let baseUrl = '';

const ADMIN_ID = 1;
const TENANT_3_ID = 3;
const TENANT_OTHER_ID = 999;
const APT_17_ID = 17;
const CALENDAR_SECUNDARIO = 'c_raia_homolog_sec@group.calendar.google.com';
const EMAIL_TESTE = 'relinautomacoes@gmail.com';

function httpRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers },
    };
    if (body) {
      if (!options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
      }
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          json,
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

describe('COMANDO 063.2.1 — Correção de Segurança do Ephemeral Gatekeeper', () => {

  before(async () => {
    sessionService.ensureSchema(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS google_sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        appointment_id INTEGER,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 5,
        locked_at DATETIME,
        next_retry_at DATETIME,
        idempotency_key TEXT UNIQUE,
        last_error TEXT,
        processed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Inicia servidor HTTP em porta aleatória para endpoints administrativos
    server = http.createServer(app);
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise(res => server.close(res));
    }
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch (_) {}
  });

  beforeEach(() => {
    // Limpeza de tabelas entre testes na ordem reversa de chaves estrangeiras
    db.exec(`
      DELETE FROM google_sync_test_sessions;
      DELETE FROM google_sync_outbox;
      DELETE FROM google_calendar_tokens;
      DELETE FROM customer_subscriptions;
      DELETE FROM appointments;
      DELETE FROM users WHERE id IN (1, 3, 999);
    `);

    // Semeia Administrador
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, totp_enabled, totp_secret, is_demo)
      VALUES (?, '5511999990001', 'Admin Master', 'ADMIN', 1, 'TESTTOTPSECRETKEY123', 0)
    `).run(ADMIN_ID);

    // Semeia Tenant 3
    const paidUntil = new Date(Date.now() + 30 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO users (id, name, email, phone_number, role, is_demo, subscription_status, paid_until)
      VALUES (?, 'Salão Teste RAIA', ?, '5511999990003', 'USER', 0, 'ACTIVE', ?)
    `).run(TENANT_3_ID, EMAIL_TESTE, paidUntil);

    // Semeia assinatura ativa do Tenant 3
    let prodId = 1;
    try {
      const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
      if (jessicaProd) prodId = jessicaProd.id;
    } catch (_) {}

    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, status, paid_until, price_cents)
      VALUES (?, ?, 'ACTIVE', datetime('now', '+30 days'), 8900)
    `).run(TENANT_3_ID, prodId);

    // Semeia tokens do Tenant 3
    db.prepare(`
      INSERT INTO google_calendar_tokens (
        user_id, encrypted_tokens, is_connected, connected_at, initial_connection_at,
        sync_existing_authorized, account_email, selected_calendar_id, sync_mode
      ) VALUES (?, 'mock_encrypted_tokens_123', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, ?, ?, 'PRIMARY')
    `).run(TENANT_3_ID, EMAIL_TESTE, CALENDAR_SECUNDARIO);

    // Semeia agendamento 17
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, title, client_name, client_phone, start_datetime, end_datetime,
        status, google_event_id, google_calendar_id, google_sync_status
      ) VALUES (
        ?, ?, 'Corte Feminino', 'Cliente Teste', '5511988887777',
        '2026-11-24 16:00:00', '2026-11-24 16:45:00', 'CONFIRMADO',
        'google_event_real_17_abc123', ?, 'SYNCED'
      )
    `).run(APT_17_ID, TENANT_3_ID, CALENDAR_SECUNDARIO);

    // Garante que variáveis de ambiente estejam no baseline
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  test('Cenário 1: Master switch ativo + sem sessão efêmera + variáveis estáticas antigas presentes = BLOQUEADO com NO_ACTIVE_HOMOLOGATION_SESSION', () => {
    // Configura variáveis estáticas antigas que antes causavam o bypass
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '3';
    process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '17';
    process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = CALENDAR_SECUNDARIO;
    process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = EMAIL_TESTE;

    // Confirma que nenhuma sessão está ativa
    const active = sessionService.getActiveSession(db);
    assert.strictEqual(active, null, 'Nenhuma sessão de teste deve estar ativa');

    // Avaliação no Gatekeeper com as variáveis estáticas ativas
    const evalResult = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      action: 'DELETE',
      isDemo: false,
    });

    assert.strictEqual(evalResult.allowed, false, 'Operação real DEVE ser bloqueada mesmo com variáveis estáticas');
    assert.strictEqual(evalResult.reason, 'NO_ACTIVE_HOMOLOGATION_SESSION', 'Razão deve ser NO_ACTIVE_HOMOLOGATION_SESSION');
    assert.strictEqual(evalResult.isAuthorizedHomologation, false, 'isAuthorizedHomologation deve ser false');

    // Limpa variáveis estáticas
    delete process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL;
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  test('Cenário 2: Sessão expirada + variáveis estáticas antigas presentes = BLOQUEADO com NO_ACTIVE_HOMOLOGATION_SESSION', () => {
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '3';
    process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '17';

    // Cria sessão já no passado (expirada)
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`
      INSERT INTO google_sync_test_sessions (
        session_token, user_id, appointment_id, calendar_id, account_email,
        allowed_action, max_executions, executions_count, created_by,
        status, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'DELETE', 1, 0, ?, 'ACTIVE', datetime('now', '-5 minutes'))
    `).run(token, TENANT_3_ID, APT_17_ID, CALENDAR_SECUNDARIO, EMAIL_TESTE, ADMIN_ID);

    const active = sessionService.getActiveSession(db);
    assert.strictEqual(active, null, 'Sessão no passado deve ser tratada como expirada (null)');

    const evalResult = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      action: 'DELETE',
      isDemo: false,
    });

    assert.strictEqual(evalResult.allowed, false, 'Sessão expirada não pode autorizar');
    assert.strictEqual(evalResult.reason, 'NO_ACTIVE_HOMOLOGATION_SESSION');

    delete process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID;
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  test('Cenário 3: Action Pinning: sessão DELETE rejeita CREATE e UPDATE com UNAUTHORIZED_ACTION e ausência de action com ACTION_REQUIRED', () => {
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

    // Cria sessão autorizada estritamente para DELETE
    sessionService.createTestSession({
      userId: TENANT_3_ID,
      appointmentId: APT_17_ID,
      calendarId: CALENDAR_SECUNDARIO,
      accountEmail: EMAIL_TESTE,
      allowedAction: 'DELETE',
      durationMinutes: 15,
      maxExecutions: 1,
      createdBy: ADMIN_ID,
    }, db);

    // 1. Chamada com CREATE
    const resCreate = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      action: 'CREATE',
      isDemo: false,
    });
    assert.strictEqual(resCreate.allowed, false);
    assert.strictEqual(resCreate.reason, 'UNAUTHORIZED_ACTION');

    // 2. Chamada com UPDATE
    const resUpdate = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      action: 'UPDATE',
      isDemo: false,
    });
    assert.strictEqual(resUpdate.allowed, false);
    assert.strictEqual(resUpdate.reason, 'UNAUTHORIZED_ACTION');

    // 3. Chamada SEM action (omissa)
    const resNoAction = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      isDemo: false,
    });
    assert.strictEqual(resNoAction.allowed, false);
    assert.strictEqual(resNoAction.reason, 'ACTION_REQUIRED');

    // 4. Chamada com DELETE exato => permitida
    const resDelete = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      action: 'DELETE',
      isDemo: false,
    });
    assert.strictEqual(resDelete.allowed, true);

    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  test('Cenário 4: Master switch desativado durante DELETE: não converte em sucesso simulado, agendamento NÃO vira CANCELLED, outbox permanece PENDING', async () => {
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false'; // Master switch desativado

    // Cria sessão autorizada para DELETE
    sessionService.createTestSession({
      userId: TENANT_3_ID,
      appointmentId: APT_17_ID,
      calendarId: CALENDAR_SECUNDARIO,
      accountEmail: EMAIL_TESTE,
      allowedAction: 'DELETE',
      durationMinutes: 15,
      maxExecutions: 1,
      createdBy: ADMIN_ID,
    }, db);

    // Insere tarefa DELETE na outbox
    const outboxRes = db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
      VALUES (?, ?, 'DELETE', 'PENDING')
    `).run(TENANT_3_ID, APT_17_ID);
    const taskId = outboxRes.lastInsertRowid;

    // Executa worker da outbox
    const processed = await outboxWorker.processGoogleSyncOutbox(TENANT_3_ID);

    // A tarefa DELETE não pôde ser executada porque o live sync está desabilitado
    const taskAfter = db.prepare('SELECT status, last_error FROM google_sync_outbox WHERE id = ?').get(taskId);
    assert.strictEqual(taskAfter.status, 'PENDING', 'Tarefa DELETE bloqueada deve permanecer PENDING (lock revertido)');

    // O agendamento continua SYNCED (não foi cancelado localmente falsamente)
    const aptAfter = db.prepare('SELECT google_sync_status FROM appointments WHERE id = ?').get(APT_17_ID);
    assert.strictEqual(aptAfter.google_sync_status, 'SYNCED', 'Agendamento NÃO pode transicionar para CANCELLED falsamente');

    // Chamada direta ao googleCalendarService.deleteCalendarEvent também deve lançar HOMOLOGACAO_BLOCKED
    await assert.rejects(
      async () => {
        await googleCalendarService.deleteCalendarEvent(TENANT_3_ID, 'google_event_real_17_abc123');
      },
      (err) => {
        return err.message.includes('HOMOLOGACAO_BLOCKED');
      },
      'Chamada direta de exclusão com Master Switch desativado deve lançar HOMOLOGACAO_BLOCKED'
    );
  });

  test('Cenário 5: Sessão com max_executions=1 após consumo: transiciona para COMPLETED e subsequente falha com NO_ACTIVE_HOMOLOGATION_SESSION', () => {
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

    const session = sessionService.createTestSession({
      userId: TENANT_3_ID,
      appointmentId: APT_17_ID,
      calendarId: CALENDAR_SECUNDARIO,
      accountEmail: EMAIL_TESTE,
      allowedAction: 'DELETE',
      durationMinutes: 15,
      maxExecutions: 1,
      createdBy: ADMIN_ID,
    }, db);

    // Registra consumo da execução
    const updated = sessionService.recordSessionExecution(session.id, db);
    assert.strictEqual(updated.status, 'COMPLETED', 'Status deve mudar para COMPLETED');
    assert.strictEqual(updated.executions_count, 1);

    // Consulta ativa deve retornar null
    const active = sessionService.getActiveSession(db);
    assert.strictEqual(active, null, 'Sessão completada não deve ser retornada como ativa');

    // Gatekeeper deve bloquear nova tentativa
    const evalResult = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      action: 'DELETE',
      isDemo: false,
    });
    assert.strictEqual(evalResult.allowed, false);
    assert.strictEqual(evalResult.reason, 'NO_ACTIVE_HOMOLOGATION_SESSION');

    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  test('Cenário 6: Isolamento estrito de tenant e calendário: nenhuma operação atinge tenant diferente ou calendário diferente', () => {
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

    sessionService.createTestSession({
      userId: TENANT_3_ID,
      appointmentId: APT_17_ID,
      calendarId: CALENDAR_SECUNDARIO,
      accountEmail: EMAIL_TESTE,
      allowedAction: 'DELETE',
      durationMinutes: 15,
      maxExecutions: 1,
      createdBy: ADMIN_ID,
    }, db);

    // 1. Tentativa sob outro tenant
    const resOtherTenant = gatekeeper.evaluateGatekeeper({
      userId: TENANT_OTHER_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      action: 'DELETE',
      isDemo: false,
    });
    assert.strictEqual(resOtherTenant.allowed, false);
    assert.strictEqual(resOtherTenant.reason, 'UNAUTHORIZED_TENANT');

    // 2. Tentativa sob outro agendamento
    const resOtherApt = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: 9999,
      accountEmail: EMAIL_TESTE,
      action: 'DELETE',
      isDemo: false,
    });
    assert.strictEqual(resOtherApt.allowed, false);
    assert.strictEqual(resOtherApt.reason, 'UNAUTHORIZED_APPOINTMENT');

    // 3. Tentativa sob calendário diferente
    const resOtherCal = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: 'c_outro_calendario@group.calendar.google.com',
      appointmentId: APT_17_ID,
      accountEmail: EMAIL_TESTE,
      action: 'DELETE',
      isDemo: false,
    });
    assert.strictEqual(resOtherCal.allowed, false);
    assert.strictEqual(resOtherCal.reason, 'DIVERGENT_CALENDAR');

    // 4. Tentativa sob e-mail diferente
    const resOtherEmail = gatekeeper.evaluateGatekeeper({
      userId: TENANT_3_ID,
      calendarId: CALENDAR_SECUNDARIO,
      appointmentId: APT_17_ID,
      accountEmail: 'outro.email@empresa.com',
      action: 'DELETE',
      isDemo: false,
    });
    assert.strictEqual(resOtherEmail.allowed, false);
    assert.strictEqual(resOtherEmail.reason, 'DIVERGENT_EMAIL');

    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  test('Cenário 7: Endpoints administrativos (/api/admin/google-sync/*) exigem sessão interativa com MFA e rejeitam API keys sem MFA', async () => {
    // 1. Requisição anônima deve ser rejeitada (401)
    const resAnon = await httpRequest('GET', '/api/admin/google-sync/test-session/active');
    assert.strictEqual(resAnon.statusCode, 401, 'Requisição anônima deve retornar 401');

    // 2. Requisição com ADMIN_API_KEY deve ser estritamente proibida (403 Least Privilege)
    const resApiKey = await httpRequest('GET', '/api/admin/google-sync/test-session/active', {
      'x-api-key': process.env.ADMIN_API_KEY,
    });
    assert.strictEqual(resApiKey.statusCode, 403, 'ADMIN_API_KEY deve retornar 403 em rotas google-sync');

    // 3. Requisição com ADMIN_API_KEY no novo endpoint de tenant-context também deve ser 403
    const resApiKeyContext = await httpRequest('GET', '/api/admin/google-sync/tenant-context/3', {
      'x-api-key': process.env.ADMIN_API_KEY,
    });
    assert.strictEqual(resApiKeyContext.statusCode, 403, 'ADMIN_API_KEY deve retornar 403 em tenant-context');

    // 4. Cria sessão administrativa interativa válida com MFA verificado
    const adminToken = crypto.randomBytes(32).toString('hex');
    db.prepare(`
      UPDATE users
      SET session_token = ?,
          session_expires_at = datetime('now', '+1 hour'),
          session_mfa_verified = 1,
          role = 'ADMIN'
      WHERE id = 1
    `).run(adminToken);

    // 5. Requisição com token administrativo interativo e MFA verificado deve ter sucesso (200)
    const resAdmin = await httpRequest('GET', '/api/admin/google-sync/test-session/active', {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.strictEqual(resAdmin.statusCode, 200, 'Admin autenticado com MFA deve obter 200');
    assert.strictEqual(resAdmin.json.success, true);

    // 6. Novo endpoint GET /api/admin/google-sync/tenant-context/3 deve retornar o contexto somente-leitura do Tenant 3
    const resContext = await httpRequest('GET', '/api/admin/google-sync/tenant-context/3', {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.strictEqual(resContext.statusCode, 200);
    assert.strictEqual(resContext.json.success, true);
    assert.strictEqual(resContext.json.tenant.id, 3);
    assert.strictEqual(resContext.json.tenant.isDemo, false);
    assert.strictEqual(resContext.json.googleConnection.isConnected, true);
    assert.strictEqual(resContext.json.googleConnection.selectedCalendarId, CALENDAR_SECUNDARIO);
    assert.ok(Array.isArray(resContext.json.appointments), 'Deve retornar lista de agendamentos');
    assert.strictEqual(resContext.json.appointments[0].id, APT_17_ID);
  });

  test('Cenário 8: Proteção de dados: session_token NUNCA é exposto em claro nas APIs ou histórico (mascarado como session_token_masked)', async () => {
    // Cria sessão
    const created = sessionService.createTestSession({
      userId: TENANT_3_ID,
      appointmentId: APT_17_ID,
      calendarId: CALENDAR_SECUNDARIO,
      accountEmail: EMAIL_TESTE,
      allowedAction: 'DELETE',
      durationMinutes: 15,
      maxExecutions: 1,
      createdBy: ADMIN_ID,
    }, db);

    // O retorno da função createTestSession não deve conter session_token em claro
    assert.strictEqual(created.session_token, undefined, 'createTestSession não pode expor session_token em claro');
    assert.ok(created.session_token_masked, 'Deve conter session_token_masked');
    assert.match(created.session_token_masked, /^[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/, 'Formato deve ser aaaa...bbbb');

    // O retorno da função getActiveSession não deve conter session_token em claro
    const active = sessionService.getActiveSession(db);
    assert.strictEqual(active.session_token, undefined, 'getActiveSession não pode expor session_token em claro');
    assert.ok(active.session_token_masked, 'Deve conter session_token_masked');

    // O retorno de getSessionHistory não deve conter session_token em claro
    const history = sessionService.getSessionHistory(10, db);
    assert.ok(history.length > 0);
    for (const item of history) {
      assert.strictEqual(item.session_token, undefined, 'Histórico não pode conter session_token em claro');
      assert.ok(item.session_token_masked, 'Histórico deve conter session_token_masked');
    }

    // Configura admin interativo com MFA
    const adminToken = crypto.randomBytes(32).toString('hex');
    db.prepare(`
      UPDATE users
      SET session_token = ?,
          session_expires_at = datetime('now', '+1 hour'),
          session_mfa_verified = 1,
          role = 'ADMIN'
      WHERE id = 1
    `).run(adminToken);

    // Consulta API /api/admin/google-sync/test-session/history
    const resHistApi = await httpRequest('GET', '/api/admin/google-sync/test-session/history', {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.strictEqual(resHistApi.statusCode, 200);
    assert.ok(resHistApi.json.sessions.length > 0);
    for (const s of resHistApi.json.sessions) {
      assert.strictEqual(s.session_token, undefined, 'API não pode vazar session_token');
      assert.ok(s.session_token_masked, 'API deve conter session_token_masked');
    }
  });

});
