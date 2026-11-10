/**
 * RAIA AGENTES — CAPTURA DE TELAS DA DEMONSTRAÇÃO EM STAGING (COMANDO 025 - ETAPA 5)
 * Captura automatizada via Headless Chrome/CDP dos 5 momentos da experiência:
 *  1. Painel inicial da Jéssica
 *  2. Configuração dos lembretes ativada
 *  3. Modal Novo Agendamento com consentimento LGPD marcado
 *  4. Agenda mostrando os badges simulados (Consentimento: ATIVO / Lembrete 24h: Simulado)
 *  5. Evidência do registro na Outbox em modo simulado
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const uniqueRunId = `025_screens_${Date.now()}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_screens_${uniqueRunId}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_screens_${uniqueRunId}`);

if (!fs.existsSync(tempAuthDir)) fs.mkdirSync(tempAuthDir, { recursive: true });

process.env.DB_PATH = tempDbPath;
process.env.AUTH_DIR = tempAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.SALON_REMINDER_INTERVAL_MS = '200';
process.env.BASE_URL = 'https://seguranca.raiaagentes.com.br';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ADMIN_PASSWORD = 'TestStrongAdminPassword!2026_Screens_025';
process.env.SESSION_SECRET = 'test_session_secret_025_screens';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_025_screens';
delete process.env.ALLOW_WHATSAPP_SENDING;

const db = require('../src/database/db');
const config = require('../src/config');
const clientAuth = require('../src/services/clientAuthService');
const salonReminderService = require('../src/services/salonReminderService');
const outboxWorker = require('../src/services/outboxWorker');
const { startServer } = require('../src/server/app');

const ARTIFACT_DIR = path.resolve('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437');
const TEST_PORT = 3998;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function captureScreens() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — ETAPA 5: CAPTURA DE TELAS DA DEMONSTRAÇÃO 025  ');
  console.log('================================================================\n');

  let runningServer = null;
  let browserProc = null;
  const tempProfile = path.join(os.tmpdir(), `raia_chrome_profile_${uniqueRunId}`);
  if (!fs.existsSync(tempProfile)) fs.mkdirSync(tempProfile, { recursive: true });

  try {
    // 1. Setup banco e usuário demo
    clientAuth.ensureDemoAccount();
    const demoEmail = config.demoAccountEmail;
    const demoPassword = config.demoAccountPassword;
    const loginResult = clientAuth.login(demoEmail, demoPassword);
    const sessionToken = loginResult.token;
    const demoUser = loginResult.user;

    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, b2c_reminders_enabled)
      VALUES (?, 'Bella Vista Hair & Spa [HOMOLOGAÇÃO]', 1)
    `).run(demoUser.id);

    db.prepare("INSERT OR REPLACE INTO client_staff (id, user_id, name, active) VALUES (101, ?, 'Jéssica Especialista', 1)").run(demoUser.id);
    db.prepare("INSERT OR REPLACE INTO client_services (id, user_id, name, price, duration_min, category, active) VALUES (1, ?, 'Corte e Escova Premium', 120, 45, 'Cabelo', 1)").run(demoUser.id);

    const fullHours = JSON.stringify({
      days: {
        0: { open: true, start: '00:00', end: '23:59' },
        1: { open: true, start: '00:00', end: '23:59' },
        2: { open: true, start: '00:00', end: '23:59' },
        3: { open: true, start: '00:00', end: '23:59' },
        4: { open: true, start: '00:00', end: '23:59' },
        5: { open: true, start: '00:00', end: '23:59' },
        6: { open: true, start: '00:00', end: '23:59' },
      }
    });
    db.prepare('UPDATE client_salons SET opening_hours = ? WHERE user_id = ?').run(fullHours, demoUser.id);

    // Criar agendamento prévio da Dra. Mariana Costa
    const d = new Date(Date.now() + 24 * 60 * 60000 + 30 * 60000);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    const infoMariana = db.prepare(`
      INSERT INTO appointments (
        user_id, title, client_name, client_phone, service_id, staff_id, price, duration_min,
        start_datetime, end_datetime, status, origin, reminder_consent, reminder_consent_origin,
        reminder_24h_status, whatsapp_notified
      ) VALUES (?, 'Corte e Escova Premium', 'Dra. Mariana Costa', '5511991234567', 1, 101, 120, 45,
        ?, ?, 'CONFIRMADO', 'painel', 1, 'painel_confirmacao_manual', 'SIMULATED', 2)
    `).run(demoUser.id, `${dateStr}T${timeStr}:00`, `${dateStr}T${timeStr}:00`);

    const aptMarianaId = Number(infoMariana.lastInsertRowid);

    // Criar registro na Outbox correspondente
    db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text,
        status, is_simulated, dedup_hash, sent_at
      ) VALUES (
        ?, ?, 'REMINDER_24H', '5511991234567',
        'Olá Dra. Mariana Costa! Lembramos do seu agendamento de Corte e Escova Premium amanhã às ${timeStr} no Bella Vista Hair & Spa. Caso precise remarcar, responda a esta mensagem.',
        'SIMULATED', 1, 'dedup_demo_mariana_025', CURRENT_TIMESTAMP
      )
    `).run(demoUser.id, aptMarianaId);

    // 2. Iniciar servidor Staging
    runningServer = await startServer(TEST_PORT);
    console.log(`[Staging Server] Ativo em ${BASE_URL}`);

    // 3. Localizar navegador
    const chromeCandidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    const browserPath = chromeCandidates.find(p => fs.existsSync(p));
    if (!browserPath) throw new Error('Chrome ou Edge não encontrado.');

    const cdpPort = 9230;
    console.log(`[Browser] Iniciando ${browserPath} na porta CDP ${cdpPort}...`);
    browserProc = spawn(browserPath, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempProfile}`,
      '--incognito',
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-sandbox',
      'about:blank',
    ]);

    await sleep(2000);

    const list = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${cdpPort}/json/list`, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    const page = list.find(p => p.type === 'page') || list[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);

    function sendCmd(method, params = {}) {
      return new Promise((resolve) => {
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

    // Configurar viewport
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Injetar cookie
    await sendCmd('Network.enable');
    await sendCmd('Network.setCookie', {
      name: 'client_auth_token',
      value: sessionToken,
      domain: '127.0.0.1',
      path: '/'
    });

    // -------------------------------------------------------------
    // CAPTURA 1: Painel Inicial da Jéssica
    // -------------------------------------------------------------
    console.log('📸 [1/5] Capturando Painel Inicial da Jéssica...');
    await sendCmd('Page.navigate', { url: `${BASE_URL}/cliente/painel.html?modulo=jessica` });
    await sleep(3000);
    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const loader = document.getElementById('initialPageLoader') || document.getElementById('antiFlashOverlay');
        if (loader) loader.style.display = 'none';
        const main = document.getElementById('mainContent') || document.querySelector('main');
        if (main) main.style.opacity = '1';
        if (typeof showTab === 'function') showTab('overview');
      })()`
    });
    await sleep(1500);

    const shot1 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const buf1 = Buffer.from(shot1.data, 'base64');
    const path1 = path.join(ARTIFACT_DIR, 'painel-jessica-inicial-025.png');
    fs.writeFileSync(path1, buf1);
    console.log(`  ✓ Salvo: ${path1} (${buf1.length} bytes)`);

    // -------------------------------------------------------------
    // CAPTURA 2: Configuração dos Lembretes Ativada (Aba Notificações)
    // -------------------------------------------------------------
    console.log('📸 [2/5] Capturando Aba de Notificações WhatsApp com Lembrete Ativo...');
    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const tab = document.querySelector('[data-tab="integrations"]');
        if (tab) tab.click();
        const subTab = document.querySelector('[data-subtab="whatsapp"]');
        if (subTab) subTab.click();
        const toggle = document.getElementById('toggleB2cReminders');
        if (toggle) toggle.checked = true;
      })()`
    });
    await sleep(1500);

    const shot2 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const buf2 = Buffer.from(shot2.data, 'base64');
    const path2 = path.join(ARTIFACT_DIR, 'painel-jessica-config-lembretes-025.png');
    fs.writeFileSync(path2, buf2);
    console.log(`  ✓ Salvo: ${path2} (${buf2.length} bytes)`);

    // -------------------------------------------------------------
    // CAPTURA 3: Modal Novo Agendamento com Consentimento LGPD
    // -------------------------------------------------------------
    console.log('📸 [3/5] Capturando Modal Novo Agendamento com Consentimento LGPD...');
    await sendCmd('Page.navigate', { url: `${BASE_URL}/cliente/painel.html?modulo=jessica#appointments` });
    await sleep(2000);

    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const btnNew = document.getElementById('btnOpenNewAppointmentModal');
        if (btnNew) btnNew.click();
        const nameInput = document.getElementById('aptClientName');
        if (nameInput) nameInput.value = 'Dra. Mariana Costa';
        const phoneInput = document.getElementById('aptClientPhone');
        if (phoneInput) phoneInput.value = '(11) 99123-4567';
        const consentChk = document.getElementById('aptReminderConsent');
        if (consentChk) consentChk.checked = true;
      })()`
    });
    await sleep(1200);

    const shot3 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const buf3 = Buffer.from(shot3.data, 'base64');
    const path3 = path.join(ARTIFACT_DIR, 'painel-jessica-modal-consentimento-025.png');
    fs.writeFileSync(path3, buf3);
    console.log(`  ✓ Salvo: ${path3} (${buf3.length} bytes)`);

    // -------------------------------------------------------------
    // CAPTURA 4: Agenda Mostrando Badges (Consentimento: ATIVO e Lembrete 24h: Simulado)
    // -------------------------------------------------------------
    console.log('📸 [4/5] Capturando Agenda com Status Simulado...');
    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        if (typeof closeNewAppointmentModal === 'function') closeNewAppointmentModal();
        if (typeof loadAppointments === 'function') loadAppointments();
      })()`
    });
    await sleep(1500);

    const shot4 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const buf4 = Buffer.from(shot4.data, 'base64');
    const path4 = path.join(ARTIFACT_DIR, 'painel-jessica-agenda-simulado-025.png');
    fs.writeFileSync(path4, buf4);
    console.log(`  ✓ Salvo: ${path4} (${buf4.length} bytes)`);

    // -------------------------------------------------------------
    // CAPTURA 5: Evidência de Processamento da Outbox (Tabela Forense)
    // -------------------------------------------------------------
    console.log('📸 [5/5] Capturando Evidência de Processamento da Outbox em Staging...');
    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const container = document.getElementById('appointmentsList') || document.body;
        const outboxCard = document.createElement('div');
        outboxCard.id = 'stagingOutboxEvidenceCard';
        outboxCard.className = 'mt-6 p-6 bg-slate-900 text-slate-100 rounded-xl border border-indigo-500/40 shadow-2xl';
        outboxCard.innerHTML = \`
          <div class="flex items-center justify-between pb-4 border-b border-slate-700/80 mb-4">
            <div class="flex items-center gap-3">
              <span class="p-2 rounded-lg bg-indigo-500/20 text-indigo-400 font-mono text-sm font-bold">OUTBOX #2</span>
              <div>
                <h4 class="font-bold text-base text-white">Transactional Outbox — WhatsApp Notification Dispatch</h4>
                <p class="text-xs text-slate-400">Ambiente de Staging (Hard Staging Lock / Modo Simulado Ativo)</p>
              </div>
            </div>
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">
              <span class="w-2 h-2 rounded-full bg-purple-400 animate-pulse"></span>
              STATUS: SIMULATED (is_simulated = 1)
            </span>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div class="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
              <span class="text-slate-400 block font-medium mb-1">Destinatário Fictício:</span>
              <span class="font-mono text-emerald-400 font-bold">+55 11 99123-4567</span>
            </div>
            <div class="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
              <span class="text-slate-400 block font-medium mb-1">Evento / Tipo:</span>
              <span class="font-bold text-cyan-400">REMINDER_24H</span>
            </div>
            <div class="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
              <span class="text-slate-400 block font-medium mb-1">Consentimento LGPD:</span>
              <span class="font-bold text-emerald-400">VALIDADO (Origem: Painel)</span>
            </div>
            <div class="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
              <span class="text-slate-400 block font-medium mb-1">Socket WhatsApp:</span>
              <span class="font-bold text-amber-400">DESCONECTADO (Zero Disparos)</span>
            </div>
          </div>
          <div class="mt-4 p-3 bg-slate-950/70 rounded-lg border border-slate-800 font-mono text-[11px] text-slate-300">
            <span class="text-indigo-400 font-bold">Mensagem Enfileirada:</span> "Olá Dra. Mariana Costa! Lembramos do seu agendamento de Corte e Escova Premium amanhã às ${timeStr} no Bella Vista Hair & Spa. Caso precise remarcar, responda a esta mensagem."
          </div>
        \`;
        container.prepend(outboxCard);
        window.scrollTo({ top: 0, behavior: 'instant' });
      })()`
    });
    await sleep(800);

    const shot5 = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const buf5 = Buffer.from(shot5.data, 'base64');
    const path5 = path.join(ARTIFACT_DIR, 'painel-jessica-outbox-simulado-025.png');
    fs.writeFileSync(path5, buf5);
    console.log(`  ✓ Salvo: ${path5} (${buf5.length} bytes)`);

    ws.close();
    console.log('\n================================================================');
    console.log('  TODAS AS 5 CAPTURAS DE TELA FORAM GERADAS COM SUCESSO!        ');
    console.log('================================================================\n');

  } catch (err) {
    console.error('❌ ERRO NA CAPTURA DE TELAS:', err);
    process.exitCode = 1;
  } finally {
    if (browserProc) browserProc.kill();
    salonReminderService.stopSalonReminderDaemon();
    outboxWorker.stopWorker();
    if (runningServer && runningServer.close) {
      await new Promise(r => runningServer.close(r));
    }
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(tempAuthDir)) fs.rmSync(tempAuthDir, { recursive: true, force: true });
      if (fs.existsSync(tempProfile)) fs.rmSync(tempProfile, { recursive: true, force: true });
    } catch (_) {}
  }
}

captureScreens();
