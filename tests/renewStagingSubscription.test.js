/**
 * Suíte de Testes Herméticos: renew-staging-subscription.js
 * Validação isolada com node:test, node:assert/strict e banco descartável em os.tmpdir().
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const {
  validateStagingEnvironment,
  validateRenewalCandidate,
  executeRenewal,
} = require('../scripts/renew-staging-subscription');

describe('Comando 060.2 — Testes Herméticos de Renovação Administrativa', () => {
  let tmpDbPath;
  let testDb;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Configura ambiente temporário isolado
    tmpDbPath = path.join(os.tmpdir(), `test_renew_staging_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
    testDb = new DatabaseSync(tmpDbPath);

    // Criação do esquema mínimo de homologação
    testDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE,
        role TEXT DEFAULT 'USER',
        is_demo INTEGER DEFAULT 0,
        subscription_status TEXT DEFAULT 'INACTIVE',
        paid_until TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL
      );

      CREATE TABLE customer_subscriptions (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        plan_id INTEGER,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        paid_until TEXT,
        access_expires_at TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE subscription_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        details_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE security_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        user_id INTEGER,
        ip_address TEXT,
        user_agent TEXT,
        resource TEXT,
        status TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Sementes dos testes
    testDb.prepare("INSERT INTO products (id, code, name) VALUES (1, 'JESSICA', 'Assistente Jéssica')").run();
    testDb.prepare("INSERT INTO products (id, code, name) VALUES (2, 'JARVIS_FINANCEIRO', 'Assistente Jarvis')").run();

    // Usuário 3 (Válido para renovação)
    testDb.prepare(`
      INSERT INTO users (id, email, role, is_demo, subscription_status, paid_until)
      VALUES (3, 'teste.entrada@example.com', 'USER', 0, 'PENDING', '2026-11-01T00:00:00.000Z')
    `).run();

    // Assinatura 2 (Válida para renovação)
    testDb.prepare(`
      INSERT INTO customer_subscriptions (id, user_id, product_id, origin, status, paid_until, access_expires_at)
      VALUES (2, 3, 1, 'MANUAL', 'PENDING', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')
    `).run();

    // Usuário 2 (Demo Hotmart compliance)
    testDb.prepare(`
      INSERT INTO users (id, email, role, is_demo, subscription_status, paid_until)
      VALUES (2, 'homologacao.hotmart@raiaagentes.com.br', 'USER', 1, 'ACTIVE', '2099-01-01T00:00:00.000Z')
    `).run();

    process.env.APP_MODE = 'staging';
    process.env.HOMOLOGACAO = 'true';
  });

  afterEach(() => {
    // Restaura ambiente e remove arquivo temporário
    process.env = { ...originalEnv };
    try { testDb.close(); } catch (_) {}
    if (fs.existsSync(tmpDbPath)) {
      try { fs.unlinkSync(tmpDbPath); } catch (_) {}
    }
  });

  test('1. Trava Fail-Closed: Bloqueia incondicionalmente se APP_MODE for production', () => {
    process.env.APP_MODE = 'production';
    process.env.HOMOLOGACAO = 'false';

    assert.throws(
      () => validateStagingEnvironment({ allowTestEnv: false }),
      /SECURITY_FAIL_CLOSED/
    );
  });

  test('1.1 Trava Fail-Closed: Bloqueia se BASE_URL for domínio raiz de produção', () => {
    process.env.APP_MODE = 'staging';
    process.env.HOMOLOGACAO = 'true';
    process.env.BASE_URL = 'https://raiaagentes.com.br';

    assert.throws(
      () => validateStagingEnvironment({ allowTestEnv: false }),
      /SECURITY_FAIL_CLOSED.*BASE_URL de produção/
    );
  });

  test('1.2 Trava Fail-Closed: Bloqueia se caminho do banco contiver production', () => {
    assert.throws(
      () => executeRenewal({ db: testDb, dbPath: '/var/data/production.db', apply: false }),
      /SECURITY_FAIL_CLOSED.*base de produção/
    );
  });

  test('2. Proteção Demo Hotmart: Rejeita renovação se user_id for 2', () => {
    assert.throws(
      () => validateRenewalCandidate(testDb, 2, 2),
      /GUARD_VIOLATION.*user_id = 2 é reservado/
    );
  });

  test('3. Proteção Tenant Demo: Rejeita renovação se is_demo for 1', () => {
    testDb.prepare("UPDATE users SET is_demo = 1 WHERE id = 3").run();
    assert.throws(
      () => validateRenewalCandidate(testDb, 3, 2),
      /SECURITY_REJECTION.*is_demo = 1/
    );
  });

  test('4. Validação de E-mail: Rejeita se e-mail não for teste.entrada@example.com', () => {
    testDb.prepare("UPDATE users SET email = 'outro@example.com' WHERE id = 3").run();
    assert.throws(
      () => validateRenewalCandidate(testDb, 3, 2),
      /SECURITY_REJECTION.*E-mail do usuário/
    );
  });

  test('5. Validação de Produto e Origem: Rejeita se produto não for JESSICA ou origem não for MANUAL', () => {
    testDb.prepare("UPDATE customer_subscriptions SET origin = 'ASAAS' WHERE id = 2").run();
    assert.throws(
      () => validateRenewalCandidate(testDb, 3, 2),
      /INVALID_ORIGIN.*esperado 'MANUAL'/
    );
  });

  test('6. Dry-Run por padrão: Não altera banco sem --apply', () => {
    const result = executeRenewal({
      db: testDb,
      dbPath: tmpDbPath,
      apply: false,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);

    const sub = testDb.prepare("SELECT status FROM customer_subscriptions WHERE id = 2").get();
    const user = testDb.prepare("SELECT subscription_status FROM users WHERE id = 3").get();

    assert.equal(sub.status, 'PENDING');
    assert.equal(user.subscription_status, 'PENDING');
  });

  test('7. Execução Atômica (--apply): Atualiza assinaturas, usuários e insere trilhas de auditoria', () => {
    const result = executeRenewal({
      db: testDb,
      dbPath: tmpDbPath,
      apply: true,
      days: 30,
    });

    assert.equal(result.success, true);
    assert.equal(result.applied, true);

    const sub = testDb.prepare("SELECT status, paid_until, access_expires_at FROM customer_subscriptions WHERE id = 2").get();
    const user = testDb.prepare("SELECT subscription_status, paid_until FROM users WHERE id = 3").get();

    assert.equal(sub.status, 'ACTIVE');
    assert.equal(user.subscription_status, 'ACTIVE');
    assert.ok(sub.paid_until.includes('T'));
    assert.equal(sub.paid_until, user.paid_until);

    const subAudit = testDb.prepare("SELECT * FROM subscription_audit_logs WHERE subscription_id = 2").get();
    assert.ok(subAudit);
    assert.equal(subAudit.action, 'ADMIN_MANUAL_RENEWAL');
    assert.equal(subAudit.new_status, 'ACTIVE');

    const secAudit = testDb.prepare("SELECT * FROM security_audit_logs WHERE event_type = 'CONTRACT_RENEWED'").get();
    assert.ok(secAudit);
    assert.equal(secAudit.user_id, 3);
  });
});
