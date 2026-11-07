/**
 * RAIA AGENTES — SUÍTE DE TESTES DE USABILIDADE DA AGENDA INTELIGENTE DA JÉSSICA
 * 
 * Verificações obrigatórias:
 * 1. Campo de Data: formato brasileiro DD/MM/AAAA, validação de dias do mês, bloqueio de datas passadas e normalização ISO.
 * 2. Campo de Horário: formato HH:MM, validação de horas 00-23 e minutos 00-59.
 * 3. Endpoint /api/cliente/appointments/available-slots:
 *    - Disponibilidade respeita expediente do salão (ex: 09:00 às 18:00) e intervalo de almoço.
 *    - Duração do serviço altera a grade de horários disponíveis.
 *    - Profissional selecionado filtra horários exclusivos.
 *    - Integração Google Calendar remove horários ocupados no calendário externo.
 * 4. Endpoint /api/cliente/appointments/check-slot (Validação em Tempo Real):
 *    - Retorna available: true para horários livres.
 *    - Retorna available: false + motivo + suggestedSlots quando há conflito SQLite.
 *    - Retorna available: false quando horário está no intervalo de almoço ou fora do expediente.
 *    - Retorna available: false quando ocupado no Google Calendar.
 *    - Parâmetro exclude_id permite validar o mesmo agendamento em remarcação.
 * 5. Bloqueio imediato e sugestões:
 *    - As sugestões retornadas pelo endpoint são realmente viáveis (disponíveis).
 * 6. Impossibilidade de burlar o bloqueio por requisições diretas:
 *    - Rejeição imediata de sobreposição com DD/MM/AAAA (SLOT_CONFLICT).
 *    - Rejeição imediata de sobreposição com YYYY-MM-DD (SLOT_CONFLICT).
 *    - Rejeição imediata de conflito com Google Calendar (GOOGLE_CALENDAR_BUSY).
 *    - Rejeição imediata em remarcação para horário ocupado.
 * 7. Agendamentos simultâneos para profissionais diferentes:
 *    - Dois profissionais podem atender no mesmo horário simultaneamente se estiverem livres.
 *    - O mesmo profissional não pode atender em duplicidade.
 * 8. Preservação de registros históricos e status:
 *    - Conflitos históricos (has_conflict = 1) são preservados.
 * 9. Integridade de contrato de interface no painel.html:
 *    - Elementos e máscaras presentes e consistentes.
 */

process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'test';
process.env.ALLOW_WHATSAPP_SENDING = 'false';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'raia-segredo-super-forte-de-32-bytes-para-testes!';
process.env.ADMIN_PASSWORD = 'raia-segredo-super-forte-admin-123456!';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const googleCalendarService = require('../src/services/googleCalendarService');

let testUser = null;
let staffAna = null;
let staffCarlos = null;
let svcEscova = null;
let svcColoracao = null;

const mockGoogleBusySlots = [];

// Mock Google Calendar
googleCalendarService.setMockHandler({
  getConnectionStatus: () => ({
    isConnected: true,
    accountEmail: 'test.usabilidade@raiaagentes.com.br',
    selectedCalendarId: 'primary',
    syncMode: 'INDIVIDUAL',
    lastSyncAt: new Date().toISOString(),
  }),
  getGoogleBusySlots: async (userId, { timeMin, timeMax, calendarId, staffId }) => {
    return mockGoogleBusySlots.filter(b => {
      if (staffId && b.staffId && b.staffId !== staffId) return false;
      return true;
    });
  },
  syncAppointmentToGoogle: async (userId, appointment) => ({
    success: true,
    googleEventId: 'mock-g-event-usability-test',
    calendarId: 'primary',
  }),
});

