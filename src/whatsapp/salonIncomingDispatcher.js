/**
 * RAIA AGENTES — DESPACHANTE CONVERSACIONAL DE ENTRADA DO WHATSAPP (MÓDULO JÉSSICA)
 *
 * Processa mensagens recebidas nos sockets Baileys comerciais de cada salão parceiro.
 * Totalmente segregado do assistente pessoal (messageHandler.js).
 * Escopo estrito por tenant: WHERE user_id = salonUserId.
 * Máquina de estados conversacional para agendamentos inteligentes da Jéssica.
 *
 * @module whatsapp/salonIncomingDispatcher
 */

const crypto = require('crypto');
const db = require('../database/db');
const phoneUtils = require('../utils/phoneUtils');
const salonAppointmentService = require('../services/salonAppointmentService');
const salonNotificationService = require('../services/salonNotificationService');
const jessicaNluService = require('../services/jessicaNluService');
const jessicaAudioService = require('../services/jessicaAudioService');

let baileysModule = null;
try {
  baileysModule = require('@whiskeysockets/baileys');
} catch (_) {}

let _mockDownloadMediaHandler = null;
function setMockDownloadMediaHandler(fn) {
  _mockDownloadMediaHandler = fn;
}
function resetMockDownloadMediaHandler() {
  _mockDownloadMediaHandler = null;
}

/**
 * Acesso preguiçoso (lazy) ao salonSessionManager para eliminar advertência de dependência circular
 */
function getSessionManager() {
  return require('./salonSessionManager');
}

// Memória volátil de conversação: `${salonUserId}:${customerPhone}` => State
const customerSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos

// Mapa de provas de despacho seguras para blindagem contra spoofing de origem (COMANDO 064.1.1)
const dispatcherProofs = new Map();

/**
 * Gera prova criptograficamente segura de despacho WhatsApp para vinculação de agendamento.
 * @param {number|string} userId
 * @param {string} clientPhone
 * @returns {string} Token de prova com TTL curto
 */
function generateDispatcherBookingProof(userId, clientPhone) {
  const token = crypto.randomBytes(24).toString('hex');
  const cleanPhone = phoneUtils.cleanDigits(clientPhone);
  dispatcherProofs.set(token, {
    userId: Number(userId),
    clientPhone: cleanPhone,
    expiresAt: Date.now() + 60000, // 60 segundos
  });
  return token;
}

/**
 * Valida e consome atomicamente (single-use) a prova de despacho WhatsApp.
 * @param {string} token
 * @param {number|string} userId
 * @param {string} clientPhone
 * @returns {boolean}
 */
function consumeDispatcherBookingProof(token, userId, clientPhone) {
  if (!token || typeof token !== 'string') return false;
  const entry = dispatcherProofs.get(token);
  if (!entry) return false;
  dispatcherProofs.delete(token); // Single-use consumption
  if (entry.expiresAt < Date.now()) return false;
  if (entry.userId !== Number(userId)) return false;
  const cleanPhone = phoneUtils.cleanDigits(clientPhone);
  if (entry.clientPhone !== cleanPhone) return false;
  return true;
}

const WEEKDAY_NAMES = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const WEEKDAY_NAME_TO_INDEX = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  terça: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
  sábado: 6,
};

/**
 * Validação segura e inteligente de nome de cliente (COMANDO 066 - ETAPA 3)
 * Rejeita nulo, vazio, apenas emojis, símbolos, caracteres genéricos ou menos de 2 letras.
 * @param {string} name
 * @returns {boolean}
 */
function isValidCustomerName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;

  // Rejeitar termos afirmativos, negativos ou comandos isolados comuns que não são nomes
  const nonNameWords = /^(sim|não|nao|ok|claro|pode|confirmo|confirma|agendar|positivo|negativo|cancela|cancelar|sair|ajuda|menu|ola|olá|oi|bom dia|boa tarde|boa noite|1|2|3|isso|com certeza)$/i;
  if (nonNameWords.test(trimmed)) return false;

  // Rejeitar placeholders genéricos conhecidos
  const genericPlaceholders = [
    /^cliente\s*whatsapp$/i,
    /^cliente$/i,
    /^unknown$/i,
    /^anonimo$/i,
    /^anônimo$/i,
    /^user$/i,
    /^usuario$/i,
    /^usuário$/i,
    /^contato$/i,
    /^numero\s*desconhecido$/i,
    /^sem\s*nome$/i,
  ];
  if (genericPlaceholders.some((rgx) => rgx.test(trimmed))) return false;

  // Requer ao menos 2 caracteres alfabéticos (Unicode/acentos latinos)
  const letters = trimmed.match(/[\p{L}]/gu) || [];
  if (letters.length < 2) return false;

  // Rejeita strings que consistem apenas de pontuações, números ou caracteres repetidos não-nominais
  if (/^[0-9\s._\-+=!@#$%¨&*()~^`'"]+$/.test(trimmed)) return false;

  return true;
}

/**
 * Extrai e higieniza o nome pessoal a partir de expressões coloquiais
 * (ex: "Meu nome é Juliana", "Me chamo Ana Paula", "Sou a Mariana", "Juliana")
 *
 * @param {string} text
 * @returns {string}
 */
function extractCleanCustomerName(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text.trim();
  // Remove afirmação inicial opcional (ex: "Sim, meu nome é Juliana" ou "Sim, Juliana")
  cleaned = cleaned.replace(/^(?:sim|claro|ok|pode\s+ser)[,.]?\s+/i, '').trim();
  // Remove prefixos comuns de apresentação
  const prefixRegex = /^(?:meu\s+nome\s+[eé]|me\s+chamo|sou\s+(?:o|a)?|aqui\s+[eé]\s+(?:o|a)?|pode\s+colocar|chamo-me)\s+/i;
  cleaned = cleaned.replace(prefixRegex, '').trim();
  // Remove pontuações finais
  cleaned = cleaned.replace(/[.!?,;]+$/g, '').trim();
  return cleaned;
}

/**
 * Limpa periodicamente sessões conversacionais inativas da memória
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [key, session] of customerSessions.entries()) {
    if (session.lastActivity && (now - session.lastActivity) > SESSION_TTL_MS) {
      customerSessions.delete(key);
    }
  }
}

// Executa limpeza de memória a cada 10 minutos
setInterval(cleanupExpiredSessions, 10 * 60 * 1000).unref();

/**
 * Retorna profissionais ativos habilitados para um serviço específico (Comando 040 e 040.1)
 */
function getQualifiedStaffForService(uid, serviceId) {
  return db.prepare(`
    SELECT cs.id, cs.name, cs.active, cs.days_off
    FROM client_staff cs
    JOIN client_service_staff css ON css.staff_id = cs.id AND css.user_id = cs.user_id
    WHERE css.service_id = ? AND cs.user_id = ? AND css.confirmed = 1 AND cs.active = 1
    ORDER BY cs.name ASC
  `).all(serviceId, uid);
}

/**
 * Extrai o nó de áudio da mensagem desenvelopando wrappers comuns do WhatsApp
 * @private
 * @param {object} messageContent
 * @returns {object|null}
 */
function extractAudioNode(messageContent) {
  if (!messageContent) return null;
  let current = messageContent;
  while (
    current?.ephemeralMessage?.message ||
    current?.viewOnceMessage?.message ||
    current?.viewOnceMessageV2?.message ||
    current?.documentWithCaptionMessage?.message
  ) {
    current =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message;
  }
  return current?.audioMessage || null;
}

/**
 * Extrai o texto limpo da mensagem recebida
 * @private
 * @param {object} messageContent
 * @returns {string}
 */
function extractMessageText(messageContent) {
  if (!messageContent) return '';
  let current = messageContent;
  while (
    current?.ephemeralMessage?.message ||
    current?.viewOnceMessage?.message ||
    current?.viewOnceMessageV2?.message ||
    current?.documentWithCaptionMessage?.message
  ) {
    current =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message;
  }
  return (
    current?.conversation ||
    current?.extendedTextMessage?.text ||
    current?.imageMessage?.caption ||
    current?.videoMessage?.caption ||
    ''
  ).trim();
}

/**
 * Formata valor monetário em Real brasileiro (R$)
 * @private
 * @param {number|string} val
 * @returns {string}
 */
function formatPrice(val) {
  const num = Number(val) || 0;
  return num.toFixed(2).replace('.', ',');
}

/**
 * Formata horário de forma fluida e coloquial (ex: "09:00" -> "9h", "10:30" -> "10h30")
 * @private
 * @param {string} timeStr
 * @returns {string}
 */
function formatTimeFriendly(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return '';
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10);
  const m = parts[1] ? parseInt(parts[1], 10) : 0;
  if (isNaN(h)) return timeStr;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

/**
 * Qualificadores lexicais para desambiguação de serviços no salão
 */
const QUALIFIER_RULES = [
  { key: 'feminino', terms: ['feminino', 'feminina', 'mulher', 'mulheres', 'dama', 'damas'] },
  { key: 'masculino', terms: ['masculino', 'masculina', 'homem', 'homens', 'barbearia'] },
  { key: 'infantil', terms: ['infantil', 'crianca', 'criancas', 'kids'] },
  { key: 'barba', terms: ['barba', 'barbear', 'barbeiro', 'bigode'] },
  { key: 'fade', terms: ['fade', 'degrade', 'disfarcado'] },
  { key: 'camadas', terms: ['camadas', 'camada', 'bordado'] },
  { key: 'quimica', terms: ['quimica', 'luzes', 'mechas', 'tintura', 'coloracao', 'morena iluminada', 'loiro', 'loira', 'platinado'] },
  { key: 'alisamento', terms: ['botox', 'progressiva', 'alisamento', 'selagem', 'definitiva', 'prancha', 'chapinha'] },
  { key: 'alongamento_gel', terms: ['gel', 'alongamento', 'fibra', 'acrigel', 'esmalte em gel', 'esmaltacao em gel'] },
  { key: 'unha_tradicional', terms: ['tradicional', 'simples'] },
];

/**
 * Famílias de serviços e seus termos de busca/gatilho
 */
const SERVICE_FAMILIES = [
  {
    family: 'corte',
    triggers: ['corte', 'cortar', 'aparar', 'cabelo', 'pontas'],
    serviceTerms: ['corte', 'cortar', 'aparar'],
  },
  {
    family: 'escova_alisamento',
    triggers: ['escova', 'escovar', 'prancha', 'chapinha', 'alisamento', 'botox', 'progressiva', 'selagem'],
    serviceTerms: ['escova', 'alisamento', 'progressiva', 'botox', 'selagem', 'prancha', 'chapinha'],
  },
  {
    family: 'manicure',
    triggers: ['manicure', 'unha', 'unhas', 'esmaltacao', 'esmalte', 'cuticula', 'alongamento', 'gel', 'fibra'],
    serviceTerms: ['manicure', 'unha', 'unhas', 'alongamento', 'esmaltacao', 'cuticula'],
  },
  {
    family: 'pedicure',
    triggers: ['pedicure', 'pe', 'pes'],
    serviceTerms: ['pedicure', 'pes', 'pe'],
  },
  {
    family: 'sobrancelha',
    triggers: ['sobrancelha', 'sombrancelha', 'henna', 'design', 'micropigmentacao'],
    serviceTerms: ['sobrancelha', 'sombrancelha', 'design', 'henna', 'micropigmentacao'],
  },
  {
    family: 'barba',
    triggers: ['barba', 'barbear', 'barbeiro', 'bigode'],
    serviceTerms: ['barba', 'barbear', 'bigode'],
  },
  {
    family: 'coloracao',
    triggers: ['coloracao', 'pintar', 'mechas', 'luzes', 'tintura', 'morena iluminada', 'loiro', 'loira', 'platinado', 'tonalizante'],
    serviceTerms: ['coloracao', 'mechas', 'luzes', 'tintura', 'loiro', 'iluminada', 'tonalizante'],
  },
  {
    family: 'hidratacao',
    triggers: ['hidratacao', 'hidratar', 'nutricao', 'cauterizacao', 'cronograma', 'reconstrucao', 'terapia capilar', 'tratamento'],
    serviceTerms: ['hidratacao', 'cauterizacao', 'tratamento', 'reconstrucao', 'nutricao', 'cronograma'],
  },
  {
    family: 'depilacao',
    triggers: ['depilacao', 'depilar', 'cera'],
    serviceTerms: ['depilacao', 'depilar', 'cera'],
  },
  {
    family: 'maquiagem',
    triggers: ['maquiagem', 'make'],
    serviceTerms: ['maquiagem', 'make'],
  },
];

/**
 * Normaliza cadeia de texto para comparações lexicais defensivas
 * @private
 * @param {string} str
 * @returns {string}
 */
function normalizeText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Avalia um conjunto de serviços candidatos contra uma entrada textual limpa
 * @private
 * @param {Array<object>} pool
 * @param {string} cleanInput
 * @returns {{ status: 'EXACT'|'AMBIGUOUS'|'NONE', match?: object, candidates: Array<object> }}
 */
function evaluateCandidatePool(pool, cleanInput) {
  if (!Array.isArray(pool) || pool.length === 0 || !cleanInput) {
    return { status: 'NONE', candidates: [] };
  }

  // 1. Match exato por igualdade de string inteira
  for (const s of pool) {
    const sNorm = normalizeText(s.name);
    if (sNorm && sNorm === cleanInput) {
      return { status: 'EXACT', match: s };
    }
  }

  // 2. Substring exata de nome completo contida na mensagem do usuário
  const containedMatches = pool.filter((s) => {
    const sNorm = normalizeText(s.name);
    return sNorm.length >= 3 && cleanInput.includes(sNorm);
  });

  if (containedMatches.length === 1) {
    return { status: 'EXACT', match: containedMatches[0] };
  }
  if (containedMatches.length > 1) {
    containedMatches.sort((a, b) => normalizeText(b.name).length - normalizeText(a.name).length);
    const longestLen = normalizeText(containedMatches[0].name).length;
    const topMatches = containedMatches.filter((s) => normalizeText(s.name).length === longestLen);
    if (topMatches.length === 1) {
      return { status: 'EXACT', match: topMatches[0] };
    }
    return { status: 'AMBIGUOUS', candidates: topMatches };
  }

  // 3. Avaliação por Qualificadores e Famílias de Serviço
  const matchedQualifiers = QUALIFIER_RULES.filter((q) =>
    q.terms.some((term) => cleanInput.includes(term))
  );

  const triggeredFamilies = SERVICE_FAMILIES.filter((fam) =>
    fam.triggers.some((trig) => cleanInput.includes(trig))
  );

  if (triggeredFamilies.length > 0) {
    const familyCandidates = [];
    for (const fam of triggeredFamilies) {
      for (const s of pool) {
        const sNorm = normalizeText(s.name);
        const catNorm = normalizeText(s.category);
        const belongs = fam.serviceTerms.some((term) => sNorm.includes(term) || (catNorm && catNorm === fam.family));
        if (belongs && !familyCandidates.some((c) => c.id === s.id)) {
          familyCandidates.push(s);
        }
      }
    }

    if (familyCandidates.length > 0) {
      if (matchedQualifiers.length > 0) {
        const qualified = familyCandidates.filter((s) => {
          const sNorm = normalizeText(s.name);
          return matchedQualifiers.some((q) => q.terms.some((term) => sNorm.includes(term)));
        });

        if (qualified.length === 1) {
          return { status: 'EXACT', match: qualified[0] };
        }
        if (qualified.length > 1) {
          return { status: 'AMBIGUOUS', candidates: qualified };
        }
        return { status: 'AMBIGUOUS', candidates: familyCandidates };
      }

      if (familyCandidates.length === 1) {
        return { status: 'EXACT', match: familyCandidates[0] };
      }
      return { status: 'AMBIGUOUS', candidates: familyCandidates };
    }
  }

  // 4. Token Matching de palavras significativas (>= 4 caracteres), excluindo stop-words comuns
  const stopWords = ['quero', 'gostaria', 'agendar', 'marcar', 'horario', 'favor', 'fazer', 'atendimento', 'preciso'];
  const tokens = cleanInput.split(/\s+/).filter((w) => w.length >= 4 && !stopWords.includes(w));
  if (tokens.length > 0) {
    const tokenMatches = pool.filter((s) => {
      const sNorm = normalizeText(s.name);
      return tokens.some((tok) => sNorm.includes(tok));
    });

    if (tokenMatches.length === 1) {
      return { status: 'EXACT', match: tokenMatches[0] };
    }
    if (tokenMatches.length > 1) {
      if (matchedQualifiers.length > 0) {
        const qualified = tokenMatches.filter((s) => {
          const sNorm = normalizeText(s.name);
          return matchedQualifiers.some((q) => q.terms.some((term) => sNorm.includes(term)));
        });
        if (qualified.length === 1) return { status: 'EXACT', match: qualified[0] };
        if (qualified.length > 1) return { status: 'AMBIGUOUS', candidates: qualified };
      }
      return { status: 'AMBIGUOUS', candidates: tokenMatches };
    }
  }

  return { status: 'NONE', candidates: [] };
}

/**
 * Resolução pura e segura de identificação de serviços (Comando 050)
 *
 * @param {Array<object>} allServices Catálogo ativo de serviços do tenant
 * @param {string} text Texto bruto recebido do cliente
 * @param {Array<object>|null} [scopedCandidates=null] Lista de serviços candidatos no diálogo atual
 * @returns {{ status: 'EXACT'|'AMBIGUOUS'|'NONE', match?: object, candidates?: Array<object> }}
 */
function resolveServiceMatch(allServices, text, scopedCandidates = null) {
  if (!Array.isArray(allServices) || allServices.length === 0 || !text || typeof text !== 'string') {
    return { status: 'NONE', candidates: [] };
  }

  // REQ-SEC-01: Clamp textual de segurança em 150 caracteres
  const cleanInput = normalizeText(text.slice(0, 150));
  if (!cleanInput) {
    return { status: 'NONE', candidates: [] };
  }

  // Precedência 1 (Índice Numérico): Ex: "1", "2", "opcao 1", "nº 2"
  const numMatch = cleanInput.match(/^(?:opcao|numero|nº|n)?\s*(\d+)\.?$/i);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    // REQ-SEC-05: Validação estrita de limites
    if (Array.isArray(scopedCandidates) && scopedCandidates.length > 0) {
      if (num >= 1 && num <= scopedCandidates.length) {
        return { status: 'EXACT', match: scopedCandidates[num - 1] };
      }
      return { status: 'NONE', candidates: [] };
    }
    if (num >= 1 && num <= allServices.length) {
      return { status: 'EXACT', match: allServices[num - 1] };
    }
    return { status: 'NONE', candidates: [] };
  }

  // Se houver scopedCandidates ativo, avalia primeiro o subconjunto contextual
  if (Array.isArray(scopedCandidates) && scopedCandidates.length > 0) {
    const scopedResult = evaluateCandidatePool(scopedCandidates, cleanInput);
    if (scopedResult.status === 'EXACT' || scopedResult.status === 'AMBIGUOUS') {
      return scopedResult;
    }
  }

  // Avaliação contra o catálogo completo do tenant
  return evaluateCandidatePool(allServices, cleanInput);
}

