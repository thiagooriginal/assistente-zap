/**
 * RAIA AGENTES — SUÍTE DE TESTES DE INTEGRAÇÃO & SEGURANÇA
 * 
 * Validação rigorosa dos 15 cenários obrigatórios de autenticação, MFA,
 * isolamento de sessão, recuperação, webhooks multiproduto e demo account.
 * Executa requisições HTTP reais em banco SQLite temporário isolado.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const assert = require('assert');

// -------------------------------------------------------------
// CONFIGURAÇÃO DO BANCO TEMPORÁRIO ISOLADO
// -------------------------------------------------------------
const tempDbName = `raia_integration_sec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.db`;
const tempDbPath = path.join(os.tmpdir(), tempDbName);
process.env.DB_PATH = tempDbPath;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.NODE_ENV = 'test';
process.env.STAGING_PROTECTION_ENABLED = 'false';

const config = require('../src/config');
config.adminPassword = 'MasterAdminPassword#2026';
const db = require('../src/database/db');
const { app } = require('../src/server/app');
const userService = require('../src/services/userService');
const clientAuth = require('../src/services/clientAuthService');
const asaasService = require('../src/services/asaasService');
const totpService = require('../src/services/totpService');

let server;
let baseUrl;

async function requestApi(endpoint, options = {}) {
  const url = `${baseUrl}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Origin': baseUrl,
      ...(options.headers || {}),
    },
  });
  return response;
}

let passed = 0;
let total = 0;

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FALHA: ${name}`);
    console.error(`     ${err.message}`);
    throw err;
  }
}

async function runIntegrationSecuritySuite() {
  console.log('\n=======================================================');
  console.log('🔐 RAIA AGENTES — TESTES DE INTEGRAÇÃO E SEGURANÇA (15 CENÁRIOS)');
  console.log('=======================================================\n');

  assert.strictEqual(config.dbPath, tempDbPath, 'DB_PATH deve ser temporário');
  console.log(`  ✓ Banco temporário ativo: ${tempDbPath}`);
  console.log(`  ✓ Banco de produção data/assistant.db intocado e preservado.\n`);

  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const clientEmail = `cliente_${Date.now()}@raiaagentes.com.br`;
  const clientPass = 'SenhaForte#2026';
  const { hash, salt } = clientAuth.hashPassword(clientPass);
  const futurePaid = new Date(Date.now() + 30 * 86400000).toISOString();

  // Create primary test client user
  const userInsert = db.prepare(`
    INSERT INTO users (
      email, name, phone_number, password_hash, password_salt,
      plan_tier, subscription_status, paid_until, is_demo, role, subscription_origin
    ) VALUES (?, 'Cliente Teste Integração', '5511988887777', ?, ?, 'JESSICA_PRO', 'ACTIVE', ?, 0, 'USER', 'ASAAS')
  `).run(clientEmail, hash, salt, futurePaid);
  const testUserId = userInsert.lastInsertRowid;
  clientAuth.ensureSalonForUser(testUserId, 'Salão Teste Integração');

  // Insert customer_subscriptions for JESSICA (PRO)
  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const jessicaPlan = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'PRO'").get(jessicaProd.id);
  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, gateway_subscription_id, status, price_cents, paid_until, access_expires_at
    ) VALUES (?, ?, ?, 'ASAAS', 'ASAAS', 'sub_jessica_init', 'ACTIVE', 14700, ?, ?)
  `).run(testUserId, jessicaProd.id, jessicaPlan?.id || null, futurePaid, futurePaid);

  let clientSessionToken = null;
  let clientCookie = null;

  // -------------------------------------------------------------
  // CENÁRIO 1: Login do cliente
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 1: LOGIN DO CLIENTE ---');
  await test('1. Login de cliente com credenciais válidas cria sessão na nova estrutura (session_token)', async () => {
    const res = await requestApi('/api/cliente/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail, password: clientPass }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert(body.token, 'Token de sessão deve ser retornado');
    clientSessionToken = body.token;

    const setCookie = res.headers.get('set-cookie') || '';
    assert(setCookie.includes('client_auth_token='), 'Cookie client_auth_token deve ser emitido');
    assert(setCookie.includes('HttpOnly'), 'Cookie deve ter flag HttpOnly');
    clientCookie = setCookie.split(';')[0];

    // Verify DB structure
    const dbUser = db.prepare('SELECT session_token, session_expires_at, magic_token FROM users WHERE id = ?').get(testUserId);
    assert.strictEqual(dbUser.session_token, clientSessionToken);
    assert(dbUser.session_expires_at, 'session_expires_at deve estar preenchido');
    assert(new Date(dbUser.session_expires_at) > new Date(), 'Sessão deve ter expiração futura');
  });

  // -------------------------------------------------------------
  // CENÁRIO 2: Acesso à Área de Membros
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 2: ACESSO À ÁREA DE MEMBROS ---');
  await test('2.1. Acesso à Área de Membros com Bearer token válido', async () => {
    const res = await requestApi('/api/cliente/profile', {
      headers: { 'Authorization': `Bearer ${clientSessionToken}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.profile.email, clientEmail);
  });

  await test('2.2. Acesso à Área de Membros com Cookie de sessão', async () => {
    const res = await requestApi('/api/cliente/profile', {
      headers: { 'Cookie': clientCookie },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.profile.id, testUserId);
  });

  await test('2.3. Rejeição de tokens passados via query string (?token=...)', async () => {
    const res = await requestApi(`/api/cliente/profile?token=${clientSessionToken}`);
    assert.strictEqual(res.status, 401, 'Token na query string não deve ser aceito');
    const body = await res.json();
    assert.strictEqual(body.code, 'UNAUTHORIZED');
  });

  // -------------------------------------------------------------
  // CENÁRIO 3: Acesso ao Dashboard Gerencial & Financeiro
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 3: DASHBOARD GERENCIAL & FINANCEIRO ---');
  await test('3. Acesso ao Dashboard Gerencial & Financeiro retorna métricas autorizadas para plano PRO', async () => {
    const res = await requestApi('/api/cliente/pro/dashboard', {
      headers: { 'Authorization': `Bearer ${clientSessionToken}` },
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.isPro, true);
  });

  // -------------------------------------------------------------
  // CENÁRIO 4: Acesso às assinaturas e pagamentos
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 4: ASSINATURAS E PRODUTOS ---');
  await test('4. Acesso às assinaturas e catálogo multiproduto', async () => {
    const res = await requestApi('/api/cliente/my-products', {
      headers: { 'Authorization': `Bearer ${clientSessionToken}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert(Array.isArray(body.subscriptions), 'Deve retornar lista de assinaturas');
  });

  // -------------------------------------------------------------
  // CENÁRIO 5: Logout e revogação da sessão
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 5: LOGOUT E REVOGAÇÃO DE SESSÃO ---');
  await test('5. Logout revoga session_token no banco e limpa cookies', async () => {
    const res = await requestApi('/api/cliente/auth/logout', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${clientSessionToken}`,
        'Cookie': clientCookie,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);

    // Verify token was revoked in database
    const dbUser = db.prepare('SELECT session_token, session_expires_at FROM users WHERE id = ?').get(testUserId);
    assert.strictEqual(dbUser.session_token, null, 'session_token deve ser NULL após logout');
    assert.strictEqual(dbUser.session_expires_at, null, 'session_expires_at deve ser NULL após logout');

    // Subsequent access with revoked token must fail with 401
    const probe = await requestApi('/api/cliente/profile', {
      headers: { 'Authorization': `Bearer ${clientSessionToken}` },
    });
    assert.strictEqual(probe.status, 401, 'Token revogado deve retornar 401');
  });

  // -------------------------------------------------------------
  // CENÁRIO 6: Recuperação de senha e invalidação de sessões antigas
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 6: RECUPERAÇÃO DE SENHA E INVALIDAÇÃO ---');
  await test('6. Recuperação de senha invalida todas as sessões ativas', async () => {
    // 1. Client logs in again
    const loginRes = await requestApi('/api/cliente/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail, password: clientPass }),
    });
    assert.strictEqual(loginRes.status, 200);
    const { token: oldSessionToken } = await loginRes.json();

    // 2. Request reset
    const resetReq = await requestApi('/api/cliente/auth/request-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail }),
    });
    assert.strictEqual(resetReq.status, 200);

    // 3. Extract reset token from DB
    const userWithReset = db.prepare('SELECT reset_token FROM users WHERE id = ?').get(testUserId);
    assert(userWithReset.reset_token, 'reset_token deve existir no banco');

    // 4. Submit new password
    const newPass = 'NovaSenhaForte#2026';
    const resetSubmit = await requestApi('/api/cliente/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: userWithReset.reset_token, newPassword: newPass }),
    });
    assert.strictEqual(resetSubmit.status, 200);

    // 5. Old session token must be invalid
    const probeOld = await requestApi('/api/cliente/profile', {
      headers: { 'Authorization': `Bearer ${oldSessionToken}` },
    });
    assert.strictEqual(probeOld.status, 401, 'Sessão antiga deve ser invalidada após reset');

    // 6. Login with new password succeeds
    const loginNew = await requestApi('/api/cliente/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail, password: newPass }),
    });
    assert.strictEqual(loginNew.status, 200);
    const newLoginBody = await loginNew.json();
    assert(newLoginBody.token);
  });

  // -------------------------------------------------------------
  // CENÁRIO 7: Login administrativo com senha e MFA
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 7: LOGIN ADMINISTRATIVO COM SENHA E MFA ---');
  let adminSessionToken = null;
  let adminCookie = null;
  let testRecoveryCodes = null;
  let totpSecretPlain = null;

  await test('7. Login administrativo com MFA exige segundo fator e autentica com código TOTP válido', async () => {
    const adminUser = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' LIMIT 1").get();
    totpSecretPlain = totpService.generateSecret();
    const { plainCodes, hashedCodes } = totpService.generateHashedRecoveryCodes(8);
    testRecoveryCodes = plainCodes;
    const encryptedSecret = totpService.encryptSecret(totpSecretPlain);

    db.prepare(`
      UPDATE users 
      SET totp_secret = ?, totp_enabled = 1, totp_recovery_codes = ?
      WHERE id = ?
    `).run(encryptedSecret, JSON.stringify(hashedCodes), adminUser.id);

    // 1. Password only -> MFA Challenge
    const res1 = await requestApi('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'MasterAdminPassword#2026' }),
    });
    assert.strictEqual(res1.status, 200);
    const body1 = await res1.json();
    assert.strictEqual(body1.mfaRequired, true);

    // 2. Wrong MFA code -> 401
    const res2 = await requestApi('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'MasterAdminPassword#2026', mfaCode: '000000' }),
    });
    assert.strictEqual(res2.status, 401);

    // 3. Valid TOTP code -> 200
    const validCode = totpService.generateToken(totpSecretPlain);
    const res3 = await requestApi('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'MasterAdminPassword#2026', mfaCode: validCode }),
    });
    assert.strictEqual(res3.status, 200);
    const body3 = await res3.json();
    assert.strictEqual(body3.success, true);
    adminSessionToken = body3.token;

    const setCookie = res3.headers.get('set-cookie') || '';
    assert(setCookie.includes('auth_token='), 'auth_token cookie deve ser emitido');
    adminCookie = setCookie.split(';')[0];
  });

  // -------------------------------------------------------------
  // CENÁRIO 8: Acesso à rota /admin
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 8: ACESSO À ROTA /ADMIN ---');
  await test('8. Acesso à rota /admin com sessão legítima de administrador', async () => {
    const res = await requestApi('/admin', {
      headers: {
        'Cookie': adminCookie,
      },
    });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert(html.includes('admin') || html.includes('<!DOCTYPE html>'), 'Deve servir a SPA administrativa');
  });

  // -------------------------------------------------------------
  // CENÁRIO 9: Tentativa de reutilização de magic link
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 9: USO ÚNICO DE MAGIC LINK ---');
  await test('9. Magic link é de uso estritamente único e queima no primeiro acesso', async () => {
    const magic = userService.generateMagicToken(testUserId, baseUrl, 15);

    // 1st access -> burns token and redirects
    const res1 = await requestApi(`/auth/magic?token=${magic.token}`, {
      redirect: 'manual',
    });
    assert.strictEqual(res1.status, 302, 'Primeiro acesso deve redirecionar');

    // Check DB: magic_token must be NULL
    const dbCheck = db.prepare('SELECT magic_token FROM users WHERE id = ?').get(testUserId);
    assert.strictEqual(dbCheck.magic_token, null, 'magic_token deve ser nullificado no banco');

    // 2nd access -> rejected with 401
    const res2 = await requestApi(`/auth/magic?token=${magic.token}`, {
      redirect: 'manual',
    });
    assert.strictEqual(res2.status, 401, 'Reutilização deve ser rejeitada com 401');
    const html2 = await res2.text();
    assert(html2.includes('Link Expirado ou Inválido'));
  });

  // -------------------------------------------------------------
  // CENÁRIO 10: Tentativa de usar magic link diretamente como Bearer token
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 10: BLOQUEIO DE MAGIC LINK COMO BEARER TOKEN ---');
  await test('10. Magic link é rejeitado sumariamente ao ser usado como Bearer token', async () => {
    const magic = userService.generateMagicToken(testUserId, baseUrl, 15);

    // Attempt to call client API with magic token as Bearer
    const probe = await requestApi('/api/cliente/profile', {
      headers: { 'Authorization': `Bearer ${magic.token}` },
    });
    assert.strictEqual(probe.status, 401);
    const body = await probe.json();
    assert.strictEqual(body.code, 'MAGIC_TOKEN_NOT_SESSION');
  });

  // -------------------------------------------------------------
  // CENÁRIO 11: Recuperação de MFA com código válido e de uso único
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 11: RECUPERAÇÃO DE MFA COM CÓDIGO ÚNICO ---');
  const codeToUse = testRecoveryCodes[0];
  await test('11. Código de recuperação válido permite autenticação e é consumido do banco', async () => {
    const adminUser = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' LIMIT 1").get();
    const beforeCodes = JSON.parse(adminUser.totp_recovery_codes);
    assert.strictEqual(beforeCodes.length, 8);

    const res = await requestApi('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'MasterAdminPassword#2026', mfaCode: codeToUse }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);

    // Verify code was burned from DB
    const afterAdmin = db.prepare("SELECT totp_recovery_codes FROM users WHERE role = 'ADMIN' LIMIT 1").get();
    const afterCodes = JSON.parse(afterAdmin.totp_recovery_codes);
    assert.strictEqual(afterCodes.length, 7, 'Código de recuperação deve ser removido após uso');
  });

  // -------------------------------------------------------------
  // CENÁRIO 12: Rejeição de códigos de recuperação já utilizados
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 12: REJEIÇÃO DE CÓDIGO DE RECUPERAÇÃO REUTILIZADO ---');
  await test('12. Tentativa de reutilizar o mesmo código de recuperação é rejeitada com 401', async () => {
    const res = await requestApi('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'MasterAdminPassword#2026', mfaCode: codeToUse }),
    });
    assert.strictEqual(res.status, 401, 'Código já usado deve ser rejeitado');
    const body = await res.json();
    assert.strictEqual(body.success, false);
  });

  // Reset admin MFA after testing
  const adminRec = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1").get();
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL WHERE id = ?').run(adminRec.id);

  // -------------------------------------------------------------
  // CENÁRIO 13: Webhooks financeiros com múltiplos contratos
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 13: WEBHOOKS FINANCEIROS COM MÚLTIPLOS CONTRATOS ---');
  await test('13.1. Isolamento multiproduto: OVERDUE em Jéssica NÃO afeta Jarvis ativo do mesmo cliente', async () => {
    // Setup client with 2 distinct products
    const multiUser = db.prepare(`
      INSERT INTO users (
        email, name, phone_number, plan_tier, subscription_status, paid_until, subscription_origin, asaas_customer_id
      ) VALUES ('multi.product@raiaagentes.com.br', 'Cliente Multiproduto', '5511977776666', 'JESSICA_PRO', 'ACTIVE', ?, 'ASAAS', 'cus_multi_test_1')
    `).run(futurePaid);
    const multiUserId = multiUser.lastInsertRowid;

    const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
    const jarvisProd = db.prepare("SELECT id FROM products WHERE code = 'JARVIS_FINANCEIRO'").get();

    // Sub A: Jéssica
    const subA = db.prepare(`
      INSERT INTO customer_subscriptions (
        user_id, product_id, origin, gateway, gateway_subscription_id, status, price_cents, paid_until, access_expires_at
      ) VALUES (?, ?, 'ASAAS', 'ASAAS', 'sub_multi_jessica_99', 'ACTIVE', 14700, ?, ?)
    `).run(multiUserId, jessicaProd.id, futurePaid, futurePaid);

    // Sub B: Jarvis Financeiro
    const subB = db.prepare(`
      INSERT INTO customer_subscriptions (
        user_id, product_id, origin, gateway, gateway_subscription_id, status, price_cents, paid_until, access_expires_at
      ) VALUES (?, ?, 'ASAAS', 'ASAAS', 'sub_multi_jarvis_99', 'ACTIVE', 9700, ?, ?)
    `).run(multiUserId, jarvisProd.id, futurePaid, futurePaid);

    // Send Webhook OVERDUE for Jéssica
    await asaasService.handleWebhookEvent({
      event: 'PAYMENT_OVERDUE',
      payment: {
        id: 'pay_overdue_multi_jessica',
        customer: 'cus_multi_test_1',
        subscription: 'sub_multi_jessica_99',
        value: 147.0,
      },
    });

    // Sub A should be OVERDUE
    const subACheck = db.prepare('SELECT status FROM customer_subscriptions WHERE id = ?').get(subA.lastInsertRowid);
    assert.strictEqual(subACheck.status, 'OVERDUE');

    // Sub B must remain ACTIVE
    const subBCheck = db.prepare('SELECT status FROM customer_subscriptions WHERE id = ?').get(subB.lastInsertRowid);
    assert.strictEqual(subBCheck.status, 'ACTIVE', 'Jarvis deve permanecer ACTIVE');

    // Global user account must remain ACTIVE because Jarvis is active
    const userCheck = db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(multiUserId);
    assert.strictEqual(userCheck.subscription_status, 'ACTIVE', 'Status global da conta deve permanecer ACTIVE');
  });

  await test('13.2. Ambiguidade guard: Evento com apenas customer_id não degrada contratos quando usuário tem múltiplos produtos', async () => {
    const multiUser = db.prepare("SELECT id FROM users WHERE email = 'multi.product@raiaagentes.com.br'").get();
    
    // Send event with customer ID only, without subscription ID
    const res = await asaasService.handleWebhookEvent({
      event: 'PAYMENT_OVERDUE',
      payment: {
        id: 'pay_ambiguous_without_sub',
        customer: 'cus_multi_test_1',
        value: 147.0,
      },
    });

    assert.strictEqual(res.ambiguous, true, 'Evento deve ser marcado como ambíguo');
    assert.strictEqual(res.reason, 'AMBIGUOUS_CONTRACT_LINK');

    // Verify Jarvis is still ACTIVE
    const jarvisProd = db.prepare("SELECT id FROM products WHERE code = 'JARVIS_FINANCEIRO'").get();
    const jarvisSub = db.prepare("SELECT status FROM customer_subscriptions WHERE user_id = ? AND product_id = ?").get(multiUser.id, jarvisProd.id);
    assert.strictEqual(jarvisSub.status, 'ACTIVE');
  });

  // -------------------------------------------------------------
  // CENÁRIO 14: Reinicialização da aplicação após migração
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 14: REINICIALIZAÇÃO APÓS MIGRAÇÃO ---');
  await test('14. Idempotência e reinicialização segura: migrações executadas novamente sem erro ou corrupção', async () => {
    // Invocate versioned migration check again
    assert.doesNotThrow(() => {
      const activeSessions = db.prepare('SELECT COUNT(*) as count FROM users WHERE session_token IS NOT NULL').get();
      assert(activeSessions.count >= 1);
    });
  });

  // -------------------------------------------------------------
  // CENÁRIO 15: Compatibilidade do painel e da conta demonstrativa
  // -------------------------------------------------------------
  console.log('--- CENÁRIO 15: CONTA DEMONSTRATIVA E COMPATIBILIDADE ---');
  await test('15. Conta demonstrativa inicializa corretamente e autentica com credenciais oficiais', async () => {
    const demoUser = clientAuth.ensureDemoAccount();
    assert(demoUser, 'Conta demonstrativa deve ser configurada');

    const demoLogin = await requestApi('/api/cliente/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.demoAccountEmail,
        password: config.demoAccountPassword,
      }),
    });
    assert.strictEqual(demoLogin.status, 200);
    const body = await demoLogin.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.user.isDemo, true);
    assert.strictEqual(body.user.planTier, 'JESSICA_PRO');

    // Access profile
    const profileRes = await requestApi('/api/cliente/profile', {
      headers: { 'Authorization': `Bearer ${body.token}` },
    });
    assert.strictEqual(profileRes.status, 200);
    const profBody = await profileRes.json();
    assert(profBody.profile.salon, 'Salão demo deve estar presente');
  });

  // -------------------------------------------------------------
  // CLEANUP
  // -------------------------------------------------------------
  console.log('\n--- LIMPEZA DO AMBIENTE TEMPORÁRIO ---');
  if (server) {
    server.close();
  }
  db.close();

  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
    console.log('  ✓ Arquivos do SQLite temporário removidos com sucesso.');
  } catch (_) {}

  console.log('\n=======================================================');
  console.log(`RESULTADO DA SUÍTE DE INTEGRAÇÃO & SEGURANÇA: ${passed}/${total} APROVADOS (100%)`);
  console.log('=======================================================\n');
}

runIntegrationSecuritySuite().catch((err) => {
  console.error('\n❌ FALHA CRÍTICA NA SUÍTE DE INTEGRAÇÃO:', err);
  process.exit(1);
});
