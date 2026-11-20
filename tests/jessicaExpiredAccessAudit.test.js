/**
 * RAIA AGENTES — Suíte de Testes Herméticos Automatizados (Comando 060.3.3)
 * Auditoria de Bloqueio Fail-Closed para Assinaturas Expiradas no Módulo Jéssica
 * 
 * Validações Mandatórias:
 * 1. Bloqueio fail-closed (HTTP 403, SUBSCRIPTION_EXPIRED) nas 13 rotas operacionais Jéssica.
 * 2. Liberação estrita da allowlist de autogestão (HTTP 200) para clientes expirados.
 * 3. Liberação integral das rotas operacionais (HTTP 200) para assinaturas ativas.
 * 4. Liberação irrestrita para contas demo (is_demo = 1), mesmo com paid_until no passado.
 * 5. Formatação de effectiveStatus = 'EXPIRED' no productService.
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
  `test-jessica-expired-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.db`
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
const { app } = require('../src/server/app');

// ============================================================================
// 2. CICLO DE VIDA DO SERVIDOR EPHEMERAL E LIMPEZA DESLIGÁVEL
// ============================================================================
let server;
let baseUrl;

// Fixtures de Autenticação
const TOKEN_EXPIRED = 'tok_expired_' + crypto.randomBytes(16).toString('hex');
const TOKEN_ACTIVE = 'tok_active_' + crypto.randomBytes(16).toString('hex');
const TOKEN_DEMO = 'tok_demo_' + crypto.randomBytes(16).toString('hex');

let userExpiredId;
let userActiveId;
let userDemoId;
let jessicaProductId;

test.before(async () => {
  // Inicialização de servidor de teste em porta efêmera (port 0)
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Garantir produto JÉSSICA no banco temporário
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

  // Garantir plano PRO no banco temporário
  let plan = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND UPPER(code) IN ('PRO', 'JESSICA_PRO') LIMIT 1").get(jessicaProductId);
  let planId = plan?.id;
  if (!planId) {
    const pRes = db.prepare(`
      INSERT INTO product_plans (product_id, code, name, price_cents, is_active)
      VALUES (?, 'PRO', 'Plano Jéssica Pró', 14900, 1)
    `).run(jessicaProductId);
    planId = Number(pRes.lastInsertRowid);
  }

  const futureExpiration = new Date(Date.now() + 30 * 86400000).toISOString();
  const pastPaidUntil = new Date(Date.now() - 5 * 86400000).toISOString(); // 5 dias atrás
  const futurePaidUntil = new Date(Date.now() + 30 * 86400000).toISOString(); // 30 dias no futuro
  const ancientPastPaidUntil = '2020-01-01T00:00:00.000Z'; // Para conta demo

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
  `).run(userExpiredId, jessicaProductId, planId, pastPaidUntil, pastPaidUntil);

  clientAuth.ensureSalonForUser(userExpiredId, 'Salão Expirado');

  // Inserir Usuário 2: Assinatura ATIVA (Cliente em dia com vigência vigente)
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
  `).run(userActiveId, jessicaProductId, planId, futurePaidUntil, futurePaidUntil);

  clientAuth.ensureSalonForUser(userActiveId, 'Salão Ativo');

  // Inserir Usuário 3: Conta DEMO (is_demo = 1, com data de paid_until no passado)
  const demoRes = db.prepare(`
    INSERT INTO users (
      phone_number, name, email, role, plan_tier, subscription_status,
      paid_until, session_token, session_expires_at, is_demo
    ) VALUES (
      '+5511999990003', 'Cliente Homologação Hotmart', 'demo@teste.com', 'USER',
      'JESSICA_PRO', 'ACTIVE', ?, ?, ?, 1
    )
  `).run(ancientPastPaidUntil, TOKEN_DEMO, futureExpiration);
  userDemoId = Number(demoRes.lastInsertRowid);

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents,
      paid_until, access_expires_at
    ) VALUES (?, ?, ?, 'HOTMART', 'HOTMART', 'ACTIVE', 14900, ?, ?)
  `).run(userDemoId, jessicaProductId, planId, ancientPastPaidUntil, ancientPastPaidUntil);

  clientAuth.ensureSalonForUser(userDemoId, 'Salão Demonstração');
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    db.close();
  } catch (_) {}

  // Expurgo completo de arquivos temporários do SQLite
  const extensions = ['', '-wal', '-shm', '-journal'];
  for (const ext of extensions) {
    const file = tempDbPath + ext;
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch (_) {}
    }
  }
});

// Helper de requisição HTTP nativo
async function apiRequest(method, endpoint, { token = null, body = null } = {}) {
  const headers = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const rawText = await res.text();
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    data = rawText;
  }

  return { status: res.status, data };
}

// ============================================================================
// 3. SUÍTE DE TESTES: VALIDAÇÃO DE SEGURANÇA E ACESSO FAIL-CLOSED
// ============================================================================

test.describe('COMANDO 060.3 — Auditoria Hermética de Acesso de Assinaturas Expiradas (Jéssica)', () => {

  test('1. Bloqueio fail-closed em todas as 13 rotas operacionais para clientes com assinatura expirada', async () => {
    const operationalRoutes = [
      { method: 'GET', endpoint: '/api/cliente/salon', body: null },
      { method: 'PUT', endpoint: '/api/cliente/salon', body: { salonName: 'Tentativa de Escrita' } },
      { method: 'GET', endpoint: '/api/cliente/services', body: null },
      { method: 'POST', endpoint: '/api/cliente/services', body: { name: 'Corte Expirado', price: 60, duration_min: 30 } },
      { method: 'GET', endpoint: '/api/cliente/staff', body: null },
      { method: 'POST', endpoint: '/api/cliente/staff', body: { name: 'Profissional Expirado' } },
      { method: 'GET', endpoint: '/api/cliente/appointments', body: null },
      { method: 'POST', endpoint: '/api/cliente/appointments', body: { clientName: 'Fulana', clientPhone: '11999999999', date: '2030-01-01', time: '10:00' } },
      { method: 'POST', endpoint: '/api/cliente/whatsapp/connect-qr', body: {} },
      { method: 'POST', endpoint: '/api/cliente/whatsapp/connect-code', body: { phone: '11999999999' } },
      { method: 'POST', endpoint: '/api/cliente/whatsapp/disconnect', body: {} },
      { method: 'GET', endpoint: '/api/cliente/whatsapp/status', body: null },
      { method: 'GET', endpoint: '/api/cliente/pro/dashboard', body: null },
    ];

    for (const route of operationalRoutes) {
      const res = await apiRequest(route.method, route.endpoint, {
        token: TOKEN_EXPIRED,
        body: route.body,
      });

      assert.strictEqual(
        res.status,
        403,
        `Rota [${route.method} ${route.endpoint}] deveria ter retornado status 403 para cliente expirado, mas retornou ${res.status}. Resposta: ${JSON.stringify(res.data)}`
      );

      assert.strictEqual(res.data.success, false, `[${route.endpoint}] success deve ser false`);
      assert.strictEqual(res.data.code, 'SUBSCRIPTION_EXPIRED', `[${route.endpoint}] code deve ser SUBSCRIPTION_EXPIRED`);
      assert.strictEqual(res.data.subscriptionExpired, true, `[${route.endpoint}] subscriptionExpired deve ser true`);
      assert.ok(res.data.paidUntil, `[${route.endpoint}] deve retornar a data paidUntil do cliente`);
    }
  });

  test('2. Liberação estrita das rotas de autogestão da allowlist segura para clientes expirados', async () => {
    // 2.1 GET /api/cliente/profile
    const profRes = await apiRequest('GET', '/api/cliente/profile', { token: TOKEN_EXPIRED });
    assert.strictEqual(profRes.status, 200, 'GET /profile deve responder 200');
    assert.strictEqual(profRes.data.success, true);
    assert.strictEqual(profRes.data.profile.subscriptionExpired, true, 'Perfil deve sinalizar subscriptionExpired: true');

    // 2.2 GET /api/cliente/my-products
    const prodRes = await apiRequest('GET', '/api/cliente/my-products', { token: TOKEN_EXPIRED });
    assert.strictEqual(prodRes.status, 200, 'GET /my-products deve responder 200');
    assert.strictEqual(prodRes.data.success, true);
    assert.ok(Array.isArray(prodRes.data.subscriptions), 'Deve retornar lista de assinaturas');
    const jessicaSub = prodRes.data.subscriptions.find((s) => s.productCode === 'JESSICA');
    assert.ok(jessicaSub, 'Deve listar o produto JESSICA');
    assert.strictEqual(jessicaSub.isAccessActive, false, 'isAccessActive deve ser false para contrato expirado');

    // 2.3 GET /api/cliente/my-subscriptions
    const subRes = await apiRequest('GET', '/api/cliente/my-subscriptions', { token: TOKEN_EXPIRED });
    assert.strictEqual(subRes.status, 200, 'GET /my-subscriptions deve responder 200');
    assert.strictEqual(subRes.data.success, true);
    assert.ok(Array.isArray(subRes.data.subscriptions));

    // 2.4 GET /api/cliente/my-invoices
    const invRes = await apiRequest('GET', '/api/cliente/my-invoices', { token: TOKEN_EXPIRED });
    assert.strictEqual(invRes.status, 200, 'GET /my-invoices deve responder 200');
    assert.strictEqual(invRes.data.success, true);

    // 2.5 POST /api/cliente/auth/logout
    const logoutRes = await apiRequest('POST', '/api/cliente/auth/logout', { token: TOKEN_EXPIRED });
    assert.strictEqual(logoutRes.status, 200, 'POST /auth/logout deve responder 200');
    assert.strictEqual(logoutRes.data.success, true);
  });

  test('3. Liberação integral de rotas operacionais para clientes com assinatura ativa', async () => {
    const operationalRoutes = [
      { method: 'GET', endpoint: '/api/cliente/salon' },
      { method: 'GET', endpoint: '/api/cliente/services' },
      { method: 'GET', endpoint: '/api/cliente/staff' },
      { method: 'GET', endpoint: '/api/cliente/appointments' },
      { method: 'GET', endpoint: '/api/cliente/whatsapp/status' },
      { method: 'GET', endpoint: '/api/cliente/pro/dashboard' },
    ];

    for (const route of operationalRoutes) {
      const res = await apiRequest(route.method, route.endpoint, { token: TOKEN_ACTIVE });
      assert.strictEqual(
        res.status,
        200,
        `Rota operacional [${route.method} ${route.endpoint}] deveria retornar 200 para assinatura ativa, mas retornou ${res.status}.`
      );
      assert.strictEqual(res.data.success, true);
    }

    // Validação complementar: profile de cliente ativo não deve marcar assinatura expirada
    const profRes = await apiRequest('GET', '/api/cliente/profile', { token: TOKEN_ACTIVE });
    assert.strictEqual(profRes.status, 200);
    assert.strictEqual(profRes.data.profile.subscriptionExpired, false, 'subscriptionExpired deve ser false para ativo');
  });

  test('4. Liberação irrestrita para contas demo (is_demo = 1) mesmo com paid_until no passado', async () => {
    const demoRoutes = [
      { method: 'GET', endpoint: '/api/cliente/salon' },
      { method: 'GET', endpoint: '/api/cliente/services' },
      { method: 'GET', endpoint: '/api/cliente/staff' },
      { method: 'GET', endpoint: '/api/cliente/appointments' },
      { method: 'GET', endpoint: '/api/cliente/whatsapp/status' },
      { method: 'GET', endpoint: '/api/cliente/pro/dashboard' },
    ];

    for (const route of demoRoutes) {
      const res = await apiRequest(route.method, route.endpoint, { token: TOKEN_DEMO });
      assert.strictEqual(
        res.status,
        200,
        `Conta demo deveria acessar [${route.method} ${route.endpoint}] com status 200 mesmo expirada, mas retornou ${res.status}.`
      );
      assert.strictEqual(res.data.success, true);
    }

    const profRes = await apiRequest('GET', '/api/cliente/profile', { token: TOKEN_DEMO });
    assert.strictEqual(profRes.status, 200);
    assert.strictEqual(profRes.data.profile.subscriptionExpired, false, 'Conta demo não deve ser marcada como expirada');
  });

  test('5. Formatação do status no productService (effectiveStatus = EXPIRED)', () => {
    // 5.1 Usuário Expirado
    const expiredSubs = productService.getUserSubscriptions(userExpiredId);
    assert.ok(expiredSubs.length > 0, 'Deve retornar ao menos 1 assinatura');
    const expSub = expiredSubs[0];
    assert.strictEqual(expSub.status, 'ACTIVE', 'Status bruto no banco deve ser ACTIVE');
    assert.strictEqual(expSub.effectiveStatus, 'EXPIRED', 'effectiveStatus deve ser EXPIRED quando paid_until está no passado');
    assert.strictEqual(expSub.isAccessActive, false, 'isAccessActive deve ser false para expirado');

    // 5.2 Usuário Ativo
    const activeSubs = productService.getUserSubscriptions(userActiveId);
    assert.ok(activeSubs.length > 0);
    const actSub = activeSubs[0];
    assert.strictEqual(actSub.status, 'ACTIVE');
    assert.strictEqual(actSub.effectiveStatus, 'ACTIVE', 'effectiveStatus deve ser ACTIVE quando paid_until está no futuro');
    assert.strictEqual(actSub.isAccessActive, true, 'isAccessActive deve ser true para ativo');
  });
});
