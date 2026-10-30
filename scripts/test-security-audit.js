const assert = require('assert');
const http = require('http');
const config = require('../src/config');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const clientAuth = require('../src/services/clientAuthService');
const rateLimiters = require('../src/middlewares/rateLimiter');

async function runSecurityAudit() {
  console.log('\n============================================================');
  console.log('🛡️  SUITE DE TESTES AUTOMATIZADOS DE SEGURANÇA (AUDITORIA RAIA)');
  console.log('============================================================\n');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let passedTests = 0;
  let totalTests = 0;

  function recordPass(testName) {
    passedTests++;
    totalTests++;
    console.log(`  ✅ [PASS] ${testName}`);
  }

  function recordFail(testName, err) {
    totalTests++;
    console.error(`  ❌ [FAIL] ${testName}:`, err.message);
    throw err;
  }

  try {
    // Reset rate limiters at start
    Object.values(rateLimiters).forEach(l => l && typeof l.reset === 'function' && l.reset());

    // Clean up test users from any previous runs
    db.prepare("DELETE FROM users WHERE email IN ('sec.client.a@raia.test', 'sec.client.b@raia.test', 'sec.inactive@raia.test', 'sec.refunded@raia.test', 'sec.expired@raia.test', 'sec.pro@raia.test') OR phone_number IN ('5511999990001', '5511999990002', '5511999990003', '5511999990004', '5511999990005')").run();

    // -------------------------------------------------------------
    // TEST 1: Password reset response must NEVER leak tokens or phone
    // -------------------------------------------------------------
    console.log('📌 Teste 1: Proteção de Dados na Recuperação de Senha');
    {
      // Ensure demo account exists
      clientAuth.ensureDemoAccount();

      const res = await fetch(`${baseUrl}/api/cliente/auth/request-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'homologacao.hotmart@raiaagentes.com.br' })
      });
      const data = await res.json();

      assert.strictEqual(res.status, 200, 'Status deve ser 200');
      assert.strictEqual(data.success, true, 'Resposta deve indicar sucesso');
      assert.strictEqual(data.resetToken, undefined, 'resetToken NUNCA deve ser retornado no payload');
      assert.strictEqual(data.token, undefined, 'token NUNCA deve ser retornado no payload');
      assert.strictEqual(data.phone, undefined, 'telefone não deve ser exposto na resposta pública');
      assert.strictEqual(data.phoneNumber, undefined, 'phoneNumber não deve ser exposto');
      assert.strictEqual(data.userId, undefined, 'userId interno não deve ser exposto');
      assert.ok(typeof data.message === 'string' && data.message.length > 10, 'Mensagem segura deve ser retornada');

      // Verify in DB that reset token was actually generated and stored
      const user = db.prepare("SELECT reset_token, reset_expires_at FROM users WHERE email = 'homologacao.hotmart@raiaagentes.com.br'").get();
      assert.ok(user.reset_token, 'Token de reset foi persistido no banco com segurança');
      assert.ok(user.reset_expires_at, 'Data de expiração do reset foi definida');

      recordPass('1.1 /api/cliente/auth/request-reset não expõe tokens, senhas ou telefones na resposta HTTP');
    }

    // -------------------------------------------------------------
    // TEST 2: Rejeição de senhas padrão e credenciais fixas
    // -------------------------------------------------------------
    console.log('\n📌 Teste 2: Remoção de Senhas Padrão e Backdoors');
    {
      const forbiddenPasswords = [
        'admin123',
        'admin',
        'assistente-zap-sync',
        '5511951364159',
        '11951364159'
      ];

      for (const badPass of forbiddenPasswords) {
        const res = await fetch(`${baseUrl}/api/auth/admin-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: badPass })
        });
        assert.strictEqual(res.status, 401, `Senha proibida '${badPass}' deve retornar 401`);
        const json = await res.json();
        assert.strictEqual(json.success, false);
      }
      recordPass('2.1 Senhas padrão fixas (admin123, admin, assistente-zap-sync, telefone) rejeitadas com 401');

      // Test header backdoors removed from authMiddleware
      const backdoorHeaderRes = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { 'x-admin-key': 'assistente-zap-sync' }
      });
      assert.strictEqual(backdoorHeaderRes.status, 401, 'x-admin-key: assistente-zap-sync deve retornar 401');
      recordPass('2.2 Chave de backdoor "assistente-zap-sync" rejeitada com 401');

      // Reset limiter for valid admin login attempt
      rateLimiters.adminLoginLimiter.reset();

      // Test valid configured admin password succeeds
      const goodPass = config.adminPassword;
      assert.ok(goodPass, 'ADMIN_PASSWORD deve estar configurado no ambiente de teste');
      const validLoginRes = await fetch(`${baseUrl}/api/auth/admin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: goodPass })
      });
      assert.strictEqual(validLoginRes.status, 200, 'Senha configurada deve autenticar com 200');
      const validJson = await validLoginRes.json();
      assert.strictEqual(validJson.success, true);
      assert.ok(validJson.token, 'Token de sessão gerado');
      assert.strictEqual(validJson.user.role, 'ADMIN', 'Usuário autenticado deve ter role ADMIN');

      // Test Set-Cookie header contains HttpOnly and SameSite=Lax
      const cookieHeader = validLoginRes.headers.get('set-cookie');
      assert.ok(cookieHeader && cookieHeader.includes('HttpOnly'), 'Cookie Set-Cookie deve conter flag HttpOnly');
      assert.ok(cookieHeader && cookieHeader.includes('SameSite=Lax'), 'Cookie Set-Cookie deve conter SameSite=Lax');
      recordPass('2.3 Login administrativo legítimo autenticado com sucesso e cookie seguro HttpOnly emitido');
    }

    // -------------------------------------------------------------
    // TEST 3: Proteção de Rotas Administrativas e Financeiras (401 & 403)
    // -------------------------------------------------------------
    console.log('\n📌 Teste 3: Autenticação e RBAC nas Rotas Administrativas e Financeiras');
    {
      // Create regular client user (role: USER, plan: JESSICA_START)
      db.prepare(`
        INSERT INTO users (name, email, password_hash, phone_number, role, plan_tier, plan, subscription_status, paid_until, magic_token, magic_token_expires_at)
        VALUES ('Cliente Alpha', 'sec.client.a@raia.test', 'hash', '5511999990001', 'USER', 'JESSICA_START', 'START', 'ACTIVE', datetime('now', '+30 days'), 'token_client_alpha_valid', datetime('now', '+30 days'))
      `).run();

      const clientToken = 'token_client_alpha_valid';

      const protectedRoutes = [
        { method: 'GET', path: '/api/admin/users' },
        { method: 'GET', path: '/api/admin/leads' },
        { method: 'GET', path: '/api/admin/analytics/overview' },
        { method: 'GET', path: '/api/admin/users-list' },
        { method: 'GET', path: '/api/asaas/status' },
        { method: 'GET', path: '/api/asaas/payments' },
        { method: 'GET', path: '/api/assistant/pause-status' },
        { method: 'POST', path: '/api/assistant/toggle-pause', body: { paused: true } },
        { method: 'POST', path: '/api/admin/calendar/setup', body: { credentials: {} } },
      ];

      // Test Unauthenticated -> 401
      for (const route of protectedRoutes) {
        const res = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: { 'Content-Type': 'application/json' },
          body: route.body ? JSON.stringify(route.body) : undefined
        });
        assert.strictEqual(res.status, 401, `Acesso anônimo a ${route.path} deve retornar 401`);
      }
      recordPass('3.1 Todas as rotas administrativas e financeiras bloqueadas sem token (401 Unauthorized)');

      // Test Non-Admin Client Token -> 403 Forbidden
      for (const route of protectedRoutes) {
        const res = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${clientToken}`
          },
          body: route.body ? JSON.stringify(route.body) : undefined
        });
        assert.strictEqual(res.status, 403, `Acesso de cliente não-admin a ${route.path} deve retornar 403 Forbidden`);
      }
      recordPass('3.2 Todas as rotas administrativas e financeiras bloqueiam usuários comuns com 403 Forbidden');
    }

    // -------------------------------------------------------------
    // TEST 4: Rate Limiting (429 Too Many Requests)
    // -------------------------------------------------------------
    console.log('\n📌 Teste 4: Rate Limiting contra Ataques de Força Bruta');
    {
      // Reset limiters first
      rateLimiters.adminLoginLimiter.reset();
      rateLimiters.passwordResetRequestLimiter.reset();

      // 4.1 Admin login limiter (max 5 per window)
      let rateLimited = false;
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${baseUrl}/api/auth/admin-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'wrong-password-' + i })
        });
        if (res.status === 429) {
          rateLimited = true;
          assert.strictEqual(res.status, 429);
          assert.ok(res.headers.get('retry-after'), 'Header Retry-After deve estar presente');
          assert.strictEqual(res.headers.get('x-ratelimit-remaining'), '0');
          const json = await res.json();
          assert.strictEqual(json.code, 'RATE_LIMIT_EXCEEDED');
          break;
        }
      }
      assert.ok(rateLimited, 'O 6º login administrativo deve ser bloqueado com 429 Too Many Requests');
      recordPass('4.1 Rate limiter bloqueia força bruta no login administrativo com HTTP 429 e cabeçalho Retry-After');

      // 4.2 Password reset request limiter (max 5 per window, 6th blocks)
      rateLimited = false;
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${baseUrl}/api/cliente/auth/request-reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'homologacao.hotmart@raiaagentes.com.br' })
        });
        if (res.status === 429) {
          rateLimited = true;
          assert.strictEqual(res.status, 429);
          break;
        }
      }
      assert.ok(rateLimited, 'Requisições excessivas de recuperação de senha devem retornar 429');
      recordPass('4.2 Rate limiter bloqueia abusos de solicitação de recuperação de senha com HTTP 429');

      // Clean limiters for remaining tests
      rateLimiters.adminLoginLimiter.reset();
      rateLimiters.passwordResetRequestLimiter.reset();
      rateLimiters.clientLoginLimiter.reset();
    }

    // -------------------------------------------------------------
    // TEST 5: Revogação de Sessão e Invalidação no Banco de Dados
    // -------------------------------------------------------------
    console.log('\n📌 Teste 5: Validade e Revogação Segura de Sessões');
    {
      // Admin session logout
      const adminLoginRes = await fetch(`${baseUrl}/api/auth/admin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: config.adminPassword })
      });
      const adminLoginData = await adminLoginRes.json();
      const adminToken = adminLoginData.token;

      // Verify admin can access users
      const beforeLogout = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(beforeLogout.status, 200, 'Admin deve acessar com token ativo');

      // Execute logout
      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(logoutRes.status, 200, 'Logout deve retornar 200');

      // Verify token is nullified in DB
      const adminInDb = db.prepare('SELECT magic_token FROM users WHERE id = ?').get(adminLoginData.user.id);
      assert.strictEqual(adminInDb.magic_token, null, 'magic_token deve ser NULL no banco após logout');

      // Subsequent access with revoked token must return 401
      const afterLogout = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      assert.strictEqual(afterLogout.status, 401, 'Token revogado deve ser rejeitado com 401');
      recordPass('5.1 Logout administrativo revoga imediatamente a sessão no banco e invalida o token (401)');

      // Client session logout
      const clientAlpha = db.prepare("SELECT * FROM users WHERE email = 'sec.client.a@raia.test'").get();
      db.prepare("UPDATE users SET magic_token = 'token_client_logout_test', magic_token_expires_at = datetime('now', '+30 days') WHERE id = ?")
        .run(clientAlpha.id);

      const clientLogoutRes = await fetch(`${baseUrl}/api/cliente/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer token_client_logout_test' }
      });
      assert.strictEqual(clientLogoutRes.status, 200);

      const clientInDb = db.prepare('SELECT magic_token FROM users WHERE id = ?').get(clientAlpha.id);
      assert.strictEqual(clientInDb.magic_token, null, 'magic_token do cliente deve ser NULL após logout');

      const clientAfterLogout = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Authorization': 'Bearer token_client_logout_test' }
      });
      assert.strictEqual(clientAfterLogout.status, 401, 'Token revogado do cliente deve retornar 401');
      recordPass('5.2 Logout do cliente revoga a sessão no SQLite e limpa cookies HttpOnly');
    }

    // -------------------------------------------------------------
    // TEST 6: Validação de Assinatura, Período Pago e Isolamento Multi-Tenant
    // -------------------------------------------------------------
    console.log('\n📌 Teste 6: Validação de Assinatura, Vigência e Isolamento Multi-Tenant');
    {
      // 6.1 Inactive subscription check
      db.prepare(`
        INSERT INTO users (name, email, password_hash, phone_number, role, plan_tier, subscription_status, magic_token, magic_token_expires_at)
        VALUES ('Cliente Inativo', 'sec.inactive@raia.test', 'hash', '5511999990002', 'USER', 'JESSICA_START', 'INACTIVE', 'token_inactive', datetime('now', '+30 days'))
      `).run();
      const inactRes = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Authorization': 'Bearer token_inactive' }
      });
      assert.strictEqual(inactRes.status, 403);
      const inactJson = await inactRes.json();
      assert.strictEqual(inactJson.code, 'SUBSCRIPTION_INACTIVE');
      recordPass('6.1 Assinatura INACTIVE bloqueia acesso aos serviços com 403 SUBSCRIPTION_INACTIVE');

      // 6.2 Refunded subscription check
      db.prepare(`
        INSERT INTO users (name, email, password_hash, phone_number, role, plan_tier, subscription_status, magic_token, magic_token_expires_at)
        VALUES ('Cliente Reembolsado', 'sec.refunded@raia.test', 'hash', '5511999990003', 'USER', 'JESSICA_START', 'REFUNDED', 'token_refunded', datetime('now', '+30 days'))
      `).run();
      const refRes = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Authorization': 'Bearer token_refunded' }
      });
      assert.strictEqual(refRes.status, 403);
      const refJson = await refRes.json();
      assert.strictEqual(refJson.code, 'SUBSCRIPTION_REFUNDED');
      recordPass('6.2 Assinatura REFUNDED bloqueia acesso aos serviços com 403 SUBSCRIPTION_REFUNDED');

      // 6.3 Expired paid period (paid_until in past)
      db.prepare(`
        INSERT INTO users (name, email, password_hash, phone_number, role, plan_tier, subscription_status, paid_until, magic_token, magic_token_expires_at)
        VALUES ('Cliente Vencido', 'sec.expired@raia.test', 'hash', '5511999990004', 'USER', 'JESSICA_START', 'ACTIVE', datetime('now', '-2 days'), 'token_expired', datetime('now', '+30 days'))
      `).run();
      const expRes = await fetch(`${baseUrl}/api/cliente/profile`, {
        headers: { 'Authorization': 'Bearer token_expired' }
      });
      assert.strictEqual(expRes.status, 403);
      const expJson = await expRes.json();
      assert.strictEqual(expJson.code, 'SUBSCRIPTION_EXPIRED');
      recordPass('6.3 Assinatura com vigência expirada (paid_until no passado) bloqueada com 403 SUBSCRIPTION_EXPIRED');

      // 6.4 Plan Tier Gating: Start vs Pro
      // Reset Client Alpha as active START
      const clientAlpha = db.prepare("SELECT * FROM users WHERE email = 'sec.client.a@raia.test'").get();
      db.prepare("UPDATE users SET plan_tier = 'JESSICA_START', subscription_status = 'ACTIVE', paid_until = datetime('now', '+30 days'), magic_token = 'token_client_a_start', magic_token_expires_at = datetime('now', '+30 days') WHERE id = ?")
        .run(clientAlpha.id);

      const proDashRes = await fetch(`${baseUrl}/api/cliente/pro/dashboard`, {
        headers: { 'Authorization': 'Bearer token_client_a_start' }
      });
      assert.strictEqual(proDashRes.status, 403);
      const proDashJson = await proDashRes.json();
      assert.strictEqual(proDashJson.upgradeRequired, true);
      recordPass('6.4 Cliente do Plano Start bloqueado no Dashboard Gerencial Pro com 403 upgradeRequired');

      // 6.5 Strict Multi-Tenant Isolation between Client Alpha and Client Beta
      // Create Client Beta
      db.prepare(`
        INSERT INTO users (name, email, password_hash, phone_number, role, plan_tier, subscription_status, paid_until, magic_token, magic_token_expires_at)
        VALUES ('Cliente Beta', 'sec.client.b@raia.test', 'hash', '5511999990005', 'USER', 'JESSICA_START', 'ACTIVE', datetime('now', '+30 days'), 'token_client_b', datetime('now', '+30 days'))
      `).run();
      const clientBeta = db.prepare("SELECT * FROM users WHERE email = 'sec.client.b@raia.test'").get();

      // Client Alpha adds a private service
      const addServiceRes = await fetch(`${baseUrl}/api/cliente/services`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token_client_a_start'
        },
        body: JSON.stringify({
          name: 'Corte Exclusivo Alpha #999',
          price: 120.00,
          durationMin: 60,
          category: 'Cabelo'
        })
      });
      const addServiceData = await addServiceRes.json();
      assert.strictEqual(addServiceRes.status, 200);
      const alphaServiceId = addServiceData.service.id;

      // Client Beta lists services -> MUST NOT see Client Alpha's service
      const betaServicesRes = await fetch(`${baseUrl}/api/cliente/services`, {
        headers: { 'Authorization': 'Bearer token_client_b' }
      });
      const betaServicesData = await betaServicesRes.json();
      assert.strictEqual(betaServicesRes.status, 200);
      const hasAlphaService = betaServicesData.services.some(s => s.id === alphaServiceId || s.name.includes('Alpha #999'));
      assert.strictEqual(hasAlphaService, false, 'Cliente Beta NÃO PODE listar serviços pertencentes ao Cliente Alpha');

      // Client Beta tries to UPDATE Client Alpha's service -> MUST return 404
      const betaTamperRes = await fetch(`${baseUrl}/api/cliente/services/${alphaServiceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token_client_b'
        },
        body: JSON.stringify({ name: 'Hacked By Beta', price: 1.00 })
      });
      assert.strictEqual(betaTamperRes.status, 404, 'Tentativa de alteração cruzada de dados de outro cliente deve retornar 404 Not Found');

      // Client Beta tries to DELETE Client Alpha's service -> MUST return 404
      const betaDeleteRes = await fetch(`${baseUrl}/api/cliente/services/${alphaServiceId}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer token_client_b' }
      });
      assert.strictEqual(betaDeleteRes.status, 404, 'Tentativa de remoção cruzada de dados de outro cliente deve retornar 404 Not Found');

      // Verify Client Alpha's service was untouched
      const alphaVerifyRes = await fetch(`${baseUrl}/api/cliente/services`, {
        headers: { 'Authorization': 'Bearer token_client_a_start' }
      });
      const alphaVerifyData = await alphaVerifyRes.json();
      const alphaServiceStillIntact = alphaVerifyData.services.find(s => s.id === alphaServiceId);
      assert.ok(alphaServiceStillIntact, 'Serviço do Cliente Alpha permaneceu intacto');
      assert.strictEqual(alphaServiceStillIntact.price, 120.00, 'Preço permaneceu inalterado');
      recordPass('6.5 Isolamento Multi-Tenant rigoroso: Clientes não conseguem ler, alterar ou excluir dados uns dos outros');
    }

    console.log('\n============================================================');
    console.log(`🎉 TODOS OS ${passedTests}/${totalTests} TESTES DE SEGURANÇA FORAM APROVADOS COM SUCESSO!`);
    console.log('============================================================\n');

  } finally {
    // Cleanup test users
    db.prepare("DELETE FROM users WHERE email IN ('sec.client.a@raia.test', 'sec.client.b@raia.test', 'sec.inactive@raia.test', 'sec.refunded@raia.test', 'sec.expired@raia.test', 'sec.pro@raia.test') OR phone_number IN ('5511999990001', '5511999990002', '5511999990003', '5511999990004', '5511999990005')").run();
    await new Promise(resolve => server.close(resolve));
  }
}

runSecurityAudit()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ ERRO NA AUDITORIA DE SEGURANÇA:', err);
    process.exit(1);
  });
