/**
 * RAIA AGENTES — NOTIFICAÇÕES AUTOMÁTICAS NO WHATSAPP DO SALÃO
 * 
 * Notifica a dona do salão ou responsável sobre agendamentos confirmados, cancelamentos,
 * remarcações e falhas de sincronização, com persistência em fila (outbox),
 * prevenção estrita de duplicidades, isolamento multi-tenant e independência de falha
 * (uma falha de envio de WhatsApp jamais cancela ou prejudica a reserva da cliente).
 */

const db = require('../database/db');
const whatsappClient = require('../whatsapp/client');

let mockHandler = null;
let mockNotificationHistory = [];

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
 * Retrieves WhatsApp notification settings for a salon user
 */
function getNotificationSettings(userId) {
  if (mockHandler?.getNotificationSettings) {
    return mockHandler.getNotificationSettings(userId);
  }

  const row = db.prepare(`
    SELECT whatsapp_notification_phone, whatsapp_notifications_enabled,
           notify_new_appointment, notify_cancellation, notify_reschedule, notify_sync_failure,
           phone, salon_name
    FROM client_salons
    WHERE user_id = ?
  `).get(userId);

  return {
    notificationPhone: row?.whatsapp_notification_phone || row?.phone || '',
    notificationsEnabled: row?.whatsapp_notifications_enabled !== 0,
    notifyNewAppointment: row?.notify_new_appointment !== 0,
    notifyCancellation: row?.notify_cancellation !== 0,
    notifyReschedule: row?.notify_reschedule !== 0,
    notifySyncFailure: row?.notify_sync_failure !== 0,
    salonName: row?.salon_name || 'Salão',
  };
}

/**
 * Updates WhatsApp notification settings for a salon
 */
