#!/usr/bin/env bash
# ==============================================================================
# RAIA AGENTES — PROCEDIMENTO DE BACKUP & INTEGRIDADE SQLITE / EASYPANEL
# ==============================================================================
# Destinado exclusivamente ao container de staging no Easypanel.
# Garante snapshot crash-consistent via VACUUM INTO, integridade PRAGMA
# e backup das credenciais WhatsApp (/app/auth_info_baileys).
# ==============================================================================

set -euo pipefail

DATA_DIR="${DATA_DIR:-/app/data}"
BACKUP_DIR="${DATA_DIR}/backups"
DB_PATH="${DATA_DIR}/assistant.db"
AUTH_DIR="${AUTH_DIR:-/app/auth_info_baileys}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DB_FILE="${BACKUP_DIR}/assistant_${TIMESTAMP}.db"
BACKUP_AUTH_FILE="${BACKUP_DIR}/baileys_${TIMESTAMP}.tar.gz"
RETENTION_DAYS=7

echo "===================================================="
echo " RAIA AGENTES — BACKUP EASYPANEL: ${TIMESTAMP}"
echo "===================================================="

mkdir -p "${BACKUP_DIR}"

# 1. Validação de existência do banco operacional
if [ ! -f "${DB_PATH}" ]; then
  echo "❌ ERRO: Banco SQLite operacional não encontrado em ${DB_PATH}"
  exit 1
fi

# 2. Execução de Snapshot Atômico via Node.js + SQLite VACUUM INTO
echo "[1/4] Executando VACUUM INTO para snapshot transacional consistente..."
node - <<EOF
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '${DB_PATH}';
const backupPath = '${BACKUP_DB_FILE}';

try {
  const db = new DatabaseSync(dbPath);
  db.exec("VACUUM INTO '" + backupPath + "'");
  db.close();
  console.log("Snapshot criado com sucesso em: " + backupPath);
} catch (err) {
  console.error("Falha ao executar VACUUM INTO:", err.message);
  process.exit(1);
}
EOF

# 3. Verificação de Integridade PRAGMA no banco gerado
echo "[2/4] Executando PRAGMA integrity_check no arquivo de backup..."
node - <<EOF
const { DatabaseSync } = require('node:sqlite');
const backupPath = '${BACKUP_DB_FILE}';

try {
  const db = new DatabaseSync(backupPath);
  const row = db.prepare('PRAGMA integrity_check').get();
  const res = row ? (row.integrity_check || Object.values(row)[0]) : 'FAILED';
  db.close();

  if (res !== 'ok') {
    console.error("❌ ERRO CRÍTICO: PRAGMA integrity_check retornou: " + res);
    process.exit(1);
  }
  console.log("Integridade verificada com sucesso: PRAGMA integrity_check = ok");
} catch (err) {
  console.error("Erro na verificação de integridade:", err.message);
  process.exit(1);
}
EOF

# 4. Snapshot dos dados de autenticação WhatsApp Baileys
echo "[3/4] Criando snapshot das credenciais Baileys..."
if [ -d "${AUTH_DIR}" ] && [ "$(ls -A "${AUTH_DIR}" 2>/dev/null)" ]; then
  tar -czf "${BACKUP_AUTH_FILE}" -C "${AUTH_DIR}" .
  echo "Sessão Baileys empacotada em: ${BACKUP_AUTH_FILE}"
else
  echo "Aviso: Diretório de credenciais ${AUTH_DIR} vazio ou ausente. Prosseguindo."
fi

# 5. Política de Retenção (7 dias)
echo "[4/4] Limpando backups com mais de ${RETENTION_DAYS} dias..."
find "${BACKUP_DIR}" -type f -name "assistant_*.db" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
find "${BACKUP_DIR}" -type f -name "baileys_*.tar.gz" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true

echo "===================================================="
echo "✅ BACKUP CONCLUÍDO E AUDITADO COM SUCESSO!"
echo "Arquivo DB: ${BACKUP_DB_FILE}"
echo "===================================================="
echo ""
echo "----------------------------------------------------"
echo "PROCEDIMENTO OBRIGATÓRIO DE ROLLBACK NO EASYPANEL:"
echo "1. Pare o serviço na interface do Easypanel."
echo "2. No terminal do container ou volume montado:"
echo "     cp ${BACKUP_DB_FILE} ${DATA_DIR}/assistant.db"
echo "     # MANDATÓRIO: Remover arquivos residuais WAL/SHM:"
echo "     rm -f ${DATA_DIR}/assistant.db-wal ${DATA_DIR}/assistant.db-shm"
echo "3. Se necessário restaurar credenciais Baileys:"
echo "     rm -rf ${AUTH_DIR}/*"
echo "     tar -xzf ${BACKUP_AUTH_FILE} -C ${AUTH_DIR}"
echo "4. Inicie o serviço novamente."
echo "----------------------------------------------------"
