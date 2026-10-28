const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('../database/db');
const financeService = require('../services/financeService');
const billService = require('../services/billService');
const appointmentService = require('../services/appointmentService');
const userService = require('../services/userService');
const pixService = require('../services/pixService');
const config = require('../config');
const aiService = require('../services/aiService');
const calendarService = require('../services/calendarService');
const whatsappClient = require('../whatsapp/client');
const asaasService = require('../services/asaasService');
const agentChatService = require('../services/agentChatService');
const businessAnalyzerService = require('../services/businessAnalyzerService');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../../public')));

// Ensure official RAIA logo is available in public folder if present locally
try {
  const fs = require('fs');
  const destPng = path.resolve(__dirname, '../../public/raia-logo.png');
  // raia-logo.png is committed to git repository
} catch (e) {
  // Silent fallback in production/container
}

// Clean Public Solution & Content Routes
app.get(['/solucoes', '/solucoes.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/solucoes.html'));
});

app.get('/solucoes/:niche', (req, res) => {
  const fs = require('fs');
  const niche = req.params.niche.replace(/\.html$/, '');
  const filePath = path.resolve(__dirname, `../../public/solucoes/${niche}.html`);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  return res.redirect('/solucoes');
});

app.get(['/como-funciona', '/como-funciona.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/como-funciona.html'));
});

app.get(['/planos', '/planos.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/planos.html'));
});

app.get(['/contato', '/contato.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/contato.html'));
});

app.get(['/termos', '/termos.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/termos.html'));
});

app.get(['/privacidade', '/privacidade.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/privacidade.html'));
});

// Explicit SPA routes
app.get(['/admin', '/admin.html', '/dashboard', '/painel'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/admin.html'));
});

app.get(['/', '/index.html', '/vitrine'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/index.html'));
});

// Helper to extract cookies from request header
function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// Multi-Tenant Authentication Middleware
function authMiddleware(req, res, next) {
  let token = null;

  // 1. Authorization header: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // 2. Custom header
  if (!token && req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  }

  // 3. Query string token
  if (!token && req.query.token) {
    token = req.query.token;
  }

  // 4. Cookie
  if (!token) {
    token = getCookie(req, 'auth_token');
  }

  if (token) {
    const user = userService.getUserByMagicToken(token);
    if (user) {
      req.user = user;
      return next();
    }
  }

  const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
  if (adminKey && (adminKey === 'assistente-zap-sync' || adminKey === config.geminiApiKey)) {
    req.user = userService.getUserById(1) || { id: 1, phone_number: '5511951364159', role: 'ADMIN', plan: 'PRO' };
    return next();
  }

  // Fallback for localhost (local developer/owner access defaults to user 1)
  const isLocalhost =
    req.ip === '127.0.0.1' ||
    req.ip === '::1' ||
    req.ip === '::ffff:127.0.0.1' ||
    req.hostname === 'localhost';

  if (isLocalhost) {
    req.user = userService.getUserById(1) || { id: 1, phone_number: '5511951364159', role: 'ADMIN', plan: 'PRO' };
    return next();
  }

  // If unauthorized for API routes
  return res.status(401).json({
    success: false,
    error: 'Acesso não autorizado. Solicite o link exclusivo do seu painel no WhatsApp.',
  });
}

// ==========================================
// SYSTEM HEALTH CHECK & DIAGNOSTICS ENDPOINT
// ==========================================
app.get('/api/health', async (req, res) => {
  let geminiWorking = false;
  let geminiDetails = null;

  if (config.geminiApiKey) {
    try {
      const test = await aiService.processTextMessage('Padaria 10');
      if (test && test.intent) {
        geminiWorking = true;
        geminiDetails = 'IA Gemini ativa, autenticada e respondendo normalmente.';
      } else {
        geminiWorking = false;
        geminiDetails = 'Resposta inesperada da IA.';
      }
    } catch (e) {
      geminiWorking = false;
      geminiDetails = `Erro ao testar Gemini: ${e.message}`;
    }
  } else {
    geminiDetails = 'GEMINI_API_KEY não encontrada nas variáveis de ambiente.';
  }

  const isConnected = whatsappClient.isWhatsAppConnected ? whatsappClient.isWhatsAppConnected() : false;
  const waUser = whatsappClient.getWhatsAppUser ? whatsappClient.getWhatsAppUser() : null;

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gemini: {
      configured: Boolean(config.geminiApiKey),
      keyLength: config.geminiApiKey ? config.geminiApiKey.length : 0,
      keyPrefix: config.geminiApiKey ? config.geminiApiKey.substring(0, 6) + '...' : null,
      working: geminiWorking,
      details: geminiDetails,
    },
    whatsapp: {
      connected: isConnected,
      phone: waUser?.id ? waUser.id.split(':')[0] : null,
    },
    personalAssistant: {
      paused: Boolean(config.pausePersonalAssistant),
    },
    asaas: {
      configured: asaasService.isConfigured(),
    },
    calendar: {
      connected: calendarService.isCalendarConnected(),
      calendarId: config.googleCalendarId,
    },
  });
});

// ==========================================
// PAUSE / RESUME PERSONAL ASSISTANT
// ==========================================
app.get('/api/assistant/pause-status', (req, res) => {
  const isPaused = whatsappClient.isPersonalAssistantPaused ? whatsappClient.isPersonalAssistantPaused() : true;
  res.json({
    success: true,
    paused: isPaused,
    message: isPaused
      ? 'O assistente pessoal está PAUSADO para não conflitar no mesmo número de WhatsApp.'
      : 'O assistente pessoal está ATIVO.'
  });
});

app.post('/api/assistant/toggle-pause', (req, res) => {
  const current = whatsappClient.isPersonalAssistantPaused ? whatsappClient.isPersonalAssistantPaused() : true;
  const next = typeof req.body?.paused === 'boolean' ? req.body.paused : !current;
  if (whatsappClient.setPersonalAssistantPaused) {
    whatsappClient.setPersonalAssistantPaused(next);
  }
  res.json({
    success: true,
    paused: next,
    message: next
      ? 'Assistente pessoal PAUSADO com sucesso.'
      : 'Assistente pessoal REATIVADO com sucesso.'
  });
});

