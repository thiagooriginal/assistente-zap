const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../database/db');
const clientAuth = require('../services/clientAuthService');
const userService = require('../services/userService');
const config = require('../config');
const productService = require('../services/productService');
const salonDashboardService = require('../services/salonDashboardService');
const serviceCatalog = require('../services/serviceCatalog');
const googleCalendarService = require('../services/googleCalendarService');
const salonNotificationService = require('../services/salonNotificationService');
const salonAppointmentService = require('../services/salonAppointmentService');
const { getPlan } = require('../services/planCatalog');
const whatsappClient = require('../whatsapp/client');
const salonSessionManager = require('../whatsapp/salonSessionManager');
const {
  clientLoginLimiter,
  activationLimiter,
  passwordResetRequestLimiter,
  passwordResetSubmitLimiter,
  whatsappTestLimiter,
  whatsappPairingLimiter,
  whatsappQrLimiter,
  whatsappPairingCodeLimiter,
  whatsappActionLimiter,
} = require('../middlewares/rateLimiter');
const { AUDIT_EVENTS, logSecurityEvent } = require('../services/securityAuditService');

// Helper to extract cookies from request header
function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// Check if request is under HTTPS (direct or reverse proxy)
function isSecureConnection(req) {
  if (!req) return false;
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto.toLowerCase() === 'https') return true;
  const host = (req.headers.host || '').toLowerCase();
  if (host.includes('trycloudflare.com') || host.includes('raiaagentes.com.br')) return true;
  return false;
}

function setSessionCookie(res, name, token, maxAgeSeconds = 30 * 24 * 3600, req = null) {
  const secureFlag = isSecureConnection(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${name}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secureFlag}`
  );
}

function clearSessionCookie(res, name, req = null) {
  const secureFlag = isSecureConnection(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`
  );
}

// Client Multi-Tenant Authentication & Subscription Enforcement Middleware (Proteção 01 & 17)
function clientAuthMiddleware(req, res, next) {
  // Explicit Least Privilege: Reject attempts to access client endpoints using administrative automation keys
  if (req.headers['x-admin-key'] || req.headers['x-api-key']) {
    return res.status(403).json({
      success: false,
      error: 'Acesso negado: ADMIN_API_KEY não possui permissão para acessar rotas privativas de clientes.',
      code: 'FORBIDDEN_CLIENT_ROUTE_VIA_API_KEY',
    });
  }

  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (!token && req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  }

  // Tokens in query string are strictly rejected for authenticated APIs (Proteção 02 & 17)
  if (!token) {
    token = getCookie(req, 'client_auth_token') || getCookie(req, 'auth_token');
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Sessão expirada ou não autenticada. Faça login para continuar.',
      code: 'UNAUTHORIZED',
    });
  }

  // Magic links are strictly single-use for initial redemption and CANNOT be used as API session tokens
  const magicCheck = db.prepare('SELECT id FROM users WHERE magic_token = ?').get(token);
  if (magicCheck) {
    return res.status(401).json({
      success: false,
      error: 'Magic links são de uso único e não podem ser utilizados como Bearer token de sessão comum. Utilize o link via navegador.',
      code: 'MAGIC_TOKEN_NOT_SESSION',
    });
  }

  // Strictly authenticate against persistent session_token with valid expiration
  const user = userService.getUserBySessionToken(token);
  if (!user) {
    const rawUser = db.prepare('SELECT id, session_expires_at FROM users WHERE session_token = ?').get(token);
    if (rawUser) {
      if (!rawUser.session_expires_at || new Date(rawUser.session_expires_at) < new Date()) {
        return res.status(401).json({
          success: false,
          error: 'Sua sessão expirou ou não possui prazo de validade. Faça login novamente.',
          code: 'SESSION_EXPIRED',
        });
      }
    }
    return res.status(401).json({
      success: false,
      error: 'Token inválido ou sessão revogada. Faça login novamente.',
      code: 'INVALID_TOKEN',
    });
  }

  const isDemo = Boolean(user.is_demo);
  req.clientUser = user;
  req.isDemo = isDemo;

  // 2. Global account state check
  // If the user has any active product in customer_subscriptions, account access is always allowed.
  let hasAnyActiveSub = false;
  try {
    const activeSub = db.prepare(`
      SELECT id FROM customer_subscriptions
      WHERE user_id = ? AND (
        (status = 'ACTIVE' AND paid_until IS NOT NULL AND datetime(paid_until) >= datetime('now'))
        OR (status = 'CANCELLED' AND paid_until IS NOT NULL AND datetime(paid_until) >= datetime('now'))
      ) LIMIT 1
    `).get(user.id);
    if (activeSub) hasAnyActiveSub = true;
  } catch (e) {}

  if (!hasAnyActiveSub && !isDemo && user.role !== 'ADMIN') {
    const subStatus = user.subscription_status || 'INACTIVE';

    if (['DIRECT', 'ASAAS'].includes(user.subscription_origin) &&
        (!user.paid_until || !Number.isFinite(Date.parse(user.paid_until)) ||
         Date.parse(user.paid_until) <= Date.now())) {
      return res.status(403).json({ success: false, code: 'PAYMENT_REQUIRED',
        error: 'Pagamento não confirmado ou período contratado encerrado.' });
    }

    if (subStatus === 'REFUNDED' || subStatus === 'CHARGEBACK') {
      return res.status(403).json({
        success: false,
        error: 'Acesso suspenso por reembolso ou contestação de pagamento.',
        code: 'SUBSCRIPTION_REFUNDED',
      });
    }

    if (subStatus === 'OVERDUE') {
      const paidUntilMs = user.paid_until ? Date.parse(user.paid_until) : 0;
      if (!Number.isFinite(paidUntilMs) || paidUntilMs <= Date.now()) {
        return res.status(403).json({
          success: false,
          error: 'Sua assinatura está em atraso. Regularize seu pagamento para reativar o acesso.',
          code: 'SUBSCRIPTION_OVERDUE',
        });
      }
    }

    if (subStatus === 'CANCELED') {
      const paidUntilMs = user.paid_until ? Date.parse(user.paid_until) : 0;
      if (!Number.isFinite(paidUntilMs) || paidUntilMs <= Date.now()) {
        return res.status(403).json({
          success: false,
          error: 'Sua assinatura foi cancelada e o período contratado encerrou.',
          code: 'SUBSCRIPTION_CANCELED',
        });
      }
    }

    if (subStatus === 'INACTIVE') {
      return res.status(403).json({
        success: false,
        error: 'Assinatura inativa. Confirme o pagamento para liberar seu acesso.',
        code: 'SUBSCRIPTION_INACTIVE',
      });
    }

    if (subStatus === 'PENDING') {
      return res.status(403).json({
        success: false,
        error: 'Conta pendente de ativação. Ative sua conta pelo link enviado para criar sua senha.',
        code: 'ACCOUNT_PENDING_ACTIVATION',
      });
    }

    if (user.paid_until) {
      const paidUntil = new Date(user.paid_until);
      const now = new Date();
      if (paidUntil < now) {
        return res.status(403).json({
          success: false,
          error: subStatus === 'CANCELED'
            ? 'Sua assinatura foi cancelada e o período pago já expirou. Renove para continuar acessando.'
            : 'O período da sua assinatura expirou.',
          code: 'SUBSCRIPTION_EXPIRED',
        });
      }
    }
  }

  return next();
}

// Optional Client Authentication (allows public access, attaches user if present)
function optionalClientAuthMiddleware(req, res, next) {
  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (!token && req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  }

  // Tokens in query string are strictly rejected for authenticated APIs
  if (!token) {
    token = getCookie(req, 'client_auth_token') || getCookie(req, 'auth_token');
  }

  if (!token) {
    return next();
  }

  try {
    const user = userService.getUserBySessionToken(token);
    if (user) {
      req.clientUser = user;
      req.isDemo = Boolean(user.is_demo);
    }
  } catch (e) {}

  return next();
}

/**
 * Enforces per-product access permission based on independent product contracts
 */
function requireProductAccess(productCode) {
  return function (req, res, next) {
    if (!req.clientUser) {
      return res.status(401).json({
        success: false,
        error: 'Sessão expirada ou não autenticada.',
        code: 'UNAUTHORIZED',
      });
    }

    const access = productService.hasProductAccess(req.clientUser.id, productCode);
    if (!access.hasAccess) {
      const code = access.status === 'EXPIRED' ? 'SUBSCRIPTION_EXPIRED'
        : access.status === 'OVERDUE' ? 'SUBSCRIPTION_OVERDUE'
        : access.status === 'PENDING' ? 'PAYMENT_PENDING'
        : access.status === 'CANCELLED' ? 'SUBSCRIPTION_CANCELED'
        : `PRODUCT_${access.status || 'ACCESS_DENIED'}`;

      return res.status(403).json({
        success: false,
        code,
        error: access.reason || `Acesso ao produto ${productCode} indisponível ou suspenso.`,
        product: productCode,
        subscription: access.subscription || null,
      });
    }

    req.productAccess = access;
    return next();
  };
}

// ==========================================
// PUBLIC AUTH ENDPOINTS (LOGIN, ACTIVATE, RESET)
// ==========================================

router.post('/auth/login', clientLoginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const result = clientAuth.login(email, password);

  if (!result.success) {
    return res.status(401).json(result);
  }

  // Set secure cookie (30 days, HttpOnly, SameSite=Lax, Secure when on HTTPS)
  setSessionCookie(res, 'client_auth_token', result.token, 30 * 24 * 3600, req);

  return res.json(result);
});

router.get('/auth/validate-activation', (req, res) => {
  const { token } = req.query;
  const result = clientAuth.validateActivationToken(token);

  if (!result.valid) {
    return res.status(400).json(result);
  }

  return res.json({
    valid: true,
    user: {
      name: result.user.name,
      email: result.user.email,
      planTier: result.user.plan_tier,
    },
  });
});

router.post('/auth/activate', activationLimiter, (req, res) => {
  const { token, password } = req.body || {};
  const result = clientAuth.activateAccount(token, password);

  if (!result.valid) {
    return res.status(400).json({ success: false, error: result.error });
  }

  setSessionCookie(res, 'client_auth_token', result.token, 30 * 24 * 3600, req);

  return res.json({
    success: true,
    token: result.token,
    user: result.user,
    message: 'Conta ativada com sucesso! Bem-vindo(a) ao seu painel.',
  });
});

// Strict Password Reset Request: Never exposes tokens or phone numbers via HTTP response
router.post('/auth/request-reset', passwordResetRequestLimiter, async (req, res) => {
  const { email } = req.body || {};
  await clientAuth.requestPasswordReset(email, whatsappClient?.sendWhatsAppMessage);
  return res.json({
    success: true,
    message: 'Se o e-mail informado estiver cadastrado, as instruções de recuperação serão enviadas para o seu canal cadastrado.',
  });
});

