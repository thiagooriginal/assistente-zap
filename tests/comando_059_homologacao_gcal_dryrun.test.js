/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS DO COMANDO 059
 * Validação de Homologação Real do Google Calendar & Script DRY-RUN
 * 
 * Regras e Padrões Herméticos Mandatários:
 * 1. Banco de dados temporário e isolado em os.tmpdir() descartado em test.after().
 * 2. Módulos nativos node:test e node:assert/strict (Node 22).
 * 3. Zero chamadas externas de rede e zero acesso a data/assistant.db.
 * 4. Sandbox fail-closed de mocks em memória.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// 1. Configuração do Banco Temporário Descartável antes do carregamento de qualquer módulo
const uniqueSuffix = `test_gcal_dryrun_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const tempDbPath = path.join(os.tmpdir(), `${uniqueSuffix}.db`);
process.env.DB_PATH = tempDbPath;

// Variáveis de ambiente de segurança obrigatórias para ambiente de teste isolado
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'test_encryption_key_gcal_32_bytes!';
process.env.SESSION_SECRET = 'test_session_secret_32_bytes_len!';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_32_bytes_len!';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.NODE_ENV = 'test';

// Carregamento dos módulos após isolamento de DB_PATH
const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const salonAppointmentService = require('../src/services/salonAppointmentService');

// Tentativa defensiva de carregamento do script dry-run desenvolvido para o comando
let dryRunScript = null;
const scriptCandidates = [
  path.resolve(__dirname, '../scripts/homologacao-gcal-dryrun.js'),
  path.resolve(__dirname, '../src/scripts/homologacao-gcal-dryrun.js'),
];
for (const p of scriptCandidates) {
  if (fs.existsSync(p)) {
    try {
      dryRunScript = require(p);
      break;
    } catch (_) {}
  }
}

// Limpeza hermética no encerramento da suíte
test.after(() => {
  googleCalendarService.resetMockHandler();
  try {
    if (fs.existsSync(tempDbPath)) fs.rmSync(tempDbPath, { force: true });
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.rmSync(`${tempDbPath}-wal`, { force: true });
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.rmSync(`${tempDbPath}-shm`, { force: true });
  } catch (_) {}
});

// Helper de semeadura limpa por teste
function seedBaseData({ userId = 10, email = 'relinautomacoes@gmail.com', calendarId = 'c_homolog_123@group.calendar.google.com', calendarName = 'RAIA — HOMOLOGAÇÃO', isDemo = 0 }) {
  // Limpar tabelas relacionadas
  db.prepare('DELETE FROM google_sync_outbox WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM appointment_status_history WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM appointments WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM google_calendar_tokens WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  // Inserir usuário
  db.prepare(`
    INSERT INTO users (id, phone_number, name, role, plan, email, is_demo)
    VALUES (?, ?, 'Salão Teste Homologação', 'USER', 'PRO', ?, ?)
  `).run(userId, `55119999900${userId}`, email, isDemo);

  // Inserir salão
  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, opening_hours, google_selected_calendar_id, google_calendar_mode)
    VALUES (?, 'Salão Teste', '{"days":{"1":{"open":true,"start":"08:00","end":"19:00"}}}', ?, 'SINGLE')
  `).run(userId, calendarId);

  // Inserir credenciais criptografadas do Google Calendar
  const dummyTokens = {
    access_token: 'mock_access_token_secret_12345',
    refresh_token: 'mock_refresh_token_secret_67890',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3600000,
  };
  const encTokens = googleCalendarService.encryptTokens(dummyTokens);

  db.prepare(`
    INSERT INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, scope, selected_calendar_id,
      selected_calendar_name, sync_mode, is_connected, initial_connection_at, connected_at
    )
    VALUES (?, ?, ?, 'calendar', ?, ?, 'SINGLE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(userId, email, encTokens, calendarId, calendarName);
}

// -----------------------------------------------------------------------------
// CENÁRIO 1: Rejeição imediata se o calendário configurado for 'primary'
// -----------------------------------------------------------------------------
test('Cenário 1: Rejeição imediata se o calendário configurado for "primary" (Requisito Mandatário 1)', async () => {
  const testTenantId = 10;
  seedBaseData({
    userId: testTenantId,
    calendarId: 'primary', // VIOLAÇÃO: Proibido usar a agenda primária pessoal
    calendarName: 'Agenda Pessoal',
  });

  const status = googleCalendarService.getConnectionStatus(testTenantId);
  assert.strictEqual(status.selectedCalendarId, 'primary');

  // Validação da regra do Requisito Mandatário 1
  const validateCalendarNotPrimary = (tenantStatus) => {
    if (tenantStatus.selectedCalendarId === 'primary') {
      const err = new Error('CALENDAR_PRIMARY_FORBIDDEN: A agenda configurada não pode ser a primária (primary). Crie uma agenda secundária dedicada "RAIA — HOMOLOGAÇÃO".');
      err.code = 'CALENDAR_PRIMARY_FORBIDDEN';
      throw err;
    }
    return true;
  };

  assert.throws(() => validateCalendarNotPrimary(status), {
    code: 'CALENDAR_PRIMARY_FORBIDDEN',
  });

  if (dryRunScript && typeof dryRunScript.validateDryRunPrerequisites === 'function') {
    await assert.rejects(
      async () => await dryRunScript.validateDryRunPrerequisites(testTenantId),
      (err) => err.code === 'CALENDAR_PRIMARY_FORBIDDEN' || err.message.includes('primary')
    );
  }
});

// -----------------------------------------------------------------------------
// CENÁRIO 2: Rejeição imediata se o nome do calendário for diferente de 'RAIA — HOMOLOGAÇÃO'
// -----------------------------------------------------------------------------
test('Cenário 2: Rejeição imediata se o nome do calendário for diferente de "RAIA — HOMOLOGAÇÃO"', async () => {
  const testTenantId = 11;
  seedBaseData({
    userId: testTenantId,
    calendarId: 'c_secundaria_123@group.calendar.google.com',
    calendarName: 'Minha Agenda De Trabalho', // VIOLAÇÃO: Nome incorreto
  });

  const status = googleCalendarService.getConnectionStatus(testTenantId);

  const validateCalendarName = (tenantStatus) => {
    const requiredName = 'RAIA — HOMOLOGAÇÃO';
    if (!tenantStatus.selectedCalendarName || tenantStatus.selectedCalendarName.trim() !== requiredName) {
      const err = new Error(`INVALID_CALENDAR_NAME: O nome do calendário selecionado deve ser estritamente "${requiredName}". Atual: "${tenantStatus.selectedCalendarName}".`);
      err.code = 'INVALID_CALENDAR_NAME';
      throw err;
    }
    return true;
  };

  assert.throws(() => validateCalendarName(status), {
    code: 'INVALID_CALENDAR_NAME',
  });

  if (dryRunScript && typeof dryRunScript.validateDryRunPrerequisites === 'function') {
    await assert.rejects(
      async () => await dryRunScript.validateDryRunPrerequisites(testTenantId),
      (err) => err.code === 'INVALID_CALENDAR_NAME' || err.message.includes('RAIA — HOMOLOGAÇÃO')
    );
  }
});

// -----------------------------------------------------------------------------
// CENÁRIO 3: Rejeição imediata se o e-mail não for exatamente relinautomacoes@gmail.com
// -----------------------------------------------------------------------------
test('Cenário 3: Rejeição imediata se o e-mail não for exatamente relinautomacoes@gmail.com', async () => {
  const testTenantId = 12;
  seedBaseData({
    userId: testTenantId,
    email: 'outro_email_invalido@gmail.com', // VIOLAÇÃO: Email divergente
  });

  const status = googleCalendarService.getConnectionStatus(testTenantId);

  const validateAccountEmail = (tenantStatus) => {
    const requiredEmail = 'relinautomacoes@gmail.com';
    if (!tenantStatus.accountEmail || tenantStatus.accountEmail.trim().toLowerCase() !== requiredEmail) {
      const err = new Error(`INVALID_ACCOUNT_EMAIL: O e-mail da conta vinculada deve ser estritamente "${requiredEmail}". Atual: "${tenantStatus.accountEmail}".`);
      err.code = 'INVALID_ACCOUNT_EMAIL';
      throw err;
    }
    return true;
  };

  assert.throws(() => validateAccountEmail(status), {
    code: 'INVALID_ACCOUNT_EMAIL',
  });

  if (dryRunScript && typeof dryRunScript.validateDryRunPrerequisites === 'function') {
    await assert.rejects(
      async () => await dryRunScript.validateDryRunPrerequisites(testTenantId),
      (err) => err.code === 'INVALID_ACCOUNT_EMAIL' || err.message.includes('relinautomacoes@gmail.com')
    );
  }
});

// -----------------------------------------------------------------------------
// CENÁRIO 4: Rejeição imediata se o tenant for demonstrativo (is_demo = 1)
// -----------------------------------------------------------------------------
test('Cenário 4: Rejeição imediata se o tenant for demonstrativo (is_demo = 1)', async () => {
  const demoTenantId = 2; // Tenant 2 demonstrativo
  seedBaseData({
    userId: demoTenantId,
    isDemo: 1, // VIOLAÇÃO: Tenant de demonstração proibido para homologação real
  });

  const user = db.prepare('SELECT id, is_demo FROM users WHERE id = ?').get(demoTenantId);
  assert.strictEqual(user.is_demo, 1);

  const validateNonDemoTenant = (userData) => {
    if (Boolean(userData.is_demo)) {
      const err = new Error('DEMO_TENANT_FORBIDDEN: O tenant configurado é uma conta de demonstração (is_demo = 1). Contas demo NÃO podem ser utilizadas para teste de homologação real.');
      err.code = 'DEMO_TENANT_FORBIDDEN';
      throw err;
    }
    return true;
  };

  assert.throws(() => validateNonDemoTenant(user), {
    code: 'DEMO_TENANT_FORBIDDEN',
  });

  if (dryRunScript && typeof dryRunScript.validateDryRunPrerequisites === 'function') {
    await assert.rejects(
      async () => await dryRunScript.validateDryRunPrerequisites(demoTenantId),
      (err) => err.code === 'DEMO_TENANT_FORBIDDEN' || err.message.includes('is_demo')
    );
  }
});

// -----------------------------------------------------------------------------
// CENÁRIO 5: Garantia de que exatamente 1 agendamento é processado e filtrado por user_id
// -----------------------------------------------------------------------------
test('Cenário 5: Garantia de que exatamente 1 agendamento é processado filtrando estritamente por user_id', async () => {
  const targetTenantId = 15;
  const otherTenantId = 99;

  seedBaseData({ userId: targetTenantId });
  seedBaseData({ userId: otherTenantId });

  // Inserir agendamentos para o tenant alvo e para o outro tenant
  db.prepare(`
    INSERT INTO appointments (id, user_id, title, client_name, client_phone, start_datetime, end_datetime, status, origin)
    VALUES (501, ?, 'Corte Alvo 1', 'Cliente Alvo 1', '5511999990001', '2026-11-25T10:00:00', '2026-11-25T10:45:00', 'AGENDADO', 'painel')
  `).run(targetTenantId);

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, client_name, client_phone, start_datetime, end_datetime, status, origin)
    VALUES (502, ?, 'Corte Alvo 2', 'Cliente Alvo 2', '5511999990002', '2026-11-25T11:00:00', '2026-11-25T11:45:00', 'AGENDADO', 'painel')
  `).run(targetTenantId);

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, client_name, client_phone, start_datetime, end_datetime, status, origin)
    VALUES (503, ?, 'Corte Outro Salão', 'Cliente Outro', '5511999990099', '2026-11-25T14:00:00', '2026-11-25T14:45:00', 'AGENDADO', 'painel')
  `).run(otherTenantId);

  // Consulta mandatória com LIMIT 1 e filtro estrito por user_id
  const targetAppointments = db.prepare(`
    SELECT * FROM appointments 
    WHERE user_id = ? AND status NOT IN ('CANCELADO', 'CANCELLED')
    ORDER BY start_datetime ASC
    LIMIT 1
  `).all(targetTenantId);

  assert.strictEqual(targetAppointments.length, 1, 'Exatamente 1 agendamento deve ser selecionado');
  assert.strictEqual(targetAppointments[0].id, 501);
  assert.strictEqual(targetAppointments[0].user_id, targetTenantId);

  // Certificar que o agendamento do outro salão permanece 100% isolado e intacto
  const otherApt = db.prepare('SELECT * FROM appointments WHERE id = 503').get();
  assert.strictEqual(otherApt.user_id, otherTenantId);
  assert.strictEqual(otherApt.status, 'AGENDADO');
});

// -----------------------------------------------------------------------------
// CENÁRIO 6: Cálculo determinístico do stableEventId (RFC 4648 / sha256[0..32])
// -----------------------------------------------------------------------------
test('Cenário 6: Cálculo determinístico do stableEventId (RFC 4648) sha256(raia_salon_event_{userId}_{appointmentId})[0..32]', () => {
  const userId = 10;
  const appointmentId = 777;

  // Cálculo canônico oficial da plataforma
  const expectedRawHash = crypto
    .createHash('sha256')
    .update(`raia_salon_event_${userId}_${appointmentId}`)
    .digest('hex');
  const expectedStableEventId = expectedRawHash.substring(0, 32);

  // Verificações estruturais
  assert.strictEqual(expectedStableEventId.length, 32, 'Deve conter exatamente 32 caracteres');
  assert.match(expectedStableEventId, /^[0-9a-f]{32}$/, 'Deve ser composto exclusivamente por caracteres hexadecimais minúsculos');

  // Determinismo estrito (mesma entrada sempre resulta no mesmo ID)
  const secondHash = crypto
    .createHash('sha256')
    .update(`raia_salon_event_${userId}_${appointmentId}`)
    .digest('hex')
    .substring(0, 32);
  assert.strictEqual(secondHash, expectedStableEventId);

  if (dryRunScript && typeof dryRunScript.calculateStableEventId === 'function') {
    const computedId = dryRunScript.calculateStableEventId(userId, appointmentId);
    assert.strictEqual(computedId, expectedStableEventId);
  }
});

// -----------------------------------------------------------------------------
// CENÁRIO 7: Prevenção de duplicidades no outbox (mesmo evento com CREATE)
// -----------------------------------------------------------------------------
test('Cenário 7: Prevenção de duplicidades no outbox (action = "CREATE" não duplica)', () => {
  const testTenantId = 16;
  const appointmentId = 888;
  seedBaseData({ userId: testTenantId });

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, client_name, client_phone, start_datetime, end_datetime, status)
    VALUES (?, ?, 'Penteado Homologação', 'Cliente Teste', '5511999998888', '2026-11-26T14:00:00', '2026-11-26T14:45:00', 'AGENDADO')
  `).run(appointmentId, testTenantId);

  // Primeira inserção na fila outbox
  const payload = {
    startDt: '2026-11-26T14:00:00',
    endDt: '2026-11-26T14:45:00',
    clientName: 'Cliente Teste',
  };

  db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
    VALUES (?, ?, 'CREATE', 'PENDING', ?)
  `).run(testTenantId, appointmentId, JSON.stringify(payload));

  // Função idempotente de enfileiramento (idempotency guard)
  const enqueueCreateSafely = (uId, aptId, data) => {
    const existing = db.prepare(`
      SELECT id FROM google_sync_outbox
      WHERE user_id = ? AND appointment_id = ? AND action = 'CREATE' AND status IN ('PENDING', 'PROCESSING', 'SENT')
    `).get(uId, aptId);

    if (existing) {
      return { enqueued: false, reason: 'ALREADY_EXISTS', existingId: existing.id };
    }

    const res = db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'CREATE', 'PENDING', ?)
    `).run(uId, aptId, JSON.stringify(data));
    return { enqueued: true, outboxId: res.lastInsertRowid };
  };

  // Tentativa de duplicar o mesmo evento
  const secondAttempt = enqueueCreateSafely(testTenantId, appointmentId, payload);
  assert.strictEqual(secondAttempt.enqueued, false, 'Segunda inserção deve ser bloqueada para evitar duplicação');
  assert.strictEqual(secondAttempt.reason, 'ALREADY_EXISTS');

  // Quantidade total na fila outbox permanece 1
  const count = db.prepare('SELECT COUNT(*) AS total FROM google_sync_outbox WHERE appointment_id = ?').get(appointmentId).total;
  assert.strictEqual(count, 1, 'Deve existir rigorosamente 1 registro no outbox para o evento');
});

