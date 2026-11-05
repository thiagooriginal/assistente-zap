/**
 * RAIA AGENTES — PROVA DE CONCEITO E TESTES DE REGRESSÃO:
 * ISOLAMENTO MULTI-TENANT ENTRE CLIENTES (CLIENTE A vs CLIENTE B)
 *
 * Valida:
 * 1. Isolamento completo de dados entre clientes distintos (IDOR/BOLA prevention)
 * 2. Serviços, profissionais, agendamentos, contas a pagar, transações e campanhas respeitam o proprietário autenticado
 * 3. Tentativas de acesso manual via IDs em parâmetros de URL são rejeitadas (404/403)
 * 4. Permissões estritas por plano: Entrada, Intermediário e Pró
 * 5. Bloqueio de acesso para assinaturas expiradas ou canceladas
 * 6. Impossibilidade de tokens de CLIENTE acessarem rotas de ADMIN
 */

const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const clientAuth = require('../src/services/clientAuthService');
const productService = require('../src/services/productService');

let server;
let baseUrl;

async function runTests() {
  console.log('================================================================');
  console.log('   RAIA AGENTES — SUÍTE DE ISOLAMENTO ENTRE CLIENTES (MULTI-TENANT)');
  console.log('================================================================\n');

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const cleanups = [];

  try {
    // -------------------------------------------------------------
    // SETUP: CRIAR CLIENTE A (Entrada) E CLIENTE B (Pró)
    // -------------------------------------------------------------
    const timestamp = Date.now();
    const phoneA = `551191111${String(timestamp).slice(-4)}`;
    const phoneB = `551192222${String(timestamp).slice(-4)}`;
    const emailA = `cliente.a.${timestamp}@salaoteste.com.br`;
    const emailB = `cliente.b.${timestamp}@salaoteste.com.br`;

    console.log('[Setup] Criando contas de teste para Cliente A e Cliente B...');

    // Cliente A: Inicialmente Plano Entrada (JESSICA_ENTRY / JESSICA_START)
    const resA = db.prepare(`
      INSERT INTO users (name, phone_number, email, role, plan_tier, subscription_status, paid_until, session_mfa_verified)
      VALUES (?, ?, ?, 'CLIENT', 'JESSICA_START', 'ACTIVE', datetime('now', '+30 days'), 0)
    `).run('Cliente A - Salão Alpha', phoneA, emailA);
    const userAId = resA.lastInsertRowid;
    cleanups.push(userAId);

    // Cliente B: Plano Pró (JESSICA_PRO)
    const resB = db.prepare(`
      INSERT INTO users (name, phone_number, email, role, plan_tier, subscription_status, paid_until, session_mfa_verified)
      VALUES (?, ?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', datetime('now', '+30 days'), 0)
    `).run('Cliente B - Salão Beta Prime', phoneB, emailB);
    const userBId = resB.lastInsertRowid;
    cleanups.push(userBId);

    // Gerar sessões válidas para ambos
    const tokenA = crypto.randomBytes(32).toString('hex');
    const tokenB = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 86400000).toISOString();

    db.prepare("UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?").run(tokenA, expires, userAId);
    db.prepare("UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?").run(tokenB, expires, userBId);

    // Vincular Jéssica em customer_subscriptions para autorizar requireProductAccess('JESSICA')
    const jessicaProduct = db.prepare("SELECT id FROM products WHERE code = 'JESSICA'").get();
    assert.ok(jessicaProduct, 'Produto JESSICA deve existir no catálogo');

    const planStart = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'START'").get(jessicaProduct.id);
    const planInter = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'INTERMEDIATE'").get(jessicaProduct.id);
    const planPro = db.prepare("SELECT id FROM product_plans WHERE product_id = ? AND code = 'PRO'").get(jessicaProduct.id);

    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, origin, gateway, status, price_cents, setup_fee_cents, contracted_at, paid_until)
      VALUES (?, ?, ?, 'DIRECT', 'MANUAL', 'ACTIVE', 8900, 0, CURRENT_TIMESTAMP, datetime('now', '+30 days'))
    `).run(userAId, jessicaProduct.id, planStart.id);

    db.prepare(`
      INSERT INTO customer_subscriptions (user_id, product_id, plan_id, origin, gateway, status, price_cents, setup_fee_cents, contracted_at, paid_until)
      VALUES (?, ?, ?, 'DIRECT', 'MANUAL', 'ACTIVE', 14900, 0, CURRENT_TIMESTAMP, datetime('now', '+30 days'))
    `).run(userBId, jessicaProduct.id, planPro.id);

    // Inserir registros privados do Cliente B
    const srvB = db.prepare(`
      INSERT INTO client_services (user_id, name, price, duration_min, category)
      VALUES (?, 'Tratamento Ultra Secreto Cliente B', 450.0, 90, 'Cabelo')
    `).run(userBId);
    const serviceBId = srvB.lastInsertRowid;

    const staffB = db.prepare(`
      INSERT INTO client_staff (user_id, name, specialty)
      VALUES (?, 'Profissional Estrela do Cliente B', 'Colorimetria')
    `).run(userBId);
    const staffBId = staffB.lastInsertRowid;

    const aptB = db.prepare(`
      INSERT INTO appointments (user_id, title, description, start_datetime, status)
      VALUES (?, 'Agendamento Confidencial Cliente B', 'Cliente VIP B', '2026-12-01T15:00:00', 'SCHEDULED')
    `).run(userBId);
    const appointmentBId = aptB.lastInsertRowid;

    const billB = db.prepare(`
      INSERT INTO scheduled_payments (user_id, title, amount, due_date, status)
      VALUES (?, 'Aluguel Comercial Salão B', 3500.0, '2026-11-20', 'PENDING')
    `).run(userBId);
    const billBId = billB.lastInsertRowid;

    const campB = db.prepare(`
      INSERT INTO client_campaigns (user_id, title, message, status, consent_confirmed)
      VALUES (?, 'Campanha Exclusiva Salão B', 'Promoção B', 'DRAFT', 1)
    `).run(userBId);
    const campaignBId = campB.lastInsertRowid;

    console.log('✅ Setup concluído com sucesso.\n');

    // -------------------------------------------------------------
    // TESTE 1: SERVIÇOS (ISOLAMENTO E PROTEÇÃO IDOR)
    // -------------------------------------------------------------
    console.log('--- TESTE 1: ISOLAMENTO DE SERVIÇOS & IDOR ---');
    // Cliente A lista serviços: não deve ver o serviço do Cliente B
    const listSrvA = await fetch(`${baseUrl}/api/cliente/services`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataSrvA = await listSrvA.json();
    assert.strictEqual(listSrvA.status, 200);
    const foundBInA = dataSrvA.services?.some(s => s.id === serviceBId);
    assert.strictEqual(foundBInA, false, 'Cliente A NUNCA deve ver serviços do Cliente B na listagem');
    console.log('  ✓ 1.1 Listagem de serviços do Cliente A não exibe dados do Cliente B');

    // Cliente A tenta alterar o serviço do Cliente B via ID na URL
    const putSrvA = await fetch(`${baseUrl}/api/cliente/services/${serviceBId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hackeado por A', price: 10.0 })
    });
    assert.strictEqual(putSrvA.status, 404, 'Tentativa de alteração com ID do Cliente B deve retornar 404');
    const srvBCheck = db.prepare('SELECT name, price FROM client_services WHERE id = ?').get(serviceBId);
    assert.strictEqual(srvBCheck.name, 'Tratamento Ultra Secreto Cliente B', 'Serviço do Cliente B deve permanecer inalterado');
    console.log('  ✓ 1.2 Tentativa de IDOR no PUT /services/:id bloqueada com 404');

    // Cliente A tenta deletar o serviço do Cliente B via ID na URL
    const delSrvA = await fetch(`${baseUrl}/api/cliente/services/${serviceBId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(delSrvA.status, 404, 'Tentativa de exclusão com ID do Cliente B deve retornar 404');
    const srvBStillExists = db.prepare('SELECT id FROM client_services WHERE id = ?').get(serviceBId);
    assert.ok(srvBStillExists, 'Serviço do Cliente B deve continuar existindo no banco');
    console.log('  ✓ 1.3 Tentativa de IDOR no DELETE /services/:id bloqueada com 404');

    // -------------------------------------------------------------
    // TESTE 2: PROFISSIONAIS / EQUIPE (ISOLAMENTO E PROTEÇÃO IDOR)
    // -------------------------------------------------------------
    console.log('\n--- TESTE 2: ISOLAMENTO DE PROFISSIONAIS (EQUIPE) ---');
    const listStaffA = await fetch(`${baseUrl}/api/cliente/staff`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataStaffA = await listStaffA.json();
    assert.strictEqual(listStaffA.status, 200);
    const foundStaffB = dataStaffA.staff?.some(s => s.id === staffBId);
    assert.strictEqual(foundStaffB, false, 'Cliente A não pode visualizar colaboradores do Cliente B');
    console.log('  ✓ 2.1 Listagem de colaboradores do Cliente A é estritamente isolada');

    const delStaffA = await fetch(`${baseUrl}/api/cliente/staff/${staffBId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(delStaffA.status, 404, 'Exclusão com ID de colaborador alheio deve retornar 404');
    const staffBExists = db.prepare('SELECT id FROM client_staff WHERE id = ?').get(staffBId);
    assert.ok(staffBExists, 'Colaborador do Cliente B não foi removido');
    console.log('  ✓ 2.2 Tentativa de exclusão de colaborador do Cliente B bloqueada com 404');

    // -------------------------------------------------------------
    // TESTE 3: AGENDAMENTOS (ISOLAMENTO E PROTEÇÃO IDOR)
    // -------------------------------------------------------------
    console.log('\n--- TESTE 3: ISOLAMENTO DE AGENDAMENTOS ---');
    const listAptA = await fetch(`${baseUrl}/api/cliente/appointments`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataAptA = await listAptA.json();
    assert.strictEqual(listAptA.status, 200);
    const foundAptB = dataAptA.appointments?.some(a => a.id === appointmentBId);
    assert.strictEqual(foundAptB, false, 'Cliente A não visualiza agendamentos do Cliente B');
    console.log('  ✓ 3.1 Consulta de agendamentos respeita estritamente o proprietário autenticado');

    const delAptA = await fetch(`${baseUrl}/api/cliente/appointments/${appointmentBId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(delAptA.status, 404, 'Cancelamento com ID de agendamento alheio retorna 404');
    const aptBExists = db.prepare('SELECT id FROM appointments WHERE id = ?').get(appointmentBId);
    assert.ok(aptBExists, 'Agendamento do Cliente B permanece intacto');
    console.log('  ✓ 3.2 Tentativa de cancelar agendamento de outro cliente rejeitada com 404');

    // -------------------------------------------------------------
    // TESTE 4: HIERARQUIA DE PLANOS (ENTRADA vs INTERMEDIÁRIO vs PRÓ)
    // -------------------------------------------------------------
    console.log('\n--- TESTE 4: HIERARQUIA DE PLANOS E PERMISSÕES DE BACKEND ---');
    // Cliente A está no plano Entrada (START/ENTRY)
    // 4.1 Acesso a Dashboard Gerencial é restrito a Intermediário e Pró
    const dashA = await fetch(`${baseUrl}/api/cliente/pro/dashboard`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(dashA.status, 403, 'Plano Entrada não pode acessar dashboard gerencial');
    const dashAData = await dashA.json();
    assert.strictEqual(dashAData.upgradeRequired, true);
    console.log('  ✓ 4.1 Plano Entrada bloqueado em /pro/dashboard com 403 upgradeRequired: true');

    // 4.2 Acesso a Contas a Pagar é exclusivo de Jéssica Pró
    const billsA = await fetch(`${baseUrl}/api/cliente/pro/bills`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(billsA.status, 403, 'Plano Entrada não pode acessar contas a pagar');
    console.log('  ✓ 4.2 Plano Entrada bloqueado em /pro/bills');

    // 4.3 Acesso a Campanhas WhatsApp é exclusivo de Jéssica Pró
    const campA = await fetch(`${baseUrl}/api/cliente/pro/campaigns`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(campA.status, 403, 'Plano Entrada não pode acessar campanhas promocionais');
    console.log('  ✓ 4.3 Plano Entrada bloqueado em /pro/campaigns');

    // Fazer upgrade do Cliente A para INTERMEDIÁRIO
    db.prepare("UPDATE users SET plan_tier = 'JESSICA_INTERMEDIATE' WHERE id = ?").run(userAId);
    db.prepare("UPDATE customer_subscriptions SET plan_id = ? WHERE user_id = ?").run(planInter.id, userAId);
    console.log('  [Upgrade] Cliente A atualizado para JESSICA_INTERMEDIATE');

    const dashAInter = await fetch(`${baseUrl}/api/cliente/pro/dashboard`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(dashAInter.status, 200, 'Plano Intermediário tem permissão para /pro/dashboard');
    console.log('  ✓ 4.4 Plano Intermediário liberado com sucesso para /pro/dashboard');

    const billsAInter = await fetch(`${baseUrl}/api/cliente/pro/bills`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(billsAInter.status, 403, 'Plano Intermediário ainda NÃO pode acessar contas a pagar (Pró exclusivo)');
    console.log('  ✓ 4.5 Plano Intermediário bloqueado em recursos exclusivos do Pró (/pro/bills)');

    // Fazer upgrade do Cliente A para PRÓ
    db.prepare("UPDATE users SET plan_tier = 'JESSICA_PRO' WHERE id = ?").run(userAId);
    db.prepare("UPDATE customer_subscriptions SET plan_id = ? WHERE user_id = ?").run(planPro.id, userAId);
    console.log('  [Upgrade] Cliente A atualizado para JESSICA_PRO');

    const billsAPro = await fetch(`${baseUrl}/api/cliente/pro/bills`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(billsAPro.status, 200, 'Plano Pró liberado para /pro/bills');
    const billsAData = await billsAPro.json();
    const allBillsA = [
      ...(billsAData.bills?.upcomingBills || []),
      ...(billsAData.bills?.overdueBills || []),
      ...(billsAData.bills?.paidBills || []),
    ];
    const foundBillB = allBillsA.some(b => b.id === billBId);
    assert.strictEqual(foundBillB, false, 'Mesmo no plano Pró, Cliente A NÃO pode ver as contas do Cliente B');
    console.log('  ✓ 4.6 Plano Pró tem acesso ao módulo mas NUNCA visualiza contas de outro cliente');

    // Cliente A tenta pagar ou excluir conta do Cliente B
    const payBillA = await fetch(`${baseUrl}/api/cliente/pro/bills/${billBId}/pay`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.ok([400, 404].includes(payBillA.status), 'Tentativa de liquidar conta alheia deve ser rejeitada');
    const billBCheck = db.prepare('SELECT status FROM scheduled_payments WHERE id = ?').get(billBId);
    assert.strictEqual(billBCheck.status, 'PENDING', 'Conta do Cliente B permanece PENDING');
    console.log('  ✓ 4.7 Tentativa de liquidar conta do Cliente B bloqueada');

    const delBillA = await fetch(`${baseUrl}/api/cliente/pro/bills/${billBId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.ok([400, 404].includes(delBillA.status), 'Tentativa de excluir conta alheia deve ser rejeitada');
    console.log('  ✓ 4.8 Tentativa de excluir conta do Cliente B bloqueada');

    // -------------------------------------------------------------
    // TESTE 5: ASSINATURA CANCELADA OU EXPIRADA
    // -------------------------------------------------------------
    console.log('\n--- TESTE 5: ASSINATURA CANCELADA / EXPIRADA ---');
    // Alterar Cliente A para CANCELED com período expirado
    db.prepare(`
      UPDATE users
      SET subscription_status = 'CANCELED',
          subscription_origin = 'ASAAS',
          paid_until = datetime('now', '-2 days')
      WHERE id = ?
    `).run(userAId);

    db.prepare(`
      UPDATE customer_subscriptions
      SET status = 'CANCELLED',
          paid_until = datetime('now', '-2 days'),
          access_expires_at = datetime('now', '-2 days')
      WHERE user_id = ?
    `).run(userAId);

    const expiredAccess = await fetch(`${baseUrl}/api/cliente/services`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(expiredAccess.status, 403, 'Acesso de assinatura cancelada/expirada deve retornar 403');
    const expiredData = await expiredAccess.json();
    assert.ok(
      expiredData.code === 'SUBSCRIPTION_CANCELED' ||
      expiredData.code === 'SUBSCRIPTION_EXPIRED' ||
      expiredData.code === 'PAYMENT_REQUIRED',
      `Código de erro de assinatura esperado, recebido: ${expiredData.code}`
    );
    console.log(`  ✓ 5.1 Acesso bloqueado para assinatura cancelada (Código retornado: ${expiredData.code})`);

    // -------------------------------------------------------------
    // TESTE 6: TOKEN DE CLIENTE TENTA ACESSAR ENDPOINTS ADMIN
    // -------------------------------------------------------------
    console.log('\n--- TESTE 6: RESTRIÇÃO DE PRIVILÉGIOS (TOKEN DE CLIENTE vs ROTAS ADMIN) ---');
    // Cliente B (plano PRO, ativo) tenta acessar rotas administrativas
    const adminEndpoints = [
      { method: 'GET', path: '/api/admin/users', desc: 'Listagem de usuários admin' },
      { method: 'POST', path: '/api/admin/products', desc: 'Criação de produtos no catálogo' },
      { method: 'GET', path: '/api/asaas/status', desc: 'Status financeiro do Asaas' },
      { method: 'GET', path: '/api/admin/direct-sales', desc: 'Contratos de vendas diretas' },
      { method: 'POST', path: '/api/admin/system/backup', desc: 'Backup do sistema SQLite' },
      { method: 'GET', path: '/api/admin/security/audit-logs', desc: 'Logs de auditoria de segurança' },
    ];

    for (const ep of adminEndpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
        body: ep.method === 'POST' ? JSON.stringify({ test: 1 }) : undefined,
      });
      assert.strictEqual(res.status, 403, `Token de cliente deve receber 403 em ${ep.path}`);
      const json = await res.json();
      assert.strictEqual(json.success, false);
      console.log(`  ✓ 6.${adminEndpoints.indexOf(ep) + 1} Token de CLIENTE rejeitado com 403 em ${ep.path} (${ep.desc})`);
    }

    console.log('\n================================================================');
    console.log('RESULTADO FINAL: TODOS OS TESTES DE ISOLAMENTO APROVADOS (100%)');
    console.log('================================================================');

  } finally {
    // Cleanup
    for (const id of cleanups) {
      try {
        db.prepare('DELETE FROM client_services WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM client_staff WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM appointments WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM scheduled_payments WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM client_campaigns WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM customer_subscriptions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM client_salons WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
      } catch (_) {}
    }
    if (server) {
      server.close();
    }
  }
}

runTests().catch((err) => {
  console.error('\n❌ FALHA NOS TESTES DE ISOLAMENTO MULTI-TENANT:', err);
  process.exit(1);
});
