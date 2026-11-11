/**
 * RAIA AGENTES — GERENCIADOR MULTI-SESSÃO WHATSAPP BAILEYS (MÓDULO JÉSSICA)
 *
 * Cada salão autenticado possui sua própria instância isolada de socket em memória
 * e credenciais no filesystem dentro de data/sessions/salon_<userId>/.
 *
 * Suporta conexão via QR Code dinâmico em memória e Código de Pareamento de 8 dígitos.
 * Em conformidade estrita com a Matriz RAIA-27 (OWASP ASVS 5.0) e Hard Staging Lock.
 *
 * CORREÇÕES DO COMANDO 028:
 * 1. Zero Fallback Global: Envio exclusivo pelo socket do salão; falha estrita (fail-closed) se offline.
 * 2. Roteamento Segregado: Mensagens recebidas no socket do salão despachadas para salonIncomingDispatcher.js.
 * 3. Restauração Automática: restoreActiveSalonSessions() reidrata sessões válidas no startup.
 * 4. Pareamento Seguro: Aguarda prontidão do socket antes de chamar requestPairingCode com mutex unificado.
 * 5. Efemeridade Total: QR Code e Pairing Code mantidos 100% em memória (RAM com TTL), nunca no SQLite.
 *
 * @module whatsapp/salonSessionManager
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../database/db');
const SalonWhatsAppRepository = require('../database/salonWhatsAppRepository');
const phoneUtils = require('../utils/phoneUtils');
const clientModule = require('./client');
const salonIncomingDispatcher = require('./salonIncomingDispatcher');

// Raiz padrão das credenciais persistentes
let SESSIONS_ROOT = path.resolve(__dirname, '../../data/sessions');

// Mapa em memória de sessões ativas: userId => SessionInstance
const activeSessions = new Map();

// Mutex unificado por tenant para serializar operações de conexão/desconexão: userId => Promise
const tenantLocks = new Map();

// Hooks herméticos para injeção de dependências em testes automatizados
let _socketFactoryForTesting = null;
let _qrInitTimeoutMs = 25000;

// Telemetria sanitizada de diagnóstico de conexão: userId => Array<{ timestamp: string, event: string, details?: object }>
const salonDiagnostics = new Map();
const MAX_DIAGNOSTIC_EVENTS = 30;

/**
 * Registra evento de diagnóstico sanitizado em memória (sem segredos, tokens ou dados desmascarados).
 * @param {number} userId
 * @param {string} event
 * @param {object} [details]
 */
function recordDiagnosticEvent(userId, event, details = {}) {
  const uid = Number(userId);
  if (!salonDiagnostics.has(uid)) {
    salonDiagnostics.set(uid, []);
  }
  const events = salonDiagnostics.get(uid);
  events.push({
    timestamp: new Date().toISOString(),
    event,
    details,
  });
  if (events.length > MAX_DIAGNOSTIC_EVENTS) {
    events.shift();
  }
}

/**
 * Inspeciona o diretório de credenciais persistentes do salão sem modificar arquivos (Comando 034).
 * @param {number} userId
 * @returns {object} Metadados sanitizados da pasta de autenticação
 */
