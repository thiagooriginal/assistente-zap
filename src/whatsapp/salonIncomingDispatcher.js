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
 * Realiza matching inteligente de serviço a partir do texto do cliente
 * @private
 * @param {Array<object>} services
 * @param {string} text
 * @returns {object|null}
 */
function findMatchingService(services, text) {
  if (!services || services.length === 0 || !text) return null;
  const cleanInput = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // 1. Seleção por índice numérico direto (ex: "1", "2")
  const num = parseInt(cleanInput, 10);
  if (!isNaN(num) && num >= 1 && num <= services.length) {
    return services[num - 1];
  }

  // 2. Busca por substring exata no nome ou categoria do serviço
  for (const s of services) {
    const sNorm = s.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (cleanInput.includes(sNorm) || sNorm.includes(cleanInput)) {
      return s;
    }
  }

  // 3. Matching por palavras-chave e sinônimos usuais de salão
  const keywordsMap = [
    { triggers: ['corte', 'cortar', 'aparar', 'cabelo', 'pontas'], terms: ['corte', 'cabelo'] },
    { triggers: ['escova', 'escovar', 'prancha', 'chapinha', 'alisamento', 'botox', 'progressiva'], terms: ['escova', 'alisamento', 'progressiva'] },
    { triggers: ['manicure', 'unha', 'unhas', 'esmaltacao', 'esmalte', 'cuticula', 'alongamento', 'gel'], terms: ['manicure', 'unha', 'alongamento'] },
    { triggers: ['pedicure', 'pe', 'pes'], terms: ['pedicure', 'pe'] },
    { triggers: ['sobrancelha', 'sombrancelha', 'design', 'henna'], terms: ['sobrancelha', 'design'] },
    { triggers: ['barba', 'barbear', 'barbeiro', 'bigode'], terms: ['barba'] },
    { triggers: ['coloracao', 'pintar', 'mechas', 'luzes', 'tintura', 'morena iluminada', 'loiro'], terms: ['coloracao', 'mechas', 'luzes', 'tintura'] },
    { triggers: ['hidratacao', 'hidratar', 'nutricao', 'cauterizacao', 'cronograma', 'reconstrucao'], terms: ['hidratacao', 'cauterizacao', 'tratamento', 'reconstrucao'] },
    { triggers: ['depilacao', 'depilar', 'cera'], terms: ['depilacao'] },
    { triggers: ['maquiagem', 'make'], terms: ['maquiagem', 'make'] },
  ];

  for (const km of keywordsMap) {
    const matchesTrigger = km.triggers.some((t) => cleanInput.includes(t));
    if (matchesTrigger) {
      for (const s of services) {
        const sNorm = s.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        if (km.terms.some((t) => sNorm.includes(t))) {
          return s;
        }
      }
    }
  }

  return null;
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

  // 5. Verificação Universal de Revogação de Lembretes (LGPD Opt-out)
  const isRevocation = /(parar lembretes|cancelar lembretes|revogar lembretes|sem lembretes|nao quero lembretes|parar lembrete|cancelar lembrete)/i.test(normText);
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

  // 5.1 Verificação Universal de Cancelamento/Desistência em qualquer estado ativo
  const isCancellation = /^(cancelar|cancela|cancelamento|desisto|sair|parar|deixa pra la|deixa para la)\b/i.test(normText);
  if (session.state !== 'IDLE' && isCancellation) {
    session.state = 'IDLE';
    session.selectedService = null;
    session.selectedStaff = null;
    session.availableStaffList = [];
    session.candidateSlots = [];
    session.selectedSlot = null;

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
      const matchedService = findMatchingService(services, text);
      if (!matchedService) {
        const serviceMenu = services.map((s, i) => `${i + 1}. *${s.name}* — R$ ${formatPrice(s.price)}`).join('\n');
        replyText = `Não consegui identificar o serviço desejado. Por favor, digite o número correspondente da lista:\n\n${serviceMenu}\n\n(Ou digite *Cancelar* para desistir)`;
        break;
      }

      session.selectedService = matchedService;

      // Resolução de Profissionais Habilitados para o Serviço (Comando 040)
      const qualifiedStaff = getQualifiedStaffForService(uid, matchedService.id);

      if (qualifiedStaff.length === 0) {
        session.state = 'IDLE';
        session.selectedService = null;
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
        session.selectedStaff = null;
        session.candidateSlots = [];
        session.selectedSlot = null;
      } catch (bookErr) {
        console.error(`[salonIncomingDispatcher] Erro ao concluir agendamento #${uid}:`, bookErr.message);
        session.state = 'IDLE';
        session.selectedService = null;
        session.selectedStaff = null;
        session.candidateSlots = [];
        session.selectedSlot = null;
        replyText = `Ops! Não conseguimos reservar esse horário: ${bookErr.message}\n\nPara escolher um novo horário, digite *Agendar*! ✨`;
      }
      break;
    }

    case 'AWAITING_REMINDER_OPTIN': {
      const isAffirmative = /^(sim|1|lembrete|quero|ativar|pode ser|com certeza|positivo|confirmo|por favor)\b/i.test(normText);
      const isNegative = /^(nao|não|2|sem lembrete|nao quero|dispensa|cancelar|deixa)\b/i.test(normText);

      if (isAffirmative && session.lastAppointmentId) {
        const salonReminderService = require('../services/salonReminderService');
        salonAppointmentService.updateAppointmentConsent(session.lastAppointmentId, uid, 1, 'whatsapp_bot_optin');
        salonReminderService.registerClientConsent(uid, cleanPhone, 'whatsapp_bot_optin');

        session.state = 'IDLE';
        session.lastAppointmentId = null;
        replyText = `Combinado! Lembrete de 24h ativado com sucesso. ✨\n\nCaso queira cancelar os lembretes no futuro, basta digitar *Parar lembretes* a qualquer momento.\n\nNos vemos em breve no *${salonName}*! 💖`;
        break;
      }

      if (isNegative) {
        session.state = 'IDLE';
        session.lastAppointmentId = null;
        replyText = `Tudo bem! Seu agendamento permanece confirmado normalmente sem lembretes automáticos. Se precisar de qualquer informação, estarei por aqui! ✨`;
        break;
      }

      // Se a mensagem for outra coisa, encerra o opt-in mantendo reminderConsent = 0 e responde cordialmente
      session.state = 'IDLE';
      session.lastAppointmentId = null;
      replyText = `Olá! Seu agendamento anterior já está confirmado. ✨\n\nComo posso te ajudar agora?\n• Digite *Serviços* para ver nosso catálogo\n• Digite *Agendar* para marcar outro horário`;
      break;
    }

    case 'IDLE':
    default: {
      const isGreeting = /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|como vai|opa|oie)\b/i.test(normText);
      const isServiceInquiry = /(servico|servicos|valor|valores|preco|precos|quanto custa|tabela|cardapio|menu|catalogo)/i.test(normText);
      const isScheduleInquiry = /(agendar|marcar|horario|vaga|disponibilidade|atendimento|cortar|corte|manicure|pedicure|escova|sobrancelha|barba)/i.test(normText);

      // Matching direto de agendamento na primeira mensagem (ex: "gostaria de agendar para cortar meu cabelo")
      if (isScheduleInquiry) {
        const matchedService = findMatchingService(services, text);

        if (matchedService) {
          session.selectedService = matchedService;

          // Resolução de Profissionais Habilitados para o Serviço (Comando 040)
          const qualifiedStaff = getQualifiedStaffForService(uid, matchedService.id);

          if (qualifiedStaff.length === 0) {
            session.state = 'IDLE';
            session.selectedService = null;
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
        } else {
          // Não especificou o serviço ainda: apresenta catálogo numerado
          session.state = 'AWAITING_SERVICE';
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
  _resetForTesting,
};
