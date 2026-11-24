/**
 * COMANDO 071.2 (P0) — Testes de Validação Hermética da Migração Segura do SQLite Existente
 * 
 * Validação mandatória:
 * - Cenário A: Inicialização limpa a partir de arquivo novo (banco novo)
 * - Cenário B: Boot e migração segura a partir de banco legado pré-existente
 * - Cenário C: Segunda inicialização / idempotência da migração
 * - Cenário D: Idempotência financeira & unicidade parcial (contas homônimas, baixa duplicada, avulsas)
 * - Cenário E: Auditoria fail-closed contra duplicatas prévias
 * 
 * PADRÃO HERMÉTICO OBRIGATÓRIO:
 * - 100% isolado em os.tmpdir() — data/assistant.db NUNCA é acessado.
 * - Test runner nativo node:test e asserções node:assert/strict.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

// ============================================================================
// HELPERS DE ISOLAMENTO HERMÉTICO E CONTROLE DE DESCRITORES
// ============================================================================

const tempFilesToClean = new Set();

function createTempDbPath(prefix = 'raia_test_') {
  const uniqueName = `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 9)}.db`;
  const fullPath = path.join(os.tmpdir(), uniqueName);
  tempFilesToClean.add(fullPath);
  return fullPath;
}

function safeCleanup(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const wal = `${filePath}-wal`;
    const shm = `${filePath}-shm`;
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  } catch (_) {}
}

function closeExistingDb() {
  try {
    const resolvedDb = require.resolve('../src/database/db');
    if (require.cache[resolvedDb] && require.cache[resolvedDb].exports) {
      const dbInstance = require.cache[resolvedDb].exports;
      if (typeof dbInstance.close === 'function') {
        dbInstance.close();
      }
    }
  } catch (_) {}
}

function unloadDbModules() {
  closeExistingDb();
  const modulesToClear = [
    '../src/config',
    '../src/database/db',
    '../src/services/financeService',
    '../src/services/billService'
  ];
  for (const mod of modulesToClear) {
    try {
      const resolved = require.resolve(mod);
      delete require.cache[resolved];
    } catch (_) {}
  }
}

function loadDbForPath(dbPath) {
  process.env.DB_PATH = dbPath;
  unloadDbModules();
  return require('../src/database/db');
}

// Cleanup global após finalização de todos os testes
test.after(() => {
  unloadDbModules();
  for (const filePath of tempFilesToClean) {
    safeCleanup(filePath);
  }
  tempFilesToClean.clear();
});

// ============================================================================
// CENÁRIO A: BANCO NOVO (INICIALIZAÇÃO LIMPA)
// ============================================================================

test('Cenário A: Banco Novo — Inicialização limpa com schema completo e operações financeiras operacionais', (t) => {
  const dbPath = createTempDbPath('scenario_a_clean_');
  const db = loadDbForPath(dbPath);

  t.after(() => {
    unloadDbModules();
    safeCleanup(dbPath);
  });

  // 1. Confirmar coluna scheduled_payment_id na tabela expenses
  const cols = db.prepare("PRAGMA table_info('expenses')").all();
  const schedCol = cols.find(c => c.name === 'scheduled_payment_id');
  assert.ok(schedCol, "A coluna 'scheduled_payment_id' deve existir na tabela 'expenses'");
  assert.equal(schedCol.type.toUpperCase(), 'INTEGER', "O tipo da coluna 'scheduled_payment_id' deve ser INTEGER");

  // 2. Confirmar criação dos índices obrigatórios
  const indices = db.prepare("PRAGMA index_list('expenses')").all();
  const hasSchedPaymentIndex = indices.some(i => i.name === 'idx_expenses_scheduled_payment');
  assert.ok(hasSchedPaymentIndex, "Índice 'idx_expenses_scheduled_payment' deve ter sido criado com sucesso");

  const uniquePartialIndex = indices.find(i => i.name === 'idx_expenses_user_scheduled_payment_unique');
  assert.ok(uniquePartialIndex, "Índice 'idx_expenses_user_scheduled_payment_unique' deve existir");
  assert.equal(uniquePartialIndex.unique, 1, "O índice 'idx_expenses_user_scheduled_payment_unique' deve ser UNIQUE");

  // 3. Confirmar registro da migração em schema_migrations
  const migrationRow = db.prepare("SELECT * FROM schema_migrations WHERE version = '20261123_01_expenses_scheduled_payment_id'").get();
  assert.ok(migrationRow, "Migração '20261123_01_expenses_scheduled_payment_id' deve constar em schema_migrations");

  // 4. Executar operações financeiras normais
  const financeService = require('../src/services/financeService');

  // Inserção de despesa avulsa sem scheduled_payment_id
  const expAvulsa = financeService.addExpense({
    userId: 1,
    amount: 85.0,
    category: 'Mercado',
    description: 'Café e suprimentos',
    paymentMethod: 'Pix',
    date: '2026-11-23T10:00:00Z'
  });
  assert.ok(expAvulsa.id > 0);
  assert.equal(expAvulsa.scheduledPaymentId, null);

  // Inserção de despesa vinculada a scheduled_payment_id
  const expVinculada = financeService.addExpense({
    userId: 1,
    amount: 150.0,
    category: 'Energia',
    description: 'Conta de luz Enel',
    paymentMethod: 'Boleto',
    date: '2026-11-23T11:00:00Z',
    scheduledPaymentId: 777
  });
  assert.ok(expVinculada.id > 0);
  assert.equal(expVinculada.scheduledPaymentId, 777);

  // Validação de consulta e saldos
  const balance = financeService.getOverallBalance(1);
  assert.equal(balance.totalExpenses, 235.0);
  assert.equal(balance.countExpenses, 2);
});

// ============================================================================
// CENÁRIO B: BANCO LEGADO EXISTENTE (BOOT & TRANSIÇÃO NÃO-DESTRUTIVA)
// ============================================================================

test('Cenário B: Banco Legado Existente — Boot não-destrutivo, aplicação segura de migração e 100% integridade de dados', (t) => {
  const legacyDbPath = createTempDbPath('scenario_b_legacy_');

  t.after(() => {
    unloadDbModules();
    safeCleanup(legacyDbPath);
  });

  // 1. Inicializar banco base completo e reverter migração para simular perfeitamente o banco legado
  const initialDb = loadDbForPath(legacyDbPath);
  initialDb.exec(`
    DELETE FROM schema_migrations WHERE version = '20261123_01_expenses_scheduled_payment_id';
    DROP INDEX IF EXISTS idx_expenses_scheduled_payment;
    DROP INDEX IF EXISTS idx_expenses_user_scheduled_payment_unique;
    DROP INDEX IF EXISTS idx_expenses_user_scheduled;
    ALTER TABLE expenses DROP COLUMN scheduled_payment_id;
  `);

  // 2. Inserir dados legados históricos
  initialDb.prepare(`INSERT OR IGNORE INTO users (id, phone_number, name, role) VALUES (1, '5511999990001', 'Salão Bellíssima', 'USER')`).run();
  initialDb.prepare(`INSERT OR REPLACE INTO customer_subscriptions (id, user_id, product_id, status, price_cents) VALUES (1, 1, 1, 'ACTIVE', 8900)`).run();
  initialDb.prepare(`INSERT INTO scheduled_payments (id, user_id, title, amount, due_date, status) VALUES (101, 1, 'Aluguel do Salão', 2500.0, '2026-12-05', 'PENDING')`).run();
  initialDb.prepare(`INSERT INTO scheduled_payments (id, user_id, title, amount, due_date, status) VALUES (102, 1, 'Internet Fibra', 120.0, '2026-12-10', 'PENDING')`).run();
  initialDb.prepare(`INSERT INTO incomes (id, user_id, amount, source, date) VALUES (50, 1, 450.0, 'Corte e Mechas', '2026-11-20T14:00:00Z')`).run();

  // Despesas históricas existentes (sem coluna scheduled_payment_id)
  initialDb.prepare(`INSERT INTO expenses (id, user_id, amount, category, description, payment_method, date) VALUES (1, 1, 95.0, 'Mercado', 'Café e descartáveis', 'Pix', '2026-11-10T08:30:00Z')`).run();
  initialDb.prepare(`INSERT INTO expenses (id, user_id, amount, category, description, payment_method, date) VALUES (2, 1, 2500.0, 'Aluguel', 'Pagamento aluguel novembro', 'Transferência', '2026-11-05T09:00:00Z')`).run();
  initialDb.prepare(`INSERT INTO expenses (id, user_id, amount, category, description, payment_method, date) VALUES (3, 1, 120.0, 'Internet', 'Boleto internet novembro', 'Boleto', '2026-11-10T11:00:00Z')`).run();

  unloadDbModules();

  // 3. Inicializar o sistema através de db.js apontando para o banco legado
  let db;
  assert.doesNotThrow(() => {
    db = loadDbForPath(legacyDbPath);
  }, "O boot do sistema em banco legado pré-existente não deve lançar nenhum erro");

  // 4. Confirmar que a migração foi aplicada com sucesso
  const mig = db.prepare("SELECT * FROM schema_migrations WHERE version = '20261123_01_expenses_scheduled_payment_id'").get();
  assert.ok(mig, "A migração 20261123_01_expenses_scheduled_payment_id deve ter sido aplicada com sucesso");

  // 5. Confirmar que a coluna scheduled_payment_id foi adicionada
  const cols = db.prepare("PRAGMA table_info('expenses')").all();
  const schedCol = cols.find(c => c.name === 'scheduled_payment_id');
  assert.ok(schedCol, "A coluna 'scheduled_payment_id' deve existir após migração");

  // 6. Confirmar criação dos índices
  const indices = db.prepare("PRAGMA index_list('expenses')").all();
  assert.ok(indices.some(i => i.name === 'idx_expenses_scheduled_payment'), "Índice idx_expenses_scheduled_payment deve existir");
  assert.ok(indices.some(i => i.name === 'idx_expenses_user_scheduled_payment_unique' && i.unique === 1), "Índice UNIQUE idx_expenses_user_scheduled_payment_unique deve existir");

  // 7. Confirmar integridade de 100% dos dados legados prévios
  const exp1 = db.prepare("SELECT * FROM expenses WHERE id = 1").get();
  assert.equal(exp1.amount, 95.0);
  assert.equal(exp1.category, 'Mercado');
  assert.equal(exp1.description, 'Café e descartáveis');
  assert.equal(exp1.scheduled_payment_id, null, "Despesa legada prévia deve ter scheduled_payment_id como NULL");

  const exp2 = db.prepare("SELECT * FROM expenses WHERE id = 2").get();
  assert.equal(exp2.amount, 2500.0);
  assert.equal(exp2.scheduled_payment_id, null);

  const exp3 = db.prepare("SELECT * FROM expenses WHERE id = 3").get();
  assert.equal(exp3.amount, 120.0);
  assert.equal(exp3.scheduled_payment_id, null);

  const inc = db.prepare("SELECT * FROM incomes WHERE id = 50").get();
  assert.equal(inc.amount, 450.0);

  const bill1 = db.prepare("SELECT * FROM scheduled_payments WHERE id = 101").get();
  assert.equal(bill1.title, 'Aluguel do Salão');
  assert.equal(bill1.status, 'PENDING');
});

// ============================================================================
// CENÁRIO C: SEGUNDA INICIALIZAÇÃO / IDEMPOTÊNCIA DA MIGRAÇÃO
// ============================================================================

test('Cenário C: Segunda Inicialização — Idempotência estrita e reuso estável do banco já migrado', (t) => {
  const dbPath = createTempDbPath('scenario_c_idempotency_');

  // 1. Primeiro boot: inicializa e aplica migrações
  const dbFirst = loadDbForPath(dbPath);
  const migBefore = dbFirst.prepare("SELECT * FROM schema_migrations WHERE version = '20261123_01_expenses_scheduled_payment_id'").get();
  assert.ok(migBefore, "Migração deve estar registrada no primeiro boot");

  // Inserir registro de despesa teste
  dbFirst.prepare(`
    INSERT INTO expenses (user_id, amount, category, description, payment_method, date, scheduled_payment_id)
    VALUES (1, 60.0, 'Alimentação', 'Almoço', 'Pix', '2026-11-23T12:00:00Z', 501)
  `).run();

  // 2. Fechar conexão e descarregar módulos
  unloadDbModules();

  t.after(() => {
    unloadDbModules();
    safeCleanup(dbPath);
  });

  // 3. Segundo boot apontando para o MESMO arquivo já migrado
  let dbSecond;
  assert.doesNotThrow(() => {
    dbSecond = loadDbForPath(dbPath);
  }, "O segundo boot sobre banco já migrado deve ocorrer de forma totalmente limpa e sem erros");

  // 4. Validar que schema_migrations continua com exatamente 1 registro para essa versão
  const migCount = dbSecond.prepare("SELECT COUNT(*) as c FROM schema_migrations WHERE version = '20261123_01_expenses_scheduled_payment_id'").get();
  assert.equal(migCount.c, 1, "A migração não deve ser reaplicada ou duplicada em inicializações subsequentes");

  // 5. Validar que os índices e dados existentes permaneceram intactos
  const expRow = dbSecond.prepare("SELECT * FROM expenses WHERE scheduled_payment_id = 501").get();
  assert.ok(expRow);
  assert.equal(expRow.amount, 60.0);
  assert.equal(expRow.scheduled_payment_id, 501);
});

// ============================================================================
// CENÁRIO D: IDEMPOTÊNCIA FINANCEIRA & UNICIDADE PARCIAL
// ============================================================================

test('Cenário D: Idempotência Financeira & Unicidade Parcial — Contas homônimas, baixa idempotente e despesas avulsas', (t) => {
  const dbPath = createTempDbPath('scenario_d_financial_');
  const db = loadDbForPath(dbPath);

  t.after(() => {
    unloadDbModules();
    safeCleanup(dbPath);
  });

  const billService = require('../src/services/billService');
  const financeService = require('../src/services/financeService');

  // Criar 2 contas homônimas para o mesmo usuário (user_id = 1)
  const insBill1 = db.prepare(`
    INSERT INTO scheduled_payments (user_id, title, amount, due_date, category, status)
    VALUES (1, 'Aluguel Sala Comercial', 1500.0, '2026-12-01', 'Aluguel', 'PENDING')
  `).run();
  const bill1Id = insBill1.lastInsertRowid;

  const insBill2 = db.prepare(`
    INSERT INTO scheduled_payments (user_id, title, amount, due_date, category, status)
    VALUES (1, 'Aluguel Sala Comercial', 1500.0, '2026-12-01', 'Aluguel', 'PENDING')
  `).run();
  const bill2Id = insBill2.lastInsertRowid;

  assert.notEqual(bill1Id, bill2Id, "As duas contas devem possuir IDs distintos");

  // 1. Quitar Conta 1 -> gera Despesa 1
  const res1 = billService.markAsPaid(bill1Id, 1);
  assert.equal(res1.bill.status, 'PAID');
  assert.ok(res1.expense, 'Despesa deve ter sido gerada para Conta 1');
  assert.equal(res1.expense.scheduledPaymentId, bill1Id);

  // 2. Quitar Conta 2 (homônima) -> gera Despesa 2 distinta
  const res2 = billService.markAsPaid(bill2Id, 1);
  assert.equal(res2.bill.status, 'PAID');
  assert.ok(res2.expense, 'Despesa deve ter sido gerada para Conta 2 homônima');
  assert.equal(res2.expense.scheduledPaymentId, bill2Id);
  assert.notEqual(res1.expense.id, res2.expense.id, "Duas contas homônimas devem gerar despesas com IDs distintos");

  // 3. Baixa repetida da mesma Conta 1 -> idempotência funcional (sem duplicar despesa)
  const res1Repetido = billService.markAsPaid(bill1Id, 1);
  assert.equal(res1Repetido.message, 'Esta conta já foi marcada como quitada anteriormente.');
  assert.equal(res1Repetido.expense.id, res1.expense.id, "Deve retornar a mesma despesa pré-existente");

  const countExpBill1 = db.prepare("SELECT COUNT(*) as c FROM expenses WHERE user_id = 1 AND scheduled_payment_id = ?").get(bill1Id);
  assert.equal(countExpBill1.c, 1, "Não deve existir mais de uma despesa para a mesma conta liquidada");

  // 4. Inserção concorrente/direta violando par (user_id, scheduled_payment_id) é rejeitada pelo índice UNIQUE
  assert.throws(() => {
    db.prepare(`
      INSERT INTO expenses (user_id, amount, category, description, date, scheduled_payment_id)
      VALUES (1, 1500.0, 'Aluguel', 'Tentativa de colisão concorrente', '2026-11-23T15:00:00Z', ?)
    `).run(bill1Id);
  }, (err) => {
    const isConstraintError = err.message.includes('UNIQUE constraint failed') ||
                              err.message.includes('SQLITE_CONSTRAINT_UNIQUE') ||
                              err.code === 'SQLITE_CONSTRAINT_UNIQUE';
    assert.ok(isConstraintError, `Erro esperado de unicidade violada, recebido: ${err.message}`);
    return true;
  });

  // 5. Inserção de múltiplas despesas avulsas com scheduled_payment_id IS NULL para o mesmo usuário
  // Valida que o índice parcial (WHERE scheduled_payment_id IS NOT NULL) não bloqueia despesas cotidianas
  for (let i = 1; i <= 5; i++) {
    const expAvulsa = financeService.addExpense({
      userId: 1,
      amount: 20.0 + i,
      category: 'Diversos',
      description: `Gasto avulso #${i}`,
      scheduledPaymentId: null
    });
    assert.ok(expAvulsa.id > 0);
    assert.equal(expAvulsa.scheduledPaymentId, null);
  }

  const countAvulsas = db.prepare("SELECT COUNT(*) as c FROM expenses WHERE user_id = 1 AND scheduled_payment_id IS NULL").get();
  assert.equal(countAvulsas.c, 5, "Todas as 5 despesas avulsas com scheduled_payment_id IS NULL devem coexistir sem restrições");
});

// ============================================================================
// CENÁRIO E: AUDITORIA FAIL-CLOSED CONTRA DUPLICATAS PRÉVIAS
// ============================================================================

test('Cenário E: Auditoria Fail-Closed — Detecção de duplicatas prévias interrompe migração sem corromper dados', (t) => {
  const dirtyDbPath = createTempDbPath('scenario_e_duplicates_');

  t.after(() => {
    unloadDbModules();
    safeCleanup(dirtyDbPath);
  });

  // 1. Inicializar banco e simular estado onde a migração 071.1 ainda não rodou, mas há registros duplicados anômalos
  const initialDb = loadDbForPath(dirtyDbPath);
  initialDb.exec(`
    DELETE FROM schema_migrations WHERE version = '20261123_01_expenses_scheduled_payment_id';
    DROP INDEX IF EXISTS idx_expenses_user_scheduled_payment_unique;
  `);

  // Inserir duplicata anômala legada para o mesmo scheduled_payment_id = 999
  initialDb.prepare(`
    INSERT INTO expenses (id, user_id, amount, category, description, date, scheduled_payment_id)
    VALUES (1, 10, 300.0, 'Telefonia', 'Plano empresarial', '2026-11-20T08:00:00Z', 999)
  `).run();
  initialDb.prepare(`
    INSERT INTO expenses (id, user_id, amount, category, description, date, scheduled_payment_id)
    VALUES (2, 10, 300.0, 'Telefonia', 'Plano empresarial (duplicado incorretamente)', '2026-11-20T08:05:00Z', 999)
  `).run();

  unloadDbModules();

  // 2. Tentar inicializar o sistema via db.js apontando para a base com duplicatas
  // A migração DEVE lançar exceção descritiva abortando o boot para proteger os dados (fail-closed)
  assert.throws(() => {
    loadDbForPath(dirtyDbPath);
  }, (err) => {
    assert.match(
      err.message,
      /Falha de integridade: detectadas despesas duplicadas para o mesmo scheduled_payment_id/,
      "A exceção deve descrever a falha de integridade e orientar saneamento manual"
    );
    return true;
  });

  // 3. Validação Fail-Closed via conexão direta independente:
  const verifyDb = new DatabaseSync(dirtyDbPath);

  // A. Nenhum dado do usuário foi apagado
  const expensesCount = verifyDb.prepare("SELECT COUNT(*) as c FROM expenses").get();
  assert.equal(expensesCount.c, 2, "Nenhum registro de despesa deve ser apagado pela auditoria");

  const row1 = verifyDb.prepare("SELECT * FROM expenses WHERE id = 1").get();
  const row2 = verifyDb.prepare("SELECT * FROM expenses WHERE id = 2").get();
  assert.equal(row1.amount, 300.0);
  assert.equal(row2.amount, 300.0);

  // B. A migração NÃO foi registrada com sucesso em schema_migrations
  const hasMigrationsTable = verifyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (hasMigrationsTable) {
    const mig = verifyDb.prepare("SELECT * FROM schema_migrations WHERE version = '20261123_01_expenses_scheduled_payment_id'").get();
    assert.equal(mig, undefined, "A migração NÃO pode ser registrada com sucesso caso haja duplicidades");
  }

  // C. O índice UNIQUE NÃO foi criado sobre a base corrompida
  const indices = verifyDb.prepare("PRAGMA index_list('expenses')").all();
  const hasUniqueIndex = indices.some(i => i.name === 'idx_expenses_user_scheduled_payment_unique');
  assert.equal(hasUniqueIndex, false, "O índice UNIQUE NÃO deve ter sido criado em estado inconsistente");

  verifyDb.close();
});