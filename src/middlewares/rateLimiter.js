/**
 * Zero-dependency In-Memory Sliding-Window Rate Limiter
 * 
 * Provides rate limiting protection for sensitive endpoints (Proteção 12):
 * - Admin Login & Admin Actions
 * - Client Login
 * - Account Activation
 * - Password Reset (Request & Submit)
 * - Lead Test Requests & TTS Streaming
 * - Analytics & WhatsApp Test Dispatches
 * 
 * Uses strictly validated client IP via trusted reverse proxy (req.ip).
 */

const crypto = require('crypto');

let dbInstance = null;
function getDb() {
  if (!dbInstance) {
    try {
      dbInstance = require('../database/db');
    } catch (_) {}
  }
  return dbInstance;
}

function createRateLimiter({
  name = 'global',
  db: injectedDb = null,
  windowMs = 15 * 60 * 1000, // 15 minutes
  maxAttempts = 5,
  message = 'Muitas tentativas a partir deste endereço. Tente novamente mais tarde.',
  keyGenerator = (req) => {
    // Proteção 12: Utilize strictly validated client IP from trusted reverse proxy
    // Never trust spoofable raw x-forwarded-for header directly
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    return `${ip}:${req.baseUrl || ''}${req.path || ''}`;
  },
}) {
  let customDb = injectedDb;
  const inMemoryAttempts = new Map();

  // Periodic cleanup of expired entries without keeping process active
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of inMemoryAttempts.entries()) {
      if (now > record.resetTime) {
        inMemoryAttempts.delete(key);
      }
    }
    const db = customDb || getDb();
    if (db && typeof db.prepare === 'function') {
      try {
        db.prepare('DELETE FROM rate_limit_entries WHERE reset_time < ?').run(now);
      } catch (_) {}
    }
  }, 60000);
  if (interval.unref) {
    interval.unref();
  }

  const limiterMiddleware = (req, res, next) => {
    const rawKey = keyGenerator(req);
    const storageKey = `${name}:${rawKey}`;
    const now = Date.now();
    let record = null;
    const db = customDb || getDb();

    // 1. Persistent, Cluster-Coordinated & Atomic Storage (Proteção 12)
    let usedDb = false;
    if (db && typeof db.prepare === 'function') {
      try {
        const resetTime = now + windowMs;
        // Atomic UPSERT preventing race conditions during concurrent requests
        db.prepare(`
          INSERT INTO rate_limit_entries (key, count, reset_time, updated_at)
          VALUES (?, 1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET
            count = CASE WHEN ? > rate_limit_entries.reset_time THEN 1 ELSE rate_limit_entries.count + 1 END,
            reset_time = CASE WHEN ? > rate_limit_entries.reset_time THEN excluded.reset_time ELSE rate_limit_entries.reset_time END,
            updated_at = CURRENT_TIMESTAMP
        `).run(storageKey, resetTime, now, now);

        const row = db.prepare('SELECT count, reset_time FROM rate_limit_entries WHERE key = ?').get(storageKey);
        if (row) {
          record = { count: row.count, resetTime: row.reset_time };
          usedDb = true;
        }
      } catch (dbErr) {
        // Resilient Fallback: Never crash critical endpoints on storage glitches or transient SQLite locks
        console.warn(`[RateLimiter:${name}] Armazenamento persistente indisponível temporariamente. Ativando fallback resiliente em memória:`, dbErr.message);
      }
    }

    // 2. In-Memory fallback or fast cache
    if (!usedDb) {
      record = inMemoryAttempts.get(storageKey);
      if (!record || now > record.resetTime) {
        record = { count: 1, resetTime: now + windowMs };
        inMemoryAttempts.set(storageKey, record);
      } else {
        record.count += 1;
      }
    } else {
      inMemoryAttempts.set(storageKey, record);
    }

    const remaining = Math.max(0, maxAttempts - record.count);
    const resetTimeSec = Math.ceil(record.resetTime / 1000);

    res.setHeader('X-RateLimit-Limit', maxAttempts);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetTimeSec);

    if (record.count > maxAttempts) {
      const retryAfterSec = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      res.setHeader('Retry-After', retryAfterSec);

      try {
        const { logSecurityEvent, AUDIT_EVENTS } = require('../services/securityAuditService');
        logSecurityEvent({
          eventType: AUDIT_EVENTS.RATE_LIMIT_BLOCKED,
          req,
          status: 'BLOCKED',
          details: { endpoint: req.path, count: record.count, maxAttempts, retryAfterSec },
        });
      } catch (_) {}

      return res.status(429).json({
        success: false,
        error: message,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: retryAfterSec,
      });
    }

    next();
  };

  // Safe helper to clear state: scoped to this limiter only and blocked in production
  limiterMiddleware.reset = (targetKey = null) => {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[RateLimiter] Chamada a reset() ignorada em ambiente de produção.');
      return;
    }

    if (targetKey) {
      inMemoryAttempts.delete(targetKey);
      inMemoryAttempts.delete(`${name}:${targetKey}`);
      const db = getDb();
      if (db && typeof db.prepare === 'function') {
        try {
          db.prepare('DELETE FROM rate_limit_entries WHERE key = ? OR key = ?').run(targetKey, `${name}:${targetKey}`);
        } catch (_) {}
      }
    } else {
      inMemoryAttempts.clear();
      const db = getDb();
      if (db && typeof db.prepare === 'function') {
        try {
          db.prepare('DELETE FROM rate_limit_entries WHERE key LIKE ?').run(`${name}:%`);
        } catch (_) {}
      }
    }
  };

  limiterMiddleware.setDb = (newDb) => {
    customDb = newDb;
  };

  return limiterMiddleware;
}

