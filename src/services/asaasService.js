const crypto = require('crypto');
const config = require('../config');
const db = require('../database/db');
const { AUDIT_EVENTS, logSecurityEvent } = require('./securityAuditService');

function getHeaders() {
  return {
    access_token: config.asaasApiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'RAIA-RH-App/1.0',
  };
}

function getApiUrl() {
  return (config.asaasApiUrl || 'https://api.asaas.com/v3').replace(/\/+$/, '');
}

/**
 * Check if Asaas is configured
 */
function isConfigured() {
  return Boolean(config.asaasApiKey && config.asaasApiKey.trim().length > 10);
}

/**
 * Helper to make HTTP requests using native fetch
 */
async function asaasRequest(endpoint, options = {}) {
  const url = `${getApiUrl()}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...getHeaders(),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text;
  }

  if (!response.ok) {
    const errorMsg = data?.errors?.[0]?.description || data?.message || response.statusText || 'Erro na requisição Asaas';
    const err = new Error(errorMsg);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

/**
 * Get merchant account details (Name, CNPJ/CPF, Status, etc.)
 */
async function getAccount() {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  return await asaasRequest('/myAccount');
}

/**
 * Get account balance
 */
async function getBalance() {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  return await asaasRequest('/finance/balance');
}

/**
 * Clean phone number to digits only
 */
function cleanPhoneNumber(phone) {
  if (!phone) return '';
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('55') && (cleaned.length === 12 || cleaned.length === 13)) {
    cleaned = cleaned.substring(2);
  }
  return cleaned;
}

/**
 * Find existing customer or create a new one in Asaas
 */
async function findOrCreateCustomer({ name, phone, email, cpfCnpj }) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');

  const cleanPhone = cleanPhoneNumber(phone);
  const cleanEmail = email ? email.trim().toLowerCase() : '';
  const cleanDoc = cpfCnpj ? String(cpfCnpj).replace(/\D/g, '') : null;

  // 1. Try finding by mobilePhone
  if (cleanPhone) {
    try {
      const resPhone = await asaasRequest(`/customers?mobilePhone=${cleanPhone}&limit=1`);
      if (resPhone?.data && resPhone.data.length > 0) {
        return resPhone.data[0];
      }
    } catch (e) {
      console.warn('[Asaas] Busca cliente por telefone falhou:', e.message);
    }
  }

  // 2. Try finding by email
  if (cleanEmail) {
    try {
      const resEmail = await asaasRequest(`/customers?email=${encodeURIComponent(cleanEmail)}&limit=1`);
      if (resEmail?.data && resEmail.data.length > 0) {
        return resEmail.data[0];
      }
    } catch (e) {
      console.warn('[Asaas] Busca cliente por email falhou:', e.message);
    }
  }

  // 3. Try finding by CPF/CNPJ
  if (cleanDoc) {
    try {
      const resDoc = await asaasRequest(`/customers?cpfCnpj=${cleanDoc}&limit=1`);
      if (resDoc?.data && resDoc.data.length > 0) {
        return resDoc.data[0];
      }
    } catch (e) {
      console.warn('[Asaas] Busca cliente por cpfCnpj falhou:', e.message);
    }
  }

  // 4. Create new customer
  const customerPayload = {
    name: (name || 'Cliente RAIA RH').trim(),
    mobilePhone: cleanPhone || undefined,
    email: cleanEmail || undefined,
    cpfCnpj: cleanDoc || undefined,
    notificationDisabled: false,
  };

  const createRes = await asaasRequest('/customers', {
    method: 'POST',
    body: JSON.stringify(customerPayload),
  });

  console.log(`[Asaas] Novo cliente criado no Asaas: ID ${createRes.id} (${customerPayload.name})`);
  return createRes;
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date) {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Create a Pix charge with dynamic QR Code & Pix Copia e Cola
 */
async function createPixCharge({
  customerName,
  customerPhone,
  customerEmail,
  customerCpf,
  value,
  description,
  dueDate,
  externalReference,
}) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');

  const customer = await findOrCreateCustomer({
    name: customerName,
    phone: customerPhone,
    email: customerEmail,
    cpfCnpj: customerCpf,
  });

  const targetDueDate = dueDate || formatDate(new Date(Date.now() + 2 * 24 * 3600 * 1000));
  const numValue = Number(value || 29.00);

  const paymentPayload = {
    customer: customer.id,
    billingType: 'PIX',
    value: numValue,
    dueDate: targetDueDate,
    description: (description || 'Contratação Agente de IA - RAIA RH').slice(0, 500),
    externalReference: externalReference || `LEAD_${Date.now()}`,
    postalService: false,
  };

  const paymentData = await asaasRequest('/payments', {
    method: 'POST',
    body: JSON.stringify(paymentPayload),
  });

  // Retrieve Pix QR Code
  let pixQrCode = null;
  try {
    pixQrCode = await asaasRequest(`/payments/${paymentData.id}/pixQrCode`);
  } catch (qrErr) {
    console.error('[Asaas] Erro ao obter QR Code Pix:', qrErr.message);
  }

  // Save payment in local database
  try {
    db.prepare(`
      INSERT OR REPLACE INTO asaas_payments (
        asaas_id, customer_id, customer_name, customer_phone,
        value, net_value, billing_type, status, description,
        invoice_url, pix_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      paymentData.id,
      customer.id,
      customer.name || customerName,
      customerPhone || customer.mobilePhone,
      paymentData.value,
      paymentData.netValue || paymentData.value,
      'PIX',
      paymentData.status || 'PENDING',
      paymentPayload.description,
      paymentData.invoiceUrl || paymentData.bankSlipUrl || null,
      pixQrCode?.payload || null
    );
  } catch (dbErr) {
    console.warn('[Asaas] Erro ao gravar asaas_payments no DB:', dbErr.message);
  }

  return {
    success: true,
    paymentId: paymentData.id,
    customerId: customer.id,
    customerName: customer.name,
    value: paymentData.value,
    status: paymentData.status,
    dueDate: paymentData.dueDate,
    invoiceUrl: paymentData.invoiceUrl,
    pixQrCode: {
      encodedImage: pixQrCode?.encodedImage || null, // Base64 PNG image
      payload: pixQrCode?.payload || null,           // Copia e Cola string
      expirationDate: pixQrCode?.expirationDate || null,
    },
  };
}

