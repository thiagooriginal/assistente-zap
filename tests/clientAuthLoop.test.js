'use strict';

/**
 * tests/clientAuthLoop.test.js
 * 
 * Suíte de Testes Herméticos: Loop de Login e Assinatura Expirada (COMANDO 060.2)
 * Branch: security/raia-27-protecoes
 * 
 * Validações implementadas:
 * 1. Login com assinatura ativa (200 OK, emissão de token, cookie HttpOnly, perfil acessível).
 * 2. Login com credenciais incorretas (401 INVALID_CREDENTIALS, sem token, sem sessão).
 * 3. Sessão válida com assinatura expirada (paid_until no passado: profile controlado sem 401,
 *    bloqueio 403 SUBSCRIPTION_EXPIRED em rotas operacionais, sessão preservada no banco).
 * 4. Renovação simulada de assinatura (atualização de paid_until restabelece 200 OK com mesmo token).
 * 5. Sessão inválida ou expirada no tempo (session_expires_at no passado: 401 SESSION_EXPIRED / INVALID_TOKEN).
 * 6. Acesso 403 por permissão RBAC (Least Privilege: rejeição de x-admin-key em rota de cliente).
 * 7. Isolamento Multi-tenant estrito (usuário 3 não lê nem altera dados de usuário demo/outro tenant).
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// 1. ISOLAMENTO HERMÉTICO DE AMBIENTE (ANTES DE QUALQUER IMPORT DO PROJETO)
// ---------------------------------------------------------------------------
const tempDbName = `test_client_auth_loop_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`;
const tempDbPath = path.join(os.tmpdir(), tempDbName);

process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.ADMIN_PASSWORD = 'TestMasterPassword123!@#';
process.env.ADMIN_API_KEY = 'test_admin_api_key_secret_least_privilege_123';
process.env.SESSION_SECRET = 'test_session_secret_32_chars_long_entropy!';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_32_chars_long_entropy!';
process.env.DEMO_ACCOUNT_EMAIL = 'homologacao.hotmart@raiaagentes.com.br';
process.env.DEMO_ACCOUNT_PASSWORD = 'DemoPassword123#';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';

// Carrega os módulos da aplicação conectados ao banco isolado em os.tmpdir()
const db = require('../src/database/db');
const { app } = require('../src/server/app');
const clientAuth = require('../src/services/clientAuthService');

let server;
let baseUrl;
let user1Id;
let user3Id;
let activeSessionToken;
let tokenUser3;

// ---------------------------------------------------------------------------
// HOOKS GLOBAIS DE INICIALIZAÇÃO E TEARDOWN
// ---------------------------------------------------------------------------
test.before(async () => {
  // Inicialização do servidor Express em porta efêmera (0)
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Garante semente da conta demo Hotmart
  clientAuth.ensureDemoAccount();

  // Criação do Usuário 1 (Cliente com assinatura ativa)
  const { hash: hash1, salt: salt1 } = clientAuth.hashPassword('SenhaCorreta123!');
  const futurePaidUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const insertUser1 = db.prepare(`
    INSERT INTO users (
      email, name, phone_number, password_hash, password_salt,
      plan_tier, subscription_status, subscription_origin, paid_until, is_demo, role
    ) VALUES (?, ?, ?, ?, ?, 'JESSICA_START', 'ACTIVE', 'HOTMART', ?, 0, 'USER')
  `).run(
    'cliente.ativo@teste.com.br',
    'Cliente Ativo Teste',
    '5511988880001',
    hash1,
    salt1,
    futurePaidUntil
  );
  user1Id = Number(insertUser1.lastInsertRowid);
  clientAuth.ensureSalonForUser(user1Id, 'Salão Beleza Ativa');

  // Criação do Usuário 3 (Segundo cliente para validação de isolamento multi-tenant)
  const { hash: hash3, salt: salt3 } = clientAuth.hashPassword('SenhaMultiTenant123!');
  const insertUser3 = db.prepare(`
    INSERT INTO users (
      email, name, phone_number, password_hash, password_salt,
      plan_tier, subscription_status, subscription_origin, paid_until, is_demo, role
    ) VALUES (?, ?, ?, ?, ?, 'JESSICA_START', 'ACTIVE', 'HOTMART', ?, 0, 'USER')
  `).run(
    'cliente3@teste.com.br',
    'Cliente 3 Multi-tenant',
    '5511988880003',
    hash3,
    salt3,
    futurePaidUntil
  );
  user3Id = Number(insertUser3.lastInsertRowid);
  clientAuth.ensureSalonForUser(user3Id, 'Salão Exclusivo Cliente 3');

  // Gera sessão válida para o Usuário 3
  tokenUser3 = crypto.randomBytes(32).toString('hex');
  const sessionExpiresAt3 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE users
    SET session_token = ?, session_expires_at = ?
    WHERE id = ?
  `).run(tokenUser3, sessionExpiresAt3, user3Id);
});

test.after(async () => {
  // Encerramento do servidor HTTP
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  // Encerramento do SQLite para liberação de handles no Windows
  try {
    db.close();
  } catch (_) {}

  // Remoção dos arquivos temporários descartáveis
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
  } catch (_) {}
});

// ---------------------------------------------------------------------------
// SUÍTE DE TESTES RIGOROSOS
// ---------------------------------------------------------------------------

test('1. Login com assinatura ativa: Sucesso 200, emissão de token, cookie HttpOnly e acesso a /profile', async () => {
  const resLogin = await fetch(`${baseUrl}/api/cliente/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'cliente.ativo@teste.com.br',
      password: 'SenhaCorreta123!'
    }),
  });

  assert.strictEqual(resLogin.status, 200, 'Login deve retornar HTTP 200 OK');
  const body = await resLogin.json();
  assert.strictEqual(body.success, true);
  assert.ok(body.token, 'Deve retornar token de sessão');
  activeSessionToken = body.token;

  // Validação do Cookie HttpOnly e Lax
  const setCookie = resLogin.headers.get('set-cookie');
  assert.ok(setCookie, 'Deve definir header Set-Cookie');
  assert.ok(setCookie.includes('client_auth_token='), 'Cookie deve conter client_auth_token');
  assert.ok(setCookie.includes('HttpOnly'), 'Cookie deve ter flag HttpOnly');
  assert.ok(setCookie.includes('SameSite=Lax'), 'Cookie deve ter SameSite=Lax');

  // Acesso a /api/cliente/profile via Bearer Token
  const resProfile = await fetch(`${baseUrl}/api/cliente/profile`, {
    headers: { Authorization: `Bearer ${activeSessionToken}` },
  });
  assert.strictEqual(resProfile.status, 200, 'Acesso ao perfil deve retornar HTTP 200');
  const profileBody = await resProfile.json();
  assert.strictEqual(profileBody.success, true);
  assert.strictEqual(profileBody.profile.email, 'cliente.ativo@teste.com.br');
  assert.strictEqual(profileBody.profile.name, 'Cliente Ativo Teste');
  assert.strictEqual(profileBody.profile.subscriptionStatus, 'ACTIVE');

  // Acesso a /api/cliente/profile via Cookie HttpOnly (sem header Bearer)
  const resCookieProfile = await fetch(`${baseUrl}/api/cliente/profile`, {
    headers: { Cookie: `client_auth_token=${activeSessionToken}` },
  });
  assert.strictEqual(resCookieProfile.status, 200, 'Acesso ao perfil via cookie deve retornar HTTP 200');
});

test('2. Login com credenciais incorretas: Erro 401 INVALID_CREDENTIALS, nenhum token e nenhuma sessão', async () => {
  const resWrong = await fetch(`${baseUrl}/api/cliente/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'cliente.ativo@teste.com.br',
      password: 'SenhaIncorreta999!'
    }),
  });

  assert.strictEqual(resWrong.status, 401, 'Senha incorreta deve retornar HTTP 401');
  const body = await resWrong.json();
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.code, 'INVALID_CREDENTIALS');
  assert.strictEqual(body.token, undefined, 'Nenhum token deve ser emitido');

  // Teste com e-mail inexistente
  const resNonExistent = await fetch(`${baseUrl}/api/cliente/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'inexistente@dominio.com.br',
      password: 'SenhaQualquer123!'
    }),
  });
  assert.strictEqual(resNonExistent.status, 401, 'E-mail inexistente deve retornar HTTP 401');
  const bodyNonExistent = await resNonExistent.json();
  assert.strictEqual(bodyNonExistent.code, 'INVALID_CREDENTIALS');
  assert.strictEqual(bodyNonExistent.token, undefined);
});

test('3. Sessão válida com assinatura expirada (paid_until no passado)', async () => {
  // Simula expiração contratual no banco de dados para user1
  const pastPaidUntil = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 dias no passado
  db.prepare('UPDATE users SET paid_until = ? WHERE id = ?').run(pastPaidUntil, user1Id);

  // 1. Acesso a /api/cliente/profile:
  // Não pode retornar 401 (o que causaria revogação indevida da sessão do cliente e loop de login).
  // Retorna status controlado com subscriptionExpired: true sem instruir remoção de cookie.
  const resProfile = await fetch(`${baseUrl}/api/cliente/profile`, {
    headers: { Authorization: `Bearer ${activeSessionToken}` },
  });

  assert.notStrictEqual(resProfile.status, 401, 'Assinatura expirada com sessão válida NÃO deve retornar 401');
  assert.strictEqual(resProfile.status, 200, 'Profile deve ser acessível em modo controlado');

  const profileBody = await resProfile.json();
  assert.strictEqual(profileBody.success, true);
  assert.strictEqual(profileBody.profile.subscriptionExpired, true);

  // Garante que o servidor não enviou Set-Cookie de logout (Max-Age=0)
  const setCookie = resProfile.headers.get('set-cookie');
  if (setCookie) {
    assert.ok(!setCookie.includes('Max-Age=0'), 'Não deve forçar deslogamento via cookie Max-Age=0');
  }

  // 2. Acesso a rota operacional paga (ex: /api/cliente/services ou /api/cliente/salon): Bloqueio 403 SUBSCRIPTION_EXPIRED
  const resServices = await fetch(`${baseUrl}/api/cliente/services`, {
    headers: { Authorization: `Bearer ${activeSessionToken}` },
  });
  assert.strictEqual(resServices.status, 403, 'Rota operacional deve ser estritamente bloqueada com 403');
  const servicesBody = await resServices.json();
  assert.strictEqual(servicesBody.success, false);
  assert.strictEqual(servicesBody.code, 'SUBSCRIPTION_EXPIRED');

  // 2.1 Requisito COMANDO 060.3: Bloqueio estrito de operações de escrita operacionais (ex: PUT /salon)
  const resPutSalon = await fetch(`${baseUrl}/api/cliente/salon`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${activeSessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ salonName: 'Tentativa de Escrita Sem Assinatura' }),
  });
  assert.strictEqual(resPutSalon.status, 403, 'PUT em /salon quando expirado deve retornar 403');
  const putSalonBody = await resPutSalon.json();
  assert.strictEqual(putSalonBody.code, 'SUBSCRIPTION_EXPIRED');

  // 2.2 Requisito COMANDO 060.3: Acesso GET a /my-invoices e /my-subscriptions permitido sem bloqueio
  const resInvoices = await fetch(`${baseUrl}/api/cliente/my-invoices`, {
    headers: { Authorization: `Bearer ${activeSessionToken}` },
  });
  assert.strictEqual(resInvoices.status, 200, 'GET /my-invoices deve ser permitido para regularização');

  const resSubscriptions = await fetch(`${baseUrl}/api/cliente/my-subscriptions`, {
    headers: { Authorization: `Bearer ${activeSessionToken}` },
  });
  assert.strictEqual(resSubscriptions.status, 200, 'GET /my-subscriptions deve ser permitido para consulta');

  // 3. Prova forense: A sessão no banco permanece ativa e íntegra para renovação
  const userInDb = db.prepare('SELECT session_token, session_expires_at FROM users WHERE id = ?').get(user1Id);
  assert.strictEqual(userInDb.session_token, activeSessionToken, 'O token de sessão deve permanecer ativo no banco');
  assert.ok(new Date(userInDb.session_expires_at) > new Date(), 'A validade temporal da sessão não deve ser corrompida');
});

test('4. Renovação simulada de assinatura: Restabelecimento imediato de 200 OK com o mesmo token', async () => {
  // Simula confirmação de renovação/pagamento (+30 dias)
  const renewedPaidUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE users
    SET paid_until = ?, subscription_status = 'ACTIVE'
    WHERE id = ?
  `).run(renewedPaidUntil, user1Id);

  // Acesso imediato à rota operacional com o MESMO token de sessão (sem re-login e sem recriar conta)
  const resServices = await fetch(`${baseUrl}/api/cliente/services`, {
    headers: { Authorization: `Bearer ${activeSessionToken}` },
  });
  assert.strictEqual(resServices.status, 200, 'Rota operacional deve restabelecer 200 OK imediatamente após renovação');
  const servicesBody = await resServices.json();
  assert.strictEqual(servicesBody.success, true);
  assert.ok(Array.isArray(servicesBody.services), 'Deve listar serviços do cliente');

  // Atualização dos dados do salão com o mesmo token
  const resUpdateSalon = await fetch(`${baseUrl}/api/cliente/salon`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${activeSessionToken}`,
    },
    body: JSON.stringify({ salonName: 'Salão Beleza Renovada Oficial' }),
  });
  assert.strictEqual(resUpdateSalon.status, 200, 'Atualização operacional deve responder 200 OK');
  const salonBody = await resUpdateSalon.json();
  assert.strictEqual(salonBody.success, true);
  assert.strictEqual(salonBody.salon.name, 'Salão Beleza Renovada Oficial');
});

test('5. Sessão inválida ou expirada no tempo (session_expires_at no passado): Retorno 401', async () => {
  // Simula expiração temporal da sessão
  const pastSessionExpires = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hora atrás
  db.prepare('UPDATE users SET session_expires_at = ? WHERE id = ?').run(pastSessionExpires, user1Id);

  const resExpiredSession = await fetch(`${baseUrl}/api/cliente/profile`, {
    headers: { Authorization: `Bearer ${activeSessionToken}` },
  });
  assert.strictEqual(resExpiredSession.status, 401, 'Sessão com session_expires_at no passado deve retornar 401');
  const bodyExpired = await resExpiredSession.json();
  assert.strictEqual(bodyExpired.code, 'SESSION_EXPIRED');

  // Token inexistente / forjado
  const resInvalidToken = await fetch(`${baseUrl}/api/cliente/profile`, {
    headers: { Authorization: 'Bearer token_inexistente_forjado_1234567890' },
  });
  assert.strictEqual(resInvalidToken.status, 401, 'Token inexistente deve retornar 401');
  const bodyInvalid = await resInvalidToken.json();
  assert.strictEqual(bodyInvalid.code, 'INVALID_TOKEN');
});

test('6. Acesso 403 por permissão (RBAC / Least Privilege): Rejeição de x-admin-key em rota de cliente', async () => {
  // Tentativa de usar credencial administrativa em rota de cliente
  const resAdminKey = await fetch(`${baseUrl}/api/cliente/profile`, {
    headers: {
      'x-admin-key': process.env.ADMIN_API_KEY,
    },
  });
  assert.strictEqual(resAdminKey.status, 403, 'x-admin-key em rota de cliente deve ser rejeitado com 403');
  const bodyAdminKey = await resAdminKey.json();
  assert.strictEqual(bodyAdminKey.code, 'FORBIDDEN_CLIENT_ROUTE_VIA_API_KEY');

  // Tentativa combinada: Token válido + x-admin-key (Princípio do Menor Privilégio / Fail-Closed)
  const resCombined = await fetch(`${baseUrl}/api/cliente/services`, {
    headers: {
      Authorization: `Bearer ${tokenUser3}`,
      'x-admin-key': process.env.ADMIN_API_KEY,
    },
  });
  assert.strictEqual(resCombined.status, 403, 'Combinação com x-admin-key deve prevalecer rejeição 403');
  const bodyCombined = await resCombined.json();
  assert.strictEqual(bodyCombined.code, 'FORBIDDEN_CLIENT_ROUTE_VIA_API_KEY');
});

test('7. Isolamento Multi-tenant: user_id=3 não acessa nem altera dados de user_id=demo (is_demo=1)', async () => {
  // Recupera dados do usuário demo (id = 1 ou 2)
  const demoUser = db.prepare('SELECT id, email, is_demo FROM users WHERE is_demo = 1 LIMIT 1').get();
  assert.ok(demoUser, 'Usuário demo deve existir');
  const demoSalonBefore = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(demoUser.id);
  assert.ok(demoSalonBefore, 'Salão demo deve existir');

  // Cadastra um serviço exclusivo pertencente ao demoUser
  db.prepare(`
    INSERT INTO client_services (user_id, name, price, duration_min, category, active)
    VALUES (?, 'Corte Master Exclusivo Demo', 180.0, 50, 'Cabelo', 1)
  `).run(demoUser.id);

  // 1. Usuário 3 consulta perfil: deve receber estritamente seus próprios dados
  const resProfile3 = await fetch(`${baseUrl}/api/cliente/profile`, {
    headers: { Authorization: `Bearer ${tokenUser3}` },
  });
  assert.strictEqual(resProfile3.status, 200);
  const profile3Body = await resProfile3.json();
  assert.strictEqual(profile3Body.profile.id, user3Id);
  assert.strictEqual(profile3Body.profile.email, 'cliente3@teste.com.br');
  assert.strictEqual(profile3Body.profile.isDemo, false, 'Usuário 3 não é demo');

  // 2. Usuário 3 lista serviços: NÃO deve ver o serviço do usuário demo
  const resServices3 = await fetch(`${baseUrl}/api/cliente/services`, {
    headers: { Authorization: `Bearer ${tokenUser3}` },
  });
  assert.strictEqual(resServices3.status, 200);
  const services3Body = await resServices3.json();
  const foundDemoService = services3Body.services.some(s => s.name === 'Corte Master Exclusivo Demo');
  assert.strictEqual(foundDemoService, false, 'Serviços de outro tenant não podem vazar');

  // 3. Usuário 3 atualiza seu salão: salão do usuário demo deve permanecer inalterado
  const resUpdateSalon3 = await fetch(`${baseUrl}/api/cliente/salon`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenUser3}`,
    },
    body: JSON.stringify({ salonName: 'Salão Alterado Somente Para o Cliente 3' }),
  });
  assert.strictEqual(resUpdateSalon3.status, 200);

  // Verificação no banco: salão do demoUser permaneceu intacto
  const demoSalonAfter = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(demoUser.id);
  assert.strictEqual(
    demoSalonAfter.salon_name,
    demoSalonBefore.salon_name,
    'Salão de outro tenant não pode ser modificado'
  );
});
