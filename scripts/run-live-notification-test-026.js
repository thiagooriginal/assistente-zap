/**
 * RAIA AGENTES — RUNNER MODULAR DE TESTE REAL DAS NOTIFICAÇÕES DA JÉSSICA (COMANDO 026)
 *
 * Suporta execução passo a passo assistida e controlada:
 * - connect: Inicia conexão Baileys isolada em ./auth_info_test_026, emite QR Code e aguarda pareamento.
 * - preview: Apresenta a prévia das duas mensagens e destinatários mascarados sem transmitir.
 * - send-maria: Executa o Teste 1 (NEW_APPOINTMENT) após autorização explícita e confirmação de Maria.
 * - send-joana: Executa o Teste 2 (REMINDER_24H) com consentimento explícito e confirmação de Joana.
 * - cleanup: Encerra e remove com segurança a pasta de credenciais e arquivos temporários de teste.
 *
 * @module scripts/run-live-notification-test-026
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// 1. Carrega variáveis locais de teste de .env.test_026 (se existente)
const envTestPath = path.resolve(process.cwd(), '.env.test_026');
if (fs.existsSync(envTestPath)) {
  const content = fs.readFileSync(envTestPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [k, ...v] = trimmed.split('=');
    if (k && v.length) {
      process.env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
    }
  }
}

// 2. Isolamento Absoluto do Banco Operacional (Regra 4.1 da Governança Multiagente)
const tmpDbPath = path.join(
  os.tmpdir(),
  `raia_test_026_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`
);
process.env.DB_PATH = tmpDbPath;

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const phoneUtils = require('../src/utils/phoneUtils');
const salonNotificationService = require('../src/services/salonNotificationService');
const salonReminderService = require('../src/services/salonReminderService');

// Configurações do Runner
const TEST_AUTH_DIR = path.resolve(process.cwd(), 'auth_info_test_026');
const QR_PNG_PATH = path.resolve(process.cwd(), 'qrcode_teste_026.png');
const ARTIFACT_DIR = 'C:\\Users\\Acer\\.gemini\\antigravity\\brain\\02a81ab1-3f50-4b80-b427-db4dc205d437';

/**
 * Mascara número telefônico para exibição segura sem vazamento em logs (ex: +55 (11) 9****-1234)
 * @param {string} phone
 * @returns {string}
 */
function maskPhone(phone) {
  if (!phone) return 'N/A';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length < 10) return '****' + clean.slice(-4);
  const norm = clean.startsWith('55') ? clean : '55' + clean;
  const ddd = norm.slice(2, 4);
  const last4 = norm.slice(-4);
  return `+55 (${ddd}) 9****-${last4}`;
}

/**
 * Normaliza número para o padrão internacional brasileiro 55XXXXXXXXXXX
 * @param {string} rawPhone
 * @returns {string|null}
 */
function normalizeRecipient(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 10) return null;

  let normalized = digits;
  if (!normalized.startsWith('55') && (normalized.length === 10 || normalized.length === 11)) {
    normalized = `55${normalized}`;
  }

  const ddd = normalized.slice(2, 4);
  if (!phoneUtils.isValidBrazilianDdd(ddd)) {
    return null;
  }

  return normalized;
}

/**
 * Validação de Whitelist Fail-Closed em Dupla Camada
 * @param {string} targetPhone
 * @param {Set<string>} whitelist
 */
function assertWhitelisted(targetPhone, whitelist) {
  const clean = String(targetPhone).replace(/\D/g, '');
  if (!whitelist.has(clean)) {
    throw new Error(`[SECURITY FAIL-CLOSED] Bloqueio preventivo: o número ${maskPhone(targetPhone)} NÃO pertence à whitelist estrita.`);
  }
  return clean;
}

/**
 * Inicializa o schema mínimo necessário no banco temporário descartável
 * @param {DatabaseSync} db
 */
function setupTemporaryDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'USER',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS client_salons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      salon_name TEXT NOT NULL,
      phone TEXT,
      whatsapp_notification_phone TEXT,
      whatsapp_notifications_enabled INTEGER DEFAULT 1,
      notify_new_appointment INTEGER DEFAULT 1,
      notify_cancellation INTEGER DEFAULT 1,
      notify_reschedule INTEGER DEFAULT 1,
      notify_sync_failure INTEGER DEFAULT 1,
      b2c_reminders_enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS client_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0.0,
      duration_minutes INTEGER NOT NULL DEFAULT 45,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS client_staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      client_name TEXT NOT NULL,
      client_phone TEXT,
      service_id INTEGER,
      staff_id INTEGER,
      price REAL,
      start_datetime TEXT NOT NULL,
      end_datetime TEXT,
      status TEXT NOT NULL DEFAULT 'CONFIRMADO',
      reminder_24h_status TEXT DEFAULT 'PENDING',
      reminder_consent INTEGER DEFAULT 1,
      reminder_consent_origin TEXT,
      whatsapp_notified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      appointment_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      recipient_phone TEXT NOT NULL,
      message_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      dedup_hash TEXT,
      is_simulated INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      last_error TEXT,
      sent_at TEXT,
      locked_at TEXT,
      next_retry_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Inicializa a conexão com o WhatsApp Baileys em pasta isolada
 * @param {boolean} exitOnConnect Se deve encerrar após conectar (para comando 'connect')
 * @returns {Promise<any>} Socket Baileys ativo
 */
async function connectIsolatedBaileys(exitOnConnect = false) {
  // Sempre limpa pasta de credenciais se não estiver autenticado para evitar estado corrompido
  const credsPath = path.join(TEST_AUTH_DIR, 'creds.json');
  if (exitOnConnect && fs.existsSync(TEST_AUTH_DIR)) {
    try {
      const credsData = fs.existsSync(credsPath) ? JSON.parse(fs.readFileSync(credsPath, 'utf8')) : null;
      if (!credsData || !credsData.registered) {
        fs.rmSync(TEST_AUTH_DIR, { recursive: true, force: true });
      }
    } catch (_) {
      fs.rmSync(TEST_AUTH_DIR, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(TEST_AUTH_DIR)) {
    fs.mkdirSync(TEST_AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(TEST_AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    let resolved = false;

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      browser: ['Assistente Zap', 'Desktop', '1.0.0'],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      qrTimeout: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n===============================================================');
        console.log('📱 ESCANEIE O QR CODE ABAIXO NO WHATSAPP DE TESTE DA JÉSSICA:');
        console.log('===============================================================\n');
        qrcodeTerminal.generate(qr, { small: true });

        try {
          await QRCode.toFile(QR_PNG_PATH, qr, { width: 350 });
          console.log(`🖼️ QR Code salvo também como imagem em: ${QR_PNG_PATH}`);

          // Cópia para o diretório de artefatos para visualização no Antigravity
          if (fs.existsSync(ARTIFACT_DIR)) {
            const artifactQrPath = path.join(ARTIFACT_DIR, 'qrcode_teste_026.png');
            fs.copyFileSync(QR_PNG_PATH, artifactQrPath);
            console.log(`🖼️ QR Code copiado para o diretório de artefatos: ${artifactQrPath}`);
          }
          console.log('ℹ️ Você pode escanear o QR Code acima pelo terminal ou abrir a imagem gerada.\n');
        } catch (err) {
          console.error('Aviso ao gerar imagem do QR Code:', err.message);
        }
      }

      if (connection === 'open') {
        const senderId = sock.user?.id ? sock.user.id.split(':')[0] : 'Conectado';
        console.log('\n===============================================================');
        console.log('✅ SOCKET BAILEYS DE TESTE CONECTADO COM SUCESSO!');
        console.log(`👤 Remetente Autenticado (Jéssica): ${maskPhone(senderId)}`);
        console.log(`📁 Pasta de Credenciais Isolada: ${TEST_AUTH_DIR}`);
        console.log('===============================================================\n');

        if (fs.existsSync(QR_PNG_PATH)) {
          try { fs.unlinkSync(QR_PNG_PATH); } catch (_) {}
        }

        if (!resolved) {
          resolved = true;
          if (exitOnConnect) {
            console.log('🔒 Sessão gravada com sucesso. Pronto para autorização e envio.');
            setTimeout(() => {
              try { sock.end(); } catch (_) {}
              process.exit(0);
            }, 1000);
          } else {
            resolve(sock);
          }
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          console.error('❌ Sessão desconectada pelo usuário (logged out). Remova auth_info_test_026 e reconecte.');
          if (!resolved) {
            resolved = true;
            reject(new Error('BAILEYS_LOGGED_OUT'));
          }
        } else if (!resolved && exitOnConnect) {
          console.log(`🔄 Reiniciando socket para gerar um QR Code novo e ativo... (Status: ${statusCode || 'refresh'})`);
          setTimeout(() => {
            connectIsolatedBaileys(exitOnConnect).then(resolve).catch(reject);
          }, 1500);
        }
      }
    });
  });
}