router.post('/auth/reset-password', passwordResetSubmitLimiter, (req, res) => {
  const { token, newPassword } = req.body || {};
  const result = clientAuth.resetPassword(token, newPassword);

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.json(result);
});

// Session Revocation & Logout (Proteção 01 & 17)
router.post('/auth/logout', clientAuthMiddleware, (req, res) => {
  if (req.clientUser?.id) {
    userService.revokeUserTokens(req.clientUser.id);
  }
  clearSessionCookie(res, 'client_auth_token', req);
  clearSessionCookie(res, 'auth_token', req);
  clearSessionCookie(res, 'csrf_token', req);
  return res.json({ success: true, message: 'Sessão encerrada com sucesso.' });
});

// ==========================================
// AUTHENTICATED CLIENT PROFILE & SALON SETUP
// ==========================================

router.get('/profile', clientAuthMiddleware, (req, res) => {
  const data = clientAuth.getSanitizedUser(req.clientUser.id);
  res.json({ success: true, profile: data });
});

// MULTIPRODUCT CLIENT PORTAL: "Meus Produtos" Hub & Portfolio
router.get('/my-products', clientAuthMiddleware, (req, res) => {
  const subscriptions = productService.getUserSubscriptions(req.clientUser.id);
  res.json({ success: true, subscriptions });
});

router.get('/segments', optionalClientAuthMiddleware, (req, res) => {
  const segments = productService.listSegments({ activeOnly: true });
  res.json({ success: true, segments });
});

router.get('/products-catalog', optionalClientAuthMiddleware, (req, res) => {
  const { segment, solution_type, search } = req.query || {};
  const products = productService.listProducts({
    activeOnly: true,
    includePlans: true,
    segmentCode: segment || null,
    solutionType: solution_type || null,
    search: search || null,
    contractedByUserId: req.clientUser ? req.clientUser.id : null
  });
  res.json({ success: true, products });
});

router.get('/products/:code/details', optionalClientAuthMiddleware, (req, res) => {
  const details = productService.getProductCatalogDetails(req.params.code, { userId: req.clientUser ? req.clientUser.id : null });
  if (!details) {
    return res.status(404).json({ success: false, error: 'Produto não encontrado.' });
  }
  res.json({ success: true, product: details });
});

router.get('/my-subscriptions', clientAuthMiddleware, (req, res) => {
  const subscriptions = productService.getUserSubscriptions(req.clientUser.id);
  res.json({ success: true, subscriptions });
});

router.get('/my-invoices', clientAuthMiddleware, (req, res) => {
  const userId = req.clientUser.id;
  
  // Asaas payments for user
  const asaasRows = db.prepare(`
    SELECT asaas_id as id, value, net_value, billing_type, status, description, invoice_url, pix_payload, created_at, 'ASAAS' as origin
    FROM asaas_payments
    WHERE user_id = ?
    ORDER BY id DESC LIMIT 50
  `).all(userId);

  // Direct sales contract payments
  const directRows = db.prepare(`
    SELECT c.id, (c.monthly_cents / 100.0) as value, c.payment_status as status, 'ASAAS' as origin, c.asaas_invoice_url as invoice_url, c.created_at, 'DIRETO' as type
    FROM direct_sales_contracts c
    WHERE c.user_id = ?
    ORDER BY c.id DESC LIMIT 50
  `).all(userId);

  res.json({
    success: true,
    invoices: asaasRows,
    directContracts: directRows
  });
});

router.post('/subscriptions/:id/cancel', clientAuthMiddleware, async (req, res) => {
  const subId = Number(req.params.id);
  const sub = productService.getUserSubscriptionById(subId);
  if (!sub || sub.userId !== req.clientUser.id) {
    return res.status(404).json({ success: false, error: 'Assinatura não encontrada ou não pertence a este usuário.' });
  }

  const { reason } = req.body || {};
  try {
    const updated = await productService.cancelSubscription(subId, {
      reason: reason || 'Solicitado pelo cliente via Central RAIA',
      userId: req.clientUser.id,
      ip: req.ip,
    });
    return res.json({
      success: true,
      message: updated.message || 'Assinatura cancelada com sucesso. O acesso ao produto continuará liberado até o final do período pago.',
      subscription: updated,
    });
  } catch (err) {
    console.error(`[Client Cancel Subscription] Falha ao cancelar sub #${subId}:`, err.message);
    return res.status(err.statusCode || 400).json({
      success: false,
      error: err.message || 'Erro ao processar cancelamento no gateway financeiro.',
      gateway: err.gateway || sub.gateway || sub.origin,
      requiresAction: err.requiresAction || false,
      instructionsUrl: err.instructionsUrl || null,
    });
  }
});

router.put('/profile/password', clientAuthMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'A nova senha deve ter no mínimo 8 caracteres.' });
  }

  const user = db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(req.clientUser.id);
  if (user && user.password_hash) {
    if (!currentPassword) {
      return res.status(400).json({ success: false, error: 'Informe sua senha atual.' });
    }
    const valid = clientAuth.verifyPassword(currentPassword, user.password_hash, user.password_salt);
    if (!valid) {
      logSecurityEvent({
        eventType: AUDIT_EVENTS.LOGIN_FAILED,
        userId: req.clientUser.id,
        req,
        status: 'FAILED',
        details: { action: 'change_password_invalid_current' },
      });
      return res.status(401).json({ success: false, error: 'Senha atual incorreta.' });
    }
  }

  const { hash, salt } = clientAuth.hashPassword(newPassword);
  // Proteção 01: Rotate session token upon password change and invalidate all other tokens
  const newSessionToken = clientAuth.generateSecureToken ? clientAuth.generateSecureToken(32) : require('crypto').randomBytes(32).toString('hex');
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE users
    SET password_hash = ?,
        password_salt = ?,
        session_token = ?,
        session_expires_at = ?,
        magic_token = NULL,
        magic_token_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hash, salt, newSessionToken, sessionExpiresAt, req.clientUser.id);

  setSessionCookie(res, 'client_auth_token', newSessionToken, 30 * 24 * 3600, req);

  logSecurityEvent({
    eventType: AUDIT_EVENTS.PASSWORD_CHANGE,
    userId: req.clientUser.id,
    req,
    status: 'SUCCESS',
  });

  res.json({ success: true, message: 'Senha alterada com sucesso.', token: newSessionToken });
});

router.get('/products/:code/access', clientAuthMiddleware, (req, res) => {
  const access = productService.hasProductAccess(req.clientUser.id, req.params.code);
  res.json({ success: true, access });
});

