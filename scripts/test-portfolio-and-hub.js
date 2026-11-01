/**
 * Test Suite: Portfolio Completo, 10 Segmentos Oficiais, Growth Assistant VIP e Central RAIA AGENTES
 * Executado localmente para validar homologação da plataforma multiproduto.
 */

const assert = require('assert');
const http = require('http');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const productService = require('../src/services/productService');
const clientAuth = require('../src/services/clientAuthService');

process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.STAGING_USER = 'raia-staging';
process.env.STAGING_PASSWORD = 'raia2026staging!';

async function runTests() {
  console.log('\n============================================================');
  console.log('🧪 TESTE COMPLETO: PORTFÓLIO, 10 SEGMENTOS & HUB CENTRAL RAIA');
  console.log('============================================================\n');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const basicAuthHeader = 'Basic ' + Buffer.from('raia-staging:raia2026staging!').toString('base64');

  function apiFetch(path, opts = {}) {
    const headers = Object.assign({ Authorization: basicAuthHeader }, opts.headers || {});
    return fetch(`${baseUrl}${path}`, Object.assign({}, opts, { headers }));
  }

  let passedTests = 0;
  let totalTests = 0;

  function test(name, fn) {
    totalTests++;
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message);
      throw err;
    }
  }

  async function testAsync(name, fn) {
    totalTests++;
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message);
      throw err;
    }
  }

  try {
    // 1. Validar 10 Segmentos Oficiais
    await testAsync('1. Validação dos 10 Segmentos Oficiais no Banco e API', async () => {
      const expectedSegments = [
        'saloes_beleza',
        'saude_clinicas',
        'delivery_restaurantes',
        'advocacia_juridico',
        'imobiliarias_corretores',
        'oficinas_autocenters',
        'academias_pilates',
        'financeiro_mei',
        'locacao_obras',
        'veiculos_seminovos',
      ];

      const res = await apiFetch('/api/cliente/segments');
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.ok(Array.isArray(json.segments));

      const returnedCodes = json.segments.map(s => s.code);
      expectedSegments.forEach(code => {
        assert.ok(returnedCodes.includes(code), `Segmento obrigatório ${code} não retornado na API`);
      });
      assert.ok(json.segments.length >= 10, 'Devem existir pelo menos os 10 segmentos oficiais');
    });

    // 2. Multi-segmento N:N e Portfólio Inicial
    test('2. Multi-segmentos N:N em produtos cadastrados', () => {
      const jarvis = productService.getProductByCode('JARVIS_FINANCEIRO');
      assert.ok(jarvis, 'Jarvis Financeiro deve existir');
      const jarvisSegments = productService.getProductSegments(jarvis.id).map(s => s.code);
      assert.ok(jarvisSegments.includes('financeiro_mei'), 'Jarvis deve estar no segmento financeiro_mei');
      assert.ok(jarvisSegments.includes('saloes_beleza'), 'Jarvis deve estar associado a salões de beleza');

      const growth = productService.getProductByCode('GROWTH_ASSISTANT_VIP');
      assert.ok(growth, 'Growth Assistant VIP deve existir');
      assert.strictEqual(growth.solution_type, 'MARKETING');
      assert.strictEqual(growth.commercial_status, 'IN_PREPARATION');
      assert.strictEqual(growth.has_approved_offer, 0);

      const growthSegments = productService.getProductSegments(growth.id).map(s => s.code);
      assert.ok(growthSegments.length > 1, 'Growth Assistant VIP deve pertencer a múltiplos segmentos');
    });

    // 3. Catálogo Comercial: Filtros por Segmento, Tipo de Solução e Busca
    await testAsync('3. Filtros do Catálogo Comercial (segmento, solução, busca)', async () => {
      // Filtro por segmento saloes_beleza
      const resBeleza = await apiFetch('/api/cliente/products-catalog?segment=saloes_beleza');
      assert.strictEqual(resBeleza.status, 200);
      const jsonBeleza = await resBeleza.json();
      const codesBeleza = jsonBeleza.products.map(p => p.code);
      assert.ok(codesBeleza.includes('JESSICA'), 'Jéssica deve aparecer em saloes_beleza');

      // Filtro por tipo de solução CAIXA
      const resCaixa = await apiFetch('/api/cliente/products-catalog?solution_type=CAIXA');
      assert.strictEqual(resCaixa.status, 200);
      const jsonCaixa = await resCaixa.json();
      const codesCaixa = jsonCaixa.products.map(p => p.code);
      assert.ok(codesCaixa.includes('JARVIS_FINANCEIRO'), 'Jarvis deve aparecer no tipo CAIXA');

      // Busca por termo
      const resSearch = await apiFetch('/api/cliente/products-catalog?search=Growth');
      assert.strictEqual(resSearch.status, 200);
      const jsonSearch = await resSearch.json();
      const codesSearch = jsonSearch.products.map(p => p.code);
      assert.ok(codesSearch.includes('GROWTH_ASSISTANT_VIP'), 'Busca por "Growth" deve retornar GROWTH_ASSISTANT_VIP');
    });

    // 4. Detalhes Individuais de Produto e Regra de Bloqueio de Compra
    await testAsync('4. Detalhes do Produto: Bloqueio de compra para produtos Em Preparação', async () => {
      // Growth Assistant VIP (Em Preparação)
      const resGrowth = await apiFetch('/api/cliente/products/GROWTH_ASSISTANT_VIP/details');
      assert.strictEqual(resGrowth.status, 200);
      const jsonGrowth = await resGrowth.json();
      const growth = jsonGrowth.product;
      assert.strictEqual(growth.commercialStatus, 'IN_PREPARATION');
      assert.strictEqual(growth.hasApprovedOffer, false);
      assert.strictEqual(growth.canPurchase, false, 'Growth VIP NÃO pode permitir compra enquanto em preparação');
      assert.strictEqual(growth.plans.length, 0, 'Growth VIP não deve possuir planos cadastrados');
      assert.ok(Array.isArray(growth.plannedFeatures) && growth.plannedFeatures.length >= 4);

      // Jarvis Financeiro (Em Preparação sem preços não aprovados)
      const resJarvis = await apiFetch('/api/cliente/products/JARVIS_FINANCEIRO/details');
      assert.strictEqual(resJarvis.status, 200);
      const jarvis = (await resJarvis.json()).product;
      assert.strictEqual(jarvis.commercialStatus, 'IN_PREPARATION');
      assert.strictEqual(jarvis.hasApprovedOffer, false);
      assert.strictEqual(jarvis.canPurchase, false, 'Jarvis não deve permitir compra enquanto em preparação');
      assert.strictEqual(jarvis.plans.length, 0, 'Jarvis não deve ter planos com preços não aprovados');

      // Dra. Camila (Em Preparação sem preços não aprovados)
      const resCamila = await apiFetch('/api/cliente/products/ASSISTENTE_CLINICA/details');
      assert.strictEqual(resCamila.status, 200);
      const camila = (await resCamila.json()).product;
      assert.strictEqual(camila.commercialStatus, 'IN_PREPARATION');
      assert.strictEqual(camila.hasApprovedOffer, false);
      assert.strictEqual(camila.canPurchase, false, 'Dra. Camila não deve permitir compra enquanto em preparação');
      assert.strictEqual(camila.plans.length, 0, 'Dra. Camila não deve ter planos com preços não aprovados');

      // Jéssica (Disponível com oferta aprovada)
      const resJessica = await apiFetch('/api/cliente/products/JESSICA/details');
      assert.strictEqual(resJessica.status, 200);
      const jsonJessica = await resJessica.json();
      const jessica = jsonJessica.product;
      assert.strictEqual(jessica.commercialStatus, 'AVAILABLE');
      assert.strictEqual(jessica.hasApprovedOffer, true);
      assert.strictEqual(jessica.canPurchase, true, 'Jéssica deve permitir compra');
      assert.ok(jessica.plans.length >= 3, 'Jéssica deve ter 3 planos aprovados');
    });

    function nextPhone() {
      return `5511${Date.now().toString().slice(-6)}${Math.floor(1000 + Math.random() * 9000)}`;
    }

    // 5. Cliente com Múltiplos Produtos Independentes
    test('5. Contratações Múltiplas e Independentes por Cliente', () => {
      const testEmail = `multicliente_${Date.now()}@teste.com`;
      const { hash, salt } = clientAuth.hashPassword('senha123');

      const userStmt = db.prepare(`
        INSERT INTO users (phone_number, email, name, role, subscription_status, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, 'CLIENT', 'ACTIVE', ?, ?, datetime('now'), datetime('now'))
      `);
      const userRes = userStmt.run(nextPhone(), testEmail, 'Cliente Multi', hash, salt);
      const userId = userRes.lastInsertRowid;

      // Assina Jéssica
      const subJessica = productService.createCustomerSubscription({
        userId,
        productCode: 'JESSICA',
        planCode: 'START',
        priceCents: 5900,
        billingCycle: 'MONTHLY',
        origin: 'ASAAS',
        status: 'ACTIVE',
        paidUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      assert.ok(subJessica.id, 'Assinatura de Jéssica deve ser criada');

      // Valida acesso a Jéssica
      const accessJessica = productService.hasProductAccess(userId, 'JESSICA');
      assert.strictEqual(accessJessica.hasAccess, true, 'Deve ter acesso liberado à Jéssica');

      // Valida que NÃO tem acesso a Jarvis Financeiro ainda
      const accessJarvis = productService.hasProductAccess(userId, 'JARVIS_FINANCEIRO');
      assert.strictEqual(accessJarvis.hasAccess, false, 'Não deve ter acesso ao Jarvis');

      // Agora assina Jarvis também
      const subJarvis = productService.createCustomerSubscription({
        userId,
        productCode: 'JARVIS_FINANCEIRO',
        priceCents: 9900,
        billingCycle: 'MONTHLY',
        origin: 'ASAAS',
        status: 'ACTIVE',
        paidUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      assert.ok(subJarvis.id, 'Assinatura de Jarvis deve ser criada');
      assert.strictEqual(productService.hasProductAccess(userId, 'JARVIS_FINANCEIRO').hasAccess, true, 'Agora deve ter acesso ao Jarvis');
      assert.strictEqual(productService.hasProductAccess(userId, 'JESSICA').hasAccess, true, 'Jéssica continua ativo');
    });

    // 6. Cancelamento Sem Fidelidade (preserva acesso até paid_until e isola outros produtos)
    test('6. Cancelamento sem fidelidade preserva acesso até paid_until e isola produtos', () => {
      const testEmail = `cancel_${Date.now()}@teste.com`;
      const { hash, salt } = clientAuth.hashPassword('senha123');
      const userRes = db.prepare(`
        INSERT INTO users (phone_number, email, name, role, subscription_status, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, 'CLIENT', 'ACTIVE', ?, ?, datetime('now'), datetime('now'))
      `).run(nextPhone(), testEmail, 'Cliente Cancelamento', hash, salt);
      const userId = userRes.lastInsertRowid;

      const futureDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

      const sub1 = productService.createCustomerSubscription({
        userId,
        productCode: 'JESSICA',
        planCode: 'START',
        priceCents: 5900,
        origin: 'ASAAS',
        status: 'ACTIVE',
        paidUntil: futureDate,
      });

      const sub2 = productService.createCustomerSubscription({
        userId,
        productCode: 'JARVIS_FINANCEIRO',
        priceCents: 9900,
        origin: 'ASAAS',
        status: 'ACTIVE',
        paidUntil: futureDate,
      });

      // Cancela sub1 (Jéssica)
      const cancelled = productService.cancelSubscription(sub1.id, { reason: 'Cancelado pelo cliente' });
      assert.strictEqual(cancelled.status, 'CANCELLED');
      assert.ok(cancelled.paidUntil, 'Sem fidelidade: preserva vigência até o fim do período pago');

      // Jéssica continua acessível até paidUntil futuro
      assert.strictEqual(productService.hasProductAccess(userId, 'JESSICA').hasAccess, true, 'Acesso deve ser mantido até fim do ciclo pago');

      // Jarvis não sofre impacto
      assert.strictEqual(productService.hasProductAccess(userId, 'JARVIS_FINANCEIRO').hasAccess, true, 'Jarvis não deve ser afetado');
    });

    // 7. Pagamento Vencido / Inadimplente Bloqueia Acesso
    test('7. Pagamento vencido revoga acesso imediatamente', () => {
      const testEmail = `overdue_${Date.now()}@teste.com`;
      const { hash, salt } = clientAuth.hashPassword('senha123');
      const userRes = db.prepare(`
        INSERT INTO users (phone_number, email, name, role, subscription_status, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, 'CLIENT', 'ACTIVE', ?, ?, datetime('now'), datetime('now'))
      `).run(nextPhone(), testEmail, 'Cliente Inadimplente', hash, salt);
      const userId = userRes.lastInsertRowid;

      const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

      productService.createCustomerSubscription({
        userId,
        productCode: 'JESSICA',
        planCode: 'START',
        priceCents: 5900,
        origin: 'ASAAS',
        status: 'OVERDUE',
        paidUntil: pastDate,
      });

      assert.strictEqual(productService.hasProductAccess(userId, 'JESSICA').hasAccess, false, 'Assinatura vencida deve ser bloqueada');
    });

    // 8. Pagamento Não Confirmado (Sem paid_until) Bloqueia Acesso
    test('8. Pagamento não confirmado (status PENDING/PAYMENT_UNCONFIRMED) bloqueia acesso', () => {
      const testEmail = `pending_${Date.now()}@teste.com`;
      const { hash, salt } = clientAuth.hashPassword('senha123');
      const userRes = db.prepare(`
        INSERT INTO users (phone_number, email, name, role, subscription_status, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, 'CLIENT', 'ACTIVE', ?, ?, datetime('now'), datetime('now'))
      `).run(nextPhone(), testEmail, 'Cliente Pendente', hash, salt);
      const userId = userRes.lastInsertRowid;

      productService.createCustomerSubscription({
        userId,
        productCode: 'JESSICA',
        planCode: 'START',
        priceCents: 5900,
        origin: 'ASAAS',
        status: 'PAYMENT_UNCONFIRMED',
        paidUntil: null,
      });

      assert.strictEqual(productService.hasProductAccess(userId, 'JESSICA').hasAccess, false, 'Status PAYMENT_UNCONFIRMED deve ser bloqueado');
    });

    // 9. Atualização de Senha do Cliente na Área de Membros
    await testAsync('9. Troca de senha segura no endpoint /api/cliente/profile/password', async () => {
      const testEmail = `pwd_${Date.now()}@teste.com`;
      const oldPassword = 'senhaAntiga123';
      const newPassword = 'senhaNovaForte456';
      const { hash, salt } = clientAuth.hashPassword(oldPassword);

      const userRes = db.prepare(`
        INSERT INTO users (phone_number, email, name, role, subscription_status, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, 'CLIENT', 'ACTIVE', ?, ?, datetime('now'), datetime('now'))
      `).run(nextPhone(), testEmail, 'Cliente Senha', hash, salt);
      const userId = userRes.lastInsertRowid;

      // Cria assinatura para poder logar como cliente
      productService.createCustomerSubscription({
        userId,
        productCode: 'JESSICA',
        planCode: 'START',
        priceCents: 5900,
        origin: 'ASAAS',
        status: 'ACTIVE',
        paidUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      // Login
      const loginRes = await apiFetch('/api/cliente/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: oldPassword }),
      });
      assert.strictEqual(loginRes.status, 200);
      const loginJson = await loginRes.json();
      assert.strictEqual(loginJson.success, true);
      const clientToken = loginJson.token;

      // Tenta trocar com senha errada -> deve retornar 401
      const failRes = await apiFetch('/api/cliente/profile/password', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': clientToken,
        },
        body: JSON.stringify({ currentPassword: 'errada', newPassword }),
      });
      assert.strictEqual(failRes.status, 401);

      // Troca com senha correta
      const okRes = await apiFetch('/api/cliente/profile/password', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': clientToken,
        },
        body: JSON.stringify({ currentPassword: oldPassword, newPassword }),
      });
      assert.strictEqual(okRes.status, 200);
      const okJson = await okRes.json();
      assert.strictEqual(okJson.success, true);

      // Valida hash no banco
      const updatedUser = db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(userId);
      assert.ok(clientAuth.verifyPassword(newPassword, updatedUser.password_hash, updatedUser.password_salt));
    });

    // 10. Histórico Financeiro e Faturas
    await testAsync('10. Endpoint /api/cliente/my-invoices retorna faturas e histórico', async () => {
      const testEmail = `invoices_${Date.now()}@teste.com`;
      const password = 'senhaFaturas123';
      const { hash, salt } = clientAuth.hashPassword(password);

      const userRes = db.prepare(`
        INSERT INTO users (phone_number, email, name, role, subscription_status, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, 'CLIENT', 'ACTIVE', ?, ?, datetime('now'), datetime('now'))
      `).run(nextPhone(), testEmail, 'Cliente Faturas', hash, salt);
      const userId = userRes.lastInsertRowid;

      const jessica = productService.getProductByCode('JESSICA');
      productService.createCustomerSubscription({
        userId,
        productCode: 'JESSICA',
        planCode: 'START',
        priceCents: 8900,
        origin: 'ASAAS',
        status: 'ACTIVE',
        paidUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });

      // Cria registro de pagamento em asaas_payments
      const testAsaasId = `pay_test_hub_${Date.now()}`;
      db.prepare(`
        INSERT INTO asaas_payments (asaas_id, customer_id, value, billing_type, status, description, user_id, paid_at, created_at)
        VALUES (?, 'cus_test_1', 89.00, 'CREDIT_CARD', 'CONFIRMED', 'Mensalidade Jéssica', ?, datetime('now'), datetime('now'))
      `).run(testAsaasId, userId);

      const loginRes = await apiFetch('/api/cliente/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password }),
      });
      assert.strictEqual(loginRes.status, 200);
      const loginJson = await loginRes.json();
      const clientToken = loginJson.token;

      const invRes = await apiFetch('/api/cliente/my-invoices', {
        headers: { 'x-auth-token': clientToken },
      });
      assert.strictEqual(invRes.status, 200);
      const invJson = await invRes.json();
      assert.strictEqual(invJson.success, true);
      assert.ok(Array.isArray(invJson.invoices));
      assert.strictEqual(invJson.invoices.length, 1);
      assert.strictEqual(invJson.invoices[0].value, 89.00);
      assert.strictEqual(invJson.invoices[0].status, 'CONFIRMED');
    });

    // 11. Headers de Segurança, Redirecionamento HTTPS e Política HSTS
    await testAsync('11. Headers de Segurança, Redirecionamento HTTPS 301, HSTS e Proxy Trust', async () => {
      // 11.1 Proxy Trust configurado para 1 salto (apenas Traefik)
      assert.strictEqual(app.get('trust proxy'), 1, 'Trust proxy deve confiar apenas no proxy reverso imediato (1)');

      // 11.2 Cabeçalhos de segurança básicos presentes
      const res = await apiFetch('/api/health/ready');
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(res.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.ok(res.headers.get('content-security-policy')?.includes('upgrade-insecure-requests'));

      // 11.3 HSTS em homologação NÃO deve conter includeSubDomains ou preload
      const hstsStaging = res.headers.get('strict-transport-security');
      if (hstsStaging) {
        assert.strictEqual(hstsStaging.includes('includeSubDomains'), false, 'Staging HSTS NÃO pode ter includeSubDomains');
        assert.strictEqual(hstsStaging.includes('preload'), false, 'Staging HSTS NÃO pode ter preload');
      }

      // 11.4 Cenário de Redirecionamento HTTP -> HTTPS 301
      const resHttp = await fetch(`${baseUrl}/cliente/login`, {
        method: 'GET',
        headers: {
          'x-forwarded-proto': 'http',
          'x-forwarded-host': 'staging.raiaagentes.com.br'
        },
        redirect: 'manual'
      });
      assert.strictEqual(resHttp.status, 301, 'Requisição HTTP em staging deve redirecionar com 301');
      assert.strictEqual(
        resHttp.headers.get('location'),
        'https://staging.raiaagentes.com.br/cliente/login',
        'Redirecionamento deve apontar para HTTPS com domínio staging correto'
      );
    });

    // 12. CRUD de Segmentos Administrativos
    test('12. CRUD completo de Segmentos Administrativos', () => {
      const testCode = `nicho_teste_${Date.now()}`;
      const newSeg = productService.createSegment({
        code: testCode,
        name: 'Nicho Teste Dinâmico',
        description: 'Descrição de teste para novo segmento',
        icon: 'sparkles',
      });
      assert.ok(newSeg.id);
      assert.strictEqual(newSeg.code, testCode);

      // Update
      const updated = productService.updateSegment(newSeg.id, {
        name: 'Nicho Teste Atualizado',
        description: 'Nova descrição',
      });
      assert.strictEqual(updated.name, 'Nicho Teste Atualizado');

      // Delete
      const deleted = productService.deleteSegment(newSeg.id);
      assert.strictEqual(deleted.success, true);

      const lookup = productService.getSegmentByCode(testCode);
      assert.strictEqual(lookup, null, 'Segmento excluído não deve existir');
    });

    console.log('\n============================================================');
    console.log(`🎉 TODOS OS ${passedTests}/${totalTests} TESTES FORAM CONCLUÍDOS COM SUCESSO!`);
    console.log('============================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('\n❌ ERRO NA EXECUÇÃO DA SUITE DE TESTES:', err);
  process.exit(1);
});