/**
 * Realiza matching inteligente de serviço a partir do texto do cliente
 * (Wrapper de compatibilidade retroativa sobre resolveServiceMatch)
 * @private
 * @param {Array<object>} services
 * @param {string} text
 * @returns {object|null}
 */
function findMatchingService(services, text) {
  const res = resolveServiceMatch(services, text);
  return res.status === 'EXACT' ? res.match : null;
}

/**
 * Detecta de forma determinística solicitações comerciais de catálogo, valores ou preços.
 * Rejeita com rigor falsos positivos (afirmações isoladas, numerais e comandos de cancelamento).
 * Identifica se a solicitação é de catálogo geral ou de procedimento específico.
 *
 * @param {string} normText Texto normalizado (sem acentos, minúsculo)
 * @returns {{ isCommercial: boolean, isFullCatalog: boolean, queryTerm: string }}
 */
function parseCommercialInquiry(normText) {
  if (!normText || typeof normText !== 'string') {
    return { isCommercial: false, isFullCatalog: false, queryTerm: '' };
  }

  const clean = normalizeText(normText);
  if (!clean) {
    return { isCommercial: false, isFullCatalog: false, queryTerm: '' };
  }

  // 1. Rejeição de falsos positivos: termos afirmativos, numerais isolados e cancelamentos
  const isAffirmativeOrCommand = /^(sim|s|1|2|3|ok|claro|pode|pode\s+ser|pode\s+sim|confirmo|confirma|positivo|com\s+certeza|isso|isso\s+mesmo|exato|cancela|cancelar|sair|parar|desisto|deixa\s+pra\s+la|parar\s+lembretes?)$/i.test(clean);
  if (isAffirmativeOrCommand) {
    return { isCommercial: false, isFullCatalog: false, queryTerm: '' };
  }

  // 2. Termos fortes e inequívocos de catálogo geral
  const fullCatalogRegex = /\b(catalogo|tabela(\s+de\s+pre[cç]os?)?|cardapio|menu|lista\s+de\s+servi[cç]os|rela[cç][aã]o\s+de\s+servi[cç]os|quais\s+(s[aã]o\s+os\s+|os\s+)?servi[cç]os|quais\s+procedimentos|o\s+que\s+voc[eê]s\s+(fazem|oferecem|atendem)|servi[cç]os\s+que\s+voc[eê]s\s+(fazem|oferecem|t[eê]m)|todos\s+os\s+(pre[cç]os|valores|servi[cç]os)|valores\s+de\s+tudo)\b/i;

  // 3. Termos de consulta comercial de preço / valor / orçamento
  const priceInquiryRegex = /\b(quanto\s+(custa|fica|sai|[eé]|t[aá])|qual\s+(o\s+|os\s+)?(pre[cç]o|valor)|quais\s+(os\s+)?(pre[cç]os|valores)|pre[cç]os?|valores?|or[cç]amentos?|tabela)\b/i;

  // 4. Termos genéricos de questionamento de serviços oferecidos
  const serviceInquiryRegex = /\b(servi[cç]os?|procedimentos?)\b/i;

  const matchesFull = fullCatalogRegex.test(clean);
  const matchesPrice = priceInquiryRegex.test(clean);
  const matchesServiceInquiry = serviceInquiryRegex.test(clean) && /\b(quais|quaisquer|ver|mostrar|mandar|enviar|tem|t[eê]m|passar|saber)\b/i.test(clean);

  if (!matchesFull && !matchesPrice && !matchesServiceInquiry) {
    return { isCommercial: false, isFullCatalog: false, queryTerm: '' };
  }

  // Verifica menção explícita a famílias de serviços
  let hasSpecificService = false;
  for (const fam of SERVICE_FAMILIES) {
    if (fam.triggers.some((trig) => clean.includes(trig))) {
      hasSpecificService = true;
      break;
    }
  }

  // Se tem gatilho explícito de catálogo geral OU se perguntou preço/valores sem citar serviço específico
  const isFull = matchesFull || (matchesPrice && !hasSpecificService) || (matchesServiceInquiry && !hasSpecificService);

  // Extrai queryTerm higienizado (removendo termos de pergunta)
  let queryTerm = clean
    .replace(/\b(quanto\s+(custa|fica|sai|[eé]|t[aá])|qual\s+(o\s+|os\s+)?(pre[cç]o|valor)|quais\s+(os\s+)?(pre[cç]os|valores)|gostaria\s+de\s+saber|saber|por\s+favor|me\s+fala|me\s+informa|tem\s+como\s+me\s+passar|pra\s+fazer|para\s+fazer|de|do|da|o|a|os|as)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    isCommercial: true,
    isFullCatalog: isFull,
    queryTerm,
  };
}

/**
 * Formata mensagem de catálogo comercial completo com preços reais e duração.
 * Agrupa por categoria caso haja mais de 6 serviços e categorias preenchidas.
 * Se o catálogo estiver vazio, emite mensagem acolhedora sem inventar valores.
 *
 * @param {Array<object>} services Catálogo ativo de serviços do tenant
 * @param {string} salonName Nome do salão
 * @returns {string} Mensagem pronta para o cliente
 */
function formatCommercialCatalogMessage(services, salonName) {
  const safeSalonName = salonName || 'Nosso Espaço de Beleza';

  if (!Array.isArray(services) || services.length === 0) {
    return `Seja muito bem-vinda ao *${safeSalonName}*! ✨\n\n` +
      `No momento, nosso catálogo de procedimentos e valores está sendo atualizado em nosso sistema. Para consultar nossos serviços e agendar seu horário com todo carinho, por favor fale diretamente com a nossa recepção! 🥰`;
  }

  // Agrupamento por categoria caso haja > 6 serviços e pelo menos 2 categorias distintas válidas
  const hasCategories = services.some((s) => s.category && typeof s.category === 'string' && s.category.trim() !== '' && s.category.trim().toLowerCase() !== 'geral');
  const distinctCategories = new Set(services.map((s) => (s.category || '').trim()).filter(Boolean));

  const shouldGroup = services.length > 6 && hasCategories && distinctCategories.size > 1;

  if (shouldGroup) {
    const grouped = new Map();
    for (const s of services) {
      const cat = (s.category && s.category.trim()) ? s.category.trim() : 'Outros Serviços';
      if (!grouped.has(cat)) {
        grouped.set(cat, []);
      }
      grouped.get(cat).push(s);
    }

    const sections = [];
    for (const [category, items] of grouped.entries()) {
      const catHeader = `📂 *${category.toUpperCase()}*`;
      const catLines = items.map((s) => {
        const dur = s.duration_min ? ` (${s.duration_min} min)` : '';
        return `• *${s.name}* — R$ ${formatPrice(s.price)}${dur}`;
      });
      sections.push(`${catHeader}\n${catLines.join('\n')}`);
    }

    return `Aqui está o nosso catálogo completo de serviços e valores no *${safeSalonName}*: ✨\n\n` +
      sections.join('\n\n') +
      `\n\nGostaria de agendar algum desses procedimentos? É só me falar qual você prefere ou o dia que tem em mente! 🥰`;
  }

  // Catálogo linear (<= 6 serviços ou sem categorias)
  const itemsList = services.map((s) => {
    const dur = s.duration_min ? ` (${s.duration_min} min)` : '';
    return `• *${s.name}* — R$ ${formatPrice(s.price)}${dur}`;
  }).join('\n');

  return `Aqui está o nosso catálogo de serviços e valores no *${safeSalonName}*: ✨\n\n` +
    `${itemsList}\n\n` +
    `Gostaria de agendar algum desses procedimentos? É só me falar qual você prefere ou o dia que tem em mente! 🥰`;
}

/**
 * Constrói resposta de preço preservando o contexto e o estado do agendamento ativo.
 * Evita perda de contexto quando o cliente tira dúvidas de preço durante o funil.
 *
 * @param {string} priceText Texto explicativo do preço ou catálogo
 * @param {object} session Sessão conversacional do cliente
 * @returns {string} Resposta contextual combinada
 */
function buildActiveStatePriceResponse(priceText, session) {
  if (!session) return priceText;

  const currentService = session.selectedService?.name;

  switch (session.state) {
    case 'AWAITING_STAFF':
      return `${priceText}\n\n(Seu agendamento para *${currentService || 'seu procedimento'}* continua em andamento! ✨ Com qual profissional você prefere realizar, ou pode ser quem tiver o primeiro horário livre?)`;

    case 'AWAITING_SLOT':
      return `${priceText}\n\n(Seu agendamento para *${currentService || 'seu procedimento'}* continua em andamento! ✨ Qual dos horários informados fica melhor para você? Se quiser trocar de serviço ou data, é só me falar!)`;

    case 'AWAITING_NAME': {
      const timeInfo = session.selectedSlot?.time ? ` às *${session.selectedSlot.time}*` : '';
      return `${priceText}\n\n(Seu horário para *${currentService || 'seu procedimento'}*${timeInfo} continua reservadinho! ✨ Para concluirmos, pode me informar seu nome completo, por favor? 😊)`;
    }

    case 'AWAITING_CONFIRMATION': {
      const timeInfo = session.selectedSlot?.time ? ` às *${session.selectedSlot.time}*` : '';
      return `${priceText}\n\n(Seu agendamento para *${currentService || 'seu procedimento'}*${timeInfo} continua reservadinho! ✨ Posso confirmar seu horário? 🥰)`;
    }

    default:
      return priceText;
  }
}

/**
 * Converte preferência de data em lista de dias alvo
 * @param {string|null} datePreference "hoje", "amanha", "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo", ou "YYYY-MM-DD"
 * @param {Date} [baseDate=new Date()]
 * @returns {Array<{ dateStr: string, label: string, offset: number }>}
 */
function resolveCandidateDays(datePreference, baseDate = new Date()) {
  const normPref = String(datePreference || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  const pad = (n) => String(n).padStart(2, '0');
  const makeDay = (d, offset, customLabel) => {
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const dateStr = `${y}-${m}-${day}`;
    let label = customLabel;
    if (!label) {
      if (offset === 0) label = `Hoje (${day}/${m})`;
      else if (offset === 1) label = `Amanhã (${day}/${m})`;
      else label = `${WEEKDAY_NAMES[d.getDay()]} (${day}/${m})`;
    }
    return { dateStr, label, offset };
  };

  if (!normPref || normPref === 'hoje') {
    if (normPref === 'hoje') {
      return [makeDay(new Date(baseDate), 0, null)];
    }
    return getUpcomingCandidateDays(4, baseDate);
  }

  if (normPref === 'amanha') {
    const target = new Date(baseDate.getTime() + 24 * 60 * 60 * 1000);
    return [makeDay(target, 1, null)];
  }

  // YYYY-MM-DD direto
  if (/^\d{4}-\d{2}-\d{2}$/.test(normPref)) {
    const [y, m, d] = normPref.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const diffDays = Math.round((target.getTime() - baseDate.getTime()) / (24 * 60 * 60 * 1000));
    return [makeDay(target, Math.max(0, diffDays), null)];
  }

  // Nome do dia da semana (ex: "sexta", "sabado", "segunda")
  for (const [key, targetDayIdx] of Object.entries(WEEKDAY_NAME_TO_INDEX)) {
    if (normPref.includes(key)) {
      const currentDayIdx = baseDate.getDay();
      let diff = targetDayIdx - currentDayIdx;
      if (diff <= 0) diff += 7; // Próximo dia da semana
      const target = new Date(baseDate.getTime() + diff * 24 * 60 * 60 * 1000);
      return [makeDay(target, diff, null)];
    }
  }

  return getUpcomingCandidateDays(4, baseDate);
}

/**
 * Filtra slots de acordo com preferências de período e restrições de horário
 * @param {Array<object>} slots
 * @param {'manha'|'tarde'|'noite'|null} period
 * @param {string|null} timeConstraint ex: "after_15h", "not_morning", "first_available"
 * @returns {Array<object>}
 */
function filterSlotsByPreference(slots, period, timeConstraint) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  let filtered = [...slots];

  if (period) {
    filtered = filtered.filter((sl) => {
      const hour = parseInt(sl.time.split(':')[0], 10);
      if (period === 'manha') return hour < 12;
      if (period === 'tarde') return hour >= 12 && hour < 18;
      if (period === 'noite') return hour >= 18;
      return true;
    });
  }

  if (timeConstraint) {
    const norm = String(timeConstraint).toLowerCase();
    const afterMatch = norm.match(/(?:after|depois|apos)_?(\d{1,2})h?/i);
    if (afterMatch) {
      const minHour = parseInt(afterMatch[1], 10);
      filtered = filtered.filter((sl) => {
        const hour = parseInt(sl.time.split(':')[0], 10);
        return hour >= minHour;
      });
    }
    if (norm.includes('not_morning') || norm.includes('nao_manha')) {
      filtered = filtered.filter((sl) => {
        const hour = parseInt(sl.time.split(':')[0], 10);
        return hour >= 12;
      });
    }
    if (norm.includes('first_available') || norm.includes('primeiro')) {
      if (filtered.length > 0) filtered = [filtered[0]];
    }
  }

  return filtered;
}

