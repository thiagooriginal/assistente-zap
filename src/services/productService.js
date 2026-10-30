'use strict';

const db = require('../database/db');

/**
 * Multi-Product & Subscription Management Service for RAIA AGENTES
 * Enables dynamic product & plan creation, multi-contract management per user,
 * immutable contract terms, and independent access control per product.
 */

// ==========================================
// 1. PRODUCT & PLAN CATALOG MANAGEMENT
// ==========================================

function listProducts({ activeOnly = false, includePlans = true } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  const products = db.prepare(`SELECT * FROM products ${where} ORDER BY id ASC`).all();

  if (includePlans) {
    const plansStmt = db.prepare(`SELECT * FROM product_plans ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY price_cents ASC`);
    const allPlans = plansStmt.all();

    return products.map(prod => {
      const plans = allPlans.filter(p => p.product_id === prod.id).map(p => ({
        ...p,
        features: p.features_json ? safeJsonParse(p.features_json, []) : [],
      }));
      return {
        ...prod,
        metadata: prod.metadata_json ? safeJsonParse(prod.metadata_json, {}) : {},
        plans,
      };
    });
  }

  return products.map(prod => ({
    ...prod,
    metadata: prod.metadata_json ? safeJsonParse(prod.metadata_json, {}) : {},
  }));
}

function getProductByCode(code, { includePlans = true } = {}) {
  if (!code) return null;
  const prod = db.prepare('SELECT * FROM products WHERE UPPER(code) = UPPER(?)').get(code.trim());
  if (!prod) return null;

  let plans = [];
  if (includePlans) {
    plans = db.prepare('SELECT * FROM product_plans WHERE product_id = ? ORDER BY price_cents ASC').all(prod.id).map(p => ({
      ...p,
      features: p.features_json ? safeJsonParse(p.features_json, []) : [],
    }));
  }

  return {
    ...prod,
    metadata: prod.metadata_json ? safeJsonParse(prod.metadata_json, {}) : {},
    plans,
  };
}

function getProductById(id, { includePlans = true } = {}) {
  if (!id) return null;
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!prod) return null;

  let plans = [];
  if (includePlans) {
    plans = db.prepare('SELECT * FROM product_plans WHERE product_id = ? ORDER BY price_cents ASC').all(prod.id).map(p => ({
      ...p,
      features: p.features_json ? safeJsonParse(p.features_json, []) : [],
    }));
  }

  return {
    ...prod,
    metadata: prod.metadata_json ? safeJsonParse(prod.metadata_json, {}) : {},
    plans,
  };
}

function createProduct({ code, name, description, category = 'GERAL', icon = 'bot', metadata = {} }) {
  if (!code || !name) {
    throw new Error('Código e nome do produto são obrigatórios.');
  }

  const cleanCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  const cleanName = String(name).trim();

  const existing = db.prepare('SELECT id FROM products WHERE code = ?').get(cleanCode);
  if (existing) {
    throw new Error(`Já existe um produto com o código '${cleanCode}'.`);
  }

  const result = db.prepare(`
    INSERT INTO products (code, name, description, category, icon, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    cleanCode,
    cleanName,
    description ? String(description).trim() : null,
    String(category).trim().toUpperCase(),
    icon || 'bot',
    JSON.stringify(metadata || {})
  );

  return getProductById(Number(result.lastInsertRowid));
}

function updateProduct(id, updates = {}) {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('Produto não encontrado.');
  }

  const name = updates.name !== undefined ? String(updates.name).trim() : existing.name;
  const description = updates.description !== undefined ? String(updates.description).trim() : existing.description;
  const category = updates.category !== undefined ? String(updates.category).trim().toUpperCase() : existing.category;
  const icon = updates.icon !== undefined ? String(updates.icon).trim() : existing.icon;
  const isActive = updates.isActive !== undefined ? (updates.isActive ? 1 : 0) : existing.is_active;
  const metadata = updates.metadata !== undefined ? JSON.stringify(updates.metadata) : existing.metadata_json;

  db.prepare(`
    UPDATE products
    SET name = ?, description = ?, category = ?, icon = ?, is_active = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, description, category, icon, isActive, metadata, id);

  return getProductById(id);
}

