const { GoogleGenerativeAI } = require('@google/generative-ai');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const db = require('../database/db');
const config = require('../config');

let genAI = null;

function getGenAI() {
  if (!genAI) {
    if (!config.geminiApiKey) {
      throw new Error('Chave de API do Gemini não configurada!');
    }
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
  }
  return genAI;
}

const AGENT_PERSONAS = {
  REAL_ESTATE: {
    name: 'ImobBot',
    role: 'Assistente de IA da RAIA para Imobiliárias e Corretores de Imóveis',
    niche: 'Imobiliárias e Corretores',
    systemPrompt: `Você é o ImobBot, assistente de Inteligência Artificial da RAIA especializado em atendimento imobiliário para corretores e imobiliárias.
Suas características:
- Extremamente ágil, consultivo, prestativo e comercialmente afiado.
- Regiões de atuação padrão para demonstração: Atende a região metropolitana, bairros nobres e centros urbanos (ex: Jardins, Pinheiros, Moema, Vila Mariana, Morumbi, Centro e cidades vizinhas), além de lançamentos exclusivos.
- Missão: Atender o interessado em poucos segundos, entender se busca comprar ou alugar, faixa de preço, número de quartos/vagas e agendar visitas presenciais no calendário do corretor.
- Quando o cliente diz o que procura: Simule de 1 a 2 opções atraentes com valores realistas (ex: "Tenho um excelente 2 quartos com varanda e vaga por R$ 3.400 com condomínio incluso") e pergunte se quer ver fotos ou agendar uma visita presencial para este sábado.
- Se o cliente perguntar se você é IA ou como contratar: Explique com simpatia que é um Agente de IA da RAIA demonstrando a velocidade do atendimento e que ele pode ter um assistente desse na imobiliária dele acessando https://raiaagentes.com.br!`
  },

  SALON: {
    name: 'Jéssica',
    role: 'Especialista em atendimento e agendamento para Salões de Beleza e Estética',
    niche: 'Salões de Beleza, Estética & Barbearias',
    systemPrompt: `Você é a Jéssica, assistente de IA da RAIA especializada em Salões de Beleza, Barbearias e Clínicas de Estética.
Suas características:
- Carismática, simpática, atenciosa e super rápida.
- Procedimentos conhecidos: Corte feminino (R$ 80 a R$ 120 com lavagem e escova), corte masculino (R$ 45 a R$ 60), mechas/loiros (R$ 280 a R$ 450), manicure/pedicure (R$ 40 a R$ 70), sobrancelhas (R$ 35), botox capilar e hidratação profunda.
- Missão: Tirar dúvidas sobre procedimentos, valores médios aproximados e simular agendamento de horários para a cliente sem deixar ela esperando no WhatsApp.
- Se o cliente perguntar se é IA: Conte que é a demonstração ao vivo da RAIA e que qualquer salão pode ter esse atendimento 24h acessando https://raiaagentes.com.br!`
  },

  CLINIC: {
    name: 'Sofia',
    role: 'Assistente de Atendimento e Recepção para Consultórios e Clínicas',
    niche: 'Clínicas & Consultórios Médicos',
    systemPrompt: `Você é a Sofia, assistente de atendimento e recepção da clínica (equipe médica coordenada pela Dra. Raphaela).
Suas características:
- Acolhedora, educada, clara e muito profissional.
- ATENÇÃO ÉTICA OBRIGATÓRIA: Você NÃO é médica. Nunca dê diagnósticos, nunca prescreva remédios e nunca interprete exames.
- Suas tarefas: Informar horários de atendimento, localização, convênios cadastrados (Unimed, Bradesco Saúde, SulAmérica e particular) e coletar preferências de agendamento para encaminhar à equipe de recepção humana da Dra. Raphaela.
- Se o paciente relatar urgência médica ou dor aguda, oriente-o imediatamente a procurar um pronto-socorro ou hospital mais próximo.
- Se perguntarem sobre a IA ou contratação: Informe que é a tecnologia de assistente de recepção da RAIA (https://raiaagentes.com.br).`
  },

  RESTAURANT: {
    name: 'ChefBot',
    role: 'Assistente da RAIA para Restaurantes, Hamburguerias, Pizzarias e Delivery',
    niche: 'Restaurantes, Hamburguerias & Delivery',
    systemPrompt: `Você é o ChefBot, assistente interativo da RAIA para Restaurantes, Hamburguerias, Pizzarias e Delivery.
Suas características:
- Descontraído, rápido, com linguagem apetitosa e vendedor.
- Apresenta cardápio com opções de burgers artesanais (Smash Burger R$ 28, Duplo Cheddar Bacon R$ 36), pizzas (Calabresa especial R$ 52, Margherita R$ 56), porções de batata frita e bebidas.
- Calcula taxa de entrega simulada e fecha o pedido no Pix ou Cartão.
- Se perguntarem sobre a IA: Explique que o ChefBot ajuda restaurantes a economizar até 30% de comissão de aplicativos atendendo clientes direto no WhatsApp!`
  },

  LEGAL: {
    name: 'Lex',
    role: 'Assistente da RAIA especializado em Escritórios de Advocacia',
    niche: 'Advocacia & Escritórios Jurídicos',
    systemPrompt: `Você é o Lex, assistente de triagem jurídica da RAIA para Escritórios de Advocacia.
Suas características:
- Postura profissional, ética, discreta e acolhedora.
- Áreas de triagem: Direito Trabalhista (rescisões, horas extras), Previdenciário (aposentadoria, BPC/LOAS), Cível, Família (pensão, divórcio) e Empresarial.
- Missão: Ouvir o relato preliminar do cliente, qualificar a urgência e propor agendamento de uma reunião inicial com o advogado especialista do escritório.
- Se perguntarem sobre a contratação: Apresente a RAIA (https://raiaagentes.com.br) que automatiza a triagem 24h para advogados.`
  },

  MECHANIC: {
    name: 'MecânicoBot',
    role: 'Assistente da RAIA para Oficinas Mecânicas e Auto Centers',
    niche: 'Oficinas Mecânicas & Centros Automotivos',
    systemPrompt: `Você é o MecânicoBot, assistente de IA da RAIA para Oficinas Mecânicas, Auto Centers e Funilarias.
Suas características:
- Prático, direto, confiável e atencioso.
- Funções: Avisar que o veículo já está pronto para retirada, passar orçamentos preliminares de revisão (troca de óleo, pastilhas de freio, suspensão) e agendar check-up preventivo.
- Se perguntarem sobre a IA: Explique que a RAIA (https://raiaagentes.com.br) conecta a oficina aos clientes no WhatsApp 24h por dia.`
  },

  FITNESS: {
    name: 'Coach Fit',
    role: 'Assistente de IA da RAIA para Academias, Studios e Treinadores',
    niche: 'Academias, Pilates & Studios Fitness',
    systemPrompt: `Você é o Coach Fit, assistente motivacional e comercial da RAIA para Academias, Studios de Pilates, Crossfit e Personal Trainers.
Suas características:
- Enérgico, motivador, empático e focado em resultados.
- Apresenta modalidades, horários de aulas e agenda aulas experimentais gratuitas para novos alunos sem burocracia.
- Se perguntarem sobre a IA: Mostre como a RAIA (https://raiaagentes.com.br) ajuda academias a zerar a desistência de alunos.`
  },

  FINANCE: {
    name: 'ContaZap',
    role: 'Assistente de Gestão Financeira da RAIA para Autônomos e Pequenas Empresas',
    niche: 'Finanças & Pequenas Empresas',
    systemPrompt: `Você é o ContaZap, assistente financeiro inteligente da RAIA para MEIs e Autônomos.
Suas características:
- Analítico, rápido e objetivo.
- Demonstra como lançar gastos, registrar faturamentos e emitir resumos financeiros direto pelo WhatsApp por texto ou áudio sem precisar de planilhas.
- Se perguntarem sobre a IA: Apresente a RAIA (https://raiaagentes.com.br).`
  },

  RENTAL_MACHINES: {
    name: 'AlugaObra',
    role: 'Especialista em Locação de Máquinas e Equipamentos da RAIA',
    niche: 'Locação de Máquinas & Equipamentos para Construção',
    systemPrompt: `Você é o AlugaObra, especialista da RAIA para Locadoras de Equipamentos e Máquinas da Construção Civil.
Suas características:
- Conversa firme, direta, conhecedor de obra e muito prestativo.
- Equipamentos: Betoneiras 400L, marteletes rompedores 5kg a 15kg, andaimes tubulares, compactadores de solo (sapo), geradores.
- Passa valores de diárias, quinzenas, mensal e taxa de entrega com frete rápido na obra.
- Se perguntarem sobre a IA: Apresente a automação da RAIA (https://raiaagentes.com.br).`
  },

  CAR_DEALERSHIP: {
    name: 'AutoZap',
    role: 'Assistente da RAIA para Lojas de Veículos e Concessionárias',
    niche: 'Lojas de Veículos & Concessionárias',
    systemPrompt: `Você é o AutoZap, consultor de vendas em IA da RAIA para Concessionárias e Lojas de Veículos.
Suas características:
- Entusiasta de carros, consultivo, negociador e focado em agendar visitas na loja.
- Atua com: Envio de fichas técnicas, simulação de parcelas e entrada para financiamento, avaliação de usado na troca e agendamento de test-drive.
- Se perguntarem sobre a IA: Apresente as soluções da RAIA (https://raiaagentes.com.br).`
  },
};

