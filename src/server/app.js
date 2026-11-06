const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('../database/db');
const financeService = require('../services/financeService');
const billService = require('../services/billService');
const appointmentService = require('../services/appointmentService');
const userService = require('../services/userService');
const pixService = require('../services/pixService');
const config = require('../config');
const aiService = require('../services/aiService');
const calendarService = require('../services/calendarService');
const whatsappClient = require('../whatsapp/client');
const asaasService = require('../services/asaasService');
const agentChatService = require('../services/agentChatService');
const businessAnalyzerService = require('../services/businessAnalyzerService');
const clientRoutes = require('../routes/clientRoutes');
const hotmartService = require('../services/hotmartService');
const analyticsService = require('../services/analyticsService');
const metaCapiService = require('../services/metaCapiService');
const clientAuth = require('../services/clientAuthService');
const directSales = require('../services/directSalesService');
const productService = require('../services/productService');
const { PLANS } = require('../services/planCatalog');
const {
  adminLoginLimiter,
  adminMfaLimiter,
  leadTestLimiter,
  ttsLimiter,
  analyticsLimiter,
  adminActionLimiter,
  whatsappTestLimiter,
  cspReportLimiter,
} = require('../middlewares/rateLimiter');
const { AUDIT_EVENTS, logSecurityEvent, getRecentSecurityLogs } = require('../services/securityAuditService');
const totpService = require('../services/totpService');

// Execute Startup Environment & Configuration Validation (Proteção 11)
const isStagingEnv = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging';
const isProdEnv = process.env.NODE_ENV === 'production' && !isStagingEnv;

try {
  if (typeof config.validateEnvironment === 'function') {
    const envValidation = config.validateEnvironment({ throwOnError: isProdEnv });
    if (!envValidation.valid) {
      const hasCriticalConflict = Boolean(envValidation.hasConflict || (envValidation.errors && envValidation.errors.some(e => e.includes('CONFLITO'))));
      if (isProdEnv || hasCriticalConflict) {
        console.error('\n🚨 FATAL: Abortando inicialização do servidor por erro crítico de configuração ou conflito de ambiente.');
        process.exit(1);
      }
    }
  }
} catch (envErr) {
  const isConflict = Boolean(envErr.message && envErr.message.includes('CONFLITO'));
  if (isProdEnv || isConflict) {
    console.error('\n🚨 FATAL: Abortando inicialização do servidor por erro crítico de configuração ou conflito de ambiente:', envErr.message);
    process.exit(1);
  } else {
    console.warn('\n⚠️ [Config Warning em Staging/Dev]:', envErr.message);
  }
}

// Initialize isolated demo account for Hotmart compliance
try {
  clientAuth.ensureDemoAccount();
} catch (demoErr) {
  console.warn('[Demo Account] Erro ao verificar conta demo:', demoErr.message);
}

const app = express();

// Trust only the immediate reverse proxy (Traefik in Docker/Easypanel), 1 hop.
// Prevents trusting spoofed X-Forwarded-* headers from untrusted external clients.
app.set('trust proxy', 1);

// Exact allowlist for legitimate Host headers (Proteção 04)
const EXACT_ALLOWED_HOSTS = new Set([
  'raiaagentes.com.br',
  'www.raiaagentes.com.br',
  'staging.raiaagentes.com.br',
  'seguranca.raiaagentes.com.br',
  'localhost',
  'localhost:3000',
  'localhost:3333',
  '127.0.0.1',
  '127.0.0.1:3000',
  '127.0.0.1:3333',
]);

// Validate host header strictly to prevent Host Header Injection / Open Redirect attacks (Proteção 04)
function getValidatedRedirectHost(req, fallbackHost) {
  const rawHost = (req.get('x-forwarded-host') || req.get('host') || '').trim().toLowerCase();
  if (!rawHost) return fallbackHost;
  if (EXACT_ALLOWED_HOSTS.has(rawHost)) return rawHost;

  // Check dynamically configured BASE_URL / CORS_ORIGIN hosts
  const configuredHosts = [
    process.env.BASE_URL,
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : []),
  ].filter(Boolean).map(val => {
    try { return new URL(val.trim()).host.toLowerCase(); } catch (_) { return null; }
  }).filter(Boolean);

  if (configuredHosts.includes(rawHost)) {
    return rawHost;
  }

  return fallbackHost;
}

// Strict validator for legitimate browser origins (Proteção 13 & 16)
function isAllowedOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    const proto = parsed.protocol.toLowerCase();

    // 1. Official RAIA production and staging/homologation domains (HTTPS only, exact host)
    const OFFICIAL_HOSTS = [
      'raiaagentes.com.br',
      'www.raiaagentes.com.br',
      'staging.raiaagentes.com.br',
      'seguranca.raiaagentes.com.br',
    ];
    if (OFFICIAL_HOSTS.includes(host)) {
      return proto === 'https:';
    }

    // 2. Validate against explicitly configured environment origins (BASE_URL & CORS_ORIGIN)
    // Supports comma-separated list of origins in CORS_ORIGIN
    const configuredOrigins = [
      process.env.BASE_URL,
      ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : []),
    ].filter(Boolean).map(o => o.trim());

    for (const conf of configuredOrigins) {
      try {
        const confUrl = new URL(conf);
        if (confUrl.hostname.toLowerCase() === host) {
          if (host === 'localhost' || host === '127.0.0.1') {
            return proto === 'http:';
          }
          return proto === 'https:' && confUrl.protocol.toLowerCase() === 'https:';
        }
      } catch (_) {}
    }

    // 3. Localhost and loopback development/test servers (HTTP only, exact loopback host)
    if (host === 'localhost' || host === '127.0.0.1') {
      return proto === 'http:';
    }

    return false;
  } catch (_) {
    return false;
  }
}

// Application-level HTTPS redirect and security headers (Proteção 04, 14 & 07)
// NOTE: TLS certificate provisioning is managed by Traefik / Let's Encrypt at the ingress proxy layer.
app.use((req, res, next) => {
  const isStaging = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging';
  const isProduction = process.env.NODE_ENV === 'production' && !isStaging;
  const isStagingOrProd = isProduction || isStaging;

  const proto = req.get('x-forwarded-proto');

  // Enforce HTTPS redirection in staging / production if request arrived over plain HTTP
  if (isStagingOrProd && proto && proto.toLowerCase() === 'http') {
    let defaultHost = 'raiaagentes.com.br';
    if (isStaging) {
      try {
        const confHost = process.env.BASE_URL ? new URL(process.env.BASE_URL).host : null;
        defaultHost = confHost || 'staging.raiaagentes.com.br';
      } catch (_) {
        defaultHost = 'staging.raiaagentes.com.br';
      }
    }
    const host = getValidatedRedirectHost(req, defaultHost);
    return res.redirect(301, `https://${host}${req.path || ''}`);
  }

  // HSTS Policy
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  } else if (isStaging && process.env.ENABLE_HSTS_STAGING === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=86400');
  }

  // Response defense-in-depth headers (Proteção 14 & 07)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '0');

  if (isStagingOrProd) {
    // Enforced baseline CSP without unsafe-eval, allowlisting required CDNs & assets
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https: blob:; connect-src 'self' https://staging.raiaagentes.com.br https://seguranca.raiaagentes.com.br https://raiaagentes.com.br; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests;"
    );
    // Report-Only CSP preparing transition away from unsafe-inline
    res.setHeader(
      'Content-Security-Policy-Report-Only',
      "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' https://staging.raiaagentes.com.br https://seguranca.raiaagentes.com.br https://raiaagentes.com.br; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; report-uri /api/security/csp-report;"
    );
  }

  next();
});

// Endpoint to receive CSP violation reports with payload limits, rate limiting & sanitized logging
app.post(
  '/api/security/csp-report',
  cspReportLimiter,
  express.json({ type: ['application/json', 'application/csp-report'], limit: '10kb' }),
  (req, res) => {
    try {
      const report = req.body?.['csp-report'] || req.body || {};
      const { sanitizeResource } = require('../services/securityAuditService');
      const blockedUri = sanitizeResource(report['blocked-uri'] || report['blockedURI']);
      const documentUri = sanitizeResource(report['document-uri'] || report['documentURI']);
      const violatedDirective = String(report['violated-directive'] || report['effective-directive'] || 'unknown').slice(0, 100);

      logSecurityEvent({
        eventType: AUDIT_EVENTS.CSP_VIOLATION,
        req,
        status: 'REPORTED',
        details: { blockedUri, documentUri, violatedDirective },
      });
    } catch (_) {}
    return res.status(204).end();
  }
);

// Restricted CORS configuration with exact origin matching (Proteção 13)
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // Allow server-to-server or non-browser tools
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    // Disallow without throwing internal server error (browser will enforce origin block)
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Auth-Token', 'X-Staging-Key', 'X-Staging-Token', 'X-Admin-Key', 'X-Admin-Pin', 'X-CSRF-Token'],
  credentials: true,
}));

app.use(express.json());

// Anti-CSRF Protection Middleware on State-Changing Requests (Proteção 16)
app.use((req, res, next) => {
  const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (!mutatingMethods.includes(req.method)) return next();

  // Webhooks and anonymous public endpoints are exempted from browser CSRF checks
  const exemptPrefixes = [
    '/api/webhooks',
    '/api/analytics/event',
    '/api/leads/request-test',
    '/api/test-agent',
    '/api/security/csp-report',
    '/api/auth/admin-login',
    '/api/cliente/auth/login',
    '/api/cliente/auth/request-reset',
    '/api/cliente/auth/reset-password',
  ];
  if (exemptPrefixes.some(p => req.path.startsWith(p))) {
    return next();
  }

  // Check if request relies on cookie authentication
  const hasAuthCookie = Boolean(getCookie(req, 'auth_token') || getCookie(req, 'client_auth_token'));
  if (hasAuthCookie) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;

    if (origin) {
      if (!isAllowedOrigin(origin)) {
        logSecurityEvent({
          eventType: AUDIT_EVENTS.CSRF_VIOLATION_BLOCKED,
          req,
          status: 'BLOCKED',
          details: { reason: 'invalid_origin', origin, path: req.path },
        });
        return res.status(403).json({
          success: false,
          error: 'Acesso bloqueado por validação Anti-CSRF: origem não autorizada.',
          code: 'CSRF_INVALID_ORIGIN'
        });
      }
    } else if (referer) {
      try {
        const refUrl = new URL(referer);
        const refOrigin = refUrl.origin.toLowerCase();
        if (!isAllowedOrigin(refOrigin)) {
          logSecurityEvent({
            eventType: AUDIT_EVENTS.CSRF_VIOLATION_BLOCKED,
            req,
            status: 'BLOCKED',
            details: { reason: 'invalid_referer', refererOrigin: refOrigin, path: req.path },
          });
          return res.status(403).json({
            success: false,
            error: 'Acesso bloqueado por validação Anti-CSRF: Referer não autorizado.',
            code: 'CSRF_INVALID_REFERER'
          });
        }
      } catch (_) {
        return res.status(403).json({
          success: false,
          error: 'Referer inválido na requisição.',
          code: 'CSRF_INVALID_REFERER'
        });
      }
    } else {
      // Both Origin and Referer are absent on a cookie-authenticated mutation
      // Require explicit Double-Submit CSRF token header
      const submittedCsrf = req.headers['x-csrf-token'];
      const cookieCsrf = getCookie(req, 'csrf_token');
      if (!submittedCsrf || !cookieCsrf || submittedCsrf !== cookieCsrf) {
        logSecurityEvent({
          eventType: AUDIT_EVENTS.CSRF_VIOLATION_BLOCKED,
          req,
          status: 'BLOCKED',
          details: { reason: 'missing_origin_and_csrf_token', path: req.path },
        });
        return res.status(403).json({
          success: false,
          error: 'Acesso bloqueado por validação Anti-CSRF: requisições autenticadas por cookie exigem comprovação de origem ou token CSRF válido.',
          code: 'CSRF_PROOF_MISSING'
        });
      }
    }
  }

  next();
});

