const crypto = require('crypto');
const db = require('../database/db');
const config = require('../config');

// Helper to hash password with salt using scrypt
function hashPassword(password, salt = null) {
  const passwordSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, passwordSalt, 64).toString('hex');
  return { hash, salt: passwordSalt };
}

// Timing-safe password verification
function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) return false;
  try {
    const hash = crypto.scryptSync(password, storedSalt, 64).toString('hex');
    const bufA = Buffer.from(hash, 'hex');
    const bufB = Buffer.from(storedHash, 'hex');
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
  } catch (e) {
    return false;
  }
}

// Generate secure random token
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Validate activation token
 */
function validateActivationToken(token) {
  if (!token) return { valid: false, error: 'Token não fornecido.' };

  const user = db.prepare(`
    SELECT * FROM users
    WHERE activation_token = ?
  `).get(token);

  if (!user) {
    return { valid: false, error: 'Token de ativação inválido ou não encontrado.' };
  }

  if (user.activation_expires_at) {
    const expires = new Date(user.activation_expires_at);
    if (expires < new Date()) {
      return { valid: false, error: 'Token de ativação expirado. Solicite um novo link.' };
    }
  }

  return { valid: true, user };
}

/**
 * Activate client account with password
 */
function activateAccount(token, password) {
  const check = validateActivationToken(token);
  if (!check.valid) return check;

  const user = check.user;

  if (!password || password.length < 8) {
    return { valid: false, error: 'A senha deve conter no mínimo 8 caracteres.' };
  }

  const { hash, salt } = hashPassword(password);

  // Transition from PENDING to ACTIVE if payment was confirmed
  let newStatus = user.subscription_status;
  if (newStatus === 'PENDING') {
    newStatus = 'ACTIVE';
  }

  db.prepare(`
    UPDATE users
    SET password_hash = ?,
        password_salt = ?,
        activation_token = NULL,
        activation_expires_at = NULL,
        subscription_status = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hash, salt, newStatus, user.id);

  // Ensure salon entry exists
  ensureSalonForUser(user.id, user.name);

  // Generate session token
  const sessionToken = generateSecureToken(24);
  db.prepare(`UPDATE users SET magic_token = ? WHERE id = ?`).run(sessionToken, user.id);

  return {
    valid: true,
    success: true,
    token: sessionToken,
    user: getSanitizedUser(user.id),
  };
}

/**
 * Login client with email and password
 */
function login(email, password) {
  if (!email || !password) {
    return { success: false, error: 'Informe o e-mail e a senha.' };
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const user = db.prepare(`
    SELECT * FROM users
    WHERE LOWER(email) = ?
  `).get(cleanEmail);

  if (!user) {
    return { success: false, error: 'E-mail ou senha incorretos.', code: 'INVALID_CREDENTIALS' };
  }

  // Check subscription status
  const subStatus = user.subscription_status || 'ACTIVE';

  if (subStatus === 'REFUNDED' || subStatus === 'CHARGEBACK') {
    return {
      success: false,
      error: 'Acesso suspenso devido a reembolso ou contestação de pagamento. Contate o suporte da RAIA.',
      code: 'SUBSCRIPTION_REFUNDED',
    };
  }

  if (subStatus === 'INACTIVE') {
    return {
      success: false,
      error: 'Assinatura inativa. Confirme o pagamento na Hotmart para liberar seu acesso.',
      code: 'SUBSCRIPTION_INACTIVE',
    };
  }

  if (subStatus === 'PENDING' || !user.password_hash || !user.password_salt) {
    return {
      success: false,
      error: 'Sua conta ainda não foi ativada. Use o link de ativação enviado para o seu e-mail ou WhatsApp para criar sua senha de acesso.',
      code: 'ACCOUNT_PENDING_ACTIVATION',
    };
  }

  const isMatch = verifyPassword(password, user.password_hash, user.password_salt);
  if (!isMatch) {
    return { success: false, error: 'E-mail ou senha incorretos.', code: 'INVALID_CREDENTIALS' };
  }

  let warning = null;
  if (subStatus === 'CANCELED') {
    const paidUntil = user.paid_until ? new Date(user.paid_until) : null;
    const now = new Date();
    if (paidUntil && paidUntil > now) {
      warning = `Sua assinatura foi cancelada, mas você tem acesso garantido até ${paidUntil.toLocaleDateString('pt-BR')}.`;
    } else {
      return {
        success: false,
        error: 'Sua assinatura foi cancelada e o período pago já expirou. Renove para continuar acessando.',
      };
    }
  } else if (subStatus === 'OVERDUE') {
    warning = 'Identificamos uma pendência na renovação da sua assinatura. Regularize para não perder o atendimento da Jéssica.';
  }

  // Update session & last login
  const sessionToken = generateSecureToken(24);
  db.prepare(`
    UPDATE users
    SET magic_token = ?,
        last_login_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(sessionToken, user.id);

  // Ensure salon entry exists
  ensureSalonForUser(user.id, user.name);

  return {
    success: true,
    token: sessionToken,
    warning,
    user: getSanitizedUser(user.id),
  };
}

/**
 * Request password reset
 */
function requestPasswordReset(email) {
  if (!email) return { success: false, error: 'Informe seu e-mail.' };

  const cleanEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT id, name, phone_number FROM users WHERE LOWER(email) = ?').get(cleanEmail);

  // Always return success to prevent email enumeration
  if (!user) {
    return {
      success: true,
      message: 'Se o e-mail estiver cadastrado, as instruções de recuperação serão enviadas.',
    };
  }

  const resetToken = generateSecureToken(32);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  db.prepare(`
    UPDATE users
    SET reset_token = ?,
        reset_expires_at = ?
    WHERE id = ?
  `).run(resetToken, expiresAt, user.id);

  return {
    success: true,
    resetToken, // For internal dispatch / testing
    userId: user.id,
    phone: user.phone_number,
    name: user.name,
    message: 'Se o e-mail estiver cadastrado, as instruções de recuperação serão enviadas.',
  };
}

/**
 * Reset password with token
 */
function resetPassword(token, newPassword) {
  if (!token) return { success: false, error: 'Token de recuperação não fornecido.' };

  if (!newPassword || newPassword.length < 8) {
    return { success: false, error: 'A nova senha deve ter no mínimo 8 caracteres.' };
  }

  const user = db.prepare(`
    SELECT * FROM users
    WHERE reset_token = ?
  `).get(token);

  if (!user) {
    return { success: false, error: 'Token de recuperação inválido ou já utilizado.' };
  }

  if (user.reset_expires_at) {
    const expires = new Date(user.reset_expires_at);
    if (expires < new Date()) {
      return { success: false, error: 'Token de recuperação expirado. Solicite um novo.' };
    }
  }

  const { hash, salt } = hashPassword(newPassword);

  db.prepare(`
    UPDATE users
    SET password_hash = ?,
        password_salt = ?,
        reset_token = NULL,
        reset_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hash, salt, user.id);

  return {
    success: true,
    message: 'Senha redefinida com sucesso! Você já pode entrar com sua nova senha.',
  };
}

/**
 * Ensure default salon entry for user
 */
function ensureSalonForUser(userId, userName = '') {
  let salon = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(userId);
  if (!salon) {
    const defaultHours = JSON.stringify({
      seg: { open: '09:00', close: '19:00', active: true },
      ter: { open: '09:00', close: '19:00', active: true },
      qua: { open: '09:00', close: '19:00', active: true },
      qui: { open: '09:00', close: '19:00', active: true },
      sex: { open: '09:00', close: '19:00', active: true },
      sab: { open: '09:00', close: '18:00', active: true },
      dom: { open: '09:00', close: '14:00', active: false },
    });

    const salonName = userName ? `Salão de ${userName.split(' ')[0]}` : 'Meu Salão de Beleza';

    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, opening_hours, whatsapp_status)
      VALUES (?, ?, ?, 'DISCONNECTED')
    `).run(userId, salonName, defaultHours);

    // Seed default starter services if none exist
    const svcCount = db.prepare('SELECT COUNT(*) as count FROM client_services WHERE user_id = ?').get(userId)?.count || 0;
    if (svcCount === 0) {
      const defaultServices = [
        { name: 'Corte Feminino com Escova', price: 90.0, duration: 60, cat: 'Cabelo' },
        { name: 'Corte Masculino Degradê', price: 50.0, duration: 40, cat: 'Cabelo' },
        { name: 'Manicure & Pedicure', price: 65.0, duration: 50, cat: 'Unhas' },
        { name: 'Design de Sobrancelhas', price: 35.0, duration: 30, cat: 'Estética' },
      ];
      for (const s of defaultServices) {
        db.prepare(`
          INSERT INTO client_services (user_id, name, price, duration_min, category)
          VALUES (?, ?, ?, ?, ?)
        `).run(userId, s.name, s.price, s.duration, s.cat);
      }
    }

    // Seed default staff member
    const staffCount = db.prepare('SELECT COUNT(*) as count FROM client_staff WHERE user_id = ?').get(userId)?.count || 0;
    if (staffCount === 0) {
      db.prepare(`
        INSERT INTO client_staff (user_id, name, specialty)
        VALUES (?, 'Profissional Principal', 'Cortes & Procedimentos')
      `).run(userId);
    }

    salon = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(userId);
  }
  return salon;
}

