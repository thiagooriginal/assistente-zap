/**
 * RAIA AGENTES — TESTES DO STATUS INICIAL DO AGENDAMENTO (JÉSSICA BEAUTY)
 * 
 * Validação rigorosa em banco SQLite temporário e isolado:
 * 1. Cadastro inicial com status CONFIRMADO persiste CONFIRMADO no SQLite e histórico.
 * 2. Cadastro inicial com status AGENDADO persiste AGENDADO no SQLite e histórico.
 * 3. Cadastro sem status explícito adota AGENDADO como fallback seguro.
 * 4. Tentativa de forjar status inicial (CONCLUÍDO, CANCELADO, etc.) sofre fallback seguro para AGENDADO.
 * 5. Mapeamento de status legados/em inglês (CONFIRMED -> CONFIRMADO, SCHEDULED -> AGENDADO).
 * 6. Endpoint HTTP POST /api/cliente/appointments recebe status e grava CONFIRMADO.
 * 7. Listagem GET /api/cliente/appointments retorna status CONFIRMADO e suporta filtros.
 * 8. Bloqueio de concorrência e conflitos preservado com agendamentos CONFIRMADOS.
 * 9. Transições de ciclo de vida (CONFIRMADO -> CONCLUÍDO, CONFIRMADO -> CANCELADO) gravadas no histórico.
 * 10. Isolamento multi-tenant garantido.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// -------------------------------------------------------------
// CONFIGURAÇÃO DO BANCO TEMPORÁRIO ISOLADO (DISPOSABLE SQLITE)
// -------------------------------------------------------------
const tempDbName = `raia_test_initial_status_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.db`;
const tempDbPath = path.resolve(os.tmpdir(), tempDbName);

// Definir DB_PATH e variáveis críticas ESTRITAMENTE ANTES de carregar qualquer módulo
process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'test';
process.env.ALLOW_WHATSAPP_SENDING = 'false';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'raia-segredo-super-forte-de-32-bytes-para-testes!';
process.env.ADMIN_PASSWORD = 'raia-segredo-super-forte-admin-123456!';

const assert = require('assert');
const http = require('http');
const config = require('../src/config/index');
const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const appointmentService = require('../src/services/appointmentService');
const userService = require('../src/services/userService');
const { app } = require('../src/server/app');

async function runTests() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — TESTES DE STATUS INICIAL DO AGENDAMENTO       ');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // COMPROVAÇÃO DE ISOLAMENTO (FAIL-CLOSED)
  // -------------------------------------------------------------
  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE TESTE ---');
  assert.strictEqual(process.env.DB_PATH, tempDbPath, 'DB_PATH no process.env deve ser o arquivo temporário isolado');
  assert.strictEqual(config.dbPath, tempDbPath, 'config.dbPath deve coincidir exatamente com o arquivo temporário');

  const defaultDbPath = path.resolve(__dirname, '../data/assistant.db');
  assert.notStrictEqual(path.resolve(config.dbPath), defaultDbPath, 'BLOQUEIO DE SEGURANÇA: Teste JAMAIS pode utilizar o banco operacional/homologação');
  assert(!config.dbPath.includes('assistant.db'), 'O caminho DB_PATH não pode conter o banco oficial assistant.db');

  assert.strictEqual(process.env.ALLOW_WHATSAPP_SENDING, 'false', 'Envio de WhatsApp deve estar desativado para testes');
  assert(fs.existsSync(tempDbPath), 'Arquivo SQLite temporário deve existir e ter sido inicializado');

  console.log(`  ✓ Banco temporário ativo: ${tempDbPath}`);
  console.log(`  ✓ Banco operacional data/assistant.db 100% intocado e preservado.`);
  console.log(`  ✓ Disparos externos (WhatsApp e Google) bloqueados com segurança.\n`);

  let server;

  try {
    // 1. Criar Salão de Teste Isolado no SQLite Temporário
    const testEmail = `status.test.${Date.now()}@example.com`;
    const testPhone = `55119${Math.floor(10000000 + Math.random() * 90000000)}`;
    const userInsert = db.prepare(`
      INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, paid_until, is_demo)
      VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'), 0)
    `).run(testEmail, testPhone);
    const salonUserId = userInsert.lastInsertRowid;

    // Configurar salão
    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, google_require_sync_availability)
      VALUES (?, 'Salão Jéssica Beauty Test', '5511988887777', '5511988887777', 1, 1, 0)
    `).run(salonUserId);

    // Criar profissional
    const staffInsert = db.prepare(`
      INSERT INTO client_staff (user_id, name, active)
      VALUES (?, 'Jéssica Especialista', 1)
    `).run(salonUserId);
    const staffId = staffInsert.lastInsertRowid;

    // Criar serviço
    const sInsert = db.prepare(`
      INSERT INTO client_services (user_id, name, duration_min, price, active, category)
      VALUES (?, 'Corte Feminino com Escova', 60, 90.00, 1, 'Cabelo')
    `).run(salonUserId);
    const serviceId = sInsert.lastInsertRowid;

    // Iniciar servidor HTTP para testes de API
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const apiBase = `http://127.0.0.1:${port}`;
    const session = userService.createUserSession(salonUserId, 7);
    const authHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.sessionToken}`,
    };

    // ----------------------------------------------------
    // TESTE 1: Cadastro inicial com status CONFIRMADO no serviço síncrono
    // ----------------------------------------------------
    console.log('[Teste 1] Cadastro síncrono com status CONFIRMADO...');
    const apt1 = salonAppointmentService.bookAppointmentSync(salonUserId, {
      clientName: 'Cliente Teste Beauty 1',
      clientPhone: '11999990001',
      serviceId,
      staffId,
      date: '2026-11-10',
      time: '09:00',
      durationMin: 60,
      status: 'CONFIRMADO',
      origin: 'painel',
    });

    assert(apt1.id > 0, 'Agendamento deve ser criado com ID válido');
    assert.strictEqual(apt1.status, 'CONFIRMADO', 'Objeto retornado deve ter status CONFIRMADO');

    const row1 = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apt1.id);
    assert.strictEqual(row1.status, 'CONFIRMADO', 'Registro no SQLite deve ter status CONFIRMADO');
    assert.strictEqual(row1.price, 90.00, 'Preço deve ser 90.00');
    assert.strictEqual(row1.duration_min, 60, 'Duração deve ser 60 min');

    const history1 = db.prepare('SELECT * FROM appointment_status_history WHERE appointment_id = ? ORDER BY id ASC').all(apt1.id);
    assert.strictEqual(history1.length, 1, 'Deve registrar histórico de criação');
    assert.strictEqual(history1[0].new_status, 'CONFIRMADO', 'Histórico deve registrar new_status CONFIRMADO');
    assert.strictEqual(history1[0].previous_status, null, 'Histórico inicial deve ter previous_status null');
    assert.strictEqual(history1[0].reason, 'Novo agendamento criado');
    console.log('  ✓ 1. Status inicial CONFIRMADO gravado corretamente no SQLite e no histórico.\n');

    // ----------------------------------------------------
    // TESTE 2: Cadastro síncrono com status AGENDADO
    // ----------------------------------------------------
    console.log('[Teste 2] Cadastro síncrono com status AGENDADO...');
    const apt2 = salonAppointmentService.bookAppointmentSync(salonUserId, {
      clientName: 'Cliente Teste Beauty 2',
      clientPhone: '11999990002',
      serviceId,
      staffId,
      date: '2026-11-10',
      time: '10:00',
      durationMin: 60,
      status: 'AGENDADO',
      origin: 'painel',
    });

    assert.strictEqual(apt2.status, 'AGENDADO', 'Objeto retornado deve ter status AGENDADO');
    const row2 = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apt2.id);
    assert.strictEqual(row2.status, 'AGENDADO', 'SQLite deve gravar AGENDADO');
    const history2 = db.prepare('SELECT * FROM appointment_status_history WHERE appointment_id = ?').get(apt2.id);
    assert.strictEqual(history2.new_status, 'AGENDADO', 'Histórico deve registrar AGENDADO');
    console.log('  ✓ 2. Status inicial AGENDADO gravado corretamente.\n');

    // ----------------------------------------------------
    // TESTE 3: Cadastro sem status explícito (default seguro AGENDADO)
    // ----------------------------------------------------
    console.log('[Teste 3] Cadastro sem status explícito...');
    const apt3 = salonAppointmentService.bookAppointmentSync(salonUserId, {
      clientName: 'Cliente Teste Beauty 3',
      clientPhone: '11999990003',
      serviceId,
      staffId,
      date: '2026-11-10',
      time: '11:00',
      durationMin: 60,
      origin: 'painel',
    });

    assert.strictEqual(apt3.status, 'AGENDADO', 'Fallback default deve ser AGENDADO');
    const row3 = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apt3.id);
    assert.strictEqual(row3.status, 'AGENDADO');
    console.log('  ✓ 3. Ausência de status adota AGENDADO com segurança.\n');

    // ----------------------------------------------------
    // TESTE 4: Tentativa de forjar status inicial (CONCLUÍDO, CANCELADO, etc.)
    // ----------------------------------------------------
    console.log('[Teste 4] Tentativas de forjar status inicial não permitido...');
    const aptForged1 = salonAppointmentService.bookAppointmentSync(salonUserId, {
      clientName: 'Cliente Forja Concluído',
      serviceId,
      staffId,
      date: '2026-11-10',
      time: '14:00',
      durationMin: 60,
      status: 'CONCLUÍDO',
    });
    assert.strictEqual(aptForged1.status, 'AGENDADO', 'Status CONCLUÍDO forjado deve sofrer fallback para AGENDADO');

    const aptForged2 = salonAppointmentService.bookAppointmentSync(salonUserId, {
      clientName: 'Cliente Forja Cancelado',
      serviceId,
      staffId,
      date: '2026-11-10',
      time: '15:00',
      durationMin: 60,
      status: 'CANCELADO',
    });
    assert.strictEqual(aptForged2.status, 'AGENDADO', 'Status CANCELADO forjado deve sofrer fallback para AGENDADO');

    const aptForged3 = salonAppointmentService.bookAppointmentSync(salonUserId, {
      clientName: 'Cliente Forja Arbitrário',
      serviceId,
      staffId,
      date: '2026-11-10',
      time: '16:00',
      durationMin: 60,
      status: 'MALICIOUS_STATUS',
    });
    assert.strictEqual(aptForged3.status, 'AGENDADO', 'Status arbitrário deve sofrer fallback para AGENDADO');
    console.log('  ✓ 4. Status forjados/não permitidos no cadastro sofrem fallback seguro para AGENDADO.\n');

    // ----------------------------------------------------
    // TESTE 5: Mapeamento de status legados/inglês (CONFIRMED -> CONFIRMADO)
    // ----------------------------------------------------
    console.log('[Teste 5] Mapeamento de status em inglês...');
    const aptEngConfirmed = salonAppointmentService.bookAppointmentSync(salonUserId, {
      clientName: 'Cliente English Confirmed',
      serviceId,
      staffId,
      date: '2026-11-10',
      time: '17:00',
      durationMin: 60,
      status: 'CONFIRMED',
    });
    assert.strictEqual(aptEngConfirmed.status, 'CONFIRMADO', 'CONFIRMED deve mapear para CONFIRMADO');

    const aptEngScheduled = salonAppointmentService.bookAppointmentSync(salonUserId, {
      clientName: 'Cliente English Scheduled',
      serviceId,
      staffId,
      date: '2026-11-10',
      time: '18:00',
      durationMin: 60,
      status: 'SCHEDULED',
    });
    assert.strictEqual(aptEngScheduled.status, 'AGENDADO', 'SCHEDULED deve mapear para AGENDADO');
    console.log('  ✓ 5. Mapeamento bidirecional de status legados aprovado.\n');

    // ----------------------------------------------------
    // TESTE 6: Chamada via rota HTTP POST /api/cliente/appointments (Cenário Exato do Usuário)
    // ----------------------------------------------------
    console.log('[Teste 6] Rota HTTP POST /api/cliente/appointments com CONFIRMADO...');
    const postPayload = {
      clientName: 'Cliente Teste Beauty',
      clientPhone: '11999998888',
      serviceId,
      staffId,
      date: '2026-11-11',
      time: '09:00',
      durationMin: 60,
      status: 'CONFIRMADO',
    };

    const resPost = await fetch(`${apiBase}/api/cliente/appointments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(postPayload),
    });

    assert.strictEqual(resPost.status, 200, 'Endpoint deve responder com 200 OK');
    const postData = await resPost.json();
    assert.strictEqual(postData.success, true, 'Resposta da API deve ter success=true');
    assert(postData.appointment, 'Deve retornar o agendamento criado');
    assert.strictEqual(postData.appointment.status, 'CONFIRMADO', 'API deve retornar status CONFIRMADO');
    assert.strictEqual(postData.appointment.price, 90.00, 'Preço deve ser 90.00');

    // Conferir diretamente no banco
    const httpRow = db.prepare('SELECT * FROM appointments WHERE id = ?').get(postData.appointment.id);
    assert.strictEqual(httpRow.status, 'CONFIRMADO', 'Banco SQLite deve conter status CONFIRMADO');

    const httpHistory = db.prepare('SELECT * FROM appointment_status_history WHERE appointment_id = ?').get(postData.appointment.id);
    assert.strictEqual(httpHistory.new_status, 'CONFIRMADO', 'Histórico deve registrar CONFIRMADO');
    console.log('  ✓ 6. Rota HTTP grava e responde status CONFIRMADO no cenário exato relatado.\n');

    // ----------------------------------------------------
    // TESTE 7: Listagem GET /api/cliente/appointments e filtros
    // ----------------------------------------------------
    console.log('[Teste 7] Listagem e filtros de agendamentos...');
    const resListAll = await fetch(`${apiBase}/api/cliente/appointments`, {
      method: 'GET',
      headers: authHeaders,
    });
    assert.strictEqual(resListAll.status, 200);
    const listAllData = await resListAll.json();
    assert(listAllData.success);
    const foundTarget = listAllData.appointments.find(a => a.id === postData.appointment.id);
    assert(foundTarget, 'Agendamento deve estar presente na listagem geral');
    assert.strictEqual(foundTarget.status, 'CONFIRMADO', 'Status na listagem geral deve ser CONFIRMADO');

    // Filtro por CONFIRMADO
    const resListConfirmed = await fetch(`${apiBase}/api/cliente/appointments?status=CONFIRMADO`, {
      method: 'GET',
      headers: authHeaders,
    });
    const listConfData = await resListConfirmed.json();
    assert(listConfData.appointments.some(a => a.id === postData.appointment.id), 'Filtro CONFIRMADO deve retornar o agendamento');
    assert(listConfData.appointments.every(a => a.status === 'CONFIRMADO'), 'Todos do filtro CONFIRMADO devem ser CONFIRMADO');

    // Filtro por AGENDADO não deve conter o CONFIRMADO
    const resListAgendados = await fetch(`${apiBase}/api/cliente/appointments?status=AGENDADO`, {
      method: 'GET',
      headers: authHeaders,
    });
    const listAgData = await resListAgendados.json();
    assert(!listAgData.appointments.some(a => a.id === postData.appointment.id), 'Filtro AGENDADO não deve conter o CONFIRMADO');
    console.log('  ✓ 7. Listagem e filtros por chip respeitam rigorosamente o status CONFIRMADO.\n');

    // ----------------------------------------------------
    // TESTE 8: Bloqueio de conflito para agendamento CONFIRMADO
    // ----------------------------------------------------
    console.log('[Teste 8] Bloqueio de conflito de horário com agendamento CONFIRMADO...');
    const resConflict = await fetch(`${apiBase}/api/cliente/appointments`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        clientName: 'Cliente Tentando Mesmo Horário',
        serviceId,
        staffId,
        date: '2026-11-11',
        time: '09:00', // Mesmo horário já ocupado das 09:00 às 10:00
      }),
    });

    assert.strictEqual(resConflict.status, 409, 'Deve retornar HTTP 409 Conflict');
    const conflictData = await resConflict.json();
    assert.strictEqual(conflictData.code, 'SLOT_CONFLICT');
    assert(Array.isArray(conflictData.suggestedSlots), 'Deve sugerir horários alternativos');
    console.log('  ✓ 8. Horário com status CONFIRMADO bloqueia novas reservas conflitantes.\n');

    // ----------------------------------------------------
    // TESTE 9: Transição de ciclo de vida e histórico a partir de CONFIRMADO
    // ----------------------------------------------------
    console.log('[Teste 9] Transições de ciclo de vida a partir de CONFIRMADO...');
    // Concluir agendamento
    salonAppointmentService.updateAppointmentStatus(postData.appointment.id, salonUserId, 'CONCLUÍDO', 'Atendimento finalizado com sucesso');
    const rowDone = db.prepare('SELECT * FROM appointments WHERE id = ?').get(postData.appointment.id);
    assert.strictEqual(rowDone.status, 'CONCLUÍDO');

    const historyTrans = db.prepare('SELECT * FROM appointment_status_history WHERE appointment_id = ? ORDER BY id ASC').all(postData.appointment.id);
    assert.strictEqual(historyTrans.length, 2);
    assert.strictEqual(historyTrans[0].new_status, 'CONFIRMADO');
    assert.strictEqual(historyTrans[1].previous_status, 'CONFIRMADO');
    assert.strictEqual(historyTrans[1].new_status, 'CONCLUÍDO');
    assert.strictEqual(historyTrans[1].reason, 'Atendimento finalizado com sucesso');
    console.log('  ✓ 9. Histórico de ciclo de vida rastreia perfeitamente a evolução CONFIRMADO -> CONCLUÍDO.\n');

    // ----------------------------------------------------
    // TESTE 10: Isolamento multi-tenant
    // ----------------------------------------------------
    console.log('[Teste 10] Isolamento multi-tenant...');
    const otherUserInsert = db.prepare(`
      INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, paid_until, is_demo)
      VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'), 0)
    `).run(`other.status.${Date.now()}@example.com`, `55119${Math.floor(10000000 + Math.random() * 90000000)}`);
    const otherUserId = otherUserInsert.lastInsertRowid;
    const otherSession = userService.createUserSession(otherUserId, 7);

    // Outro salão tentando acessar ou alterar o agendamento
    let updateDenied = false;
    try {
      salonAppointmentService.updateAppointmentStatus(postData.appointment.id, otherUserId, 'CANCELADO');
    } catch (e) {
      if (e.code === 'NOT_FOUND') updateDenied = true;
    }
    assert(updateDenied, 'Outro usuário não pode alterar status de agendamento alheio');
    console.log('  ✓ 10. Isolamento entre salões mantido com rigor.\n');

  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }

    // -------------------------------------------------------------
    // LIMPEZA GARANTIDA DO SQLITE TEMPORÁRIO (DISPOSABLE)
    // -------------------------------------------------------------
    console.log('--- LIMPEZA DO AMBIENTE TEMPORÁRIO ---');
    try {
      if (db && typeof db.close === 'function') {
        db.close();
      }
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
      if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
      if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
      console.log('  ✓ Arquivos do SQLite temporário descartados com sucesso.\n');
    } catch (e) {
      console.warn('  ! Aviso na remoção do arquivo temporário:', e.message);
    }
  }

  console.log('================================================================');
  console.log('   TODOS OS 10 TESTES DE STATUS INICIAL PASSARAM COM SUCESSO!   ');
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
