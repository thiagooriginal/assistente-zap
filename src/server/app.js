const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('../database/db');
const financeService = require('../services/financeService');
const billService = require('../services/billService');
const appointmentService = require('../services/appointmentService');
const userService = require('../services/userService');
const pixService = require('../services/pixService');
const config = require('../config');
const aiService = require('../services/aiService');
const calendarService = require('../services/calendarService');
const whatsappClient = require('../whatsapp/client');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../../public')));

// Helper to extract cookies from request header
function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// Multi-Tenant Authentication Middleware
function authMiddleware(req, res, next) {
  let token = null;

  // 1. Authorization header: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // 2. Custom header
  if (!token && req.headers['x-auth-token']) {
    token = req.headers['x-auth-token'];
  }

  // 3. Query string token
  if (!token && req.query.token) {
    token = req.query.token;
  }

  // 4. Cookie
  if (!token) {
    token = getCookie(req, 'auth_token');
  }

  if (token) {
    const user = userService.getUserByMagicToken(token);
    if (user) {
      req.user = user;
      return next();
    }
  }

  // Fallback for localhost (local developer/owner access defaults to user 1)
  const isLocalhost =
    req.ip === '127.0.0.1' ||
    req.ip === '::1' ||
    req.ip === '::ffff:127.0.0.1' ||
    req.hostname === 'localhost';

  if (isLocalhost) {
    req.user = userService.getUserById(1) || { id: 1, phone_number: '5511951364159', role: 'ADMIN', plan: 'PRO' };
    return next();
  }

  // If unauthorized for API routes
  return res.status(401).json({
    success: false,
    error: 'Acesso não autorizado. Solicite o link exclusivo do seu painel no WhatsApp.',
  });
}

// ==========================================
// SYSTEM HEALTH CHECK & DIAGNOSTICS ENDPOINT
// ==========================================
app.get('/api/health', async (req, res) => {
  let geminiWorking = false;
  let geminiDetails = null;

  if (config.geminiApiKey) {
    try {
      const test = await aiService.processTextMessage('Padaria 10');
      if (test && test.intent) {
        geminiWorking = true;
        geminiDetails = 'IA Gemini ativa, autenticada e respondendo normalmente.';
      } else {
        geminiWorking = false;
        geminiDetails = 'Resposta inesperada da IA.';
      }
    } catch (e) {
      geminiWorking = false;
      geminiDetails = `Erro ao testar Gemini: ${e.message}`;
    }
  } else {
    geminiDetails = 'GEMINI_API_KEY não encontrada nas variáveis de ambiente.';
  }

  const isConnected = whatsappClient.isWhatsAppConnected ? whatsappClient.isWhatsAppConnected() : false;
  const waUser = whatsappClient.getWhatsAppUser ? whatsappClient.getWhatsAppUser() : null;

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gemini: {
      configured: Boolean(config.geminiApiKey),
      keyLength: config.geminiApiKey ? config.geminiApiKey.length : 0,
      keyPrefix: config.geminiApiKey ? config.geminiApiKey.substring(0, 6) + '...' : null,
      working: geminiWorking,
      details: geminiDetails,
    },
    whatsapp: {
      connected: isConnected,
      phone: waUser?.id ? waUser.id.split(':')[0] : null,
    },
    calendar: {
      connected: calendarService.isCalendarConnected(),
      calendarId: config.googleCalendarId,
    },
  });
});

// ==========================================
// 1-CLICK PASSWORDLESS MAGIC LINK ENDPOINT
// ==========================================
app.get('/auth/magic', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('Token de acesso não fornecido.');
  }

  const user = userService.getUserByMagicToken(token);
  if (!user) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Link Expirado | Assistente Zap</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-[#080C15] text-slate-100 flex items-center justify-center min-h-screen p-4 text-center font-sans">
        <div class="max-w-md bg-[#131B2E] p-8 rounded-2xl border border-red-500/30 shadow-2xl">
          <div class="w-16 h-16 mx-auto mb-4 bg-red-500/10 rounded-full flex items-center justify-center text-red-400 text-3xl">⚠️</div>
          <h2 class="text-2xl font-bold mb-2">Link Expirado ou Inválido</h2>
          <p class="text-slate-400 mb-6">Este link de acesso ao painel não é mais válido ou já expirou.</p>
          <div class="text-sm text-slate-300 bg-[#0F1626] p-4 rounded-xl border border-slate-800">
            👉 Envie a palavra <b class="text-purple-400">"painel"</b> no WhatsApp para receber um novo link instantâneo!
          </div>
        </div>
      </body>
      </html>
    `);
  }

  // Set auth cookie for 10 years (permanent)
  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; SameSite=Lax`);
  return res.redirect(`/?token=${token}`);
});

