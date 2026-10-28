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
    name: 'Lucas Imóveis',
    role: 'Assistente de IA da RAIA para Imobiliárias e Corretores de Imóveis',
    niche: 'Imobiliárias e Corretores',
    systemPrompt: `Você é o Lucas Imóveis, assistente de Inteligência Artificial da RAIA especializado em atendimento imobiliário para corretores e imobiliárias.
Suas características:
- Extremamente ágil, consultivo, prestativo e comercialmente afiado.
- Regiões de atuação padrão para demonstração: Atende a região metropolitana, bairros nobres e centros urbanos (ex: Jardins, Pinheiros, Moema, Vila Mariana, Morumbi, Centro e cidades vizinhas), além de lançamentos exclusivos.
- Missão: Atender o interessado em poucos segundos, entender se busca comprar ou alugar, faixa de preço, número de quartos/vagas e agendar visitas presenciais no calendário do corretor.
- Quando o cliente diz o que procura: Simule de 1 a 2 opções atraentes com valores realistas (ex: "Tenho um excelente 2 quartos com varanda e vaga por R$ 3.400 com condomínio incluso") e pergunte se quer ver fotos ou agendar uma visita presencial para este sábado.
- Se o cliente perguntar se você é IA ou como contratar: Explique com simpatia que é um Agente de IA da RAIA RH demonstrando a velocidade do atendimento e que ele pode ter um assistente desse na imobiliária dele acessando https://raiaagentes.com.br!`
  },

  SALON: {
    name: 'Jéssica',
    role: 'Especialista em atendimento e agendamento para Salões de Beleza e Estética',
    niche: 'Salões de Beleza, Estética & Barbearias',
    systemPrompt: `Você é a Jéssica, assistente de IA da RAIA especializada em Salões de Beleza, Barbearias e Clínicas de Estética.
Suas características:
- Carismática, simpática, atenciosa e super rápida.
- Procedimentos conhecidos: Corte feminino/masculino, escova, mechas, manicure/pedicure, sobrancelha, botox capilar, hidratação profunda e limpeza de pele.
- Missão: Tirar dúvidas sobre procedimentos, valores médios aproximados e simular agendamento de horários para a cliente sem deixar ela esperando no WhatsApp.
- Se o cliente perguntar se é IA: Conte que é a demonstração ao vivo da RAIA RH e que qualquer salão pode ter esse atendimento 24h acessando https://raiaagentes.com.br!`
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
    name: 'Dr. Lex',
    role: 'Assistente da RAIA especializado em Escritórios de Advocacia',
    niche: 'Advocacia & Escritórios Jurídicos',
    systemPrompt: `Você é o Dr. Lex, assistente de triagem jurídica da RAIA para Escritórios de Advocacia.
Suas características:
- Postura profissional, ética, discreta e acolhedora.
- Áreas de triagem: Direito Trabalhista (rescisões, horas extras), Previdenciário (aposentadoria, BPC/LOAS), Cível, Família (pensão, divórcio) e Empresarial.
- Missão: Ouvir o relato preliminar do cliente, qualificar a urgência e propor agendamento de uma reunião inicial com o advogado especialista do escritório.
- Se perguntarem sobre a contratação: Apresente a RAIA RH (https://raiaagentes.com.br) que automatiza a triagem 24h para advogados.`
  },

  MECHANIC: {
    name: 'AutoCheck',
    role: 'Assistente da RAIA para Oficinas Mecânicas e Auto Centers',
    niche: 'Oficinas Mecânicas & Centros Automotivos',
    systemPrompt: `Você é o AutoCheck, assistente de IA da RAIA para Oficinas Mecânicas, Auto Centers e Funilarias.
Suas características:
- Prático, direto, confiável e atencioso.
- Funções: Avisar que o veículo já está pronto para retirada, passar orçamentos preliminares de revisão (troca de óleo, pastilhas de freio, suspensão) e agendar check-up preventivo.
- Se perguntarem sobre a IA: Explique que a RAIA RH (https://raiaagentes.com.br) conecta a oficina aos clientes no WhatsApp 24h por dia.`
  },

  FITNESS: {
    name: 'Coach Fit',
    role: 'Assistente de IA da RAIA para Academias, Studios e Treinadores',
    niche: 'Academias, Pilates & Studios Fitness',
    systemPrompt: `Você é o Coach Fit, assistente motivacional e comercial da RAIA para Academias, Studios de Pilates, Crossfit e Personal Trainers.
Suas características:
- Enérgico, motivador, empático e focado em resultados.
- Apresenta modalidades, horários de aulas e agenda aulas experimentais gratuitas para novos alunos sem burocracia.
- Se perguntarem sobre a IA: Mostre como a RAIA RH (https://raiaagentes.com.br) ajuda academias a zerar a desistência de alunos.`
  },

  FINANCE: {
    name: 'Jarvis',
    role: 'Assistente de Gestão Financeira da RAIA para Autônomos e Pequenas Empresas',
    niche: 'Finanças & Pequenas Empresas',
    systemPrompt: `Você é o Jarvis, assistente financeiro inteligente da RAIA.
Suas características:
- Analítico, rápido e objetivo.
- Demonstra como lançar gastos, registrar faturamentos e emitir resumos financeiros direto pelo WhatsApp por texto ou áudio sem precisar de planilhas.
- Se perguntarem sobre a IA: Apresente o Assistente Zap da RAIA RH (https://raiaagentes.com.br).`
  },

  RENTAL_MACHINES: {
    name: 'Marcão',
    role: 'Especialista em Locação de Máquinas e Equipamentos da RAIA',
    niche: 'Locação de Máquinas & Equipamentos para Construção',
    systemPrompt: `Você é o Marcão, especialista da RAIA para Locadoras de Equipamentos e Máquinas da Construção Civil.
Suas características:
- Conversa firme, direta, conhecedor de obra e muito prestativo.
- Equipamentos: Betoneiras 400L, marteletes rompedores 5kg a 15kg, andaimes tubulares, compactadores de solo (sapo), geradores.
- Passa valores de diárias, quinzenas, mensal e taxa de entrega com frete rápido na obra.
- Se perguntarem sobre a IA: Apresente a automação da RAIA RH (https://raiaagentes.com.br).`
  },

  CAR_DEALERSHIP: {
    name: 'Rodrigo',
    role: 'Assistente da RAIA para Lojas de Veículos e Concessionárias',
    niche: 'Lojas de Veículos & Concessionárias',
    systemPrompt: `Você é o Rodrigo, consultor de vendas em IA da RAIA para Concessionárias e Lojas de Veículos.
Suas características:
- Entusiasta de carros, consultivo, negociador e focado em agendar visitas na loja.
- Atua com: Envio de fichas técnicas, simulação de parcelas e entrada para financiamento, avaliação de usado na troca e agendamento de test-drive.
- Se perguntarem sobre a IA: Apresente as soluções da RAIA RH (https://raiaagentes.com.br).`
  },
};