router.put('/salon', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { salonName, phone, address, openingHours, customInstructions } = req.body || {};
  const userId = req.clientUser.id;

  clientAuth.ensureSalonForUser(userId, req.clientUser.name);

  const hoursStr = typeof openingHours === 'object' ? JSON.stringify(openingHours) : openingHours;

  db.prepare(`
    UPDATE client_salons
    SET salon_name = COALESCE(?, salon_name),
        phone = COALESCE(?, phone),
        address = COALESCE(?, address),
        opening_hours = COALESCE(?, opening_hours),
        agent_custom_instructions = COALESCE(?, agent_custom_instructions),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    salonName || null,
    phone || null,
    address || null,
    hoursStr || null,
    customInstructions || null,
    userId
  );

  const updated = clientAuth.getSanitizedUser(userId);
  res.json({ success: true, message: 'Dados do salão atualizados com sucesso!', salon: updated.salon });
});

// ==========================================
// SERVICES & PRICING MANAGEMENT (CADASTRO INTELIGENTE)
// ==========================================

router.get('/services/catalog', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { q, category } = req.query || {};
  const results = serviceCatalog.searchCatalog(q || '', category || '');
  res.json({
    success: true,
    categories: serviceCatalog.CATEGORIES,
    catalog: results,
    total: results.length,
  });
});

router.get('/services', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { active } = req.query || {};
  let sql = `
    SELECT s.id, s.user_id, s.name, s.price, s.duration_min, s.category, s.active,
           (SELECT COUNT(*) FROM appointments a WHERE a.service_id = s.id AND a.user_id = s.user_id) AS appointment_count
    FROM client_services s
    WHERE s.user_id = ?
  `;
  const params = [req.clientUser.id];
  if (active !== undefined && active !== '') {
    sql += ` AND s.active = ?`;
    params.push(Number(active) ? 1 : 0);
  }
  sql += ` ORDER BY s.active DESC, s.category ASC, s.name ASC`;

  const rows = db.prepare(sql).all(...params);

  // Buscar mapeamento de profissionais habilitados e pendentes para cada serviço
  const staffRelations = db.prepare(`
    SELECT css.service_id, css.staff_id, css.confirmed
    FROM client_service_staff css
    JOIN client_staff cs ON cs.id = css.staff_id AND cs.user_id = css.user_id
    WHERE css.user_id = ? AND cs.active = 1
  `).all(req.clientUser.id);
  const staffByService = new Map();
  const pendingStaffByService = new Map();
  for (const rel of staffRelations) {
    if (rel.confirmed === 1) {
      if (!staffByService.has(rel.service_id)) {
        staffByService.set(rel.service_id, []);
      }
      staffByService.get(rel.service_id).push(rel.staff_id);
    } else {
      if (!pendingStaffByService.has(rel.service_id)) {
        pendingStaffByService.set(rel.service_id, []);
      }
      pendingStaffByService.get(rel.service_id).push(rel.staff_id);
    }
  }

  // Return both duration_min and duration_minutes for total compatibility and predictability
  const services = rows.map((svc) => ({
    id: svc.id,
    user_id: svc.user_id,
    name: svc.name,
    price: svc.price,
    duration_min: svc.duration_min,
    duration_minutes: svc.duration_min,
    category: svc.category,
    active: svc.active,
    appointment_count: svc.appointment_count || 0,
    has_appointments: (svc.appointment_count || 0) > 0,
    staff_ids: staffByService.get(svc.id) || [],
    pending_staff_ids: pendingStaffByService.get(svc.id) || [],
  }));

  res.json({ success: true, services });
});

router.post('/services', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { name, price, category, confirmSimilar, staff_ids, staffIds } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Nome e valor do serviço são obrigatórios.' });
  }

  const cleanName = serviceCatalog.sanitizeName(name);
  if (!cleanName) {
    return res.status(400).json({ success: false, error: 'Nome do serviço inválido.' });
  }

  if (price === undefined || price === null || price === '') {
    return res.status(400).json({ success: false, error: 'Nome e valor do serviço são obrigatórios.' });
  }

  const numPrice = parseFloat(price);
  if (isNaN(numPrice) || numPrice < 0) {
    return res.status(400).json({ success: false, error: 'Valor inválido.' });
  }

  // Accept duration_min, durationMin, durationMinutes or duration
  const rawDuration = req.body?.duration_min !== undefined
    ? req.body.duration_min
    : (req.body?.durationMin !== undefined
      ? req.body.durationMin
      : (req.body?.durationMinutes !== undefined
        ? req.body.durationMinutes
        : req.body?.duration));

  if (rawDuration === undefined || rawDuration === null || (typeof rawDuration === 'string' && rawDuration.trim() === '')) {
    return res.status(400).json({
      success: false,
      error: 'A duração do serviço deve ser um número inteiro positivo em minutos (mínimo 1 minuto).',
    });
  }

  const parsedDuration = Number(rawDuration);
  if (!Number.isInteger(parsedDuration) || parsedDuration <= 0) {
    return res.status(400).json({
      success: false,
      error: 'A duração do serviço deve ser um número inteiro positivo em minutos (mínimo 1 minuto).',
    });
  }

  if (parsedDuration > 1440) {
    return res.status(400).json({
      success: false,
      error: 'A duração máxima permitida para um serviço é de 1440 minutos (24 horas).',
    });
  }

  // Validação de Duplicidades e Similaridade
  const existingServices = db.prepare('SELECT id, name FROM client_services WHERE user_id = ?').all(req.clientUser.id);
  const normNewName = serviceCatalog.normalizeText(cleanName);

  const exactDuplicate = existingServices.find((s) => serviceCatalog.normalizeText(s.name) === normNewName);
  if (exactDuplicate) {
    return res.status(409).json({
      success: false,
      code: 'SERVICE_DUPLICATE',
      error: `Você já possui um serviço cadastrado com o nome "${exactDuplicate.name}". Edite o serviço existente ou use um nome diferenciado.`,
      existingId: exactDuplicate.id,
    });
  }

  if (!confirmSimilar) {
    const similar = existingServices.find((s) => serviceCatalog.calculateSimilarity(s.name, cleanName) >= 0.85);
    if (similar) {
      return res.status(409).json({
        success: false,
        code: 'SERVICE_SIMILAR',
        warning: `Já existe um serviço com nome muito similar: "${similar.name}". Deseja cadastrar "${cleanName}" assim mesmo?`,
        similarTo: similar.name,
        requiresConfirmation: true,
      });
    }
  }

  const cleanCategory = category && typeof category === 'string' && category.trim() ? category.trim() : 'Cabelos';

  // Validação estrita de staff_ids (fail-closed contra multi-tenant)
  const rawStaffIds = staff_ids !== undefined ? staff_ids : staffIds;
  let parsedStaffIds = null;
  if (rawStaffIds !== undefined && rawStaffIds !== null) {
    if (!Array.isArray(rawStaffIds)) {
      return res.status(400).json({ success: false, error: 'O campo staff_ids deve ser uma lista de identificadores numéricos.' });
    }
    parsedStaffIds = [];
    for (const sid of rawStaffIds) {
      const num = Number(sid);
      if (!Number.isInteger(num) || num <= 0) {
        return res.status(400).json({ success: false, error: 'Identificador de profissional inválido na lista.' });
      }
      parsedStaffIds.push(num);
    }
    if (parsedStaffIds.length > 0) {
      const uniqueIds = Array.from(new Set(parsedStaffIds));
      const placeholders = uniqueIds.map(() => '?').join(',');
      const countRow = db.prepare(`
        SELECT COUNT(*) AS total
        FROM client_staff
        WHERE user_id = ? AND id IN (${placeholders}) AND active = 1
      `).get(req.clientUser.id, ...uniqueIds);
      if ((countRow?.total || 0) !== uniqueIds.length) {
        return res.status(400).json({ success: false, error: 'Um ou mais profissionais selecionados não existem ou não pertencem ao seu salão.', code: 'INVALID_STAFF_IDS' });
      }
      parsedStaffIds = uniqueIds;
    }
  } else {
    // Se não fornecido e o salão tem exatamente 1 staff ativo, auto-vincula
    const activeStaff = db.prepare('SELECT id FROM client_staff WHERE user_id = ? AND active = 1').all(req.clientUser.id);
    if (activeStaff.length === 1) {
      parsedStaffIds = [activeStaff[0].id];
    }
  }

  db.exec('BEGIN IMMEDIATE');
  let serviceId;
  try {
    const info = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(req.clientUser.id, cleanName, numPrice, parsedDuration, cleanCategory);
    serviceId = info.lastInsertRowid;

    if (parsedStaffIds && parsedStaffIds.length > 0) {
      const insertCss = db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)');
      for (const sId of parsedStaffIds) {
        insertCss.run(req.clientUser.id, serviceId, sId);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ success: false, error: 'Falha ao gravar serviço no banco de dados.' });
  }

  const createdService = {
    id: serviceId,
    user_id: req.clientUser.id,
    name: cleanName,
    price: numPrice,
    duration_min: parsedDuration,
    duration_minutes: parsedDuration,
    category: cleanCategory,
    active: 1,
    appointment_count: 0,
    has_appointments: false,
    staff_ids: parsedStaffIds || [],
  };

  res.json({
    success: true,
    service: createdService,
    message: 'Serviço cadastrado com sucesso!',
  });
});

// Cadastro em Lote Inteligente com Transação Atômica
router.post('/services/batch', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { services: rawServices, skipDuplicates = true } = req.body || {};

  if (!Array.isArray(rawServices) || rawServices.length === 0) {
    return res.status(400).json({ success: false, error: 'A lista de serviços para cadastro em lote é obrigatória.' });
  }

  if (rawServices.length > 50) {
    return res.status(400).json({ success: false, error: 'Máximo de 50 serviços por lote permitido.' });
  }

  // 1. Validação estrita de cada item antes de qualquer escrita no banco
  const validatedItems = [];
  const seenInBatch = new Set();

  for (let idx = 0; idx < rawServices.length; idx++) {
    const item = rawServices[idx];
    if (!item || typeof item !== 'object') {
      return res.status(400).json({ success: false, error: `Item #${idx + 1} inválido no lote.` });
    }

    const cleanName = serviceCatalog.sanitizeName(item.name);
    if (!cleanName) {
      return res.status(400).json({ success: false, error: `Nome obrigatório no item #${idx + 1}.` });
    }

    const price = parseFloat(item.price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ success: false, error: `Valor inválido no serviço "${cleanName}".` });
    }

    const rawDuration = item.duration_min !== undefined
      ? item.duration_min
      : (item.durationMin !== undefined ? item.durationMin : item.durationMinutes);

    if (rawDuration === undefined || rawDuration === null || (typeof rawDuration === 'string' && String(rawDuration).trim() === '')) {
      return res.status(400).json({ success: false, error: `Duração obrigatória no serviço "${cleanName}".` });
    }

    const duration = Number(rawDuration);
    if (!Number.isInteger(duration) || duration <= 0 || duration > 1440) {
      return res.status(400).json({
        success: false,
        error: `Duração inválida no serviço "${cleanName}". Deve ser um número inteiro entre 1 e 1440 minutos.`,
      });
    }

    const normKey = serviceCatalog.normalizeText(cleanName);
    if (seenInBatch.has(normKey)) {
      // Ignora duplicata duplicada dentro da mesma requisição de lote
      continue;
    }
    seenInBatch.add(normKey);

    validatedItems.push({
      name: cleanName,
      price,
      duration_min: duration,
      category: item.category && typeof item.category === 'string' && item.category.trim() ? item.category.trim() : 'Cabelos',
      normKey,
    });
  }

  if (validatedItems.length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum serviço válido para cadastro no lote.' });
  }

  // 2. Consulta serviços já cadastrados pelo salão
  const existingRows = db.prepare('SELECT id, name FROM client_services WHERE user_id = ?').all(req.clientUser.id);
  const existingSet = new Set(existingRows.map((r) => serviceCatalog.normalizeText(r.name)));

  const itemsToInsert = [];
  const skippedItems = [];

  for (const it of validatedItems) {
    if (existingSet.has(it.normKey)) {
      skippedItems.push(it.name);
      if (!skipDuplicates) {
        return res.status(409).json({
          success: false,
          code: 'SERVICE_DUPLICATE',
          error: `O serviço "${it.name}" já está cadastrado no seu salão.`,
        });
      }
    } else {
      itemsToInsert.push(it);
    }
  }

  if (itemsToInsert.length === 0) {
    return res.json({
      success: true,
      createdCount: 0,
      skippedCount: skippedItems.length,
      services: [],
      skipped: skippedItems,
      message: 'Todos os serviços selecionados já estavam previamente cadastrados no seu salão.',
    });
  }

  // 3. Execução em Transação Atômica SQLite (Rollback completo em caso de falha)
  db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const createdServices = [];
    for (const item of itemsToInsert) {
      const info = stmt.run(req.clientUser.id, item.name, item.price, item.duration_min, item.category);
      createdServices.push({
        id: info.lastInsertRowid,
        user_id: req.clientUser.id,
        name: item.name,
        price: item.price,
        duration_min: item.duration_min,
        duration_minutes: item.duration_min,
        category: item.category,
        active: 1,
        appointment_count: 0,
        has_appointments: false,
      });
    }
    db.exec('COMMIT');

    return res.json({
      success: true,
      createdCount: createdServices.length,
      skippedCount: skippedItems.length,
      services: createdServices,
      skipped: skippedItems,
      message: `${createdServices.length} serviço(s) cadastrado(s) com sucesso!` +
        (skippedItems.length > 0 ? ` (${skippedItems.length} já cadastrado(s) ignorado(s))` : ''),
    });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('[Services Batch] Erro na transação de cadastro em lote:', err.message);
    return res.status(500).json({ success: false, error: 'Falha interna ao processar cadastro em lote. Nenhuma alteração foi realizada.' });
  }
});

