const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// Ensure data directory exists
const dataDir = path.dirname(config.dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(config.dbPath);

// 1. Initialize core tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'USER',
    plan TEXT NOT NULL DEFAULT 'FREE_TRIAL',
    trial_ends_at TEXT,
    magic_token TEXT UNIQUE,
    magic_token_expires_at TEXT,
    google_token TEXT,
    google_calendar_id TEXT DEFAULT 'primary',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
  CREATE INDEX IF NOT EXISTS idx_users_magic ON users(magic_token);

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    payment_method TEXT,
    date TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'text',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
  CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);

  CREATE TABLE IF NOT EXISTS incomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    amount REAL NOT NULL,
    source TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Outros',
    payment_method TEXT DEFAULT 'Pix',
    date TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'text',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_incomes_date ON incomes(date);
  CREATE INDEX IF NOT EXISTS idx_incomes_category ON incomes(category);

  CREATE TABLE IF NOT EXISTS reminder_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    event_id TEXT NOT NULL,
    reminder_type TEXT NOT NULL,
    event_title TEXT NOT NULL,
    event_start TEXT NOT NULL,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, reminder_type)
  );

  CREATE TABLE IF NOT EXISTS bot_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS scheduled_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    due_date TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Contas',
    status TEXT NOT NULL DEFAULT 'PENDING',
    installment_current INTEGER DEFAULT 1,
    installment_total INTEGER DEFAULT 1,
    source_type TEXT NOT NULL DEFAULT 'text',
    notified_1d INTEGER DEFAULT 0,
    notified_due INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_payments_due ON scheduled_payments(due_date);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON scheduled_payments(status);

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    description TEXT,
    start_datetime TEXT NOT NULL,
    end_datetime TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'SCHEDULED',
    notified_24h INTEGER DEFAULT 0,
    notified_3h INTEGER DEFAULT 0,
    notified_1h INTEGER DEFAULT 0,
    source_type TEXT NOT NULL DEFAULT 'whatsapp',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_user_date ON appointments(user_id, start_datetime);
  CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status, start_datetime);

  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'PENDING',
    used_by_user_id INTEGER,
    used_by_phone TEXT,
    trial_days INTEGER DEFAULT 7,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_invite_code ON invite_codes(code);

  -- SECURITY & AUDIT TRAIL LOGGING (PROTEÇÃO 08 & 26)
  CREATE TABLE IF NOT EXISTS security_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    user_id INTEGER,
    ip_address TEXT,
    user_agent TEXT,
    resource TEXT,
    status TEXT NOT NULL,
    details_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sec_audit_event ON security_audit_logs(event_type);
  CREATE INDEX IF NOT EXISTS idx_sec_audit_user ON security_audit_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_sec_audit_created ON security_audit_logs(created_at);

  CREATE TABLE IF NOT EXISTS processed_messages (
    id TEXT PRIMARY KEY,
    sender_jid TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_broadcast_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date_str TEXT NOT NULL,
    message_type TEXT NOT NULL,
    message_text TEXT,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date_str)
  );

  CREATE INDEX IF NOT EXISTS idx_daily_broadcast ON daily_broadcast_logs(user_id, date_str);

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT NOT NULL,
    agent_key TEXT,
    agent_name TEXT,
    status TEXT DEFAULT 'SENT',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

  CREATE TABLE IF NOT EXISTS asaas_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asaas_id TEXT UNIQUE,
    customer_id TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    value REAL,
    net_value REAL,
    billing_type TEXT,
    status TEXT,
    description TEXT,
    invoice_url TEXT,
    pix_payload TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_asaas_payments_id ON asaas_payments(asaas_id);
  CREATE INDEX IF NOT EXISTS idx_asaas_payments_phone ON asaas_payments(customer_phone);

  CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    phone TEXT NOT NULL,
    agent_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_agent_messages_phone ON agent_messages(phone);
  CREATE INDEX IF NOT EXISTS idx_agent_messages_lead ON agent_messages(lead_id);

  CREATE TABLE IF NOT EXISTS business_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT,
    url TEXT,
    niche TEXT,
    analysis_data TEXT,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_business_analyses_niche ON business_analyses(niche);

  -- CLIENT PORTAL: Salon Establishment Configuration
  CREATE TABLE IF NOT EXISTS client_salons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    salon_name TEXT NOT NULL DEFAULT 'Meu Salão',
    phone TEXT,
    address TEXT,
    opening_hours TEXT,
    agent_custom_instructions TEXT,
    whatsapp_status TEXT DEFAULT 'DISCONNECTED',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_client_salons_user ON client_salons(user_id);

  -- CLIENT PORTAL: Salon Services Catalog & Prices
  CREATE TABLE IF NOT EXISTS client_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    duration_min INTEGER DEFAULT 45,
    category TEXT DEFAULT 'Cabelo',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_client_services_user ON client_services(user_id);

  -- CLIENT PORTAL: Salon Staff / Team Members
  CREATE TABLE IF NOT EXISTS client_staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    specialty TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_client_staff_user ON client_staff(user_id);

  -- CLIENT PORTAL: Promotional Campaigns (Pro Plan)
  CREATE TABLE IF NOT EXISTS client_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    target_audience TEXT DEFAULT 'TODOS',
    status TEXT DEFAULT 'DRAFT',
    consent_confirmed INTEGER DEFAULT 0,
    opt_out_text TEXT DEFAULT 'Para não receber mais mensagens, responda SAIR.',
    recipients_count INTEGER DEFAULT 0,
    scheduled_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_client_campaigns_user ON client_campaigns(user_id);

  -- HOTMART: Idempotent Webhook Events & Audit Log
  CREATE TABLE IF NOT EXISTS hotmart_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    event_name TEXT NOT NULL,
    transaction_code TEXT,
    subscriber_code TEXT,
    buyer_email TEXT,
    buyer_phone TEXT,
    product_id TEXT,
    plan_id TEXT,
    raw_payload TEXT,
    status TEXT DEFAULT 'PROCESSED',
    processed_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_hotmart_event_id ON hotmart_webhook_events(event_id);
  CREATE INDEX IF NOT EXISTS idx_hotmart_transaction ON hotmart_webhook_events(transaction_code);
  CREATE INDEX IF NOT EXISTS idx_hotmart_subscriber ON hotmart_webhook_events(subscriber_code);

  -- MARKETING & ANALYTICS: Conversion Tracking & Traffic Source
  CREATE TABLE IF NOT EXISTS marketing_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    visitor_id TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    src TEXT,
    sck TEXT,
    page_url TEXT,
    referrer TEXT,
    ip_hash TEXT,
    user_agent TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_marketing_event_name ON marketing_events(event_name);
  CREATE INDEX IF NOT EXISTS idx_marketing_created ON marketing_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_marketing_utm_source ON marketing_events(utm_source);

  -- HOTMART: Official Affiliate Sales Records
  CREATE TABLE IF NOT EXISTS affiliate_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    affiliate_code TEXT NOT NULL,
    affiliate_name TEXT,
    transaction_code TEXT,
    product_id TEXT,
    plan_id TEXT,
    commission_amount REAL DEFAULT 0,
    currency TEXT DEFAULT 'BRL',
    buyer_email_masked TEXT,
    sale_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_affiliate_sales_code ON affiliate_sales(affiliate_code);

  CREATE TABLE IF NOT EXISTS direct_sales_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    plan_tier TEXT NOT NULL CHECK(plan_tier IN ('JESSICA_START','JESSICA_INTERMEDIATE','JESSICA_PRO')),
    promotion TEXT NOT NULL CHECK(promotion IN ('FAIR_2026','STANDARD')),
    monthly_cents INTEGER NOT NULL CHECK(monthly_cents > 0),
    setup_cents INTEGER NOT NULL CHECK(setup_cents >= 0),
    extra_professionals INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL CHECK(payment_method IN ('PIX','BOLETO','CARD_RECURRING')),
    payment_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
    created_by INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS direct_sales_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL REFERENCES direct_sales_contracts(id),
    reference TEXT NOT NULL UNIQUE,
    paid_until TEXT NOT NULL,
    confirmed_by INTEGER NOT NULL,
    confirmed_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS direct_sales_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL REFERENCES direct_sales_contracts(id),
    admin_id INTEGER NOT NULL, event_type TEXT NOT NULL, notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS asaas_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    event_type TEXT NOT NULL,
    payment_id TEXT,
    subscription_id TEXT,
    customer_id TEXT,
    payload TEXT,
    status TEXT DEFAULT 'PROCESSED',
    processed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_asaas_events_event_id ON asaas_webhook_events(event_id);

  -- MULTIPRODUCT ARCHITECTURE: Market Segments (10 official categories)
  CREATE TABLE IF NOT EXISTS product_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT DEFAULT 'layers',
    display_order INTEGER DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_prod_segments_code ON product_segments(code);
  CREATE INDEX IF NOT EXISTS idx_prod_segments_active ON product_segments(is_active);

  -- MULTIPRODUCT ARCHITECTURE: Products Catalog
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    summary TEXT,
    target_audience TEXT,
    category TEXT NOT NULL DEFAULT 'GERAL',
    solution_type TEXT NOT NULL DEFAULT 'AGENDA',
    commercial_status TEXT NOT NULL DEFAULT 'AVAILABLE',
    has_approved_offer INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    icon TEXT DEFAULT 'bot',
    metadata_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

  -- MULTIPRODUCT ARCHITECTURE: Product to Segment Association (N:N)
  CREATE TABLE IF NOT EXISTS product_segment_relations (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    segment_id INTEGER NOT NULL REFERENCES product_segments(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (product_id, segment_id)
  );
  CREATE INDEX IF NOT EXISTS idx_prod_seg_prod ON product_segment_relations(product_id);
  CREATE INDEX IF NOT EXISTS idx_prod_seg_seg ON product_segment_relations(segment_id);

  -- MULTIPRODUCT ARCHITECTURE: Plans per Product
  CREATE TABLE IF NOT EXISTS product_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY',
    price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
    setup_fee_cents INTEGER NOT NULL DEFAULT 0,
    promo_fair_price_cents INTEGER,
    max_professionals INTEGER DEFAULT 1,
    features_json TEXT,
    has_loyalty INTEGER DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, code)
  );
  CREATE INDEX IF NOT EXISTS idx_product_plans_prod ON product_plans(product_id);
  CREATE INDEX IF NOT EXISTS idx_product_plans_code ON product_plans(code);

  -- MULTIPRODUCT ARCHITECTURE: Customer Contracts & Subscriptions
  CREATE TABLE IF NOT EXISTS customer_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    contract_id INTEGER,
    product_id INTEGER NOT NULL REFERENCES products(id),
    plan_id INTEGER REFERENCES product_plans(id),
    origin TEXT NOT NULL DEFAULT 'ASAAS',
    gateway TEXT NOT NULL DEFAULT 'ASAAS',
    gateway_subscription_id TEXT,
    gateway_customer_id TEXT,
    gateway_payment_id TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    price_cents INTEGER NOT NULL,
    setup_fee_cents INTEGER NOT NULL DEFAULT 0,
    billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY',
    promotional_fair INTEGER NOT NULL DEFAULT 0,
    extra_professionals INTEGER NOT NULL DEFAULT 0,
    contracted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    paid_until TEXT,
    access_expires_at TEXT,
    cancelled_at TEXT,
    cancellation_reason TEXT,
    custom_settings_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_cust_sub_user ON customer_subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_cust_sub_prod ON customer_subscriptions(product_id);
  CREATE INDEX IF NOT EXISTS idx_cust_sub_gw_sub ON customer_subscriptions(gateway_subscription_id);
  CREATE INDEX IF NOT EXISTS idx_cust_sub_gw_cust ON customer_subscriptions(gateway_customer_id);
  CREATE INDEX IF NOT EXISTS idx_cust_sub_status ON customer_subscriptions(status);

  -- MULTIPRODUCT ARCHITECTURE: Audit Trail for Subscription Changes
  CREATE TABLE IF NOT EXISTS subscription_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL REFERENCES customer_subscriptions(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    old_status TEXT,
    new_status TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    details_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sub_audit_sub ON subscription_audit_logs(subscription_id);
  CREATE INDEX IF NOT EXISTS idx_sub_audit_user ON subscription_audit_logs(user_id);
`);

// 2. Run migrations for existing databases
function ensureColumnExists(tableName, columnName, columnDef) {
  try {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const hasColumn = columns.some((c) => c.name === columnName);
    if (!hasColumn) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
      console.log(`[Database Migration] Adicionada coluna ${columnName} na tabela ${tableName}.`);
    }
  } catch (err) {
    console.error(`Erro ao verificar/adicionar coluna ${columnName} em ${tableName}:`, err.message);
  }
}

// Versioned schema migrations & backup table
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_plans_backup (
    id INTEGER PRIMARY KEY,
    product_id INTEGER,
    code TEXT,
    name TEXT,
    description TEXT,
    billing_cycle TEXT,
    price_cents INTEGER,
    setup_fee_cents INTEGER,
    promo_fair_price_cents INTEGER,
    max_professionals INTEGER,
    features_json TEXT,
    archived_at TEXT DEFAULT CURRENT_TIMESTAMP,
    archive_reason TEXT
  );
`);

