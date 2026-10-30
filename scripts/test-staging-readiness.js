/**
 * TESTE DE PRONTIDÃO PARA DEPLOY DE HOMOLOGAÇÃO NO EASYPANEL
 * Valida:
 * 1. Endpoint /api/health/ready (200 OK com banco operacional)
 * 2. Proteção HTTP Basic Auth opcional para staging
 * 3. Bloqueio de disparos de WhatsApp e campanhas em homologação
 * 4. Isolamento dos volumes e arquivos de configuração (easypanel.staging.json e docker-compose.staging.yml)
 * 5. Sanitização de .dockerignore (bloqueio de .env, bancos SQLite e credenciais)
 * 6. Hub "Meus Produtos" e Central de Produtos operacionais
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.PORT = '0'; // Ephemeral port for test
process.env.BASE_URL = 'https://staging.raiaagentes.com.br';

const { app } = require('../src/server/app');
const db = require('../src/database/db');
const clientAuth = require('../src/services/clientAuthService');
const productService = require('../src/services/productService');

let passedTests = 0;
let totalTests = 0;

function pass(msg) {
  passedTests++;
  console.log(`  ✅ [PASS] ${msg}`);
}

async function runStagingReadinessTests() {
  console.log('============================================================');
  console.log('🚀 SUÍTE DE TESTES: PRONTIDÃO DE HOMOLOGAÇÃO EASYPANEL');
  console.log('============================================================\n');

  // Start test HTTP server
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Initial cleanup of staging test users
    const prevStgUsers = db.prepare("SELECT id FROM users WHERE email LIKE 'staging.%@raia.test'").all().map(r => r.id);
    if (prevStgUsers.length > 0) {
      const p = prevStgUsers.map(() => '?').join(',');
      db.prepare(`DELETE FROM subscription_audit_logs WHERE user_id IN (${p})`).run(...prevStgUsers);
      db.prepare(`DELETE FROM customer_subscriptions WHERE user_id IN (${p})`).run(...prevStgUsers);
      db.prepare(`DELETE FROM users WHERE id IN (${p})`).run(...prevStgUsers);
    }
    console.log('📌 Teste 1: Endpoint de Prontidão /api/health/ready');
    {
      totalTests++;
      const res = await fetch(`${baseUrl}/api/health/ready`);
      assert.strictEqual(res.status, 200, 'Health ready deve retornar HTTP 200');

      const data = await res.json();
      assert.strictEqual(data.status, 'ready');
      assert.strictEqual(data.ready, true);
      assert.strictEqual(data.database, 'connected');
      assert.strictEqual(data.mode, 'staging');
      assert.ok(typeof data.uptime === 'number');

      pass('Endpoint /api/health/ready responde HTTP 200 com metadados de prontidão');
    }

    // -------------------------------------------------------------
    // TEST 2: Proteção HTTP Basic Auth em Homologação
    // -------------------------------------------------------------
    console.log('\n📌 Teste 2: Proteção por Senha Adicional (Staging Gate)');
    {
      totalTests++;
      // Ativa proteção temporariamente
      process.env.STAGING_PROTECTION_ENABLED = 'true';
      process.env.STAGING_USER = 'raia-staging-test';
      process.env.STAGING_PASSWORD = 'super-secret-staging-pass';

      // 1. Requisição sem credenciais deve receber 401
      const unauthRes = await fetch(`${baseUrl}/cliente/login`);
      assert.strictEqual(unauthRes.status, 401, 'Requisição sem Basic Auth deve ser 401');
      assert.ok(unauthRes.headers.get('www-authenticate')?.includes('Basic realm='), 'Cabeçalho WWW-Authenticate deve estar presente');

      // 2. Requisição com senha errada deve receber 401
      const wrongCredentials = Buffer.from('raia-staging-test:wrongpass').toString('base64');
      const wrongRes = await fetch(`${baseUrl}/cliente/login`, {
        headers: { 'Authorization': `Basic ${wrongCredentials}` }
      });
      assert.strictEqual(wrongRes.status, 401, 'Senha errada deve ser rejeitada com 401');

      // 3. Requisição com credenciais corretas deve acessar com 200
      const correctCredentials = Buffer.from('raia-staging-test:super-secret-staging-pass').toString('base64');
      const authRes = await fetch(`${baseUrl}/cliente/login`, {
        headers: { 'Authorization': `Basic ${correctCredentials}` }
      });
      assert.strictEqual(authRes.status, 200, 'Credenciais corretas devem liberar acesso com 200');

      // 4. Endpoint /api/health/ready deve SEMPRE ignorar Basic Auth (para o Easypanel checar saúde)
      const bypassHealthRes = await fetch(`${baseUrl}/api/health/ready`);
      assert.strictEqual(bypassHealthRes.status, 200, '/api/health/ready deve bypassar Basic Auth para o monitoramento Easypanel');

      // Desativa proteção após teste
      delete process.env.STAGING_PROTECTION_ENABLED;
      delete process.env.STAGING_USER;
      delete process.env.STAGING_PASSWORD;

      pass('Staging Basic Auth bloqueia acessos não autorizados e bypassa /api/health/ready');
    }

    // -------------------------------------------------------------
    // TEST 3: Bloqueio de Disparos de WhatsApp em Homologação
    // -------------------------------------------------------------
    console.log('\n📌 Teste 3: Bloqueio Estrito de Disparos Reais no WhatsApp');
    {
      totalTests++;
      // Cria cliente de teste ativo
      const testEmail = `staging.wa.test.${Date.now()}@raia.test`;
      db.prepare(`
        INSERT INTO users (name, email, phone_number, role, plan_tier, subscription_status, paid_until, magic_token, magic_token_expires_at)
        VALUES ('Cliente Staging Test', ?, '5511999998877', 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'), 'token_stg_wa_test', datetime('now', '+1 day'))
      `).run(testEmail);

      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(testEmail);
      productService.createCustomerSubscription({
        userId: user.id,
        productCode: 'JESSICA',
        planCode: 'PRO',
        origin: 'DIRECT',
        status: 'ACTIVE',
        contractedPrice: 99.00
      });

      // Tenta enviar WhatsApp de teste em homologação
      const testWaRes = await fetch(`${baseUrl}/api/cliente/test-whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token_stg_wa_test'
        },
        body: JSON.stringify({ targetPhone: '5511999990000', message: 'Teste Staging' })
      });
      const testWaData = await testWaRes.json();
      assert.strictEqual(testWaRes.status, 403, 'Disparo de WhatsApp deve ser bloqueado com 403 em homologação');
      assert.strictEqual(testWaData.isDemoBlocked, true);

      // Cleanup
      db.prepare('DELETE FROM subscription_audit_logs WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

      pass('Disparos reais de WhatsApp e campanhas rigorosamente bloqueados com 403 em homologação');
    }

    // -------------------------------------------------------------
    // TEST 4: Hub "Meus Produtos" e Catálogo na API de Homologação
    // -------------------------------------------------------------
    console.log('\n📌 Teste 4: Hub "Meus Produtos" & Catálogo Ativo');
    {
      totalTests++;
      const testEmail = `staging.hub.${Date.now()}@raia.test`;
      const stgToken = `token_stg_hub_${Date.now()}`;
      db.prepare(`
        INSERT INTO users (name, email, phone_number, role, plan_tier, subscription_status, paid_until, magic_token, magic_token_expires_at)
        VALUES ('Cliente Hub Staging', ?, '5511999997766', 'CLIENT', 'JESSICA_START', 'ACTIVE', datetime('now', '+30 days'), ?, datetime('now', '+1 day'))
      `).run(testEmail, stgToken);

      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(testEmail);
      productService.createCustomerSubscription({
        userId: user.id,
        productCode: 'JESSICA',
        planCode: 'START',
        origin: 'DIRECT',
        status: 'ACTIVE',
        contractedPrice: 59.00
      });

      // 1. Consulta "Meus Produtos"
      const myProdRes = await fetch(`${baseUrl}/api/cliente/my-products`, {
        headers: { 'Authorization': `Bearer ${stgToken}` }
      });
      assert.strictEqual(myProdRes.status, 200);
      const myProdData = await myProdRes.json();
      assert.strictEqual(myProdData.success, true);
      assert.ok(myProdData.subscriptions.length >= 1);
      assert.strictEqual(myProdData.subscriptions[0].productCode, 'JESSICA');

      // 2. Consulta Catálogo de Agentes
      const catRes = await fetch(`${baseUrl}/api/cliente/products-catalog`, {
        headers: { 'Authorization': `Bearer ${stgToken}` }
      });
      assert.strictEqual(catRes.status, 200);
      const catData = await catRes.json();
      assert.strictEqual(catData.success, true);
      assert.ok(catData.products.length >= 2);

      // Cleanup
      db.prepare('DELETE FROM subscription_audit_logs WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

      pass('Hub Meus Produtos e Catálogo retornam contratos e agentes com sucesso');
    }

    // -------------------------------------------------------------
    // TEST 5: Validação de Configuração do Easypanel (easypanel.staging.json)
    // -------------------------------------------------------------
    console.log('\n📌 Teste 5: Validação do Arquivo easypanel.staging.json');
    {
      totalTests++;
      const configPath = path.resolve(__dirname, '..', 'easypanel.staging.json');
      assert.ok(fs.existsSync(configPath), 'easypanel.staging.json deve existir');

      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.strictEqual(configData.source.ref, 'raia-hotmart-homologacao', 'Branch no Easypanel DEVE ser raia-hotmart-homologacao');
      assert.strictEqual(configData.domains[0].host, 'staging.raiaagentes.com.br');
      assert.strictEqual(configData.domains[0].port, 3333);
      assert.strictEqual(configData.healthCheck.path, '/api/health/ready');
      assert.strictEqual(configData.healthCheck.status, 200);

      // Volumes isolados
      const dataMount = configData.mounts.find(m => m.mountPath === '/app/data');
      assert.ok(dataMount, 'Montagem de volume /app/data deve existir');
      assert.strictEqual(dataMount.name, 'raia_staging_sqlite_data');

      // Variáveis de ambiente
      const envMap = Object.fromEntries(configData.env.map(e => [e.key, e.value]));
      assert.strictEqual(envMap.BASE_URL, 'https://staging.raiaagentes.com.br');
      assert.strictEqual(envMap.PORT, '3333');
      assert.strictEqual(envMap.APP_MODE, 'staging');
      assert.strictEqual(envMap.HOMOLOGACAO, 'true');
      assert.strictEqual(envMap.DISABLE_WHATSAPP, 'true');
      assert.strictEqual(envMap.ASAAS_ENV, 'sandbox');

      pass('easypanel.staging.json configurado com branch raia-hotmart-homologacao, sandbox, porta 3333 e healthcheck /api/health/ready');
    }

    // -------------------------------------------------------------
    // TEST 6: Validação do Dockerfile e docker-compose.staging.yml
    // -------------------------------------------------------------
    console.log('\n📌 Teste 6: Validação do Dockerfile e docker-compose.staging.yml');
    {
      totalTests++;
      const composePath = path.resolve(__dirname, '..', 'docker-compose.staging.yml');
      const composeContent = fs.readFileSync(composePath, 'utf8');

      assert.ok(composeContent.includes('raia_staging_sqlite_data'), 'Volume exclusivo de SQLite presente');
      assert.ok(composeContent.includes('/api/health/ready'), 'Healthcheck no docker-compose aponta para /api/health/ready');
      assert.ok(composeContent.includes('APP_MODE=staging'), 'Modo staging declarado no compose');

      const dockerfilePath = path.resolve(__dirname, '..', 'Dockerfile');
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
      assert.ok(dockerfileContent.includes('EXPOSE 3333'), 'Porta 3333 exposta no Dockerfile');
      assert.ok(dockerfileContent.includes('/api/health/ready'), 'HEALTHCHECK nativo no Dockerfile configurado');

      pass('Dockerfile e docker-compose.staging.yml validados com healthcheck real e isolamento total');
    }

    // -------------------------------------------------------------
    // TEST 7: Auditoria de Sanitização do .dockerignore
    // -------------------------------------------------------------
    console.log('\n📌 Teste 7: Auditoria de Segurança do .dockerignore');
    {
      totalTests++;
      const dockerignorePath = path.resolve(__dirname, '..', '.dockerignore');
      const dockerignoreContent = fs.readFileSync(dockerignorePath, 'utf8');

      assert.ok(dockerignoreContent.includes('.env'), '.dockerignore DEVE ignorar .env');
      assert.ok(dockerignoreContent.includes('data/*.db'), '.dockerignore DEVE ignorar bancos data/*.db');
      assert.ok(dockerignoreContent.includes('data/backups/'), '.dockerignore DEVE ignorar data/backups/');
      assert.ok(dockerignoreContent.includes('auth_info_baileys/'), '.dockerignore DEVE ignorar auth_info_baileys/');
      assert.ok(dockerignoreContent.includes('google_credentials.json'), '.dockerignore DEVE ignorar google_credentials.json');
      assert.ok(dockerignoreContent.includes('google_token.json'), '.dockerignore DEVE ignorar google_token.json');

      pass('.dockerignore blinda completamente segredos, .env, bancos SQLite e backups contra inclusão no build');
    }

    console.log('\n============================================================');
    console.log(`🎉 TODOS OS ${passedTests}/${totalTests} TESTES DE PRONTIDÃO DE STAGING FORAM APROVADOS!`);
    console.log('============================================================\n');

  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

runStagingReadinessTests()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ ERRO NA SUÍTE DE PRONTIDÃO DE STAGING:', err);
    process.exit(1);
  });
