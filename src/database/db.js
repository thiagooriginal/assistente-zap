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
    processed_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_asaas_events_event_id ON asaas_webhook_events(event_id);

  -- MULTIPRODUCT ARCHITECTURE: Products Catalog
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'GERAL',
    is_active INTEGER NOT NULL DEFAULT 1,
    icon TEXT DEFAULT 'bot',
    metadata_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

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

// User columns for Client Authentication & Hotmart Subscriptions
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

ensureColumnExists('asaas_payments', 'subscription_id', 'TEXT');
ensureColumnExists('asaas_payments', 'user_id', 'INTEGER');
ensureColumnExists('asaas_payments', 'event_type', 'TEXT');
ensureColumnExists('hotmart_webhook_events', 'creation_date', 'INTEGER');

ensureColumnExists('expenses', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('incomes', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('scheduled_payments', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('reminder_logs', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('appointments', 'google_event_id', 'TEXT');

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
  `);
} catch (e) {}

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
      db.prepare(`UPDATE users SET role = 'ADMIN', plan = 'PRO' WHERE phone_number LIKE ?`).run(`%${p.slice(-8)}`);
    }
  }
} catch (err) {
  console.error('[Database] Erro ao verificar/criar usuário master:', err.message);
}

// 4. Seed Default Products & Plans for Multiproduct Architecture
try {
  const seedProducts = [
    {
      code: 'JESSICA',
      name: 'Jéssica - Assistente Virtual para Salões e Barbearias',
      description: 'Agente de IA especializado em agendamentos, catálogo de serviços, confirmações automáticas e atendimento 24/7 via WhatsApp.',
      category: 'BELEZA',
      icon: 'scissors',
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
      category: 'FINANCEIRO',
      icon: 'wallet',
      metadata_json: JSON.stringify({ module: 'finance', whatsappCapable: true }),
      plans: [
        {
          code: 'START',
          name: 'Jarvis Inicial',
          description: 'Controle financeiro pessoal e MEI via WhatsApp',
          billing_cycle: 'MONTHLY',
          price_cents: 9900,
          setup_fee_cents: 0,
          promo_fair_price_cents: 7900,
          max_professionals: 1,
          features_json: JSON.stringify(['RECEITAS_DESPESAS', 'LEMBRETES_CONTAS', 'RELATORIOS_MENSAIS'])
        },
        {
          code: 'PRO',
          name: 'Jarvis Empresarial',
          description: 'Gestão financeira avançada para PMEs com conciliação',
          billing_cycle: 'MONTHLY',
          price_cents: 19900,
          setup_fee_cents: 0,
          promo_fair_price_cents: 14900,
          max_professionals: 5,
          features_json: JSON.stringify(['RECEITAS_DESPESAS', 'LEMBRETES_CONTAS', 'RELATORIOS_AVANCADOS', 'CONCILIACAO_EXTRATOS', 'MULTI_USUARIOS'])
        }
      ]
    },
    {
      code: 'ASSISTENTE_CLINICA',
      name: 'Dra. Camila - Atendente para Clínicas e Consultórios',
      description: 'Agente de IA especializado em triagem, agendamento de consultas médicas e odontológicas, orientações e retornos.',
      category: 'SAUDE',
      icon: 'stethoscope',
      metadata_json: JSON.stringify({ module: 'clinic', whatsappCapable: true }),
      plans: [
        {
          code: 'START',
          name: 'Dra. Camila Clínicas Básica',
          description: 'Agendamento e triagem para 1 consultório',
          billing_cycle: 'MONTHLY',
          price_cents: 11900,
          setup_fee_cents: 35000,
          promo_fair_price_cents: 9900,
          max_professionals: 1,
          features_json: JSON.stringify(['AGENDAMENTO_CONSULTAS', 'CONFIRMACOES_LEMBRETES', 'PRONTUARIO_INTEGRADO'])
        },
        {
          code: 'PRO',
          name: 'Dra. Camila Clínicas Avançada',
          description: 'Triagem personalizada, múltiplos especialistas e retornos',
          billing_cycle: 'MONTHLY',
          price_cents: 24900,
          setup_fee_cents: 35000,
          promo_fair_price_cents: 18900,
          max_professionals: 5,
          features_json: JSON.stringify(['AGENDAMENTO_CONSULTAS', 'CONFIRMACOES_LEMBRETES', 'PRONTUARIO_INTEGRADO', 'MULTI_ESPECIALISTAS', 'TRIAGEM_INTELIGENTE'])
        }
      ]
    }
  ];

  for (const prod of seedProducts) {
    let pRow = db.prepare('SELECT id FROM products WHERE code = ?').get(prod.code);
    if (!pRow) {
      const res = db.prepare(`
        INSERT INTO products (code, name, description, category, icon, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(prod.code, prod.name, prod.description, prod.category, prod.icon, prod.metadata_json);
      pRow = { id: Number(res.lastInsertRowid) };
      console.log(`[Database Seed] Produto criado: ${prod.code} (${prod.name})`);
    }

    if (pRow?.id && prod.plans) {
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
             c.promotion, c.monthly_cents, c.setup_cents, c.payment_status
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
            user_id, product_id, plan_id, origin, gateway, gateway_subscription_id,
            gateway_customer_id, gateway_payment_id, status, price_cents, setup_fee_cents,
            billing_cycle, promotional_fair, extra_professionals, contracted_at, paid_until,
            access_expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MONTHLY', ?, ?, CURRENT_TIMESTAMP, ?, ?)
        `).run(
          u.id, jessica.id, plan?.id || null, origin, gateway,
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


module.exports = db;
