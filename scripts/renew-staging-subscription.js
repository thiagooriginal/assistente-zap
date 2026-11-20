/**
 * RAIA AGENTES — Script Preparatório de Renovação Administrativa em Staging
 * COMANDO 060.2 — Item 5
 * 
 * Regras Mandatórias:
 * 1. Fail-closed: Executa estritamente sob APP_MODE=staging, homologacao ou HOMOLOGACAO=true.
 * 2. Validação prévia dos dados (user_id=3, email='teste.entrada@example.com', is_demo=0, sub_id=2, product='JESSICA', origin='MANUAL').
 * 3. Rejeita categoricamente is_demo=1 e user_id=2 (conta Hotmart homologação).
 * 4. Backup consistente prévio via VACUUM INTO (.bak) com timestamp.
 * 5. Transação atômica síncrona: BEGIN IMMEDIATE ... COMMIT com rollback em falhas.
 * 6. Modo --dry-run ativado por padrão; exige --apply para persistir.
 * 7. Parametrização estrita de prepared statements (?).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Validação de ambiente fail-closed
 */
function validateStagingEnvironment(options = {}) {
  const appMode = (process.env.APP_MODE || '').toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  const isHomologacao = process.env.HOMOLOGACAO === 'true';
  const baseUrl = (process.env.BASE_URL || process.env.APP_URL || '').toLowerCase();

  // COMANDO 060.3: Bloqueio categórico se apontar para o domínio raiz de produção
  if (baseUrl.includes('raiaagentes.com.br') && !baseUrl.includes('seguranca.raiaagentes.com.br') && !baseUrl.includes('staging')) {
    throw new Error(
      `[SECURITY_FAIL_CLOSED] Tentativa de execução com BASE_URL de produção detectada (${baseUrl})! Interrompendo imediatamente.`
    );
  }

  const isStaging = appMode === 'staging' || appMode === 'homologacao' || isHomologacao;
  const isTest = (options.allowTestEnv !== false) && (nodeEnv === 'test' || appMode === 'test');

  if (appMode === 'production' || (!isStaging && !isTest)) {
    throw new Error(
      `[SECURITY_FAIL_CLOSED] Execução proibida em produção ou ambiente não autorizado! ` +
      `O script só pode operar em staging/homologação (APP_MODE=staging ou HOMOLOGACAO=true). ` +
      `Ambiente detectado: APP_MODE="${process.env.APP_MODE || ''}", NODE_ENV="${process.env.NODE_ENV || ''}", HOMOLOGACAO="${process.env.HOMOLOGACAO || ''}".`
    );
  }

  return { isStaging, isTest };
}

/**
 * Gera snapshot consistente de backup via VACUUM INTO
 */
function createConsistentBackup(db, dbPath) {
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) {
    return { created: false, reason: 'Banco em memória ou arquivo não persistido em disco' };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(path.dirname(dbPath), 'backups');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const baseName = path.basename(dbPath, path.extname(dbPath));
  const backupFilePath = path.join(backupDir, `${baseName}_staging_renew_${timestamp}.bak`);

  try {
    const escapedBackupPath = backupFilePath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedBackupPath}'`);
    return { created: true, path: backupFilePath, timestamp };
  } catch (vacuumErr) {
    // Fallback de cópia segura se VACUUM INTO sofrer limitação de permissão de arquivo
    fs.copyFileSync(dbPath, backupFilePath);
    return { created: true, path: backupFilePath, timestamp, fallbackCopy: true };
  }
}

/**
 * Validação prévia estrita do Tenant e da Assinatura
 */
