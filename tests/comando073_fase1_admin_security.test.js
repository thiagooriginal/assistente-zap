/**
 * Testes Herméticos de Segurança P0 do Administrador - COMANDO 073 Fase 1
 *
 * Validações:
 * 1. Bloqueio de anônimos em rotas administrativas (HTTP 401).
 * 2. Bloqueio de tokens de clientes comuns em rotas administrativas (HTTP 403).
 * 3. Segregação de cookies: client_auth_token não é aceito em rotas /api/admin/* (HTTP 401/403).
 * 4. Bloqueio de API Keys de automação em rotas financeiras/interativas (HTTP 403).
 * 5. Proteção contra força bruta em /api/auth/admin-login (HTTP 429 após 5 tentativas).
 * 6. Desafio MFA obrigatório após senha primária correta.
 * 7. Autenticação completa com TOTP válido gerando sessão segura.
 * 8. Startup validation exigindo ADMIN_MFA_ENABLED=true em produção e rejeitando senhas fracas.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Forçar ambiente hermético e isolado
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raia-cmd073-f1-'));
const tempDbPath = path.join(tempDir, 'test_admin_sec.db');

process.env.DB_PATH = tempDbPath;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'TestAdminMasterSecret2026!#Strong';
process.env.ADMIN_API_KEY = 'ApiKeySecretForAutomations2026!Strong';
process.env.SESSION_SECRET = 'TestSessionSecretSuperSecure2026_123456';
process.env.CLIENT_AUTH_SECRET = 'TestClientAuthSecretSuperSecure2026_123';
process.env.MFA_ENCRYPTION_KEY = 'TestMfaEncryptionKeyIndependent2026_987';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // Base32 test secret
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';

const config = require('../src/config');
const db = require('../src/database/db');
const userService = require('../src/services/userService');
const totpService = require('../src/services/totpService');
const { app } = require('../src/server/app');
const { adminLoginLimiter } = require('../src/middlewares/rateLimiter');

let server;
let baseUrl;

function makeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const postData = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const reqHeaders = { ...headers };
    if (postData && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(rawData);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json || rawData,
        });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

describe('COMANDO 073 — FASE 1: Segurança P0 do Administrador', () => {
  let clientUser;
  let clientSessionToken;
  let adminUser;

  before(async () => {
    // Inicializar servidor de teste em porta dinâmica
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Configurar usuário ADMIN
    adminUser = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1").get();
    if (!adminUser) {
      const created = userService.getOrCreateUser({ phoneNumber: '5511999990001', name: 'Master Admin' });
      adminUser = created.user;
      db.prepare("UPDATE users SET role = 'ADMIN', plan = 'PRO' WHERE id = ?").run(adminUser.id);
    }

    // Configurar usuário CLIENT (salão comum)
    const clientCreated = userService.getOrCreateUser({ phoneNumber: '5511988887777', name: 'Salao Cliente Teste' });
    clientUser = clientCreated.user;
    db.prepare("UPDATE users SET role = 'CLIENT', plan = 'START' WHERE id = ?").run(clientUser.id);

    const clientSession = userService.createUserSession(clientUser.id, 7);
    clientSessionToken = clientSession.sessionToken;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  beforeEach(() => {
    if (adminLoginLimiter && typeof adminLoginLimiter.reset === 'function') {
      adminLoginLimiter.reset();
    }
  });

  test('1. Requisição anônima a rota administrativa deve retornar HTTP 401', async () => {
    const res = await makeRequest('GET', '/api/admin/users');
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
  });

  test('2. Usuário com role CLIENT tentando acessar rota administrativa deve retornar HTTP 403', async () => {
    const res = await makeRequest('GET', '/api/admin/users', {
      Authorization: `Bearer ${clientSessionToken}`
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /exclusivo para administradores/i);
  });

  test('3. Cookie client_auth_token não deve ser aceito para autenticar rota administrativa (HTTP 401)', async () => {
    const res = await makeRequest('GET', '/api/admin/users', {
      Cookie: `client_auth_token=${clientSessionToken}`
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
  });

  test('4. ADMIN_API_KEY deve ser estritamente bloqueada em rotas financeiras / interativas (HTTP 403)', async () => {
    const res = await makeRequest('GET', '/api/admin/direct-sales', {
      'X-Admin-Key': process.env.ADMIN_API_KEY
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN_RESTRICTED_AUTOMATION_SCOPE');
  });

  test('5. Login com senha incorreta deve falhar com HTTP 401', async () => {
    const res = await makeRequest('POST', '/api/auth/admin-login', {}, {
      password: 'SenhaIncorretaQueNaoExiste'
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /incorreta/i);
  });

  test('6. Proteção contra força bruta (Rate Limit): deve bloquear após 5 tentativas falhas', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await makeRequest('POST', '/api/auth/admin-login', {}, { password: 'wrong' });
      assert.equal(r.statusCode, 401);
    }
    // 6ª tentativa deve retornar 429
    const blockedRes = await makeRequest('POST', '/api/auth/admin-login', {}, { password: 'wrong' });
    assert.equal(blockedRes.statusCode, 429);
    assert.equal(blockedRes.body.code, 'RATE_LIMIT_EXCEEDED');
  });

  test('7. Login com senha correta sem TOTP deve solicitar desafio MFA (HTTP 200 { mfaRequired: true })', async () => {
    const res = await makeRequest('POST', '/api/auth/admin-login', {}, {
      password: process.env.ADMIN_PASSWORD
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.mfaRequired, true);
    assert.match(res.body.message, /segundo fator|TOTP|multifator/i);
  });

  test('8. Login com senha correta e TOTP válido deve gerar sessão HTTPOnly com mfaVerified: true', async () => {
    // Gerar código TOTP usando o secret de teste configurado
    const code = totpService.generateToken(process.env.ADMIN_TOTP_SECRET);

    const res = await makeRequest('POST', '/api/auth/admin-login', {}, {
      password: process.env.ADMIN_PASSWORD,
      mfaCode: code
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mfaVerified, true);
    assert.ok(res.body.token, 'Deve retornar token de sessão');
    assert.ok(res.headers['set-cookie'], 'Deve definir cookie de sessão');
    const cookieHeader = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join('; ') : res.headers['set-cookie'];
    assert.match(cookieHeader, /auth_token=/);
    assert.match(cookieHeader, /HttpOnly/i);

    // Testar acesso a rota interativa com o token retornado
    const authedRes = await makeRequest('GET', '/api/admin/mfa/status', {
      Authorization: `Bearer ${res.body.token}`
    });
    assert.equal(authedRes.statusCode, 200);
    assert.equal(authedRes.body.success, true);
  });

  test('9. Validação de ambiente: em produção rejeita senhas fracas e exige ADMIN_MFA_ENABLED=true', () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origHomolog = process.env.HOMOLOGACAO;
    const origAppMode = process.env.APP_MODE;
    const origAdminMfa = process.env.ADMIN_MFA_ENABLED;
    const origAdminPass = config.adminPassword;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.HOMOLOGACAO;
      process.env.APP_MODE = 'production';
      process.env.ADMIN_MFA_ENABLED = 'false';
      config.adminMfaEnabled = false;

      assert.throws(
        () => config.validateEnvironment({ throwOnError: false }),
        /ADMIN_MFA_ENABLED obrigatório em produção/
      );

      // Testar senha fraca em staging (não-abortivo)
      process.env.NODE_ENV = 'development';
      process.env.APP_MODE = 'staging';
      process.env.HOMOLOGACAO = 'true';
      config.adminPassword = 'admin';
      const resultWeak = config.validateEnvironment({ throwOnError: false });
      const hasWeakError = resultWeak.errors.some(e => e.includes('ADMIN_PASSWORD configurada com valor fraco'));
      assert.ok(hasWeakError, 'Deve acusar senha fraca proibida');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origHomolog) process.env.HOMOLOGACAO = origHomolog;
      if (origAppMode) process.env.APP_MODE = origAppMode;
      process.env.ADMIN_MFA_ENABLED = origAdminMfa;
      config.adminMfaEnabled = origAdminMfa === 'true';
      config.adminPassword = origAdminPass;
    }
  });
});
