/**
 * RAIA AGENTES — PROCESS LOCK HELPER (T9 / COMANDO 038.2)
 *
 * Gerencia a trava do motor de sessões do WhatsApp (`data/wa-sessions.lock`)
 * para prevenir execuções concorrentes de scripts de migração/rollback enquanto
 * o motor de sessões estiver ativo em qualquer ambiente.
 */

const fs = require('fs');
const path = require('path');

const OPERATIONAL_LOCK_FILE = path.resolve(__dirname, '../../data/wa-sessions.lock');
const DEFAULT_LOCK_FILE = OPERATIONAL_LOCK_FILE;

/**
 * Resolve o caminho do lock file com suporte a WA_LOCK_PATH
 * @param {string} [customPath]
 * @returns {string}
 */
function resolveLockFilePath(customPath) {
  if (customPath) return path.resolve(customPath);
  if (process.env.WA_LOCK_PATH) return path.resolve(process.env.WA_LOCK_PATH);
  return OPERATIONAL_LOCK_FILE;
}

// Estado de aquisição em memória por processo
let _engineLockAcquired = false;
let _engineLockPath = null;

// Hooks de teste hermético para simular leituras de /proc no Linux
let _procStatReaderForTesting = null;
let _bootIdReaderForTesting = null;

function _setProcStatReaderForTesting(fn) {
  _procStatReaderForTesting = fn;
}

function _setBootIdReaderForTesting(fn) {
  _bootIdReaderForTesting = fn;
}

function _resetEngineLockForTesting() {
  _engineLockAcquired = false;
  _engineLockPath = null;
  _procStatReaderForTesting = null;
  _bootIdReaderForTesting = null;
}

/**
 * Lê o boot_id atual do sistema Linux (/proc/sys/kernel/random/boot_id)
 * @returns {string|null}
 */
function readBootId() {
  if (typeof _bootIdReaderForTesting === 'function') {
    return _bootIdReaderForTesting();
  }
  try {
    if (process.platform === 'linux' && fs.existsSync('/proc/sys/kernel/random/boot_id')) {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    }
  } catch (_) {}
  return null;
}

/**
 * Parser robusto de /proc/<pid>/stat do Linux
 * Suporta nomes de processos contendo parênteses e espaços (ex: '(Web Content (worker))')
 * O campo 2 (comm) é delimitado pelo primeiro '(' e o último ')'.
 * O campo 22 (starttime) é o 19º elemento após o comm.
 *
 * @param {string} statContent
 * @returns {{ startTicks: number }|null}
 */
function parseProcStat(statContent) {
  if (!statContent || typeof statContent !== 'string') return null;
  const lastParenIndex = statContent.lastIndexOf(')');
  if (lastParenIndex === -1) return null;

  const afterComm = statContent.substring(lastParenIndex + 1).trim();
  const fields = afterComm.split(/\s+/);
  if (fields.length <= 19) return null;

  const startTicks = parseInt(fields[19], 10);
  if (isNaN(startTicks) || startTicks < 0) return null;

  return { startTicks };
}

/**
 * Obtém informações do processo a partir de /proc/<pid>/stat
 * @param {number|string} pid
 * @returns {{ startTicks: number }|null}
 */
