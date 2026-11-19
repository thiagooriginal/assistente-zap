/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS: COMANDO 058
 * Refinamento Final da Experiência Conversacional da Jéssica 2.1
 *
 * Padrão Hermético Obrigatório:
 * - Banco SQLite temporário e descartável em os.tmpdir() (DatabaseSync)
 * - Módulos nativos node:test e node:assert/strict (Node.js 22)
 * - Mocks fail-closed locais para IA e WhatsApp (sem chamadas externas de rede)
 * - Zero conexão ou interferência em data/assistant.db
 *
 * Casos de Teste Cobertos:
 * 1. Reconhecimento Imediato de Profissional Indiferente ("tanto faz", "qualquer uma", "quem estiver disponível")
 * 2. Preservação de Dia e Período através dos turnos ("amanhã de manhã")
 * 3. Apresentação Curta e Natural de Horários (fluida, sem cardápio numerado mecânico)
 * 4. Escolha Espontânea de Horário ("Pode ser 9h30", "O segundo", "Prefiro o mais cedo")
 * 5. Pré-Confirmação sem Reserva Antecipada (sem promessa de "já separei")
 * 6. Confirmação e Gravação Atômica no SQLite (geração de appointment e lastAppointmentId)
 * 7. Regra de Lembretes < 24h (não promete lembrete 24h antes para horários no mesmo dia/próximos) vs >= 24h
 * 8. Remarcação Segura e Handoff Humano (preservação do agendamento original intacto no SQLite)
 * 9. Resiliência do Fallback Determinístico (timeout / offline do Gemini mantendo regras de naturalidade)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// 1. Configuração Hermética de Ambiente e Banco Temporário em os.tmpdir()
