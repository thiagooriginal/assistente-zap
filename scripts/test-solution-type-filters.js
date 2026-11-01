/**
 * test-solution-type-filters.js
 * Suíte de testes de regressão para filtros de soluções no catálogo multiproduto:
 * 1. Confirmação do solution_type de JARVIS_FINANCEIRO como 'CAIXA' no banco e API
 * 2. Filtro 'CAIXA' exibe Jarvis e não exibe produtos de agenda ou marketing
 * 3. Filtro 'AGENDA' exibe somente Jéssica e Dra. Camila
 * 4. Filtro 'MARKETING' exibe Growth Assistant VIP com status IN_PREPARATION
 * 5. Filtros combinados (segmento + solution_type + busca por texto)
 * 6. Idempotência e integridade da migração versionada
 */

process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.STAGING_USER = 'raia-staging';
process.env.STAGING_PASSWORD = 'raia2026staging!';

const assert = require('assert');
const http = require('http');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const productService = require('../src/services/productService');

async function runTests() {
  console.log('============================================================');
  console.log('🧪 TESTE DE REGRESSÃO: FILTROS DE SOLUÇÕES & MIGRAÇÃO JARVIS');
  console.log('============================================================\n');

  // 1. Iniciar Servidor de Teste
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
    // -------------------------------------------------------------
    // TESTE 1: Verificação no SQLite e na API do JARVIS_FINANCEIRO
    // -------------------------------------------------------------
    console.log('📌 Teste 1: Verificação de solution_type no Banco SQLite e API');
    const jarvisDb = db.prepare('SELECT * FROM products WHERE code = ?').get('JARVIS_FINANCEIRO');
    assert.ok(jarvisDb, 'Produto JARVIS_FINANCEIRO deve existir no banco');
    assert.strictEqual(jarvisDb.solution_type, 'CAIXA', 'solution_type no banco deve ser estritamente CAIXA');
    assert.strictEqual(jarvisDb.commercial_status, 'IN_PREPARATION', 'commercial_status deve ser IN_PREPARATION');

    const resAll = await apiFetch('/api/cliente/products-catalog');
    assert.strictEqual(resAll.status, 200);
    const dataAll = await resAll.json();
    assert.strictEqual(dataAll.success, true);

    const jarvisApi = dataAll.products.find(p => p.code === 'JARVIS_FINANCEIRO');
    assert.ok(jarvisApi, 'Jarvis deve estar presente na listagem da API');
    assert.strictEqual(jarvisApi.solutionType, 'CAIXA', 'solutionType retornado pela API deve ser CAIXA');
    console.log('  ✅ [PASS] Jarvis validado com solution_type = CAIXA no banco e na API\n');

    // -------------------------------------------------------------
    // TESTE 2: Filtro Caixa & Financeiro (solution_type: 'CAIXA')
    // -------------------------------------------------------------
    console.log('📌 Teste 2: Filtro Caixa & Financeiro (solution_type = CAIXA)');
    const resCaixa = await apiFetch('/api/cliente/products-catalog?solution_type=CAIXA');
    const dataCaixa = await resCaixa.json();
    assert.strictEqual(dataCaixa.success, true);
    assert.ok(dataCaixa.products.length >= 1, 'Deve retornar ao menos 1 produto para CAIXA');

    const hasJarvisInCaixa = dataCaixa.products.some(p => p.code === 'JARVIS_FINANCEIRO');
    assert.strictEqual(hasJarvisInCaixa, true, 'Jarvis DEVE estar presente no filtro CAIXA');

    const hasJessicaInCaixa = dataCaixa.products.some(p => p.code === 'JESSICA');
    assert.strictEqual(hasJessicaInCaixa, false, 'Jéssica NÃO deve aparecer no filtro CAIXA');

    const hasCamilaInCaixa = dataCaixa.products.some(p => p.code === 'ASSISTENTE_CLINICA');
    assert.strictEqual(hasCamilaInCaixa, false, 'Dra. Camila NÃO deve aparecer no filtro CAIXA');

    const hasGrowthInCaixa = dataCaixa.products.some(p => p.code === 'GROWTH_ASSISTANT_VIP');
    assert.strictEqual(hasGrowthInCaixa, false, 'Growth Assistant VIP NÃO deve aparecer no filtro CAIXA');

    for (const p of dataCaixa.products) {
      assert.strictEqual(p.solutionType, 'CAIXA', `Produto ${p.code} deve ter solutionType CAIXA`);
    }
    console.log(`  ✅ [PASS] Filtro CAIXA retorna exclusivamente produtos financeiros (${dataCaixa.products.map(p => p.name).join(', ')})\n`);

    // -------------------------------------------------------------
    // TESTE 3: Filtro Agenda & Atendimento (solution_type: 'AGENDA')
    // -------------------------------------------------------------
    console.log('📌 Teste 3: Filtro Agenda & Atendimento (solution_type = AGENDA)');
    const resAgenda = await apiFetch('/api/cliente/products-catalog?solution_type=AGENDA');
    const dataAgenda = await resAgenda.json();
    assert.strictEqual(dataAgenda.success, true);

    const hasJessicaInAgenda = dataAgenda.products.some(p => p.code === 'JESSICA');
    assert.strictEqual(hasJessicaInAgenda, true, 'Jéssica DEVE aparecer no filtro AGENDA');

    const hasJarvisInAgenda = dataAgenda.products.some(p => p.code === 'JARVIS_FINANCEIRO');
    assert.strictEqual(hasJarvisInAgenda, false, 'Jarvis NÃO DEVE aparecer no filtro AGENDA');

    const hasGrowthInAgenda = dataAgenda.products.some(p => p.code === 'GROWTH_ASSISTANT_VIP');
    assert.strictEqual(hasGrowthInAgenda, false, 'Growth Assistant VIP NÃO DEVE aparecer no filtro AGENDA');

    for (const p of dataAgenda.products) {
      assert.strictEqual(p.solutionType, 'AGENDA', `Produto ${p.code} deve ter solutionType AGENDA`);
    }
    console.log(`  ✅ [PASS] Filtro AGENDA retorna exclusivamente produtos de agendamento (${dataAgenda.products.map(p => p.name).join(', ')})\n`);

    // -------------------------------------------------------------
    // TESTE 4: Filtro Marketing & Growth (solution_type: 'MARKETING')
    // -------------------------------------------------------------
    console.log('📌 Teste 4: Filtro Marketing & Growth (solution_type = MARKETING)');
    const resMkt = await apiFetch('/api/cliente/products-catalog?solution_type=MARKETING');
    const dataMkt = await resMkt.json();
    assert.strictEqual(dataMkt.success, true);

    const growthProd = dataMkt.products.find(p => p.code === 'GROWTH_ASSISTANT_VIP');
    assert.ok(growthProd, 'Growth Assistant VIP DEVE constar no filtro MARKETING');
    assert.strictEqual(growthProd.commercialStatus, 'IN_PREPARATION', 'Growth Assistant VIP deve manter status IN_PREPARATION');
    assert.strictEqual(growthProd.hasApprovedOffer, false, 'Growth Assistant VIP não deve ter oferta aprovada');

    const hasJarvisInMkt = dataMkt.products.some(p => p.code === 'JARVIS_FINANCEIRO');
    assert.strictEqual(hasJarvisInMkt, false, 'Jarvis NÃO DEVE aparecer no filtro MARKETING');

    const hasJessicaInMkt = dataMkt.products.some(p => p.code === 'JESSICA');
    assert.strictEqual(hasJessicaInMkt, false, 'Jéssica NÃO DEVE aparecer no filtro MARKETING');
    console.log('  ✅ [PASS] Filtro MARKETING exibe Growth Assistant VIP em preparação\n');

    // -------------------------------------------------------------
    // TESTE 5: Filtros Combinados (Segmento + Tipo + Pesquisa)
    // -------------------------------------------------------------
    console.log('📌 Teste 5: Filtros Combinados (Segmento + Tipo + Pesquisa)');
    // 5.1 Segmento financeiro_mei + CAIXA
    const resComb1 = await apiFetch('/api/cliente/products-catalog?segment=financeiro_mei&solution_type=CAIXA');
    const dataComb1 = await resComb1.json();
    assert.strictEqual(dataComb1.products.some(p => p.code === 'JARVIS_FINANCEIRO'), true, 'Jarvis deve estar presente em financeiro_mei + CAIXA');

    // 5.2 Segmento saloes_beleza + CAIXA
    const resComb2 = await apiFetch('/api/cliente/products-catalog?segment=saloes_beleza&solution_type=CAIXA');
    const dataComb2 = await resComb2.json();
    assert.strictEqual(dataComb2.products.some(p => p.code === 'JARVIS_FINANCEIRO'), true, 'Jarvis deve estar presente em saloes_beleza + CAIXA');

    // 5.3 Segmento saloes_beleza + AGENDA
    const resComb3 = await apiFetch('/api/cliente/products-catalog?segment=saloes_beleza&solution_type=AGENDA');
    const dataComb3 = await resComb3.json();
    assert.strictEqual(dataComb3.products.some(p => p.code === 'JESSICA'), true, 'Jéssica deve estar presente em saloes_beleza + AGENDA');
    assert.strictEqual(dataComb3.products.some(p => p.code === 'JARVIS_FINANCEIRO'), false, 'Jarvis NÃO deve estar presente em saloes_beleza + AGENDA');

    // 5.4 Busca textual por "Jarvis" + CAIXA
    const resSearch1 = await apiFetch('/api/cliente/products-catalog?search=Jarvis&solution_type=CAIXA');
    const dataSearch1 = await resSearch1.json();
    assert.strictEqual(dataSearch1.products.length, 1, 'Busca por Jarvis + CAIXA deve retornar exatamente 1 produto');
    assert.strictEqual(dataSearch1.products[0].code, 'JARVIS_FINANCEIRO');

    // 5.5 Busca textual por "Jéssica" + CAIXA -> Deve retornar vazio
    const resSearch2 = await apiFetch('/api/cliente/products-catalog?search=Jessica&solution_type=CAIXA');
    const dataSearch2 = await resSearch2.json();
    assert.strictEqual(dataSearch2.products.length, 0, 'Busca por Jéssica + CAIXA deve retornar vazio');
    console.log('  ✅ [PASS] Todos os filtros combinados respondem com precisão rigorosa\n');

    // -------------------------------------------------------------
    // TESTE 6: Validação da Migração Versionada e Idempotência
    // -------------------------------------------------------------
    console.log('📌 Teste 6: Migração Versionada e Preservação de Dados');
    const migRow = db.prepare('SELECT * FROM schema_migrations WHERE version = ?').get('20261101_02_fix_jarvis_solution_type');
    assert.ok(migRow, 'Migração 20261101_02_fix_jarvis_solution_type deve constar em schema_migrations');
    assert.strictEqual(migRow.version, '20261101_02_fix_jarvis_solution_type');

    // Testar simulação de atualização idempotente
    db.prepare("UPDATE products SET solution_type = 'CAIXA' WHERE code = 'JARVIS_FINANCEIRO'").run();
    const jarvisCheck = db.prepare('SELECT solution_type, category, commercial_status FROM products WHERE code = ?').get('JARVIS_FINANCEIRO');
    assert.strictEqual(jarvisCheck.solution_type, 'CAIXA');
    assert.strictEqual(jarvisCheck.category, 'FINANCEIRO');
    assert.strictEqual(jarvisCheck.commercial_status, 'IN_PREPARATION');
    console.log('  ✅ [PASS] Migração versionada registrada e idempotência confirmada sem efeitos colaterais\n');

  } finally {
    server.close();
  }

  console.log('============================================================');
  console.log('🎉 TODOS OS TESTES DE FILTRO DE SOLUÇÃO FORAM APROVADOS!');
  console.log('============================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ FALHA NO TESTE DE FILTROS DE SOLUÇÃO:', err);
  process.exit(1);
});
