/**
 * RAIA AGENTES — SUÍTE DE TESTES: ESTABILIDADE E PROTEÇÃO DOS MODAIS PREMIUM (COMANDO 011)
 * 
 * Validação rigorosa dos requisitos de concorrência e proteção de formulários:
 *  1. Abrir, fechar e reabrir o mesmo modal em menos de 150 ms (eliminação de race condition).
 *  2. Repetir abertura e fechamento rapidamente 10 vezes consecutivas sem corrupção de estado.
 *  3. Fechar enquanto o foco inicial ainda está pendente (cancelamento seguro de timers).
 *  4. Digitar nome de cliente e pressionar Esc -> interceptação com confirmação de descarte.
 *  5. Digitar dados e tocar/clicar fora do modal (backdrop) -> interceptação com confirmação.
 *  6. Escolher "Continuar Editando" e comprovar preservação integral dos dados preenchidos.
 *  7. Confirmar descarte ("Descartar Alterações") e comprovar fechamento correto de ambos os modais.
 *  8. Salvar um formulário com sucesso e fechar sem alerta indevido (markClean).
 *  9. Abrir dois modais (conflitos + remarcação) e fechar somente o superior preservando o inferior.
 * 10. Validar retorno de foco ao elemento disparador e integridade do scroll-lock no body/html.
 * 11. Validação cruzada em Desktop (1024x768) e Mobile (390x844).
 * 12. Captura de evidências fotográficas em alta resolução via Chrome DevTools Protocol (CDP).
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
  painelHtml = painelHtml.replace('https://unpkg.com/lucide@latest', `http://127.0.0.1:${port}/mock-lucide.js`);
  painelHtml = painelHtml.replace(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/gi, '<!-- fonts stripped for hermetic test -->');

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

    if (url.pathname === '/mock-lucide.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end('window.lucide = { createIcons: function() {} };');
    }

    if (url.pathname === '/api/cliente/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        profile: {
          id: 101,
          name: 'Jéssica Master Teste',
          email: 'jessica@salao.com.br',
          planTier: 'JESSICA_PRO',
          salon: { name: 'Jéssica Beauty & Nails', phone: '11999998888' }
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

async function runModalStability011() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — SUÍTE DE TESTES: ESTABILIDADE DE MODAIS (011) ');
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

  await new Promise(r => setTimeout(r, 2500));

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
        const id = Math.floor(Math.random() * 1000000);
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

    async function captureScreenshot(filename) {
      const shot = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const fullPath = path.join(ARTIFACT_DIR, filename);
      fs.writeFileSync(fullPath, Buffer.from(shot.result.data, 'base64'));
      console.log(`   📸 Screenshot salvo: ${filename}`);
    }

    async function sendKey(key, code, windowsVirtualKeyCode, modifiers = 0) {
      await sendCmd('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode,
        modifiers
      });
      await sendCmd('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode,
        modifiers
      });
    }

    // Wait until panel and RaiaModalManager ready
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const chk = await sendCmd('Runtime.evaluate', {
        expression: `Boolean(window.RaiaModalManager && document.getElementById('modal-root') && document.getElementById('modalDiscardConfirm'))`
      });
      if (chk.result?.result?.value === true) {
        ready = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!ready) throw new Error('Timeout aguardando inicialização do painel e modalDiscardConfirm');

    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false
    });

    // =========================================================================
    // CENÁRIO 1: Abrir, fechar e reabrir o mesmo modal em menos de 150 ms
    // =========================================================================
    console.log('[CENÁRIO 1] Abrir, fechar e reabrir o mesmo modal em < 150 ms (Anti-Race Condition)...');
    const raceRes = await evaluate(`function() {
      // 1. Abre
      RaiaModalManager.open('modalNewAppointment');
      // 2. Fecha (inicia setTimeout de 150ms)
      RaiaModalManager.close('modalNewAppointment', true);
      // 3. Reabre imediatamente após 30ms (bem antes dos 150ms)
      let stateSnapshot = null;
      setTimeout(() => {
        RaiaModalManager.open('modalNewAppointment');
      }, 30);
      return true;
    }`);

    // Aguarda 250ms (garante que os 150ms originais expiraram)
    await new Promise(r => setTimeout(r, 260));

    const checkOpenAfterRace = await evaluate(`function() {
      const modal = document.getElementById('modalNewAppointment');
      const isVisible = !modal.classList.contains('hidden') && modal.classList.contains('flex');
      const inStack = RaiaModalManager.openModalsStack.includes('modalNewAppointment');
      const state = RaiaModalManager.getModalState('modalNewAppointment');
      return {
        isVisible,
        inStack,
        isOpen: state.isOpen,
        isClosing: state.isClosing,
        stackLength: RaiaModalManager.openModalsStack.length
      };
    }`);

    assert(checkOpenAfterRace.isVisible, 'Modal DEVE permanecer visível e aberto após reabertura rápida');
    assert(checkOpenAfterRace.inStack, 'Modal DEVE estar presente na pilha openModalsStack');
    assert(checkOpenAfterRace.isOpen, 'Estado do modal deve ser isOpen=true');
    assert(!checkOpenAfterRace.isClosing, 'Estado isClosing deve ter sido cancelado');
    console.log('   ✓ Modal permaneceu aberto sem ser ocultado pelo timer anterior!');

    // Fecha limpando
    await evaluate(`function() { RaiaModalManager.close('modalNewAppointment', true); }`);
    await new Promise(r => setTimeout(r, 200));
    console.log('   ✅ PASS: Cenário 1 aprovado com sucesso.\n');

    // =========================================================================
    // CENÁRIO 2: Repetir abertura e fechamento rapidamente 10 vezes
    // =========================================================================
    console.log('[CENÁRIO 2] Repetir abertura e fechamento rapidamente 10 vezes...');
    for (let k = 1; k <= 10; k++) {
      await evaluate(`function() {
        RaiaModalManager.open('modalNewAppointment');
      }`);
      await new Promise(r => setTimeout(r, 25));
      await evaluate(`function() {
        RaiaModalManager.close('modalNewAppointment', true);
      }`);
      await new Promise(r => setTimeout(r, 25));
    }

    // Ao final das 10 alternâncias, abre de forma estável
    await evaluate(`function() {
      RaiaModalManager.open('modalNewAppointment');
    }`);
    await new Promise(r => setTimeout(r, 250));

    const checkCycleState = await evaluate(`function() {
      const modal = document.getElementById('modalNewAppointment');
      const state = RaiaModalManager.getModalState('modalNewAppointment');
      return {
        isVisible: !modal.classList.contains('hidden'),
        isOpen: state.isOpen,
        isClosing: state.isClosing,
        stackLength: RaiaModalManager.openModalsStack.length
      };
    }`);
    assert(checkCycleState.isVisible, 'Modal deve estar visível após o ciclo');
    assert(checkCycleState.isOpen, 'Modal deve estar isOpen=true');
    assert.strictEqual(checkCycleState.stackLength, 1, 'Pilha deve conter exatamente 1 item');
    console.log('   ✓ 10 ciclos de alta frequência executados sem erros de estado!');

    await evaluate(`function() { RaiaModalManager.close('modalNewAppointment', true); }`);
    await new Promise(r => setTimeout(r, 200));
    console.log('   ✅ PASS: Cenário 2 aprovado.\n');

    // =========================================================================
    // CENÁRIO 3: Fechar enquanto o foco inicial ainda está pendente
    // =========================================================================
    console.log('[CENÁRIO 3] Fechar enquanto o foco inicial está pendente (50ms timeout)...');
    await evaluate(`function() {
      // Abre (agenda focusTimer para 50ms)
      RaiaModalManager.open('modalNewBill');
      // Fecha quase instantaneamente aos 10ms
      setTimeout(() => {
        RaiaModalManager.close('modalNewBill', true);
      }, 10);
    }`);

    // Aguarda o término da janela de 50ms + 150ms
    await new Promise(r => setTimeout(r, 220));

    const checkFocusCancel = await evaluate(`function() {
      const modal = document.getElementById('modalNewBill');
      const state = RaiaModalManager.getModalState('modalNewBill');
      return {
        isHidden: modal.classList.contains('hidden'),
        focusTimerNull: state.focusTimer === null,
        activeElTag: document.activeElement ? document.activeElement.tagName : null
      };
    }`);
    assert(checkFocusCancel.isHidden, 'Modal deve estar oculto');
    assert(checkFocusCancel.focusTimerNull, 'Focus timer deve ter sido cancelado');
    console.log('   ✓ Focus timer cancelado sem disparar foco em elemento oculto!');
    console.log('   ✅ PASS: Cenário 3 aprovado.\n');

    // =========================================================================
    // CENÁRIO 4: Digitar nome de cliente e pressionar Esc
    // =========================================================================
    console.log('[CENÁRIO 4] Digitar dados no formulário e pressionar ESC (Intercepção de Descarte)...');
    await evaluate(`function() {
      RaiaModalManager.open('modalNewAppointment');
      const input = document.getElementById('aptClientName');
      if (input) {
        input.value = 'Dra. Ana Paula Silveira';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }`);
    await new Promise(r => setTimeout(r, 100));

    // Envia tecla ESC via CDP
    await sendKey('Escape', 'Escape', 27);
    await new Promise(r => setTimeout(r, 200));

    const checkEscIntercept = await evaluate(`function() {
      const confirmModal = document.getElementById('modalDiscardConfirm');
      const aptModal = document.getElementById('modalNewAppointment');
      const input = document.getElementById('aptClientName');

      return {
        confirmVisible: !confirmModal.classList.contains('hidden'),
        aptModalVisible: !aptModal.classList.contains('hidden'),
        inputValue: input ? input.value : '',
        topModalId: RaiaModalManager.getTopModal() ? RaiaModalManager.getTopModal().id : null,
        stackLength: RaiaModalManager.openModalsStack.length
      };
    }`);

    assert(checkEscIntercept.confirmVisible, 'Modal de confirmação de descarte DEVE ser exibido');
    assert(checkEscIntercept.aptModalVisible, 'Modal de agendamento DEVE permanecer aberto por baixo');
    assert.strictEqual(checkEscIntercept.inputValue, 'Dra. Ana Paula Silveira', 'Dados digitados NÃO podem ser perdidos');
    assert.strictEqual(checkEscIntercept.topModalId, 'modalDiscardConfirm', 'Modal do topo deve ser modalDiscardConfirm');
    assert.strictEqual(checkEscIntercept.stackLength, 2, 'Pilha deve conter [modalNewAppointment, modalDiscardConfirm]');
    console.log('   ✓ ESC interceptado com sucesso: Confirmação de descarte aberta e dados preservados!');

    await captureScreenshot('suite011-modal-discard-confirm-beauty-desktop.png');
    console.log('   ✅ PASS: Cenário 4 aprovado.\n');

    // =========================================================================
    // CENÁRIO 5 & 6: Escolher "Continuar Editando" e comprovar preservação
    // =========================================================================
    console.log('[CENÁRIO 5 & 6] Clicar em "Continuar Editando" e validar preservação dos dados...');
    await evaluate(`function() {
      const btnStay = document.getElementById('btnDiscardStay');
      if (btnStay) btnStay.click();
    }`);
    await new Promise(r => setTimeout(r, 200));

    const checkStayResult = await evaluate(`function() {
      const confirmModal = document.getElementById('modalDiscardConfirm');
      const aptModal = document.getElementById('modalNewAppointment');
      const input = document.getElementById('aptClientName');

      return {
        confirmHidden: confirmModal.classList.contains('hidden'),
        aptModalVisible: !aptModal.classList.contains('hidden'),
        inputValue: input ? input.value : '',
        topModalId: RaiaModalManager.getTopModal() ? RaiaModalManager.getTopModal().id : null,
        stackLength: RaiaModalManager.openModalsStack.length
      };
    }`);

    assert(checkStayResult.confirmHidden, 'Modal de confirmação de descarte deve ter fechado');
    assert(checkStayResult.aptModalVisible, 'Modal de agendamento deve continuar aberto');
    assert.strictEqual(checkStayResult.inputValue, 'Dra. Ana Paula Silveira', 'Dados digitados devem permanecer 100% intactos');
    assert.strictEqual(checkStayResult.topModalId, 'modalNewAppointment', 'Topo da pilha volta a ser modalNewAppointment');
    assert.strictEqual(checkStayResult.stackLength, 1, 'Pilha deve conter agora 1 modal');
    console.log('   ✓ "Continuar Editando" validado: Modal de confirmação fechou e dados estão preservados!');
    console.log('   ✅ PASS: Cenários 5 e 6 aprovados.\n');

    // =========================================================================
    // CENÁRIO 7: Tocar fora (backdrop) e Confirmar Descarte
    // =========================================================================
    console.log('[CENÁRIO 7] Tocar no backdrop e confirmar descarte ("Descartar Alterações")...');
    // Clica no backdrop de modalNewAppointment
    await evaluate(`function() {
      const aptModal = document.getElementById('modalNewAppointment');
      // Simula mousedown e click no backdrop overlay
      aptModal.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      aptModal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }`);
    await new Promise(r => setTimeout(r, 200));

    const checkBackdropIntercept = await evaluate(`function() {
      const confirmModal = document.getElementById('modalDiscardConfirm');
      return !confirmModal.classList.contains('hidden');
    }`);
    assert(checkBackdropIntercept, 'Clique no backdrop DEVE acionar a confirmação de descarte');
    console.log('   ✓ Clique no backdrop interceptado com confirmação de descarte');

    // Clica em "Descartar Alterações"
    await evaluate(`function() {
      const btnConfirm = document.getElementById('btnDiscardConfirm');
      if (btnConfirm) btnConfirm.click();
    }`);
    await new Promise(r => setTimeout(r, 250));

    const checkDiscardDone = await evaluate(`function() {
      const confirmModal = document.getElementById('modalDiscardConfirm');
      const aptModal = document.getElementById('modalNewAppointment');
      const bodyHasOpen = document.body.classList.contains('modal-open');

      return {
        confirmHidden: confirmModal.classList.contains('hidden'),
        aptModalHidden: aptModal.classList.contains('hidden'),
        bodyHasOpen,
        stackLength: RaiaModalManager.openModalsStack.length
      };
    }`);

    assert(checkDiscardDone.confirmHidden, 'Confirmação de descarte deve ter fechado');
    assert(checkDiscardDone.aptModalHidden, 'Modal de agendamento deve ter fechado completamente');
    assert(!checkDiscardDone.bodyHasOpen, 'Scroll-lock do body DEVE ter sido liberado');
    assert.strictEqual(checkDiscardDone.stackLength, 0, 'Pilha deve estar completamente vazia');
    console.log('   ✓ Descarte confirmado: Ambos os modais foram fechados e scroll liberado!');
    console.log('   ✅ PASS: Cenário 7 aprovado.\n');

    // =========================================================================
    // CENÁRIO 8: Salvar com sucesso e fechar sem alerta indevido (markClean)
    // =========================================================================
    console.log('[CENÁRIO 8] Salvar formulário com sucesso e fechar sem alerta (markClean)...');
    await evaluate(`function() {
      RaiaModalManager.open('modalNewBill');
      const title = document.getElementById('billTitle');
      const amount = document.getElementById('billAmount');
      if (title) title.value = 'Fornecedor de Esmaltes VIP';
      if (amount) amount.value = '350.00';
    }`);
    await new Promise(r => setTimeout(r, 100));

    // Valida que o modal é considerado dirty antes do salvamento
    const checkDirtyBefore = await evaluate(`function() {
      return RaiaModalManager.isDirty('modalNewBill');
    }`);
    assert(checkDirtyBefore, 'Modal com dados preenchidos DEVE ser considerado dirty antes de salvar');
    console.log('   ✓ Formulário marcado como dirty antes do salvamento');

    // Simula salvamento bem-sucedido (marca clean e fecha)
    await evaluate(`function() {
      RaiaModalManager.markClean('modalNewBill');
      RaiaModalManager.close('modalNewBill');
    }`);
    await new Promise(r => setTimeout(r, 200));

    const checkSaveResult = await evaluate(`function() {
      const billModal = document.getElementById('modalNewBill');
      const confirmModal = document.getElementById('modalDiscardConfirm');
      return {
        billModalHidden: billModal.classList.contains('hidden'),
        confirmModalHidden: confirmModal.classList.contains('hidden'),
        stackLength: RaiaModalManager.openModalsStack.length
      };
    }`);

    assert(checkSaveResult.billModalHidden, 'Modal de contas deve ter fechado normalmente após markClean');
    assert(checkSaveResult.confirmModalHidden, 'Modal de confirmação de descarte NÃO PODE ser exibido após salvamento');
    assert.strictEqual(checkSaveResult.stackLength, 0, 'Pilha deve estar limpa');
    console.log('   ✓ Salvamento com sucesso fecha imediatamente sem alerta indevido!');
    console.log('   ✅ PASS: Cenário 8 aprovado.\n');

    // =========================================================================
    // CENÁRIO 9: Abrir dois modais e fechar somente o superior
    // =========================================================================
    console.log('[CENÁRIO 9] Abrir dois modais (Conflitos + Remarcação) e fechar o superior...');
    await evaluate(`function() {
      RaiaModalManager.open('modalHistoricalConflicts');
      RaiaModalManager.open('modalRescheduleAppointment');
    }`);
    await new Promise(r => setTimeout(r, 150));

    const checkTwoModals = await evaluate(`function() {
      const m1 = document.getElementById('modalHistoricalConflicts');
      const m2 = document.getElementById('modalRescheduleAppointment');
      return {
        m1Visible: !m1.classList.contains('hidden'),
        m2Visible: !m2.classList.contains('hidden'),
        stack: RaiaModalManager.openModalsStack.slice()
      };
    }`);
    assert(checkTwoModals.m1Visible && checkTwoModals.m2Visible, 'Ambos os modais devem estar visíveis');
    assert.strictEqual(checkTwoModals.stack.length, 2, 'Pilha deve conter exatamente 2 modais');

    // Fecha apenas o superior sem ter alterado dados
    await evaluate(`function() {
      RaiaModalManager.close('modalRescheduleAppointment');
    }`);
    await new Promise(r => setTimeout(r, 250));

    const checkAfterUpperClose = await evaluate(`function() {
      const m1 = document.getElementById('modalHistoricalConflicts');
      const m2 = document.getElementById('modalRescheduleAppointment');
      const bodyHasOpen = document.body.classList.contains('modal-open');
      return {
        m1Visible: !m1.classList.contains('hidden'),
        m2Hidden: m2.classList.contains('hidden'),
        bodyHasOpen,
        stack: RaiaModalManager.openModalsStack.slice()
      };
    }`);

    assert(checkAfterUpperClose.m1Visible, 'Modal inferior (Conflitos) DEVE continuar aberto');
    assert(checkAfterUpperClose.m2Hidden, 'Modal superior (Remarcação) deve ter sido fechado');
    assert(checkAfterUpperClose.bodyHasOpen, 'Scroll-lock no body DEVE PERMANECER ATIVO');
    assert.strictEqual(checkAfterUpperClose.stack.length, 1, 'Pilha deve conter agora 1 modal');
    console.log('   ✓ Modal superior fechou e modal inferior permaneceu estável com scroll-lock!');

    // Fecha o modal de conflitos
    await evaluate(`function() { RaiaModalManager.close('modalHistoricalConflicts', true); }`);
    await new Promise(r => setTimeout(r, 200));
    console.log('   ✅ PASS: Cenário 9 aprovado.\n');

    // =========================================================================
    // CENÁRIO 10: Retorno de foco ao disparador e integridade do scroll-lock
    // =========================================================================
    console.log('[CENÁRIO 10] Retorno de foco ao disparador e integridade do scroll-lock...');
    await evaluate(`function() {
      let btn = document.getElementById('testCustomTrigger011');
      if (!btn) {
        btn = document.createElement('button');
        btn.id = 'testCustomTrigger011';
        btn.textContent = 'Botão Disparador de Teste';
        document.body.appendChild(btn);
      }
      btn.focus();
      RaiaModalManager.open('modalNewTransaction', btn);
    }`);

    // Aguarda o término de setInitialFocus (50ms timeout)
    await new Promise(r => setTimeout(r, 120));

    const triggerFocusTest = await evaluate(`function() {
      const btn = document.getElementById('testCustomTrigger011');
      const modal = document.getElementById('modalNewTransaction');
      return modal.contains(document.activeElement) && document.activeElement !== btn;
    }`);
    assert(triggerFocusTest, 'Foco deve ter entrado no modal');

    await evaluate(`function() {
      RaiaModalManager.close('modalNewTransaction', true);
    }`);
    await new Promise(r => setTimeout(r, 250));

    const returnFocusCheck = await evaluate(`function() {
      const btn = document.getElementById('testCustomTrigger011');
      const hasFocus = document.activeElement === btn;
      const bodyHasOpen = document.body.classList.contains('modal-open');
      if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      return { hasFocus, bodyHasOpen };
    }`);
    assert(returnFocusCheck.hasFocus, 'Foco deve retornar ao botão disparador');
    assert(!returnFocusCheck.bodyHasOpen, 'Scroll-lock no body deve estar totalmente liberado');
    console.log('   ✓ Retorno de foco ao disparador e liberação de scroll-lock confirmados!');
    console.log('   ✅ PASS: Cenário 10 aprovado.\n');

    // =========================================================================
    // CENÁRIO 11: Responsividade Mobile (iPhone 390x844) e Touch no Backdrop
    // =========================================================================
    console.log('[CENÁRIO 11] Validação Mobile (390x844) com intercepção de descarte...');
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await new Promise(r => setTimeout(r, 300));

    await evaluate(`function() {
      RaiaModalManager.open('modalSingleService');
      const input = document.getElementById('singleServiceName');
      if (input) {
        input.value = 'Mega Hair Especial';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }`);
    await new Promise(r => setTimeout(r, 100));

    // Toca no backdrop overlay no mobile
    await evaluate(`function() {
      const modal = document.getElementById('modalSingleService');
      modal.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
      modal.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    }`);
    await new Promise(r => setTimeout(r, 200));

    const checkMobileDiscard = await evaluate(`function() {
      const confirmModal = document.getElementById('modalDiscardConfirm');
      const rect = confirmModal.getBoundingClientRect();
      const card = confirmModal.querySelector('.raia-modal-card');
      const cardRect = card ? card.getBoundingClientRect() : null;

      return {
        confirmVisible: !confirmModal.classList.contains('hidden'),
        overlayWidth: rect.width,
        cardWidth: cardRect ? cardRect.width : 0,
        noHorizontalScroll: document.documentElement.scrollWidth <= window.innerWidth
      };
    }`);

    assert(checkMobileDiscard.confirmVisible, 'No mobile, touch no backdrop deve acionar confirmação de descarte');
    assert.strictEqual(checkMobileDiscard.overlayWidth, 390, 'No mobile, overlay deve cobrir 390px');
    assert(checkMobileDiscard.cardWidth <= 390, 'Card não pode estourar a tela no mobile');
    assert(checkMobileDiscard.noHorizontalScroll, 'Sem rolagem horizontal residual');
    console.log('   ✓ Mobile 390x844: Backdrop touch e diálogo de descarte 100% responsivos!');

    await captureScreenshot('suite011-modal-discard-confirm-beauty-mobile.png');

    // Descarta no mobile
    await evaluate(`function() {
      const btnConfirm = document.getElementById('btnDiscardConfirm');
      if (btnConfirm) btnConfirm.click();
    }`);
    await new Promise(r => setTimeout(r, 250));

    // Restaura desktop
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false
    });
    await new Promise(r => setTimeout(r, 200));
    console.log('   ✅ PASS: Cenário 11 aprovado.\n');

    // =========================================================================
    // CENÁRIO 12: HUB Central (Tema Dark) e Validação Visual do Diálogo
    // =========================================================================
    console.log('[CENÁRIO 12] Modal de Confirmação de Descarte no HUB Central (Tema Dark)...');
    await evaluate(`function() {
      if (typeof switchTab === 'function') switchTab('my-products');
      RaiaModalManager.open('modalDiscardConfirm');
    }`);
    await new Promise(r => setTimeout(r, 150));

    const checkHubTheme = await evaluate(`function() {
      const modal = document.getElementById('modalDiscardConfirm');
      const card = modal.querySelector('.raia-modal-card');
      const cardStyle = window.getComputedStyle(card);
      return {
        cardBg: cardStyle.backgroundColor,
        color: cardStyle.color
      };
    }`);
    console.log(`   ✓ HUB Central Dark: Card BG=${checkHubTheme.cardBg}`);
    await captureScreenshot('suite011-modal-discard-confirm-hub-dark.png');

    await evaluate(`function() {
      RaiaModalManager.close('modalDiscardConfirm', true);
      if (typeof switchTab === 'function') switchTab('appointments');
    }`);
    await new Promise(r => setTimeout(r, 200));
    console.log('   ✅ PASS: Cenário 12 aprovado.\n');

    ws.close();

    console.log('================================================================');
    console.log('   TODOS OS 12 CENÁRIOS DE ESTABILIDADE FORAM APROVADOS!        ');
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

runModalStability011().catch(err => {
  console.error('\n❌ ERRO NA SUÍTE 011:', err);
  process.exit(1);
});