/**
 * Extrai preferências temporais deterministicamente a partir de texto normalizado
 * @param {string} normText
 * @returns {{ datePref: string|null, periodPref: 'manha'|'tarde'|'noite'|null }}
 */
function extractDeterministicTemporal(normText) {
  if (!normText || typeof normText !== 'string') {
    return { datePref: null, periodPref: null };
  }

  const clean = normalizeText(normText);
  let datePref = null;
  let periodPref = null;

  if (/\bhoje\b/i.test(clean)) {
    datePref = 'hoje';
  } else if (/\bamanha\b/i.test(clean)) {
    datePref = 'amanha';
  } else {
    for (const [key] of Object.entries(WEEKDAY_NAME_TO_INDEX)) {
      const reg = new RegExp(`\\b${key}(-feira)?\\b`, 'i');
      if (reg.test(clean)) {
        datePref = key;
        break;
      }
    }
  }

  if (/\b(manha|cedo|pela manha|de manha)\b/i.test(clean)) {
    periodPref = 'manha';
  } else if (/\b(tarde|a tarde|pela tarde|de tarde)\b/i.test(clean)) {
    periodPref = 'tarde';
  } else if (/\b(noite|a noite|pela noite|de noite)\b/i.test(clean)) {
    periodPref = 'noite';
  }

  return { datePref, periodPref };
}

/**
 * Formata descrição fluida do alvo temporal para acolhimento conversacional
 * @param {string|null} datePref
 * @param {'manha'|'tarde'|'noite'|null} periodPref
 * @returns {string}
 */
function formatTemporalTarget(datePref, periodPref) {
  if (datePref === 'hoje') {
    if (periodPref === 'manha') return 'hoje de manhã';
    if (periodPref === 'tarde') return 'hoje à tarde';
    if (periodPref === 'noite') return 'hoje à noite';
    return 'hoje';
  }
  if (datePref === 'amanha') {
    if (periodPref === 'manha') return 'amanhã de manhã';
    if (periodPref === 'tarde') return 'amanhã à tarde';
    if (periodPref === 'noite') return 'amanhã à noite';
    return 'amanhã';
  }
  if (datePref) {
    const periodDesc = periodPref === 'manha' ? ' de manhã' : (periodPref === 'tarde' ? ' à tarde' : (periodPref === 'noite' ? ' à noite' : ''));
    return `para ${datePref}${periodDesc}`;
  }
  if (periodPref === 'manha') return 'pela manhã';
  if (periodPref === 'tarde') return 'à tarde';
  if (periodPref === 'noite') return 'à noite';
  return '';
}

/**
 * Verifica se o texto expressa intenção de agendamento ou renovação visual
 * @param {string} normText
 * @returns {boolean}
 */
function isSchedulingOrCareIntent(normText) {
  if (!normText) return false;
  const clean = normalizeText(normText);
  return /\b(agendar|marcar|horario|horarios|vaga|vagas|disponibilidade|atendimento|atender|atendem|atendendo|cortar|corte|renovar|visual|cuidar|trato|fazer|manicure|pedicure|escova|sobrancelha|barba)\b/i.test(clean) ||
    /dar\s+uma\s+renovada/i.test(clean) ||
    /renovar\s+o\s+visual/i.test(clean) ||
    /dar\s+um\s+trato/i.test(clean) ||
    /tem\s+(horario|vaga)/i.test(clean) ||
    /tem\s+como\s+(atender|agendar|marcar)/i.test(clean) ||
    /estao\s+atendendo/i.test(clean) ||
    /está\s+atendendo/i.test(clean) ||
    /quero\s+(mudar|arrumar|cuidar|cortar|fazer)/i.test(clean);
}

/**
 * Gera lista de datas candidatas para busca de horários disponíveis
 * @private
 * @param {number} [count=4]
 * @param {Date} [baseDate=new Date()]
 * @returns {Array<{ dateStr: string, label: string, offset: number }>}
 */
function getUpcomingCandidateDays(count = 4, baseDate = new Date()) {
  const days = [];
  const now = baseDate;

  for (let i = 0; i < 7 && days.length < count; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${day}`;

    let label = '';
    if (i === 0) {
      label = `Hoje (${day}/${m})`;
    } else if (i === 1) {
      label = `Amanhã (${day}/${m})`;
    } else {
      label = `${WEEKDAY_NAMES[d.getDay()]} (${day}/${m})`;
    }

    days.push({ dateStr, label, offset: i });
  }
  return days;
}

/**
 * Busca horários livres reais no salonAppointmentService para os próximos dias
 * @private
 * @param {number} userId
 * @param {object} service
 * @param {object|null} staff
 * @param {Array<object>|null} [targetDays=null]
 * @returns {Promise<Array<{ number: number, date: string, time: string, dayLabel: string }>>}
 */
async function findCandidateSlots(userId, service, staff = null, targetDays = null) {
  const duration = service?.duration_min || 45;
  const staffId = staff ? staff.id : null;
  const days = Array.isArray(targetDays) && targetDays.length > 0
    ? targetDays
    : getUpcomingCandidateDays(4);

  const allCandidateSlots = [];
  let counter = 1;
  const perDayLimit = days.length === 1 ? 15 : 4;

  for (const day of days) {
    try {
      const freeSlots = await salonAppointmentService.findAlternativeSlots(userId, {
        date: day.dateStr,
        serviceDurationMin: duration,
        staffId,
        serviceId: service?.id || null,
        limit: perDayLimit,
      });

      if (Array.isArray(freeSlots) && freeSlots.length > 0) {
        for (const slotTime of freeSlots) {
          let assignedStaffName = staff ? staff.name : null;
          if (!assignedStaffName && service?.id) {
            try {
              const eff = salonAppointmentService.resolveEffectiveStaff(userId, {
                serviceId: service.id,
                staffId: null,
                date: day.dateStr,
                time: slotTime,
                durationMin: duration,
              });
              if (eff && eff.staffName) {
                assignedStaffName = eff.staffName;
              }
            } catch (_) {}
          }
          allCandidateSlots.push({
            number: counter++,
            date: day.dateStr,
            time: slotTime,
            dayLabel: day.label,
            staffName: assignedStaffName,
          });
          if (allCandidateSlots.length >= 15) break;
        }
      }
    } catch (_) {}
    if (allCandidateSlots.length >= 15) break;
  }

  return allCandidateSlots;
}

/**
 * Expressão regular abrangente para detecção de indiferença por profissional (Comando 058)
 */
const REGEX_WANTS_ANY_STAFF = /(\bqualquer\b|tanto faz|sem prefer[eê]ncia|n[aã]o tenho prefer[eê]ncia|quem estiver dispon[ií]vel|quem tiver vaga|quem conseguir me atender|mais cedo|primeir[oa] hor[aá]rio|primeir[oa] vaga|qualquer profissional|qualquer um)/i;

/**
 * Formata apresentação curta, calorosa e fluida de horários disponíveis (Comando 058)
 *
 * @private
 * @param {Array<object>} slots Lista de slots candidatos
 * @param {object} service Serviço selecionado
 * @param {object|null} selectedStaff Profissional selecionado (se houver)
 * @param {string|null} [requestedPeriod] Período solicitado ('manha'|'tarde'|'noite'|null)
 * @returns {string}
 */
function formatCandidateSlotsMessage(slots, service, selectedStaff, requestedPeriod = null) {
  const displaySlots = slots.slice(0, 3);
  const count = displaySlots.length;
  if (count === 0) return '';

  const firstDay = displaySlots[0].dayLabel;
  const sameDay = displaySlots.every((s) => s.dayLabel === firstDay);

  let dayContext = '';
  if (sameDay) {
    const raw = firstDay.toLowerCase();
    if (raw.includes('hoje')) {
      dayContext = requestedPeriod ? `para hoje de ${requestedPeriod}` : 'para hoje';
    } else if (raw.includes('amanhã') || raw.includes('amanha')) {
      dayContext = requestedPeriod ? `para amanhã de ${requestedPeriod}` : 'para amanhã';
    } else {
      const weekday = firstDay.split(' ')[0];
      dayContext = requestedPeriod ? `para ${weekday} de ${requestedPeriod}` : `para ${weekday}`;
    }
  }

  // Identifica se múltiplos profissionais foram associados aos slots
  const staffNames = displaySlots.map((s) => s.staffName || selectedStaff?.name).filter(Boolean);
  const hasDistinctStaff = !selectedStaff && new Set(staffNames).size > 1;

  const slotPhrases = displaySlots.map((s) => {
    const timeFormatted = formatTimeFriendly(s.time);
    const dayPrefix = !sameDay ? `${s.dayLabel.split(' ')[0]} às ` : '';
    const stName = s.staffName || selectedStaff?.name;
    if (hasDistinctStaff && stName) {
      return `${dayPrefix}${timeFormatted} com a *${stName}*`;
    }
    return `${dayPrefix}*${timeFormatted}*`;
  });

  const countWord = count === 1 ? 'um horário' : (count === 2 ? 'dois horários' : (count === 3 ? 'três horários' : `${count} horários`));
  const timeListText = count === 1
    ? slotPhrases[0]
    : `${slotPhrases.slice(0, -1).join(', ')} e ${slotPhrases[slotPhrases.length - 1]}`;

  const priceDesc = service?.price != null ? ` (R$ ${formatPrice(service.price)})` : '';
  const serviceDesc = service?.name ? ` para *${service.name}*${priceDesc}` : '';
  const staffDesc = selectedStaff?.name ? ` com a *${selectedStaff.name}*` : '';
  let whenDesc = dayContext;
  if (service?.name && dayContext.startsWith('para ')) {
    whenDesc = dayContext.slice(5);
  }

  const intro = dayContext
    ? `Encontrei ${countWord}${serviceDesc}${staffDesc} ${whenDesc}: ${timeListText}.`
    : `Encontrei os seguintes horários${serviceDesc}${staffDesc}: ${timeListText}.`;

  const question = count === 1
    ? `Esse horário fica bom para você? 😊`
    : `Qual fica melhor para você? 😊`;

  const moreHint = slots.length > 3 ? ' (Quer ver mais opções? É só me falar!) ✨' : '';

  return `${intro} ${question}${moreHint}`;
}

/**
 * Trata solicitação de remarcação com encaminhamento real ou orientação transparente (Comando 058.1)
 *
 * @private
 * @param {number} uid ID do salão (tenant)
 * @param {string} cleanPhone Telefone normalizado da cliente
 * @param {object} session Sessão conversacional da cliente
 * @param {object} salon Registro do salão no banco
 * @returns {Promise<string>}
 */
async function dispatchRescheduleHandoff(uid, cleanPhone, session, salon = null) {
  if (!salon) {
    try {
      salon = db.prepare('SELECT salon_name, phone FROM client_salons WHERE user_id = ?').get(uid);
    } catch (_) {}
  }
  // 1. Localiza o agendamento original ativo do cliente no escopo estrito do tenant
  let apt = null;
  const targetAptId = session.lastConfirmedAppointmentId || session.lastAppointmentId;
  if (targetAptId) {
    try {
      apt = db.prepare(`
        SELECT a.id, a.client_name, a.client_phone, a.start_datetime, a.end_datetime, a.price,
               s.name AS service_name, st.name AS staff_name
        FROM appointments a
        LEFT JOIN client_services s ON s.id = a.service_id
        LEFT JOIN client_staff st ON st.id = a.staff_id
        WHERE a.id = ? AND a.user_id = ?
      `).get(targetAptId, uid);
    } catch (_) {}
  }
  if (!apt) {
    try {
      apt = db.prepare(`
        SELECT a.id, a.client_name, a.client_phone, a.start_datetime, a.end_datetime, a.price,
               s.name AS service_name, st.name AS staff_name
        FROM appointments a
        LEFT JOIN client_services s ON s.id = a.service_id
        LEFT JOIN client_staff st ON st.id = a.staff_id
        WHERE a.user_id = ?
          AND a.client_phone = ?
          AND a.status = 'AGENDADO'
          AND a.start_datetime >= datetime('now', '-2 hours')
        ORDER BY a.start_datetime ASC
        LIMIT 1
      `).get(uid, cleanPhone);
    } catch (_) {}
  }

  // 2. Consulta configurações de notificação do salão
  let notifSettings = null;
  try {
    notifSettings = salonNotificationService.getNotificationSettings(uid);
  } catch (_) {}

  const canNotify = Boolean(
    notifSettings &&
    notifSettings.notificationsEnabled &&
    notifSettings.notificationPhone &&
    notifSettings.notifyReschedule
  );

  session.state = 'IDLE';
  session.lastAppointmentId = null;
  session.lastConfirmedAppointmentId = null;
  session.isRescheduling = false;

  // Contato oficial de recepção (exclusivamente o telefone comercial do salão, autorizado para divulgação)
  const officialPhone = salon?.phone && typeof salon.phone === 'string' ? salon.phone.trim() : '';
  const contactInfo = officialPhone ? `pelo telefone ${officialPhone}` : `diretamente com a nossa equipe`;

  // 3. Encaminhamento real se houver infraestrutura e canal habilitado
  if (canNotify) {
    let queueRes = null;
    try {
      queueRes = await salonNotificationService.queueNotification(uid, apt ? apt.id : 0, 'RESCHEDULE_REQUEST', {
        clientName: apt?.client_name || session.customerName || 'Cliente WhatsApp',
        clientPhone: cleanPhone,
        serviceName: apt?.service_name || 'Procedimento',
        staffName: apt?.staff_name || 'Equipe',
        startDt: apt?.start_datetime || new Date().toISOString(),
        endDt: apt?.end_datetime || null,
      });
    } catch (err) {
      console.warn(`[salonIncomingDispatcher] Falha ao enfileirar notificação de remarcação (#${uid}):`, err.message);
    }

    const outboxStatus = queueRes?.status || (queueRes?.success ? 'PENDING' : 'FAILED');

    // Confirmação transparente baseada no estado real de entrega (Comando 058.1)
    if (outboxStatus === 'SENT') {
      return `Sem problemas! Seu agendamento atual continua 100% garantido e confirmado. ✨\n\n` +
        `Nossa equipe da recepção já foi notificada sobre o seu pedido de remarcação, e uma de nossas atendentes vai te responder por aqui em instantes para ajustar o seu horário com todo o carinho!`;
    }

    if (outboxStatus === 'PENDING' || outboxStatus === 'SIMULATED') {
      return `Sem problemas! Seu agendamento atual continua 100% garantido e confirmado. ✨\n\n` +
        `Já registrei seu pedido de remarcação para a nossa equipe da recepção, e assim que uma de nossas atendentes visualizar ela vai te responder por aqui para ajustar o seu horário com todo o carinho!`;
    }

    // Se o status for FAILED ou houver erro no enfileiramento, não afirma que notificou e orienta contato
  }

  // 4. Se o encaminhamento automático não puder ser garantido ou falhar, fornece orientação verdadeira sem falsas promessas
  return `Sem problemas! Seu agendamento atual continua 100% garantido e confirmado. ✨\n\n` +
    `Para remarcar ou ajustar seu horário, por favor entre em contato com a nossa recepção ${contactInfo}. Assim nossa equipe encontra o melhor horário para você!`;
}

