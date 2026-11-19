/**
 * COMANDO 059 — Suíte Hermética de Fechamento:
 * Validação Rigorosa de Conflito de Datas no SQLite e Compatibilidade Comercial do Google Calendar
 *
 * Módulos nativos: node:test e node:assert/strict
 * Banco temporário hermético em os.tmpdir()
 * Sem chamadas externas de rede, sem afetar dados de produção.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tempDbPath = path.join(os.tmpdir(), `test-c059-fechamento-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';

const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const gatekeeper = require('../src/services/googleCalendarGatekeeper');
const googleCalendarService = require('../src/services/googleCalendarService');

const TEST_SALON_ID = 601;
let staffId1;
let staffId2;
let serviceId1;

test.before(async () => {
  // Salão de teste
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, is_demo)
    VALUES (?, '5511999990601', 'Salão Fechamento 059', 'USER', 0)
  `).run(TEST_SALON_ID);

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours)
    VALUES (?, 'Salão Fechamento', ?)
  `).run(
    TEST_SALON_ID,
    JSON.stringify({
      timezone: 'America/Sao_Paulo',
      days: {
        0: { open: true, start: '00:00', end: '23:59' },
        1: { open: true, start: '00:00', end: '23:59' },
        2: { open: true, start: '00:00', end: '23:59' },
        3: { open: true, start: '00:00', end: '23:59' },
        4: { open: true, start: '00:00', end: '23:59' },
        5: { open: true, start: '00:00', end: '23:59' },
        6: { open: true, start: '00:00', end: '23:59' },
      },
    })
  );

  const st1 = db.prepare(`INSERT INTO client_staff (user_id, name, active) VALUES (?, 'Profissional Alpha', 1)`).run(TEST_SALON_ID);
  staffId1 = st1.lastInsertRowid;

  const st2 = db.prepare(`INSERT INTO client_staff (user_id, name, active) VALUES (?, 'Profissional Beta', 1)`).run(TEST_SALON_ID);
  staffId2 = st2.lastInsertRowid;

  const s1 = db.prepare(`INSERT INTO client_services (user_id, name, duration_min, price, active) VALUES (?, 'Corte Master', 60, 100, 1)`).run(TEST_SALON_ID);
  serviceId1 = s1.lastInsertRowid;

  db.prepare(`INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)`).run(TEST_SALON_ID, serviceId1, staffId1);
  db.prepare(`INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)`).run(TEST_SALON_ID, serviceId1, staffId2);
});

test.after(async () => {
  try {
    db.close();
  } catch (_) {}
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDbPath + '-wal')) fs.unlinkSync(tempDbPath + '-wal');
    if (fs.existsSync(tempDbPath + '-shm')) fs.unlinkSync(tempDbPath + '-shm');
  } catch (_) {}
});

test.beforeEach(() => {
  db.prepare("DELETE FROM appointments WHERE user_id = ?").run(TEST_SALON_ID);
});

// ============================================================================
// VERIFICAÇÃO 1: AUDITORIA E NORMALIZAÇÃO DE DATAS E CONFLITOS NO SQLITE
// ============================================================================

test('1.1. Dois horários sem sobreposição no mesmo dia (consecutivos e espaçados)', async () => {
  // Agendamento existente: 09:00 às 10:00
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status)
    VALUES (?, ?, 'Corte 1', 'Cliente 1', '2026-12-01 09:00:00', '2026-12-01 10:00:00', 'AGENDADO')
  `).run(TEST_SALON_ID, staffId1);

  // Caso A: Horário imediatamente consecutivo posterior (10:00 às 11:00) -> SEM CONFLITO
  const checkConsecutivoPosterior = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 10:00:00',
    endDt: '2026-12-01 11:00:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkConsecutivoPosterior.available, true, 'Horário consecutivo (10h-11h) deve estar livre');

  // Caso B: Horário imediatamente consecutivo anterior (08:00 às 09:00) -> SEM CONFLITO
  const checkConsecutivoAnterior = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 08:00:00',
    endDt: '2026-12-01 09:00:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkConsecutivoAnterior.available, true, 'Horário consecutivo anterior (08h-09h) deve estar livre');

  // Caso C: Horário espaçado no mesmo dia (14:00 às 15:00) -> SEM CONFLITO
  const checkEspacado = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 14:00:00',
    endDt: '2026-12-01 15:00:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkEspacado.available, true, 'Horário espaçado no mesmo dia deve estar livre');
});

test('1.2. Dois horários parcialmente sobrepostos (início dentro, término dentro, contido e englobante)', async () => {
  // Agendamento existente: 10:00 às 11:00
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status)
    VALUES (?, ?, 'Corte Base', 'Cliente Existente', '2026-12-01 10:00:00', '2026-12-01 11:00:00', 'AGENDADO')
  `).run(TEST_SALON_ID, staffId1);

  // Tentativa A: Início antes, término dentro (09:30 às 10:30) -> CONFLITO
  const checkInicioAntes = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 09:30:00',
    endDt: '2026-12-01 10:30:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkInicioAntes.available, false);
  assert.equal(checkInicioAntes.reason, 'SLOT_CONFLICT');

  // Tentativa B: Início dentro, término depois (10:30 às 11:30) -> CONFLITO
  const checkTerminoDepois = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 10:30:00',
    endDt: '2026-12-01 11:30:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkTerminoDepois.available, false);
  assert.equal(checkTerminoDepois.reason, 'SLOT_CONFLICT');

  // Tentativa C: Totalmente contido (10:15 às 10:45) -> CONFLITO
  const checkContido = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 10:15:00',
    endDt: '2026-12-01 10:45:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkContido.available, false);
  assert.equal(checkContido.reason, 'SLOT_CONFLICT');

  // Tentativa D: Totalmente englobante (09:00 às 12:00) -> CONFLITO
  const checkEnglobante = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 09:00:00',
    endDt: '2026-12-01 12:00:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkEnglobante.available, false);
  assert.equal(checkEnglobante.reason, 'SLOT_CONFLICT');
});

test('1.3. Dois horários exatamente iguais (mesmo início e término)', async () => {
  // Agendamento existente: 15:00 às 16:00
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status)
    VALUES (?, ?, 'Corte Idêntico', 'Cliente Original', '2026-12-01 15:00:00', '2026-12-01 16:00:00', 'AGENDADO')
  `).run(TEST_SALON_ID, staffId1);

  // Tentativa com horário exatamente idêntico
  const checkExato = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 15:00:00',
    endDt: '2026-12-01 16:00:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkExato.available, false, 'Horário idêntico deve acusar conflito imediato');
  assert.equal(checkExato.reason, 'SLOT_CONFLICT');
  assert.equal(checkExato.conflict.client_name, 'Cliente Original');
});

test('1.4. Agendamentos em formatos mistos SQL e ISO (eliminação do bug ASCII 32 vs 84)', async () => {
  // Agendamento no banco em formato SQL nativo (com espaço ' ')
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status)
    VALUES (?, ?, 'SQL Format', 'Cliente SQL', '2026-12-01 14:00:00', '2026-12-01 15:00:00', 'AGENDADO')
  `).run(TEST_SALON_ID, staffId1);

  // Tentativa em formato ISO (com 'T') sobreposta: 14:30 às 15:30 -> DEVE DETECTAR CONFLITO
  const checkIsoOverlap = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01T14:30:00',
    endDt: '2026-12-01T15:30:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkIsoOverlap.available, false, 'ISO sobreposto a SQL deve acusar conflito');
  assert.equal(checkIsoOverlap.reason, 'SLOT_CONFLICT');

  // Agendamento no banco em formato ISO (com 'T')
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status)
    VALUES (?, ?, 'ISO Format', 'Cliente ISO', '2026-12-01T16:00:00', '2026-12-01T17:00:00', 'AGENDADO')
  `).run(TEST_SALON_ID, staffId1);

  // Tentativa em formato SQL sobreposta: 16:00 às 17:00 -> DEVE DETECTAR CONFLITO
  const checkSqlOverlap = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 16:00:00',
    endDt: '2026-12-01 17:00:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkSqlOverlap.available, false, 'SQL sobreposto a ISO deve acusar conflito');
  assert.equal(checkSqlOverlap.reason, 'SLOT_CONFLICT');

  // Caso Crítico do Bug Original: Agendamento tardio em SQL (23:30) NÃO pode colidir com horário matutino em ISO (08:00)
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status)
    VALUES (?, ?, 'Tardio SQL', 'Cliente Noturno', '2026-12-01 23:30:00', '2026-12-02 00:30:00', 'AGENDADO')
  `).run(TEST_SALON_ID, staffId1);

  const checkMatutinoSemFalsoConflito = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01T08:00:00',
    endDt: '2026-12-01T09:00:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkMatutinoSemFalsoConflito.available, true, 'Horário matutino ISO não pode colidir falsamente com agendamento noturno SQL');
});

test('1.5. Comparações próximas da meia-noite (transição entre dias)', async () => {
  // Agendamento existente que cruza a meia-noite: 23:30 do dia 01 às 00:30 do dia 02
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status)
    VALUES (?, ?, 'Turno Meia Noite', 'Cliente Meia Noite', '2026-12-01 23:30:00', '2026-12-02 00:30:00', 'AGENDADO')
  `).run(TEST_SALON_ID, staffId1);

  // Caso 1: Anterior consecutivo (22:30 às 23:30 no dia 01) -> SEM CONFLITO
  const checkAntesMeiaNoite = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 22:30:00',
    endDt: '2026-12-01 23:30:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkAntesMeiaNoite.available, true, 'Horário antes da meia-noite consecutivo deve estar livre');

  // Caso 2: Sobreposição parcial antes da meia-noite (23:00 às 23:45) -> CONFLITO
  const checkSobreposicaoAntes = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-01 23:00:00',
    endDt: '2026-12-01 23:45:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkSobreposicaoAntes.available, false);
  assert.equal(checkSobreposicaoAntes.reason, 'SLOT_CONFLICT');

  // Caso 3: Sobreposição parcial após a meia-noite no dia seguinte (00:00 às 01:00 do dia 02) -> CONFLITO
  const checkSobreposicaoApos = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-02 00:00:00',
    endDt: '2026-12-02 01:00:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkSobreposicaoApos.available, false);
  assert.equal(checkSobreposicaoApos.reason, 'SLOT_CONFLICT');

  // Caso 4: Posterior consecutivo no dia seguinte (00:30 às 01:30 do dia 02) -> SEM CONFLITO
  const checkAposMeiaNoiteConsecutivo = salonAppointmentService.checkInternalSlotAvailability(TEST_SALON_ID, {
    startDt: '2026-12-02 00:30:00',
    endDt: '2026-12-02 01:30:00',
    staffId: staffId1,
    bypassPastCheck: true,
  });
  assert.equal(checkAposMeiaNoiteConsecutivo.available, true, 'Horário após a meia-noite consecutivo deve estar livre');
});

// ============================================================================
// VERIFICAÇÃO 2: COMPATIBILIDADE COM CLIENTES COMERCIAIS (PRODUÇÃO GCAL)
// ============================================================================

test('2.1. Produção Comercial: Calendário "primary" é PERMITIDO quando expressamente selecionado pelo salão', () => {
  process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

  const evalPrimaryProd = gatekeeper.evaluateGatekeeper({
    userId: TEST_SALON_ID,
    calendarId: 'primary',
    appointmentId: 1001,
    accountEmail: 'salao.comercial@gmail.com',
    isDemo: false,
  });

  assert.equal(evalPrimaryProd.allowed, true, 'Em produção comercial, o calendário primary deve ser permitido');
  assert.equal(evalPrimaryProd.reason, 'AUTHORIZED_PRODUCTION');
  assert.equal(evalPrimaryProd.isHomologation, false);
});

test('2.2. Produção Comercial: Calendário secundário também é PERMITIDO quando configurado pelo salão', () => {
  process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';

  const evalSecundarioProd = gatekeeper.evaluateGatekeeper({
    userId: TEST_SALON_ID,
    calendarId: 'c_abc123_secundaria@group.calendar.google.com',
    appointmentId: 1002,
    accountEmail: 'salao.comercial@gmail.com',
    isDemo: false,
  });

  assert.equal(evalSecundarioProd.allowed, true, 'Em produção comercial, calendário secundário deve ser permitido');
  assert.equal(evalSecundarioProd.reason, 'AUTHORIZED_PRODUCTION');
});

test('2.3. Produção Comercial: Allowlist global de homologação NÃO impede clientes comerciais legítimos', () => {
  process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
  // Allowlist de homologação configurada apenas com e-mail institucional
  process.env.GOOGLE_SYNC_ALLOWED_EMAILS = 'relinautomacoes@gmail.com';
  process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'relinautomacoes@gmail.com';

  // Salão comercial conectou com seu próprio e-mail legítimo
  const evalClienteComercial = gatekeeper.evaluateGatekeeper({
    userId: TEST_SALON_ID,
    calendarId: 'primary',
    appointmentId: 1003,
    accountEmail: 'cliente.salao.novo@barbearia.com.br',
    isDemo: false,
  });

  assert.equal(evalClienteComercial.allowed, true, 'Allowlist de homologação não pode bloquear clientes comerciais em produção');
  assert.equal(evalClienteComercial.reason, 'AUTHORIZED_PRODUCTION');

  const checkLiveAllowed = googleCalendarService.isLiveGoogleSyncAllowed('cliente.salao.novo@barbearia.com.br');
  assert.equal(checkLiveAllowed, true, 'isLiveGoogleSyncAllowed deve retornar true em produção para clientes legítimos');
});

test('2.4. Homologação Controlada: Anti-Primary Shield e os 5 pinos continuam estritamente obrigatórios', () => {
  process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
  process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
  process.env.GOOGLE_SYNC_AUTHORIZED_TENANT_ID = '999';
  process.env.GOOGLE_SYNC_AUTHORIZED_CALENDAR_ID = 'c_homologacao@group.calendar.google.com';
  process.env.GOOGLE_SYNC_AUTHORIZED_APPOINTMENT_ID = '555';
  process.env.GOOGLE_SYNC_AUTHORIZED_EMAIL = 'relinautomacoes@gmail.com';

  // Tentativa de usar "primary" em homologação -> BLOQUEIO
  const evalPrimaryHomolog = gatekeeper.evaluateGatekeeper({
    userId: 999,
    calendarId: 'primary',
    appointmentId: 555,
    accountEmail: 'relinautomacoes@gmail.com',
    isDemo: false,
  });
  assert.equal(evalPrimaryHomolog.allowed, false);
  assert.equal(evalPrimaryHomolog.reason, 'PRIMARY_CALENDAR_PROHIBITED', 'Em homologação, primary continua proibido');

  // Tentativa com e-mail divergente em homologação -> BLOQUEIO
  const evalEmailDivergente = gatekeeper.evaluateGatekeeper({
    userId: 999,
    calendarId: 'c_homologacao@group.calendar.google.com',
    appointmentId: 555,
    accountEmail: 'outro@gmail.com',
    isDemo: false,
  });
  assert.equal(evalEmailDivergente.allowed, false);
  assert.equal(evalEmailDivergente.reason, 'DIVERGENT_EMAIL');

  // Conta Demo continua universalmente bloqueada
  const evalDemo = gatekeeper.evaluateGatekeeper({
    userId: 999,
    calendarId: 'c_homologacao@group.calendar.google.com',
    appointmentId: 555,
    accountEmail: 'relinautomacoes@gmail.com',
    isDemo: true,
  });
  assert.equal(evalDemo.allowed, false);
  assert.equal(evalDemo.reason, 'DEMO_TENANT_BLOCKED');
});

test('2.5. Auditoria Histórica de Conflitos: detectAndFlagHistoricalConflicts com formatos mistos', () => {
  // Insere dois agendamentos conflitantes no mesmo horário para o mesmo profissional, um em ISO e outro em SQL
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status, has_conflict)
    VALUES (?, ?, 'Apt 1 SQL', 'Cliente A', '2026-12-10 10:00:00', '2026-12-10 11:00:00', 'AGENDADO', 0)
  `).run(TEST_SALON_ID, staffId1);

  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, client_name, start_datetime, end_datetime, status, has_conflict)
    VALUES (?, ?, 'Apt 2 ISO', 'Cliente B', '2026-12-10T10:30:00', '2026-12-10T11:30:00', 'AGENDADO', 0)
  `).run(TEST_SALON_ID, staffId1);

  const res = salonAppointmentService.detectAndFlagHistoricalConflicts(TEST_SALON_ID);
  assert.ok(res.flaggedCount >= 2, 'Ambos os agendamentos sobrepostos devem ser sinalizados');
  assert.ok(res.conflicts.length >= 1, 'Deve retornar ao menos 1 par de conflito');
});
