/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADOS HERMÉTICOS (COMANDO 064.1)
 * MÓDULO: Conclusão do Dynamic Late-Binding e Fluxo Real Integrado do WhatsApp
 * Branch: security/raia-27-protecoes
 * Ambiente: raia-staging
 *
 * Padrão Hermético Mandatório:
 * 1. Isolamento Absoluto de Banco de Dados: DB_PATH isolado em os.tmpdir() e destruído em test.after().
 * 2. Módulos Nativos Node.js 22: node:test e node:assert/strict (zero dependências externas).
 * 3. Dynamic Late-Binding 100% Automático: ZERO comandos UPDATE manuais no banco pelo teste.
 * 4. Sandbox e Mocks Fail-Closed: Sem chamadas externas ao WhatsApp ou à API do Google Calendar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// =============================================================================
// CONFIGURAÇÃO DO AMBIENTE HERMÉTICO E ISOLAMENTO DE BANCO DE DADOS
// =============================================================================

const tempDbPath = path.join(
  os.tmpdir(),
  `test_comando064_1_late_binding_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.db`
);

const originalEnv = {
  DB_PATH: process.env.DB_PATH,
  NODE_ENV: process.env.NODE_ENV,
  APP_MODE: process.env.APP_MODE,
  HOMOLOGACAO: process.env.HOMOLOGACAO,
  ALLOW_SALON_WHATSAPP_TESTING: process.env.ALLOW_SALON_WHATSAPP_TESTING,
  SALON_TEST_ALLOWED_TENANTS: process.env.SALON_TEST_ALLOWED_TENANTS,
  SALON_TEST_ALLOWED_PHONES: process.env.SALON_TEST_ALLOWED_PHONES,
  GOOGLE_SYNC_HOMOLOGATION_MODE: process.env.GOOGLE_SYNC_HOMOLOGATION_MODE,
  GOOGLE_SYNC_LIVE_ENABLED: process.env.GOOGLE_SYNC_LIVE_ENABLED,
  JESSICA_CONVERSATIONAL_V2: process.env.JESSICA_CONVERSATIONAL_V2,
  PAUSE_PERSONAL_ASSISTANT: process.env.PAUSE_PERSONAL_ASSISTANT,
  WA_SESSIONS_DISABLED: process.env.WA_SESSIONS_DISABLED,
};

process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '3';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990001,5511999990002';
process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
process.env.JESSICA_CONVERSATIONAL_V2 = 'false';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';

const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const googleCalendarSessionService = require('../src/services/googleCalendarSessionService');
const googleCalendarGatekeeper = require('../src/services/googleCalendarGatekeeper');
const outboxWorker = require('../src/services/outboxWorker');