/**
 * Create a universal Payment Link (Checkout) with Pix, Credit Card (up to 12x), or Boleto
 */
async function createPaymentLink({
  name,
  description,
  value,
  billingType = 'UNDEFINED',
  chargeType = 'DETACHED',
  maxInstallmentCount = 12,
  dueDateLimitDays = 3,
}) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');

  const payload = {
    name: name || 'Contratação Agente de IA RAIA RH',
    description: description || 'Acesso ao colaborador de Inteligência Artificial para WhatsApp.',
    endDate: formatDate(new Date(Date.now() + 60 * 24 * 3600 * 1000)),
    value: Number(value || 197.00),
    billingType: billingType || 'UNDEFINED',
    chargeType: chargeType || 'DETACHED',
    maxInstallmentCount: Number(maxInstallmentCount || 12),
    dueDateLimitDays: Number(dueDateLimitDays || 3),
    notificationEnabled: true,
  };

  const response = await asaasRequest('/paymentLinks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return {
    success: true,
    id: response.id,
    url: response.url,
    name: response.name,
    value: response.value,
    active: response.active,
  };
}

/**
 * Get payment details by ID
 */
async function getPayment(paymentId) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  return await asaasRequest(`/payments/${paymentId}`);
}

/**
 * Create an Asaas Monthly Subscription
 */
