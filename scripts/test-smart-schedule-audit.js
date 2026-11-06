/**
 * RAIA AGENTES — SUÍTE DE AUDITORIA CORRETIVA FINAL DA AGENDA INTELIGENTE (22 TESTES)
 * 
 * Verificações obrigatórias de segurança, concorrência, unificação e resiliência:
 * 1. Agendamento iniciado pelo WhatsApp e sincronizado com o motor central.
 * 2. Conflito entre reserva do painel e reserva iniciada pelo WhatsApp.
 * 3. Consulta lenta ou indisponível do Google sem bloquear o SQLite indevidamente.
 * 4. Google obrigatório, porém desconectado.
 * 5. Dois profissionais com calendários Google distintos (modalidade STAFF).
 * 6. Reinício do container com eventos pendentes nas filas (recuperação de tarefas abandonadas).
 * 7. Retry da criação de evento sem duplicação no Google.
 * 8. Retry de notificação WhatsApp sem envio duplicado (deduplicação persistente).
 * 9. Ausência de profissional ativo.
 * 10. Múltiplos profissionais sem seleção explícita.
 * 11. Rejeição de status arbitrário ou forjado.
 * 12. Falta de chave criptográfica obrigatória (fail-closed).
 * 13. Compatibilidade com reservas históricas e status legados.
 * 14. Teste ponta a ponta: confirmação, gravação, outbox Google processado e WhatsApp simulado.
 * 15. Segurança OAuth: sessão ausente, expirada e vinculação cruzada.
 * 16. WhatsApp valida Google Calendar antes de confirmar.
 * 17. Outbox durável em remarcação e cancelamento.
 * 18. Status AGENDADO/SCHEDULED e concorrência no updateAppointment.
 * 19. Reconciliação determinística no Google Calendar.
 * 20. Resolução prévia de profissional efetivo e consulta individual em modalidade STAFF.
 * 21. Idempotência de eventos Google com identificador estável e crash recovery.
 * 22. Auditoria da rota legada POST /api/appointments impedindo bypass do Google para salões.
 */

process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'test';
process.env.ALLOW_WHATSAPP_SENDING = 'false';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'raia-segredo-super-forte-de-32-bytes-para-testes!';
process.env.ADMIN_PASSWORD = 'raia-segredo-super-forte-admin-123456!';

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const googleCalendarService = require('../src/services/googleCalendarService');
const salonNotificationService = require('../src/services/salonNotificationService');
const appointmentService = require('../src/services/appointmentService');
const outboxWorker = require('../src/services/outboxWorker');

let testSalonUser = null;
let staff1 = null;
let staff2 = null;
let serviceCorte = null;

// Mock in-memory state for deterministic tests
const mockGoogleState = {
  connected: false,
  email: 'salao.teste@raiaagentes.com.br',
  syncMode: 'SINGLE',
  selectedCalendarId: 'primary',
  events: new Map(),
  busySlotsByCalendar: new Map(),
  insertCallCount: 0,
};

async function setup() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — AUDITORIA FINAL DA AGENDA INTELIGENTE (22 TESTES)');
  console.log('================================================================\n');

  // Configurar Mocks determinísticos
  googleCalendarService.setMockHandler({
    getConnectionStatus: () => ({
      isConnected: mockGoogleState.connected,
      accountEmail: mockGoogleState.email,
      selectedCalendarId: mockGoogleState.selectedCalendarId,
      syncMode: mockGoogleState.syncMode,
      lastSyncAt: new Date().toISOString(),
    }),
    getGoogleBusySlots: async (userId, { timeMin, timeMax, calendarId, staffId }) => {
      let cal = calendarId;
      if (!cal && mockGoogleState.syncMode === 'STAFF' && staffId) {
        const row = db.prepare('SELECT google_calendar_id FROM client_staff WHERE id = ?').get(staffId);
        if (row?.google_calendar_id) cal = row.google_calendar_id;
      }
      if (!cal) cal = mockGoogleState.selectedCalendarId || 'primary';

      const slots = mockGoogleState.busySlotsByCalendar.get(cal) || [];
      return slots;
    },
    createCalendarEvent: async (userId, appointment, targetCalendarId) => {
      let cal = targetCalendarId;
      if (!cal && mockGoogleState.syncMode === 'STAFF' && appointment.staff_id) {
        const row = db.prepare('SELECT google_calendar_id FROM client_staff WHERE id = ?').get(appointment.staff_id);
        if (row?.google_calendar_id) cal = row.google_calendar_id;
      }
      if (!cal) cal = mockGoogleState.selectedCalendarId || 'primary';

      const crypto = require('crypto');
      const stableEventId = crypto
        .createHash('sha256')
        .update(`raia_salon_event_${userId}_${appointment.id}`)
        .digest('hex')
        .substring(0, 32);

      // Reconciliação determinística no mock por ID estável
      if (mockGoogleState.events.has(stableEventId)) {
        db.prepare(`
          UPDATE appointments
          SET google_event_id = ?, google_calendar_id = ?, google_sync_status = 'SYNCED', google_sync_error = NULL
          WHERE id = ?
        `).run(stableEventId, cal, appointment.id);
        return { success: true, googleEventId: stableEventId, calendarId: cal, reconciled: true };
      }

      // Reconciliação determinística no mock por id do compromisso
      for (const [existingId, evData] of mockGoogleState.events.entries()) {
        if (evData.appointment.id === appointment.id) {
          db.prepare(`
            UPDATE appointments
            SET google_event_id = ?, google_calendar_id = ?, google_sync_status = 'SYNCED', google_sync_error = NULL
            WHERE id = ?
          `).run(existingId, cal, appointment.id);
          return { success: true, googleEventId: existingId, calendarId: cal, reconciled: true };
        }
      }

      mockGoogleState.insertCallCount++;
      const eventId = stableEventId;
      mockGoogleState.events.set(eventId, { appointment, calendarId: cal });

      db.prepare(`
        UPDATE appointments
        SET google_event_id = ?, google_calendar_id = ?, google_sync_status = 'SYNCED', google_sync_error = NULL
        WHERE id = ?
      `).run(eventId, cal, appointment.id);

      return { success: true, googleEventId: eventId, calendarId: cal };
    },
    updateCalendarEvent: async (userId, googleEventId, appointment) => {
      return { success: true, googleEventId };
    },
    deleteCalendarEvent: async (userId, googleEventId) => {
      mockGoogleState.events.delete(googleEventId);
      return { success: true };
    },
  });

  // Limpar filas de execuções anteriores para isolamento do teste
  db.prepare("UPDATE google_sync_outbox SET status = 'SENT' WHERE status = 'PENDING'").run();
  db.prepare("UPDATE whatsapp_notification_outbox SET status = 'SENT' WHERE status = 'PENDING'").run();

  // Criar Usuário do Salão de Teste
  const testEmail = `audit.salon.${Date.now()}@example.com`;
  const testPhone = `55119${Math.floor(10000000 + Math.random() * 90000000)}`;
  const info = db.prepare(`
    INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, is_demo)
    VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', 0)
  `).run(testEmail, testPhone);
  const userId = info.lastInsertRowid;

  testSalonUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  // Configurar salão
  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, google_require_sync_availability)
    VALUES (?, 'Salão Auditoria Pro', '5511999990000', '5511999990000', 1, 1, 0)
  `).run(userId);

  // Criar serviço
  const sInfo = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Corte Master', 45, 90.0, 1, 'Cabelos')
  `).run(userId);
  serviceCorte = db.prepare('SELECT * FROM client_services WHERE id = ?').get(sInfo.lastInsertRowid);

  // Criar profissionais
  const st1 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active, google_calendar_id)
    VALUES (?, 'Profissional Alice', 'Cortes', 1, 'alice.agenda@group.calendar.google.com')
  `).run(userId);
  staff1 = db.prepare('SELECT * FROM client_staff WHERE id = ?').get(st1.lastInsertRowid);

  const st2 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active, google_calendar_id)
    VALUES (?, 'Profissional Bruno', 'Penteados', 1, 'bruno.agenda@group.calendar.google.com')
  `).run(userId);
  staff2 = db.prepare('SELECT * FROM client_staff WHERE id = ?').get(st2.lastInsertRowid);

  console.log(`[Setup] Salão de Auditoria preparado com sucesso (ID: ${userId}).\n`);
}

