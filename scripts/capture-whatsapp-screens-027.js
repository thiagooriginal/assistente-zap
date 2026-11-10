/**
 * RAIA AGENTES — CAPTURA DE TELAS DA CONEXÃO WHATSAPP (COMANDO 027)
 * Captura automatizada via Headless Chrome/CDP dos estados da interface:
 *  1. Tela inicial de seleção de modalidade (QR Code vs Código)
 *  2. Container do QR Code interativo com auto-refresh e instruções
 *  3. Container do Código de Pareamento com telefone e código de 8 dígitos
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const uniqueRunId = `027_screens_${Date.now()}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_screens_${uniqueRunId}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_screens_${uniqueRunId}`);

if (!fs.existsSync(tempAuthDir)) fs.mkdirSync(tempAuthDir, { recursive: true });

process.env.DB_PATH = tempDbPath;
process.env.AUTH_DIR = tempAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.BASE_URL = 'https://seguranca.raiaagentes.com.br';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ADMIN_PASSWORD = 'TestStrongAdminPassword!2026_Screens_027';
process.env.SESSION_SECRET = 'test_session_secret_027_screens';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_027_screens';
delete process.env.ALLOW_WHATSAPP_SENDING;

const db = require('../src/database/db');
const config = require('../src/config');
const clientAuth = require('../src/services/clientAuthService');
const { startServer } = require('../src/server/app');

const ARTIFACT_DIR = path.resolve('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437');
const TEST_PORT = 3995;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function captureScreens() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — CAPTURA DE TELAS DA CONEXÃO WHATSAPP (027)     ');
  console.log('================================================================\n');

  let runningServer = null;
  let browserProc = null;
  const tempProfile = path.join(os.tmpdir(), `raia_chrome_profile_${uniqueRunId}`);
  if (!fs.existsSync(tempProfile)) fs.mkdirSync(tempProfile, { recursive: true });

  try {
    // 1. Criar usuário e salão demo
    clientAuth.ensureDemoAccount();
    const demoEmail = config.demoAccountEmail;
    const demoPassword = config.demoAccountPassword;
    const loginResult = clientAuth.login(demoEmail, demoPassword);
    const sessionToken = loginResult.token;
    const demoUser = loginResult.user;

    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, b2c_reminders_enabled, whatsapp_phone)
      VALUES (?, 'Studio Jéssica Beauty Premium', 1, NULL)
    `).run(demoUser.id);

    // 2. Iniciar servidor Express em porta dedicada
    runningServer = await startServer(TEST_PORT);
    console.log(`  ✓ Servidor Express ativo em ${BASE_URL}`);

    // 3. Localizar navegador Chrome ou Edge
    const chromeCandidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    const browserPath = chromeCandidates.find(p => fs.existsSync(p));
    if (!browserPath) {
      throw new Error('Navegador Chrome ou Edge não encontrado para captura headless');
    }

    const cdpPort = 9232;
    console.log(`  ✓ Iniciando navegador headless: ${browserPath}`);
    browserProc = spawn(browserPath, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempProfile}`,
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-sandbox',
      '--window-size=1280,900',
      'about:blank',
    ]);

    await sleep(2000);

    // 4. Conectar ao WebSocket do CDP
    const list = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${cdpPort}/json/list`, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    const page = list.find(p => p.type === 'page') || list[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);

    function sendCmd(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 100000);
        function handler(msg) {
          const res = JSON.parse(msg.data);
          if (res.id === id) {
            ws.removeEventListener('message', handler);
            if (res.error) reject(res.error);
            else resolve(res.result);
          }
        }
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await new Promise(r => ws.onopen = r);

    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    // Injetar cookies de autenticação antes de navegar
    await sendCmd('Network.enable');
    await sendCmd('Network.setCookie', {
      name: 'client_auth_token',
      value: sessionToken,
      domain: '127.0.0.1',
      path: '/'
    });

    // Navegar diretamente para o painel com o hash da aba de WhatsApp
    console.log(`  Navegando para ${BASE_URL}/cliente/painel.html?modulo=jessica#integrations-whatsapp...`);
    await sendCmd('Page.navigate', {
      url: `${BASE_URL}/cliente/painel.html?modulo=jessica#integrations-whatsapp`
    });

    await sleep(3000);

    // Garantir remoção da cortina e localStorage sincronizado
    await sendCmd('Runtime.evaluate', {
      expression: `(function() {
        localStorage.setItem('raia_client_token', '${sessionToken}');
        localStorage.setItem('raia_client_user', JSON.stringify(${JSON.stringify(demoUser)}));
        const curtain = document.getElementById('appInitCurtain');
        if (curtain) curtain.remove();
        document.body.classList.remove('app-initializing');
        const main = document.querySelector('main');
        if (main) {
          main.style.opacity = '1';
          main.style.visibility = 'visible';
          main.style.pointerEvents = 'auto';
        }
        if (typeof switchTab === 'function') {
          switchTab('integrations-whatsapp');
        }
      })()`,
    });

    await sleep(1500);

    // SCREENSHOT 1: Tela de Seleção (Desconectado)
    console.log('  Capturando: painel-jessica-whatsapp-desconectado-027.png...');
    const shot1 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'painel-jessica-whatsapp-desconectado-027.png'), Buffer.from(shot1.data, 'base64'));
    console.log('  ✓ Tela 1 gravada.');

    // SCREENSHOT 2: Modalidade QR Code Ativa
    console.log('  Ativando Modalidade QR Code...');
    await sendCmd('Runtime.evaluate', {
      expression: `(function() {
        if (typeof openSalonQrConnection === 'function') openSalonQrConnection();
      })()`,
    });
    await sleep(1500);

    console.log('  Capturando: painel-jessica-whatsapp-qrcode-027.png...');
    const shot2 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'painel-jessica-whatsapp-qrcode-027.png'), Buffer.from(shot2.data, 'base64'));
    console.log('  ✓ Tela 2 gravada.');

    // SCREENSHOT 3: Modalidade Código de Pareamento Ativa
    console.log('  Ativando Modalidade Código de Pareamento...');
    await sendCmd('Runtime.evaluate', {
      expression: `(function() {
        if (typeof cancelSalonConnectMode === 'function') cancelSalonConnectMode();
        if (typeof openSalonCodeConnection === 'function') openSalonCodeConnection();
        const input = document.getElementById('waPairingPhoneInput');
        if (input) input.value = '(11) 98765-4321';
        if (typeof submitSalonPairingCode === 'function') submitSalonPairingCode();
      })()`,
    });
    await sleep(2000);

    console.log('  Capturando: painel-jessica-whatsapp-codigo-027.png...');
    const shot3 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'painel-jessica-whatsapp-codigo-027.png'), Buffer.from(shot3.data, 'base64'));
    console.log('  ✓ Tela 3 gravada.');

    ws.close();
    browserProc.kill();
    console.log('\n✓ Todas as capturas de tela foram geradas com sucesso!');
  } finally {
    if (browserProc && !browserProc.killed) {
      try { browserProc.kill(); } catch (_) {}
    }
    if (runningServer) {
      await new Promise(r => runningServer.close(r));
    }
    // Cleanup temp
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(tempAuthDir)) fs.rmSync(tempAuthDir, { recursive: true, force: true });
      if (fs.existsSync(tempProfile)) fs.rmSync(tempProfile, { recursive: true, force: true });
    } catch (_) {}
  }
}

captureScreens().catch(err => {
  console.error('Erro na captura de telas:', err);
  process.exit(1);
});
