/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICA: COMANDO 071.1
 * 
 * Foco: Idempotência Financeira Estrita por Identificador Único (scheduled_payment_id),
 *       Multi-tenant Isolation, Defesa Anti-IDOR, Rollback Atômico e Demo Shield.
 * 
 * Padrão Hermético Obrigatório:
 * - Banco SQLite descartável único em os.tmpdir() com destruição em test.after().
 * - Módulos nativos node:test e node:assert/strict (Node 22).
 * - Sem dependências externas de rede.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

// 1. Configuração Hermética de Ambiente ANTES de carregar qualquer módulo da aplicação
const tmpDbPath = path.join(os.tmpdir(), `raia_test_071_1_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tmpDbPath;
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.HOMOLOGACAO = 'true';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.WA_SESSIONS_DISABLED = 'true';
process.env.ADMIN_PASSWORD = 'TestMasterPassword123!';
process.env.JWT_SECRET = 'test-jwt-secret-very-secure-32chars';
process.env.SESSION_SECRET = 'test-session-secret-very-secure-32chars';
process.env.CLIENT_AUTH_SECRET = 'test-client-secret-very-secure-32chars';
process.env.ASAAS_ENV = 'sandbox';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ASAAS_API_KEY = 'mock_asaas_api_key_for_testing';

// 2. Módulos do Sistema
const db = require('../src/database/db');
const salonDashboardService = require('../src/services/salonDashboardService');
const financeService = require('../src/services/financeService');
const { app } = require('../src/server/app');

// Helpers de Data
function getFutureDate(days = 1) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

test.describe('COMANDO 071.1 — Idempotência Financeira & Identificador Único', () => {
  let server = null;
  let baseUrl = '';

  // Usuários de Teste
  let userAId = null;
  let userBId = null;
  let demoUserId = null;

  const tokenUserA = 'session_token_user_a_071_1_test_ok';
  const tokenUserB = 'session_token_user_b_071_1_test_ok';
  const tokenDemo = 'session_token_demo_user_071_1_test_ok';

  test.before(async () => {
    // 1. Inicializar Servidor Express Efêmero em porta dinâmica (0)
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // 2. Cadastrar Usuários Multi-Tenant com Plano Jéssica Pró Ativo
    const futureExpires = '2099-12-31T23:59:59.000Z';

    const insertUserStmt = db.prepare(`
      INSERT INTO users (
        phone_number, name, email, role, plan, plan_tier, subscription_status,
        paid_until, session_token, session_expires_at, is_demo
      ) VALUES (?, ?, ?, 'USER', 'JESSICA_PRO', 'JESSICA_PRO', 'ACTIVE', ?, ?, ?, ?)
    `);

    // Salão A
    const resA = insertUserStmt.run(
      '5511988880001',
      'Salão Elegance A',
      'salao.a@teste.com.br',
      futureExpires,
      tokenUserA,
      futureExpires,
      0
    );
    userAId = Number(resA.lastInsertRowid);

    // Salão B
    const resB = insertUserStmt.run(
      '5511988880002',
      'Salão Studio B',
      'salao.b@teste.com.br',
      futureExpires,
      tokenUserB,
      futureExpires,
      0
    );
    userBId = Number(resB.lastInsertRowid);

    // Usuário Homologação / Demo Shield
    const resDemo = insertUserStmt.run(
      '5511988880003',
      'Conta Demo Homologação',
      'demo.hotmart@teste.com.br',
      futureExpires,
      tokenDemo,
      futureExpires,
      1
    );
    demoUserId = Number(resDemo.lastInsertRowid);

    // Cadastrar Salões Vinculados
    db.prepare('INSERT INTO client_salons (user_id, salon_name) VALUES (?, ?)').run(userAId, 'Salão Elegance A');
    db.prepare('INSERT INTO client_salons (user_id, salon_name) VALUES (?, ?)').run(userBId, 'Salão Studio B');
    db.prepare('INSERT INTO client_salons (user_id, salon_name) VALUES (?, ?)').run(demoUserId, 'Salão Demo Homologação');
  });

  test.after(() => {
    // Limpeza de recursos
    if (server && server.close) {
      server.close();
    }
    try {
      db.close();
    } catch (_) {}

    // Remover banco SQLite temporário
    if (fs.existsSync(tmpDbPath)) {
      try {
        fs.unlinkSync(tmpDbPath);
      } catch (_) {}
    }
  });

  // =========================================================================
  // CENÁRIO F: MIGRAÇÃO E SCHEMA DO BANCO DE DADOS
  // =========================================================================
  test('f) Schema Validation: Coluna scheduled_payment_id e índices devem existir em expenses', () => {
    const tableInfo = db.prepare('PRAGMA table_info(expenses)').all();
    const hasScheduledCol = tableInfo.some(col => col.name === 'scheduled_payment_id' && col.type.toUpperCase() === 'INTEGER');
    assert.strictEqual(hasScheduledCol, true, 'A coluna scheduled_payment_id deve existir na tabela expenses como INTEGER');

    const indexList = db.prepare('PRAGMA index_list(expenses)').all();
    const hasIndexSingle = indexList.some(idx => idx.name === 'idx_expenses_scheduled_payment');
    const hasIndexComposite = indexList.some(idx => idx.name === 'idx_expenses_user_scheduled');

    assert.strictEqual(hasIndexSingle, true, 'O índice idx_expenses_scheduled_payment deve existir');
    assert.strictEqual(hasIndexComposite, true, 'O índice composto idx_expenses_user_scheduled deve existir');
  });

  // =========================================================================
  // CENÁRIO A: CONTAS HOMÔNIMAS COM VALORES DISTINTOS NO MESMO SALÃO
  // =========================================================================
  test('a) Duas contas diferentes com o mesmo título e valores distintos geram duas despesas ao serem quitadas', async () => {
    // 1. Cadastrar Conta 1: "Fornecedor Cosméticos", R$ 80,00
    const [bill1] = salonDashboardService.createBill(userAId, {
      title: 'Fornecedor Cosméticos',
      amount: 80.00,
      dueDate: getFutureDate(1),
      category: 'Produtos',
      installments: 1,
    });
    assert.ok(bill1.id, 'Conta 1 deve ser criada com ID válido');
    assert.strictEqual(bill1.amount, 80.00);

    // 2. Cadastrar Conta 2: "Fornecedor Cosméticos", R$ 120,00
    const [bill2] = salonDashboardService.createBill(userAId, {
      title: 'Fornecedor Cosméticos',
      amount: 120.00,
      dueDate: getFutureDate(2),
      category: 'Produtos',
      installments: 1,
    });
    assert.ok(bill2.id, 'Conta 2 deve ser criada com ID válido');
    assert.strictEqual(bill2.amount, 120.00);
    assert.notStrictEqual(bill1.id, bill2.id, 'As contas devem possuir IDs únicos diferentes');

    // 3. Quitar Conta 1 via Service
    const paidResult1 = salonDashboardService.markBillAsPaid(userAId, bill1.id);
    assert.strictEqual(paidResult1.bill.status, 'PAID');
    assert.strictEqual(paidResult1.expense.scheduledPaymentId || paidResult1.expense.scheduled_payment_id, bill1.id);

    // 4. Quitar Conta 2 via Service
    const paidResult2 = salonDashboardService.markBillAsPaid(userAId, bill2.id);
    assert.strictEqual(paidResult2.bill.status, 'PAID');
    assert.strictEqual(paidResult2.expense.scheduledPaymentId || paidResult2.expense.scheduled_payment_id, bill2.id);

    // 5. Validar que ambas as despesas estão vinculadas aos seus respectivos IDs na tabela expenses
    const expRow1 = db.prepare('SELECT * FROM expenses WHERE user_id = ? AND scheduled_payment_id = ?').get(userAId, bill1.id);
    const expRow2 = db.prepare('SELECT * FROM expenses WHERE user_id = ? AND scheduled_payment_id = ?').get(userAId, bill2.id);

    assert.ok(expRow1, 'Despesa vinculada à Conta 1 deve existir no banco');
    assert.strictEqual(expRow1.amount, 80.00);
    assert.strictEqual(expRow1.scheduled_payment_id, bill1.id);

    assert.ok(expRow2, 'Despesa vinculada à Conta 2 deve existir no banco');
    assert.strictEqual(expRow2.amount, 120.00);
    assert.strictEqual(expRow2.scheduled_payment_id, bill2.id);

    // 6. Validar que o Dashboard soma corretamente R$ 200,00 de despesas
    const dashboard = await salonDashboardService.getSalonDashboard(userAId, { isPro: true });
    assert.strictEqual(dashboard.metrics.expensesTotal, 200.00, 'Dashboard deve somar R$ 200,00 de despesas');
  });

  // =========================================================================
  // CENÁRIO B: IDEMPOTÊNCIA E PREVENÇÃO DE DESPESAS DUPLICADAS
  // =========================================================================
  test('b) Repetir a baixa da mesma conta não pode gerar uma segunda despesa', async () => {
    // 1. Localizar Conta 1 quitada no cenário anterior
    const bill1 = db.prepare(`SELECT id FROM scheduled_payments WHERE user_id = ? AND amount = 80.00 LIMIT 1`).get(userAId);
    assert.ok(bill1, 'Conta 1 deve existir');

    const expensesBefore = db.prepare('SELECT COUNT(*) as total FROM expenses WHERE user_id = ?').get(userAId).total;
    assert.strictEqual(expensesBefore, 2, 'Devem existir exatamente 2 despesas cadastradas para o Salão A');

    // 2. Chamar novamente markBillAsPaid na Conta 1 via Service
    const repeatResult = salonDashboardService.markBillAsPaid(userAId, bill1.id);
    assert.strictEqual(repeatResult.bill.status, 'PAID');
    assert.match(repeatResult.message, /já foi marcada como quitada/i);

    // 3. Chamar novamente via API HTTP PATCH /api/cliente/pro/bills/:id/pay
    const httpRes = await fetch(`${baseUrl}/api/cliente/pro/bills/${bill1.id}/pay`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${tokenUserA}`,
        'Content-Type': 'application/json',
      },
    });
    assert.strictEqual(httpRes.status, 200);
    const httpJson = await httpRes.json();
    assert.strictEqual(httpJson.success, true);
    assert.match(httpJson.message, /já foi marcada como quitada/i);

    // 4. Garantir que nenhuma nova linha foi adicionada na tabela expenses
    const expensesAfter = db.prepare('SELECT COUNT(*) as total FROM expenses WHERE user_id = ?').get(userAId).total;
    assert.strictEqual(expensesAfter, 2, 'Total de despesas deve permanecer estritamente 2 sem duplicação');
  });

  // =========================================================================
  // CENÁRIO C: ISOLAMENTO MULTI-TENANT E PROTEÇÃO ANTI-IDOR
  // =========================================================================
  test('c) Contas de salões diferentes com nomes iguais devem permanecer isoladas e protegidas contra IDOR', async () => {
    // 1. Salão A cadastra conta "Aluguel Salão", R$ 1500,00
    const [billA] = salonDashboardService.createBill(userAId, {
      title: 'Aluguel Salão',
      amount: 1500.00,
      dueDate: getFutureDate(5),
      category: 'Imóvel',
      installments: 1,
    });

    // 2. Salão B cadastra conta "Aluguel Salão", R$ 2200,00
    const [billB] = salonDashboardService.createBill(userBId, {
      title: 'Aluguel Salão',
      amount: 2200.00,
      dueDate: getFutureDate(5),
      category: 'Imóvel',
      installments: 1,
    });

    // 3. Salão A quita sua própria conta
    const resPayA = salonDashboardService.markBillAsPaid(userAId, billA.id);
    assert.strictEqual(resPayA.bill.status, 'PAID');

    // 4. Tentativa de Salão B quitar conta de Salão A via Service (Falha de IDOR esperada)
    assert.throws(
      () => salonDashboardService.markBillAsPaid(userBId, billA.id),
      /não encontrada ou não pertence a este usuário/i,
      'Service deve rejeitar tentativa de quitar conta de outro salão (IDOR)'
    );

    // 5. Tentativa de Salão B quitar conta de Salão A via API HTTP (Falha 400 esperada)
    const attackRes = await fetch(`${baseUrl}/api/cliente/pro/bills/${billA.id}/pay`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${tokenUserB}`,
        'Content-Type': 'application/json',
      },
    });
    assert.strictEqual(attackRes.status, 400);
    const attackJson = await attackRes.json();
    assert.strictEqual(attackJson.success, false);
    assert.match(attackJson.error, /não encontrada ou não pertence a este usuário/i);

    // 6. Salão B quita sua própria conta legítima via API HTTP
    const legitRes = await fetch(`${baseUrl}/api/cliente/pro/bills/${billB.id}/pay`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${tokenUserB}`,
        'Content-Type': 'application/json',
      },
    });
    assert.strictEqual(legitRes.status, 200);

    // 7. Validar isolamento dos extratos no SQLite
    const expSalãoA = db.prepare('SELECT * FROM expenses WHERE user_id = ?').all(userAId);
    const expSalãoB = db.prepare('SELECT * FROM expenses WHERE user_id = ?').all(userBId);

    // Salão A possui: 80 (Conta 1) + 120 (Conta 2) + 1500 (Aluguel Salão A) = 3 despesas
    assert.strictEqual(expSalãoA.length, 3);
    assert.strictEqual(expSalãoA.some(e => e.amount === 2200), false, 'Extrato de A jamais pode conter despesa de B');

    // Salão B possui: 2200 (Aluguel Salão B) = 1 despesa
    assert.strictEqual(expSalãoB.length, 1);
    assert.strictEqual(expSalãoB[0].amount, 2200);
    assert.strictEqual(expSalãoB[0].scheduled_payment_id, billB.id);
  });

  // =========================================================================
  // CENÁRIO D: ATOMICIDADE E ROLLBACK TRANSACIONAL
  // =========================================================================
  test('d) Falhas intermediárias devem provocar rollback completo da operação', () => {
    // 1. Cadastrar conta de teste para o Salão A
    const [billFail] = salonDashboardService.createBill(userAId, {
      title: 'Manutenção Equipamentos',
      amount: 450.00,
      dueDate: getFutureDate(10),
      category: 'Manutenção',
      installments: 1,
    });

    const expensesBeforeCount = db.prepare('SELECT COUNT(*) as c FROM expenses WHERE user_id = ?').get(userAId).c;

    // 2. Mock com falha forçada no método financeService.addExpense para simular erro dentro da transação
    const originalAddExpense = financeService.addExpense;
    financeService.addExpense = () => {
      throw new Error('SIMULATED_DATABASE_IO_FAILURE_TRIGGERED');
    };

    try {
      assert.throws(
        () => salonDashboardService.markBillAsPaid(userAId, billFail.id),
        /SIMULATED_DATABASE_IO_FAILURE_TRIGGERED/
      );
    } finally {
      // Restaurar método original
      financeService.addExpense = originalAddExpense;
    }

    // 3. Garantir que a transação sofreu rollback estrito:
    // O status em scheduled_payments continua 'PENDING' e nenhuma despesa residual foi inserida
    const billAfter = db.prepare('SELECT status, paid_at FROM scheduled_payments WHERE id = ?').get(billFail.id);
    assert.strictEqual(billAfter.status, 'PENDING', 'Status da conta deve continuar PENDING após rollback');
    assert.strictEqual(billAfter.paid_at, null, 'paid_at deve permanecer null após rollback');

    const expensesAfterCount = db.prepare('SELECT COUNT(*) as c FROM expenses WHERE user_id = ?').get(userAId).c;
    assert.strictEqual(expensesAfterCount, expensesBeforeCount, 'Nenhuma linha residual pode ser gravada na tabela expenses');
  });

  // =========================================================================
  // CENÁRIO E: DEMO SHIELD (BLOQUEIO FAIL-CLOSED DE ESCRITA)
  // =========================================================================
  test('e) Contas demonstrativas recebem HTTP 403 nas rotas de escrita (Demo Shield)', async () => {
    // 1. Testar POST /api/cliente/pro/bills (Criar conta)
    const resCreate = await fetch(`${baseUrl}/api/cliente/pro/bills`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenDemo}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Conta Hacker Demo',
        amount: 999.00,
        dueDate: getFutureDate(1),
        category: 'Insumos',
      }),
    });
    assert.strictEqual(resCreate.status, 403);
    const jsonCreate = await resCreate.json();
    assert.strictEqual(jsonCreate.code, 'DEMO_MODE_RESTRICTED');
    assert.strictEqual(jsonCreate.isDemoBlocked, true);

    // 2. Testar PATCH /api/cliente/pro/bills/:id/pay (Quitar conta)
    const resPay = await fetch(`${baseUrl}/api/cliente/pro/bills/999/pay`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${tokenDemo}`,
        'Content-Type': 'application/json',
      },
    });
    assert.strictEqual(resPay.status, 403);
    const jsonPay = await resPay.json();
    assert.strictEqual(jsonPay.code, 'DEMO_MODE_RESTRICTED');
    assert.strictEqual(jsonPay.isDemoBlocked, true);

    // 3. Testar DELETE /api/cliente/pro/bills/:id (Excluir conta)
    const resDelete = await fetch(`${baseUrl}/api/cliente/pro/bills/999`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${tokenDemo}`,
      },
    });
    assert.strictEqual(resDelete.status, 403);
    const jsonDelete = await resDelete.json();
    assert.strictEqual(jsonDelete.code, 'DEMO_MODE_RESTRICTED');
    assert.strictEqual(jsonDelete.isDemoBlocked, true);

    // 4. Testar POST /api/cliente/pro/transactions (Movimentação manual)
    const resTx = await fetch(`${baseUrl}/api/cliente/pro/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenDemo}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'EXPENSE',
        amount: 350.00,
        category: 'Despesas',
        description: 'Despesa Não Autorizada Demo',
      }),
    });
    assert.strictEqual(resTx.status, 403);
    const jsonTx = await resTx.json();
    assert.strictEqual(jsonTx.code, 'DEMO_MODE_RESTRICTED');
    assert.strictEqual(jsonTx.isDemoBlocked, true);

    // 5. Garantir que 0 linhas foram inseridas no SQLite para o usuário demo
    const demoBillsCount = db.prepare('SELECT COUNT(*) as c FROM scheduled_payments WHERE user_id = ?').get(demoUserId).c;
    const demoExpCount = db.prepare('SELECT COUNT(*) as c FROM expenses WHERE user_id = ?').get(demoUserId).c;
    assert.strictEqual(demoBillsCount, 0, 'Zero contas devem ter sido criadas para o usuário demo');
    assert.strictEqual(demoExpCount, 0, 'Zero despesas devem ter sido criadas para o usuário demo');
  });
});