/**
 * Identifica o slot selecionado a partir de expressões coloquiais, ordinais ou horários (Comando 058)
 *
 * @private
 * @param {Array<object>} slots Lista de slots disponíveis
 * @param {string} normText Texto normalizado do cliente
 * @param {string|null} [nluTime=null] Horário inferido pelo NLU (se houver)
 * @returns {object|null}
 */
function resolveSlotSelection(slots, normText, nluTime = null) {
  if (!Array.isArray(slots) || slots.length === 0 || !normText) return null;

  // 1. Ordinais ou expressões de preferência temporal relativa
  if (/(mais cedo|primeir[oa]|1[oºªa]|o primeiro)/i.test(normText)) {
    return slots[0] || null;
  }
  if (/(segund[oa]|2[oºªa]|o segundo)/i.test(normText) && slots.length >= 2) {
    return slots[1] || null;
  }
  if (/(terceir[oa]|3[oºªa]|o terceiro)/i.test(normText) && slots.length >= 3) {
    return slots[2] || null;
  }
  if (/(mais tarde|[uú]ltim[oa]|o ultimo)/i.test(normText)) {
    return slots[slots.length - 1] || null;
  }

  // 2. Número direto do menu (ex: "1", "2", "opcao 1")
  const numMatch = normText.match(/^(?:opcao|numero|nº|n)?\s*(\d+)\.?$/i);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    if (num >= 1 && num <= slots.length) {
      return slots[num - 1];
    }
  }

  // 3. Horário do NLU se presente
  if (nluTime && typeof nluTime === 'string') {
    const cleanNlu = nluTime.trim().replace('h', ':');
    const matched = slots.find((s) => s.time === cleanNlu || s.time.startsWith(cleanNlu) || cleanNlu.startsWith(s.time));
    if (matched) return matched;
  }

  // 4. Extração de padrões de horário no texto: ex "9h30", "9:30", "09:30", "9h", "10", "10h"
  const timeMatches = normText.match(/\b(\d{1,2})(?:[:hH](\d{2}))?\b/);
  if (timeMatches) {
    const hour = parseInt(timeMatches[1], 10);
    const minute = timeMatches[2] ? parseInt(timeMatches[2], 10) : 0;
    if (hour >= 6 && hour <= 23 && minute >= 0 && minute <= 59) {
      const padHour = String(hour).padStart(2, '0');
      const padMin = String(minute).padStart(2, '0');
      const targetTime = `${padHour}:${padMin}`;

      const exactTimeSlot = slots.find((s) => s.time === targetTime);
      if (exactTimeSlot) return exactTimeSlot;

      if (!timeMatches[2]) {
        const hourSlot = slots.find((s) => s.time.startsWith(`${padHour}:`));
        if (hourSlot) return hourSlot;
      }
    }
  }

  // 5. Fallback por includes de s.time ou formatação amigável
  for (const s of slots) {
    const friendly = formatTimeFriendly(s.time).toLowerCase();
    const raw = s.time.toLowerCase();
    const rawWithH = raw.replace(':', 'h');
    if (normText.includes(friendly) || normText.includes(raw) || normText.includes(rawWithH)) {
      return s;
    }
  }

  return null;
}

/**
 * Processa a mensagem através da Jéssica Conversacional 2.0 (NLU) com validação defensiva
 * e ancoragem no backend determinístico.
 *
 * @private
 * @param {object} params
 * @returns {Promise<string|null>} Retorna texto da resposta ou null para acionar fallback
 */