function runVersionedMigration(version, name, migrationFn) {
  const row = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version);
  if (row) return; // Already applied

  try {
    console.log(`[Database Migration] Executando migração ${version} (${name})...`);
    migrationFn();
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);
    console.log(`[Database Migration] Migração ${version} concluída com sucesso.`);
  } catch (err) {
    console.error(`[Database Migration] Falha na migração ${version}:`, err.message);
    throw err;
  }
}

// One-time non-destructive migration to archive unapproved plans from initial seeds
runVersionedMigration('20261101_01_archive_unapproved_plans', 'Archive unapproved plans for Jarvis and Dra. Camila without data loss', () => {
  // 1. Backup any existing plans before removing from active catalog
  db.exec(`
    INSERT INTO product_plans_backup (
      id, product_id, code, name, description, billing_cycle,
      price_cents, setup_fee_cents, promo_fair_price_cents,
      max_professionals, features_json, archive_reason
    )
    SELECT id, product_id, code, name, description, billing_cycle,
           price_cents, setup_fee_cents, promo_fair_price_cents,
           max_professionals, features_json, 'Migração para status IN_PREPARATION sem oferta comercial aprovada'
    FROM product_plans
    WHERE product_id IN (
      SELECT id FROM products WHERE code IN ('JARVIS_FINANCEIRO', 'ASSISTENTE_CLINICA')
    ) AND id NOT IN (SELECT id FROM product_plans_backup);
  `);

  // 2. Remove unapproved plans from active table ONLY if no active subscription depends on it
  db.prepare(`
    DELETE FROM product_plans
    WHERE product_id IN (
      SELECT id FROM products WHERE code IN ('JARVIS_FINANCEIRO', 'ASSISTENTE_CLINICA')
    )
    AND id NOT IN (SELECT DISTINCT plan_id FROM customer_subscriptions WHERE plan_id IS NOT NULL)
  `).run();
});

