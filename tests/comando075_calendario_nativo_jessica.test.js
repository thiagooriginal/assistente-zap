/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS DO COMANDO 075
 * Arquivo: tests/comando075_calendario_nativo_jessica.test.js
 * 
 * Validação do Calendário Nativo Inteligente da Jéssica Beauty Premium
 * - 4 Modos Operacionais: Dia, Semana, Mês e Lista
 * - Filtros por Período, Profissional, Serviço, Status e Busca
 * - Normalização de Datas SQLite (' ' vs 'T')
 * - Isolamento estrito Multi-Tenant (user_id)
 * - Compatibilidade com Studio Aurora Beauty
 * - Controles DOM no Painel do Cliente
 * 
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
const testDbPath = path.join(os.tmpdir(), `raia_test_calendar_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
const testAuthDir = path.join(os.tmpdir(), `raia_test_calendar_auth_${Date.now()}`);

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
process.env.ADMIN_PASSWORD = 'master_admin_password_calendar_123';
process.env.ADMIN_API_KEY = 'admin_key_calendar_automation_123';
process.env.ADMIN_MFA_ENABLED = 'true';
process.env.SESSION_SECRET = '01234567890123456789012345678901';
process.env.MFA_ENCRYPTION_KEY = '01234567890123456789012345678901';
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ASAAS_API_KEY = '$aact_test_cmd075_key';
process.env.HOTMART_PRODUCT_ID = '8840376';
process.env.HOTMART_OFFER_START_CODE = 'gtt3rhpk';
process.env.HOTMART_OFFER_INTERMEDIATE_CODE = '1x8ik7i3';
process.env.HOTMART_OFFER_PRO_CODE = 'ytvdj943';
process.env.HOTMART_WEBHOOK_SECRET = 'secret_webhook_test_123';
process.env.DEMO_COMMERCIAL_ENABLED = 'true';
process.env.DEMO_AURORA_EMAIL = 'mariana.aurora@raiaagentes.com.br';
process.env.DEMO_AURORA_PHONE = '5511998880000';

// Importa módulos após definir as variáveis de ambiente
const db = require('../src/database/db');
const clientAuth = require('../src/services/clientAuthService');
const salonAppointmentService = require('../src/services/salonAppointmentService');
const demoStudioAuroraService = require('../src/services/demoStudioAuroraService');
const { app } = require('../src/server/app');

describe('COMANDO 075 — Calendário Nativo Inteligente da Jéssica Beauty Premium', () => {
  let server;
  let baseUrl;
  let tenantAUserId;
  let tenantBUserId;
  let serviceA1Id;
  let serviceA2Id;
  let staffA1Id;
  let tenantACookie;

  before(async () => {
    // Inicia servidor HTTP efêmero para teste das rotas
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    const futurePaidUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Cria Tenant A (Salão Bella)
    const { hash: hashA, salt: saltA } = clientAuth.hashPassword('SenhaForteBella@2026');
    const resA = db.prepare(`
      INSERT INTO users (
        email, name, phone_number, password_hash, password_salt,
        plan_tier, subscription_status, subscription_origin, paid_until, is_demo, role
      ) VALUES (?, ?, ?, ?, ?, 'JESSICA_PRO', 'ACTIVE', 'HOTMART', ?, 0, 'USER')
    `).run(
      'isabela.bella@teste.com.br',
      'Isabela Bella',
      '5511999990001',
      hashA,
      saltA,
      futurePaidUntil
    );
    tenantAUserId = Number(resA.lastInsertRowid);
    clientAuth.ensureSalonForUser(tenantAUserId, 'Salão Bella Vista');

    // Cria Tenant B (Barbearia Alfa) para teste de isolamento multi-tenant
    const { hash: hashB, salt: saltB } = clientAuth.hashPassword('SenhaForteAlfa@2026');
    const resB = db.prepare(`
      INSERT INTO users (
        email, name, phone_number, password_hash, password_salt,
        plan_tier, subscription_status, subscription_origin, paid_until, is_demo, role
      ) VALUES (?, ?, ?, ?, ?, 'JESSICA_PRO', 'ACTIVE', 'HOTMART', ?, 0, 'USER')
    `).run(
      'carlos.alfa@teste.com.br',
      'Carlos Alfa',
      '5511999990002',
      hashB,
      saltB,
      futurePaidUntil
    );
    tenantBUserId = Number(resB.lastInsertRowid);
    clientAuth.ensureSalonForUser(tenantBUserId, 'Barbearia Alfa');

    // Cria serviços e profissionais para o Tenant A usando as tabelas corretas
    const insertStaff = db.prepare(`
      INSERT INTO client_staff (user_id, name, specialty, active)
      VALUES (?, ?, ?, 1)
    `);
    const staffRes = insertStaff.run(tenantAUserId, 'Paula Cabelos', 'Cabeleireira');
    staffA1Id = Number(staffRes.lastInsertRowid);

    const insertService = db.prepare(`
      INSERT INTO client_services (user_id, name, duration_min, price, active)
      VALUES (?, ?, ?, ?, 1)
    `);
    const s1Res = insertService.run(tenantAUserId, 'Corte e Escova', 60, 120.00);
    serviceA1Id = Number(s1Res.lastInsertRowid);
    const s2Res = insertService.run(tenantAUserId, 'Coloração Global', 120, 250.00);
    serviceA2Id = Number(s2Res.lastInsertRowid);

    // Insere atendimentos no Tenant A com formatos mistos (ISO com 'T' e SQL com espaço ' ')
    const insertApt = db.prepare(`
      INSERT INTO appointments (
        user_id, title, description, client_name, client_phone, staff_id, service_id,
        start_datetime, end_datetime, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Atendimento 1: 2026-11-27 10:00:00 (formato espaço)
    insertApt.run(
      tenantAUserId, 'Corte e Escova - Mariana Silva', 'Agendado pelo WhatsApp', 'Mariana Silva', '5511988881111', staffA1Id, serviceA1Id,
      '2026-11-27 10:00:00', '2026-11-27 11:00:00', 'CONFIRMED'
    );

    // Atendimento 2: 2026-11-27T14:30:00 (formato ISO com T)
    insertApt.run(
      tenantAUserId, 'Coloração Global - Fernanda Costa', 'Aguardando confirmação', 'Fernanda Costa', '5511988882222', staffA1Id, serviceA2Id,
      '2026-11-27T14:30:00', '2026-11-27T16:30:00', 'PENDING'
    );

    // Atendimento 3: 2026-11-28 09:00:00 (outro dia)
    insertApt.run(
      tenantAUserId, 'Corte e Escova - Luciana Dias', 'Retorno quinzenal', 'Luciana Dias', '5511988883333', staffA1Id, serviceA1Id,
      '2026-11-28 09:00:00', '2026-11-28 10:00:00', 'CONFIRMED'
    );

    // Atendimento Tenant B (deve ser estritamente isolado)
    insertApt.run(
      tenantBUserId, 'Atendimento B - João Invasor', 'Tenant B isolado', 'João Invasor', '5511977770000', null, null,
      '2026-11-27 10:00:00', '2026-11-27 10:30:00', 'CONFIRMED'
    );

    // Realiza login HTTP com Tenant A para obter cookie de sessão
    tenantACookie = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        email: 'isabela.bella@teste.com.br',
        password: 'SenhaForteBella@2026',
      });
      const req = http.request(`${baseUrl}/api/client/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        const rawCookies = res.headers['set-cookie'] || [];
        const sessionCookie = rawCookies.map((c) => c.split(';')[0]).join('; ');
        resolve(sessionCookie);
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
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

  // -----------------------------------------------------------------------
  // TESTE 1: Normalização de Datas (normalizeFilterDate)
  // -----------------------------------------------------------------------
  test('1. normalizeFilterDate: normaliza strings YYYY-MM-DD e ISO com espaço', () => {
    const fn = salonAppointmentService.normalizeFilterDate;
    assert.strictEqual(typeof fn, 'function', 'normalizeFilterDate deve ser exportada');

    // Início de dia
    assert.strictEqual(fn('2026-11-27', false), '2026-11-27 00:00:00');
    // Fim de dia
    assert.strictEqual(fn('2026-11-27', true), '2026-11-27 23:59:59');

    // Com T
    assert.strictEqual(fn('2026-11-27T08:00:00', false), '2026-11-27 08:00:00');
    assert.strictEqual(fn('2026-11-27T08:00', false), '2026-11-27 08:00:00');

    // Nulos / indefinidos retornam null
    assert.strictEqual(fn(null), null);
    assert.strictEqual(fn(''), null);
    assert.strictEqual(fn(undefined), null);
  });

  // -----------------------------------------------------------------------
  // TESTE 2: Isolamento Multi-Tenant e Filtragem por Período
  // -----------------------------------------------------------------------
  test('2. listAppointments: respeita user_id estritamente e compara datas com espaço e com T uniformemente', () => {
    // Consulta do Tenant A no dia 2026-11-27
    const resultDayA = salonAppointmentService.listAppointments(tenantAUserId, {
      startDate: '2026-11-27',
      endDate: '2026-11-27',
    });

    // Deve retornar 2 atendimentos de A (o com espaço e o com T), NUNCA o de B
    assert.strictEqual(resultDayA.length, 2, 'Tenant A deve ter exatamente 2 atendimentos no dia 27');
    const names = resultDayA.map((a) => a.client_name);
    assert.ok(names.includes('Mariana Silva'), 'Deve incluir Mariana Silva (formato espaço)');
    assert.ok(names.includes('Fernanda Costa'), 'Deve incluir Fernanda Costa (formato T)');
    assert.ok(!names.includes('João Invasor'), 'Tenant B NUNCA pode aparecer no Tenant A');

    // Consulta do Tenant B
    const resultDayB = salonAppointmentService.listAppointments(tenantBUserId, {
      startDate: '2026-11-27',
      endDate: '2026-11-27',
    });
    assert.strictEqual(resultDayB.length, 1, 'Tenant B deve ter apenas o seu agendamento');
    assert.strictEqual(resultDayB[0].client_name, 'João Invasor');
  });

  // -----------------------------------------------------------------------
  // TESTE 3: Ordenação Dinâmica (ASC em períodos e DESC no padrão) e Limite Parametrizado
  // -----------------------------------------------------------------------
  test('3. listAppointments: ordenação cronológica ASC quando há período e DESC sem período', () => {
    // Com período: ASC (o das 10:00 deve vir antes do das 14:30)
    const ascList = salonAppointmentService.listAppointments(tenantAUserId, {
      startDate: '2026-11-27',
      endDate: '2026-11-27',
    });
    assert.strictEqual(ascList[0].client_name, 'Mariana Silva');
    assert.strictEqual(ascList[1].client_name, 'Fernanda Costa');

    // Sem período: DESC padrão
    const descList = salonAppointmentService.listAppointments(tenantAUserId, {});
    assert.strictEqual(descList.length, 3, 'Tenant A possui 3 atendimentos no total');
    // Mais recente é dia 28
    assert.strictEqual(descList[0].client_name, 'Luciana Dias');

    // Limite parametrizado
    const limitedList = salonAppointmentService.listAppointments(tenantAUserId, { limit: 1 });
    assert.strictEqual(limitedList.length, 1);
  });

  // -----------------------------------------------------------------------
  // TESTE 4: Filtros de Serviço (serviceId) e Profissional (staffId)
  // -----------------------------------------------------------------------
  test('4. listAppointments: suporta filtro combinado por serviceId e staffId', () => {
    const listS2 = salonAppointmentService.listAppointments(tenantAUserId, {
      serviceId: serviceA2Id,
    });
    assert.strictEqual(listS2.length, 1);
    assert.strictEqual(listS2[0].client_name, 'Fernanda Costa');
    assert.strictEqual(listS2[0].service_name, 'Coloração Global');

    const listS1 = salonAppointmentService.listAppointments(tenantAUserId, {
      serviceId: serviceA1Id,
    });
    assert.strictEqual(listS1.length, 2);
  });

  // -----------------------------------------------------------------------
  // TESTE 5: Compatibilidade com Demonstração Comercial Studio Aurora Beauty
  // -----------------------------------------------------------------------
  test('5. Studio Aurora: atendimentos semeados da Mariana Alves são consultáveis pelo calendário nativo', () => {
    const res = demoStudioAuroraService.ensureDemoStudioAuroraAccount();
    assert.strictEqual(res.success, true, 'Studio Aurora deve ser provisionado com sucesso');
    const auroraUser = demoStudioAuroraService.getDemoAuroraUser();
    assert.ok(auroraUser && auroraUser.id, 'Studio Aurora deve existir');

    // Consulta os agendamentos da Aurora
    const auroraApts = salonAppointmentService.listAppointments(auroraUser.id, {
      limit: 100,
    });

    assert.ok(auroraApts.length >= 20, `Studio Aurora deve ter agendamentos semeados (encontrados: ${auroraApts.length})`);
    
    // Testa consulta filtrando pelo primeiro agendamento
    const firstApt = auroraApts[0];
    const dateStr = firstApt.start_datetime.substring(0, 10);
    const dayApts = salonAppointmentService.listAppointments(auroraUser.id, {
      startDate: dateStr,
      endDate: dateStr,
    });
    assert.ok(dayApts.length >= 1, `Deve retornar agendamento da Aurora no dia ${dateStr}`);
    assert.strictEqual(dayApts[0].user_id, auroraUser.id, 'Isolamento de tenant do Studio Aurora preservado');
  });

  // -----------------------------------------------------------------------
  // TESTE 6: Rota HTTP Express GET /api/client/appointments com Novos Parâmetros
  // -----------------------------------------------------------------------
  test('6. HTTP GET /api/client/appointments: autenticação, service_id, start_date, end_date', async () => {
    const url = `${baseUrl}/api/client/appointments?start_date=2026-11-27&end_date=2026-11-27&service_id=${serviceA1Id}&order=ASC`;
    
    const responseData = await new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: 'GET',
        headers: {
          'Cookie': tenantACookie,
        },
      }, (res) => {
        assert.strictEqual(res.statusCode, 200, 'Status deve ser 200 OK');
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.end();
    });

    assert.ok(responseData.success, 'Resposta deve indicar success: true');
    assert.strictEqual(responseData.appointments.length, 1, 'Deve filtrar 1 agendamento do serviço 1');
    assert.strictEqual(responseData.appointments[0].client_name, 'Mariana Silva');
  });

  // -----------------------------------------------------------------------
  // TESTE 7: Teste Negativo — Bloqueio de Acesso Não Autenticado
  // -----------------------------------------------------------------------
  test('7. HTTP GET /api/client/appointments: bloqueia requisição não autenticada com HTTP 401', async () => {
    const url = `${baseUrl}/api/client/appointments?start_date=2026-11-27`;
    
    const status = await new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: 'GET',
      }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });

    assert.strictEqual(status, 401, 'Endpoint de agendamentos deve exigir autenticação');
  });

  // -----------------------------------------------------------------------
  // TESTE 8: Integridade DOM de public/cliente/painel.html
  // -----------------------------------------------------------------------
  test('8. painel.html: contém os containers das 4 views, controles temporais, filtros e modal de detalhes', () => {
    const htmlPath = path.join(__dirname, '../public/cliente/painel.html');
    assert.ok(fs.existsSync(htmlPath), 'Arquivo painel.html deve existir');
    const content = fs.readFileSync(htmlPath, 'utf8');

    // 4 Views
    assert.ok(content.includes('id="aptListView"'), 'Deve conter container #aptListView');
    assert.ok(content.includes('id="aptDayView"'), 'Deve conter container #aptDayView');
    assert.ok(content.includes('id="aptWeekView"'), 'Deve conter container #aptWeekView');
    assert.ok(content.includes('id="aptMonthView"'), 'Deve conter container #aptMonthView');

    // Controles Temporais
    assert.ok(content.includes('id="aptNavPrev"'), 'Deve conter botão #aptNavPrev');
    assert.ok(content.includes('id="aptNavToday"'), 'Deve conter botão #aptNavToday');
    assert.ok(content.includes('id="aptNavNext"'), 'Deve conter botão #aptNavNext');
    assert.ok(content.includes('id="aptPeriodTitle"'), 'Deve conter título #aptPeriodTitle');
    assert.ok(content.includes('id="aptPeriodStats"'), 'Deve conter contador #aptPeriodStats');
    assert.ok(content.includes('id="btnAptJumpDate"'), 'Deve conter botão de salto #btnAptJumpDate');
    assert.ok(content.includes('id="aptJumpDatePicker"'), 'Deve conter seletor de data #aptJumpDatePicker');

    // Filtros
    assert.ok(content.includes('id="aptStaffFilter"'), 'Deve conter seletor #aptStaffFilter');
    assert.ok(content.includes('id="aptServiceFilter"'), 'Deve conter seletor #aptServiceFilter');

    // Modal de Detalhes
    assert.ok(content.includes('id="modalAppointmentDetails"'), 'Deve conter modal #modalAppointmentDetails');
    assert.ok(content.includes('id="btnAptDetailsReschedule"'), 'Deve conter botão de remarcar #btnAptDetailsReschedule');
    assert.ok(content.includes('id="btnAptDetailsStatus"'), 'Deve conter botão de status #btnAptDetailsStatus');
    assert.ok(content.includes('id="btnAptDetailsCancel"'), 'Deve conter botão de cancelar #btnAptDetailsCancel');
  });
});
