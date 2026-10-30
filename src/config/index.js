require('dotenv').config();
const path = require('path');

let geminiKey = (process.env.GEMINI_API_KEY || '').trim();
if (geminiKey.includes('B8tpfH0')) {
  geminiKey = geminiKey.replace('B8tpfH0', 'B8tpFh0');
}

const config = {
  geminiApiKey: geminiKey,
  authorizedPhone: process.env.AUTHORIZED_PHONE || '', // e.g., '5511999999999' or comma-separated
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  baseUrl: process.env.BASE_URL || 'https://raiaagentes.com.br',
  dbPath: path.resolve(__dirname, '../../data/assistant.db'),
  authDir: path.resolve(__dirname, '../../auth_info_baileys'),
  googleCredentialsPath: path.resolve(__dirname, '../../google_credentials.json'),
  googleTokenPath: path.resolve(__dirname, '../../google_token.json'),
  pixKey: process.env.PIX_KEY || '+5511951364159',
  pixName: process.env.PIX_NAME || 'RAIA RH',
  pixCity: process.env.PIX_CITY || 'SAO PAULO',
  pixPrice: process.env.PIX_PRICE || '29.00',
  pausePersonalAssistant: process.env.PAUSE_PERSONAL_ASSISTANT !== 'false', // Pausado por padrão para não conflitar no mesmo número
  asaasApiKey: (process.env.ASAAS_API_KEY || '').trim(),
  asaasApiUrl: process.env.ASAAS_API_URL || 'https://api.asaas.com/v3',
  asaasWebhookSecret: (process.env.ASAAS_WEBHOOK_SECRET || '').trim(),

  // Hotmart Integration
  hotmartWebhookSecret: (process.env.HOTMART_WEBHOOK_SECRET || process.env.HOTMART_HOTTOK || '').trim(),
  hotmartProductId: (process.env.HOTMART_PRODUCT_ID || '8840376').trim(),
  hotmartPlanStartId: (process.env.HOTMART_PLAN_START_ID || '').trim(),
  hotmartPlanProId: (process.env.HOTMART_PLAN_PRO_ID || '').trim(),

  // Isolated Demo Account for Hotmart Compliance
  demoAccountEmail: (process.env.DEMO_ACCOUNT_EMAIL || 'homologacao.hotmart@raiaagentes.com.br').trim().toLowerCase(),
  demoAccountPassword: (process.env.DEMO_ACCOUNT_PASSWORD || '').trim(),

  // Marketing & Analytics
  ga4MeasurementId: (process.env.GA4_MEASUREMENT_ID || '').trim(),
  gtmContainerId: (process.env.GTM_CONTAINER_ID || '').trim(),
  metaPixelId: (process.env.META_PIXEL_ID || '').trim(),
  metaCapiToken: (process.env.META_CAPI_TOKEN || '').trim(),
  metaCapiTestCode: (process.env.META_CAPI_TEST_CODE || '').trim(),
};

module.exports = config;
