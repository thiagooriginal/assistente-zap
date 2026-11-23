/**
 * RAIA AGENTES — SERVIÇO DE SESSÕES CONTROLADAS DE TESTE DO GOOGLE CALENDAR
 * Branch: security/raia-27-protecoes
 *
 * Gerencia a autorização temporária, delimitada e revogável para testes reais
 * de sincronização com o Google Calendar em ambiente de homologação controlada.
 *
 * Em conformidade com a Matriz RAIA-27 (OWASP ASVS 5.0):
 * - Anti-Primary Shield: proíbe calendários principais ('primary', 'default')
 * - Demo Shield: proíbe execução sob contas com is_demo = 1
 * - Single Active Session: no máximo 1 sessão ativa simultânea no cluster
 * - Atomic Lazy Expiration & Execution Limiting
 * - Injeção de `dbInstance` opcional para testes herméticos em os.tmpdir()
 */

const crypto = require('crypto');
const defaultDb = require('../database/db');

/**
 * Retorna a instância ativa do banco de dados (injetada ou padrão).
 * @param {Object} [dbInstance]
 * @returns {Object}
 */
function getDb(dbInstance) {
  return dbInstance || defaultDb;
}

/**
 * Garante a criação idempotente do esquema da tabela de sessões (útil para testes herméticos).
 * @param {Object} [dbInstance]
 */
