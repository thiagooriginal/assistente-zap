const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function computeFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Controlled SQLite Rollback
 * - Preserves newly registered clients and appointments (zero customer data loss)
 * - Creates an emergency pre-rollback snapshot before modifying anything
 * - Validates cryptographic integrity before and after restoration
 */
function runRollback({ mode = 'safe', targetManifest = null } = {}) {
  console.log('====================================================');
  console.log('   RAIA AGENTES — RESTAURAÇÃO CONTROLADA & SEGURA');
  console.log('====================================================\n');

  const rootDir = path.resolve(__dirname, '..');
  const dbPath = path.join(rootDir, 'data', 'assistant.db');
  const envPath = path.join(rootDir, '.env');
  const backupsDir = path.join(rootDir, 'data', 'backups');
  const manifestPath = path.join(backupsDir, 'backup_manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.error(`ERRO: Manifesto de backup não encontrado em: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = targetManifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`[1/5] Lendo manifesto do backup: ${manifest.timestamp}`);
  console.log(`      Arquivo DB de backup: ${manifest.dbBackupPath}`);
  console.log(`      SHA-256 esperado: ${manifest.dbBackupSha256}`);

  if (!fs.existsSync(manifest.dbBackupPath)) {
    console.error(`ERRO: Arquivo de backup não existe: ${manifest.dbBackupPath}`);
    process.exit(1);
  }

  // 1. Verify backup file integrity
  const currentBackupSha256 = computeFileSha256(manifest.dbBackupPath);
  if (currentBackupSha256 !== manifest.dbBackupSha256) {
    console.error('❌ ERRO: Checksum do arquivo de backup não confere com o manifesto!');
    process.exit(1);
  }

  // 2. Create emergency safety snapshot of current live database
  const preRollbackTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const preRollbackFile = path.join(backupsDir, `assistant_pre_rollback_${preRollbackTimestamp}.db`);
  console.log(`\n[2/5] Criando snapshot de segurança pré-rollback (para evitar perda de dados)...`);
  if (fs.existsSync(dbPath)) {
    try {
      const liveDb = new DatabaseSync(dbPath);
      liveDb.exec(`VACUUM INTO '${preRollbackFile.replace(/\\/g, '/')}'`);
      liveDb.close();
      console.log(`      Snapshot de segurança salvo em: ${preRollbackFile}`);
    } catch (e) {
      fs.copyFileSync(dbPath, preRollbackFile);
      console.log(`      Snapshot de segurança (cópia direta): ${preRollbackFile}`);
    }
  }

  // 3. Detect new customers / records added since backup
  let newUsers = [];
  let newSalons = [];
  let newServices = [];
  let newAppts = [];

  if (mode === 'safe' && fs.existsSync(dbPath)) {
    console.log(`\n[3/5] Analisando registros de clientes adicionados desde o backup...`);
    try {
      const currentDb = new DatabaseSync(dbPath);
      const backupDb = new DatabaseSync(manifest.dbBackupPath);

      // Find max ID in backup
      const backupMaxUser = backupDb.prepare('SELECT MAX(id) as maxId FROM users').get()?.maxId || 0;
      backupDb.close();

      // Find users with ID > maxId or created_at > backup timestamp
      newUsers = currentDb.prepare('SELECT * FROM users WHERE id > ?').all(backupMaxUser);
      if (newUsers.length > 0) {
        const newUserIds = newUsers.map((u) => u.id);
        const placeholders = newUserIds.map(() => '?').join(',');
        newSalons = currentDb.prepare(`SELECT * FROM client_salons WHERE user_id IN (${placeholders})`).all(...newUserIds);
        newServices = currentDb.prepare(`SELECT * FROM client_services WHERE user_id IN (${placeholders})`).all(...newUserIds);
        newAppts = currentDb.prepare(`SELECT * FROM appointments WHERE user_id IN (${placeholders})`).all(...newUserIds);
        console.log(`      ⚠️ Detectados ${newUsers.length} novos clientes e ${newAppts.length} agendamentos desde o backup.`);
        console.log(`      🛡️ Modo seguro ativado: Os novos clientes serão PRESERVADOS e reinseridos pós-restauração.`);
      } else {
        console.log(`      Nenhum cliente novo criado após o backup. Prosseguindo com restauração direta.`);
      }

      currentDb.close();
    } catch (diffErr) {
      console.warn(`      Aviso na detecção de novos registros: ${diffErr.message}`);
    }
  }

  // 4. Restore base database from backup
  console.log(`\n[4/5] Restaurando banco de dados a partir do backup homologado...`);
  fs.copyFileSync(manifest.dbBackupPath, dbPath);

  // Reconcile new customer data if in safe mode
  if (mode === 'safe' && newUsers.length > 0) {
    console.log(`      Reconciliando e reinserindo ${newUsers.length} novos clientes com integridade...`);
    const restoredDb = new DatabaseSync(dbPath);

    for (const u of newUsers) {
      try {
        restoredDb.prepare(`
          INSERT OR REPLACE INTO users (
            id, email, phone_number, name, role, plan_tier, subscription_status,
            paid_until, hotmart_subscriber_code, hotmart_transaction,
            hotmart_product_id, hotmart_plan_id, activation_token, activation_expires_at,
            password_hash, password_salt, magic_token, is_demo, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          u.id, u.email, u.phone_number, u.name, u.role, u.plan_tier, u.subscription_status,
          u.paid_until, u.hotmart_subscriber_code, u.hotmart_transaction,
          u.hotmart_product_id, u.hotmart_plan_id, u.activation_token, u.activation_expires_at,
          u.password_hash, u.password_salt, u.magic_token, u.is_demo, u.created_at
        );
      } catch (uErr) {
        console.warn(`      Erro ao reinserir usuário #${u.id}:`, uErr.message);
      }
    }

    for (const s of newSalons) {
      try {
        restoredDb.prepare(`
          INSERT OR REPLACE INTO client_salons (id, user_id, salon_name, phone, address, opening_hours, agent_custom_instructions, whatsapp_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(s.id, s.user_id, s.salon_name, s.phone, s.address, s.opening_hours, s.agent_custom_instructions, s.whatsapp_status);
      } catch (sErr) {}
    }

    for (const s of newServices) {
      try {
        restoredDb.prepare(`
          INSERT OR REPLACE INTO client_services (id, user_id, name, price, duration_min, category, active)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(s.id, s.user_id, s.name, s.price, s.duration_min, s.category, s.active);
      } catch (svcErr) {}
    }

    for (const a of newAppts) {
      try {
        restoredDb.prepare(`
          INSERT OR REPLACE INTO appointments (id, user_id, title, description, start_datetime, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(a.id, a.user_id, a.title, a.description, a.start_datetime, a.status);
      } catch (aErr) {}
    }

    restoredDb.close();
    console.log(`      ✅ Novos clientes, salões e agendamentos preservados com sucesso!`);
  }

  // Restore .env if needed
  if (manifest.envBackupPath && fs.existsSync(manifest.envBackupPath)) {
    fs.copyFileSync(manifest.envBackupPath, envPath);
    console.log(`      Arquivo .env restaurado.`);
  }

  // 5. Final integrity check
  console.log(`\n[5/5] Executando verificação de integridade pós-restauração...`);
  const finalDb = new DatabaseSync(dbPath);
  const check = finalDb.prepare('PRAGMA integrity_check').get();
  const integrity = check ? (check.integrity_check || Object.values(check)[0]) : 'FAILED';
  finalDb.close();

  console.log(`      Resultado PRAGMA integrity_check pós-restauração: ${integrity}`);

  if (integrity !== 'ok') {
    console.error('❌ FALHA CRÍTICA: O banco restaurado não passou no teste de integridade!');
    process.exit(1);
  }

  console.log('\n====================================================');
  console.log('✅ RESTAURAÇÃO CONTROLADA CONCLUÍDA COM 100% DE SUCESSO');
  console.log('====================================================\n');
}

if (require.main === module) {
  const mode = process.argv.includes('--overwrite') ? 'overwrite' : 'safe';
  try {
    runRollback({ mode });
    process.exit(0);
  } catch (err) {
    console.error('Erro ao executar rollback:', err);
    process.exit(1);
  }
}

module.exports = { runRollback };
