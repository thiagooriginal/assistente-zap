const db = require('../database/db');
const crypto = require('crypto');

/**
 * Clean phone number to digits only
 */
function cleanPhone(phone) {
  if (!phone) return '';
  return phone.replace(/[^0-9]/g, '');
}

/**
 * Get user by phone number
 */
function getUserByPhone(phoneNumber) {
  const clean = cleanPhone(phoneNumber);
  if (!clean) return null;

  // Direct match
  let user = db.prepare('SELECT * FROM users WHERE phone_number = ?').get(clean);
  if (user) return user;

  // Suffix / DDD matching for Brazilian numbers
  if (clean.length >= 10) {
    const ddd = clean.length >= 12 ? clean.slice(2, 4) : clean.slice(0, 2);
    const last8 = clean.slice(-8);

    const allUsers = db.prepare('SELECT * FROM users').all();
    for (const u of allUsers) {
      const uClean = cleanPhone(u.phone_number);
      const uDDD = uClean.length >= 12 ? uClean.slice(2, 4) : uClean.slice(0, 2);
      const uLast8 = uClean.slice(-8);
      if (last8 === uLast8 && ddd === uDDD) {
        return u;
      }
    }
  }

  return null;
}

/**
 * Get user by ID
 */
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * Get or create user on first message (Automatic Onboarding)
 */
function getOrCreateUser({ phoneNumber, name = null, trialDays = 7 }) {
  const clean = cleanPhone(phoneNumber);
  let user = getUserByPhone(clean);

  if (user) {
    return { user, isNew: false };
  }

  // Create new user with 7-day free trial
  const now = new Date();
  const trialEnds = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString();

  const insert = db.prepare(`
    INSERT INTO users (phone_number, name, role, plan, trial_ends_at)
    VALUES (?, ?, 'USER', 'FREE_TRIAL', ?)
  `).run(clean, name, trialEnds);

  user = getUserById(insert.lastInsertRowid);
  console.log(`[Multi-Tenant Onboarding] Novo usuário cadastrado: #${user.id} (${clean}) - Teste até ${trialEnds}`);

  return { user, isNew: true };
}

/**
 * Update user fields
 */
function updateUser(id, fields = {}) {
  const allowed = ['name', 'plan', 'role', 'trial_ends_at', 'google_token', 'google_calendar_id'];
  const sets = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (sets.length === 0) return getUserById(id);

  sets.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(id);
}

/**
 * Generate a 1-click passwordless Magic Link for the dashboard
 */
function generateMagicToken(userId, baseUrl = '') {
  const existing = db.prepare('SELECT magic_token FROM users WHERE id = ?').get(userId);
  let token = existing?.magic_token;

  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
  }

  // Set magic_token_expires_at to NULL for permanent lifetime
  db.prepare(`
    UPDATE users 
    SET magic_token = ?, magic_token_expires_at = NULL 
    WHERE id = ?
  `).run(token, userId);

  const cleanBase = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
  const loginUrl = `${cleanBase}/auth/magic?token=${token}`;

  return {
    token,
    expiresAt: null,
    url: loginUrl,
  };
}

/**
 * Validate magic token and return user
 */
function getUserByMagicToken(token) {
  if (!token) return null;
  const user = db.prepare('SELECT * FROM users WHERE magic_token = ?').get(token);
  if (!user) return null;

  if (user.magic_token_expires_at) {
    const expires = new Date(user.magic_token_expires_at);
    if (expires < new Date()) {
      return null; // Expired
    }
  }

  return user;
}

/**
 * Check if user plan is active
 */
function isUserActive(user) {
  if (!user) return { active: false, reason: 'Usuário não encontrado' };

  if (user.role === 'ADMIN') {
    return { active: true, isAdmin: true, plan: 'ADMIN' };
  }

  if (user.plan === 'PRO') {
    return { active: true, plan: 'PRO' };
  }

  if (user.plan === 'FREE_TRIAL') {
    if (!user.trial_ends_at) {
      return { active: true, plan: 'FREE_TRIAL', daysRemaining: 7 };
    }

    const now = new Date();
    const trialEnd = new Date(user.trial_ends_at);
    const diffMs = trialEnd.getTime() - now.getTime();

    if (diffMs > 0) {
      const daysRemaining = Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
      return { active: true, plan: 'FREE_TRIAL', daysRemaining };
    } else {
      return {
        active: false,
        expired: true,
        reason: 'Seu período de teste gratuito de 7 dias encerrou. Fale com nosso suporte para assinar o plano Pro!',
      };
    }
  }

  return { active: false, reason: 'Plano inativo ou suspenso.' };
}

/**
 * Get all users for admin dashboard
 */
function getAllUsers() {
  return db.prepare(`
    SELECT id, phone_number, name, role, plan, trial_ends_at, created_at,
           (SELECT COUNT(*) FROM expenses WHERE expenses.user_id = users.id) as total_expenses,
           (SELECT COUNT(*) FROM scheduled_payments WHERE scheduled_payments.user_id = users.id) as total_bills
    FROM users
    ORDER BY id ASC
  `).all();
}

