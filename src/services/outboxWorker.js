/**
 * RAIA AGENTES — WORKER DE PROCESSAMENTO RESILIENTE DAS FILAS OUTBOX
 * 
 * Gerencia a execução assíncrona, durável e idempotente das integrações externas:
 * - Google Calendar: criação, atualização e remoção de eventos com prevenção estrita de duplicações
 * - Notificações WhatsApp: envio para o responsável pelo salão com deduplicação persistente
 * - Estados controlados: PENDING -> PROCESSING -> SENT / SIMULATED / FAILED
 * - Backoff exponencial e limite de tentativas
 * - Recuperação automática de tarefas abandonadas após reinício do container
 * - Isolamento multi-tenant por user_id
 */

const crypto = require('crypto');
const db = require('../database/db');

let workerTimer = null;
let isProcessing = false;
let pendingTrigger = false;

/**
 * Recovers tasks stuck in PROCESSING state (e.g. from container restart or crash)
 */
function recoverStalledTasks() {
  try {
    // 5 minutes timeout for in-flight tasks
    const gStalled = db.prepare(`
      UPDATE google_sync_outbox
      SET status = 'PENDING', locked_at = NULL
      WHERE status = 'PROCESSING'
        AND datetime(locked_at) < datetime('now', '-5 minutes')
    `).run();

    const wStalled = db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET status = 'PENDING', locked_at = NULL
      WHERE status = 'PROCESSING'
        AND datetime(locked_at) < datetime('now', '-5 minutes')
    `).run();

    return {
      googleRecovered: gStalled.changes,
      whatsappRecovered: wStalled.changes,
    };
  } catch (err) {
    console.error('[OutboxWorker] Erro ao recuperar tarefas travadas:', err.message);
    return { googleRecovered: 0, whatsappRecovered: 0 };
  }
}

/**
 * Processes pending items in the Google Calendar sync outbox
 */
async function processGoogleSyncOutbox(filterUserId = null) {
  const googleCalendarService = require('./googleCalendarService');

  let sql = `
    SELECT * FROM google_sync_outbox
    WHERE status = 'PENDING'
      AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime('now'))
      AND attempts < COALESCE(max_attempts, 5)
  `;
  const params = [];
  if (filterUserId) {
    sql += ' AND user_id = ?';
    params.push(filterUserId);
  }
  sql += ' ORDER BY id ASC LIMIT 20';

  const items = db.prepare(sql).all(...params);

  let processedCount = 0;

  for (const item of items) {
    // 1. Lock item atomically
    const lock = db.prepare(`
      UPDATE google_sync_outbox
      SET status = 'PROCESSING', locked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PENDING'
    `).run(item.id);

    if (lock.changes === 0) continue;

    try {
      const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(item.appointment_id);
      if (!apt) {
        // Appointment was deleted or invalid
        db.prepare(`
          UPDATE google_sync_outbox
          SET status = 'FAILED', last_error = 'Agendamento não encontrado no banco de dados', processed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(item.id);
        continue;
      }

      const status = googleCalendarService.getConnectionStatus(item.user_id);
      if (!status.isConnected) {
        // Se a conta não está conectada, registra que está aguardando conexão
        db.prepare(`
          UPDATE google_sync_outbox
          SET status = 'PENDING', last_error = 'Google Calendar não conectado no momento',
              next_retry_at = datetime('now', '+15 minutes'), locked_at = NULL
          WHERE id = ?
        `).run(item.id);
        continue;
      }

      // 2. Executar ação idempotente
      let result = null;
      if (item.action === 'CREATE') {
        if (apt.google_event_id) {
          // Idempotência: evento já foi criado anteriormente no Google
          result = await googleCalendarService.updateCalendarEvent(item.user_id, apt.google_event_id, apt, apt.google_calendar_id);
        } else {
          result = await googleCalendarService.createCalendarEvent(item.user_id, apt);
        }
      } else if (item.action === 'UPDATE') {
        if (apt.google_event_id) {
          result = await googleCalendarService.updateCalendarEvent(item.user_id, apt.google_event_id, apt, apt.google_calendar_id);
        } else {
          result = await googleCalendarService.createCalendarEvent(item.user_id, apt);
        }
      } else if (item.action === 'DELETE') {
        if (apt.google_event_id) {
          result = await googleCalendarService.deleteCalendarEvent(item.user_id, apt.google_event_id, apt.google_calendar_id);
        } else {
          result = { success: true, reason: 'NO_EVENT_ID_TO_DELETE' };
        }
      }

      // 3. Sucesso na execução
      db.prepare(`
        UPDATE google_sync_outbox
        SET status = 'SENT', processed_at = CURRENT_TIMESTAMP, last_error = NULL
        WHERE id = ?
      `).run(item.id);

      db.prepare(`
        UPDATE appointments
        SET google_sync_status = 'SYNCED', google_sync_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(item.appointment_id);

      processedCount++;
    } catch (err) {
      const newAttempts = (item.attempts || 0) + 1;
      const maxAttempts = item.max_attempts || 5;
      const isFinal = newAttempts >= maxAttempts;
      const backoffMin = Math.min(Math.pow(2, newAttempts), 60);
      const nextRetry = new Date(Date.now() + backoffMin * 60000).toISOString();

      db.prepare(`
        UPDATE google_sync_outbox
        SET status = ?, attempts = ?, last_error = ?, next_retry_at = ?, locked_at = NULL
        WHERE id = ?
      `).run(isFinal ? 'FAILED' : 'PENDING', newAttempts, err.message, nextRetry, item.id);

      db.prepare(`
        UPDATE appointments
        SET google_sync_status = 'FAILED', google_sync_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(err.message, item.appointment_id);
    }
  }

  return processedCount;
}

