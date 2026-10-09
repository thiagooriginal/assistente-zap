const db = require('../database/db');
const calendarService = require('./calendarService');
const config = require('../config');
const dailyBroadcastService = require('./dailyBroadcastService');

// Check if a reminder has already been sent
function hasReminderBeenSent(eventId, reminderType) {
  const stmt = db.prepare(`
    SELECT id FROM reminder_logs WHERE event_id = ? AND reminder_type = ?
  `);
  return !!stmt.get(eventId, reminderType);
}

// Record that a reminder was sent
function recordReminderSent(eventId, reminderType, eventTitle, eventStart) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO reminder_logs (event_id, reminder_type, event_title, event_start)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(eventId, reminderType, eventTitle || 'Sem título', eventStart);
}

// Clean old reminder logs (> 7 days)
function cleanOldReminderLogs() {
  try {
    db.prepare(`
      DELETE FROM reminder_logs WHERE datetime(sent_at) < datetime('now', '-7 days')
    `).run();
  } catch (err) {
    console.error('Erro ao limpar logs antigos de lembretes:', err);
  }
}

/**
 * Check Google Calendar events and send reminders if needed
 */
async function checkAndSendReminders(sendWhatsAppMessage, targetJid) {
  if (!calendarService.isCalendarConnected()) {
    return;
  }

  if (!targetJid) {
    return;
  }

  try {
    const events = await calendarService.getEventsForReminder();
    const now = new Date();

    for (const event of events) {
      const startRaw = event.start?.dateTime || event.start?.date;
      if (!startRaw) continue;

      const eventStart = new Date(startRaw);
      const diffMs = eventStart.getTime() - now.getTime();
      const diffMin = Math.floor(diffMs / (60 * 1000));

      // Event is in the past
      if (diffMin <= 0) continue;

      const eventTitle = event.summary || 'Compromisso sem título';
      const timeStr = eventStart.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const dateStr = eventStart.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const locationStr = event.location ? `\n📍 *Local*: ${event.location}` : '';
      const descStr = (event.description && !event.description.includes('Criado via')) ? `\n📝 *Detalhes*: ${event.description}` : '';

      // 1. Lembrete: 1 dia antes (entre 24h e 3h)
      if (diffMin <= 24 * 60 && diffMin > 3 * 60) {
        if (!hasReminderBeenSent(event.id, '24h')) {
          const msg = `🔔 *Lembrete de Compromisso (Amanhã)*\n\n` +
                      `📌 *${eventTitle}*\n` +
                      `🗓️ *Data*: ${dateStr}\n` +
                      `⏰ *Horário*: ${timeStr}${locationStr}${descStr}\n\n` +
                      `_Este compromisso está agendado no seu Google Calendar para daqui a cerca de 24 horas._`;

          await sendWhatsAppMessage(targetJid, msg);
          recordReminderSent(event.id, '24h', eventTitle, eventStart.toISOString());
          console.log(`[Lembrete 24h enviado] ${eventTitle} para ${targetJid}`);
        }
      }

      // 2. Lembrete: 3 horas antes (entre 3h e 1h)
      if (diffMin <= 3 * 60 && diffMin > 60) {
        if (!hasReminderBeenSent(event.id, '3h')) {
          const msg = `⏰ *Lembrete de Compromisso (Em 3 Horas)*\n\n` +
                      `📌 *${eventTitle}*\n` +
                      `⏰ *Horário*: ${timeStr}${locationStr}${descStr}\n\n` +
                      `_Faltam menos de 3 horas para o seu compromisso!_`;

          await sendWhatsAppMessage(targetJid, msg);
          recordReminderSent(event.id, '3h', eventTitle, eventStart.toISOString());
          console.log(`[Lembrete 3h enviado] ${eventTitle} para ${targetJid}`);
        }
      }

      // 3. Lembrete: 1 hora antes (<= 60 minutos)
      if (diffMin <= 60 && diffMin > 0) {
        if (!hasReminderBeenSent(event.id, '1h')) {
          const msg = `🚨 *Lembrete Urgente (Em 1 Hora)*\n\n` +
                      `📌 *${eventTitle}*\n` +
                      `⏰ *Início às*: ${timeStr}${locationStr}${descStr}\n\n` +
                      `_Seu compromisso começa em breve!_`;

          await sendWhatsAppMessage(targetJid, msg);
          recordReminderSent(event.id, '1h', eventTitle, eventStart.toISOString());
          console.log(`[Lembrete 1h enviado] ${eventTitle} para ${targetJid}`);
        }
      }
    }
  } catch (err) {
    console.error('Erro ao verificar lembretes do Calendar:', err.message);
  }
}

