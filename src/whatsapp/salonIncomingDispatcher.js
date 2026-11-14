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
 * Gera lista de datas candidatas para busca de horários disponíveis
 * @private
 * @param {number} [count=4]
 * @returns {Array<{ dateStr: string, label: string, offset: number }>}
 */
function getUpcomingCandidateDays(count = 4) {
  const days = [];
  const now = new Date();

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
 * @returns {Promise<Array<{ number: number, date: string, time: string, dayLabel: string }>>}
 */
async function findCandidateSlots(userId, service, staff = null) {
  const duration = service?.duration_min || 45;
  const staffId = staff ? staff.id : null;
  const days = getUpcomingCandidateDays(4);

  const allCandidateSlots = [];
  let counter = 1;

  for (const day of days) {
    try {
      const freeSlots = await salonAppointmentService.findAlternativeSlots(userId, {
        date: day.dateStr,
        serviceDurationMin: duration,
        staffId,
        serviceId: service?.id || null,
        limit: 3, // Limita a 3 sugestões por dia para não poluir o WhatsApp
      });

      if (Array.isArray(freeSlots) && freeSlots.length > 0) {
        for (const slotTime of freeSlots) {
          allCandidateSlots.push({
            number: counter++,
            date: day.dateStr,
            time: slotTime,
            dayLabel: day.label,
          });
          if (allCandidateSlots.length >= 6) break;
        }
      }
    } catch (_) {}
    if (allCandidateSlots.length >= 6) break;
  }

  return allCandidateSlots;
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

  // 6. Máquina de Estados Conversacionais da Jéssica
  switch (session.state) {
    case 'AWAITING_SERVICE': {
      const serviceResolution = resolveServiceMatch(services, text, session.candidateServices);

      if (serviceResolution.status === 'AMBIGUOUS') {
        session.candidateServices = serviceResolution.candidates;
        const candidateList = serviceResolution.candidates
          .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
          .join('\n');
        replyText = `Identifiquei mais de uma opção. Por favor, escolha digitando o número correspondente:\n\n${candidateList}\n\n(Ou digite *Cancelar* para desistir)`;
        break;
      }

      if (serviceResolution.status !== 'EXACT') {
        const listToDisplay = (session.candidateServices && session.candidateServices.length > 0)
          ? session.candidateServices
          : services;
        const serviceMenu = listToDisplay.map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)}`).join('\n');
        replyText = `Não consegui identificar o serviço desejado. Por favor, digite o número correspondente da lista:\n\n${serviceMenu}\n\n(Ou digite *Cancelar* para desistir)`;
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
        replyText = `No momento não temos profissionais disponíveis para o serviço *${matchedService.name}*. Gostaria de escolher outro serviço do nosso catálogo? Digite *Serviços* para ver as opções! ✨`;
      } else if (qualifiedStaff.length === 1) {
        session.selectedStaff = qualifiedStaff[0];
        const slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff);
        if (slots.length > 0) {
          session.candidateSlots = slots;
          session.state = 'AWAITING_SLOT';
          const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
          replyText = `Excelente escolha: *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}) com *${qualifiedStaff[0].name}*! ✨\n\nEstes são os horários livres mais próximos disponíveis:\n\n${slotList}\n\nPor favor, digite o *número* do horário de sua preferência (ou digite *Cancelar*):`;
        } else {
          session.state = 'IDLE';
          replyText = `No momento não encontramos horários disponíveis nos próximos dias para *${matchedService.name}* com ${qualifiedStaff[0].name}. Nossa equipe entrará em contato em breve para verificar um encaixe especial para você! ✨`;
        }
      } else {
        session.availableStaffList = qualifiedStaff;
        session.state = 'AWAITING_STAFF';
        const staffMenu = qualifiedStaff.map((st, i) => `${i + 1}. *${st.name}*`).join('\n');
        replyText = `Perfeito! Você escolheu *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}).\n\nCom qual de nossas profissionais você gostaria de ser atendida?\n\n${staffMenu}\n${qualifiedStaff.length + 1}. *Qualquer profissional disponível*\n\nPor favor, digite o número da sua preferência:`;
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
        replyText = `Não entendi a opção escolhida. Por favor, escolha um profissional digitando o número correspondente:\n\n${staffMenu}\n${available.length + 1}. *Qualquer profissional disponível*`;
        break;
      }

      session.selectedStaff = chosenStaff;
      const slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff);

      if (slots.length > 0) {
        session.candidateSlots = slots;
        session.state = 'AWAITING_SLOT';
        const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
        const staffDesc = chosenStaff ? `com *${chosenStaff.name}*` : 'com nossa equipe';
        replyText = `Maravilha! Para *${session.selectedService.name}* ${staffDesc}, temos os seguintes horários livres:\n\n${slotList}\n\nPor favor, digite o *número* do horário desejado:`;
      } else {
        session.state = 'IDLE';
        replyText = `Não encontramos horários livres nos próximos dias para esta configuração. Deseja verificar com outro profissional ou para outra data? Digite *Agendar* para tentar novamente. ✨`;
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
        replyText = `Por favor, selecione um dos horários informados digitando o número correspondente:\n\n${slotList}\n\n(Ou digite *Cancelar* para desistir)`;
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
        `Posso confirmar o seu agendamento?\n` +
        `• Digite *Sim* para confirmar\n` +
        `• Digite *Cancelar* para desistir`;
      break;
    }

    case 'AWAITING_CONFIRMATION': {
      const isAffirmative = /^(sim|confirmo|pode agendar|agendar|ok|confirma|com certeza|positivo|pode ser|1)\b/i.test(normText);
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
        replyText = `Por favor, digite *Sim* para confirmar o seu agendamento no *${salonName}* ou *Cancelar* para desistir. ✨`;
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
        replyText = `Ops! Não conseguimos reservar esse horário: ${bookErr.message}\n\nPara escolher um novo horário, digite *Agendar*! ✨`;
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
        replyText = `Combinado! Lembrete de 24h ativado com sucesso. ✨\n\nCaso queira cancelar os lembretes no futuro, basta digitar *Parar lembretes* a qualquer momento.\n\nNos vemos em breve no *${salonName}*! 💖`;
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
              replyText = `Olá! Com certeza! Para *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}) com *${qualifiedStaff[0].name}*, temos os seguintes horários disponíveis:\n\n${slotList}\n\nPor favor, digite o *número* da opção que você prefere (ou envie outro horário desejado):`;
            } else {
              session.state = 'IDLE';
              replyText = `Olá! Adoraríamos te atender para *${matchedService.name}*, mas no momento não encontramos horários disponíveis nos próximos dias com ${qualifiedStaff[0].name}. Nossa equipe entrará em contato com você em instantes! ✨`;
            }
          } else {
            session.availableStaffList = qualifiedStaff;
            session.state = 'AWAITING_STAFF';
            const staffMenu = qualifiedStaff.map((st, i) => `${i + 1}. *${st.name}*`).join('\n');
            replyText = `Olá! Seja muito bem-vinda ao *${salonName}*! ✨\n\nIdentifiquei seu interesse em *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}).\n\nCom qual de nossas profissionais você gostaria de realizar o atendimento?\n\n${staffMenu}\n${qualifiedStaff.length + 1}. *Qualquer profissional disponível*\n\nPor favor, digite o número da sua preferência:`;
          }
        } else if (serviceResolution.status === 'AMBIGUOUS') {
          session.candidateServices = serviceResolution.candidates;
          session.state = 'AWAITING_SERVICE';
          const candidateList = serviceResolution.candidates
            .map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`)
            .join('\n');
          replyText = `Olá! Seja bem-vinda ao *${salonName}*! ✨\n\nIdentifiquei mais de uma opção correspondente ao seu pedido:\n\n${candidateList}\n\nPor favor, digite o *número* ou o *nome* da opção que você prefere (ou digite *Cancelar* para desistir):`;
        } else {
          // Não especificou o serviço ainda: apresenta catálogo numerado
          session.state = 'AWAITING_SERVICE';
          session.candidateServices = null;
          if (services && services.length > 0) {
            const serviceMenu = services.map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)} (${s.duration_min} min)`).join('\n');
            replyText = `Com certeza! Seja bem-vinda ao *${salonName}*! ✨\n\nPara qual serviço você gostaria de agendar seu horário?\n\n${serviceMenu}\n\nBasta responder com o número ou nome do serviço desejado!`;
          } else {
            session.state = 'IDLE';
            replyText = `Seja bem-vinda ao *${salonName}*! Nosso catálogo está sendo atualizado. Por favor, me informe qual procedimento você deseja para eu consultar nossa equipe! ✨`;
          }
        }
      } else if (isServiceInquiry) {
        if (services && services.length > 0) {
          const itemsList = services.map((s, i) => `${i + 1}. *${s.name}*: R$ ${formatPrice(s.price)} (${s.duration_min} min)`).join('\n');
          replyText = `Aqui estão os procedimentos disponíveis no *${salonName}*:\n\n${itemsList}\n\nGostaria de agendar algum? Basta me informar o nome ou número do serviço desejado! ✨`;
        } else {
          replyText = `Seja bem-vinda ao *${salonName}*! Estamos atualizando nosso catálogo de procedimentos. Pode me informar qual serviço deseja realizar para eu verificar com a nossa equipe?`;
        }
      } else if (isGreeting && session.messageCount === 1) {
        replyText = `Olá! Seja muito bem-vinda ao *${salonName}*! ✨\n\nEu sou a Jéssica, sua assistente virtual. Como posso ajudar você hoje?\n\n• Digite *Serviços* para conhecer nossos procedimentos e valores\n• Digite *Agendar* para verificar horários disponíveis`;
      } else {
        replyText = `Obrigada pelo contato com o *${salonName}*! ✨\n\nPara agilizar seu atendimento, digite:\n• *Serviços* para ver procedimentos e valores\n• *Agendar* para escolher data e horário`;
      }
      break;
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
  _resetForTesting,
};
