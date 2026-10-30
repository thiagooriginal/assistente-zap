/**
 * RAIA AGENTES — Hotmart Webhook 2.0 Official Payloads Test Suite
 * 
 * Tests strictly against official Hotmart Webhook 2.0 payloads:
 * 1. Root structure (id UUID, creation_date in ms, event name, version 2.0.0, data)
 * 2. Official event names (PURCHASE_APPROVED, SWITCH_PLAN, PURCHASE_DELAYED, SUBSCRIPTION_CANCELLATION, PURCHASE_REFUNDED, PURCHASE_CHARGEBACK)
 * 3. Plan resolution by official IDs (not by price or arbitrary strings)
 * 4. Real dates from date_next_charge in milliseconds (no arbitrary +30 days)
 * 5. Out-of-order and duplicate events rejection
 * 6. High-entropy demo account credential validation
 */

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/database/db');
const hotmartService = require('../src/services/hotmartService');
const hotmartReconciliation = require('../src/services/hotmartReconciliationService');
const clientAuth = require('../src/services/clientAuthService');
const config = require('../src/config');

console.log('\n==================================================================');
console.log('🧪 AUDITORIA HOTMART WEBHOOK 2.0 — PAYLOADS OFICIAIS & SEGURANÇA');
console.log('==================================================================\n');

