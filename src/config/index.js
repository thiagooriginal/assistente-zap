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
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.resolve(__dirname, '../../data/assistant.db'),
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

  // Security & Administrative Credentials
  adminPassword: (process.env.ADMIN_PASSWORD || process.env.ADMIN_MASTER_PASSWORD || '').trim(),
  adminPin: (process.env.ADMIN_PIN || '').trim(),
  adminApiKey: (process.env.ADMIN_API_KEY || '').trim(),
  adminMfaEnabled: process.env.ADMIN_MFA_ENABLED === 'true',
  adminTotpSecret: (process.env.ADMIN_TOTP_SECRET || '').trim(),
  mfaEncryptionKey: (process.env.MFA_ENCRYPTION_KEY || '').trim(),

  // Session & Authentication Secrets (Proteção 01, 11 & 17)
  sessionSecret: (process.env.SESSION_SECRET || '').trim(),
  clientAuthSecret: (process.env.CLIENT_AUTH_SECRET || '').trim(),

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

/**
 * Startup Environment & Configuration Validation (Proteção 11)
 */
config.validateEnvironment = function validateEnvironment({ throwOnError = false } = {}) {
  const errors = [];
  const warnings = [];

  const WEAK_OR_DEFAULT_SECRETS = [
    'admin123', 'admin', 'password', '12345678', 'mestre123', 'raiaadmin',
    'segredo_padrao_trocar_em_producao', 'default_secret', 'raia_secret',
    'change_me', 'secret', 'raia-mfa-default-key-fallback'
  ];

  // 0. Environment Conflict & Canonical Domain Checks (Separação Rigorosa de Ambientes)
  const isNodeProd = process.env.NODE_ENV === 'production';
  const hasStagingFlag = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging';
  const isExplicitProdMode = process.env.APP_MODE === 'production';

  const rawBaseUrl = (process.env.BASE_URL || '').trim();
  let isExplicitCanonicalProdDomain = false;
  if (rawBaseUrl) {
    try {
      const u = new URL(rawBaseUrl);
      isExplicitCanonicalProdDomain = (u.hostname === 'raiaagentes.com.br' || u.hostname === 'www.raiaagentes.com.br');
    } catch (_) {}
  }
  const isCanonicalProdDomain = isExplicitCanonicalProdDomain || (isNodeProd && !rawBaseUrl);

  // Disallow mutually contradictory environment declarations
  if (isExplicitProdMode && process.env.HOMOLOGACAO === 'true') {
    errors.push('CONFLITO DE AMBIENTE: APP_MODE=production é incompatível com HOMOLOGACAO=true.');
  }

  // Strictly disallow running staging mode against the canonical production domain (regardless of isProdEnv)
  if (isCanonicalProdDomain && hasStagingFlag) {
    errors.push('CONFLITO CRÍTICO DE AMBIENTE: Tentativa de ativar modo homologação/staging apontando para o domínio canônico de produção (raiaagentes.com.br).');
  }

  const hasCriticalConflict = errors.some(e => e.includes('CONFLITO'));
  const isProduction = isNodeProd && !hasStagingFlag;
  const isStaging = hasStagingFlag && !isProduction;

  // Universal checks: weak/default secrets are prohibited in any production or staging environment
  if (config.adminPassword && WEAK_OR_DEFAULT_SECRETS.includes(String(config.adminPassword).toLowerCase())) {
    errors.push('ADMIN_PASSWORD configurada com valor fraco ou padrão proibido.');
  }
  if (config.sessionSecret && WEAK_OR_DEFAULT_SECRETS.includes(String(config.sessionSecret).toLowerCase())) {
    errors.push('SESSION_SECRET configurado com valor padrão proibido.');
  }
  if (config.clientAuthSecret && WEAK_OR_DEFAULT_SECRETS.includes(String(config.clientAuthSecret).toLowerCase())) {
    errors.push('CLIENT_AUTH_SECRET configurado com valor padrão proibido.');
  }

  // 1. Production Critical Checks
  if (isProduction) {
    // Admin Password
    if (!config.adminPassword || config.adminPassword.length < 8) {
      errors.push('ADMIN_PASSWORD não configurada ou muito curta em ambiente de produção (mínimo 8 caracteres).');
    }

    // Session Secret
    if (!config.sessionSecret || config.sessionSecret.length < 16) {
      errors.push('SESSION_SECRET não configurado ou muito curto em produção (mínimo 16 caracteres).');
    }

    // Client Auth Secret
    if (!config.clientAuthSecret || config.clientAuthSecret.length < 16) {
      errors.push('CLIENT_AUTH_SECRET não configurado ou muito curto em produção (mínimo 16 caracteres).');
    }

    // MFA Encryption Key: In production, requires its OWN independent key (cannot reuse session secret)
    if (config.adminMfaEnabled || process.env.ADMIN_MFA_ENABLED === 'true') {
      if (!config.mfaEncryptionKey || config.mfaEncryptionKey.length < 16) {
        errors.push('MFA_ENCRYPTION_KEY obrigatória e independente não configurada ou insuficiente em produção (mínimo 16 caracteres).');
      } else if (WEAK_OR_DEFAULT_SECRETS.includes(String(config.mfaEncryptionKey).toLowerCase())) {
        errors.push('MFA_ENCRYPTION_KEY configurada com valor padrão ou trivial em produção.');
      } else if (config.mfaEncryptionKey === config.sessionSecret || config.mfaEncryptionKey === config.clientAuthSecret) {
        errors.push('MFA_ENCRYPTION_KEY deve ser uma chave independente e não pode ser reutilizada de SESSION_SECRET ou CLIENT_AUTH_SECRET.');
      }
    }

    if (!config.adminApiKey || config.adminApiKey.length < 16) {
      warnings.push('ADMIN_API_KEY recomendada com entropia elevada (mínimo 16 caracteres).');
    }
    if (!config.hotmartWebhookSecret) {
      warnings.push('HOTMART_WEBHOOK_SECRET não definida no ambiente de produção.');
    }
    if (!config.asaasWebhookSecret) {
      warnings.push('ASAAS_WEBHOOK_SECRET não definida no ambiente de produção.');
    }
  }

  // 2. Staging Gate Checks
  if (isStaging && (process.env.STAGING_PROTECTION_ENABLED === 'true' || process.env.STAGING_AUTH_ENABLED === 'true')) {
    if (!process.env.STAGING_PASSWORD || process.env.STAGING_PASSWORD.trim().length < 6) {
      errors.push('STAGING_PASSWORD ausente ou insuficiente com STAGING_PROTECTION_ENABLED ativado.');
    }
  }

  // 3. Database Check
  if (!config.dbPath) {
    errors.push('DB_PATH inválido ou não definido.');
  }

  if (errors.length > 0) {
    console.error('\n❌ [Security Startup Error] Falha de validação das variáveis de ambiente:');
    for (const err of errors) console.error(`  - ${err}`);
    if (isProduction || throwOnError || hasCriticalConflict) {
      throw new Error(`Abortando inicialização por violação de segurança: ${errors.join('; ')}`);
    }
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️ [Security Startup Warning] Alertas de configuração:');
    for (const w of warnings) console.warn(`  - ${w}`);
  }

  return {
    valid: errors.length === 0,
    hasConflict: hasCriticalConflict,
    errors,
    warnings,
    environment: isProduction ? 'production' : (isStaging ? 'staging' : 'development')
  };
};

module.exports = config;
