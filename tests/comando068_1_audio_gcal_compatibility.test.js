/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICA DE COMPATIBILIDADE ÁUDIO & GOOGLE CALENDAR
 * Branch: security/raia-27-protecoes
 * Validação: COMANDO 068.1 (Dynamic Late-Binding com Áudio + Limites e Sanitização)
 *
 * Módulos nativos: node:test e node:assert/strict
 * Isolamento total: Banco descartável em os.tmpdir()
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 1. Configuração mandatória do ambiente isolado em os.tmpdir() ANTES de carregar o banco
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raia-audio-gcal-test-'));
const testDbPath = path.join(tmpDir, 'test_audio_gcal.db');

process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.GOOGLE_SYNC_HOMOLOGATION_MODE = 'true';
process.env.GOOGLE_SYNC_LIVE_ENABLED = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'true';
process.env.SALON_TEST_ALLOWED_TENANTS = '3';
process.env.SALON_TEST_ALLOWED_PHONES = '5511999990003';
process.env.JESSICA_AUDIO_ENABLED = 'true';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'test_key_for_gcal_encryption_32b!';
process.env.MFA_ENCRYPTION_KEY = 'test_key_for_gcal_encryption_32b!';

// Carregar módulos do sistema sob o DB isolado
const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const salonIncomingDispatcher = require('../src/whatsapp/salonIncomingDispatcher');
const jessicaAudioService = require('../src/services/jessicaAudioService');
const googleCalendarService = require('../src/services/googleCalendarService');
const sessionService = require('../src/services/googleCalendarSessionService');
const outboxWorker = require('../src/services/outboxWorker');

const TEST_TENANT_ID = 3;
const TEST_CLIENT_PHONE = '5511999990003';
const TEST_ACCOUNT_EMAIL = 'salao.belladonna@test.com';
const TEST_CALENDAR_ID = 'c_sec_cal_audio123@group.calendar.google.com';

function setupTenantData() {
  // Tenant / Usuário Salão
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, subscription_status, paid_until, is_demo)
    VALUES (?, ?, ?, 'CLIENT_SALON', 'PRO', 'ACTIVE', datetime('now', '+30 days'), 0)
  `).run(TEST_TENANT_ID, TEST_CLIENT_PHONE, 'Salão Bella Donna');

  // Garantir produto JESSICA e assinatura de produto ativa para o tenant
  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const prodId = jessicaProd ? jessicaProd.id : 1;

  db.prepare(`
    INSERT OR REPLACE INTO customer_subscriptions (
      id, user_id, product_id, status, price_cents, setup_fee_cents,
      billing_cycle, contracted_at, paid_until, access_expires_at
    ) VALUES (
      101, ?, ?, 'ACTIVE', 14900, 0, 'MONTHLY', CURRENT_TIMESTAMP,
      datetime('now', '+30 days'), datetime('now', '+30 days')
    )
  `).run(TEST_TENANT_ID, prodId);

  // Salão
  db.prepare(`
    INSERT OR REPLACE INTO client_salons (
      user_id, salon_name, phone, whatsapp_status,
      google_selected_calendar_id, google_calendar_mode,
      whatsapp_notification_phone, whatsapp_notifications_enabled
    ) VALUES (?, ?, ?, 'CONNECTED', ?, 'SINGLE', ?, 1)
  `).run(TEST_TENANT_ID, 'Salão Bella Donna', TEST_CLIENT_PHONE, TEST_CALENDAR_ID, TEST_CLIENT_PHONE);

  // Serviço
  db.prepare(`
    INSERT OR REPLACE INTO client_services (id, user_id, name, price, duration_min, category, active)
    VALUES (101, ?, 'Corte Feminino', 90.00, 45, 'Cabelo', 1)
  `).run(TEST_TENANT_ID);

  // Profissional
  db.prepare(`
    INSERT OR REPLACE INTO client_staff (id, user_id, name, active)
    VALUES (201, ?, 'Camila Santos', 1)
  `).run(TEST_TENANT_ID);

  // Vínculo confirmado
  db.prepare(`
    INSERT OR REPLACE INTO client_service_staff (user_id, service_id, staff_id, confirmed)
    VALUES (?, 101, 201, 1)
  `).run(TEST_TENANT_ID);

  // Tokens cifrados do Google Calendar
  const encryptedTokens = googleCalendarService.encryptTokens({
    access_token: 'fake_access_token_audio_test',
    refresh_token: 'fake_refresh_token_audio_test',
    expiry_date: Date.now() + 3600000,
  });

  db.prepare(`
    INSERT OR REPLACE INTO google_calendar_tokens (
      user_id, account_email, encrypted_tokens, selected_calendar_id,
      sync_mode, is_connected, initial_connection_at, connected_at
    ) VALUES (?, ?, ?, ?, 'SINGLE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(TEST_TENANT_ID, TEST_ACCOUNT_EMAIL, encryptedTokens, TEST_CALENDAR_ID);
}

