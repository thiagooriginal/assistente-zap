const fs = require('fs');
const path = require('path');
const config = require('../config');

async function pushCredentials() {
  const credsPath = path.resolve(__dirname, '../../google_credentials.json');
  const tokenPath = path.resolve(__dirname, '../../google_token.json');

  if (!fs.existsSync(credsPath) || !fs.existsSync(tokenPath)) {
    console.error('❌ Arquivos google_credentials.json ou google_token.json não encontrados localmente.');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  const targetUrl = `${config.baseUrl.replace(/\/+$/, '')}/api/admin/calendar/setup`;
  console.log(`📡 Enviando credenciais do Google Calendar para: ${targetUrl}...`);

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': config.geminiApiKey || 'assistente-zap-sync',
      },
      body: JSON.stringify({ credentials, token }),
    });

    const data = await res.json();
    console.log('✅ Resposta do Servidor:', data);

    if (data.success && data.calendarConnected) {
      console.log(`🎉 Google Calendar CONECTADO com sucesso no servidor!`);
      if (data.syncResult && data.syncResult.synced > 0) {
        console.log(`📅 ${data.syncResult.synced} compromisso(s) retroativo(s) sincronizado(s) no seu Google Calendar!`);
      }
    } else {
      console.warn('⚠️ O servidor recebeu os dados mas reportou status:', data);
    }
  } catch (err) {
    console.error('❌ Erro na requisição:', err.message);
  }
}

pushCredentials();
