/**
 * RAIA AGENTES — SERVIÇO DE TRANSCRIÇÃO DE ÁUDIO NO WHATSAPP (MÓDULO JÉSSICA)
 *
 * Módulo de transcrição inteligente e multimodal alimentado pelo Google Gemini SDK.
 * Responsável por converter mensagens de voz em texto com rigorosa fidelidade
 * sem alucinações, sem cumprimentos adicionais e com proteção fail-safe.
 *
 * @module services/jessicaAudioService
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { performance } = require('node:perf_hooks');
const config = require('../config');

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_AUDIO_SECONDS = 120; // 120 segundos (2 minutos)
const DEFAULT_AUDIO_TIMEOUT_MS = 10000; // 10 segundos
const MIN_AUDIO_TIMEOUT_MS = 2000;
const MAX_AUDIO_TIMEOUT_MS = 30000;

// Ordem mandatária de modelos Gemini para baixa latência e alta disponibilidade
const GEMINI_MODELS = process.env.GEMINI_AUDIO_MODEL
  ? [process.env.GEMINI_AUDIO_MODEL.trim()]
  : (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL.trim()] : [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);

let genAIClient = null;
let _mockAudioHandler = null;

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
 * @param {AbortController} [abortController]
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, abortController) {
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      if (abortController && typeof abortController.abort === 'function') {
        try {
          abortController.abort();
        } catch (_) {}
      }
      const err = new Error(`AUDIO_TIMEOUT: Transcrição de áudio excedeu o limite de ${ms}ms.`);
      err.code = 'AUDIO_TIMEOUT';
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
 * Normaliza e limpa a resposta de texto do Gemini
 * @private
 * @param {string} raw
 * @returns {string}
 */
function cleanTranscriptionOutput(raw) {
  if (!raw || typeof raw !== 'string') return '[ININTELIGIVEL]';
  let cleaned = raw.trim();

  // Remove markdown code blocks se a LLM tiver envolvido a transcrição
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  // Remove aspas envolventes se a LLM colocou
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith('\'') && cleaned.endsWith('\''))) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  if (!cleaned || /^(sil[eê]ncio|ru[íi]do|inaud[íi]vel|indistinto|desconhecido)$/i.test(cleaned)) {
    return '[ININTELIGIVEL]';
  }

  return cleaned;
}

/**
 * Prompt estrito para transcrição literal em pt-BR
 */
const SYSTEM_AUDIO_PROMPT =
  `Você é um transcritor de áudio altamente preciso em português do Brasil (pt-BR).\n` +
  `Sua tarefa é transcrever com exatidão literal as palavras faladas pelo usuário neste áudio.\n` +
  `Diretrizes estritas e invioláveis:\n` +
  `1. Retorne estritamente o texto falado. Jamais adicione cumprimentos, comentários, saudações, explicações, introduções ou aspas adicionais.\n` +
  `2. Jamais responda ou dialogue com a mensagem; apenas transcreva as falas com fidelidade.\n` +
  `3. Preserve termos comuns de salões de beleza, cortes de cabelo, datas, períodos e nomes próprios falados.\n` +
  `4. Se o áudio contiver apenas silêncio, ruídos de fundo incompreensíveis, música sem fala perceptível ou se for totalmente inaudível, retorne exatamente: [ININTELIGIVEL]`;

/**
 * Executa a chamada multimodal ao Gemini para transcrição de áudio
 * @private
 */
async function executeGeminiAudioCall({ audioBuffer, mimeType, abortSignal }) {
  const client = getGenAI();
  const safeMime = (mimeType || 'audio/ogg').split(';')[0].trim().toLowerCase() || 'audio/ogg';

  const inlineDataPart = {
    inlineData: {
      data: audioBuffer.toString('base64'),
      mimeType: safeMime,
    },
  };

  let lastError = null;

  for (const modelName of GEMINI_MODELS) {
    if (abortSignal?.aborted) {
      const abortErr = new Error('AUDIO_TIMEOUT: Transcrição de áudio cancelada por timeout.');
      abortErr.code = 'AUDIO_TIMEOUT';
      lastError = abortErr;
      break;
    }

    try {
      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1000,
        },
      }, { signal: abortSignal });

      const response = await model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              { text: SYSTEM_AUDIO_PROMPT },
              inlineDataPart,
            ],
          },
        ],
      }, { signal: abortSignal });

      const rawText = response.response.text();
      return cleanTranscriptionOutput(rawText);
    } catch (err) {
      const isTimeout = Boolean(abortSignal?.aborted || err.code === 'AUDIO_TIMEOUT' || err.name === 'AbortError');
      if (isTimeout) {
        const timeoutErr = new Error('AUDIO_TIMEOUT: Transcrição de áudio excedeu o limite de tempo.');
        timeoutErr.code = 'AUDIO_TIMEOUT';
        lastError = timeoutErr;
        break;
      }
      lastError = err;
    }
  }

  throw lastError || new Error('AUDIO_MODELS_EXHAUSTED: Nenhum modelo Gemini concluiu a transcrição.');
}