const tempDbPath = path.join(
  os.tmpdir(),
  `test-jessica-cmd058-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);

process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '580';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990058';
process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
process.env.GEMINI_API_KEY = 'mock-gemini-key-test-cmd058';

// Limpeza de cache de módulos para assegurar conexão ao banco temporário isolado
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/config/index')];
delete require.cache[require.resolve('../src/database/db')];

const db = require('../src/database/db');
const jessicaNluService = require('../src/services/jessicaNluService');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const salonAppointmentService = require('../src/services/salonAppointmentService');

// Interceptador fail-closed de envio WhatsApp
salonSessionManager.isSalonRealWhatsAppAllowed = () => true;

// Helpers de Mocks
let msgCounter = 0;

function createMockSocket() {
  const sentMessages = [];
  return {
    user: { id: '5511988887777:1@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content, text: content?.text || '', timestamp: Date.now() });
      return { key: { id: `out_${Date.now()}_${Math.random()}` } };
    },
    sentMessages,
    getLastText: () => {
      if (sentMessages.length === 0) return '';
      return sentMessages[sentMessages.length - 1].text || '';
    },
    clearSent: () => {
      sentMessages.length = 0;
    },
  };
}

function createIncomingMessage(text, fromPhone = '5511999990058', pushName = 'Camila') {
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

test.describe('COMANDO 058 — Refinamento Final da Experiência Conversacional da Jéssica 2.1', () => {
  const tenantId = 580;
  const clientPhone = '5511999990058';

  test.before(() => {
    // 1. Seed do Usuário / Salão Tenant
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan)
      VALUES (?, '5511977770058', 'Salão Elegance Jéssica 2.1', 'ADMIN', 'PRO')
      ON CONFLICT(id) DO UPDATE SET phone_number = excluded.phone_number;
    `).run(tenantId);

    // 2. Horários de Funcionamento (Segunda a Domingo das 08h às 19h)
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
      INSERT INTO client_salons (user_id, salon_name, phone, opening_hours, whatsapp_status)
      VALUES (?, 'Studio Elegance', '5511977770058', ?, 'CONNECTED')
      ON CONFLICT(user_id) DO UPDATE SET salon_name = excluded.salon_name, opening_hours = excluded.opening_hours;
    `).run(tenantId, openingHours);

    // 3. Catálogo de Serviços
    db.prepare(`
      INSERT INTO client_services (id, user_id, name, price, duration_min, category, active)
      VALUES 
        (101, ?, 'Corte Feminino', 120.0, 45, 'Cabelo', 1),
        (102, ?, 'Corte Masculino', 60.0, 30, 'Cabelo', 1),
        (103, ?, 'Escova Modeladora', 80.0, 40, 'Cabelo', 1)
      ON CONFLICT(id) DO UPDATE SET price = excluded.price, active = 1;
    `).run(tenantId, tenantId, tenantId);

    // 4. Profissionais (Amanda e Letícia)
    db.prepare(`
      INSERT INTO client_staff (id, user_id, name, specialty, active)
      VALUES 
        (201, ?, 'Amanda', 'Master Stylist', 1),
        (202, ?, 'Letícia', 'Colorista e Corte', 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1;
    `).run(tenantId, tenantId);

    // 5. Associação Serviço x Profissionais
    db.prepare(`
      INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
      VALUES 
        (?, 101, 201, 1),
        (?, 101, 202, 1),
        (?, 102, 201, 1),
        (?, 103, 202, 1)
      ON CONFLICT(user_id, service_id, staff_id) DO UPDATE SET confirmed = 1;
    `).run(tenantId, tenantId, tenantId, tenantId);
  });

  test.after(() => {
    delete process.env.JESSICA_NLU_TIMEOUT_MS;
    jessicaNluService.resetMockNluHandler();
    salonIncomingDispatcher._resetForTesting();
    salonSessionManager._resetForTesting();

    try {
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }
    } catch (_) {}
  });

  test.beforeEach(() => {
    delete process.env.JESSICA_NLU_TIMEOUT_MS;
    salonIncomingDispatcher._resetForTesting();
    jessicaNluService.resetMockNluHandler();
    db.prepare('DELETE FROM appointments WHERE user_id = ?').run(tenantId);
    db.prepare('DELETE FROM processed_messages').run();
  });

  // =========================================================================
  // CASO 1: Reconhecimento Imediato de Profissional Indiferente
  // =========================================================================
  test('Caso 1: Reconhecimento Imediato de Profissional Indiferente (avança direto aos horários sem perguntar preferência)', async () => {
    const mockSock = createMockSocket();
    const sessionKey = `${tenantId}:${clientPhone}`;

    const clientMsg = 'Estou pensando em fazer um corte feminino, mas não tenho preferência por profissional. Pode ser quem estiver disponível.';

    jessicaNluService.setMockNluHandler(({ text }) => {
      assert.strictEqual(text, clientMsg);
      return {
        intent: 'SCHEDULE_INQUIRY',
        serviceName: 'Corte Feminino',
        staffName: 'ANY',
        datePreference: null,
        period: null,
        timeConstraint: null,
        friendlyMessage: null,
      };
    });

    const processed = await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage(clientMsg, clientPhone)
    );

    assert.strictEqual(processed, true, 'Mensagem deve ser processada');
    const reply = mockSock.getLastText();

    // Valida que NÃO perguntou qual profissional prefere
    assert.ok(
      !reply.includes('Com qual de nossas profissionais você gostaria') &&
      !reply.includes('Você tem preferência por alguém'),
      'NÃO deve perguntar qual profissional prefere quando a cliente é indiferente'
    );

    // Valida que avançou direto para oferta de horários
    const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
    assert.strictEqual(session.state, 'AWAITING_SLOT', 'Estado deve avançar diretamente para AWAITING_SLOT');
    assert.ok(session.candidateSlots.length > 0, 'Deve conter slots candidatos de profissionais disponíveis');
  });

  test('Caso 1.1: Variações de Indiferença ("tanto faz", "qualquer uma", "quem conseguir me atender mais cedo")', async () => {
    const variations = [
      'Quero corte feminino, tanto faz a profissional',
      'Corte feminino amanhã, pode ser qualquer uma da equipe',
      'Quero corte feminino com quem tiver vaga primeiro',
      'Corte feminino com quem conseguir me atender mais cedo',
    ];

    for (const msg of variations) {
      salonIncomingDispatcher._resetForTesting();
      db.prepare('DELETE FROM processed_messages').run();
      const mockSock = createMockSocket();
      const sessionKey = `${tenantId}:${clientPhone}`;

      jessicaNluService.setMockNluHandler(() => ({
        intent: 'SCHEDULE_INQUIRY',
        serviceName: 'Corte Feminino',
        staffName: 'ANY',
        datePreference: 'amanha',
        period: null,
        timeConstraint: null,
      }));

      await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(msg, clientPhone)
      );

      const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.strictEqual(session.state, 'AWAITING_SLOT', `Deve avançar direto para AWAITING_SLOT na frase: "${msg}"`);
      assert.ok(mockSock.getLastText().includes('horários') || mockSock.getLastText().includes('Encontrei'));
    }
  });

  // =========================================================================
  // CASO 2: Preservação de Dia e Período através dos Turnos
  // =========================================================================
  test('Caso 2: Preservação contínua de "amanhã de manhã" através dos turnos conversacionais', async () => {
    const mockSock = createMockSocket();
    const sessionKey = `${tenantId}:${clientPhone}`;

    // Turno 1: Cliente manifesta desejo sem serviço explícito
    const msgTurno1 = 'Oi! Vocês atendem amanhã de manhã?';
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'SCHEDULE_INQUIRY',
      serviceName: null,
      staffName: null,
      datePreference: 'amanha',
      period: 'manha',
      friendlyMessage: 'Oii! Claro, posso verificar para você amanhã de manhã! O que você está pensando em fazer?',
    }));

    await salonIncomingDispatcher.dispatchMessage(tenantId, mockSock, createIncomingMessage(msgTurno1, clientPhone));
    let session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
    assert.strictEqual(session.requestedDatePref, 'amanha');
    assert.strictEqual(session.requestedPeriod, 'manha');

    mockSock.clearSent();

    // Turno 2: Cliente informa serviço com indiferença de profissional
    const msgTurno2 = 'Corte feminino, pode ser quem estiver disponível';
    jessicaNluService.setMockNluHandler(({ session: currentSession }) => {
      // Confirma que o contexto herdou requestedDatePref e requestedPeriod
      assert.strictEqual(currentSession.requestedDatePref, 'amanha');
      assert.strictEqual(currentSession.requestedPeriod, 'manha');
      return {
        intent: 'SCHEDULE_INQUIRY',
        serviceName: 'Corte Feminino',
        staffName: 'ANY',
        datePreference: null, // NLU não precisa repetir, contexto preservado
        period: null,
      };
    });

    await salonIncomingDispatcher.dispatchMessage(tenantId, mockSock, createIncomingMessage(msgTurno2, clientPhone));
    session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);

    assert.strictEqual(session.state, 'AWAITING_SLOT');
    assert.ok(session.candidateSlots.length > 0);

    // Todos os slots devem respeitar rigorosamente o período matutino (< 12h)
    for (const slot of session.candidateSlots) {
      const hour = parseInt(slot.time.split(':')[0], 10);
      assert.ok(hour < 12, `Horário ${slot.time} deve ser no período matutino (< 12h)`);
    }
  });

  // =========================================================================
  // CASO 3: Apresentação Curta e Natural de Horários (Sem Cardápios Mecânicos)
  // =========================================================================
  test('Caso 3: Apresentação Curta e Natural de Horários (fluida, sem cardápios numerados extensos)', async () => {
    const mockSock = createMockSocket();

    jessicaNluService.setMockNluHandler(() => ({
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Corte Feminino',
      staffName: 'ANY',
      datePreference: 'amanha',
      period: 'manha',
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Quero corte feminino amanhã de manhã com qualquer uma', clientPhone)
    );

    const reply = mockSock.getLastText();

    // Assertivas de tom natural e ausência de ordens mecânicas
    assert.ok(!reply.includes('1. Corte Feminino'), 'NÃO deve repetir lista mecânica de serviços');
    assert.ok(!/digite\s+o\s+n[úu]mero/i.test(reply), 'NÃO deve usar ordens robóticas "digite o número"');
    assert.ok(/qual\s+(desses\s+)?hor[aá]rios|qual\s+fica\s+melhor/i.test(reply), 'Deve convidar a cliente a escolher de forma leve');
  });

  // =========================================================================
  // CASO 4: Escolha Espontânea de Horário
  // =========================================================================
  test('Caso 4: Escolha Espontânea de Horário ("Pode ser 9h30", "O segundo", "Prefiro o mais cedo")', async () => {
    const testCases = [
      { replyMsg: 'Pode ser 09:00', expectedTime: '09:00' },
      { replyMsg: 'Prefiro o mais cedo', expectedTime: '08:00' },
      { replyMsg: '2', expectedIndex: 1 },
    ];

    for (const tc of testCases) {
      salonIncomingDispatcher._resetForTesting();
      db.prepare('DELETE FROM processed_messages').run();
      const mockSock = createMockSocket();
      const sessionKey = `${tenantId}:${clientPhone}`;

      // Configura sessão prévia aguardando slot
      jessicaNluService.setMockNluHandler(() => ({
        intent: 'SCHEDULE_INQUIRY',
        serviceName: 'Corte Feminino',
        staffName: 'ANY',
        datePreference: 'amanha',
        period: 'manha',
      }));

      await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage('Quero agendar corte feminino amanhã de manhã', clientPhone)
      );

      mockSock.clearSent();

      // Cliente escolhe espontaneamente
      await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(tc.replyMsg, clientPhone)
      );

      const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.strictEqual(session.state, 'AWAITING_CONFIRMATION', `Deve transicionar para confirmação após: ${tc.replyMsg}`);
      assert.ok(session.selectedSlot, 'Deve possuir slot selecionado');
      if (tc.expectedTime) {
        assert.strictEqual(session.selectedSlot.time, tc.expectedTime);
      }
    }
  });

  // =========================================================================
  // CASO 5: Pré-Confirmação sem Reserva Antecipada
  // =========================================================================
  test('Caso 5: Pré-Confirmação sem Reserva Antecipada (sem prometer "Já separei esse horário")', async () => {
    const mockSock = createMockSocket();
    const sessionKey = `${tenantId}:${clientPhone}`;

    // Passo 1: Inicializa slots
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Corte Feminino',
      staffName: 'ANY',
      datePreference: 'amanha',
      period: 'manha',
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Corte feminino amanhã de manhã com quem estiver disponível', clientPhone)
    );

    mockSock.clearSent();

    // Passo 2: Cliente escolhe um horário
    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Pode ser 08:30', clientPhone)
    );

    const reply = mockSock.getLastText();

    // Validação estrita do COMANDO 058: Não deve prometer falsa retenção prévia
    assert.ok(
      !reply.includes('Já separei esse horário para você') &&
      !reply.includes('ja separei esse horario'),
      'NÃO deve prometer "Já separei esse horário" antes da confirmação'
    );
    assert.ok(
      reply.includes('Encontrei') || reply.includes('confira os dados') || reply.includes('Perfeito'),
      'Deve apresentar os detalhes e perguntar cordialmente se pode confirmar'
    );
    assert.ok(reply.includes('Corte Feminino'));
    assert.ok(reply.includes('08:30'));
  });

  // =========================================================================
  // CASO 6: Confirmação e Gravação Atômica no SQLite
  // =========================================================================
  test('Caso 6: Confirmação "Sim, pode confirmar" grava no SQLite e gera lastAppointmentId', async () => {
    const mockSock = createMockSocket();
    const sessionKey = `${tenantId}:${clientPhone}`;

    // Estado pré-configurado aguardando confirmação (data com > 24h para validar fluxo com opt-in)
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Corte Feminino',
      staffName: 'ANY',
      datePreference: 'sabado',
      period: 'manha',
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Corte feminino no sábado de manhã', clientPhone)
    );

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Pode ser 09:00', clientPhone)
    );

    mockSock.clearSent();

    // Confirmação final
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'CONFIRM_BOOKING',
      friendlyMessage: 'Confirmado com sucesso!',
    }));

    const processedConfirm = await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Sim, pode confirmar!', clientPhone)
    );

    assert.strictEqual(processedConfirm, true);
    const reply = mockSock.getLastText();
    assert.ok(reply.includes('confirmado com sucesso') || reply.includes('Prontinho'));

    // Verifica persistência no SQLite
    const savedApt = db.prepare(`
      SELECT id, user_id, client_phone, service_id, staff_id, start_datetime, status
      FROM appointments
      WHERE user_id = ? AND client_phone = ?
    `).get(tenantId, clientPhone);

    assert.ok(savedApt, 'Agendamento deve ser persistido no SQLite');
    assert.strictEqual(savedApt.status, 'AGENDADO', 'Status deve ser AGENDADO');
    assert.strictEqual(savedApt.service_id, 101, 'Serviço deve ser Corte Feminino (101)');
    assert.ok(savedApt.staff_id === 201 || savedApt.staff_id === 202, 'Profissional deve ser resolvido');
    assert.ok(savedApt.start_datetime.includes('09:00'), 'Horário deve ser 09:00');

    const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
    assert.strictEqual(session.lastAppointmentId, savedApt.id, 'lastAppointmentId deve ser preenchido');
    assert.strictEqual(session.state, 'AWAITING_REMINDER_OPTIN', 'Deve transicionar para AWAITING_REMINDER_OPTIN');
  });

  // =========================================================================
  // CASO 7: Regra de Lembretes < 24h vs >= 24h
  // =========================================================================
  test('Caso 7.1: Agendamento marcado com < 24h NÃO promete envio de lembrete "24 horas antes"', async () => {
    const mockSock = createMockSocket();
    const sessionKey = `${tenantId}:${clientPhone}`;

    // Agendamento para AMANHÃ DE MANHÃ (menos de 24h a partir do final da tarde)
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Corte Feminino',
      staffName: 'ANY',
      datePreference: 'amanha',
      period: 'manha',
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Quero corte feminino amanhã de manhã', clientPhone)
    );

    const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
    assert.ok(session.candidateSlots.length > 0);

    // Seleciona horário de amanhã
    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage(session.candidateSlots[0].time, clientPhone)
    );

    mockSock.clearSent();

    // Confirma agendamento
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'CONFIRM_BOOKING',
      friendlyMessage: 'Confirmado!',
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Sim, pode confirmar!', clientPhone)
    );

    const reply = mockSock.getLastText();
    assert.ok(reply.includes('confirmado com sucesso') || reply.includes('Prontinho'));

    // Validação estrita: Como o atendimento é nas próximas horas (< 24h), a Jéssica NÃO deve prometer lembrete "24 horas antes"
    assert.ok(
      !reply.includes('24 horas antes') && !reply.includes('24h antes'),
      'NÃO deve prometer lembrete "24 horas antes" para compromissos marcados com menos de 24h'
    );
  });

  test('Caso 7.2: Agendamento marcado com >= 24h oferta normalmente o opt-in de 24 horas antes', async () => {
    const mockSock = createMockSocket();
    const sessionKey = `${tenantId}:${clientPhone}`;

    // Agendamento para data futura (> 24h)
    jessicaNluService.setMockNluHandler(() => ({
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Corte Feminino',
      staffName: 'ANY',
      datePreference: 'sabado',
      period: 'tarde',
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Quero corte feminino no sábado à tarde', clientPhone)
    );

    const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
    assert.ok(session.candidateSlots.length > 0);

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage(session.candidateSlots[0].time, clientPhone)
    );

    mockSock.clearSent();

    jessicaNluService.setMockNluHandler(() => ({
      intent: 'CONFIRM_BOOKING',
      friendlyMessage: 'Confirmado!',
    }));

    await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage('Sim, pode confirmar!', clientPhone)
    );

    const reply = mockSock.getLastText();
    // Para agendamentos futuros (> 24h), deve ofertar normalmente o lembrete de 24h
    assert.ok(
      reply.includes('24 horas antes') || reply.includes('24h'),
      'Deve ofertar lembrete de 24 horas antes para compromissos com mais de 24h de antecedência'
    );
  });

  // =========================================================================
  // CASO 8: Remarcação Segura e Handoff Humano
  // =========================================================================
  test('Caso 8: Solicitação de remarcação preserva agendamento intacto no SQLite e aciona handoff humano', async () => {
    const mockSock = createMockSocket();

    // 1. Cria agendamento prévio garantido no banco
    const originalBooking = await salonAppointmentService.bookAppointment(tenantId, {
      clientName: 'Camila',
      clientPhone,
      serviceId: 101,
      staffId: 201,
      date: '2026-11-25',
      time: '14:00',
      durationMin: 45,
      origin: 'WHATSAPP_BOT',
      reminderConsent: 1,
    });

    assert.ok(originalBooking.id, 'Agendamento original deve ser criado com sucesso');

    // 2. Cliente envia mensagem solicitando remarcar
    const rescheduleMsg = 'Oi Jéssica, precisei de um imprevisto e queria remarcar meu horário do dia 25';

    jessicaNluService.setMockNluHandler(({ text }) => {
      assert.strictEqual(text, rescheduleMsg);
      return {
        intent: 'RESCHEDULE',
        serviceName: null,
        staffName: null,
        datePreference: null,
        period: null,
        friendlyMessage: null,
      };
    });

    const processed = await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage(rescheduleMsg, clientPhone)
    );

    assert.strictEqual(processed, true);
    const reply = mockSock.getLastText();

    // 3. Verifica que o agendamento original permanece 100% INTACTO no SQLite
    const currentApt = db.prepare('SELECT id, status, start_datetime FROM appointments WHERE id = ?').get(originalBooking.id);
    assert.strictEqual(currentApt.status, 'AGENDADO', 'Agendamento original não pode ser cancelado prematuramente');
    assert.ok(currentApt.start_datetime.includes('2026-11-25'));
    assert.ok(currentApt.start_datetime.includes('14:00'));

    // 4. Verifica que nenhum agendamento duplicado foi criado
    const totalApts = db.prepare('SELECT COUNT(*) as cnt FROM appointments WHERE user_id = ? AND client_phone = ?').get(tenantId, clientPhone);
    assert.strictEqual(totalApts.cnt, 1, 'Não pode criar agendamento duplicado');

    // 5. Verifica resposta acolhedora de handoff ou remarcação transparente
    assert.ok(
      reply.includes('remarcar') || reply.includes('equipe') || reply.includes('qual dia e horário'),
      'Deve responder com acolhimento e suporte para remarcação sem quebrar o fluxo'
    );
  });

  // =========================================================================
  // CASO 9: Resiliência a Timeout / Offline do Gemini Mantendo Naturalidade
  // =========================================================================
  test('Caso 9: Fallback determinístico mantém indiferença de profissional e naturalidade em caso de timeout do Gemini', async () => {
    const mockSock = createMockSocket();
    const sessionKey = `${tenantId}:${clientPhone}`;

    const clientMsg = 'Estou pensando em fazer um corte feminino, tanto faz quem atender amanhã de manhã.';

    // Simula Gemini com timeout / offline
    jessicaNluService.setMockNluHandler(() => {
      const timeoutErr = new Error('NLU_TIMEOUT: Timeout de 8000ms atingido');
      timeoutErr.code = 'NLU_TIMEOUT';
      throw timeoutErr;
    });

    const processed = await salonIncomingDispatcher.dispatchMessage(
      tenantId,
      mockSock,
      createIncomingMessage(clientMsg, clientPhone)
    );

    assert.strictEqual(processed, true, 'Fallback deve recuperar com sucesso');
    const reply = mockSock.getLastText();

    // Assertivas: Fallback determinístico deve identificar o serviço e indiferença sem quebrar
    assert.ok(reply.length > 0, 'Deveria responder normalmente pelo fallback');
    assert.ok(!reply.includes('NLU_TIMEOUT'), 'Erro de timeout não deve vazar para o cliente');

    const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
    assert.ok(session, 'Sessão deve existir');
    assert.strictEqual(session.requestedDatePref, 'amanha', 'Fallback determinístico deve reter requestedDatePref="amanha"');
    assert.strictEqual(session.requestedPeriod, 'manha', 'Fallback determinístico deve reter requestedPeriod="manha"');
    assert.ok(!reply.includes('Com qual de nossas profissionais você gostaria'), 'Fallback determinístico também deve respeitar o tanto faz');
  });
});