async function handleConversationalV2({
  nluResult,
  uid,
  cleanPhone,
  salonName,
  salon,
  services,
  staffList,
  session,
  text,
  normText,
}) {
  if (!nluResult || !nluResult.intent) return null;
  const intent = nluResult.intent;

  // Sessão aguardando nome deve ser conduzida com precisão determinística (ETAPA 3 - COMANDO 066),
  // exceto se a mensagem for dúvida comercial/preço, que deve ser esclarecida sem resetar o agendamento.
  if (session.state === 'AWAITING_NAME') {
    const commercial = parseCommercialInquiry(normText);
    if (!commercial.isCommercial && intent !== 'PRICE_INQUIRY' && intent !== 'PRICE_SERVICE_INQUIRY' && intent !== 'SERVICE_INQUIRY') {
      return null;
    }
  }

  // 1. Opt-in ou Opt-out de Lembretes 24h (LGPD - Prioridade Absoluta sobre Cancelamento Genérico)
  if (session.state === 'AWAITING_REMINDER_OPTIN' || intent === 'REMINDER_OPTIN') {
    // Zero-Trust: jamais conceder consentimento por mera inferência de IA
    const isFalsePositive =
      /^(eu\s+)?quero\s*$/i.test(normText) ||
      /^(eu\s+)?quero\s+receber\s*$/i.test(normText) ||
      /\b(orcamento|orçamento|catalogo|catálogo|valores?|precos?|preços?|tabela|menu)\b/i.test(normText) ||
      /quero\s+(agendar|marcar|mudar|ver|trocar|outro|outra|fazer|cancelar|saber)\b/i.test(normText) ||
      /pode\s+(mandar|enviar)\s+(os?\s+)?(valores?|precos?|preços?|orcamentos?|orçamentos?|catalogo|catálogo)/i.test(normText) ||
      /mostre\s+os\s+servicos/i.test(normText) ||
      /\b(nao|não)\s+quero\b/i.test(normText) ||
      /\bsem\s+lembrete/i.test(normText);

    const isExplicitAffirmative =
      !isFalsePositive && (
        // Resposta afirmativa direta e inequívoca à oferta de lembrete
        /^(1|sim|com certeza|autorizo|pode sim|claro)\s*(!|\.|\?)*$/i.test(normText) ||
        // Menção direta e obrigatória ao termo lembrete(s)
        /^(sim,?\s*)?(quero|pode enviar|pode mandar|ativar|autorizo)\s+(receber\s+)?(o\s+|os\s+)?lembrete(s)?\b/i.test(normText) ||
        /^(sim,?\s*)?quero\s+receber\s+(o\s+|os\s+)?lembrete(s)?\b/i.test(normText) ||
        /^(sim,?\s*)?pode\s+(enviar|mandar)\s+(o\s+|os\s+)?lembrete(s)?\b/i.test(normText) ||
        /^(sim,?\s*)?pode\s+(mandar|enviar)\s*(por favor|sim)?\s*(!|\.|\?)*$/i.test(normText)
      );

    const isExplicitNegative =
      /^(nao|não|2|dispensa|cancelar|cancela|sem lembrete)/i.test(normText) ||
      /\b(nao|não)\s+quero(\s+lembrete)?/i.test(normText) ||
      /\bsem\s+lembrete/i.test(normText) ||
      nluResult.optInConsent === false;

    // Se for afirmação explícita de consentimento de lembrete
    if (isExplicitAffirmative && session.lastAppointmentId) {
      const salonReminderService = require('../services/salonReminderService');
      salonAppointmentService.updateAppointmentConsent(session.lastAppointmentId, uid, 1, 'whatsapp_bot_optin');
      salonReminderService.registerClientConsent(uid, cleanPhone, 'whatsapp_bot_optin');

      session.state = 'IDLE';
      session.lastAppointmentId = null;
      return `Combinado! Lembrete de 24h ativado com sucesso. ✨\n\nCaso queira cancelar os lembretes no futuro, basta digitar *Parar lembretes* a qualquer momento.\n\nNos vemos em breve no *${salonName}*! 💖`;
    }

    // Se for recusa explícita de lembrete OU a palavra isolada "quero"
    if (isExplicitNegative || /^(eu\s+)?quero\s*$/i.test(normText)) {
      session.state = 'IDLE';
      session.lastAppointmentId = null;
      return `Tudo bem! Seu agendamento permanece confirmado normalmente sem lembretes automáticos. Se precisar de algo, estarei à disposição! ✨`;
    }

    // Continuidade da Conversa (COMANDO 056.1):
    // Se a cliente manifestar intenção de agendar outro horário, remarcar ou mudar atendimento:
    const isScheduleOrRescheduleInquiry =
      intent === 'RESCHEDULE' ||
      intent === 'SCHEDULE_INQUIRY' ||
      /(outro\s+(hor[aá]rio|dia|atendimento)|remarcar|mudar\s+(o\s+)?(hor[aá]rio|corte|servi[çc]o|dia|data)|novo\s+(hor[aá]rio|atendimento|agendamento)|agendar\s+outro|marcar\s+outro)/i.test(normText);

    if (isScheduleOrRescheduleInquiry) {
      // Consentimento permanece 0 (Zero-Trust) e agendamento confirmado permanece INTACTO no SQLite
      session.lastConfirmedAppointmentId = session.lastAppointmentId;
      session.state = 'AWAITING_RESCHEDULE_OR_NEW';
      return `Claro! Você quer remarcar o horário que acabamos de confirmar ou marcar um novo atendimento?`;
    }

    // Se a cliente perguntar valores / orçamento / catálogo / serviços
    if (intent === 'PRICE_INQUIRY' || intent === 'PRICE_SERVICE_INQUIRY' || intent === 'SERVICE_INQUIRY' || /\b(orcamento|orçamento|catalogo|catálogo|valores?|precos?|preços?|tabela|menu)\b/i.test(normText)) {
      session.state = 'IDLE';
      session.lastAppointmentId = null;
      const queryTerm = nluResult.serviceName || text;
      const resMatch = resolveServiceMatch(services, queryTerm);
      if (resMatch.status === 'EXACT') {
        const s = resMatch.match;
        return `O procedimento *${s.name}* no *${salonName}* custa *R$ ${formatPrice(s.price)}* (duração estimada de ${s.duration_min} minutos).\n\n(Seu agendamento anterior continua confirmadíssimo! ✨ Se quiser marcar mais um horário para esse ou outro procedimento, é só me falar!)`;
      }
      const catalog = formatCommercialCatalogMessage(services, salonName);
      return `${catalog}\n\n(Seu agendamento já está confirmado normalmente! ✨ Se quiser marcar outro atendimento, é só me avisar!)`;
    }

    // Se for conversa geral / dúvidas
    if (intent === 'GENERAL_TALK' && nluResult.friendlyMessage) {
      session.state = 'IDLE';
      session.lastAppointmentId = null;
      return nluResult.friendlyMessage;
    }

    // Qualquer outra intenção encerra o opt-in cordial sem conceder consentimento
    session.state = 'IDLE';
    session.lastAppointmentId = null;
    return `Tudo bem! Seu agendamento permanece confirmado normalmente sem lembretes automáticos. Se precisar de algo, estarei à disposição! ✨`;
  }

  // 1.1 Continuidade de Agendamento: Esclarecimento entre Remarcação ou Novo Atendimento (COMANDO 056.1 e 058)
  if (session.state === 'AWAITING_RESCHEDULE_OR_NEW') {
    const isRemarcar = /\b(remarcar|mudar|trocar|o\s+(que\s+)?acabamos\s+de\s+confirmar|o\s+de\s+agora|esse\s+mesmo)\b/i.test(normText);
    const isNovo = /\b(novo|marcar\s+(um\s+)?novo|novo\s+atendimento|outro\s+atendimento|outro|mais\s+um)\b/i.test(normText);

    if (isRemarcar) {
      return await dispatchRescheduleHandoff(uid, cleanPhone, session, salon);
    }

    if (isNovo) {
      // O agendamento anterior permanece 100% intacto no SQLite
      session.state = 'IDLE';
      session.lastAppointmentId = null;
      session.lastConfirmedAppointmentId = null;
      session.isRescheduling = false;
      return `Combinado! O seu agendamento anterior continua confirmado com carinho. ✨ Para o novo atendimento, qual serviço você gostaria de agendar?`;
    }

    // Se a cliente enviar outra mensagem direta (ex: serviço ou data), transiciona para IDLE e processa
    session.state = 'IDLE';
    session.lastAppointmentId = null;
    session.lastConfirmedAppointmentId = null;
  }

  // 2. Desistência ou Cancelamento voluntário do fluxo durante agendamento
  if (intent === 'CANCEL_OR_DISMISS' || /^(cancelar|cancela|desisto|sair|parar|deixa pra la)\b/i.test(normText)) {
    session.state = 'IDLE';
    session.selectedService = null;
    session.candidateServices = null;
    session.selectedStaff = null;
    session.availableStaffList = [];
    session.candidateSlots = [];
    session.selectedSlot = null;
    session.lastAppointmentId = null;
    session.requestedDatePref = null;
    session.requestedPeriod = null;
    session.requestedTimeConstraint = null;
    return nluResult.friendlyMessage || `Tudo bem! O agendamento foi cancelado. Se precisar de qualquer informação ou quiser marcar em outro momento, estarei por aqui! ✨`;
  }

  // 3. Confirmação Final do Agendamento
  if (session.state === 'AWAITING_CONFIRMATION' && (intent === 'CONFIRM_BOOKING' || /^(sim|confirmo|pode agendar|pode sim|pode confirmar|pode|ok|positivo|com certeza|1)\b/i.test(normText))) {
    const validService = db.prepare(`
      SELECT id, name, price, duration_min
      FROM client_services
      WHERE id = ? AND user_id = ? AND active = 1
    `).get(session.selectedService.id, uid);

    if (!validService) {
      throw new Error('SECURITY_VIOLATION_IDOR: Serviço inválido.');
    }

    let finalStaffId = session.selectedStaff ? session.selectedStaff.id : null;
    if (!finalStaffId) {
      const eff = salonAppointmentService.resolveEffectiveStaff(uid, {
        serviceId: validService.id,
        staffId: null,
        date: session.selectedSlot.date,
        time: session.selectedSlot.time,
        durationMin: validService.duration_min,
      });
      finalStaffId = eff.staffId;
      session.selectedStaff = { id: eff.staffId, name: eff.staffName };
    }

    const dispatcherProof = generateDispatcherBookingProof(uid, cleanPhone);
    const booked = await salonAppointmentService.bookAppointment(uid, {
      clientName: session.customerName || 'Cliente WhatsApp',
      clientPhone: cleanPhone,
      serviceId: validService.id,
      staffId: finalStaffId,
      date: session.selectedSlot.date,
      time: session.selectedSlot.time,
      durationMin: validService.duration_min,
      origin: 'WHATSAPP_BOT',
      inputModality: (session.lastOrigin === 'whatsapp_audio') ? 'audio' : 'text',
      dispatcherProof,
      reminderConsent: 0,
      reminderConsentOrigin: null,
    });

    // Fix bug: capturar variáveis antes de resetar a sessão para evitar `${undefined}` no horário
    const rawDate = session.selectedSlot.date;
    let displayDate = formatDisplayDate(rawDate);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

    if (rawDate === 'amanha' || rawDate === 'amanhã' || rawDate === tomorrowStr || (session.selectedSlot.dayLabel && session.selectedSlot.dayLabel.toLowerCase().includes('amanhã'))) {
      displayDate = 'amanhã';
    } else if (rawDate === 'hoje' || rawDate === todayStr || (session.selectedSlot.dayLabel && session.selectedSlot.dayLabel.toLowerCase().includes('hoje'))) {
      displayDate = 'hoje';
    }

    const datePrep = (displayDate.toLowerCase() === 'amanhã' || displayDate.toLowerCase() === 'hoje')
      ? displayDate.toLowerCase()
      : 'o dia ' + displayDate;

    const confirmedTime = session.selectedSlot.time;
    const confirmedServiceName = validService.name;
    const confirmedPrice = formatPrice(session.selectedService.price);
    const staffName = session.selectedStaff ? session.selectedStaff.name : (booked?.staff_name || 'Equipe do Salão');

    // Cálculo da diferença em horas até o atendimento (COMANDO 058)
    let diffHours = 48; // fallback seguro
    try {
      const [aptYear, aptMonth, aptDay] = rawDate.split('-').map(Number);
      const [aptHour, aptMin] = confirmedTime.split(':').map(Number);
      if (!isNaN(aptYear) && !isNaN(aptMonth) && !isNaN(aptDay)) {
        const appointmentDateObj = new Date(aptYear, aptMonth - 1, aptDay, aptHour || 0, aptMin || 0, 0);
        diffHours = (appointmentDateObj.getTime() - Date.now()) / (3600 * 1000);
      }
    } catch (_) {}

    session.selectedService = null;
    session.candidateServices = null;
    session.selectedStaff = null;
    session.candidateSlots = [];
    session.selectedSlot = null;
    session.requestedDatePref = null;
    session.requestedPeriod = null;
    session.requestedTimeConstraint = null;

    if (diffHours >= 24) {
      session.state = 'AWAITING_REMINDER_OPTIN';
      session.lastAppointmentId = booked.id;
      return `Prontinho! Agendamento confirmado com sucesso: seu agendamento para *${confirmedServiceName}* está marcado para ${datePrep}, às *${confirmedTime}*, com a *${staffName}*, por R$ ${confirmedPrice}. 😊\n\n` +
        `Quer que eu te mande um lembrete aqui no WhatsApp 24 horas antes do seu horário para você não esquecer? ✨\n\n` +
        `(Se não quiser o lembrete, não precisa se preocupar: seu horário já está garantido!)`;
    }

    // Atendimento em menos de 24 horas: não oferece lembrete e finaliza em IDLE
    session.state = 'IDLE';
    session.lastAppointmentId = null;
    return `Prontinho! Agendamento confirmado com sucesso: seu agendamento para *${confirmedServiceName}* está marcado para ${datePrep}, às *${confirmedTime}*, com a *${staffName}*, por R$ ${confirmedPrice}. 😊\n\n` +
      `Como seu atendimento já é nas próximas horas, nos vemos em breve no *${salonName}*! 💖`;
  }

  // 4. Consulta Comercial: Preço / Valores / Catálogo Inteligente (COMANDO 067)
  const commercialInfo = parseCommercialInquiry(normText);
  const isCommercialIntent =
    intent === 'PRICE_INQUIRY' ||
    intent === 'PRICE_SERVICE_INQUIRY' ||
    intent === 'SERVICE_INQUIRY' ||
    commercialInfo.isCommercial;

  if (isCommercialIntent) {
    const isBookingActive = ['AWAITING_STAFF', 'AWAITING_SLOT', 'AWAITING_NAME', 'AWAITING_CONFIRMATION'].includes(session.state);

    let priceResponseText = '';

    if (commercialInfo.isFullCatalog) {
      priceResponseText = formatCommercialCatalogMessage(services, salonName);
    } else {
      const queryTerm = commercialInfo.queryTerm || nluResult.serviceName || text;
      const resMatch = resolveServiceMatch(services, queryTerm);

      if (resMatch.status === 'EXACT') {
        const s = resMatch.match;
        const dur = s.duration_min ? ` (duração estimada de ${s.duration_min} minutos)` : '';
        if (session.selectedService && session.selectedService.id !== s.id) {
          priceResponseText = `O procedimento *${s.name}* no *${salonName}* custa *R$ ${formatPrice(s.price)}*${dur}.\n\n(Seu agendamento para *${session.selectedService.name}* continua em andamento! Deseja trocar para este serviço ou continuar?)`;
        } else {
          priceResponseText = `O procedimento *${s.name}* no *${salonName}* custa *R$ ${formatPrice(s.price)}*${dur}.\n\nGostaria de verificar os horários livres para agendar? É só me falar o dia de sua preferência! ✨`;
        }
      } else if (resMatch.status === 'AMBIGUOUS') {
        const candidateList = resMatch.candidates
          .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
          .join('\n');
        priceResponseText = `Temos mais de uma opção para esse serviço no *${salonName}*:\n\n${candidateList}\n\nQual dessas opções você prefere? Me conta para eu já checar os horários! ✨`;
      } else {
        priceResponseText = formatCommercialCatalogMessage(services, salonName);
      }
    }

    if (isBookingActive) {
      return buildActiveStatePriceResponse(priceResponseText, session);
    }

    return priceResponseText;
  }

  // 5. Seleção de Horário/Slot
  if (session.state === 'AWAITING_SLOT' && (session.candidateSlots?.length > 0)) {
    const slots = session.candidateSlots;
    const num = parseInt(normText, 10);
    let pickedSlot = null;

    if (/(mais opc|outros horar|ver mais|tem mais|outras opc)/i.test(normText)) {
      if (slots.length > 3) {
        const remainingSlots = slots.slice(3, 9);
        const slotList = remainingSlots.map((s, i) => `${i + 4}. ${s.dayLabel} às *${s.time}*`).join('\n');
        return `Aqui estão mais opções de horários disponíveis:\n\n${slotList}\n\nQual desses horários você prefere? ✨`;
      }
    }

    if (intent === 'CHANGE_PREFERENCE' && nluResult.serviceName) {
      // Cliente mudou de ideia sobre o serviço mesmo estando na tela de slots
      session.selectedService = null;
      session.selectedStaff = null;
      session.candidateSlots = [];
      session.state = 'IDLE';
    } else {
      const pickedSlot = resolveSlotSelection(slots, normText, nluResult.time);

      if (pickedSlot) {
        session.selectedSlot = { date: pickedSlot.date, time: pickedSlot.time };

        if (!session.selectedStaff) {
          try {
            const eff = salonAppointmentService.resolveEffectiveStaff(uid, {
              serviceId: session.selectedService.id,
              staffId: null,
              date: pickedSlot.date,
              time: pickedSlot.time,
              durationMin: session.selectedService.duration_min,
            });
            session.selectedStaff = { id: eff.staffId, name: eff.staffName };
          } catch (_) {}
        }

        const displayDate = formatDisplayDate(pickedSlot.date);
        const staffName = session.selectedStaff ? session.selectedStaff.name : 'Equipe do Salão';
        const priceFormatted = formatPrice(session.selectedService.price);

        const hasValidName = isValidCustomerName(session.customerName);
        if (hasValidName) {
          session.state = 'AWAITING_CONFIRMATION';
          return `Perfeito! Encontrei esse horário para você! ✨\n\n` +
            `📍 *Espaço:* ${salonName}\n` +
            `💇‍♀️ *Serviço:* ${session.selectedService.name}\n` +
            `👤 *Profissional:* ${staffName}\n` +
            `📅 *Data:* ${displayDate} (${pickedSlot.dayLabel.split(' ')[0]})\n` +
            `⏰ *Horário:* ${pickedSlot.time}\n` +
            `💰 *Valor:* R$ ${priceFormatted}\n\n` +
            `Posso confirmar o seu agendamento? 🥰`;
        }

        session.state = 'AWAITING_NAME';
        return `Perfeito! Encontrei esse horário para você! ✨\n\n` +
          `📍 *Espaço:* ${salonName}\n` +
          `💇‍♀️ *Serviço:* ${session.selectedService.name}\n` +
          `👤 *Profissional:* ${staffName}\n` +
          `📅 *Data:* ${displayDate} (${pickedSlot.dayLabel.split(' ')[0]})\n` +
          `⏰ *Horário:* ${pickedSlot.time}\n` +
          `💰 *Valor:* R$ ${priceFormatted}\n\n` +
          `Perfeito! Antes de confirmar, pode me informar seu nome, por favor? 😊`;
      }
    }
  }

  // 5.1 Solicitação Direta de Remarcação (Comando 058.1)
  if (intent === 'RESCHEDULE' || /\b(remarcar|remarca[çc][aã]o|mudar\s+(o\s+)?(hor[aá]rio|dia|data)|trocar\s+(o\s+)?(hor[aá]rio|dia|data))\b/i.test(normText)) {
    return await dispatchRescheduleHandoff(uid, cleanPhone, session, salon);
  }

  // 6. Conversa Geral / Saudação
  if (intent === 'GENERAL_TALK') {
    return nluResult.friendlyMessage || `Olá! Tudo bem? Seja muito bem-vinda ao *${salonName}*! 🥰\n\nComo posso te ajudar hoje? Se você quiser agendar um horário ou saber mais sobre nossos serviços, é só me falar!`;
  }

  // 7. Agendamento com Resolução do Serviço ou Acolhimento Aberto
  if (intent === 'SCHEDULE_INQUIRY' || intent === 'CHANGE_PREFERENCE' || !session.selectedService) {
    const detTemp = extractDeterministicTemporal(normText);
    if (nluResult.datePreference) session.requestedDatePref = nluResult.datePreference;
    else if (!session.requestedDatePref && detTemp.datePref) session.requestedDatePref = detTemp.datePref;

    if (nluResult.period) session.requestedPeriod = nluResult.period;
    else if (!session.requestedPeriod && detTemp.periodPref) session.requestedPeriod = detTemp.periodPref;

    if (nluResult.timeConstraint) session.requestedTimeConstraint = nluResult.timeConstraint;

    const queryTerm = nluResult.serviceName || text;
    const resMatch = resolveServiceMatch(services, queryTerm, session.candidateServices);

    if (resMatch.status === 'EXACT') {
      const matchedService = resMatch.match;
      session.selectedService = matchedService;
      session.candidateServices = null;

      const qualifiedStaff = getQualifiedStaffForService(uid, matchedService.id);
      if (qualifiedStaff.length === 0) {
        session.state = 'IDLE';
        return `Adoraríamos te atender para *${matchedService.name}*, mas no momento não temos profissionais com agenda aberta para este procedimento. Nossa equipe entrará em contato em instantes! ✨`;
      }

      // Se o cliente pediu profissional específico
      let pickedStaff = null;
      if (nluResult.staffName && nluResult.staffName !== 'ANY') {
        const staffNorm = nluResult.staffName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        pickedStaff = qualifiedStaff.find((st) => {
          const stNorm = st.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          return stNorm.includes(staffNorm) || staffNorm.includes(stNorm);
        }) || null;
      }

      const wantsAny = Boolean(nluResult.staffName === 'ANY' || REGEX_WANTS_ANY_STAFF.test(normText));

      if (pickedStaff) {
        session.selectedStaff = pickedStaff;
      } else if (wantsAny) {
        session.selectedStaff = null;
      } else if (qualifiedStaff.length === 1) {
        session.selectedStaff = qualifiedStaff[0];
      } else {
        session.availableStaffList = qualifiedStaff;
        session.state = 'AWAITING_STAFF';
        const staffNames = qualifiedStaff.map((st) => `*${st.name}*`).join(', ');
        return `Perfeito! Para *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}), nós temos as profissionais ${staffNames}. Você tem preferência por alguém ou pode ser com quem tiver o primeiro horário livre? ✨`;
      }

      // Busca slots de horários com o serviço e profissional (ou qualquer), respeitando data e turno
      const effectiveDatePref = nluResult.datePreference || session.requestedDatePref;
      const effectivePeriod = nluResult.period || session.requestedPeriod;
      const effectiveConstraint = nluResult.timeConstraint || session.requestedTimeConstraint;

      const targetDays = resolveCandidateDays(effectiveDatePref);
      let slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff, targetDays);

      const hadTimePreference = Boolean(effectivePeriod || effectiveConstraint);
      if (hadTimePreference) {
        slots = filterSlotsByPreference(slots, effectivePeriod, effectiveConstraint);
      }

      if (slots.length > 0) {
        session.candidateSlots = slots;
        session.state = 'AWAITING_SLOT';
        return formatCandidateSlotsMessage(slots, session.selectedService, session.selectedStaff, effectivePeriod);
      } else {
        session.state = 'IDLE';
        if (hadTimePreference) {
          const prefDesc = effectivePeriod ? `no período da ${effectivePeriod}` : 'no horário solicitado';
          return `Não encontrei horários disponíveis para *${matchedService.name}* ${prefDesc} nessa data. Você teria disponibilidade em outro turno ou dia? Me avise para eu verificar! ✨`;
        }
        return `No momento não encontrei horários livres para *${matchedService.name}* nessa data. Você teria disponibilidade em outro dia? Me conta qual fica melhor para você! ✨`;
      }
    } else if (resMatch.status === 'AMBIGUOUS') {
      session.candidateServices = resMatch.candidates;
      session.state = 'AWAITING_SERVICE';
      const candidateList = resMatch.candidates
        .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
        .join('\n');
      return `Temos mais de uma opção para esse serviço no *${salonName}*:\n\n${candidateList}\n\nQual dessas opções você prefere? Me conta para eu já checar os horários! ✨`;
    } else {
      // Intenção aberta sem serviço específico identificado (ex: "dar uma renovada no visual amanhã de manhã")
      session.state = 'AWAITING_SERVICE';
      session.candidateServices = null;

      const datePref = nluResult.datePreference || session.requestedDatePref;
      const periodPref = nluResult.period || session.requestedPeriod;

      if (datePref) session.requestedDatePref = datePref;
      if (periodPref) session.requestedPeriod = periodPref;

      if (nluResult.friendlyMessage) {
        return nluResult.friendlyMessage;
      }
      if (nluResult.assistantResponse) {
        return nluResult.assistantResponse;
      }

      let timeTarget = '';
      if (datePref === 'hoje') {
        timeTarget = periodPref === 'manha' ? 'hoje de manhã' : (periodPref === 'tarde' ? 'hoje à tarde' : (periodPref === 'noite' ? 'hoje à noite' : 'hoje'));
      } else if (datePref === 'amanha' || datePref === 'amanhã') {
        timeTarget = periodPref === 'manha' ? 'amanhã de manhã' : (periodPref === 'tarde' ? 'amanhã à tarde' : (periodPref === 'noite' ? 'amanhã à noite' : 'amanhã'));
      } else if (periodPref === 'manha') {
        timeTarget = 'pela manhã';
      } else if (periodPref === 'tarde') {
        timeTarget = 'à tarde';
      } else if (periodPref === 'noite') {
        timeTarget = 'à noite';
      } else if (datePref) {
        timeTarget = `para ${datePref}`;
      }

      if (timeTarget) {
        return `Oii! Tudo bem? 😊 Claro, posso verificar para você ${timeTarget}! O que você está pensando em fazer no cabelo (como corte, escova, mechas...)? Me conta para eu já checar com a nossa equipe! ✨`;
      }
      return `Oii! Tudo bem? 😊 Claro, posso verificar para você! O que você está pensando em fazer no cabelo (como corte, escova, mechas...)? Me conta para eu já checar com a nossa equipe! ✨`;
    }
  }

  return null;
}

/**
 * Formata data YYYY-MM-DD para DD/MM/YYYY
 * @private
 * @param {string} dateStr
 * @returns {string}
 */
function formatDisplayDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr;
  const parts = dateStr.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return dateStr;
}

/**
 * Despacha e processa a mensagem recebida no WhatsApp comercial do salão
 *
 * @param {number} salonUserId Identificador do salão proprietário da linha
 * @param {object} sock Instância Baileys do salão
 * @param {object} msg Mensagem recebida no evento messages.upsert
 * @returns {Promise<boolean>} Retorna true se processou, false se ignorou
 */