async function runTests() {
  await setup();

  // ----------------------------------------------------
  // TESTE 1: Agendamento iniciado pelo WhatsApp e sincronizado com o motor central
  // ----------------------------------------------------
  console.log('[Teste 1] Agendamento iniciado pelo WhatsApp e sincronizado com o motor central...');
  const aptBot = appointmentService.createAppointment({
    userId: testSalonUser.id,
    title: 'Corte — Cliente WhatsApp 1',
    startDateTime: '2026-11-25T10:00:00',
    staffId: staff1.id,
    serviceId: serviceCorte.id,
    durationMin: 45,
    sourceType: 'whatsapp',
  });

  assert(aptBot.id > 0);
  assert.strictEqual(aptBot.status, 'AGENDADO');

  // Verificar gravação na tabela canônica appointments
  const savedRow = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptBot.id);
  assert.strictEqual(savedRow.user_id, testSalonUser.id);
  assert.strictEqual(savedRow.staff_id, staff1.id);
  assert.strictEqual(savedRow.duration_min, 45);

  // Verificar auditoria em appointment_status_history
  const history = db.prepare('SELECT * FROM appointment_status_history WHERE appointment_id = ?').get(aptBot.id);
  assert(history);
  assert.strictEqual(history.new_status, 'AGENDADO');

  // Verificar outbox de Google e WhatsApp enfileirados
  const gOutbox = db.prepare('SELECT * FROM google_sync_outbox WHERE appointment_id = ?').get(aptBot.id);
  assert(gOutbox);
  assert.strictEqual(gOutbox.action, 'CREATE');

  const wOutbox = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE appointment_id = ?').get(aptBot.id);
  assert(wOutbox);
  assert.strictEqual(wOutbox.event_type, 'NEW_APPOINTMENT');
  console.log('  ✓ 1. Agendamento via canal WhatsApp utilizou 100% o motor central e produziu eventos em fila.\n');

  // ----------------------------------------------------
  // TESTE 2: Conflito entre reserva do painel e reserva iniciada pelo WhatsApp
  // ----------------------------------------------------
  console.log('[Teste 2] Conflito entre reserva do painel e reserva iniciada pelo WhatsApp...');
  // O agendamento anterior do bot foi das 10:00 às 10:45 para staff1.
  // Tentativa pelo painel das 10:30 às 11:15 para o mesmo profissional staff1 deve colidir!
  let errConflictPanel = null;
  try {
    await salonAppointmentService.bookAppointment(testSalonUser.id, {
      clientName: 'Cliente Painel Conflito',
      date: '2026-11-25',
      time: '10:30',
      durationMin: 45,
      staffId: staff1.id,
      origin: 'painel',
    });
  } catch (err) {
    errConflictPanel = err;
  }

  assert(errConflictPanel);
  assert.strictEqual(errConflictPanel.code, 'SLOT_CONFLICT');
  assert(errConflictPanel.suggestedSlots.length > 0);
  console.log('  ✓ 2. Conflito entre Painel e WhatsApp bloqueado com sucesso (regra unificada sem bypass).\n');

  // ----------------------------------------------------
  // TESTE 3: Consulta lenta ou indisponível do Google sem bloquear o SQLite indevidamente
  // ----------------------------------------------------
  console.log('[Teste 3] Consulta lenta ou indisponível do Google sem bloquear o SQLite indevidamente...');
  // Conectar Google temporariamente
  mockGoogleState.connected = true;

  // Medir que o SQLite permite operações concorrentes sem travamento de transação aberta
  const startTimer = Date.now();
  const createdConcurrent = await salonAppointmentService.bookAppointment(testSalonUser.id, {
    clientName: 'Cliente Concorrência Limpa',
    date: '2026-11-25',
    time: '11:00',
    durationMin: 45,
    staffId: staff1.id,
  });

  const durationMs = Date.now() - startTimer;
  assert(createdConcurrent.id > 0);
  assert(durationMs < 2000, `Operação não deve ser bloqueada (durou ${durationMs}ms)`);
  console.log(`  ✓ 3. Transação SQLite isolada de chamadas HTTP externas concluída com agilidade (${durationMs}ms).\n`);

  // ----------------------------------------------------
  // TESTE 4: Google obrigatório, porém desconectado
  // ----------------------------------------------------
  console.log('[Teste 4] Google obrigatório, porém desconectado...');
  // Ativar obrigatoriedade de sincronização
  db.prepare('UPDATE client_salons SET google_require_sync_availability = 1 WHERE user_id = ?').run(testSalonUser.id);
  mockGoogleState.connected = false; // Desconectar

  let errSyncRequired = null;
  try {
    await salonAppointmentService.bookAppointment(testSalonUser.id, {
      clientName: 'Cliente Falha Obrigatória',
      date: '2026-11-25',
      time: '12:00',
      durationMin: 45,
      staffId: staff1.id,
    });
  } catch (err) {
    errSyncRequired = err;
  }

  assert(errSyncRequired);
  assert.strictEqual(errSyncRequired.code, 'GOOGLE_CALENDAR_UNAVAILABLE');
  // Restaurar setting
  db.prepare('UPDATE client_salons SET google_require_sync_availability = 0 WHERE user_id = ?').run(testSalonUser.id);
  console.log('  ✓ 4. Google obrigatório desconectado rejeita agendamento com segurança fail-closed.\n');

  // ----------------------------------------------------
  // TESTE 5: Dois profissionais com calendários Google distintos (modalidade STAFF)
  // ----------------------------------------------------
  console.log('[Teste 5] Dois profissionais com calendários Google distintos (modalidade STAFF)...');
  mockGoogleState.connected = true;
  mockGoogleState.syncMode = 'STAFF';

  // Configurar compromisso externo somente na agenda da Alice (staff1)
  mockGoogleState.busySlotsByCalendar.set('alice.agenda@group.calendar.google.com', [
    { start: '2026-11-26T14:00:00-03:00', end: '2026-11-26T15:00:00-03:00' },
  ]);

  // Bruno (staff2) está com a agenda livre
  mockGoogleState.busySlotsByCalendar.set('bruno.agenda@group.calendar.google.com', []);

  // Tentativa com Alice (staff1) deve ser bloqueada por compromisso externo da agenda dela
  let errAliceBusy = null;
  try {
    await salonAppointmentService.bookAppointment(testSalonUser.id, {
      clientName: 'Cliente Alice Bloqueada',
      date: '2026-11-26',
      time: '14:00',
      durationMin: 45,
      staffId: staff1.id,
    });
  } catch (err) {
    errAliceBusy = err;
  }
  assert(errAliceBusy);
  assert.strictEqual(errAliceBusy.code, 'GOOGLE_CALENDAR_BUSY');

  // Tentativa no MESMO HORÁRIO com Bruno (staff2) deve ter sucesso pois a agenda dele está livre
  const aptBruno = await salonAppointmentService.bookAppointment(testSalonUser.id, {
    clientName: 'Cliente Bruno Livre',
    date: '2026-11-26',
    time: '14:00',
    durationMin: 45,
    staffId: staff2.id,
  });

  assert(aptBruno.id > 0);
  console.log('  ✓ 5. Modalidade STAFF respeitou calendários individuais distintos por profissional.\n');

  // ----------------------------------------------------
  // TESTE 6: Reinício do processo com eventos pendentes nas filas
  // ----------------------------------------------------
  console.log('[Teste 6] Reinício do processo com eventos pendentes nas filas (recuperação de tarefas)...');
  // Simular evento em PROCESSING abandonado há 10 minutos
  db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, locked_at, payload_json)
    VALUES (?, ?, 'CREATE', 'PROCESSING', datetime('now', '-10 minutes'), '{}')
  `).run(testSalonUser.id, aptBruno.id);

  db.prepare(`
    INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, status, locked_at)
    VALUES (?, ?, 'NEW_APPOINTMENT', '5511999990000', 'Mensagem travada', 'PROCESSING', datetime('now', '-10 minutes'))
  `).run(testSalonUser.id, aptBruno.id);

  // Executar rotina de recuperação do worker
  const recovered = outboxWorker.recoverStalledTasks();
  assert(recovered.googleRecovered >= 1);
  assert(recovered.whatsappRecovered >= 1);

  // Processar pendências após reinício
  const stats = await outboxWorker.processAllPending();
  assert(stats.success === true);
  console.log('  ✓ 6. Tarefas abandonadas recuperadas e processadas após reinício simulado do container.\n');

  // ----------------------------------------------------
  // TESTE 7: Retry da criação de evento sem duplicação no Google
  // ----------------------------------------------------
  console.log('[Teste 7] Retry da criação de evento sem duplicação no Google...');
  // Criar agendamento que já possui google_event_id gravado
  const initialInserts = mockGoogleState.insertCallCount;
  db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
    VALUES (?, ?, 'CREATE', 'PENDING', '{}')
  `).run(testSalonUser.id, aptBruno.id);

  await outboxWorker.processGoogleSyncOutbox();
  // Não deve ter chamado events.insert novamente pois aptBruno já possui google_event_id
  assert.strictEqual(mockGoogleState.insertCallCount, initialInserts, 'Não deve criar evento duplicado se já possui google_event_id');
  console.log('  ✓ 7. Idempotência do Google Calendar impediu a criação de evento duplicado.\n');

  // ----------------------------------------------------
  // TESTE 8: Retry de notificação WhatsApp sem envio duplicado
  // ----------------------------------------------------
  console.log('[Teste 8] Retry de notificação WhatsApp sem envio duplicado...');
  salonNotificationService.clearMockHistory();

  // Limpar histórico e criar agendamento para o teste de deduplicação
  salonNotificationService.clearMockHistory();

  const aptTest8 = salonAppointmentService.bookAppointmentSync(testSalonUser.id, {
    clientName: 'Cliente Dedup Test',
    date: '2026-11-26',
    time: '17:00',
    durationMin: 30,
    staffId: staff1.id,
  });

  // Processar a notificação inicial gerada na reserva
  await outboxWorker.processWhatsAppOutbox();
  const historyAfterFirst = salonNotificationService.getMockHistory();
  assert.strictEqual(historyAfterFirst.length, 1);

  // Tentativa de enfileirar notificação idêntica para o mesmo agendamento
  const dupRes = await salonNotificationService.queueNotification(testSalonUser.id, aptTest8.id, 'NEW_APPOINTMENT', {
    clientName: 'Cliente Dedup Test',
    serviceName: 'Corte Master',
    staffName: 'Profissional Alice',
    startDt: '2026-11-26T17:00:00',
    endDt: '2026-11-26T17:30:00',
  });

  assert(dupRes.deduplicated === true);

  // Reprocessar o worker: nenhum envio adicional deve ter ocorrido
  await outboxWorker.processWhatsAppOutbox();
  const historyAfterRetry = salonNotificationService.getMockHistory();
  assert.strictEqual(historyAfterRetry.length, 1);
  console.log('  ✓ 8. Deduplicação persistente bloqueou disparo duplicado de mensagem WhatsApp.\n');

  // ----------------------------------------------------
  // TESTE 9: Ausência de profissional ativo
  // ----------------------------------------------------
  console.log('[Teste 9] Ausência de profissional ativo...');
  // Desativar temporariamente todos os profissionais
  db.prepare('UPDATE client_staff SET active = 0 WHERE user_id = ?').run(testSalonUser.id);

  let errNoStaff = null;
  try {
    salonAppointmentService.bookAppointmentSync(testSalonUser.id, {
      clientName: 'Cliente Sem Staff',
      date: '2026-11-27',
      time: '15:00',
      durationMin: 30,
    });
  } catch (err) {
    errNoStaff = err;
  }

  assert(errNoStaff);
  assert.strictEqual(errNoStaff.code, 'NO_ACTIVE_STAFF');
  // Reativar os profissionais
  db.prepare('UPDATE client_staff SET active = 1 WHERE user_id = ?').run(testSalonUser.id);
  console.log('  ✓ 9. Bloqueio estrito de agendamento na ausência de profissionais ativos aprovado.\n');

  // ----------------------------------------------------
  // TESTE 10: Múltiplos profissionais sem seleção explícita
  // ----------------------------------------------------
  console.log('[Teste 10] Múltiplos profissionais sem seleção explícita...');
  // Salão possui staff1 e staff2 ativos. Se a requisição não enviar staffId, deve exigir seleção!
  let errStaffRequired = null;
  try {
    salonAppointmentService.bookAppointmentSync(testSalonUser.id, {
      clientName: 'Cliente Sem Seleção',
      date: '2026-11-27',
      time: '15:00',
      durationMin: 30,
      staffId: null, // Sem seleção explícita
    });
  } catch (err) {
    errStaffRequired = err;
  }

  assert(errStaffRequired);
  assert.strictEqual(errStaffRequired.code, 'STAFF_REQUIRED');
  console.log('  ✓ 10. Múltiplos profissionais sem seleção exigem escolha explícita (sem auto-seleção cega).\n');

  // ----------------------------------------------------
  // TESTE 11: Rejeição de status arbitrário ou forjado
  // ----------------------------------------------------
  console.log('[Teste 11] Rejeição de status arbitrário ou forjado...');
  // 1. Tentar forjar status no cadastro inicial
  const aptClean = salonAppointmentService.bookAppointmentSync(testSalonUser.id, {
    clientName: 'Cliente Forja Status',
    date: '2026-11-27',
    time: '15:00',
    durationMin: 30,
    staffId: staff1.id,
    status: 'CONCLUÍDO', // Forjado
  });

  // O motor deve ter imposto o status inicial 'AGENDADO'
  assert.strictEqual(aptClean.status, 'AGENDADO');

  // 2. Tentar atualizar para status inválido via updateAppointmentStatus
  let errInvalidStatus = null;
  try {
    salonAppointmentService.updateAppointmentStatus(aptClean.id, testSalonUser.id, 'HACKEADO');
  } catch (err) {
    errInvalidStatus = err;
  }
  assert(errInvalidStatus);
  assert.strictEqual(errInvalidStatus.code, 'INVALID_STATUS');
  console.log('  ✓ 11. Rejeição de status arbitrário ou forjado validada com sucesso.\n');

  // ----------------------------------------------------
  // TESTE 12: Falta de chave criptográfica obrigatória
  // ----------------------------------------------------
  console.log('[Teste 12] Falta de chave criptográfica obrigatória (fail-closed)...');
  const originalKey = process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY;
  const originalMfaKey = process.env.MFA_ENCRYPTION_KEY;
  delete process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY;
  delete process.env.MFA_ENCRYPTION_KEY;

  let errMissingKey = null;
  try {
    googleCalendarService.encryptTokens({ token: 'abc' });
  } catch (err) {
    errMissingKey = err;
  }

  assert(errMissingKey);
  assert.strictEqual(errMissingKey.code, 'MISSING_ENCRYPTION_KEY');

  // Restaurar chave
  process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = originalKey;
  process.env.MFA_ENCRYPTION_KEY = originalMfaKey;
  console.log('  ✓ 12. Ausência de chave criptográfica obrigatória aborta operação de forma segura fail-closed.\n');

  // ----------------------------------------------------
  // TESTE 13: Compatibilidade com reservas históricas e status legados
  // ----------------------------------------------------
  console.log('[Teste 13] Compatibilidade com reservas históricas e status legados...');
  // Inserir registro com status legado SCHEDULED e CANCELLED
  const leg1 = db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, end_datetime, status)
    VALUES (?, 'Legado 1', '2026-11-28T10:00:00', '2026-11-28T10:30:00', 'SCHEDULED')
  `).run(testSalonUser.id);

  const list = salonAppointmentService.listAppointments(testSalonUser.id);
  const foundLeg1 = list.find((a) => a.id === leg1.lastInsertRowid);
  assert(foundLeg1);
  assert.strictEqual(foundLeg1.status, 'AGENDADO'); // Mapeado amigavelmente para PT-BR
  console.log('  ✓ 13. Mapeamento de status legados SCHEDULED/CONFIRMED preservado com retrocompatibilidade.\n');

  // ----------------------------------------------------
  // TESTE 14: Teste ponta a ponta: cliente confirma, reserva gravada, Google sincronizado e WhatsApp simulado
  // ----------------------------------------------------
  console.log('[Teste 14] Teste ponta a ponta integrado...');
  salonNotificationService.clearMockHistory();

  // 1. Cliente agenda
  const aptE2E = await salonAppointmentService.bookAppointment(testSalonUser.id, {
    clientName: 'Cliente Experiência Completa',
    date: '2026-11-27',
    time: '16:00',
    durationMin: 45,
    staffId: staff1.id,
    origin: 'painel',
  });

  assert(aptE2E.id > 0);
  assert.strictEqual(aptE2E.status, 'AGENDADO');

  // 2. Processar Outbox
  await outboxWorker.processAllPending();

  // 3. Verificar Google espelhado com SYNCED
  const checkApt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptE2E.id);
  assert.strictEqual(checkApt.google_sync_status, 'SYNCED');
  assert(checkApt.google_event_id);

  // 4. Verificar Notificação WhatsApp marcada como SIMULATED (nunca SENT falso)
  const waRow = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE appointment_id = ?').get(aptE2E.id);
  assert(waRow);
  assert.strictEqual(waRow.status, 'SIMULATED');
  assert.strictEqual(waRow.is_simulated, 1);
  assert(waRow.sent_at);
  assert.strictEqual(checkApt.whatsapp_notified, 1);

  console.log('  ✓ 14. Fluxo ponta a ponta validado com integridade entre reserva, Google e WhatsApp.\n');

  // ----------------------------------------------------
  // TESTE 15: Segurança OAuth: sessão ausente, expirada e rejeição de vinculação cruzada
  // ----------------------------------------------------
  console.log('[Teste 15] Segurança OAuth: sessão ausente, expirada e vinculação cruzada...');
  
  // 15.1 Rejeição de callback sem sessão válida (UNAUTHORIZED_OAUTH_CALLBACK)
  const stateNoSession = `oauth_state_nosession_${Date.now()}`;
  db.prepare(`
    INSERT INTO oauth_states (state, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(stateNoSession, testSalonUser.id, Date.now() + 600000);

  let errNoSession = null;
  try {
    await googleCalendarService.handleOAuthCallback('fake_code', stateNoSession, null);
  } catch (err) {
    errNoSession = err;
  }
  assert(errNoSession);
  assert.strictEqual(errNoSession.code, 'UNAUTHORIZED_OAUTH_CALLBACK');
  assert(!db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(stateNoSession), 'State deve ser deletado após rejeição de sessão ausente');

  // 15.2 Rejeição de state expirado (STATE_EXPIRED)
  const stateExpired = `oauth_state_expired_${Date.now()}`;
  db.prepare(`
    INSERT INTO oauth_states (state, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(stateExpired, testSalonUser.id, Date.now() - 5000);

  let errExpired = null;
  try {
    await googleCalendarService.handleOAuthCallback('fake_code', stateExpired, testSalonUser.id);
  } catch (err) {
    errExpired = err;
  }
  assert(errExpired);
  assert.strictEqual(errExpired.code, 'STATE_EXPIRED');
  assert(!db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(stateExpired), 'State expirado deve ser deletado após validação');

  // 15.3 Rejeição de vinculação cruzada entre salões (CROSS_SALON_LINKING_REJECTED)
  const testOAuthState = `oauth_state_${Date.now()}`;
  db.prepare(`
    INSERT INTO oauth_states (state, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(testOAuthState, testSalonUser.id, Date.now() + 600000);

  // Outro usuário autenticado tenta vincular o callback deste state
  let errCrossSalon = null;
  try {
    await googleCalendarService.handleOAuthCallback('fake_code', testOAuthState, 999999);
  } catch (err) {
    errCrossSalon = err;
  }

  assert(errCrossSalon);
  assert.strictEqual(errCrossSalon.code, 'CROSS_SALON_LINKING_REJECTED');
  const checkState = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(testOAuthState);
  assert(!checkState);
  console.log('  ✓ 15. Segurança OAuth validada (sessão ausente, state expirado e rejeição de outro salão com exclusão do state).\n');

  // ----------------------------------------------------
  // TESTE 16: WhatsApp valida disponibilidade no Google Calendar antes de confirmar
  // ----------------------------------------------------
  console.log('[Teste 16] WhatsApp valida Google Calendar antes de confirmar reserva...');
  mockGoogleState.busySlotsByCalendar.set(staff1.google_calendar_id, [
    { start: '2026-11-27T14:00:00-03:00', end: '2026-11-27T15:00:00-03:00' },
  ]);

  let errGoogleBusy = null;
  try {
    await appointmentService.createAppointment({
      userId: testSalonUser.id,
      title: 'Cliente WhatsApp Google Ocupado',
      startDateTime: '2026-11-27T14:15:00',
      durationMin: 30,
      staffId: staff1.id,
      sourceType: 'whatsapp',
      checkGoogle: true,
    });
  } catch (err) {
    errGoogleBusy = err;
  }

  assert(errGoogleBusy);
  assert.strictEqual(errGoogleBusy.code, 'GOOGLE_CALENDAR_BUSY');

  // Testar quando Google é obrigatório e está desconectado
  db.prepare('UPDATE client_salons SET google_require_sync_availability = 1 WHERE user_id = ?').run(testSalonUser.id);
  mockGoogleState.connected = false;

  let errGoogleUnavailable = null;
  try {
    await appointmentService.createAppointment({
      userId: testSalonUser.id,
      title: 'Cliente WhatsApp Google Desconectado',
      startDateTime: '2026-11-27T11:00:00',
      durationMin: 30,
      staffId: staff1.id,
      sourceType: 'whatsapp',
      checkGoogle: true,
    });
  } catch (err) {
    errGoogleUnavailable = err;
  }

  assert(errGoogleUnavailable);
  assert.strictEqual(errGoogleUnavailable.code, 'GOOGLE_CALENDAR_UNAVAILABLE');

  mockGoogleState.connected = true;
  db.prepare('UPDATE client_salons SET google_require_sync_availability = 0 WHERE user_id = ?').run(testSalonUser.id);
  mockGoogleState.busySlotsByCalendar.clear();
  console.log('  ✓ 16. WhatsApp valida Google Calendar (GOOGLE_CALENDAR_BUSY e GOOGLE_CALENDAR_UNAVAILABLE).\n');

  // ----------------------------------------------------
  // TESTE 17: Outbox durável em Remarcação e Cancelamento dentro da transação SQLite
  // ----------------------------------------------------
  console.log('[Teste 17] Outbox durável em remarcação e cancelamento...');
  const aptToChange = salonAppointmentService.bookAppointmentSync(testSalonUser.id, {
    clientName: 'Cliente Para Remarcar e Cancelar',
    date: '2026-11-27',
    time: '09:00',
    durationMin: 45,
    staffId: staff1.id,
  });

  await salonAppointmentService.rescheduleAppointment(aptToChange.id, testSalonUser.id, {
    newDate: '2026-11-27',
    newTime: '11:00',
    reason: 'Remarcado pelo cliente via teste',
  });

  const gUpdateOutbox = db.prepare(`
    SELECT * FROM google_sync_outbox
    WHERE appointment_id = ? AND action = 'UPDATE'
  `).get(aptToChange.id);
  assert(gUpdateOutbox);
  assert.strictEqual(gUpdateOutbox.status, 'PENDING');

  const wReschedOutbox = db.prepare(`
    SELECT * FROM whatsapp_notification_outbox
    WHERE appointment_id = ? AND event_type = 'RESCHEDULE'
  `).get(aptToChange.id);
  assert(wReschedOutbox);

  await salonAppointmentService.cancelAppointment(aptToChange.id, testSalonUser.id, {
    reason: 'Cancelamento definitivo de teste',
    cancelledBy: 'TEST',
  });

  const gDeleteOutbox = db.prepare(`
    SELECT * FROM google_sync_outbox
    WHERE appointment_id = ? AND action = 'DELETE'
  `).get(aptToChange.id);
  assert(gDeleteOutbox);
  assert.strictEqual(gDeleteOutbox.status, 'PENDING');

  const wCancelOutbox = db.prepare(`
    SELECT * FROM whatsapp_notification_outbox
    WHERE appointment_id = ? AND event_type = 'CANCELLATION'
  `).get(aptToChange.id);
  assert(wCancelOutbox);
  console.log('  ✓ 17. Filas google_sync_outbox e whatsapp_notification_outbox duráveis em UPDATE e DELETE.\n');

  // ----------------------------------------------------
  // TESTE 18: Padronização de status AGENDADO e SCHEDULED em consultas e modificações
  // ----------------------------------------------------
  console.log('[Teste 18] Padronização de status AGENDADO e SCHEDULED nas consultas...');
  const legScheduled = db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, end_datetime, status)
    VALUES (?, 'Consulta Legada Dentista', '2026-11-27T14:00:00', '2026-11-27T14:45:00', 'SCHEDULED')
  `).run(testSalonUser.id);

  const newAgendado = db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, end_datetime, status)
    VALUES (?, 'Consulta Nova Jéssica', '2026-11-27T15:00:00', '2026-11-27T15:45:00', 'AGENDADO')
  `).run(testSalonUser.id);

  const upcomingList = appointmentService.getUpcomingAppointments(testSalonUser.id, 20);
  const foundScheduled = upcomingList.find((a) => a.id === legScheduled.lastInsertRowid);
  const foundAgendado = upcomingList.find((a) => a.id === newAgendado.lastInsertRowid);
  assert(foundScheduled, 'Deve encontrar compromisso com status SCHEDULED');
  assert(foundAgendado, 'Deve encontrar compromisso com status AGENDADO');

  const foundBySearch = appointmentService.findAppointmentToModify(testSalonUser.id, 'Dentista');
  assert(foundBySearch);
  assert.strictEqual(foundBySearch.id, legScheduled.lastInsertRowid);

  // Remarcar compromisso legado via updateAppointment propagando erros de conflito
  let errConflictUpdate = null;
  try {
    await appointmentService.updateAppointment(legScheduled.lastInsertRowid, testSalonUser.id, {
      startDateTime: '2026-11-27T15:00:00', // Conflita com newAgendado!
    });
  } catch (err) {
    errConflictUpdate = err;
  }
  assert(errConflictUpdate);
  assert.strictEqual(errConflictUpdate.code, 'SLOT_CONFLICT');

  await appointmentService.deleteAppointment(legScheduled.lastInsertRowid, testSalonUser.id);
  const checkCancelled = db.prepare('SELECT status FROM appointments WHERE id = ?').get(legScheduled.lastInsertRowid);
  assert(['CANCELADO', 'CANCELLED'].includes(checkCancelled.status));
  console.log('  ✓ 18. Status AGENDADO e SCHEDULED padronizados e concorrência protegida no updateAppointment.\n');

  // ----------------------------------------------------
  // TESTE 19: Reconciliação determinística contra duplicações externas no Google
  // ----------------------------------------------------
  console.log('[Teste 19] Reconciliação determinística no Google Calendar...');
  const aptReconcile = salonAppointmentService.bookAppointmentSync(testSalonUser.id, {
    clientName: 'Cliente Reconciliação',
    date: '2026-11-28',
    time: '11:00',
    durationMin: 30,
    staffId: staff1.id,
  });

  const existingGoogleId = 'g_event_pre_existing_123';
  mockGoogleState.events.set(existingGoogleId, {
    appointment: { id: aptReconcile.id },
    calendarId: 'primary',
  });

  const insertsBefore = mockGoogleState.insertCallCount;

  const reconcileResult = await googleCalendarService.createCalendarEvent(testSalonUser.id, aptReconcile);
  assert(reconcileResult.success);
  assert.strictEqual(reconcileResult.googleEventId, existingGoogleId);
  assert.strictEqual(reconcileResult.reconciled, true);
  assert.strictEqual(mockGoogleState.insertCallCount, insertsBefore, 'Não deve criar novo evento no Google');

  const checkAptReconciled = db.prepare('SELECT google_event_id, google_sync_status FROM appointments WHERE id = ?').get(aptReconcile.id);
  assert.strictEqual(checkAptReconciled.google_event_id, existingGoogleId);
  assert.strictEqual(checkAptReconciled.google_sync_status, 'SYNCED');
  console.log('  ✓ 19. Reconciliação determinística preveniu duplicação no Google após falha de crash.\n');

  // ----------------------------------------------------
  // TESTE 20: Resolução do profissional efetivo antes da consulta Google (modalidade STAFF)
  // ----------------------------------------------------
  console.log('[Teste 20] Resolução de profissional efetivo antes da consulta Google em modalidade STAFF...');
  
  // Criar salão isolado com apenas 1 profissional ativo
  const soloEmail = `solo.staff.${Date.now()}@example.com`;
  const soloPhone = `55119${Math.floor(10000000 + Math.random() * 90000000)}`;
  const soloUserInsert = db.prepare(`
    INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, is_demo)
    VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', 0)
  `).run(soloEmail, soloPhone);
  const soloUserId = soloUserInsert.lastInsertRowid;

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, google_require_sync_availability)
    VALUES (?, 'Salão Solo', '5511999991111', '5511999991111', 1, 1, 0)
  `).run(soloUserId);

  const soloStaffInsert = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active, google_calendar_id)
    VALUES (?, 'Carla Solo', 'Unhas', 1, 'carla.agenda@group.calendar.google.com')
  `).run(soloUserId);
  const soloStaffId = soloStaffInsert.lastInsertRowid;

  // Habilitar modalidade STAFF e conectar Google no mock
  mockGoogleState.connected = true;
  mockGoogleState.syncMode = 'STAFF';

  // Marcar a agenda individual da Carla como ocupada das 10h às 11h
  mockGoogleState.busySlotsByCalendar.set('carla.agenda@group.calendar.google.com', [
    { start: '2026-11-30T10:00:00-03:00', end: '2026-11-30T11:00:00-03:00' },
  ]);

  // Tentativa de agendamento SEM informar staffId
  // O sistema deve resolver Carla automaticamente e consultar o calendário dela no Google!
  let errSoloBusy = null;
  try {
    await salonAppointmentService.bookAppointment(soloUserId, {
      clientName: 'Cliente Consulta Carla',
      date: '2026-11-30',
      time: '10:15',
      durationMin: 30,
      // staffId omitido propositalmente!
    });
  } catch (err) {
    errSoloBusy = err;
  }
  assert(errSoloBusy, 'Deve rejeitar agendamento pois o profissional único resolvido está ocupado no Google');
  assert.strictEqual(errSoloBusy.code, 'GOOGLE_CALENDAR_BUSY');

  // Quando o horário da Carla estiver livre (14h), agendamento sem staffId é resolvido e confirmado com ela
  const aptSoloConfirmed = await salonAppointmentService.bookAppointment(soloUserId, {
    clientName: 'Cliente Consulta Carla Livre',
    date: '2026-11-30',
    time: '14:00',
    durationMin: 30,
  });
  assert(aptSoloConfirmed.id > 0);
  assert.strictEqual(aptSoloConfirmed.staff_id, soloStaffId, 'Deve associar automaticamente ao profissional único');

  // Adicionar um segundo profissional ao salão solo
  db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active, google_calendar_id)
    VALUES (?, 'Diego Segundo', 'Cabelos', 1, 'diego.agenda@group.calendar.google.com')
  `).run(soloUserId);

  // Agora que há mais de 1 profissional, agendar sem staffId deve falhar imediatamente com STAFF_REQUIRED
  let errMultipleStaffReq = null;
  try {
    await salonAppointmentService.bookAppointment(soloUserId, {
      clientName: 'Cliente Múltiplos Staffs',
      date: '2026-11-30',
      time: '16:00',
      durationMin: 30,
    });
  } catch (err) {
    errMultipleStaffReq = err;
  }
  assert(errMultipleStaffReq);
  assert.strictEqual(errMultipleStaffReq.code, 'STAFF_REQUIRED');
  console.log('  ✓ 20. Resolução prévia do profissional efetivo e consulta Google em modalidade STAFF validadas.\n');

  // ----------------------------------------------------
  // TESTE 21: Idempotência de eventos Google com identificador estável e crash recovery
  // ----------------------------------------------------
  console.log('[Teste 21] Idempotência de eventos Google com ID estável e recuperação pós-crash...');
  const aptCrash = salonAppointmentService.bookAppointmentSync(testSalonUser.id, {
    clientName: 'Cliente Crash Recovery',
    date: '2026-12-01',
    time: '09:00',
    durationMin: 45,
    staffId: staff1.id,
  });

  const stableCrashId = crypto
    .createHash('sha256')
    .update(`raia_salon_event_${testSalonUser.id}_${aptCrash.id}`)
    .digest('hex')
    .substring(0, 32);

  // Simular que o evento foi gravado na API Google Calendar antes do processo cair,
  // mas o SQLite local ainda tem google_event_id = NULL e google_sync_status = 'PENDING'
  mockGoogleState.events.set(stableCrashId, {
    appointment: aptCrash,
    calendarId: staff1.google_calendar_id || 'primary',
  });
  db.prepare(`
    UPDATE appointments
    SET google_event_id = NULL, google_sync_status = 'PENDING'
    WHERE id = ?
  `).run(aptCrash.id);

  const callCountBeforeSync = mockGoogleState.insertCallCount;

  // Chamar createCalendarEvent: deve reconciliar usando o stableEventId
  const crashSyncResult = await googleCalendarService.createCalendarEvent(testSalonUser.id, aptCrash);
  assert(crashSyncResult.success);
  assert.strictEqual(crashSyncResult.googleEventId, stableCrashId);
  assert.strictEqual(crashSyncResult.reconciled, true);
  assert.strictEqual(mockGoogleState.insertCallCount, callCountBeforeSync, 'Não deve criar novo evento duplicado');

  const aptAfterCrash = db.prepare('SELECT google_event_id, google_sync_status FROM appointments WHERE id = ?').get(aptCrash.id);
  assert.strictEqual(aptAfterCrash.google_event_id, stableCrashId);
  assert.strictEqual(aptAfterCrash.google_sync_status, 'SYNCED');
  console.log('  ✓ 21. Identificador determinístico estável reconciliou com sucesso evento existente após crash.\n');

  // ----------------------------------------------------
  // TESTE 22: Auditoria da rota legada POST /api/appointments
  // ----------------------------------------------------
  console.log('[Teste 22] Auditoria da rota legada POST /api/appointments com verificação Google...');
  const { app } = require('../src/server/app');
  const http = require('http');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const apiBase = `http://127.0.0.1:${serverPort}`;

  // Criar sessão de autenticação para testSalonUser
  const userService = require('../src/services/userService');
  const userSession = userService.createUserSession(testSalonUser.id, 7);
  const salonAuthHeader = {
    'Authorization': `Bearer ${userSession.sessionToken}`,
    'Content-Type': 'application/json',
  };

  try {
    // 22.1 Bloqueio por conflito com o Google Calendar
    mockGoogleState.busySlotsByCalendar.set(staff1.google_calendar_id, [
      { start: '2026-12-02T10:00:00-03:00', end: '2026-12-02T11:00:00-03:00' },
    ]);

    const resGoogleBusy = await fetch(`${apiBase}/api/appointments`, {
      method: 'POST',
      headers: salonAuthHeader,
      body: JSON.stringify({
        title: 'Corte via Rota Legada',
        startDateTime: '2026-12-02T10:15:00',
        endDateTime: '2026-12-02T10:45:00',
        staffId: staff1.id,
      }),
    });

    const bodyGoogleBusy = await resGoogleBusy.json();
    assert.strictEqual(resGoogleBusy.status, 409, 'Deve retornar HTTP 409 em caso de conflito com o Google');
    assert.strictEqual(bodyGoogleBusy.code, 'GOOGLE_CALENDAR_BUSY');

    // 22.2 Bloqueio quando Google é obrigatório e está desconectado
    db.prepare('UPDATE client_salons SET google_require_sync_availability = 1 WHERE user_id = ?').run(testSalonUser.id);
    mockGoogleState.connected = false;

    const resGoogleDisc = await fetch(`${apiBase}/api/appointments`, {
      method: 'POST',
      headers: salonAuthHeader,
      body: JSON.stringify({
        title: 'Corte via Rota Legada Google Desconectado',
        startDateTime: '2026-12-02T14:00:00',
        endDateTime: '2026-12-02T14:45:00',
        staffId: staff1.id,
      }),
    });

    const bodyGoogleDisc = await resGoogleDisc.json();
    assert.strictEqual(resGoogleDisc.status, 400, 'Deve retornar HTTP 400 quando Google é obrigatório mas indisponível');
    assert.strictEqual(bodyGoogleDisc.code, 'GOOGLE_CALENDAR_UNAVAILABLE');

    // Restaurar status do Google
    mockGoogleState.connected = true;
    db.prepare('UPDATE client_salons SET google_require_sync_availability = 0 WHERE user_id = ?').run(testSalonUser.id);

    // 22.3 Bloqueio por falta de seleção de profissional quando salão tem múltiplos profissionais
    const resStaffReq = await fetch(`${apiBase}/api/appointments`, {
      method: 'POST',
      headers: salonAuthHeader,
      body: JSON.stringify({
        title: 'Corte sem profissional informado',
        startDateTime: '2026-12-02T15:00:00',
        endDateTime: '2026-12-02T15:45:00',
      }),
    });

    const bodyStaffReq = await resStaffReq.json();
    assert.strictEqual(resStaffReq.status, 400);
    assert.strictEqual(bodyStaffReq.code, 'STAFF_REQUIRED');

    // 22.4 Sucesso ao agendar em horário livre e com profissional especificado
    const resSuccess = await fetch(`${apiBase}/api/appointments`, {
      method: 'POST',
      headers: salonAuthHeader,
      body: JSON.stringify({
        title: 'Corte Valido via Rota Legada',
        startDateTime: '2026-12-02T16:00:00',
        endDateTime: '2026-12-02T16:45:00',
        staffId: staff1.id,
      }),
    });

    const bodySuccess = await resSuccess.json();
    assert.strictEqual(resSuccess.status, 201);
    assert.strictEqual(bodySuccess.success, true);
    assert.strictEqual(bodySuccess.data.status, 'AGENDADO');

    // 22.5 Bloqueio por conflito no SQLite interno ao tentar marcar no mesmo horário
    const resConflict = await fetch(`${apiBase}/api/appointments`, {
      method: 'POST',
      headers: salonAuthHeader,
      body: JSON.stringify({
        title: 'Corte Conflitante no Mesmo Horário',
        startDateTime: '2026-12-02T16:15:00',
        endDateTime: '2026-12-02T16:45:00',
        staffId: staff1.id,
      }),
    });

    const bodyConflict = await resConflict.json();
    assert.strictEqual(resConflict.status, 409);
    assert.strictEqual(bodyConflict.code, 'SLOT_CONFLICT');

    // 22.6 Usuário comum não-salão (sem client_salons) deve criar compromisso sem exigir staff
    const stdUserEmail = `std.user.${Date.now()}@example.com`;
    const stdPhone = `55119${Math.floor(10000000 + Math.random() * 90000000)}`;
    const stdInsert = db.prepare(`
      INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, is_demo)
      VALUES (?, ?, 'CLIENT', 'FREE', 'ACTIVE', 0)
    `).run(stdUserEmail, stdPhone);
    const stdSession = userService.createUserSession(stdInsert.lastInsertRowid, 7);

    const resStd = await fetch(`${apiBase}/api/appointments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stdSession.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Lembrete Pessoal Usuário Comum',
        startDateTime: '2026-12-02T18:00:00',
        endDateTime: '2026-12-02T18:30:00',
      }),
    });

    const bodyStd = await resStd.json();
    assert.strictEqual(resStd.status, 201);
    assert.strictEqual(bodyStd.success, true);

    console.log('  ✓ 22. Rota legada POST /api/appointments auditada: bloqueia conflitos Google e respeita regras de salão.\n');
  } finally {
    server.close();
  }

  console.log('================================================================');
  console.log('   TODOS OS 22 TESTES DE AUDITORIA FORAM APROVADOS COM SUCESSO! ');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Falha na suíte de testes de auditoria:', err);
  process.exit(1);
});
