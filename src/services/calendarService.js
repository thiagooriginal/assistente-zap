const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('../config');

let oauth2Client = null;

const persistentCredentialsPath = path.resolve(__dirname, '../../data/google_credentials.json');
const persistentTokenPath = path.resolve(__dirname, '../../data/google_token.json');

function resolveCredentialsContent() {
  // 1. Primary configured path
  if (fs.existsSync(config.googleCredentialsPath)) {
    try {
      return fs.readFileSync(config.googleCredentialsPath, 'utf8');
    } catch (e) {}
  }
  // 2. Persistent volume data/ path
  if (fs.existsSync(persistentCredentialsPath)) {
    try {
      return fs.readFileSync(persistentCredentialsPath, 'utf8');
    } catch (e) {}
  }
  // 3. Environment variable (raw JSON)
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
      return process.env.GOOGLE_CREDENTIALS_JSON;
    } catch (e) {}
  }
  // 4. Environment variable (Base64)
  if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    try {
      return Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8');
    } catch (e) {}
  }
  return null;
}

function resolveTokenContent() {
  // 1. Primary configured path
  if (fs.existsSync(config.googleTokenPath)) {
    try {
      return fs.readFileSync(config.googleTokenPath, 'utf8');
    } catch (e) {}
  }
  // 2. Persistent volume data/ path
  if (fs.existsSync(persistentTokenPath)) {
    try {
      return fs.readFileSync(persistentTokenPath, 'utf8');
    } catch (e) {}
  }
  // 3. Environment variable (raw JSON)
  if (process.env.GOOGLE_TOKEN_JSON) {
    try {
      return process.env.GOOGLE_TOKEN_JSON;
    } catch (e) {}
  }
  // 4. Environment variable (Base64)
  if (process.env.GOOGLE_TOKEN_BASE64) {
    try {
      return Buffer.from(process.env.GOOGLE_TOKEN_BASE64, 'base64').toString('utf8');
    } catch (e) {}
  }
  // 5. Database users table (stored for admin)
  try {
    const db = require('../database/db');
    const row = db.prepare(`SELECT google_token FROM users WHERE (role = 'ADMIN' OR id = 1) AND google_token IS NOT NULL LIMIT 1`).get();
    if (row && row.google_token) {
      return row.google_token;
    }
  } catch (e) {}

  return null;
}

function getOAuthClient() {
  if (oauth2Client) return oauth2Client;

  const credsRaw = resolveCredentialsContent();
  if (!credsRaw) {
    return null;
  }

  try {
    const credentials = JSON.parse(credsRaw);
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web || credentials;

    if (!client_id || !client_secret) return null;

    oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      (redirect_uris && redirect_uris[0]) || 'http://localhost:3000/oauth2callback'
    );

    const tokenRaw = resolveTokenContent();
    if (tokenRaw) {
      const token = JSON.parse(tokenRaw);
      oauth2Client.setCredentials(token);

      // Cache token to disk if possible
      try {
        if (!fs.existsSync(config.googleTokenPath)) fs.writeFileSync(config.googleTokenPath, tokenRaw, 'utf8');
        if (!fs.existsSync(persistentTokenPath)) fs.writeFileSync(persistentTokenPath, tokenRaw, 'utf8');
      } catch (e) {}

      // Handle automatic token refresh
      oauth2Client.on('tokens', (tokens) => {
        try {
          let currentToken = {};
          try {
            currentToken = JSON.parse(resolveTokenContent() || '{}');
          } catch (e) {}
          const updatedToken = { ...currentToken, ...tokens };
          const updatedStr = JSON.stringify(updatedToken, null, 2);

          try { fs.writeFileSync(config.googleTokenPath, updatedStr, 'utf8'); } catch (e) {}
          try { fs.writeFileSync(persistentTokenPath, updatedStr, 'utf8'); } catch (e) {}

          // Also persist in DB
          try {
            const db = require('../database/db');
            db.prepare(`UPDATE users SET google_token = ? WHERE role = 'ADMIN' OR id = 1`).run(updatedStr);
          } catch (e) {}
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
  if (!client || !client.credentials) return false;
  return !!(client.credentials.access_token || client.credentials.refresh_token);
}

function reloadCredentials() {
  oauth2Client = null;
  return getOAuthClient();
}

function saveCredentialsAndToken({ credentials, token }) {
  if (credentials) {
    const credsStr = typeof credentials === 'string' ? credentials : JSON.stringify(credentials, null, 2);
    JSON.parse(credsStr); // validate syntax
    try { fs.writeFileSync(config.googleCredentialsPath, credsStr, 'utf8'); } catch (e) {}
    try { fs.writeFileSync(persistentCredentialsPath, credsStr, 'utf8'); } catch (e) {}
  }

  if (token) {
    const tokenStr = typeof token === 'string' ? token : JSON.stringify(token, null, 2);
    JSON.parse(tokenStr); // validate syntax
    try { fs.writeFileSync(config.googleTokenPath, tokenStr, 'utf8'); } catch (e) {}
    try { fs.writeFileSync(persistentTokenPath, tokenStr, 'utf8'); } catch (e) {}

    try {
      const db = require('../database/db');
      db.prepare(`UPDATE users SET google_token = ? WHERE role = 'ADMIN' OR id = 1`).run(tokenStr);
    } catch (e) {}
  }

  return isCalendarConnected();
}

/**
 * Create a new event on Google Calendar
 */
async function createCalendarEvent({ summary, description, startDateTime, endDateTime, location }) {
  const auth = getOAuthClient();
  if (!auth || !isCalendarConnected()) {
    throw new Error('Google Calendar não está autenticado. Configure as credenciais no painel ou variáveis.');
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
  if (!auth || !isCalendarConnected()) {
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
  if (!auth || !isCalendarConnected()) {
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
  if (!auth || !isCalendarConnected()) {
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
  reloadCredentials,
  saveCredentialsAndToken,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  findEventToModify,
  listUpcomingEvents,
  getEventsForReminder,
};
