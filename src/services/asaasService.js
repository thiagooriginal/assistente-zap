const config = require('../config');
const db = require('../database/db');

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
 * Process incoming Asaas Webhook event
 */
async function handleWebhookEvent(eventData) {
  const event = eventData.event;
  const payment = eventData.payment;

  console.log(`[Asaas Webhook] Evento recebido: ${event} para cobrança ID: ${payment?.id}`);

  if (!payment || !payment.id) {
    return { received: true, ignored: true };
  }

  // Update local DB
  const isPaid = event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED';
  const paidAt = isPaid ? new Date().toISOString() : null;

  try {
    const existing = db.prepare('SELECT id, customer_phone, customer_name FROM asaas_payments WHERE asaas_id = ?').get(payment.id);
    if (existing) {
      db.prepare(`
        UPDATE asaas_payments
        SET status = ?, net_value = ?, paid_at = COALESCE(?, paid_at)
        WHERE asaas_id = ?
      `).run(payment.status || event, payment.netValue || payment.value, paidAt, payment.id);
    } else {
      db.prepare(`
        INSERT INTO asaas_payments (
          asaas_id, customer_id, value, net_value, billing_type, status,
          description, invoice_url, paid_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        payment.id,
        payment.customer,
        payment.value,
        payment.netValue || payment.value,
        payment.billingType,
        payment.status || event,
        payment.description || null,
        payment.invoiceUrl || null,
        paidAt
      );
    }
  } catch (dbErr) {
    console.error('[Asaas Webhook] Erro ao atualizar DB:', dbErr.message);
  }

  return {
    received: true,
    event,
    paymentId: payment.id,
    status: payment.status,
    isPaid,
  };
}

module.exports = {
  isConfigured,
  getAccount,
  getBalance,
  findOrCreateCustomer,
  createPixCharge,
  createPaymentLink,
  getPayment,
  handleWebhookEvent,
};
