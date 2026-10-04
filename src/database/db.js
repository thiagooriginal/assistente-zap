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
`);

// 2. Run migrations for existing databases to add user_id column if missing
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

ensureColumnExists('expenses', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('scheduled_payments', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
ensureColumnExists('reminder_logs', 'user_id', 'INTEGER NOT NULL DEFAULT 1');

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON scheduled_payments(user_id);
  `);
} catch (e) {}

// 3. Ensure Master Admin user exists (phone: 5511951364159)
try {
  const masterPhone = '5511951364159';
  const existingUser = db.prepare('SELECT id FROM users WHERE phone_number = ?').get(masterPhone);
  if (!existingUser) {
    // Read google_token if available
    let googleTokenStr = null;
    if (fs.existsSync(config.googleTokenPath)) {
      try {
        googleTokenStr = fs.readFileSync(config.googleTokenPath, 'utf8');
      } catch (e) {}
    }

    db.prepare(`
      INSERT INTO users (phone_number, name, role, plan, google_token)
      VALUES (?, ?, 'ADMIN', 'PRO', ?)
    `).run(masterPhone, 'Administrador', googleTokenStr);
    console.log(`[Database] Usuário Master (${masterPhone}) configurado como ADMIN/PRO.`);
  }
} catch (err) {
  console.error('[Database] Erro ao verificar/criar usuário master:', err.message);
}

module.exports = db;
