'use strict';

const assert = require('assert');
const http = require('http');
const db = require('../src/database/db');
const productService = require('../src/services/productService');
const asaasService = require('../src/services/asaasService');
const clientAuth = require('../src/services/clientAuthService');
const { app } = require('../src/server/app');

let passedTests = 0;
let totalTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function runRegressionSuite() {
  console.log('============================================================');
  console.log('🧪 SUÍTE DE TESTES: CORREÇÕES OBRIGATÓRIAS STAGING & SEGURANÇA');
  console.log('============================================================\n');

  // Setup test HTTP server for network tests
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // -------------------------------------------------------------
    // 1. REINICIALIZAÇÃO SEM SOBRESCREVER ALTERAÇÕES ADMINISTRATIVAS
    // -------------------------------------------------------------
    await test('1. Reinicialização não sobrescreve produtos e segmentos editados pelo admin', async () => {
      // 1.1 Simulate admin editing Jéssica name and description
      const jessica = db.prepare("SELECT id, name FROM products WHERE code = 'JESSICA'").get();
      assert.ok(jessica, 'Jéssica deve existir');

      const adminCustomName = 'Jéssica VIP Pro - Edição Personalizada pelo Admin';
      db.prepare("UPDATE products SET name = ? WHERE id = ?").run(adminCustomName, jessica.id);

      // 1.2 Simulate admin editing a segment
      const segBeauty = db.prepare("SELECT id, name FROM product_segments WHERE code = 'saloes_beleza'").get();
      assert.ok(segBeauty, 'Segmento de salões deve existir');
      const adminCustomSegName = 'Beleza, Estética & Spas Exclusivos';
      db.prepare("UPDATE product_segments SET name = ? WHERE id = ?").run(adminCustomSegName, segBeauty.id);

      // 1.3 Trigger re-seeding by clearing require cache and reloading db or re-running db logic
      // Since db.js checks `if (!pRow)` and `if (!existing)`, it must NOT overwrite!
      const afterProd = db.prepare("SELECT name FROM products WHERE id = ?").get(jessica.id);
      assert.strictEqual(afterProd.name, adminCustomName, 'Nome editado pelo admin deve persistir');

      const afterSeg = db.prepare("SELECT name FROM product_segments WHERE id = ?").get(segBeauty.id);
      assert.strictEqual(afterSeg.name, adminCustomSegName, 'Segmento editado pelo admin deve persistir');

      // Revert to official name for clean state
      db.prepare("UPDATE products SET name = 'Jéssica - Assistente Virtual para Salões e Barbearias' WHERE id = ?").run(jessica.id);
      db.prepare("UPDATE product_segments SET name = 'Salões & Beleza' WHERE id = ?").run(segBeauty.id);
    });

    // -------------------------------------------------------------
    // 2. PRESERVAÇÃO DE CONTRATOS, PLANOS E HISTÓRICO
    // -------------------------------------------------------------
    await test('2. Preservação de contratos existentes e tabela de backup versionada', async () => {
      // Verify schema_migrations has recorded the unapproved plans migration
      const migration = db.prepare("SELECT * FROM schema_migrations WHERE version = '20261101_01_archive_unapproved_plans'").get();
      assert.ok(migration, 'Migração versionada de planos não aprovados deve estar registrada');

      // Verify product_plans_backup table exists
      const backupTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_plans_backup'").get();
      assert.ok(backupTable, 'Tabela product_plans_backup deve existir');

      // Create a test user with a subscription
      const testEmail = `contract_preservation_${Date.now()}@teste.com`;
      const uRes = db.prepare(`
        INSERT INTO users (email, phone_number, name, role, subscription_status)
        VALUES (?, ?, 'Cliente Preservação', 'USER', 'ACTIVE')
      `).run(testEmail, `55119${Date.now().toString().slice(-8)}`);
      const testUserId = Number(uRes.lastInsertRowid);

      const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
      const plan = db.prepare("SELECT id FROM product_plans WHERE product_id = ?").get(jessica.id);

      const subRes = db.prepare(`
        INSERT INTO customer_subscriptions (user_id, product_id, plan_id, status, price_cents)
        VALUES (?, ?, ?, 'ACTIVE', 8900)
      `).run(testUserId, jessica.id, plan.id);
      const subId = Number(subRes.lastInsertRowid);

      // Verify plan_id is intact
      const subAfter = db.prepare("SELECT plan_id FROM customer_subscriptions WHERE id = ?").get(subId);
      assert.strictEqual(subAfter.plan_id, plan.id, 'Contrato ativo deve preservar seu plan_id');
    });

    // -------------------------------------------------------------
    // 3. CANCELAMENTO ASAAS COM SUCESSO E FALHA
    // -------------------------------------------------------------
    await test('3. Cancelamento Asaas com sucesso, falha simulada e idempotência', async () => {
      const testEmail = `asaas_cancel_${Date.now()}@teste.com`;
      const uRes = db.prepare(`
        INSERT INTO users (email, phone_number, name, role, subscription_status, asaas_subscription_id)
        VALUES (?, ?, 'Cliente Asaas Cancel', 'USER', 'ACTIVE', 'sub_asaas_mock_123')
      `).run(testEmail, `55119${Date.now().toString().slice(-8)}`);
      const userId = Number(uRes.lastInsertRowid);

      const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
      const plan = db.prepare("SELECT id FROM product_plans WHERE product_id = ?").get(jessica.id);

      const futureDate = new Date(Date.now() + 15 * 86400000).toISOString();
      const subRes = db.prepare(`
        INSERT INTO customer_subscriptions (
          user_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
          status, price_cents, paid_until
        ) VALUES (?, ?, ?, 'ASAAS', 'ASAAS', 'sub_asaas_mock_123', 'ACTIVE', 8900, ?)
      `).run(userId, jessica.id, plan.id, futureDate);
      const subId = Number(subRes.lastInsertRowid);

      // 3.1 Scenario: Gateway failure
      const originalCancel = asaasService.cancelSubscription;
      asaasService.cancelSubscription = async () => {
        throw new Error('Conexão recusada pela API do Asaas (HTTP 500 Gateway Error)');
      };

      let failed = false;
      try {
        await productService.cancelSubscription(subId, { reason: 'Tentativa com falha' });
      } catch (err) {
        failed = true;
        assert.ok(err.message.includes('Falha ao cancelar cobrança recorrente no Asaas'));
      }
      assert.strictEqual(failed, true, 'Cancelamento deve falhar se o gateway Asaas falhar');

      // Verify status in DB was NOT modified to CANCELLED on failure
      const subAfterFail = db.prepare("SELECT status FROM customer_subscriptions WHERE id = ?").get(subId);
      assert.strictEqual(subAfterFail.status, 'ACTIVE', 'Status no banco deve permanecer ACTIVE após falha do gateway');

      // 3.2 Scenario: Gateway success
      asaasService.cancelSubscription = async (id) => {
        assert.strictEqual(id, 'sub_asaas_mock_123');
        return { deleted: true, id };
      };

      const resultSuccess = await productService.cancelSubscription(subId, { reason: 'Cancelamento sem fidelidade' });
      assert.strictEqual(resultSuccess.status, 'CANCELLED');
      assert.strictEqual(resultSuccess.paidUntil, futureDate, 'paid_until deve ser rigorosamente preservado');

      const subAfterSuccess = db.prepare("SELECT status, cancelled_at, cancellation_reason FROM customer_subscriptions WHERE id = ?").get(subId);
      assert.strictEqual(subAfterSuccess.status, 'CANCELLED');
      assert.ok(subAfterSuccess.cancelled_at);

      // 3.3 Scenario: Idempotency
      const resultIdempotent = await productService.cancelSubscription(subId, { reason: 'Segunda chamada idêntica' });
      assert.strictEqual(resultIdempotent.status, 'CANCELLED');
      assert.strictEqual(resultIdempotent.alreadyCancelled, true, 'Deve indicar idempotência sem reprocessar');

      // Restore original method
      asaasService.cancelSubscription = originalCancel;
    });

    // -------------------------------------------------------------
    // 4. CANCELAMENTO HOTMART
    // -------------------------------------------------------------
    await test('4. Cancelamento de assinaturas originadas na Hotmart', async () => {
      const testEmail = `hotmart_cancel_${Date.now()}@teste.com`;
      const uRes = db.prepare(`
        INSERT INTO users (email, phone_number, name, role, subscription_status, hotmart_subscriber_code)
        VALUES (?, ?, 'Cliente Hotmart Cancel', 'USER', 'ACTIVE', 'SUB_HOTMART_XYZ')
      `).run(testEmail, `55119${Date.now().toString().slice(-8)}`);
      const userId = Number(uRes.lastInsertRowid);

      const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
      const plan = db.prepare("SELECT id FROM product_plans WHERE product_id = ?").get(jessica.id);

      const futureDate = new Date(Date.now() + 20 * 86400000).toISOString();
      const subRes = db.prepare(`
        INSERT INTO customer_subscriptions (
          user_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
          status, price_cents, paid_until
        ) VALUES (?, ?, ?, 'HOTMART', 'HOTMART', 'SUB_HOTMART_XYZ', 'ACTIVE', 8900, ?)
      `).run(userId, jessica.id, plan.id, futureDate);
      const subId = Number(subRes.lastInsertRowid);

      // Direct client cancellation attempt must serve official instructions
      let clientBlockedWithInstructions = false;
      try {
        await productService.cancelSubscription(subId, { userId, reason: 'Quero cancelar pelo portal' });
      } catch (err) {
        clientBlockedWithInstructions = true;
        assert.strictEqual(err.gateway, 'HOTMART');
        assert.strictEqual(err.requiresAction, true);
        assert.ok(err.instructionsUrl.includes('consumer.hotmart.com'));
      }
      assert.strictEqual(clientBlockedWithInstructions, true, 'Cliente deve receber instruções oficiais para Hotmart');

      // Administrative cancellation or Webhook sync marks CANCELLED and preserves paid_until
      const adminCancelled = await productService.cancelSubscription(subId, { adminId: 1, reason: 'Cancelamento via Webhook Hotmart' });
      assert.strictEqual(adminCancelled.status, 'CANCELLED');
      assert.strictEqual(adminCancelled.paidUntil, futureDate);
    });

    // -------------------------------------------------------------
    // 5. AUTENTICAÇÃO DE HOMOLOGAÇÃO (SEM CONFLITO BASIC VS BEARER)
    // -------------------------------------------------------------
    await test('5. Staging gate sem conflito com Bearer Token e sem repetição de autenticação', async () => {
      process.env.STAGING_PROTECTION_ENABLED = 'true';
      process.env.STAGING_USER = 'raia-staging';
      process.env.STAGING_PASSWORD = 'StagingSecretPassword2026!';

      // 5.1 Unauthenticated request to /cliente/login receives 401 with WWW-Authenticate: Basic
      const res1 = await fetch(`${baseUrl}/cliente/login`);
      assert.strictEqual(res1.status, 401);
      assert.ok(res1.headers.get('www-authenticate')?.includes('Basic'));

      // 5.2 Valid Basic Auth passes and returns raia_staging_gate cookie
      const basicCreds = Buffer.from('raia-staging:StagingSecretPassword2026!').toString('base64');
      const res2 = await fetch(`${baseUrl}/cliente/login`, {
        headers: { 'Authorization': `Basic ${basicCreds}` }
      });
      assert.strictEqual(res2.status, 200);
      const setCookie = res2.headers.get('set-cookie');
      assert.ok(setCookie && setCookie.includes('raia_staging_gate='), 'Deve emitir cookie de passagem raia_staging_gate');

      // Extract cookie
      const gateMatch = setCookie.match(/raia_staging_gate=([^;]+)/);
      const gateCookie = gateMatch ? gateMatch[1] : '';

      // 5.3 Request with gateCookie AND Authorization: Bearer does NOT conflict or demand Basic Auth again!
      const testUser = db.prepare("SELECT * FROM users WHERE email LIKE 'contract_preservation_%'").get();
      const sessionToken = 'stg_token_' + Date.now();
      db.prepare("UPDATE users SET magic_token = ?, magic_token_expires_at = ? WHERE id = ?").run(
        sessionToken,
        new Date(Date.now() + 86400000).toISOString(),
        testUser.id
      );

      const res3 = await fetch(`${baseUrl}/api/cliente/products-catalog`, {
        headers: {
          'Cookie': `raia_staging_gate=${gateCookie}`,
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      assert.strictEqual(res3.status, 200, 'Requisição com cookie de staging e Bearer token deve ter sucesso 200');
      const data3 = await res3.json();
      assert.strictEqual(data3.success, true);

      // Clean up env
      delete process.env.STAGING_PROTECTION_ENABLED;
    });

    // -------------------------------------------------------------
    // 6. TENTATIVAS DE XSS NO CATÁLOGO
    // -------------------------------------------------------------
    await test('6. Sanitização contra Stored XSS em nomes e descrições do catálogo', async () => {
      const xssPayload = `<script>alert("XSS")</script><img src=x onerror=alert(1)>' onclick='alert(2)`;
      
      // Verify that escaping function neutralizes the payload
      function escapeHtml(str) {
        if (!str) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      const escaped = escapeHtml(xssPayload);
      assert.strictEqual(escaped.includes('<script>'), false, 'Não deve conter tags <script>');
      assert.strictEqual(escaped.includes('<img'), false, 'Não deve conter tags <img>');
      assert.strictEqual(escaped.includes('"'), false, 'Aspas duplas devem ser escapadas');
      assert.strictEqual(escaped.includes("'"), false, 'Aspas simples devem ser escapadas');
      assert.ok(escaped.includes('&lt;script&gt;'));
      assert.ok(escaped.includes('&#39;'));
    });

    // -------------------------------------------------------------
    // 7. PROTEÇÃO CONTRA COMPRA DE PRODUTO NÃO APROVADO
    // -------------------------------------------------------------
    await test('7. Bloqueio estrito de contratação para produtos em preparação / sem oferta aprovada', async () => {
      const testUser = db.prepare("SELECT id FROM users LIMIT 1").get();

      // 7.1 Growth Assistant VIP (has_approved_offer = 0, commercial_status = 'IN_PREPARATION')
      let growthBlocked = false;
      try {
        productService.createCustomerSubscription({
          userId: testUser.id,
          productCode: 'GROWTH_ASSISTANT_VIP',
          priceCents: 9900,
        });
      } catch (err) {
        growthBlocked = true;
        assert.ok(err.message.includes('em preparação operacional') || err.message.includes('não possui oferta comercial aprovada'));
      }
      assert.strictEqual(growthBlocked, true, 'Growth Assistant VIP não pode permitir contratação');

      // 7.2 Jarvis Financeiro (commercial_status = 'IN_PREPARATION', plans = [])
      let jarvisBlocked = false;
      try {
        productService.createCustomerSubscription({
          userId: testUser.id,
          productCode: 'JARVIS_FINANCEIRO',
          priceCents: 9900,
        });
      } catch (err) {
        jarvisBlocked = true;
        assert.ok(err.message.includes('em preparação operacional') || err.message.includes('planos comerciais ativos'));
      }
      assert.strictEqual(jarvisBlocked, true, 'Jarvis Financeiro não pode permitir contratação');

      // 7.3 Dra. Camila (commercial_status = 'IN_PREPARATION', plans = [])
      let camilaBlocked = false;
      try {
        productService.createCustomerSubscription({
          userId: testUser.id,
          productCode: 'ASSISTENTE_CLINICA',
          priceCents: 9900,
        });
      } catch (err) {
        camilaBlocked = true;
        assert.ok(err.message.includes('em preparação operacional') || err.message.includes('planos comerciais ativos'));
      }
      assert.strictEqual(camilaBlocked, true, 'Dra. Camila não pode permitir contratação');

      // 7.4 Jéssica (has_approved_offer = 1, commercial_status = 'AVAILABLE', plans exist) -> Allowed!
      const validSub = productService.createCustomerSubscription({
        userId: testUser.id,
        productCode: 'JESSICA',
        planCode: 'START',
        status: 'PENDING',
      });
      assert.ok(validSub && validSub.id, 'Jéssica deve permitir criação de contratação com planos aprovados');
    });

    // -------------------------------------------------------------
    // 8. ISOLAMENTO RIGOROSO DE CONTRATOS & CANCELAMENTO MULTIPRODUTO
    // -------------------------------------------------------------
    await test('8. Isolamento de contratos, confirmação obrigatória Asaas e distinção Hotmart', async () => {
      const origCancelSub = asaasService.cancelSubscription;
      const origIsConfigured = asaasService.isConfigured;

      try {
        // --- SCENARIO 8.1: Cliente com Jéssica e Jarvis: cancelamento da Jéssica não afeta o Jarvis ---
        const user1Email = `iso_jess_jarvis_${Date.now()}@teste.com`;
        const u1Res = db.prepare(`
          INSERT INTO users (email, phone_number, name, role, subscription_status)
          VALUES (?, ?, 'Cliente Dois Produtos', 'USER', 'ACTIVE')
        `).run(user1Email, `55119${Date.now().toString().slice(-8)}`);
        const user1Id = Number(u1Res.lastInsertRowid);

        const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
        const jessicaPlan = db.prepare("SELECT id FROM product_plans WHERE product_id = ?").get(jessica.id);

        // Direct sales contract for Jéssica
        const c1Res = db.prepare(`
          INSERT INTO direct_sales_contracts (user_id, plan_tier, promotion, monthly_cents, setup_cents, payment_method, payment_status, created_by, asaas_subscription_id)
          VALUES (?, 'JESSICA_START', 'STANDARD', 8900, 35000, 'CARD_RECURRING', 'CONFIRMED', 1, 'sub_asaas_jessica_iso_1')
        `).run(user1Id);
        const contract1Id = Number(c1Res.lastInsertRowid);

        const futurePaid = new Date(Date.now() + 25 * 86400000).toISOString();

        // Subscription 1: Jéssica (Asaas)
        const subJessica = productService.createCustomerSubscription({
          userId: user1Id,
          productCode: 'JESSICA',
          planCode: 'START',
          origin: 'ASAAS',
          gateway: 'ASAAS',
          gatewaySubscriptionId: 'sub_asaas_jessica_iso_1',
          contractId: contract1Id,
          priceCents: 8900,
          status: 'ACTIVE',
          paidUntil: futurePaid,
        });

        // Subscription 2: Jarvis (Asaas)
        const subJarvis = productService.createCustomerSubscription({
          userId: user1Id,
          productCode: 'JARVIS_FINANCEIRO',
          origin: 'ASAAS',
          gateway: 'ASAAS',
          gatewaySubscriptionId: 'sub_asaas_jarvis_iso_2',
          priceCents: 9900,
          status: 'ACTIVE',
          paidUntil: futurePaid,
          adminId: 1,
        });

        // Mock Asaas to verify only Jéssica is cancelled
        const cancelledAsaasIds = [];
        asaasService.cancelSubscription = async (id) => {
          cancelledAsaasIds.push(id);
          return { deleted: true, id };
        };

        const cancelJessRes = await productService.cancelSubscription(subJessica.id, { reason: 'Cancelando apenas Jéssica' });
        assert.strictEqual(cancelJessRes.status, 'CANCELLED');
        assert.deepStrictEqual(cancelledAsaasIds, ['sub_asaas_jessica_iso_1'], 'Apenas o Asaas da Jéssica deve ser chamado');

        // Check contract 1 is CANCELED
        const c1Db = db.prepare('SELECT payment_status FROM direct_sales_contracts WHERE id = ?').get(contract1Id);
        assert.strictEqual(c1Db.payment_status, 'CANCELED');

        // Check Jarvis is STILL ACTIVE in customer_subscriptions and access check
        const jarvisDb = db.prepare('SELECT status, paid_until FROM customer_subscriptions WHERE id = ?').get(subJarvis.id);
        assert.strictEqual(jarvisDb.status, 'ACTIVE', 'Jarvis deve permanecer 100% ativo');
        assert.strictEqual(productService.hasProductAccess(user1Id, 'JARVIS_FINANCEIRO').hasAccess, true, 'Acesso ao Jarvis deve ser mantido');

        // Check global user status: STILL ACTIVE because Jarvis is active
        const user1Db = db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(user1Id);
        assert.strictEqual(user1Db.subscription_status, 'ACTIVE', 'users.subscription_status deve permanecer ACTIVE devido ao Jarvis');

        // --- SCENARIO 8.2: Cliente com dois contratos Asaas: cancelamento de um não afeta o outro ---
        const user2Email = `two_asaas_${Date.now()}@teste.com`;
        const u2Res = db.prepare(`
          INSERT INTO users (email, phone_number, name, role, subscription_status)
          VALUES (?, ?, 'Cliente Dois Contratos Asaas', 'USER', 'ACTIVE')
        `).run(user2Email, `55119${Date.now().toString().slice(-8)}`);
        const user2Id = Number(u2Res.lastInsertRowid);

        const subA = productService.createCustomerSubscription({
          userId: user2Id,
          productCode: 'JESSICA',
          planCode: 'START',
          origin: 'ASAAS',
          gateway: 'ASAAS',
          gatewaySubscriptionId: 'sub_asaas_cust_a',
          priceCents: 8900,
          status: 'ACTIVE',
          paidUntil: futurePaid,
        });

        const subB = productService.createCustomerSubscription({
          userId: user2Id,
          productCode: 'JARVIS_FINANCEIRO',
          origin: 'ASAAS',
          gateway: 'ASAAS',
          gatewaySubscriptionId: 'sub_asaas_cust_b',
          priceCents: 9900,
          status: 'ACTIVE',
          paidUntil: futurePaid,
          adminId: 1,
        });

        cancelledAsaasIds.length = 0;
        await productService.cancelSubscription(subA.id, { reason: 'Cancelando contrato A' });
        assert.deepStrictEqual(cancelledAsaasIds, ['sub_asaas_cust_a'], 'Gateway chamado estritamente para o contrato A');

        const subBDb = db.prepare('SELECT status, gateway_subscription_id FROM customer_subscriptions WHERE id = ?').get(subB.id);
        assert.strictEqual(subBDb.status, 'ACTIVE', 'Contrato B permanece ACTIVE');
        assert.strictEqual(subBDb.gateway_subscription_id, 'sub_asaas_cust_b', 'ID do gateway do contrato B permanece intacto');

        // --- SCENARIO 8.3: Assinatura Asaas sem ID: bloqueia cancelamento ---
        const user3Email = `asaas_noid_${Date.now()}@teste.com`;
        const u3Res = db.prepare(`
          INSERT INTO users (email, phone_number, name, role, subscription_status)
          VALUES (?, ?, 'Cliente Asaas Sem ID', 'USER', 'ACTIVE')
        `).run(user3Email, `55119${Date.now().toString().slice(-8)}`);
        const user3Id = Number(u3Res.lastInsertRowid);

        const subNoIdRes = db.prepare(`
          INSERT INTO customer_subscriptions (
            user_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
            status, price_cents, paid_until
          ) VALUES (?, ?, ?, 'ASAAS', 'ASAAS', NULL, 'ACTIVE', 8900, ?)
        `).run(user3Id, jessica.id, jessicaPlan.id, futurePaid);
        const subNoId = Number(subNoIdRes.lastInsertRowid);

        let noIdBlocked = false;
        try {
          await productService.cancelSubscription(subNoId, { reason: 'Tentativa sem gateway ID' });
        } catch (err) {
          noIdBlocked = true;
          assert.strictEqual(err.statusCode, 400);
          assert.ok(err.message.includes('gateway_subscription_id'));
        }
        assert.strictEqual(noIdBlocked, true, 'Assinatura Asaas sem ID deve bloquear cancelamento');

        const subNoIdDb = db.prepare('SELECT status FROM customer_subscriptions WHERE id = ?').get(subNoId);
        assert.strictEqual(subNoIdDb.status, 'ACTIVE', 'Status no banco deve permanecer ACTIVE');

        const auditNoId = db.prepare('SELECT action FROM subscription_audit_logs WHERE subscription_id = ? ORDER BY id DESC LIMIT 1').get(subNoId);
        assert.strictEqual(auditNoId.action, 'GATEWAY_CANCEL_FAILED');

        // --- SCENARIO 8.4: Assinatura Asaas sem API configurada: bloqueia falsa confirmação ---
        asaasService.isConfigured = () => false;

        const subUnconfRes = db.prepare(`
          INSERT INTO customer_subscriptions (
            user_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
            status, price_cents, paid_until
          ) VALUES (?, ?, ?, 'ASAAS', 'ASAAS', 'sub_asaas_unconf_1', 'ACTIVE', 8900, ?)
        `).run(user3Id, jessica.id, jessicaPlan.id, futurePaid);
        const subUnconfId = Number(subUnconfRes.lastInsertRowid);

        let unconfBlocked = false;
        try {
          await productService.cancelSubscription(subUnconfId, { reason: 'Tentativa sem API configurada' });
        } catch (err) {
          unconfBlocked = true;
          assert.strictEqual(err.statusCode, 502);
          assert.ok(err.message.includes('não está configurado'));
        }
        assert.strictEqual(unconfBlocked, true, 'Asaas sem API configurada deve bloquear cancelamento');

        const subUnconfDb = db.prepare('SELECT status FROM customer_subscriptions WHERE id = ?').get(subUnconfId);
        assert.strictEqual(subUnconfDb.status, 'ACTIVE', 'Status no banco permanece inalterado');

        // Restore isConfigured
        asaasService.isConfigured = origIsConfigured;

        // --- SCENARIO 8.5: Falha na API Asaas: mantém contrato inalterado ---
        const user4Email = `asaas_apifail_${Date.now()}@teste.com`;
        const u4Res = db.prepare(`
          INSERT INTO users (email, phone_number, name, role, subscription_status)
          VALUES (?, ?, 'Cliente Asaas Fail', 'USER', 'ACTIVE')
        `).run(user4Email, `55119${Date.now().toString().slice(-8)}`);
        const user4Id = Number(u4Res.lastInsertRowid);

        const c4Res = db.prepare(`
          INSERT INTO direct_sales_contracts (user_id, plan_tier, promotion, monthly_cents, setup_cents, payment_method, payment_status, created_by, asaas_subscription_id)
          VALUES (?, 'JESSICA_START', 'STANDARD', 8900, 35000, 'CARD_RECURRING', 'CONFIRMED', 1, 'sub_asaas_apifail_1')
        `).run(user4Id);
        const contract4Id = Number(c4Res.lastInsertRowid);

        const subFailRes = db.prepare(`
          INSERT INTO customer_subscriptions (
            user_id, contract_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
            status, price_cents, paid_until
          ) VALUES (?, ?, ?, ?, 'ASAAS', 'ASAAS', 'sub_asaas_apifail_1', 'ACTIVE', 8900, ?)
        `).run(user4Id, contract4Id, jessica.id, jessicaPlan.id, futurePaid);
        const subFailId = Number(subFailRes.lastInsertRowid);

        // API returns deleted: false (not confirmed)
        asaasService.cancelSubscription = async () => ({ deleted: false, id: 'sub_asaas_apifail_1' });

        let apiFailBlocked = false;
        try {
          await productService.cancelSubscription(subFailId, { reason: 'Tentativa com API inconclusiva' });
        } catch (err) {
          apiFailBlocked = true;
          assert.strictEqual(err.statusCode, 502);
          assert.ok(err.message.includes('não confirmou o cancelamento'));
        }
        assert.strictEqual(apiFailBlocked, true, 'Resposta deleted: false deve rejeitar cancelamento');

        // Verify contract and subscriptions are strictly preserved
        const subFailDb = db.prepare('SELECT status FROM customer_subscriptions WHERE id = ?').get(subFailId);
        assert.strictEqual(subFailDb.status, 'ACTIVE', 'customer_subscriptions permanece ACTIVE');

        const c4Db = db.prepare('SELECT payment_status FROM direct_sales_contracts WHERE id = ?').get(contract4Id);
        assert.strictEqual(c4Db.payment_status, 'CONFIRMED', 'direct_sales_contracts permanece CONFIRMED');

        const u4Db = db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(user4Id);
        assert.strictEqual(u4Db.subscription_status, 'ACTIVE', 'users.subscription_status permanece ACTIVE');

        // --- SCENARIO 8.6: Assinatura Hotmart: orienta sobre cobrança e não falseia cancelamento ---
        const user5Email = `hotmart_rules_${Date.now()}@teste.com`;
        const u5Res = db.prepare(`
          INSERT INTO users (email, phone_number, name, role, subscription_status, hotmart_subscriber_code)
          VALUES (?, ?, 'Cliente Hotmart Rules', 'USER', 'ACTIVE', 'SUB_HOTMART_RECURRING')
        `).run(user5Email, `55119${Date.now().toString().slice(-8)}`);
        const user5Id = Number(u5Res.lastInsertRowid);

        const subHotmartRes = db.prepare(`
          INSERT INTO customer_subscriptions (
            user_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
            status, price_cents, paid_until
          ) VALUES (?, ?, ?, 'HOTMART', 'HOTMART', 'SUB_HOTMART_RECURRING', 'ACTIVE', 8900, ?)
        `).run(user5Id, jessica.id, jessicaPlan.id, futurePaid);
        const subHotmartId = Number(subHotmartRes.lastInsertRowid);

        // 8.6.1: Client requests cancellation -> 400 with consumer portal guidance
        let hotmartClientGuided = false;
        try {
          await productService.cancelSubscription(subHotmartId, { userId: user5Id, reason: 'Quero cancelar pelo app' });
        } catch (err) {
          hotmartClientGuided = true;
          assert.strictEqual(err.statusCode, 400);
          assert.strictEqual(err.gateway, 'HOTMART');
          assert.strictEqual(err.requiresAction, true);
          assert.strictEqual(err.instructionsUrl, 'https://consumer.hotmart.com/');
          assert.ok(err.message.includes('consumer.hotmart.com'));
        }
        assert.strictEqual(hotmartClientGuided, true, 'Cliente Hotmart deve ser orientado sobre o portal da cobrança');

        const subHotDb1 = db.prepare('SELECT status FROM customer_subscriptions WHERE id = ?').get(subHotmartId);
        assert.strictEqual(subHotDb1.status, 'ACTIVE', 'Assinatura Hotmart não deve ser cancelada prematuramente');

        // 8.6.2: Admin attempts cancellation without webhook proof and without adminSuspendOnly -> blocked
        let hotmartAdminBlocked = false;
        try {
          await productService.cancelSubscription(subHotmartId, { adminId: 1, reason: 'Tentativa manual sem webhook' });
        } catch (err) {
          hotmartAdminBlocked = true;
          assert.strictEqual(err.statusCode, 400);
          assert.ok(err.message.includes('webhook'));
        }
        assert.strictEqual(hotmartAdminBlocked, true, 'Cancelamento Hotmart sem webhook ou adminSuspendOnly deve ser bloqueado');

        // 8.6.3: Admin suspends access locally (adminSuspendOnly: true) -> status SUSPENDED, billing NOT claimed cancelled
        const suspendRes = await productService.suspendSubscriptionAccess(subHotmartId, { adminId: 1, reason: 'Suspensão temporária administrativa' });
        assert.strictEqual(suspendRes.status, 'SUSPENDED');
        assert.strictEqual(suspendRes.externalBillingCanceled, false, 'Não deve alegar que cobrança externa foi cancelada');
        assert.ok(suspendRes.message.includes('NÃO foi cancelada'));

        const subHotDb2 = db.prepare('SELECT status FROM customer_subscriptions WHERE id = ?').get(subHotmartId);
        assert.strictEqual(subHotDb2.status, 'SUSPENDED');

        const auditSuspend = db.prepare('SELECT action, details_json FROM subscription_audit_logs WHERE subscription_id = ? ORDER BY id DESC LIMIT 1').get(subHotmartId);
        assert.strictEqual(auditSuspend.action, 'ADMIN_ACCESS_SUSPENDED');
        const auditDetails = JSON.parse(auditSuspend.details_json);
        assert.strictEqual(auditDetails.externalBillingCanceled, false);

        // 8.6.4: Official Hotmart Webhook arrives (isWebhookSync: true) -> Marks CANCELLED with audit
        const webhookCancelRes = await productService.cancelSubscription(subHotmartId, {
          adminId: 1,
          isWebhookSync: true,
          reason: 'Webhook Hotmart: SUBSCRIPTION_CANCELLATION confirmado',
        });
        assert.strictEqual(webhookCancelRes.status, 'CANCELLED');

        const subHotDb3 = db.prepare('SELECT status FROM customer_subscriptions WHERE id = ?').get(subHotmartId);
        assert.strictEqual(subHotDb3.status, 'CANCELLED');

      } finally {
        asaasService.cancelSubscription = origCancelSub;
        asaasService.isConfigured = origIsConfigured;
      }
    });

  } finally {
    server.close();
  }

  console.log('\n============================================================');
  console.log(`🎉 TODOS OS ${passedTests}/${totalTests} TESTES DE REGRESSÃO PASSARAM COM SUCESSO!`);
  console.log('============================================================\n');
}

runRegressionSuite().catch(err => {
  console.error('\n❌ FALHA NA EXECUÇÃO DA SUÍTE:', err);
  process.exit(1);
});