/**
 * Format phone number nicely for display (e.g. +55 (11) 99999-9999)
 */
function formatPhone(phone) {
  if (!phone) return '';
  const p = cleanPhone(phone);
  if (p.length === 13) {
    return `+${p.slice(0, 2)} (${p.slice(2, 4)}) ${p.slice(4, 9)}-${p.slice(9)}`;
  }
  if (p.length === 11) {
    return `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}`;
  }
  return phone;
}

/**
 * Generate a new invite code
 */
function createInviteCode({ createdBy = 1, trialDays = 7, customCode = null } = {}) {
  let code = customCode;
  if (!code) {
    const num = Math.floor(1000 + Math.random() * 9000);
    code = `ZAP-${num}`;
  } else {
    code = code.toUpperCase().trim();
  }

  const existing = db.prepare('SELECT id FROM invite_codes WHERE code = ?').get(code);
  if (existing) {
    const num2 = Math.floor(1000 + Math.random() * 9000);
    code = `ZAP-${num2}`;
  }

  db.prepare(`
    INSERT INTO invite_codes (code, created_by, status, trial_days)
    VALUES (?, ?, 'PENDING', ?)
  `).run(code, createdBy, trialDays);

  return db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
}

/**
 * Search text for any pending invite code
 */
function findPendingInviteInText(text) {
  if (!text) return null;
  const cleanInput = text.toUpperCase().replace(/\s+/g, '');

  const pendingList = db.prepare("SELECT * FROM invite_codes WHERE status = 'PENDING'").all();
  for (const inv of pendingList) {
    const codeClean = inv.code.toUpperCase().replace(/\s+/g, '');
    const codeNumOnly = inv.code.replace(/[^0-9]/g, '');

    // Match full code (e.g. ZAP-1234 or ZAP1234)
    if (cleanInput.includes(codeClean) || cleanInput.includes(codeClean.replace('-', ''))) {
      return inv;
    }
    // If the input is just the 4 digits (e.g. "1234") and it matches
    if (codeNumOnly && codeNumOnly.length >= 4 && cleanInput.trim() === codeNumOnly) {
      return inv;
    }
  }

  return null;
}

/**
 * Redeem an invite code to activate a new user
 */
function redeemInviteCode({ code, phoneNumber, name = null }) {
  const clean = cleanPhone(phoneNumber);
  const invite = db.prepare("SELECT * FROM invite_codes WHERE code = ? AND status = 'PENDING'").get(code);
  if (!invite) {
    throw new Error('Código de convite inválido ou já utilizado.');
  }

  let user = getUserByPhone(clean);
  const now = new Date();
  const trialEnds = new Date(now.getTime() + (invite.trial_days || 7) * 24 * 60 * 60 * 1000).toISOString();

  if (!user) {
    const insert = db.prepare(`
      INSERT INTO users (phone_number, name, role, plan, trial_ends_at)
      VALUES (?, ?, 'USER', 'FREE_TRIAL', ?)
    `).run(clean, name, trialEnds);
    user = getUserById(insert.lastInsertRowid);
  } else {
    db.prepare(`
      UPDATE users 
      SET plan = 'FREE_TRIAL', trial_ends_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(trialEnds, user.id);
    user = getUserById(user.id);
  }

  db.prepare(`
    UPDATE invite_codes
    SET status = 'USED', used_by_user_id = ?, used_by_phone = ?, used_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(user.id, clean, invite.id);

  console.log(`[Convite Ativado] Código ${code} resgatado com sucesso por ${clean} (#${user.id}).`);

  return { success: true, user, invite: db.prepare('SELECT * FROM invite_codes WHERE id = ?').get(invite.id) };
}

/**
 * List all invite codes for admin
 */
function getAllInvites() {
  return db.prepare(`
    SELECT i.*, u.phone_number as user_phone
    FROM invite_codes i
    LEFT JOIN users u ON i.used_by_user_id = u.id
    ORDER BY i.id DESC
  `).all();
}

/**
 * Delete or reset a user for testing purposes
 */
function deleteUser(id) {
  if (id === 1) throw new Error('Não é permitido excluir o usuário Administrador');
  db.prepare('DELETE FROM expenses WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_payments WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM appointments WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

function isUserAdmin(user) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (user.id === 1) return true;
  const clean = cleanPhone(user.phone_number);
  if (clean.endsWith('951364159')) return true;
  try {
    const config = require('../config');
    if (config.authorizedPhone) {
      const authorized = config.authorizedPhone.split(',').map(cleanPhone).filter(Boolean);
      if (authorized.some((auth) => clean.endsWith(auth.slice(-8)))) return true;
    }
  } catch (e) {}
  return false;
}

module.exports = {
  cleanPhone,
  formatPhone,
  getUserByPhone,
  getUserById,
  getOrCreateUser,
  updateUser,
  generateMagicToken,
  getUserByMagicToken,
  isUserActive,
  isUserAdmin,
  getAllUsers,
  createInviteCode,
  findPendingInviteInText,
  redeemInviteCode,
  getAllInvites,
  deleteUser,
};