function updateNotificationSettings(userId, {
  notificationPhone,
  notificationsEnabled,
  notifyNewAppointment,
  notifyCancellation,
  notifyReschedule,
  notifySyncFailure,
}) {
  if (mockHandler?.updateNotificationSettings) {
    return mockHandler.updateNotificationSettings(userId, {
      notificationPhone,
      notificationsEnabled,
      notifyNewAppointment,
      notifyCancellation,
      notifyReschedule,
      notifySyncFailure,
    });
  }

  const cleanPhone = notificationPhone !== undefined ? normalizePhone(notificationPhone) : null;

  db.prepare(`
    UPDATE client_salons
    SET whatsapp_notification_phone = COALESCE(?, whatsapp_notification_phone),
        whatsapp_notifications_enabled = COALESCE(?, whatsapp_notifications_enabled),
        notify_new_appointment = COALESCE(?, notify_new_appointment),
        notify_cancellation = COALESCE(?, notify_cancellation),
        notify_reschedule = COALESCE(?, notify_reschedule),
        notify_sync_failure = COALESCE(?, notify_sync_failure),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    cleanPhone,
    notificationsEnabled !== undefined ? (notificationsEnabled ? 1 : 0) : null,
    notifyNewAppointment !== undefined ? (notifyNewAppointment ? 1 : 0) : null,
    notifyCancellation !== undefined ? (notifyCancellation ? 1 : 0) : null,
    notifyReschedule !== undefined ? (notifyReschedule ? 1 : 0) : null,
    notifySyncFailure !== undefined ? (notifySyncFailure ? 1 : 0) : null,
    userId
  );

  return getNotificationSettings(userId);
}

/**
 * Formats date and time strings for Brazilian presentation
 */
function formatDateTimeStrings(startDt, endDt) {
  const start = new Date(startDt);
  const end = endDt ? new Date(endDt) : new Date(start.getTime() + 45 * 60000);

  const dateStr = start.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  });

  const startTimeStr = start.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });

  const endTimeStr = end.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });

  return { dateStr, startTimeStr, endTimeStr };
}

/**
 * Generates message for new confirmed appointment
 */
function buildNewAppointmentMessage({ clientName, serviceName, staffName, startDt, endDt }) {
  const { dateStr, startTimeStr, endTimeStr } = formatDateTimeStrings(startDt, endDt);

  return `✂️ Novo agendamento confirmado!\n\n` +
         `Cliente: ${clientName || 'Cliente'}\n` +
         `Serviço: ${serviceName || 'Atendimento'}\n` +
         `Data: ${dateStr}\n` +
         `Horário: ${startTimeStr} às ${endTimeStr}\n` +
         `Profissional: ${staffName || 'Equipe'}\n\n` +
         `✅ Agendamento registrado pela Jéssica.`;
}

/**
 * Generates message for cancellation
 */
function buildCancellationMessage({ clientName, serviceName, staffName, startDt, endDt, reason }) {
  const { dateStr, startTimeStr, endTimeStr } = formatDateTimeStrings(startDt, endDt);

  return `⚠️ Agendamento cancelado!\n\n` +
         `Cliente: ${clientName || 'Cliente'}\n` +
         `Serviço: ${serviceName || 'Atendimento'}\n` +
         `Data: ${dateStr}\n` +
         `Horário: ${startTimeStr} às ${endTimeStr}\n` +
         `Profissional: ${staffName || 'Equipe'}\n` +
         `${reason ? `Motivo: ${reason}\n` : ''}\n` +
         `ℹ️ O horário foi liberado na sua agenda.`;
}

/**
 * Generates message for rescheduling
 */
function buildRescheduleMessage({
  clientName,
  serviceName,
  staffName,
  newStartDt,
  newEndDt,
  oldStartDt,
  oldEndDt,
}) {
  const nw = formatDateTimeStrings(newStartDt, newEndDt);
  const old = formatDateTimeStrings(oldStartDt, oldEndDt);

  return `🔄 Agendamento remarcado!\n\n` +
         `Cliente: ${clientName || 'Cliente'}\n` +
         `Serviço: ${serviceName || 'Atendimento'}\n` +
         `Novo Horário: ${nw.dateStr} de ${nw.startTimeStr} às ${nw.endTimeStr}\n` +
         `Horário Anterior: ${old.dateStr} de ${old.startTimeStr} às ${old.endTimeStr}\n` +
         `Profissional: ${staffName || 'Equipe'}\n\n` +
         `✅ Agenda atualizada com sucesso.`;
}

/**
 * Generates message for Google sync failure alert
 */
function buildSyncFailureMessage({ clientName, serviceName, staffName, startDt, error }) {
  const { dateStr, startTimeStr } = formatDateTimeStrings(startDt);

  return `⚠️ Atenção: Falha na sincronização com o Google Calendar\n\n` +
         `Agendamento: ${clientName || 'Cliente'} — ${serviceName || 'Atendimento'}\n` +
         `Horário: ${dateStr} às ${startTimeStr}\n` +
         `Profissional: ${staffName || 'Equipe'}\n` +
         `Motivo: ${error || 'Token expirado ou serviço temporariamente indisponível'}\n\n` +
         `ℹ️ O agendamento está salvo com segurança na sua agenda RAIA. Acesse o painel para reconectar sua conta Google.`;
}

/**
 * Enqueues a notification into the persistent outbox and triggers safe dispatch
 */
async function queueNotification(userId, appointmentId, eventType, data = {}) {
  if (mockHandler?.queueNotification) {
    return mockHandler.queueNotification(userId, appointmentId, eventType, data);
  }

  const settings = getNotificationSettings(userId);
  if (!settings.notificationsEnabled || !settings.notificationPhone) {
    return { success: false, reason: 'NOTIFICATIONS_DISABLED_OR_NO_PHONE' };
  }

  // Check event-specific toggle
  if (eventType === 'NEW_APPOINTMENT' && !settings.notifyNewAppointment) return { success: false, reason: 'TOGGLE_DISABLED' };
  if (eventType === 'CANCELLATION' && !settings.notifyCancellation) return { success: false, reason: 'TOGGLE_DISABLED' };
  if (eventType === 'RESCHEDULE' && !settings.notifyReschedule) return { success: false, reason: 'TOGGLE_DISABLED' };
  if (eventType === 'SYNC_FAILURE' && !settings.notifySyncFailure) return { success: false, reason: 'TOGGLE_DISABLED' };

  let messageText = '';
  switch (eventType) {
    case 'NEW_APPOINTMENT':
      messageText = buildNewAppointmentMessage(data);
      break;
    case 'CANCELLATION':
      messageText = buildCancellationMessage(data);
      break;
    case 'RESCHEDULE':
      messageText = buildRescheduleMessage(data);
      break;
    case 'SYNC_FAILURE':
      messageText = buildSyncFailureMessage(data);
      break;
    default:
      messageText = data.text || 'Notificação RAIA Agentes';
  }

  // Prevenção de duplicação: não enfileirar notificação idêntica para o mesmo compromisso e evento nos últimos 5 minutos
  const existingRecent = db.prepare(`
    SELECT id FROM whatsapp_notification_outbox
    WHERE user_id = ? AND appointment_id = ? AND event_type = ?
      AND created_at >= datetime('now', '-5 minutes')
    LIMIT 1
  `).get(userId, appointmentId, eventType);

  if (existingRecent) {
    return { success: true, deduplicated: true, message: 'Notificação recente já enviada ou enfileirada.' };
  }

  const info = db.prepare(`
    INSERT INTO whatsapp_notification_outbox (
      user_id, appointment_id, event_type, recipient_phone, message_text, status
    )
    VALUES (?, ?, ?, ?, ?, 'PENDING')
  `).run(userId, appointmentId, eventType, settings.notificationPhone, messageText);

  const outboxId = info.lastInsertRowid;

  try {
    await dispatchOutboxItem(outboxId);
  } catch (err) {
    console.warn(`[SalonNotificationService] Aviso no envio assíncrono do outbox #${outboxId}:`, err.message);
  }

  return { success: true, outboxId, messageText };
}

