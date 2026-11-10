/**
 * RAIA AGENTES — REPOSITÓRIO DE SESSÕES WHATSAPP MULTI-TENANT
 * Driver: node:sqlite DatabaseSync
 * Branch: security/raia-27-protecoes
 *
 * @module database/salonWhatsAppRepository
 */

const db = require('./db');

class SalonWhatsAppRepository {
  /**
   * Obtém a sessão atual de um salão/usuário
   * @param {number} userId
   * @returns {object|null}
   */
  static getSessionByUserId(userId) {
    return db.prepare(`
      SELECT * FROM client_salon_whatsapp_sessions WHERE user_id = ?
    `).get(Number(userId)) || null;
  }

  /**
   * Garante a existência do registro de sessão para o salão
   * @param {number} userId
   * @param {string} authDirPath
   * @returns {object}
   */
  static ensureSessionExists(userId, authDirPath) {
    db.prepare(`
      INSERT INTO client_salon_whatsapp_sessions (user_id, auth_dir_path, session_status)
      VALUES (?, ?, 'DISCONNECTED')
      ON CONFLICT(user_id) DO UPDATE SET
        auth_dir_path = COALESCE(client_salon_whatsapp_sessions.auth_dir_path, excluded.auth_dir_path),
        updated_at = CURRENT_TIMESTAMP
    `).run(Number(userId), authDirPath);

    return this.getSessionByUserId(userId);
  }

  /**
   * Registra a geração de um novo QR Code efêmero
   * @param {number} userId
   * @param {string} qrCodeDataUrl
   * @param {number} ttlSeconds
   */
  static updateQrCode(userId, qrCodeDataUrl, ttlSeconds = 60) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(`
      UPDATE client_salon_whatsapp_sessions
      SET session_status = 'WAITING_QR',
          pairing_method = 'QR',
          qr_code_cached = ?,
          qr_code_expires_at = ?,
          pairing_code_cached = NULL,
          pairing_code_expires_at = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(qrCodeDataUrl, expiresAt, Number(userId));

    db.prepare("UPDATE client_salons SET whatsapp_status = 'WAITING_QR', whatsapp_pairing_method = 'QR', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(Number(userId));
  }

  /**
   * Registra a solicitação de Pairing Code efêmero (8 dígitos)
   * @param {number} userId
   * @param {string} pairingCode
   * @param {number} ttlSeconds
   */
  static updatePairingCode(userId, pairingCode, ttlSeconds = 180) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(`
      UPDATE client_salon_whatsapp_sessions
      SET session_status = 'WAITING_CODE',
          pairing_method = 'CODE',
          pairing_code_cached = ?,
          pairing_code_expires_at = ?,
          qr_code_cached = NULL,
          qr_code_expires_at = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(pairingCode, expiresAt, Number(userId));

    db.prepare("UPDATE client_salons SET whatsapp_status = 'WAITING_CODE', whatsapp_pairing_method = 'CODE', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(Number(userId));
  }

  /**
   * Marca a sessão como conectada com sucesso
   * @param {number} userId
   * @param {object} params
   * @param {string} params.phone
   * @param {string} params.phoneJid
   * @param {string} [params.pairingMethod]
   */
  static markSessionConnected(userId, { phone, phoneJid, pairingMethod = 'QR' }) {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
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
      `).run(phone, phoneJid, pairingMethod, now, now, Number(userId));

      db.prepare(`
        UPDATE client_salons
        SET whatsapp_status = 'CONNECTED',
            whatsapp_phone = ?,
            whatsapp_last_connected_at = ?,
            whatsapp_pairing_method = ?,
            whatsapp_last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(phone, now, pairingMethod, Number(userId));

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Atualiza a sessão para desconectada ou erro
   * @param {number} userId
   * @param {object} [params]
   * @param {string} [params.status] 'DISCONNECTED' | 'CONNECTION_LOST' | 'ERROR'
   * @param {string|null} [params.error]
   * @param {boolean} [params.resetCredentials]
   */
  static markSessionDisconnected(userId, { status = 'DISCONNECTED', error = null, resetCredentials = false } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const resetFlag = resetCredentials ? 1 : 0;
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
      `).run(status, error, resetFlag, resetFlag, resetFlag, Number(userId));

      db.prepare(`
        UPDATE client_salons
        SET whatsapp_status = ?,
            whatsapp_phone = CASE WHEN ? = 1 THEN NULL ELSE whatsapp_phone END,
            whatsapp_last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(status, resetFlag, error, Number(userId));

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Atualiza o timestamp de heartbeat (ping)
   * @param {number} userId
   */
  static touchHeartbeat(userId) {
    db.prepare(`
      UPDATE client_salon_whatsapp_sessions
      SET last_seen_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(Number(userId));
  }

  /**
   * Insere um evento de log de conexão do salão
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
    const metadataStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    db.prepare(`
      INSERT INTO client_salon_whatsapp_logs (
        session_id, user_id, event_type, old_status, new_status,
        pairing_method, connected_phone, reason, ip_address, user_agent, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, Number(userId), eventType, oldStatus, newStatus,
      pairingMethod, connectedPhone, reason, ipAddress, userAgent, metadataStr
    );
  }

  /**
   * Recupera histórico recente de logs de conexão do salão
   * @param {number} userId
   * @param {number} limit
   * @returns {Array<object>}
   */
  static getRecentLogs(userId, limit = 20) {
    return db.prepare(`
      SELECT * FROM client_salon_whatsapp_logs
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(Number(userId), Number(limit));
  }
}

module.exports = SalonWhatsAppRepository;
