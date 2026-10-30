const crypto = require('crypto');
const db = require('../database/db');

// Anonymize IP using SHA-256 with salt according to LGPD guidelines
function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + '_raia_salt').digest('hex').substring(0, 16);
}

/**
 * Record marketing / tracking event
 */
function recordEvent({
  eventName,
  visitorId = null,
  utmSource = null,
  utmMedium = null,
  utmCampaign = null,
  utmContent = null,
  utmTerm = null,
  src = null,
  sck = null,
  pageUrl = null,
  referrer = null,
  ip = null,
  userAgent = null,
  metadata = null,
}) {
  try {
    const metaStr = typeof metadata === 'object' ? JSON.stringify(metadata) : metadata;
    const ipHashed = hashIp(ip);

    db.prepare(`
      INSERT INTO marketing_events (
        event_name, visitor_id, utm_source, utm_medium, utm_campaign,
        utm_content, utm_term, src, sck, page_url, referrer, ip_hash, user_agent, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventName || 'page_view',
      visitorId,
      utmSource || 'direct',
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      src,
      sck,
      pageUrl,
      referrer,
      ipHashed,
      userAgent,
      metaStr
    );

    return { success: true };
  } catch (err) {
    console.warn('[Analytics] Erro ao gravar evento de marketing:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get aggregated marketing overview for Admin panel
 */
function getMarketingOverview(days = 30) {
  try {
    const timeLimit = `-${parseInt(days, 10) || 30} days`;

    // 1. Total events and unique visitors
    const totalVisits = db.prepare(`
      SELECT COUNT(*) as total, COUNT(DISTINCT visitor_id) as uniques
      FROM marketing_events
      WHERE created_at >= datetime('now', ?)
    `).get(timeLimit) || { total: 0, uniques: 0 };

    // 2. Conversion Funnel
    const funnelRows = db.prepare(`
      SELECT event_name, COUNT(*) as count
      FROM marketing_events
      WHERE created_at >= datetime('now', ?)
      GROUP BY event_name
    `).all(timeLimit) || [];

    const funnel = {
      pageViews: 0,
      whatsappClicks: 0,
      demoRequested: 0,
      checkoutInitiates: 0,
      purchasesApproved: 0,
    };

    for (const r of funnelRows) {
      if (r.event_name === 'page_view') funnel.pageViews += r.count;
      else if (r.event_name === 'click_whatsapp') funnel.whatsappClicks += r.count;
      else if (r.event_name === 'demo_requested') funnel.demoRequested += r.count;
      else if (r.event_name === 'initiate_checkout') funnel.checkoutInitiates += r.count;
      else if (r.event_name === 'purchase_approved') funnel.purchasesApproved += r.count;
    }

    // Also get purchases from hotmart_webhook_events
    const hotmartApproved = db.prepare(`
      SELECT COUNT(*) as count
      FROM hotmart_webhook_events
      WHERE event_name IN ('PURCHASE_APPROVED', 'ORDER_APPROVED')
        AND processed_at >= datetime('now', ?)
    `).get(timeLimit)?.count || 0;

    funnel.purchasesApproved = Math.max(funnel.purchasesApproved, hotmartApproved);

    // 3. Traffic Sources Breakdown (by utm_source, medium, campaign)
    const trafficSources = db.prepare(`
      SELECT
        COALESCE(utm_source, 'direct') as source,
        COALESCE(utm_medium, '-') as medium,
        COALESCE(utm_campaign, '-') as campaign,
        COUNT(*) as visits,
        COUNT(DISTINCT visitor_id) as uniques,
        SUM(CASE WHEN event_name IN ('click_whatsapp', 'request_demo', 'initiate_checkout', 'purchase_approved') THEN 1 ELSE 0 END) as conversions
      FROM marketing_events
      WHERE created_at >= datetime('now', ?)
      GROUP BY source, medium, campaign
      ORDER BY visits DESC
      LIMIT 15
    `).all(timeLimit) || [];

    // 4. Hotmart Active Subscriptions by Plan Tier
    const subsRow = db.prepare(`
      SELECT
        SUM(CASE WHEN plan_tier = 'JESSICA_START' AND subscription_status = 'ACTIVE' THEN 1 ELSE 0 END) as activeStart,
        SUM(CASE WHEN plan_tier = 'JESSICA_PRO' AND subscription_status = 'ACTIVE' THEN 1 ELSE 0 END) as activePro,
        SUM(CASE WHEN subscription_status = 'PENDING' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN subscription_status = 'OVERDUE' THEN 1 ELSE 0 END) as overdue,
        SUM(CASE WHEN subscription_status = 'CANCELED' THEN 1 ELSE 0 END) as canceled,
        SUM(CASE WHEN subscription_status = 'REFUNDED' THEN 1 ELSE 0 END) as refunded
      FROM users
      WHERE is_demo = 0
    `).get() || { activeStart: 0, activePro: 0, pending: 0, overdue: 0, canceled: 0, refunded: 0 };

    const activeStart = subsRow.activeStart || 0;
    const activePro = subsRow.activePro || 0;
    const pendingCount = subsRow.pending || 0;
    const overdueCount = subsRow.overdue || 0;
    const canceledCount = (subsRow.canceled || 0) + (subsRow.refunded || 0);
    const activeCount = activeStart + activePro;
    const totalSubs = activeCount + pendingCount + overdueCount + canceledCount;

    // 5. Recent marketing events feed
    const recentEvents = db.prepare(`
      SELECT
        event_name,
        'browser' as event_source,
        page_url as page_path,
        utm_source,
        utm_campaign,
        created_at
      FROM marketing_events
      ORDER BY id DESC
      LIMIT 20
    `).all() || [];

    return {
      success: true,
      periodDays: days,
      visits: totalVisits,
      funnel: {
        visitors: totalVisits.uniques || totalVisits.total || 0,
        whatsappClicks: funnel.whatsappClicks || 0,
        demoRequests: funnel.demoRequested || 0,
        initiatedCheckouts: funnel.checkoutInitiates || 0,
        approvedPurchases: funnel.purchasesApproved || 0,
        pageViews: funnel.pageViews || 0,
      },
      trafficSources,
      subscriptions: {
        total: totalSubs,
        activeCount,
        startCount: activeStart,
        proCount: activePro,
        pendingCount,
        overdueCount,
        canceledCount,
      },
      recentEvents,
    };
  } catch (err) {
    console.error('[Analytics] Erro ao obter overview de marketing:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get official affiliate sales performance
 */
function getAffiliateSalesOverview(days = 30) {
  try {
    const timeLimit = `-${parseInt(days, 10) || 30} days`;

    const affiliates = db.prepare(`
      SELECT
        affiliate_code,
        affiliate_name,
        COUNT(*) as total_sales,
        SUM(commission_amount) as total_commission,
        currency,
        MAX(sale_date) as last_sale_date
      FROM affiliate_sales
      WHERE created_at >= datetime('now', ?)
      GROUP BY affiliate_code
      ORDER BY total_sales DESC
      LIMIT 25
    `).all(timeLimit) || [];

    const totalStats = db.prepare(`
      SELECT COUNT(*) as total_sales, SUM(commission_amount) as total_commission
      FROM affiliate_sales
      WHERE created_at >= datetime('now', ?)
    `).get(timeLimit) || { total_sales: 0, total_commission: 0 };

    return {
      success: true,
      periodDays: days,
      totalAffiliateSales: totalStats.total_sales || 0,
      totalAffiliateCommission: totalStats.total_commission || 0,
      affiliates,
    };
  } catch (err) {
    console.error('[Analytics] Erro ao obter dados de afiliados:', err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  recordEvent,
  logMarketingEvent: recordEvent,
  getMarketingOverview,
  getAffiliateSalesOverview,
};