async function runHotmart2Suite() {
  const buyerEmail = `auditoria_hotmart_${Date.now()}@teste.com`;
  const buyerPhone = `55119${Date.now().toString().slice(-8)}`;
  const transactionCode = `HP_AUDIT_${Date.now()}`;
  const subscriberCode = `SUB_AUDIT_${Date.now()}`;

  // Clean test user if exists
  db.prepare('DELETE FROM users WHERE LOWER(email) = ? OR phone_number = ?').run(buyerEmail, buyerPhone);

  // -------------------------------------------------------------
  // TEST 1: PURCHASE_APPROVED (Official 2.0 Payload with date_next_charge)
  // -------------------------------------------------------------
  console.log('🔹 Teste 1: PURCHASE_APPROVED com date_next_charge real...');
  const t1Date = Date.now();
  const nextMonthTs = t1Date + 28 * 24 * 60 * 60 * 1000; // Exact 28-day billing cycle (e.g., February)
  const expectedNextChargeIso = new Date(nextMonthTs).toISOString();

  const approvedPayload = {
    id: `evt_uuid_${crypto.randomUUID()}`,
    creation_date: t1Date,
    event: 'PURCHASE_APPROVED',
    version: '2.0.0',
    data: {
      product: {
        id: 8840376,
        ucode: 'c3d987e2-1234-4567-89ab-cdef01234567',
        name: 'Assistente Jéssica para WhatsApp'
      },
      buyer: {
        email: buyerEmail,
        name: 'Dra. Camila Silveira',
        checkout_phone: buyerPhone
      },
      purchase: {
        transaction: transactionCode,
        order_date: t1Date,
        approved_date: t1Date,
        status: 'APPROVED',
        price: {
          value: 59.00,
          currency_value: 'BRL'
        },
        payment: {
          type: 'CREDIT_CARD',
          installments_number: 1
        },
        offer: {
          code: 'jessica_start'
        },
        recurrence: {
          number: 1
        }
      },
      subscription: {
        subscriber: {
          code: subscriberCode
        },
        status: 'ACTIVE',
        plan: {
          id: 9901,
          name: 'Jéssica Start'
        },
        date_next_charge: nextMonthTs // Milliseconds timestamp
      },
      affiliates: [
        {
          affiliate_code: 'AFL_OFICIAL_01',
          name: 'Parceiro Certificado RAIA',
          commission: {
            value: 20.00,
            currency_value: 'BRL'
          }
        }
      ]
    }
  };

  const res1 = await hotmartService.processWebhook(approvedPayload);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.action, 'USER_CREATED_PENDING');
  assert.strictEqual(res1.planTier, 'JESSICA_START');

  const userAfterApproved = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(buyerEmail);
  assert.ok(userAfterApproved, 'Usuário deve existir no banco.');
  assert.strictEqual(userAfterApproved.subscription_status, 'PENDING');
  assert.strictEqual(userAfterApproved.paid_until, expectedNextChargeIso, 'paid_until DEVE refletir exatamente date_next_charge da Hotmart.');
  console.log(`  ✅ [PASS] Compra aprovada registrada com vigência exata da Hotmart: ${userAfterApproved.paid_until}`);

  // -------------------------------------------------------------
  // TEST 2: IDEMPOTENCY (Repeating identical payload id)
  // -------------------------------------------------------------
  console.log('🔹 Teste 2: Idempotência com mesmo event id...');
  const resDuplicate = await hotmartService.processWebhook(approvedPayload);
  assert.strictEqual(resDuplicate.success, true);
  assert.strictEqual(resDuplicate.duplicated, true);
  assert.strictEqual(resDuplicate.status, 'ignored');
  console.log('  ✅ [PASS] Evento duplicado ignorado sem alterações.');

  // -------------------------------------------------------------
  // TEST 3: SWITCH_PLAN (Official 2.0 Plan Upgrade from Start to Pro)
  // -------------------------------------------------------------
  console.log('🔹 Teste 3: SWITCH_PLAN (Upgrade para Jéssica Pro)...');
  const t2Date = t1Date + 5 * 24 * 60 * 60 * 1000;
  const upgradeNextChargeTs = nextMonthTs; // Preserves cycle

  const switchPlanPayload = {
    id: `evt_uuid_${crypto.randomUUID()}`,
    creation_date: t2Date,
    event: 'SWITCH_PLAN',
    version: '2.0.0',
    data: {
      switch_plan_date: t2Date,
      product: {
        id: 8840376,
        name: 'Assistente Jéssica para WhatsApp'
      },
      subscription: {
        subscriber_code: subscriberCode,
        status: 'ACTIVE',
        date_next_charge: upgradeNextChargeTs,
        plan: {
          id: 9902, // Pro Plan ID
          name: 'Jéssica Pro'
        },
        user: {
          email: buyerEmail
        }
      }
    }
  };

  const resSwitch = await hotmartService.processWebhook(switchPlanPayload);
  assert.strictEqual(resSwitch.success, true);
  assert.strictEqual(resSwitch.action, 'PLAN_SWITCHED');
  assert.strictEqual(resSwitch.planTier, 'JESSICA_PRO');

  const userAfterSwitch = db.prepare('SELECT plan_tier FROM users WHERE LOWER(email) = ?').get(buyerEmail);
  assert.strictEqual(userAfterSwitch.plan_tier, 'JESSICA_PRO', 'Plano deve ser atualizado para JESSICA_PRO.');
  console.log('  ✅ [PASS] Upgrade de plano executado: usuário agora é JESSICA_PRO.');

  // -------------------------------------------------------------
  // TEST 4: PURCHASE_DELAYED / SUBSCRIPTION_OVERDUE (Inadimplência)
  // -------------------------------------------------------------
  console.log('🔹 Teste 4: PURCHASE_DELAYED (Atraso / Inadimplência)...');
  const t3Date = t2Date + 25 * 24 * 60 * 60 * 1000;

  const delayedPayload = {
    id: `evt_uuid_${crypto.randomUUID()}`,
    creation_date: t3Date,
    event: 'PURCHASE_DELAYED',
    version: '2.0.0',
    data: {
      product: { id: 8840376 },
      buyer: { email: buyerEmail },
      purchase: { transaction: transactionCode },
      subscription: { subscriber: { code: subscriberCode } }
    }
  };

  const resDelayed = await hotmartService.processWebhook(delayedPayload);
  assert.strictEqual(resDelayed.success, true);
  assert.strictEqual(resDelayed.action, 'SUBSCRIPTION_OVERDUE');

  const userAfterDelayed = db.prepare('SELECT subscription_status FROM users WHERE LOWER(email) = ?').get(buyerEmail);
  assert.strictEqual(userAfterDelayed.subscription_status, 'OVERDUE');
  console.log('  ✅ [PASS] Status atualizado para OVERDUE.');

  // -------------------------------------------------------------
  // TEST 5: SUBSCRIPTION_CANCELLATION (Respeito ao período pago date_next_charge)
  // -------------------------------------------------------------
  console.log('🔹 Teste 5: SUBSCRIPTION_CANCELLATION (Cancelamento com vigência paga)...');
  const t4Date = t3Date + 2 * 24 * 60 * 60 * 1000;
  const accessExpiryTs = t4Date + 10 * 24 * 60 * 60 * 1000; // Remaining 10 days
  const accessExpiryIso = new Date(accessExpiryTs).toISOString();

  const cancelPayload = {
    id: `evt_uuid_${crypto.randomUUID()}`,
    creation_date: t4Date,
    event: 'SUBSCRIPTION_CANCELLATION',
    version: '2.0.0',
    data: {
      cancellation_date: t4Date,
      date_next_charge: accessExpiryTs, // Official Hotmart date representing last date of access
      product: { id: 8840376 },
      subscriber: {
        code: subscriberCode,
        email: buyerEmail,
        name: 'Dra. Camila Silveira'
      }
    }
  };

  const resCancel = await hotmartService.processWebhook(cancelPayload);
  assert.strictEqual(resCancel.success, true);
  assert.strictEqual(resCancel.action, 'SUBSCRIPTION_CANCELED');

  const userAfterCancel = db.prepare('SELECT subscription_status, paid_until FROM users WHERE LOWER(email) = ?').get(buyerEmail);
  assert.strictEqual(userAfterCancel.subscription_status, 'CANCELED');
  assert.strictEqual(userAfterCancel.paid_until, accessExpiryIso, 'Deve manter acesso até date_next_charge da Hotmart.');
  console.log(`  ✅ [PASS] Cancelamento preserva acesso pago até: ${userAfterCancel.paid_until}`);

  // -------------------------------------------------------------
  // TEST 6: PURCHASE_REFUNDED (Revogação imediata)
  // -------------------------------------------------------------
  console.log('🔹 Teste 6: PURCHASE_REFUNDED (Reembolso com revogação imediata)...');
  const t5Date = t4Date + 1 * 24 * 60 * 60 * 1000;

  const refundPayload = {
    id: `evt_uuid_${crypto.randomUUID()}`,
    creation_date: t5Date,
    event: 'PURCHASE_REFUNDED',
    version: '2.0.0',
    data: {
      product: { id: 8840376 },
      buyer: { email: buyerEmail },
      purchase: { transaction: transactionCode }
    }
  };

  const resRefund = await hotmartService.processWebhook(refundPayload);
  assert.strictEqual(resRefund.success, true);
  assert.strictEqual(resRefund.action, 'ACCESS_REVOKED');

  const userAfterRefund = db.prepare('SELECT subscription_status, paid_until FROM users WHERE LOWER(email) = ?').get(buyerEmail);
  assert.strictEqual(userAfterRefund.subscription_status, 'REFUNDED');
  assert.strictEqual(userAfterRefund.paid_until, null, 'paid_until deve ser anulado no reembolso.');
  console.log('  ✅ [PASS] Acesso revogado imediatamente e vigência zerada.');

  // -------------------------------------------------------------
  // TEST 7: OUT-OF-ORDER EVENT REJECTION
  // Simulating an older delayed approval (t1Date) arriving AFTER refund (t5Date)
  // -------------------------------------------------------------
  console.log('🔹 Teste 7: Rejeição de evento atrasado fora de ordem (Out-of-Order)...');
  const lateOlderApproval = {
    id: `evt_uuid_${crypto.randomUUID()}`,
    creation_date: t1Date + 1000, // Older than t5Date (refund)
    event: 'PURCHASE_APPROVED',
    version: '2.0.0',
    data: {
      product: { id: 8840376 },
      buyer: { email: buyerEmail },
      purchase: { transaction: transactionCode },
      subscription: { subscriber: { code: subscriberCode }, date_next_charge: nextMonthTs }
    }
  };

  const resLate = await hotmartService.processWebhook(lateOlderApproval);
  assert.strictEqual(resLate.success, true);
  assert.strictEqual(resLate.outOfOrder, true, 'Deve ser identificado como fora de ordem.');
  assert.strictEqual(resLate.status, 'ignored');

  const userUnchanged = db.prepare('SELECT subscription_status FROM users WHERE LOWER(email) = ?').get(buyerEmail);
  assert.strictEqual(userUnchanged.subscription_status, 'REFUNDED', 'Status REFUNDED NÃO pode ser revertido por evento mais antigo.');
  console.log('  ✅ [PASS] Evento antigo fora de ordem descartado; status REFUNDED preservado.');

  // -------------------------------------------------------------
  // TEST 8: PLAN IDENTIFICATION BY REAL HOTMART PLAN ID
  // -------------------------------------------------------------
  console.log('🔹 Teste 8: Resolução de plano por Plan ID oficial Hotmart...');
  // Override config plan IDs for testing
  config.hotmartPlanStartId = 'HP_PLAN_START_9901';
  config.hotmartPlanProId = 'HP_PLAN_PRO_9902';

  const testStartPayload = { subscription: { plan: { id: 'HP_PLAN_START_9901' } }, purchase: { price: { value: 999.00 } } };
  const testProPayload = { subscription: { plan: { id: 'HP_PLAN_PRO_9902' } }, purchase: { price: { value: 1.00 } } };

  assert.strictEqual(hotmartService.resolvePlanTier(testStartPayload), 'JESSICA_START');
  assert.strictEqual(hotmartService.resolvePlanTier(testProPayload), 'JESSICA_PRO');
  console.log('  ✅ [PASS] Planos identificados rigorosamente pelos IDs oficiais, sem depender de valor de compra.');

  // -------------------------------------------------------------
  // TEST 9: DEMO ACCOUNT SECURITY CREDENTIALS
  // -------------------------------------------------------------
  console.log('🔹 Teste 9: Credencial segura da conta de homologação (.env)...');
  const demoAccount = clientAuth.ensureDemoAccount();
  assert.strictEqual(demoAccount.email, 'homologacao.hotmart@raiaagentes.com.br');
  assert.strictEqual(demoAccount.is_demo, 1);
  assert.ok(process.env.DEMO_ACCOUNT_PASSWORD, 'DEMO_ACCOUNT_PASSWORD deve estar presente no .env.');
  assert.notStrictEqual(process.env.DEMO_ACCOUNT_PASSWORD, 'RaiaHotmart#2026!Demo', 'Não pode ser a senha antiga divulgada em relatórios.');
  assert.ok(process.env.DEMO_ACCOUNT_PASSWORD.length >= 16, 'Deve ser senha de alta entropia (>= 16 caracteres).');
  console.log('  ✅ [PASS] Conta de homologação utiliza credencial randômica exclusiva do .env.');

  // -------------------------------------------------------------
  // TEST 10: MISSING DATE_NEXT_CHARGE COMPLIANCE & RECONCILIATION
  // -------------------------------------------------------------
  console.log('🔹 Teste 10: Conformidade estrita sem concessão de 30 dias quando date_next_charge ausente...');
  const test10Email = `sem_data_${Date.now()}@teste.com`;
  const test10Phone = `55119${Date.now().toString().slice(-8)}`;
  const test10SubCode = `SUB_NODATE_${Date.now()}`;

  const payloadNoDate = {
    id: `evt_uuid_${crypto.randomUUID()}`,
    creation_date: Date.now(),
    event: 'PURCHASE_APPROVED',
    version: '2.0.0',
    data: {
      buyer: { email: test10Email, name: 'Cliente Sem Data', checkout_phone: test10Phone },
      purchase: { transaction: `TR_NODATE_${Date.now()}`, status: 'APPROVED', offer: { code: 'jessica_start' } },
      subscription: { subscriber: { code: test10SubCode }, status: 'ACTIVE', plan: { name: 'Jéssica Start' } }
      // date_next_charge is intentionally omitted!
    }
  };

  const res10 = await hotmartService.processWebhook(payloadNoDate);
  assert.strictEqual(res10.success, true);
  assert.strictEqual(res10.paidUntil, null, 'NÃO pode conceder 30 dias automaticamente!');

  const userNoDate = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(test10Email);
  assert.strictEqual(userNoDate.paid_until, null, 'paid_until no banco deve ser NULL');
  assert.strictEqual(userNoDate.subscription_status, 'PENDING_DATE_RECONCILIATION', 'Status deve ser PENDING_DATE_RECONCILIATION');
  assert.strictEqual(userNoDate.needs_reconciliation, 1, 'needs_reconciliation deve ser 1');
  console.log('  ✅ [PASS] Concessão automática de 30 dias BLOQUEADA com sucesso quando date_next_charge ausente.');

  // Now perform reconciliation via HotmartReconciliationService
  console.log('  🔹 Testando reconciliação via HotmartReconciliationService...');
  const realDateAfterApiCall = Date.now() + 45 * 24 * 60 * 60 * 1000;
  const reconcilRes = await hotmartReconciliation.reconcileSubscription({
    subscriberCode: test10SubCode,
    mockApiResponse: { date_next_charge: realDateAfterApiCall }
  });
  assert.strictEqual(reconcilRes.success, true);
  assert.strictEqual(reconcilRes.reconciled, true);

  const userReconciled = db.prepare('SELECT * FROM users WHERE id = ?').get(userNoDate.id);
  assert.strictEqual(userReconciled.paid_until, new Date(realDateAfterApiCall).toISOString());
  assert.strictEqual(userReconciled.subscription_status, 'ACTIVE');
  assert.strictEqual(userReconciled.needs_reconciliation, 0);
  console.log('  ✅ [PASS] Reconciliação via API Hotmart concluiu com sucesso e atualizou vigência real.');

  // Clean test 10
  db.prepare('DELETE FROM subscription_audit_logs WHERE user_id = ?').run(userNoDate.id);
  db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(userNoDate.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(userNoDate.id);

  console.log('\n==================================================================');
  console.log('🎉 AUDITORIA HOTMART 2.0 CONCLUÍDA: 10/10 TESTES APROVADOS COM SUCESSO!');
  console.log('==================================================================\n');
  process.exit(0);
}

runHotmart2Suite().catch(err => {
  console.error('\n❌ ERRO NA AUDITORIA HOTMART 2.0:', err);
  process.exit(1);
});
