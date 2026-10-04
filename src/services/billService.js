const db = require('../database/db');
const financeService = require('./financeService');
const calendarService = require('./calendarService');

/**
 * Robust currency and number parser supporting Brazilian Portuguese formats
 */
function parseMoney(val, fallbackText = '') {
  if (typeof val === 'number' && !isNaN(val) && val > 0) return val;
  if (typeof val === 'string') {
    let s = val.trim().toLowerCase();
    if (s === 'mil') return 1000;
    if (s.includes('mil')) {
      const cleanNum = s.replace('mil', '').replace(/[^\d,\.]/g, '').trim();
      const mult = parseFloat(cleanNum.replace(',', '.')) || 1;
      return mult * 1000;
    }
    s = s.replace(/[^\d,\.]/g, '');
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    else if (s.includes('.') && s.split('.')[1]?.length === 3) s = s.replace('.', '');
    const n = parseFloat(s);
    if (!isNaN(n) && n > 0) return n;
  }
  if (fallbackText) {
    const lower = fallbackText.toLowerCase();
    if (lower.includes('mil')) {
      const matchMil = lower.match(/(\d+[\.,]?\d*)\s*mil/);
      if (matchMil) {
        return parseFloat(matchMil[1].replace(',', '.')) * 1000;
      }
      return 1000;
    }
    const matchNumber = lower.match(/(?:r\$|\$)?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[\.,]\d{1,2})?)/);
    if (matchNumber) {
      let numStr = matchNumber[1];
      if (numStr.includes('.') && numStr.includes(',')) numStr = numStr.replace(/\./g, '').replace(',', '.');
      else if (numStr.includes(',')) numStr = numStr.replace(',', '.');
      const num = parseFloat(numStr);
      if (!isNaN(num) && num > 0) return num;
    }
  }
  return 0;
}

/**
 * Robust date parser supporting YYYY-MM-DD, ISO, or day-of-month (e.g., "10", "dia 10", "todo dia 10")
 */
