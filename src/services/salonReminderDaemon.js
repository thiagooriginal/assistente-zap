/**
 * RAIA AGENTES — DAEMON DE LEMBRETES B2C (JÉSSICA BEAUTY)
 * 
 * Ponto de entrada modular para o ciclo periódico de varredura e enfileiramento
 * dos lembretes automáticos de 24 horas da Jéssica.
 */

const salonReminderService = require('./salonReminderService');

module.exports = {
  startSalonReminderDaemon: salonReminderService.startSalonReminderDaemon,
  stopSalonReminderDaemon: salonReminderService.stopSalonReminderDaemon,
  checkAndQueue24hReminders: salonReminderService.checkAndQueue24hReminders,
  revokeClientConsent: salonReminderService.revokeClientConsent,
  registerClientConsent: salonReminderService.registerClientConsent,
};
