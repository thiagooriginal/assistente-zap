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

module.exports = {
  addExpense,
  queryExpenses,
  queryExpensesLastDays,
  getRecentExpenses,
  deleteLastExpense,
  deleteExpense,
  updateExpense,
  getMonthlySummary,
  formatCurrency,
  formatDateBR,
  normalizeCategory,
};
