/**
 * RAIA AGENTES — SERVIÇO DE INTEGRAÇÃO MULTI-TENANT COM GOOGLE CALENDAR
 * 
 * Permite que cada salão conecte individualmente sua própria conta Google Calendar via OAuth 2.0,
 * com isolamento estrito por user_id, criptografia AES-256-GCM dos tokens em repouso,
 * seleção de modalidade (Agenda Única do Salão ou Agenda por Profissional),
 * consulta de disponibilidade (Free/Busy), criação, remarcação e cancelamento idempotente de eventos.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const config = require('../config');
const db = require('../database/db');

// Mock handler for test environments
let mockHandler = null;

/**
 * Verifica se chamadas reais de rede para a API do Google Calendar são permitidas.
 * Bloqueio estrito fail-closed: exige GOOGLE_SYNC_LIVE_ENABLED=true, lista
 * GOOGLE_SYNC_ALLOWED_EMAILS não vazia e email da conta conectada explicitamente presente.
 * Lista vazia ou email ausente resultam obrigatoriamente em bloqueio.
 */
function isLiveGoogleSyncAllowed(accountEmail = null) {
  // Se houver um mockHandler ativo (testes automatizados com simulação em memória):
  if (isMockActive()) return true;

  // 1. Bloqueio fail-closed: exige GOOGLE_SYNC_LIVE_ENABLED=true
  if (process.env.GOOGLE_SYNC_LIVE_ENABLED !== 'true') {
    return false;
  }

  // 2. Exige e-mail da conta conectada válido
  if (!accountEmail || typeof accountEmail !== 'string') {
    return false;
  }
  const emailTrimmed = accountEmail.trim().toLowerCase();
  if (!emailTrimmed) {
    return false;
  }

  // 3. Exige lista GOOGLE_SYNC_ALLOWED_EMAILS não vazia
  const allowedList = (process.env.GOOGLE_SYNC_ALLOWED_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  if (allowedList.length === 0) {
    return false;
  }

  // 4. Exige email da conta conectada explicitamente presente na lista
  return allowedList.includes(emailTrimmed);
}


/**
 * Derives a 32-byte AES key from environment secrets
 */
function getEncryptionKey() {
  const secret = process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY 
    || process.env.MFA_ENCRYPTION_KEY;
  if (!secret || typeof secret !== 'string' || secret.trim().length < 16) {
    const err = new Error('MISSING_ENCRYPTION_KEY: GOOGLE_CALENDAR_ENCRYPTION_KEY obrigatória não configurada.');
    err.code = 'MISSING_ENCRYPTION_KEY';
    throw err;
  }
  return crypto.createHash('sha256').update(secret.trim()).digest();
}

/**
 * Encrypts token JSON string using AES-256-GCM
 */
function encryptTokens(tokensObj) {
  if (!tokensObj) return null;
  const plainText = typeof tokensObj === 'string' ? tokensObj : JSON.stringify(tokensObj);
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `aes-256-gcm:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM token string
 */
function decryptTokens(encryptedText) {
  if (!encryptedText) return null;
  if (!encryptedText.startsWith('aes-256-gcm:v1:')) {
    const err = new Error('INVALID_TOKEN_FORMAT: Formato de token não criptografado rejeitado por política de segurança.');
    err.code = 'INVALID_TOKEN_FORMAT';
    throw err;
  }

  const parts = encryptedText.split(':');
  if (parts.length !== 5) {
    const err = new Error('INVALID_TOKEN_FORMAT: Estrutura inválida de token encriptado.');
    err.code = 'INVALID_TOKEN_FORMAT';
    throw err;
  }

  const iv = Buffer.from(parts[2], 'hex');
  const authTag = Buffer.from(parts[3], 'hex');
  const ciphertext = parts[4];
  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

/**
 * Resolves Google OAuth credentials from env or filesystem
 */
function getGoogleCredentials() {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      client_id: process.env.GOOGLE_CLIENT_ID.trim(),
      client_secret: process.env.GOOGLE_CLIENT_SECRET.trim(),
      redirect_uri: process.env.GOOGLE_REDIRECT_URI || `${config.baseUrl}/api/cliente/integrations/google/callback`,
    };
  }

  // Check file paths
  const credPaths = [
    config.googleCredentialsPath,
    path.resolve(__dirname, '../../data/google_credentials.json'),
    path.resolve(__dirname, '../../google_credentials.json'),
  ];

  for (const p of credPaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        const creds = parsed.installed || parsed.web || parsed;
        if (creds.client_id && creds.client_secret) {
          return {
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            redirect_uri: (creds.redirect_uris && creds.redirect_uris[0]) 
              || `${config.baseUrl}/api/cliente/integrations/google/callback`,
          };
        }
      } catch (_) {}
    }
  }

  return {
    client_id: 'mock-google-client-id.apps.googleusercontent.com',
    client_secret: 'mock-google-client-secret',
    redirect_uri: `${config.baseUrl}/api/cliente/integrations/google/callback`,
  };
}

/**
 * Creates or retrieves OAuth2 client configured for a specific user
 */
function getOAuth2Client(userId = null) {
  const creds = getGoogleCredentials();
  const oauth2 = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uri
  );

  if (userId) {
    const row = db.prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ? AND is_connected = 1').get(userId);
    if (row && row.encrypted_tokens) {
      const tokens = decryptTokens(row.encrypted_tokens);
      if (tokens) {
        oauth2.setCredentials(tokens);

        // Auto-persist refreshed tokens
        oauth2.on('tokens', (newTokens) => {
          try {
            const merged = { ...tokens, ...newTokens };
            const enc = encryptTokens(merged);
            db.prepare(`
              UPDATE google_calendar_tokens
              SET encrypted_tokens = ?, last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ?
            `).run(enc, userId);
          } catch (e) {
            console.error('[GoogleCalendarService] Erro ao persistir tokens atualizados:', e.message);
          }
        });
      }
    }
  }

  return oauth2;
}

/**
 * Generates Google OAuth consent URL with Anti-CSRF state token
 */
function generateAuthUrl(userId) {
  if (mockHandler?.generateAuthUrl) {
    return mockHandler.generateAuthUrl(userId);
  }

  const oauth2 = getOAuth2Client();
  const state = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutos

  db.prepare(`
    INSERT OR REPLACE INTO oauth_states (state, user_id, provider, expires_at)
    VALUES (?, ?, 'google', ?)
  `).run(state, userId, expiresAt);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  });

  return { authUrl, state };
}

/**
 * Handles OAuth callback, validating Anti-CSRF state and saving tokens
 */
async function handleOAuthCallback(code, state, authenticatedUserId = null, options = {}) {
  if (mockHandler?.handleOAuthCallback) {
    return mockHandler.handleOAuthCallback(code, state, authenticatedUserId, options);
  }

  // 1. Validar Anti-CSRF State
  const stateRow = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  if (!stateRow) {
    const err = new Error('Estado de autenticação OAuth inválido ou expirado (CSRF_INVALID_STATE).');
    err.code = 'CSRF_INVALID_STATE';
    throw err;
  }

  if (Date.now() > stateRow.expires_at) {
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    const err = new Error('A solicitação de autorização expirou. Por favor, tente novamente.');
    err.code = 'STATE_EXPIRED';
    throw err;
  }

  // 2. Rejeitar sessões explicitamente expiradas
  if (authenticatedUserId === 'EXPIRED' || options?.sessionExpired) {
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    const err = new Error('Sessão expirada. Faça login novamente para concluir a vinculação do Google Calendar.');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }

  // 3. Rejeitar callbacks sem sessão autenticada válida
  if (!authenticatedUserId) {
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    const err = new Error('Autenticação de sessão obrigatória para concluir vinculação OAuth.');
    err.code = 'UNAUTHORIZED_OAUTH_CALLBACK';
    throw err;
  }

  // 4. Exigir estrita correspondência entre usuário autenticado e proprietário do state
  const userId = stateRow.user_id;
  if (Number(authenticatedUserId) !== Number(userId)) {
    db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    const err = new Error('Tentativa de vinculação cruzada entre contas de salões rejeitada por segurança.');
    err.code = 'CROSS_SALON_LINKING_REJECTED';
    throw err;
  }
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);

  // 2. Trocar código por tokens
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // 3. Obter email do titular da conta
  let accountEmail = null;
  try {
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const userInfo = await oauth2Api.userinfo.get();
    accountEmail = userInfo.data.email;
  } catch (_) {
    if (tokens.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8'));
        accountEmail = payload.email;
      } catch (_) {}
    }
  }

  const encTokens = encryptTokens(tokens);

  // 4. Execução atômica da vinculação e sanitização de outbox para evitar condições de corrida (Requisitos 2, 5 e 6)
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingToken = db.prepare('SELECT initial_connection_at, sync_existing_authorized FROM google_calendar_tokens WHERE user_id = ?').get(userId);
    const isFirstConnection = !existingToken || !existingToken.initial_connection_at;
    const connectionTimestamp = new Date().toISOString();
    const initialConnAt = isFirstConnection ? connectionTimestamp : existingToken.initial_connection_at;
    const syncAuthorized = (options?.syncExistingAppointments || existingToken?.sync_existing_authorized) ? 1 : 0;

    db.prepare(`
      INSERT INTO google_calendar_tokens (
        user_id, account_email, encrypted_tokens, scope, selected_calendar_id, 
        selected_calendar_name, sync_mode, is_connected, last_sync_at, last_error,
        initial_connection_at, connected_at, sync_existing_authorized
      )
      VALUES (?, ?, ?, ?, 'primary', 'Principal', 'SINGLE', 1, CURRENT_TIMESTAMP, NULL, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        account_email = excluded.account_email,
        encrypted_tokens = excluded.encrypted_tokens,
        is_connected = 1,
        last_sync_at = CURRENT_TIMESTAMP,
        last_error = NULL,
        connected_at = excluded.connected_at,
        initial_connection_at = COALESCE(google_calendar_tokens.initial_connection_at, excluded.initial_connection_at),
        sync_existing_authorized = CASE WHEN excluded.sync_existing_authorized = 1 THEN 1 ELSE google_calendar_tokens.sync_existing_authorized END,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, accountEmail || 'Conta Google', encTokens, tokens.scope || 'calendar', initialConnAt, connectionTimestamp, syncAuthorized);

    // Sanitização 1: Agendamentos históricos no passado (CREATE, UPDATE, DELETE sem ID Google real)
    db.prepare(`
      UPDATE google_sync_outbox
      SET status = 'SENT', processed_at = CURRENT_TIMESTAMP, last_error = 'SKIPPED: Agendamento histórico concluído no passado'
      WHERE user_id = ? AND status = 'PENDING'
        AND appointment_id IN (
          SELECT id FROM appointments 
          WHERE user_id = ? AND datetime(end_datetime) < datetime('now')
            AND (google_event_id IS NULL OR google_event_id = '' OR google_event_id LIKE 'sim_%')
        )
    `).run(userId, userId);

    // Sanitização 2: Agendamentos cancelados antes da conexão Google (CREATE, UPDATE, DELETE sem ID Google real)
    db.prepare(`
      UPDATE google_sync_outbox
      SET status = 'SENT', processed_at = CURRENT_TIMESTAMP, last_error = 'SKIPPED: Agendamento cancelado antes da conexão Google'
      WHERE user_id = ? AND status = 'PENDING'
        AND appointment_id IN (
          SELECT id FROM appointments 
          WHERE user_id = ? AND status IN ('CANCELADO', 'CANCELLED')
            AND (google_event_id IS NULL OR google_event_id = '' OR google_event_id LIKE 'sim_%')
        )
    `).run(userId, userId);

    db.prepare(`
      UPDATE appointments
      SET google_sync_status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status IN ('CANCELADO', 'CANCELLED')
        AND (google_event_id IS NULL OR google_event_id = '' OR google_event_id LIKE 'sim_%')
    `).run(userId);

    // Sanitização 3 (Proteção Crítica na Primeira Conexão - Requisitos 2, 3 e 5):
    // Na primeira conexão Google, agendamentos preexistentes NÃO devem ser sincronizados sem autorização explícita.
    // Abrange todas as ações da fila outbox (CREATE, UPDATE, DELETE) para agendamentos sem evento real.
    // Todos os registros no SQLite e histórico permanecem 100% preservados (não apaga registros).
    // Na reconexão (!isFirstConnection), novos agendamentos legítimos pós-conexão inicial NÃO são descartados.
    if (isFirstConnection && !syncAuthorized) {
      db.prepare(`
        UPDATE google_sync_outbox
        SET status = 'SENT', processed_at = CURRENT_TIMESTAMP, 
            last_error = 'SKIPPED_PRE_EXISTING: Agendamento preexistente à primeira conexão Google (requer autorização explícita)'
        WHERE user_id = ? AND status = 'PENDING'
          AND appointment_id IN (
            SELECT id FROM appointments 
            WHERE user_id = ? AND (google_event_id IS NULL OR google_event_id = '' OR google_event_id LIKE 'sim_%')
              AND datetime(created_at) <= datetime(?)
          )
      `).run(userId, userId, connectionTimestamp);

      db.prepare(`
        UPDATE appointments
        SET google_sync_status = 'NOT_SYNCED', 
            google_sync_error = 'Agendamento preexistente à conexão Google (aguardando autorização para sincronização em massa)',
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND (google_event_id IS NULL OR google_event_id = '' OR google_event_id LIKE 'sim_%')
          AND datetime(created_at) <= datetime(?)
          AND status NOT IN ('CANCELADO', 'CANCELLED')
          AND google_sync_status IN ('PENDING', 'NOT_CONNECTED', 'SIMULATED')
      `).run(userId, connectionTimestamp);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }

  return { success: true, userId, email: accountEmail };
}

/**
 * Disconnects Google Calendar account for a user
 */
async function disconnectUserCalendar(userId) {
  if (mockHandler?.disconnectUserCalendar) {
    return mockHandler.disconnectUserCalendar(userId);
  }

  const row = db.prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ?').get(userId);
  if (row && row.encrypted_tokens && isLiveGoogleSyncAllowed(row.account_email)) {
    try {
      const oauth2 = getOAuth2Client(userId);
      await oauth2.revokeCredentials();
    } catch (_) {}
  }

  db.prepare(`
    UPDATE google_calendar_tokens
    SET is_connected = 0, last_error = 'Conta desconectada pelo usuário.', updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(userId);

  return { success: true, message: 'Google Calendar desconectado com sucesso.' };
}

/**
 * Gets connection status and configuration for user
 */
function getConnectionStatus(userId) {
  if (mockHandler?.getConnectionStatus) {
    return mockHandler.getConnectionStatus(userId);
  }

  const row = db.prepare(`
    SELECT user_id, account_email, selected_calendar_id, selected_calendar_name,
           sync_mode, is_connected, last_sync_at, last_error,
           initial_connection_at, connected_at, sync_existing_authorized
    FROM google_calendar_tokens
    WHERE user_id = ?
  `).get(userId);

  if (!row || !row.is_connected) {
    return {
      isConnected: false,
      accountEmail: null,
      selectedCalendarId: 'primary',
      selectedCalendarName: 'Principal',
      syncMode: 'SINGLE',
      lastSyncAt: null,
      lastError: row?.last_error || null,
      initialConnectionAt: row?.initial_connection_at || null,
      connectedAt: row?.connected_at || null,
      syncExistingAuthorized: Boolean(row?.sync_existing_authorized),
    };
  }

  return {
    isConnected: true,
    accountEmail: row.account_email,
    selectedCalendarId: row.selected_calendar_id || 'primary',
    selectedCalendarName: row.selected_calendar_name || 'Principal',
    syncMode: row.sync_mode || 'SINGLE',
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    initialConnectionAt: row.initial_connection_at || null,
    connectedAt: row.connected_at || null,
    syncExistingAuthorized: Boolean(row.sync_existing_authorized),
  };
}

/**
 * Lists available Google Calendars in connected account
 */
async function listUserCalendars(userId) {
  if (mockHandler?.listUserCalendars) {
    return mockHandler.listUserCalendars(userId);
  }

  const status = getConnectionStatus(userId);
  if (!status.isConnected) {
    throw new Error('Nenhuma conta Google Calendar conectada para este salão.');
  }

  const oauth2 = getOAuth2Client(userId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  const res = await calendar.calendarList.list({ maxResults: 50 });
  const items = res.data.items || [];

  return items.map((cal) => ({
    id: cal.id,
    summary: cal.summary || 'Sem Título',
    description: cal.description || '',
    primary: !!cal.primary,
    selected: cal.id === status.selectedCalendarId,
  }));
}

/**
 * Sets selected calendar and modality (SINGLE or STAFF)
 */
function selectCalendar(userId, { calendarId, calendarName, syncMode }) {
  if (mockHandler?.selectCalendar) {
    return mockHandler.selectCalendar(userId, { calendarId, calendarName, syncMode });
  }

  const cleanMode = syncMode === 'STAFF' ? 'STAFF' : 'SINGLE';
  const cleanCalId = calendarId ? calendarId.trim() : 'primary';

  db.prepare(`
    UPDATE google_calendar_tokens
    SET selected_calendar_id = ?,
        selected_calendar_name = COALESCE(?, selected_calendar_name),
        sync_mode = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(cleanCalId, calendarName || null, cleanMode, userId);

  db.prepare(`
    UPDATE client_salons
    SET google_selected_calendar_id = ?,
        google_calendar_mode = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(cleanCalId, cleanMode, userId);

  return { success: true, selectedCalendarId: cleanCalId, syncMode: cleanMode };
}

/**
 * Tests connection and permissions on Google Calendar
 */
async function testConnection(userId) {
  if (mockHandler?.testConnection) {
    return mockHandler.testConnection(userId);
  }

  const status = getConnectionStatus(userId);
  if (!status.isConnected) {
    return { success: false, error: 'Google Calendar não está conectado.' };
  }

  if (!isLiveGoogleSyncAllowed(status.accountEmail)) {
    db.prepare(`
      UPDATE google_calendar_tokens
      SET last_sync_at = CURRENT_TIMESTAMP, last_error = NULL
      WHERE user_id = ?
    `).run(userId);

    return {
      success: true,
      message: `Conexão válida com ${status.accountEmail || 'Google Calendar'} (Homologação: Modo Seguro Simulado)!`,
      isSimulated: true,
    };
  }

  try {
    const oauth2 = getOAuth2Client(userId);
    const calendar = google.calendar({ version: 'v3', auth: oauth2 });
    await calendar.calendarList.list({ maxResults: 1 });

    db.prepare(`
      UPDATE google_calendar_tokens
      SET last_sync_at = CURRENT_TIMESTAMP, last_error = NULL
      WHERE user_id = ?
    `).run(userId);

    return {
      success: true,
      message: `Conexão válida e ativa com ${status.accountEmail || 'Google Calendar'}!`,
    };
  } catch (err) {
    const errMsg = err.message || 'Erro ao comunicar com Google Calendar';
    db.prepare(`
      UPDATE google_calendar_tokens
      SET last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(errMsg, userId);

    return { success: false, error: errMsg };
  }
}

/**
 * Queries busy slots from Google Calendar to prevent scheduling conflicts
 */
async function getGoogleBusySlots(userId, { timeMin, timeMax, calendarId = null, staffId = null }) {
  if (mockHandler?.getGoogleBusySlots) {
    return mockHandler.getGoogleBusySlots(userId, { timeMin, timeMax, calendarId, staffId });
  }

  const status = getConnectionStatus(userId);
  if (!status.isConnected) return [];

  if (!isLiveGoogleSyncAllowed(status.accountEmail)) {
    return [];
  }

  let calId = calendarId;
  let targetStaffId = staffId ? Number(staffId) : null;
  if (!calId && status.syncMode === 'STAFF') {
    if (!targetStaffId) {
      try {
        const salonAppointmentService = require('./salonAppointmentService');
        const effective = salonAppointmentService.resolveEffectiveStaff(userId, null);
        targetStaffId = effective.staffId;
      } catch (_) {}
    }
    if (targetStaffId) {
      const staffRow = db.prepare('SELECT google_calendar_id FROM client_staff WHERE id = ? AND user_id = ?').get(targetStaffId, userId);
      if (staffRow?.google_calendar_id) {
        calId = staffRow.google_calendar_id;
      }
    }
  }
  if (!calId) {
    calId = status.selectedCalendarId || 'primary';
  }

  const oauth2 = getOAuth2Client(userId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  try {
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        items: [{ id: calId }],
      },
    });

    const busyList = res.data.calendars?.[calId]?.busy || [];
    return busyList.map((b) => ({
      start: b.start,
      end: b.end,
      source: 'GOOGLE_CALENDAR',
    }));
  } catch (err) {
    console.warn(`[GoogleCalendarService] Aviso na consulta FreeBusy para salão ${userId}:`, err.message);
    const salon = db.prepare('SELECT google_require_sync_availability FROM client_salons WHERE user_id = ?').get(userId);
    if (salon && salon.google_require_sync_availability === 1) {
      throw new Error('Não foi possível verificar a disponibilidade no Google Calendar obrigatório. Tente novamente.');
    }
    return [];
  }
}

