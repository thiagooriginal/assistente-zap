const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ============================================================================
// CONFIGURAÇÃO HERMÉTICA OBRIGATÓRIA (BANCO TEMPORÁRIO EM OS.TMPDIR)
// ============================================================================
const tmpDbPath = path.join(os.tmpdir(), `test-salon-staff-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tmpDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';

// Importa os serviços após configurar DB_PATH isolado
const {
  distributeIntegerByWeights,
  getSalonDashboard,
} = require('../src/services/salonDashboardService');
const db = require('../src/database/db');

// Limpeza no teardown do teste
test.after(() => {
  try {
    if (db && typeof db.close === 'function') {
      db.close();
    }
  } catch (_) {}
  try {
    if (fs.existsSync(tmpDbPath)) {
      fs.unlinkSync(tmpDbPath);
    }
  } catch (_) {}
});

// ============================================================================
// PARTE 1: VALIDAÇÃO UNITÁRIA DE distributeIntegerByWeights (HAMILTON METHOD)
// ============================================================================
test('1. distributeIntegerByWeights: Distribuição determinística e invariância da soma', async (t) => {
  const staffWeights = [0.52, 0.28, 0.20];

  await t.test('Caso 1.1: Total = 0 retorna todos zeros', () => {
    const res = distributeIntegerByWeights(0, staffWeights);
    assert.deepEqual(res, [0, 0, 0]);
    assert.equal(res.reduce((a, b) => a + b, 0), 0);
  });

  await t.test('Caso 1.2: Total = 1 atribui ao maior peso [1, 0, 0]', () => {
    const res = distributeIntegerByWeights(1, staffWeights);
    assert.deepEqual(res, [1, 0, 0]);
    assert.equal(res.reduce((a, b) => a + b, 0), 1);
  });

  await t.test('Caso 1.3: Total = 2 distribui corretamente [1, 1, 0]', () => {
    const res = distributeIntegerByWeights(2, staffWeights);
    assert.deepEqual(res, [1, 1, 0]);
    assert.equal(res.reduce((a, b) => a + b, 0), 2);
  });

  await t.test('Caso 1.4: Total = 3 distribui [1, 1, 1]', () => {
    const res = distributeIntegerByWeights(3, staffWeights);
    assert.deepEqual(res, [1, 1, 1]);
    assert.equal(res.reduce((a, b) => a + b, 0), 3);
  });

  await t.test('Caso 1.5: Total = 7 distribui [4, 2, 1]', () => {
    const res = distributeIntegerByWeights(7, staffWeights);
    assert.deepEqual(res, [4, 2, 1]);
    assert.equal(res.reduce((a, b) => a + b, 0), 7);
  });

  await t.test('Caso 1.6 (Caso Crítico COMANDO 070.3): Total = 28 resulta estritamente [14, 8, 6]', () => {
    const res = distributeIntegerByWeights(28, staffWeights);
    // Elimina a inconsistência anterior de Math.round (15 + 8 + 6 = 29)
    assert.deepEqual(res, [14, 8, 6]);
    assert.equal(res[0], 14, 'Jéssica deve ter 14 atendimentos');
    assert.equal(res[1], 8, 'Camila deve ter 8 atendimentos');
    assert.equal(res[2], 6, 'Rafael deve ter 6 atendimentos');
    assert.equal(res.reduce((a, b) => a + b, 0), 28, 'Soma deve ser estritamente 28');
  });

  await t.test('Caso 1.7: Total = 120 distribui [62, 34, 24]', () => {
    const res = distributeIntegerByWeights(120, staffWeights);
    assert.deepEqual(res, [62, 34, 24]);
    assert.equal(res.reduce((a, b) => a + b, 0), 120);
  });

  await t.test('Caso 1.8: Invariância Universal: SUM(distributeIntegerByWeights(N, weights)) === N para todo N de 0 a 250', () => {
    for (let n = 0; n <= 250; n++) {
      const distributed = distributeIntegerByWeights(n, staffWeights);
      const sum = distributed.reduce((acc, val) => acc + val, 0);
      assert.equal(
        sum,
        n,
        `Invariância violada para total = ${n}: soma obtida foi ${sum}`
      );
    }
  });

  await t.test('Caso 1.9: Invariância com vetor de pesos de serviços (5 categorias)', () => {
    const serviceWeights = [0.35, 0.18, 0.22, 0.15, 0.10];
    for (let n = 0; n <= 100; n++) {
      const distributed = distributeIntegerByWeights(n, serviceWeights);
      const sum = distributed.reduce((acc, val) => acc + val, 0);
      assert.equal(
        sum,
        n,
        `Invariância de serviços violada para total = ${n}: soma obtida foi ${sum}`
      );
    }
  });

  await t.test('Caso 1.10: Resiliência contra entradas inválidas e de borda', () => {
    // Total negativo normalizado para 0
    assert.deepEqual(distributeIntegerByWeights(-10, staffWeights), [0, 0, 0]);

    // Total string numérico convertido para inteiro
    assert.deepEqual(distributeIntegerByWeights('28', staffWeights), [14, 8, 6]);

    // Total não numérico / NaN tratado como 0
    assert.deepEqual(distributeIntegerByWeights('invalido', staffWeights), [0, 0, 0]);
    assert.deepEqual(distributeIntegerByWeights(NaN, staffWeights), [0, 0, 0]);
    assert.deepEqual(distributeIntegerByWeights(null, staffWeights), [0, 0, 0]);
    assert.deepEqual(distributeIntegerByWeights(undefined, staffWeights), [0, 0, 0]);

    // Pesos vazios retornam array vazio
    assert.deepEqual(distributeIntegerByWeights(28, []), []);

    // Pesos todos zerados dividem equitativamente o total
    const zeroWeightsResult = distributeIntegerByWeights(6, [0, 0, 0]);
    assert.deepEqual(zeroWeightsResult, [2, 2, 2]);
    assert.equal(zeroWeightsResult.reduce((a, b) => a + b, 0), 6);
  });
});

// ============================================================================
// PARTE 2: VALIDAÇÃO INTEGRADA DE getSalonDashboard (MODO DEMO / NULL USERID)
// ============================================================================
test('2. getSalonDashboard (Modo Demo): Consistência matemática completa entre métricas, equipe e serviços', async (t) => {
  const periods = ['today', '7d', 'this_month', 'last_month'];

  await t.test('Caso 2.1 (Filtro 7d Específico): Jéssica=14, Camila=8, Rafael=6, soma=28', async () => {
    const data = await getSalonDashboard(null, { period: '7d', isDemo: true });

    assert.ok(data, 'Dashboard deve retornar objeto de dados');
    assert.equal(data.success, true);
    assert.equal(data.isDemo, true);

    const completed = data.metrics.completedAppointments;
    assert.equal(completed, 28, 'Filtro 7d deve ter exatamente 28 atendimentos concluídos');

    const staff = data.staff;
    assert.equal(staff.length, 3, 'Devem existir 3 profissionais');

    const jessica = staff.find(s => s.name === 'Jéssica Ramos');
    const camila = staff.find(s => s.name === 'Camila Santos');
    const rafael = staff.find(s => s.name === 'Rafael Costa');

    assert.ok(jessica, 'Jéssica Ramos deve estar presente');
    assert.ok(camila, 'Camila Santos deve estar presente');
    assert.ok(rafael, 'Rafael Costa deve estar presente');

    assert.equal(jessica.appointments, 14, 'Jéssica deve ter 14 atendimentos');
    assert.equal(camila.appointments, 8, 'Camila deve ter 8 atendimentos');
    assert.equal(rafael.appointments, 6, 'Rafael deve ter 6 atendimentos');

    const staffSum = staff.reduce((acc, s) => acc + s.appointments, 0);
    assert.equal(staffSum, completed, 'A soma dos atendimentos da equipe deve ser rigorosamente igual a completedAppointments (28)');

    // Invariância nos serviços para 7d
    const serviceSum = data.services.reduce((acc, s) => acc + s.count, 0);
    assert.equal(serviceSum, completed, 'A soma dos atendimentos dos serviços deve ser rigorosamente igual a completedAppointments (28)');
  });

  await t.test('Caso 2.2: Invariância Universal em todos os filtros de período', async () => {
    for (const period of periods) {
      const data = await getSalonDashboard(null, { period, isDemo: true });
      const completed = data.metrics.completedAppointments;

      // Invariância de Staff
      const staffSum = data.staff.reduce((acc, s) => acc + s.appointments, 0);
      assert.equal(
        staffSum,
        completed,
        `Invariância de Staff violada no período "${period}": soma(${staffSum}) !== completedAppointments(${completed})`
      );

      // Invariância de Serviços
      const servicesSum = data.services.reduce((acc, s) => acc + s.count, 0);
      assert.equal(
        servicesSum,
        completed,
        `Invariância de Serviços violada no período "${period}": soma(${servicesSum}) !== completedAppointments(${completed})`
      );
    }
  });

  await t.test('Caso 2.3: Recálculo do Ticket Médio Individual e Ausência de NaN / Infinity', async () => {
    for (const period of periods) {
      const data = await getSalonDashboard(null, { period, isDemo: true });

      for (const member of data.staff) {
        assert.ok(!Number.isNaN(member.avgTicket), `avgTicket não pode ser NaN para ${member.name} em ${period}`);
        assert.ok(Number.isFinite(member.avgTicket), `avgTicket deve ser finito para ${member.name} em ${period}`);

        if (member.appointments > 0) {
          const expectedAvg = Math.round((member.revenue / member.appointments) * 100) / 100;
          assert.equal(
            member.avgTicket,
            expectedAvg,
            `avgTicket recalculado incorretamente para ${member.name} em ${period}: obtido ${member.avgTicket}, esperado ${expectedAvg}`
          );
        } else {
          assert.equal(member.avgTicket, 0, `avgTicket deve ser 0 quando appointments for 0`);
        }
      }
    }
  });

  await t.test('Caso 2.4: Preservação de Receitas Atribuídas e Participações Percentuais', async () => {
    for (const period of periods) {
      const data = await getSalonDashboard(null, { period, isDemo: true });
      const realizedRevenue = data.metrics.realizedRevenue;

      const jessica = data.staff.find(s => s.name === 'Jéssica Ramos');
      const camila = data.staff.find(s => s.name === 'Camila Santos');
      const rafael = data.staff.find(s => s.name === 'Rafael Costa');

      // Percentuais nominais preservados
      assert.equal(jessica.sharePercent, 55.0);
      assert.equal(camila.sharePercent, 30.0);
      assert.equal(rafael.sharePercent, 15.0);

      // Receitas alocadas preservadas
      const expectedJessRev = Math.round(realizedRevenue * 0.55 * 100) / 100;
      const expectedCamRev = Math.round(realizedRevenue * 0.30 * 100) / 100;
      const expectedRafRev = Math.round(realizedRevenue * 0.15 * 100) / 100;

      assert.equal(jessica.revenue, expectedJessRev);
      assert.equal(camila.revenue, expectedCamRev);
      assert.equal(rafael.revenue, expectedRafRev);
    }
  });

  await t.test('Caso 2.5: Preservação dos 8 KPIs Estruturais e Gráficos Financeiros', async () => {
    const data = await getSalonDashboard(null, { period: 'this_month', isDemo: true });

    // 8 KPIs
    assert.ok(typeof data.metrics.realizedRevenue === 'number', 'KPI realizedRevenue presente');
    assert.ok(typeof data.metrics.serviceRevenue === 'number', 'KPI serviceRevenue presente');
    assert.ok(typeof data.metrics.estimatedRevenue === 'number', 'KPI estimatedRevenue presente');
    assert.ok(typeof data.metrics.expensesTotal === 'number', 'KPI expensesTotal presente');
    assert.ok(typeof data.metrics.financialResult === 'number', 'KPI financialResult presente');
    assert.ok(typeof data.metrics.totalAppointments === 'number', 'KPI totalAppointments presente');
    assert.ok(typeof data.metrics.completedAppointments === 'number', 'KPI completedAppointments presente');
    assert.ok(typeof data.metrics.averageTicket === 'number', 'KPI averageTicket presente');

    // Gráficos e quebras
    assert.ok(Array.isArray(data.timeline), 'Timeline diária presente');
    assert.ok(Array.isArray(data.weeklyBreakdown), 'Quebra semanal presente');
    assert.ok(Array.isArray(data.peakHours), 'Horários de pico presentes');
    assert.ok(Array.isArray(data.services), 'Serviços presentes');
    assert.ok(Array.isArray(data.staff), 'Equipe presente');
    assert.ok(data.bills !== null && typeof data.bills === 'object', 'Contas a pagar presente');
  });

  await t.test('Caso 2.6: Proteção Hermética — data/assistant.db intocado', () => {
    // Garante que DB_PATH em vigor é o temporário descartável
    assert.equal(process.env.DB_PATH, tmpDbPath);
    assert.ok(!tmpDbPath.includes('assistant.db'), 'O caminho do banco não pode apontar para assistant.db');
  });
});
