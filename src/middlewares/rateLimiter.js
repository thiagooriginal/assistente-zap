/**
 * Zero-dependency In-Memory Sliding-Window Rate Limiter
 * 
 * Provides rate limiting protection for sensitive endpoints:
 * - Admin Login
 * - Client Login
 * - Account Activation
 * - Password Reset
 */

function createRateLimiter({
  windowMs = 15 * 60 * 1000, // 15 minutes
  maxAttempts = 5,
  message = 'Muitas tentativas a partir deste endereço. Tente novamente mais tarde.',
  keyGenerator = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || '127.0.0.1');
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

module.exports = {
  createRateLimiter,
  adminLoginLimiter,
  clientLoginLimiter,
  activationLimiter,
  passwordResetRequestLimiter,
  passwordResetSubmitLimiter,
};
