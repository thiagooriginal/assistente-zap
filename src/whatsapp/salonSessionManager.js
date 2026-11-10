/**
 * RAIA AGENTES — GERENCIADOR MULTI-SESSÃO WHATSAPP BAILEYS (MÓDULO JÉSSICA)
 *
 * Cada salão autenticado possui sua própria instância isolada de socket em memória
 * e credenciais no filesystem dentro de data/sessions/salon_<userId>/.
 *
 * Suporta conexão via QR Code dinâmico em memória e Código de Pareamento de 8 dígitos.
 * Em conformidade com a Matriz RAIA-27 (OWASP ASVS 5.0) e Hard Staging Lock.
 *
 * @module whatsapp/salonSessionManager
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../database/db');
const SalonWhatsAppRepository = require('../database/salonWhatsAppRepository');
const phoneUtils = require('../utils/phoneUtils');
const clientModule = require('./client');

// Raiz padrão das credenciais persistentes
let SESSIONS_ROOT = path.resolve(__dirname, '../../data/sessions');

// Mapa em memória de sessões ativas: userId => SessionInstance
const activeSessions = new Map();

// Mutex de conexão para prevenir cliques concorrentes: userId => Promise
const connectionLocks = new Map();

/**
 * Sanitiza e retorna o caminho absoluto seguro do diretório de credenciais do salão
 * Proteção 23 (OWASP ASVS 5.0): Defesa contra Directory Traversal
 *
 * @param {number} userId
 * @returns {string}
 */
function getSalonSessionDir(userId) {
  const rawId = String(userId ?? '').trim();
  if (!/^\d+$/.test(rawId)) {
    throw new Error('INVALID_TENANT_ID: Identificador de salão inválido.');
  }
  const numericId = parseInt(rawId, 10);
  if (numericId <= 0) {
    throw new Error('INVALID_TENANT_ID: Identificador de salão inválido.');
  }
  if (!fs.existsSync(SESSIONS_ROOT)) {
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
  }
  const sessionDir = path.resolve(SESSIONS_ROOT, `salon_${numericId}`);
  if (!sessionDir.startsWith(SESSIONS_ROOT)) {
    throw new Error('SECURITY_VIOLATION: Tentativa de violação de diretório de sessão.');
  }
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Normaliza e valida o número para código de pareamento no padrão brasileiro (E.164)
 *
 * @param {string} rawPhone
 * @returns {string} Dígitos normalizados com DDI 55 (ex: '5511999998888')
 */
function validateBrazilianPhoneForPairing(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') {
    throw new Error('INVALID_PHONE_FORMAT: Informe um número de telefone com DDD.');
  }

  const clean = phoneUtils.cleanDigits(rawPhone);
  let formatted = clean;

  if (!formatted.startsWith('55')) {
    formatted = `55${clean}`;
  }

  // Com DDI 55, número brasileiro deve ter 12 (fixo) ou 13 (móvel) dígitos
  if (formatted.length < 12 || formatted.length > 13) {
    throw new Error('INVALID_PHONE_LENGTH: Número de telefone deve conter DDD e de 8 a 9 dígitos.');
  }

  const ddd = formatted.slice(2, 4);
  if (!phoneUtils.isValidBrazilianDdd(ddd)) {
    throw new Error('INVALID_BRAZILIAN_DDD: O código DDD informado é inválido no Brasil.');
  }

  // Validação do 9º dígito para celulares (13 dígitos)
  if (formatted.length === 13) {
    const ninthDigit = formatted.slice(4, 5);
    if (ninthDigit !== '9') {
      throw new Error('INVALID_MOBILE_NINTH_DIGIT: Telefones celulares no Brasil devem iniciar com 9.');
    }
  }

  return formatted;
}

/**
 * Retorna o status de conexão atual do salão
 *
 * @param {number} userId
 * @returns {object}
 */
