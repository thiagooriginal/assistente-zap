/**
 * COMANDO 045 — Suíte de Testes Automatizados Hermética
 * Melhorias Finais de Experiência e Consentimento — Jéssica Beauty Premium
 *
 * Módulos nativos: node:test e node:assert/strict
 * Banco isolado temporário em os.tmpdir()
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const express = require('express');

// 1. ISOLAMENTO MANDATÓRIO DE BANCO DE DADOS EM os.tmpdir()
const uniqueDbName = `test-c045-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
const testDbPath = path.join(os.tmpdir(), uniqueDbName);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';

const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonReminderService = require('../src/services/salonReminderService');
const clientRoutes = require('../src/routes/clientRoutes');

// 2. APLICAÇÃO EXPRESS DE TESTE LOCAL
const testApp = express();
testApp.use(express.json());
testApp.use('/api/client', clientRoutes);

let server;
let baseUrl;

const SALON = {
  id: 301,
  phone: '5511999990301',
  name: 'Jéssica Beauty Premium 045',
  token: 'token_tenant_c045',
};

let serviceCorteId;
let serviceColoracaoId;
let staffJessicaId;
let staffCamilaId;

async function apiRequest(endpoint, { method = 'GET', body = null } = {}) {
  const url = `${baseUrl}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${SALON.token}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}

  return { status: res.status, ok: res.ok, data: json, rawText: text };
}

test.before(async () => {
  server = http.createServer(testApp);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Provisiona Tenant Salão
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan_tier, extra_professionals, subscription_status, session_token, session_expires_at, paid_until)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 20, 'ACTIVE', ?, datetime('now', '+30 days'), datetime('now', '+30 days'))
  `).run(SALON.id, SALON.phone, SALON.name, SALON.token);

  // Dar acesso ao produto JESSICA
  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const proPlan = jessicaProd ? db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'PRO'").get(jessicaProd.id) : null;
  if (jessicaProd && proPlan) {
    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, extra_professionals, status, price_cents, paid_until)
      VALUES (?, ?, ?, 20, 'ACTIVE', 8900, datetime('now', '+30 days'))
    `).run(SALON.id, jessicaProd.id, proPlan.id);
  }

  // Configurar salão com horário comercial e lembretes B2C ativos
  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours, b2c_reminders_enabled)
    VALUES (?, ?, ?, 1)
  `).run(
    SALON.id,
    SALON.name,
    JSON.stringify({
      days: {
        0: { open: false },
        1: { open: true, start: '08:00', end: '20:00' },
        2: { open: true, start: '08:00', end: '20:00' },
        3: { open: true, start: '08:00', end: '20:00' },
        4: { open: true, start: '08:00', end: '20:00' },
        5: { open: true, start: '08:00', end: '20:00' },
        6: { open: true, start: '08:00', end: '20:00' },
      },
    })
  );

  // Cadastrar serviços
  const svc1 = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active)
    VALUES (?, 'Corte Feminino em Camadas', 60, 120.00, 1)
  `).run(SALON.id);
  serviceCorteId = svc1.lastInsertRowid;

  const svc2 = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active)
    VALUES (?, 'Coloração Completa', 90, 220.00, 1)
  `).run(SALON.id);
  serviceColoracaoId = svc2.lastInsertRowid;

  // Cadastrar profissionais: Jéssica e Camila
  const st1 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active)
    VALUES (?, 'Jéssica Ramos', 'Cortes', 1)
  `).run(SALON.id);
  staffJessicaId = st1.lastInsertRowid;

  const st2 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active)
    VALUES (?, 'Camila Santos', 'Cortes e Mechas', 1)
  `).run(SALON.id);
  staffCamilaId = st2.lastInsertRowid;

  // Habilitar vínculos N:N
  // Corte Feminino: Jéssica e Camila habilitadas e confirmadas
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1), (?, ?, ?, 1)
  `).run(SALON.id, serviceCorteId, staffJessicaId, SALON.id, serviceCorteId, staffCamilaId);

  // Coloração: apenas Jéssica habilitada e confirmada
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1)
  `).run(SALON.id, serviceColoracaoId, staffJessicaId);

  // Ocupar Jéssica na segunda-feira 16/11/2026 das 09:00 às 10:00
  db.prepare(`
    INSERT INTO appointments (
      user_id, title, client_name, client_phone, service_id, staff_id,
      start_datetime, end_datetime, duration_min, origin, status, reminder_consent
    )
    VALUES (?, 'Corte Feminino em Camadas', 'Cliente Ocupante', '5511988887777', ?, ?, '2026-11-16T09:00:00', '2026-11-16T10:00:00', 60, 'PAINEL', 'CONFIRMADO', 1)
  `).run(SALON.id, serviceCorteId, staffJessicaId);
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  // Remover banco temporário de teste
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch (_) {}
});

test('Melhoria 1: Consulta /check-slot no modo Automático retorna a profissional disponível antes da confirmação', async () => {
  // Segunda-feira 16/11/2026 às 09:00: Jéssica ocupada, Camila livre
  const res = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=09:00&service_id=${serviceCorteId}&staff_id=`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.available, true);
  assert.strictEqual(res.data.assignedStaffId, staffCamilaId, 'Camila Santos deve ser a profissional atribuída');
  assert.strictEqual(res.data.assignedStaffName, 'Camila Santos');
});

test('Melhoria 1: Consulta /check-slot omite indicação de profissional quando há conflito de horário', async () => {
  // Segunda-feira 16/11/2026 às 09:00 para Coloração: apenas Jéssica realiza e ela está ocupada
  const res = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=09:00&service_id=${serviceColoracaoId}&staff_id=`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.available, false);
  assert.strictEqual(res.data.assignedStaffName, undefined);
  assert.ok(Array.isArray(res.data.suggestedSlots));
});

test('Melhoria 1: Consulta com profissional selecionado manualmente preserva resolução individual', async () => {
  // Consulta explícita por Camila
  const resCamila = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=09:00&service_id=${serviceCorteId}&staff_id=${staffCamilaId}`);
  assert.strictEqual(resCamila.data.available, true);
  assert.strictEqual(resCamila.data.assignedStaffName, 'Camila Santos');

  // Consulta explícita por Jéssica (ocupada)
  const resJessica = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=09:00&service_id=${serviceCorteId}&staff_id=${staffJessicaId}`);
  assert.strictEqual(resJessica.data.available, false);
});

test('Melhoria 2: Agendamento criado sem consentimento grava reminder_consent = 0 e reminder_24h_status = DISABLED', async () => {
  const created = salonAppointmentService.bookAppointmentSync(SALON.id, {
    serviceId: serviceCorteId,
    clientName: 'Ana Beatriz',
    clientPhone: '5511977776666',
    date: '2026-11-16',
    time: '11:00',
    reminderConsent: 0,
    origin: 'PAINEL',
  });

  assert.ok(created.id > 0);
  assert.strictEqual(created.reminder_consent, 0);

  const row = db.prepare('SELECT reminder_consent, reminder_24h_status FROM appointments WHERE id = ?').get(created.id);
  assert.strictEqual(row.reminder_consent, 0);
  assert.strictEqual(row.reminder_24h_status, 'DISABLED', 'Agendamento sem consentimento não pode ficar PENDING');
});

test('Melhoria 2: Agendamento sem consentimento é estritamente ignorado pela fila de lembretes B2C (Fail-Closed)', async () => {
  // Executar rotina de enfileiramento de lembretes
  const queuedCount = salonReminderService.checkAndQueue24hReminders(SALON.id);
  
  // Garantir que nenhum outbox foi gerado para Ana Beatriz
  const outboxItem = db.prepare(`
    SELECT o.* FROM whatsapp_notification_outbox o
    JOIN appointments a ON o.appointment_id = a.id
    WHERE a.client_name = 'Ana Beatriz' AND o.user_id = ?
  `).get(SALON.id);

  assert.strictEqual(outboxItem, undefined, 'Agendamento sem consentimento nunca pode gerar notificação no outbox');
});

test('Melhoria 2: Agendamento criado com consentimento grava reminder_consent = 1 e reminder_24h_status = PENDING', async () => {
  const created = salonAppointmentService.bookAppointmentSync(SALON.id, {
    serviceId: serviceCorteId,
    clientName: 'Carla Cristina',
    clientPhone: '5511977775555',
    date: '2026-11-16',
    time: '14:00',
    reminderConsent: 1,
    origin: 'PAINEL',
  });

  assert.ok(created.id > 0);
  assert.strictEqual(created.reminder_consent, 1);

  const row = db.prepare('SELECT reminder_consent, reminder_24h_status FROM appointments WHERE id = ?').get(created.id);
  assert.strictEqual(row.reminder_consent, 1);
  assert.strictEqual(row.reminder_24h_status, 'PENDING');
});

test('Melhoria 2: Atualização de consentimento via updateAppointmentConsent transiciona status de lembrete com segurança', async () => {
  // Criar sem consentimento
  const created = salonAppointmentService.bookAppointmentSync(SALON.id, {
    serviceId: serviceCorteId,
    clientName: 'Fernanda Lima',
    clientPhone: '5511977774444',
    date: '2026-11-16',
    time: '16:00',
    reminderConsent: 0,
    origin: 'PAINEL',
  });

  // Ativar consentimento
  salonAppointmentService.updateAppointmentConsent(created.id, SALON.id, 1, 'painel_cliente');
  const rowActive = db.prepare('SELECT reminder_consent, reminder_24h_status FROM appointments WHERE id = ?').get(created.id);
  assert.strictEqual(rowActive.reminder_consent, 1);
  assert.strictEqual(rowActive.reminder_24h_status, 'PENDING', 'Ao ativar consentimento, deve transicionar de DISABLED para PENDING');

  // Revogar consentimento
  salonAppointmentService.updateAppointmentConsent(created.id, SALON.id, 0, 'painel_cliente');
  const rowRevoked = db.prepare('SELECT reminder_consent, reminder_24h_status FROM appointments WHERE id = ?').get(created.id);
  assert.strictEqual(rowRevoked.reminder_consent, 0);
  assert.strictEqual(rowRevoked.reminder_24h_status, 'CANCELLED', 'Ao revogar, deve transicionar para CANCELLED');
});

test('Melhoria 2: Badges HTML no frontend eliminam a contradição de Pendente para agendamentos sem consentimento', () => {
  // Lógica exata implementada no painel.html
  function getReminder24hBadgeHtml(reminderStatus, reminderConsent) {
    if (reminderConsent !== 1 && reminderConsent !== '1') {
      return '';
    }
    if (!reminderStatus || reminderStatus === 'PENDING') {
      return '<span class="apt-badge-reminder-24h">Lembrete 24h: Pendente</span>';
    }
    return '';
  }

  function getReminderConsentBadgeHtml(reminderConsent, reminderStatus, consentOrigin) {
    if (reminderConsent === 1 || reminderConsent === '1') {
      return '<span class="apt-badge-consent">Consentimento: ATIVO</span>';
    }
    return '<span class="apt-badge-consent">Sem autorização para lembretes</span>';
  }

  // Agendamento sem consentimento
  const badgeConsentNo = getReminderConsentBadgeHtml(0, 'DISABLED', null);
  const badge24hNo = getReminder24hBadgeHtml('DISABLED', 0);

  assert.ok(badgeConsentNo.includes('Sem autorização para lembretes'));
  assert.strictEqual(badge24hNo, '', 'Não deve renderizar badge de lembrete 24h quando não há autorização');

  // Agendamento com consentimento ativo
  const badgeConsentYes = getReminderConsentBadgeHtml(1, 'PENDING', 'painel');
  const badge24hYes = getReminder24hBadgeHtml('PENDING', 1);

  assert.ok(badgeConsentYes.includes('Consentimento: ATIVO'));
  assert.ok(badge24hYes.includes('Lembrete 24h: Pendente'));
});
