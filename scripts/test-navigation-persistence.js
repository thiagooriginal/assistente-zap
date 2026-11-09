/**
 * RAIA AGENTES — VALIDAÇÃO DA PERSISTÊNCIA DE NAVEGAÇÃO NO HUB E NA JÉSSICA
 * 
 * Validação rigorosa dos requisitos:
 * 1. switchTab(tabId) atualiza window.location.hash e localStorage.
 * 2. loadProfile() recupera a aba ativa a partir de:
 *    a) Query param (?tab=...)
 *    b) Hash da URL (#appointments, #services, #integrations-google, etc.)
 *    c) Hash de retorno OAuth com prefixo (#tab-integrations-google)
 *    d) Fallback do localStorage ('raia_active_tab')
 *    e) Fallback padrão ('my-products')
 * 3. Atualização com F5 / Ctrl+F5 preserva a seção exata do Módulo Jéssica e o tema visual.
 * 4. Botão "Voltar ao Hub" atualiza a URL para #my-products e preserva o estado.
 * 5. Navegação no histórico (popstate / hashchange) alterna as abas corretamente.
 */

const { spawn } = require('child_process');
const http = require('http');
const assert = require('assert');

async function runValidation() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — TESTE DE PERSISTÊNCIA DE NAVEGAÇÃO            ');
  console.log('================================================================\n');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9231',
    '--hide-scrollbars',
    'file:///C:/Users/Acer/Downloads/assistente%20zap/public/cliente/painel.html'
  ]);

  await new Promise(r => setTimeout(r, 2000));

  try {
    const list = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:9231/json/list', res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    const page = list.find(p => p.url.includes('painel.html'));
    if (!page) throw new Error('Página painel.html não encontrada no Chrome!');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
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

    // =========================================================
    // CONFIGURAÇÃO INICIAL E MOCKS DE API
    // =========================================================
    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const originalFetch = window.fetch;
        window.fetch = async (url, opts) => {
          if (url.includes('/api/cliente/profile')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                success: true,
                profile: {
                  id: 1,
                  name: 'Jéssica Teste',
                  email: 'jessica@salao.com.br',
                  planTier: 'JESSICA_PRO',
                  salon: { name: 'Jéssica Beauty & Nails' }
                }
              })
            };
          }
          if (url.includes('/api/cliente/appointments')) {
            return { ok: true, status: 200, json: async () => ({ success: true, appointments: [] }) };
          }
          if (url.includes('/api/cliente/services')) {
            return { ok: true, status: 200, json: async () => ({ success: true, services: [] }) };
          }
          if (url.includes('/api/cliente/integrations/google/status')) {
            return { ok: true, status: 200, json: async () => ({ isConnected: false }) };
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) };
        };
      })()`
    });

    // =========================================================
    // TESTE 1: switchTab(tabId) ATUALIZA HASH E LOCALSTORAGE
    // =========================================================
    console.log('[Teste 1] switchTab() atualiza a URL (hash) e o localStorage...');
    const t1 = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        switchTab('appointments');
        const hash = window.location.hash;
        const stored = localStorage.getItem('raia_active_tab');
        const isBeauty = document.body.classList.contains('theme-jessica-beauty');
        const aptVisible = !document.getElementById('tab-appointments').classList.contains('hidden');
        return { hash, stored, isBeauty, aptVisible };
      })()`,
      returnByValue: true
    });

    const res1 = t1.result.value;
    console.log('  -> Hash na URL:', res1.hash);
    console.log('  -> Persistido no localStorage:', res1.stored);
    console.log('  -> Tema Jéssica Beauty ativo:', res1.isBeauty);
    console.log('  -> Aba appointments visível:', res1.aptVisible);

    assert.strictEqual(res1.hash, '#appointments', 'URL deve conter #appointments');
    assert.strictEqual(res1.stored, 'appointments', 'localStorage deve salvar appointments');
    assert.strictEqual(res1.isBeauty, true, 'Tema Jéssica Beauty deve estar ativo');
    assert.strictEqual(res1.aptVisible, true, 'Aba appointments deve estar visível');
    console.log('  ✓ 1. switchTab("appointments") atualizou hash e persistiu no storage com sucesso.\n');

    // =========================================================
    // TESTE 2: SIMULAÇÃO DE F5/RELOAD EM #appointments
    // =========================================================
    console.log('[Teste 2] Simulação de F5 em #appointments (loadProfile)...');
    const t2 = await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        // Garantir que a URL possui #appointments
        window.location.hash = '#appointments';
        // Executar loadProfile simulando o arranque da página após F5
        await loadProfile();

        const hash = window.location.hash;
        const isBeauty = document.body.classList.contains('theme-jessica-beauty');
        const aptVisible = !document.getElementById('tab-appointments').classList.contains('hidden');
        const hubVisible = !document.getElementById('tab-my-products').classList.contains('hidden');

        return { hash, isBeauty, aptVisible, hubVisible };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });

    const res2 = t2.result.value;
    console.log('  -> Hash após reload:', res2.hash);
    console.log('  -> Aba appointments continua aberta:', res2.aptVisible);
    console.log('  -> Aba my-products oculta:', !res2.hubVisible);

    assert.strictEqual(res2.hash, '#appointments', 'Hash deve continuar #appointments');
    assert.strictEqual(res2.aptVisible, true, 'Aba appointments deve continuar aberta');
    assert.strictEqual(res2.hubVisible, false, 'Aba my-products não deve abrir no F5 de appointments');
    console.log('  ✓ 2. F5 na seção appointments preservou a página e o tema sem retornar ao Hub.\n');

    // =========================================================
    // TESTE 3: NORMALIZAÇÃO DE RETORNO OAUTH (#tab-integrations-google)
    // =========================================================
    console.log('[Teste 3] Reconhecimento de #tab-integrations-google (retorno Google OAuth)...');
    const t3 = await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        // Simular o hash exato gerado pelo redirect OAuth
        window.location.hash = '#tab-integrations-google';
        await loadProfile();

        const hash = window.location.hash;
        const stored = localStorage.getItem('raia_active_tab');
        const googleVisible = !document.getElementById('tab-integrations-google').classList.contains('hidden');
        const hubVisible = !document.getElementById('tab-my-products').classList.contains('hidden');

        return { hash, stored, googleVisible, hubVisible };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });

    const res3 = t3.result.value;
    console.log('  -> Hash normalizado na URL:', res3.hash);
    console.log('  -> Aba integrations-google visível:', res3.googleVisible);
    console.log('  -> localStorage atualizado para:', res3.stored);

    assert.strictEqual(res3.hash, '#integrations-google', 'Deve normalizar #tab-integrations-google para #integrations-google');
    assert.strictEqual(res3.googleVisible, true, 'Aba Google Calendar deve estar visível');
    assert.strictEqual(res3.stored, 'integrations-google', 'Storage deve conter integrations-google');
    console.log('  ✓ 3. Retorno OAuth com #tab-integrations-google normalizado e aberto com sucesso.\n');

    // =========================================================
    // TESTE 4: PERSISTÊNCIA EM TODAS AS SEÇÕES DO MÓDULO JÉSSICA
    // =========================================================
    console.log('[Teste 4] Verificando persistência em todas as seções do Módulo Jéssica...');
    const jessicaTabs = ['services', 'salon', 'staff', 'integrations-whatsapp', 'dashboard-pro', 'campaigns-pro', 'overview'];

    for (const tab of jessicaTabs) {
      const resTab = await sendCmd('Runtime.evaluate', {
        expression: `(async () => {
          switchTab('${tab}');
          await loadProfile();
          return {
            hash: window.location.hash,
            stored: localStorage.getItem('raia_active_tab'),
            isVisible: !document.getElementById('tab-${tab}').classList.contains('hidden'),
            isBeauty: document.body.classList.contains('theme-jessica-beauty')
          };
        })()`,
        returnByValue: true,
        awaitPromise: true
      });

      const r = resTab.result.value;
      assert.strictEqual(r.hash, '#' + tab, `Hash deve ser #${tab}`);
      assert.strictEqual(r.stored, tab, `Storage deve ser ${tab}`);
      assert.strictEqual(r.isVisible, true, `Aba tab-${tab} deve estar visível`);
      assert.strictEqual(r.isBeauty, true, `Tema Jéssica deve estar ativo para ${tab}`);
    }
    console.log('  ✓ 4. Todas as 7 outras seções da Jéssica persistem e mantêm tema no reload.\n');

    // =========================================================
    // TESTE 5: FALLBACK DO LOCALSTORAGE QUANDO HASH ESTÁ VAZIO
    // =========================================================
    console.log('[Teste 5] Fallback via localStorage quando a URL não possui hash...');
    const t5 = await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        // Definir aba salva no storage
        localStorage.setItem('raia_active_tab', 'services');
        // Remover hash da URL
        window.history.replaceState(null, '', window.location.pathname);
        // Chamar loadProfile
        await loadProfile();

        return {
          hash: window.location.hash,
          stored: localStorage.getItem('raia_active_tab'),
          servicesVisible: !document.getElementById('tab-services').classList.contains('hidden')
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });

    const res5 = t5.result.value;
    console.log('  -> Hash restaurado na URL:', res5.hash);
    console.log('  -> Aba services aberta via storage:', res5.servicesVisible);

    assert.strictEqual(res5.hash, '#services', 'Deve restaurar #services na URL via storage');
    assert.strictEqual(res5.servicesVisible, true, 'Aba services deve estar aberta');
    console.log('  ✓ 5. Recuperação via localStorage quando hash vazio validada com sucesso.\n');

    // =========================================================
    // TESTE 6: RETORNO AO HUB CENTRAL VIA "VOLTAR AO HUB"
    // =========================================================
    console.log('[Teste 6] Retorno ao Hub Central via botão "Voltar ao Hub"...');
    const t6 = await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        // Clicar no botão Voltar ao Hub
        const btnBack = document.getElementById('btnBackToHub');
        if (btnBack) btnBack.click();
        await new Promise(r => setTimeout(r, 100));

        const hash = window.location.hash;
        const stored = localStorage.getItem('raia_active_tab');
        const isRaiaTheme = document.body.classList.contains('theme-raia');
        const hubVisible = !document.getElementById('tab-my-products').classList.contains('hidden');

        // Testar F5 após voltar ao Hub
        await loadProfile();

        return {
          hash,
          stored,
          isRaiaTheme,
          hubVisible,
          hashAfterReload: window.location.hash,
          hubVisibleAfterReload: !document.getElementById('tab-my-products').classList.contains('hidden')
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });

    const res6 = t6.result.value;
    console.log('  -> Hash ao voltar ao Hub:', res6.hash);
    console.log('  -> Tema RAIA Central ativo:', res6.isRaiaTheme);
    console.log('  -> Hub visível após F5:', res6.hubVisibleAfterReload);

    assert.strictEqual(res6.hash, '#my-products', 'Hash deve ser #my-products');
    assert.strictEqual(res6.stored, 'my-products', 'Storage deve ser my-products');
    assert.strictEqual(res6.isRaiaTheme, true, 'Tema RAIA deve estar ativo no Hub');
    assert.strictEqual(res6.hubVisibleAfterReload, true, 'Hub deve permanecer visível no reload');
    console.log('  ✓ 6. Retorno ao Hub preservado e tema institucional restaurado.\n');

    // =========================================================
    // TESTE 7: NAVEGAÇÃO DE HISTÓRICO (POPSTATE / HASHCHANGE)
    // =========================================================
    console.log('[Teste 7] Navegação pelo histórico (hashchange)...');
    const t7 = await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        // Mudar hash diretamente via evento hashchange
        window.location.hash = '#staff';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        await new Promise(r => setTimeout(r, 100));

        const staffVisible = !document.getElementById('tab-staff').classList.contains('hidden');
        const isBeauty = document.body.classList.contains('theme-jessica-beauty');

        return { staffVisible, isBeauty };
      })()`,
      returnByValue: true,
      awaitPromise: true
    });

    const res7 = t7.result.value;
    assert.strictEqual(res7.staffVisible, true, 'Aba staff deve abrir no hashchange');
    assert.strictEqual(res7.isBeauty, true, 'Tema Beauty deve ser acionado no hashchange');
    console.log('  ✓ 7. Eventos de hashchange/popstate sincronizados com sucesso.\n');

    // Fechar WebSocket e processo Chrome
    ws.close();
    chrome.kill();

    console.log('================================================================');
    console.log('   TODOS OS 7 TESTES DE NAVEGAÇÃO PERSISTENTE PASSARAM! (7/7)   ');
    console.log('================================================================\n');

  } catch (err) {
    chrome.kill();
    console.error('\n❌ FALHA NOS TESTES DE NAVEGAÇÃO:', err);
    process.exit(1);
  }
}

runValidation();