function createPlan(productId, planData) {
  const prod = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!prod) {
    throw new Error('Produto não encontrado.');
  }

  const code = String(planData.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  const name = String(planData.name || '').trim();
  if (!code || !name) {
    throw new Error('Código e nome do plano são obrigatórios.');
  }

  const priceCents = Math.round(Number(planData.priceCents || 0));
  const setupFeeCents = Math.round(Number(planData.setupFeeCents || 0));
  const promoFairPriceCents = planData.promoFairPriceCents !== undefined && planData.promoFairPriceCents !== null
    ? Math.round(Number(planData.promoFairPriceCents))
    : null;
  const billingCycle = String(planData.billingCycle || 'MONTHLY').toUpperCase();
  const maxProfessionals = Number(planData.maxProfessionals || 1);
  const hasLoyalty = planData.hasLoyalty ? 1 : 0;
  const featuresJson = JSON.stringify(Array.isArray(planData.features) ? planData.features : []);

  const existing = db.prepare('SELECT id FROM product_plans WHERE product_id = ? AND code = ?').get(productId, code);
  if (existing) {
    throw new Error(`Plano '${code}' já existe para este produto.`);
  }

  const result = db.prepare(`
    INSERT INTO product_plans (
      product_id, code, name, description, billing_cycle, price_cents, setup_fee_cents,
      promo_fair_price_cents, max_professionals, has_loyalty, features_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId, code, name, planData.description ? String(planData.description).trim() : null,
    billingCycle, priceCents, setupFeeCents, promoFairPriceCents, maxProfessionals, hasLoyalty, featuresJson
  );

  return db.prepare('SELECT * FROM product_plans WHERE id = ?').get(Number(result.lastInsertRowid));
}

function updatePlan(planId, updates = {}) {
  const existing = db.prepare('SELECT * FROM product_plans WHERE id = ?').get(planId);
  if (!existing) {
    throw new Error('Plano não encontrado.');
  }

  const name = updates.name !== undefined ? String(updates.name).trim() : existing.name;
  const description = updates.description !== undefined ? String(updates.description).trim() : existing.description;
  const priceCents = updates.priceCents !== undefined ? Math.round(Number(updates.priceCents)) : existing.price_cents;
  const setupFeeCents = updates.setupFeeCents !== undefined ? Math.round(Number(updates.setupFeeCents)) : existing.setup_fee_cents;
  const promoFairPriceCents = updates.promoFairPriceCents !== undefined
    ? (updates.promoFairPriceCents !== null ? Math.round(Number(updates.promoFairPriceCents)) : null)
    : existing.promo_fair_price_cents;
  const billingCycle = updates.billingCycle !== undefined ? String(updates.billingCycle).toUpperCase() : existing.billing_cycle;
  const maxProfessionals = updates.maxProfessionals !== undefined ? Number(updates.maxProfessionals) : existing.max_professionals;
  const hasLoyalty = updates.hasLoyalty !== undefined ? (updates.hasLoyalty ? 1 : 0) : existing.has_loyalty;
  const isActive = updates.isActive !== undefined ? (updates.isActive ? 1 : 0) : existing.is_active;
  const featuresJson = updates.features !== undefined ? JSON.stringify(updates.features) : existing.features_json;

  db.prepare(`
    UPDATE product_plans
    SET name = ?, description = ?, price_cents = ?, setup_fee_cents = ?,
        promo_fair_price_cents = ?, billing_cycle = ?, max_professionals = ?,
        has_loyalty = ?, is_active = ?, features_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, description, priceCents, setupFeeCents, promoFairPriceCents, billingCycle, maxProfessionals, hasLoyalty, isActive, featuresJson, planId);

  return db.prepare('SELECT * FROM product_plans WHERE id = ?').get(planId);
}

// ==========================================
// 2. CUSTOMER SUBSCRIPTIONS & MULTI-CONTRACT
// ==========================================

function getUserSubscriptions(userId) {
  if (!userId) return [];

  const rows = db.prepare(`
    SELECT cs.*,
           p.code AS product_code, p.name AS product_name, p.category AS product_category, p.icon AS product_icon, p.metadata_json AS product_metadata,
           pp.name AS plan_name, pp.code AS plan_code, pp.max_professionals AS plan_max_professionals, pp.features_json AS plan_features
    FROM customer_subscriptions cs
    JOIN products p ON p.id = cs.product_id
    LEFT JOIN product_plans pp ON pp.id = cs.plan_id
    WHERE cs.user_id = ?
    ORDER BY cs.id DESC
  `).all(userId);

  return rows.map(formatSubscriptionRow);
}

