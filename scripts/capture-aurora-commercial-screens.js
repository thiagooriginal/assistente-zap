/**
 * RAIA AGENTES — CAPTURA DE TELAS DA DEMONSTRAÇÃO COMERCIAL STUDIO AURORA (COMANDO 074)
 * Captura automatizada via Headless Chrome / Edge CDP:
 *  1. Desktop 16:9 (1920x1080) — Visão Geral & Dashboard no Modo Apresentação
 *  2. Android Padrão 360x800 — Tela Limpa (aurora-android-360x800-clean.png)
 *  3. Android Padrão 360x800 — Menu Mobile Aberto com Overlay e Botão X (aurora-android-360x800-menu.png)
 *  4. Mobile 390x844 — Tela Limpa Vertical (aurora-android-390x844-clean.png)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const uniqueRunId = `074_screens_${Date.now()}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_aurora_screens_${uniqueRunId}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_screens_${uniqueRunId}`);

if (!fs.existsSync(tempAuthDir)) fs.mkdirSync(tempAuthDir, { recursive: true });

process.env.DB_PATH = tempDbPath;
process.env.AUTH_DIR = tempAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.NODE_ENV = 'test';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.ADMIN_PASSWORD = 'TestStrongAdminPassword!2026_Aurora_074';
process.env.ADMIN_API_KEY = 'admin_key_test_automation_123';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.SESSION_SECRET = 'test_session_secret_074_screens_32bytes';
process.env.MFA_ENCRYPTION_KEY = 'test_mfa_encryption_key_32bytes_074';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ASAAS_API_KEY = '$aact_test_cmd074_screens';
process.env.HOTMART_PRODUCT_ID = '8840376';
process.env.HOTMART_OFFER_START_CODE = 'gtt3rhpk';
process.env.HOTMART_OFFER_INTERMEDIATE_CODE = '1x8ik7i3';
process.env.HOTMART_OFFER_PRO_CODE = 'ytvdj943';
process.env.HOTMART_WEBHOOK_SECRET = 'secret_webhook_test_123';
process.env.DEMO_COMMERCIAL_ENABLED = 'true';
process.env.DEMO_AURORA_EMAIL = 'mariana.aurora@raiaagentes.com.br';
process.env.DEMO_AURORA_PHONE = '5511998880000';

const db = require('../src/database/db');
const demoStudioAuroraService = require('../src/services/demoStudioAuroraService');
const { app } = require('../src/server/app');

const ARTIFACT_DIR = path.resolve('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437');
const TEST_PORT = 4124;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function captureScreens() {
  console.log('================================================================');
  console.log(' RAIA AGENTES — CAPTURA DE TELAS STUDIO AURORA BEAUTY (CMD 074) ');
  console.log('================================================================\n');

  if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  }

  // 1. Inicia servidor efêmero
  console.log(`[1/5] Iniciando servidor Express em ${BASE_URL}...`);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));

  // 2. Provisiona Studio Aurora e gera sessão válida
  console.log('[2/5] Provisionando Studio Aurora Beauty e credenciais...');
  demoStudioAuroraService.ensureDemoStudioAuroraAccount();
  const auroraUser = demoStudioAuroraService.getDemoAuroraUser();

  const sessionToken = 'aurora_session_token_' + Date.now();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?').run(sessionToken, expiresAt, auroraUser.id);
  console.log(`      Usuária: Mariana Alves (#${auroraUser.id}) | Token injetado.`);

  // 3. Localiza Chrome ou Edge
  const browserPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const browserBin = browserPaths.find(p => fs.existsSync(p));
  if (!browserBin) {
    throw new Error('Nenhum binário de navegador compatível (Chrome/Edge) encontrado.');
  }
  console.log(`[3/5] Navegador detectado: ${browserBin}`);

  const debugPort = 9334;
  const targetUrl = `${BASE_URL}/cliente/painel.html#appointments`;
  const browserProc = spawn(browserBin, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--hide-scrollbars',
    '--no-sandbox',
    '--disable-gpu',
    targetUrl,
  ]);

  await sleep(2500);

  try {
    // 4. Conecta via CDP
    console.log('[4/5] Conectando ao Chrome DevTools Protocol...');
    const pagesList = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${debugPort}/json/list`, res => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => resolve(JSON.parse(raw)));
      }).on('error', reject);
    });

    const targetPage = pagesList.find(p => p.url.includes('painel.html') || p.type === 'page');
    if (!targetPage) {
      throw new Error('Página do painel não encontrada na lista de alvos CDP.');
    }

    const WebSocket = global.WebSocket || require('ws');
    const ws = new WebSocket(targetPage.webSocketDebuggerUrl);

    function sendCmd(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1000000);
        function onMsg(ev) {
          const res = JSON.parse(ev.data);
          if (res.id === id) {
            ws.removeEventListener('message', onMsg);
            if (res.error) reject(new Error(res.error.message));
            else resolve(res.result);
          }
        }
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await new Promise(resolve => ws.onopen = resolve);

    // Injeta Cookie de Sessão da Mariana Alves
    await sendCmd('Network.enable');
    await sendCmd('Network.setCookie', {
      name: 'client_session',
      value: sessionToken,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
    });

    // Recarrega página com cookie aplicado
    await sendCmd('Page.reload');
    await sleep(3500);

    console.log('[5/5] Realizando capturas de alta definição...');

    // Captura 1: Desktop 16:9 (1920x1080)
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(1500);
    const shotDesktop = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const desktopFile = path.join(ARTIFACT_DIR, 'aurora-commercial-desktop-1080p.png');
    fs.writeFileSync(desktopFile, Buffer.from(shotDesktop.data, 'base64'));
    console.log(`      ✅ Desktop 1080p salvo: ${desktopFile}`);

    // Captura 2: Android Padrão 360 × 800 (Dashboard / Agenda limpa)
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 800,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(1500);
    const shotAndroidClean = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const androidCleanFile = path.join(ARTIFACT_DIR, 'aurora-android-360x800-clean.png');
    fs.writeFileSync(androidCleanFile, Buffer.from(shotAndroidClean.data, 'base64'));
    console.log(`      ✅ Android 360x800 Limpo salvo: ${androidCleanFile}`);

    // Captura 3: Android Padrão 360 × 800 com Menu Mobile Aberto (Overlay + Botão X)
    await sendCmd('Runtime.evaluate', {
      expression: `
        (function() {
          const btn = document.getElementById('mobileMenuBtnBeauty') || document.getElementById('mobileMenuBtn');
          if (btn) btn.click();
          else if (typeof openMobileSidebar === 'function') openMobileSidebar();
        })()
      `,
    });
    await sleep(1200);
    const shotAndroidMenu = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const androidMenuFile = path.join(ARTIFACT_DIR, 'aurora-android-360x800-menu.png');
    fs.writeFileSync(androidMenuFile, Buffer.from(shotAndroidMenu.data, 'base64'));
    console.log(`      ✅ Android 360x800 com Menu Aberto salvo: ${androidMenuFile}`);

    // Fecha o menu mobile antes da próxima captura
    await sendCmd('Runtime.evaluate', {
      expression: `
        (function() {
          const closeBtn = document.getElementById('closeSidebarBtn');
          if (closeBtn) closeBtn.click();
          else if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
        })()
      `,
    });
    await sleep(800);

    // Captura 4: Resolução 390 × 844 (Tela Limpa Vertical)
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(1500);
    const shot390Clean = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const mobile390CleanFile = path.join(ARTIFACT_DIR, 'aurora-android-390x844-clean.png');
    fs.writeFileSync(mobile390CleanFile, Buffer.from(shot390Clean.data, 'base64'));
    console.log(`      ✅ Mobile 390x844 Limpo salvo: ${mobile390CleanFile}`);

    ws.close();
    console.log('\n================================================================');
    console.log('✅ TODAS AS TELAS COMERCIAIS MOBILE FORAM CAPTURADAS COM SUCESSO 100%');
    console.log('================================================================');
  } finally {
    try { browserProc.kill(); } catch (_) {}
    try { await new Promise(r => server.close(r)); } catch (_) {}
    try {
      if (db && typeof db.close === 'function') db.close();
    } catch (_) {}
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tempDbPath + ext); } catch (_) {}
    }
    try { fs.rmSync(tempAuthDir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (require.main === module) {
  captureScreens().catch(err => {
    console.error('❌ Falha na captura de telas:', err);
    process.exit(1);
  });
}

module.exports = { captureScreens };
