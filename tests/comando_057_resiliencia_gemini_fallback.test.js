/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS: COMANDO 057
 * Resiliência Conversacional Jéssica — Fallback Determinístico do Gemini
 *
 * Padrão Hermético Obrigatório:
 * - Banco SQLite temporário e descartável em os.tmpdir() (DatabaseSync)
 * - Módulos nativos node:test e node:assert/strict (Node.js 22)
 * - Mocks fail-closed locais para IA e WhatsApp (sem chamadas externas de rede)
 * - Zero conexão ou interferência em data/assistant.db
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// 1. Configuração Hermética de Ambiente e Banco Temporário em os.tmpdir()
const tempDbPath = path.join(
  os.tmpdir(),
  `test-jessica-cmd057-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
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
process.env.SALON_TEST_ALLOWED_TENANTS = '570';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990057';
process.env.JESSICA_CONVERSATIONAL_V2 = 'true';
process.env.GEMINI_API_KEY = 'mock-gemini-key-test-cmd057';

// Limpeza de cache de módulos para assegurar conexão ao banco temporário isolado
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/config/index')];
delete require.cache[require.resolve('../src/database/db')];

const db = require('../src/database/db');
const jessicaNluService = require('../src/services/jessicaNluService');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');

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

function createIncomingMessage(text, fromPhone = '5511999990057', pushName = 'Bruna') {
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

test.describe('COMANDO 057 — Resiliência do Gemini NLU e Fallback Determinístico da Jéssica', () => {
  const tenantId = 570;
  const clientPhone = '5511999990057';

  test.before(() => {
    // 1. Seed do Usuário / Salão Tenant
    db.prepare(`
      INSERT INTO users (id, phone_number, name, role, plan)
      VALUES (?, '5511977770057', 'Salão Jéssica Resiliente', 'ADMIN', 'PRO')
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
      VALUES (?, 'Studio Jéssica V2', '5511977770057', ?, 'CONNECTED')
      ON CONFLICT(user_id) DO UPDATE SET salon_name = excluded.salon_name, opening_hours = excluded.opening_hours;
    `).run(tenantId, openingHours);

    // 3. Catálogo de Serviços
    db.prepare(`
      INSERT INTO client_services (id, user_id, name, price, duration_min, category, active)
      VALUES 
        (101, ?, 'Corte Feminino', 110.0, 45, 'Cabelo', 1),
        (102, ?, 'Corte Masculino', 60.0, 30, 'Cabelo', 1),
        (103, ?, 'Escova Modeladora', 70.0, 40, 'Cabelo', 1)
      ON CONFLICT(id) DO UPDATE SET price = excluded.price, active = 1;
    `).run(tenantId, tenantId, tenantId);

    // 4. Profissionais (Amanda e Letícia)
    db.prepare(`
      INSERT INTO client_staff (id, user_id, name, specialty, active)
      VALUES 
        (201, ?, 'Amanda', 'Cabelereira Master', 1),
        (202, ?, 'Letícia', 'Colorista e Corte', 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1;
    `).run(tenantId, tenantId);

    // 5. Relação Serviço x Profissional
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
  // SUÍTE 1: Bounds e Parsing de getNluTimeoutMs
  // =========================================================================
  test.describe('1. Bounds e Parsing de getNluTimeoutMs', () => {
    test('1.1 JESSICA_NLU_TIMEOUT_MS="500" deve ser clamped no mínimo de 1000ms', () => {
      process.env.JESSICA_NLU_TIMEOUT_MS = '500';
      const timeout = jessicaNluService.getNluTimeoutMs();
      assert.strictEqual(timeout, 1000, 'Deveria aplicar clamp inferior em 1000ms');
    });

    test('1.2 JESSICA_NLU_TIMEOUT_MS="30000" deve ser clamped no teto de 15000ms', () => {
      process.env.JESSICA_NLU_TIMEOUT_MS = '30000';
      const timeout = jessicaNluService.getNluTimeoutMs();
      assert.strictEqual(timeout, 15000, 'Deveria aplicar clamp superior em 15000ms');
    });

    test('1.3 JESSICA_NLU_TIMEOUT_MS="invalid" ou não numérico deve retornar default 8000ms', () => {
      process.env.JESSICA_NLU_TIMEOUT_MS = 'invalid_timeout';
      const timeout = jessicaNluService.getNluTimeoutMs();
      assert.strictEqual(timeout, 8000, 'Deveria retornar default 8000ms para valor inválido');

      delete process.env.JESSICA_NLU_TIMEOUT_MS;
      const timeoutUnset = jessicaNluService.getNluTimeoutMs();
      assert.strictEqual(timeoutUnset, 8000, 'Deveria retornar default 8000ms quando variável estiver ausente');
    });

    test('1.4 JESSICA_NLU_TIMEOUT_MS="5000" dentro dos limites deve retornar exatamente 5000ms', () => {
      process.env.JESSICA_NLU_TIMEOUT_MS = '5000';
      const timeout = jessicaNluService.getNluTimeoutMs();
      assert.strictEqual(timeout, 5000, 'Deveria respeitar valor válido de 5000ms');
    });

    test('1.5 Compatibilidade de NLU_TIMEOUT_MS getter dinâmico', () => {
      process.env.JESSICA_NLU_TIMEOUT_MS = '4500';
      assert.strictEqual(jessicaNluService.NLU_TIMEOUT_MS, 4500, 'NLU_TIMEOUT_MS getter deve refletir JESSICA_NLU_TIMEOUT_MS');

      process.env.JESSICA_NLU_TIMEOUT_MS = '25000';
      assert.strictEqual(jessicaNluService.NLU_TIMEOUT_MS, 15000, 'NLU_TIMEOUT_MS getter deve respeitar o clamp máximo de 15000ms');
    });
  });

  // =========================================================================
  // SUÍTE 2: Sanitização de Erros de IA (sanitizeAiError)
  // =========================================================================
  test.describe('2. Sanitização de Erros de IA (sanitizeAiError)', () => {
    test('2.1 Deve mascarar chaves de API cruas no padrão AIzaSy...', () => {
      const rawError = new Error('Falha ao conectar com Gemini usando chave AIzaSyB8tpFh0Z910111213141516171819202122');
      const sanitized = jessicaNluService.sanitizeAiError(rawError);
      assert.ok(!sanitized.includes('AIzaSyB8tpFh0'), 'Chave real não pode constar no erro sanitizado');
      assert.ok(sanitized.includes('[REDACTED_GEMINI_KEY]'), 'Deve substituir chave por [REDACTED_GEMINI_KEY]');
    });

    test('2.2 Deve mascarar parâmetros de URL com ?key=AIza... e &key=AIza...', () => {
      const urlError = 'GoogleGenerativeAIError: 403 Forbidden at https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSy_SecretKeyValueExample1234567890&alt=json';
      const sanitized = jessicaNluService.sanitizeAiError(urlError);
      assert.ok(!sanitized.includes('AIzaSy_SecretKeyValue'), 'Query param key deve ser omitido');
      assert.ok(sanitized.includes('key=[REDACTED_GEMINI_KEY]'), 'Query param deve ser convertido para key=[REDACTED_GEMINI_KEY]');
    });

    test('2.3 Trata valores nulos, vazios ou mensagens excessivamente longas com clamp seguro', () => {
      assert.strictEqual(jessicaNluService.sanitizeAiError(null), 'Erro desconhecido');
      assert.strictEqual(jessicaNluService.sanitizeAiError(undefined), 'Erro desconhecido');

      const longMessage = 'A'.repeat(500);
      const sanitized = jessicaNluService.sanitizeAiError(longMessage);
      assert.ok(sanitized.length <= 255, 'Mensagem deve ser limitada a 255 caracteres para prevenção de log injection');
    });
  });

  // =========================================================================
  // SUÍTE 3: Extratores Determinísticos em salonIncomingDispatcher.js
  // =========================================================================
  test.describe('3. Extratores Determinísticos em salonIncomingDispatcher', () => {
    test('3.1 extractDeterministicTemporal extrai "amanhã de manhã" -> datePref: "amanha", periodPref: "manha"', () => {
      const input = 'Oi, tudo bem? Tô querendo dar uma renovada no visual amanhã de manhã. Vocês conseguem me atender?';
      const result = salonIncomingDispatcher.extractDeterministicTemporal(input);
      assert.deepStrictEqual(result, {
        datePref: 'amanha',
        periodPref: 'manha',
      });
    });

    test('3.2 extractDeterministicTemporal extrai variações: hoje à tarde, amanhã à noite, sábado de manhã', () => {
      const resTarde = salonIncomingDispatcher.extractDeterministicTemporal('Tem vaga hoje a tarde?');
      assert.deepStrictEqual(resTarde, { datePref: 'hoje', periodPref: 'tarde' });

      const resNoite = salonIncomingDispatcher.extractDeterministicTemporal('Quero passar aí amanhã a noite');
      assert.deepStrictEqual(resNoite, { datePref: 'amanha', periodPref: 'noite' });

      const resSabado = salonIncomingDispatcher.extractDeterministicTemporal('Vocês têm horário no sábado pela manhã?');
      assert.deepStrictEqual(resSabado, { datePref: 'sabado', periodPref: 'manha' });
    });

    test('3.3 formatTemporalTarget formata amigavelmente combinações de data e período', () => {
      assert.strictEqual(salonIncomingDispatcher.formatTemporalTarget('amanha', 'manha'), 'amanhã de manhã');
      assert.strictEqual(salonIncomingDispatcher.formatTemporalTarget('amanha', 'tarde'), 'amanhã à tarde');
      assert.strictEqual(salonIncomingDispatcher.formatTemporalTarget('hoje', 'manha'), 'hoje de manhã');
      assert.strictEqual(salonIncomingDispatcher.formatTemporalTarget('hoje', 'tarde'), 'hoje à tarde');
      assert.strictEqual(salonIncomingDispatcher.formatTemporalTarget(null, 'manha'), 'pela manhã');
      assert.strictEqual(salonIncomingDispatcher.formatTemporalTarget('amanha', null), 'amanhã');
    });

    test('3.4 isSchedulingOrCareIntent identifica intenções acolhedoras de cuidado e renovação visual', () => {
      assert.strictEqual(salonIncomingDispatcher.isSchedulingOrCareIntent('Tô querendo dar uma renovada no visual'), true);
      assert.strictEqual(salonIncomingDispatcher.isSchedulingOrCareIntent('Quero cuidar do meu cabelo amanhã'), true);
      assert.strictEqual(salonIncomingDispatcher.isSchedulingOrCareIntent('Gostaria de dar um trato no cabelo'), true);
      assert.strictEqual(salonIncomingDispatcher.isSchedulingOrCareIntent('Tem vaga pra me atender amanhã?'), true);
      assert.strictEqual(salonIncomingDispatcher.isSchedulingOrCareIntent('Vocês estão atendendo hoje?'), true);
      assert.strictEqual(salonIncomingDispatcher.isSchedulingOrCareIntent('Boa tarde, tudo bem?'), false);
    });
  });

  // =========================================================================
  // SUÍTE 4: Cenários Conversacionais E2E no Dispatcher
  // =========================================================================
  test.describe('4. Cenários Conversacionais de Entrada no Dispatcher', () => {
    const inputMsg = 'Oi, tudo bem? Tô querendo dar uma renovada no visual amanhã de manhã. Vocês conseguem me atender?';

    // -----------------------------------------------------------------------
    // CENÁRIO A: Gemini Rápido / Sucesso
    // -----------------------------------------------------------------------
    test('Cenário A (Gemini Rápido / Sucesso): Acolhe calorosamente com "amanhã de manhã", sem menus mecânicos', async () => {
      const mockSock = createMockSocket();

      jessicaNluService.setMockNluHandler(({ text }) => {
        assert.strictEqual(text, inputMsg);
        return {
          intent: 'SCHEDULE_INQUIRY',
          serviceName: null,
          staffName: null,
          datePreference: 'amanha',
          period: 'manha',
          timeConstraint: null,
          friendlyMessage: 'Oii! Tudo bem? 😊 Claro, posso verificar para você amanhã de manhã! O que você está pensando em fazer no cabelo? Me conta para eu já checar com a nossa equipe! ✨',
        };
      });

      const processed = await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(inputMsg, clientPhone)
      );

      assert.strictEqual(processed, true, 'Mensagem deve ser processada com sucesso');
      const reply = mockSock.getLastText();

      assert.ok(reply.length > 0, 'Deveria ter enviado resposta de acolhimento');
      assert.ok(/amanh[aã]\s+de\s+manh[aã]/i.test(reply), 'Deveria citar "amanhã de manhã"');
      assert.ok(/qual procedimento|o que você está pensando em fazer/i.test(reply), 'Deve perguntar o procedimento desejado');
      assert.ok(!reply.includes('1.'), 'NÃO deve conter cardápio numerado imperativo no acolhimento');
      assert.ok(!/digite\s+o\s+n[úu]mero/i.test(reply), 'NÃO deve conter ordens robóticas "digite o número"');
    });

    // -----------------------------------------------------------------------
    // CENÁRIO B: Gemini Timeout -> Fallback Determinístico
    // -----------------------------------------------------------------------
    test('Cenário B (Gemini Timeout): Fallback acolhe cordialmente, retém data/turno e transiciona para AWAITING_SERVICE', async () => {
      const mockSock = createMockSocket();

      // Mock simula timeout da IA disparando erro com código NLU_TIMEOUT
      jessicaNluService.setMockNluHandler(() => {
        const timeoutErr = new Error('NLU_TIMEOUT: Processamento NLU excedeu o limite de 8000ms.');
        timeoutErr.code = 'NLU_TIMEOUT';
        throw timeoutErr;
      });

      const processed = await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(inputMsg, clientPhone)
      );

      assert.strictEqual(processed, true, 'Fallback deve recuperar o fluxo com sucesso');
      const reply = mockSock.getLastText();

      // Assertiva da resposta determinística humanizada do fallback
      assert.ok(
        reply.includes('amanhã de manhã') || reply.includes('amanha de manha'),
        'Fallback determinístico deve conter "amanhã de manhã"'
      );
      assert.ok(
        /qual procedimento você está pensando em fazer|o que você está pensando em fazer/i.test(reply),
        'Fallback determinístico deve perguntar o que a cliente quer fazer sem menus forçados'
      );
      assert.ok(!reply.includes('1. Corte Feminino'), 'Fallback de intenção aberta não deve forçar menu numerado');

      // Verificação da sessão em memória
      const sessionKey = `${tenantId}:${clientPhone}`;
      const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.ok(session, 'Sessão conversacional deve existir em memória');
      assert.strictEqual(session.state, 'AWAITING_SERVICE', 'Estado deve ser AWAITING_SERVICE');
      assert.strictEqual(session.requestedDatePref, 'amanha', 'Sessão deve reter requestedDatePref="amanha"');
      assert.strictEqual(session.requestedPeriod, 'manha', 'Sessão deve reter requestedPeriod="manha"');
    });

    // -----------------------------------------------------------------------
    // CENÁRIO C: Gemini Erro/Offline -> Fallback Determinístico
    // -----------------------------------------------------------------------
    test('Cenário C (Gemini Erro/Offline): Mock lança 503 Service Unavailable -> Fallback acolhe identicamente', async () => {
      const mockSock = createMockSocket();

      jessicaNluService.setMockNluHandler(() => {
        throw new Error('GEMINI_API_ERROR: 503 Service Unavailable [AIzaSyMockKeyForTest]');
      });

      const processed = await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(inputMsg, clientPhone)
      );

      assert.strictEqual(processed, true, 'Fallback determinístico deve tratar erro de API');
      const reply = mockSock.getLastText();

      assert.ok(reply.includes('amanhã de manhã'), 'Deveria manter retenção amanhã de manhã mesmo com IA offline');
      assert.ok(!reply.includes('503 Service Unavailable'), 'Erro interno nunca deve vazar para a cliente');

      const sessionKey = `${tenantId}:${clientPhone}`;
      const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.strictEqual(session.state, 'AWAITING_SERVICE');
      assert.strictEqual(session.requestedDatePref, 'amanha');
      assert.strictEqual(session.requestedPeriod, 'manha');
    });

    // -----------------------------------------------------------------------
    // CENÁRIO D: Turno Seguinte após Fallback
    // -----------------------------------------------------------------------
    test('Cenário D (Turno Seguinte): Cliente responde "Quero fazer um corte feminino" e Jéssica entrega horários da manhã de amanhã sem re-perguntar', async () => {
      const mockSock = createMockSocket();

      // Turno 1: Gemini dá timeout e entra no fallback determinístico
      jessicaNluService.setMockNluHandler(() => {
        const err = new Error('NLU_TIMEOUT: Gemini lento');
        err.code = 'NLU_TIMEOUT';
        throw err;
      });

      await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(inputMsg, clientPhone)
      );

      mockSock.clearSent();

      // Turno 2: Cliente informa o procedimento ("Quero fazer um corte feminino")
      const msgTurno2 = 'Quero fazer um corte feminino';

      // NLU reconhece o serviço "Corte Feminino" sem precisar de parâmetros temporais novos
      jessicaNluService.setMockNluHandler(({ text, session }) => {
        assert.strictEqual(text, msgTurno2);
        // Confirma que a sessão herdou requestedDatePref e requestedPeriod do fallback
        assert.strictEqual(session.requestedDatePref, 'amanha');
        assert.strictEqual(session.requestedPeriod, 'manha');
        return {
          intent: 'SCHEDULE_INQUIRY',
          serviceName: 'Corte Feminino',
          staffName: 'ANY',
          datePreference: null,
          period: null,
          friendlyMessage: 'Maravilha!',
        };
      });

      const processed2 = await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(msgTurno2, clientPhone)
      );

      assert.strictEqual(processed2, true);
      const reply2 = mockSock.getLastText();

      // Jéssica deve apresentar opções matutinas de amanhã sem perguntar "qual dia você quer?"
      assert.ok(reply2.includes('Corte Feminino'), 'Deve citar o serviço Corte Feminino');
      assert.ok(/hor[aá]rios/i.test(reply2) || /separei/i.test(reply2) || /encontrei/i.test(reply2), 'Deve avançar para os horários disponíveis');
      assert.ok(!reply2.includes('qual dia fica melhor para você'), 'NÃO deve re-perguntar a data já informada no turno 1');

      const sessionKey = `${tenantId}:${clientPhone}`;
      const session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.strictEqual(session.selectedService?.name, 'Corte Feminino');
      assert.ok(session.candidateSlots.length > 0, 'Deve ter carregado horários candidatos para amanhã de manhã');

      // Todos os slots devem respeitar o período matutino (< 12h)
      for (const slot of session.candidateSlots) {
        const hour = parseInt(slot.time.split(':')[0], 10);
        assert.ok(hour < 12, `Horário ${slot.time} deve ser no período matutino (< 12h)`);
      }
    });

    // -----------------------------------------------------------------------
    // CENÁRIO E: Limpeza da Sessão (Conclusão e Cancelamento)
    // -----------------------------------------------------------------------
    test('Cenário E.1 (Limpeza da Sessão no Cancelamento): Ao cancelar, requestedDatePref e requestedPeriod são zerados', async () => {
      const mockSock = createMockSocket();

      // Coloca sessão com data e período retidos via fallback
      jessicaNluService.setMockNluHandler(() => {
        throw new Error('NLU_TIMEOUT');
      });

      await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(inputMsg, clientPhone)
      );

      const sessionKey = `${tenantId}:${clientPhone}`;
      let session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.strictEqual(session.requestedDatePref, 'amanha');
      assert.strictEqual(session.requestedPeriod, 'manha');

      mockSock.clearSent();

      // Cliente cancela o agendamento
      const cancelMsg = 'Ah, deixa pra lá, prefiro cancelar por enquanto';
      jessicaNluService.setMockNluHandler(() => ({
        intent: 'CANCEL_OR_DISMISS',
        friendlyMessage: 'Tudo bem! Cancelado com sucesso.',
      }));

      await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage(cancelMsg, clientPhone)
      );

      session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.strictEqual(session.state, 'IDLE', 'Estado deve retornar para IDLE');
      assert.strictEqual(session.requestedDatePref, null, 'requestedDatePref deve ser limpo (null)');
      assert.strictEqual(session.requestedPeriod, null, 'requestedPeriod deve ser limpo (null)');
      assert.strictEqual(session.requestedTimeConstraint, null, 'requestedTimeConstraint deve ser limpo (null)');
    });

    test('Cenário E.2 (Limpeza da Sessão na Confirmação): Ao concluir agendamento, requestedDatePref e requestedPeriod são zerados', async () => {
      const mockSock = createMockSocket();
      const sessionKey = `${tenantId}:${clientPhone}`;

      // Inicia sessão e configura slot pré-selecionado
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

      let session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.ok(session.candidateSlots.length > 0, 'Deve ter slots candidatos');

      // Simula seleção do primeiro horário
      session.selectedSlot = session.candidateSlots[0];
      session.state = 'AWAITING_CONFIRMATION';

      mockSock.clearSent();

      // Cliente confirma agendamento
      jessicaNluService.setMockNluHandler(() => ({
        intent: 'CONFIRM_BOOKING',
        friendlyMessage: 'Confirmado!',
      }));

      const processedConfirm = await salonIncomingDispatcher.dispatchMessage(
        tenantId,
        mockSock,
        createIncomingMessage('Sim, pode confirmar!', clientPhone)
      );

      assert.strictEqual(processedConfirm, true);
      const reply = mockSock.getLastText();
      assert.ok(reply.includes('confirmado com sucesso'), 'Deveria confirmar agendamento');

      session = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
      assert.ok(session.state === 'AWAITING_REMINDER_OPTIN' || session.state === 'IDLE', 'Estado deve ser finalizado ou ir para oferta de lembrete');
      assert.strictEqual(session.requestedDatePref, null, 'requestedDatePref deve ser limpo após confirmação');
      assert.strictEqual(session.requestedPeriod, null, 'requestedPeriod deve ser limpo após confirmação');
      assert.strictEqual(session.requestedTimeConstraint, null, 'requestedTimeConstraint deve ser limpo após confirmação');
    });
  });
});