function getUserSubscriptionForProduct(userId, productCode) {
  if (!userId || !productCode) return null;

  const row = db.prepare(`
    SELECT cs.*,
           p.code AS product_code, p.name AS product_name, p.category AS product_category, p.icon AS product_icon, p.metadata_json AS product_metadata,
           pp.name AS plan_name, pp.code AS plan_code, pp.max_professionals AS plan_max_professionals, pp.features_json AS plan_features
    FROM customer_subscriptions cs
    JOIN products p ON p.id = cs.product_id
    LEFT JOIN product_plans pp ON pp.id = cs.plan_id
    WHERE cs.user_id = ? AND UPPER(p.code) = UPPER(?)
    ORDER BY CASE
      WHEN cs.status = 'ACTIVE' THEN 1
      WHEN cs.status = 'PENDING' THEN 2
      WHEN cs.status = 'OVERDUE' THEN 3
      WHEN cs.status = 'CANCELLED' THEN 4
      ELSE 5
    END ASC, cs.id DESC
    LIMIT 1
  `).get(userId, productCode.trim());

  return row ? formatSubscriptionRow(row) : null;
}

function hasProductAccess(userId, productCode) {
  if (!userId) {
    return { hasAccess: false, status: 'UNAUTHENTICATED', reason: 'Usuário não autenticado.' };
  }

  const user = db.prepare('SELECT id, role, is_demo, subscription_status, paid_until, plan_tier FROM users WHERE id = ?').get(userId);
  if (!user) {
    return { hasAccess: false, status: 'NOT_FOUND', reason: 'Usuário não encontrado.' };
  }

  // Admin has unconditional master access across all products
  if (user.role === 'ADMIN') {
    return { hasAccess: true, status: 'ACTIVE', reason: 'ADMIN_ACCESS' };
  }

  // Demo account has unconditional demonstration access
  if (user.is_demo) {
    return { hasAccess: true, status: 'ACTIVE', reason: 'DEMO_ACCESS' };
  }

  // Find product subscription
  const sub = getUserSubscriptionForProduct(userId, productCode);

  // If no subscription record found in customer_subscriptions, check legacy Jéssica fallback
  if (!sub) {
    if (String(productCode).toUpperCase() === 'JESSICA' && user.subscription_status) {
      const isPaid = user.paid_until && new Date(user.paid_until) >= new Date();
      if (['ACTIVE', 'TRIAL'].includes(user.subscription_status) && isPaid) {
        return { hasAccess: true, status: user.subscription_status, reason: 'LEGACY_ACTIVE' };
      }
      return {
        hasAccess: false,
        status: user.subscription_status,
        reason: `Status Jéssica legado: ${user.subscription_status}`,
      };
    }

    return {
      hasAccess: false,
      status: 'NOT_CONTRACTED',
      reason: `Produto '${productCode}' não contratado por este usuário.`,
    };
  }

  const now = new Date();
  const paidUntilDate = sub.paidUntil ? new Date(sub.paidUntil) : null;
  const isPaidPeriodValid = paidUntilDate ? paidUntilDate >= now : false;

  // Active status
  if (sub.status === 'ACTIVE') {
    if (isPaidPeriodValid || !sub.paidUntil) {
      return { hasAccess: true, status: 'ACTIVE', subscription: sub, reason: 'SUBSCRIPTION_ACTIVE' };
    }
    return {
      hasAccess: false,
      status: 'EXPIRED',
      subscription: sub,
      reason: 'Período contratado encerrou. Realize a renovação para restabelecer o acesso.',
    };
  }

  // Cancelled status: Sem fidelidade! Customer retains access until the end of the paid period
  if (sub.status === 'CANCELLED') {
    if (isPaidPeriodValid) {
      return {
        hasAccess: true,
        status: 'CANCELLED_WITH_ACCESS',
        subscription: sub,
        reason: `Assinatura cancelada sem fidelidade. Acesso mantido até o término do ciclo em ${sub.paidUntil}.`,
      };
    }
    return {
      hasAccess: false,
      status: 'CANCELLED',
      subscription: sub,
      reason: 'Assinatura cancelada e vigência contratual encerrada.',
    };
  }

  // Overdue status: Check if within grace/paid period
  if (sub.status === 'OVERDUE') {
    if (isPaidPeriodValid) {
      return {
        hasAccess: true,
        status: 'OVERDUE_WITH_GRACE',
        subscription: sub,
        reason: 'Assinatura em atraso, mas período vigente ainda em curso.',
      };
    }
    return {
      hasAccess: false,
      status: 'OVERDUE',
      subscription: sub,
      reason: 'Assinatura em atraso. Regularize seu pagamento para liberar o acesso.',
    };
  }

  // Pending status (awaiting first payment confirmation)
  if (sub.status === 'PENDING') {
    return {
      hasAccess: false,
      status: 'PENDING',
      subscription: sub,
      reason: 'Aguardando confirmação de pagamento para liberar o acesso a este produto.',
    };
  }

  // Terminal / suspended statuses
  return {
    hasAccess: false,
    status: sub.status,
    subscription: sub,
    reason: `Acesso indisponível (situação: ${sub.status}).`,
  };
}

