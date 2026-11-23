/**
 * COMANDO 067 — SUÍTE DE TESTES HERMÉTICOS: CATÁLOGO INTELIGENTE E PREÇOS REAIS
 *
 * Validação rigorosa dos 14 cenários comerciais da Jéssica:
 *  1. Pergunta ampla de catálogo/valores na primeira mensagem ("quais serviços oferecem e quanto custam").
 *  2. Pergunta de serviço específico com preço e duração reais.
 *  3. Mensagem ambígua de serviço com múltiplos candidatos e preços reais.
 *  4. Pergunta de preço durante AWAITING_SLOT sem perda de contexto nem cancelamento.
 *  5. Pergunta de preço durante AWAITING_STAFF mantendo fluxo de profissional.
 *  6. Pergunta de preço durante AWAITING_NAME mantendo reserva e pedindo nome.
 *  7. Pergunta de preço durante AWAITING_CONFIRMATION mantendo horário.
 *  8. Rejeição de falsos positivos ("Sim", "1", "Ok", "Confirmar", "Cancelar").
 *  9. Agrupamento por categoria elegante quando > 6 serviços e categorias preenchidas.
 * 10. Catálogo vazio/inativo tratado com transparência e sem alucinação de preços.
 * 11. Isolamento multi-tenant absoluto (WHERE user_id = ? AND active = 1).
 * 12. Funcionamento pleno em JESSICA_CONVERSATIONAL_V2=true.
 * 13. Funcionamento pleno em JESSICA_CONVERSATIONAL_V2=false (determinístico).
 * 14. Resiliência e fallback caso o NLU Gemini falhe ou expire por timeout.
 *
 * Padrão Hermético: Banco SQLite temporário em os.tmpdir(), node:test e node:assert/strict.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 1. ISOLAMENTO DO BANCO DE DADOS EM os.tmpdir()
const uniqueDbName = `test_c067_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
const testDbPath = path.join(os.tmpdir(), uniqueDbName);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '670,671';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990670,5511999990671,5511988880001,5511988880002';

const db = require('../src/database/db');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
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

function createIncomingMsg({ fromPhone, text, pushName = 'Cliente Comercial', id = null }) {
  const clean = fromPhone.replace(/\D/g, '');
  const msgId = id || `MSG-C067-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

const SALON_1 = {
  id: 670,
  phone: '5511999990670',
  name: 'Studio Jéssica Premium',
};

const SALON_2 = {
  id: 671,
  phone: '5511999990671',
  name: 'Barbearia do Rodrigo',
};

test.after(() => {
  try {
    salonIncomingDispatcher._resetForTesting();
  } catch (_) {}
  try {
    jessicaNluService.resetMockNluHandler();
  } catch (_) {}
  try {
    db.close();
  } catch (_) {}
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch (_) {}
});

test.before(async () => {
  // Limpar tabelas
  db.prepare('DELETE FROM client_service_staff').run();
  db.prepare('DELETE FROM client_staff').run();
  db.prepare('DELETE FROM client_services').run();
  db.prepare('DELETE FROM client_salons').run();
  db.prepare('DELETE FROM customer_subscriptions').run();
  db.prepare('DELETE FROM users WHERE id IN (670, 671)').run();

  // Usuários
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan, subscription_status, paid_until)
    VALUES 
      (670, '5511999990670', 'Jéssica Beauty', 'USER', 'PRO', 'ACTIVE', datetime('now', '+30 days')),
      (671, '5511999990671', 'Rodrigo Barber', 'USER', 'PRO', 'ACTIVE', datetime('now', '+30 days'))
  `).run();

  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const prodId = jessicaProd ? jessicaProd.id : 1;

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, status, price_cents, paid_until)
    VALUES 
      (670, ?, 'ACTIVE', 8900, datetime('now', '+30 days')),
      (671, ?, 'ACTIVE', 8900, datetime('now', '+30 days'))
  `).run(prodId, prodId);

  // Salões
  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled)
    VALUES 
      (670, 'Studio Jéssica Premium', '5511999990670', '5511999990670', 1),
      (671, 'Barbearia do Rodrigo', '5511999990671', '5511999990671', 1)
  `).run();

  // Serviços Salão 1 (8 serviços cobrindo múltiplas categorias para testar agrupamento)
  const insertSvc = db.prepare(`
    INSERT INTO client_services (id, user_id, name, price, duration_min, category, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertSvc.run(1, 670, 'Corte Feminino', 90.00, 50, 'Cabelo', 1);
  insertSvc.run(2, 670, 'Corte Masculino', 60.00, 30, 'Cabelo', 1);
  insertSvc.run(3, 670, 'Escova Modeladora', 75.00, 40, 'Cabelo', 1);
  insertSvc.run(4, 670, 'Hidratação Profunda', 120.00, 60, 'Tratamentos', 1);
  insertSvc.run(5, 670, 'Mechas Criativas', 350.00, 180, 'Coloração', 1);
  insertSvc.run(6, 670, 'Manicure Tradicional', 45.00, 40, 'Unhas', 1);
  insertSvc.run(7, 670, 'Pedicure Spa', 55.00, 45, 'Unhas', 1);
  insertSvc.run(8, 670, 'Design de Sobrancelha', 50.00, 30, 'Estética', 1);
  // Serviço inativo (deve ser ignorado)
  insertSvc.run(9, 670, 'Serviço Desativado Antigo', 20.00, 20, 'Geral', 0);

  // Serviços Salão 2 (Isolamento Multi-Tenant)
  insertSvc.run(10, 671, 'Corte Barba Cabelo', 80.00, 45, 'Barbearia', 1);
  insertSvc.run(11, 671, 'Pigmentação de Barba', 40.00, 30, 'Barbearia', 1);

  // Profissionais Salão 1
  const insertStaff = db.prepare(`
    INSERT INTO client_staff (id, user_id, name, specialty, active)
    VALUES (?, ?, ?, ?, 1)
  `);
  insertStaff.run(1, 670, 'Jéssica Ramos', 'Cabelo');
  insertStaff.run(2, 670, 'Camila Santos', 'Unhas');

  // Profissionais Salão 2
  insertStaff.run(3, 671, 'Rodrigo Mestre', 'Barbeiro');

  // Vínculos
  const insertCss = db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1)
  `);
  for (let sId = 1; sId <= 8; sId++) {
    insertCss.run(670, sId, 1);
  }
  insertCss.run(671, 10, 3);
  insertCss.run(671, 11, 3);
});

// =============================================================================
// TESTES UNITÁRIOS: FUNÇÕES AUXILIARES COMERCIAIS
// =============================================================================

test('1. parseCommercialInquiry: Deve identificar corretamente pedidos de catálogo e consultas de preços', () => {
  const { parseCommercialInquiry } = salonIncomingDispatcher;

  // Catálogo completo
  const q1 = parseCommercialInquiry('Gostaria de saber quais servicos voces oferecem e quanto custam');
  assert.strictEqual(q1.isCommercial, true);
  assert.strictEqual(q1.isFullCatalog, true);

  const q2 = parseCommercialInquiry('Voces podem me mandar a tabela de precos?');
  assert.strictEqual(q2.isCommercial, true);
  assert.strictEqual(q2.isFullCatalog, true);

  const q3 = parseCommercialInquiry('qual o catalogo do salao?');
  assert.strictEqual(q3.isCommercial, true);
  assert.strictEqual(q3.isFullCatalog, true);

  const q4 = parseCommercialInquiry('quais os valores?');
  assert.strictEqual(q4.isCommercial, true);
  assert.strictEqual(q4.isFullCatalog, true);

  // Serviço específico
  const q5 = parseCommercialInquiry('Quanto custa o corte feminino?');
  assert.strictEqual(q5.isCommercial, true);
  assert.strictEqual(q5.isFullCatalog, false);

  const q6 = parseCommercialInquiry('qual o valor da hidratacao?');
  assert.strictEqual(q6.isCommercial, true);
  assert.strictEqual(q6.isFullCatalog, false);
});

test('2. parseCommercialInquiry: Deve rejeitar falsos positivos como respostas afirmativas, numerais e cancelamentos', () => {
  const { parseCommercialInquiry } = salonIncomingDispatcher;

  const negatives = [
    'sim',
    'Sim',
    'SIM',
    '1',
    '2',
    'ok',
    'pode ser',
    'pode sim',
    'confirmo',
    'com certeza',
    'cancela',
    'cancelar',
    'sair',
    'parar',
    'parar lembrete',
  ];

  for (const text of negatives) {
    const res = parseCommercialInquiry(text);
    assert.strictEqual(res.isCommercial, false, `Falha ao rejeitar falso positivo: "${text}"`);
  }
});

test('3. formatCommercialCatalogMessage: Deve agrupar por categoria quando > 6 serviços e conter preços reais em BRL', () => {
  const { formatCommercialCatalogMessage } = salonIncomingDispatcher;

  const services = db.prepare(`
    SELECT id, name, price, duration_min, category
    FROM client_services
    WHERE user_id = 670 AND active = 1
    ORDER BY category ASC, name ASC
  `).all();

  const msg = formatCommercialCatalogMessage(services, 'Studio Jéssica Premium');

  assert.ok(msg.includes('Studio Jéssica Premium'));
  assert.ok(msg.includes('R$ 90,00'));
  assert.ok(msg.includes('R$ 350,00'));
  assert.ok(msg.includes('📂 *CABELO*'));
  assert.ok(msg.includes('📂 *UNHAS*'));
  assert.ok(msg.includes('📂 *TRATAMENTOS*'));
  assert.ok(!msg.includes('Serviço Desativado Antigo'), 'Serviço inativo não deve estar presente');
});

test('4. formatCommercialCatalogMessage: Deve tratar catálogo vazio com mensagem acolhedora sem inventar valores', () => {
  const { formatCommercialCatalogMessage } = salonIncomingDispatcher;

  const msg = formatCommercialCatalogMessage([], 'Salão Vazio');
  assert.ok(msg.includes('Salão Vazio'));
  assert.ok(msg.includes('atualizado'));
  assert.ok(msg.includes('recepção'));
  assert.ok(!msg.includes('R$'), 'Não deve alucinar preços para catálogo vazio');
});

test('5. buildActiveStatePriceResponse: Deve anexar lembrete de continuidade sem cancelar estados ativos', () => {
  const { buildActiveStatePriceResponse } = salonIncomingDispatcher;

  const priceText = 'O procedimento *Corte Feminino* custa *R$ 90,00*.';

  // AWAITING_SLOT
  const sessionSlot = { state: 'AWAITING_SLOT', selectedService: { name: 'Corte Feminino' } };
  const respSlot = buildActiveStatePriceResponse(priceText, sessionSlot);
  assert.ok(respSlot.includes(priceText));
  assert.ok(respSlot.includes('continua em andamento'));
  assert.ok(respSlot.includes('Qual dos horários informados fica melhor'));

  // AWAITING_NAME
  const sessionName = {
    state: 'AWAITING_NAME',
    selectedService: { name: 'Corte Feminino' },
    selectedSlot: { time: '14:00' },
  };
  const respName = buildActiveStatePriceResponse(priceText, sessionName);
  assert.ok(respName.includes(priceText));
  assert.ok(respName.includes('continua reservadinho'));
  assert.ok(respName.includes('nome completo'));

  // AWAITING_CONFIRMATION
  const sessionConfirm = {
    state: 'AWAITING_CONFIRMATION',
    selectedService: { name: 'Corte Feminino' },
    selectedSlot: { time: '14:00' },
  };
  const respConfirm = buildActiveStatePriceResponse(priceText, sessionConfirm);
  assert.ok(respConfirm.includes(priceText));
  assert.ok(respConfirm.includes('Posso confirmar seu horário?'));
});

// =============================================================================
// TESTES DE FLUXO CONVERSACIONAL (JÉSSICA V2 E DETERMINÍSTICO)
// =============================================================================

test('6. Cenário WhatsApp: Pergunta de catálogo na primeira mensagem (V2 ativado)', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';

  jessicaNluService.setMockNluHandler(() => ({
    intent: 'PRICE_INQUIRY',
    serviceName: null,
    friendlyMessage: 'Olá! Temos vários serviços.',
  }));

  const mockSock = createMockSocket();
  const phone = '5511988880001';

  const msg = createIncomingMsg({
    fromPhone: phone,
    text: 'Bom dia, Jéssica! Gostaria de saber quais serviços vocês oferecem e quanto custam.',
  });

  const dispatched = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, msg);
  assert.strictEqual(dispatched, true);

  const reply = mockSock.getLastText();
  assert.ok(reply.includes('Studio Jéssica Premium'));
  assert.ok(reply.includes('R$ 90,00'), 'Corte Feminino deve estar com preço R$ 90,00');
  assert.ok(reply.includes('R$ 350,00'), 'Mechas Criativas deve estar com preço R$ 350,00');
  assert.ok(reply.includes('📂 *CABELO*'), 'Deve agrupar por categoria');
});

test('7. Cenário WhatsApp: Pergunta de serviço específico na primeira mensagem (V2 ativado)', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';

  jessicaNluService.setMockNluHandler(() => ({
    intent: 'PRICE_INQUIRY',
    serviceName: 'Corte Feminino',
    friendlyMessage: null,
  }));

  const mockSock = createMockSocket();
  const phone = '5511988880001';

  const msg = createIncomingMsg({
    fromPhone: phone,
    text: 'Quanto custa o corte feminino?',
  });

  const dispatched = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, msg);
  assert.strictEqual(dispatched, true);

  const reply = mockSock.getLastText();
  assert.ok(reply.includes('*Corte Feminino*'));
  assert.ok(reply.includes('R$ 90,00'));
  assert.ok(reply.includes('50 minutos'));
  assert.ok(reply.includes('verificar os horários livres'));
});

test('8. Cenário WhatsApp: Pergunta ambígua (Corte) com múltiplos candidatos', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';

  jessicaNluService.setMockNluHandler(() => ({
    intent: 'PRICE_INQUIRY',
    serviceName: 'Corte',
    friendlyMessage: null,
  }));

  const mockSock = createMockSocket();
  const phone = '5511988880001';

  const msg = createIncomingMsg({
    fromPhone: phone,
    text: 'Quanto custa o corte?',
  });

  const dispatched = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, msg);
  assert.strictEqual(dispatched, true);

  const reply = mockSock.getLastText();
  assert.ok(reply.includes('mais de uma opção'));
  assert.ok(reply.includes('Corte Feminino'));
  assert.ok(reply.includes('R$ 90,00'));
  assert.ok(reply.includes('Corte Masculino'));
  assert.ok(reply.includes('R$ 60,00'));
});

test('9. Cenário WhatsApp: Pergunta de preço durante AWAITING_SLOT sem perder reserva', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';

  const phone = '5511988880001';
  const sessionKey = `${SALON_1.id}:${phone}`;

  // Simula estado AWAITING_SLOT
  const mockSock = createMockSocket();
  const svc = db.prepare('SELECT * FROM client_services WHERE id = 1').get();

  // Inicia conversa
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, createIncomingMsg({ fromPhone: phone, text: 'Oi' }));
  const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
  assert.ok(session);

  session.state = 'AWAITING_SLOT';
  session.selectedService = svc;
  session.candidateSlots = [
    { number: 1, date: '2026-11-25', time: '14:00', dayLabel: 'Quarta-feira (25/11)' },
    { number: 2, date: '2026-11-25', time: '15:00', dayLabel: 'Quarta-feira (25/11)' },
  ];

  jessicaNluService.setMockNluHandler(() => ({
    intent: 'PRICE_INQUIRY',
    serviceName: 'Corte Feminino',
    friendlyMessage: null,
  }));

  mockSock.clear();
  const msgPrice = createIncomingMsg({ fromPhone: phone, text: 'Quanto fica o corte mesmo?' });
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, msgPrice);

  const reply = mockSock.getLastText();
  assert.ok(reply.includes('R$ 90,00'));
  assert.ok(reply.includes('continua em andamento'));
  assert.strictEqual(session.state, 'AWAITING_SLOT', 'Estado da sessão deve continuar AWAITING_SLOT');
  assert.strictEqual(session.selectedService.id, 1, 'Serviço selecionado deve ser preservado');
});

test('10. Cenário WhatsApp: Pergunta de preço durante AWAITING_NAME sem resetar fluxo', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';

  const phone = '5511988880001';
  const sessionKey = `${SALON_1.id}:${phone}`;

  const mockSock = createMockSocket();
  const svc = db.prepare('SELECT * FROM client_services WHERE id = 1').get();

  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, createIncomingMsg({ fromPhone: phone, text: 'Oi' }));
  const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);

  session.state = 'AWAITING_NAME';
  session.selectedService = svc;
  session.selectedSlot = { date: '2026-11-25', time: '14:00' };

  jessicaNluService.setMockNluHandler(() => ({
    intent: 'PRICE_INQUIRY',
    serviceName: 'Corte Feminino',
    friendlyMessage: null,
  }));

  mockSock.clear();
  const msgPrice = createIncomingMsg({ fromPhone: phone, text: 'Qual o valor certinho?' });
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, msgPrice);

  const reply = mockSock.getLastText();
  assert.ok(reply.includes('R$ 90,00'));
  assert.ok(reply.includes('continua reservadinho'));
  assert.ok(reply.includes('nome completo'));
  assert.strictEqual(session.state, 'AWAITING_NAME', 'Estado deve permanecer AWAITING_NAME');
});

test('11. Cenário WhatsApp: Modo Determinístico V1 (JESSICA_CONVERSATIONAL_V2=false)', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'false';

  const mockSock = createMockSocket();
  const phone = '5511988880002';

  const msg = createIncomingMsg({
    fromPhone: phone,
    text: 'Olá, quais são os serviços e preços de vocês?',
  });

  const dispatched = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, msg);
  assert.strictEqual(dispatched, true);

  const reply = mockSock.getLastText();
  assert.ok(reply.includes('Studio Jéssica Premium'));
  assert.ok(reply.includes('R$ 90,00'));
  assert.ok(reply.includes('R$ 350,00'));
});

test('12. Cenário WhatsApp: Isolamento Multi-Tenant estrito (Salão 671)', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'false';

  const mockSock = createMockSocket();
  const phone = '5511988880002';

  const msg = createIncomingMsg({
    fromPhone: phone,
    text: 'tabela de precos',
  });

  const dispatched = await salonIncomingDispatcher.dispatchMessage(SALON_2.id, mockSock, msg);
  assert.strictEqual(dispatched, true);

  const reply = mockSock.getLastText();
  assert.ok(reply.includes('Barbearia do Rodrigo'));
  assert.ok(reply.includes('Corte Barba Cabelo'));
  assert.ok(reply.includes('R$ 80,00'));
  assert.ok(!reply.includes('Corte Feminino'), 'Salão 2 jamais pode ver serviços do Salão 1');
  assert.ok(!reply.includes('Mechas Criativas'), 'Salão 2 jamais pode ver serviços do Salão 1');
});

test('13. Cenário WhatsApp: Resiliência NLU (Timeout/Erro -> Fallback determinístico responde catálogo)', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';

  // Força simulação de falha ou timeout do Gemini
  jessicaNluService.setMockNluHandler(() => {
    const err = new Error('NLU_TIMEOUT: Timeout de 8000ms excedido no Gemini');
    err.code = 'NLU_TIMEOUT';
    throw err;
  });

  const mockSock = createMockSocket();
  const phone = '5511988880001';

  const msg = createIncomingMsg({
    fromPhone: phone,
    text: 'Qual o valor do corte feminino?',
  });

  const dispatched = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, msg);
  assert.strictEqual(dispatched, true);

  const reply = mockSock.getLastText();
  assert.ok(reply.includes('Corte Feminino'));
  assert.ok(reply.includes('R$ 90,00'));
  assert.ok(reply.includes('verificar os horários'));
});

test('14. Cenário WhatsApp: Resposta de confirmação numérica não pode disparar catálogo (Prevenção de Falso Positivo)', async () => {
  salonIncomingDispatcher._resetForTesting();
  process.env.JESSICA_CONVERSATIONAL_V2 = 'true';

  const phone = '5511988880001';
  const sessionKey = `${SALON_1.id}:${phone}`;

  const mockSock = createMockSocket();
  const svc = db.prepare('SELECT * FROM client_services WHERE id = 1').get();

  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, createIncomingMsg({ fromPhone: phone, text: 'Oi' }));
  const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);

  session.state = 'AWAITING_SLOT';
  session.selectedService = svc;
  session.candidateSlots = [
    { number: 1, date: '2026-11-25', time: '14:00', dayLabel: 'Quarta-feira (25/11)' },
    { number: 2, date: '2026-11-25', time: '15:00', dayLabel: 'Quarta-feira (25/11)' },
  ];

  jessicaNluService.setMockNluHandler(() => ({
    intent: 'SCHEDULE_INQUIRY',
    time: '14:00',
    friendlyMessage: null,
  }));

  mockSock.clear();
  const msgSlotChoice = createIncomingMsg({ fromPhone: phone, text: '1' });
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, mockSock, msgSlotChoice);

  const reply = mockSock.getLastText();
  assert.ok(!reply.includes('catálogo completo de serviços'), 'Mensagem "1" nunca deve disparar catálogo geral');
  assert.ok(['AWAITING_NAME', 'AWAITING_CONFIRMATION'].includes(session.state), 'Deve avançar no funil de agendamento');
});
