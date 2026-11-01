'use strict';

const db = require('../database/db');

function safeJsonParse(val, fallback = null) {
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch (e) {
    return fallback;
  }
}

/**
 * Multi-Product & Subscription Management Service for RAIA AGENTES
 * Enables dynamic product & plan creation, market segments, multi-contract management,
 * immutable contract terms, and independent access control per product.
 */

// ==========================================
// 1. MARKET SEGMENTS MANAGEMENT (10 CATEGORIES)
// ==========================================

function listSegments({ activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  const rows = db.prepare(`SELECT * FROM product_segments ${where} ORDER BY display_order ASC, name ASC`).all();

  // Attach product counts to each segment
  const countStmt = db.prepare(`
    SELECT segment_id, COUNT(product_id) as count
    FROM product_segment_relations r
    JOIN products p ON p.id = r.product_id
    WHERE p.is_active = 1
    GROUP BY segment_id
  `);
  const counts = countStmt.all();
  const countMap = {};
  for (const c of counts) countMap[c.segment_id] = c.count;

  return rows.map(s => ({
    id: s.id,
    code: s.code,
    name: s.name,
    description: s.description,
    icon: s.icon || 'layers',
    displayOrder: s.display_order,
    isActive: Boolean(s.is_active),
    productCount: countMap[s.id] || 0,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));
}

function getSegmentByCode(code) {
  if (!code) return null;
  const row = db.prepare('SELECT * FROM product_segments WHERE UPPER(code) = UPPER(?)').get(code.trim());
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    icon: row.icon || 'layers',
    displayOrder: row.display_order,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getSegmentById(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM product_segments WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    icon: row.icon || 'layers',
    displayOrder: row.display_order,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createSegment({ code, name, description, icon = 'layers', displayOrder = 0 }) {
  if (!code || !name) {
    throw new Error('Código e nome do segmento são obrigatórios.');
  }
  const cleanCode = String(code).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const cleanName = String(name).trim();

  const existing = db.prepare('SELECT id FROM product_segments WHERE code = ?').get(cleanCode);
  if (existing) {
    throw new Error(`Segmento com código '${cleanCode}' já existe.`);
  }

  const res = db.prepare(`
    INSERT INTO product_segments (code, name, description, icon, display_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(cleanCode, cleanName, description ? String(description).trim() : null, icon || 'layers', Number(displayOrder || 0));

  return getSegmentById(Number(res.lastInsertRowid));
}

function updateSegment(id, updates = {}) {
  const existing = db.prepare('SELECT * FROM product_segments WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('Segmento não encontrado.');
  }

  const name = updates.name !== undefined ? String(updates.name).trim() : existing.name;
  const description = updates.description !== undefined ? String(updates.description).trim() : existing.description;
  const icon = updates.icon !== undefined ? String(updates.icon).trim() : existing.icon;
  const displayOrder = updates.displayOrder !== undefined ? Number(updates.displayOrder) : existing.display_order;
  const isActive = updates.isActive !== undefined ? (updates.isActive ? 1 : 0) : existing.is_active;

  db.prepare(`
    UPDATE product_segments
    SET name = ?, description = ?, icon = ?, display_order = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, description, icon, displayOrder, isActive, id);

  return getSegmentById(id);
}

function deleteSegment(id) {
  const existing = db.prepare('SELECT * FROM product_segments WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('Segmento não encontrado.');
  }
  db.prepare('DELETE FROM product_segment_relations WHERE segment_id = ?').run(id);
  db.prepare('DELETE FROM product_segments WHERE id = ?').run(id);
  return { success: true };
}

function getProductSegments(productId) {
  return db.prepare(`
    SELECT s.id, s.code, s.name, s.description, s.icon, s.display_order
    FROM product_segments s
    JOIN product_segment_relations r ON r.segment_id = s.id
    WHERE r.product_id = ? AND s.is_active = 1
    ORDER BY s.display_order ASC, s.name ASC
  `).all(productId);
}

function setProductSegments(productId, segmentCodesOrIds = []) {
  db.prepare('DELETE FROM product_segment_relations WHERE product_id = ?').run(productId);
  if (!Array.isArray(segmentCodesOrIds) || segmentCodesOrIds.length === 0) return [];

  const insertStmt = db.prepare('INSERT OR IGNORE INTO product_segment_relations (product_id, segment_id) VALUES (?, ?)');
  for (const item of segmentCodesOrIds) {
    let segId = null;
    if (typeof item === 'number' || /^\d+$/.test(item)) {
      segId = Number(item);
    } else if (typeof item === 'string') {
      const segRow = db.prepare('SELECT id FROM product_segments WHERE code = ?').get(item.trim().toLowerCase());
      if (segRow) segId = segRow.id;
    } else if (item && item.id) {
      segId = item.id;
    }
    if (segId) {
      insertStmt.run(productId, segId);
    }
  }

  return getProductSegments(productId);
}

// ==========================================
// 2. PRODUCT & PLAN CATALOG MANAGEMENT
// ==========================================

function listProducts({
  activeOnly = false,
  includePlans = true,
  segmentCode = null,
  solutionType = null,
  search = null,
  commercialStatus = null,
  contractedByUserId = null
} = {}) {
  let query = `SELECT DISTINCT p.* FROM products p`;
  const params = [];
  const whereClauses = [];

  if (activeOnly) {
    whereClauses.push('p.is_active = 1');
  }

  if (segmentCode && segmentCode !== 'ALL' && segmentCode !== 'TODOS') {
    query += ` JOIN product_segment_relations psr ON psr.product_id = p.id
               JOIN product_segments ps ON ps.id = psr.segment_id `;
    whereClauses.push('(UPPER(ps.code) = UPPER(?) OR ps.id = ?)');
    params.push(segmentCode.trim(), Number(segmentCode) || 0);
  }

  if (solutionType && solutionType !== 'ALL' && solutionType !== 'TODOS') {
    whereClauses.push('UPPER(p.solution_type) = UPPER(?)');
    params.push(solutionType.trim());
  }

  if (commercialStatus) {
    whereClauses.push('UPPER(p.commercial_status) = UPPER(?)');
    params.push(commercialStatus.trim());
  }

  if (search && search.trim()) {
    const term = `%${search.trim().toLowerCase()}%`;
    whereClauses.push('(LOWER(p.name) LIKE ? OR LOWER(p.code) LIKE ? OR LOWER(COALESCE(p.description, \'\')) LIKE ? OR LOWER(COALESCE(p.summary, \'\')) LIKE ?)');
    params.push(term, term, term, term);
  }

  if (whereClauses.length > 0) {
    query += ' WHERE ' + whereClauses.join(' AND ');
  }

  query += ' ORDER BY p.has_approved_offer DESC, p.id ASC';

  const products = db.prepare(query).all(...params);

  let allPlans = [];
  if (includePlans) {
    allPlans = db.prepare(`SELECT * FROM product_plans ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY price_cents ASC`).all();
  }

  const allRelations = db.prepare(`
    SELECT r.product_id, s.id, s.code, s.name, s.icon
    FROM product_segment_relations r
    JOIN product_segments s ON s.id = r.segment_id
    WHERE s.is_active = 1
    ORDER BY s.display_order ASC
  `).all();
  const segmentMap = {};
  for (const rel of allRelations) {
    if (!segmentMap[rel.product_id]) segmentMap[rel.product_id] = [];
    segmentMap[rel.product_id].push({
      id: rel.id,
      code: rel.code,
      name: rel.name,
      icon: rel.icon || 'layers'
    });
  }

  const userSubsMap = {};
  if (contractedByUserId) {
    const userSubs = db.prepare(`
      SELECT id, product_id, status, paid_until, price_cents, gateway
      FROM customer_subscriptions
      WHERE user_id = ?
      ORDER BY id DESC
    `).all(contractedByUserId);
    for (const sub of userSubs) {
      if (!userSubsMap[sub.product_id]) {
        userSubsMap[sub.product_id] = sub;
      }
    }
  }

  return products.map(prod => {
    let plans = [];
    if (includePlans) {
      plans = allPlans.filter(p => p.product_id === prod.id).map(p => ({
        ...p,
        priceFormatted: (p.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
        setupFeeFormatted: (p.setup_fee_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
        promoFairPriceFormatted: p.promo_fair_price_cents !== null ? (p.promo_fair_price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : null,
        features: p.features_json ? safeJsonParse(p.features_json, []) : [],
      }));
    }

    const segments = segmentMap[prod.id] || [];
    const userSub = userSubsMap[prod.id] || null;
    const isPaidValid = Boolean(userSub && userSub.paid_until && new Date(userSub.paid_until) >= new Date());
    const isContracted = Boolean(userSub && (userSub.status === 'ACTIVE' || (userSub.status === 'CANCELLED' && isPaidValid)));

    return {
      id: prod.id,
      code: prod.code,
      name: prod.name,
      description: prod.description,
      summary: prod.summary || prod.description,
      targetAudience: prod.target_audience || null,
      category: prod.category,
      solutionType: prod.solution_type || 'AGENDA',
      commercialStatus: prod.commercial_status || 'AVAILABLE',
      hasApprovedOffer: Boolean(prod.has_approved_offer),
      isActive: Boolean(prod.is_active),
      icon: prod.icon || 'bot',
      metadata: prod.metadata_json ? safeJsonParse(prod.metadata_json, {}) : {},
      segments,
      plans,
      isContracted,
      contractStatus: userSub ? userSub.status : null,
      subscriptionId: userSub ? userSub.id : null,
      paidUntil: userSub ? userSub.paid_until : null,
      moduleRoute: prod.code === 'JESSICA' ? '/cliente/painel.html?modulo=jessica' : null
    };
  });
}

function getProductByCode(code, { includePlans = true, userId = null } = {}) {
  if (!code) return null;
  const prod = db.prepare('SELECT * FROM products WHERE UPPER(code) = UPPER(?)').get(code.trim());
  if (!prod) return null;

  let plans = [];
  if (includePlans) {
    plans = db.prepare('SELECT * FROM product_plans WHERE product_id = ? ORDER BY price_cents ASC').all(prod.id).map(p => ({
      ...p,
      priceFormatted: (p.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      setupFeeFormatted: (p.setup_fee_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      promoFairPriceFormatted: p.promo_fair_price_cents !== null ? (p.promo_fair_price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : null,
      features: p.features_json ? safeJsonParse(p.features_json, []) : [],
    }));
  }

  const segments = getProductSegments(prod.id);

  let isContracted = false;
  let userSub = null;
  if (userId) {
    userSub = db.prepare('SELECT id, status, paid_until FROM customer_subscriptions WHERE user_id = ? AND product_id = ? ORDER BY id DESC LIMIT 1').get(userId, prod.id);
    const isPaidValid = Boolean(userSub && userSub.paid_until && new Date(userSub.paid_until) >= new Date());
    isContracted = Boolean(userSub && (userSub.status === 'ACTIVE' || (userSub.status === 'CANCELLED' && isPaidValid)));
  }

  return {
    ...prod,
    summary: prod.summary || prod.description,
    targetAudience: prod.target_audience || null,
    solutionType: prod.solution_type || 'AGENDA',
    commercialStatus: prod.commercial_status || 'AVAILABLE',
    hasApprovedOffer: Boolean(prod.has_approved_offer),
    metadata: prod.metadata_json ? safeJsonParse(prod.metadata_json, {}) : {},
    segments,
    plans,
    isContracted,
    contractStatus: userSub ? userSub.status : null,
    subscriptionId: userSub ? userSub.id : null,
  };
}

function getProductById(id, { includePlans = true, userId = null } = {}) {
  if (!id) return null;
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!prod) return null;

  let plans = [];
  if (includePlans) {
    plans = db.prepare('SELECT * FROM product_plans WHERE product_id = ? ORDER BY price_cents ASC').all(prod.id).map(p => ({
      ...p,
      priceFormatted: (p.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      setupFeeFormatted: (p.setup_fee_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      promoFairPriceFormatted: p.promo_fair_price_cents !== null ? (p.promo_fair_price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : null,
      features: p.features_json ? safeJsonParse(p.features_json, []) : [],
    }));
  }

  const segments = getProductSegments(prod.id);

  let isContracted = false;
  let userSub = null;
  if (userId) {
    userSub = db.prepare('SELECT id, status, paid_until FROM customer_subscriptions WHERE user_id = ? AND product_id = ? ORDER BY id DESC LIMIT 1').get(userId, prod.id);
    const isPaidValid = Boolean(userSub && userSub.paid_until && new Date(userSub.paid_until) >= new Date());
    isContracted = Boolean(userSub && (userSub.status === 'ACTIVE' || (userSub.status === 'CANCELLED' && isPaidValid)));
  }

  return {
    ...prod,
    summary: prod.summary || prod.description,
    targetAudience: prod.target_audience || null,
    solutionType: prod.solution_type || 'AGENDA',
    commercialStatus: prod.commercial_status || 'AVAILABLE',
    hasApprovedOffer: Boolean(prod.has_approved_offer),
    metadata: prod.metadata_json ? safeJsonParse(prod.metadata_json, {}) : {},
    segments,
    plans,
    isContracted,
    contractStatus: userSub ? userSub.status : null,
    subscriptionId: userSub ? userSub.id : null,
  };
}

function getProductCatalogDetails(codeOrId, { userId = null } = {}) {
  let prod = null;
  if (typeof codeOrId === 'number' || /^\d+$/.test(codeOrId)) {
    prod = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(codeOrId));
  } else {
    prod = db.prepare('SELECT * FROM products WHERE UPPER(code) = UPPER(?)').get(String(codeOrId).trim());
  }
  if (!prod) return null;

  const segments = getProductSegments(prod.id);
  const plans = db.prepare('SELECT * FROM product_plans WHERE product_id = ? AND is_active = 1 ORDER BY price_cents ASC').all(prod.id).map(p => ({
    ...p,
    priceFormatted: (p.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    setupFeeFormatted: (p.setup_fee_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    promoFairPriceFormatted: p.promo_fair_price_cents !== null ? (p.promo_fair_price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : null,
    features: p.features_json ? safeJsonParse(p.features_json, []) : [],
  }));

  let userSub = null;
  if (userId) {
    userSub = db.prepare(`
      SELECT * FROM customer_subscriptions
      WHERE user_id = ? AND product_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(userId, prod.id);
  }

  const isPaidValid = Boolean(userSub && userSub.paid_until && new Date(userSub.paid_until) >= new Date());
  const isContracted = Boolean(userSub && (userSub.status === 'ACTIVE' || (userSub.status === 'CANCELLED' && isPaidValid)));
  const meta = prod.metadata_json ? safeJsonParse(prod.metadata_json, {}) : {};
  const canPurchase = Boolean(prod.is_active) &&
    (prod.commercial_status === 'AVAILABLE') &&
    Boolean(prod.has_approved_offer) &&
    plans.length > 0;

  return {
    id: prod.id,
    code: prod.code,
    name: prod.name,
    description: prod.description,
    summary: prod.summary || prod.description,
    targetAudience: prod.target_audience || null,
    category: prod.category,
    solutionType: prod.solution_type || 'AGENDA',
    commercialStatus: prod.commercial_status || 'AVAILABLE',
    hasApprovedOffer: Boolean(prod.has_approved_offer),
    canPurchase,
    plannedFeatures: meta.plannedFeatures || [],
    isActive: Boolean(prod.is_active),
    icon: prod.icon || 'bot',
    metadata: meta,
    segments,
    plans,
    isContracted,
    subscription: userSub ? {
      id: userSub.id,
      status: userSub.status,
      origin: userSub.origin,
      gateway: userSub.gateway,
      priceCents: userSub.price_cents,
      priceFormatted: (userSub.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      paidUntil: userSub.paid_until,
      contractedAt: userSub.contracted_at,
    } : null,
    moduleRoute: prod.code === 'JESSICA' ? '/cliente/painel.html?modulo=jessica' : null
  };
}

function createProduct({
  code,
  name,
  description,
  summary,
  targetAudience,
  category = 'GERAL',
  solutionType = 'AGENDA',
  commercialStatus = 'AVAILABLE',
  hasApprovedOffer = 1,
  icon = 'bot',
  metadata = {},
  segments = []
}) {
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
    INSERT INTO products (
      code, name, description, summary, target_audience,
      category, solution_type, commercial_status, has_approved_offer,
      icon, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanCode,
    cleanName,
    description ? String(description).trim() : null,
    summary ? String(summary).trim() : (description ? String(description).trim() : null),
    targetAudience ? String(targetAudience).trim() : null,
    String(category).trim().toUpperCase(),
    String(solutionType || 'AGENDA').trim().toUpperCase(),
    String(commercialStatus || 'AVAILABLE').trim().toUpperCase(),
    hasApprovedOffer ? 1 : 0,
    icon || 'bot',
    JSON.stringify(metadata || {})
  );

  const prodId = Number(result.lastInsertRowid);
  if (Array.isArray(segments) && segments.length > 0) {
    setProductSegments(prodId, segments);
  }

  return getProductById(prodId);
}

function updateProduct(id, updates = {}) {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('Produto não encontrado.');
  }

  const name = updates.name !== undefined ? String(updates.name).trim() : existing.name;
  const description = updates.description !== undefined ? String(updates.description).trim() : existing.description;
  const summary = updates.summary !== undefined ? String(updates.summary).trim() : existing.summary;
  const targetAudience = updates.targetAudience !== undefined ? String(updates.targetAudience).trim() : existing.target_audience;
  const category = updates.category !== undefined ? String(updates.category).trim().toUpperCase() : existing.category;
  const solutionType = updates.solutionType !== undefined ? String(updates.solutionType).trim().toUpperCase() : existing.solution_type;
  const commercialStatus = updates.commercialStatus !== undefined ? String(updates.commercialStatus).trim().toUpperCase() : existing.commercial_status;
  const hasApprovedOffer = updates.hasApprovedOffer !== undefined ? (updates.hasApprovedOffer ? 1 : 0) : existing.has_approved_offer;
  const icon = updates.icon !== undefined ? String(updates.icon).trim() : existing.icon;
  const isActive = updates.isActive !== undefined ? (updates.isActive ? 1 : 0) : existing.is_active;
  const metadata = updates.metadata !== undefined ? JSON.stringify(updates.metadata) : existing.metadata_json;

  db.prepare(`
    UPDATE products
    SET name = ?, description = ?, summary = ?, target_audience = ?,
        category = ?, solution_type = ?, commercial_status = ?, has_approved_offer = ?,
        icon = ?, is_active = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, description, summary, targetAudience, category, solutionType, commercialStatus, hasApprovedOffer, icon, isActive, metadata, id);

  if (Array.isArray(updates.segments)) {
    setProductSegments(id, updates.segments);
  }

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

  // Active status: must have valid paid period
  if (sub.status === 'ACTIVE') {
    if (paidUntilDate && isPaidPeriodValid) {
      return { hasAccess: true, status: 'ACTIVE', subscription: sub, reason: 'SUBSCRIPTION_ACTIVE' };
    }
    if (!sub.paidUntil) {
      return {
        hasAccess: false,
        status: 'PAYMENT_UNCONFIRMED',
        subscription: sub,
        reason: 'Assinatura sem vigência ou aguardando confirmação de pagamento.',
      };
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

  let effectivePaidUntil = paidUntil || null;
  if (!effectivePaidUntil && status === 'ACTIVE') {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    effectivePaidUntil = d.toISOString();
  }

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
    Number(extraProfessionals || 0), effectivePaidUntil, effectivePaidUntil,
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
  listSegments,
  getSegmentByCode,
  getSegmentById,
  createSegment,
  updateSegment,
  deleteSegment,
  getProductSegments,
  setProductSegments,
  getProductCatalogDetails,
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