/**
 * Check internal appointments and send WhatsApp reminders (24h, 3h, 1h) per user
 */
async function checkAndSendAppointmentReminders(sendWhatsAppMessage) {
  const appointmentService = require('./appointmentService');
  try {
    const now = new Date();
    const upcoming = db.prepare(`
      SELECT a.*, u.phone_number 
      FROM appointments a
      JOIN users u ON a.user_id = u.id
      WHERE a.status = 'SCHEDULED' AND datetime(a.start_datetime) >= datetime('now', '-1 hour')
    `).all();

    for (const apt of upcoming) {
      if (!apt.phone_number) continue;
      const targetJid = `${apt.phone_number}@s.whatsapp.net`;
      const startObj = new Date(apt.start_datetime);
      const diffMs = startObj.getTime() - now.getTime();
      const diffMin = Math.floor(diffMs / (60 * 1000));

      if (diffMin <= 0) continue;

      const dateStr = startObj.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = startObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const locationStr = apt.location ? `\n📍 *Local*: ${apt.location}` : '';
      const descStr = apt.description ? `\n📝 *Detalhes*: ${apt.description}` : '';

      // 1. Lembrete: 1 dia antes (entre 24h e 3h)
      if (diffMin <= 24 * 60 && diffMin > 3 * 60 && !apt.notified_24h) {
        const msg = `🔔 *Lembrete de Compromisso (Amanhã)*\n\n` +
                    `📌 *${apt.title}*\n` +
                    `🗓️ *Data*: ${dateStr}\n` +
                    `⏰ *Horário*: ${timeStr}${locationStr}${descStr}\n\n` +
                    `_Lembrete automático do seu Assistente Pessoal._`;

        await sendWhatsAppMessage(targetJid, msg);
        appointmentService.setNotified(apt.id, '24h');
        console.log(`[Lembrete 24h Compromisso] ${apt.title} enviado para ${targetJid}`);
      }

      // 2. Lembrete: 3 horas antes (entre 3h e 1h)
      if (diffMin <= 3 * 60 && diffMin > 60 && !apt.notified_3h) {
        const msg = `⏰ *Lembrete de Compromisso (Em 3 Horas)*\n\n` +
                    `📌 *${apt.title}*\n` +
                    `⏰ *Horário*: ${timeStr}${locationStr}${descStr}\n\n` +
                    `_Faltam menos de 3 horas para o seu compromisso!_`;

        await sendWhatsAppMessage(targetJid, msg);
        appointmentService.setNotified(apt.id, '3h');
        console.log(`[Lembrete 3h Compromisso] ${apt.title} enviado para ${targetJid}`);
      }

      // 3. Lembrete: 1 hora antes (<= 60 min)
      if (diffMin <= 60 && diffMin > 0 && !apt.notified_1h) {
        const msg = `🚨 *Lembrete Urgente (Em 1 Hora)*\n\n` +
                    `📌 *${apt.title}*\n` +
                    `⏰ *Início às*: ${timeStr}${locationStr}${descStr}\n\n` +
                    `_Seu compromisso começa em breve!_`;

        await sendWhatsAppMessage(targetJid, msg);
        appointmentService.setNotified(apt.id, '1h');
        console.log(`[Lembrete 1h Compromisso] ${apt.title} enviado para ${targetJid}`);
      }
    }
  } catch (err) {
    console.error('Erro ao verificar lembretes de compromissos:', err.message);
  }
}

