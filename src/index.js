process.on('uncaughtException', (err) => {
  console.error('[Process Error] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process Error] Unhandled Rejection:', reason?.message || reason);
});

const { startWhatsAppBot } = require('./whatsapp/client');
const config = require('./config');
const calendarService = require('./services/calendarService');
const { startServer } = require('./server/app');

console.log('====================================================');
console.log('      🤖 ASSISTENTE PESSOAL DO WHATSAPP             ');
console.log('   💰 Controle Financeiro  |  📅 Google Calendar   ');
console.log('====================================================\n');

// Verification of configuration
if (!config.geminiApiKey) {
  console.warn('⚠️ AVISO: GEMINI_API_KEY não encontrada no arquivo .env!');
  console.warn('O assistente precisa da chave da API do Google Gemini para processar texto, áudios e comprovantes.\n');
} else {
  console.log('✅ Inteligência Artificial Gemini configurada.');
}

if (calendarService.isCalendarConnected()) {
  console.log('✅ Google Calendar conectado com sucesso.');
} else {
  console.log('ℹ️ Google Calendar ainda não autenticado (opcional para iniciar).');
  console.log('   Para autenticar o Calendar, execute: npm run auth-calendar\n');
}

// Start visual web dashboard
const DASHBOARD_PORT = process.env.PORT || 3333;
startServer(DASHBOARD_PORT).then(() => {
  console.log(`🌐 Acesse o painel pelo navegador: http://localhost:${DASHBOARD_PORT}\n`);
});

console.log('Iniciando conexão com WhatsApp...');
startWhatsAppBot().catch((err) => {
  console.error('Erro fatal ao iniciar bot:', err);
});
