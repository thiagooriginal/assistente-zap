const crypto = require('crypto');
const db = require('../database/db');
const config = require('../config');
const clientAuth = require('./clientAuthService');
const hotmartReconciliation = require('./hotmartReconciliationService');

/**
 * Validate Hotmart Webhook authenticity via official X-HOTMART-HOTTOK header
 */
function validateHotmartHeader(req, customSecret = null) {
  const secret = (customSecret || config.hotmartWebhookSecret || '').trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Hotmart Webhook] ALERTA CRÍTICO: HOTMART_WEBHOOK_SECRET não configurado em ambiente de produção!');
      return false;
    }
    const headerToken = req?.headers?.['x-hotmart-hottok'] || req?.headers?.['hottok'] || req?.body?.hottok;
    return Boolean(headerToken);
  }

  if (!req || !req.headers) return false;

  // Official Hotmart webhook token header
  const headerToken = (
    req.headers['x-hotmart-hottok'] ||
    req.headers['hottok'] ||
    req.body?.hottok ||
    req.query?.hottok ||
    ''
  ).trim();

  if (!headerToken) return false;

  try {
    const a = Buffer.from(headerToken, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return headerToken === secret;
  }
}

/**
 * Identify plan tier from Hotmart 2.0 payload using official Plan IDs or Offer Codes
 * Strictly avoids relying on purchase price values or arbitrary guessing.
 */
