const crypto = require('crypto');
const config = require('../config');

// Helper to hash string with SHA-256 according to Meta CAPI specification
function sha256(val) {
  if (!val) return null;
  return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
}

/**
 * Send server-side event to Meta Conversions API
 */
async function sendMetaCapiEvent({
  eventName,
  eventSourceUrl,
  eventId,
  userData = {},
  customData = {},
}) {
  const pixelId = config.metaPixelId;
  const token = config.metaCapiToken;

  if (!pixelId || !token) {
    // Graceful no-op when credentials not yet configured by user
    return { success: false, skipped: true, reason: 'META_PIXEL_ID ou META_CAPI_TOKEN não configurados.' };
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId || `meta_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        event_source_url: eventSourceUrl || config.baseUrl,
        action_source: 'website',
        user_data: {
          em: userData.email ? [sha256(userData.email)] : undefined,
          ph: userData.phone ? [sha256(userData.phone.replace(/\D/g, ''))] : undefined,
          client_ip_address: userData.ip || undefined,
          client_user_agent: userData.userAgent || undefined,
        },
        custom_data: {
          currency: customData.currency || 'BRL',
          value: customData.value || undefined,
          content_name: customData.contentName || undefined,
          content_category: customData.contentCategory || 'AI Agents',
          status: customData.status || undefined,
        },
      },
    ],
  };

  if (config.metaCapiTestCode) {
    payload.test_event_code = config.metaCapiTestCode;
  }

  try {
    const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) {
      console.warn('[Meta CAPI] Resposta com erro da Meta:', result);
      return { success: false, error: result };
    }

    console.log(`[Meta CAPI] Evento ${eventName} enviado com sucesso! Eventos recebidos: ${result.events_received || 1}`);
    return { success: true, result };
  } catch (err) {
    console.warn(`[Meta CAPI] Erro ao disparar evento ${eventName}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendMetaCapiEvent,
};