// Versioned migration: Fix solution_type for Jarvis to CAIXA if set to AGENDA
runVersionedMigration('20261101_02_fix_jarvis_solution_type', 'Fix solution_type for Jarvis to CAIXA if incorrectly set to AGENDA', () => {
  db.prepare(`
    UPDATE products
    SET solution_type = 'CAIXA',
        updated_at = CURRENT_TIMESTAMP
    WHERE code = 'JARVIS_FINANCEIRO' AND solution_type != 'CAIXA'
  `).run();
});

// Versioned migration: Security Hardening & Session Expiration (Proteção 08 & 17)
runVersionedMigration('20261103_01_security_hardening_27_protections', 'Eliminate permanent magic tokens and initialize security audit trail', () => {
  // Eliminate permanent magic tokens: set expiration to +7 days for any existing user with NULL
  db.prepare(`
    UPDATE users
    SET magic_token_expires_at = datetime('now', '+7 days'),
        updated_at = CURRENT_TIMESTAMP
    WHERE magic_token IS NOT NULL AND magic_token_expires_at IS NULL
  `).run();

  // Ensure security_audit_logs table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      resource TEXT,
      status TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sec_audit_event ON security_audit_logs(event_type);
    CREATE INDEX IF NOT EXISTS idx_sec_audit_user ON security_audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_sec_audit_created ON security_audit_logs(created_at);
  `);
});

// Versioned migration: Separation of Magic Login Links from Session Tokens & TOTP Support (Proteção 01, 09, 17)
runVersionedMigration('20261104_01_explicit_session_separation_and_totp', 'Separate short-lived magic links from persistent session tokens and invalidate legacy magic links', () => {
  // 1. Ensure columns exist before executing migration queries
  ensureColumnExists('users', 'session_token', 'TEXT');
  ensureColumnExists('users', 'session_expires_at', 'TEXT');
  ensureColumnExists('users', 'totp_secret', 'TEXT');
  ensureColumnExists('users', 'totp_enabled', 'INTEGER DEFAULT 0');
  ensureColumnExists('users', 'totp_recovery_codes', 'TEXT');

  // 2. Ensure existing active browser sessions continue to work seamlessly via session_token
  db.prepare(`
    UPDATE users
    SET session_token = magic_token,
        session_expires_at = COALESCE(magic_token_expires_at, datetime('now', '+7 days')),
        updated_at = CURRENT_TIMESTAMP
    WHERE magic_token IS NOT NULL AND (session_token IS NULL OR session_token = '')
  `).run();

  // 3. Safely invalidate/clear legacy magic tokens so old WhatsApp messages cannot be reused
  db.prepare(`
    UPDATE users
    SET magic_token = NULL,
        magic_token_expires_at = datetime('now', '-1 minute'),
        updated_at = CURRENT_TIMESTAMP
    WHERE magic_token IS NOT NULL
  `).run();

  // 4. Create index for fast session validation
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_session_token ON users(session_token);
    CREATE INDEX IF NOT EXISTS idx_users_magic_token ON users(magic_token);
  `);
});

// Versioned migration: Strict Session Unification & Enforce Expiration (Proteção 01, 17)
runVersionedMigration('20261104_02_strict_session_unification', 'Enforce session_expires_at on active sessions and purge expired tokens', () => {
  // 1. Ensure any legacy sessions without explicit expiration get a 30-day window
  db.prepare(`
    UPDATE users
    SET session_expires_at = datetime('now', '+30 days'),
        updated_at = CURRENT_TIMESTAMP
    WHERE session_token IS NOT NULL AND (session_expires_at IS NULL OR session_expires_at = '')
  `).run();

  // 2. Ensure magic_token is strictly nullified if expired
  db.prepare(`
    UPDATE users
    SET magic_token = NULL,
        magic_token_expires_at = datetime('now', '-1 minute'),
        updated_at = CURRENT_TIMESTAMP
    WHERE magic_token IS NOT NULL AND datetime(magic_token_expires_at) < datetime('now')
  `).run();
});