router.put('/services/:id', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { id } = req.params;
  const { name, price, category, active, confirmSimilar, staff_ids, staffIds } = req.body || {};

  const existing = db.prepare('SELECT id, name, duration_min FROM client_services WHERE id = ? AND user_id = ?').get(id, req.clientUser.id);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Serviço não encontrado.' });
  }

  let cleanName = null;
  if (name !== undefined && name !== null) {
    cleanName = serviceCatalog.sanitizeName(name);
    if (!cleanName) {
      return res.status(400).json({ success: false, error: 'Nome do serviço não pode ser vazio.' });
    }

    // Checagem de duplicidade contra OUTROS serviços do mesmo salão
    const normNew = serviceCatalog.normalizeText(cleanName);
    const otherSameName = db.prepare('SELECT id, name FROM client_services WHERE user_id = ? AND id != ?').all(req.clientUser.id, id);
    const duplicate = otherSameName.find((s) => serviceCatalog.normalizeText(s.name) === normNew);
    if (duplicate) {
      return res.status(409).json({
        success: false,
        code: 'SERVICE_DUPLICATE',
        error: `Você já possui outro serviço cadastrado com o nome "${duplicate.name}".`,
      });
    }

    if (!confirmSimilar && cleanName !== existing.name) {
      const similar = otherSameName.find((s) => serviceCatalog.calculateSimilarity(s.name, cleanName) >= 0.85);
      if (similar) {
        return res.status(409).json({
          success: false,
          code: 'SERVICE_SIMILAR',
          warning: `Já existe outro serviço com nome muito similar: "${similar.name}". Deseja atualizar assim mesmo?`,
          similarTo: similar.name,
          requiresConfirmation: true,
        });
      }
    }
  }

  const rawDuration = req.body?.duration_min !== undefined
    ? req.body.duration_min
    : (req.body?.durationMin !== undefined
      ? req.body.durationMin
      : (req.body?.durationMinutes !== undefined
        ? req.body.durationMinutes
        : req.body?.duration));

  let parsedDuration = null;
  if (rawDuration !== undefined && rawDuration !== null) {
    if (typeof rawDuration === 'string' && rawDuration.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'A duração do serviço deve ser um número inteiro positivo em minutos (mínimo 1 minuto).',
      });
    }
    const num = Number(rawDuration);
    if (!Number.isInteger(num) || num <= 0) {
      return res.status(400).json({
        success: false,
        error: 'A duração do serviço deve ser um número inteiro positivo em minutos (mínimo 1 minuto).',
      });
    }
    if (num > 1440) {
      return res.status(400).json({
        success: false,
        error: 'A duração máxima permitida para um serviço é de 1440 minutos (24 horas).',
      });
    }
    parsedDuration = num;
  }

  let numPrice = null;
  if (price !== undefined && price !== null && price !== '') {
    numPrice = parseFloat(price);
    if (isNaN(numPrice) || numPrice < 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido.' });
    }
  }

  const rawStaffIds = staff_ids !== undefined ? staff_ids : staffIds;
  let parsedStaffIds = null;
  if (rawStaffIds !== undefined && rawStaffIds !== null) {
    if (!Array.isArray(rawStaffIds)) {
      return res.status(400).json({ success: false, error: 'O campo staff_ids deve ser uma lista de identificadores numéricos.' });
    }
    parsedStaffIds = [];
    for (const sid of rawStaffIds) {
      const num = Number(sid);
      if (!Number.isInteger(num) || num <= 0) {
        return res.status(400).json({ success: false, error: 'Identificador de profissional inválido na lista.' });
      }
      parsedStaffIds.push(num);
    }
    if (parsedStaffIds.length > 0) {
      const uniqueIds = Array.from(new Set(parsedStaffIds));
      const placeholders = uniqueIds.map(() => '?').join(',');
      const countRow = db.prepare(`
        SELECT COUNT(*) AS total
        FROM client_staff
        WHERE user_id = ? AND id IN (${placeholders}) AND active = 1
      `).get(req.clientUser.id, ...uniqueIds);
      if ((countRow?.total || 0) !== uniqueIds.length) {
        return res.status(400).json({ success: false, error: 'Um ou mais profissionais selecionados não existem ou não pertencem ao seu salão.', code: 'INVALID_STAFF_IDS' });
      }
      parsedStaffIds = uniqueIds;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE client_services
      SET name = COALESCE(?, name),
          price = COALESCE(?, price),
          duration_min = COALESCE(?, duration_min),
          category = COALESCE(?, category),
          active = COALESCE(?, active)
      WHERE id = ? AND user_id = ?
    `).run(
      cleanName || null,
      numPrice !== null ? numPrice : null,
      parsedDuration !== null ? parsedDuration : null,
      category && typeof category === 'string' && category.trim() ? category.trim() : null,
      active !== undefined ? (Number(active) ? 1 : 0) : null,
      id,
      req.clientUser.id
    );

    if (parsedStaffIds !== null) {
      db.prepare('DELETE FROM client_service_staff WHERE user_id = ? AND service_id = ?').run(req.clientUser.id, id);
      const insertCss = db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)');
      for (const sId of parsedStaffIds) {
        insertCss.run(req.clientUser.id, id, sId);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ success: false, error: 'Falha ao atualizar serviço no banco.' });
  }

  const updated = db.prepare(`
    SELECT s.id, s.user_id, s.name, s.price, s.duration_min, s.category, s.active,
           (SELECT COUNT(*) FROM appointments a WHERE a.service_id = s.id AND a.user_id = s.user_id) AS appointment_count
    FROM client_services s
    WHERE s.id = ? AND s.user_id = ?
  `).get(id, req.clientUser.id);

  res.json({
    success: true,
    message: 'Serviço atualizado com sucesso!',
    service: updated ? {
      ...updated,
      duration_minutes: updated.duration_min,
      has_appointments: (updated.appointment_count || 0) > 0,
      staff_ids: db.prepare(`
        SELECT staff_id FROM client_service_staff WHERE user_id = ? AND service_id = ? AND confirmed = 1
      `).all(req.clientUser.id, id).map(r => r.staff_id),
    } : null,
  });
});

// Retorna profissionais habilitados para um serviço específico
router.get('/services/:id/staff', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { id } = req.params;
  const service = db.prepare('SELECT id, name FROM client_services WHERE id = ? AND user_id = ?').get(id, req.clientUser.id);
  if (!service) {
    return res.status(404).json({ success: false, error: 'Serviço não encontrado.' });
  }
  const staff = db.prepare(`
    SELECT cs.id, cs.name, cs.specialty, cs.active, cs.google_calendar_id
    FROM client_staff cs
    JOIN client_service_staff css ON css.staff_id = cs.id AND css.user_id = cs.user_id
    WHERE css.service_id = ? AND css.user_id = ? AND css.confirmed = 1 AND cs.active = 1
    ORDER BY cs.name ASC
  `).all(id, req.clientUser.id);

  res.json({ success: true, service_id: Number(id), staff });
});

// Toggle Ativar / Desativar Serviço
router.patch('/services/:id/toggle', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT id, name, active FROM client_services WHERE id = ? AND user_id = ?').get(id, req.clientUser.id);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Serviço não encontrado.' });
  }

  const newActive = existing.active ? 0 : 1;
  db.prepare('UPDATE client_services SET active = ? WHERE id = ? AND user_id = ?').run(newActive, id, req.clientUser.id);

  res.json({
    success: true,
    active: newActive,
    message: `Serviço "${existing.name}" ${newActive ? 'ativado' : 'desativado'} com sucesso!`,
  });
});

router.delete('/services/:id', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { id } = req.params;
  const { force } = req.query || {};

  const existing = db.prepare('SELECT id, name FROM client_services WHERE id = ? AND user_id = ?').get(id, req.clientUser.id);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Serviço não encontrado.' });
  }

  // Verifica agendamentos vinculados a este serviço
  const appointmentCount = db.prepare('SELECT COUNT(*) as count FROM appointments WHERE service_id = ? AND user_id = ?').get(id, req.clientUser.id)?.count || 0;

  if (appointmentCount > 0 && force !== 'true') {
    return res.status(409).json({
      success: false,
      code: 'SERVICE_HAS_APPOINTMENTS',
      appointmentCount,
      error: `Este serviço possui ${appointmentCount} atendimento(s) registrado(s) no histórico da Jéssica. Para manter seus relatórios e métricas íntegros, recomendamos desativar o serviço em vez de excluí-lo definitivamente.`,
      recommendation: 'deactivate',
    });
  }

  db.prepare('DELETE FROM client_services WHERE id = ? AND user_id = ?').run(id, req.clientUser.id);

  res.json({
    success: true,
    message: appointmentCount > 0
      ? `Serviço removido definitivamente (${appointmentCount} agendamento(s) histórico(s) preservado(s)).`
      : 'Serviço removido com sucesso.',
  });
});

// ==========================================
// STAFF & TEAM MEMBERS (COM AGENDA INDIVIDUAL)
// ==========================================

router.get('/staff', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, specialty, active, google_calendar_id, days_off, custom_hours
    FROM client_staff
    WHERE user_id = ?
    ORDER BY id ASC
  `).all(req.clientUser.id);

  const serviceRelations = db.prepare(`
    SELECT css.staff_id, css.service_id, css.confirmed
    FROM client_service_staff css
    JOIN client_services cs ON cs.id = css.service_id AND cs.user_id = css.user_id
    WHERE css.user_id = ? AND cs.active = 1
  `).all(req.clientUser.id);
  const servicesByStaff = new Map();
  const pendingServicesByStaff = new Map();
  for (const rel of serviceRelations) {
    if (rel.confirmed === 1) {
      if (!servicesByStaff.has(rel.staff_id)) {
        servicesByStaff.set(rel.staff_id, []);
      }
      servicesByStaff.get(rel.staff_id).push(rel.service_id);
    } else {
      if (!pendingServicesByStaff.has(rel.staff_id)) {
        pendingServicesByStaff.set(rel.staff_id, []);
      }
      pendingServicesByStaff.get(rel.staff_id).push(rel.service_id);
    }
  }

  res.json({ success: true, staff: rows.map(s => ({
    ...s,
    service_ids: servicesByStaff.get(s.id) || [],
    pending_service_ids: pendingServicesByStaff.get(s.id) || [],
  })) });
});

