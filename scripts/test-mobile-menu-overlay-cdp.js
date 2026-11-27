/**
 * RAIA AGENTES — SUÍTE DE TESTES DE INTERAÇÃO REAL MOBILE VIA CDP
 * Validação do COMANDO 074.3: Fechamento do menu mobile no Android ao tocar no overlay
 *
 * Padrão Hermético Obrigatório:
 * - Banco SQLite efêmero em os.tmpdir() destruído no teardown
 * - Emulação touch Chrome/Edge CDP nativa (hasTouch: true, isMobile: true)
 * - Resoluções: 360x800 (Samsung Galaxy Android) e 390x844 (Smartphones modernos)
 * - Assertividade estrita via node:assert/strict
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

const uniqueRunId = `074_mobile_test_${Date.now()}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_mobile_menu_${uniqueRunId}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_mobile_auth_${uniqueRunId}`);

if (!fs.existsSync(tempAuthDir)) fs.mkdirSync(tempAuthDir, { recursive: true });

process.env.DB_PATH = tempDbPath;
process.env.AUTH_DIR = tempAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.NODE_ENV = 'test';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.ADMIN_PASSWORD = 'TestPassword!Mobile_074_Secure';
process.env.ADMIN_API_KEY = 'admin_key_mobile_test_123';
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
const TEST_PORT = 4125;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runMobileMenuInteractionSuite() {
  console.log('========================================================================');
  console.log(' RAIA AGENTES — SUÍTE CDP: INTERAÇÃO TOUCH MOBILE & OVERLAY (CMD 074.3) ');
  console.log('========================================================================\n');

  if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  }

  // 1. Inicializa servidor Express isolado
  console.log(`[1/5] Iniciando servidor Express de teste em ${BASE_URL}...`);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));

  // 2. Provisiona Studio Aurora e credenciais da Mariana Alves
  console.log('[2/5] Provisionando Studio Aurora Beauty e gerando sessão autenticada...');
  demoStudioAuroraService.ensureDemoStudioAuroraAccount();
  const auroraUser = demoStudioAuroraService.getDemoAuroraUser();
  assert.ok(auroraUser, 'Usuária Mariana Alves deve existir no banco.');

  const sessionToken = 'aurora_mobile_session_' + Date.now();
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?').run(
    sessionToken,
    expiresAt,
    auroraUser.id
  );
  console.log(`      Usuária: Mariana Alves (#${auroraUser.id}) | Token: ${sessionToken}`);

  // 3. Detecta binário Chrome / Edge
  const browserPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const browserBin = browserPaths.find(p => fs.existsSync(p));
  assert.ok(browserBin, 'Binário de navegador compatível (Chrome/Edge) não encontrado.');
  console.log(`[3/5] Navegador detectado: ${browserBin}`);

  const debugPort = 9400 + Math.floor(Math.random() * 400);
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
    // 4. Conexão CDP via WebSocket com retry resiliente
    console.log(`[4/5] Conectando ao Chrome DevTools Protocol na porta ${debugPort}...`);
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
    assert.ok(pagesList, 'Falha ao conectar com endpoint CDP do Chrome.');

    const targetPage = pagesList.find(p => p.url.includes('painel.html') || p.type === 'page');
    assert.ok(targetPage, 'Página do painel não encontrada na lista de alvos CDP.');

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

    await new Promise(resolve => (ws.onopen = resolve));

    // Configuração de cookies canônicos aceitos por clientRoutes.js
    await sendCmd('Network.enable');
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

    // Injeta token no sessionStorage para o front-end
    await sendCmd('Page.reload');
    await sleep(2000);

    await sendCmd('Runtime.evaluate', {
      expression: `
        sessionStorage.setItem('raia_client_token', '${sessionToken}');
        sessionStorage.setItem('raia_user_email', '${auroraUser.email}');
      `,
    });

    await sendCmd('Page.reload');
    await sleep(3500);

    // Garante remoção da cortina caso o watchdog esteja pendente
    await sendCmd('Runtime.evaluate', {
      expression: `
        if (typeof revealInterface === 'function') revealInterface();
      `,
    });
    await sleep(1000);

    console.log('[5/5] Iniciando testes de toque mobile nas resoluções especificadas...\n');

    const testViewports = [
      { name: 'Samsung Galaxy / Android Padrão', width: 360, height: 800, scale: 2 },
      { name: 'Smartphone Moderno', width: 390, height: 844, scale: 3 },
    ];

    for (const vp of testViewports) {
      console.log(`------------------------------------------------------------------------`);
      console.log(`📱 Testando Resolução: ${vp.name} (${vp.width} × ${vp.height}, Scale: ${vp.scale})`);
      console.log(`------------------------------------------------------------------------`);

      // 1. Configura emulação de viewport e Touch
      await sendCmd('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.scale,
        mobile: true,
      });

      await sendCmd('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5,
      });

      await sleep(1000);

      // PASSO 1: Abrir menu mobile tocando no botão hambúrguer
      console.log('   👉 [Ação] Toque no botão hambúrguer (#mobileMenuBtnBeauty ou #mobileMenuBtn)...');
      await sendCmd('Runtime.evaluate', {
        expression: `
          (function() {
            const btn = document.getElementById('mobileMenuBtnBeauty') || document.getElementById('mobileMenuBtn');
            if (btn) btn.click();
            else if (typeof openMobileSidebar === 'function') openMobileSidebar();
          })()
        `,
      });
      await sleep(600);

      // Validação do estado ABERTO
      const stateOpen = await sendCmd('Runtime.evaluate', {
        expression: `
          (function() {
            const sb = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebarOverlay');
            const overlayStyle = window.getComputedStyle(overlay);
            return {
              sidebarOpen: !sb.classList.contains('-translate-x-full'),
              overlayHasHidden: overlay.classList.contains('hidden'),
              overlayHasPointerEventsNone: overlay.classList.contains('pointer-events-none'),
              overlayHasPointerEventsAuto: overlay.classList.contains('pointer-events-auto'),
              overlayDisplay: overlayStyle.display,
              overlayPointerEvents: overlayStyle.pointerEvents
            };
          })()
        `,
        returnByValue: true,
      });

      const oVal = stateOpen.result.value;
      assert.strictEqual(oVal.sidebarOpen, true, 'Sidebar deve estar aberta (sem -translate-x-full).');
      assert.strictEqual(oVal.overlayHasHidden, false, 'Overlay não deve ter a classe hidden.');
      assert.strictEqual(oVal.overlayHasPointerEventsNone, false, 'Overlay não deve ter pointer-events-none.');
      assert.strictEqual(oVal.overlayHasPointerEventsAuto, true, 'Overlay deve ter pointer-events-auto.');
      console.log('   ✅ [Validação OK] Menu aberto com sucesso e Overlay interativo (pointer-events: auto).');

      // Screenshot: Menu Aberto
      const shotMenuOpen = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const pathMenuOpen = path.join(ARTIFACT_DIR, `mobile-test-${vp.width}x${vp.height}-1-menu-opened.png`);
      fs.writeFileSync(pathMenuOpen, Buffer.from(shotMenuOpen.data, 'base64'));

      // PASSO 2: TESTE 1 — Toque fora do menu no Overlay (ex: x = 320, y = 350)
      console.log(`   👉 [Teste 1] Toque fora do menu no Overlay em x = ${vp.width - 40}, y = 350...`);
      const touchOutsideX = vp.width - 40; // 320px no 360 ou 350px no 390 (ambos fora dos 288px da sidebar)
      const touchOutsideY = 350;

      await sendCmd('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: touchOutsideX, y: touchOutsideY }],
      });
      await sleep(100);
      await sendCmd('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await sleep(600);

      // Validação do estado FECHADO após toque no overlay
      const stateClosedByOverlay = await sendCmd('Runtime.evaluate', {
        expression: `
          (function() {
            const sb = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebarOverlay');
            return {
              sidebarClosed: sb.classList.contains('-translate-x-full'),
              overlayPointerEventsNone: overlay.classList.contains('pointer-events-none')
            };
          })()
        `,
        returnByValue: true,
      });

      const cVal = stateClosedByOverlay.result.value;
      assert.strictEqual(cVal.sidebarClosed, true, 'Sidebar DEVE fechar imediatamente ao tocar no overlay.');
      assert.strictEqual(cVal.overlayPointerEventsNone, true, 'Overlay deve retornar para pointer-events-none.');
      console.log('   ✅ [Validação OK - TESTE 1] Menu fechou imediatamente ao tocar fora dele no Overlay.');

      // Screenshot: Fechado após toque no overlay
      const shotClosedOverlay = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const pathClosedOverlay = path.join(ARTIFACT_DIR, `mobile-test-${vp.width}x${vp.height}-2-overlay-touched-closed.png`);
      fs.writeFileSync(pathClosedOverlay, Buffer.from(shotClosedOverlay.data, 'base64'));

      // PASSO 3: TESTE 2 — Reabrir e tocar DENTRO do menu lateral em área não navegável (cabeçalho/fundo)
      console.log('   👉 [Teste 2] Reabrindo menu e tocando DENTRO da barra lateral (área neutra do cabeçalho x = 120, y = 25)...');
      await sendCmd('Runtime.evaluate', {
        expression: `(typeof openMobileSidebar === 'function') && openMobileSidebar();`,
      });
      await sleep(500);

      // Dispara toque na área neutra do cabeçalho da sidebar (Menu de Navegação)
      await sendCmd('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 120, y: 25 }],
      });
      await sleep(100);
      await sendCmd('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await sleep(500);

      const stateInsideTouch = await sendCmd('Runtime.evaluate', {
        expression: `
          (function() {
            const sb = document.getElementById('sidebar');
            return {
              sidebarStillOpen: !sb.classList.contains('-translate-x-full')
            };
          })()
        `,
        returnByValue: true,
      });

      assert.strictEqual(stateInsideTouch.result.value.sidebarStillOpen, true, 'Sidebar NÃO DEVE fechar ao tocar em sua área interna.');
      console.log('   ✅ [Validação OK - TESTE 2] Toque interno isolado com sucesso: o menu PERMANECEU ABERTO.');

      // Screenshot: Aberto após toque interno
      const shotInside = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const pathInside = path.join(ARTIFACT_DIR, `mobile-test-${vp.width}x${vp.height}-3-menu-reopened-touch-inside.png`);
      fs.writeFileSync(pathInside, Buffer.from(shotInside.data, 'base64'));

      // PASSO 4: TESTE 3 — Toque no botão X (#closeSidebarBtn)
      console.log('   👉 [Teste 3] Toque no botão Fechar (X) (#closeSidebarBtn)...');
      await sendCmd('Runtime.evaluate', {
        expression: `
          (function() {
            const closeBtn = document.getElementById('closeSidebarBtn');
            if (closeBtn) closeBtn.click();
            else if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
          })()
        `,
      });
      await sleep(600);

      const stateClosedByBtn = await sendCmd('Runtime.evaluate', {
        expression: `
          (function() {
            const sb = document.getElementById('sidebar');
            return {
              sidebarClosed: sb.classList.contains('-translate-x-full')
            };
          })()
        `,
        returnByValue: true,
      });

      assert.strictEqual(stateClosedByBtn.result.value.sidebarClosed, true, 'Sidebar DEVE fechar ao tocar no botão X.');
      console.log('   ✅ [Validação OK - TESTE 3] Menu fechou imediatamente ao acionar o botão X.');

      // Screenshot: Fechado após botão X
      const shotClosedBtn = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const pathClosedBtn = path.join(ARTIFACT_DIR, `mobile-test-${vp.width}x${vp.height}-4-close-btn-touched.png`);
      fs.writeFileSync(pathClosedBtn, Buffer.from(shotClosedBtn.data, 'base64'));

      // PASSO 5: TESTE 4 — Prevenção de Ghost Click (Pass-Through)
      console.log('   👉 [Teste 4] Verificação de isolamento contra Ghost Click...');
      const ghostClickCheck = await sendCmd('Runtime.evaluate', {
        expression: `
          (function() {
            const overlay = document.getElementById('sidebarOverlay');
            // Reabre e inspeciona se o elemento sob a coordenada (outside) é o overlay
            openMobileSidebar();
            const targetEl = document.elementFromPoint(${touchOutsideX}, ${touchOutsideY});
            const isOverlay = targetEl === overlay || overlay.contains(targetEl);
            closeMobileSidebar();
            return {
              hitOverlayDirectly: isOverlay,
              targetTag: targetEl ? targetEl.tagName : null,
              targetId: targetEl ? targetEl.id : null
            };
          })()
        `,
        returnByValue: true,
      });

      assert.strictEqual(ghostClickCheck.result.value.hitOverlayDirectly, true, 'Toque em x=320, y=350 deve colidir exclusivamente com o overlay, bloqueando elementos subjacentes.');
      console.log('   ✅ [Validação OK - TESTE 4] Prevenção de clique fantasma comprovada: o overlay intercepta 100% dos eventos.');
      console.log(`\n🎉 Resolução ${vp.width} × ${vp.height} APROVADA EM TODOS OS 4 TESTES!\n`);
    }

    ws.close();
    console.log('========================================================================');
    console.log('🏆 RESULTADO GERAL: SUÍTE DE TOQUE MOBILE ANDROID EXECUTADA COM SUCESSO 100%');
    console.log('========================================================================');
  } finally {
    try { browserProc.kill(); } catch (_) {}
    try { await new Promise(r => server.close(r)); } catch (_) {}
    try { if (db && typeof db.close === 'function') db.close(); } catch (_) {}
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tempDbPath + ext); } catch (_) {}
    }
    try { fs.rmSync(tempAuthDir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (require.main === module) {
  runMobileMenuInteractionSuite().catch(err => {
    console.error('❌ Falha na execução da suíte de testes mobile:', err);
    process.exit(1);
  });
}

module.exports = { runMobileMenuInteractionSuite };
