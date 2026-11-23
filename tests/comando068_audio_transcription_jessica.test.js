/**
 * COMANDO 068 — SUÍTE DE TESTES HERMÉTICOS: RECEPÇÃO DE ÁUDIO NO WHATSAPP E TRANSCRIÇÃO INTELIGENTE
 *
 * Validação rigorosa dos 13 cenários mandatários do Módulo Jéssica:
 *  1. Áudio pedindo tabela de preços (resposta com catálogo e preços reais).
 *  2. Áudio solicitando agendamento (avanço para seleção de horário/data).
 *  3. Áudio escolhendo um horário (associação de slot livre e solicitação de nome).
 *  4. Áudio confirmando uma reserva (registro no SQLite com origin 'whatsapp_audio').
 *  5. Áudio com conteúdo incompreensível (fallback amigável e acolhedor).
 *  6. Falha ou timeout da transcrição (fallback amigável e acolhedor).
 *  7. Áudio com duração excessiva (> 120s) ou tamanho (> 5MB) (rejeição pré-download).
 *  8. Remetente não autorizado na whitelist (descarte silencioso pré-download).
 *  9. Isolamento multi-tenant (áudio do salão A não acessa salão B).
 * 10. Mensagens duplicadas / Idempotência (bloqueio por processed_messages).
 * 11. Preservação do contexto conversacional (alternância fluida áudio <-> texto).
 * 12. Regressão de mensagens de texto (100% funcionais).
 * 13. Feature Flag inativa (JESSICA_AUDIO_ENABLED != 'true' -> descarte silencioso).
 *
 * Padrão Hermético: Banco SQLite descartável em os.tmpdir(), node:test e node:assert/strict.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 1. ISOLAMENTO DO BANCO DE DADOS EM os.tmpdir()
const uniqueDbName = `test_c068_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
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
process.env.SALON_TEST_ALLOWED_TENANTS = '680,681';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990680,5511999990681,5511988880001,5511988880002';
process.env.JESSICA_AUDIO_ENABLED = 'true';

const db = require('../src/database/db');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const jessicaAudioService = require('../src/services/jessicaAudioService');
const jessicaNluService = require('../src/services/jessicaNluService');

// Configuração do Mock de Whitelist
salonSessionManager.isSalonRealWhatsAppAllowed = (uid, phone) => {
  if (phone === '5511977777777') return false; // Telefone propositalmente não autorizado
  return true;
};

// Mock de Download em Memória
let mockDownloadBuffer = Buffer.from('TEST_AUDIO_BYTES_OPUS');
let downloadMediaMessageCalled = false;
let mockDownloadError = null;

function setupMediaDownloadMock() {
  salonIncomingDispatcher.setMockDownloadMediaHandler(async () => {
    downloadMediaMessageCalled = true;
    if (mockDownloadError) {
      throw mockDownloadError;
    }
    return mockDownloadBuffer;
  });
}

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

function createIncomingAudioMsg({
  fromPhone,
  seconds = 15,
  fileLength = 30000,
  mimetype = 'audio/ogg; codecs=opus',
  id = null,
  pushName = 'Cliente Voz',
}) {
  const clean = fromPhone.replace(/\D/g, '');
  const msgId = id || `MSG-AUDIO-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    key: {
      remoteJid: `${clean}@s.whatsapp.net`,
      fromMe: false,
      id: msgId,
    },
    pushName,
    message: {
      audioMessage: {
        mimetype,
        seconds,
        fileLength,
      },
    },
  };
}

function createIncomingTextMsg({ fromPhone, text, pushName = 'Cliente Texto', id = null }) {
  const clean = fromPhone.replace(/\D/g, '');
  const msgId = id || `MSG-TEXT-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  id: 680,
  phone: '5511999990680',
  name: 'Studio Jéssica Voice',
};

const SALON_2 = {
  id: 681,
  phone: '5511999990681',
  name: 'Barbearia do Rodrigo Voice',
};

test.before(async () => {
  assert.ok(fs.existsSync(testDbPath), 'Banco de teste temporário deve existir');

  // Criar usuários com status e paid_until ativos
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, subscription_status, paid_until)
    VALUES 
      (?, ?, ?, 'USER', 'PRO', 'ACTIVE', datetime('now', '+30 days')),
      (?, ?, ?, 'USER', 'PRO', 'ACTIVE', datetime('now', '+30 days'))
  `).run(SALON_1.id, SALON_1.phone, SALON_1.name, SALON_2.id, SALON_2.phone, SALON_2.name);

  // Descobrir ID do produto JESSICA
  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const prodId = jessicaProd ? jessicaProd.id : 1;

  // Criar assinatura de produto com paid_until no futuro
  db.prepare(`
    INSERT OR REPLACE INTO customer_subscriptions (user_id, product_id, status, price_cents, paid_until)
    VALUES 
      (?, ?, 'ACTIVE', 9900, datetime('now', '+30 days')),
      (?, ?, 'ACTIVE', 9900, datetime('now', '+30 days'))
  `).run(SALON_1.id, prodId, SALON_2.id, prodId);

  // Configurar salões
  db.prepare(`
    INSERT OR REPLACE INTO client_salons (id, user_id, salon_name, phone, opening_hours, whatsapp_notification_phone, whatsapp_notifications_enabled)
    VALUES 
      (?, ?, ?, ?, '09:00 - 19:00', ?, 1),
      (?, ?, ?, ?, '09:00 - 19:00', ?, 1)
  `).run(SALON_1.id, SALON_1.id, SALON_1.name, SALON_1.phone, SALON_1.phone, SALON_2.id, SALON_2.id, SALON_2.name, SALON_2.phone, SALON_2.phone);

  // Serviços Salão 1
  db.prepare(`
    INSERT OR REPLACE INTO client_services (id, user_id, name, price, duration_min, category, active)
    VALUES
      (6801, 680, 'Corte Feminino', 90.00, 45, 'Cabelo', 1),
      (6802, 680, 'Escova Modelada', 60.00, 30, 'Cabelo', 1),
      (6803, 680, 'Manicure Tradicional', 35.00, 30, 'Unhas', 1)
  `).run();

  // Serviços Salão 2
  db.prepare(`
    INSERT OR REPLACE INTO client_services (id, user_id, name, price, duration_min, category, active)
    VALUES
      (6811, 681, 'Corte Degradê Navalhado', 50.00, 40, 'Barbearia', 1),
      (6812, 681, 'Barba Terapia Completa', 45.00, 30, 'Barbearia', 1)
  `).run();

  // Profissionais Salão 1
  db.prepare(`
    INSERT OR REPLACE INTO client_staff (id, user_id, name, specialty, active)
    VALUES (6801, 680, 'Jéssica Castro', 'Cabeleireira', 1)
  `).run();

  // Profissionais Salão 2
  db.prepare(`
    INSERT OR REPLACE INTO client_staff (id, user_id, name, specialty, active)
    VALUES (6811, 681, 'Rodrigo Barbeiro', 'Barbeiro Master', 1)
  `).run();

  // Vinculação de equipe aos serviços
  db.prepare(`
    INSERT OR REPLACE INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES
      (680, 6801, 6801, 1),
      (680, 6802, 6801, 1),
      (680, 6803, 6801, 1),
      (681, 6811, 6811, 1),
      (681, 6812, 6811, 1)
  `).run();
});

test.after(() => {
  try {
    salonIncomingDispatcher._resetForTesting();
    jessicaAudioService.resetMockAudioHandler();
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (_) {}
});

test('1. Áudio pedindo tabela de preços -> Jéssica transcreve e responde catálogo com valores reais', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  jessicaAudioService.setMockAudioHandler(async () => {
    return 'Olá Jéssica, gostaria de saber quais serviços vocês oferecem e quais os preços?';
  });

  const msg = createIncomingAudioMsg({ fromPhone: '5511988880001' });
  const processed = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msg);

  assert.strictEqual(processed, true, 'Mensagem de áudio deve ser processada');
  const reply = sock.getLastText();
  assert.ok(reply.includes('Corte Feminino'), 'Deve conter Corte Feminino');
  assert.ok(reply.includes('90,00'), 'Deve conter preço de R$ 90,00');
  assert.ok(reply.includes('Escova Modelada'), 'Deve conter Escova Modelada');
  assert.ok(reply.includes('60,00'), 'Deve conter preço de R$ 60,00');
  assert.ok(reply.includes('Manicure Tradicional'), 'Deve conter Manicure');
  assert.ok(reply.includes('35,00'), 'Deve conter preço de R$ 35,00');
});

test('2. Áudio solicitando agendamento -> Jéssica transcreve e avança para seleção de horários/data', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  jessicaAudioService.setMockAudioHandler(async () => {
    return 'Oi, queria agendar um corte feminino para amanhã';
  });

  const msg = createIncomingAudioMsg({ fromPhone: '5511988880001' });
  const processed = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msg);

  assert.strictEqual(processed, true);
  const reply = sock.getLastText();
  assert.ok(reply.includes('Corte Feminino'), 'Deve identificar o serviço solicitado');
  assert.ok(/hor[aá]rios?/i.test(reply), 'Deve oferecer horários ou perguntar preferências');
});

test('3. Áudio escolhendo um horário -> Jéssica transcreve, associa slot e pede nome', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  // Etapa 1: Iniciar agendamento por áudio especificando data
  jessicaAudioService.setMockAudioHandler(async () => 'Quero fazer escova modelada amanhã');
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, createIncomingAudioMsg({ fromPhone: '5511988880001' }));

  // Etapa 2: Escolher horário por áudio
  sock.clear();
  jessicaAudioService.setMockAudioHandler(async () => 'Pode ser às 10 horas');
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, createIncomingAudioMsg({ fromPhone: '5511988880001' }));

  const reply = sock.getLastText();
  assert.ok(
    reply.includes('nome') || reply.includes('confirmar') || reply.includes('Escova Modelada') || reply.includes('10:00'),
    'Deve reconhecer o horário e avançar o funil solicitando identificação ou confirmação'
  );
});

test('4. Áudio confirmando uma reserva -> Jéssica transcreve, confirma reserva no SQLite e emite origin whatsapp_audio', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  const testDate = new Date(Date.now() + 48 * 3600 * 1000).toISOString().split('T')[0];
  const svc = db.prepare('SELECT id, name, price, duration_min FROM client_services WHERE id = 6801').get();
  const staff = db.prepare('SELECT id, name FROM client_staff WHERE id = 6801').get();

  jessicaAudioService.setMockAudioHandler(async () => 'Sim, confirmo meu agendamento');

  // Enviar áudio inicial para registrar sessão
  const msgInit = createIncomingAudioMsg({ fromPhone: '5511988880001', pushName: 'Camila Ferreira' });
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msgInit);

  // Injetar estado AWAITING_CONFIRMATION na sessão
  const sess = salonIncomingDispatcher._getCustomerSessionForTesting(`680:5511988880001`);
  sess.state = 'AWAITING_CONFIRMATION';
  sess.customerName = 'Camila Ferreira';
  sess.selectedService = svc;
  sess.selectedStaff = staff;
  sess.selectedSlot = { date: testDate, time: '14:00' };
  sess.lastOrigin = 'whatsapp_audio';

  sock.clear();
  // Novo ID para a mensagem de confirmação (evitar bloqueio por idempotência)
  const msgConfirm = createIncomingAudioMsg({ fromPhone: '5511988880001', pushName: 'Camila Ferreira' });
  const processed = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msgConfirm);
  assert.strictEqual(processed, true);

  const reply = sock.getLastText();
  assert.ok(
    reply.includes('confirmado com sucesso') || reply.includes('Agendamento confirmado'),
    'Deve confirmar o agendamento'
  );

  // Verificar gravação no SQLite
  const apt = db.prepare(`
    SELECT * FROM appointments
    WHERE user_id = 680 AND client_name = 'Camila Ferreira'
    ORDER BY id DESC LIMIT 1
  `).get();

  assert.ok(apt, 'Agendamento deve ter sido gravado no SQLite');
  assert.strictEqual(apt.origin, 'whatsapp_audio', 'Origin deve ser gravado como whatsapp_audio');
});

test('5. Áudio com conteúdo incompreensível -> Transcrição retorna [ININTELIGIVEL] -> Fallback cordial', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  jessicaAudioService.setMockAudioHandler(async () => '[ININTELIGIVEL]');

  const msg = createIncomingAudioMsg({ fromPhone: '5511988880001' });
  const processed = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msg);

  assert.strictEqual(processed, true);
  const reply = sock.getLastText();
  assert.ok(
    reply.includes('Desculpa! 😊 Não consegui entender seu áudio desta vez'),
    'Deve responder com a mensagem acolhedora mandatória do Comando 068'
  );
  assert.ok(
    reply.includes('tentar enviar novamente ou me escrever o que precisa'),
    'Deve orientar o cliente a enviar novamente ou escrever'
  );
});

test('6. Falha ou timeout da transcrição -> Handler simula erro -> Fallback cordial', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  jessicaAudioService.setMockAudioHandler(async () => {
    throw new Error('AUDIO_TIMEOUT: Transcrição excedeu 10s');
  });

  const msg = createIncomingAudioMsg({ fromPhone: '5511988880001' });
  const processed = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msg);

  assert.strictEqual(processed, true);
  const reply = sock.getLastText();
  assert.ok(
    reply.includes('Desculpa! 😊 Não consegui entender seu áudio desta vez'),
    'Deve responder cordialmente mesmo sob falha técnica/timeout'
  );
});

test('7. Áudio com duração excessiva (> 120s) ou tamanho (> 5MB) -> Rejeição pré-download', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  downloadMediaMessageCalled = false;

  // 7.1 Duração excessiva: 150 segundos
  const msgLong = createIncomingAudioMsg({ fromPhone: '5511988880001', seconds: 150 });
  const processedLong = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msgLong);
  assert.strictEqual(processedLong, true);
  assert.ok(sock.getLastText().includes('longo para eu ouvir'), 'Deve informar que áudio é longo');
  assert.strictEqual(downloadMediaMessageCalled, false, 'NÃO deve baixar mídia para áudio longo');

  // 7.2 Tamanho excessivo: 6MB (6 * 1024 * 1024 bytes)
  sock.clear();
  downloadMediaMessageCalled = false;
  const msgLarge = createIncomingAudioMsg({ fromPhone: '5511988880001', fileLength: 6 * 1024 * 1024 });
  const processedLarge = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msgLarge);
  assert.strictEqual(processedLarge, true);
  assert.ok(sock.getLastText().includes('grande demais para eu ouvir'), 'Deve informar que áudio é grande');
  assert.strictEqual(downloadMediaMessageCalled, false, 'NÃO deve baixar mídia para áudio pesado');
});

test('8. Remetente não autorizado na whitelist -> Descarte silencioso pré-download', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();
  downloadMediaMessageCalled = false;

  // Telefone não cadastrado na whitelist (5511977777777)
  const msgUnauthorized = createIncomingAudioMsg({ fromPhone: '5511977777777' });
  const processed = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msgUnauthorized);

  assert.strictEqual(processed, false, 'Deve descartar silenciosamente');
  assert.strictEqual(sock.sentMessages.length, 0, 'Nenhuma mensagem deve ser enviada');
  assert.strictEqual(downloadMediaMessageCalled, false, 'Nenhum download de mídia deve ser efetuado');
});

test('9. Isolamento multi-tenant -> Áudio recebido no salão #680 não acessa dados do salão #681', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock1 = createMockSocket();
  const sock2 = createMockSocket();

  // No salão 1 (Studio Jéssica), cliente pede serviço da barbearia (Barba Terapia)
  jessicaAudioService.setMockAudioHandler(async () => 'Quanto custa a barba terapia completa?');
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock1, createIncomingAudioMsg({ fromPhone: '5511988880001' }));

  const reply1 = sock1.getLastText();
  assert.ok(!reply1.includes('Barbearia do Rodrigo'), 'Salão 1 jamais deve vazar nome do Salão 2');
  assert.ok(!reply1.includes('45,00'), 'Salão 1 jamais deve cotar preço da barbearia');

  // No salão 2 (Barbearia), o mesmo pedido deve funcionar
  jessicaAudioService.setMockAudioHandler(async () => 'Quanto custa a barba terapia completa?');
  await salonIncomingDispatcher.dispatchMessage(SALON_2.id, sock2, createIncomingAudioMsg({ fromPhone: '5511988880002' }));

  const reply2 = sock2.getLastText();
  assert.ok(reply2.includes('Barba Terapia Completa'), 'Salão 2 deve identificar seu próprio serviço');
  assert.ok(reply2.includes('45,00'), 'Salão 2 deve responder o seu preço de R$ 45,00');
});

test('10. Mensagens duplicadas / Idempotência -> Segunda mensagem com mesmo key.id é descartada', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  let transcriptionCount = 0;
  jessicaAudioService.setMockAudioHandler(async () => {
    transcriptionCount++;
    return 'Quero saber os valores';
  });

  const fixedId = 'MSG-IDEMPOTENT-068-TEST';
  const msg1 = createIncomingAudioMsg({ fromPhone: '5511988880001', id: fixedId });
  const msg2 = createIncomingAudioMsg({ fromPhone: '5511988880001', id: fixedId });

  const res1 = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msg1);
  assert.strictEqual(res1, true, 'Primeira mensagem deve ser processada');
  assert.strictEqual(transcriptionCount, 1, 'Deve transcrever 1 vez');

  const res2 = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msg2);
  assert.strictEqual(res2, false, 'Segunda mensagem duplicada deve ser descartada');
  assert.strictEqual(transcriptionCount, 1, 'NÃO deve transcrever novamente');
});

test('11. Preservação do contexto conversacional -> Alternância fluida entre áudio e texto', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  // Passo 1: Envia áudio escolhendo serviço
  jessicaAudioService.setMockAudioHandler(async () => 'Gostaria de agendar um corte feminino');
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, createIncomingAudioMsg({ fromPhone: '5511988880001' }));

  const sess1 = salonIncomingDispatcher._getCustomerSessionForTesting(`680:5511988880001`);
  assert.ok(sess1.selectedService, 'Serviço deve estar selecionado na sessão');
  assert.strictEqual(sess1.selectedService.name, 'Corte Feminino');
  assert.strictEqual(sess1.lastOrigin, 'whatsapp_audio');

  // Passo 2: Responde por texto indicando preferência
  sock.clear();
  await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, createIncomingTextMsg({
    fromPhone: '5511988880001',
    text: 'Pode ser amanhã de manhã',
  }));

  const sess2 = salonIncomingDispatcher._getCustomerSessionForTesting(`680:5511988880001`);
  assert.strictEqual(sess2.selectedService.name, 'Corte Feminino', 'Contexto do serviço deve ser preservado');
  assert.strictEqual(sess2.lastOrigin, 'whatsapp_text', 'Origem da última mensagem atualizada para texto');
});

test('12. Regressão de mensagens de texto -> Continuam 100% funcionais sem efeito colateral', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  const msgText = createIncomingTextMsg({
    fromPhone: '5511988880001',
    text: 'Quais os preços dos serviços?',
  });

  const processed = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msgText);
  assert.strictEqual(processed, true);
  const reply = sock.getLastText();
  assert.ok(reply.includes('Corte Feminino'), 'Texto normal continua respondendo catálogo');
  assert.ok(reply.includes('90,00'));
});

test('13. Feature Flag inativa (JESSICA_AUDIO_ENABLED != true) -> Áudio é ignorado silenciosamente', async () => {
  salonIncomingDispatcher._resetForTesting();
  setupMediaDownloadMock();
  const sock = createMockSocket();

  const originalFlag = process.env.JESSICA_AUDIO_ENABLED;
  try {
    process.env.JESSICA_AUDIO_ENABLED = 'false';

    const msg = createIncomingAudioMsg({ fromPhone: '5511988880001' });
    const processed = await salonIncomingDispatcher.dispatchMessage(SALON_1.id, sock, msg);

    assert.strictEqual(processed, false, 'Com a flag desativada, áudios devem retornar false');
    assert.strictEqual(sock.sentMessages.length, 0, 'Nenhuma resposta deve ser emitida');
  } finally {
    process.env.JESSICA_AUDIO_ENABLED = originalFlag;
  }
});