/**
 * Creates an immutable contract snapshot for a user
 */
function createCustomerSubscription({
  userId,
  productCode,
  planCode,
  origin = 'ASAAS',
  gateway = 'ASAAS',
  priceCents,
  setupFeeCents,
  billingCycle = 'MONTHLY',
  promotionalFair = false,
  extraProfessionals = 0,
  gatewaySubscriptionId = null,
  gatewayCustomerId = null,
  gatewayPaymentId = null,
  paidUntil = null,
  status = 'PENDING',
  customSettings = {},
  adminId = 0,
  notes = null,
}) {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Cliente não encontrado.');

  const product = getProductByCode(productCode);
  if (!product) throw new Error(`Produto '${productCode}' não encontrado.`);

  let plan = null;
  if (planCode) {
    plan = product.plans.find(p => p.code.toUpperCase() === planCode.toUpperCase());
  }
  if (!plan && product.plans.length > 0) {
    plan = product.plans[0];
  }

  // Contract snapshot values: if not explicitly supplied, snapshot current catalog values
  const isFair = Boolean(promotionalFair);
  const finalPriceCents = priceCents !== undefined && priceCents !== null
    ? Math.round(Number(priceCents))
    : (isFair && plan?.promo_fair_price_cents ? plan.promo_fair_price_cents : (plan?.price_cents || 0));

  const finalSetupFeeCents = setupFeeCents !== undefined && setupFeeCents !== null
    ? Math.round(Number(setupFeeCents))
    : (isFair ? 0 : (plan?.setup_fee_cents || 0));

  const finalCycle = billingCycle || plan?.billing_cycle || 'MONTHLY';

  const result = db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
      gateway_customer_id, gateway_payment_id, status, price_cents, setup_fee_cents,
      billing_cycle, promotional_fair, extra_professionals, contracted_at, paid_until,
      access_expires_at, custom_settings_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
  `).run(
    userId, product.id, plan?.id || null, origin, gateway,
    gatewaySubscriptionId || null, gatewayCustomerId || null, gatewayPaymentId || null,
    status, finalPriceCents, finalSetupFeeCents, finalCycle, isFair ? 1 : 0,
    Number(extraProfessionals || 0), paidUntil || null, paidUntil || null,
    JSON.stringify(customSettings || {})
  );

  const subId = Number(result.lastInsertRowid);

  // Log audit
  logSubscriptionAudit({
    subscriptionId: subId,
    userId,
    productId: product.id,
    oldStatus: null,
    newStatus: status,
    action: 'CREATED',
    reason: notes || `Contrato criado para ${product.name} (${plan?.name || 'Sem plano'})`,
    details: {
      priceCents: finalPriceCents,
      setupFeeCents: finalSetupFeeCents,
      origin,
      gateway,
      adminId,
    },
  });

  return getUserSubscriptionById(subId);
}

function updateSubscriptionStatus(subscriptionId, newStatus, { reason = null, details = {}, adminId = 0 } = {}) {
  const current = db.prepare('SELECT * FROM customer_subscriptions WHERE id = ?').get(subscriptionId);
  if (!current) throw new Error('Assinatura não encontrada.');

  const oldStatus = current.status;
  if (oldStatus === newStatus) return formatSubscriptionRow(current);

  db.prepare(`
    UPDATE customer_subscriptions
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newStatus, subscriptionId);

  logSubscriptionAudit({
    subscriptionId,
    userId: current.user_id,
    productId: current.product_id,
    oldStatus,
    newStatus,
    action: 'STATUS_CHANGED',
    reason,
    details: { ...details, adminId },
  });

  return getUserSubscriptionById(subscriptionId);
}

