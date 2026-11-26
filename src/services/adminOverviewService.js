'use strict';

/**
 * src/services/adminOverviewService.js
 *
 * Serviço de Consolidação da Visão Geral Administrativa e Gestão Central de Clientes
 * Plataforma RAIA AGENTES - COMANDO 073 Fase 4
 *
 * Princípios ASVS / LGPD:
 * - Consultas 100% parametrizadas no SQLite nativo.
 * - Minimização e mascaramento de dados pessoais (LGPD).
 * - Distinção contábil estrita: receita contratada (MRR), recebida (confirmada) e prevista.
 * - Segregação estrita por tenant e integridade relacional.
 */

const db = require('../database/db');
const phoneUtils = require('../utils/phoneUtils');

function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***';
  const name = parts[0];
  const domain = parts[1];
  const visible = name.length > 2 ? name.slice(0, 2) : name.slice(0, 1);
  return `${visible}***@${domain}`;
}

/**
 * Retorna os indicadores centrais e consolidados da plataforma
 */
function getAdminOverviewMetrics() {
  // 1. Clientes cadastrados (excluindo ADMINs do sistema)
  const clientsRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM users
    WHERE role != 'ADMIN'
  `).get();
  const totalClients = Number(clientsRow?.total || 0);

  // 2. Assinaturas por Status e MRR
  const subsRow = db.prepare(`
    SELECT
      COUNT(*) AS total_subscriptions,
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_subscriptions,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_subscriptions,
      SUM(CASE WHEN status = 'OVERDUE' THEN 1 ELSE 0 END) AS overdue_subscriptions,
      SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_subscriptions,
      SUM(CASE WHEN status = 'ACTIVE' THEN price_cents ELSE 0 END) AS mrr_cents
    FROM customer_subscriptions
  `).get();

  const activeSubscriptions = Number(subsRow?.active_subscriptions || 0);
  const pendingSubscriptions = Number(subsRow?.pending_subscriptions || 0);
  const overdueSubscriptions = Number(subsRow?.overdue_subscriptions || 0);
  const cancelledSubscriptions = Number(subsRow?.cancelled_subscriptions || 0);
  const mrrCents = Number(subsRow?.mrr_cents || 0);
  const mrrFormatted = (mrrCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // 3. Receita Efetivamente Confirmada, Deduções e Receita Líquida (Asaas + Hotmart com junção determinística)
  let asaasGrossCents = 0;
  let asaasDeductionsCents = 0;
  let asaasCount = 0;
  try {
    const asaasGrossRow = db.prepare(`
      SELECT
        COALESCE(SUM(ROUND(ap.value * 100)), 0) AS total_cents,
        COUNT(ap.id) AS count
      FROM asaas_payments ap
      JOIN (
        SELECT asaas_id, MAX(id) AS max_id
        FROM asaas_payments
        WHERE asaas_id IS NOT NULL
        GROUP BY asaas_id
      ) latest ON latest.max_id = ap.id
      WHERE ap.status IN ('CONFIRMED', 'RECEIVED')
    `).get();
    asaasGrossCents = Number(asaasGrossRow?.total_cents || 0);
    asaasCount = Number(asaasGrossRow?.count || 0);

    const asaasDedRow = db.prepare(`
      SELECT COALESCE(SUM(ROUND(ap.value * 100)), 0) AS total_cents
      FROM asaas_payments ap
      JOIN (
        SELECT asaas_id, MAX(id) AS max_id
        FROM asaas_payments
        WHERE asaas_id IS NOT NULL
        GROUP BY asaas_id
      ) latest ON latest.max_id = ap.id
      WHERE ap.status IN ('REFUNDED', 'CHARGEBACK', 'CHARGED_BACK')
    `).get();
    asaasDeductionsCents = Number(asaasDedRow?.total_cents || 0);
  } catch (_) {}

  let hotmartGrossCents = 0;
  let hotmartDeductionsCents = 0;
  let hotmartAuditedCount = 0;
  try {
    const hotmartGrossRow = db.prepare(`
      SELECT
        COALESCE(SUM(h.price_cents), 0) AS total_cents,
        COUNT(h.price_cents) AS audited_count
      FROM hotmart_webhook_events h
      JOIN (
        SELECT transaction_code, MAX(id) AS max_id
        FROM hotmart_webhook_events
        WHERE event_name IN ('PURCHASE_APPROVED', 'ORDER_APPROVED')
          AND status = 'PROCESSED'
          AND transaction_code IS NOT NULL
        GROUP BY transaction_code
      ) latest ON latest.max_id = h.id
      WHERE h.price_cents IS NOT NULL
    `).get();
    hotmartGrossCents = Number(hotmartGrossRow?.total_cents || 0);
    hotmartAuditedCount = Number(hotmartGrossRow?.audited_count || 0);

    const hotmartDedRow = db.prepare(`
      SELECT
        COALESCE(SUM(COALESCE(ref.price_cents, orig.price_cents, 0)), 0) AS total_cents
      FROM hotmart_webhook_events ref
      JOIN (
        SELECT transaction_code, MAX(id) AS max_id
        FROM hotmart_webhook_events
        WHERE event_name IN ('PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK')
          AND status = 'PROCESSED'
          AND transaction_code IS NOT NULL
        GROUP BY transaction_code
      ) latest_ref ON latest_ref.max_id = ref.id
      LEFT JOIN (
        SELECT h_orig.transaction_code, h_orig.price_cents
        FROM hotmart_webhook_events h_orig
        JOIN (
          SELECT transaction_code, MAX(id) AS max_id
          FROM hotmart_webhook_events
          WHERE event_name IN ('PURCHASE_APPROVED', 'ORDER_APPROVED')
            AND status = 'PROCESSED'
            AND price_cents IS NOT NULL
            AND transaction_code IS NOT NULL
          GROUP BY transaction_code
        ) latest_orig ON latest_orig.max_id = h_orig.id
      ) orig ON orig.transaction_code = ref.transaction_code
    `).get();
    hotmartDeductionsCents = Number(hotmartDedRow?.total_cents || 0);
  } catch (_) {}

  // 3.1 Verificação de Usuários Aguardando Reconciliação (needs_reconciliation = 1)
  let pendingReconciliationCount = 0;
  try {
    const recRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM users
      WHERE needs_reconciliation = 1 AND role != 'ADMIN'
    `).get();
    pendingReconciliationCount = Number(recRow?.total || 0);
  } catch (_) {}

  const hasAuditedTransactions = (asaasCount > 0 || hotmartAuditedCount > 0);
  const hasPendingReconciliation = pendingReconciliationCount > 0;
  const isRevenueAudited = hasAuditedTransactions && !hasPendingReconciliation;

  const grossRevenueCents = asaasGrossCents + hotmartGrossCents;
  const deductionsCents = asaasDeductionsCents + hotmartDeductionsCents;
  const netRevenueCents = Math.max(0, grossRevenueCents - deductionsCents);

  const confirmedRevenueFormatted = isRevenueAudited
    ? (netRevenueCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : 'Dados indisponíveis';
  const grossRevenueFormatted = isRevenueAudited
    ? (grossRevenueCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : 'Dados indisponíveis';
  const deductionsFormatted = isRevenueAudited
    ? (deductionsCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : 'Dados indisponíveis';

  // 4. Clientes por Plano (Isolamento por CTE para unicidade)
  let clientsByPlan = [];
  try {
    const planRows = db.prepare(`
      WITH ranked_client_plans AS (
        SELECT
          u.id AS user_id,
          COALESCE(pp.code, u.plan_tier, u.plan, 'START') AS plan_code,
          COALESCE(pp.name, u.plan_tier, u.plan, 'Jéssica Start') AS plan_name,
          ROW_NUMBER() OVER (
            PARTITION BY u.id
            ORDER BY
              CASE WHEN cs.status = 'ACTIVE' THEN 1 ELSE 2 END,
              cs.id DESC
          ) AS rn
        FROM users u
        LEFT JOIN customer_subscriptions cs ON cs.user_id = u.id
        LEFT JOIN product_plans pp ON pp.id = cs.plan_id
        WHERE u.role != 'ADMIN'
      )
      SELECT
        plan_code,
        plan_name,
        COUNT(user_id) AS client_count
      FROM ranked_client_plans
      WHERE rn = 1
      GROUP BY plan_code, plan_name
      ORDER BY client_count DESC
    `).all();
    clientsByPlan = planRows.map(r => ({
      planCode: r.plan_code,
      planName: r.plan_name,
      count: Number(r.client_count || 0),
    }));
  } catch (_) {}

  // 5. Clientes por Canal (Hotmart, Asaas, Direto, NÃO IDENTIFICADO)
  let clientsByChannel = [];
  try {
    const channelRows = db.prepare(`
      WITH ranked_subscriptions AS (
        SELECT
          u.id AS user_id,
          cs.id AS subscription_id,
          cs.origin,
          cs.status,
          cs.price_cents,
          ROW_NUMBER() OVER (
            PARTITION BY u.id
            ORDER BY
              CASE WHEN cs.status = 'ACTIVE' THEN 1 ELSE 2 END,
              cs.id DESC
          ) AS rn
        FROM users u
        LEFT JOIN customer_subscriptions cs ON cs.user_id = u.id
        WHERE u.role != 'ADMIN'
      )
      SELECT
        CASE
          WHEN origin IS NULL OR TRIM(origin) = '' THEN 'NÃO IDENTIFICADO'
          ELSE UPPER(TRIM(origin))
        END AS channel,
        COUNT(user_id) AS client_count,
        COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN price_cents ELSE 0 END), 0) AS mrr_cents
      FROM ranked_subscriptions
      WHERE rn = 1
      GROUP BY channel
      ORDER BY client_count DESC
    `).all();
    clientsByChannel = channelRows.map(r => ({
      channel: r.channel,
      count: Number(r.client_count || 0),
      mrrCents: Number(r.mrr_cents || 0),
      mrrFormatted: (Number(r.mrr_cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    }));
  } catch (_) {}

  // 6. Ativações Pendentes (usuários criados sem senha ou com ativação pendente)
  let pendingActivations = 0;
  try {
    const actRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM users
      WHERE role != 'ADMIN' AND password_hash IS NULL
    `).get();
    pendingActivations = Number(actRow?.total || 0);
  } catch (_) {}

  // 7. Integrações WhatsApp Conectadas e Desconectadas
  let whatsappConnected = 0;
  let whatsappDisconnected = 0;
  try {
    const waRow = db.prepare(`
      SELECT
        SUM(CASE WHEN whatsapp_status = 'CONNECTED' THEN 1 ELSE 0 END) AS connected,
        SUM(CASE WHEN whatsapp_status != 'CONNECTED' OR whatsapp_status IS NULL THEN 1 ELSE 0 END) AS disconnected
      FROM client_salons
    `).get();
    whatsappConnected = Number(waRow?.connected || 0);
    whatsappDisconnected = Number(waRow?.disconnected || 0);
  } catch (_) {}

  return {
    summary: {
      totalClients,
      activeSubscriptions,
      pendingSubscriptions,
      overdueSubscriptions,
      cancelledSubscriptions,
      mrrCents,
      mrrFormatted,
      confirmedRevenueCents: isRevenueAudited ? netRevenueCents : null,
      confirmedRevenueFormatted,
      grossRevenueCents: isRevenueAudited ? grossRevenueCents : null,
      grossRevenueFormatted,
      deductionsCents: isRevenueAudited ? deductionsCents : null,
      deductionsFormatted,
      hasAuditedTransactions,
      hasPendingReconciliation,
      pendingReconciliationCount,
      isRevenueAudited,
      pendingActivations,
      whatsappConnected,
      whatsappDisconnected,
    },
    clientsByPlan,
    clientsByChannel,
  };
}

/**
 * Retorna a lista detalhada e paginada de clientes com dados protegidos pela LGPD
 */
function getAdminClientsList({ search = '', status = '', origin = '', limit = 50, offset = 0 } = {}) {
  let query = `
    WITH ranked_subscriptions AS (
      SELECT
        cs.id AS subscription_id,
        cs.user_id,
        cs.origin AS subscription_origin,
        cs.status AS subscription_status,
        cs.price_cents AS subscription_price_cents,
        cs.plan_id,
        ROW_NUMBER() OVER (
          PARTITION BY cs.user_id
          ORDER BY
            CASE WHEN cs.status = 'ACTIVE' THEN 1 ELSE 2 END,
            cs.id DESC
        ) AS rn
      FROM customer_subscriptions cs
    )
    SELECT
      u.id AS user_id,
      u.name AS user_name,
      u.email AS user_email,
      u.phone_number AS user_phone,
      u.plan_tier AS user_plan,
      u.password_hash AS user_password_hash,
      u.created_at AS user_created_at,
      u.paid_until AS user_paid_until,
      u.subscription_status AS user_sub_status,
      u.needs_reconciliation AS user_needs_reconciliation,
      salon.salon_name,
      salon.whatsapp_status,
      salon.whatsapp_phone,
      salon.google_selected_calendar_id,
      rs.subscription_id,
      rs.subscription_origin,
      rs.subscription_status,
      rs.subscription_price_cents,
      pp.code AS plan_code,
      pp.name AS plan_name
    FROM users u
    LEFT JOIN client_salons salon ON salon.user_id = u.id
    LEFT JOIN ranked_subscriptions rs ON rs.user_id = u.id AND rs.rn = 1
    LEFT JOIN product_plans pp ON pp.id = rs.plan_id
    WHERE u.role != 'ADMIN'
  `;

  const params = [];

  if (search && search.trim()) {
    query += ` AND (u.name LIKE ? OR u.phone_number LIKE ? OR u.email LIKE ? OR salon.salon_name LIKE ?)`;
    const term = `%${search.trim()}%`;
    params.push(term, term, term, term);
  }

  if (status && status.trim()) {
    query += ` AND (COALESCE(rs.subscription_status, u.subscription_status, 'PENDING') = ?)`;
    params.push(status.trim().toUpperCase());
  }

  if (origin && origin.trim()) {
    const normOrigin = origin.trim().toUpperCase();
    if (normOrigin === 'NÃO IDENTIFICADO' || normOrigin === 'NAO IDENTIFICADO') {
      query += ` AND (rs.subscription_origin IS NULL OR TRIM(rs.subscription_origin) = '')`;
    } else {
      query += ` AND UPPER(TRIM(rs.subscription_origin)) = ?`;
      params.push(normOrigin);
    }
  }

  query += ` ORDER BY u.id DESC LIMIT ? OFFSET ?`;
  params.push(Math.min(100, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));

  const rows = db.prepare(query).all(...params);

  return rows.map(r => {
    const isActivated = Boolean(r.user_password_hash);
    const subStatus = (r.subscription_status || r.user_sub_status || 'PENDING').toUpperCase();
    const effectivePlan = r.plan_code || r.user_plan || 'JESSICA_START';
    const channel = (r.subscription_origin && r.subscription_origin.trim())
      ? r.subscription_origin.toUpperCase()
      : 'NÃO IDENTIFICADO';
    const hasGcal = Boolean(r.google_selected_calendar_id && r.google_selected_calendar_id.trim());

    return {
      clientId: r.user_id,
      salonName: r.salon_name || 'Salão Sem Nome',
      contactNameMasked: r.user_name ? r.user_name.split(' ')[0] + ' ***' : 'Cliente ***',
      phoneMasked: r.user_phone ? phoneUtils.maskPhoneNumber(r.user_phone) : null,
      emailMasked: r.user_email ? maskEmail(r.user_email) : null,
      planCode: effectivePlan,
      channel,
      subscriptionStatus: subStatus,
      needsReconciliation: Boolean(r.user_needs_reconciliation === 1),
      hiredAt: r.user_created_at,
      paidUntil: r.user_paid_until || null,
      isAccountActivated: isActivated,
      whatsappStatus: r.whatsapp_status || 'DISCONNECTED',
      googleCalendarStatus: hasGcal ? 'CONNECTED' : 'DISCONNECTED',
    };
  });
}

module.exports = {
  getAdminOverviewMetrics,
  getAdminClientsList,
  maskEmail,
};
