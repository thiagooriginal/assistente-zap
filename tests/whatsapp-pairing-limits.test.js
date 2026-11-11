/**
 * Suíte de Testes Hermética — Validação de Pareamento WhatsApp & Rate Limiting
 * Arquivo: tests/whatsapp-pairing-limits.test.js
 * 
 * COMANDO 033: INVESTIGAÇÃO DO BLOQUEIO INDEVIDO DE PAREAMENTO WHATSAPP (P0)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

// 1. Isolamento Mandatório de Banco de Dados e Ambiente em os.tmpdir()
const uniqueRunId = 'test_wa_limits_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
const tempDbPath = path.join(os.tmpdir(), `${uniqueRunId}.db`);
const tempSessionsDir = path.join(os.tmpdir(), `${uniqueRunId}_sessions`);

process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'false'; // Garante mocks simulados fail-closed
process.env.STAGING_PROTECTION_ENABLED = 'false';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ADMIN_PASSWORD = 'SuperSecureStagingPassword2026!#';
process.env.ADMIN_MASTER_PASSWORD = 'SuperSecureStagingPassword2026!#';
process.env.SESSION_SECRET = 'super_secret_test_session_key_123456';
process.env.CLIENT_AUTH_SECRET = 'super_secret_test_client_key_123456';

// Importa módulos após definição do DB_PATH
const db = require('../src/database/db');
const { app } = require('../src/server/app');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');

salonSessionManager._setBaseDirForTesting(tempSessionsDir);

// Dados dos Tenants de Teste
const TENANT_A = { id: 801, name: 'Salão Alpha', phone: '5511999990001', token: `tok_a_${uniqueRunId}` };
const TENANT_B = { id: 802, name: 'Salão Beta', phone: '5511999990002', token: `tok_b_${uniqueRunId}` };

let server;
let baseUrl;

// Helper para disparar requisições HTTP locais no servidor de teste
function requestApi(endpoint, { method = 'GET', token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const headers = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {
          json = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json,
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('COMANDO 033: Pareamento WhatsApp Jéssica — Testes de Limites e Cota Herméticos', () => {
  before(async () => {
    // Inicializa schemas e fixtures mínimas de usuários e salões
    db.exec(`
      INSERT OR REPLACE INTO users (id, name, phone_number, role, session_token, session_expires_at, is_demo, plan)
      VALUES 
        (${TENANT_A.id}, '${TENANT_A.name}', '${TENANT_A.phone}', 'USER', '${TENANT_A.token}', datetime('now', '+1 day'), 1, 'JESSICA_PRO'),
        (${TENANT_B.id}, '${TENANT_B.name}', '${TENANT_B.phone}', 'USER', '${TENANT_B.token}', datetime('now', '+1 day'), 1, 'JESSICA_PRO');

      INSERT OR REPLACE INTO client_salons (id, user_id, salon_name, phone, created_at)
      VALUES 
        (${TENANT_A.id}, ${TENANT_A.id}, '${TENANT_A.name}', '${TENANT_A.phone}', datetime('now')),
        (${TENANT_B.id}, ${TENANT_B.id}, '${TENANT_B.name}', '${TENANT_B.phone}', datetime('now'));
    `);

    // Inicia Express em porta efêmera aleatória
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    // 1. Encerra servidor HTTP
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // 2. Limpa sessões em memória
    try {
      salonSessionManager._resetForTesting();
      db.close();
    } catch (_) {}

    // 3. Expurga credenciais e banco isolado
    try {
      if (fs.existsSync(tempDbPath)) fs.rmSync(tempDbPath, { force: true });
      if (fs.existsSync(`${tempDbPath}-wal`)) fs.rmSync(`${tempDbPath}-wal`, { force: true });
      if (fs.existsSync(`${tempDbPath}-shm`)) fs.rmSync(`${tempDbPath}-shm`, { force: true });
      if (fs.existsSync(tempSessionsDir)) fs.rmSync(tempSessionsDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it('1. Primeira solicitação legítima de código deve responder 200 sem bloqueio', async () => {
    const res = await requestApi('/api/cliente/whatsapp/connect-code', {
      method: 'POST',
      token: TENANT_A.token,
      body: { phone: '11988887777' },
    });

    assert.equal(res.status, 200, 'Primeira solicitação deve retornar HTTP 200');
    assert.equal(res.body.success, true, 'Resposta deve indicar success: true');
    assert.ok(res.body.pairingCode, 'Deve retornar o pairingCode');
    assert.match(res.body.pairingCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Formato do código deve ser 8 dígitos com hífen');
    assert.equal(res.body.status, 'WAITING_CODE');
  });

  it('2. Alternância entre QR Code e Código de Pareamento não deve queimar cota um do outro', async () => {
    // Inicia sessão QR Code
    const resQr = await requestApi('/api/cliente/whatsapp/connect-qr', {
      method: 'POST',
      token: TENANT_A.token,
    });
    assert.equal(resQr.status, 200);
    assert.equal(resQr.body.success, true);
    assert.ok(resQr.body.qrCode, 'Deve gerar QR Code');

    // Solicita Código de Pareamento logo em seguida
    const resCode = await requestApi('/api/cliente/whatsapp/connect-code', {
      method: 'POST',
      token: TENANT_A.token,
      body: { phone: '11988887777' },
    });
    assert.equal(resCode.status, 200, 'Alternar para Código não pode sofrer bloqueio');
    assert.equal(resCode.body.success, true);
    assert.ok(resCode.body.pairingCode);
  });

  it('3. /whatsapp/cancel-pairing e polling /whatsapp/status NÃO devem consumir cota de rate limit', async () => {
    // Executa 5 leituras de status (polling)
    for (let i = 0; i < 5; i++) {
      const statusRes = await requestApi('/api/cliente/whatsapp/status', {
        method: 'GET',
        token: TENANT_A.token,
      });
      assert.equal(statusRes.status, 200);
    }

    // Executa cancelamento de pareamento
    const cancelRes = await requestApi('/api/cliente/whatsapp/cancel-pairing', {
      method: 'POST',
      token: TENANT_A.token,
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.status, 'DISCONNECTED');

    // Após 5 status e 1 cancelamento, uma nova solicitação de código deve continuar permitida
    const nextCodeRes = await requestApi('/api/cliente/whatsapp/connect-code', {
      method: 'POST',
      token: TENANT_A.token,
      body: { phone: '11988887777' },
    });
    assert.equal(nextCodeRes.status, 200, 'Cancelamento e Polling não podem abater tentativas do usuário');
  });

  it('4. Requisições concorrentes ou duplo clique rápido devem ser tratadas sem falhas inesperadas', async () => {
    // Dispara 2 requisições idênticas em paralelo simulando duplo clique acidental
    const [req1, req2] = await Promise.all([
      requestApi('/api/cliente/whatsapp/connect-code', {
        method: 'POST',
        token: TENANT_A.token,
        body: { phone: '11988887777' },
      }),
      requestApi('/api/cliente/whatsapp/connect-code', {
        method: 'POST',
        token: TENANT_A.token,
        body: { phone: '11988887777' },
      }),
    ]);

    // Ambas devem ter sucesso ou pelo menos uma
    assert.ok(req1.status === 200 || req2.status === 200, 'Ao menos uma chamada paralela deve ter sucesso');
    if (req1.status === 200 && req2.status === 200) {
      assert.equal(req1.body.pairingCode, req2.body.pairingCode, 'Duplo clique concorrente deve compartilhar o mesmo código retornado pelo mutex');
    }
  });

  it('5. Quando o limite de código for legitimamente excedido após 5 tentativas, deve retornar 429 com Retry-After', async () => {
    // Até agora Tenant A fez 1 (teste 1) + 1 (teste 2) + 1 (teste 3) + 2 (teste 4) = 5 chamadas de connect-code
    // A 6ª tentativa deve estourar o limite (maxAttempts = 5) e retornar HTTP 429
    const blockedRes = await requestApi('/api/cliente/whatsapp/connect-code', {
      method: 'POST',
      token: TENANT_A.token,
      body: { phone: '11988887777' },
    });

    assert.equal(blockedRes.status, 429, 'Após exceder o limite real, o status deve ser 429');
    assert.equal(blockedRes.body.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(blockedRes.body.retryAfter > 0, 'retryAfter no corpo deve ser numérico em segundos');
    assert.ok(blockedRes.headers['retry-after'], 'Header HTTP Retry-After deve estar presente');
    assert.ok(Number(blockedRes.headers['retry-after']) > 0);
  });

  it('6. Isolamento estrito entre diferentes tenants: bloqueio do Tenant A NÃO afeta Tenant B', async () => {
    // Tenant A está com cota bloqueada (429) do teste anterior
    const blockedRes = await requestApi('/api/cliente/whatsapp/connect-code', {
      method: 'POST',
      token: TENANT_A.token,
      body: { phone: '11988887777' },
    });
    assert.equal(blockedRes.status, 429, 'Tenant A permanece com cota esgotada');

    // Tenant B faz sua primeira requisição agora e DEVE obter 200 OK
    const tenantBRes = await requestApi('/api/cliente/whatsapp/connect-code', {
      method: 'POST',
      token: TENANT_B.token,
      body: { phone: '11977776666' },
    });
    assert.equal(tenantBRes.status, 200, 'Tenant B deve funcionar perfeitamente sem ser afetado por Tenant A');
    assert.equal(tenantBRes.body.success, true);
    assert.ok(tenantBRes.body.pairingCode);
  });
});
