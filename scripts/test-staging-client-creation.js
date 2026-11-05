'use strict';

/**
 * RAIA AGENTES — SUÍTE DE TESTES: CRIAÇÃO DO CLIENTE DE TESTE EM HOMOLOGAÇÃO
 *
 * Valida:
 * 1. Bloqueio fail-closed em ambiente não-staging.
 * 2. Criação idempotente do usuário Salão Teste RAIA (teste.entrada@example.com).
 * 3. Configuração de is_demo = 0 e plano JESSICA_START (1 profissional).
 * 4. Vigência ativa de 7 dias sem comunicação com Asaas/Hotmart.
 * 5. Autenticação HTTP em /api/cliente/auth/login e acesso ao Portal.
 * 6. Bloqueio correto de recursos PRO (reforço de restrição de tier).
 * 7. Atualização idempotente de credenciais sem duplicação de registros.
 */

const assert = require('assert');
const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');
const db = require('../src/database/db');
const { app } = require('../src/server/app');
const { clientLoginLimiter } = require('../src/middlewares/rateLimiter');

const SCRIPT_PATH = path.resolve(__dirname, 'create-staging-test-client.js');
const TEST_EMAIL = 'teste.entrada@example.com';
const TEST_PWD_INITIAL = 'RaiaStaging#Pass1';
const TEST_PWD_UPDATED = 'RaiaStaging#Pass2';

let server = null;
let serverPort = null;
let baseUrl = null;

