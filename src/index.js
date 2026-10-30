process.on('uncaughtException', (err) => {
  console.error('[Process Error] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process Error] Unhandled Rejection:', reason?.message || reason);
});

const config = require('./config');
const calendarService = require('./services/calendarService');
const { startServer } = require('./server/app');
const clientAuth = require('./services/clientAuthService');

const isStagingMode =
  process.env.APP_MODE === 'homologacao' ||
  process.env.APP_MODE === 'staging' ||
  process.env.HOMOLOGACAO === 'true' ||
  process.env.DISABLE_WHATSAPP === 'true' ||
  process.env.DISABLE_WHATSAPP_BOT === 'true';

if (isStagingMode) {
  console.log('====================================================');
  console.log('   🌐 RAIA AGENTES — MODO HOMOLOGAÇÃO / STAGING WEB  ');
  console.log('   (WhatsApp, Agentes e Sincronizações Desativados) ');
  console.log('====================================================\n');
} else {
  console.log('====================================================');
  console.log('      🤖 ASSISTENTE PESSOAL DO WHATSAPP             ');
  console.log('   💰 Controle Financeiro  |  📅 Google Calendar   ');
  console.log('====================================================\n');
}

// Verification of configuration
if (!config.geminiApiKey) {
  console.warn('⚠️ AVISO: GEMINI_API_KEY não encontrada no arquivo .env!');
  console.warn('O assistente precisa da chave da API do Google Gemini para processar texto, áudios e comprovantes.\n');
} else {
  console.log('✅ Inteligência Artificial Gemini configurada.');
}

// Calendar Sync: only active in standard/production mode
if (isStagingMode) {
  console.log('ℹ️ [Homologação] Sincronização com Google Calendar desativada para preservar dados reais.');
} else if (calendarService.isCalendarConnected()) {
  console.log('✅ Google Calendar conectado com sucesso.');
  const appointmentService = require('./services/appointmentService');
  appointmentService.syncPendingAdminAppointmentsToGoogle()
    .then((r) => {
      if (r && r.synced > 0) {
        console.log(`[Google Calendar Sync] ${r.synced} compromisso(s) sincronizado(s) na inicialização.`);
      }
    })
    .catch((err) => console.error('[Google Calendar Sync] Erro:', err.message));
} else {
  console.log('ℹ️ Google Calendar ainda não autenticado (opcional para iniciar).');
  console.log('   Para autenticar o Calendar, execute: npm run auth-calendar ou defina as variáveis no Easypanel.\n');
}

// Ensure demo account exists
try {
  clientAuth.ensureDemoAccount();
} catch (e) {}

// Start visual web dashboard
const DASHBOARD_PORT = process.env.PORT || 3333;
startServer(DASHBOARD_PORT).then(() => {
  console.log(`🌐 Acesse o painel pelo navegador: http://localhost:${DASHBOARD_PORT}\n`);
});

// WhatsApp Bot: strictly skipped in staging/homologation mode
if (isStagingMode) {
  console.log('ℹ️ [Homologação] Bot WhatsApp e agentes operacionais desativados com sucesso.');
  console.log('🚀 Aplicação web operando de forma isolada e pronta para receber requisições.\n');
} else {
  console.log('Iniciando conexão com WhatsApp...');
  const { startWhatsAppBot } = require('./whatsapp/client');
  startWhatsAppBot().catch((err) => {
    console.error('Erro fatal ao iniciar bot:', err);
  });
}