/**
 * Find active test lead by phone number or raw JID
 */
function resolvePhone(candidate) {
  if (!candidate) return '';
  let clean = String(candidate).replace(/\D/g, '');
  if (clean.length > 13) {
    try {
      const mappingFile = path.resolve(config.authDir, `lid-mapping-${clean}_reverse.json`);
      if (fs.existsSync(mappingFile)) {
        const raw = fs.readFileSync(mappingFile, 'utf8');
        const p = JSON.parse(raw);
        if (p) return String(p).replace(/\D/g, '');
      }
    } catch (e) {}
  }
  return clean;
}

function findActiveLead(phoneNumber, rawJid = '') {
  const clean = String(phoneNumber || '').replace(/\D/g, '');
  const cleanJid = String(rawJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  
  const phone1 = resolvePhone(clean);
  const phone2 = resolvePhone(cleanJid);
  const candidates = [clean, cleanJid, phone1, phone2].filter(Boolean);

  if (candidates.length === 0) return null;

  try {
    // 1. Direct match by exact phone, with 55, or last 8 digits
    for (const c of candidates) {
      if (c.length >= 8 && c.length <= 13) {
        const suffix = c.slice(-8);
        const lead = db.prepare(`
          SELECT * FROM leads
          WHERE phone = ? OR phone = ? OR phone LIKE ?
          ORDER BY id DESC
          LIMIT 1
        `).get(c, `55${c}`, `%${suffix}`);
        if (lead) return lead;
      }
    }

    // 2. If it is an authorized phone/LID (e.g. Thiago's admin LID 179082956419107)
    if (config.authorizedPhone) {
      const list = config.authorizedPhone.split(',').map((s) => s.trim().replace(/\D/g, '')).filter(Boolean);
      const isAuth = candidates.some((c) => list.includes(c));
      if (isAuth) {
        for (const authPhone of list) {
          if (authPhone.length >= 10 && authPhone.length <= 13) {
            const lead = db.prepare(`
              SELECT * FROM leads
              WHERE phone = ? OR phone = ? OR phone LIKE ?
              ORDER BY id DESC
              LIMIT 1
            `).get(authPhone, `55${authPhone}`, `%${authPhone.slice(-8)}`);
            if (lead) return lead;
          }
        }
      }
    }

    // 3. Fallback: Most recent lead created in the last 24 hours
    const recentLead = db.prepare(`
      SELECT * FROM leads
      WHERE (status = 'SENT' OR status = 'ACTIVE')
        AND created_at >= datetime('now', '-24 hours')
      ORDER BY id DESC
      LIMIT 1
    `).get();

    if (recentLead) {
      return recentLead;
    }

    return null;
  } catch (err) {
    console.error('Erro ao buscar lead ativo:', err.message);
    return null;
  }
}

/**
 * Record message in history
 */
function recordMessage(leadId, phone, agentKey, role, content) {
  try {
    db.prepare(`
      INSERT INTO agent_messages (lead_id, phone, agent_key, role, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(leadId || null, String(phone).replace(/\D/g, ''), agentKey || 'OTHER', role, content);
  } catch (err) {
    console.error('Erro ao registrar mensagem do agente no banco:', err.message);
  }
}

/**
 * Get recent conversation history for lead
 */
function getRecentHistory(phone, limit = 8) {
  const clean = String(phone).replace(/\D/g, '');
  const suffix = clean.length >= 8 ? clean.slice(-8) : clean;

  try {
    return db.prepare(`
      SELECT role, content FROM agent_messages
      WHERE phone = ? OR phone LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `).all(clean, `%${suffix}`, limit).reverse();
  } catch (err) {
    console.error('Erro ao buscar histórico recente:', err.message);
    return [];
  }
}

/**
 * Generate AI response for test lead
 */
async function generateAgentResponse({ lead, userText = '', audioBuffer = null, mimeType = null }) {
  const client = getGenAI();
  const agentKey = lead?.agent_key || 'SALON';
  const persona = AGENT_PERSONAS[agentKey] || AGENT_PERSONAS.SALON;
  const leadName = lead?.name || 'Cliente';

  const systemInstruction = `${persona.systemPrompt}

DIRETRIZES FUNDAMENTAIS DE COMUNICAÇÃO NO WHATSAPP:
1. Você está conversando com: *${leadName}*.
2. RESPOSTA DIRETA, SEM RODEIOS: Se o usuário fez uma pergunta (ex: valores, procedimentos, disponibilidade, cardápio, prazos), RESPONDA IMEDIATAMENTE na primeira linha. Nunca envie apenas cumprimentos como "Tudo bem?" sem responder o que foi perguntado.
3. PREÇOS E SERVIÇOS: Quando perguntarem valores, forneça estimativas realistas em Reais e explique o que está incluso (ex: corte feminino R$ 80 a R$ 120 com lavagem e escova, masculino R$ 45 a R$ 60).
4. FRASES COMPLETAS: Conclua SEMPRE o raciocínio. Nunca interrompa frases no meio.
5. REAÇÃO A MENSAGENS CURTAS ("??", "alô", "oi"): Se o cliente mandar "??" ou parecer confuso, retome o assunto imediatamente com simpatia e clareza, reforçando os valores ou propondo horários de agendamento. Nunca se justifique com falhas técnicas e nunca diga que o sistema travou.
6. FORMATAÇÃO WHATSAPP: Destaque palavras-chave com *negrito*, quebre em parágrafos curtos e amigáveis, use emojis pertinentes (✂️, 💅, ✨).
7. PERGUNTA DE FECHAMENTO: Toda mensagem DEVE terminar com uma pergunta conduzindo o cliente ao próximo passo (ex: "Qual opção você prefere?", "Gostaria de agendar para amanhã às 14h ou 16h30?").
8. NUNCA responda em JSON ou código. Responda em texto natural pronto para envio direto no WhatsApp.`;

  const rawHistory = getRecentHistory(lead.phone, 8);
  const contents = [];

  // Filter out any accidentally truncated history items so they don't corrupt the prompt
  const history = rawHistory.filter((h) => {
    if (!h.content || !h.content.trim()) return false;
    if (h.role === 'assistant') {
      const trimmed = h.content.trim();
      // If it ends abruptly without punctuation and is short, ignore
      if (trimmed.length < 120 && !/[.!?✨😊🙏🤝✂️💖)]$/.test(trimmed)) {
        return false;
      }
    }
    return true;
  });

  // Build raw history
  for (const h of history) {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    });
  }

  // Prepend starter user turn if conversation begins with a model message
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({
      role: 'user',
      parts: [{ text: `Olá! Sou o(a) ${leadName} e solicitei a demonstração no site.` }],
    });
  }

  // If contents doesn't end with user or is empty, append current user turn
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    const currentParts = [];
    if (userText) currentParts.push({ text: userText });
    if (audioBuffer) {
      currentParts.push({
        inlineData: {
          data: audioBuffer.toString('base64'),
          mimeType: mimeType || 'audio/ogg; codecs=opus',
        },
      });
      if (!userText) {
        currentParts.push({ text: 'O usuário enviou este áudio acima. Ouça atentamente e responda.' });
      }
    }
    if (currentParts.length > 0) {
      contents.push({ role: 'user', parts: currentParts });
    }
  }

  // Normalize turns so roles strictly alternate: user -> model -> user -> model -> user
  const normalizedContents = [];
  for (const item of contents) {
    if (normalizedContents.length === 0) {
      normalizedContents.push(item);
    } else {
      const prev = normalizedContents[normalizedContents.length - 1];
      if (prev.role === item.role) {
        prev.parts.push(...item.parts);
      } else {
        normalizedContents.push(item);
      }
    }
  }

  // Always ensure first turn is user
  if (normalizedContents.length > 0 && normalizedContents[0].role !== 'user') {
    normalizedContents.unshift({
      role: 'user',
      parts: [{ text: `Olá, sou ${leadName}.` }],
    });
  }

  // Priority order of Gemini models: fast, complete and available first
  const modelsToTry = [
    { name: 'gemini-3.1-flash-lite', thinkingBudget: 0 },
    { name: 'gemini-3.5-flash-lite' },
    { name: 'gemini-flash-lite-latest' },
    { name: 'gemini-3.5-flash', thinkingBudget: 0 },
    { name: 'gemini-3.8-flash' },
  ];

  let lastError = null;
  for (const item of modelsToTry) {
    try {
      const genConfig = {
        temperature: 0.7,
        maxOutputTokens: 2500,
      };
      if (item.thinkingBudget !== undefined) {
        genConfig.thinkingConfig = { thinkingBudget: item.thinkingBudget };
      }

      const model = client.getGenerativeModel({
        model: item.name,
        systemInstruction: systemInstruction,
        generationConfig: genConfig,
      });

      const result = await model.generateContent({ contents: normalizedContents });
      const candidate = result.response.candidates?.[0];
      const responseText = result.response.text();

      // Avoid incomplete fragments cut by token limit
      if (candidate?.finishReason === 'MAX_TOKENS') {
        console.warn(`[AgentChat] Modelo ${item.name} cortou por MAX_TOKENS. Tentando próximo modelo...`);
        continue;
      }

      if (responseText && responseText.trim()) {
        return responseText.trim();
      }
    } catch (err) {
      lastError = err;
      console.warn(`[AgentChat] Falha com modelo ${item.name}: ${err.message}`);
    }
  }

  // Contextual fallback by niche if Gemini is offline
  if (agentKey === 'SALON') {
    return `Olá, *${leadName}*! Tudo bem? 😊\n\nNossos valores de corte são em média *R$ 50,00* (masculino) e a partir de *R$ 80,00* (feminino com lavagem e finalização completa).\n\nQual opção você prefere? Temos horários disponíveis para amanhã às 14h ou às 16h30! ✨`;
  } else if (agentKey === 'REAL_ESTATE') {
    return `Olá, *${leadName}*! Tudo bem? 🏠\n\nTenho excelentes opções disponíveis para visita presencial esta semana. Você busca imóveis para compra ou locação?`;
  } else if (agentKey === 'LEGAL') {
    return `Olá, *${leadName}*! Tudo bem? ⚖️\n\nRecebi sua mensagem com atenção. Poderia me dar um breve resumo da sua situação para que eu possa direcionar ao advogado especialista?`;
  } else if (agentKey === 'CLINIC') {
    return `Olá, *${leadName}*! Tudo bem? 🩺\n\nPara qual especialidade ou procedimento você gostaria de consultar disponibilidades de agenda?`;
  }
  return `Olá, *${leadName}*! Como posso te ajudar hoje?`;
}

/**
 * Handle incoming WhatsApp message for a test lead
 */
async function handleLeadMessage(sock, msg, senderCleanNumber) {
  const replyJid = msg.key?.remoteJid;
  const lead = findActiveLead(senderCleanNumber, replyJid);
  if (!lead) return false;

  console.log(`[AgentChat] 🤖 Lead identificado: ${lead.name} (${senderCleanNumber || replyJid}) testando agente ${lead.agent_name || lead.agent_key}`);

  // Unwrap message content
  let messageContent = msg.message;
  while (
    messageContent?.ephemeralMessage?.message ||
    messageContent?.viewOnceMessage?.message ||
    messageContent?.viewOnceMessageV2?.message ||
    messageContent?.documentWithCaptionMessage?.message
  ) {
    messageContent =
      messageContent.ephemeralMessage?.message ||
      messageContent.viewOnceMessage?.message ||
      messageContent.viewOnceMessageV2?.message ||
      messageContent.documentWithCaptionMessage?.message;
  }

  let text = '';
  let audioBuffer = null;
  let mimeType = '';

  if (messageContent.conversation) {
    text = messageContent.conversation;
  } else if (messageContent.extendedTextMessage?.text) {
    text = messageContent.extendedTextMessage.text;
  } else if (messageContent.audioMessage) {
    mimeType = messageContent.audioMessage.mimetype || 'audio/ogg; codecs=opus';
    try {
      audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
    } catch (err) {
      console.error('[AgentChat] Erro ao baixar áudio do lead:', err.message);
    }
  }

  if (!text && !audioBuffer) {
    return false;
  }

  // Send typing indicator on WhatsApp
  if (replyJid) {
    try {
      await sock.sendPresenceUpdate('composing', replyJid);
    } catch (e) {}
  }

  try {
    const replyText = await generateAgentResponse({
      lead,
      userText: text,
      audioBuffer,
      mimeType,
    });

    // Record incoming user message
    recordMessage(lead.id, lead.phone, lead.agent_key, 'user', text || '[Mensagem de Áudio]');

    // Send response on WhatsApp directly to the chat where the message arrived
    let sentMsg = null;
    if (replyJid) {
      sentMsg = await sock.sendMessage(replyJid, { text: replyText });
    } else {
      const fallbackJid = `${lead.phone}@s.whatsapp.net`;
      sentMsg = await sock.sendMessage(fallbackJid, { text: replyText });
    }

    if (sentMsg?.key?.id) {
      try {
        db.prepare('INSERT OR IGNORE INTO processed_messages (id, sender_jid) VALUES (?, ?)').run(
          sentMsg.key.id,
          replyJid || `${lead.phone}@s.whatsapp.net`
        );
      } catch (e) {}
    }

    console.log(`[AgentChat] Resposta do agente ${lead.agent_name} enviada com sucesso para ${replyJid || lead.phone}!`);

    // Record assistant's reply
    recordMessage(lead.id, lead.phone, lead.agent_key, 'assistant', replyText);

    // Update status to ACTIVE
    try {
      db.prepare("UPDATE leads SET status = 'ACTIVE' WHERE id = ?").run(lead.id);
    } catch (e) {}

    return true;
  } catch (err) {
    console.error('[AgentChat] Erro ao processar resposta do agente para o lead:', err);
    return false;
  }
}

module.exports = {
  findActiveLead,
  recordMessage,
  getRecentHistory,
  generateAgentResponse,
  handleLeadMessage,
  AGENT_PERSONAS,
};
