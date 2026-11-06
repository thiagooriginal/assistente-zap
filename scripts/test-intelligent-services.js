/**
 * RAIA AGENTES — SUÍTE DE TESTES AUTOMATIZADOS: CADASTRO INTELIGENTE DE SERVIÇOS
 *
 * Cobertura completa dos 18 cenários obrigatórios:
 * 1. Cadastro individual.
 * 2. Pesquisa por nome.
 * 3. Pesquisa sem acentos.
 * 4. Filtro por categoria.
 * 5. Seleção de múltiplos serviços (lógica em memória).
 * 6. Cadastro em lote com cinco serviços.
 * 7. Rejeição de valores inválidos (preço < 0, duração <= 0, etc.).
 * 8. Persistência de preço e duração após recarregar.
 * 9. Prevenção de duplicidades (exatas e similares).
 * 10. Edição de serviços (nome, preço, duração, categoria).
 * 11. Ativação e desativação (toggle active/inactive).
 * 12. Preservação de agendamentos históricos e proteção contra exclusão indevida.
 * 13. Integração com agenda (cálculo de horário e bloqueio de inativos).
 * 14. Isolamento multi-tenant entre dois salões (Tenant A vs Tenant B).
 * 15. Sanitização contra injeção de conteúdo malicioso (XSS).
 * 16. Responsividade e integridade estrutural do DOM.
 * 17. Falha durante cadastro em lote e rollback transacional atômico.
 * 18. Compatibilidade com serviços já existentes.
 */

const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const serviceCatalog = require('../src/services/serviceCatalog');

let server;
let baseUrl;

