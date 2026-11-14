/**
 * COMANDO 042.1 — Suíte de Testes Automatizados Hermética
 * Correção de Falso Conflito na Seleção Automática de Profissionais (Jéssica Beauty)
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
const uniqueDbName = `test-c042-1-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
const clientRoutes = require('../src/routes/clientRoutes');

// 2. APLICAÇÃO EXPRESS DE TESTE LOCAL
const testApp = express();
testApp.use(express.json());
testApp.use('/api/client', clientRoutes);

let server;
let baseUrl;

const SALON = {
  id: 201,
  phone: '5511999990201',
  name: 'Jéssica Beauty Premium',
  token: 'token_tenant_c042_1',
};

let serviceId;
let staffJessicaId;
let staffCamilaId;
let staffRafaelId;

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

  return { status: res.status, ok: res.ok, body: json, text };
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

  // Segunda a Sábado aberto das 08:00 às 20:00 (sem intervalo de almoço fechado para testes de conflito)
  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours)
    VALUES (?, ?, ?)
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

  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const proPlan = jessicaProd ? db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'PRO'").get(jessicaProd.id) : null;
  if (jessicaProd && proPlan) {
    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, extra_professionals, status, price_cents, paid_until)
      VALUES (?, ?, ?, 20, 'ACTIVE', 8900, datetime('now', '+30 days'))
    `).run(SALON.id, jessicaProd.id, proPlan.id);
  }

  // Cadastra Serviço: Corte Feminino em Camadas (60 minutos)
  const svcInfo = db.prepare(`
    INSERT INTO client_services (user_id, name, price, duration_min, category, active)
    VALUES (?, 'Corte Feminino em Camadas', 120.00, 60, 'Cabelos', 1)
  `).run(SALON.id);
  serviceId = svcInfo.lastInsertRowid;

  // Cadastra Profissionais
  // 1. Jéssica Ramos (habilitada e confirmada)
  const st1 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active)
    VALUES (?, 'Jéssica Ramos', 'Especialista em Cortes', 1)
  `).run(SALON.id);
  staffJessicaId = st1.lastInsertRowid;

  // 2. Camila Santos (habilitada e confirmada)
  const st2 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active)
    VALUES (?, 'Camila Santos', 'Cabeleireira Master', 1)
  `).run(SALON.id);
  staffCamilaId = st2.lastInsertRowid;

  // 3. Rafael Barber (ativo mas NÃO habilitado para Corte Feminino)
  const st3 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active)
    VALUES (?, 'Rafael Barber', 'Barbeiro', 1)
  `).run(SALON.id);
  staffRafaelId = st3.lastInsertRowid;

  // Vincula Jéssica e Camila ao serviço com confirmed = 1
  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1)
  `).run(SALON.id, serviceId, staffJessicaId);

  db.prepare(`
    INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, ?, ?, 1)
  `).run(SALON.id, serviceId, staffCamilaId);

  // Insere agendamento existente: Jéssica Ramos ocupada das 09:00 às 10:00 em 2026-11-16
  db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, service_id, staff_id, start_datetime, end_datetime, status, duration_min)
    VALUES (?, 'Corte Feminino em Camadas', 'Cliente Mariana', '5511988887777', ?, ?, '2026-11-16T09:00:00', '2026-11-16T10:00:00', 'AGENDADO', 60)
  `).run(SALON.id, serviceId, staffJessicaId);
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (db && typeof db.close === 'function') db.close();
  } catch (_) {}

  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (_) {}
});

test('Cenário 1 (Reprodução do Staging): Jéssica ocupada às 09:00 e Camila livre -> Automático deve permitir 09:00 sem falso conflito', async () => {
  // Chamada check-slot para 2026-11-16 às 09:00 com staff_id vazio (Automático)
  const res = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=09:00&service_id=${serviceId}&staff_id=`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.available, true, 'O horário 09:00 deve ser considerado disponível pois Camila está livre');
  assert.strictEqual(res.body.assignedStaffId, staffCamilaId, 'A profissional designada deve ser Camila Santos');
});

test('Cenário 2: Consistência entre horários livres e check-slot (09:00 aparece na lista de disponíveis)', async () => {
  const res = await apiRequest(`/api/client/appointments/available-slots?date=2026-11-16&service_id=${serviceId}&staff_id=&limit=50`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(Array.isArray(res.body.slots));
  assert.ok(res.body.slots.includes('09:00'), 'A lista de horários livres DEVE conter 09:00, em perfeita consonância com check-slot');
});

test('Cenário 3: O agendamento automático às 09:00 deve ser atribuído nominalmente à Camila (staff_id nunca nulo)', async () => {
  const res = await apiRequest('/api/client/appointments', {
    method: 'POST',
    body: {
      clientName: 'Ana Beatriz',
      clientPhone: '5511999991111',
      serviceId,
      staffId: '', // Automático
      date: '2026-11-16',
      time: '09:00',
    },
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  const aptId = res.body.id;
  assert.ok(aptId);

  // Consulta direta no SQLite para conferir persistência nominal
  const apt = db.prepare('SELECT id, staff_id, start_datetime, end_datetime FROM appointments WHERE id = ?').get(aptId);
  assert.strictEqual(apt.staff_id, staffCamilaId, 'O agendamento automático DEVE persistir nominalmente o ID de Camila Santos');
  assert.notStrictEqual(apt.staff_id, null, 'O staff_id NUNCA pode ser NULL');
});

test('Cenário 4: Preservação de agendamentos simultâneos entre profissionais distintos', async () => {
  // Neste momento, às 09:00 de 2026-11-16, temos dois agendamentos simultâneos: Jéssica e Camila
  const apts = db.prepare(`
    SELECT id, client_name, staff_id, start_datetime, end_datetime
    FROM appointments
    WHERE user_id = ? AND start_datetime = '2026-11-16T09:00:00' AND status = 'AGENDADO'
  `).all(SALON.id);

  assert.strictEqual(apts.length, 2, 'Devem coexistir 2 agendamentos simultâneos para profissionais distintas');
  const staffIds = apts.map(a => a.staff_id).sort();
  assert.deepStrictEqual(staffIds, [staffJessicaId, staffCamilaId].sort());
});

test('Cenário 5: Conflito real quando todos os profissionais habilitados estão ocupados (Jéssica e Camila ocupadas)', async () => {
  // Agora tanto Jéssica quanto Camila estão ocupadas das 09:00 às 10:00
  // Tentativa de check-slot para 09:00 no modo Automático deve retornar available = false
  const checkRes = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=09:00&service_id=${serviceId}&staff_id=`);
  assert.strictEqual(checkRes.status, 200);
  assert.strictEqual(checkRes.body.available, false, 'Com todas as habilitadas ocupadas, horário deve ser rejeitado');
  assert.strictEqual(checkRes.body.reason, 'SLOT_CONFLICT');
  assert.ok(Array.isArray(checkRes.body.suggestedSlots));
  assert.strictEqual(checkRes.body.suggestedSlots.includes('09:00'), false, 'Horário ocupado não pode ser sugerido');

  // Tentativa de POST deve retornar 409
  const bookRes = await apiRequest('/api/client/appointments', {
    method: 'POST',
    body: {
      clientName: 'Terceira Cliente',
      clientPhone: '5511999993333',
      serviceId,
      staffId: '', // Automático
      date: '2026-11-16',
      time: '09:00',
    },
  });

  assert.strictEqual(bookRes.status, 409);
  assert.strictEqual(bookRes.body.code, 'SLOT_CONFLICT');
});

test('Cenário 6: Profissional escolhido manualmente mantém a verificação individual', async () => {
  // Insere agendamento apenas para Jéssica às 11:00 às 12:00
  db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, service_id, staff_id, start_datetime, end_datetime, status, duration_min)
    VALUES (?, 'Corte Feminino em Camadas', 'Cliente Carla', '5511988886666', ?, ?, '2026-11-16T11:00:00', '2026-11-16T12:00:00', 'AGENDADO', 60)
  `).run(SALON.id, serviceId, staffJessicaId);

  // 1. Jéssica selecionada manualmente às 11:00 -> Conflito
  const resJessica = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=11:00&service_id=${serviceId}&staff_id=${staffJessicaId}`);
  assert.strictEqual(resJessica.status, 200);
  assert.strictEqual(resJessica.body.available, false);
  assert.strictEqual(resJessica.body.reason, 'SLOT_CONFLICT');

  // 2. Camila selecionada manualmente às 11:00 -> Disponível
  const resCamila = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=11:00&service_id=${serviceId}&staff_id=${staffCamilaId}`);
  assert.strictEqual(resCamila.status, 200);
  assert.strictEqual(resCamila.body.available, true);
  assert.strictEqual(resCamila.body.assignedStaffId, staffCamilaId);

  // 3. Automático às 11:00 -> Disponível (atribuído à Camila)
  const resAuto = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=11:00&service_id=${serviceId}&staff_id=`);
  assert.strictEqual(resAuto.status, 200);
  assert.strictEqual(resAuto.body.available, true);
  assert.strictEqual(resAuto.body.assignedStaffId, staffCamilaId);
});

test('Cenário 7: Profissional não habilitado nunca pode ser selecionado nem pelo automático', async () => {
  // Rafael (id 3) não possui vínculo confirmado para Corte Feminino
  const res = await apiRequest(`/api/client/appointments/check-slot?date=2026-11-16&time=14:00&service_id=${serviceId}&staff_id=${staffRafaelId}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.available, false);
  assert.strictEqual(res.body.reason, 'STAFF_NOT_QUALIFIED');

  // Tentativa de POST com Rafael deve retornar 422
  const bookRes = await apiRequest('/api/client/appointments', {
    method: 'POST',
    body: {
      clientName: 'Cliente Tentativa',
      serviceId,
      staffId: staffRafaelId,
      date: '2026-11-16',
      time: '14:00',
    },
  });
  assert.strictEqual(bookRes.status, 422);
  assert.strictEqual(bookRes.body.code, 'STAFF_NOT_QUALIFIED');
});

test('Cenário 8: Nenhum agendamento duplicado para o mesmo profissional', async () => {
  // Jéssica já está ocupada às 11:00. Tentar forçar agendamento para Jéssica às 11:00
  const bookRes = await apiRequest('/api/client/appointments', {
    method: 'POST',
    body: {
      clientName: 'Cliente Duplicada',
      serviceId,
      staffId: staffJessicaId,
      date: '2026-11-16',
      time: '11:00',
    },
  });

  assert.strictEqual(bookRes.status, 409);
  assert.strictEqual(bookRes.body.code, 'SLOT_CONFLICT');
});