/**
 * Wrapper de Envio Seguro com Fail-Closed
 */
async function sendProtectedMessage(sock, jid, text, whitelist) {
  if (!jid || typeof jid !== 'string') {
    throw new Error('RECIPIENT_INVALID: JID vazio ou inválido');
  }

  // 1. Bloqueio total de grupos, canais e transmissões
  if (jid.endsWith('@g.us') || jid.includes('@broadcast') || jid.includes('@newsletter')) {
    throw new Error(`SECURITY_BLOCK: Disparo para grupo/broadcast sumariamente bloqueado: ${jid}`);
  }

  // 2. Extração estrita dos dígitos para checagem na whitelist
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  assertWhitelisted(digits, whitelist);

  // 3. Disparo estrito pelo socket de teste
  const response = await sock.sendMessage(`${digits}@s.whatsapp.net`, { text });
  if (!response?.key?.id) {
    throw new Error('BAILEYS_EMPTY_CONFIRMATION: Baileys não confirmou entrega com key.id');
  }

  return response;
}

/**
 * Obtém os números configurados no ambiente
 */
function getConfiguredPhones() {
  const args = process.argv.slice(2);
  let maria = process.env.TELEFONE_MARIA || '';
  let joana = process.env.TELEFONE_JOANA || '';
  let jessica = process.env.TELEFONE_JESSICA || '';

  for (const arg of args) {
    if (arg.startsWith('--maria=')) maria = arg.split('=')[1];
    if (arg.startsWith('--joana=')) joana = arg.split('=')[1];
    if (arg.startsWith('--jessica=')) jessica = arg.split('=')[1];
  }

  return {
    maria: normalizeRecipient(maria),
    joana: normalizeRecipient(joana),
    jessica: normalizeRecipient(jessica),
  };
}

// =============================================================================
// SUBCOMANDOS
// =============================================================================

/**
 * Subcomando: PREVIEW (Visualização prévia das mensagens sem transmissão)
 */