function resolvePlanTier(data) {
  const planId = String(
    data?.subscription?.plan?.id ||
    data?.plan?.id ||
    ''
  ).trim();

  const offerCode = String(
    data?.purchase?.offer?.code ||
    data?.offer?.code ||
    ''
  ).trim().toLowerCase();

  // 1. Strict match against official IDs configured in environment
  if (config.hotmartPlanProId) {
    const configuredPro = config.hotmartPlanProId.trim();
    if (planId === configuredPro || offerCode === configuredPro.toLowerCase()) {
      return 'JESSICA_PRO';
    }
  }

  if (config.hotmartPlanStartId) {
    const configuredStart = config.hotmartPlanStartId.trim();
    if (planId === configuredStart || offerCode === configuredStart.toLowerCase()) {
      return 'JESSICA_START';
    }
  }

  // 2. Exact match against known official IDs / standard offer codes
  if (
    planId === 'JESSICA_PRO' ||
    offerCode === 'jessica_pro' ||
    planId.toLowerCase() === 'pro' ||
    offerCode === 'pro'
  ) {
    return 'JESSICA_PRO';
  }

  if (
    planId === 'JESSICA_START' ||
    offerCode === 'jessica_start' ||
    planId.toLowerCase() === 'start' ||
    offerCode === 'start'
  ) {
    return 'JESSICA_START';
  }

  // 3. Fallback: Plan name check if official ID is not yet assigned in .env
  const planName = String(
    data?.subscription?.plan?.name ||
    data?.plan?.name ||
    ''
  ).trim().toUpperCase();

  if (planName.includes('PRO') || planName.includes('PROFISSIONAL') || planName.includes('GESTÃO')) {
    return 'JESSICA_PRO';
  }
  if (planName.includes('START') || planName.includes('INICIAL') || planName.includes('ESSENCIAL')) {
    return 'JESSICA_START';
  }

  // If no official ID configured and no matching key or name
  console.warn(`[Hotmart Webhook] ALERTA: Plano não identificado pelos IDs oficiais (planId: '${planId}', offer: '${offerCode}'). Marcado como pendente de identificação.`);
  return 'PENDING_PLAN_IDENTIFICATION';
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
  const productId = String(product.id || config.hotmartProductId || '8840376');
  const planId = String(subscription.plan?.id || data.plan?.id || purchase.offer?.code || '');
  const planTier = resolvePlanTier(data);

  // 2. Strict Idempotency Check
  const existingEvent = db.prepare('SELECT id, status FROM hotmart_webhook_events WHERE event_id = ?').get(eventId);
  if (existingEvent) {
    console.log(`[Hotmart Webhook] Evento duplicado ignorado (ID: ${eventId}, Evento: ${eventName})`);
    return { success: true, duplicated: true, status: 'ignored', message: 'Evento já processado anteriormente.' };
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

      const auditPayload = JSON.stringify({
        eventId,
        eventName,
        eventCreationDate,
        lastEventAt: existingUser.hotmart_last_event_at,
        currentStatus: existingUser.subscription_status,
        reason: 'OUT_OF_ORDER_DROPPED'
      });

      db.prepare(`
        INSERT INTO hotmart_webhook_events (
          event_id, event_name, creation_date, transaction_code, subscriber_code,
          buyer_email, buyer_phone, product_id, plan_id, raw_payload, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IGNORED_OUT_OF_ORDER')
      `).run(
        eventId, eventName, eventCreationDate, transactionCode, subscriberCode,
        buyerEmail, buyerPhone, productId, planId, auditPayload
      );

      return {
        success: true,
        outOfOrder: true,
        status: 'ignored',
        action: 'IGNORED_OUT_OF_ORDER',
        message: `Evento fora de ordem descartado para preservar o status ${existingUser.subscription_status}.`
      };
    }
  }

  // Sanitize audit payload (without tokens or passwords)
  const auditPayload = JSON.stringify({
    eventId,
    eventName,
    eventCreationDate,
    transactionCode,
    subscriberCode,
    productId,
    planTier,
    buyerEmailMasked: buyerEmail ? buyerEmail.replace(/^(.{2})(.*)(@.*)$/, '$1***$3') : null,
    buyerPhoneSuffix: buyerPhone ? buyerPhone.slice(-4) : null,
    orderDate: purchase.order_date || purchase.approved_date || new Date().toISOString(),
  });

  // Record event in log with creation_date
  db.prepare(`
    INSERT INTO hotmart_webhook_events (
      event_id, event_name, creation_date, transaction_code, subscriber_code,
      buyer_email, buyer_phone, product_id, plan_id, raw_payload, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSING')
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
    auditPayload
  );

  let processingResult = { success: true };

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

        // Send activation WhatsApp message if telephone is available
        if (buyerPhone && buyerPhone.length >= 10 && whatsappSender) {
          try {
            const targetJid = `${buyerPhone}@s.whatsapp.net`;
            const activationUrl = activationToken
              ? `${config.baseUrl}/cliente/ativar?token=${activationToken}`
              : `${config.baseUrl}/cliente/login`;

            const planLabel = planTier === 'JESSICA_PRO' ? 'Jéssica Pro 🌟' : 'Jéssica Start ✂️';

            const welcomeMsg =
              `🎉 *PAGAMENTO APROVADO! SEJA BEM-VINDO(A)!* 🚀\n\n` +
              `Olá, *${buyerName.split(' ')[0]}*! Confirmamos a sua assinatura do plano *${planLabel}* na Hotmart!\n\n` +
              `O seu Assistente Inteligente já está reservado e pronto para ser configurado.\n\n` +
              `👉 *Clique no link abaixo para criar sua senha e acessar o painel do seu salão:*\n` +
              `${activationUrl}\n\n` +
              `_Precisa de ajuda no primeiro acesso? Basta responder esta mensagem!_ 💇‍♀️✨`;

            await whatsappSender(targetJid, welcomeMsg);
            console.log(`[Hotmart Webhook] Mensagem de boas-vindas enviada para WhatsApp ${buyerPhone}`);
          } catch (waErr) {
            console.warn('[Hotmart Webhook] Erro ao enviar WhatsApp de boas-vindas:', waErr.message);
          }
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

      // TROCA DE PLANO (UPGRADE / DOWNGRADE)
      case 'SWITCH_PLAN': {
        const { iso: paidUntil } = extractPaidUntil(data);
        if (existingUser) {
          db.prepare(`
            UPDATE users
            SET plan_tier = ?,
                paid_until = ?,
                hotmart_plan_id = ?,
                subscription_status = 'ACTIVE',
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(planTier, paidUntil, planId, eventCreationDate, existingUser.id);

          console.log(`[Hotmart Webhook] Troca de plano executada para assinante #${existingUser.id}: Novo plano ${planTier}`);
        }
        processingResult = { success: true, action: 'PLAN_SWITCHED', planTier };
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
          db.prepare(`
            UPDATE users
            SET subscription_status = 'OVERDUE',
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(eventCreationDate, existingUser.id);

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

          db.prepare(`
            UPDATE users
            SET subscription_status = 'CANCELED',
                paid_until = ?,
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(finalPaidUntil, eventCreationDate, existingUser.id);

          console.log(`[Hotmart Webhook] Cancelamento registrado para assinante #${existingUser.id}. Acesso mantido até ${finalPaidUntil}`);
        }
        processingResult = { success: true, action: 'SUBSCRIPTION_CANCELED' };
        break;
      }

      // REEMBOLSO (Revogação imediata de acesso)
      case 'PURCHASE_REFUNDED': {
        if (existingUser) {
          db.prepare(`
            UPDATE users
            SET subscription_status = 'REFUNDED',
                paid_until = NULL,
                magic_token = NULL,
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(eventCreationDate, existingUser.id);

          console.log(`[Hotmart Webhook] Acesso revogado imediatamente (Reembolso): #${existingUser.id} (${transactionCode})`);
        }
        processingResult = { success: true, action: 'ACCESS_REVOKED' };
        break;
      }

      // CHARGEBACK (Revogação imediata de acesso)
      case 'PURCHASE_CHARGEBACK': {
        if (existingUser) {
          db.prepare(`
            UPDATE users
            SET subscription_status = 'CHARGEBACK',
                paid_until = NULL,
                magic_token = NULL,
                hotmart_last_event_at = MAX(COALESCE(hotmart_last_event_at, 0), ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(eventCreationDate, existingUser.id);

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
    try {
      const targetUser = existingUser?.id ? db.prepare('SELECT * FROM users WHERE id = ?').get(existingUser.id) : null;
      if (targetUser) {
        const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
        if (jessica) {
          let pCode = 'START';
          if (targetUser.plan_tier?.includes('PRO')) pCode = 'PRO';
          else if (targetUser.plan_tier?.includes('INTERMEDIATE')) pCode = 'INTERMEDIATE';
          const pl = db.prepare('SELECT id, price_cents FROM product_plans WHERE product_id = ? AND code = ?').get(jessica.id, pCode);

          const existingSub = db.prepare('SELECT id FROM customer_subscriptions WHERE user_id = ? AND product_id = ?').get(targetUser.id, jessica.id);
          const subStatus = ['ACTIVE', 'PENDING', 'OVERDUE', 'CANCELLED', 'REFUNDED'].includes(targetUser.subscription_status)
            ? targetUser.subscription_status
            : (targetUser.subscription_status === 'CANCELED' ? 'CANCELLED' : 'PENDING');

          if (existingSub) {
            db.prepare(`
              UPDATE customer_subscriptions
              SET status = ?, paid_until = ?, access_expires_at = ?, plan_id = COALESCE(?, plan_id),
                  gateway_subscription_id = COALESCE(?, gateway_subscription_id),
                  gateway_payment_id = COALESCE(?, gateway_payment_id),
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(subStatus, targetUser.paid_until || null, targetUser.paid_until || null, pl?.id || null, targetUser.hotmart_subscriber_code || null, targetUser.hotmart_transaction || null, existingSub.id);
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
              subStatus, pl?.price_cents || 8900,
              targetUser.paid_until || null, targetUser.paid_until || null
            );
          }
        }
      }
    } catch (csErr) {
      console.warn('[Hotmart Webhook] Aviso ao sincronizar customer_subscriptions:', csErr.message);
    }

    // Mark event as processed in audit table
    db.prepare("UPDATE hotmart_webhook_events SET status = 'PROCESSED' WHERE event_id = ?").run(eventId);

    return processingResult;
  } catch (err) {
    db.prepare("UPDATE hotmart_webhook_events SET status = 'ERROR' WHERE event_id = ?").run(eventId);
    console.error(`[Hotmart Webhook] Erro ao processar evento ${eventName} (ID: ${eventId}):`, err);
    return { success: false, error: err.message };
  }
}

