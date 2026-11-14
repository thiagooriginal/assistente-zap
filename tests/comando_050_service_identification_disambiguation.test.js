/**
 * COMANDO 050 — Suíte de Testes Automatizados de Identificação e Desambiguação de Serviços
 * 
 * Módulos nativos: node:test e node:assert/strict
 * Exercita o dispatcher real: src/whatsapp/salonIncomingDispatcher.js
 * Banco isolado temporário em os.tmpdir()
 * Socket Baileys simulado com captura de mensagens
 * Whitelist mockada com fail-closed
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 1. ISOLAMENTO MANDATÓRIO DE BANCO DE DADOS EM os.tmpdir()
const uniqueDbName = `test-c050-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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

// Interceptar verificação de transporte Baileys para o mock do teste
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

function createIncomingMsg({ fromPhone, text, pushName = 'Cliente Teste C050', id = null }) {
  const clean = fromPhone.replace(/\D/g, '');
  const msgId = id || `MSG-C050-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  id: 501,
  phone: '5511999990501',
  name: 'Espaço Harmonia & Beleza',
};

let serviceCorteFemId;
let serviceCorteMascId;
let serviceManicureId;
let staffCamilaId;
let staffJessicaId;
let staffRafaelId;

test.before(async () => {
  // 1. Criar Salão do Teste C050
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan_tier, subscription_status, session_token, session_expires_at)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 'ACTIVE', 'token_501', datetime('now', '+30 days'))
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

  // 2. Criar Serviços do Cenário C050:
  // - "Corte Feminino em Camadas" (R$ 90,00, 60 min)
  const svcF = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Corte Feminino em Camadas', 60, 90.00, 1, 'cabelo')
  `).run(SALON.id);
  serviceCorteFemId = svcF.lastInsertRowid;

  // - "Corte Masculino Fade / Degradê" (R$ 55,00, 45 min)
  const svcM = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Corte Masculino Fade / Degradê', 45, 55.00, 1, 'cabelo')
  `).run(SALON.id);
  serviceCorteMascId = svcM.lastInsertRowid;

  // - "Manicure Tradicional" (R$ 35,00, 40 min)
  const svcE = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Manicure Tradicional', 40, 35.00, 1, 'unhas')
  `).run(SALON.id);
  serviceManicureId = svcE.lastInsertRowid;

  // 3. Criar Profissionais:
  // Camila Santos
  const st1 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Camila Santos', 1)
  `).run(SALON.id);
  staffCamilaId = st1.lastInsertRowid;

  // Jéssica Ramos
  const st2 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Jéssica Ramos', 1)
  `).run(SALON.id);
  staffJessicaId = st2.lastInsertRowid;

  // Rafael Costa
  const st3 = db.prepare(`
    INSERT INTO client_staff (user_id, name, active)
    VALUES (?, 'Rafael Costa', 1)
  `).run(SALON.id);
  staffRafaelId = st3.lastInsertRowid;

  // 4. Habilitar Vínculos N:N (client_service_staff):
  // - "Corte Feminino em Camadas": Camila Santos e Jéssica Ramos
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1), (?, ?, ?, 1)
  `).run(SALON.id, serviceCorteFemId, staffCamilaId, SALON.id, serviceCorteFemId, staffJessicaId);

  // - "Corte Masculino Fade / Degradê": Rafael Costa
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1)
  `).run(SALON.id, serviceCorteMascId, staffRafaelId);

  // - "Manicure Tradicional": Camila Santos
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1)
  `).run(SALON.id, serviceManicureId, staffCamilaId);
});

test.after(async () => {
  try {
    if (typeof db.close === 'function') db.close();
  } catch (_) {}

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
// CENÁRIO 1: Reprodução do Problema Real e Validação da Correção
// ============================================================================
test('Cenário 1: Entrada genérica "Oi gostaria de agendar um corte" gera desambiguação sem atribuição prematura', async () => {
  const sock = createMockSocket();
  const phone = '5511988881001';

  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({
    fromPhone: phone,
    text: 'Oi gostaria de agendar um corte',
  }));

  const reply = sock.getLastText();

  // a) Não atribui profissional prematuramente
  assert.ok(!reply.includes('com Camila Santos'), 'NÃO pode atribuir Camila Santos prematuramente');
  assert.ok(!reply.includes('com Jéssica Ramos'), 'NÃO pode atribuir Jéssica Ramos prematuramente');
  assert.ok(!reply.includes('com Rafael Costa'), 'NÃO pode atribuir Rafael Costa prematuramente');

  // b) Não oferece horários de imediato
  assert.ok(!reply.includes('horários disponíveis:'), 'NÃO pode listar horários de imediato');
  assert.ok(!reply.includes('horários livres:'), 'NÃO pode listar horários livres');

  // c) Responde solicitando esclarecimento e enumerando as duas opções de corte com valores e durações
  assert.ok(reply.includes('Identifiquei mais de uma opção correspondente ao seu pedido'), 'Deve solicitar esclarecimento amigável');
  assert.ok(reply.includes('Corte Feminino em Camadas'), 'Deve listar a opção feminina');
  assert.ok(reply.includes('90,00'), 'Deve exibir o valor R$ 90,00');
  assert.ok(reply.includes('60 min'), 'Deve exibir a duração de 60 min');

  assert.ok(reply.includes('Corte Masculino Fade / Degradê'), 'Deve listar a opção masculina');
  assert.ok(reply.includes('55,00'), 'Deve exibir o valor R$ 55,00');
  assert.ok(reply.includes('45 min'), 'Deve exibir a duração de 45 min');

  // Não deve listar manicure no grupo de cortes
  assert.ok(!reply.includes('Manicure Tradicional'), 'Manicure NÃO deve aparecer na desambiguação de corte');
});

// ============================================================================
// CENÁRIO 2: Desambiguação por Número
// ============================================================================
test('Cenário 2A: Desambiguação respondendo "1" seleciona Corte Feminino e transiciona para escolha de profissional', async () => {
  const sock = createMockSocket();
  const phone = '5511988881002';

  // 1. Mensagem inicial ambígua
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Oi gostaria de agendar um corte' }));
  
  // 2. Cliente responde "1"
  sock.clear();
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: '1' }));
  const reply = sock.getLastText();

  // Deve selecionar Corte Feminino e apresentar Camila Santos e Jéssica Ramos
  assert.ok(reply.includes('Corte Feminino em Camadas'), 'Deve acusar seleção do Corte Feminino');
  assert.ok(reply.includes('90,00'), 'Deve exibir o valor R$ 90,00');
  assert.ok(reply.includes('Camila Santos') && reply.includes('Jéssica Ramos'), 'Deve apresentar as profissionais habilitadas');
  assert.ok(reply.includes('Qualquer profissional disponível'), 'Deve incluir a opção genérica');
  assert.ok(!reply.includes('Rafael Costa'), 'Rafael Costa NÃO deve ser listado para corte feminino');
});

test('Cenário 2B: Desambiguação respondendo "2" seleciona Corte Masculino e oferece horários com Rafael Costa', async () => {
  const sock = createMockSocket();
  const phone = '5511988881003';

  // 1. Mensagem inicial ambígua
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Oi gostaria de agendar um corte' }));
  
  // 2. Cliente responde "2"
  sock.clear();
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: '2' }));
  const reply = sock.getLastText();

  // Corte Masculino tem apenas Rafael Costa habilitado: transiciona direto para horários
  assert.ok(reply.includes('Corte Masculino Fade / Degradê'), 'Deve acusar seleção do Corte Masculino');
  assert.ok(reply.includes('55,00'), 'Deve exibir o valor R$ 55,00');
  assert.ok(reply.includes('Rafael Costa'), 'Deve indicar o profissional exclusivo Rafael Costa');
  assert.ok(reply.includes('horários livres') || reply.includes('horários disponíveis'), 'Deve listar horários diretamente');
});

// ============================================================================
// CENÁRIO 3: Desambiguação por Nome / Qualificador
// ============================================================================
test('Cenário 3: Desambiguação respondendo "feminino" após menu seleciona Corte Feminino em Camadas', async () => {
  const sock = createMockSocket();
  const phone = '5511988881004';

  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Oi gostaria de agendar um corte' }));

  sock.clear();
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'feminino' }));
  const reply = sock.getLastText();

  assert.ok(reply.includes('Corte Feminino em Camadas'), 'Deve desambiguar pelo qualificador feminino');
  assert.ok(reply.includes('Camila Santos') && reply.includes('Jéssica Ramos'), 'Deve apresentar as profissionais');
});

// ============================================================================
// CENÁRIO 4: Mensagem Inicial Específica com Qualificador Feminino
// ============================================================================
test('Cenário 4: "Quero agendar um corte feminino" seleciona diretamente Corte Feminino (status EXACT)', async () => {
  const sock = createMockSocket();
  const phone = '5511988881005';

  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Quero agendar um corte feminino' }));
  const reply = sock.getLastText();

  assert.ok(reply.includes('Corte Feminino em Camadas'), 'Deve selecionar o corte feminino diretamente');
  assert.ok(!reply.includes('Identifiquei mais de uma opção'), 'NÃO deve entrar em estado ambíguo');
  assert.ok(reply.includes('Camila Santos') && reply.includes('Jéssica Ramos'), 'Deve solicitar a escolha da profissional');
});

// ============================================================================
// CENÁRIO 5: Mensagem Inicial Específica com Qualificador Masculino
// ============================================================================
test('Cenário 5: "Gostaria de marcar corte masculino" seleciona diretamente Corte Masculino com Rafael Costa', async () => {
  const sock = createMockSocket();
  const phone = '5511988881006';

  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Gostaria de marcar corte masculino' }));
  const reply = sock.getLastText();

  assert.ok(reply.includes('Corte Masculino Fade / Degradê'), 'Deve selecionar o corte masculino diretamente');
  assert.ok(!reply.includes('Identifiquei mais de uma opção'), 'NÃO deve entrar em estado ambíguo');
  assert.ok(reply.includes('Rafael Costa'), 'Deve atribuir Rafael Costa como profissional habilitado único');
  assert.ok(reply.includes('horários') && reply.includes('1.'), 'Deve oferecer horários disponíveis');
});

// ============================================================================
// CENÁRIO 6: Seleção de Serviço Único no Catálogo
// ============================================================================
test('Cenário 6: "Quero fazer manicure" seleciona diretamente Manicure Tradicional sem ambiguidade', async () => {
  const sock = createMockSocket();
  const phone = '5511988881007';

  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Quero fazer manicure' }));
  const reply = sock.getLastText();

  assert.ok(reply.includes('Manicure Tradicional'), 'Deve selecionar Manicure Tradicional');
  assert.ok(!reply.includes('Identifiquei mais de uma opção'), 'NÃO deve acusar ambiguidade');
  assert.ok(reply.includes('Camila Santos'), 'Deve atribuir Camila Santos (única habilitada para manicure)');
});

// ============================================================================
// CENÁRIO 7: Opção Numérica Inválida durante Desambiguação
// ============================================================================
test('Cenário 7: Opção numérica inválida "99" durante desambiguação mantém o estado e reapresenta opções', async () => {
  const sock = createMockSocket();
  const phone = '5511988881008';

  // 1. Inicia ambiguidade
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Oi gostaria de agendar um corte' }));

  // 2. Cliente digita "99"
  sock.clear();
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: '99' }));
  const reply = sock.getLastText();

  assert.ok(reply.includes('Não consegui identificar o serviço desejado'), 'Deve acusar não identificação');
  assert.ok(reply.includes('Corte Feminino em Camadas') && reply.includes('Corte Masculino Fade / Degradê'), 'Deve reapresentar as opções de corte');

  // 3. Em seguida, digita "1" válido e recupera o fluxo normalmente
  sock.clear();
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: '1' }));
  const replyValid = sock.getLastText();
  assert.ok(replyValid.includes('Corte Feminino em Camadas'), 'Deve recuperar e selecionar a opção 1 com sucesso');
});

// ============================================================================
// CENÁRIO 8: Cancelamento durante a Desambiguação
// ============================================================================
test('Cenário 8: Cancelamento durante a desambiguação encerra o fluxo e não cria agendamento', async () => {
  const sock = createMockSocket();
  const phone = '5511988881009';

  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Oi gostaria de agendar um corte' }));

  sock.clear();
  await salonIncomingDispatcher.dispatchMessage(SALON.id, sock, createIncomingMsg({ fromPhone: phone, text: 'Cancelar' }));
  const reply = sock.getLastText();

  assert.ok(reply.includes('O agendamento foi cancelado'), 'Deve confirmar o cancelamento');

  // Verificar ausência no banco
  const count = db.prepare('SELECT COUNT(*) as total FROM appointments WHERE user_id = ? AND client_phone = ?').get(SALON.id, phone);
  assert.strictEqual(count.total, 0, 'Nenhum agendamento deve ser gravado no banco');
});

// ============================================================================
// CENÁRIO 9: Testes Unitários de resolveServiceMatch
// ============================================================================
test('Cenário 9.1: Clamp de segurança corta strings > 150 caracteres e previne ReDoS', () => {
  const services = [
    { id: 1, name: 'Corte Feminino em Camadas', category: 'cabelo', price: 90, duration_min: 60 },
    { id: 2, name: 'Corte Masculino Fade / Degradê', category: 'cabelo', price: 55, duration_min: 45 },
  ];

  // String excessivamente longa (> 500 caracteres com repetições)
  const longPayload = 'gostaria de agendar um corte feminino ' + 'a'.repeat(400);
  const start = Date.now();
  const resLong = salonIncomingDispatcher.resolveServiceMatch(services, longPayload);
  const duration = Date.now() - start;

  assert.ok(duration < 50, `Execução deve ser instantânea (levou ${duration}ms)`);
  assert.strictEqual(resLong.status, 'EXACT');
  assert.strictEqual(resLong.match.id, 1);

  // String com carga maliciosa de regex / pontuação excessiva
  const regexPayload = 'corte (.*)+ (a+)+ (b+)+ ' + '!'.repeat(200);
  const resRegex = salonIncomingDispatcher.resolveServiceMatch(services, regexPayload);
  assert.ok(resRegex.status === 'AMBIGUOUS' || resRegex.status === 'NONE');
});

test('Cenário 9.2: Entrada inválida ou serviço inexistente retorna status NONE', () => {
  const services = [
    { id: 1, name: 'Corte Feminino em Camadas', category: 'cabelo', price: 90, duration_min: 60 },
  ];

  assert.strictEqual(salonIncomingDispatcher.resolveServiceMatch(services, 'quero aula de pilates').status, 'NONE');
  assert.strictEqual(salonIncomingDispatcher.resolveServiceMatch(services, '').status, 'NONE');
  assert.strictEqual(salonIncomingDispatcher.resolveServiceMatch(services, null).status, 'NONE');
  assert.strictEqual(salonIncomingDispatcher.resolveServiceMatch(services, undefined).status, 'NONE');
  assert.strictEqual(salonIncomingDispatcher.resolveServiceMatch([], 'corte').status, 'NONE');
  assert.strictEqual(salonIncomingDispatcher.resolveServiceMatch(null, 'corte').status, 'NONE');
});

test('Cenário 9.3: Termo genérico "corte" retorna status AMBIGUOUS com a lista exata de candidatos', () => {
  const services = [
    { id: 1, name: 'Corte Feminino em Camadas', category: 'cabelo', price: 90, duration_min: 60 },
    { id: 2, name: 'Corte Masculino Fade / Degradê', category: 'cabelo', price: 55, duration_min: 45 },
    { id: 3, name: 'Manicure Tradicional', category: 'unhas', price: 35, duration_min: 40 },
  ];

  const res = salonIncomingDispatcher.resolveServiceMatch(services, 'Gostaria de agendar um corte');
  assert.strictEqual(res.status, 'AMBIGUOUS');
  assert.strictEqual(res.candidates.length, 2);
  assert.deepStrictEqual(res.candidates.map((c) => c.id), [1, 2]);
});

test('Cenário 9.4: Precedência de índice numérico respeita limites de scopedCandidates', () => {
  const scoped = [
    { id: 1, name: 'Corte Feminino em Camadas', category: 'cabelo', price: 90, duration_min: 60 },
    { id: 2, name: 'Corte Masculino Fade / Degradê', category: 'cabelo', price: 55, duration_min: 45 },
  ];
  const allServices = [...scoped, { id: 3, name: 'Manicure Tradicional', category: 'unhas', price: 35, duration_min: 40 }];

  // "1" dentro dos limites de scoped
  const res1 = salonIncomingDispatcher.resolveServiceMatch(allServices, '1', scoped);
  assert.strictEqual(res1.status, 'EXACT');
  assert.strictEqual(res1.match.id, 1);

  // "2" dentro dos limites de scoped
  const res2 = salonIncomingDispatcher.resolveServiceMatch(allServices, '2', scoped);
  assert.strictEqual(res2.status, 'EXACT');
  assert.strictEqual(res2.match.id, 2);

  // "3" fora dos limites de scoped (mesmo existindo no catálogo geral)
  const res3 = salonIncomingDispatcher.resolveServiceMatch(allServices, '3', scoped);
  assert.strictEqual(res3.status, 'NONE');

  // "0" ou negativos
  assert.strictEqual(salonIncomingDispatcher.resolveServiceMatch(allServices, '0', scoped).status, 'NONE');
});
