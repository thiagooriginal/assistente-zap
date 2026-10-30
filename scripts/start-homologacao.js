const { spawn } = require('child_process');
const path = require('path');
const { startServer } = require('../src/server/app');
const clientAuth = require('../src/services/clientAuthService');
const config = require('../src/config');

async function launchHomologation() {
  console.log('====================================================');
  console.log('   RAIA AGENTES — INICIANDO AMBIENTE DE HOMOLOGAÇÃO');
  console.log('====================================================\n');

  // 1. Ensure Demo Account
  clientAuth.ensureDemoAccount();

  // 2. Start Express on 3333
  const PORT = process.env.PORT || 3333;
  await startServer(PORT);
  console.log(`[1/2] Servidor Express ativo localmente em http://localhost:${PORT}`);

  // 3. Start cloudflared tunnel
  console.log(`[2/2] Estabelecendo túnel HTTPS público via Cloudflare...`);
  const tunnelExe = path.resolve(__dirname, '..', 'cloudflared.exe');
  const cloudflared = spawn(tunnelExe, ['tunnel', '--url', `http://localhost:${PORT}`]);

  let announced = false;

  const onData = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !announced) {
      announced = true;
      const publicUrl = match[0];
      const fs = require('fs');
      try {
        fs.writeFileSync(path.resolve(__dirname, '..', 'data', 'homologation_url.txt'), publicUrl, 'utf8');
      } catch (e) {}

      console.log('\n====================================================');
      console.log('🌐 AMBIENTE DE HOMOLOGAÇÃO PUBLICADO COM SUCESSO!');
      console.log('====================================================');
      console.log(`\n🔗 URL Base de Homologação:\n   ${publicUrl}`);
      console.log(`\n🎯 Webhook Hotmart 2.0 (Endpoint HTTPS):\n   ${publicUrl}/api/webhooks/hotmart`);
      console.log(`\n💻 Área do Cliente (Login):\n   ${publicUrl}/cliente/login`);
      console.log(`\n🔑 Credenciais da Conta Demonstrativa Homologação Hotmart:`);
      console.log(`   E-mail: ${config.demoAccountEmail}`);
      console.log(`   Senha:  ${config.demoAccountPassword}`);
      console.log('\n====================================================\n');
    }
  };

  cloudflared.stderr.on('data', onData);
  cloudflared.stdout.on('data', onData);

  cloudflared.on('error', (err) => {
    console.error('Erro ao iniciar túnel Cloudflare:', err.message);
  });

  process.on('SIGINT', () => {
    cloudflared.kill();
    process.exit(0);
  });
}

launchHomologation();