function inspectSalonAuthCredentials(userId) {
  const uid = Number(userId);
  if (!uid || isNaN(uid) || uid <= 0) {
    return {
      exists: false,
      hasCreds: false,
      credsValid: false,
      credsMe: null,
      filesCount: 0,
      keyFilesCount: 0,
    };
  }
  const sessionDir = path.resolve(SESSIONS_ROOT, `salon_${uid}`);
  if (!fs.existsSync(sessionDir)) {
    return {
      exists: false,
      hasCreds: false,
      credsValid: false,
      credsMe: null,
      filesCount: 0,
      keyFilesCount: 0,
    };
  }
  try {
    const files = fs.readdirSync(sessionDir);
    const hasCreds = files.includes('creds.json');
    let credsValid = false;
    let credsMe = null;
    if (hasCreds) {
      try {
        const raw = fs.readFileSync(path.join(sessionDir, 'creds.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const isRegistered = Boolean(parsed && typeof parsed === 'object' && parsed.registered === true);
        const hasMeId = Boolean(parsed?.me?.id);
        credsValid = Boolean(isRegistered && hasMeId);
        if (parsed?.me?.id) {
          credsMe = phoneUtils.maskPhoneNumber(parsed.me.id.split('@')[0].split(':')[0]);
        }
      } catch (_) {}
    }
    return {
      exists: true,
      hasCreds,
      credsValid,
      credsMe,
      filesCount: files.length,
      keyFilesCount: files.filter((f) => f.endsWith('.json')).length,
    };
  } catch (err) {
    return {
      exists: true,
      hasCreds: false,
      credsValid: false,
      credsMe: null,
      filesCount: 0,
      keyFilesCount: 0,
      error: 'FS_READ_ERROR',
    };
  }
}

/**
 * Retorna telemetria sanitizada do salão para diagnóstico operacional seguro.
 * @param {number} userId
 * @returns {object}
 */
function getSalonDiagnostics(userId) {
  const uid = Number(userId);
  const session = activeSessions.get(uid);
  const repo = SalonWhatsAppRepository.getSessionByUserId(uid);
  const events = salonDiagnostics.get(uid) || [];
  const credentialsAudit = inspectSalonAuthCredentials(uid);

  return {
    userId: uid,
    status: session ? session.status : (repo ? repo.session_status : 'DISCONNECTED'),
    pairingMethod: session ? session.pairingMethod : (repo ? repo.pairing_method : null),
    hasSocket: Boolean(session && session.sock),
    qrActive: Boolean(session && session.qrCode && session.qrExpiresAt > Date.now()),
    qrVersion: session?.qrVersion || 0,
    qrExpiresInMs: session?.qrExpiresAt ? Math.max(0, session.qrExpiresAt - Date.now()) : 0,
    pairingActive: Boolean(session && session.pairingCode && session.pairingExpiresAt > Date.now()),
    connectedPhone: session?.connectedPhone ? phoneUtils.maskPhoneNumber(session.connectedPhone) : (repo?.connected_phone ? phoneUtils.maskPhoneNumber(repo.connected_phone) : null),
    environment: {
      isHomologacao: process.env.HOMOLOGACAO === 'true',
      allowSalonWhatsAppTesting: process.env.ALLOW_SALON_WHATSAPP_TESTING === 'true',
      isTenantAllowed: (process.env.SALON_TEST_ALLOWED_TENANTS || '').split(',').map((s) => s.trim()).includes(String(uid)),
    },
    credentialsAudit,
    recentEvents: events.slice(-20),
  };
}

/**
 * Verifica autorização com Triplo Bloqueio Fail-Closed para Staging (Proteções 11 e 12)
 *
 * Bloqueio 1: Kill-Switch ALLOW_SALON_WHATSAPP_TESTING === 'true'
 * Bloqueio 2: SALON_TEST_ALLOWED_TENANTS obrigatoriamente contém o userId
 * Bloqueio 3: SALON_TEST_ALLOWED_PHONES obrigatoriamente contém o telefone do salão/teste
 *
 * Se QUALQUER um dos três falhar em staging/homologação, o retorno é false (caindo estritamente em mock simulado).
 * Em produção explícita, respeita clientModule.isRealWhatsAppTransportAllowed().
 *
 * @param {number} userId
 * @param {string|null} [candidatePhone=null]
 * @returns {boolean}
 */
function isSalonRealWhatsAppAllowed(userId, candidatePhone = null) {
  if (clientModule.isRealWhatsAppTransportAllowed()) {
    return true; // Produção explícita
  }

  const isHomologacao = process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging' || process.env.APP_MODE === 'homologacao';

  // Bloqueio 1 / Kill-Switch Atômico
  if (!isHomologacao || process.env.ALLOW_SALON_WHATSAPP_TESTING !== 'true') {
    return false;
  }

  const uid = Number(userId);
  if (!uid || isNaN(uid) || uid <= 0) {
    return false;
  }

  // Bloqueio 2: Tenant Whitelist Obrigatória
  const rawAllowedTenants = process.env.SALON_TEST_ALLOWED_TENANTS || '';
  const allowedTenants = rawAllowedTenants
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (!allowedTenants.includes(String(uid))) {
    return false;
  }

  // Bloqueio 3: Phone Whitelist Obrigatória
  const rawAllowedPhones = process.env.SALON_TEST_ALLOWED_PHONES || '';
  const allowedPhones = rawAllowedPhones
    .split(',')
    .map((p) => phoneUtils.cleanDigits(p))
    .filter(Boolean);

  if (allowedPhones.length === 0) {
    return false; // Fail-closed: se a lista de telefones não estiver preenchida, bloqueia conexões reais
  }

  // Se candidatePhone foi informado (ex: Pareamento por Código), valida imediatamente contra a whitelist
  if (candidatePhone) {
    const phoneToVerify = phoneUtils.cleanDigits(candidatePhone);
    return allowedPhones.some((ap) => {
      return ap === phoneToVerify;
    });
  }

  // Se candidatePhone for null (ex: Início de sessão para emissão de QR Code):
  // O aparelho do usuário ainda é desconhecido neste momento inicial.
  // Permite iniciar a emissão do QR real do Baileys para o tenant autorizado em staging.
  // A validação estrita fail-closed do telefone é executada no evento 'connection === open'
  // assim que o Baileys decodificar o JID do aparelho conectado.
  return true;
}

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
 * Aguarda a prontidão operacional do socket antes de requisitar emparelhamento
 * Previne race conditions no handshake WebSocket/Noise
 *
 * @private
 * @param {object} sock
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<void>}
 */
function waitForSocketReady(sock, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('SOCKET_NOT_READY_TIMEOUT: O socket WhatsApp não inicializou a tempo para pareamento.'));
      }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      if (sock?.ev?.off) {
        sock.ev.off('connection.update', onUpdate);
      }
    }

    function onUpdate(update) {
      const { connection, lastDisconnect, qr } = update || {};
      if (qr || connection === 'connecting') {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve();
        }
      } else if (connection === 'close') {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`SOCKET_CLOSED_BEFORE_PAIRING: ${lastDisconnect?.error?.message || 'Conexão fechada precocemente.'}`));
        }
      }
    }

    sock.ev.on('connection.update', onUpdate);
  });
}

/**
 * Retorna o status de conexão atual do salão.
 * CORREÇÃO 5: Limpeza ativa de segredos expirados em memória.
 *
 * @param {number} userId
 * @returns {object}
 */
function getSessionStatus(userId) {
  const uid = Number(userId);
  const memSession = activeSessions.get(uid);

  if (memSession) {
    const now = Date.now();

    // Expiração ativa do código de pareamento em memória
    if (memSession.pairingExpiresAt && memSession.pairingExpiresAt < now) {
      memSession.pairingCode = null;
      memSession.pairingExpiresAt = null;
    }

    // Expiração ativa do QR Code em memória
    if (memSession.qrExpiresAt && memSession.qrExpiresAt < now) {
      memSession.qrCode = null;
      memSession.qrExpiresAt = null;
    }

    const hasPairing = Boolean(memSession.pairingCode);
    const hasQr = Boolean(memSession.qrCode);

    return {
      status: memSession.status,
      connectedPhone: memSession.connectedPhone ? phoneUtils.maskPhoneNumber(memSession.connectedPhone) : null,
      lastConnectedAt: memSession.lastConnectedAt || null,
      lastError: memSession.lastError || null,
      pairingMethod: memSession.pairingMethod || null,
      hasQr,
      qrCode: memSession.qrCode || null,
      qrVersion: memSession.qrVersion || 0,
      hasPairingCode: hasPairing,
      pairingCode: memSession.pairingCode || null,
      pairingExpiresAt: memSession.pairingExpiresAt || null,
      simulated: Boolean(memSession.simulated),
    };
  }

  // Consulta no repositório persistido (garantido sem segredos no SQLite)
  const repoSession = SalonWhatsAppRepository.getSessionByUserId(uid);
  if (repoSession) {
    return {
      status: repoSession.session_status || 'DISCONNECTED',
      connectedPhone: repoSession.connected_phone ? phoneUtils.maskPhoneNumber(repoSession.connected_phone) : null,
      lastConnectedAt: repoSession.connected_at || null,
      lastError: repoSession.last_error || null,
      pairingMethod: repoSession.pairing_method || null,
      hasQr: false,
      qrCode: null,
      qrVersion: 0,
      hasPairingCode: false,
      pairingCode: null,
      pairingExpiresAt: null,
      simulated: false,
    };
  }

  return {
    status: 'DISCONNECTED',
    connectedPhone: null,
    lastConnectedAt: null,
    lastError: null,
    pairingMethod: null,
    hasQr: false,
    qrCode: null,
    qrVersion: 0,
    hasPairingCode: false,
    pairingCode: null,
    pairingExpiresAt: null,
    simulated: false,
  };
}

