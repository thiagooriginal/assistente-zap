#!/usr/bin/env node
'use strict';

/**
 * RAIA AGENTES — CADASTRO DE CLIENTE DE TESTE EM HOMOLOGAÇÃO
 *
 * Cria/atualiza de forma estritamente segura e idempotente o primeiro
 * usuário cliente de teste no ambiente de homologação (raia-staging).
 *
 * Características:
 *  - E-mail: teste.entrada@example.com
 *  - Nome: Salão Teste RAIA
 *  - Produto: Jéssica (Assistente Virtual para Salões e Barbearias)
 *  - Plano: JESSICA_START (Entrada) com 1 profissional incluso
 *  - Vigência: 7 dias (status ACTIVE)
 *  - Modo: is_demo = 0 (ambiente real de assinante Entrada)
 *  - Senha: Leitura estrita com mascaramento via TTY (hash scrypt + salt)
 *  - Isolamento: Verificação simultânea de APP_MODE, HOMOLOGACAO e BASE_URL
 *  - Compatibilidade: Aceita NODE_ENV=production sob as flags obrigatórias de staging
 *  - Preservação: Não exclui colaboradores nem dados existentes em reexecuções
 *
 * Requisito de Volume SQLite Exclusivo no Easypanel:
 * O serviço 'raia-staging' DEVE montar um volume persistente independente
 * montado em /app/data (ex: 'raia-staging-sqlite:/app/data'), garantindo
 * que a base de dados de homologação jamais compartilhe o mesmo arquivo
 * ou volume com o serviço 'bot' de produção.
 */

const readline = require('readline');
const crypto = require('crypto');
const path = require('path');

// 1. Verificação fail-closed do ambiente de execução (Executado antes de carregar o DB)
function validateStagingEnvironment() {
  const appMode = (process.env.APP_MODE || '').trim().toLowerCase();
  const isHomologacao = (process.env.HOMOLOGACAO || '').trim().toLowerCase();
  const rawBaseUrl = (process.env.BASE_URL || '').trim();
  const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  const rawDbPath = (process.env.DB_PATH || '').trim();

  // Rejeição explícita de parâmetros de produção (sem vetar NODE_ENV=production do container Docker)
  const isProductionAppMode = appMode === 'production';
  const isProducaoFlagTrue = (process.env.PRODUCAO || '').trim().toLowerCase() === 'true';
  const isProductionDomain =
    normalizedBaseUrl === 'https://raiaagentes.com.br' ||
    normalizedBaseUrl === 'http://raiaagentes.com.br' ||
    (normalizedBaseUrl.includes('raiaagentes.com.br') && !normalizedBaseUrl.includes('seguranca.') && !normalizedBaseUrl.includes('staging.'));

  if (isProductionAppMode || isProducaoFlagTrue || isProductionDomain) {
    console.error('\n❌ [BLOQUEIO DE SEGURANÇA] Execução em Produção Rejeitada!');
    console.error('Configuração de produção detectada no ambiente:');
    if (isProductionAppMode) console.error('  - APP_MODE=production não é permitido.');
    if (isProducaoFlagTrue) console.error('  - PRODUCAO=true não é permitido.');
    if (isProductionDomain) console.error(`  - Domínio principal (${normalizedBaseUrl}) não é permitido.`);
    console.error('Este script é estritamente proibido de ser executado no ambiente de produção.');
    console.error('Operação abortada imediatamente para proteger a base de dados de produção.');
    process.exit(1);
  }

  // Validação simultânea e obrigatória das 3 variáveis fundamentais de homologação
  const isAppModeStaging = appMode === 'staging';
  const isHomologacaoTrue = isHomologacao === 'true';
  const isBaseUrlStaging = normalizedBaseUrl === 'https://seguranca.raiaagentes.com.br';

  if (!isAppModeStaging || !isHomologacaoTrue || !isBaseUrlStaging) {
    console.error('\n❌ [BLOQUEIO DE SEGURANÇA] Ambiente Não Autorizado!');
    console.error('Este script exige SIMULTANEAMENTE a presença das seguintes 3 configurações de homologação:');
    console.error(`  1. APP_MODE=staging                          (Atual: "${process.env.APP_MODE || ''}") -> ${isAppModeStaging ? 'OK' : 'FALHA'}`);
    console.error(`  2. HOMOLOGACAO=true                          (Atual: "${process.env.HOMOLOGACAO || ''}") -> ${isHomologacaoTrue ? 'OK' : 'FALHA'}`);
    console.error(`  3. BASE_URL=https://seguranca.raiaagentes.com.br (Atual: "${rawBaseUrl}") -> ${isBaseUrlStaging ? 'OK' : 'FALHA'}`);
    console.error('\nTodas as 3 condições devem ser satisfeitas em conjunto para autorizar a execução.');
    console.error('Operação abortada imediatamente.');
    process.exit(1);
  }

  // Validação do caminho do banco de dados (DB_PATH) e salvaguarda do volume
  if (rawDbPath) {
    const normalizedDb = path.normalize(rawDbPath).replace(/\\/g, '/');
    const isExpectedExtension = normalizedDb.endsWith('.db') || normalizedDb.endsWith('.sqlite');
    if (!isExpectedExtension) {
      console.error('\n❌ [BLOQUEIO DE SEGURANÇA] DB_PATH Inválido!');
      console.error(`O caminho DB_PATH="${rawDbPath}" não aponta para um arquivo SQLite válido (.db/.sqlite).`);
      process.exit(1);
    }
    // Salvaguarda: Rejeita caminhos que façam referência explícita ao serviço bot ou produção
    if (normalizedDb.includes('production') || normalizedDb.includes('/bot/') || normalizedDb.includes('bot-sqlite')) {
      console.error('\n❌ [BLOQUEIO DE SEGURANÇA] DB_PATH Conflitante com Produção!');
      console.error(`O caminho configurado (${rawDbPath}) parece apontar para o diretório ou volume do serviço de produção (bot).`);
      console.error('O serviço raia-staging deve apontar exclusivamente para o volume isolado (ex: /app/data/assistant.db).');
      process.exit(1);
    }
  }
}