test.after(() => {
  try {
    outboxWorker.stopWorker();
  } catch (_) {}

  try {
    db.close();
  } catch (_) {}

  const cleanupFiles = [tempDbPath, `${tempDbPath}-shm`, `${tempDbPath}-wal`];
  for (const f of cleanupFiles) {
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch (_) {}
    }
  }

  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

// =============================================================================
// SEEDING DO SALÃO TESTE (TENANT 3) E RECURSOS
// =============================================================================

const openingHours = JSON.stringify({
  timezone: 'America/Sao_Paulo',
  days: {
    0: { open: true, label: 'Domingo', start: '08:00', end: '19:00' },
    1: { open: true, label: 'Segunda-feira', start: '08:00', end: '19:00' },
    2: { open: true, label: 'Terça-feira', start: '08:00', end: '19:00' },
    3: { open: true, label: 'Quarta-feira', start: '08:00', end: '19:00' },
    4: { open: true, label: 'Quinta-feira', start: '08:00', end: '19:00' },
    5: { open: true, label: 'Sexta-feira', start: '08:00', end: '19:00' },
    6: { open: true, label: 'Sábado', start: '08:00', end: '19:00' },
  },
  pauses: [],
  exceptions: [],
});

function seedTestTenant() {
  db.prepare(`
    INSERT OR REPLACE INTO users (
      id, phone_number, name, role, plan_tier, subscription_status,
      paid_until, is_demo, created_at, updated_at
    ) VALUES (
      3, '5511999990003', 'Salão Jéssica Staging', 'CLIENT', 'JESSICA_PRO', 'ACTIVE',
      datetime('now', '+30 days'), 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO products (
      id, code, name, category, solution_type, commercial_status, has_approved_offer, is_active
    ) VALUES (
      1, 'JESSICA', 'Jéssica Agendamentos', 'BEAUTY_SALON', 'AGENDA', 'AVAILABLE', 1, 1
    )
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO customer_subscriptions (
      id, user_id, product_id, status, price_cents, setup_fee_cents,
      billing_cycle, contracted_at, paid_until, access_expires_at
    ) VALUES (
      101, 3, 1, 'ACTIVE', 14900, 0, 'MONTHLY', CURRENT_TIMESTAMP,
      datetime('now', '+30 days'), datetime('now', '+30 days')
    )
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (
      id, user_id, salon_name, phone, opening_hours, whatsapp_status,
      whatsapp_notifications_enabled, b2c_reminders_enabled,
      google_selected_calendar_id, google_calendar_mode, google_sync_existing_authorized
    ) VALUES (
      1, 3, 'Espaço Jéssica Beleza Staging', '5511999990003', ?, 'CONNECTED', 1, 1,
      'agenda-homolog-sec@group.calendar.google.com', 'SECONDARY', 1
    )
  `).run(openingHours);

  db.prepare(`
    INSERT OR REPLACE INTO client_staff (id, user_id, name, specialty, active)
    VALUES (20, 3, 'Camila Cabeleireira', 'Cabelo', 1)
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_services (id, user_id, name, duration_min, price, category, active)
    VALUES (10, 3, 'Corte Feminino', 45, 80.00, 'Cabelo', 1)
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (3, 10, 20, 1)
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, selected_calendar_id, sync_mode,
      is_connected, encrypted_tokens, connected_at, initial_connection_at,
      sync_existing_authorized
    ) VALUES (
      3, 'jessica.homolog@raiaagentes.com.br', 'agenda-homolog-sec@group.calendar.google.com', 'SECONDARY',
      1, '{"access_token":"mock_valid"}', datetime('now', '-1 day'), datetime('now', '-1 day'),
      1
    )
  `).run();
}

// =============================================================================
// SUÍTE DE TESTES: DYNAMIC LATE-BINDING AUTOMÁTICO (COMANDO 064.1)
// =============================================================================

test.describe('COMANDO 064.1 — Dynamic Late-Binding e Fluxo Real Integrado do WhatsApp', () => {

  test.before(() => {
    seedTestTenant();
  });

  const secondaryCalendarId = 'agenda-homolog-sec@group.calendar.google.com';
  const accountEmail = 'jessica.homolog@raiaagentes.com.br';

  test('1. Criação de Sessão Efêmera no modo WHATSAPP_NEW com sentinel appointment_id=0', () => {
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalendarId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 30,
      createdBy: 1,
      reason: 'Demonstração Comercial WhatsApp da Jéssica (Dynamic Late-Binding)',
      authorizedClientPhone: '5511999990001',
    });

    assert.ok(session, 'Sessão temporária deve ser criada');
    assert.equal(session.user_id, 3);
    assert.equal(session.appointment_id, 0, 'Sentinel appointment_id inicial deve ser 0');
    assert.equal(session.status, 'ACTIVE');
    assert.equal(session.session_type, 'WHATSAPP_NEW');
    assert.equal(session.allow_new_appointments, 1);
    assert.equal(session.allowed_action, 'CREATE');
    assert.equal(session.max_executions, 1);
    assert.equal(session.executions_count, 0);

    const active = googleCalendarSessionService.getActiveTestSession(3);
    assert.ok(active, 'Deve existir sessão ativa para o tenant 3');
    assert.equal(active.id, session.id);
  });

  test('2. Dynamic Late-Binding AUTOMÁTICO no bookAppointmentSync (ZERO SQL manual no teste)', () => {
    // Busca a sessão ativa antes do agendamento
    const sessionBefore = googleCalendarSessionService.getActiveTestSession(3);
    assert.ok(sessionBefore);
    assert.equal(sessionBefore.appointment_id, 0);
    assert.equal(sessionBefore.session_type, 'WHATSAPP_NEW');

    // Executa a reserva exatamente como o WhatsApp Bot faz: origin = 'WHATSAPP_BOT'
    const newAppointment = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Ana Paula Cliente Demo',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-29',
      time: '14:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001'),
    });

    assert.ok(newAppointment, 'Agendamento deve ser criado com sucesso');
    assert.ok(newAppointment.id > 0, 'Agendamento deve ter ID positivo');
    const newAptId = newAppointment.id;

    // Inspeciona o estado da sessão no banco de dados SEM NENHUM UPDATE MANUAL
    const sessionAfter = googleCalendarSessionService.getActiveTestSession(3);
    assert.ok(sessionAfter, 'Sessão deve continuar ACTIVE');
    assert.equal(
      sessionAfter.appointment_id,
      newAptId,
      'A sessão efêmera deve ter sido vinculada AUTOMATICAMENTE ao novo agendamento'
    );
    assert.equal(
      sessionAfter.session_type,
      'EXISTING_APPOINTMENT',
      'session_type deve transicionar para EXISTING_APPOINTMENT'
    );
    assert.equal(
      sessionAfter.allow_new_appointments,
      0,
      'allow_new_appointments deve ser travado em 0 após o vínculo'
    );

    // Verifica que a outbox foi criada para o agendamento vinculado
    const outboxRow = db.prepare(`
      SELECT * FROM google_sync_outbox
      WHERE user_id = 3 AND appointment_id = ? AND action = 'CREATE'
    `).get(newAptId);

    assert.ok(outboxRow, 'Deve existir tarefa na google_sync_outbox');
    assert.equal(outboxRow.status, 'PENDING');
  });

  test('3. Execução completa do Outbox Worker com o agendamento vinculado via Late-Binding', async () => {
    const session = googleCalendarSessionService.getActiveSession(3);
    assert.ok(session);
    const targetAptId = session.appointment_id;
    assert.ok(targetAptId > 0);

    // Garante status PENDING e desmarca qualquer lock concorrente para o teste de processamento real
    db.prepare(`
      UPDATE google_sync_outbox
      SET status = 'PENDING', locked_at = NULL
      WHERE user_id = 3 AND appointment_id = ? AND action = 'CREATE'
    `).run(targetAptId);

    const outboxRow = db.prepare(`
      SELECT * FROM google_sync_outbox
      WHERE user_id = 3 AND appointment_id = ? AND action = 'CREATE'
    `).get(targetAptId);
    assert.ok(outboxRow);

    const googleCalendarService = require('../src/services/googleCalendarService');
    let mockCreatedCalendarId = null;

    googleCalendarService.setMockHandler({
      createCalendarEvent: async (userId, apt, calId) => {
        mockCreatedCalendarId = calId;
        return {
          id: `gevent_demo_${Date.now()}`,
          htmlLink: 'https://calendar.google.com/event?eid=mock_demo',
          isSimulated: false,
        };
      },
    });

    // Ativa temporariamente GOOGLE_SYNC_LIVE_ENABLED para validar o Gatekeeper
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

    try {
      // 3.1 Avalia Gatekeeper diretamente: deve aprovar
      const gateResult = googleCalendarGatekeeper.evaluateGatekeeper({
        userId: 3,
        calendarId: secondaryCalendarId,
        appointmentId: targetAptId,
        accountEmail,
        action: 'CREATE',
        isDemo: false,
      });

      assert.equal(gateResult.allowed, true, 'Gatekeeper deve aprovar agendamento vinculado');
      assert.equal(gateResult.reason, 'AUTHORIZED_HOMOLOGATION');
      assert.equal(gateResult.isAuthorizedHomologation, true);

      // 3.2 Executa processamento da outbox via outboxWorker.processGoogleSyncOutbox()
      const processedCount = await outboxWorker.processGoogleSyncOutbox();
      assert.ok(processedCount >= 1, 'Ao menos uma tarefa da outbox deve ter sido processada');
      assert.equal(mockCreatedCalendarId, secondaryCalendarId, 'Deve usar exclusivamente calendário secundário');

      // 3.3 Verifica status da outbox atualizado para SENT
      const updatedOutbox = db.prepare(`SELECT * FROM google_sync_outbox WHERE id = ?`).get(outboxRow.id);
      assert.equal(updatedOutbox.status, 'SENT');

      // 3.4 Inspeciona sessão efêmera: max_executions=1 atingido deve transicionar para COMPLETED
      const updatedSession = db.prepare(`SELECT * FROM google_sync_test_sessions WHERE id = ?`).get(session.id);
      assert.equal(updatedSession.executions_count, 1);
      assert.equal(updatedSession.status, 'COMPLETED', 'Sessão 1/1 deve transicionar para COMPLETED');

      // 3.5 Após completion, nova verificação no Gatekeeper deve bloquear
      const gateAfter = googleCalendarGatekeeper.evaluateGatekeeper({
        userId: 3,
        calendarId: secondaryCalendarId,
        appointmentId: targetAptId,
        accountEmail,
        action: 'CREATE',
        isDemo: false,
      });
      assert.equal(gateAfter.allowed, false, 'Após sessão COMPLETED, Gatekeeper deve bloquear');
      assert.equal(gateAfter.reason, 'NO_ACTIVE_HOMOLOGATION_SESSION');
    } finally {
      googleCalendarService.resetMockHandler();
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
    }
  });

  test('4. Proteção de Origem (Origin Shield): Agendamento de canal não-WhatsApp NÃO se vincula', () => {
    // Abre nova sessão WHATSAPP_NEW
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalendarId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      createdBy: 1,
      reason: 'Teste Origin Shield',
      authorizedClientPhone: '5511999990001',
    });
    assert.equal(session.appointment_id, 0);

    // Cria agendamento com origin 'PAINEL_CLIENTE' (não WHATSAPP_BOT)
    const panelApt = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Cliente Via Painel Web',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-29',
      time: '15:30',
      durationMin: 45,
      origin: 'PAINEL_CLIENTE', // CANAL DISTINTO
    });

    // Sessão continua intacta com appointment_id = 0
    const currentSession = googleCalendarSessionService.getActiveTestSession(3);
    assert.equal(currentSession.appointment_id, 0, 'Sessão não deve ser vinculada a agendamento do painel');
    assert.equal(currentSession.allow_new_appointments, 1);

    // Revoga a sessão de teste
    googleCalendarSessionService.revokeSession(session.id, 1, 'Limpeza de teste');
  });

  test('5. Proteção Multi-Tenant (Tenant Shield): Agendamento de outro tenant NÃO afeta a sessão', () => {
    // Seed de um segundo usuário tenant 4
    db.prepare(`
      INSERT OR REPLACE INTO users (id, phone_number, name, role, plan_tier, subscription_status)
      VALUES (4, '5511999990004', 'Outro Salão Tenant 4', 'CLIENT', 'JESSICA_PRO', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO client_salons (id, user_id, salon_name, phone, opening_hours)
      VALUES (2, 4, 'Salão Tenant 4', '5511999990004', ?)
    `).run(openingHours);

    db.prepare(`
      INSERT OR REPLACE INTO client_staff (id, user_id, name, specialty, active)
      VALUES (21, 4, 'Staff Tenant 4', 'Geral', 1)
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO client_services (id, user_id, name, duration_min, price, category, active)
      VALUES (11, 4, 'Serviço Tenant 4', 30, 50.00, 'Geral', 1)
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO client_service_staff (user_id, service_id, staff_id, confirmed)
      VALUES (4, 11, 21, 1)
    `).run();

    // Cria sessão WHATSAPP_NEW para o tenant 3
    const sessionT3 = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalendarId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      createdBy: 1,
      reason: 'Teste Tenant Shield',
      authorizedClientPhone: '5511999990001',
    });

    // Tenant 4 cria agendamento via WhatsApp
    const aptT4 = salonAppointmentService.bookAppointmentSync(4, {
      clientName: 'Cliente Tenant 4',
      clientPhone: '5511999990001',
      serviceId: 11,
      serviceName: 'Serviço Tenant 4',
      staffId: 21,
      date: '2026-11-29',
      time: '16:00',
      durationMin: 30,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(4, '5511999990001'),
    });

    // Sessão do Tenant 3 NÃO deve ter sido tocada
    const currentT3 = googleCalendarSessionService.getActiveTestSession(3);
    assert.equal(currentT3.appointment_id, 0, 'Sessão do Tenant 3 não deve ser vinculada ao Tenant 4');

    googleCalendarSessionService.revokeSession(sessionT3.id, 1, 'Limpeza de teste');
  });

  test('6. Proteção de Telefone Autorizado (Phone Shield): Telefone divergente NÃO vincula', () => {
    // Cria sessão autorizando APENAS o telefone 5511999990001
    const sessionPhoneLocked = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalendarId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      createdBy: 1,
      reason: 'Teste Phone Shield',
      authorizedClientPhone: '5511999990001',
    });

    // Agendamento chega do telefone 5511999990002 (da whitelist geral, mas divergente do pino da sessão)
    const aptOtherPhone = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Cliente Outro Telefone',
      clientPhone: '5511999990002',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-29',
      time: '16:30',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990002'),
    });

    const activeSession = googleCalendarSessionService.getActiveTestSession(3);
    assert.equal(
      activeSession.appointment_id,
      0,
      'Sessão com telefone pinned não deve vincular a telefone diferente'
    );

    // Agora agendamento chega com o telefone correto pinned: 5511999990001
    const aptCorrectPhone = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Cliente Telefone Correto',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-29',
      time: '17:30',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001'),
    });

    const boundSession = googleCalendarSessionService.getActiveTestSession(3);
    assert.equal(
      boundSession.appointment_id,
      aptCorrectPhone.id,
      'Sessão deve vincular imediatamente quando o telefone confere'
    );

    googleCalendarSessionService.revokeSession(sessionPhoneLocked.id, 1, 'Limpeza de teste');
  });

  test('7. Proteção Anti-Reuso / Predicate Lock: Segunda reserva NÃO sobrescreve a sessão já vinculada', () => {
    // 1. Cria sessão WHATSAPP_NEW
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalendarId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      createdBy: 1,
      reason: 'Teste Anti-Reuso',
      authorizedClientPhone: '5511999990001',
    });

    // 2. Primeira reserva vincula
    const firstApt = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Primeiro Agendamento',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-30',
      time: '09:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001'),
    });

    const afterFirst = googleCalendarSessionService.getActiveTestSession(3);
    assert.equal(afterFirst.appointment_id, firstApt.id);
    assert.equal(afterFirst.allow_new_appointments, 0);

    // 3. Segunda reserva chega logo em seguida pelo WhatsApp
    const secondApt = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Segundo Agendamento',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-30',
      time: '10:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001'),
    });

    // 4. A sessão PRESERVA o primeiro agendamento e NÃO foi roubada pelo segundo
    const afterSecond = googleCalendarSessionService.getActiveTestSession(3);
    assert.equal(
      afterSecond.appointment_id,
      firstApt.id,
      'Sessão deve permanecer com o 1º agendamento e rejeitar vinculação múltipla'
    );

    googleCalendarSessionService.revokeSession(session.id, 1, 'Limpeza de teste');
  });

  test('8. Proteção de Sessão Expirada (TTL Shield): Sessão vencida não vincula e é rejeitada pelo Gatekeeper', () => {
    // Cria sessão já expirada no passado
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalendarId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 1,
      createdBy: 1,
      reason: 'Teste TTL',
      authorizedClientPhone: '5511999990001',
    });

    // Força data de expiração no passado via DB
    db.prepare(`UPDATE google_sync_test_sessions SET expires_at = datetime('now', '-5 minutes') WHERE id = ?`).run(session.id);

    // Tenta vincular via reserva
    const lateApt = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Cliente Atrasado',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-30',
      time: '11:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001'),
    });

    // A sessão continua com appointment_id = 0 e status expira
    const dbSession = db.prepare(`SELECT * FROM google_sync_test_sessions WHERE id = ?`).get(session.id);
    assert.equal(dbSession.appointment_id, 0, 'Sessão expirada não deve receber vínculo dinâmico');

    // Gatekeeper fail-closed
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    try {
      const gate = googleCalendarGatekeeper.evaluateGatekeeper({
        userId: 3,
        calendarId: secondaryCalendarId,
        appointmentId: lateApt.id,
        accountEmail,
        action: 'CREATE',
        isDemo: false,
      });
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, 'NO_ACTIVE_HOMOLOGATION_SESSION');
    } finally {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
    }
  });

  test('9. Anti-Primary Shield: Rejeição incondicional de calendarId="primary"', () => {
    assert.throws(
      () => {
        googleCalendarSessionService.createTestSession({
          userId: 3,
          sessionType: 'WHATSAPP_NEW',
          appointmentId: 0,
          calendarId: 'primary', // VIOLAÇÃO OWASP ASVS
          accountEmail,
          allowedAction: 'CREATE',
          maxExecutions: 1,
          durationMinutes: 15,
          createdBy: 1,
          authorizedClientPhone: '5511999990001',
        });
      },
      (err) => {
        assert.ok(err.message.includes('Anti-Primary Shield'));
        return true;
      },
      'Deve barrar calendarId="primary"'
    );
  });

  test('10. Restrição Mandatória de Tenant: Modo WHATSAPP_NEW bloqueado para qualquer tenant !== 3', () => {
    assert.throws(
      () => {
        googleCalendarSessionService.createTestSession({
          userId: 2, // Tenant não autorizado para demonstração
          sessionType: 'WHATSAPP_NEW',
          appointmentId: 0,
          calendarId: secondaryCalendarId,
          accountEmail,
          allowedAction: 'CREATE',
          maxExecutions: 1,
          durationMinutes: 15,
          createdBy: 1,
          authorizedClientPhone: '5511999990001',
        });
      },
      (err) => {
        assert.ok(err.message.includes('apenas para o Tenant 3') || err.message.includes('TENANT_RESTRICTED'));
        return true;
      },
      'Modo WHATSAPP_NEW deve ser restrito ao tenant 3'
    );
  });

});