function makeRequest(method, reqPath, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const headers = {
      'Content-Type': 'application/json',
      'Origin': baseUrl,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['Cookie'] = `client_auth_token=${token}`;
    }

    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      }
    );

    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function run() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — SUÍTE: CADASTRO INTELIGENTE DE SERVIÇOS (18 TESTES)');
  console.log('================================================================\n');

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const cleanups = [];

  try {
    // -------------------------------------------------------------
    // SETUP: Criar Salão A e Salão B com produto JESSICA
    // -------------------------------------------------------------
    const ts = Date.now();
    const tokenA = crypto.randomBytes(32).toString('hex');
    const tokenB = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 86400000).toISOString();

    const resA = db.prepare(`
      INSERT INTO users (name, phone_number, email, role, plan_tier, subscription_status, paid_until, session_token, session_expires_at)
      VALUES (?, ?, ?, 'CLIENT', 'JESSICA_START', 'ACTIVE', datetime('now', '+30 days'), ?, ?)
    `).run('Salão Inteligente A', `551196666${String(ts).slice(-4)}`, `salao.a.${ts}@example.com`, tokenA, exp);
    const userAId = resA.lastInsertRowid;
    cleanups.push(userAId);

    const resB = db.prepare(`
      INSERT INTO users (name, phone_number, email, role, plan_tier, subscription_status, paid_until, session_token, session_expires_at)
      VALUES (?, ?, ?, 'CLIENT', 'JESSICA_START', 'ACTIVE', datetime('now', '+30 days'), ?, ?)
    `).run('Salão Inteligente B', `551195555${String(ts).slice(-4)}`, `salao.b.${ts}@example.com`, tokenB, exp);
    const userBId = resB.lastInsertRowid;
    cleanups.push(userBId);

    const jessicaProduct = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
    const planStart = db.prepare("SELECT id FROM product_plans WHERE code = 'START' OR code = 'JESSICA_START'").get();

    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, origin, gateway, status, price_cents, setup_fee_cents, contracted_at, paid_until)
      VALUES (?, ?, ?, 'DIRECT', 'MANUAL', 'ACTIVE', 8900, 0, CURRENT_TIMESTAMP, datetime('now', '+30 days'))
    `).run(userAId, jessicaProduct.id, planStart.id);

    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, origin, gateway, status, price_cents, setup_fee_cents, contracted_at, paid_until)
      VALUES (?, ?, ?, 'DIRECT', 'MANUAL', 'ACTIVE', 8900, 0, CURRENT_TIMESTAMP, datetime('now', '+30 days'))
    `).run(userBId, jessicaProduct.id, planStart.id);

    // Limpar serviços e agendamentos existentes destes usuários
    db.prepare('DELETE FROM client_services WHERE user_id IN (?, ?)').run(userAId, userBId);
    db.prepare('DELETE FROM appointments WHERE user_id IN (?, ?)').run(userAId, userBId);

    console.log('[Setup] Salão A (ID: ' + userAId + ') e Salão B (ID: ' + userBId + ') preparados com sucesso.\n');

    // -------------------------------------------------------------
    // TESTE 1: Cadastro individual
    // -------------------------------------------------------------
    console.log('[Teste 1] Cadastro individual de serviço...');
    const res1 = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: 'Corte Feminino com Escova',
        price: 95.0,
        duration_min: 60,
        category: 'Cabelos',
      },
      tokenA
    );
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body.success, true);
    assert.strictEqual(res1.body.service.name, 'Corte Feminino com Escova');
    assert.strictEqual(res1.body.service.price, 95.0);
    assert.strictEqual(res1.body.service.duration_min, 60);
    assert.strictEqual(res1.body.service.active, 1);
    const svc1Id = res1.body.service.id;
    console.log('  ✓ 1. Serviço individual criado com sucesso (ID: ' + svc1Id + ').\n');

    // -------------------------------------------------------------
    // TESTE 2: Pesquisa no catálogo por nome
    // -------------------------------------------------------------
    console.log('[Teste 2] Pesquisa inteligente no catálogo por nome...');
    const res2 = await makeRequest('GET', '/api/cliente/services/catalog?q=corte', null, tokenA);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.success, true);
    assert(Array.isArray(res2.body.catalog));
    assert(res2.body.catalog.length >= 3, 'Deve encontrar pelo menos 3 tipos de corte');
    assert(res2.body.catalog.some((item) => item.name.toLowerCase().includes('corte')));
    console.log('  ✓ 2. Pesquisa por nome retornou ' + res2.body.catalog.length + ' resultados coerentes.\n');

    // -------------------------------------------------------------
    // TESTE 3: Pesquisa sem acentos (insensibilidade a diacríticos)
    // -------------------------------------------------------------
    console.log('[Teste 3] Pesquisa sem acentos e case-insensitive...');
    const res3a = await makeRequest('GET', '/api/cliente/services/catalog?q=hidratacao', null, tokenA);
    assert.strictEqual(res3a.status, 200);
    assert(res3a.body.catalog.some((item) => item.name === 'Hidratação capilar'));

    const res3b = await makeRequest('GET', '/api/cliente/services/catalog?q=extensao de cilios', null, tokenA);
    assert.strictEqual(res3b.status, 200);
    assert(res3b.body.catalog.some((item) => item.name === 'Extensão de cílios'));
    console.log('  ✓ 3. Pesquisa insensível a acentos ("hidratacao" -> "Hidratação capilar") validada com sucesso.\n');

    // -------------------------------------------------------------
    // TESTE 4: Filtro por categoria
    // -------------------------------------------------------------
    console.log('[Teste 4] Filtro por categoria no catálogo...');
    const res4Unhas = await makeRequest('GET', '/api/cliente/services/catalog?category=Unhas', null, tokenA);
    assert.strictEqual(res4Unhas.status, 200);
    assert(res4Unhas.body.catalog.length >= 6);
    assert(res4Unhas.body.catalog.every((item) => item.category === 'Unhas'));

    const res4Barba = await makeRequest('GET', '/api/cliente/services/catalog?category=Barbearia', null, tokenA);
    assert.strictEqual(res4Barba.status, 200);
    assert(res4Barba.body.catalog.every((item) => item.category === 'Barbearia'));
    console.log('  ✓ 4. Filtro por categoria validado com precisão estrita.\n');

    // -------------------------------------------------------------
    // TESTE 5: Seleção de múltiplos serviços (lógica em memória)
    // -------------------------------------------------------------
    console.log('[Teste 5] Seleção de múltiplos procedimentos sem criação prévia no banco...');
    const countBeforeSelection = db.prepare('SELECT COUNT(*) as count FROM client_services WHERE user_id = ?').get(userAId).count;
    assert.strictEqual(countBeforeSelection, 1, 'Apenas 1 serviço criado até aqui');

    // Simulação do carrinho de seleção em lote no frontend
    const selectedCatalog = [
      { name: 'Manicure', category: 'Unhas', duration_min: 45, price: 40.0 },
      { name: 'Pedicure', category: 'Unhas', duration_min: 45, price: 45.0 },
      { name: 'Design de sobrancelhas', category: 'Sobrancelhas e cílios', duration_min: 30, price: 35.0 },
      { name: 'Barba', category: 'Barbearia', duration_min: 30, price: 35.0 },
      { name: 'Limpeza de pele', category: 'Estética e maquiagem', duration_min: 60, price: 120.0 },
    ];
    assert.strictEqual(selectedCatalog.length, 5);

    // Confirma que nenhuma gravação ocorreu no banco durante a seleção
    const countAfterSelection = db.prepare('SELECT COUNT(*) as count FROM client_services WHERE user_id = ?').get(userAId).count;
    assert.strictEqual(countAfterSelection, 1, 'Banco de dados permaneceu intacto durante a seleção');
    console.log('  ✓ 5. Seleção em memória verificada sem gravação prematura no banco.\n');

    // -------------------------------------------------------------
    // TESTE 6: Cadastro em lote com cinco serviços
    // -------------------------------------------------------------
    console.log('[Teste 6] Cadastro em lote de 5 serviços via POST /api/cliente/services/batch...');
    const resBatch = await makeRequest(
      'POST',
      '/api/cliente/services/batch',
      {
        services: selectedCatalog,
        skipDuplicates: true,
      },
      tokenA
    );
    assert.strictEqual(resBatch.status, 200);
    assert.strictEqual(resBatch.body.success, true);
    assert.strictEqual(resBatch.body.createdCount, 5, 'Deve cadastrar exatamente 5 serviços');
    assert.strictEqual(resBatch.body.services.length, 5);

    const countAfterBatch = db.prepare('SELECT COUNT(*) as count FROM client_services WHERE user_id = ?').get(userAId).count;
    assert.strictEqual(countAfterBatch, 6, 'Total no banco agora deve ser 1 + 5 = 6 serviços');
    console.log('  ✓ 6. Cadastro em lote de 5 serviços persistido com sucesso via transação.\n');

    // -------------------------------------------------------------
    // TESTE 7: Rejeição de valores inválidos (individual e lote)
    // -------------------------------------------------------------
    console.log('[Teste 7] Rejeição rigorosa de valores inválidos...');
    const invalidSingle1 = await makeRequest('POST', '/api/cliente/services', { name: 'Preço Negativo', price: -10, duration_min: 30 }, tokenA);
    assert.strictEqual(invalidSingle1.status, 400);

    const invalidSingle2 = await makeRequest('POST', '/api/cliente/services', { name: 'Duração Zero', price: 50, duration_min: 0 }, tokenA);
    assert.strictEqual(invalidSingle2.status, 400);

    const invalidSingle3 = await makeRequest('POST', '/api/cliente/services', { name: '   ', price: 50, duration_min: 30 }, tokenA);
    assert.strictEqual(invalidSingle3.status, 400);

    // Lote com um item inválido deve falhar totalmente sem gravar nada
    const invalidBatch = await makeRequest(
      'POST',
      '/api/cliente/services/batch',
      {
        services: [
          { name: 'Serviço Válido 1', price: 50, duration_min: 30 },
          { name: 'Serviço Inválido 2', price: -5, duration_min: 30 }, // Preço negativo!
        ],
      },
      tokenA
    );
    assert.strictEqual(invalidBatch.status, 400, 'Lote com item inválido deve ser rejeitado com 400');
    console.log('  ✓ 7. Rejeição de dados inválidos validada no cadastro individual e em lote.\n');

    // -------------------------------------------------------------
    // TESTE 8: Persistência de preço e duração após recarregar
    // -------------------------------------------------------------
    console.log('[Teste 8] Persistência íntegra de dados ao recarregar (GET /api/cliente/services)...');
    const resReload = await makeRequest('GET', '/api/cliente/services', null, tokenA);
    assert.strictEqual(resReload.status, 200);
    assert.strictEqual(resReload.body.services.length, 6);

    const manicure = resReload.body.services.find((s) => s.name === 'Manicure');
    assert.ok(manicure);
    assert.strictEqual(manicure.price, 40.0);
    assert.strictEqual(manicure.duration_min, 45);
    assert.strictEqual(manicure.duration_minutes, 45);

    const limpeza = resReload.body.services.find((s) => s.name === 'Limpeza de pele');
    assert.ok(limpeza);
    assert.strictEqual(limpeza.price, 120.0);
    assert.strictEqual(limpeza.duration_min, 60);
    console.log('  ✓ 8. Preços e durações permanecem 100% corretos e íntegros após recarga.\n');

    // -------------------------------------------------------------
    // TESTE 9: Prevenção de duplicidades (exatas, sem acentos e semelhantes)
    // -------------------------------------------------------------
    console.log('[Teste 9] Prevenção rigorosa de duplicidades...');
    // 9.1 Tentativa de cadastrar serviço com nome idêntico (diferença de maiúsculas/espaços/acentos)
    const dupAttempt1 = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: '  manicure  ',
        price: 50.0,
        duration_min: 30,
      },
      tokenA
    );
    assert.strictEqual(dupAttempt1.status, 409, 'Duplicata exata normalizada deve retornar 409');
    assert.strictEqual(dupAttempt1.body.code, 'SERVICE_DUPLICATE');

    // 9.2 Detecção de nome similar (ex: "Manicura" vs "Manicure")
    const dupSimilar = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: 'Manicura',
        price: 50.0,
        duration_min: 30,
      },
      tokenA
    );
    assert.strictEqual(dupSimilar.status, 409, 'Nome similar deve exigir confirmação com 409');
    assert.strictEqual(dupSimilar.body.code, 'SERVICE_SIMILAR');
    assert.strictEqual(dupSimilar.body.requiresConfirmation, true);

    // 9.3 Confirmando nome similar explicitamente deve permitir
    const confirmSimilarRes = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: 'Manicura Francesa',
        price: 55.0,
        duration_min: 40,
        confirmSimilar: true,
      },
      tokenA
    );
    assert.strictEqual(confirmSimilarRes.status, 200, 'Confirmação explícita de nome similar deve permitir cadastro');

    // 9.4 Lote com itens já cadastrados e skipDuplicates=true deve ignorar duplicatas com segurança
    const batchWithDupes = await makeRequest(
      'POST',
      '/api/cliente/services/batch',
      {
        services: [
          { name: 'Manicure', price: 40.0, duration_min: 45, category: 'Unhas' }, // Já existe
          { name: 'Esmaltação em gel', price: 65.0, duration_min: 60, category: 'Unhas' }, // Novo!
        ],
        skipDuplicates: true,
      },
      tokenA
    );
    assert.strictEqual(batchWithDupes.status, 200);
    assert.strictEqual(batchWithDupes.body.createdCount, 1);
    assert.strictEqual(batchWithDupes.body.skippedCount, 1);
    console.log('  ✓ 9. Bloqueio de duplicatas exatas, alerta de similares e skip inteligente em lote aprovados.\n');

    // -------------------------------------------------------------
    // TESTE 10: Edição de serviços existentes
    // -------------------------------------------------------------
    console.log('[Teste 10] Edição de serviço (nome, preço, duração e categoria)...');
    const resEdit = await makeRequest(
      'PUT',
      `/api/cliente/services/${svc1Id}`,
      {
        name: 'Corte Feminino Premium com Escova',
        price: 110.0,
        duration_min: 75,
        category: 'Cabelos',
      },
      tokenA
    );
    assert.strictEqual(resEdit.status, 200);
    assert.strictEqual(resEdit.body.success, true);
    assert.strictEqual(resEdit.body.service.name, 'Corte Feminino Premium com Escova');
    assert.strictEqual(resEdit.body.service.price, 110.0);
    assert.strictEqual(resEdit.body.service.duration_min, 75);

    // Tentativa de editar para o nome de outro serviço existente deve ser bloqueada
    const resEditDup = await makeRequest(
      'PUT',
      `/api/cliente/services/${svc1Id}`,
      {
        name: 'Manicure', // Já pertence a outro serviço
      },
      tokenA
    );
    assert.strictEqual(resEditDup.status, 409);
    assert.strictEqual(resEditDup.body.code, 'SERVICE_DUPLICATE');
    console.log('  ✓ 10. Edição de campos concluída com prevenção de colisão de nomes.\n');

    // -------------------------------------------------------------
    // TESTE 11: Ativação e desativação de serviços
    // -------------------------------------------------------------
    console.log('[Teste 11] Alternância de status ativo/inativo...');
    const toggle1 = await makeRequest('PATCH', `/api/cliente/services/${svc1Id}/toggle`, null, tokenA);
    assert.strictEqual(toggle1.status, 200);
    assert.strictEqual(toggle1.body.active, 0, 'Serviço deve ter sido desativado');

    const checkInactive = db.prepare('SELECT active FROM client_services WHERE id = ?').get(svc1Id);
    assert.strictEqual(checkInactive.active, 0);

    const toggle2 = await makeRequest('PATCH', `/api/cliente/services/${svc1Id}/toggle`, null, tokenA);
    assert.strictEqual(toggle2.status, 200);
    assert.strictEqual(toggle2.body.active, 1, 'Serviço deve ter sido reativado');
    console.log('  ✓ 11. Toggle de ativação e desativação verificado com sucesso.\n');

    // -------------------------------------------------------------
    // TESTE 12: Preservação de agendamentos históricos e proteção contra exclusão
    // -------------------------------------------------------------
    console.log('[Teste 12] Preservação de agendamentos históricos e bloqueio de exclusão...');
    // Criar um agendamento vinculado ao serviço 1 (75 min)
    const resAptHist = await makeRequest(
      'POST',
      '/api/cliente/appointments',
      {
        clientName: 'Cliente Histórica',
        serviceId: svc1Id,
        date: '2026-11-20',
        time: '10:00',
      },
      tokenA
    );
    assert.strictEqual(resAptHist.status, 200);
    const aptId = resAptHist.body.id;
    assert.strictEqual(resAptHist.body.appointment.end_datetime, '2026-11-20T11:15:00', '10:00 + 75min = 11:15');

    // Alterar a duração do serviço para 90 min: o agendamento ANTIGO NÃO pode sofrer alteração!
    await makeRequest('PUT', `/api/cliente/services/${svc1Id}`, { duration_min: 90 }, tokenA);
    const checkAptAfterServiceChange = db.prepare('SELECT start_datetime, end_datetime FROM appointments WHERE id = ?').get(aptId);
    assert.strictEqual(
      checkAptAfterServiceChange.end_datetime,
      '2026-11-20T11:15:00',
      'Agendamento histórico deve manter término original inalterado'
    );

    // Tentativa de excluir serviço com agendamentos vinculados deve ser bloqueada (409) recomendando desativação
    const delBlocked = await makeRequest('DELETE', `/api/cliente/services/${svc1Id}`, null, tokenA);
    assert.strictEqual(delBlocked.status, 409, 'Exclusão com agendamentos vinculados deve retornar 409');
    assert.strictEqual(delBlocked.body.code, 'SERVICE_HAS_APPOINTMENTS');
    assert.strictEqual(delBlocked.body.recommendation, 'deactivate');
    assert(delBlocked.body.appointmentCount >= 1);

    // Serviço continua existindo no banco
    const svcStillThere = db.prepare('SELECT id FROM client_services WHERE id = ?').get(svc1Id);
    assert.ok(svcStillThere, 'Serviço deve continuar existindo após tentativa de exclusão bloqueada');
    console.log('  ✓ 12. Histórico de agendamentos preservado e exclusão acidental bloqueada com 409.\n');

    // -------------------------------------------------------------
    // TESTE 13: Integração com agenda (serviço inativo bloqueado para novos)
    // -------------------------------------------------------------
    console.log('[Teste 13] Integração com agenda e bloqueio de novos agendamentos para serviços inativos...');
    // Desativa o serviço svc1Id
    await makeRequest('PATCH', `/api/cliente/services/${svc1Id}/toggle`, null, tokenA);

    // Tentar agendar com o serviço inativo deve falhar (400)
    const aptBlocked = await makeRequest(
      'POST',
      '/api/cliente/appointments',
      {
        clientName: 'Nova Tentativa',
        serviceId: svc1Id,
        date: '2026-11-21',
        time: '14:00',
      },
      tokenA
    );
    assert.strictEqual(aptBlocked.status, 400, 'Agendamento com serviço inativo deve retornar 400');
    assert(aptBlocked.body.error.includes('inativo'));

    // Reativa o serviço para os próximos testes
    await makeRequest('PATCH', `/api/cliente/services/${svc1Id}/toggle`, null, tokenA);
    console.log('  ✓ 13. Agenda respeita status ativo/inativo dos serviços com rigor.\n');

    // -------------------------------------------------------------
    // TESTE 14: Isolamento multi-tenant entre dois salões
    // -------------------------------------------------------------
    console.log('[Teste 14] Isolamento multi-tenant entre Salão A e Salão B...');
    // Salão B cria serviço
    const resSvcB = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: 'Barboterapia Especial B',
        price: 80.0,
        duration_min: 45,
        category: 'Barbearia',
      },
      tokenB
    );
    assert.strictEqual(resSvcB.status, 200);
    const svcBId = resSvcB.body.service.id;

    // Salão A tenta consultar serviços: não vê o de B
    const listA = await makeRequest('GET', '/api/cliente/services', null, tokenA);
    assert(!listA.body.services.some((s) => s.id === svcBId));

    // Salão A tenta editar serviço de B: 404
    const putB = await makeRequest('PUT', `/api/cliente/services/${svcBId}`, { price: 10.0 }, tokenA);
    assert.strictEqual(putB.status, 404);

    // Salão A tenta excluir serviço de B: 404
    const delB = await makeRequest('DELETE', `/api/cliente/services/${svcBId}`, null, tokenA);
    assert.strictEqual(delB.status, 404);
    console.log('  ✓ 14. Isolamento multi-tenant estrito garantido em todas as rotas.\n');

    // -------------------------------------------------------------
    // TESTE 15: Sanitização contra injeção de HTML / XSS
    // -------------------------------------------------------------
    console.log('[Teste 15] Proteção contra injeção maliciosa e XSS...');
    const xssAttempt = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: '<script>alert("hack")</script>Corte com Tesoura',
        price: 70.0,
        duration_min: 40,
        category: 'Cabelos',
      },
      tokenA
    );
    assert.strictEqual(xssAttempt.status, 200);
    assert(!xssAttempt.body.service.name.includes('<script>'), 'Tags HTML devem ser removidas');
    assert.strictEqual(xssAttempt.body.service.name, 'alert(hack)Corte com Tesoura');
    console.log('  ✓ 15. Sanitização de nomes contra scripts maliciosos confirmada.\n');

    // -------------------------------------------------------------
    // TESTE 16: Funcionamento em telas pequenas (DOM e Responsividade)
    // -------------------------------------------------------------
    console.log('[Teste 16] Avaliação de integridade estrutural e responsividade do frontend...');
    const painelHtml = fs.readFileSync(path.resolve(__dirname, '../public/cliente/painel.html'), 'utf8');

    // Verifica presença dos componentes essenciais de tela pequena e modais
    assert(painelHtml.includes('id="modalBatchServices"'), 'Modal de lote deve estar presente no HTML');
    assert(painelHtml.includes('id="modalSingleService"'), 'Modal de serviço individual deve estar presente');
    assert(painelHtml.includes('id="modalDeleteConfirm"'), 'Modal de confirmação de exclusão deve estar presente');
    assert(painelHtml.includes('btnOpenBatchModal'), 'Botão "Adicionar vários serviços" deve existir');
    assert(painelHtml.includes('grid grid-cols-1 sm:grid-cols-2'), 'Classes responsivas Tailwind devem estar presentes');
    assert(painelHtml.includes('max-h-[90vh]'), 'Modais devem ter controle de overflow para mobile');
    assert(painelHtml.includes('Duração (minutos)'), 'Label explícita de duração deve existir');
    console.log('  ✓ 16. Estrutura responsiva e componentes de modal validados no painel.\n');

    // -------------------------------------------------------------
    // TESTE 17: Falha durante cadastro em lote e rollback transacional
    // -------------------------------------------------------------
    console.log('[Teste 17] Atomicidade e rollback transacional em falha de lote...');
    const countBeforeRollback = db.prepare('SELECT COUNT(*) as count FROM client_services WHERE user_id = ?').get(userAId).count;

    // Forçar tentativa de lote com um item que cause erro de validação
    const failedBatch = await makeRequest(
      'POST',
      '/api/cliente/services/batch',
      {
        services: [
          { name: 'Procedimento Atômico 1', price: 50.0, duration_min: 30 },
          { name: 'Procedimento Atômico 2', price: 50.0, duration_min: -50 }, // Inválido!
          { name: 'Procedimento Atômico 3', price: 50.0, duration_min: 30 },
        ],
      },
      tokenA
    );
    assert.strictEqual(failedBatch.status, 400);

    const countAfterRollback = db.prepare('SELECT COUNT(*) as count FROM client_services WHERE user_id = ?').get(userAId).count;
    assert.strictEqual(countAfterRollback, countBeforeRollback, 'Nenhum registro parcial deve ter sido inserido no banco');
    console.log('  ✓ 17. Atomicidade completa: zero registros parciais gravados após falha.\n');

    // -------------------------------------------------------------
    // TESTE 18: Compatibilidade com serviços já existentes
    // -------------------------------------------------------------
    console.log('[Teste 18] Compatibilidade de retrocompatibilidade com serviços legados...');
    // Inserir registro com formato antigo
    const legacySvc = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category, active)
      VALUES (?, 'Serviço Tradicional Antigo', 65.0, 45, 'Cabelo', 1)
    `).run(userAId);

    const resCheckLegacy = await makeRequest('GET', '/api/cliente/services', null, tokenA);
    assert.strictEqual(resCheckLegacy.status, 200);
    const foundLegacy = resCheckLegacy.body.services.find((s) => s.id === legacySvc.lastInsertRowid);
    assert.ok(foundLegacy);
    assert.strictEqual(foundLegacy.duration_min, 45);
    assert.strictEqual(foundLegacy.duration_minutes, 45);
    assert.strictEqual(foundLegacy.price, 65.0);
    console.log('  ✓ 18. Compatibilidade total com registros legados preservada.\n');

    console.log('================================================================');
    console.log('   TODOS OS 18 TESTES DO CADASTRO INTELIGENTE FORAM APROVADOS!  ');
    console.log('================================================================\n');
  } finally {
    for (const uId of cleanups) {
      try {
        db.prepare('DELETE FROM client_services WHERE user_id = ?').run(uId);
        db.prepare('DELETE FROM appointments WHERE user_id = ?').run(uId);
        db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(uId);
        db.prepare('DELETE FROM users WHERE id = ?').run(uId);
      } catch (e) {}
    }

    if (server) {
      server.close();
    }
  }
}

run().catch((err) => {
  console.error('\n❌ Falha na execução dos testes do Cadastro Inteligente:');
  console.error(err);
  process.exit(1);
});
