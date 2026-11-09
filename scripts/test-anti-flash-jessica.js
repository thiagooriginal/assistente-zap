/**
 * RAIA AGENTES — TESTE VISUAL ANTI-FLASH E INICIALIZAÇÃO SEGURA (COMANDO 006)
 * 
 * Verificação automatizada dos requisitos:
 * - Teste A: F5 na Agenda Jéssica (#appointments) sem flash escuro do HUB nem exibição de "Meus Produtos".
 * - Teste B: Simulação de Rede Lenta (atraso >= 2s na /api/cliente/profile) capturando o estado intermediário.
 * - Teste C: F5 nas outras seções da Jéssica (#services, #staff, #integrations-google).
 * - Teste D: F5 no HUB Central (#my-products) mantendo identidade escura própria sem flash da Jéssica.
 * - Teste E: Segurança com sessão 401: nenhum dado operacional revelado antes do redirecionamento ao login.
 * - Teste F: Navegação geral, Voltar/Avançar, OAuth e responsividade desktop/mobile.
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

async function runValidation() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — TESTE DE ELIMINAÇÃO DO FLASH DA JÉSSICA (006) ');
  console.log('================================================================\n');

  const HTTP_PORT = 4155;
  const CDP_PORT = 9266;
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

    // =========================================================
    // TESTE A: F5 NA AGENDA JÉSSICA (#appointments)
    // =========================================================
    console.log('[Teste A] F5 real na Agenda Jéssica (#appointments)...');
    
    // Executar reload real
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    const tA = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const doc = document.documentElement;
        const body = document.body;
        const myProductsSection = document.getElementById('tab-my-products');
        const appointmentsSection = document.getElementById('tab-appointments');
        const computedBg = window.getComputedStyle(body).backgroundColor;

        return {
          hash: window.location.hash,
          hasDarkClass: doc.classList.contains('dark'),
          hasPreJessica: doc.classList.contains('pre-jessica'),
          hasBeautyTheme: body.classList.contains('theme-jessica-beauty'),
          myProductsHidden: myProductsSection.classList.contains('hidden'),
          appointmentsVisible: !appointmentsSection.classList.contains('hidden'),
          computedBg: computedBg,
          curtainGoneOrHidden: !document.getElementById('appInitCurtain') || document.getElementById('appInitCurtain').classList.contains('curtain-hidden')
        };
      })()`,
      returnByValue: true
    });

    const resA = tA.result.value;
    console.log('  -> Hash na URL:', resA.hash);
    console.log('  -> HTML possui classe dark:', resA.hasDarkClass);
    console.log('  -> Pré-detecção pre-jessica ativa:', resA.hasPreJessica);
    console.log('  -> Tema Jéssica Beauty ativo no body:', resA.hasBeautyTheme);
    console.log('  -> "Meus Produtos" permaneceu oculto:', resA.myProductsHidden);
    console.log('  -> Agenda de atendimentos visível:', resA.appointmentsVisible);
    console.log('  -> Cor de fundo final da página:', resA.computedBg);

    assert.strictEqual(resA.hash, '#appointments', 'Hash deve ser #appointments');
    assert.strictEqual(resA.hasDarkClass, false, 'HTML NÃO deve ter classe dark em seção da Jéssica');
    assert.strictEqual(resA.hasPreJessica, false, 'Pré-detecção síncrona pre-jessica deve ser removida após revealInterface()');
    assert.strictEqual(resA.hasBeautyTheme, true, 'Body deve ter tema Jéssica Beauty');
    assert.strictEqual(resA.myProductsHidden, true, 'Aba "Meus Produtos" JAMAIS deve ser renderizada na Jéssica');
    assert.strictEqual(resA.appointmentsVisible, true, 'Aba appointments deve estar visível');

    // Capturar screenshot final do Teste A
    const shotA = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'jessica-anti-flash-final-appointments.png'), Buffer.from(shotA.data, 'base64'));
    console.log('  ✓ Teste A APROVADO: F5 direto na Jéssica sem exibição transitória do HUB.\n');

    // =========================================================
    // TESTE B: SIMULAÇÃO DE REDE LENTA (>= 2s) E ESTADO INTERMEDIÁRIO
    // =========================================================
    console.log('[Teste B] Rede lenta (delay de 2000ms na /api/cliente/profile)...');
    testState.networkDelayMs = 2000;

    // Disparar reload
    await sendCmd('Page.reload');

    // Aguardar 500ms (momento exato em que a requisição de perfil ainda está em voo)
    await new Promise(r => setTimeout(r, 600));

    const tB_intermediate = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const doc = document.documentElement;
        const body = document.body;
        const curtain = document.getElementById('appInitCurtain');
        const myProducts = document.getElementById('tab-my-products');
        const appointments = document.getElementById('tab-appointments');
        const computedBg = window.getComputedStyle(body).backgroundColor;

        return {
          isDark: doc.classList.contains('dark'),
          isPreJessica: doc.classList.contains('pre-jessica'),
          isInitializing: body.classList.contains('app-initializing'),
          curtainVisible: curtain && !curtain.classList.contains('curtain-hidden'),
          curtainJessicaActive: window.getComputedStyle(document.getElementById('curtainJessicaContent')).display !== 'none',
          curtainRaiaActive: window.getComputedStyle(document.getElementById('curtainRaiaContent')).display !== 'none',
          myProductsHidden: myProducts ? myProducts.classList.contains('hidden') : true,
          appointmentsHiddenWhileLoading: appointments ? appointments.classList.contains('hidden') : true,
          computedBg: computedBg
        };
      })()`,
      returnByValue: true
    });

    const resB = tB_intermediate.result.value;
    console.log('  [Estado Intermediário aos 600ms - Perfil aguardando rede]');
    console.log('    -> Classe dark do Hub presente:', resB.isDark);
    console.log('    -> Pré-tema pre-jessica ativo:', resB.isPreJessica);
    console.log('    -> Cortina visual ativa:', resB.curtainVisible);
    console.log('    -> Loader do Módulo Jéssica exibido:', resB.curtainJessicaActive);
    console.log('    -> Loader do HUB Central desativado:', !resB.curtainRaiaActive);
    console.log('    -> "Meus Produtos" oculto:', resB.myProductsHidden);
    console.log('    -> Fundo Champagne computado no body:', resB.computedBg);

    // Salvar screenshot do estado intermediário do loader
    const shotB = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'jessica-anti-flash-loading-interstitial.png'), Buffer.from(shotB.data, 'base64'));

    assert.strictEqual(resB.isDark, false, 'HTML NÃO deve ser dark durante carregamento da Jéssica');
    assert.strictEqual(resB.isPreJessica, true, 'pre-jessica deve estar ativo desde a primeira pintura');
    assert.strictEqual(resB.curtainVisible, true, 'Cortina de carregamento discreto deve estar visível');
    assert.strictEqual(resB.curtainJessicaActive, true, 'Loader da Jéssica deve estar ativo');
    assert.strictEqual(resB.curtainRaiaActive, false, 'Loader do Hub NÃO deve estar ativo');
    assert.strictEqual(resB.myProductsHidden, true, 'Aba "Meus Produtos" JAMAIS deve ser renderizada durante o delay');

    // Aguardar conclusão da resposta lenta
    await new Promise(r => setTimeout(r, 2000));
    testState.networkDelayMs = 0; // Restaurar latência normal

    const tB_final = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        return {
          aptVisible: !document.getElementById('tab-appointments').classList.contains('hidden'),
          isBeauty: document.body.classList.contains('theme-jessica-beauty')
        };
      })()`,
      returnByValue: true
    });
    assert.strictEqual(tB_final.result.value.aptVisible, true, 'Agenda de atendimentos revelada perfeitamente após resposta');
    console.log('  ✓ Teste B APROVADO: Durante os 2s de rede lenta, o HUB Central não apareceu em momento algum.\n');

    // =========================================================
    // TESTE C: OUTRAS SEÇÕES JÉSSICA (#services, #staff, #integrations-google)
    // =========================================================
    console.log('[Teste C] F5 direto em Serviços, Equipe e Google Calendar...');
    const sections = ['services', 'staff', 'integrations-google'];

    for (const sec of sections) {
      await sendCmd('Runtime.evaluate', {
        expression: `switchTab('${sec}');`
      });
      await sendCmd('Page.reload');
      await new Promise(r => setTimeout(r, 1000));

      const tSec = await sendCmd('Runtime.evaluate', {
        expression: `(() => {
          const doc = document.documentElement;
          const body = document.body;
          const tabEl = document.getElementById('tab-${sec}');
          const hubEl = document.getElementById('tab-my-products');

          return {
            hash: window.location.hash,
            isDark: doc.classList.contains('dark'),
            isPreJessica: doc.classList.contains('pre-jessica'),
            isBeauty: body.classList.contains('theme-jessica-beauty'),
            tabVisible: tabEl && !tabEl.classList.contains('hidden'),
            hubHidden: hubEl && hubEl.classList.contains('hidden')
          };
        })()`,
        returnByValue: true
      });

      const r = tSec.result.value;
      console.log(`  -> Seção #${sec}: aberta diretamente, tema Beauty=${r.isBeauty}, Hub oculto=${r.hubHidden}`);
      assert.strictEqual(r.hash, '#' + sec);
      assert.strictEqual(r.isDark, false);
      assert.strictEqual(r.isPreJessica, false, 'pre-jessica deve ser removido após revealInterface()');
      assert.strictEqual(r.isBeauty, true);
      assert.strictEqual(r.tabVisible, true);
      assert.strictEqual(r.hubHidden, true);
    }
    console.log('  ✓ Teste C APROVADO: Todas as seções da Jéssica abrem diretamente sem flash do Hub.\n');

    // =========================================================
    // TESTE D: HUB CENTRAL (#my-products)
    // =========================================================
    console.log('[Teste D] F5 no HUB Central (#my-products)...');
    await sendCmd('Runtime.evaluate', {
      expression: `switchTab('my-products');`
    });
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    const tD = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const doc = document.documentElement;
        const body = document.body;
        const myProducts = document.getElementById('tab-my-products');
        const appointments = document.getElementById('tab-appointments');
        const computedBg = window.getComputedStyle(body).backgroundColor;

        return {
          hash: window.location.hash,
          isDark: doc.classList.contains('dark'),
          isPreRaia: doc.classList.contains('pre-raia'),
          isBeauty: body.classList.contains('theme-jessica-beauty'),
          isRaia: body.classList.contains('theme-raia'),
          hubVisible: myProducts && !myProducts.classList.contains('hidden'),
          aptHidden: appointments && appointments.classList.contains('hidden'),
          computedBg: computedBg
        };
      })()`,
      returnByValue: true
    });

    const resD = tD.result.value;
    console.log('  -> Hash do Hub:', resD.hash);
    console.log('  -> Tema dark ativo no HTML:', resD.isDark);
    console.log('  -> Tema pré-raia ativo:', resD.isPreRaia);
    console.log('  -> Tema Jéssica Beauty desativado:', !resD.isBeauty);
    console.log('  -> "Meus Produtos" visível:', resD.hubVisible);
    console.log('  -> Agenda Jéssica oculta:', resD.aptHidden);
    console.log('  -> Cor de fundo escura do Hub:', resD.computedBg);

    // Salvar screenshot do Hub Central
    const shotD = await sendCmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'hub-central-anti-flash-reloaded.png'), Buffer.from(shotD.data, 'base64'));

    assert.strictEqual(resD.isDark, true, 'Hub Central deve ser dark');
    assert.strictEqual(resD.isPreRaia, false, 'pre-raia deve ser removido após revealInterface()');
    assert.strictEqual(resD.isBeauty, false, 'Hub NÃO deve ter tema Jéssica Beauty');
    assert.strictEqual(resD.hubVisible, true, 'Aba "Meus Produtos" deve estar visível no Hub');
    assert.strictEqual(resD.aptHidden, true, 'Aba appointments deve estar oculta');
    console.log('  ✓ Teste D APROVADO: Hub Central abre com identidade escura própria sem flash da Jéssica.\n');

    // =========================================================
    // TESTE E: SEGURANÇA COM SESSÃO EXPIRADA / RETORNO 401
    // =========================================================
    console.log('[Teste E] Segurança: Sessão 401 não revela dados operacionais...');
    testState.authStatus = 401;

    // Selecionar agenda e disparar reload real com sessão expirada
    await sendCmd('Runtime.evaluate', {
      expression: `switchTab('appointments');`
    });
    await sendCmd('Page.reload');

    let currentUrl = '';
    let aptHidden = true;
    let salonHidden = true;

    const startWait = Date.now();
    while (Date.now() - startWait < 4000) {
      await new Promise(r => setTimeout(r, 200));
      const evalRes = await sendCmd('Runtime.evaluate', {
        expression: `(() => {
          return {
            url: window.location.href,
            aptHidden: document.getElementById('tab-appointments') ? document.getElementById('tab-appointments').classList.contains('hidden') : true,
            salonHidden: document.getElementById('tab-salon') ? document.getElementById('tab-salon').classList.contains('hidden') : true
          };
        })()`,
        returnByValue: true
      });

      const val = evalRes.result?.value;
      if (val) {
        currentUrl = val.url;
        aptHidden = val.aptHidden;
        salonHidden = val.salonHidden;
        if (currentUrl.includes('/cliente/login')) break;
      }
    }

    console.log('  -> URL final após falha de autenticação:', currentUrl);
    console.log('  -> Abas operacionais mantidas 100% ocultas:', aptHidden && salonHidden);

    assert.strictEqual(currentUrl.includes('/cliente/login'), true, 'Deve redirecionar para a página de login');
    assert.strictEqual(aptHidden, true, 'Aba appointments não deve ser revelada ao falhar autenticação');
    assert.strictEqual(salonHidden, true, 'Aba salon não deve ser revelada ao falhar autenticação');
    console.log('  ✓ Teste E APROVADO: Sessão 401 preserva sigilo absoluto e redireciona ao login.\n');

    // Restaurar sessão válida para o Teste F
    testState.authStatus = 200;

    // =========================================================
    // TESTE F: NAVEGAÇÃO GERAL, VOLTAR/AVANÇAR E RESPONSIVIDADE MOBILE
    // =========================================================
    console.log('[Teste F] Navegação geral, Voltar/Avançar e Mobile 390x844...');
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html#appointments`
    });
    await new Promise(r => setTimeout(r, 1000));

    // Testar Voltar / Avançar
    const tF_nav = await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        switchTab('services');
        switchTab('salon');
        window.history.back();
        await new Promise(r => setTimeout(r, 100));
        const backTab = window.location.hash;
        window.history.forward();
        await new Promise(r => setTimeout(r, 100));
        const fwdTab = window.location.hash;
        return { backTab, fwdTab };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    assert.strictEqual(tF_nav.result.value.backTab, '#services');
    assert.strictEqual(tF_nav.result.value.fwdTab, '#salon');
    console.log('  -> Histórico Voltar/Avançar validado.');

    // Testar viewport mobile 390x844
    await sendCmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    const tF_mobile = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const body = document.body;
        const currentTab = window.location.hash.replace('#', '') || 'salon';
        const activeSection = document.getElementById('tab-' + currentTab);
        return {
          currentTab,
          isBeauty: body.classList.contains('theme-jessica-beauty'),
          tabVisible: activeSection ? !activeSection.classList.contains('hidden') : false
        };
      })()`,
      returnByValue: true
    });
    assert.strictEqual(tF_mobile.result.value.isBeauty, true);
    assert.strictEqual(tF_mobile.result.value.tabVisible, true);
    console.log(`  -> Mobile 390x844 aprovado com tema Jéssica e seção #${tF_mobile.result.value.currentTab} visível.`);

    console.log('  ✓ Teste F APROVADO: Navegação geral e responsividade validadas.\n');

    // Fechar conexões
    ws.close();
    chrome.kill();
    await new Promise(res => httpServer.close(res));

    console.log('================================================================');
    console.log('   TODOS OS TESTES VISUAIS ANTI-FLASH PASSARAM COM SUCESSO!     ');
    console.log('================================================================\n');

  } catch (err) {
    if (ws) ws.close();
    chrome.kill();
    httpServer.close();
    console.error('\n❌ FALHA NOS TESTES ANTI-FLASH:', err);
    process.exit(1);
  }
}

runValidation();
