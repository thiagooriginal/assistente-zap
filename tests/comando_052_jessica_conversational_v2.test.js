/**
 * COMANDO 052 — Suíte de Testes da Jéssica Conversacional 2.0 (Humanização NLU)
 *
 * Módulos nativos: node:test e node:assert/strict
 * Banco temporário hermético em os.tmpdir()
 * Socket Baileys mock com fail-closed
 * Cobertura completa:
 *  1. Feature flag desativada (fallback determinístico idêntico ao C050)
 *  2. Agendamento em linguagem natural ("quero cortar o cabelo amanhã de manhã")
 *  3. Seleção de "qualquer profissional"
 *  4. "Primeiro horário livre"
 *  5. Mudança de ideia ("na verdade quero manicure")
 *  6. Consulta de preço no meio do fluxo sem perda de contexto
 *  7. Timeout NLU (> 3500ms) ou erro com fallback silencioso para motor determinístico
 *  8. Expiração de lembretes passados (expirePastReminders -> EXPIRED sem disparo retroativo)
 *  9. Normalização de origem WHATSAPP_BOT no painel.html
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 1. ISOLAMENTO DO BANCO DE DADOS EM os.tmpdir()
const uniqueDbName = `test-c052-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

salonSessionManager.isSalonRealWhatsAppAllowed = (uid, phone) => true;

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

function createIncomingMsg({ fromPhone, text, pushName = 'Cliente Teste C052', id = null }) {
  const clean = fromPhone.replace(/\D/g, '');
  const msgId = id || `MSG-C052-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  id: 520,
  phone: '5511999990520',
  name: 'Jéssica Beauty Studio',
};

let serviceCorteFemId;
let serviceManicureId;
let staffCamilaId;
let staffJessicaId;

test.before(async () => {
  // Cria Salão
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan_tier, subscription_status, session_token, session_expires_at)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 'ACTIVE', 'token_520', datetime('now', '+30 days'))
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
  const svcF = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Corte Feminino em Camadas', 60, 90.00, 1, 'cabelo')
  `).run(SALON.id);
  serviceCorteFemId = svcF.lastInsertRowid;

  const svcM = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Manicure Tradicional', 40, 35.00, 1, 'unhas')
  `).run(SALON.id);
  serviceManicureId = svcM.lastInsertRowid;

  // Profissionais
  const st1 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Camila Santos', 1)
  `).run(SALON.id);
  staffCamilaId = st1.lastInsertRowid;

  const st2 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Jéssica Ramos', 1)
  `).run(SALON.id);
  staffJessicaId = st2.lastInsertRowid;

  // Vínculos
  db.prepare(`INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)`).run(SALON.id, serviceCorteFemId, staffCamilaId);
  db.prepare(`INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)`).run(SALON.id, serviceCorteFemId, staffJessicaId);
  db.prepare(`INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)`).run(SALON.id, serviceManicureId, staffJessicaId);
});

test.after(async () => {
  jessicaNluService.resetMockNluHandler();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'false';
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (err) {}
});

test.beforeEach(() => {
  salonIncomingDispatcher._resetForTesting();
  jessicaNluService.resetMockNluHandler();
});

test('1. Feature Flag Desativada -> Opera exclusivamente via motor determinístico V1', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'false';
  const sock = createMockSocket();
  const phone = '5511999991001';

  // Mensagem genérica
  const handled = await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Oi, tudo bem?' })
  );

  assert.strictEqual(handled, true);
  const resp = sock.getLastText();
  assert.match(resp, /Seja muito bem-vinda ao \*Jéssica Beauty Studio\*/);
  assert.match(resp, /Como posso te ajudar hoje/i);
});

