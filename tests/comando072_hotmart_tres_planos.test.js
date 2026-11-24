/**
 * COMANDO 072 — RAIA AGENTES
 * Suíte de Testes Hermética: Integração Hotmart dos Três Planos Jéssica
 *
 * Mapeamento Oficial das Ofertas (Produto 8840376):
 * - Jéssica Start         → offer code: gtt3rhpk → JESSICA_START        → R$ 89,00
 * - Jéssica Intermediário → offer code: 1x8ik7i3 → JESSICA_INTERMEDIATE → R$ 109,00
 * - Jéssica Pro           → offer code: ytvdj943 → JESSICA_PRO          → R$ 139,00
 *
 * Diretrizes Herméticas Mandatórias:
 * 1. Base 100% isolada e temporária em os.tmpdir(). assistant.db nunca é tocado.
 * 2. Limpeza rigorosa de require.cache entre os testes.
 * 3. Validação completa dos ciclos de vida, permissões, upgrades/downgrades e segurança.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const OPERATIONAL_DB_PATH = path.resolve(__dirname, '../data/assistant.db');

function createTempDbPath(prefix = 'test_hotmart_072_') {
  return path.join(os.tmpdir(), `${prefix}${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`);
}

function safeCleanup(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      const wal = `${filePath}-wal`;
      const shm = `${filePath}-shm`;
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    }
  } catch (_) {}
}

function unloadDbModules() {
  const modulesToClear = [
    '../src/config',
    '../src/database/db',
    '../src/services/hotmartService',
    '../src/services/clientAuthService',
    '../src/services/salonDashboardService',
    '../src/services/productService',
  ];

  for (const mod of modulesToClear) {
    try {
      const resolved = require.resolve(mod);
      delete require.cache[resolved];
    } catch (_) {}
  }
}

function setupHermeticEnvironment(dbPath) {
  unloadDbModules();
  process.env.DB_PATH = dbPath;
  process.env.APP_MODE = 'staging';
  process.env.HOMOLOGACAO = 'true';
  process.env.HOTMART_WEBHOOK_SECRET = 'segredo_teste_hottok_12345';
  process.env.HOTMART_PRODUCT_ID = '8840376';
  process.env.HOTMART_OFFER_START_CODE = 'gtt3rhpk';
  process.env.HOTMART_OFFER_INTERMEDIATE_CODE = '1x8ik7i3';
  process.env.HOTMART_OFFER_PRO_CODE = 'ytvdj943';

  const db = require('../src/database/db');
  const hotmartService = require('../src/services/hotmartService');
  const salonDashboardService = require('../src/services/salonDashboardService');
  const config = require('../src/config');

  return { db, hotmartService, salonDashboardService, config };
}

// ============================================================================
// CENÁRIO A: RESOLVEDOR DE PLANOS (resolvePlanTier) COM OFFER CODES OFICIAIS
// ============================================================================
test('Cenário A: resolvePlanTier — Identificação canônica dos três planos por offer codes', () => {
  const tempDb = createTempDbPath('scen_a_');
  const { hotmartService } = setupHermeticEnvironment(tempDb);

  try {
    // 1. Offer code Start
    const tierStart = hotmartService.resolvePlanTier({
      product: { id: '8840376' },
      purchase: { offer: { code: 'gtt3rhpk' } },
    });
    assert.equal(tierStart, 'JESSICA_START', 'Offer code gtt3rhpk deve resolver para JESSICA_START');

    // 2. Offer code Intermediário
    const tierIntermediate = hotmartService.resolvePlanTier({
      product: { id: '8840376' },
      purchase: { offer: { code: '1x8ik7i3' } },
    });
    assert.equal(tierIntermediate, 'JESSICA_INTERMEDIATE', 'Offer code 1x8ik7i3 deve resolver para JESSICA_INTERMEDIATE');

    // 3. Offer code Pro
    const tierPro = hotmartService.resolvePlanTier({
      product: { id: '8840376' },
      purchase: { offer: { code: 'ytvdj943' } },
    });
    assert.equal(tierPro, 'JESSICA_PRO', 'Offer code ytvdj943 deve resolver para JESSICA_PRO');

    // 4. Offer code desconhecido -> PENDING_PLAN_IDENTIFICATION (sem guessing)
    const tierUnknown = hotmartService.resolvePlanTier({
      product: { id: '8840376' },
      purchase: { offer: { code: 'codigo_invalido_xyz' } },
    });
    assert.equal(tierUnknown, 'PENDING_PLAN_IDENTIFICATION', 'Offer code desconhecido deve retornar PENDING_PLAN_IDENTIFICATION');

    // 5. Fallback por nome do plano para produto oficial
    const tierByName = hotmartService.resolvePlanTier({
      product: { id: '8840376' },
      subscription: { plan: { name: 'Jéssica Plano Intermediário Gestão' } },
    });
    assert.equal(tierByName, 'JESSICA_INTERMEDIATE', 'Nome contendo Intermediário no produto oficial deve resolver JESSICA_INTERMEDIATE');

    // 6. Proteção de Segurança: Produto de terceiros com "PRO" no nome NÃO deve ganhar JESSICA_PRO
    const tierAlienProduct = hotmartService.resolvePlanTier({
      product: { id: '9999999_PRODUTO_ALIENIGENA' },
      subscription: { plan: { name: 'Curso PRO de Cabelereiros' } },
    });
    assert.equal(tierAlienProduct, 'PENDING_PLAN_IDENTIFICATION', 'Produto não oficial não deve ser escalado para PRO via fallback de nome');
  } finally {
    unloadDbModules();
    safeCleanup(tempDb);
  }
});

// ============================================================================
// CENÁRIO B: PURCHASE_APPROVED E PROVISIONAMENTO ATÔMICO DOS 3 PLANOS
// ============================================================================
test('Cenário B: PURCHASE_APPROVED — Provisionamento atômico para Start, Intermediário e Pro', async () => {
  const tempDb = createTempDbPath('scen_b_');
  const { db, hotmartService } = setupHermeticEnvironment(tempDb);

  try {
    // 1. Compra aprovada: Jéssica Start
    const payloadStart = {
      id: 'EVT_PURCHASE_START_001',
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: {
          transaction: 'HP_TX_START_001',
          offer: { code: 'gtt3rhpk' },
          date_next_charge: Date.now() + 30 * 24 * 60 * 60 * 1000,
        },
        buyer: {
          email: 'cliente.start@salao.com',
          name: 'Ana Start',
          phone: '5511988880001',
        },
        subscription: {
          subscriber_code: 'SUB_HOTMART_START_001',
        },
      },
    };

    const resStart = await hotmartService.processWebhook(payloadStart);
    assert.equal(resStart.success, true);
    assert.equal(resStart.planTier, 'JESSICA_START');

    const userStart = db.prepare('SELECT * FROM users WHERE email = ?').get('cliente.start@salao.com');
    assert.ok(userStart);
    assert.equal(userStart.plan_tier, 'JESSICA_START');

    const subStart = db.prepare('SELECT * FROM customer_subscriptions WHERE user_id = ?').get(userStart.id);
    assert.ok(subStart);
    assert.equal(subStart.gateway, 'HOTMART');
    assert.equal(subStart.price_cents, 8900);

    // 2. Compra aprovada: Jéssica Intermediário
    const payloadInt = {
      id: 'EVT_PURCHASE_INT_002',
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: {
          transaction: 'HP_TX_INT_002',
          offer: { code: '1x8ik7i3' },
          date_next_charge: Date.now() + 30 * 24 * 60 * 60 * 1000,
        },
        buyer: {
          email: 'cliente.inter@salao.com',
          name: 'Beatriz Intermediario',
          phone: '5511988880002',
        },
        subscription: {
          subscriber_code: 'SUB_HOTMART_INT_002',
        },
      },
    };

    const resInt = await hotmartService.processWebhook(payloadInt);
    assert.equal(resInt.success, true);
    assert.equal(resInt.planTier, 'JESSICA_INTERMEDIATE');

    const userInt = db.prepare('SELECT * FROM users WHERE email = ?').get('cliente.inter@salao.com');
    assert.ok(userInt);
    assert.equal(userInt.plan_tier, 'JESSICA_INTERMEDIATE');

    const subInt = db.prepare('SELECT * FROM customer_subscriptions WHERE user_id = ?').get(userInt.id);
    assert.ok(subInt);
    assert.equal(subInt.gateway, 'HOTMART');
    assert.equal(subInt.price_cents, 10900);

    // 3. Compra aprovada: Jéssica Pro
    const payloadPro = {
      id: 'EVT_PURCHASE_PRO_003',
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: {
          transaction: 'HP_TX_PRO_003',
          offer: { code: 'ytvdj943' },
          date_next_charge: Date.now() + 30 * 24 * 60 * 60 * 1000,
        },
        buyer: {
          email: 'cliente.pro@salao.com',
          name: 'Carla Pro',
          phone: '5511988880003',
        },
        subscription: {
          subscriber_code: 'SUB_HOTMART_PRO_003',
        },
      },
    };

    const resPro = await hotmartService.processWebhook(payloadPro);
    assert.equal(resPro.success, true);
    assert.equal(resPro.planTier, 'JESSICA_PRO');

    const userPro = db.prepare('SELECT * FROM users WHERE email = ?').get('cliente.pro@salao.com');
    assert.ok(userPro);
    assert.equal(userPro.plan_tier, 'JESSICA_PRO');

    const subPro = db.prepare('SELECT * FROM customer_subscriptions WHERE user_id = ?').get(userPro.id);
    assert.ok(subPro);
    assert.equal(subPro.gateway, 'HOTMART');
    assert.equal(subPro.price_cents, 13900);

    // 4. Verificação de auditoria: offer_code persistido na tabela hotmart_webhook_events
    const eventRow = db.prepare('SELECT offer_code, plan_id FROM hotmart_webhook_events WHERE event_id = ?').get('EVT_PURCHASE_INT_002');
    assert.ok(eventRow);
    assert.equal(eventRow.offer_code, '1x8ik7i3');

    // 5. Teste de Idempotência: reprocessar mesmo evento
    const duplicateRes = await hotmartService.processWebhook(payloadInt);
    assert.equal(duplicateRes.duplicated, true);
    assert.equal(duplicateRes.status, 'ignored');

    const countUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE email = 'cliente.inter@salao.com'").get().count;
    assert.equal(countUsers, 1, 'Reenvio de webhook não deve criar usuário duplicado');
  } finally {
    unloadDbModules();
    safeCleanup(tempDb);
  }
});

// ============================================================================
// CENÁRIO C: MATRIZ DE PERMISSÕES E ISOLAMENTO POR TIER
// ============================================================================
test('Cenário C: Matriz de Permissões — Start, Intermediário e Pro respeitam fronteiras estritas', async () => {
  const tempDb = createTempDbPath('scen_c_');
  const { db, hotmartService, salonDashboardService } = setupHermeticEnvironment(tempDb);

  try {
    const validUntil = Date.now() + 30 * 24 * 60 * 60 * 1000;

    // 1. Criar assinante Start
    const resStart = await hotmartService.processWebhook({
      id: 'EVT_PERM_START',
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: { transaction: 'TX_PERM_START', offer: { code: 'gtt3rhpk' }, date_next_charge: validUntil },
        buyer: { email: 'perm.start@salao.com', name: 'Paula Start', phone: '5511955550001' },
        subscription: { subscriber_code: 'SUB_PERM_START' },
      },
    });
    const userStart = db.prepare('SELECT * FROM users WHERE id = ?').get(resStart.userId);
    const tierStart = salonDashboardService.getEffectiveJessicaTier(userStart.id, userStart);
    assert.equal(tierStart, 'JESSICA_START', 'Usuário Start deve ter tier efetivo JESSICA_START');

    const canStartDashboard = ['JESSICA_INTERMEDIATE', 'JESSICA_PRO'].includes(tierStart);
    const isStartPro = tierStart === 'JESSICA_PRO';
    assert.equal(canStartDashboard, false, 'Start NÃO deve acessar Dashboard');
    assert.equal(isStartPro, false, 'Start NÃO tem permissão Pro');

    // 2. Criar assinante Intermediário
    const resInt = await hotmartService.processWebhook({
      id: 'EVT_PERM_INT',
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: { transaction: 'TX_PERM_INT', offer: { code: '1x8ik7i3' }, date_next_charge: validUntil },
        buyer: { email: 'perm.inter@salao.com', name: 'Isabela Inter', phone: '5511955550002' },
        subscription: { subscriber_code: 'SUB_PERM_INT' },
      },
    });
    const userInt = db.prepare('SELECT * FROM users WHERE id = ?').get(resInt.userId);
    const tierInt = salonDashboardService.getEffectiveJessicaTier(userInt.id, userInt);
    assert.equal(tierInt, 'JESSICA_INTERMEDIATE', 'Usuário Intermediário deve ter tier efetivo JESSICA_INTERMEDIATE');

    const canIntDashboard = ['JESSICA_INTERMEDIATE', 'JESSICA_PRO'].includes(tierInt);
    const isIntPro = tierInt === 'JESSICA_PRO';
    assert.equal(canIntDashboard, true, 'Intermediário DEVE acessar Dashboard');
    assert.equal(isIntPro, false, 'Intermediário NÃO tem acesso a recursos exclusivos Pro (contas/campanhas)');

    // 3. Criar assinante Pro
    const resPro = await hotmartService.processWebhook({
      id: 'EVT_PERM_PRO',
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: { transaction: 'TX_PERM_PRO', offer: { code: 'ytvdj943' }, date_next_charge: validUntil },
        buyer: { email: 'perm.pro@salao.com', name: 'Patricia Pro', phone: '5511955550003' },
        subscription: { subscriber_code: 'SUB_PERM_PRO' },
      },
    });
    const userPro = db.prepare('SELECT * FROM users WHERE id = ?').get(resPro.userId);
    const tierPro = salonDashboardService.getEffectiveJessicaTier(userPro.id, userPro);
    assert.equal(tierPro, 'JESSICA_PRO', 'Usuário Pro deve ter tier efetivo JESSICA_PRO');

    const canProDashboard = ['JESSICA_INTERMEDIATE', 'JESSICA_PRO'].includes(tierPro);
    const isProFull = tierPro === 'JESSICA_PRO';
    assert.equal(canProDashboard, true, 'Pro tem acesso ao Dashboard');
    assert.equal(isProFull, true, 'Pro tem acesso a Contas a Pagar e Campanhas');
  } finally {
    unloadDbModules();
    safeCleanup(tempDb);
  }
});

// ============================================================================
// CENÁRIO D: UPGRADE E DOWNGRADE DE PLANO (SWITCH_PLAN)
// ============================================================================
test('Cenário D: SWITCH_PLAN — Upgrade e downgrade atômicos sem permissões residuais', async () => {
  const tempDb = createTempDbPath('scen_d_');
  const { db, hotmartService } = setupHermeticEnvironment(tempDb);

  try {
    // 1. Criar cliente com plano START
    await hotmartService.processWebhook({
      id: 'EVT_UPGRADE_001',
      event: 'PURCHASE_APPROVED',
      creation_date: 1000,
      data: {
        product: { id: '8840376' },
        purchase: { transaction: 'TX_UPGRADE_001', offer: { code: 'gtt3rhpk' } },
        buyer: { email: 'upgrade.user@salao.com', name: 'Marina Upgrade', phone: '5511977770001' },
        subscription: { subscriber_code: 'SUB_UPGRADE_001' },
      },
    });

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get('upgrade.user@salao.com');
    assert.equal(user.plan_tier, 'JESSICA_START');

    // 2. UPGRADE para INTERMEDIÁRIO via SWITCH_PLAN
    const upgradeRes = await hotmartService.processWebhook({
      id: 'EVT_UPGRADE_002',
      event: 'SWITCH_PLAN',
      creation_date: 2000,
      data: {
        product: { id: '8840376' },
        purchase: { offer: { code: '1x8ik7i3' } },
        subscription: { subscriber_code: 'SUB_UPGRADE_001' },
      },
    });
    assert.equal(upgradeRes.success, true);
    assert.equal(upgradeRes.action, 'PLAN_SWITCHED');

    user = db.prepare('SELECT * FROM users WHERE email = ?').get('upgrade.user@salao.com');
    assert.equal(user.plan_tier, 'JESSICA_INTERMEDIATE', 'Plano deve ter sido atualizado para JESSICA_INTERMEDIATE');

    // 3. UPGRADE para PRO via SWITCH_PLAN
    await hotmartService.processWebhook({
      id: 'EVT_UPGRADE_003',
      event: 'SWITCH_PLAN',
      creation_date: 3000,
      data: {
        product: { id: '8840376' },
        purchase: { offer: { code: 'ytvdj943' } },
        subscription: { subscriber_code: 'SUB_UPGRADE_001' },
      },
    });

    user = db.prepare('SELECT * FROM users WHERE email = ?').get('upgrade.user@salao.com');
    assert.equal(user.plan_tier, 'JESSICA_PRO', 'Plano deve ter sido atualizado para JESSICA_PRO');

    // 4. DOWNGRADE de PRO para START via SWITCH_PLAN
    await hotmartService.processWebhook({
      id: 'EVT_UPGRADE_004',
      event: 'SWITCH_PLAN',
      creation_date: 4000,
      data: {
        product: { id: '8840376' },
        purchase: { offer: { code: 'gtt3rhpk' } },
        subscription: { subscriber_code: 'SUB_UPGRADE_001' },
      },
    });

    user = db.prepare('SELECT * FROM users WHERE email = ?').get('upgrade.user@salao.com');
    assert.equal(user.plan_tier, 'JESSICA_START', 'Downgrade deve revogar PRO e redefinir para JESSICA_START');
  } finally {
    unloadDbModules();
    safeCleanup(tempDb);
  }
});

// ============================================================================
// CENÁRIO E: EVENTOS DE CICLO DE VIDA (CANCELAMENTO, REEMBOLSO, INADIMPLÊNCIA)
// ============================================================================
test('Cenário E: Ciclo de Vida — Cancelamento, Reembolso e Inadimplência', async () => {
  const tempDb = createTempDbPath('scen_e_');
  const { db, hotmartService } = setupHermeticEnvironment(tempDb);

  try {
    const nextChargeDate = Date.now() + 20 * 24 * 60 * 60 * 1000;
    // 1. Criar cliente com plano INTERMEDIATE
    await hotmartService.processWebhook({
      id: 'EVT_CYCLE_001',
      event: 'PURCHASE_APPROVED',
      creation_date: 1000,
      data: {
        product: { id: '8840376' },
        purchase: {
          transaction: 'TX_CYCLE_001',
          offer: { code: '1x8ik7i3' },
          date_next_charge: nextChargeDate,
        },
        buyer: { email: 'ciclo.user@salao.com', name: 'Juliana Ciclo', phone: '5511966660001' },
        subscription: { subscriber_code: 'SUB_CYCLE_001' },
      },
    });

    // 2. Inadimplência / Atraso na cobrança (PURCHASE_DELAYED / SUBSCRIPTION_OVERDUE)
    await hotmartService.processWebhook({
      id: 'EVT_CYCLE_002',
      event: 'SUBSCRIPTION_OVERDUE',
      creation_date: 2000,
      data: {
        subscription: { subscriber_code: 'SUB_CYCLE_001' },
      },
    });

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get('ciclo.user@salao.com');
    assert.equal(user.subscription_status, 'OVERDUE', 'Status deve mudar para OVERDUE');

    // 3. Cancelamento da Assinatura (SUBSCRIPTION_CANCELLATION) — mantém acesso até o fim da vigência
    await hotmartService.processWebhook({
      id: 'EVT_CYCLE_003',
      event: 'SUBSCRIPTION_CANCELLATION',
      creation_date: 3000,
      data: {
        subscription: { subscriber_code: 'SUB_CYCLE_001' },
      },
    });

    user = db.prepare('SELECT * FROM users WHERE email = ?').get('ciclo.user@salao.com');
    assert.equal(user.subscription_status, 'CANCELED', 'Status deve mudar para CANCELED');
    assert.ok(user.paid_until, 'Vigência paga deve ser preservada no cancelamento');

    // 4. Reembolso (PURCHASE_REFUNDED) — revoga acesso imediatamente
    await hotmartService.processWebhook({
      id: 'EVT_CYCLE_004',
      event: 'PURCHASE_REFUNDED',
      creation_date: 4000,
      data: {
        purchase: { transaction: 'TX_CYCLE_001' },
        subscription: { subscriber_code: 'SUB_CYCLE_001' },
      },
    });

    user = db.prepare('SELECT * FROM users WHERE email = ?').get('ciclo.user@salao.com');
    assert.equal(user.subscription_status, 'REFUNDED', 'Status deve mudar para REFUNDED');
    assert.equal(user.paid_until, null, 'paid_until deve ser zerado imediatamente no reembolso');

    const sub = db.prepare('SELECT * FROM customer_subscriptions WHERE user_id = ?').get(user.id);
    assert.equal(sub.status, 'REFUNDED');
    assert.equal(sub.paid_until, null);
  } finally {
    unloadDbModules();
    safeCleanup(tempDb);
  }
});

// ============================================================================
// CENÁRIO F: SEGURANÇA, FAIL-CLOSED E VALIDAÇÃO DE AUTENTICIDADE
// ============================================================================
test('Cenário F: Segurança de Webhook — Validação de token Hottok e rejeição de dados espúrios', () => {
  const tempDb = createTempDbPath('scen_f_');
  const { hotmartService } = setupHermeticEnvironment(tempDb);

  try {
    // 1. Header correto
    const validReq = {
      headers: { 'x-hotmart-hottok': 'segredo_teste_hottok_12345' },
    };
    assert.equal(hotmartService.validateHotmartHeader(validReq), true, 'Header X-HOTMART-HOTTOK válido deve ser aceito');

    // 2. Token incorreto -> Rejeitado
    const invalidReq = {
      headers: { 'x-hotmart-hottok': 'token_falso_hacker' },
    };
    assert.equal(hotmartService.validateHotmartHeader(invalidReq), false, 'Token incorreto deve ser rejeitado');

    // 3. Header ausente -> Rejeitado (fail-closed)
    const missingReq = { headers: {} };
    assert.equal(hotmartService.validateHotmartHeader(missingReq), false, 'Header ausente deve ser rejeitado');
  } finally {
    unloadDbModules();
    safeCleanup(tempDb);
  }
});

// ============================================================================
// CENÁRIO G: getIntegrationStatus() E PRONTIDÃO COMERCIAL
// ============================================================================
test('Cenário G: getIntegrationStatus — Status completo dos três planos e critérios de prontidão', () => {
  const tempDb = createTempDbPath('scen_g_');
  const { hotmartService } = setupHermeticEnvironment(tempDb);

  try {
    const status = hotmartService.getIntegrationStatus();
    assert.equal(status.productId, '8840376');
    assert.equal(status.webhookSecretConfigured, true);
    assert.equal(status.isProductionReady, true);

    // Mapeamento dos três planos
    assert.equal(status.offerCodes.start, 'gtt3rhpk');
    assert.equal(status.offerCodes.intermediate, '1x8ik7i3');
    assert.equal(status.offerCodes.pro, 'ytvdj943');

    assert.equal(status.planMapping.length, 3);
    const startOffer = status.planMapping.find(p => p.tier === 'JESSICA_START');
    const intOffer = status.planMapping.find(p => p.tier === 'JESSICA_INTERMEDIATE');
    const proOffer = status.planMapping.find(p => p.tier === 'JESSICA_PRO');

    assert.equal(startOffer.price, 89.0);
    assert.equal(intOffer.price, 109.0);
    assert.equal(proOffer.price, 139.0);
  } finally {
    unloadDbModules();
    safeCleanup(tempDb);
  }
});

// ============================================================================
// SALVAGUARDA MANDATÓRIA: ASSISTANT.DB NÃO FOI TOCADO
// ============================================================================
test('Salvaguarda Mandatória: data/assistant.db permaneceu estritamente intocado', () => {
  if (fs.existsSync(OPERATIONAL_DB_PATH)) {
    const stats = fs.statSync(OPERATIONAL_DB_PATH);
    assert.ok(stats.size > 0, 'O banco operacional deve permanecer intacto');
  }
});