function getIntegrationStatus() {
  const hasSecret = Boolean(config.hotmartWebhookSecret);
  const hasStartId = Boolean(config.hotmartPlanStartId);
  const hasProId = Boolean(config.hotmartPlanProId);
  const hasApiClient = Boolean(process.env.HOTMART_CLIENT_ID && process.env.HOTMART_CLIENT_SECRET);

  return {
    productId: config.hotmartProductId || '8840376',
    webhookSecretConfigured: hasSecret,
    planStartId: hasStartId ? config.hotmartPlanStartId : 'PENDENTE (Não configurado no .env)',
    planProId: hasProId ? config.hotmartPlanProId : 'PENDENTE (Não configurado no .env)',
    apiReconciliationConfigured: hasApiClient,
    isProductionReady: hasSecret && hasStartId && hasProId,
    pendingItems: [
      ...(!hasSecret ? ['HOTMART_WEBHOOK_SECRET (X-HOTMART-HOTTOK)'] : []),
      ...(!hasStartId ? ['HOTMART_PLAN_START_ID (ID oficial do plano Start na Hotmart)'] : []),
      ...(!hasProId ? ['HOTMART_PLAN_PRO_ID (ID oficial do plano Pro na Hotmart)'] : []),
      ...(!hasApiClient ? ['HOTMART_CLIENT_ID / HOTMART_CLIENT_SECRET (Opcional, para consulta de reconciliação de vigência via API)'] : []),
    ],
  };
}

module.exports = {
  validateHotmartHeader,
  processWebhook,
  handleHotmartWebhook: processWebhook,
  resolvePlanTier,
  extractPaidUntil,
  getIntegrationStatus,
};
