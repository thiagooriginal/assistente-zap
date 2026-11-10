/**
 * RAIA AGENTES — DESPACHANTE CONVERSACIONAL DE ENTRADA DO WHATSAPP (MÓDULO JÉSSICA)
 *
 * Processa mensagens recebidas nos sockets Baileys comerciais de cada salão parceiro.
 * Totalmente segregado do assistente pessoal (messageHandler.js).
 * Escopo estrito por tenant: WHERE user_id = salonUserId.
 *
 * @module whatsapp/salonIncomingDispatcher
 */

const db = require('../database/db');
const phoneUtils = require('../utils/phoneUtils');

// Memória volátil de conversação: `${salonUserId}:${customerPhone}` => State
const customerSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos

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

  // Atualizar sessão em memória
  const now = Date.now();
  let session = customerSessions.get(sessionKey);
  if (!session) {
    session = {
      salonUserId: uid,
      customerPhone: cleanPhone,
      startedAt: now,
      lastActivity: now,
      messageCount: 0,
    };
    customerSessions.set(sessionKey, session);
  }
  session.lastActivity = now;
  session.messageCount++;

  // 4. Construção da resposta Jéssica Beauty Scoped
  const normText = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  let replyText = '';

  const isGreeting = /^(oi|ola|bom dia|boa tarde|boa noite|tudo bem|como vai|opa|oie)\b/i.test(normText);
  const isServiceInquiry = /(servico|valor|preco|quanto custa|tabela|cardapio|menu|procedimento|corte|manicure|pedicure|escova)/i.test(normText);
  const isScheduleInquiry = /(agendar|marcar|horario|vaga|disponibilidade|amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado)/i.test(normText);

  if (isGreeting && !isServiceInquiry && !isScheduleInquiry && session.messageCount === 1) {
    replyText = `Olá! Seja muito bem-vinda ao *${salonName}*! ✨\n\nEu sou a Jéssica, sua assistente virtual. Como posso ajudar você hoje?\n\n• Digite *Serviços* para conhecer nossos procedimentos e valores\n• Digite *Agendar* para verificar horários disponíveis`;
  } else if (isServiceInquiry) {
    if (services && services.length > 0) {
      const itemsList = services.map(s => `• *${s.name}*: R$ ${Number(s.price).toFixed(2).replace('.', ',')} (${s.duration_min} min)`).join('\n');
      replyText = `Aqui estão os principais serviços disponíveis no *${salonName}*:\n\n${itemsList}\n\nGostaria de agendar algum horário? Basta me informar o serviço desejado!`;
    } else {
      replyText = `Seja bem-vinda ao *${salonName}*! Estamos atualizando nosso catálogo de procedimentos. Pode me informar qual serviço deseja realizar para eu verificar com a nossa equipe?`;
    }
  } else if (isScheduleInquiry) {
    replyText = `Com certeza! Para agendar seu atendimento no *${salonName}*, por favor me informe:\n\n1. Qual serviço deseja realizar\n2. O dia de sua preferência (ex: amanhã ou sexta-feira)\n3. O melhor turno (manhã ou tarde)\n\nNossa equipe cuidará de cada detalhe com muito carinho! ✨`;
  } else {
    replyText = `Obrigada pelo contato com o *${salonName}*! ✨\n\nPara agilizar seu atendimento, digite:\n• *Serviços* para ver procedimentos e valores\n• *Agendar* para escolher data e horário`;
  }

  // 5. Envio da resposta exclusivamente pelo socket do próprio salão
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
