/**
 * RAIA AGENTES — SERVIÇO DE LEMBRETES AUTOMÁTICOS B2C (JÉSSICA BEAUTY)
 * 
 * Responsável pelo envio de lembretes automáticos de agendamento diretamente
 * no WhatsApp da cliente (B2C), com cálculo preciso de fuso horário em America/Sao_Paulo,
 * respeito a consentimento, controle de janelas de antecedência (24h),
 * idempotência na Transactional Outbox e isolamento multi-tenant estrito.
 */

const crypto = require('crypto');
const db = require('../database/db');
const phoneUtils = require('../utils/phoneUtils');
const outboxWorker = require('./outboxWorker');

let reminderDaemonInterval = null;

/**
 * Normalizes Brazilian phone numbers to international standard 55XXXXXXXXXXX
 */
function normalizePhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.startsWith('55')) return digits;
  return `55${digits}`;
}

/**
 * Explicitly parses a start_datetime string from SQLite as an America/Sao_Paulo (UTC-3) Date.
 * Handles both 'YYYY-MM-DDTHH:mm:ss' and 'YYYY-MM-DD HH:mm:ss' formats.
 * 
 * @param {string} startDtStr
 * @returns {Date|null}
 */
function parseDateInSaoPaulo(startDtStr) {
  if (!startDtStr || typeof startDtStr !== 'string') return null;
  const clean = startDtStr.trim().replace(' ', 'T');
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    const d = new Date(startDtStr);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, y, m, d, h, min, sec] = match;
  // Standard Brazilian time is UTC-3 (America/Sao_Paulo)
  const isoWithOffset = `${y}-${m}-${d}T${h}:${min}:${sec || '00'}-03:00`;
  const dateObj = new Date(isoWithOffset);
  return isNaN(dateObj.getTime()) ? null : dateObj;
}

/**
 * Formats date and time components in America/Sao_Paulo timezone for presentation.
 * 
 * @param {Date|string} dateInput
 * @returns {{ dateStr: string, timeStr: string }}
 */
function formatDateTimeSaoPaulo(dateInput) {
  const d = dateInput instanceof Date ? dateInput : parseDateInSaoPaulo(dateInput);
  if (!d || isNaN(d.getTime())) return { dateStr: '', timeStr: '' };

  const dateStr = d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  });

  const timeStr = d.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });

  return { dateStr, timeStr };
}

/**
 * Formats a Date object to local YYYY-MM-DDTHH:mm:ss in America/Sao_Paulo
 */
function toLocalISOString(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return null;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(d);
  const partMap = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  return `${partMap.year}-${partMap.month}-${partMap.day}T${partMap.hour}:${partMap.minute}:${partMap.second}`;
}

/**
 * Builds the friendly, professional 24h reminder message from Jéssica to the client.
 */
function build24hReminderMessage({ clientName, serviceName, staffName, salonName, startDt, endDt }) {
  const { dateStr, timeStr: startTimeStr } = formatDateTimeSaoPaulo(startDt);
  let endTimeStr = '';
  if (endDt) {
    endTimeStr = formatDateTimeSaoPaulo(endDt).timeStr;
  }
  const timeDisplay = endTimeStr ? `${startTimeStr} às ${endTimeStr}` : startTimeStr;

  return `Oi, ${clientName || 'tudo bem'}! Aqui é a Jéssica do *${salonName || 'Salão'}* ✨\n\n` +
         `Passando para lembrar do seu horário de *${serviceName || 'atendimento'}* amanhã!\n\n` +
         `📅 *Data*: ${dateStr}\n` +
         `⏰ *Horário*: ${timeDisplay}\n` +
         `👤 *Profissional*: ${staffName || 'Equipe'}\n\n` +
         `Se precisar remarcar ou cancelar, é só me avisar por aqui. Estamos te esperando! 💖`;
}

/**
 * Scans upcoming appointments and enqueues 24h reminders into the Transactional Outbox.
 * 
 * Rules:
 *  - Salon must have b2c_reminders_enabled = 1 (disabled by default)
 *  - Appointment status must be 'AGENDADO' or 'CONFIRMADO' (never CANCELADO)
 *  - Client must have consent (reminder_consent = 1)
 *  - Reminder status must be 'PENDING'
 *  - Current time must be within the 24h window (between 20h and 26h before appointment)
 *  - Enqueued with idempotent dedup_hash in whatsapp_notification_outbox
 * 
 * @param {Object} options
 * @param {number} [options.now] Current timestamp in ms (defaults to Date.now())
 * @param {number} [options.userId] Filter for specific salon user_id (optional)
 * @returns {Array} List of processed / enqueued reminder results
 */
