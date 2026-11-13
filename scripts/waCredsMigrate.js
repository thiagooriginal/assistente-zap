#!/usr/bin/env node
/**
 * RAIA AGENTES — SCRIPT DE MIGRAÇÃO E ROLLBACK DE SESSÕES WHATSAPP (T9 / COMANDO 038.1)
 *
 * Converte credenciais legadas em texto claro (.json) para armazenamento cifrado
 * com envelope AWS KMS (AES-256-GCM com AAD rígido e extensão .enc).
 *
 * USO:
 *   node scripts/waCredsMigrate.js --tenant 13 --migrate
 *   node scripts/waCredsMigrate.js --personal --migrate
 *   node scripts/waCredsMigrate.js --all --migrate
 *   node scripts/waCredsMigrate.js --tenant 13 --dry-run
 *   node scripts/waCredsMigrate.js --tenant 13 --rollback --confirm-rollback
 *   node scripts/waCredsMigrate.js --all --verify
 *
 * SEGURANÇA:
 * - Valida rigorosamente a trava do motor de sessões (data/wa-sessions.lock).
 * - Sanidade obrigatória byte-a-byte antes de quarentenar texto claro.
 * - NUNCA deleta arquivos em texto claro; move para data/sessions_quarantine/.
 * - Reversão atômica por tenant em caso de falha (restaura arquivos da quarentena se falhar).
 */

const fs = require('fs');
const path = require('path');
const {
  encryptBuffer,
  decryptBuffer,
  getOrLoadTenantDek,
} = require('../src/whatsapp/encryptedAuthState');
const { getKeyProvider } = require('../src/security/keyProvider');
const { inspectAppLock, tryForceUnlock, DEFAULT_LOCK_FILE } = require('../src/utils/appLock');

const DEFAULT_SESSIONS_ROOT = path.resolve(__dirname, '../data/sessions');
const DEFAULT_QUARANTINE_ROOT = path.resolve(__dirname, '../data/sessions_quarantine');
const DEFAULT_PERSONAL_DIR = path.resolve(__dirname, '../auth_info_baileys');

/**
 * Retorna os diretórios alvo para processamento
 * @param {object} options
 * @returns {Array<{ tenantId: string|number, dir: string, isPersonal: boolean }>}
 */
function resolveTargets({ tenant, personal, all, baseSessionsDir = DEFAULT_SESSIONS_ROOT, personalDir = DEFAULT_PERSONAL_DIR }) {
  const targets = [];

  if (tenant) {
    const uid = Number(tenant);
    if (!uid || isNaN(uid) || uid <= 0) {
      throw new Error(`INVALID_TENANT: Tenant inválido informado: "${tenant}".`);
    }
    targets.push({
      tenantId: uid,
      dir: path.join(baseSessionsDir, `salon_${uid}`),
      isPersonal: false,
    });
  }

  if (personal) {
    targets.push({
      tenantId: 'personal',
      dir: personalDir,
      isPersonal: true,
    });
  }

  if (all) {
    if (fs.existsSync(baseSessionsDir)) {
      const entries = fs.readdirSync(baseSessionsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && ent.name.startsWith('salon_')) {
          const rawId = ent.name.replace('salon_', '');
          const uid = Number(rawId);
          if (uid && !isNaN(uid)) {
            targets.push({
              tenantId: uid,
              dir: path.join(baseSessionsDir, ent.name),
              isPersonal: false,
            });
          }
        }
      }
    }

    if (fs.existsSync(personalDir)) {
      targets.push({
        tenantId: 'personal',
        dir: personalDir,
        isPersonal: true,
      });
    }
  }

  return targets;
}

/**
 * Executa simulação sem escrita (--dry-run)
 * Mostra apenas nomes e tamanhos em bytes, sem hashes ou dados sensíveis.
 */
