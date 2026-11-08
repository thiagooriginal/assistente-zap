/**
 * RAIA AGENTES — SERVIÇO CENTRALIZADO DE AGENDAMENTOS DA JÉSSICA
 * 
 * Gerencia o ciclo completo de vida dos agendamentos:
 * - Validação rigorosa de horários de funcionamento, intervalos de almoço e exceções
 * - Regra de sobreposição sem conflitos: inicio_novo < fim_existente AND fim_novo > inicio_existente
 * - Controle por profissional (staff_id) com permissão de atendimentos simultâneos entre profissionais distintos
 * - Transações atômicas BEGIN IMMEDIATE para eliminar condições de corrida
 * - Resposta HTTP 409 com horários alternativos sugeridos
 * - Sinalização não-destrutiva de conflitos históricos para revisão
 * - Integração síncrona/assíncrona idempotente com Google Calendar e Notificações WhatsApp
 */

const db = require('../database/db');
const googleCalendarService = require('./googleCalendarService');
const salonNotificationService = require('./salonNotificationService');

/**
 * Standardizes time representations to HH:mm
 */
function padZero(n) {
  return String(n).padStart(2, '0');
}

/**
 * Formats a Date object or ISO string to local YYYY-MM-DDTHH:mm:ss in America/Sao_Paulo
 */
