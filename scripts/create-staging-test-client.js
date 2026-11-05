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
 *  - Senha: Lido com segurança via console mascarado (sem exibição em tela/logs)
 *  - Isolamento: Verificação fail-closed de ambiente de homologação
 */

const readline = require('readline');
const crypto = require('crypto');
const path = require('path');

// 1. Verificação fail-closed do ambiente de execução
function validateStagingEnvironment() {
  const appMode = (process.env.APP_MODE || '').toLowerCase();
  const isHomologacao = process.env.HOMOLOGACAO === 'true';
  const canonicalDomain = (process.env.CANONICAL_DOMAIN || '').toLowerCase();
  const allowLocalTest = process.env.ALLOW_LOCAL_TEST === 'true';

  const isStaging =
    appMode === 'staging' ||
    appMode === 'homologacao' ||
    isHomologacao ||
    canonicalDomain.includes('seguranca.raiaagentes.com.br') ||
    canonicalDomain.includes('staging');

  if (!isStaging && !allowLocalTest) {
    console.error('\n❌ [BLOQUEIO DE SEGURANÇA] Execução Não Permitida!');
    console.error('Este script é exclusivo para o ambiente de homologação (raia-staging).');
    console.error('Ambiente atual:');
    console.error(`  - APP_MODE: ${process.env.APP_MODE || '(não configurado)'}`);
    console.error(`  - HOMOLOGACAO: ${process.env.HOMOLOGACAO || '(não configurado)'}`);
    console.error(`  - CANONICAL_DOMAIN: ${process.env.CANONICAL_DOMAIN || '(não configurado)'}`);
    console.error('\nOperação abortada imediatamente para proteger os demais ambientes.');
    process.exit(1);
  }
}