async function dispatchMessage(salonUserId, sock, msg) {
  const uid = Number(salonUserId);
  if (!uid || isNaN(uid) || !sock || !msg || !msg.message) {
    return false;
  }

  const senderJid = msg.key?.remoteJid;
  const isFromMe = Boolean(msg.key?.fromMe);

  // 1. Defesa de borda: rejeitar grupos, broadcasts, newsletters e canais
  if (
    !senderJid ||
    isFromMe ||
    senderJid.endsWith('@g.us') ||
    senderJid.includes('@newsletter') ||
    senderJid.includes('@broadcast')
  ) {
    return false;
  }

  // Apenas mensagens individuais (@s.whatsapp.net ou @lid)
  if (!senderJid.includes('@s.whatsapp.net') && !senderJid.includes('@lid')) {
    return false;
  }

  // 1.1 Verificação defensiva de assinatura ativa do salão (Módulo Jéssica)
  try {
    const productService = require('../services/productService');
    const access = productService.hasProductAccess(uid, 'JESSICA');
    if (!access || !access.hasAccess) {
      console.warn(`[salonIncomingDispatcher] Salão #${uid} com assinatura inativa ou expirada (${access?.status || 'NO_ACCESS'}). Mensagem descartada.`);
      return false;
    }
  } catch (subErr) {
    console.error(`[salonIncomingDispatcher] Erro ao verificar assinatura para #${uid}:`, subErr.message);
  }

  // A5 / CORREÇÃO 4: Resolução defensiva do telefone do remetente via identificadores alternativos e mapeamento
  const sessionMgr = getSessionManager();
  let authDir = null;
  try {
    authDir = sessionMgr.getSalonSessionDir(uid);
  } catch (_) {}

  const cleanPhone = phoneUtils.extractSenderPhone(msg, authDir);
  if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 13) {
    if (senderJid.includes('@lid')) {
      console.warn(`[salonIncomingDispatcher] Mensagem @lid ignorada: impossível mapear para telefone E.164 válido (#${uid}).`);
    }
    return false;
  }

  // A5: Validação estrita da Whitelist de Homologação (Fail-Closed)
  if (!sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
    console.warn(`[salonIncomingDispatcher] STAGING: Remetente ${phoneUtils.maskPhoneNumber(cleanPhone)} não autorizado na whitelist para salão #${uid}. Mensagem descartada.`);
    return false;
  }

  const audioNode = extractAudioNode(msg.message);
  let text = extractMessageText(msg.message);

  // 1. Defesa primária: se não há texto nem nó de áudio, descartar silenciosamente
  if (!text && !audioNode) {
    return false;
  }

  let isAudioMessage = false;

  // 2. Tratamento especializado para mensagem de áudio (COMANDO 068)
  if (audioNode) {
    // 2.1 Feature Flag: process.env.JESSICA_AUDIO_ENABLED === 'true'
    if (process.env.JESSICA_AUDIO_ENABLED !== 'true') {
      console.info(`[salonIncomingDispatcher] Áudio recebido mas JESSICA_AUDIO_ENABLED não está ativo. Ignorando silenciosamente (#${uid}).`);
      return false;
    }

    // 2.2 Metadados defensivos ANTES de qualquer download em memória:
    const rawFileLength = (audioNode.fileLength !== undefined && audioNode.fileLength !== null) ? Number(audioNode.fileLength) : null;
    if (Number.isFinite(rawFileLength) && rawFileLength > jessicaAudioService.MAX_AUDIO_BYTES) {
      if (sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
        await sock.sendMessage(senderJid, {
          text: 'Opa! 😊 Este áudio é um pouco grande demais para eu ouvir por aqui (máximo de 5MB). Você poderia enviar um áudio mais curtinho ou me mandar por mensagem escrita o que precisa? Vou adorar te atender!',
        });
      }
      return true;
    }

    const rawSeconds = (audioNode.seconds !== undefined && audioNode.seconds !== null) ? Number(audioNode.seconds) : null;
    const durationSeconds = (Number.isFinite(rawSeconds) && rawSeconds > 0) ? rawSeconds : 0;
    if (Number.isFinite(rawSeconds) && rawSeconds > jessicaAudioService.MAX_AUDIO_SECONDS) {
      if (sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
        await sock.sendMessage(senderJid, {
          text: 'Opa! 😊 Este áudio é um pouco longo para eu ouvir por aqui (máximo de 2 minutos). Você poderia enviar um áudio mais curtinho ou me escrever o que você precisa? Vou adorar te atender!',
        });
      }
      return true;
    }

    const rawMime = String(audioNode.mimetype || '').trim().toLowerCase();
    if (!rawMime.startsWith('audio/')) {
      if (sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
        await sock.sendMessage(senderJid, {
          text: 'Desculpa! 😊 Não consegui reconhecer o formato desse arquivo de áudio. Você poderia me enviar uma mensagem de voz comum ou me escrever o que precisa?',
        });
      }
      return true;
    }

    // 2.3 Deduplicação persistente via processed_messages antes do download
    const msgId = msg.key?.id;
    if (msgId) {
      try {
        const existing = db.prepare('SELECT id FROM processed_messages WHERE id = ?').get(msgId);
        if (existing) {
          return false;
        }
        db.prepare('INSERT OR IGNORE INTO processed_messages (id, sender_jid) VALUES (?, ?)').run(msgId, senderJid);
      } catch (_) {}
    }

    // 2.4 Download do buffer de áudio em memória via Baileys downloadMediaMessage
    let audioBuffer = null;
    try {
      if (typeof _mockDownloadMediaHandler === 'function') {
        audioBuffer = await _mockDownloadMediaHandler(msg);
      } else {
        const dlFn = baileysModule?.downloadMediaMessage;
        if (typeof dlFn !== 'function') {
          throw new Error('downloadMediaMessage helper não está disponível.');
        }
        audioBuffer = await dlFn(msg, 'buffer', {});
      }
    } catch (dlErr) {
      console.error(`[salonIncomingDispatcher] Falha no download do áudio (#${uid}):`, dlErr.message);
    }

    // Post-Download / In-Flight Buffer Guard (Tier 2 de Defesa da RAM)
    if (audioBuffer && audioBuffer.length > jessicaAudioService.MAX_AUDIO_BYTES) {
      console.warn(`[salonIncomingDispatcher] Áudio baixado excedeu tamanho máximo de 5MB (${audioBuffer.length} bytes > ${jessicaAudioService.MAX_AUDIO_BYTES}). Descartando da RAM.`);
      audioBuffer = null;
      if (sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
        await sock.sendMessage(senderJid, {
          text: 'Opa! 😊 Este áudio é um pouco grande demais para eu ouvir por aqui (máximo de 5MB). Você poderia enviar um áudio mais curtinho ou me mandar por mensagem escrita o que precisa? Vou adorar te atender!',
        });
      }
      return true;
    }

    if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      if (sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
        await sock.sendMessage(senderJid, {
          text: 'Desculpa! 😊 Não consegui entender seu áudio desta vez. Você pode tentar enviar novamente ou me escrever o que precisa? Estou aqui para ajudar!',
        });
      }
      return true;
    }

    // 2.5 Transcrição multimodal inteligente com JessicaAudioService
    let transResult = null;
    try {
      transResult = await jessicaAudioService.transcribeAudio({
        audioBuffer,
        mimeType: audioNode.mimetype,
        seconds: durationSeconds,
      });
    } catch (txErr) {
      console.error(`[salonIncomingDispatcher] Erro inesperado na transcrição de áudio (#${uid}):`, txErr.message);
    }

    if (transResult?.error === 'AUDIO_FILE_TOO_LARGE') {
      if (sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
        await sock.sendMessage(senderJid, {
          text: 'Opa! 😊 Este áudio é um pouco grande demais para eu ouvir por aqui (máximo de 5MB). Você poderia enviar um áudio mais curtinho ou me mandar por mensagem escrita o que precisa? Vou adorar te atender!',
        });
      }
      return true;
    }

    if (transResult?.error === 'AUDIO_DURATION_EXCEEDED') {
      if (sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
        await sock.sendMessage(senderJid, {
          text: 'Opa! 😊 Este áudio é um pouco longo para eu ouvir por aqui (máximo de 2 minutos). Você poderia enviar um áudio mais curtinho ou me escrever o que você precisa? Vou adorar te atender!',
        });
      }
      return true;
    }

    const transcribedText = (transResult?.text || '').trim();
    if (!transResult?.success || !transcribedText || transcribedText === '[ININTELIGIVEL]') {
      if (sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
        await sock.sendMessage(senderJid, {
          text: 'Desculpa! 😊 Não consegui entender seu áudio desta vez. Você pode tentar enviar novamente ou me escrever o que precisa? Estou aqui para ajudar!',
        });
      }
      return true;
    }

    text = transcribedText;
    isAudioMessage = true;
  } else {
    // Deduplicação para mensagens de texto padrão
    const msgId = msg.key?.id;
    if (msgId) {
      try {
        const existing = db.prepare('SELECT id FROM processed_messages WHERE id = ?').get(msgId);
        if (existing) {
          return false;
        }
        db.prepare('INSERT OR IGNORE INTO processed_messages (id, sender_jid) VALUES (?, ?)').run(msgId, senderJid);
      } catch (_) {}
    }
  }

  const sessionKey = `${uid}:${cleanPhone}`;

  // 3. Resolução de contexto no escopo estrito do tenant
  const salon = db.prepare(`
    SELECT salon_name, opening_hours, phone, address
    FROM client_salons
    WHERE user_id = ?
  `).get(uid);

  const salonName = salon?.salon_name || 'Nosso Espaço de Beleza';

  const services = db.prepare(`
    SELECT id, name, price, duration_min, category
    FROM client_services
    WHERE user_id = ? AND active = 1
    ORDER BY category ASC, name ASC
  `).all(uid);

  const staffList = db.prepare(`
    SELECT id, name, active, days_off
    FROM client_staff
    WHERE user_id = ? AND active = 1
    ORDER BY id ASC
  `).all(uid);

  // Atualizar sessão em memória
  const now = Date.now();
  let session = customerSessions.get(sessionKey);
  if (!session) {
    const rawPushName = (msg.pushName || '').trim();
    session = {
      salonUserId: uid,
      customerPhone: cleanPhone,
      customerName: isValidCustomerName(rawPushName) ? rawPushName : 'Cliente WhatsApp',
      state: 'IDLE',
      startedAt: now,
      lastActivity: now,
      messageCount: 0,
      selectedService: null,
      candidateServices: null,
      selectedStaff: null,
      availableStaffList: [],
      candidateSlots: [],
      selectedSlot: null,
      lastOrigin: isAudioMessage ? 'whatsapp_audio' : 'whatsapp_text',
    };
    customerSessions.set(sessionKey, session);
  } else {
    if (msg.pushName && (!session.customerName || session.customerName === 'Cliente WhatsApp' || !isValidCustomerName(session.customerName))) {
      const candidateName = msg.pushName.trim();
      if (isValidCustomerName(candidateName)) {
        session.customerName = candidateName;
      }
    }
  }
  session.lastActivity = now;
  session.lastOrigin = isAudioMessage ? 'whatsapp_audio' : 'whatsapp_text';
  session.messageCount++;

  // 4. Normalização do texto
  const normText = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  let replyText = '';

  // 5. Verificação Universal de Revogação de Lembretes (LGPD Opt-out fora do diálogo de opt-in)
  const isRevocation = session.state !== 'AWAITING_REMINDER_OPTIN' && /(parar lembretes|cancelar lembretes|revogar lembretes|sem lembretes|nao quero lembretes|parar lembrete|cancelar lembrete)/i.test(normText);
  if (isRevocation) {
    const salonReminderService = require('../services/salonReminderService');
    salonReminderService.revokeClientConsent(uid, cleanPhone, 'Opt-out solicitado pelo cliente via WhatsApp');
    session.state = 'IDLE';
    session.lastAppointmentId = null;
    replyText = `Entendido! Seus lembretes automáticos de WhatsApp foram cancelados com sucesso. ✨\n\nSeus agendamentos marcados continuam confirmados. Se desejar reativar os lembretes futuramente, é só nos avisar!`;
    try {
      if (!sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) return false;
      await sock.sendMessage(senderJid, { text: replyText });
      return true;
    } catch (_) {
      return false;
    }
  }

  // 5.1 Verificação de Cancelamento/Desistência durante o fluxo de agendamento em andamento
  const isBookingFlowActive = ['AWAITING_SERVICE', 'AWAITING_STAFF', 'AWAITING_SLOT', 'AWAITING_NAME', 'AWAITING_CONFIRMATION'].includes(session.state);
  const isCancellation = /^(cancelar|cancela|cancelamento|desisto|sair|parar|deixa pra la|deixa para la)\b/i.test(normText);
  if (isBookingFlowActive && isCancellation) {
    session.state = 'IDLE';
    session.selectedService = null;
    session.candidateServices = null;
    session.selectedStaff = null;
    session.availableStaffList = [];
    session.candidateSlots = [];
    session.selectedSlot = null;
    session.lastAppointmentId = null;
    session.requestedDatePref = null;
    session.requestedPeriod = null;
    session.requestedTimeConstraint = null;

    replyText = `Tudo bem! O agendamento foi cancelado. Se você precisar de qualquer informação sobre nossos serviços ou quiser agendar em outro momento, estarei à sua disposição! ✨`;
    try {
      if (!sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) return false;
      await sock.sendMessage(senderJid, { text: replyText });
      return true;
    } catch (err) {
      return false;
    }
  }

  // 5.2 Execução Opcional da Jéssica Conversacional 2.0 (Sob Feature Flag e Timeout)
  const isV2Enabled = process.env.JESSICA_CONVERSATIONAL_V2 === 'true';
  if (isV2Enabled) {
    try {
      const nluResult = await jessicaNluService.parseMessage({
        text,
        salonName,
        services,
        staffList,
        session,
      });
      const v2Response = await handleConversationalV2({
        nluResult,
        uid,
        cleanPhone,
        salonName,
        salon,
        services,
        staffList,
        session,
        text,
        normText,
      });
      if (v2Response) {
        replyText = v2Response;
      }
    } catch (v2Err) {
      console.warn(`[salonIncomingDispatcher] Jéssica V2 NLU falhou ou expirou (${v2Err.message}). Fallback determinístico acionado com sucesso.`);
    }
  }

  // 5.3 Consulta Comercial durante agendamento em andamento (Determinístico Fallback)
  const isBookingFlowActiveWithoutService = ['AWAITING_STAFF', 'AWAITING_SLOT', 'AWAITING_NAME', 'AWAITING_CONFIRMATION'].includes(session.state);
  const activeCommercialCheck = parseCommercialInquiry(normText);
  if (!replyText && isBookingFlowActiveWithoutService && activeCommercialCheck.isCommercial) {
    let priceInfo = '';
    if (activeCommercialCheck.isFullCatalog) {
      priceInfo = formatCommercialCatalogMessage(services, salonName);
    } else {
      const qTerm = activeCommercialCheck.queryTerm || text;
      const resMatch = resolveServiceMatch(services, qTerm);
      if (resMatch.status === 'EXACT') {
        const s = resMatch.match;
        const dur = s.duration_min ? ` (duração estimada de ${s.duration_min} minutos)` : '';
        priceInfo = `O procedimento *${s.name}* no *${salonName}* custa *R$ ${formatPrice(s.price)}*${dur}.`;
      } else if (resMatch.status === 'AMBIGUOUS') {
        const candidateList = resMatch.candidates
          .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
          .join('\n');
        priceInfo = `Temos mais de uma opção para esse serviço no *${salonName}*:\n\n${candidateList}`;
      } else {
        priceInfo = formatCommercialCatalogMessage(services, salonName);
      }
    }
    replyText = buildActiveStatePriceResponse(priceInfo, session);
  }

  // 6. Máquina de Estados Conversacionais da Jéssica
  if (!replyText) {
  switch (session.state) {
    case 'AWAITING_RESCHEDULE_OR_NEW': {
      const isRemarcar = /\b(remarcar|mudar|trocar|o\s+(que\s+)?acabamos\s+de\s+confirmar|o\s+de\s+agora|esse\s+mesmo)\b/i.test(normText);
      const isNovo = /\b(novo|marcar\s+(um\s+)?novo|novo\s+atendimento|outro\s+atendimento|outro|mais\s+um)\b/i.test(normText);

      if (isRemarcar) {
        replyText = await dispatchRescheduleHandoff(uid, cleanPhone, session, salon);
        break;
      }

      if (isNovo) {
        session.state = 'IDLE';
        session.lastAppointmentId = null;
        session.lastConfirmedAppointmentId = null;
        session.isRescheduling = false;
        replyText = `Combinado! O seu agendamento anterior continua confirmado com carinho. ✨ Para o novo atendimento, qual serviço você gostaria de agendar?`;
        break;
      }

      session.state = 'IDLE';
      session.lastAppointmentId = null;
      session.lastConfirmedAppointmentId = null;
      break;
    }

    case 'AWAITING_SERVICE': {
      const comm = parseCommercialInquiry(normText);
      if (comm.isCommercial && comm.isFullCatalog) {
        replyText = formatCommercialCatalogMessage(services, salonName);
        break;
      }

      const serviceResolution = resolveServiceMatch(services, text, session.candidateServices);

      if (serviceResolution.status === 'AMBIGUOUS') {
        session.candidateServices = serviceResolution.candidates;
        const candidateList = serviceResolution.candidates
          .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
          .join('\n');
        replyText = `Identifiquei mais de uma opção correspondente ao seu pedido no *${salonName}*:\n\n${candidateList}\n\nQual dessas opções você prefere? Me conta para eu já checar os horários! ✨`;
        break;
      }

      if (serviceResolution.status !== 'EXACT') {
        const listToDisplay = (session.candidateServices && session.candidateServices.length > 0)
          ? session.candidateServices
          : services;
        const serviceMenu = listToDisplay.map((s, i) => `• *${s.name}* — R$ ${formatPrice(s.price)}`).join('\n');
        replyText = `Não consegui identificar o serviço desejado. Me confirma qual desses procedimentos você gostaria de fazer:\n\n${serviceMenu}\n\nÉ só me falar o nome ou como preferir! ✨`;
        break;
      }

      const matchedService = serviceResolution.match;
      session.selectedService = matchedService;
      session.candidateServices = null;

      // Resolução de Profissionais Habilitados para o Serviço (Comando 040)
      const qualifiedStaff = getQualifiedStaffForService(uid, matchedService.id);

      if (qualifiedStaff.length === 0) {
        session.state = 'IDLE';
        session.selectedService = null;
        session.candidateServices = null;
        replyText = `Adoraríamos te atender para *${matchedService.name}*, mas no momento não temos profissionais com agenda aberta para este procedimento. Nossa equipe entrará em contato em instantes! ✨`;
      } else if (qualifiedStaff.length === 1) {
        session.selectedStaff = qualifiedStaff[0];
        const targetDays = resolveCandidateDays(session.requestedDatePref);
        let slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff, targetDays);
        if (session.requestedPeriod || session.requestedTimeConstraint) {
          slots = filterSlotsByPreference(slots, session.requestedPeriod, session.requestedTimeConstraint);
        }

        if (slots.length > 0) {
          session.candidateSlots = slots;
          session.state = 'AWAITING_SLOT';
          const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
          replyText = `Excelente escolha: *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}) com a *${qualifiedStaff[0].name}*! ✨\n\nSeparei estes horários livres mais próximos para você:\n\n${slotList}\n\nAlgum desses horários fica bom para você? Me conta por aqui!`;
        } else {
          session.state = 'IDLE';
          const timeTargetDesc = formatTemporalTarget(session.requestedDatePref, session.requestedPeriod);
          if (timeTargetDesc) {
            replyText = `Não encontramos horários disponíveis para ${timeTargetDesc} para *${matchedService.name}* com ${qualifiedStaff[0].name}. Gostaria de verificar em outro turno ou dia? Me avise para eu pesquisar para você! ✨`;
          } else {
            replyText = `No momento não encontramos horários disponíveis nos próximos dias para *${matchedService.name}* com ${qualifiedStaff[0].name}. Nossa equipe entrará em contato em breve para verificar um encaixe especial para você! ✨`;
          }
        }
      } else {
        session.availableStaffList = qualifiedStaff;
        session.state = 'AWAITING_STAFF';
        const staffMenu = qualifiedStaff.map((st, i) => `${i + 1}. *${st.name}*`).join('\n');
        replyText = `Perfeito! Você escolheu *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}).\n\nCom qual de nossas profissionais você gostaria de realizar o atendimento?\n\n${staffMenu}\n${qualifiedStaff.length + 1}. *Qualquer profissional disponível*\n\nPode me dizer o nome da sua preferência ou se prefere o primeiro horário livre! ✨`;
      }
      break;
    }

    case 'AWAITING_STAFF': {
      const available = session.availableStaffList || staffList;
      const num = parseInt(normText, 10);
      let chosenStaff = null;

      if (REGEX_WANTS_ANY_STAFF.test(normText) || num === (available.length + 1)) {
        chosenStaff = null;
      } else if (!isNaN(num) && num >= 1 && num <= available.length) {
        chosenStaff = available[num - 1];
      } else {
        // Matching por nome do profissional
        chosenStaff = available.find((st) => {
          const stNorm = st.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          return normText.includes(stNorm) || stNorm.includes(normText);
        }) || undefined;
      }

      if (chosenStaff === undefined) {
        const staffMenu = available.map((st, i) => `${i + 1}. *${st.name}*`).join('\n');
        replyText = `Não entendi a opção escolhida. Nossas profissionais disponíveis são:\n\n${staffMenu}\n${available.length + 1}. *Qualquer profissional disponível*\n\nPode me dizer o nome de quem você prefere ou se pode ser qualquer uma da equipe! ✨`;
        break;
      }

      session.selectedStaff = chosenStaff;
      const targetDays = resolveCandidateDays(session.requestedDatePref);
      let slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff, targetDays);
      if (session.requestedPeriod || session.requestedTimeConstraint) {
        slots = filterSlotsByPreference(slots, session.requestedPeriod, session.requestedTimeConstraint);
      }

      if (slots.length > 0) {
        session.candidateSlots = slots;
        session.state = 'AWAITING_SLOT';
        replyText = formatCandidateSlotsMessage(slots, session.selectedService, session.selectedStaff, session.requestedPeriod);
      } else {
        session.state = 'IDLE';
        const timeTargetDesc = formatTemporalTarget(session.requestedDatePref, session.requestedPeriod);
        if (timeTargetDesc) {
          replyText = `Não encontramos horários disponíveis para ${timeTargetDesc} para esta combinação. Gostaria de verificar em outro turno ou dia? Me avise para eu pesquisar para você! ✨`;
        } else {
          replyText = `Não encontramos horários livres nos próximos dias para esta combinação. Gostaria de verificar com outra profissional ou para uma data mais adiante? Me avise para eu pesquisar para você! ✨`;
        }
      }
      break;
    }

    case 'AWAITING_SLOT': {
      const slots = session.candidateSlots || [];
      const pickedSlot = resolveSlotSelection(slots, normText, null);

      if (!pickedSlot) {
        const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
        replyText = `Por favor, selecione um dos horários informados:\n\n${slotList}\n\nQual deles fica melhor para você? ✨`;
        break;
      }

      session.selectedSlot = { date: pickedSlot.date, time: pickedSlot.time };

      // Se o cliente escolheu "Qualquer profissional disponível", resolver atomicamente agora
      if (!session.selectedStaff) {
        try {
          const eff = salonAppointmentService.resolveEffectiveStaff(uid, {
            serviceId: session.selectedService.id,
            staffId: null,
            date: pickedSlot.date,
            time: pickedSlot.time,
            durationMin: session.selectedService.duration_min,
          });
          session.selectedStaff = { id: eff.staffId, name: eff.staffName };
        } catch (_) {}
      }

      const displayDate = formatDisplayDate(pickedSlot.date);
      const staffName = session.selectedStaff ? session.selectedStaff.name : 'Equipe do Salão';
      const priceFormatted = formatPrice(session.selectedService.price);

      const hasValidName = isValidCustomerName(session.customerName);
      if (hasValidName) {
        session.state = 'AWAITING_CONFIRMATION';
        replyText = `Perfeito! Encontrei esse horário para você! ✨\n\n` +
          `📍 *Espaço:* ${salonName}\n` +
          `💇‍♀️ *Serviço:* ${session.selectedService.name}\n` +
          `👤 *Profissional:* ${staffName}\n` +
          `📅 *Data:* ${displayDate} (${pickedSlot.dayLabel.split(' ')[0]})\n` +
          `⏰ *Horário:* ${pickedSlot.time}\n` +
          `💰 *Valor:* R$ ${priceFormatted}\n\n` +
          `Posso confirmar o seu agendamento? 🥰`;
        break;
      }

      session.state = 'AWAITING_NAME';
      replyText = `Perfeito! Encontrei esse horário para você! ✨\n\n` +
        `📍 *Espaço:* ${salonName}\n` +
        `💇‍♀️ *Serviço:* ${session.selectedService.name}\n` +
        `👤 *Profissional:* ${staffName}\n` +
        `📅 *Data:* ${displayDate} (${pickedSlot.dayLabel.split(' ')[0]})\n` +
        `⏰ *Horário:* ${pickedSlot.time}\n` +
        `💰 *Valor:* R$ ${priceFormatted}\n\n` +
        `Perfeito! Antes de confirmar, pode me informar seu nome, por favor? 😊`;
      break;
    }

    case 'AWAITING_NAME': {
      const isAffirmationWithoutName = /^(sim|confirmo|pode agendar|pode sim|pode confirmar|pode|agendar|ok|confirma|com certeza|positivo|pode ser|1|claro|isso)\b/i.test(normText);
      const cleanedName = extractCleanCustomerName(text);

      if (isAffirmationWithoutName && !isValidCustomerName(cleanedName)) {
        replyText = `Para eu deixar reservadinho na sua ficha, qual é o seu nome completo, por favor? 😊`;
        break;
      }

      if (isValidCustomerName(cleanedName)) {
        session.customerName = cleanedName;
        session.state = 'AWAITING_CONFIRMATION';
        const displayDate = formatDisplayDate(session.selectedSlot?.date);
        replyText = `Obrigada, ${session.customerName}! 🥰 Agora sim, posso confirmar o seu agendamento para ${displayDate} às ${session.selectedSlot?.time}? ✨`;
        break;
      }

      // Se enviar caracteres inválidos, símbolos ou ruídos sem nome válido
      replyText = `Para eu deixar reservadinho na sua ficha, qual é o seu nome completo, por favor? 😊`;
      break;
    }

    case 'AWAITING_CONFIRMATION': {
      const isAffirmative = /^(sim|confirmo|pode agendar|pode sim|pode confirmar|pode|agendar|ok|confirma|com certeza|positivo|pode ser|1)\b/i.test(normText);
      const isNegative = /^(nao|não|cancelar|cancela|desisto|deixa)\b/i.test(normText);

      if (isNegative) {
        session.state = 'IDLE';
        session.selectedService = null;
        session.candidateServices = null;
        session.selectedStaff = null;
        session.candidateSlots = [];
        session.selectedSlot = null;
        session.requestedDatePref = null;
        session.requestedPeriod = null;
        session.requestedTimeConstraint = null;
        replyText = `Tudo bem! O agendamento foi cancelado. Se quiser agendar em outro momento, estarei por aqui! ✨`;
        break;
      }

      if (!isAffirmative) {
        replyText = `Posso confirmar esse horário para você ou prefere fazer alguma alteração? ✨`;
        break;
      }

      // Executa o agendamento real e atômico via salonAppointmentService
      try {
        // Defesa Anti-IDOR (Proteção 01 e 17 - OWASP ASVS 5.0)
        const validService = db.prepare(`
          SELECT id, name, price, duration_min
          FROM client_services
          WHERE id = ? AND user_id = ? AND active = 1
        `).get(session.selectedService.id, uid);

        if (!validService) {
          throw new Error('SECURITY_VIOLATION_IDOR: Tentativa de agendamento em serviço inválido ou não pertencente ao salão.');
        }

        // Garantir resolução nominal estrita de staffId antes de invocar bookAppointment
        let finalStaffId = session.selectedStaff ? session.selectedStaff.id : null;
        if (!finalStaffId) {
          const eff = salonAppointmentService.resolveEffectiveStaff(uid, {
            serviceId: validService.id,
            staffId: null,
            date: session.selectedSlot.date,
            time: session.selectedSlot.time,
            durationMin: validService.duration_min,
          });
          finalStaffId = eff.staffId;
          session.selectedStaff = { id: eff.staffId, name: eff.staffName };
        }

        if (finalStaffId) {
          const validStaff = db.prepare(`
            SELECT id, name
            FROM client_staff
            WHERE id = ? AND user_id = ? AND active = 1
          `).get(finalStaffId, uid);

          if (!validStaff) {
            throw new Error('SECURITY_VIOLATION_IDOR: Tentativa de agendamento com profissional inválido ou não pertencente ao salão.');
          }
        }

        const dispatcherProof = generateDispatcherBookingProof(uid, cleanPhone);
        const booked = await salonAppointmentService.bookAppointment(uid, {
          clientName: session.customerName || 'Cliente WhatsApp',
          clientPhone: cleanPhone,
          serviceId: validService.id,
          staffId: finalStaffId,
          date: session.selectedSlot.date,
          time: session.selectedSlot.time,
          durationMin: validService.duration_min,
          origin: 'WHATSAPP_BOT',
      inputModality: (session.lastOrigin === 'whatsapp_audio') ? 'audio' : 'text',
          dispatcherProof,
          reminderConsent: 0,
          reminderConsentOrigin: null,
        });

        const displayDate = formatDisplayDate(session.selectedSlot.date);
        const staffName = session.selectedStaff ? session.selectedStaff.name : (booked?.staff_name || 'Equipe do Salão');
        const priceFormatted = formatPrice(session.selectedService.price);
        const confirmedTime = session.selectedSlot.time;

        // Cálculo da diferença em horas até o atendimento (COMANDO 058)
        let diffHours = 48;
        try {
          const [aptYear, aptMonth, aptDay] = session.selectedSlot.date.split('-').map(Number);
          const [aptHour, aptMin] = session.selectedSlot.time.split(':').map(Number);
          if (!isNaN(aptYear) && !isNaN(aptMonth) && !isNaN(aptDay)) {
            const appointmentDateObj = new Date(aptYear, aptMonth - 1, aptDay, aptHour || 0, aptMin || 0, 0);
            diffHours = (appointmentDateObj.getTime() - Date.now()) / (3600 * 1000);
          }
        } catch (_) {}

        session.selectedService = null;
        session.candidateServices = null;
        session.selectedStaff = null;
        session.candidateSlots = [];
        session.selectedSlot = null;
        session.requestedDatePref = null;
        session.requestedPeriod = null;
        session.requestedTimeConstraint = null;

        if (diffHours >= 24) {
          session.state = 'AWAITING_REMINDER_OPTIN';
          session.lastAppointmentId = booked.id;

          replyText = `🎉 *Agendamento confirmado com sucesso!* 🎉\n\n` +
            `Estamos muito felizes em te receber no *${salonName}*! ✨\n\n` +
            `📋 *Detalhes do seu Atendimento:*\n` +
            `• *Espaço:* ${salonName}\n` +
            `• *Serviço:* ${validService.name}\n` +
            `• *Profissional:* ${staffName}\n` +
            `• *Data:* ${displayDate}\n` +
            `• *Horário:* ${confirmedTime}\n` +
            `• *Valor:* R$ ${priceFormatted}\n\n` +
            `🔔 *Lembrete 24h por WhatsApp (Opcional):*\n` +
            `Você gostaria de receber um lembrete automático por aqui 24 horas antes do seu horário?\n` +
            `• Digite *Sim* ou *1* para autorizar o lembrete\n` +
            `• (Se não quiser, não precisa responder nada — seu agendamento já está confirmado!)\n\n` +
            `Caso precise remarcar ou tirar dúvidas, pode me chamar por aqui a qualquer momento. Até breve! 💖`;
        } else {
          session.state = 'IDLE';
          session.lastAppointmentId = null;

          replyText = `🎉 *Agendamento confirmado com sucesso!* 🎉\n\n` +
            `Estamos muito felizes em te receber no *${salonName}*! ✨\n\n` +
            `📋 *Detalhes do seu Atendimento:*\n` +
            `• *Espaço:* ${salonName}\n` +
            `• *Serviço:* ${validService.name}\n` +
            `• *Profissional:* ${staffName}\n` +
            `• *Data:* ${displayDate}\n` +
            `• *Horário:* ${confirmedTime}\n` +
            `• *Valor:* R$ ${priceFormatted}\n\n` +
            `Como seu atendimento já é nas próximas horas, nos vemos em breve no *${salonName}*! 💖`;
        }
      } catch (bookErr) {
        console.error(`[salonIncomingDispatcher] Erro ao concluir agendamento #${uid}:`, bookErr.message);
        session.state = 'IDLE';
        session.selectedService = null;
        session.candidateServices = null;
        session.selectedStaff = null;
        session.candidateSlots = [];
        session.selectedSlot = null;
        session.requestedDatePref = null;
        session.requestedPeriod = null;
        session.requestedTimeConstraint = null;
        replyText = `Puxa, parece que esse horário acabou de ser reservado: ${bookErr.message}\n\nQuer tentar outro horário? É só me falar! ✨`;
      }
      break;
    }

    case 'AWAITING_RESCHEDULE_OR_NEW': {
      const isRemarcar = /\b(remarcar|mudar|trocar|o\s+(que\s+)?acabamos\s+de\s+confirmar|o\s+de\s+agora|esse\s+mesmo)\b/i.test(normText);
      const isNovo = /\b(novo|marcar\s+(um\s+)?novo|novo\s+atendimento|outro\s+atendimento|outro|mais\s+um)\b/i.test(normText);

      if (isRemarcar) {
        replyText = await dispatchRescheduleHandoff(uid, cleanPhone, session, salon);
        break;
      }

      if (isNovo) {
        session.state = 'IDLE';
        replyText = `Combinado! O seu agendamento anterior continua confirmado com carinho. ✨ Para o novo atendimento, qual serviço você gostaria de agendar?`;
        break;
      }

      session.state = 'IDLE';
      break;
    }

    case 'AWAITING_REMINDER_OPTIN': {
      // Zero-Trust: Falsos positivos
      const isFalsePositive =
        /^(eu\s+)?quero\s*$/i.test(normText) ||
        /^(eu\s+)?quero\s+receber\s*$/i.test(normText) ||
        /\b(orcamento|orçamento|catalogo|catálogo|valores?|precos?|preços?|tabela|menu)\b/i.test(normText) ||
        /quero\s+(agendar|marcar|mudar|ver|trocar|outro|outra|fazer|cancelar|saber)\b/i.test(normText) ||
        /pode\s+(mandar|enviar)\s+(os?\s+)?(valores?|precos?|preços?|orcamentos?|orçamentos?|catalogo|catálogo)/i.test(normText) ||
        /mostre\s+os\s+servicos/i.test(normText) ||
        /\b(nao|não)\s+quero\b/i.test(normText) ||
        /\bsem\s+lembrete/i.test(normText);

      // 1. Recusa ou cancelamento de lembretes (precedência estrita)
      const isNegative =
        /^(nao|não|2|dispensa|cancelar|deixa pra la|deixa)\b/i.test(normText) ||
        /\b(nao|não)\s+quero(\s+lembrete)?/i.test(normText) ||
        /\bsem\s+lembrete/i.test(normText);

      if (isNegative || /^(eu\s+)?quero\s*$/i.test(normText)) {
        session.state = 'IDLE';
        session.lastAppointmentId = null;
        replyText = `Tudo bem! Seu agendamento permanece confirmado normalmente sem lembretes automáticos. Se precisar de qualquer informação, estarei por aqui! ✨`;
        break;
      }

      // 2. Afirmação inequívoca de consentimento no contexto da pergunta sobre lembretes
      const isAffirmative =
        !isFalsePositive && (
          /^(1|sim|com certeza|positivo|autorizo|pode sim|claro)\s*(!|\.|\?)*$/i.test(normText) ||
          /^(sim,?\s*)?(quero|pode enviar|ativar|autorizo)\s+(o\s+|os\s+)?lembrete(s)?\b/i.test(normText) ||
          /^(sim,?\s*)?quero\s+receber\s+(o\s+|os\s+)?lembrete(s)?\b/i.test(normText) ||
          /^(sim,?\s*)?pode\s+(enviar|mandar)\s+(o\s+|os\s+)?lembrete(s)?\b/i.test(normText) ||
          /^(sim,?\s*)?pode\s+(mandar|enviar)\s*(por favor|sim)?\s*(!|\.|\?)*$/i.test(normText)
        );

      if (isAffirmative && session.lastAppointmentId) {
        const salonReminderService = require('../services/salonReminderService');
        salonAppointmentService.updateAppointmentConsent(session.lastAppointmentId, uid, 1, 'whatsapp_bot_optin');
        salonReminderService.registerClientConsent(uid, cleanPhone, 'whatsapp_bot_optin');

        session.state = 'IDLE';
        session.lastAppointmentId = null;
        replyText = `Combinado! Lembrete de 24h ativado com sucesso. ✨\n\nCaso queira cancelar os lembretes no futuro, é só me avisar ou enviar *Parar lembretes* a qualquer momento.\n\nNos vemos em breve no *${salonName}*! 💖`;
        break;
      }

      // 3. Se a mensagem for outra solicitação da cliente, encerra o opt-in e processa no IDLE
      session.state = 'IDLE';
      session.lastAppointmentId = null;
      // Fallthrough intencional para case 'IDLE' atender a nova solicitação imediatamente
    }

    case 'IDLE':
    default: {
      const commercial = parseCommercialInquiry(normText);
      const isGreeting = /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|como vai|opa|oie)\b/i.test(normText);
      const isRescheduleDirect = /\b(remarcar|remarca[çc][aã]o|mudar\s+(o\s+)?(hor[aá]rio|dia|data)|trocar\s+(o\s+)?(hor[aá]rio|dia|data))\b/i.test(normText);
      if (isRescheduleDirect) {
        replyText = await dispatchRescheduleHandoff(uid, cleanPhone, session, salon);
        break;
      }

      // Precedência Absoluta Comercial (COMANDO 067): Catálogo e preços reais respondidos antes de agendamento
      if (commercial.isCommercial) {
        if (commercial.isFullCatalog) {
          replyText = formatCommercialCatalogMessage(services, salonName);
        } else {
          const queryTerm = commercial.queryTerm || text;
          const resMatch = resolveServiceMatch(services, queryTerm);
          if (resMatch.status === 'EXACT') {
            const s = resMatch.match;
            const dur = s.duration_min ? ` (duração estimada de ${s.duration_min} minutos)` : '';
            replyText = `O procedimento *${s.name}* no *${salonName}* custa *R$ ${formatPrice(s.price)}*${dur}.\n\nGostaria de verificar os horários disponíveis para agendar? É só me falar o dia de sua preferência! ✨`;
          } else if (resMatch.status === 'AMBIGUOUS') {
            session.candidateServices = resMatch.candidates;
            session.state = 'AWAITING_SERVICE';
            const candidateList = resMatch.candidates
              .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
              .join('\n');
            replyText = `Temos mais de uma opção para esse serviço no *${salonName}*:\n\n${candidateList}\n\nQual dessas opções você prefere? Me conta para eu já checar os horários! ✨`;
          } else {
            replyText = formatCommercialCatalogMessage(services, salonName);
          }
        }
        break;
      }

      const isScheduleInquiry = isSchedulingOrCareIntent(normText);
      const temporal = extractDeterministicTemporal(normText);

      if (temporal.datePref) session.requestedDatePref = temporal.datePref;
      if (temporal.periodPref) session.requestedPeriod = temporal.periodPref;

      // Matching direto de agendamento na primeira mensagem (ex: "gostaria de agendar para cortar meu cabelo")
      if (isScheduleInquiry) {
        const serviceResolution = resolveServiceMatch(services, text, session.candidateServices);

        if (serviceResolution.status === 'EXACT') {
          const matchedService = serviceResolution.match;
          session.selectedService = matchedService;
          session.candidateServices = null;

          // Resolução de Profissionais Habilitados para o Serviço (Comando 040)
          const qualifiedStaff = getQualifiedStaffForService(uid, matchedService.id);

          if (qualifiedStaff.length === 0) {
            session.state = 'IDLE';
            session.selectedService = null;
            session.candidateServices = null;
            replyText = `Olá! Adoraríamos te atender para *${matchedService.name}*, mas no momento não temos profissionais disponíveis habilitadas para este serviço. Nossa equipe entrará em contato com você em instantes! ✨`;
          } else {
            const wantsAny = REGEX_WANTS_ANY_STAFF.test(normText);
            if (qualifiedStaff.length === 1 || wantsAny) {
              session.selectedStaff = qualifiedStaff.length === 1 && !wantsAny ? qualifiedStaff[0] : null;
              const targetDays = resolveCandidateDays(session.requestedDatePref);
              let slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff, targetDays);
              if (session.requestedPeriod || session.requestedTimeConstraint) {
                slots = filterSlotsByPreference(slots, session.requestedPeriod, session.requestedTimeConstraint);
              }
              if (slots.length > 0) {
                session.candidateSlots = slots;
                session.state = 'AWAITING_SLOT';
                replyText = formatCandidateSlotsMessage(slots, session.selectedService, session.selectedStaff, session.requestedPeriod);
              } else {
                session.state = 'IDLE';
                const timeTargetDesc = formatTemporalTarget(session.requestedDatePref, session.requestedPeriod);
                if (timeTargetDesc) {
                  replyText = `Olá! Adoraríamos te atender para *${matchedService.name}* ${timeTargetDesc}, mas no momento não encontramos horários disponíveis. Gostaria de verificar em outro turno ou dia? Me avise para eu pesquisar para você! ✨`;
                } else {
                  replyText = `Olá! Adoraríamos te atender para *${matchedService.name}*, mas no momento não encontramos horários disponíveis nos próximos dias. Nossa equipe entrará em contato com você em instantes! ✨`;
                }
              }
            } else {
              session.availableStaffList = qualifiedStaff;
              session.state = 'AWAITING_STAFF';
              const staffMenu = qualifiedStaff.map((st, i) => `${i + 1}. *${st.name}*`).join('\n');
              replyText = `Olá! Seja muito bem-vinda ao *${salonName}*! ✨\n\nIdentifiquei seu interesse em *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}).\n\nCom qual de nossas profissionais você gostaria de realizar o atendimento?\n\n${staffMenu}\n${qualifiedStaff.length + 1}. *Qualquer profissional disponível*\n\nPode me dizer o nome da sua preferência ou se prefere o primeiro horário livre! ✨`;
            }
          }
        } else if (serviceResolution.status === 'AMBIGUOUS') {
          session.candidateServices = serviceResolution.candidates;
          session.state = 'AWAITING_SERVICE';
          const candidateList = serviceResolution.candidates
            .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
            .join('\n');
          replyText = `Olá! Seja bem-vinda ao *${salonName}*! ✨\n\nIdentifiquei mais de uma opção correspondente ao seu pedido:\n\n${candidateList}\n\nQual dessas opções você prefere? Me conta para eu já checar os horários! ✨`;
        } else {
          // Não especificou o serviço ainda: acolhimento humanizado com retenção de data/turno
          session.state = 'AWAITING_SERVICE';
          session.candidateServices = null;
          const timeTarget = formatTemporalTarget(session.requestedDatePref, session.requestedPeriod);
          if (timeTarget) {
            replyText = `Oii! Tudo bem? 😊 Claro, posso verificar para ${timeTarget}! Qual procedimento você está pensando em fazer?`;
          } else if (services && services.length > 0) {
            const serviceMenu = services.map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`).join('\n');
            replyText = `Com certeza! Seja bem-vinda ao *${salonName}*! ✨\n\nPara qual serviço você gostaria de agendar seu horário?\n\n${serviceMenu}\n\nÉ só me falar o nome ou como preferir!`;
          } else {
            replyText = `Oii! Tudo bem? 😊 Claro, posso verificar para você! Qual procedimento você está pensando em fazer?`;
          }
        }
      } else if (isGreeting && session.messageCount === 1) {
        replyText = `Olá! Tudo bem? Seja muito bem-vinda ao *${salonName}*! ✨\n\nEu sou a Jéssica. Como posso te ajudar hoje? Se você quiser agendar um horário ou saber mais sobre nossos serviços, é só me falar!`;
      } else {
        replyText = `Olá! Como posso te ajudar hoje no *${salonName}*? ✨ Se quiser marcar um horário ou tirar dúvidas sobre algum serviço, estou por aqui!`;
      }
      break;
    }
  }
  }

  // 7. Envio da resposta exclusivamente pelo socket do próprio salão
  try {
    if (!sessionMgr.isSalonRealWhatsAppAllowed(uid, cleanPhone)) {
      console.warn(`[salonIncomingDispatcher] STAGING: Envio de resposta bloqueado para ${phoneUtils.maskPhoneNumber(cleanPhone)} (#${uid}).`);
      return false;
    }
    await sock.sendMessage(senderJid, { text: replyText });
    return true;
  } catch (sendErr) {
    console.error(`[salonIncomingDispatcher] Falha ao enviar resposta para #${uid}:`, sendErr.message);
    return false;
  }
}

/**
 * Hook de limpeza para testes herméticos
 */
function _resetForTesting() {
  customerSessions.clear();
  dispatcherProofs.clear();
  _mockDownloadMediaHandler = null;
  jessicaAudioService._resetForTesting();
}

/**
 * Hook para inspeção de sessão em testes herméticos
 */
function _getCustomerSessionForTesting(key) {
  return customerSessions.get(key) || null;
}

module.exports = {
  dispatchMessage,
  extractAudioNode,
  setMockDownloadMediaHandler,
  resetMockDownloadMediaHandler,
  resolveServiceMatch,
  extractDeterministicTemporal,
  formatTemporalTarget,
  isSchedulingOrCareIntent,
  findMatchingService,
  resolveCandidateDays,
  filterSlotsByPreference,
  formatCandidateSlotsMessage,
  dispatchRescheduleHandoff,
  generateDispatcherBookingProof,
  consumeDispatcherBookingProof,
  isValidCustomerName,
  extractCleanCustomerName,
  parseCommercialInquiry,
  formatCommercialCatalogMessage,
  buildActiveStatePriceResponse,
  _resetForTesting,
  _getCustomerSessionForTesting,
};
