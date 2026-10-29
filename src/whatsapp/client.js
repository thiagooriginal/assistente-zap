const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const db = require('../database/db');
const { handleIncomingMessage } = require('./messageHandler');
const { startReminderJob } = require('../services/reminderService');
const agentChatService = require('../services/agentChatService');

let currentSock = null;
let lastKnownUserJid = null;

function getTargetJid() {
  if (config.authorizedPhone) {
    const clean = config.authorizedPhone.split(',')[0].trim().replace(/[^0-9]/g, '');
    return `${clean}@s.whatsapp.net`;
  }
  return lastKnownUserJid;
}

async function sendWhatsAppMessage(jid, text) {
  if (!currentSock) {
    console.warn('Tentativa de envio sem socket ativo.');
    return;
  }
  // Hard security block: never send messages to groups, channels, or broadcasts
  if (
    !jid ||
    jid.endsWith('@g.us') ||
    jid.includes('@newsletter') ||
    jid.includes('@broadcast')
  ) {
    console.warn(`[Bloqueio de Segurança] Envio para destinatário inválido/grupo impedido: ${jid}`);
    return;
  }

  let finalJid = jid;
  if (finalJid.includes('@lid')) {
    const clean = finalJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    try {
      const mappingPath = path.resolve(config.authDir, `lid-mapping-${clean}_reverse.json`);
      if (fs.existsSync(mappingPath)) {
        const raw = fs.readFileSync(mappingPath, 'utf8');
        const phone = JSON.parse(raw);
        if (phone) finalJid = `${String(phone).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
      }
    } catch (e) {}
  } else if (!finalJid.endsWith('@s.whatsapp.net')) {
    const clean = finalJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    finalJid = `${clean}@s.whatsapp.net`;
  }

  try {
    const sent = await currentSock.sendMessage(finalJid, { text });
    if (sent?.key?.id) {
      try {
        db.prepare('INSERT OR IGNORE INTO processed_messages (id, sender_jid) VALUES (?, ?)').run(
          sent.key.id,
          finalJid
        );
      } catch (e) {}
    }
  } catch (err) {
    console.error(`Erro ao enviar mensagem para ${finalJid}:`, err.message);
  }
}

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Usando versão Baileys v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: ['Assistente Zap', 'Desktop', '1.0.0'],
    generateHighQualityLinkPreview: true,
  });

  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=========================================');
      console.log('📱 ESCANEIE O QR CODE ABAIXO NO SEU WHATSAPP:');
      console.log('=========================================\n');
      qrcodeTerminal.generate(qr, { small: true });

      // Save as PNG image in project root for easy viewing
      const qrImagePath = path.resolve(__dirname, '../../qrcode.png');
      try {
        await QRCode.toFile(qrImagePath, qr, { width: 350 });
        console.log(`\n🖼️ QR Code salvo também como imagem em: ${qrImagePath}`);
      } catch (err) {
        console.error('Erro ao salvar imagem QR code:', err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        'Conexão fechada. Motivo:',
        lastDisconnect?.error?.message,
        '| Reconectando:',
        shouldReconnect
      );

      if (shouldReconnect) {
        setTimeout(startWhatsAppBot, 3000);
      } else {
        console.log('Você foi desconectado (logout). Limpando sessão...');
        if (fs.existsSync(config.authDir)) {
          fs.rmSync(config.authDir, { recursive: true, force: true });
        }
        setTimeout(startWhatsAppBot, 2000);
      }
    } else if (connection === 'open') {
      console.log('\n=========================================');
      console.log('🚀 WHATSAPP CONECTADO COM SUCESSO!');
      console.log(`Conectado como: ${sock.user?.id || 'Desconhecido'}`);
      console.log('=========================================\n');

      if (sock.user?.id) {
        lastKnownUserJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      }

      // Start the Google Calendar reminder daemon (if not paused)
      if (config.pausePersonalAssistant) {
        console.log('\n⏸️ [Assistente Pessoal] Rotinas diárias e lembretes do assistente pessoal estão PAUSADOS para evitar conflito no mesmo número.');
      } else {
        startReminderJob(sendWhatsAppMessage, getTargetJid);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[WhatsApp Event] messages.upsert: type=${type}, count=${messages?.length || 0}`);

    for (const msg of messages) {
      if (!msg.message || !msg.key?.remoteJid) continue;

      const myCleanNumber = sock.user?.id ? sock.user.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
      let senderClean = '';

      if (msg.key.remoteJid.includes('@s.whatsapp.net') || msg.key.remoteJid.includes('@lid')) {
        let clean = msg.key.remoteJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        if (msg.key.remoteJid.includes('@lid')) {
          try {
            const mappingPath = path.resolve(config.authDir, `lid-mapping-${clean}_reverse.json`);
            if (fs.existsSync(mappingPath)) {
              const raw = fs.readFileSync(mappingPath, 'utf8');
              const phone = JSON.parse(raw);
              if (phone) clean = String(phone).replace(/[^0-9]/g, '');
            }
          } catch (e) {}
        }
        senderClean = clean;
      }

      // If message is fromMe: only process if it's a self-chat (talking to oneself) or authorized tester
      if (msg.key.fromMe) {
        const authList = config.authorizedPhone
          ? config.authorizedPhone.split(',').map((s) => s.trim().replace(/\D/g, '')).filter(Boolean)
          : [];
        const isAuth = authList.includes(senderClean) || authList.some((p) => msg.key.remoteJid.includes(p));
        const isSelfChat = (myCleanNumber && senderClean && senderClean === myCleanNumber) || isAuth;
        if (!isSelfChat) {
          // User is texting someone else, never interfere
          continue;
        }
      }

      const msgId = msg.key.id;
      if (!msgId) continue;

      // Ignore messages older than 12 hours
      const msgTimestamp = Number(msg.messageTimestamp || 0);
      const nowSec = Math.floor(Date.now() / 1000);
      if (msgTimestamp && (nowSec - msgTimestamp > 12 * 3600)) {
        continue;
      }

      // Check if already processed
      try {
        const existing = db.prepare('SELECT id FROM processed_messages WHERE id = ?').get(msgId);
        if (existing) {
          continue;
        }
        db.prepare('INSERT OR IGNORE INTO processed_messages (id, sender_jid) VALUES (?, ?)').run(
          msgId,
          msg.key.remoteJid
        );
      } catch (errDb) {
        console.error('Erro ao verificar mensagem processada:', errDb.message);
      }

      if (senderClean) {
        lastKnownUserJid = `${senderClean}@s.whatsapp.net`;
      }

      // 1. PRIORIDADE MÁXIMA: Verificar se é um Lead interagindo com um Agente RAIA (Jéssica, Sofia, Lex, etc.)
      const lead = agentChatService.findActiveLead(senderClean, msg.key?.remoteJid);
      if (lead) {
        console.log(`[WhatsApp] 🤖 Lead ativo para Agente ${lead.agent_name || lead.agent_key} (${senderClean || msg.key?.remoteJid}). Processando resposta com agentChatService...`);
        try {
          const handled = await agentChatService.handleLeadMessage(sock, msg, senderClean);
          if (handled) {
            continue; // Sucesso: mensagem respondida como o Agente de IA!
          }
        } catch (agentErr) {
          console.error('[WhatsApp] Erro no agentChatService:', agentErr.message);
        }
      }

      // 2. Se o assistente pessoal estiver pausado, ignorar para não conflitar com finanças/agenda pessoal
      if (config.pausePersonalAssistant) {
        console.log(`[WhatsApp] ⏸️ Assistente Pessoal Pausado: ignorando mensagem recebida de ${msg.key.remoteJid} (não é lead de demonstração).`);
        continue;
      }

      // 3. Assistente pessoal legado (finanças, agenda)
      console.log(`[WhatsApp] Processando mensagem pessoal (ID: ${msgId}, de: ${msg.key.remoteJid})`);
      await handleIncomingMessage(sock, msg).catch((err) => {
        console.error('Erro em handleIncomingMessage:', err.message);
      });
    }
  });

  return sock;
}

module.exports = {
  startWhatsAppBot,
  sendWhatsAppMessage,
  getTargetJid,
  isWhatsAppConnected: () => Boolean(currentSock && currentSock.user),
  getWhatsAppUser: () => currentSock?.user || null,
  isPersonalAssistantPaused: () => Boolean(config.pausePersonalAssistant),
  setPersonalAssistantPaused: (val) => { config.pausePersonalAssistant = Boolean(val); },
};

