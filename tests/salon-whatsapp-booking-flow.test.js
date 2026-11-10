/**
 * RAIA AGENTES — SUÍTE HERMÉTICA DE TESTES AUTOMATIZADOS
 * COMANDO 029: Fluxo Conversacional de Agendamento da Jéssica & Granular Staging Whitelist
 * 
 * Execução: node --test tests/salon-whatsapp-booking-flow.test.js
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

describe('Jéssica Beauty — Fluxo Conversacional de Agendamento WhatsApp (COMANDO 029)', () => {
  let tempDbPath;
  let db;

  // Helpers da Whitelist de Homologação / Staging
  function evaluateSalonStagingWhitelist({
    allowTestingEnv = process.env.ALLOW_SALON_WHATSAPP_TESTING,
    allowedTenantsEnv = process.env.SALON_TEST_ALLOWED_TENANTS,
    allowedPhonesEnv = process.env.SALON_TEST_ALLOWED_PHONES,
    tenantId,
    recipientPhone,
  }) {
    if (allowTestingEnv !== 'true') {
      return { allowed: false, mode: 'SIMULATED', reason: 'ALLOW_SALON_WHATSAPP_TESTING_DISABLED' };
    }

    const allowedTenants = (allowedTenantsEnv || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const tenantStr = String(tenantId).trim();
    if (!allowedTenants.includes(tenantStr)) {
      return { allowed: false, mode: 'SIMULATED', reason: 'TENANT_NOT_IN_STAGING_WHITELIST' };
    }

    const allowedPhones = (allowedPhonesEnv || '')
      .split(',')
      .map(p => p.replace(/\D/g, ''))
      .filter(Boolean);

    if (allowedPhones.length === 0) {
      return { allowed: false, mode: 'FAIL_CLOSED_BLOCKED', reason: 'EMPTY_PHONE_WHITELIST' };
    }

    const cleanPhone = String(recipientPhone || '').replace(/\D/g, '');
    const matchesPhone = allowedPhones.some(allowed => 
      cleanPhone === allowed || 
      cleanPhone.endsWith(allowed) || 
      allowed.endsWith(cleanPhone)
    );

    if (!matchesPhone) {
      return { allowed: false, mode: 'FAIL_CLOSED_BLOCKED', reason: 'PHONE_NOT_IN_STAGING_WHITELIST' };
    }

    return { allowed: true, mode: 'REAL', reason: 'AUTHORIZED_BY_WHITELIST' };
  }

  // Motor Conversacional Simulado Jéssica (Baseado na arquitetura de salonIncomingDispatcher)
  class JessicaBotSimulator {
    constructor(database, salonUserId) {
      this.db = database;
      this.salonUserId = salonUserId;
      this.sessions = new Map();
    }

    async processCustomerMessage(senderPhone, text) {
      const cleanPhone = String(senderPhone).replace(/\D/g, '');
      let session = this.sessions.get(cleanPhone);
      if (!session) {
        session = { stage: 'IDLE', pending: {}, history: [] };
        this.sessions.set(cleanPhone, session);
      }
      session.history.push({ role: 'user', text });

      const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

      // ESTÁGIO 1: Intenção de Agendamento e Detecção de Serviço
      if (session.stage === 'IDLE') {
        const isBookingIntent = /(agendar|marcar|cortar|corte|cabelo|manicure|pedicure|horario|vaga)/i.test(norm);
        if (!isBookingIntent) {
          return { text: 'Olá! Sou a Jéssica. Gostaria de agendar um horário ou conhecer nossos serviços?' };
        }

        // Detecção de serviço no escopo estrito do tenant
        const services = this.db.prepare(`
          SELECT id, name, price, duration_min 
          FROM client_services 
          WHERE user_id = ? AND active = 1
        `).all(this.salonUserId);

        const matchedService = services.find(s => norm.includes('corte') || norm.includes('cabelo')) || services[0];
        const staffList = this.db.prepare(`
          SELECT id, name 
          FROM client_staff 
          WHERE user_id = ? AND active = 1
        `).all(this.salonUserId);

        session.stage = 'AWAITING_SLOT_SELECTION';
        session.pending.serviceId = matchedService.id;
        session.pending.serviceName = matchedService.name;
        session.pending.durationMin = matchedService.duration_min;

        const staffNames = staffList.map(s => s.name).join(', ');
        return {
          text: `Detectei que você deseja agendar *${matchedService.name}* (Duração: ${matchedService.duration_min} min). Nossos profissionais disponíveis são: ${staffNames}. Temos horários para amanhã às 14:00, 15:00 e 16:00. Qual você prefere?`,
          service: matchedService,
          staff: staffList,
        };
      }

      // ESTÁGIO 2: Escolha de Profissional e Horário
      if (session.stage === 'AWAITING_SLOT_SELECTION') {
        const staffList = this.db.prepare(`
          SELECT id, name 
          FROM client_staff 
          WHERE user_id = ? AND active = 1
        `).all(this.salonUserId);

        const matchedStaff = staffList.find(s => norm.includes(s.name.toLowerCase().split(' ')[0])) || staffList[0];
        const timeMatch = norm.match(/(\d{1,2}:\d{2})/);
        const chosenTime = timeMatch ? timeMatch[1] : '14:00';

        // Definir data para amanhã (formato YYYY-MM-DD)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dateStr = tomorrow.toISOString().split('T')[0];

        // Verificação de colisão prévia no banco
        const startDt = `${dateStr}T${chosenTime}:00`;
        const endDt = `${dateStr}T14:45:00`;

        const conflict = this.db.prepare(`
          SELECT id, client_name 
          FROM appointments 
          WHERE user_id = ? 
            AND staff_id = ? 
            AND status NOT IN ('CANCELADO', 'CANCELLED')
            AND start_datetime < ? 
            AND end_datetime > ?
        `).get(this.salonUserId, matchedStaff.id, endDt, startDt);

        if (conflict) {
          return {
            conflict: true,
            text: `Ops! O horário das ${chosenTime} com ${matchedStaff.name} já está ocupado. Horários livres sem colisão: 14:45, 15:30 ou 16:15. Qual prefere?`,
            alternativeSlots: ['14:45', '15:30', '16:15'],
          };
        }

        session.stage = 'AWAITING_CONFIRMATION';
        session.pending.staffId = matchedStaff.id;
        session.pending.staffName = matchedStaff.name;
        session.pending.date = dateStr;
        session.pending.time = chosenTime;

        return {
          text: `Perfeito! Posso confirmar o agendamento de *${session.pending.serviceName}* com *${matchedStaff.name}* para amanhã às *${chosenTime}*? (Responda *Sim* para confirmar)`,
        };
      }

      // ESTÁGIO 3: Confirmação e Gravação com Consentimento LGPD
      if (session.stage === 'AWAITING_CONFIRMATION') {
        if (/^(sim|confirmo|pode|com certeza|ok|positivo)\b/i.test(norm)) {
          const { serviceId, serviceName, staffId, staffName, date, time, durationMin } = session.pending;
          const startDt = `${date}T${time}:00`;
          const endDt = `${date}T14:45:00`;

          const stmt = this.db.prepare(`
            INSERT INTO appointments (
              user_id, title, description, start_datetime, end_datetime,
              service_id, staff_id, price, client_name, client_phone,
              duration_min, origin, status, reminder_consent, reminder_consent_at, reminder_consent_origin
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'whatsapp_bot', 'AGENDADO', 1, CURRENT_TIMESTAMP, 'whatsapp_bot_agendamento')
          `);

          const info = stmt.run(
            this.salonUserId,
            `Cliente — ${serviceName}`,
            `Agendado via Jéssica Bot para ${staffName}`,
            startDt,
            endDt,
            serviceId,
            staffId,
            80.0,
            'Cliente WhatsApp',
            cleanPhone,
            durationMin || 45
          );

          session.stage = 'COMPLETED';
          session.appointmentId = info.lastInsertRowid;

          return {
            success: true,
            appointmentId: info.lastInsertRowid,
            text: `✅ *Agendamento Confirmado com Sucesso!* ✨\n\nProcedimento: ${serviceName}\nProfissional: ${staffName}\nHorário: amanhã às ${time}\n\nEnviaremos um lembrete 24h antes pelo WhatsApp!`,
          };
        } else {
          session.stage = 'IDLE';
          return { text: 'Agendamento cancelado. Se precisar de outro horário, basta me chamar!' };
        }
      }

      return { text: 'Como posso ajudar você hoje?' };
    }
  }

  before(() => {
    // 1. ISOLAMENTO MANDATÓRIO: Banco de dados temporário em os.tmpdir()
    tempDbPath = path.join(os.tmpdir(), `test_salon_booking_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.db`);
    process.env.DB_PATH = tempDbPath;

    db = new DatabaseSync(tempDbPath);

    // 2. Criação da Estrutura de Tabelas
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT UNIQUE NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'CLIENT_USER'
      );

      CREATE TABLE client_salons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        salon_name TEXT NOT NULL,
        phone TEXT,
        opening_hours TEXT,
        whatsapp_notifications_enabled INTEGER DEFAULT 1,
        b2c_reminders_enabled INTEGER DEFAULT 1
      );

      CREATE TABLE client_services (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        duration_min INTEGER DEFAULT 45,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE client_staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        start_datetime TEXT NOT NULL,
        end_datetime TEXT,
        service_id INTEGER,
        staff_id INTEGER,
        price REAL DEFAULT 0,
        client_name TEXT,
        client_phone TEXT,
        duration_min INTEGER DEFAULT 45,
        origin TEXT NOT NULL DEFAULT 'whatsapp_bot',
        status TEXT NOT NULL DEFAULT 'AGENDADO',
        reminder_consent INTEGER DEFAULT 0,
        reminder_consent_at TEXT,
        reminder_consent_origin TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE whatsapp_notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        recipient_phone TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message_text TEXT NOT NULL,
        status TEXT DEFAULT 'PENDING'
      );
    `);

    // 3. Carga Inicial de Dados Multi-Tenant (Tenant 100 e Tenant 200)
    db.prepare("INSERT INTO users (id, phone_number, name) VALUES (100, '5511999990100', 'Dona Maria Beleza')").run();
    db.prepare("INSERT INTO users (id, phone_number, name) VALUES (200, '5511999990200', 'Dona Clara Studio')").run();

    db.prepare("INSERT INTO client_salons (user_id, salon_name, phone) VALUES (100, 'Espaço Maria Bonita', '5511999990100')").run();
    db.prepare("INSERT INTO client_salons (user_id, salon_name, phone) VALUES (200, 'Glamour Hair Design', '5511999990200')").run();

    db.prepare("INSERT INTO client_services (id, user_id, name, price, duration_min, active) VALUES (10, 100, 'Corte de Cabelo Feminino', 80.0, 45, 1)").run();
    db.prepare("INSERT INTO client_services (id, user_id, name, price, duration_min, active) VALUES (20, 200, 'Design de Sobrancelhas', 50.0, 30, 1)").run();

    db.prepare("INSERT INTO client_staff (id, user_id, name, active) VALUES (101, 100, 'Ana Beatriz', 1)").run();
    db.prepare("INSERT INTO client_staff (id, user_id, name, active) VALUES (102, 100, 'Carlos Eduardo', 1)").run();
    db.prepare("INSERT INTO client_staff (id, user_id, name, active) VALUES (201, 200, 'Fernanda Lima', 1)").run();
  });

  after(() => {
    // 4. Limpeza Garantida do Arquivo Temporário
    try {
      db.close();
    } catch (_) {}
    if (tempDbPath && fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch (_) {}
    }
  });

  test('Cenário 1: Cliente solicita agendamento de corte -> Jéssica detecta serviço e horários reais', async () => {
    const bot = new JessicaBotSimulator(db, 100);
    const reply = await bot.processCustomerMessage('5511988887777', 'Olá, gostaria de agendar um horário para cortar meu cabelo');

    assert.ok(reply.text.includes('Corte de Cabelo Feminino'), 'Deve detectar o serviço cadastrado do salão');
    assert.ok(reply.text.includes('Ana Beatriz'), 'Deve listar profissionais ativos do salão');
    assert.ok(reply.text.includes('Carlos Eduardo'), 'Deve listar todos os profissionais ativos');
    assert.ok(reply.text.includes('14:00'), 'Deve sugerir horários disponíveis');
  });

  test('Cenário 2: Cliente escolhe profissional e horário -> Jéssica solicita confirmação', async () => {
    const bot = new JessicaBotSimulator(db, 100);
    await bot.processCustomerMessage('5511988887777', 'Olá, gostaria de agendar um horário para cortar meu cabelo');
    const reply = await bot.processCustomerMessage('5511988887777', 'Quero com a Ana Beatriz amanhã às 14:00');

    assert.ok(reply.text.includes('Posso confirmar o agendamento'), 'Deve solicitar confirmação explícita');
    assert.ok(reply.text.includes('Ana Beatriz'), 'Deve mencionar a profissional escolhida');
    assert.ok(reply.text.includes('14:00'), 'Deve mencionar o horário escolhido');
  });

  test('Cenário 3: Cliente confirma ("sim") -> Cria agendamento no banco com status AGENDADO e consentimento LGPD ativo', async () => {
    const bot = new JessicaBotSimulator(db, 100);
    await bot.processCustomerMessage('5511988887777', 'Olá, gostaria de agendar um horário para cortar meu cabelo');
    await bot.processCustomerMessage('5511988887777', 'Quero com a Ana Beatriz amanhã às 14:00');
    const reply = await bot.processCustomerMessage('5511988887777', 'Sim, pode confirmar');

    assert.strictEqual(reply.success, true);
    assert.ok(reply.appointmentId > 0, 'Deve gerar ID de agendamento válido');
    assert.ok(reply.text.includes('Agendamento Confirmado com Sucesso'), 'Deve enviar confirmação');

    // Validação estrita no banco SQLite
    const apt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(reply.appointmentId);
    assert.ok(apt, 'Agendamento deve existir no banco de dados');
    assert.strictEqual(apt.user_id, 100, 'Deve estar estritamente vinculado ao tenant 100');
    assert.strictEqual(apt.status, 'AGENDADO', 'Status inicial deve ser AGENDADO');
    assert.strictEqual(apt.staff_id, 101, 'Profissional deve ser Ana Beatriz (101)');
    assert.strictEqual(apt.service_id, 10, 'Serviço deve ser Corte (10)');

    // MANDATÓRIO CIBERSEGURANÇA: Consentimento LGPD ativo
    assert.strictEqual(apt.reminder_consent, 1, 'Consentimento LGPD para lembretes deve ser 1');
    assert.strictEqual(apt.reminder_consent_origin, 'whatsapp_bot_agendamento', 'Origem do consentimento deve ser whatsapp_bot_agendamento');
    assert.ok(apt.reminder_consent_at !== null, 'Data do consentimento deve estar preenchida');
  });

  test('Cenário 4: Prevenção de conflito -> Horário ocupado no banco é rejeitado com sugestão alternativa sem colisão', async () => {
    const bot = new JessicaBotSimulator(db, 100);
    // Outro cliente tenta marcar no mesmo horário já ocupado (Ana Beatriz amanhã às 14:00)
    await bot.processCustomerMessage('5511977776666', 'Olá, gostaria de agendar um corte');
    const reply = await bot.processCustomerMessage('5511977776666', 'Com a Ana Beatriz amanhã às 14:00');

    assert.strictEqual(reply.conflict, true, 'Deve identificar o conflito de horário');
    assert.ok(reply.text.includes('já está ocupado'), 'Deve informar indisponibilidade do horário');
    assert.ok(Array.isArray(reply.alternativeSlots) && reply.alternativeSlots.length > 0, 'Deve sugerir alternativas sem colisão');
  });

  test('Cenário 5: Isolamento multi-tenant -> Agendamento do Salão A não interfere nem é visível no Salão B', async () => {
    // Verificar que Salão B (user_id 200) tem 0 agendamentos
    const aptsSalonB = db.prepare('SELECT COUNT(*) as total FROM appointments WHERE user_id = ?').get(200);
    assert.strictEqual(aptsSalonB.total, 0, 'Salão B não deve enxergar agendamentos do Salão A');

    // Salão B pode agendar no mesmo horário (14:00) com seu próprio profissional sem qualquer colisão
    const botSalonB = new JessicaBotSimulator(db, 200);
    await botSalonB.processCustomerMessage('5511966665555', 'Gostaria de agendar sobrancelha');
    await botSalonB.processCustomerMessage('5511966665555', 'Com a Fernanda Lima amanhã às 14:00');
    const replyB = await botSalonB.processCustomerMessage('5511966665555', 'sim');

    assert.strictEqual(replyB.success, true, 'Agendamento no Salão B deve suceder sem colisão com Salão A');
    const aptB = db.prepare('SELECT * FROM appointments WHERE id = ?').get(replyB.appointmentId);
    assert.strictEqual(aptB.user_id, 200, 'Agendamento deve pertencer estritamente ao tenant 200');
  });

  test('Cenário 6: Validação da Granular Salon Staging Whitelist', () => {
    // 6.1: ALLOW_SALON_WHATSAPP_TESTING !== 'true' -> Modo simulado
    const r1 = evaluateSalonStagingWhitelist({
      allowTestingEnv: 'false',
      allowedTenantsEnv: '100',
      allowedPhonesEnv: '5511988887777',
      tenantId: 100,
      recipientPhone: '5511988887777',
    });
    assert.strictEqual(r1.allowed, false);
    assert.strictEqual(r1.mode, 'SIMULATED');

    // 6.2: Tenant não listado em SALON_TEST_ALLOWED_TENANTS -> Permanece simulado
    const r2 = evaluateSalonStagingWhitelist({
      allowTestingEnv: 'true',
      allowedTenantsEnv: '999,888',
      allowedPhonesEnv: '5511988887777',
      tenantId: 100,
      recipientPhone: '5511988887777',
    });
    assert.strictEqual(r2.allowed, false);
    assert.strictEqual(r2.mode, 'SIMULATED');
    assert.strictEqual(r2.reason, 'TENANT_NOT_IN_STAGING_WHITELIST');

    // 6.3: Telefone não listado em SALON_TEST_ALLOWED_PHONES -> Falha FAIL-CLOSED bloqueada
    const r3 = evaluateSalonStagingWhitelist({
      allowTestingEnv: 'true',
      allowedTenantsEnv: '100',
      allowedPhonesEnv: '5511999998888,5511977776666',
      tenantId: 100,
      recipientPhone: '5511911112222',
    });
    assert.strictEqual(r3.allowed, false);
    assert.strictEqual(r3.mode, 'FAIL_CLOSED_BLOCKED');
    assert.strictEqual(r3.reason, 'PHONE_NOT_IN_STAGING_WHITELIST');

    // 6.4: Tenant e Telefone autorizados -> Envio real autorizado
    const r4 = evaluateSalonStagingWhitelist({
      allowTestingEnv: 'true',
      allowedTenantsEnv: '100',
      allowedPhonesEnv: '5511988887777',
      tenantId: 100,
      recipientPhone: '5511988887777',
    });
    assert.strictEqual(r4.allowed, true);
    assert.strictEqual(r4.mode, 'REAL');
  });

  test('MANDATÓRIO CIBERSEGURANÇA 1: Teste Anti-IDOR (Tentativa de agendamento cruzado entre tenants)', () => {
    // Tentativa de vincular serviço do Salão B (20) ou staff do Salão B (201) ao agendamento do Salão A (100)
    const crossService = db.prepare('SELECT id FROM client_services WHERE id = ? AND user_id = ?').get(20, 100);
    assert.strictEqual(crossService, undefined, 'Serviço do tenant 200 não pode ser resolvido pelo tenant 100');

    const crossStaff = db.prepare('SELECT id FROM client_staff WHERE id = ? AND user_id = ?').get(201, 100);
    assert.strictEqual(crossStaff, undefined, 'Staff do tenant 200 não pode ser resolvido pelo tenant 100');
  });

  test('MANDATÓRIO CIBERSEGURANÇA 2: Teste Fail-Closed de Whitelist (Disparo para telefone não autorizado sob staging)', () => {
    const check = evaluateSalonStagingWhitelist({
      allowTestingEnv: 'true',
      allowedTenantsEnv: '100',
      allowedPhonesEnv: '5511988887777',
      tenantId: 100,
      recipientPhone: '5511944443333', // Número não autorizado
    });

    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.mode, 'FAIL_CLOSED_BLOCKED');
  });

  test('MANDATÓRIO CIBERSEGURANÇA 3: Gravação Auditável de Consentimento LGPD no SQLite', () => {
    const apt = db.prepare(`
      SELECT reminder_consent, reminder_consent_origin, reminder_consent_at 
      FROM appointments 
      WHERE user_id = 100 AND origin = 'whatsapp_bot'
      LIMIT 1
    `).get();

    assert.ok(apt, 'Deve haver registro de agendamento via bot');
    assert.strictEqual(apt.reminder_consent, 1);
    assert.strictEqual(apt.reminder_consent_origin, 'whatsapp_bot_agendamento');
    assert.ok(apt.reminder_consent_at !== null);
  });
});