/**
 * Dispatches an item from the notification outbox
 */
async function dispatchOutboxItem(outboxId) {
  const item = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(outboxId);
  if (!item || item.status === 'SENT') return;

  if (mockHandler?.dispatchOutboxItem) {
    return mockHandler.dispatchOutboxItem(item);
  }

  // Regra de Segurança em Homologação/Testes (Proteção 12)
  const isTestOrHomolog = process.env.APP_MODE === 'staging' 
    || process.env.HOMOLOGACAO === 'true' 
    || process.env.NODE_ENV === 'test'
    || process.env.ALLOW_WHATSAPP_SENDING !== 'true';

  if (isTestOrHomolog) {
    // Registra entrega simulada segura sem disparar mensagem para números reais
    db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET status = 'SENT_MOCKED', sent_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(outboxId);

    db.prepare(`
      UPDATE appointments
      SET whatsapp_notified = 1
      WHERE id = ?
    `).run(item.appointment_id);

    mockNotificationHistory.push({
      outboxId: item.id,
      recipient: item.recipient_phone,
      eventType: item.event_type,
      message: item.message_text,
      timestamp: new Date().toISOString(),
    });

    return { success: true, simulated: true };
  }

  // Ambiente com WhatsApp real conectado
  try {
    if (whatsappClient?.sendWhatsAppMessage) {
      const jid = `${item.recipient_phone}@s.whatsapp.net`;
      await whatsappClient.sendWhatsAppMessage(jid, item.message_text);

      db.prepare(`
        UPDATE whatsapp_notification_outbox
        SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, last_error = NULL
        WHERE id = ?
      `).run(outboxId);

      db.prepare(`
        UPDATE appointments
        SET whatsapp_notified = 1
        WHERE id = ?
      `).run(item.appointment_id);

      return { success: true };
    } else {
      throw new Error('Cliente WhatsApp offline ou não inicializado no servidor.');
    }
  } catch (err) {
    db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET status = 'FAILED', attempts = attempts + 1, last_error = ?
      WHERE id = ?
    `).run(err.message, outboxId);

    // Falha isolada: nunca propaga para o agendamento
    return { success: false, error: err.message };
  }
}

/**
 * Sends a test notification to verify the phone and message format
 */
async function sendTestNotification(userId, customPhone = null) {
  if (mockHandler?.sendTestNotification) {
    return mockHandler.sendTestNotification(userId, customPhone);
  }

  const settings = getNotificationSettings(userId);
  const targetPhone = normalizePhone(customPhone) || settings.notificationPhone;

  if (!targetPhone) {
    throw new Error('Informe um número de WhatsApp válido com DDD para o teste.');
  }

  const testMessage = `🧪 *Teste de Notificação — RAIA Agentes Jéssica*\n\n` +
                      `Olá! Este é um disparo de verificação do seu salão *${settings.salonName}*.\n\n` +
                      `✅ O seu WhatsApp está configurado e pronto para receber notificações de novos agendamentos!`;

  const info = db.prepare(`
    INSERT INTO whatsapp_notification_outbox (
      user_id, appointment_id, event_type, recipient_phone, message_text, status
    )
    VALUES (?, 0, 'TEST_MESSAGE', ?, ?, 'PENDING')
  `).run(userId, targetPhone, testMessage);

  const outboxId = info.lastInsertRowid;
  const dispatchResult = await dispatchOutboxItem(outboxId);

  return {
    success: true,
    recipient: targetPhone,
    message: 'Disparo de teste processado com sucesso!',
    dispatchResult,
  };
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

function getMockHistory() {
  return [...mockNotificationHistory];
}

function clearMockHistory() {
  mockNotificationHistory = [];
}

module.exports = {
  normalizePhone,
  getNotificationSettings,
  updateNotificationSettings,
  buildNewAppointmentMessage,
  buildCancellationMessage,
  buildRescheduleMessage,
  buildSyncFailureMessage,
  queueNotification,
  dispatchOutboxItem,
  sendTestNotification,
  setMockHandler,
  resetMockHandler,
  getMockHistory,
  clearMockHistory,
};