// Migration: Persistent & Cluster-Coordinated Rate Limiting (Proteção 12)
runVersionedMigration('20261104_03_persistent_rate_limiting', 'Create rate_limit_entries table for persistent and cluster-coordinated rate limiting', () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_entries (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_time INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON rate_limit_entries(reset_time);
  `);
});

// Versioned migration: Enforce Session MFA Verification & Invalidate Incompatible Admin Sessions (Proteção 01, 09, 17)
runVersionedMigration('20261105_01_session_mfa_verification_and_revocation', 'Add session_mfa_verified column and revoke legacy admin sessions lacking explicit MFA verification', () => {
  ensureColumnExists('users', 'session_mfa_verified', 'INTEGER DEFAULT 0');

  // Invalidate any existing active sessions on ADMIN accounts so they are forced to authenticate cleanly with MFA
  db.prepare(`
    UPDATE users
    SET session_token = NULL,
        session_expires_at = NULL,
        session_mfa_verified = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE role = 'ADMIN'
  `).run();
});

// User columns for Client Authentication & Hotmart Subscriptions
ensureColumnExists('users', 'session_token', 'TEXT');
ensureColumnExists('users', 'session_expires_at', 'TEXT');
ensureColumnExists('users', 'session_mfa_verified', 'INTEGER DEFAULT 0');
ensureColumnExists('users', 'totp_secret', 'TEXT');
ensureColumnExists('users', 'totp_enabled', 'INTEGER DEFAULT 0');
ensureColumnExists('users', 'totp_recovery_codes', 'TEXT');
ensureColumnExists('users', 'email', 'TEXT');
ensureColumnExists('users', 'password_hash', 'TEXT');
ensureColumnExists('users', 'password_salt', 'TEXT');
ensureColumnExists('users', 'plan_tier', "TEXT DEFAULT 'JESSICA_START'");
ensureColumnExists('users', 'subscription_status', "TEXT DEFAULT 'INACTIVE'");
ensureColumnExists('users', 'paid_until', 'TEXT');
ensureColumnExists('users', 'hotmart_subscriber_code', 'TEXT');
ensureColumnExists('users', 'hotmart_transaction', 'TEXT');
ensureColumnExists('users', 'hotmart_product_id', 'TEXT');
ensureColumnExists('users', 'hotmart_plan_id', 'TEXT');
ensureColumnExists('users', 'activation_token', 'TEXT');
ensureColumnExists('users', 'activation_expires_at', 'TEXT');
ensureColumnExists('users', 'reset_token', 'TEXT');
ensureColumnExists('users', 'reset_expires_at', 'TEXT');
ensureColumnExists('users', 'is_demo', 'INTEGER DEFAULT 0');
ensureColumnExists('users', 'last_login_at', 'TEXT');
ensureColumnExists('users', 'hotmart_last_event_at', 'INTEGER DEFAULT 0');
ensureColumnExists('users', 'needs_reconciliation', 'INTEGER DEFAULT 0');
ensureColumnExists('users', 'subscription_origin', "TEXT DEFAULT 'LEGACY'");
ensureColumnExists('users', 'extra_professionals', 'INTEGER DEFAULT 0');
ensureColumnExists('users', 'asaas_customer_id', 'TEXT');
ensureColumnExists('users', 'asaas_subscription_id', 'TEXT');
ensureColumnExists('users', 'asaas_payment_id', 'TEXT');
ensureColumnExists('users', 'asaas_last_event_at', 'INTEGER DEFAULT 0');

ensureColumnExists('direct_sales_contracts', 'asaas_customer_id', 'TEXT');
ensureColumnExists('direct_sales_contracts', 'asaas_subscription_id', 'TEXT');
ensureColumnExists('direct_sales_contracts', 'asaas_payment_id', 'TEXT');
ensureColumnExists('direct_sales_contracts', 'asaas_invoice_url', 'TEXT');
ensureColumnExists('direct_sales_contracts', 'pix_payload', 'TEXT');
ensureColumnExists('customer_subscriptions', 'contract_id', 'INTEGER');

ensureColumnExists('asaas_payments', 'subscription_id', 'TEXT');
ensureColumnExists('asaas_payments', 'user_id', 'INTEGER');
ensureColumnExists('asaas_payments', 'event_type', 'TEXT');
ensureColumnExists('asaas_webhook_events', 'status', "TEXT DEFAULT 'PROCESSED'");
ensureColumnExists('asaas_webhook_events', 'updated_at', 'TEXT');
ensureColumnExists('hotmart_webhook_events', 'creation_date', 'INTEGER');
ensureColumnExists('hotmart_webhook_events', 'updated_at', 'TEXT');

ensureColumnExists('expenses', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('incomes', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('scheduled_payments', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('reminder_logs', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('appointments', 'google_event_id', 'TEXT');

ensureColumnExists('products', 'solution_type', "TEXT DEFAULT 'AGENDA'");
ensureColumnExists('products', 'commercial_status', "TEXT DEFAULT 'AVAILABLE'");
ensureColumnExists('products', 'has_approved_offer', "INTEGER DEFAULT 1");
ensureColumnExists('products', 'summary', "TEXT");
ensureColumnExists('products', 'target_audience', "TEXT");

// Dashboard Gerencial & Financeiro 2.0 enhancements
ensureColumnExists('appointments', 'service_id', 'INTEGER');
ensureColumnExists('appointments', 'staff_id', 'INTEGER');
ensureColumnExists('appointments', 'price', 'REAL');
ensureColumnExists('appointments', 'client_name', 'TEXT');
ensureColumnExists('appointments', 'client_phone', 'TEXT');

ensureColumnExists('incomes', 'service_id', 'INTEGER');
ensureColumnExists('incomes', 'staff_id', 'INTEGER');
ensureColumnExists('incomes', 'appointment_id', 'INTEGER');

ensureColumnExists('scheduled_payments', 'paid_at', 'TEXT');

ensureColumnExists('client_services', 'duration_min', 'INTEGER DEFAULT 45');

// Safe legacy data correction for client_services duration without overwriting valid data
try {
  db.exec(`
    UPDATE client_services
    SET duration_min = 45
    WHERE duration_min IS NULL OR duration_min <= 0;
  `);
} catch (e) {
  console.warn('[Database] Aviso ao verificar migração de duração legada em client_services:', e.message);
}

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_activation ON users(activation_token);
    CREATE INDEX IF NOT EXISTS idx_users_reset ON users(reset_token);
    CREATE INDEX IF NOT EXISTS idx_users_asaas_sub ON users(asaas_subscription_id);
    CREATE INDEX IF NOT EXISTS idx_users_asaas_cust ON users(asaas_customer_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id);
    CREATE INDEX IF NOT EXISTS idx_incomes_user ON incomes(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON scheduled_payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_google_id ON appointments(google_event_id);
    CREATE INDEX IF NOT EXISTS idx_products_solution_type ON products(solution_type);
    CREATE INDEX IF NOT EXISTS idx_products_comm_status ON products(commercial_status);
    CREATE INDEX IF NOT EXISTS idx_incomes_user_date ON incomes(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_scheduled_payments_user_due ON scheduled_payments(user_id, due_date, status);
    CREATE INDEX IF NOT EXISTS idx_appointments_user_status_date ON appointments(user_id, status, start_datetime);
  `);
} catch (e) {}