// ==========================================
// DIRECT ADMIN SHORTCUT: /admin
// ==========================================
app.get('/admin', (req, res) => {
  const adminUser = userService.getUserById(1);
  const token = adminUser ? adminUser.magic_token : '';
  if (token) {
    res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; Max-Age=${10 * 365 * 24 * 3600}; SameSite=Lax`);
  }
  return res.redirect(`/?tab=admin&token=${token}`);
});

// ==========================================
// SHOWCASE & LANDING PAGE (PAPEL RASGADO / DESCUBRA)
// ==========================================
app.get(['/descubra', '/explore'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../../public/explore.html'));
});


// ==========================================
// CURRENT AUTHENTICATED USER & PROFILE
// ==========================================
app.get('/api/me', authMiddleware, (req, res) => {
  const status = userService.isUserActive(req.user);
  res.json({
    success: true,
    user: {
      id: req.user.id,
      phoneNumber: req.user.phone_number,
      name: req.user.name,
      role: req.user.role,
      plan: req.user.plan,
      trialEndsAt: req.user.trial_ends_at,
      status,
    },
  });
});

// ==========================================
// ADMIN MANAGEMENT (ONLY ROLE = ADMIN)
// ==========================================
app.get('/api/admin/users', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const users = userService.getAllUsers();
  res.json({ success: true, count: users.length, data: users });
});

app.put('/api/admin/users/:id/plan', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const { id } = req.params;
  const { plan, role } = req.body;
  const updated = userService.updateUser(id, { plan, role });
  res.json({ success: true, data: updated });
});

app.delete('/api/admin/users/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  try {
    userService.deleteUser(Number(req.params.id));
    res.json({ success: true, message: 'Usuário removido com sucesso' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/invites', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const invites = userService.getAllInvites();
  res.json({ success: true, count: invites.length, data: invites });
});

app.post('/api/admin/invites', authMiddleware, (req, res) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Acesso restrito ao administrador.' });
  }
  const trialDays = req.body.trialDays || 7;
  const invite = userService.createInviteCode({ createdBy: req.user.id, trialDays });
  res.status(201).json({ success: true, data: invite });
});

// ==========================================
// GOOGLE CALENDAR SETUP & SYNC API
// ==========================================
app.post('/api/admin/calendar/setup', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey || req.body?.adminKey;
    const isLocal =
      req.ip === '127.0.0.1' ||
      req.ip === '::1' ||
      req.ip === '::ffff:127.0.0.1' ||
      req.hostname === 'localhost';

    let authorized = isLocal;
    if (!authorized && adminKey && (adminKey === config.geminiApiKey || adminKey === 'assistente-zap-sync')) {
      authorized = true;
    }
    if (!authorized) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '') || req.query.token || req.body?.token;
      if (token) {
        const user = userService.getUserByMagicToken(token);
        if (user && (user.role === 'ADMIN' || user.id === 1)) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return res.status(401).json({ success: false, error: 'Acesso não autorizado para configurar o Calendar.' });
    }

    const { credentials, token } = req.body;
    if (!credentials && !token) {
      return res.status(400).json({ success: false, error: 'Credenciais ou token não fornecidos.' });
    }

    const connected = calendarService.saveCredentialsAndToken({ credentials, token });
    let syncResult = { synced: 0 };
    if (connected) {
      const appointmentService = require('../services/appointmentService');
      syncResult = await appointmentService.syncPendingAdminAppointmentsToGoogle();
    }

    res.json({
      success: true,
      calendarConnected: connected,
      syncResult,
      message: connected
        ? `Google Calendar conectado com sucesso! ${syncResult.synced || 0} compromisso(s) pendente(s) sincronizado(s).`
        : 'Credenciais recebidas, mas aguardando validação do token.',
    });
  } catch (err) {
    console.error('Erro na rota /api/admin/calendar/setup:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/calendar/sync', async (req, res) => {
  try {
    const appointmentService = require('../services/appointmentService');
    const syncResult = await appointmentService.syncPendingAdminAppointmentsToGoogle();
    res.json({ success: true, ...syncResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PIX SUBSCRIPTION / PAYMENT API (R$ 29,00)
// ==========================================
app.get('/api/pix', authMiddleware, async (req, res) => {
  try {
    const details = await pixService.getPixPaymentDetails(req.user?.id);
    res.json({
      success: true,
      data: details,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// EXPENSES API (TENANT ISOLATED)
// ==========================================
// 1. List expenses with optional filters
app.get('/api/expenses', authMiddleware, (req, res) => {
  try {
    const { category, search, startDate, endDate } = req.query;
    let sql = 'SELECT * FROM expenses WHERE user_id = ?';
    const params = [req.user.id];

    if (category && category !== 'Todas') {
      sql += ' AND category = ?';
      params.push(category);
    }

    if (search) {
      sql += ' AND (description LIKE ? OR category LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (startDate) {
      sql += ' AND date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND date <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY date DESC, id DESC';
    const rows = db.prepare(sql).all(...params);

    res.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Add an expense manually from the dashboard
app.post('/api/expenses', authMiddleware, (req, res) => {
  try {
    const { amount, category, description, paymentMethod, date } = req.body;
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido' });
    }

    const saved = financeService.addExpense({
      userId: req.user.id,
      amount: Number(amount),
      category: category || 'Outros',
      description: description || 'Lançamento manual',
      paymentMethod: paymentMethod || 'Outro',
      date: date ? new Date(date).toISOString() : new Date().toISOString(),
      sourceType: 'dashboard',
    });

    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Edit an expense (ownership guaranteed)
app.put('/api/expenses/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { amount, category, description, paymentMethod, date } = req.body;

    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Gasto não encontrado' });
    }

    const normCat = category ? financeService.normalizeCategory(category) : existing.category;

    db.prepare(`
      UPDATE expenses
      SET amount = ?, category = ?, description = ?, payment_method = ?, date = ?
      WHERE id = ? AND user_id = ?
    `).run(
      amount !== undefined ? Number(amount) : existing.amount,
      normCat,
      description !== undefined ? description : existing.description,
      paymentMethod !== undefined ? paymentMethod : existing.payment_method,
      date || existing.date,
      id,
      req.user.id
    );

    const updated = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Delete an expense (ownership guaranteed)
app.delete('/api/expenses/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Gasto não encontrado' });
    }

    db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Gasto removido com sucesso', data: existing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Get aggregate statistics (isolated for current user)
app.get('/api/stats', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7); // 'YYYY-MM'
    const today = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();

    // Total Month
    const monthRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${currentMonth}%`);

    // Total Today
    const todayRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND date LIKE ?
    `).get(userId, `${today}%`);

    // Gasoline last 15 days
    const gasRow = db.prepare(`
      SELECT SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ? AND (category LIKE '%Gasolina%' OR description LIKE '%gasolina%')
        AND date >= ?
    `).get(userId, fifteenDaysAgo);

    // All categories distribution
    const categoryRows = db.prepare(`
      SELECT category, SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ?
      GROUP BY category
      ORDER BY total DESC
    `).all(userId);

    // Payment methods distribution
    const paymentRows = db.prepare(`
      SELECT payment_method, SUM(amount) as total, COUNT(*) as count
      FROM expenses
      WHERE user_id = ?
      GROUP BY payment_method
      ORDER BY total DESC
    `).all(userId);

    // Daily breakdown for the last 14 days
    const dailyStats = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStr = d.toISOString().slice(0, 10);
      const row = db.prepare(`
        SELECT SUM(amount) as total
        FROM expenses
        WHERE user_id = ? AND date LIKE ?
      `).get(userId, `${dayStr}%`);

      dailyStats.push({
        date: dayStr,
        displayDate: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        total: Number(row?.total || 0),
      });
    }

    const totalMonthNum = Number(monthRow?.total || 0);
    const categoriesWithPercent = categoryRows.map((cat) => ({
      ...cat,
      total: Number(cat.total),
      percentage: totalMonthNum > 0 ? ((Number(cat.total) / totalMonthNum) * 100).toFixed(1) : 0,
    }));

    res.json({
      success: true,
      data: {
        totalMonth: totalMonthNum,
        countMonth: Number(monthRow?.count || 0),
        totalToday: Number(todayRow?.total || 0),
        countToday: Number(todayRow?.count || 0),
        totalGasoline15Days: Number(gasRow?.total || 0),
        countGasoline15Days: Number(gasRow?.count || 0),
        categories: categoriesWithPercent,
        payments: paymentRows,
        daily: dailyStats,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Export to CSV (tenant isolated)
app.get('/api/export/csv', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC').all(req.user.id);
    let csv = 'ID;Data;Valor;Categoria;Descricao;FormaPagamento;Origem\n';

    for (const r of rows) {
      const dateStr = financeService.formatDateBR(r.date);
      const valStr = Number(r.amount).toFixed(2).replace('.', ',');
      const desc = (r.description || '').replace(/;/g, ' ');
      const cat = (r.category || '').replace(/;/g, ' ');
      const pay = (r.payment_method || '').replace(/;/g, ' ');
      csv += `${r.id};"${dateStr}";"${valStr}";"${cat}";"${desc}";"${pay}";"${r.source_type}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gastos_assistente.csv"');
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).send('Erro ao exportar CSV: ' + err.message);
  }
});

