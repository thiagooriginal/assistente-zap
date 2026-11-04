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
  const attempts = new Map();

  // Periodic cleanup of expired entries without keeping process active
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of attempts.entries()) {
      if (now > record.resetTime) {
        attempts.delete(key);
      }
    }
  }, 60000);
  if (interval.unref) {
    interval.unref();
  }

  const limiterMiddleware = (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    let record = attempts.get(key);

    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      attempts.set(key, record);
    } else {
      record.count += 1;
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

  // Helper for automated tests to clear state
  limiterMiddleware.reset = () => attempts.clear();

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
};