test.before(() => {
  setupTenantData();
});

test.after(() => {
  // Limpeza hermética
  salonIncomingDispatcher._resetForTesting();
  googleCalendarService.resetMockHandler();
  try {
    db.close();
  } catch (_) {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

// =========================================================================
// P0 — DYNAMIC LATE-BINDING COM CONFIRMAÇÃO POR ÁUDIO E SINCRONIZAÇÃO GCAL
// =========================================================================
test.describe('P0 — Dynamic Late-Binding com Confirmação por Áudio no WhatsApp', () => {
  test('Fluxo completo: Confirmação por ÁUDIO -> origin=WHATSAPP_BOT, input_modality=audio, vinculação e outbox', async () => {
    salonIncomingDispatcher._resetForTesting();
    googleCalendarService.resetMockHandler();

    // 1. Criar sessão de teste efêmera WHATSAPP_NEW ativa para o tenant
    const createdSession = sessionService.createTestSession({
      userId: TEST_TENANT_ID,
      calendarId: TEST_CALENDAR_ID,
      accountEmail: TEST_ACCOUNT_EMAIL,
      sessionType: 'WHATSAPP_NEW',
      authorizedClientPhone: TEST_CLIENT_PHONE,
      targetChannel: 'WHATSAPP_BOT',
      allowedAction: 'CREATE',
      durationMinutes: 30,
      maxExecutions: 1,
      createdBy: 1,
      reason: 'Homologation Test COMANDO 068.1',
    });

    assert.ok(createdSession);
    assert.equal(createdSession.status, 'ACTIVE');
    assert.equal(createdSession.session_type, 'WHATSAPP_NEW');
    assert.equal(createdSession.appointment_id, 0);

    // 2. Configurar sessão conversacional na memória da Jéssica em AWAITING_CONFIRMATION
    const sessionKey = `${TEST_TENANT_ID}:${TEST_CLIENT_PHONE}`;
    const targetDate = '2026-12-15';
    const targetTime = '15:00';

    // Disparar uma mensagem de inicialização para criar a sessão em memória
    const sentMessages = [];
    const mockSock = {
      sendMessage: async (jid, payload) => {
        sentMessages.push({ jid, payload });
        return { key: { id: 'reply_msg_01' } };
      },
    };

    // Forçar estado diretamente na sessão em memória
    const dummyInitMsg = {
      key: { id: 'init_msg_1', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      pushName: 'Mariana Lima',
      message: { conversation: 'Olá' },
    };
    await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, mockSock, dummyInitMsg);

    const custSession = salonIncomingDispatcher._getCustomerSessionForTesting(sessionKey);
    assert.ok(custSession, 'Sessão conversacional deve existir na memória');
    custSession.state = 'AWAITING_CONFIRMATION';
    custSession.selectedService = { id: 101, name: 'Corte Feminino', price: 90.00, duration_min: 45 };
    custSession.selectedStaff = { id: 201, name: 'Camila Santos' };
    custSession.selectedSlot = { date: targetDate, time: targetTime, dayLabel: 'Terça-feira' };
    custSession.customerName = 'Mariana Lima';

    // 3. Simular envio de ÁUDIO confirmando o agendamento
    const audioPayload = Buffer.alloc(15000, 0xBB);
    salonIncomingDispatcher.setMockDownloadMediaHandler(async () => audioPayload);
    jessicaAudioService.setMockAudioHandler(async () => ({
      success: true,
      text: 'Sim, confirmo o meu agendamento por favor!',
      durationSeconds: 3,
      latencyMs: 120,
    }));

    let mockGcalCreated = false;
    googleCalendarService.setMockHandler({
      createCalendarEvent: async (uid, apt, calId) => {
        mockGcalCreated = true;
        return {
          id: `real_gcal_audio_${apt.id}`,
          googleEventId: `real_gcal_audio_${apt.id}`,
          htmlLink: 'https://calendar.google.com/event?eid=mock_audio',
          calendarId: calId,
          isSimulated: false,
        };
      },
    });

    const incomingAudioMsg = {
      key: { id: 'audio_confirm_msg_100', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      pushName: 'Mariana Lima',
      message: {
        audioMessage: {
          mimetype: 'audio/ogg; codecs=opus',
          seconds: 3,
          fileLength: 15000,
        },
      },
    };

    const dispatchResult = await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, mockSock, incomingAudioMsg);
    assert.equal(dispatchResult, true, 'Mensagem de áudio deve ser processada com sucesso');

    // 4. Verificar se o agendamento foi inserido no SQLite conforme especificação
    const booked = db.prepare(`
      SELECT * FROM appointments
      WHERE user_id = ? AND client_phone = ?
      ORDER BY id DESC LIMIT 1
    `).get(TEST_TENANT_ID, TEST_CLIENT_PHONE);

    assert.ok(booked, 'Agendamento deve ter sido gravado');
    assert.equal(booked.origin, 'WHATSAPP_BOT', 'origin deve ser estritamente WHATSAPP_BOT');
    assert.equal(booked.input_modality, 'audio', 'input_modality deve ser estritamente audio');
    assert.equal(booked.service_id, 101);
    assert.equal(booked.staff_id, 201);

    // 5. Verificar auditoria de ciclo de vida em appointment_status_history
    const history = db.prepare(`
      SELECT * FROM appointment_status_history
      WHERE appointment_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(booked.id);

    assert.ok(history, 'Histórico de status deve existir');
    assert.equal(history.changed_by, 'WHATSAPP_BOT', 'appointment_status_history.changed_by deve ser WHATSAPP_BOT');

    // 6. Verificar se a sessão efêmera vinculou automaticamente o novo agendamento (Dynamic Late-Binding)
    const boundSession = db.prepare(`
      SELECT * FROM google_sync_test_sessions
      WHERE id = ?
    `).get(createdSession.id);

    assert.equal(boundSession.appointment_id, booked.id, 'Sessão efêmera deve estar vinculada ao novo agendamento');
    assert.equal(boundSession.session_type, 'EXISTING_APPOINTMENT');
    assert.equal(boundSession.allow_new_appointments, 0);

    // 7. Verificar se a tarefa Outbox de CREATE foi enfileirada no SQLite
    let outboxItem = db.prepare(`
      SELECT * FROM google_sync_outbox
      WHERE user_id = ? AND appointment_id = ? AND action = 'CREATE'
    `).get(TEST_TENANT_ID, booked.id);

    assert.ok(outboxItem, 'Tarefa CREATE deve existir no outbox');

    // 8. Executar o worker da outbox caso ainda não tenha sido processado pelo trigger assíncrono
    if (outboxItem.status === 'PENDING') {
      db.prepare(`
        UPDATE google_sync_outbox
        SET status = 'PENDING', locked_at = NULL, next_retry_at = NULL
        WHERE id = ?
      `).run(outboxItem.id);

      const processedCount = await outboxWorker.processGoogleSyncOutbox(TEST_TENANT_ID);
      assert.ok(processedCount >= 1, 'Worker deve processar ao menos 1 tarefa');
    }

    assert.equal(mockGcalCreated, true, 'Mock do Google Calendar deve ter sido invocado');

    // 9. Verificar estado pós-sincronização
    const outboxFinished = db.prepare(`SELECT * FROM google_sync_outbox WHERE id = ?`).get(outboxItem.id);
    assert.equal(outboxFinished.status, 'SENT', 'Outbox deve transicionar para SENT');

    const appointmentFinished = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(booked.id);
    assert.equal(appointmentFinished.google_sync_status, 'SYNCED');

    // 10. Sessão efêmera deve atingir COMPLETED com 1/1 execuções
    const completedSession = db.prepare(`SELECT * FROM google_sync_test_sessions WHERE id = ?`).get(createdSession.id);
    assert.equal(completedSession.status, 'COMPLETED', 'Sessão de teste deve estar COMPLETED');
    assert.equal(completedSession.executions_count, 1, 'Execuções devem ser exatamente 1');
    assert.equal(completedSession.max_executions, 1);
  });
});

// =========================================================================
// P1 — LIMITES DE DOWNLOAD E ROBUSTEZ DE METADADOS
// =========================================================================
test.describe('P1 — Limites de Download e Robustez de Metadados de Áudio', () => {
  const mockSock = {
    sendMessage: async (jid, payload) => ({ key: { id: 'mock_reply' } }),
  };

  test('Caso 1: fileLength ausente (undefined) com payload válido de 50KB -> Pre-Download aceita e transcreve', async () => {
    salonIncomingDispatcher._resetForTesting();
    let downloadCalled = false;

    salonIncomingDispatcher.setMockDownloadMediaHandler(async () => {
      downloadCalled = true;
      return Buffer.alloc(50 * 1024, 0xAA);
    });

    jessicaAudioService.setMockAudioHandler(async () => ({
      success: true,
      text: 'Quero cortar meu cabelo',
    }));

    const msg = {
      key: { id: 'c1_msg', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg; codecs=opus',
          seconds: 5,
          fileLength: undefined,
        },
      },
    };

    const res = await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, mockSock, msg);
    assert.equal(res, true);
    assert.equal(downloadCalled, true, 'Download deve ter sido realizado');
  });

  test('Caso 2: fileLength = 0 com payload de áudio válido -> Pre-Download aceita e transcreve', async () => {
    salonIncomingDispatcher._resetForTesting();
    let downloadCalled = false;

    salonIncomingDispatcher.setMockDownloadMediaHandler(async () => {
      downloadCalled = true;
      return Buffer.alloc(50 * 1024, 0xAA);
    });

    jessicaAudioService.setMockAudioHandler(async () => ({
      success: true,
      text: 'Quero agendar horário',
    }));

    const msg = {
      key: { id: 'c2_msg', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
          seconds: 4,
          fileLength: 0,
        },
      },
    };

    const res = await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, mockSock, msg);
    assert.equal(res, true);
    assert.equal(downloadCalled, true);
  });

  test('Caso 3: fileLength fraudado (declara 200B, baixa 6MB) -> Post-Download intercepta e descarta da RAM', async () => {
    salonIncomingDispatcher._resetForTesting();
    let geminiCalled = false;
    const sentReplies = [];

    salonIncomingDispatcher.setMockDownloadMediaHandler(async () => {
      return Buffer.alloc(6 * 1024 * 1024, 0xFF); // 6MB
    });

    jessicaAudioService.setMockAudioHandler(async () => {
      geminiCalled = true;
      return { success: true, text: 'Hacked' };
    });

    const trackingSock = {
      sendMessage: async (jid, payload) => {
        sentReplies.push(payload.text);
        return { key: { id: 'rep_3' } };
      },
    };

    const msg = {
      key: { id: 'c3_msg', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
          seconds: 5,
          fileLength: 200, // Fraudado
        },
      },
    };

    const res = await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, trackingSock, msg);
    assert.equal(res, true);
    assert.equal(geminiCalled, false, 'Gemini NÃO deve ser invocado para áudio > 5MB');
    assert.ok(sentReplies.some((t) => t.includes('5MB')), 'Deve responder amigavelmente sobre o limite de 5MB');
  });

  test('Caso 4: fileLength declarado > 5MB (ex: 6MB) -> Pre-Download Guard intercepta sem baixar', async () => {
    salonIncomingDispatcher._resetForTesting();
    let downloadCalled = false;
    const sentReplies = [];

    salonIncomingDispatcher.setMockDownloadMediaHandler(async () => {
      downloadCalled = true;
      return Buffer.alloc(100);
    });

    const trackingSock = {
      sendMessage: async (jid, payload) => {
        sentReplies.push(payload.text);
        return { key: { id: 'rep_4' } };
      },
    };

    const msg = {
      key: { id: 'c4_msg', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
          seconds: 10,
          fileLength: 6 * 1024 * 1024, // 6MB declarado
        },
      },
    };

    const res = await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, trackingSock, msg);
    assert.equal(res, true);
    assert.equal(downloadCalled, false, 'Download NÃO deve ocorrer se fileLength > 5MB no cabeçalho');
    assert.ok(sentReplies.some((t) => t.includes('5MB')));
  });

  test('Caso 5: seconds ausente (undefined) com áudio curto -> Pre-Download aceita e transcreve', async () => {
    salonIncomingDispatcher._resetForTesting();
    let transcribed = false;

    salonIncomingDispatcher.setMockDownloadMediaHandler(async () => Buffer.alloc(10000, 0x11));
    jessicaAudioService.setMockAudioHandler(async () => {
      transcribed = true;
      return { success: true, text: 'Oi tudo bem' };
    });

    const msg = {
      key: { id: 'c5_msg', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
          seconds: undefined,
          fileLength: 10000,
        },
      },
    };

    const res = await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, mockSock, msg);
    assert.equal(res, true);
    assert.equal(transcribed, true);
  });

  test('Caso 6: seconds > 120 (ex: 130s) -> Pre-Download Guard intercepta e avisa do limite de 2 minutos', async () => {
    salonIncomingDispatcher._resetForTesting();
    let downloadCalled = false;
    const sentReplies = [];

    salonIncomingDispatcher.setMockDownloadMediaHandler(async () => {
      downloadCalled = true;
      return Buffer.alloc(100);
    });

    const trackingSock = {
      sendMessage: async (jid, payload) => {
        sentReplies.push(payload.text);
        return { key: { id: 'rep_6' } };
      },
    };

    const msg = {
      key: { id: 'c6_msg', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
          seconds: 130, // 2m10s
          fileLength: 50000,
        },
      },
    };

    const res = await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, trackingSock, msg);
    assert.equal(res, true);
    assert.equal(downloadCalled, false, 'Download NÃO deve ocorrer se seconds > 120s');
    assert.ok(sentReplies.some((t) => t.includes('2 minutos')));
  });

  test('Caso 7: mimetype não-áudio (ex: video/mp4) -> Rejeitado amigavelmente antes do download', async () => {
    salonIncomingDispatcher._resetForTesting();
    let downloadCalled = false;
    const sentReplies = [];

    salonIncomingDispatcher.setMockDownloadMediaHandler(async () => {
      downloadCalled = true;
      return Buffer.alloc(100);
    });

    const trackingSock = {
      sendMessage: async (jid, payload) => {
        sentReplies.push(payload.text);
        return { key: { id: 'rep_7' } };
      },
    };

    const msg = {
      key: { id: 'c7_msg', remoteJid: `${TEST_CLIENT_PHONE}@s.whatsapp.net`, fromMe: false },
      message: {
        audioMessage: {
          mimetype: 'video/mp4', // Não-áudio
          seconds: 10,
          fileLength: 50000,
        },
      },
    };

    const res = await salonIncomingDispatcher.dispatchMessage(TEST_TENANT_ID, trackingSock, msg);
    assert.equal(res, true);
    assert.equal(downloadCalled, false);
    assert.ok(sentReplies.some((t) => t.includes('formato desse arquivo')));
  });
});

// =========================================================================
// P1 — MODELOS GEMINI E SANITIZAÇÃO DE ERROS
// =========================================================================
test.describe('P1 — Configuração de Modelos Gemini e Sanitização de Erros', () => {
  test('GEMINI_MODELS contém gemini-1.5-flash e gemini-1.5-flash-8b', () => {
    const audioServiceSource = fs.readFileSync(path.resolve(__dirname, '../src/services/jessicaAudioService.js'), 'utf8');
    assert.ok(audioServiceSource.includes('gemini-1.5-flash'), 'Deve conter gemini-1.5-flash');
    assert.ok(audioServiceSource.includes('gemini-1.5-flash-8b'), 'Deve conter gemini-1.5-flash-8b');
  });

  test('sanitizeAiError mascara chaves AIza..., query params key=... e headers x-goog-api-key', () => {
    const rawKey = 'AIzaSyDemoFakeSecretKey1234567890123456';
    const errText = `Request failed: https://generativelanguage.googleapis.com/v1beta/models?key=${rawKey} with header x-goog-api-key: ${rawKey} and direct token ${rawKey}`;

    const sanitized = jessicaAudioService.sanitizeAiError(new Error(errText));

    assert.equal(sanitized.includes(rawKey), false, 'A chave crua NUNCA deve constar no erro sanitizado');
    assert.ok(sanitized.includes('[REDACTED_GEMINI_KEY]'), 'Deve substituir as ocorrências por [REDACTED_GEMINI_KEY]');
  });

  test('transcribeAudio intercepta timeout com código AUDIO_TIMEOUT defensivo', async () => {
    jessicaAudioService.setMockAudioHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { success: true, text: 'Tarde demais' };
    });

    const result = await jessicaAudioService.transcribeAudio({
      audioBuffer: Buffer.alloc(1024),
      mimeType: 'audio/ogg',
      seconds: 5,
      timeoutMs: 2000,
    });

    assert.equal(result.success, false);
    assert.ok(result.error.includes('AUDIO_TIMEOUT'));
  });
});