// =========================================================================
// AGENDA INTELIGENTE JÉSSICA: MULTI-TENANT, GOOGLE CALENDAR & WHATSAPP
// =========================================================================
ensureColumnExists('appointments', 'duration_min', 'INTEGER DEFAULT 45');
ensureColumnExists('appointments', 'origin', "TEXT DEFAULT 'painel'");
ensureColumnExists('appointments', 'google_calendar_id', 'TEXT');
ensureColumnExists('appointments', 'google_sync_status', "TEXT DEFAULT 'NOT_CONNECTED'");
ensureColumnExists('appointments', 'google_sync_error', 'TEXT');
ensureColumnExists('appointments', 'has_conflict', 'INTEGER DEFAULT 0');
ensureColumnExists('appointments', 'whatsapp_notified', 'INTEGER DEFAULT 0');
ensureColumnExists('appointments', 'reminder_24h_status', "TEXT DEFAULT 'PENDING'");
ensureColumnExists('appointments', 'reminder_consent', 'INTEGER DEFAULT 1');
ensureColumnExists('appointments', 'updated_at', 'TEXT');

ensureColumnExists('client_staff', 'google_calendar_id', 'TEXT');
ensureColumnExists('client_staff', 'days_off', 'TEXT');
ensureColumnExists('client_staff', 'custom_hours', 'TEXT');

ensureColumnExists('client_salons', 'whatsapp_notification_phone', 'TEXT');
ensureColumnExists('client_salons', 'whatsapp_notifications_enabled', 'INTEGER DEFAULT 1');
ensureColumnExists('client_salons', 'notify_new_appointment', 'INTEGER DEFAULT 1');
ensureColumnExists('client_salons', 'notify_cancellation', 'INTEGER DEFAULT 1');
ensureColumnExists('client_salons', 'notify_reschedule', 'INTEGER DEFAULT 1');
ensureColumnExists('client_salons', 'notify_sync_failure', 'INTEGER DEFAULT 1');
ensureColumnExists('client_salons', 'b2c_reminders_enabled', 'INTEGER DEFAULT 0');
ensureColumnExists('client_salons', 'google_calendar_mode', "TEXT DEFAULT 'SINGLE'");
ensureColumnExists('client_salons', 'google_selected_calendar_id', "TEXT DEFAULT 'primary'");
ensureColumnExists('client_salons', 'google_require_sync_availability', 'INTEGER DEFAULT 0');

try {
  db.exec(`
    -- Multi-tenant Encrypted Google Calendar OAuth Tokens
    CREATE TABLE IF NOT EXISTS google_calendar_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      account_email TEXT,
      encrypted_tokens TEXT,
      scope TEXT,
      selected_calendar_id TEXT DEFAULT 'primary',
      selected_calendar_name TEXT,
      sync_mode TEXT DEFAULT 'SINGLE',
      is_connected INTEGER DEFAULT 1,
      last_sync_at TEXT,
      last_error TEXT,
      initial_connection_at TEXT,
      connected_at TEXT,
      sync_existing_authorized INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_google_tokens_user ON google_calendar_tokens(user_id);

    -- Persistent Google Calendar Outbox for Idempotent Sync & Retries
    CREATE TABLE IF NOT EXISTS google_sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      appointment_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      payload_json TEXT,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_google_sync_outbox_status ON google_sync_outbox(status);
    CREATE INDEX IF NOT EXISTS idx_google_sync_outbox_apt ON google_sync_outbox(appointment_id);

    -- Persistent WhatsApp Notification Outbox for Salon Owner/Manager
    CREATE TABLE IF NOT EXISTS whatsapp_notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      appointment_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      recipient_phone TEXT NOT NULL,
      message_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      next_retry_at TEXT,
      locked_at TEXT,
      dedup_hash TEXT,
      is_simulated INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wa_outbox_status ON whatsapp_notification_outbox(status);
    CREATE INDEX IF NOT EXISTS idx_wa_outbox_apt ON whatsapp_notification_outbox(appointment_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_reminder_24h ON appointments(reminder_24h_status, start_datetime);

    -- Appointment Lifecycle Audit History
    CREATE TABLE IF NOT EXISTS appointment_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      changed_by TEXT DEFAULT 'SYSTEM',
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_apt_history_apt ON appointment_status_history(appointment_id);

    -- Anti-CSRF OAuth States
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'google',
      expires_at INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_appointments_user_staff_dates ON appointments(user_id, staff_id, start_datetime, end_datetime);
    CREATE INDEX IF NOT EXISTS idx_appointments_google_sync ON appointments(google_sync_status);
  `);

  // Colunas de suporte a resiliência e concorrência das filas outbox
  ensureColumnExists('google_sync_outbox', 'max_attempts', 'INTEGER DEFAULT 5');
  ensureColumnExists('google_sync_outbox', 'next_retry_at', 'TEXT');
  ensureColumnExists('google_sync_outbox', 'locked_at', 'TEXT');
  ensureColumnExists('google_sync_outbox', 'idempotency_key', 'TEXT');

  ensureColumnExists('google_calendar_tokens', 'initial_connection_at', 'TEXT');
  ensureColumnExists('google_calendar_tokens', 'connected_at', 'TEXT');
  ensureColumnExists('google_calendar_tokens', 'sync_existing_authorized', 'INTEGER DEFAULT 0');
  ensureColumnExists('client_salons', 'google_sync_existing_authorized', 'INTEGER DEFAULT 0');

  ensureColumnExists('whatsapp_notification_outbox', 'max_attempts', 'INTEGER DEFAULT 5');
  ensureColumnExists('whatsapp_notification_outbox', 'next_retry_at', 'TEXT');
  ensureColumnExists('whatsapp_notification_outbox', 'locked_at', 'TEXT');
  ensureColumnExists('whatsapp_notification_outbox', 'dedup_hash', 'TEXT');
  ensureColumnExists('whatsapp_notification_outbox', 'is_simulated', 'INTEGER DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wa_outbox_dedup_hash ON whatsapp_notification_outbox(dedup_hash, created_at);');
} catch (e) {
  console.warn('[Database] Aviso ao inicializar tabelas da Agenda Inteligente:', e.message);
}