/**
 * Processes pending items in the WhatsApp notification outbox
 */
async function processWhatsAppOutbox(filterUserId = null) {
  const salonNotificationService = require('./salonNotificationService');
  const whatsappClient = require('../whatsapp/client');

  let sql = `
    SELECT * FROM whatsapp_notification_outbox
    WHERE status = 'PENDING'
      AND (next_retry_at IS NULL OR datetime(next_retry_at) <= datetime('now'))
      AND attempts < COALESCE(max_attempts, 5)
  `;
  const params = [];
  if (filterUserId) {
    sql += ' AND user_id = ?';
    params.push(filterUserId);
  }
  sql += ' ORDER BY id ASC LIMIT 20';

  const items = db.prepare(sql).all(...params);

  let processedCount = 0;

  for (const item of items) {
    // 1. Lock item atomically
    const lock = db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET status = 'PROCESSING', locked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PENDING'
    `).run(item.id);

    if (lock.changes === 0) continue;

    try {
      // 2. Prevenção de duplicidades persistente:
      // Verifica se a mesma mensagem para o mesmo agendamento já foi enviada ou simulada nos últimos 5 minutos
      const recentDuplicate = db.prepare(`
        SELECT id FROM whatsapp_notification_outbox
        WHERE user_id = ? AND appointment_id = ? AND event_type = ?
          AND status IN ('SENT', 'SIMULATED')
          AND datetime(sent_at) >= datetime('now', '-5 minutes')
          AND id != ?
        LIMIT 1
      `).get(item.user_id, item.appointment_id, item.event_type, item.id);

      if (recentDuplicate) {
        db.prepare(`
          UPDATE whatsapp_notification_outbox
          SET status = 'DEDUPLICATED', sent_at = CURRENT_TIMESTAMP, last_error = 'Mensagem recente idêntica já enviada.', locked_at = NULL
          WHERE id = ?
        `).run(item.id);
        processedCount++;
        continue;
      }

      // 3. Regra de Segurança em Homologação / Testes (Proteção 12)
      const isTestOrHomolog = process.env.APP_MODE === 'staging'
        || process.env.HOMOLOGACAO === 'true'
        || process.env.NODE_ENV === 'test'
        || process.env.ALLOW_WHATSAPP_SENDING !== 'true';

      if (isTestOrHomolog) {
        // Marca expressamente como SIMULATED (nunca como SENT real)
        db.prepare(`
          UPDATE whatsapp_notification_outbox
          SET status = 'SIMULATED', is_simulated = 1, sent_at = CURRENT_TIMESTAMP, last_error = NULL, locked_at = NULL
          WHERE id = ?
        `).run(item.id);

        db.prepare(`
          UPDATE appointments
          SET whatsapp_notified = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(item.appointment_id);

        salonNotificationService.recordMockNotification(item);
        processedCount++;
        continue;
      }

      // 4. Envio em Produção Real com WhatsApp Conectado
      if (whatsappClient?.sendWhatsAppMessage) {
        const jid = `${item.recipient_phone}@s.whatsapp.net`;
        await whatsappClient.sendWhatsAppMessage(jid, item.message_text);

        db.prepare(`
          UPDATE whatsapp_notification_outbox
          SET status = 'SENT', is_simulated = 0, sent_at = CURRENT_TIMESTAMP, last_error = NULL, locked_at = NULL
          WHERE id = ?
        `).run(item.id);

        db.prepare(`
          UPDATE appointments
          SET whatsapp_notified = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(item.appointment_id);

        processedCount++;
      } else {
        throw new Error('Cliente WhatsApp offline ou não inicializado no servidor.');
      }
    } catch (err) {
      const newAttempts = (item.attempts || 0) + 1;
      const maxAttempts = item.max_attempts || 5;
      const isFinal = newAttempts >= maxAttempts;
      const backoffMin = Math.min(Math.pow(2, newAttempts), 60);
      const nextRetry = new Date(Date.now() + backoffMin * 60000).toISOString();

      db.prepare(`
        UPDATE whatsapp_notification_outbox
        SET status = ?, attempts = ?, last_error = ?, next_retry_at = ?, locked_at = NULL
        WHERE id = ?
      `).run(isFinal ? 'FAILED' : 'PENDING', newAttempts, err.message, nextRetry, item.id);
    }
  }

  return processedCount;
}

/**
 * Runs recovery and processes all pending outbox tasks
 */
async function processAllPending(filterUserId = null) {
  if (isProcessing) {
    pendingTrigger = true;
    return { skipped: true, isProcessing: true };
  }

  isProcessing = true;
  try {
    recoverStalledTasks();
    const gCount = await processGoogleSyncOutbox(filterUserId);
    const wCount = await processWhatsAppOutbox(filterUserId);
    return { success: true, googleProcessed: gCount, whatsappProcessed: wCount };
  } finally {
    isProcessing = false;
    if (pendingTrigger) {
      pendingTrigger = false;
      setImmediate(() => processAllPending());
    }
  }
}

/**
 * Wakes the worker to process outbox in the next tick
 */
function notify() {
  setImmediate(() => {
    processAllPending().catch((err) => {
      console.warn('[OutboxWorker] Erro durante processamento assíncrono notificado:', err.message);
    });
  });
}

/**
 * Starts the periodic outbox background worker
 */
function startWorker(intervalMs = 10000) {
  if (workerTimer) return;
  // Recover and process immediately on startup
  processAllPending().catch((e) => console.warn('[OutboxWorker] Erro no ciclo inicial:', e.message));
  workerTimer = setInterval(() => {
    processAllPending().catch((e) => console.warn('[OutboxWorker] Erro no ciclo periódico:', e.message));
  }, intervalMs);
  if (workerTimer.unref) workerTimer.unref();
}

/**
 * Stops the outbox background worker
 */
function stopWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

module.exports = {
  recoverStalledTasks,
  processGoogleSyncOutbox,
  processWhatsAppOutbox,
  processAllPending,
  notify,
  startWorker,
  stopWorker,
};
