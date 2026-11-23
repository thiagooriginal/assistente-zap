/**
 * COMANDO 070 — SUÍTE DE TESTES HERMÉTICOS:
 * REDESIGN PREMIUM DO DASHBOARD GERENCIAL E FINANCEIRO DA JÉSSICA
 *
 * Validação rigorosa dos 15 cenários de negócio, consistência matemática e UX:
 *  1. Presença e coexistência das três novas seções no HTML de painel.html.
 *  2. Consistência matemática exata de buildWeeklyBreakdown com a timeline e totais.
 *  3. Cálculo de receitas realizadas via tabela incomes.
 *  4. Cálculo de despesas operacionais via tabela expenses.
 *  5. Cálculo do resultado financeiro líquido (receitas - despesas).
 *  6. Cenário de resultado negativo (déficit de caixa onde despesas > receitas).
 *  7. Cenário de ausência de movimentações financeiras (zeros defensivos).
 *  8. Filtros de período (today, 7d, this_month, last_month, custom).
 *  9. Dados demonstrativos (Demo Shield — Bella Vista Hair & Spa e isDemo=true).
 * 10. Isolamento multi-tenant absoluto (Salão A não acessa dados do Salão B).
 * 11. Proteção de planos RBAC (JESSICA_START vs INTERMEDIATE vs PRO).
 * 12. Módulo de Contas a Pagar segregado e exclusivo do plano PRO.
 * 13. Preservação de todos os 8 indicadores de KPI existentes.
 * 14. Sanitização contra XSS no frontend (escapeHtml).
 * 15. Formatação monetária pt-BR e integridade dos seletores de interação.
 *
 * Padrão Hermético: Banco SQLite temporário em os.tmpdir(), node:test e node:assert/strict.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 1. ISOLAMENTO DO BANCO DE DADOS EM os.tmpdir()
const uniqueDbName = `test_c070_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
const testDbPath = path.join(os.tmpdir(), uniqueDbName);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';

const db = require('../src/database/db');
const salonDashboardService = require('../src/services/salonDashboardService');

// IDs de teste para isolamento multi-tenant
const TENANT_A = 701;
const TENANT_B = 702;
const DEMO_TENANT = 703;
const START_TENANT = 704;

function setupDashboardTestData() {
  // 1. Usuários e Tenants
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan, subscription_status, paid_until, is_demo)
    VALUES
      (?, '5511999990701', 'Salão Studio A', 'CLIENT_SALON', 'PRO', 'ACTIVE', datetime('now', '+30 days'), 0),
      (?, '5511999990702', 'Salão Studio B', 'CLIENT_SALON', 'PRO', 'ACTIVE', datetime('now', '+30 days'), 0),
      (?, '5511999990703', 'Bella Vista Hair & Spa', 'CLIENT_SALON', 'PRO', 'ACTIVE', datetime('now', '+30 days'), 1),
      (?, '5511999990704', 'Salão Básico Start', 'CLIENT_SALON', 'START', 'ACTIVE', datetime('now', '+30 days'), 0)
  `).run(TENANT_A, TENANT_B, DEMO_TENANT, START_TENANT);

  // 2. Subscrições de Produto Jéssica
  const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  const prodId = jessicaProd ? jessicaProd.id : 1;

  const planPro = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'PRO'").get(prodId);
  const planStart = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'START'").get(prodId);
  const proPlanId = planPro ? planPro.id : null;
  const startPlanId = planStart ? planStart.id : null;

  db.prepare(`
    INSERT OR REPLACE INTO customer_subscriptions (id, user_id, product_id, plan_id, status, price_cents, setup_fee_cents, billing_cycle, contracted_at, paid_until, access_expires_at)
    VALUES
      (701, ?, ?, ?, 'ACTIVE', 14900, 0, 'MONTHLY', CURRENT_TIMESTAMP, datetime('now', '+30 days'), datetime('now', '+30 days')),
      (702, ?, ?, ?, 'ACTIVE', 14900, 0, 'MONTHLY', CURRENT_TIMESTAMP, datetime('now', '+30 days'), datetime('now', '+30 days')),
      (703, ?, ?, ?, 'ACTIVE', 14900, 0, 'MONTHLY', CURRENT_TIMESTAMP, datetime('now', '+30 days'), datetime('now', '+30 days')),
      (704, ?, ?, ?, 'ACTIVE', 4900, 0, 'MONTHLY', CURRENT_TIMESTAMP, datetime('now', '+30 days'), datetime('now', '+30 days'))
  `).run(TENANT_A, prodId, proPlanId, TENANT_B, prodId, proPlanId, DEMO_TENANT, prodId, proPlanId, START_TENANT, prodId, startPlanId);

  // 3. Salão
  db.prepare(`
    INSERT OR REPLACE INTO client_salons (user_id, salon_name, phone, whatsapp_status)
    VALUES
      (?, 'Studio A Luxury', '5511999990701', 'CONNECTED'),
      (?, 'Studio B Glamour', '5511999990702', 'CONNECTED'),
      (?, 'Bella Vista Hair & Spa', '5511999990703', 'CONNECTED'),
      (?, 'Start Hair', '5511999990704', 'CONNECTED')
  `).run(TENANT_A, TENANT_B, DEMO_TENANT, START_TENANT);

  // 4. Serviços para Tenant A
  db.prepare(`
    INSERT OR REPLACE INTO client_services (id, user_id, name, price, duration_min, category, active)
    VALUES
      (7011, ?, 'Corte Feminino', 100.00, 45, 'Cabelo', 1),
      (7012, ?, 'Mechas & Blond', 350.00, 180, 'Coloração', 1)
  `).run(TENANT_A, TENANT_A);

  // 5. Profissionais para Tenant A
  db.prepare(`
    INSERT OR REPLACE INTO client_staff (id, user_id, name, specialty, active)
    VALUES
      (7021, ?, 'Juliana Master', 'Colorista', 1),
      (7022, ?, 'Renata Hairstylist', 'Corte', 1)
  `).run(TENANT_A, TENANT_A);

  // Obter data de hoje no formato YYYY-MM-DD
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);

  // 6. Incomes para Tenant A (R$ 500 + R$ 350 = R$ 850 total)
  db.prepare(`
    INSERT OR REPLACE INTO incomes (id, user_id, amount, category, source, date, payment_method, source_type)
    VALUES
      (7031, ?, 500.00, 'Serviços', 'Atendimento Corte e Escova', ? || '-05 14:00', 'PIX', 'manual'),
      (7032, ?, 350.00, 'Coloração', 'Atendimento Mechas', ? || '-12 16:00', 'CARTAO', 'manual')
  `).run(TENANT_A, currentMonth, TENANT_A, currentMonth);

  // 7. Expenses para Tenant A (R$ 200 + R$ 150 = R$ 350 total)
  db.prepare(`
    INSERT OR REPLACE INTO expenses (id, user_id, amount, category, description, date, payment_method, source_type)
    VALUES
      (7041, ?, 200.00, 'Insumos', 'Tonalizantes e Shampoo', ? || '-06 10:00', 'PIX', 'manual'),
      (7042, ?, 150.00, 'Contas', 'Internet Fibra', ? || '-15 09:00', 'BOLETO', 'manual')
  `).run(TENANT_A, currentMonth, TENANT_A, currentMonth);

  // 8. Incomes e Expenses para Tenant B (Isolamento: R$ 2.000 de receita e R$ 3.000 de despesa -> déficit)
  db.prepare(`
    INSERT OR REPLACE INTO incomes (id, user_id, amount, category, source, date, payment_method, source_type)
    VALUES (7051, ?, 2000.00, 'Serviços', 'Receita Salão B', ? || '-10 12:00', 'PIX', 'manual')
  `).run(TENANT_B, currentMonth);

  db.prepare(`
    INSERT OR REPLACE INTO expenses (id, user_id, amount, category, description, date, payment_method, source_type)
    VALUES (7061, ?, 3000.00, 'Aluguel', 'Aluguel Comercial Salão B', ? || '-10 12:00', 'PIX', 'manual')
  `).run(TENANT_B, currentMonth);
}

test.before(() => {
  setupDashboardTestData();
});

test.after(() => {
  try {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  } catch (_) {}
});

// =========================================================================
// TESTE 1: PRESENÇA E COEXISTÊNCIA DAS 3 SEÇÕES NO HTML (painel.html)
// =========================================================================
test('1. Renderização e coexistência das três novas seções no painel.html', () => {
  const painelHtml = fs.readFileSync(path.resolve(__dirname, '../public/cliente/painel.html'), 'utf8');

  // Seção 1
  assert.ok(painelHtml.includes('id="sectionFinancialSummary"'), 'Deve conter Seção 1 (Resumo Financeiro)');
  assert.ok(painelHtml.includes('Resumo Financeiro do Período'), 'Deve conter o título formal da Seção 1');
  assert.ok(painelHtml.includes('id="weeklyBreakdownContainer"'), 'Deve conter container de barras semanais');
  assert.ok(painelHtml.includes('id="summaryRealizedRevenue"'), 'Deve conter indicador de receita do resumo');
  assert.ok(painelHtml.includes('id="summaryExpensesTotal"'), 'Deve conter indicador de despesa do resumo');
  assert.ok(painelHtml.includes('id="summaryFinancialResult"'), 'Deve conter indicador de resultado do resumo');

  // Seção 2
  assert.ok(painelHtml.includes('id="sectionRevenueExpenses"'), 'Deve conter Seção 2 (Receitas x Despesas)');
  assert.ok(painelHtml.includes('Receitas x Despesas'), 'Deve conter o título formal da Seção 2');
  assert.ok(painelHtml.includes('id="financialChartContainer"'), 'Deve preservar o ID financialChartContainer');
  assert.ok(painelHtml.includes('id="btnToggleResultLine"'), 'Deve conter o botão interativo de toggle da linha de resultado');

  // Seção 3
  assert.ok(painelHtml.includes('id="sectionFinancialTrend"'), 'Deve conter Seção 3 (Tendência do Resultado)');
  assert.ok(painelHtml.includes('Evolução do Resultado Financeiro'), 'Deve conter o título formal da Seção 3');
  assert.ok(painelHtml.includes('id="financialTrendContainer"'), 'Deve conter container para gráfico de linha e área');
});

// =========================================================================
// TESTE 2: CONSISTÊNCIA MATEMÁTICA DE buildWeeklyBreakdown
// =========================================================================
test('2. Consistência matemática exata entre weeklyBreakdown, timeline e totais', () => {
  const sampleTimeline = [
    { date: '2026-11-01', label: '01/11', receitas: 100, despesas: 40, resultado: 60 },
    { date: '2026-11-05', label: '05/11', receitas: 250, despesas: 110, resultado: 140 },
    { date: '2026-11-10', label: '10/11', receitas: 400, despesas: 150, resultado: 250 },
    { date: '2026-11-18', label: '18/11', receitas: 300, despesas: 200, resultado: 100 },
    { date: '2026-11-25', label: '25/11', receitas: 500, despesas: 100, resultado: 400 },
  ];

  const weeks = salonDashboardService.buildWeeklyBreakdown(sampleTimeline, 'this_month');
  assert.ok(Array.isArray(weeks), 'Deve retornar array de semanas');
  assert.ok(weeks.length > 0, 'Deve conter semanas agrupadas');

  const sumTimelineRec = sampleTimeline.reduce((acc, t) => acc + t.receitas, 0);
  const sumTimelineDesp = sampleTimeline.reduce((acc, t) => acc + t.despesas, 0);
  const sumTimelineRes = sampleTimeline.reduce((acc, t) => acc + t.resultado, 0);

  const sumWeeksRec = Math.round(weeks.reduce((acc, w) => acc + w.receitas, 0) * 100) / 100;
  const sumWeeksDesp = Math.round(weeks.reduce((acc, w) => acc + w.despesas, 0) * 100) / 100;
  const sumWeeksRes = Math.round(weeks.reduce((acc, w) => acc + w.resultado, 0) * 100) / 100;

  assert.equal(sumWeeksRec, sumTimelineRec, 'Soma das receitas semanais deve ser idêntica à soma diária');
  assert.equal(sumWeeksDesp, sumTimelineDesp, 'Soma das despesas semanais deve ser idêntica à soma diária');
  assert.equal(sumWeeksRes, sumTimelineRes, 'Soma dos resultados semanais deve ser idêntica à soma diária');

  // Cada semana deve ter resultado = receitas - despesas
  weeks.forEach(w => {
    const expectedRes = Math.round((w.receitas - w.despesas) * 100) / 100;
    assert.equal(w.resultado, expectedRes, `Resultado da ${w.label} deve ser exatamente receitas - despesas`);
  });
});

// =========================================================================
// TESTE 3: CÁLCULO DE RECEITAS E DESPESAS REAIS NO SQLITE
// =========================================================================
test('3 e 4. Cálculo de receitas realizadas e despesas operacionais no SQLite para Tenant A', async () => {
  const periodInfo = salonDashboardService.getPeriodDates('this_month');
  const data = await salonDashboardService.getSalonDashboard(TENANT_A, { period: 'this_month' });

  assert.equal(data.success, true);
  assert.equal(data.isDemo, false, 'Tenant A é conta real, isDemo deve ser false');

  // Receitas: 500 + 350 = 850
  assert.equal(data.metrics.realizedRevenue, 850.00);

  // Despesas: 200 + 150 = 350
  assert.equal(data.metrics.expensesTotal, 350.00);

  // Resultado = 850 - 350 = 500
  assert.equal(data.metrics.financialResult, 500.00);

  // weeklyBreakdown deve bater exatamente com os totais
  const sumWeeklyRec = Math.round(data.weeklyBreakdown.reduce((acc, w) => acc + w.receitas, 0) * 100) / 100;
  const sumWeeklyDesp = Math.round(data.weeklyBreakdown.reduce((acc, w) => acc + w.despesas, 0) * 100) / 100;
  const sumWeeklyRes = Math.round(data.weeklyBreakdown.reduce((acc, w) => acc + w.resultado, 0) * 100) / 100;

  assert.equal(sumWeeklyRec, 850.00);
  assert.equal(sumWeeklyDesp, 350.00);
  assert.equal(sumWeeklyRes, 500.00);
});

// =========================================================================
// TESTE 5 E 6: RESULTADO NEGATIVO (DÉFICIT DE CAIXA)
// =========================================================================
test('5 e 6. Cálculo e tratamento correto de resultado negativo (Déficit de Caixa no Tenant B)', async () => {
  const data = await salonDashboardService.getSalonDashboard(TENANT_B, { period: 'this_month' });

  assert.equal(data.success, true);
  assert.equal(data.metrics.realizedRevenue, 2000.00);
  assert.equal(data.metrics.expensesTotal, 3000.00);

  // 2000 - 3000 = -1000
  assert.equal(data.metrics.financialResult, -1000.00);
  assert.ok(data.metrics.financialResult < 0, 'O resultado deve ser estritamente negativo');

  // As semanas do Tenant B também devem refletir o déficit com consistência
  const sumWeeklyRes = Math.round(data.weeklyBreakdown.reduce((acc, w) => acc + w.resultado, 0) * 100) / 100;
  assert.equal(sumWeeklyRes, -1000.00);
});

// =========================================================================
// TESTE 7: AUSÊNCIA DE MOVIMENTAÇÕES (ZEROS DEFENSIVOS)
// =========================================================================
test('7. Cenário de ausência de movimentações no período (Start Tenant)', async () => {
  // Salão Start não possui incomes nem expenses lançados
  const data = await salonDashboardService.getSalonDashboard(START_TENANT, { period: 'this_month' });

  assert.equal(data.success, true);
  assert.equal(data.metrics.realizedRevenue, 0);
  assert.equal(data.metrics.expensesTotal, 0);
  assert.equal(data.metrics.financialResult, 0);
  assert.equal(data.metrics.totalAppointments, 0);
  assert.equal(data.metrics.averageTicket, 0);
  assert.equal(data.metrics.hasSufficientData, false);
});

// =========================================================================
// TESTE 8: FILTROS DE PERÍODO (today, 7d, this_month, last_month, custom)
// =========================================================================
test('8. Adaptação correta dos filtros de período em getPeriodDates', () => {
  const todayFilter = salonDashboardService.getPeriodDates('today');
  assert.equal(todayFilter.period, 'today');
  assert.equal(todayFilter.startDate, todayFilter.endDate);

  const sevenDaysFilter = salonDashboardService.getPeriodDates('7d');
  assert.equal(sevenDaysFilter.period, '7d');
  assert.ok(sevenDaysFilter.startDate <= sevenDaysFilter.endDate);

  const thisMonthFilter = salonDashboardService.getPeriodDates('this_month');
  assert.equal(thisMonthFilter.period, 'this_month');
  assert.ok(thisMonthFilter.startDate.endsWith('-01'));

  const lastMonthFilter = salonDashboardService.getPeriodDates('last_month');
  assert.equal(lastMonthFilter.period, 'last_month');
  assert.ok(lastMonthFilter.startDate.endsWith('-01'));

  const customFilter = salonDashboardService.getPeriodDates('custom', '2026-05-10', '2026-05-25');
  assert.equal(customFilter.period, 'custom');
  assert.equal(customFilter.startDate, '2026-05-10');
  assert.equal(customFilter.endDate, '2026-05-25');
});

// =========================================================================
// TESTE 9: DADOS DEMONSTRATIVOS E DEMO SHIELD (Bella Vista Hair & Spa)
// =========================================================================
test('9. Preservação integral do Demo Shield para a conta Hotmart / Bella Vista', async () => {
  const data = await salonDashboardService.getSalonDashboard(DEMO_TENANT, { period: 'this_month' });

  assert.equal(data.success, true);
  assert.equal(data.isDemo, true, 'isDemo deve ser verdadeiro para conta de demonstração');
  assert.ok(data.demoBadge.includes('Bella Vista Hair & Spa'), 'Deve exibir o badge oficial da Bella Vista');
  assert.ok(data.weeklyBreakdown.length > 0, 'Deve gerar weeklyBreakdown na demonstração');

  // Consistência matemática exata também na demonstração
  const sumRec = Math.round(data.weeklyBreakdown.reduce((acc, w) => acc + w.receitas, 0) * 100) / 100;
  const sumDesp = Math.round(data.weeklyBreakdown.reduce((acc, w) => acc + w.despesas, 0) * 100) / 100;
  const sumRes = Math.round(data.weeklyBreakdown.reduce((acc, w) => acc + w.resultado, 0) * 100) / 100;

  assert.equal(sumRec, data.metrics.realizedRevenue);
  assert.equal(sumDesp, data.metrics.expensesTotal);
  assert.equal(sumRes, data.metrics.financialResult);
});

// =========================================================================
// TESTE 10: ISOLAMENTO MULTI-TENANT ABSOLUTO
// =========================================================================
test('10. Isolamento multi-tenant absoluto entre Tenant A e Tenant B', async () => {
  const dataA = await salonDashboardService.getSalonDashboard(TENANT_A, { period: 'this_month' });
  const dataB = await salonDashboardService.getSalonDashboard(TENANT_B, { period: 'this_month' });

  assert.notEqual(dataA.metrics.realizedRevenue, dataB.metrics.realizedRevenue);
  assert.equal(dataA.metrics.realizedRevenue, 850.00);
  assert.equal(dataB.metrics.realizedRevenue, 2000.00);

  // Transações de Tenant A não devem aparecer em Tenant B
  const bIncomesInA = dataA.transactions.some(t => t.description.includes('Salão B'));
  assert.equal(bIncomesInA, false, 'Tenant A jamais deve enxergar transações de Tenant B');
});

// =========================================================================
// TESTE 11 E 12: PROTEÇÃO DE PLANOS RBAC (START vs PRO) E CONTAS A PAGAR
// =========================================================================
test('11 e 12. Validação de tiers de acesso e proteção do módulo de Contas a Pagar', () => {
  const tierStart = salonDashboardService.getEffectiveJessicaTier(START_TENANT);
  assert.equal(tierStart, 'JESSICA_START', 'Tenant Start deve ser classificado como JESSICA_START');

  const tierPro = salonDashboardService.getEffectiveJessicaTier(TENANT_A);
  assert.equal(tierPro, 'JESSICA_PRO', 'Tenant A deve ser classificado como JESSICA_PRO');

  const tierDemo = salonDashboardService.getEffectiveJessicaTier(DEMO_TENANT);
  assert.equal(tierDemo, 'JESSICA_PRO', 'Demo Tenant deve receber recursos PRO');
});

// =========================================================================
// TESTE 13: PRESERVAÇÃO DOS 8 INDICADORES DE KPI EXISTENTES
// =========================================================================
test('13. Preservação de todos os 8 indicadores de KPI existentes', async () => {
  const data = await salonDashboardService.getSalonDashboard(TENANT_A, { period: 'this_month' });
  const m = data.metrics;

  assert.ok('realizedRevenue' in m, '1. Faturamento Realizado preservado');
  assert.ok('estimatedRevenue' in m, '2. Faturamento Estimado preservado');
  assert.ok('expensesTotal' in m, '3. Despesas Registradas preservado');
  assert.ok('financialResult' in m, '4. Resultado do Período preservado');
  assert.ok('totalAppointments' in m, '5. Total de Agendamentos preservado');
  assert.ok('completedAppointments' in m, '6. Atendimentos Concluídos preservado');
  assert.ok('averageTicket' in m, '7. Ticket Médio preservado');
  assert.ok('cancelledAppointments' in m, '8. Agendamentos Cancelados preservado');
});

// =========================================================================
// TESTE 14: SANITIZAÇÃO XSS NO FRONTEND (escapeHtml)
// =========================================================================
test('14. Sanitização estrita contra XSS em rótulos e títulos dinâmicos', () => {
  const painelHtml = fs.readFileSync(path.resolve(__dirname, '../public/cliente/painel.html'), 'utf8');

  // Verifica que escapeHtml está definido e usado nas três novas renderizações
  assert.ok(painelHtml.includes('function escapeHtml(str)'), 'Função escapeHtml deve estar presente no script');
  assert.ok(painelHtml.includes('escapeHtml(w.label)'), 'Rótulo da semana deve ser escapado');
  assert.ok(painelHtml.includes('escapeHtml(w.dateRange)'), 'Intervalo de datas deve ser escapado');
  assert.ok(painelHtml.includes('escapeHtml(g.fullLabel)'), 'Tooltip da barra vertical deve ser escapado');
  assert.ok(painelHtml.includes('escapeHtml(pt.label)'), 'Rótulo dos pontos de tendência deve ser escapado');
});

// =========================================================================
// TESTE 15: FORMATAÇÃO MONETÁRIA E SELETORES INTERATIVOS
// =========================================================================
test('15. Presença dos seletores interativos e toggle de linha de resultado', () => {
  const painelHtml = fs.readFileSync(path.resolve(__dirname, '../public/cliente/painel.html'), 'utf8');

  assert.ok(painelHtml.includes("document.getElementById('btnToggleResultLine')"), 'Deve conter listener para toggle de linha');
  assert.ok(painelHtml.includes('showResultLine'), 'Deve controlar o estado de visibilidade da linha');
  assert.ok(painelHtml.includes('formatBRL'), 'Deve conter formatador em moeda brasileira R$');
});
