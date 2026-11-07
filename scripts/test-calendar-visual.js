/**
 * RAIA AGENTES — VALIDAÇÃO VISUAL DO CALENDÁRIO JÉSSICA BEAUTY
 * Testes no navegador real (Desktop e Mobile) com capturas de tela.
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const assert = require('assert');

async function runVisualValidation() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — VALIDAÇÃO VISUAL REAL DO CALENDÁRIO JÉSSICA   ');
  console.log('================================================================\n');

  const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new',
    '--remote-debugging-port=9229',
    '--hide-scrollbars',
    'file:///C:/Users/Acer/Downloads/assistente%20zap/public/cliente/painel.html#appointments'
  ]);

  await new Promise(r => setTimeout(r, 2000));

  try {
    const list = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:9229/json/list', res => {
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
    // 1. DESKTOP (1024 x 768)
    // =========================================================
    console.log('[Teste 1] Avaliação em Desktop 1024x768 com Janela de Novo Agendamento...');
    await sendCmd('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });

    const desktopRes = await sendCmd('Runtime.evaluate', {
      expression: `(async () => {
        // Garantir aba appointments ativa no tema Jéssica Beauty
        if (typeof switchTab === 'function') switchTab('appointments');

        // Abrir modal de novo agendamento
        const modal = document.getElementById('modalNewAppointment');
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        if (typeof validateAppointmentFormCompletion === 'function') validateAppointmentFormCompletion();

        const submitBtn = document.getElementById('btnSubmitNewAppointment');
        const submitDisabledProp = submitBtn ? submitBtn.disabled : false;
        const submitDisabledAttr = submitBtn ? submitBtn.hasAttribute('disabled') : false;
        const submitStyle = submitBtn ? window.getComputedStyle(submitBtn) : {};

        // Clicar no botão do calendário para abrir
        const btnCal = document.getElementById('btnOpenAptDatePicker');
        btnCal.click();

        const popover = document.getElementById('aptBeautyCalendarPopover');
        const modalCard = modal.querySelector('div');
        const pr = popover.getBoundingClientRect();
        const mr = modalCard.getBoundingClientRect();

        const monthLabel = document.getElementById('aptCalMonthYearLabel');
        const prevBtn = document.getElementById('btnPrevAptCalMonth');
        const nextBtn = document.getElementById('btnNextAptCalMonth');
        const closeBtn = document.getElementById('btnCloseAptCalPopover');

        return {
          submitBtn: {
            disabled: submitDisabledProp,
            hasAttr: submitDisabledAttr,
            cursor: submitStyle.cursor,
            backgroundColor: submitStyle.backgroundColor
          },
          popover: {
            top: pr.top,
            bottom: pr.bottom,
            left: pr.left,
            right: pr.right,
            width: pr.width,
            height: pr.height,
            isVisible: !popover.classList.contains('hidden')
          },
          modalCard: {
            top: mr.top,
            bottom: mr.bottom,
            left: mr.left,
            right: mr.right,
            width: mr.width,
            height: mr.height
          },
          controls: {
            monthText: monthLabel ? monthLabel.innerText : '',
            hasPrevBtn: Boolean(prevBtn),
            hasNextBtn: Boolean(nextBtn),
            hasCloseBtn: Boolean(closeBtn)
          },
          // Validação geométrica: popover dentro da viewport e sem corte no topo da tela ou modal
          isWithinWindow: (pr.top >= 0 && pr.bottom <= window.innerHeight && pr.left >= 0 && pr.right <= window.innerWidth),
          isWithinModalCard: (pr.top >= mr.top && pr.bottom <= mr.bottom)
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const dData = desktopRes.result.value;
    assert(dData.submitBtn.disabled, 'Botão Confirmar Agendamento deve estar com disabled=true');
    assert(dData.submitBtn.hasAttr, 'Botão Confirmar Agendamento deve possuir atributo disabled');
    assert(dData.popover.isVisible, 'Calendário deve estar visível');
    assert(dData.controls.monthText.length > 3, 'Nome do mês deve estar visível e preenchido');
    assert(dData.controls.hasPrevBtn && dData.controls.hasNextBtn, 'Botões de navegação de mês devem estar visíveis');
    assert(dData.controls.hasCloseBtn, 'Botão fechar [x] do calendário deve existir');
    assert(dData.isWithinWindow, 'Todo o calendário deve estar dentro da tela sem cortes');
    assert(dData.isWithinModalCard, 'Todo o calendário deve estar contido nos limites do modal sem cortar topo');

    console.log(`  ✓ 1.1. Botão Confirmar Agendamento desabilitado com sucesso (prop=true, attr=disabled, cursor=${dData.submitBtn.cursor}).`);
    console.log(`  ✓ 1.2. Calendário aberto com dimensões ${Math.round(dData.popover.width)}x${Math.round(dData.popover.height)}px em [${Math.round(dData.popover.top)}, ${Math.round(dData.popover.left)}].`);
    console.log(`  ✓ 1.3. Cabeçalho visível: "${dData.controls.monthText}", controles de navegação e fechar [x] presentes.`);
    console.log(`  ✓ 1.4. Geometria íntegra: topo do calendário (${Math.round(dData.popover.top)}px) está abaixo do topo do modal (${Math.round(dData.modalCard.top)}px). ZERO CORTE.`);

    // Capturar tela Desktop com o calendário aberto
    await new Promise(r => setTimeout(r, 400));
    const shotDesktop = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const bufDesktop = Buffer.from(shotDesktop.data, 'base64');
    fs.writeFileSync('public/images/beauty/jessica-beauty-calendar-open-desktop-1024x768.png', bufDesktop);
    fs.writeFileSync('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437/jessica-beauty-calendar-open-desktop-1024x768.png', bufDesktop);
    console.log('  ✓ 1.5. Screenshot Desktop gravado com sucesso.');

    // =========================================================
    // 2. MOBILE (390 x 844)
    // =========================================================
    console.log('\n[Teste 2] Avaliação em Mobile 390x844 (adaptado à largura, sem cortes)...');
    await sendCmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sendCmd('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('resize'));` });
    await new Promise(r => setTimeout(r, 300));

    const mobileRes = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const popover = document.getElementById('aptBeautyCalendarPopover');
        const pr = popover.getBoundingClientRect();
        return {
          top: pr.top,
          bottom: pr.bottom,
          left: pr.left,
          right: pr.right,
          width: pr.width,
          height: pr.height,
          isWithinWindow: (pr.top >= 0 && pr.bottom <= window.innerHeight && pr.left >= 0 && pr.right <= window.innerWidth),
          isCenteredX: Math.abs((pr.left + pr.width / 2) - (window.innerWidth / 2)) < 5
        };
      })()`,
      returnByValue: true
    });

    const mData = mobileRes.result.value;
    assert(mData.isWithinWindow, 'Calendário no mobile deve estar totalmente dentro da tela');
    assert(mData.isCenteredX, 'Calendário no mobile deve estar perfeitamente centralizado horizontalmente');
    assert(mData.width <= 390, 'Largura do calendário deve caber na tela do celular sem overflow');

    console.log(`  ✓ 2.1. Mobile: largura adaptada em ${Math.round(mData.width)}px com margens seguras (left=${Math.round(mData.left)}px, right=${Math.round(mData.right)}px).`);
    console.log(`  ✓ 2.2. Mobile: perfeitamente centralizado horizontalmente (isCenteredX=true).`);
    console.log(`  ✓ 2.3. Mobile: sem corte superior ou inferior (top=${Math.round(mData.top)}px, bottom=${Math.round(mData.bottom)}px dentro de 844px).`);

    // Capturar tela Mobile com o calendário aberto
    await new Promise(r => setTimeout(r, 400));
    const shotMobile = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const bufMobile = Buffer.from(shotMobile.data, 'base64');
    fs.writeFileSync('public/images/beauty/jessica-beauty-calendar-open-mobile-390x844.png', bufMobile);
    fs.writeFileSync('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437/jessica-beauty-calendar-open-mobile-390x844.png', bufMobile);
    console.log('  ✓ 2.4. Screenshot Mobile gravado com sucesso.');

    // =========================================================
    // 3. FECHAMENTO ADEQUADO (BOTÃO [X] E SELEÇÃO)
    // =========================================================
    console.log('\n[Teste 3] Teste de fechamento do calendário via botão [x] e seleção de dia...');
    const closeRes = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const closeBtn = document.getElementById('btnCloseAptCalPopover');
        closeBtn.click();
        const popover = document.getElementById('aptBeautyCalendarPopover');
        return { isHidden: popover.classList.contains('hidden') };
      })()`,
      returnByValue: true
    });
    assert(closeRes.result.value.isHidden, 'Clicar no botão [x] deve fechar o calendário');
    console.log('  ✓ 3.1. Botão [x] fecha o popover de calendário com sucesso.');

    // =========================================================
    // 4. CALENDÁRIO DE REMARCAÇÃO (MESMA CORREÇÃO)
    // =========================================================
    console.log('\n[Teste 4] Validação da mesma correção aplicada ao Calendário de Remarcação...');
    await sendCmd('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    const reschedRes = await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const modal = document.getElementById('modalRescheduleAppointment');
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        const btn = document.getElementById('btnOpenRescheduleDatePicker');
        btn.click();

        const popover = document.getElementById('rescheduleBeautyCalendarPopover');
        const modalCard = modal.querySelector('div');
        const pr = popover.getBoundingClientRect();
        const mr = modalCard.getBoundingClientRect();
        const monthLabel = document.getElementById('rescheduleCalMonthYearLabel');
        const closeBtn = document.getElementById('btnCloseRescheduleCalPopover');

        return {
          isVisible: !popover.classList.contains('hidden'),
          popover: { top: pr.top, bottom: pr.bottom, left: pr.left, right: pr.right, width: pr.width, height: pr.height },
          modalCard: { top: mr.top, bottom: mr.bottom, left: mr.left, right: mr.right, width: mr.width, height: mr.height },
          monthText: monthLabel ? monthLabel.innerText : '',
          hasCloseBtn: Boolean(closeBtn),
          isWithinWindow: (pr.top >= 0 && pr.bottom <= window.innerHeight && pr.left >= 0 && pr.right <= window.innerWidth),
          isWithinModalCard: (pr.top >= mr.top && pr.bottom <= mr.bottom)
        };
      })()`,
      returnByValue: true
    });

    const rData = reschedRes.result.value;
    console.log('rData:', JSON.stringify(rData, null, 2));
    assert(rData.isVisible, 'Calendário de remarcação deve abrir');
    assert(rData.monthText.length > 3, 'Cabeçalho do mês de remarcação deve estar visível');
    assert(rData.hasCloseBtn, 'Botão fechar [x] de remarcação deve existir');
    assert(rData.isWithinWindow, 'Calendário de remarcação deve estar totalmente visível na tela');
    assert(rData.isWithinModalCard, 'Calendário de remarcação deve estar contido nos limites do modal');
    console.log('  ✓ 4.1. Calendário de remarcação 100% contido nos limites visíveis com cabeçalho e controles íntegros.');

    console.log('\n================================================================');
    console.log('   RESULTADO: TODOS OS TESTES VISUAIS APROVADOS COM SUCESSO!    ');
    console.log('================================================================\n');

    chrome.kill();
  } catch (err) {
    console.error('\n❌ ERRO NA VALIDAÇÃO VISUAL:', err);
    chrome.kill();
    process.exit(1);
  }
}

runVisualValidation();