async function actionPreview() {
  const { maria, joana, jessica } = getConfiguredPhones();

  if (!maria || !joana) {
    console.error('❌ Configuração incompleta: informe TELEFONE_MARIA e TELEFONE_JOANA.');
    process.exit(1);
  }

  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const startDtIso = salonReminderService.toLocalISOString(tomorrow);
  const endDtIso = salonReminderService.toLocalISOString(new Date(tomorrow.getTime() + 45 * 60 * 1000));

  const msgMaria = salonNotificationService.buildNewAppointmentMessage({
    clientName: 'Joana',
    serviceName: 'Corte e Escova',
    staffName: 'Maria Silva',
    startDt: startDtIso,
    endDt: endDtIso,
  });

  const msgJoana = salonReminderService.build24hReminderMessage({
    clientName: 'Joana',
    serviceName: 'Corte e Escova',
    staffName: 'Maria Silva',
    salonName: 'Salão da Maria',
    startDt: startDtIso,
    endDt: endDtIso,
  });

  console.log('===============================================================');
  console.log('📋 PRÉVIA DE NOTIFICAÇÕES — COMANDO 026 (SEM TRANSMISSÃO)       ');
  console.log('===============================================================\n');

  console.log(`📱 Remetente (Jéssica): ${maskPhone(jessica)}`);
  console.log(`🔒 Whitelist Estrita: ${maskPhone(maria)} (Maria) e ${maskPhone(joana)} (Joana)\n`);

  console.log('---------------------------------------------------------------');
  console.log(`1️⃣ TESTE 1: AVISO NOVO AGENDAMENTO`);
  console.log(`   Destinatária: Maria (Responsável pelo Salão) -> ${maskPhone(maria)}`);
  console.log(`   Evento: NEW_APPOINTMENT`);
  console.log(`   Horário Agendamento: ${startDtIso} (Fuso America/Sao_Paulo)`);
  console.log(`   Texto da Mensagem:`);
  console.log(`\n${msgMaria}\n`);

  console.log('---------------------------------------------------------------');
  console.log(`2️⃣ TESTE 2: LEMBRETE 24 HORAS`);
  console.log(`   Destinatária: Joana (Cliente B2C) -> ${maskPhone(joana)}`);
  console.log(`   Evento: REMINDER_24H`);
  console.log(`   Consentimento: SIM (Origem: painel_confirmacao_manual)`);
  console.log(`   Janela de Elegibilidade: 24h antes do atendimento`);
  console.log(`   Texto da Mensagem:`);
  console.log(`\n${msgJoana}\n`);

  console.log('===============================================================');
  console.log('⚠️ Nenhuma mensagem foi transmitida. Aguardando autorização.');
  console.log('===============================================================\n');
}

/**
 * Subcomando: SEND-MARIA (Envia o Teste 1 para Maria)
 */