/**
 * Criação centralizada do socket Baileys com configuração unificada
 * Reutilizada por startQrSession, requestPairingCode e restoreActiveSalonSessions.
 *
 * @private
 * @param {number} uid
 * @param {string} sessionDir
 * @param {object} session
 * @returns {Promise<{ sock: object, saveCreds: Function }>}
 */
async function _createBaileysSocket(uid, sessionDir, session) {
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  session.socketGen = (session.socketGen || 0) + 1;
  const currentGen = session.socketGen;

  const isSessionAborted = () => {
    return activeSessions.get(uid) !== session || session.socketGen !== currentGen || session.status === 'DISCONNECTED' || session.isCancelled;
  };

  if (_socketFactoryForTesting) {
    const sock = await _socketFactoryForTesting(uid, sessionDir, session);
    if (isSessionAborted()) {
      if (sock && typeof sock.end === 'function') {
        try { sock.end(undefined); } catch (_) {}
      }
      throw new Error('SESSION_CANCELLED_OR_SUPERSEDED: Sessão invalidada durante inicialização de testes.');
    }
    session.sock = sock;
    _attachSocketListeners(uid, sock, session, () => {}, currentGen);
    return { sock, saveCreds: () => {}, currentGen };
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  if (isSessionAborted()) {
    throw new Error('SESSION_CANCELLED_OR_SUPERSEDED: Sessão invalidada durante leitura de auth state.');
  }

  const { version } = await fetchLatestBaileysVersion();
  if (isSessionAborted()) {
    throw new Error('SESSION_CANCELLED_OR_SUPERSEDED: Sessão invalidada durante obtenção de versão do Baileys.');
  }

  recordDiagnosticEvent(uid, 'SOCKET_INIT', {
    method: session.pairingMethod || 'QR',
    browser: 'macOS Desktop (14.4.1)',
    baileysVersion: Array.isArray(version) ? version.join('.') : '7.0.0-rc14',
  });

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: Browsers.macOS('Desktop'),
    generateHighQualityLinkPreview: false,
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  if (isSessionAborted()) {
    if (sock && typeof sock.end === 'function') {
      try { sock.end(undefined); } catch (_) {}
    }
    throw new Error('SESSION_CANCELLED_OR_SUPERSEDED: Sessão invalidada durante criação do socket.');
  }

  session.sock = sock;
  _attachSocketListeners(uid, sock, session, saveCreds, currentGen);

  return { sock, saveCreds, currentGen };
}

/**
 * Executa reconexão controlada do socket preservando credenciais salvas em disco.
 *
 * @private
 * @param {number} uid
 * @param {object} session
 * @param {number} [delayMs=500]
 */
async function _reconnectSalonSocket(uid, session, delayMs = 500) {
  if (activeSessions.get(uid) !== session || session.status === 'DISCONNECTED') return;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  if (session.sock) {
    try { session.sock.end(undefined); } catch (_) {}
    session.sock = null;
  }

  session.reconnecting = true;
  session.status = 'CONNECTING';

  if (delayMs > 0) {
    await new Promise((resolve) => {
      session.reconnectTimer = setTimeout(() => {
        session.reconnectTimer = null;
        resolve();
      }, delayMs);
    });
  }

  if (activeSessions.get(uid) !== session || session.status === 'DISCONNECTED') return;

  try {
    const sessionDir = getSalonSessionDir(uid);
    await _createBaileysSocket(uid, sessionDir, session);
    session.reconnecting = false;
  } catch (err) {
    session.reconnecting = false;
    session.status = 'CONNECTION_LOST';
    session.lastError = `Falha na reconexão: ${err.message}`;
    recordDiagnosticEvent(uid, 'RECONNECT_ERROR', { error: err.message });
  }
}

/**
 * Registra listeners comuns do socket Baileys do salão
 * CORREÇÃO 2: Roteamento de mensagens de entrada para salonIncomingDispatcher.js
 * CORREÇÃO 5: Queima imediata de QR Code e Pairing Code ao conectar
 *
 * @private
 * @param {number} uid
 * @param {object} sock
 * @param {object} session
 * @param {Function} saveCreds
 */
function _attachSocketListeners(uid, sock, session, saveCreds, currentGen) {
  const isSocketStale = () => session.socketGen !== currentGen || activeSessions.get(uid) !== session || session.status === 'DISCONNECTED';

  sock.ev.on('creds.update', async (...args) => {
    if (isSocketStale()) return;
    try {
      await saveCreds(...args);
    } catch (saveErr) {
      console.error(`[salonSessionManager] Erro ao salvar credenciais Baileys #${uid}:`, saveErr.message);
    }
  });

  // CORREÇÃO 2: Mensagens recebidas no WhatsApp comercial do salão
  sock.ev.on('messages.upsert', async (m) => {
    if (isSocketStale()) return;
    try {
      // Guarda de segurança: apenas despacha se a sessão estiver formalmente conectada
      if (session.status !== 'CONNECTED') return;

      if (m.type === 'notify' && Array.isArray(m.messages)) {
        for (const msg of m.messages) {
          if (!msg.message || !msg.key?.remoteJid || msg.key.fromMe) continue;
          await salonIncomingDispatcher.dispatchMessage(uid, sock, msg);
        }
      }
    } catch (err) {
      console.error(`[salonSessionManager] Erro no despachante da Jéssica #${uid}:`, err.message);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    if (isSocketStale()) return;

    try {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (session.pairingMethod === 'CODE') {
          return; // Preserva WAITING_CODE e ignora QR quando o método for CODE
        }
        try {
          const isFirstQr = (session.qrVersion || 0) === 0;
          const qrTtlMs = isFirstQr ? 65000 : 25000;

          const qrDataUrl = await QRCode.toDataURL(qr, {
            margin: 4,
            width: 320,
            errorCorrectionLevel: 'M',
            color: { dark: '#000000', light: '#FFFFFF' },
          });

          // Defesa contra corrida: descarta se a sessão foi cancelada durante a geração do DataURL
          if (isSocketStale()) return;

          session.qrCode = qrDataUrl;
          session.qrExpiresAt = Date.now() + qrTtlMs;
          session.qrVersion = (session.qrVersion || 0) + 1;
          session.status = 'WAITING_QR';

          if (typeof session.onQrReady === 'function') {
            try { session.onQrReady(qrDataUrl); } catch (_) {}
          }

          recordDiagnosticEvent(uid, session.qrVersion === 1 ? 'QR_RECEIVED' : 'QR_ROTATED', {
            version: session.qrVersion,
            expiresInMs: qrTtlMs,
          });

          // Atualiza banco sem persistir imagem bruta
          SalonWhatsAppRepository.updateQrCode(uid, null, Math.round(qrTtlMs / 1000));

          SalonWhatsAppRepository.createLog(uid, {
            eventType: 'QR_GENERATED',
            newStatus: 'WAITING_QR',
            pairingMethod: 'QR',
          });
        } catch (err) {
          session.lastError = 'Falha ao codificar imagem do QR Code.';
          recordDiagnosticEvent(uid, 'QR_ERROR', { error: 'Falha ao codificar imagem do QR Code' });
        }
      }

      if (connection === 'open') {
        const jid = sock.user?.id || '';
        const cleanPhone = phoneUtils.cleanDigits(jid.split('@')[0].split(':')[0]);

        // Staging Hard Lock: Validação imediata pós-scan do aparelho conectado (Proteções 11 e 12)
        if (!clientModule.isRealWhatsAppTransportAllowed()) {
          const isAllowed = isSalonRealWhatsAppAllowed(uid, cleanPhone);
          if (!isAllowed) {
            console.warn(`[salonSessionManager] SEGURANÇA: Conexão rejeitada para tenant #${uid}. Telefone ${phoneUtils.maskPhoneNumber(cleanPhone)} não consta em SALON_TEST_ALLOWED_PHONES.`);
            recordDiagnosticEvent(uid, 'PHONE_VALIDATION', {
              authorized: false,
              maskedPhone: phoneUtils.maskPhoneNumber(cleanPhone),
            });
            try { await sock.logout(); } catch (_) {}
            try { sock.end(undefined); } catch (_) {}
            try {
              const sDir = getSalonSessionDir(uid);
              if (fs.existsSync(sDir)) fs.rmSync(sDir, { recursive: true, force: true });
            } catch (_) {}
            session.sock = null;
            session.status = 'DISCONNECTED';
            session.connectedPhone = null;
            session.lastError = 'Telefone não autorizado no ambiente de homologação.';
            session.qrCode = null;
            session.pairingCode = null;

            SalonWhatsAppRepository.markSessionDisconnected(uid, {
              status: 'DISCONNECTED',
              error: session.lastError,
              resetCredentials: true,
            });

            SalonWhatsAppRepository.createLog(uid, {
              eventType: 'AUTH_FAILURE',
              newStatus: 'DISCONNECTED',
              reason: `Tentativa de conexão não autorizada com telefone: ${phoneUtils.maskPhoneNumber(cleanPhone)}`,
            });
            return; // Aborta antes de prosseguir
          }
        }

        recordDiagnosticEvent(uid, 'PHONE_VALIDATION', {
          authorized: true,
          maskedPhone: phoneUtils.maskPhoneNumber(cleanPhone),
        });
        recordDiagnosticEvent(uid, 'WS_OPEN', {
          maskedPhone: phoneUtils.maskPhoneNumber(cleanPhone),
        });

        session.status = 'CONNECTED';
        session.connectedPhone = cleanPhone;
        session.lastConnectedAt = new Date().toISOString();
        session.lastError = null;
        session.retryCount = 0;
        session.reconnecting = false;

        // CORREÇÃO 5: Queima imediata de segredos efêmeros ao conectar
        session.qrCode = null;
        session.qrExpiresAt = null;
        session.pairingCode = null;
        session.pairingExpiresAt = null;

        SalonWhatsAppRepository.markSessionConnected(uid, {
          phone: cleanPhone,
          phoneJid: `${cleanPhone}@s.whatsapp.net`,
          pairingMethod: session.pairingMethod || 'QR',
        });

        SalonWhatsAppRepository.createLog(uid, {
          eventType: 'CONNECTED',
          newStatus: 'CONNECTED',
          pairingMethod: session.pairingMethod || 'QR',
          connectedPhone: cleanPhone,
          reason: 'WhatsApp comercial do salão conectado com sucesso.',
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;

        // Limpa segredos em memória e desvincula socket fechado
        session.qrCode = null;
        session.pairingCode = null;
        session.sock = null;

        const authAudit = inspectSalonAuthCredentials(uid);

        recordDiagnosticEvent(uid, 'WS_CLOSED', {
          statusCode: statusCode || null,
          reason: lastDisconnect?.error?.message ? String(lastDisconnect.error.message).slice(0, 100) : 'Closed',
          isLoggedOut,
          isRestartRequired,
          hasCreds: authAudit.hasCreds,
          credsValid: authAudit.credsValid,
        });

        // Apenas 401 (loggedOut explícito) expurga credenciais e desconecta formalmente
        if (isLoggedOut) {
          await disconnect(uid);
          return;
        }

        if (isRestartRequired) {
          recordDiagnosticEvent(uid, 'RESTART_REQUIRED', { statusCode });
          await _reconnectSalonSocket(uid, session, 500);
          return;
        }

        // Se statusCode === 500 ou erro de infraestrutura / rede / timeout:
        // se credenciais existirem e forem válidas (ou se a sessão estava CONECTADA),
        // preserva-as e efetua reconexão controlada com backoff exponencial.
        const wasConnectedOrHasCreds = session.status === 'CONNECTED' || (authAudit.exists && authAudit.hasCreds && authAudit.credsValid);

        if (wasConnectedOrHasCreds) {
          session.retryCount = (session.retryCount || 0) + 1;
          const maxRetries = 5;

          if (session.retryCount <= maxRetries) {
            session.reconnecting = true;
            session.status = 'CONNECTION_LOST';
            const backoffDelay = Math.min(24000, 1500 * Math.pow(2, session.retryCount - 1)); // 1.5s, 3s, 6s, 12s, 24s

            recordDiagnosticEvent(uid, 'RECONNECT_ATTEMPT', {
              attempt: session.retryCount,
              maxRetries,
              delayMs: backoffDelay,
            });

            await _reconnectSalonSocket(uid, session, backoffDelay);
            return;
          }

          // Excedeu tentativas
          session.reconnecting = false;
          session.status = 'CONNECTION_LOST';
          session.lastError = 'Limite de tentativas de reconexão excedido.';
          SalonWhatsAppRepository.markSessionDisconnected(uid, {
            status: 'CONNECTION_LOST',
            error: session.lastError,
          });
          SalonWhatsAppRepository.createLog(uid, {
            eventType: 'DISCONNECTED',
            newStatus: 'CONNECTION_LOST',
            reason: session.lastError,
          });
        } else {
          // Estava em WAITING_QR, WAITING_CODE ou sem credenciais registradas válidas e fechou por timeout/interrupção
          session.reconnecting = false;
          session.status = 'DISCONNECTED';
          session.lastError = 'QR Code expirado ou conexão fechada antes da leitura (QR_EXPIRED)';
          SalonWhatsAppRepository.markSessionDisconnected(uid, {
            status: 'DISCONNECTED',
            error: session.lastError,
          });

          SalonWhatsAppRepository.createLog(uid, {
            eventType: 'DISCONNECTED',
            oldStatus: session.pairingMethod === 'CODE' ? 'WAITING_CODE' : 'WAITING_QR',
            newStatus: 'DISCONNECTED',
            reason: session.lastError,
            metadata: { reasonCode: 'QR_EXPIRED' },
          });
        }
      }
    } catch (unhandledErr) {
      console.error(`[salonSessionManager] Exceção não tratada no connection.update #${uid}:`, unhandledErr.message);
      recordDiagnosticEvent(uid, 'LISTENER_UNHANDLED_ERROR', { error: unhandledErr.message });
    }
  });
}

/**
 * Inicializa ou recupera a sessão QR Code do salão
 *
 * @param {number} userId
 * @returns {Promise<{ success: boolean, qrCode: string|null, status: string, connectedPhone?: string }>}
 */
async function startQrSession(userId) {
  const uid = Number(userId);

  // Mutex unificado por tenant (CORREÇÃO 4)
  if (tenantLocks.has(uid)) {
    return tenantLocks.get(uid);
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

    // Se já existe sessão WAITING_QR ativa com QR Code válido dentro do TTL, reaproveita sem reiniciar socket
    if (
      session &&
      session.status === 'WAITING_QR' &&
      session.qrCode &&
      session.qrExpiresAt &&
      session.qrExpiresAt > Date.now()
    ) {
      return {
        success: true,
        qrCode: session.qrCode,
        status: 'WAITING_QR',
      };
    }

    const sessionDir = getSalonSessionDir(uid);
    SalonWhatsAppRepository.ensureSessionExists(uid, `data/sessions/salon_${uid}`);

    // Hard Staging Lock com Whitelist Granular Cirúrgica
    const isRealAllowed = isSalonRealWhatsAppAllowed(uid);
    if (!isRealAllowed) {
      const simQrDataUrl = await QRCode.toDataURL(`RAIA_HOMOLOGACAO_SALON_${uid}_MOCK_QR_${Date.now()}`, {
        margin: 4,
        width: 320,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#FFFFFF' },
      });

      session = {
        userId: uid,
        sock: null,
        status: 'WAITING_QR',
        qrCode: simQrDataUrl,
        qrExpiresAt: Date.now() + 25000,
        qrVersion: 1,
        pairingCode: null,
        pairingExpiresAt: null,
        connectedPhone: null,
        lastConnectedAt: null,
        lastError: null,
        pairingMethod: 'QR',
        simulated: true,
      };
      activeSessions.set(uid, session);

      recordDiagnosticEvent(uid, 'QR_SIMULATED', { version: 1, expiresInMs: 25000 });

      // Banco recebe NULL para dados brutos do QR Code (CORREÇÃO 5)
      SalonWhatsAppRepository.updateQrCode(uid, null, 25);

      SalonWhatsAppRepository.createLog(uid, {
        eventType: 'QR_GENERATED',
        newStatus: 'WAITING_QR',
        pairingMethod: 'QR',
        reason: 'QR Code de homologação gerado com sucesso.',
      });

      return { success: true, qrCode: simQrDataUrl, status: 'WAITING_QR', simulated: true };
    }

    // Modo Real Baileys: encerra socket prévio pendente
    if (session && session.sock) {
      try { session.sock.end(undefined); } catch (_) {}
      session.sock = null;
    }

    session = {
      userId: uid,
      sock: null,
      status: 'CONNECTING',
      qrCode: null,
      qrExpiresAt: null,
      qrVersion: 0,
      pairingCode: null,
      pairingExpiresAt: null,
      connectedPhone: null,
      lastConnectedAt: null,
      lastError: null,
      pairingMethod: 'QR',
      simulated: false,
    };
    activeSessions.set(uid, session);

    const { sock, currentGen } = await _createBaileysSocket(uid, sessionDir, session);

    // Se o QR Code já foi gerado e convertido durante a inicialização do socket, retorna de imediato
    if (session.qrCode) {
      return {
        success: true,
        qrCode: session.qrCode,
        status: session.status || 'WAITING_QR',
        simulated: false,
      };
    }

    return new Promise((resolve) => {
      let resolved = false;

      function cleanup() {
        clearTimeout(initialTimeout);
        session.onQrReady = null;
        if (sock?.ev?.off) {
          sock.ev.off('connection.update', onInitUpdate);
        }
      }

      session.onQrReady = (qrDataUrl) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({
            success: true,
            qrCode: qrDataUrl,
            status: session.status || 'WAITING_QR',
            simulated: false,
          });
        }
      };

      const initialTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          // B1: Não encerra nem cancela o socket se ainda estiver em CONNECTING
          resolve({
            success: true,
            status: session.status || 'CONNECTING',
            qrCode: session.qrCode || null,
            simulated: false,
          });
        }
      }, _qrInitTimeoutMs);

      function onInitUpdate(update) {
        if (session.socketGen !== currentGen || activeSessions.get(uid) !== session || session.status === 'DISCONNECTED') {
          cleanup();
          return;
        }
        const { connection } = update;
        if (session.qrCode && !resolved) {
          resolved = true;
          cleanup();
          resolve({ success: true, qrCode: session.qrCode, status: session.status || 'WAITING_QR', simulated: false });
          return;
        }
        if (connection === 'open' && !resolved) {
          resolved = true;
          cleanup();
          resolve({
            success: true,
            status: 'CONNECTED',
            qrCode: null,
            connectedPhone: session.connectedPhone ? phoneUtils.maskPhoneNumber(session.connectedPhone) : null,
            simulated: false,
          });
        }
      }

      sock.ev.on('connection.update', onInitUpdate);
    });
  })();

  tenantLocks.set(uid, connectPromise);
  try {
    return await connectPromise;
  } finally {
    if (tenantLocks.get(uid) === connectPromise) {
      tenantLocks.delete(uid);
    }
  }
}