function renewSubscription(subscriptionId, newPaidUntil, { reason = null, gatewayPaymentId = null, adminId = 0 } = {}) {
  const current = db.prepare('SELECT * FROM customer_subscriptions WHERE id = ?').get(subscriptionId);
  if (!current) throw new Error('Assinatura não encontrada.');

  const oldStatus = current.status;
  const newStatus = ['PENDING', 'OVERDUE', 'INACTIVE'].includes(current.status) ? 'ACTIVE' : current.status;

  db.prepare(`
    UPDATE customer_subscriptions
    SET paid_until = ?, access_expires_at = ?, status = ?,
        gateway_payment_id = COALESCE(?, gateway_payment_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newPaidUntil, newPaidUntil, newStatus, gatewayPaymentId || null, subscriptionId);

  logSubscriptionAudit({
    subscriptionId,
    userId: current.user_id,
    productId: current.product_id,
    oldStatus,
    newStatus,
    action: 'RENEWED',
    reason: reason || `Renovação confirmada até ${newPaidUntil}`,
    details: { newPaidUntil, gatewayPaymentId, adminId },
  });

  return getUserSubscriptionById(subscriptionId);
}

function cancelSubscription(subscriptionId, { reason = null, adminId = 0 } = {}) {
  const current = db.prepare('SELECT * FROM customer_subscriptions WHERE id = ?').get(subscriptionId);
  if (!current) throw new Error('Assinatura não encontrada.');

  const oldStatus = current.status;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE customer_subscriptions
    SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(now, reason || 'Cancelamento solicitado (sem fidelidade)', subscriptionId);

  logSubscriptionAudit({
    subscriptionId,
    userId: current.user_id,
    productId: current.product_id,
    oldStatus,
    newStatus: 'CANCELLED',
    action: 'CANCELLED',
    reason: reason || 'Cancelamento solicitado (sem fidelidade)',
    details: { adminId, accessRetainedUntil: current.paid_until },
  });

  return getUserSubscriptionById(subscriptionId);
}

function getUserSubscriptionById(id) {
  const row = db.prepare(`
    SELECT cs.*,
           p.code AS product_code, p.name AS product_name, p.category AS product_category, p.icon AS product_icon, p.metadata_json AS product_metadata,
           pp.name AS plan_name, pp.code AS plan_code, pp.max_professionals AS plan_max_professionals, pp.features_json AS plan_features
    FROM customer_subscriptions cs
    JOIN products p ON p.id = cs.product_id
    LEFT JOIN product_plans pp ON pp.id = cs.plan_id
    WHERE cs.id = ?
  `).get(id);

  return row ? formatSubscriptionRow(row) : null;
}

function logSubscriptionAudit({ subscriptionId, userId, productId, oldStatus, newStatus, action, reason, details }) {
  try {
    db.prepare(`
      INSERT INTO subscription_audit_logs (
        subscription_id, user_id, product_id, old_status, new_status, action, reason, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      subscriptionId,
      userId,
      productId,
      oldStatus || null,
      newStatus,
      action,
      reason || null,
      details ? JSON.stringify(details) : null
    );
  } catch (err) {
    console.warn('[productService] Falha ao registrar log de auditoria:', err.message);
  }
}

// ==========================================
// 3. ADMIN METRICS & REPORTING
// ==========================================

