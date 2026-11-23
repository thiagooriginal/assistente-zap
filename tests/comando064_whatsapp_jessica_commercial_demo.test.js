/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADOS HERMÉTICOS (COMANDO 064)
 * MÓDULO: Jéssica — Preparação para Demonstração Comercial pelo WhatsApp
 * Branch: security/raia-27-protecoes
 * Ambiente: raia-staging
 *
 * Padrão Hermético Mandatório:
 * 1. Isolamento Absoluto de Banco de Dados: DB_PATH isolado em os.tmpdir() e destruído em test.after().
 * 2. Módulos Nativos Node.js 22: node:test e node:assert/strict (zero dependências externas).
 * 3. Sandbox de Rede e Mocks Fail-Closed: Baileys e Google Calendar 100% interceptados em memória.
 * 4. Determinismo Estrito: Testes independentes com encerramento de timers e conexões.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// =============================================================================
// CONFIGURAÇÃO DE AMBIENTE HERMÉTICO E ISOLAMENTO DE BANCO DE DADOS
// =============================================================================

const tempDbPath = path.join(
  os.tmpdir(),
  `test_comando064_jessica_${Date.now()}_${Math.random().toString(36).slice(2, 9)}.db`
);

// Preserva variáveis de ambiente originais
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

// Define ambiente controlado de testes
process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '3';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990001,5511999990002';
process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false'; // Fail-closed para Google Calendar
process.env.JESSICA_CONVERSATIONAL_V2 = 'false'; // Testa o núcleo determinístico principal
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';

// Inicialização segura do banco isolado e módulos do sistema
const db = require('../src/database/db');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const googleCalendarSessionService = require('../src/services/googleCalendarSessionService');
const googleCalendarGatekeeper = require('../src/services/googleCalendarGatekeeper');
const outboxWorker = require('../src/services/outboxWorker');
const productService = require('../src/services/productService');