function parseDueDate(dateStr) {
  const now = new Date();
  if (!dateStr) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (typeof dateStr === 'string' && dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return dateStr;
  }
  const matchDay = String(dateStr).match(/\b(\d{1,2})\b/);
  if (matchDay) {
    const day = parseInt(matchDay[1], 10);
    if (day >= 1 && day <= 31) {
      const target = new Date(now.getFullYear(), now.getMonth(), day);
      if (target <= now) target.setMonth(target.getMonth() + 1);
      const y = target.getFullYear();
      const m = String(target.getMonth() + 1).padStart(2, '0');
      const d = String(target.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Add scheduled payment(s) - supports one-off or installments
 */
/**
 * Add scheduled payment(s) - supports one-off or installments
 */
async function addScheduledPayment({
  userId = 1,
  title,
  totalAmount,
  amount,
  total,
  value,
  valor,
  installmentAmount,
  parcelaValor,
  installments = 1,
  firstDueDate,
  category = 'Contas',
  sourceType = 'text',
  rawText = '',
}) {
  const count = Math.max(1, parseInt(installments, 10) || 1);
  const parsedInst = parseMoney(installmentAmount || parcelaValor);
  const parsedTotal = parseMoney(totalAmount || amount || total || value || valor, rawText);

  let amountPerInstallment = 0;
  if (parsedInst > 0) {
    amountPerInstallment = parsedInst;
  } else if (parsedTotal > 0) {
    amountPerInstallment = Math.round((parsedTotal / count) * 100) / 100;
  }

  if (!amountPerInstallment || amountPerInstallment <= 0) {
    throw new Error('Valor inválido para o pagamento agendado.');
  }

  // Safety guard: if amount was parsed as 1 but user spoke/typed "mil"
  if (amountPerInstallment === 1 && (rawText.toLowerCase().includes('mil') || (title && title.toLowerCase().includes('mil')))) {
    amountPerInstallment = 1000;
  }

  const baseDueDateStr = parseDueDate(firstDueDate);
  const [baseY, baseM, baseD] = baseDueDateStr.split('-').map(Number);

  const createdBills = [];
  const stmt = db.prepare(`
    INSERT INTO scheduled_payments (
      user_id, title, amount, due_date, category, status,
      installment_current, installment_total, source_type
    ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
  `);

  for (let i = 1; i <= count; i++) {
    // Correctly advance months while preserving day
    const instDate = new Date(baseY, (baseM - 1) + (i - 1), baseD);
    const y = instDate.getFullYear();
    const m = String(instDate.getMonth() + 1).padStart(2, '0');
    const d = String(instDate.getDate()).padStart(2, '0');
    const dueDateStr = `${y}-${m}-${d}`;

    const cleanTitle = title || 'Conta Agendada';
    const fullTitle = count > 1 ? `${cleanTitle} (${i}/${count})` : cleanTitle;

    const res = stmt.run(
      userId,
      fullTitle,
      amountPerInstallment,
      dueDateStr,
      category || 'Contas',
      i,
      count,
      sourceType
    );

    const billObj = {
      id: res.lastInsertRowid,
      userId,
      title: fullTitle,
      amount: amountPerInstallment,
      dueDate: dueDateStr,
      category,
      installmentCurrent: i,
      installmentTotal: count,
    };
    createdBills.push(billObj);

    // Financial bills are kept strictly in the assistant database & dashboard,
    // leaving Google Calendar purely for personal/non-financial commitments.
  }

  return createdBills;
}

/**
 * Get bills with flexible filters
 */
function getBills({ userId = 1, status, search, limit = 100 } = {}) {
  let sql = 'SELECT * FROM scheduled_payments WHERE user_id = ?';
  const params = [userId];

  if (status && status !== 'ALL') {
    sql += ' AND status = ?';
    params.push(status);
  }

  if (search) {
    sql += ' AND (title LIKE ? OR category LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY due_date ASC, id ASC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get bills due today
 */
function getBillsDueToday(userId = 1) {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .prepare(`
      SELECT * FROM scheduled_payments
      WHERE user_id = ? AND status = 'PENDING' AND due_date = ?
    `)
    .all(userId, today);
}

/**
 * Get bills due tomorrow
 */
function getBillsDueTomorrow(userId = 1) {
  const tom = new Date();
  tom.setDate(tom.getDate() + 1);
  const tomorrowStr = tom.toISOString().slice(0, 10);

  return db
    .prepare(`
      SELECT * FROM scheduled_payments
      WHERE user_id = ? AND status = 'PENDING' AND due_date = ?
    `)
    .all(userId, tomorrowStr);
}

/**
 * Mark a bill as PAID and automatically create an expense
 */
function markAsPaid(billId, userId = null) {
  const bill = db.prepare('SELECT * FROM scheduled_payments WHERE id = ?').get(billId);
  if (!bill) {
    throw new Error('Pagamento agendado não encontrado.');
  }

  // Update status to PAID
  db.prepare(`UPDATE scheduled_payments SET status = 'PAID' WHERE id = ?`).run(billId);

  // Automatically register in expenses table with bill's user_id
  const targetUserId = userId || bill.user_id || 1;
  const expense = financeService.addExpense({
    userId: targetUserId,
    amount: bill.amount,
    category: bill.category || 'Contas',
    description: `Pagamento: ${bill.title}`,
    paymentMethod: 'Boleto / Transferência',
    date: new Date().toISOString(),
    sourceType: bill.source_type || 'scheduled',
  });

  return { bill, expense };
}

/**
 * Mark bill as paid by name / search match
 */
function markAsPaidBySearch(searchTerm) {
  return markAsPaidSmart({ searchTerm });
}

/**
 * Update a scheduled payment by search or get the latest pending bill
 * If the bill is part of an installment plan, updates all installments consistently
 */
function updateBillSmart({ userId = 1, searchTerm, newTitle, newAmount, newDueDate, newCategory } = {}) {
  let target = null;

  if (searchTerm) {
    target = db.prepare(`
      SELECT * FROM scheduled_payments
      WHERE user_id = ? AND title LIKE ?
      ORDER BY id DESC LIMIT 1
    `).get(userId, `%${searchTerm}%`);

    if (!target) {
      throw new Error(`Nenhuma conta ou boleto agendado encontrado correspondente a "${searchTerm}".`);
    }
  } else {
    // If no search term at all, take the latest bill created
    target = db.prepare(`
      SELECT * FROM scheduled_payments
      WHERE user_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(userId);
  }

  if (!target) {
    throw new Error('Nenhuma conta encontrada para atualizar.');
  }

  const updatedCategory = newCategory || target.category;
  const isInstallment = (target.installment_total && target.installment_total > 1) || /\(\d+\/\d+\)$/.test(target.title);

  if (isInstallment) {
    const baseTitle = target.title.replace(/\s*\(\d+\/\d+\)$/, '').trim();
    const effectiveBaseTitle = newTitle || baseTitle;

    // Find all sibling installments of this purchase
    const installments = db.prepare(`
      SELECT * FROM scheduled_payments
      WHERE user_id = ? AND (title LIKE ? OR title LIKE ?)
      ORDER BY installment_current ASC, id ASC
    `).all(userId, `${baseTitle} (%`, `${baseTitle}%`);

    if (installments.length > 0) {
      for (const inst of installments) {
        const instTitle = newTitle
          ? `${newTitle} (${inst.installment_current}/${inst.installment_total})`
          : inst.title;
        const instAmount = newAmount !== undefined && newAmount !== null ? Number(newAmount) : inst.amount;

        db.prepare(`
          UPDATE scheduled_payments
          SET title = ?, amount = ?, category = ?
          WHERE id = ?
        `).run(instTitle, instAmount, updatedCategory, inst.id);
      }

      // If user specifically changed dueDate, update the target or recalculate
      if (newDueDate) {
        db.prepare('UPDATE scheduled_payments SET due_date = ? WHERE id = ?').run(newDueDate, target.id);
      }

      const refreshedTarget = db.prepare('SELECT * FROM scheduled_payments WHERE id = ?').get(target.id);
      return Object.assign(refreshedTarget, {
        isInstallment: true,
        installmentCount: installments.length,
        baseTitle: effectiveBaseTitle,
      });
    }
  }

  // Single bill update
  const updatedTitle = newTitle || target.title;
  const updatedAmount = newAmount !== undefined && newAmount !== null ? Number(newAmount) : target.amount;
  const updatedDueDate = newDueDate || target.due_date;

  db.prepare(`
    UPDATE scheduled_payments
    SET title = ?, amount = ?, due_date = ?, category = ?
    WHERE id = ?
  `).run(updatedTitle, updatedAmount, updatedDueDate, updatedCategory, target.id);

  const singleUpdated = db.prepare('SELECT * FROM scheduled_payments WHERE id = ?').get(target.id);
  return Object.assign(singleUpdated, {
    isInstallment: false,
    installmentCount: 1,
    baseTitle: updatedTitle,
  });
}

/**
 * Find matching pending bills based on search criteria
 */
function findPendingBills({ userId = 1, searchTerm, month, amount } = {}) {
  const todayStr = new Date().toISOString().slice(0, 10);

  let cleanSearch = '';
  if (searchTerm) {
    cleanSearch = searchTerm
      .replace(/\b(pagamento|pagamentos|conta|contas|de|do|da|dos|das|mes|mês|feito|feita|feitos|feitas|ok|pago|paga|pagos|pagas|boleto|boletos|ja|já|ta|tá)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 1. If specific search term provided (e.g. "telefone", "luz", "flavia")
  if (cleanSearch && cleanSearch.length >= 2) {
    let query = "SELECT * FROM scheduled_payments WHERE user_id = ? AND status = 'PENDING' AND title LIKE ?";
    const params = [userId, `%${cleanSearch}%`];

    if (month) {
      const monthStr = String(month).padStart(2, '0');
      query += " AND due_date LIKE ?";
      params.push(`%-${monthStr}-%`);
    }

    if (amount && Number(amount) > 0) {
      query += " AND ABS(amount - ?) < 1";
      params.push(Number(amount));
    }

    query += " ORDER BY due_date ASC, id ASC";
    const bills = db.prepare(query).all(...params);
    if (bills.length > 0) return bills;

    // Fallback if month/amount didn't match, search by title only
    const byTitle = db.prepare(`
      SELECT * FROM scheduled_payments
      WHERE user_id = ? AND status = 'PENDING' AND title LIKE ?
      ORDER BY due_date ASC, id ASC
    `).all(userId, `%${cleanSearch}%`);
    if (byTitle.length > 0) return byTitle;
  }

  // 2. If month is provided (e.g. "conta do mes 10")
  if (month) {
    const monthStr = String(month).padStart(2, '0');
    const byMonth = db.prepare(`
      SELECT * FROM scheduled_payments
      WHERE user_id = ? AND status = 'PENDING' AND due_date LIKE ?
      ORDER BY due_date ASC, id ASC
    `).all(userId, `%-${monthStr}-%`);
    if (byMonth.length > 0) return byMonth;
  }

  // 3. Generic confirmation (e.g. "pagamento de conta ok", "paguei a conta", "boleto pago")
  // First priority: check if there are OVERDUE pending bills (due_date < today)
  const overdueBills = db.prepare(`
    SELECT * FROM scheduled_payments
    WHERE user_id = ? AND status = 'PENDING' AND due_date < ?
    ORDER BY due_date ASC, id ASC
  `).all(userId, todayStr);

  if (overdueBills.length > 0) {
    return overdueBills;
  }

  // Second priority: check bills due today
  const todayBills = db.prepare(`
    SELECT * FROM scheduled_payments
    WHERE user_id = ? AND status = 'PENDING' AND due_date = ?
    ORDER BY due_date ASC, id ASC
  `).all(userId, todayStr);

  if (todayBills.length > 0) {
    return todayBills;
  }

  // Third priority: return earliest upcoming pending bills (up to 5)
  return db.prepare(`
    SELECT * FROM scheduled_payments
    WHERE user_id = ? AND status = 'PENDING'
    ORDER BY due_date ASC, id ASC
    LIMIT 5
  `).all(userId);
}

/**
 * Super flexible payment confirmation with disambiguation support
 */
function markAsPaidSmart({ userId = 1, searchTerm, month, amount } = {}) {
  const candidates = findPendingBills({ userId, searchTerm, month, amount });

  if (candidates.length === 0) {
    return { status: 'NOT_FOUND' };
  }

  if (candidates.length === 1) {
    const result = markAsPaid(candidates[0].id, userId);
    return { status: 'PAID_SINGLE', ...result };
  }

  // Multiple candidates! Ask user whether they paid all or just the oldest
  return {
    status: 'MULTIPLE_BILLS',
    bills: candidates,
  };
}

/**
 * Mark multiple bills as paid at once
 */
function markMultipleAsPaid(billIds) {
  const results = [];
  for (const id of billIds) {
    results.push(markAsPaid(id));
  }
  return results;
}

/**
 * Delete a scheduled payment
 */
function deleteBill(billId) {
  return db.prepare('DELETE FROM scheduled_payments WHERE id = ?').run(billId);
}

/**
 * Flag bill as notified
 */
function setNotified(billId, type) {
  if (type === '1d') {
    db.prepare('UPDATE scheduled_payments SET notified_1d = 1 WHERE id = ?').run(billId);
  } else if (type === 'due') {
    db.prepare('UPDATE scheduled_payments SET notified_due = 1 WHERE id = ?').run(billId);
  }
}

module.exports = {
  addScheduledPayment,
  getBills,
  getBillsDueToday,
  getBillsDueTomorrow,
  findPendingBills,
  markAsPaid,
  markAsPaidBySearch,
  markAsPaidSmart,
  markMultipleAsPaid,
  updateBillSmart,
  deleteBill,
  setNotified,
};
