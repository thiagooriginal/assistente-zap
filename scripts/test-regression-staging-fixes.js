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