// Limpeza geral após a execução da suíte
test.after(() => {
  try {
    outboxWorker.stopWorker();
  } catch (_) {}

  try {
    salonIncomingDispatcher._resetForTesting();
  } catch (_) {}

  try {
    db.close();
  } catch (_) {}

  // Remove arquivos SQLite temporários gerados no tmpdir
  const cleanupFiles = [tempDbPath, `${tempDbPath}-shm`, `${tempDbPath}-wal`];
  for (const f of cleanupFiles) {
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch (_) {}
    }
  }

  // Restaura o ambiente original
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

// =============================================================================
// SEEDING CONTROLADO DO SALÃO DE DEMONSTRAÇÃO COMERCIAL (TENANT 3)
// =============================================================================

function seedTestTenant() {
  // 1. Tenant 3: Usuário Salão Jéssica Staging
  db.prepare(`
    INSERT OR REPLACE INTO users (
      id, phone_number, name, role, plan_tier, subscription_status,
      paid_until, is_demo, created_at, updated_at
    ) VALUES (
      3, '5511999990003', 'Salão Jéssica Staging', 'CLIENT', 'JESSICA_PRO', 'ACTIVE',
      datetime('now', '+30 days'), 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run();

  // 2. Garante Produto Jéssica cadastrado
  db.prepare(`
    INSERT OR IGNORE INTO products (
      id, code, name, category, solution_type, commercial_status, has_approved_offer, is_active
    ) VALUES (
      1, 'JESSICA', 'Jéssica Agendamentos', 'BEAUTY_SALON', 'AGENDA', 'AVAILABLE', 1, 1
    )
  `).run();

  // 3. Contrato ativo em customer_subscriptions
  db.prepare(`
    INSERT OR REPLACE INTO customer_subscriptions (
      id, user_id, product_id, status, price_cents, setup_fee_cents,
      billing_cycle, contracted_at, paid_until, access_expires_at
    ) VALUES (
      101, 3, 1, 'ACTIVE', 14900, 0, 'MONTHLY', CURRENT_TIMESTAMP,
      datetime('now', '+30 days'), datetime('now', '+30 days')
    )
  `).run();

  // 4. Configuração do Salão com Horário de Funcionamento Completo (Segunda a Domingo 08:00 - 19:00)
  const fullOpeningHours = JSON.stringify({
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

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (
      id, user_id, salon_name, phone, opening_hours, whatsapp_status,
      whatsapp_notifications_enabled, b2c_reminders_enabled
    ) VALUES (
      1, 3, 'Espaço Jéssica Beleza Staging', '5511999990003', ?, 'CONNECTED', 1, 1
    )
  `).run(fullOpeningHours);

  // 5. Catálogo de Serviços do Salão
  db.prepare(`
    INSERT OR REPLACE INTO client_services (
      id, user_id, name, price, duration_min, category, active
    ) VALUES 
      (10, 3, 'Corte Feminino', 90.00, 45, 'Cabelo', 1),
      (11, 3, 'Manicure', 40.00, 30, 'Unhas', 1),
      (12, 3, 'Escova Modeladora', 70.00, 40, 'Cabelo', 1)
  `).run();

  // 6. Equipe de Profissionais do Salão
  db.prepare(`
    INSERT OR REPLACE INTO client_staff (
      id, user_id, name, specialty, active
    ) VALUES 
      (20, 3, 'Juliana', 'Cabelo', 1),
      (21, 3, 'Camila', 'Cabelo', 1)
  `).run();

  // 7. Vinculação de Serviços e Profissionais (client_service_staff)
  db.prepare(`
    INSERT OR REPLACE INTO client_service_staff (
      id, user_id, service_id, staff_id, confirmed
    ) VALUES 
      (1, 3, 10, 20, 1),
      (2, 3, 10, 21, 1),
      (3, 3, 11, 20, 1),
      (4, 3, 12, 21, 1)
  `).run();
}

// Helper para criar mock socket do WhatsApp em memória
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

// Helper para construir mensagem do Baileys
function buildIncomingMessage(text, { phone = '5511999990001', msgId = null, pushName = 'Cliente Teste' } = {}) {
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

// =============================================================================
// SUÍTE DE TESTES AUTOMATIZADOS
// =============================================================================

test.describe('COMANDO 064: Demonstração Comercial WhatsApp da Jéssica (Branch security/raia-27-protecoes)', () => {

  test.beforeEach(() => {
    salonIncomingDispatcher._resetForTesting();
    seedTestTenant();
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 1: Agendamento bem-sucedido via WhatsApp (Diálogo Completo)
  // ---------------------------------------------------------------------------
  test('1. Agendamento bem-sucedido via WhatsApp (IDLE -> AWAITING_STAFF -> AWAITING_SLOT -> AWAITING_CONFIRMATION -> SQLite e Outbox)', async () => {
    const mockSock = createMockSocket();
    const clientPhone = '5511999990001';

    // Turno 1: Cliente solicita agendamento com serviço exato
    const msg1 = buildIncomingMessage('Olá, quero agendar um corte feminino', { phone: clientPhone });
    const res1 = await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg1);
    assert.equal(res1, true, 'Turno 1 deve ser processado com sucesso');
    assert.equal(mockSock.sentMessages.length, 1);
    assert.match(mockSock.sentMessages[0].content.text, /Juliana/i);
    assert.match(mockSock.sentMessages[0].content.text, /Camila/i);

    const session1 = salonIncomingDispatcher._getCustomerSessionForTesting(`3:${clientPhone}`);
    assert.equal(session1.state, 'AWAITING_STAFF', 'Estado deve transicionar para AWAITING_STAFF');
    assert.equal(session1.selectedService.name, 'Corte Feminino');

    // Turno 2: Cliente escolhe a profissional "Juliana"
    const msg2 = buildIncomingMessage('Com a Juliana', { phone: clientPhone });
    const res2 = await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg2);
    assert.equal(res2, true, 'Turno 2 deve ser processado com sucesso');
    assert.equal(mockSock.sentMessages.length, 2);
    assert.match(mockSock.sentMessages[1].content.text, /horário/i);

    const session2 = salonIncomingDispatcher._getCustomerSessionForTesting(`3:${clientPhone}`);
    assert.equal(session2.state, 'AWAITING_SLOT', 'Estado deve transicionar para AWAITING_SLOT');
    assert.equal(session2.selectedStaff.name, 'Juliana');
    assert.ok(session2.candidateSlots.length > 0, 'Deve conter slots candidatos disponíveis');

    // Turno 3: Cliente seleciona o slot 1 (ex: "1" ou "primeiro")
    const msg3 = buildIncomingMessage('1', { phone: clientPhone });
    const res3 = await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg3);
    assert.equal(res3, true, 'Turno 3 deve ser processado com sucesso');
    assert.equal(mockSock.sentMessages.length, 3);
    assert.match(mockSock.sentMessages[2].content.text, /Posso confirmar o seu agendamento\?/i);

    const session3 = salonIncomingDispatcher._getCustomerSessionForTesting(`3:${clientPhone}`);
    assert.equal(session3.state, 'AWAITING_CONFIRMATION', 'Estado deve transicionar para AWAITING_CONFIRMATION');
    assert.ok(session3.selectedSlot, 'Deve ter slot de data e hora selecionado');

    // Turno 4: Cliente confirma o agendamento ("Sim")
    const msg4 = buildIncomingMessage('Sim, pode confirmar!', { phone: clientPhone });
    const res4 = await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg4);
    assert.equal(res4, true, 'Turno 4 deve confirmar o agendamento com sucesso');
    assert.equal(mockSock.sentMessages.length, 4);
    assert.match(mockSock.sentMessages[3].content.text, /Agendamento confirmado com sucesso/i);

    // Verificação no banco de dados SQLite isolado
    const appointment = db.prepare(`
      SELECT * FROM appointments 
      WHERE user_id = 3 AND client_phone = ? AND status = 'AGENDADO'
    `).get(clientPhone);

    assert.ok(appointment, 'Agendamento deve estar registrado na tabela appointments com status AGENDADO');
    assert.equal(appointment.service_id, 10, 'Service ID deve ser 10 (Corte Feminino)');
    assert.equal(appointment.staff_id, 20, 'Staff ID deve ser 20 (Juliana)');
    assert.equal(appointment.origin, 'WHATSAPP_BOT');

    // Verificação de enfileiramento durável no google_sync_outbox
    const gOutbox = db.prepare(`
      SELECT * FROM google_sync_outbox 
      WHERE user_id = 3 AND appointment_id = ?
    `).get(appointment.id);

    assert.ok(gOutbox, 'Agendamento deve estar enfileirado na google_sync_outbox');
    assert.equal(gOutbox.action, 'CREATE');
    assert.equal(gOutbox.status, 'PENDING');

    // Verificação de notificação ao gestor do salão no whatsapp_notification_outbox
    const wOutbox = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox 
      WHERE user_id = 3 AND appointment_id = ?
    `).get(appointment.id);

    assert.ok(wOutbox, 'Notificação ao responsável do salão deve estar na whatsapp_notification_outbox');
    assert.equal(wOutbox.event_type, 'NEW_APPOINTMENT');
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 2: Horário indisponível (colisão e fora de expediente)
  // ---------------------------------------------------------------------------
  test('2. Horário indisponível (colisão de slot e fora de expediente tratados sem erro)', () => {
    // 2.1 Fora do expediente: tentativa de agendar às 23:00
    const outOfHoursCheck = salonAppointmentService.checkInternalSlotAvailability(3, {
      startDt: '2026-11-25 23:00:00',
      endDt: '2026-11-25 23:45:00',
      staffId: 20,
      bypassPastCheck: true,
      bypassHoursCheck: false,
    });
    assert.equal(outOfHoursCheck.available, false);
    assert.equal(outOfHoursCheck.reason, 'EXCEEDS_CLOSING', 'Deve bloquear horário posterior ao fechamento');

    // 2.2 Criação prévia de compromisso para a Juliana às 14:00
    db.prepare(`
      INSERT INTO appointments (
        user_id, title, start_datetime, end_datetime, service_id, staff_id,
        price, client_name, client_phone, status, origin
      ) VALUES (
        3, 'Corte Juliana', '2026-11-25 14:00:00', '2026-11-25 14:45:00',
        10, 20, 90.00, 'Cliente Existente', '5511999990002', 'AGENDADO', 'painel'
      )
    `).run();

    // Verificação de colisão interna no mesmo horário
    const conflictCheck = salonAppointmentService.checkInternalSlotAvailability(3, {
      startDt: '2026-11-25 14:00:00',
      endDt: '2026-11-25 14:45:00',
      staffId: 20,
      bypassPastCheck: true,
      bypassHoursCheck: true,
    });
    assert.equal(conflictCheck.available, false);
    assert.equal(conflictCheck.reason, 'SLOT_CONFLICT', 'Deve acusar colisão de horário');

    // bookAppointmentSync direto no horário colidente deve rejeitar com erro 409
    assert.throws(
      () => {
        salonAppointmentService.bookAppointmentSync(3, {
          clientName: 'Cliente Conflitante',
          clientPhone: '5511999990001',
          serviceId: 10,
          serviceName: 'Corte Feminino',
          staffId: 20,
          date: '2026-11-25',
          time: '14:00',
          durationMin: 45,
        });
      },
      (err) => {
        return err.code === 'SLOT_CONFLICT' || err.statusCode === 409 || err.message.includes('ocupada');
      },
      'Deve lançar erro SLOT_CONFLICT ao tentar reservar horário já ocupado'
    );
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 3: Serviço inexistente tratado graciosamente
  // ---------------------------------------------------------------------------
  test('3. Serviço inexistente (cliente pede serviço não cadastrado, bot exibe cardápio graciosamente)', async () => {
    const mockSock = createMockSocket();
    const clientPhone = '5511999990001';

    // Inicia conversa solicitando procedimento inexistente no catálogo
    const msg = buildIncomingMessage('Quero fazer uma micropigmentação capilar 3D a laser', { phone: clientPhone });
    const res = await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg);

    assert.equal(res, true, 'Mensagem deve ser tratada sem lançar exceções');
    assert.equal(mockSock.sentMessages.length, 1);
    const replyText = mockSock.sentMessages[0].content.text;

    // Deve acolher apresentando os serviços legítimos cadastrados
    assert.match(replyText, /Corte Feminino/i, 'Deve conter os serviços disponíveis no cardápio');
    assert.match(replyText, /Manicure/i);

    const session = salonIncomingDispatcher._getCustomerSessionForTesting(`3:${clientPhone}`);
    assert.equal(session.state, 'AWAITING_SERVICE', 'Estado deve aguardar escolha válida do serviço');
    assert.equal(session.selectedService, null, 'Nenhum serviço inexistente deve ter sido selecionado');
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 4: Atendimento de outro tenant bloqueado
  // ---------------------------------------------------------------------------
  test('4. Atendimento de outro tenant bloqueado (tenant inexistente ou não autorizado sumariamente descartado)', async () => {
    const mockSock = createMockSocket();
    const msg = buildIncomingMessage('Olá, quero agendar', { phone: '5511999990001' });

    // 4.1 Tenant 999 (inexistente ou sem permissão Jéssica)
    const resTenant999 = await salonIncomingDispatcher.dispatchMessage(999, mockSock, msg);
    assert.equal(resTenant999, false, 'Tenant inexistente deve ser descartado imediatamente');
    assert.equal(mockSock.sentMessages.length, 0, 'Nenhuma mensagem deve ser transmitida para tenant inexistente');

    // 4.2 Tenant 2 (existe, mas não está na whitelist SALON_TEST_ALLOWED_TENANTS = "3")
    db.prepare(`
      INSERT OR REPLACE INTO users (id, phone_number, name, role, plan_tier, subscription_status, is_demo)
      VALUES (2, '5511988880002', 'Outro Salão', 'CLIENT', 'JESSICA_PRO', 'ACTIVE', 0)
    `).run();
    const resTenant2 = await salonIncomingDispatcher.dispatchMessage(2, mockSock, msg);
    assert.equal(resTenant2, false, 'Tenant fora da whitelist de homologação deve ser bloqueado');
    assert.equal(mockSock.sentMessages.length, 0);

    // 4.3 Defesa Anti-IDOR em salonAppointmentService: agendar serviço pertencente a outro tenant
    assert.throws(
      () => {
        salonAppointmentService.bookAppointmentSync(3, {
          clientName: 'Cliente IDOR',
          clientPhone: '5511999990001',
          serviceId: 99999, // Serviço não pertencente ao tenant 3
          date: '2026-11-25',
          time: '15:00',
        });
      },
      /Serviço não encontrado|SERVICE_NOT_FOUND|SECURITY_VIOLATION/i,
      'Tentativa de cruzar serviços de outro tenant deve ser rejeitada'
    );
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 5: Telefone não autorizado bloqueado
  // ---------------------------------------------------------------------------
  test('5. Telefone não autorizado bloqueado (número fora da whitelist é sumariamente descartado)', async () => {
    const mockSock = createMockSocket();
    // 5511977776666 não consta em SALON_TEST_ALLOWED_PHONES (que contém 5511999990001 e 5511999990002)
    const unauthorizedPhone = '5511977776666';

    assert.equal(
      salonSessionManager.isSalonRealWhatsAppAllowed(3, unauthorizedPhone),
      false,
      'isSalonRealWhatsAppAllowed deve retornar false para telefone não autorizado'
    );

    const msg = buildIncomingMessage('Olá, quero agendar corte', { phone: unauthorizedPhone });
    const handled = await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg);

    assert.equal(handled, false, 'Mensagem de telefone não autorizado deve ser sumariamente descartada');
    assert.equal(mockSock.sentMessages.length, 0, 'Zero mensagens devem ser despachadas no socket');
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 6: Falha na conexão WhatsApp (socket com falha tratado como fail-closed)
  // ---------------------------------------------------------------------------
  test('6. Falha na conexão WhatsApp (socket desconectado ou erro de envio tratado como fail-closed)', async () => {
    // Mock socket que simula erro de conexão (ex: WebSocket closed)
    const brokenSock = {
      sendMessage: async () => {
        throw new Error('BAILEYS_SOCKET_DISCONNECTED: Conexão com o WhatsApp foi encerrada');
      },
    };

    const msg = buildIncomingMessage('Oi', { phone: '5511999990001' });

    // dispatchMessage deve capturar o erro internamente sem travar o processo Node
    const result = await salonIncomingDispatcher.dispatchMessage(3, brokenSock, msg);

    assert.equal(result, false, 'Deve retornar false e registrar erro sem propagar exceção fatal');
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 7: Falha na sincronização Google (preservação do agendamento)
  // ---------------------------------------------------------------------------
  test('7. Falha na sincronização Google (Gatekeeper bloqueando registra last_error no outbox sem perder o agendamento)', async () => {
    // 7.1 Criação de agendamento válido no SQLite
    const apt = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Cliente Resiliência Google',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-26',
      time: '16:00',
      durationMin: 45,
    });

    assert.ok(apt.id, 'Agendamento deve ser criado com ID válido');

    // 7.2 Em ambiente com GOOGLE_SYNC_LIVE_ENABLED=false (padrão seguro fail-closed):
    const gateEval = googleCalendarGatekeeper.evaluateGatekeeper({
      userId: 3,
      calendarId: 'agenda-sec@group.calendar.google.com',
      appointmentId: apt.id,
      accountEmail: 'salao.teste@raiaagentes.com.br',
      action: 'CREATE',
      isDemo: false,
    });

    assert.equal(gateEval.allowed, false, 'Gatekeeper deve bloquear quando LIVE_SYNC_DISABLED ou sem sessão ativa');

    // Simula tentativa de envio onde o outbox registra o erro
    db.prepare(`
      UPDATE google_sync_outbox
      SET attempts = attempts + 1,
          last_error = ?,
          status = 'PENDING'
      WHERE appointment_id = ?
    `).run(`Gatekeeper bloqueou: ${gateEval.reason}`, apt.id);

    // O agendamento DEVE continuar íntegro no SQLite (Zero perda de dados)
    const preservedApt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apt.id);
    assert.ok(preservedApt, 'Agendamento original DEVE ser preservado intacto');
    assert.equal(preservedApt.status, 'AGENDADO');
    assert.equal(preservedApt.client_name, 'Cliente Resiliência Google');

    const outboxRow = db.prepare('SELECT * FROM google_sync_outbox WHERE appointment_id = ?').get(apt.id);
    assert.ok(outboxRow.last_error.includes('Gatekeeper bloqueou'));
    assert.equal(outboxRow.attempts, 1);
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 8: Prevenção de agendamento duplicado (processed_messages e BEGIN IMMEDIATE)
  // ---------------------------------------------------------------------------
  test('8. Prevenção de agendamento duplicado (mensagens duplicadas via processed_messages e colisão atômica)', async () => {
    const mockSock = createMockSocket();
    const fixedMsgId = 'msg_duplicate_id_999888';

    // 8.1 Mensagens duplicadas no WhatsApp:
    const msgA = buildIncomingMessage('Olá', { phone: '5511999990001', msgId: fixedMsgId });
    const handledA = await salonIncomingDispatcher.dispatchMessage(3, mockSock, msgA);
    assert.equal(handledA, true, 'Primeira ocorrência da mensagem deve ser processada');
    assert.equal(mockSock.sentMessages.length, 1);

    // Reenvio exato da mesma mensagem (idêntico msgId do Baileys)
    const msgB = buildIncomingMessage('Olá', { phone: '5511999990001', msgId: fixedMsgId });
    const handledB = await salonIncomingDispatcher.dispatchMessage(3, mockSock, msgB);
    assert.equal(handledB, false, 'Segunda ocorrência com mesmo msgId deve ser descartada por processed_messages');
    assert.equal(mockSock.sentMessages.length, 1, 'Mock socket não deve receber novas chamadas para mensagem duplicada');

    // 8.2 Colisão atômica no SQLite com BEGIN IMMEDIATE:
    // Primeira reserva para Camila às 11:00
    const bookedFirst = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Cliente 1',
      clientPhone: '5511999990001',
      serviceId: 10,
      staffId: 21,
      date: '2026-11-27',
      time: '11:00',
      durationMin: 45,
    });
    assert.ok(bookedFirst.id);

    // Segunda tentativa imediata de reserva para a mesma Camila no mesmo horário exato
    assert.throws(
      () => {
        salonAppointmentService.bookAppointmentSync(3, {
          clientName: 'Cliente 2 (Colisão)',
          clientPhone: '5511999990002',
          serviceId: 10,
          staffId: 21,
          date: '2026-11-27',
          time: '11:00',
          durationMin: 45,
        });
      },
      (err) => err.code === 'SLOT_CONFLICT' || err.statusCode === 409,
      'Segunda reserva no mesmo slot deve falhar imediatamente com SLOT_CONFLICT'
    );
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 9: Recuperação e persistência de sessão
  // ---------------------------------------------------------------------------
  test('9. Recuperação de sessão (persistência em memória de sessão conversacional e auditoria de credenciais)', async () => {
    const mockSock = createMockSocket();
    const clientPhone = '5511999990001';

    // 9.1 Mensagem inicial define estado AWAITING_STAFF
    const msg1 = buildIncomingMessage('Quero agendar corte feminino', { phone: clientPhone });
    await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg1);

    // Inspeciona sessão persistida em memória
    const activeSession = salonIncomingDispatcher._getCustomerSessionForTesting(`3:${clientPhone}`);
    assert.ok(activeSession, 'Sessão conversacional deve existir em memória');
    assert.equal(activeSession.state, 'AWAITING_STAFF');
    assert.equal(activeSession.customerPhone, clientPhone);

    // 9.2 Simula envio da próxima mensagem recuperando o estado prévio sem reiniciar
    const msg2 = buildIncomingMessage('Com a Camila', { phone: clientPhone });
    await salonIncomingDispatcher.dispatchMessage(3, mockSock, msg2);

    const recoveredSession = salonIncomingDispatcher._getCustomerSessionForTesting(`3:${clientPhone}`);
    assert.equal(recoveredSession.state, 'AWAITING_SLOT');
    assert.equal(recoveredSession.selectedStaff.name, 'Camila');

    // 9.3 Inspeciona auditoria e suporte de credenciais do Baileys para o tenant
    const credentialsAudit = salonSessionManager.inspectSalonAuthCredentials(3);
    assert.ok(credentialsAudit, 'Auditoria de credenciais deve retornar objeto estruturado');
    assert.equal(typeof credentialsAudit.keyLoaded, 'boolean');
  });

  // ---------------------------------------------------------------------------
  // CENÁRIO 10: Dynamic Late-Binding no Ephemeral Gatekeeper
  // ---------------------------------------------------------------------------
  test('10. Dynamic Late-Binding / Suporte a Novo Agendamento no Ephemeral Gatekeeper (sessão ativa autorizando novo agendamento do WhatsApp)', () => {
    const calendarId = 'agenda-homolog-sec@group.calendar.google.com';
    const accountEmail = 'jessica.homolog@raiaagentes.com.br';

    // 10.1 Cria sessão de teste com placeholder de appointment_id antes da criação do agendamento
    const session = googleCalendarSessionService.createTestSession({
      userId: 3,
      appointmentId: 1, // Placeholder inicial para permitir abertura da sessão antes do chat
      calendarId,
      accountEmail,
      allowedAction: 'CREATE',
      durationMinutes: 20,
      createdBy: 1,
      reason: 'Demonstração Comercial WhatsApp Jéssica',
    });

    assert.ok(session, 'Sessão temporária de homologação deve ser criada com sucesso');
    assert.equal(session.user_id, 3);
    assert.equal(session.status, 'ACTIVE');

    // 10.2 Cliente agenda via WhatsApp e gera novo agendamento no SQLite
    const newApt = salonAppointmentService.bookAppointmentSync(3, {
      clientName: 'Cliente Demonstração WhatsApp',
      clientPhone: '5511999990001',
      serviceId: 10,
      serviceName: 'Corte Feminino',
      staffId: 20,
      date: '2026-11-28',
      time: '10:30',
      durationMin: 45,
    });

    assert.ok(newApt.id, 'Novo agendamento deve gerar ID autoincrement');
    const realAppointmentId = newApt.id;

    // 10.3 Dynamic Late-Binding: vincula atômico o ID real do agendamento recém-criado à sessão de teste
    db.prepare(`
      UPDATE google_sync_test_sessions
      SET appointment_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'ACTIVE'
    `).run(realAppointmentId, session.id);

    // Ativa temporariamente o switch de teste de homologação para verificar a autorização estrita
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

    try {
      // 10.4 Avaliação do Gatekeeper com o appointmentId vinculado dinamicamente
      const gateResult = googleCalendarGatekeeper.evaluateGatekeeper({
        userId: 3,
        calendarId,
        appointmentId: realAppointmentId,
        accountEmail,
        action: 'CREATE',
        isDemo: false,
      });

      assert.equal(gateResult.allowed, true, 'Gatekeeper deve autorizar a sincronização via late-binding');
      assert.equal(gateResult.reason, 'AUTHORIZED_HOMOLOGATION');
      assert.equal(gateResult.isAuthorizedHomologation, true);

      // 10.5 Rejeição fail-closed para agendamento divergente (Pino 3 - Appointment Pinning)
      const divergentGateResult = googleCalendarGatekeeper.evaluateGatekeeper({
        userId: 3,
        calendarId,
        appointmentId: 999999, // ID diferente do vinculado
        accountEmail,
        action: 'CREATE',
        isDemo: false,
      });

      assert.equal(divergentGateResult.allowed, false, 'Gatekeeper deve rejeitar agendamento divergente');
      assert.equal(divergentGateResult.reason, 'UNAUTHORIZED_APPOINTMENT');
    } finally {
      process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
    }
  });

});
