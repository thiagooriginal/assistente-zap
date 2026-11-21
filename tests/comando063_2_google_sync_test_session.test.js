/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS (COMANDO 063.2)
 * Autorização Temporária, Delimitada e Controlada do Google Calendar em Homologação
 * Branch: security/raia-27-protecoes
 *
 * Utiliza estritamente módulos nativos do Node 22 (node:test, node:assert/strict).
 * Isolamento hermético com banco descartável em os.tmpdir() e sandbox de rede fail-closed.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');

// -----------------------------------------------------------------------------
// 1. ISOLAMENTO MANDATÓRIO DE BANCO DE DADOS EM OS.TMPDIR()
// -----------------------------------------------------------------------------
const testDbPath = path.join(os.tmpdir(), `test_gcal_session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`);
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

// Módulos da aplicação (carregados após configuração do DB_PATH)
const db = require('../src/database/db');
const sessionService = require('../src/services/googleCalendarSessionService');
const gatekeeper = require('../src/services/googleCalendarGatekeeper');
const outboxWorker = require('../src/services/outboxWorker');
const userService = require('../src/services/userService');
const googleCalendarService = require('../src/services/googleCalendarService');
const { app } = require('../src/server/app');

// Instância de servidor HTTP para teste de endpoints administrativos
let server = null;
let serverPort = null;
let baseUrl = '';

// IDs fixos de teste
const ADMIN_USER_ID = 1;
const TENANT_LEGIT_ID = 3;
const TENANT_DEMO_ID = 99;
const TENANT_OTHER_ID = 202;
const APT_AUTHORIZED_ID = 17;
const APT_UNAUTHORIZED_ID = 100;
const APT_OTHER_TENANT_ID = 99;

const CALENDAR_SECUNDARIO_LEGIT = 'c_salon_alpha_sec@group.calendar.google.com';
const EMAIL_LEGIT = 'salaoalpha@gmail.com';

// Mock fail-closed em memória para chamadas de rede do Google Calendar
const originalCreateCalendarEvent = googleCalendarService.createCalendarEvent;
const originalUpdateCalendarEvent = googleCalendarService.updateCalendarEvent;
const originalDeleteCalendarEvent = googleCalendarService.deleteCalendarEvent;