async function runDryRun(target, { keyProvider = getKeyProvider() } = {}) {
  const { tenantId, dir, isPersonal } = target;
  console.log(`\n======================================================`);
  console.log(`🔎 SIMULAÇÃO (DRY-RUN) - Tenant: ${tenantId} (${isPersonal ? 'Assistente Pessoal' : 'Salão'})`);
  console.log(`📁 Diretório: ${dir}`);
  console.log(`======================================================`);

  if (!fs.existsSync(dir)) {
    console.log(`⚠️ Diretório não existe. Nenhum arquivo para simular.`);
    return { target: tenantId, filesCount: 0, status: 'NOT_FOUND' };
  }

  const allFiles = fs.readdirSync(dir);
  const jsonFiles = allFiles.filter((f) => f.endsWith('.json'));
  const encFiles = allFiles.filter((f) => f.endsWith('.enc'));
  const hasWrappedKey = allFiles.includes('dek.wrapped');

  console.log(`Resumo do diretório:`);
  console.log(`- Arquivos em texto claro (.json): ${jsonFiles.length}`);
  console.log(`- Arquivos já cifrados (.enc):    ${encFiles.length}`);
  console.log(`- Chave embrulhada (dek.wrapped): ${hasWrappedKey ? 'PRESENTE' : 'SERÁ CRIADA'}`);

  const details = [];
  for (const file of jsonFiles) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    const estimatedEncSize = stat.size + 37; // 37 bytes de cabeçalho binário (Magic + Versão + IV + Tag)

    details.push({
      file,
      sizePlain: stat.size,
      estimatedEncSize,
      aad: `wa:${tenantId}:${file}`,
    });
  }

  if (details.length > 0) {
    console.log('\nArquivos que seriam migrados:');
    for (const d of details) {
      console.log(`  • ${d.file.padEnd(35)} ${String(d.sizePlain).padStart(6)}B -> ~${String(d.estimatedEncSize).padStart(6)}B [AAD: ${d.aad}]`);
    }
  } else {
    console.log(`ℹ️ Nenhum arquivo .json pendente de migração.`);
  }

  return {
    target: tenantId,
    filesCount: jsonFiles.length,
    status: jsonFiles.length === 0 ? 'ALREADY_MIGRATED_OR_EMPTY' : 'READY_TO_MIGRATE',
    details,
  };
}

/**
 * Executa a migração cifrada com quarentena e validação byte-a-byte.
 * Se houver qualquer falha, restaura os arquivos já movidos para quarentena de volta
 * e remove arquivos .enc gerados nesta tentativa, deixando o diretório 100% idêntico ao original.
 */