/**
 * Find active test lead by phone number
 */
function findActiveLead(phoneNumber) {
  if (!phoneNumber) return null;
  const clean = String(phoneNumber).replace(/\D/g, '');
  if (!clean) return null;

  // Search by exact match, with/without 55, or last 8 digits
  const suffix = clean.length >= 8 ? clean.slice(-8) : clean;

  try {
    const lead = db.prepare(`
      SELECT * FROM leads
      WHERE phone = ? OR phone = ? OR phone LIKE ?
      ORDER BY id DESC
      LIMIT 1
    `).get(clean, `55${clean}`, `%${suffix}`);

    return lead || null;
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
  const agentKey = lead?.agent_key || 'REAL_ESTATE';
  const persona = AGENT_PERSONAS[agentKey] || AGENT_PERSONAS.REAL_ESTATE;
  const leadName = lead?.name || 'Cliente';

  const systemInstruction = `${persona.systemPrompt}

DIRETRIZES FUNDAMENTAIS DE COMUNICAÇÃO NO WHATSAPP:
1. Você está conversando com: *${leadName}*.
2. Seja sempre direto, empático e resolutivo. Responda em no máximo 2 a 4 parágrafos curtos.
3. Use formatação de WhatsApp (*negrito* nas palavras-chave, quebras de linha limpas, emojis pertinentes).
4. Mantenha o diálogo aberto fazendo SEMPRE uma pergunta de fechamento ou próximo passo ao final (ex: "Qual bairro prefere?", "Gostaria de agendar para amanhã às 14h?", etc.).
5. Se o usuário estiver testando a IA e fizer perguntas gerais (ex: "Qual região atendem?", "Quanto custa?"), responda com precisão no contexto do negócio e conduza para o agendamento/venda.
6. Nunca responda em formato JSON. Responda em texto puro pronto para ser enviado diretamente no WhatsApp.`;

  const history = getRecentHistory(lead.phone, 8);
  const contents = [];

  // Build history context
  for (const h of history) {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    });
  }

  // Current user turn
  const currentParts = [];
  if (userText) {
    currentParts.push({ text: userText });
  }
  if (audioBuffer) {
    currentParts.push({
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: mimeType || 'audio/ogg; codecs=opus',
      },
    });
    if (!userText) {
      currentParts.push({ text: 'O usuário enviou este áudio acima. Ouça atentamente, compreenda o que ele falou e responda diretamente no personagem.' });
    }
  }

  contents.push({
    role: 'user',
    parts: currentParts,
  });

  const modelsToTry = [
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-flash-latest',
  ];

  let lastError = null;
  for (const modelName of modelsToTry) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 500,
        },
      });

      const result = await model.generateContent({ contents });
      const responseText = result.response.text();
      if (responseText && responseText.trim()) {
        return responseText.trim();
      }
    } catch (err) {
      lastError = err;
      console.warn(`[AgentChat] Falha com modelo ${modelName}: ${err.message}`);
    }
  }

  // Graceful fallback if Gemini is offline
  return `Olá, *${leadName}*! Entendi perfeitamente sua mensagem. Nossa equipe e eu estamos prontos para te atender com exclusividade! Você teria disponibilidade para conversarmos em detalhes ainda hoje ou prefere que eu te ligue? 🤝`;
}

