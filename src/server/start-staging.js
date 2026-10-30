/**
 * RAIA AGENTES — Isolated Staging / Homologation Entrypoint
 * Starts Express Web Server without WhatsApp, without personal assistant,
 * and without Google Calendar background synchronization.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.PORT = process.env.PORT || 3333;
process.env.BASE_URL = process.env.BASE_URL || 'https://staging.raiaagentes.com.br';

require('../index');