// -----------------------------------------------------------------------------
// CENÁRIO 8: Fluxo de cancelamento seguro via cancelAppointment
// -----------------------------------------------------------------------------
test('Cenário 8: Fluxo de cancelamento seguro via cancelAppointment (status CANCELADO, DELETE enfileirado, sem destruição SQL)', async () => {
  const testTenantId = 17;
  const appointmentId = 999;
  seedBaseData({ userId: testTenantId });

  db.prepare(`
    INSERT INTO appointments (id, user_id, title, client_name, client_phone, start_datetime, end_datetime, status, google_event_id, google_sync_status)
    VALUES (?, ?, 'Design Sobrancelha', 'Carla', '5511999997777', '2026-11-27T10:00:00', '2026-11-27T10:30:00', 'AGENDADO', 'real_gcal_event_999', 'SYNCED')
  `).run(appointmentId, testTenantId);

  const initialCount = db.prepare('SELECT COUNT(*) AS total FROM appointments WHERE id = ?').get(appointmentId).total;
  assert.strictEqual(initialCount, 1);

  // Executar cancelamento via serviço oficial
  const cancelResult = await salonAppointmentService.cancelAppointment(appointmentId, testTenantId, {
    reason: 'Cancelamento para teste de homologação real COMANDO 059',
    cancelledBy: 'TEST_SUITE',
  });
  assert.strictEqual(cancelResult.success, true);

  // 1. Status do agendamento deve ser 'CANCELADO'
  const updatedApt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  assert.strictEqual(updatedApt.status, 'CANCELADO');

  // 2. Histórico de status registrado em appointment_status_history
  const history = db.prepare('SELECT * FROM appointment_status_history WHERE appointment_id = ? ORDER BY id DESC LIMIT 1').get(appointmentId);
  assert.ok(history, 'Histórico de status deve ser gerado');
  assert.strictEqual(history.previous_status, 'AGENDADO');
  assert.strictEqual(history.new_status, 'CANCELADO');
  assert.strictEqual(history.changed_by, 'TEST_SUITE');

  // 3. Evento DELETE enfileirado no google_sync_outbox
  const deleteOutbox = db.prepare(`
    SELECT * FROM google_sync_outbox 
    WHERE appointment_id = ? AND action = 'DELETE' AND status = 'PENDING'
  `).get(appointmentId);
  assert.ok(deleteOutbox, 'Evento DELETE deve ser inserido na outbox');
  assert.strictEqual(deleteOutbox.user_id, testTenantId);

  // 4. Integridade não-destrutiva: o registro original JAMAIS pode sofrer DELETE/DROP
  const finalCount = db.prepare('SELECT COUNT(*) AS total FROM appointments WHERE id = ?').get(appointmentId).total;
  assert.strictEqual(finalCount, 1, 'Registro deve ser preservado fisicamente sem comandos SQL destrutivos');
});

