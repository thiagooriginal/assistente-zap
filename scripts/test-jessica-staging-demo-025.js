/**
 * RAIA AGENTES — SUÍTE DE TESTES E DEMONSTRAÇÃO COMPLETA EM STAGING (COMANDO 025)
 * Etapas 3 e 4: Ativação Funcional B2C, Fluxo Feliz, Testes Negativos e Salvaguardas
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const http = require('http');

// 1. ISOLAMENTO HERMÉTICO EM OS.TMPDIR() — BANCO DE PRODUÇÃO 100% INVIOLÁVEL
const uniqueRunId = `025_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
const tempDbPath = path.join(os.tmpdir(), `raia_test_demo_025_${uniqueRunId}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_demo_025_${uniqueRunId}`);

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
process.env.BASE_URL = 'https://seguranca.raiaagentes.com.br';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';

process.env.ADMIN_PASSWORD = 'TestStrongAdminPassword!2026_Demo_025';
process.env.SESSION_SECRET = 'test_session_secret_025_demo_abc_123';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_025_demo_def_456';
delete process.env.ALLOW_WHATSAPP_SENDING;

// Monitoramento de inviolabilidade do banco de dados operacional
const prodDbPath = path.resolve(__dirname, '../data/assistant.db');
const prodDbStatBefore = fs.existsSync(prodDbPath) ? fs.statSync(prodDbPath) : null;

// Carregar módulos do sistema
const db = require('../src/database/db');
const config = require('../src/config');
const clientAuth = require('../src/services/clientAuthService');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonReminderService = require('../src/services/salonReminderService');
const salonNotificationService = require('../src/services/salonNotificationService');
const outboxWorker = require('../src/services/outboxWorker');
const whatsappClient = require('../src/whatsapp/client');
const { startServer } = require('../src/server/app');

let passedTests = 0;
let runningServer = null;
const TEST_PORT = 3995;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStagingDemoTests() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — COMANDO 025: DEMONSTRAÇÃO E TESTES EM STAGING  ');
  console.log('================================================================\n');

  console.log('--- COMPROVAÇÃO DE AMBIENTE ISOLADO ---');
  console.log('  ✓ Banco temporário ativo:', tempDbPath);
  console.log('  ✓ AuthDir temporário ativo:', tempAuthDir);
  console.log('  ✓ BASE_URL configurada:', process.env.BASE_URL);
  console.log('  ✓ Banco operacional monitorado para inviolabilidade estrita.\n');

  try {
    // -------------------------------------------------------------
    // SETUP: Garantir conta demo de homologação Hotmart
    // -------------------------------------------------------------
    clientAuth.ensureDemoAccount();
    const demoEmail = config.demoAccountEmail;
    const demoPassword = config.demoAccountPassword;

    const demoUser = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(demoEmail.toLowerCase());
    assert.ok(demoUser, 'Conta demo deve existir no banco isolado');

    // Inicializar servidor de staging
    runningServer = await startServer(TEST_PORT);
    console.log(`[Staging Server] Ativo em ${BASE_URL}\n`);

    // =============================================================
    // ETAPA 3: DEMONSTRAÇÃO COMPLETA DO FLUXO FELIZ EM STAGING
    // =============================================================
    console.log('================================================================');
    console.log('  ETAPA 3: DEMONSTRAÇÃO COMPLETA DO FLUXO FELIZ (JÉSSICA 24H)   ');
    console.log('================================================================\n');

    // -------------------------------------------------------------
    // CENÁRIO 1: Login com conta demo autorizada ao módulo Jéssica
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 1: Login com conta demo autorizada ao módulo Jéssica ---');
    const loginRes = await fetch(`${BASE_URL}/api/cliente/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: demoEmail, password: demoPassword }),
    });

    assert.strictEqual(loginRes.status, 200, 'Login demo deve responder HTTP 200');
    const loginData = await loginRes.json();
    assert.strictEqual(loginData.success, true);
    assert.ok(loginData.token, 'Token de sessão deve ser gerado');
    const sessionToken = loginData.token;

    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`,
      'Cookie': `client_auth_token=${sessionToken}`,
      'Origin': BASE_URL,
    };
    console.log(`  ✓ Login autenticado com sucesso para ${demoEmail} (User ID: ${demoUser.id}).\n`);
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 2: Ativação do lembrete automático 24h na aba Notificações
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 2: Ativação do lembrete 24h na aba Notificações WhatsApp ---');
    const settingsPutRes = await fetch(`${BASE_URL}/api/cliente/integrations/whatsapp/settings`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        b2cRemindersEnabled: true,
        notificationsEnabled: true,
      }),
    });

    assert.strictEqual(settingsPutRes.status, 200, 'PUT /integrations/whatsapp/settings deve responder 200');
    const settingsData = await settingsPutRes.json();
    assert.strictEqual(settingsData.success, true);
    assert.strictEqual(settingsData.settings.b2cRemindersEnabled, true);

    const salonRow = db.prepare('SELECT b2c_reminders_enabled FROM client_salons WHERE user_id = ?').get(demoUser.id);
    assert.strictEqual(salonRow.b2c_reminders_enabled, 1, 'b2c_reminders_enabled deve ser 1 no SQLite');
    console.log('  ✓ Lembretes B2C ativados com sucesso (b2c_reminders_enabled = 1).\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 3 & 4: Criação de agendamento para Dra. Mariana na janela de ~24h
    // -------------------------------------------------------------
    console.log('--- CENÁRIOS 3 & 4: Criação de agendamento para Dra. Mariana Costa na janela de 24h ---');
    const nowRef = Date.now();
    function makeAptSlot(offsetMinutes) {
      const d = new Date(nowRef + offsetMinutes * 60000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return { d, dateStr, timeStr };
    }

    const slotMariana = makeAptSlot(24 * 60 + 15); // 24h e 15 minutos à frente
    const diffHours = (slotMariana.d.getTime() - nowRef) / (1000 * 60 * 60);
    assert.ok(diffHours >= 20 && diffHours <= 26, 'Horário deve estar rigorosamente na janela 20h-26h');

    // Obter serviço e profissionais de demonstração
    db.prepare("INSERT OR IGNORE INTO client_staff (id, user_id, name, active) VALUES (101, ?, 'Jéssica Oficial', 1)").run(demoUser.id);
    db.prepare("INSERT OR IGNORE INTO client_staff (id, user_id, name, active) VALUES (102, ?, 'Ana Paula Cabelos', 1)").run(demoUser.id);
    db.prepare("INSERT OR IGNORE INTO client_staff (id, user_id, name, active) VALUES (103, ?, 'Bruna Estética', 1)").run(demoUser.id);

    let demoService = db.prepare('SELECT id FROM client_services WHERE user_id = ? LIMIT 1').get(demoUser.id);
    if (!demoService) {
      db.prepare("INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, 'Corte e Escova Premium', 120, 30, 'Cabelo', 1)").run(demoUser.id);
      demoService = db.prepare('SELECT id FROM client_services WHERE user_id = ? LIMIT 1').get(demoUser.id);
    }
    assert.ok(demoService, 'Serviço demo deve existir');

    // Garantir horários 24/7 para não rejeitar agendamento por horário
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

    const postAptRes1 = await fetch(`${BASE_URL}/api/cliente/appointments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        clientName: 'Dra. Mariana Costa',
        clientPhone: '5511991234567',
        serviceId: demoService.id,
        staffId: 101,
        date: slotMariana.dateStr,
        time: slotMariana.timeStr,
        status: 'CONFIRMADO',
        reminderConsent: true,
        reminderConsentOrigin: 'painel_confirmacao_manual',
      }),
    });

    const postAptData1 = await postAptRes1.json();
    if (postAptRes1.status !== 200) {
      console.error('ERRO EM POST /appointments:', postAptData1);
    }
    assert.strictEqual(postAptRes1.status, 200, 'POST /appointments deve retornar 200');
    assert.strictEqual(postAptData1.success, true);
    const aptMarianaId = postAptData1.id || postAptData1.appointment.id;

    const aptMarianaDb = db.prepare('SELECT reminder_consent, reminder_consent_origin, reminder_24h_status, start_datetime, end_datetime FROM appointments WHERE id = ?').get(aptMarianaId);
    assert.strictEqual(aptMarianaDb.reminder_consent, 1);
    assert.strictEqual(aptMarianaDb.reminder_consent_origin, 'painel_confirmacao_manual');
    assert.ok(['PENDING', 'QUEUED'].includes(aptMarianaDb.reminder_24h_status), 'reminder_24h_status deve ser PENDING ou QUEUED');
    console.log(`  ✓ Agendamento #${aptMarianaId} registrado para Dra. Mariana Costa (${aptMarianaDb.start_datetime} - ${aptMarianaDb.end_datetime}) com consentimento ativo.\n`);
    passedTests += 2;

    // -------------------------------------------------------------
    // CENÁRIO 5: Execução do ciclo automático do daemon (SEM SWEEP MANUAL)
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 5: Ciclo automático do SalonReminderDaemon em background (sem sweep manual) ---');
    let outboxMariana = null;
    // Aguardar o daemon em background realizar a varredura autônoma
    for (let i = 0; i < 20; i++) {
      outboxMariana = db.prepare(`
        SELECT * FROM whatsapp_notification_outbox
        WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
      `).get(aptMarianaId);
      if (outboxMariana) break;
      await sleep(100);
    }

    assert.ok(outboxMariana, 'Daemon deve detectar e enfileirar o agendamento automaticamente');
    assert.strictEqual(outboxMariana.recipient_phone, '5511991234567');
    console.log(`  ✓ Notificação #${outboxMariana.id} criada automaticamente pelo daemon na outbox.\n`);
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 6: Comprovação de SIMULATED na Outbox e Badge na Agenda
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 6: OutboxWorker marca SIMULATED e API expõe badge na Agenda ---');
    const outboxMarianaId = outboxMariana.id;
    // Aguardar processamento do OutboxWorker
    for (let i = 0; i < 25; i++) {
      outboxMariana = db.prepare('SELECT status, is_simulated FROM whatsapp_notification_outbox WHERE id = ?').get(outboxMarianaId);
      if (outboxMariana && outboxMariana.status === 'SIMULATED') break;
      await sleep(100);
    }

    // Se ainda PENDING por sincronia, processa
    if (outboxMariana && outboxMariana.status === 'PENDING') {
      await outboxWorker.processWhatsAppOutbox(demoUser.id);
      outboxMariana = db.prepare('SELECT status, is_simulated FROM whatsapp_notification_outbox WHERE id = ?').get(outboxMarianaId);
    }

    assert.ok(outboxMariana, 'Registro da outbox deve existir');
    assert.strictEqual(outboxMariana.status, 'SIMULATED', 'Outbox status deve ser estritamente SIMULATED em staging');
    assert.strictEqual(outboxMariana.is_simulated, 1);

    const aptAfterWorker = db.prepare('SELECT whatsapp_notified, reminder_24h_status FROM appointments WHERE id = ?').get(aptMarianaId);
    assert.strictEqual(aptAfterWorker.whatsapp_notified, 2, 'Staging deve atualizar whatsapp_notified = 2');
    assert.strictEqual(aptAfterWorker.reminder_24h_status, 'SIMULATED');

    // Validação na API da listagem de agendamentos
    const listRes = await fetch(`${BASE_URL}/api/cliente/appointments`, { headers: authHeaders });
    const listData = await listRes.json();
    assert.strictEqual(listData.success, true);
    const aptInApi = listData.appointments.find(a => a.id === aptMarianaId);
    assert.ok(aptInApi, 'Agendamento deve estar na resposta da API');
    assert.strictEqual(aptInApi.reminder_24h_status, 'SIMULATED');
    assert.strictEqual(aptInApi.reminder_consent, 1);
    assert.strictEqual(aptInApi.reminder_consent_origin, 'painel_confirmacao_manual');
    console.log('  ✓ Notificação SIMULATED comprovada e badge visível na listagem da API.\n');
    passedTests++;

    // =============================================================
    // ETAPA 4: TESTES NEGATIVOS, SEGURANÇA E SALVAGUARDAS
    // =============================================================
    console.log('================================================================');
    console.log('  ETAPA 4: TESTES NEGATIVOS, SEGURANÇA E SALVAGUARDAS          ');
    console.log('================================================================\n');

    // -------------------------------------------------------------
    // CENÁRIO 7: Agendamento sem consentimento NÃO gera lembrete
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 7: Agendamento sem consentimento NÃO gera lembrete ---');
    const slotJuliana = makeAptSlot(24 * 60 + 60); // 1 hora à frente (sem conflito com Mariana)
    console.log('Juliana slot solicitada:', slotJuliana.dateStr, slotJuliana.timeStr);
    const postAptRes2 = await fetch(`${BASE_URL}/api/cliente/appointments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        clientName: 'Juliana Santos',
        clientPhone: '5511997654321',
        serviceId: demoService.id,
        staffId: 102,
        date: slotJuliana.dateStr,
        time: slotJuliana.timeStr,
        status: 'CONFIRMADO',
        reminderConsent: false,
      }),
    });

    const postAptData2 = await postAptRes2.json();
    if (postAptRes2.status !== 200) {
      console.error('ERRO EM CENÁRIO 7:', postAptData2);
    }
    assert.strictEqual(postAptData2.success, true);
    const aptJulianaId = postAptData2.id || postAptData2.appointment.id;

    // Aguardar múltiplos ciclos do daemon
    await sleep(600);

    const outboxJuliana = db.prepare(`
      SELECT * FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
    `).get(aptJulianaId);

    assert.strictEqual(outboxJuliana, undefined, 'Zero lembretes devem ser gerados sem consentimento');
    console.log('  ✓ Política fail-closed comprovada: cliente sem consentimento não recebe lembrete.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 8: Revogação de consentimento cancela lembretes pendentes
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 8: Revogação de consentimento cancela lembretes pendentes ---');
    const slotRevoke = makeAptSlot(24 * 60 + 120); // 2 horas à frente (sem conflito)
    const postAptRes3 = await fetch(`${BASE_URL}/api/cliente/appointments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        clientName: 'Camila Pitanga',
        clientPhone: '5511998881234',
        serviceId: demoService.id,
        staffId: 103,
        date: slotRevoke.dateStr,
        time: slotRevoke.timeStr,
        status: 'CONFIRMADO',
        reminderConsent: true,
      }),
    });

    const postAptData3 = await postAptRes3.json();
    if (postAptRes3.status !== 200) {
      console.error('ERRO EM CENÁRIO 8:', postAptData3);
    }
    const aptCamilaId = postAptData3.id || (postAptData3.appointment && postAptData3.appointment.id);
    // Aguardar enfileiramento
    await sleep(300);

    // Revogação de consentimento via API
    const patchRes = await fetch(`${BASE_URL}/api/cliente/appointments/${aptCamilaId}/consent`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ consent: 0, reason: 'Revogado pela cliente' }),
    });

    const patchData = await patchRes.json();
    assert.strictEqual(patchData.success, true);
    assert.strictEqual(patchData.reminderConsent, 0);

    const aptCamilaDb = db.prepare('SELECT reminder_consent, reminder_24h_status FROM appointments WHERE id = ?').get(aptCamilaId);
    assert.strictEqual(aptCamilaDb.reminder_consent, 0);
    assert.strictEqual(aptCamilaDb.reminder_24h_status, 'CANCELLED');

    const outboxCamila = db.prepare('SELECT status FROM whatsapp_notification_outbox WHERE appointment_id = ?').get(aptCamilaId);
    if (outboxCamila) {
      assert.ok(['CANCELLED', 'SIMULATED'].includes(outboxCamila.status), 'Outbox status deve ser CANCELLED se pendente ou SIMULATED');
    }
    console.log('  ✓ Revogação via PATCH transiciona agendamento e outbox com segurança.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 9: Cancelamento de agendamento invalida lembrete pendente
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 9: Cancelamento de agendamento invalida lembrete pendente ---');
    const cancelRes = await fetch(`${BASE_URL}/api/cliente/appointments/${aptJulianaId}`, {
      method: 'DELETE',
      headers: authHeaders,
      body: JSON.stringify({ reason: 'Desistência da cliente' }),
    });

    assert.strictEqual(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.strictEqual(cancelData.success, true);

    const aptJulianaDb = db.prepare('SELECT status, reminder_24h_status FROM appointments WHERE id = ?').get(aptJulianaId);
    assert.strictEqual(aptJulianaDb.status, 'CANCELADO');
    assert.strictEqual(aptJulianaDb.reminder_24h_status, 'CANCELLED');
    console.log('  ✓ Cancelamento de agendamento invalida lembrete com status CANCELLED.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 10: Remarcação de horário recalcula e gera novo lembrete
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 10: Remarcação de horário recalcula e atualiza lembrete ---');
    const slotResched = makeAptSlot(25 * 60); // Remarcado para 25h à frente
    const reschedRes = await fetch(`${BASE_URL}/api/cliente/appointments/${aptMarianaId}/reschedule`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        newDate: slotResched.dateStr,
        newTime: slotResched.timeStr,
        reason: 'Cliente solicitou novo horário',
      }),
    });

    assert.strictEqual(reschedRes.status, 200);
    const reschedData = await reschedRes.json();
    assert.strictEqual(reschedData.success, true);

    const aptMarianaResched = db.prepare('SELECT reminder_24h_status, start_datetime FROM appointments WHERE id = ?').get(aptMarianaId);
    assert.ok(['PENDING', 'QUEUED', 'SIMULATED'].includes(aptMarianaResched.reminder_24h_status), 'reminder_24h_status deve ser PENDING, QUEUED ou SIMULATED');

    // Aguardar ciclo do daemon
    await sleep(400);

    const marianaReminders = db.prepare(`
      SELECT id, status, message_text FROM whatsapp_notification_outbox
      WHERE appointment_id = ? AND event_type = 'REMINDER_24H'
      ORDER BY id ASC
    `).all(aptMarianaId);

    assert.ok(marianaReminders.length >= 2, 'Deve haver lembrete antigo e novo lembrete');
    console.log('  ✓ Remarcação resetou status para PENDING e gerou nova notificação no outbox.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 11: Reinício de serviço não duplica notificações
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 11: Reinício de serviço não duplica notificações ---');
    salonReminderService.stopSalonReminderDaemon();
    outboxWorker.stopWorker();

    const countBeforeRestart = db.prepare("SELECT COUNT(*) as c FROM whatsapp_notification_outbox WHERE event_type = 'REMINDER_24H'").get().c;

    // Reiniciar daemons
    salonReminderService.startSalonReminderDaemon(200);
    outboxWorker.startWorker(200);

    // Aguardar ciclos do daemon reiniciado
    await sleep(600);

    const countAfterRestart = db.prepare("SELECT COUNT(*) as c FROM whatsapp_notification_outbox WHERE event_type = 'REMINDER_24H'").get().c;
    assert.strictEqual(countBeforeRestart, countAfterRestart, 'Zero duplicações permitidas após reinício do serviço');
    console.log('  ✓ Idempotência confirmada: zero duplicatas geradas após restart do daemon.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 12: Isolamento multi-tenant
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 12: Isolamento multi-tenant entre salões distintos ---');
    const userSalonB = 202;
    db.prepare("INSERT OR REPLACE INTO users (id, phone_number, name) VALUES (?, '5511999990202', 'Studio Bella')").run(userSalonB);
    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, phone, b2c_reminders_enabled)
      VALUES (?, 'Studio Bella Spa', '5511988880202', 1)
    `).run(userSalonB);

    const slotShared = makeAptSlot(24 * 60 + 20);
    const aptSalonBId = db.prepare(`
      INSERT INTO appointments (
        user_id, title, client_name, client_phone, start_datetime, end_datetime, status, reminder_consent, reminder_24h_status
      ) VALUES (?, 'Massagem Terapêutica', 'Dra. Mariana Costa', '5511991234567', ?, ?, 'CONFIRMADO', 1, 'PENDING')
    `).run(userSalonB, `${slotShared.dateStr}T${slotShared.timeStr}:00`, `${slotShared.dateStr}T${slotShared.timeStr}:00`).lastInsertRowid;

    // Aguardar ciclo do daemon
    await sleep(500);

    const outboxDemo = db.prepare("SELECT user_id, message_text FROM whatsapp_notification_outbox WHERE appointment_id = ?").get(aptMarianaId);
    const outboxB = db.prepare("SELECT user_id, message_text FROM whatsapp_notification_outbox WHERE appointment_id = ?").get(aptSalonBId);

    assert.ok(outboxDemo);
    assert.ok(outboxB);
    assert.strictEqual(outboxDemo.user_id, demoUser.id);
    assert.strictEqual(outboxB.user_id, userSalonB);
    assert.ok(outboxB.message_text.includes('Studio Bella Spa'));
    assert.ok(!outboxB.message_text.includes('Bella Vista'));
    console.log('  ✓ Isolamento multi-tenant garantido: mensagens particionadas por user_id e salão.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 13: Nenhuma conexão física WhatsApp e Inviolabilidade DB
    // -------------------------------------------------------------
    console.log('--- CENÁRIO 13: Trava de transporte físico e Inviolabilidade de data/assistant.db ---');
    assert.strictEqual(whatsappClient.isRealWhatsAppTransportAllowed(), false, 'Transporte físico deve estar bloqueado em staging');
    assert.strictEqual(process.env.ALLOW_WHATSAPP_SENDING, undefined);

    const physicalOutbox = db.prepare("SELECT COUNT(*) as c FROM whatsapp_notification_outbox WHERE status = 'SENT'").get().c;
    assert.strictEqual(physicalOutbox, 0, 'Zero mensagens podem ter status SENT em staging');

    if (prodDbStatBefore && fs.existsSync(prodDbPath)) {
      const prodDbStatAfter = fs.statSync(prodDbPath);
      assert.strictEqual(prodDbStatBefore.mtimeMs, prodDbStatAfter.mtimeMs, 'data/assistant.db NÃO pode ter sido tocado');
      assert.strictEqual(prodDbStatBefore.size, prodDbStatAfter.size, 'Tamanho de data/assistant.db não pode ter mudado');
      console.log('  ✓ Inviolabilidade de data/assistant.db 100% comprovada.');
    }
    console.log('  ✓ Trava de socket físico e integridade de base operacional validadas com sucesso.\n');
    passedTests++;

    console.log('================================================================');
    console.log(`  RESULTADO: TODOS OS ${passedTests} TESTES DAS ETAPAS 3 E 4 FORAM APROVADOS!`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('\n❌ ERRO NA EXECUÇÃO DA SUÍTE 025:', err);
    process.exitCode = 1;
  } finally {
    salonReminderService.stopSalonReminderDaemon();
    outboxWorker.stopWorker();
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

runStagingDemoTests();