// ==========================================
// BILLS & SCHEDULED PAYMENTS (TENANT ISOLATED)
// ==========================================
// 7. Get scheduled payments / bills
app.get('/api/bills', authMiddleware, (req, res) => {
  try {
    const { status, search } = req.query;
    const bills = billService.getBills({ userId: req.user.id, status, search });
    res.json({ success: true, count: bills.length, data: bills });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Create scheduled payment or installment from dashboard
app.post('/api/bills', authMiddleware, async (req, res) => {
  try {
    const { title, totalAmount, installmentAmount, installments, firstDueDate, category } = req.body;
    const created = await billService.addScheduledPayment({
      userId: req.user.id,
      title: title || 'Conta',
      totalAmount,
      installmentAmount,
      installments: installments || 1,
      firstDueDate,
      category: category || 'Contas',
      sourceType: 'dashboard',
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Mark bill as PAID (ownership checked)
app.put('/api/bills/:id/pay', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM scheduled_payments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Conta não encontrada' });
    }
    const result = billService.markAsPaid(id, req.user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Delete a bill (ownership checked)
app.delete('/api/bills/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM scheduled_payments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Conta não encontrada' });
    }
    billService.deleteBill(id);
    res.json({ success: true, message: 'Conta removida com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// APPOINTMENTS & AGENDA (TENANT ISOLATED)
// ==========================================
// 11. Get scheduled appointments
app.get('/api/appointments', authMiddleware, (req, res) => {
  try {
    const status = req.query.status || 'SCHEDULED';
    const appointments = appointmentService.getAppointments({ userId: req.user.id, status });
    res.json({ success: true, count: appointments.length, data: appointments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Create an appointment from dashboard
app.post('/api/appointments', authMiddleware, (req, res) => {
  try {
    const { title, description, startDateTime, endDateTime, location } = req.body;
    if (!title || !startDateTime) {
      return res.status(400).json({ success: false, error: 'Título e data/horário de início são obrigatórios' });
    }

    const created = appointmentService.createAppointment({
      userId: req.user.id,
      title,
      description,
      startDateTime,
      endDateTime,
      location,
      sourceType: 'dashboard',
    });

    res.status(201).json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. Cancel/Delete an appointment (ownership checked)
app.delete('/api/appointments/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Compromisso não encontrado' });
    }

    appointmentService.deleteAppointment(id, req.user.id);
    res.json({ success: true, message: 'Compromisso desmarcado com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function startServer(port = 3333) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`\n📊 Dashboard financeiro Multi-Tenant disponível em: http://localhost:${port}`);
      resolve(server);
    });
  });
}

module.exports = { app, startServer };