function getSessionStatus(userId) {
  const uid = Number(userId);
  const memSession = activeSessions.get(uid);

  if (memSession) {
    const now = Date.now();
    const hasPairing = Boolean(memSession.pairingCode && memSession.pairingExpiresAt && memSession.pairingExpiresAt > now);

    return {
      status: memSession.status,
      connectedPhone: memSession.connectedPhone ? phoneUtils.maskPhoneNumber(memSession.connectedPhone) : null,
      rawPhone: memSession.connectedPhone || null,
      lastConnectedAt: memSession.lastConnectedAt || null,
      lastError: memSession.lastError || null,
      pairingMethod: memSession.pairingMethod || null,
      hasQr: Boolean(memSession.qrCode),
      qrCode: memSession.qrCode,
      hasPairingCode: hasPairing,
      pairingCode: hasPairing ? memSession.pairingCode : null,
      pairingExpiresAt: memSession.pairingExpiresAt || null,
    };
  }

  // Consulta no repositório persistido
  const repoSession = SalonWhatsAppRepository.getSessionByUserId(uid);
  if (repoSession) {
    return {
      status: repoSession.session_status || 'DISCONNECTED',
      connectedPhone: repoSession.connected_phone ? phoneUtils.maskPhoneNumber(repoSession.connected_phone) : null,
      rawPhone: repoSession.connected_phone || null,
      lastConnectedAt: repoSession.connected_at || null,
      lastError: repoSession.last_error || null,
      pairingMethod: repoSession.pairing_method || null,
      hasQr: Boolean(repoSession.qr_code_cached),
      qrCode: repoSession.qr_code_cached || null,
      hasPairingCode: false,
      pairingCode: null,
      pairingExpiresAt: null,
    };
  }

  return {
    status: 'DISCONNECTED',
    connectedPhone: null,
    rawPhone: null,
    lastConnectedAt: null,
    lastError: null,
    pairingMethod: null,
    hasQr: false,
    qrCode: null,
    hasPairingCode: false,
    pairingCode: null,
    pairingExpiresAt: null,
  };
}

/**
 * Inicializa ou recupera a sessão QR Code do salão
 *
 * @param {number} userId
 * @returns {Promise<{ success: boolean, qrCode: string|null, status: string, connectedPhone?: string }>}
 */
async function startQrSession(userId) {
  const uid = Number(userId);

  // Trava de concorrência
  if (connectionLocks.has(uid)) {
    return connectionLocks.get(uid);
  }

  const connectPromise = (async () => {
    let session = activeSessions.get(uid);
    if (session && session.status === 'CONNECTED') {
      return {
        success: true,
        status: 'CONNECTED',
        qrCode: null,
        connectedPhone: session.connectedPhone ? phoneUtils.maskPhoneNumber(session.connectedPhone) : null,
      };
    }

    const sessionDir = getSalonSessionDir(uid);
    SalonWhatsAppRepository.ensureSessionExists(uid, `data/sessions/salon_${uid}`);

    // Hard Staging Lock: em staging/homologacao sem autorização, opera modo simulado limpo
    const isRealAllowed = clientModule.isRealWhatsAppTransportAllowed();
    if (!isRealAllowed) {
      const simQrDataUrl = await QRCode.toDataURL(`RAIA_HOMOLOGACAO_SALON_${uid}_MOCK_QR_${Date.now()}`, {
        margin: 2,
        width: 280,
        color: { dark: '#4E3B31', light: '#FFFDFB' },
      });

      session = {
        userId: uid,
        sock: null,
        status: 'WAITING_QR',
        qrCode: simQrDataUrl,
        pairingCode: null,
        pairingExpiresAt: null,
        connectedPhone: null,
        lastConnectedAt: null,
        lastError: null,
        pairingMethod: 'QR',
      };
      activeSessions.set(uid, session);
      SalonWhatsAppRepository.updateQrCode(uid, simQrDataUrl, 120);

      SalonWhatsAppRepository.createLog(uid, {
        eventType: 'QR_GENERATED',
        newStatus: 'WAITING_QR',
        pairingMethod: 'QR',
        reason: 'QR Code de homologação gerado com sucesso.',
      });

      return { success: true, qrCode: simQrDataUrl, status: 'WAITING_QR' };
    }

    // Em produção com autorização real: conecta ao Baileys
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      browser: ['Jéssica Beauty', 'Desktop', '1.0.0'],
      generateHighQualityLinkPreview: false,
      printQRInTerminal: false,
      syncFullHistory: false,
    });

    session = {
      userId: uid,
      sock,
      status: 'CONNECTING',
      qrCode: null,
      pairingCode: null,
      pairingExpiresAt: null,
      connectedPhone: null,
      lastConnectedAt: null,
      lastError: null,
      pairingMethod: 'QR',
    };
    activeSessions.set(uid, session);

    sock.ev.on('creds.update', saveCreds);

    // Listener para mensagens recebidas da cliente final no WhatsApp comercial do salão
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (m.type === 'notify' && Array.isArray(m.messages)) {
          const { handleIncomingMessage } = require('./messageHandler');
          for (const msg of m.messages) {
            if (!msg.message || !msg.key?.remoteJid || msg.key.fromMe) continue;
            await handleIncomingMessage(sock, msg, { salonUserId: uid });
          }
        }
      } catch (err) {
        console.error(`[salonSessionManager] Erro no processamento de mensagem recebida #${uid}:`, err.message);
      }
    });

    return new Promise((resolve) => {
      let resolved = false;

      // Timeout defensivo de 25 segundos para retorno da requisição inicial
      const initialTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ success: true, qrCode: session.qrCode, status: session.status });
        }
      }, 25000);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            session.qrCode = await QRCode.toDataURL(qr, {
              margin: 2,
              width: 280,
              color: { dark: '#4E3B31', light: '#FFFDFB' },
            });
            session.status = 'WAITING_QR';
            SalonWhatsAppRepository.updateQrCode(uid, session.qrCode, 60);

            SalonWhatsAppRepository.createLog(uid, {
              eventType: 'QR_GENERATED',
              newStatus: 'WAITING_QR',
              pairingMethod: 'QR',
            });
          } catch (err) {
            session.lastError = 'Falha ao codificar imagem do QR Code.';
          }

          if (!resolved) {
            resolved = true;
            clearTimeout(initialTimeout);
            resolve({ success: true, qrCode: session.qrCode, status: 'WAITING_QR' });
          }
        }

        if (connection === 'open') {
          const jid = sock.user?.id || '';
          const cleanPhone = phoneUtils.cleanDigits(jid.split('@')[0].split(':')[0]);
          session.status = 'CONNECTED';
          session.connectedPhone = cleanPhone;
          session.lastConnectedAt = new Date().toISOString();
          session.qrCode = null;
          session.pairingCode = null;
          session.lastError = null;

          SalonWhatsAppRepository.markSessionConnected(uid, {
            phone: cleanPhone,
            phoneJid: `${cleanPhone}@s.whatsapp.net`,
            pairingMethod: 'QR',
          });

          SalonWhatsAppRepository.createLog(uid, {
            eventType: 'CONNECTED',
            newStatus: 'CONNECTED',
            pairingMethod: 'QR',
            connectedPhone: cleanPhone,
            reason: 'WhatsApp comercial do salão conectado com sucesso via QR Code.',
          });

          if (!resolved) {
            resolved = true;
            clearTimeout(initialTimeout);
            resolve({
              success: true,
              status: 'CONNECTED',
              qrCode: null,
              connectedPhone: phoneUtils.maskPhoneNumber(cleanPhone),
            });
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          if (isLoggedOut) {
            await disconnect(uid);
          } else {
            session.status = 'CONNECTION_LOST';
            session.lastError = lastDisconnect?.error?.message || 'Conexão temporariamente interrompida.';
            SalonWhatsAppRepository.markSessionDisconnected(uid, {
              status: 'CONNECTION_LOST',
              error: session.lastError,
            });

            SalonWhatsAppRepository.createLog(uid, {
              eventType: 'DISCONNECTED',
              newStatus: 'CONNECTION_LOST',
              reason: session.lastError,
            });
          }
        }
      });
    });
  })();

  connectionLocks.set(uid, connectPromise);
  try {
    return await connectPromise;
  } finally {
    connectionLocks.delete(uid);
  }
}

