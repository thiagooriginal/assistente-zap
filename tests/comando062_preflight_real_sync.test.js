'use strict';

/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS DO COMANDO 062
 * Pré-requisito e Validação do Primeiro Teste Real do Google Calendar
 * Branch: security/raia-27-protecoes
 *
 * Módulos Nativos: node:test, node:assert/strict, node:sqlite (DatabaseSync)
 * Isolamento Mandatório: Banco descartável em os.tmpdir()
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('os');

// 1. ISOLAMENTO MANDATÓRIO DE BANCO DE DADOS (Padrão Hermético RAIA)
const tempDbPath = path.join(os.tmpdir(), `test_raia_cmd062_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tempDbPath;

// 2. CHAVES CRIPTOGRÁFICAS PARA TESTES EM MEMÓRIA
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'test_encryption_key_32_bytes_long_secret_12345';
process.env.MFA_ENCRYPTION_KEY = 'test_encryption_key_32_bytes_long_secret_12345';
process.env.SESSION_SECRET = 'test_session_secret_32_bytes_super_secure';

// 3. CARREGAMENTO DOS MÓDULOS DO SISTEMA
const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const gatekeeper = require('../src/services/googleCalendarGatekeeper');
const outboxWorker = require('../src/services/outboxWorker');

test.describe('COMANDO 062: Validação de Pré-Voo do Teste Real do Google Calendar', () => {

  test.before(() => {
    // 3.1. Semeação de Dados Controlados para Testes

    // Tenant 3: Salão Comercial Autorizado para Homologação
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan_tier, subscription_status, paid_until, is_demo)
      VALUES (3, '5511999990003', 'Salão Homologação Real', 'USER', 'JESSICA_PRO', 'ACTIVE', '2099-12-31T23:59:59.000Z', 0)
    `).run();

    db.prepare(`
      INSERT INTO client_salons (id, user_id, salon_name, google_selected_calendar_id, google_calendar_mode)
      VALUES (3, 3, 'Salão Homologação Real', 'c_homologacao@group.calendar.google.com', 'SINGLE')
    `).run();

    const encTokens = googleCalendarService.encryptTokens({
      access_token: 'fake_live_access_token',
      refresh_token: 'fake_live_refresh_token',
      scope: 'https://www.googleapis.com/auth/calendar.events',
    });

    db.prepare(`
      INSERT INTO google_calendar_tokens (
        user_id, account_email, encrypted_tokens, selected_calendar_id,
        selected_calendar_name, sync_mode, is_connected, connected_at,
        initial_connection_at, sync_existing_authorized
      ) VALUES (
        3, 'homologacao@raiaagentes.com.br', ?, 'c_homologacao@group.calendar.google.com',
        'Agenda Homologacao', 'SINGLE', 1, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, 1
      )
    `).run(encTokens);

    // Assinatura ativa do módulo Jéssica no Customer Subscriptions para Tenant 3
    const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
    if (jessicaProd) {
      db.prepare(`
        INSERT INTO customer_subscriptions (
          user_id, product_id, status, price_cents, billing_cycle, contracted_at, paid_until, access_expires_at
        ) VALUES (
          3, ?, 'ACTIVE', 8900, 'MONTHLY', CURRENT_TIMESTAMP, '2099-12-31T23:59:59.000Z', '2099-12-31T23:59:59.000Z'
        )
      `).run(jessicaProd.id);
    }

    // Tenant 2: Salão Demonstração (is_demo = 1)
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan_tier, subscription_status, paid_until, is_demo)
      VALUES (2, '5511999990002', 'Salão Demonstração', 'USER', 'JESSICA_START', 'ACTIVE', '2099-12-31T23:59:59.000Z', 1)
    `).run();

    db.prepare(`
      INSERT INTO client_salons (id, user_id, salon_name, google_selected_calendar_id, google_calendar_mode)
      VALUES (2, 2, 'Salão Demonstração', 'c_demo@group.calendar.google.com', 'SINGLE')
    `).run();

    db.prepare(`
      INSERT INTO google_calendar_tokens (
        user_id, account_email, encrypted_tokens, selected_calendar_id,
        selected_calendar_name, sync_mode, is_connected, connected_at,
        initial_connection_at, sync_existing_authorized
      ) VALUES (
        2, 'demo@raiaagentes.com.br', ?, 'c_demo@group.calendar.google.com',
        'Agenda Demo', 'SINGLE', 1, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, 1
      )
    `).run(encTokens);

    // Tenant 202: Salão Terceiro Isolado
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan_tier, subscription_status, paid_until, is_demo)
      VALUES (202, '5511999990202', 'Salão Terceiro Outro', 'USER', 'JESSICA_START', 'ACTIVE', '2099-12-31T23:59:59.000Z', 0)
    `).run();

    db.prepare(`
      INSERT INTO client_salons (id, user_id, salon_name, google_selected_calendar_id)
      VALUES (202, 202, 'Salão Terceiro Outro', 'c_outro@group.calendar.google.com')
    `).run();
  });

  test.after(() => {
    // Reset dos Mocks e Variáveis de Ambiente
    googleCalendarService.resetMockHandler();
    delete process.env.GOOGLE_SYNC_LIVE_ENABLED;
    delete process.env.GOOGLE_SYNC_HOMOLOGATION_MODE;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID;
    delete process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL;
    delete process.env.GOOGLE_SYNC_ALLOWED_EMAILS;

    // Destruição Hermética do Banco SQLite Temporário
    try {
      db.close();
    } catch (_) {}

    for (const ext of ['', '-wal', '-shm', '-journal']) {
      const f = tempDbPath + ext;
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
  });

  // =========================================================================
  // CENÁRIO 1: CENÁRIO AUTORIZADO COM ESCRITA REAL SIMULADA VIA MOCK
  // =========================================================================
  test('1. Cenário Autorizado com Escrita Real: Worker executa mock, grava google_event_id real, outbox=SENT e apt=SYNCED', async () => {
    // 1. Configura os 5 Pinos de Homologação e o Live Switch Ativo
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
    process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '3';
    process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'c_homologacao@group.calendar.google.com';
    process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '99';
    process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'homologacao@raiaagentes.com.br';
    process.env.GOOGLE_SYNC_ALLOWED_EMAILS = 'homologacao@raiaagentes.com.br';

    // 2. Insere Agendamento #99 e Tarefa CREATE na Outbox
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, title, description, start_datetime, end_datetime,
        status, google_calendar_id, google_sync_status, client_name
      ) VALUES (
        99, 3, 'Corte Masculino Premium', 'Primeiro teste controlado de homologação',
        '2026-11-25 14:00:00', '2026-11-25 15:00:00',
        'CONFIRMADO', 'c_homologacao@group.calendar.google.com', 'PENDING', 'Carlos Silva'
      )
    `).run();

    db.prepare(`
      INSERT INTO google_sync_outbox (
        id, user_id, appointment_id, action, status, payload_json
      ) VALUES (
        99, 3, 99, 'CREATE', 'PENDING',
        '{"startDt":"2026-11-25 14:00:00","endDt":"2026-11-25 15:00:00","finalServiceName":"Corte Masculino Premium"}'
      )
    `).run();

    // 3. Configura Mock Handler interceptando a escrita real simulada
    let mockCreateCalls = [];
    googleCalendarService.setMockHandler({
      createCalendarEvent: async (userId, appointment, targetCalendarId) => {
        mockCreateCalls.push({ userId, appointmentId: appointment.id, targetCalendarId });
        const googleEventId = `gcal_real_event_${appointment.id}`;
        db.prepare(`
          UPDATE appointments
          SET google_event_id = ?, google_calendar_id = ?, google_sync_status = 'SYNCED', google_sync_error = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(googleEventId, targetCalendarId, appointment.id, userId);
        return {
          success: true,
          googleEventId,
          calendarId: targetCalendarId,
          isSimulated: false, // Simula retorno de sucesso de escrita real
        };
      },
    });

    // 4. Executa o Outbox Worker
    const processed = await outboxWorker.processGoogleSyncOutbox(3);

    // 5. Asserções Estritas
    assert.equal(processed, 1, 'Worker deve ter processado exatamente 1 tarefa autorizada');
    assert.equal(mockCreateCalls.length, 1, 'Mock de criação deve ter sido invocado exatamente 1 vez');
    assert.equal(mockCreateCalls[0].userId, 3, 'Tenant do mock deve ser 3');
    assert.equal(mockCreateCalls[0].appointmentId, 99, 'Agendamento do mock deve ser 99');
    assert.equal(mockCreateCalls[0].targetCalendarId, 'c_homologacao@group.calendar.google.com', 'Calendário secundário correto');

    // 6. Validação no Banco de Dados SQLite
    const outbox99 = db.prepare('SELECT * FROM google_sync_outbox WHERE id = 99').get();
    assert.equal(outbox99.status, 'SENT', 'Status na outbox deve ter transitado para SENT');
    assert.ok(outbox99.processed_at, 'processed_at deve estar registrado');

    const apt99 = db.prepare('SELECT * FROM appointments WHERE id = 99').get();
    assert.equal(apt99.google_sync_status, 'SYNCED', 'google_sync_status no agendamento deve ser SYNCED');
    assert.equal(apt99.google_event_id, 'gcal_real_event_99', 'google_event_id gravado deve ser o retornado pelo mock');
    assert.equal(apt99.google_sync_error, null, 'Nenhum erro residual no agendamento');
  });

  // =========================================================================
  // CENÁRIO 2: ISOLAMENTO DE TAREFAS ANTIGAS
  // =========================================================================
  test('2. Isolamento de Tarefas Antigas: Tarefa 21 (SIMULATED, apt=16) NÃO é selecionada nem executada pelo worker', async () => {
    // 1. Semeia agendamento antigo #16 e tarefa #21 com status SIMULATED
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, title, start_datetime, end_datetime,
        status, google_calendar_id, google_sync_status, google_event_id
      ) VALUES (
        16, 3, 'Corte Antigo Simulado', '2026-11-20 10:00:00', '2026-11-20 11:00:00',
        'CONFIRMADO', 'c_homologacao@group.calendar.google.com', 'SIMULATED', 'sim_gcal_16'
      )
    `).run();

    db.prepare(`
      INSERT INTO google_sync_outbox (
        id, user_id, appointment_id, action, status, last_error, processed_at
      ) VALUES (
        21, 3, 16, 'CREATE', 'SIMULATED', 'Ambiente de Homologação: Sincronização segura simulada', CURRENT_TIMESTAMP
      )
    `).run();

    let calls = 0;
    googleCalendarService.setMockHandler({
      createCalendarEvent: async () => { calls++; return { success: true }; },
    });

    // 2. Executa worker para tenant 3 (com agendamento 99 já processado)
    const processed = await outboxWorker.processGoogleSyncOutbox(3);

    // 3. Asserções
    assert.equal(processed, 0, 'Worker não deve processar tarefas com status SIMULATED');
    assert.equal(calls, 0, 'Nenhuma chamada ao mock deve ocorrer para tarefas antigas');

    const task21 = db.prepare('SELECT status, last_error FROM google_sync_outbox WHERE id = 21').get();
    assert.equal(task21.status, 'SIMULATED', 'Tarefa 21 deve permanecer rigorosamente SIMULATED');

    const apt16 = db.prepare('SELECT google_sync_status FROM appointments WHERE id = 16').get();
    assert.equal(apt16.google_sync_status, 'SIMULATED', 'Agendamento 16 deve permanecer SIMULATED');
  });

  // =========================================================================
  // CENÁRIO 3: PRESERVAÇÃO DE FILA DE TERCEIROS E OUTROS AGENDAMENTOS
  // =========================================================================
  test('3. Preservação de Fila: Tarefas PENDING de outro salão (tenant 202) e outro agendamento (apt 100) permanecem PENDING', async () => {
    // 1. Tarefa de outro salão (tenant 202)
    db.prepare(`
      INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status)
      VALUES (202, 202, 'Escova Salão Terceiro', '2026-11-26 10:00:00', '2026-11-26 11:00:00', 'CONFIRMADO', 'PENDING')
    `).run();

    db.prepare(`
      INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status)
      VALUES (101, 202, 202, 'CREATE', 'PENDING')
    `).run();

    // 2. Outro agendamento do mesmo salão (tenant 3, apt 100)
    db.prepare(`
      INSERT INTO appointments (id, user_id, title, start_datetime, end_datetime, status, google_sync_status)
      VALUES (100, 3, 'Manicure Salão 3', '2026-11-26 14:00:00', '2026-11-26 15:00:00', 'CONFIRMADO', 'PENDING')
    `).run();

    db.prepare(`
      INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status)
      VALUES (102, 3, 100, 'CREATE', 'PENDING')
    `).run();

    // 3. Executa o worker sem filtro explícito de usuário
    const processed = await outboxWorker.processGoogleSyncOutbox();

    // 4. Asserções
    assert.equal(processed, 0, 'Em homologação restrita, nenhuma tarefa não autorizada deve ser processada');

    const task101 = db.prepare('SELECT status, locked_at FROM google_sync_outbox WHERE id = 101').get();
    assert.equal(task101.status, 'PENDING', 'Tarefa de terceiro (101) deve permanecer intacta em PENDING');
    assert.equal(task101.locked_at, null, 'Lock de terceiro deve permanecer nulo');

    const task102 = db.prepare('SELECT status, locked_at FROM google_sync_outbox WHERE id = 102').get();
    assert.equal(task102.status, 'PENDING', 'Tarefa de outro agendamento (102) deve permanecer intacta em PENDING');
    assert.equal(task102.locked_at, null, 'Lock de outro agendamento deve permanecer nulo');
  });

  // =========================================================================
  // CENÁRIO 4: BARREIRA ANTI-PRIMARY SHIELD COM LIVE SWITCH ATIVO
  // =========================================================================
  test('4. Barreira Anti-Primary Shield: targetCalendarId="primary" ou "default" é bloqueado e chamada ao mock não ocorre', async () => {
    // 1. Validação Direta no Gatekeeper
    const gateCheckPrimary = gatekeeper.evaluateGatekeeper({
      userId: 3,
      calendarId: 'primary',
      appointmentId: 99,
      accountEmail: 'homologacao@raiaagentes.com.br',
      isDemo: false,
    });

    assert.equal(gateCheckPrimary.allowed, false, 'Anti-Primary Shield deve bloquear primary');
    assert.equal(gateCheckPrimary.reason, 'PRIMARY_CALENDAR_PROHIBITED');

    const gateCheckDefault = gatekeeper.evaluateGatekeeper({
      userId: 3,
      calendarId: 'default',
      appointmentId: 99,
      accountEmail: 'homologacao@raiaagentes.com.br',
      isDemo: false,
    });

    assert.equal(gateCheckDefault.allowed, false, 'Anti-Primary Shield deve bloquear default');
    assert.equal(gateCheckDefault.reason, 'PRIMARY_CALENDAR_PROHIBITED');

    // 2. Validação no Worker com Live Switch Ativo
    process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '98';
    db.prepare(`
      INSERT INTO appointments (
        id, user_id, title, start_datetime, end_datetime,
        status, google_calendar_id, google_sync_status
      ) VALUES (
        98, 3, 'Agendamento Tentando Primary', '2026-11-27 10:00:00', '2026-11-27 11:00:00',
        'CONFIRMADO', 'primary', 'PENDING'
      )
    `).run();

    db.prepare(`
      INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status)
      VALUES (98, 3, 98, 'CREATE', 'PENDING')
    `).run();

    let createCalls = 0;
    googleCalendarService.setMockHandler({
      createCalendarEvent: async () => { createCalls++; return { success: true }; },
    });

    await outboxWorker.processGoogleSyncOutbox(3);

    // 3. Asserção Crítica: O Mock NUNCA foi chamado
    assert.equal(createCalls, 0, 'NENHUMA chamada ao mock de criação deve ocorrer sob primary calendar');

    // 4. Fila preservada e destravada
    const task98 = db.prepare('SELECT status, locked_at FROM google_sync_outbox WHERE id = 98').get();
    assert.equal(task98.status, 'PENDING', 'Tarefa bloqueada por primary calendar é preservada como PENDING');
    assert.equal(task98.locked_at, null, 'Lock destravado');

    // Restaura autorização para agendamento 99
    process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '99';
  });

  // =========================================================================
  // CENÁRIO 5: BARREIRA DEMO SHIELD COM LIVE SWITCH ATIVO
  // =========================================================================
  test('5. Barreira Demo Shield: Tenant is_demo=1 (Tenant 2) é bloqueado com DEMO_TENANT_BLOCKED e vira SIMULATED local', async () => {
    // 1. Validação Direta no Gatekeeper
    const gateCheckDemo = gatekeeper.evaluateGatekeeper({
      userId: 2,
      calendarId: 'c_homologacao@group.calendar.google.com',
      appointmentId: 200,
      accountEmail: 'homologacao@raiaagentes.com.br',
      isDemo: 1,
    });

    assert.equal(gateCheckDemo.allowed, false, 'Demo Shield deve bloquear tenant demo');
    assert.equal(gateCheckDemo.reason, 'DEMO_TENANT_BLOCKED');

    // 2. Validação no Worker para Conta Demo: mesmo se configurada como autorizada, o Demo Shield veta
    process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '2';
    process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '200';

    db.prepare(`
      INSERT INTO appointments (
        id, user_id, title, start_datetime, end_datetime,
        status, google_calendar_id, google_sync_status
      ) VALUES (
        200, 2, 'Agendamento Demo Fake', '2026-11-28 10:00:00', '2026-11-28 11:00:00',
        'CONFIRMADO', 'c_demo@group.calendar.google.com', 'PENDING'
      )
    `).run();

    db.prepare(`
      INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status)
      VALUES (200, 2, 200, 'CREATE', 'PENDING')
    `).run();

    let mockCalls = 0;
    googleCalendarService.setMockHandler({
      createCalendarEvent: async () => { mockCalls++; return { success: true }; },
    });

    // 3. Executa worker para tenant 2
    const processedDemo = await outboxWorker.processGoogleSyncOutbox(2);

    // 4. Asserções
    assert.equal(processedDemo, 1, 'Worker deve processar localmente a conta demo');
    assert.equal(mockCalls, 0, 'Nenhuma chamada ao mock ou à rede para conta demo');

    const outbox200 = db.prepare('SELECT status, last_error FROM google_sync_outbox WHERE id = 200').get();
    assert.equal(outbox200.status, 'SIMULATED', 'Outbox vira SIMULATED localmente');
    assert.ok(outbox200.last_error.includes('is_demo'), 'last_error registra bloqueio de demo');

    const apt200 = db.prepare('SELECT google_sync_status, google_event_id FROM appointments WHERE id = 200').get();
    assert.equal(apt200.google_sync_status, 'SIMULATED', 'Agendamento vira SIMULATED');
    assert.ok(apt200.google_event_id.startsWith('sim_demo_'), 'google_event_id simulado para demo');

    // Restaura autorização para agendamento 99
    process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '3';
    process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '99';
  });

  // =========================================================================
  // CENÁRIO 6: CICLO DE LIMPEZA SEGURA (CLEANUP)
  // =========================================================================
  test('6. Ciclo de Limpeza Segura: Agendamento cancelado gera tarefa DELETE, executa deleteCalendarEvent no mock e marca CANCELLED', async () => {
    // 1. Agendamento #99 previamente sincronizado com sucesso no Cenário 1 (google_event_id = 'gcal_real_event_99')
    db.prepare(`
      UPDATE appointments
      SET status = 'CANCELADO', updated_at = CURRENT_TIMESTAMP
      WHERE id = 99
    `).run();

    // 2. Insere tarefa DELETE na Outbox
    db.prepare(`
      INSERT INTO google_sync_outbox (id, user_id, appointment_id, action, status)
      VALUES (999, 3, 99, 'DELETE', 'PENDING')
    `).run();

    // 3. Mock para Deleção
    let mockDeleteCalls = [];
    googleCalendarService.setMockHandler({
      deleteCalendarEvent: async (userId, googleEventId, targetCalendarId) => {
        mockDeleteCalls.push({ userId, googleEventId, targetCalendarId });
        return { success: true, isSimulated: false };
      },
    });

    // 4. Executa worker para tenant 3
    const processed = await outboxWorker.processGoogleSyncOutbox(3);

    // 5. Asserções
    assert.equal(processed, 1, 'Worker deve processar a tarefa DELETE');
    assert.equal(mockDeleteCalls.length, 1, 'Mock de deleção deve ser chamado exatamente 1 vez');
    assert.equal(mockDeleteCalls[0].userId, 3, 'Tenant 3');
    assert.equal(mockDeleteCalls[0].googleEventId, 'gcal_real_event_99', 'ID do evento real deletado');
    assert.equal(mockDeleteCalls[0].targetCalendarId, 'c_homologacao@group.calendar.google.com');

    // 6. Validação no Banco de Dados SQLite
    const outbox999 = db.prepare('SELECT status, processed_at FROM google_sync_outbox WHERE id = 999').get();
    assert.equal(outbox999.status, 'SENT', 'Outbox vira SENT após exclusão remota confirmada');

    const apt99 = db.prepare('SELECT google_sync_status FROM appointments WHERE id = 99').get();
    assert.equal(apt99.google_sync_status, 'CANCELLED', 'Status do agendamento vira CANCELLED');
  });

});
