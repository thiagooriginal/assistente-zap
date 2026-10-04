const http = require('http');
const url = require('url');
const fs = require('fs');
const { google } = require('googleapis');
const config = require('../config');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

async function authenticate() {
  if (!fs.existsSync(config.googleCredentialsPath)) {
    console.error(`\n❌ Arquivo de credenciais não encontrado em: ${config.googleCredentialsPath}`);
    console.log(`\n📋 Como obter o arquivo google_credentials.json:
1. Acesse https://console.cloud.google.com/
2. Crie um projeto ou selecione um existente.
3. Ative a "Google Calendar API" na biblioteca de APIs.
4. Em "Credenciais", clique em "Criar Credenciais" > "ID do cliente OAuth".
5. Escolha tipo "Aplicativo da Web" ou "Aplicativo para Computador" (Desktop).
   - Se for Aplicativo da Web, adicione URI de redirecionamento autorizada: http://localhost:3000/oauth2callback
6. Baixe o JSON e salve na raiz do projeto com o nome: google_credentials.json
7. Execute este script novamente: npm run auth-calendar\n`);
    return;
  }

  const credentials = JSON.parse(fs.readFileSync(config.googleCredentialsPath, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

  const redirectUri = 'http://localhost:3000';
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n=========================================');
  console.log('🔗 AUTENTICAÇÃO COM GOOGLE CALENDAR');
  console.log('=========================================');
  console.log('\nAbra o link abaixo no seu navegador para autorizar o acesso à sua agenda:');
  console.log(`\n👉 ${authUrl}\n`);

  // Start local server to receive the callback automatically
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new url.URL(req.url, 'http://localhost:3000');
      const code = parsedUrl.searchParams.get('code');

      if (code) {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        fs.writeFileSync(config.googleTokenPath, JSON.stringify(tokens, null, 2));

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
            <h1 style="color: #2e7d32;">✅ Google Calendar conectado com sucesso!</h1>
            <p>Você pode fechar esta aba e voltar para o seu assistente.</p>
          </div>
        `);

        console.log('\n✅ Token obtido e salvo com sucesso em google_token.json!');
        console.log('O assistente agora tem acesso total à sua agenda do Google Calendar.\n');
        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 1000);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erro ao processar autenticação: ' + err.message);
      console.error('Erro na autenticação:', err);
    }
  });

  server.listen(3000, () => {
    console.log('Aguardando autorização no navegador na porta 3000...');
  });
}

authenticate();