function validateRenewalCandidate(db, targetUserId = 3, targetSubscriptionId = 2) {
  // 1. Rejeição mandatória do usuário demonstrativo do Hotmart (user_id = 2)
  if (Number(targetUserId) === 2) {
    throw new Error('[GUARD_VIOLATION] Proibição Absoluta: user_id = 2 é reservado para a conta de homologação Hotmart e não pode receber renovação manual.');
  }

  // 2. Consulta do usuário estritamente parametrizada
  const user = db.prepare(`
    SELECT id, email, role, is_demo, subscription_status, paid_until
    FROM users
    WHERE id = ?
  `).get(targetUserId);

  if (!user) {
    throw new Error(`[DATA_NOT_FOUND] Usuário user_id = ${targetUserId} não encontrado no banco de dados.`);
  }

  // 3. Validação do e-mail oficial de teste
  if (user.email !== 'teste.entrada@example.com') {
    throw new Error(`[SECURITY_REJECTION] E-mail do usuário (${user.email}) difere do esperado ('teste.entrada@example.com').`);
  }

  // 4. Rejeição se for tenant demo
  if (Number(user.is_demo) === 1) {
    throw new Error(`[SECURITY_REJECTION] Tenant demonstrativo detectado (is_demo = 1). Contas demo não podem receber renovação manual.`);
  }

  // 5. Consulta da assinatura e integridade do produto
  const subscription = db.prepare(`
    SELECT cs.id, cs.user_id, cs.product_id, cs.plan_id, cs.origin, cs.status,
           cs.paid_until, cs.access_expires_at,
           p.code AS product_code, p.name AS product_name
    FROM customer_subscriptions cs
    JOIN products p ON p.id = cs.product_id
    WHERE cs.id = ? AND cs.user_id = ?
  `).get(targetSubscriptionId, targetUserId);

  if (!subscription) {
    throw new Error(`[DATA_NOT_FOUND] Assinatura id = ${targetSubscriptionId} associada ao user_id = ${targetUserId} não foi encontrada.`);
  }

  // 6. Validação do produto JESSICA
  if (subscription.product_code !== 'JESSICA') {
    throw new Error(`[INVALID_PRODUCT] O produto da assinatura é '${subscription.product_code}', esperado 'JESSICA'.`);
  }

  // 7. Validação da origem MANUAL
  if (subscription.origin !== 'MANUAL') {
    throw new Error(`[INVALID_ORIGIN] A origem da assinatura é '${subscription.origin}', esperado 'MANUAL'.`);
  }

  return { user, subscription };
}

/**
 * Execução atômica da renovação
 */
