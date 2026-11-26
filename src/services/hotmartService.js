const crypto = require('crypto');
const db = require('../database/db');
const config = require('../config');
const clientAuth = require('./clientAuthService');
const hotmartReconciliation = require('./hotmartReconciliationService');

/**
 * Validate Hotmart Webhook authenticity
 * Hotmart Webhooks 2.0 delivers the validation token in the official header X-HOTMART-HOTTOK,
 * or within the JSON body payload (req.body.hottok) in standard v1/v2 webhook transmissions.
 * Query string parameters (?hottok=...) are strictly forbidden to prevent token leaks in access logs.
 */
function validateHotmartHeader(req, customSecret = null) {
  const secret = (customSecret || config.hotmartWebhookSecret || '').trim();
  if (!secret) {
    console.warn('[Hotmart Webhook] ALERTA DE SEGURANÇA: HOTMART_WEBHOOK_SECRET não configurado. Bloqueio fail-closed ativo.');
    return false;
  }

  if (!req || !req.headers) return false;

  // Primary: Official X-HOTMART-HOTTOK header. Fallback: JSON body payload parameter. Query parameters strictly forbidden.
  const headerToken = (
    req.headers['x-hotmart-hottok'] ||
    req.headers['hottok'] ||
    req.body?.hottok ||
    ''
  ).trim();

  if (!headerToken) return false;

  try {
    const a = Buffer.from(headerToken, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/**
 * Resolve o tier da assinatura a partir do código de oferta da Hotmart.
 * Mapeamento estrito (FAIL-CLOSED):
 *   ytvdj943 -> JESSICA_PRO
 *   1x8ik7i3 -> JESSICA_INTERMEDIATE
 *   gtt3rhpk -> JESSICA_START
 *
 * @param {string | null} offerCode
 * @returns {'JESSICA_START' | 'JESSICA_INTERMEDIATE' | 'JESSICA_PRO' | null}
 */
function resolveTierFromOfferCode(offerCode) {
  if (!offerCode || typeof offerCode !== 'string') return null;
  const code = offerCode.trim().toLowerCase();
  if (!code) return null;

  const offerPro = (config.hotmartOfferProCode || 'ytvdj943').trim().toLowerCase();
  const offerIntermediate = (config.hotmartOfferIntermediateCode || '1x8ik7i3').trim().toLowerCase();
  const offerStart = (config.hotmartOfferStartCode || 'gtt3rhpk').trim().toLowerCase();

  if (code === offerPro || code === 'ytvdj943') return 'JESSICA_PRO';
  if (code === offerIntermediate || code === '1x8ik7i3') return 'JESSICA_INTERMEDIATE';
  if (code === offerStart || code === 'gtt3rhpk') return 'JESSICA_START';

  return null;
}

/**
 * Resolve o tier da assinatura a partir do Plan ID da Hotmart ou literais canônicos.
 *
 * @param {string | number | null} planId
 * @returns {'JESSICA_START' | 'JESSICA_INTERMEDIATE' | 'JESSICA_PRO' | null}
 */
function resolveTierFromPlanId(planId) {
  if (planId === undefined || planId === null || planId === '') return null;
  const p = String(planId).trim();
  if (!p) return null;
  const pLower = p.toLowerCase();

  if (config.hotmartPlanProId && pLower === config.hotmartPlanProId.trim().toLowerCase()) return 'JESSICA_PRO';
  if (config.hotmartPlanIntermediateId && pLower === config.hotmartPlanIntermediateId.trim().toLowerCase()) return 'JESSICA_INTERMEDIATE';
  if (config.hotmartPlanStartId && pLower === config.hotmartPlanStartId.trim().toLowerCase()) return 'JESSICA_START';

  // Se o planId fornecido for o próprio código de oferta oficial, resolver pelo mapeamento de oferta
  const asOffer = resolveTierFromOfferCode(pLower);
  if (asOffer) return asOffer;

  if (p === 'JESSICA_PRO' || pLower === 'pro') return 'JESSICA_PRO';
  if (p === 'JESSICA_INTERMEDIATE' || pLower === 'intermediate') return 'JESSICA_INTERMEDIATE';
  if (p === 'JESSICA_START' || pLower === 'start') return 'JESSICA_START';

  return null;
}

/**
 * Identify plan tier from Hotmart 2.0 payload using official Offer Codes (Priority 1)
 * or canonical Plan IDs from .env (Priority 2).
 * Strictly avoids guessing, substring matching or defaulting (FAIL-CLOSED).
 *
 * Official offer codes for product 8840376:
 *   gtt3rhpk → JESSICA_START        (R$ 89,00)
 *   1x8ik7i3 → JESSICA_INTERMEDIATE (R$ 109,00)
 *   ytvdj943 → JESSICA_PRO          (R$ 139,00)
 *
 * @param {object} data Hotmart event payload data
 * @returns {'JESSICA_START' | 'JESSICA_INTERMEDIATE' | 'JESSICA_PRO' | null}
 */
function resolvePlanTier(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const rawProductId =
    data?.product?.id ??
    data?.purchase?.product?.id ??
    data?.productId;
  const productId = (rawProductId !== undefined && rawProductId !== null)
    ? String(rawProductId).trim()
    : '';

  const officialProductId = String(config.hotmartProductId || '8840376').trim();

  // Fail-closed: se productId ausente ou incompatível com o produto oficial, rejeitar imediatamente
  if (!productId || productId !== officialProductId) {
    console.warn(
      `[Hotmart Webhook] ALERTA: Produto não corresponde ao oficial (recebido: '${productId}', esperado: '${officialProductId}'). Rejeição fail-closed.`
    );
    return null;
  }

  const rawOfferCode =
    data?.purchase?.offer?.code ??
    data?.offer?.code ??
    null;

  const rawPlanId =
    data?.subscription?.plan?.id ??
    data?.plan?.id ??
    null;

  // ── REGRA DE OFERTA EXCLUSIVA (COMANDO 073.2 Ponto 1) ──
  // Se offer.code foi fornecido, DEVE corresponder a uma das 3 ofertas oficiais.
  // Se fornecido e NÃO for oficial, FAIL-CLOSED imediato sem consultar nome do plano ou planId.
  if (rawOfferCode !== null && rawOfferCode !== undefined && String(rawOfferCode).trim() !== '') {
    const offerTier = resolveTierFromOfferCode(String(rawOfferCode));
    if (!offerTier) {
      console.warn(
        `[Hotmart Webhook] ALERTA FAIL-CLOSED (Oferta Exclusiva): offer.code '${rawOfferCode}' fornecido mas inválido/desconhecido. Rejeição imediata sem fallback para nome.`
      );
      return null;
    }
    return offerTier;
  }

  // ── Prioridade 2: Match contra Plan IDs oficiais (Apenas se offerCode NÃO foi fornecido) ──
  if (rawPlanId !== null && rawPlanId !== undefined && String(rawPlanId).trim() !== '') {
    const planTier = resolveTierFromPlanId(rawPlanId);
    if (planTier) {
      return planTier;
    }
  }

  // ── COMANDO 073.2 Ponto 3: ELIMINAÇÃO TOTAL DE ELEVAÇÃO POR SUBSTRING DO NOME ──
  // Toda inferência baseada em substrings de plan.name ("PRO", "START", "INTERMEDIÁRIO") foi removida.
  console.warn(
    `[Hotmart Webhook] ALERTA FAIL-CLOSED: Plano não identificado por oferta ou planId oficial ` +
    `(rawPlanId: '${rawPlanId}', rawOfferCode: '${rawOfferCode}', product: '${productId}'). Retornando null.`
  );
  return null;
}

/**
 * Extrai o valor real cobrado na transação Hotmart em centavos inteiros
 * @param {object} data
 * @returns {number | null} Valor em centavos inteiros ou null se ausente/inválido
 */
function extractPriceCents(data) {
  const rawValue =
    data?.purchase?.price?.value ??
    data?.purchase?.price ??
    data?.price?.value ??
    data?.price ??
    data?.purchase?.original_offer_price?.value;

  if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
    const num = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue).replace(',', '.'));
    if (!isNaN(num) && num >= 0) {
      return Math.round(num * 100);
    }
  }
  return null;
}

