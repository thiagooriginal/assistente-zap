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
  const inMemoryAttempts = new Map();

  // Periodic cleanup of expired entries without keeping process active
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of inMemoryAttempts.entries()) {
      if (now > record.resetTime) {
        inMemoryAttempts.delete(key);
      }
    }
    const db = getDb();
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
    const key = keyGenerator(req);
    const now = Date.now();
    let record = null;
    const db = getDb();

    // 1. Persistent & Cluster-Coordinated Storage (Proteção 12: Sobrevive a reinicializações e instâncias múltiplas)
    let usedDb = false;
    if (db && typeof db.prepare === 'function') {
      try {
        const row = db.prepare('SELECT count, reset_time FROM rate_limit_entries WHERE key = ?').get(key);
        if (!row || now > row.reset_time) {
          const resetTime = now + windowMs;
          db.prepare(`
            INSERT INTO rate_limit_entries (key, count, reset_time, updated_at)
            VALUES (?, 1, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET count = 1, reset_time = excluded.reset_time, updated_at = CURRENT_TIMESTAMP
          `).run(key, resetTime);
          record = { count: 1, resetTime };
        } else {
          const newCount = row.count + 1;
          db.prepare('UPDATE rate_limit_entries SET count = count + 1, updated_at = CURRENT_TIMESTAMP WHERE key = ?').run(key);
          record = { count: newCount, resetTime: row.reset_time };
        }
        usedDb = true;
      } catch (_) {
        // Fallback to in-memory if DB is temporarily locked or before migration
      }
    }

    // 2. In-Memory fallback or fast cache
    if (!usedDb) {
      record = inMemoryAttempts.get(key);
      if (!record || now > record.resetTime) {
        record = { count: 1, resetTime: now + windowMs };
        inMemoryAttempts.set(key, record);
      } else {
        record.count += 1;
      }
    } else {
      inMemoryAttempts.set(key, record);
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

  // Helper for automated tests to clear state (clears both in-memory and database)
  limiterMiddleware.reset = () => {
    inMemoryAttempts.clear();
    const db = getDb();
    if (db && typeof db.prepare === 'function') {
      try {
        db.prepare('DELETE FROM rate_limit_entries').run();
      } catch (_) {}
    }
  };

  return limiterMiddleware;
}

// Pre-configured rate limiters
const adminLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de acesso administrativo excedido. Tente novamente em 15 minutos.',
});

const clientLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de login excedido. Tente novamente em 15 minutos.',
});

const activationLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de ativação de conta excedido. Tente novamente em 15 minutos.',
});

const passwordResetRequestLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de solicitações de recuperação de senha excedido. Tente novamente em 15 minutos.',
});

const passwordResetSubmitLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de tentativas de redefinição de senha excedido. Tente novamente em 15 minutos.',
});

const leadTestLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
  message: 'Limite de solicitações de teste excedido. Tente novamente mais tarde.',
});

const ttsLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 25,
  message: 'Limite de streaming de áudio neural excedido. Aguarde alguns minutos.',
});

const analyticsLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxAttempts: 60,
  message: 'Limite de telemetria excedido.',
});

const adminActionLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxAttempts: 40,
  message: 'Limite de operações administrativas excedido. Aguarde alguns minutos.',
});

const whatsappTestLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 5,
  message: 'Limite de disparos de teste de WhatsApp excedido.',
});

const cspReportLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxAttempts: 50,
  message: 'Limite de relatórios CSP excedido.',
});

module.exports = {
  createRateLimiter,
  adminLoginLimiter,
  clientLoginLimiter,
  activationLimiter,
  passwordResetRequestLimiter,
  passwordResetSubmitLimiter,
  leadTestLimiter,
  ttsLimiter,
  analyticsLimiter,
  adminActionLimiter,
  whatsappTestLimiter,
  cspReportLimiter,
};
