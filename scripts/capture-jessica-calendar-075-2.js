/**
 * RAIA AGENTES — SCRIPT DE CAPTURA VISUAL REAL DO CALENDÁRIO JÉSSICA (CMD 075.2)
 * Renderização e captura de tela em ambiente Android real (360x800 e 390x844) via CDP nativo
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

const uniqueRunId = `075_2_calendar_${Date.now()}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_calendar_${uniqueRunId}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_calendar_auth_${uniqueRunId}`);

if (!fs.existsSync(tempAuthDir)) fs.mkdirSync(tempAuthDir, { recursive: true });

process.env.DB_PATH = tempDbPath;
process.env.AUTH_DIR = tempAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.NODE_ENV = 'test';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.ADMIN_PASSWORD = 'TestPassword!Calendar_075_2';
process.env.ADMIN_API_KEY = 'admin_key_calendar_075_2';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.SESSION_SECRET = 'test_session_secret_075_2_32bytes';
process.env.MFA_ENCRYPTION_KEY = 'test_mfa_encryption_key_075_2_32';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ASAAS_API_KEY = '$aact_test_cmd075_screens';
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
const BEAUTY_DIR = path.resolve('public/images/beauty');
const TEST_PORT = 4129;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function captureScreens() {
  console.log('=== CAPTURANDO TELAS DO CALENDÁRIO NATIVO JÉSSICA (COMANDO 075.2) ===');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));

  // Provisiona Studio Aurora
  demoStudioAuroraService.ensureDemoStudioAuroraAccount();
  const auroraUser = demoStudioAuroraService.getDemoAuroraUser();
  assert.ok(auroraUser, 'Mariana Alves deve existir.');

  const sessionToken = 'aurora_calendar_session_' + Date.now();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?').run(
    sessionToken,
    expiresAt,
    auroraUser.id
  );

  const browserPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const browserBin = browserPaths.find(p => fs.existsSync(p));
  assert.ok(browserBin, 'Navegador não encontrado.');

  const debugPort = 9500 + Math.floor(Math.random() * 400);
  const targetUrl = `${BASE_URL}/cliente/painel.html#appointments`;
  const browserProc = spawn(browserBin, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--hide-scrollbars',
    '--no-sandbox',
    '--disable-gpu',
    targetUrl,
  ]);

  await sleep(1500);

  try {
    let pagesList = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      try {
        pagesList = await new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${debugPort}/json/list`, res => {
            let raw = '';
            res.on('data', chunk => (raw += chunk));
            res.on('end', () => resolve(JSON.parse(raw)));
          }).on('error', reject);
        });
        if (pagesList && pagesList.length > 0) break;
      } catch (_) {
        await sleep(500);
      }
    }
    assert.ok(pagesList, 'CDP indisponível.');

    const targetPage = pagesList.find(p => p.url.includes('painel.html') || p.type === 'page');
    assert.ok(targetPage, 'Página não encontrada.');

    const WebSocket = global.WebSocket || require('ws');
    const ws = new WebSocket(targetPage.webSocketDebuggerUrl);

    function sendCmd(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1000000);
        function onMsg(ev) {
          const raw = typeof ev.data === 'string' ? ev.data : (ev.data ? ev.data.toString() : String(ev));
          const msg = JSON.parse(raw);
          if (msg.id === id) {
            ws.removeEventListener('message', onMsg);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        }
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await new Promise(resolve => {
      if (ws.readyState === 1) return resolve();
      ws.onopen = resolve;
      ws.addEventListener('open', resolve);
    });

    await sendCmd('Network.enable');
    await sendCmd('Page.enable');

    // Injeta cookies de autenticação aceitos por clientRoutes.js
    await sendCmd('Network.setCookie', {
      name: 'client_auth_token',
      value: sessionToken,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
    });
    await sendCmd('Network.setCookie', {
      name: 'auth_token',
      value: sessionToken,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
    });

    // Função para capturar em resolução específica
    async function captureViewport(width, height, label, isMobile = true) {
      console.log(`\nCapturando em ${width}x${height} (${label})...`);
      await sendCmd('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: isMobile,
      });
      await sendCmd('Emulation.setTouchEmulationEnabled', {
        enabled: isMobile,
        maxTouchPoints: 5,
      });

      // Navega e aguarda carregamento
      await sendCmd('Page.navigate', { url: `${BASE_URL}/cliente/painel.html#appointments` });
      await sleep(2000);

      // Garante descarte da cortina de init, ativação da aba appointments e modo mês renderizado
      await sendCmd('Runtime.evaluate', {
        awaitPromise: true,
        expression: `
          (async function() {
            sessionStorage.setItem('client_session_token', '${sessionToken}');
            if (typeof revealInterface === 'function') revealInterface();
            const curtain = document.getElementById('appInitCurtain');
            if (curtain) {
              curtain.style.display = 'none';
              curtain.remove();
            }
            if (typeof switchTab === 'function') switchTab('appointments');
            if (typeof appointmentsState !== 'undefined') {
              appointmentsState.view = 'month';
              if (typeof updateViewSwitcherButtons === 'function') updateViewSwitcherButtons();
              if (typeof populateAgendaFilters === 'function') await populateAgendaFilters();
              if (typeof loadAppointments === 'function') await loadAppointments();
            }
          })()
        `,
      });
      await sleep(2000);

      const shot = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const imgBuffer = Buffer.from(shot.data, 'base64');

      const outArtifactPath = path.join(ARTIFACT_DIR, `jessica-calendar-${label}.png`);
      fs.writeFileSync(outArtifactPath, imgBuffer);
      console.log(`  -> Salvo no artifact: ${outArtifactPath}`);

      if (fs.existsSync(BEAUTY_DIR)) {
        const outBeautyPath = path.join(BEAUTY_DIR, `jessica-calendar-${label}.png`);
        fs.writeFileSync(outBeautyPath, imgBuffer);
        console.log(`  -> Salvo em beauty: ${outBeautyPath}`);
      }
    }

    // 1. Android 360x800
    await captureViewport(360, 800, 'android-360x800', true);

    // 2. Modern Mobile 390x844
    await captureViewport(390, 844, 'android-390x844', true);

    // 3. Desktop 1280x800
    await captureViewport(1280, 800, 'desktop-1280x800', false);

    console.log('\nTodas as capturas foram concluídas com sucesso!');
    ws.close();
  } finally {
    browserProc.kill();
    server.close();
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(tempAuthDir)) fs.rmSync(tempAuthDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

captureScreens().catch(err => {
  console.error('Erro na captura:', err);
  process.exit(1);
});
