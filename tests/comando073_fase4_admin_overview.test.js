/**
 * Testes Herméticos do Painel Central do Administrador - COMANDO 073 Fase 4
 *
 * Validações:
 * 1. adminOverviewService calcula indicadores centrais reais a partir do SQLite.
 * 2. adminOverviewService mascara dados pessoais conforme a LGPD.
 * 3. GET /api/admin/overview exige sessão interativa de administrador com MFA.
 * 4. GET /api/admin/clients-consolidated exige sessão interativa e aplica filtros e busca.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Configuração de ambiente isolado em os.tmpdir()
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raia-cmd073-f4-'));
const tempDbPath = path.join(tempDir, 'test_admin_overview.db');

process.env.DB_PATH = tempDbPath;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'TestMasterAdminSecret2026!#Strong';
process.env.SESSION_SECRET = 'TestSessionSecretSuperSecure2026_123456';
process.env.CLIENT_AUTH_SECRET = 'TestClientAuthSecretSuperSecure2026_123';
process.env.MFA_ENCRYPTION_KEY = 'TestMfaEncryptionKeyIndependent2026_987';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';

const db = require('../src/database/db');
const userService = require('../src/services/userService');
const adminOverviewService = require('../src/services/adminOverviewService');
const { app } = require('../src/server/app');

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
        try { json = JSON.parse(rawData); } catch (_) {}
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

describe('COMANDO 073 — FASE 4: Novo Painel Central do Administrador', () => {
  let adminSessionToken;
  let clientSessionToken;

  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Obter ou criar Admin com MFA verificado
    let admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1").get();
    if (!admin) {
      const created = userService.getOrCreateUser({ phoneNumber: '5511999990001', name: 'Master Admin' });
      admin = created.user;
      db.prepare("UPDATE users SET role = 'ADMIN', plan = 'PRO' WHERE id = ?").run(admin.id);
    }
    const adminSession = userService.createUserSession(admin.id, 7, { mfaVerified: true });
    adminSessionToken = adminSession.sessionToken;

    // 2. Criar Clientes de Demonstração para testes dos KPIs
    const c1 = userService.getOrCreateUser({ phoneNumber: '5511977771111', name: 'Juliana Mendes' }).user;
    db.prepare(`
      UPDATE users SET role = 'CLIENT', plan = 'PRO', password_hash = 'valid_hash_123', paid_until = '2026-12-31' WHERE id = ?
    `).run(c1.id);
    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, whatsapp_status, phone)
      VALUES (?, 'Studio Juliana Hair', 'CONNECTED', '5511977771111')
    `).run(c1.id);

    // Contrato Ativo Jéssica Pro R$ 139 (13900 cents)
    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, origin, status, price_cents)
      VALUES (?, 1, 3, 'HOTMART', 'ACTIVE', 13900)
    `).run(c1.id);

    const c2 = userService.getOrCreateUser({ phoneNumber: '5511977772222', name: 'Marcos Barbearia' }).user;
    db.prepare(`
      UPDATE users SET role = 'CLIENT', plan = 'START', password_hash = NULL WHERE id = ?
    `).run(c2.id);
    db.prepare(`
      INSERT OR REPLACE INTO client_salons (user_id, salon_name, whatsapp_status, phone)
      VALUES (?, 'Barbearia do Marcos', 'DISCONNECTED', '5511977772222')
    `).run(c2.id);

    // Contrato Pendente Jéssica Start R$ 89
    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, origin, status, price_cents)
      VALUES (?, 1, 1, 'ASAAS', 'PENDING', 8900)
    `).run(c2.id);

    const clientSession = userService.createUserSession(c1.id, 7);
    clientSessionToken = clientSession.sessionToken;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('1. adminOverviewService.getAdminOverviewMetrics calcula indicadores consolidados reais', () => {
    const data = adminOverviewService.getAdminOverviewMetrics();
    assert.ok(data.summary, 'Deve retornar summary com métricas');
    assert.ok(data.summary.totalClients >= 2, 'Total de clientes deve incluir os clientes criados');
    assert.ok(data.summary.activeSubscriptions >= 1, 'Deve identificar ao menos 1 assinatura ativa');
    assert.ok(data.summary.pendingSubscriptions >= 1, 'Deve identificar ao menos 1 assinatura pendente');
    assert.ok(data.summary.mrrCents >= 13900, 'MRR deve ser de pelo menos R$ 139,00');
    assert.match(data.summary.mrrFormatted, /R\$\s*139/);
    assert.ok(data.summary.whatsappConnected >= 1, 'Deve registrar ao menos 1 WhatsApp conectado');
    assert.ok(data.summary.whatsappDisconnected >= 1, 'Deve registrar ao menos 1 WhatsApp desconectado');
  });

  test('2. adminOverviewService.getAdminClientsList mascara dados de acordo com a LGPD', () => {
    const clients = adminOverviewService.getAdminClientsList({ limit: 10 });
    assert.ok(Array.isArray(clients));
    assert.ok(clients.length >= 2);

    const juliana = clients.find(c => c.salonName === 'Studio Juliana Hair');
    assert.ok(juliana, 'Deve localizar Studio Juliana Hair');
    assert.match(juliana.phoneMasked, /\*\*\*/, 'Telefone deve estar mascarado para conformidade LGPD');
    assert.match(juliana.contactNameMasked, /\*\*\*/, 'Nome de contato deve estar minimizado');
    assert.equal(juliana.subscriptionStatus, 'ACTIVE');
    assert.equal(juliana.channel, 'HOTMART');
    assert.equal(juliana.whatsappStatus, 'CONNECTED');
  });

  test('3. GET /api/admin/overview: bloqueia anônimos e clientes comuns, responde para admin com MFA', async () => {
    // Anônimo: 401
    const anonRes = await makeRequest('GET', '/api/admin/overview');
    assert.equal(anonRes.statusCode, 401);

    // Cliente comum: 403
    const clientRes = await makeRequest('GET', '/api/admin/overview', {
      Authorization: `Bearer ${clientSessionToken}`
    });
    assert.equal(clientRes.statusCode, 403);

    // Admin autenticado interativamente com MFA: 200 OK
    const adminRes = await makeRequest('GET', '/api/admin/overview', {
      Authorization: `Bearer ${adminSessionToken}`
    });
    assert.equal(adminRes.statusCode, 200);
    assert.equal(adminRes.body.success, true);
    assert.ok(adminRes.body.summary);
    assert.ok(Array.isArray(adminRes.body.clientsByPlan));
    assert.ok(Array.isArray(adminRes.body.clientsByChannel));
  });

  test('4. GET /api/admin/clients-consolidated: permite busca e filtros estruturados', async () => {
    // Busca por "Juliana"
    const searchRes = await makeRequest('GET', '/api/admin/clients-consolidated?search=Juliana', {
      Authorization: `Bearer ${adminSessionToken}`
    });
    assert.equal(searchRes.statusCode, 200);
    assert.equal(searchRes.body.success, true);
    assert.ok(searchRes.body.clients.length >= 1);
    assert.equal(searchRes.body.clients[0].salonName, 'Studio Juliana Hair');

    // Filtro por canal "HOTMART"
    const hotmartRes = await makeRequest('GET', '/api/admin/clients-consolidated?origin=HOTMART', {
      Authorization: `Bearer ${adminSessionToken}`
    });
    assert.equal(hotmartRes.statusCode, 200);
    assert.ok(hotmartRes.body.clients.every(c => c.channel === 'HOTMART'));
  });
});