/**
 * Solicita Código de Pareamento de 8 dígitos para o número informado
 *
 * @param {number} userId
 * @param {string} rawPhone
 * @returns {Promise<{ success: boolean, pairingCode: string, expiresAt: number, status: string }>}
 */
async function requestPairingCode(userId, rawPhone) {
  const uid = Number(userId);
  const formattedPhone = validateBrazilianPhoneForPairing(rawPhone);

  if (connectionLocks.has(uid)) {
    return connectionLocks.get(uid);
  }

  const pairingPromise = (async () => {
    const sessionDir = getSalonSessionDir(uid);
    SalonWhatsAppRepository.ensureSessionExists(uid, `data/sessions/salon_${uid}`);

    // Hard Staging Lock: modo simulado em homologação/staging
    const isRealAllowed = clientModule.isRealWhatsAppTransportAllowed();
    if (!isRealAllowed) {
      const part1 = Math.random().toString(36).substring(2, 6).toUpperCase();
      const part2 = Math.random().toString(36).substring(2, 6).toUpperCase();
      const simCode = `${part1}-${part2}`;
      const expiresAt = Date.now() + 180000; // 3 minutos

      const session = {
        userId: uid,
        sock: null,
        status: 'WAITING_CODE',
        qrCode: null,
        pairingCode: simCode,
        pairingExpiresAt: expiresAt,
        connectedPhone: null,
        lastConnectedAt: null,
        lastError: null,
        pairingMethod: 'CODE',
      };
      activeSessions.set(uid, session);
      SalonWhatsAppRepository.updatePairingCode(uid, simCode, 180);

      SalonWhatsAppRepository.createLog(uid, {
        eventType: 'PAIRING_CODE_REQUESTED',
        newStatus: 'WAITING_CODE',
        pairingMethod: 'CODE',
        connectedPhone: formattedPhone,
        reason: 'Código de pareamento simulado gerado em ambiente de homologação.',
      });

      return { success: true, pairingCode: simCode, expiresAt, status: 'WAITING_CODE' };
    }

    // Modo Real Baileys
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      browser: ['Jéssica Beauty', 'Desktop', '1.0.0'],
      printQRInTerminal: false,
      syncFullHistory: false,
    });

    const rawPairingCode = await sock.requestPairingCode(formattedPhone);
    const formattedCode = rawPairingCode && rawPairingCode.length === 8
      ? `${rawPairingCode.slice(0, 4)}-${rawPairingCode.slice(4)}`
      : rawPairingCode;

    const expiresAt = Date.now() + 180000; // 3 minutos

    const session = {
      userId: uid,
      sock,
      status: 'WAITING_CODE',
      qrCode: null,
      pairingCode: formattedCode,
      pairingExpiresAt: expiresAt,
      connectedPhone: null,
      lastConnectedAt: null,
      lastError: null,
      pairingMethod: 'CODE',
    };
    activeSessions.set(uid, session);

    SalonWhatsAppRepository.updatePairingCode(uid, formattedCode, 180);
    SalonWhatsAppRepository.createLog(uid, {
      eventType: 'PAIRING_CODE_REQUESTED',
      newStatus: 'WAITING_CODE',
      pairingMethod: 'CODE',
      connectedPhone: formattedPhone,
    });

    sock.ev.on('creds.update', saveCreds);

    // Listener para mensagens recebidas da cliente final no WhatsApp comercial do salão
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (m.type === 'notify' && Array.isArray(m.messages)) {
          const { handleIncomingMessage } = require('./messageHandler');
          for (const msg of m.messages) {
            if (!msg.message || !msg.key?.remoteJid || msg.key.fromMe) continue;
            await handleIncomingMessage(sock, msg, { salonUserId: uid });
          }
        }
      } catch (err) {
        console.error(`[salonSessionManager] Erro no processamento de mensagem recebida #${uid}:`, err.message);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        const jid = sock.user?.id || '';
        const cleanConnPhone = phoneUtils.cleanDigits(jid.split('@')[0].split(':')[0]);
        session.status = 'CONNECTED';
        session.connectedPhone = cleanConnPhone;
        session.lastConnectedAt = new Date().toISOString();
        session.pairingCode = null;
        session.lastError = null;

        SalonWhatsAppRepository.markSessionConnected(uid, {
          phone: cleanConnPhone,
          phoneJid: `${cleanConnPhone}@s.whatsapp.net`,
          pairingMethod: 'CODE',
        });

        SalonWhatsAppRepository.createLog(uid, {
          eventType: 'CONNECTED',
          newStatus: 'CONNECTED',
          pairingMethod: 'CODE',
          connectedPhone: cleanConnPhone,
          reason: 'WhatsApp comercial do salão conectado via código de pareamento.',
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          await disconnect(uid);
        }
      }
    });

    return { success: true, pairingCode: formattedCode, expiresAt, status: 'WAITING_CODE' };
  })();

  connectionLocks.set(uid, pairingPromise);
  try {
    return await pairingPromise;
  } finally {
    connectionLocks.delete(uid);
  }
}

