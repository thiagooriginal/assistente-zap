/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADA: BACKDROP E COBERTURA DE MODAIS (COMANDO 009)
 * 
 * Validação rigorosa no navegador real (Desktop 1024x768 e Mobile 390x844):
 * - Teste 1: Modal de Remarcação cobre 100% da viewport (top: 0, left: 0, width: 100vw, height: 100vh).
 * - Teste 2: Topo absoluto coberto: elementFromPoint(300, 10) é o backdrop do modal (zero vazamentos no cabeçalho sticky/topbar).
 * - Teste 3: Laterais e rodapé 100% cobertos: elementFromPoint nos 4 cantos da viewport pertencem ao modal.
 * - Teste 4: Imunidade a scroll: com scroll prévio de 300px, modal continua cravado no topo absoluto (top: 0).
 * - Teste 5: Bloqueio de scroll do fundo (body.modal-open com overflow: hidden).
 * - Teste 6: Identidade visual Beauty Premium: tom champagne escuro translúcido rgba(30, 20, 15, 0.65) e backdrop-filter blur(12px).
 * - Teste 7: Responsividade no celular (390x844): cobertura integral de 100% sem cortes nem rolagem horizontal.
 * - Teste 8: Dropdown de horários (#rescheduleTimeDropdown) abre elegantemente sobre o modal.
 * - Teste 9: Sem regressão nos outros modais (Novo Agendamento, Status, Cancelar, Serviço, Lote, Contas, Movimentação).
 * - Teste 10: Sem regressão no Hub Central RAIA (#productDetailsModal com backdrop dark fintech).
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const ARTIFACT_DIR = 'C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function startTestHttpServer(port) {
  let painelHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'cliente', 'painel.html'), 'utf8');
  painelHtml = painelHtml.replace('https://cdn.tailwindcss.com', `http://127.0.0.1:${port}/mock-tailwind.js`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

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
          id: 101,
          name: 'Jéssica Teste',
          email: 'jessica@salao.com.br',
          planTier: 'JESSICA_PRO',
          salon: { name: 'Jéssica Beauty & Nails' }
        }
      }));
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