function checkAndQueue24hReminders({ now = Date.now(), userId = null } = {}) {
  let query = `
    SELECT 
      a.id AS appointment_id,
      a.user_id,
      a.client_name,
      a.client_phone,
      a.start_datetime,
      a.end_datetime,
      a.service_id,
      a.status,
      a.reminder_24h_status,
      a.reminder_consent,
      cs.name AS service_name,
      st.name AS staff_name,
      sal.salon_name,
      sal.b2c_reminders_enabled
    FROM appointments a
    JOIN client_salons sal ON a.user_id = sal.user_id
    LEFT JOIN client_services cs ON a.service_id = cs.id
    LEFT JOIN client_staff st ON a.staff_id = st.id
    WHERE (a.reminder_24h_status = 'PENDING' OR a.reminder_24h_status IS NULL)
      AND a.status IN ('AGENDADO', 'CONFIRMADO', 'SCHEDULED', 'CONFIRMED')
      AND COALESCE(a.reminder_consent, 1) = 1
      AND sal.b2c_reminders_enabled = 1
      AND a.client_phone IS NOT NULL
  `;
  const params = [];

  if (userId) {
    query += ` AND a.user_id = ?`;
    params.push(userId);
  }

  query += ` ORDER BY a.start_datetime ASC LIMIT 100`;

  const candidates = db.prepare(query).all(...params);
  const results = [];

  for (const apt of candidates) {
    const cleanPhone = normalizePhone(apt.client_phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      // Invalid phone -> disable reminder
      db.prepare(`
        UPDATE appointments
        SET reminder_24h_status = 'DISABLED', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(apt.appointment_id);
      results.push({ appointmentId: apt.appointment_id, status: 'SKIPPED_INVALID_PHONE' });
      continue;
    }

    const aptDate = parseDateInSaoPaulo(apt.start_datetime);
    if (!aptDate) {
      results.push({ appointmentId: apt.appointment_id, status: 'SKIPPED_INVALID_DATE' });
      continue;
    }

    const diffMs = aptDate.getTime() - now;
    const diffHours = diffMs / (3600 * 1000);

    // Controlled 24h execution window: between 20h and 26h before appointment
    if (diffHours > 26) {
      // Still too early for the 24h reminder
      results.push({ appointmentId: apt.appointment_id, status: 'TOO_EARLY', diffHours });
      continue;
    }

    if (diffHours < 20) {
      // Past the 24h window (e.g. booked last minute or window expired)
      // Do not send a confusing "reminder for tomorrow" when it is only a few hours away
      db.prepare(`
        UPDATE appointments
        SET reminder_24h_status = 'DISABLED', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(apt.appointment_id);
      results.push({ appointmentId: apt.appointment_id, status: 'WINDOW_EXPIRED', diffHours });
      continue;
    }

    // Appointment is in the exact 24h window!
    const messageText = build24hReminderMessage({
      clientName: apt.client_name,
      serviceName: apt.service_name,
      staffName: apt.staff_name,
      salonName: apt.salon_name,
      startDt: apt.start_datetime,
      endDt: apt.end_datetime,
    });

    const rawSignature = `${apt.user_id}:${apt.appointment_id}:REMINDER_24H:${cleanPhone}:${apt.start_datetime}`;
    const dedupHash = crypto.createHash('sha256').update(rawSignature).digest('hex');

    // Check if an outbox record with this dedupHash already exists or active
    const existing = db.prepare(`
      SELECT id, status FROM whatsapp_notification_outbox
      WHERE (dedup_hash = ? OR (appointment_id = ? AND event_type = 'REMINDER_24H'))
        AND status IN ('PENDING', 'PROCESSING', 'SENT', 'SIMULATED', 'DEDUPLICATED')
      ORDER BY id DESC LIMIT 1
    `).get(dedupHash, apt.appointment_id);

    if (existing) {
      results.push({ appointmentId: apt.appointment_id, status: 'DEDUPLICATED', outboxId: existing.id });
      continue;
    }

    // Insert into Transactional Outbox
    const info = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (
        user_id, appointment_id, event_type, recipient_phone, message_text, dedup_hash, status
      ) VALUES (?, ?, 'REMINDER_24H', ?, ?, ?, 'PENDING')
    `).run(apt.user_id, apt.appointment_id, cleanPhone, messageText, dedupHash);

    const outboxId = info.lastInsertRowid;

    // Trigger immediate outbox dispatch (asynchronous, non-blocking)
    try {
      outboxWorker.notify();
    } catch (_) {}

    results.push({
      appointmentId: apt.appointment_id,
      status: 'ENQUEUED',
      outboxId,
      recipient: cleanPhone,
      diffHours: Number(diffHours.toFixed(1)),
    });
  }

  return results;
}

/**
 * Starts the periodic background daemon for Jéssica 24h reminders.
 * Runs checkAndQueue24hReminders every intervalMs (defaults to 60s).
 */
function startSalonReminderDaemon(intervalMs = 60000) {
  if (reminderDaemonInterval) clearInterval(reminderDaemonInterval);

  console.log(`⏰ [Jéssica Reminders] Daemon de lembretes B2C ativo (verificação a cada ${intervalMs / 1000}s).`);

  // Run initial check
  try {
    checkAndQueue24hReminders();
  } catch (err) {
    console.error('[Jéssica Reminders] Erro no ciclo inicial de lembretes:', err.message);
  }

  reminderDaemonInterval = setInterval(() => {
    try {
      checkAndQueue24hReminders();
    } catch (err) {
      console.error('[Jéssica Reminders] Erro no ciclo periódico de lembretes:', err.message);
    }
  }, intervalMs);
}

/**
 * Stops the periodic background daemon.
 */
function stopSalonReminderDaemon() {
  if (reminderDaemonInterval) {
    clearInterval(reminderDaemonInterval);
    reminderDaemonInterval = null;
  }
}

module.exports = {
  normalizePhone,
  parseDateInSaoPaulo,
  formatDateTimeSaoPaulo,
  toLocalISOString,
  build24hReminderMessage,
  checkAndQueue24hReminders,
  startSalonReminderDaemon,
  stopSalonReminderDaemon,
};