function getLinuxProcessStat(pid) {
  if (typeof _procStatReaderForTesting === 'function') {
    return _procStatReaderForTesting(pid);
  }
  try {
    if (process.platform === 'linux') {
      const statPath = pid === process.pid || pid === 'self' ? '/proc/self/stat' : `/proc/${pid}/stat`;
      if (fs.existsSync(statPath)) {
        const content = fs.readFileSync(statPath, 'utf8');
        return parseProcStat(content);
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
 *   startTicks: number|null,
 *   bootId: string|null,
 *   engineId: string|null,
 *   reason: string,
 *   lockFile: string
 * }}
 */
function inspectAppLock(customPath) {
  const lockFilePath = resolveLockFilePath(customPath);
  if (!fs.existsSync(lockFilePath)) {
    return {
      exists: false,
      running: false,
      orphan: false,
      indeterminate: false,
      self: false,
      pid: null,
      startTicks: null,
      bootId: null,
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
      startTicks: null,
      bootId: null,
      engineId: null,
      reason: `READ_ERROR: ${err.code || err.message}`,
      lockFile: lockFilePath,
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    // Compatibilidade com lock legado (apenas número) ou corrompido
    const numericOnly = parseInt(raw, 10);
    if (!numericOnly || isNaN(numericOnly)) {
      return {
        exists: true,
        running: true,
        orphan: false,
        indeterminate: true,
        self: false,
        pid: null,
        startTicks: null,
        bootId: null,
        engineId: null,
        reason: 'LOCK_CORRUPTED_OR_UNREADABLE',
        lockFile: lockFilePath,
      };
    }
    payload = { pid: numericOnly, startTicks: null, bootId: null, engineId: 'legacy' };
  }

  const pid = Number(payload.pid);
  const startTicks = payload.startTicks != null ? Number(payload.startTicks) : null;
  const bootId = payload.bootId != null ? String(payload.bootId) : null;
  const engineId = payload.engineId || null;

  if (!pid || isNaN(pid) || pid <= 0) {
    return {
      exists: true,
      running: true,
      orphan: false,
      indeterminate: true,
      self: false,
      pid: null,
      startTicks,
      bootId,
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
      startTicks,
      bootId,
      engineId,
      reason: 'LOCK_HELD_BY_SELF_PROCESS',
      lockFile: lockFilePath,
    };
  }

  // Verifica se o processo com esse PID existe no sistema operacional
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
        startTicks,
        bootId,
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
      startTicks,
      bootId,
      engineId,
      reason: `SIGNAL_CHECK_FAILED: ${err.code || err.message}`,
      lockFile: lockFilePath,
    };
  }

  // O processo está vivo (process.kill retornou sem erro)
  // Agora compara o horário de início na mesma unidade (Linux startTicks e bootId)
  const currentBootId = readBootId();

  // Se a trava possui bootId gravado e o bootId atual difere: o sistema reiniciou (PID reciclado)
  if (bootId !== null && currentBootId !== null && bootId !== currentBootId) {
    return {
      exists: true,
      running: false,
      orphan: true,
      indeterminate: false,
      self: false,
      pid,
      startTicks,
      bootId,
      engineId,
      reason: 'BOOT_ID_MISMATCH_REAPROVEITADO',
      lockFile: lockFilePath,
    };
  }

  // Se a trava possui startTicks gravados
  if (startTicks !== null) {
    const currentStat = getLinuxProcessStat(pid);
    if (currentStat && currentStat.startTicks !== null) {
      if (currentStat.startTicks !== startTicks) {
        return {
          exists: true,
          running: false,
          orphan: true,
          indeterminate: false,
          self: false,
          pid,
          startTicks,
          bootId,
          engineId,
          reason: 'PID_RECYCLED_DIFFERENT_START_TICKS',
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
        startTicks,
        bootId,
        engineId,
        reason: 'PROCESS_ALIVE_ACTIVE',
        lockFile: lockFilePath,
      };
    }
    // Não foi possível ler /proc/<pid>/stat (ex: erro de permissão ou sistema não-Linux):
    // Resultado é indeterminado. Com processo vivo, tratado como ativo (fail-closed).
    return {
      exists: true,
      running: true,
      orphan: false,
      indeterminate: true,
      self: false,
      pid,
      startTicks,
      bootId,
      engineId,
      reason: 'PROC_READ_FAILED_INDETERMINATE',
      lockFile: lockFilePath,
    };
  }

  // Trava antiga (apenas PID ou sem startTicks legíveis):
  // Com o PID vivo, tratada obrigatoriamente como ativa
  return {
    exists: true,
    running: true,
    orphan: false,
    indeterminate: false,
    self: false,
    pid,
    startTicks: null,
    bootId,
    engineId,
    reason: 'LEGACY_LOCK_PID_ALIVE_ACTIVE',
    lockFile: lockFilePath,
  };
}

/**
 * Tenta remover uma trava se for comprovadamente órfã
 * @param {string} [lockFilePath=DEFAULT_LOCK_FILE]
 * @param {{ logger?: object }} [options]
 * @returns {{ unlocked: boolean, reason: string, status: object }}
 */
function tryForceUnlock(customPath, { logger = console } = {}) {
  const lockFilePath = resolveLockFilePath(customPath);
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
    // Salvaguarda: em ambiente de teste, nunca apaga a trava operacional data/wa-sessions.lock
    if (process.env.NODE_ENV === 'test' && lockFilePath === OPERATIONAL_LOCK_FILE) {
      return { unlocked: false, reason: 'TEST_ENVIRONMENT_PREVENTED_OPERATIONAL_LOCK_REMOVAL', status };
    }
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
 * Adquire a trava de sessões do WhatsApp gravando PID, startTicks, bootId e engineId.
 * Se WA_SESSIONS_DISABLED=true, não adquire e retorna false.
 * @param {string} [customPath]
 * @returns {boolean} True se o lock foi adquirido
 */
function acquireAppLock(customPath) {
  const lockFilePath = resolveLockFilePath(customPath);
  if (process.env.WA_SESSIONS_DISABLED === 'true') {
    return false;
  }

  // Salvaguarda mandatória: em ambiente de teste, nunca grava no arquivo operacional data/wa-sessions.lock
  if (process.env.NODE_ENV === 'test' && lockFilePath === OPERATIONAL_LOCK_FILE) {
    return false;
  }

  const dir = path.dirname(lockFilePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }

  const pid = process.pid;
  const linuxStat = getLinuxProcessStat(pid);
  const bootId = readBootId();

  const payload = {
    pid,
    engineId: 'wa-sessions-engine',
    createdAt: Date.now(),
    startTicks: linuxStat ? linuxStat.startTicks : null,
    bootId: bootId || null,
  };

  try {
    fs.writeFileSync(lockFilePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[appLock] Falha ao gravar lock file (${err.message}).`);
    return false;
  }

  const removeLock = () => {
    try {
      if (process.env.NODE_ENV === 'test' && lockFilePath === OPERATIONAL_LOCK_FILE) {
        return;
      }
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
 * Garante a criação da trava do motor WhatsApp sempre que um motor puder iniciar.
 * Idempotente por processo.
 * @param {string} [customPath]
 * @returns {boolean}
 */
function ensureWaEngineLock(customPath) {
  const lockFilePath = resolveLockFilePath(customPath);
  if (process.env.WA_SESSIONS_DISABLED === 'true') {
    return false;
  }

  if (process.env.NODE_ENV === 'test' && lockFilePath === OPERATIONAL_LOCK_FILE) {
    return false;
  }

  if (_engineLockAcquired && _engineLockPath === lockFilePath) {
    return true;
  }

  const acquired = acquireAppLock(lockFilePath);
  if (acquired) {
    _engineLockAcquired = true;
    _engineLockPath = lockFilePath;
    return true;
  }

  const err = new Error('WA_ENGINE_LOCK_ACQUISITION_FAILED: Falha ao adquirir trava do motor WhatsApp.');
  err.code = 'WA_ENGINE_LOCK_FAILED';
  throw err;
}

/**
 * Libera explicitamente o lock file
 * @param {string} [customPath]
 */
function releaseAppLock(customPath) {
  const lockFilePath = resolveLockFilePath(customPath);
  try {
    if (process.env.NODE_ENV === 'test' && lockFilePath === OPERATIONAL_LOCK_FILE) {
      return;
    }
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }
    if (_engineLockPath === lockFilePath) {
      _engineLockAcquired = false;
      _engineLockPath = null;
    }
  } catch (_) {}
}

/**
 * Função de retrocompatibilidade para chamadas legadas
 */
function checkAppRunning(customPath) {
  const lockFilePath = resolveLockFilePath(customPath);
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
  parseProcStat,
  readBootId,
  inspectAppLock,
  tryForceUnlock,
  acquireAppLock,
  ensureWaEngineLock,
  releaseAppLock,
  checkAppRunning,
  _setProcStatReaderForTesting,
  _setBootIdReaderForTesting,
  _resetEngineLockForTesting,
};