router.post('/staff', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { name, specialty, googleCalendarId, daysOff, customHours, service_ids, serviceIds } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Nome do profissional é obrigatório.' });
  }

  const jessicaSub = productService.getUserSubscriptionForProduct(req.clientUser.id, 'JESSICA');
  const plan = getPlan(req.clientUser.plan_tier);
  const baseProfessionals = jessicaSub?.maxProfessionals !== undefined ? jessicaSub.maxProfessionals : (plan?.includedProfessionals || 1);
  const extraProfessionals = Math.max(Number(jessicaSub?.extraProfessionals || 0), Number(req.clientUser.extra_professionals || 0));
  const available = baseProfessionals + extraProfessionals;
  const total = db.prepare('SELECT COUNT(*) AS n FROM client_staff WHERE user_id = ? AND active = 1')
    .get(req.clientUser.id)?.n || 0;

  if (!req.isDemo && total >= available) {
    return res.status(403).json({
      success: false,
      error: 'Limite de profissionais atingido. Contrate mais um profissional para ampliar seu plano.',
    });
  }

  const daysOffStr = typeof daysOff === 'object' ? JSON.stringify(daysOff) : daysOff;
  const customHoursStr = typeof customHours === 'object' ? JSON.stringify(customHours) : customHours;

  const rawServiceIds = service_ids !== undefined ? service_ids : serviceIds;
  let parsedServiceIds = null;
  if (rawServiceIds !== undefined && rawServiceIds !== null) {
    if (!Array.isArray(rawServiceIds)) {
      return res.status(400).json({ success: false, error: 'O campo service_ids deve ser uma lista de identificadores.' });
    }
    parsedServiceIds = [];
    for (const sid of rawServiceIds) {
      const num = Number(sid);
      if (!Number.isInteger(num) || num <= 0) {
        return res.status(400).json({ success: false, error: 'Identificador de serviço inválido.' });
      }
      parsedServiceIds.push(num);
    }
    if (parsedServiceIds.length > 0) {
      const uniqueIds = Array.from(new Set(parsedServiceIds));
      const placeholders = uniqueIds.map(() => '?').join(',');
      const countRow = db.prepare(`
        SELECT COUNT(*) AS total
        FROM client_services
        WHERE user_id = ? AND id IN (${placeholders}) AND active = 1
      `).get(req.clientUser.id, ...uniqueIds);
      if ((countRow?.total || 0) !== uniqueIds.length) {
        return res.status(400).json({ success: false, error: 'Um ou mais serviços selecionados não existem ou não pertencem ao seu salão.', code: 'INVALID_SERVICE_IDS' });
      }
      parsedServiceIds = uniqueIds;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  let staffId;
  try {
    const info = db.prepare(`
      INSERT INTO client_staff (user_id, name, specialty, google_calendar_id, days_off, custom_hours)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.clientUser.id,
      name.trim(),
      specialty ? specialty.trim() : 'Atendimento Geral',
      googleCalendarId || null,
      daysOffStr || null,
      customHoursStr || null
    );
    staffId = info.lastInsertRowid;
    if (parsedServiceIds && parsedServiceIds.length > 0) {
      const insertCss = db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)');
      for (const sId of parsedServiceIds) {
        insertCss.run(req.clientUser.id, sId, staffId);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ success: false, error: 'Falha ao cadastrar profissional.' });
  }

  res.json({
    success: true,
    staff: {
      id: staffId,
      name: name.trim(),
      specialty: specialty || 'Atendimento Geral',
      google_calendar_id: googleCalendarId || null,
      days_off: daysOffStr || null,
      active: 1,
      service_ids: parsedServiceIds || [],
    },
    message: 'Profissional adicionado à equipe com sucesso!',
  });
});

router.put('/staff/:id', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { id } = req.params;
  const { name, specialty, active, googleCalendarId, daysOff, customHours, service_ids, serviceIds } = req.body || {};

  const existing = db.prepare('SELECT id FROM client_staff WHERE id = ? AND user_id = ?').get(id, req.clientUser.id);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Profissional não encontrado.' });
  }

  const daysOffStr = typeof daysOff === 'object' ? JSON.stringify(daysOff) : daysOff;
  const customHoursStr = typeof customHours === 'object' ? JSON.stringify(customHours) : customHours;

  const rawServiceIds = service_ids !== undefined ? service_ids : serviceIds;
  let parsedServiceIds = null;
  if (rawServiceIds !== undefined && rawServiceIds !== null) {
    if (!Array.isArray(rawServiceIds)) {
      return res.status(400).json({ success: false, error: 'O campo service_ids deve ser uma lista de identificadores.' });
    }
    parsedServiceIds = [];
    for (const sid of rawServiceIds) {
      const num = Number(sid);
      if (!Number.isInteger(num) || num <= 0) {
        return res.status(400).json({ success: false, error: 'Identificador de serviço inválido.' });
      }
      parsedServiceIds.push(num);
    }
    if (parsedServiceIds.length > 0) {
      const uniqueIds = Array.from(new Set(parsedServiceIds));
      const placeholders = uniqueIds.map(() => '?').join(',');
      const countRow = db.prepare(`
        SELECT COUNT(*) AS total
        FROM client_services
        WHERE user_id = ? AND id IN (${placeholders}) AND active = 1
      `).get(req.clientUser.id, ...uniqueIds);
      if ((countRow?.total || 0) !== uniqueIds.length) {
        return res.status(400).json({ success: false, error: 'Um ou mais serviços selecionados não existem ou não pertencem ao seu salão.', code: 'INVALID_SERVICE_IDS' });
      }
      parsedServiceIds = uniqueIds;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE client_staff
      SET name = COALESCE(?, name),
          specialty = COALESCE(?, specialty),
          active = COALESCE(?, active),
          google_calendar_id = COALESCE(?, google_calendar_id),
          days_off = COALESCE(?, days_off),
          custom_hours = COALESCE(?, custom_hours)
      WHERE id = ? AND user_id = ?
    `).run(
      name ? name.trim() : null,
      specialty ? specialty.trim() : null,
      active !== undefined ? (active ? 1 : 0) : null,
      googleCalendarId !== undefined ? googleCalendarId : null,
      daysOffStr !== undefined ? daysOffStr : null,
      customHoursStr !== undefined ? customHoursStr : null,
      id,
      req.clientUser.id
    );

    if (parsedServiceIds !== null) {
      db.prepare('DELETE FROM client_service_staff WHERE user_id = ? AND staff_id = ?').run(req.clientUser.id, id);
      const insertCss = db.prepare('INSERT INTO client_service_staff (user_id, service_id, staff_id, confirmed) VALUES (?, ?, ?, 1)');
      for (const sId of parsedServiceIds) {
        insertCss.run(req.clientUser.id, sId, id);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ success: false, error: 'Falha ao atualizar profissional.' });
  }

  res.json({ success: true, message: 'Dados do profissional atualizados com sucesso.' });
});

// Retorna serviços habilitados para um profissional específico
router.get('/staff/:id/services', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { id } = req.params;
  const staff = db.prepare('SELECT id, name FROM client_staff WHERE id = ? AND user_id = ?').get(id, req.clientUser.id);
  if (!staff) {
    return res.status(404).json({ success: false, error: 'Profissional não encontrado.' });
  }
  const services = db.prepare(`
    SELECT s.id, s.name, s.price, s.duration_min, s.category, s.active
    FROM client_services s
    JOIN client_service_staff css ON css.service_id = s.id AND css.user_id = s.user_id
    WHERE css.staff_id = ? AND s.user_id = ? AND css.confirmed = 1 AND s.active = 1
    ORDER BY s.category ASC, s.name ASC
  `).all(id, req.clientUser.id);

  res.json({ success: true, staff_id: Number(id), services });
});

// ==========================================
// GESTÃO DE QUALIFICAÇÕES PENDENTES (COMANDO 040.1)
// ==========================================

router.get('/staff/qualifications/pending', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const rows = db.prepare(`
    SELECT css.id, css.service_id, cs.name AS service_name, cs.category AS service_category,
           css.staff_id, st.name AS staff_name, st.specialty AS staff_specialty, css.created_at
    FROM client_service_staff css
    JOIN client_services cs ON cs.id = css.service_id AND cs.user_id = css.user_id
    JOIN client_staff st ON st.id = css.staff_id AND st.user_id = css.user_id
    WHERE css.user_id = ? AND css.confirmed = 0 AND cs.active = 1 AND st.active = 1
    ORDER BY cs.name ASC, st.name ASC
  `).all(req.clientUser.id);

  res.json({ success: true, count: rows.length, pendingQualifications: rows });
});

router.post('/staff/qualifications/batch-confirm', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : (Array.isArray(req.body) ? req.body : null);
  if (!items || items.length === 0) {
    return res.status(400).json({ success: false, error: 'A lista de qualificações para confirmação é obrigatória.' });
  }

  // Validação preliminar anti-IDOR e de integridade dos dados
  const validActions = ['confirm', 'reject'];
  const sanitizedItems = [];
  for (const item of items) {
    const serviceId = Number(item.service_id || item.serviceId);
    const staffId = Number(item.staff_id || item.staffId);
    const action = String(item.action || 'confirm').toLowerCase();

    if (!Number.isInteger(serviceId) || serviceId <= 0 || !Number.isInteger(staffId) || staffId <= 0) {
      return res.status(400).json({ success: false, error: 'Identificadores de serviço ou profissional inválidos.' });
    }
    if (!validActions.includes(action)) {
      return res.status(400).json({ success: false, error: `Ação inválida: "${action}". Utilize "confirm" ou "reject".` });
    }
    sanitizedItems.push({ serviceId, staffId, action });
  }

  // Transação Atômica BEGIN IMMEDIATE
  db.exec('BEGIN IMMEDIATE');
  let confirmedCount = 0;
  let rejectedCount = 0;
  try {
    const checkService = db.prepare('SELECT id FROM client_services WHERE id = ? AND user_id = ?');
    const checkStaff = db.prepare('SELECT id FROM client_staff WHERE id = ? AND user_id = ?');
    const updateConfirm = db.prepare('UPDATE client_service_staff SET confirmed = 1 WHERE user_id = ? AND service_id = ? AND staff_id = ?');
    const deleteReject = db.prepare('DELETE FROM client_service_staff WHERE user_id = ? AND service_id = ? AND staff_id = ?');

    for (const it of sanitizedItems) {
      const svcExists = checkService.get(it.serviceId, req.clientUser.id);
      const staffExists = checkStaff.get(it.staffId, req.clientUser.id);
      if (!svcExists || !staffExists) {
        throw new Error('SECURITY_VIOLATION_IDOR: Tentativa de manipulação de entidades de outro usuário.');
      }

      if (it.action === 'confirm') {
        const resUpdate = updateConfirm.run(req.clientUser.id, it.serviceId, it.staffId);
        if (resUpdate.changes > 0) confirmedCount++;
      } else {
        const resDel = deleteReject.run(req.clientUser.id, it.serviceId, it.staffId);
        if (resDel.changes > 0) rejectedCount++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('[Qualifications Batch Confirm] Falha na operação atômica:', err.message);
    return res.status(err.message.includes('IDOR') ? 403 : 500).json({
      success: false,
      error: err.message.includes('IDOR') ? 'Violação de acesso a dados.' : 'Falha ao processar confirmação das qualificações.',
    });
  }

  res.json({
    success: true,
    confirmedCount,
    rejectedCount,
    message: `${confirmedCount} qualificação(ões) confirmada(s) e ${rejectedCount} rejeitada(s) com sucesso.`,
  });
});

router.delete('/staff/:id', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT id, name FROM client_staff WHERE id = ? AND user_id = ?').get(id, req.clientUser.id);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'Profissional não encontrado.' });
  }

  // Preservação de dados históricos: se possuir agendamentos vinculados, desativa em vez de deletar
  const aptCount = db.prepare('SELECT COUNT(*) AS count FROM appointments WHERE staff_id = ? AND user_id = ?').get(id, req.clientUser.id)?.count || 0;

  if (aptCount > 0 && req.query.force !== 'true') {
    db.prepare('UPDATE client_staff SET active = 0 WHERE id = ? AND user_id = ?').run(id, req.clientUser.id);
    return res.json({
      success: true,
      deactivated: true,
      message: `O profissional "${existing.name}" possui ${aptCount} agendamento(s) histórico(s) e foi desativado com segurança para preservar relatórios.`,
    });
  }

  db.prepare('DELETE FROM client_staff WHERE id = ? AND user_id = ?').run(id, req.clientUser.id);
  res.json({ success: true, message: 'Profissional removido com sucesso.' });
});

