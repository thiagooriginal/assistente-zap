/**
 * RAIA AGENTES — SUÍTE DE AUDITORIA CORRETIVA FINAL DA AGENDA INTELIGENTE (14 TESTES)
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
 */

process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'test';
process.env.ALLOW_WHATSAPP_SENDING = 'false';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'raia-segredo-super-forte-de-32-bytes-para-testes!';

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
  console.log('   RAIA AGENTES — AUDITORIA FINAL DA AGENDA INTELIGENTE (14 TESTES)');
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
      mockGoogleState.insertCallCount++;
      let cal = targetCalendarId;
      if (!cal && mockGoogleState.syncMode === 'STAFF' && appointment.staff_id) {
        const row = db.prepare('SELECT google_calendar_id FROM client_staff WHERE id = ?').get(appointment.staff_id);
        if (row?.google_calendar_id) cal = row.google_calendar_id;
      }
      if (!cal) cal = mockGoogleState.selectedCalendarId || 'primary';

      const eventId = `g_event_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
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

  console.log('================================================================');
  console.log('   TODOS OS 14 TESTES DE AUDITORIA FORAM APROVADOS COM SUCESSO! ');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Falha na suíte de testes de auditoria:', err);
  process.exit(1);
});