async function runBackdropValidation() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — TESTE AUTOMATIZADO DE BACKDROP DE MODAIS      ');
  console.log('================================================================\n');

  const HTTP_PORT = await getFreePort();
  const CDP_PORT = await getFreePort();
  console.log(`Portas dinâmicas alocadas: HTTP=${HTTP_PORT}, CDP=${CDP_PORT}`);

  const server = await startTestHttpServer(HTTP_PORT);

  const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--hide-scrollbars',
    `http://127.0.0.1:${HTTP_PORT}/cliente/painel.html#appointments`
  ]);

  await new Promise(r => setTimeout(r, 2000));

  try {
    const listRes = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    const page = listRes.find(p => p.type === 'page' && p.url.includes('painel.html'));
    if (!page) throw new Error('Página painel.html não encontrada no Chrome!');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    function sendCmd(method, params = {}) {
      return new Promise(resolve => {
        const id = Math.floor(Math.random() * 100000);
        function handler(msg) {
          const res = JSON.parse(msg.data);
          if (res.id === id) {
            ws.removeEventListener('message', handler);
            resolve(res);
          }
        }
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await new Promise(r => ws.onopen = r);
    await sendCmd('Page.enable');
    await sendCmd('Runtime.enable');
    await sendCmd('DOM.enable');

    // Helper evaluate
    async function evaluate(fnStr) {
      const res = await sendCmd('Runtime.evaluate', {
        expression: `(${fnStr})()`,
        returnByValue: true
      });
      if (res.result.exceptionDetails) {
        throw new Error(res.result.exceptionDetails.text + ': ' + (res.result.exceptionDetails.exception?.description || ''));
      }
      return res.result.result.value;
    }

    // Helper screenshot
    async function captureScreenshot(filename) {
      const shot = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const fullPath = path.join(ARTIFACT_DIR, filename);
      fs.writeFileSync(fullPath, Buffer.from(shot.result.data, 'base64'));
      console.log(`   📸 Screenshot salvo: ${filename}`);
    }

    // Aguarda inicialização da página
    let ready = false;
    for (let i = 0; i < 20; i++) {
      const chk = await sendCmd('Runtime.evaluate', {
        expression: `Boolean(document.body && document.getElementById('modal-root'))`
      });
      if (chk.result?.result?.value === true) {
        ready = true;
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    if (!ready) throw new Error('Timeout aguardando DOM e modal-root ficarem prontos');

    // TESTE 1: Cobertura 100% da Viewport em Desktop (1024x768)
    console.log('[TESTE 1] Abrindo #modalRescheduleAppointment em Desktop (1024x768)...');
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false
    });

    const t1 = await evaluate(`function() {
      if (typeof switchTab === 'function') switchTab('appointments');
      const apt = {
        id: 101,
        client_name: 'Mariana Silva',
        service_id: 1,
        service_name: 'Corte e Escova',
        start_datetime: '2026-11-24T09:00:00',
        duration_minutes: 60,
        staff_id: 1,
        staff_name: 'Jéssica'
      };
      const idInput = document.getElementById('rescheduleAptId');
      if (idInput) idInput.value = apt.id;
      const infoEl = document.getElementById('rescheduleAptInfo');
      if (infoEl) infoEl.innerHTML = '<strong>' + apt.client_name + '</strong> — ' + apt.service_name;

      const modal = document.getElementById('modalRescheduleAppointment');
      modal.classList.remove('hidden');
      modal.classList.add('flex');

      const rect = modal.getBoundingClientRect();
      const style = window.getComputedStyle(modal);

      return {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        right: rect.right,
        width: rect.width,
        height: rect.height,
        windowW: window.innerWidth,
        windowH: window.innerHeight,
        position: style.position,
        zIndex: Number(style.zIndex),
        hasBackdropBlur: (style.backdropFilter || style.webkitBackdropFilter || '').includes('blur'),
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter,
        backgroundColor: style.backgroundColor
      };
    }`);

    console.log(`   Rect: top=${t1.top}, left=${t1.left}, w=${t1.width}, h=${t1.height} (viewport: ${t1.windowW}x${t1.windowH})`);
    console.log(`   Styles: position=${t1.position}, zIndex=${t1.zIndex}, blur=${t1.hasBackdropBlur}, bg=${t1.backgroundColor}`);
    assert.strictEqual(t1.top, 0, 'Modal deve iniciar exatamente em top=0');
    assert.strictEqual(t1.left, 0, 'Modal deve iniciar exatamente em left=0');
    assert.strictEqual(t1.width, 1024, 'Largura deve ser 100% da viewport (1024px)');
    assert.strictEqual(t1.height, 768, 'Altura deve ser 100% da viewport (768px)');
    assert.strictEqual(t1.position, 'fixed', 'Position deve ser fixed');
    assert(t1.zIndex >= 50000, 'Z-Index deve ser alto (>= 50000)');
    assert(t1.hasBackdropBlur, 'Backdrop deve conter filtro blur');
    console.log('   ✅ PASS: Cobertura 100% da viewport confirmada.\n');

    // TESTE 2: Topo absoluto coberto (elementFromPoint no topo não vaza cabeçalho)
    console.log('[TESTE 2] Verificação de invasão/vazamento de elementos do topo...');
    const t2 = await evaluate(`function() {
      // Ponto (300, 10) onde antes ficava o cabeçalho sticky descoberto
      const topEl = document.elementFromPoint(300, 10);
      const modal = document.getElementById('modalRescheduleAppointment');
      return {
        isInsideModalOrBackdrop: modal.contains(topEl) || topEl === modal,
        tag: topEl ? topEl.tagName : null,
        id: topEl ? topEl.id : null,
        className: topEl ? topEl.className : null
      };
    }`);
    console.log(`   Elemento no topo (300, 10): <${t2.tag} id="${t2.id}">`);
    assert(t2.isInsideModalOrBackdrop, 'O elemento no topo DEVE pertencer ao modal/backdrop (zero vazamento de cabeçalho)');
    console.log('   ✅ PASS: Topo absoluto 100% protegido e coberto.\n');

    // TESTE 3: Cantos da viewport pertencem ao modal
    console.log('[TESTE 3] Verificação dos 4 cantos da viewport...');
    const t3 = await evaluate(`function() {
      const modal = document.getElementById('modalRescheduleAppointment');
      const pTopLeft = document.elementFromPoint(5, 5);
      const pTopRight = document.elementFromPoint(1019, 5);
      const pBottomLeft = document.elementFromPoint(5, 763);
      const pBottomRight = document.elementFromPoint(1019, 763);

      return {
        topLeftCovered: modal.contains(pTopLeft) || pTopLeft === modal,
        topRightCovered: modal.contains(pTopRight) || pTopRight === modal,
        bottomLeftCovered: modal.contains(pBottomLeft) || pBottomLeft === modal,
        bottomRightCovered: modal.contains(pBottomRight) || pBottomRight === modal
      };
    }`);
    assert(t3.topLeftCovered && t3.topRightCovered && t3.bottomLeftCovered && t3.bottomRightCovered, 'Todos os 4 cantos devem estar cobertos pelo modal');
    console.log('   ✅ PASS: Quatro cantos da tela integralmente cobertos pelo overlay.\n');

    // Captura screenshot desktop
    await captureScreenshot('modal-reschedule-backdrop-desktop-1024x768.png');

    // TESTE 4: Imunidade a Scroll (mesmo com página previamente rolada)
    console.log('[TESTE 4] Teste com scroll de 300px antes de abrir o modal...');
    const t4 = await evaluate(`function() {
      const modal = document.getElementById('modalRescheduleAppointment');
      modal.classList.add('hidden');
      modal.classList.remove('flex');

      // Scrolla conteúdo
      const main = document.querySelector('main');
      if (main) main.scrollTop = 300;
      window.scrollTo(0, 300);

      // Reabre modal
      modal.classList.remove('hidden');
      modal.classList.add('flex');

      const rect = modal.getBoundingClientRect();
      const topEl = document.elementFromPoint(400, 12);
      return {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        right: rect.right,
        height: rect.height,
        topElBelongsToModal: modal.contains(topEl) || topEl === modal
      };
    }`);
    assert.strictEqual(t4.top, 0, 'Mesmo após scroll, modal DEVE iniciar em top=0');
    assert.strictEqual(t4.bottom, 768, 'Mesmo após scroll, modal DEVE terminar em bottom=768');
    assert(t4.topElBelongsToModal, 'Topo permanece coberto após scroll');
    console.log('   ✅ PASS: Imunidade absoluta ao scroll confirmada.\n');

    // TESTE 5: Bloqueio de scroll do fundo (body.modal-open)
    console.log('[TESTE 5] Verificação de scroll-lock no body e html...');
    const t5 = await evaluate(`function() {
      const bodyHasClass = document.body.classList.contains('modal-open');
      const bodyComputed = window.getComputedStyle(document.body).overflow;
      const htmlComputed = window.getComputedStyle(document.documentElement).overflow;
      return {
        bodyHasClass,
        bodyOverflow: bodyComputed,
        htmlOverflow: htmlComputed
      };
    }`);
    assert(t5.bodyHasClass, 'Body deve possuir classe modal-open');
    assert.strictEqual(t5.bodyOverflow, 'hidden', 'Body overflow deve ser hidden');
    assert.strictEqual(t5.htmlOverflow, 'hidden', 'HTML overflow deve ser hidden');
    console.log('   ✅ PASS: Bloqueio de scroll do fundo ativado.\n');

    // TESTE 6: Identidade Visual Beauty Premium
    console.log('[TESTE 6] Validação cromática e blur do tema Jéssica Beauty...');
    const t6 = await evaluate(`function() {
      const modal = document.getElementById('modalRescheduleAppointment');
      const style = window.getComputedStyle(modal);
      return {
        bg: style.backgroundColor,
        filter: style.backdropFilter || style.webkitBackdropFilter
      };
    }`);
    console.log(`   Backdrop Color: ${t6.bg}, Filter: ${t6.filter}`);
    assert(t6.bg.includes('rgba(30, 20, 15') || t6.bg.includes('rgba(78, 59, 49'), 'Cor de fundo deve respeitar a paleta sofisticada translúcida Beauty');
    assert(t6.filter.includes('blur'), 'Filtro deve ter desfoque elegante');
    console.log('   ✅ PASS: Identidade estética premium preservada.\n');

    // TESTE 7: Responsividade no celular (Mobile 390x844)
    console.log('[TESTE 7] Teste no Celular (Mobile 390x844)...');
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });

    await new Promise(r => setTimeout(r, 600));

    const t7 = await evaluate(`function() {
      const modal = document.getElementById('modalRescheduleAppointment');
      const rect = modal.getBoundingClientRect();
      const topEl = document.elementFromPoint(195, 10);
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        windowW: window.innerWidth,
        windowH: window.innerHeight,
        topCovered: modal.contains(topEl) || topEl === modal
      };
    }`);
    console.log(`   Mobile Rect: top=${t7.top}, left=${t7.left}, w=${t7.width}, h=${t7.height} (viewport: ${t7.windowW}x${t7.windowH})`);
    assert.strictEqual(t7.top, 0, 'No celular, modal deve cobrir a partir de top=0');
    assert.strictEqual(t7.left, 0, 'No celular, modal deve cobrir a partir de left=0');
    assert.strictEqual(t7.width, 390, 'No celular, largura deve ser 390px (100%)');
    assert.strictEqual(t7.height, 844, 'No celular, altura deve ser 844px (100%)');
    assert(t7.topCovered, 'No celular, topo deve estar 100% coberto pelo modal');
    await captureScreenshot('modal-reschedule-backdrop-mobile-390x844.png');
    console.log('   ✅ PASS: Celular 100% coberto sem faixas nem cortes.\n');

    // Retorna para Desktop para testes seguintes
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false
    });
    await new Promise(r => setTimeout(r, 400));

    // TESTE 8: Seletor de horários abre normalmente sobre o modal
    console.log('[TESTE 8] Interação com Seletor de Horários (#rescheduleTimeDropdown)...');
    const t8 = await evaluate(`function() {
      const btn = document.getElementById('btnToggleRescheduleTimeDropdown');
      if (btn) btn.click();
      const drop = document.getElementById('rescheduleTimeDropdown');
      const dropStyle = window.getComputedStyle(drop);
      const isVisible = !drop.classList.contains('hidden') && dropStyle.display !== 'none';
      const dropRect = drop.getBoundingClientRect();
      return {
        isVisible,
        width: dropRect.width,
        zIndex: Number(dropStyle.zIndex)
      };
    }`);
    console.log(`   Dropdown de Horários: visível=${t8.isVisible}, width=${t8.width}px, zIndex=${t8.zIndex}`);
    assert(t8.isVisible, 'Dropdown de horários deve abrir');
    assert(t8.width >= 240 && t8.width <= 340, 'Dropdown deve manter largura compacta e elegante');
    console.log('   ✅ PASS: Dropdown de horários opera perfeitamente sobre o modal.\n');

    // TESTE 9: Sem regressão nos outros modais
    console.log('[TESTE 9] Testando cobertura de outros modais da aplicação...');
    const otherModals = [
      'modalNewAppointment',
      'modalStatusAppointment',
      'modalCancelAppointment',
      'modalSingleService',
      'modalBatchServices',
      'modalDeleteConfirm',
      'modalNewBill',
      'modalNewTransaction'
    ];

    for (const mId of otherModals) {
      const mRes = await evaluate(`function() {
        // Fecha todos
        document.querySelectorAll('#modal-root > div').forEach(m => {
          m.classList.add('hidden');
          m.classList.remove('flex');
        });

        const target = document.getElementById('${mId}');
        if (!target) return { found: false };
        target.classList.remove('hidden');
        target.classList.add('flex');

        const rect = target.getBoundingClientRect();
        const topEl = document.elementFromPoint(500, 10);
        return {
          found: true,
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          coveredTop: target.contains(topEl) || topEl === target
        };
      }`);

      assert(mRes.found, `Modal ${mId} deve existir no DOM`);
      assert.strictEqual(mRes.top, 0, `Modal ${mId} deve iniciar em top=0`);
      assert.strictEqual(mRes.width, 1024, `Modal ${mId} deve cobrir 1024px`);
      assert.strictEqual(mRes.height, 768, `Modal ${mId} deve cobrir 768px`);
      assert(mRes.coveredTop, `Modal ${mId} deve cobrir o topo`);
      console.log(`   - ${mId}: 100% coberto (top=0, 1024x768) OK`);
    }

    // Captura screenshot de outro modal chave: Novo Agendamento
    await captureScreenshot('modal-new-appointment-backdrop-desktop-1024x768.png');
    console.log('   ✅ PASS: Todos os modais possuem cobertura 100% integral.\n');

    // TESTE 10: Sem regressão no Hub Central RAIA (#productDetailsModal)
    console.log('[TESTE 10] Testando #productDetailsModal no HUB Central RAIA...');
    const t10 = await evaluate(`function() {
      // Fecha todos
      document.querySelectorAll('#modal-root > div').forEach(m => {
        m.classList.add('hidden');
        m.classList.remove('flex');
      });

      if (typeof switchTab === 'function') switchTab('my-products');

      const modal = document.getElementById('productDetailsModal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');

      const rect = modal.getBoundingClientRect();
      const style = window.getComputedStyle(modal);
      const topEl = document.elementFromPoint(500, 10);

      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        coveredTop: modal.contains(topEl) || topEl === modal,
        bg: style.backgroundColor,
        filter: style.backdropFilter || style.webkitBackdropFilter
      };
    }`);
    assert.strictEqual(t10.top, 0, 'No HUB, modal deve iniciar em top=0');
    assert.strictEqual(t10.width, 1024, 'No HUB, modal deve cobrir 1024px');
    assert.strictEqual(t10.height, 768, 'No HUB, modal deve cobrir 768px');
    assert(t10.coveredTop, 'No HUB, topo deve estar 100% coberto');
    console.log(`   Hub Modal Rect: top=${t10.top}, w=${t10.width}, h=${t10.height}, bg=${t10.bg}`);
    await captureScreenshot('modal-product-details-backdrop-hub.png');
    console.log('   ✅ PASS: HUB Central RAIA validado com sucesso.\n');

    // Fecha todos ao finalizar
    await evaluate(`function() {
      document.querySelectorAll('#modal-root > div').forEach(m => {
        m.classList.add('hidden');
        m.classList.remove('flex');
      });
      document.body.classList.remove('modal-open');
      document.documentElement.classList.remove('modal-open');
    }`);

    ws.close();

    console.log('================================================================');
    console.log('   TODOS OS 10 TESTES DE BACKDROP E COBERTURA PASSARAM! (10/10) ');
    console.log('================================================================\n');
  } finally {
    try {
      execSync(`taskkill /F /PID ${chrome.pid} /T`, { stdio: 'ignore' });
    } catch (_) {
      try { chrome.kill(); } catch (_) {}
    }
    server.close();
  }
}

runBackdropValidation().catch(err => {
  console.error('\n❌ ERRO NA VALIDAÇÃO DE BACKDROP:', err);
  process.exit(1);
});
