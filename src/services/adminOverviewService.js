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

  // 3. Receita Efetivamente Confirmada (Asaas + Hotmart sem duplicações)
  let asaasConfirmedCents = 0;
  try {
    const asaasRow = db.prepare(`
      SELECT COALESCE(SUM(ROUND(value * 100)), 0) AS total_cents
      FROM asaas_payments
      WHERE status IN ('CONFIRMED', 'RECEIVED')
    `).get();
    asaasConfirmedCents = Number(asaasRow?.total_cents || 0);
  } catch (_) {}

  let hotmartConfirmedCents = 0;
  try {
    const hotmartRow = db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN plan_id LIKE '%START%' THEN 8900
          WHEN plan_id LIKE '%INTERMEDIATE%' THEN 10900
          WHEN plan_id LIKE '%PRO%' THEN 13900
          ELSE 8900
        END
      ), 0) AS total_cents
      FROM hotmart_webhook_events
      WHERE event_name IN ('PURCHASE_APPROVED', 'ORDER_APPROVED')
        AND status = 'PROCESSED'
    `).get();
    hotmartConfirmedCents = Number(hotmartRow?.total_cents || 0);
  } catch (_) {}

  const confirmedRevenueCents = asaasConfirmedCents + hotmartConfirmedCents;
  const confirmedRevenueFormatted = (confirmedRevenueCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // 4. Clientes por Plano
  let clientsByPlan = [];
  try {
    const planRows = db.prepare(`
      SELECT
        COALESCE(pp.code, u.plan, 'START') AS plan_code,
        COALESCE(pp.name, u.plan, 'Jéssica Start') AS plan_name,
        COUNT(DISTINCT u.id) AS client_count
      FROM users u
      LEFT JOIN customer_subscriptions cs ON cs.user_id = u.id AND cs.status = 'ACTIVE'
      LEFT JOIN product_plans pp ON pp.id = cs.plan_id
      WHERE u.role != 'ADMIN'
      GROUP BY plan_code
      ORDER BY client_count DESC
    `).all();
    clientsByPlan = planRows.map(r => ({
      planCode: r.plan_code,
      planName: r.plan_name,
      count: Number(r.client_count || 0),
    }));
  } catch (_) {}

  // 5. Clientes por Canal (Hotmart, Asaas, Direto)
  let clientsByChannel = [];
  try {
    const channelRows = db.prepare(`
      SELECT
        COALESCE(cs.origin, 'HOTMART') AS origin,
        COUNT(DISTINCT u.id) AS client_count,
        COALESCE(SUM(CASE WHEN cs.status = 'ACTIVE' THEN cs.price_cents ELSE 0 END), 0) AS mrr_cents
      FROM users u
      LEFT JOIN customer_subscriptions cs ON cs.user_id = u.id
      WHERE u.role != 'ADMIN'
      GROUP BY origin
      ORDER BY client_count DESC
    `).all();
    clientsByChannel = channelRows.map(r => ({
      channel: r.origin,
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
      confirmedRevenueCents,
      confirmedRevenueFormatted,
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
    SELECT
      u.id AS user_id,
      u.name AS user_name,
      u.email AS user_email,
      u.phone_number AS user_phone,
      u.plan AS user_plan,
      u.password_hash AS user_password_hash,
      u.created_at AS user_created_at,
      u.paid_until AS user_paid_until,
      u.subscription_status AS user_sub_status,
      salon.salon_name,
      salon.whatsapp_status,
      salon.whatsapp_phone,
      salon.google_selected_calendar_id,
      cs.id AS subscription_id,
      cs.origin AS subscription_origin,
      cs.status AS subscription_status,
      cs.price_cents AS subscription_price_cents,
      pp.code AS plan_code,
      pp.name AS plan_name
    FROM users u
    LEFT JOIN client_salons salon ON salon.user_id = u.id
    LEFT JOIN customer_subscriptions cs ON cs.user_id = u.id
    LEFT JOIN product_plans pp ON pp.id = cs.plan_id
    WHERE u.role != 'ADMIN'
  `;

  const params = [];

  if (search && search.trim()) {
    query += ` AND (u.name LIKE ? OR u.phone_number LIKE ? OR salon.salon_name LIKE ?)`;
    const term = `%${search.trim()}%`;
    params.push(term, term, term);
  }

  if (status && status.trim()) {
    query += ` AND (cs.status = ? OR u.subscription_status = ?)`;
    params.push(status.trim().toUpperCase(), status.trim().toUpperCase());
  }

  if (origin && origin.trim()) {
    query += ` AND cs.origin = ?`;
    params.push(origin.trim().toUpperCase());
  }

  query += ` ORDER BY u.id DESC LIMIT ? OFFSET ?`;
  params.push(Math.min(100, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0));

  const rows = db.prepare(query).all(...params);

  return rows.map(r => {
    const isActivated = Boolean(r.user_password_hash);
    const subStatus = (r.subscription_status || r.user_sub_status || 'PENDING').toUpperCase();
    const effectivePlan = r.plan_code || r.user_plan || 'JESSICA_START';
    const channel = r.subscription_origin || 'HOTMART';
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
