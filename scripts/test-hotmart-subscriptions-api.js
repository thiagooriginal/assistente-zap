const assert = require('assert');
const db = require('../src/database/db');
const hotmartReconciliation = require('../src/services/hotmartReconciliationService');

async function testSubscriptionsApi() {
  console.log('====================================================');
  console.log('🧪 TESTE OFICIAL: API HOTMART GET /payments/api/v1/subscriptions');
  console.log('====================================================\n');

  // 1. Create a test user with PENDING_DATE_RECONCILIATION
  const testSubCode = `SUB_OFFICIAL_${Date.now()}`;
  const testEmail = `sub.test.${Date.now()}@teste.com`;
  const insert = db.prepare(`
    INSERT INTO users (email, phone_number, name, role, plan_tier, subscription_status, hotmart_subscriber_code, needs_reconciliation)
    VALUES (?, ?, ?, 'USER', 'JESSICA_START', 'PENDING_DATE_RECONCILIATION', ?, 1)
  `).run(testEmail, `55119${Date.now().toString().slice(-8)}`, 'Cliente Teste API', testSubCode);
  const userId = insert.lastInsertRowid;

  try {
    // TEST 1: Official Hotmart API response with items array and date_next_charge
    console.log('[1/5] Testando resposta oficial Hotmart (items[0] com date_next_charge)...');
    const futureDateTs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const officialPayload = {
      items: [
        {
          subscriber_code: testSubCode,
          subscription_id: 8840123,
          status: 'ACTIVE',
          date_next_charge: futureDateTs,
          price: {
            value: 59.0,
            currency_code: 'BRL',
          },
          plan: {
            id: 9901,
            name: 'Jéssica Start',
          },
          product: {
            id: 8840376,
            name: 'Assistente Jéssica para WhatsApp',
          },
        },
      ],
      page_info: {
        total_results: 1,
      },
    };

    const res1 = await hotmartReconciliation.reconcileSubscription({
      subscriberCode: testSubCode,
      mockApiResponse: officialPayload,
    });

    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.reconciled, true);
    assert.strictEqual(res1.status, 'ACTIVE');
    assert.strictEqual(res1.paidUntil, new Date(futureDateTs).toISOString());

    const updatedUser = db.prepare('SELECT subscription_status, paid_until, needs_reconciliation FROM users WHERE id = ?').get(userId);
    assert.strictEqual(updatedUser.subscription_status, 'ACTIVE');
    assert.strictEqual(updatedUser.paid_until, new Date(futureDateTs).toISOString());
    assert.strictEqual(updatedUser.needs_reconciliation, 0);
    console.log('      ✅ Resposta oficial processada com sucesso! Status: ACTIVE, Vigência atualizada, needs_reconciliation = 0');

    // TEST 2: Official Hotmart response with empty items (subscription not found)
    console.log('\n[2/5] Testando resposta com total_results = 0 (Assinatura inexistente)...');
    const emptyPayload = {
      items: [],
      page_info: { total_results: 0 },
    };
    const res2 = await hotmartReconciliation.reconcileSubscription({
      subscriberCode: 'SUB_INEXISTENTE_9999',
      mockApiResponse: emptyPayload,
    });
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.notFound, true);
    console.log('      ✅ Resposta vazia tratada corretamente: notFound = true');

    // TEST 3: HTTP 401 Unauthorized handling (invalid credentials)
    console.log('\n[3/5] Testando caso de erro HTTP 401 (Credenciais inválidas/expiradas)...');
    const res3 = await hotmartReconciliation.reconcileSubscription({
      subscriberCode: testSubCode,
      mockError: { status: 401, body: '{"error":"unauthorized"}' },
    });
    assert.strictEqual(res3.success, false);
    assert.strictEqual(res3.statusCode, 401);
    assert.strictEqual(res3.errorCode, 'UNAUTHORIZED');
    console.log('      ✅ Erro 401 capturado com segurança: errorCode = UNAUTHORIZED');

    // TEST 4: HTTP 400 Bad Request handling
    console.log('\n[4/5] Testando caso de erro HTTP 400 (Bad Request / parâmetro inválido)...');
    const res4 = await hotmartReconciliation.reconcileSubscription({
      subscriberCode: 'INVALID_CODE!',
      mockError: { status: 400, body: '{"error":"bad_request"}' },
    });
    assert.strictEqual(res4.success, false);
    assert.strictEqual(res4.statusCode, 400);
    assert.strictEqual(res4.errorCode, 'BAD_REQUEST');
    console.log('      ✅ Erro 400 capturado com segurança: errorCode = BAD_REQUEST');

    // TEST 5: Status CANCELED mapping from Hotmart API
    console.log('\n[5/5] Testando mapeamento de status CANCELED retornado da Hotmart...');
    const canceledPayload = {
      items: [
        {
          subscriber_code: testSubCode,
          status: 'CANCELED',
          date_next_charge: futureDateTs,
        },
      ],
      page_info: { total_results: 1 },
    };
    const res5 = await hotmartReconciliation.reconcileSubscription({
      subscriberCode: testSubCode,
      mockApiResponse: canceledPayload,
    });
    assert.strictEqual(res5.success, true);
    assert.strictEqual(res5.status, 'CANCELED');
    const canceledUser = db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(userId);
    assert.strictEqual(canceledUser.subscription_status, 'CANCELED');
    console.log('      ✅ Status CANCELED mapeado e refletido com precisão no banco.');

    console.log('\n====================================================');
    console.log('🎉 TODOS OS TESTES DA API DE ASSINATURAS HOTMART APROVADOS!');
    console.log('====================================================\n');
  } finally {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
}

testSubscriptionsApi()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Falha nos testes de API Hotmart:', err);
    process.exit(1);
  });
