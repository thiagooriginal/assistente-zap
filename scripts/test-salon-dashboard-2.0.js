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
const salonDashboardService = require('../src/services/salonDashboardService');

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
  console.log('SUÍTE OFICIAL: DASHBOARD GERENCIAL & FINANCEIRO 2.0');
  console.log('=======================================================\n');

  // Setup mock test users
  const testEmailA = 'test.salon.user.a@raiaagentes.com.br';
  const testEmailB = 'test.salon.user.b@raiaagentes.com.br';
  const testEmailStart = 'test.salon.start@raiaagentes.com.br';
  const testEmailInter = 'test.salon.inter@raiaagentes.com.br';

  db.prepare('DELETE FROM users WHERE email IN (?, ?, ?, ?)').run(testEmailA, testEmailB, testEmailStart, testEmailInter);

  const tokenA = 'magic_token_pro_a';
  const tokenB = 'magic_token_pro_b';
  const tokenStart = 'magic_token_start';
  const tokenInter = 'magic_token_inter';

  const userA = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Cliente A (Pró)', '5511990000001', ?, 'JESSICA_PRO', 'ACTIVE', '2030-01-01', 0, 'CLIENT', ?, '2030-01-01')
  `).run(testEmailA, tokenA);
  const userIdA = userA.lastInsertRowid;

  const userB = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Cliente B (Pró Concorrente)', '5511990000002', ?, 'JESSICA_PRO', 'ACTIVE', '2030-01-01', 0, 'CLIENT', ?, '2030-01-01')
  `).run(testEmailB, tokenB);
  const userIdB = userB.lastInsertRowid;

  const userStart = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Cliente Start', '5511990000003', ?, 'JESSICA_START', 'ACTIVE', '2030-01-01', 0, 'CLIENT', ?, '2030-01-01')
  `).run(testEmailStart, tokenStart);
  const userIdStart = userStart.lastInsertRowid;

  const userInter = db.prepare(`
    INSERT INTO users (name, phone_number, email, plan_tier, subscription_status, paid_until, is_demo, role, magic_token, magic_token_expires_at)
    VALUES ('Salão Cliente Intermediário', '5511990000004', ?, 'JESSICA_INTERMEDIATE', 'ACTIVE', '2030-01-01', 0, 'CLIENT', ?, '2030-01-01')
  `).run(testEmailInter, tokenInter);
  const userIdInter = userInter.lastInsertRowid;

  // Clean data for test users
  db.prepare('DELETE FROM incomes WHERE user_id IN (?, ?)').run(userIdA, userIdB);
  db.prepare('DELETE FROM expenses WHERE user_id IN (?, ?)').run(userIdA, userIdB);
  db.prepare('DELETE FROM scheduled_payments WHERE user_id IN (?, ?)').run(userIdA, userIdB);
  db.prepare('DELETE FROM appointments WHERE user_id IN (?, ?)').run(userIdA, userIdB);

  // Today in SP timezone
  const todaySP = salonDashboardService.getPeriodDates('today').startDate;

  console.log('--- FASE 1: TESTES DE SERVIÇO, CÁLCULO E PERSISTÊNCIA ---');

  await itAsync('1. Correção da incompatibilidade entre os campos da API e do frontend', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'this_month' });
    assert.strictEqual(data.success, true);
    // Modern 2.0 KPI keys
    assert(typeof data.metrics.realizedRevenue === 'number');
    assert(typeof data.metrics.estimatedRevenue === 'number');
    assert(typeof data.metrics.expensesTotal === 'number');
    assert(typeof data.metrics.financialResult === 'number');
    assert(typeof data.metrics.totalAppointments === 'number');
    assert(typeof data.metrics.completedAppointments === 'number');
    assert(typeof data.metrics.cancelledAppointments === 'number');
    assert(typeof data.metrics.averageTicket === 'number');

    // Backward compatibility keys
    assert.strictEqual(data.metrics.totalRevenue, data.metrics.realizedRevenue);
    assert.strictEqual(data.metrics.faturamentoMes, data.metrics.realizedRevenue);
    assert.strictEqual(data.metrics.atendimentosMes, data.metrics.totalAppointments);
    assert.strictEqual(data.metrics.ticketMedio, data.metrics.averageTicket);
  });

  await itAsync('2. Dados ausentes: não inventar números quando não houver transações', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'this_month' });
    assert.strictEqual(data.metrics.realizedRevenue, 0);
    assert.strictEqual(data.metrics.expensesTotal, 0);
    assert.strictEqual(data.metrics.financialResult, 0);
    assert.strictEqual(data.metrics.totalAppointments, 0);
    assert.strictEqual(data.metrics.completedAppointments, 0);
    assert.strictEqual(data.metrics.hasSufficientData, false);
    assert.strictEqual(data.variations.realizedRevenue.hasHistory, false);
    assert.strictEqual(data.variations.realizedRevenue.formatted, null);
  });

  // Insert financial data for User A
  // 2 incomes: R$ 150 (Pix) and R$ 250 (Cartão) = R$ 400
  db.prepare(`
    INSERT INTO incomes (user_id, amount, source, category, payment_method, date, source_type)
    VALUES (?, 150.0, 'Corte e Escova', 'Cortes', 'Pix', ?, 'test'),
           (?, 250.0, 'Mechas', 'Coloração', 'Cartão', ?, 'test')
  `).run(userIdA, todaySP, userIdA, todaySP);

  // 1 expense: R$ 80.0
  db.prepare(`
    INSERT INTO expenses (user_id, amount, category, description, payment_method, date, source_type)
    VALUES (?, 80.0, 'Insumos', 'Café e descartáveis', 'Pix', ?, 'test')
  `).run(userIdA, todaySP);

  // Appointments for User A:
  // 1 COMPLETED (price 150), 1 COMPLETED (price 250), 1 CANCELLED, 1 SCHEDULED (price 100)
  db.prepare(`
    INSERT INTO appointments (user_id, title, start_datetime, status, price)
    VALUES (?, 'Atendimento Maria', ? || 'T10:00:00', 'COMPLETED', 150.0),
           (?, 'Atendimento Joana', ? || 'T14:00:00', 'COMPLETED', 250.0),
           (?, 'Atendimento Carla', ? || 'T16:00:00', 'CANCELLED', 80.0),
           (?, 'Atendimento Paula', ? || 'T18:00:00', 'SCHEDULED', 100.0)
  `).run(userIdA, todaySP, userIdA, todaySP, userIdA, todaySP, userIdA, todaySP);

  await itAsync('3. Cálculo de receitas realizadas no período', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'today' });
    assert.strictEqual(data.metrics.realizedRevenue, 400.0);
  });

  await itAsync('4. Cálculo de despesas operacionais no período', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'today' });
    assert.strictEqual(data.metrics.expensesTotal, 80.0);
  });

  await itAsync('5. Resultado financeiro exato (Receitas - Despesas)', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'today' });
    assert.strictEqual(data.metrics.financialResult, 320.0); // 400 - 80
  });

  await itAsync('6. Faturamento estimado baseado em agendamentos futuros pendentes', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'today' });
    assert.strictEqual(data.metrics.estimatedRevenue, 100.0); // Paula's scheduled appt
  });

  await itAsync('7. Agendamentos realizados vs cancelados', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'today' });
    assert.strictEqual(data.metrics.totalAppointments, 4);
    assert.strictEqual(data.metrics.completedAppointments, 2);
    assert.strictEqual(data.metrics.cancelledAppointments, 1);
  });

  await itAsync('8. Ticket médio calculado com precisão sobre atendimentos realizados', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'today' });
    // R$ 400 realized / 2 completed = R$ 200.00
    assert.strictEqual(data.metrics.averageTicket, 200.0);
    assert.strictEqual(data.metrics.hasSufficientData, true);
  });

  await itAsync('9. Respeito aos filtros de datas (Hoje, 7d, Este mês, Mês anterior, Personalizado)', async () => {
    const pToday = salonDashboardService.getPeriodDates('today');
    assert.strictEqual(pToday.startDate, pToday.endDate);

    const p7d = salonDashboardService.getPeriodDates('7d');
    assert(p7d.startDate <= p7d.endDate);

    const pThisM = salonDashboardService.getPeriodDates('this_month');
    assert(pThisM.startDate.endsWith('-01'));

    const pLastM = salonDashboardService.getPeriodDates('last_month');
    assert(pLastM.startDate <= pLastM.endDate);

    const pCustom = salonDashboardService.getPeriodDates('custom', '2026-05-01', '2026-05-15');
    assert.strictEqual(pCustom.startDate, '2026-05-01');
    assert.strictEqual(pCustom.endDate, '2026-05-15');
    assert.strictEqual(pCustom.prevStartDate, '2026-04-16');
  });

  await itAsync('10. Gráfico temporal: série diária coerente com os lançamentos', async () => {
    const data = await salonDashboardService.getSalonDashboard(userIdA, { period: 'today' });
    assert(data.timeline.length >= 1);
    const todayPoint = data.timeline.find(t => t.date === todaySP);
    assert(todayPoint, 'Ponto de hoje deve estar presente na timeline');
    assert.strictEqual(todayPoint.receitas, 400.0);
    assert.strictEqual(todayPoint.despesas, 80.0);
    assert.strictEqual(todayPoint.resultado, 320.0);
  });

  it('11. Permissões de Plano: Jéssica Entrada (JESSICA_START)', () => {
    const tier = salonDashboardService.getEffectiveJessicaTier(userIdStart);
    assert.strictEqual(tier, 'JESSICA_START');
  });

  it('12. Permissões de Plano: Jéssica Intermediário (JESSICA_INTERMEDIATE)', () => {
    const tier = salonDashboardService.getEffectiveJessicaTier(userIdInter);
    assert.strictEqual(tier, 'JESSICA_INTERMEDIATE');
  });

  it('13. Permissões de Plano: Jéssica Pró (JESSICA_PRO)', () => {
    const tier = salonDashboardService.getEffectiveJessicaTier(userIdA);
    assert.strictEqual(tier, 'JESSICA_PRO');
  });

  await itAsync('14. Contas a Pagar: criação, liquidação e reflexo automático em despesas', async () => {
    const newBills = salonDashboardService.createBill(userIdA, {
      title: 'Fornecedor de Esmaltes',
      amount: 150.0,
      dueDate: todaySP,
      category: 'Fornecedores',
      installments: 1,
    });
    assert.strictEqual(newBills.length, 1);
    const billId = newBills[0].id;

    const payResult = salonDashboardService.markBillAsPaid(userIdA, billId);
    assert.strictEqual(payResult.bill.status, 'PAID');
    assert.strictEqual(payResult.expense.amount, 150.0);
    assert.strictEqual(payResult.expense.userId, userIdA);

    const paidExp = db.prepare('SELECT * FROM expenses WHERE id = ?').get(payResult.expense.id);
    assert(paidExp);
    assert.strictEqual(paidExp.user_id, userIdA);

    const delResult = salonDashboardService.deleteBill(userIdA, billId);
    assert.strictEqual(delResult.changes, 1);
  });

  await itAsync('15. Multi-tenant: isolamento estrito de dados financeiros entre estabelecimentos', async () => {
    const dataB = await salonDashboardService.getSalonDashboard(userIdB, { period: 'today' });
    assert.strictEqual(dataB.metrics.realizedRevenue, 0, 'User B não deve ver receitas de User A');
    assert.strictEqual(dataB.metrics.expensesTotal, 0, 'User B não deve ver despesas de User A');
    assert.strictEqual(dataB.metrics.totalAppointments, 0, 'User B não deve ver agendamentos de User A');

    const billA = salonDashboardService.createBill(userIdA, {
      title: 'Conta Segredo Salão A',
      amount: 500.0,
      dueDate: todaySP,
    })[0];

    assert.throws(() => salonDashboardService.markBillAsPaid(userIdB, billA.id), /não pertence a este usuário/i);
    assert.throws(() => salonDashboardService.deleteBill(userIdB, billA.id), /permissão negada/i);

    salonDashboardService.deleteBill(userIdA, billA.id);
  });

  await itAsync('16. Conta demonstrativa: dados ilustrativos coerentes e badge de homologação', async () => {
    const demoData = await salonDashboardService.getSalonDashboard(13, { isDemo: true, period: 'this_month' });
    assert.strictEqual(demoData.isDemo, true);
    assert(demoData.demoBadge.includes('Bella Vista'));
    assert(demoData.metrics.realizedRevenue > 5000);
    assert(demoData.metrics.completedAppointments > 50);
    assert(demoData.timeline.length > 0);
    assert(demoData.services.length > 0);
    assert(demoData.staff.length > 0);
    assert(demoData.bills.upcomingBills.length > 0);
    assert(demoData.transactions.length > 0);
  });

  console.log('\n--- FASE 2: TESTES DE INTEGRAÇÃO HTTP (API REST & GATING REAL) ---');

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

  await itAsync('17. HTTP GET /api/cliente/pro/dashboard - Bloqueio 403 no Plano Entrada (JESSICA_START)', async () => {
    const res = await requestApi('/api/cliente/pro/dashboard', {
      headers: { 'X-Auth-Token': tokenStart },
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.upgradeRequired, true);
    assert(body.message.includes('Intermediário e Pró'));
  });

  await itAsync('18. HTTP GET /api/cliente/pro/dashboard - Acesso 200 no Plano Intermediário', async () => {
    const res = await requestApi('/api/cliente/pro/dashboard?period=today', {
      headers: { 'X-Auth-Token': tokenInter },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.isPro, false);
    assert.strictEqual(body.userTier, 'JESSICA_INTERMEDIATE');
  });

  await itAsync('19. HTTP GET /api/cliente/pro/bills - Bloqueio 403 no Plano Intermediário (proExclusive)', async () => {
    const res = await requestApi('/api/cliente/pro/bills', {
      headers: { 'X-Auth-Token': tokenInter },
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.proExclusive, true);
  });

  await itAsync('20. HTTP GET /api/cliente/pro/dashboard - Acesso 200 no Plano Pró com Contas a Pagar', async () => {
    const res = await requestApi('/api/cliente/pro/dashboard?period=today', {
      headers: { 'X-Auth-Token': tokenA },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.isPro, true);
    assert.strictEqual(body.userTier, 'JESSICA_PRO');
    assert(body.bills !== undefined);
  });

  await itAsync('21. HTTP POST /api/cliente/pro/bills - Cadastro de conta com sucesso no Plano Pró', async () => {
    const res = await requestApi('/api/cliente/pro/bills', {
      method: 'POST',
      headers: {
        'X-Auth-Token': tokenA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Aluguel do Salão de Teste',
        amount: 2500.0,
        dueDate: todaySP,
        category: 'Aluguel',
        installments: 1,
      }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert(Array.isArray(body.bills));
    assert.strictEqual(body.bills[0].title, 'Aluguel do Salão de Teste');

    const createdBillId = body.bills[0].id;

    // Now test PATCH /pay
    const payRes = await requestApi(`/api/cliente/pro/bills/${createdBillId}/pay`, {
      method: 'PATCH',
      headers: { 'X-Auth-Token': tokenA },
    });
    assert.strictEqual(payRes.status, 200);
    const payBody = await payRes.json();
    assert.strictEqual(payBody.success, true);
    assert.strictEqual(payBody.bill.status, 'PAID');

    // Clean up
    salonDashboardService.deleteBill(userIdA, createdBillId);
  });

  await itAsync('22. HTTP POST /api/cliente/pro/transactions - Lançamento manual de movimentação', async () => {
    const res = await requestApi('/api/cliente/pro/transactions', {
      method: 'POST',
      headers: {
        'X-Auth-Token': tokenA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'INCOME',
        description: 'Venda de Shampoo e Máscara',
        amount: 120.0,
        paymentMethod: 'Pix',
        category: 'Produtos',
      }),
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.transaction.amount, 120.0);
  });

  await itAsync('23. HTTP GET /api/cliente/pro/dashboard - Conta demonstrativa Bella Vista', async () => {
    // Get demo user token
    const demoUser = db.prepare('SELECT magic_token FROM users WHERE is_demo = 1 LIMIT 1').get();
    assert(demoUser);
    const res = await requestApi('/api/cliente/pro/dashboard?period=this_month', {
      headers: { 'X-Auth-Token': demoUser.magic_token },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.isDemo, true);
    assert(body.demoBadge.includes('Bella Vista'));
    assert(body.metrics.realizedRevenue > 0);
  });

  // Close server
  await new Promise(res => server.close(res));

  // Clean test accounts
  db.prepare('DELETE FROM incomes WHERE user_id IN (?, ?)').run(userIdA, userIdB);
  db.prepare('DELETE FROM expenses WHERE user_id IN (?, ?)').run(userIdA, userIdB);
  db.prepare('DELETE FROM scheduled_payments WHERE user_id IN (?, ?)').run(userIdA, userIdB);
  db.prepare('DELETE FROM appointments WHERE user_id IN (?, ?)').run(userIdA, userIdB);
  db.prepare('DELETE FROM users WHERE id IN (?, ?, ?, ?)').run(userIdA, userIdB, userIdStart, userIdInter);

  console.log('\n=======================================================');
  console.log(`RESULTADO FINAL: ${passedTests} APROVADOS, ${failedTests} FALHAS`);
  console.log('=======================================================\n');

  if (failedTests > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
