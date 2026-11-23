/**
 * COMANDO 070.2 — Homologação da Consistência Financeira, Cards de Contas a Pagar,
 * Ticket Médio, Preço de Tabela, Separação Previsto/Realizado e Isolamento Multi-Tenant.
 *
 * Módulos nativos: node:test e node:assert/strict.
 * Isolamento hermético: banco temporário em os.tmpdir().
 * Zero contaminação de data/assistant.db.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// 1. Configuração do Banco Temporário Isolado em os.tmpdir()
const tempDbPath = path.join(os.tmpdir(), `test-consistencia-financeira-${crypto.randomUUID()}.db`);
process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.SESSION_SECRET = 'test-session-secret-consistencia-100-percent';
process.env.CLIENT_AUTH_SECRET = 'test-client-secret-consistencia-100-percent';

// Importa banco de dados e serviços após configurar DB_PATH
const db = require('../src/database/db');
const salonDashboardService = require('../src/services/salonDashboardService');

// Hook de encerramento para destruição do banco temporário
test.after(() => {
  try {
    db.close();
  } catch (_) {}
  try {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  } catch (_) {}
});

// Helper de data de São Paulo (UTC-3)
function getSaoPauloDate(d = new Date()) {
  const spOffset = -3 * 60;
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const spDate = new Date(utc + (spOffset * 60000));
  const y = spDate.getFullYear();
  const m = String(spDate.getMonth() + 1).padStart(2, '0');
  const day = String(spDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return getSaoPauloDate(dt);
}

// ============================================================================
// SUÍTE 1: CARDS DE CONTAS A PAGAR VERSUS TABELA (DEMO & REAL SQLITE)
// ============================================================================
test('1. Cards de Contas a Pagar: Total Pendente, Vencidas, A Vencer e Quitadas (Demo)', async () => {
  const todayStr = getSaoPauloDate();
  const demoData = await salonDashboardService.getSalonDashboard(null, {
    isDemo: true,
    isPro: true,
    period: 'this_month',
  });

  assert.ok(demoData.success, 'Dashboard Demo deve retornar sucesso');
  assert.ok(demoData.bills, 'Dashboard Demo Pro deve conter o objeto bills');

  const { bills } = demoData;
  const { overdueBills, upcomingBills, paidBills } = bills;

  // 1.1 pendingTotal é exatamente igual à soma de overdueBills + upcomingBills
  const sumOverdue = overdueBills.reduce((acc, b) => acc + Number(b.amount), 0);
  const sumUpcoming = upcomingBills.reduce((acc, b) => acc + Number(b.amount), 0);
  const expectedPendingTotal = Math.round((sumOverdue + sumUpcoming) * 100) / 100;
  assert.equal(bills.pendingTotal, expectedPendingTotal, 'bills.pendingTotal deve ser a soma exata de vencidas e a vencer');

  // 1.2 pendingCount é exatamente igual à soma dos tamanhos dos arrays
  assert.equal(bills.pendingCount, overdueBills.length + upcomingBills.length, 'bills.pendingCount deve ser a soma de overdue + upcoming');

  // 1.3 overdueCount é exatamente igual ao número de contas vencidas
  assert.equal(bills.overdueCount, overdueBills.length, 'bills.overdueCount deve coincidir com overdueBills.length');

  // 1.4 paidTotal é exatamente igual à soma de paidBills
  const expectedPaidTotal = Math.round(paidBills.reduce((acc, b) => acc + Number(b.amount), 0) * 100) / 100;
  assert.equal(bills.paidTotal, expectedPaidTotal, 'bills.paidTotal deve ser a soma exata de paidBills');

  // 1.5 paidCount é exatamente igual ao total de quitadas
  assert.equal(bills.paidCount, paidBills.length, 'bills.paidCount deve coincidir com paidBills.length');
});

test('1.1 Cards de Contas a Pagar: Validação Real com SQLite e Agendamentos no Banco', async () => {
  const todayStr = getSaoPauloDate();

  // Cria usuário do salão
  const userResult = db.prepare(`
    INSERT INTO users (phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (?, ?, 'CLIENT', 0, 'ACTIVE', '2099-12-31')
  `).run(`551199990001_${Date.now()}`, 'Salão Real Teste Contas');
  const userId = userResult.lastInsertRowid;

  // Insere contas vencidas (< todayStr)
  db.prepare(`
    INSERT INTO scheduled_payments (user_id, title, amount, due_date, category, status)
    VALUES (?, 'Fornecedor Vencido A', 450.50, ?, 'Produtos', 'PENDING')
  `).run(userId, addDays(todayStr, -5));

  db.prepare(`
    INSERT INTO scheduled_payments (user_id, title, amount, due_date, category, status)
    VALUES (?, 'Fornecedor Vencido B', 120.25, ?, 'Insumos', 'PENDING')
  `).run(userId, addDays(todayStr, -2));

  // Insere contas a vencer (>= todayStr)
  db.prepare(`
    INSERT INTO scheduled_payments (user_id, title, amount, due_date, category, status)
    VALUES (?, 'Energia Elétrica', 380.00, ?, 'Contas', 'PENDING')
  `).run(userId, addDays(todayStr, 3));

  db.prepare(`
    INSERT INTO scheduled_payments (user_id, title, amount, due_date, category, status)
    VALUES (?, 'Internet Fibra', 150.00, ?, 'Tecnologia', 'PENDING')
  `).run(userId, addDays(todayStr, 10));

  // Insere conta quitada (status = PAID)
  db.prepare(`
    INSERT INTO scheduled_payments (user_id, title, amount, due_date, category, status, paid_at)
    VALUES (?, 'Aluguel Comercial', 2200.00, ?, 'Imóvel', 'PAID', ?)
  `).run(userId, addDays(todayStr, -15), `${addDays(todayStr, -15)}T10:00:00`);

  const dashboard = await salonDashboardService.getSalonDashboard(userId, {
    isDemo: false,
    isPro: true,
    period: 'this_month',
  });

  assert.ok(dashboard.bills, 'Módulo de contas a pagar deve estar preenchido para Jéssica Pró');
  const { bills } = dashboard;

  // Validações estritas dos cards
  assert.equal(bills.overdueCount, 2, 'Devem existir 2 contas vencidas');
  assert.equal(bills.overdueBills.length, 2);
  assert.equal(bills.upcomingBills.length, 2, 'Devem existir 2 contas a vencer');
  assert.equal(bills.pendingCount, 4, 'Total pendente deve ser 4 contas');
  assert.equal(bills.pendingTotal, 450.50 + 120.25 + 380.00 + 150.00); // 1100.75
  assert.equal(bills.paidCount, 1, 'Deve existir 1 conta quitada');
  assert.equal(bills.paidTotal, 2200.00, 'Total quitado deve ser R$ 2.200,00');
});

// ============================================================================
// SUÍTE 2: CLASSIFICAÇÃO DE VENCIMENTOS CONFORME A DATA ATUAL
// ============================================================================
test('2. Classificação de Vencimentos: due_date < todayStr (Vencida), >= todayStr (A Vencer), status PAID (Quitada)', async () => {
  const todayStr = getSaoPauloDate();

  const userResult = db.prepare(`
    INSERT INTO users (phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (?, ?, 'CLIENT', 0, 'ACTIVE', '2099-12-31')
  `).run(`551199990002_${Date.now()}`, 'Salão Classificação Vencimentos');
  const userId = userResult.lastInsertRowid;

  // Ontem (Vencida)
  const yesterday = addDays(todayStr, -1);
  db.prepare("INSERT INTO scheduled_payments (user_id, title, amount, due_date, status) VALUES (?, 'Ontem', 100, ?, 'PENDING')").run(userId, yesterday);

  // Hoje (A Vencer / Próxima)
  db.prepare("INSERT INTO scheduled_payments (user_id, title, amount, due_date, status) VALUES (?, 'Hoje', 200, ?, 'PENDING')").run(userId, todayStr);

  // Amanhã (A Vencer / Próxima)
  const tomorrow = addDays(todayStr, 1);
  db.prepare("INSERT INTO scheduled_payments (user_id, title, amount, due_date, status) VALUES (?, 'Amanhã', 300, ?, 'PENDING')").run(userId, tomorrow);

  // Paga no passado (Quitada)
  db.prepare("INSERT INTO scheduled_payments (user_id, title, amount, due_date, status, paid_at) VALUES (?, 'Paga', 400, ?, 'PAID', ?)").run(userId, yesterday, `${yesterday}T12:00:00`);

  const dashboard = await salonDashboardService.getSalonDashboard(userId, { isDemo: false, isPro: true });
  const { bills } = dashboard;

  // Verificação de pertencimento
  const isOverdue = bills.overdueBills.some(b => b.title === 'Ontem' && b.due_date < todayStr);
  assert.ok(isOverdue, 'Conta com vencimento ontem deve estar estritamente em overdueBills');

  const isTodayUpcoming = bills.upcomingBills.some(b => b.title === 'Hoje' && b.due_date >= todayStr);
  assert.ok(isTodayUpcoming, 'Conta com vencimento hoje deve estar em upcomingBills');

  const isTomorrowUpcoming = bills.upcomingBills.some(b => b.title === 'Amanhã' && b.due_date >= todayStr);
  assert.ok(isTomorrowUpcoming, 'Conta com vencimento amanhã deve estar em upcomingBills');

  const isPaid = bills.paidBills.some(b => b.title === 'Paga' && b.status === 'PAID');
  assert.ok(isPaid, 'Conta com status PAID deve estar em paidBills');
});

// ============================================================================
// SUÍTE 3: TICKET MÉDIO VERSUS RECEITAS E ATENDIMENTOS
// ============================================================================
test('3. Ticket Médio: Cálculo estrito por profissional (revenue / appointments) e zero na ausência', async () => {
  // Teste em dados Demo
  const demoData = await salonDashboardService.getSalonDashboard(null, { isDemo: true });
  assert.ok(demoData.staff && demoData.staff.length > 0, 'Demo deve retornar lista de staff');

  demoData.staff.forEach(st => {
    if (st.appointments > 0) {
      const expectedAvg = Math.round((st.revenue / st.appointments) * 100) / 100;
      assert.equal(st.avgTicket, expectedAvg, `Ticket médio do profissional ${st.name} deve ser exatamente revenue/appointments`);
    } else {
      assert.equal(st.avgTicket, 0, `Profissional sem atendimentos deve ter ticket médio 0`);
    }
  });

  // Teste com salão real no SQLite
  const userResult = db.prepare(`
    INSERT INTO users (phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (?, ?, 'CLIENT', 0, 'ACTIVE', '2099-12-31')
  `).run(`551199990003_${Date.now()}`, 'Salão Ticket Médio');
  const userId = userResult.lastInsertRowid;

  // Cadastra 2 profissionais
  const st1 = db.prepare("INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, 'Beatriz', 'Colorista', 1)").run(userId);
  const st2 = db.prepare("INSERT INTO client_staff (user_id, name, specialty, active) VALUES (?, 'Marcos', 'Barbeiro', 1)").run(userId);

  const todayStr = getSaoPauloDate();
  // Beatriz: 2 atendimentos, R$ 150 + R$ 250 = R$ 400 (Ticket médio R$ 200)
  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, price, start_datetime, status)
    VALUES (?, ?, 'Coloração', 150.00, ?, 'COMPLETED')
  `).run(userId, st1.lastInsertRowid, `${todayStr}T10:00:00`);

  db.prepare(`
    INSERT INTO appointments (user_id, staff_id, title, price, start_datetime, status)
    VALUES (?, ?, 'Mechas', 250.00, ?, 'COMPLETED')
  `).run(userId, st1.lastInsertRowid, `${todayStr}T14:00:00`);

  // Marcos: 0 atendimentos

  const dashboard = await salonDashboardService.getSalonDashboard(userId, { isDemo: false });
  const beatriz = dashboard.staff.find(s => s.name === 'Beatriz');
  const marcos = dashboard.staff.find(s => s.name === 'Marcos');

  assert.ok(beatriz);
  assert.equal(beatriz.appointments, 2);
  assert.equal(beatriz.revenue, 400.00);
  assert.equal(beatriz.avgTicket, 200.00);

  assert.ok(marcos);
  assert.equal(marcos.appointments, 0);
  assert.equal(marcos.revenue, 0);
  assert.equal(marcos.avgTicket, 0);
});

// ============================================================================
// SUÍTE 4: PREÇO DE TABELA VERSUS VALORES DOS SERVIÇOS
// ============================================================================
test('4. Preço de Tabela: renderTopServices e HTML exibem o rótulo "Preço de tabela" e legenda explicativa', () => {
  const painelHtmlPath = path.resolve(__dirname, '../public/cliente/painel.html');
  assert.ok(fs.existsSync(painelHtmlPath), 'Arquivo painel.html deve existir');

  const htmlContent = fs.readFileSync(painelHtmlPath, 'utf8');

  // Valida que o JavaScript do frontend exibe "Preço de tabela: R$ ..."
  assert.ok(
    htmlContent.includes('Preço de tabela: ${formatBRL(s.price)}') ||
    htmlContent.includes('Preço de tabela:'),
    'O template JavaScript deve conter a expressão literal "Preço de tabela:"'
  );

  // Valida a legenda explicativa no container de serviços mais procurados
  assert.ok(
    htmlContent.includes('Por volume e receita (preço de tabela)'),
    'O cabeçalho do card de serviços deve exibir a legenda "Por volume e receita (preço de tabela)"'
  );

  // Valida a nota explicativa do ticket médio da equipe
  assert.ok(
    htmlContent.includes('O Ticket Médio individual é calculado rigorosamente pela receita atribuída dividida pelos atendimentos'),
    'A tabela de profissionais deve exibir a nota de cálculo rigoroso do ticket médio'
  );
});

// ============================================================================
// SUÍTE 5: SEPARAÇÃO ENTRE VALORES PREVISTOS E REALIZADOS
// ============================================================================
test('5. Separação Previsto vs Realizado: Dias futuros com receitas em caixa = 0 e faturamento previsto separado', async () => {
  const todayStr = getSaoPauloDate();
  const demoData = await salonDashboardService.getSalonDashboard(null, {
    isDemo: true,
    period: 'this_month',
  });

  const { timeline, metrics } = demoData;
  assert.ok(Array.isArray(timeline) && timeline.length > 0, 'Timeline deve conter dados');

  let futurePointsCount = 0;
  let realizedSumFromTimeline = 0;

  timeline.forEach(point => {
    if (point.date > todayStr) {
      futurePointsCount++;
      // Dias futuros NÃO podem ter receitas nem despesas realizadas em caixa
      assert.equal(point.receitas, 0, `Dia futuro ${point.date} deve ter receita realizada = 0`);
      assert.equal(point.despesas, 0, `Dia futuro ${point.date} deve ter despesa realizada = 0`);
    } else {
      realizedSumFromTimeline += point.receitas;
    }
  });

  const expectedRealized = Math.round(realizedSumFromTimeline * 100) / 100;
  assert.equal(metrics.realizedRevenue, expectedRealized, 'metrics.realizedRevenue deve ser estritamente a soma dos dias <= todayStr');

  // Se houver dias futuros no mês, faturamento estimado deve refletir a projeção futura
  if (futurePointsCount > 0) {
    assert.ok(metrics.estimatedRevenue > 0, 'Faturamento estimado deve ser positivo quando houver dias futuros');
    assert.notEqual(metrics.estimatedRevenue, metrics.realizedRevenue, 'Faturamento estimado não deve se confundir com o realizado');
  }
});

// ============================================================================
// SUÍTE 6: VALIDAÇÃO DINÂMICA DA CONSISTÊNCIA MATEMÁTICA 100%
// ============================================================================
test('6. Validação Dinâmica da Consistência Matemática 100%: Lógica do badge #badgeMathConsistency', async () => {
  // Executa algoritmo de auditoria matemática do badge
  function verifyConsistency(metrics, weeklyBreakdown) {
    const realized = Math.round((Number(metrics.realizedRevenue) || 0) * 100) / 100;
    const expenses = Math.round((Number(metrics.expensesTotal) || 0) * 100) / 100;
    const result = Math.round((Number(metrics.financialResult) || 0) * 100) / 100;
    const expectedResult = Math.round((realized - expenses) * 100) / 100;
    const resultValid = Math.abs(result - expectedResult) < 0.02;

    if (Array.isArray(weeklyBreakdown) && weeklyBreakdown.length > 0) {
      const sumWeeksRec = Math.round(weeklyBreakdown.reduce((acc, w) => acc + (Number(w.receitas) || 0), 0) * 100) / 100;
      const sumWeeksDesp = Math.round(weeklyBreakdown.reduce((acc, w) => acc + (Number(w.despesas) || 0), 0) * 100) / 100;
      const sumWeeksRes = Math.round(weeklyBreakdown.reduce((acc, w) => acc + (Number(w.resultado) || 0), 0) * 100) / 100;

      const recValid = Math.abs(sumWeeksRec - realized) < 0.02;
      const despValid = Math.abs(sumWeeksDesp - expenses) < 0.02;
      const resValid = Math.abs(sumWeeksRes - result) < 0.02;

      return recValid && despValid && resValid && resultValid;
    }
    return resultValid;
  }

  // 6.1 Testa consistência nos dados de Demonstração
  const periods = ['today', '7d', 'this_month', 'last_month'];
  for (const p of periods) {
    const demoData = await salonDashboardService.getSalonDashboard(null, { isDemo: true, period: p });
    const isConsistent = verifyConsistency(demoData.metrics, demoData.weeklyBreakdown);
    assert.ok(isConsistent, `Demonstração deve ter consistência matemática 100% no período ${p}`);
  }

  // 6.2 Testa consistência em dados reais com transações no SQLite
  const userResult = db.prepare(`
    INSERT INTO users (phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (?, ?, 'CLIENT', 0, 'ACTIVE', '2099-12-31')
  `).run(`551199990006_${Date.now()}`, 'Salão Auditoria Matemática');
  const userId = userResult.lastInsertRowid;

  const todayStr = getSaoPauloDate();
  db.prepare("INSERT INTO incomes (user_id, amount, source, date) VALUES (?, 1500.00, 'Serviços', ?)").run(userId, `${todayStr} 10:00:00`);
  db.prepare("INSERT INTO expenses (user_id, amount, description, category, date) VALUES (?, 450.00, 'Insumos', 'Insumos', ?)").run(userId, `${todayStr} 11:00:00`);

  const realDashboard = await salonDashboardService.getSalonDashboard(userId, { isDemo: false, period: 'this_month' });
  const isRealConsistent = verifyConsistency(realDashboard.metrics, realDashboard.weeklyBreakdown);
  assert.ok(isRealConsistent, 'Salão real com receitas e despesas deve atingir consistência matemática 100%');
});

// ============================================================================
// SUÍTE 7: FILTROS DE PERÍODO, ISOLAMENTO MULTI-TENANT E DEMO SHIELD
// ============================================================================
test('7. Multi-Tenant Isolation & Demo Shield: Nenhum dado vaza entre estabelecimentos ou contamina Demo', async () => {
  // Salão Alpha
  const uAlpha = db.prepare(`
    INSERT INTO users (phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (?, 'Salão Alpha', 'CLIENT', 0, 'ACTIVE', '2099-12-31')
  `).run(`551199990007_${Date.now()}`);
  const idAlpha = uAlpha.lastInsertRowid;

  // Salão Beta
  const uBeta = db.prepare(`
    INSERT INTO users (phone_number, name, role, is_demo, subscription_status, paid_until)
    VALUES (?, 'Salão Beta', 'CLIENT', 0, 'ACTIVE', '2099-12-31')
  `).run(`551199990008_${Date.now()}`);
  const idBeta = uBeta.lastInsertRowid;

  const todayStr = getSaoPauloDate();

  // Alpha fatura R$ 5.000 e tem despesa de R$ 1.000
  db.prepare("INSERT INTO incomes (user_id, amount, source, date) VALUES (?, 5000.00, 'Coloração Especial', ?)").run(idAlpha, `${todayStr} 09:00:00`);
  db.prepare("INSERT INTO expenses (user_id, amount, description, category, date) VALUES (?, 1000.00, 'Aluguel Alpha', 'Imóvel', ?)").run(idAlpha, `${todayStr} 09:30:00`);
  db.prepare("INSERT INTO scheduled_payments (user_id, title, amount, due_date, status) VALUES (?, 'Conta Alpha', 350.00, ?, 'PENDING')").run(idAlpha, addDays(todayStr, 2));

  // Beta fatura R$ 800 e tem despesa de R$ 200
  db.prepare("INSERT INTO incomes (user_id, amount, source, date) VALUES (?, 800.00, 'Corte Masculino', ?)").run(idBeta, `${todayStr} 10:00:00`);
  db.prepare("INSERT INTO expenses (user_id, amount, description, category, date) VALUES (?, 200.00, 'Café e Limpeza Beta', 'Insumos', ?)").run(idBeta, `${todayStr} 10:30:00`);
  db.prepare("INSERT INTO scheduled_payments (user_id, title, amount, due_date, status) VALUES (?, 'Conta Beta', 80.00, ?, 'PENDING')").run(idBeta, addDays(todayStr, 5));

  // Consulta Salão Alpha
  const dashAlpha = await salonDashboardService.getSalonDashboard(idAlpha, { isDemo: false, isPro: true });
  assert.equal(dashAlpha.metrics.realizedRevenue, 5000.00, 'Alpha deve ter exatamente R$ 5.000 faturados');
  assert.equal(dashAlpha.metrics.expensesTotal, 1000.00, 'Alpha deve ter exatamente R$ 1.000 em despesas');
  assert.equal(dashAlpha.metrics.financialResult, 4000.00, 'Resultado de Alpha deve ser R$ 4.000');
  assert.equal(dashAlpha.bills.pendingTotal, 350.00, 'Contas a pagar de Alpha deve ser R$ 350');

  // Consulta Salão Beta
  const dashBeta = await salonDashboardService.getSalonDashboard(idBeta, { isDemo: false, isPro: true });
  assert.equal(dashBeta.metrics.realizedRevenue, 800.00, 'Beta deve ter exatamente R$ 800 faturados');
  assert.equal(dashBeta.metrics.expensesTotal, 200.00, 'Beta deve ter exatamente R$ 200 em despesas');
  assert.equal(dashBeta.metrics.financialResult, 600.00, 'Resultado de Beta deve ser R$ 600');
  assert.equal(dashBeta.bills.pendingTotal, 80.00, 'Contas a pagar de Beta deve ser R$ 80');

  // 7.2 Demo Shield: Preservação da Conta Demonstrativa Bella Vista
  const demoShield = await salonDashboardService.getSalonDashboard(null, { isDemo: true });
  assert.equal(demoShield.isDemo, true, 'Flag isDemo deve ser estritamente true');
  assert.equal(demoShield.demoBadge, 'Dados demonstrativos — Bella Vista Hair & Spa');
  assert.notEqual(demoShield.metrics.realizedRevenue, dashAlpha.metrics.realizedRevenue, 'Demo não pode refletir valores do Salão Alpha');
  assert.notEqual(demoShield.metrics.realizedRevenue, dashBeta.metrics.realizedRevenue, 'Demo não pode refletir valores do Salão Beta');
});