// Detecção e sinalização não-destrutiva de conflitos históricos em agendamentos existentes
try {
  const conflictResult = db.prepare(`
    UPDATE appointments
    SET has_conflict = 1
    WHERE id IN (
      SELECT a1.id
      FROM appointments a1
      JOIN appointments a2 ON a1.user_id = a2.user_id
        AND a1.id != a2.id
        AND (a1.staff_id IS NULL OR a2.staff_id IS NULL OR a1.staff_id = a2.staff_id)
        AND a1.status NOT IN ('CANCELADO', 'CANCELLED')
        AND a2.status NOT IN ('CANCELADO', 'CANCELLED')
        AND a1.start_datetime < a2.end_datetime
        AND a1.end_datetime > a2.start_datetime
    ) AND has_conflict = 0;
  `).run();
  if (conflictResult && conflictResult.changes > 0) {
    console.log(`[Database Migration] Sinalizados ${conflictResult.changes} agendamento(s) com conflito histórico para revisão no painel.`);
  }
} catch (e) {
  console.warn('[Database] Aviso ao verificar conflitos históricos de agendamentos:', e.message);
}

// 3. Ensure Master Admin user exists (phone: 5511951364159)
try {
  const masterPhone = '5511951364159';
  const existingUser = db.prepare('SELECT id FROM users WHERE phone_number = ?').get(masterPhone);

  // Read google_token if available
  let googleTokenStr = null;
  if (fs.existsSync(config.googleTokenPath)) {
    try {
      googleTokenStr = fs.readFileSync(config.googleTokenPath, 'utf8');
    } catch (e) {}
  }

  if (!existingUser) {
    db.prepare(`
      INSERT INTO users (phone_number, name, role, plan, google_token)
      VALUES (?, ?, 'ADMIN', 'PRO', ?)
    `).run(masterPhone, 'Administrador', googleTokenStr);
    console.log(`[Database] Usuário Master (${masterPhone}) configurado como ADMIN/PRO.`);
  } else {
    // Ensure role and plan are ADMIN and PRO
    db.prepare(`
      UPDATE users SET role = 'ADMIN', plan = 'PRO'
      ${googleTokenStr ? ', google_token = ?' : ''}
      WHERE id = ?
    `).run(...(googleTokenStr ? [googleTokenStr, existingUser.id] : [existingUser.id]));
  }

  // Also ensure User #1 has role = 'ADMIN'
  db.prepare(`UPDATE users SET role = 'ADMIN', plan = 'PRO' WHERE id = 1`).run();

  // If authorizedPhone is configured in env, make sure it is also ADMIN
  if (config.authorizedPhone) {
    const phones = config.authorizedPhone.split(',').map(p => p.trim().replace(/\D/g, '')).filter(Boolean);
    for (const p of phones) {
      const with55 = p.startsWith('55') ? p : `55${p}`;
      const without55 = p.startsWith('55') ? p.slice(2) : p;
      db.prepare(`UPDATE users SET role = 'ADMIN', plan = 'PRO' WHERE phone_number = ? OR phone_number = ?`).run(with55, without55);
    }
  }
} catch (err) {
  console.error('[Database] Erro ao verificar/criar usuário master:', err.message);
}

