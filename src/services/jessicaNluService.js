/**
 * RAIA AGENTES — SERVIÇO DE COMPREENSÃO DE LINGUAGEM NATURAL (NLU) - JÉSSICA 2.0
 *
 * Módulo NLU conversacional alimentado por Google Gemini SDK (@google/generative-ai).
 * Responsável por extrair intenções, preferências temporais, serviços e profissionais
 * mantendo estrito desacoplamento do backend transacional e proteção contra alucinações.
 *
 * @module services/jessicaNluService
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { performance } = require('node:perf_hooks');
const config = require('../config');

// Ordem mandatária de modelos Gemini para baixa latência e alta disponibilidade
// Permite sobrescrita via variável de ambiente GEMINI_MODEL sem expor dados sensíveis
const GEMINI_MODELS = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL.trim()]
  : [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ];

const DEFAULT_NLU_TIMEOUT_MS = 8000;
const MIN_NLU_TIMEOUT_MS = 1000;
const MAX_NLU_TIMEOUT_MS = 15000;
const MAX_INPUT_CHARS = 500;

let genAIClient = null;
let _mockNluHandler = null;

/**
 * Sanitiza mensagens de erro de IA para prevenir vazamento de credenciais e chaves
 * @param {any} err
 * @returns {string}
 */
function sanitizeAiError(err) {
  if (!err) return 'Erro desconhecido';
  let msg = typeof err === 'string' ? err : (err.message || String(err));
  msg = msg.replace(/AIza[0-9A-Za-z\-_]{35}/g, '[REDACTED_GEMINI_KEY]');
  msg = msg.replace(/([?&]key=)[^&]+/gi, '$1[REDACTED_GEMINI_KEY]');
  return msg.substring(0, 255);
}

/**
 * Obtém o timeout configurado em milissegundos dentro dos limites seguros
 * @returns {number}
 */
function getNluTimeoutMs() {
  const envVal = parseInt(process.env.JESSICA_NLU_TIMEOUT_MS, 10);
  if (isNaN(envVal)) return DEFAULT_NLU_TIMEOUT_MS;
  return Math.max(MIN_NLU_TIMEOUT_MS, Math.min(MAX_NLU_TIMEOUT_MS, envVal));
}

/**
 * Obtém ou inicializa o cliente singleton do Google Generative AI
 * @private
 * @returns {GoogleGenerativeAI}
 */
function getGenAI() {
  const apiKey = (config.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY_NOT_CONFIGURED: Chave da API do Gemini não configurada.');
  }
  if (!genAIClient) {
    genAIClient = new GoogleGenerativeAI(apiKey);
  }
  return genAIClient;
}

/**
 * Executa uma promise com timeout defensivo e desalocação do timer (unref)
 * @private
 * @param {Promise<any>} promise
 * @param {number} [ms]
 * @param {AbortController} [abortController]
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, abortController) {
  const timeoutDuration = typeof ms === 'number' ? ms : getNluTimeoutMs();
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      if (abortController && typeof abortController.abort === 'function') {
        try {
          abortController.abort();
        } catch (_) {}
      }
      const err = new Error(`NLU_TIMEOUT: Processamento NLU excedeu o limite de ${timeoutDuration}ms.`);
      err.code = 'NLU_TIMEOUT';
      reject(err);
    }, timeoutDuration);
    if (timerId && typeof timerId.unref === 'function') {
      timerId.unref();
    }
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId) clearTimeout(timerId);
  });
}

/**
 * Extrai e sanitiza objeto JSON de saídas de texto de LLMs
 * @private
 * @param {string} rawText
 * @returns {object|null}
 */
function extractJsonFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    return null;
  }
}

/**
 * Constrói as instruções de sistema seguras para a Jéssica
 * @private
 * @param {string} salonName
 * @returns {string}
 */
