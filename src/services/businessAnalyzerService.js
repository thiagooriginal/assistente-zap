const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const db = require('../database/db');

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

/**
 * Scrapes readable text from a URL if accessible
 */
async function fetchPageText(url) {
  if (!url || !url.startsWith('http')) return '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return '';
    const html = await res.text();
    // Clean HTML to rough text
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 15000);
  } catch (err) {
    console.warn(`[BusinessAnalyzer] Não foi possível fazer scrape direto de ${url}: ${err.message}`);
    return '';
  }
}

/**
 * Deep business and offer analysis (Wiser-style) using Gemini
 */
async function analyzeBusiness({ url = '', description = '', niche = '', companyName = '' }) {
  const client = getGenAI();
  
  let scrapedContent = '';
  if (url) {
    scrapedContent = await fetchPageText(url);
  }

  const prompt = `Você é um Consultor Estratégico de Negócios e Arquiteto de IA da RAIA RH.
Sua missão é realizar uma análise mercadológica profunda (estilo Wiser e agências de alta performance) para estruturar o atendimento e as campanhas desta empresa.

DADOS DA EMPRESA:
- Nome da Empresa: ${companyName || 'Não informado (identifique pelo contexto)'}
- Nicho / Segmento: ${niche || 'Geral'}
- URL do Site / Landing Page: ${url || 'Não informada'}
- Descrição informada: ${description || 'Nenhuma'}
${scrapedContent ? `\nCONTEÚDO EXTRAÍDO DA PÁGINA WEB:\n"${scrapedContent.slice(0, 8000)}"` : ''}

REQUISITOS DA ANÁLISE:
Gere uma análise completa, precisa e altamente prática, estruturada estritamente no seguinte formato JSON:

{
  "companyName": "Nome identificado ou confirmado da empresa",
  "tagline": "Frase de posicionamento de alto impacto (proposta única de valor)",
  "summary": "Resumo executivo em 2 parágrafos sobre o que a empresa faz, como monetiza e seu diferencial competitivo",
  "targetAudience": {
    "avatar": "Perfil demográfico e comportamental do cliente ideal",
    "primaryPain": "Principal dor ou problema urgente que faz o cliente procurar essa empresa",
    "coreDesire": "O resultado final ou transformação que o cliente busca",
    "buyingTriggers": ["Gatilho 1", "Gatilho 2", "Gatilho 3"]
  },
  "coreServices": [
    { "name": "Serviço ou Produto 1", "description": "Breve explicação", "estimatedValue": "R$..." },
    { "name": "Serviço ou Produto 2", "description": "Breve explicação", "estimatedValue": "R$..." }
  ],
  "objectionsAndAnswers": [
    { "objection": "Objeção comum (ex: Preço, confiança, prazo)", "answer": "Argumento persuasivo e acolhedor para a IA usar no WhatsApp" },
    { "objection": "Objeção comum 2", "answer": "Resposta recomendada" },
    { "objection": "Objeção comum 3", "answer": "Resposta recomendada" }
  ],
  "adAngles": [
    { "headline": "Título chamativo para Google/Meta Ads", "angle": "Ângulo de dor/desejo explorado" },
    { "headline": "Título chamativo 2", "angle": "Ângulo explorado" },
    { "headline": "Título chamativo 3", "angle": "Ângulo explorado" }
  ],
  "recommendedAgent": {
    "name": "Nome sugerido para o assistente da empresa",
    "tone": "Tom de voz recomendado (ex: empático, ágil, consultivo)",
    "rules": [
      "Regra 1 de atendimento",
      "Regra 2 de agendamento/venda",
      "Regra 3 de encaminhamento para atendente humano"
    ]
  },
  "customWhatsAppPrompt": "Instrução de sistema completa pronta para ser aplicada no robô de WhatsApp desta empresa, com saudação, qualificação e direcionamento comercial."
}`;

  const modelsToTry = [
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-flash-latest'
  ];

  let lastError = null;
  for (const modelName of modelsToTry) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.4,
        },
      });

      const res = await model.generateContent(prompt);
      const text = res.response.text();
      const parsed = JSON.parse(text);

      // Save to database
      const finalName = parsed.companyName || companyName || 'Empresa Analisada';
      const insertInfo = db.prepare(`
        INSERT INTO business_analyses (company_name, url, niche, analysis_data)
        VALUES (?, ?, ?, ?)
      `).run(finalName, url, niche || parsed.niche || 'GERAL', JSON.stringify(parsed));

      return {
        id: insertInfo.lastInsertRowid,
        success: true,
        data: parsed,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[BusinessAnalyzer] Falha com modelo ${modelName}: ${err.message}`);
    }
  }

  throw new Error(`Não foi possível concluir a análise de IA: ${lastError?.message}`);
}

function listAnalyses(limit = 30) {
  try {
    return db.prepare(`
      SELECT id, company_name, url, niche, created_at, analysis_data
      FROM business_analyses
      ORDER BY id DESC
      LIMIT ?
    `).all(limit).map(row => {
      try {
        row.data = JSON.parse(row.analysis_data);
      } catch (e) {
        row.data = null;
      }
      delete row.analysis_data;
      return row;
    });
  } catch (err) {
    console.error('Erro ao listar análises:', err);
    return [];
  }
}

function deleteAnalysis(id) {
  try {
    db.prepare('DELETE FROM business_analyses WHERE id = ?').run(id);
    return true;
  } catch (err) {
    console.error('Erro ao deletar análise:', err);
    return false;
  }
}

module.exports = {
  analyzeBusiness,
  listAnalyses,
  deleteAnalysis,
};
