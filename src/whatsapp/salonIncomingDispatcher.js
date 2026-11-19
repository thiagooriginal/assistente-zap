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

const db = require('../database/db');
const phoneUtils = require('../utils/phoneUtils');
const salonAppointmentService = require('../services/salonAppointmentService');
const jessicaNluService = require('../services/jessicaNluService');

/**
 * Acesso preguiçoso (lazy) ao salonSessionManager para eliminar advertência de dependência circular
 */
function getSessionManager() {
  return require('./salonSessionManager');
}

// Memória volátil de conversação: `${salonUserId}:${customerPhone}` => State
const customerSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos

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
 * Extrai o texto limpo da mensagem recebida
 * @private
 * @param {object} messageContent
 * @returns {string}
 */
function extractMessageText(messageContent) {
  if (!messageContent) return '';
  return (
    messageContent.conversation ||
    messageContent.extendedTextMessage?.text ||
    messageContent.imageMessage?.caption ||
    messageContent.videoMessage?.caption ||
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
  services,
  staffList,
  session,
  text,
  normText,
}) {
  if (!nluResult || !nluResult.intent) return null;
  const intent = nluResult.intent;

  // 1. Opt-in ou Opt-out de Lembretes 24h (LGPD - Prioridade Absoluta sobre Cancelamento Genérico)
  if (session.state === 'AWAITING_REMINDER_OPTIN' || intent === 'REMINDER_OPTIN') {
    // Zero-Trust: jamais conceder consentimento por mera inferência de IA
    const isFalsePositive =
      /^(eu\s+)?quero\s*$/i.test(normText) ||
      /quero\s+(agendar|marcar|mudar|ver|trocar|outro|fazer|cancelar|saber)/i.test(normText) ||
      /mostre\s+os\s+servicos/i.test(normText) ||
      /\b(nao|não)\s+quero\b/i.test(normText) ||
      /\bsem\s+lembrete/i.test(normText);

    const isExplicitAffirmative =
      !isFalsePositive && (
        /^(1|sim|com certeza|autorizo|pode enviar|pode mandar)\b/i.test(normText) ||
        /^(sim,?\s*)?(quero|pode enviar|pode mandar|ativar|autorizo)\s+(receber\s+)?(o\s+|os\s+)?lembrete(s)?\b/i.test(normText) ||
        /^(sim,?\s*)?quero\s+receber(\s+lembretes?)?\b/i.test(normText)
      );

    const isExplicitNegative =
      /^(nao|não|2|dispensa|cancelar|cancela|sem lembrete)/i.test(normText) ||
      /\b(nao|não)\s+quero(\s+lembrete)?/i.test(normText) ||
      /\bsem\s+lembrete/i.test(normText) ||
      nluResult.optInConsent === false;

    if (isExplicitNegative || /^(eu\s+)?quero\s*$/i.test(normText)) {
      session.state = 'IDLE';
      session.lastAppointmentId = null;
      return `Tudo bem! Seu agendamento permanece confirmado normalmente sem lembretes automáticos. Se precisar de algo, estarei à disposição! ✨`;
    }

    if (isExplicitAffirmative && session.lastAppointmentId) {
      const salonReminderService = require('../services/salonReminderService');
      salonAppointmentService.updateAppointmentConsent(session.lastAppointmentId, uid, 1, 'whatsapp_bot_optin');
      salonReminderService.registerClientConsent(uid, cleanPhone, 'whatsapp_bot_optin');

      session.state = 'IDLE';
      session.lastAppointmentId = null;
      return `Combinado! Lembrete de 24h ativado com sucesso. ✨\n\nCaso queira cancelar os lembretes no futuro, basta digitar *Parar lembretes* a qualquer momento.\n\nNos vemos em breve no *${salonName}*! 💖`;
    }

    // Se for outra intenção (ex: "Quero agendar outro horário", "Quero mudar o corte"), encerra o opt-in sem consentimento
    session.state = 'IDLE';
    session.lastAppointmentId = null;
    return `Tudo bem! Seu agendamento permanece confirmado normalmente sem lembretes automáticos. Se precisar de algo, estarei à disposição! ✨`;
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

    const booked = await salonAppointmentService.bookAppointment(uid, {
      clientName: session.customerName || 'Cliente WhatsApp',
      clientPhone: cleanPhone,
      serviceId: validService.id,
      staffId: finalStaffId,
      date: session.selectedSlot.date,
      time: session.selectedSlot.time,
      durationMin: validService.duration_min,
      origin: 'WHATSAPP_BOT',
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

    session.state = 'AWAITING_REMINDER_OPTIN';
    session.lastAppointmentId = booked.id;
    session.selectedService = null;
    session.candidateServices = null;
    session.selectedStaff = null;
    session.candidateSlots = [];
    session.selectedSlot = null;

    return `Prontinho! Agendamento confirmado com sucesso: seu agendamento para *${confirmedServiceName}* está marcado para ${datePrep}, às *${confirmedTime}*, com a *${staffName}*, por R$ ${confirmedPrice}. 😊\n\n` +
      `Quer que eu te mande um lembrete aqui no WhatsApp 24 horas antes do seu horário para você não esquecer? ✨\n\n` +
      `(Se não quiser o lembrete, não precisa se preocupar: seu horário já está garantido!)`;
  }

  // 4. Consulta de Preço / Valores (sem perder o serviço em andamento se já estiver selecionado)
  if (intent === 'PRICE_INQUIRY' || intent === 'PRICE_SERVICE_INQUIRY' || intent === 'SERVICE_INQUIRY') {
    const queryTerm = nluResult.serviceName || text;
    const resMatch = resolveServiceMatch(services, queryTerm);
    if (resMatch.status === 'EXACT') {
      const s = resMatch.match;
      let extra = '';
      if (session.selectedService && session.selectedService.id !== s.id) {
        extra = `\n\n(Seu agendamento para *${session.selectedService.name}* continua em andamento! Deseja trocar para este serviço ou continuar?)`;
      } else {
        extra = `\n\nGostaria de verificar os horários livres para agendar? É só me falar o dia de sua preferência! ✨`;
      }
      return `O procedimento *${s.name}* no *${salonName}* custa *R$ ${formatPrice(s.price)}* (duração estimada de ${s.duration_min} minutos).${extra}`;
    }
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
      if (!isNaN(num) && num >= 1 && num <= slots.length) {
        pickedSlot = slots[num - 1];
      } else if (normText.includes('primeiro') || normText.includes('primeiro horario') || normText.includes('primeira vaga')) {
        pickedSlot = slots[0];
      } else if (nluResult.time) {
        const cleanT = nluResult.time.replace('h', ':');
        pickedSlot = slots.find((s) => s.time.includes(cleanT) || cleanT.includes(s.time)) || null;
      } else {
        pickedSlot = slots.find((s) => normText.includes(s.time.replace(':', 'h')) || normText.includes(s.time)) || null;
      }

      if (pickedSlot) {
        session.selectedSlot = { date: pickedSlot.date, time: pickedSlot.time };
        session.state = 'AWAITING_CONFIRMATION';

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

        return `Perfeito! Já separei esse horário para você:\n\n` +
          `📍 *Espaço:* ${salonName}\n` +
          `💇‍♀️ *Serviço:* ${session.selectedService.name}\n` +
          `👤 *Profissional:* ${staffName}\n` +
          `📅 *Data:* ${displayDate} (${pickedSlot.dayLabel.split(' ')[0]})\n` +
          `⏰ *Horário:* ${pickedSlot.time}\n` +
          `💰 *Valor:* R$ ${priceFormatted}\n\n` +
          `Tudo certinho, posso confirmar o agendamento para você? 🥰`;
      }
    }
  }

  // 6. Conversa Geral / Saudação
  if (intent === 'GENERAL_TALK') {
    return nluResult.friendlyMessage || `Olá! Tudo bem? Seja muito bem-vinda ao *${salonName}*! 🥰\n\nComo posso te ajudar hoje? Se você quiser agendar um horário ou saber mais sobre nossos serviços, é só me falar!`;
  }

  // 7. Agendamento com Resolução do Serviço ou Acolhimento Aberto
  if (intent === 'SCHEDULE_INQUIRY' || intent === 'CHANGE_PREFERENCE' || !session.selectedService) {
    if (nluResult.datePreference) session.requestedDatePref = nluResult.datePreference;
    if (nluResult.period) session.requestedPeriod = nluResult.period;
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

      const wantsAny = Boolean(nluResult.staffName === 'ANY' || /(qualquer|tanto faz|sem preferencia|qualquer um|qualquer profissional)/i.test(normText));

      if (pickedStaff) {
        session.selectedStaff = pickedStaff;
      } else if (qualifiedStaff.length === 1 || wantsAny) {
        session.selectedStaff = qualifiedStaff.length === 1 ? qualifiedStaff[0] : null;
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
        const displaySlots = slots.slice(0, 3);
        const slotList = displaySlots.map((s, i) => `${i + 1}. ${s.dayLabel} às *${s.time}*`).join('\n');
        const staffDesc = session.selectedStaff ? `com *${session.selectedStaff.name}*` : 'com nossa equipe';
        const moreHint = slots.length > 3 ? '\n\n(Quer ver mais opções? É só me falar!) ✨' : '';

        if (displaySlots.length === 2) {
          const timeDesc1 = formatTimeFriendly(displaySlots[0].time);
          const st1 = displaySlots[0].staffName || session.selectedStaff?.name;
          const staffDesc1 = st1 ? ` com a *${st1}*` : '';

          const timeDesc2 = formatTimeFriendly(displaySlots[1].time);
          const st2 = displaySlots[1].staffName || session.selectedStaff?.name;
          const staffDesc2 = st2 ? ` com a *${st2}*` : '';

          return `Encontrei ${timeDesc1}${staffDesc1} e ${timeDesc2}${staffDesc2}. Qual fica melhor pra você? ✨\n\n` +
            `${slotList}\n\n` +
            `Você pode responder pelo número ou me falar o horário! 😊`;
        }

        return `Excelente! Para *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}) ${staffDesc}, separei os seguintes horários disponíveis:\n\n${slotList}${moreHint}\n\nAlgum desses horários fica bom para você? ✨`;
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

  const text = extractMessageText(msg.message);
  if (!text) {
    return false;
  }

  // 2. Deduplicação persistente via processed_messages
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
    session = {
      salonUserId: uid,
      customerPhone: cleanPhone,
      customerName: (msg.pushName || '').trim() || 'Cliente WhatsApp',
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
    };
    customerSessions.set(sessionKey, session);
  } else {
    if (msg.pushName && (!session.customerName || session.customerName === 'Cliente WhatsApp')) {
      session.customerName = msg.pushName.trim();
    }
  }
  session.lastActivity = now;
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
  const isBookingFlowActive = ['AWAITING_SERVICE', 'AWAITING_STAFF', 'AWAITING_SLOT', 'AWAITING_CONFIRMATION'].includes(session.state);
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

  // 6. Máquina de Estados Conversacionais da Jéssica
  if (!replyText) {
  switch (session.state) {
    case 'AWAITING_SERVICE': {
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
        const slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff);
        if (slots.length > 0) {
          session.candidateSlots = slots;
          session.state = 'AWAITING_SLOT';
          const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
          replyText = `Excelente escolha: *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}) com a *${qualifiedStaff[0].name}*! ✨\n\nSeparei estes horários livres mais próximos para você:\n\n${slotList}\n\nAlgum desses horários fica bom para você? Me conta por aqui!`;
        } else {
          session.state = 'IDLE';
          replyText = `No momento não encontramos horários disponíveis nos próximos dias para *${matchedService.name}* com ${qualifiedStaff[0].name}. Nossa equipe entrará em contato em breve para verificar um encaixe especial para você! ✨`;
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

      if (/(qualquer|tanto faz|sem preferencia|qualquer um|qualquer profissional|pode ser qualquer)/i.test(normText) || num === (available.length + 1)) {
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
      const slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff);

      if (slots.length > 0) {
        session.candidateSlots = slots;
        session.state = 'AWAITING_SLOT';
        const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
        const staffDesc = chosenStaff ? `com *${chosenStaff.name}*` : 'com nossa equipe';
        replyText = `Maravilha! Para *${session.selectedService.name}* ${staffDesc}, temos os seguintes horários livres:\n\n${slotList}\n\nAlgum desses horários fica bom para você? É só me falar! ✨`;
      } else {
        session.state = 'IDLE';
        replyText = `Não encontramos horários livres nos próximos dias para esta combinação. Gostaria de verificar com outra profissional ou para uma data mais adiante? Me avise para eu pesquisar para você! ✨`;
      }
      break;
    }

    case 'AWAITING_SLOT': {
      const slots = session.candidateSlots || [];
      const num = parseInt(normText, 10);
      let pickedSlot = null;

      if (!isNaN(num) && num >= 1 && num <= slots.length) {
        pickedSlot = slots[num - 1];
      } else {
        // Tenta encontrar por correspondência de horário (ex: "14:00" ou "14h")
        pickedSlot = slots.find((s) => normText.includes(s.time.replace(':', 'h')) || normText.includes(s.time)) || null;
      }

      if (!pickedSlot) {
        const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
        replyText = `Por favor, selecione um dos horários informados:\n\n${slotList}\n\nQual deles fica melhor para você? ✨`;
        break;
      }

      session.selectedSlot = { date: pickedSlot.date, time: pickedSlot.time };
      session.state = 'AWAITING_CONFIRMATION';

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

      replyText = `Perfeito! Por favor, confira os dados do seu agendamento:\n\n` +
        `📍 *Espaço:* ${salonName}\n` +
        `💇‍♀️ *Serviço:* ${session.selectedService.name}\n` +
        `👤 *Profissional:* ${staffName}\n` +
        `📅 *Data:* ${displayDate} (${pickedSlot.dayLabel.split(' ')[0]})\n` +
        `⏰ *Horário:* ${pickedSlot.time}\n` +
        `💰 *Valor:* R$ ${priceFormatted}\n\n` +
        `Posso confirmar o seu agendamento? Tudo certinho para você? ✨`;
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

        const booked = await salonAppointmentService.bookAppointment(uid, {
          clientName: session.customerName || 'Cliente WhatsApp',
          clientPhone: cleanPhone,
          serviceId: validService.id,
          staffId: finalStaffId,
          date: session.selectedSlot.date,
          time: session.selectedSlot.time,
          durationMin: validService.duration_min,
          origin: 'WHATSAPP_BOT',
          reminderConsent: 0,
          reminderConsentOrigin: null,
        });

        const displayDate = formatDisplayDate(session.selectedSlot.date);
        const staffName = session.selectedStaff ? session.selectedStaff.name : (booked?.staff_name || 'Equipe do Salão');
        const priceFormatted = formatPrice(session.selectedService.price);

        replyText = `🎉 *Agendamento confirmado com sucesso!* 🎉\n\n` +
          `Estamos muito felizes em te receber no *${salonName}*! ✨\n\n` +
          `📋 *Detalhes do seu Atendimento:*\n` +
          `• *Espaço:* ${salonName}\n` +
          `• *Serviço:* ${session.selectedService.name}\n` +
          `• *Profissional:* ${staffName}\n` +
          `• *Data:* ${displayDate}\n` +
          `• *Horário:* ${session.selectedSlot.time}\n` +
          `• *Valor:* R$ ${priceFormatted}\n\n` +
          `🔔 *Lembrete 24h por WhatsApp (Opcional):*\n` +
          `Você gostaria de receber um lembrete automático por aqui 24 horas antes do seu horário?\n` +
          `• Digite *Sim* ou *1* para autorizar o lembrete\n` +
          `• (Se não quiser, não precisa responder nada — seu agendamento já está confirmado!)\n\n` +
          `Caso precise remarcar ou tirar dúvidas, pode me chamar por aqui a qualquer momento. Até breve! 💖`;

        // Transiciona para aguardar opt-in opcional de lembretes (LGPD)
        session.state = 'AWAITING_REMINDER_OPTIN';
        session.lastAppointmentId = booked.id;
        session.selectedService = null;
        session.candidateServices = null;
        session.selectedStaff = null;
        session.candidateSlots = [];
        session.selectedSlot = null;
      } catch (bookErr) {
        console.error(`[salonIncomingDispatcher] Erro ao concluir agendamento #${uid}:`, bookErr.message);
        session.state = 'IDLE';
        session.selectedService = null;
        session.candidateServices = null;
        session.selectedStaff = null;
        session.candidateSlots = [];
        session.selectedSlot = null;
        replyText = `Puxa, parece que esse horário acabou de ser reservado: ${bookErr.message}\n\nQuer tentar outro horário? É só me falar! ✨`;
      }
      break;
    }

    case 'AWAITING_REMINDER_OPTIN': {
      // 1. Recusa ou cancelamento de lembretes (precedência estrita)
      const isNegative =
        /^(nao|não|2|dispensa|cancelar|deixa pra la|deixa)\b/i.test(normText) ||
        /\b(nao|não)\s+quero\b/i.test(normText) ||
        /\bsem\s+lembrete/i.test(normText);

      if (isNegative) {
        session.state = 'IDLE';
        session.lastAppointmentId = null;
        replyText = `Tudo bem! Seu agendamento permanece confirmado normalmente sem lembretes automáticos. Se precisar de qualquer informação, estarei por aqui! ✨`;
        break;
      }

      // 2. Afirmação inequívoca de consentimento no contexto da pergunta sobre lembretes
      const isAffirmative =
        /^(1|sim|com certeza|positivo|autorizo)\b/i.test(normText) ||
        /^(sim,?\s*)?(quero|pode enviar|ativar|autorizo)\s+(o\s+|os\s+)?lembrete(s)?\b/i.test(normText) ||
        /^(sim,?\s*)?quero\s+receber\s+(o\s+|os\s+)?lembrete(s)?\b/i.test(normText);

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
      const isGreeting = /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|como vai|opa|oie)\b/i.test(normText);
      const isServiceInquiry = /(servico|servicos|valor|valores|preco|precos|quanto custa|tabela|cardapio|menu|catalogo)/i.test(normText);
      const isScheduleInquiry = /(agendar|marcar|horario|vaga|disponibilidade|atendimento|cortar|corte|manicure|pedicure|escova|sobrancelha|barba)/i.test(normText);

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
          } else if (qualifiedStaff.length === 1) {
            session.selectedStaff = qualifiedStaff[0];
            const slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff);
            if (slots.length > 0) {
              session.candidateSlots = slots;
              session.state = 'AWAITING_SLOT';
              const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
              replyText = `Olá! Com certeza! Para *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}) com a *${qualifiedStaff[0].name}*, temos estes horários livres:\n\n${slotList}\n\nQual desses horários fica melhor para você? (Ou pode me falar outro horário que preferir!) ✨`;
            } else {
              session.state = 'IDLE';
              replyText = `Olá! Adoraríamos te atender para *${matchedService.name}*, mas no momento não encontramos horários disponíveis nos próximos dias com ${qualifiedStaff[0].name}. Nossa equipe entrará em contato com você em instantes! ✨`;
            }
          } else {
            session.availableStaffList = qualifiedStaff;
            session.state = 'AWAITING_STAFF';
            const staffMenu = qualifiedStaff.map((st, i) => `${i + 1}. *${st.name}*`).join('\n');
            replyText = `Olá! Seja muito bem-vinda ao *${salonName}*! ✨\n\nIdentifiquei seu interesse em *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}).\n\nCom qual de nossas profissionais você gostaria de realizar o atendimento?\n\n${staffMenu}\n${qualifiedStaff.length + 1}. *Qualquer profissional disponível*\n\nPode me dizer o nome da sua preferência ou se prefere o primeiro horário livre! ✨`;
          }
        } else if (serviceResolution.status === 'AMBIGUOUS') {
          session.candidateServices = serviceResolution.candidates;
          session.state = 'AWAITING_SERVICE';
          const candidateList = serviceResolution.candidates
            .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
            .join('\n');
          replyText = `Olá! Seja bem-vinda ao *${salonName}*! ✨\n\nIdentifiquei mais de uma opção correspondente ao seu pedido:\n\n${candidateList}\n\nQual dessas opções você prefere? Me conta para eu já checar os horários! ✨`;
        } else {
          // Não especificou o serviço ainda: apresenta catálogo numerado
          session.state = 'AWAITING_SERVICE';
          session.candidateServices = null;
          if (services && services.length > 0) {
            const serviceMenu = services.map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`).join('\n');
            replyText = `Com certeza! Seja bem-vinda ao *${salonName}*! ✨\n\nPara qual serviço você gostaria de agendar seu horário?\n\n${serviceMenu}\n\nÉ só me falar o nome ou como preferir!`;
          } else {
            session.state = 'IDLE';
            replyText = `Seja bem-vinda ao *${salonName}*! Nosso catálogo está sendo atualizado. Por favor, me informe qual procedimento você deseja para eu consultar nossa equipe! ✨`;
          }
        }
      } else if (isServiceInquiry) {
        if (services && services.length > 0) {
          const itemsList = services.map((s, i) => `${i + 1}. *${s.name}*: R$ ${formatPrice(s.price)} (${s.duration_min} min)`).join('\n');
          replyText = `Aqui estão os procedimentos disponíveis no *${salonName}*:\n\n${itemsList}\n\nGostaria de agendar algum? É só me falar qual você tem em mente! ✨`;
        } else {
          replyText = `Seja bem-vinda ao *${salonName}*! Estamos atualizando nosso catálogo de procedimentos. Pode me informar qual serviço deseja realizar para eu verificar com a nossa equipe?`;
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
}

module.exports = {
  dispatchMessage,
  resolveServiceMatch,
  findMatchingService,
  resolveCandidateDays,
  filterSlotsByPreference,
  _resetForTesting,
};