function toLocalISOString(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;

  // Use Intl to format components in America/Sao_Paulo timezone
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
 * Parses and normalizes salon opening hours JSON
 */
function parseOpeningHours(rawHours) {
  const defaultHours = {
    timezone: 'America/Sao_Paulo',
    days: {
      0: { open: false, label: 'Domingo', start: '09:00', end: '14:00' },
      1: { open: true, label: 'Segunda-feira', start: '08:00', end: '19:00', lunchStart: '12:00', lunchEnd: '13:00' },
      2: { open: true, label: 'Terça-feira', start: '08:00', end: '19:00', lunchStart: '12:00', lunchEnd: '13:00' },
      3: { open: true, label: 'Quarta-feira', start: '08:00', end: '19:00', lunchStart: '12:00', lunchEnd: '13:00' },
      4: { open: true, label: 'Quinta-feira', start: '08:00', end: '19:00', lunchStart: '12:00', lunchEnd: '13:00' },
      5: { open: true, label: 'Sexta-feira', start: '08:00', end: '19:00', lunchStart: '12:00', lunchEnd: '13:00' },
      6: { open: true, label: 'Sábado', start: '08:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00' },
    },
    pauses: [],
    exceptions: [],
  };

  if (!rawHours) return defaultHours;

  let parsed = null;
  if (typeof rawHours === 'string') {
    try {
      parsed = JSON.parse(rawHours);
    } catch (_) {
      return defaultHours;
    }
  } else if (typeof rawHours === 'object') {
    parsed = rawHours;
  }

  if (!parsed) return defaultHours;

  // Se já está no formato novo com days
  if (parsed.days && typeof parsed.days === 'object') {
    return {
      timezone: parsed.timezone || 'America/Sao_Paulo',
      days: { ...defaultHours.days, ...parsed.days },
      pauses: Array.isArray(parsed.pauses) ? parsed.pauses : [],
      exceptions: Array.isArray(parsed.exceptions) ? parsed.exceptions : [],
    };
  }

  // Compatibilidade com formato legado { seg: { open, close, active }, ... }
  const legacyDayMap = {
    dom: 0,
    seg: 1,
    ter: 2,
    qua: 3,
    qui: 4,
    sex: 5,
    sab: 6,
  };

  const convertedDays = { ...defaultHours.days };
  for (const [key, val] of Object.entries(parsed)) {
    const dayNum = legacyDayMap[key.toLowerCase()];
    if (dayNum !== undefined && val && typeof val === 'object') {
      convertedDays[dayNum] = {
        open: val.active !== undefined ? !!val.active : !!val.open,
        label: convertedDays[dayNum].label,
        start: val.open || val.start || '08:00',
        end: val.close || val.end || '19:00',
        lunchStart: val.lunchStart || '12:00',
        lunchEnd: val.lunchEnd || '13:00',
      };
    }
  }

  return {
    timezone: 'America/Sao_Paulo',
    days: convertedDays,
    pauses: Array.isArray(parsed.pauses) ? parsed.pauses : [],
    exceptions: Array.isArray(parsed.exceptions) ? parsed.exceptions : [],
  };
}

/**
 * Fast synchronous check for internal business hours, staff days off, and SQLite conflict
 */
function checkInternalSlotAvailability(userId, {
  startDt,
  endDt,
  staffId = null,
  excludeAppointmentId = null,
  bypassPastCheck = false,
  bypassHoursCheck = false,
}) {
  const startDate = new Date(startDt);
  const endDate = new Date(endDt);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { available: false, reason: 'INVALID_DATES', message: 'Data e horário em formato inválido.' };
  }

  if (startDate >= endDate) {
    return { available: false, reason: 'INVALID_INTERVAL', message: 'O horário de início deve ser anterior ao término.' };
  }

  // 1. Verificação de Horário no Passado (em America/Sao_Paulo)
  if (!bypassPastCheck) {
    const now = new Date();
    // Tolerância de 2 minutos para delays de rede
    if (startDate.getTime() < now.getTime() - 2 * 60 * 1000) {
      return {
        available: false,
        reason: 'PAST_DATETIME',
        message: 'Não é permitido realizar agendamentos em datas ou horários no passado.',
      };
    }
  }

  // 2. Verificação de Horário de Funcionamento do Salão
  if (!bypassHoursCheck) {
    const salon = db.prepare('SELECT opening_hours FROM client_salons WHERE user_id = ?').get(userId);
    const hours = parseOpeningHours(salon?.opening_hours);

    const dayOfWeek = startDate.getDay();
    const dayConfig = hours.days[dayOfWeek];

    if (!dayConfig || !dayConfig.open) {
      return {
        available: false,
        reason: 'SALON_CLOSED_DAY',
        message: `O salão não abre neste dia da semana (${dayConfig?.label || 'Fechado'}).`,
      };
    }

    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const endMinutes = endDate.getHours() * 60 + endDate.getMinutes();

    const [openH, openM] = (dayConfig.start || '08:00').split(':').map(Number);
    const [closeH, closeM] = (dayConfig.end || '19:00').split(':').map(Number);
    const salonOpenMinutes = openH * 60 + openM;
    const salonCloseMinutes = closeH * 60 + closeM;

    if (startMinutes < salonOpenMinutes) {
      return {
        available: false,
        reason: 'BEFORE_OPENING',
        message: `O horário solicitado (${padZero(startDate.getHours())}:${padZero(startDate.getMinutes())}) é anterior à abertura do salão (${dayConfig.start}).`,
      };
    }

    if (endMinutes > salonCloseMinutes) {
      return {
        available: false,
        reason: 'EXCEEDS_CLOSING',
        message: `O serviço encerra às ${padZero(endDate.getHours())}:${padZero(endDate.getMinutes())}, ultrapassando o horário de fechamento do salão (${dayConfig.end}).`,
      };
    }

    // Intervalo de Almoço
    if (dayConfig.lunchStart && dayConfig.lunchEnd) {
      const [lStartH, lStartM] = dayConfig.lunchStart.split(':').map(Number);
      const [lEndH, lEndM] = dayConfig.lunchEnd.split(':').map(Number);
      const lunchStartMin = lStartH * 60 + lStartM;
      const lunchEndMin = lEndH * 60 + lEndM;

      if (startMinutes < lunchEndMin && endMinutes > lunchStartMin) {
        return {
          available: false,
          reason: 'LUNCH_BREAK',
          message: `O horário coincide com o intervalo de almoço do salão (${dayConfig.lunchStart} às ${dayConfig.lunchEnd}).`,
        };
      }
    }
  }

  // 3. Verificação de Folgas do Profissional
  if (staffId) {
    const staff = db.prepare('SELECT id, name, active, days_off FROM client_staff WHERE id = ? AND user_id = ?').get(staffId, userId);
    if (!staff || !staff.active) {
      return {
        available: false,
        reason: 'STAFF_INACTIVE',
        message: 'O profissional selecionado não está ativo ou não foi encontrado.',
      };
    }

    if (staff.days_off) {
      try {
        const daysOff = JSON.parse(staff.days_off);
        const dayOfWeek = startDate.getDay();
        const dateStr = startDt.split('T')[0];
        if (Array.isArray(daysOff) && (daysOff.includes(dayOfWeek) || daysOff.includes(dateStr))) {
          return {
            available: false,
            reason: 'STAFF_DAY_OFF',
            message: `${staff.name} está de folga nesta data.`,
          };
        }
      } catch (_) {}
    }
  }

  // 4. Regra de Conflito Interno no SQLite
  // inicio_novo < fim_existente AND fim_novo > inicio_existente
  let conflictQuery = `
    SELECT id, title, client_name, start_datetime, end_datetime, staff_id
    FROM appointments
    WHERE user_id = ?
      AND status NOT IN ('CANCELADO', 'CANCELLED')
      AND start_datetime < ?
      AND end_datetime > ?
  `;
  const params = [userId, endDt, startDt];

  if (staffId !== null) {
    conflictQuery += ` AND (staff_id = ? OR staff_id IS NULL)`;
    params.push(staffId);
  }

  if (excludeAppointmentId) {
    conflictQuery += ` AND id != ?`;
    params.push(excludeAppointmentId);
  }

  conflictQuery += ` LIMIT 1`;

  const conflictingApt = db.prepare(conflictQuery).get(...params);
  if (conflictingApt) {
    return {
      available: false,
      reason: 'SLOT_CONFLICT',
      conflict: conflictingApt,
      message: `Já existe um agendamento para este horário (${conflictingApt.client_name || conflictingApt.title}).`,
    };
  }

  return { available: true };
}

/**
 * Asynchronously checks Google Calendar availability outside SQLite transactions with strict timeout
 */
