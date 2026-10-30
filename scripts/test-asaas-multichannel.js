'use strict';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const config = require('../src/config');
const db = require('../src/database/db');
const { app } = require('../src/server/app');
const planCatalog = require('../src/services/planCatalog');
const asaasService = require('../src/services/asaasService');
const directSales = require('../src/services/directSalesService');
const clientAuth = require('../src/services/clientAuthService');
const rateLimiters = require('../src/middlewares/rateLimiter');

async function runAsaasMultichannelTests() {
  console.log('\n============================================================');
  console.log('💳  SUITE DE TESTES MULTICANAL: ASSINATURAS ASAAS & HOTMART');
  console.log('============================================================\n');

  // Configure test webhook secret if empty
  const TEST_WEBHOOK_SECRET = 'test_asaas_secret_token_raia_2026';
  config.asaasWebhookSecret = TEST_WEBHOOK_SECRET;

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let passed = 0;
  let total = 0;

  function pass(name) {
    passed++;
    total++;
    console.log(`  ✅ [PASS] ${name}`);
  }

  function fail(name, err) {
    total++;
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
    throw err;
  }

  let originalFindOrCreate, originalCreateSub, originalListPayments, originalGetPix, originalCancelSub;

  try {
    // Reset rate limiters
    Object.values(rateLimiters).forEach(l => l && typeof l.reset === 'function' && l.reset());

    // Clean test data from DB respecting Foreign Keys
    db.prepare("DELETE FROM direct_sales_events WHERE contract_id IN (SELECT id FROM direct_sales_contracts WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@asaas.test' OR email LIKE '%@multichannel.test'))").run();
    db.prepare("DELETE FROM direct_sales_payments WHERE contract_id IN (SELECT id FROM direct_sales_contracts WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@asaas.test' OR email LIKE '%@multichannel.test'))").run();
    db.prepare("DELETE FROM direct_sales_contracts WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@asaas.test' OR email LIKE '%@multichannel.test')").run();
    db.prepare("DELETE FROM client_staff WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@asaas.test' OR email LIKE '%@multichannel.test')").run();
    db.prepare("DELETE FROM client_salons WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@asaas.test' OR email LIKE '%@multichannel.test')").run();
    db.prepare("DELETE FROM users WHERE email LIKE '%@asaas.test' OR email LIKE '%@multichannel.test'").run();
    db.prepare("DELETE FROM asaas_webhook_events WHERE event_id LIKE 'TEST_%'").run();

    // Sandbox / Mock Asaas Service for testing to protect production
    originalFindOrCreate = asaasService.findOrCreateCustomer;
    originalCreateSub = asaasService.createSubscription;
    originalListPayments = asaasService.listSubscriptionPayments;
    originalGetPix = asaasService.getPaymentPixQrCode;
    originalCancelSub = asaasService.cancelSubscription;

    asaasService.findOrCreateCustomer = async ({ name, phone, email, cpfCnpj }) => {
      return { id: 'cus_sandbox_001', name, mobilePhone: phone, email, cpfCnpj };
    };
    asaasService.createSubscription = async (params) => {
      return { id: 'sub_sandbox_001', customer: params.customerId, value: params.value, status: 'ACTIVE' };
    };
    asaasService.listSubscriptionPayments = async (subId) => {
      return {
        data: [{
          id: 'pay_sandbox_001',
          customer: 'cus_sandbox_001',
          subscription: subId,
          value: 79.00,
          status: 'PENDING',
          dueDate: '2026-11-30',
          invoiceUrl: 'https://sandbox.asaas.com/i/pay_sandbox_001',
          bankSlipUrl: 'https://sandbox.asaas.com/b/pay_sandbox_001',
        }]
      };
    };
    asaasService.getPaymentPixQrCode = async (paymentId) => {
      return {
        encodedImage: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        payload: '00020126580014BR.GOV.BCB.PIX0136test-payload-sandbox-pix520400005303986540579.005802BR5925RAIA AGENTES6009SAO PAULO62070503***6304ABCD'
      };
    };
    asaasService.cancelSubscription = async (subId) => {
      return { deleted: true, id: subId };
    };

    // -------------------------------------------------------------
    // TEST 1: Catálogo Oficial dos 3 Planos e Preços de Feira / Padrão
    // -------------------------------------------------------------
    console.log('📌 Teste 1: Regras e Preços do Catálogo Multicanal');
    {
      // Entrada (JESSICA_START): R$ 59 feira / R$ 89 fora
      const qStartFair = planCatalog.quote('JESSICA_START', 'FAIR_2026');
      assert.strictEqual(qStartFair.monthlyCents, 5900, 'Entrada feira = R$ 59,00');
      assert.strictEqual(qStartFair.setupCents, 0, 'Entrada feira setup = R$ 0');
      assert.strictEqual(qStartFair.includedProfessionals, 1);

      const qStartStd = planCatalog.quote('JESSICA_START', 'STANDARD');
      assert.strictEqual(qStartStd.monthlyCents, 8900, 'Entrada padrão = R$ 89,00');
      assert.strictEqual(qStartStd.setupCents, 35000, 'Entrada padrão setup = R$ 350');

      // Intermediário (JESSICA_INTERMEDIATE): R$ 79 feira / R$ 109 fora
      const qInterFair = planCatalog.quote('JESSICA_INTERMEDIATE', 'FAIR_2026');
      assert.strictEqual(qInterFair.monthlyCents, 7900, 'Intermediário feira = R$ 79,00');
      assert.strictEqual(qInterFair.setupCents, 0);
      assert.strictEqual(qInterFair.includedProfessionals, 1);
      assert.ok(planCatalog.includesFeature('JESSICA_INTERMEDIATE', 'financial_dashboard'));
      assert.strictEqual(planCatalog.includesFeature('JESSICA_INTERMEDIATE', 'marketing_campaigns'), false);

      const qInterStd = planCatalog.quote('JESSICA_INTERMEDIATE', 'STANDARD');
      assert.strictEqual(qInterStd.monthlyCents, 10900, 'Intermediário padrão = R$ 109,00');
      assert.strictEqual(qInterStd.setupCents, 35000);

      // Pró (JESSICA_PRO): R$ 99 feira / R$ 139 fora
      const qProFair = planCatalog.quote('JESSICA_PRO', 'FAIR_2026');
      assert.strictEqual(qProFair.monthlyCents, 9900, 'Pró feira = R$ 99,00');
      assert.strictEqual(qProFair.setupCents, 0);
      assert.strictEqual(qProFair.includedProfessionals, 2);
      assert.ok(planCatalog.includesFeature('JESSICA_PRO', 'financial_dashboard'));
      assert.ok(planCatalog.includesFeature('JESSICA_PRO', 'marketing_campaigns'));

      const qProStd = planCatalog.quote('JESSICA_PRO', 'STANDARD');
      assert.strictEqual(qProStd.monthlyCents, 13900, 'Pró padrão = R$ 139,00');
      assert.strictEqual(qProStd.setupCents, 35000);

      // Profissional adicional: R$ 19,90 cada
      const qProExtra = planCatalog.quote('JESSICA_PRO', 'FAIR_2026', 2);
      assert.strictEqual(qProExtra.monthlyCents, 9900 + (2 * 1990), 'R$ 99 + 2x R$ 19,90 = R$ 138,80');

      pass('Catálogo oficial de planos, feira, implantação e adicionais validado');
    }

    // -------------------------------------------------------------
    // TEST 2: Cadastro Direto Asaas inicia PENDING sem acesso liberado
    // -------------------------------------------------------------
    console.log('\n📌 Teste 2: Contratação Asaas inicia PENDING e Bloqueia Acesso Não Pago');
    let testContractId = null;
    let testUserId = null;
    {
      const contract = await directSales.createDirectContract({
        name: 'Studio Teste Asaas',
        email: 'salao.asaas@multichannel.test',
        phone: '11988880001',
        cpfCnpj: '12345678909',
        planTier: 'JESSICA_INTERMEDIATE',
        promotion: 'FAIR_2026',
        paymentMethod: 'BOLETO',
        extraProfessionals: 0,
      }, 1);

      assert.ok(contract.id, 'Contrato deve ser criado');
      assert.strictEqual(contract.paymentStatus, 'AWAITING_PAYMENT');
      assert.strictEqual(contract.subscriptionStatus, 'INACTIVE');
      testContractId = contract.id;
      testUserId = contract.userId;

      // Check DB
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(testUserId);
      assert.strictEqual(user.subscription_status, 'INACTIVE');
      assert.strictEqual(user.subscription_origin, 'ASAAS');
      assert.strictEqual(user.paid_until, null, 'paid_until deve ser nulo antes do pagamento');

      // Tentar login sem pagamento -> deve falhar
      const loginAttempt = clientAuth.login('salao.asaas@multichannel.test', 'SenhaForte123!');
      assert.strictEqual(loginAttempt.success, false);
      assert.ok(loginAttempt.code === 'PAYMENT_REQUIRED' || loginAttempt.code === 'SUBSCRIPTION_INACTIVE');

      pass('Cliente Asaas inicia INACTIVE / AWAITING_PAYMENT e acesso é bloqueado');
    }

    // -------------------------------------------------------------
    // TEST 3: Proteção de Duplicidade e Isolamento da Hotmart
    // -------------------------------------------------------------
    console.log('\n📌 Teste 3: Proteção contra Duplicidade e Cobrança Dupla Hotmart');
    {
      // Criar usuário Hotmart existente
      db.prepare(`
        INSERT INTO users (name, email, phone_number, role, plan_tier, subscription_status, subscription_origin, hotmart_subscriber_code)
        VALUES ('Cliente Hotmart Ativo', 'cliente.hotmart@multichannel.test', '5511988880002', 'USER', 'JESSICA_START', 'ACTIVE', 'HOTMART', 'HMT-SUB-001')
      `).run();

      // Tentativa de criar contrato Asaas para usuário da Hotmart -> DEVE LANÇAR ERRO
      let errorThrown = false;
      try {
        await directSales.createDirectContract({
          name: 'Tentativa Duplicada',
          email: 'cliente.hotmart@multichannel.test',
          phone: '11988880002',
          planTier: 'JESSICA_PRO',
          paymentMethod: 'BOLETO'
        }, 1);
      } catch (err) {
        errorThrown = true;
        assert.ok(err.message.includes('Hotmart') || err.message.includes('já possui assinatura'), 'Deve avisar sobre assinatura Hotmart existente');
      }
      assert.ok(errorThrown, 'Não deve permitir criar assinatura Asaas para cliente Hotmart');

      pass('Tentativa de dupla cobrança em cliente Hotmart prevenida com sucesso');
    }

    // -------------------------------------------------------------
    // TEST 4: Segurança do Webhook Asaas (Token Obrigatório & Falso Rejeitado)
    // -------------------------------------------------------------
    console.log('\n📌 Teste 4: Validação Obrigatória de Token do Webhook Asaas');
    {
      // 1. Chamada sem token -> 401
      const resNoToken = await fetch(`${baseUrl}/api/webhooks/asaas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'PAYMENT_CONFIRMED' })
      });
      assert.strictEqual(resNoToken.status, 401, 'Sem token deve retornar 401');

      // 2. Chamada com token incorreto -> 401
      const resWrongToken = await fetch(`${baseUrl}/api/webhooks/asaas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': 'token_completamente_falso_e_invalido'
        },
        body: JSON.stringify({ event: 'PAYMENT_CONFIRMED' })
      });
      assert.strictEqual(resWrongToken.status, 401, 'Token falso deve retornar 401');

      pass('Webhooks não autenticados ou com token falso rejeitados com 401');
    }

    // -------------------------------------------------------------
    // TEST 5: Idempotência de Eventos no Webhook Asaas
    // -------------------------------------------------------------
    console.log('\n📌 Teste 5: Idempotência Obrigatória por Evento');
    {
      const fakeEventId = 'TEST_EVT_' + Date.now();
      const fakePaymentId = 'TEST_PAY_' + Date.now();
      const payload = {
        id: fakeEventId,
        event: 'PAYMENT_CONFIRMED',
        payment: {
          id: fakePaymentId,
          customer: 'cus_test_001',
          value: 79.00,
          status: 'CONFIRMED',
          dueDate: '2026-11-30'
        }
      };

      // 1ª Chamada -> 200 OK
      const res1 = await fetch(`${baseUrl}/api/webhooks/asaas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': TEST_WEBHOOK_SECRET
        },
        body: JSON.stringify(payload)
      });
      assert.strictEqual(res1.status, 200);
      const json1 = await res1.json();
      assert.strictEqual(json1.success, true);
      assert.strictEqual(json1.duplicate, undefined);

      // 2ª Chamada idêntica -> 200 OK com duplicate: true
      const res2 = await fetch(`${baseUrl}/api/webhooks/asaas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': TEST_WEBHOOK_SECRET
        },
        body: JSON.stringify(payload)
      });
      assert.strictEqual(res2.status, 200);
      const json2 = await res2.json();
      assert.strictEqual(json2.success, true);
      assert.strictEqual(json2.duplicate, true, 'Evento repetido deve ser marcado como duplicate');

      pass('Idempotência de Webhook Asaas validada com sucesso');
    }

    // -------------------------------------------------------------
    // TEST 6: Confirmação de 1º Pagamento via Webhook -> Ativação de Conta
    // -------------------------------------------------------------
    console.log('\n📌 Teste 6: Webhook Confirma Pagamento -> Gera Ativação de 48h');
    let activationToken = null;
    {
      const paymentId = 'pay_asaas_' + Date.now();
      const subId = 'sub_asaas_' + Date.now();

      // Associar usuário ao subId no banco para simulação
      db.prepare(`
        UPDATE users
        SET asaas_subscription_id = ?, asaas_payment_id = ?
        WHERE id = ?
      `).run(subId, paymentId, testUserId);

      db.prepare(`
        UPDATE direct_sales_contracts
        SET asaas_subscription_id = ?, asaas_payment_id = ?
        WHERE id = ?
      `).run(subId, paymentId, testContractId);

      const res = await fetch(`${baseUrl}/api/webhooks/asaas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': TEST_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          id: 'TEST_CONFIRM_' + Date.now(),
          event: 'PAYMENT_CONFIRMED',
          payment: {
            id: paymentId,
            subscription: subId,
            value: 79.00,
            status: 'CONFIRMED',
            dueDate: '2026-11-30'
          }
        })
      });

      assert.strictEqual(res.status, 200);

      // Verificar que usuário agora está PENDING e tem activation_token
      const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(testUserId);
      assert.strictEqual(updatedUser.subscription_status, 'PENDING');
      assert.ok(updatedUser.paid_until, 'paid_until deve ser preenchido');
      assert.ok(updatedUser.activation_token, 'activation_token deve ser gerado');
      activationToken = updatedUser.activation_token;

      // Ativar conta com nova senha
      const actRes = await fetch(`${baseUrl}/api/cliente/auth/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: activationToken,
          password: 'SenhaForteAsaas2026!'
        })
      });
      const actJson = await actRes.json();
      assert.strictEqual(actRes.status, 200);
      assert.strictEqual(actJson.success, true);

      // Usuário agora deve estar ACTIVE
      const activeUser = db.prepare('SELECT * FROM users WHERE id = ?').get(testUserId);
      assert.strictEqual(activeUser.subscription_status, 'ACTIVE');

      pass('1º pagamento Asaas confirmado, token 48h gerado e conta ativada');
    }

    // -------------------------------------------------------------
    // TEST 7: Login e Sessão Segura HttpOnly
    // -------------------------------------------------------------
    console.log('\n📌 Teste 7: Login do Cliente Asaas com Sessão Segura');
    let clientCookie = null;
    {
      const loginRes = await fetch(`${baseUrl}/api/cliente/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'salao.asaas@multichannel.test',
          password: 'SenhaForteAsaas2026!'
        })
      });
      const loginJson = await loginRes.json();
      assert.strictEqual(loginRes.status, 200);
      assert.strictEqual(loginJson.success, true);

      const rawCookie = loginRes.headers.get('set-cookie');
      assert.ok(rawCookie && rawCookie.includes('client_auth_token='), 'Deve emitir cookie client_auth_token');
      assert.ok(rawCookie.includes('HttpOnly'), 'Cookie deve ter flag HttpOnly');
      clientCookie = rawCookie.split(';')[0];

      // Acessar perfil com o cookie
      const profileRes = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Cookie': clientCookie }
      });
      const profileJson = await profileRes.json();
      assert.strictEqual(profileRes.status, 200);
      assert.strictEqual(profileJson.profile.email, 'salao.asaas@multichannel.test');
      assert.strictEqual(profileJson.profile.subscriptionOrigin, 'ASAAS');

      pass('Login Asaas bem-sucedido com cookie HttpOnly e perfil verificado');
    }

    // -------------------------------------------------------------
    // TEST 8: Permissões de Planos na Área de Membros (Intermediário vs Pró)
    // -------------------------------------------------------------
    console.log('\n📌 Teste 8: Validação de Permissões (Dashboard vs Campanhas)');
    {
      // Nosso cliente teste é JESSICA_INTERMEDIATE
      // 1. Dashboard Financeiro deve ser LIBERADO no Intermediário
      const dashRes = await fetch(`${baseUrl}/api/cliente/pro/dashboard`, {
        headers: { 'Cookie': clientCookie }
      });
      const dashJson = await dashRes.json();
      assert.strictEqual(dashRes.status, 200, 'Intermediário tem acesso ao Dashboard Financeiro');
      assert.strictEqual(dashJson.success, true);

      // 2. Limite de profissionais (1 profissional incluso no Intermediário)
      // O sistema já seedou o "Profissional Principal" (1 incluído)
      const staffList = await fetch(`${baseUrl}/api/cliente/staff`, {
        headers: { 'Cookie': clientCookie }
      });
      const staffListJson = await staffList.json();
      assert.strictEqual(staffListJson.staff.length, 1, '1 profissional principal já incluso');

      // Tentar adicionar 2º profissional sem contratar extra -> DEVE RETORNAR 403
      const staffBlocked = await fetch(`${baseUrl}/api/cliente/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': clientCookie },
        body: JSON.stringify({ name: 'Cabeleireira Ana', specialty: 'Coloração' })
      });
      assert.strictEqual(staffBlocked.status, 403, 'Exceder limite de profissionais sem extra deve retornar 403');

      // Contratar 1 profissional extra no banco (+ R$ 19,90) -> Deve liberar adicionar o 2º
      db.prepare('UPDATE users SET extra_professionals = 1 WHERE id = ?').run(testUserId);
      const staffAllowed = await fetch(`${baseUrl}/api/cliente/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': clientCookie },
        body: JSON.stringify({ name: 'Cabeleireira Ana', specialty: 'Coloração' })
      });
      assert.strictEqual(staffAllowed.status, 200, 'Com profissional extra contratado, adição deve ser 200');

      pass('Permissões de Dashboard e limites de profissionais validados');
    }

    // -------------------------------------------------------------
    // TEST 9: Pagamento em Atraso (OVERDUE) e Renovação Recorrente
    // -------------------------------------------------------------
    console.log('\n📌 Teste 9: Tratamento de Mensalidade em Atraso & Renovação Recorrente');
    {
      const user = db.prepare('SELECT asaas_subscription_id, asaas_payment_id FROM users WHERE id = ?').get(testUserId);

      // 1. Simular evento PAYMENT_OVERDUE via Webhook
      await fetch(`${baseUrl}/api/webhooks/asaas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': TEST_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          id: 'TEST_OVERDUE_' + Date.now(),
          event: 'PAYMENT_OVERDUE',
          payment: {
            id: user.asaas_payment_id,
            subscription: user.asaas_subscription_id,
            status: 'OVERDUE'
          }
        })
      });

      // Status no banco deve mudar para OVERDUE
      const overdueUser = db.prepare('SELECT subscription_status, paid_until FROM users WHERE id = ?').get(testUserId);
      assert.strictEqual(overdueUser.subscription_status, 'OVERDUE');

      // Se paid_until expirar -> acesso é bloqueado
      db.prepare("UPDATE users SET paid_until = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(testUserId);
      const blockedRes = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Cookie': clientCookie }
      });
      assert.strictEqual(blockedRes.status, 403, 'Acesso com paid_until expirado em atraso deve ser 403');

      // 2. Simular Renovação Recorrente Aprovada (PAYMENT_RECEIVED)
      const newPayId = 'pay_renew_' + Date.now();
      await fetch(`${baseUrl}/api/webhooks/asaas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': TEST_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          id: 'TEST_RENEW_' + Date.now(),
          event: 'PAYMENT_RECEIVED',
          payment: {
            id: newPayId,
            subscription: user.asaas_subscription_id,
            value: 79.00,
            status: 'RECEIVED',
            dueDate: '2026-12-30'
          }
        })
      });

      // Status deve voltar para ACTIVE e vigência restaurada
      const renewedUser = db.prepare('SELECT subscription_status, paid_until FROM users WHERE id = ?').get(testUserId);
      assert.strictEqual(renewedUser.subscription_status, 'ACTIVE');
      assert.ok(Date.parse(renewedUser.paid_until) > Date.now(), 'paid_until deve ser renovado');

      // Acesso ao perfil deve voltar a funcionar imediatamente
      const unblockedRes = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Cookie': clientCookie }
      });
      assert.strictEqual(unblockedRes.status, 200, 'Acesso liberado novamente após renovação');

      pass('Ciclo de atraso (overdue), bloqueio e renovação recorrente validado');
    }

    // -------------------------------------------------------------
    // TEST 10: Cancelamento Sem Fidelidade (SUBSCRIPTION_DELETED)
    // -------------------------------------------------------------
    console.log('\n📌 Teste 10: Cancelamento Sem Fidelidade (Vigência Paga Preservada)');
    {
      const user = db.prepare('SELECT asaas_subscription_id, paid_until FROM users WHERE id = ?').get(testUserId);
      const paidUntilBefore = user.paid_until;

      // Simular Webhook de Cancelamento de Assinatura Asaas
      await fetch(`${baseUrl}/api/webhooks/asaas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': TEST_WEBHOOK_SECRET
        },
        body: JSON.stringify({
          id: 'TEST_CANCEL_' + Date.now(),
          event: 'SUBSCRIPTION_DELETED',
          subscription: {
            id: user.asaas_subscription_id,
            status: 'INACTIVE'
          }
        })
      });

      const canceledUser = db.prepare('SELECT subscription_status, paid_until FROM users WHERE id = ?').get(testUserId);
      assert.strictEqual(canceledUser.subscription_status, 'CANCELED');
      assert.strictEqual(canceledUser.paid_until, paidUntilBefore, 'paid_until NÃO deve ser encurtado (sem fidelidade)');

      // Durante a vigência paga, cliente ainda acessa
      const stillActiveRes = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Cookie': clientCookie }
      });
      assert.strictEqual(stillActiveRes.status, 200, 'Cliente mantém acesso durante vigência paga');

      // Quando a vigência termina, acesso é revogado
      db.prepare("UPDATE users SET paid_until = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(testUserId);
      const postExpiredRes = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Cookie': clientCookie }
      });
      assert.strictEqual(postExpiredRes.status, 403, 'Acesso bloqueado após fim do período pago de contrato cancelado');

      pass('Cancelamento sem fidelidade preserva período pago e bloqueia após expiração');
    }

    // -------------------------------------------------------------
    // TEST 11: Listagem e Filtro de Clientes por Origem (HOTMART / ASAAS)
    // -------------------------------------------------------------
    console.log('\n📌 Teste 11: Filtro Administrativo por Origem (HOTMART vs ASAAS)');
    {
      const allUsers = directSales.listContracts();
      assert.ok(Array.isArray(allUsers));

      const adminHotmartUsers = clientAuth.getSanitizedUser(1); // Check sanitized structure
      assert.ok(adminHotmartUsers !== undefined);

      // Usar userService com filtro origin
      const userService = require('../src/services/userService');
      const hotmartClients = userService.getAllUsers({ origin: 'HOTMART' });
      assert.ok(hotmartClients.every(u => u.subscriptionOrigin === 'HOTMART'), 'Todos devem ter origem HOTMART');

      const asaasClients = userService.getAllUsers({ origin: 'ASAAS' });
      assert.ok(asaasClients.some(u => u.id === testUserId), 'Cliente teste deve estar na lista Asaas');
      assert.ok(asaasClients.every(u => u.subscriptionOrigin === 'ASAAS' || u.subscription_origin === 'DIRECT'), 'Todos devem ter origem ASAAS');

      pass('Filtro administrativo de clientes HOTMART e ASAAS validado com sucesso');
    }

    console.log('\n============================================================');
    console.log(`🎉 TODOS OS ${passed} TESTES MULTICANAL PASSARAM COM SUCESSO!`);
    console.log('============================================================\n');

  } catch (err) {
    console.error('\n❌ Erro durante execução da suite de testes:', err);
    process.exitCode = 1;
  } finally {
    if (originalFindOrCreate) asaasService.findOrCreateCustomer = originalFindOrCreate;
    if (originalCreateSub) asaasService.createSubscription = originalCreateSub;
    if (originalListPayments) asaasService.listSubscriptionPayments = originalListPayments;
    if (originalGetPix) asaasService.getPaymentPixQrCode = originalGetPix;
    if (originalCancelSub) asaasService.cancelSubscription = originalCancelSub;
    server.close();
  }
}

if (require.main === module) {
  runAsaasMultichannelTests().then(() => {
    process.exit(process.exitCode || 0);
  });
}

module.exports = { runAsaasMultichannelTests };
