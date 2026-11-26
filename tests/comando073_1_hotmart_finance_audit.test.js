'use strict';

/**
 * tests/comando073_1_hotmart_finance_audit.test.js
 *
 * Suíte Hermética de Testes de Homologação e Auditoria Financeira
 * Plataforma RAIA AGENTES — COMANDO 073.1
 *
 * Módulos nativos: node:test e node:assert/strict
 * Padrão Hermético: Banco de testes descartável em os.tmpdir() com destruição pós-execução.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

// ── 1. Isolamento Mandatório do Banco de Dados & Ambiente ───────────────────
const testDbName = `test_hotmart_audit_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
const testDbPath = path.join(os.tmpdir(), testDbName);

process.env.DB_PATH = testDbPath;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.NODE_ENV = 'test';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.STAGING_PASSWORD = 'staging_test_password_123';
process.env.STAGING_USER = 'raia-staging';
process.env.HOTMART_PRODUCT_ID = '8840376';
process.env.HOTMART_OFFER_START_CODE = 'gtt3rhpk';
process.env.HOTMART_OFFER_INTERMEDIATE_CODE = '1x8ik7i3';
process.env.HOTMART_OFFER_PRO_CODE = 'ytvdj943';
process.env.HOTMART_WEBHOOK_SECRET = 'hottok_secret_audit_test';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ASAAS_API_KEY = '$aact_test_sandbox_audit_mock_key';
process.env.ADMIN_PASSWORD = 'master_admin_password_audit_123';
process.env.ADMIN_API_KEY = 'admin_key_test_automation_123';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.SESSION_SECRET = '01234567890123456789012345678901';
process.env.MFA_ENCRYPTION_KEY = '01234567890123456789012345678901';

// Importação dos módulos da aplicação após isolamento de ambiente
const db = require('../src/database/db');
const hotmartService = require('../src/services/hotmartService');
const adminOverviewService = require('../src/services/adminOverviewService');
const salonDashboardService = require('../src/services/salonDashboardService');
const userService = require('../src/services/userService');
const { app } = require('../src/server/app');

// Limpeza garantida ao final de todos os testes
test.after(() => {
  try {
    if (typeof db.close === 'function') {
      try { db.close(); } catch (_) {}
    }
    const filesToClean = [
      testDbPath,
      `${testDbPath}-wal`,
      `${testDbPath}-shm`
    ];
    for (const f of filesToClean) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    }
  } catch (err) {
    console.warn('[Test Cleanup Warning] Falha ao remover arquivo temporário de teste:', err.message);
  }
});

// ── Cenário 1: Compra Hotmart Legítima nos 3 Planos Comerciais ──────────────
test('1. Compra Hotmart legítima nos 3 planos comerciais (Start, Intermediário e Pro)', async () => {
  const plansToTest = [
    {
      offer: 'gtt3rhpk',
      expectedTier: 'JESSICA_START',
      price: 89.0,
      priceCents: 8900,
      email: 'comprador_start@teste.com',
      phone: '5511999990001',
    },
    {
      offer: '1x8ik7i3',
      expectedTier: 'JESSICA_INTERMEDIATE',
      price: 109.0,
      priceCents: 10900,
      email: 'comprador_intermediate@teste.com',
      phone: '5511999990002',
    },
    {
      offer: 'ytvdj943',
      expectedTier: 'JESSICA_PRO',
      price: 139.0,
      priceCents: 13900,
      email: 'comprador_pro@teste.com',
      phone: '5511999990003',
    },
  ];

  for (const p of plansToTest) {
    const payload = {
      id: `EVT_PURCHASE_${p.expectedTier}_${Date.now()}`,
      creation_date: Date.now(),
      event: 'PURCHASE_APPROVED',
      data: {
        product: { id: '8840376' },
        purchase: {
          offer: { code: p.offer },
          price: { value: p.price },
          transaction: `HP_TX_${p.expectedTier}`,
        },
        buyer: {
          name: `Cliente ${p.expectedTier}`,
          email: p.email,
          checkout_phone: p.phone,
        },
        subscription: {
          subscriber_code: `SUB_${p.expectedTier}`,
          date_next_charge: Date.now() + 30 * 86400000,
        },
      },
    };

    const result = await hotmartService.processWebhook(payload);
    assert.equal(result.success, true, `Webhook de compra deve ser processado com sucesso para ${p.expectedTier}`);
    assert.equal(result.planTier, p.expectedTier, `Plano identificado deve ser ${p.expectedTier}`);

    // Validação na tabela users
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(p.email);
    assert.ok(user, `Usuário deve existir na tabela users para ${p.email}`);
    assert.equal(user.plan_tier, p.expectedTier, `User plan_tier deve ser ${p.expectedTier}`);
    assert.equal(user.hotmart_product_id, '8840376', 'hotmart_product_id deve ser 8840376');
    assert.ok(user.paid_until !== null, 'Vigência paga deve ser preenchida');

    // Validação na tabela customer_subscriptions
    const sub = db.prepare(`
      SELECT * FROM customer_subscriptions
      WHERE user_id = ? AND origin = 'HOTMART'
    `).get(user.id);

    assert.ok(sub, `customer_subscriptions deve conter registro para ${p.expectedTier}`);
    assert.equal(sub.status, 'ACTIVE', 'Assinatura deve estar ACTIVE');
    assert.equal(sub.price_cents, p.priceCents, `price_cents deve ser ${p.priceCents}`);
    assert.equal(sub.origin, 'HOTMART', 'origin deve ser HOTMART');
    assert.equal(sub.gateway, 'HOTMART', 'gateway deve ser HOTMART');
  }
});

// ── Cenário 2: Rejeição Fail-Closed para product.id Ausente ou Divergente ────
test('2. Teste negativo fail-closed para product.id ausente ou divergente', async () => {
  // A. product.id ausente
  const payloadNoProd = {
    id: 'EVT_FAIL_NO_PRODUCT_ID',
    creation_date: Date.now(),
    event: 'PURCHASE_APPROVED',
    data: {
      purchase: {
        offer: { code: 'ytvdj943' },
        price: { value: 139.0 },
        transaction: 'TX_FAIL_NO_PROD',
      },
      buyer: {
        email: 'invasor_sem_prod@teste.com',
        name: 'Tentativa Invasão',
        checkout_phone: '5511999991111',
      },
    },
  };

  const resNoProd = await hotmartService.processWebhook(payloadNoProd);
  assert.equal(resNoProd.success, false, 'Deve rejeitar com success: false');
  assert.equal(resNoProd.ignored, true, 'Deve indicar ignored: true');
  assert.equal(resNoProd.reason, 'INVALID_OR_MISSING_PRODUCT_ID');

  const userNoProd = db.prepare('SELECT * FROM users WHERE email = ?').get('invasor_sem_prod@teste.com');
  assert.equal(userNoProd, undefined, 'Nenhum usuário deve ser criado para produto ausente');

  // B. product.id divergente ('9999999') em SWITCH_PLAN
  const payloadBadProd = {
    id: 'EVT_FAIL_BAD_PRODUCT_ID',
    creation_date: Date.now(),
    event: 'SWITCH_PLAN',
    data: {
      product: { id: '9999999' },
      purchase: {
        offer: { code: 'ytvdj943' },
        price: { value: 139.0 },
        transaction: 'TX_FAIL_BAD_PROD',
      },
      buyer: {
        email: 'invasor_bad_prod@teste.com',
        name: 'Tentativa Produto Falso',
        checkout_phone: '5511999992222',
      },
    },
  };

  const resBadProd = await hotmartService.processWebhook(payloadBadProd);
  assert.equal(resBadProd.success, false);
  assert.equal(resBadProd.ignored, true);
  assert.equal(resBadProd.reason, 'INVALID_OR_MISSING_PRODUCT_ID');

  const userBadProd = db.prepare('SELECT * FROM users WHERE email = ?').get('invasor_bad_prod@teste.com');
  assert.equal(userBadProd, undefined, 'Nenhum usuário deve ser criado para produto divergente');
});

// ── Cenário 3: Rejeição Fail-Closed para Oferta ou Plano Desconhecido ────────
test('3. Teste negativo fail-closed para oferta ou plano desconhecido', async () => {
  const payloadUnknown = {
    id: 'EVT_FAIL_UNKNOWN_OFFER',
    creation_date: Date.now(),
    event: 'PURCHASE_APPROVED',
    data: {
      product: { id: '8840376' },
      purchase: {
        offer: { code: 'oferta_desconhecida_xyz' },
        price: { value: 10.0 },
        transaction: 'TX_FAIL_UNKNOWN_OFFER',
      },
      plan: { id: 'plano_inexistente' },
      buyer: {
        email: 'comprador_desconhecido@teste.com',
        name: 'Oferta Estranha',
        checkout_phone: '5511999993333',
      },
    },
  };

  const resUnknown = await hotmartService.processWebhook(payloadUnknown);
  assert.equal(resUnknown.success, false);
  assert.equal(resUnknown.ignored, true);
  assert.equal(resUnknown.reason, 'UNKNOWN_OR_INVALID_PLAN_TIER');

  const userUnknown = db.prepare('SELECT * FROM users WHERE email = ?').get('comprador_desconhecido@teste.com');
  assert.equal(userUnknown, undefined, 'Nenhum usuário deve ser criado para oferta desconhecida');
});

// ── Cenário 4: Idempotência e Prevenção de Duplicação Financeira ─────────────
test('4. Idempotência e prevenção de duplicação financeira em getAdminOverviewMetrics', async () => {
  const payloadIdemp = {
    id: 'EVT_IDEMP_TEST_STRICT_01',
    creation_date: Date.now(),
    event: 'PURCHASE_APPROVED',
    data: {
      product: { id: '8840376' },
      purchase: {
        offer: { code: 'ytvdj943' },
        price: { value: 139.0 },
        transaction: 'HP_TX_IDEMP_AUDIT_STRICT',
      },
      buyer: {
        email: 'idemp_auditoria@teste.com',
        name: 'Cliente Idempotente',
        checkout_phone: '5511999994444',
      },
      subscription: {
        subscriber_code: 'SUB_IDEMP_AUDIT',
        date_next_charge: Date.now() + 30 * 86400000,
      },
    },
  };

  // Primeira transmissão
  const res1 = await hotmartService.processWebhook(payloadIdemp);
  assert.equal(res1.success, true);

  const metricsFirst = adminOverviewService.getAdminOverviewMetrics();
  const grossBefore = metricsFirst.summary.grossRevenueCents;
  assert.ok(grossBefore > 0, 'Receita bruta deve ser maior que zero');

  // Transmissão duplicada com o mesmo event_id
  const resDupEvent = await hotmartService.processWebhook(payloadIdemp);
  assert.equal(resDupEvent.success, true);
  assert.equal(resDupEvent.duplicated, true, 'Deve identificar duplicação de event_id');

  // Redeliberação com NOVO event_id mas com a MESMA transação
  const payloadRedelivered = {
    ...payloadIdemp,
    id: 'EVT_IDEMP_TEST_STRICT_02_REDELIVERED',
    creation_date: Date.now() + 1000,
  };
  await hotmartService.processWebhook(payloadRedelivered);

  // Validação estrita de métricas: a receita consolidada NÃO deve duplicar valores
  const metricsSecond = adminOverviewService.getAdminOverviewMetrics();
  assert.equal(
    metricsSecond.summary.grossRevenueCents,
    grossBefore,
    'A receita bruta em getAdminOverviewMetrics deve ser deduplicada por transaction_code'
  );
});

// ── Cenário 5: Reembolso e Chargeback (Revogação & Dedução Contábil) ─────────
test('5. Reembolso e Chargeback: revogação de acesso e dedução contábil exata', async () => {
  // A. Registrar compra para posterior reembolso
  const payloadForRefund = {
    id: 'EVT_APPROVED_FOR_REFUND_TEST',
    creation_date: Date.now() - 5000,
    event: 'PURCHASE_APPROVED',
    data: {
      product: { id: '8840376' },
      purchase: {
        offer: { code: '1x8ik7i3' },
        price: { value: 109.0 },
        transaction: 'HP_TX_TARGET_FOR_REFUND',
      },
      buyer: {
        email: 'cliente_para_reembolso@teste.com',
        name: 'Cliente Reembolsado',
        checkout_phone: '5511999995555',
      },
      subscription: {
        subscriber_code: 'SUB_TARGET_FOR_REFUND',
        date_next_charge: Date.now() + 30 * 86400000,
      },
    },
  };

  await hotmartService.processWebhook(payloadForRefund);

  const userPreRefund = db.prepare('SELECT * FROM users WHERE email = ?').get('cliente_para_reembolso@teste.com');
  assert.ok(userPreRefund.paid_until !== null, 'paid_until deve estar preenchido antes do reembolso');

  const metricsBeforeRefund = adminOverviewService.getAdminOverviewMetrics();
  const deductionsBefore = metricsBeforeRefund.summary.deductionsCents;

  // B. Processar evento PURCHASE_REFUNDED
  const payloadRefund = {
    id: 'EVT_PROCESS_REFUND_EVENT',
    creation_date: Date.now(),
    event: 'PURCHASE_REFUNDED',
    data: {
      product: { id: '8840376' },
      purchase: {
        transaction: 'HP_TX_TARGET_FOR_REFUND',
      },
      buyer: {
        email: 'cliente_para_reembolso@teste.com',
      },
      subscription: {
        subscriber_code: 'SUB_TARGET_FOR_REFUND',
      },
    },
  };

  const resRefund = await hotmartService.processWebhook(payloadRefund);
  assert.equal(resRefund.success, true);
  assert.equal(resRefund.action, 'ACCESS_REVOKED');

  // Verificar revogação estrita no usuário
  const userPostRefund = db.prepare('SELECT * FROM users WHERE email = ?').get('cliente_para_reembolso@teste.com');
  assert.equal(userPostRefund.subscription_status, 'REFUNDED', 'Status deve ser REFUNDED');
  assert.equal(userPostRefund.paid_until, null, 'paid_until deve ser revogado para NULL');

  // Verificar atualização em customer_subscriptions
  const subPostRefund = db.prepare('SELECT * FROM customer_subscriptions WHERE user_id = ?').get(userPostRefund.id);
  assert.equal(subPostRefund.status, 'REFUNDED', 'Subscription deve estar REFUNDED');
  assert.equal(subPostRefund.paid_until, null, 'Subscription paid_until deve ser NULL');

  // Verificar dedução contábil em getAdminOverviewMetrics
  const metricsPostRefund = adminOverviewService.getAdminOverviewMetrics();
  assert.equal(
    metricsPostRefund.summary.deductionsCents,
    deductionsBefore + 10900,
    'Deduções devem computar exatamente os R$ 109,00 reembolsados'
  );
  assert.equal(
    metricsPostRefund.summary.confirmedRevenueCents,
    metricsPostRefund.summary.grossRevenueCents - metricsPostRefund.summary.deductionsCents,
    'Receita líquida confirmada deve deduzir o valor reembolsado'
  );
});

// ── Cenário 6: Central de Clientes Sem Duplicidade ──────────────────────────
test('6. Central de Clientes sem duplicidade: cliente com múltiplos contratos aparece 1 vez', () => {
  // Criar um cliente novo
  const created = userService.getOrCreateUser({
    phoneNumber: '5511999996666',
    name: 'Cliente Contratos Multiplos',
  });
  const clientUser = created.user;

  const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const plan = db.prepare('SELECT id FROM product_plans WHERE product_id = ? LIMIT 1').get(jessica.id);

  // Inserir histórico: 1 cancelada anterior + 1 reembolsada anterior + 1 ativa atual
  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents, setup_fee_cents, billing_cycle, contracted_at
    ) VALUES (?, ?, ?, 'HOTMART', 'HOTMART', 'CANCELLED', 8900, 0, 'MONTHLY', datetime('now', '-60 days'))
  `).run(clientUser.id, jessica.id, plan.id);

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents, setup_fee_cents, billing_cycle, contracted_at
    ) VALUES (?, ?, ?, 'HOTMART', 'HOTMART', 'REFUNDED', 10900, 0, 'MONTHLY', datetime('now', '-30 days'))
  `).run(clientUser.id, jessica.id, plan.id);

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents, setup_fee_cents, billing_cycle, contracted_at
    ) VALUES (?, ?, ?, 'HOTMART', 'HOTMART', 'ACTIVE', 13900, 0, 'MONTHLY', datetime('now'))
  `).run(clientUser.id, jessica.id, plan.id);

  const clientList = adminOverviewService.getAdminClientsList({ search: 'Cliente Contratos Multiplos' });
  assert.equal(clientList.length, 1, 'Cliente com 3 contratos deve aparecer exatamente 1 vez na lista consolidada');
  assert.equal(clientList[0].clientId, clientUser.id);
  assert.equal(clientList[0].subscriptionStatus, 'ACTIVE', 'Deve priorizar a assinatura de status ACTIVE');
});

// ── Cenário 7: Clientes Sem Origem Comprovada ────────────────────────────────
test("7. Clientes sem origem comprovada: exibem 'NÃO IDENTIFICADO' sem forçar 'HOTMART'", () => {
  const created = userService.getOrCreateUser({
    phoneNumber: '5511999997777',
    name: 'Cliente Orfao Sem Assinatura',
  });
  const orphanUser = created.user;

  // Consulta individual na listagem
  const clients = adminOverviewService.getAdminClientsList({ search: 'Cliente Orfao Sem Assinatura' });
  assert.equal(clients.length, 1);
  assert.equal(clients[0].channel, 'NÃO IDENTIFICADO', 'Canal deve ser estritamente NÃO IDENTIFICADO');

  // Consulta agregada por canal nas métricas
  const metrics = adminOverviewService.getAdminOverviewMetrics();
  const unk = metrics.clientsByChannel.find(c => c.channel === 'NÃO IDENTIFICADO');
  assert.ok(unk, "Deve existir grupo 'NÃO IDENTIFICADO' em clientsByChannel");
  assert.ok(unk.count >= 1, "Contagem do grupo 'NÃO IDENTIFICADO' deve ser >= 1");
});

// ── Cenário 8: Proteção da Rota /api/admin/overview e /api/admin/clients-consolidated
test('8. Proteção da rota /api/admin/overview e /api/admin/clients-consolidated (401/403/200)', async () => {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 8.1 Requisição anônima (sem auth) -> 401
    const resNoAuth = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { 'x-staging-key': 'staging_test_password_123' },
    });
    assert.equal(resNoAuth.status, 401, 'Requisição anônima deve ser barrada com 401');

    // 8.2 Requisição com token de usuário comum (role != ADMIN) -> 403
    const regularUser = userService.getOrCreateUser({ phoneNumber: '5511999998888', name: 'Usuario Comum' }).user;
    const { sessionToken: regularToken } = userService.createUserSession(regularUser.id, 1, { mfaVerified: false });
    const resRegular = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: {
        'x-staging-key': 'staging_test_password_123',
        Authorization: `Bearer ${regularToken}`,
      },
    });
    assert.equal(resRegular.status, 403, 'Usuário com role != ADMIN deve ser barrado com 403');

    // 8.3 Requisição com x-admin-key (automação sem sessão interativa) -> 403
    const resApiKey = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: {
        'x-staging-key': 'staging_test_password_123',
        'x-admin-key': 'admin_key_test_automation_123',
      },
    });
    assert.equal(resApiKey.status, 403, 'API Key de automação deve ser barrada com 403 por exigir sessão interativa');

    // 8.4 Requisição com Admin com sessão MAS sem MFA verificado -> 403
    const masterAdmin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1").get();
    const { sessionToken: adminNoMfaToken } = userService.createUserSession(masterAdmin.id, 1, { mfaVerified: false });
    const resAdminNoMfa = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: {
        'x-staging-key': 'staging_test_password_123',
        Authorization: `Bearer ${adminNoMfaToken}`,
      },
    });
    assert.equal(resAdminNoMfa.status, 403, 'Admin sem MFA verificado deve ser barrado com 403');

    // 8.5 Requisição legítima: Admin com sessão E MFA verificado -> 200 OK
    const { sessionToken: adminMfaToken } = userService.createUserSession(masterAdmin.id, 1, { mfaVerified: true });
    const resAdminOk = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: {
        'x-staging-key': 'staging_test_password_123',
        Authorization: `Bearer ${adminMfaToken}`,
      },
    });
    assert.equal(resAdminOk.status, 200, 'Admin com MFA verificado deve receber 200 OK');
    const dataOverview = await resAdminOk.json();
    assert.equal(dataOverview.success, true);
    assert.ok(dataOverview.summary);

    // 8.6 Validação também na rota /api/admin/clients-consolidated -> 200 OK
    const resClientsOk = await fetch(`${baseUrl}/api/admin/clients-consolidated`, {
      headers: {
        'x-staging-key': 'staging_test_password_123',
        Authorization: `Bearer ${adminMfaToken}`,
      },
    });
    assert.equal(resClientsOk.status, 200, 'Admin com MFA deve receber 200 em clients-consolidated');
    const dataClients = await resClientsOk.json();
    assert.equal(dataClients.success, true);
    assert.ok(Array.isArray(dataClients.clients));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── Cenário 9: Preservação dos Fluxos Operacionais do Salão ─────────────────
test('9. Preservação dos fluxos operacionais do salão: agendamentos, serviços, despesas e salonDashboardService', async () => {
  const salonOwner = userService.getOrCreateUser({
    phoneNumber: '5511999999999',
    name: 'Proprietaria Salao Audit',
  }).user;

  // Inserir salão
  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, address, whatsapp_phone)
    VALUES (?, 'Salão Studio Prime Audit', 'Av. Paulista 1000', '5511999999999')
  `).run(salonOwner.id);

  // Inserir serviço do salão
  db.prepare(`
    INSERT INTO client_services (user_id, name, price, duration_min, active)
    VALUES (?, 'Design de Sobrancelhas', 60.0, 30, 1)
  `).run(salonOwner.id);

  // Inserir agendamento operacional
  db.prepare(`
    INSERT INTO appointments (user_id, title, client_name, client_phone, start_datetime, end_datetime, status)
    VALUES (?, 'Design de Sobrancelhas', 'Cliente VIP Salão', '5511911112222', datetime('now', '+1 hour'), datetime('now', '+2 hours'), 'CONFIRMADO')
  `).run(salonOwner.id);

  // Inserir despesa operacional via salonDashboardService
  const expResult = salonDashboardService.recordTransaction(salonOwner.id, {
    type: 'EXPENSE',
    amount: 45.0,
    category: 'Insumos',
    description: 'Produtos de coloração',
  });
  assert.ok(expResult, 'Transação de despesa deve ser registrada com sucesso');

  // Invocar motor analítico do salão
  const dashboard = await salonDashboardService.getSalonDashboard(salonOwner.id, { period: 'this_month' });
  assert.ok(dashboard, 'salonDashboardService.getSalonDashboard deve responder com integridade');
  assert.ok(dashboard.metrics, 'Estrutura metrics deve estar presente');
  assert.equal(typeof dashboard.metrics.totalAppointments, 'number');
  assert.equal(typeof dashboard.metrics.totalRevenue, 'number');
  assert.ok(Array.isArray(dashboard.services), 'services deve ser um array');
});