/**
 * Transcreve um buffer de áudio do WhatsApp de forma inteligente e segura
 *
 * @param {Object} params
 * @param {Buffer} params.audioBuffer Buffer binário do áudio
 * @param {string} [params.mimeType] Mime type original (ex: 'audio/ogg; codecs=opus')
 * @param {number} [params.seconds=0] Duração em segundos declarada no WhatsApp
 * @param {number} [params.timeoutMs=10000] Timeout máximo de processamento em ms
 * @returns {Promise<{
 *   success: boolean,
 *   text: string,
 *   error: string|null,
 *   durationSeconds: number,
 *   latencyMs: number
 * }>}
 */
async function transcribeAudio({ audioBuffer, mimeType = 'audio/ogg', seconds = 0, timeoutMs = DEFAULT_AUDIO_TIMEOUT_MS }) {
  const startTime = performance.now();
  const durationSeconds = Number(seconds) || 0;

  // 1. Validação defensiva de metadados
  if (durationSeconds > MAX_AUDIO_SECONDS) {
    return {
      success: false,
      text: '',
      error: 'AUDIO_DURATION_EXCEEDED',
      durationSeconds,
      latencyMs: 0,
    };
  }

  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return {
      success: false,
      text: '',
      error: 'AUDIO_BUFFER_EMPTY',
      durationSeconds,
      latencyMs: 0,
    };
  }

  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    return {
      success: false,
      text: '',
      error: 'AUDIO_FILE_TOO_LARGE',
      durationSeconds,
      latencyMs: 0,
    };
  }

  const effectiveTimeout = Math.max(MIN_AUDIO_TIMEOUT_MS, Math.min(MAX_AUDIO_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_AUDIO_TIMEOUT_MS));
  const abortController = new AbortController();

  // 2. Interceptador Mock para testes herméticos
  if (typeof _mockAudioHandler === 'function') {
    try {
      const mockResult = await withTimeout(
        Promise.resolve().then(() => _mockAudioHandler({
          audioBuffer,
          mimeType,
          seconds: durationSeconds,
          timeoutMs: effectiveTimeout,
        })),
        effectiveTimeout,
        abortController
      );

      const latencyMs = Math.round(performance.now() - startTime);

      if (typeof mockResult === 'string') {
        return {
          success: true,
          text: mockResult,
          error: null,
          durationSeconds,
          latencyMs,
        };
      }

      return {
        success: mockResult?.success !== false,
        text: mockResult?.text || '',
        error: mockResult?.error || null,
        durationSeconds: mockResult?.durationSeconds ?? durationSeconds,
        latencyMs: mockResult?.latencyMs ?? latencyMs,
      };
    } catch (mockErr) {
      const latencyMs = Math.round(performance.now() - startTime);
      return {
        success: false,
        text: '',
        error: sanitizeAiError(mockErr),
        durationSeconds,
        latencyMs,
      };
    }
  }

  // 3. Execução real com Google Gemini Multimodal
  try {
    const transcribedText = await withTimeout(
      executeGeminiAudioCall({
        audioBuffer,
        mimeType,
        abortSignal: abortController.signal,
      }),
      effectiveTimeout,
      abortController
    );

    const latencyMs = Math.round(performance.now() - startTime);
    return {
      success: true,
      text: transcribedText,
      error: null,
      durationSeconds,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startTime);
    const safeError = sanitizeAiError(err);
    return {
      success: false,
      text: '',
      error: safeError,
      durationSeconds,
      latencyMs,
    };
  }
}

/**
 * Define handler mock para interceptação em testes herméticos
 * @param {Function} fn
 */
function setMockAudioHandler(fn) {
  _mockAudioHandler = fn;
}

/**
 * Restaura o handler de áudio padrão (remove mock de testes)
 */
function resetMockAudioHandler() {
  _mockAudioHandler = null;
}

/**
 * Reset completo para isolamento em testes herméticos
 */
function _resetForTesting() {
  _mockAudioHandler = null;
  genAIClient = null;
}

module.exports = {
  transcribeAudio,
  setMockAudioHandler,
  resetMockAudioHandler,
  _resetForTesting,
  sanitizeAiError,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  DEFAULT_AUDIO_TIMEOUT_MS,
};
