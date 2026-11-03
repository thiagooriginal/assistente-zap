const db = require('../database/db');

/**
 * RAIA AGENTES — Centralized Security & Audit Logging Service
 * 
 * Implements Proteção 08 & 26 (OWASP ASVS 5.0 Logging and Auditing):
 * - Records authentication attempts (success, failure, lockout)
 * - Records password changes, resets and token usage
 * - Records administrative actions and privilege elevations
 * - Records contract, price and plan changes
 * - Records financial mutations, cancellations and reconciliations
 * - Records unauthorized cross-tenant data access attempts (IDOR)
 * - Records webhook signature validations and duplicate payloads
 * - Automatically strips passwords, tokens, hashes and secrets from logs
 */

const AUDIT_EVENTS = {
  // Authentication & Session
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  RATE_LIMIT_BLOCKED: 'RATE_LIMIT_BLOCKED',
  SESSION_FIXATION_PREVENTED: 'SESSION_FIXATION_PREVENTED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  
  // Passwords & Tokens
  PASSWORD_CHANGE: 'PASSWORD_CHANGE',
  PASSWORD_RESET_REQUEST: 'PASSWORD_RESET_REQUEST',
  PASSWORD_RESET_SUCCESS: 'PASSWORD_RESET_SUCCESS',
  ACTIVATION_SUCCESS: 'ACTIVATION_SUCCESS',
  MAGIC_TOKEN_GENERATED: 'MAGIC_TOKEN_GENERATED',
  MAGIC_TOKEN_USED: 'MAGIC_TOKEN_USED',
  MAGIC_TOKEN_EXPIRED: 'MAGIC_TOKEN_EXPIRED',

  // Administrative & RBAC
  ADMIN_ACCESS: 'ADMIN_ACCESS',
  ADMIN_LOGIN_SUCCESS: 'ADMIN_LOGIN_SUCCESS',
  ADMIN_LOGIN_FAILED: 'ADMIN_LOGIN_FAILED',
  ADMIN_MFA_CHALLENGE: 'ADMIN_MFA_CHALLENGE',
  ADMIN_MFA_SUCCESS: 'ADMIN_MFA_SUCCESS',
  ADMIN_MFA_FAILED: 'ADMIN_MFA_FAILED',
  PRIVILEGE_ESCALATION_BLOCKED: 'PRIVILEGE_ESCALATION_BLOCKED',

  // Multi-Tenant Isolation & IDOR
  CROSS_TENANT_ACCESS_BLOCKED: 'CROSS_TENANT_ACCESS_BLOCKED',
  UNAUTHORIZED_API_ACCESS: 'UNAUTHORIZED_API_ACCESS',

  // Subscriptions, Contracts & Financial
  PLAN_CHANGE: 'PLAN_CHANGE',
  CONTRACT_CREATED: 'CONTRACT_CREATED',
  CONTRACT_CONFIRMED: 'CONTRACT_CONFIRMED',
  CONTRACT_CANCELLED: 'CONTRACT_CANCELLED',
  CONTRACT_RENEWED: 'CONTRACT_RENEWED',
  BILL_CREATED: 'BILL_CREATED',
  BILL_PAID: 'BILL_PAID',
  BILL_DELETE_BLOCKED: 'BILL_DELETE_BLOCKED',
  PRICE_VALIDATION_FAILED: 'PRICE_VALIDATION_FAILED',

  // Webhooks
  WEBHOOK_INVALID_SIGNATURE: 'WEBHOOK_INVALID_SIGNATURE',
  WEBHOOK_DUPLICATE_EVENT: 'WEBHOOK_DUPLICATE_EVENT',
  WEBHOOK_PROCESSED: 'WEBHOOK_PROCESSED',

  // Security Operations
  DB_INTEGRITY_CHECK: 'DB_INTEGRITY_CHECK',
  DB_BACKUP_CREATED: 'DB_BACKUP_CREATED',
  CSRF_VIOLATION_BLOCKED: 'CSRF_VIOLATION_BLOCKED',
  SUSPICIOUS_FILE_ACCESS_BLOCKED: 'SUSPICIOUS_FILE_ACCESS_BLOCKED',
};

/**
 * Remove sensitive credentials from audit details
 */
function sanitizeDetails(data) {
  if (!data || typeof data !== 'object') return data;
  
  const sensitiveKeys = [
    'password', 'password_hash', 'password_salt', 'currentPassword', 'newPassword',
    'secret', 'token', 'magic_token', 'apiKey', 'access_token', 'cookie',
    'authorization', 'key', 'admin_pin', 'creditCard', 'cvv'
  ];

  const sanitized = Array.isArray(data) ? [] : {};

  for (const [key, value] of Object.entries(data)) {
    const isSensitive = sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()));
    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeDetails(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Record a security audit event in SQLite
 */
function logSecurityEvent({
  eventType,
  userId = null,
  req = null,
  ipAddress = null,
  userAgent = null,
  resource = null,
  status = 'SUCCESS',
  details = null,
}) {
  try {
    let clientIp = ipAddress;
    let clientUa = userAgent;

    if (req) {
      clientIp = clientIp || req.ip || req.socket?.remoteAddress || '127.0.0.1';
      clientUa = clientUa || req.headers?.['user-agent'] || null;
      resource = resource || req.originalUrl || req.url || null;
    }

    const cleanDetails = details ? JSON.stringify(sanitizeDetails(details)) : null;

    db.prepare(`
      INSERT INTO security_audit_logs (
        event_type, user_id, ip_address, user_agent, resource, status, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventType,
      userId,
      clientIp,
      clientUa ? String(clientUa).substring(0, 255) : null,
      resource ? String(resource).substring(0, 255) : null,
      status,
      cleanDetails
    );
  } catch (err) {
    // Audit logging failure must NEVER crash the main request loop, but should be logged to console
    console.error('[Security Audit] Falha ao registrar evento de auditoria:', err.message);
  }
}

/**
 * Query recent security audit logs (Admin only)
 */
function getRecentSecurityLogs({ limit = 50, eventType = null, userId = null } = {}) {
  let query = 'SELECT * FROM security_audit_logs';
  const conditions = [];
  const params = [];

  if (eventType) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY id DESC LIMIT ?';
  params.push(Math.min(limit, 200));

  return db.prepare(query).all(...params);
}

module.exports = {
  AUDIT_EVENTS,
  logSecurityEvent,
  getRecentSecurityLogs,
  sanitizeDetails,
};
