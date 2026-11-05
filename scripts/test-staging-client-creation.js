'use strict';

/**
 * RAIA AGENTES — SUÍTE DE TESTES: CRIAÇÃO DO CLIENTE DE TESTE EM HOMOLOGAÇÃO
 *
 * Valida:
 * 1. Proteção de ambiente: exigência simultânea de:
 *    - APP_MODE=staging
 *    - HOMOLOGACAO=true
 *    - BASE_URL=https://seguranca.raiaagentes.com.br
 * 2. Rejeição explícita de ambiente de produção e eliminação de ALLOW_LOCAL_TEST.
 * 3. Interrupção segura com mensagem explicativa quando process.stdin.isTTY não estiver disponível.
 * 4. Preservação de colaboradores e registros existentes (sem exclusão automática).
 * 5. Criação atômica com hash scrypt + salt, is_demo = 0 e plano JESSICA_START.
 * 6. Autenticação HTTP em /api/cliente/auth/login e acesso ao Portal.
 * 7. Bloqueio correto de recursos PRO (reforço de restrição de tier).
 */

const assert = require('assert');
const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');
const db = require('../src/database/db');
const { app } = require('../src/server/app');
const { clientLoginLimiter } = require('../src/middlewares/rateLimiter');
const {
  validateStagingEnvironment,
  createOrUpdateStagingClient
} = require('./create-staging-test-client');

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
    // Teste 1: Proteção Estrita e Simultânea do Ambiente
    // -------------------------------------------------------------
    console.log('--- TESTE 1: PROTEÇÃO SIMULTÂNEA DO AMBIENTE (3 VARIÁVEIS) ---');

    // 1.1 Tentativa com APP_MODE=production
    const resProd = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'production',
        HOMOLOGACAO: 'true',
        BASE_URL: 'https://seguranca.raiaagentes.com.br'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resProd.status, 1, 'Deve abortar se APP_MODE for production');
    assert.ok(
      resProd.stderr.includes('Execução em Produção Rejeitada') || resProd.stdout.includes('Execução em Produção Rejeitada'),
      'Deve exibir mensagem de rejeição de produção'
    );
    console.log('  ✓ 1.1 Bloqueio de produção (APP_MODE=production) confirmado');

    // 1.2 Tentativa sem BASE_URL de staging
    const resBadUrl = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        BASE_URL: 'https://raiaagentes.com.br'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resBadUrl.status, 1, 'Deve abortar se BASE_URL for de produção');
    console.log('  ✓ 1.2 Bloqueio de BASE_URL não autorizada confirmado');

    // 1.3 Tentativa com ALLOW_LOCAL_TEST sem as 3 variáveis
    const resBypassAttempt = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'development',
        HOMOLOGACAO: 'false',
        BASE_URL: 'http://localhost:3333',
        ALLOW_LOCAL_TEST: 'true'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resBypassAttempt.status, 1, 'ALLOW_LOCAL_TEST não pode contornar a validação');
    console.log('  ✓ 1.3 Impossibilidade de contornar por ALLOW_LOCAL_TEST confirmada');

    // 1.4 Tentativa com HOMOLOGACAO=false
    const resHomolFalse = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'false',
        BASE_URL: 'https://seguranca.raiaagentes.com.br'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resHomolFalse.status, 1, 'Deve abortar se HOMOLOGACAO não for true');
    console.log('  ✓ 1.4 Exigência simultânea de HOMOLOGACAO=true confirmada');

    // -------------------------------------------------------------
    // Teste 2: Exigência de Terminal Interativo (TTY Ausente)
    // -------------------------------------------------------------
    console.log('\n--- TESTE 2: BLOQUEIO DE EXECUÇÃO NÃO INTERATIVA (SEM TTY) ---');
    // Quando executado via spawnSync sem TTY alocado, deve interromper com a mensagem explicativa
    const resNoTty = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        BASE_URL: 'https://seguranca.raiaagentes.com.br'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resNoTty.status, 1, 'Execução sem TTY deve sair com código 1');
    assert.ok(
      resNoTty.stderr.includes('Terminal Interativo Obrigatório (TTY Ausente)'),
      'Deve exibir mensagem explicando que TTY interativo é obrigatório'
    );
    console.log('  ✓ 2.1 Bloqueio seguro sem TTY confirmado com mensagem explicativa');

    // -------------------------------------------------------------
    // Teste 3: Preservação de Dados Existentes (Colaboradores / Salão)
    // -------------------------------------------------------------
    console.log('\n--- TESTE 3: PRESERVAÇÃO DE DADOS E NÃO EXCLUSÃO DE PROFISSIONAIS ---');

    // Limpa registros anteriores para teste controlado
    const oldUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(TEST_EMAIL.toLowerCase());
    if (oldUser) {
      db.prepare('DELETE FROM client_services WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(oldUser.id);
    }

    // 3.1 Criação inicial
    const result1 = createOrUpdateStagingClient({
      email: TEST_EMAIL,
      name: 'Salão Teste RAIA',
      password: TEST_PWD_INITIAL
    });
    assert.ok(result1.userId, 'Usuário criado com sucesso');
    assert.strictEqual(result1.planTier, 'JESSICA_START');
    assert.strictEqual(result1.staffCount, 1, 'Inicialmente possui 1 profissional');

    // 3.2 Simula adição manual de um 2º colaborador pré-existente
    db.prepare(`
      INSERT INTO client_staff (user_id, name, specialty)
      VALUES (?, 'Segunda Profissional (Colorista)', 'Mechas e Luzes')
    `).run(result1.userId);

    const staffBeforeReexec = db.prepare('SELECT id, name FROM client_staff WHERE user_id = ?').all(result1.userId);
    assert.strictEqual(staffBeforeReexec.length, 2, 'Agora possui 2 profissionais');

    // 3.3 Reexecuta createOrUpdateStagingClient: DEVE PRESERVAR os 2 profissionais sem excluir nenhum
    const result2 = createOrUpdateStagingClient({
      email: TEST_EMAIL,
      name: 'Salão Teste RAIA',
      password: TEST_PWD_UPDATED
    });

    const staffAfterReexec = db.prepare('SELECT id, name FROM client_staff WHERE user_id = ?').all(result1.userId);
    assert.strictEqual(staffAfterReexec.length, 2, 'Os 2 profissionais devem permanecer no banco intactos');
    console.log('  ✓ 3.1 Reexecução preservou 100% dos colaboradores existentes sem exclusão');

    // Validação no SQLite
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(result1.userId);
    assert.strictEqual(userRow.is_demo, 0, 'is_demo deve ser estritamente 0');
    assert.strictEqual(userRow.plan_tier, 'JESSICA_START');
    assert.strictEqual(userRow.subscription_status, 'ACTIVE');
    assert.ok(userRow.password_hash && userRow.password_salt);
    console.log('  ✓ 3.2 Registro no SQLite verificado: is_demo=0, plano JESSICA_START, hash scrypt + salt');

    // -------------------------------------------------------------
    // Teste 4: Autenticação HTTP no Portal do Assinante
    // -------------------------------------------------------------
    console.log('\n--- TESTE 4: AUTENTICAÇÃO HTTP EM /api/cliente/auth/login ---');
    if (clientLoginLimiter?.reset) clientLoginLimiter.reset();

    // 4.1 Login com nova senha (sucesso)
    const resLogin = await request('POST', '/api/cliente/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PWD_UPDATED
    });
    assert.strictEqual(resLogin.status, 200, 'Login deve retornar 200 OK');
    assert.strictEqual(resLogin.body.success, true);
    assert.ok(resLogin.body.token, 'Deve retornar token de sessão');
    const authToken = resLogin.body.token;

    // 4.2 Login com senha antiga (deve falhar com 401)
    if (clientLoginLimiter?.reset) clientLoginLimiter.reset();
    const resOldLogin = await request('POST', '/api/cliente/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PWD_INITIAL
    });
    assert.strictEqual(resOldLogin.status, 401, 'Senha antiga deve ser rejeitada com 401');
    assert.strictEqual(resOldLogin.body.code, 'INVALID_CREDENTIALS');
    console.log('  ✓ 4.1 Autenticação HTTP válida com nova senha e rejeição de senha anterior');

    // 4.3 Acesso ao perfil
    const resProfile = await request('GET', '/api/cliente/profile', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resProfile.status, 200);
    assert.strictEqual(resProfile.body.profile.email, TEST_EMAIL);
    assert.strictEqual(resProfile.body.profile.planTier, 'JESSICA_START');
    assert.strictEqual(resProfile.body.profile.isDemo, false);

    // 4.4 Acesso aos produtos contratados
    const resMyProducts = await request('GET', '/api/cliente/my-products', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resMyProducts.status, 200);
    assert.ok(resMyProducts.body.subscriptions.length >= 1);
    assert.strictEqual(resMyProducts.body.subscriptions[0].productCode, 'JESSICA');
    assert.strictEqual(resMyProducts.body.subscriptions[0].status, 'ACTIVE');
    console.log('  ✓ 4.2 Perfil e Meus Produtos confirmam plano Jéssica Entrada ativo');

    // -------------------------------------------------------------
    // Teste 5: Hierarquia e Restrição de Tier (Plano Entrada vs Módulo Pró)
    // -------------------------------------------------------------
    console.log('\n--- TESTE 5: HIERARQUIA DE PLANOS (IS_DEMO=0 BLOQUEIA MÓDULOS PRÓ) ---');
    const resProBills = await request('GET', '/api/cliente/pro/bills', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resProBills.status, 403, 'Módulo Contas a Pagar PRO deve retornar 403');
    assert.strictEqual(resProBills.body.upgradeRequired, true);
    assert.strictEqual(resProBills.body.proExclusive, true);

    const resProCampaigns = await request('GET', '/api/cliente/pro/campaigns', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resProCampaigns.status, 403, 'Disparos em massa PRO devem retornar 403');
    console.log('  ✓ 5.1 Recursos PRO estritamente bloqueados com 403 upgradeRequired para assinante Entrada');

    // Limpeza final do usuário de teste no SQLite de desenvolvimento
    db.prepare('DELETE FROM client_services WHERE user_id = ?').run(result1.userId);
    db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(result1.userId);
    db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(result1.userId);
    db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(result1.userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(result1.userId);

    console.log('\n================================================================');
    console.log('TODOS OS TESTES DO AJUSTE FINAL FORAM APROVADOS! (100%)');
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
