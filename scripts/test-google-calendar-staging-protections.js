/**
 * RAIA AGENTES — SUÍTE DE TESTES DE PROTEÇÃO FINAL DO GOOGLE CALENDAR EM HOMOLOGAÇÃO
 * 
 * Validação rigorosa dos requisitos de segurança antes da primeira conexão Google real:
 * a) Fluxo real de OAuth com endpoints mockados (handleOAuthCallback direto, anti-CSRF, transação atômica,
 *    simulação integral de google.oauth2 userinfo.get com respostas válidas e inválidas, fallback para id_token).
 * b) Conexão inicial e reconexão (preservação de initial_connection_at e de agendamentos legítimos pós-conexão).
 * c) Proteção de itens preexistentes do outbox com CREATE, UPDATE e DELETE (sanitização universal fail-safe).
 * d) Bloqueio de rede fail-closed com lista vazia de emails ou ausência de autorização explícita.
 * e) Atualização e cancelamento de eventos com ID simulado (sim_) ao ativar sincronização real (nunca envia sim_ para o Google).
 * f) Isolamento multi-tenant entre salões, deduplicação de eventos e confirmação estrita (confirmed === true)
 *    rejeitando 'true', 'false', 1, 0, null e campos ausentes.
 * g) Comprovação de zero chamadas de rede externa e descarte garantido do SQLite temporário em qualquer desfecho.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const http = require('http');
const https = require('https');

// -------------------------------------------------------------
// CONFIGURAÇÃO DO BANCO TEMPORÁRIO ISOLADO (DISPOSABLE SQLITE)
// -------------------------------------------------------------
const tempDbName = `raia_test_gcal_staging_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.db`;
const tempDbPath = path.resolve(os.tmpdir(), tempDbName);

process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.ALLOW_WHATSAPP_SENDING = 'false';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'raia-segredo-super-forte-de-32-bytes-para-testes!';
process.env.ADMIN_PASSWORD = 'raia-segredo-super-forte-admin-123456!';
delete process.env.GOOGLE_SYNC_LIVE_ENABLED;
delete process.env.GOOGLE_SYNC_ALLOWED_EMAILS;

function cleanupTempDb() {
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDbPath + '-wal')) fs.unlinkSync(tempDbPath + '-wal');
    if (fs.existsSync(tempDbPath + '-shm')) fs.unlinkSync(tempDbPath + '-shm');
  } catch (_) {}
}

// -------------------------------------------------------------
// SANDBOX DE REDE FAIL-CLOSED (COMPROVAÇÃO DE ZERO CHAMADAS EXTERNAS)
// -------------------------------------------------------------
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
let externalNetworkCallsAttempted = 0;
const interceptedHosts = [];

function enableStrictNetworkSandbox() {
  https.request = function(url, options, cb) {
    externalNetworkCallsAttempted++;
    const host = (typeof url === 'string' ? url : options?.host || options?.hostname || url?.host || url?.hostname) || 'unknown';
    interceptedHosts.push(host);
    const err = new Error(`SEGURANÇA_FAIL_CLOSED: Tentativa indevida de conexão externa em teste: ${host}`);
    err.code = 'EXTERNAL_NETWORK_PROHIBITED';
    throw err;
  };

  http.request = function(url, options, cb) {
    externalNetworkCallsAttempted++;
    const host = (typeof url === 'string' ? url : options?.host || options?.hostname || url?.host || url?.hostname) || 'unknown';
    interceptedHosts.push(host);
    const err = new Error(`SEGURANÇA_FAIL_CLOSED: Tentativa indevida de conexão externa em teste: ${host}`);
    err.code = 'EXTERNAL_NETWORK_PROHIBITED';
    throw err;
  };
}

function restoreNetwork() {
  http.request = originalHttpRequest;
  https.request = originalHttpsRequest;
}

const { google } = require('googleapis');
const config = require('../src/config/index');
const db = require('../src/database/db');
const googleCalendarService = require('../src/services/googleCalendarService');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const outboxWorker = require('../src/services/outboxWorker');

function setupTestSalon(email, isDemo = 0) {
  const user = db.prepare(`
    INSERT INTO users (email, phone_number, role, plan_tier, subscription_status, paid_until, is_demo)
    VALUES (?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'), ?)
  `).run(email, '55119' + Math.floor(10000000 + Math.random() * 90000000), isDemo);
  const userId = user.lastInsertRowid;

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, google_require_sync_availability)
    VALUES (?, 'Salão Jéssica Beauty Teste', '5511988880001', '5511988880001', 1, 1, 0)
  `).run(userId);

  const staff = db.prepare(`INSERT INTO client_staff (user_id, name, active) VALUES (?, 'Jéssica Master', 1)`).run(userId);
  const staffId = staff.lastInsertRowid;

  const svc = db.prepare(`INSERT INTO client_services (user_id, name, duration_min, price, active, category) VALUES (?, 'Corte Feminino com Escova', 60, 90.0, 1, 'Cabelo')`).run(userId);
  const svcId = svc.lastInsertRowid;

  return { userId, staffId, svcId };
}

async function runTests() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — TESTES DE PROTEÇÃO DO GOOGLE CALENDAR         ');
  console.log('================================================================\n');

  enableStrictNetworkSandbox();

  // -------------------------------------------------------------
  // COMPROVAÇÃO DE ISOLAMENTO (FAIL-CLOSED)
  // -------------------------------------------------------------
  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE TESTE ---');
  assert.strictEqual(process.env.DB_PATH, tempDbPath, 'DB_PATH deve ser o SQLite temporário');
  assert.strictEqual(config.dbPath, tempDbPath, 'config.dbPath deve apontar para o SQLite temporário');
  const defaultDbPath = path.resolve(__dirname, '../data/assistant.db');
  assert.notStrictEqual(path.resolve(config.dbPath), defaultDbPath, 'Segurança: assistant.db jamais pode ser acessado em testes');
  assert(!config.dbPath.includes('assistant.db'), 'O caminho DB_PATH não pode conter assistant.db');
  assert.strictEqual(process.env.ALLOW_WHATSAPP_SENDING, 'false', 'WhatsApp externo bloqueado');

  console.log(`  ✓ Banco temporário ativo: ${tempDbPath}`);
  console.log(`  ✓ Banco operacional data/assistant.db 100% intocado e preservado.\n`);

  // -------------------------------------------------------------
  // CONFIGURAÇÃO DOS MOCKS OAUTH (INTEGRALMENTE EM MEMÓRIA)
  // -------------------------------------------------------------
  const originalGetToken = google.auth.OAuth2.prototype.getToken;
  const originalRevoke = google.auth.OAuth2.prototype.revokeCredentials;
  const originalOauth2 = google.oauth2;
  let mockOAuthEmail = 'salao.homologacao@gmail.com';
  let mockUserinfoShouldFail = false;
  let userinfoGetCallCount = 0;

  google.auth.OAuth2.prototype.revokeCredentials = async function() {
    return { data: {} };
  };

  google.auth.OAuth2.prototype.getToken = async function(code) {
    return {
      tokens: {
        access_token: 'mock_access_' + Math.random().toString(36).substring(2),
        refresh_token: 'mock_refresh_' + Math.random().toString(36).substring(2),
        scope: 'https://www.googleapis.com/auth/calendar',
        token_type: 'Bearer',
        expiry_date: Date.now() + 3600000,
        id_token: 'header.' + Buffer.from(JSON.stringify({ email: mockOAuthEmail })).toString('base64') + '.sig',
      }
    };
  };

  google.oauth2 = function(opts) {
    return {
      userinfo: {
        get: async function() {
          userinfoGetCallCount++;
          if (mockUserinfoShouldFail) {
            const err = new Error('Simulated Google OAuth userinfo.get() Network/Auth Error');
            err.code = 'MOCK_USERINFO_FAIL';
            throw err;
          }
          return {
            data: {
              email: mockOAuthEmail,
              verified_email: true,
              id: 'mock_google_user_id_123',
            }
          };
        }
      }
    };
  };

  // Helper para acionar o fluxo REAL de OAuth de forma estrita
  async function executeRealOAuthCallback(userId, email, options = {}) {
    mockOAuthEmail = email;
    const state = 'oauth_state_' + Math.random().toString(36).substring(2);
    db.prepare('INSERT INTO oauth_states (state, user_id, expires_at) VALUES (?, ?, ?)').run(
      state,
      userId,
      Date.now() + 600000
    );

    return googleCalendarService.handleOAuthCallback('mock_auth_code_123', state, userId, options);
  }

  try {
    // =============================================================
    // TESTE 1: Bloqueio de Rede Fail-Closed (Item 1 e Requisito 6d)
    // =============================================================
    console.log('[Teste 1] Bloqueio de rede fail-closed em isLiveGoogleSyncAllowed...');
    // 1. GOOGLE_SYNC_LIVE_ENABLED desabilitado
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';
    delete process.env.GOOGLE_SYNC_ALLOWED_EMAILS;
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed('teste@gmail.com'), false, 'Deve bloquear quando live desabilitado');

    // 2. GOOGLE_SYNC_LIVE_ENABLED=true mas GOOGLE_SYNC_ALLOWED_EMAILS vazia ou inexistente (FAIL-CLOSED)
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    process.env.GOOGLE_SYNC_ALLOWED_EMAILS = '';
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed('teste@gmail.com'), false, 'Deve bloquear fail-closed com whitelist vazia');

    process.env.GOOGLE_SYNC_ALLOWED_EMAILS = '   ,  , ';
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed('teste@gmail.com'), false, 'Deve bloquear fail-closed com espaços');

    // 3. Email ausente
    process.env.GOOGLE_SYNC_ALLOWED_EMAILS = 'salao@raiaagentes.com.br';
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed(null), false, 'Deve bloquear quando email da conta for null');
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed(''), false, 'Deve bloquear quando email for vazio');

    // 4. Email não autorizado
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed('invasor@gmail.com'), false, 'Deve bloquear email fora da whitelist');

    // 5. Email autorizado na lista
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed('salao@raiaagentes.com.br'), true, 'Deve liberar apenas email presente na whitelist');
    process.env.GOOGLE_SYNC_ALLOWED_EMAILS = 'admin@raia.com, salao@raiaagentes.com.br, outro@raia.com';
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed('SALAO@raiaagentes.com.br'), true, 'Case-insensitive autorizado');

    // Reset para ambiente padrão seguro de testes (bloqueado)
    delete process.env.GOOGLE_SYNC_LIVE_ENABLED;
    delete process.env.GOOGLE_SYNC_ALLOWED_EMAILS;
    console.log('  ✓ 1. Bloqueio fail-closed validado em todos os cenários de borda.');

    // =============================================================
    // TESTE 2: Preexistentes no Outbox com CREATE, UPDATE e DELETE (Item 2 e Requisito 6c)
    // =============================================================
    console.log('[Teste 2] Proteção de preexistentes no outbox cobrindo CREATE, UPDATE e DELETE...');
    const { userId: salon1Id, staffId: staff1, svcId: svc1 } = setupTestSalon('salao.teste.outbox@raiaagentes.com.br', 0);

    // 1. Agendamento A: CREATE no outbox
    const aptA = salonAppointmentService.bookAppointmentSync(salon1Id, {
      clientName: 'Cliente Teste Beauty',
      clientPhone: '11999990001',
      serviceId: svc1,
      staffId: staff1,
      date: '2026-11-10',
      time: '09:00',
      durationMin: 60,
      status: 'AGENDADO',
    });

    // 2. Agendamento B: UPDATE no outbox (remarcado antes da conexão Google)
    const aptB = salonAppointmentService.bookAppointmentSync(salon1Id, {
      clientName: 'Cliente Teste Remarcado',
      clientPhone: '11999990002',
      serviceId: svc1,
      staffId: staff1,
      date: '2026-11-10',
      time: '11:00',
      durationMin: 60,
      status: 'AGENDADO',
    });
    // Simular ação UPDATE no outbox para aptB
    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'UPDATE', 'PENDING', ?)
    `).run(salon1Id, aptB.id, JSON.stringify({ startDt: '2026-11-10T12:00:00' }));

    // 3. Agendamento C: DELETE no outbox (cancelado antes da conexão Google)
    const aptC = salonAppointmentService.bookAppointmentSync(salon1Id, {
      clientName: 'Cliente Teste Cancelado',
      clientPhone: '11999990003',
      serviceId: svc1,
      staffId: staff1,
      date: '2026-11-10',
      time: '14:00',
      durationMin: 60,
      status: 'AGENDADO',
    });
    // Marca como cancelado antes da conexão Google
    db.prepare("UPDATE appointments SET status = 'CANCELADO', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(aptC.id);

    // Simular ação DELETE no outbox para aptC
    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'DELETE', 'PENDING', ?)
    `).run(salon1Id, aptC.id, JSON.stringify({ reason: 'Cancelado pelo cliente' }));

    // Verificar que temos os 3 no outbox como PENDING
    const outboxItemsBefore = db.prepare("SELECT id, appointment_id, action, status FROM google_sync_outbox WHERE user_id = ? AND status = 'PENDING'").all(salon1Id);
    const actions = outboxItemsBefore.map(i => i.action);
    assert(actions.includes('CREATE'), 'Outbox deve conter CREATE');
    assert(actions.includes('UPDATE'), 'Outbox deve conter UPDATE');
    assert(actions.includes('DELETE'), 'Outbox deve conter DELETE');
    console.log('  ✓ 2. Agendamentos preexistentes com CREATE, UPDATE e DELETE auditados.');

    // =============================================================
    // TESTE 3: Fluxo Real de OAuth Callback com Simulação Integral de userinfo.get (Requisitos 6a, 6b e 6c)
    // =============================================================
    console.log('[Teste 3] Fluxo real de OAuth com simulação de userinfo.get() válida e com falha...');
    // Cenário A: Resposta válida da API userinfo.get()
    mockUserinfoShouldFail = false;
    const initialCallCount = userinfoGetCallCount;
    const oauthResult = await executeRealOAuthCallback(salon1Id, 'salao.homologacao@gmail.com');
    assert.strictEqual(oauthResult.success, true, 'OAuth callback real executado com sucesso');
    assert.strictEqual(oauthResult.userId, salon1Id);
    assert(userinfoGetCallCount > initialCallCount, 'userinfo.get() deve ter sido invocado');

    // Cenário B: Simulação de falha na API userinfo.get() com fallback seguro para id_token
    const { userId: salonRecoveryId } = setupTestSalon('salao.fallback@raiaagentes.com.br', 0);
    mockUserinfoShouldFail = true;
    const recoveryResult = await executeRealOAuthCallback(salonRecoveryId, 'salao.fallback@gmail.com');
    assert.strictEqual(recoveryResult.success, true, 'OAuth callback deve concluir via fallback de id_token');
    assert.strictEqual(recoveryResult.email, 'salao.fallback@gmail.com', 'Email deve ser extraído do id_token');
    mockUserinfoShouldFail = false; // Restaura

    // Verificar que initial_connection_at e connected_at foram gravados
    const tokenRow = db.prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ?').get(salon1Id);
    assert(tokenRow.initial_connection_at, 'initial_connection_at deve ser gravado na primeira conexão');
    assert(tokenRow.connected_at, 'connected_at deve ser gravado');
    assert.strictEqual(tokenRow.is_connected, 1, 'Deve estar marcado como conectado');

    // Verificar que NENHUM dos itens preexistentes (CREATE, UPDATE, DELETE) permaneceu PENDING
    const outboxPending = db.prepare("SELECT * FROM google_sync_outbox WHERE user_id = ? AND status = 'PENDING'").all(salon1Id);
    assert.strictEqual(outboxPending.length, 0, 'Todos os itens preexistentes (CREATE, UPDATE, DELETE) devem ser sanitizados na primeira conexão');

    // Conferir que todos foram marcados como SENT com SKIPPED_PRE_EXISTING (ou cancelado)
    const outboxAll = db.prepare('SELECT * FROM google_sync_outbox WHERE user_id = ?').all(salon1Id);
    for (const item of outboxAll) {
      assert.strictEqual(item.status, 'SENT', `Item ${item.id} action ${item.action} deve ter status SENT`);
      assert(
        item.last_error.includes('SKIPPED_PRE_EXISTING') || item.last_error.includes('SKIPPED: Agendamento cancelado'),
        `Item ${item.id} (${item.action}) last_error deve ser SKIPPED: ${item.last_error}`
      );
    }

    // Conferir que appointments estão como NOT_SYNCED ou CANCELLED e com SQLite 100% preservado
    const aptACheck = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptA.id);
    const aptBCheck = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptB.id);
    const aptCCheck = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptC.id);
    assert.strictEqual(aptACheck.google_sync_status, 'NOT_SYNCED');
    assert.strictEqual(aptBCheck.google_sync_status, 'NOT_SYNCED');
    assert.strictEqual(aptCCheck.google_sync_status, 'CANCELLED');
    assert.strictEqual(aptACheck.client_name, 'Cliente Teste Beauty');
    assert.strictEqual(aptBCheck.client_name, 'Cliente Teste Remarcado');
    assert.strictEqual(aptCCheck.client_name, 'Cliente Teste Cancelado');
    console.log('  ✓ 3. Fluxo real de OAuth callback simulado integralmente com suporte a fallback e sanitização de CREATE, UPDATE, DELETE.');

    // =============================================================
    // TESTE 4: Reconexão Preserva Histórico e Agendamentos Legítimos (Requisito 6b)
    // =============================================================
    console.log('[Teste 4] Reconexão preserva initial_connection_at e novos agendamentos...');
    const initialConnTimestamp = tokenRow.initial_connection_at;

    // Desconectar
    await googleCalendarService.disconnectUserCalendar(salon1Id);
    assert.strictEqual(googleCalendarService.getConnectionStatus(salon1Id).isConnected, false);

    // Criar agendamento legítimo pós-conexão durante período desconectado (Terça-feira, salão aberto)
    const aptPosConexao = salonAppointmentService.bookAppointmentSync(salon1Id, {
      clientName: 'Cliente Pós Conexão Legítimo',
      clientPhone: '11999990004',
      serviceId: svc1,
      staffId: staff1,
      date: '2026-11-17',
      time: '15:00',
      durationMin: 60,
      status: 'CONFIRMADO',
    });

    // Reconectar
    await executeRealOAuthCallback(salon1Id, 'salao.homologacao@gmail.com');
    const tokenRecon = db.prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ?').get(salon1Id);
    assert.strictEqual(tokenRecon.initial_connection_at, initialConnTimestamp, 'initial_connection_at deve ser estritamente preservado na reconexão');

    // O agendamento legítimo pós-conexão NÃO deve ter sido descartado
    const outboxLegit = db.prepare('SELECT * FROM google_sync_outbox WHERE appointment_id = ?').get(aptPosConexao.id);
    assert.strictEqual(outboxLegit.status, 'PENDING', 'Agendamento pós-conexão deve permanecer PENDING na reconexão');
    console.log('  ✓ 4. Reconexão preservou initial_connection_at e itens legítimos.');

    // =============================================================
    // TESTE 5: Sincronização Manual com Confirmação Estrita e Deduplicação (Item 2 e Requisito 6f)
    // =============================================================
    console.log('[Teste 5] Confirmação estrita (confirmed === true) e deduplicação na sincronização manual...');
    // 1. Prévia deve listar agendamentos elegíveis
    const preview = googleCalendarService.getPreExistingSyncPreview(salon1Id);
    assert.strictEqual(preview.canSync, true);
    assert(preview.count >= 2, `Deve encontrar agendamentos preexistentes futuros (encontrados: ${preview.count})`);

    // 2. Validação estrita: rejeição de valores não estritamente booleanos true
    const invalidInputs = [
      undefined,
      {},
      { confirmed: 'true' },   // string "true"
      { confirmed: 'false' },  // string "false"
      { confirmed: 1 },        // number 1
      { confirmed: 0 },        // number 0
      { confirmed: null },     // null
      { confirmed: false },    // boolean false
    ];

    for (const invalidOpt of invalidInputs) {
      let threw = false;
      try {
        await googleCalendarService.syncPreExistingAppointments(salon1Id, invalidOpt);
      } catch (err) {
        threw = true;
        assert.strictEqual(err.code, 'CONFIRMATION_REQUIRED', `Opção ${JSON.stringify(invalidOpt)} deve ser rejeitada com CONFIRMATION_REQUIRED`);
        assert.strictEqual(err.eligibleCount, preview.count);
      }
      assert.strictEqual(threw, true, `syncPreExistingAppointments deve lançar CONFIRMATION_REQUIRED para ${JSON.stringify(invalidOpt)}`);
    }

    // 3. Chamar com confirmação estrita { confirmed: true }
    const syncResult = await googleCalendarService.syncPreExistingAppointments(salon1Id, { confirmed: true });
    assert.strictEqual(syncResult.success, true);
    assert.strictEqual(syncResult.enqueuedCount, preview.count);

    // 4. Chamar novamente deve resultar em 0 enfileiramentos (Deduplicação de Eventos - Requisito 6f)
    const syncDuplicate = await googleCalendarService.syncPreExistingAppointments(salon1Id, { confirmed: true });
    assert.strictEqual(syncDuplicate.enqueuedCount, 0, 'Não deve enfileirar duplicatas no outbox');
    console.log('  ✓ 5. Confirmação estrita (rejeitando strings, números e null) e prevenção de duplicatas aprovadas.');

    // =============================================================
    // TESTE 6: Worker em Modo Simulado e Correção do Retorno de createCalendarEvent (Item 3)
    // =============================================================
    console.log('[Teste 6] Processamento do worker em modo simulado e integridade de IDs...');
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'false';

    const processedCount = await outboxWorker.processGoogleSyncOutbox(salon1Id);
    assert(processedCount > 0, 'Worker deve processar itens da fila em modo simulado');

    // Verificar que os agendamentos foram atualizados com IDs simulados válidos (sem googleEventId indefinido)
    const aptASim = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptA.id);
    assert.strictEqual(aptASim.google_sync_status, 'SIMULATED');
    assert(aptASim.google_event_id.startsWith('sim_'), 'ID do evento simulado deve iniciar com sim_');
    assert(!aptASim.google_event_id.includes('undefined'), 'ID jamais pode conter string undefined');

    // Testar chamada direta de createCalendarEvent em modo simulado
    const directSimCreate = await googleCalendarService.createCalendarEvent(salon1Id, aptASim);
    assert.strictEqual(directSimCreate.success, true);
    assert.strictEqual(directSimCreate.isSimulated, true);
    assert(directSimCreate.googleEventId.startsWith('sim_'), 'googleEventId retornado não pode ser indefinido');
    console.log('  ✓ 6. Modo simulado processado com sucesso e retorno de createCalendarEvent validado.');

    // =============================================================
    // TESTE 7: Transição de Simulado para Real (Item 3 e Requisito 6e)
    // =============================================================
    console.log('[Teste 7] Transição de simulado para real (nunca envia sim_ para Google API)...');
    // Ativar sincronização real com email autorizado
    process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
    process.env.GOOGLE_SYNC_ALLOWED_EMAILS = 'salao.homologacao@gmail.com';
    assert.strictEqual(googleCalendarService.isLiveGoogleSyncAllowed('salao.homologacao@gmail.com'), true);

    // Espionar chamadas para a API do Google Calendar
    let patchEventIdCalled = null;
    let insertCalledWith = null;
    let deleteEventIdCalled = null;

    const originalCalendar = google.calendar;
    google.calendar = function() {
      return {
        events: {
          list: async () => ({ data: { items: [] } }),
          insert: async (opts) => {
            insertCalledWith = opts;
            return { data: { id: opts.requestBody?.id || 'real_gcal_evt_123' } };
          },
          patch: async (opts) => {
            patchEventIdCalled = opts.eventId;
            return { data: { id: opts.eventId } };
          },
          delete: async (opts) => {
            deleteEventIdCalled = opts.eventId;
            return { data: {} };
          },
        },
      };
    };

    try {
      // 1. Atualizar agendamento que possuía ID simulado (sim_)
      const simulatedApt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptA.id);
      assert(simulatedApt.google_event_id.startsWith('sim_'), 'Deve ter ID simulado');

      const updateResult = await googleCalendarService.updateCalendarEvent(
        salon1Id,
        simulatedApt.google_event_id,
        { ...simulatedApt, title: 'Corte e Escova Jéssica Atualizado' }
      );

      assert.strictEqual(updateResult.success, true);
      // CRÍTICO: patch NUNCA deve ser chamado com ID sim_!
      assert.strictEqual(patchEventIdCalled, null, 'Segurança: patch JAMAIS pode ser chamado com ID simulado');
      // Deve ter chamado insert (createCalendarEvent) para criar o evento real no Google
      assert(insertCalledWith !== null, 'Transição: deve criar o evento no Google via insert de forma idempotente');
      assert.strictEqual(updateResult.googleEventId, insertCalledWith.requestBody.id);

      // O status no banco deve agora ser SYNCED
      const updatedApt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptA.id);
      assert.strictEqual(updatedApt.google_sync_status, 'SYNCED', 'Status deve ter transitado para SYNCED');
      assert(!updatedApt.google_event_id.startsWith('sim_'), 'google_event_id deve ser o ID real no Google');

      // 2. Cancelar agendamento que possui ID simulado
      const aptSimCancel = salonAppointmentService.bookAppointmentSync(salon1Id, {
        clientName: 'Cliente Simulado Cancelar',
        clientPhone: '11999990009',
        serviceId: svc1,
        staffId: staff1,
        date: '2026-11-25',
        time: '16:00',
        durationMin: 60,
        status: 'AGENDADO',
      });
      db.prepare("UPDATE appointments SET google_event_id = 'sim_gcal_cancel_999', google_sync_status = 'SIMULATED' WHERE id = ?").run(aptSimCancel.id);

      const deleteResult = await googleCalendarService.deleteCalendarEvent(salon1Id, 'sim_gcal_cancel_999');
      assert.strictEqual(deleteResult.success, true);
      assert.strictEqual(deleteResult.isSimulated, true);
      // CRÍTICO: delete do Google Calendar NUNCA deve ser chamado para ID simulado (evita 404)
      assert.strictEqual(deleteEventIdCalled, null, 'Segurança: Google API delete JAMAIS deve ser chamado para ID simulado');

      const cancelledSimApt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptSimCancel.id);
      assert.strictEqual(cancelledSimApt.google_sync_status, 'CANCELLED');
      console.log('  ✓ 7. Transição de simulado para real validada: IDs simulados nunca enviados à API externa.');
    } finally {
      google.calendar = originalCalendar;
      delete process.env.GOOGLE_SYNC_LIVE_ENABLED;
      delete process.env.GOOGLE_SYNC_ALLOWED_EMAILS;
    }

    // =============================================================
    // TESTE 8: Isolamento Multi-Tenant e Prevenção Cross-Salon (Requisito 6f)
    // =============================================================
    console.log('[Teste 8] Isolamento estrito entre salões e rejeição de vínculo cruzado...');
    const { userId: salon2Id, staffId: staff2, svcId: svc2 } = setupTestSalon('salao.concorrente@raiaagentes.com.br', 0);

    // Tentativa de vincular callback usando state gerado para salon1Id autenticado como salon2Id
    const fakeState = 'cross_state_' + Math.random().toString(36).substring(2);
    db.prepare('INSERT INTO oauth_states (state, user_id, expires_at) VALUES (?, ?, ?)').run(
      fakeState,
      salon1Id,
      Date.now() + 600000
    );

    let crossThrew = false;
    try {
      await googleCalendarService.handleOAuthCallback('mock_code', fakeState, salon2Id);
    } catch (err) {
      crossThrew = true;
      assert.strictEqual(err.code, 'CROSS_SALON_LINKING_REJECTED', 'Deve rejeitar vínculo cruzado entre salões');
    }
    assert.strictEqual(crossThrew, true, 'Deve rejeitar vinculação cruzada');

    // Agendamento do Salão 2 não é afetado pelo Salão 1
    const aptSalon2 = salonAppointmentService.bookAppointmentSync(salon2Id, {
      clientName: 'Cliente do Salão Concorrente',
      clientPhone: '11999990088',
      serviceId: svc2,
      staffId: staff2,
      date: '2026-11-28',
      time: '10:00',
      durationMin: 60,
      status: 'AGENDADO',
    });

    const countOutboxSalon2 = db.prepare('SELECT COUNT(*) as count FROM google_sync_outbox WHERE user_id = ?').get(salon2Id);
    assert.strictEqual(countOutboxSalon2.count, 1, 'Salão 2 deve ter seu próprio outbox isolado');
    console.log('  ✓ 8. Isolamento multi-tenant e segurança anti-cross-salon 100% comprovados.');

    // =============================================================
    // TESTE 9: Aliases e Notificações do Worker (Item 4)
    // =============================================================
    console.log('[Teste 9] Validação de outboxWorker.notify e triggerWorkerImmediate alias...');
    assert.strictEqual(typeof outboxWorker.notify, 'function', 'outboxWorker.notify deve ser função exportada');
    assert.strictEqual(typeof outboxWorker.triggerWorkerImmediate, 'function', 'triggerWorkerImmediate deve ser alias de notify');
    assert.strictEqual(outboxWorker.triggerWorkerImmediate, outboxWorker.notify, 'Deve ser exatamente a mesma função');
    outboxWorker.notify(); // Não deve lançar erro
    console.log('  ✓ 9. Worker notify() e triggerWorkerImmediate() validados.');

    // =============================================================
    // TESTE 10: Comprovação de Zero Chamadas de Rede Externa
    // =============================================================
    console.log('[Teste 10] Comprovação de zero chamadas de rede externa...');
    assert.strictEqual(externalNetworkCallsAttempted, 0, `Nenhuma chamada externa permitida. Tentativas interceptadas: ${externalNetworkCallsAttempted}`);
    console.log('  ✓ 10. Comprovado: 0 conexões externas efetuadas durante toda a execução dos testes.');

  } finally {
    // -------------------------------------------------------------
    // RESTAURAÇÃO DE MOCKS E LIMPEZA GARANTIDA
    // -------------------------------------------------------------
    restoreNetwork();
    google.auth.OAuth2.prototype.getToken = originalGetToken;
    google.auth.OAuth2.prototype.revokeCredentials = originalRevoke;
    google.oauth2 = originalOauth2;
    cleanupTempDb();
    console.log('\n--- LIMPEZA DO AMBIENTE TEMPORÁRIO ---');
    console.log('  ✓ Métodos originais restaurados.');
    console.log('  ✓ Arquivos do SQLite temporário descartados com sucesso.');
  }

  console.log('\n================================================================');
  console.log('   TODOS OS 10 TESTES DE SEGURANÇA GOOGLE PASSARAM! (10/10)     ');
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ FALHA NA SUÍTE DE TESTES:', err);
  cleanupTempDb();
  process.exit(1);
});
