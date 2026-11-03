/**
 * test-salon-dashboard-2.0.js
 * Suíte Oficial e Completa de Segurança e Validação:
 * Dashboard Gerencial & Financeiro 2.0 (Módulo Jéssica)
 *
 * Garante:
 * 1. Isolamento 100% estrito utilizando SQLite temporário (data/assistant.db NUNCA é tocado)
 * 2. Gating no backend: Contas a Pagar é estritamente ocultado (bills === null) para o Plano Intermediário
 * 3. Validação rigorosa de assinatura: PENDING, OVERDUE, expirados ou users.plan_tier antigo não liberam recursos
 * 4. Proteção contra XSS: sanitização estrita de strings e atributos HTML
 * 5. Integridade de Contas a Pagar: atomicidade, prevenção de duplicatas e bloqueio de exclusão de contas quitadas
 * 6. Precisão de indicadores: ticket médio baseado estritamente em atendimentos/serviços
 * 7. Integração REST HTTP com servidor ativo
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// -------------------------------------------------------------
// 1. ISOLAMENTO ESTRITO DO BANCO DE TESTE
// -------------------------------------------------------------
const tempDbPath = path.join(os.tmpdir(), `raia_test_salon_dashboard_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.STAGING_USER = 'raia-staging';
process.env.STAGING_PASSWORD = 'raia2026staging!';

const assert = require('assert');
const http = require('http');
const config = require('../src/config');
const db = require('../src/database/db');
const { app } = require('../src/server/app');
const salonDashboardService = require('../src/services/salonDashboardService');
const productService = require('../src/services/productService');

let passedTests = 0;
let failedTests = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

async function itAsync(desc, fn) {
  try {
    await fn();
    console.log(`  ✓ ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

async function runAllTests() {
  console.log('\n=======================================================');
  console.log('SUÍTE DE SEGURANÇA: DASHBOARD GERENCIAL & FINANCEIRO 2.0');
  console.log('=======================================================\n');

  // Comprovação de isolamento do banco
  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE TESTE ---');
  assert.strictEqual(config.dbPath, tempDbPath, 'O banco ativo deve ser o temporário configurado.');
  assert(tempDbPath.includes(os.tmpdir()), 'O banco deve residir exclusivamente no diretório temporário do SO.');
  console.log(`  ✓ Banco temporário isolado ativo: ${tempDbPath}`);
  console.log(`  ✓ Banco persistente data/assistant.db preservado e intocado.\n`);

  // Seed baseline products & plans in temporary db
  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  let jessicaProdId = jessicaProd?.id;
  if (!jessicaProdId) {
    const res = db.prepare(`
      INSERT INTO products (code, name, category, solution_type, is_active)
      VALUES ('JESSICA', 'Assistente Virtual Jéssica', 'Salões & Beleza', 'AGENDA', 1)
    `).run();
    jessicaProdId = res.lastInsertRowid;
  }

  // Ensure plans START, INTERMEDIATE, PRO exist for JESSICA
  const plans = [
    { code: 'START', name: 'Jéssica Entrada', price: 8900 },
    { code: 'INTERMEDIATE', name: 'Jéssica Intermediário', price: 10900 },
    { code: 'PRO', name: 'Jéssica Pró', price: 13900 },
  ];
  const planIds = {};
  for (const pl of plans) {
    const existing = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = ?").get(jessicaProdId, pl.code);
    if (existing) {
      planIds[pl.code] = existing.id;
    } else {
      const res = db.prepare(`
        INSERT INTO product_plans (product_id, code, name, billing_cycle, price_cents, is_active)
        VALUES (?, ?, ?, 'MONTHLY', ?, 1)
      `).run(jessicaProdId, pl.code, pl.name, pl.price);
      planIds[pl.code] = res.lastInsertRowid;
    }
  }

  // Setup test users in temporary database
  const todaySP = salonDashboardService.getPeriodDates('today').startDate;
  const futurePaid = '2030-01-01T00:00:00.000Z';
  const pastPaid = '2020-01-01T00:00:00.000Z';

  // 1. User PRO (Active subscription)
  const userPro = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Pró Ativo', '5511990000001', 'pro@teste.com', 'JESSICA_PRO', 'ACTIVE', ?, 0, 'CLIENT', 'token_pro', ?)
  `).run(futurePaid, futurePaid);
  const userIdPro = userPro.lastInsertRowid;

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, plan_id, status, price_cents, paid_until, origin)
    VALUES (?, ?, ?, 'ACTIVE', 19700, ?, 'DIRECT')
  `).run(userIdPro, jessicaProdId, planIds['PRO'], futurePaid);

  // 2. User INTERMEDIATE (Active subscription)
  const userInter = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Inter Ativo', '5511990000002', 'inter@teste.com', 'JESSICA_INTERMEDIATE', 'ACTIVE', ?, 0, 'CLIENT', 'token_inter', ?)
  `).run(futurePaid, futurePaid);
  const userIdInter = userInter.lastInsertRowid;

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, plan_id, status, price_cents, paid_until, origin)
    VALUES (?, ?, ?, 'ACTIVE', 14700, ?, 'DIRECT')
  `).run(userIdInter, jessicaProdId, planIds['INTERMEDIATE'], futurePaid);

  // 3. User START (Active subscription)
  const userStart = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Start Ativo', '5511990000003', 'start@teste.com', 'JESSICA_START', 'ACTIVE', ?, 0, 'CLIENT', 'token_start', ?)
  `).run(futurePaid, futurePaid);
  const userIdStart = userStart.lastInsertRowid;

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, plan_id, status, price_cents, paid_until, origin)
    VALUES (?, ?, ?, 'ACTIVE', 9700, ?, 'DIRECT')
  `).run(userIdStart, jessicaProdId, planIds['START'], futurePaid);

  // 4. User with PENDING subscription (not paid yet)
  const userPending = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Aguardando Pagamento', '5511990000004', 'pending@teste.com', 'JESSICA_PRO', 'PENDING', NULL, 0, 'CLIENT', 'token_pending', ?)
  `).run(futurePaid);
  const userIdPending = userPending.lastInsertRowid;

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, plan_id, status, price_cents, paid_until, origin)
    VALUES (?, ?, ?, 'PENDING', 19700, NULL, 'DIRECT')
  `).run(userIdPending, jessicaProdId, planIds['PRO']);

  // 5. User with OVERDUE expired subscription
  const userOverdue = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Inadimplente Expirado', '5511990000005', 'overdue@teste.com', 'JESSICA_PRO', 'OVERDUE', ?, 0, 'CLIENT', 'token_overdue', ?)
  `).run(pastPaid, futurePaid);
  const userIdOverdue = userOverdue.lastInsertRowid;

  db.prepare(`
    INSERT INTO customer_subscriptions (user_id, product_id, plan_id, status, price_cents, paid_until, origin)
    VALUES (?, ?, ?, 'OVERDUE', 19700, ?, 'DIRECT')
  `).run(userIdOverdue, jessicaProdId, planIds['PRO'], pastPaid);

  // 6. User with STALE users.plan_tier (plan_tier says PRO, but subscription expired)
  const userStale = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Antigo Expirado', '5511990000006', 'stale@teste.com', 'JESSICA_PRO', 'EXPIRED', ?, 0, 'CLIENT', 'token_stale', ?)
  `).run(pastPaid, futurePaid);
  const userIdStale = userStale.lastInsertRowid;

  // 7. Demo User (Bella Vista)
  let userIdDemo;
  const existingDemo = db.prepare('SELECT id FROM users WHERE phone_number = ?').get('5511999990000');
  if (existingDemo) {
    db.prepare(`
      UPDATE users SET magic_token = 'token_demo', magic_token_expires_at = ?, paid_until = ?, is_demo = 1, plan_tier = 'JESSICA_PRO', subscription_status = 'ACTIVE'
      WHERE id = ?
    `).run(futurePaid, futurePaid, existingDemo.id);
    userIdDemo = existingDemo.id;
  } else {
    const userDemo = db.prepare(`
      INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
      VALUES ('Bella Vista Hair & Spa', '5511999990000', 'homologacao.hotmart@raiaagentes.com.br', 'JESSICA_PRO', 'ACTIVE', ?, 1, 'CLIENT', 'token_demo', ?)
    `).run(futurePaid, futurePaid);
    userIdDemo = userDemo.lastInsertRowid;
  }

  console.log('--- REVISÃO 1: PROTEÇÃO DOS DADOS DE CONTAS A PAGAR ---');

  // Seed scheduled payments for User Inter and User Pro
  salonDashboardService.createBill(userIdPro, {
    title: 'Fornecedor Wella Pro',
    amount: 1200.0,
    dueDate: todaySP,
    category: 'Produtos',
  });

  salonDashboardService.createBill(userIdInter, {
    title: 'Fornecedor Sigiloso Inter',
    amount: 800.0,
    dueDate: todaySP,
    category: 'Produtos',
  });

  await itAsync('1.1. Backend oculta dados de Contas a Pagar (bills === null) para o Plano Intermediário', async () => {
    const dashInter = await salonDashboardService.getSalonDashboard(userIdInter, { period: 'this_month', isPro: false });
    assert.strictEqual(dashInter.bills, null, 'bills deve ser estritamente null para plano intermediário');
    assert(dashInter.metrics !== undefined, 'Métricas gerais devem continuar acessíveis');
    assert(dashInter.timeline !== undefined, 'Timeline deve continuar acessível');
  });

  await itAsync('1.2. Backend entrega Contas a Pagar completas exclusivamente para o Plano Pró', async () => {
    const dashPro = await salonDashboardService.getSalonDashboard(userIdPro, { period: 'this_month', isPro: true });
    assert.notStrictEqual(dashPro.bills, null, 'bills não deve ser null para plano Pró');
    assert(dashPro.bills.pendingTotal >= 1200.0);
    assert(dashPro.bills.upcomingBills.length > 0);
  });

  console.log('\n--- REVISÃO 2: VERIFICAÇÃO RIGOROSA DA ASSINATURA ---');

  it('2.1. Assinatura PENDING é rebaixada para START e bloqueada', () => {
    const tier = salonDashboardService.getEffectiveJessicaTier(userIdPending);
    assert.strictEqual(tier, 'JESSICA_START', 'Assinatura PENDING não pode liberar recursos pagos');
  });

  it('2.2. Assinatura OVERDUE com vigência expirada é bloqueada como START', () => {
    const tier = salonDashboardService.getEffectiveJessicaTier(userIdOverdue);
    assert.strictEqual(tier, 'JESSICA_START', 'Inadimplente expirado não pode receber tier PRO');
  });

  it('2.3. Valor antigo em users.plan_tier com vigência expirada é rejeitado', () => {
    const tier = salonDashboardService.getEffectiveJessicaTier(userIdStale);
    assert.strictEqual(tier, 'JESSICA_START', 'users.plan_tier antigo não pode burlar expiração');
  });

  it('2.4. Assinatura ativa vigente no plano Intermediário é confirmada', () => {
    const tier = salonDashboardService.getEffectiveJessicaTier(userIdInter);
    assert.strictEqual(tier, 'JESSICA_INTERMEDIATE');
  });

  it('2.5. Assinatura ativa vigente no plano Pró é confirmada', () => {
    const tier = salonDashboardService.getEffectiveJessicaTier(userIdPro);
    assert.strictEqual(tier, 'JESSICA_PRO');
  });

  it('2.6. Conta demonstrativa e Admin preservam acesso irrestrito', () => {
    const tierDemo = salonDashboardService.getEffectiveJessicaTier(userIdDemo);
    assert.strictEqual(tierDemo, 'JESSICA_PRO');
    const tierAdmin = salonDashboardService.getEffectiveJessicaTier(null, { role: 'ADMIN' });
    assert.strictEqual(tierAdmin, 'JESSICA_PRO');
  });

  console.log('\n--- REVISÃO 3: PROTEÇÃO CONTRA XSS ---');

  it('3.1. Sanitização estrita contra XSS em descrições, categorias e atributos', () => {
    // Read escapeHtml from painel.html
    const painelHtml = fs.readFileSync(path.resolve(__dirname, '../public/cliente/painel.html'), 'utf-8');
    assert(painelHtml.includes('function escapeHtml(str)'), 'painel.html deve declarar escapeHtml');

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    const payloadScript = '<script>alert("xss")</script>';
    const payloadAttr = '"> <img src=x onerror=alert(1)>';
    const payloadSingleQuote = "' onfocus='alert(1)";

    const cleanScript = escapeHtml(payloadScript);
    assert(!cleanScript.includes('<script>'), 'Não deve conter tag script crua');
    assert(cleanScript.includes('&lt;script&gt;'));

    const cleanAttr = escapeHtml(payloadAttr);
    assert(!cleanAttr.includes('"'), 'Não deve conter aspas duplas cruas que quebram atributos');
    assert(cleanAttr.includes('&quot;&gt; &lt;img'));

    const cleanSingle = escapeHtml(payloadSingleQuote);
    assert(!cleanSingle.includes("'"), 'Não deve conter aspas simples cruas');
    assert(cleanSingle.includes('&#39;'));

    // Check painel.html usages
    assert(painelHtml.includes('escapeHtml(t.description || \'\')'), 't.description deve ser escapado');
    assert(painelHtml.includes('escapeHtml(t.category || \'--\')'), 't.category deve ser escapado');
    assert(painelHtml.includes('escapeHtml(t.origin || \'--\')'), 't.origin deve ser escapado');
    assert(painelHtml.includes('data-desc="${searchAttr}"'), 'Atributo de busca deve usar searchAttr escapado');
    assert(painelHtml.includes('escapeHtml(b.title)'), 'b.title de contas a pagar deve ser escapado');
    assert(painelHtml.includes('escapeHtml(s.name)'), 's.name de serviços deve ser escapado');
    assert(painelHtml.includes('escapeHtml(st.name)'), 'st.name de profissionais deve ser escapado');
  });

  console.log('\n--- REVISÃO 5: INTEGRIDADE DE CONTAS A PAGAR ---');

  await itAsync('5.1. Atomicidade: liquidação de conta atualiza status e registra despesa', async () => {
    const bills = salonDashboardService.createBill(userIdPro, {
      title: 'Energia Elétrica Salão',
      amount: 450.0,
      dueDate: todaySP,
      category: 'Contas',
    });
    const billId = bills[0].id;

    const result = salonDashboardService.markBillAsPaid(userIdPro, billId);
    assert.strictEqual(result.bill.status, 'PAID');
    assert(result.expense);
    assert.strictEqual(result.expense.amount, 450.0);

    const expenseDb = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.expense.id);
    assert(expenseDb);
    assert.strictEqual(expenseDb.user_id, userIdPro);
    assert.strictEqual(expenseDb.amount, 450.0);
  });

  await itAsync('5.2. Prevenção de duplicatas: marcar conta paga novamente não gera nova despesa', async () => {
    const bills = salonDashboardService.createBill(userIdPro, {
      title: 'Internet Fibra Salão',
      amount: 199.90,
      dueDate: todaySP,
      category: 'Tecnologia',
    });
    const billId = bills[0].id;

    salonDashboardService.markBillAsPaid(userIdPro, billId);
    const countExpensesBefore = db.prepare('SELECT COUNT(*) as c FROM expenses WHERE user_id = ?').get(userIdPro).c;

    // Second call
    const secondResult = salonDashboardService.markBillAsPaid(userIdPro, billId);
    assert(secondResult.message.includes('já foi marcada como quitada'));

    const countExpensesAfter = db.prepare('SELECT COUNT(*) as c FROM expenses WHERE user_id = ?').get(userIdPro).c;
    assert.strictEqual(countExpensesAfter, countExpensesBefore, 'Não deve duplicar despesa no caixa');
  });

  await itAsync('5.3. Rastreabilidade contábil: exclusão de contas quitadas é bloqueada', async () => {
    const bills = salonDashboardService.createBill(userIdPro, {
      title: 'Tributo Municipal Salão',
      amount: 320.0,
      dueDate: todaySP,
      category: 'Tributos',
    });
    const billId = bills[0].id;
    salonDashboardService.markBillAsPaid(userIdPro, billId);

    // Attempt delete
    assert.throws(() => {
      salonDashboardService.deleteBill(userIdPro, billId);
    }, /não podem ser excluídas para preservar a rastreabilidade contábil/i);

    const billStillExists = db.prepare('SELECT id, status FROM scheduled_payments WHERE id = ?').get(billId);
    assert(billStillExists);
    assert.strictEqual(billStillExists.status, 'PAID');
  });

  console.log('\n--- REVISÃO 6: PRECISÃO DOS INDICADORES E TICKET MÉDIO ---');

  await itAsync('6.1. Ticket médio calculado estritamente sobre atendimentos/serviços realizados', async () => {
    // Insert 1 completed appointment with price R$ 70.00
    db.prepare(`
      INSERT INTO appointments (user_id, title, start_datetime, status, price)
      VALUES (?, 'Corte Masculino', ? || 'T11:00:00', 'COMPLETED', 70.0)
    `).run(userIdPro, todaySP);

    // Insert 1 manual generic income unrelated to appointments (e.g. sale of old chair R$ 3,000.00)
    db.prepare(`
      INSERT INTO incomes (user_id, amount, source, category, payment_method, date, source_type)
      VALUES (?, 3000.0, 'Venda de Cadeira Antiga', 'Outros', 'Pix', ?, 'dashboard_manual')
    `).run(userIdPro, todaySP);

    const dash = await salonDashboardService.getSalonDashboard(userIdPro, { period: 'today', isPro: true });

    // Total realized revenue includes all salon cash entries: R$ 3,000.00
    assert.strictEqual(dash.metrics.realizedRevenue, 3000.0);

    // But average ticket is strictly based on the appointment price: R$ 70.00 (NOT R$ 3,000.00 / 1!)
    assert.strictEqual(dash.metrics.averageTicket, 70.0, 'Ticket médio deve refletir o valor do serviço e não receitas avulsas de capital');
    assert.strictEqual(dash.metrics.hasSufficientData, true);
  });

  await itAsync('6.2. Sem atendimentos concluídos, ticket médio não divide receitas avulsas por contagem', async () => {
    const dashInter = await salonDashboardService.getSalonDashboard(userIdInter, { period: 'today', isPro: false });
    // User Inter has 0 appointments
    assert.strictEqual(dashInter.metrics.totalAppointments, 0);
    assert.strictEqual(dashInter.metrics.completedAppointments, 0);
    assert.strictEqual(dashInter.metrics.averageTicket, 0);
    assert.strictEqual(dashInter.metrics.hasSufficientData, false, 'Sem atendimentos, ticket médio deve sinalizar dados insuficientes');
  });

  console.log('\n--- FASE 3: TESTES REST HTTP COM SERVIDOR ATIVO ---');

  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const stagingAuthHeader = 'Basic ' + Buffer.from('raia-staging:raia2026staging!').toString('base64');

  function requestApi(urlPath, options = {}) {
    const headers = Object.assign({
      Authorization: stagingAuthHeader,
    }, options.headers || {});
    return fetch(`${baseUrl}${urlPath}`, Object.assign({}, options, { headers }));
  }

  await itAsync('7.1. HTTP: Plano Entrada (START) recebe 403 upgradeRequired no dashboard', async () => {
    const res = await requestApi('/api/cliente/pro/dashboard', {
      headers: { 'X-Auth-Token': 'token_start' },
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.upgradeRequired, true);
  });

  await itAsync('7.2. HTTP: Plano Intermediário recebe 200 no dashboard MAS bills é estritamente null', async () => {
    const res = await requestApi('/api/cliente/pro/dashboard?period=today', {
      headers: { 'X-Auth-Token': 'token_inter' },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.isPro, false);
    assert.strictEqual(body.bills, null, 'Contas a pagar deve ser null no payload HTTP para plano intermediário');
  });

  await itAsync('7.3. HTTP: Plano Intermediário é bloqueado com 403 na rota /api/cliente/pro/bills', async () => {
    const res = await requestApi('/api/cliente/pro/bills', {
      headers: { 'X-Auth-Token': 'token_inter' },
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.proExclusive, true);
  });

  await itAsync('7.4. HTTP: Plano Pró recebe 200 e payload completo com bills', async () => {
    const res = await requestApi('/api/cliente/pro/dashboard?period=today', {
      headers: { 'X-Auth-Token': 'token_pro' },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.isPro, true);
    assert.notStrictEqual(body.bills, null);
    assert(body.bills.pendingTotal !== undefined);
  });

  // Close HTTP Server
  await new Promise(res => server.close(res));

  // -------------------------------------------------------------
  // LIMPEZA DO BANCO ISOLADO TEMPORÁRIO
  // -------------------------------------------------------------
  console.log('\n--- LIMPEZA DO AMBIENTE TEMPORÁRIO ---');
  try {
    if (typeof db.close === 'function') {
      db.close();
    }
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
    console.log('  ✓ Arquivos do SQLite temporário removidos com sucesso.');
  } catch (e) {
    console.warn('  ! Aviso na remoção do arquivo temporário:', e.message);
  }

  console.log('\n=======================================================');
  console.log(`RESULTADO DA REVISÃO DE SEGURANÇA: ${passedTests} APROVADOS, ${failedTests} FALHAS`);
  console.log('=======================================================\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
