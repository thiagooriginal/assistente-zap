/**
 * RAIA AGENTES — PROCESS LOCK HELPER (T9 / COMANDO 038.1)
 *
 * Gerencia a trava do motor de sessões do WhatsApp (`data/wa-sessions.lock`)
 * para prevenir execuções concorrentes de scripts de migração/rollback enquanto
 * a aplicação ou o motor de sessões estiver ativo.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCK_FILE = path.resolve(__dirname, '../../data/wa-sessions.lock');

let _processStartTimeChecker = null;

/**
 * Hook exclusivo para testes herméticos injetarem verificador de tempo de início de processo
 * @param {((pid: number) => number|null)|null} fn
 */
function _setProcessStartTimeCheckerForTesting(fn) {
  _processStartTimeChecker = fn;
}

/**
 * Retorna o tempo de início do processo (timestamp em ms) ou null se indeterminado
 * @param {number} pid
 * @returns {number|null}
 */
function getProcessStartTime(pid) {
  if (typeof _processStartTimeChecker === 'function') {
    return _processStartTimeChecker(pid);
  }

  if (pid === process.pid) {
    return Math.floor(Date.now() - (process.uptime() * 1000));
  }

  try {
    if (process.platform === 'linux' && fs.existsSync(`/proc/${pid}/stat`)) {
      const statContent = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = statContent.substring(statContent.lastIndexOf(')') + 1).trim().split(/\s+/);
      const starttimeJiffies = parseInt(afterComm[19], 10);
      if (!isNaN(starttimeJiffies)) {
        return starttimeJiffies;
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Inspeciona rigorosamente o estado do lock de sessões do WhatsApp
 * @param {string} [lockFilePath=DEFAULT_LOCK_FILE]
 * @returns {{
 *   exists: boolean,
 *   running: boolean,
 *   orphan: boolean,
 *   indeterminate: boolean,
 *   self: boolean,
 *   pid: number|null,
 *   startedAt: number|null,
 *   engineId: string|null,
 *   reason: string,
 *   lockFile: string
 * }}
 */
function inspectAppLock(lockFilePath = DEFAULT_LOCK_FILE) {
  if (!fs.existsSync(lockFilePath)) {
    return {
      exists: false,
      running: false,
      orphan: false,
      indeterminate: false,
      self: false,
      pid: null,
      startedAt: null,
      engineId: null,
      reason: 'LOCK_NOT_FOUND',
      lockFile: lockFilePath,
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(lockFilePath, 'utf8').trim();
  } catch (err) {
    return {
      exists: true,
      running: true,
      orphan: false,
      indeterminate: true,
      self: false,
      pid: null,
      startedAt: null,
      engineId: null,
      reason: `READ_ERROR: ${err.code || err.message}`,
      lockFile: lockFilePath,
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    // Compatibilidade com lock antigo (apenas número) ou corrompido
    const numericOnly = parseInt(raw, 10);
    if (!numericOnly || isNaN(numericOnly)) {
      return {
        exists: true,
        running: true,
        orphan: false,
        indeterminate: true,
        self: false,
        pid: null,
        startedAt: null,
        engineId: null,
        reason: 'LOCK_CORRUPTED_OR_UNREADABLE',
        lockFile: lockFilePath,
      };
    }
    payload = { pid: numericOnly, startedAt: null, engineId: 'legacy' };
  }

  const pid = Number(payload.pid);
  const startedAt = payload.startedAt != null ? Number(payload.startedAt) : null;
  const engineId = payload.engineId || null;

  if (!pid || isNaN(pid) || pid <= 0) {
    return {
      exists: true,
      running: true,
      orphan: false,
      indeterminate: true,
      self: false,
      pid: null,
      startedAt,
      engineId,
      reason: 'INVALID_PID_IN_LOCK',
      lockFile: lockFilePath,
    };
  }

  if (pid === process.pid) {
    return {
      exists: true,
      running: true,
      orphan: false,
      indeterminate: false,
      self: true,
      pid,
      startedAt,
      engineId,
      reason: 'LOCK_HELD_BY_SELF_PROCESS',
      lockFile: lockFilePath,
    };
  }

  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') {
      // Processo comprovadamente morto
      return {
        exists: true,
        running: false,
        orphan: true,
        indeterminate: false,
        self: false,
        pid,
        startedAt,
        engineId,
        reason: 'PID_NOT_FOUND_DEAD',
        lockFile: lockFilePath,
      };
    }
    // Erro EPERM ou outro erro de sistema: indeterminado (fail-closed)
    return {
      exists: true,
      running: true,
      orphan: false,
      indeterminate: true,
      self: false,
      pid,
      startedAt,
      engineId,
      reason: `SIGNAL_CHECK_FAILED: ${err.code || err.message}`,
      lockFile: lockFilePath,
    };
  }

  // O processo está vivo (process.kill retornou sem erro)
  // Agora verifica se o PID foi reciclado se houver startedAt no lock
  const currentStartTime = getProcessStartTime(pid);
  if (currentStartTime !== null && startedAt !== null && currentStartTime !== startedAt) {
    return {
      exists: true,
      running: false,
      orphan: true,
      indeterminate: false,
      self: false,
      pid,
      startedAt,
      engineId,
      reason: 'PID_RECYCLED_DIFFERENT_START_TIME',
      lockFile: lockFilePath,
    };
  }

  return {
    exists: true,
    running: true,
    orphan: false,
    indeterminate: false,
    self: false,
    pid,
    startedAt,
    engineId,
    reason: 'PROCESS_ALIVE_ACTIVE',
    lockFile: lockFilePath,
  };
}

/**
 * Tenta remover uma trava se for comprovadamente órfã
 * @param {string} [lockFilePath=DEFAULT_LOCK_FILE]
 * @param {{ logger?: object }} [options]
 * @returns {{ unlocked: boolean, reason: string, status: object }}
 */
function tryForceUnlock(lockFilePath = DEFAULT_LOCK_FILE, { logger = console } = {}) {
  const status = inspectAppLock(lockFilePath);
  if (!status.exists) {
    return { unlocked: true, reason: 'LOCK_NOT_FOUND', status };
  }

  if (status.self) {
    return { unlocked: false, reason: 'CANNOT_UNLOCK_SELF_PROCESS', status };
  }

  if (status.running || status.indeterminate || !status.orphan) {
    return { unlocked: false, reason: status.reason || 'CANNOT_UNLOCK_ACTIVE_OR_INDETERMINATE', status };
  }

  try {
    fs.unlinkSync(lockFilePath);
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[appLock] Trava órfã removida com sucesso. Motivo: ${status.reason} (PID: ${status.pid}).`);
    }
    return { unlocked: true, reason: status.reason, status };
  } catch (err) {
    return { unlocked: false, reason: `UNLINK_FAILED: ${err.message}`, status };
  }
}

/**
 * Adquire a trava de sessões do WhatsApp gravando PID, startedAt e engineId.
 * Se WA_SESSIONS_DISABLED=true, não adquire e retorna false.
 * @param {string} [lockFilePath=DEFAULT_LOCK_FILE]
 * @returns {boolean} True se o lock foi adquirido
 */
function acquireAppLock(lockFilePath = DEFAULT_LOCK_FILE) {
  if (process.env.WA_SESSIONS_DISABLED === 'true') {
    return false;
  }

  const dir = path.dirname(lockFilePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }

  const pid = process.pid;
  const startedAt = getProcessStartTime(pid) || Date.now();
  const payload = {
    pid,
    startedAt,
    engineId: 'wa-sessions-engine',
  };

  try {
    fs.writeFileSync(lockFilePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[appLock] Falha ao gravar lock file (${err.message}).`);
    return false;
  }

  const removeLock = () => {
    try {
      if (fs.existsSync(lockFilePath)) {
        const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
        try {
          const parsed = JSON.parse(raw);
          if (parsed && Number(parsed.pid) === pid) {
            fs.unlinkSync(lockFilePath);
          }
        } catch (_) {
          if (raw === String(pid)) {
            fs.unlinkSync(lockFilePath);
          }
        }
      }
    } catch (_) {}
  };

  process.once('exit', removeLock);
  process.once('SIGINT', () => {
    removeLock();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    removeLock();
    process.exit(0);
  });

  return true;
}

/**
 * Libera explicitamente o lock file
 * @param {string} [lockFilePath=DEFAULT_LOCK_FILE]
 */
function releaseAppLock(lockFilePath = DEFAULT_LOCK_FILE) {
  try {
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }
  } catch (_) {}
}

/**
 * Função de retrocompatibilidade para chamadas legadas
 */
function checkAppRunning(lockFilePath = DEFAULT_LOCK_FILE) {
  const status = inspectAppLock(lockFilePath);
  return {
    running: status.running || status.indeterminate,
    pid: status.pid,
    stale: status.orphan,
    lockFile: status.lockFile,
    reason: status.reason,
  };
}

module.exports = {
  DEFAULT_LOCK_FILE,
  inspectAppLock,
  tryForceUnlock,
  acquireAppLock,
  releaseAppLock,
  checkAppRunning,
  _setProcessStartTimeCheckerForTesting,
};