// 2. Leitura segura de senha (sem eco/logs)
async function promptSecurePassword(query) {
  if (process.env.CLIENT_TEMP_PASSWORD) {
    const p = process.env.CLIENT_TEMP_PASSWORD.trim();
    delete process.env.CLIENT_TEMP_PASSWORD;
    if (p.length < 8) {
      throw new Error('A senha fornecida via variável de ambiente deve ter no mínimo 8 caracteres.');
    }
    return p;
  }

  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

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
        case '\u0004':
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
        case '\u0008':
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

async function main() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — CADASTRO DE CLIENTE DE TESTE EM HOMOLOGAÇÃO   ');
  console.log('================================================================\n');

  // Validação estrita do ambiente
  validateStagingEnvironment();

  // Dependências internas (carregadas somente após validação de ambiente)
  const db = require('../src/database/db');
  const clientAuth = require('../src/services/clientAuthService');
  const productService = require('../src/services/productService');
  const salonDashboardService = require('../src/services/salonDashboardService');

  const clientEmail = 'teste.entrada@example.com';
  const clientName = 'Salão Teste RAIA';
  const testPhone = '5511999990002';
  const planTier = 'JESSICA_START';
  const paidUntilDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log('Parâmetros da Conta:');
  console.log(`  - Nome: ${clientName}`);
  console.log(`  - E-mail: ${clientEmail}`);
  console.log(`  - Produto: Jéssica`);
  console.log(`  - Plano: Jéssica Entrada (${planTier})`);
  console.log(`  - Profissionais Inclusos: 1`);
  console.log(`  - Vigência: 7 dias (até ${new Date(paidUntilDate).toLocaleString('pt-BR')})`);
  console.log(`  - Status: ACTIVE (is_demo = 0)`);
  console.log(`  - Pagamento: Simulado / Manual (sem comunicação externa com Asaas/Hotmart)\n`);

  let rawPassword = await promptSecurePassword('Digite a senha temporária para o cliente (mínimo 8 caracteres): ');
  if (!rawPassword || rawPassword.length < 8) {
    console.error('\n❌ Erro: A senha deve conter pelo menos 8 caracteres.');
    process.exit(1);
  }

  if (process.stdin.isTTY) {
    const confirmPassword = await promptSecurePassword('Confirme a senha temporária: ');
    if (rawPassword !== confirmPassword) {
      console.error('\n❌ Erro: As senhas digitadas não coincidem.');
      process.exit(1);
    }
  }

  // Gera hash scrypt com salt seguro
  const { hash, salt } = clientAuth.hashPassword(rawPassword);

  let userId = null;

  // Bloco transacional atômico no SQLite
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingUser = db.prepare('SELECT id, phone_number FROM users WHERE LOWER(email) = ?').get(clientEmail.toLowerCase());

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
      console.log(`\n[SQLite] Usuário existente atualizado com sucesso (ID #${userId}).`);
    } else {
      // Garante que o telefone de teste não colida
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
      console.log(`\n[SQLite] Novo usuário cadastrado com sucesso (ID #${userId}).`);
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
      console.log(`[SQLite] Assinatura multiproduto existente atualizada para Plano Entrada (ID #${existingSub.id}).`);
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

    // Configura o salão
    clientAuth.ensureSalonForUser(userId, clientName);
    db.prepare('UPDATE client_salons SET salon_name = ? WHERE user_id = ?').run(clientName, userId);

    // Garante exatamente 1 colaborador (respeitando o limite do plano Entrada)
    const staffList = db.prepare('SELECT id FROM client_staff WHERE user_id = ?').all(userId);
    if (staffList.length === 0) {
      db.prepare(`
        INSERT INTO client_staff (user_id, name, specialty)
        VALUES (?, 'Profissional Principal', 'Cortes & Atendimento')
      `).run(userId);
    } else if (staffList.length > 1) {
      for (let i = 1; i < staffList.length; i++) {
        db.prepare('DELETE FROM client_staff WHERE id = ?').run(staffList[i].id);
      }
    }

    db.exec('COMMIT');
  } catch (dbErr) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('\n❌ Erro durante a persistência:', dbErr.message);
    process.exit(1);
  }

  // 3. Validação funcional pós-cadastro com a senha informada
  const loginTest = clientAuth.login(clientEmail, rawPassword);
  // Limpeza imediata da variável em memória
  rawPassword = null;

  if (!loginTest.success) {
    console.error('\n❌ Falha na verificação pós-cadastro de login:', loginTest.error);
    process.exit(1);
  }

  const accessCheck = productService.hasProductAccess(userId, 'JESSICA');
  if (!accessCheck.hasAccess || accessCheck.status !== 'ACTIVE') {
    console.error('\n❌ Falha na verificação de acesso ao produto:', accessCheck);
    process.exit(1);
  }

  const resolvedTier = salonDashboardService.getEffectiveJessicaTier(userId);
  if (resolvedTier !== 'JESSICA_START') {
    console.error(`\n❌ Inconsistência de Tier: esperado JESSICA_START, obtido ${resolvedTier}`);
    process.exit(1);
  }

  const staffCount = db.prepare('SELECT COUNT(*) as c FROM client_staff WHERE user_id = ?').get(userId)?.c || 0;

  console.log('\n================================================================');
  console.log('✅ CLIENTE DE TESTE CONFIGURADO E VALIDADO COM SUCESSO!');
  console.log('================================================================');
  console.log(`ID no banco de dados: #${userId}`);
  console.log(`E-mail de login:      ${clientEmail}`);
  console.log(`Produto ativo:        Jéssica (Assistente Virtual)`);
  console.log(`Plano verificado:     ${resolvedTier} (Entrada)`);
  console.log(`Profissionais:        ${staffCount} configurado(s)`);
  console.log(`Flag is_demo:         0 (acesso real de cliente)`);
  console.log(`Validação de login:   APROVADO (login funcional com token gerado)`);
  console.log(`URL do Portal:        https://seguranca.raiaagentes.com.br/cliente/login`);
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