test('2. Agendamento em Linguagem Natural com Turno ("quero cortar o cabelo amanhã de manhã")', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999991002';

  // Mock NLU para classificar intenção com período da manhã e qualquer profissional
  jessicaNluService.setMockNluHandler(async ({ text }) => {
    return {
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Corte Feminino em Camadas',
      staffName: 'ANY',
      period: 'manha',
      datePreference: 'amanha',
      friendlyMessage: null,
    };
  });

  const handled = await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'quero cortar o cabelo amanhã de manhã' })
  );

  assert.strictEqual(handled, true);
  const resp = sock.getLastText();
  assert.match(resp, /Corte Feminino em Camadas/);
  assert.match(resp, /R\$\s*90,00/);
  // Todos os horários oferecidos devem ser do período da manhã (< 12:00)
  const lines = resp.split('\n').filter((l) => /^\d+\.\s+/.test(l));
  assert.ok(lines.length > 0, 'Deve ter oferecido horários');
  for (const line of lines) {
    const matchTime = line.match(/às\s+\*?(\d{2}):(\d{2})\*?/);
    if (matchTime) {
      const hour = parseInt(matchTime[1], 10);
      assert.ok(hour < 12, `Horário ${matchTime[1]}:${matchTime[2]} deve ser do turno da manhã (< 12h)`);
    }
  }
});

test('3. Seleção de Profissional em Linguagem Natural e Escolha do "Primeiro Horário Livre"', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999991003';

  // 1a etapa: Cliente pede manicure com a Jéssica
  jessicaNluService.setMockNluHandler(async ({ text }) => {
    if (text.includes('primeiro')) {
      return {
        intent: 'SELECT_SLOT',
        slotChoice: 'FIRST_AVAILABLE',
        friendlyMessage: null,
      };
    }
    return {
      intent: 'SCHEDULE_INQUIRY',
      serviceName: 'Manicure Tradicional',
      staffName: 'Jéssica Ramos',
      period: 'qualquer',
      friendlyMessage: null,
    };
  });

  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Gostaria de fazer as unhas com a Jéssica' })
  );

  let resp = sock.getLastText();
  assert.match(resp, /Manicure Tradicional/);
  assert.match(resp, /Jéssica Ramos/);

  // 2a etapa: Cliente responde "pode ser o primeiro horário livre"
  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Pode ser o primeiro horário livre' })
  );

  resp = sock.getLastText();
  assert.match(resp, /posso confirmar.*agendamento/i);
  assert.match(resp, /Manicure Tradicional/);
  assert.match(resp, /Jéssica Ramos/);
});

test('4. Mudança de Ideia Durante o Atendimento ("na verdade quero manicure")', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999991004';

  // Passo 1: Começa agendando corte
  jessicaNluService.setMockNluHandler(async () => ({
    intent: 'SCHEDULE_INQUIRY',
    serviceName: 'Corte Feminino em Camadas',
    staffName: 'ANY',
    friendlyMessage: null,
  }));

  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Quero cortar o cabelo' })
  );

  let resp = sock.getLastText();
  assert.match(resp, /Corte Feminino em Camadas/);

  // Passo 2: Cliente muda de ideia
  jessicaNluService.setMockNluHandler(async () => ({
    intent: 'CHANGE_PREFERENCE',
    serviceName: 'Manicure Tradicional',
    staffName: 'ANY',
    friendlyMessage: null,
  }));

  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Pensando bem, na verdade quero manicure tradicional' })
  );

  resp = sock.getLastText();
  assert.match(resp, /Manicure Tradicional/);
  assert.match(resp, /R\$\s*35,00/);
});

