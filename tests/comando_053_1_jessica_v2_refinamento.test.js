/**
 * COMANDO 053.1 — Suíte de Testes Herméticos: Correções Críticas e Refinamento Conversacional Jéssica 2.0
 *
 * Módulos nativos: node:test e node:assert/strict
 * Banco temporário hermético em os.tmpdir()
 * Sem chamadas externas, sem afetar dados de produção.
 *
 * Cobertura mandatária do Comando 053.1:
 *  1. Expiração Segura e Atômica (expirePastReminders): transação BEGIN/COMMIT e Rollback em falha (_failForTest)
 *  2. Defesa Zero-Trust de Consentimento LGPD contra falsos positivos do NLU
 *  3. Cancelamento em AWAITING_REMINDER_OPTIN não cancela agendamento confirmado
 *  4. Confirmação do agendamento exibe horário e detalhes reais (sem "undefined")
 *  5. Resolução de datas e turnos (resolveCandidateDays e filterSlotsByPreference)
 *  6. Janela/Turno indisponível: explicação cordial sem empurrar horário fora de preferência
 *  7. Limite inicial de 3 horários com dica e suporte a "ver mais opções"
 *  8. Fluxo E2E completo humanizado Jéssica 2.0
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Isolamento hermético em banco temporário
const uniqueDbName = `test-c053-1-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
const testDbPath = path.join(os.tmpdir(), uniqueDbName);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';

const db = require('../src/database/db');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const salonReminderService = require('../src/services/salonReminderService');
const jessicaNluService = require('../src/services/jessicaNluService');

salonSessionManager.isSalonRealWhatsAppAllowed = () => true;

function createMockSocket() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content, text: content?.text || '', timestamp: Date.now() });
      return { key: { id: `mock-${Date.now()}` } };
    },
    getLastText: () => {
      if (sentMessages.length === 0) return '';
      return sentMessages[sentMessages.length - 1].text || '';
    },
    clear: () => {
      sentMessages.length = 0;
    },
  };
}

function createIncomingMsg({ fromPhone, text, pushName = 'Cliente C053.1', id = null }) {
  const clean = fromPhone.replace(/\D/g, '');
  const msgId = id || `MSG-C053-1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    key: {
      remoteJid: `${clean}@s.whatsapp.net`,
      fromMe: false,
      id: msgId,
    },
    pushName,
    message: {
      conversation: text,
    },
  };
}

const SALON = {
  id: 531,
  phone: '5511999990531',
  name: 'Studio Jéssica Refinado',
};

let serviceCorteId;
let serviceEscovaId;
let staffPaulaId;
let staffMarianaId;

test.before(async () => {
  // Cria salão de teste
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan_tier, subscription_status, session_token, session_expires_at)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 'ACTIVE', 'token_531', datetime('now', '+30 days'))
  `).run(SALON.id, SALON.phone, SALON.name);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours, b2c_reminders_enabled)
    VALUES (?, ?, ?, 1)
  `).run(
    SALON.id,
    SALON.name,
    JSON.stringify({
      timezone: 'America/Sao_Paulo',
      days: {
        0: { open: true, start: '08:00', end: '20:00' },
        1: { open: true, start: '08:00', end: '20:00' },
        2: { open: true, start: '08:00', end: '20:00' },
        3: { open: true, start: '08:00', end: '20:00' },
        4: { open: true, start: '08:00', end: '20:00' },
        5: { open: true, start: '08:00', end: '20:00' },
        6: { open: true, start: '08:00', end: '20:00' },
      },
    })
  );

  // Serviços
  const s1 = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Corte e Escova Modelada', 60, 110.00, 1, 'cabelo')
  `).run(SALON.id);
  serviceCorteId = s1.lastInsertRowid;

  const s2 = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Escova Express', 30, 50.00, 1, 'cabelo')
  `).run(SALON.id);
  serviceEscovaId = s2.lastInsertRowid;

  // Profissionais
  const st1 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Paula Lima', 1)
  `).run(SALON.id);
  staffPaulaId = st1.lastInsertRowid;

  const st2 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Mariana Souza', 1)
  `).run(SALON.id);
  staffMarianaId = st2.lastInsertRowid;

  // Vínculos
  db.prepare(`INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)`).run(SALON.id, serviceCorteId, staffPaulaId);
  db.prepare(`INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)`).run(SALON.id, serviceCorteId, staffMarianaId);
  db.prepare(`INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)`).run(SALON.id, serviceEscovaId, staffPaulaId);
});

test.after(async () => {
  jessicaNluService.resetMockNluHandler();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'false';
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (_) {}
});

test.beforeEach(() => {
  salonIncomingDispatcher._resetForTesting();
  jessicaNluService.resetMockNluHandler();
});

test('1. Atomicidade e Rollback em expirePastReminders (_failForTest)', async () => {
  // Cria agendamento passado com reminder PENDING
  const apt = db.prepare(`
    INSERT INTO appointments (
      user_id, title, client_name, client_phone, service_id, staff_id,
      start_datetime, end_datetime, status, origin, reminder_consent, reminder_24h_status
    ) VALUES (
      ?, 'Corte e Escova Modelada', 'Cliente Rollback', '5511999990001', ?, ?,
      datetime('now', '-3 hours'), datetime('now', '-2 hours'), 'CONFIRMED', 'WHATSAPP_BOT', 1, 'PENDING'
    )
  `).run(SALON.id, serviceCorteId, staffPaulaId);
  const aptId = apt.lastInsertRowid;

  // Cria outbox associada PENDING
  db.prepare(`
    INSERT INTO whatsapp_notification_outbox (
      user_id, appointment_id, recipient_phone, event_type, message_text, status
    ) VALUES (
      ?, ?, '5511999990001', 'REMINDER_24H', '{"msg":"teste"}', 'PENDING'
    )
  `).run(SALON.id, aptId);

  // Executa com gancho de erro simulado: deve disparar exceção e fazer ROLLBACK
  assert.throws(
    () => {
      salonReminderService.expirePastReminders({ _failForTest: true });
    },
    /SIMULATED_TRANSACTION_FAILURE_FOR_TEST/
  );

  // Verifica que status no appointments permanece PENDING (não foi alterado para EXPIRED)
  const aptAfter = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(aptId);
  assert.strictEqual(aptAfter.reminder_24h_status, 'PENDING', 'Rollback deve preservar PENDING no appointment');

  // Verifica que outbox permanece PENDING
  const outboxAfter = db.prepare('SELECT status FROM whatsapp_notification_outbox WHERE appointment_id = ?').get(aptId);
  assert.strictEqual(outboxAfter.status, 'PENDING', 'Rollback deve preservar PENDING na outbox');

  // Executa sem erro: deve commitar com sucesso
  const resSuccess = salonReminderService.expirePastReminders({ userId: SALON.id });
  assert.ok(resSuccess.expiredCount >= 1);
  assert.ok(resSuccess.cancelledOutboxCount >= 1);

  const aptFinal = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(aptId);
  assert.strictEqual(aptFinal.reminder_24h_status, 'EXPIRED');
  const outboxFinal = db.prepare('SELECT status FROM whatsapp_notification_outbox WHERE appointment_id = ?').get(aptId);
  assert.strictEqual(outboxFinal.status, 'CANCELLED');
});

test('2. Proteção LGPD Zero-Trust: IA retornar optInConsent: true com texto incongruente NÃO autoriza', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999992002';

  // 1. Cria agendamento prévio com consentimento 0
  const apt = db.prepare(`
    INSERT INTO appointments (
      user_id, title, client_name, client_phone, service_id, staff_id,
      start_datetime, end_datetime, status, origin, reminder_consent
    ) VALUES (
      ?, 'Corte e Escova Modelada', 'Cliente LGPD', ?, ?, ?,
      datetime('now', '+2 days'), datetime('now', '+2 days', '+1 hour'), 'CONFIRMED', 'WHATSAPP_BOT', 0
    )
  `).run(SALON.id, phone, serviceCorteId, staffPaulaId);
  const aptId = apt.lastInsertRowid;

  // Inicia conversa e coloca sessão em AWAITING_REMINDER_OPTIN
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Oi' })
  );

  // Simula o estado da sessão diretamente em AWAITING_REMINDER_OPTIN
  jessicaNluService.setMockNluHandler(async () => ({
    intent: 'REMINDER_OPTIN',
    optInConsent: true, // NLU alucina que é consentimento
    friendlyMessage: null,
  }));

  // Mas o texto do cliente é falso-positivo clássico: "Quero agendar outro dia"
  // Primeiro, estabelecemos a sessão no estado AWAITING_REMINDER_OPTIN via fluxo normal de confirmação
  // Criamos uma sessão com state AWAITING_CONFIRMATION
  salonIncomingDispatcher._resetForTesting();

  // Executa fluxo direto de confirmação para colocar em AWAITING_REMINDER_OPTIN
  jessicaNluService.setMockNluHandler(async ({ text }) => {
    if (text.includes('Quero agendar outro')) {
      return {
        intent: 'REMINDER_OPTIN',
        optInConsent: true, // IA diz que consentiu
        friendlyMessage: null,
      };
    }
    return {
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Corte e Escova Modelada',
      staffName: 'Paula Lima',
      friendlyMessage: null,
    };
  });

  // Passo 1: Solicita serviço
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Quero corte e escova' })
  );

  // Passo 2: Escolhe horário 1
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: '1' })
  );

  // Passo 3: Confirma agendamento
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Sim, confirmo' })
  );

  const confirmMsg = sock.getLastText();
  assert.match(confirmMsg, /Agendamento confirmado com sucesso/);
  assert.match(confirmMsg, /lembrete.*WhatsApp/i);

  // Passo 4: Cliente manda "Quero agendar outro horário"
  // A IA respondeu optInConsent: true, mas o dispatcher Zero-Trust DEVE recusar consentimento!
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Quero agendar outro dia para minha amiga' })
  );

  const optInReply = sock.getLastText();
  assert.match(optInReply, /sem lembretes automáticos/i);

  // Verifica no banco de dados que reminder_consent permanece 0
  const aptCheck = db.prepare('SELECT reminder_consent FROM appointments WHERE user_id = ? AND client_phone = ? ORDER BY id DESC LIMIT 1').get(SALON.id, phone);
  assert.strictEqual(aptCheck.reminder_consent, 0, 'Consentimento LGPD NÃO pode ser concedido');
});

test('3. Cancelar no estado AWAITING_REMINDER_OPTIN NÃO cancela o agendamento confirmado', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999992003';

  jessicaNluService.setMockNluHandler(async ({ text }) => {
    if (text.includes('cancelar')) {
      return {
        intent: 'CANCEL_OR_DISMISS',
        friendlyMessage: 'Tudo bem! Cancelado.',
      };
    }
    return {
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Corte e Escova Modelada',
      staffName: 'Paula Lima',
    };
  });

  // 1. Agenda
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Corte e escova' })
  );
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: '1' })
  );
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Sim' })
  );

  assert.match(sock.getLastText(), /Agendamento confirmado com sucesso/);

  // 2. Cliente responde "Cancelar" à pergunta de lembretes
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Cancelar' })
  );

  const reply = sock.getLastText();
  // Não pode dizer "O agendamento foi cancelado"!
  assert.doesNotMatch(reply, /agendamento foi cancelado/i);
  assert.match(reply, /permanece confirmado normalmente sem lembretes/i);

  // Confirma no banco que o status do agendamento permanece AGENDADO
  const apt = db.prepare('SELECT status, reminder_consent FROM appointments WHERE user_id = ? AND client_phone = ? ORDER BY id DESC LIMIT 1').get(SALON.id, phone);
  assert.strictEqual(apt.status, 'AGENDADO');
  assert.strictEqual(apt.reminder_consent, 0);
});

test('4. Confirmação exibe Horário e Detalhes Sem Qualquer "undefined"', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999992004';

  jessicaNluService.setMockNluHandler(async () => ({
    intent: 'SCHEDULE_INQUIRY',
    serviceName: 'Corte e Escova Modelada',
    staffName: 'Paula Lima',
  }));

  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Quero corte e escova' })
  );
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: '1' })
  );
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Sim' })
  );

  const confirmMsg = sock.getLastText();
  // Não pode conter literal "undefined" nem "null"
  assert.doesNotMatch(confirmMsg, /undefined/i);
  assert.doesNotMatch(confirmMsg, /null/i);

  // Deve conter campos corretos
  assert.match(confirmMsg, /• \*Horário:\* \d{2}:\d{2}/);
  assert.match(confirmMsg, /• \*Data:\* \d{2}\/\d{2}\/\d{4}/);
  assert.match(confirmMsg, /• \*Valor:\* R\$ 110,00/);
  assert.match(confirmMsg, /• \*Serviço:\* Corte e Escova Modelada/);
  assert.match(confirmMsg, /• \*Profissional:\* Paula Lima/);
});

test('5. Resolução Temporal: resolveCandidateDays e filterSlotsByPreference', () => {
  const baseDate = new Date('2026-11-20T10:00:00-03:00'); // Uma sexta-feira

  // Teste resolveCandidateDays
  const hoje = salonIncomingDispatcher.resolveCandidateDays('hoje', baseDate);
  assert.strictEqual(hoje.length, 1);
  assert.strictEqual(hoje[0].dateStr, '2026-11-20');

  const amanha = salonIncomingDispatcher.resolveCandidateDays('amanha', baseDate);
  assert.strictEqual(amanha.length, 1);
  assert.strictEqual(amanha[0].dateStr, '2026-11-21');

  const sabado = salonIncomingDispatcher.resolveCandidateDays('sabado', baseDate);
  assert.strictEqual(sabado.length, 1);
  assert.strictEqual(sabado[0].dateStr, '2026-11-21');

  // Teste filterSlotsByPreference
  const mockSlots = [
    { number: 1, date: '2026-11-21', time: '09:00', dayLabel: 'Amanhã' },
    { number: 2, date: '2026-11-21', time: '10:30', dayLabel: 'Amanhã' },
    { number: 3, date: '2026-11-21', time: '14:00', dayLabel: 'Amanhã' },
    { number: 4, date: '2026-11-21', time: '16:30', dayLabel: 'Amanhã' },
    { number: 5, date: '2026-11-21', time: '19:00', dayLabel: 'Amanhã' },
  ];

  const manhaSlots = salonIncomingDispatcher.filterSlotsByPreference(mockSlots, 'manha', null);
  assert.deepStrictEqual(manhaSlots.map((s) => s.time), ['09:00', '10:30']);

  const tardeSlots = salonIncomingDispatcher.filterSlotsByPreference(mockSlots, 'tarde', null);
  assert.deepStrictEqual(tardeSlots.map((s) => s.time), ['14:00', '16:30']);

  const after15h = salonIncomingDispatcher.filterSlotsByPreference(mockSlots, null, 'after_15h');
  assert.deepStrictEqual(after15h.map((s) => s.time), ['16:30', '19:00']);

  const notMorning = salonIncomingDispatcher.filterSlotsByPreference(mockSlots, null, 'not_morning');
  assert.deepStrictEqual(notMorning.map((s) => s.time), ['14:00', '16:30', '19:00']);
});

test('6. Janela Indisponível: Não empurra horário fora da preferência sem consultar cliente', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999992006';

  // Simula cliente pedindo horário no turno da noite, mas salon só tem horários que se esgotam ou não coincidem
  // NLU diz "noite", mas forçamos filtro a retornar vazio
  jessicaNluService.setMockNluHandler(async () => ({
    intent: 'SCHEDULE_INQUIRY',
    serviceName: 'Corte e Escova Modelada',
    staffName: 'Paula Lima',
    datePreference: 'hoje',
    period: 'noite',
    timeConstraint: 'after_21h', // Fora do expediente (fecha às 20h)
  }));

  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Quero cortar o cabelo hoje depois das 21h' })
  );

  const reply = sock.getLastText();
  // Deve alertar que não tem horários disponíveis no horário/período solicitado e perguntar outro turno
  assert.match(reply, /Não encontrei horários disponíveis.*(no período da noite|no horário solicitado)/i);
  assert.match(reply, /Você teria disponibilidade em outro turno ou dia\?/i);
});

test('7. Apresenta até 3 horários com dica de mais opções e aceita "ver mais opções"', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999992007';

  jessicaNluService.setMockNluHandler(async () => ({
    intent: 'SCHEDULE_INQUIRY',
    serviceName: 'Corte e Escova Modelada',
    staffName: 'ANY',
  }));

  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Quero horário para corte e escova' })
  );

  const reply = sock.getLastText();
  // Verifica que mostra no máximo 3 opções iniciais
  const lines = reply.split('\n').filter((l) => /^\d+\.\s+/.test(l));
  assert.ok(lines.length <= 3, `Deve mostrar no máximo 3 horários, mostrou ${lines.length}`);
  assert.match(reply, /Quer ver mais opções\? É só me falar!/);

  // Cliente pede mais opções
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Quero ver mais opções de horários' })
  );

  const moreReply = sock.getLastText();
  assert.match(moreReply, /mais opções de horários/i);
});

test('8. Fluxo E2E Completo: Linguagem Natural -> Agendamento -> Opt-in Concedido Explicitamente', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999992008';

  jessicaNluService.setMockNluHandler(async ({ text }) => {
    if (text.includes('Sim, quero receber')) {
      return {
        intent: 'REMINDER_OPTIN',
        optInConsent: true,
      };
    }
    return {
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Escova Express',
      staffName: 'Paula Lima',
      period: 'tarde',
    };
  });

  // 1. Pedido em linguagem natural
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Olá Jéssica, gostaria de fazer uma escova express amanhã de tarde com a Paula' })
  );

  let reply = sock.getLastText();
  assert.match(reply, /Escova Express/);
  assert.match(reply, /Paula Lima/);

  // 2. Escolha do horário
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: '1' })
  );

  reply = sock.getLastText();
  assert.match(reply, /posso confirmar.*agendamento/i);

  // 3. Confirmação
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Sim, por favor!' })
  );

  reply = sock.getLastText();
  assert.match(reply, /Agendamento confirmado com sucesso/);
  assert.match(reply, /• \*Serviço:\* Escova Express/);
  assert.match(reply, /• \*Valor:\* R\$ 50,00/);

  // 4. Aceite explícito e inequívoco de lembrete
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Sim, quero receber o lembrete' })
  );

  reply = sock.getLastText();
  assert.match(reply, /Lembrete de 24h ativado com sucesso/);

  // Confirma no banco que o consentimento foi gravado como 1
  const apt = db.prepare('SELECT status, reminder_consent, reminder_consent_origin FROM appointments WHERE user_id = ? AND client_phone = ? ORDER BY id DESC LIMIT 1').get(SALON.id, phone);
  assert.strictEqual(apt.status, 'AGENDADO');
  assert.strictEqual(apt.reminder_consent, 1);
  assert.strictEqual(apt.reminder_consent_origin, 'whatsapp_bot_optin');
});

test('9. Conversa Aberta e Fluida: Pedido de "renovar o visual amanhã de manhã" acolhe sem ordens mecânicas', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999992009';

  jessicaNluService.setMockNluHandler(async ({ text }) => {
    return {
      intent: 'SCHEDULE_INQUIRY',
      serviceName: null,
      staffName: null,
      datePreference: 'amanha',
      period: 'manha',
      friendlyMessage: null,
    };
  });

  const handled = await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({
      fromPhone: phone,
      text: 'Oi, tudo bem? Tô querendo dar uma renovada no visual amanhã de manhã. Vocês conseguem me atender?',
    })
  );

  assert.strictEqual(handled, true);
  const reply = sock.getLastText();

  // Garante acolhimento caloroso e menção a amanhã de manhã
  assert.match(reply, /Com certeza.*Amanhã de manhã temos horários livres sim/i);
  assert.match(reply, /Você já pensou no que gostaria de fazer\?/i);

  // Garante AUSÊNCIA TOTAL de qualquer instrução mecânica ("digite", "escolha o número")
  assert.doesNotMatch(reply, /digite/i);
  assert.doesNotMatch(reply, /escolha digitando/i);
  assert.doesNotMatch(reply, /número correspondente/i);
});