/**
 * Desconecta a sessão do salão e expurga os arquivos de credencial
 *
 * @param {number} userId
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function disconnect(userId) {
  const uid = Number(userId);
  const session = activeSessions.get(uid);

  if (session && session.sock) {
    try {
      session.sock.end(undefined);
    } catch (_) {}
  }

  activeSessions.delete(uid);

  // Expurgo seguro das credenciais em disco
  try {
    const sessionDir = getSalonSessionDir(uid);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[salonSessionManager] Erro ao remover pasta de sessão #${uid}:`, err.message);
  }

  SalonWhatsAppRepository.markSessionDisconnected(uid, {
    status: 'DISCONNECTED',
    resetCredentials: true,
  });

  SalonWhatsAppRepository.createLog(uid, {
    eventType: 'LOGOUT_USER',
    newStatus: 'DISCONNECTED',
    reason: 'Desconexão voluntária do salão pelo painel da Jéssica.',
  });

  return { success: true, message: 'WhatsApp comercial do salão desconectado e credenciais removidas com sucesso.' };
}

/**
 * Despacha mensagem via sessão WhatsApp comercial conectada do próprio salão
 *
 * @param {number} userId
 * @param {string} recipientJid
 * @param {string} text
 * @param {object} [options]
 * @returns {Promise<{ success: boolean, sent: boolean, simulated: boolean, messageId?: string, timestamp: number }>}
 */
