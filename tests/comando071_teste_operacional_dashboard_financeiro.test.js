'use strict';

/**
 * ==============================================================================
 * RAIA AGENTES — SUÍTE DE TESTES OPERACIONAIS HERMÉTICA (COMANDO 071)
 * Dashboard Financeiro & Módulo Contas a Pagar Jéssica Pró
 *
 * Padrão Hermético Obrigatório:
 * - Banco descartável único em os.tmpdir() (sem tocar data/assistant.db)
 * - Módulos nativos node:test e node:assert/strict
 * - Sem dependências externas de rede
 * - Testes de regras de negócio, persistência contábil, Demo Shield e Multi-Tenant IDOR
 * ==============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// 1. ISOLAMENTO MANDATÓRIO DE BANCO DE DADOS
const tmpDbPath = path.join(os.tmpdir(), `test-comando071-dashboard-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.DB_PATH = tmpDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.ADMIN_PASSWORD = 'TestMasterPassword123!@#';
process.env.ADMIN_API_KEY = 'test_admin_api_key_secret_least_privilege_123';
process.env.SESSION_SECRET = 'test_session_secret_32_chars_long_entropy!';
process.env.CLIENT_AUTH_SECRET = 'test_client_secret_32_chars_long_entropy!';
process.env.DEMO_ACCOUNT_EMAIL = 'homologacao.hotmart@raiaagentes.com.br';
process.env.DEMO_ACCOUNT_PASSWORD = 'DemoPassword123#';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.PORT = '0';
process.env.STAGING_PROTECTION_ENABLED = 'false';

const db = require('../src/database/db');
const salonDashboardService = require('../src/services/salonDashboardService');
const { app } = require('../src/server/app');

// Helpers de datas no fuso America/Sao_Paulo (UTC-3)
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

const todayStr = getSaoPauloDate();
const tomorrowStr = addDays(todayStr, 1);
const yesterdayStr = addDays(todayStr, -1);

let server;
let baseUrl;

// Identificadores dos Tenants de Teste
let userProA = null;
let userProB = null;
let userDemo = null;
let userStart = null;

test.before(async () => {
  // Iniciar servidor Express em porta efêmera local
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Identificar produtos e planos do catálogo nativo
  const jessica = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
  assert.ok(jessica, 'Produto JESSICA deve existir no banco semeado');
  const planPro = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'PRO'").get(jessica.id);
  const planStart = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'START'").get(jessica.id);
  assert.ok(planPro, 'Plano PRO da Jéssica deve existir');
  assert.ok(planStart, 'Plano START da Jéssica deve existir');

  // 1. Tenant Exclusivo de Testes Staging (Jéssica Pró - Usuário A)
  const tokenProA = 'sess_pro_user_a_' + crypto.randomBytes(8).toString('hex');
  const resA = db.prepare(`
    INSERT INTO users (
      email, phone_number, name, role, is_demo, plan_tier, subscription_status,
      paid_until, session_token, session_expires_at
    ) VALUES (?, ?, ?, 'CLIENT', 0, 'JESSICA_PRO', 'ACTIVE', '2099-12-31T23:59:59.000Z', ?, datetime('now', '+30 days'))
  `).run('staging.test.financeiro@raiaagentes.internal', '5511999990071', 'Salão Teste Jéssica Pró', tokenProA);
  userProA = { id: resA.lastInsertRowid, email: 'staging.test.financeiro@raiaagentes.internal', token: tokenProA };

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_status)
    VALUES (?, ?, ?, 'DISCONNECTED')
  `).run(userProA.id, 'Salão Financeiro Staging A', '5511999990071');

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents,
      billing_cycle, paid_until, access_expires_at
    ) VALUES (?, ?, ?, 'MANUAL', 'MANUAL', 'ACTIVE', 14900, 'MONTHLY', '2099-12-31T23:59:59.000Z', '2099-12-31T23:59:59.000Z')
  `).run(userProA.id, jessica.id, planPro.id);

  // 2. Tenant Multi-Tenant B (Jéssica Pró - Usuário B para testes de IDOR)
  const tokenProB = 'sess_pro_user_b_' + crypto.randomBytes(8).toString('hex');
  const resB = db.prepare(`
    INSERT INTO users (
      email, phone_number, name, role, is_demo, plan_tier, subscription_status,
      paid_until, session_token, session_expires_at
    ) VALUES (?, ?, ?, 'CLIENT', 0, 'JESSICA_PRO', 'ACTIVE', '2099-12-31T23:59:59.000Z', ?, datetime('now', '+30 days'))
  `).run('tenant.b.financeiro@raiaagentes.internal', '5511999990072', 'Salão B Concorrente', tokenProB);
  userProB = { id: resB.lastInsertRowid, email: 'tenant.b.financeiro@raiaagentes.internal', token: tokenProB };

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_status)
    VALUES (?, ?, ?, 'DISCONNECTED')
  `).run(userProB.id, 'Salão Concorrente B', '5511999990072');

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents,
      billing_cycle, paid_until, access_expires_at
    ) VALUES (?, ?, ?, 'MANUAL', 'MANUAL', 'ACTIVE', 14900, 'MONTHLY', '2099-12-31T23:59:59.000Z', '2099-12-31T23:59:59.000Z')
  `).run(userProB.id, jessica.id, planPro.id);

  // 3. Tenant Demo Shield (Conta Demo: is_demo = 1)
  const tokenDemo = 'sess_demo_shield_' + crypto.randomBytes(8).toString('hex');
  const resDemo = db.prepare(`
    INSERT INTO users (
      email, phone_number, name, role, is_demo, plan_tier, subscription_status,
      paid_until, session_token, session_expires_at
    ) VALUES (?, ?, ?, 'CLIENT', 1, 'JESSICA_PRO', 'ACTIVE', '2099-12-31T23:59:59.000Z', ?, datetime('now', '+30 days'))
  `).run('demo.shield.financeiro@raiaagentes.internal', '5511999990073', 'Conta Demo Shield', tokenDemo);
  userDemo = { id: resDemo.lastInsertRowid, email: 'demo.shield.financeiro@raiaagentes.internal', token: tokenDemo };

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_status)
    VALUES (?, ?, ?, 'DISCONNECTED')
  `).run(userDemo.id, 'Salão Demo Shield', '5511999990073');

  // 4. Tenant Plano Start (Sem acesso a Contas a Pagar Pró)
  const tokenStart = 'sess_plan_start_' + crypto.randomBytes(8).toString('hex');
  const resStart = db.prepare(`
    INSERT INTO users (
      email, phone_number, name, role, is_demo, plan_tier, subscription_status,
      paid_until, session_token, session_expires_at
    ) VALUES (?, ?, ?, 'CLIENT', 0, 'JESSICA_START', 'ACTIVE', '2099-12-31T23:59:59.000Z', ?, datetime('now', '+30 days'))
  `).run('start.plan.financeiro@raiaagentes.internal', '5511999990074', 'Salão Start Básico', tokenStart);
  userStart = { id: resStart.lastInsertRowid, email: 'start.plan.financeiro@raiaagentes.internal', token: tokenStart };

  db.prepare(`
    INSERT INTO client_salons (user_id, salon_name, phone, whatsapp_status)
    VALUES (?, ?, ?, 'DISCONNECTED')
  `).run(userStart.id, 'Salão Start Básico', '5511999990074');

  db.prepare(`
    INSERT INTO customer_subscriptions (
      user_id, product_id, plan_id, origin, gateway, status, price_cents,
      billing_cycle, paid_until, access_expires_at
    ) VALUES (?, ?, ?, 'MANUAL', 'MANUAL', 'ACTIVE', 8900, 'MONTHLY', '2099-12-31T23:59:59.000Z', '2099-12-31T23:59:59.000Z')
  `).run(userStart.id, jessica.id, planStart.id);
});

test.after(() => {
  if (server) server.close();
  try {
    if (db && typeof db.close === 'function') db.close();
  } catch (_) {}
  try {
    if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
    if (fs.existsSync(`${tmpDbPath}-shm`)) fs.unlinkSync(`${tmpDbPath}-shm`);
    if (fs.existsSync(`${tmpDbPath}-wal`)) fs.unlinkSync(`${tmpDbPath}-wal`);
  } catch (_) {}
});

// Helper para chamadas HTTP locais
async function apiRequest(method, endpoint, token, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: json };
}

// ==============================================================================
// TESTES OPERACIONAIS
// ==============================================================================

test('1. Isolamento Mandatório e Configuração de Tenants Staging', async (t) => {
  await t.test('Garante que o banco operacional assistant.db NÃO foi tocado', () => {
    assert.strictEqual(process.env.DB_PATH, tmpDbPath);
    assert.strictEqual(tmpDbPath.includes('data/assistant.db'), false);
    assert.ok(fs.existsSync(tmpDbPath), 'Arquivo temporário de banco deve existir');
  });

  await t.test('Garante criação correta dos tenants isolados sem afetar outros registros', () => {
    assert.ok(userProA.id > 1, 'Tenant A deve possuir ID isolado');
    assert.ok(userProB.id > userProA.id, 'Tenant B deve possuir ID isolado');

    const checkA = db.prepare('SELECT is_demo, plan_tier, subscription_status FROM users WHERE id = ?').get(userProA.id);
    assert.strictEqual(checkA.is_demo, 0);
    assert.strictEqual(checkA.plan_tier, 'JESSICA_PRO');
    assert.strictEqual(checkA.subscription_status, 'ACTIVE');

    const salonA = db.prepare('SELECT whatsapp_status FROM client_salons WHERE user_id = ?').get(userProA.id);
    assert.strictEqual(salonA.whatsapp_status, 'DISCONNECTED');

    const tierA = salonDashboardService.getEffectiveJessicaTier(userProA.id);
    assert.strictEqual(tierA, 'JESSICA_PRO');

    const tierStart = salonDashboardService.getEffectiveJessicaTier(userStart.id);
    assert.strictEqual(tierStart, 'JESSICA_START');
  });
});

test('2. Movimentações Financeiras Reais e Dashboard do Salão', async (t) => {
  await t.test('Registrar receita real de R$ 100,00 e despesa real de R$ 30,00', () => {
    const income = salonDashboardService.recordTransaction(userProA.id, {
      type: 'INCOME',
      amount: 100.00,
      category: 'Serviços',
      description: 'Corte e Escova Modeladora',
      paymentMethod: 'Pix',
      date: `${todayStr}T14:30:00.000Z`,
    });
    assert.ok(income.id, 'Receita deve ser gravada e retornar ID');
    assert.strictEqual(Number(income.amount), 100.00);

    const expense = salonDashboardService.recordTransaction(userProA.id, {
      type: 'EXPENSE',
      amount: 30.00,
      category: 'Insumos',
      description: 'Shampoo Neutro Especial',
      paymentMethod: 'Pix',
      date: `${todayStr}T15:00:00.000Z`,
    });
    assert.ok(expense.id, 'Despesa deve ser gravada e retornar ID');
    assert.strictEqual(Number(expense.amount), 30.00);
  });

  await t.test('Validar getSalonDashboard consolidando receitas, despesas e resultado', async () => {
    const dashboard = await salonDashboardService.getSalonDashboard(userProA.id, { period: 'this_month' });
    assert.strictEqual(dashboard.success, true);
    assert.strictEqual(dashboard.isDemo, false);

    // Métricas Financeiras
    assert.strictEqual(dashboard.metrics.realizedRevenue, 100.00, 'Receita realizada deve ser exatamente R$ 100,00');
    assert.strictEqual(dashboard.metrics.expensesTotal, 30.00, 'Despesas totais devem ser exatamente R$ 30,00');
    assert.strictEqual(dashboard.metrics.financialResult, 70.00, 'Resultado financeiro deve ser exatamente R$ 70,00 (100 - 30)');

    // Extrato de Transações Recentes
    assert.ok(Array.isArray(dashboard.transactions), 'Transações devem ser um array');
    assert.strictEqual(dashboard.transactions.length, 2, 'Deve conter exatamente 2 transações registradas');

    const txIncome = dashboard.transactions.find(t => t.type === 'INCOME');
    const txExpense = dashboard.transactions.find(t => t.type === 'EXPENSE');

    assert.ok(txIncome, 'Transação de receita deve estar presente no extrato');
    assert.strictEqual(txIncome.amount, 100.00);
    assert.strictEqual(txIncome.category, 'Serviços');

    assert.ok(txExpense, 'Transação de despesa deve estar presente no extrato');
    assert.strictEqual(txExpense.amount, -30.00);
    assert.strictEqual(txExpense.category, 'Insumos');

    // Validação da Timeline Diária
    assert.ok(Array.isArray(dashboard.timeline), 'Timeline deve ser um array');
    const todayPoint = dashboard.timeline.find(p => p.date === todayStr);
    assert.ok(todayPoint, 'Timeline deve conter ponto para o dia de hoje');
    assert.strictEqual(todayPoint.receitas, 100.00);
    assert.strictEqual(todayPoint.despesas, 30.00);
    assert.strictEqual(todayPoint.resultado, 70.00);

    // Validação da Quebra Semanal (Weekly Breakdown)
    assert.ok(Array.isArray(dashboard.weeklyBreakdown), 'Weekly Breakdown deve ser um array');
    const totalWeeklyRec = dashboard.weeklyBreakdown.reduce((acc, w) => acc + w.receitas, 0);
    const totalWeeklyDesp = dashboard.weeklyBreakdown.reduce((acc, w) => acc + w.despesas, 0);
    assert.strictEqual(Math.round(totalWeeklyRec * 100) / 100, 100.00, 'Soma das semanas deve ser igual ao faturamento');
    assert.strictEqual(Math.round(totalWeeklyDesp * 100) / 100, 30.00, 'Soma das semanas deve ser igual às despesas');
  });

  await t.test('Validar persistência e idempotência ao chamar getSalonDashboard repetidamente', async () => {
    const dash1 = await salonDashboardService.getSalonDashboard(userProA.id, { period: 'this_month' });
    const dash2 = await salonDashboardService.getSalonDashboard(userProA.id, { period: 'this_month' });

    assert.strictEqual(dash1.metrics.realizedRevenue, dash2.metrics.realizedRevenue);
    assert.strictEqual(dash1.metrics.expensesTotal, dash2.metrics.expensesTotal);
    assert.strictEqual(dash1.metrics.financialResult, dash2.metrics.financialResult);
    assert.strictEqual(dash1.transactions.length, dash2.transactions.length);
  });

  await t.test('Validar respeito rigoroso aos filtros de período', async () => {
    // Filtro 'today' (contém as movimentações de hoje)
    const dashToday = await salonDashboardService.getSalonDashboard(userProA.id, { period: 'today' });
    assert.strictEqual(dashToday.metrics.realizedRevenue, 100.00);
    assert.strictEqual(dashToday.metrics.expensesTotal, 30.00);

    // Filtro 'last_month' (não deve conter as movimentações deste mês)
    const dashLastMonth = await salonDashboardService.getSalonDashboard(userProA.id, { period: 'last_month' });
    assert.strictEqual(dashLastMonth.metrics.realizedRevenue, 0.00);
    assert.strictEqual(dashLastMonth.metrics.expensesTotal, 0.00);
    assert.strictEqual(dashLastMonth.metrics.financialResult, 0.00);

    // Filtro 'custom' com intervalo no passado
    const dashPastCustom = await salonDashboardService.getSalonDashboard(userProA.id, {
      period: 'custom',
      startDate: '2020-01-01',
      endDate: '2020-01-31',
    });
    assert.strictEqual(dashPastCustom.metrics.realizedRevenue, 0.00);
    assert.strictEqual(dashPastCustom.metrics.expensesTotal, 0.00);
    assert.strictEqual(dashPastCustom.metrics.financialResult, 0.00);
  });
});

test('3. Gestão Completa de Contas a Pagar (Scheduled Payments)', async (t) => {
  let billUpcoming = null;
  let billOverdue = null;

  await t.test('Inserir conta de R$ 50,00 pendente (vencimento amanhã)', () => {
    const created = salonDashboardService.createBill(userProA.id, {
      title: 'Energia Elétrica Enel',
      amount: 50.00,
      dueDate: tomorrowStr,
      category: 'Contas Básicas',
      installments: 1,
    });
    assert.strictEqual(created.length, 1);
    billUpcoming = created[0];
    assert.strictEqual(billUpcoming.amount, 50.00);
    assert.strictEqual(billUpcoming.status, 'PENDING');
  });

  await t.test('Inserir conta de R$ 25,00 pendente vencida (vencimento ontem)', () => {
    const created = salonDashboardService.createBill(userProA.id, {
      title: 'Taxa de Água Sabesp Vencida',
      amount: 25.00,
      dueDate: yesterdayStr,
      category: 'Contas Básicas',
      installments: 1,
    });
    assert.strictEqual(created.length, 1);
    billOverdue = created[0];
    assert.strictEqual(billOverdue.amount, 25.00);
    assert.strictEqual(billOverdue.status, 'PENDING');
  });

  await t.test('Validar classificação de vencimento no dashboard (overdue vs upcoming)', async () => {
    const dashboard = await salonDashboardService.getSalonDashboard(userProA.id, { isPro: true });
    assert.ok(dashboard.bills, 'Módulo de contas a pagar deve estar preenchido para Jéssica Pró');
    assert.strictEqual(dashboard.bills.pendingCount, 2, 'Devem existir 2 contas pendentes');
    assert.strictEqual(dashboard.bills.pendingTotal, 75.00, 'Total pendente deve ser R$ 75,00 (50 + 25)');

    assert.strictEqual(dashboard.bills.overdueCount, 1, 'Deve conter 1 conta vencida');
    assert.strictEqual(dashboard.bills.overdueBills[0].id, billOverdue.id);
    assert.strictEqual(dashboard.bills.upcomingBills[0].id, billUpcoming.id);
  });

  await t.test('Testar liquidação / baixa da conta de energia (markBillAsPaid)', async () => {
    const payResult = salonDashboardService.markBillAsPaid(userProA.id, billUpcoming.id);
    assert.strictEqual(payResult.bill.status, 'PAID');
    assert.ok(payResult.bill.paid_at, 'Data de quitação paid_at deve estar preenchida');

    // Despesa correspondente criada automaticamente no caixa
    assert.ok(payResult.expense, 'Despesa deve ser gerada automaticamente');
    assert.strictEqual(payResult.expense.amount, 50.00);
    assert.strictEqual(payResult.expense.sourceType, 'dashboard_bill');

    // Verificar atualização instantânea do Dashboard
    const dashboard = await salonDashboardService.getSalonDashboard(userProA.id, { isPro: true });
    assert.strictEqual(dashboard.metrics.realizedRevenue, 100.00);
    assert.strictEqual(dashboard.metrics.expensesTotal, 80.00, 'Despesas totais sobem para R$ 80,00 (30 anterior + 50 da conta)');
    assert.strictEqual(dashboard.metrics.financialResult, 20.00, 'Resultado ajustado para R$ 20,00 (100 - 80)');

    assert.strictEqual(dashboard.bills.paidCount, 1, 'Deve constar 1 conta quitada');
    assert.strictEqual(dashboard.bills.paidTotal, 50.00);
    assert.strictEqual(dashboard.bills.upcomingBills.length, 0, 'Upcoming bills de energia deve estar liquidada');
  });

  await t.test('Testar proteção contra pagamento duplicado', () => {
    const secondPayResult = salonDashboardService.markBillAsPaid(userProA.id, billUpcoming.id);
    assert.strictEqual(secondPayResult.bill.status, 'PAID');
    assert.strictEqual(secondPayResult.message, 'Esta conta já foi marcada como quitada anteriormente.');

    // Contar despesas geradas para esta conta
    const billExpenses = db.prepare(`
      SELECT COUNT(*) as count FROM expenses
      WHERE user_id = ? AND source_type = 'dashboard_bill' AND description = ?
    `).get(userProA.id, `Pagamento de Conta: ${billUpcoming.title}`);
    assert.strictEqual(billExpenses.count, 1, 'Não deve criar despesa duplicada');
  });

  await t.test('Testar bloqueio de exclusão de conta quitada (auditoria contábil)', () => {
    assert.throws(
      () => salonDashboardService.deleteBill(userProA.id, billUpcoming.id),
      /Contas já quitadas não podem ser excluídas para preservar a rastreabilidade contábil/
    );

    // Verificar que a conta quitada ainda existe no banco
    const checkPaid = db.prepare('SELECT id, status FROM scheduled_payments WHERE id = ?').get(billUpcoming.id);
    assert.ok(checkPaid, 'Conta quitada deve permanecer salva no banco');
    assert.strictEqual(checkPaid.status, 'PAID');
  });

  await t.test('Testar exclusão de conta pendente com sucesso', async () => {
    const delResult = salonDashboardService.deleteBill(userProA.id, billOverdue.id);
    assert.ok(delResult.changes > 0, 'Exclusão de conta pendente deve afetar linha no banco');

    const checkOverdue = db.prepare('SELECT id FROM scheduled_payments WHERE id = ?').get(billOverdue.id);
    assert.strictEqual(checkOverdue, undefined, 'Conta vencida excluída não deve mais existir');

    const dashboard = await salonDashboardService.getSalonDashboard(userProA.id, { isPro: true });
    assert.strictEqual(dashboard.bills.overdueCount, 0, 'Contagem de contas vencidas deve zerar');
    assert.strictEqual(dashboard.bills.pendingCount, 0, 'Contagem de contas pendentes deve zerar');
  });
});

test('4. Validação de Segurança Demo Shield em Rotas de Escrita', async (t) => {
  await t.test('Demo Shield bloqueia criação de conta (POST /api/cliente/pro/bills)', async () => {
    const res = await apiRequest('POST', '/api/cliente/pro/bills', userDemo.token, {
      title: 'Tentativa Demo de Conta',
      amount: 150.00,
      dueDate: tomorrowStr,
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.isDemoBlocked, true);
    assert.strictEqual(res.body.code, 'DEMO_MODE_RESTRICTED');

    const count = db.prepare('SELECT COUNT(*) as c FROM scheduled_payments WHERE user_id = ?').get(userDemo.id).c;
    assert.strictEqual(count, 0, 'Nenhuma conta deve ser salva no banco para conta demo');
  });

  await t.test('Demo Shield bloqueia quitação de conta (PATCH /api/cliente/pro/bills/:id/pay)', async () => {
    const res = await apiRequest('PATCH', '/api/cliente/pro/bills/999/pay', userDemo.token);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.isDemoBlocked, true);
    assert.strictEqual(res.body.code, 'DEMO_MODE_RESTRICTED');
  });

  await t.test('Demo Shield bloqueia exclusão de conta (DELETE /api/cliente/pro/bills/:id)', async () => {
    const res = await apiRequest('DELETE', '/api/cliente/pro/bills/999', userDemo.token);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.isDemoBlocked, true);
    assert.strictEqual(res.body.code, 'DEMO_MODE_RESTRICTED');
  });

  await t.test('Demo Shield bloqueia movimentação financeira manual (POST /api/cliente/pro/transactions)', async () => {
    const res = await apiRequest('POST', '/api/cliente/pro/transactions', userDemo.token, {
      type: 'INCOME',
      amount: 200.00,
      category: 'Serviços',
      description: 'Tentativa Demo Receita',
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.isDemoBlocked, true);
    assert.strictEqual(res.body.code, 'DEMO_MODE_RESTRICTED');

    const incCount = db.prepare('SELECT COUNT(*) as c FROM incomes WHERE user_id = ?').get(userDemo.id).c;
    assert.strictEqual(incCount, 0, 'Nenhuma receita demo gravada');
    const expCount = db.prepare('SELECT COUNT(*) as c FROM expenses WHERE user_id = ?').get(userDemo.id).c;
    assert.strictEqual(expCount, 0, 'Nenhuma despesa demo gravada');
  });
});

test('5. Autorização de Plano & Isolamento Multi-Tenant IDOR', async (t) => {
  await t.test('Usuário no plano Jéssica Start é bloqueado em /pro/bills (proExclusive)', async () => {
    const resGet = await apiRequest('GET', '/api/cliente/pro/bills', userStart.token);
    assert.strictEqual(resGet.status, 403);
    assert.strictEqual(resGet.body.proExclusive, true);

    const resPost = await apiRequest('POST', '/api/cliente/pro/bills', userStart.token, {
      title: 'Tentativa Start',
      amount: 50.00,
      dueDate: tomorrowStr,
    });
    assert.strictEqual(resPost.status, 403);
    assert.strictEqual(resPost.body.proExclusive, true);
  });

  await t.test('Multi-Tenant IDOR: Usuário B não consegue acessar, liquidar ou excluir contas do Usuário A', async () => {
    // Criar nova conta legítima para Usuário A
    const createdA = salonDashboardService.createBill(userProA.id, {
      title: 'Aluguel Salão Usuário A',
      amount: 1200.00,
      dueDate: tomorrowStr,
      category: 'Imóvel',
    });
    const billIdA = createdA[0].id;

    // 1. Usuário B tenta liquidar conta de A via API HTTP
    const resPay = await apiRequest('PATCH', `/api/cliente/pro/bills/${billIdA}/pay`, userProB.token);
    assert.strictEqual(resPay.status, 400);
    assert.strictEqual(resPay.body.success, false);

    // 2. Usuário B tenta excluir conta de A via API HTTP
    const resDel = await apiRequest('DELETE', `/api/cliente/pro/bills/${billIdA}`, userProB.token);
    assert.strictEqual(resDel.status, 400);
    assert.strictEqual(resDel.body.success, false);

    // 3. Validação direta via Service com asserção de exceção
    assert.throws(
      () => salonDashboardService.markBillAsPaid(userProB.id, billIdA),
      /Conta agendada não encontrada ou não pertence a este usuário/
    );

    assert.throws(
      () => salonDashboardService.deleteBill(userProB.id, billIdA),
      /Conta não encontrada ou permissão negada/
    );

    // 4. Usuário B consulta suas contas via API e NÃO visualiza a conta de A
    const resListB = await apiRequest('GET', '/api/cliente/pro/bills', userProB.token);
    assert.strictEqual(resListB.status, 200);
    const billsB = resListB.body.bills?.upcomingBills || [];
    const hasBillA = billsB.some(b => b.id === billIdA);
    assert.strictEqual(hasBillA, false, 'Usuário B não deve enxergar contas de A no extrato');

    // 5. Garantir que a conta de A continua intacta como PENDING
    const checkA = db.prepare('SELECT id, status, user_id FROM scheduled_payments WHERE id = ?').get(billIdA);
    assert.strictEqual(checkA.status, 'PENDING');
    assert.strictEqual(checkA.user_id, userProA.id);
  });
});