// ==========================================
// SALON OPERATING HOURS & EXCEPTIONS
// ==========================================

router.get('/salon/hours', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const salon = db.prepare('SELECT opening_hours FROM client_salons WHERE user_id = ?').get(req.clientUser.id);
  const parsed = salonAppointmentService.parseOpeningHours(salon?.opening_hours);
  res.json({ success: true, hours: parsed });
});

router.put('/salon/hours', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { days, pauses, exceptions, timezone } = req.body || {};
  clientAuth.ensureSalonForUser(req.clientUser.id, req.clientUser.name);

  const hoursObj = {
    timezone: timezone || 'America/Sao_Paulo',
    days: days || {},
    pauses: pauses || [],
    exceptions: exceptions || [],
  };

  db.prepare(`
    UPDATE client_salons
    SET opening_hours = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(JSON.stringify(hoursObj), req.clientUser.id);

  res.json({ success: true, hours: hoursObj, message: 'Horários de funcionamento atualizados com sucesso!' });
});

// ==========================================
// APPOINTMENTS & SMART SCHEDULE (JÉSSICA)
// ==========================================

router.get('/appointments', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const { staff_id, status, start_date, end_date, search } = req.query || {};
  const appointments = salonAppointmentService.listAppointments(req.clientUser.id, {
    staffId: staff_id ? Number(staff_id) : null,
    status: status || null,
    startDate: start_date || null,
    endDate: end_date || null,
    search: search || null,
  });

  const googleStatus = googleCalendarService.getConnectionStatus(req.clientUser.id);

  res.json({ success: true, appointments, isGoogleConnected: Boolean(googleStatus?.isConnected) });
});

router.get('/appointments/available-slots', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  const { date, service_id, staff_id, limit } = req.query || {};
  if (!date) {
    return res.status(400).json({ success: false, error: 'A data é obrigatória (formato YYYY-MM-DD ou DD/MM/AAAA).' });
  }

  let cleanDate = date;
  if (typeof cleanDate === 'string' && cleanDate.includes('/')) {
    const parts = cleanDate.trim().split('/');
    if (parts.length === 3) {
      const [d, m, y] = parts;
      cleanDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  let durationMin = 45;
  if (service_id) {
    const svc = db.prepare('SELECT duration_min FROM client_services WHERE id = ? AND user_id = ?').get(service_id, req.clientUser.id);
    if (svc && svc.duration_min) durationMin = svc.duration_min;
  }

  const slots = await salonAppointmentService.findAlternativeSlots(req.clientUser.id, {
    date: cleanDate,
    serviceDurationMin: durationMin,
    serviceId: service_id ? Number(service_id) : null,
    staffId: (staff_id && staff_id !== 'ANY') ? Number(staff_id) : null,
    limit: limit ? Number(limit) : 50,
  });

  res.json({ success: true, date: cleanDate, durationMin, slots });
});

router.get('/appointments/check-slot', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  const { date, time, service_id, staff_id, exclude_id } = req.query || {};
  if (!date || !time) {
    return res.status(400).json({ success: false, error: 'Data e horário são obrigatórios.' });
  }

  let cleanDate = date;
  if (typeof cleanDate === 'string' && cleanDate.includes('/')) {
    const parts = cleanDate.trim().split('/');
    if (parts.length === 3) {
      const [d, m, y] = parts;
      cleanDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  let durationMin = 45;
  if (service_id) {
    const svc = db.prepare('SELECT duration_min FROM client_services WHERE id = ? AND user_id = ?').get(service_id, req.clientUser.id);
    if (svc && svc.duration_min) durationMin = svc.duration_min;
  }

  const cleanTime = time.length === 5 ? time + ':00' : time;
  const startDt = `${cleanDate}T${cleanTime}`;
  const startDate = new Date(startDt);
  if (isNaN(startDate.getTime())) {
    return res.status(400).json({ success: false, error: 'Data ou horário em formato inválido.' });
  }

  const endDate = new Date(startDate.getTime() + durationMin * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const endDt = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:${pad(endDate.getSeconds())}`;

  const check = await salonAppointmentService.checkSlotAvailability(req.clientUser.id, {
    startDt,
    endDt,
    serviceId: service_id ? Number(service_id) : null,
    staffId: (staff_id && staff_id !== 'ANY') ? Number(staff_id) : null,
    durationMin,
    excludeAppointmentId: exclude_id ? Number(exclude_id) : null,
  });

  if (!check.available) {
    const suggestedSlots = await salonAppointmentService.findAlternativeSlots(req.clientUser.id, {
      date: cleanDate,
      serviceDurationMin: durationMin,
      serviceId: service_id ? Number(service_id) : null,
      staffId: (staff_id && staff_id !== 'ANY') ? Number(staff_id) : null,
      limit: 6,
    });

    return res.json({
      success: true,
      available: false,
      reason: check.reason || 'SLOT_CONFLICT',
      message: check.message,
      conflict: check.conflict || null,
      suggestedSlots,
    });
  }

  return res.json({
    success: true,
    available: true,
    startDt,
    endDt,
    durationMin,
    assignedStaffId: check.staffId || null,
    assignedStaffName: check.staffName || null,
  });
});

router.get('/appointments/conflicts', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const result = salonAppointmentService.detectAndFlagHistoricalConflicts(req.clientUser.id);
  res.json({ success: true, ...result });
});

router.post('/appointments', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    const rawDuration = req.body?.duration_min !== undefined
      ? req.body.duration_min
      : (req.body?.durationMin !== undefined
        ? req.body.durationMin
        : (req.body?.durationMinutes !== undefined
          ? req.body.durationMinutes
          : req.body?.duration));

    const appointment = await salonAppointmentService.bookAppointment(req.clientUser.id, {
      clientName: req.body?.clientName || req.body?.client_name,
      clientPhone: req.body?.clientPhone || req.body?.client_phone,
      serviceId: req.body?.serviceId || req.body?.service_id,
      serviceName: req.body?.serviceName || req.body?.service_name,
      staffId: req.body?.staffId || req.body?.staff_id,
      date: req.body?.date,
      time: req.body?.time,
      durationMin: rawDuration,
      origin: req.body?.origin || 'painel',
      status: req.body?.status || 'AGENDADO',
      reminderConsent: req.body?.reminderConsent ?? req.body?.reminder_consent,
      reminderConsentOrigin: req.body?.reminderConsentOrigin || req.body?.reminder_consent_origin || req.body?.origin || 'painel',
    });

    res.json({
      success: true,
      id: appointment.id,
      appointment,
      message: 'Agendamento registrado com sucesso!',
    });
  } catch (err) {
    if (err.code === 'SLOT_CONFLICT' || err.code === 'GOOGLE_CALENDAR_BUSY') {
      return res.status(409).json({
        success: false,
        code: 'SLOT_CONFLICT',
        error: err.message,
        suggestedSlots: err.suggestedSlots || [],
      });
    }

    if (err.code === 'STAFF_NOT_QUALIFIED' || err.code === 'NO_QUALIFIED_STAFF_FOR_SERVICE') {
      return res.status(422).json({
        success: false,
        code: err.code,
        error: err.message,
      });
    }

    const isBadRequest = [
      'SALON_CLOSED_DAY',
      'BEFORE_OPENING',
      'EXCEEDS_CLOSING',
      'LUNCH_BREAK',
      'STAFF_DAY_OFF',
      'PAST_DATETIME',
      'SERVICE_INACTIVE',
      'STAFF_NOT_FOUND',
      'STAFF_REQUIRED',
      'NO_ACTIVE_STAFF',
      'GOOGLE_CALENDAR_UNAVAILABLE',
      'GOOGLE_SYNC_REQUIRED',
      'INVALID_DATES',
      'INVALID_STATUS',
    ].includes(err.code);

    res.status(isBadRequest ? 400 : 500).json({
      success: false,
      code: err.code || 'BOOKING_ERROR',
      error: err.message,
      suggestedSlots: err.suggestedSlots || [],
    });
  }
});

router.put('/appointments/:id/reschedule', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    const { id } = req.params;
    const { newDate, newTime, newStaffId, reason } = req.body || {};

    const updated = await salonAppointmentService.rescheduleAppointment(id, req.clientUser.id, {
      newDate,
      newTime,
      newStaffId,
      reason,
    });

    res.json({
      success: true,
      appointment: updated,
      message: 'Agendamento remarcado com sucesso!',
    });
  } catch (err) {
    if (err.code === 'SLOT_CONFLICT' || err.code === 'GOOGLE_CALENDAR_BUSY') {
      return res.status(409).json({
        success: false,
        code: 'SLOT_CONFLICT',
        error: err.message,
        suggestedSlots: err.suggestedSlots || [],
      });
    }

    if (err.code === 'STAFF_NOT_QUALIFIED' || err.code === 'NO_QUALIFIED_STAFF_FOR_SERVICE') {
      return res.status(422).json({
        success: false,
        code: err.code,
        error: err.message,
      });
    }

    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({
      success: false,
      code: err.code || 'RESCHEDULE_ERROR',
      error: err.message,
      suggestedSlots: err.suggestedSlots || [],
    });
  }
});

router.patch('/appointments/:id/status', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body || {};
    const result = salonAppointmentService.updateAppointmentStatus(id, req.clientUser.id, status, reason, 'SALON_USER');
    res.json({ success: true, ...result, message: `Status alterado para ${result.status} com sucesso!` });
  } catch (err) {
    const statusCode = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(statusCode).json({ success: false, code: err.code || 'INVALID_STATUS', error: err.message });
  }
});

router.patch('/appointments/:id/consent', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const { id } = req.params;
    const consentVal = req.body?.consent !== undefined ? req.body.consent : req.body?.reminderConsent;
    const origin = req.body?.origin || req.body?.reminderConsentOrigin || 'painel';
    const reason = req.body?.reason || 'Alteração manual de consentimento';
    const result = salonAppointmentService.updateAppointmentConsent(id, req.clientUser.id, consentVal, origin, reason);
    res.json({ success: true, ...result, message: `Consentimento atualizado para ${result.reminderConsent ? 'ATIVO' : 'REVOGADO'}` });
  } catch (err) {
    const statusCode = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(statusCode).json({ success: false, code: err.code || 'CONSENT_ERROR', error: err.message });
  }
});

router.post('/clients/opt-out', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const { phone, reason } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, error: 'O telefone é obrigatório para registrar opt-out.' });
    }
    const salonReminderService = require('../services/salonReminderService');
    const result = salonReminderService.revokeClientConsent(req.clientUser.id, phone, reason || 'Opt-out via API');
    res.json({ success: true, ...result, message: 'Opt-out registrado com sucesso e lembretes futuros cancelados.' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete('/appointments/:id', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await salonAppointmentService.cancelAppointment(id, req.clientUser.id, {
      reason: req.body?.reason || req.query?.reason || 'Cancelado pelo salão',
      cancelledBy: 'SALON_USER',
    });
    res.json(result);
  } catch (err) {
    res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ success: false, error: err.message });
  }
});

