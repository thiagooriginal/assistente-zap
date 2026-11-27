/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS DO COMANDO 074
 * Arquivo: tests/comando074_demo_aurora_commercial.test.js
 * 
 * Validação da Demonstração Comercial Isolada do Studio Aurora Beauty (Mariana Alves)
 * Padrão Hermético: os.tmpdir(), node:test, node:assert/strict, limpeza no after()
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

// =========================================================================
// 1. ISOLAMENTO MANDATÓRIO DE BANCO E AMBIENTE (PADRÃO HERMÉTICO)
// =========================================================================
const testDbPath = path.join(os.tmpdir(), `raia_test_aurora_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
const testAuthDir = path.join(os.tmpdir(), `raia_test_aurora_auth_${Date.now()}`);

if (!fs.existsSync(testAuthDir)) {
  fs.mkdirSync(testAuthDir, { recursive: true });
}

process.env.DB_PATH = testDbPath;
process.env.AUTH_DIR = testAuthDir;
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';
process.env.NODE_ENV = 'test';
process.env.DISABLE_WHATSAPP = 'true';
process.env.DISABLE_WHATSAPP_BOT = 'true';
process.env.DISABLE_WHATSAPP_DISPATCH = 'true';
process.env.WHATSAPP_ENABLED = 'false';
process.env.ALLOW_WHATSAPP_SENDING = 'false';
process.env.PAUSE_PERSONAL_ASSISTANT = 'true';
process.env.ADMIN_PASSWORD = 'master_admin_password_audit_123';
process.env.ADMIN_API_KEY = 'admin_key_test_automation_123';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.SESSION_SECRET = '01234567890123456789012345678901';
process.env.MFA_ENCRYPTION_KEY = '01234567890123456789012345678901';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ASAAS_API_KEY = '$aact_test_cmd074_key';
process.env.HOTMART_PRODUCT_ID = '8840376';
process.env.HOTMART_OFFER_START_CODE = 'gtt3rhpk';
process.env.HOTMART_OFFER_INTERMEDIATE_CODE = '1x8ik7i3';
process.env.HOTMART_OFFER_PRO_CODE = 'ytvdj943';
process.env.HOTMART_WEBHOOK_SECRET = 'secret_webhook_test_123';
process.env.DEMO_COMMERCIAL_ENABLED = 'true';
process.env.DEMO_AURORA_EMAIL = 'mariana.aurora@raiaagentes.com.br';
process.env.DEMO_AURORA_PHONE = '5511998880000';

// Importa módulos do sistema após isolar DB_PATH
const db = require('../src/database/db');
const clientAuth = require('../src/services/clientAuthService');
const demoStudioAuroraService = require('../src/services/demoStudioAuroraService');
const salonDashboardService = require('../src/services/salonDashboardService');
const { app } = require('../src/server/app');

describe('COMANDO 074 — Demonstração Comercial Studio Aurora Beauty', () => {
  let server;
  let baseUrl;
  let auroraUser;
  let hotmartUser;
  let auroraToken;
  let adminToken;

  before(async () => {
    // Inicializa servidor HTTP de teste em porta efêmera nativa
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    // 1. Encerra servidor HTTP
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // 2. Fecha conexão SQLite e expurga banco temporário
    try {
      if (db && typeof db.close === 'function') {
        db.close();
      }
    } catch (_) {}

    for (const ext of ['', '-wal', '-shm', '-journal']) {
      try {
        const filePath = testDbPath + ext;
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {}
    }

    try {
      if (fs.existsSync(testAuthDir)) {
        fs.rmSync(testAuthDir, { recursive: true, force: true });
      }
    } catch (_) {}
  });

  // =======================================================================
  // CENÁRIO 1: Provisionamento Idempotente de Mariana Alves
  // =======================================================================
  test('Cenário 1: Provisionamento idempotente de Mariana Alves (Studio Aurora Beauty)', () => {
    // 1ª Execução do provisionamento
    const res1 = demoStudioAuroraService.ensureDemoStudioAuroraAccount();
    assert.strictEqual(res1.success, true, 'O primeiro provisionamento deve ter sucesso');
    assert.strictEqual(res1.isDemo, true, 'Usuária deve possuir flag is_demo = 1');
    assert.strictEqual(res1.email, 'mariana.aurora@raiaagentes.com.br');

    // Validação estrita dos atributos de segurança e autorização no SQLite
    auroraUser = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get('mariana.aurora@raiaagentes.com.br');
    assert.ok(auroraUser, 'Usuária Mariana Alves deve existir no banco de dados');
    assert.strictEqual(auroraUser.plan_tier, 'JESSICA_PRO', 'Plano da Mariana Alves deve ser JESSICA_PRO');
    assert.strictEqual(auroraUser.role, 'USER', 'Role da Mariana Alves deve ser estritamente USER (sem privilégios ADMIN)');
    assert.strictEqual(auroraUser.is_demo, 1, 'is_demo deve ser 1');
    assert.strictEqual(auroraUser.subscription_status, 'ACTIVE', 'subscription_status deve ser ACTIVE');
    assert.strictEqual(auroraUser.subscription_origin, 'DEMO', 'subscription_origin deve ser DEMO');

    // Validação da sincronização em customer_subscriptions
    const jessicaProd = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
    if (jessicaProd) {
      const sub = db.prepare('SELECT * FROM customer_subscriptions WHERE user_id = ? AND product_id = ?').get(auroraUser.id, jessicaProd.id);
      assert.ok(sub, 'Assinatura PRO em customer_subscriptions deve existir');
      assert.strictEqual(sub.status, 'ACTIVE', 'Assinatura deve estar ACTIVE');
      assert.strictEqual(sub.origin, 'DEMO');
    }

    // 2ª Execução para comprovar idempotência estrita sem duplicação de registros
    const res2 = demoStudioAuroraService.ensureDemoStudioAuroraAccount();
    assert.strictEqual(res2.success, true, 'Segunda execução deve suceder de forma idempotente');
    assert.strictEqual(res2.userId, auroraUser.id, 'ID de usuário deve permanecer o mesmo');

    const totalMariana = db.prepare("SELECT COUNT(*) as c FROM users WHERE LOWER(email) = 'mariana.aurora@raiaagentes.com.br'").get().c;
    assert.strictEqual(totalMariana, 1, 'Não deve haver duplicidade de registro para Mariana Alves');

    // Gera token de sessão Bearer para uso nos testes de rotas
    auroraToken = 'test_token_aurora_' + Date.now();
    const expires = new Date(Date.now() + 3600 * 1000).toISOString();
    db.prepare("UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?").run(auroraToken, expires, auroraUser.id);

    // Gera token de sessão para ADMIN
    let adminUser = db.prepare("SELECT * FROM users WHERE role = 'ADMIN'").get();
    if (!adminUser) {
      const resAdmin = db.prepare(`
        INSERT INTO users (email, name, phone_number, role, is_demo, plan_tier, subscription_status)
        VALUES ('admin.aurora.audit@raiaagentes.com.br', 'Admin Auditor', '5511999990000', 'ADMIN', 0, 'PRO', 'ACTIVE')
      `).run();
      adminUser = db.prepare('SELECT * FROM users WHERE id = ?').get(resAdmin.lastInsertRowid);
    }
    adminToken = 'test_token_admin_' + Date.now();
    db.prepare("UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?").run(adminToken, expires, adminUser.id);
  });

  // =======================================================================
  // CENÁRIO 2: Segregação Total da Conta Hotmart Bella Vista
  // =======================================================================
  test('Cenário 2: Segregação total da conta Hotmart Bella Vista (coexistência sem conflito)', () => {
    // Provisiona conta Hotmart de homologação
    hotmartUser = clientAuth.ensureDemoAccount();
    assert.ok(hotmartUser, 'Conta Hotmart Bella Vista deve ser criada');
    assert.notStrictEqual(hotmartUser.id, auroraUser.id, 'IDs de Mariana Alves e Homologação Hotmart devem ser estritamente distintos');

    // Valida que o salão da Mariana é 'Studio Aurora Beauty' e o da Hotmart é 'Bella Vista Hair & Spa [DEMO ILUSTRATIVO]'
    const salonAurora = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(auroraUser.id);
    const salonHotmart = db.prepare('SELECT * FROM client_salons WHERE user_id = ?').get(hotmartUser.id);

    assert.ok(salonAurora, 'Salão da Aurora deve existir');
    assert.ok(salonHotmart, 'Salão da Hotmart deve existir');
    assert.strictEqual(salonAurora.salon_name, 'Studio Aurora Beauty');
    assert.strictEqual(salonHotmart.salon_name, 'Bella Vista Hair & Spa [DEMO ILUSTRATIVO]');
    assert.strictEqual(salonAurora.phone, '(11) 99888-0000');
    assert.strictEqual(salonHotmart.phone, '(11) 99999-0000');

    // Valida segregação estrita de serviços entre os dois tenants
    const servicesAurora = db.prepare('SELECT name FROM client_services WHERE user_id = ?').all(auroraUser.id);
    const servicesHotmart = db.prepare('SELECT name FROM client_services WHERE user_id = ?').all(hotmartUser.id);

    assert.strictEqual(servicesAurora.length, 8, 'Studio Aurora deve possuir exatamente 8 serviços');
    assert.strictEqual(servicesHotmart.length, 6, 'Bella Vista deve possuir exatamente 6 serviços');

    // Nenhum serviço de Aurora pertence a Hotmart
    const auroraNames = new Set(servicesAurora.map(s => s.name));
    for (const hSvc of servicesHotmart) {
      assert.strictEqual(auroraNames.has(hSvc.name), false, `Serviço ${hSvc.name} do Hotmart não pode colidir com catálogo da Aurora`);
    }

    // Valida que agendamentos e contas de Aurora pertencem unicamente a auroraUser.id
    const aptHotmartCount = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE user_id = ?').get(hotmartUser.id).c;
    assert.strictEqual(aptHotmartCount, 0, 'Conta Hotmart não deve possuir agendamentos gerados pelo seed da Aurora');
  });

  // =======================================================================
  // CENÁRIO 3: Catálogo dos 8 Serviços, 3 Profissionais e Matriz Populada
  // =======================================================================
  test('Cenário 3: Catálogo dos 8 serviços, 3 profissionais e matriz client_service_staff populada', () => {
    // 1. Validação dos 8 serviços canônicos
    const services = db.prepare('SELECT * FROM client_services WHERE user_id = ? ORDER BY id ASC').all(auroraUser.id);
    assert.strictEqual(services.length, 8, 'Devem existir 8 serviços');

    const expectedServices = [
      'Corte e Visagismo Feminino',
      'Mechas Criativas & Blond',
      'Morena Iluminada & Tonalização',
      'Escova Modelada & Nutrição Glow',
      'Cronograma Capilar & Reconstrução',
      'Design de Sobrancelhas Personalizado',
      'Manicure Russa & Esmaltação em Gel',
      'Spa dos Pés & Pedicure Completa',
    ];
    for (const name of expectedServices) {
      const match = services.find(s => s.name === name);
      assert.ok(match, `Serviço ${name} deve estar presente`);
      assert.ok(match.price > 0, `Preço de ${name} deve ser maior que zero`);
      assert.ok(match.duration_min > 0, `Duração de ${name} deve ser maior que zero`);
    }

    // 2. Validação dos 3 profissionais
    const staff = db.prepare('SELECT * FROM client_staff WHERE user_id = ? ORDER BY id ASC').all(auroraUser.id);
    assert.strictEqual(staff.length, 3, 'Devem existir exatamente 3 profissionais');

    const expectedStaff = ['Mariana Alves', 'Camila Rocha', 'Lucas Ferreira'];
    for (const name of expectedStaff) {
      const match = staff.find(st => st.name === name);
      assert.ok(match, `Profissional ${name} deve estar cadastrado`);
      assert.ok(match.specialty && match.specialty.length > 5, `Especialidade de ${name} deve ser informativa`);
    }

    // 3. Matriz client_service_staff
    const links = db.prepare('SELECT * FROM client_service_staff WHERE user_id = ?').all(auroraUser.id);
    assert.ok(links.length >= 13, `Devem existir vínculos mapeados na matriz (encontrados: ${links.length})`);
    for (const link of links) {
      assert.strictEqual(link.user_id, auroraUser.id);
      assert.strictEqual(link.confirmed, 1, 'Vínculo serviço-profissional deve estar confirmado');
    }
  });

  // =======================================================================
  // CENÁRIO 4: Agenda Realista, Contas a Pagar e salonDashboardService
  // =======================================================================
  test('Cenário 4: Agenda realista (passados, hoje, futuros) e contas a pagar consistentes com salonDashboardService', async () => {
    // 1. Contas a Pagar (scheduled_payments) e Despesas (expenses)
    const bills = db.prepare('SELECT * FROM scheduled_payments WHERE user_id = ?').all(auroraUser.id);
    assert.strictEqual(bills.length, 8, 'Devem existir 8 contas cadastradas');

    const paidBills = bills.filter(b => b.status === 'PAID');
    const pendingBills = bills.filter(b => b.status === 'PENDING');
    assert.strictEqual(paidBills.length, 4, 'Devem existir exatamente 4 contas pagas');
    assert.strictEqual(pendingBills.length, 4, 'Devem existir exatamente 4 contas pendentes');

    const totalPaidAmount = paidBills.reduce((acc, b) => acc + b.amount, 0);
    assert.strictEqual(totalPaidAmount, 7520.0, 'Soma das contas pagas deve ser exatamente R$ 7.520,00');

    // Validação das despesas correspondentes em expenses
    const expenses = db.prepare('SELECT * FROM expenses WHERE user_id = ?').all(auroraUser.id);
    assert.strictEqual(expenses.length, 4, 'Devem existir 4 lançamentos em expenses decorrentes das contas pagas');
    const totalExpensesAmount = expenses.reduce((acc, e) => acc + e.amount, 0);
    assert.strictEqual(totalExpensesAmount, 7520.0, 'Soma em expenses deve ser matematicamente igual a R$ 7.520,00');

    // 2. Agenda de Atendimentos (appointments) e Receitas (incomes)
    const appointments = db.prepare('SELECT * FROM appointments WHERE user_id = ?').all(auroraUser.id);
    assert.strictEqual(appointments.length, 35, 'Devem existir exatamente 35 agendamentos no seed comercial');

    const completedApts = appointments.filter(a => a.status === 'CONCLUIDO');
    const confirmedApts = appointments.filter(a => a.status === 'CONFIRMADO');
    const scheduledApts = appointments.filter(a => a.status === 'AGENDADO');
    const cancelledApts = appointments.filter(a => a.status === 'CANCELADO');

    assert.strictEqual(completedApts.length, 20, 'Devem existir 20 atendimentos com status CONCLUIDO');
    assert.strictEqual(cancelledApts.length, 2, 'Devem existir 2 cancelamentos realistas');
    assert.ok(confirmedApts.length >= 8, 'Devem existir agendamentos confirmados');
    assert.ok(scheduledApts.length >= 4, 'Devem existir agendamentos futuros em status AGENDADO');

    // Validação matemática de incomes para cada atendimento CONCLUIDO
    const incomes = db.prepare('SELECT * FROM incomes WHERE user_id = ?').all(auroraUser.id);
    assert.strictEqual(incomes.length, 20, 'Cada atendimento CONCLUIDO deve gerar exatamente 1 lançamento em incomes');

    // 3. Execução e consistência com salonDashboardService
    const dashboard = await salonDashboardService.getSalonDashboard(auroraUser.id, { period: 'this_month' });
    assert.strictEqual(dashboard.success, true, 'getSalonDashboard deve retornar success: true');
    assert.ok(dashboard.metrics, 'Métricas do salão devem estar preenchidas');
    assert.ok(dashboard.timeline && dashboard.timeline.length > 0, 'Timeline diária deve estar populada');
    assert.ok(dashboard.weeklyBreakdown && dashboard.weeklyBreakdown.length > 0, 'Breakdown semanal deve estar calculado');
    assert.ok(dashboard.bills, 'Estrutura de contas do dashboard deve estar presente');
  });

  // =======================================================================
  // CENÁRIO 5: Reset Transacional Atômico (resetDemoStudioAuroraData)
  // =======================================================================
  test('Cenário 5: Reset transacional atômico limpa e recria dados do Studio Aurora e rejeita terceiros', () => {
    // 1. Modifica intencionalmente os dados do Studio Aurora adicionando um agendamento temporário
    db.prepare(`
      INSERT INTO appointments (
        user_id, title, description, start_datetime, origin, status
      ) VALUES (?, 'Agendamento Temporário Alterado', 'Teste de Purga', '2026-11-30 10:00:00', 'whatsapp', 'AGENDADO')
    `).run(auroraUser.id);

    const countBeforeReset = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE user_id = ?').get(auroraUser.id).c;
    assert.strictEqual(countBeforeReset, 36, 'Deve haver 36 agendamentos antes do reset');

    // 2. Executa reset atômico para Mariana Alves
    const resetResult = demoStudioAuroraService.resetDemoStudioAuroraData(auroraUser.id);
    assert.strictEqual(resetResult.success, true);
    assert.strictEqual(resetResult.purged, true);
    assert.strictEqual(resetResult.reseeded, true);
    assert.strictEqual(resetResult.userId, auroraUser.id);

    // Valida que o agendamento temporário foi expurgado e a base voltou aos 35 agendamentos oficiais
    const countAfterReset = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE user_id = ?').get(auroraUser.id).c;
    assert.strictEqual(countAfterReset, 35, 'Após reset, devem existir rigorosamente os 35 agendamentos oficiais');

    // 3. Salvaguarda Multi-Tenant: Rejeição ao tentar resetar a conta Hotmart Bella Vista
    assert.throws(
      () => demoStudioAuroraService.resetDemoStudioAuroraData(hotmartUser.id),
      /reset restrito ao tenant da Mariana Alves/,
      'Tentativa de reset no ID da Hotmart deve ser categoricamente bloqueada'
    );

    // 4. Salvaguarda Multi-Tenant: Rejeição com ID inexistente ou inválido
    assert.throws(
      () => demoStudioAuroraService.resetDemoStudioAuroraData(999999),
      /não encontrado para reset/,
      'ID de usuário inexistente deve disparar exceção fail-closed'
    );
    assert.throws(
      () => demoStudioAuroraService.resetDemoStudioAuroraData(null),
      /ID de usuário inválido/,
      'ID nulo deve disparar exceção imediata'
    );
  });

  // =======================================================================
  // CENÁRIO 6: Rotas da API da Aurora (Simulador WhatsApp em 6 passos e Criação)
  // =======================================================================
  test('Cenário 6: Rotas da API da Aurora (simulador em 6 passos e agendamento confirmado)', async () => {
    // 1. GET /api/client/demo/aurora/simulator-flow sem autenticação (deve retornar 401)
    const unauthRes = await fetch(`${baseUrl}/api/client/demo/aurora/simulator-flow`);
    assert.strictEqual(unauthRes.status, 401, 'Requisição não autenticada deve retornar 401');

    // 2. GET /api/client/demo/aurora/simulator-flow autenticada com Bearer
    const flowRes = await fetch(`${baseUrl}/api/client/demo/aurora/simulator-flow`, {
      headers: {
        'Authorization': `Bearer ${auroraToken}`,
        'Accept': 'application/json',
      },
    });
    assert.strictEqual(flowRes.status, 200, 'Requisição com token de Mariana Alves deve retornar 200');
    const flowData = await flowRes.json();

    assert.strictEqual(flowData.success, true);
    assert.strictEqual(flowData.salonName, 'Studio Aurora Beauty');
    assert.strictEqual(flowData.aiAgentName, 'Jéssica');
    assert.strictEqual(flowData.ownerName, 'Mariana Alves');
    assert.strictEqual(flowData.totalSteps, 6, 'O fluxo deve conter rigorosamente 6 passos');
    assert.strictEqual(flowData.steps.length, 6);

    // Validação da cadência CLIENT <-> AI
    assert.strictEqual(flowData.steps[0].sender, 'CLIENT');
    assert.strictEqual(flowData.steps[1].sender, 'AI');
    assert.strictEqual(flowData.steps[2].sender, 'CLIENT');
    assert.strictEqual(flowData.steps[3].sender, 'AI');
    assert.strictEqual(flowData.steps[4].sender, 'CLIENT');
    assert.strictEqual(flowData.steps[5].sender, 'AI');

    // Validação de correspondência exata do slot determinístico na conversa
    assert.ok(flowData.scheduledSlot, 'flowData deve incluir scheduledSlot com o slot canônico');
    assert.ok(flowData.scheduledSlot.startDatetime, 'scheduledSlot deve conter startDatetime');
    assert.ok(flowData.scheduledSlot.endDatetime, 'scheduledSlot deve conter endDatetime');
    assert.ok(flowData.scheduledSlot.formattedText, 'scheduledSlot deve conter formattedText');
    assert.ok(
      flowData.steps[5].message.includes(flowData.scheduledSlot.formattedText),
      'Passo 6 da conversa deve conter a data e horário exatamente correspondentes ao slot'
    );

    // 3. POST /api/client/demo/aurora/simulate-appointment (Passo 6 dinâmico)
    const simRes = await fetch(`${baseUrl}/api/client/demo/aurora/simulate-appointment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auroraToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientName: 'Fernanda Lima (Simulação WhatsApp)',
        clientPhone: '(11) 99888-0099',
      }),
    });

    assert.strictEqual(simRes.status, 201, 'Criação simulada deve retornar HTTP 201 Created');
    const simData = await simRes.json();

    assert.strictEqual(simData.success, true);
    assert.ok(simData.appointment, 'Agendamento criado deve ser retornado no payload');
    assert.strictEqual(simData.appointment.user_id, auroraUser.id, 'Agendamento deve pertencer à Mariana Alves');
    assert.strictEqual(simData.appointment.status, 'CONFIRMADO', 'Status deve ser CONFIRMADO');
    assert.strictEqual(simData.appointment.client_name, 'Fernanda Lima (Simulação WhatsApp)');
    assert.strictEqual(simData.appointment.client_phone, '(11) 99888-0099');

    // Correspondência exata entre a conversa e o agendamento persistido
    assert.strictEqual(
      simData.appointment.start_datetime,
      flowData.scheduledSlot.startDatetime,
      'start_datetime persistido deve corresponder exatamente ao slot apresentado na conversa'
    );
    assert.strictEqual(
      simData.appointment.end_datetime,
      flowData.scheduledSlot.endDatetime,
      'end_datetime persistido deve corresponder exatamente ao slot apresentado na conversa'
    );

    // Valida persistência real no SQLite
    const createdInDb = db.prepare('SELECT * FROM appointments WHERE id = ?').get(simData.appointment.id);
    assert.ok(createdInDb, 'Compromisso simulado deve estar persistido no SQLite');
    assert.strictEqual(createdInDb.origin, 'whatsapp');
    assert.strictEqual(createdInDb.status, 'CONFIRMADO');
  });

  // =======================================================================
  // CENÁRIO 7: Salvaguarda Fail-Closed fora de Homologação
  // =======================================================================
  test('Cenário 7: Salvaguarda fail-closed: bloqueio em produção quando sem flag explícita (inclusive ADMIN)', async () => {
    // Guarda referências originais de ambiente
    const origHomolog = process.env.HOMOLOGACAO;
    const origAppMode = process.env.APP_MODE;
    const origFlag = process.env.DEMO_COMMERCIAL_ENABLED;

    try {
      // Simula ambiente de produção sem DEMO_COMMERCIAL_ENABLED
      delete process.env.HOMOLOGACAO;
      process.env.APP_MODE = 'production';
      delete process.env.DEMO_COMMERCIAL_ENABLED;

      // 1. isCommercialDemoAllowed deve retornar categoricamente false
      assert.strictEqual(
        demoStudioAuroraService.isCommercialDemoAllowed(),
        false,
        'Em produção sem flag explícita, isCommercialDemoAllowed deve ser false'
      );

      // 2. ensureDemoStudioAuroraAccount deve rejeitar fail-closed sem afetar o banco
      const blockedEnsure = demoStudioAuroraService.ensureDemoStudioAuroraAccount();
      assert.strictEqual(blockedEnsure.success, false);
      assert.strictEqual(blockedEnsure.reason, 'DISABLED_IN_PRODUCTION');

      // 3. resetDemoStudioAuroraData deve lançar erro bloqueante fail-closed
      assert.throws(
        () => demoStudioAuroraService.resetDemoStudioAuroraData(auroraUser.id),
        /Reset comercial bloqueado: ambiente de produção restrito/,
        'Tentativa de reset em produção sem flag deve lançar exceção fail-closed'
      );

      // 4. Bloqueio HTTP 403 fail-closed para cliente Mariana Alves
      const flowResAurora = await fetch(`${baseUrl}/api/client/demo/aurora/simulator-flow`, {
        headers: { 'Authorization': `Bearer ${auroraToken}` },
      });
      assert.strictEqual(flowResAurora.status, 403);
      const flowDataAurora = await flowResAurora.json();
      assert.strictEqual(flowDataAurora.code, 'DEMO_COMMERCIAL_DISABLED');

      const simResAurora = await fetch(`${baseUrl}/api/client/demo/aurora/simulate-appointment`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auroraToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clientName: 'Tentativa Bloqueada', clientPhone: '(11) 90000-0000' }),
      });
      assert.strictEqual(simResAurora.status, 403);
      const simDataAurora = await simResAurora.json();
      assert.strictEqual(simDataAurora.code, 'DEMO_COMMERCIAL_DISABLED');

      const resetResAurora = await fetch(`${baseUrl}/api/client/demo/aurora/reset`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${auroraToken}` },
      });
      assert.strictEqual(resetResAurora.status, 403);
      const resetDataAurora = await resetResAurora.json();
      assert.strictEqual(resetDataAurora.code, 'DEMO_COMMERCIAL_DISABLED');

      // 5. Bloqueio HTTP 403 fail-closed também para ADMIN (requisito: independentemente de ser administrador)
      const flowResAdmin = await fetch(`${baseUrl}/api/client/demo/aurora/simulator-flow`, {
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
      assert.strictEqual(flowResAdmin.status, 403);
      const flowDataAdmin = await flowResAdmin.json();
      assert.strictEqual(flowDataAdmin.code, 'DEMO_COMMERCIAL_DISABLED');

      const simResAdmin = await fetch(`${baseUrl}/api/client/demo/aurora/simulate-appointment`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ clientName: 'Admin Tentativa Bloqueada', clientPhone: '(11) 90000-0000' }),
      });
      assert.strictEqual(simResAdmin.status, 403);
      const simDataAdmin = await simResAdmin.json();
      assert.strictEqual(simDataAdmin.code, 'DEMO_COMMERCIAL_DISABLED');

      const resetResAdmin = await fetch(`${baseUrl}/api/client/demo/aurora/reset`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
      assert.strictEqual(resetResAdmin.status, 403);
      const resetDataAdmin = await resetResAdmin.json();
      assert.strictEqual(resetDataAdmin.code, 'DEMO_COMMERCIAL_DISABLED');
    } finally {
      // Restaura ambiente de homologação
      process.env.HOMOLOGACAO = origHomolog;
      process.env.APP_MODE = origAppMode;
      process.env.DEMO_COMMERCIAL_ENABLED = origFlag;
    }
  });

  // =======================================================================
  // CENÁRIO 8: Ajuste Visual Prioritário — Studio Aurora Beauty
  // =======================================================================
  test('Cenário 8: Ajuste visual prioritário Studio Aurora: sanitização, overlay mobile e seletores CSS limpos', () => {
    // 1. Validar que clientAuthService.getSanitizedUser retorna isCommercialDemo: true e isAuroraDemo: true para Mariana Alves
    const sanitizedAurora = clientAuth.getSanitizedUser(auroraUser.id);
    assert.ok(sanitizedAurora, 'Perfil sanitizado de Mariana Alves deve existir');
    assert.strictEqual(sanitizedAurora.isCommercialDemo, true, 'isCommercialDemo deve ser true para Mariana Alves');
    assert.strictEqual(sanitizedAurora.isAuroraDemo, true, 'isAuroraDemo deve ser true para Mariana Alves');
    assert.strictEqual(sanitizedAurora.name, 'Mariana Alves');
    assert.strictEqual(sanitizedAurora.salon.name, 'Studio Aurora Beauty');

    // 2. Validar que clientAuthService.getSanitizedUser retorna false para a conta de homologação Hotmart Bella Vista
    const sanitizedHotmart = clientAuth.getSanitizedUser(hotmartUser.id);
    assert.ok(sanitizedHotmart, 'Perfil sanitizado de homologação Hotmart deve existir');
    assert.strictEqual(sanitizedHotmart.isCommercialDemo, false, 'isCommercialDemo deve ser false para Hotmart Bella Vista');
    assert.strictEqual(sanitizedHotmart.isAuroraDemo, false, 'isAuroraDemo deve ser false para Hotmart Bella Vista');
    assert.strictEqual(sanitizedHotmart.salon.name, 'Bella Vista Hair & Spa [DEMO ILUSTRATIVO]');

    // 3. Validar arquivo public/cliente/painel.html
    const painelHtmlPath = path.resolve(__dirname, '../public/cliente/painel.html');
    assert.ok(fs.existsSync(painelHtmlPath), 'Arquivo painel.html deve existir');
    const htmlContent = fs.readFileSync(painelHtmlPath, 'utf-8');

    // 3.1 #sidebarOverlay com backdrop e transição suave
    assert.ok(
      htmlContent.includes('id="sidebarOverlay"') &&
      htmlContent.includes('backdrop-blur') &&
      htmlContent.includes('transition-opacity'),
      'painel.html deve conter #sidebarOverlay com backdrop blur e transição suave de opacidade'
    );

    // 3.2 #closeSidebarBtn para fechar o menu no mobile
    assert.ok(
      htmlContent.includes('id="closeSidebarBtn"') &&
      htmlContent.includes('closeMobileSidebar'),
      'painel.html deve conter #closeSidebarBtn e manipulador de fechamento do menu mobile'
    );

    // 3.3 Estilos CSS body.is-aurora-commercial ocultando #demoNoticeBanner, #demoAuroraBadge e #proDemoBadge
    assert.ok(
      htmlContent.includes('body.is-aurora-commercial #demoNoticeBanner') &&
      htmlContent.includes('body.is-aurora-commercial #demoAuroraBadge') &&
      htmlContent.includes('body.is-aurora-commercial #proDemoBadge') &&
      htmlContent.includes('display: none !important'),
      'painel.html deve conter regras CSS em body.is-aurora-commercial ocultando banners e badges'
    );

    // 3.4 #demoNoticeBanner reclassificado para não sobrepor o topo fixo (w-full em vez de fixed top-0)
    const bannerMatch = htmlContent.match(/<div[^>]*id="demoNoticeBanner"[^>]*class="([^"]*)"/);
    assert.ok(bannerMatch, '#demoNoticeBanner deve existir na estrutura HTML');
    const bannerClasses = bannerMatch[1];
    assert.ok(bannerClasses.includes('w-full'), '#demoNoticeBanner deve conter classe w-full para fluxo natural');
    assert.strictEqual(
      bannerClasses.includes('fixed top-0'),
      false,
      '#demoNoticeBanner NÃO pode conter fixed top-0 para evitar sobreposição do topo fixo'
    );
  });

  // =======================================================================
  // CENÁRIO 9: Teste Negativo de Autorização em simulate-appointment (Requisito 1)
  // =======================================================================
  test('Cenário 9: Teste negativo de autorização em simulate-appointment (bloqueio 403 e código FORBIDDEN_AURORA_SIMULATE)', async () => {
    // 1. Gera token de sessão Bearer para o usuário de homologação Hotmart Bella Vista
    const hotmartToken = 'test_token_hotmart_invader_' + Date.now();
    const expires = new Date(Date.now() + 3600 * 1000).toISOString();
    db.prepare('UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?').run(
      hotmartToken,
      expires,
      hotmartUser.id
    );

    // 2. Tenta acionar simulate-appointment com token de terceiro
    const simRes = await fetch(`${baseUrl}/api/client/demo/aurora/simulate-appointment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hotmartToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientName: 'Cliente Não Autorizado',
        clientPhone: '(11) 97777-8899',
      }),
    });

    // 3. Deve retornar estritamente HTTP 403 Forbidden e código FORBIDDEN_AURORA_SIMULATE
    assert.strictEqual(simRes.status, 403, 'Acesso não-aurora deve retornar HTTP 403');
    const simData = await simRes.json();
    assert.strictEqual(simData.success, false);
    assert.strictEqual(simData.code, 'FORBIDDEN_AURORA_SIMULATE');

    // 4. Nenhum registro é gravado em tenants de terceiros
    const hotmartApts = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE user_id = ?').get(hotmartUser.id).c;
    assert.strictEqual(hotmartApts, 0, 'Nenhum agendamento deve ser gravado para o tenant terceiro');
  });

  // =======================================================================
  // CENÁRIO 10: Disponibilidade de Agenda sem Colisão e Blindagem Externa (Requisito 2)
  // =======================================================================
  test('Cenário 10: Disponibilidade de agenda sem colisão (HTTP 409 em conflito) e blindagem externa', async () => {
    // 1. Obtém slot oficial da simulação e staff Mariana Alves
    const demoSlot = demoStudioAuroraService.getNextThursdayDemoSlot();
    const marianaStaff = db.prepare("SELECT id FROM client_staff WHERE user_id = ? AND name LIKE '%Mariana Alves%'").get(auroraUser.id);
    assert.ok(marianaStaff, 'Mariana Alves deve existir no client_staff do Studio Aurora');

    // 1.1 Limpa agendamentos prévios que porventura ocupem este slot determinístico
    db.prepare(`
      DELETE FROM appointments 
      WHERE user_id = ? 
        AND staff_id = ? 
        AND replace(start_datetime, 'T', ' ') < ? 
        AND replace(end_datetime, 'T', ' ') > ?
    `).run(auroraUser.id, marianaStaff.id, demoSlot.endDatetime, demoSlot.startDatetime);

    // 2. Insere agendamento concorrente ocupando exatamente o horário do slot da simulação
    const concurInsert = db.prepare(`
      INSERT INTO appointments (
        user_id, title, description, start_datetime, end_datetime,
        staff_id, status, origin, google_sync_status
      ) VALUES (?, 'Agendamento Concorrente Bloqueio', 'Bloqueio de slot para teste', ?, ?, ?, 'CONFIRMADO', 'dashboard', 'NOT_CONNECTED')
    `).run(auroraUser.id, demoSlot.startDatetime, demoSlot.endDatetime, marianaStaff.id);
    const concurAptId = Number(concurInsert.lastInsertRowid);

    // Contagem de agendamentos antes da tentativa com conflito
    const totalBefore = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE user_id = ?').get(auroraUser.id).c;

    // 3. Tenta simular agendamento com agenda ocupada -> DEVE RETORNAR HTTP 409 SEM CRIAR AGENDAMENTO
    const conflictRes = await fetch(`${baseUrl}/api/client/demo/aurora/simulate-appointment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auroraToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientName: 'Carla Silveira (Tentativa em Horário Ocupado)',
        clientPhone: '(11) 98888-7711',
      }),
    });

    assert.strictEqual(conflictRes.status, 409, 'Quando o horário estiver ocupado, deve retornar estritamente HTTP 409 Conflict');
    const conflictData = await conflictRes.json();
    assert.strictEqual(conflictData.success, false);
    assert.strictEqual(conflictData.code, 'SCHEDULE_CONFLICT');
    assert.strictEqual(conflictData.conflictingAppointmentId, concurAptId, 'Deve indicar o ID exato do agendamento conflitante');

    // Valida que nenhum registro adicional foi persistido (sem fallback fantasma)
    const totalAfterConflict = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE user_id = ?').get(auroraUser.id).c;
    assert.strictEqual(totalAfterConflict, totalBefore, 'Nenhum agendamento deve ser criado quando a agenda estiver ocupada');

    // 4. Desbloqueia o horário removendo o agendamento conflitante
    db.prepare('DELETE FROM appointments WHERE id = ?').run(concurAptId);

    // 5. Executa simulação com o horário desobstruído -> DEVE RETORNAR HTTP 201
    const simRes = await fetch(`${baseUrl}/api/client/demo/aurora/simulate-appointment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auroraToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientName: 'Carla Silveira (Simulação Sem Conflito)',
        clientPhone: '(11) 98888-7711',
      }),
    });

    assert.strictEqual(simRes.status, 201, 'Criação simulada em horário livre deve retornar HTTP 201 Created');
    const simData = await simRes.json();
    assert.strictEqual(simData.success, true);
    assert.ok(simData.appointment);
    assert.strictEqual(simData.appointment.start_datetime, demoSlot.startDatetime);
    assert.strictEqual(simData.appointment.end_datetime, demoSlot.endDatetime);

    // 6. Blindagem Externa:
    // google_sync_status permanece 'NOT_CONNECTED'
    assert.strictEqual(simData.appointment.google_sync_status, 'NOT_CONNECTED');

    // Nada é adicionado à google_sync_outbox
    const outboxCount = db.prepare('SELECT COUNT(*) as c FROM google_sync_outbox WHERE appointment_id = ?').get(simData.appointment.id).c;
    assert.strictEqual(outboxCount, 0, 'Nenhum registro pode ser enfileirado na google_sync_outbox durante simulação');

    // Nenhum WhatsApp real é disparado (notificado flag = 1, reminder = DISABLED)
    assert.strictEqual(simData.appointment.whatsapp_notified, 1);
    assert.strictEqual(simData.appointment.reminder_24h_status, 'DISABLED');
  });

  // =======================================================================
  // CENÁRIO 11: Configuração e Redefinição Segura de Senha por Variável de Ambiente (Requisito 3)
  // =======================================================================
  test('Cenário 11: Configuração e redefinição segura de senha por variável de ambiente (DEMO_AURORA_PASSWORD)', () => {
    const customPassword = 'SenhaSeguraMariana2026!#Aurora';
    const origEnvPassword = process.env.DEMO_AURORA_PASSWORD;

    try {
      // 1. Define variável de ambiente com senha customizada
      process.env.DEMO_AURORA_PASSWORD = customPassword;

      // 2. Executa provisionamento/sincronização
      const ensureRes = demoStudioAuroraService.ensureDemoStudioAuroraAccount();
      assert.strictEqual(ensureRes.success, true);

      // 3. Testa login real via clientAuth.login() -> deve suceder
      const loginSuccess = clientAuth.login(demoStudioAuroraService.AURORA_EMAIL, customPassword);
      assert.strictEqual(loginSuccess.success, true, 'Login com a nova DEMO_AURORA_PASSWORD deve ser bem-sucedido');
      assert.ok(loginSuccess.token, 'Token de sessão válido deve ser retornado no login');
      assert.strictEqual(loginSuccess.user.email, demoStudioAuroraService.AURORA_EMAIL);

      // 4. Testa login com senha errada -> deve falhar fail-closed com INVALID_CREDENTIALS
      const loginFail = clientAuth.login(demoStudioAuroraService.AURORA_EMAIL, 'SenhaIncorretaQueDeveFalhar123!');
      assert.strictEqual(loginFail.success, false, 'Login com credencial inválida deve falhar');
      assert.strictEqual(loginFail.code, 'INVALID_CREDENTIALS', 'Código de falha deve ser INVALID_CREDENTIALS');
    } finally {
      // Restaura o ambiente
      if (origEnvPassword !== undefined) {
        process.env.DEMO_AURORA_PASSWORD = origEnvPassword;
      } else {
        delete process.env.DEMO_AURORA_PASSWORD;
      }
    }
  });

  // =======================================================================
  // CENÁRIO 12: Identidade Canônica Estrita — Rejeição de Substrings/Spoofing (Requisito 4)
  // =======================================================================
  test('Cenário 12: Identidade canônica estrita — rejeição de substrings/spoofing (OWASP ASVS 5.0)', () => {
    // 1. Cria usuário simulando tentativa de spoofing com substring no e-mail e salão
    const spoofEmail = 'mariana.aurora.fake@gmail.com';
    const fakeInsert = db.prepare(`
      INSERT INTO users (email, name, phone_number, role, is_demo, plan_tier, subscription_status)
      VALUES (?, 'Mariana Aurora Impostora', '5511999998888', 'USER', 1, 'JESSICA_PRO', 'ACTIVE')
    `).run(spoofEmail);
    const fakeUserId = Number(fakeInsert.lastInsertRowid);

    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone)
      VALUES (?, 'Studio Aurora Hair Impostor', '(11) 96666-5544')
    `).run(fakeUserId);

    // 2. clientAuth.getSanitizedUser DEVE retornar isCommercialDemo: false e isAuroraDemo: false
    const sanitizedFake = clientAuth.getSanitizedUser(fakeUserId);
    assert.ok(sanitizedFake, 'Perfil sanitizado do usuário fake deve ser retornado');
    assert.strictEqual(
      sanitizedFake.isCommercialDemo,
      false,
      'Usuário com e-mail fake mariana.aurora.fake@gmail.com NÃO pode ter isCommercialDemo = true'
    );
    assert.strictEqual(
      sanitizedFake.isAuroraDemo,
      false,
      'Usuário com e-mail fake mariana.aurora.fake@gmail.com NÃO pode ter isAuroraDemo = true'
    );

    // 3. Valida que public/cliente/painel.html e clientAuthService.js não possuem correspondências por .includes('mariana.aurora')
    const painelHtmlPath = path.resolve(__dirname, '../public/cliente/painel.html');
    const painelHtml = fs.readFileSync(painelHtmlPath, 'utf-8');
    const clientAuthPath = path.resolve(__dirname, '../src/services/clientAuthService.js');
    const clientAuthSrc = fs.readFileSync(clientAuthPath, 'utf-8');

    assert.strictEqual(
      painelHtml.includes(".includes('mariana.aurora')") || painelHtml.includes('.includes("mariana.aurora")'),
      false,
      'public/cliente/painel.html não pode conter validação frágil via .includes("mariana.aurora")'
    );

    assert.strictEqual(
      clientAuthSrc.includes(".includes('mariana.aurora')") || clientAuthSrc.includes('.includes("mariana.aurora")'),
      false,
      'src/services/clientAuthService.js não pode conter validação frágil via .includes("mariana.aurora")'
    );
  });
});
