/**
 * RAIA AGENTES — PROCESS LOCK HELPER (T9)
 * 
 * Gerencia o arquivo de lock da aplicação (`data/app.lock`) para prevenir
 * execuções concorrentes de scripts de migração/rollback durante a atividade do servidor.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCK_FILE = path.resolve(__dirname, '../../data/app.lock');

/**
 * Verifica se um processo com determinado PID ainda está em execução
 * @param {number|string} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!numericPid || isNaN(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // Processo existe mas pertence a outro usuário
  }
}

/**
 * Inspeciona o estado atual do lock da aplicação
 * @param {string} [lockFilePath=DEFAULT_LOCK_FILE]
 * @returns {{ running: boolean, pid: number|null, stale: boolean, lockFile: string }}
 */
function checkAppRunning(lockFilePath = DEFAULT_LOCK_FILE) {
  if (!fs.existsSync(lockFilePath)) {
    return { running: false, pid: null, stale: false, lockFile: lockFilePath };
  }

  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!pid || isNaN(pid)) {
      return { running: false, pid: null, stale: true, lockFile: lockFilePath };
    }

    if (isPidAlive(pid)) {
      return { running: true, pid, stale: false, lockFile: lockFilePath };
    }

    return { running: false, pid, stale: true, lockFile: lockFilePath };
  } catch (_) {
    return { running: false, pid: null, stale: false, lockFile: lockFilePath };
  }
}

/**
 * Adquire o lock gravando o PID atual e registrando handlers de cleanup
 * @param {string} [lockFilePath=DEFAULT_LOCK_FILE]
 * @returns {boolean} True se o lock foi adquirido
 */
function acquireAppLock(lockFilePath = DEFAULT_LOCK_FILE) {
  const dir = path.dirname(lockFilePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }

  const pid = process.pid;
  try {
    fs.writeFileSync(lockFilePath, String(pid), 'utf8');
  } catch (err) {
    console.warn(`[appLock] Falha ao gravar lock file (${err.message}).`);
    return false;
  }

  const removeLock = () => {
    try {
      if (fs.existsSync(lockFilePath)) {
        const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
        if (raw === String(pid)) {
          fs.unlinkSync(lockFilePath);
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

module.exports = {
  DEFAULT_LOCK_FILE,
  isPidAlive,
  checkAppRunning,
  acquireAppLock,
  releaseAppLock,
};
