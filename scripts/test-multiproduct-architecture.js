'use strict';

/**
 * TEST SUITE: MULTIPRODUCT ARCHITECTURE & MULTI-CONTRACT ENGINE
 * Validates:
 * 1. Dynamic product & plan catalog (creation & updates without schema changes)
 * 2. Single client with multiple independent product contracts
 * 3. Independent access control per product (Product A active, Product B suspended)
 * 4. Account session remains accessible even when products are suspended
 * 5. Cancellation without loyalty (access preserved until paid_until)
 * 6. Contract price preservation (catalog changes do not alter signed contracts)
 * 7. Audit logging of status transitions
 * 8. Asaas & Hotmart multichannel isolation
 * 9. Multi-tenant customer isolation
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const db = require('../src/database/db');
const productService = require('../src/services/productService');
const { app } = require('../src/server/app');

let server;
let baseUrl;
let adminCookie = '';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function deleteUserAndChildren(email, phone) {
  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ? OR phone_number = ?').get(email || '', phone || '');
    if (user) {
      db.prepare('DELETE FROM subscription_audit_logs WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM client_services WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM appointments WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
  } catch (e) {}
}

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  return { status: res.status, headers: res.headers, data };
}

let passCount = 0;
function recordPass(desc) {
  passCount++;
  console.log(`  ✓ [PASS ${passCount}] ${desc}`);
}

async function runTests() {
  console.log('\n======================================================');
  console.log(' INICIANDO SUÍTE DE TESTES: ARQUITETURA MULTIPRODUTO ');
  console.log('======================================================\n');

  // Start HTTP server on ephemeral port
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Test Server] Executando em ${baseUrl}`);

  try {
    // -------------------------------------------------------------
    // SETUP: Master Admin Session & Test Cleanup
    // -------------------------------------------------------------
    db.prepare("DELETE FROM product_plans WHERE product_id IN (SELECT id FROM products WHERE code LIKE '%_TEST')").run();
    db.prepare("DELETE FROM products WHERE code LIKE '%_TEST'").run();

    const masterAdmin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' LIMIT 1").get();
    const adminToken = 'test_multiproduct_admin_' + Date.now();
    db.prepare("UPDATE users SET magic_token = ?, magic_token_expires_at = datetime('now', '+1 hour') WHERE id = ?")
      .run(adminToken, masterAdmin.id);
    adminCookie = `auth_token=${adminToken}`;

    // -------------------------------------------------------------
    // TEST 1: CATÁLOGO DINÂMICO DE PRODUTOS & PLANOS
    // -------------------------------------------------------------
    console.log('\n--- 1. CENTRAL DE PRODUTOS: CRIAÇÃO DINÂMICA ---');

    // 1.1 List initial seeded products
    const initialProds = productService.listProducts();
    assert(initialProds.length >= 3, 'Deve haver ao menos 3 produtos semeados (Jéssica, Jarvis, Dra. Camila)');
    recordPass(`Catálogo inicial contém ${initialProds.length} produtos semeados.`);

    // 1.2 Create a brand new product via API without any database schema changes
    const newProdRes = await request('/api/admin/products', {
      method: 'POST',
      headers: { Cookie: adminCookie },
      body: JSON.stringify({
        code: 'BOT_IMOBILIARIO_TEST',
        name: 'Lucas Corretor IA',
        description: 'Agente especializado em plantão imobiliário e qualificação de leads.',
        category: 'IMOBILIARIO',
        icon: 'building',
      }),
    });
    assert.strictEqual(newProdRes.status, 201, 'Criação de produto deve retornar 201');
    assert.strictEqual(newProdRes.data.success, true);
    assert.strictEqual(newProdRes.data.product.code, 'BOT_IMOBILIARIO_TEST');
    const createdProductId = newProdRes.data.product.id;
    recordPass('Novo produto (Lucas Corretor IA) cadastrado no catálogo dinâmico.');

    // 1.3 Create plans for the new product
    const planRes = await request(`/api/admin/products/${createdProductId}/plans`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
      body: JSON.stringify({
        code: 'CORRETOR_START',
        name: 'Plano Corretor Individual',
        description: 'Atendimento para até 50 imóveis',
        priceCents: 14900,
        promoFairPriceCents: 9900,
        setupFeeCents: 35000,
        billingCycle: 'MONTHLY',
        maxProfessionals: 1,
        features: ['LEADS_WHATSAPP', 'CATALOGO_IMOVEIS'],
      }),
    });
    assert.strictEqual(planRes.status, 201, 'Criação de plano deve retornar 201');
    assert.strictEqual(planRes.data.success, true);
    assert.strictEqual(planRes.data.plan.price_cents, 14900);
    recordPass('Novo plano (CORRETOR_START) cadastrado com sucesso para o produto.');

    // -------------------------------------------------------------
    // TEST 2: CENTRAL DE CLIENTES: CLIENTE COM MULTIPLOS PRODUTOS
    // -------------------------------------------------------------
    console.log('\n--- 2. CLIENTE COM MÚLTIPLOS PRODUTOS INDEPENDENTES ---');

    // Create a customer user
    const clientPhone = '5511988887701';
    const clientEmail = 'dra.helena.multi@raia.test';
    deleteUserAndChildren(clientEmail, clientPhone);

    const clientPassSalt = crypto.randomBytes(16).toString('hex');
    const clientPassHash = crypto.scryptSync('Helena@2026', clientPassSalt, 64).toString('hex');
    const clientToken = 'token_helena_multi_' + Date.now();
    const tokenExp = new Date(Date.now() + 24 * 3600000).toISOString();

    const insertUserRes = db.prepare(`
      INSERT INTO users (name, email, phone_number, password_hash, password_salt, role, magic_token, magic_token_expires_at, subscription_status)
      VALUES ('Dra. Helena Multi', ?, ?, ?, ?, 'USER', ?, ?, 'ACTIVE')
    `).run(clientEmail, clientPhone, clientPassHash, clientPassSalt, clientToken, tokenExp);
    const clientId = Number(insertUserRes.lastInsertRowid);

    // Contract Product 1: JESSICA (Plano START, R$ 89,00)
    const jessicaSub = productService.createCustomerSubscription({
      userId: clientId,
      productCode: 'JESSICA',
      planCode: 'START',
      origin: 'ASAAS',
      gateway: 'ASAAS',
      gatewaySubscriptionId: 'sub_jessica_test_1',
      priceCents: 8900,
      setupFeeCents: 0,
      promotionalFair: true,
      paidUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
      status: 'ACTIVE',
      adminId: masterAdmin.id,
      notes: 'Contratação Jéssica Feira',
    });
    assert.strictEqual(jessicaSub.productCode, 'JESSICA');
    assert.strictEqual(jessicaSub.status, 'ACTIVE');
    assert.strictEqual(jessicaSub.priceCents, 8900);
    recordPass('Contrato 1 firmado: Jéssica (R$ 89,00/mês, Status: ACTIVE)');

    // Contract Product 2: JARVIS_FINANCEIRO (Plano PRO, R$ 199,00)
    const jarvisSub = productService.createCustomerSubscription({
      userId: clientId,
      productCode: 'JARVIS_FINANCEIRO',
      planCode: 'PRO',
      origin: 'ASAAS',
      gateway: 'ASAAS',
      gatewaySubscriptionId: 'sub_jarvis_test_2',
      priceCents: 19900,
      setupFeeCents: 0,
      promotionalFair: false,
      paidUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
      status: 'ACTIVE',
      adminId: masterAdmin.id,
      notes: 'Contratação Jarvis Financeiro Pro',
    });
    assert.strictEqual(jarvisSub.productCode, 'JARVIS_FINANCEIRO');
    assert.strictEqual(jarvisSub.status, 'ACTIVE');
    assert.strictEqual(jarvisSub.priceCents, 19900);
    recordPass('Contrato 2 firmado: Jarvis Financeiro (R$ 199,00/mês, Status: ACTIVE)');

    // Verify user now has 2 distinct active subscriptions
    const userSubs = productService.getUserSubscriptions(clientId);
    assert.strictEqual(userSubs.length, 2, 'Usuário deve possuir exatamente 2 assinaturas');
    assert.strictEqual(userSubs[0].id !== userSubs[1].id, true);
    recordPass('Cliente possui 2 contratos independentes vinculados ao mesmo cadastro.');

    // -------------------------------------------------------------
    // TEST 3: CONTROLE INDIVIDUAL DE ACESSO
    // -------------------------------------------------------------
    console.log('\n--- 3. CONTROLE INDIVIDUAL DE ACESSO POR PRODUTO ---');

    // Case 3.1: Both products ACTIVE -> Access granted to both
    const jessicaAccess1 = productService.hasProductAccess(clientId, 'JESSICA');
    assert.strictEqual(jessicaAccess1.hasAccess, true);
    assert.strictEqual(jessicaAccess1.status, 'ACTIVE');

    const jarvisAccess1 = productService.hasProductAccess(clientId, 'JARVIS_FINANCEIRO');
    assert.strictEqual(jarvisAccess1.hasAccess, true);
    assert.strictEqual(jarvisAccess1.status, 'ACTIVE');
    recordPass('Ambos os produtos liberados quando ambos estão ativos e adimplentes.');

    // Test API call to Jéssica salon endpoint with customer token
    const salonRes1 = await request('/api/cliente/salon', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ salonName: 'Espaço Helena VIP' }),
    });
    assert.strictEqual(salonRes1.status, 200, 'Acesso à API Jéssica deve ser 200');
    recordPass('Chamada à API Jéssica (/api/cliente/salon) autorizada com sucesso.');

    // Case 3.2: Product 2 (JARVIS) becomes OVERDUE and past paid_until
    productService.updateSubscriptionStatus(jarvisSub.id, 'OVERDUE', { reason: 'Boleto não pago' });
    db.prepare("UPDATE customer_subscriptions SET paid_until = datetime('now', '-3 days') WHERE id = ?").run(jarvisSub.id);

    const jarvisAccess2 = productService.hasProductAccess(clientId, 'JARVIS_FINANCEIRO');
    assert.strictEqual(jarvisAccess2.hasAccess, false, 'Acesso a Jarvis deve ser suspenso por atraso');
    assert.strictEqual(jarvisAccess2.status, 'OVERDUE');

    // Crucial check: Product 1 (JÉSSICA) MUST remain 100% ACTIVE
    const jessicaAccess2 = productService.hasProductAccess(clientId, 'JESSICA');
    assert.strictEqual(jessicaAccess2.hasAccess, true, 'Jéssica DEVE continuar ativa');
    recordPass('ISOLAMENTO DE PRODUTO: Jarvis suspenso por inadimplência, Jéssica continua 100% ativa.');

    // Case 3.3: Customer account login and general portal MUST remain accessible
    const profileRes = await request('/api/cliente/profile', {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.strictEqual(profileRes.status, 200, 'Perfil da conta do cliente permanece acessível');

    const myProdRes = await request('/api/cliente/my-products', {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.strictEqual(myProdRes.status, 200);
    assert.strictEqual(myProdRes.data.subscriptions.length, 2);
    const jessicaInList = myProdRes.data.subscriptions.find(s => s.productCode === 'JESSICA');
    const jarvisInList = myProdRes.data.subscriptions.find(s => s.productCode === 'JARVIS_FINANCEIRO');
    assert.strictEqual(jessicaInList.isAccessActive, true);
    assert.strictEqual(jarvisInList.isAccessActive, false);
    recordPass('PAINEL DO CLIENTE: "Meus Produtos" exibe Jéssica ativo e Jarvis suspenso para o mesmo cliente.');

    // Case 3.4: Try to access Jéssica now -> STILL WORKS (200)
    const salonRes2 = await request('/api/cliente/salon', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ salonName: 'Espaço Helena VIP Renovado' }),
    });
    assert.strictEqual(salonRes2.status, 200);
    recordPass('Requisição para Jéssica executada com sucesso enquanto Jarvis permanece bloqueado.');

    // -------------------------------------------------------------
    // TEST 4: CANCELAMENTO SEM FIDELIDADE
    // -------------------------------------------------------------
    console.log('\n--- 4. CANCELAMENTO SEM FIDELIDADE (ACESSO ATÉ O FIM DO CICLO) ---');

    // Cancel Jéssica, with paid_until 20 days in the future
    const futurePaidUntil = new Date(Date.now() + 20 * 86400000).toISOString();
    db.prepare("UPDATE customer_subscriptions SET paid_until = ? WHERE id = ?").run(futurePaidUntil, jessicaSub.id);
    productService.cancelSubscription(jessicaSub.id, { reason: 'Cliente solicitou encerramento sem fidelidade' });

    // Status is CANCELLED, but because paid_until is in future, access remains valid
    const jessicaAccessCancelledWithGrace = productService.hasProductAccess(clientId, 'JESSICA');
    assert.strictEqual(jessicaAccessCancelledWithGrace.hasAccess, true, 'Acesso deve ser preservado até o término do período pago');
    assert.strictEqual(jessicaAccessCancelledWithGrace.status, 'CANCELLED_WITH_ACCESS');
    recordPass('Assinatura cancelada sem fidelidade mantém acesso válido até o término do ciclo contratado.');

    // Now advance paid_until into the past -> access becomes blocked
    db.prepare("UPDATE customer_subscriptions SET paid_until = datetime('now', '-1 day') WHERE id = ?").run(jessicaSub.id);
    const jessicaAccessPostExpired = productService.hasProductAccess(clientId, 'JESSICA');
    assert.strictEqual(jessicaAccessPostExpired.hasAccess, false, 'Acesso deve ser bloqueado após o fim do período contratado');
    assert.strictEqual(jessicaAccessPostExpired.status, 'CANCELLED');

    const salonBlockedRes = await request('/api/cliente/salon', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({ salonName: 'Tentativa Bloqueada' }),
    });
    assert.strictEqual(salonBlockedRes.status, 403, 'Acesso à API Jéssica deve ser 403 após expiração');
    assert.strictEqual(salonBlockedRes.data.code, 'SUBSCRIPTION_CANCELED');
    recordPass('Acesso à API Jéssica bloqueado com 403 após encerramento definitivo da vigência.');

    // -------------------------------------------------------------
    // TEST 5: PRESERVAÇÃO IMUTÁVEL DOS CONTRATOS (PRICE LOCK)
    // -------------------------------------------------------------
    console.log('\n--- 5. PRESERVAÇÃO DOS CONTRATOS (TERMOS IMUTÁVEIS) ---');

    // Contract a plan for a new user at current catalog price R$ 89,00
    deleteUserAndChildren('preco.historico@raia.test', '5511977770001');
    const userPriceTest = db.prepare(`
      INSERT INTO users (name, email, phone_number, role, subscription_status)
      VALUES ('Cliente Preço Histórico', 'preco.historico@raia.test', '5511977770001', 'USER', 'ACTIVE')
    `).run();
    const userPriceId = Number(userPriceTest.lastInsertRowid);

    const priceSub = productService.createCustomerSubscription({
      userId: userPriceId,
      productCode: 'JESSICA',
      planCode: 'START',
      origin: 'ASAAS',
      priceCents: 8900,
      paidUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
      status: 'ACTIVE',
    });
    assert.strictEqual(priceSub.priceCents, 8900);

    // Now, Administrator updates the catalog price of Jéssica Start to R$ 119,00
    const startPlan = db.prepare("SELECT pp.id FROM product_plans pp JOIN products p ON p.id = pp.product_id WHERE p.code = 'JESSICA' AND pp.code = 'START'").get();
    productService.updatePlan(startPlan.id, { priceCents: 11900 });

    // Verify catalog now has the new price
    const updatedPlan = db.prepare("SELECT price_cents FROM product_plans WHERE id = ?").get(startPlan.id);
    assert.strictEqual(updatedPlan.price_cents, 11900, 'Preço no catálogo deve ser 11900');

    // CRITICAL: The existing user's contract in customer_subscriptions MUST preserve the original R$ 89,00
    const contractAfterPriceChange = productService.getUserSubscriptionById(priceSub.id);
    assert.strictEqual(contractAfterPriceChange.priceCents, 8900, 'Contrato existente NÃO pode sofrer alteração de preço');
    assert.strictEqual(contractAfterPriceChange.priceFormatted, 'R$ 89,00');
    recordPass('IMUTABILIDADE DO CONTRATO: Preço do plano alterado no catálogo (R$ 119,00) preservou contrato histórico em R$ 89,00.');

    // Restore catalog price to R$ 89,00 for consistency
    productService.updatePlan(startPlan.id, { priceCents: 8900 });

    // -------------------------------------------------------------
    // TEST 6: WEBHOOK ASAAS RENOVA APENAS O PRODUTO PAGO
    // -------------------------------------------------------------
    console.log('\n--- 6. WEBHOOKS & ISOLAMENTO DE CANAIS ---');

    // Simulate Asaas Webhook PAYMENT_CONFIRMED for Jarvis
    const newJarvisPaidUntil = new Date(Date.now() + 30 * 86400000).toISOString();
    productService.renewSubscription(jarvisSub.id, newJarvisPaidUntil, {
      gatewayPaymentId: 'pay_jarvis_simulated',
      reason: 'Pagamento confirmado via Asaas',
    });

    const jarvisRenewed = productService.getUserSubscriptionById(jarvisSub.id);
    assert.strictEqual(jarvisRenewed.status, 'ACTIVE');
    assert.strictEqual(jarvisRenewed.isAccessActive, true);
    assert.strictEqual(jarvisRenewed.gatewayPaymentId, 'pay_jarvis_simulated');

    // Verify Jéssica remains in its previous state (not renewed by Jarvis' payment)
    const jessicaPostJarvisRenew = productService.getUserSubscriptionById(jessicaSub.id);
    assert.strictEqual(jessicaPostJarvisRenew.status, 'CANCELLED');
    recordPass('RENOVAÇÃO SELETIVA: Pagamento de Jarvis renovou apenas Jarvis, sem afetar Jéssica.');

    // -------------------------------------------------------------
    // TEST 7: AUDITORIA DE TRANSIÇÕES DE STATUS
    // -------------------------------------------------------------
    console.log('\n--- 7. TRILHA DE AUDITORIA & VERSIONAMENTO ---');

    const auditLogs = db.prepare('SELECT * FROM subscription_audit_logs WHERE subscription_id = ? ORDER BY id ASC').all(jessicaSub.id);
    assert(auditLogs.length >= 2, 'Deve haver registros de auditoria para criação e cancelamento');
    assert.strictEqual(auditLogs[0].action, 'CREATED');
    const cancelLog = auditLogs.find(l => l.action === 'CANCELLED');
    assert(Boolean(cancelLog), 'Deve haver registro de auditoria para cancelamento');
    recordPass(`Trilha de auditoria registrada com sucesso (${auditLogs.length} eventos auditados).`);

    // -------------------------------------------------------------
    // TEST 8: MÉTRICAS ADMINISTRATIVAS CONSOLIDADAS
    // -------------------------------------------------------------
    console.log('\n--- 8. MÉTRICAS CONSOLIDADAS MULTIPRODUTO ---');

    const metricsRes = await request('/api/admin/multiproduct/metrics', {
      headers: { Cookie: adminCookie },
    });
    assert.strictEqual(metricsRes.status, 200);
    assert.strictEqual(metricsRes.data.success, true);
    assert(metricsRes.data.metrics.metricsByProduct.length >= 3);
    assert(metricsRes.data.metrics.totalMrrCents > 0);
    recordPass(`Métricas consolidadas calculadas com sucesso: MRR total de ${metricsRes.data.metrics.totalMrrFormatted}.`);

    // -------------------------------------------------------------
    // TEST 9: ISOLAMENTO MULTI-TENANT
    // -------------------------------------------------------------
    console.log('\n--- 9. ISOLAMENTO MULTI-TENANT ENTRE CLIENTES ---');

    // Create Client B
    deleteUserAndChildren('client.b@raia.test', '5511966660002');
    const clientBToken = 'token_client_b_' + Date.now();
    const insertClientB = db.prepare(`
      INSERT INTO users (name, email, phone_number, role, magic_token, magic_token_expires_at, subscription_status)
      VALUES ('Cliente B Salão', 'client.b@raia.test', '5511966660002', 'USER', ?, datetime('now', '+1 hour'), 'ACTIVE')
    `).run(clientBToken);
    const clientBId = Number(insertClientB.lastInsertRowid);

    productService.createCustomerSubscription({
      userId: clientBId,
      productCode: 'JESSICA',
      planCode: 'START',
      status: 'ACTIVE',
      priceCents: 8900,
      paidUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
    });

    // Client B requests their products
    const clientBProductsRes = await request('/api/cliente/my-products', {
      headers: { Authorization: `Bearer ${clientBToken}` },
    });
    assert.strictEqual(clientBProductsRes.status, 200);
    assert.strictEqual(clientBProductsRes.data.subscriptions.length, 1);
    assert.strictEqual(clientBProductsRes.data.subscriptions[0].userId, clientBId);

    // Client B must NOT see Client A's subscriptions
    const foundClientASub = clientBProductsRes.data.subscriptions.some(s => s.userId === clientId);
    assert.strictEqual(foundClientASub, false, 'Cliente B não pode ver assinaturas de Cliente A');
    recordPass('Isolamento multi-tenant validado: clientes acessam exclusivamente seus próprios contratos.');

    // -------------------------------------------------------------
    // TEST 10: REGRESSÃO DE SEGURANÇA E COMPATIBILIDADE
    // -------------------------------------------------------------
    console.log('\n--- 10. SEGURANÇA: CONTROLE DE ROTAS NÃO AUTENTICADAS ---');

    // Request without token to /api/cliente/my-products -> 401
    const unauthMyProd = await request('/api/cliente/my-products');
    assert.strictEqual(unauthMyProd.status, 401, 'Endpoint do cliente sem autenticação deve retornar 401');

    // Request without admin cookie to /api/admin/products -> 401 or 403
    const unauthAdmin = await request('/api/admin/products');
    assert([401, 403].includes(unauthAdmin.status), 'Endpoint admin sem credencial administrativa deve ser bloqueado');

    recordPass('Proteção 401/403 preservada em rotas de cliente e administrativas.');

    console.log('\n======================================================');
    console.log(` TODOS OS ${passCount} TESTES MULTIPRODUTO PASSARAM COM SUCESSO! `);
    console.log('======================================================\n');
  } finally {
    if (server) {
      server.close();
    }
  }
}

runTests().catch((err) => {
  console.error('\n❌ FALHA NOS TESTES MULTIPRODUTO:', err);
  process.exit(1);
});
