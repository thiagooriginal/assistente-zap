const http = require('http');
const assert = require('assert');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const config = require('../src/config');
const clientAuth = require('../src/services/clientAuthService');

async function runDemoIsolationTests() {
  console.log('====================================================');
  console.log('   RAIA AGENTES — PROVA DE ISOLAMENTO CONTA DEMO');
  console.log('====================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Initialize demo account
    clientAuth.ensureDemoAccount();
    const demoEmail = config.demoAccountEmail;
    const demoPassword = config.demoAccountPassword;

    console.log(`[1/6] Realizando login na Conta Demonstrativa (${demoEmail})...`);
    const loginRes = await fetch(`${baseUrl}/api/cliente/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: demoEmail, password: demoPassword }),
    });
    const loginData = await loginRes.json();
    assert.strictEqual(loginRes.status, 200, 'Login da conta demo falhou');
    assert.strictEqual(loginData.success, true);
    assert.strictEqual(loginData.user.is_demo, 1, 'Conta deve ter is_demo = 1');
    const demoToken = loginData.token;
    console.log(`      ✅ Login demo autenticado com sucesso! Token: ${demoToken.substring(0, 8)}...`);

    // 2. Create an isolated REAL client with sensitive private data
    console.log(`\n[2/6] Criando cliente REAL no banco para teste de isolamento multitenant...`);
    const realEmail = `real.proprietario.${Date.now()}@salaoluxo.com.br`;
    const realPhone = `55119${Date.now().toString().slice(-8)}`;
    const realUserInsert = db.prepare(`
      INSERT INTO users (name, email, phone_number, plan_tier, subscription_status, is_demo)
      VALUES (?, ?, ?, 'JESSICA_PRO', 'ACTIVE', 0)
    `).run('Dra. Helena Propriétária Real', realEmail, realPhone);
    const realUserId = realUserInsert.lastInsertRowid;

    // Insert real salon, services, staff, appointments
    db.prepare(`
      INSERT INTO client_salons (user_id, salon_name, phone, address)
      VALUES (?, 'Helena Haute Coiffure [DADOS REAIS]', '(11) 98888-7777', 'Rua Oscar Freire, 500')
    `).run(realUserId);

    const realServiceInsert = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category)
      VALUES (?, 'Tratamento Ouro 24k Exclusivo', 1200.0, 120, 'Luxo')
    `).run(realUserId);
    const realServiceId = realServiceInsert.lastInsertRowid;

    db.prepare(`
      INSERT INTO client_staff (user_id, name, specialty)
      VALUES (?, 'Jean-Luc Stylist Privé', 'Haute Coiffure')
    `).run(realUserId);

    const realApptInsert = db.prepare(`
      INSERT INTO appointments (user_id, title, description, start_datetime, status)
      VALUES (?, 'VIP - Tratamento Ouro Cliente Sigiloso', 'Dados confidenciais', '2026-11-15T14:00:00', 'SCHEDULED')
    `).run(realUserId);
    const realApptId = realApptInsert.lastInsertRowid;
    console.log(`      ✅ Cliente real criado (ID #${realUserId}) com serviço (#${realServiceId}) e agendamento (#${realApptId}).`);

    // 3. Verify Demo User CANNOT see Real User Services
    console.log(`\n[3/6] Testando vazamento em Serviços (/api/cliente/services)...`);
    const servicesRes = await fetch(`${baseUrl}/api/cliente/services`, {
      headers: { Authorization: `Bearer ${demoToken}` },
    });
    const servicesData = await servicesRes.json();
    assert.strictEqual(servicesRes.status, 200);
    const leakedService = servicesData.services.find((s) => s.id === realServiceId || s.name.includes('Ouro 24k'));
    assert.strictEqual(leakedService, undefined, 'Vazamento detectado: Demo viu serviço de cliente real!');
    console.log(`      ✅ Isolamento de Serviços 100%: Nenhum dado do cliente real vazado para a demo.`);

    // 4. Verify Demo User CANNOT see Real User Appointments
    console.log(`\n[4/6] Testando vazamento em Agenda (/api/cliente/appointments)...`);
    const apptsRes = await fetch(`${baseUrl}/api/cliente/appointments`, {
      headers: { Authorization: `Bearer ${demoToken}` },
    });
    const apptsData = await apptsRes.json();
    assert.strictEqual(apptsRes.status, 200);
    const leakedAppt = apptsData.appointments.find((a) => a.id === realApptId || a.title.includes('Sigiloso'));
    assert.strictEqual(leakedAppt, undefined, 'Vazamento detectado: Demo viu agendamento de cliente real!');
    console.log(`      ✅ Isolamento de Agenda 100%: Agendamentos confidenciais inacessíveis pela demo.`);

    // 5. Test Demo User Cross-Tenant Mutation Attempt
    console.log(`\n[5/6] Testando tentativa de exclusão cruzada de dados reais pelo usuário demo...`);
    const deleteRes = await fetch(`${baseUrl}/api/cliente/services/${realServiceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${demoToken}` },
    });
    assert.strictEqual(deleteRes.status, 404, 'Conta demo não pode alterar registros de outros salões');
    console.log(`      ✅ Tentativa de mutação rejeitada com HTTP 404 (Proteção multi-tenant ativa).`);

    // 6. Test WhatsApp Message and Campaign Dispatch Block on Demo Account
    console.log(`\n[6/6] Comprovando bloqueio estrito de envio de mensagens reais de WhatsApp...`);
    const waTestRes = await fetch(`${baseUrl}/api/cliente/test-whatsapp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${demoToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetPhone: '5511999998888', message: 'Mensagem teste' }),
    });
    const waTestData = await waTestRes.json();
    assert.strictEqual(waTestRes.status, 403, 'Envio real de WhatsApp deveria ter retornado HTTP 403');
    assert.strictEqual(waTestData.isDemoBlocked, true);
    console.log(`      ✅ Disparo direto de WhatsApp bloqueado na demo: ${waTestData.error}`);

    // Create a demo campaign then attempt to send
    const campRes = await fetch(`${baseUrl}/api/cliente/pro/campaigns`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${demoToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Campanha Demo',
        message: 'Desconto de 20%',
        targetAudience: 'Todos',
        consentConfirmed: true,
      }),
    });
    const campData = await campRes.json();
    assert.strictEqual(campRes.status, 200);
    const demoCampId = campData.campaignId;

    const campSendRes = await fetch(`${baseUrl}/api/cliente/pro/campaigns/${demoCampId}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${demoToken}` },
    });
    const campSendData = await campSendRes.json();
    assert.strictEqual(campSendRes.status, 403, 'Envio de campanha em conta demo deveria ter retornado HTTP 403');
    assert.strictEqual(campSendData.isDemoBlocked, true);
    console.log(`      ✅ Disparo de campanhas promocionais bloqueado na demo: ${campSendData.error}`);

    // Clean up test real user
    db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(realUserId);
    db.prepare('DELETE FROM client_services WHERE user_id = ?').run(realUserId);
    db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(realUserId);
    db.prepare('DELETE FROM appointments WHERE user_id = ?').run(realUserId);
    db.prepare('DELETE FROM users WHERE id = ?').run(realUserId);

    console.log('\n====================================================');
    console.log('✅ COMPROVAÇÃO DE ISOLAMENTO DA CONTA DEMO: APROVADO!');
    console.log('   1. Zero acesso a dados e clientes reais.');
    console.log('   2. Zero possibilidade de envio de WhatsApp real.');
    console.log('   3. Proteção multi-tenant comprovada.');
    console.log('====================================================\n');
  } finally {
    server.close();
  }
}

if (require.main === module) {
  runDemoIsolationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Falha no teste de isolamento demo:', err);
      process.exit(1);
    });
}

module.exports = { runDemoIsolationTests };
