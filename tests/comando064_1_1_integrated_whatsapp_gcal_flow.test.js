/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADOS HERMÉTICOS (COMANDO 064.1.1)
 * MÓDULO: Blindagem de Telefone e Teste Integrado WhatsApp → Google Calendar
 * Branch: security/raia-27-protecoes
 * Ambiente: raia-staging
 *
 * Padrão Hermético Mandatório:
 * 1. Isolamento Absoluto de Banco de Dados: DB_PATH isolado em os.tmpdir() e destruído em test.after().
 * 2. Módulos Nativos Node.js 22: node:test e node:assert/strict (zero dependências externas).
 * 3. Jornada Conversacional Completa: Mensagens fluindo via salonIncomingDispatcher e socket WhatsApp simulado.
 * 4. Blindagem do Phone Shield e Dispatcher Proof: Zero spoofing de origem ou desvios de whitelist.
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
  `test_comando064_1_1_whatsapp_gcal_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.db`
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
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const googleCalendarSessionService = require('../src/services/googleCalendarSessionService');
const googleCalendarGatekeeper = require('../src/services/googleCalendarGatekeeper');
const googleCalendarService = require('../src/services/googleCalendarService');
const outboxWorker = require('../src/services/outboxWorker');

test.after(() => {
  try {
    outboxWorker.stopWorker();
  } catch (_) {}

  try {
    salonIncomingDispatcher._resetForTesting();
  } catch (_) {}

  try {
    googleCalendarService.resetMockHandler();
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

// Helper de socket Baileys em memória
function createMockSocket() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (jid, content) => {
      sentMessages.push({
        jid,
        content,
        timestamp: Date.now(),
      });
      return {
        key: {
          id: `sim_msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        },
      };
    },
  };
}

// Helper para construir mensagens do Baileys
function buildIncomingMessage(text, { phone = '5511999990001', msgId = null, pushName = 'Cliente Demo' } = {}) {
  return {
    key: {
      remoteJid: `${phone}@s.whatsapp.net`,
      fromMe: false,
      id: msgId || `baileys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    },
    pushName,
    message: {
      conversation: text,
    },
  };
}

// Horário comercial completo
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
    VALUES 
      (20, 3, 'Juliana', 'Cabelo', 1),
      (21, 3, 'Camila', 'Cabelo', 1)
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_services (id, user_id, name, duration_min, price, category, active)
    VALUES 
      (10, 3, 'Corte Feminino', 45, 90.00, 'Cabelo', 1),
      (11, 3, 'Manicure', 30, 40.00, 'Unhas', 1)
  `).run();

  db.prepare(`
    INSERT OR REPLACE INTO client_service_staff (id, user_id, service_id, staff_id, confirmed)
    VALUES 
      (1, 3, 10, 20, 1),
      (2, 3, 10, 21, 1),
      (3, 3, 11, 20, 1)
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
// SUÍTE DE TESTES: COMANDO 064.1.1
// =============================================================================

test.describe('COMANDO 064.1.1 — Blindagem de Telefone e Teste Integrado WhatsApp → Google Calendar', () => {

  test.beforeEach(() => {
    salonIncomingDispatcher._resetForTesting();
    googleCalendarService.resetMockHandler();
    seedTestTenant();
  });

  const secondaryCalId = 'agenda-homolog-sec@group.calendar.google.com';
  const accountEmail = 'jessica.homolog@raiaagentes.com.br';
  const authorizedClientPhone = '5511999990001';

  // ---------------------------------------------------------------------------
  // CENÁRIO 1: Jornada Conversacional Completa de Ponta a Ponta (10 Passos)
  // ---------------------------------------------------------------------------
  test('1. Jornada Completa: WhatsApp (4 turnos) -> SQLite -> Dynamic Late-Binding -> Outbox SENT -> WhatsApp Confirmação', async () => {
    const mockSock = createMockSocket();

    // Passo 1: Administrador abre sessão temporária para o próximo agendamento do WhatsApp com o telefone pinned
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 20,
      authorizedClientPhone,
      createdBy: 1,
      reason: 'Demonstração Comercial WhatsApp Real',
    });

    assert.ok(session);
    assert.equal(session.status, 'ACTIVE');
    assert.equal(session.appointment_id, 0);
    assert.equal(session.authorized_client_phone, authorizedClientPhone);

    // Passo 2: Cliente inicia conversa solicitando corte feminino
    const msg1 = buildIncomingMessage('Olá, gostaria de agendar corte feminino', { phone: authorizedClientPhone });
    await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg1);
    assert.equal(mockSock.sentMessages.length, 1);
    assert.match(mockSock.sentMessages[0].content.text, /Juliana/i);

    // Passo 3: Cliente escolhe profissional Camila
    const msg2 = buildIncomingMessage('Com a Camila', { phone: authorizedClientPhone });
    await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg2);
    assert.equal(mockSock.sentMessages.length, 2);
    assert.match(mockSock.sentMessages[1].content.text, /horário/i);

    // Passo 4: Cliente seleciona o slot 1
    const msg3 = buildIncomingMessage('1', { phone: authorizedClientPhone });
    await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg3);
    assert.equal(mockSock.sentMessages.length, 3);
    assert.match(mockSock.sentMessages[2].content.text, /Posso confirmar/i);

    // Prepara mock seguro do Google Calendar antes do passo de confirmação
    let mockCreatedCalendarId = null;
    googleCalendarService.setMockHandler({
      createCalendarEvent: async (userId, apt, calId) => {
        mockCreatedCalendarId = calId;
        return {
          id: `gevent_demo_real_${Date.now()}`,
          htmlLink: 'https://calendar.google.com/event?eid=mock_demo_real',
          isSimulated: false,
        };
      },
    });

    // Passo 5: Cliente confirma o agendamento ("Sim") com GOOGLE_SYNC_LIVE_ENABLED ativo
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    try {
      const msg4 = buildIncomingMessage('Sim, pode confirmar por favor!', { phone: authorizedClientPhone });
      await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg4);
      assert.equal(mockSock.sentMessages.length, 4);

      // Passo 6: Verifica agendamento criado no SQLite
      const appointment = db.prepare(`
        SELECT * FROM appointments 
        WHERE user_id = 3 AND client_phone = ? AND status = 'AGENDADO'
        ORDER BY id DESC LIMIT 1
      `).get(authorizedClientPhone);

      assert.ok(appointment, 'Agendamento deve ser criado no banco');
      assert.ok(appointment.id > 0);

      // Passo 7: Verifica que o ID foi vinculado AUTOMATICAMENTE à sessão efêmera
      const boundSession = db.prepare(`SELECT * FROM google_sync_test_sessions WHERE id = ?`).get(session.id);
      assert.equal(
        boundSession.appointment_id,
        appointment.id,
        'A sessão efêmera deve estar vinculada ao novo agendamento'
      );
      assert.equal(boundSession.allow_new_appointments, 0, 'Novas vinculações devem estar travadas');

      // Passo 8: Outbox processa CREATE com Google Calendar mockado (se ainda houver tarefa pendente)
      await outboxWorker.processGoogleSyncOutbox();
      assert.equal(mockCreatedCalendarId, secondaryCalId, 'Deve usar exclusivamente calendário secundário');

      // Passo 9: Outbox atualizado para SENT e Sessão termina como COMPLETED (1/1)
      const outboxItem = db.prepare(`
        SELECT * FROM google_sync_outbox WHERE appointment_id = ? AND action = 'CREATE'
      `).get(appointment.id);
      assert.equal(outboxItem.status, 'SENT', 'Outbox deve transicionar para SENT');

      const completedSession = db.prepare(`SELECT * FROM google_sync_test_sessions WHERE id = ?`).get(session.id);
      assert.equal(completedSession.status, 'COMPLETED', 'Sessão 1/1 deve finalizar como COMPLETED');
      assert.equal(completedSession.executions_count, 1);
    } finally {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
      googleCalendarService.resetMockHandler();
    }

    // Passo 10: Cliente recebeu confirmação correta no WhatsApp simulado
    const finalBotReply = mockSock.sentMessages[3].content.text;
    assert.match(finalBotReply, /Agendamento confirmado com sucesso/i);
    assert.match(finalBotReply, /Camila/i);
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 2: Validação Estrita de Telefone Ausente, Nulo ou Vazio (Phone Shield)
  // ---------------------------------------------------------------------------
  test('2. Phone Shield: Rejeição incondicional de telefone nulo, vazio ou inválido', () => {
    // 2.1 Rejeição na abertura de sessão WHATSAPP_NEW sem telefone autorizado
    assert.throws(
      () => {
        googleCalendarSessionService.createTestSession({
          userId: 3,
          sessionType: 'WHATSAPP_NEW',
          appointmentId: 0,
          calendarId: secondaryCalId,
          accountEmail,
          allowedAction: 'CREATE',
          maxExecutions: 1,
          durationMinutes: 15,
          authorizedClientPhone: null, // TELEFONE AUSENTE
          createdBy: 1,
        });
      },
      (err) => {
        assert.equal(err.code, 'PHONE_REQUIRED_FOR_WHATSAPP_DEMO');
        return true;
      },
      'Deve barrar abertura de sessão sem telefone'
    );

    // 2.2 Rejeição de vinculação se o agendamento possuir telefone vazio
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      authorizedClientPhone: '5511999990001',
      createdBy: 1,
    });

    const bindResult = googleCalendarSessionService.bindAppointmentToActiveSession(3, 999, {
      origin: 'WHATSAPP_BOT',
      clientPhone: '', // VAZIO
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001'),
    });

    assert.equal(bindResult, null, 'Vinculação com telefone vazio deve falhar');
    const err = googleCalendarSessionService.getLastBindingError();
    assert.equal(err.code, 'INVALID_CLIENT_PHONE');
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 3: Validação de Telefone Não Autorizado na Whitelist (Fail-Closed)
  // ---------------------------------------------------------------------------
  test('3. Phone Shield: Rejeição de telefone fora de SALON_TEST_ALLOWED_PHONES e whitelist não configurada', () => {
    // 3.1 Tentativa de abrir sessão com telefone fora da whitelist
    assert.throws(
      () => {
        googleCalendarSessionService.createTestSession({
          userId: 3,
          sessionType: 'WHATSAPP_NEW',
          appointmentId: 0,
          calendarId: secondaryCalId,
          accountEmail,
          allowedAction: 'CREATE',
          maxExecutions: 1,
          durationMinutes: 15,
          authorizedClientPhone: '5511988887777', // FORA DA WHITELIST (5511999990001, 5511999990002)
          createdBy: 1,
        });
      },
      (err) => {
        assert.equal(err.code, 'PHONE_NOT_IN_TEST_ALLOWLIST');
        return true;
      },
      'Deve barrar telefone fora da whitelist de homologação'
    );

    // 3.2 Whitelist ausente ou vazia no ambiente: Fail-Closed
    const origWhitelist = process.env.SALON_TEST_ALLOWED_PHONES;
    try {
      process.env.SALON_TEST_ALLOWED_PHONES = '';
      assert.throws(
        () => {
          googleCalendarSessionService.createTestSession({
            userId: 3,
            sessionType: 'WHATSAPP_NEW',
            appointmentId: 0,
            calendarId: secondaryCalId,
            accountEmail,
            allowedAction: 'CREATE',
            maxExecutions: 1,
            durationMinutes: 15,
            authorizedClientPhone: '5511999990001',
            createdBy: 1,
          });
        },
        (err) => {
          assert.equal(err.code, 'WHITELIST_NOT_CONFIGURED');
          return true;
        },
        'Deve falhar se SALON_TEST_ALLOWED_PHONES estiver vazia'
      );
    } finally {
      process.env.SALON_TEST_ALLOWED_PHONES = origWhitelist;
    }

    // 3.3 Mismatch: Sessão autoriza 5511999990001, mas agendamento chega de 5511999990002
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      authorizedClientPhone: '5511999990001',
      createdBy: 1,
    });

    const bindMismatch = googleCalendarSessionService.bindAppointmentToActiveSession(3, 888, {
      origin: 'WHATSAPP_BOT',
      clientPhone: '5511999990002', // DIVERGENTE DA SESSÃO
      dispatcherProof: salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990002'),
    });

    assert.equal(bindMismatch, null);
    const mismatchErr = googleCalendarSessionService.getLastBindingError();
    assert.equal(mismatchErr.code, 'PHONE_MISMATCH_WITH_SESSION');
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 4: Garantia de Origem Confiável (Anti-Spoofing de Despachante)
  // ---------------------------------------------------------------------------
  test('4. Anti-Spoofing: Rejeição de agendamento sem prova autêntica do despachante WhatsApp', () => {
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      authorizedClientPhone: '5511999990001',
      createdBy: 1,
    });

    // 4.1 Tentativa de vincular declarando origin 'WHATSAPP_BOT' mas SEM dispatcherProof
    const noProofResult = googleCalendarSessionService.bindAppointmentToActiveSession(3, 101, {
      origin: 'WHATSAPP_BOT',
      clientPhone: '5511999990001',
      dispatcherProof: null, // SEM PROVA
    });
    assert.equal(noProofResult, null);
    assert.equal(googleCalendarSessionService.getLastBindingError().code, 'UNTRUSTED_DISPATCHER_ORIGIN');

    // 4.2 Tentativa de vincular com dispatcherProof forjado / inválido
    const fakeProofResult = googleCalendarSessionService.bindAppointmentToActiveSession(3, 102, {
      origin: 'WHATSAPP_BOT',
      clientPhone: '5511999990001',
      dispatcherProof: 'token_falso_injetado_via_http_1234567890',
    });
    assert.equal(fakeProofResult, null);
    assert.equal(googleCalendarSessionService.getLastBindingError().code, 'UNTRUSTED_DISPATCHER_ORIGIN');

    // 4.3 Reuso de prova (Single-Use Nonce / Replay-Attack Prevention)
    const validProof = salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001');
    const firstConsume = googleCalendarSessionService.bindAppointmentToActiveSession(3, 103, {
      origin: 'WHATSAPP_BOT',
      clientPhone: '5511999990001',
      dispatcherProof: validProof,
    });
    assert.ok(firstConsume, 'Primeiro consumo da prova deve ser aceito');

    // Tentativa de reusar a mesma prova em novo agendamento
    const replayConsume = googleCalendarSessionService.bindAppointmentToActiveSession(3, 104, {
      origin: 'WHATSAPP_BOT',
      clientPhone: '5511999990001',
      dispatcherProof: validProof, // MESMA PROVA JÁ CONSUMIDA
    });
    assert.equal(replayConsume, null, 'Reuso de prova deve ser sumariamente bloqueado');
    assert.equal(googleCalendarSessionService.getLastBindingError().code, 'UNTRUSTED_DISPATCHER_ORIGIN');

    // 4.4 Origem diferente de WHATSAPP_BOT (ex: PAINEL_CLIENTE)
    const panelResult = googleCalendarSessionService.bindAppointmentToActiveSession(3, 105, {
      origin: 'PAINEL_CLIENTE',
      clientPhone: '5511999990001',
    });
    assert.equal(panelResult, null);
    assert.equal(googleCalendarSessionService.getLastBindingError().code, 'INVALID_ORIGIN');
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 5: Proteção Multi-Tenant (Tenant Shield)
  // ---------------------------------------------------------------------------
  test('5. Tenant Shield: Interação e agendamentos de outro tenant não afetam o tenant homologado', async () => {
    // Seed do Tenant 4
    db.prepare(`
      INSERT OR REPLACE INTO users (id, phone_number, name, role, plan_tier, subscription_status)
      VALUES (4, '5511999990004', 'Salão Tenant 4', 'CLIENT', 'JESSICA_PRO', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO client_salons (id, user_id, salon_name, phone, opening_hours)
      VALUES (2, 4, 'Salão Tenant 4', '5511999990004', ?)
    `).run(openingHours);

    db.prepare(`
      INSERT OR REPLACE INTO client_staff (id, user_id, name, specialty, active)
      VALUES (22, 4, 'Profissional T4', 'Geral', 1)
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO client_services (id, user_id, name, duration_min, price, category, active)
      VALUES (12, 4, 'Serviço T4', 30, 50.00, 'Geral', 1)
    `).run();

    db.prepare(`
      INSERT OR REPLACE INTO client_service_staff (user_id, service_id, staff_id, confirmed)
      VALUES (4, 12, 22, 1)
    `).run();

    // Cria sessão efêmera para o Tenant 3
    const sessionT3 = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      authorizedClientPhone: '5511999990001',
      createdBy: 1,
    });

    // Tenant 4 cria agendamento
    const proofT4 = salonIncomingDispatcher.generateDispatcherBookingProof(4, '5511999990001');
    const aptT4 = salonAppointmentService.bookAppointmentSync(4, {
      clientName: 'Cliente Tenant 4',
      clientPhone: '5511999990001',
      serviceId: 12,
      serviceName: 'Serviço T4',
      staffId: 22,
      date: '2026-11-29',
      time: '15:00',
      durationMin: 30,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: proofT4,
    });

    // Sessão do Tenant 3 permanece intacta e não vinculada
    const currentT3 = googleCalendarSessionService.getActiveSession(3);
    assert.equal(currentT3.appointment_id, 0, 'Sessão do Tenant 3 não pode ser consumida pelo Tenant 4');

    // Tentativa de abrir sessão WHATSAPP_NEW para o Tenant 4 é bloqueada
    assert.throws(
      () => {
        googleCalendarSessionService.createTestSession({
          userId: 4, // TENANT NÃO AUTORIZADO
          sessionType: 'WHATSAPP_NEW',
          appointmentId: 0,
          calendarId: secondaryCalId,
          accountEmail,
          allowedAction: 'CREATE',
          maxExecutions: 1,
          durationMinutes: 15,
          authorizedClientPhone: '5511999990001',
          createdBy: 1,
        });
      },
      (err) => {
        assert.equal(err.code, 'TENANT_RESTRICTED_TO_TEST_SALON');
        return true;
      }
    );
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 6: Proteção de Sessão Vencida (TTL Shield)
  // ---------------------------------------------------------------------------
  test('6. TTL Shield: Sessão vencida não vincula e é rejeitada pelo Gatekeeper', () => {
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 1,
      authorizedClientPhone: '5511999990001',
      createdBy: 1,
    });

    // Força data de expiração no passado via SQLite
    db.prepare(`UPDATE google_sync_test_sessions SET expires_at = datetime('now', '-5 minutes') WHERE id = ?`).run(session.id);

    const proof = salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001');
    const bindExpired = googleCalendarSessionService.bindAppointmentToActiveSession(3, 999, {
      origin: 'WHATSAPP_BOT',
      clientPhone: '5511999990001',
      dispatcherProof: proof,
    });

    assert.equal(bindExpired, null, 'Sessão expirada não deve vincular');
    assert.equal(googleCalendarSessionService.getLastBindingError().code, 'NO_ACTIVE_SESSION');

    // Gatekeeper fail-closed
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    try {
      const gate = googleCalendarGatekeeper.evaluateGatekeeper({
        userId: 3,
        calendarId: secondaryCalId,
        appointmentId: 999,
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

  // ---------------------------------------------------------------------------
  // CENÁRIO 7: Falha de Sincronização Google (Zero Perda de Dados)
  // ---------------------------------------------------------------------------
  test('7. Resiliência: Falha de sincronização do Google Calendar preserva o agendamento íntegro no SQLite', async () => {
    // 7.1 Cria sessão e agendamento
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      sessionType: 'WHATSAPP_NEW',
      appointmentId: 0,
      calendarId: secondaryCalId,
      accountEmail,
      allowedAction: 'CREATE',
      maxExecutions: 1,
      durationMinutes: 15,
      authorizedClientPhone: '5511999990001',
      createdBy: 1,
    });

    const proof = salonIncomingDispatcher.generateDispatcherBookingProof(3, '5511999990001');
    const apt = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Cliente Resiliência Google',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-29',
      time: '18:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      dispatcherProof: proof,
    });

    assert.ok(apt.id);

    // 7.2 Em ambiente seguro fail-closed (GOOGLE_SYNC_LIVE_ENABLED=false):
    const gateEval = googleCalendarGatekeeper.evaluateGatekeeper({
      userId: 3,
      calendarId: secondaryCalId,
      appointmentId: apt.id,
      accountEmail,
      action: 'CREATE',
      isDemo: false,
    });

    assert.equal(gateEval.allowed, false, 'Gatekeeper deve bloquear quando LIVE_SYNC_DISABLED');
    assert.equal(gateEval.reason, 'LIVE_SYNC_DISABLED');

    // 7.3 O agendamento no SQLite permanece íntegro com status AGENDADO (Zero perda de dados)
    const preservedApt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apt.id);
    assert.ok(preservedApt);
    assert.equal(preservedApt.status, 'AGENDADO');
    assert.equal(preservedApt.client_name, 'Cliente Resiliência Google');
  });

});
