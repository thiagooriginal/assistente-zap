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
const config = require('../config');

// Ordem mandatária de modelos Gemini para baixa latência e alta disponibilidade
const GEMINI_MODELS = [
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'gemini-flash-latest',
];

const NLU_TIMEOUT_MS = 3500;
const MAX_INPUT_CHARS = 500;

let genAIClient = null;
let _mockNluHandler = null;

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
 * @param {number} ms
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms = NLU_TIMEOUT_MS) {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      const err = new Error(`NLU_TIMEOUT: Processamento NLU excedeu o limite de ${ms}ms.`);
      err.code = 'NLU_TIMEOUT';
      reject(err);
    }, ms);
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
  return `Você é a Jéssica, recepcionista virtual inteligente, acolhedora e extremamente profissional do salão "${salonName}".
Diretrizes Invioláveis:
- Responda SEMPRE E EXCLUSIVAMENTE em formato JSON puro compatível com o schema solicitado.
- Seja natural, empática e use frases curtas. Não utilize excesso de emojis (no máximo 1 ou 2 por mensagem).
- Faça apenas UMA pergunta por vez para não sobrecarregar a cliente.
- NUNCA se reapresente dizendo seu nome caso a conversa já esteja em andamento.
- NUNCA invente horários, preços, descontos ou profissionais não listados explicitamente no contexto.
- NUNCA prometa brindes, cortesias ou condições financeiras não cadastradas.

Intenções possíveis (intent):
- SCHEDULE_INQUIRY: Cliente quer agendar, verificar horários, dias disponíveis ou marcar um atendimento.
- SERVICE_INQUIRY: Cliente perguntando quais serviços são oferecidos, opções de catálogo ou detalhes técnicos.
- PRICE_INQUIRY: Cliente perguntando preços, valores ou formas de pagamento.
- CHANGE_PREFERENCE: Cliente solicitando alterar serviço, profissional, dia ou turno durante o fluxo.
- CONFIRM_BOOKING: Cliente confirmando o agendamento proposto (ex: "sim", "pode marcar", "confirmo", "perfeito").
- CANCEL_OR_DISMISS: Cliente cancelando, desistindo ou pedindo para parar o agendamento em andamento.
- REMINDER_OPTIN: Cliente respondendo sobre autorização de lembrete 24h por WhatsApp (ex: "sim", "quero", "não", "sem lembrete").
- GENERAL_TALK: Saudação inicial, agradecimento simples ("obrigada", "valeu") ou conversa geral cordial.

Schema JSON de saída:
{
  "intent": "SCHEDULE_INQUIRY" | "SERVICE_INQUIRY" | "PRICE_INQUIRY" | "CHANGE_PREFERENCE" | "CONFIRM_BOOKING" | "CANCEL_OR_DISMISS" | "REMINDER_OPTIN" | "GENERAL_TALK",
  "serviceName": string | null,
  "staffName": string | null,
  "period": "manha" | "tarde" | "noite" | null,
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
async function executeGeminiCall({ text, salonName, services, staffList, session }) {
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
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 800,
        },
      });

      const response = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      });

      const rawText = response.response.text();
      const parsed = extractJsonFromText(rawText);
      if (parsed && typeof parsed.intent === 'string') {
        return parsed;
      }
    } catch (err) {
      lastError = err;
      // Tenta o próximo modelo da lista de prioridades
    }
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
      NLU_TIMEOUT_MS
    );
  }

  return withTimeout(
    executeGeminiCall({
      text: clampedText,
      salonName,
      services,
      staffList,
      session,
    }),
    NLU_TIMEOUT_MS
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
  NLU_TIMEOUT_MS,
  MAX_INPUT_CHARS,
};