/**
 * Extract next charge / access expiration date directly from Hotmart 2.0 payload
 * In Hotmart 2.0, date_next_charge is a Unix timestamp in milliseconds.
 * This ensures renewals and cancellations reflect the real billing cycle.
 * 
 * COMPLIANCE RULE: When date_next_charge is absent, DO NOT grant 30 days automatically.
 * Instead, mark for reconciliation via Hotmart Subscription API.
 */
function extractPaidUntil(data) {
  const rawDate =
    data?.subscription?.date_next_charge ??
    data?.purchase?.date_next_charge ??
    data?.date_next_charge ??
    data?.subscription?.next_charge_date;

  if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
    const timestamp = typeof rawDate === 'number' ? rawDate : Number(rawDate) || Date.parse(rawDate);
    if (!isNaN(timestamp) && timestamp > 0) {
      return {
        iso: new Date(timestamp).toISOString(),
        isRealHotmartDate: true,
        needsReconciliation: false,
        rawDate,
      };
    }
  }

  // Strict compliance: Do NOT inject 30 days when date is absent!
  return {
    iso: null,
    isRealHotmartDate: false,
    needsReconciliation: true,
    rawDate: null,
  };
}

/**
 * Process Hotmart Webhook 2.0 with:
 * - Strict idempotency (event_id)
 * - Handling of duplicate, delayed, and out-of-order events (creation_date check)
 * - Real billing dates (date_next_charge)
 * - Plan ID resolution
 * - Full lifecycle: purchase approved, renewals, delayed, billeted, plan switch, cancellations, refunds, chargebacks
 */