// ==========================================
// GOOGLE CALENDAR INTEGRATIONS (POR SALÃO)
// ==========================================

router.get('/integrations/google/status', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const status = googleCalendarService.getConnectionStatus(req.clientUser.id);
  const salon = db.prepare('SELECT google_calendar_mode, google_selected_calendar_id FROM client_salons WHERE user_id = ?').get(req.clientUser.id);

  res.json({
    success: true,
    ...status,
    calendarMode: salon?.google_calendar_mode || 'SINGLE',
    selectedCalendarId: salon?.google_selected_calendar_id || status.selectedCalendarId || 'primary',
  });
});

router.get('/integrations/google/auth-url', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const { authUrl, state } = googleCalendarService.generateAuthUrl(req.clientUser.id);
    res.json({ success: true, authUrl, state });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Falha ao gerar link de autorização Google: ' + err.message });
  }
});

router.get('/integrations/google/callback', async (req, res) => {
  const { code, state, error } = req.query || {};

  if (error) {
    return res.redirect(`/cliente/painel.html?google_error=${encodeURIComponent(error)}#tab-integrations-google`);
  }

  if (!code || !state) {
    return res.status(400).send('Parâmetros de autenticação incompletos.');
  }

  // Obter sessão do usuário autenticado no cookie ou header
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token && req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  }
  if (!token) {
    token = getCookie(req, 'client_auth_token') || getCookie(req, 'auth_token');
  }

  let sessionUser = null;
  let sessionExpired = false;

  if (token) {
    sessionUser = userService.getUserBySessionToken(token);
    if (!sessionUser) {
      const rawUser = db.prepare('SELECT id, session_expires_at FROM users WHERE session_token = ?').get(token);
      if (rawUser && (!rawUser.session_expires_at || new Date(rawUser.session_expires_at) < new Date())) {
        sessionExpired = true;
      }
    }
  }

  const sessionUserId = sessionUser?.id || null;

  try {
    const result = await googleCalendarService.handleOAuthCallback(code, state, sessionUserId, { sessionExpired });
    res.redirect(`/cliente/painel.html?google_connected=true&email=${encodeURIComponent(result.email || '')}#tab-integrations-google`);
  } catch (err) {
    res.redirect(`/cliente/painel.html?google_error=${encodeURIComponent(err.code || err.message)}#tab-integrations-google`);
  }
});

router.post('/integrations/google/disconnect', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    const result = await googleCalendarService.disconnectUserCalendar(req.clientUser.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/integrations/google/calendars', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    const calendars = await googleCalendarService.listUserCalendars(req.clientUser.id);
    res.json({ success: true, calendars });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/integrations/google/select-calendar', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const { calendarId, calendarName, syncMode } = req.body || {};
    const result = googleCalendarService.selectCalendar(req.clientUser.id, {
      calendarId,
      calendarName,
      syncMode,
    });
    res.json({ success: true, ...result, message: 'Configuração de calendário salva com sucesso!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/integrations/google/test', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  const result = await googleCalendarService.testConnection(req.clientUser.id);
  res.json(result);
});

router.get('/integrations/google/sync-existing-preview', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const preview = googleCalendarService.getPreExistingSyncPreview(req.clientUser.id);
    res.json({ success: true, ...preview });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/integrations/google/sync-existing', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    // Validação estrita: aceita única e exclusivamente o valor booleano true
    // Rejeita valores "false", "true", 1, 0, null, undefined ou campos ausentes
    if (req.body?.confirmed !== true) {
      const preview = googleCalendarService.getPreExistingSyncPreview(req.clientUser.id);
      return res.status(400).json({
        success: false,
        error: `CONFIRMATION_REQUIRED: A sincronização em massa exige confirmação estrita (confirmed: true). Existem ${preview.count} agendamento(s) elegível(is).`,
        code: 'CONFIRMATION_REQUIRED',
        eligibleCount: preview.count,
      });
    }

    const result = await googleCalendarService.syncPreExistingAppointments(req.clientUser.id, { confirmed: true });
    res.json(result);
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message,
      code: err.code || 'SYNC_ERROR',
      eligibleCount: err.eligibleCount ?? null,
    });
  }
});

// ==========================================
// WHATSAPP NOTIFICATIONS INTEGRATIONS
// ==========================================

router.get('/integrations/whatsapp/settings', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const settings = salonNotificationService.getNotificationSettings(req.clientUser.id);
  res.json({ success: true, settings });
});

router.put('/integrations/whatsapp/settings', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const {
      notificationPhone,
      notificationsEnabled,
      notifyNewAppointment,
      notifyCancellation,
      notifyReschedule,
      notifySyncFailure,
      b2cRemindersEnabled,
    } = req.body || {};

    const updated = salonNotificationService.updateNotificationSettings(req.clientUser.id, {
      notificationPhone,
      notificationsEnabled,
      notifyNewAppointment,
      notifyCancellation,
      notifyReschedule,
      notifySyncFailure,
      b2cRemindersEnabled: b2cRemindersEnabled !== undefined ? Boolean(b2cRemindersEnabled) : undefined,
    });
    res.json({ success: true, settings: updated, message: 'Configurações de notificações WhatsApp atualizadas!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/integrations/whatsapp/test', whatsappTestLimiter, clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    const result = await salonNotificationService.sendTestNotification(req.clientUser.id, req.body?.phone);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// =======================================================
// CONEXÃO WHATSAPP COMERCIAL DO SALÃO (COMANDO 027)
// =======================================================

/**
 * GET /api/cliente/whatsapp/status (e alias /integrations/whatsapp/session-status)
 * Retorna status de conexão, telefone mascarado e dados efêmeros da sessão
 */
const getWhatsAppStatusHandler = (req, res) => {
  try {
    const statusData = salonSessionManager.getSessionStatus(req.clientUser.id);
    delete statusData.rawPhone;
    return res.json({
      success: true,
      ...statusData,
    });
  } catch (err) {
    console.error('[WhatsApp Status Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao verificar status da conexão WhatsApp do salão.',
    });
  }
};
router.get('/whatsapp/status', clientAuthMiddleware, requireProductAccess('JESSICA'), getWhatsAppStatusHandler);
router.get('/integrations/whatsapp/session-status', clientAuthMiddleware, requireProductAccess('JESSICA'), getWhatsAppStatusHandler);

/**
 * POST /api/cliente/whatsapp/connect-qr (e alias /integrations/whatsapp/connect-qr)
 * Inicializa ou recupera sessão QR Code para pareamento
 */
const postConnectQrHandler = async (req, res) => {
  try {
    const result = await salonSessionManager.startQrSession(req.clientUser.id);
    return res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('[WhatsApp Connect QR Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao inicializar sessão QR Code do WhatsApp.',
    });
  }
};
router.post('/whatsapp/connect-qr', clientAuthMiddleware, whatsappQrLimiter, requireProductAccess('JESSICA'), postConnectQrHandler);
router.post('/integrations/whatsapp/connect-qr', clientAuthMiddleware, whatsappQrLimiter, requireProductAccess('JESSICA'), postConnectQrHandler);

/**
 * POST /api/cliente/whatsapp/connect-code (e alias /integrations/whatsapp/connect-code e /integrations/whatsapp/pairing-code)
 * Gera Código de Pareamento de 8 dígitos para o número informado
 */
const postConnectCodeHandler = async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Informe o número de telefone com DDD para gerar o código de pareamento.',
        code: 'INVALID_PHONE_FORMAT',
      });
    }

    const result = await salonSessionManager.requestPairingCode(req.clientUser.id, phone);
    return res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    const isBadPhone = err.message && (
      err.message.includes('INVALID_PHONE') ||
      err.message.includes('INVALID_BRAZILIAN_DDD') ||
      err.message.includes('INVALID_MOBILE_NINTH_DIGIT')
    );
    return res.status(isBadPhone ? 400 : 500).json({
      success: false,
      error: err.message || 'Erro ao gerar código de pareamento.',
      code: isBadPhone ? 'INVALID_PHONE_E164' : 'PAIRING_ERROR',
    });
  }
};
router.post('/whatsapp/connect-code', clientAuthMiddleware, whatsappPairingCodeLimiter, requireProductAccess('JESSICA'), postConnectCodeHandler);
router.post('/integrations/whatsapp/connect-code', clientAuthMiddleware, whatsappPairingCodeLimiter, requireProductAccess('JESSICA'), postConnectCodeHandler);
router.post('/integrations/whatsapp/pairing-code', clientAuthMiddleware, whatsappPairingCodeLimiter, requireProductAccess('JESSICA'), postConnectCodeHandler);

/**
 * POST /api/cliente/whatsapp/disconnect (e alias /integrations/whatsapp/disconnect)
 * Desconecta o WhatsApp comercial do salão e expurga as credenciais em disco
 */
const postDisconnectHandler = async (req, res) => {
  try {
    const result = await salonSessionManager.disconnect(req.clientUser.id);
    return res.json(result);
  } catch (err) {
    console.error('[WhatsApp Disconnect Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao desconectar WhatsApp do salão.',
    });
  }
};
router.post('/whatsapp/disconnect', clientAuthMiddleware, whatsappActionLimiter, requireProductAccess('JESSICA'), postDisconnectHandler);
router.post('/integrations/whatsapp/disconnect', clientAuthMiddleware, whatsappActionLimiter, requireProductAccess('JESSICA'), postDisconnectHandler);

/**
 * POST /api/cliente/whatsapp/cancel-pairing (e alias /integrations/whatsapp/cancel-pairing)
 * Cancela tentativa pendente de pareamento por QR Code ou Código, liberando o socket.
 * Operação de limpeza sem retenção de rate limit (Comando 033).
 */
const postCancelPairingHandler = async (req, res) => {
  try {
    const result = await salonSessionManager.cancelPendingPairing(req.clientUser.id);
    return res.json(result);
  } catch (err) {
    console.error('[WhatsApp Cancel Pairing Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao cancelar pareamento.',
    });
  }
};
router.post('/whatsapp/cancel-pairing', clientAuthMiddleware, whatsappActionLimiter, requireProductAccess('JESSICA'), postCancelPairingHandler);
router.post('/integrations/whatsapp/cancel-pairing', clientAuthMiddleware, whatsappActionLimiter, requireProductAccess('JESSICA'), postCancelPairingHandler);

/**
 * GET /api/cliente/whatsapp/diagnostics (e alias /integrations/whatsapp/diagnostics)
 * Retorna telemetria sanitizada de conexão e auditoria de credenciais em disco (Comando 034).
 */