/**
 * Solicita Código de Pareamento de 8 dígitos para o número informado.
 * CORREÇÃO 4: Aguarda prontidão do socket antes de chamar requestPairingCode.
 * CORREÇÃO 5: Código mantido estritamente em memória com TTL.
 *
 * @param {number} userId
 * @param {string} rawPhone
 * @returns {Promise<{ success: boolean, pairingCode: string, expiresAt: number, status: string }>}
 */
async function requestPairingCode(userId, rawPhone) {
  const uid = Number(userId);
  const formattedPhone = validateBrazilianPhoneForPairing(rawPhone);

  // Idempotência: se já existe um código ativo e válido em memória para este tenant, reutiliza (Comando 033)
  const existingSession = activeSessions.get(uid);
  if (
    existingSession &&
    existingSession.status === 'WAITING_CODE' &&
    existingSession.pairingCode &&
    existingSession.pairingExpiresAt > Date.now() &&
    (!existingSession.connectedPhone || existingSession.connectedPhone === formattedPhone)
  ) {
    return {
      success: true,
      pairingCode: existingSession.pairingCode,
      expiresAt: existingSession.pairingExpiresAt,
      status: 'WAITING_CODE',
    };
  }

  // Mutex unificado por tenant (CORREÇÃO 4)
  if (tenantLocks.has(uid)) {
    return tenantLocks.get(uid);
  }

  const pairingPromise = (async () => {
    const sessionDir = getSalonSessionDir(uid);
    SalonWhatsAppRepository.ensureSessionExists(uid, `data/sessions/salon_${uid}`);

    // Hard Staging Lock com Whitelist Granular Cirúrgica
    const isRealAllowed = isSalonRealWhatsAppAllowed(uid, formattedPhone);
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
        qrExpiresAt: null,
        pairingCode: simCode,
        pairingExpiresAt: expiresAt,
        connectedPhone: null,
        lastConnectedAt: null,
        lastError: null,
        pairingMethod: 'CODE',
        simulated: true,
      };
      activeSessions.set(uid, session);

      // Banco recebe NULL para segredo bruto (CORREÇÃO 5)
      SalonWhatsAppRepository.updatePairingCode(uid, null, 180);

      SalonWhatsAppRepository.createLog(uid, {
        eventType: 'PAIRING_CODE_REQUESTED',
        newStatus: 'WAITING_CODE',
        pairingMethod: 'CODE',
        connectedPhone: formattedPhone,
        reason: 'Código de pareamento simulado gerado em ambiente de homologação.',
      });

      return { success: true, pairingCode: simCode, expiresAt, status: 'WAITING_CODE', simulated: true };
    }

    // Modo Real Baileys: encerra socket prévio se houver
    const prevSession = activeSessions.get(uid);
    if (prevSession && prevSession.sock) {
      try { prevSession.sock.end(undefined); } catch (_) {}
      prevSession.sock = null;
    }

    const session = {
      userId: uid,
      sock: null,
      status: 'WAITING_CODE',
      qrCode: null,
      qrExpiresAt: null,
      pairingCode: null,
      pairingExpiresAt: null,
      connectedPhone: null,
      lastConnectedAt: null,
      lastError: null,
      pairingMethod: 'CODE',
      simulated: false,
    };
    activeSessions.set(uid, session);

    const { sock } = await _createBaileysSocket(uid, sessionDir, session);

    let formattedCode;
    let expiresAt;
    try {
      // CORREÇÃO 4: Aguarda prontidão do socket antes de solicitar código de pareamento
      await waitForSocketReady(sock, 15000);

      const rawPairingCode = await sock.requestPairingCode(formattedPhone);
      formattedCode = rawPairingCode && rawPairingCode.length === 8
        ? `${rawPairingCode.slice(0, 4)}-${rawPairingCode.slice(4)}`
        : rawPairingCode;

      expiresAt = Date.now() + 180000; // 3 minutos

      session.pairingCode = formattedCode;
      session.pairingExpiresAt = expiresAt;

      // Atualiza SQLite sem gravar código bruto (CORREÇÃO 5)
      SalonWhatsAppRepository.updatePairingCode(uid, null, 180);

      SalonWhatsAppRepository.createLog(uid, {
        eventType: 'PAIRING_CODE_REQUESTED',
        newStatus: 'WAITING_CODE',
        pairingMethod: 'CODE',
        connectedPhone: formattedPhone,
      });
    } catch (pairErr) {
      if (sock) {
        try { sock.end(undefined); } catch (_) {}
      }
      session.sock = null;
      session.status = 'DISCONNECTED';
      session.pairingCode = null;
      session.pairingExpiresAt = null;
      session.lastError = pairErr.message;
      recordDiagnosticEvent(uid, 'PAIRING_ERROR', { error: pairErr.message });
      throw pairErr;
    }

    return {
      success: true,
      pairingCode: formattedCode,
      expiresAt,
      status: 'WAITING_CODE',
      simulated: false,
    };
  })();

  tenantLocks.set(uid, pairingPromise);
  try {
    return await pairingPromise;
  } finally {
    if (tenantLocks.get(uid) === pairingPromise) {
      tenantLocks.delete(uid);
    }
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

  if (session) {
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    session.socketGen = null;
    if (session.sock) {
      try { session.sock.end(undefined); } catch (_) {}
      session.sock = null;
    }
    session.status = 'DISCONNECTED';
  }

  activeSessions.delete(uid);
  recordDiagnosticEvent(uid, 'DISCONNECTED', { reason: 'Desconexão formal solicitada pelo usuário.' });

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
 * Cancela qualquer tentativa de pareamento em andamento (QR ou Código)
 * e redefine o status em memória para DISCONNECTED, sem afetar conexões ativas (CONNECTED).
 *
 * @param {number} userId
 * @returns {Promise<{ success: boolean, status: string, message?: string }>}
 */
async function cancelPendingPairing(userId) {
  const uid = Number(userId);
  if (!uid || isNaN(uid) || uid <= 0) {
    throw new Error('INVALID_TENANT_ID: Identificador de salão inválido.');
  }

  const session = activeSessions.get(uid);

  // Não cancela se já estiver conectado (exige disconnect formal)
  if (session && session.status === 'CONNECTED') {
    return {
      success: false,
      error: 'CANNOT_CANCEL_ACTIVE_CONNECTION',
      message: 'Sessão já está conectada. Utilize a desconexão formal para desvincular.',
      status: 'CONNECTED',
    };
  }

  if (session) {
    session.isCancelled = true;
    session.socketGen = (session.socketGen || 0) + 1;
    session.reconnecting = false;
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    if (session.sock) {
      try {
        session.sock.end(undefined);
      } catch (_) {}
      session.sock = null;
    }
    session.status = 'DISCONNECTED';
    session.qrCode = null;
    session.qrExpiresAt = null;
    session.pairingCode = null;
    session.pairingExpiresAt = null;
    session.lastError = null;
    session.pairingMethod = null;
    activeSessions.delete(uid);
  }

  // Libera locks pendentes se houver
  tenantLocks.delete(uid);
  recordDiagnosticEvent(uid, 'PAIRING_CANCELLED', { reason: 'Cancelado pelo usuário no painel.' });

  SalonWhatsAppRepository.markSessionDisconnected(uid, {
    status: 'DISCONNECTED',
    error: 'Tentativa de pareamento cancelada pelo usuário.',
  });

  SalonWhatsAppRepository.createLog(uid, {
    eventType: 'DISCONNECTED',
    newStatus: 'DISCONNECTED',
    reason: 'Cancelado pelo usuário no painel.',
  });

  return { success: true, status: 'DISCONNECTED' };
}

/**
 * CORREÇÃO 1: Despacha mensagem via sessão WhatsApp comercial conectada do salão.
 * Padrão Fail-Closed: NUNCA recorre ao WhatsApp global do sistema.
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

  // 1. Hard Staging Lock com Whitelist Granular Cirúrgica
  const cleanRecipientDigits = phoneUtils.cleanDigits(finalJid.split('@')[0]);
  const isRealAllowed = isSalonRealWhatsAppAllowed(uid, cleanRecipientDigits);
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

  // 2. Modo Real: Validação estrita de sessão conectada (FAIL-CLOSED: ZERO FALLBACK GLOBAL)
  const session = activeSessions.get(uid);
  if (!session || session.status !== 'CONNECTED' || !session.sock) {
    const err = new Error(`SALON_WHATSAPP_DISCONNECTED: WhatsApp do salão #${uid} não está conectado.`);
    err.code = 'SALON_WHATSAPP_DISCONNECTED';
    err.userId = uid;
    throw err;
  }

  const sock = session.sock;
  if (!sock.user || (sock.ws && sock.ws.readyState !== undefined && sock.ws.readyState !== 1)) {
    const err = new Error(`SALON_WHATSAPP_SOCKET_NOT_READY: Socket WhatsApp do salão #${uid} não está pronto para transmissão.`);
    err.code = 'SALON_WHATSAPP_SOCKET_NOT_READY';
    err.userId = uid;
    throw err;
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
 * CORREÇÃO 3: Restaura automaticamente as sessões ativas no boot do servidor.
 * Verifica a existência física das credenciais e evita duplicação de sockets.
 * Em staging/homologação, respeita o Hard Staging Lock e não abre conexões externas.
 *
 * @returns {Promise<{ restored: number, total: number, skippedStaging?: boolean }>}
 */
async function restoreActiveSalonSessions() {
  const isGlobalReal = clientModule.isRealWhatsAppTransportAllowed();
  const isStagingTesting = (process.env.HOMOLOGACAO === 'true' || process.env.APP_MODE === 'staging') && process.env.ALLOW_SALON_WHATSAPP_TESTING === 'true';

  if (!isGlobalReal && !isStagingTesting) {
    return { restored: 0, total: 0, skippedStaging: true };
  }

  const candidates = SalonWhatsAppRepository.getActiveSessionsForRestore({ limit: 100 });
  let restored = 0;

  for (const cand of candidates) {
    const uid = cand.user_id;

    // Em staging com flag cirúrgica, reidrata apenas os salões estritamente autorizados
    if (!isGlobalReal && !isSalonRealWhatsAppAllowed(uid, cand.connected_phone)) {
      continue;
    }

    // Evita duplicidade se a sessão já estiver instanciada
    if (activeSessions.has(uid)) {
      continue;
    }

    try {
      const sessionDir = getSalonSessionDir(uid);
      const credsFile = path.join(sessionDir, 'creds.json');

      if (!fs.existsSync(credsFile)) {
        // Credenciais ausentes em disco: marca desconectado
        SalonWhatsAppRepository.markSessionDisconnected(uid, {
          status: 'DISCONNECTED',
          error: 'Credenciais ausentes em disco após inicialização.',
          resetCredentials: false,
        });
        continue;
      }

      // Valida se o creds.json contém credenciais autenticadas e registradas
      try {
        const rawCreds = fs.readFileSync(credsFile, 'utf8');
        const parsedCreds = JSON.parse(rawCreds);
        if (!parsedCreds || parsedCreds.registered !== true || !parsedCreds.me?.id) {
          SalonWhatsAppRepository.markSessionDisconnected(uid, {
            status: 'DISCONNECTED',
            error: 'Credenciais incompletas ou não registradas.',
            resetCredentials: false,
          });
          continue;
        }
      } catch (_) {
        SalonWhatsAppRepository.markSessionDisconnected(uid, {
          status: 'CONNECTION_LOST',
          error: 'Arquivo de credenciais corrompido no disco.',
          resetCredentials: false,
        });
        continue;
      }

      const session = {
        userId: uid,
        sock: null,
        status: 'CONNECTING',
        qrCode: null,
        qrExpiresAt: null,
        pairingCode: null,
        pairingExpiresAt: null,
        connectedPhone: cand.connected_phone || null,
        lastConnectedAt: null,
        lastError: null,
        pairingMethod: cand.pairing_method || 'QR',
        simulated: false,
      };
      activeSessions.set(uid, session);

      await _createBaileysSocket(uid, sessionDir, session);
      restored++;
    } catch (err) {
      console.error(`[salonSessionManager] Erro ao restaurar sessão #${uid}:`, err.message);
      SalonWhatsAppRepository.markSessionDisconnected(uid, {
        status: 'CONNECTION_LOST',
        error: `Falha na restauração: ${err.message}`,
        resetCredentials: false,
      });
    }
  }

  return { restored, total: candidates.length };
}

/**
 * Hook de injeção de mock para testes herméticos
 * @param {number} userId
 * @param {object} mockSock
 */
function _setSocketForTesting(userId, mockSock, options = {}) {
  const uid = Number(userId);
  const session = {
    userId: uid,
    sock: mockSock,
    status: options.status || (mockSock?.user ? 'CONNECTED' : 'WAITING_QR'),
    qrCode: options.qrCode || null,
    qrExpiresAt: options.qrExpiresAt || null,
    qrVersion: options.qrVersion || 0,
    pairingCode: options.pairingCode || null,
    pairingExpiresAt: options.pairingExpiresAt || null,
    connectedPhone: mockSock?.user ? phoneUtils.cleanDigits(mockSock.user.id.split('@')[0].split(':')[0]) : (options.connectedPhone || null),
    lastConnectedAt: mockSock?.user ? new Date().toISOString() : null,
    lastError: null,
    pairingMethod: options.pairingMethod || 'QR',
    simulated: Boolean(options.simulated),
    retryCount: options.retryCount || 0,
    socketGen: options.socketGen !== undefined ? options.socketGen : 1,
  };
  activeSessions.set(uid, session);
  if (options.attachListeners && mockSock?.ev?.on) {
    _attachSocketListeners(uid, mockSock, session, options.saveCreds || (() => {}), session.socketGen);
  }
  return session;
}

/**
 * Hook de inspeção de sessão em memória para testes herméticos
 * @param {number} userId
 */
function _getActiveSessionForTesting(userId) {
  return activeSessions.get(Number(userId));
}

/**
 * Hook de limpeza para testes herméticos
 */
function _resetForTesting() {
  activeSessions.clear();
  tenantLocks.clear();
  _socketFactoryForTesting = null;
  _qrInitTimeoutMs = 25000;
}

/**
 * Hook para alterar o diretório base de sessões durante testes
 * @param {string} dir
 */
function _setBaseDirForTesting(dir) {
  SESSIONS_ROOT = dir;
}

function _setBaileysSocketFactoryForTesting(factory) {
  _socketFactoryForTesting = factory;
}

function _setQrInitTimeoutForTesting(ms) {
  _qrInitTimeoutMs = ms;
}

module.exports = {
  isSalonRealWhatsAppAllowed,
  getSessionStatus,
  startQrSession,
  requestPairingCode,
  cancelPendingPairing,
  disconnect,
  sendSalonMessage,
  restoreActiveSalonSessions,
  getSalonSessionDir,
  validateBrazilianPhoneForPairing,
  getSalonDiagnostics,
  inspectSalonAuthCredentials,
  _attachSocketListeners,
  _reconnectSalonSocket,
  _setSocketForTesting,
  _getActiveSessionForTesting,
  _resetForTesting,
  _setBaseDirForTesting,
  _setBaileysSocketFactoryForTesting,
  _setQrInitTimeoutForTesting,
};