async function actionSendMaria() {
  const { maria, joana } = getConfiguredPhones();
  if (!maria) {
    console.error('❌ Telefone de Maria não configurado.');
    process.exit(1);
  }

  const whitelist = new Set([maria, joana].filter(Boolean));
  assertWhitelisted(maria, whitelist);

  console.log('===============================================================');
  console.log(`🚀 EXECUTANDO TESTE 1: AVISO IMEDIATO PARA MARIA (${maskPhone(maria)})`);
  console.log('===============================================================\n');

  const db = new DatabaseSync(tmpDbPath);
  setupTemporaryDatabase(db);

  try {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const startDtIso = salonReminderService.toLocalISOString(tomorrow);
    const endDtIso = salonReminderService.toLocalISOString(new Date(tomorrow.getTime() + 45 * 60 * 1000));

    db.prepare(`INSERT INTO users (id, phone_number, name, role) VALUES (1, ?, 'Maria', 'USER')`).run(maria);
    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, b2c_reminders_enabled)
      VALUES (1, 'Salão da Maria', ?, ?, 1, 1, 1)
    `).run(maria, maria);
    db.prepare(`INSERT INTO client_services (id, user_id, name, price, duration_minutes) VALUES (1, 1, 'Corte e Escova', 80.0, 45)`).run();
    db.prepare(`INSERT INTO client_staff (id, user_id, name, phone) VALUES (1, 1, 'Maria Silva', ?)`).run(maria);

    const aptInfo = db.prepare(`
      INSERT INTO appointments (user_id, client_name, client_phone, service_id, staff_id, price, start_datetime, end_datetime, status)
      VALUES (1, 'Joana', ?, 1, 1, 80.0, ?, ?, 'CONFIRMADO')
    `).run(joana || maria, startDtIso, endDtIso);
    const aptId = aptInfo.lastInsertRowid;

    const msgMaria = salonNotificationService.buildNewAppointmentMessage({
      clientName: 'Joana',
      serviceName: 'Corte e Escova',
      staffName: 'Maria Silva',
      startDt: startDtIso,
      endDt: endDtIso,
    });

    const dedupHash = crypto
      .createHash('sha256')
      .update(`1:${aptId}:NEW_APPOINTMENT:${maria}:${msgMaria.trim().replace(/\s+/g, ' ')}`)
      .digest('hex');

    const outboxInfo = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, dedup_hash, status)
      VALUES (1, ?, 'NEW_APPOINTMENT', ?, ?, ?, 'PENDING')
    `).run(aptId, maria, msgMaria, dedupHash);
    const outboxId = outboxInfo.lastInsertRowid;

    console.log('📡 Conectando ao Baileys com a sessão autenticada...');
    const sock = await connectIsolatedBaileys(false);

    console.log(`📤 Transmitindo mensagem para Maria (${maskPhone(maria)})...`);
    const sent = await sendProtectedMessage(sock, `${maria}@s.whatsapp.net`, msgMaria, whitelist);

    db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET status = 'SENT', is_simulated = 0, sent_at = CURRENT_TIMESTAMP, last_error = NULL
      WHERE id = ?
    `).run(outboxId);
    db.prepare(`UPDATE appointments SET whatsapp_notified = 1 WHERE id = ?`).run(aptId);

    console.log('\n===============================================================');
    console.log('✅ TESTE 1 CONCLUÍDO COM SUCESSO!');
    console.log(`   - Destinatária: Maria (${maskPhone(maria)})`);
    console.log(`   - Baileys Message Key ID: ${sent.key.id}`);
    console.log(`   - Timestamp da Transmissão: ${sent.messageTimestamp}`);
    console.log(`   - Status da Outbox: SENT`);
    console.log(`   - Appointment: whatsapp_notified = 1`);
    console.log('===============================================================\n');

    await new Promise((r) => setTimeout(r, 1000));
    try { sock.end(); } catch (_) {}
  } finally {
    db.close();
    try { if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath); } catch (_) {}
  }
}

/**
 * Subcomando: SEND-JOANA (Envia o Teste 2 para Joana)
 */
async function actionSendJoana() {
  const { maria, joana } = getConfiguredPhones();
  if (!joana) {
    console.error('❌ Telefone de Joana não configurado.');
    process.exit(1);
  }

  const whitelist = new Set([maria, joana].filter(Boolean));
  assertWhitelisted(joana, whitelist);

  console.log('===============================================================');
  console.log(`🚀 EXECUTANDO TESTE 2: LEMBRETE 24H PARA JOANA (${maskPhone(joana)})`);
  console.log('===============================================================\n');

  const db = new DatabaseSync(tmpDbPath);
  setupTemporaryDatabase(db);

  try {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const startDtIso = salonReminderService.toLocalISOString(tomorrow);
    const endDtIso = salonReminderService.toLocalISOString(new Date(tomorrow.getTime() + 45 * 60 * 1000));

    db.prepare(`INSERT INTO users (id, phone_number, name, role) VALUES (1, ?, 'Maria', 'USER')`).run(maria || joana);
    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_notification_phone, whatsapp_notifications_enabled, notify_new_appointment, b2c_reminders_enabled)
      VALUES (1, 'Salão da Maria', ?, ?, 1, 1, 1)
    `).run(maria || joana, maria || joana);

    const aptInfo = db.prepare(`
      INSERT INTO appointments (
        user_id, client_name, client_phone, service_id, staff_id, price,
        start_datetime, end_datetime, status, reminder_consent, reminder_consent_origin, reminder_24h_status
      ) VALUES (1, 'Joana', ?, 1, 1, 80.0, ?, ?, 'CONFIRMADO', 1, 'painel_confirmacao_manual', 'PENDING')
    `).run(joana, startDtIso, endDtIso);
    const aptId = aptInfo.lastInsertRowid;

    const msgJoana = salonReminderService.build24hReminderMessage({
      clientName: 'Joana',
      serviceName: 'Corte e Escova',
      staffName: 'Maria Silva',
      salonName: 'Salão da Maria',
      startDt: startDtIso,
      endDt: endDtIso,
    });

    const dedupHash = crypto
      .createHash('sha256')
      .update(`1:${aptId}:REMINDER_24H:${joana}:${startDtIso}`)
      .digest('hex');

    const outboxInfo = db.prepare(`
      INSERT INTO whatsapp_notification_outbox (user_id, appointment_id, event_type, recipient_phone, message_text, dedup_hash, status)
      VALUES (1, ?, 'REMINDER_24H', ?, ?, ?, 'PENDING')
    `).run(aptId, joana, msgJoana, dedupHash);
    const outboxId = outboxInfo.lastInsertRowid;

    console.log('📡 Conectando ao Baileys com a sessão autenticada...');
    const sock = await connectIsolatedBaileys(false);

    console.log(`📤 Transmitindo mensagem para Joana (${maskPhone(joana)})...`);
    const sent = await sendProtectedMessage(sock, `${joana}@s.whatsapp.net`, msgJoana, whitelist);

    db.prepare(`
      UPDATE whatsapp_notification_outbox
      SET status = 'SENT', is_simulated = 0, sent_at = CURRENT_TIMESTAMP, last_error = NULL
      WHERE id = ?
    `).run(outboxId);
    db.prepare(`UPDATE appointments SET reminder_24h_status = 'SENT' WHERE id = ?`).run(aptId);

    console.log('\n===============================================================');
    console.log('✅ TESTE 2 CONCLUÍDO COM SUCESSO!');
    console.log(`   - Destinatária: Joana (${maskPhone(joana)})`);
    console.log(`   - Baileys Message Key ID: ${sent.key.id}`);
    console.log(`   - Timestamp da Transmissão: ${sent.messageTimestamp}`);
    console.log(`   - Status da Outbox: SENT`);
    console.log(`   - Appointment: reminder_24h_status = SENT`);
    console.log('===============================================================\n');

    await new Promise((r) => setTimeout(r, 1000));
    try { sock.end(); } catch (_) {}
  } finally {
    db.close();
    try { if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath); } catch (_) {}
  }
}

