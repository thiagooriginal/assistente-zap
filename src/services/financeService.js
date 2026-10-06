const db = require('../database/db');

function formatCurrency(amount) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(amount);
}

function formatDateBR(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return dateStr;
  }
}

/**
 * Standardize and capitalize category names
 */
function normalizeCategory(category) {
  if (!category) return 'Outros';
  const clean = category.trim().toLowerCase();
  
  if (clean.includes('gasolin') || clean.includes('combust') || clean.includes('posto') || clean.includes('etanol') || clean.includes('abastec')) {
    return 'Gasolina';
  }
  if (clean.includes('mercado') || clean.includes('supermercado') || clean.includes('feira') || clean.includes('hortifruti')) {
    return 'Mercado';
  }
  if (clean.includes('almoç') || clean.includes('jantar') || clean.includes('lanche') || clean.includes('restaurante') || clean.includes('ifood') || clean.includes('pizz') || clean.includes('café') || clean.includes('comida') || clean.includes('aliment')) {
    return 'Alimentação';
  }
  if (clean.includes('farm') || clean.includes('remedio') || clean.includes('remédio') || clean.includes('saude') || clean.includes('saúde') || clean.includes('médic') || clean.includes('medic')) {
    return 'Saúde / Farmácia';
  }
  if (clean.includes('uber') || clean.includes('99') || clean.includes('taxi') || clean.includes('estacion') || clean.includes('pedag') || clean.includes('onibus') || clean.includes('ônibus')) {
    return 'Transporte';
  }
  if (clean.includes('lazer') || clean.includes('cinema') || clean.includes('balada') || clean.includes('bar') || clean.includes('viagem') || clean.includes('festa')) {
    return 'Lazer / Diversão';
  }
  if (clean.includes('luz') || clean.includes('agua') || clean.includes('água') || clean.includes('internet') || clean.includes('aluguel') || clean.includes('condom') || clean.includes('casa')) {
    return 'Moradia / Contas';
  }
  
  // Capitalize first letter
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Standardize and capitalize income category names
 */
function normalizeIncomeCategory(category) {
  if (!category) return 'Outros';
  const clean = category.trim().toLowerCase();

  if (clean.includes('salari') || clean.includes('salário') || clean.includes('holerite') || clean.includes('pro labore') || clean.includes('pró-labore') || clean.includes('empresa') || clean.includes('ordenado') || clean.includes('adiantamento')) {
    return 'Salário';
  }
  if (clean.includes('servic') || clean.includes('serviço') || clean.includes('freela') || clean.includes('cliente') || clean.includes('consultor') || clean.includes('projeto') || clean.includes('honorari')) {
    return 'Serviços';
  }
  if (clean.includes('venda') || clean.includes('produto') || clean.includes('loja') || clean.includes('comercio') || clean.includes('comércio')) {
    return 'Vendas';
  }
  if (clean.includes('comiss') || clean.includes('comissão')) {
    return 'Comissão';
  }
  if (clean.includes('rendimento') || clean.includes('dividendo') || clean.includes('invest') || clean.includes('juro') || clean.includes('cdi') || clean.includes('poupanca') || clean.includes('poupança')) {
    return 'Rendimentos';
  }
  if (clean.includes('aluguel') || clean.includes('locacao') || clean.includes('locação')) {
    return 'Aluguel';
  }
  if (clean.includes('reembolso') || clean.includes('devoluc') || clean.includes('devolução') || clean.includes('estorno')) {
    return 'Reembolso';
  }
  if (clean.includes('pix') || clean.includes('transfer')) {
    return 'Pix Recebido';
  }

  // Capitalize first letter
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Add a new expense
 */
function addExpense({ userId = 1, amount, category, description, paymentMethod, date, sourceType = 'text' }) {
  const normCategory = normalizeCategory(category);
  const expenseDate = date || new Date().toISOString();
  
  const stmt = db.prepare(`
    INSERT INTO expenses (user_id, amount, category, description, payment_method, date, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    userId,
    Number(amount),
    normCategory,
    description || normCategory,
    paymentMethod || 'Não informado',
    expenseDate,
    sourceType
  );
  
  return {
    id: result.lastInsertRowid,
    userId,
    amount: Number(amount),
    category: normCategory,
    description: description || normCategory,
    paymentMethod: paymentMethod || 'Não informado',
    date: expenseDate,
    sourceType,
  };
}

/**
 * Query expenses with flexible filters
 */
function queryExpenses({ userId = 1, category, startDate, endDate }) {
  let query = 'SELECT * FROM expenses WHERE user_id = ?';
  const params = [userId];

  if (category) {
    const norm = normalizeCategory(category);
    query += ' AND (category LIKE ? OR description LIKE ?)';
    params.push(`%${norm}%`, `%${category}%`);
  }

  if (startDate) {
    query += ' AND date >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND date <= ?';
    params.push(endDate);
  }

  query += ' ORDER BY date DESC';
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);

  const total = rows.reduce((acc, row) => acc + Number(row.amount), 0);

  return {
    rows,
    total,
    count: rows.length,
    formattedTotal: formatCurrency(total),
  };
}

/**
 * Query expenses by last N days
 */
function queryExpensesLastDays(category, days, userId = 1) {
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startDate = past.toISOString();
  
  return queryExpenses({
    userId,
    category,
    startDate,
  });
}

/**
 * Get recent expenses
 */
function getRecentExpenses(limit = 5, userId = 1) {
  const stmt = db.prepare(`
    SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?
  `);
  const rows = stmt.all(userId, limit);
  return rows;
}

/**
 * Delete the latest expense for a specific user
 */
function deleteLastExpense(userId = 1) {
  const recent = db.prepare(`SELECT * FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(userId);
  if (!recent) return null;

  db.prepare(`DELETE FROM expenses WHERE id = ?`).run(recent.id);
  return recent;
}

/**
 * Delete an expense by amount, description/keyword, or last registered
 */
function deleteExpense({ userId = 1, amount, description, target = 'specific' }) {
  if (target === 'last' && !amount && !description) {
    return deleteLastExpense(userId);
  }

  const numAmount = (amount !== null && amount !== undefined && !isNaN(Number(amount))) ? Number(amount) : null;
  const cleanDesc = description
    ? description.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    : null;

  // Fetch recent 50 expenses for this user
  const recent = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId);
  if (!recent || recent.length === 0) return null;

  let candidate = null;

  const getNormText = (exp) => {
    const d = (exp.description || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const c = (exp.category || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return `${d} ${c}`;
  };

  // 1. Both amount and description provided
  if (numAmount !== null && cleanDesc) {
    candidate = recent.find((exp) => {
      const matchAmt = Math.abs(Number(exp.amount) - numAmount) < 0.01;
      const text = getNormText(exp);
      const matchDesc = text.includes(cleanDesc);
      return matchAmt && matchDesc;
    });
  }

  // 2. By description / keyword
  if (!candidate && cleanDesc) {
    candidate = recent.find((exp) => {
      const text = getNormText(exp);
      return text.includes(cleanDesc);
    });
  }

  // 3. By amount
  if (!candidate && numAmount !== null) {
    candidate = recent.find((exp) => {
      return Math.abs(Number(exp.amount) - numAmount) < 0.01;
    });
  }

  // 4. Fallback to last expense if target is 'last'
  if (!candidate && target === 'last') {
    candidate = recent[0];
  }

  if (candidate) {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(candidate.id);
    return candidate;
  }

  return null;
}

/**
 * Get monthly category breakdown
 */
function getMonthlySummary(yearMonth, userId = 1) {
  // yearMonth: 'YYYY-MM'
  const target = yearMonth || new Date().toISOString().slice(0, 7);
  
  const stmt = db.prepare(`
    SELECT category, SUM(amount) as total, COUNT(*) as count
    FROM expenses
    WHERE user_id = ? AND date LIKE ?
    GROUP BY category
    ORDER BY total DESC
  `);
  const rows = stmt.all(userId, `${target}%`);
  const total = rows.reduce((acc, row) => acc + Number(row.total), 0);

  return {
    month: target,
    categories: rows,
    total,
  };
}

/**
 * Update an existing expense by search criteria, old amount or latest expense
 */
function updateExpense({ userId = 1, targetId, searchTerm, oldAmount, newAmount, newCategory, newDescription, newPaymentMethod }) {
  let target = null;

  if (targetId) {
    target = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(targetId, userId);
  }

  const recent = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(userId);
  if (!recent || recent.length === 0) {
    throw new Error('Nenhum gasto encontrado no histórico para atualizar.');
  }

  // If oldAmount is specified, try to find an expense matching oldAmount
  if (!target && oldAmount !== undefined && oldAmount !== null) {
    const numOld = Number(oldAmount);
    target = recent.find(e => Math.abs(Number(e.amount) - numOld) < 0.01);
  }

  // If searchTerm is specified, search in description or category
  if (!target && searchTerm) {
    const cleanSearch = searchTerm.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    target = recent.find(e => {
      const desc = (e.description || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const cat = (e.category || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return desc.includes(cleanSearch) || cat.includes(cleanSearch);
    });
  }

  // Fallback: take the very last expense registered
  if (!target) {
    target = recent[0];
  }

  const previous = { ...target };

  const updatedAmount = (newAmount !== undefined && newAmount !== null) ? Number(newAmount) : target.amount;
  const updatedCategory = newCategory ? normalizeCategory(newCategory) : target.category;
  const updatedDescription = newDescription ? newDescription.trim() : target.description;
  const updatedPaymentMethod = newPaymentMethod || target.payment_method;

  db.prepare(`
    UPDATE expenses 
    SET amount = ?, category = ?, description = ?, payment_method = ?
    WHERE id = ?
  `).run(updatedAmount, updatedCategory, updatedDescription, updatedPaymentMethod, target.id);

  const updated = db.prepare('SELECT * FROM expenses WHERE id = ?').get(target.id);

  return {
    previous,
    updated,
  };
}

/**
 * Add a new income
 */
function addIncome({ userId = 1, amount, source, category, paymentMethod = 'Pix', date, sourceType = 'text' }) {
  const normCategory = normalizeIncomeCategory(category || source);
  const incomeDate = date || new Date().toISOString();
  const incomeSource = (source && source.trim()) ? source.trim() : (category || 'Receita');

  const stmt = db.prepare(`
    INSERT INTO incomes (user_id, amount, source, category, payment_method, date, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    userId,
    Number(amount),
    incomeSource,
    normCategory,
    paymentMethod || 'Pix',
    incomeDate,
    sourceType
  );

  return {
    id: result.lastInsertRowid,
    userId,
    amount: Number(amount),
    source: incomeSource,
    category: normCategory,
    paymentMethod: paymentMethod || 'Pix',
    date: incomeDate,
    sourceType,
  };
}

/**
 * Query incomes with flexible filters
 */
function queryIncomes({ userId = 1, category, startDate, endDate }) {
  let query = 'SELECT * FROM incomes WHERE user_id = ?';
  const params = [userId];

  if (category) {
    const norm = normalizeIncomeCategory(category);
    query += ' AND (category LIKE ? OR source LIKE ?)';
    params.push(`%${norm}%`, `%${category}%`);
  }

  if (startDate) {
    query += ' AND date >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND date <= ?';
    params.push(endDate);
  }

  query += ' ORDER BY date DESC, id DESC';
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);

  const total = rows.reduce((acc, row) => acc + Number(row.amount), 0);

  return {
    rows,
    total,
    count: rows.length,
    formattedTotal: formatCurrency(total),
  };
}

/**
 * Query incomes by last N days
 */
function queryIncomesLastDays(category, days, userId = 1) {
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startDate = past.toISOString();

  return queryIncomes({
    userId,
    category,
    startDate,
  });
}

/**
 * Get recent incomes
 */
function getRecentIncomes(limit = 5, userId = 1) {
  const stmt = db.prepare(`
    SELECT * FROM incomes WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?
  `);
  const rows = stmt.all(userId, limit);
  return rows;
}

/**
 * Delete the latest income for a specific user
 */
function deleteLastIncome(userId = 1) {
  const recent = db.prepare(`SELECT * FROM incomes WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(userId);
  if (!recent) return null;

  db.prepare(`DELETE FROM incomes WHERE id = ?`).run(recent.id);
  return recent;
}

/**
 * Delete an income by amount, source/keyword, or last registered
 */
function deleteIncome({ userId = 1, amount, source, target = 'specific' }) {
  if (target === 'last' && !amount && !source) {
    return deleteLastIncome(userId);
  }

  const numAmount = (amount !== null && amount !== undefined && !isNaN(Number(amount))) ? Number(amount) : null;
  const cleanSource = source
    ? source.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    : null;

  // Fetch recent 50 incomes for this user
  const recent = db.prepare('SELECT * FROM incomes WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId);
  if (!recent || recent.length === 0) return null;

  let candidate = null;

  const getNormText = (inc) => {
    const s = (inc.source || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const c = (inc.category || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return `${s} ${c}`;
  };

  // 1. Both amount and source provided
  if (numAmount !== null && cleanSource) {
    candidate = recent.find((inc) => {
      const matchAmt = Math.abs(Number(inc.amount) - numAmount) < 0.01;
      const text = getNormText(inc);
      const matchSrc = text.includes(cleanSource);
      return matchAmt && matchSrc;
    });
  }

  // 2. By source / keyword
  if (!candidate && cleanSource) {
    candidate = recent.find((inc) => {
      const text = getNormText(inc);
      return text.includes(cleanSource);
    });
  }

  // 3. By amount
  if (!candidate && numAmount !== null) {
    candidate = recent.find((inc) => {
      return Math.abs(Number(inc.amount) - numAmount) < 0.01;
    });
  }

  // 4. Fallback to last income if target is 'last'
  if (!candidate && target === 'last') {
    candidate = recent[0];
  }

  if (candidate) {
    db.prepare('DELETE FROM incomes WHERE id = ?').run(candidate.id);
    return candidate;
  }

  return null;
}

/**
 * Update an existing income
 */
function updateIncome({ userId = 1, targetId, searchTerm, oldAmount, newAmount, newCategory, newSource, newPaymentMethod }) {
  let target = null;

  if (targetId) {
    target = db.prepare('SELECT * FROM incomes WHERE id = ? AND user_id = ?').get(targetId, userId);
  }

  const recent = db.prepare('SELECT * FROM incomes WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(userId);
  if (!recent || recent.length === 0) {
    throw new Error('Nenhuma entrada encontrada no histórico para atualizar.');
  }

  if (!target && oldAmount !== undefined && oldAmount !== null) {
    const numOld = Number(oldAmount);
    target = recent.find(e => Math.abs(Number(e.amount) - numOld) < 0.01);
  }

  if (!target && searchTerm) {
    const cleanSearch = searchTerm.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    target = recent.find(e => {
      const src = (e.source || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const cat = (e.category || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return src.includes(cleanSearch) || cat.includes(cleanSearch);
    });
  }

  if (!target) {
    target = recent[0];
  }

  const previous = { ...target };

  const updatedAmount = (newAmount !== undefined && newAmount !== null) ? Number(newAmount) : target.amount;
  const updatedCategory = newCategory ? normalizeIncomeCategory(newCategory) : target.category;
  const updatedSource = newSource ? newSource.trim() : target.source;
  const updatedPaymentMethod = newPaymentMethod || target.payment_method;

  db.prepare(`
    UPDATE incomes 
    SET amount = ?, category = ?, source = ?, payment_method = ?
    WHERE id = ?
  `).run(updatedAmount, updatedCategory, updatedSource, updatedPaymentMethod, target.id);

  const updated = db.prepare('SELECT * FROM incomes WHERE id = ?').get(target.id);

  return {
    previous,
    updated,
  };
}

/**
 * Format ISO date to simple DD/MM/YYYY
 */
function formatDateSimple(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch (e) {
    return dateStr.slice(0, 10);
  }
}

/**
 * Get cumulative overall balance (Total Incomes ever - Total Expenses ever)
 */
function getOverallBalance(userId = 1) {
  const incomeRow = db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count
    FROM incomes
    WHERE user_id = ?
  `).get(userId);

  const expenseRow = db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count
    FROM expenses
    WHERE user_id = ?
  `).get(userId);

  const totalIncomes = Number(incomeRow?.total || 0);
  const countIncomes = Number(incomeRow?.count || 0);
  const totalExpenses = Number(expenseRow?.total || 0);
  const countExpenses = Number(expenseRow?.count || 0);
  const balance = totalIncomes - totalExpenses;

  return {
    totalIncomes,
    countIncomes,
    formattedIncomes: formatCurrency(totalIncomes),
    totalExpenses,
    countExpenses,
    formattedExpenses: formatCurrency(totalExpenses),
    balance,
    formattedBalance: formatCurrency(balance),
    isPositive: balance >= 0,
  };
}

/**
 * Get period financial balance (e.g. last 30 days, or custom date range)
 */
function getPeriodBalance({ days = 30, startDate, endDate, userId = 1 }) {
  let startISO, endISO, periodLabel;

  if (startDate && endDate) {
    startISO = new Date(startDate).toISOString();
    endISO = new Date(endDate).toISOString();
    periodLabel = `Período (${formatDateSimple(startISO)} a ${formatDateSimple(endISO)})`;
  } else {
    const numDays = days ? Number(days) : 30;
    const now = new Date();
    const past = new Date(now.getTime() - numDays * 24 * 60 * 60 * 1000);
    startISO = past.toISOString();
    endISO = now.toISOString();
    periodLabel = `Últimos ${numDays} Dias`;
  }

  const incomeRow = db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count
    FROM incomes
    WHERE user_id = ? AND date >= ? AND date <= ?
  `).get(userId, startISO, endISO);

  const expenseRow = db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count
    FROM expenses
    WHERE user_id = ? AND date >= ? AND date <= ?
  `).get(userId, startISO, endISO);

  const recentIncomes = db.prepare(`
    SELECT * FROM incomes
    WHERE user_id = ? AND date >= ? AND date <= ?
    ORDER BY date DESC LIMIT 5
  `).all(userId, startISO, endISO);

  const recentExpenses = db.prepare(`
    SELECT * FROM expenses
    WHERE user_id = ? AND date >= ? AND date <= ?
    ORDER BY date DESC LIMIT 5
  `).all(userId, startISO, endISO);

  const totalIncomes = Number(incomeRow?.total || 0);
  const countIncomes = Number(incomeRow?.count || 0);
  const totalExpenses = Number(expenseRow?.total || 0);
  const countExpenses = Number(expenseRow?.count || 0);
  const balance = totalIncomes - totalExpenses;

  const overall = getOverallBalance(userId);

  return {
    periodLabel,
    days: days || 30,
    startDate: startISO,
    endDate: endISO,
    totalIncomes,
    countIncomes,
    formattedIncomes: formatCurrency(totalIncomes),
    totalExpenses,
    countExpenses,
    formattedExpenses: formatCurrency(totalExpenses),
    balance,
    formattedBalance: formatCurrency(balance),
    isPositive: balance >= 0,
    recentIncomes,
    recentExpenses,
    overallBalance: overall.balance,
    formattedOverallBalance: overall.formattedBalance,
    isOverallPositive: overall.isPositive,
  };
}

/**
 * Get monthly financial balance (Incomes vs Expenses)
 */
function getMonthlyBalance(yearMonth, userId = 1) {
  const target = yearMonth || new Date().toISOString().slice(0, 7);

  const incomeRow = db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count
    FROM incomes
    WHERE user_id = ? AND date LIKE ?
  `).get(userId, `${target}%`);

  const expenseRow = db.prepare(`
    SELECT SUM(amount) as total, COUNT(*) as count
    FROM expenses
    WHERE user_id = ? AND date LIKE ?
  `).get(userId, `${target}%`);

  const totalIncomes = Number(incomeRow?.total || 0);
  const countIncomes = Number(incomeRow?.count || 0);
  const totalExpenses = Number(expenseRow?.total || 0);
  const countExpenses = Number(expenseRow?.count || 0);
  const balance = totalIncomes - totalExpenses;

  const overall = getOverallBalance(userId);

  return {
    month: target,
    totalIncomes,
    countIncomes,
    formattedIncomes: formatCurrency(totalIncomes),
    totalExpenses,
    countExpenses,
    formattedExpenses: formatCurrency(totalExpenses),
    balance,
    formattedBalance: formatCurrency(balance),
    isPositive: balance >= 0,
    overallBalance: overall.balance,
    formattedOverallBalance: overall.formattedBalance,
    isOverallPositive: overall.isPositive,
  };
}

/**
 * Get monthly income category breakdown
 */
function getMonthlyIncomesSummary(yearMonth, userId = 1) {
  const target = yearMonth || new Date().toISOString().slice(0, 7);

  const stmt = db.prepare(`
    SELECT category, SUM(amount) as total, COUNT(*) as count
    FROM incomes
    WHERE user_id = ? AND date LIKE ?
    GROUP BY category
    ORDER BY total DESC
  `);
  const rows = stmt.all(userId, `${target}%`);
  const total = rows.reduce((acc, row) => acc + Number(row.total), 0);

  return {
    month: target,
    categories: rows,
    total,
  };
}

module.exports = {
  addExpense,
  queryExpenses,
  queryExpensesLastDays,
  getRecentExpenses,
  deleteLastExpense,
  deleteExpense,
  updateExpense,
  getMonthlySummary,
  addIncome,
  queryIncomes,
  queryIncomesLastDays,
  getRecentIncomes,
  deleteLastIncome,
  deleteIncome,
  updateIncome,
  getMonthlyBalance,
  getOverallBalance,
  getPeriodBalance,
  getMonthlyIncomesSummary,
  formatCurrency,
  formatDateBR,
  formatDateSimple,
  normalizeCategory,
  normalizeIncomeCategory,
};