/**
 * Creates an event in the user's authorized Google Calendar
 */
async function createCalendarEvent(userId, appointment, targetCalendarId = null) {
  if (mockHandler?.createCalendarEvent) {
    return mockHandler.createCalendarEvent(userId, appointment, targetCalendarId);
  }

  const status = getConnectionStatus(userId);
  if (!status.isConnected) {
    return { success: false, reason: 'GOOGLE_NOT_CONNECTED' };
  }

  let calId = targetCalendarId;
  if (!calId && status.syncMode === 'STAFF' && appointment.staff_id) {
    const staffRow = db.prepare('SELECT google_calendar_id FROM client_staff WHERE id = ? AND user_id = ?').get(appointment.staff_id, userId);
    if (staffRow?.google_calendar_id) {
      calId = staffRow.google_calendar_id;
    }
  }
  if (!calId) {
    calId = status.selectedCalendarId || 'primary';
  }


  const oauth2 = getOAuth2Client(userId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  const clientName = appointment.client_name || 'Cliente';
  const serviceName = appointment.service_name || appointment.title || 'Atendimento';
  const staffName = appointment.staff_name || 'Profissional';
  const duration = appointment.duration_min || 45;

  // Identificador determinístico estável compatível com RFC 4648 Base32Hex da API Google Calendar
  const stableEventId = crypto
    .createHash('sha256')
    .update(`raia_salon_event_${userId}_${appointment.id}`)
    .digest('hex')
    .substring(0, 32);

  // Proteção de Homologação/Staging contra chamadas externas inadvertidas (Requisito 7)
  if (!isLiveGoogleSyncAllowed(status.accountEmail)) {
    const simEventId = `sim_${stableEventId.substring(0, 28)}`;

    db.prepare(`
      UPDATE appointments
      SET google_event_id = ?,
          google_calendar_id = ?,
          google_sync_status = 'SIMULATED',
          google_sync_error = 'Ambiente de Homologação: Sincronização segura simulada (GOOGLE_SYNC_LIVE_ENABLED=false)',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(simEventId, calId, appointment.id, userId);

    return {
      success: true,
      googleEventId: simEventId,
      calendarId: calId,
      isSimulated: true,
    };
  }

  const eventPayload = {
    id: stableEventId,
    summary: `${clientName} — ${serviceName} (${staffName})`,
    description: `Agendamento RAIA Agentes Jéssica\n\n` +
      `👤 Cliente: ${clientName}\n` +
      `✂️ Serviço: ${serviceName}\n` +
      `⏳ Duração: ${duration} minutos\n` +
      `💇 Profissional: ${staffName}\n` +
      `💰 Valor: R$ ${(appointment.price || 0).toFixed(2).replace('.', ',')}\n` +
      `📌 ID do Agendamento: #${appointment.id}\n` +
      `✅ Registrado pela Jéssica.`,
    extendedProperties: {
      private: {
        raia_appointment_id: String(appointment.id),
      },
    },
    start: {
      dateTime: new Date(appointment.start_datetime).toISOString(),
      timeZone: 'America/Sao_Paulo',
    },
    end: {
      dateTime: new Date(appointment.end_datetime).toISOString(),
      timeZone: 'America/Sao_Paulo',
    },
  };

  // Reconciliação determinística 1: buscar diretamente pelo identificador estável no Google
  try {
    const existingEv = await calendar.events.get({
      calendarId: calId,
      eventId: stableEventId,
    });
    if (existingEv?.data && existingEv.data.status !== 'cancelled') {
      db.prepare(`
        UPDATE appointments
        SET google_event_id = ?,
            google_calendar_id = ?,
            google_sync_status = 'SYNCED',
            google_sync_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(stableEventId, calId, appointment.id, userId);

      return { success: true, googleEventId: stableEventId, calendarId: calId, reconciled: true };
    }
  } catch (_) {
    // 404 esperado quando o evento ainda não existe no Google
  }

  // Reconciliação determinística 2: busca por query e propriedades estendidas
  try {
    const listRes = await calendar.events.list({
      calendarId: calId,
      q: `#${appointment.id}`,
      maxResults: 5,
    });
    const found = (listRes.data.items || []).find((ev) => 
      ev.status !== 'cancelled' &&
      ((ev.description && ev.description.includes(`ID do Agendamento: #${appointment.id}`)) ||
       (ev.extendedProperties?.private?.raia_appointment_id === String(appointment.id)))
    );
    if (found) {
      db.prepare(`
        UPDATE appointments
        SET google_event_id = ?,
            google_calendar_id = ?,
            google_sync_status = 'SYNCED',
            google_sync_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(found.id, calId, appointment.id, userId);

      return { success: true, googleEventId: found.id, calendarId: calId, reconciled: true };
    }
  } catch (reconcileErr) {
    console.warn(`[GoogleCalendarService] Aviso na busca determinística por evento existente:`, reconcileErr.message);
  }

  try {
    const res = await calendar.events.insert({
      calendarId: calId,
      requestBody: eventPayload,
    });

    const googleEventId = res.data.id || stableEventId;

    db.prepare(`
      UPDATE appointments
      SET google_event_id = ?,
          google_calendar_id = ?,
          google_sync_status = 'SYNCED',
          google_sync_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(googleEventId, calId, appointment.id, userId);

    return { success: true, googleEventId, calendarId: calId };
  } catch (err) {
    // Se o evento já existe (409 Conflict), reconcilia imediatamente vinculando o stableEventId
    if (err.code === 409 || err.message?.includes('already exists') || err.message?.includes('409')) {
      db.prepare(`
        UPDATE appointments
        SET google_event_id = ?,
            google_calendar_id = ?,
            google_sync_status = 'SYNCED',
            google_sync_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(stableEventId, calId, appointment.id, userId);

      return { success: true, googleEventId: stableEventId, calendarId: calId, reconciled: true };
    }

    const errMsg = err.message || 'Falha ao criar evento no Google Calendar';
    db.prepare(`
      UPDATE appointments
      SET google_sync_status = 'FAILED',
          google_sync_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(errMsg, appointment.id, userId);

    throw err;
  }
}

/**
 * Updates an existing Google Calendar event on reschedule
 */
async function updateCalendarEvent(userId, googleEventId, appointment, targetCalendarId = null) {
  if (mockHandler?.updateCalendarEvent) {
    return mockHandler.updateCalendarEvent(userId, googleEventId, appointment, targetCalendarId);
  }

  const status = getConnectionStatus(userId);
  if (!status.isConnected || !googleEventId) {
    return { success: false, reason: 'GOOGLE_NOT_CONNECTED_OR_MISSING_ID' };
  }

  let calId = targetCalendarId || appointment.google_calendar_id;
  if (!calId && status.syncMode === 'STAFF' && appointment.staff_id) {
    const staffRow = db.prepare('SELECT google_calendar_id FROM client_staff WHERE id = ? AND user_id = ?').get(appointment.staff_id, userId);
    if (staffRow?.google_calendar_id) {
      calId = staffRow.google_calendar_id;
    }
  }
  if (!calId) {
    calId = status.selectedCalendarId || 'primary';
  }

  // 1. Proteção de Homologação/Staging contra chamadas externas inadvertidas (Requisito 7 e Item 3)
  if (!isLiveGoogleSyncAllowed(status.accountEmail)) {
    const simEventId = googleEventId.startsWith('sim_')
      ? googleEventId
      : `sim_${googleEventId.substring(0, 28)}`;

    db.prepare(`
      UPDATE appointments
      SET google_event_id = ?,
          google_calendar_id = ?,
          google_sync_status = 'SIMULATED',
          google_sync_error = 'Ambiente de Homologação: Sincronização segura simulada (GOOGLE_SYNC_LIVE_ENABLED=false)',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(simEventId, calId, appointment.id, userId);

    return {
      success: true,
      googleEventId: simEventId,
      calendarId: calId,
      isSimulated: true,
    };
  }

  // 2. Transição de Simulado para Real (Item 3):
  // Se o ID for simulado (sim_ ou sim_gcal_), o evento ainda NÃO existe no Google Calendar real.
  // Nunca enviar IDs simulados para a API do Google (evita 404). Executa criação segura e idempotente.
  if (googleEventId.startsWith('sim_')) {
    return createCalendarEvent(userId, appointment, calId);
  }

  const oauth2 = getOAuth2Client(userId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  const clientName = appointment.client_name || 'Cliente';
  const serviceName = appointment.service_name || appointment.title || 'Atendimento';
  const staffName = appointment.staff_name || 'Profissional';
  const duration = appointment.duration_min || 45;

  const eventPayload = {
    summary: `${clientName} — ${serviceName} (${staffName})`,
    description: `Agendamento RAIA Agentes Jéssica (REMARCADO)\n\n` +
      `👤 Cliente: ${clientName}\n` +
      `✂️ Serviço: ${serviceName}\n` +
      `⏳ Duração: ${duration} minutos\n` +
      `💇 Profissional: ${staffName}\n` +
      `💰 Valor: R$ ${(appointment.price || 0).toFixed(2).replace('.', ',')}\n` +
      `📌 ID do Agendamento: #${appointment.id}\n` +
      `🔄 Atualizado pela Jéssica.`,
    start: {
      dateTime: new Date(appointment.start_datetime).toISOString(),
      timeZone: 'America/Sao_Paulo',
    },
    end: {
      dateTime: new Date(appointment.end_datetime).toISOString(),
      timeZone: 'America/Sao_Paulo',
    },
  };

  try {
    await calendar.events.patch({
      calendarId: calId,
      eventId: googleEventId,
      requestBody: eventPayload,
    });

    db.prepare(`
      UPDATE appointments
      SET google_sync_status = 'SYNCED',
          google_sync_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(appointment.id, userId);

    return { success: true, googleEventId, calendarId: calId };
  } catch (err) {
    const errMsg = err.message || 'Falha ao atualizar evento no Google Calendar';
    db.prepare(`
      UPDATE appointments
      SET google_sync_status = 'FAILED',
          google_sync_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(errMsg, appointment.id, userId);

    throw err;
  }
}

/**
 * Deletes or cancels a Google Calendar event on appointment cancellation
 */
async function deleteCalendarEvent(userId, googleEventId, targetCalendarId = null) {
  if (mockHandler?.deleteCalendarEvent) {
    return mockHandler.deleteCalendarEvent(userId, googleEventId, targetCalendarId);
  }

  const status = getConnectionStatus(userId);
  if (!status.isConnected || !googleEventId) {
    return { success: false, reason: 'GOOGLE_NOT_CONNECTED_OR_MISSING_ID' };
  }

  const calId = targetCalendarId || status.selectedCalendarId || 'primary';

  // Proteção contra chamadas de rede em ambiente simulado OU se o evento for simulado (nunca existiu no Google)
  if (!isLiveGoogleSyncAllowed(status.accountEmail) || googleEventId.startsWith('sim_')) {
    db.prepare(`
      UPDATE appointments
      SET google_sync_status = 'CANCELLED',
          google_sync_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE (google_event_id = ? OR id = ?) AND user_id = ?
    `).run(googleEventId, googleEventId, userId);

    return { success: true, isSimulated: true };
  }

  const oauth2 = getOAuth2Client(userId);
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  try {
    await calendar.events.delete({
      calendarId: calId,
      eventId: googleEventId,
    });

    db.prepare(`
      UPDATE appointments
      SET google_sync_status = 'CANCELLED',
          google_sync_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE google_event_id = ? AND user_id = ?
    `).run(googleEventId, userId);

    return { success: true };
  } catch (err) {
    // If already 404/410, treat as cleanly removed
    if (err.code === 404 || err.code === 410) {
      db.prepare(`
        UPDATE appointments
        SET google_sync_status = 'CANCELLED',
            google_sync_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE google_event_id = ? AND user_id = ?
      `).run(googleEventId, userId);
      return { success: true };
    }

    const errMsg = err.message || 'Falha ao remover evento no Google Calendar';
    db.prepare(`
      UPDATE appointments
      SET google_sync_status = 'FAILED',
          google_sync_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE google_event_id = ? AND user_id = ?
    `).run(errMsg, googleEventId, userId);

    throw err;
  }
}

/**
 * Mock Handler Setup for automated testing
 */
function setMockHandler(handler) {
  mockHandler = handler;
}

function resetMockHandler() {
  mockHandler = null;
}

function isMockActive() {
  return !!mockHandler;
}


/**
 * Retorna prévia dos agendamentos elegíveis para sincronização manual preexistente (Requisito 4)
 */
function getPreExistingSyncPreview(userId) {
  if (mockHandler?.getPreExistingSyncPreview) {
    return mockHandler.getPreExistingSyncPreview(userId);
  }

  const status = getConnectionStatus(userId);
  if (!status.isConnected) {
    return {
      canSync: false,
      reason: 'GOOGLE_NOT_CONNECTED',
      count: 0,
      appointments: [],
    };
  }

  const eligible = db.prepare(`
    SELECT id, client_name, title, start_datetime, end_datetime, price, google_sync_status, google_event_id
    FROM appointments
    WHERE user_id = ?
      AND (google_event_id IS NULL OR google_event_id = '' OR google_event_id LIKE 'sim_%')
      AND datetime(end_datetime) >= datetime('now')
      AND status NOT IN ('CANCELADO', 'CANCELLED', 'NO_SHOW', 'COMPLETED', 'CONCLUIDO', 'CONCLUÍDO')
      AND google_sync_status != 'PENDING'
      AND id NOT IN (
        SELECT appointment_id FROM google_sync_outbox
        WHERE user_id = ? AND status IN ('PENDING', 'PROCESSING')
      )
    ORDER BY start_datetime ASC
  `).all(userId, userId);

  return {
    canSync: true,
    count: eligible.length,
    appointments: eligible,
  };
}

/**
 * Sincronização controlada de agendamentos preexistentes para salões reais (Requisito 4).
 * Permite ao salão autorizar explicitamente a sincronização no Google Calendar de agendamentos futuros
 * criados antes da primeira vinculação com o Google.
 * Exige prévia confirmação explícita e previne duplicações no outbox.
 */
async function syncPreExistingAppointments(userId, options = {}) {
  if (mockHandler?.syncPreExistingAppointments) {
    return mockHandler.syncPreExistingAppointments(userId, options);
  }

  const status = getConnectionStatus(userId);
  if (!status.isConnected) {
    throw new Error('Google Calendar não está conectado para este salão.');
  }

  // Exigir confirmação prévia explícita estrita (apenas boolean true)
  const isConfirmed = options === true || (typeof options === 'object' && options !== null && options.confirmed === true);
  if (!isConfirmed) {
    const preview = getPreExistingSyncPreview(userId);
    const err = new Error(`CONFIRMATION_REQUIRED: A sincronização em massa requer confirmação prévia e explícita (confirmed: true). Existem ${preview.count} agendamento(s) elegível(is).`);
    err.code = 'CONFIRMATION_REQUIRED';
    err.eligibleCount = preview.count;
    throw err;
  }

  // 1. Gravar autorização explícita
  db.prepare(`
    UPDATE google_calendar_tokens
    SET sync_existing_authorized = 1, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(userId);

  db.prepare(`
    UPDATE client_salons
    SET google_sync_existing_authorized = 1, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(userId);

  // 2. Buscar agendamentos futuros não cancelados sem evento Google real e sem duplicatas pendentes
  const eligible = db.prepare(`
    SELECT * FROM appointments
    WHERE user_id = ?
      AND (google_event_id IS NULL OR google_event_id = '' OR google_event_id LIKE 'sim_%')
      AND datetime(end_datetime) >= datetime('now')
      AND status NOT IN ('CANCELADO', 'CANCELLED', 'NO_SHOW', 'COMPLETED', 'CONCLUIDO', 'CONCLUÍDO')
      AND google_sync_status != 'PENDING'
      AND id NOT IN (
        SELECT appointment_id FROM google_sync_outbox
        WHERE user_id = ? AND status IN ('PENDING', 'PROCESSING')
      )
    ORDER BY start_datetime ASC
  `).all(userId, userId);

  let enqueuedCount = 0;

  for (const apt of eligible) {
    const payload = {
      startDt: apt.start_datetime,
      endDt: apt.end_datetime,
      finalServiceName: apt.title,
      clientName: apt.client_name,
      resolvedStaffName: 'Profissional',
    };

    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'CREATE', 'PENDING', ?)
    `).run(userId, apt.id, JSON.stringify(payload));

    db.prepare(`
      UPDATE appointments
      SET google_sync_status = 'PENDING', google_sync_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(apt.id);

    enqueuedCount++;
  }

  // 3. Disparar worker assíncrono para processar a fila imediatamente usando notify()
  try {
    const outboxWorker = require('./outboxWorker');
    if (typeof outboxWorker.notify === 'function') {
      outboxWorker.notify();
    } else if (typeof outboxWorker.triggerWorkerImmediate === 'function') {
      outboxWorker.triggerWorkerImmediate(userId);
    }
  } catch (_) {}

  return {
    success: true,
    enqueuedCount,
    eligibleTotal: eligible.length,
    message: `${enqueuedCount} agendamento(s) preexistente(s) enfileirado(s) com sucesso para sincronização no Google Calendar.`,
  };
}

module.exports = {
  encryptTokens,
  decryptTokens,
  generateAuthUrl,
  handleOAuthCallback,
  disconnectUserCalendar,
  getConnectionStatus,
  listUserCalendars,
  selectCalendar,
  testConnection,
  getGoogleBusySlots,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getPreExistingSyncPreview,
  syncPreExistingAppointments,
  isLiveGoogleSyncAllowed,
  setMockHandler,
  resetMockHandler,
  isMockActive,
};