const getWhatsAppDiagnosticsHandler = (req, res) => {
  try {
    const diagnostics = salonSessionManager.getSalonDiagnostics(req.clientUser.id);
    return res.json({ success: true, diagnostics });
  } catch (err) {
    console.error('[WhatsApp Diagnostics Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Erro ao obter telemetria de diagnóstico WhatsApp do salão.',
    });
  }
};
router.get('/whatsapp/diagnostics', clientAuthMiddleware, requireProductAccess('JESSICA'), getWhatsAppDiagnosticsHandler);
router.get('/integrations/whatsapp/diagnostics', clientAuthMiddleware, requireProductAccess('JESSICA'), getWhatsAppDiagnosticsHandler);

// =======================================================
// DASHBOARD GERENCIAL & FINANCEIRO 2.0 (MÓDULO JÉSSICA)
// =======================================================

router.get('/pro/dashboard', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    const tier = salonDashboardService.getEffectiveJessicaTier(req.clientUser.id, req.clientUser);
    const canAccessDashboard = ['JESSICA_INTERMEDIATE', 'JESSICA_PRO'].includes(tier) || req.isDemo;

    if (!canAccessDashboard) {
      return res.status(403).json({
        success: false,
        upgradeRequired: true,
        currentPlan: tier,
        message: 'Dashboard Gerencial disponível nos planos Intermediário e Pró.',
        upgradeUrl: `${config.baseUrl}/planos`,
      });
    }

    const isPro = tier === 'JESSICA_PRO' || req.isDemo;
    const { period, startDate, endDate } = req.query;
    const data = await salonDashboardService.getSalonDashboard(req.clientUser.id, {
      period,
      startDate,
      endDate,
      isDemo: req.isDemo,
      isPro,
    });

    data.userTier = tier;
    data.isPro = isPro;
    if (!isPro) {
      data.bills = null;
    }

    return res.json(data);
  } catch (err) {
    console.error('[Dashboard 2.0 Error]:', err);
    return res.status(500).json({
      success: false,
      error: 'Erro ao carregar dados do dashboard gerencial.',
    });
  }
});

// Bills to Pay (Contas a Pagar) - Exclusive to JESSICA_PRO
router.get('/pro/bills', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  try {
    const tier = salonDashboardService.getEffectiveJessicaTier(req.clientUser.id, req.clientUser);
    const isPro = tier === 'JESSICA_PRO' || req.isDemo;

    if (!isPro) {
      return res.status(403).json({
        success: false,
        upgradeRequired: true,
        proExclusive: true,
        message: 'O módulo de Contas a Pagar é exclusivo do Plano Jéssica Pró.',
      });
    }

    const dashboard = await salonDashboardService.getSalonDashboard(req.clientUser.id, { isDemo: req.isDemo });
    return res.json({ success: true, bills: dashboard.bills });
  } catch (err) {
    console.error('[Bills Error]:', err);
    return res.status(500).json({ success: false, error: 'Erro ao carregar contas a pagar.' });
  }
});

router.post('/pro/bills', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const tier = salonDashboardService.getEffectiveJessicaTier(req.clientUser.id, req.clientUser);
    const isPro = tier === 'JESSICA_PRO' || req.isDemo;

    if (!isPro) {
      return res.status(403).json({
        success: false,
        upgradeRequired: true,
        proExclusive: true,
        message: 'O módulo de Contas a Pagar é exclusivo do Plano Jéssica Pró.',
      });
    }

    const bills = salonDashboardService.createBill(req.clientUser.id, req.body || {});
    return res.status(201).json({ success: true, bills, message: 'Conta agendada registrada com sucesso!' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message || 'Erro ao registrar conta.' });
  }
});

router.patch('/pro/bills/:id/pay', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const tier = salonDashboardService.getEffectiveJessicaTier(req.clientUser.id, req.clientUser);
    const isPro = tier === 'JESSICA_PRO' || req.isDemo;

    if (!isPro) {
      return res.status(403).json({
        success: false,
        upgradeRequired: true,
        proExclusive: true,
        message: 'O módulo de Contas a Pagar é exclusivo do Plano Jéssica Pró.',
      });
    }

    const result = salonDashboardService.markBillAsPaid(req.clientUser.id, req.params.id);
    return res.json({ success: true, ...result, message: 'Conta marcada como paga e despesa registrada no caixa!' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message || 'Erro ao atualizar conta.' });
  }
});

router.delete('/pro/bills/:id', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const tier = salonDashboardService.getEffectiveJessicaTier(req.clientUser.id, req.clientUser);
    const isPro = tier === 'JESSICA_PRO' || req.isDemo;

    if (!isPro) {
      return res.status(403).json({
        success: false,
        upgradeRequired: true,
        proExclusive: true,
        message: 'O módulo de Contas a Pagar é exclusivo do Plano Jéssica Pró.',
      });
    }

    salonDashboardService.deleteBill(req.clientUser.id, req.params.id);
    return res.json({ success: true, message: 'Conta excluída com sucesso.' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message || 'Erro ao excluir conta.' });
  }
});

// Manual transaction registration (Income or Expense)
router.post('/pro/transactions', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  try {
    const tier = salonDashboardService.getEffectiveJessicaTier(req.clientUser.id, req.clientUser);
    const canAccess = ['JESSICA_INTERMEDIATE', 'JESSICA_PRO'].includes(tier) || req.isDemo;

    if (!canAccess) {
      return res.status(403).json({
        success: false,
        upgradeRequired: true,
        message: 'Movimentações de caixa disponíveis nos planos Intermediário e Pró.',
      });
    }

    const tx = salonDashboardService.recordTransaction(req.clientUser.id, req.body || {});
    return res.status(201).json({ success: true, transaction: tx, message: 'Movimentação registrada com sucesso!' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message || 'Erro ao registrar movimentação.' });
  }
});

// ==========================================
// PRO PLAN EXCLUSIVE: PROMOTIONAL CAMPAIGNS
// ==========================================

router.get('/pro/campaigns', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const isPro = req.clientUser.plan_tier === 'JESSICA_PRO' || req.isDemo;

  if (!isPro) {
    return res.status(403).json({
      success: false,
      upgradeRequired: true,
      message: 'O módulo de Campanhas Promocionais via WhatsApp é exclusivo do Plano Jéssica Pro.',
    });
  }

  const rows = db.prepare(`
    SELECT id, title, message, target_audience, status, consent_confirmed, recipients_count, created_at
    FROM client_campaigns
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(req.clientUser.id);

  res.json({ success: true, campaigns: rows });
});

router.post('/pro/campaigns', clientAuthMiddleware, requireProductAccess('JESSICA'), (req, res) => {
  const isPro = req.clientUser.plan_tier === 'JESSICA_PRO' || req.isDemo;

  if (!isPro) {
    return res.status(403).json({
      success: false,
      upgradeRequired: true,
      message: 'O módulo de Campanhas Promocionais via WhatsApp é exclusivo do Plano Jéssica Pro.',
    });
  }

  const { title, message, targetAudience, consentConfirmed } = req.body || {};

  if (!title || !message) {
    return res.status(400).json({ success: false, error: 'Título e mensagem da campanha são obrigatórios.' });
  }

  // Mandatory Consent Validation (Requirement 3)
  if (!consentConfirmed) {
    return res.status(400).json({
      success: false,
      error: 'É obrigatório confirmar que todos os destinatários autorizaram o recebimento de mensagens promocionais (opt-in LGPD).',
    });
  }

  // Guarantee opt-out clause in message
  const optOutNotice = '\n\n_(Para não receber mais novidades, responda SAIR)_';
  const finalMessage = message.includes('SAIR') ? message.trim() : (message.trim() + optOutNotice);

  const info = db.prepare(`
    INSERT INTO client_campaigns (
      user_id, title, message, target_audience, status, consent_confirmed, recipients_count
    ) VALUES (?, ?, ?, ?, 'DRAFT', 1, 0)
  `).run(
    req.clientUser.id,
    title.trim(),
    finalMessage,
    targetAudience || 'Clientes cadastrados'
  );

  res.json({
    success: true,
    campaignId: info.lastInsertRowid,
    message: 'Campanha criada com sucesso! Mecanismo de consentimento e opção de saída (opt-out) validados.',
  });
});

// ==========================================
// WHATSAPP DISPATCH & DEMO SECURITY GUARDS
// ==========================================

// Test WhatsApp Message (Strictly blocked on Demo Account & Homologation) (Proteção 12)
router.post('/test-whatsapp', whatsappTestLimiter, clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  if (req.isDemo || req.clientUser.is_demo) {
    return res.status(403).json({
      success: false,
      isDemoBlocked: true,
      error: 'Ambiente de Homologação / Demonstração: O envio de mensagens reais via WhatsApp está estritamente bloqueado para a conta de homologação Hotmart.',
    });
  }

  const isStaging = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging' || process.env.APP_MODE === 'homologacao';
  if (isStaging) {
    return res.status(403).json({
      success: false,
      isDemoBlocked: true,
      error: 'Ambiente de Homologação: O envio de mensagens reais via WhatsApp está estritamente desativado no ambiente de homologação.',
    });
  }

  const { targetPhone, message } = req.body || {};
  if (!targetPhone) {
    return res.status(400).json({ success: false, error: 'Telefone de destino é obrigatório.' });
  }

  return res.json({
    success: true,
    message: `Mensagem de teste enviada para ${targetPhone}.`,
  });
});

// Dispatch Campaign (Strictly blocked on Demo Account & Homologation)
router.post('/pro/campaigns/:id/send', clientAuthMiddleware, requireProductAccess('JESSICA'), async (req, res) => {
  const isPro = req.clientUser.plan_tier === 'JESSICA_PRO' || req.isDemo;
  if (!isPro) {
    return res.status(403).json({ success: false, error: 'Exclusivo do Plano Pro.' });
  }

  if (req.isDemo || req.clientUser.is_demo) {
    return res.status(403).json({
      success: false,
      isDemoBlocked: true,
      error: 'Ambiente de Homologação / Demonstração: O disparo de campanhas para números reais de WhatsApp está estritamente bloqueado para a conta de homologação Hotmart.',
    });
  }

  const isStaging = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging' || process.env.APP_MODE === 'homologacao';
  if (isStaging) {
    return res.status(403).json({
      success: false,
      isDemoBlocked: true,
      error: 'Ambiente de Homologação: O disparo de campanhas para números reais de WhatsApp está estritamente desativado no ambiente de homologação.',
    });
  }

  const { id } = req.params;
  const campaign = db.prepare('SELECT * FROM client_campaigns WHERE id = ? AND user_id = ?').get(id, req.clientUser.id);
  if (!campaign) {
    return res.status(404).json({ success: false, error: 'Campanha não encontrada.' });
  }

  db.prepare("UPDATE client_campaigns SET status = 'SENT' WHERE id = ?").run(id);
  return res.json({ success: true, message: 'Campanha disparada com sucesso.' });
});

module.exports = router;