// 4. Seed Default Segments, Products & Plans for Multiproduct Architecture
try {
  // 4.1 Seed 10 Official Market Segments (Categories)
  const officialSegments = [
    { code: 'saloes_beleza', name: 'Salões & Beleza', description: 'Soluções para salões de beleza, barbearias, estética e spas', icon: 'scissors', display_order: 1 },
    { code: 'saude_clinicas', name: 'Saúde & Clínicas', description: 'Soluções para consultórios médicos, odontologia, fisioterapia e clínicas', icon: 'stethoscope', display_order: 2 },
    { code: 'delivery_restaurantes', name: 'Delivery & Restaurantes', description: 'Atendimento, cardápio digital e gestão de pedidos para gastronomia', icon: 'utensils', display_order: 3 },
    { code: 'advocacia_juridico', name: 'Advocacia & Jurídico', description: 'Triagem de clientes, agendamento de consultas e gestão jurídica', icon: 'scale', display_order: 4 },
    { code: 'imobiliarias_corretores', name: 'Imobiliárias & Corretores', description: 'Qualificação de leads, agendamento de visitas e portfólio de imóveis', icon: 'building-2', display_order: 5 },
    { code: 'oficinas_autocenters', name: 'Oficinas & Auto Centers', description: 'Orçamentos, revisões periódicas, agendamentos mecânicos e pós-venda', icon: 'wrench', display_order: 6 },
    { code: 'academias_pilates', name: 'Academias & Pilates', description: 'Agendamento de aulas, renovação de matrículas e engajamento de alunos', icon: 'dumbbell', display_order: 7 },
    { code: 'financeiro_mei', name: 'Financeiro & MEI', description: 'Conciliação, cobrança, emissão e lembretes financeiros inteligentes', icon: 'wallet', display_order: 8 },
    { code: 'locacao_obras', name: 'Locação & Obras', description: 'Gestão de locação de equipamentos, contratos e cronograma de obras', icon: 'hard-hat', display_order: 9 },
    { code: 'veiculos_seminovos', name: 'Veículos & Seminovos', description: 'Captação de compradores, simulação de propostas e estoque automotivo', icon: 'car', display_order: 10 },
  ];

  for (const seg of officialSegments) {
    const existing = db.prepare('SELECT id FROM product_segments WHERE code = ?').get(seg.code);
    if (!existing) {
      db.prepare(`
        INSERT INTO product_segments (code, name, description, icon, display_order)
        VALUES (?, ?, ?, ?, ?)
      `).run(seg.code, seg.name, seg.description, seg.icon, seg.display_order);
    }
    // Existing segments are NOT overwritten on boot, preserving administrative changes
  }

  // 4.2 Seed Products & Default Plans (insert only if not exists, never overwrite admin modifications)
  const seedProducts = [
    {
      code: 'JESSICA',
      name: 'Jéssica - Assistente Virtual para Salões e Barbearias',
      description: 'Agente de IA especializado em agendamentos, catálogo de serviços, confirmações automáticas e atendimento 24/7 via WhatsApp.',
      summary: 'Secretária virtual de WhatsApp para agendamentos automáticos, gestão de equipe e confirmação de horários.',
      target_audience: 'Salões de beleza, barbearias, manicures, clínicas de estética e spas',
      category: 'BELEZA',
      solution_type: 'AGENDA',
      commercial_status: 'AVAILABLE',
      has_approved_offer: 1,
      icon: 'scissors',
      segments: ['saloes_beleza'],
      metadata_json: JSON.stringify({ module: 'salon', whatsappCapable: true }),
      plans: [
        {
          code: 'START',
          name: 'Jéssica Entrada',
          description: 'Plano Essencial com 1 profissional incluso',
          billing_cycle: 'MONTHLY',
          price_cents: 8900,
          setup_fee_cents: 35000,
          promo_fair_price_cents: 5900,
          max_professionals: 1,
          features_json: JSON.stringify(['AGENDAMENTO_WHATSAPP', 'CATALOGO_SERVICOS', 'LEMBRETES_AUTOMATICOS', 'PAINEL_GESTAO'])
        },
        {
          code: 'INTERMEDIATE',
          name: 'Jéssica Intermediário',
          description: 'Plano Intermediário com 1 profissional incluso',
          billing_cycle: 'MONTHLY',
          price_cents: 10900,
          setup_fee_cents: 35000,
          promo_fair_price_cents: 7900,
          max_professionals: 1,
          features_json: JSON.stringify(['AGENDAMENTO_WHATSAPP', 'CATALOGO_SERVICOS', 'LEMBRETES_AUTOMATICOS', 'PAINEL_GESTAO', 'RELATORIOS_AVANCADOS'])
        },
        {
          code: 'PRO',
          name: 'Jéssica Pró',
          description: 'Plano Completo com 2 profissionais inclusos e disparos em massa',
          billing_cycle: 'MONTHLY',
          price_cents: 13900,
          setup_fee_cents: 35000,
          promo_fair_price_cents: 9900,
          max_professionals: 2,
          features_json: JSON.stringify(['AGENDAMENTO_WHATSAPP', 'CATALOGO_SERVICOS', 'LEMBRETES_AUTOMATICOS', 'PAINEL_GESTAO', 'RELATORIOS_AVANCADOS', 'CAMPANHAS_PROMOCIONAIS_WHATSAPP', 'MULTI_PROFISSIONAIS'])
        }
      ]
    },
    {
      code: 'JARVIS_FINANCEIRO',
      name: 'Jarvis - Assistente Financeiro Inteligente',
      description: 'Agente de IA para controle de receitas, despesas, contas a pagar, lembretes de vencimento e relatórios via WhatsApp.',
      summary: 'Assistente de gestão financeira via WhatsApp: receitas, despesas, contas a pagar e conciliação bancária.',
      target_audience: 'Profissionais autônomos, MEIs, pequenas empresas, salões e consultórios',
      category: 'FINANCEIRO',
      solution_type: 'CAIXA',
      commercial_status: 'IN_PREPARATION',
      has_approved_offer: 0,
      icon: 'wallet',
      segments: ['financeiro_mei', 'saloes_beleza', 'saude_clinicas'],
      metadata_json: JSON.stringify({
        module: 'finance',
        whatsappCapable: true,
        statusNote: 'Em preparação operacional — condições comerciais sob definição'
      }),
      plans: []
    },
    {
      code: 'ASSISTENTE_CLINICA',
      name: 'Dra. Camila - Atendente para Clínicas e Consultórios',
      description: 'Agente de IA especializado em triagem, agendamento de consultas médicas e odontológicas, orientações e retornos.',
      summary: 'Atendente virtual inteligente para triagem, agendamento de consultas médicas e odontológicas.',
      target_audience: 'Consultórios médicos, odontologia, clínicas de psicologia, fisioterapia e saúde',
      category: 'SAUDE',
      solution_type: 'AGENDA',
      commercial_status: 'IN_PREPARATION',
      has_approved_offer: 0,
      icon: 'stethoscope',
      segments: ['saude_clinicas'],
      metadata_json: JSON.stringify({
        module: 'clinic',
        whatsappCapable: true,
        statusNote: 'Em preparação operacional — condições comerciais sob definição'
      }),
      plans: []
    },
    {
      code: 'GROWTH_ASSISTANT_VIP',
      name: 'Growth Assistant VIP',
      description: 'Ferramentas de Marketing e Growth com inteligência artificial para captação, sorteios, licenciamento e automação multicanal.',
      summary: 'Suíte de marketing para crescimento acelerado: extensão Chrome, aplicativo Android, sorteador web e licenciamento.',
      target_audience: 'Empresas de todos os segmentos que buscam captação acelerada de clientes e campanhas virais',
      category: 'Ferramentas de Marketing',
      solution_type: 'MARKETING',
      commercial_status: 'IN_PREPARATION',
      has_approved_offer: 0,
      icon: 'zap',
      segments: ['saloes_beleza', 'delivery_restaurantes', 'imobiliarias_corretores', 'veiculos_seminovos'],
      metadata_json: JSON.stringify({
        plannedFeatures: ['Extensão Chrome', 'Aplicativo Android', 'Sorteador Web', 'Licenciamento de IA'],
        statusNote: 'Em preparação operacional'
      }),
      plans: []
    }
  ];

  for (const prod of seedProducts) {
    let pRow = db.prepare('SELECT id FROM products WHERE code = ?').get(prod.code);
    if (!pRow) {
      const res = db.prepare(`
        INSERT INTO products (code, name, description, summary, target_audience, category, solution_type, commercial_status, has_approved_offer, icon, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prod.code, prod.name, prod.description, prod.summary, prod.target_audience,
        prod.category, prod.solution_type, prod.commercial_status, prod.has_approved_offer,
        prod.icon, prod.metadata_json
      );
      pRow = { id: Number(res.lastInsertRowid) };
      console.log(`[Database Seed] Produto criado: ${prod.code} (${prod.name})`);

      // Associate product with initial segments only on creation
      if (pRow?.id && Array.isArray(prod.segments)) {
        for (const segCode of prod.segments) {
          const segRow = db.prepare('SELECT id FROM product_segments WHERE code = ?').get(segCode);
          if (segRow) {
            db.prepare(`
              INSERT OR IGNORE INTO product_segment_relations (product_id, segment_id)
              VALUES (?, ?)
            `).run(pRow.id, segRow.id);
          }
        }
      }

      // Seed default plans only on initial product creation
      if (pRow?.id && prod.plans && prod.plans.length > 0) {
        for (const pl of prod.plans) {
          const existingPlan = db.prepare('SELECT id FROM product_plans WHERE product_id = ? AND code = ?').get(pRow.id, pl.code);
          if (!existingPlan) {
            db.prepare(`
              INSERT INTO product_plans (
                product_id, code, name, description, billing_cycle,
                price_cents, setup_fee_cents, promo_fair_price_cents,
                max_professionals, features_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              pRow.id, pl.code, pl.name, pl.description, pl.billing_cycle,
              pl.price_cents, pl.setup_fee_cents, pl.promo_fair_price_cents,
              pl.max_professionals || 1, pl.features_json
            );
            console.log(`[Database Seed] Plano criado: ${prod.code} -> ${pl.code} (${pl.name})`);
          }
        }
      }
    }
    // Existing products and their custom plans are left intact, preserving admin modifications
  }

  // 5. Backfill: Ensure existing users with contracts have customer_subscriptions for JESSICA
  const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  if (jessica) {
    const plans = db.prepare('SELECT id, code, price_cents, setup_fee_cents, promo_fair_price_cents FROM product_plans WHERE product_id = ?').all(jessica.id);
    const planMap = {};
    for (const p of plans) planMap[p.code] = p;

    const candidates = db.prepare(`
      SELECT u.id, u.plan_tier, u.subscription_status, u.paid_until, u.subscription_origin,
             u.extra_professionals, u.asaas_subscription_id, u.asaas_customer_id, u.asaas_payment_id,
             u.hotmart_subscriber_code, u.hotmart_transaction,
             c.id AS contract_id, c.promotion, c.monthly_cents, c.setup_cents, c.payment_status
      FROM users u
      LEFT JOIN direct_sales_contracts c ON c.user_id = u.id
      WHERE u.role != 'ADMIN' AND (
        u.plan_tier IS NOT NULL OR u.subscription_status IS NOT NULL OR c.id IS NOT NULL
        OR EXISTS (SELECT 1 FROM client_salons s WHERE s.user_id = u.id)
      )
    `).all();

    for (const u of candidates) {
      const existingSub = db.prepare('SELECT id FROM customer_subscriptions WHERE user_id = ? AND product_id = ?').get(u.id, jessica.id);
      if (!existingSub) {
        let planCode = 'START';
        if (u.plan_tier?.includes('PRO')) planCode = 'PRO';
        else if (u.plan_tier?.includes('INTERMEDIATE')) planCode = 'INTERMEDIATE';
        const plan = planMap[planCode] || plans[0];

        const isFair = u.promotion === 'FAIR_2026';
        let priceCents = u.monthly_cents || (isFair ? (plan?.promo_fair_price_cents || 5900) : (plan?.price_cents || 8900));
        let setupCents = u.setup_cents !== undefined && u.setup_cents !== null ? u.setup_cents : (isFair ? 0 : 35000);

        let gateway = 'MANUAL';
        let origin = u.subscription_origin || 'LEGACY';
        if (u.subscription_origin === 'HOTMART' || u.hotmart_subscriber_code) {
          gateway = 'HOTMART';
          origin = 'HOTMART';
        } else if (u.subscription_origin === 'ASAAS' || u.asaas_subscription_id) {
          gateway = 'ASAAS';
          origin = 'ASAAS';
        }

        const subStatus = u.subscription_status || 'INACTIVE';
        const subId = u.asaas_subscription_id || u.hotmart_subscriber_code || null;

        db.prepare(`
          INSERT INTO customer_subscriptions (
            user_id, contract_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
            gateway_customer_id, gateway_payment_id, status, price_cents, setup_fee_cents,
            billing_cycle, promotional_fair, extra_professionals, contracted_at, paid_until,
            access_expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MONTHLY', ?, ?, CURRENT_TIMESTAMP, ?, ?)
        `).run(
          u.id, u.contract_id || null, jessica.id, plan?.id || null, origin, gateway,
          subId, u.asaas_customer_id || null, u.asaas_payment_id || null,
          subStatus, priceCents, setupCents, isFair ? 1 : 0,
          u.extra_professionals || 0, u.paid_until || null, u.paid_until || null
        );
      }
    }
  }
} catch (seedErr) {
  console.warn('[Database Seed] Aviso ao semear produtos ou migrar assinaturas:', seedErr.message);
}

/**
 * SQLite Integrity & Security Validation (Proteção 03)
 */
db.checkDatabaseIntegrity = function () {
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    const isOk = result.length === 1 && result[0].integrity_check === 'ok';
    return {
      ok: isOk,
      result: result.map(r => r.integrity_check).join('; '),
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    return { ok: false, error: err.message, timestamp: new Date().toISOString() };
  }
};

/**
 * SQLite Atomic Zero-Downtime Safe Backup (Proteção 03)
 */
db.backupDatabase = function (targetPath = null) {
  if (!targetPath) {
    const backupDir = path.resolve(path.dirname(config.dbPath), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    targetPath = path.join(backupDir, `assistant-backup-${timestamp}.db`);
  }

  try {
    db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
    return {
      success: true,
      backupPath: targetPath,
      sizeBytes: fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    throw new Error(`Falha ao executar backup SQLite: ${err.message}`);
  }
};

module.exports = db;