describe('COMANDO 063.2 — Autorização Temporária e Controlada do Google Calendar', () => {

  before(async () => {
    // Garante criação idempotente das tabelas essenciais
    sessionService.ensureSchema(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS google_sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        appointment_id INTEGER NOT NULL,
        action TEXT NOT NULL DEFAULT 'CREATE',
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 5,
        next_retry_at TEXT,
        locked_at TEXT,
        processed_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS google_calendar_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE NOT NULL,
        encrypted_tokens TEXT,
        is_connected INTEGER DEFAULT 0,
        connected_at TEXT,
        initial_connection_at TEXT,
        sync_existing_authorized INTEGER DEFAULT 0,
        account_email TEXT,
        selected_calendar_id TEXT DEFAULT 'primary',
        sync_mode TEXT DEFAULT 'ACCOUNT',
        last_error TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS customer_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        contract_id INTEGER,
        product_id INTEGER NOT NULL,
        plan_id INTEGER,
        origin TEXT NOT NULL DEFAULT 'MANUAL',
        gateway TEXT NOT NULL DEFAULT 'MANUAL',
        gateway_subscription_id TEXT,
        gateway_customer_id TEXT,
        gateway_payment_id TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        price_cents INTEGER NOT NULL DEFAULT 8900,
        setup_fee_cents INTEGER NOT NULL DEFAULT 0,
        billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY',
        promotional_fair INTEGER NOT NULL DEFAULT 0,
        extra_professionals INTEGER NOT NULL DEFAULT 0,
        contracted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        paid_until TEXT,
        access_expires_at TEXT,
        custom_settings_json TEXT,
        cancelled_at TEXT,
        cancellation_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Inicializa servidor HTTP na porta 0 para testes de endpoints
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        baseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    // Restaura mocks
    googleCalendarService.createCalendarEvent = originalCreateCalendarEvent;
    googleCalendarService.updateCalendarEvent = originalUpdateCalendarEvent;
    googleCalendarService.deleteCalendarEvent = originalDeleteCalendarEvent;

    // Encerra servidor HTTP
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // Destrói banco de dados temporário garantindo hermeticidade
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
      if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    } catch (_) {}
  });

  beforeEach(() => {
    // Limpa tabelas de teste antes de cada cenário (filhos antes dos pais para respeitar foreign keys)
    db.exec(`
      DELETE FROM google_sync_test_sessions;
      DELETE FROM google_sync_outbox;
      DELETE FROM google_calendar_tokens;
      DELETE FROM customer_subscriptions;
      DELETE FROM appointments;
      DELETE FROM users WHERE id IN (1, 3, 99, 202);
    `);

    // Semeia Administrador
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, totp_enabled, totp_secret, is_demo)
      VALUES (?, ?, ?, 'ADMIN', 1, 'TESTTOTPSECRETKEY123', 0)
    `).run(ADMIN_USER_ID, '5511999990001', 'Admin Master');

    // Semeia Tenant Legítimo (Salon Alpha) com assinatura ativa
    const paidUntil = new Date(Date.now() + 30 * 86400000).toISOString();
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, is_demo, subscription_status, paid_until)
      VALUES (?, ?, ?, 'USER', 0, 'ACTIVE', ?)
    `).run(TENANT_LEGIT_ID, '5511999990003', 'Salao Alpha', paidUntil);

    // Semeia Tenant Demo (Salon Demo)
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, is_demo, subscription_status, paid_until)
      VALUES (?, ?, ?, 'USER', 1, 'ACTIVE', ?)
    `).run(TENANT_DEMO_ID, '5511999990099', 'Salao Demo', paidUntil);

    // Semeia Outro Tenant Legítimo (Salon Beta)
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, is_demo, subscription_status, paid_until)
      VALUES (?, ?, ?, 'USER', 0, 'ACTIVE', ?)
    `).run(TENANT_OTHER_ID, '5511999990202', 'Salao Beta', paidUntil);

    // Agendamentos
    const startIso = new Date(Date.now() + 86400000).toISOString();
    const endIso = new Date(Date.now() + 90000000).toISOString();

    db.prepare(`
      INSERT INTO appointments (id, user_id, client_name, client_phone, title, start_datetime, end_datetime, status, google_sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'AGENDADO', 'PENDING')
    `).run(APT_AUTHORIZED_ID, TENANT_LEGIT_ID, 'Cliente 17', '5511911111117', 'Corte', startIso, endIso);

    db.prepare(`
      INSERT INTO appointments (id, user_id, client_name, client_phone, title, start_datetime, end_datetime, status, google_sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'AGENDADO', 'PENDING')
    `).run(APT_UNAUTHORIZED_ID, TENANT_LEGIT_ID, 'Cliente 100', '5511911111100', 'Escova', startIso, endIso);

    db.prepare(`
      INSERT INTO appointments (id, user_id, client_name, client_phone, title, start_datetime, end_datetime, status, google_sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'AGENDADO', 'PENDING')
    `).run(APT_OTHER_TENANT_ID, TENANT_OTHER_ID, 'Cliente 202', '5511911111202', 'Coloracao', startIso, endIso);

    // Conexão Google para Tenant 3 (Legítimo)
    db.prepare(`
      INSERT INTO google_calendar_tokens (user_id, encrypted_tokens, is_connected, connected_at, initial_connection_at, account_email, selected_calendar_id, sync_existing_authorized)
      VALUES (?, 'encrypted_valid_mock_token', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 1)
    `).run(TENANT_LEGIT_ID, EMAIL_LEGIT, CALENDAR_SECUNDARIO_LEGIT);

    // Conexão Google para Tenant 202 (Outro)
    db.prepare(`
      INSERT INTO google_calendar_tokens (user_id, encrypted_tokens, is_connected, connected_at, initial_connection_at, account_email, selected_calendar_id, sync_existing_authorized)
      VALUES (?, 'encrypted_valid_mock_token', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'salaobeta@gmail.com', 'c_sec_beta@group.calendar.google.com', 1)
    `).run(TENANT_OTHER_ID);

    // Permissão de produto Jéssica
    const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
    if (jessica) {
      db.prepare(`
        INSERT INTO customer_subscriptions (user_id, product_id, status, price_cents, paid_until, access_expires_at)
        VALUES (?, ?, 'ACTIVE', 8900, ?, ?)
      `).run(TENANT_LEGIT_ID, jessica.id, paidUntil, paidUntil);
    }
  });

  // ===========================================================================
  // CENÁRIO 1: Master Switch Global Inviolável
  // ===========================================================================
  test('1. Master Switch Global inviolável: bloqueia com LIVE_SYNC_DISABLED quando GOOGLE_SYNC_LIVE_ENABLED !== "true"', () => {
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    delete process.env.GOOGLE_SYNC_LIVE_ENABLED; // Desativado por ausência

    // Cria sessão ativa 100% válida
    sessionService.createTestSession({
      userId: TENANT_LEGIT_ID,
      appointmentId: APT_AUTHORIZED_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      accountEmail: EMAIL_LEGIT,
      allowedAction: 'CREATE',
      durationMinutes: 15,
      maxExecutions: 1,
      createdBy: ADMIN_USER_ID,
    });

    const resAusente = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'CREATE',
    });

    assert.equal(resAusente.allowed, false, 'Deve bloquear com master switch ausente');
    assert.equal(resAusente.reason, 'LIVE_SYNC_DISABLED');
    assert.equal(resAusente.isAuthorizedHomologation, true, 'Deve reconhecer que a sessão era válida');

    // Desativado explicitamente como 'false'
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
    const resFalse = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'CREATE',
    });

    assert.equal(resFalse.allowed, false, 'Deve bloquear com master switch = "false"');
    assert.equal(resFalse.reason, 'LIVE_SYNC_DISABLED');

    // Quando GOOGLE_SYNC_LIVE_ENABLED === 'true', a sincronização real é permitida
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    const resTrue = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'CREATE',
    });

    assert.equal(resTrue.allowed, true, 'Deve liberar sincronização real quando GOOGLE_SYNC_LIVE_ENABLED === "true"');
    assert.equal(resTrue.reason, 'AUTHORIZED_HOMOLOGATION');

    // Restaura default seguro
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  // ===========================================================================
  // CENÁRIO 2: Anti-Primary Shield
  // ===========================================================================
  test('2. Anti-Primary Shield: criação de sessão com calendarId "primary" ou "default" é rejeitada com ANTI_PRIMARY_VIOLATION', () => {
    // 2.1 Rejeição no serviço
    const primaryCalls = ['primary', 'PRIMARY', ' default ', 'default'];

    for (const cal of primaryCalls) {
      assert.throws(
        () => {
          sessionService.createTestSession({
            userId: TENANT_LEGIT_ID,
            appointmentId: APT_AUTHORIZED_ID,
            calendarId: cal,
            accountEmail: EMAIL_LEGIT,
            createdBy: ADMIN_USER_ID,
          });
        },
        (err) => {
          assert.equal(err.code, 'ANTI_PRIMARY_VIOLATION');
          return true;
        },
        `Deveria ter rejeitado calendarId "${cal}" com ANTI_PRIMARY_VIOLATION`
      );
    }

    // 2.2 Rejeição no evaluateGatekeeper
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    const evalPrimary = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: 'primary',
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'CREATE',
    });
    assert.equal(evalPrimary.allowed, false);
    assert.equal(evalPrimary.reason, 'PRIMARY_CALENDAR_PROHIBITED');
  });

  // ===========================================================================
  // CENÁRIO 3: Demo Shield
  // ===========================================================================
  test('3. Demo Shield: tentativa de abrir sessão para tenant com is_demo=1 é rejeitada com DEMO_TENANT_PROHIBITED', () => {
    // 3.1 Rejeição no serviço
    assert.throws(
      () => {
        sessionService.createTestSession({
          userId: TENANT_DEMO_ID,
          appointmentId: APT_AUTHORIZED_ID,
          calendarId: CALENDAR_SECUNDARIO_LEGIT,
          accountEmail: EMAIL_LEGIT,
          createdBy: ADMIN_USER_ID,
        });
      },
      (err) => {
        assert.equal(err.code, 'DEMO_TENANT_PROHIBITED');
        return true;
      },
      'Deveria ter rejeitado tenant demo com DEMO_TENANT_PROHIBITED'
    );

    // 3.2 Bloqueio no evaluateGatekeeper
    const evalDemo = gatekeeper.evaluateGatekeeper({
      userId: TENANT_DEMO_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      isDemo: 1,
      action: 'CREATE',
    });

    assert.equal(evalDemo.allowed, false);
    assert.equal(evalDemo.reason, 'DEMO_TENANT_BLOCKED');
  });

  // ===========================================================================
  // CENÁRIO 4: Auto-expiração de TTL (Lazy Expire fail-closed)
  // ===========================================================================
  test('4. Auto-expiração de TTL: após transcorrer TTL, getActiveSession() expira sessão e evaluateGatekeeper bloqueia com NO_ACTIVE_HOMOLOGATION_SESSION', () => {
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    delete process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID;

    // Cria sessão válida
    const session = sessionService.createTestSession({
      userId: TENANT_LEGIT_ID,
      appointmentId: APT_AUTHORIZED_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      accountEmail: EMAIL_LEGIT,
      durationMinutes: 15,
      createdBy: ADMIN_USER_ID,
    });

    assert.ok(sessionService.getActiveSession(), 'Sessão deve estar ativa imediatamente após criação');

    // Simula transcurso do TTL forçando expires_at no passado
    const pastExpires = new Date(Date.now() - 60000).toISOString();
    db.prepare('UPDATE google_sync_test_sessions SET expires_at = ? WHERE id = ?').run(pastExpires, session.id);

    // getActiveSession deve expirar atômico e retornar null
    const active = sessionService.getActiveSession();
    assert.equal(active, null, 'getActiveSession deve retornar null para sessão com TTL expirado');

    const updatedRow = db.prepare('SELECT status FROM google_sync_test_sessions WHERE id = ?').get(session.id);
    assert.equal(updatedRow.status, 'EXPIRED', 'Status no banco deve ser atualizado para EXPIRED');

    // evaluateGatekeeper deve bloquear fail-closed
    const evalExpired = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'CREATE',
    });

    assert.equal(evalExpired.allowed, false);
    assert.equal(evalExpired.reason, 'NO_ACTIVE_HOMOLOGATION_SESSION');
  });

  // ===========================================================================
  // CENÁRIO 5: Botão de Pânico (Kill-Switch Imediato)
  // ===========================================================================
  test('5. Botão de Pânico (Kill-Switch Imediato): revokeTestSession() encerra a sessão instantaneamente', () => {
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    delete process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID;

    const session = sessionService.createTestSession({
      userId: TENANT_LEGIT_ID,
      appointmentId: APT_AUTHORIZED_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      accountEmail: EMAIL_LEGIT,
      createdBy: ADMIN_USER_ID,
    });

    assert.ok(sessionService.getActiveSession(), 'Sessão deve estar ativa');

    // Aciona o Kill-Switch Imediato
    const revokeResult = sessionService.revokeTestSession(session.id, {
      revokedBy: ADMIN_USER_ID,
      revocationReason: 'EMERGENCY_PANIC_BUTTON_TRIGGERED',
    });

    assert.equal(revokeResult.revoked, true);
    assert.equal(revokeResult.changes, 1);

    const revokedRow = db.prepare('SELECT status, revoked_by, revocation_reason FROM google_sync_test_sessions WHERE id = ?').get(session.id);
    assert.equal(revokedRow.status, 'REVOKED');
    assert.equal(revokedRow.revoked_by, ADMIN_USER_ID);
    assert.equal(revokedRow.revocation_reason, 'EMERGENCY_PANIC_BUTTON_TRIGGERED');

    // Subsequentes checagens bloqueiam imediatamente
    assert.equal(sessionService.getActiveSession(), null);

    const evalRevoked = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'CREATE',
    });

    assert.equal(evalRevoked.allowed, false);
    assert.equal(evalRevoked.reason, 'NO_ACTIVE_HOMOLOGATION_SESSION');
  });

  // ===========================================================================
  // CENÁRIO 6: Action Pinning
  // ===========================================================================
  test('6. Action Pinning: sessão autorizada exclusivamente para "DELETE" bloqueia "CREATE" ou "UPDATE" com UNAUTHORIZED_ACTION', () => {
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

    // Cria sessão restrita a DELETE
    sessionService.createTestSession({
      userId: TENANT_LEGIT_ID,
      appointmentId: APT_AUTHORIZED_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      accountEmail: EMAIL_LEGIT,
      allowedAction: 'DELETE',
      createdBy: ADMIN_USER_ID,
    });

    // Tentativa de CREATE
    const resCreate = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'CREATE',
    });
    assert.equal(resCreate.allowed, false);
    assert.equal(resCreate.reason, 'UNAUTHORIZED_ACTION');

    // Tentativa de UPDATE
    const resUpdate = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'UPDATE',
    });
    assert.equal(resUpdate.allowed, false);
    assert.equal(resUpdate.reason, 'UNAUTHORIZED_ACTION');

    // Tentativa de DELETE -> autorizada
    const resDelete = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'DELETE',
    });
    assert.equal(resDelete.allowed, true);
    assert.equal(resDelete.reason, 'AUTHORIZED_HOMOLOGATION');

    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  // ===========================================================================
  // CENÁRIO 7: Isolamento Multi-tenant e Preservação de Fila
  // ===========================================================================
  test('7. Isolamento Multi-tenant e Preservação de Fila: tarefas de outro tenant ou outro agendamento NÃO são processadas e permanecem PENDING', async () => {
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

    // Sessão ativa autorizada EXCLUSIVAMENTE para Tenant 3 e Agendamento 17
    sessionService.createTestSession({
      userId: TENANT_LEGIT_ID,
      appointmentId: APT_AUTHORIZED_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      accountEmail: EMAIL_LEGIT,
      allowedAction: 'CREATE',
      maxExecutions: 5,
      createdBy: ADMIN_USER_ID,
    });

    // Insere tarefas na fila outbox:
    // 1. Tarefa autorizada (Tenant 3, Apt 17)
    const tAuth = db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
      VALUES (?, ?, 'CREATE', 'PENDING')
    `).run(TENANT_LEGIT_ID, APT_AUTHORIZED_ID);

    // 2. Tarefa de outro tenant (Tenant 202, Apt 99)
    const tOtherTenant = db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
      VALUES (?, ?, 'CREATE', 'PENDING')
    `).run(TENANT_OTHER_ID, APT_OTHER_TENANT_ID);

    // 3. Tarefa de outro agendamento do mesmo tenant (Tenant 3, Apt 100)
    const tOtherApt = db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status)
      VALUES (?, ?, 'CREATE', 'PENDING')
    `).run(TENANT_LEGIT_ID, APT_UNAUTHORIZED_ID);

    // Mock seguro fail-closed para simular resposta do Google Calendar na tarefa autorizada
    googleCalendarService.createCalendarEvent = async () => ({ id: 'g_event_mock_success_17' });

    // Executa processamento da fila outbox
    const processed = await outboxWorker.processGoogleSyncOutbox();
    assert.equal(processed, 1, 'Apenas 1 tarefa (a autorizada) deve ter sido processada');

    // Validações de Preservação Integral de Fila:
    // A) Tarefa autorizada foi processada com sucesso
    const rowAuth = db.prepare('SELECT status, last_error FROM google_sync_outbox WHERE id = ?').get(tAuth.lastInsertRowid);
    assert.equal(rowAuth.status, 'SENT', 'Tarefa autorizada deve ter sido enviada com sucesso');

    // B) Tarefa do outro tenant permaneceu estritamente intacta em PENDING
    const rowOtherTenant = db.prepare('SELECT status, locked_at, processed_at, last_error FROM google_sync_outbox WHERE id = ?').get(tOtherTenant.lastInsertRowid);
    assert.equal(rowOtherTenant.status, 'PENDING', 'Tarefa de outro tenant deve permanecer PENDING');
    assert.equal(rowOtherTenant.locked_at, null, 'Lock deve estar limpo');
    assert.equal(rowOtherTenant.processed_at, null, 'processed_at deve permanecer null');

    // C) Tarefa do outro agendamento permaneceu estritamente intacta em PENDING
    const rowOtherApt = db.prepare('SELECT status, locked_at, processed_at, last_error FROM google_sync_outbox WHERE id = ?').get(tOtherApt.lastInsertRowid);
    assert.equal(rowOtherApt.status, 'PENDING', 'Tarefa de outro agendamento deve permanecer PENDING');
    assert.equal(rowOtherApt.locked_at, null);
    assert.equal(rowOtherApt.processed_at, null);

    // D) Agendamentos não autorizados permaneceram com google_sync_status = 'PENDING'
    const aptOtherTenantRow = db.prepare('SELECT google_sync_status FROM appointments WHERE id = ?').get(APT_OTHER_TENANT_ID);
    assert.equal(aptOtherTenantRow.google_sync_status, 'PENDING');

    const aptOtherAptRow = db.prepare('SELECT google_sync_status FROM appointments WHERE id = ?').get(APT_UNAUTHORIZED_ID);
    assert.equal(aptOtherAptRow.google_sync_status, 'PENDING');

    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
  });

  // ===========================================================================
  // CENÁRIO 8: Consumo de Sessão
  // ===========================================================================
  test('8. Consumo de Sessão: sessão com max_executions=1 é transicionada para COMPLETED após recordSessionExecution', () => {
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    delete process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID;

    // 8.1 max_executions = 1
    const session = sessionService.createTestSession({
      userId: TENANT_LEGIT_ID,
      appointmentId: APT_AUTHORIZED_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      accountEmail: EMAIL_LEGIT,
      maxExecutions: 1,
      createdBy: ADMIN_USER_ID,
    });

    assert.equal(session.executions_count, 0);
    assert.equal(session.status, 'ACTIVE');

    // Registra 1 consumo
    const updated = sessionService.recordSessionExecution(session.id);
    assert.equal(updated.executions_count, 1);
    assert.equal(updated.status, 'COMPLETED', 'Deve transicionar imediatamente para COMPLETED');

    // getActiveSession deve retornar null e bloquear
    assert.equal(sessionService.getActiveSession(), null);

    const evalBlocked = gatekeeper.evaluateGatekeeper({
      userId: TENANT_LEGIT_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      appointmentId: APT_AUTHORIZED_ID,
      accountEmail: EMAIL_LEGIT,
      action: 'CREATE',
    });
    assert.equal(evalBlocked.allowed, false);
    assert.equal(evalBlocked.reason, 'NO_ACTIVE_HOMOLOGATION_SESSION');

    // 8.2 max_executions = 2
    const session2 = sessionService.createTestSession({
      userId: TENANT_LEGIT_ID,
      appointmentId: APT_AUTHORIZED_ID,
      calendarId: CALENDAR_SECUNDARIO_LEGIT,
      accountEmail: EMAIL_LEGIT,
      maxExecutions: 2,
      createdBy: ADMIN_USER_ID,
    });

    // 1ª execução
    const firstExec = sessionService.recordSessionExecution(session2.id);
    assert.equal(firstExec.executions_count, 1);
    assert.equal(firstExec.status, 'ACTIVE', 'Permanece ACTIVE na primeira de duas execuções');
    assert.ok(sessionService.getActiveSession(), 'Sessão ainda deve estar ativa');

    // 2ª execução
    const secondExec = sessionService.recordSessionExecution(session2.id);
    assert.equal(secondExec.executions_count, 2);
    assert.equal(secondExec.status, 'COMPLETED', 'Transiciona para COMPLETED após a segunda execução');
    assert.equal(sessionService.getActiveSession(), null);
  });

  // ===========================================================================
  // CENÁRIO 9: Segurança Administrativa (ADMIN_API_KEY Rejeitada e Exigência de MFA)
  // ===========================================================================
  test('9. Segurança Administrativa: endpoints rejeitam ADMIN_API_KEY e exigem sessão interativa com MFA', async () => {
    // 9.1 Acesso sem autenticação -> 401
    const unauthRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/active`, {
      headers: { 'Accept': 'application/json' },
    });
    assert.equal(unauthRes.status, 401, 'Requisição sem autenticação deve retornar 401');

    // 9.2 Acesso com ADMIN_API_KEY -> 403 FORBIDDEN_RESTRICTED_AUTOMATION_SCOPE
    const apiKeyRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/active`, {
      headers: {
        'x-admin-key': process.env.ADMIN_API_KEY,
        'Accept': 'application/json',
      },
    });
    assert.equal(apiKeyRes.status, 403, 'Acesso via ADMIN_API_KEY deve ser estritamente proibido com 403');
    const apiKeyJson = await apiKeyRes.json();
    assert.equal(apiKeyJson.code, 'FORBIDDEN_RESTRICTED_AUTOMATION_SCOPE');

    // 9.3 Acesso com Sessão de Usuário Comum (ROLE = USER) -> 403
    const userSession = userService.createUserSession(TENANT_LEGIT_ID, 7, { mfaVerified: true });
    const userRoleRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/active`, {
      headers: {
        'Authorization': `Bearer ${userSession.sessionToken}`,
        'Accept': 'application/json',
      },
    });
    assert.equal(userRoleRes.status, 403, 'Usuário comum deve ser rejeitado com 403');

    // 9.4 Acesso com Sessão de Admin SEM MFA Verificado -> 403
    const adminSessionNoMfa = userService.createUserSession(ADMIN_USER_ID, 7, { mfaVerified: false });
    const adminNoMfaRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/active`, {
      headers: {
        'Authorization': `Bearer ${adminSessionNoMfa.sessionToken}`,
        'Accept': 'application/json',
      },
    });
    assert.equal(adminNoMfaRes.status, 403, 'Sessão de admin sem MFA verificado deve ser rejeitada com 403');
    const adminNoMfaJson = await adminNoMfaRes.json();
    assert.equal(adminNoMfaJson.code, 'FORBIDDEN_MFA_SESSION_REQUIRED');

    // 9.5 Acesso com Sessão Interativa de Admin COM MFA Verificado -> 200 / 201 Autorizado
    const adminSessionWithMfa = userService.createUserSession(ADMIN_USER_ID, 7, { mfaVerified: true });

    // Consulta de sessão ativa (GET)
    const activeRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/active`, {
      headers: {
        'Authorization': `Bearer ${adminSessionWithMfa.sessionToken}`,
        'Accept': 'application/json',
      },
    });
    assert.equal(activeRes.status, 200, 'Admin interativo com MFA deve acessar endpoint GET com sucesso');
    const activeJson = await activeRes.json();
    assert.equal(activeJson.success, true);

    // Criação de sessão de teste via API HTTP (POST)
    const createRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminSessionWithMfa.sessionToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        userId: TENANT_LEGIT_ID,
        appointmentId: APT_AUTHORIZED_ID,
        calendarId: CALENDAR_SECUNDARIO_LEGIT,
        accountEmail: EMAIL_LEGIT,
        allowedAction: 'CREATE',
        durationMinutes: 20,
        maxExecutions: 1,
        reason: 'Teste HTTP automatizado via Admin MFA',
      }),
    });

    assert.equal(createRes.status, 201, 'Criação de sessão via Admin interativo com MFA deve retornar 201 Created');
    const createJson = await createRes.json();
    assert.equal(createJson.success, true);
    assert.ok(createJson.session?.id);
    assert.equal(createJson.session.calendar_id, CALENDAR_SECUNDARIO_LEGIT);

    // Anti-Primary Shield via endpoint HTTP: tentativa de enviar calendarId='primary'
    const createPrimaryRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminSessionWithMfa.sessionToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        userId: TENANT_LEGIT_ID,
        appointmentId: APT_AUTHORIZED_ID,
        calendarId: 'primary',
        accountEmail: EMAIL_LEGIT,
      }),
    });
    assert.equal(createPrimaryRes.status, 400, 'Tentativa de criar sessão com calendarId primary deve retornar 400');
    const createPrimaryJson = await createPrimaryRes.json();
    assert.equal(createPrimaryJson.code, 'ANTI_PRIMARY_VIOLATION');

    // Revogação via endpoint HTTP (POST)
    const revokeRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/revoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminSessionWithMfa.sessionToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sessionId: createJson.session.id,
        reason: 'Revogação manual via painel',
      }),
    });
    assert.equal(revokeRes.status, 200, 'Revogação via Admin MFA deve retornar 200');
    const revokeJson = await revokeRes.json();
    assert.equal(revokeJson.success, true);
    assert.equal(revokeJson.changes, 1);

    // Histórico de auditoria via endpoint HTTP (GET)
    const historyRes = await fetch(`${baseUrl}/api/admin/google-sync/test-session/history?limit=10`, {
      headers: {
        'Authorization': `Bearer ${adminSessionWithMfa.sessionToken}`,
        'Accept': 'application/json',
      },
    });
    assert.equal(historyRes.status, 200, 'Consulta de histórico via Admin MFA deve retornar 200');
    const historyJson = await historyRes.json();
    assert.equal(historyJson.success, true);
    assert.ok(Array.isArray(historyJson.sessions));
    assert.ok(historyJson.sessions.length >= 1);
  });

});
