'use strict';

/** RAIA membership catalogue. Prices use integer cents and do NOT charge anyone. */
const PLANS = Object.freeze({
  JESSICA_START: Object.freeze({
    id: 'JESSICA_START', name: 'Plano de Entrada',
    fairMonthlyCents: 5900, standardMonthlyCents: 8900, standardSetupCents: 35000,
    includedProfessionals: 1,
    features: Object.freeze(['ai_responses', 'automatic_bookings', 'always_on']),
  }),
  JESSICA_INTERMEDIATE: Object.freeze({
    id: 'JESSICA_INTERMEDIATE', name: 'Plano Intermediário',
    fairMonthlyCents: 7900, standardMonthlyCents: 10900, standardSetupCents: 35000,
    includedProfessionals: 1,
    features: Object.freeze(['ai_responses', 'automatic_bookings', 'always_on', 'financial_dashboard']),
  }),
  JESSICA_PRO: Object.freeze({
    id: 'JESSICA_PRO', name: 'Plano Pró',
    fairMonthlyCents: 9900, standardMonthlyCents: 13900, standardSetupCents: 35000,
    includedProfessionals: 2,
    features: Object.freeze(['ai_responses', 'automatic_bookings', 'always_on', 'financial_dashboard',
      'professional_whatsapp_alerts', 'accounts_payable', 'marketing_campaigns']),
  }),
});
const EXTRA_PROFESSIONAL_MONTHLY_CENTS = 1990;
const BILLING_METHODS = Object.freeze(['PIX', 'BOLETO', 'CARD_RECURRING', 'CREDIT_CARD', 'UNDEFINED']);
const PROMOTIONS = Object.freeze(['FAIR_2026', 'STANDARD']);

function getPlan(id) { return PLANS[id] || null; }
function includesFeature(planTier, feature) {
  const plan = getPlan(planTier);
  return Boolean(plan && plan.features.includes(feature));
}
function quote(planId, promotion = 'STANDARD', extraProfessionals = 0) {
  const plan = getPlan(planId);
  if (!plan) throw new Error('Plano inválido.');
  if (!PROMOTIONS.includes(promotion)) throw new Error('Promoção inválida.');
  if (!Number.isSafeInteger(extraProfessionals) || extraProfessionals < 0 || extraProfessionals > 20) {
    throw new Error('Quantidade inválida de profissionais adicionais.');
  }
  return {
    planTier: plan.id,
    promotion,
    monthlyCents: (promotion === 'FAIR_2026' ? plan.fairMonthlyCents : plan.standardMonthlyCents)
      + extraProfessionals * EXTRA_PROFESSIONAL_MONTHLY_CENTS,
    setupCents: promotion === 'FAIR_2026' ? 0 : plan.standardSetupCents,
    includedProfessionals: plan.includedProfessionals,
    extraProfessionals,
    noLoyaltyContract: true,
  };
}
module.exports = { PLANS, getPlan, includesFeature, quote, BILLING_METHODS,
  PROMOTIONS, EXTRA_PROFESSIONAL_MONTHLY_CENTS };