async function sendSalonMessage(userId, recipientJid, text, options = {}) {
  const uid = Number(userId);
  if (!uid || isNaN(uid)) {
    throw new Error('INVALID_TENANT_ID: Identificador de salão inválido.');
  }

  // Sanitização e validação de destinatário
  const cleanRecipient = String(recipientJid || '').trim();
  const finalJid = cleanRecipient.includes('@') ? cleanRecipient : `${cleanRecipient}@s.whatsapp.net`;

  // Defesa de segurança: rejeitar grupos, canais e broadcasts
  if (
    finalJid.endsWith('@g.us') ||
    finalJid.includes('@newsletter') ||
    finalJid.includes('@broadcast')
  ) {
    throw new Error('RECIPIENT_FORBIDDEN: Envio para grupos ou listas não autorizado.');
  }

  const nowTs = Math.floor(Date.now() / 1000);

  // 1. Hard Staging Lock: Modo Simulado fail-closed em testes, homologação e staging
  const isRealAllowed = clientModule.isRealWhatsAppTransportAllowed();
  if (!isRealAllowed) {
    const simMessageId = `sim_salon_${uid}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    return {
      success: true,
      sent: false,
      simulated: true,
      isSimulated: true,
      blocked: false,
      accepted: true,
      messageId: simMessageId,
      timestamp: nowTs,
      recipientJid: finalJid,
    };
  }

  // 2. Modo Real: Validação de sessão conectada
  const session = activeSessions.get(uid);
  if (!session || session.status !== 'CONNECTED' || !session.sock) {
    // Se a sessão do salão não está ativa, fallback para o cliente WhatsApp padrão
    return await clientModule.sendWhatsAppMessage(finalJid, text);
  }

  const sock = session.sock;
  if (!sock.user || (sock.ws && sock.ws.readyState !== undefined && sock.ws.readyState !== 1)) {
    return await clientModule.sendWhatsAppMessage(finalJid, text);
  }

  let sent;
  try {
    sent = await sock.sendMessage(finalJid, { text });
  } catch (sendErr) {
    throw new Error(`BAILEYS_TRANSMISSION_ERROR: ${sendErr.message}`);
  }

  if (!sent || !sent.key || !sent.key.id) {
    throw new Error('BAILEYS_EMPTY_CONFIRMATION: Baileys não retornou confirmação de entrega válida (key.id ausente).');
  }

  try {
    db.prepare('INSERT OR IGNORE INTO processed_messages (id, sender_jid) VALUES (?, ?)').run(
      sent.key.id,
      finalJid
    );
  } catch (_) {}

  return {
    success: true,
    sent: true,
    simulated: false,
    isSimulated: false,
    blocked: false,
    accepted: true,
    messageId: sent.key.id,
    timestamp: sent.messageTimestamp ? Number(sent.messageTimestamp) : nowTs,
    recipientJid: finalJid,
    rawSent: sent,
  };
}

/**
 * Hook de injeção de mock para testes herméticos
 * @param {number} userId
 * @param {object} mockSock
 */
function _setSocketForTesting(userId, mockSock) {
  const uid = Number(userId);
  activeSessions.set(uid, {
    userId: uid,
    sock: mockSock,
    status: mockSock.user ? 'CONNECTED' : 'WAITING_QR',
    qrCode: null,
    pairingCode: null,
    pairingExpiresAt: null,
    connectedPhone: mockSock.user ? phoneUtils.cleanDigits(mockSock.user.id.split('@')[0]) : null,
    lastConnectedAt: mockSock.user ? new Date().toISOString() : null,
    lastError: null,
    pairingMethod: 'QR',
  });
}

/**
 * Hook de limpeza para testes herméticos
 */
function _resetForTesting() {
  activeSessions.clear();
  connectionLocks.clear();
}

/**
 * Hook para alterar o diretório base de sessões durante testes
 * @param {string} dir
 */
function _setBaseDirForTesting(dir) {
  SESSIONS_ROOT = dir;
}

module.exports = {
  getSessionStatus,
  startQrSession,
  requestPairingCode,
  disconnect,
  sendSalonMessage,
  getSalonSessionDir,
  validateBrazilianPhoneForPairing,
  _setSocketForTesting,
  _resetForTesting,
  _setBaseDirForTesting,
};