async function createSubscription({
  customerId,
  billingType = 'BOLETO',
  value,
  nextDueDate,
  cycle = 'MONTHLY',
  description,
  externalReference,
}) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');

  const payload = {
    customer: customerId,
    billingType: billingType || 'BOLETO',
    value: Number(value),
    nextDueDate: nextDueDate || formatDate(new Date(Date.now() + 24 * 3600 * 1000)),
    cycle: cycle || 'MONTHLY',
    description: (description || 'Assinatura Agente IA - RAIA').slice(0, 500),
    externalReference: externalReference || `RAIA_SUB_${Date.now()}`,
    updatePendingPayments: true,
  };

  const response = await asaasRequest('/subscriptions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return response;
}

/**
 * Get subscription details by ID
 */
async function getSubscription(subscriptionId) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  return await asaasRequest(`/subscriptions/${subscriptionId}`);
}

/**
 * List payments of a specific subscription
 */
async function listSubscriptionPayments(subscriptionId, { limit = 10 } = {}) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  return await asaasRequest(`/subscriptions/${subscriptionId}/payments?limit=${limit}`);
}

/**
 * Get Pix QR Code for a specific payment
 */
async function getPaymentPixQrCode(paymentId) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  try {
    return await asaasRequest(`/payments/${paymentId}/pixQrCode`);
  } catch (err) {
    console.warn(`[Asaas] Erro ao obter Pix QR Code para payment ${paymentId}:`, err.message);
    return null;
  }
}

/**
 * Cancel an Asaas Subscription (sem fidelidade)
 */