async function checkGoogleAvailability(userId, { startDt, endDt, staffId = null, timeoutMs = 4000 }) {
  const salon = db.prepare('SELECT google_require_sync_availability FROM client_salons WHERE user_id = ?').get(userId);
  const isRequired = salon && salon.google_require_sync_availability === 1;

  let resolvedStaffId = staffId ? Number(staffId) : null;
  if (!resolvedStaffId) {
    try {
      const eff = resolveEffectiveStaff(userId, null);
      resolvedStaffId = eff.staffId;
    } catch (_) {}
  }

  const googleStatus = googleCalendarService.getConnectionStatus(userId);
  if (!googleStatus.isConnected) {
    if (isRequired) {
      return {
        available: false,
        reason: 'GOOGLE_CALENDAR_UNAVAILABLE',
        message: 'A verificação da agenda Google é obrigatória e a conta está desconectada ou inacessível.',
      };
    }
    return { available: true };
  }

  try {
    const queryPromise = googleCalendarService.getGoogleBusySlots(userId, {
      timeMin: startDt,
      timeMax: endDt,
      staffId: resolvedStaffId,
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout na consulta do Google Calendar')), timeoutMs).unref?.();
    });

    const busySlots = await Promise.race([queryPromise, timeoutPromise]);

    const slotStart = new Date(startDt).getTime();
    const slotEnd = new Date(endDt).getTime();

    for (const b of busySlots) {
      const bStart = new Date(b.start).getTime();
      const bEnd = new Date(b.end).getTime();
      if (slotStart < bEnd && slotEnd > bStart) {
        return {
          available: false,
          reason: 'GOOGLE_CALENDAR_BUSY',
          message: 'O horário selecionado está ocupado na Agenda Google do salão ou profissional.',
        };
      }
    }

    return { available: true };
  } catch (err) {
    console.warn(`[SalonAppointmentService] Aviso na consulta Google Calendar:`, err.message);
    if (isRequired) {
      return {
        available: false,
        reason: 'GOOGLE_CALENDAR_UNAVAILABLE',
        message: 'A verificação da agenda Google é obrigatória e está temporariamente inacessível.',
      };
    }
    return { available: true };
  }
}

/**
 * Checks if a specific candidate slot is free from conflicts and compliant with business hours
 */
async function checkSlotAvailability(userId, params) {
  let resolvedStaffId = params?.staffId ? Number(params.staffId) : null;
  if (!resolvedStaffId) {
    try {
      const eff = resolveEffectiveStaff(userId, null);
      resolvedStaffId = eff.staffId;
    } catch (_) {}
  }
  const internal = checkInternalSlotAvailability(userId, { ...params, staffId: resolvedStaffId });
  if (!internal.available) return internal;
  return checkGoogleAvailability(userId, { ...params, staffId: resolvedStaffId });
}

/**
 * Finds alternative available slots on a given date for a service duration
 */
