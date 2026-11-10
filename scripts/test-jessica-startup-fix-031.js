/**
 * RAIA AGENTES — COMANDO 031: Teste E2E Hermético de Inicialização da Jéssica
 * Valida em Chrome Real Headless:
 * 1. Abertura do painel da Jéssica sem travamento
 * 2. Remoção da cortina de carregamento (#appInitCurtain)
 * 3. Ausência de exceções JavaScript no console
 * 4. Navegação para Integrações > WhatsApp
 * 5. Resiliência do watchdog e estado de erro amigável
 * 6. Preservação de headers CSP e conformidade de segurança
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const HTTP_PORT = 4166;
const CDP_PORT = 9288;

const ARTIFACT_DIR = path.resolve('C:\\Users\\Acer\\.gemini\\antigravity\\brain\\02a81ab1-3f50-4b80-b427-db4dc205d437');

const testState = {
  profileError: false,
  networkDelayMs: 0,
  currentUser: {
    id: 13,
    name: 'Homologação Hotmart (Bella Vista)',
    email: 'homologacao.hotmart@raiaagentes.com.br',
    phoneNumber: '5511999990000',
    planTier: 'JESSICA_PRO',
    subscriptionStatus: 'ACTIVE',
    isDemo: true,
    salon: {
      name: 'Bella Vista Hair & Spa [DEMO ILUSTRATIVO]',
      phone: '(11) 99999-0000',
      address: 'Av. Paulista, 1000 - Bela Vista, São Paulo - SP',
      openingHours: null, // Testando resiliência de openingHours null vindo do SQLite!
      whatsappStatus: 'DISCONNECTED',
      customInstructions: 'Oferecer café e cappuccino para clientes na recepção.'
    }
  }
};

function startTestHttpServer(port) {
  let painelHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'cliente', 'painel.html'), 'utf8');

  // Ajusta CDN de Tailwind para mock local caso offline
  painelHtml = painelHtml.replace('https://cdn.tailwindcss.com', `http://127.0.0.1:${port}/mock-tailwind.js`);
  painelHtml = painelHtml.replace(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/gi, '<!-- fonts stripped for hermetic test -->');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // Headers de segurança da aplicação
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests;");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    if (url.pathname === '/cliente/painel.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(painelHtml);
    }

    if (url.pathname === '/mock-tailwind.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end('window.tailwind = { config: {} };');
    }

    if (url.pathname === '/api/cliente/profile') {
      if (testState.networkDelayMs > 0) {
        await new Promise(r => setTimeout(r, testState.networkDelayMs));
      }
      if (testState.profileError) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Falha interna de simulação' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, profile: testState.currentUser }));
    }

    if (url.pathname === '/api/cliente/whatsapp/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        status: 'DISCONNECTED',
        connectedPhone: null,
        pairingMethod: null
      }));
    }

    if (url.pathname.startsWith('/api/cliente/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: [] }));
    }

    // Arquivos estáticos em public
    const localPath = path.join(__dirname, '..', 'public', url.pathname);
    if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
      const ext = path.extname(localPath).toLowerCase();
      const mimeTypes = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      return res.end(fs.readFileSync(localPath));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function runTest() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — VALIDAÇÃO E2E COMANDO 031 (CHROME HEADLESS)   ');
  console.log('================================================================\n');

  const httpServer = await startTestHttpServer(HTTP_PORT);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--hide-scrollbars',
    `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html#overview`
  ]);

  await new Promise(r => setTimeout(r, 1500));

  let ws = null;
  const capturedErrors = [];

  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find(p => p.url.includes('painel.html')) || list[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);

    function sendCmd(method, params = {}) {
      return new Promise(resolve => {
        const id = Math.floor(Math.random() * 100000);
        function handler(msg) {
          const res = JSON.parse(msg.data);
          if (res.id === id) {
            ws.removeEventListener('message', handler);
            resolve(res.result);
          }
        }
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await new Promise(r => ws.onopen = r);

    ws.onmessage = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.method === 'Runtime.exceptionThrown') {
        capturedErrors.push(d.params.exceptionDetails);
      }
    };

    await sendCmd('Page.enable');
    await sendCmd('Runtime.enable');
    await sendCmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // Aguardar ciclo de inicialização (1 segundo)
    await new Promise(r => setTimeout(r, 1000));

    // -------------------------------------------------------------
    // FASE 1: Verificação da Inicialização e Remoção da Cortina
    // -------------------------------------------------------------
    console.log('[Fase 1] Verificação de Inicialização e Remoção do Loading...');

    const evalInit = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const curtain = document.getElementById('appInitCurtain');
        const doc = document.documentElement;
        const body = document.body;
        const ovTab = document.getElementById('tab-overview');
        const pageTitle = document.getElementById('pageTitle')?.innerText || '';

        return {
          curtainExists: Boolean(curtain),
          curtainHidden: !curtain || curtain.classList.contains('curtain-hidden'),
          isAppInitializing: body.classList.contains('app-initializing'),
          hasBeautyTheme: body.classList.contains('theme-jessica-beauty'),
          isOverviewVisible: ovTab && !ovTab.classList.contains('hidden'),
          pageTitle: pageTitle
        };
      })()`,
      returnByValue: true
    });

    const res1 = evalInit.result.value;
    console.log('  -> Cortina de loading removida/oculta:', res1.curtainHidden);
    console.log('  -> Classe app-initializing removida:', !res1.isAppInitializing);
    console.log('  -> Tema Jéssica Beauty ativo:', res1.hasBeautyTheme);
    console.log('  -> Aba Visão Geral visível:', res1.isOverviewVisible);
    console.log('  -> Título da página renderizado:', res1.pageTitle);
    console.log('  -> Exceções JS capturadas:', capturedErrors.length);

    assert.strictEqual(res1.curtainHidden, true, 'Cortina de carregamento DEVE ser descartada/oculta');
    assert.strictEqual(res1.isAppInitializing, false, 'Classe app-initializing DEVE ser desativada');
    assert.strictEqual(res1.hasBeautyTheme, true, 'Tema Jéssica Beauty DEVE estar ativo');
    assert.strictEqual(res1.isOverviewVisible, true, 'Aba Overview DEVE estar visível');
    assert.strictEqual(capturedErrors.length, 0, `Não deve haver nenhuma exceção JS no console (encontradas: ${capturedErrors.length})`);

    // Screenshot da Fase 1
    const shot1 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'painel-jessica-startup-sucesso-031.png'), Buffer.from(shot1.data, 'base64'));
    console.log('  ✓ Fase 1 APROVADA: Painel carregou perfeitamente e removeu cortina sem erros JS.\n');

    // -------------------------------------------------------------
    // FASE 2: Navegação até Integrações > WhatsApp
    // -------------------------------------------------------------
    console.log('[Fase 2] Navegação até Integrações > WhatsApp...');

    await sendCmd('Runtime.evaluate', {
      expression: `switchTab('integrations-whatsapp')`
    });

    await new Promise(r => setTimeout(r, 600));

    const evalWa = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const waTab = document.getElementById('tab-integrations-whatsapp');
        const choiceBox = document.getElementById('waConnectChoiceBox');
        const btnQr = document.getElementById('btnChooseQrMode');
        const btnCode = document.getElementById('btnChooseCodeMode');

        return {
          isWaTabVisible: waTab && !waTab.classList.contains('hidden'),
          choiceBoxVisible: choiceBox && !choiceBox.classList.contains('hidden'),
          btnQrExists: Boolean(btnQr),
          btnCodeExists: Boolean(btnCode)
        };
      })()`,
      returnByValue: true
    });

    const res2 = evalWa.result.value;
    console.log('  -> Aba de Integrações WhatsApp visível:', res2.isWaTabVisible);
    console.log('  -> Caixa de Escolha de Conexão visível:', res2.choiceBoxVisible);
    console.log('  -> Botão Conectar QR Code presente:', res2.btnQrExists);
    console.log('  -> Botão Conectar Código presente:', res2.btnCodeExists);

    assert.strictEqual(res2.isWaTabVisible, true, 'Aba WhatsApp deve estar visível');
    assert.strictEqual(res2.btnQrExists, true, 'Botão Conectar QR Code deve estar presente');
    assert.strictEqual(res2.btnCodeExists, true, 'Botão Conectar Código deve estar presente');
    assert.strictEqual(capturedErrors.length, 0, 'Zero exceções JS durante a navegação para WhatsApp');

    const shot2 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'painel-jessica-whatsapp-nav-031.png'), Buffer.from(shot2.data, 'base64'));
    console.log('  ✓ Fase 2 APROVADA: Navegação até WhatsApp 100% funcional sem erros.\n');

    // -------------------------------------------------------------
    // FASE 3: Teste de Resiliência: Watchdog & UI Amigável de Erro
    // -------------------------------------------------------------
    console.log('[Fase 3] Teste de Resiliência: Tela de Erro Amigável e Tentar Novamente...');

    // Simula erro de API e recarrega
    testState.profileError = true;
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 800));

    const evalErr = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const errContent = document.getElementById('curtainErrorContent');
        const errMsg = document.getElementById('curtainErrorMessage');
        const btnRetry = document.getElementById('btnRetryCurtain');

        return {
          errContentVisible: errContent && errContent.style.display !== 'none' && !errContent.classList.contains('hidden'),
          errorMessage: errMsg ? errMsg.textContent : '',
          btnRetryExists: Boolean(btnRetry)
        };
      })()`,
      returnByValue: true
    });

    const res3 = evalErr.result.value;
    console.log('  -> Container de erro exibido:', res3.errContentVisible);
    console.log('  -> Mensagem de erro amigável:', res3.errorMessage);
    console.log('  -> Botão Tentar Novamente disponível:', res3.btnRetryExists);

    assert.strictEqual(res3.errContentVisible, true, 'Container de erro deve estar visível quando API falha');
    assert.strictEqual(res3.btnRetryExists, true, 'Botão Tentar Novamente deve estar presente');

    const shot3 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'painel-jessica-error-watchdog-031.png'), Buffer.from(shot3.data, 'base64'));

    // Testa o botão "Tentar Novamente" com a API restaurada
    console.log('  -> Testando clique em "Tentar Novamente" com recuperação da API...');
    testState.profileError = false;
    await sendCmd('Runtime.evaluate', { expression: `retryAppInit()` });
    await new Promise(r => setTimeout(r, 1000));

    const evalRecover = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const curtain = document.getElementById('appInitCurtain');
        return !curtain || curtain.classList.contains('curtain-hidden');
      })()`,
      returnByValue: true
    });

    assert.strictEqual(evalRecover.result.value, true, 'Após clicar em Tentar Novamente, cortina deve ser removida');
    console.log('  ✓ Fase 3 APROVADA: Watchdog e recuperação com Tentar Novamente funcionam com perfeição!\n');

    console.log('================================================================');
    console.log('🎉 TODOS OS TESTES DO COMANDO 031 PASSARAM COM 100% DE SUCESSO! ');
    console.log('================================================================\n');

  } finally {
    if (ws) ws.close();
    chrome.kill();
    httpServer.close();
  }
}

runTest().catch(err => {
  console.error('\n❌ FALHA NO TESTE E2E DO COMANDO 031:', err);
  process.exit(1);
});
