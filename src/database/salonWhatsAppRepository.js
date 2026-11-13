/**
 * RAIA AGENTES — REPOSITÓRIO DE SESSÕES WHATSAPP MULTI-TENANT
 * Driver: node:sqlite DatabaseSync (Node 22)
 * Branch: security/raia-27-protecoes
 *
 * Diretrizes Mandatórias:
 * 1. 100% de consultas preparadas com marcadores de posição (?)
 * 2. Transações atômicas BEGIN IMMEDIATE para evitar lock contention
 * 3. Proibição de armazenamento em disco de QR Code ou Pairing Code brutos (OWASP ASVS 5.0)
 *
 * @module database/salonWhatsAppRepository
 */

const db = require('./db');

const ALLOWED_SESSION_STATUSES = Object.freeze([
  'DISCONNECTED',
  'WAITING_QR',
  'WAITING_CODE',
  'CONNECTING',
  'CONNECTED',
  'CONNECTION_LOST',
  'ERROR',
  'KMS_UNAVAILABLE',
  'NOT_MIGRATED',
]);

const ALLOWED_EVENT_TYPES = Object.freeze([
  'STATUS_CHANGE',
  'QR_GENERATED',
  'PAIRING_CODE_REQUESTED',
  'CONNECTED',
  'DISCONNECTED',
  'RECONNECTING',
  'AUTH_FAILURE',
  'ERROR',
  'LOGOUT_USER',
]);

class SalonWhatsAppRepository {
  /**
   * Sanitiza recursivamente strings e objetos de log para impedir vazamento de credenciais efêmeras
   * @private
   * @param {*} value
   * @returns {*}
   */
  static _sanitizeLogPayload(value) {
    if (!value) return null;

    if (typeof value === 'string') {
      return value
        .replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/gi, '[REDACTED_IMAGE_DATA]')
        .replace(/\b([A-Za-z0-9]{4}-[A-Za-z0-9]{4})\b/gi, '[REDACTED_PAIRING_CODE]')
        .replace(/\b(\d{8})\b/g, () => '[REDACTED_PAIRING_CODE]');
    }

    if (typeof value === 'object') {
      try {
        const copy = JSON.parse(JSON.stringify(value));
        const sensitiveKeys = [
          'code', 'pairingcode', 'pairing_code',
          'qr', 'qrcode', 'qr_code',
          'dataurl', 'data_url', 'secret', 'token'
        ];

        const redactRecursive = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          for (const key of Object.keys(obj)) {
            const lowerKey = key.toLowerCase();
            if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
              obj[key] = '[REDACTED_CREDENTIAL]';
            } else if (typeof obj[key] === 'string') {
              obj[key] = SalonWhatsAppRepository._sanitizeLogPayload(obj[key]);
            } else if (typeof obj[key] === 'object') {
              redactRecursive(obj[key]);
            }
          }
        };

