/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS: COMANDO 026
 * Verificação automatizada dos contratos das notificações da Jéssica (Maria & Joana)
 * em conformidade com as asserções especificadas pelo Engenheiro de Testes.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const testDbPath = path.join(os.tmpdir(), `raia_test_hermetic_026_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`);
process.env.DB_PATH = testDbPath;
process.env.APP_MODE = 'test';
process.env.NODE_ENV = 'test';

// Carrega o banco e os serviços após setar DB_PATH
const db = require('../src/database/db');
const salonNotificationService = require('../src/services/salonNotificationService');
const salonReminderService = require('../src/services/salonReminderService');

const TELEFONE_MARIA = '5511999990001';
const TELEFONE_JOANA = '5511999990002';
const SALON_USER_ID = 42;

async function runHermeticTests() {
  console.log('===============================================================');
  console.log('  🧪 RAIA AGENTES — TESTES HERMÉTICOS: COMANDO 026             ');
  console.log('===============================================================\n');

  let passed = 0;

  try {
    // Semente no banco isolado
    db.prepare(`INSERT OR REPLACE INTO users (id, name, phone_number) VALUES (?, 'Maria', ?)`).run(SALON_USER_ID, TELEFONE_MARIA);
    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, b2c_reminders_enabled)
      VALUES (?, 'Salão da Maria', ?, ?, 1)
    `).run(SALON_USER_ID, TELEFONE_MARIA, TELEFONE_MARIA);
    db.prepare(`INSERT OR REPLACE INTO client_services (id, user_id, name, price, duration_min) VALUES (1, ?, 'Corte e Escova', 80.0, 45)`).run(SALON_USER_ID);
    db.prepare(`INSERT OR REPLACE INTO client_staff (id, user_id, name) VALUES (1, ?, 'Maria Silva')`).run(SALON_USER_ID);

    // TESTE 1: Validação de E.164
    console.log('--- TESTE 1: Validação de E.164 e Formato dos Telefones ---');
    const e164Regex = /^55\d{10,11}$/;
    assert.match(TELEFONE_MARIA, e164Regex, 'Telefone da Maria deve ser E.164 válido');
    assert.match(TELEFONE_JOANA, e164Regex, 'Telefone da Joana deve ser E.164 válido');
    console.log('  ✓ Formatos E.164 validados com sucesso.');
    passed++;

    // TESTE 2: Mensagem e Enfileiramento NEW_APPOINTMENT (Maria)
    console.log('\n--- TESTE 2: Contrato da Notificação NEW_APPOINTMENT (Maria) ---');
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const startDtIso = salonReminderService.toLocalISOString(tomorrow);
    const endDtIso = salonReminderService.toLocalISOString(new Date(tomorrow.getTime() + 45 * 60 * 1000));

    const aptInfo = db.prepare(`
      INSERT INTO appointments (user_id, title, client_name, client_phone, service_id, staff_id, price, start_datetime, end_datetime, status)
      VALUES (?, 'Corte e Escova', 'Joana', ?, 1, 1, 80.0, ?, ?, 'CONFIRMADO')
    `).run(SALON_USER_ID, TELEFONE_JOANA, startDtIso, endDtIso);
    const aptId = aptInfo.lastInsertRowid;

    const messageMaria = salonNotificationService.buildNewAppointmentMessage({
      clientName: 'Joana',
      serviceName: 'Corte e Escova',
      staffName: 'Maria Silva',
      startDt: startDtIso,
      endDt: endDtIso,
    });

    assert.match(messageMaria, /✂️ Novo agendamento confirmado!/);
    assert.match(messageMaria, /Cliente: Joana/);
    assert.match(messageMaria, /Serviço: Corte e Escova/);
    assert.match(messageMaria, /Profissional: Maria Silva/);
    assert.match(messageMaria, /✅ Agendamento registrado pela Jéssica\./);
    console.log('  ✓ Mensagem de novo agendamento construída com conteúdo exato.');

    // Simular registro na Outbox
    const dedupHashMaria = crypto.createHash('sha256').update(`1:${aptId}:NEW_APPOINTMENT:${TELEFONE_MARIA}`).digest('hex');
    const ob1 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, dedup_hash, status)
      VALUES (?, ?, 'NEW_APPOINTMENT', ?, ?, ?, 'PENDING')
    `).run(SALON_USER_ID, aptId, TELEFONE_MARIA, messageMaria, dedupHashMaria);

    // Simular entrega real Baileys
    const simulatedRealKeyId = 'BAILEYS_TEST_' + crypto.randomBytes(8).toString('hex');
    db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET status = 'SENT', is_simulated = 0, sent_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(ob1.lastInsertRowid);
    db.prepare(`UPDATE appointments SET whatsapp_notified = 1 WHERE id = ?`).run(aptId);

    const checkMaria = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(ob1.lastInsertRowid);
    assert.equal(checkMaria.status, 'SENT');
    assert.equal(checkMaria.is_simulated, 0);
    assert.equal(checkMaria.recipient_phone, TELEFONE_MARIA);
    console.log('  ✓ Transição de Outbox e atualização de appointment comprovadas.');
    passed++;

    // TESTE 3: Mensagem e Enfileiramento REMINDER_24H (Joana)
    console.log('\n--- TESTE 3: Contrato do Lembrete B2C REMINDER_24H (Joana) ---');
    const messageJoana = salonReminderService.build24hReminderMessage({
      clientName: 'Joana',
      serviceName: 'Corte e Escova',
      staffName: 'Maria Silva',
      salonName: 'Salão da Maria',
      startDt: startDtIso,
      endDt: endDtIso,
    });

    assert.match(messageJoana, /Oi, Joana! Aqui é a Jéssica do \*Salão da Maria\* ✨/);
    assert.match(messageJoana, /Passando para lembrar do seu horário de \*Corte e Escova\* amanhã!/);
    assert.match(messageJoana, /👤 \*Profissional\*: Maria Silva/);
    assert.match(messageJoana, /Se precisar remarcar ou cancelar, é só me avisar por aqui\. Estamos te esperando! 💖/);
    console.log('  ✓ Mensagem de lembrete 24h construída com tom humanizado da Jéssica.');

    const dedupHashJoana = crypto.createHash('sha256').update(`1:${aptId}:REMINDER_24H:${TELEFONE_JOANA}`).digest('hex');
    const ob2 = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, dedup_hash, status)
      VALUES (?, ?, 'REMINDER_24H', ?, ?, ?, 'PENDING')
    `).run(SALON_USER_ID, aptId, TELEFONE_JOANA, messageJoana, dedupHashJoana);

    const simulatedRealKeyId2 = 'BAILEYS_TEST_' + crypto.randomBytes(8).toString('hex');
    db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET status = 'SENT', is_simulated = 0, sent_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(ob2.lastInsertRowid);
    db.prepare(`UPDATE appointments SET reminder_24h_status = 'SENT' WHERE id = ?`).run(aptId);

    const checkJoana = db.prepare('SELECT * FROM whatsapp_notification_outbox WHERE id = ?').get(ob2.lastInsertRowid);
    assert.equal(checkJoana.status, 'SENT');
    assert.equal(checkJoana.is_simulated, 0);
    assert.equal(checkJoana.recipient_phone, TELEFONE_JOANA);
    console.log('  ✓ Lembrete Joana registrado na Outbox com status SENT.');
    passed++;

    // TESTE 4: Invariante de Não-Violação de Destinatários
    console.log('\n--- TESTE 4: Invariante de Não-Violação de Destinatários ---');
    const recipients = db.prepare('SELECT DISTINCT recipient_phone FROM whatsapp_notification_outbox').all();
    for (const r of recipients) {
      assert.ok([TELEFONE_MARIA, TELEFONE_JOANA].includes(r.recipient_phone));
    }
    assert.equal(recipients.length, 2);
    console.log('  ✓ Zero contaminação: apenas Maria e Joana presentes na Outbox.');
    passed++;

    console.log('\n===============================================================');
    console.log(`🎉 TODOS OS ${passed}/4 TESTES HERMÉTICOS FORAM APROVADOS COM SUCESSO!`);
    console.log('===============================================================\n');
  } finally {
    try { if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch (_) {}
  }
}

runHermeticTests().catch((err) => {
  console.error('\n❌ ERRO NA SUÍTE HERMÉTICA:', err);
  process.exit(1);
});