function ensureSchema(dbInstance = null) {
  const db = getDb(dbInstance);
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_sync_test_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_token TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      appointment_id INTEGER NOT NULL,
      calendar_id TEXT NOT NULL,
      account_email TEXT NOT NULL,
      session_type TEXT NOT NULL DEFAULT 'EXISTING_APPOINTMENT',
      authorized_client_phone TEXT,
      target_channel TEXT DEFAULT 'WHATSAPP_BOT',
      allow_new_appointments INTEGER NOT NULL DEFAULT 0,
      allowed_action TEXT NOT NULL DEFAULT 'CREATE' CHECK(allowed_action IN ('CREATE', 'UPDATE', 'DELETE', 'ANY')),
      max_executions INTEGER NOT NULL DEFAULT 1,
      executions_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'COMPLETED', 'EXPIRED', 'REVOKED')),
      reason TEXT,
      revoked_by INTEGER,
      revocation_reason TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gtest_status_expires ON google_sync_test_sessions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_gtest_user_apt ON google_sync_test_sessions(user_id, appointment_id);
    CREATE INDEX IF NOT EXISTS idx_gtest_created_at ON google_sync_test_sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_gtest_late_binding ON google_sync_test_sessions(user_id, status, session_type, appointment_id);
  `);

  // Migrações suaves idempotentes para instâncias preexistentes
  const migrations = [
    { name: 'session_type', def: "TEXT NOT NULL DEFAULT 'EXISTING_APPOINTMENT'" },
    { name: 'authorized_client_phone', def: 'TEXT' },
    { name: 'target_channel', def: "TEXT DEFAULT 'WHATSAPP_BOT'" },
    { name: 'allow_new_appointments', def: 'INTEGER NOT NULL DEFAULT 0' },
  ];

  for (const col of migrations) {
    try {
      const cols = db.prepare('PRAGMA table_info(google_sync_test_sessions)').all();
      const hasCol = cols.some((c) => c.name.toLowerCase() === col.name.toLowerCase());
      if (!hasCol) {
        db.exec(`ALTER TABLE google_sync_test_sessions ADD COLUMN ${col.name} ${col.def}`);
      }
    } catch (_) {}
  }
}

/**
 * Mascara o token de sessão para evitar exposição em respostas e histórico.
 * @param {string} token
 * @returns {string}
 */
function maskSessionToken(token) {
  if (!token || typeof token !== 'string') return '';
  if (token.length <= 8) return '****';
  return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
}

/**
 * Sanitiza a sessão omitindo session_token e expondo session_token_masked.
 * @param {Object} row
 * @returns {Object|null}
 */
function sanitizeSession(row) {
  if (!row) return null;
  const copy = { ...row };
  if (copy.session_token) {
    copy.session_token_masked = maskSessionToken(copy.session_token);
    delete copy.session_token;
  }
  return copy;
}

/**
 * Expira atômica e passivamente todas as sessões cujo TTL já venceu.
 * @param {Object} [dbInstance]
 * @returns {number} Quantidade de sessões expiradas
 */
function cleanupExpiredSessions(dbInstance = null) {
  const db = getDb(dbInstance);
  const result = db.prepare(`
    UPDATE google_sync_test_sessions
    SET status = 'EXPIRED',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'ACTIVE'
      AND datetime(expires_at) <= datetime('now')
  `).run();
  return result.changes;
}

/**
 * Cria uma sessão temporária de homologação controlada.
 *
 * @param {Object} params
 * @param {number|string} params.userId - Identificador do tenant
 * @param {number|string} [params.appointmentId] - Identificador do agendamento (obrigatório se sessionType != 'WHATSAPP_NEW')
 * @param {string} params.calendarId - ID do calendário secundário
 * @param {string} params.accountEmail - E-mail institucional do salão
 * @param {string} [params.allowedAction='CREATE'] - Ação permitida ('CREATE', 'UPDATE', 'DELETE', 'ANY')
 * @param {number} [params.durationMinutes=15] - Duração do TTL em minutos (1 a 60)
 * @param {number} [params.maxExecutions=1] - Limite de execuções reais (1 a 5)
 * @param {number|string} params.createdBy - ID do administrador responsável
 * @param {string} [params.reason] - Motivo do teste
 * @param {string} [params.sessionType='EXISTING_APPOINTMENT'] - Tipo ('EXISTING_APPOINTMENT' ou 'WHATSAPP_NEW')
 * @param {string|null} [params.authorizedClientPhone=null] - Telefone autorizado (opcional, restrito à whitelist)
 * @param {string} [params.targetChannel='WHATSAPP_BOT'] - Canal autorizado
 * @param {Object} [dbInstance] - Instância de banco para injeção em testes
 * @returns {Object} Sessão criada
 */
function createTestSession({
  userId,
  appointmentId,
  calendarId,
  accountEmail,
  allowedAction = 'CREATE',
  durationMinutes = 15,
  maxExecutions = 1,
  createdBy,
  reason = 'Homologação real controlada Google Calendar',
  sessionType = 'EXISTING_APPOINTMENT',
  authorizedClientPhone = null,
  targetChannel = 'WHATSAPP_BOT',
}, dbInstance = null) {
  const db = getDb(dbInstance);

  const uId = Number(userId);
  const isWhatsAppNew = String(sessionType || '').toUpperCase() === 'WHATSAPP_NEW';
  const aptId = isWhatsAppNew ? (Number(appointmentId) || 0) : Number(appointmentId);
  const adminId = Number(createdBy);

  if (!uId || isNaN(uId) || uId <= 0) {
    const err = new Error('INVALID_USER_ID: Identificador do tenant inválido.');
    err.code = 'INVALID_USER_ID';
    throw err;
  }
  if (isWhatsAppNew && uId !== 3) {
    const err = new Error('TENANT_RESTRICTED_TO_TEST_SALON: O modo WHATSAPP_NEW está disponível exclusivamente para o salão de testes oficial (Tenant 3).');
    err.code = 'TENANT_RESTRICTED_TO_TEST_SALON';
    throw err;
  }
  if (!isWhatsAppNew && (!aptId || isNaN(aptId) || aptId <= 0)) {
    const err = new Error('INVALID_APPOINTMENT_ID: Identificador do agendamento inválido.');
    err.code = 'INVALID_APPOINTMENT_ID';
    throw err;
  }
  if (!adminId || isNaN(adminId) || adminId <= 0) {
    const err = new Error('INVALID_ADMIN_ID: Identificador do administrador obrigatório.');
    err.code = 'INVALID_ADMIN_ID';
    throw err;
  }

  // 1. Pino Anti-Primary Shield: PROIBIDO calendário 'primary' ou 'default'
  const normCalId = (calendarId || '').trim().toLowerCase();
  if (!normCalId || normCalId === 'primary' || normCalId === 'default') {
    const err = new Error('ANTI_PRIMARY_VIOLATION: O uso do calendário principal ("primary" ou "default") é terminantemente proibido pelo Anti-Primary Shield em homologação.');
    err.code = 'ANTI_PRIMARY_VIOLATION';
    throw err;
  }

  // 2. Pino Demo Shield: PROIBIDO contas com is_demo = 1
  try {
    const userRow = db.prepare('SELECT is_demo FROM users WHERE id = ?').get(uId);
    if (userRow && Boolean(userRow.is_demo)) {
      const err = new Error('DEMO_TENANT_PROHIBITED: Tenants com flag de demonstração (is_demo=1) estão estritamente proibidos de abrir sessões reais.');
      err.code = 'DEMO_TENANT_PROHIBITED';
      throw err;
    }
  } catch (uErr) {
    if (uErr.code === 'DEMO_TENANT_PROHIBITED') throw uErr;
  }

  // 3. Validação do e-mail
  const emailTrimmed = (accountEmail || '').trim().toLowerCase();
  if (!emailTrimmed || !emailTrimmed.includes('@')) {
    const err = new Error('INVALID_EMAIL: E-mail da conta Google inválido.');
    err.code = 'INVALID_EMAIL';
    throw err;
  }

  // 4. Normalização da ação permitida (No modo WHATSAPP_NEW, força estritamente CREATE)
  let actionUpper = isWhatsAppNew ? 'CREATE' : String(allowedAction || 'CREATE').trim().toUpperCase();
  if (actionUpper === 'INSERT') actionUpper = 'CREATE';
  const VALID_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'ANY'];
  if (!VALID_ACTIONS.includes(actionUpper)) {
    const err = new Error(`INVALID_ACTION: Ação "${allowedAction}" inválida. Permitidas: ${VALID_ACTIONS.join(', ')}.`);
    err.code = 'INVALID_ACTION';
    throw err;
  }

  // 5. Normalização de TTL e execuções (máximo 30 minutos em homologação, exatamente 1 para WHATSAPP_NEW)
  const safeDuration = Math.min(Math.max(Number(durationMinutes) || 15, 1), 30);
  const safeMaxExecutions = isWhatsAppNew ? 1 : Math.min(Math.max(Number(maxExecutions) || 1, 1), 5);
  const allowNewAppointments = isWhatsAppNew ? 1 : 0;

  // Sanitização de telefone autorizado se fornecido
  let cleanAuthorizedPhone = null;
  if (authorizedClientPhone) {
    cleanAuthorizedPhone = String(authorizedClientPhone).replace(/\D/g, '') || null;
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + safeDuration * 60 * 1000).toISOString();

  // 6. Transação atômica: revoga qualquer sessão anterior ainda ativa para garantir unicidade estrita
  db.prepare(`
    UPDATE google_sync_test_sessions
    SET status = 'REVOKED',
        revoked_by = ?,
        revocation_reason = 'SUPERSEDED_BY_NEW_SESSION',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'ACTIVE'
  `).run(adminId);

  // 7. Insere a nova sessão
  const stmt = db.prepare(`
    INSERT INTO google_sync_test_sessions (
      session_token, user_id, appointment_id, calendar_id, account_email,
      session_type, authorized_client_phone, target_channel, allow_new_appointments,
      allowed_action, max_executions, executions_count, created_by,
      status, reason, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?, ?)
  `);

  const res = stmt.run(
    sessionToken,
    uId,
    aptId,
    calendarId.trim(),
    emailTrimmed,
    isWhatsAppNew ? 'WHATSAPP_NEW' : 'EXISTING_APPOINTMENT',
    cleanAuthorizedPhone,
    targetChannel || 'WHATSAPP_BOT',
    allowNewAppointments,
    actionUpper,
    safeMaxExecutions,
    adminId,
    (reason || '').slice(0, 500),
    expiresAt
  );

  const inserted = db.prepare('SELECT * FROM google_sync_test_sessions WHERE id = ?').get(res.lastInsertRowid);
  return sanitizeSession(inserted);
}

/**
 * Retorna a sessão ativa de homologação com lazy-expiration atômica.
 * Suporta chamada getActiveSession(userId) ou getActiveSession(dbInstance).
 *
 * @param {number|Object} [userIdOrDb]
 * @param {Object} [dbInstance]
 * @returns {Object|null}
 */
function getActiveSession(userIdOrDb = null, dbInstance = null) {
  let userId = null;
  let dbRef = dbInstance;
  if (typeof userIdOrDb === 'number' || (typeof userIdOrDb === 'string' && /^\d+$/.test(userIdOrDb))) {
    userId = Number(userIdOrDb);
  } else if (userIdOrDb && typeof userIdOrDb === 'object') {
    dbRef = userIdOrDb;
  }
  const db = getDb(dbRef);

  // Lazy-expire atômico pré-consulta
  cleanupExpiredSessions(dbRef);

  let query = `
    SELECT * FROM google_sync_test_sessions
    WHERE status = 'ACTIVE'
      AND datetime(expires_at) > datetime('now')
  `;
  const params = [];
  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }
  query += ' ORDER BY id DESC LIMIT 1';

  const row = db.prepare(query).get(...params);

  if (!row) return null;

  // Se já bateu o limite de execuções, completa atômico
  if (row.executions_count >= row.max_executions) {
    db.prepare(`
      UPDATE google_sync_test_sessions
      SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(row.id);
    return null;
  }

  const ttlSeconds = Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000));
  if (ttlSeconds <= 0) {
    db.prepare(`
      UPDATE google_sync_test_sessions
      SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(row.id);
    return null;
  }

  return sanitizeSession({
    ...row,
    ttl_seconds: ttlSeconds,
  });
}

/**
 * Registra o consumo de uma execução real da sessão.
 * Se atingir o limite `max_executions`, transiciona atômico para 'COMPLETED'.
 *
 * @param {number|string} sessionId
 * @param {Object} [dbInstance]
 * @returns {Object|null} Sessão atualizada
 */
function recordSessionExecution(sessionId, dbInstance = null) {
  const db = getDb(dbInstance);
  const sId = Number(sessionId);
  if (!sId) return null;

  db.prepare(`
    UPDATE google_sync_test_sessions
    SET executions_count = executions_count + 1,
        status = CASE WHEN (executions_count + 1) >= max_executions THEN 'COMPLETED' ELSE status END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'ACTIVE'
  `).run(sId);

  return db.prepare('SELECT * FROM google_sync_test_sessions WHERE id = ?').get(sId);
}

/**
 * Revoga uma sessão ativa (kill-switch / botão de pânico).
 * Se sessionId não for especificado, revoga a sessão atualmente ativa no sistema.
 * Suporta chamada revokeTestSession(id, options, db) ou revokeTestSession(id, adminId, reason).
 *
 * @param {number|string|null} [sessionId=null]
 * @param {Object|number} [options]
 * @param {Object|string} [dbInstance]
 * @returns {{ revoked: boolean, changes: number }}
 */
function revokeTestSession(
  sessionId = null,
  options = {},
  dbInstance = null
) {
  let adminId = null;
  let reasonText = 'Manual admin revocation';
  let dbRef = dbInstance;

  if (typeof options === 'number') {
    adminId = options;
    if (typeof dbInstance === 'string') {
      reasonText = dbInstance;
      dbRef = null;
    }
  } else if (options && typeof options === 'object') {
    adminId = options.revokedBy ? Number(options.revokedBy) : null;
    reasonText = (options.revocationReason || 'Manual admin revocation').slice(0, 500);
  }

  const db = getDb(dbRef);

  let result;
  if (sessionId) {
    result = db.prepare(`
      UPDATE google_sync_test_sessions
      SET status = 'REVOKED',
          revoked_by = ?,
          revocation_reason = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'ACTIVE'
    `).run(adminId, reasonText, Number(sessionId));
  } else {
    result = db.prepare(`
      UPDATE google_sync_test_sessions
      SET status = 'REVOKED',
          revoked_by = ?,
          revocation_reason = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'ACTIVE'
    `).run(adminId, reasonText);
  }

  return {
    revoked: result.changes > 0,
    changes: result.changes,
  };
}

/**
 * Retorna o histórico das últimas sessões de teste para auditoria.
 *
 * @param {number} [limit=20]
 * @param {Object} [dbInstance]
 * @returns {Array<Object>}
 */
function getSessionHistory(limit = 20, dbInstance = null) {
  const db = getDb(dbInstance);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = db.prepare(`
    SELECT id, session_token, user_id, appointment_id, calendar_id,
           account_email, allowed_action, max_executions, executions_count,
           created_by, status, reason, revoked_by, revocation_reason,
           expires_at, session_type, authorized_client_phone, target_channel,
           allow_new_appointments, created_at, updated_at
    FROM google_sync_test_sessions
    ORDER BY id DESC
    LIMIT ?
  `).all(safeLimit);
  return rows.map(sanitizeSession);
}

/**
 * Realiza o Dynamic Late-Binding atômico de um agendamento recém-criado via WhatsApp
 * à sessão ativa de homologação controlada do Google Calendar (COMANDO 064.1).
 *
 * @param {number|string} userId - Identificador do tenant do salão
 * @param {number|string} appointmentId - Identificador do agendamento recém-gerado
 * @param {Object} [context={}] - Metadados de segurança (origin, clientPhone)
 * @param {Object} [dbInstance=null] - Instância de banco injetável
 * @returns {Object|null} Sessão atualizada e sanitizada, ou null se não houver vinculação
 */
function bindAppointmentToActiveSession(userId, appointmentId, context = {}, dbInstance = null) {
  const db = getDb(dbInstance);
  const uId = Number(userId);
  const aptId = Number(appointmentId);

  if (!uId || !aptId || aptId <= 0) return null;

  // 1. Canal estrito: somente agendamentos originados pelo bot do WhatsApp
  const origin = String(context.origin || '').trim().toUpperCase();
  if (origin !== 'WHATSAPP_BOT') {
    return null;
  }

  // 2. Telefone do cliente
  const phoneUtils = require('../utils/phoneUtils');
  const clientPhoneDigits = context.clientPhone ? phoneUtils.cleanDigits(context.clientPhone) : null;

  // Em homologação, validação contra SALON_TEST_ALLOWED_PHONES
  const isHomologation = process.env.GOOGLE_SYNC_HOMOLOGATION_MODE === 'true';
  if (isHomologation && process.env.SALON_TEST_ALLOWED_PHONES) {
    const rawAllowed = process.env.SALON_TEST_ALLOWED_PHONES || '';
    const allowedList = rawAllowed.split(',').map((p) => phoneUtils.cleanDigits(p)).filter(Boolean);
    if (allowedList.length > 0 && clientPhoneDigits && !allowedList.includes(clientPhoneDigits)) {
      return null;
    }
  }

  // 3. Busca a sessão ativa elegível para Late-Binding
  cleanupExpiredSessions(dbInstance);

  const activeSession = db.prepare(`
    SELECT * FROM google_sync_test_sessions
    WHERE user_id = ?
      AND status = 'ACTIVE'
      AND (session_type = 'WHATSAPP_NEW' OR allow_new_appointments = 1 OR appointment_id = 0)
      AND allowed_action IN ('CREATE', 'ANY')
      AND datetime(expires_at) > datetime('now')
      AND executions_count < max_executions
    ORDER BY id DESC
    LIMIT 1
  `).get(uId);

  if (!activeSession) return null;

  // Se a sessão amarra um telefone específico, exige correspondência exata
  if (activeSession.authorized_client_phone) {
    const authPhoneDigits = phoneUtils.cleanDigits(activeSession.authorized_client_phone);
    if (authPhoneDigits && clientPhoneDigits && authPhoneDigits !== clientPhoneDigits) {
      return null;
    }
  }

  // 4. Update atômico com predicate lock
  const updateStmt = db.prepare(`
    UPDATE google_sync_test_sessions
    SET appointment_id = ?,
        allow_new_appointments = 0,
        session_type = 'EXISTING_APPOINTMENT',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'ACTIVE'
      AND (session_type = 'WHATSAPP_NEW' OR allow_new_appointments = 1 OR appointment_id = 0)
  `);

  const result = updateStmt.run(aptId, activeSession.id);
  if (result.changes === 0) return null;

  const updatedSession = db.prepare('SELECT * FROM google_sync_test_sessions WHERE id = ?').get(activeSession.id);
  return sanitizeSession(updatedSession);
}

module.exports = {
  ensureSchema,
  createTestSession,
  getActiveSession,
  getActiveTestSession: getActiveSession,
  bindAppointmentToActiveSession,
  recordSessionExecution,
  revokeTestSession,
  revokeSession: revokeTestSession,
  getSessionHistory,
  cleanupExpiredSessions,
  maskSessionToken,
  sanitizeSession,
};
