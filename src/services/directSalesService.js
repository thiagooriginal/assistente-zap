'use strict';

const crypto = require('crypto');
const db = require('../database/db');
const config = require('../config');
const { quote, BILLING_METHODS } = require('./planCatalog');
const asaasService = require('./asaasService');

function businessError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}
function normalizePhone(phone) {
  let v = String(phone || '').replace(/\D/g, '');
  if (v.length === 10 || v.length === 11) v = '55' + v;
  if (!/^55\d{10,11}$/.test(v)) throw businessError('WhatsApp brasileiro inválido. Informe DDD e número.');
  return v;
}
function normalizeEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw businessError('Informe um e-mail válido.');
  }
  return v;
}
function runTransaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const output = action();
    db.exec('COMMIT');
    return output;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
function getContract(id) {
  return db.prepare(`SELECT c.*, u.email, u.name, u.phone_number, u.subscription_status,
    u.paid_until, u.plan_tier FROM direct_sales_contracts c
    JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(id);
}
function publicContract(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, name: row.name, email: row.email,
    phone: row.phone_number, planTier: row.plan_tier, monthlyCents: row.monthly_cents,
    setupCents: row.setup_cents, extraProfessionals: row.extra_professionals,
    promotion: row.promotion, paymentMethod: row.payment_method,
    paymentStatus: row.payment_status, subscriptionStatus: row.subscription_status,
    paidUntil: row.paid_until, createdAt: row.created_at,
    asaasCustomerId: row.asaas_customer_id || null,
    asaasSubscriptionId: row.asaas_subscription_id || null,
    asaasPaymentId: row.asaas_payment_id || null,
    invoiceUrl: row.asaas_invoice_url || null,
    pixPayload: row.pix_payload || null,
  };
}
/** Create an Asaas recurring subscription for a direct client (starts PENDING) */
async function createDirectContract(input, adminId) {
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 150) throw businessError('Nome inválido.');
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  // Check existing users to protect Hotmart users & avoid duplicates
  const existingUser = db.prepare('SELECT id, email, subscription_origin, hotmart_subscriber_code FROM users WHERE LOWER(email) = ? OR phone_number = ?').get(email, phone);
  if (existingUser) {
    if (existingUser.subscription_origin === 'HOTMART' || existingUser.hotmart_subscriber_code) {
      throw businessError(`Este cliente (${existingUser.email}) já possui assinatura ativa via Hotmart. Para evitar cobrança dupla, gerencie pela Hotmart.`, 409);
    }
    throw businessError('Já existe uma conta com este e-mail ou WhatsApp. Revise o cadastro antes de continuar.', 409);
  }

  const paymentMethod = String(input.paymentMethod || 'BOLETO').toUpperCase();
  if (!BILLING_METHODS.includes(paymentMethod)) throw businessError('Método de pagamento inválido.');
  const cpfCnpj = input.cpfCnpj ? String(input.cpfCnpj).replace(/\D/g, '') : null;
  if (paymentMethod === 'BOLETO' && (!cpfCnpj || (cpfCnpj.length !== 11 && cpfCnpj.length !== 14))) {
    throw businessError('Para emissão de Boleto com Pix pelo Asaas, informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.');
  }
  const quoted = quote(input.planTier, input.promotion || 'STANDARD', Number(input.extraProfessionals || 0));

  let asaasCustomer = null;
  let asaasSub = null;
  let firstPayment = null;
  let pixData = null;

  if (asaasService.isConfigured()) {
    try {
      asaasCustomer = await asaasService.findOrCreateCustomer({
        name,
        phone,
        email,
        cpfCnpj,
      });

      const asaasBillingType = paymentMethod === 'CARD_RECURRING' ? 'CREDIT_CARD' : paymentMethod;
      const monthlyValue = quoted.monthlyCents / 100;

      asaasSub = await asaasService.createSubscription({
        customerId: asaasCustomer.id,
        billingType: asaasBillingType,
        value: monthlyValue,
        description: `Assinatura ${quoted.planTier} RAIA - Jéssica`,
        externalReference: `RAIA_SUB_${Date.now()}`,
      });

      if (asaasSub?.id) {
        const paymentsRes = await asaasService.listSubscriptionPayments(asaasSub.id, { limit: 1 });
        firstPayment = paymentsRes?.data?.[0] || null;

        if (firstPayment && (asaasBillingType === 'BOLETO' || asaasBillingType === 'PIX' || asaasBillingType === 'UNDEFINED')) {
          pixData = await asaasService.getPaymentPixQrCode(firstPayment.id);
        }
      }
    } catch (asaasErr) {
      console.error('[directSalesService] Erro ao integrar com Asaas:', asaasErr);
      throw businessError(`Erro ao comunicar com Asaas: ${asaasErr.message}`, 502);
    }
  }

  return runTransaction(() => {
    const created = db.prepare(`INSERT INTO users
      (name, email, phone_number, role, plan_tier, subscription_status, subscription_origin,
       extra_professionals, is_demo, asaas_customer_id, asaas_subscription_id, asaas_payment_id)
      VALUES (?, ?, ?, 'USER', ?, 'INACTIVE', 'ASAAS', ?, 0, ?, ?, ?)`)
      .run(
        name, email, phone, quoted.planTier, quoted.extraProfessionals,
        asaasCustomer?.id || null, asaasSub?.id || null, firstPayment?.id || null
      );
    const userId = Number(created.lastInsertRowid);
    const contract = db.prepare(`INSERT INTO direct_sales_contracts
      (user_id, plan_tier, promotion, monthly_cents, setup_cents, extra_professionals,
       payment_method, payment_status, created_by, asaas_customer_id, asaas_subscription_id,
       asaas_payment_id, asaas_invoice_url, pix_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'AWAITING_PAYMENT', ?, ?, ?, ?, ?, ?)`)
      .run(
        userId, quoted.planTier, quoted.promotion, quoted.monthlyCents,
        quoted.setupCents, quoted.extraProfessionals, paymentMethod, adminId,
        asaasCustomer?.id || null, asaasSub?.id || null, firstPayment?.id || null,
        firstPayment?.invoiceUrl || null, pixData?.payload || null
      );
    const contractId = Number(contract.lastInsertRowid);
    db.prepare(`INSERT INTO direct_sales_events (contract_id, admin_id, event_type, notes)
       VALUES (?, ?, 'CREATED_PENDING_PAYMENT', ?)`)
      .run(contractId, adminId, asaasSub ? `Assinatura Asaas criada: ${asaasSub.id}. Aguardando primeiro pagamento.` : 'Contrato direto registrado.');

    const res = publicContract(getContract(contractId));
    if (firstPayment?.invoiceUrl) {
      res.invoiceUrl = firstPayment.invoiceUrl;
      res.bankSlipUrl = firstPayment.bankSlipUrl;
    }
    if (pixData) {
      res.pixQrCode = pixData;
    }
    return res;
  });
}
function validatePaymentReference(value) {
  const v = String(value || '').trim();
  if (v.length < 6 || v.length > 150 || !/^[a-zA-Z0-9\-_.:/]+$/.test(v)) {
    throw businessError('Informe uma referência válida e única da transação verificada.');
  }
  return v;
}
function validatePaidUntil(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw businessError('Informe paidUntil em ISO 8601 com fuso (ex.: 2026-12-01T03:00:00.000Z).');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date <= new Date() || date.getTime() > Date.now() + 400 * 86400000) {
    throw businessError('Vigência inválida.');
  }
  return date.toISOString();
}
/** Manual verification of external funds. A declaration is NOT a gateway integration. */
function confirmPayment({ contractId, paymentReference, paidUntil, adminId }) {
  const reference = validatePaymentReference(paymentReference);
  const date = validatePaidUntil(paidUntil);
  return runTransaction(() => {
    const row = getContract(contractId);
    if (!row) throw businessError('Contrato não encontrado.', 404);
    if (row.payment_status !== 'AWAITING_PAYMENT') {
      throw businessError('Este contrato não está aguardando primeiro pagamento.', 409);
    }
    const existingReference = db.prepare('SELECT id FROM direct_sales_payments WHERE reference = ?').get(reference);
    if (existingReference) throw businessError('Referência de pagamento já utilizada.', 409);

    db.prepare(`INSERT INTO direct_sales_payments
       (contract_id, reference, paid_until, confirmed_by) VALUES (?, ?, ?, ?)`)
      .run(row.id, reference, date, adminId);
    db.prepare(`UPDATE direct_sales_contracts SET payment_status = 'PAID',
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`UPDATE users SET subscription_status = 'PENDING', paid_until = ?,
        activation_token = ?, activation_expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`)
      .run(date, token, new Date(Date.now() + 48 * 3600000).toISOString(), row.user_id);
    db.prepare(`INSERT INTO direct_sales_events (contract_id, admin_id, event_type, notes)
      VALUES (?, ?, 'PAYMENT_CONFIRMED', ?)`)
      .run(row.id, adminId, `Referência verificada: ${reference}`);
    const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    return {
      contract: publicContract(getContract(row.id)),
      // Returned ONLY to an authorized admin; deliver via customer's verified channel.
      activationUrl: `${baseUrl}/cliente/ativar?token=${encodeURIComponent(token)}`,
      activationExpiresInHours: 48,
    };
  });
}
function renewContract({ contractId, paymentReference, paidUntil, adminId }) {
  const reference = validatePaymentReference(paymentReference);
  const date = validatePaidUntil(paidUntil);
  return runTransaction(() => {
    const row = getContract(contractId);
    if (!row) throw businessError('Contrato não encontrado.', 404);
    if (row.payment_status !== 'PAID') throw businessError('Contrato não ativado.', 409);
    if (row.subscription_status === 'CANCELED' || row.subscription_status === 'REFUNDED') {
      throw businessError('Contrato cancelado ou reembolsado. Verifique antes de renovar.', 409);
    }
    if (row.paid_until && new Date(date) <= new Date(row.paid_until)) {
      throw businessError('A nova vigência precisa ser posterior à atual.', 409);
    }
    if (db.prepare('SELECT id FROM direct_sales_payments WHERE reference = ?').get(reference)) {
      throw businessError('Referência de pagamento já utilizada.', 409);
    }
    db.prepare(`INSERT INTO direct_sales_payments (contract_id, reference, paid_until, confirmed_by)
       VALUES (?, ?, ?, ?)`).run(row.id, reference, date, adminId);
    // If account has not yet been activated, keep it pending while extending its paid-through date.
    const status = row.subscription_status === 'PENDING' ? 'PENDING' : 'ACTIVE';
    db.prepare(`UPDATE users SET paid_until = ?, subscription_status = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(date, status, row.user_id);
    db.prepare(`INSERT INTO direct_sales_events (contract_id, admin_id, event_type, notes)
      VALUES (?, ?, 'RENEWAL_CONFIRMED', ?)`)
      .run(row.id, adminId, `Referência verificada: ${reference}`);
    return publicContract(getContract(row.id));
  });
}
async function cancelContract({ contractId, adminId }) {
  const row = getContract(contractId);
  if (!row) throw businessError('Contrato não encontrado.', 404);
  if (row.subscription_status === 'REFUNDED' || row.subscription_status === 'CHARGEBACK') {
    throw businessError('Conta com status terminal.', 409);
  }

  // Cancel subscription in Asaas if configured
  if (row.asaas_subscription_id && asaasService.isConfigured()) {
    try {
      await asaasService.cancelSubscription(row.asaas_subscription_id);
      console.log(`[directSalesService] Assinatura Asaas ${row.asaas_subscription_id} cancelada com sucesso.`);
    } catch (err) {
      console.warn(`[directSalesService] Falha ao cancelar assinatura no Asaas: ${err.message}`);
    }
  }

  return runTransaction(() => {
    db.prepare("UPDATE users SET subscription_status = 'CANCELED', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(row.user_id);
    db.prepare("UPDATE direct_sales_contracts SET payment_status = 'CANCELED', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(row.id);
    db.prepare(`INSERT INTO direct_sales_events (contract_id, admin_id, event_type, notes)
       VALUES (?, ?, 'CANCELED_NO_LOYALTY', ?)`)
      .run(row.id, adminId, 'Sem fidelidade. Acesso mantido somente até o término do período pago.');
    return publicContract(getContract(row.id));
  });
}
function listContracts() {
  return db.prepare(`SELECT c.*, u.email, u.name, u.phone_number, u.subscription_status,
    u.paid_until, u.plan_tier FROM direct_sales_contracts c JOIN users u ON u.id = c.user_id
    ORDER BY c.id DESC LIMIT 100`).all().map(publicContract);
}
module.exports = { createDirectContract, confirmPayment, renewContract, cancelContract,
  listContracts, getContract, normalizeEmail, normalizePhone };
