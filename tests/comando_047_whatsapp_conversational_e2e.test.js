/**
 * COMANDO 047 — Suíte de Homologação Conversacional Completa da Jéssica (WhatsApp)
 *
 * Módulos nativos: node:test e node:assert/strict
 * Exercita o dispatcher real: src/whatsapp/salonIncomingDispatcher.js
 * Banco isolado temporário em os.tmpdir()
 * Socket Baileys simulado (captura mensagens)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 1. ISOLAMENTO MANDATÓRIO DE BANCO DE DADOS EM os.tmpdir()
const uniqueDbName = `test-c047-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
const salonAppointmentService = require('../src/services/salonAppointmentService');

// Interceptar verificação de transporte Baileys exclusivamente para o mock do teste
salonSessionManager.isSalonRealWhatsAppAllowed = (uid, phone) => true;

// Mock Socket Baileys
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

function createIncomingMsg({ fromPhone, text, pushName = 'Mariana Silva', id = null }) {
  const clean = fromPhone.replace(/\D/g, '');
  const msgId = id || `MSG-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

const SALON_A = {
  id: 401,
  phone: '5511999990401',
  name: 'Jéssica Beauty Premium',
};

const SALON_B = {
  id: 402,
  phone: '5511999990402',
  name: 'Espaço Glamour B',
};

let serviceCorteId;
let serviceColoracaoId;
let staffJessicaId;
let staffCamilaId;

test.before(async () => {
  // 1. Criar Salão A
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan_tier, subscription_status, session_token, session_expires_at)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 'ACTIVE', 'token_401', datetime('now', '+30 days'))
  `).run(SALON_A.id, SALON_A.phone, SALON_A.name);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours, b2c_reminders_enabled)
    VALUES (?, ?, ?, 1)
  `).run(
    SALON_A.id,
    SALON_A.name,
    JSON.stringify({
      days: {
        0: { open: false },
        1: { open: true, start: '08:00', end: '20:00' },
        2: { open: true, start: '08:00', end: '20:00' },
        3: { open: true, start: '08:00', end: '20:00' },
        4: { open: true, start: '08:00', end: '20:00' },
        5: { open: true, start: '08:00', end: '20:00' },
        6: { open: true, start: '08:00', end: '20:00' },
      },
    })
  );

  // 2. Criar Salão B (para teste de isolamento multi-tenant)
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan_tier, subscription_status, session_token, session_expires_at)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 'ACTIVE', 'token_402', datetime('now', '+30 days'))
  `).run(SALON_B.id, SALON_B.phone, SALON_B.name);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours, b2c_reminders_enabled)
    VALUES (?, ?, ?, 1)
  `).run(
    SALON_B.id,
    SALON_B.name,
    JSON.stringify({
      days: {
        1: { open: true, start: '09:00', end: '18:00' },
      },
    })
  );

  // Serviços do Salão A
  const svcA1 = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active)
    VALUES (?, 'Corte Feminino em Camadas', 60, 120.00, 1)
  `).run(SALON_A.id);
  serviceCorteId = svcA1.lastInsertRowid;

  const svcA2 = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active)
    VALUES (?, 'Coloração Completa', 90, 220.00, 1)
  `).run(SALON_A.id);
  serviceColoracaoId = svcA2.lastInsertRowid;

  // Profissionais do Salão A: Jéssica e Camila
  const stA1 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Jéssica Ramos', 1)
  `).run(SALON_A.id);
  staffJessicaId = stA1.lastInsertRowid;

  const stA2 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Camila Santos', 1)
  `).run(SALON_A.id);
  staffCamilaId = stA2.lastInsertRowid;

  // Habilitar vínculos N:N no Salão A
  // Corte Feminino: Jéssica e Camila habilitadas e confirmadas
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1), (?, ?, ?, 1)
  `).run(SALON_A.id, serviceCorteId, staffJessicaId, SALON_A.id, serviceCorteId, staffCamilaId);

  // Coloração: apenas Jéssica habilitada e confirmada
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1)
  `).run(SALON_A.id, serviceColoracaoId, staffJessicaId);

  // Serviço exclusivo do Salão B
  db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active)
    VALUES (?, 'Barba Tradicional Salão B', 30, 45.00, 1)
  `).run(SALON_B.id);
});

test.after(async () => {
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch (_) {}
});

test.beforeEach(() => {
  salonIncomingDispatcher._resetForTesting();
});

// ============================================================================
// 2. CENÁRIO CONVERSACIONAL PRINCIPAL
// ============================================================================

test('Cenário Principal: Fluxo conversacional ponta a ponta com Jéssica via WhatsApp', async (t) => {
  const sock = createMockSocket();
  const customerPhone = '5511988880001';
  const customerName = 'Mariana Silva';
  const conversationTranscript = [];

  async function sendCustomerMsg(userText) {
    const msg = createIncomingMsg({ fromPhone: customerPhone, text: userText, pushName: customerName });
    await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, msg);
    const botReply = sock.getLastText();
    conversationTranscript.push({
      sender: 'Cliente',
      text: userText,
    });
    conversationTranscript.push({
      sender: 'Jéssica (Bot)',
      text: botReply,
    });
    return botReply;
  }

  // ETAPA 1: Cliente inicia solicitando corte feminino
  const reply1 = await sendCustomerMsg('Oi, gostaria de agendar um corte feminino.');
  assert.ok(reply1.includes('Corte Feminino em Camadas'), 'Deve reconhecer o serviço cadastrado');
  assert.ok(reply1.includes('120,00'), 'Deve informar o preço do serviço');
  assert.ok(reply1.includes('Camila Santos') && reply1.includes('Jéssica Ramos'), 'Deve apresentar as profissionais habilitadas');
  assert.ok(reply1.includes('Qualquer profissional disponível'), 'Deve conter opção automática');

  // ETAPA 2: Cliente escolhe "Pode ser qualquer profissional."
  const reply2 = await sendCustomerMsg('Pode ser qualquer profissional.');
  assert.ok(reply2.includes('temos os seguintes horários livres') || reply2.includes('horários disponíveis'), 'Deve apresentar horários livres reais');
  assert.ok(reply2.includes('1.') && reply2.includes(':'), 'Deve conter lista numerada de horários livres');

  // ETAPA 3: Cliente escolhe a opção 1 de horário
  const reply3 = await sendCustomerMsg('1');
  assert.ok(reply3.includes('confira os dados do seu agendamento'), 'Deve exibir o resumo de confirmação');
  assert.ok(reply3.includes('Jéssica Beauty Premium'), 'Deve exibir o nome do salão');
  assert.ok(reply3.includes('Corte Feminino em Camadas'), 'Deve exibir o serviço');
  assert.ok(reply3.includes('Profissional:'), 'Deve indicar a profissional atribuída');
  assert.ok(reply3.includes('Camila Santos') || reply3.includes('Jéssica Ramos'), 'Profissional deve ser nominal');
  assert.ok(reply3.includes('Posso confirmar o seu agendamento?'), 'Deve solicitar confirmação expressa');

  // ETAPA 4: Cliente confirma: "Sim, pode confirmar."
  const reply4 = await sendCustomerMsg('Sim, pode confirmar.');
  assert.ok(reply4.includes('Agendamento confirmado com sucesso!'), 'Deve confirmar o agendamento');
  assert.ok(reply4.includes('Lembrete 24h por WhatsApp (Opcional):'), 'Deve oferecer opt-in opcional de lembrete');
  assert.ok(reply4.includes('Digite *Sim* ou *1* para autorizar o lembrete'), 'Deve orientar como ativar opcionalmente');

  // Validação no Banco SQLite Temporário após a confirmação:
  const aptRow = db.prepare(`
    SELECT id, client_name, client_phone, service_id, staff_id, status, origin, reminder_consent, reminder_24h_status
    FROM appointments
    WHERE user_id = ? AND client_phone = ?
    ORDER BY id DESC LIMIT 1
  `).get(SALON_A.id, customerPhone);

  assert.ok(aptRow, 'O agendamento deve estar gravado no banco de dados');
  assert.strictEqual(aptRow.client_name, customerName);
  assert.strictEqual(aptRow.status, 'AGENDADO');
  assert.strictEqual(aptRow.origin, 'WHATSAPP_BOT');
  assert.ok(aptRow.staff_id > 0, 'staff_id deve ser um profissional nominal atribuído');
  assert.strictEqual(aptRow.reminder_consent, 0, 'Agendamento recém-confirmado NÃO deve ter consentimento automático');
  assert.strictEqual(aptRow.reminder_24h_status, 'DISABLED', 'Status do lembrete deve ser DISABLED até opt-in expresso');

  // ETAPA 5: Cliente decide aceitar o lembrete de WhatsApp opcional
  const reply5 = await sendCustomerMsg('Sim, pode enviar o lembrete');
  assert.ok(reply5.includes('Lembrete de 24h ativado com sucesso'), 'Deve acusar ativação do lembrete');
  assert.ok(reply5.includes('Parar lembretes'), 'Deve orientar sobre revogação futura');

  // Validação do consentimento gravado após a resposta expressa:
  const aptRowConsented = db.prepare('SELECT reminder_consent, reminder_24h_status, reminder_consent_origin FROM appointments WHERE id = ?').get(aptRow.id);
  assert.strictEqual(aptRowConsented.reminder_consent, 1, 'Consentimento deve ter sido ativado');
  assert.strictEqual(aptRowConsented.reminder_24h_status, 'PENDING', 'Lembrete deve transicionar para PENDING');
  assert.strictEqual(aptRowConsented.reminder_consent_origin, 'whatsapp_bot_optin');

  // Salvar a transcrição para exibição no relatório
  global.__C047_TRANSCRIPT__ = conversationTranscript;
});

// ============================================================================
// 3. TESTES COMPLEMENTARES (1 a 10 + Revogação)
// ============================================================================

test('Complementar 1: Serviço inexistente ou não reconhecido lista menu do catálogo', async () => {
  const sock = createMockSocket();
  const phone = '5511988880002';

  // Mensagem inicial de agendamento genérico
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Quero agendar um serviço' }));
  assert.ok(sock.getLastText().includes('Para qual serviço você gostaria de agendar'));

  // Cliente digita serviço não reconhecido
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Quero fazer tatuagem' }));
  const reply = sock.getLastText();
  assert.ok(reply.includes('Não consegui identificar o serviço desejado'), 'Deve informar que não identificou');
  assert.ok(reply.includes('Corte Feminino em Camadas') && reply.includes('Coloração Completa'), 'Deve listar serviços válidos');
});

test('Complementar 2: Profissional não habilitado para o serviço não é listado', async () => {
  const sock = createMockSocket();
  const phone = '5511988880003';

  // Coloração: apenas Jéssica é qualificada
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Gostaria de agendar coloração' }));
  const reply = sock.getLastText();
  assert.ok(reply.includes('Jéssica Ramos'), 'Deve listar Jéssica Ramos');
  assert.ok(!reply.includes('Camila Santos'), 'Camila Santos NÃO deve ser listada para coloração');
});

test('Complementar 3: Escolha "Qualquer profissional disponível" busca horários consolidados', async () => {
  const sock = createMockSocket();
  const phone = '5511988880004';

  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Agendar corte feminino' }));
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: '3' })); // Opção 3: Qualquer profissional

  const reply = sock.getLastText();
  assert.ok(reply.includes('temos os seguintes horários livres'), 'Deve retornar lista de horários');
  assert.ok(reply.includes('1.'), 'Deve listar opções');
});

test('Complementar 4: Conflito parcial (uma profissional ocupada e outra livre)', async () => {
  const sock = createMockSocket();
  const phone = '5511988880005';

  // Ocupar Jéssica no dia 17/11/2026 das 10:00 às 11:00
  db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, service_id, staff_id, start_datetime, end_datetime, duration_min, origin, status)
    VALUES (?, 'Corte', 'Ocupante Jéssica', '5511911112222', ?, ?, '2026-11-17T10:00:00', '2026-11-17T11:00:00', 60, 'PAINEL', 'CONFIRMADO')
  `).run(SALON_A.id, serviceCorteId, staffJessicaId);

  // Solicitar verificação de slot para Camila no mesmo horário (deve estar livre)
  const check = await salonAppointmentService.checkSlotAvailability(SALON_A.id, {
    startDt: '2026-11-17T10:00:00',
    endDt: '2026-11-17T11:00:00',
    serviceId: serviceCorteId,
    staffId: null, // modo automático
    durationMin: 60,
  });

  assert.strictEqual(check.available, true, 'Deve encontrar Camila disponível às 10:00');
  assert.strictEqual(check.staffId, staffCamilaId, 'Deve atribuir a Camila Santos');
});

test('Complementar 5: Conflito real quando todas as profissionais estão ocupadas', async () => {
  // Ocupar Jéssica e Camila no dia 17/11/2026 das 14:00 às 15:00
  db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, service_id, staff_id, start_datetime, end_datetime, duration_min, origin, status)
    VALUES (?, 'Corte', 'Ocupante Jéssica', '5511911112222', ?, ?, '2026-11-17T14:00:00', '2026-11-17T15:00:00', 60, 'PAINEL', 'CONFIRMADO'),
           (?, 'Corte', 'Ocupante Camila', '5511911113333', ?, ?, '2026-11-17T14:00:00', '2026-11-17T15:00:00', 60, 'PAINEL', 'CONFIRMADO')
  `).run(SALON_A.id, serviceCorteId, staffJessicaId, SALON_A.id, serviceCorteId, staffCamilaId);

  const check = await salonAppointmentService.checkSlotAvailability(SALON_A.id, {
    startDt: '2026-11-17T14:00:00',
    endDt: '2026-11-17T15:00:00',
    serviceId: serviceCorteId,
    staffId: null,
    durationMin: 60,
  });

  assert.strictEqual(check.available, false, 'Deve detectar conflito real quando todas estão ocupadas');
});

test('Complementar 6: Cancelamento da conversa antes da confirmação', async () => {
  const sock = createMockSocket();
  const phone = '5511988880006';

  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Quero cortar cabelo' }));
  assert.ok(sock.getLastText().includes('Com qual de nossas profissionais'));

  // Cliente cancela
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Cancelar' }));
  const reply = sock.getLastText();
  assert.ok(reply.includes('Tudo bem! O agendamento foi cancelado'), 'Deve confirmar o cancelamento da conversa');

  // Verificar que nada foi gravado
  const count = db.prepare('SELECT COUNT(*) as total FROM appointments WHERE user_id = ? AND client_phone = ?').get(SALON_A.id, phone).total;
  assert.strictEqual(count, 0, 'Nenhum agendamento deve ser persistido');
});

test('Complementar 7: Mensagens repetidas e proteção contra duplicidade', async () => {
  const sock = createMockSocket();
  const phone = '5511988880007';
  const duplicateId = 'FIXED-MSG-ID-DUP-01';

  const msg1 = createIncomingMsg({ fromPhone: phone, text: 'Oi', id: duplicateId });
  const processed1 = await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, msg1);
  assert.strictEqual(processed1, true, 'Primeira mensagem deve ser processada');
  assert.strictEqual(sock.sentMessages.length, 1);

  // Segunda mensagem idêntica
  const msg2 = createIncomingMsg({ fromPhone: phone, text: 'Oi', id: duplicateId });
  const processed2 = await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, msg2);
  assert.strictEqual(processed2, false, 'Mensagem duplicada deve ser descartada');
  assert.strictEqual(sock.sentMessages.length, 1, 'Não deve ter enviado mensagem duplicada');
});

test('Complementar 8: Isolamento entre salões (Multi-tenant)', async () => {
  const sock = createMockSocket();
  const phone = '5511988880008';

  // Mensagem para o Salão B
  await salonIncomingDispatcher.dispatchMessage(SALON_B.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Serviços' }));
  const replyB = sock.getLastText();
  assert.ok(replyB.includes('Espaço Glamour B'), 'Deve identificar o Salão B');
  assert.ok(replyB.includes('Barba Tradicional Salão B'), 'Deve listar serviço do Salão B');
  assert.ok(!replyB.includes('Corte Feminino em Camadas'), 'Não deve vazar serviços do Salão A');
});

test('Complementar 9: Resposta inválida ao selecionar profissional ou horário', async () => {
  const sock = createMockSocket();
  const phone = '5511988880009';

  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Agendar corte' }));

  // Em AWAITING_STAFF, cliente digita opção inválida "99"
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: '99' }));
  let reply = sock.getLastText();
  assert.ok(reply.includes('Não entendi a opção escolhida'), 'Deve avisar sobre profissional inválido');

  // Escolhe profissional válido
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: '1' }));
  assert.ok(sock.getLastText().includes('temos os seguintes horários livres'));

  // Em AWAITING_SLOT, cliente digita horário inválido "99"
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: '99' }));
  reply = sock.getLastText();
  assert.ok(reply.includes('Por favor, selecione um dos horários informados'), 'Deve avisar sobre horário inválido');
});

test('Complementar 10: Persistência correta e revogação posterior de lembretes', async () => {
  const sock = createMockSocket();
  const phone = '5511988880010';

  // Fluxo completo rápido
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Agendar corte feminino' }));
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: '1' })); // Jéssica Ramos
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: '1' })); // Primeiro horário
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Sim' })); // Confirmação
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Sim' })); // Aceita lembretes

  const row = db.prepare('SELECT id, reminder_consent, reminder_24h_status FROM appointments WHERE user_id = ? AND client_phone = ?').get(SALON_A.id, phone);
  assert.strictEqual(row.reminder_consent, 1);
  assert.strictEqual(row.reminder_24h_status, 'PENDING');

  // Cliente solicita revogação posterior
  sock.clear();
  await salonIncomingDispatcher.dispatchMessage(SALON_A.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Por favor, parar lembretes' }));
  const replyRevoke = sock.getLastText();
  assert.ok(replyRevoke.includes('cancelados com sucesso'), 'Deve acusar cancelamento de lembretes');

  const rowAfterRevoke = db.prepare('SELECT reminder_consent, reminder_24h_status FROM appointments WHERE id = ?').get(row.id);
  assert.strictEqual(rowAfterRevoke.reminder_consent, 0, 'Consentimento deve ter sido revogado');
  assert.strictEqual(rowAfterRevoke.reminder_24h_status, 'CANCELLED', 'Lembrete deve ter sido cancelado');
});
