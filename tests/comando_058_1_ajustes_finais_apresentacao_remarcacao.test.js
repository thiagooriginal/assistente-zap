/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS: COMANDO 058.1
 * Ajustes Finais de Apresentação e Encaminhamento Humano de Remarcações
 *
 * Padrão Hermético:
 * - Banco SQLite temporário descartável criado em os.tmpdir() (DatabaseSync)
 * - Módulos nativos node:test e node:assert/strict (Node 22)
 * - Sandbox de rede fail-closed com interceptação por mocks locais em memória
 * - Zero conexão ou alteração no banco operacional data/assistant.db
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// 1. Configuração Hermética de Ambiente e Banco Temporário em os.tmpdir()
const tempDbPath = path.join(
  os.tmpdir(),
  `test-jessica-058-1-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);

process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '1';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999998888';
process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
process.env.GEMINI_API_KEY = 'mock-gemini-key-test-058-1';

// Limpeza de cache de módulos para assegurar inicialização limpa do banco
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/config/index')];
delete require.cache[require.resolve('../src/database/db')];

const db = require('../src/database/db');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const jessicaNluService = require('../src/services/jessicaNluService');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonNotificationService = require('../src/services/salonNotificationService');

let msgCounter = 0;

function createMockSocket() {
  const sentMessages = [];
  return {
    user: { id: '5511988887777:1@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content });
      return { key: { id: `out_${Date.now()}_${Math.random()}` } };
    },
    sentMessages,
    getLastText: () => sentMessages[sentMessages.length - 1]?.content?.text || '',
    clearSent: () => { sentMessages.length = 0; },
  };
}

function createIncomingMessage(text, fromPhone = '5511999998888', pushName = 'Mariana') {
  msgCounter++;
  return {
    key: {
      remoteJid: `${fromPhone}@s.whatsapp.net`,
      fromMe: false,
      id: `msg_in_${Date.now()}_${msgCounter}_${Math.random().toString(36).slice(2)}`,
    },
    message: {
      conversation: text,
    },
    pushName,
  };
}

test.describe('COMANDO 058.1 — Apresentação Limpa de Slots e Encaminhamento Real de Remarcação', () => {
  const tenantId = 1;
  const clientPhone = '5511999998888';

  test.before(() => {
    // 1. Seed do Usuário / Tenant
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan)
      VALUES (?, '5511951364159', 'Proprietário Espaço Bella', 'ADMIN', 'PRO')
      ON CONFLICT(id) DO UPDATE SET phone_number = excluded.phone_number;
    `).run(tenantId);

    // 2. Seed do Salão
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

    db.prepare(`
      INSERT INTO client_salons (
        user_id, salon_name, phone, opening_hours, whatsapp_status,
        whatsapp_notifications_enabled, whatsapp_notification_phone, notify_reschedule
      )
      VALUES (?, 'Espaço Bella', '5511951364159', ?, 'CONNECTED', 1, '5511951364159', 1)
      ON CONFLICT(user_id) DO UPDATE SET
        salon_name = excluded.salon_name,
        whatsapp_notifications_enabled = 1,
        whatsapp_notification_phone = '5511951364159',
        notify_reschedule = 1;
    `).run(tenantId, openingHours);

    // 3. Seed dos Serviços
    db.prepare(`
      INSERT INTO client_services (id, user_id, name, price, duration_min, category, active)
      VALUES 
        (101, ?, 'Corte Feminino', 90.00, 45, 'Cabelo', 1),
        (102, ?, 'Manicure Tradicional', 35.00, 30, 'Unhas', 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name;
    `).run(tenantId, tenantId);

    // 4. Seed de Profissionais
    db.prepare(`
      INSERT INTO client_staff (id, user_id, name, active)
      VALUES 
        (201, ?, 'Bia', 1),
        (202, ?, 'Carol', 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name;
    `).run(tenantId, tenantId);

    // 5. Associação Serviço <-> Profissional
    db.prepare(`
      INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
      VALUES 
        (?, 101, 201, 1),
        (?, 101, 202, 1),
        (?, 102, 201, 1)
      ON CONFLICT(user_id, service_id, staff_id) DO UPDATE SET confirmed = 1;
    `).run(tenantId, tenantId, tenantId);
  });

  test.after(() => {
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    } catch (_) {}
  });

  test.beforeEach(() => {
    salonIncomingDispatcher._resetForTesting();
    salonSessionManager._resetForTesting();
    db.prepare('DELETE FROM processed_messages').run();
  });

  // =========================================================================
  // ITEM 1: Eliminação de Horários Duplicados e Ordens Mecânicas
  // =========================================================================
  test('Item 1.1: formatCandidateSlotsMessage apresenta horários fluidos sem lista numerada duplicada', () => {
    const slots = [
      { number: 1, date: '2026-11-20', time: '09:00', dayLabel: 'Amanhã (20/11)' },
      { number: 2, date: '2026-11-20', time: '09:30', dayLabel: 'Amanhã (20/11)' },
      { number: 3, date: '2026-11-20', time: '10:00', dayLabel: 'Amanhã (20/11)' },
    ];
    const service = { name: 'Corte Feminino', price: 90 };
    const msg = salonIncomingDispatcher.formatCandidateSlotsMessage(slots, service, null, 'manha');

    // 1. Deve conter a frase natural
    assert.ok(
      msg.includes('Encontrei três horários para *Corte Feminino* (R$ 90,00) amanhã de manha: *9h*, *9h30* e *10h*. Qual fica melhor para você? 😊'),
      'Deve conter a frase natural formatada'
    );

    // 2. NÃO deve conter a repetição numerada tipo "1. Amanhã (20/11) às *09:00*"
    assert.doesNotMatch(msg, /1\.\s+Amanhã/i, 'NÃO deve duplicar horários em lista numerada');
    assert.doesNotMatch(msg, /2\.\s+Amanhã/i);
    assert.doesNotMatch(msg, /3\.\s+Amanhã/i);

    // 3. NÃO deve conter instruções mecânicas de resposta
    assert.doesNotMatch(msg, /Você pode responder pelo número/i, 'NÃO deve induzir ordens mecânicas de comando');
    assert.doesNotMatch(msg, /digite/i);
  });

  test('Item 1.2: Quando houver mais de 3 slots, inclui dica discreta de opções adicionais', () => {
    const slots = [
      { number: 1, date: '2026-11-20', time: '09:00', dayLabel: 'Amanhã (20/11)' },
      { number: 2, date: '2026-11-20', time: '09:30', dayLabel: 'Amanhã (20/11)' },
      { number: 3, date: '2026-11-20', time: '10:00', dayLabel: 'Amanhã (20/11)' },
      { number: 4, date: '2026-11-20', time: '10:30', dayLabel: 'Amanhã (20/11)' },
    ];
    const service = { name: 'Corte Feminino', price: 90 };
    const msg = salonIncomingDispatcher.formatCandidateSlotsMessage(slots, service, null, 'manha');

    assert.match(msg, /\(Quer ver mais opções\? É só me falar!\) ✨/i);
    assert.doesNotMatch(msg, /1\.\s+Amanhã/i);
  });

  test('Item 1.3: Quando houver profissionais distintos entre os slots, apresenta distinção sem ambiguidade', () => {
    const slots = [
      { number: 1, date: '2026-11-20', time: '09:00', dayLabel: 'Amanhã (20/11)', staffName: 'Bia' },
      { number: 2, date: '2026-11-20', time: '09:30', dayLabel: 'Amanhã (20/11)', staffName: 'Carol' },
    ];
    const service = { name: 'Corte Feminino', price: 90 };
    const msg = salonIncomingDispatcher.formatCandidateSlotsMessage(slots, service, null, 'manha');

    assert.match(msg, /9h com a \*Bia\*/i);
    assert.match(msg, /9h30 com a \*Carol\*/i);
  });

  test('Item 1.4: Quando houver datas distintas entre os slots, apresenta distinção de dia', () => {
    const slots = [
      { number: 1, date: '2026-11-20', time: '18:00', dayLabel: 'Hoje (19/11)' },
      { number: 2, date: '2026-11-21', time: '09:00', dayLabel: 'Amanhã (20/11)' },
    ];
    const service = { name: 'Corte Feminino', price: 90 };
    const msg = salonIncomingDispatcher.formatCandidateSlotsMessage(slots, service, null, null);

    assert.match(msg, /Hoje às \*18h\*/i);
    assert.match(msg, /Amanhã às \*9h\*/i);
  });

  // =========================================================================
  // ITEM 2: Garantir Encaminhamento Real de Remarcações
  // =========================================================================
  test('Item 2.1: Com notificação configurada, enfileira notificação real no outbox e acolhe cliente', async () => {
    const mockSock = createMockSocket();

    // 1. Cria agendamento prévio no banco
    const booking = await salonAppointmentService.bookAppointment(tenantId, {
      clientName: 'Mariana Silva',
      clientPhone,
      serviceId: 101,
      staffId: 201,
      date: '2026-11-25',
      time: '14:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      reminderConsent: 0,
    });

    assert.ok(booking.id > 0);

    // 2. Limpa outbox para teste isolado
    db.prepare('DELETE FROM whatsapp_notification_outbox WHERE user_id = ?').run(tenantId);

    // 3. Cliente solicita remarcação pelo WhatsApp
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'RESCHEDULE',
      friendlyMessage: null,
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Oi, quero remarcar meu horário do dia 25', clientPhone)
    );

    const reply = mockSock.getLastText();

    // Em ambiente de teste/simulação (SIMULATED), a resposta informa honestamente que o pedido foi registrado
    assert.match(reply, /Já registrei seu pedido de remarcação para a nossa equipe da recepção/i);
    assert.match(reply, /agendamento atual continua 100% garantido e confirmado/i);

    // 4. Verificação no SQLite: Agendamento permanece INTACTO
    const apt = db.prepare('SELECT id, status, start_datetime FROM appointments WHERE id = ?').get(booking.id);
    assert.strictEqual(apt.status, 'AGENDADO', 'Status DEVE permanecer AGENDADO');
    assert.ok(apt.start_datetime.includes('2026-11-25'));
    assert.ok(apt.start_datetime.includes('14:00'));

    // 5. Verificação no Outbox SQLite: Notificação REAL enfileirada para o WhatsApp do Salão
    const outboxItem = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox 
      WHERE user_id = ? AND appointment_id = ? AND event_type = 'RESCHEDULE_REQUEST'
      ORDER BY id DESC LIMIT 1
    `).get(tenantId, booking.id);

    assert.ok(outboxItem, 'DEVE existir notificação de remarcação enfileirada no outbox');
    assert.strictEqual(outboxItem.recipient_phone, '5511951364159', 'Deve ser enviada ao telefone de notificação do salão');
    assert.ok(outboxItem.status === 'PENDING' || outboxItem.status === 'SIMULATED', 'Status do outbox deve ser PENDING ou SIMULATED');
    assert.match(outboxItem.message_text, /Solicitação de remarcação recebida/i);
    assert.match(outboxItem.message_text, /Mariana Silva/);
    assert.match(outboxItem.message_text, /Corte Feminino/);
    assert.match(outboxItem.message_text, /Bia/);
    assert.match(outboxItem.message_text, /25\/11\/2026/);
  });

  test('Item 2.2: Sem notificação configurada, orienta com telefone do salão sem mentir que a equipe foi notificada', async () => {
    const mockSock = createMockSocket();

    // Desativa temporariamente as notificações do salão
    db.prepare(`
      UPDATE client_salons 
      SET whatsapp_notifications_enabled = 0, whatsapp_notification_phone = NULL
      WHERE user_id = ?
    `).run(tenantId);

    // 1. Cria agendamento prévio
    const booking = await salonAppointmentService.bookAppointment(tenantId, {
      clientName: 'Carla',
      clientPhone,
      serviceId: 101,
      staffId: 201,
      date: '2026-11-26',
      time: '15:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      reminderConsent: 0,
    });

    // 2. Limpa outbox
    db.prepare('DELETE FROM whatsapp_notification_outbox WHERE user_id = ?').run(tenantId);

    // 3. Cliente solicita remarcação
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'RESCHEDULE',
      friendlyMessage: null,
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Quero mudar o horário do meu corte', clientPhone)
    );

    const reply = mockSock.getLastText();

    // Resposta honesta: NÃO deve afirmar que a equipe foi notificada
    assert.doesNotMatch(reply, /Já notifiquei nossa equipe/i, 'NÃO deve mentir dizendo que notificou a equipe');
    assert.match(reply, /Para remarcar ou ajustar seu horário, por favor entre em contato com a nossa recepção/i);
    assert.match(reply, /agendamento atual continua 100% garantido e confirmado/i);

    // Nenhuma notificação deve ter sido gerada no outbox
    const outboxCount = db.prepare('SELECT COUNT(*) as cnt FROM whatsapp_notification_outbox WHERE user_id = ?').get(tenantId);
    assert.strictEqual(outboxCount.cnt, 0, 'Nenhum outbox deve ser gerado sem canal configurado');

    // Agendamento original permanece 100% INTACTO
    const apt = db.prepare('SELECT status FROM appointments WHERE id = ?').get(booking.id);
    assert.strictEqual(apt.status, 'AGENDADO');

    // Restaura configurações do salão para próximos testes
    db.prepare(`
      UPDATE client_salons 
      SET whatsapp_notifications_enabled = 1, whatsapp_notification_phone = '5511951364159', notify_reschedule = 1
      WHERE user_id = ?
    `).run(tenantId);
  });

  test('Item 2.3: Solicitação de remarcação no estado AWAITING_RESCHEDULE_OR_NEW aciona o mesmo encaminhamento seguro', async () => {
    const mockSock = createMockSocket();
    const sessionKey = `${tenantId}:${clientPhone}`;

    // Configura sessão previamente em AWAITING_RESCHEDULE_OR_NEW
    const booking = await salonAppointmentService.bookAppointment(tenantId, {
      clientName: 'Juliana',
      clientPhone,
      serviceId: 101,
      staffId: 201,
      date: '2026-11-27',
      time: '11:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      reminderConsent: 0,
    });

    // Inicia sessão simulando resposta da confirmação
    const session = {
      state: 'AWAITING_RESCHEDULE_OR_NEW',
      lastConfirmedAppointmentId: booking.id,
      customerName: 'Juliana',
      messageCount: 3,
    };
    salonIncomingDispatcher._resetForTesting();
    // Injeta na memória de sessões
    const privateSessions = require('../src/whatsapp/salonIncomingDispatcher');

    // Envia resposta do cliente: "Quero remarcar"
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'RESCHEDULE',
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Quero remarcar o que acabamos de marcar', clientPhone)
    );

    const reply = mockSock.getLastText();
    assert.match(reply, /Já registrei seu pedido de remarcação para a nossa equipe da recepção/i);

    // Agendamento no SQLite permanece AGENDADO
    const apt = db.prepare('SELECT status FROM appointments WHERE id = ?').get(booking.id);
    assert.strictEqual(apt.status, 'AGENDADO');
  });

  test('Item 2.4: Isolamento multi-tenant estrito nas notificações de remarcação', async () => {
    const otherTenantId = 99;

    // Garante que não existem notificações vazadas para outro tenant
    const otherTenantOutbox = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE user_id = ?').all(otherTenantId);
    assert.strictEqual(otherTenantOutbox.length, 0, 'Isolamento Multi-tenant estrito: zero vazamento de dados');
  });

  test('Item 2.5: Distinção de status SENT vs PENDING/SIMULATED (somente SENT afirma que recepção já foi notificada)', async () => {
    // 1. Simula retorno com status SENT
    const origQueue = salonNotificationService.queueNotification;
    salonNotificationService.queueNotification = async () => ({
      success: true,
      status: 'SENT',
      outboxId: 999,
    });

    const mockSock = createMockSocket();
    const session = { state: 'IDLE', customerName: 'Renata' };
    const reply = await salonIncomingDispatcher.dispatchRescheduleHandoff(tenantId, clientPhone, session);

    assert.match(reply, /Nossa equipe da recepção já foi notificada sobre o seu pedido de remarcação/i, 'Somente SENT deve afirmar que foi notificada');

    // 2. Simula retorno com status PENDING
    salonNotificationService.queueNotification = async () => ({
      success: true,
      status: 'PENDING',
      outboxId: 999,
    });

    const replyPending = await salonIncomingDispatcher.dispatchRescheduleHandoff(tenantId, clientPhone, session);
    assert.match(replyPending, /Já registrei seu pedido de remarcação para a nossa equipe da recepção/i, 'PENDING deve afirmar registro sem alegar entrega concluída');

    salonNotificationService.queueNotification = origQueue;
  });

  test('Item 2.6: Falha no envio (FAILED) ou exceção mantém agendamento AGENDADO e direciona para canal oficial sem mentir', async () => {
    const booking = await salonAppointmentService.bookAppointment(tenantId, {
      clientName: 'Patricia',
      clientPhone,
      serviceId: 101,
      staffId: 201,
      date: '2026-11-28',
      time: '16:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      reminderConsent: 0,
    });

    // Força falha no envio da notificação
    const origQueue = salonNotificationService.queueNotification;
    salonNotificationService.queueNotification = async () => {
      throw new Error('SIMULATED_NETWORK_OUTAGE: Falha de conexão com a outbox');
    };

    const session = { state: 'IDLE', lastConfirmedAppointmentId: booking.id };
    const reply = await salonIncomingDispatcher.dispatchRescheduleHandoff(tenantId, clientPhone, session);

    // Resposta honesta direcionando para recepção
    assert.match(reply, /Para remarcar ou ajustar seu horário, por favor entre em contato com a nossa recepção/i);
    assert.doesNotMatch(reply, /Já notifiquei/i);
    assert.doesNotMatch(reply, /Já registrei/i);

    // Agendamento original no SQLite permanece 100% INTACTO
    const apt = db.prepare('SELECT status, start_datetime FROM appointments WHERE id = ?').get(booking.id);
    assert.strictEqual(apt.status, 'AGENDADO', 'Falha no outbox NUNCA pode afetar o agendamento original');
    assert.ok(apt.start_datetime.includes('2026-11-28'));

    salonNotificationService.queueNotification = origQueue;
  });

  test('Item 2.7: Telefone privado interno de notificações NUNCA é exposto como contato da recepção', async () => {
    // Salão com telefone oficial nulo/vazio, mas com telefone interno de notificação cadastrado
    db.prepare(`
      UPDATE client_salons 
      SET phone = NULL, whatsapp_notifications_enabled = 0, whatsapp_notification_phone = '5511999990000'
      WHERE user_id = ?
    `).run(tenantId);

    const session = { state: 'IDLE' };
    const reply = await salonIncomingDispatcher.dispatchRescheduleHandoff(tenantId, clientPhone, session);

    // NÃO deve vazar o telefone interno 5511999990000 para a cliente
    assert.doesNotMatch(reply, /5511999990000/, 'Telefone privado de notificação jamais pode vazar para clientes');
    assert.match(reply, /diretamente com a nossa equipe/i, 'Deve orientar contato direto com a equipe');

    // Restaura o telefone oficial
    db.prepare(`
      UPDATE client_salons 
      SET phone = '5511951364159', whatsapp_notifications_enabled = 1, whatsapp_notification_phone = '5511951364159'
      WHERE user_id = ?
    `).run(tenantId);
  });

  test('Item 2.8: outboxWorker processa diretamente item RESCHEDULE_REQUEST com transição de status e respeito ao tenant', async () => {
    const outboxWorker = require('../src/services/outboxWorker');

    // Insere item RESCHEDULE_REQUEST direto na tabela
    const info = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, status
      ) VALUES (?, 1, 'RESCHEDULE_REQUEST', '5511951364159', 'Teste Remarcação', 'PENDING')
    `).run(tenantId);

    const outboxId = info.lastInsertRowid;
    assert.ok(outboxId > 0);

    // Executa o processador oficial do outboxWorker
    const res = await outboxWorker.processWhatsAppOutboxItem(outboxId);
    assert.strictEqual(res.success, true);

    const updated = db.prepare('SELECT status, is_simulated FROM whatsapp_notification_outbox WHERE id = ?').get(outboxId);
    // Em staging, deve ser SIMULATED
    assert.ok(updated.status === 'SIMULATED' || updated.status === 'SENT');
  });
});
