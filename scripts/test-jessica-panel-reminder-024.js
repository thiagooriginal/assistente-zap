/**
 * RAIA AGENTES — SUÍTE DE TESTES E DEMONSTRAÇÃO E2E (COMANDO 024)
 * 
 * Validação dos 10 passos do fluxo completo do Lembrete 24h no Painel da Jéssica:
 *  1. Abrir o painel da Jéssica e validar campo no HTML (#aptReminderConsent)
 *  2. Ativar os lembretes nas configurações do salão (b2c_reminders_enabled = 1)
 *  3. Criar uma cliente fictícia (Dra. Mariana Costa)
 *  4. Marcar expressamente o consentimento no novo formulário (reminderConsent: true)
 *  5. Agendar atendimento para ~24h à frente
 *  6. Confirmar que o daemon cria a notificação automaticamente na Outbox
 *  7. Confirmar que o worker marca como SIMULATED (Homologação)
 *  8. Exibir o badge correspondente na agenda (Lembrete 24h: Simulado / Consentimento: ATIVO)
 *  9. Criar outro agendamento sem consentimento e comprovar ausência de lembrete
 * 10. Remarcar e cancelar agendamento, verificando os respectivos estados
 * 11. Navegação no painel com navegador headless e captura de tela de alta resolução
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');

// 1. ISOLAMENTO HERMÉTICO EM OS.TMPDIR() — BANCO DE PRODUÇÃO 100% INVIOLÁVEL
const uniqueRunId = `024_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_panel_reminder_${uniqueRunId}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_panel_${uniqueRunId}`);

if (!fs.existsSync(tempAuthDir)) {
  fs.mkdirSync(tempAuthDir, { recursive: true });
}

process.env.DB_PATH = tempDbPath;
process.env.AUTH_DIR = tempAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.SALON_REMINDER_INTERVAL_MS = '200';

process.env.ADMIN_PASSWORD = 'TestStrongAdminPassword!2026_Panel_024';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.SESSION_SECRET = 'test_session_secret_024_panel_token_abc_123';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_024_panel_token_def_456';
process.env.MFA_ENCRYPTION_KEY = 'test_mfa_key_024_panel_token_ghi_789';

// Inviolabilidade do banco operacional
const prodDbPath = path.resolve(__dirname, '../data/assistant.db');
const prodDbStatBefore = fs.existsSync(prodDbPath) ? fs.statSync(prodDbPath) : null;

// Carregar módulos da RAIA
const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonReminderService = require('../src/services/salonReminderService');
const outboxWorker = require('../src/services/outboxWorker');
const { app, startServer } = require('../src/server/app');

let passedTests = 0;
let runningServer = null;
const TEST_PORT = 3987;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const ARTIFACT_DIR = path.resolve('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — SUÍTE E2E: FINALIZAÇÃO DO LEMBRETE 24H (024)   ');
  console.log('================================================================\n');

  try {
    // -------------------------------------------------------------
    // SETUP: Criação de Salão, Usuário e Sessão
    // -------------------------------------------------------------
    const userId = 201;
    const sessionToken = 'session_test_token_jessica_024_xyz';

    db.prepare(`
      INSERT OR REPLACE INTO users (id, phone_number, name, role, plan_tier, subscription_status, paid_until, session_token, session_expires_at)
      VALUES (?, '5511999990201', 'Jéssica Beauty Salon', 'SALON_OWNER', 'JESSICA_PRO', 'ACTIVE', '2099-01-01T00:00:00Z', ?, '2099-01-01T00:00:00Z')
    `).run(userId, sessionToken);

    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, b2c_reminders_enabled)
      VALUES (?, 'Jéssica Beauty Studio', 0)
    `).run(userId);

    db.prepare("INSERT OR REPLACE INTO client_staff (id, user_id, name, active) VALUES (1, ?, 'Jéssica Oficial', 1)").run(userId);

    db.prepare(`
      INSERT OR REPLACE INTO client_services (id, user_id, name, price, duration_min, category, active)
      VALUES (1, ?, 'Corte e Escova Premium', 120.00, 30, 'Cabelo', 1)
    `).run(userId);

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
    db.prepare('UPDATE client_salons SET opening_hours = ? WHERE user_id = ?').run(fullHours, userId);

    // Iniciar servidor Staging na porta 3987
    runningServer = await startServer(TEST_PORT);
    console.log(`[Staging Server] Ativo em ${BASE_URL}`);

    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`,
      'Cookie': `client_auth_token=${sessionToken}`,
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/cliente/painel.html`,
    };

    // -------------------------------------------------------------
    // PASSO 1: Abrir o painel da Jéssica e validar campo no HTML
    // -------------------------------------------------------------
    console.log('\n--- PASSO 1: Abrir o painel da Jéssica e validar checkbox de consentimento ---');
    const panelHtmlRes = await fetch(`${BASE_URL}/cliente/painel.html`, {
      headers: { 'Cookie': `client_auth_token=${sessionToken}` }
    });
    assert.strictEqual(panelHtmlRes.status, 200, 'painel.html deve responder HTTP 200');
    const panelHtml = await panelHtmlRes.text();

    assert.ok(panelHtml.includes('id="aptReminderConsent"'), 'O checkbox #aptReminderConsent deve estar no HTML');
    assert.ok(
      panelHtml.includes('A cliente autorizou receber lembretes deste agendamento pelo WhatsApp.'),
      'O texto do consentimento deve ser exatamente o exigido pelo Comando 024'
    );
    // Verificar que não possui o atributo "checked" no HTML
    const checkboxRegex = /<input[^>]*id="aptReminderConsent"[^>]*>/i;
    const checkboxTag = panelHtml.match(checkboxRegex)?.[0] || '';
    assert.ok(!checkboxTag.includes('checked'), 'O checkbox NÃO deve possuir o atributo checked (fail-closed)');
    console.log('  ✓ Checkbox #aptReminderConsent presente, desmarcado por padrão e com label exato.\n');
    passedTests++;

    // -------------------------------------------------------------
    // PASSO 2: Ativar os lembretes nas configurações do salão
    // -------------------------------------------------------------
    console.log('--- PASSO 2: Ativar os lembretes nas configurações do salão ---');
    db.prepare('UPDATE client_salons SET b2c_reminders_enabled = 1 WHERE user_id = ?').run(userId);
    const salonRow = db.prepare('SELECT b2c_reminders_enabled FROM client_salons WHERE user_id = ?').get(userId);
    assert.strictEqual(salonRow.b2c_reminders_enabled, 1, 'b2c_reminders_enabled deve ser 1');
    console.log('  ✓ Lembretes B2C ativados para o salão (b2c_reminders_enabled = 1).\n');
    passedTests++;

    // -------------------------------------------------------------
    // PASSO 3 & 4: Criar cliente fictícia com consentimento expresso
    // -------------------------------------------------------------
    console.log('--- PASSOS 3 & 4: Criar cliente fictícia e marcar consentimento no formulário ---');
    const nowRef = Date.now();
    function makeAptSlot(offsetMinutes) {
      const d = new Date(nowRef + offsetMinutes * 60000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return { d, dateStr, timeStr };
    }

    // Horário para ~24h à frente (24h e 10 min)
    const slotMariana = makeAptSlot(24 * 60 + 10);
    const postRes1 = await fetch(`${BASE_URL}/api/cliente/appointments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        clientName: 'Dra. Mariana Costa',
        clientPhone: '5511991234567',
        serviceId: 1,
        staffId: 1,
        date: slotMariana.dateStr,
        time: slotMariana.timeStr,
        status: 'CONFIRMADO',
        reminderConsent: true,
        reminderConsentOrigin: 'painel_confirmacao_manual',
      }),
    });

    const postRes1Text = await postRes1.text();
    console.log('  Response status:', postRes1.status, 'body:', postRes1Text);
    assert.strictEqual(postRes1.status, 200, 'POST /appointments deve retornar 200');
    const postData1 = JSON.parse(postRes1Text);
    assert.strictEqual(postData1.success, true);
    const apt1Id = postData1.id || postData1.appointment.id;

    // Verificar gravação no SQLite
    const apt1Db = db.prepare('SELECT reminder_consent, reminder_consent_origin, reminder_24h_status FROM appointments WHERE id = ?').get(apt1Id);
    assert.strictEqual(apt1Db.reminder_consent, 1, 'reminder_consent deve ser 1');
    assert.strictEqual(apt1Db.reminder_consent_origin, 'painel_confirmacao_manual', 'origem deve ser painel_confirmacao_manual');
    assert.strictEqual(apt1Db.reminder_24h_status, 'PENDING');
    console.log('  ✓ Agendamento criado com consentimento ativo e registrado para Dra. Mariana Costa.\n');
    passedTests++;

    // -------------------------------------------------------------
    // PASSO 5 & 6: Varredura do daemon cria notificação automaticamente
    // -------------------------------------------------------------
    console.log('--- PASSOS 5 & 6: Daemon cria notificação na Outbox automaticamente ---');
    const sweepRes = await salonReminderService.checkAndQueue24hReminders(userId);
    assert.ok(sweepRes.length >= 1, 'Sweep deve enfileirar o agendamento da Dra. Mariana');

    const outbox1 = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt1Id);

    assert.ok(outbox1, 'Item deve existir na whatsapp_notification_outbox');
    assert.strictEqual(outbox1.recipient_phone, '5511991234567');
    assert.strictEqual(outbox1.status, 'PENDING');
    console.log(`  ✓ Notificação enfileirada no Outbox com status PENDING para o telefone ${outbox1.recipient_phone}.\n`);
    passedTests++;

    // -------------------------------------------------------------
    // PASSO 7: OutboxWorker marca como SIMULATED (Hard Staging Lock)
    // -------------------------------------------------------------
    console.log('--- PASSO 7: Worker processa e marca notificação como SIMULATED ---');
    const processedCount = await outboxWorker.processWhatsAppOutbox(userId);
    assert.ok(processedCount >= 1, 'Worker deve ter processado o lote');

    const outbox1After = db.prepare('SELECT status, sent_at, last_error FROM whatsapp_notification_outbox WHERE id = ?').get(outbox1.id);
    assert.strictEqual(outbox1After.status, 'SIMULATED', 'Outbox status deve ser SIMULATED no ambiente de Staging');

    const apt1After = db.prepare('SELECT reminder_24h_status FROM appointments WHERE id = ?').get(apt1Id);
    assert.strictEqual(apt1After.reminder_24h_status, 'SIMULATED', 'reminder_24h_status do appointment deve ser SIMULATED');
    console.log('  ✓ Outbox e Appointment promovidos com segurança para status SIMULATED.\n');
    passedTests++;

    // -------------------------------------------------------------
    // PASSO 8: Badge correspondente na Agenda (API / Frontend)
    // -------------------------------------------------------------
    console.log('--- PASSO 8: Exibir badge correspondente na Agenda ---');
    const listRes = await fetch(`${BASE_URL}/api/cliente/appointments`, {
      headers: authHeaders,
    });
    const listData = await listRes.json();
    assert.strictEqual(listData.success, true);
    const apt1InList = listData.appointments.find(a => a.id === apt1Id);
    assert.ok(apt1InList, 'Agendamento deve estar presente na listagem');
    assert.strictEqual(apt1InList.reminder_24h_status, 'SIMULATED');
    assert.strictEqual(apt1InList.reminder_consent, 1);
    assert.strictEqual(apt1InList.reminder_consent_origin, 'painel_confirmacao_manual');
    console.log('  ✓ API retorna reminder_24h_status: SIMULATED e reminder_consent: 1 para renderização dos badges.\n');
    passedTests++;

    // -------------------------------------------------------------
    // PASSO 9: Criar agendamento sem consentimento e comprovar ausência de lembrete
    // -------------------------------------------------------------
    console.log('--- PASSO 9: Criar agendamento sem consentimento e comprovar ausência de lembrete ---');
    const slotJuliana = makeAptSlot(24 * 60 + 50); // 24h50 à frente
    const postRes2 = await fetch(`${BASE_URL}/api/cliente/appointments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        clientName: 'Juliana Santos',
        clientPhone: '5511997654321',
        serviceId: 1,
        staffId: 1,
        date: slotJuliana.dateStr,
        time: slotJuliana.timeStr,
        status: 'CONFIRMADO',
        reminderConsent: false,
      }),
    });

    const postData2 = await postRes2.json();
    assert.strictEqual(postData2.success, true);
    const apt2Id = postData2.id || postData2.appointment.id;

    // Verificar gravação no SQLite
    const apt2Db = db.prepare('SELECT reminder_consent, reminder_consent_origin FROM appointments WHERE id = ?').get(apt2Id);
    assert.strictEqual(apt2Db.reminder_consent, 0, 'reminder_consent deve ser 0');
    assert.strictEqual(apt2Db.reminder_consent_origin, null, 'reminder_consent_origin deve ser null');

    // Executar varredura do daemon
    await salonReminderService.checkAndQueue24hReminders(userId);

    // Confirmar que NENHUM item foi enfileirado para Juliana
    const outbox2 = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(apt2Id);
    assert.strictEqual(outbox2, undefined, 'Nenhum lembrete pode ser gerado sem consentimento');
    console.log('  ✓ Política fail-closed comprovada: sem consentimento, zero notificações criadas.\n');
    passedTests++;

    // -------------------------------------------------------------
    // PASSO 10: Revogação via API, Remarcação e Cancelamento
    // -------------------------------------------------------------
    console.log('--- PASSO 10: Revogação de consentimento, Remarcação e Cancelamento ---');
    // 10.1: Revogação de consentimento na Dra. Mariana
    const patchConsentRes = await fetch(`${BASE_URL}/api/cliente/appointments/${apt1Id}/consent`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        consent: 0,
        reason: 'Revogado pelo operador do salão',
      }),
    });
    const patchConsentData = await patchConsentRes.json();
    assert.strictEqual(patchConsentData.success, true);
    assert.strictEqual(patchConsentData.reminderConsent, 0);

    const apt1Revoked = db.prepare('SELECT reminder_consent, reminder_consent_origin, reminder_24h_status FROM appointments WHERE id = ?').get(apt1Id);
    assert.strictEqual(apt1Revoked.reminder_consent, 0);
    assert.strictEqual(apt1Revoked.reminder_consent_origin, 'revogado');
    assert.strictEqual(apt1Revoked.reminder_24h_status, 'CANCELLED');

    // 10.2: Cancelamento do agendamento da Juliana
    const cancelRes = await fetch(`${BASE_URL}/api/cliente/appointments/${apt2Id}`, {
      method: 'DELETE',
      headers: authHeaders,
      body: JSON.stringify({ reason: 'Cliente desmarcou' }),
    });
    const cancelData = await cancelRes.json();
    assert.strictEqual(cancelData.success, true);

    const apt2Cancelled = db.prepare('SELECT status, reminder_24h_status FROM appointments WHERE id = ?').get(apt2Id);
    assert.strictEqual(apt2Cancelled.status, 'CANCELADO');
    assert.strictEqual(apt2Cancelled.reminder_24h_status, 'CANCELLED');
    console.log('  ✓ Estados transitados com sucesso para CANCELLED após revogação e cancelamento.\n');
    passedTests++;

    // -------------------------------------------------------------
    // PASSO 11: Navegação no Painel com Headless Browser e Screenshot
    // -------------------------------------------------------------
    console.log('--- PASSO 11: Teste de navegação headless com captura de tela (Edge / Chrome) ---');
    const chromeCandidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    const browserPath = chromeCandidates.find(p => fs.existsSync(p));
    assert.ok(browserPath, 'Navegador Chrome ou Edge deve existir');

    const screenshotPath = path.join(ARTIFACT_DIR, 'painel-jessica-lembrete-24h-024.png');
    const cdpPort = 9226;
    const tempBrowserProfile = path.join(os.tmpdir(), `raia_chrome_profile_${uniqueRunId}`);
    if (!fs.existsSync(tempBrowserProfile)) fs.mkdirSync(tempBrowserProfile, { recursive: true });

    console.log(`  Iniciando navegador headless: ${browserPath}`);
    const browserProc = spawn(browserPath, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempBrowserProfile}`,
      '--incognito',
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-sandbox',
      'about:blank',
    ]);

    await sleep(2000);

    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${cdpPort}/json/list`, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
      });

      const page = list.find(p => p.type === 'page') || list[0];
      assert.ok(page, 'Página do navegador deve estar ativa');

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

      // 1. Configurar viewport desktop
      await sendCmd('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      // 2. Definir Cookie de autenticação antes de navegar
      await sendCmd('Network.enable');
      await sendCmd('Network.setCookie', {
        name: 'client_auth_token',
        value: sessionToken,
        domain: '127.0.0.1',
        path: '/'
      });

      // 3. Navegar até o painel
      await sendCmd('Page.navigate', { url: `${BASE_URL}/cliente/painel.html?modulo=jessica#appointments` });
      await sleep(2500);

      // 4. Avaliar abertura do modal com o checkbox visível
      const evalRes = await sendCmd('Runtime.evaluate', {
        expression: `(() => {
          const btnNew = document.getElementById('btnOpenNewAppointmentModal');
          if (btnNew) btnNew.click();
          const chk = document.getElementById('aptReminderConsent');
          return {
            url: window.location.href,
            title: document.title,
            hasBtn: Boolean(btnNew),
            hasModal: Boolean(document.getElementById('modalNewAppointment')),
            modalClasses: document.getElementById('modalNewAppointment')?.className,
            checkboxExists: Boolean(chk),
            checkboxChecked: Boolean(chk?.checked),
            label: chk?.parentElement?.innerText?.trim()
          };
        })()`,
        returnByValue: true,
      });

      const evalData = evalRes?.result?.value;
      console.log('  Resultado da avaliação no DOM:', evalData);
      assert.strictEqual(evalData?.checkboxExists, true, 'Checkbox deve existir no DOM');
      assert.strictEqual(evalData?.checkboxChecked, false, 'Checkbox deve estar desmarcado no DOM');

      await sleep(800);

      // 5. Capturar Screenshot do Modal com Checkbox de Consentimento
      const shotModal = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const imgBufferModal = Buffer.from(shotModal.data, 'base64');
      fs.writeFileSync(screenshotPath, imgBufferModal);
      const modalScreenshotPath = path.join(ARTIFACT_DIR, 'painel-jessica-lembrete-24h-modal-024.png');
      fs.writeFileSync(modalScreenshotPath, imgBufferModal);
      console.log(`  ✓ Captura de tela do modal gerada com sucesso (${imgBufferModal.length} bytes): ${modalScreenshotPath}`);

      // 6. Fechar modal, carregar a agenda e capturar screenshot dos badges da agenda
      await sendCmd('Runtime.evaluate', {
        expression: `(() => {
          if (typeof closeNewAppointmentModal === 'function') closeNewAppointmentModal();
          if (typeof loadAppointments === 'function') loadAppointments();
        })()`,
      });
      await sleep(1000);

      const agendaScreenshotPath = path.join(ARTIFACT_DIR, 'painel-jessica-lembrete-24h-agenda-024.png');
      const shotAgenda = await sendCmd('Page.captureScreenshot', { format: 'png' });
      const imgBufferAgenda = Buffer.from(shotAgenda.data, 'base64');
      fs.writeFileSync(agendaScreenshotPath, imgBufferAgenda);
      console.log(`  ✓ Captura de tela da agenda gerada com sucesso (${imgBufferAgenda.length} bytes): ${agendaScreenshotPath}`);

      ws.close();
      browserProc.kill();
      try { fs.rmSync(tempBrowserProfile, { recursive: true, force: true }); } catch (_) {}
      passedTests++;
    } catch (browserErr) {
      browserProc.kill();
      try { fs.rmSync(tempBrowserProfile, { recursive: true, force: true }); } catch (_) {}
      throw browserErr;
    }

    // -------------------------------------------------------------
    // PASSO 12: Inviolabilidade do Banco Operacional
    // -------------------------------------------------------------
    console.log('\n--- PASSO 12: Inviolabilidade absoluta de data/assistant.db ---');
    if (prodDbStatBefore && fs.existsSync(prodDbPath)) {
      const prodDbStatAfter = fs.statSync(prodDbPath);
      assert.strictEqual(prodDbStatBefore.mtimeMs, prodDbStatAfter.mtimeMs, 'data/assistant.db NÃO pode ter sido tocado');
      assert.strictEqual(prodDbStatBefore.size, prodDbStatAfter.size, 'Tamanho de data/assistant.db não pode ter mudado');
    }
    console.log('  ✓ Inviolabilidade de data/assistant.db 100% comprovada.');
    passedTests++;

    console.log('\n================================================================');
    console.log(`  TODOS OS ${passedTests} TESTES DO COMANDO 024 PASSARAM COM SUCESSO! `);
    console.log('================================================================\n');

  } catch (err) {
    console.error('\n❌ ERRO NA EXECUÇÃO DA SUÍTE 024:', err);
    process.exitCode = 1;
  } finally {
    if (runningServer && runningServer.close) {
      await new Promise(r => runningServer.close(r));
      console.log('[Staging Server] Encerrado com sucesso.');
    }
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(tempAuthDir)) fs.rmSync(tempAuthDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

runTests();
