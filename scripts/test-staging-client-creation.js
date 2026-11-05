'use strict';

/**
 * RAIA AGENTES — SUÍTE DE TESTES: CRIAÇÃO DO CLIENTE DE TESTE EM HOMOLOGAÇÃO
 *
 * Validações obrigatórias:
 * 1. Combinação real de raia-staging (NODE_ENV=production + APP_MODE=staging + HOMOLOGACAO=true + BASE_URL=https://seguranca.raiaagentes.com.br) É ACEITA.
 * 2. Bloqueio explícito de configurações de produção (APP_MODE=production, PRODUCAO=true, domínio principal).
 * 3. Validação de DB_PATH com rejeição de caminhos conflitantes com serviço bot/produção.
 * 4. Validação fail-closed executada antes de qualquer acesso ao banco em createOrUpdateStagingClient().
 * 5. Bloqueio com mensagem explicativa quando process.stdin.isTTY for ausente.
 * 6. Preservação estrita de colaboradores existentes em reexecuções.
 * 7. Autenticação HTTP em /api/cliente/auth/login e restrição de recursos PRO (is_demo = 0).
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
    // Teste 1: Validação do Ambiente Real de Homologação (raia-staging)
    // -------------------------------------------------------------
    console.log('--- TESTE 1: COMPATIBILIDADE COM O AMBIENTE REAL DE STAGING ---');

    // 1.1 Configuração real exata do Easypanel:
    // NODE_ENV=production, APP_MODE=staging, HOMOLOGACAO=true, BASE_URL=https://seguranca.raiaagentes.com.br, DB_PATH=/app/data/assistant.db
    // Deve passar pela validação de ambiente sem erros
    const savedEnv = { ...process.env };
    process.env.NODE_ENV = 'production';
    process.env.APP_MODE = 'staging';
    process.env.HOMOLOGACAO = 'true';
    process.env.BASE_URL = 'https://seguranca.raiaagentes.com.br';
    process.env.DB_PATH = '/app/data/assistant.db';

    let validationPassed = false;
    try {
      validateStagingEnvironment();
      validationPassed = true;
    } catch (err) {
      validationPassed = false;
    }
    assert.strictEqual(validationPassed, true, 'A combinação oficial do raia-staging com NODE_ENV=production DEVE ser aceita');
    console.log('  ✓ 1.1 Configuração oficial do raia-staging (com NODE_ENV=production) é autorizada com sucesso');

    // Restaura ambiente
    process.env = { ...savedEnv };

    // -------------------------------------------------------------
    // Teste 2: Rejeição Rigorosa de Produção e Configurações Conflitantes
    // -------------------------------------------------------------
    console.log('\n--- TESTE 2: BLOQUEIO EXPLÍCITO DE PRODUÇÃO E CONFLITOS ---');

    // 2.1 APP_MODE=production
    const resProdAppMode = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'production',
        HOMOLOGACAO: 'true',
        BASE_URL: 'https://seguranca.raiaagentes.com.br',
        DB_PATH: '/app/data/assistant.db'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resProdAppMode.status, 1, 'APP_MODE=production deve abortar');
    assert.ok(resProdAppMode.stderr.includes('Execução em Produção Rejeitada'));
    console.log('  ✓ 2.1 APP_MODE=production é sumariamente bloqueado');

    // 2.2 PRODUCAO=true
    const resProducaoFlag = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        PRODUCAO: 'true',
        BASE_URL: 'https://seguranca.raiaagentes.com.br',
        DB_PATH: '/app/data/assistant.db'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resProducaoFlag.status, 1, 'PRODUCAO=true deve abortar');
    console.log('  ✓ 2.2 PRODUCAO=true é sumariamente bloqueado');

    // 2.3 Domínio canônico de produção
    const resProdDomain = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        BASE_URL: 'https://raiaagentes.com.br',
        DB_PATH: '/app/data/assistant.db'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resProdDomain.status, 1, 'Domínio de produção deve abortar');
    console.log('  ✓ 2.3 Domínio de produção (raiaagentes.com.br) é sumariamente bloqueado');

    // 2.4 DB_PATH conflitante apontando para volume do serviço de produção (bot)
    const resBotDb = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        BASE_URL: 'https://seguranca.raiaagentes.com.br',
        DB_PATH: '/var/lib/docker/volumes/bot-sqlite/assistant.db'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resBotDb.status, 1, 'DB_PATH de bot de produção deve abortar');
    assert.ok(resBotDb.stderr.includes('DB_PATH Conflitante com Produção'));
    console.log('  ✓ 2.4 DB_PATH conflitante com volume do serviço bot é bloqueado');

    // 2.5 DB_PATH com extensão inválida
    const resInvalidExt = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        BASE_URL: 'https://seguranca.raiaagentes.com.br',
        DB_PATH: '/app/data/assistant.txt'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resInvalidExt.status, 1, 'DB_PATH sem .db/.sqlite deve abortar');
    console.log('  ✓ 2.5 DB_PATH sem extensão de banco válida é bloqueado');

    // -------------------------------------------------------------
    // Teste 3: Validação Fail-Closed na Função Exportada
    // -------------------------------------------------------------
    console.log('\n--- TESTE 3: VALIDAÇÃO FAIL-CLOSED EM createOrUpdateStagingClient() ---');

    // Simula chamada direta em ambiente sem as 3 variáveis
    const resDirectCallSub = spawnSync(process.execPath, ['-e', `
      const { createOrUpdateStagingClient } = require('./scripts/create-staging-test-client');
      createOrUpdateStagingClient({ email: 'hack@test.com', password: 'SenhaQualquer#123' });
    `], {
      env: {
        ...process.env,
        APP_MODE: 'development',
        HOMOLOGACAO: 'false'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resDirectCallSub.status, 1, 'Chamada direta sem staging deve abortar');
    assert.ok(resDirectCallSub.stderr.includes('Ambiente Não Autorizado'));
    console.log('  ✓ 3.1 createOrUpdateStagingClient() executa validateStagingEnvironment() antes de tocar o DB');

    // -------------------------------------------------------------
    // Teste 4: Exigência de Terminal Interativo (TTY Ausente)
    // -------------------------------------------------------------
    console.log('\n--- TESTE 4: BLOQUEIO DE EXECUÇÃO NÃO INTERATIVA (SEM TTY) ---');
    const resNoTty = spawnSync(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        APP_MODE: 'staging',
        HOMOLOGACAO: 'true',
        BASE_URL: 'https://seguranca.raiaagentes.com.br',
        DB_PATH: '/app/data/assistant.db'
      },
      encoding: 'utf8'
    });
    assert.strictEqual(resNoTty.status, 1, 'Execução sem TTY deve sair com código 1');
    assert.ok(resNoTty.stderr.includes('Terminal Interativo Obrigatório (TTY Ausente)'));
    console.log('  ✓ 4.1 Bloqueio seguro sem TTY confirmado com mensagem explicativa');

    // -------------------------------------------------------------
    // Teste 5: Criação Atômica e Preservação de Dados
    // -------------------------------------------------------------
    console.log('\n--- TESTE 5: CRIAÇÃO ATÔMICA E PRESERVAÇÃO DE DADOS ---');

    // Configura o ambiente de staging para permitir execução de createOrUpdateStagingClient
    process.env.NODE_ENV = 'production';
    process.env.APP_MODE = 'staging';
    process.env.HOMOLOGACAO = 'true';
    process.env.BASE_URL = 'https://seguranca.raiaagentes.com.br';

    // Limpa registros anteriores para teste controlado
    const oldUser = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(TEST_EMAIL.toLowerCase());
    if (oldUser) {
      db.prepare('DELETE FROM client_services WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(oldUser.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(oldUser.id);
    }

    // 5.1 Criação inicial
    const result1 = createOrUpdateStagingClient({
      email: TEST_EMAIL,
      name: 'Salão Teste RAIA',
      password: TEST_PWD_INITIAL
    });
    assert.ok(result1.userId);
    assert.strictEqual(result1.planTier, 'JESSICA_START');
    assert.strictEqual(result1.staffCount, 1);

    // 5.2 Simula profissional adicional existente
    db.prepare(`
      INSERT INTO client_staff (user_id, name, specialty)
      VALUES (?, 'Segunda Profissional (Colorista)', 'Mechas e Luzes')
    `).run(result1.userId);

    // 5.3 Reexecução deve preservar ambos
    const result2 = createOrUpdateStagingClient({
      email: TEST_EMAIL,
      name: 'Salão Teste RAIA',
      password: TEST_PWD_UPDATED
    });

    const staffAfter = db.prepare('SELECT id, name FROM client_staff WHERE user_id = ?').all(result1.userId);
    assert.strictEqual(staffAfter.length, 2, 'Colaboradores existentes devem ser preservados');
    console.log('  ✓ 5.1 Reexecução preservou 100% dos colaboradores existentes');

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(result1.userId);
    assert.strictEqual(userRow.is_demo, 0, 'is_demo deve ser 0');
    assert.strictEqual(userRow.plan_tier, 'JESSICA_START');
    assert.strictEqual(userRow.subscription_status, 'ACTIVE');
    console.log('  ✓ 5.2 Usuário gravado: is_demo=0, plano JESSICA_START, status ACTIVE por 7 dias');

    // -------------------------------------------------------------
    // Teste 6: Autenticação HTTP no Portal do Assinante
    // -------------------------------------------------------------
    console.log('\n--- TESTE 6: AUTENTICAÇÃO HTTP EM /api/cliente/auth/login ---');
    if (clientLoginLimiter?.reset) clientLoginLimiter.reset();

    const resLogin = await request('POST', '/api/cliente/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PWD_UPDATED
    });
    assert.strictEqual(resLogin.status, 200);
    assert.strictEqual(resLogin.body.success, true);
    const authToken = resLogin.body.token;

    // Acesso ao perfil
    const resProfile = await request('GET', '/api/cliente/profile', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resProfile.status, 200);
    assert.strictEqual(resProfile.body.profile.email, TEST_EMAIL);
    assert.strictEqual(resProfile.body.profile.planTier, 'JESSICA_START');
    assert.strictEqual(resProfile.body.profile.isDemo, false);

    // Bloqueio de rota PRO
    const resProBills = await request('GET', '/api/cliente/pro/bills', null, {
      Authorization: `Bearer ${authToken}`
    });
    assert.strictEqual(resProBills.status, 403);
    assert.strictEqual(resProBills.body.upgradeRequired, true);
    console.log('  ✓ 6.1 Login HTTP funcional, perfil Entrada confirmado e módulo PRO bloqueado com 403');

    // Limpeza final no SQLite local de teste
    db.prepare('DELETE FROM client_services WHERE user_id = ?').run(result1.userId);
    db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(result1.userId);
    db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(result1.userId);
    db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(result1.userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(result1.userId);

    console.log('\n================================================================');
    console.log('TODAS AS VALIDAÇÕES DE AMBIENTE E SEGURANÇA FORAM APROVADAS! (100%)');
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