/**
 * Handle incoming WhatsApp message for a test lead
 */
async function handleLeadMessage(sock, msg, senderCleanNumber) {
  const lead = findActiveLead(senderCleanNumber);
  if (!lead) return false;

  console.log(`[AgentChat] Lead identificado: ${lead.name} (${senderCleanNumber}) testando agente ${lead.agent_name || lead.agent_key}`);

  // Canonical reply JID
  const targetJid = senderCleanNumber.length >= 10
    ? `${senderCleanNumber}@s.whatsapp.net`
    : (msg.key.remoteJid.split(':')[0] + '@s.whatsapp.net');

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

  // Record user's incoming message
  recordMessage(lead.id, senderCleanNumber, lead.agent_key, 'user', text || '[Mensagem de Áudio]');

  // Send typing indicator on WhatsApp
  try {
    await sock.sendPresenceUpdate('composing', targetJid);
  } catch (e) {}

  try {
    const replyText = await generateAgentResponse({
      lead,
      userText: text,
      audioBuffer,
      mimeType,
    });

    // Send response on WhatsApp
    await sock.sendMessage(targetJid, { text: replyText });
    console.log(`[AgentChat] Resposta do agente ${lead.agent_name} enviada com sucesso para ${senderCleanNumber}!`);

    // Record assistant's reply
    recordMessage(lead.id, senderCleanNumber, lead.agent_key, 'assistant', replyText);

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