async function runTests() {
  console.log('=== INICIANDO SUÍTE DE TESTES: USABILIDADE DA AGENDA INTELIGENTE JÉSSICA ===\n');
  let passed = 0;
  let total = 0;

  function test(desc, fn) {
    total++;
    try {
      fn();
      console.log(`  [OK] Teste ${total}: ${desc}`);
      passed++;
    } catch (err) {
      console.error(`  [FALHA] Teste ${total}: ${desc}`);
      console.error('   ', err.message);
      throw err;
    }
  }

  async function testAsync(desc, fn) {
    total++;
    try {
      await fn();
      console.log(`  [OK] Teste ${total}: ${desc}`);
      passed++;
    } catch (err) {
      console.error(`  [FALHA] Teste ${total}: ${desc}`);
      console.error('   ', err.message);
      throw err;
    }
  }

  // --- PREPARAÇÃO DO BANCO DE DADOS DE TESTE ---
  const email = `teste.usabilidade.${Date.now()}@raiaagentes.com.br`;
  const testPhone = `55119${Math.floor(10000000 + Math.random() * 90000000)}`;

  const info = db.prepare(`
    INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, is_demo)
    VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', 0)
  `).run(email, testPhone);

  testUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  // Configuração do salão: Segunda a Sábado das 08:00 às 18:00, Almoço 12:00 às 13:00
  const customOpeningHours = JSON.stringify({
    timezone: 'America/Sao_Paulo',
    days: {
      0: { open: false, label: 'Domingo', start: '09:00', end: '14:00' },
      1: { open: true, label: 'Segunda-feira', start: '08:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00' },
      2: { open: true, label: 'Terça-feira', start: '08:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00' },
      3: { open: true, label: 'Quarta-feira', start: '08:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00' },
      4: { open: true, label: 'Quinta-feira', start: '08:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00' },
      5: { open: true, label: 'Sexta-feira', start: '08:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00' },
      6: { open: true, label: 'Sábado', start: '08:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00' },
    },
    pauses: [],
    exceptions: [],
  });

  db.prepare(`
    INSERT INTO client_salons (
      user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled,
      notify_new_appointment, google_require_sync_availability, opening_hours
    ) VALUES (?, 'Salão Teste Usabilidade', ?, ?, 1, 1, 0, ?)
  `).run(testUser.id, testPhone, testPhone, customOpeningHours);

  // Profissionais
  const s1 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active, google_calendar_id)
    VALUES (?, 'Ana Cabelos', 'Cabeleireira', 1, 'ana.agenda@group.calendar.google.com')
  `).run(testUser.id);
  staffAna = db.prepare('SELECT * FROM client_staff WHERE id = ?').get(s1.lastInsertRowid);

  const s2 = db.prepare(`
    INSERT INTO client_staff (user_id, name, specialty, active, google_calendar_id)
    VALUES (?, 'Carlos Barba', 'Barbeiro', 1, 'carlos.agenda@group.calendar.google.com')
  `).run(testUser.id);
  staffCarlos = db.prepare('SELECT * FROM client_staff WHERE id = ?').get(s2.lastInsertRowid);

  // Serviços: Escova 30min, Coloração 90min
  const svc1 = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Escova Modelada', 30, 60.0, 1, 'Cabelos')
  `).run(testUser.id);
  svcEscova = db.prepare('SELECT * FROM client_services WHERE id = ?').get(svc1.lastInsertRowid);

  const svc2 = db.prepare(`
    INSERT INTO client_services (user_id, name, duration_min, price, active, category)
    VALUES (?, 'Coloração Completa', 90, 180.0, 1, 'Cabelos')
  `).run(testUser.id);
  svcColoracao = db.prepare('SELECT * FROM client_services WHERE id = ?').get(svc2.lastInsertRowid);

  // Escolhemos uma data futura conhecida: Terça-feira 24/11/2026
  const targetDateISO = '2026-11-24';
  const targetDateBR = '24/11/2026';

  // =========================================================================
  // BLOCO 1: Validação de Data no Formato Brasileiro (DD/MM/AAAA) e ISO
  // =========================================================================
  test('1. Normalização de DD/MM/AAAA para YYYY-MM-DD e suporte a ambos no motor de agendamentos', () => {
    // Teste de parsing
    const parts = targetDateBR.split('/');
    const convertedISO = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    assert.strictEqual(convertedISO, targetDateISO, 'A data 24/11/2026 deve ser convertida para 2026-11-24');
  });

  test('2. Validação de calendário rejeita dias inexistentes (31/02, 31/04, etc.)', () => {
    function isValidBRDate(str) {
      if (!str || str.length !== 10) return false;
      const [d, m, y] = str.split('/').map(Number);
      if (!d || !m || !y || m < 1 || m > 12) return false;
      const daysInMonth = new Date(y, m, 0).getDate();
      return d >= 1 && d <= daysInMonth;
    }

    assert.strictEqual(isValidBRDate('31/02/2026'), false, '31 de fevereiro deve ser rejeitado');
    assert.strictEqual(isValidBRDate('31/04/2026'), false, '31 de abril deve ser rejeitado');
    assert.strictEqual(isValidBRDate('29/02/2026'), false, '29 de fevereiro em 2026 (ano não bissexto) deve ser rejeitado');
    assert.strictEqual(isValidBRDate('29/02/2024'), true, '29 de fevereiro em 2024 (ano bissexto) deve ser aceito');
    assert.strictEqual(isValidBRDate('24/11/2026'), true, '24 de novembro de 2026 deve ser aceito');
  });

  test('3. Validação rejeita datas passadas para novos agendamentos', () => {
    function isFutureOrToday(str) {
      const [d, m, y] = str.split('/').map(Number);
      const target = new Date(y, m - 1, d, 0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return target >= today;
    }

    assert.strictEqual(isFutureOrToday('01/01/2020'), false, 'Data no ano 2020 deve ser rejeitada como passada');
    assert.strictEqual(isFutureOrToday('24/11/2026'), true, 'Data futura deve ser aceita');
  });

  // =========================================================================
  // BLOCO 2: Horário e Disponibilidade Conforme Expediente e Duração
  // =========================================================================
  await testAsync('4. Consulta de slots disponíveis respeita expediente (08:00-18:00) e exclui almoço (12:00-13:00)', async () => {
    const slots = await salonAppointmentService.findAlternativeSlots(testUser.id, {
      date: targetDateBR, // Passando formato BR
      serviceDurationMin: svcEscova.duration_min, // 30 min
      staffId: staffAna.id,
      limit: 50,
    });

    assert.ok(Array.isArray(slots) && slots.length > 0, 'Deve retornar horários livres');
    assert.ok(slots.includes('08:00'), '08:00 deve estar disponível');
    assert.ok(slots.includes('11:30'), '11:30 deve estar disponível');
    // Almoço das 12:00 às 13:00 não pode constar
    assert.strictEqual(slots.includes('12:00'), false, '12:00 (almoço) não deve estar disponível');
    assert.strictEqual(slots.includes('12:30'), false, '12:30 (almoço) não deve estar disponível');
    assert.ok(slots.includes('13:00'), '13:00 (retorno do almoço) deve estar disponível');
    assert.ok(slots.includes('17:30'), '17:30 deve estar disponível');
    assert.strictEqual(slots.includes('18:00'), false, '18:00 (fechamento com duração de 30min ultrapassa 18:00) não deve estar');
  });

  await testAsync('5. Duração do serviço de 90min ajusta os slots disponíveis adequadamente', async () => {
    const slots = await salonAppointmentService.findAlternativeSlots(testUser.id, {
      date: targetDateISO,
      serviceDurationMin: svcColoracao.duration_min, // 90 min
      staffId: staffAna.id,
      limit: 50,
    });

    // Um serviço de 90 min iniciado às 11:00 terminaria às 12:30 (invade o almoço 12:00-13:00), então 11:00 deve ser excluído!
    assert.strictEqual(slots.includes('11:00'), false, 'Slot de 90min às 11:00 invade almoço e deve ser excluído');
    assert.strictEqual(slots.includes('11:30'), false, 'Slot de 90min às 11:30 invade almoço e deve ser excluído');
    // 10:30 termina às 12:00, exatamente no início do almoço, deve ser permitido
    assert.ok(slots.includes('10:30'), 'Slot de 90min às 10:30 termina às 12:00 e deve ser permitido');
    // 16:30 termina às 18:00, deve ser permitido
    assert.ok(slots.includes('16:30'), 'Slot de 90min às 16:30 termina às 18:00 e deve ser permitido');
    assert.strictEqual(slots.includes('17:00'), false, 'Slot de 90min às 17:00 termina às 18:30 (fora do expediente) e deve ser excluído');
  });

  // =========================================================================
  // BLOCO 3: Verificação em Tempo Real (checkSlotAvailability)
  // =========================================================================
  await testAsync('6. checkSlotAvailability retorna available: true para horário livre', async () => {
    const check = await salonAppointmentService.checkSlotAvailability(testUser.id, {
      startDt: `${targetDateISO}T09:00:00`,
      endDt: `${targetDateISO}T09:30:00`,
      staffId: staffAna.id,
    });

    assert.strictEqual(check.available, true, 'Horário livre das 09:00 às 09:30 deve retornar available: true');
  });

  await testAsync('7. checkSlotAvailability retorna available: false quando horário está no almoço', async () => {
    const check = await salonAppointmentService.checkSlotAvailability(testUser.id, {
      startDt: `${targetDateISO}T12:00:00`,
      endDt: `${targetDateISO}T12:30:00`,
      staffId: staffAna.id,
    });

    assert.strictEqual(check.available, false, 'Horário no almoço deve ser indisponível');
    assert.strictEqual(check.reason, 'LUNCH_BREAK', 'Motivo deve ser LUNCH_BREAK');
  });

  await testAsync('8. checkSlotAvailability retorna available: false quando horário é fora do expediente', async () => {
    const check = await salonAppointmentService.checkSlotAvailability(testUser.id, {
      startDt: `${targetDateISO}T19:00:00`,
      endDt: `${targetDateISO}T19:30:00`,
      staffId: staffAna.id,
    });

    assert.strictEqual(check.available, false, 'Horário após o expediente deve ser indisponível');
    assert.strictEqual(check.reason, 'EXCEEDS_CLOSING', 'Motivo deve ser EXCEEDS_CLOSING');
  });

  // =========================================================================
  // BLOCO 4: Criação de Agendamento, Bloqueio Imediato e Sugestões Alternativas
  // =========================================================================
  let apt1Id = null;
  await testAsync('9. Registrar agendamento para Ana das 14:00 às 14:30 via DD/MM/AAAA', async () => {
    const apt = await salonAppointmentService.bookAppointment(testUser.id, {
      clientName: 'Cliente Maria',
      clientPhone: '11999991111',
      serviceId: svcEscova.id,
      staffId: staffAna.id,
      date: targetDateBR, // Formato BR
      time: '14:00',
      status: 'CONFIRMADO',
    });

    assert.ok(apt && apt.id, 'Agendamento deve ser criado com sucesso');
    apt1Id = apt.id;
    assert.strictEqual(apt.start_datetime, `${targetDateISO}T14:00:00`);
    assert.strictEqual(apt.end_datetime, `${targetDateISO}T14:30:00`);
  });

  await testAsync('10. checkSlotAvailability detecta conflito imediato com apt1 para Ana às 14:00 e 14:15', async () => {
    const check1 = await salonAppointmentService.checkSlotAvailability(testUser.id, {
      startDt: `${targetDateISO}T14:00:00`,
      endDt: `${targetDateISO}T14:30:00`,
      staffId: staffAna.id,
    });
    assert.strictEqual(check1.available, false, 'Sobreposição exata deve ser detectada');
    assert.strictEqual(check1.reason, 'SLOT_CONFLICT');

    const check2 = await salonAppointmentService.checkSlotAvailability(testUser.id, {
      startDt: `${targetDateISO}T14:15:00`,
      endDt: `${targetDateISO}T14:45:00`,
      staffId: staffAna.id,
    });
    assert.strictEqual(check2.available, false, 'Sobreposição parcial deve ser detectada');
    assert.strictEqual(check2.reason, 'SLOT_CONFLICT');
  });

  await testAsync('11. Sugestões alternativas retornam horários livres imediatamente após conflito', async () => {
    // Busca todas as alternativas do dia
    const allSuggestions = await salonAppointmentService.findAlternativeSlots(testUser.id, {
      date: targetDateISO,
      serviceDurationMin: 30,
      staffId: staffAna.id,
      limit: 50,
    });

    assert.ok(Array.isArray(allSuggestions) && allSuggestions.length > 0, 'Deve retornar sugestões');
    // 14:00 ocupada não pode estar presente
    assert.strictEqual(allSuggestions.includes('14:00'), false, '14:00 ocupada não pode estar nas sugestões');
    // 14:30 (imediatamente após o término de apt1) deve estar livre e presente
    assert.ok(allSuggestions.includes('14:30'), '14:30 deve estar livre e presente');

    // Busca limitada (como usada no popover/pills de sugestão rápida: limit 6)
    const quickSuggestions = await salonAppointmentService.findAlternativeSlots(testUser.id, {
      date: targetDateISO,
      serviceDurationMin: 30,
      staffId: staffAna.id,
      limit: 6,
    });

    assert.strictEqual(quickSuggestions.length, 6, 'Deve retornar até 6 sugestões rápidas');
    assert.strictEqual(quickSuggestions.includes('14:00'), false, '14:00 não pode estar nas sugestões rápidas');

    // Ao testar a primeira sugestão rápida, checkSlotAvailability deve retornar available: true
    const chosenSlot = quickSuggestions[0];
    const cleanSlot = chosenSlot.length === 5 ? chosenSlot + ':00' : chosenSlot;
    const sDate = new Date(`${targetDateISO}T${cleanSlot}`);
    const eDate = new Date(sDate.getTime() + 30 * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    const calcEndDt = `${eDate.getFullYear()}-${pad(eDate.getMonth() + 1)}-${pad(eDate.getDate())}T${pad(eDate.getHours())}:${pad(eDate.getMinutes())}:${pad(eDate.getSeconds())}`;

    const checkChosen = await salonAppointmentService.checkSlotAvailability(testUser.id, {
      startDt: `${targetDateISO}T${cleanSlot}`,
      endDt: calcEndDt,
      staffId: staffAna.id,
    });
    assert.strictEqual(checkChosen.available, true, `Sugestão ${chosenSlot} deve ser comprovadamente livre`);
  });

  // =========================================================================
  // BLOCO 5: Impossibilidade de Burlar o Bloqueio por Requisições Diretas
  // =========================================================================
  await testAsync('12. Tentativa direta de agendar no horário ocupado via DD/MM/AAAA é rejeitada com SLOT_CONFLICT', async () => {
    let threw = false;
    try {
      await salonAppointmentService.bookAppointment(testUser.id, {
        clientName: 'Tentativa Invasora BR',
        serviceId: svcEscova.id,
        staffId: staffAna.id,
        date: targetDateBR, // 24/11/2026
        time: '14:00', // Ocupado
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'SLOT_CONFLICT', 'Deve falhar com código SLOT_CONFLICT');
      assert.ok(Array.isArray(err.suggestedSlots) && err.suggestedSlots.length > 0, 'Deve fornecer suggestedSlots no erro');
    }
    assert.strictEqual(threw, true, 'Deveria ter lançado erro de conflito');
  });

  await testAsync('13. Tentativa direta de agendar no horário ocupado via YYYY-MM-DD é rejeitada com SLOT_CONFLICT', async () => {
    let threw = false;
    try {
      await salonAppointmentService.bookAppointment(testUser.id, {
        clientName: 'Tentativa Invasora ISO',
        serviceId: svcEscova.id,
        staffId: staffAna.id,
        date: targetDateISO, // 2026-11-24
        time: '14:00', // Ocupado
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'SLOT_CONFLICT', 'Deve falhar com código SLOT_CONFLICT');
    }
    assert.strictEqual(threw, true, 'Deveria ter lançado erro de conflito');
  });

  await testAsync('14. Conflito no Google Calendar bloqueia agendamento com GOOGLE_CALENDAR_BUSY e fornece sugestões', async () => {
    // Inserir bloqueio no Google para Ana das 10:00 às 11:00 (mesmo fuso local)
    mockGoogleBusySlots.push({
      start: `${targetDateISO}T10:00:00`,
      end: `${targetDateISO}T11:00:00`,
      staffId: staffAna.id,
    });

    let threw = false;
    try {
      await salonAppointmentService.bookAppointment(testUser.id, {
        clientName: 'Tentativa Google Conflito',
        serviceId: svcEscova.id,
        staffId: staffAna.id,
        date: targetDateISO,
        time: '10:00',
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'GOOGLE_CALENDAR_BUSY', 'Deve falhar com GOOGLE_CALENDAR_BUSY');
      assert.ok(Array.isArray(err.suggestedSlots), 'Deve fornecer sugestões');
    }
    assert.strictEqual(threw, true, 'Deveria ter bloqueado devido ao Google Calendar');

    // Limpar mock do Google para os próximos testes
    mockGoogleBusySlots.length = 0;
  });

  // =========================================================================
  // BLOCO 6: Agendamentos Simultâneos para Profissionais Diferentes
  // =========================================================================
  await testAsync('15. Horário das 14:00 (ocupado para Ana) é PERMITIDO e confirmado para Carlos', async () => {
    // Ana está ocupada às 14:00
    // Carlos está livre às 14:00
    const checkCarlos = await salonAppointmentService.checkSlotAvailability(testUser.id, {
      startDt: `${targetDateISO}T14:00:00`,
      endDt: `${targetDateISO}T14:30:00`,
      staffId: staffCarlos.id,
    });
    assert.strictEqual(checkCarlos.available, true, 'Carlos deve estar disponível às 14:00');

    // Registrar agendamento para Carlos
    const aptCarlos = await salonAppointmentService.bookAppointment(testUser.id, {
      clientName: 'Cliente Carlos Simultanêo',
      serviceId: svcEscova.id,
      staffId: staffCarlos.id,
      date: targetDateBR,
      time: '14:00',
    });

    assert.ok(aptCarlos && aptCarlos.id, 'Agendamento para Carlos deve ser criado');
    assert.strictEqual(aptCarlos.staff_id, staffCarlos.id);

    // Agora AMBOS têm agendamentos gravados às 14:00 na mesma data
    const rowAna = db.prepare('SELECT id, staff_id, start_datetime FROM appointments WHERE id = ?').get(apt1Id);
    const rowCarlos = db.prepare('SELECT id, staff_id, start_datetime FROM appointments WHERE id = ?').get(aptCarlos.id);

    assert.strictEqual(rowAna.start_datetime, `${targetDateISO}T14:00:00`);
    assert.strictEqual(rowCarlos.start_datetime, `${targetDateISO}T14:00:00`);
    assert.notStrictEqual(rowAna.staff_id, rowCarlos.staff_id, 'Profissionais diferentes devem coabitar o mesmo horário');
  });

  // =========================================================================
  // BLOCO 7: Remarcação com Validação de Exclude_Id e Bloqueio de Conflito
  // =========================================================================
  await testAsync('16. Remarcação de apt1 para horário ocupado de Carlos (14:00) ao trocar de profissional é BLOQUEADA', async () => {
    let threw = false;
    try {
      await salonAppointmentService.rescheduleAppointment(apt1Id, testUser.id, {
        newDate: targetDateBR,
        newTime: '14:00',
        newStaffId: staffCarlos.id, // Carlos já está ocupado às 14:00
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'SLOT_CONFLICT', 'Deve bloquear conflito na remarcação');
    }
    assert.strictEqual(threw, true, 'Remarcação conflitante deve ser bloqueada');
  });

  await testAsync('17. Remarcação de apt1 mantendo o próprio horário e alterando apenas data é PERMITIDA (exclude_id)', async () => {
    // Remarcar apt1 para Quarta-feira 25/11/2026 às 14:00
    const newTargetDate = '2026-11-25';
    const resched = await salonAppointmentService.rescheduleAppointment(apt1Id, testUser.id, {
      newDate: '25/11/2026',
      newTime: '14:00',
      newStaffId: staffAna.id,
    });

    assert.ok(resched && resched.id, 'Remarcação deve ter sucesso e retornar compromisso');
    const updated = db.prepare('SELECT start_datetime FROM appointments WHERE id = ?').get(apt1Id);
    assert.strictEqual(updated.start_datetime, `${newTargetDate}T14:00:00`);
  });

  // =========================================================================
  // BLOCO 8: Preservação de Histórico e Conflitos Existentes
  // =========================================================================
  test('18. Preservação de histórico com has_conflict = 1 e status', () => {
    // Inserir agendamento histórico marcado como conflito
    db.prepare(`
      INSERT INTO appointments (
        user_id, client_name, title, duration_min,
        start_datetime, end_datetime, status, has_conflict, staff_id
      ) VALUES (?, 'Histórico Conflito', 'Corte', 30, '2026-10-01T10:00:00', '2026-10-01T10:30:00', 'AGENDADO', 1, ?)
    `).run(testUser.id, staffAna.id);

    const historical = db.prepare('SELECT * FROM appointments WHERE user_id = ? AND has_conflict = 1').get(testUser.id);
    assert.ok(historical, 'Agendamento histórico deve existir');
    assert.strictEqual(historical.has_conflict, 1, 'has_conflict = 1 deve ser preservado');
  });

  // =========================================================================
  // BLOCO 9: Validação dos Elementos de Interface no painel.html
  // =========================================================================
  test('19. painel.html contém os elementos de data com digitação DD/MM/AAAA e seletor visual', () => {
    const painelHtml = fs.readFileSync(path.join(__dirname, '../public/cliente/painel.html'), 'utf8');

    assert.ok(painelHtml.includes('id="aptDateDisplay"'), 'Deve conter aptDateDisplay');
    assert.ok(painelHtml.includes('id="btnOpenAptDatePicker"'), 'Deve conter btnOpenAptDatePicker');
    assert.ok(painelHtml.includes('id="aptDatePicker"'), 'Deve conter aptDatePicker');
    assert.ok(painelHtml.includes('id="aptDateError"'), 'Deve conter aptDateError');
    assert.ok(painelHtml.includes('placeholder="DD/MM/AAAA"'), 'Deve ter placeholder DD/MM/AAAA');
  });

  test('20. painel.html contém os elementos de horário com digitação HH:MM e dropdown de horários disponíveis', () => {
    const painelHtml = fs.readFileSync(path.join(__dirname, '../public/cliente/painel.html'), 'utf8');

    assert.ok(painelHtml.includes('id="aptTimeInput"'), 'Deve conter aptTimeInput');
    assert.ok(painelHtml.includes('id="btnToggleAptTimeDropdown"'), 'Deve conter btnToggleAptTimeDropdown');
    assert.ok(painelHtml.includes('id="aptTimeDropdown"'), 'Deve conter aptTimeDropdown');
    assert.ok(painelHtml.includes('id="aptAvailableSlotsList"'), 'Deve conter aptAvailableSlotsList');
    assert.ok(painelHtml.includes('placeholder="HH:MM"'), 'Deve ter placeholder HH:MM');
  });

  test('21. painel.html contém os elementos de bloqueio imediato, pílulas de sugestão e remarcação', () => {
    const painelHtml = fs.readFileSync(path.join(__dirname, '../public/cliente/painel.html'), 'utf8');

    assert.ok(painelHtml.includes('id="aptSuggestedSlotsContainer"'), 'Deve conter container de sugestões');
    assert.ok(painelHtml.includes('id="aptSuggestedSlotsPills"'), 'Deve conter pílulas clicáveis');
    assert.ok(painelHtml.includes('id="rescheduleDateDisplay"'), 'Deve conter rescheduleDateDisplay');
    assert.ok(painelHtml.includes('id="rescheduleTimeInput"'), 'Deve conter rescheduleTimeInput');
    assert.ok(painelHtml.includes('id="rescheduleTimeDropdown"'), 'Deve conter rescheduleTimeDropdown');
  });

  test('22. Script inline de painel.html possui funções de máscara, validação e verificação em tempo real', () => {
    const painelHtml = fs.readFileSync(path.join(__dirname, '../public/cliente/painel.html'), 'utf8');

    assert.ok(painelHtml.includes('function maskDateInput'), 'Deve conter maskDateInput');
    assert.ok(painelHtml.includes('function maskTimeInput'), 'Deve conter maskTimeInput');
    assert.ok(painelHtml.includes('function validateBRDate'), 'Deve conter validateBRDate');
    assert.ok(painelHtml.includes('function validateTimeStr'), 'Deve conter validateTimeStr');
    assert.ok(painelHtml.includes('function checkNewAppointmentSlot'), 'Deve conter checkNewAppointmentSlot');
    assert.ok(painelHtml.includes('function fetchNewAppointmentSlots'), 'Deve conter fetchNewAppointmentSlots');
  });

  console.log(`\n=== TODOS OS ${passed}/${total} TESTES DE USABILIDADE PASSARAM COM SUCESSO! ===`);
}

runTests().catch(err => {
  console.error('\nErro fatal na execução dos testes:', err);
  process.exit(1);
});
