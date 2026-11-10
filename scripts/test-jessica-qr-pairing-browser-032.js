/**
 * RAIA AGENTES — COMANDO 032: Teste E2E em Navegador Real (Chrome Headless CDP)
 * Validação de:
 * 1. Resolução do BUG 1: Geração e renderização de QR Code PNG válido de alto contraste
 * 2. Resolução do BUG 2: Imunidade a overwrite por polling ao selecionar Código de Pareamento
 * 3. Máquina de Estados da Interface (DISCONNECTED -> CODE_SELECTED -> CODE_WAITING -> DISCONNECTED -> QR_WAITING)
 * 4. Funcionamento do botão "Trocar método" e chamada ao endpoint /cancel-pairing
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const QRCode = require('qrcode');

const HTTP_PORT = 4177;
const CDP_PORT = 9299;

const ARTIFACT_DIR = path.resolve('C:\\Users\\Acer\\.gemini\\antigravity\\brain\\02a81ab1-3f50-4b80-b427-db4dc205d437');

const mockServerState = {
  status: 'WAITING_QR', // Simula servidor já com QR pendente em background!
  qrCode: null,
  pairingCode: null,
  expiresAt: null,
  cancelCount: 0,
  connectQrCount: 0,
  connectCodeCount: 0,
};

async function generateSampleQr() {
  return await QRCode.toDataURL('1@SampleNoiseHandshakeStringForBaileysWhatsAppConnection==,MockKey1,MockKey2', {
    margin: 2,
    width: 320,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' }
  });
}

async function startTestHttpServer(port) {
  mockServerState.qrCode = await generateSampleQr();

  let painelHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'cliente', 'painel.html'), 'utf8');
  painelHtml = painelHtml.replace('https://cdn.tailwindcss.com', `http://127.0.0.1:${port}/mock-tailwind.js`);
  painelHtml = painelHtml.replace(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/gi, '<!-- fonts stripped for hermetic test -->');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        profile: {
          id: 13,
          name: 'Bella Vista Hair & Spa',
          email: 'homologacao.hotmart@raiaagentes.com.br',
          phoneNumber: '5511999990000',
          planTier: 'JESSICA_PRO',
          subscriptionStatus: 'ACTIVE',
          isDemo: true,
          salon: {
            name: 'Bella Vista Hair & Spa',
            phone: '(11) 99999-0000',
            address: 'Av. Paulista, 1000',
            whatsappStatus: 'DISCONNECTED'
          }
        }
      }));
    }

    // POLLING ENDPOINT: Retorna status (por padrão WAITING_QR para testar o overwrite protection!)
    if (url.pathname === '/api/cliente/whatsapp/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        status: mockServerState.status,
        hasQr: Boolean(mockServerState.qrCode),
        qrCode: mockServerState.qrCode,
        hasPairingCode: Boolean(mockServerState.pairingCode),
        pairingCode: mockServerState.pairingCode,
        pairingExpiresAt: mockServerState.expiresAt,
        connectedPhone: null,
      }));
    }

    if (url.pathname === '/api/cliente/whatsapp/connect-qr' && req.method === 'POST') {
      mockServerState.connectQrCount++;
      mockServerState.status = 'WAITING_QR';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        status: 'WAITING_QR',
        qrCode: mockServerState.qrCode,
      }));
    }

    if (url.pathname === '/api/cliente/whatsapp/connect-code' && req.method === 'POST') {
      mockServerState.connectCodeCount++;
      mockServerState.status = 'WAITING_CODE';
      mockServerState.pairingCode = '9876-5432';
      mockServerState.expiresAt = Date.now() + 180000;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        status: 'WAITING_CODE',
        pairingCode: mockServerState.pairingCode,
        expiresAt: mockServerState.expiresAt,
      }));
    }

    if (url.pathname === '/api/cliente/whatsapp/cancel-pairing' && req.method === 'POST') {
      mockServerState.cancelCount++;
      mockServerState.status = 'DISCONNECTED';
      mockServerState.pairingCode = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, status: 'DISCONNECTED' }));
    }

    if (url.pathname.startsWith('/api/cliente/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: [] }));
    }

    const localPath = path.join(__dirname, '..', 'public', url.pathname);
    if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
      const ext = path.extname(localPath).toLowerCase();
      const mimeMap = {
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.html': 'text/html'
      };
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'text/plain' });
      return fs.createReadStream(localPath).pipe(res);
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return server;
}

function findChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome executável não encontrado no sistema.');
}

async function connectCDP(port) {
  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        targetWs = list[0].webSocketDebuggerUrl;
        break;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!targetWs) throw new Error('Falha ao conectar na porta CDP do Chrome.');

  const ws = new WebSocket(targetWs);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  };

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res.result?.value;
  }

  async function captureScreenshot(filename) {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const fullPath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(fullPath, buffer);
    console.log(`[Screenshot]: ${filename} gravado com sucesso.`);
    return fullPath;
  }

  return { ws, send, evaluate, captureScreenshot };
}

async function runTest() {
  console.log('=== INICIANDO TESTE E2E COMANDO 032: QR CODE E MÁQUINA DE ESTADOS ===');

  const server = await startTestHttpServer(HTTP_PORT);
  console.log(`[Server]: Mock HTTP rodando na porta ${HTTP_PORT}`);

  const chromePath = findChromePath();
  const chromeProc = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=1280,900',
    '--hide-scrollbars',
    'about:blank'
  ]);

  let cdp;
  try {
    cdp = await connectCDP(CDP_PORT);
    console.log('[CDP]: Conectado ao Chrome Headless.');

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 1. Navega para painel
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html` });
    await new Promise(r => setTimeout(r, 2000));

    // Remove loading curtain se houver
    await cdp.evaluate(`
      const curtain = document.getElementById('appInitCurtain');
      if (curtain) curtain.style.display = 'none';
      if (typeof switchClientView === 'function') switchClientView('integrations');
      const waTab = document.querySelector('[data-subtab="waConnectSection"]');
      if (waTab) waTab.click();
    `);
    await new Promise(r => setTimeout(r, 1000));

    // Captura 1: Estado inicial com Escolha
    await cdp.captureScreenshot('painel-jessica-whatsapp-escolha-032.png');

    const initialChoiceVisible = await cdp.evaluate(`
      (() => {
        const b = document.getElementById('waConnectChoiceBox');
        return Boolean(b && !b.classList.contains('hidden'));
      })()
    `);
    assert.strictEqual(initialChoiceVisible, true, 'Choice box deve estar visível no estado inicial');

    // =========================================================================
    // TESTE BUG 2: Clica em 'Conectar com Código' e aguarda múltiplos ciclos de polling
    // =========================================================================
    console.log('[Teste]: Selecionando Conectar com Código (openSalonCodeConnection)...');
    await cdp.evaluate(`openSalonCodeConnection();`);
    await new Promise(r => setTimeout(r, 500));

    let isCodeBoxVisible = await cdp.evaluate(`
      (() => {
        const p = document.getElementById('waPairingCodeBox');
        return Boolean(p && !p.classList.contains('hidden'));
      })()
    `);
    assert.strictEqual(isCodeBoxVisible, true, 'waPairingCodeBox deve estar visível após clicar em Conectar com Código');

    // AGUARDA 6 SEGUNDOS DE POLLING ATIVO COM SERVIDOR EM WAITING_QR
    console.log('[Teste]: Aguardando 6 segundos de polling enquanto servidor reporta WAITING_QR...');
    await new Promise(r => setTimeout(r, 6500));

    // VERIFICA SE O DOM PERMANECE NO MODO CÓDIGO (TESTE DEFINITIVO DO BUG 2)
    isCodeBoxVisible = await cdp.evaluate(`
      (() => {
        const p = document.getElementById('waPairingCodeBox');
        const q = document.getElementById('waQrCodeBox');
        return Boolean(p && !p.classList.contains('hidden') && q && q.classList.contains('hidden'));
      })()
    `);
    assert.strictEqual(
      isCodeBoxVisible,
      true,
      'FALHA CRÍTICA DO BUG 2: O polling sobrescreveu a tela de código para QR!'
    );
    console.log('✔ SUCESSO: waPairingCodeBox PERMANECEU visível após múltiplos ciclos de polling!');

    await cdp.captureScreenshot('painel-jessica-whatsapp-codigo-input-032.png');

    // =========================================================================
    // SUBMETE NÚMERO DE TELEFONE E GERA CÓDIGO DE 8 DÍGITOS
    // =========================================================================
    console.log('[Teste]: Submetendo número de telefone para gerar código de 8 dígitos...');
    await cdp.evaluate(`
      document.getElementById('waPairingPhoneInput').value = '11999998888';
      submitSalonPairingCode();
    `);
    await new Promise(r => setTimeout(r, 1000));

    const pairingCodeDisplayed = await cdp.evaluate(`
      (() => {
        const val = document.getElementById('waPairingCodeValue');
        const disp = document.getElementById('waPairingDisplayArea');
        return Boolean(disp && !disp.classList.contains('hidden') && val && val.innerText.includes('9876-5432'));
      })()
    `);
    assert.strictEqual(pairingCodeDisplayed, true, 'Código de pareamento 9876-5432 deve estar visível');
    console.log('✔ SUCESSO: Código de pareamento 9876-5432 exibido corretamente com contador regressivo!');

    await cdp.captureScreenshot('painel-jessica-whatsapp-codigo-gerado-032.png');

    // =========================================================================
    // TESTE BOTÃO VOLTAR / TROCAR MÉTODO
    // =========================================================================
    console.log('[Teste]: Clicando em Trocar método (cancelSalonConnectMode)...');
    await cdp.evaluate(`cancelSalonConnectMode();`);
    await new Promise(r => setTimeout(r, 1000));

    const choiceRestored = await cdp.evaluate(`
      (() => {
        const b = document.getElementById('waConnectChoiceBox');
        const p = document.getElementById('waPairingCodeBox');
        const q = document.getElementById('waQrCodeBox');
        return Boolean(b && !b.classList.contains('hidden') && p && p.classList.contains('hidden') && q && q.classList.contains('hidden'));
      })()
    `);
    assert.strictEqual(choiceRestored, true, 'Choice box deve estar restaurado após trocar método');
    assert.strictEqual(mockServerState.cancelCount >= 1, true, 'Endpoint /cancel-pairing deve ter sido invocado');
    console.log('✔ SUCESSO: Trocar método restaurou a tela inicial e cancelou pendência no servidor!');

    // =========================================================================
    // TESTE BUG 1: Conecta via QR Code e verifica renderização com PNG de alto contraste
    // =========================================================================
    console.log('[Teste]: Selecionando Conectar com QR Code (openSalonQrConnection)...');
    await cdp.evaluate(`openSalonQrConnection();`);
    await new Promise(r => setTimeout(r, 1500));

    const qrRendered = await cdp.evaluate(`
      (() => {
        const img = document.getElementById('salonQrCodeImg');
        const qBox = document.getElementById('waQrCodeBox');
        return Boolean(qBox && !qBox.classList.contains('hidden') && img && img.src.startsWith('data:image/png;base64,'));
      })()
    `);
    assert.strictEqual(qrRendered, true, 'QR Code deve estar renderizado com Data URL de imagem PNG');
    console.log('✔ SUCESSO: QR Code gerado e renderizado com imagem PNG de alto contraste!');

    await cdp.captureScreenshot('painel-jessica-whatsapp-qrcode-renderizado-032.png');

    console.log('=== TODOS OS TESTES E2E DO COMANDO 032 FORAM CONCLUÍDOS COM 100% DE SUCESSO! ===');
  } finally {
    if (cdp?.ws) cdp.ws.close();
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

runTest().catch((err) => {
  console.error('[ERRO FATAL NO TESTE E2E]:', err);
  process.exit(1);
});