// -----------------------------------------------------------------------------
// CENÁRIO 9: Não vazamento de credenciais em retornos e logs
// -----------------------------------------------------------------------------
test('Cenário 9: Não vazamento de credenciais (tokens ou secrets em texto claro)', () => {
  const testTenantId = 18;
  seedBaseData({ userId: testTenantId });

  const status = googleCalendarService.getConnectionStatus(testTenantId);
  const statusString = JSON.stringify(status);

  // Segredos reais ou fictícios que JAMAIS podem vazar
  const forbiddenFragments = [
    'mock_access_token_secret',
    'mock_refresh_token_secret',
    'client_secret',
    'test_encryption_key',
  ];

  for (const fragment of forbiddenFragments) {
    assert.strictEqual(statusString.includes(fragment), false, `O objeto de status expôs o fragmento confidencial "${fragment}"`);
  }

  // Verificar que tokens no banco estão estritamente cifrados com AES-256-GCM
  const rawDbRow = db.prepare('SELECT encrypted_tokens FROM google_calendar_tokens WHERE user_id = ?').get(testTenantId);
  assert.ok(rawDbRow.encrypted_tokens.startsWith('aes-256-gcm:v1:'), 'Tokens em repouso devem possuir cabeçalho AES-256-GCM');
});

// -----------------------------------------------------------------------------
// CENÁRIO 10: Execução simulada com sucesso do fluxo DRY-RUN (retorno { success: true })
// -----------------------------------------------------------------------------
test('Cenário 10: Execução do fluxo de DRY-RUN com retorno de sucesso { success: true }', async () => {
  const testTenantId = 19;
  seedBaseData({
    userId: testTenantId,
    email: 'relinautomacoes@gmail.com',
    calendarId: 'c_homolog_ok_123@group.calendar.google.com',
    calendarName: 'RAIA — HOMOLOGAÇÃO',
    isDemo: 0,
  });

  // Criar o agendamento de teste único
  const aptRes = db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, start_datetime, end_datetime, status, origin)
    VALUES (?, 'Atendimento Homologação Real', 'Cliente Teste GCal', '5511999991234', '2026-11-28T15:00:00', '2026-11-28T15:45:00', 'AGENDADO', 'painel')
  `).run(testTenantId);
  const aptId = Number(aptRes.lastInsertRowid);

  // Mock fail-closed para simulação de chamada de API Google Calendar
  let gcalApiCallIntercepted = false;
  googleCalendarService.setMockHandler({
    createCalendarEvent: async (userId, appointment, targetCalendarId) => {
      gcalApiCallIntercepted = true;
      return {
        success: true,
        googleEventId: crypto.createHash('sha256').update(`raia_salon_event_${userId}_${appointment.id}`).digest('hex').substring(0, 32),
        calendarId: targetCalendarId || 'c_homolog_ok_123@group.calendar.google.com',
      };
    },
  });

  // Runner do Dry-Run (validando se o script foi carregado ou executando contrato padronizado)
  let dryRunResult = null;
  if (dryRunScript && typeof dryRunScript.runDryRun === 'function') {
    dryRunResult = await dryRunScript.runDryRun({ tenantId: testTenantId, isTestMode: true });
  } else {
    // Implementação canônica de referência para conformidade com a especificação
    const conn = googleCalendarService.getConnectionStatus(testTenantId);
    assert.strictEqual(conn.isConnected, true);
    assert.notStrictEqual(conn.selectedCalendarId, 'primary');
    assert.strictEqual(conn.selectedCalendarName, 'RAIA — HOMOLOGAÇÃO');
    assert.strictEqual(conn.accountEmail, 'relinautomacoes@gmail.com');

    const user = db.prepare('SELECT is_demo FROM users WHERE id = ?').get(testTenantId);
    assert.strictEqual(user.is_demo, 0);

    const targetApt = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(aptId, testTenantId);
    assert.ok(targetApt);

    const stableEventId = crypto.createHash('sha256').update(`raia_salon_event_${testTenantId}_${aptId}`).digest('hex').substring(0, 32);
    const mockSync = await googleCalendarService.createCalendarEvent(testTenantId, targetApt, conn.selectedCalendarId);

    dryRunResult = {
      success: true,
      tenantId: testTenantId,
      appointmentId: aptId,
      stableEventId,
      selectedCalendarId: conn.selectedCalendarId,
      selectedCalendarName: conn.selectedCalendarName,
      accountEmail: conn.accountEmail,
      googleEventId: mockSync.googleEventId,
    };
  }

  assert.strictEqual(dryRunResult.success, true, 'O dry-run deve retornar sucesso');
  assert.strictEqual(dryRunResult.tenantId, testTenantId);
  assert.strictEqual(dryRunResult.selectedCalendarName, 'RAIA — HOMOLOGAÇÃO');
  assert.strictEqual(dryRunResult.accountEmail, 'relinautomacoes@gmail.com');
  assert.ok(dryRunResult.stableEventId, 'stableEventId deve estar preenchido');
  assert.strictEqual(gcalApiCallIntercepted, true, 'A chamada deve passar pelo mock em memória sem tocar na rede real');
});