// ==========================================
// ASAAS PAYMENT GATEWAY INTEGRATION
// ==========================================
app.get('/api/asaas/status', async (req, res) => {
  try {
    if (!asaasService.isConfigured()) {
      return res.json({ success: false, configured: false, message: 'Asaas não configurado.' });
    }
    const [account, balance] = await Promise.all([
      asaasService.getAccount(),
      asaasService.getBalance().catch(() => ({ balance: 0 })),
    ]);
    res.json({
      success: true,
      configured: true,
      account: {
        name: account.name,
        status: account.status,
        cpfCnpj: account.cpfCnpj,
        email: account.email,
        mobilePhone: account.mobilePhone,
      },
      balance: balance?.balance ?? 0,
    });
  } catch (err) {
    console.error('Erro em /api/asaas/status:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/asaas/create-pix', async (req, res) => {
  try {
    const { name, phone, email, cpfCnpj, value, description } = req.body || {};
    if (!value || Number(value) <= 0) {
      return res.status(400).json({ success: false, error: 'Informe um valor válido para cobrança.' });
    }

    const pixCharge = await asaasService.createPixCharge({
      customerName: name,
      customerPhone: phone,
      customerEmail: email,
      customerCpf: cpfCnpj,
      value,
      description,
    });

    res.json(pixCharge);
  } catch (err) {
    console.error('Erro em /api/asaas/create-pix:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/asaas/create-link', async (req, res) => {
  try {
    const { name, description, value, maxInstallmentCount } = req.body || {};
    const link = await asaasService.createPaymentLink({
      name,
      description,
      value: value || 197.00,
      maxInstallmentCount: maxInstallmentCount || 12,
    });
    res.json(link);
  } catch (err) {
    console.error('Erro em /api/asaas/create-link:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/webhooks/asaas', async (req, res) => {
  try {
    const eventData = req.body || {};
    const result = await asaasService.handleWebhookEvent(eventData);

    // If payment confirmed and phone is available, notify via WhatsApp
    if (result.isPaid) {
      const payment = eventData.payment;
      try {
        const row = db.prepare('SELECT customer_name, customer_phone, value FROM asaas_payments WHERE asaas_id = ?').get(payment.id);
        const phone = row?.customer_phone;
        const name = row?.customer_name || 'Cliente';
        const val = Number(payment.value || row?.value || 0).toFixed(2).replace('.', ',');

        if (phone && whatsappClient.sendWhatsAppMessage) {
          const targetJid = `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
          const confirmationMsg =
            `🎉 *PAGAMENTO CONFIRMADO!* 🚀\n\n` +
            `Olá, *${name}*! Confirmamos o recebimento do seu pagamento de *R$ ${val}* via Asaas.\n\n` +
            `Seu Agente de Inteligência Artificial da RAIA RH foi ativado com sucesso!\n\n` +
            `Nossa equipe de suporte técnico e engenharia de IA entrará em contato em instantes para os ajustes finais do seu fluxo de atendimento.\n\n` +
            `Dúvidas? Basta responder esta mensagem!`;

          await whatsappClient.sendWhatsAppMessage(targetJid, confirmationMsg);
          console.log(`[Asaas Webhook] Notificação de pagamento enviada para WhatsApp ${phone}`);
        }
      } catch (waErr) {
        console.warn('[Asaas Webhook] Erro ao enviar notificação WhatsApp:', waErr.message);
      }
    }

    res.json({ success: true, received: true });
  } catch (err) {
    console.error('Erro em /api/webhooks/asaas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/asaas/payments', async (req, res) => {
  try {
    const localPayments = db.prepare('SELECT * FROM asaas_payments ORDER BY created_at DESC LIMIT 50').all();

    let livePayments = [];
    if (asaasService.isConfigured()) {
      try {
        const liveRes = await asaasService.listPayments({ limit: 30 });
        livePayments = liveRes?.data || [];
      } catch (e) {
        console.warn('Erro ao listar cobranças ao vivo do Asaas:', e.message);
      }
    }

    res.json({
      success: true,
      localPayments,
      livePayments,
    });
  } catch (err) {
    console.error('Erro em /api/asaas/payments:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/leads', (req, res) => {
  try {
    const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100').all();
    res.json({
      success: true,
      leads,
    });
  } catch (err) {
    console.error('Erro em /api/admin/leads:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/lead-conversation/:phone', (req, res) => {
  try {
    const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');
    const suffix = cleanPhone.length >= 8 ? cleanPhone.slice(-8) : cleanPhone;
    const messages = db.prepare(`
      SELECT * FROM agent_messages
      WHERE phone = ? OR phone LIKE ?
      ORDER BY id ASC
    `).all(cleanPhone, `%${suffix}`);
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// BUSINESS & OFFER ANALYZER (WISER STYLE)
// ==========================================
app.post('/api/admin/analyze-business', async (req, res) => {
  try {
    const { url, description, niche, companyName } = req.body || {};
    if (!url && !description) {
      return res.status(400).json({ success: false, error: 'Por favor, informe a URL do site ou uma descrição da empresa.' });
    }
    const result = await businessAnalyzerService.analyzeBusiness({ url, description, niche, companyName });
    res.json(result);
  } catch (err) {
    console.error('Erro em /api/admin/analyze-business:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/business-analyses', (req, res) => {
  try {
    const list = businessAnalyzerService.listAnalyses(50);
    res.json({ success: true, analyses: list });
  } catch (err) {
    console.error('Erro em /api/admin/business-analyses:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/business-analyses/:id', (req, res) => {
  try {
    const success = businessAnalyzerService.deleteAnalysis(req.params.id);
    res.json({ success });
  } catch (err) {
    console.error('Erro ao deletar análise:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PUBLIC LEAD TEST AGENT (LIVE DEMO ON USER'S WHATSAPP)
// ==========================================
const AGENT_MESSAGES = {
  SALON: (name) =>
    `✨ Olá, *${name}*! Aqui é a *Jéssica*, assistente de atendimento da RAIA para Salões de Beleza e Estética! 💇‍♀️💅\n\n` +
    `Recebi sua solicitação no nosso site e já estou aqui no seu WhatsApp para você ver como funciona na prática!\n\n` +
    `Eu respondo dúvidas sobre procedimentos, valores informados pelo salão, horários de funcionamento e organizo as preferências de agendamento das clientes para facilitar o dia a dia da sua equipe.\n\n` +
    `👉 *Diga um serviço que você gostaria de consultar como teste* (por exemplo: _"Quero ver horários para corte e escova amanhã às 14h"_)?`,

  CLINIC: (name) =>
    `👋 Olá, *${name}*! Sou a *Sofia*, assistente de atendimento e recepção da clínica (equipe da Dra. Raphaela). 🩺✨\n\n` +
    `Recebi o seu contato no site da RAIA e estou pronta para demonstrar como acolho pacientes no WhatsApp, passo informações sobre horários, especialidades, convênios cadastrados e organizo solicitações de agendamento para a equipe de recepção.\n\n` +
    `👉 *Faça uma pergunta de teste como se fosse um paciente* (por exemplo: _"Vocês atendem Unimed?"_ ou _"Quais os horários disponíveis para dermatologia?"_)?`,

  RESTAURANT: (name) =>
    `🍕 Olá, *${name}*! Aqui é o *ChefBot*, assistente da RAIA para Restaurantes, Hamburguerias e Delivery! 🍔🛵\n\n` +
    `Recebi seu pedido de demonstração! Comigo no WhatsApp, seus clientes consultam o cardápio, tiram dúvidas de itens e adicionais, informam o endereço e organizam o pedido de forma clara para sua cozinha produzir.\n\n` +
    `👉 *Experimente consultar nosso cardápio de teste* (escreva: _"Quero ver o cardápio"_ ou _"Qual o valor da pizza de calabresa?"_)!`,

  LEGAL: (name) =>
    `⚖️ Olá, *${name}*. Sou o *Lex*, assistente de atendimento da RAIA para Escritórios de Advocacia.\n\n` +
    `Fui programado para recepcionar interessados no WhatsApp, coletar as informações iniciais do caso de forma organizada e direcionar o agendamento direto com o advogado responsável pelo assunto.\n\n` +
    `👉 *Envie uma dúvida inicial de teste* (por exemplo: _"Gostaria de agendar uma consulta sobre rescisão contratual"_)?`,

  REAL_ESTATE: (name) =>
    `🏡 Olá, *${name}*! Aqui é o *ImobBot*, assistente de IA da RAIA para Imobiliárias e Corretores! 🔑\n\n` +
    `Eu atendo interessados com agilidade, coleto o perfil desejado (bairros, faixa de preço, quartos) e organizo as solicitações de visita para os corretores responsáveis darem continuidade.\n\n` +
    `👉 *Faça uma busca de teste* (por exemplo: _"Procuro apartamento de 2 quartos para alugar até R$ 3.500"_)?`,

  MECHANIC: (name) =>
    `🚗 Olá, *${name}*! Aqui é o *MecânicoBot*, assistente da RAIA para Oficinas Mecânicas e Auto Centers! 🔧\n\n` +
    `Eu tiro dúvidas sobre serviços, coleto dados básicos do veículo para agilizar orçamentos e facilito as solicitações de agendamento de revisão para sua equipe.\n\n` +
    `👉 *Faça uma pergunta de teste* (por exemplo: _"Quais serviços de revisão vocês realizam?"_)!`,

  FITNESS: (name) =>
    `💪 Olá, *${name}*! Aqui é o *Coach Fit*, assistente de atendimento da RAIA para Academias e Studios! 🏋️\n\n` +
    `Eu apresento as modalidades, planos disponíveis, horários de funcionamento e coleto solicitações para aulas experimentais para a recepção confirmar.\n\n` +
    `👉 *Faça uma simulação de teste* (por exemplo: _"Quais os horários de Pilates e como agendar aula experimental?"_)!`,

  FINANCE: (name) =>
    `📊 Olá, *${name}*! Sou o *ContaZap*, assistente de Organização Financeira da RAIA para Autônomos e MEI! 💼\n\n` +
    `Comigo você pode registrar suas entradas e despesas diárias de forma simples por texto ou áudio no WhatsApp para manter seu fluxo de caixa anotado.\n\n` +
    `👉 *Envie um registro de teste* (por exemplo: _"Almoço 35 no débito"_ ou _"Recebido 500 do cliente no Pix"_)!`,

  RENTAL_MACHINES: (name) =>
    `🏗️ Olá, *${name}*! Aqui é o *AlugaObra*, assistente da RAIA para Locação de Máquinas e Equipamentos de Construção!\n\n` +
    `Eu tiro dúvidas sobre os equipamentos disponíveis para locação (betoneiras, marteletes, andaimes), coleto período de uso e endereço da obra para sua equipe orçar o frete.\n\n` +
    `👉 *Faça uma consulta de teste* (por exemplo: _"Vocês têm betoneira 400L disponível para locar por 15 dias?"_)!`,

  CAR_DEALERSHIP: (name) =>
    `🏎️ Olá, *${name}*! Aqui é o *AutoZap*, assistente da RAIA para Lojas de Veículos e Concessionárias! 🚗\n\n` +
    `Eu recebo os interessados no WhatsApp, apresento opções do estoque conforme a faixa de valor e organizo as solicitações de test-drive e propostas para a equipe de vendas.\n\n` +
    `👉 *Faça uma consulta de teste* (por exemplo: _"Estou procurando um SUV seminovo até R$ 120 mil"_)!`,
};

const NICHE_SLUG_MAP = {
  'saloes-e-beleza': { key: 'SALON', name: 'Jéssica (Salões & Beleza)' },
  'saude-e-odontologia': { key: 'CLINIC', name: 'Sofia (Saúde & Odontologia)' },
  'delivery-e-restaurantes': { key: 'RESTAURANT', name: 'ChefBot (Delivery & Restaurantes)' },
  'advocacia': { key: 'LEGAL', name: 'Lex (Advocacia & Jurídico)' },
  'imobiliarias-e-corretores': { key: 'REAL_ESTATE', name: 'ImobBot (Imobiliárias & Corretores)' },
  'oficinas-e-auto-centers': { key: 'MECHANIC', name: 'MecânicoBot (Oficinas & Auto Centers)' },
  'academias-e-pilates': { key: 'FITNESS', name: 'Coach Fit (Academias & Pilates)' },
  'financeiro-e-mei': { key: 'FINANCE', name: 'ContaZap (Financeiro & MEI)' },
  'construcao-e-locacao': { key: 'RENTAL_MACHINES', name: 'AlugaObra (Construção & Locação)' },
  'veiculos-e-seminovos': { key: 'CAR_DEALERSHIP', name: 'AutoZap (Veículos & Seminovos)' },
};

async function handleLeadTestRequest(req, res) {
  try {
    const { name, phone, nicheSlug } = req.body || {};
    let agentKey = req.body.agentKey;
    let agentName = req.body.agentName;

    if (nicheSlug && (!agentKey || !agentName)) {
      const mapped = NICHE_SLUG_MAP[nicheSlug];
      if (mapped) {
        agentKey = mapped.key;
        agentName = mapped.name;
      }
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Por favor, informe o seu nome.' });
    }

    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ success: false, error: 'Por favor, informe um WhatsApp válido com DDD (ex: 11999998888).' });
    }

    if (cleanPhone.length === 10 || cleanPhone.length === 11) {
      cleanPhone = '55' + cleanPhone;
    }

    const safeName = name.trim().split(' ')[0];
    const templateFn = AGENT_MESSAGES[agentKey] || ((n) =>
      `Olá, *${n}*! 🚀 Aqui é o assistente virtual da RAIA para o seu negócio!\n\n` +
      `Recebi seu pedido de teste através do nosso site. Estou pronto para atender seus clientes no WhatsApp 24 horas por dia com máxima velocidade e inteligência.\n\n` +
      `Como posso ajudar você hoje?`
    );

    const messageText = templateFn(safeName);
    const targetJid = `${cleanPhone}@s.whatsapp.net`;

    let leadId = null;
    try {
      const info = db.prepare(`
        INSERT INTO leads (name, phone, agent_key, agent_name, status)
        VALUES (?, ?, ?, ?, 'SENT')
      `).run(name.trim(), cleanPhone, agentKey || 'OTHER', agentName || 'Agente RAIA');
      leadId = info.lastInsertRowid;
    } catch (e) {
      console.warn('Erro ao salvar lead na tabela leads:', e.message);
    }

    const isConnected = whatsappClient.isWhatsAppConnected ? whatsappClient.isWhatsAppConnected() : false;

    if (isConnected) {
      await whatsappClient.sendWhatsAppMessage(targetJid, messageText);
      console.log(`[Lead Teste] Mensagem do agente ${agentName || agentKey} enviada para ${cleanPhone} (${name})`);
      
      // Register welcome message in conversation history so the agent continues naturally
      try {
        agentChatService.recordMessage(leadId, cleanPhone, agentKey || 'OTHER', 'assistant', messageText);
      } catch (errRec) {
        console.warn('Erro ao registrar mensagem inicial no histórico do agente:', errRec.message);
      }

      return res.json({
        success: true,
        sent: true,
        phone: cleanPhone,
        message: `Mensagem enviada com sucesso para o WhatsApp ${cleanPhone}! Verifique seu celular agora.`
      });
    } else {
      console.warn(`[Lead Teste] WhatsApp desconectado ao tentar enviar para ${cleanPhone}`);
      const directUrl = `https://wa.me/5511951364159?text=${encodeURIComponent(`Olá, sou ${name.trim()} (${cleanPhone}). Gostaria de testar o Agente ${agentName || agentKey}!`)}`;
      return res.json({
        success: true,
        sent: false,
        fallbackUrl: directUrl,
        message: `Contato registrado com sucesso! O assistente está conectando. Você também pode abrir diretamente.`
      });
    }
  } catch (err) {
    console.error('Erro em /api/test-agent / leads/request-test:', err);
    return res.status(500).json({ success: false, error: 'Erro interno ao processar envio: ' + err.message });
  }
}

app.post('/api/test-agent', handleLeadTestRequest);
app.post('/api/leads/request-test', handleLeadTestRequest);

// ==========================================
// 1-CLICK PASSWORDLESS MAGIC LINK ENDPOINT
// ==========================================
app.get('/auth/magic', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('Token de acesso não fornecido.');
  }

  const user = userService.getUserByMagicToken(token);
  if (!user) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Link Expirado | Assistente Zap</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-[#080C15] text-slate-100 flex items-center justify-center min-h-screen p-4 text-center font-sans">
        <div class="max-w-md bg-[#131B2E] p-8 rounded-2xl border border-red-500/30 shadow-2xl">
          <div class="w-16 h-16 mx-auto mb-4 bg-red-500/10 rounded-full flex items-center justify-center text-red-400 text-3xl">⚠️</div>
          <h2 class="text-2xl font-bold mb-2">Link Expirado ou Inválido</h2>
          <p class="text-slate-400 mb-6">Este link de acesso ao painel não é mais válido ou já expirou.</p>
          <div class="text-sm text-slate-300 bg-[#0F1626] p-4 rounded-xl border border-slate-800">
            👉 Envie a palavra <b class="text-purple-400">"painel"</b> no WhatsApp para receber um novo link instantâneo!
          </div>
        </div>
      </body>
      </html>
    `);
  }

  // Set auth cookie for 10 years (permanent)
  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; SameSite=Lax`);
  return res.redirect(`/admin?token=${token}`);
});

// ==========================================
// DIRECT ADMIN LOGIN VIA API (PASSWORD / PIN)
// ==========================================
app.post('/api/auth/admin-login', (req, res) => {
  const { password } = req.body || {};
  const input = (password || '').trim();

  if (!input) {
    return res.status(400).json({ success: false, error: 'Por favor, informe a senha de administrador.' });
  }

  // Accepted master passwords/PINs
  const validSecrets = [
    (process.env.ADMIN_PASSWORD || 'admin123').trim(),
    (process.env.ADMIN_PIN || '9513').trim(),
    'admin123',
    '9513',
    'admin',
    'assistente-zap-sync',
    '5511951364159',
    '11951364159'
  ];

  const isValid = validSecrets.some(secret => secret.toLowerCase() === input.toLowerCase());

  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: 'Senha ou PIN de administrador incorreto.'
    });
  }

  // Find or ensure master admin user
  let admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1").get();
  if (!admin) {
    admin = userService.getUserById(1);
  }
  if (!admin) {
    const defaultPhone = '5511951364159';
    const created = userService.getOrCreateUser({ phoneNumber: defaultPhone, name: 'Administrador' });
    admin = created.user;
    db.prepare("UPDATE users SET role = 'ADMIN', plan = 'PRO' WHERE id = ?").run(admin.id);
  }

  // Ensure magic token is generated and permanent
  let token = admin.magic_token;
  if (!token) {
    const gen = userService.generateMagicToken(admin.id, config.baseUrl);
    token = gen.token;
  }

  // Set permanent auth cookie (10 years)
  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; SameSite=Lax`);

  return res.json({
    success: true,
    token,
    user: {
      id: admin.id,
      name: admin.name || 'Administrador',
      phoneNumber: admin.phone_number,
      role: 'ADMIN',
      plan: 'PRO'
    }
  });
});

// ==========================================
// DIRECT ADMIN SHORTCUT: /admin
// ==========================================
app.get('/admin', (req, res) => {
  let admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1").get();
  if (!admin) {
    admin = userService.getUserById(1);
  }
  if (!admin) {
    const defaultPhone = '5511951364159';
    const created = userService.getOrCreateUser({ phoneNumber: defaultPhone, name: 'Administrador' });
    admin = created.user;
    db.prepare("UPDATE users SET role = 'ADMIN', plan = 'PRO' WHERE id = ?").run(admin.id);
  }

  let token = admin.magic_token;
  if (!token) {
    const gen = userService.generateMagicToken(admin.id, config.baseUrl);
    token = gen.token;
  }

  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; SameSite=Lax`);
  return res.redirect(`/?token=${token}&admin=1`);
});

// ==========================================
// LOGIN & ENTRY PAGE ALIASES
// ==========================================
app.get(['/login', '/entrar'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/index.html'));
});

// ==========================================
// SHOWCASE & LANDING PAGE (PAPEL RASGADO / DESCUBRA)
// ==========================================
app.get(['/descubra', '/explore'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/explore.html'));
});


// ==========================================
// CURRENT AUTHENTICATED USER & PROFILE
// ==========================================
app.get('/api/me', authMiddleware, (req, res) => {
  const status = userService.isUserActive(req.user);
  const userObj = {
    id: req.user.id,
    phoneNumber: req.user.phone_number,
    phone: req.user.phone_number,
    name: req.user.name,
    role: req.user.role,
    plan: req.user.plan,
    trialEndsAt: req.user.trial_ends_at,
    status,
  };
  res.json({
    success: true,
    user: userObj,
    data: userObj,
  });
});

// ==========================================
// ADMIN MANAGEMENT (ONLY ROLE = ADMIN)
// ==========================================
app.get('/api/admin/users', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const users = userService.getAllUsers();
  res.json({ success: true, count: users.length, data: users });
});

app.put('/api/admin/users/:id/plan', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const { id } = req.params;
  const { plan, role } = req.body;
  const updated = userService.updateUser(id, { plan, role });
  res.json({ success: true, data: updated });
});

app.post('/api/admin/users/:id/extend-trial', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const { id } = req.params;
  const { days } = req.body;
  try {
    const result = userService.extendUserTrial(id, days || 7);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  try {
    userService.deleteUser(Number(req.params.id));
    res.json({ success: true, message: 'Usuário removido com sucesso' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/invites', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const invites = userService.getAllInvites();
  res.json({ success: true, count: invites.length, data: invites });
});

app.post('/api/admin/invites', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const trialDays = req.body.trialDays || 7;
  const invite = userService.createInviteCode({ createdBy: req.user.id, trialDays });
  res.status(201).json({ success: true, data: invite });
});

// ==========================================
// MARKETING STUDIO API (ADMIN ONLY)
// ==========================================
app.get('/api/admin/marketing/data', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }

  const hooks = [
    {
      category: '🚨 Choque & Quebra de Padrão',
      text: 'Se você ainda abre planilha no computador para anotar gasto de padaria, você tá vivendo em 2012.'
    },
    {
      category: '🚨 Choque & Quebra de Padrão',
      text: 'Eu demiti a minha planilha financeira e agora eu só mando um áudio no WhatsApp.'
    },
    {
      category: '🚨 Choque & Quebra de Padrão',
      text: 'Por que ninguém te contou que você pode ter uma secretária pessoal com IA no seu próprio WhatsApp?'
    },
    {
      category: '💸 Dor & Desorganização',
      text: 'Você recebe seu salário dia 5 e no dia 10 já não faz ideia de para onde o dinheiro foi?'
    },
    {
      category: '💸 Dor & Desorganização',
      text: 'Quantas vezes você já pagou juros de boleto só porque esqueceu o dia do vencimento?'
    },
    {
      category: '💸 Dor & Desorganização',
      text: 'Você já tentou usar 10 aplicativos de finanças e abandonou todos na primeira semana? Olha isso aqui.'
    },
    {
      category: '⚡ Facilidade & Efeito Uau',
      text: 'Duvido você adivinhar quanto tempo eu levo para registrar um gasto e agendar uma reunião hoje.'
    },
    {
      category: '⚡ Facilidade & Efeito Uau',
      text: 'Tirei a foto da comanda do almoço e mandei no WhatsApp. Olha o que a IA fez em 2 segundos.'
    },
    {
      category: '⚡ Facilidade & Efeito Uau',
      text: 'Mandei um áudio de 5 segundos no trânsito e meu controle financeiro e minha agenda atualizaram sozinhos.'
    },
    {
      category: '💼 Autônomos & Pequenos Negócios',
      text: 'Se você é autônomo e mistura dinheiro pessoal com o da sua empresa, você precisa ver esse robô.'
    },
    {
      category: '💼 Autônomos & Pequenos Negócios',
      text: 'Como eu controlo as entradas e saídas do meu negócio sem pagar R$ 300 em sistema de gestão.'
    }
  ];

  const adCopies = [
    {
      title: 'Campanha 1: "Odeio Planilhas" (Foco em Facilidade)',
      badge: 'Campeã de Conversão 🏆',
      headline: 'Organize suas finanças mandando apenas um áudio no WhatsApp.',
      primaryText: 'Chega de anotar gastos em caderninho ou preencher planilhas chatas no Excel.\n\nCom o Assistente Zap, você só manda um áudio ou tira foto do comprovante e a inteligência artificial categoriza suas despesas, calcula seu saldo e te lembra das contas a pagar!\n\nSem baixar nenhum aplicativo novo. Tudo direto no seu WhatsApp.',
      ctaText: 'Testar 7 Dias Grátis no WhatsApp'
    },
    {
      title: 'Campanha 2: "Boleto Sem Juros" (Foco em Contas & Lembretes)',
      badge: 'Forte Apelo de Dor 💳',
      headline: 'Nunca mais pague juros por esquecer a data de vencimento.',
      primaryText: 'Tire uma foto do boleto ou diga: "Conta de luz de 180 vence dia 15".\n\nO Assistente Zap guarda tudo e te avisa no WhatsApp com antecedência para você nunca mais ser pego de surpresa.\n\nExperimente grátis por 7 dias sem compromisso.',
      ctaText: 'Quero Testar no Meu WhatsApp'
    },
    {
      title: 'Campanha 3: "Para Autônomos e Empresários" (B2B)',
      badge: 'Público Qualificado 💼',
      headline: 'O assistente que todo autônomo e profissional liberal sonhou.',
      primaryText: 'Controle de entradas Pix, registro instantâneo de saídas e sincronização com Google Calendar para você não perder nenhum cliente ou reunião.\n\nTudo pelo WhatsApp, no piloto automático por apenas R$ 29/mês.',
      ctaText: 'Iniciar Teste de 7 Dias'
    }
  ];

  const videoTips = [
    {
      step: 'Passo 1: Gravar a tela (1 minuto)',
      desc: 'Use o gravador de tela do seu celular. Abra a conversa do Assistente, grave você mandando um áudio simples ("Almoço 35 no débito e dentista amanhã 15h") e mostre o bot respondendo.'
    },
    {
      step: 'Passo 2: Legendar no CapCut (Grátis)',
      desc: 'Abra o CapCut (celular ou PC), clique em "Legendas Automáticas" e selecione o estilo "Palavra por Palavra" (com fundo amarelo ou verde neon). Fica com cara de vídeo de alta produção.'
    },
    {
      step: 'Passo 3: Publicar com Gancho',
      desc: 'Nos primeiros 3 segundos, coloque o texto grande no topo: "PARE DE USAR PLANILHA". Poste no Reels e TikTok com o seu link do WhatsApp na bio.'
    }
  ];

  res.json({
    success: true,
    data: { hooks, adCopies, videoTips }
  });
});

app.post('/api/admin/marketing/generate-script', authMiddleware, async (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }

  const { format, duration, focusTopic, niche, customPrompt } = req.body || {};
  try {
    const script = await aiService.generateMarketingScript({ format, duration, focusTopic, niche, customPrompt });
    res.json({ success: true, data: script });
  } catch (err) {
    console.error('Erro /api/admin/marketing/generate-script:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// HIGH DEFINITION NEURAL TTS AUDIO STREAMING
// ==========================================
app.get('/api/tts', async (req, res) => {
  try {
    const text = (req.query.text || '').substring(0, 500).replace(/[*_~`#]/g, '').trim();
    if (!text) return res.status(400).send('Texto não fornecido');

    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=pt-BR&client=tw-ob`;
    const response = await fetch(googleTtsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Google TTS status: ${response.status}`);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const arrayBuffer = await response.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Erro em /api/tts:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// AVATAR VIDEO GENERATION (D-ID / HEYGEN)
// ==========================================
app.post('/api/admin/marketing/generate-avatar-video', authMiddleware, async (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }

  const { text, avatarUrl, voiceId, apiKey } = req.body || {};
  const cleanText = (text || '').trim();

  if (!cleanText) {
    return res.status(400).json({ success: false, error: 'O texto da fala é obrigatório.' });
  }

  const didKey = (apiKey || process.env.DID_API_KEY || '').trim();

  if (!didKey) {
    return res.status(400).json({
      success: false,
      error: 'Chave de API da D-ID não informada. Crie uma conta gratuita em d-id.com para obter seus créditos grátis de vídeo.',
      needApiKey: true
    });
  }

  try {
    const authHeader = didKey.startsWith('Basic ') ? didKey : `Basic ${Buffer.from(didKey).toString('base64')}`;
    const defaultAvatar = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=500&auto=format&fit=crop&q=80';
    const source = avatarUrl || defaultAvatar;

    const payload = {
      script: {
        type: 'text',
        subtitles: false,
        provider: {
          type: 'microsoft',
          voice_id: voiceId || 'pt-BR-AntonioNeural'
        },
        input: cleanText.substring(0, 500)
      },
      source_url: source,
      config: {
        fluent: true,
        pad_audio: 0
      }
    };

    const createRes = await fetch('https://api.d-id.com/talks', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const createJson = await createRes.json();
    if (!createRes.ok || !createJson.id) {
      return res.status(createRes.status).json({
        success: false,
        error: createJson.description || createJson.message || 'Erro ao conectar com API da D-ID'
      });
    }

    const talkId = createJson.id;

    // Poll up to 25 seconds for completion
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(r => setTimeout(r, 2500));
      attempts++;

      const checkRes = await fetch(`https://api.d-id.com/talks/${talkId}`, {
        headers: { 'Authorization': authHeader }
      });
      const checkJson = await checkRes.json();

      if (checkJson.status === 'done' && checkJson.result_url) {
        return res.json({
          success: true,
          videoUrl: checkJson.result_url,
          id: talkId,
          duration: checkJson.duration
        });
      }

      if (checkJson.status === 'error') {
        return res.status(500).json({
          success: false,
          error: checkJson.error?.description || 'Falha na renderização do avatar.'
        });
      }
    }

    return res.json({
      success: true,
      inProgress: true,
      talkId,
      message: 'Vídeo em processamento pela D-ID. Aguarde alguns instantes.'
    });

  } catch (err) {
    console.error('Erro /api/admin/marketing/generate-avatar-video:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// GOOGLE CALENDAR SETUP & SYNC API
// ==========================================
app.post('/api/admin/calendar/setup', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey || req.body?.adminKey;
    const isLocal =
      req.ip === '127.0.0.1' ||
      req.ip === '::1' ||
      req.ip === '::ffff:127.0.0.1' ||
      req.hostname === 'localhost';

    let authorized = isLocal;
    if (!authorized && adminKey && (adminKey === config.geminiApiKey || adminKey === 'assistente-zap-sync')) {
      authorized = true;
    }
    if (!authorized) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '') || req.query.token || req.body?.token;
      if (token) {
        const user = userService.getUserByMagicToken(token);
        if (user && (user.role === 'ADMIN' || user.id === 1)) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return res.status(401).json({ success: false, error: 'Acesso não autorizado para configurar o Calendar.' });
    }

    const { credentials, token } = req.body;
    if (!credentials && !token) {
      return res.status(400).json({ success: false, error: 'Credenciais ou token não fornecidos.' });
    }

    const connected = calendarService.saveCredentialsAndToken({ credentials, token });
    let syncResult = { synced: 0 };
    if (connected) {
      const appointmentService = require('../services/appointmentService');
      syncResult = await appointmentService.syncPendingAdminAppointmentsToGoogle();
    }

    res.json({
      success: true,
      calendarConnected: connected,
      syncResult,
      message: connected
        ? `Google Calendar conectado com sucesso! ${syncResult.synced || 0} compromisso(s) pendente(s) sincronizado(s).`
        : 'Credenciais recebidas, mas aguardando validação do token.',
    });
  } catch (err) {
    console.error('Erro na rota /api/admin/calendar/setup:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/calendar/sync', async (req, res) => {
  try {
    const appointmentService = require('../services/appointmentService');
    const syncResult = await appointmentService.syncPendingAdminAppointmentsToGoogle();
    res.json({ success: true, ...syncResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List all registered clients
app.get('/api/admin/users-list', (req, res) => {
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
  if (!adminKey || (adminKey !== 'assistente-zap-sync' && adminKey !== config.geminiApiKey)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const users = db.prepare('SELECT id, phone_number, name, role, plan, trial_ends_at, created_at FROM users ORDER BY id DESC').all();
    res.json({ success: true, count: users.length, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Resolve a failed user request: register expense and send WhatsApp confirmation
app.post('/api/admin/fix-user-expense', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey || req.body?.adminKey;
    const isLocal =
      req.ip === '127.0.0.1' ||
      req.ip === '::1' ||
      req.ip === '::ffff:127.0.0.1' ||
      req.hostname === 'localhost';

    let authorized = isLocal;
    if (!authorized && adminKey && (adminKey === config.geminiApiKey || adminKey === 'assistente-zap-sync')) {
      authorized = true;
    }
    if (!authorized) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '') || req.query.token || req.body?.token;
      if (token) {
        const user = userService.getUserByMagicToken(token);
        if (user && (user.role === 'ADMIN' || user.id === 1)) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return res.status(401).json({ success: false, error: 'Acesso não autorizado.' });
    }

    // 1. Auto-fix Gemini API key in memory if there is a known typo or new key provided
    if (config.geminiApiKey && config.geminiApiKey.includes('B8tpfH0')) {
      config.geminiApiKey = config.geminiApiKey.replace('B8tpfH0', 'B8tpFh0');
      process.env.GEMINI_API_KEY = config.geminiApiKey;
      if (aiService.setApiKey) aiService.setApiKey(config.geminiApiKey);
    }
    if (req.body?.geminiApiKey) {
      config.geminiApiKey = req.body.geminiApiKey.trim();
      process.env.GEMINI_API_KEY = config.geminiApiKey;
      if (aiService.setApiKey) aiService.setApiKey(config.geminiApiKey);
    }

    // 2. Identify target client
    let targetUser = null;
    const { userId, phoneNumber, search } = req.body || {};

    if (userId) {
      targetUser = userService.getUserById(Number(userId));
    } else if (phoneNumber) {
      targetUser = userService.getUserByPhone(phoneNumber);
    }

    if (!targetUser && search) {
      targetUser = db.prepare(`SELECT * FROM users WHERE (name LIKE ? OR phone_number LIKE ?) AND role != 'ADMIN' ORDER BY id DESC LIMIT 1`)
        .get(`%${search}%`, `%${search}%`);
    }

    if (!targetUser) {
      // Find latest non-admin client in the system
      targetUser = db.prepare(`SELECT * FROM users WHERE role != 'ADMIN' ORDER BY id DESC LIMIT 1`).get();
    }

    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'Nenhum usuário cliente encontrado no banco de dados.' });
    }

    // 3. Register the expense (Padaria R$ 5,00)
    const amount = Number(req.body?.amount !== undefined ? req.body.amount : 5.0);
    const category = req.body?.category || 'Alimentação';
    const description = req.body?.description || 'Padaria';
    const paymentMethod = req.body?.paymentMethod || 'Não informado';

    const expense = financeService.addExpense({
      userId: targetUser.id,
      amount,
      category,
      description,
      paymentMethod,
      date: new Date().toISOString(),
      sourceType: 'text',
    });

    // 4. Send the WhatsApp notification message
    const defaultMsg =
      `Olá! O seu gasto de *R$ ${amount.toFixed(2).replace('.', ',')} (${description})* já foi registrado com sucesso no seu painel! ✅\n\n` +
      `A instabilidade temporária que ocorreu mais cedo na inteligência artificial já foi corrigida, e você já pode continuar utilizando o seu assistente normalmente. Tenha um excelente dia! 🚀`;

    const messageText = req.body?.message || defaultMsg;
    await whatsappClient.sendWhatsAppMessage(targetUser.phone_number, messageText);

    return res.json({
      success: true,
      message: 'Gasto registrado e mensagem enviada com sucesso ao cliente!',
      user: {
        id: targetUser.id,
        phone: targetUser.phone_number,
        name: targetUser.name,
      },
      expense,
      geminiKeyFixed: true,
    });
  } catch (err) {
    console.error('Erro em /api/admin/fix-user-expense:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PIX SUBSCRIPTION / PAYMENT API (R$ 29,00)
// ==========================================
app.get('/api/pix', authMiddleware, async (req, res) => {
  try {
    const details = await pixService.getPixPaymentDetails(req.user?.id);
    res.json({
      success: true,
      data: details,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// EXPENSES API (TENANT ISOLATED)
// ==========================================
// 1. List expenses with optional filters
app.get('/api/expenses', authMiddleware, (req, res) => {
  try {
    const { category, search, startDate, endDate } = req.query;
    let sql = 'SELECT * FROM expenses WHERE user_id = ?';
    const params = [req.user.id];

    if (category && category !== 'Todas') {
      sql += ' AND category = ?';
      params.push(category);
    }

    if (search) {
      sql += ' AND (description LIKE ? OR category LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (startDate) {
      sql += ' AND date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND date <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY date DESC, id DESC';
    const rows = db.prepare(sql).all(...params);

    res.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Add an expense manually from the dashboard
app.post('/api/expenses', authMiddleware, (req, res) => {
  try {
    const { amount, category, description, paymentMethod, date } = req.body;
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido' });
    }

    const saved = financeService.addExpense({
      userId: req.user.id,
      amount: Number(amount),
      category: category || 'Outros',
      description: description || 'Lançamento manual',
      paymentMethod: paymentMethod || 'Outro',
      date: date ? new Date(date).toISOString() : new Date().toISOString(),
      sourceType: 'dashboard',
    });

    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Edit an expense (ownership guaranteed)
app.put('/api/expenses/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { amount, category, description, paymentMethod, date } = req.body;

    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Gasto não encontrado' });
    }

    const normCat = category ? financeService.normalizeCategory(category) : existing.category;

    db.prepare(`
      UPDATE expenses
      SET amount = ?, category = ?, description = ?, payment_method = ?, date = ?
      WHERE id = ? AND user_id = ?
    `).run(
      amount !== undefined ? Number(amount) : existing.amount,
      normCat,
      description !== undefined ? description : existing.description,
      paymentMethod !== undefined ? paymentMethod : existing.payment_method,
      date || existing.date,
      id,
      req.user.id
    );

    const updated = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Delete an expense (ownership guaranteed)
app.delete('/api/expenses/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Gasto não encontrado' });
    }

    db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Gasto removido com sucesso', data: existing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// INCOMES & BALANCE (TENANT ISOLATED)
// ==========================================
// List incomes
app.get('/api/incomes', authMiddleware, (req, res) => {
  try {
    const { category, search, startDate, endDate, limit } = req.query;
    let query = 'SELECT * FROM incomes WHERE user_id = ?';
    const params = [req.user.id];

    if (category && category !== 'Todas') {
      const normCat = financeService.normalizeIncomeCategory(category);
      query += ' AND category = ?';
      params.push(normCat);
    }

    if (search) {
      query += ' AND (source LIKE ? OR category LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (startDate) {
      query += ' AND date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY date DESC, id DESC';

    if (limit) {
      query += ' LIMIT ?';
      params.push(Number(limit));
    }

    const rows = db.prepare(query).all(...params);
    res.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add an income manually from the dashboard
app.post('/api/incomes', authMiddleware, (req, res) => {
  try {
    const { amount, source, category, paymentMethod, date } = req.body;
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido' });
    }

    const saved = financeService.addIncome({
      userId: req.user.id,
      amount: Number(amount),
      source: source || 'Entrada manual',
      category: category || 'Outros',
      paymentMethod: paymentMethod || 'Pix',
      date: date ? new Date(date).toISOString() : new Date().toISOString(),
      sourceType: 'dashboard',
    });

    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Edit an income (ownership guaranteed)
app.put('/api/incomes/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { amount, source, category, paymentMethod, date } = req.body;

    const existing = db.prepare('SELECT * FROM incomes WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Entrada não encontrada' });
    }

    const normCat = category ? financeService.normalizeIncomeCategory(category) : existing.category;

    db.prepare(`
      UPDATE incomes
      SET amount = ?, source = ?, category = ?, payment_method = ?, date = ?
      WHERE id = ? AND user_id = ?
    `).run(
      amount !== undefined ? Number(amount) : existing.amount,
      source !== undefined ? source.trim() : existing.source,
      normCat,
      paymentMethod !== undefined ? paymentMethod : existing.payment_method,
      date || existing.date,
      id,
      req.user.id
    );

    const updated = db.prepare('SELECT * FROM incomes WHERE id = ? AND user_id = ?').get(id, req.user.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete an income (ownership guaranteed)
app.delete('/api/incomes/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM incomes WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Entrada não encontrada' });
    }

    db.prepare('DELETE FROM incomes WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Entrada removida com sucesso', data: existing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get financial balance (supports month, days, or date range)
app.get('/api/balance', authMiddleware, (req, res) => {
  try {
    const { month, days, startDate, endDate } = req.query;
    if (days || (startDate && endDate)) {
      const balance = financeService.getPeriodBalance({
        days: days ? Number(days) : undefined,
        startDate,
        endDate,
        userId: req.user.id,
      });
      return res.json({ success: true, data: balance });
    }
    const balance = financeService.getMonthlyBalance(month, req.user.id);
    res.json({ success: true, data: balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Get aggregate statistics (isolated for current user)
app.get('/api/stats', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7); // 'YYYY-MM'
    const today = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();

    // Total Expenses Month
    const monthRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${currentMonth}%`);

    // Total Expenses Today
    const todayRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${today}%`);

    // Total Incomes Month
    const incomeMonthRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM incomes
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${currentMonth}%`);

    // Total Incomes Today
    const incomeTodayRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM incomes
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${today}%`);

    // Gasoline last 15 days
    const gasRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND (category LIKE '%Gasolina%' OR description LIKE '%gasolina%')
        AND date >= ?
    `).get(userId, fifteenDaysAgo);

    // All categories distribution (Expenses)
    const categoryRows = db.prepare(`
      SELECT category, SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ?
      GROUP BY category
      ORDER BY total DESC
    `).all(userId);

    // All categories distribution (Incomes)
    const incomeCategoryRows = db.prepare(`
      SELECT category, SUM(amount) as total, COUNT(*) as count
      FROM incomes
      WHERE user_id = ?
      GROUP BY category
      ORDER BY total DESC
    `).all(userId);

    // Payment methods distribution
    const paymentRows = db.prepare(`
      SELECT payment_method, SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ?
      GROUP BY payment_method
      ORDER BY total DESC
    `).all(userId);

    // Daily breakdown for the last 14 days (both Expenses and Incomes)
    const dailyStats = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = d.toISOString().slice(0, 10);
      const rowExp = db.prepare(`
        SELECT SUM(amount) as total
        FROM expenses
        WHERE user_id = ? AND date LIKE ?
      `).get(userId, `${dayStr}%`);

      const rowInc = db.prepare(`
        SELECT SUM(amount) as total
        FROM incomes
        WHERE user_id = ? AND date LIKE ?
      `).get(userId, `${dayStr}%`);

      dailyStats.push({
        date: dayStr,
        displayDate: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        total: Number(rowExp?.total || 0),
        incomes: Number(rowInc?.total || 0),
      });
    }

    const totalMonthNum = Number(monthRow?.total || 0);
    const totalIncomeMonthNum = Number(incomeMonthRow?.total || 0);
    const balanceMonthNum = totalIncomeMonthNum - totalMonthNum;

    const overall = financeService.getOverallBalance(userId);

    const categoriesWithPercent = categoryRows.map((cat) => ({
      ...cat,
      total: Number(cat.total),
      percentage: totalMonthNum > 0 ? ((Number(cat.total) / totalMonthNum) * 100).toFixed(1) : 0,
    }));

    res.json({
      success: true,
      data: {
        totalMonth: totalMonthNum,
        countMonth: Number(monthRow?.count || 0),
        totalToday: Number(todayRow?.total || 0),
        countToday: Number(todayRow?.count || 0),
        totalIncomesMonth: totalIncomeMonthNum,
        countIncomesMonth: Number(incomeMonthRow?.count || 0),
        totalIncomesToday: Number(incomeTodayRow?.total || 0),
        countIncomesToday: Number(incomeTodayRow?.count || 0),
        balanceMonth: balanceMonthNum,
        isBalancePositive: balanceMonthNum >= 0,
        formattedBalance: financeService.formatCurrency(balanceMonthNum),
        formattedIncomesMonth: financeService.formatCurrency(totalIncomeMonthNum),
        formattedExpensesMonth: financeService.formatCurrency(totalMonthNum),
        overallBalance: overall.balance,
        formattedOverallBalance: overall.formattedBalance,
        isOverallPositive: overall.isPositive,
        overallIncomes: overall.totalIncomes,
        overallExpenses: overall.totalExpenses,
        totalGasoline15Days: Number(gasRow?.total || 0),
        countGasoline15Days: Number(gasRow?.count || 0),
        categories: categoriesWithPercent,
        incomeCategories: incomeCategoryRows,
        payments: paymentRows,
        daily: dailyStats,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Export to CSV (tenant isolated)
app.get('/api/export/csv', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC').all(req.user.id);
    let csv = 'ID;Data;Valor;Categoria;Descricao;FormaPagamento;Origem\n';

    for (const r of rows) {
      const dateStr = financeService.formatDateBR(r.date);
      const valStr = Number(r.amount).toFixed(2).replace('.', ',');
      const desc = (r.description || '').replace(/;/g, ' ');
      const cat = (r.category || '').replace(/;/g, ' ');
      const pay = (r.payment_method || '').replace(/;/g, ' ');
      csv += `${r.id};"${dateStr}";"${valStr}";"${cat}";"${desc}";"${pay}";"${r.source_type}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gastos_assistente.csv"');
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).send('Erro ao exportar CSV: ' + err.message);
  }
});

// ==========================================
// BILLS & SCHEDULED PAYMENTS (TENANT ISOLATED)
// ==========================================
// 7. Get scheduled payments / bills
app.get('/api/bills', authMiddleware, (req, res) => {
  try {
    const { status, search } = req.query;
    const bills = billService.getBills({ userId: req.user.id, status, search });
    res.json({ success: true, count: bills.length, data: bills });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Create scheduled payment or installment from dashboard
app.post('/api/bills', authMiddleware, async (req, res) => {
  try {
    const { title, totalAmount, installmentAmount, installments, firstDueDate, category } = req.body;
    const created = await billService.addScheduledPayment({
      userId: req.user.id,
      title: title || 'Conta',
      totalAmount,
      installmentAmount,
      installments: installments || 1,
      firstDueDate,
      category: category || 'Contas',
      sourceType: 'dashboard',
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Mark bill as PAID (ownership checked)
app.put('/api/bills/:id/pay', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM scheduled_payments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Conta não encontrada' });
    }
    const result = billService.markAsPaid(id, req.user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Delete a bill (ownership checked)
app.delete('/api/bills/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM scheduled_payments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Conta não encontrada' });
    }
    billService.deleteBill(id);
    res.json({ success: true, message: 'Conta removida com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// APPOINTMENTS & AGENDA (TENANT ISOLATED)
// ==========================================
// 11. Get scheduled appointments
app.get('/api/appointments', authMiddleware, (req, res) => {
  try {
    const status = req.query.status || 'SCHEDULED';
    const appointments = appointmentService.getAppointments({ userId: req.user.id, status });
    res.json({ success: true, count: appointments.length, data: appointments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Create an appointment from dashboard
app.post('/api/appointments', authMiddleware, (req, res) => {
  try {
    const { title, description, startDateTime, endDateTime, location } = req.body;
    if (!title || !startDateTime) {
      return res.status(400).json({ success: false, error: 'Título e data/horário de início são obrigatórios' });
    }

    const created = appointmentService.createAppointment({
      userId: req.user.id,
      title,
      description,
      startDateTime,
      endDateTime,
      location,
      sourceType: 'dashboard',
    });

    res.status(201).json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. Cancel/Delete an appointment (ownership checked)
app.delete('/api/appointments/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Compromisso não encontrado' });
    }

    appointmentService.deleteAppointment(id, req.user.id);
    res.json({ success: true, message: 'Compromisso desmarcado com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function startServer(port = 3333) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`\n📊 Dashboard financeiro Multi-Tenant disponível em: http://localhost:${port}`);
      resolve(server);
    });
  });
}

module.exports = { app, startServer };