async function checkAndSendBillReminders(sendWhatsAppMessage) {
  const billService = require('./billService');
  const financeService = require('./financeService');

  try {
    const today = new Date().toISOString().slice(0, 10);
    const tom = new Date();
    tom.setDate(tom.getDate() + 1);
    const tomorrowStr = tom.toISOString().slice(0, 10);

    // 1. Contas que vencem amanhã
    const dueTomorrow = db.prepare(`
      SELECT b.*, u.phone_number 
      FROM scheduled_payments b
      JOIN users u ON b.user_id = u.id
      WHERE b.status = 'PENDING' AND b.due_date = ? AND b.notified_1d = 0
    `).all(tomorrowStr);

    for (const b of dueTomorrow) {
      if (!b.phone_number) continue;
      const targetJid = `${b.phone_number}@s.whatsapp.net`;
      const [ano, mes, dia] = b.due_date.split('-');
      const msg = `⚠️ *Lembrete de Vencimento (Amanhã!)*\n\n` +
                  `📌 *${b.title}*\n` +
                  `💰 *Valor*: ${financeService.formatCurrency(b.amount)}\n` +
                  `📅 *Vencimento*: ${dia}/${mes}/${ano}\n\n` +
                  `_Não se esqueça de pagar amanhã! Quando pagar, me avise: "Paguei o ${b.title}"._`;

      await sendWhatsAppMessage(targetJid, msg);
      billService.setNotified(b.id, '1d');
      console.log(`[Lembrete Conta 1d] ${b.title} enviado para ${targetJid}`);
    }

    // 2. Contas que vencem hoje
    const dueToday = db.prepare(`
      SELECT b.*, u.phone_number 
      FROM scheduled_payments b
      JOIN users u ON b.user_id = u.id
      WHERE b.status = 'PENDING' AND b.due_date = ? AND b.notified_due = 0
    `).all(today);

    for (const b of dueToday) {
      if (!b.phone_number) continue;
      const targetJid = `${b.phone_number}@s.whatsapp.net`;
      const [ano, mes, dia] = b.due_date.split('-');
      const msg = `🚨 *Vence Hoje! (Atenção ao Pagamento)*\n\n` +
                  `📌 *${b.title}*\n` +
                  `💰 *Valor*: ${financeService.formatCurrency(b.amount)}\n` +
                  `📅 *Data*: Hoje (${dia}/${mes}/${ano})\n\n` +
                  `_Lembre-se de realizar o pagamento hoje. Assim que pagar, mande: "Paguei o ${b.title}"._`;

      await sendWhatsAppMessage(targetJid, msg);
      billService.setNotified(b.id, 'due');
      console.log(`[Lembrete Conta Hoje] ${b.title} enviado para ${targetJid}`);
    }
  } catch (err) {
    console.error('Erro ao verificar lembretes de contas:', err.message);
  }
}

let reminderInterval = null;

function startReminderJob(sendWhatsAppMessage, getTargetJid) {
  if (reminderInterval) clearInterval(reminderInterval);

  console.log('⏰ Serviço de lembretes e broadcast diário iniciado (verificação ativa a cada 60s)');

  // Run immediately on start
  const target = getTargetJid();
  if (target) {
    checkAndSendReminders(sendWhatsAppMessage, target);
  }
  checkAndSendBillReminders(sendWhatsAppMessage);
  checkAndSendAppointmentReminders(sendWhatsAppMessage);
  dailyBroadcastService.checkAndSendDailyBroadcast(sendWhatsAppMessage);

  // Check every 60 seconds (1 minute) for reminders and 09:00 AM daily messages
  reminderInterval = setInterval(async () => {
    const currentTarget = getTargetJid();
    if (currentTarget) {
      await checkAndSendReminders(sendWhatsAppMessage, currentTarget);
    }
    await checkAndSendBillReminders(sendWhatsAppMessage);
    await checkAndSendAppointmentReminders(sendWhatsAppMessage);
    await dailyBroadcastService.checkAndSendDailyBroadcast(sendWhatsAppMessage);
  }, 60 * 1000);

  // Clean old logs once a day
  setInterval(() => {
    cleanOldReminderLogs();
    dailyBroadcastService.cleanOldBroadcastLogs();
  }, 24 * 60 * 60 * 1000);
}

module.exports = {
  checkAndSendReminders,
  checkAndSendAppointmentReminders,
  checkAndSendBillReminders,
  startReminderJob,
  dailyBroadcastService,
};