function executeRenewal(options = {}) {
  // 1. Validação de Ambiente Fail-Closed
  validateStagingEnvironment(options);

  const apply = options.apply === true;
  const daysToAdd = Number(options.days) || 30;
  const targetUserId = Number(options.userId) || 3;
  const targetSubscriptionId = Number(options.subscriptionId) || 2;

  // 2. Conexão / Instância do Banco
  let db = options.db;
  let dbPath = options.dbPath;

  if (!db) {
    const config = require('../src/config');
    dbPath = config.dbPath;
    db = new DatabaseSync(dbPath);
  }

  // COMANDO 060.3: Bloqueio fail-closed se o caminho do banco apontar para arquivo de produção
  if (dbPath) {
    const normPath = String(dbPath).toLowerCase();
    if (normPath.includes('production') || normPath.endsWith('prod.db')) {
      throw new Error(`[SECURITY_FAIL_CLOSED] Caminho do banco indica base de produção (${dbPath}). Abortando.`);
    }
  }

  // 3. Validação Prévia dos Dados
  const { user, subscription } = validateRenewalCandidate(db, targetUserId, targetSubscriptionId);

  // 4. Cálculo da nova vigência
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + daysToAdd);
  const newPaidUntil = targetDate.toISOString();

  const diagnosticReport = {
    mode: apply ? 'APPLY (ESCRITA ATÔMICA)' : 'DRY-RUN (SIMULAÇÃO PASSIVA)',
    tenant: {
      userId: user.id,
      email: user.email,
      role: user.role,
      isDemo: user.is_demo,
      currentStatus: user.subscription_status,
      currentPaidUntil: user.paid_until,
    },
    subscription: {
      subscriptionId: subscription.id,
      productCode: subscription.product_code,
      productName: subscription.product_name,
      origin: subscription.origin,
      currentStatus: subscription.status,
      currentPaidUntil: subscription.paid_until,
      currentAccessExpiresAt: subscription.access_expires_at,
    },
    plannedMutation: {
      newStatus: 'ACTIVE',
      newPaidUntil,
      newAccessExpiresAt: newPaidUntil,
      daysExtended: daysToAdd,
    }
  };

  // Se for apenas simulação passiva (--dry-run), retorna sem mutações
  if (!apply) {
    return {
      success: true,
      dryRun: true,
      applied: false,
      diagnosticReport,
      message: 'Diagnóstico concluído com sucesso. Nenhuma alteração foi gravada no banco de dados. Use --apply para confirmar.'
    };
  }

  // 5. Procedimento de Backup Consistente antes da escrita
  const backupResult = createConsistentBackup(db, dbPath);

  // 6. Transação Atômica BEGIN IMMEDIATE
  db.exec('BEGIN IMMEDIATE');

  try {
    // 6.1 Atualização de customer_subscriptions
    const updateSubStmt = db.prepare(`
      UPDATE customer_subscriptions
      SET status = 'ACTIVE',
          paid_until = ?,
          access_expires_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `);
    const subRes = updateSubStmt.run(newPaidUntil, newPaidUntil, subscription.id, user.id);

    if (subRes.changes !== 1) {
      throw new Error(`[TX_FAIL] Falha ao atualizar customer_subscriptions. Esperado 1 registro, afetados: ${subRes.changes}`);
    }

    // 6.2 Atualização de users
    const updateUserStmt = db.prepare(`
      UPDATE users
      SET subscription_status = 'ACTIVE',
          paid_until = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const userRes = updateUserStmt.run(newPaidUntil, user.id);

    if (userRes.changes !== 1) {
      throw new Error(`[TX_FAIL] Falha ao atualizar users. Esperado 1 registro, afetados: ${userRes.changes}`);
    }

    // 6.3 Trilha de Auditoria em subscription_audit_logs
    const insertSubAuditStmt = db.prepare(`
      INSERT INTO subscription_audit_logs (
        subscription_id,
        user_id,
        product_id,
        old_status,
        new_status,
        action,
        reason,
        details_json,
        created_at
      ) VALUES (?, ?, ?, ?, 'ACTIVE', 'ADMIN_MANUAL_RENEWAL', ?, ?, CURRENT_TIMESTAMP)
    `);

    const subAuditDetails = JSON.stringify({
      script: 'scripts/renew-staging-subscription.js',
      action: 'ADMIN_MANUAL_RENEWAL',
      userId: user.id,
      subscriptionId: subscription.id,
      productId: subscription.product_id,
      oldSubStatus: subscription.status,
      newSubStatus: 'ACTIVE',
      oldUserStatus: user.subscription_status,
      newUserStatus: 'ACTIVE',
      newPaidUntil,
      renewedAt: new Date().toISOString()
    });

    insertSubAuditStmt.run(
      subscription.id,
      user.id,
      subscription.product_id,
      subscription.status,
      options.reason || 'Renovação administrativa controlada em staging',
      subAuditDetails
    );

    // 6.4 Trilha de Auditoria em security_audit_logs (Proteção 08 & 26)
    const insertSecAuditStmt = db.prepare(`
      INSERT INTO security_audit_logs (
        event_type,
        user_id,
        ip_address,
        user_agent,
        resource,
        status,
        details_json,
        created_at
      ) VALUES (?, ?, '127.0.0.1', 'CLI-Script/renew-staging-subscription', ?, 'SUCCESS', ?, CURRENT_TIMESTAMP)
    `);

    const secAuditDetails = JSON.stringify({
      eventType: 'CONTRACT_RENEWED',
      script: 'scripts/renew-staging-subscription.js',
      userId: user.id,
      subscriptionId: subscription.id,
      productId: subscription.product_id,
      newPaidUntil,
      reason: options.reason || 'Renovação administrativa controlada em staging'
    });

    insertSecAuditStmt.run(
      'CONTRACT_RENEWED',
      user.id,
      'scripts/renew-staging-subscription.js',
      secAuditDetails
    );

    // Commit Atômico
    db.exec('COMMIT');

    return {
      success: true,
      dryRun: false,
      applied: true,
      backup: backupResult,
      diagnosticReport,
      receipt: {
        userId: user.id,
        subscriptionId: subscription.id,
        previousStatus: subscription.status,
        newStatus: 'ACTIVE',
        newPaidUntil,
        appliedAt: new Date().toISOString(),
      }
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    throw err;
  }
}

// Ponto de entrada CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const daysArg = args.find(a => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1], 10) : 30;

  console.log('===============================================================');
  console.log('   RAIA AGENTES — RENOVAÇÃO ADMINISTRATIVA EM STAGING (CLI)   ');
  console.log('===============================================================\n');

  try {
    const result = executeRenewal({ apply, days });
    console.log(JSON.stringify(result, null, 2));

    if (result.dryRun) {
      console.log('\n✅ [DRY-RUN] Diagnóstico concluído com sucesso. Nenhuma alteração realizada.');
      console.log('Para aplicar efetivamente em staging, execute com a flag: --apply\n');
    } else {
      console.log('\n🎉 [SUCESSO] Assinatura e Usuário renovados com atomicidade imediata.');
      if (result.backup?.created) {
        console.log(`📁 Backup snapshot salvo em: ${result.backup.path}\n`);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('\n❌ [ERRO FATAL NA RENOVAÇÃO]:', err.message);
    process.exit(1);
  }
}

module.exports = {
  validateStagingEnvironment,
  createConsistentBackup,
  validateRenewalCandidate,
  executeRenewal,
};