async function processWebhook(payload, whatsappSender = null) {
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Payload vazio ou inválido.' };
  }

  // 1. Extract core attributes according to Hotmart Webhook 2.0 specification
  const eventId = String(payload.id || payload.event_id || `evt_${payload.event || 'UNKNOWN'}_${Date.now()}`);
  const eventCreationDate = Number(payload.creation_date) || Date.now();
  const eventName = String(payload.event || payload.event_name || '').toUpperCase().trim();
  const data = payload.data || payload;

  const purchase = data.purchase || data;
  const buyer = data.buyer || {};
  const subscription = data.subscription || {};
  const product = data.product || {};
  const affiliate = data.affiliate || (Array.isArray(data.affiliates) && data.affiliates[0] ? data.affiliates[0] : {}) || {};

  const transactionCode = purchase.transaction || purchase.order_id || null;
  const subscriberCode = subscription.subscriber_code || subscription.subscriber?.code || subscription.subscription_id || data.subscriber?.code || null;
  const buyerEmail = (buyer.email || data.subscriber?.email || '').trim().toLowerCase();
  const buyerPhone = (buyer.checkout_phone || buyer.phone || '').replace(/\D/g, '');
  const buyerName = buyer.name || buyer.first_name || data.subscriber?.name || 'Cliente';

  // 1.1 Extração rigorosa de productId sem default permissivo
  const rawProductId =
    product.id ??
    purchase.product?.id ??
    data.productId;
  const productId = (rawProductId !== undefined && rawProductId !== null) ? String(rawProductId).trim() : '';
  const officialProductId = String(config.hotmartProductId || '8840376').trim();

  // Rejeição imediata se produto ausente ou não oficial (Proteção 19 & Regra P0 - Fail-Closed)
  if (!productId || productId !== officialProductId) {
    console.warn(`[Hotmart Webhook] Rejeição fail-closed: produto inválido ou não oficial (recebido: '${productId}', esperado: '${officialProductId}'). Evento: ${eventId}`);
    try {
      db.prepare(`
        INSERT INTO hotmart_webhook_events (
          event_id, event_name, creation_date, transaction_code, subscriber_code,
          buyer_email, buyer_phone, product_id, plan_id, offer_code, raw_payload, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REJECTED_INVALID_PRODUCT')
        ON CONFLICT(event_id) DO UPDATE SET status = 'REJECTED_INVALID_PRODUCT', updated_at = CURRENT_TIMESTAMP
      `).run(
        eventId,
        eventName,
        eventCreationDate,
        transactionCode,
        subscriberCode,
        buyerEmail,
        buyerPhone,
        productId,
        null,
        null,
        JSON.stringify({ reason: 'INVALID_OR_MISSING_PRODUCT_ID', receivedProductId: productId, officialProductId })
      );
    } catch (_) {}
    return { success: false, ignored: true, reason: 'INVALID_OR_MISSING_PRODUCT_ID' };
  }

  const rawPlanId = subscription.plan?.id ?? data.plan?.id ?? null;
  const planId = rawPlanId !== null && rawPlanId !== undefined && String(rawPlanId).trim() !== '' ? String(rawPlanId).trim() : null;
  const rawOfferCode = purchase.offer?.code ?? data.offer?.code ?? null;
  const offerCode = rawOfferCode !== null && rawOfferCode !== undefined && String(rawOfferCode).trim() !== '' ? String(rawOfferCode).trim().toLowerCase() : null;
  const planTier = resolvePlanTier(data);
  const priceCents = extractPriceCents(data);

  // 1.1.1 Detecção de Conflito de Tier entre Oferta e Plano (COMANDO 073.2 Ponto 1)
  if (offerCode && planId) {
    const resolvedOfferTier = resolveTierFromOfferCode(offerCode);
    const resolvedPlanTier = resolveTierFromPlanId(planId);

    if (resolvedOfferTier && resolvedPlanTier && resolvedOfferTier !== resolvedPlanTier) {
      console.warn(
        `[Hotmart Webhook] ALERTA DE SEGURANÇA: Conflito de tier detectado entre oferta ('${offerCode}' -> ${resolvedOfferTier}) ` +
        `e plano ('${planId}' -> ${resolvedPlanTier}) no evento '${eventName}' (ID: ${eventId}). Rejeição sumária com REJECTED_PLAN_OFFER_CONFLICT.`
      );
      try {
        db.prepare(`
          INSERT INTO hotmart_webhook_events (
            event_id, event_name, creation_date, transaction_code, subscriber_code,
            buyer_email, buyer_phone, product_id, plan_id, offer_code, price_cents, raw_payload, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REJECTED_PLAN_OFFER_CONFLICT')
          ON CONFLICT(event_id) DO UPDATE SET status = 'REJECTED_PLAN_OFFER_CONFLICT', updated_at = CURRENT_TIMESTAMP
        `).run(
          eventId,
          eventName,
          eventCreationDate,
          transactionCode,
          subscriberCode,
          buyerEmail,
          buyerPhone,
          productId,
          planId,
          offerCode,
          priceCents,
          JSON.stringify({ reason: 'PLAN_OFFER_TIER_CONFLICT', offerCode, planId, resolvedOfferTier, resolvedPlanTier })
        );
      } catch (_) {}
      return { success: false, ignored: true, reason: 'PLAN_OFFER_TIER_CONFLICT' };
    }
  }

  // 1.2 Validação estrita de plano em eventos de ativação (Regra P0 - Fail Closed)
  const isActivationEvent = ['PURCHASE_APPROVED', 'ORDER_APPROVED', 'SWITCH_PLAN'].includes(eventName);
  if (isActivationEvent && !planTier) {
    console.warn(`[Hotmart Webhook] Rejeição fail-closed: oferta/plano desconhecido em evento de ativação '${eventName}' (ID: ${eventId}). Usuário não será modificado.`);
    try {
      db.prepare(`
        INSERT INTO hotmart_webhook_events (
          event_id, event_name, creation_date, transaction_code, subscriber_code,
          buyer_email, buyer_phone, product_id, plan_id, offer_code, price_cents, raw_payload, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REJECTED_UNKNOWN_OFFER')
        ON CONFLICT(event_id) DO UPDATE SET status = 'REJECTED_UNKNOWN_OFFER', updated_at = CURRENT_TIMESTAMP
      `).run(
        eventId,
        eventName,
        eventCreationDate,
        transactionCode,
        subscriberCode,
        buyerEmail,
        buyerPhone,
        productId,
        planId,
        offerCode,
        priceCents,
        JSON.stringify({ reason: 'UNKNOWN_OR_INVALID_PLAN_TIER', offerCode, planId })
      );
    } catch (_) {}
    return { success: false, ignored: true, reason: 'UNKNOWN_OR_INVALID_PLAN_TIER' };
  }

  // Sanitize audit payload (without tokens or passwords)
  const auditPayload = JSON.stringify({
    eventId,
    eventName,
    eventCreationDate,
    transactionCode,
    subscriberCode,
    productId,
    planId,
    offerCode,
    planTier,
    priceCents,
    buyerEmailMasked: buyerEmail ? buyerEmail.replace(/^(.{2})(.*)(@.*)$/, '$1***$3') : null,
    buyerPhoneSuffix: buyerPhone ? buyerPhone.slice(-4) : null,
    orderDate: purchase.order_date || purchase.approved_date || new Date().toISOString(),
  });

  // 2. Strict Idempotency Check with Error Recovery (Proteção 19)
  const existingEvent = db.prepare('SELECT id, status FROM hotmart_webhook_events WHERE event_id = ?').get(eventId);
  if (existingEvent) {
    if (
      existingEvent.status === 'PROCESSED' ||
      existingEvent.status === 'IGNORED_OUT_OF_ORDER' ||
      existingEvent.status === 'REJECTED_INVALID_PRODUCT' ||
      existingEvent.status === 'REJECTED_UNKNOWN_OFFER' ||
      existingEvent.status === 'REJECTED_PLAN_OFFER_CONFLICT'
    ) {
      console.log(`[Hotmart Webhook] Evento já concluído anteriormente ignorado (ID: ${eventId}, Evento: ${eventName})`);
      return { success: true, duplicated: true, status: 'ignored', message: 'Evento já processado anteriormente.' };
    }
    console.warn(`[Hotmart Webhook] Re-tentativa recebida para evento com status anterior '${existingEvent.status}' (ID: ${eventId}). Retomando processamento com recuperação segura.`);
    try {
      db.prepare("UPDATE hotmart_webhook_events SET status = 'PROCESSING', updated_at = CURRENT_TIMESTAMP WHERE event_id = ?").run(eventId);
    } catch (updErr) {
      console.error('[Hotmart Webhook] Falha ao atualizar status de evento para reprocessamento:', updErr.message);
      return { success: false, error: updErr.message };
    }
  } else {
    try {
      db.prepare(`
        INSERT INTO hotmart_webhook_events (
          event_id, event_name, creation_date, transaction_code, subscriber_code,
          buyer_email, buyer_phone, product_id, plan_id, offer_code, price_cents, raw_payload, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSING')
      `).run(
        eventId,
        eventName,
        eventCreationDate,
        transactionCode,
        subscriberCode,
        buyerEmail,
        buyerPhone,
        productId,
        planId,
        offerCode,
        priceCents,
        auditPayload
      );
    } catch (insErr) {
      if (insErr.message && insErr.message.includes('UNIQUE')) {
        const raceEvt = db.prepare('SELECT id, status FROM hotmart_webhook_events WHERE event_id = ?').get(eventId);
        if (raceEvt && (raceEvt.status === 'PROCESSED' || raceEvt.status === 'IGNORED_OUT_OF_ORDER' || raceEvt.status === 'REJECTED_PLAN_OFFER_CONFLICT')) {
          console.log(`[Hotmart Webhook] Evento ${eventId} já registrado e concluído em concorrência.`);
          return { success: true, duplicated: true, status: 'ignored', message: 'Evento já processado anteriormente.' };
        }
      }
      console.error('[Hotmart Webhook] Falha crítica ao persistir evento de idempotência:', insErr.message);
      return { success: false, error: insErr.message };
    }
  }

  // 3. Find target user if already exists in database
  let existingUser = null;
  if (subscriberCode) {
    existingUser = db.prepare('SELECT * FROM users WHERE hotmart_subscriber_code = ?').get(subscriberCode);
  }
  if (!existingUser && transactionCode) {
    existingUser = db.prepare('SELECT * FROM users WHERE hotmart_transaction = ?').get(transactionCode);
  }
  if (!existingUser && buyerEmail) {
    existingUser = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(buyerEmail);
  }
  if (!existingUser && buyerPhone && buyerPhone.length >= 8) {
    existingUser = db.prepare('SELECT * FROM users WHERE phone_number = ?').get(buyerPhone);
  }

  // 4. Out-of-Order / Delayed Events Check
  // If an older event arrives after a newer event was already processed for this user
  if (existingUser && existingUser.hotmart_last_event_at && eventCreationDate < existingUser.hotmart_last_event_at) {
    const terminalStatuses = ['REFUNDED', 'CHARGEBACK', 'CANCELED'];
    if (terminalStatuses.includes(existingUser.subscription_status)) {
      console.warn(`[Hotmart Webhook] Evento fora de ordem descartado: ${eventName} (creation_date: ${eventCreationDate}) recebido após evento mais recente (${existingUser.hotmart_last_event_at}) do usuário #${existingUser.id} em status terminal ${existingUser.subscription_status}.`);

      const outOfOrderPayload = JSON.stringify({
        eventId,
        eventName,
        eventCreationDate,
        lastEventAt: existingUser.hotmart_last_event_at,
        currentStatus: existingUser.subscription_status,
        reason: 'OUT_OF_ORDER_DROPPED'
      });

      db.prepare(`
        UPDATE hotmart_webhook_events
        SET status = 'IGNORED_OUT_OF_ORDER', raw_payload = ?, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ?
      `).run(outOfOrderPayload, eventId);

      return {
        success: true,
        outOfOrder: true,
        status: 'ignored',
        action: 'IGNORED_OUT_OF_ORDER',
        message: `Evento fora de ordem descartado para preservar o status ${existingUser.subscription_status}.`
      };
    }
  }

  let processingResult = { success: true };
  let pendingWhatsApp = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 5. Handle Affiliate Attribution if present
    if (affiliate.code || affiliate.affiliate_code) {
      try {
        const affCode = affiliate.code || affiliate.affiliate_code;
        const affName = affiliate.name || null;
        const commissionAmount = Number(
          affiliate.commission?.value ||
          data.commissions?.find(c => c.source === 'AFFILIATE')?.value ||
          0
        );

        db.prepare(`
          INSERT INTO affiliate_sales (
            affiliate_code, affiliate_name, transaction_code, product_id, plan_id,
            commission_amount, buyer_email_masked, sale_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          affCode,
          affName,
          transactionCode,
          productId,
          planId,
          commissionAmount,
          buyerEmail ? buyerEmail.replace(/^(.{2})(.*)(@.*)$/, '$1***$3') : null
        );
      } catch (affErr) {
        console.warn('[Hotmart Webhook] Aviso ao registrar afiliado:', affErr.message);
      }
    }

    // 6. Process Events by Official Hotmart 2.0 Event Name
    switch (eventName) {
      // COMPRA APROVADA / RECORRÊNCIA CONFIRMADA
      case 'PURCHASE_APPROVED':
      case 'ORDER_APPROVED': {
        const { iso: paidUntil, isRealHotmartDate, needsReconciliation } = extractPaidUntil(data);
        if (!isRealHotmartDate) {
          console.warn(`[Hotmart Webhook] CONFORMIDADE: date_next_charge ausente no webhook para evento ${eventName}. Concessão automática de 30 dias BLOQUEADA. Assinatura sinalizada para reconciliação via API.`);
        }

        let isNewUser = false;
        let activationToken = null;

        if (!existingUser) {
          isNewUser = true;
          activationToken = crypto.randomBytes(32).toString('hex');
          const tokenExpires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h

          const initialStatus = isRealHotmartDate ? 'PENDING' : 'PENDING_DATE_RECONCILIATION';

          const info = db.prepare(`
            INSERT INTO users (
              email, phone_number, name, role, plan_tier, subscription_status,
              paid_until, hotmart_subscriber_code, hotmart_transaction,
              hotmart_product_id, hotmart_plan_id, activation_token, activation_expires_at,
              hotmart_last_event_at, needs_reconciliation
            ) VALUES (?, ?, ?, 'USER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            buyerEmail || null,
            buyerPhone || `temp_${Date.now()}`,
            buyerName,
            planTier,
            initialStatus,
            paidUntil, // null if absent
            subscriberCode,
            transactionCode,
            productId,
            planId,
            activationToken,
            tokenExpires,
            eventCreationDate,
            needsReconciliation ? 1 : 0
          );

          existingUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
          console.log(`[Hotmart Webhook] Novo cliente criado: ID #${existingUser.id} (${buyerEmail}) - Status: ${initialStatus} - Vigência: ${paidUntil || 'PENDENTE RECONCILIAÇÃO'}`);
        } else {
          // Existing user upgrade / renewal
          // If date_next_charge was absent, preserve existing valid paid_until if already set and in the future
          const effectivePaidUntil = isRealHotmartDate ? paidUntil : (existingUser.paid_until || null);
          const updateStatus = isRealHotmartDate
            ? (existingUser.password_hash ? 'ACTIVE' : 'PENDING')
            : (existingUser.paid_until && new Date(existingUser.paid_until) > new Date() ? (existingUser.password_hash ? 'ACTIVE' : 'PENDING') : 'PENDING_DATE_RECONCILIATION');

          if (!existingUser.password_hash) {
            activationToken = crypto.randomBytes(32).toString('hex');
          }

          db.prepare(`
            UPDATE users
            SET plan_tier = ?,
                subscription_status = ?,
                paid_until = ?,
                hotmart_subscriber_code = COALESCE(?, hotmart_subscriber_code),
                hotmart_transaction = ?,
                hotmart_product_id = ?,
                hotmart_plan_id = ?,
                email = COALESCE(email, ?),
                activation_token = COALESCE(activation_token, ?),
                activation_expires_at = CASE WHEN ? IS NOT NULL THEN datetime('now', '+48 hours') ELSE activation_expires_at END,
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                needs_reconciliation = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            planTier,
            updateStatus,
            effectivePaidUntil,
            subscriberCode,
            transactionCode,
            productId,
            planId,
            buyerEmail || null,
            activationToken,
            activationToken,
            eventCreationDate,
            needsReconciliation ? 1 : 0,
            existingUser.id
          );

          existingUser = db.prepare('SELECT * FROM users WHERE id = ?').get(existingUser.id);
          console.log(`[Hotmart Webhook] Cliente existente atualizado: ID #${existingUser.id} (${buyerEmail}) - Status: ${updateStatus} - Vigência: ${effectivePaidUntil || 'PENDENTE RECONCILIAÇÃO'}`);
        }

        // Trigger asynchronous reconciliation if date_next_charge was missing
        if (needsReconciliation && subscriberCode) {
          hotmartReconciliation.reconcileSubscription({
            subscriberCode,
            transactionCode,
            userId: existingUser.id,
          }).catch((err) => {
            console.warn('[Hotmart Webhook] Tentativa de reconciliação assíncrona falhou:', err.message);
          });
        }

        // Ensure salon record exists
        clientAuth.ensureSalonForUser(existingUser.id, buyerName);

        // Schedule activation WhatsApp message for delivery after atomic DB commit
        if (buyerPhone && buyerPhone.length >= 10 && typeof whatsappSender === 'function') {
          const targetJid = `${buyerPhone}@s.whatsapp.net`;
          const activationUrl = activationToken
            ? `${config.baseUrl}/cliente/ativar?token=${activationToken}`
            : `${config.baseUrl}/cliente/login`;

          /** @type {Record<string, string>} */
          const PLAN_LABELS = {
            JESSICA_START: 'Jéssica Start ✂️',
            JESSICA_INTERMEDIATE: 'Jéssica Intermediário 💼',
            JESSICA_PRO: 'Jéssica Pro 🌟',
          };
          const planLabel = PLAN_LABELS[planTier] || `Plano ${planTier}`;

          const welcomeMsg =
            `🎉 *PAGAMENTO APROVADO! SEJA BEM-VINDO(A)!* 🚀\n\n` +
            `Olá, *${buyerName.split(' ')[0]}*! Confirmamos a sua assinatura do plano *${planLabel}* na Hotmart!\n\n` +
            `O seu Assistente Inteligente já está reservado e pronto para ser configurado.\n\n` +
            `👉 *Clique no link abaixo para criar sua senha e acessar o painel do seu salão:*\n` +
            `${activationUrl}\n\n` +
            `_Precisa de ajuda no primeiro acesso? Basta responder esta mensagem!_ 💇‍♀️✨`;

          pendingWhatsApp = { targetJid, welcomeMsg, phone: buyerPhone };
        }

        processingResult = {
          success: true,
          action: isNewUser ? 'USER_CREATED_PENDING' : 'USER_UPDATED',
          userId: existingUser.id,
          planTier,
          paidUntil,
        };
        break;
      }

      // COMPRA COMPLETA (Fim do período de garantia)
      case 'PURCHASE_COMPLETE': {
        if (existingUser) {
          db.prepare(`
            UPDATE users
            SET hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(eventCreationDate, existingUser.id);
        }
        processingResult = { success: true, action: 'PURCHASE_COMPLETE' };
        break;
      }

      // TROCA DE PLANO (UPGRADE / DOWNGRADE) — ENDURECIMENTO FAIL-CLOSED (COMANDO 073.2 Ponto 1)
      case 'SWITCH_PLAN': {
        const { iso: paidUntil, isRealHotmartDate, needsReconciliation } = extractPaidUntil(data);
        if (existingUser) {
          if (!isRealHotmartDate || needsReconciliation || !paidUntil) {
            console.warn(
              `[Hotmart Webhook] CONFORMIDADE: SWITCH_PLAN recebido sem vigência real para assinante #${existingUser.id} (ID: ${eventId}). ` +
              `Concessão imediata de plano e status 'ACTIVE' BLOQUEADOS. Preservando plan_tier '${existingUser.plan_tier}' e status '${existingUser.subscription_status}'.`
            );

            // Preserva plan_tier anterior e status anterior intactos
            db.prepare(`
              UPDATE users
              SET needs_reconciliation = 1,
                  hotmart_plan_id = COALESCE(?, hotmart_plan_id),
                  hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(planId, eventCreationDate, existingUser.id);

            // Dispara reconciliação assíncrona oficial via Hotmart Subscription API
            if (subscriberCode) {
              hotmartReconciliation.reconcileSubscription({
                subscriberCode,
                transactionCode,
                userId: existingUser.id,
              }).catch((err) => {
                console.warn('[Hotmart Webhook] Tentativa de reconciliação pós SWITCH_PLAN falhou:', err.message);
              });
            }

            processingResult = {
              success: true,
              action: 'PLAN_SWITCH_PENDING_RECONCILIATION',
              userId: existingUser.id,
              preservedPlanTier: existingUser.plan_tier,
              requestedPlanTier: planTier,
              needsReconciliation: true,
            };
          } else {
            // Vigência real comprovada pela Hotmart: aplicar migração de plano com segurança
            db.prepare(`
              UPDATE users
              SET plan_tier = ?,
                  paid_until = ?,
                  hotmart_plan_id = ?,
                  subscription_status = 'ACTIVE',
                  needs_reconciliation = 0,
                  hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(planTier, paidUntil, planId, eventCreationDate, existingUser.id);

            console.log(
              `[Hotmart Webhook] Troca de plano confirmada com vigência real para assinante #${existingUser.id}: ` +
              `Novo plano ${planTier} (vigência até ${paidUntil})`
            );
            processingResult = { success: true, action: 'PLAN_SWITCHED', planTier, paidUntil };
          }
        } else {
          console.warn(`[Hotmart Webhook] Usuário não encontrado para evento SWITCH_PLAN (ID: ${eventId})`);
          processingResult = { success: false, error: 'Usuário não encontrado para SWITCH_PLAN' };
        }
        break;
      }

      // ALTERAÇÃO DA DATA DE COBRANÇA
      case 'UPDATE_SUBSCRIPTION_CHARGE_DATE': {
        const { iso: paidUntil } = extractPaidUntil(data);
        if (existingUser) {
          db.prepare(`
            UPDATE users
            SET paid_until = ?,
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(paidUntil, eventCreationDate, existingUser.id);

          console.log(`[Hotmart Webhook] Data de cobrança atualizada para assinante #${existingUser.id}: Nova data ${paidUntil}`);
        }
        processingResult = { success: true, action: 'CHARGE_DATE_UPDATED' };
        break;
      }

      // BOLETO / PIX GERADO (AGUARDANDO PAGAMENTO)
      case 'PURCHASE_BILLET_PRINTED': {
        if (!existingUser && buyerEmail) {
          // Register buyer in PENDING state without activating paid features
          db.prepare(`
            INSERT INTO users (
              email, phone_number, name, role, plan_tier, subscription_status,
              hotmart_transaction, hotmart_product_id, hotmart_plan_id,
              hotmart_last_event_at
            ) VALUES (?, ?, ?, 'USER', ?, 'INACTIVE', ?, ?, ?, ?)
          `).run(
            buyerEmail,
            buyerPhone || `temp_${Date.now()}`,
            buyerName,
            planTier,
            transactionCode,
            productId,
            planId,
            eventCreationDate
          );
        }
        processingResult = { success: true, action: 'BILLET_PRINTED_AWAITING_PAYMENT' };
        break;
      }

      // INADIMPLÊNCIA / ATRASO NA COBRANÇA
      case 'PURCHASE_DELAYED':
      case 'SUBSCRIPTION_OVERDUE': {
        if (existingUser) {
          const otherActiveContracts = db.prepare(`
            SELECT COUNT(*) AS count
            FROM customer_subscriptions
            WHERE user_id = ?
              AND (gateway != 'HOTMART' AND origin != 'HOTMART')
              AND status = 'ACTIVE'
          `).get(existingUser.id)?.count || 0;

          if (otherActiveContracts === 0) {
            db.prepare(`
              UPDATE users
              SET subscription_status = 'OVERDUE',
                  hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(eventCreationDate, existingUser.id);
          } else {
            db.prepare(`
              UPDATE users
              SET hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(eventCreationDate, existingUser.id);
            console.log(`[Hotmart Webhook] Usuário #${existingUser.id} possui contratos ativos em outros canais. Status global mantido.`);
          }

          console.log(`[Hotmart Webhook] Inadimplência marcada para assinante #${existingUser.id}`);
        }
        processingResult = { success: true, action: 'SUBSCRIPTION_OVERDUE' };
        break;
      }

      // CANCELAMENTO DE ASSINATURA (Preserva período pago)
      case 'SUBSCRIPTION_CANCELLATION': {
        const { iso: paidUntil } = extractPaidUntil(data);
        if (existingUser) {
          // If Hotmart sent the last date of access in date_next_charge, use it; otherwise preserve current paid_until
          const finalPaidUntil = paidUntil || existingUser.paid_until;

          const otherActiveContracts = db.prepare(`
            SELECT COUNT(*) AS count
            FROM customer_subscriptions
            WHERE user_id = ?
              AND (gateway != 'HOTMART' AND origin != 'HOTMART')
              AND status = 'ACTIVE'
          `).get(existingUser.id)?.count || 0;

          if (otherActiveContracts === 0) {
            db.prepare(`
              UPDATE users
              SET subscription_status = 'CANCELED',
                  paid_until = ?,
                  hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(finalPaidUntil, eventCreationDate, existingUser.id);
          } else {
            db.prepare(`
              UPDATE users
              SET hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(eventCreationDate, existingUser.id);
            console.log(`[Hotmart Webhook] Usuário #${existingUser.id} possui contratos ativos em outros canais. Status global da conta mantido.`);
          }

          console.log(`[Hotmart Webhook] Cancelamento registrado para assinante #${existingUser.id}. Acesso mantido até ${finalPaidUntil}`);
        }
        processingResult = { success: true, action: 'SUBSCRIPTION_CANCELED' };
        break;
      }

      // REEMBOLSO (Revogação imediata de acesso)
      case 'PURCHASE_REFUNDED': {
        if (existingUser) {
          const otherActiveContracts = db.prepare(`
            SELECT COUNT(*) AS count
            FROM customer_subscriptions
            WHERE user_id = ?
              AND (gateway != 'HOTMART' AND origin != 'HOTMART')
              AND status = 'ACTIVE'
          `).get(existingUser.id)?.count || 0;

          if (otherActiveContracts === 0) {
            db.prepare(`
              UPDATE users
              SET subscription_status = 'REFUNDED',
                  paid_until = NULL,
                  magic_token = NULL,
                  hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(eventCreationDate, existingUser.id);
          } else {
            db.prepare(`
              UPDATE users
              SET hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(eventCreationDate, existingUser.id);
            console.log(`[Hotmart Webhook] Usuário #${existingUser.id} possui contratos ativos em outros canais. Status global mantido.`);
          }

          console.log(`[Hotmart Webhook] Acesso revogado imediatamente (Reembolso): #${existingUser.id} (${transactionCode})`);
        }
        processingResult = { success: true, action: 'ACCESS_REVOKED' };
        break;
      }

      // CHARGEBACK (Revogação imediata de acesso)
      case 'PURCHASE_CHARGEBACK': {
        if (existingUser) {
          const otherActiveContracts = db.prepare(`
            SELECT COUNT(*) AS count
            FROM customer_subscriptions
            WHERE user_id = ?
              AND (gateway != 'HOTMART' AND origin != 'HOTMART')
              AND status = 'ACTIVE'
          `).get(existingUser.id)?.count || 0;

          if (otherActiveContracts === 0) {
            db.prepare(`
              UPDATE users
              SET subscription_status = 'CHARGEBACK',
                  paid_until = NULL,
                  magic_token = NULL,
                  hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(eventCreationDate, existingUser.id);
          } else {
            db.prepare(`
              UPDATE users
              SET hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(eventCreationDate, existingUser.id);
            console.log(`[Hotmart Webhook] Usuário #${existingUser.id} possui contratos ativos em outros canais. Status global mantido.`);
          }

          console.log(`[Hotmart Webhook] Acesso revogado imediatamente (Chargeback): #${existingUser.id} (${transactionCode})`);
        }
        processingResult = { success: true, action: 'ACCESS_REVOKED' };
        break;
      }

      // COMPRA EXPIRADA / CANCELADA ANTES DO PAGAMENTO
      case 'PURCHASE_EXPIRED':
      case 'PURCHASE_CANCELED': {
        if (existingUser && existingUser.subscription_status === 'INACTIVE') {
          db.prepare(`
            UPDATE users
            SET subscription_status = 'INACTIVE',
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(eventCreationDate, existingUser.id);
        }
        processingResult = { success: true, action: 'PURCHASE_EXPIRED' };
        break;
      }

      // DISPUTA / PROTESTO
      case 'PURCHASE_PROTEST': {
        if (existingUser) {
          db.prepare(`
            UPDATE users
            SET subscription_status = 'OVERDUE',
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(eventCreationDate, existingUser.id);
        }
        processingResult = { success: true, action: 'TRANSACTION_PROTESTED' };
        break;
      }

      default:
        console.log(`[Hotmart Webhook] Evento não mapeado recebido: ${eventName}`);
        processingResult = { success: true, action: 'EVENT_IGNORED_UNKNOWN' };
        break;
    }

    // Sync customer_subscriptions for multiproduct
    const targetUser = existingUser?.id ? db.prepare('SELECT * FROM users WHERE id = ?').get(existingUser.id) : null;
      if (targetUser) {
        const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
        if (jessica) {
          let pCode = 'START';
          if (targetUser.plan_tier?.includes('PRO')) pCode = 'PRO';
          else if (targetUser.plan_tier?.includes('INTERMEDIATE')) pCode = 'INTERMEDIATE';
          const pl = db.prepare('SELECT id, price_cents FROM product_plans WHERE product_id = ? AND code = ?').get(jessica.id, pCode);

          // Find existing subscription EXCLUSIVELY for HOTMART channel and target product
          let existingSub = null;
          if (subscriberCode) {
            existingSub = db.prepare(`
              SELECT id, origin, gateway, status
              FROM customer_subscriptions
              WHERE user_id = ? AND product_id = ? AND gateway = 'HOTMART' AND gateway_subscription_id = ?
            `).get(targetUser.id, jessica.id, subscriberCode);
          }
          if (!existingSub) {
            existingSub = db.prepare(`
              SELECT id, origin, gateway, status
              FROM customer_subscriptions
              WHERE user_id = ? AND product_id = ? AND (gateway = 'HOTMART' OR origin = 'HOTMART')
            `).get(targetUser.id, jessica.id);
          }

          // Compute status for the Hotmart product specifically
          let subStatus = 'PENDING';
          if (['SUBSCRIPTION_CANCELLATION'].includes(eventName)) {
            subStatus = 'CANCELLED';
          } else if (['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK'].includes(eventName)) {
            subStatus = 'REFUNDED';
          } else if (['PURCHASE_DELAYED', 'SUBSCRIPTION_OVERDUE', 'PURCHASE_PROTEST'].includes(eventName)) {
            subStatus = 'OVERDUE';
          } else if (['PURCHASE_APPROVED', 'ORDER_APPROVED'].includes(eventName)) {
            subStatus = 'ACTIVE';
          } else if (eventName === 'SWITCH_PLAN') {
            const { isRealHotmartDate: switchHasRealDate, needsReconciliation: needsRecSwitch } = extractPaidUntil(data);
            if (switchHasRealDate && !needsRecSwitch) {
              subStatus = 'ACTIVE';
            } else {
              subStatus = existingSub?.status || targetUser.subscription_status || 'PENDING';
            }
          } else {
            subStatus = ['ACTIVE', 'PENDING', 'OVERDUE', 'CANCELLED', 'REFUNDED'].includes(targetUser.subscription_status)
              ? targetUser.subscription_status
              : (targetUser.subscription_status === 'CANCELED' ? 'CANCELLED' : 'PENDING');
          }

          const effectivePaidUntil = ['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK'].includes(eventName)
            ? null
            : (targetUser.paid_until || null);

          const finalPriceCents = priceCents !== null ? priceCents : (pl?.price_cents || 8900);

          if (existingSub) {
            db.prepare(`
              UPDATE customer_subscriptions
              SET status = ?, paid_until = ?, access_expires_at = ?, plan_id = COALESCE(?, plan_id),
                  price_cents = COALESCE(?, price_cents),
                  gateway_subscription_id = COALESCE(?, gateway_subscription_id),
                  gateway_payment_id = COALESCE(?, gateway_payment_id),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(subStatus, effectivePaidUntil, effectivePaidUntil, pl?.id || null, finalPriceCents, targetUser.hotmart_subscriber_code || null, targetUser.hotmart_transaction || null, existingSub.id);
          } else {
            db.prepare(`
              INSERT INTO customer_subscriptions (
                user_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
                gateway_payment_id, status, price_cents, setup_fee_cents, billing_cycle,
                contracted_at, paid_until, access_expires_at
              ) VALUES (?, ?, ?, 'HOTMART', 'HOTMART', ?, ?, ?, ?, 0, 'MONTHLY', CURRENT_TIMESTAMP, ?, ?)
            `).run(
              targetUser.id, jessica.id, pl?.id || null,
              targetUser.hotmart_subscriber_code || null, targetUser.hotmart_transaction || null,
              subStatus, finalPriceCents,
              effectivePaidUntil, effectivePaidUntil
            );
          }
        }
      }

    // Mark event as processed in audit table and commit atomic transaction
    db.prepare("UPDATE hotmart_webhook_events SET status = 'PROCESSED', updated_at = CURRENT_TIMESTAMP WHERE event_id = ?").run(eventId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    try {
      db.prepare("UPDATE hotmart_webhook_events SET status = 'ERROR', updated_at = CURRENT_TIMESTAMP WHERE event_id = ?").run(eventId);
    } catch (_) {}
    console.error(`[Hotmart Webhook] Erro ao processar evento ${eventName} (ID: ${eventId}):`, err);
    return { success: false, error: err.message };
  }

  // After successful atomic DB commit, dispatch welcome WhatsApp message if scheduled
  if (pendingWhatsApp && typeof whatsappSender === 'function') {
    try {
      await whatsappSender(pendingWhatsApp.targetJid, pendingWhatsApp.welcomeMsg);
      console.log(`[Hotmart Webhook] Mensagem de boas-vindas enviada para WhatsApp ${pendingWhatsApp.phone}`);
    } catch (waErr) {
      console.warn('[Hotmart Webhook] Erro ao enviar WhatsApp de boas-vindas:', waErr.message);
    }
  }

  return processingResult;
}

function getIntegrationStatus() {
  const hasSecret = Boolean(config.hotmartWebhookSecret);
  const hasStartId = Boolean(config.hotmartPlanStartId);
  const hasIntermediateId = Boolean(config.hotmartPlanIntermediateId);
  const hasProId = Boolean(config.hotmartPlanProId);
  const hasOfferStart = Boolean(config.hotmartOfferStartCode);
  const hasOfferIntermediate = Boolean(config.hotmartOfferIntermediateCode);
  const hasOfferPro = Boolean(config.hotmartOfferProCode);
  const hasApiClient = Boolean(process.env.HOTMART_CLIENT_ID && process.env.HOTMART_CLIENT_SECRET);

  // isProductionReady: webhook secret configurado E os três offer codes oficiais definidos
  const isProductionReady = hasSecret && hasOfferStart && hasOfferIntermediate && hasOfferPro;

  return {
    productId: config.hotmartProductId || '8840376',
    webhookSecretConfigured: hasSecret,

    // Offer codes (identificação primária de ofertas da Hotmart)
    offerCodes: {
      start: hasOfferStart ? config.hotmartOfferStartCode : 'PENDENTE',
      intermediate: hasOfferIntermediate ? config.hotmartOfferIntermediateCode : 'PENDENTE',
      pro: hasOfferPro ? config.hotmartOfferProCode : 'PENDENTE',
    },

    // Plan IDs (identificação secundária por plano de assinatura Hotmart)
    planIds: {
      start: hasStartId ? config.hotmartPlanStartId : 'NÃO CONFIGURADO (opcional)',
      intermediate: hasIntermediateId ? config.hotmartPlanIntermediateId : 'NÃO CONFIGURADO (opcional)',
      pro: hasProId ? config.hotmartPlanProId : 'NÃO CONFIGURADO (opcional)',
    },

    // Mapeamento oficial dos três planos
    planMapping: [
      { tier: 'JESSICA_START', offerCode: config.hotmartOfferStartCode || 'gtt3rhpk', price: 89.0, label: 'Jéssica Start ✂️' },
      { tier: 'JESSICA_INTERMEDIATE', offerCode: config.hotmartOfferIntermediateCode || '1x8ik7i3', price: 109.0, label: 'Jéssica Intermediário 💼' },
      { tier: 'JESSICA_PRO', offerCode: config.hotmartOfferProCode || 'ytvdj943', price: 139.0, label: 'Jéssica Pro 🌟' },
    ],

    apiReconciliationConfigured: hasApiClient,
    isProductionReady,
    pendingItems: [
      ...(!hasSecret ? ['HOTMART_WEBHOOK_SECRET (X-HOTMART-HOTTOK)'] : []),
      ...(!hasOfferStart ? ['HOTMART_OFFER_START_CODE (código da oferta Start)'] : []),
      ...(!hasOfferIntermediate ? ['HOTMART_OFFER_INTERMEDIATE_CODE (código da oferta Intermediário)'] : []),
      ...(!hasOfferPro ? ['HOTMART_OFFER_PRO_CODE (código da oferta Pro)'] : []),
      ...(!hasApiClient ? ['HOTMART_CLIENT_ID / HOTMART_CLIENT_SECRET (Opcional, para reconciliação via API)'] : []),
    ],
  };
}

module.exports = {
  validateHotmartHeader,
  processWebhook,
  handleHotmartWebhook: processWebhook,
  resolveTierFromOfferCode,
  resolveTierFromPlanId,
  resolvePlanTier,
  extractPriceCents,
  extractPaidUntil,
  getIntegrationStatus,
};