/**
 * Get sanitized user profile
 */
function getSanitizedUser(userId) {
  const user = db.prepare(`
    SELECT id, email, name, phone_number, plan_tier, subscription_status,
           paid_until, is_demo, created_at, last_login_at
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!user) return null;

  const salon = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(userId) || null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone_number,
    planTier: user.plan_tier || 'JESSICA_START',
    plan_tier: user.plan_tier || 'JESSICA_START',
    subscriptionStatus: user.subscription_status || 'ACTIVE',
    subscription_status: user.subscription_status || 'ACTIVE',
    paidUntil: user.paid_until,
    isDemo: Boolean(user.is_demo),
    is_demo: user.is_demo ? 1 : 0,
    salon: salon ? {
      name: salon.salon_name,
      phone: salon.phone,
      address: salon.address,
      openingHours: salon.opening_hours ? JSON.parse(salon.opening_hours) : null,
      customInstructions: salon.agent_custom_instructions,
      whatsappStatus: salon.whatsapp_status || 'DISCONNECTED',
    } : null,
  };
}

/**
 * Setup and seed isolated Hotmart compliance demo account
 */
function ensureDemoAccount() {
  const email = config.demoAccountEmail;
  let rawPassword = config.demoAccountPassword;

  if (!rawPassword) {
    // Generate high-entropy secure credential if not set in environment
    rawPassword = 'Raia_' + crypto.randomBytes(12).toString('base64url') + '#26';
  }

  let demoUser = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
  const { hash, salt } = hashPassword(rawPassword);

  if (!demoUser) {
    const nextMonth = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare(`
      INSERT INTO users (
        email, name, phone_number, password_hash, password_salt,
        plan_tier, subscription_status, paid_until, is_demo, role
      ) VALUES (?, ?, ?, ?, ?, 'JESSICA_PRO', 'ACTIVE', ?, 1, 'USER')
    `).run(
      email,
      'Homologação Hotmart (Bella Vista)',
      '5511999990000',
      hash,
      salt,
      nextMonth
    );
    demoUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    console.log(`[Demo Account] Conta de homologação criada: ${email}`);
  } else {
    // Keep credentials updated and ensure PRO
    db.prepare(`
      UPDATE users
      SET password_hash = ?,
          password_salt = ?,
          plan_tier = 'JESSICA_PRO',
          subscription_status = 'ACTIVE',
          is_demo = 1
      WHERE id = ?
    `).run(hash, salt, demoUser.id);
  }

  // Seed demo salon
  let demoSalon = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(demoUser.id);
  const demoHours = JSON.stringify({
    seg: { open: '09:00', close: '20:00', active: true },
    ter: { open: '09:00', close: '20:00', active: true },
    qua: { open: '09:00', close: '20:00', active: true },
    qui: { open: '09:00', close: '20:00', active: true },
    sex: { open: '09:00', close: '20:00', active: true },
    sab: { open: '09:00', close: '19:00', active: true },
    dom: { open: '10:00', close: '15:00', active: false },
  });

  if (!demoSalon) {
    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone, address, opening_hours, agent_custom_instructions, whatsapp_status)
      VALUES (?, ?, ?, ?, ?, ?, 'CONNECTED')
    `).run(
      demoUser.id,
      'Bella Vista Hair & Spa [DEMO ILUSTRATIVO]',
      '(11) 99999-0000',
      'Av. Paulista, 1000 - Bela Vista, São Paulo - SP',
      demoHours,
      'Oferecer café e cappuccino para clientes na recepção. Manter 10 minutos de intervalo entre químicas.'
    );
  } else {
    db.prepare(`
      UPDATE client_salons
      SET salon_name = 'Bella Vista Hair & Spa [DEMO ILUSTRATIVO]',
          phone = '(11) 99999-0000',
          address = 'Av. Paulista, 1000 - Bela Vista, São Paulo - SP',
          opening_hours = ?,
          whatsapp_status = 'CONNECTED'
      WHERE id = ?
    `).run(demoHours, demoSalon.id);
  }

  // Ensure demo services
  const svcCount = db.prepare('SELECT COUNT(*) as c FROM client_services WHERE user_id = ?').get(demoUser.id)?.c || 0;
  if (svcCount === 0) {
    const demoSvcs = [
      { name: 'Corte Feminino em Camadas', price: 95.0, duration: 60, cat: 'Cabelo' },
      { name: 'Corte Masculino Fade / Degradê', price: 55.0, duration: 40, cat: 'Cabelo' },
      { name: 'Mechas & Loiro Iluminado', price: 350.0, duration: 180, cat: 'Coloração' },
      { name: 'Escova Modelada com Tratamento', price: 75.0, duration: 45, cat: 'Cabelo' },
      { name: 'Manicure & Pedicure Completa', price: 70.0, duration: 60, cat: 'Unhas' },
      { name: 'Design & Micropigmentação de Sobrancelha', price: 120.0, duration: 60, cat: 'Estética' },
    ];
    for (const s of demoSvcs) {
      db.prepare(`
        INSERT INTO client_services (user_id, name, price, duration_min, category)
        VALUES (?, ?, ?, ?, ?)
      `).run(demoUser.id, s.name, s.price, s.duration, s.cat);
    }
  }

  // Ensure demo staff
  const staffCount = db.prepare('SELECT COUNT(*) as c FROM client_staff WHERE user_id = ?').get(demoUser.id)?.c || 0;
  if (staffCount === 0) {
    const demoStaff = [
      { name: 'Jéssica Ramos', specialty: 'Cortes & Visagismo' },
      { name: 'Camila Santos', specialty: 'Coloração & Mechas' },
      { name: 'Rafael Costa', specialty: 'Barbearia & Fade' },
    ];
    for (const st of demoStaff) {
      db.prepare(`
        INSERT INTO client_staff (user_id, name, specialty)
        VALUES (?, ?, ?)
      `).run(demoUser.id, st.name, st.specialty);
    }
  }

  // Ensure demo campaign (Pro)
  const campCount = db.prepare('SELECT COUNT(*) as c FROM client_campaigns WHERE user_id = ?').get(demoUser.id)?.c || 0;
  if (campCount === 0) {
    db.prepare(`
      INSERT INTO client_campaigns (user_id, title, message, target_audience, status, consent_confirmed, recipients_count)
      VALUES (?, ?, ?, ?, 'SENT', 1, 142)
    `).run(
      demoUser.id,
      'Campanha Quarta da Hidratação (Exemplo Demonstrativo)',
      '✨ Olá! A equipe do Bella Vista preparou um mimo especial: agendando seu corte nesta quarta, você ganha 20% OFF na hidratação profunda! Responda para reservar seu horário. (Responda SAIR para cancelar)',
      'Clientes com mais de 30 dias sem visitar'
    );
  }

  return demoUser;
}

module.exports = {
  hashPassword,
  verifyPassword,
  validateActivationToken,
  activateAccount,
  login,
  requestPasswordReset,
  resetPassword,
  ensureSalonForUser,
  getSanitizedUser,
  ensureDemoAccount,
};