// 2. Leitura segura de senha (exige TTY obrigatório e caracteres mascarados)
async function promptSecurePassword(query) {
  if (!process.stdin.isTTY) {
    console.error('\n❌ [ERRO DE SEGURANÇA] Terminal Interativo Obrigatório (TTY Ausente)!');
    console.error('Este script exige entrada segura em um terminal interativo com TTY ativo.');
    console.error('A execução via redirecionamento de entrada, pipes, background ou automação não interativa foi interrompida para impedir a exposição ou captura indevida de senhas.');
    console.error('Como executar com segurança:');
    console.error('  1. Acesse o Easypanel no serviço raia-staging.');
    console.error('  2. Abra a aba Terminal / Console.');
    console.error('  3. Execute interativamente:');
    console.error('     node scripts/create-staging-test-client.js\n');
    process.exit(1);
  }

  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';
    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl+D
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password.trim());
          break;
        case '\u0003': // Ctrl+C
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\nOperação cancelada pelo operador.\n');
          process.exit(130);
          break;
        case '\u0008': // Backspace
        case '\x7f':
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
          break;
        default:
          password += char;
          process.stdout.write('*');
          break;
      }
    };
    stdin.on('data', onData);
  });
}

// 3. Função atômica de criação/atualização com preservação de dados
function createOrUpdateStagingClient(options = {}) {
  // Validação fail-closed antes de qualquer carregamento de banco de dados
  validateStagingEnvironment();

  const db = require('../src/database/db');
  const clientAuth = require('../src/services/clientAuthService');
  const productService = require('../src/services/productService');
  const salonDashboardService = require('../src/services/salonDashboardService');

  const clientEmail = (options.email || 'teste.entrada@example.com').trim().toLowerCase();
  const clientName = options.name || 'Salão Teste RAIA';
  const testPhone = options.phone || '5511999990002';
  const planTier = 'JESSICA_START';
  const rawPassword = options.password;

  if (!rawPassword || rawPassword.length < 8) {
    throw new Error('A senha deve conter no mínimo 8 caracteres.');
  }

  const paidUntilDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { hash, salt } = clientAuth.hashPassword(rawPassword);

  let userId = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const existingUser = db.prepare('SELECT id, phone_number FROM users WHERE LOWER(email) = ?').get(clientEmail);

    if (existingUser) {
      userId = existingUser.id;
      db.prepare(`
        UPDATE users
        SET name = ?,
            password_hash = ?,
            password_salt = ?,
            plan_tier = ?,
            subscription_status = 'ACTIVE',
            paid_until = ?,
            subscription_origin = 'MANUAL',
            is_demo = 0,
            role = 'USER',
            extra_professionals = 0,
            activation_token = NULL,
            activation_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(clientName, hash, salt, planTier, paidUntilDate, userId);
      console.log(`[SQLite] Conta existente atualizada com segurança (ID #${userId}).`);
    } else {
      const phoneTaken = db.prepare('SELECT id FROM users WHERE phone_number = ?').get(testPhone);
      const safePhone = phoneTaken ? `551199999${Date.now().toString().slice(-4)}` : testPhone;

      const userInsert = db.prepare(`
        INSERT INTO users (
          name, email, phone_number, password_hash, password_salt,
          plan_tier, subscription_status, paid_until, subscription_origin,
          is_demo, role, extra_professionals
        ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, 'MANUAL', 0, 'USER', 0)
      `).run(clientName, clientEmail, safePhone, hash, salt, planTier, paidUntilDate);

      userId = Number(userInsert.lastInsertRowid);
      console.log(`[SQLite] Nova conta cadastrada com sucesso (ID #${userId}).`);
    }

    // Vincula produto JESSICA na arquitetura multiproduto (customer_subscriptions)
    const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
    if (!jessica) {
      throw new Error("Produto 'JESSICA' não encontrado no catálogo.");
    }

    const startPlan = db.prepare("SELECT id, price_cents FROM product_plans WHERE product_id = ? AND code IN ('START', 'JESSICA_START')").get(jessica.id);
    const planId = startPlan ? startPlan.id : null;
    const priceCents = startPlan?.price_cents || 8900;

    const existingSub = db.prepare('SELECT id FROM customer_subscriptions WHERE user_id = ? AND product_id = ?').get(userId, jessica.id);
    if (existingSub) {
      db.prepare(`
        UPDATE customer_subscriptions
        SET plan_id = ?,
            origin = 'MANUAL',
            gateway = 'MANUAL',
            status = 'ACTIVE',
            price_cents = ?,
            paid_until = ?,
            access_expires_at = ?,
            extra_professionals = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(planId, priceCents, paidUntilDate, paidUntilDate, existingSub.id);
      console.log(`[SQLite] Assinatura multiproduto mantida e renovada para 7 dias (ID #${existingSub.id}).`);
    } else {
      const subInsert = db.prepare(`
        INSERT INTO customer_subscriptions (
          user_id, product_id, plan_id, origin, gateway,
          status, price_cents, setup_fee_cents,
          billing_cycle, promotional_fair, extra_professionals,
          contracted_at, paid_until, access_expires_at
        ) VALUES (
          ?, ?, ?, 'MANUAL', 'MANUAL',
          'ACTIVE', ?, 0,
          'MONTHLY', 0, 0,
          CURRENT_TIMESTAMP, ?, ?
        )
      `).run(userId, jessica.id, planId, priceCents, paidUntilDate, paidUntilDate);
      console.log(`[SQLite] Assinatura criada em customer_subscriptions (ID #${subInsert.lastInsertRowid}).`);
    }

    // Configura o salão preservando dados existentes
    clientAuth.ensureSalonForUser(userId, clientName);
    db.prepare('UPDATE client_salons SET salon_name = ? WHERE user_id = ?').run(clientName, userId);

    // Preservação estrita de colaboradores (NÃO exclui profissionais existentes)
    const staffList = db.prepare('SELECT id, name, specialty FROM client_staff WHERE user_id = ?').all(userId);
    if (staffList.length === 0) {
      db.prepare(`
        INSERT INTO client_staff (user_id, name, specialty)
        VALUES (?, 'Profissional Principal', 'Cortes & Atendimento')
      `).run(userId);
      console.log('[Colaboradores] 1 profissional padrão configurado (Profissional Principal).');
    } else if (staffList.length === 1) {
      console.log(`[Colaboradores] 1 profissional existente preservado intacto: "${staffList[0].name}".`);
    } else {
      console.warn(`⚠️ [Preservação de Dados] Inconsistência identificada: a conta possui ${staffList.length} profissionais cadastrados no banco.`);
      console.warn('   O limite padrão do plano Jéssica Entrada é de 1 profissional.');
      console.warn('   Conforme política de preservação de dados, NENHUM colaborador foi excluído. Todos os registros permanecem preservados.');
    }

    db.exec('COMMIT');
  } catch (dbErr) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw dbErr;
  }

  // Validação funcional do login
  const loginTest = clientAuth.login(clientEmail, rawPassword);
  if (!loginTest.success) {
    throw new Error(`Falha na verificação de login pós-cadastro: ${loginTest.error}`);
  }

  const accessCheck = productService.hasProductAccess(userId, 'JESSICA');
  if (!accessCheck.hasAccess || accessCheck.status !== 'ACTIVE') {
    throw new Error(`Falha no acesso ao produto Jéssica: status=${accessCheck.status}`);
  }

  const resolvedTier = salonDashboardService.getEffectiveJessicaTier(userId);
  if (resolvedTier !== 'JESSICA_START') {
    throw new Error(`Inconsistência de Tier: esperado JESSICA_START, obtido ${resolvedTier}`);
  }

  const staffCount = db.prepare('SELECT COUNT(*) as c FROM client_staff WHERE user_id = ?').get(userId)?.c || 0;

  return {
    userId,
    clientEmail,
    clientName,
    planTier: resolvedTier,
    staffCount,
    paidUntilDate,
    token: loginTest.token
  };
}

async function main() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — CADASTRO DE CLIENTE DE TESTE EM HOMOLOGAÇÃO   ');
  console.log('================================================================\n');

  // 1. Validação obrigatória e simultânea do ambiente (fail-closed)
  validateStagingEnvironment();

  // 2. Parâmetros visuais
  const clientEmail = 'teste.entrada@example.com';
  const clientName = 'Salão Teste RAIA';

  console.log('Parâmetros da Conta de Teste:');
  console.log(`  - Nome: ${clientName}`);
  console.log(`  - E-mail: ${clientEmail}`);
  console.log(`  - Produto: Jéssica (Assistente Virtual para Salões e Barbearias)`);
  console.log(`  - Plano: Jéssica Entrada (JESSICA_START) — 1 profissional incluso`);
  console.log(`  - Vigência: 7 dias (status ACTIVE)`);
  console.log(`  - Modo: is_demo = 0 (perfil real de cliente assinante)`);
  console.log(`  - Pagamento: Simulado / Manual (sem comunicação externa com Asaas/Hotmart)`);
  console.log(`  - Volume DB: Isolado para homologação (ex: /app/data/assistant.db)\n`);

  // 3. Leitura segura de senha com mascaramento no TTY
  let rawPassword = await promptSecurePassword('Digite a senha temporária para o cliente (mínimo 8 caracteres): ');
  if (!rawPassword || rawPassword.length < 8) {
    console.error('\n❌ Erro: A senha deve conter pelo menos 8 caracteres.');
    process.exit(1);
  }

  if (rawPassword.length < 12) {
    console.log('ℹ️ [Recomendação de Segurança] A senha digitada possui menos de 12 caracteres. Recomenda-se preferencialmente 12 ou mais caracteres.');
  }

  const confirmPassword = await promptSecurePassword('Confirme a senha temporária: ');
  if (rawPassword !== confirmPassword) {
    console.error('\n❌ Erro: As senhas digitadas não coincidem.');
    process.exit(1);
  }

  // 4. Execução da criação/atualização preservando dados existentes
  const result = createOrUpdateStagingClient({
    email: clientEmail,
    name: clientName,
    password: rawPassword
  });

  // Limpeza imediata da senha em memória
  rawPassword = null;

  console.log('\n================================================================');
  console.log('✅ CLIENTE DE TESTE CONFIGURADO E VALIDADO COM SUCESSO!');
  console.log('================================================================');
  console.log(`ID no banco de dados: #${result.userId}`);
  console.log(`E-mail de login:      ${result.clientEmail}`);
  console.log(`Produto ativo:        Jéssica (Assistente Virtual)`);
  console.log(`Plano verificado:     ${result.planTier} (Entrada)`);
  console.log(`Profissionais:        ${result.staffCount} cadastrado(s) (preservados)`);
  console.log(`Flag is_demo:         0 (perfil de assinante real)`);
  console.log(`Vigência:             Válido até ${new Date(result.paidUntilDate).toLocaleString('pt-BR')}`);
  console.log(`Validação de login:   APROVADO (login funcional)`);
  console.log(`URL do Portal:        https://seguranca.raiaagentes.com.br/cliente/login`);
  console.log('================================================================\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ Erro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  validateStagingEnvironment,
  createOrUpdateStagingClient
};