async function runMigration(target, { keyProvider = getKeyProvider(), quarantineRoot = DEFAULT_QUARANTINE_ROOT } = {}) {
  const { tenantId, dir, isPersonal } = target;
  console.log(`\n======================================================`);
  console.log(`🔒 INICIANDO MIGRAÇÃO - Tenant: ${tenantId} (${isPersonal ? 'Assistente Pessoal' : 'Salão'})`);
  console.log(`📁 Diretório: ${dir}`);
  console.log(`======================================================`);

  if (!fs.existsSync(dir)) {
    console.log(`⚠️ Diretório não existe. Pulando.`);
    return { target: tenantId, status: 'SKIPPED_NOT_FOUND', migratedCount: 0 };
  }

  const allFiles = fs.readdirSync(dir);
  const jsonFiles = allFiles.filter((f) => f.endsWith('.json'));

  if (jsonFiles.length === 0) {
    const encFiles = allFiles.filter((f) => f.endsWith('.enc'));
    if (encFiles.length > 0) {
      console.log(`✅ Diretório já migrado (${encFiles.length} arquivos .enc presentes). Nenhuma ação necessária.`);
      return { target: tenantId, status: 'ALREADY_MIGRATED', migratedCount: 0 };
    }
    console.log(`ℹ️ Diretório vazio. Nenhuma ação necessária.`);
    return { target: tenantId, status: 'EMPTY', migratedCount: 0 };
  }

  // 1. Obtém ou cria a DEK do tenant
  const dek = await getOrLoadTenantDek(dir, { tenantId, keyProvider });

  const stagedEncFiles = [];
  const processedPlainFiles = [];
  const movedToQuarantine = [];
  let quarantineFolder = null;

  try {
    // 2. Cifra cada arquivo para .enc e valida byte-a-byte
    for (const file of jsonFiles) {
      const plainPath = path.join(dir, file);
      const originalPlainBuffer = fs.readFileSync(plainPath);
      const encBuffer = encryptBuffer(originalPlainBuffer, dek, { tenantId, fileName: file });

      const encPath = path.join(dir, `${file}.enc`);
      const tmpEncPath = `${encPath}.tmp`;

      // Escrita atômica com fsync
      const fd = fs.openSync(tmpEncPath, 'w');
      try {
        fs.writeFileSync(fd, encBuffer);
        try {
          fs.fsyncSync(fd);
        } catch (_) {}
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpEncPath, encPath);
      stagedEncFiles.push(encPath);

      // 3. Teste de Sanidade Obrigatório: Leitura e Comparação Byte-a-Byte
      const readBackBuffer = fs.readFileSync(encPath);
      const decryptedPlainBuffer = decryptBuffer(readBackBuffer, dek, { tenantId, fileName: file });

      if (!decryptedPlainBuffer.equals(originalPlainBuffer)) {
        throw new Error(`SANITY_CHECK_FAILED: Divergência byte-a-byte detectada no arquivo ${file}!`);
      }

      processedPlainFiles.push({ file, plainPath });
      console.log(`  ✓ ${file.padEnd(35)} -> ${file}.enc [Integridade verificada 100%]`);
    }

    // 4. Mover arquivos em texto claro para a quarentena (NUNCA deletar)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    quarantineFolder = path.join(
      quarantineRoot,
      isPersonal ? `personal_${timestamp}` : `salon_${tenantId}_${timestamp}`
    );

    if (!fs.existsSync(quarantineFolder)) {
      fs.mkdirSync(quarantineFolder, { recursive: true });
    }

    for (const item of processedPlainFiles) {
      const destPath = path.join(quarantineFolder, item.file);
      fs.renameSync(item.plainPath, destPath);
      movedToQuarantine.push({ item, destPath });
    }

    console.log(`\n📦 ${processedPlainFiles.length} arquivos em texto claro movidos para quarentena segura:`);
    console.log(`   📂 ${quarantineFolder}`);
    console.log(`✅ Migração do tenant ${tenantId} concluída com sucesso.`);

    return {
      target: tenantId,
      status: 'SUCCESS',
      migratedCount: processedPlainFiles.length,
      quarantineFolder,
    };
  } catch (err) {
    console.error(`\n❌ ERRO CRÍTICO durante a migração do tenant ${tenantId}: ${err.message}`);
    console.log(`🔄 Executando reversão imediata das alterações pendentes...`);

    // 1. Devolver à pasta da sessão os arquivos já movidos para a quarentena
    for (const entry of movedToQuarantine) {
      try {
        if (fs.existsSync(entry.destPath)) {
          fs.renameSync(entry.destPath, entry.item.plainPath);
        }
      } catch (_) {}
    }

    // Se a pasta de quarentena ficou vazia, limpa-a
    try {
      if (quarantineFolder && fs.existsSync(quarantineFolder)) {
        const remaining = fs.readdirSync(quarantineFolder);
        if (remaining.length === 0) {
          fs.rmdirSync(quarantineFolder);
        }
      }
    } catch (_) {}

    // 2. Remove apenas os arquivos .enc gerados nesta tentativa falha
    for (const encFile of stagedEncFiles) {
      try {
        if (fs.existsSync(encFile)) {
          fs.unlinkSync(encFile);
        }
      } catch (_) {}
    }

    throw err;
  }
}

