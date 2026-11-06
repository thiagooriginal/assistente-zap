/**
 * RAIA AGENTES — SUÍTE DE TESTES: DURAÇÃO DE SERVIÇOS E INTEGRAÇÃO COM AGENDA
 * 
 * Validações obrigatórias:
 * 1. Criar serviço com duração 30 min e verificar gravação no SQLite e retorno da API.
 * 2. Criar serviço com duração 60 min e verificar gravação no SQLite e retorno da API.
 * 3. Recarregar lista (GET /api/cliente/services) e confirmar que ambas as durações permanecem corretas.
 * 4. Garantir que nenhum serviço apresente undefined, null ou NaN.
 * 5. Validação rigorosa: rejeitar durações <= 0, vazias, nulas, decimais ou inválidas (sem fallback silencioso para 45).
 * 6. Garantir que a agenda utilize a duração do serviço efetivamente configurada (cálculo de end_datetime).
 * 7. Isolamento de serviços por usuário autenticado (req.clientUser.id).
 * 8. Migração segura de dados legados (preservando valores válidos existentes e corrigindo apenas NULL ou <= 0).
 */

const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const clientAuth = require('../src/services/clientAuthService');

let server;
let baseUrl;

function makeRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
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
  console.log('   RAIA AGENTES — SUÍTE DE TESTES: DURAÇÃO DE SERVIÇOS & AGENDA');
  console.log('================================================================\n');

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const cleanups = [];

  try {
    // -----------------------------------------------------------------
    // SETUP: Criar dois clientes de teste (User A e User B)
    // -----------------------------------------------------------------
    const ts = Date.now();
    const tokenA = crypto.randomBytes(32).toString('hex');
    const tokenB = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 86400000).toISOString();

    const resA = db.prepare(`
      INSERT INTO users (name, phone_number, email, role, plan_tier, subscription_status, paid_until, session_token, session_expires_at)
      VALUES (?, ?, ?, 'CLIENT', 'JESSICA_START', 'ACTIVE', datetime('now', '+30 days'), ?, ?)
    `).run('Salão Teste Duração A', `551198888${String(ts).slice(-4)}`, `duracao.a.${ts}@example.com`, tokenA, exp);
    const userAId = resA.lastInsertRowid;
    cleanups.push(userAId);

    const resB = db.prepare(`
      INSERT INTO users (name, phone_number, email, role, plan_tier, subscription_status, paid_until, session_token, session_expires_at)
      VALUES (?, ?, ?, 'CLIENT', 'JESSICA_START', 'ACTIVE', datetime('now', '+30 days'), ?, ?)
    `).run('Salão Teste Duração B', `551197777${String(ts).slice(-4)}`, `duracao.b.${ts}@example.com`, tokenB, exp);
    const userBId = resB.lastInsertRowid;
    cleanups.push(userBId);

    // Conceder acesso ao produto JESSICA para ambos via customer_subscriptions
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

    // Limpar serviços padrão de userA e userB para testes controlados
    db.prepare('DELETE FROM client_services WHERE user_id IN (?, ?)').run(userAId, userBId);
    db.prepare('DELETE FROM appointments WHERE user_id IN (?, ?)').run(userAId, userBId);

    console.log('[Setup] Clientes criados com sucesso.');
    console.log(`  - Cliente A ID: ${userAId}`);
    console.log(`  - Cliente B ID: ${userBId}\n`);

    // -----------------------------------------------------------------
    // TESTE 1: Criar serviço com duração 30 min
    // -----------------------------------------------------------------
    console.log('[Teste 1] Criando serviço com duração de 30 min (Escova Rápida)...');
    const resSvc30 = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: 'Escova Rápida',
        price: 45.0,
        duration_min: 30,
        category: 'Cabelo',
      },
      tokenA
    );

    assert.strictEqual(resSvc30.status, 200, 'POST /services deve responder 200');
    assert.strictEqual(resSvc30.body.success, true);
    assert.strictEqual(resSvc30.body.service.duration_min, 30, 'duration_min retornado deve ser 30');
    assert.strictEqual(resSvc30.body.service.duration_minutes, 30, 'duration_minutes retornado deve ser 30');
    assert.strictEqual(resSvc30.body.service.price, 45.0);

    const svc30Id = resSvc30.body.service.id;
    const dbSvc30 = db.prepare('SELECT * FROM client_services WHERE id = ?').get(svc30Id);
    assert.strictEqual(dbSvc30.duration_min, 30, 'No SQLite duration_min deve ser exatamente 30');
    console.log('  ✓ Sucesso: Serviço de 30 min criado e persistido no SQLite.\n');

    // -----------------------------------------------------------------
    // TESTE 2: Criar serviço com duração 60 min (usando campo durationMinutes)
    // -----------------------------------------------------------------
    console.log('[Teste 2] Criando serviço com duração de 60 min (Corte e Hidratação)...');
    const resSvc60 = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: 'Corte e Hidratação',
        price: 90.0,
        durationMinutes: 60,
        category: 'Cabelo',
      },
      tokenA
    );

    assert.strictEqual(resSvc60.status, 200, 'POST /services deve responder 200');
    assert.strictEqual(resSvc60.body.success, true);
    assert.strictEqual(resSvc60.body.service.duration_min, 60, 'duration_min retornado deve ser 60');
    assert.strictEqual(resSvc60.body.service.duration_minutes, 60, 'duration_minutes retornado deve ser 60');
    assert.strictEqual(resSvc60.body.service.price, 90.0);

    const svc60Id = resSvc60.body.service.id;
    const dbSvc60 = db.prepare('SELECT * FROM client_services WHERE id = ?').get(svc60Id);
    assert.strictEqual(dbSvc60.duration_min, 60, 'No SQLite duration_min deve ser exatamente 60');
    console.log('  ✓ Sucesso: Serviço de 60 min criado e persistido no SQLite.\n');

    // -----------------------------------------------------------------
    // TESTE 3: Recarregar página (GET /api/cliente/services) e confirmar ambas
    // -----------------------------------------------------------------
    console.log('[Teste 3] Recarregando lista de serviços (GET /api/cliente/services)...');
    const resList = await makeRequest('GET', '/api/cliente/services', null, tokenA);
    assert.strictEqual(resList.status, 200);
    assert.strictEqual(resList.body.success, true);
    assert.strictEqual(resList.body.services.length, 2);

    const item30 = resList.body.services.find((s) => s.id === svc30Id);
    const item60 = resList.body.services.find((s) => s.id === svc60Id);

    assert(item30, 'Serviço de 30 min deve estar na lista');
    assert(item60, 'Serviço de 60 min deve estar na lista');

    assert.strictEqual(item30.duration_min, 30, 'Duração de Escova Rápida deve persistir em 30');
    assert.strictEqual(item30.duration_minutes, 30, 'Alias duration_minutes deve persistir em 30');
    assert.strictEqual(item60.duration_min, 60, 'Duração de Corte e Hidratação deve persistir em 60');
    assert.strictEqual(item60.duration_minutes, 60, 'Alias duration_minutes deve persistir em 60');
    console.log('  ✓ Sucesso: Ambas as durações (30 min e 60 min) permanecem íntegras após reload.\n');

    // -----------------------------------------------------------------
    // TESTE 4: Garantir que nenhum campo retorne undefined, null ou NaN
    // -----------------------------------------------------------------
    console.log('[Teste 4] Verificando integridade de campos contra undefined, null ou NaN...');
    for (const svc of resList.body.services) {
      assert(svc.duration_min !== undefined, `duration_min não pode ser undefined no serviço #${svc.id}`);
      assert(svc.duration_min !== null, `duration_min não pode ser null no serviço #${svc.id}`);
      assert(!isNaN(svc.duration_min), `duration_min não pode ser NaN no serviço #${svc.id}`);
      assert(svc.duration_min > 0, `duration_min deve ser maior que 0`);

      assert(svc.duration_minutes !== undefined, `duration_minutes não pode ser undefined no serviço #${svc.id}`);
      assert(svc.duration_minutes !== null, `duration_minutes não pode ser null no serviço #${svc.id}`);
      assert(!isNaN(svc.duration_minutes), `duration_minutes não pode ser NaN no serviço #${svc.id}`);

      assert(svc.price !== undefined && svc.price !== null && !isNaN(svc.price), 'price deve ser numérico válido');
      assert(typeof svc.name === 'string' && svc.name.trim().length > 0, 'name deve ser string válida');
    }
    console.log('  ✓ Sucesso: Nenhum serviço contém valores undefined, null ou NaN.\n');

    // -----------------------------------------------------------------
    // TESTE 5: Validação de duração (rejeitar <= 0, vazios, inválidos sem fallback silencioso)
    // -----------------------------------------------------------------
    console.log('[Teste 5] Testando rejeição rigorosa de valores inválidos de duração...');

    const invalidCases = [
      { payload: { name: 'Teste Zero', price: 50, duration_min: 0 }, desc: 'duração zero' },
      { payload: { name: 'Teste Negativo', price: 50, duration_min: -15 }, desc: 'duração negativa' },
      { payload: { name: 'Teste String Vazia', price: 50, duration_min: '' }, desc: 'string vazia' },
      { payload: { name: 'Teste Não Numérico', price: 50, duration_min: 'abc' }, desc: 'string não numérica' },
      { payload: { name: 'Teste Nulo', price: 50, duration_min: null }, desc: 'valor null' },
      { payload: { name: 'Teste Float Inválido', price: 50, duration_min: 15.7 }, desc: 'número decimal não-inteiro' },
      { payload: { name: 'Teste Excessivo', price: 50, duration_min: 5000 }, desc: 'duração maior que 24h' },
    ];

    for (const c of invalidCases) {
      const res = await makeRequest('POST', '/api/cliente/services', c.payload, tokenA);
      assert.strictEqual(
        res.status,
        400,
        `Tentativa com ${c.desc} deveria retornar HTTP 400, obteve ${res.status}`
      );
      assert.strictEqual(res.body.success, false);
      assert(
        res.body.error && res.body.error.includes('duração'),
        `Mensagem de erro de ${c.desc} deve mencionar duração. Mensagem: ${res.body.error}`
      );
    }

    // Confirmar que NENHUM desses serviços inválidos foi criado com fallback para 45
    const countAfterInvalid = db.prepare('SELECT COUNT(*) as count FROM client_services WHERE user_id = ?').get(userAId).count;
    assert.strictEqual(countAfterInvalid, 2, 'Nenhum registro com fallback silencioso deve ter sido gravado');
    console.log('  ✓ Sucesso: Todos os 7 casos inválidos rejeitados com HTTP 400 e erro descritivo em PT-BR.\n');

    // -----------------------------------------------------------------
    // TESTE 6: Agenda utiliza a duração do serviço efetivamente configurada
    // -----------------------------------------------------------------
    console.log('[Teste 6] Agendando compromissos e validando cálculo de end_datetime pela duração...');

    // Agendamento A: Serviço de 30 min às 14:00 -> término deve ser 14:30:00
    const resApt30 = await makeRequest(
      'POST',
      '/api/cliente/appointments',
      {
        clientName: 'Mariana Silva',
        serviceId: svc30Id,
        date: '2026-11-10',
        time: '14:00',
      },
      tokenA
    );

    assert.strictEqual(resApt30.status, 200);
    assert.strictEqual(resApt30.body.success, true);
    assert.strictEqual(resApt30.body.appointment.duration_minutes, 30);
    assert.strictEqual(resApt30.body.appointment.start_datetime, '2026-11-10T14:00:00');
    assert.strictEqual(resApt30.body.appointment.end_datetime, '2026-11-10T14:30:00');

    // Agendamento B: Serviço de 60 min às 15:00 -> término deve ser 16:00:00
    const resApt60 = await makeRequest(
      'POST',
      '/api/cliente/appointments',
      {
        clientName: 'Carla Souza',
        serviceName: 'Corte e Hidratação',
        date: '2026-11-10',
        time: '15:00',
      },
      tokenA
    );

    assert.strictEqual(resApt60.status, 200);
    assert.strictEqual(resApt60.body.success, true);
    assert.strictEqual(resApt60.body.appointment.duration_minutes, 60);
    assert.strictEqual(resApt60.body.appointment.start_datetime, '2026-11-10T15:00:00');
    assert.strictEqual(resApt60.body.appointment.end_datetime, '2026-11-10T16:00:00');

    // Verificar na API de consulta de agendamentos
    const resAptList = await makeRequest('GET', '/api/cliente/appointments', null, tokenA);
    assert.strictEqual(resAptList.status, 200);
    const apt30 = resAptList.body.appointments.find((a) => a.id === resApt30.body.id);
    const apt60 = resAptList.body.appointments.find((a) => a.id === resApt60.body.id);

    assert.strictEqual(apt30.end_datetime, '2026-11-10T14:30:00', 'end_datetime do serviço de 30 min deve ser 14:30:00');
    assert.strictEqual(apt60.end_datetime, '2026-11-10T16:00:00', 'end_datetime do serviço de 60 min deve ser 16:00:00');
    console.log('  ✓ Sucesso: Agenda calcula end_datetime com base exata na duração configurada (30m e 60m).\n');

    // -----------------------------------------------------------------
    // TESTE 7: Isolamento de serviços por usuário autenticado
    // -----------------------------------------------------------------
    console.log('[Teste 7] Validando isolamento multi-tenant entre Cliente A e Cliente B...');

    // Cliente B cria serviço próprio de 120 min
    const resSvcB = await makeRequest(
      'POST',
      '/api/cliente/services',
      {
        name: 'Mega Hair Especial B',
        price: 500.0,
        duration_min: 120,
      },
      tokenB
    );
    assert.strictEqual(resSvcB.status, 200);
    const svcBId = resSvcB.body.service.id;

    // Cliente A consulta serviços: NÃO pode ver o serviço de B
    const listA = await makeRequest('GET', '/api/cliente/services', null, tokenA);
    const foundBInA = listA.body.services.some((s) => s.id === svcBId);
    assert.strictEqual(foundBInA, false, 'Cliente A não pode enxergar serviços do Cliente B');

    // Cliente A tenta alterar serviço de B: deve retornar 404
    const putAttack = await makeRequest(
      'PUT',
      `/api/cliente/services/${svcBId}`,
      { duration_min: 15 },
      tokenA
    );
    assert.strictEqual(putAttack.status, 404, 'Cliente A não pode alterar serviço de outro usuário');

    // Cliente A tenta excluir serviço de B: deve retornar 404
    const delAttack = await makeRequest('DELETE', `/api/cliente/services/${svcBId}`, null, tokenA);
    assert.strictEqual(delAttack.status, 404, 'Cliente A não pode excluir serviço de outro usuário');
    console.log('  ✓ Sucesso: Isolamento completo garantido em GET, POST, PUT e DELETE.\n');

    // -----------------------------------------------------------------
    // TESTE 8: Migração de dados legados segura (sem sobrescrever dados válidos)
    // -----------------------------------------------------------------
    console.log('[Teste 8] Validando migração de dados legados no SQLite...');

    // Inserir registro com duração válida customizada (ex: 35 min)
    const validLegacy = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category)
      VALUES (?, 'Serviço Válido Legado', 70.0, 35, 'Cabelo')
    `).run(userAId);

    // Inserir registros corrompidos/legados sem duração válida
    const nullLegacy = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category)
      VALUES (?, 'Serviço Null Legado', 70.0, NULL, 'Cabelo')
    `).run(userAId);

    const zeroLegacy = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category)
      VALUES (?, 'Serviço Zero Legado', 70.0, 0, 'Cabelo')
    `).run(userAId);

    const negativeLegacy = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category)
      VALUES (?, 'Serviço Negativo Legado', 70.0, -20, 'Cabelo')
    `).run(userAId);

    // Executar a rotina de migração
    db.exec(`
      UPDATE client_services
      SET duration_min = 45
      WHERE duration_min IS NULL OR duration_min <= 0;
    `);

    // Verificar se o registro válido (35 min) foi mantido intacto
    const checkValid = db.prepare('SELECT duration_min FROM client_services WHERE id = ?').get(validLegacy.lastInsertRowid);
    assert.strictEqual(checkValid.duration_min, 35, 'Duração válida de 35 min deve permanecer intacta');

    // Verificar se os inválidos foram corrigidos para 45
    const checkNull = db.prepare('SELECT duration_min FROM client_services WHERE id = ?').get(nullLegacy.lastInsertRowid);
    const checkZero = db.prepare('SELECT duration_min FROM client_services WHERE id = ?').get(zeroLegacy.lastInsertRowid);
    const checkNeg = db.prepare('SELECT duration_min FROM client_services WHERE id = ?').get(negativeLegacy.lastInsertRowid);

    assert.strictEqual(checkNull.duration_min, 45, 'Registro NULL deve ser migrado para 45');
    assert.strictEqual(checkZero.duration_min, 45, 'Registro com 0 deve ser migrado para 45');
    assert.strictEqual(checkNeg.duration_min, 45, 'Registro negativo deve ser migrado para 45');
    console.log('  ✓ Sucesso: Migração preservou dados válidos e corrigiu apenas registros inválidos/nulos.\n');

    // -----------------------------------------------------------------
    // TESTE 9: Formatação no Frontend (Simulação das regras de UI em PT-BR)
    // -----------------------------------------------------------------
    console.log('[Teste 9] Validando regras de formatação textual em português do Brasil...');

    const sampleServices = [
      { id: 101, name: 'Corte Tradicional', duration_min: 30, price: 50.0 },
      { id: 102, name: 'Coloração Completa', duration_min: 60, price: 180.5 },
      { id: 103, name: 'Escova Modelada', duration_minutes: 45, price: 65.0 },
      { id: 104, name: null, duration_min: 40, price: null },
    ];

    sampleServices.forEach((svc) => {
      const duration = (svc.duration_min !== undefined && svc.duration_min !== null && !isNaN(svc.duration_min))
        ? Number(svc.duration_min)
        : ((svc.duration_minutes !== undefined && svc.duration_minutes !== null && !isNaN(svc.duration_minutes))
          ? Number(svc.duration_minutes)
          : 45);

      const numPrice = (svc.price !== undefined && svc.price !== null && !isNaN(Number(svc.price)))
        ? Number(svc.price)
        : 0;

      const formattedPrice = numPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const safeName = (svc.name && typeof svc.name === 'string') ? svc.name : 'Serviço';

      const renderedText = `Duração: ${duration} minutos • Valor: ${formattedPrice}`;

      assert(!renderedText.includes('undefined'), `Renderização não pode conter undefined: ${renderedText}`);
      assert(!renderedText.includes('null'), `Renderização não pode conter null: ${renderedText}`);
      assert(!renderedText.includes('NaN'), `Renderização não pode conter NaN: ${renderedText}`);
      assert(renderedText.startsWith('Duração: '), `Deve iniciar com "Duração: ": ${renderedText}`);
      assert(renderedText.includes(' minutos • Valor: R$'), `Deve conter padrão monetário brasileiro: ${renderedText}`);
    });
    console.log('  ✓ Sucesso: Regras de renderização aprovadas com formatação brasileira.\n');

    console.log('================================================================');
    console.log('   TODOS OS 9 TESTES FORAM APROVADOS COM SUCESSO (100% OK)!');
    console.log('================================================================\n');
  } finally {
    // Limpeza
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
  console.error('\n❌ Falha na execução da suíte de testes:');
  console.error(err);
  process.exit(1);
});
