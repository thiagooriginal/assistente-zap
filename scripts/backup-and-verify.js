const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function computeFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function runBackupAndVerify() {
  console.log('====================================================');
  console.log('   RAIA AGENTES — BACKUP VERIFICÁVEL & INTEGRIDADE');
  console.log('====================================================\n');

  const rootDir = path.resolve(__dirname, '..');
  const dbPath = path.join(rootDir, 'data', 'assistant.db');
  const envPath = path.join(rootDir, '.env');
  const backupsDir = path.join(rootDir, 'data', 'backups');

  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`ERRO: Banco de dados SQLite não encontrado em: ${dbPath}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dbBackupName = `assistant_${timestamp}.db`;
  const envBackupName = `env_${timestamp}.backup`;
  const dbBackupPath = path.join(backupsDir, dbBackupName);
  const envBackupPath = path.join(backupsDir, envBackupName);

  // 1. Calculate original checksums
  const originalDbSha256 = computeFileSha256(dbPath);
  const originalDbSize = fs.statSync(dbPath).size;
  console.log(`[1/5] Banco SQLite de Origem:`);
  console.log(`      Arquivo: ${dbPath}`);
  console.log(`      Tamanho: ${originalDbSize} bytes`);
  console.log(`      SHA-256: ${originalDbSha256}`);

  // 2. Perform atomic crash-consistent backup via SQLite VACUUM INTO
  console.log(`\n[2/5] Criando snapshot consistente e atômico via SQLite VACUUM INTO...`);
  const liveDb = new DatabaseSync(dbPath);
  liveDb.exec(`VACUUM INTO '${dbBackupPath.replace(/\\/g, '/')}'`);
  liveDb.close();
  console.log(`      Backup consistente criado em: ${dbBackupPath}`);

  // 3. Backup .env
  let envSha256 = null;
  if (fs.existsSync(envPath)) {
    fs.copyFileSync(envPath, envBackupPath);
    envSha256 = computeFileSha256(envBackupPath);
    console.log(`\n[3/5] Backup do .env realizado com sucesso:`);
    console.log(`      Arquivo: ${envBackupPath}`);
    console.log(`      SHA-256: ${envSha256}`);
  } else {
    console.warn(`\n[3/5] AVISO: Arquivo .env não encontrado em ${envPath}`);
  }

  // 4. Verify integrity of the backup database
  console.log(`\n[4/5] Executando PRAGMA integrity_check no arquivo de backup...`);
  const backupDb = new DatabaseSync(dbBackupPath);
  const integrityRow = backupDb.prepare('PRAGMA integrity_check').get();
  const integrityResult = integrityRow ? (integrityRow.integrity_check || Object.values(integrityRow)[0]) : 'FAILED';
  const tableCountRow = backupDb.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table'").get();
  const tableCount = tableCountRow ? tableCountRow.count : 0;
  backupDb.close();

  const backupSha256 = computeFileSha256(dbBackupPath);
  const backupSize = fs.statSync(dbBackupPath).size;

  console.log(`      Resultado PRAGMA integrity_check: ${integrityResult}`);
  console.log(`      Tabelas verificadas no backup: ${tableCount}`);
  console.log(`      Tamanho do backup: ${backupSize} bytes`);
  console.log(`      SHA-256 do backup: ${backupSha256}`);

  if (integrityResult !== 'ok') {
    console.error('\n❌ FALHA CRÍTICA: O backup falhou na verificação de integridade!');
    process.exit(1);
  }

  // 5. Save manifest
  const manifestPath = path.join(backupsDir, 'backup_manifest.json');
  const manifest = {
    timestamp: new Date().toISOString(),
    status: 'VERIFIED_OK',
    dbBackupFile: dbBackupName,
    dbBackupPath: dbBackupPath,
    dbBackupSha256: backupSha256,
    dbBackupSizeBytes: backupSize,
    originalDbSha256: originalDbSha256,
    integrityCheck: integrityResult,
    tableCount: tableCount,
    envBackupFile: envBackupName,
    envBackupPath: envBackupPath,
    envBackupSha256: envSha256,
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n[5/5] Manifesto de backup registrado: ${manifestPath}`);
  console.log('\n====================================================');
  console.log('✅ BACKUP E VERIFICAÇÃO CONCLUÍDOS COM SUCESSO 100%');
  console.log('====================================================');

  return manifest;
}

if (require.main === module) {
  try {
    runBackupAndVerify();
    process.exit(0);
  } catch (err) {
    console.error('Erro ao executar backup:', err);
    process.exit(1);
  }
}

module.exports = { runBackupAndVerify };
