const db = require('../database/db');

function getSalonAppointmentService() {
  return require('./salonAppointmentService');
}

/**
 * Normalizes text removing accents and whitespace for fuzzy matching
 */
function norm(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,:;!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Create a new appointment / reminder delegating to unified salon appointment core
 */
function createAppointment({
  userId = 1,
  title,
  description,
  startDateTime,
  endDateTime,
  location,
  sourceType = 'whatsapp',
  staffId = null,
  serviceId = null,
  price = null,
  clientName = null,
  clientPhone = null,
  durationMin = 45,
}) {
  if (!title || !startDateTime) {
    throw new Error('Título e data/horário são obrigatórios para agendar um compromisso.');
  }

  // Parse date and time from startDateTime
  let dateStr = '';
  let timeStr = '';
  if (startDateTime.includes('T')) {
    const [d, t] = startDateTime.split('T');
    dateStr = d;
    timeStr = t.substring(0, 5);
  } else {
    const dt = new Date(startDateTime);
    dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    timeStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  }

  let finalDuration = Number(durationMin) || 45;
  if (!durationMin && endDateTime) {
    const sTime = new Date(startDateTime).getTime();
    const eTime = new Date(endDateTime).getTime();
    if (eTime > sTime) {
      finalDuration = Math.round((eTime - sTime) / 60000);
    }
  }

  let resolvedClientName = clientName;
  if (!resolvedClientName) {
    if (title.includes('—')) {
      resolvedClientName = title.split('—')[0].trim();
    } else if (title.includes('-')) {
      resolvedClientName = title.split('-')[0].trim();
    } else {
      resolvedClientName = title.trim();
    }
  }

  const booked = getSalonAppointmentService().bookAppointmentSync(userId, {
    clientName: resolvedClientName,
    clientPhone: clientPhone || null,
    serviceId: serviceId || null,
    serviceName: title.trim(),
    staffId: staffId || null,
    date: dateStr,
    time: timeStr,
    durationMin: finalDuration,
    origin: sourceType || 'whatsapp',
  });

  return {
    id: booked.id,
    userId: booked.user_id,
    title: booked.title,
    description: booked.description || description || null,
    startDateTime: booked.start_datetime,
    endDateTime: booked.end_datetime,
    location: location || null,
    serviceId: booked.service_id,
    staffId: booked.staff_id,
    price: booked.price,
    clientName: booked.client_name,
    clientPhone: booked.client_phone,
    durationMin: booked.duration_min,
    status: booked.status,
  };
}

/**
 * Get appointments for a user
 */
function getAppointments({ userId = 1, status = 'SCHEDULED', limit = 50 } = {}) {
  let sql = 'SELECT * FROM appointments WHERE user_id = ?';
  const params = [userId];

  if (status && status !== 'ALL') {
    sql += ' AND status = ?';
    params.push(status);
  }

  sql += ' ORDER BY start_datetime ASC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get upcoming appointments (from now forward)
 */
function getUpcomingAppointments(userId = 1, limit = 10) {
  const now = new Date();
  // Buffer of 1 hour in case event just started
  const pastOneHour = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  return db.prepare(`
    SELECT * FROM appointments
    WHERE user_id = ? AND status = 'SCHEDULED' AND start_datetime >= ?
    ORDER BY start_datetime ASC
    LIMIT ?
  `).all(userId, pastOneHour, limit);
}

/**
 * Find an upcoming or recent appointment to modify or cancel
 */
function findAppointmentToModify(userId = 1, searchTerm) {
  const genericTerms = [
    'esse', 'este', 'esse compromisso', 'este compromisso', 'o compromisso',
    'meu compromisso', 'o ultimo', 'ultimo', 'recente', 'agendamento',
    'proximo', 'o proximo', 'esse agendamento', 'este agendamento'
  ];
  const isGeneric = !searchTerm || !String(searchTerm).trim() || genericTerms.includes(norm(searchTerm));

  if (!isGeneric) {
    const cleanSearch = norm(searchTerm);

    // 1. Fetch appointments: upcoming and recent from the last 72 hours forward
    const allRecentAndUpcoming = db.prepare(`
      SELECT * FROM appointments
      WHERE user_id = ? AND status = 'SCHEDULED' AND datetime(start_datetime) >= datetime('now', '-72 hours')
      ORDER BY ABS(strftime('%s', start_datetime) - strftime('%s', 'now')) ASC
      LIMIT 50
    `).all(userId);

    const allScheduled = db.prepare(`
      SELECT * FROM appointments
      WHERE user_id = ? AND status = 'SCHEDULED'
      ORDER BY id DESC
      LIMIT 50
    `).all(userId);

    const candidates = [...allRecentAndUpcoming];
    for (const a of allScheduled) {
      if (!candidates.some((c) => c.id === a.id)) {
        candidates.push(a);
      }
    }

    if (candidates.length === 0) {
      const anyStatus = db.prepare(`
        SELECT * FROM appointments
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 20
      `).all(userId);
      candidates.push(...anyStatus);
    }

    // A. Direct exact or substring match
    const direct = candidates.find(
      (ev) => norm(ev.title).includes(cleanSearch) || cleanSearch.includes(norm(ev.title))
    );
    if (direct) return direct;

    // B. Word-by-word token overlap
    const searchWords = cleanSearch.split(/\s+/).filter((w) => w.length > 2);
    if (searchWords.length > 0) {
      let bestMatch = null;
      let maxMatches = 0;
      for (const ev of candidates) {
        const evNorm = norm(ev.title);
        const matches = searchWords.filter((w) => evNorm.includes(w)).length;
        if (matches > maxMatches) {
          maxMatches = matches;
          bestMatch = ev;
        }
      }
      if (bestMatch && maxMatches >= 1) {
        return bestMatch;
      }
    }

    // Specific search term was given and no match found -> DO NOT return a random appointment!
    return null;
  }

  // Generic request ("esse compromisso", "o próximo") -> return nearest upcoming appointment
  const upcoming = getUpcomingAppointments(userId, 10);
  if (upcoming.length > 0) return upcoming[0];

  const anyScheduled = getAppointments({ userId, status: 'SCHEDULED', limit: 1 });
  return anyScheduled[0] || null;
}

/**
 * Update an appointment
 */
function updateAppointment(id, userId, { title, description, startDateTime, endDateTime, location }) {
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    throw new Error('Compromisso não encontrado para atualização.');
  }

  if (startDateTime) {
    let dateStr = '';
    let timeStr = '';
    if (startDateTime.includes('T')) {
      const [d, t] = startDateTime.split('T');
      dateStr = d;
      timeStr = t.substring(0, 5);
    } else {
      const dt = new Date(startDateTime);
      dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      timeStr = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    }

    getSalonAppointmentService().rescheduleAppointment(id, userId, {
      newDate: dateStr,
      newTime: timeStr,
      reason: 'Remarcado via WhatsApp',
    }).catch?.(() => {});
  }

  const newTitle = (title && typeof title === 'string' && title.trim()) ? title.trim() : existing.title;
  const newLoc = (location !== undefined && location !== null && typeof location === 'string' && location.trim()) 
    ? location.trim() 
    : (location === null ? null : existing.location);
  const newDesc = (description !== undefined && description !== null && typeof description === 'string' && description.trim()) 
    ? description.trim() 
    : (description === null ? null : existing.description);

  db.prepare(`
    UPDATE appointments
    SET title = ?, description = ?, location = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(newTitle, newDesc, newLoc, id, userId);

  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
}

/**
 * Cancel or delete an appointment
 */
function deleteAppointment(id, userId) {
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    throw new Error('Compromisso não encontrado para cancelamento.');
  }

  getSalonAppointmentService().cancelAppointment(id, userId, {
    reason: 'Cancelado pelo usuário',
    cancelledBy: 'WHATSAPP',
  }).catch?.(() => {});

  db.prepare(`UPDATE appointments SET status = 'CANCELADO' WHERE id = ? AND user_id = ?`).run(id, userId);
  return existing;
}

/**
 * Flag appointment reminder as sent
 */
function setNotified(id, type) {
  if (type === '24h') {
    db.prepare('UPDATE appointments SET notified_24h = 1 WHERE id = ?').run(id);
  } else if (type === '3h') {
    db.prepare('UPDATE appointments SET notified_3h = 1 WHERE id = ?').run(id);
  } else if (type === '1h') {
    db.prepare('UPDATE appointments SET notified_1h = 1 WHERE id = ?').run(id);
  }
}

/**
 * Acknowledge / silence reminders for an appointment
 */
function silenceAppointment({ userId = 1, searchTerm }) {
  const target = findAppointmentToModify(userId, searchTerm);
  if (!target) return null;

  db.prepare(`
    UPDATE appointments
    SET notified_24h = 1, notified_3h = 1, notified_1h = 1
    WHERE id = ? AND user_id = ?
  `).run(target.id, userId);

  return target;
}

/**
 * Update Google Calendar Event ID
 */
function setGoogleEventId(id, googleEventId) {
  try {
    db.prepare('UPDATE appointments SET google_event_id = ? WHERE id = ?').run(googleEventId, id);
  } catch (e) {
    console.error(`Erro ao salvar google_event_id no compromisso #${id}:`, e.message);
  }
}

/**
 * Retroactively sync unsynced future appointments for Admin/Owner to Google Calendar
 */
async function syncPendingAdminAppointmentsToGoogle() {
  const calendarService = require('./calendarService');
  if (!calendarService.isCalendarConnected()) {
    return { synced: 0, reason: 'Google Calendar desconectado' };
  }

  const now = new Date().toISOString();
  let unsynced = [];
  try {
    unsynced = db.prepare(`
      SELECT a.* FROM appointments a
      JOIN users u ON a.user_id = u.id
      WHERE (u.role = 'ADMIN' OR u.id = 1 OR u.phone_number LIKE '%951364159')
        AND a.status = 'SCHEDULED'
        AND a.start_datetime >= ?
        AND (a.google_event_id IS NULL OR a.google_event_id = '')
      ORDER BY a.start_datetime ASC
    `).all(now);
  } catch (e) {
    console.error('Erro ao buscar compromissos pendentes de sincronização:', e.message);
    return { synced: 0, error: e.message };
  }

  let count = 0;
  for (const apt of unsynced) {
    try {
      const gEvent = await calendarService.createCalendarEvent({
        summary: apt.title,
        description: apt.description || 'Criado via Assistente Zap',
        startDateTime: apt.start_datetime,
        endDateTime: apt.end_datetime,
        location: apt.location,
      });

      if (gEvent && gEvent.id) {
        setGoogleEventId(apt.id, gEvent.id);
        count++;
        console.log(`[Google Calendar Sync] Compromisso #${apt.id} "${apt.title}" enviado ao Google Calendar com ID: ${gEvent.id}`);
      }
    } catch (err) {
      console.error(`[Google Calendar Sync] Erro ao sincronizar #${apt.id}:`, err.message);
    }
  }

  return { synced: count, totalFound: unsynced.length };
}

module.exports = {
  createAppointment,
  getAppointments,
  getUpcomingAppointments,
  findAppointmentToModify,
  updateAppointment,
  deleteAppointment,
  setNotified,
  silenceAppointment,
  setGoogleEventId,
  syncPendingAdminAppointmentsToGoogle,
};
