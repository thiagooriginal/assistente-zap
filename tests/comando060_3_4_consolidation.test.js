/**
 * RAIA AGENTES — Suíte de Testes Herméticos Automatizados (Comando 060.3.4)
 * Consolidação e Validação de Bloqueio Fail-Closed em Workers, Filas Outbox,
 * Renovação Simulada e Isolamento Multi-Tenant.
 *
 * Cenários Mandatórios:
 * 1. Assinatura Ativa vs Vencida (bloqueio fail-closed em rotas pagas HTTP 403 SUBSCRIPTION_EXPIRED).
 * 2. Outbox Worker Google Calendar: item enfileirado antes do vencimento e processado após expiração
 *    deve transitar para CANCELLED com motivo SUBSCRIPTION_EXPIRED e marcar agendamento NOT_SYNCED.
 * 3. Outbox Worker WhatsApp: notificação/lembrete enfileirado antes do vencimento e processado após
 *    expiração deve transitar para CANCELLED com motivo SUBSCRIPTION_EXPIRED.
 * 4. Lembretes 24h (salonReminderService): agendamentos de clientes expirados são descartados antes do enfileiramento.
 * 5. Simulação de Renovação: ao estender paid_until para o futuro em banco descartável,
 *    as rotas operacionais e acessos são desbloqueados imediatamente (HTTP 200).
 * 6. Tenant Demo (is_demo = 1): opera normalmente sem bloqueio de expiração.
 * 7. Isolamento Multi-Tenant Estrito: conta demo ou cliente expirado jamais acessa dados de outro salão.
 */

'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// ============================================================================
// 1. ISOLAMENTO MANDATÓRIO DE BANCO E AMBIENTE (ANTES DE QUALQUER REQUIRE)
// ============================================================================
const tempDbPath = path.join(
  os.tmpdir(),
  `test-comando060-3-4-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`
);

process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.STAGING_PROTECTION_ENABLED = 'false';
process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'false';
process.env.ADMIN_PASSWORD = 'TestMasterPassword123!@#';
process.env.ADMIN_API_KEY = 'test_admin_api_key_secret_least_privilege_123';
process.env.SESSION_SECRET = 'test_session_secret_32_chars_long_entropy!';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_32_chars_long_entropy!';
process.env.DEMO_ACCOUNT_EMAIL = 'homologacao.hotmart@raiaagentes.com.br';
process.env.DEMO_ACCOUNT_PASSWORD = 'DemoPassword123#';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database/db');
const productService = require('../src/services/productService');
const clientAuth = require('../src/services/clientAuthService');
const outboxWorker = require('../src/services/outboxWorker');
const salonReminderService = require('../src/services/salonReminderService');
const { app } = require('../src/server/app');

// ============================================================================
// 2. CICLO DE VIDA DO SERVIDOR EFÊMERO
// ============================================================================
let server;
let baseUrl;

const TOKEN_EXPIRED = 'tok_exp_' + crypto.randomBytes(16).toString('hex');
const TOKEN_ACTIVE = 'tok_act_' + crypto.randomBytes(16).toString('hex');
const TOKEN_DEMO = 'tok_dmo_' + crypto.randomBytes(16).toString('hex');

let userExpiredId;
let userActiveId;
let userDemoId;
let jessicaProductId;
let proPlanId;

