/**
 * COMANDO 040.1 — Suíte de Testes Automatizados Hermética
 * Vinculação Inteligente entre Serviços e Profissionais (Jéssica Beauty Premium)
 *
 * Módulos nativos: node:test e node:assert/strict
 * Banco isolado temporário: os.tmpdir() (Sem tocar em data/assistant.db)
 * Rede: Interceptada / Local loopback fail-closed
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const express = require('express');

// 1. ISOLAMENTO MANDATÓRIO DE BANCO DE DADOS EM os.tmpdir()
const uniqueDbName = `test-c040-1-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
const testDbPath = path.join(os.tmpdir(), uniqueDbName);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';

// Importa módulos após configurar DB_PATH no ambiente
const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const clientRoutes = require('../src/routes/clientRoutes');

// 2. APLICAÇÃO EXPRESS DE TESTE LOCAL
const testApp = express();
testApp.use(express.json());
testApp.use('/api/client', clientRoutes);

let server;
let baseUrl;

// Fixtures de Tenants
const SALON_A = {
  id: 101,
  phone: '5511999990101',
  name: 'Salão A - Jéssica Beauty',
  token: 'token_tenant_a_c040_1',
};

const SALON_B = {
  id: 102,
  phone: '5511999990102',
  name: 'Salão B - Barbearia Rival',
  token: 'token_tenant_b_c040_1',
};

test.before(async () => {
  // Inicializa servidor HTTP na porta efêmera 0 (loopback estrito 127.0.0.1)
  server = http.createServer(testApp);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Setup do Salão A
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan_tier, extra_professionals, subscription_status, session_token, session_expires_at, paid_until)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 20, 'ACTIVE', ?, datetime('now', '+30 days'), datetime('now', '+30 days'))
  `).run(SALON_A.id, SALON_A.phone, SALON_A.name, SALON_A.token);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours)
    VALUES (?, ?, ?)
  `).run(
    SALON_A.id,
    SALON_A.name,
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
  const proPlanA = jessicaProd ? db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'PRO'").get(jessicaProd.id) : null;
  if (jessicaProd && proPlanA) {
    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, extra_professionals, status, price_cents, paid_until)
      VALUES (?, ?, ?, 20, 'ACTIVE', 8900, datetime('now', '+30 days'))
    `).run(SALON_A.id, jessicaProd.id, proPlanA.id);
  }

  // Setup do Salão B (Multi-tenant)
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan_tier, extra_professionals, subscription_status, session_token, session_expires_at, paid_until)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 20, 'ACTIVE', ?, datetime('now', '+30 days'), datetime('now', '+30 days'))
  `).run(SALON_B.id, SALON_B.phone, SALON_B.name, SALON_B.token);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours)
    VALUES (?, ?, ?)
  `).run(
    SALON_B.id,
    SALON_B.name,
    JSON.stringify({
      days: {
        1: { open: true, start: '08:00', end: '20:00' },
        2: { open: true, start: '08:00', end: '20:00' },
      },
    })
  );

  if (jessicaProd && proPlanA) {
    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, extra_professionals, status, price_cents, paid_until)
      VALUES (?, ?, ?, 20, 'ACTIVE', 8900, datetime('now', '+30 days'))
    `).run(SALON_B.id, jessicaProd.id, proPlanA.id);
  }
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (db && typeof db.close === 'function') db.close();
  } catch (_) {}

  // Exclusão garantida do banco temporário em os.tmpdir()
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch (_) {}
});

// Helper para chamadas autenticadas na API
async function apiRequest(endpoint, { method = 'GET', body = null, token = SALON_A.token } = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

// =========================================================================
// SUÍTE DE TESTES: CENÁRIOS 1 A 13 DO COMANDO 040.1
// =========================================================================

test('Cenário 1: Um serviço realizado por vários profissionais (N:N)', async () => {
  const staff1Res = await apiRequest('/api/client/staff', {
    method: 'POST',
    body: { name: 'Jéssica Cabelos', specialty: 'Cabeleireira' },
  });
  assert.equal(staff1Res.status, 200);
  const jessicaId = staff1Res.data.staff.id;

  const staff2Res = await apiRequest('/api/client/staff', {
    method: 'POST',
    body: { name: 'Carla Silva', specialty: 'Cortes & Escovas' },
  });
  assert.equal(staff2Res.status, 200);
  const carlaId = staff2Res.data.staff.id;

  const svcRes = await apiRequest('/api/client/services', {
    method: 'POST',
    body: {
      name: 'Corte Feminino Premium',
      price: 85.0,
      duration_min: 45,
      category: 'Cabelos',
      staff_ids: [jessicaId, carlaId],
    },
  });
  assert.equal(svcRes.status, 200);
  const serviceId = svcRes.data.service.id;
  assert.deepEqual(svcRes.data.service.staff_ids.sort(), [jessicaId, carlaId].sort());

  const relationRes = await apiRequest(`/api/client/services/${serviceId}/staff`);
  assert.equal(relationRes.status, 200);
  assert.equal(relationRes.data.staff.length, 2);
  const returnedStaffIds = relationRes.data.staff.map((s) => s.id).sort();
  assert.deepEqual(returnedStaffIds, [jessicaId, carlaId].sort());

  const apt1 = salonAppointmentService.bookAppointmentSync(SALON_A.id, {
    clientName: 'Cliente 1',
    serviceId,
    staffId: jessicaId,
    date: '2026-11-20',
    time: '09:00',
  });
  assert.equal(apt1.staff_id, jessicaId);

  const apt2 = salonAppointmentService.bookAppointmentSync(SALON_A.id, {
    clientName: 'Cliente 2',
    serviceId,
    staffId: carlaId,
    date: '2026-11-20',
    time: '09:00',
  });
  assert.equal(apt2.staff_id, carlaId);
});

test('Cenário 2: Um profissional realizando vários serviços (N:N)', async () => {
  const s1 = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Escova Modelada C040', 60.0, 30, 'Cabelos');
  const s2 = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Hidratação Profunda C040', 90.0, 45, 'Cabelos');
  const serviceId1 = Number(s1.lastInsertRowid);
  const serviceId2 = Number(s2.lastInsertRowid);

  const staffRes = await apiRequest('/api/client/staff', {
    method: 'POST',
    body: {
      name: 'Mariana Especialista',
      specialty: 'Cabelos em Geral',
      service_ids: [serviceId1, serviceId2],
    },
  });
  assert.equal(staffRes.status, 200);
  const marianaId = staffRes.data.staff.id;
  assert.deepEqual(staffRes.data.staff.service_ids.sort(), [serviceId1, serviceId2].sort());

  const getStaffSvc = await apiRequest(`/api/client/staff/${marianaId}/services`);
  assert.equal(getStaffSvc.status, 200);
  assert.equal(getStaffSvc.data.services.length, 2);
  const mappedIds = getStaffSvc.data.services.map((s) => s.id).sort();
  assert.deepEqual(mappedIds, [serviceId1, serviceId2].sort());
});

test('Cenário 3: Profissional não habilitado não aparece e é rejeitado na API/agendamento', async () => {
  const pA = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Fernanda Lash', 'Cílios e Sobrancelhas');
  const staffFernandaId = Number(pA.lastInsertRowid);

  const pB = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Rodrigo Barbeiro', 'Barbearia');
  const staffRodrigoId = Number(pB.lastInsertRowid);

  const sExt = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Extensão de Cílios Volume', 150.0, 90, 'Sobrancelhas e cílios');
  const extSvcId = Number(sExt.lastInsertRowid);

  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, extSvcId, staffFernandaId);

  const listRes = await apiRequest(`/api/client/services/${extSvcId}/staff`);
  assert.equal(listRes.status, 200);
  const qualifiedStaff = listRes.data.staff;
  assert.equal(qualifiedStaff.some((st) => st.id === staffRodrigoId), false);
  assert.equal(qualifiedStaff.some((st) => st.id === staffFernandaId), true);

  const bookAttempt = await apiRequest('/api/client/appointments', {
    method: 'POST',
    body: {
      clientName: 'Maria Silva',
      serviceId: extSvcId,
      staffId: staffRodrigoId,
      date: '2026-11-20',
      time: '14:00',
    },
  });
  assert.equal(bookAttempt.status, 422);
  assert.equal(bookAttempt.data.code, 'STAFF_NOT_QUALIFIED');

  assert.throws(
    () => {
      salonAppointmentService.resolveEffectiveStaff(SALON_A.id, extSvcId, staffRodrigoId);
    },
    (err) => err.code === 'STAFF_NOT_QUALIFIED' && err.statusCode === 422
  );
});

test('Cenário 4: Profissional inativo (active = 0) não recebe agendamentos mesmo com vínculo prévio', async () => {
  const staffRow = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Paula Manicure', 'Unhas');
  const paulaId = Number(staffRow.lastInsertRowid);

  const svcRow = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Manicure Tradicional', 40.0, 45, 'Unhas');
  const nailSvcId = Number(svcRow.lastInsertRowid);

  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, nailSvcId, paulaId);

  db.prepare('UPDATE client_staff SET active = 0 WHERE id = ? AND user_id = ?').run(paulaId, SALON_A.id);

  const staffList = await apiRequest(`/api/client/services/${nailSvcId}/staff`);
  assert.equal(staffList.status, 200);
  assert.equal(staffList.data.staff.some((s) => s.id === paulaId), false);

  assert.throws(
    () => {
      salonAppointmentService.resolveEffectiveStaff(SALON_A.id, nailSvcId, paulaId);
    },
    (err) => err.code === 'STAFF_NOT_FOUND'
  );
});

test('Cenário 5: Seleção automática (auto-assign) respeita habilitação (quando há apenas 1 habilitado)', async () => {
  const staffCount = db.prepare('SELECT COUNT(*) AS total FROM client_staff WHERE user_id = ? AND active = 1').get(SALON_A.id).total;
  assert.ok(staffCount > 1);

  const jessica = db.prepare("SELECT id, name FROM client_staff WHERE user_id = ? AND name = 'Jéssica Cabelos'").get(SALON_A.id);
  assert.ok(jessica);

  const svcUnique = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Terapia Capilar Exclusiva', 200.0, 60, 'Cabelos');
  const terapiaId = Number(svcUnique.lastInsertRowid);

  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, terapiaId, jessica.id);

  const effective = salonAppointmentService.resolveEffectiveStaff(SALON_A.id, terapiaId, null);
  assert.equal(effective.staffId, jessica.id);
  assert.equal(effective.staffName, jessica.name);

  const booking = salonAppointmentService.bookAppointmentSync(SALON_A.id, {
    clientName: 'Cliente Auto-Assign',
    serviceId: terapiaId,
    date: '2026-11-20',
    time: '11:00',
  });
  assert.equal(booking.staff_id, jessica.id);
});

test('Cenário 6: Bloqueio de tentativas indevidas pela API (422 incompatível, 400 IDs alheios/inexistentes)', async () => {
  const badStaffPost = await apiRequest('/api/client/services', {
    method: 'POST',
    body: {
      name: 'Serviço Inválido',
      price: 50.0,
      duration_min: 30,
      category: 'Cabelos',
      staff_ids: [999999],
    },
  });
  assert.equal(badStaffPost.status, 400);
  assert.equal(badStaffPost.data.code, 'INVALID_STAFF_IDS');

  const badSvcPost = await apiRequest('/api/client/staff', {
    method: 'POST',
    body: {
      name: 'Profissional com Serviço Fantasma',
      service_ids: [888888],
    },
  });
  assert.equal(badSvcPost.status, 400);
  assert.equal(badSvcPost.data.code, 'INVALID_SERVICE_IDS');

  const svcMulti = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Corte Masculino Degrade C040', 50.0, 30, 'Barbearia');
  const multiSvcId = Number(svcMulti.lastInsertRowid);

  const st1 = db.prepare("SELECT id FROM client_staff WHERE user_id = ? AND name = 'Jéssica Cabelos'").get(SALON_A.id).id;
  const st2 = db.prepare("SELECT id FROM client_staff WHERE user_id = ? AND name = 'Carla Silva'").get(SALON_A.id).id;

  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, multiSvcId, st1);
  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, multiSvcId, st2);

  // Consulta direta sem data/hora lança STAFF_REQUIRED
  assert.throws(
    () => {
      salonAppointmentService.resolveEffectiveStaff(SALON_A.id, multiSvcId, null);
    },
    (err) => err.code === 'STAFF_REQUIRED' && err.statusCode === 400 && Array.isArray(err.availableStaff)
  );
});

test('Cenário 7: Ausência de profissionais elegíveis (0 habilitados -> NO_QUALIFIED_STAFF_FOR_SERVICE 422)', async () => {
  const svcZero = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Drenagem Linfática Solo', 180.0, 60, 'Estética e maquiagem');
  const zeroSvcId = Number(svcZero.lastInsertRowid);

  const bookAttempt = await apiRequest('/api/client/appointments', {
    method: 'POST',
    body: {
      clientName: 'Cliente Zero Staff',
      serviceId: zeroSvcId,
      date: '2026-11-20',
      time: '16:00',
    },
  });
  assert.equal(bookAttempt.status, 422);
  assert.equal(bookAttempt.data.code, 'NO_QUALIFIED_STAFF_FOR_SERVICE');

  assert.throws(
    () => {
      salonAppointmentService.resolveEffectiveStaff(SALON_A.id, zeroSvcId, null);
    },
    (err) => err.code === 'NO_QUALIFIED_STAFF_FOR_SERVICE' && err.statusCode === 422
  );
});

test('Cenário 8: Isolamento entre salões (Multi-tenant: Salão A não vincula ou agenda do Salão B)', async () => {
  const staffB = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_B.id, 'Barbeiro do Salão B', 'Barbearia');
  const staffBId = Number(staffB.lastInsertRowid);

  const svcB = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_B.id, 'Barba Terapia Salão B', 70.0, 30, 'Barbearia');
  const svcBId = Number(svcB.lastInsertRowid);

  const crossStaffRes = await apiRequest('/api/client/services', {
    method: 'POST',
    token: SALON_A.token,
    body: {
      name: 'Serviço Tentando Invadir Salão B',
      price: 100.0,
      duration_min: 45,
      category: 'Cabelos',
      staff_ids: [staffBId],
    },
  });
  assert.equal(crossStaffRes.status, 400);
  assert.equal(crossStaffRes.data.code, 'INVALID_STAFF_IDS');

  const crossSvcRes = await apiRequest('/api/client/staff', {
    method: 'POST',
    token: SALON_A.token,
    body: {
      name: 'Staff Tentando Invadir Salão B',
      service_ids: [svcBId],
    },
  });
  assert.equal(crossSvcRes.status, 400);
  assert.equal(crossSvcRes.data.code, 'INVALID_SERVICE_IDS');

  assert.throws(
    () => {
      salonAppointmentService.resolveEffectiveStaff(SALON_A.id, null, staffBId);
    },
    (err) => err.code === 'STAFF_NOT_FOUND'
  );

  const bServices = await apiRequest('/api/client/services', { token: SALON_B.token });
  assert.equal(bServices.status, 200);
  assert.ok(bServices.data.services.every((s) => s.user_id === SALON_B.id));
});

test('Cenário 9: Preservação de dados existentes e migração versionada 040.1 (Salão Solo confirmed=1 vs Multi confirmed=0)', () => {
  const LEGACY_SOLO_USER = 201;
  const LEGACY_MULTI_USER = 202;

  db.prepare("INSERT INTO users (id, phone_number, name, role) VALUES (?, '5511999990201', 'Salão Solo Legado', 'USER')").run(LEGACY_SOLO_USER);
  db.prepare("INSERT INTO users (id, phone_number, name, role) VALUES (?, '5511999990202', 'Salão Multi Legado', 'USER')").run(LEGACY_MULTI_USER);

  // 1. Salão Solo: 1 staff ativo e 2 serviços ativos
  const soloStaff = db.prepare("INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, 'Cabeleireira Solo', 'Geral', 1)").run(LEGACY_SOLO_USER);
  const soloStaffId = Number(soloStaff.lastInsertRowid);

  const soloSvc1 = db.prepare("INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, 'Corte Solo', 50, 30, 'Cabelos', 1)").run(LEGACY_SOLO_USER);
  const soloSvc2 = db.prepare("INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, 'Escova Solo', 40, 30, 'Cabelos', 1)").run(LEGACY_SOLO_USER);
  const soloSvc1Id = Number(soloSvc1.lastInsertRowid);
  const soloSvc2Id = Number(soloSvc2.lastInsertRowid);

  // 2. Salão Multi: 2 staff ativos e 2 serviços
  const multiStaff1 = db.prepare("INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, 'Alice Cabelos', 'Especialista em Mechas e Cortes', 1)").run(LEGACY_MULTI_USER);
  const multiStaff2 = db.prepare("INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, 'Beatriz Unhas', 'Manicure e Alongamento em Gel', 1)").run(LEGACY_MULTI_USER);
  const multiStaff1Id = Number(multiStaff1.lastInsertRowid);
  const multiStaff2Id = Number(multiStaff2.lastInsertRowid);

  const multiSvcCabelo = db.prepare("INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, 'Corte e Mechas', 250, 120, 'Cabelos', 1)").run(LEGACY_MULTI_USER);
  const multiSvcUnha = db.prepare("INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, 'Alongamento em Gel', 120, 90, 'Unhas', 1)").run(LEGACY_MULTI_USER);
  const multiSvcCabeloId = Number(multiSvcCabelo.lastInsertRowid);
  const multiSvcUnhaId = Number(multiSvcUnha.lastInsertRowid);

  // Histórico existente de agendamento ligando multiStaff1 a multiSvcCabelo
  db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, end_datetime, service_id, staff_id, status)
    VALUES (?, 'Atendimento Histórico', '2026-10-10T10:00:00', '2026-10-10T12:00:00', ?, ?, 'CONCLUÍDO')
  `).run(LEGACY_MULTI_USER, multiSvcCabeloId, multiStaff1Id);

  // SIMULAÇÃO DA TRANSIÇÃO DA MIGRAÇÃO 20261113_01_client_service_staff (COMANDO 040.1)
  // Etapa 1: Salões solo recebem confirmed = 1
  db.exec(`
    INSERT OR IGNORE INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    SELECT cs.user_id, cs.id AS service_id, staff_single.id AS staff_id, 1
    FROM client_services cs
    JOIN (
      SELECT user_id, MIN(id) AS id
      FROM client_staff
      WHERE active = 1
      GROUP BY user_id
      HAVING COUNT(id) = 1
    ) staff_single ON staff_single.user_id = cs.user_id
    WHERE cs.active = 1 AND cs.user_id = ${LEGACY_SOLO_USER};
  `);

  // Etapa 2: Agendamentos históricos recebem confirmed = 1
  db.exec(`
    INSERT OR IGNORE INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    SELECT DISTINCT a.user_id, a.service_id, a.staff_id, 1
    FROM appointments a
    JOIN client_services cs ON cs.id = a.service_id AND cs.user_id = a.user_id
    JOIN client_staff st ON st.id = a.staff_id AND st.user_id = a.user_id
    WHERE a.service_id IS NOT NULL 
      AND a.staff_id IS NOT NULL
      AND cs.active = 1
      AND st.active = 1
      AND a.user_id = ${LEGACY_MULTI_USER};
  `);

  // Etapa 3: Sugestões heurísticas em salão multi recebem confirmed = 0
  const remainingServices = db.prepare('SELECT id, name, category FROM client_services WHERE user_id = ? AND active = 1').all(LEGACY_MULTI_USER);
  const multiStaff = db.prepare('SELECT id, name, specialty FROM client_staff WHERE user_id = ? AND active = 1').all(LEGACY_MULTI_USER);

  for (const svc of remainingServices) {
    const existing = db.prepare('SELECT COUNT(*) AS count FROM client_service_staff WHERE user_id = ? AND service_id = ?').get(LEGACY_MULTI_USER, svc.id);
    if (existing && existing.count > 0) continue;

    const svcText = `${svc.name} ${svc.category || ''}`.toLowerCase();
    for (const st of multiStaff) {
      const spec = (st.specialty || '').toLowerCase();
      const isNailMatch = (spec.includes('manicur') || spec.includes('unha')) && (svcText.includes('unha') || svcText.includes('gel'));
      if (isNailMatch) {
        db.prepare('INSERT OR IGNORE INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 0)').run(LEGACY_MULTI_USER, svc.id, st.id);
      }
    }
  }

  // ASSERÇÕES DO CENÁRIO 9:
  // 1. Salão Solo: ambos os serviços vinculados com confirmed = 1
  const soloLinks = db.prepare('SELECT service_id, staff_id, confirmed FROM client_service_staff WHERE user_id = ?').all(LEGACY_SOLO_USER);
  assert.equal(soloLinks.length, 2);
  assert.ok(soloLinks.every((l) => l.confirmed === 1));
  assert.ok(soloLinks.some((l) => l.service_id === soloSvc1Id && l.staff_id === soloStaffId));
  assert.ok(soloLinks.some((l) => l.service_id === soloSvc2Id && l.staff_id === soloStaffId));

  // 2. Salão Multi: serviço de Cabelo vinculado via histórico com confirmed = 1
  const cabeloLink = db.prepare('SELECT staff_id, confirmed FROM client_service_staff WHERE user_id = ? AND service_id = ?').get(LEGACY_MULTI_USER, multiSvcCabeloId);
  assert.equal(cabeloLink.staff_id, multiStaff1Id);
  assert.equal(cabeloLink.confirmed, 1);

  // 3. Salão Multi: serviço de Unha vinculado via heurística com confirmed = 0 (pendente de confirmação)
  const unhaLink = db.prepare('SELECT staff_id, confirmed FROM client_service_staff WHERE user_id = ? AND service_id = ?').get(LEGACY_MULTI_USER, multiSvcUnhaId);
  assert.equal(unhaLink.staff_id, multiStaff2Id);
  assert.equal(unhaLink.confirmed, 0);

  // 4. Idempotência garantida
  const totalBefore = db.prepare('SELECT COUNT(*) AS total FROM client_service_staff').get().total;
  db.prepare('INSERT OR IGNORE INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(LEGACY_SOLO_USER, soloSvc1Id, soloStaffId);
  const totalAfter = db.prepare('SELECT COUNT(*) AS total FROM client_service_staff').get().total;
  assert.equal(totalBefore, totalAfter);
});

test('Cenário 10: Vínculo com confirmed = 0 bloqueia novos agendamentos (422 STAFF_NOT_QUALIFIED / NO_QUALIFIED_STAFF)', async () => {
  // Cria serviço e profissional no Salão A com confirmed = 0 (sugestão pendente)
  const staffPending = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Bruna Colorista Pendente', 'Coloração');
  const pendingStaffId = Number(staffPending.lastInsertRowid);

  const svcPend = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Mechas Criativas Pendentes', 300.0, 120, 'Cabelos');
  const pendingSvcId = Number(svcPend.lastInsertRowid);

  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 0)').run(SALON_A.id, pendingSvcId, pendingStaffId);

  // 1. Profissional com confirmed = 0 não aparece como habilitado na rota pública/interna de serviços
  const staffListRes = await apiRequest(`/api/client/services/${pendingSvcId}/staff`);
  assert.equal(staffListRes.status, 200);
  assert.equal(staffListRes.data.staff.some((s) => s.id === pendingStaffId), false);

  // 2. Serviço com confirmed = 0 não aparece na rota /staff/:id/services
  const staffSvcRes = await apiRequest(`/api/client/staff/${pendingStaffId}/services`);
  assert.equal(staffSvcRes.status, 200);
  assert.equal(staffSvcRes.data.services.some((s) => s.id === pendingSvcId), false);

  // 3. Tentativa de agendamento especificando o profissional com vínculo pendente deve falhar com 422 STAFF_NOT_QUALIFIED
  const bookAttempt = await apiRequest('/api/client/appointments', {
    method: 'POST',
    body: {
      clientName: 'Cliente Tentando Agendar Pendente',
      serviceId: pendingSvcId,
      staffId: pendingStaffId,
      date: '2026-11-21',
      time: '10:00',
    },
  });
  assert.equal(bookAttempt.status, 422);
  assert.equal(bookAttempt.data.code, 'STAFF_NOT_QUALIFIED');

  // 4. Tentativa de agendamento sem especificar profissional (quando não há nenhum confirmed = 1) falha com 422 NO_QUALIFIED_STAFF_FOR_SERVICE
  const bookNoStaffAttempt = await apiRequest('/api/client/appointments', {
    method: 'POST',
    body: {
      clientName: 'Cliente Sem Staff Definido',
      serviceId: pendingSvcId,
      date: '2026-11-21',
      time: '10:00',
    },
  });
  assert.equal(bookNoStaffAttempt.status, 422);
  assert.equal(bookNoStaffAttempt.data.code, 'NO_QUALIFIED_STAFF_FOR_SERVICE');

  // 5. Validação direta via resolveEffectiveStaff
  assert.throws(
    () => {
      salonAppointmentService.resolveEffectiveStaff(SALON_A.id, pendingSvcId, pendingStaffId);
    },
    (err) => err.code === 'STAFF_NOT_QUALIFIED' && err.statusCode === 422
  );
  assert.throws(
    () => {
      salonAppointmentService.resolveEffectiveStaff(SALON_A.id, pendingSvcId, null);
    },
    (err) => err.code === 'NO_QUALIFIED_STAFF_FOR_SERVICE' && err.statusCode === 422
  );
});

test('Cenário 11: Endpoints de pendências e confirmação em lote com proteção Anti-IDOR', async () => {
  // Prepara dados pendentes no Salão A
  const staffA1 = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Profissional A1', 'Especialidade 1');
  const staffA2 = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Profissional A2', 'Especialidade 2');
  const svcA1 = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Serviço A1', 50, 30, 'Cabelos');
  const svcA2 = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Serviço A2', 70, 40, 'Cabelos');

  const idStaffA1 = Number(staffA1.lastInsertRowid);
  const idStaffA2 = Number(staffA2.lastInsertRowid);
  const idSvcA1 = Number(svcA1.lastInsertRowid);
  const idSvcA2 = Number(svcA2.lastInsertRowid);

  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 0)').run(SALON_A.id, idSvcA1, idStaffA1);
  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 0)').run(SALON_A.id, idSvcA2, idStaffA2);

  // 1. GET /api/client/staff/qualifications/pending lista as pendências do Salão A
  const pendingRes = await apiRequest('/api/client/staff/qualifications/pending');
  assert.equal(pendingRes.status, 200);
  assert.ok(pendingRes.data.pendingQualifications.some((p) => p.service_id === idSvcA1 && p.staff_id === idStaffA1));
  assert.ok(pendingRes.data.pendingQualifications.some((p) => p.service_id === idSvcA2 && p.staff_id === idStaffA2));

  // 2. Confirmação em lote: confirma o primeiro (action = 'confirm') e rejeita o segundo (action = 'reject')
  const batchRes = await apiRequest('/api/client/staff/qualifications/batch-confirm', {
    method: 'POST',
    body: {
      items: [
        { service_id: idSvcA1, staff_id: idStaffA1, action: 'confirm' },
        { service_id: idSvcA2, staff_id: idStaffA2, action: 'reject' },
      ],
    },
  });
  assert.equal(batchRes.status, 200);
  assert.equal(batchRes.data.confirmedCount, 1);
  assert.equal(batchRes.data.rejectedCount, 1);

  // Verifica no banco: o confirmado agora tem confirmed = 1
  const confirmedRow = db.prepare('SELECT confirmed FROM client_service_staff WHERE user_id = ? AND service_id = ? AND staff_id = ?').get(SALON_A.id, idSvcA1, idStaffA1);
  assert.equal(confirmedRow.confirmed, 1);

  // Verifica no banco: o rejeitado foi removido
  const rejectedRow = db.prepare('SELECT confirmed FROM client_service_staff WHERE user_id = ? AND service_id = ? AND staff_id = ?').get(SALON_A.id, idSvcA2, idStaffA2);
  assert.equal(rejectedRow, undefined);

  // 3. Proteção Anti-IDOR: Salão A tenta confirmar entidade pertencente ao Salão B
  const staffB = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_B.id, 'Staff IDOR Test B', 'Barbearia');
  const svcB = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_B.id, 'Serviço IDOR Test B', 60, 30, 'Barbearia');
  const idStaffB = Number(staffB.lastInsertRowid);
  const idSvcB = Number(svcB.lastInsertRowid);
  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 0)').run(SALON_B.id, idSvcB, idStaffB);

  const idorRes = await apiRequest('/api/client/staff/qualifications/batch-confirm', {
    method: 'POST',
    token: SALON_A.token, // Token do Salão A
    body: {
      items: [
        { service_id: idSvcB, staff_id: idStaffB, action: 'confirm' }, // Entidades do Salão B
      ],
    },
  });
  assert.equal(idorRes.status, 403);
  assert.equal(idorRes.data.success, false);

  // Garante que o vínculo do Salão B permaneceu intacto com confirmed = 0
  const bRow = db.prepare('SELECT confirmed FROM client_service_staff WHERE user_id = ? AND service_id = ? AND staff_id = ?').get(SALON_B.id, idSvcB, idStaffB);
  assert.equal(bRow.confirmed, 0);
});

test('Cenário 12: Opção "Qualquer profissional disponível" com balanceamento de carga diária', async () => {
  // Cadastra 2 profissionais no Salão A
  const p1 = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Equipe Alfa', 'Geral');
  const p2 = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Equipe Beta', 'Geral');
  const staffAlfaId = Number(p1.lastInsertRowid);
  const staffBetaId = Number(p2.lastInsertRowid);

  // Cadastra serviço habilitado e confirmado para ambos
  const svc = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Massagem Relaxante C040', 120, 60, 'Estética');
  const svcId = Number(svc.lastInsertRowid);

  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, svcId, staffAlfaId);
  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, svcId, staffBetaId);

  const testDate = '2026-11-23';

  // Pré-condição de carga diária: Alfa já tem 1 agendamento em outro horário no mesmo dia
  db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, end_datetime, service_id, staff_id, status)
    VALUES (?, 'Agendamento Anterior Alfa', ?, ?, ?, ?, 'AGENDADO')
  `).run(SALON_A.id, `${testDate}T08:00:00`, `${testDate}T09:00:00`, svcId, staffAlfaId);

  // 1. Agendamento com staffId = null / 'ANY' às 10:00 (ambos estão livres no horário)
  // Como Beta tem carga 0 e Alfa tem carga 1, deve escolher atomicamente Beta e gravar nominalmente staff_id = staffBetaId
  const aptAuto1 = salonAppointmentService.bookAppointmentSync(SALON_A.id, {
    clientName: 'Cliente Qualquer Profissional 1',
    serviceId: svcId,
    staffId: 'ANY',
    date: testDate,
    time: '10:00',
  });

  assert.ok(aptAuto1.staff_id !== null, 'staff_id deve ser nominalmente gravado e não nulo');
  assert.equal(aptAuto1.staff_id, staffBetaId, 'Deve selecionar Beta por possuir menor carga diária (0 vs 1)');

  // 2. Agora ambos possuem 1 agendamento no dia.
  // Novo agendamento às 11:00 com staffId nulo: critério de desempate por menor id escolhe Alfa
  const aptAuto2 = salonAppointmentService.bookAppointmentSync(SALON_A.id, {
    clientName: 'Cliente Qualquer Profissional 2',
    serviceId: svcId,
    staffId: null,
    date: testDate,
    time: '11:00',
  });

  assert.ok(aptAuto2.staff_id !== null);
  const minId = Math.min(staffAlfaId, staffBetaId);
  assert.equal(aptAuto2.staff_id, minId, 'Com cargas iguais, desempata selecionando o profissional com menor ID');
});

test('Cenário 13: Conflito total no horário ("Qualquer profissional disponível") e união em findAlternativeSlots', async () => {
  const p1 = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Especialista 1 Slot', 'Unhas');
  const p2 = db.prepare('INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, ?, ?, 1)').run(SALON_A.id, 'Especialista 2 Slot', 'Unhas');
  const s1Id = Number(p1.lastInsertRowid);
  const s2Id = Number(p2.lastInsertRowid);

  const svcA = db.prepare('INSERT INTO client_services (user_id, name, price, duration_min, category, active) VALUES (?, ?, ?, ?, ?, 1)').run(SALON_A.id, 'Pedicure Express C040', 60, 60, 'Unhas');
  const svcConflictId = Number(svcA.lastInsertRowid);

  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, svcConflictId, s1Id);
  db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)').run(SALON_A.id, svcConflictId, s2Id);

  const testDate = '2026-11-24';
  const conflictTime = '14:00';

  // Ocupa AMBOS os profissionais no horário das 14:00
  db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, end_datetime, service_id, staff_id, status)
    VALUES (?, 'Ocupado 1', ?, ?, ?, ?, 'AGENDADO')
  `).run(SALON_A.id, `${testDate}T14:00:00`, `${testDate}T15:00:00`, svcConflictId, s1Id);

  db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, end_datetime, service_id, staff_id, status)
    VALUES (?, 'Ocupado 2', ?, ?, ?, ?, 'AGENDADO')
  `).run(SALON_A.id, `${testDate}T14:00:00`, `${testDate}T15:00:00`, svcConflictId, s2Id);

  // Ocupa apenas o profissional 1 às 15:00 (profissional 2 permanece livre)
  db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, end_datetime, service_id, staff_id, status)
    VALUES (?, 'Ocupado Prof 1', ?, ?, ?, ?, 'AGENDADO')
  `).run(SALON_A.id, `${testDate}T15:00:00`, `${testDate}T16:00:00`, svcConflictId, s1Id);

  // 1. Tentativa de agendamento às 14:00 com staffId: 'ANY' falha com 409 SLOT_CONFLICT
  assert.throws(
    () => {
      salonAppointmentService.bookAppointmentSync(SALON_A.id, {
        clientName: 'Cliente Sem Vaga',
        serviceId: svcConflictId,
        staffId: 'ANY',
        date: testDate,
        time: conflictTime,
      });
    },
    (err) => err.code === 'SLOT_CONFLICT' && err.statusCode === 409
  );

  // 2. findAlternativeSlots retorna a união onde pelo menos UM profissional qualificado esteja livre
  const slots = await salonAppointmentService.findAlternativeSlots(SALON_A.id, {
    date: testDate,
    serviceDurationMin: 60,
    serviceId: svcConflictId,
  });

  // O horário das 14:00 NÃO pode estar nos slots (ambos ocupados)
  assert.equal(slots.includes('14:00'), false, 'Slot 14:00 deve ser excluído pois todos os profissionais estão ocupados');

  // O horário das 15:00 DEVE estar presente pois o Profissional 2 está livre
  assert.equal(slots.includes('15:00'), true, 'Slot 15:00 deve ser incluído na união pois o Profissional 2 está disponível');

  // Horários da manhã sem agendamentos também devem estar presentes
  assert.equal(slots.includes('09:00'), true);
});
