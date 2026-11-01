/**
 * test-painel-frontend-fix.js
 * Validação da correção urgente do painel multiproduto:
 * 1. Parser Node.js de sintaxe de todos os scripts inline em painel.html
 * 2. Disponibilidade da rota /qrcode.png com HTTP 200 (PNG)
 * 3. Validação dos endpoints consumidos pelo painel: /api/cliente/profile, /api/cliente/my-products, /api/cliente/products-catalog, /api/cliente/segments
 * 4. Verificação de status comercial de produtos em preparação (Growth Assistant VIP)
 * 5. Verificação dos 10 segmentos oficiais
 */

process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.STAGING_USER = 'raia-staging';
process.env.STAGING_PASSWORD = 'raia2026staging!';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const clientAuth = require('../src/services/clientAuthService');
const productService = require('../src/services/productService');

async function runValidation() {
  console.log('============================================================');
  console.log('🧪 TESTE DE VALIDAÇÃO: CORREÇÃO DO PAINEL MULTIPRODUTO');
  console.log('============================================================\n');

  // 1. Sintaxe dos scripts inline do painel.html
  console.log('📌 Teste 1: Validação de Sintaxe dos Scripts Inline (Node.js vm)');
  const painelHtml = fs.readFileSync(path.resolve(__dirname, '../public/cliente/painel.html'), 'utf8');
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptCount = 0;
  while ((match = scriptRegex.exec(painelHtml)) !== null) {
    const code = match[1].trim();
    if (!code) continue;
    scriptCount++;
    assert.doesNotThrow(() => {
      new vm.Script(code);
    }, `SyntaxError detectado no script ${scriptCount} de painel.html!`);
  }
  assert.ok(scriptCount >= 2, 'Pelo menos 2 scripts inline devem ser analisados');
  console.log(`  ✅ [PASS] Todos os ${scriptCount} scripts inline do painel.html possuem sintaxe JavaScript válida!\n`);

  // 2. Start Test Server
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const basicAuthHeader = 'Basic ' + Buffer.from('raia-staging:raia2026staging!').toString('base64');

  function apiFetch(urlPath, opts = {}) {
    const headers = Object.assign({ Authorization: basicAuthHeader }, opts.headers || {});
    return fetch(`${baseUrl}${urlPath}`, Object.assign({}, opts, { headers }));
  }

  try {
    // 3. Teste /qrcode.png
    console.log('📌 Teste 2: Verificação da Imagem /qrcode.png (Evita 404 no console)');
    const qrRes = await apiFetch('/qrcode.png');
    assert.strictEqual(qrRes.status, 200, `Status de /qrcode.png deve ser 200 (recebido: ${qrRes.status})`);
    const ct = qrRes.headers.get('content-type') || '';
    assert.ok(ct.includes('image/png'), `Content-Type deve ser image/png (recebido: ${ct})`);
    const qrBuffer = await qrRes.arrayBuffer();
    assert.ok(qrBuffer.byteLength > 100, 'Buffer da imagem QR deve ser válido');
    console.log(`  ✅ [PASS] /qrcode.png responde HTTP 200 com imagem PNG válida (${qrBuffer.byteLength} bytes)!\n`);

    // 4. Criação de token de cliente para testes dos endpoints consumidos pelo painel
    console.log('📌 Teste 3: Simulação de Sessão do Cliente e Endpoints do Painel');
    const testEmail = `painel_fix_${Date.now()}@teste.com`;
    const plainPass = 'SenhaSegura123!';
    const { hash, salt } = clientAuth.hashPassword(plainPass);
    const userRes = db.prepare(`
      INSERT INTO users (email, phone_number, name, role, plan_tier, subscription_status, password_hash, password_salt)
      VALUES (?, ?, 'Cliente Validação Painel', 'USER', 'JESSICA_START', 'ACTIVE', ?, ?)
    `).run(testEmail, `55119${Date.now().toString().slice(-8)}`, hash, salt);
    const userId = Number(userRes.lastInsertRowid);

    // Salão de beleza vinculado
    clientAuth.ensureSalonForUser(userId, 'Studio Validação RAIA');

    // Assinatura do produto Jéssica
    const futurePaid = new Date(Date.now() + 30 * 86400000).toISOString();
    productService.createCustomerSubscription({
      userId,
      productCode: 'JESSICA',
      planCode: 'START',
      origin: 'ASAAS',
      gateway: 'ASAAS',
      priceCents: 8900,
      status: 'ACTIVE',
      paidUntil: futurePaid,
    });

    // Login para obter sessão oficial
    const loginRes = await apiFetch('/api/cliente/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: plainPass }),
    });
    assert.strictEqual(loginRes.status, 200, 'Login deve responder 200');
    const loginData = await loginRes.json();
    assert.strictEqual(loginData.success, true);
    const token = loginData.token;

    const authHeaders = {
      'x-auth-token': token,
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    };

    // 5. Teste /api/cliente/profile (loadProfile)
    const profRes = await apiFetch('/api/cliente/profile', { headers: authHeaders });
    assert.strictEqual(profRes.status, 200, 'Profile deve responder 200');
    const profData = await profRes.json();
    assert.strictEqual(profData.success, true);
    assert.strictEqual(profData.profile.email, testEmail);
    assert.ok(profData.profile.salon && profData.profile.salon.name.includes('Studio'), 'Deve conter nome do salão');
    console.log('  ✅ [PASS] /api/cliente/profile retorna dados completos do cliente e salão');

    // 6. Teste /api/cliente/my-products (loadMyProducts)
    const myProdRes = await apiFetch('/api/cliente/my-products', { headers: authHeaders });
    assert.strictEqual(myProdRes.status, 200, 'My-products deve responder 200');
    const myProdData = await myProdRes.json();
    assert.strictEqual(myProdData.success, true);
    assert.ok(Array.isArray(myProdData.subscriptions), 'Deve retornar lista de assinaturas');
    assert.ok(myProdData.subscriptions.length >= 1, 'Deve conter pelo menos 1 produto contratado');
    const jessicaSub = myProdData.subscriptions.find(s => s.productCode === 'JESSICA');
    assert.ok(jessicaSub, 'Jéssica deve constar nos produtos contratados');
    assert.strictEqual(jessicaSub.status, 'ACTIVE');
    console.log(`  ✅ [PASS] /api/cliente/my-products retorna ${myProdData.subscriptions.length} produto(s) contratado(s)`);

    // 7. Teste /api/cliente/products-catalog (loadMyProducts spotlight & loadExploreSolutions)
    const catRes = await apiFetch('/api/cliente/products-catalog', { headers: authHeaders });
    assert.strictEqual(catRes.status, 200, 'Catalog deve responder 200');
    const catData = await catRes.json();
    assert.strictEqual(catData.success, true);
    assert.ok(Array.isArray(catData.products), 'Deve retornar lista de produtos');
    assert.ok(catData.products.length >= 3, 'Deve conter produtos semeados');

    const growthVip = catData.products.find(p => p.code === 'GROWTH_ASSISTANT_VIP');
    assert.ok(growthVip, 'Growth Assistant VIP deve constar no catálogo');
    assert.strictEqual(growthVip.commercialStatus, 'IN_PREPARATION', 'Growth Assistant VIP deve estar IN_PREPARATION');
    console.log('  ✅ [PASS] /api/cliente/products-catalog retorna catálogo com Growth Assistant VIP em preparação');

    // 8. Teste /api/cliente/segments (loadExploreSolutions)
    const segRes = await apiFetch('/api/cliente/segments', { headers: authHeaders });
    assert.strictEqual(segRes.status, 200, 'Segments deve responder 200');
    const segData = await segRes.json();
    assert.strictEqual(segData.success, true);
    assert.ok(Array.isArray(segData.segments), 'Deve retornar array de segmentos');
    assert.strictEqual(segData.segments.length, 10, 'Devem existir exatamente os 10 segmentos oficiais');
    console.log('  ✅ [PASS] /api/cliente/segments retorna os 10 segmentos oficiais');

  } finally {
    server.close();
  }

  console.log('\n============================================================');
  console.log('🎉 TODOS OS TESTES DE VALIDAÇÃO DO PAINEL FORAM APROVADOS!');
  console.log('============================================================\n');
}

runValidation().catch(err => {
  console.error('\n❌ FALHA NO TESTE DO PAINEL:', err);
  process.exit(1);
});