test.before(async () => {
  // Subir servidor HTTP em porta dinâmica aleatória (0)
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Garantir produto JÉSSICA
  let prod = db.prepare("SELECT id FROM products WHERE UPPER(code) = 'JESSICA'").get();
  if (!prod) {
    const res = db.prepare(`
      INSERT INTO products (code, name, category, commercial_status, is_active, has_approved_offer)
      VALUES ('JESSICA', 'Jéssica Beauty', 'Beleza & Estética', 'AVAILABLE', 1, 1)
    `).run();
    jessicaProductId = Number(res.lastInsertRowid);
  } else {
    jessicaProductId = prod.id;
  }

  // Garantir plano PRO
  let plan = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND UPPER(code) IN ('PRO', 'JESSICA_PRO') LIMIT 1").get(jessicaProductId);
  if (!plan) {
    const pRes = db.prepare(`
      INSERT INTO product_plans (product_id, code, name, price_cents, is_active)
      VALUES (?, 'PRO', 'Plano Jéssica Pró', 14900, 1)
    `).run(jessicaProductId);
    proPlanId = Number(pRes.lastInsertRowid);
  } else {
    proPlanId = plan.id;
  }

  const futureExpiration = new Date(Date.now() + 30 * 86400000).toISOString();
  const pastPaidUntil = new Date(Date.now() - 5 * 86400000).toISOString();
  const futurePaidUntil = new Date(Date.now() + 30 * 86400000).toISOString();
  const ancientPastPaidUntil = '2020-01-01T00:00:00.000Z';

  // Inserir Usuário 1: Assinatura EXPIRADA (Cliente real com período contratado encerrado)
  const expRes = db.prepare(`
    INSERT INTO users (
      phone_number, name, email, role, plan_tier, subscription_status,
      paid_until, session_token, session_expires_at, is_demo
    ) VALUES (
      '+5511999990001', 'Cliente Expirado', 'expirado@teste.com', 'USER',
      'JESSICA_PRO', 'ACTIVE', ?, ?, ?, 0
    )
  `).run(pastPaidUntil, TOKEN_EXPIRED, futureExpiration);
  userExpiredId = Number(expRes.lastInsertRowid);

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents,
      paid_until, access_expires_at
    ) VALUES (?, ?, ?, 'ASAAS', 'ASAAS', 'ACTIVE', 14900, ?, ?)
  `).run(userExpiredId, jessicaProductId, proPlanId, pastPaidUntil, pastPaidUntil);

  clientAuth.ensureSalonForUser(userExpiredId, 'Salão Expirado');

  // Inserir Usuário 2: Assinatura ATIVA (Cliente em dia com vigência contratual)
  const actRes = db.prepare(`
    INSERT INTO users (
      phone_number, name, email, role, plan_tier, subscription_status,
      paid_until, session_token, session_expires_at, is_demo
    ) VALUES (
      '+5511999990002', 'Cliente Ativo', 'ativo@teste.com', 'USER',
      'JESSICA_PRO', 'ACTIVE', ?, ?, ?, 0
    )
  `).run(futurePaidUntil, TOKEN_ACTIVE, futureExpiration);
  userActiveId = Number(actRes.lastInsertRowid);

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents,
      paid_until, access_expires_at
    ) VALUES (?, ?, ?, 'ASAAS', 'ASAAS', 'ACTIVE', 14900, ?, ?)
  `).run(userActiveId, jessicaProductId, proPlanId, futurePaidUntil, futurePaidUntil);

  clientAuth.ensureSalonForUser(userActiveId, 'Salão Ativo');

  // Inserir Usuário 3: Conta DEMO (is_demo = 1, paid_until no passado)
  const demoRes = db.prepare(`
    INSERT INTO users (
      phone_number, name, email, role, plan_tier, subscription_status,
      paid_until, session_token, session_expires_at, is_demo
    ) VALUES (
      '+5511999990003', 'Cliente Homologação Hotmart', 'homologacao.hotmart@raiaagentes.com.br', 'USER',
      'JESSICA_PRO', 'ACTIVE', ?, ?, ?, 1
    )
  `).run(ancientPastPaidUntil, TOKEN_DEMO, futureExpiration);
  userDemoId = Number(demoRes.lastInsertRowid);

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents,
      paid_until, access_expires_at
    ) VALUES (?, ?, ?, 'HOTMART', 'HOTMART', 'ACTIVE', 14900, ?, ?)
  `).run(userDemoId, jessicaProductId, proPlanId, ancientPastPaidUntil, ancientPastPaidUntil);

  clientAuth.ensureSalonForUser(userDemoId, 'Salão Homologação Hotmart');
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  } catch (_) {}
});

// Helper HTTP
async function makeRequest(pathname, token, options = {}) {
  const url = `${baseUrl}${pathname}`;
  const headers = {
    'Accept': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };
  return fetch(url, { ...options, headers });
}

// ============================================================================
// SUÍTE DE TESTES: COMANDO 060.3.4
// ============================================================================

test('Cenário 1: Assinatura Ativa vs Vencida — Bloqueio fail-closed em rotas operacionais Jéssica', async () => {
  // Teste com cliente expirado em rota operacional
  const resExp = await makeRequest('/api/cliente/appointments', TOKEN_EXPIRED);
  assert.strictEqual(resExp.status, 403, 'Cliente com assinatura vencida deve receber HTTP 403');
  const bodyExp = await resExp.json();
  assert.strictEqual(bodyExp.code, 'SUBSCRIPTION_EXPIRED', 'Código de erro deve ser SUBSCRIPTION_EXPIRED');

  // Teste com cliente ativo em rota operacional
  const resAct = await makeRequest('/api/cliente/appointments', TOKEN_ACTIVE);
  assert.strictEqual(resAct.status, 200, 'Cliente ativo deve ter acesso liberado HTTP 200');

  // Teste de rota de autogestão liberada para cliente expirado (allowlist)
  const resProfile = await makeRequest('/api/cliente/profile', TOKEN_EXPIRED);
  assert.strictEqual(resProfile.status, 200, 'Cliente expirado deve acessar seu próprio perfil (HTTP 200)');
});

test('Cenário 2: Outbox Worker Google Sync — Item enfileirado antes do vencimento e processado depois é CANCELADO', async () => {
  // 1. Criar agendamento para o usuário expirado
  const aptRes = db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, start_datetime, end_datetime, status, google_sync_status)
    VALUES (?, 'Atendimento Pre-Vencimento', 'Cliente Pre-Vencimento', '11999991111', datetime('now', '+2 days'), datetime('now', '+2 days', '+1 hour'), 'AGENDADO', 'PENDING')
  `).run(userExpiredId);
  const aptId = Number(aptRes.lastInsertRowid);

  // 2. Enfileirar item no google_sync_outbox como se tivesse sido agendado antes do vencimento
  const outboxRes = db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
    VALUES (?, ?, 'CREATE', 'PENDING', ?)
  `).run(userExpiredId, aptId, JSON.stringify({ summary: 'Corte Cabelo' }));
  const outboxId = Number(outboxRes.lastInsertRowid);

  // 3. Executar o worker
  const result = await outboxWorker.processGoogleSyncOutbox(userExpiredId);

  // 4. Verificar se o item foi cancelado fail-closed
  const itemAfter = db.prepare('SELECT * FROM google_sync_outbox WHERE id = ?').get(outboxId);
  assert.strictEqual(itemAfter.status, 'CANCELLED', 'Item da outbox deve transitar para CANCELLED');
  assert.match(itemAfter.last_error, /SUBSCRIPTION_EXPIRED/, 'last_error deve indicar SUBSCRIPTION_EXPIRED');

  // 5. Verificar se o agendamento foi marcado como NOT_SYNCED
  const aptAfter = db.prepare('SELECT * FROM appointments WHERE id = ?').get(aptId);
  assert.strictEqual(aptAfter.google_sync_status, 'NOT_SYNCED', 'Agendamento deve ser marcado como NOT_SYNCED');
});

test('Cenário 3: Outbox Worker WhatsApp — Mensagem enfileirada antes do vencimento é CANCELADA fail-closed', async () => {
  // 1. Criar agendamento
  const aptRes = db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, start_datetime, end_datetime, status, reminder_consent)
    VALUES (?, 'Atendimento WhatsApp Expirado', 'Cliente WhatsApp Expirado', '5511999992222', datetime('now', '+1 day'), datetime('now', '+1 day', '+1 hour'), 'AGENDADO', 1)
  `).run(userExpiredId);
  const aptId = Number(aptRes.lastInsertRowid);

  // 2. Enfileirar notificação na outbox
  const outboxRes = db.prepare(`
    INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, recipient_phone, message_text, event_type, status, dedup_hash)
    VALUES (?, ?, '5511999992222', 'Seu agendamento está confirmado', 'CONFIRMATION', 'PENDING', ?)
  `).run(userExpiredId, aptId, `wa_test_exp_${Date.now()}`);
  const outboxId = Number(outboxRes.lastInsertRowid);

  // 3. Executar worker de WhatsApp
  const workerResult = await outboxWorker.processWhatsAppOutbox(userExpiredId);

  // 4. Verificar se a mensagem foi cancelada
  const itemAfter = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(outboxId);
  assert.strictEqual(itemAfter.status, 'CANCELLED', 'Notificação WhatsApp de cliente expirado deve ser CANCELLED');
  assert.match(itemAfter.last_error, /SUBSCRIPTION_EXPIRED/, 'last_error deve indicar SUBSCRIPTION_EXPIRED');
});

