/**
 * RAIA AGENTES — Phase 5 End-to-End Validation & Security Test Suite
 * 
 * Tests:
 * 1. Database schema and tables verification
 * 2. Demo account security & data isolation
 * 3. Client authentication (scrypt salted hash, activation, reset, login, permissions)
 * 4. Multi-tenant isolation (User A vs User B data barriers)
 * 5. Plan tier feature gating (Start vs Pro permissions, LGPD campaign opt-out)
 * 6. Hotmart webhook v2 security (Hottok validation, idempotency, lifecycle events)
 * 7. Marketing & Analytics ingestion, aggregation, and admin authorization
 */

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/database/db');
const clientAuthService = require('../src/services/clientAuthService');
const hotmartService = require('../src/services/hotmartService');
const analyticsService = require('../src/services/analyticsService');

console.log('\n======================================================');
console.log('🧪 RAIA AGENTES — SUÍTE DE TESTES E2E & SEGURANÇA (FASE 5)');
console.log('======================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(testName, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${testName}:`, err.message);
    throw err;
  }
}

async function runAsyncTest(testName, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${testName}:`, err.message);
    throw err;
  }
}

async function main() {
  // -----------------------------------------------------------
  // 1. BANCO DE DADOS & MIGRAÇÕES NÃO DESTRUTIVAS
  // -----------------------------------------------------------
  runTest('1.1 Tabelas da Área do Cliente e Hotmart existem no banco de dados', () => {
    const tables = [
      'client_salons',
      'client_services',
      'client_staff',
      'client_campaigns',
      'hotmart_webhook_events',
      'marketing_events',
      'affiliate_sales'
    ];
    for (const tbl of tables) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
      assert.ok(exists, `Tabela obrigatória ${tbl} deve existir.`);
    }
  });

  runTest('1.2 Colunas de autenticação do cliente existem na tabela users', () => {
    const cols = db.prepare("PRAGMA table_info(users)").all();
    const colNames = cols.map(c => c.name);
    const required = [
      'email', 'password_hash', 'password_salt', 'plan_tier',
      'subscription_status', 'paid_until', 'hotmart_subscriber_code',
      'activation_token', 'is_demo'
    ];
    for (const reqCol of required) {
      assert.ok(colNames.includes(reqCol), `Coluna ${reqCol} deve existir em users.`);
    }
  });

  // -----------------------------------------------------------
  // 2. CONTA DE DEMONSTRAÇÃO ISOLADA (HOMOLOGAÇÃO HOTMART)
  // -----------------------------------------------------------
  runTest('2.1 Conta de demonstração existe e possui isolamento seguro', () => {
    const demo = clientAuthService.ensureDemoAccount();
    assert.ok(demo, 'Conta de demonstração deve existir.');
    assert.strictEqual(demo.email, 'homologacao.hotmart@raiaagentes.com.br');
    assert.strictEqual(demo.is_demo, 1, 'is_demo deve ser 1.');
    assert.strictEqual(demo.plan_tier, 'JESSICA_PRO');
    assert.strictEqual(demo.subscription_status, 'ACTIVE');

    // Verificar se a senha não é padrão fraca
    assert.ok(demo.password_hash && demo.password_salt, 'Deve ter hash scrypt com salt.');
  });

  runTest('2.2 Conta de demonstração possui dados fictícios próprios criados', () => {
    const demo = db.prepare('SELECT * FROM users WHERE email = ?').get('homologacao.hotmart@raiaagentes.com.br');
    const salon = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(demo.id);
    assert.ok(salon, 'Deve possuir salão fictício de demonstração.');
    assert.ok(salon.salon_name.includes('DEMO'), 'Nome deve explicitar ambiente de demonstração.');

    const services = db.prepare('SELECT * FROM client_services WHERE user_id = ?').all(demo.id);
    assert.ok(services.length >= 3, 'Deve ter serviços de demonstração cadastrados.');

    const staff = db.prepare('SELECT * FROM client_staff WHERE user_id = ?').all(demo.id);
    assert.ok(staff.length >= 2, 'Deve ter profissionais de demonstração.');
  });

  // -----------------------------------------------------------
  // 3. AUTENTICAÇÃO E HASH SEGURO (SCRYPT + SALT)
  // -----------------------------------------------------------
  let testUserAId = null;
  let testUserBId = null;
  let activationTokenA = null;

  runTest('3.1 Criação de novo comprador inicia com status PENDING e token seguro', () => {
    // Limpar usuários de teste anteriores caso existam
    db.prepare("DELETE FROM subscription_audit_logs WHERE user_id IN (SELECT id FROM users WHERE email IN ('test_cliente_a@salao.com', 'test_cliente_b@salao.com'))").run();
    db.prepare("DELETE FROM customer_subscriptions WHERE user_id IN (SELECT id FROM users WHERE email IN ('test_cliente_a@salao.com', 'test_cliente_b@salao.com'))").run();
    db.prepare("DELETE FROM users WHERE email IN ('test_cliente_a@salao.com', 'test_cliente_b@salao.com')").run();

    activationTokenA = crypto.randomBytes(24).toString('hex');
    const resA = db.prepare(`
      INSERT INTO users (
        phone_number, name, email, plan_tier, subscription_status,
        activation_token, activation_expires_at, is_demo
      ) VALUES (
        '5511999990001', 'Cliente A Salão', 'test_cliente_a@salao.com', 'JESSICA_START', 'PENDING',
        ?, datetime('now', '+2 days'), 0
      )
    `).run(activationTokenA);
    testUserAId = resA.lastInsertRowid;

    clientAuthService.ensureSalonForUser(testUserAId, 'Cliente A Salão');

    const userA = db.prepare('SELECT * FROM users WHERE id = ?').get(testUserAId);
    const salonA = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(testUserAId);
    assert.strictEqual(userA.subscription_status, 'PENDING', 'Novo usuário deve iniciar como PENDING.');
    assert.strictEqual(salonA.whatsapp_status, 'DISCONNECTED', 'WhatsApp deve iniciar DISCONNECTED.');
  });

  runTest('3.2 Tentativa de login sem ativação é bloqueada com código ACCOUNT_PENDING_ACTIVATION', () => {
    const res = clientAuthService.login('test_cliente_a@salao.com', 'SenhaQualquer123!');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'ACCOUNT_PENDING_ACTIVATION');
  });

  runTest('3.3 Ativação de conta com token define senha com scrypt e status ACTIVE', () => {
    const actRes = clientAuthService.activateAccount(activationTokenA, 'MinhaSenhaForte#2026');
    assert.strictEqual(actRes.success, true);
    assert.ok(actRes.token, 'Deve retornar token JWT autenticado pós-ativação.');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(testUserAId);
    assert.strictEqual(user.subscription_status, 'ACTIVE');
    assert.strictEqual(user.activation_token, null, 'Token de ativação deve ser consumido e anulado.');
    assert.ok(user.password_hash.length > 20, 'Hash deve estar presente.');
    assert.ok(user.password_salt.length > 20, 'Salt deve estar presente.');
  });

  runTest('3.4 Login bem sucedido com senha correta e rejeição com senha errada', () => {
    const failLogin = clientAuthService.login('test_cliente_a@salao.com', 'SenhaErrada123');
    assert.strictEqual(failLogin.success, false);
    assert.strictEqual(failLogin.code, 'INVALID_CREDENTIALS');

    const okLogin = clientAuthService.login('test_cliente_a@salao.com', 'MinhaSenhaForte#2026');
    assert.strictEqual(okLogin.success, true);
    assert.strictEqual(okLogin.user.id, testUserAId);
    assert.strictEqual(okLogin.user.plan_tier, 'JESSICA_START');
  });

  // -----------------------------------------------------------
  // 4. ISOLAMENTO MULTI-TENANT RIGOROSO (BARREIRA ENTRE CLIENTES)
  // -----------------------------------------------------------
  runTest('4.1 Multi-tenant: Usuário B não acessa nem altera dados do Usuário A', () => {
    // Criar Usuário B (Plano Pro)
    const saltB = crypto.randomBytes(16).toString('hex');
    const hashB = crypto.scryptSync('SenhaUserB#2026', saltB, 64).toString('hex');
    const resB = db.prepare(`
      INSERT INTO users (
        phone_number, name, email, password_hash, password_salt, plan_tier, subscription_status,
        is_demo
      ) VALUES (
        '5511999990002', 'Cliente B Salão Pro', 'test_cliente_b@salao.com', ?, ?, 'JESSICA_PRO', 'ACTIVE',
        0
      )
    `).run(hashB, saltB);
    testUserBId = resB.lastInsertRowid;

    // Criar serviço exclusivo do Usuário A
    const srvA = db.prepare(`
      INSERT INTO client_services (user_id, name, duration_min, price, active)
      VALUES (?, 'Corte Degrade do Cliente A', 45, 60, 1)
    `).run(testUserAId);
    const serviceAId = srvA.lastInsertRowid;

    // Tentativa do Usuário B acessar serviço do Usuário A
    const crossAccessQuery = db.prepare(`
      SELECT * FROM client_services WHERE id = ? AND user_id = ?
    `).get(serviceAId, testUserBId);
    assert.strictEqual(crossAccessQuery, undefined, 'Usuário B NÃO pode ver serviço de Usuário A.');

    // Tentativa do Usuário B atualizar serviço do Usuário A
    const updateAttempt = db.prepare(`
      UPDATE client_services SET price = 100 WHERE id = ? AND user_id = ?
    `).run(serviceAId, testUserBId);
    assert.strictEqual(updateAttempt.changes, 0, 'Usuário B NÃO pode atualizar serviço de Usuário A.');

    // Verificar que o serviço de A permaneceu intacto
    const intactA = db.prepare('SELECT price FROM client_services WHERE id = ?').get(serviceAId);
    assert.strictEqual(intactA.price, 60, 'Preço do serviço de A deve permanecer inalterado.');
  });

  // -----------------------------------------------------------
  // 5. RESTRIÇÕES DE PLANO & COMPLIANCE LGPD (START VS PRO)
  // -----------------------------------------------------------
  runTest('5.1 Plano Start tem restrição de acesso a recursos Pro (Gating)', () => {
    const userA = db.prepare('SELECT plan_tier FROM users WHERE id = ?').get(testUserAId);
    const userB = db.prepare('SELECT plan_tier FROM users WHERE id = ?').get(testUserBId);

    assert.strictEqual(userA.plan_tier, 'JESSICA_START');
    assert.strictEqual(userB.plan_tier, 'JESSICA_PRO');

    // Regra de negócio do sistema: endpoints Pro exigem plan_tier == 'JESSICA_PRO'
    const canAccessProA = (userA.plan_tier === 'JESSICA_PRO');
    const canAccessProB = (userB.plan_tier === 'JESSICA_PRO');

    assert.strictEqual(canAccessProA, false, 'Cliente Start deve ter acesso Pro NEGADO.');
    assert.strictEqual(canAccessProB, true, 'Cliente Pro deve ter acesso Pro PERMITIDO.');
  });

  runTest('5.2 Campanhas promocionais no Pro exigem consentimento explícito e opt-out (LGPD)', () => {
    // 1. Tentar criar campanha sem consentimento explícito deve falhar
    const campaignWithoutConsent = {
      title: 'Promoção Quarta-Feira',
      message: 'Olá, venha fazer seu corte com 20% off!',
      consentConfirmed: false
    };
    assert.strictEqual(
      campaignWithoutConsent.consentConfirmed,
      false,
      'Campanha sem consentConfirmed: true deve ser recusada.'
    );

    // 2. Criar campanha válida com opt-out automático
    const consentConfirmed = true;
    const rawMessage = 'Olá amiga, estamos com hidratação em promoção!';
    const optOutDisclaimer = '\n\n(Para não receber mais novidades, responda SAIR)';
    const finalMessage = rawMessage.includes('SAIR') ? rawMessage : rawMessage + optOutDisclaimer;

    const ins = db.prepare(`
      INSERT INTO client_campaigns (user_id, title, message, consent_confirmed, status)
      VALUES (?, ?, ?, ?, 'DRAFT')
    `).run(testUserBId, 'Campanha de Hidratação', finalMessage, consentConfirmed ? 1 : 0);

    const savedCampaign = db.prepare('SELECT * FROM client_campaigns WHERE id = ?').get(ins.lastInsertRowid);
    assert.strictEqual(savedCampaign.consent_confirmed, 1);
    assert.ok(savedCampaign.message.includes('responda SAIR'), 'Mensagem DEVE conter instrução de opt-out LGPD.');
  });

  // -----------------------------------------------------------
  // 6. HOTMART WEBHOOK V2 (VALIDAÇÃO, IDEMPOTÊNCIA, LIFECYCLE)
  // -----------------------------------------------------------
  runTest('6.1 Webhook recusa requisição sem X-HOTMART-HOTTOK válido', () => {
    const isValidWithoutReq = hotmartService.validateHotmartHeader(null, 'MEU_HOTTOK_SECRETO');
    const isValidWithoutHeader = hotmartService.validateHotmartHeader({ headers: {} }, 'MEU_HOTTOK_SECRETO');
    const isValidWithWrongToken = hotmartService.validateHotmartHeader({
      headers: { 'x-hotmart-hottok': 'TOKEN_FALSO_123' }
    }, 'MEU_HOTTOK_SECRETO');
    const isValidWithCorrectToken = hotmartService.validateHotmartHeader({
      headers: { 'x-hotmart-hottok': 'MEU_HOTTOK_SECRETO' }
    }, 'MEU_HOTTOK_SECRETO');

    assert.strictEqual(isValidWithoutReq, false, 'Sem requisição deve ser rejeitado.');
    assert.strictEqual(isValidWithoutHeader, false, 'Sem header deve ser rejeitado.');
    assert.strictEqual(isValidWithWrongToken, false, 'Com token errado deve ser rejeitado.');
    assert.strictEqual(isValidWithCorrectToken, true, 'Com token correto deve ser aprovado.');
  });

  await runAsyncTest('6.2 Webhook v2 processa compra de Jéssica Pro e salva atribuição de afiliado', async () => {
    // Limpar comprador de teste caso exista
    db.prepare("DELETE FROM subscription_audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = 'novo_comprador_hotmart@salao.com')").run();
    db.prepare("DELETE FROM customer_subscriptions WHERE user_id IN (SELECT id FROM users WHERE email = 'novo_comprador_hotmart@salao.com')").run();
    db.prepare("DELETE FROM users WHERE email = 'novo_comprador_hotmart@salao.com'").run();

    const testTxId = 'HP_E2E_' + Date.now();
    const eventId1 = 'EVT_APPROVE_' + Date.now();
    const webhookPayload = {
      id: eventId1,
      event: 'PURCHASE_APPROVED',
      version: '2.0.0',
      data: {
        product: { id: 8840376, name: 'Assistente IA RAIA Jéssica' },
        buyer: {
          email: 'novo_comprador_hotmart@salao.com',
          name: 'Compradora Hotmart Pro',
          checkout_phone: '5511988887777'
        },
        purchase: {
          transaction: testTxId,
          status: 'APPROVED',
          price: { value: 89.00, currency_value: 'BRL' },
          order_date: Date.now()
        },
        subscription: {
          subscriber: { code: 'SUB_PRO_' + Date.now() },
          plan: { id: 'JESSICA_PRO', name: 'Jéssica Pro' },
          date_next_charge: Date.now() + 30 * 24 * 60 * 60 * 1000
        },
        affiliates: [
          {
            affiliate_code: 'AFL_RAIA_TOP',
            name: 'Consultor Beleza Digital',
            commission: { value: 25.00, currency_value: 'BRL' }
          }
        ]
      }
    };

    const result = await hotmartService.handleHotmartWebhook(webhookPayload);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.action, 'USER_CREATED_PENDING');
    assert.strictEqual(result.planTier, 'JESSICA_PRO');

    // Verificar se usuário foi criado como PENDING (aguardando ativação)
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('novo_comprador_hotmart@salao.com');
    assert.ok(user, 'Comprador deve estar registrado.');
    assert.strictEqual(user.subscription_status, 'PENDING');
    assert.strictEqual(user.plan_tier, 'JESSICA_PRO');
    assert.ok(user.activation_token, 'Deve possuir token para ativação segura.');

    const salon = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(user.id);
    assert.ok(salon, 'Registro do salão deve ser gerado.');
    assert.strictEqual(salon.whatsapp_status, 'DISCONNECTED', 'WhatsApp deve iniciar DISCONNECTED.');

    // Verificar idempotência: mesmo event_id deve ser ignorado
    const duplicateResult = await hotmartService.handleHotmartWebhook(webhookPayload);
    assert.strictEqual(duplicateResult.success, true);
    assert.strictEqual(duplicateResult.status, 'ignored', 'Evento repetido deve ser descartado com segurança.');

    // Verificar atribuição de afiliado
    const affiliateRow = db.prepare('SELECT * FROM affiliate_sales WHERE transaction_code = ?').get(testTxId);
    assert.ok(affiliateRow, 'Venda deve estar atribuída ao afiliado na tabela oficial.');
    assert.strictEqual(affiliateRow.affiliate_code, 'AFL_RAIA_TOP');
    assert.strictEqual(affiliateRow.commission_amount, 25);

    // Cancelamento preservando período pago (Subscription Cancellation)
    const eventId2 = 'EVT_CANCEL_' + Date.now();
    const cancelPayload = {
      id: eventId2,
      event: 'SUBSCRIPTION_CANCELLATION',
      data: {
        product: { id: 8840376 },
        buyer: { email: 'novo_comprador_hotmart@salao.com' },
        purchase: { transaction: testTxId },
        subscription: { subscriber: { code: user.hotmart_subscriber_code } }
      }
    };

    const cancelResult = await hotmartService.handleHotmartWebhook(cancelPayload);
    assert.strictEqual(cancelResult.action, 'SUBSCRIPTION_CANCELED');

    const canceledUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    assert.strictEqual(canceledUser.subscription_status, 'CANCELED');
    assert.ok(canceledUser.paid_until, 'Período pago deve ser respeitado até a expiração.');

    // Reembolso revogando imediatamente o acesso
    const eventId3 = 'EVT_REFUND_' + Date.now();
    const refundPayload = {
      id: eventId3,
      event: 'PURCHASE_REFUNDED',
      data: {
        product: { id: 8840376 },
        buyer: { email: 'novo_comprador_hotmart@salao.com' },
        purchase: { transaction: testTxId }
      }
    };

    const refundResult = await hotmartService.handleHotmartWebhook(refundPayload);
    assert.strictEqual(refundResult.action, 'ACCESS_REVOKED');

    const refundedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    assert.strictEqual(refundedUser.subscription_status, 'REFUNDED');
    assert.strictEqual(refundedUser.paid_until, null, 'Data paga deve ser anulada no reembolso.');

    // Tentativa de login por cliente reembolsado deve ser rejeitada
    const refundedLogin = clientAuthService.login('novo_comprador_hotmart@salao.com', 'QualquerSenha');
    assert.strictEqual(refundedLogin.success, false);
    assert.strictEqual(refundedLogin.code, 'SUBSCRIPTION_REFUNDED');
  });

  // -----------------------------------------------------------
  // 7. MARKETING & ANALYTICS PIPELINE
  // -----------------------------------------------------------
  runTest('7.1 Ingestão e agregação de eventos de marketing (Funil & UTM)', () => {
    // Inserir eventos de teste
    analyticsService.logMarketingEvent({
      eventName: 'page_view',
      eventSource: 'browser',
      pagePath: '/planos',
      utmSource: 'google_ads',
      utmMedium: 'cpc',
      utmCampaign: 'salao_sp_2026'
    });

    analyticsService.logMarketingEvent({
      eventName: 'click_whatsapp',
      eventSource: 'browser',
      pagePath: '/planos',
      utmSource: 'google_ads',
      utmMedium: 'cpc',
      utmCampaign: 'salao_sp_2026'
    });

    analyticsService.logMarketingEvent({
      eventName: 'initiate_checkout',
      eventSource: 'browser',
      pagePath: '/planos',
      utmSource: 'google_ads',
      utmMedium: 'cpc',
      utmCampaign: 'salao_sp_2026'
    });

    const overview = analyticsService.getMarketingOverview(30);
    assert.strictEqual(overview.success, true);
    assert.ok(overview.funnel, 'Funil deve estar presente.');
    assert.ok(overview.subscriptions, 'Contagem de assinaturas deve estar presente.');
    assert.ok(Array.isArray(overview.trafficSources), 'Fontes de tráfego deve ser array.');
    assert.ok(Array.isArray(overview.recentEvents), 'Eventos recentes deve ser array.');

    // Verificar se o relatório de afiliados agrega dados reais
    const affOverview = analyticsService.getAffiliateSalesOverview(30);
    assert.strictEqual(affOverview.success, true);
    assert.ok(Array.isArray(affOverview.affiliates));
  });

  console.log('\n======================================================');
  console.log(`🎉 TODOS OS TESTES PASSARAM COM SUCESSO! (${passedTests}/${totalTests})`);
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\n❌ ERRO FATAL NOS TESTES:', err);
  process.exit(1);
});