/**
 * Subcomando: CLEANUP (Remove credenciais e arquivos temporários de teste)
 */
async function actionCleanup() {
  console.log('🧹 Iniciando encerramento e limpeza da sessão isolada...');

  if (fs.existsSync(TEST_AUTH_DIR)) {
    fs.rmSync(TEST_AUTH_DIR, { recursive: true, force: true });
    console.log(`   ✓ Pasta de autenticação ${TEST_AUTH_DIR} removida.`);
  }

  if (fs.existsSync(QR_PNG_PATH)) {
    fs.unlinkSync(QR_PNG_PATH);
    console.log(`   ✓ Arquivo temporário ${QR_PNG_PATH} removido.`);
  }

  if (fs.existsSync(envTestPath)) {
    fs.unlinkSync(envTestPath);
    console.log(`   ✓ Arquivo de configuração local ${envTestPath} removido.`);
  }

  console.log('🔒 Processo isolado encerrado com 100% de contenção.');
}

// =============================================================================
// DISPATCHER PRINCIPAL
// =============================================================================
async function main() {
  const command = process.argv[2] || 'preview';

  switch (command) {
    case 'connect':
      await connectIsolatedBaileys(true);
      break;
    case 'preview':
      await actionPreview();
      break;
    case 'send-maria':
      await actionSendMaria();
      break;
    case 'send-joana':
      await actionSendJoana();
      break;
    case 'cleanup':
      await actionCleanup();
      break;
    default:
      console.log(`Uso: node scripts/run-live-notification-test-026.js [connect|preview|send-maria|send-joana|cleanup]`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ ERRO FATAL:', err.message);
  process.exit(1);
});
