const fs = require('fs');
const { google } = require('googleapis');
const config = require('../config');

let oauth2Client = null;

function getOAuthClient() {
  if (oauth2Client) return oauth2Client;

  if (!fs.existsSync(config.googleCredentialsPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(config.googleCredentialsPath, 'utf8');
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

    oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      (redirect_uris && redirect_uris[0]) || 'http://localhost:3000/oauth2callback'
    );

    if (fs.existsSync(config.googleTokenPath)) {
      const token = JSON.parse(fs.readFileSync(config.googleTokenPath, 'utf8'));
      oauth2Client.setCredentials(token);

      // Handle automatic token refresh
      oauth2Client.on('tokens', (tokens) => {
        try {
          const currentToken = JSON.parse(fs.readFileSync(config.googleTokenPath, 'utf8'));
          const updatedToken = { ...currentToken, ...tokens };
          fs.writeFileSync(config.googleTokenPath, JSON.stringify(updatedToken, null, 2));
        } catch (err) {
          console.error('Erro ao atualizar token:', err);
        }
      });
    }

    return oauth2Client;
  } catch (err) {
    console.error('Erro ao inicializar Google OAuth Client:', err);
    return null;
  }
}

function isCalendarConnected() {
  const client = getOAuthClient();
  return !!(client && fs.existsSync(config.googleTokenPath));
}

/**
 * Create a new event on Google Calendar
 */
async function createCalendarEvent({ summary, description, startDateTime, endDateTime, location }) {
  const auth = getOAuthClient();
  if (!auth || !fs.existsSync(config.googleTokenPath)) {
    throw new Error('Google Calendar não está autenticado. Execute o script de login ou configure as credenciais.');
  }

  const calendar = google.calendar({ version: 'v3', auth });

  // Default end time to 1 hour after start if not provided
  let end = endDateTime;
  if (!end) {
    const startObj = new Date(startDateTime);
    end = new Date(startObj.getTime() + 60 * 60 * 1000).toISOString();
  }

  const eventResource = {
    summary,
    description: description || 'Criado via Assistente WhatsApp',
    location: location || '',
    start: {
      dateTime: startDateTime,
      timeZone: 'America/Sao_Paulo',
    },
    end: {
      dateTime: end,
      timeZone: 'America/Sao_Paulo',
    },
  };

  const response = await calendar.events.insert({
    calendarId: config.googleCalendarId,
    requestBody: eventResource,
  });

  return response.data;
}

/**
 * List upcoming events
 */
async function listUpcomingEvents({ maxResults = 10, timeMin = new Date().toISOString(), timeMax = null }) {
  const auth = getOAuthClient();
  if (!auth || !fs.existsSync(config.googleTokenPath)) {
    return [];
  }

  const calendar = google.calendar({ version: 'v3', auth });

  const params = {
    calendarId: config.googleCalendarId,
    timeMin,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  };

  if (timeMax) {
    params.timeMax = timeMax;
  }

  const response = await calendar.events.list(params);
  return response.data.items || [];
}

/**
 * Get upcoming events for reminder check (next 26 hours)
 */
async function getEventsForReminder() {
  const now = new Date();
  const next26Hours = new Date(now.getTime() + 26 * 60 * 60 * 1000);

  return await listUpcomingEvents({
    maxResults: 50,
    timeMin: now.toISOString(),
    timeMax: next26Hours.toISOString(),
  });
}

/**
 * Find the best matching event for an update or cancellation
 */
async function findEventToModify(targetSummary) {
  const upcoming = await listUpcomingEvents({ maxResults: 30 });
  if (!upcoming || upcoming.length === 0) return null;

  if (!targetSummary) {
    // Return the nearest upcoming event
    return upcoming[0];
  }

  const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const cleanTarget = norm(targetSummary);

  // 1. Exact or partial match on normalized summary
  const match = upcoming.find((e) => {
    const sum = norm(e.summary);
    return sum.includes(cleanTarget) || cleanTarget.includes(sum);
  });
  if (match) return match;

  // 2. Token overlap match (e.g. "reuniao", "dentista", "gabriel", "album")
  const tokens = cleanTarget.split(/\s+/).filter((t) => t.length > 2);
  const bestByToken = upcoming.find((e) => {
    const sum = norm(e.summary);
    return tokens.some((t) => sum.includes(t));
  });

  return bestByToken || upcoming[0];
}

/**
 * Update an existing event in Google Calendar
 */
async function updateCalendarEvent(eventId, { summary, description, startDateTime, endDateTime, location }) {
  const auth = getOAuthClient();
  if (!auth || !fs.existsSync(config.googleTokenPath)) {
    throw new Error('Google Calendar não está autenticado.');
  }

  const calendar = google.calendar({ version: 'v3', auth });

  const patchBody = {};
  if (summary) patchBody.summary = summary;
  if (description) patchBody.description = description;
  if (location !== undefined) patchBody.location = location;

  if (startDateTime) {
    patchBody.start = {
      dateTime: startDateTime,
      timeZone: 'America/Sao_Paulo',
    };
    let end = endDateTime;
    if (!end) {
      const startObj = new Date(startDateTime);
      end = new Date(startObj.getTime() + 60 * 60 * 1000).toISOString();
    }
    patchBody.end = {
      dateTime: end,
      timeZone: 'America/Sao_Paulo',
    };
  }

  const response = await calendar.events.patch({
    calendarId: config.googleCalendarId,
    eventId,
    requestBody: patchBody,
  });

  return response.data;
}

/**
 * Delete/cancel an event from Google Calendar
 */
async function deleteCalendarEvent(eventId) {
  const auth = getOAuthClient();
  if (!auth || !fs.existsSync(config.googleTokenPath)) {
    throw new Error('Google Calendar não está autenticado.');
  }

  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.delete({
    calendarId: config.googleCalendarId,
    eventId,
  });

  return true;
}

module.exports = {
  getOAuthClient,
  isCalendarConnected,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  findEventToModify,
  listUpcomingEvents,
  getEventsForReminder,
};