function request(method, pathUrl, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, baseUrl);
    const reqHeaders = { ...headers };
    let payload = null;

    if (body) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
          raw: data
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('  TESTES DE SEGURANÇA: CADASTRO DE CLIENTE EM HOMOLOGAÇÃO       ');
  console.log('================================================================\n');

  // Inicializa servidor de teste
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      baseUrl = `http://127.0.0.1:${serverPort}`;
      resolve();
    });
  });

  try {
    // -------------------------------------------------------------
    // Teste 1: Proteção Fail-Closed contra Execução em Produção
    // -------------------------------------------------------------
    console.log('--- TESTE 1: PROTEÇÃO FAIL-CLOSED DE AMBIENTE ---');
    const resBlocked = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'production',
        HOMOLOGACAO: 'false',
        CANONICAL_DOMAIN: 'raiaagentes.com.br',
        ALLOW_LOCAL_TEST: 'false',
        CLIENT_TEMP_PASSWORD: TEST_PWD_INITIAL
      },
      encoding: 'utf8'
    });

    assert.strictEqual(resBlocked.status, 1, 'Script deve sair com código 1 em produção');
    assert.ok(
      resBlocked.stderr.includes('[BLOQUEIO DE SEGURANÇA]') || resBlocked.stdout.includes('[BLOQUEIO DE SEGURANÇA]'),
      'Deve exibir mensagem de bloqueio fail-closed'
    );
    console.log('  ✓ 1.1 Bloqueio fail-closed confirmado em ambiente de produção');

    // -------------------------------------------------------------
    // Teste 2: Criação Inicial em Homologação
    // -------------------------------------------------------------
    console.log('\n--- TESTE 2: CRIAÇÃO INICIAL EM HOMOLOGAÇÃO ---');

    // Limpa registros anteriores para teste limpo
    const oldUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(TEST_EMAIL.toLowerCase());
    if (oldUser) {
      db.prepare('DELETE FROM client_services WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(oldUser.id);
    }

    const resCreate = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        CANONICAL_DOMAIN: 'seguranca.raiaagentes.com.br',
        ALLOW_LOCAL_TEST: 'true',
        CLIENT_TEMP_PASSWORD: TEST_PWD_INITIAL
      },
      encoding: 'utf8'
    });

    assert.strictEqual(resCreate.status, 0, `Script deve executar com sucesso. Saída: ${resCreate.stderr || resCreate.stdout}`);
    assert.ok(
      !resCreate.stdout.includes(TEST_PWD_INITIAL) && !resCreate.stderr.includes(TEST_PWD_INITIAL),
      'A senha em texto plano NUNCA deve ser impressa em stdout ou stderr'
    );
    console.log('  ✓ 2.1 Script executou com sucesso (código 0) e senha não foi exposta');

    // Validação no SQLite
    const createdUser = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(TEST_EMAIL.toLowerCase());
    assert.ok(createdUser, 'Usuário deve existir no banco');
    assert.strictEqual(createdUser.name, 'Salão Teste RAIA');
    assert.strictEqual(createdUser.plan_tier, 'JESSICA_START');
    assert.strictEqual(createdUser.subscription_status, 'ACTIVE');
    assert.strictEqual(createdUser.is_demo, 0, 'is_demo deve ser estritamente 0');
    assert.strictEqual(createdUser.role, 'USER');
    assert.strictEqual(createdUser.subscription_origin, 'MANUAL');
    assert.ok(createdUser.password_hash && createdUser.password_salt, 'Deve possuir hash e salt scrypt');

    const paidUntil = new Date(createdUser.paid_until);
    const now = new Date();
    const daysDiff = (paidUntil - now) / (1000 * 60 * 60 * 24);
    assert.ok(daysDiff >= 6.8 && daysDiff <= 7.2, `Vigência deve ser de aproximadamente 7 dias (obtido: ${daysDiff.toFixed(2)} dias)`);
    console.log('  ✓ 2.2 Usuário gravado no SQLite: plano JESSICA_START, is_demo=0, vigência 7 dias');

    // Validação de customer_subscriptions
    const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
    const sub = db.prepare('SELECT * FROM customer_subscriptions WHERE user_id = ? AND product_id = ?').get(createdUser.id, jessica.id);
    assert.ok(sub, 'Assinatura multiproduto deve existir');
    assert.strictEqual(sub.status, 'ACTIVE');
    assert.strictEqual(sub.origin, 'MANUAL');
    assert.strictEqual(sub.gateway, 'MANUAL');
    assert.strictEqual(sub.extra_professionals, 0);

    // Validação de salão e colaboradores
    const salon = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(createdUser.id);
    assert.ok(salon, 'Salão deve existir');
    assert.strictEqual(salon.salon_name, 'Salão Teste RAIA');

    const staff = db.prepare('SELECT * FROM client_staff WHERE user_id = ?').all(createdUser.id);
    assert.strictEqual(staff.length, 1, 'Deve possuir exatamente 1 colaborador (limite do plano Entrada)');
    console.log('  ✓ 2.3 customer_subscriptions ativo e limite de 1 profissional configurado');

    // -------------------------------------------------------------
    // Teste 3: Login HTTP em /api/cliente/auth/login
    // -------------------------------------------------------------
    console.log('\n--- TESTE 3: AUTENTICAÇÃO HTTP NO PORTAL DO ASSINANTE ---');
    if (clientLoginLimiter?.reset) clientLoginLimiter.reset();

    // Tentativa com senha incorreta
    const resBadLogin = await request('POST', '/api/cliente/auth/login', {
      email: TEST_EMAIL,
      password: 'SenhaErrada#2026'
    });
    assert.strictEqual(resBadLogin.status, 401, 'Senha incorreta retorna 401');
    assert.strictEqual(resBadLogin.body.code, 'INVALID_CREDENTIALS');
    console.log('  ✓ 3.1 Tentativa com credenciais inválidas rejeitada com 401');

    // Login com senha legítima
    const resLogin = await request('POST', '/api/cliente/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PWD_INITIAL
    });
    assert.strictEqual(resLogin.status, 200, 'Login deve retornar 200 OK');
    assert.strictEqual(resLogin.body.success, true);
    assert.ok(resLogin.body.token, 'Deve retornar token de sessão');

    const authToken = resLogin.body.token;

    // Acesso ao perfil
    const resProfile = await request('GET', '/api/cliente/profile', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resProfile.status, 200);
    assert.strictEqual(resProfile.body.profile.email, TEST_EMAIL);
    assert.strictEqual(resProfile.body.profile.planTier, 'JESSICA_START');
    assert.strictEqual(resProfile.body.profile.isDemo, false, 'Perfil deve refletir isDemo=false');
    console.log('  ✓ 3.2 Login bem-sucedido e GET /api/cliente/profile retorna plano Entrada');

    // Acesso a Meus Produtos
    const resMyProducts = await request('GET', '/api/cliente/my-products', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resMyProducts.status, 200);
    assert.ok(resMyProducts.body.subscriptions.length >= 1);
    assert.strictEqual(resMyProducts.body.subscriptions[0].productCode, 'JESSICA');
    assert.strictEqual(resMyProducts.body.subscriptions[0].status, 'ACTIVE');
    console.log('  ✓ 3.3 GET /api/cliente/my-products lista produto Jéssica com status ACTIVE');

    // -------------------------------------------------------------
    // Teste 4: Reforço de Permissões de Tier (Plano Entrada vs Módulos Pró)
    // -------------------------------------------------------------
    console.log('\n--- TESTE 4: HIERARQUIA DE PLANOS (ENTRADA VS PRÓ) ---');
    const resProBills = await request('GET', '/api/cliente/pro/bills', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resProBills.status, 403, 'Acesso ao módulo financeiro PRO deve retornar 403');
    assert.strictEqual(resProBills.body.upgradeRequired, true);
    assert.strictEqual(resProBills.body.proExclusive, true);

    const resProCampaigns = await request('GET', '/api/cliente/pro/campaigns', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resProCampaigns.status, 403, 'Acesso a campanhas PRO deve retornar 403');
    console.log('  ✓ 4.1 Recursos restritos do Pró bloqueados com 403 FEATURE_NOT_IN_PLAN para plano Entrada');

    // -------------------------------------------------------------
    // Teste 5: Idempotência de Execução e Atualização de Senha
    // -------------------------------------------------------------
    console.log('\n--- TESTE 5: IDEMPOTÊNCIA E ATUALIZAÇÃO SEGURA ---');
    const resUpdate = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        CANONICAL_DOMAIN: 'seguranca.raiaagentes.com.br',
        ALLOW_LOCAL_TEST: 'true',
        CLIENT_TEMP_PASSWORD: TEST_PWD_UPDATED
      },
      encoding: 'utf8'
    });

    assert.strictEqual(resUpdate.status, 0, 'Reexecução deve ser bem-sucedida');

    // Verifica que não houve duplicação de usuário
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE LOWER(email) = ?').get(TEST_EMAIL.toLowerCase()).c;
    assert.strictEqual(userCount, 1, 'Deve existir exatamente 1 usuário com este e-mail');

    // Limpa limitador para validar nova senha e falha da antiga
    if (clientLoginLimiter?.reset) clientLoginLimiter.reset();

    // Verifica que a nova senha funciona
    const resNewLogin = await request('POST', '/api/cliente/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PWD_UPDATED
    });
    assert.strictEqual(resNewLogin.status, 200, 'Login com a nova senha deve retornar 200');

    // Antiga senha agora deve falhar
    const resOldLogin = await request('POST', '/api/cliente/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PWD_INITIAL
    });
    assert.strictEqual(resOldLogin.status, 401, 'Login com a senha anterior deve falhar com 401');
    assert.strictEqual(resOldLogin.body.code, 'INVALID_CREDENTIALS');
    console.log('  ✓ 5.1 Reexecução idempotente atualizou credenciais sem duplicar contas');

    console.log('\n================================================================');
    console.log('TODOS OS TESTES DO CLIENTE DE HOMOLOGAÇÃO FORAM APROVADOS! (100%)');
    console.log('================================================================\n');

  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

runTestSuite().catch((err) => {
  console.error('\n❌ Erro fatal na suíte:', err);
  process.exit(1);
});
