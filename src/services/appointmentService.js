const db = require('../database/db');

/**
 * Normalizes text removing accents and whitespace for fuzzy matching
 */
function norm(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Create a new appointment / reminder
 */
function createAppointment({
  userId = 1,
  title,
  description,
  startDateTime,
  endDateTime,
  location,
  sourceType = 'whatsapp',
}) {
  if (!title || !startDateTime) {
    throw new Error('Título e data/horário são obrigatórios para agendar um compromisso.');
  }

  const stmt = db.prepare(`
    INSERT INTO appointments (
      user_id, title, description, start_datetime, end_datetime, location, source_type, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SCHEDULED')
  `);

  const result = stmt.run(
    userId,
    title.trim(),
    description || null,
    startDateTime,
    endDateTime || null,
    location || null,
    sourceType
  );

  return {
    id: result.lastInsertRowid,
    userId,
    title: title.trim(),
    description,
    startDateTime,
    endDateTime,
    location,
    status: 'SCHEDULED',
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
 * Find an upcoming appointment to modify or cancel
 */
function findAppointmentToModify(userId = 1, searchTerm) {
  const upcoming = getUpcomingAppointments(userId, 20);
  if (upcoming.length === 0) return null;

  if (!searchTerm || !searchTerm.trim()) {
    return upcoming[0];
  }

  const cleanSearch = norm(searchTerm);

  // 1. Direct includes
  const direct = upcoming.find(
    (ev) => norm(ev.title).includes(cleanSearch) || cleanSearch.includes(norm(ev.title))
  );
  if (direct) return direct;

  // 2. Word by word match
  const searchWords = cleanSearch.split(/\s+/).filter((w) => w.length > 2);
  for (const ev of upcoming) {
    const evNorm = norm(ev.title);
    if (searchWords.some((w) => evNorm.includes(w))) {
      return ev;
    }
  }

  // 3. Fallback to earliest upcoming
  return upcoming[0];
}

/**
 * Update an appointment
 */
function updateAppointment(id, userId, { title, startDateTime, endDateTime, location }) {
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    throw new Error('Compromisso não encontrado para atualização.');
  }

  const newTitle = title !== undefined ? title.trim() : existing.title;
  const newStart = startDateTime || existing.start_datetime;
  const newEnd = endDateTime || existing.end_datetime;
  const newLoc = location !== undefined ? location : existing.location;

  // If time changed, reset reminder notification flags so user receives alerts for the new time!
  const timeChanged = startDateTime && startDateTime !== existing.start_datetime;

  db.prepare(`
    UPDATE appointments
    SET title = ?, start_datetime = ?, end_datetime = ?, location = ?,
        notified_24h = CASE WHEN ? = 1 THEN 0 ELSE notified_24h END,
        notified_3h  = CASE WHEN ? = 1 THEN 0 ELSE notified_3h END,
        notified_1h  = CASE WHEN ? = 1 THEN 0 ELSE notified_1h END
    WHERE id = ? AND user_id = ?
  `).run(newTitle, newStart, newEnd, newLoc, timeChanged ? 1 : 0, timeChanged ? 1 : 0, timeChanged ? 1 : 0, id, userId);

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

  db.prepare(`UPDATE appointments SET status = 'CANCELLED' WHERE id = ? AND user_id = ?`).run(id, userId);
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

module.exports = {
  createAppointment,
  getAppointments,
  getUpcomingAppointments,
  findAppointmentToModify,
  updateAppointment,
  deleteAppointment,
  setNotified,
  silenceAppointment,
};
