require('dotenv').config();
const path = require('path');

let geminiKey = (process.env.GEMINI_API_KEY || '').trim();
if (geminiKey.includes('B8tpfH0')) {
  geminiKey = geminiKey.replace('B8tpfH0', 'B8tpFh0');
}

const config = {
  geminiApiKey: geminiKey,
  authorizedPhone: process.env.AUTHORIZED_PHONE || '', // e.g., '5511999999999' or comma-separated
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
  baseUrl: process.env.BASE_URL || 'https://raiaagentes.com.br',
  dbPath: path.resolve(__dirname, '../../data/assistant.db'),
  authDir: path.resolve(__dirname, '../../auth_info_baileys'),
  googleCredentialsPath: path.resolve(__dirname, '../../google_credentials.json'),
  googleTokenPath: path.resolve(__dirname, '../../google_token.json'),
  pixKey: process.env.PIX_KEY || '+5511951364159',
  pixName: process.env.PIX_NAME || 'RAIA RH',
  pixCity: process.env.PIX_CITY || 'SAO PAULO',
  pixPrice: process.env.PIX_PRICE || '29.00',
  pausePersonalAssistant: process.env.PAUSE_PERSONAL_ASSISTANT !== 'false', // Pausado por padrão para não conflitar no mesmo número
};

module.exports = config;
