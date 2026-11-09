/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADA: TRANSIÇÕES DE TEMAS (COMANDO 007)
 * 
 * Validação rigorosa:
 * - Teste 1: F5 na Agenda Jéssica (#appointments) -> getComputedStyle() confirma #F7EFE7 (247, 239, 231).
 *            Classes pre-jessica e app-initializing removidas do <html> e <body> após revealInterface().
 * - Teste 2: Transição Jéssica -> HUB Central (switchTab('my-products')) sem recarregar a página.
 *            getComputedStyle() confirma #07080c (7, 8, 12).
 *            Classes theme-raia, bg-[#07080c], text-slate-100 aplicadas; theme-jessica-beauty removido.
 * - Teste 3: Transição HUB -> Jéssica (switchTab('appointments')) sem recarregar a página.
 *            getComputedStyle() retorna a #F7EFE7 (247, 239, 231).
 * - Teste 4: Ciclo contínuo de alternâncias sucessivas (Jéssica <-> HUB) sem recarregar.
 *            Validando estabilidade cromática e de layout a cada passo.
 * - Teste 5: Navegação por histórico (popstate / back / forward) entre Hub e Jéssica sem recarregar.
 * - Teste 6: Precedência canônica estrita: URL contendo query ?modulo=jessica e hash #my-products
 *            DEVE renderizar o HUB Central escuro (#07080c), respeitando o hash como fonte de verdade.
 * - Teste 7: Limpeza de query params sensíveis (?google_connected=true&email=...) preservando o hash ativo.
 * - Teste 8: F5 direto no HUB Central (#my-products) e transição subsequente para Jéssica.
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const ARTIFACT_DIR = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\02a81ab1-3f50-4b80-b427-db4dc205d437';

const testState = {
  authStatus: 200,
  networkDelayMs: 0,
  currentUser: {
    id: 101,
    name: 'Jéssica Teste Premium',
    email: 'jessica@salao.com.br',
    planTier: 'JESSICA_PRO',
    salon: { name: 'Jéssica Beauty & Nails' }
  }
};

function startTestHttpServer(port) {
  const painelHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'cliente', 'painel.html'), 'utf8');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === '/cliente/painel.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(painelHtml);
    }

    if (url.pathname === '/cliente/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html><body><h1>Login RAIA</h1></body></html>');
    }

    if (url.pathname === '/api/cliente/profile') {
      if (testState.networkDelayMs > 0) {
        await new Promise(r => setTimeout(r, testState.networkDelayMs));
      }
      if (testState.authStatus === 401 || testState.authStatus === 403) {
        res.writeHead(testState.authStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, profile: testState.currentUser }));
    }

    if (url.pathname === '/api/cliente/auth/logout') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    }

    if (url.pathname.startsWith('/api/cliente/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: [] }));
    }

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

async function runTransitionsValidation() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — VALIDAÇÃO DE TRANSIÇÕES DE TEMAS & ANTI-FLASH  ');
  console.log('================================================================\n');

  const HTTP_PORT = 4166;
  const CDP_PORT = 9277;
  const httpServer = await startTestHttpServer(HTTP_PORT);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--hide-scrollbars',
    `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html#appointments`
  ]);

  await new Promise(r => setTimeout(r, 1500));

  let ws = null;

  try {
    const listRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    const page = listRes.find(p => p.type === 'page' && p.url.includes('painel.html')) || listRes[0];
    if (!page || !page.webSocketDebuggerUrl) {
      throw new Error('Não foi possível conectar ao DevTools do Chrome headless');
    }

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

    await sendCmd('Page.enable');
    await sendCmd('Runtime.enable');
    await sendCmd('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });

    // Helper para extrair estilos computados e classes completas
    async function getThemeState() {
      const evalRes = await sendCmd('Runtime.evaluate', {
        expression: `(() => {
          const doc = document.documentElement;
          const body = document.body;
          const cs = window.getComputedStyle(body);
          const curtain = document.getElementById('appInitCurtain');
          return {
            hash: window.location.hash,
            search: window.location.search,
            url: window.location.href,
            htmlClasses: Array.from(doc.classList),
            bodyClasses: Array.from(body.classList),
            computedBg: cs.backgroundColor,
            computedColor: cs.color,
            curtainPresent: !!curtain,
            curtainHidden: curtain ? curtain.classList.contains('curtain-hidden') : true,
            isAppointmentsVisible: !document.getElementById('tab-appointments').classList.contains('hidden'),
            isMyProductsVisible: !document.getElementById('tab-my-products').classList.contains('hidden')
          };
        })()`,
        returnByValue: true
      });
      if (!evalRes || !evalRes.result || !evalRes.result.value) {
        console.error('DEBUG evalRes is:', JSON.stringify(evalRes, null, 2));
      }
      return evalRes.result.value;
    }

    // =========================================================
    // TESTE 1: F5 NA AGENDA JÉSSICA (#appointments)
    // =========================================================
    console.log('[Teste 1] F5 na Agenda Jéssica (#appointments)...');
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    const s1 = await getThemeState();
    console.log('  -> Hash:', s1.hash);
    console.log('  -> Cor de fundo computada no body:', s1.computedBg);
    console.log('  -> Cor do texto computada no body:', s1.computedColor);
    console.log('  -> HTML classes:', s1.htmlClasses.join(' '));
    console.log('  -> Body classes:', s1.bodyClasses.join(' '));

    assert.strictEqual(s1.hash, '#appointments', 'Hash deve ser #appointments');
    assert.strictEqual(s1.computedBg, 'rgb(247, 239, 231)', 'Fundo deve ser champagne #F7EFE7');
    assert.strictEqual(s1.computedColor, 'rgb(78, 59, 49)', 'Texto deve ser marrom quente #4E3B31');
    assert.strictEqual(s1.htmlClasses.includes('pre-jessica'), false, 'pre-jessica deve ser removido do html após revealInterface');
    assert.strictEqual(s1.htmlClasses.includes('pre-raia'), false, 'pre-raia não deve existir no html');
    assert.strictEqual(s1.bodyClasses.includes('pre-jessica'), false, 'pre-jessica deve ser removido do body');
    assert.strictEqual(s1.bodyClasses.includes('app-initializing'), false, 'app-initializing deve ser removido');
    assert.strictEqual(s1.bodyClasses.includes('theme-jessica-beauty'), true, 'theme-jessica-beauty deve estar ativo');
    assert.strictEqual(s1.bodyClasses.includes('theme-raia'), false, 'theme-raia não deve estar no body');
    assert.strictEqual(s1.isAppointmentsVisible, true, 'Agenda de atendimentos visível');
    assert.strictEqual(s1.isMyProductsVisible, false, 'Meus Produtos oculto');

    const shot1 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'jessica-theme-transition-appointments.png'), Buffer.from(shot1.data, 'base64'));
    console.log('  ✓ Teste 1 APROVADO: Estilos Jéssica Beauty Premium ativos e classes temporárias limpas.\n');

    // =========================================================
    // TESTE 2: TRANSIÇÃO JÉSSICA -> HUB CENTRAL (SEM RECARREGAR)
    // =========================================================
    console.log('[Teste 2] Transição Jéssica -> HUB Central via switchTab("my-products") sem recarregar...');
    await sendCmd('Runtime.evaluate', {
      expression: `switchTab('my-products');`
    });
    await new Promise(r => setTimeout(r, 200));

    const s2 = await getThemeState();
    console.log('  -> Hash:', s2.hash);
    console.log('  -> Cor de fundo computada no body:', s2.computedBg);
    console.log('  -> Cor do texto computada no body:', s2.computedColor);
    console.log('  -> HTML classes:', s2.htmlClasses.join(' '));
    console.log('  -> Body classes:', s2.bodyClasses.join(' '));

    assert.strictEqual(s2.hash, '#my-products', 'Hash deve ser #my-products');
    assert.strictEqual(s2.computedBg, 'rgb(7, 8, 12)', 'Fundo deve mudar imediatamente para o escuro institucional #07080c');
    assert.strictEqual(s2.computedColor, 'rgb(241, 245, 249)', 'Texto deve mudar imediatamente para #F1F5F9');
    assert.strictEqual(s2.htmlClasses.includes('dark'), true, 'html deve ter classe dark');
    assert.strictEqual(s2.htmlClasses.includes('theme-raia'), true, 'html deve ter classe theme-raia');
    assert.strictEqual(s2.htmlClasses.includes('theme-jessica-beauty'), false, 'theme-jessica-beauty deve ser removido do html');
    assert.strictEqual(s2.bodyClasses.includes('theme-raia'), true, 'body deve ter classe theme-raia');
    assert.strictEqual(s2.bodyClasses.includes('bg-[#07080c]'), true, 'body deve ter classe bg-[#07080c]');
    assert.strictEqual(s2.bodyClasses.includes('theme-jessica-beauty'), false, 'theme-jessica-beauty deve ser removido do body');
    assert.strictEqual(s2.isMyProductsVisible, true, 'Meus Produtos visível no Hub');
    assert.strictEqual(s2.isAppointmentsVisible, false, 'Agenda Jéssica oculta no Hub');

    const shot2 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'hub-theme-transition-my-products.png'), Buffer.from(shot2.data, 'base64'));
    console.log('  ✓ Teste 2 APROVADO: Transição dinâmica sem reload aplica perfeitamente o tema HUB Central escuro.\n');

    // =========================================================
    // TESTE 3: TRANSIÇÃO HUB CENTRAL -> JÉSSICA (SEM RECARREGAR)
    // =========================================================
    console.log('[Teste 3] Transição de volta HUB Central -> Jéssica via switchTab("appointments") sem recarregar...');
    await sendCmd('Runtime.evaluate', {
      expression: `switchTab('appointments');`
    });
    await new Promise(r => setTimeout(r, 200));

    const s3 = await getThemeState();
    console.log('  -> Hash:', s3.hash);
    console.log('  -> Cor de fundo computada no body:', s3.computedBg);
    console.log('  -> Cor do texto computada no body:', s3.computedColor);
    console.log('  -> HTML classes:', s3.htmlClasses.join(' '));
    console.log('  -> Body classes:', s3.bodyClasses.join(' '));

    assert.strictEqual(s3.hash, '#appointments', 'Hash deve ser #appointments');
    assert.strictEqual(s3.computedBg, 'rgb(247, 239, 231)', 'Fundo deve voltar imediatamente para champagne #F7EFE7');
    assert.strictEqual(s3.computedColor, 'rgb(78, 59, 49)', 'Texto deve voltar para #4E3B31');
    assert.strictEqual(s3.htmlClasses.includes('dark'), false, 'html NÃO deve ter classe dark');
    assert.strictEqual(s3.htmlClasses.includes('theme-raia'), false, 'html NÃO deve ter classe theme-raia');
    assert.strictEqual(s3.htmlClasses.includes('theme-jessica-beauty'), true, 'html deve ter theme-jessica-beauty');
    assert.strictEqual(s3.bodyClasses.includes('theme-jessica-beauty'), true, 'body deve ter theme-jessica-beauty');
    assert.strictEqual(s3.bodyClasses.includes('theme-raia'), false, 'body NÃO deve ter theme-raia');
    assert.strictEqual(s3.isAppointmentsVisible, true, 'Agenda de atendimentos visível');
    assert.strictEqual(s3.isMyProductsVisible, false, 'Meus Produtos oculto');
    console.log('  ✓ Teste 3 APROVADO: Reversão imediata para o tema Jéssica sem recarregar.\n');

    // =========================================================
    // TESTE 4: CICLO DE ALTERNÂNCIAS SUCESSIVAS (SEM RECARREGAR)
    // =========================================================
    console.log('[Teste 4] Múltiplas alternâncias sucessivas Jéssica <-> HUB sem recarregar...');
    const alternationSequence = [
      { tab: 'my-subscriptions', expectedTheme: 'hub', expectedBg: 'rgb(7, 8, 12)' },
      { tab: 'services', expectedTheme: 'jessica', expectedBg: 'rgb(247, 239, 231)' },
      { tab: 'my-invoices', expectedTheme: 'hub', expectedBg: 'rgb(7, 8, 12)' },
      { tab: 'staff', expectedTheme: 'jessica', expectedBg: 'rgb(247, 239, 231)' },
      { tab: 'explore-solutions', expectedTheme: 'hub', expectedBg: 'rgb(7, 8, 12)' },
      { tab: 'integrations-google', expectedTheme: 'jessica', expectedBg: 'rgb(247, 239, 231)' }
    ];

    for (let i = 0; i < alternationSequence.length; i++) {
      const step = alternationSequence[i];
      await sendCmd('Runtime.evaluate', { expression: `switchTab('${step.tab}');` });
      await new Promise(r => setTimeout(r, 100));

      const st = await getThemeState();
      assert.strictEqual(st.hash, '#' + step.tab);
      assert.strictEqual(st.computedBg, step.expectedBg, `Passo ${i+1} (${step.tab}): fundo computado deve ser ${step.expectedBg}`);

      if (step.expectedTheme === 'hub') {
        assert.strictEqual(st.htmlClasses.includes('dark'), true);
        assert.strictEqual(st.bodyClasses.includes('theme-raia'), true);
        assert.strictEqual(st.bodyClasses.includes('theme-jessica-beauty'), false);
      } else {
        assert.strictEqual(st.htmlClasses.includes('dark'), false);
        assert.strictEqual(st.bodyClasses.includes('theme-jessica-beauty'), true);
        assert.strictEqual(st.bodyClasses.includes('theme-raia'), false);
      }
      console.log(`  -> Passo ${i+1} [${step.tab}] (${step.expectedTheme.toUpperCase()}): BG=${st.computedBg} ✓`);
    }
    console.log('  ✓ Teste 4 APROVADO: Estabilidade mantida em 6 transições alternadas sucessivas.\n');

    // =========================================================
    // TESTE 5: HISTÓRICO VOLTAR / AVANÇAR (POPSTATE) SEM RECARREGAR
    // =========================================================
    console.log('[Teste 5] Navegação no histórico (popstate) entre Hub e Jéssica sem recarregar...');
    // Estamos em #integrations-google (Jéssica). Vamos voltar 1 passo para explore-solutions (Hub)
    await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        window.history.back();
        await new Promise(r => setTimeout(r, 150));
      })()`,
      awaitPromise: true
    });

    const s5_back = await getThemeState();
    console.log('  -> Após back(): Hash=', s5_back.hash, 'BG=', s5_back.computedBg);
    assert.strictEqual(s5_back.hash, '#explore-solutions');
    assert.strictEqual(s5_back.computedBg, 'rgb(7, 8, 12)', 'Fundo deve ser Hub Central após history.back()');
    assert.strictEqual(s5_back.bodyClasses.includes('theme-raia'), true);

    // Agora avançar de volta para #integrations-google (Jéssica)
    await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        window.history.forward();
        await new Promise(r => setTimeout(r, 150));
      })()`,
      awaitPromise: true
    });

    const s5_fwd = await getThemeState();
    console.log('  -> Após forward(): Hash=', s5_fwd.hash, 'BG=', s5_fwd.computedBg);
    assert.strictEqual(s5_fwd.hash, '#integrations-google');
    assert.strictEqual(s5_fwd.computedBg, 'rgb(247, 239, 231)', 'Fundo deve ser Jéssica após history.forward()');
    assert.strictEqual(s5_fwd.bodyClasses.includes('theme-jessica-beauty'), true);
    console.log('  ✓ Teste 5 APROVADO: Histórico do navegador restaura o tema exato de cada aba.\n');

    // =========================================================
    // TESTE 6: PRECEDÊNCIA CANÔNICA (QUERY ?modulo=jessica vs HASH #my-products)
    // =========================================================
    console.log('[Teste 6] Precedência Canônica: URL com ?modulo=jessica e #my-products...');
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html?modulo=jessica#my-products`
    });
    await new Promise(r => setTimeout(r, 1200));

    const s6 = await getThemeState();
    console.log('  -> URL atual:', s6.url);
    console.log('  -> Hash:', s6.hash);
    console.log('  -> Search:', s6.search);
    console.log('  -> Cor de fundo computada no body:', s6.computedBg);
    console.log('  -> "Meus Produtos" visível:', s6.isMyProductsVisible);

    assert.strictEqual(s6.hash, '#my-products', 'Hash #my-products deve prevalecer');
    assert.strictEqual(s6.computedBg, 'rgb(7, 8, 12)', 'Fundo DEVE ser escuro do Hub, pois #my-products tem prioridade sobre ?modulo=jessica');
    assert.strictEqual(s6.htmlClasses.includes('dark'), true, 'html deve ter classe dark');
    assert.strictEqual(s6.bodyClasses.includes('theme-raia'), true, 'body deve ter theme-raia');
    assert.strictEqual(s6.bodyClasses.includes('theme-jessica-beauty'), false, 'body NÃO deve ter theme-jessica-beauty');
    assert.strictEqual(s6.isMyProductsVisible, true, 'Aba "Meus Produtos" visível');
    assert.strictEqual(s6.isAppointmentsVisible, false, 'Agenda oculta');
    assert.strictEqual(s6.search.includes('modulo=jessica'), false, 'Parâmetro de query modulo=jessica deve ser limpo da URL');

    const shot6 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'canonical-precedence-my-products.png'), Buffer.from(shot6.data, 'base64'));
    console.log('  ✓ Teste 6 APROVADO: Precedência canônica da hash sobre query parameters respeitada.\n');

    // =========================================================
    // TESTE 7: LIMPEZA DE PARÂMETROS SENSÍVEIS OAUTH PRESERVANDO HASH
    // =========================================================
    console.log('[Teste 7] Limpeza de parâmetros sensíveis OAuth preservando hash ativa (#appointments)...');
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html?google_connected=true&email=salao%40jessica.com#appointments`
    });
    await new Promise(r => setTimeout(r, 1200));

    const s7 = await getThemeState();
    console.log('  -> URL pós-limpeza:', s7.url);
    console.log('  -> Hash preservada:', s7.hash);
    console.log('  -> Search restante:', s7.search);
    console.log('  -> Cor de fundo:', s7.computedBg);

    assert.strictEqual(s7.hash, '#appointments', 'Hash #appointments deve ser preservada');
    assert.strictEqual(s7.search.includes('google_connected'), false, 'google_connected deve ser removido');
    assert.strictEqual(s7.search.includes('email'), false, 'email sensível deve ser removido');
    assert.strictEqual(s7.computedBg, 'rgb(247, 239, 231)', 'Tema Jéssica deve estar ativo');
    console.log('  ✓ Teste 7 APROVADO: Parâmetros OAuth limpos e hash canônica mantida.\n');

    // =========================================================
    // TESTE 8: F5 DIRETO NO HUB CENTRAL (#my-products)
    // =========================================================
    console.log('[Teste 8] F5 direto no HUB Central (#my-products) e transição subsequente...');
    await sendCmd('Runtime.evaluate', { expression: `switchTab('my-products');` });
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    const s8_initial = await getThemeState();
    assert.strictEqual(s8_initial.hash, '#my-products');
    assert.strictEqual(s8_initial.computedBg, 'rgb(7, 8, 12)');
    assert.strictEqual(s8_initial.htmlClasses.includes('pre-raia'), false, 'pre-raia removido após reveal');
    assert.strictEqual(s8_initial.bodyClasses.includes('theme-raia'), true);

    // Mudar para Jéssica e validar que aplica corretamente
    await sendCmd('Runtime.evaluate', { expression: `switchTab('salon');` });
    await new Promise(r => setTimeout(r, 200));

    const s8_salon = await getThemeState();
    assert.strictEqual(s8_salon.hash, '#salon');
    assert.strictEqual(s8_salon.computedBg, 'rgb(247, 239, 231)');
    assert.strictEqual(s8_salon.bodyClasses.includes('theme-jessica-beauty'), true);
    console.log('  ✓ Teste 8 APROVADO: F5 no Hub inicializa com dark institucional e permite transição limpa para Jéssica.\n');

    console.log('================================================================');
    console.log('   TODOS OS 8 TESTES DE TRANSIÇÃO DE TEMAS FORAM APROVADOS!     ');
    console.log('================================================================');

  } finally {
    if (ws) ws.close();
    chrome.kill('SIGKILL');
    await new Promise(r => httpServer.close(r));
  }
}

runTransitionsValidation().catch(err => {
  console.error('\n❌ ERRO NA VALIDAÇÃO DE TRANSIÇÕES DE TEMAS:', err);
  process.exit(1);
});