function getMultiproductMetrics() {
  const products = listProducts({ activeOnly: false, includePlans: false });

  const metricsByProduct = products.map(prod => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) AS total_contracts,
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN status = 'OVERDUE' THEN 1 ELSE 0 END) AS overdue_count,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_count,
        SUM(CASE WHEN status = 'ACTIVE' THEN price_cents ELSE 0 END) AS active_mrr_cents
      FROM customer_subscriptions
      WHERE product_id = ?
    `).get(prod.id);

    return {
      productId: prod.id,
      productCode: prod.code,
      productName: prod.name,
      category: prod.category,
      totalContracts: Number(stats?.total_contracts || 0),
      activeCount: Number(stats?.active_count || 0),
      overdueCount: Number(stats?.overdue_count || 0),
      pendingCount: Number(stats?.pending_count || 0),
      cancelledCount: Number(stats?.cancelled_count || 0),
      activeMrrCents: Number(stats?.active_mrr_cents || 0),
      activeMrrFormatted: (Number(stats?.active_mrr_cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    };
  });

  const channelStats = db.prepare(`
    SELECT
      origin,
      COUNT(*) AS total_contracts,
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN status = 'ACTIVE' THEN price_cents ELSE 0 END) AS mrr_cents
    FROM customer_subscriptions
    GROUP BY origin
  `).all();

  const totalMrrCents = metricsByProduct.reduce((acc, p) => acc + p.activeMrrCents, 0);

  return {
    metricsByProduct,
    channelStats: channelStats.map(c => ({
      origin: c.origin,
      totalContracts: Number(c.total_contracts || 0),
      activeCount: Number(c.active_count || 0),
      mrrCents: Number(c.mrr_cents || 0),
      mrrFormatted: (Number(c.mrr_cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    })),
    totalMrrCents,
    totalMrrFormatted: (totalMrrCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  };
}

function listAllSubscriptions({ productId, status, origin, limit = 100 } = {}) {
  let query = `
    SELECT cs.*,
           u.name AS user_name, u.email AS user_email, u.phone_number AS user_phone,
           p.code AS product_code, p.name AS product_name,
           pp.name AS plan_name, pp.code AS plan_code
    FROM customer_subscriptions cs
    JOIN users u ON u.id = cs.user_id
    JOIN products p ON p.id = cs.product_id
    LEFT JOIN product_plans pp ON pp.id = cs.plan_id
    WHERE 1=1
  `;
  const params = [];

  if (productId) {
    query += ' AND cs.product_id = ?';
    params.push(productId);
  }
  if (status) {
    query += ' AND cs.status = ?';
    params.push(status);
  }
  if (origin) {
    query += ' AND cs.origin = ?';
    params.push(origin);
  }

  query += ' ORDER BY cs.id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params).map(r => ({
    ...formatSubscriptionRow(r),
    userName: r.user_name,
    userEmail: r.user_email,
    userPhone: r.user_phone,
  }));
}

// ==========================================
// 4. HELPERS
// ==========================================

function safeJsonParse(val, fallback) {
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

function formatSubscriptionRow(row) {
  const isPaidPeriodValid = row.paid_until ? new Date(row.paid_until) >= new Date() : false;
  let isAccessActive = false;

  if (row.status === 'ACTIVE' && (isPaidPeriodValid || !row.paid_until)) {
    isAccessActive = true;
  } else if (row.status === 'CANCELLED' && isPaidPeriodValid) {
    // Sem fidelidade: access active until cycle end
    isAccessActive = true;
  } else if (row.status === 'OVERDUE' && isPaidPeriodValid) {
    isAccessActive = true;
  }

  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    productCategory: row.product_category,
    productIcon: row.product_icon || 'bot',
    planId: row.plan_id,
    planCode: row.plan_code || null,
    planName: row.plan_name || 'Personalizado',
    planFeatures: row.plan_features ? safeJsonParse(row.plan_features, []) : [],
    maxProfessionals: row.plan_max_professionals || 1,
    origin: row.origin,
    gateway: row.gateway,
    gatewaySubscriptionId: row.gateway_subscription_id,
    gatewayCustomerId: row.gateway_customer_id,
    gatewayPaymentId: row.gateway_payment_id,
    status: row.status,
    isAccessActive,
    priceCents: row.price_cents,
    priceFormatted: (row.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    setupFeeCents: row.setup_fee_cents,
    setupFeeFormatted: (row.setup_fee_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    billingCycle: row.billing_cycle,
    promotionalFair: Boolean(row.promotional_fair),
    extraProfessionals: row.extra_professionals || 0,
    contractedAt: row.contracted_at,
    paidUntil: row.paid_until,
    accessExpiresAt: row.access_expires_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    customSettings: row.custom_settings_json ? safeJsonParse(row.custom_settings_json, {}) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  listProducts,
  getProductByCode,
  getProductById,
  createProduct,
  updateProduct,
  createPlan,
  updatePlan,
  getUserSubscriptions,
  getUserSubscriptionForProduct,
  hasProductAccess,
  createCustomerSubscription,
  updateSubscriptionStatus,
  renewSubscription,
  cancelSubscription,
  getUserSubscriptionById,
  getMultiproductMetrics,
  listAllSubscriptions,
};
