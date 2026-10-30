const assert = require('assert');
const http = require('http');
const { app } = require('../src/server/app');
const db = require('../src/database/db');

async function testHttpEndpoints() {
  console.log('\n🌐 TESTANDO ENDPOINTS HTTP (EXPRESS ROUTING & GUARDS)...\n');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Client Login endpoint
    const loginRes = await fetch(`${baseUrl}/api/cliente/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'homologacao.hotmart@raiaagentes.com.br',
        password: process.env.DEMO_ACCOUNT_PASSWORD || 'RaiaHotmart#2026!Demo'
      })
    });

    const loginData = await loginRes.json();
    assert.strictEqual(loginRes.status, 200);
    assert.strictEqual(loginData.success, true);
    assert.ok(loginData.token);
    const demoToken = loginData.token;
    console.log('  ✅ [PASS] POST /api/cliente/auth/login (Demo account login OK)');

    // 2. Client Profile endpoint
    const profileRes = await fetch(`${baseUrl}/api/cliente/profile`, {
      headers: { 'Authorization': `Bearer ${demoToken}` }
    });
    const profileData = await profileRes.json();
    assert.strictEqual(profileRes.status, 200);
    assert.strictEqual(profileData.success, true);
    const profileUser = profileData.profile || profileData.data;
    assert.strictEqual(profileUser.email, 'homologacao.hotmart@raiaagentes.com.br');
    console.log('  ✅ [PASS] GET /api/cliente/profile (Tenant profile OK)');

    // 3. Pro Dashboard endpoint (Demo is PRO)
    const proDashRes = await fetch(`${baseUrl}/api/cliente/pro/dashboard`, {
      headers: { 'Authorization': `Bearer ${demoToken}` }
    });
    const proDashData = await proDashRes.json();
    assert.strictEqual(proDashRes.status, 200);
    assert.strictEqual(proDashData.success, true);
    assert.ok(proDashData.metrics);
    console.log('  ✅ [PASS] GET /api/cliente/pro/dashboard (Pro plan allowed, metrics OK)');

    // 4. Marketing Event Ingestion
    const eventRes = await fetch(`${baseUrl}/api/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventName: 'page_view',
        pageUrl: 'https://raiaagentes.com.br/planos',
        utmSource: 'facebook_ads',
        utmMedium: 'feed'
      })
    });
    const eventData = await eventRes.json();
    assert.strictEqual(eventRes.status, 200);
    assert.strictEqual(eventData.success, true);
    console.log('  ✅ [PASS] POST /api/analytics/event (LGPD tracking OK)');

    // 5. Unauthorized user trying to access admin analytics (403 Forbidden)
    const unauthRes = await fetch(`${baseUrl}/api/admin/analytics/overview`, {
      headers: { 'Authorization': `Bearer ${demoToken}` } // demoToken is not ADMIN
    });
    assert.strictEqual(unauthRes.status, 403);
    console.log('  ✅ [PASS] GET /api/admin/analytics/overview (Blocked for non-admin: 403 Forbidden)');

    // 6. Admin Login and Analytics Overview
    const adminLoginRes = await fetch(`${baseUrl}/api/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || 'admin123' })
    });
    const adminLoginData = await adminLoginRes.json();
    if (adminLoginData.success && adminLoginData.token) {
      const adminToken = adminLoginData.token;
      const overviewRes = await fetch(`${baseUrl}/api/admin/analytics/overview?days=30`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const overviewData = await overviewRes.json();
      assert.strictEqual(overviewRes.status, 200);
      assert.strictEqual(overviewData.success, true);
      assert.ok(overviewData.funnel);
      console.log('  ✅ [PASS] GET /api/admin/analytics/overview (Admin authorized: 200 OK)');

      const affRes = await fetch(`${baseUrl}/api/admin/analytics/affiliates?days=30`, {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const affData = await affRes.json();
      assert.strictEqual(affRes.status, 200);
      assert.strictEqual(affData.success, true);
      console.log('  ✅ [PASS] GET /api/admin/analytics/affiliates (Official affiliate report: 200 OK)');
    }

    console.log('\n🎉 TODOS OS TESTES HTTP PASSARAM COM SUCESSO!\n');
    process.exit(0);
  } finally {
    server.close();
  }
}

testHttpEndpoints().catch(err => {
  console.error('❌ ERRO NOS TESTES HTTP:', err);
  process.exit(1);
});