// Pre-configured rate limiters
const adminLoginLimiter = createRateLimiter({
  name: 'admin_login',
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de acesso administrativo excedido. Tente novamente em 15 minutos.',
});

const clientLoginLimiter = createRateLimiter({
  name: 'client_login',
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de login excedido. Tente novamente em 15 minutos.',
});

const activationLimiter = createRateLimiter({
  name: 'activation',
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de ativação de conta excedido. Tente novamente em 15 minutos.',
});

const passwordResetRequestLimiter = createRateLimiter({
  name: 'password_reset_req',
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de solicitações de recuperação de senha excedido. Tente novamente em 15 minutos.',
});

const passwordResetSubmitLimiter = createRateLimiter({
  name: 'password_reset_sub',
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de redefinição de senha excedido. Tente novamente em 15 minutos.',
});

const leadTestLimiter = createRateLimiter({
  name: 'lead_test',
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
  message: 'Limite de solicitações de teste excedido. Tente novamente mais tarde.',
});

const ttsLimiter = createRateLimiter({
  name: 'tts',
  windowMs: 10 * 60 * 1000,
  maxAttempts: 25,
  message: 'Limite de streaming de áudio neural excedido. Aguarde alguns minutos.',
});

const analyticsLimiter = createRateLimiter({
  name: 'analytics',
  windowMs: 60 * 1000,
  maxAttempts: 60,
  message: 'Limite de telemetria excedido.',
});

const adminActionLimiter = createRateLimiter({
  name: 'admin_action',
  windowMs: 5 * 60 * 1000,
  maxAttempts: 40,
  message: 'Limite de operações administrativas excedido. Aguarde alguns minutos.',
});

const whatsappTestLimiter = createRateLimiter({
  name: 'whatsapp_test',
  windowMs: 10 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de disparos de teste de WhatsApp excedido.',
});

const cspReportLimiter = createRateLimiter({
  name: 'csp_report',
  windowMs: 5 * 60 * 1000,
  maxAttempts: 50,
  message: 'Limite de relatórios CSP excedido.',
});

// Dedicated persistent rate limiter for MFA verification & activation (Proteção 01 & 12)
const adminMfaLimiter = createRateLimiter({
  name: 'admin_mfa',
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de autenticação multifator excedido. Tente novamente em 15 minutos.',
  keyGenerator: (req) => {
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const userIdentifier = req.user?.id
      ? `uid_${req.user.id}`
      : (req.headers.authorization ? `auth_${crypto.createHash('sha256').update(req.headers.authorization).digest('hex').slice(0, 16)}` : 'anon');
    return `${ip}:${userIdentifier}:${req.baseUrl || ''}${req.path || ''}`;
  },
});

// Dedicated persistent rate limiter for WhatsApp multi-tenant pairing code & QR requests (Comando 027 & Comando 033)
const whatsappQrLimiter = createRateLimiter({
  name: 'whatsapp_qr',
  windowMs: 5 * 60 * 1000,
  maxAttempts: 10,
  message: 'Limite de solicitações de QR Code excedido. Aguarde alguns minutos para tentar novamente.',
  keyGenerator: (req) => {
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const tenantId = req.clientUser?.id ? `salon_${req.clientUser.id}` : 'anon';
    return `${ip}:${tenantId}:whatsapp_qr`;
  },
});

const whatsappPairingCodeLimiter = createRateLimiter({
  name: 'whatsapp_code',
  windowMs: 5 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de solicitações de código de pareamento excedido. Aguarde alguns minutos para tentar novamente.',
  keyGenerator: (req) => {
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const tenantId = req.clientUser?.id ? `salon_${req.clientUser.id}` : 'anon';
    return `${ip}:${tenantId}:whatsapp_code`;
  },
});

// Dedicated rate limiter for WhatsApp state actions (disconnect & cancel) (Comando 035 / F15)
const whatsappActionLimiter = createRateLimiter({
  name: 'whatsapp_action',
  windowMs: 5 * 60 * 1000,
  maxAttempts: 30,
  message: 'Limite de ações do WhatsApp excedido. Aguarde alguns minutos para tentar novamente.',
  keyGenerator: (req) => {
    const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const tenantId = req.clientUser?.id ? `salon_${req.clientUser.id}` : 'anon';
    return `${ip}:${tenantId}:whatsapp_action`;
  },
});

// Alias for backwards compatibility
const whatsappPairingLimiter = whatsappPairingCodeLimiter;

module.exports = {
  createRateLimiter,
  adminLoginLimiter,
  adminMfaLimiter,
  clientLoginLimiter,
  activationLimiter,
  passwordResetRequestLimiter,
  passwordResetSubmitLimiter,
  leadTestLimiter,
  ttsLimiter,
  analyticsLimiter,
  adminActionLimiter,
  whatsappTestLimiter,
  whatsappPairingLimiter,
  whatsappQrLimiter,
  whatsappPairingCodeLimiter,
  whatsappActionLimiter,
  cspReportLimiter,
};