async function cancelSubscription(subscriptionId) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  return await asaasRequest(`/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
  });
}

/**
 * Validate incoming Asaas Webhook secret token
 */
function validateWebhookToken(req) {
  const secret = (config.asaasWebhookSecret || '').trim();
  if (!secret) return false;
  const token = req.headers['asaas-access-token'] || req.headers['access_token'] || req.headers['authorization'];
  if (!token) return false;
  const cleanToken = String(token).replace(/^Bearer\s+/i, '').trim();
  if (cleanToken.length !== secret.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(secret));
  } catch (e) {
    return false;
  }
}

/**
 * Process incoming Asaas Webhook event with Idempotency & Membership Entitlements
 */
async function handleWebhookEvent(eventData) {
  const event = eventData.event;
  const payment = eventData.payment;
  const subscription = eventData.subscription;

  console.log(`[Asaas Webhook] Evento recebido: ${event} para cobrança ID: ${payment?.id || 'N/A'}, sub: ${payment?.subscription || subscription?.id || 'N/A'}`);

  const eventId = eventData.id || `${event}_${payment?.id || subscription?.id || 'unknown'}_${payment?.status || ''}`;

  // 1. Idempotency Check
  try {
    const existingEvt = db.prepare('SELECT id FROM asaas_webhook_events WHERE event_id = ?').get(eventId);
    if (existingEvt) {
      console.log(`[Asaas Webhook] Evento ${eventId} duplicado. Retornando 200 OK sem reprocessar.`);
      return { received: true, duplicate: true, eventId };
    }
    db.prepare(`
      INSERT INTO asaas_webhook_events (event_id, event_type, payment_id, subscription_id, customer_id, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      event,
      payment?.id || null,
      payment?.subscription || subscription?.id || null,
      payment?.customer || eventData.customer || null,
      JSON.stringify(eventData)
    );
  } catch (evtErr) {
    if (evtErr.message && evtErr.message.includes('UNIQUE')) {
      console.log(`[Asaas Webhook] Evento ${eventId} já registrado em concorrência.`);
      return { received: true, duplicate: true, eventId };
    }
    console.warn('[Asaas Webhook] Erro ao registrar idempotência:', evtErr.message);
  }

  // 2. Update asaas_payments table
  const isPaid = event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED';
  const paidAt = isPaid ? new Date().toISOString() : null;

  if (payment && payment.id) {
    try {
      const existing = db.prepare('SELECT id, customer_phone, customer_name FROM asaas_payments WHERE asaas_id = ?').get(payment.id);
      if (existing) {
        db.prepare(`
          UPDATE asaas_payments
          SET status = ?, net_value = ?, paid_at = COALESCE(?, paid_at),
              subscription_id = COALESCE(?, subscription_id)
          WHERE asaas_id = ?
        `).run(payment.status || event || 'UNKNOWN', payment.netValue || payment.value || 0, paidAt, payment.subscription || null, payment.id);
      } else {
        db.prepare(`
          INSERT INTO asaas_payments (
            asaas_id, customer_id, subscription_id, value, net_value, billing_type, status,
            description, invoice_url, paid_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          payment.id,
          payment.customer || null,
          payment.subscription || null,
          payment.value || 0,
          payment.netValue || payment.value || 0,
          payment.billingType || null,
          payment.status || event || null,
          payment.description || null,
          payment.invoiceUrl || null,
          paidAt
        );
      }
    } catch (dbErr) {
      console.error('[Asaas Webhook] Erro ao atualizar asaas_payments:', dbErr.message);
    }
  }

  // 3. Find User in SQLite
  let user = null;
  const subId = payment?.subscription || subscription?.id;
  if (subId) {
    user = db.prepare('SELECT * FROM users WHERE asaas_subscription_id = ?').get(subId);
  }
  if (!user && payment?.id) {
    user = db.prepare('SELECT * FROM users WHERE asaas_payment_id = ?').get(payment.id);
  }
  if (!user && payment?.customer) {
    user = db.prepare('SELECT * FROM users WHERE asaas_customer_id = ?').get(payment.customer);
  }
  if (!user && subId) {
    const contract = db.prepare('SELECT user_id FROM direct_sales_contracts WHERE asaas_subscription_id = ?').get(subId);
    if (contract) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(contract.user_id);
    }
  }
  if (!user && subId) {
    const custSub = db.prepare('SELECT user_id FROM customer_subscriptions WHERE gateway_subscription_id = ?').get(subId);
    if (custSub) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(custSub.user_id);
    }
  }
  if (!user && payment?.id) {
    const custSub = db.prepare('SELECT user_id FROM customer_subscriptions WHERE gateway_payment_id = ?').get(payment.id);
    if (custSub) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(custSub.user_id);
    }
  }

  // Check Hotmart isolation: Do NOT let Asaas events alter Hotmart customers
  if (user && user.subscription_origin === 'HOTMART') {
    console.warn(`[Asaas Webhook] Usuário ID ${user.id} é originário da Hotmart. Ignorando alteração de plano via Asaas.`);
    return { received: true, ignored: true, reason: 'HOTMART_ISOLATION' };
  }

  // If no user found, record unlinked event audit log and do NOT alter any contracts
  if (!user) {
    logSecurityEvent({
      eventType: AUDIT_EVENTS.WEBHOOK_PROCESSED,
      status: 'UNLINKED_EVENT',
      details: {
        event,
        paymentId: payment?.id || null,
        subId: subId || null,
        reason: 'Nenhum usuário ou contrato correspondente encontrado no sistema. Nenhuma alteração financeira executada.'
      }
    });
    return {
      received: true,
      unlinked: true,
      event,
      paymentId: payment?.id,
      subscriptionId: subId,
    };
  }

  let activationUrl = null;

  // 4. Handle State Transitions
  if (user) {
    if (isPaid) {
      // Calculate paidUntil (30 days from due date or today)
      let paidUntilDate;
      if (payment?.dueDate) {
        const d = new Date(payment.dueDate);
        if (!Number.isNaN(d.getTime())) {
          d.setDate(d.getDate() + 30);
          if (d.getTime() < Date.now()) {
            d.setTime(Date.now() + 30 * 86400000);
          }
          paidUntilDate = d.toISOString();
        }
      }
      if (!paidUntilDate) {
        paidUntilDate = new Date(Date.now() + 30 * 86400000).toISOString();
      }

      if (!user.password_hash) {
        // Needs initial activation
        let actToken = user.activation_token;
        let actExp = user.activation_expires_at;
        if (!actToken || !actExp || new Date(actExp) <= new Date()) {
          actToken = crypto.randomBytes(32).toString('hex');
          actExp = new Date(Date.now() + 48 * 3600000).toISOString();
        }
        db.prepare(`
          UPDATE users
          SET subscription_status = 'PENDING',
              paid_until = ?,
              activation_token = ?,
              activation_expires_at = ?,
              subscription_origin = 'ASAAS',
              asaas_payment_id = COALESCE(?, asaas_payment_id),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(paidUntilDate, actToken, actExp, payment?.id || null, user.id);

        const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
        activationUrl = `${baseUrl}/cliente/ativar?token=${encodeURIComponent(actToken)}`;
      } else {
        // Already activated account (recurring renewal or reactivated)
        db.prepare(`
          UPDATE users
          SET subscription_status = 'ACTIVE',
              paid_until = ?,
              subscription_origin = 'ASAAS',
              asaas_payment_id = COALESCE(?, asaas_payment_id),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(paidUntilDate, payment?.id || null, user.id);
      }

      // -------------------------------------------------------------
      // EXACT MULTIPRODUCT & CONTRACT TARGETING (PROTEÇÃO 19)
      // Never use broad user_id = ? that would overwrite other independent contracts
      // -------------------------------------------------------------
      let targetSub = null;
      if (subId) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_subscription_id = ?').get(subId);
      }
      if (!targetSub && payment?.id) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_payment_id = ?').get(payment.id);
      }
      if (!targetSub && user?.id) {
        const userSubs = db.prepare("SELECT * FROM customer_subscriptions WHERE user_id = ? AND origin = 'ASAAS'").all(user.id);
        if (userSubs.length === 1) targetSub = userSubs[0];
      }

      let targetContract = null;
      if (subId) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_subscription_id = ?').get(subId);
      }
      if (!targetContract && payment?.id) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_payment_id = ?').get(payment.id);
      }
      if (!targetContract && targetSub?.contract_id) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE id = ?').get(targetSub.contract_id);
      }
      if (!targetContract && user?.id) {
        const userContracts = db.prepare('SELECT * FROM direct_sales_contracts WHERE user_id = ?').all(user.id);
        if (userContracts.length === 1) targetContract = userContracts[0];
      }

      // Update specific target contract
      if (targetContract) {
        db.prepare(`
          UPDATE direct_sales_contracts
          SET payment_status = 'PAID',
              asaas_payment_id = COALESCE(?, asaas_payment_id),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(payment?.id || null, targetContract.id);

        try {
          db.prepare(`
            INSERT OR REPLACE INTO direct_sales_payments (contract_id, reference, paid_until, confirmed_by)
            VALUES (?, ?, ?, 0)
          `).run(targetContract.id, payment?.id || `PAY_${Date.now()}`, paidUntilDate);

          db.prepare(`
            INSERT INTO direct_sales_events (contract_id, admin_id, event_type, notes)
            VALUES (?, 0, 'PAYMENT_CONFIRMED_ASAAS', ?)
          `).run(targetContract.id, `Pagamento Asaas confirmado: R$ ${payment?.value || 0}`);
        } catch (e) {
          console.warn('[Asaas Webhook] Erro ao gravar evento direto:', e.message);
        }
      }

      // Sync specific customer_subscription for multiproduct
      try {
        const subStatus = user.password_hash ? 'ACTIVE' : 'PENDING';
        if (targetSub) {
          db.prepare(`
            UPDATE customer_subscriptions
            SET status = ?, paid_until = ?, access_expires_at = ?,
                gateway_payment_id = COALESCE(?, gateway_payment_id),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(subStatus, paidUntilDate, paidUntilDate, payment?.id || null, targetSub.id);
        } else if (subId || payment?.id) {
          db.prepare(`
            UPDATE customer_subscriptions
            SET status = ?, paid_until = ?, access_expires_at = ?,
                gateway_payment_id = COALESCE(?, gateway_payment_id),
                updated_at = CURRENT_TIMESTAMP
            WHERE (gateway_subscription_id = ? OR gateway_payment_id = ?)
          `).run(subStatus, paidUntilDate, paidUntilDate, payment?.id || null, subId || null, payment?.id || null);
        }
      } catch (e) {}

      logSecurityEvent({
        eventType: AUDIT_EVENTS.WEBHOOK_PROCESSED,
        userId: user.id,
        details: { event, paymentId: payment?.id, subId, status: 'PAID' },
      });
    } else if (event === 'PAYMENT_OVERDUE') {
      let targetSub = null;
      if (subId) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_subscription_id = ?').get(subId);
      }
      if (!targetSub && payment?.id) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_payment_id = ?').get(payment.id);
      }
      if (!targetSub && user?.id) {
        const userSubs = db.prepare("SELECT * FROM customer_subscriptions WHERE user_id = ? AND origin = 'ASAAS'").all(user.id);
        if (userSubs.length === 1) targetSub = userSubs[0];
      }

      let targetContract = null;
      if (subId) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_subscription_id = ?').get(subId);
      }
      if (!targetContract && payment?.id) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_payment_id = ?').get(payment.id);
      }
      if (!targetContract && targetSub?.contract_id) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE id = ?').get(targetSub.contract_id);
      }
      if (!targetContract && user?.id) {
        const userContracts = db.prepare('SELECT * FROM direct_sales_contracts WHERE user_id = ?').all(user.id);
        if (userContracts.length === 1) targetContract = userContracts[0];
      }

      if (targetContract) {
        db.prepare(`UPDATE direct_sales_contracts SET payment_status = 'OVERDUE', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(targetContract.id);
        db.prepare(`
          INSERT INTO direct_sales_events (contract_id, admin_id, event_type, notes)
          VALUES (?, 0, 'PAYMENT_OVERDUE_ASAAS', ?)
        `).run(targetContract.id, `Cobrança ID ${payment?.id} em atraso.`);
      }

      if (targetSub) {
        db.prepare(`UPDATE customer_subscriptions SET status = 'OVERDUE', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(targetSub.id);
      } else if (subId || payment?.id) {
        db.prepare(`
          UPDATE customer_subscriptions
          SET status = 'OVERDUE', updated_at = CURRENT_TIMESTAMP
          WHERE (gateway_subscription_id = ? OR gateway_payment_id = ?)
        `).run(subId || null, payment?.id || null);
      }

      // Check if user has other active products before downgrading global status
      const hasOtherActive = db.prepare(`
        SELECT id FROM customer_subscriptions
        WHERE user_id = ? AND status = 'ACTIVE' AND datetime(paid_until) >= datetime('now')
          AND id != COALESCE(?, -1)
        LIMIT 1
      `).get(user.id, targetSub?.id || -1);

      if (!hasOtherActive) {
        db.prepare(`UPDATE users SET subscription_status = 'OVERDUE', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(user.id);
      } else {
        console.log(`[Asaas Webhook] Usuário #${user.id} possui outros produtos ativos. Status global mantido.`);
      }

      logSecurityEvent({
        eventType: AUDIT_EVENTS.WEBHOOK_PROCESSED,
        userId: user.id,
        details: { event, paymentId: payment?.id, subId, status: 'OVERDUE' },
      });
    } else if (event === 'PAYMENT_REFUNDED' || event === 'PAYMENT_CHARGEBACK') {
      let targetSub = null;
      if (subId) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_subscription_id = ?').get(subId);
      }
      if (!targetSub && payment?.id) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_payment_id = ?').get(payment.id);
      }
      if (!targetSub && user?.id) {
        const userSubs = db.prepare("SELECT * FROM customer_subscriptions WHERE user_id = ? AND origin = 'ASAAS'").all(user.id);
        if (userSubs.length === 1) targetSub = userSubs[0];
      }

      let targetContract = null;
      if (subId) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_subscription_id = ?').get(subId);
      }
      if (!targetContract && payment?.id) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_payment_id = ?').get(payment.id);
      }
      if (!targetContract && targetSub?.contract_id) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE id = ?').get(targetSub.contract_id);
      }
      if (!targetContract && user?.id) {
        const userContracts = db.prepare('SELECT * FROM direct_sales_contracts WHERE user_id = ?').all(user.id);
        if (userContracts.length === 1) targetContract = userContracts[0];
      }

      if (targetContract) {
        db.prepare(`UPDATE direct_sales_contracts SET payment_status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(targetContract.id);
        db.prepare(`
          INSERT INTO direct_sales_events (contract_id, admin_id, event_type, notes)
          VALUES (?, 0, 'PAYMENT_REFUNDED_ASAAS', ?)
        `).run(targetContract.id, `Estorno / chargeback recebido no Asaas.`);
      }

      if (targetSub) {
        db.prepare(`UPDATE customer_subscriptions SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(targetSub.id);
      } else if (subId || payment?.id) {
        db.prepare(`
          UPDATE customer_subscriptions
          SET status = 'REFUNDED', updated_at = CURRENT_TIMESTAMP
          WHERE (gateway_subscription_id = ? OR gateway_payment_id = ?)
        `).run(subId || null, payment?.id || null);
      }

      const hasOtherActive = db.prepare(`
        SELECT id FROM customer_subscriptions
        WHERE user_id = ? AND status = 'ACTIVE' AND datetime(paid_until) >= datetime('now')
          AND id != COALESCE(?, -1)
        LIMIT 1
      `).get(user.id, targetSub?.id || -1);

      if (!hasOtherActive) {
        db.prepare(`
          UPDATE users
          SET subscription_status = 'REFUNDED',
              magic_token = NULL,
              magic_token_expires_at = NULL,
              reset_token = NULL,
              reset_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(user.id);
      } else {
        console.log(`[Asaas Webhook] Usuário #${user.id} possui outros produtos ativos. Status global mantido após estorno de produto.`);
      }

      logSecurityEvent({
        eventType: AUDIT_EVENTS.WEBHOOK_PROCESSED,
        userId: user.id,
        details: { event, paymentId: payment?.id, subId, status: 'REFUNDED' },
      });
    } else if (event === 'PAYMENT_RESTORED') {
      let targetSub = null;
      if (subId) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_subscription_id = ?').get(subId);
      }
      if (!targetSub && payment?.id) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_payment_id = ?').get(payment.id);
      }

      let targetContract = null;
      if (subId) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_subscription_id = ?').get(subId);
      }
      if (!targetContract && payment?.id) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_payment_id = ?').get(payment.id);
      }

      if (targetContract) {
        db.prepare(`UPDATE direct_sales_contracts SET payment_status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(targetContract.id);
      }
      if (targetSub) {
        db.prepare(`UPDATE customer_subscriptions SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(targetSub.id);
      }

      db.prepare(`UPDATE users SET subscription_status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(user.id);

      logSecurityEvent({
        eventType: AUDIT_EVENTS.CONTRACT_RENEWED,
        userId: user.id,
        details: { event, paymentId: payment?.id, subId, status: 'RESTORED' },
      });
    } else if (event === 'SUBSCRIPTION_DELETED' || event === 'SUBSCRIPTION_INACTIVATED') {
      // Cancellation without penalty (sem fidelidade) -> keeps access until paid_until expires
      let targetSub = null;
      if (subId) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_subscription_id = ?').get(subId);
      }
      if (!targetSub && payment?.id) {
        targetSub = db.prepare('SELECT * FROM customer_subscriptions WHERE gateway_payment_id = ?').get(payment.id);
      }
      if (!targetSub && user?.id) {
        const userSubs = db.prepare("SELECT * FROM customer_subscriptions WHERE user_id = ? AND origin = 'ASAAS'").all(user.id);
        if (userSubs.length === 1) targetSub = userSubs[0];
      }

      let targetContract = null;
      if (subId) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE asaas_subscription_id = ?').get(subId);
      }
      if (!targetContract && targetSub?.contract_id) {
        targetContract = db.prepare('SELECT * FROM direct_sales_contracts WHERE id = ?').get(targetSub.contract_id);
      }
      if (!targetContract && user?.id) {
        const userContracts = db.prepare('SELECT * FROM direct_sales_contracts WHERE user_id = ?').all(user.id);
        if (userContracts.length === 1) targetContract = userContracts[0];
      }

      if (targetContract) {
        db.prepare(`UPDATE direct_sales_contracts SET payment_status = 'CANCELED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(targetContract.id);
        db.prepare(`
          INSERT INTO direct_sales_events (contract_id, admin_id, event_type, notes)
          VALUES (?, 0, 'SUBSCRIPTION_CANCELED_ASAAS', ?)
        `).run(targetContract.id, 'Assinatura cancelada no Asaas. Acesso mantido até o término do período pago.');
      }

      if (targetSub) {
        db.prepare(`
          UPDATE customer_subscriptions
          SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'Assinatura cancelada no Asaas', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(targetSub.id);
      } else if (subId) {
        db.prepare(`
          UPDATE customer_subscriptions
          SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'Assinatura cancelada no Asaas', updated_at = CURRENT_TIMESTAMP
          WHERE gateway_subscription_id = ?
        `).run(subId);
      }

      // Check if user has other active products
      const hasOtherActive = db.prepare(`
        SELECT id FROM customer_subscriptions
        WHERE user_id = ? AND status = 'ACTIVE' AND datetime(paid_until) >= datetime('now')
          AND id != COALESCE(?, -1)
        LIMIT 1
      `).get(user.id, targetSub?.id || -1);

      if (!hasOtherActive) {
        db.prepare(`UPDATE users SET subscription_status = 'CANCELED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(user.id);
      } else {
        console.log(`[Asaas Webhook] Usuário #${user.id} possui outros produtos ativos. Status global mantido após cancelamento de assinatura.`);
      }

      logSecurityEvent({
        eventType: AUDIT_EVENTS.CONTRACT_CANCELLED,
        userId: user.id,
        details: { event, subId, status: 'CANCELED' },
      });
    } else {
      // Unknown or informational event type that does NOT mutate financial contracts
      logSecurityEvent({
        eventType: AUDIT_EVENTS.WEBHOOK_PROCESSED,
        userId: user.id,
        status: 'IGNORED_EVENT_TYPE',
        details: { event, paymentId: payment?.id, subId, note: 'Tipo de evento não altera contratos financeiros.' },
      });
    }
  }

  return {
    received: true,
    event,
    paymentId: payment?.id,
    subscriptionId: subId,
    status: payment?.status,
    isPaid,
    activationUrl,
    userId: user?.id,
  };
}

/**
 * List payments from Asaas API
 */
async function listPayments({ limit = 30, status = null } = {}) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  const query = new URLSearchParams({ limit: String(limit) });
  if (status) query.append('status', status);
  return await asaasRequest(`/payments?${query.toString()}`);
}

/**
 * List customers from Asaas API
 */
async function listCustomers({ limit = 50 } = {}) {
  if (!isConfigured()) throw new Error('Chave de API do Asaas não configurada.');
  return await asaasRequest(`/customers?limit=${limit}`);
}

module.exports = {
  isConfigured,
  getAccount,
  getBalance,
  findOrCreateCustomer,
  createPixCharge,
  createPaymentLink,
  getPayment,
  createSubscription,
  getSubscription,
  listSubscriptionPayments,
  getPaymentPixQrCode,
  cancelSubscription,
  validateWebhookToken,
  listPayments,
  listCustomers,
  handleWebhookEvent,
};