async function findAlternativeSlots(userId, { date, serviceDurationMin = 45, staffId = null, limit = 50 }) {
  let cleanDate = date;
  if (typeof cleanDate === 'string' && cleanDate.includes('/')) {
    const parts = cleanDate.trim().split('/');
    if (parts.length === 3) {
      const [d, m, y] = parts;
      cleanDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  const salon = db.prepare('SELECT opening_hours FROM client_salons WHERE user_id = ?').get(userId);
  const hours = parseOpeningHours(salon?.opening_hours);

  let resolvedStaffId = staffId ? Number(staffId) : null;
  if (!resolvedStaffId) {
    try {
      const eff = resolveEffectiveStaff(userId, null);
      resolvedStaffId = eff.staffId;
    } catch (_) {}
  }

  const targetDate = new Date(`${cleanDate}T12:00:00`);
  const dayOfWeek = targetDate.getDay();
  const dayConfig = hours.days[dayOfWeek];

  if (!dayConfig || !dayConfig.open) {
    return [];
  }

  const [openH, openM] = (dayConfig.start || '08:00').split(':').map(Number);
  const [closeH, closeM] = (dayConfig.end || '19:00').split(':').map(Number);

  // Consulta do Google Calendar para o dia todo (para evitar múltiplas chamadas externas)
  let googleBusy = [];
  try {
    const googleStatus = googleCalendarService.getConnectionStatus(userId);
    if (googleStatus.isConnected) {
      googleBusy = await googleCalendarService.getGoogleBusySlots(userId, {
        timeMin: `${cleanDate}T00:00:00`,
        timeMax: `${cleanDate}T23:59:59`,
        staffId: resolvedStaffId,
      });
    }
  } catch (_) {}

  const candidateSlots = [];
  let currentMin = openH * 60 + openM;
  const maxStartMin = closeH * 60 + closeM - serviceDurationMin;

  while (currentMin <= maxStartMin) {
    const h = Math.floor(currentMin / 60);
    const m = currentMin % 60;
    const timeStr = `${padZero(h)}:${padZero(m)}`;

    const candidateStart = `${cleanDate}T${timeStr}:00`;
    const candidateEnd = new Date(new Date(candidateStart).getTime() + serviceDurationMin * 60000);
    const candidateEndStr = `${cleanDate}T${padZero(candidateEnd.getHours())}:${padZero(candidateEnd.getMinutes())}:${padZero(candidateEnd.getSeconds())}`;

    const check = checkInternalSlotAvailability(userId, {
      startDt: candidateStart,
      endDt: candidateEndStr,
      staffId: resolvedStaffId,
      bypassPastCheck: false,
      bypassHoursCheck: false,
    });

    if (check.available) {
      const slotStartMs = new Date(candidateStart).getTime();
      const slotEndMs = candidateEnd.getTime();
      const hasGoogleConflict = googleBusy.some((b) => {
        const bStart = new Date(b.start).getTime();
        const bEnd = new Date(b.end).getTime();
        return slotStartMs < bEnd && slotEndMs > bStart;
      });

      if (!hasGoogleConflict) {
        candidateSlots.push(timeStr);
        if (limit && candidateSlots.length >= limit) break;
      }
    }

    currentMin += 30; // Incrementos de 30 minutos
  }

  return candidateSlots;
}

/**
 * Resolves the effective staff for an appointment:
 * - If staffId is specified, verifies it exists in client_staff, belongs to the salon and is active.
 * - If only 1 staff is active in the salon, automatically selects that staff.
 * - If 0 staff are active, throws NO_ACTIVE_STAFF.
 * - If > 1 staff are active and no staffId was specified, throws STAFF_REQUIRED.
 */
function resolveEffectiveStaff(userId, staffId = null) {
  let activeStaffList = db.prepare('SELECT id, name, active, google_calendar_id FROM client_staff WHERE user_id = ? AND active = 1 ORDER BY id ASC').all(userId);

  if (activeStaffList.length === 0) {
    const totalStaff = db.prepare('SELECT COUNT(*) as count FROM client_staff WHERE user_id = ?').get(userId)?.count || 0;
    if (totalStaff === 0) {
      try {
        const clientAuth = require('./clientAuthService');
        clientAuth.ensureSalonForUser(userId);
        activeStaffList = db.prepare('SELECT id, name, active, google_calendar_id FROM client_staff WHERE user_id = ? AND active = 1 ORDER BY id ASC').all(userId);
      } catch (_) {}
    }
  }

  let resolvedStaffId = staffId ? Number(staffId) : null;
  let resolvedStaffName = 'Profissional';
  let resolvedStaffGoogleCalId = null;

  if (resolvedStaffId) {
    const matchedStaff = activeStaffList.find((s) => s.id === resolvedStaffId);
    if (!matchedStaff) {
      const err = new Error('Profissional selecionado não pertence ao salão ou está inativo.');
      err.code = 'STAFF_NOT_FOUND';
      throw err;
    }
    resolvedStaffName = matchedStaff.name;
    resolvedStaffGoogleCalId = matchedStaff.google_calendar_id || null;
  } else if (activeStaffList.length === 1) {
    // Seleciona automaticamente quando houver apenas 1 profissional disponível no salão
    resolvedStaffId = activeStaffList[0].id;
    resolvedStaffName = activeStaffList[0].name;
    resolvedStaffGoogleCalId = activeStaffList[0].google_calendar_id || null;
  } else if (activeStaffList.length === 0) {
    const err = new Error('Nenhum profissional disponível para agendamento no momento.');
    err.code = 'NO_ACTIVE_STAFF';
    throw err;
  } else {
    // Mais de 1 profissional ativo sem seleção explícita -> exigir seleção
    const err = new Error('Existem múltiplos profissionais disponíveis. Por favor, selecione um profissional para o agendamento.');
    err.code = 'STAFF_REQUIRED';
    err.availableStaff = activeStaffList.map((s) => ({ id: s.id, name: s.name }));
    throw err;
  }

  return {
    staffId: resolvedStaffId,
    staffName: resolvedStaffName,
    googleCalendarId: resolvedStaffGoogleCalId,
  };
}

/**
 * Pure atomic synchronous booking inside SQLite transaction (BEGIN IMMEDIATE)
 */
function bookAppointmentSync(userId, {
  clientName,
  clientPhone,
  serviceId,
  serviceName,
  staffId = null,
  date,
  time,
  durationMin = null,
  origin = 'painel',
  status = 'AGENDADO',
}) {
  if (!clientName || !clientName.trim()) {
    throw new Error('O nome do cliente é obrigatório.');
  }
  if (!date || !time) {
    throw new Error('Data e horário são obrigatórios para realizar o agendamento.');
  }

  // 1. Resolução do Serviço
  let matchedService = null;
  if (serviceId) {
    matchedService = db.prepare('SELECT id, name, price, duration_min, active FROM client_services WHERE id = ? AND user_id = ?').get(serviceId, userId);
  }
  if (!matchedService && serviceName) {
    matchedService = db.prepare('SELECT id, name, price, duration_min, active FROM client_services WHERE LOWER(name) = LOWER(?) AND user_id = ?').get(serviceName.trim(), userId);
  }

  if (matchedService && matchedService.active === 0) {
    const err = new Error('Este serviço está inativo e não aceita novos agendamentos.');
    err.code = 'SERVICE_INACTIVE';
    throw err;
  }

  const finalDurationMin = matchedService?.duration_min 
    || (durationMin ? Number(durationMin) : null) 
    || 45;

  const finalServiceName = matchedService?.name || (serviceName ? serviceName.trim() : 'Atendimento Geral');
  const finalPrice = matchedService?.price !== undefined ? matchedService.price : 0.0;

  // 2. Resolução do Profissional Efetivo (Staff)
  const effectiveStaff = resolveEffectiveStaff(userId, staffId);
  const resolvedStaffId = effectiveStaff.staffId;
  const resolvedStaffName = effectiveStaff.staffName;

  // 3. Cálculo de Início e Término
  let cleanDate = date;
  if (typeof cleanDate === 'string' && cleanDate.includes('/')) {
    const parts = cleanDate.trim().split('/');
    if (parts.length === 3) {
      const [d, m, y] = parts;
      cleanDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  const cleanTime = time.length === 5 ? time + ':00' : time;
  const startDt = `${cleanDate}T${cleanTime}`;
  const startDate = new Date(startDt);
  if (isNaN(startDate.getTime())) {
    throw new Error('Data ou horário inválido.');
  }

  const endDate = new Date(startDate.getTime() + finalDurationMin * 60000);
  const endDt = `${endDate.getFullYear()}-${padZero(endDate.getMonth() + 1)}-${padZero(endDate.getDate())}T${padZero(endDate.getHours())}:${padZero(endDate.getMinutes())}:${padZero(endDate.getSeconds())}`;

  // 4. Execução Atômica em Transação SQLite (BEGIN IMMEDIATE)
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (lockErr) {
    const err = new Error('O horário está em processo de reserva por outra requisição concorrente. Tente novamente em instantes.');
    err.code = 'SLOT_CONFLICT';
    throw err;
  }

  try {
    const check = checkInternalSlotAvailability(userId, {
      startDt,
      endDt,
      staffId: resolvedStaffId,
    });

    if (!check.available) {
      db.exec('ROLLBACK');
      const err = new Error(check.message);
      err.code = check.reason || 'SLOT_CONFLICT';
      throw err;
    }

    const title = `${clientName.trim()} — ${finalServiceName}`;
    const description = `Agendado via ${origin} para ${resolvedStaffName} (Duração: ${finalDurationMin} min)`;

    // Validar status inicial permitido (apenas AGENDADO e CONFIRMADO são permitidos no momento do cadastro inicial)
    // Se receber status forjado (ex: CONCLUÍDO, CANCELADO) ou não permitido, fallback seguro para AGENDADO
    const ALLOWED_INITIAL_STATUSES = ['AGENDADO', 'CONFIRMADO'];
    let finalStatus = 'AGENDADO';
    if (status) {
      const normalizedStatus = mapToPortugueseStatus(status);
      if (ALLOWED_INITIAL_STATUSES.includes(normalizedStatus)) {
        finalStatus = normalizedStatus;
      }
    }

    const stmt = db.prepare(`
      INSERT INTO appointments (
        user_id, title, description, start_datetime, end_datetime,
        service_id, staff_id, price, client_name, client_phone,
        duration_min, origin, status, google_sync_status, whatsapp_notified
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0)
    `);

    const info = stmt.run(
      userId,
      title,
      description,
      startDt,
      endDt,
      matchedService?.id || null,
      resolvedStaffId,
      finalPrice,
      clientName.trim(),
      clientPhone ? clientPhone.trim() : null,
      finalDurationMin,
      origin,
      finalStatus
    );

    const appointmentId = info.lastInsertRowid;

    // Registrar no histórico de ciclo de vida
    db.prepare(`
      INSERT INTO appointment_status_history (appointment_id, user_id, previous_status, new_status, changed_by, reason)
      VALUES (?, ?, NULL, ?, ?, 'Novo agendamento criado')
    `).run(appointmentId, userId, finalStatus, origin.toUpperCase());

    // Enfileirar sincronização com Google Calendar no Outbox durável
    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'CREATE', 'PENDING', ?)
    `).run(userId, appointmentId, JSON.stringify({ startDt, endDt, finalServiceName, clientName: clientName.trim(), resolvedStaffName }));

    // Enfileirar notificação WhatsApp no Outbox durável dentro da transação
    salonNotificationService.enqueueNotificationTx(userId, appointmentId, 'NEW_APPOINTMENT', {
      clientName: clientName.trim(),
      serviceName: finalServiceName,
      staffName: resolvedStaffName,
      startDt,
      endDt,
    });

    db.exec('COMMIT');

    const createdAppointment = {
      id: appointmentId,
      user_id: userId,
      title,
      description,
      start_datetime: startDt,
      end_datetime: endDt,
      service_id: matchedService?.id || null,
      service_name: finalServiceName,
      staff_id: resolvedStaffId,
      staff_name: resolvedStaffName,
      price: finalPrice,
      client_name: clientName.trim(),
      client_phone: clientPhone ? clientPhone.trim() : null,
      duration_min: finalDurationMin,
      duration_minutes: finalDurationMin,
      origin,
      status: finalStatus,
      has_conflict: 0,
      google_sync_status: 'PENDING',
    };

    // Notificar o outbox worker para processamento resiliente imediato
    const outboxWorker = require('./outboxWorker');
    outboxWorker.notify();

    return createdAppointment;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Books an appointment with external Google Pre-check outside SQLite transaction
 */
async function bookAppointment(userId, params) {
  const { date, time, durationMin, serviceId, staffId } = params;

  // 1. Resolver o profissional efetivo ANTES da consulta de disponibilidade Google
  // Inclui seleção automática quando existe apenas 1 profissional e rejeição se STAFF_REQUIRED/NO_ACTIVE_STAFF
  const effectiveStaff = resolveEffectiveStaff(userId, staffId);
  const resolvedStaffId = effectiveStaff.staffId;

  let calcDuration = Number(durationMin) || 45;
  if (serviceId) {
    const sRow = db.prepare('SELECT duration_min FROM client_services WHERE id = ? AND user_id = ?').get(serviceId, userId);
    if (sRow?.duration_min) calcDuration = sRow.duration_min;
  }

  let cleanDate = date;
  if (typeof cleanDate === 'string' && cleanDate.includes('/')) {
    const parts = cleanDate.trim().split('/');
    if (parts.length === 3) {
      const [d, m, y] = parts;
      cleanDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  const cleanTime = time.length === 5 ? time + ':00' : time;
  const startDt = `${cleanDate}T${cleanTime}`;
  const startDate = new Date(startDt);
  if (!isNaN(startDate.getTime())) {
    const endDate = new Date(startDate.getTime() + calcDuration * 60000);
    const endDt = `${endDate.getFullYear()}-${padZero(endDate.getMonth() + 1)}-${padZero(endDate.getDate())}T${padZero(endDate.getHours())}:${padZero(endDate.getMinutes())}:${padZero(endDate.getSeconds())}`;

    // 2. Consulta ao Google Calendar FORA da transação SQLite com timeout
    // Em modalidade STAFF, consulta necessariamente o calendário desse profissional
    const gCheck = await checkGoogleAvailability(userId, {
      startDt,
      endDt,
      staffId: resolvedStaffId,
      timeoutMs: 4000,
    });

    if (!gCheck.available) {
      const err = new Error(gCheck.message);
      err.code = gCheck.reason || 'GOOGLE_CALENDAR_BUSY';
      try {
        err.suggestedSlots = await findAlternativeSlots(userId, { date: cleanDate, serviceDurationMin: calcDuration, staffId: resolvedStaffId });
      } catch (_) {
        err.suggestedSlots = [];
      }
      throw err;
    }
  }

  // 3. Execução atômica no SQLite passando o profissional já resolvido e data normalizada
  try {
    const createdAppointment = bookAppointmentSync(userId, {
      ...params,
      date: cleanDate,
      staffId: resolvedStaffId,
    });

    // Se estiver em ambiente com mock ou testes síncronos, processa o outbox imediatamente
    const outboxWorker = require('./outboxWorker');
    await outboxWorker.processAllPending().catch(() => {});

    return createdAppointment;
  } catch (err) {
    if (err.code === 'SLOT_CONFLICT' && !err.suggestedSlots) {
      try {
        err.suggestedSlots = await findAlternativeSlots(userId, { date: cleanDate, serviceDurationMin: calcDuration, staffId: resolvedStaffId });
      } catch (_) {
        err.suggestedSlots = [];
      }
    }
    throw err;
  }
}

/**
 * Reschedules an appointment to a new date/time or staff
 */
async function rescheduleAppointment(appointmentId, userId, { newDate, newTime, newStaffId = null, reason = 'Remarcado pelo cliente' }) {
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(appointmentId, userId);
  if (!existing) {
    const err = new Error('Agendamento não encontrado.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (existing.status === 'CANCELADO' || existing.status === 'CANCELLED') {
    const err = new Error('Não é possível remarcar um agendamento cancelado.');
    err.code = 'ALREADY_CANCELLED';
    throw err;
  }

  let cleanNewDate = newDate;
  if (typeof cleanNewDate === 'string' && cleanNewDate.includes('/')) {
    const parts = cleanNewDate.trim().split('/');
    if (parts.length === 3) {
      const [d, m, y] = parts;
      cleanNewDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  const durationMin = existing.duration_min || 45;
  const cleanNewTime = newTime.length === 5 ? newTime + ':00' : newTime;
  const startDt = `${cleanNewDate}T${cleanNewTime}`;
  const startDate = new Date(startDt);
  if (isNaN(startDate.getTime())) {
    throw new Error('Nova data ou horário em formato inválido.');
  }

  const endDate = new Date(startDate.getTime() + durationMin * 60000);
  const endDt = `${endDate.getFullYear()}-${padZero(endDate.getMonth() + 1)}-${padZero(endDate.getDate())}T${padZero(endDate.getHours())}:${padZero(endDate.getMinutes())}:${padZero(endDate.getSeconds())}`;

  const targetStaffId = newStaffId !== null ? Number(newStaffId) : existing.staff_id;

  // 1. Consulta externa de disponibilidade Google FORA da transação SQLite (sem prender locks)
  const gCheck = await checkGoogleAvailability(userId, {
    startDt,
    endDt,
    staffId: targetStaffId,
    timeoutMs: 4000,
  });

  if (!gCheck.available) {
    let alternatives = [];
    try {
      alternatives = await findAlternativeSlots(userId, {
        date: cleanNewDate,
        serviceDurationMin: durationMin,
        staffId: targetStaffId,
        limit: 5,
      });
    } catch (_) {}

    const err = new Error(gCheck.message);
    err.code = gCheck.reason || 'GOOGLE_CALENDAR_BUSY';
    err.suggestedSlots = alternatives;
    throw err;
  }

  // 2. Transação atômica SQLite (BEGIN IMMEDIATE) estritamente local (sem chamadas externas de rede)
  db.exec('BEGIN IMMEDIATE');
  try {
    const internalCheck = checkInternalSlotAvailability(userId, {
      startDt,
      endDt,
      staffId: targetStaffId,
      excludeAppointmentId: appointmentId,
    });

    if (!internalCheck.available) {
      db.exec('ROLLBACK');
      let alternatives = [];
      try {
        alternatives = await findAlternativeSlots(userId, {
          date: cleanNewDate,
          serviceDurationMin: durationMin,
          staffId: targetStaffId,
          limit: 5,
        });
      } catch (_) {}

      const err = new Error(internalCheck.message);
      err.code = internalCheck.reason || 'SLOT_CONFLICT';
      err.suggestedSlots = alternatives;
      throw err;
    }

    const oldStart = existing.start_datetime;
    const oldEnd = existing.end_datetime;

    db.prepare(`
      UPDATE appointments
      SET start_datetime = ?,
          end_datetime = ?,
          staff_id = ?,
          status = 'AGENDADO',
          has_conflict = 0,
          google_sync_status = 'PENDING',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(startDt, endDt, targetStaffId, appointmentId, userId);

    db.prepare(`
      INSERT INTO appointment_status_history (appointment_id, user_id, previous_status, new_status, changed_by, reason)
      VALUES (?, ?, ?, 'AGENDADO', 'SALON_USER', ?)
    `).run(appointmentId, userId, existing.status, reason);

    // Enfileirar sincronização durável com Google Calendar (UPDATE) no SQLite
    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'UPDATE', 'PENDING', ?)
    `).run(userId, appointmentId, JSON.stringify({ startDt, endDt, targetStaffId, newDate, newTime, reason }));

    // Obter dados complementares e enfileirar notificação WhatsApp durável (RESCHEDULE) no SQLite
    const staffRow = targetStaffId ? db.prepare('SELECT name FROM client_staff WHERE id = ?').get(targetStaffId) : null;
    const svcRow = existing.service_id ? db.prepare('SELECT name FROM client_services WHERE id = ?').get(existing.service_id) : null;

    salonNotificationService.enqueueNotificationTx(userId, appointmentId, 'RESCHEDULE', {
      clientName: existing.client_name,
      serviceName: svcRow?.name || existing.title,
      staffName: staffRow?.name || 'Profissional',
      newStartDt: startDt,
      newEndDt: endDt,
      oldStartDt: oldStart,
      oldEndDt: oldEnd,
    });

    db.exec('COMMIT');

    const updatedAppointment = {
      ...existing,
      start_datetime: startDt,
      end_datetime: endDt,
      staff_id: targetStaffId,
      staff_name: staffRow?.name || 'Profissional',
      service_name: svcRow?.name || existing.title,
    };

    // Disparar worker resiliente após commit
    const outboxWorker = require('./outboxWorker');
    outboxWorker.notify();

    return updatedAppointment;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Cancels an appointment, freeing the slot and notifying Google and salon WhatsApp
 */
async function cancelAppointment(appointmentId, userId, { reason = 'Cancelado pelo salão', cancelledBy = 'SALON_USER' } = {}) {
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(appointmentId, userId);
  if (!existing) {
    const err = new Error('Agendamento não encontrado.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (existing.status === 'CANCELADO' || existing.status === 'CANCELLED') {
    return { success: true, message: 'Agendamento já estava cancelado.' };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE appointments
      SET status = 'CANCELADO',
          has_conflict = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(appointmentId, userId);

    db.prepare(`
      INSERT INTO appointment_status_history (appointment_id, user_id, previous_status, new_status, changed_by, reason)
      VALUES (?, ?, ?, 'CANCELADO', ?, ?)
    `).run(appointmentId, userId, existing.status, cancelledBy, reason);

    // Enfileirar sincronização durável com Google Calendar (DELETE) no SQLite
    db.prepare(`
      INSERT INTO google_sync_outbox (user_id, appointment_id, action, status, payload_json)
      VALUES (?, ?, 'DELETE', 'PENDING', ?)
    `).run(userId, appointmentId, JSON.stringify({ reason, cancelledBy }));

    // Obter dados complementares e enfileirar notificação WhatsApp durável (CANCELLATION) no SQLite
    const staffRow = existing.staff_id ? db.prepare('SELECT name FROM client_staff WHERE id = ?').get(existing.staff_id) : null;
    const svcRow = existing.service_id ? db.prepare('SELECT name FROM client_services WHERE id = ?').get(existing.service_id) : null;

    salonNotificationService.enqueueNotificationTx(userId, appointmentId, 'CANCELLATION', {
      clientName: existing.client_name,
      serviceName: svcRow?.name || existing.title,
      staffName: staffRow?.name || 'Profissional',
      startDt: existing.start_datetime,
      endDt: existing.end_datetime,
      reason,
    });

    db.exec('COMMIT');

    // Disparar worker resiliente após commit
    const outboxWorker = require('./outboxWorker');
    outboxWorker.notify();

    return { success: true, message: 'Agendamento cancelado com sucesso e horário liberado.' };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Updates status of an appointment
 */
function updateAppointmentStatus(appointmentId, userId, newStatus, reason = '', changedBy = 'SALON_USER') {
  const allowed = ['AGENDADO', 'CONFIRMADO', 'CONCLUÍDO', 'CANCELADO', 'NÃO COMPARECEU'];
  const cleanStatus = newStatus ? newStatus.toUpperCase().trim() : '';

  if (!allowed.includes(cleanStatus)) {
    const err = new Error(`Status inválido. Escolha entre: ${allowed.join(', ')}`);
    err.code = 'INVALID_STATUS';
    throw err;
  }

  const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(appointmentId, userId);
  if (!existing) {
    const err = new Error('Agendamento não encontrado.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE appointments
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).run(cleanStatus, appointmentId, userId);

    db.prepare(`
      INSERT INTO appointment_status_history (appointment_id, user_id, previous_status, new_status, changed_by, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(appointmentId, userId, existing.status, cleanStatus, changedBy, reason);

    db.exec('COMMIT');

    return { success: true, appointmentId, status: cleanStatus };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Standardizes legacy statuses to PT-BR display
 */
function mapToPortugueseStatus(rawStatus) {
  if (!rawStatus) return 'AGENDADO';
  const s = rawStatus.toUpperCase();
  if (s === 'SCHEDULED') return 'AGENDADO';
  if (s === 'CONFIRMED') return 'CONFIRMADO';
  if (s === 'COMPLETED' || s === 'DONE') return 'CONCLUÍDO';
  if (s === 'CANCELLED') return 'CANCELADO';
  if (s === 'NO_SHOW') return 'NÃO COMPARECEU';
  return s;
}

/**
 * Lists appointments for a salon with rich filters and history view
 */
function listAppointments(userId, { staffId = null, status = null, startDate = null, endDate = null, search = null } = {}) {
  let query = `
    SELECT a.id, a.user_id, a.title, a.description, a.start_datetime, a.end_datetime,
           a.service_id, a.staff_id, a.price, a.client_name, a.client_phone,
           a.duration_min, a.origin, a.status, a.has_conflict, a.google_event_id,
           a.google_sync_status, a.whatsapp_notified,
           cs.name AS service_name,
           st.name AS staff_name
    FROM appointments a
    LEFT JOIN client_services cs ON a.service_id = cs.id
    LEFT JOIN client_staff st ON a.staff_id = st.id
    WHERE a.user_id = ?
  `;
  const params = [userId];

  if (staffId) {
    query += ` AND a.staff_id = ?`;
    params.push(staffId);
  }

  if (status && status !== 'TODOS') {
    if (status === 'AGENDADO') {
      query += ` AND (a.status = 'AGENDADO' OR a.status = 'SCHEDULED')`;
    } else if (status === 'CONFIRMADO') {
      query += ` AND (a.status = 'CONFIRMADO' OR a.status = 'CONFIRMED')`;
    } else if (status === 'CONCLUÍDO') {
      query += ` AND (a.status = 'CONCLUÍDO' OR a.status = 'COMPLETED' OR a.status = 'DONE')`;
    } else if (status === 'CANCELADO') {
      query += ` AND (a.status = 'CANCELADO' OR a.status = 'CANCELLED')`;
    } else if (status === 'NÃO COMPARECEU') {
      query += ` AND (a.status = 'NÃO COMPARECEU' OR a.status = 'NO_SHOW')`;
    } else {
      query += ` AND a.status = ?`;
      params.push(status);
    }
  }

  if (startDate) {
    query += ` AND a.start_datetime >= ?`;
    params.push(`${startDate}T00:00:00`);
  }

  if (endDate) {
    query += ` AND a.start_datetime <= ?`;
    params.push(`${endDate}T23:59:59`);
  }

  if (search && search.trim()) {
    const cleanSearch = `%${search.trim().toLowerCase()}%`;
    query += ` AND (LOWER(a.client_name) LIKE ? OR LOWER(a.title) LIKE ? OR LOWER(cs.name) LIKE ?)`;
    params.push(cleanSearch, cleanSearch, cleanSearch);
  }

  query += ` ORDER BY a.start_datetime DESC LIMIT 200`;

  const rows = db.prepare(query).all(...params);

  return rows.map((r) => ({
    ...r,
    status: mapToPortugueseStatus(r.status),
    client_name: r.client_name || (r.title ? r.title.split(' — ')[0].split(' - ')[0] : 'Cliente'),
    service_name: r.service_name || (r.title && r.title.includes('—') ? r.title.split(' — ')[1] : 'Atendimento Geral'),
    staff_name: r.staff_name || 'Profissional',
    price_formatted: `R$ ${(r.price || 0).toFixed(2).replace('.', ',')}`,
    duration_formatted: `${r.duration_min || 45} minutos`,
    duration_minutes: r.duration_min || 45,
    has_conflict: !!r.has_conflict,
  }));
}

/**
 * Scans for historical non-cancelled overlaps and flags them for review without deletion
 */
function detectAndFlagHistoricalConflicts(userId) {
  const result = db.prepare(`
    UPDATE appointments
    SET has_conflict = 1
    WHERE user_id = ?
      AND status NOT IN ('CANCELADO', 'CANCELLED')
      AND id IN (
        SELECT a1.id
        FROM appointments a1
        JOIN appointments a2 ON a1.user_id = a2.user_id
          AND a1.id != a2.id
          AND (a1.staff_id IS NULL OR a2.staff_id IS NULL OR a1.staff_id = a2.staff_id)
          AND a1.status NOT IN ('CANCELADO', 'CANCELLED')
          AND a2.status NOT IN ('CANCELADO', 'CANCELLED')
          AND a1.start_datetime < a2.end_datetime
          AND a1.end_datetime > a2.start_datetime
      )
  `).run(userId);

  const conflicts = db.prepare(`
    SELECT a1.id AS id1, a1.client_name AS client1, a1.start_datetime AS start1, a1.end_datetime AS end1,
           a2.id AS id2, a2.client_name AS client2, a2.start_datetime AS start2, a2.end_datetime AS end2,
           a1.staff_id
    FROM appointments a1
    JOIN appointments a2 ON a1.user_id = a2.user_id
      AND a1.id < a2.id
      AND (a1.staff_id IS NULL OR a2.staff_id IS NULL OR a1.staff_id = a2.staff_id)
      AND a1.status NOT IN ('CANCELADO', 'CANCELLED')
      AND a2.status NOT IN ('CANCELADO', 'CANCELLED')
      AND a1.start_datetime < a2.end_datetime
      AND a1.end_datetime > a2.start_datetime
    WHERE a1.user_id = ?
  `).all(userId);

  return { flaggedCount: result.changes, conflicts };
}

module.exports = {
  resolveEffectiveStaff,
  parseOpeningHours,
  checkInternalSlotAvailability,
  checkGoogleAvailability,
  checkSlotAvailability,
  findAlternativeSlots,
  bookAppointmentSync,
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
  updateAppointmentStatus,
  mapToPortugueseStatus,
  listAppointments,
  detectAndFlagHistoricalConflicts,
  toLocalISOString,
};