function buildSystemInstruction(salonName) {
  return `Você é a Jéssica, recepcionista virtual acolhedora, calorosa e extremamente profissional do salão "${salonName}".
Diretrizes Invioláveis:
- Responda SEMPRE E EXCLUSIVAMENTE em formato JSON puro compatível com o schema solicitado.
- Converse de forma natural, humana, empática e fluida. Jamais use frases robóticas ou ordens mecânicas como "digite...", "escolha digitando o número", "responda com 1 ou 2", "digite Sim".
- Não utilize excesso de emojis (no máximo 1 ou 2 por mensagem).
- Faça apenas UMA pergunta por vez para manter a conversa leve e acolhedora.
- NUNCA se reapresente dizendo seu nome caso a conversa já esteja em andamento.
- NUNCA invente horários, preços, descontos ou profissionais não listados explicitamente no contexto.
- NUNCA prometa brindes, cortesias ou condições financeiras não cadastradas.
- Se o cliente expressar vontade de agendar ou mudar o visual sem citar um serviço específico (ex: "quero dar uma renovada no visual amanhã de manhã", "tem horário amanhã?", "vocês atendem hoje?", "quero cuidar do meu cabelo"): classifique como intent: SCHEDULE_INQUIRY com serviceName: null, capture datePreference e period, e em friendlyMessage responda com acolhimento e simpatia dizendo que vai verificar os horários para o turno ou dia solicitado e perguntando carinhosamente o que ele tem em mente (ex: corte, escova, mechas, etc.). NUNCA prometa ou afirme que há vagas ou horários livres antes de saber o serviço e checar no sistema.

Intenções possíveis (intent):
- SCHEDULE_INQUIRY: Cliente quer agendar, verificar horários, dias disponíveis ou marcar um atendimento.
- SERVICE_INQUIRY: Cliente perguntando quais serviços são oferecidos, opções de catálogo ou detalhes técnicos.
- PRICE_INQUIRY: Cliente perguntando preços, valores ou formas de pagamento.
- CHANGE_PREFERENCE: Cliente solicitando alterar serviço, profissional, dia ou turno durante o fluxo.
- CONFIRM_BOOKING: Cliente confirmando o agendamento proposto (ex: "sim", "pode marcar", "confirmo", "perfeito").
- CANCEL_OR_DISMISS: Cliente cancelando, desistindo ou pedindo para parar o agendamento em andamento.
- REMINDER_OPTIN: Cliente respondendo sobre autorização de lembrete 24h por WhatsApp (ex: "sim", "quero", "não", "sem lembrete").
- GENERAL_TALK: Saudação inicial, agradecimento simples ("obrigada", "valeu") ou conversa geral cordial.

Parâmetros temporais obrigatórios quando mencionados pelo cliente:
- datePreference: "hoje", "amanha", "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo", ou "YYYY-MM-DD".
- period: "manha" (< 12h), "tarde" (12h às 18h), "noite" (>= 18h), ou null.
- timeConstraint: restrições explícitas como "after_15h" ("depois das 15h"), "not_morning" ("não posso de manhã"), "first_available" ("primeiro horário"), etc.

Schema JSON de saída:
{
  "intent": "SCHEDULE_INQUIRY" | "SERVICE_INQUIRY" | "PRICE_INQUIRY" | "CHANGE_PREFERENCE" | "CONFIRM_BOOKING" | "CANCEL_OR_DISMISS" | "REMINDER_OPTIN" | "GENERAL_TALK",
  "serviceName": string | null,
  "staffName": string | null,
  "datePreference": string | null,
  "period": "manha" | "tarde" | "noite" | null,
  "timeConstraint": string | null,
  "date": string | null,
  "time": string | null,
  "optInConsent": boolean | null,
  "friendlyMessage": string
}`;
}

/**
 * Executa a chamada aos modelos do Gemini em ordem de prioridade
 * @private
 */
