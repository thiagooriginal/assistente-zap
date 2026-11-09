/**
 * RAIA AGENTES — SUÍTE DE TESTES DE PERSISTÊNCIA DE NAVEGAÇÃO E SEGURANÇA OAUTH
 * 
 * Verificação automatizada dos 10 requisitos obrigatórios do comando 005:
 * 1. F5 real preservando a aba.
 * 2. Navegação entre todas as seções HUB/Jéssica (14 abas).
 * 3. Voltar e Avançar reais do navegador (popstate).
 * 4. URL antiga com ?tab= e novo hash sem conflito (canonicalização via replaceState).
 * 5. Retorno OAuth com #tab-integrations-google.
 * 6. Limpeza dos parâmetros temporários OAuth pós-notificação e sem repetição no F5.
 * 7. Mensagens contendo HTML malicioso renderizadas apenas como texto (prevenção XSS).
 * 8. Alternância entre dois usuários fictícios sem herança de preferências.
 * 9. Logout e login preservando isolamento.
 * 10. Falha de autenticação sem exposição de telas internas.
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

// Estado dinâmico do servidor de mock para os testes
const testState = {
  authStatus: 200,
  currentUser: {
    id: 101,
    name: 'Jéssica Teste Premium',
    email: 'jessica@salao.com.br',
    planTier: 'JESSICA_PRO',
    salon: { name: 'Jéssica Beauty & Nails' }
  },
  logoutCalls: 0
};

function startTestHttpServer(port) {
  const painelHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'cliente', 'painel.html'), 'utf8');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === '/cliente/painel.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(painelHtml);
    }

    if (url.pathname === '/cliente/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><html><body><h1 id="loginHeader">Página de Login RAIA</h1></body></html>');
    }

    if (url.pathname === '/api/cliente/profile') {
      if (testState.authStatus === 401 || testState.authStatus === 403) {
        res.writeHead(testState.authStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, profile: testState.currentUser }));
    }

    if (url.pathname === '/api/cliente/auth/logout') {
      testState.logoutCalls++;
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
  console.log('   RAIA AGENTES — TESTE DE HARDENING DA NAVEGAÇÃO E SEGURANÇA   ');
  console.log('================================================================\n');

  const HTTP_PORT = 4133;
  const CDP_PORT = 9244;
  const httpServer = await startTestHttpServer(HTTP_PORT);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--hide-scrollbars',
    `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html`
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

    // Habilitar Page e Runtime no CDP
    await sendCmd('Page.enable');
    await sendCmd('Runtime.enable');

    // Aguardar página pronta
    await sendCmd('Runtime.evaluate', {
      expression: `new Promise(resolve => {
        const check = () => {
          if (typeof loadProfile === 'function' && document.body) resolve(true);
          else setTimeout(check, 50);
        };
        check();
      })`,
      awaitPromise: true
    });

    // =========================================================
    // TESTE 1: F5 REAL PRESERVANDO A ABA ATIVA (#appointments)
    // =========================================================
    console.log('[Teste 1] F5 real preservando a aba ativa (#appointments)...');
    await sendCmd('Runtime.evaluate', {
      expression: `switchTab('appointments');`
    });

    // Executar reload real da página via protocolo CDP
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 1200));

    // Aguardar re-inicialização pós reload
    const t1 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        return {
          hash: window.location.hash,
          isBeauty: document.body.classList.contains('theme-jessica-beauty'),
          aptVisible: !document.getElementById('tab-appointments').classList.contains('hidden'),
          hubVisible: !document.getElementById('tab-my-products').classList.contains('hidden'),
          legacyStorage: localStorage.getItem('raia_active_tab')
        };
      })()`,
      returnByValue: true
    });

    const res1 = t1.result.value;
    console.log('  -> Hash na URL após F5:', res1.hash);
    console.log('  -> Tema Jéssica Beauty ativo:', res1.isBeauty);
    console.log('  -> Aba appointments visível:', res1.aptVisible);
    console.log('  -> Chave legada raia_active_tab no localStorage:', res1.legacyStorage);

    assert.strictEqual(res1.hash, '#appointments', 'URL deve conter #appointments');
    assert.strictEqual(res1.isBeauty, true, 'Tema Jéssica Beauty deve permanecer ativo');
    assert.strictEqual(res1.aptVisible, true, 'Aba appointments deve estar visível');
    assert.strictEqual(res1.hubVisible, false, 'Aba my-products deve estar oculta');
    assert.strictEqual(res1.legacyStorage, null, 'Chave legada compartilhada deve ser nula');
    console.log('  ✓ 1. F5 real preservou aba e tema sem compartilhamento indevido no localStorage.\n');

    // =========================================================
    // TESTE 2: NAVEGAÇÃO ENTRE TODAS AS SEÇÕES HUB E JÉSSICA (14 ABAS)
    // =========================================================
    console.log('[Teste 2] Navegação entre todas as 14 seções do HUB e da Jéssica...');
    const allTabs = [
      { id: 'my-products', module: 'hub' },
      { id: 'my-subscriptions', module: 'hub' },
      { id: 'my-invoices', module: 'hub' },
      { id: 'explore-solutions', module: 'hub' },
      { id: 'profile-security', module: 'hub' },
      { id: 'overview', module: 'jessica' },
      { id: 'salon', module: 'jessica' },
      { id: 'services', module: 'jessica' },
      { id: 'staff', module: 'jessica' },
      { id: 'appointments', module: 'jessica' },
      { id: 'integrations-google', module: 'jessica' },
      { id: 'integrations-whatsapp', module: 'jessica' },
      { id: 'dashboard-pro', module: 'jessica' },
      { id: 'campaigns-pro', module: 'jessica' }
    ];

    for (const item of allTabs) {
      const resTab = await sendCmd('Runtime.evaluate', {
        expression: `(() => {
          switchTab('${item.id}');
          return {
            hash: window.location.hash,
            isVisible: !document.getElementById('tab-${item.id}').classList.contains('hidden'),
            isBeauty: document.body.classList.contains('theme-jessica-beauty'),
            isRaia: document.body.classList.contains('theme-raia')
          };
        })()`,
        returnByValue: true
      });

      const r = resTab.result.value;
      assert.strictEqual(r.hash, '#' + item.id, `Hash deve ser #${item.id}`);
      assert.strictEqual(r.isVisible, true, `Aba tab-${item.id} deve estar visível`);
      if (item.module === 'jessica') {
        assert.strictEqual(r.isBeauty, true, `Tema Jéssica deve estar ativo para ${item.id}`);
      } else {
        assert.strictEqual(r.isRaia, true, `Tema RAIA deve estar ativo para ${item.id}`);
      }
    }
    console.log('  ✓ 2. Todas as 14 abas (5 HUB + 9 Jéssica) navegam e ativam temas corretamente.\n');

    // =========================================================
    // TESTE 3: VOLTAR E AVANÇAR REAIS DO NAVEGADOR (POPSTATE)
    // =========================================================
    console.log('[Teste 3] Histórico do navegador: Voltar e Avançar com popstate...');
    const t3 = await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        // Sequência: my-products -> appointments -> services
        switchTab('my-products');
        switchTab('appointments');
        switchTab('services');

        // Voltar real no histórico do navegador
        window.history.back();
        await new Promise(r => setTimeout(r, 100));

        const backVisible = !document.getElementById('tab-appointments').classList.contains('hidden');
        const backHash = window.location.hash;

        // Avançar real no histórico do navegador
        window.history.forward();
        await new Promise(r => setTimeout(r, 100));

        const fwdVisible = !document.getElementById('tab-services').classList.contains('hidden');
        const fwdHash = window.location.hash;

        return { backVisible, backHash, fwdVisible, fwdHash };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });

    const res3 = t3.result.value;
    console.log('  -> Voltar para:', res3.backHash, '(visível:', res3.backVisible, ')');
    console.log('  -> Avançar para:', res3.fwdHash, '(visível:', res3.fwdVisible, ')');

    assert.strictEqual(res3.backVisible, true, 'Ao voltar, appointments deve estar visível');
    assert.strictEqual(res3.backHash, '#appointments', 'Hash deve voltar a #appointments');
    assert.strictEqual(res3.fwdVisible, true, 'Ao avançar, services deve estar visível');
    assert.strictEqual(res3.fwdHash, '#services', 'Hash deve avançar a #services');
    console.log('  ✓ 3. Botões Voltar e Avançar reais sincronizados perfeitamente.\n');

    // =========================================================
    // TESTE 4: URL ANTIGA COM ?tab= E NOVO HASH SEM CONFLITO
    // =========================================================
    console.log('[Teste 4] URL mista com ?tab=appointments e #services (canonicalização)...');
    // Navegar para URL conflitante
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html?tab=appointments#services`
    });
    await new Promise(r => setTimeout(r, 1200));

    const t4 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        return {
          canonicalHash: window.location.hash,
          searchRemaining: window.location.search,
          servicesVisible: !document.getElementById('tab-services').classList.contains('hidden'),
          appointmentsVisible: !document.getElementById('tab-appointments').classList.contains('hidden')
        };
      })()`,
      returnByValue: true
    });

    const res4 = t4.result.value;
    console.log('  -> Hash canônico adotado:', res4.canonicalHash);
    console.log('  -> Query params restantes:', res4.searchRemaining || '(limpo)');
    console.log('  -> Aba services ativa:', res4.servicesVisible);

    assert.strictEqual(res4.canonicalHash, '#services', 'Hash #services deve ter precedência sobre ?tab=appointments');
    assert.strictEqual(res4.searchRemaining.includes('tab='), false, 'Query param ?tab= deve ter sido removido');
    assert.strictEqual(res4.servicesVisible, true, 'Aba services deve estar aberta');
    assert.strictEqual(res4.appointmentsVisible, false, 'Aba appointments não deve estar aberta');

    // Executar reload real F5 para garantir persistência canônica
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    const t4_f5 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        return {
          hash: window.location.hash,
          search: window.location.search,
          servicesVisible: !document.getElementById('tab-services').classList.contains('hidden')
        };
      })()`,
      returnByValue: true
    });
    const res4_f5 = t4_f5.result.value;
    assert.strictEqual(res4_f5.hash, '#services', 'F5 subsequente deve permanecer em #services');
    assert.strictEqual(res4_f5.servicesVisible, true, 'Aba services continua visível após F5');
    console.log('  ✓ 4. Conflito entre query string e hash resolvido canonicamente via replaceState.\n');

    // =========================================================
    // TESTE 5: RETORNO OAUTH COM #tab-integrations-google
    // =========================================================
    console.log('[Teste 5] Retorno OAuth com prefixo #tab-integrations-google...');
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html#tab-integrations-google`
    });
    await new Promise(r => setTimeout(r, 1000));

    const t5 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        return {
          hash: window.location.hash,
          googleVisible: !document.getElementById('tab-integrations-google').classList.contains('hidden'),
          hubVisible: !document.getElementById('tab-my-products').classList.contains('hidden')
        };
      })()`,
      returnByValue: true
    });

    const res5 = t5.result.value;
    assert.strictEqual(res5.hash, '#integrations-google', 'Deve normalizar #tab-integrations-google para #integrations-google');
    assert.strictEqual(res5.googleVisible, true, 'Aba Google Calendar deve estar visível');
    assert.strictEqual(res5.hubVisible, false, 'Hub central deve estar oculto');
    console.log('  ✓ 5. Prefixo #tab-integrations-google normalizado para #integrations-google com sucesso.\n');

    // =========================================================
    // TESTE 6: LIMPEZA DOS PARÂMETROS TEMPORÁRIOS DO OAUTH
    // =========================================================
    console.log('[Teste 6] Limpeza dos parâmetros temporários OAuth pós-notificação...');
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html?google_connected=true&email=cliente.teste%40salao.com#tab-integrations-google`
    });
    await new Promise(r => setTimeout(r, 1200));

    const t6 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const toast = document.getElementById('toast');
        return {
          searchAfterInit: window.location.search,
          hashAfterInit: window.location.hash,
          toastVisible: !toast.classList.contains('hidden'),
          toastText: toast.textContent
        };
      })()`,
      returnByValue: true
    });

    const res6 = t6.result.value;
    console.log('  -> Query params após limpeza:', res6.searchAfterInit || '(vazio)');
    console.log('  -> Hash preservado:', res6.hashAfterInit);
    console.log('  -> Toast exibido:', res6.toastVisible);
    console.log('  -> Mensagem do toast:', res6.toastText.trim());

    assert.strictEqual(res6.searchAfterInit.includes('google_connected'), false, 'google_connected deve ser removido');
    assert.strictEqual(res6.searchAfterInit.includes('email'), false, 'email deve ser removido');
    assert.strictEqual(res6.hashAfterInit, '#integrations-google', 'Aba integrations-google deve ser mantida');
    assert.strictEqual(res6.toastText.includes('cliente.teste@salao.com'), true, 'Toast deve conter o email');

    // Simular reload F5: comprovar que toast não é repetido
    await sendCmd('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    const t6_f5 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const toast = document.getElementById('toast');
        return {
          searchAfterReload: window.location.search,
          toastHiddenAfterReload: toast.classList.contains('hidden')
        };
      })()`,
      returnByValue: true
    });
    const res6_f5 = t6_f5.result.value;
    assert.strictEqual(res6_f5.searchAfterReload, '', 'Query parameters devem permanecer vazios no reload');
    assert.strictEqual(res6_f5.toastHiddenAfterReload, true, 'Toast NÃO deve ser disparado novamente no reload');
    console.log('  ✓ 6. Parâmetros temporários do OAuth expurgados; F5 não repete notificação.\n');

    // =========================================================
    // TESTE 7: PREVENÇÃO DE XSS NAS NOTIFICAÇÕES (showToast)
    // =========================================================
    console.log('[Teste 7] Prevenção de XSS com payloads HTML em google_error e email...');
    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        window.__xss_executed = false;
        const xssPayload = '<img src="x" onerror="window.__xss_executed=true"><script>window.__xss_executed=true</script>';
        showToast(xssPayload, 'error');
      })()`
    });

    await new Promise(r => setTimeout(r, 100));

    const t7 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const toast = document.getElementById('toast');
        const span = toast.querySelector('span');
        const injectedImgs = toast.querySelectorAll('img');
        const injectedScripts = toast.querySelectorAll('script');

        return {
          xssExecuted: window.__xss_executed,
          spanText: span ? span.textContent : '',
          injectedImgsCount: injectedImgs.length,
          injectedScriptsCount: injectedScripts.length
        };
      })()`,
      returnByValue: true
    });

    const res7 = t7.result.value;
    console.log('  -> Script XSS executado:', res7.xssExecuted);
    console.log('  -> Elementos <img> injetados no toast:', res7.injectedImgsCount);
    console.log('  -> Elementos <script> injetados no toast:', res7.injectedScriptsCount);
    console.log('  -> Texto puro renderizado no span:', res7.spanText.slice(0, 45) + '...');

    assert.strictEqual(res7.xssExecuted, false, 'XSS JAMAIS deve ser executado');
    assert.strictEqual(res7.injectedImgsCount, 0, 'Nenhuma tag img deve existir no DOM do toast');
    assert.strictEqual(res7.injectedScriptsCount, 0, 'Nenhuma tag script deve existir no DOM do toast');
    assert.strictEqual(res7.spanText.includes('<img'), true, 'Conteúdo deve ser inserido estritamente como texto puro');
    console.log('  ✓ 7. Proteção anti-XSS comprovada: tags tratadas estritamente como texto sem execução.\n');

    // =========================================================
    // TESTE 8: ALTERNÂNCIA ENTRE USUÁRIOS SEM HERANÇA DE PREFERÊNCIAS
    // =========================================================
    console.log('[Teste 8] Alternância entre Usuário A e Usuário B sem herança de estado...');
    // Usuário A (ID 101) entra e navega para #appointments
    testState.currentUser = { id: 101, name: 'Usuário A', planTier: 'JESSICA_PRO', salon: { name: 'Salão A' } };
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html#appointments`
    });
    await new Promise(r => setTimeout(r, 1000));

    // Usuário A desloga
    await sendCmd('Runtime.evaluate', {
      expression: `document.getElementById('logoutBtn').click();`
    });
    await new Promise(r => setTimeout(r, 200));

    // Usuário B (ID 202) loga e acessa o painel com URL limpa (sem hash)
    testState.currentUser = { id: 202, name: 'Usuário B', planTier: 'JESSICA_PRO', salon: { name: 'Salão B' } };
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html`
    });
    await new Promise(r => setTimeout(r, 1000));

    const t8 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        return {
          userBTab: window.location.hash,
          userBHubVisible: !document.getElementById('tab-my-products').classList.contains('hidden'),
          userBAptVisible: !document.getElementById('tab-appointments').classList.contains('hidden'),
          legacyStorage: localStorage.getItem('raia_active_tab')
        };
      })()`,
      returnByValue: true
    });

    const res8 = t8.result.value;
    console.log('  -> Aba inicial do Usuário B:', res8.userBTab);
    console.log('  -> Hub visível para o Usuário B:', res8.userBHubVisible);
    console.log('  -> Aba appointments vazada para Usuário B:', res8.userBAptVisible);

    assert.strictEqual(res8.userBTab, '#my-products', 'Usuário B sem hash deve iniciar em #my-products');
    assert.strictEqual(res8.userBHubVisible, true, 'Hub central deve estar visível para o Usuário B');
    assert.strictEqual(res8.userBAptVisible, false, 'Usuário B NUNCA deve herdar a aba appointments do Usuário A');
    assert.strictEqual(res8.legacyStorage, null, 'Chave legada compartilhada deve permanecer nula');
    console.log('  ✓ 8. Isolamento entre contas comprovado: Usuário B não herda estado do Usuário A.\n');

    // =========================================================
    // TESTE 9: LOGOUT E LIMPEZA DE SESSÃO
    // =========================================================
    console.log('[Teste 9] Logout e limpeza de chaves isoladas...');
    testState.currentUser = { id: 303, name: 'Usuário C', planTier: 'JESSICA_PRO' };
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html#salon`
    });
    await new Promise(r => setTimeout(r, 1000));

    // Validar limpeza no storage e acionamento do botão logout
    const t9 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.getElementById('logoutBtn');
        if (btn) btn.click();
        return {
          legacyStorage: localStorage.getItem('raia_active_tab'),
          sessionUserStorage: sessionStorage.getItem('raia_active_tab_303')
        };
      })()`,
      returnByValue: true
    });

    // Aguardar conclusão da requisição de logout e redirecionamento para login
    await new Promise(r => setTimeout(r, 800));

    const res9 = t9.result.value;
    assert.strictEqual(res9.legacyStorage, null, 'Chave legada deve estar nula');
    assert.strictEqual(res9.sessionUserStorage, null, 'Chave de sessão do usuário deve estar nula');
    assert.strictEqual(testState.logoutCalls > 0, true, 'Endpoint /api/cliente/auth/logout deve ter sido chamado');
    console.log('  ✓ 9. Logout executado com limpeza completa de armazenamento e chamada à API.\n');

    // =========================================================
    // TESTE 10: FALHA DE AUTENTICAÇÃO SEM EXPOSIÇÃO DE TELAS INTERNAS
    // =========================================================
    console.log('[Teste 10] Falha de autenticação (401) sem exposição de dados...');
    testState.authStatus = 401; // Simular sessão expirada / não autorizada

    // Tentar acessar diretamente a URL interna de agendamentos deslogado
    await sendCmd('Page.navigate', {
      url: `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html#appointments`
    });

    let currentUrl = '';
    let aptHidden = true;
    let salonHidden = true;

    // Aguardar detecção do 401 e redirecionamento seguro ao login
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
    console.log('  -> Abas operacionais internas protegidas (ocultas):', aptHidden && salonHidden);

    assert.strictEqual(currentUrl.includes('/cliente/login'), true, 'Deve redirecionar para a página de login');
    assert.strictEqual(aptHidden, true, 'Aba appointments não deve ser exibida na falha de autenticação');
    assert.strictEqual(salonHidden, true, 'Aba salon não deve ser exibida na falha de autenticação');
    console.log('  ✓ 10. Falha de autenticação bloqueia exposição de dados e redireciona ao login com segurança.\n');

    // Fechar conexões
    ws.close();
    chrome.kill();
    await new Promise(res => httpServer.close(res));

    console.log('================================================================');
    console.log('   TODOS OS 10 TESTES DE HARDENING E NAVEGAÇÃO PASSARAM! (10/10)');
    console.log('================================================================\n');

  } catch (err) {
    if (ws) ws.close();
    chrome.kill();
    httpServer.close();
    console.error('\n❌ FALHA NOS TESTES DE HARDENING:', err);
    process.exit(1);
  }
}

runValidation();