test('5. Consulta de Preço sem Perder o Contexto do Agendamento em Andamento', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999991005';

  // Passo 1: Seleciona corte
  jessicaNluService.setMockNluHandler(async () => ({
    intent: 'SCHEDULE_INQUIRY',
    serviceName: 'Corte Feminino em Camadas',
    staffName: 'ANY',
    friendlyMessage: null,
  }));

  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Quero corte feminino' })
  );

  // Passo 2: Pergunta quanto custa a manicure
  jessicaNluService.setMockNluHandler(async () => ({
    intent: 'PRICE_SERVICE_INQUIRY',
    serviceName: 'Manicure Tradicional',
    friendlyMessage: null,
  }));

  await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Qual o valor da manicure?' })
  );

  const resp = sock.getLastText();
  assert.match(resp, /Manicure Tradicional/);
  assert.match(resp, /R\$\s*35,00/);
  assert.match(resp, /Corte Feminino em Camadas/);
});

test('6. NLU Timeout (> 3500ms) ou Erro -> Fallback Silencioso para Motor Determinístico', async () => {
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
  const sock = createMockSocket();
  const phone = '5511999991006';

  // Simula timeout da API do Gemini
  jessicaNluService.setMockNluHandler(async () => {
    throw new Error('NLU_TIMEOUT: Resposta da IA excedeu 3500ms');
  });

  // Envia "Agendar" — no motor determinístico clássico exibe os serviços
  const handled = await salonIncomingDispatcher.dispatchMessage(
    SALON.id,
    sock,
    createIncomingMsg({ fromPhone: phone, text: 'Agendar' })
  );

  assert.strictEqual(handled, true);
  const resp = sock.getLastText();
  // Deve ter respondido normalmente via motor clássico (fallback seguro)
  assert.match(resp, /Para qual serviço você gostaria de agendar|Corte Feminino em Camadas/i);
  assert.match(resp, /Corte Feminino em Camadas/);
  assert.match(resp, /Manicure Tradicional/);
});

test('7. Rotina de Lembretes: expirePastReminders marca PENDING no passado como EXPIRED sem disparar mensagens', async () => {
  // Cria agendamento no passado na tabela appointments com status 'PENDING'
  const pastStmt = db.prepare(`
    INSERT INTO appointments (
      user_id, title, client_name, client_phone, service_id, staff_id,
      start_datetime, end_datetime, status, origin,
      reminder_consent, reminder_24h_status
    ) VALUES (
      ?, 'Corte Feminino em Camadas', 'Cliente Passado', '5511988880001', ?, ?,
      datetime('now', '-2 hours'), datetime('now', '-1 hours'), 'CONFIRMED', 'WHATSAPP_BOT',
      1, 'PENDING'
    )
  `).run(SALON.id, serviceCorteFemId, staffCamilaId);
  const pastApptId = pastStmt.lastInsertRowid;

  // Executa expiração
  const result = salonReminderService.expirePastReminders();
  assert.ok(result.expiredCount >= 1, 'Deve ter expirado pelo menos 1 agendamento passado');

  // Verifica no banco
  const appt = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(pastApptId);
  assert.strictEqual(appt.reminder_24h_status, 'EXPIRED');

  // Garante que NENHUM item foi enfileirado na outbox para este agendamento
  const outbox = db.prepare('SELECT COUNT(*) as cnt FROM whatsapp_notification_outbox WHERE appointment_id = ?').get(pastApptId);
  assert.strictEqual(outbox.cnt, 0);
});

test('8. Validação de Badges de Origem e Lembretes no painel.html', () => {
  const painelHtml = fs.readFileSync(path.join(__dirname, '../public/cliente/painel.html'), 'utf8');

  // 1. Verifica suporte a whatsapp_bot na badge de origem
  assert.ok(
    painelHtml.includes("normOrigin === 'whatsapp_bot'"),
    'painel.html deve reconhecer whatsapp_bot como origem WhatsApp'
  );

  // 2. Verifica exibição de badge para status EXPIRED de lembretes
  assert.ok(
    painelHtml.includes("reminderStatus === 'EXPIRED'"),
    'painel.html deve verificar reminderStatus === EXPIRED'
  );
  assert.ok(
    painelHtml.includes("Lembrete 24h: Expirado"),
    'painel.html deve conter label Lembrete 24h: Expirado'
  );
});
