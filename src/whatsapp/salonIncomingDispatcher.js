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

  const cleanPhone = phoneUtils.cleanDigits(senderJid.split('@')[0].split(':')[0]);
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

  // 5. Verificação Universal de Cancelamento/Desistência em qualquer estado ativo
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

      // Resolução de Profissionais
      if (staffList.length === 1) {
        session.selectedStaff = staffList[0];
        const slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff);
        if (slots.length > 0) {
          session.candidateSlots = slots;
          session.state = 'AWAITING_SLOT';
          const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
          replyText = `Excelente escolha: *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}) com *${staffList[0].name}*! ✨\n\nEstes são os horários livres mais próximos disponíveis:\n\n${slotList}\n\nPor favor, digite o *número* do horário de sua preferência (ou digite *Cancelar*):`;
        } else {
          session.state = 'IDLE';
          replyText = `No momento não encontramos horários disponíveis nos próximos dias para *${matchedService.name}*. Nossa equipe entrará em contato em breve para verificar um encaixe especial para você! ✨`;
        }
      } else if (staffList.length > 1) {
        session.availableStaffList = staffList;
        session.state = 'AWAITING_STAFF';
        const staffMenu = staffList.map((st, i) => `${i + 1}. *${st.name}*`).join('\n');
        replyText = `Perfeito! Você escolheu *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}).\n\nCom qual de nossas profissionais você gostaria de ser atendida?\n\n${staffMenu}\n${staffList.length + 1}. *Qualquer profissional disponível*\n\nPor favor, digite o número da sua preferência:`;
      } else {
        session.selectedStaff = null;
        const slots = await findCandidateSlots(uid, session.selectedService, null);
        if (slots.length > 0) {
          session.candidateSlots = slots;
          session.state = 'AWAITING_SLOT';
          const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
          replyText = `Ótima escolha: *${matchedService.name}* (R$ ${formatPrice(matchedService.price)})! ✨\n\nEstes são os horários livres disponíveis:\n\n${slotList}\n\nPor favor, digite o *número* da opção desejada:`;
        } else {
          session.state = 'IDLE';
          replyText = `No momento não encontramos horários livres disponíveis para este procedimento. Nossa equipe entrará em contato em breve para agendar seu atendimento! ✨`;
        }
      }
      break;
    }

    case 'AWAITING_STAFF': {
      const available = session.availableStaffList || staffList;
      const num = parseInt(normText, 10);
      let chosenStaff = null;

      if (/^(qualquer|tanto faz|sem preferencia|qualquer um|qualquer profissional)\b/i.test(normText) || num === (available.length + 1)) {
        chosenStaff = null;
      } else if (!isNaN(num) && num >= 1 && num <= available.length) {
        chosenStaff = available[num - 1];
      } else {
        // Matching por nome do profissional
        chosenStaff = available.find((st) => {
          const stNorm = st.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          return normText.includes(stNorm) || stNorm.includes(normText);
        }) || null;
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

      const displayDate = formatDisplayDate(pickedSlot.date);
      const staffName = session.selectedStaff ? session.selectedStaff.name : 'Profissional disponível da equipe';
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

        if (session.selectedStaff && session.selectedStaff.id) {
          const validStaff = db.prepare(`
            SELECT id, name
            FROM client_staff
            WHERE id = ? AND user_id = ? AND active = 1
          `).get(session.selectedStaff.id, uid);

          if (!validStaff) {
            throw new Error('SECURITY_VIOLATION_IDOR: Tentativa de agendamento com profissional inválido ou não pertencente ao salão.');
          }
        }

        const booked = await salonAppointmentService.bookAppointment(uid, {
          clientName: session.customerName || 'Cliente WhatsApp',
          clientPhone: cleanPhone,
          serviceId: validService.id,
          staffId: session.selectedStaff ? session.selectedStaff.id : null,
          date: session.selectedSlot.date,
          time: session.selectedSlot.time,
          durationMin: validService.duration_min,
          origin: 'WHATSAPP_BOT',
          reminderConsent: 1,
          reminderConsentOrigin: 'whatsapp_bot_agendamento',
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
          `Você receberá lembretes pelo WhatsApp antes do atendimento. Caso precise remarcar ou tirar dúvidas, pode me chamar por aqui a qualquer momento!\n\n` +
          `Até breve! 💖`;

        // Limpeza de estado após sucesso
        session.state = 'IDLE';
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

          if (staffList.length === 1) {
            session.selectedStaff = staffList[0];
            const slots = await findCandidateSlots(uid, session.selectedService, session.selectedStaff);
            if (slots.length > 0) {
              session.candidateSlots = slots;
              session.state = 'AWAITING_SLOT';
              const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
              replyText = `Olá! Com certeza! Para *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}) com *${staffList[0].name}*, temos os seguintes horários disponíveis:\n\n${slotList}\n\nPor favor, digite o *número* da opção que você prefere (ou envie outro horário desejado):`;
            } else {
              session.state = 'IDLE';
              replyText = `Olá! Adoraríamos te atender para *${matchedService.name}*, mas no momento não encontramos horários disponíveis nos próximos dias. Nossa equipe entrará em contato com você em instantes! ✨`;
            }
          } else if (staffList.length > 1) {
            session.availableStaffList = staffList;
            session.state = 'AWAITING_STAFF';
            const staffMenu = staffList.map((st, i) => `${i + 1}. *${st.name}*`).join('\n');
            replyText = `Olá! Seja muito bem-vinda ao *${salonName}*! ✨\n\nIdentifiquei seu interesse em *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}).\n\nCom qual de nossas profissionais você gostaria de realizar o atendimento?\n\n${staffMenu}\n${staffList.length + 1}. *Qualquer profissional disponível*\n\nPor favor, digite o número da sua preferência:`;
          } else {
            session.selectedStaff = null;
            const slots = await findCandidateSlots(uid, session.selectedService, null);
            if (slots.length > 0) {
              session.candidateSlots = slots;
              session.state = 'AWAITING_SLOT';
              const slotList = slots.map((s) => `${s.number}. ${s.dayLabel} às *${s.time}*`).join('\n');
              replyText = `Olá! Seja bem-vinda ao *${salonName}*! ✨\n\nPara *${matchedService.name}* (R$ ${formatPrice(matchedService.price)}), temos os seguintes horários disponíveis:\n\n${slotList}\n\nPor favor, digite o *número* do horário desejado:`;
            } else {
              session.state = 'IDLE';
              replyText = `Olá! No momento estamos sem vagas imediatas para *${matchedService.name}*, mas nossa equipe entrará em contato para te acomodar no melhor horário! ✨`;
            }
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