// Cache-Control protection for private client and administrative data (Proteção 14)
app.use(['/api/cliente', '/api/admin', '/api/asaas', '/api/me'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Defensive block against exposing internal databases, secrets, backups, logs, and dotfiles (Proteção 23)
app.use((req, res, next) => {
  const urlPath = decodeURIComponent(req.path || '').toLowerCase();
  const forbiddenPatterns = [
    /\/\./,                             // Any hidden dotfile (e.g. .env, .git)
    /\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$/i, // Databases
    /\.(key|pem|cert|crt|p12|pfx)$/i,    // Certificates & Keys
    /\.(bak|dump|sql|backup|tar|gz)$/i, // Backups & Dumps
    /\.(log|env|env.*)$/i,              // Logs and environment files
    /\/package\.json$/i,                // Package manifests
    /\/google_.*\.json$/i,              // Google credentials
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(urlPath)) {
      logSecurityEvent({
        eventType: AUDIT_EVENTS.SUSPICIOUS_FILE_ACCESS_BLOCKED,
        req,
        status: 'BLOCKED',
        details: { requestedPath: req.path },
      });
      return res.status(404).send('Not Found');
    }
  }
  next();
});

// Helper to extract cookies from request header
function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// Cookie session helpers with HttpOnly, SameSite and dynamic Secure
function setSessionCookie(res, name, value, req, maxAgeSeconds = 7 * 24 * 3600) {
  const isHttps = req.secure || (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  let cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax`;
  if (isHttps) {
    cookie += '; Secure';
  }
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookie]);
  }
}

function clearSessionCookie(res, name, req) {
  const isHttps = req.secure || (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  let cookie = `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax`;
  if (name !== 'csrf_token') {
    cookie += '; HttpOnly';
  }
  if (isHttps) {
    cookie += '; Secure';
  }
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', [existing, cookie]);
  }
}

// Staging Gate Middleware: Protects staging environment without conflicting with Authorization: Bearer
function stagingProtectionMiddleware(req, res, next) {
  const isStagingProtected = process.env.STAGING_PROTECTION_ENABLED === 'true' ||
                             process.env.STAGING_AUTH_ENABLED === 'true' ||
                             Boolean(process.env.STAGING_PASSWORD);

  if (!isStagingProtected) {
    return next();
  }

  // Bypass health checks, diagnostics, webhooks and static asset /qrcode.png
  const bypassPaths = [
    '/api/health',
    '/api/health/ready',
    '/api/webhooks/asaas',
    '/api/webhooks/hotmart',
    '/api/analytics/event',
    '/qrcode.png'
  ];
  if (bypassPaths.includes(req.path) || req.path.startsWith('/api/webhooks/')) {
    return next();
  }

  const expectedUser = (process.env.STAGING_USER || 'raia-staging').trim();
  const expectedPassword = (process.env.STAGING_PASSWORD || '').trim();

  // Strict check: NEVER allow hardcoded default fallback passwords
  if (!expectedPassword) {
    console.error('[Staging Gate] ERRO: STAGING_PASSWORD não está configurada no ambiente.');
    return res.status(500).send('Erro de configuração: Proteção de homologação ativada, mas STAGING_PASSWORD não está configurada no servidor.');
  }

  const stagingGateSecret = crypto.createHmac('sha256', expectedPassword).update(expectedUser).digest('hex');

  // 1. Session Cookie Check (Prevents repeated browser prompts and avoids Authorization: Bearer conflict)
  const gateCookie = getCookie(req, 'raia_staging_gate');
  if (gateCookie === stagingGateSecret) {
    return next();
  }

  // 2. Custom header check (for automation or scripts)
  const stagingKey = req.headers['x-staging-key'] || req.headers['x-staging-token'];
  if (stagingKey && stagingKey.trim() === expectedPassword) {
    return next();
  }

  const authHeader = req.headers.authorization;

  // 3. HTTP Basic Auth Check
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const [user, pass] = credentials.split(':');
      if (user === expectedUser && pass === expectedPassword) {
        // Set secure cookie so subsequent page navigations and API fetch calls do not re-prompt
        setSessionCookie(res, 'raia_staging_gate', stagingGateSecret, req, 7 * 24 * 3600);
        return next();
      }
    } catch (e) {
      // Invalid base64, continue to rejection
    }
  }

  // 4. Authorization: Bearer Token Check (Resolve conflict between Basic and Bearer auth)
  // If an API client or authenticated portal session sends a valid user token, allow through gate
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    try {
      const isClientToken = clientAuth.verifyToken(bearerToken);
      const isAdminToken = isClientToken ? null : db.prepare("SELECT id FROM users WHERE session_token = ? AND role = 'ADMIN' AND session_expires_at IS NOT NULL AND datetime(session_expires_at) >= datetime('now')").get(bearerToken);
      if (isClientToken || isAdminToken) {
        return next(); // Authenticated system user is granted passage through staging gate
      }
    } catch (tokenErr) {
      // Invalid token, fall through to staging rejection
    }
  }

  // 5. Response handling: JSON for API requests (avoids browser dialog hijacking), Basic Auth for HTML
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      success: false,
      error: 'Acesso restrito ao ambiente de homologação RAIA AGENTES. Autenticação de staging necessária.'
    });
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="RAIA AGENTES Homologacao"');
  return res.status(401).send('Acesso restrito ao ambiente de homologacao RAIA AGENTES. Autenticacao basica necessaria.');
}

app.use(stagingProtectionMiddleware);
app.use(express.static(path.resolve(__dirname, '../../public')));

// QR code route: serve active WhatsApp pairing QR code if present at root, or fallback to public image
app.get('/qrcode.png', (req, res) => {
  const fs = require('fs');
  const rootQr = path.resolve(__dirname, '../../qrcode.png');
  if (fs.existsSync(rootQr)) {
    return res.sendFile(rootQr);
  }
  const publicQr = path.resolve(__dirname, '../../public/qrcode.png');
  if (fs.existsSync(publicQr)) {
    return res.sendFile(publicQr);
  }
  return res.redirect('https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=RAIA_HOMOLOGACAO_SIMULATOR');
});

// Mount Client Portal APIs
app.use('/api/cliente', clientRoutes);

// Ensure official RAIA logo is available in public folder if present locally
try {
  const fs = require('fs');
  const destPng = path.resolve(__dirname, '../../public/raia-logo.png');
  // raia-logo.png is committed to git repository
} catch (e) {
  // Silent fallback in production/container
}

// Clean Public Solution & Content Routes
app.get(['/solucoes', '/solucoes.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/solucoes.html'));
});

app.get('/solucoes/:niche', (req, res) => {
  const fs = require('fs');
  const niche = req.params.niche.replace(/\.html$/, '');
  const filePath = path.resolve(__dirname, `../../public/solucoes/${niche}.html`);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  return res.redirect('/solucoes');
});

app.get(['/como-funciona', '/como-funciona.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/como-funciona.html'));
});

app.get(['/planos', '/planos.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/planos.html'));
});

app.get(['/contato', '/contato.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/contato.html'));
});

app.get(['/termos', '/termos.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/termos.html'));
});

app.get(['/privacidade', '/privacidade.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/privacidade.html'));
});

// Client Portal Isolated SPA routes
app.get(['/cliente/login', '/cliente/entrar'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/cliente/login.html'));
});

app.get(['/cliente/ativar', '/cliente/ativacao'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/cliente/ativar.html'));
});

app.get(['/cliente/recuperar-senha', '/cliente/esqueci-senha'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/cliente/recuperar-senha.html'));
});

app.get(['/cliente', '/cliente/painel', '/cliente/dashboard'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/cliente/painel.html'));
});

// Admin SPA routes: serves the admin interface (which includes the built-in adminAuthOverlay login form)
app.get(['/admin', '/admin.html', '/dashboard', '/painel'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/admin.html'));
});

app.get(['/', '/index.html', '/vitrine'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/index.html'));
});

// Multi-Tenant Authentication Middleware (Proteção 01 & 17)
function authMiddleware(req, res, next) {
  let token = null;

  // 1. Authorization header: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // 2. Custom header
  if (!token && req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  }

  // Tokens in query string are strictly rejected for authenticated APIs (Proteção 02 & 17)

  // 3. Cookie
  if (!token) {
    token = getCookie(req, 'auth_token') || getCookie(req, 'client_auth_token');
  }

  if (token) {
    // Magic links are strictly single-use and CANNOT be used as API session tokens
    const magicCheck = db.prepare('SELECT id FROM users WHERE magic_token = ?').get(token);
    if (magicCheck) {
      return res.status(401).json({
        success: false,
        error: 'Magic links são de uso único e não podem ser utilizados como Bearer token de sessão comum. Utilize o link via navegador.',
        code: 'MAGIC_TOKEN_NOT_SESSION',
      });
    }

    // Proteção 01 & 17: Validate session token strictly with expiration check
    const user = userService.getUserBySessionToken(token);
    if (user) {
      req.user = user;
      req.authMethod = 'SESSION';
      return next();
    }
  }

  // Admin API key via header (timing-safe comparison, env-configured only)
  const apiKeyHeader = req.headers['x-admin-key'] || req.headers['x-api-key'];
  if (apiKeyHeader && config.adminApiKey) {
    const keyBuf = Buffer.from(String(apiKeyHeader));
    const expectedBuf = Buffer.from(String(config.adminApiKey));
    if (keyBuf.length === expectedBuf.length && crypto.timingSafeEqual(keyBuf, expectedBuf)) {
      const admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1").get() || userService.getUserById(1);

      // Least Privilege: Prohibit using ADMIN_API_KEY on client-specific tenant routes
      if (req.path.startsWith('/api/cliente/')) {
        return res.status(403).json({
          success: false,
          error: 'Acesso negado: ADMIN_API_KEY não possui permissão para acessar rotas privativas de clientes.',
          code: 'FORBIDDEN_CLIENT_ROUTE_VIA_API_KEY',
        });
      }

      // Least Privilege: Explicitly prohibit using ADMIN_API_KEY on financial, subscription, direct sales, and catalog mutation routes
      const prohibitedPrefixesForApiKey = [
        '/api/asaas',
        '/api/admin/direct-sales',
        '/api/admin/multiproduct/subscriptions',
        '/api/admin/security',
        '/api/admin/system/backup',
        '/api/admin/products',
        '/api/admin/plans',
        '/api/admin/segments',
      ];
      if (prohibitedPrefixesForApiKey.some(p => req.path.startsWith(p))) {
        try {
          const { logSecurityEvent, AUDIT_EVENTS } = require('../services/securityAuditService');
          logSecurityEvent({
            eventType: AUDIT_EVENTS.UNAUTHORIZED_ACCESS_BLOCKED,
            userId: admin?.id,
            req,
            status: 'BLOCKED',
            details: { reason: 'api_key_forbidden_on_financial_or_sensitive_route', path: req.path },
          });
        } catch (_) {}
        return res.status(403).json({
          success: false,
          error: 'Acesso negado: ADMIN_API_KEY não possui permissão para acessar operações financeiras ou cadastrais sensíveis. Exige sessão interativa com MFA.',
          code: 'FORBIDDEN_RESTRICTED_AUTOMATION_SCOPE',
        });
      }

      if (admin) {
        req.user = admin;
        req.authMethod = 'API_KEY';

        // Traceability & Audit Logging for API Key automation usage
        try {
          const { logSecurityEvent, AUDIT_EVENTS } = require('../services/securityAuditService');
          logSecurityEvent({
            eventType: AUDIT_EVENTS.ADMIN_API_KEY_USED || 'ADMIN_API_KEY_USED',
            userId: admin.id,
            req,
            status: 'SUCCESS',
            details: { path: req.path, method: req.method },
          });
        } catch (_) {}

        return next();
      }
    }
  }

  // If unauthorized for API routes
  return res.status(401).json({
    success: false,
    error: 'Acesso não autorizado. Autenticação obrigatória.',
  });
}

// Role-Based Access Control: Require Admin
function requireAdmin(req, res, next) {
  return authMiddleware(req, res, () => {
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'Acesso negado. Recurso exclusivo para administradores.',
      });
    }

    // Setup routes allow configuring or verifying MFA for the first time without circular lockout
    const isMfaSetupPath = req.path === '/api/admin/mfa/status' ||
                           req.path === '/api/admin/mfa/setup' ||
                           req.path === '/api/admin/mfa/enable' ||
                           req.path === '/api/auth/mfa/verify' ||
                           req.path === '/api/auth/logout' ||
                           req.path === '/api/me';

    // Enforce Session MFA Policy for Interactive Sessions
    if (req.authMethod === 'SESSION') {
      const isMfaMandatory = config.adminMfaEnabled || process.env.ADMIN_MFA_ENABLED === 'true';
      const isUserMfaActive = Boolean(req.user.totp_enabled === 1 && req.user.totp_secret);
      const isGlobalMfaActive = Boolean(process.env.ADMIN_TOTP_SECRET || config.adminTotpSecret);
      const mfaConfigured = isUserMfaActive || isGlobalMfaActive;
      const isSessionVerified = Boolean(req.user.session_mfa_verified === 1);

      if ((isMfaMandatory || mfaConfigured) && !isSessionVerified && !isMfaSetupPath) {
        return res.status(403).json({
          success: false,
          error: !mfaConfigured
            ? 'Política de segurança: Acesso bloqueado pois o segundo fator (MFA) ainda não foi configurado na conta administrativa.'
            : 'Política de segurança: Acesso bloqueado pois a sessão administrativa atual não foi validada com MFA. Complete a verificação em duas etapas.',
          code: !mfaConfigured ? 'FORBIDDEN_MFA_POLICY_ENFORCEMENT' : 'FORBIDDEN_MFA_SESSION_REQUIRED',
          mfaPending: true,
          mfaSetupRequired: !mfaConfigured,
          mfaChallengeRequired: mfaConfigured,
        });
      }
    }

    return next();
  });
}

// Strict Admin Middleware requiring Interactive Session (MFA protected)
// Rejects automated API keys and any non-session authentication for human-only operations
function requireInteractiveAdmin(req, res, next) {
  return requireAdmin(req, res, () => {
    // 1. Strictly accept ONLY valid interactive sessions (never API keys or non-session tokens)
    if (!req.authMethod || req.authMethod !== 'SESSION') {
      try {
        const { logSecurityEvent, AUDIT_EVENTS } = require('../services/securityAuditService');
        logSecurityEvent({
          eventType: AUDIT_EVENTS.UNAUTHORIZED_ACCESS_BLOCKED,
          userId: req.user?.id,
          req,
          status: 'BLOCKED',
          details: { reason: 'non_session_auth_rejected_for_interactive_admin', authMethod: req.authMethod, path: req.path },
        });
      } catch (_) {}

      return res.status(403).json({
        success: false,
        error: 'Operação restrita a administradores autenticados interativamente via sessão com MFA. Automações e chaves de API não possuem permissão para esta ação.',
        code: 'FORBIDDEN_INTERACTIVE_SESSION_REQUIRED',
      });
    }

    // 2. Validate admin role and session user integrity
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'Acesso negado: privilégios administrativos requeridos.',
        code: 'FORBIDDEN_ADMIN_ROLE_REQUIRED',
      });
    }

    // 3. Setup routes allow configuring or verifying MFA
    const isMfaSetupPath = req.path === '/api/admin/mfa/status' ||
                           req.path === '/api/admin/mfa/setup' ||
                           req.path === '/api/admin/mfa/enable' ||
                           req.path === '/api/auth/mfa/verify' ||
                           req.path === '/api/auth/logout' ||
                           req.path === '/api/me';

    // 4. Enforce Session MFA Verification
    const isMfaMandatory = config.adminMfaEnabled || process.env.ADMIN_MFA_ENABLED === 'true';
    const isUserMfaActive = Boolean(req.user.totp_enabled === 1 && req.user.totp_secret);
    const isGlobalMfaActive = Boolean(process.env.ADMIN_TOTP_SECRET || config.adminTotpSecret);
    const mfaConfigured = isUserMfaActive || isGlobalMfaActive;
    const isSessionVerified = Boolean(req.user.session_mfa_verified === 1);

    if ((isMfaMandatory || mfaConfigured) && !isSessionVerified && !isMfaSetupPath) {
      return res.status(403).json({
        success: false,
        error: !mfaConfigured
          ? 'Política de segurança: Acesso restrito a administradores com segundo fator (MFA) configurado e validado.'
          : 'Política de segurança: Acesso restrito a administradores com segundo fator (MFA) validado.',
        code: !mfaConfigured ? 'FORBIDDEN_MFA_POLICY_ENFORCEMENT' : 'FORBIDDEN_MFA_SESSION_REQUIRED',
        mfaPending: true,
        mfaSetupRequired: !mfaConfigured,
        mfaChallengeRequired: mfaConfigured,
      });
    }

    return next();
  });
}

// ==========================================
// READY HEALTH CHECK ENDPOINT (EASYPANEL / DOCKER)
// Returns HTTP 200 ONLY when DB & core schema are fully operational
// ==========================================
app.get('/api/health/ready', (req, res) => {
  try {
    const dbCheck = db.prepare('SELECT 1 AS alive').get();
    if (!dbCheck || dbCheck.alive !== 1) {
      return res.status(503).json({
        status: 'not_ready',
        ready: false,
        error: 'Database connection failed'
      });
    }

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'products', 'product_plans', 'customer_subscriptions')").all();
    if (tables.length < 4) {
      return res.status(503).json({
        status: 'not_ready',
        ready: false,
        error: `Database schema incomplete (found ${tables.length}/4 core tables)`
      });
    }

    return res.status(200).json({
      status: 'ready',
      ready: true,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      mode: process.env.APP_MODE || (process.env.HOMOLOGACAO === 'true' ? 'homologacao' : 'standard'),
      database: 'connected',
      version: '1.0.0-staging'
    });
  } catch (err) {
    return res.status(503).json({
      status: 'not_ready',
      ready: false,
      error: err.message
    });
  }
});

// ==========================================
// SYSTEM HEALTH CHECK & DIAGNOSTICS ENDPOINT
// ==========================================
app.get('/api/health', async (req, res) => {
  let geminiWorking = false;
  let geminiDetails = null;

  if (config.geminiApiKey) {
    try {
      const test = await aiService.processTextMessage('Padaria 10');
      if (test && test.intent) {
        geminiWorking = true;
        geminiDetails = 'IA Gemini ativa, autenticada e respondendo normalmente.';
      } else {
        geminiWorking = false;
        geminiDetails = 'Resposta inesperada da IA.';
      }
    } catch (e) {
      geminiWorking = false;
      geminiDetails = `Erro ao testar Gemini: ${e.message}`;
    }
  } else {
    geminiDetails = 'GEMINI_API_KEY não encontrada nas variáveis de ambiente.';
  }

  const isConnected = whatsappClient.isWhatsAppConnected ? whatsappClient.isWhatsAppConnected() : false;
  const waUser = whatsappClient.getWhatsAppUser ? whatsappClient.getWhatsAppUser() : null;

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gemini: {
      configured: Boolean(config.geminiApiKey),
      working: geminiWorking,
    },
    whatsapp: {
      connected: isConnected,
    },
    personalAssistant: {
      paused: Boolean(config.pausePersonalAssistant),
    },
    asaas: {
      configured: asaasService.isConfigured(),
    },
    calendar: {
      connected: calendarService.isCalendarConnected(),
    },
  });
});

// ==========================================
// PAUSE / RESUME PERSONAL ASSISTANT
// ==========================================
app.get('/api/assistant/pause-status', requireAdmin, (req, res) => {
  const isPaused = whatsappClient.isPersonalAssistantPaused ? whatsappClient.isPersonalAssistantPaused() : true;
  res.json({
    success: true,
    paused: isPaused,
    message: isPaused
      ? 'O assistente pessoal está PAUSADO para não conflitar no mesmo número de WhatsApp.'
      : 'O assistente pessoal está ATIVO.'
  });
});

app.post('/api/assistant/toggle-pause', requireAdmin, (req, res) => {
  const current = whatsappClient.isPersonalAssistantPaused ? whatsappClient.isPersonalAssistantPaused() : true;
  const next = typeof req.body?.paused === 'boolean' ? req.body.paused : !current;
  if (whatsappClient.setPersonalAssistantPaused) {
    whatsappClient.setPersonalAssistantPaused(next);
  }
  res.json({
    success: true,
    paused: next,
    message: next
      ? 'Assistente pessoal PAUSADO com sucesso.'
      : 'Assistente pessoal REATIVADO com sucesso.'
  });
});

// ==========================================
// ASAAS PAYMENT GATEWAY INTEGRATION
// ==========================================
app.get('/api/asaas/status', requireInteractiveAdmin, async (req, res) => {
  try {
    if (!asaasService.isConfigured()) {
      return res.json({ success: false, configured: false, message: 'Asaas não configurado.' });
    }
    const [account, balance] = await Promise.all([
      asaasService.getAccount(),
      asaasService.getBalance().catch(() => ({ balance: 0 })),
    ]);
    res.json({
      success: true,
      configured: true,
      account: {
        name: account.name,
        status: account.status,
        cpfCnpj: account.cpfCnpj,
        email: account.email,
        mobilePhone: account.mobilePhone,
      },
      balance: balance?.balance ?? 0,
    });
  } catch (err) {
    console.error('Erro em /api/asaas/status:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/asaas/create-pix', requireInteractiveAdmin, async (req, res) => {
  try {
    const { name, phone, email, cpfCnpj, value, description } = req.body || {};
    if (!value || Number(value) <= 0) {
      return res.status(400).json({ success: false, error: 'Informe um valor válido para cobrança.' });
    }

    const pixCharge = await asaasService.createPixCharge({
      customerName: name,
      customerPhone: phone,
      customerEmail: email,
      customerCpf: cpfCnpj,
      value,
      description,
    });

    res.json(pixCharge);
  } catch (err) {
    console.error('Erro em /api/asaas/create-pix:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/asaas/create-link', requireInteractiveAdmin, async (req, res) => {
  try {
    const { name, description, value, maxInstallmentCount } = req.body || {};
    const link = await asaasService.createPaymentLink({
      name,
      description,
      value: value || 197.00,
      maxInstallmentCount: maxInstallmentCount || 12,
    });
    res.json(link);
  } catch (err) {
    console.error('Erro em /api/asaas/create-link:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/webhooks/asaas', async (req, res) => {
  try {
    // 1. Mandatory Asaas Webhook Authentication (Token Validation)
    if (!asaasService.validateWebhookToken(req)) {
      console.warn('[Asaas Webhook] 401 Unauthorized: token secreto ausente ou inválido.');
      return res.status(401).json({ success: false, error: 'Unauthorized: token inválido.' });
    }

    const eventData = req.body || {};
    const result = await asaasService.handleWebhookEvent(eventData);

    // Idempotent duplicate event
    if (result.duplicate) {
      return res.json({ success: true, duplicate: true, eventId: result.eventId });
    }

    // 2. WhatsApp Notification on First Payment / Activation (Strictly suppressed in Staging)
    const isStagingEnvWebhook = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging' || process.env.APP_MODE === 'homologacao';
    if (!isStagingEnvWebhook && result.isPaid) {
      const payment = eventData.payment;
      try {
        const row = db.prepare('SELECT customer_name, customer_phone, value FROM asaas_payments WHERE asaas_id = ?').get(payment?.id);
        const phone = row?.customer_phone;
        const name = row?.customer_name || 'Cliente';
        const val = Number(payment?.value || row?.value || 0).toFixed(2).replace('.', ',');

        if (phone && whatsappClient.sendWhatsAppMessage) {
          const targetJid = `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
          let confirmationMsg;
          if (result.activationUrl) {
            confirmationMsg =
              `🎉 *PAGAMENTO CONFIRMADO!* 🚀\n\n` +
              `Olá, *${name}*! Confirmamos o seu pagamento de *R$ ${val}* via Asaas.\n\n` +
              `Sua Área de Membros está liberada! Ative seu acesso e crie sua senha pelo link exclusivo abaixo (válido por 48h):\n` +
              `🔗 ${result.activationUrl}\n\n` +
              `Nossa equipe de engenharia e suporte técnico da RAIA está à sua disposição!`;
          } else {
            confirmationMsg =
              `🎉 *PAGAMENTO CONFIRMADO!* 🚀\n\n` +
              `Olá, *${name}*! Confirmamos a renovação da sua assinatura de *R$ ${val}* via Asaas.\n\n` +
              `Seu Agente de Inteligência Artificial da RAIA segue 100% ativo!\n\n` +
              `Dúvidas? Basta responder esta mensagem!`;
          }

          await whatsappClient.sendWhatsAppMessage(targetJid, confirmationMsg);
          console.log(`[Asaas Webhook] Notificação de pagamento enviada para WhatsApp ${phone}`);
        }
      } catch (waErr) {
        console.warn('[Asaas Webhook] Erro ao enviar notificação WhatsApp:', waErr.message);
      }
    }

    return res.json({ success: true, received: true, event: result.event });
  } catch (err) {
    console.error('Erro em /api/webhooks/asaas:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// HOTMART WEBHOOK (PRODUCT 8840376 - JÉSSICA START & PRO)
// ==========================================
app.post('/api/webhooks/hotmart', async (req, res) => {
  try {
    const isValid = hotmartService.validateHotmartHeader(req);
    if (!isValid) {
      console.warn('[Hotmart Webhook] Requisição rejeitada: token de validação (X-HOTMART-HOTTOK) inválido ou ausente.');
      return res.status(401).json({ success: false, error: 'Unauthorized: X-HOTMART-HOTTOK inválido ou ausente.' });
    }

    const payload = req.body || {};
    const result = await hotmartService.processWebhook(payload, whatsappClient.sendWhatsAppMessage);

    if (!result.success) {
      return res.status(500).json(result);
    }

    // If purchase was approved, dispatch Meta CAPI server-side event (Strictly suppressed in Staging)
    const isStagingHotmart = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging' || process.env.APP_MODE === 'homologacao';
    if (!isStagingHotmart && (result.action === 'USER_CREATED_PENDING' || result.action === 'USER_UPDATED')) {
      const buyer = payload.data?.buyer || {};
      const purchase = payload.data?.purchase || {};
      metaCapiService.sendMetaCapiEvent({
        eventName: 'Purchase',
        eventId: payload.id || `purchase_${purchase.transaction}`,
        userData: {
          email: buyer.email,
          phone: buyer.checkout_phone || buyer.phone,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        },
        customData: {
          currency: purchase.price?.currency_value || 'BRL',
          value: purchase.price?.value || (result.planTier === 'JESSICA_PRO' ? 89.0 : 59.0),
          contentName: result.planTier === 'JESSICA_PRO' ? 'Jéssica Pro' : 'Jéssica Start',
        },
      }).catch(() => {});
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erro em /api/webhooks/hotmart:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// MARKETING & ANALYTICS INGESTION ENDPOINTS (PROTEÇÃO 12)
// ==========================================
app.post('/api/analytics/event', analyticsLimiter, (req, res) => {
  try {
    const {
      eventName, visitorId, utmSource, utmMedium, utmCampaign,
      utmContent, utmTerm, src, sck, pageUrl, referrer, metadata
    } = req.body || {};

    analyticsService.recordEvent({
      eventName,
      visitorId,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      src,
      sck,
      pageUrl,
      referrer,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      metadata,
    });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Analytics Overview & Funnel (Protected by requireAdmin)
app.get('/api/admin/analytics/overview', requireAdmin, (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const overview = analyticsService.getMarketingOverview(days);
  return res.json(overview);
});

// Admin Affiliate Sales Report (Protected by requireAdmin)
app.get('/api/admin/analytics/affiliates', requireAdmin, (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const report = analyticsService.getAffiliateSalesOverview(days);
  return res.json(report);
});

// Memberships from Hotmart and direct RAIA contracts share the client login.
// Every operation requires an authenticated admin. No public payment approval.
app.get('/api/admin/memberships/plans', requireAdmin, (_req, res) =>
  res.json({ success: true, plans: Object.values(PLANS) }));
app.get('/admin/vendas-diretas', requireInteractiveAdmin, (_req, res) =>
  res.sendFile(path.resolve(__dirname, '../../views/admin-direct-sales.html')));
app.get('/api/admin/direct-sales', requireInteractiveAdmin, (_req, res) => {
  try { return res.json({ success: true, contracts: directSales.listContracts() }); }
  catch (err) { console.error(err); return res.status(500).json({ success: false, error: 'Erro interno.' }); }
});
app.post('/api/admin/direct-sales', requireInteractiveAdmin, async (req, res) => {
  try {
    const contract = await directSales.createDirectContract(req.body || {}, req.user.id);
    return res.status(201).json({ success: true, contract });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Erro interno.' });
  }
});
app.post('/api/admin/direct-sales/:id/confirm', requireInteractiveAdmin, (req, res) => {
  try { return res.json({ success: true, ...directSales.confirmPayment({
    contractId: req.params.id, paymentReference: req.body?.paymentReference,
    paidUntil: req.body?.paidUntil, adminId: req.user.id,
  }) }); }
  catch (e) { return res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Erro interno.' }); }
});
app.post('/api/admin/direct-sales/:id/renew', requireInteractiveAdmin, (req, res) => {
  try { return res.json({ success: true, contract: directSales.renewContract({
    contractId: req.params.id, paymentReference: req.body?.paymentReference,
    paidUntil: req.body?.paidUntil, adminId: req.user.id,
  }) }); }
  catch (e) { return res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Erro interno.' }); }
});
app.post('/api/admin/direct-sales/:id/cancel', requireInteractiveAdmin, async (req, res) => {
  try {
    const contract = await directSales.cancelContract({
      contractId: req.params.id,
      adminId: req.user.id,
      isTestRun: Boolean(req.body?.isTestRun || (process.env.NODE_ENV === 'test')),
    });
    return res.json({ success: true, contract });
  } catch (e) {
    return res.status(e.status || e.statusCode || 500).json({ success: false, error: e.message || 'Erro interno.' });
  }
});

// ==========================================
// CENTRAL DE PRODUTOS & MULTIPRODUTO ADMIN
// ==========================================

// 0. Market Segments Admin API
app.get('/api/admin/segments', requireAdmin, (req, res) => {
  try {
    const segments = productService.listSegments({ activeOnly: false });
    return res.json({ success: true, segments });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/segments', requireInteractiveAdmin, (req, res) => {
  try {
    const segment = productService.createSegment(req.body || {});
    return res.status(201).json({ success: true, segment });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/segments/:id', requireInteractiveAdmin, (req, res) => {
  try {
    const segment = productService.updateSegment(Number(req.params.id), req.body || {});
    return res.json({ success: true, segment });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/segments/:id', requireInteractiveAdmin, (req, res) => {
  try {
    const result = productService.deleteSegment(Number(req.params.id));
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/products/:id/segments', requireInteractiveAdmin, (req, res) => {
  try {
    const segments = productService.setProductSegments(Number(req.params.id), req.body?.segments || []);
    return res.json({ success: true, segments });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// 1. List all products and their plans (Catalog)
app.get('/api/admin/products', requireInteractiveAdmin, (req, res) => {
  try {
    const products = productService.listProducts({ activeOnly: false, includePlans: true });
    return res.json({ success: true, products });
  } catch (err) {
    console.error('Erro em GET /api/admin/products:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Create new product in catalog
app.post('/api/admin/products', requireInteractiveAdmin, (req, res) => {
  try {
    const product = productService.createProduct(req.body || {});
    return res.status(201).json({ success: true, product });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// 3. Update existing product
app.put('/api/admin/products/:id', requireInteractiveAdmin, (req, res) => {
  try {
    const product = productService.updateProduct(Number(req.params.id), req.body || {});
    return res.json({ success: true, product });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// 4. Create new plan for a product
app.post('/api/admin/products/:id/plans', requireInteractiveAdmin, (req, res) => {
  try {
    const plan = productService.createPlan(Number(req.params.id), req.body || {});
    return res.status(201).json({ success: true, plan });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// 5. Update existing plan
app.put('/api/admin/plans/:id', requireInteractiveAdmin, (req, res) => {
  try {
    const plan = productService.updatePlan(Number(req.params.id), req.body || {});
    return res.json({ success: true, plan });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// 6. Multiproduct Metrics & Financial Reporting
app.get('/api/admin/multiproduct/metrics', requireAdmin, (req, res) => {
  try {
    const metrics = productService.getMultiproductMetrics();
    return res.json({ success: true, metrics });
  } catch (err) {
    console.error('Erro em /api/admin/multiproduct/metrics:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 7. List Subscriptions Across Products
app.get('/api/admin/multiproduct/subscriptions', requireInteractiveAdmin, (req, res) => {
  try {
    const { productId, status, origin, limit } = req.query;
    const subscriptions = productService.listAllSubscriptions({
      productId: productId ? Number(productId) : undefined,
      status: status || undefined,
      origin: origin || undefined,
      limit: limit ? Number(limit) : 100,
    });
    return res.json({ success: true, subscriptions });
  } catch (err) {
    console.error('Erro em /api/admin/multiproduct/subscriptions:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Create Customer Subscription (Multi-Product Contract)
app.post('/api/admin/multiproduct/subscriptions', requireInteractiveAdmin, (req, res) => {
  try {
    const sub = productService.createCustomerSubscription({
      ...req.body,
      adminId: req.user.id,
    });
    return res.status(201).json({ success: true, subscription: sub });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// 9. Cancel Specific Product Subscription
app.post('/api/admin/multiproduct/subscriptions/:id/cancel', requireInteractiveAdmin, async (req, res) => {
  try {
    const sub = await productService.cancelSubscription(Number(req.params.id), {
      reason: req.body?.reason,
      adminId: req.user.id,
    });
    return res.json({ success: true, subscription: sub });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ success: false, error: err.message });
  }
});

// 10. Renew Specific Product Subscription
app.post('/api/admin/multiproduct/subscriptions/:id/renew', requireInteractiveAdmin, (req, res) => {
  try {
    const { paidUntil, gatewayPaymentId, reason } = req.body || {};
    if (!paidUntil) {
      return res.status(400).json({ success: false, error: 'paidUntil é obrigatório para renovação.' });
    }
    const sub = productService.renewSubscription(Number(req.params.id), paidUntil, {
      gatewayPaymentId,
      reason,
      adminId: req.user.id,
    });
    return res.json({ success: true, subscription: sub });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/asaas/payments', requireInteractiveAdmin, async (req, res) => {
  try {
    const localPayments = db.prepare('SELECT * FROM asaas_payments ORDER BY created_at DESC LIMIT 50').all();

    let livePayments = [];
    if (asaasService.isConfigured()) {
      try {
        const liveRes = await asaasService.listPayments({ limit: 30 });
        livePayments = liveRes?.data || [];
      } catch (e) {
        console.warn('Erro ao listar cobranças ao vivo do Asaas:', e.message);
      }
    }

    res.json({
      success: true,
      localPayments,
      livePayments,
    });
  } catch (err) {
    console.error('Erro em /api/asaas/payments:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/leads', requireAdmin, (req, res) => {
  try {
    const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100').all();
    res.json({
      success: true,
      leads,
    });
  } catch (err) {
    console.error('Erro em /api/admin/leads:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/lead-conversation/:phone', requireAdmin, (req, res) => {
  try {
    const cleanPhone = String(req.params.phone || '').replace(/\D/g, '');
    const suffix = cleanPhone.length >= 8 ? cleanPhone.slice(-8) : cleanPhone;
    const messages = db.prepare(`
      SELECT * FROM agent_messages
      WHERE phone = ? OR phone LIKE ?
      ORDER BY id ASC
    `).all(cleanPhone, `%${suffix}`);
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// BUSINESS & OFFER ANALYZER (WISER STYLE)
// ==========================================
app.post('/api/admin/analyze-business', requireAdmin, async (req, res) => {
  try {
    const { url, description, niche, companyName } = req.body || {};
    if (!url && !description) {
      return res.status(400).json({ success: false, error: 'Por favor, informe a URL do site ou uma descrição da empresa.' });
    }
    const result = await businessAnalyzerService.analyzeBusiness({ url, description, niche, companyName });
    res.json(result);
  } catch (err) {
    console.error('Erro em /api/admin/analyze-business:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/business-analyses', requireAdmin, (req, res) => {
  try {
    const list = businessAnalyzerService.listAnalyses(50);
    res.json({ success: true, analyses: list });
  } catch (err) {
    console.error('Erro em /api/admin/business-analyses:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/business-analyses/:id', requireAdmin, (req, res) => {
  try {
    const success = businessAnalyzerService.deleteAnalysis(req.params.id);
    res.json({ success });
  } catch (err) {
    console.error('Erro ao deletar análise:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PUBLIC LEAD TEST AGENT (LIVE DEMO ON USER'S WHATSAPP)
// ==========================================
const AGENT_MESSAGES = {
  SALON: (name) =>
    `✨ Olá, *${name}*! Aqui é a *Jéssica*, assistente de atendimento da RAIA para Salões de Beleza e Estética! 💇‍♀️💅\n\n` +
    `Recebi sua solicitação no nosso site e já estou aqui no seu WhatsApp para você ver como funciona na prática!\n\n` +
    `Eu respondo dúvidas sobre procedimentos, valores informados pelo salão, horários de funcionamento e organizo as preferências de agendamento das clientes para facilitar o dia a dia da sua equipe.\n\n` +
    `👉 *Diga um serviço que você gostaria de consultar como teste* (por exemplo: _"Quero ver horários para corte e escova amanhã às 14h"_)?`,

  CLINIC: (name) =>
    `👋 Olá, *${name}*! Sou a *Sofia*, assistente de atendimento e recepção da clínica (equipe da Dra. Raphaela). 🩺✨\n\n` +
    `Recebi o seu contato no site da RAIA e estou pronta para demonstrar como acolho pacientes no WhatsApp, passo informações sobre horários, especialidades, convênios cadastrados e organizo solicitações de agendamento para a equipe de recepção.\n\n` +
    `👉 *Faça uma pergunta de teste como se fosse um paciente* (por exemplo: _"Vocês atendem Unimed?"_ ou _"Quais os horários disponíveis para dermatologia?"_)?`,

  RESTAURANT: (name) =>
    `🍕 Olá, *${name}*! Aqui é o *ChefBot*, assistente da RAIA para Restaurantes, Hamburguerias e Delivery! 🍔🛵\n\n` +
    `Recebi seu pedido de demonstração! Comigo no WhatsApp, seus clientes consultam o cardápio, tiram dúvidas de itens e adicionais, informam o endereço e organizam o pedido de forma clara para sua cozinha produzir.\n\n` +
    `👉 *Experimente consultar nosso cardápio de teste* (escreva: _"Quero ver o cardápio"_ ou _"Qual o valor da pizza de calabresa?"_)!`,

  LEGAL: (name) =>
    `⚖️ Olá, *${name}*. Sou o *Lex*, assistente de atendimento da RAIA para Escritórios de Advocacia.\n\n` +
    `Fui programado para recepcionar interessados no WhatsApp, coletar as informações iniciais do caso de forma organizada e direcionar o agendamento direto com o advogado responsável pelo assunto.\n\n` +
    `👉 *Envie uma dúvida inicial de teste* (por exemplo: _"Gostaria de agendar uma consulta sobre rescisão contratual"_)?`,

  REAL_ESTATE: (name) =>
    `🏡 Olá, *${name}*! Aqui é o *ImobBot*, assistente de IA da RAIA para Imobiliárias e Corretores! 🔑\n\n` +
    `Eu atendo interessados com agilidade, coleto o perfil desejado (bairros, faixa de preço, quartos) e organizo as solicitações de visita para os corretores responsáveis darem continuidade.\n\n` +
    `👉 *Faça uma busca de teste* (por exemplo: _"Procuro apartamento de 2 quartos para alugar até R$ 3.500"_)?`,

  MECHANIC: (name) =>
    `🚗 Olá, *${name}*! Aqui é o *MecânicoBot*, assistente da RAIA para Oficinas Mecânicas e Auto Centers! 🔧\n\n` +
    `Eu tiro dúvidas sobre serviços, coleto dados básicos do veículo para agilizar orçamentos e facilito as solicitações de agendamento de revisão para sua equipe.\n\n` +
    `👉 *Faça uma pergunta de teste* (por exemplo: _"Quais serviços de revisão vocês realizam?"_)!`,

  FITNESS: (name) =>
    `💪 Olá, *${name}*! Aqui é o *Coach Fit*, assistente de atendimento da RAIA para Academias e Studios! 🏋️\n\n` +
    `Eu apresento as modalidades, planos disponíveis, horários de funcionamento e coleto solicitações para aulas experimentais para a recepção confirmar.\n\n` +
    `👉 *Faça uma simulação de teste* (por exemplo: _"Quais os horários de Pilates e como agendar aula experimental?"_)!`,

  FINANCE: (name) =>
    `📊 Olá, *${name}*! Sou o *ContaZap*, assistente de Organização Financeira da RAIA para Autônomos e MEI! 💼\n\n` +
    `Comigo você pode registrar suas entradas e despesas diárias de forma simples por texto ou áudio no WhatsApp para manter seu fluxo de caixa anotado.\n\n` +
    `👉 *Envie um registro de teste* (por exemplo: _"Almoço 35 no débito"_ ou _"Recebido 500 do cliente no Pix"_)!`,

  RENTAL_MACHINES: (name) =>
    `🏗️ Olá, *${name}*! Aqui é o *AlugaObra*, assistente da RAIA para Locação de Máquinas e Equipamentos de Construção!\n\n` +
    `Eu tiro dúvidas sobre os equipamentos disponíveis para locação (betoneiras, marteletes, andaimes), coleto período de uso e endereço da obra para sua equipe orçar o frete.\n\n` +
    `👉 *Faça uma consulta de teste* (por exemplo: _"Vocês têm betoneira 400L disponível para locar por 15 dias?"_)!`,

  CAR_DEALERSHIP: (name) =>
    `🏎️ Olá, *${name}*! Aqui é o *AutoZap*, assistente da RAIA para Lojas de Veículos e Concessionárias! 🚗\n\n` +
    `Eu recebo os interessados no WhatsApp, apresento opções do estoque conforme a faixa de valor e organizo as solicitações de test-drive e propostas para a equipe de vendas.\n\n` +
    `👉 *Faça uma consulta de teste* (por exemplo: _"Estou procurando um SUV seminovo até R$ 120 mil"_)!`,
};

const NICHE_SLUG_MAP = {
  'saloes-e-beleza': { key: 'SALON', name: 'Jéssica (Salões & Beleza)' },
  'saude-e-odontologia': { key: 'CLINIC', name: 'Sofia (Saúde & Odontologia)' },
  'delivery-e-restaurantes': { key: 'RESTAURANT', name: 'ChefBot (Delivery & Restaurantes)' },
  'advocacia': { key: 'LEGAL', name: 'Lex (Advocacia & Jurídico)' },
  'imobiliarias-e-corretores': { key: 'REAL_ESTATE', name: 'ImobBot (Imobiliárias & Corretores)' },
  'oficinas-e-auto-centers': { key: 'MECHANIC', name: 'MecânicoBot (Oficinas & Auto Centers)' },
  'academias-e-pilates': { key: 'FITNESS', name: 'Coach Fit (Academias & Pilates)' },
  'financeiro-e-mei': { key: 'FINANCE', name: 'ContaZap (Financeiro & MEI)' },
  'construcao-e-locacao': { key: 'RENTAL_MACHINES', name: 'AlugaObra (Construção & Locação)' },
  'veiculos-e-seminovos': { key: 'CAR_DEALERSHIP', name: 'AutoZap (Veículos & Seminovos)' },
};

async function handleLeadTestRequest(req, res) {
  try {
    const { name, phone, nicheSlug } = req.body || {};
    let agentKey = req.body.agentKey;
    let agentName = req.body.agentName;

    if (nicheSlug && (!agentKey || !agentName)) {
      const mapped = NICHE_SLUG_MAP[nicheSlug];
      if (mapped) {
        agentKey = mapped.key;
        agentName = mapped.name;
      }
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Por favor, informe o seu nome.' });
    }

    let cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ success: false, error: 'Por favor, informe um WhatsApp válido com DDD (ex: 11999998888).' });
    }

    if (cleanPhone.length === 10 || cleanPhone.length === 11) {
      cleanPhone = '55' + cleanPhone;
    }

    const safeName = name.trim().split(' ')[0];
    const templateFn = AGENT_MESSAGES[agentKey] || ((n) =>
      `Olá, *${n}*! 🚀 Aqui é o assistente virtual da RAIA para o seu negócio!\n\n` +
      `Recebi seu pedido de teste através do nosso site. Estou pronto para atender seus clientes no WhatsApp 24 horas por dia com máxima velocidade e inteligência.\n\n` +
      `Como posso ajudar você hoje?`
    );

    const messageText = templateFn(safeName);
    const targetJid = `${cleanPhone}@s.whatsapp.net`;

    let leadId = null;
    try {
      const info = db.prepare(`
        INSERT INTO leads (name, phone, agent_key, agent_name, status)
        VALUES (?, ?, ?, ?, 'SENT')
      `).run(name.trim(), cleanPhone, agentKey || 'OTHER', agentName || 'Agente RAIA');
      leadId = info.lastInsertRowid;
    } catch (e) {
      console.warn('Erro ao salvar lead na tabela leads:', e.message);
    }

    const isConnected = whatsappClient.isWhatsAppConnected ? whatsappClient.isWhatsAppConnected() : false;

    if (isConnected) {
      await whatsappClient.sendWhatsAppMessage(targetJid, messageText);
      console.log(`[Lead Teste] Mensagem do agente ${agentName || agentKey} enviada para ${cleanPhone} (${name})`);
      
      // Register welcome message in conversation history so the agent continues naturally
      try {
        agentChatService.recordMessage(leadId, cleanPhone, agentKey || 'OTHER', 'assistant', messageText);
      } catch (errRec) {
        console.warn('Erro ao registrar mensagem inicial no histórico do agente:', errRec.message);
      }

      // Track lead in marketing analytics & Meta CAPI
      try {
        analyticsService.recordEvent({
          eventName: 'demo_requested',
          utmSource: req.body?.utmSource || 'site',
          pageUrl: req.headers.referer || `${config.baseUrl}/solucoes/${nicheSlug}`,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          metadata: { niche: nicheSlug, agentKey, name: name.trim() },
        });

        metaCapiService.sendMetaCapiEvent({
          eventName: 'Lead',
          eventSourceUrl: req.headers.referer || config.baseUrl,
          userData: {
            phone: cleanPhone,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          },
          customData: {
            contentName: agentName || agentKey,
            status: 'DEMO_REQUESTED',
          },
        }).catch(() => {});
      } catch (trackErr) {}

      return res.json({
        success: true,
        sent: true,
        phone: cleanPhone,
        message: `Mensagem enviada com sucesso para o WhatsApp ${cleanPhone}! Verifique seu celular agora.`
      });
    } else {
      console.warn(`[Lead Teste] WhatsApp desconectado ao tentar enviar para ${cleanPhone}`);
      const directUrl = `https://wa.me/5511951364159?text=${encodeURIComponent(`Olá, sou ${name.trim()} (${cleanPhone}). Gostaria de testar o Agente ${agentName || agentKey}!`)}`;
      return res.json({
        success: true,
        sent: false,
        fallbackUrl: directUrl,
        message: `Contato registrado com sucesso! O assistente está conectando. Você também pode abrir diretamente.`
      });
    }
  } catch (err) {
    console.error('Erro em /api/test-agent / leads/request-test:', err);
    return res.status(500).json({ success: false, error: 'Erro interno ao processar envio: ' + err.message });
  }
}

app.post('/api/test-agent', leadTestLimiter, handleLeadTestRequest);
app.post('/api/leads/request-test', leadTestLimiter, handleLeadTestRequest);

// ==========================================
// 1-CLICK PASSWORDLESS MAGIC LINK ENDPOINT (PROTEÇÃO 17)
// ==========================================
app.get('/auth/magic', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('Token de acesso não fornecido.');
  }

  const user = userService.getUserByMagicToken(token);
  if (!user) {
    logSecurityEvent({
      eventType: AUDIT_EVENTS.MAGIC_TOKEN_EXPIRED,
      req,
      status: 'FAILED',
      details: { reason: 'invalid_or_expired' }
    });
    return res.status(401).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Link Expirado | Assistente Zap</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-[#080C15] text-slate-100 flex items-center justify-center min-h-screen p-4 text-center font-sans">
        <div class="max-w-md bg-[#131B2E] p-8 rounded-2xl border border-red-500/30 shadow-2xl">
          <div class="w-16 h-16 mx-auto mb-4 bg-red-500/10 rounded-full flex items-center justify-center text-red-400 text-3xl">⚠️</div>
          <h2 class="text-2xl font-bold mb-2">Link Expirado ou Inválido</h2>
          <p class="text-slate-400 mb-6">Este link de acesso ao painel não é mais válido ou já expirou.</p>
          <div class="text-sm text-slate-300 bg-[#0F1626] p-4 rounded-xl border border-slate-800">
            👉 Envie a palavra <b class="text-purple-400">"painel"</b> no WhatsApp para receber um novo link instantâneo!
          </div>
        </div>
      </body>
      </html>
    `);
  }

  // Proteção 01 & 17: Consume single-use magic token IMMEDIATELY
  userService.consumeMagicToken(user.id);

  // Proteção 01 & 17: Issue a dedicated, persistent session token
  // If user is ADMIN: Magic links CANNOT grant full MFA verified administrative access!
  // It issues a pre-authentication session with session_mfa_verified = 0.
  const { sessionToken } = userService.createUserSession(user.id, 7, { mfaVerified: false });

  // Set secure auth cookie with HttpOnly & SameSite=Lax (7 days)
  setSessionCookie(res, 'auth_token', sessionToken, req, 7 * 24 * 3600);

  // Issue Double-Submit CSRF cookie (readable by frontend)
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const isHttps = req.secure || (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  let csrfCookie = `csrf_token=${csrfToken}; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`;
  if (isHttps) csrfCookie += '; Secure';
  res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), csrfCookie].flat().filter(Boolean));

  logSecurityEvent({
    eventType: AUDIT_EVENTS.MAGIC_TOKEN_USED,
    userId: user.id,
    req,
    status: 'SUCCESS',
    details: { destination: '/admin' }
  });

  // Redirect to admin panel WITHOUT leaking token into query string
  return res.redirect('/admin');
});

// ==========================================
// DIRECT ADMIN LOGIN VIA API (TRUE TOTP MFA) (PROTEÇÃO 01 & 09)
// ==========================================
app.post('/api/auth/admin-login', adminLoginLimiter, (req, res) => {
  const { password, mfaCode } = req.body || {};
  const input = typeof password === 'string' ? password.trim() : '';

  if (!input) {
    return res.status(400).json({ success: false, error: 'Por favor, informe a senha de administrador.' });
  }

  const configuredPass = (config.adminPassword || '').trim();
  if (!configuredPass) {
    return res.status(500).json({ success: false, error: 'ADMIN_PASSWORD não configurada no servidor.' });
  }

  // Timing-safe comparison for primary authentication
  const timingSafeMatch = (candidate, secret) => {
    if (!secret || !candidate) return false;
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    return crypto.timingSafeEqual(a, b);
  };

  // Primary authentication: accepts ONLY admin password (PIN is NEVER accepted as primary password)
  if (!timingSafeMatch(input, configuredPass)) {
    logSecurityEvent({
      eventType: AUDIT_EVENTS.ADMIN_LOGIN_FAILED,
      req,
      status: 'FAILED',
      details: { reason: 'invalid_credentials' },
    });
    return res.status(401).json({
      success: false,
      error: 'Senha de administrador incorreta.'
    });
  }

  // Find or ensure master admin user
  let admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1").get();
  if (!admin) {
    admin = userService.getUserById(1);
  }
  if (!admin) {
    const defaultPhone = '5511951364159';
    const created = userService.getOrCreateUser({ phoneNumber: defaultPhone, name: 'Administrador' });
    admin = created.user;
    db.prepare("UPDATE users SET role = 'ADMIN', plan = 'PRO' WHERE id = ?").run(admin.id);
  }

  // Determine if MFA is active for this admin
  const isMfaMandatory = Boolean(config.adminMfaEnabled || process.env.ADMIN_MFA_ENABLED === 'true');
  const isGlobalMfa = isMfaMandatory && Boolean(process.env.ADMIN_TOTP_SECRET || config.adminTotpSecret);
  const isUserMfa = Boolean(admin && admin.totp_enabled === 1 && admin.totp_secret);
  const isMfaActive = isGlobalMfa || isUserMfa;
  const totpSecret = (admin && admin.totp_enabled === 1 && admin.totp_secret) ? admin.totp_secret : (process.env.ADMIN_TOTP_SECRET || config.adminTotpSecret);

  let mfaValid = false;
  let recoveryCodeUsed = false;

  if (isMfaActive && totpSecret) {
    if (!mfaCode) {
      logSecurityEvent({
        eventType: AUDIT_EVENTS.ADMIN_MFA_CHALLENGE,
        userId: admin.id,
        req,
        status: 'CHALLENGE_REQUIRED',
      });
      return res.status(200).json({
        success: false,
        mfaRequired: true,
        message: 'Autenticação multifator (TOTP) obrigatória para administradores. Informe o código de 6 dígitos gerado pelo seu aplicativo autenticador.',
      });
    }

    const cleanMfaCode = String(mfaCode).trim();

    // Prevent using the same credential as primary password and MFA code
    if (cleanMfaCode === input) {
      logSecurityEvent({
        eventType: AUDIT_EVENTS.ADMIN_MFA_FAILED,
        userId: admin.id,
        req,
        status: 'FAILED',
        details: { reason: 'mfa_identical_to_primary_password' },
      });
      return res.status(401).json({
        success: false,
        error: 'O código MFA deve ser um código temporário independente (TOTP), não a senha primária.',
      });
    }

    // Verify TOTP token with ±1 window (±30s drift tolerance)
    const totpVerification = totpService.verifyToken(cleanMfaCode, totpSecret, { window: 1 });
    mfaValid = totpVerification.valid;

    // Check single-use hashed recovery codes if TOTP verification failed
    if (!mfaValid && admin.totp_recovery_codes) {
      try {
        const storedCodes = JSON.parse(admin.totp_recovery_codes);
        if (Array.isArray(storedCodes) && storedCodes.length > 0) {
          // Check hashed codes first (Proteção 01)
          const recCheck = totpService.verifyRecoveryCode(cleanMfaCode, storedCodes);
          if (recCheck.valid) {
            mfaValid = true;
            recoveryCodeUsed = true;
            storedCodes.splice(recCheck.matchedIndex, 1);
            db.prepare('UPDATE users SET totp_recovery_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(storedCodes), admin.id);
          } else {
            // Backward-compatible check for legacy plain-text recovery codes (auto-migrating to hashes)
            const plainIdx = storedCodes.findIndex(c => typeof c === 'string' && c.toUpperCase().replace(/[\s-]/g, '') === cleanMfaCode.toUpperCase().replace(/[\s-]/g, ''));
            if (plainIdx !== -1) {
              mfaValid = true;
              recoveryCodeUsed = true;
              storedCodes.splice(plainIdx, 1);
              const updatedHashes = storedCodes.map(c => c.length === 64 ? c : totpService.hashRecoveryCode(c));
              db.prepare('UPDATE users SET totp_recovery_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(updatedHashes), admin.id);
            }
          }
        }
      } catch (_) {}
    }

    if (!mfaValid) {
      logSecurityEvent({
        eventType: AUDIT_EVENTS.ADMIN_MFA_FAILED,
        userId: admin.id,
        req,
        status: 'FAILED',
        details: { reason: totpVerification.reason || 'invalid_mfa_code' },
      });
      return res.status(401).json({
        success: false,
        error: 'Código MFA incorreto ou expirado. Verifique o relógio do seu dispositivo.',
      });
    }

    logSecurityEvent({
      eventType: AUDIT_EVENTS.ADMIN_MFA_SUCCESS,
      userId: admin.id,
      req,
      status: 'SUCCESS',
      details: { method: recoveryCodeUsed ? 'recovery_code' : 'totp' }
    });
  }

  // Generate 7-day session token via dedicated session model (Proteção 01 & 17)
  const isMfaFullyVerified = isMfaActive ? (mfaValid === true) : !isMfaMandatory;
  const { sessionToken } = userService.createUserSession(admin.id, 7, { mfaVerified: isMfaFullyVerified });

  // Set secure HttpOnly cookie
  setSessionCookie(res, 'auth_token', sessionToken, req, 7 * 24 * 3600);

  // Issue CSRF cookie
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const isHttps = req.secure || (req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  let csrfCookie = `csrf_token=${csrfToken}; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`;
  if (isHttps) csrfCookie += '; Secure';
  res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), csrfCookie].flat().filter(Boolean));

  logSecurityEvent({
    eventType: AUDIT_EVENTS.ADMIN_LOGIN_SUCCESS,
    userId: admin.id,
    req,
    status: 'SUCCESS',
    details: { mfaVerified: isMfaFullyVerified },
  });

  const mfaSetupRequired = Boolean(isMfaMandatory && !isMfaActive);

  return res.json({
    success: true,
    mfaSetupRequired,
    mfaVerified: isMfaFullyVerified,
    token: sessionToken,
    csrfToken,
    user: {
      id: admin.id,
      name: admin.name || 'Administrador',
      phoneNumber: admin.phone_number,
      role: 'ADMIN',
      plan: 'PRO',
      mfaVerified: isMfaFullyVerified,
      mfaPending: mfaSetupRequired,
      mfaSetupRequired,
    },
    message: mfaSetupRequired
      ? 'Senha mestra validada. É obrigatório configurar a autenticação em duas etapas (MFA/TOTP) para acessar o painel.'
      : 'Autenticação administrativa realizada com sucesso.',
  });
});

// ==========================================
// ADMIN MFA CHALLENGE VERIFICATION (FOR PRE-AUTH SESSIONS / MAGIC LINKS)
// ==========================================
app.post('/api/auth/mfa/verify', adminMfaLimiter, requireAdmin, (req, res) => {
  if (req.authMethod !== 'SESSION' || !req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      error: 'Operação restrita a administradores com sessão interativa ativa.',
      code: 'FORBIDDEN_INTERACTIVE_ADMIN_REQUIRED',
    });
  }

  const { mfaCode } = req.body || {};
  const cleanMfaCode = typeof mfaCode === 'string' ? mfaCode.trim() : '';
  if (!cleanMfaCode) {
    return res.status(400).json({
      success: false,
      error: 'Informe o código de 6 dígitos do autenticador ou código de recuperação.',
    });
  }

  const isMfaMandatory = Boolean(config.adminMfaEnabled || process.env.ADMIN_MFA_ENABLED === 'true');
  const isGlobalMfa = isMfaMandatory && Boolean(process.env.ADMIN_TOTP_SECRET || config.adminTotpSecret);
  const isUserMfa = Boolean(req.user.totp_enabled === 1 && req.user.totp_secret);
  const totpSecret = (req.user.totp_enabled === 1 && req.user.totp_secret)
    ? req.user.totp_secret
    : (process.env.ADMIN_TOTP_SECRET || config.adminTotpSecret);

  if (!totpSecret) {
    return res.status(400).json({
      success: false,
      error: 'MFA não está configurado nesta conta de administrador.',
      mfaSetupRequired: true,
    });
  }

  const totpVerification = totpService.verifyToken(cleanMfaCode, totpSecret, { window: 1 });
  let mfaValid = totpVerification.valid;
  let recoveryCodeUsed = false;

  if (!mfaValid && req.user.totp_recovery_codes) {
    try {
      const storedCodes = JSON.parse(req.user.totp_recovery_codes);
      if (Array.isArray(storedCodes) && storedCodes.length > 0) {
        const recCheck = totpService.verifyRecoveryCode(cleanMfaCode, storedCodes);
        if (recCheck.valid) {
          mfaValid = true;
          recoveryCodeUsed = true;
          storedCodes.splice(recCheck.matchedIndex, 1);
          db.prepare('UPDATE users SET totp_recovery_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(JSON.stringify(storedCodes), req.user.id);
        } else {
          const plainIdx = storedCodes.findIndex(c => typeof c === 'string' && c.toUpperCase().replace(/[\s-]/g, '') === cleanMfaCode.toUpperCase().replace(/[\s-]/g, ''));
          if (plainIdx !== -1) {
            mfaValid = true;
            recoveryCodeUsed = true;
            storedCodes.splice(plainIdx, 1);
            const updatedHashes = storedCodes.map(c => c.length === 64 ? c : totpService.hashRecoveryCode(c));
            db.prepare('UPDATE users SET totp_recovery_codes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(JSON.stringify(updatedHashes), req.user.id);
          }
        }
      }
    } catch (_) {}
  }

  if (!mfaValid) {
    logSecurityEvent({
      eventType: AUDIT_EVENTS.ADMIN_MFA_FAILED,
      userId: req.user.id,
      req,
      status: 'FAILED',
      details: { reason: totpVerification.reason || 'invalid_mfa_code' },
    });
    return res.status(401).json({
      success: false,
      error: 'Código MFA incorreto ou expirado. Verifique o relógio do seu dispositivo.',
    });
  }

  userService.setSessionMfaVerified(req.user.id, true);

  logSecurityEvent({
    eventType: AUDIT_EVENTS.ADMIN_MFA_SUCCESS,
    userId: req.user.id,
    req,
    status: 'SUCCESS',
    details: { method: recoveryCodeUsed ? 'recovery_code' : 'totp', origin: 'mfa_verify_endpoint' },
  });

  return res.json({
    success: true,
    mfaVerified: true,
    message: 'Segundo fator validado com sucesso.',
  });
});

// Admin MFA Status: Check whether MFA is currently enforced or active
app.get('/api/admin/mfa/status', requireInteractiveAdmin, (req, res) => {
  const admin = db.prepare('SELECT totp_enabled, totp_recovery_codes FROM users WHERE id = ?').get(req.user.id);
  const isGlobalMfa = (config.adminMfaEnabled || process.env.ADMIN_MFA_ENABLED === 'true') && Boolean(process.env.ADMIN_TOTP_SECRET || config.adminTotpSecret);
  const userMfaEnabled = Boolean(admin && admin.totp_enabled === 1);

  let hasLegacyRecoveryCodes = false;
  if (userMfaEnabled && admin && admin.totp_recovery_codes) {
    try {
      const parsed = JSON.parse(admin.totp_recovery_codes);
      const currentFp = totpService.getKeyFingerprint();
      if (Array.isArray(parsed) && parsed.length > 0) {
        hasLegacyRecoveryCodes = parsed.some(c => typeof c === 'string' && !c.startsWith(`hmac:v2:${currentFp}:`));
      }
    } catch (_) {}
  }

  return res.json({
    success: true,
    enabled: userMfaEnabled || isGlobalMfa,
    isGlobalMfa,
    userMfaEnabled,
    hasLegacyRecoveryCodes,
  });
});

// Admin MFA: Secure Regeneration of Recovery Codes by Authenticated Admin
app.post('/api/admin/mfa/regenerate-recovery-codes', adminMfaLimiter, requireInteractiveAdmin, (req, res) => {
  const { password } = req.body || {};
  const configuredPass = (config.adminPassword || '').trim();
  const timingSafeMatch = (candidate, expected) => {
    if (!expected || !candidate) return false;
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  };

  if (!password || !timingSafeMatch(String(password).trim(), configuredPass)) {
    return res.status(401).json({ success: false, error: 'Senha de administrador obrigatória e incorreta para regenerar códigos de recuperação.' });
  }

  const admin = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!admin || admin.totp_enabled !== 1) {
    return res.status(400).json({ success: false, error: 'MFA não está ativo para este administrador.' });
  }

  const { plainCodes, hashedCodes } = totpService.generateHashedRecoveryCodes(8);

  db.prepare(`
    UPDATE users
    SET totp_recovery_codes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(hashedCodes), req.user.id);

  logSecurityEvent({
    eventType: AUDIT_EVENTS.ADMIN_MFA_RECOVERY_CODES_REGENERATED,
    userId: req.user.id,
    req,
    status: 'SUCCESS',
    details: { count: plainCodes.length },
  });

  return res.json({
    success: true,
    recoveryCodes: plainCodes,
    message: 'Novos códigos de recuperação gerados com sucesso e protegidos com a chave primária atual.',
  });
});

// Admin MFA Setup: Generate TOTP Secret & In-Process Local QR Code (Proteção 01)
app.post('/api/admin/mfa/setup', requireInteractiveAdmin, async (req, res) => {
  const secret = totpService.generateSecret();
  const otpAuthUri = totpService.generateOtpAuthUri({
    secret,
    accountName: req.user.email || req.user.phone_number || 'admin@raiaagentes.com.br',
    issuer: 'RAIA AGENTES'
  });

  // Pure in-process local QR code generation - NEVER sends secrets to external web services
  let qrCodeDataUrl = null;
  try {
    const QRCode = require('qrcode');
    qrCodeDataUrl = await QRCode.toDataURL(otpAuthUri, {
      width: 220,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
  } catch (qrErr) {
    console.warn('[Admin MFA Setup] Aviso ao gerar QR code local:', qrErr.message);
  }

  return res.json({
    success: true,
    secret,
    otpAuthUri,
    qrCodeDataUrl,
  });
});

// Admin MFA Enable: Reinforced Authentication & Server-Generated Hashed Recovery Codes (Proteção 01)
app.post('/api/admin/mfa/enable', adminMfaLimiter, requireInteractiveAdmin, (req, res) => {
  const { password, secret, code } = req.body || {};
  if (!secret || !code) {
    return res.status(400).json({ success: false, error: 'Secret e código TOTP são obrigatórios para ativação.' });
  }

  // Reinforced Authentication: Admin password is required to enable MFA
  const configuredPass = (config.adminPassword || '').trim();
  const timingSafeMatch = (candidate, expected) => {
    if (!expected || !candidate) return false;
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  };

  if (!password || !timingSafeMatch(String(password).trim(), configuredPass)) {
    return res.status(401).json({ success: false, error: 'Senha de administrador obrigatória e incorreta para ativar MFA.' });
  }

  // Validate TOTP code against provided secret
  const verification = totpService.verifyToken(String(code).trim(), secret, { window: 1 });
  if (!verification.valid) {
    return res.status(400).json({ success: false, error: 'Código TOTP incorreto. Verifique o código exibido no seu aplicativo autenticador.' });
  }

  // Server strictly generates fresh recovery codes and stores ONLY hashes in DB
  const { plainCodes, hashedCodes } = totpService.generateHashedRecoveryCodes(8);
  const encryptedSecret = totpService.encryptSecret(secret);

  db.prepare(`
    UPDATE users
    SET totp_secret = ?,
        totp_enabled = 1,
        totp_recovery_codes = ?,
        session_mfa_verified = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(encryptedSecret, JSON.stringify(hashedCodes), req.user.id);

  logSecurityEvent({
    eventType: AUDIT_EVENTS.ADMIN_MFA_ENABLED,
    userId: req.user.id,
    req,
    status: 'SUCCESS',
  });

  return res.json({
    success: true,
    recoveryCodes: plainCodes,
    message: 'Autenticação multifator (TOTP) ativada com sucesso. Guarde seus 8 códigos de recuperação em local seguro.',
  });
});

// Admin MFA Disable: Reinforced Authentication (Requires admin password + current MFA verification) (Proteção 01)
app.post('/api/admin/mfa/disable', adminMfaLimiter, requireInteractiveAdmin, (req, res) => {
  const { password, code } = req.body || {};
  const configuredPass = (config.adminPassword || '').trim();

  const timingSafeMatch = (candidate, expected) => {
    if (!expected || !candidate) return false;
    const a = crypto.createHash('sha256').update(candidate).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  };

  // 1. Password verification
  if (!password || !timingSafeMatch(String(password).trim(), configuredPass)) {
    return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
  }

  // 2. Reinforced second factor verification if MFA is enrolled
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (admin && admin.totp_enabled === 1 && admin.totp_secret) {
    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Código TOTP ou código de recuperação é obrigatório para confirmar a desativação do MFA.',
      });
    }

    const cleanCode = String(code).trim();
    const totpVerification = totpService.verifyToken(cleanCode, admin.totp_secret, { window: 1 });
    let codeValid = totpVerification.valid;

    if (!codeValid && admin.totp_recovery_codes) {
      try {
        const storedCodes = JSON.parse(admin.totp_recovery_codes);
        const recCheck = totpService.verifyRecoveryCode(cleanCode, storedCodes);
        if (recCheck.valid) {
          codeValid = true;
        }
      } catch (_) {}
    }

    if (!codeValid) {
      return res.status(401).json({ success: false, error: 'Código de confirmação MFA inválido.' });
    }
  }

  db.prepare(`
    UPDATE users
    SET totp_enabled = 0,
        totp_secret = NULL,
        totp_recovery_codes = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.user.id);

  logSecurityEvent({
    eventType: AUDIT_EVENTS.ADMIN_MFA_DISABLED,
    userId: req.user.id,
    req,
    status: 'SUCCESS',
  });

  return res.json({ success: true, message: 'Autenticação multifator (TOTP) desativada.' });
});

// ==========================================
// ADMIN & CLIENT LOGOUT (REVOKES TOKEN IN DB & CLEARS COOKIES)
// ==========================================
app.post('/api/auth/logout', (req, res) => {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    token = getCookie(req, 'auth_token') || getCookie(req, 'client_auth_token');
  }

  if (token) {
    try {
      const user = db.prepare('SELECT id FROM users WHERE session_token = ?').get(token);
      if (user?.id) {
        userService.revokeUserTokens(user.id);
      }
    } catch (err) {
      console.error('[Logout] Erro ao revogar sessão no SQLite:', err);
      return res.status(500).json({
        success: false,
        error: 'Erro ao revogar sessão no banco de dados. Tente novamente.',
      });
    }
  }

  clearSessionCookie(res, 'auth_token', req);
  clearSessionCookie(res, 'client_auth_token', req);
  clearSessionCookie(res, 'csrf_token', req);
  return res.json({ success: true, message: 'Sessão encerrada com sucesso.' });
});

// ==========================================
// LOGIN & ENTRY PAGE ALIASES
// ==========================================
app.get(['/login', '/entrar'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/index.html'));
});

// ==========================================
// SHOWCASE & LANDING PAGE (PAPEL RASGADO / DESCUBRA)
// ==========================================
app.get(['/descubra', '/explore'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/explore.html'));
});


// ==========================================
// CURRENT AUTHENTICATED USER & PROFILE
// ==========================================
app.get('/api/me', authMiddleware, (req, res) => {
  const status = userService.isUserActive(req.user);
  const isMfaMandatory = config.adminMfaEnabled || process.env.ADMIN_MFA_ENABLED === 'true';
  const isUserMfaActive = Boolean(req.user.totp_enabled === 1 && req.user.totp_secret);
  const isGlobalMfaActive = Boolean(process.env.ADMIN_TOTP_SECRET || config.adminTotpSecret);
  const mfaConfigured = isUserMfaActive || isGlobalMfaActive;
  const isMfaVerified = Boolean(req.user.session_mfa_verified === 1);
  const isMfaRequired = Boolean(req.user.role === 'ADMIN' && (isMfaMandatory || mfaConfigured));

  const mfaPending = Boolean(req.user.role === 'ADMIN' && isMfaRequired && !isMfaVerified);
  const mfaSetupRequired = Boolean(req.user.role === 'ADMIN' && isMfaMandatory && !mfaConfigured);
  const mfaChallengeRequired = Boolean(req.user.role === 'ADMIN' && mfaConfigured && !isMfaVerified);

  const userObj = {
    id: req.user.id,
    phoneNumber: req.user.phone_number,
    phone: req.user.phone_number,
    name: req.user.name,
    role: req.user.role,
    plan: req.user.plan,
    trialEndsAt: req.user.trial_ends_at,
    status,
    mfaVerified: isMfaVerified,
    mfaRequired: isMfaRequired,
    mfaPending,
    mfaSetupRequired,
    mfaChallengeRequired,
  };
  res.json({
    success: true,
    user: userObj,
    data: userObj,
  });
});

// ==========================================
// ADMIN MANAGEMENT (ONLY ROLE = ADMIN)
// ==========================================
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const origin = req.query.origin ? String(req.query.origin).toUpperCase() : null;
  const users = userService.getAllUsers({ origin });
  res.json({ success: true, count: users.length, data: users });
});

app.put('/api/admin/users/:id/plan', requireInteractiveAdmin, (req, res) => {
  const { id } = req.params;
  const { plan, role } = req.body;
  const updated = userService.updateUser(id, { plan, role });
  res.json({ success: true, data: updated });
});

app.post('/api/admin/users/:id/extend-trial', requireInteractiveAdmin, (req, res) => {
  const { id } = req.params;
  const { days } = req.body;
  try {
    const result = userService.extendUserTrial(id, days || 7);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireInteractiveAdmin, (req, res) => {
  try {
    userService.deleteUser(Number(req.params.id));
    res.json({ success: true, message: 'Usuário removido com sucesso' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/invites', requireAdmin, (req, res) => {
  const invites = userService.getAllInvites();
  res.json({ success: true, count: invites.length, data: invites });
});

app.post('/api/admin/invites', requireAdmin, (req, res) => {
  const trialDays = req.body.trialDays || 7;
  const invite = userService.createInviteCode({ createdBy: req.user.id, trialDays });
  res.status(201).json({ success: true, data: invite });
});

// ==========================================
// MARKETING STUDIO API (ADMIN ONLY)
// ==========================================
app.get('/api/admin/marketing/data', requireAdmin, (req, res) => {

  const hooks = [
    {
      category: '🚨 Choque & Quebra de Padrão',
      text: 'Se você ainda abre planilha no computador para anotar gasto de padaria, você tá vivendo em 2012.'
    },
    {
      category: '🚨 Choque & Quebra de Padrão',
      text: 'Eu demiti a minha planilha financeira e agora eu só mando um áudio no WhatsApp.'
    },
    {
      category: '🚨 Choque & Quebra de Padrão',
      text: 'Por que ninguém te contou que você pode ter uma secretária pessoal com IA no seu próprio WhatsApp?'
    },
    {
      category: '💸 Dor & Desorganização',
      text: 'Você recebe seu salário dia 5 e no dia 10 já não faz ideia de para onde o dinheiro foi?'
    },
    {
      category: '💸 Dor & Desorganização',
      text: 'Quantas vezes você já pagou juros de boleto só porque esqueceu o dia do vencimento?'
    },
    {
      category: '💸 Dor & Desorganização',
      text: 'Você já tentou usar 10 aplicativos de finanças e abandonou todos na primeira semana? Olha isso aqui.'
    },
    {
      category: '⚡ Facilidade & Efeito Uau',
      text: 'Duvido você adivinhar quanto tempo eu levo para registrar um gasto e agendar uma reunião hoje.'
    },
    {
      category: '⚡ Facilidade & Efeito Uau',
      text: 'Tirei a foto da comanda do almoço e mandei no WhatsApp. Olha o que a IA fez em 2 segundos.'
    },
    {
      category: '⚡ Facilidade & Efeito Uau',
      text: 'Mandei um áudio de 5 segundos no trânsito e meu controle financeiro e minha agenda atualizaram sozinhos.'
    },
    {
      category: '💼 Autônomos & Pequenos Negócios',
      text: 'Se você é autônomo e mistura dinheiro pessoal com o da sua empresa, você precisa ver esse robô.'
    },
    {
      category: '💼 Autônomos & Pequenos Negócios',
      text: 'Como eu controlo as entradas e saídas do meu negócio sem pagar R$ 300 em sistema de gestão.'
    }
  ];

  const adCopies = [
    {
      title: 'Campanha 1: "Odeio Planilhas" (Foco em Facilidade)',
      badge: 'Campeã de Conversão 🏆',
      headline: 'Organize suas finanças mandando apenas um áudio no WhatsApp.',
      primaryText: 'Chega de anotar gastos em caderninho ou preencher planilhas chatas no Excel.\n\nCom o Assistente Zap, você só manda um áudio ou tira foto do comprovante e a inteligência artificial categoriza suas despesas, calcula seu saldo e te lembra das contas a pagar!\n\nSem baixar nenhum aplicativo novo. Tudo direto no seu WhatsApp.',
      ctaText: 'Testar 7 Dias Grátis no WhatsApp'
    },
    {
      title: 'Campanha 2: "Boleto Sem Juros" (Foco em Contas & Lembretes)',
      badge: 'Forte Apelo de Dor 💳',
      headline: 'Nunca mais pague juros por esquecer a data de vencimento.',
      primaryText: 'Tire uma foto do boleto ou diga: "Conta de luz de 180 vence dia 15".\n\nO Assistente Zap guarda tudo e te avisa no WhatsApp com antecedência para você nunca mais ser pego de surpresa.\n\nExperimente grátis por 7 dias sem compromisso.',
      ctaText: 'Quero Testar no Meu WhatsApp'
    },
    {
      title: 'Campanha 3: "Para Autônomos e Empresários" (B2B)',
      badge: 'Público Qualificado 💼',
      headline: 'O assistente que todo autônomo e profissional liberal sonhou.',
      primaryText: 'Controle de entradas Pix, registro instantâneo de saídas e sincronização com Google Calendar para você não perder nenhum cliente ou reunião.\n\nTudo pelo WhatsApp, no piloto automático por apenas R$ 29/mês.',
      ctaText: 'Iniciar Teste de 7 Dias'
    }
  ];

  const videoTips = [
    {
      step: 'Passo 1: Gravar a tela (1 minuto)',
      desc: 'Use o gravador de tela do seu celular. Abra a conversa do Assistente, grave você mandando um áudio simples ("Almoço 35 no débito e dentista amanhã 15h") e mostre o bot respondendo.'
    },
    {
      step: 'Passo 2: Legendar no CapCut (Grátis)',
      desc: 'Abra o CapCut (celular ou PC), clique em "Legendas Automáticas" e selecione o estilo "Palavra por Palavra" (com fundo amarelo ou verde neon). Fica com cara de vídeo de alta produção.'
    },
    {
      step: 'Passo 3: Publicar com Gancho',
      desc: 'Nos primeiros 3 segundos, coloque o texto grande no topo: "PARE DE USAR PLANILHA". Poste no Reels e TikTok com o seu link do WhatsApp na bio.'
    }
  ];

  res.json({
    success: true,
    data: { hooks, adCopies, videoTips }
  });
});

app.post('/api/admin/marketing/generate-script', requireAdmin, async (req, res) => {
  const { format, duration, focusTopic, niche, customPrompt } = req.body || {};
  try {
    const script = await aiService.generateMarketingScript({ format, duration, focusTopic, niche, customPrompt });
    res.json({ success: true, data: script });
  } catch (err) {
    console.error('Erro /api/admin/marketing/generate-script:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// HIGH DEFINITION NEURAL TTS AUDIO STREAMING (PROTEÇÃO 12)
// ==========================================
app.get('/api/tts', ttsLimiter, async (req, res) => {
  try {
    const text = (req.query.text || '').substring(0, 500).replace(/[*_~`#]/g, '').trim();
    if (!text) return res.status(400).send('Texto não fornecido');

    const googleTtsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=pt-BR&client=tw-ob`;
    const response = await fetch(googleTtsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Google TTS status: ${response.status}`);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const arrayBuffer = await response.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Erro em /api/tts:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// AVATAR VIDEO GENERATION (D-ID / HEYGEN)
// ==========================================
app.post('/api/admin/marketing/generate-avatar-video', requireAdmin, async (req, res) => {
  const { text, avatarUrl, voiceId, apiKey } = req.body || {};
  const cleanText = (text || '').trim();

  if (!cleanText) {
    return res.status(400).json({ success: false, error: 'O texto da fala é obrigatório.' });
  }

  const didKey = (apiKey || process.env.DID_API_KEY || '').trim();

  if (!didKey) {
    return res.status(400).json({
      success: false,
      error: 'Chave de API da D-ID não informada. Crie uma conta gratuita em d-id.com para obter seus créditos grátis de vídeo.',
      needApiKey: true
    });
  }

  try {
    const authHeader = didKey.startsWith('Basic ') ? didKey : `Basic ${Buffer.from(didKey).toString('base64')}`;
    const defaultAvatar = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=500&auto=format&fit=crop&q=80';
    const source = avatarUrl || defaultAvatar;

    const payload = {
      script: {
        type: 'text',
        subtitles: false,
        provider: {
          type: 'microsoft',
          voice_id: voiceId || 'pt-BR-AntonioNeural'
        },
        input: cleanText.substring(0, 500)
      },
      source_url: source,
      config: {
        fluent: true,
        pad_audio: 0
      }
    };

    const createRes = await fetch('https://api.d-id.com/talks', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const createJson = await createRes.json();
    if (!createRes.ok || !createJson.id) {
      return res.status(createRes.status).json({
        success: false,
        error: createJson.description || createJson.message || 'Erro ao conectar com API da D-ID'
      });
    }

    const talkId = createJson.id;

    // Poll up to 25 seconds for completion
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(r => setTimeout(r, 2500));
      attempts++;

      const checkRes = await fetch(`https://api.d-id.com/talks/${talkId}`, {
        headers: { 'Authorization': authHeader }
      });
      const checkJson = await checkRes.json();

      if (checkJson.status === 'done' && checkJson.result_url) {
        return res.json({
          success: true,
          videoUrl: checkJson.result_url,
          id: talkId,
          duration: checkJson.duration
        });
      }

      if (checkJson.status === 'error') {
        return res.status(500).json({
          success: false,
          error: checkJson.error?.description || 'Falha na renderização do avatar.'
        });
      }
    }

    return res.json({
      success: true,
      inProgress: true,
      talkId,
      message: 'Vídeo em processamento pela D-ID. Aguarde alguns instantes.'
    });

  } catch (err) {
    console.error('Erro /api/admin/marketing/generate-avatar-video:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// GOOGLE CALENDAR SETUP & SYNC API
// ==========================================
app.post('/api/admin/calendar/setup', requireAdmin, async (req, res) => {
  try {
    const { credentials, token } = req.body || {};
    if (!credentials && !token) {
      return res.status(400).json({ success: false, error: 'Credenciais ou token não fornecidos.' });
    }

    const connected = calendarService.saveCredentialsAndToken({ credentials, token });
    let syncResult = { synced: 0 };
    if (connected) {
      const appointmentService = require('../services/appointmentService');
      syncResult = await appointmentService.syncPendingAdminAppointmentsToGoogle();
    }

    res.json({
      success: true,
      calendarConnected: connected,
      syncResult,
      message: connected
        ? `Google Calendar conectado com sucesso! ${syncResult.synced || 0} compromisso(s) pendente(s) sincronizado(s).`
        : 'Credenciais recebidas, mas aguardando validação do token.',
    });
  } catch (err) {
    console.error('Erro na rota /api/admin/calendar/setup:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/calendar/sync', requireAdmin, async (req, res) => {
  try {
    const appointmentService = require('../services/appointmentService');
    const syncResult = await appointmentService.syncPendingAdminAppointmentsToGoogle();
    res.json({ success: true, ...syncResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List all registered clients
app.get('/api/admin/users-list', requireAdmin, (req, res) => {
  try {
    const users = db.prepare('SELECT id, phone_number, name, role, plan, trial_ends_at, created_at FROM users ORDER BY id DESC').all();
    res.json({ success: true, count: users.length, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Resolve a failed user request: register expense and send WhatsApp confirmation
app.post('/api/admin/fix-user-expense', requireAdmin, async (req, res) => {
  try {
    // 1. Auto-fix Gemini API key in memory if there is a known typo or new key provided
    if (config.geminiApiKey && config.geminiApiKey.includes('B8tpfH0')) {
      config.geminiApiKey = config.geminiApiKey.replace('B8tpfH0', 'B8tpFh0');
      process.env.GEMINI_API_KEY = config.geminiApiKey;
      if (aiService.setApiKey) aiService.setApiKey(config.geminiApiKey);
    }
    if (req.body?.geminiApiKey) {
      config.geminiApiKey = req.body.geminiApiKey.trim();
      process.env.GEMINI_API_KEY = config.geminiApiKey;
      if (aiService.setApiKey) aiService.setApiKey(config.geminiApiKey);
    }

    // 2. Identify target client
    let targetUser = null;
    const { userId, phoneNumber, search } = req.body || {};

    if (userId) {
      targetUser = userService.getUserById(Number(userId));
    } else if (phoneNumber) {
      targetUser = userService.getUserByPhone(phoneNumber);
    }

    if (!targetUser && search) {
      targetUser = db.prepare(`SELECT * FROM users WHERE (name LIKE ? OR phone_number LIKE ?) AND role != 'ADMIN' ORDER BY id DESC LIMIT 1`)
        .get(`%${search}%`, `%${search}%`);
    }

    if (!targetUser) {
      // Find latest non-admin client in the system
      targetUser = db.prepare(`SELECT * FROM users WHERE role != 'ADMIN' ORDER BY id DESC LIMIT 1`).get();
    }

    if (!targetUser) {
      return res.status(404).json({ success: false, error: 'Nenhum usuário cliente encontrado no banco de dados.' });
    }

    // 3. Register the expense (Padaria R$ 5,00)
    const amount = Number(req.body?.amount !== undefined ? req.body.amount : 5.0);
    const category = req.body?.category || 'Alimentação';
    const description = req.body?.description || 'Padaria';
    const paymentMethod = req.body?.paymentMethod || 'Não informado';

    const expense = financeService.addExpense({
      userId: targetUser.id,
      amount,
      category,
      description,
      paymentMethod,
      date: new Date().toISOString(),
      sourceType: 'text',
    });

    // 4. Send the WhatsApp notification message
    const defaultMsg =
      `Olá! O seu gasto de *R$ ${amount.toFixed(2).replace('.', ',')} (${description})* já foi registrado com sucesso no seu painel! ✅\n\n` +
      `A instabilidade temporária que ocorreu mais cedo na inteligência artificial já foi corrigida, e você já pode continuar utilizando o seu assistente normalmente. Tenha um excelente dia! 🚀`;

    const messageText = req.body?.message || defaultMsg;
    await whatsappClient.sendWhatsAppMessage(targetUser.phone_number, messageText);

    return res.json({
      success: true,
      message: 'Gasto registrado e mensagem enviada com sucesso ao cliente!',
      user: {
        id: targetUser.id,
        phone: targetUser.phone_number,
        name: targetUser.name,
      },
      expense,
      geminiKeyFixed: true,
    });
  } catch (err) {
    console.error('Erro em /api/admin/fix-user-expense:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PIX SUBSCRIPTION / PAYMENT API (R$ 29,00)
// ==========================================
app.get('/api/pix', authMiddleware, async (req, res) => {
  try {
    const details = await pixService.getPixPaymentDetails(req.user?.id);
    res.json({
      success: true,
      data: details,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// EXPENSES API (TENANT ISOLATED)
// ==========================================
// 1. List expenses with optional filters
app.get('/api/expenses', authMiddleware, (req, res) => {
  try {
    const { category, search, startDate, endDate } = req.query;
    let sql = 'SELECT * FROM expenses WHERE user_id = ?';
    const params = [req.user.id];

    if (category && category !== 'Todas') {
      sql += ' AND category = ?';
      params.push(category);
    }

    if (search) {
      sql += ' AND (description LIKE ? OR category LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (startDate) {
      sql += ' AND date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND date <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY date DESC, id DESC';
    const rows = db.prepare(sql).all(...params);

    res.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Add an expense manually from the dashboard
app.post('/api/expenses', authMiddleware, (req, res) => {
  try {
    const { amount, category, description, paymentMethod, date } = req.body;
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido' });
    }

    const saved = financeService.addExpense({
      userId: req.user.id,
      amount: Number(amount),
      category: category || 'Outros',
      description: description || 'Lançamento manual',
      paymentMethod: paymentMethod || 'Outro',
      date: date ? new Date(date).toISOString() : new Date().toISOString(),
      sourceType: 'dashboard',
    });

    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Edit an expense (ownership guaranteed)
app.put('/api/expenses/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { amount, category, description, paymentMethod, date } = req.body;

    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Gasto não encontrado' });
    }

    const normCat = category ? financeService.normalizeCategory(category) : existing.category;

    db.prepare(`
      UPDATE expenses
      SET amount = ?, category = ?, description = ?, payment_method = ?, date = ?
      WHERE id = ? AND user_id = ?
    `).run(
      amount !== undefined ? Number(amount) : existing.amount,
      normCat,
      description !== undefined ? description : existing.description,
      paymentMethod !== undefined ? paymentMethod : existing.payment_method,
      date || existing.date,
      id,
      req.user.id
    );

    const updated = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Delete an expense (ownership guaranteed)
app.delete('/api/expenses/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Gasto não encontrado' });
    }

    db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Gasto removido com sucesso', data: existing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// INCOMES & BALANCE (TENANT ISOLATED)
// ==========================================
// List incomes
app.get('/api/incomes', authMiddleware, (req, res) => {
  try {
    const { category, search, startDate, endDate, limit } = req.query;
    let query = 'SELECT * FROM incomes WHERE user_id = ?';
    const params = [req.user.id];

    if (category && category !== 'Todas') {
      const normCat = financeService.normalizeIncomeCategory(category);
      query += ' AND category = ?';
      params.push(normCat);
    }

    if (search) {
      query += ' AND (source LIKE ? OR category LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (startDate) {
      query += ' AND date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY date DESC, id DESC';

    if (limit) {
      query += ' LIMIT ?';
      params.push(Number(limit));
    }

    const rows = db.prepare(query).all(...params);
    res.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add an income manually from the dashboard
app.post('/api/incomes', authMiddleware, (req, res) => {
  try {
    const { amount, source, category, paymentMethod, date } = req.body;
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido' });
    }

    const saved = financeService.addIncome({
      userId: req.user.id,
      amount: Number(amount),
      source: source || 'Entrada manual',
      category: category || 'Outros',
      paymentMethod: paymentMethod || 'Pix',
      date: date ? new Date(date).toISOString() : new Date().toISOString(),
      sourceType: 'dashboard',
    });

    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Edit an income (ownership guaranteed)
app.put('/api/incomes/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { amount, source, category, paymentMethod, date } = req.body;

    const existing = db.prepare('SELECT * FROM incomes WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Entrada não encontrada' });
    }

    const normCat = category ? financeService.normalizeIncomeCategory(category) : existing.category;

    db.prepare(`
      UPDATE incomes
      SET amount = ?, source = ?, category = ?, payment_method = ?, date = ?
      WHERE id = ? AND user_id = ?
    `).run(
      amount !== undefined ? Number(amount) : existing.amount,
      source !== undefined ? source.trim() : existing.source,
      normCat,
      paymentMethod !== undefined ? paymentMethod : existing.payment_method,
      date || existing.date,
      id,
      req.user.id
    );

    const updated = db.prepare('SELECT * FROM incomes WHERE id = ? AND user_id = ?').get(id, req.user.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete an income (ownership guaranteed)
app.delete('/api/incomes/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM incomes WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Entrada não encontrada' });
    }

    db.prepare('DELETE FROM incomes WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Entrada removida com sucesso', data: existing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get financial balance (supports month, days, or date range)
app.get('/api/balance', authMiddleware, (req, res) => {
  try {
    const { month, days, startDate, endDate } = req.query;
    if (days || (startDate && endDate)) {
      const balance = financeService.getPeriodBalance({
        days: days ? Number(days) : undefined,
        startDate,
        endDate,
        userId: req.user.id,
      });
      return res.json({ success: true, data: balance });
    }
    const balance = financeService.getMonthlyBalance(month, req.user.id);
    res.json({ success: true, data: balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Get aggregate statistics (isolated for current user)
app.get('/api/stats', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7); // 'YYYY-MM'
    const today = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();

    // Total Expenses Month
    const monthRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${currentMonth}%`);

    // Total Expenses Today
    const todayRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${today}%`);

    // Total Incomes Month
    const incomeMonthRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM incomes
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${currentMonth}%`);

    // Total Incomes Today
    const incomeTodayRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM incomes
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${today}%`);

    // Gasoline last 15 days
    const gasRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND (category LIKE '%Gasolina%' OR description LIKE '%gasolina%')
        AND date >= ?
    `).get(userId, fifteenDaysAgo);

    // All categories distribution (Expenses)
    const categoryRows = db.prepare(`
      SELECT category, SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ?
      GROUP BY category
      ORDER BY total DESC
    `).all(userId);

    // All categories distribution (Incomes)
    const incomeCategoryRows = db.prepare(`
      SELECT category, SUM(amount) as total, COUNT(*) as count
      FROM incomes
      WHERE user_id = ?
      GROUP BY category
      ORDER BY total DESC
    `).all(userId);

    // Payment methods distribution
    const paymentRows = db.prepare(`
      SELECT payment_method, SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ?
      GROUP BY payment_method
      ORDER BY total DESC
    `).all(userId);

    // Daily breakdown for the last 14 days (both Expenses and Incomes)
    const dailyStats = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = d.toISOString().slice(0, 10);
      const rowExp = db.prepare(`
        SELECT SUM(amount) as total
        FROM expenses
        WHERE user_id = ? AND date LIKE ?
      `).get(userId, `${dayStr}%`);

      const rowInc = db.prepare(`
        SELECT SUM(amount) as total
        FROM incomes
        WHERE user_id = ? AND date LIKE ?
      `).get(userId, `${dayStr}%`);

      dailyStats.push({
        date: dayStr,
        displayDate: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        total: Number(rowExp?.total || 0),
        incomes: Number(rowInc?.total || 0),
      });
    }

    const totalMonthNum = Number(monthRow?.total || 0);
    const totalIncomeMonthNum = Number(incomeMonthRow?.total || 0);
    const balanceMonthNum = totalIncomeMonthNum - totalMonthNum;

    const overall = financeService.getOverallBalance(userId);

    const categoriesWithPercent = categoryRows.map((cat) => ({
      ...cat,
      total: Number(cat.total),
      percentage: totalMonthNum > 0 ? ((Number(cat.total) / totalMonthNum) * 100).toFixed(1) : 0,
    }));

    res.json({
      success: true,
      data: {
        totalMonth: totalMonthNum,
        countMonth: Number(monthRow?.count || 0),
        totalToday: Number(todayRow?.total || 0),
        countToday: Number(todayRow?.count || 0),
        totalIncomesMonth: totalIncomeMonthNum,
        countIncomesMonth: Number(incomeMonthRow?.count || 0),
        totalIncomesToday: Number(incomeTodayRow?.total || 0),
        countIncomesToday: Number(incomeTodayRow?.count || 0),
        balanceMonth: balanceMonthNum,
        isBalancePositive: balanceMonthNum >= 0,
        formattedBalance: financeService.formatCurrency(balanceMonthNum),
        formattedIncomesMonth: financeService.formatCurrency(totalIncomeMonthNum),
        formattedExpensesMonth: financeService.formatCurrency(totalMonthNum),
        overallBalance: overall.balance,
        formattedOverallBalance: overall.formattedBalance,
        isOverallPositive: overall.isPositive,
        overallIncomes: overall.totalIncomes,
        overallExpenses: overall.totalExpenses,
        totalGasoline15Days: Number(gasRow?.total || 0),
        countGasoline15Days: Number(gasRow?.count || 0),
        categories: categoriesWithPercent,
        incomeCategories: incomeCategoryRows,
        payments: paymentRows,
        daily: dailyStats,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Export to CSV (tenant isolated)
app.get('/api/export/csv', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC').all(req.user.id);
    let csv = 'ID;Data;Valor;Categoria;Descricao;FormaPagamento;Origem\n';

    for (const r of rows) {
      const dateStr = financeService.formatDateBR(r.date);
      const valStr = Number(r.amount).toFixed(2).replace('.', ',');
      const desc = (r.description || '').replace(/;/g, ' ');
      const cat = (r.category || '').replace(/;/g, ' ');
      const pay = (r.payment_method || '').replace(/;/g, ' ');
      csv += `${r.id};"${dateStr}";"${valStr}";"${cat}";"${desc}";"${pay}";"${r.source_type}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gastos_assistente.csv"');
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).send('Erro ao exportar CSV: ' + err.message);
  }
});

// ==========================================
// BILLS & SCHEDULED PAYMENTS (TENANT ISOLATED)
// ==========================================
// 7. Get scheduled payments / bills
app.get('/api/bills', authMiddleware, (req, res) => {
  try {
    const { status, search } = req.query;
    const bills = billService.getBills({ userId: req.user.id, status, search });
    res.json({ success: true, count: bills.length, data: bills });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Create scheduled payment or installment from dashboard
app.post('/api/bills', authMiddleware, async (req, res) => {
  try {
    const { title, totalAmount, installmentAmount, installments, firstDueDate, category } = req.body;
    const created = await billService.addScheduledPayment({
      userId: req.user.id,
      title: title || 'Conta',
      totalAmount,
      installmentAmount,
      installments: installments || 1,
      firstDueDate,
      category: category || 'Contas',
      sourceType: 'dashboard',
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Mark bill as PAID (ownership checked)
app.put('/api/bills/:id/pay', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM scheduled_payments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Conta não encontrada' });
    }
    const result = billService.markAsPaid(id, req.user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Delete a bill (ownership checked)
app.delete('/api/bills/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM scheduled_payments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Conta não encontrada' });
    }
    billService.deleteBill(id);
    res.json({ success: true, message: 'Conta removida com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// APPOINTMENTS & AGENDA (TENANT ISOLATED)
// ==========================================
// 11. Get scheduled appointments
app.get('/api/appointments', authMiddleware, (req, res) => {
  try {
    const status = req.query.status || 'SCHEDULED';
    const appointments = appointmentService.getAppointments({ userId: req.user.id, status });
    res.json({ success: true, count: appointments.length, data: appointments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Create an appointment from dashboard
app.post('/api/appointments', authMiddleware, (req, res) => {
  try {
    const { title, description, startDateTime, endDateTime, location } = req.body;
    if (!title || !startDateTime) {
      return res.status(400).json({ success: false, error: 'Título e data/horário de início são obrigatórios' });
    }

    const created = appointmentService.createAppointment({
      userId: req.user.id,
      title,
      description,
      startDateTime,
      endDateTime,
      location,
      sourceType: 'dashboard',
    });

    res.status(201).json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. Cancel/Delete an appointment (ownership checked)
app.delete('/api/appointments/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Compromisso não encontrado' });
    }

    await appointmentService.deleteAppointment(id, req.user.id);
    res.json({ success: true, message: 'Compromisso desmarcado com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SECURITY AUDIT & SYSTEM INTEGRITY ENDPOINTS (PROTEÇÃO 03 & 08)
// ==========================================
app.get('/api/admin/security/audit-logs', requireInteractiveAdmin, (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const eventType = req.query.eventType || null;
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const logs = getRecentSecurityLogs({ limit, eventType, userId });
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erro ao buscar logs de auditoria: ' + err.message });
  }
});

app.get('/api/admin/system/integrity-check', requireAdmin, (req, res) => {
  try {
    const integrity = typeof db.checkDatabaseIntegrity === 'function'
      ? db.checkDatabaseIntegrity()
      : { ok: true, message: 'checkDatabaseIntegrity não disponível' };
    logSecurityEvent({
      eventType: AUDIT_EVENTS.DB_INTEGRITY_CHECK,
      userId: req.user?.id,
      req,
      status: integrity.ok ? 'SUCCESS' : 'FAILED',
      details: integrity,
    });
    res.json({ success: integrity.ok, ...integrity });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/system/backup', requireInteractiveAdmin, (req, res) => {
  try {
    if (typeof db.backupDatabase !== 'function') {
      return res.status(500).json({ success: false, error: 'Função de backup não disponível no adaptador SQLite.' });
    }
    const result = db.backupDatabase();
    logSecurityEvent({
      eventType: AUDIT_EVENTS.DB_BACKUP_CREATED,
      userId: req.user?.id,
      req,
      status: 'SUCCESS',
      details: { backupPath: result.backupPath, sizeBytes: result.sizeBytes },
    });
    res.json({ success: true, message: 'Backup SQLite executado com sucesso.', ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// CENTRALIZED ERROR HANDLING MIDDLEWARE (PROTEÇÃO 20)
// Prevents leaking stack traces, environment variables or internal details
// ==========================================
app.use((err, req, res, next) => {
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      error: 'Origem não autorizada pela política CORS.',
      code: 'CORS_FORBIDDEN',
    });
  }
  console.error('[Unhandled Server Error]', err.stack || err.message || err);
  const isStaging = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging';
  const isProdOrStaging = process.env.NODE_ENV === 'production' || isStaging;
  const status = err.status || err.statusCode || 500;
  
  return res.status(status).json({
    success: false,
    error: isProdOrStaging ? 'Ocorreu um erro interno no servidor.' : (err.message || 'Erro interno no servidor.'),
    code: 'INTERNAL_SERVER_ERROR',
  });
});

function startServer(port = 3333) {
  try {
    const outboxWorker = require('../services/outboxWorker');
    outboxWorker.startWorker();
  } catch (err) {
    console.warn('[OutboxWorker] Aviso ao iniciar worker de outbox:', err.message);
  }

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`\n📊 Dashboard financeiro Multi-Tenant disponível em: http://localhost:${port}`);
      resolve(server);
    });
  });
}

module.exports = { app, startServer };