async function executeGeminiCall({ text, salonName, services, staffList, session, abortSignal }) {
  const client = getGenAI();
  const systemInstruction = buildSystemInstruction(salonName);

  const servicesSummary = (services || []).map((s) => `- ${s.name}: R$ ${Number(s.price).toFixed(2).replace('.', ',')} (${s.duration_min} min)`).join('\n');
  const staffSummary = (staffList || []).map((st) => `- ${st.name}`).join('\n');

  const userPrompt = `Catálogo de Serviços Disponíveis:\n${servicesSummary || 'Nenhum'}\n\n` +
    `Profissionais Ativas:\n${staffSummary || 'Nenhuma'}\n\n` +
    `Estado Atual da Sessão:\n` +
    `- Estado: ${session?.state || 'IDLE'}\n` +
    `- Cliente: ${session?.customerName || 'Cliente'}\n` +
    `- Serviço Selecionado: ${session?.selectedService?.name || 'Nenhum'}\n` +
    `- Profissional: ${session?.selectedStaff?.name || 'Não definida'}\n` +
    `- Horário: ${session?.selectedSlot ? `${session.selectedSlot.date} às ${session.selectedSlot.time}` : 'Não definido'}\n\n` +
    `Mensagem recebida do cliente:\n"${text}"`;

  let lastError = null;

  for (const modelName of GEMINI_MODELS) {
    if (abortSignal?.aborted) {
      const abortErr = new Error('NLU_TIMEOUT: Processamento NLU cancelado por timeout.');
      abortErr.code = 'NLU_TIMEOUT';
      lastError = abortErr;
      break;
    }

    const startTime = performance.now();
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 800,
        },
      }, { signal: abortSignal });

      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      }, { signal: abortSignal });

      const durationMs = Math.round(performance.now() - startTime);
      const rawText = response.response.text();
      const parsed = extractJsonFromText(rawText);
      if (parsed && typeof parsed.intent === 'string') {
        console.info(`[jessicaNluService] Chamada Gemini concluída com sucesso: modelo=${modelName}, latencia=${durationMs}ms`);
        return parsed;
      }
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const isTimeout = Boolean(abortSignal?.aborted || err.code === 'NLU_TIMEOUT' || err.name === 'AbortError');
      const safeErrMsg = sanitizeAiError(err.name || err.message);
      console.warn(`[jessicaNluService] Falha na chamada Gemini: modelo=${modelName}, latencia=${durationMs}ms, timeout=${isTimeout}, erro=${safeErrMsg}`);

      if (isTimeout) {
        const timeoutErr = new Error('NLU_TIMEOUT: Processamento NLU excedeu o limite ou foi cancelado.');
        timeoutErr.code = 'NLU_TIMEOUT';
        lastError = timeoutErr;
        break; // Não tenta modelos adicionais após o timeout
      }
      lastError = err;
    }
  }

  if (lastError && (lastError.name === 'AbortError' || abortSignal?.aborted)) {
    lastError.code = 'NLU_TIMEOUT';
  }

  throw lastError || new Error('NLU_MODELS_EXHAUSTED: Nenhum modelo Gemini retornou resposta estruturada válida.');
}

/**
 * Processa uma mensagem recebida e retorna a classificação NLU estruturada
 *
 * @param {Object} params
 * @param {string} params.text Mensagem textual enviada pelo cliente
 * @param {string} [params.salonName] Nome comercial do salão
 * @param {Array<object>} [params.services] Catálogo de serviços ativos do salão
 * @param {Array<object>} [params.staffList] Lista de profissionais ativas do salão
 * @param {object} [params.session] Sessão conversacional atual
 * @returns {Promise<{
 *   intent: string,
 *   serviceName: string|null,
 *   staffName: string|null,
 *   period: 'manha'|'tarde'|'noite'|null,
 *   date: string|null,
 *   time: string|null,
 *   optInConsent: boolean|null,
 *   friendlyMessage: string
 * }|null>}
 */
async function parseMessage({ text, salonName = 'Nosso Salão', services = [], staffList = [], session = {} }) {
  if (!text || typeof text !== 'string') return null;

  // Clamp de segurança: limita estritamente em 500 caracteres
  const clampedText = text.slice(0, MAX_INPUT_CHARS).trim();
  if (!clampedText) return null;

  const timeoutMs = getNluTimeoutMs();
  const abortController = new AbortController();

  // Interceptador para testes unitários herméticos
  if (typeof _mockNluHandler === 'function') {
    return withTimeout(
      Promise.resolve().then(() => _mockNluHandler({
        text: clampedText,
        salonName,
        services,
        staffList,
        session,
      })),
      timeoutMs,
      abortController
    );
  }

  return withTimeout(
    executeGeminiCall({
      text: clampedText,
      salonName,
      services,
      staffList,
      session,
      abortSignal: abortController.signal,
    }),
    timeoutMs,
    abortController
  );
}

/**
 * Define handler mock para interceptação em testes herméticos
 * @param {Function} fn
 */
function setMockNluHandler(fn) {
  _mockNluHandler = fn;
}

/**
 * Restaura o handler NLU padrão (remove mock de testes)
 */
function resetMockNluHandler() {
  _mockNluHandler = null;
}

module.exports = {
  parseMessage,
  setMockNluHandler,
  resetMockNluHandler,
  getNluTimeoutMs,
  get NLU_TIMEOUT_MS() {
    return getNluTimeoutMs();
  },
  MAX_INPUT_CHARS,
  sanitizeAiError,
};