test('Cenário 4: Prevenção de Enfileiramento de Lembretes para Clientes Expirados', async () => {
  // 1. Criar agendamento nas próximas 24h para o cliente expirado
  db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, start_datetime, end_datetime, status, reminder_24h_status, reminder_consent)
    VALUES (?, 'Atendimento 24h Expirado', 'Cliente 24h Expirado', '5511977773333', datetime('now', '+23 hours'), datetime('now', '+24 hours'), 'AGENDADO', 'PENDING', 1)
  `).run(userExpiredId);

  // 2. Executar rotina de enfileiramento de lembretes 24h
  const remResult = await salonReminderService.checkAndQueue24hReminders(userExpiredId);

  // 3. Confirmar que nada foi enfileirado para o cliente expirado
  const queuedCount = Array.isArray(remResult) ? remResult.filter(r => r.status === 'ENQUEUED').length : 0;
  assert.strictEqual(queuedCount, 0, 'Zero lembretes devem ser enfileirados para salão com assinatura vencida');

  const pendingOutbox = db.prepare(`
    SELECT COUNT(*) as count FROM whatsapp_notification_outbox 
    WHERE user_id = ? AND recipient_phone = '5511977773333'
  `).get(userExpiredId);
  assert.strictEqual(pendingOutbox.count, 0, 'Nenhuma notificação deve constar na outbox para este agendamento');
});

test('Cenário 5: Simulação de Renovação de Assinatura — Desbloqueio imediato (HTTP 200 e Worker)', async () => {
  // 1. Confirmar que o usuário expirado está bloqueado
  const preCheck = await makeRequest('/api/cliente/appointments', TOKEN_EXPIRED);
  assert.strictEqual(preCheck.status, 403, 'Deve iniciar bloqueado');

  // 2. Simular renovação no banco descartável (atualizar paid_until para +30 dias)
  db.prepare(`
    UPDATE customer_subscriptions
    SET paid_until = datetime('now', '+30 days'),
        access_expires_at = datetime('now', '+30 days'),
        status = 'ACTIVE',
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(userExpiredId);
  db.prepare(`
    UPDATE users
    SET paid_until = datetime('now', '+30 days'),
        subscription_status = 'ACTIVE'
    WHERE id = ?
  `).run(userExpiredId);

  // 3. Testar se a rota operacional é liberada imediatamente (HTTP 200)
  const postCheck = await makeRequest('/api/cliente/appointments', TOKEN_EXPIRED);
  assert.strictEqual(postCheck.status, 200, 'Após renovação, a rota deve responder HTTP 200 imediatamente');

  // 4. Testar se o worker de sincronização processa itens normalmente após renovação
  const aptRes = db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, start_datetime, end_datetime, status, google_sync_status)
    VALUES (?, 'Atendimento Pós-Renovação', 'Cliente Pós-Renovação', '11999994444', datetime('now', '+3 days'), datetime('now', '+3 days', '+1 hour'), 'AGENDADO', 'PENDING')
  `).run(userExpiredId);
  const aptId = Number(aptRes.lastInsertRowid);

  const outboxRes = db.prepare(`
    INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
    VALUES (?, ?, 'CREATE', 'PENDING', ?)
  `).run(userExpiredId, aptId, JSON.stringify({ summary: 'Corte Renovado' }));
  const outboxId = Number(outboxRes.lastInsertRowid);

  await outboxWorker.processGoogleSyncOutbox(userExpiredId);

  const itemAfter = db.prepare('SELECT * FROM google_sync_outbox WHERE id = ?').get(outboxId);
  // O item avançou pelo gate de assinatura (não foi cancelado com SUBSCRIPTION_EXPIRED)
  assert.doesNotMatch(itemAfter.last_error || '', /SUBSCRIPTION_EXPIRED/, 'Erro não pode ser de assinatura expirada');
  assert.match(itemAfter.last_error || '', /CANCELLED_DISCONNECTED/, 'Deve avançar até a checagem de conexão do Google Calendar');

  // Reverter usuário para expirado para não interferir em outros testes
  db.prepare(`
    UPDATE customer_subscriptions
    SET paid_until = datetime('now', '-7 days'),
        access_expires_at = datetime('now', '-7 days')
    WHERE user_id = ?
  `).run(userExpiredId);
  db.prepare(`
    UPDATE users
    SET paid_until = datetime('now', '-7 days')
    WHERE id = ?
  `).run(userExpiredId);
});

test('Cenário 6: Tenant Demo (is_demo = 1) — Acesso irrestrito a operações pagas', async () => {
  // Usuário Demo possui paid_until no passado (-30 dias), mas is_demo = 1
  const resDemoApt = await makeRequest('/api/cliente/appointments', TOKEN_DEMO);
  assert.strictEqual(resDemoApt.status, 200, 'Conta demo deve ter acesso permitido (HTTP 200) mesmo com paid_until expirado');

  const resDemoSalon = await makeRequest('/api/cliente/salon', TOKEN_DEMO);
  assert.strictEqual(resDemoSalon.status, 200, 'Conta demo deve acessar GET /salon (HTTP 200)');
  const salonData = await resDemoSalon.json();
  assert.strictEqual(salonData.salon.name, 'Salão de Salão', 'Deve retornar dados do próprio salão demo');
});

test('Cenário 7: Isolamento Multi-Tenant Estrito — Sem vazamento entre salões', async () => {
  // Inserir agendamento confidencial no salão ativo
  const aptAtivoRes = db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, start_datetime, end_datetime, status)
    VALUES (?, 'Atendimento Secreto Ativo', 'Cliente Secreto Ativo', '11999998888', datetime('now', '+5 days'), datetime('now', '+5 days', '+1 hour'), 'AGENDADO')
  `).run(userActiveId);
  const idAtivo = Number(aptAtivoRes.lastInsertRowid);

  // 1. Tentar acessar com o Token Demo
  const resDemoList = await makeRequest('/api/cliente/appointments', TOKEN_DEMO);
  assert.strictEqual(resDemoList.status, 200);
  const appointmentsDemo = await resDemoList.json();
  const containsActiveClient = (appointmentsDemo.appointments || []).some(a => a.id === idAtivo);
  assert.strictEqual(containsActiveClient, false, 'Conta demo NÃO deve ver agendamentos de outros clientes');

  // 2. Tentar cancelar o agendamento de outro cliente via API (cross-tenant attack)
  const resCrossCancel = await makeRequest(`/api/cliente/appointments/${idAtivo}`, TOKEN_DEMO, {
    method: 'DELETE'
  });
  // Rota deve retornar 404 (não encontrado no escopo do tenant) ou 403, jamais 200
  assert.notStrictEqual(resCrossCancel.status, 200, 'Cross-tenant cancel não pode retornar HTTP 200');

  // 3. Confirmar no banco que o agendamento do usuário ativo não foi modificado
  const aptCheck = db.prepare('SELECT status FROM appointments WHERE id = ?').get(idAtivo);
  assert.strictEqual(aptCheck.status, 'AGENDADO', 'Status do agendamento de outro tenant deve permanecer intacto');
});