        redactRecursive(copy);
        return JSON.stringify(copy);
      } catch (_) {
        return null;
      }
    }

    return String(value);
  }

  /**
   * Obtém a sessão atual de um salão/usuário sem expor credenciais em disco
   * @param {number} userId
   * @returns {object|null}
   */
  static getSessionByUserId(userId) {
    try {
      return db.prepare(`
        SELECT 
          id,
          user_id,
          session_status,
          connected_phone,
          connected_phone_jid,
          connected_at,
          last_seen_at,
          last_error,
          pairing_method,
          NULL AS qr_code_cached,
          qr_code_expires_at,
          NULL AS pairing_code_cached,
          pairing_code_expires_at,
          auth_dir_path,
          reconnect_attempts,
          created_at,
          updated_at
        FROM client_salon_whatsapp_sessions
        WHERE user_id = ?
      `).get(Number(userId)) || null;
    } catch (err) {
      console.error(`[salonWhatsAppRepository] getSessionByUserId falhou (#${userId}):`, err.message);
      return null;
    }
  }

  /**
   * Garante a existência do registro de sessão para o salão
   * @param {number} userId
   * @param {string} authDirPath
   * @returns {object}
   */
  static ensureSessionExists(userId, authDirPath = null) {
    try {
      db.prepare(`
        INSERT INTO client_salon_whatsapp_sessions (user_id, auth_dir_path, session_status)
        VALUES (?, ?, 'DISCONNECTED')
        ON CONFLICT(user_id) DO UPDATE SET
          auth_dir_path = COALESCE(client_salon_whatsapp_sessions.auth_dir_path, excluded.auth_dir_path),
          updated_at = CURRENT_TIMESTAMP
      `).run(Number(userId), authDirPath || null);

      return this.getSessionByUserId(userId);
    } catch (err) {
      console.error(`[salonWhatsAppRepository] ensureSessionExists falhou (#${userId}):`, err.message);
      return null;
    }
  }

  /**
   * Registra a geração de um novo QR Code efêmero.
   * CORREÇÃO 5: Elimina persistência de QR Code bruto no SQLite; armazena apenas expiração e estado.
   * Operação atômica em transação BEGIN IMMEDIATE.
   *
   * @param {number} userId
   * @param {string|null} [_ignoredQrCode] Ignorado intencionalmente (mantido apenas em memória)
   * @param {number} [ttlSeconds=60]
   */
  static updateQrCode(userId, _ignoredQrCode = null, ttlSeconds = 60) {
    const uid = Number(userId);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`
        UPDATE client_salon_whatsapp_sessions
        SET session_status = 'WAITING_QR',
            pairing_method = 'QR',
            qr_code_cached = NULL,
            qr_code_expires_at = ?,
            pairing_code_cached = NULL,
            pairing_code_expires_at = NULL,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(expiresAt, uid);

      db.prepare(`
        UPDATE client_salons
        SET whatsapp_status = 'WAITING_QR',
            whatsapp_pairing_method = 'QR',
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(uid);

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error(`[salonWhatsAppRepository] updateQrCode falhou (#${uid}):`, err.message);
    }
  }

  /**
   * Registra a solicitação de Pairing Code efêmero (8 dígitos).
   * CORREÇÃO 5: Elimina persistência do código no SQLite; armazena apenas expiração e estado.
   * Operação atômica em transação BEGIN IMMEDIATE.
   *
   * @param {number} userId
   * @param {string|null} [_ignoredPairingCode] Ignorado intencionalmente (mantido apenas em memória)
   * @param {number} [ttlSeconds=180]
   */
  static updatePairingCode(userId, _ignoredPairingCode = null, ttlSeconds = 180) {
    const uid = Number(userId);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`
        UPDATE client_salon_whatsapp_sessions
        SET session_status = 'WAITING_CODE',
            pairing_method = 'CODE',
            pairing_code_cached = NULL,
            pairing_code_expires_at = ?,
            qr_code_cached = NULL,
            qr_code_expires_at = NULL,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(expiresAt, uid);

      db.prepare(`
        UPDATE client_salons
        SET whatsapp_status = 'WAITING_CODE',
            whatsapp_pairing_method = 'CODE',
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(uid);

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error(`[salonWhatsAppRepository] updatePairingCode falhou (#${uid}):`, err.message);
    }
  }

  /**
   * Marca a sessão como conectada com sucesso
   * @param {number} userId
   * @param {object} params
   * @param {string} params.phone
   * @param {string} params.phoneJid
   * @param {string} [params.pairingMethod='QR']
   */
  static markSessionConnected(userId, { phone, phoneJid, pairingMethod = 'QR' }) {
    const uid = Number(userId);
    const now = new Date().toISOString();

    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`
        UPDATE client_salon_whatsapp_sessions
        SET session_status = 'CONNECTED',
            connected_phone = ?,
            connected_phone_jid = ?,
            pairing_method = ?,
            connected_at = ?,
            last_seen_at = ?,
            last_error = NULL,
            reconnect_attempts = 0,
            qr_code_cached = NULL,
            qr_code_expires_at = NULL,
            pairing_code_cached = NULL,
            pairing_code_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(phone, phoneJid, pairingMethod, now, now, uid);

      db.prepare(`
        UPDATE client_salons
        SET whatsapp_status = 'CONNECTED',
            whatsapp_phone = ?,
            whatsapp_last_connected_at = ?,
            whatsapp_pairing_method = ?,
            whatsapp_last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(phone, now, pairingMethod, uid);

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error(`[salonWhatsAppRepository] markSessionConnected falhou (#${uid}):`, err.message);
    }
  }

  /**
   * Atualiza a sessão para desconectada ou erro
   * @param {number} userId
   * @param {object} [params]
   * @param {string} [params.status='DISCONNECTED'] 'DISCONNECTED' | 'CONNECTION_LOST' | 'ERROR'
   * @param {string|null} [params.error=null]
   * @param {boolean} [params.resetCredentials=false]
   */
  static markSessionDisconnected(userId, { status = 'DISCONNECTED', error = null, resetCredentials = false } = {}) {
    const uid = Number(userId);
    const resetFlag = resetCredentials ? 1 : 0;
    const safeStatus = ALLOWED_SESSION_STATUSES.includes(status) ? status : 'DISCONNECTED';

    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`
        UPDATE client_salon_whatsapp_sessions
        SET session_status = ?,
            last_error = ?,
            qr_code_cached = NULL,
            qr_code_expires_at = NULL,
            pairing_code_cached = NULL,
            pairing_code_expires_at = NULL,
            connected_phone = CASE WHEN ? = 1 THEN NULL ELSE connected_phone END,
            connected_phone_jid = CASE WHEN ? = 1 THEN NULL ELSE connected_phone_jid END,
            connected_at = CASE WHEN ? = 1 THEN NULL ELSE connected_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(safeStatus, error, resetFlag, resetFlag, resetFlag, uid);

      db.prepare(`
        UPDATE client_salons
        SET whatsapp_status = ?,
            whatsapp_phone = CASE WHEN ? = 1 THEN NULL ELSE whatsapp_phone END,
            whatsapp_last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(safeStatus, resetFlag, error, uid);

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.error(`[salonWhatsAppRepository] markSessionDisconnected falhou (#${uid}):`, err.message);
    }
  }

  /**
   * CORREÇÃO 3: Busca todas as sessões ativas elegíveis para restauração automática no boot.
   * Seleciona sessões em CONNECTED ou CONNECTION_LOST que não estejam explicitamente com DISCONNECTED.
   * Consulta protegida com LIMIT explícito e parâmetros seguros.
   *
   * @param {object} [options]
   * @param {number} [options.limit=100]
   * @returns {Array<object>}
   */
  static getActiveSessionsForRestore({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));

    try {
      return db.prepare(`
        SELECT 
          id,
          user_id,
          session_status,
          connected_phone,
          connected_phone_jid,
          pairing_method,
          auth_dir_path,
          reconnect_attempts,
          last_seen_at,
          created_at,
          updated_at
        FROM client_salon_whatsapp_sessions
        WHERE session_status IN ('CONNECTED', 'CONNECTION_LOST', 'CONNECTING', 'KMS_UNAVAILABLE', 'NOT_MIGRATED')
          AND session_status NOT IN ('DISCONNECTED', 'ERROR', 'WAITING_QR', 'WAITING_CODE')
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(safeLimit);
    } catch (err) {
      console.error('[salonWhatsAppRepository] getActiveSessionsForRestore falhou:', err.message);
      return [];
    }
  }

  /**
   * Atualiza o timestamp de heartbeat (ping)
   * @param {number} userId
   */
  static touchHeartbeat(userId) {
    try {
      db.prepare(`
        UPDATE client_salon_whatsapp_sessions
        SET last_seen_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(Number(userId));
    } catch (err) {
      console.error(`[salonWhatsAppRepository] touchHeartbeat falhou (#${userId}):`, err.message);
    }
  }

  /**
   * Insere um evento de log de conexão do salão com sanitização defensiva contra vazamento de segredos.
   * CORREÇÃO 5: Garante que QR Code e códigos de pareamento NUNCA entrem na tabela client_salon_whatsapp_logs.
   *
   * @param {number} userId
   * @param {object} logData
   */
  static createLog(userId, {
    sessionId = null,
    eventType,
    oldStatus = null,
    newStatus = null,
    pairingMethod = null,
    connectedPhone = null,
    reason = null,
    ipAddress = null,
    userAgent = null,
    metadata = null,
  }) {
    try {
      const safeEventType = ALLOWED_EVENT_TYPES.includes(eventType) ? eventType : 'DISCONNECTED';
      const safeOldStatus = oldStatus && ALLOWED_SESSION_STATUSES.includes(oldStatus) ? oldStatus : null;
      const safeNewStatus = newStatus && ALLOWED_SESSION_STATUSES.includes(newStatus) ? newStatus : null;
      const safePairingMethod = ['QR', 'CODE'].includes(pairingMethod) ? pairingMethod : null;
      const sanitizedReason = reason ? SalonWhatsAppRepository._sanitizeLogPayload(reason) : null;
      const metadataStr = metadata ? SalonWhatsAppRepository._sanitizeLogPayload(metadata) : null;

      db.prepare(`
        INSERT INTO client_salon_whatsapp_logs (
          session_id, user_id, event_type, old_status, new_status,
          pairing_method, connected_phone, reason, ip_address, user_agent, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId, Number(userId), safeEventType, safeOldStatus, safeNewStatus,
        safePairingMethod, connectedPhone, sanitizedReason, ipAddress, userAgent, metadataStr
      );
    } catch (err) {
      console.error(`[salonWhatsAppRepository] createLog falhou (#${userId}):`, err.message);
    }
  }

  /**
   * Recupera histórico recente de logs de conexão do salão
   * @param {number} userId
   * @param {number} [limit=20]
   * @returns {Array<object>}
   */
  static getRecentLogs(userId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));

    try {
      return db.prepare(`
        SELECT 
          id, session_id, user_id, event_type, old_status, new_status,
          pairing_method, connected_phone, reason, ip_address, user_agent,
          metadata_json, created_at
        FROM client_salon_whatsapp_logs
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(Number(userId), safeLimit);
    } catch (err) {
      console.error(`[salonWhatsAppRepository] getRecentLogs falhou (#${userId}):`, err.message);
      return [];
    }
  }
}

module.exports = SalonWhatsAppRepository;
