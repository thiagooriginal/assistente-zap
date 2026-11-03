const db = require('../database/db');
const financeService = require('./financeService');
const productService = require('./productService');

/**
 * Helper to get date string in America/Sao_Paulo (UTC-3)
 */
function getSaoPauloDate(d = new Date()) {
  // Offset -3 hours for Sao Paulo
  const spOffset = -3 * 60; // in minutes
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const spDate = new Date(utc + (spOffset * 60000));
  const y = spDate.getFullYear();
  const m = String(spDate.getMonth() + 1).padStart(2, '0');
  const day = String(spDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute start and end dates based on period filter
 */
function getPeriodDates(period = 'this_month', customStart = null, customEnd = null) {
  const todayStr = getSaoPauloDate();
  const [currY, currM, currD] = todayStr.split('-').map(Number);

  let startDate = todayStr;
  let endDate = todayStr;
  let prevStartDate = null;
  let prevEndDate = null;
  let periodLabel = 'Este mês';

  if (period === 'today') {
    startDate = todayStr;
    endDate = todayStr;
    periodLabel = 'Hoje';

    // Yesterday
    const prevD = new Date(currY, currM - 1, currD - 1);
    prevStartDate = getSaoPauloDate(prevD);
    prevEndDate = prevStartDate;
  } else if (period === '7d') {
    const startD = new Date(currY, currM - 1, currD - 6);
    startDate = getSaoPauloDate(startD);
    endDate = todayStr;
    periodLabel = 'Últimos 7 dias';

    const pEnd = new Date(currY, currM - 1, currD - 7);
    const pStart = new Date(currY, currM - 1, currD - 13);
    prevStartDate = getSaoPauloDate(pStart);
    prevEndDate = getSaoPauloDate(pEnd);
  } else if (period === 'last_month') {
    const lastMYear = currM === 1 ? currY - 1 : currY;
    const lastMonth = currM === 1 ? 12 : currM - 1;
    const lastDayOfLastM = new Date(lastMYear, lastMonth, 0).getDate();

    startDate = `${lastMYear}-${String(lastMonth).padStart(2, '0')}-01`;
    endDate = `${lastMYear}-${String(lastMonth).padStart(2, '0')}-${String(lastDayOfLastM).padStart(2, '0')}`;
    periodLabel = 'Mês anterior';

    // 2 months ago for comparison
    const twoMonthsAgoYear = lastMonth === 1 ? lastMYear - 1 : lastMYear;
    const twoMonthsAgoM = lastMonth === 1 ? 12 : lastMonth - 1;
    const lastDay2M = new Date(twoMonthsAgoYear, twoMonthsAgoM, 0).getDate();
    prevStartDate = `${twoMonthsAgoYear}-${String(twoMonthsAgoM).padStart(2, '0')}-01`;
    prevEndDate = `${twoMonthsAgoYear}-${String(twoMonthsAgoM).padStart(2, '0')}-${String(lastDay2M).padStart(2, '0')}`;
  } else if (period === 'custom' && customStart && customEnd) {
    // Validate custom dates YYYY-MM-DD
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (dateRegex.test(customStart) && dateRegex.test(customEnd) && customStart <= customEnd) {
      startDate = customStart;
      endDate = customEnd;
      periodLabel = `${customStart.split('-').reverse().join('/')} até ${customEnd.split('-').reverse().join('/')}`;

      // Equal length prior period using local calendar date math
      const [sy, sm, sd] = customStart.split('-').map(Number);
      const [ey, em, ed] = customEnd.split('-').map(Number);
      const s = new Date(sy, sm - 1, sd);
      const e = new Date(ey, em - 1, ed);
      const diffDays = Math.max(1, Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1);

      const pe = new Date(sy, sm - 1, sd - 1);
      const ps = new Date(sy, sm - 1, sd - diffDays);

      const toDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      prevStartDate = toDateStr(ps);
      prevEndDate = toDateStr(pe);
    } else {
      // Fallback to this_month
      startDate = `${currY}-${String(currM).padStart(2, '0')}-01`;
      endDate = todayStr;
      periodLabel = 'Este mês';
    }
  } else {
    // Default: this_month
    startDate = `${currY}-${String(currM).padStart(2, '0')}-01`;
    const lastDayCurrM = new Date(currY, currM, 0).getDate();
    endDate = `${currY}-${String(currM).padStart(2, '0')}-${String(lastDayCurrM).padStart(2, '0')}`;
    periodLabel = 'Este mês';

    const lastMYear = currM === 1 ? currY - 1 : currY;
    const lastMonth = currM === 1 ? 12 : currM - 1;
    const lastDayOfLastM = new Date(lastMYear, lastMonth, 0).getDate();
    prevStartDate = `${lastMYear}-${String(lastMonth).padStart(2, '0')}-01`;
    prevEndDate = `${lastMYear}-${String(lastMonth).padStart(2, '0')}-${String(lastDayOfLastM).padStart(2, '0')}`;
  }

  return { startDate, endDate, prevStartDate, prevEndDate, periodLabel, period };
}

/**
 * Determine effective Jéssica subscription tier with strict verification
 */
function getEffectiveJessicaTier(userId, user = null) {
  if (!user && userId) {
    user = db.prepare('SELECT id, role, is_demo, plan_tier, subscription_status, paid_until FROM users WHERE id = ?').get(userId);
  }
  if (!user) return 'JESSICA_START';

  // Master Admin or authorized Demo Account
  if (user.role === 'ADMIN' || Boolean(user.is_demo)) {
    return 'JESSICA_PRO';
  }

  // Strictly check product access via productService
  const access = productService.hasProductAccess(user.id, 'JESSICA');
  if (!access.hasAccess) {
    // Subscription is PENDING, OVERDUE, EXPIRED, CANCELED (past paid_until), or INACTIVE
    return 'JESSICA_START';
  }

  // If access is granted via customer_subscriptions
  if (access.subscription) {
    const code = String(access.subscription.planCode || access.subscription.plan_code || '').toUpperCase();
    if (code === 'PRO' || code === 'JESSICA_PRO') return 'JESSICA_PRO';
    if (code === 'INTERMEDIATE' || code === 'JESSICA_INTERMEDIATE') return 'JESSICA_INTERMEDIATE';
    if (code === 'START' || code === 'JESSICA_START') return 'JESSICA_START';
  }

  // If access is granted via verified legacy contract
  if (access.reason === 'LEGACY_ACTIVE') {
    const isPaid = user.paid_until && new Date(user.paid_until) >= new Date();
    const isActiveStatus = ['ACTIVE', 'TRIAL'].includes(String(user.subscription_status || '').toUpperCase());
    if (isActiveStatus && isPaid) {
      const rawTier = String(user.plan_tier || '').toUpperCase();
      if (rawTier.includes('PRO')) return 'JESSICA_PRO';
      if (rawTier.includes('INTERMEDIATE')) return 'JESSICA_INTERMEDIATE';
      return 'JESSICA_START';
    }
  }

  return 'JESSICA_START';
}

/**
 * Compute percentage variation only if prevValue > 0
 */
function calcVariation(curr, prev) {
  if (prev && prev > 0) {
    const diff = curr - prev;
    const pct = Math.round((diff / prev) * 1000) / 10;
    return {
      percent: pct,
      formatted: `${pct >= 0 ? '+' : ''}${pct.toFixed(1).replace('.', ',')}%`,
      direction: pct >= 0 ? 'up' : 'down',
      hasHistory: true,
    };
  }
  return {
    percent: null,
    formatted: null,
    direction: 'neutral',
    hasHistory: false,
  };
}

/**
 * Generate dates array between start and end
 */
function getDateRangeArray(startStr, endStr) {
  const dates = [];
  const curr = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  let safety = 0;
  while (curr <= end && safety < 366) {
    dates.push(getSaoPauloDate(curr));
    curr.setDate(curr.getDate() + 1);
    safety++;
  }
  return dates;
}

/**
 * Get dashboard metrics for demo account (Bella Vista Hair & Spa)
 */
function getDemoDashboardData(periodInfo, isPro = true) {
  const { period, startDate, endDate, periodLabel } = periodInfo;

  const dateArr = getDateRangeArray(startDate, endDate);
  const daysCount = Math.max(1, dateArr.length);

  const baseDailyRealized = 428.33;
  const baseDailyEstimated = 114.00;
  const baseDailyExpenses = 159.33;

  const realizedRevenue = Math.round(baseDailyRealized * daysCount * 100) / 100;
  const estimatedRevenue = Math.round(baseDailyEstimated * daysCount * 100) / 100;
  const expensesTotal = Math.round(baseDailyExpenses * daysCount * 100) / 100;
  const financialResult = Math.round((realizedRevenue - expensesTotal) * 100) / 100;

  const totalAppointments = Math.max(daysCount * 5, 6);
  const completedAppointments = Math.max(daysCount * 4, 5);
  const cancelledAppointments = Math.max(Math.round(daysCount * 0.3), 1);
  const averageTicket = completedAppointments > 0
    ? Math.round((realizedRevenue / completedAppointments) * 100) / 100
    : 85.00;

  // Timeline
  const timeline = dateArr.map((d, idx) => {
    const dayFactor = 0.7 + (((idx * 7) % 11) / 15);
    const dayRealized = Math.round(baseDailyRealized * dayFactor * 100) / 100;
    const dayExpense = (idx % 3 === 0) ? Math.round(baseDailyExpenses * 2.2 * 100) / 100 : 0;
    const [y, m, day] = d.split('-');
    return {
      date: d,
      label: `${day}/${m}`,
      receitas: dayRealized,
      despesas: dayExpense,
      resultado: Math.round((dayRealized - dayExpense) * 100) / 100,
    };
  });

  // Services
  const services = [
    { name: 'Corte Feminino & Visagismo', count: Math.round(completedAppointments * 0.35), revenue: Math.round(realizedRevenue * 0.32), price: 110.00 },
    { name: 'Mechas Criativas & Blond', count: Math.round(completedAppointments * 0.18), revenue: Math.round(realizedRevenue * 0.38), price: 350.00 },
    { name: 'Cronograma Capilar & Nutrição', count: Math.round(completedAppointments * 0.22), revenue: Math.round(realizedRevenue * 0.15), price: 140.00 },
    { name: 'Escova Modeladora & Tratamento', count: Math.round(completedAppointments * 0.15), revenue: Math.round(realizedRevenue * 0.09), price: 75.00 },
    { name: 'Manicure & Spa dos Pés', count: Math.round(completedAppointments * 0.10), revenue: Math.round(realizedRevenue * 0.06), price: 65.00 },
  ];

  // Staff
  const staff = [
    {
      id: 1,
      name: 'Jéssica Ramos',
      specialty: 'Master Hairstylist & Colorista',
      appointments: Math.round(completedAppointments * 0.52),
      revenue: Math.round(realizedRevenue * 0.55),
      avgTicket: 91.50,
      sharePercent: 55.0,
    },
    {
      id: 2,
      name: 'Camila Santos',
      specialty: 'Especialista em Mechas & Tratamento',
      appointments: Math.round(completedAppointments * 0.28),
      revenue: Math.round(realizedRevenue * 0.30),
      avgTicket: 93.20,
      sharePercent: 30.0,
    },
    {
      id: 3,
      name: 'Rafael Costa',
      specialty: 'Cortes & Terapia Capilar',
      appointments: Math.round(completedAppointments * 0.20),
      revenue: Math.round(realizedRevenue * 0.15),
      avgTicket: 65.25,
      sharePercent: 15.0,
    },
  ];

  // Peak Hours
  const peakHours = [
    { hour: '09:00', count: Math.round(totalAppointments * 0.08) },
    { hour: '10:00', count: Math.round(totalAppointments * 0.14) },
    { hour: '11:00', count: Math.round(totalAppointments * 0.12) },
    { hour: '14:00', count: Math.round(totalAppointments * 0.18) },
    { hour: '15:00', count: Math.round(totalAppointments * 0.22) },
    { hour: '16:00', count: Math.round(totalAppointments * 0.15) },
    { hour: '17:00', count: Math.round(totalAppointments * 0.11) },
  ];

  // Demo Bills to Pay (Gated by isPro)
  let bills = null;
  if (isPro) {
    bills = {
      pendingTotal: 2750.00,
      pendingCount: 3,
      paidTotal: 3400.00,
      paidCount: 4,
      overdueCount: 0,
      upcomingBills: [
        { id: 901, title: 'Distribuidora L\'Oréal & Wella', amount: 1450.00, due_date: `${startDate.slice(0, 7)}-20`, category: 'Produtos', status: 'PENDING' },
        { id: 902, title: 'Enel Energia Elétrica', amount: 680.00, due_date: `${startDate.slice(0, 7)}-22`, category: 'Contas Básicas', status: 'PENDING' },
        { id: 903, title: 'Software & Internet Fibra', amount: 620.00, due_date: `${startDate.slice(0, 7)}-25`, category: 'Tecnologia', status: 'PENDING' },
      ],
      overdueBills: [],
      paidBills: [
        { id: 900, title: 'Aluguel do Salão Comercial', amount: 3400.00, due_date: `${startDate.slice(0, 7)}-05`, category: 'Imóvel', status: 'PAID' },
      ],
    };
  }

  // Demo Transactions
  const transactions = [
    { id: 101, type: 'INCOME', date: `${endDate} 16:30`, description: 'Mechas Criativas + Tratamento (Mariana S.)', category: 'Coloração', amount: 380.00, paymentMethod: 'Pix', origin: 'Agendamento Jéssica' },
    { id: 102, type: 'INCOME', date: `${endDate} 14:15`, description: 'Corte Feminino & Escova (Paula M.)', category: 'Cortes', amount: 140.00, paymentMethod: 'Cartão de Crédito', origin: 'Agendamento Camila' },
    { id: 103, type: 'EXPENSE', date: `${endDate} 11:20`, description: 'Café Premium & Insumos Recepção', category: 'Insumos', amount: -85.50, paymentMethod: 'Pix', origin: 'Despesa Salão' },
    { id: 104, type: 'INCOME', date: `${startDate} 10:00`, description: 'Cronograma Capilar (Fernanda R.)', category: 'Tratamentos', amount: 160.00, paymentMethod: 'Pix', origin: 'Agendamento Jéssica' },
    { id: 105, type: 'EXPENSE', date: `${startDate} 09:10`, description: 'Produtos de Limpeza & Higiene', category: 'Operacional', amount: -120.00, paymentMethod: 'Débito', origin: 'Despesa Salão' },
  ];

  return {
    success: true,
    isDemo: true,
    demoBadge: 'Dados demonstrativos — Bella Vista Hair & Spa',
    period: period,
    periodLabel: periodLabel,
    startDate: startDate,
    endDate: endDate,
    metrics: {
      realizedRevenue,
      serviceRevenue: Math.round(realizedRevenue * 0.95 * 100) / 100,
      estimatedRevenue,
      expensesTotal,
      financialResult,
      totalAppointments,
      completedAppointments,
      cancelledAppointments,
      averageTicket,
      hasSufficientData: true,

      // Backward compatibility keys
      totalRevenue: realizedRevenue,
      totalAppointments: totalAppointments,
      averageTicket: averageTicket,
      faturamentoMes: realizedRevenue,
      atendimentosMes: totalAppointments,
      ticketMedio: averageTicket,
      lucroEstimado: financialResult,
      taxaRetencao: '78.5%',
      faturamentoCrescimento: '+14.2%',
    },
    variations: {
      realizedRevenue: { percent: 14.2, formatted: '+14,2%', direction: 'up', hasHistory: true },
      expensesTotal: { percent: -4.5, formatted: '-4,5%', direction: 'down', hasHistory: true },
      totalAppointments: { percent: 8.0, formatted: '+8,0%', direction: 'up', hasHistory: true },
      completedAppointments: { percent: 9.5, formatted: '+9,5%', direction: 'up', hasHistory: true },
    },
    timeline,
    services,
    staff,
    peakHours,
    bills,
    transactions,
  };
}

/**
 * Get real dashboard data for an authenticated client user
 */
function getRealDashboardData(userId, periodInfo, isPro = true) {
  const { period, startDate, endDate, prevStartDate, prevEndDate, periodLabel } = periodInfo;

  // 1. Faturamento Realizado (Incomes where user_id = userId and date in range)
  const incomeRow = db.prepare(`
    SELECT
      COALESCE(SUM(amount), 0) AS total,
      COUNT(*) AS count
    FROM incomes
    WHERE user_id = ?
      AND substr(date, 1, 10) >= ?
      AND substr(date, 1, 10) <= ?
  `).get(userId, startDate, endDate);

  const realizedRevenue = Math.round((incomeRow?.total || 0) * 100) / 100;
  const incomesCount = incomeRow?.count || 0;

  // 2. Despesas Registradas (Expenses where user_id = userId and date in range)
  const expenseRow = db.prepare(`
    SELECT
      COALESCE(SUM(amount), 0) AS total,
      COUNT(*) AS count
    FROM expenses
    WHERE user_id = ?
      AND substr(date, 1, 10) >= ?
      AND substr(date, 1, 10) <= ?
  `).get(userId, startDate, endDate);

  const expensesTotal = Math.round((expenseRow?.total || 0) * 100) / 100;
  const expensesCount = expenseRow?.count || 0;

  // 3. Resultado Financeiro = Receitas - Despesas (resultado de caixa, não lucro contábil)
  const financialResult = Math.round((realizedRevenue - expensesTotal) * 100) / 100;

  // 4. Agendamentos no Período (Todos, Realizados, Cancelados)
  const appointmentRows = db.prepare(`
    SELECT
      id, title, start_datetime, status, price, service_id, staff_id
    FROM appointments
    WHERE user_id = ?
      AND substr(start_datetime, 1, 10) >= ?
      AND substr(start_datetime, 1, 10) <= ?
    ORDER BY start_datetime ASC
  `).all(userId, startDate, endDate);

  const totalAppointments = appointmentRows.length;

  let completedAppointments = 0;
  let cancelledAppointments = 0;
  let scheduledPendingAppointments = 0;
  let appointmentCompletedRevenue = 0;

  const userServices = db.prepare('SELECT id, name, price, category FROM client_services WHERE user_id = ?').all(userId);
  const avgServicePrice = userServices.length > 0
    ? userServices.reduce((acc, s) => acc + (s.price || 0), 0) / userServices.length
    : 0;

  appointmentRows.forEach(a => {
    const st = String(a.status || '').toUpperCase();
    if (['COMPLETED', 'REALIZADO', 'CONCLUIDO'].includes(st)) {
      completedAppointments++;
      let aptPrice = 0;
      if (a.price && Number(a.price) > 0) {
        aptPrice = Number(a.price);
      } else if (a.service_id) {
        const svc = userServices.find(s => s.id === a.service_id);
        aptPrice = svc?.price || 0;
      }
      appointmentCompletedRevenue += aptPrice;
    } else if (['CANCELLED', 'CANCELED', 'CANCELADO'].includes(st)) {
      cancelledAppointments++;
    } else {
      scheduledPendingAppointments++;
    }
  });

  // Verified service incomes from incomes table (linked to appointments or matching salon services)
  const serviceIncomes = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM incomes
    WHERE user_id = ?
      AND substr(date, 1, 10) >= ?
      AND substr(date, 1, 10) <= ?
      AND (
        appointment_id IS NOT NULL
        OR source_type IN ('appointment', 'agendamento', 'jessica_service', 'service')
        OR category IN (SELECT name FROM client_services WHERE user_id = ?)
      )
  `).get(userId, startDate, endDate, userId);

  const serviceRevenue = Math.round((serviceIncomes?.total || 0) * 100) / 100;

  // 5. Faturamento Estimado (Agendamentos pendentes/confirmados no período)
  let estimatedRevenue = 0;
  if (scheduledPendingAppointments > 0) {
    appointmentRows.forEach(a => {
      const st = String(a.status || '').toUpperCase();
      if (!['COMPLETED', 'REALIZADO', 'CONCLUIDO', 'CANCELLED', 'CANCELED', 'CANCELADO'].includes(st)) {
        if (a.price && Number(a.price) > 0) {
          estimatedRevenue += Number(a.price);
        } else if (a.service_id) {
          const svc = userServices.find(s => s.id === a.service_id);
          estimatedRevenue += svc?.price || avgServicePrice;
        } else {
          estimatedRevenue += avgServicePrice;
        }
      }
    });
  }
  estimatedRevenue = Math.round(estimatedRevenue * 100) / 100;

  // 6. Ticket Médio Rigoroso (baseado exclusivamente em atendimentos concluídos com receita identificada)
  let averageTicket = 0;
  let hasSufficientData = false;

  if (completedAppointments > 0) {
    if (appointmentCompletedRevenue > 0) {
      averageTicket = Math.round((appointmentCompletedRevenue / completedAppointments) * 100) / 100;
      hasSufficientData = true;
    } else if (serviceRevenue > 0) {
      averageTicket = Math.round((serviceRevenue / completedAppointments) * 100) / 100;
      hasSufficientData = true;
    } else if (realizedRevenue > 0 && incomesCount === completedAppointments) {
      // Direct 1-to-1 match between completed appointments and incomes
      averageTicket = Math.round((realizedRevenue / completedAppointments) * 100) / 100;
      hasSufficientData = true;
    } else {
      averageTicket = 0;
      hasSufficientData = false;
    }
  } else {
    averageTicket = 0;
    hasSufficientData = false;
  }

  // 7. Comparative Metrics (Previous period)
  let prevRealized = 0;
  let prevExpenses = 0;
  let prevTotalAppts = 0;
  let prevCompleted = 0;

  if (prevStartDate && prevEndDate) {
    const prevInc = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM incomes
      WHERE user_id = ? AND substr(date, 1, 10) >= ? AND substr(date, 1, 10) <= ?
    `).get(userId, prevStartDate, prevEndDate);
    prevRealized = prevInc?.total || 0;

    const prevExp = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
      WHERE user_id = ? AND substr(date, 1, 10) >= ? AND substr(date, 1, 10) <= ?
    `).get(userId, prevStartDate, prevEndDate);
    prevExpenses = prevExp?.total || 0;

    const prevAppts = db.prepare(`
      SELECT status FROM appointments
      WHERE user_id = ? AND substr(start_datetime, 1, 10) >= ? AND substr(start_datetime, 1, 10) <= ?
    `).all(userId, prevStartDate, prevEndDate);

    prevTotalAppts = prevAppts.length;
    prevCompleted = prevAppts.filter(a => ['COMPLETED', 'REALIZADO', 'CONCLUIDO'].includes(String(a.status || '').toUpperCase())).length;
  }

  const variations = {
    realizedRevenue: calcVariation(realizedRevenue, prevRealized),
    expensesTotal: calcVariation(expensesTotal, prevExpenses),
    totalAppointments: calcVariation(totalAppointments, prevTotalAppts),
    completedAppointments: calcVariation(completedAppointments, prevCompleted),
  };

  // 8. Timeline (Daily points for chart)
  const dateArr = getDateRangeArray(startDate, endDate);
  const dailyIncomes = db.prepare(`
    SELECT substr(date, 1, 10) as d, COALESCE(SUM(amount), 0) as total
    FROM incomes
    WHERE user_id = ? AND substr(date, 1, 10) >= ? AND substr(date, 1, 10) <= ?
    GROUP BY substr(date, 1, 10)
  `).all(userId, startDate, endDate);
  const incomeMap = {};
  dailyIncomes.forEach(r => { incomeMap[r.d] = r.total; });

  const dailyExpenses = db.prepare(`
    SELECT substr(date, 1, 10) as d, COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE user_id = ? AND substr(date, 1, 10) >= ? AND substr(date, 1, 10) <= ?
    GROUP BY substr(date, 1, 10)
  `).all(userId, startDate, endDate);
  const expenseMap = {};
  dailyExpenses.forEach(r => { expenseMap[r.d] = r.total; });

  const timeline = dateArr.map(d => {
    const [y, m, day] = d.split('-');
    const rec = Math.round((incomeMap[d] || 0) * 100) / 100;
    const desp = Math.round((expenseMap[d] || 0) * 100) / 100;
    return {
      date: d,
      label: `${day}/${m}`,
      receitas: rec,
      despesas: desp,
      resultado: Math.round((rec - desp) * 100) / 100,
    };
  });

  // 9. Services Ranking
  const serviceStatsMap = {};
  userServices.forEach(s => {
    serviceStatsMap[s.id] = { id: s.id, name: s.name, count: 0, revenue: 0, price: s.price || 0 };
  });

  appointmentRows.forEach(a => {
    if (a.service_id && serviceStatsMap[a.service_id]) {
      serviceStatsMap[a.service_id].count++;
      serviceStatsMap[a.service_id].revenue += Number(a.price) || serviceStatsMap[a.service_id].price;
    } else if (a.title) {
      const matched = userServices.find(s => a.title.toLowerCase().includes(s.name.toLowerCase()));
      if (matched && serviceStatsMap[matched.id]) {
        serviceStatsMap[matched.id].count++;
        serviceStatsMap[matched.id].revenue += Number(a.price) || matched.price;
      }
    }
  });

  const services = Object.values(serviceStatsMap)
    .sort((a, b) => b.count - a.count || b.revenue - a.revenue)
    .slice(0, 10);

  // 10. Staff Performance
  const staffMembers = db.prepare(`
    SELECT id, name, specialty FROM client_staff
    WHERE user_id = ? AND active = 1
  `).all(userId);

  const staffStatsMap = {};
  staffMembers.forEach(s => {
    staffStatsMap[s.id] = {
      id: s.id,
      name: s.name,
      specialty: s.specialty || 'Profissional',
      appointments: 0,
      revenue: 0,
      avgTicket: 0,
      sharePercent: 0,
    };
  });

  appointmentRows.forEach(a => {
    if (a.staff_id && staffStatsMap[a.staff_id]) {
      staffStatsMap[a.staff_id].appointments++;
      staffStatsMap[a.staff_id].revenue += Number(a.price) || 0;
    }
  });

  const staff = Object.values(staffStatsMap).map(st => {
    const avg = st.appointments > 0 ? Math.round((st.revenue / st.appointments) * 100) / 100 : 0;
    const share = realizedRevenue > 0 ? Math.round((st.revenue / realizedRevenue) * 1000) / 10 : 0;
    return {
      ...st,
      revenue: Math.round(st.revenue * 100) / 100,
      avgTicket: avg,
      sharePercent: share,
    };
  });

  // 11. Peak Hours Breakdown
  const hoursCountMap = {};
  for (let h = 8; h <= 20; h++) {
    const key = `${String(h).padStart(2, '0')}:00`;
    hoursCountMap[key] = 0;
  }

  appointmentRows.forEach(a => {
    if (a.start_datetime) {
      const timePart = a.start_datetime.includes('T')
        ? a.start_datetime.split('T')[1]
        : a.start_datetime.split(' ')[1];
      if (timePart) {
        const h = parseInt(timePart.split(':')[0], 10);
        if (h >= 8 && h <= 20) {
          const key = `${String(h).padStart(2, '0')}:00`;
          hoursCountMap[key] = (hoursCountMap[key] || 0) + 1;
        }
      }
    }
  });

  const peakHours = Object.entries(hoursCountMap).map(([hour, count]) => ({ hour, count }));

  // 12. Contas a Pagar (Scheduled Payments) - Exclusivo do Plano Jéssica Pró
  let bills = null;
  if (isPro) {
    const todayStr = getSaoPauloDate();
    const pendingRows = db.prepare(`
      SELECT id, title, amount, due_date, category, status, installment_current, installment_total
      FROM scheduled_payments
      WHERE user_id = ? AND status = 'PENDING'
      ORDER BY due_date ASC
    `).all(userId);

    const pendingTotal = Math.round(pendingRows.reduce((acc, b) => acc + (b.amount || 0), 0) * 100) / 100;
    const overdueBills = pendingRows.filter(b => b.due_date < todayStr);
    const upcomingBills = pendingRows.filter(b => b.due_date >= todayStr).slice(0, 10);

    const paidRows = db.prepare(`
      SELECT id, title, amount, due_date, category, status, paid_at
      FROM scheduled_payments
      WHERE user_id = ? AND status = 'PAID'
      ORDER BY due_date DESC LIMIT 10
    `).all(userId);
    const paidTotal = Math.round(paidRows.reduce((acc, b) => acc + (b.amount || 0), 0) * 100) / 100;

    bills = {
      pendingTotal,
      pendingCount: pendingRows.length,
      overdueCount: overdueBills.length,
      overdueBills,
      upcomingBills,
      paidBills: paidRows,
      paidTotal,
      paidCount: paidRows.length,
    };
  }

  // 13. Movimentações Recentes (Extrato Incomes + Expenses)
  const recentIncomes = db.prepare(`
    SELECT id, amount, source, category, payment_method, date, 'INCOME' as tx_type
    FROM incomes
    WHERE user_id = ?
    ORDER BY date DESC, id DESC LIMIT 25
  `).all(userId);

  const recentExpenses = db.prepare(`
    SELECT id, amount, description, category, payment_method, date, 'EXPENSE' as tx_type
    FROM expenses
    WHERE user_id = ?
    ORDER BY date DESC, id DESC LIMIT 25
  `).all(userId);

  const transactions = [
    ...recentIncomes.map(inc => ({
      id: inc.id,
      type: 'INCOME',
      date: inc.date,
      description: inc.source || inc.category || 'Receita Realizada',
      category: inc.category || 'Receita',
      amount: inc.amount,
      paymentMethod: inc.payment_method || 'Pix',
      origin: 'Caixa / Atendimento',
    })),
    ...recentExpenses.map(exp => ({
      id: exp.id,
      type: 'EXPENSE',
      date: exp.date,
      description: exp.description || exp.category || 'Despesa Salão',
      category: exp.category || 'Despesa',
      amount: -Math.abs(exp.amount),
      paymentMethod: exp.payment_method || 'Não informado',
      origin: 'Despesa Operacional',
    })),
  ].sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : b.id - a.id)).slice(0, 50);

  return {
    success: true,
    isDemo: false,
    period,
    periodLabel,
    startDate,
    endDate,
    metrics: {
      realizedRevenue,
      serviceRevenue,
      estimatedRevenue,
      expensesTotal,
      financialResult,
      totalAppointments,
      completedAppointments,
      cancelledAppointments,
      averageTicket,
      hasSufficientData,

      // Compatibility fields
      totalRevenue: realizedRevenue,
      totalAppointments,
      averageTicket,
      faturamentoMes: realizedRevenue,
      atendimentosMes: totalAppointments,
      ticketMedio: averageTicket,
      lucroEstimado: financialResult,
      taxaRetencao: totalAppointments > 0
        ? `${Math.round(((completedAppointments) / totalAppointments) * 1000) / 10}%`
        : '0.0%',
      faturamentoCrescimento: variations.realizedRevenue.formatted || '0.0%',
    },
    variations,
    timeline,
    services,
    staff,
    peakHours,
    bills,
    transactions,
  };
}

/**
 * Main function to retrieve salon dashboard data
 */
async function getSalonDashboard(userId, options = {}) {
  const { period = 'this_month', startDate = null, endDate = null, isDemo = false, isPro = true } = options;
  const periodInfo = getPeriodDates(period, startDate, endDate);

  if (isDemo) {
    return getDemoDashboardData(periodInfo, isPro);
  }

  return getRealDashboardData(userId, periodInfo, isPro);
}

/**
 * Add a new bill to pay (scheduled payment) with strict user isolation
 */
function createBill(userId, data) {
  const { title, amount, dueDate, category = 'Contas', installments = 1 } = data;

  if (!title || !title.trim()) {
    throw new Error('Título da conta é obrigatório.');
  }

  const numAmount = parseFloat(amount);
  if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Valor da conta deve ser maior que zero.');
  }

  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new Error('Data de vencimento inválida (use o formato AAAA-MM-DD).');
  }

  const count = Math.max(1, parseInt(installments, 10) || 1);
  const amountPerInstallment = Math.round((numAmount / count) * 100) / 100;

  const [baseY, baseM, baseD] = dueDate.split('-').map(Number);
  const createdBills = [];

  const stmt = db.prepare(`
    INSERT INTO scheduled_payments (
      user_id, title, amount, due_date, category, status,
      installment_current, installment_total, source_type
    ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, 'dashboard')
  `);

  for (let i = 1; i <= count; i++) {
    const instDate = new Date(baseY, (baseM - 1) + (i - 1), baseD);
    const y = instDate.getFullYear();
    const m = String(instDate.getMonth() + 1).padStart(2, '0');
    const d = String(instDate.getDate()).padStart(2, '0');
    const dueDateStr = `${y}-${m}-${d}`;

    const cleanTitle = title.trim();
    const fullTitle = count > 1 ? `${cleanTitle} (${i}/${count})` : cleanTitle;

    const res = stmt.run(
      userId,
      fullTitle,
      amountPerInstallment,
      dueDateStr,
      category || 'Contas',
      i,
      count
    );

    createdBills.push({
      id: res.lastInsertRowid,
      userId,
      title: fullTitle,
      amount: amountPerInstallment,
      dueDate: dueDateStr,
      category,
      status: 'PENDING',
    });
  }

  return createdBills;
}

/**
 * Mark a bill as paid with strict user isolation, atomic transaction and duplicate expense prevention
 */
function markBillAsPaid(userId, billId) {
  if (!userId || !billId) {
    throw new Error('Identificadores de usuário e conta são obrigatórios.');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const bill = db.prepare('SELECT * FROM scheduled_payments WHERE id = ? AND user_id = ?').get(billId, userId);
    if (!bill) {
      throw new Error('Conta agendada não encontrada ou não pertence a este usuário.');
    }

    if (bill.status === 'PAID') {
      db.exec('ROLLBACK');
      return { bill, message: 'Esta conta já foi marcada como quitada anteriormente.' };
    }

    const nowIso = new Date().toISOString();
    db.prepare(`UPDATE scheduled_payments SET status = 'PAID', paid_at = ? WHERE id = ? AND user_id = ?`).run(nowIso, billId, userId);

    // Prevent duplicate expense entries if one already exists for this exact bill
    const existingExpense = db.prepare(`
      SELECT id, amount, category, description, date FROM expenses
      WHERE user_id = ? AND source_type = 'dashboard_bill' AND description = ?
      LIMIT 1
    `).get(userId, `Pagamento de Conta: ${bill.title}`);

    let expense = null;
    if (existingExpense) {
      expense = existingExpense;
    } else {
      expense = financeService.addExpense({
        userId,
        amount: bill.amount,
        category: bill.category || 'Contas',
        description: `Pagamento de Conta: ${bill.title}`,
        paymentMethod: 'Boleto / Transferência',
        date: nowIso,
        sourceType: 'dashboard_bill',
      });
    }

    db.exec('COMMIT');
    return { bill: { ...bill, status: 'PAID', paid_at: nowIso }, expense };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Delete a bill with strict user isolation and audit protection
 */
function deleteBill(userId, billId) {
  if (!userId || !billId) {
    throw new Error('Identificadores de usuário e conta são obrigatórios.');
  }

  const bill = db.prepare('SELECT id, status, title FROM scheduled_payments WHERE id = ? AND user_id = ?').get(billId, userId);
  if (!bill) {
    throw new Error('Conta não encontrada ou permissão negada.');
  }

  // Audit protection: Settled/paid bills must NEVER be deleted to maintain accounting auditability
  if (bill.status === 'PAID') {
    throw new Error('Contas já quitadas não podem ser excluídas para preservar a rastreabilidade contábil.');
  }

  return db.prepare('DELETE FROM scheduled_payments WHERE id = ? AND user_id = ?').run(billId, userId);
}

/**
 * Record a manual financial transaction (income or expense)
 */
function recordTransaction(userId, data) {
  const { type, amount, category, description, paymentMethod, date } = data;

  if (!['INCOME', 'EXPENSE'].includes(type)) {
    throw new Error('Tipo de movimentação inválido (deve ser INCOME ou EXPENSE).');
  }

  const numAmount = parseFloat(amount);
  if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Valor da movimentação deve ser maior que zero.');
  }

  const txDate = date || new Date().toISOString();

  if (type === 'INCOME') {
    return financeService.addIncome({
      userId,
      amount: numAmount,
      source: description || category || 'Receita Salão',
      category: category || 'Receita',
      paymentMethod: paymentMethod || 'Pix',
      date: txDate,
      sourceType: 'dashboard_manual',
    });
  } else {
    return financeService.addExpense({
      userId,
      amount: numAmount,
      category: category || 'Despesas',
      description: description || category || 'Despesa Salão',
      paymentMethod: paymentMethod || 'Não informado',
      date: txDate,
      sourceType: 'dashboard_manual',
    });
  }
}

module.exports = {
  getPeriodDates,
  getEffectiveJessicaTier,
  getSalonDashboard,
  createBill,
  markBillAsPaid,
  deleteBill,
  recordTransaction,
};