/**
 * Executa o rollback: decifra .enc para .json em staging temporário antes do swap.
 * Se falhar no meio, a pasta volta ao estado anterior, sem estado misto.
 */
async function runRollback(target, { keyProvider = getKeyProvider(), confirmRollback = false } = {}) {
  const { tenantId, dir, isPersonal } = target;
  if (!confirmRollback) {
    throw new Error('ROLLBACK_CONFIRMATION_REQUIRED: Rollback exige a flag obrigatória --confirm-rollback.');
  }

  console.log(`\n======================================================`);
  console.log(`🔓 INICIANDO ROLLBACK - Tenant: ${tenantId} (${isPersonal ? 'Assistente Pessoal' : 'Salão'})`);
  console.log(`📁 Diretório: ${dir}`);
  console.log(`======================================================`);

  if (!fs.existsSync(dir)) {
    console.log(`⚠️ Diretório não encontrado. Pulando.`);
    return { target: tenantId, status: 'SKIPPED_NOT_FOUND', rolledBackCount: 0 };
  }

  const allFiles = fs.readdirSync(dir);
  const encFiles = allFiles.filter((f) => f.endsWith('.enc'));

  if (encFiles.length === 0) {
    console.log(`ℹ️ Nenhum arquivo .enc encontrado para reverter.`);
    return { target: tenantId, status: 'NO_ENC_FILES', rolledBackCount: 0 };
  }

  const dek = await getOrLoadTenantDek(dir, { tenantId, keyProvider });

  // Staging temporário no mesmo diretório para garantir atomicidade no mesmo filesystem
  const stagingDir = path.join(dir, `.rollback_staging_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  const restoredFiles = [];
  const movedToDest = [];

  try {
    // 1. Decifra todos os arquivos no staging e valida integridade JSON
    for (const encFile of encFiles) {
      const originalFileName = encFile.replace(/\.enc$/, '');
      const encPath = path.join(dir, encFile);
      const encBuffer = fs.readFileSync(encPath);

      const decrypted = decryptBuffer(encBuffer, dek, { tenantId, fileName: originalFileName });

      // Validação de sanidade do JSON
      JSON.parse(decrypted.toString('utf8'));

      const stagingFilePath = path.join(stagingDir, originalFileName);
      const fd = fs.openSync(stagingFilePath, 'w');
      try {
        fs.writeFileSync(fd, decrypted);
        try {
          fs.fsyncSync(fd);
        } catch (_) {}
      } finally {
        fs.closeSync(fd);
      }

      restoredFiles.push({ originalFileName, encPath, stagingFilePath });
      console.log(`  ✓ Decifrado e validado: ${encFile} -> ${originalFileName}`);
    }

    // 2. Move os arquivos decifrados para o diretório oficial
    for (const item of restoredFiles) {
      const finalDest = path.join(dir, item.originalFileName);
      fs.renameSync(item.stagingFilePath, finalDest);
      movedToDest.push({ finalDest, item });
    }

    // 3. Remove os arquivos .enc somente APÓS todos os decifrados estarem no diretório oficial
    for (const item of restoredFiles) {
      try {
        if (fs.existsSync(item.encPath)) {
          fs.unlinkSync(item.encPath);
        }
      } catch (_) {}
    }

    // Limpa staging dir
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (_) {}

    console.log(`✅ Rollback concluído com sucesso para o tenant ${tenantId}. (${restoredFiles.length} arquivos restaurados)`);
    console.log(`ℹ️ Nota: dek.wrapped foi mantido intacto para contingência.`);

    return {
      target: tenantId,
      status: 'SUCCESS',
      rolledBackCount: restoredFiles.length,
    };
  } catch (err) {
    console.error(`❌ Erro durante o rollback do tenant ${tenantId}: ${err.message}`);

    // Reverte arquivos que já foram movidos para o destino, voltando ao estado puramente cifrado
    for (const { finalDest } of movedToDest) {
      try {
        if (fs.existsSync(finalDest)) {
          fs.unlinkSync(finalDest);
        }
      } catch (_) {}
    }

    // Limpa staging dir em caso de falha
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (_) {}

    throw err;
  }
}

/**
 * Valida a integridade de todas as sessões cifradas sem modificar o disco
 */
async function runVerify(target, { keyProvider = getKeyProvider() } = {}) {
  const { tenantId, dir, isPersonal } = target;
  console.log(`\n======================================================`);
  console.log(`🔍 VERIFICAÇÃO DE INTEGRIDADE - Tenant: ${tenantId} (${isPersonal ? 'Assistente Pessoal' : 'Salão'})`);
  console.log(`📁 Diretório: ${dir}`);
  console.log(`======================================================`);

  if (!fs.existsSync(dir)) {
    console.log(`⚠️ Diretório não existe.`);
    return { target: tenantId, status: 'NOT_FOUND', verifiedCount: 0, errors: [] };
  }

  const allFiles = fs.readdirSync(dir);
  const encFiles = allFiles.filter((f) => f.endsWith('.enc'));
  const hasWrappedKey = allFiles.includes('dek.wrapped');

  if (encFiles.length === 0) {
    console.log(`ℹ️ Nenhum arquivo .enc presente.`);
    return { target: tenantId, status: 'NO_ENC_FILES', verifiedCount: 0, errors: [] };
  }

  if (!hasWrappedKey) {
    const msg = 'CHAVE_AUSENTE: dek.wrapped não encontrado no diretório!';
    console.error(`❌ ${msg}`);
    return { target: tenantId, status: 'CORRUPTED', verifiedCount: 0, errors: [msg] };
  }

  let dek;
  try {
    dek = await getOrLoadTenantDek(dir, { tenantId, keyProvider });
  } catch (err) {
    console.error(`❌ Falha ao carregar chave do tenant: ${err.message}`);
    return { target: tenantId, status: 'KMS_ERROR', verifiedCount: 0, errors: [err.message] };
  }

  const errors = [];
  let verifiedCount = 0;

  for (const encFile of encFiles) {
    const originalFileName = encFile.replace(/\.enc$/, '');
    const encPath = path.join(dir, encFile);
    try {
      const buffer = fs.readFileSync(encPath);
      const decrypted = decryptBuffer(buffer, dek, { tenantId, fileName: originalFileName });
      JSON.parse(decrypted.toString('utf8'));
      verifiedCount++;
      console.log(`  ✓ ${encFile} [Íntegro e Válido]`);
    } catch (err) {
      console.error(`  ✗ ${encFile} [FALHA]: ${err.message}`);
      errors.push({ file: encFile, error: err.message });
    }
  }

  console.log(`\nResultado da verificação do tenant ${tenantId}:`);
  console.log(`- Arquivos verificados com sucesso: ${verifiedCount}/${encFiles.length}`);
  console.log(`- Erros detectados:                ${errors.length}`);

  return {
    target: tenantId,
    status: errors.length === 0 ? 'HEALTHY' : 'CORRUPTED',
    verifiedCount,
    errors,
  };
}

/**
 * Ponto de entrada CLI
 */
async function main(argv = process.argv.slice(2), { exitOnError = true, lockFile = DEFAULT_LOCK_FILE, keyProvider = null } = {}) {
  const args = {
    tenant: null,
    personal: false,
    all: false,
    dryRun: false,
    migrate: false,
    rollback: false,
    confirmRollback: false,
    verify: false,
    forceUnlock: false,
    lockFile,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tenant' && argv[i + 1]) {
      args.tenant = argv[++i];
    } else if (arg === '--personal') {
      args.personal = true;
    } else if (arg === '--all') {
      args.all = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--migrate') {
      args.migrate = true;
    } else if (arg === '--rollback') {
      args.rollback = true;
    } else if (arg === '--confirm-rollback') {
      args.confirmRollback = true;
    } else if (arg === '--verify') {
      args.verify = true;
    } else if (arg === '--force-unlock') {
      args.forceUnlock = true;
    } else if (arg === '--lock-file' && argv[i + 1]) {
      args.lockFile = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Uso: node scripts/waCredsMigrate.js [alvos] [ação] [opções]

Alvos (pelo menos um obrigatório):
  --tenant <id>        Processa o salão especificado (ex: --tenant 13)
  --personal           Processa a sessão pessoal do assistente
  --all                Processa todos os salões e a sessão pessoal

Ações (exatamente uma obrigatória):
  --dry-run            Simula a migração sem escrever alterações em disco
  --migrate            Executa a migração cifrada com quarentena
  --rollback           Reverte arquivos cifrados (.enc) para texto claro (.json)
  --verify             Valida a integridade e decifração de sessões existentes

Opções:
  --confirm-rollback   Confirmação explícita obrigatória para ação de rollback
  --force-unlock       Ignora lock órfão comprovado se detectado
  --lock-file <path>   Caminho customizado do lock file (para testes)
      `);
      return;
    }
  }

  const fail = (msg) => {
    console.error(msg);
    if (exitOnError) {
      process.exit(1);
    } else {
      const err = new Error(msg);
      err.code = 'CLI_ERROR';
      throw err;
    }
  };

  if (!args.tenant && !args.personal && !args.all) {
    return fail('ERRO: Especifique pelo menos um alvo: --tenant <id>, --personal ou --all.');
  }

  const actionsCount = [args.dryRun, args.migrate, args.rollback, args.verify].filter(Boolean).length;
  if (actionsCount === 0) {
    return fail('ERRO: Especifique uma ação: --dry-run, --migrate, --rollback ou --verify.');
  }
  if (actionsCount > 1) {
    return fail('ERRO: Especifique apenas UMA ação por execução.');
  }

  // 1. Verificação rigorosa de Process Lock (Se for ação de escrita: --migrate ou --rollback)
  if (args.migrate || args.rollback) {
    const lockStatus = inspectAppLock(args.lockFile);
    if (lockStatus.exists) {
      if (args.forceUnlock) {
        const unlockResult = tryForceUnlock(args.lockFile, { logger: console });
        if (!unlockResult.unlocked) {
          return fail(`\n❌ ERRO: Não foi possível liberar a trava (${unlockResult.reason}). Execução cancelada.`);
        }
      } else {
        return fail(`\n❌ ERRO: Trava existente detectada em ${lockStatus.lockFile} (Status: ${lockStatus.reason}, PID: ${lockStatus.pid || 'N/A'}). Ação de escrita bloqueada.`);
      }
    }
  }

  const targets = resolveTargets(args);
  if (targets.length === 0) {
    console.log('Nenhum alvo encontrado para processar.');
    return;
  }

  console.log(`\nRAIA AGENTES — Utilitário de Criptografia de Credenciais WhatsApp (T9)`);
  console.log(`Alvos identificados: ${targets.length}`);

  const kp = keyProvider || getKeyProvider();

  for (const target of targets) {
    if (args.dryRun) {
      await runDryRun(target, { keyProvider: kp });
    } else if (args.migrate) {
      await runMigration(target, { keyProvider: kp });
    } else if (args.rollback) {
      await runRollback(target, { keyProvider: kp, confirmRollback: args.confirmRollback });
    } else if (args.verify) {
      await runVerify(target, { keyProvider: kp });
    }
  }

  console.log('\nOperação concluída com sucesso.\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFALHA NA EXECUÇÃO:', err.message);
    process.exit(1);
  });
}

module.exports = {
  resolveTargets,
  runDryRun,
  runMigration,
  runRollback,
  runVerify,
  main,
};
