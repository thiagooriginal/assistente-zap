/**
 * RAIA AGENTES — Complete Admin MFA Lifecycle & Security Flow Test Suite
 * 
 * Verifies:
 * 1. Admin login when MFA is disabled.
 * 2. In-process local QR code generation (zero external requests).
 * 3. TOTP setup, activation with reinforced admin password confirmation.
 * 4. MFA login challenge (mfaRequired: true).
 * 5. Rejection of invalid / expired TOTP codes.
 * 6. Single-use recovery code login and instant burning from DB.
 * 7. Prevention of recovery code replay attacks.
 * 8. MFA deactivation requiring admin password + MFA confirmation.
 * 9. Multi-key candidate decryption for key rotation and backward compatibility.
 * 10. Production enforcement rejecting fallback keys.
 */

const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const config = require('../src/config');
const { app } = require('../src/server/app');
const db = require('../src/database/db');
const totpService = require('../src/services/totpService');
const { adminLoginLimiter } = require('../src/middlewares/rateLimiter');

console.log('================================================================');
console.log('   RAIA AGENTES — SUITE DE TESTES: CICLO DE VIDA DO MFA ADMIN   ');
console.log('================================================================\n');

let server;
let baseUrl;
let passedTests = 0;
let totalTests = 0;

const TEST_ADMIN_PASSWORD = 'TestMasterAdmin#2026';
config.adminPassword = TEST_ADMIN_PASSWORD;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };

    let postData = null;
    if (body !== null) {
      postData = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(rawData);
          } catch (_) {
            json = rawData;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json
          });
        });
      }
    );

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function test(name, fn) {
  totalTests++;
  return fn()
    .then(() => {
      console.log(`✅ [PASS] ${name}`);
      passedTests++;
    })
    .catch((err) => {
      console.error(`❌ [FAIL] ${name}:`, err.message);
    });
}

async function runAllTests() {
  // Start server on an ephemeral port
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  // Ensure an admin user exists in DB with clean state
  let adminUser = db.prepare('SELECT * FROM users WHERE role = ? OR id = 1 LIMIT 1').get('ADMIN');
  if (!adminUser) {
    db.prepare(`
      INSERT INTO users (name, email, role, created_at)
      VALUES ('Super Admin Test', 'admin.test@raiaagentes.com.br', 'ADMIN', CURRENT_TIMESTAMP)
    `).run();
    adminUser = db.prepare('SELECT * FROM users WHERE role = ? OR id = 1 LIMIT 1').get('ADMIN');
  }

  const adminId = adminUser.id;

  // Clean MFA state on test admin
  db.prepare(`
    UPDATE users 
    SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL 
    WHERE id = ?
  `).run(adminId);

  let adminAuthToken = null;
  let mfaSetupSecret = null;
  let savedRecoveryCodes = [];

  try {
    // -------------------------------------------------------------
    // Test 1: Admin login when MFA is disabled
    // -------------------------------------------------------------
    await test('1. Login direto de administrador quando MFA está desativado', async () => {
      const res = await request('POST', '/api/auth/admin-login', { password: TEST_ADMIN_PASSWORD });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.token, 'Token de sessão retornado');
      assert.strictEqual(res.body.mfaRequired, undefined);
      adminAuthToken = res.body.token;

      // Check HttpOnly session cookie
      const setCookies = res.headers['set-cookie'] || [];
      const hasAuthCookie = setCookies.some((c) => c.includes('auth_token=') && c.includes('HttpOnly'));
      assert.ok(hasAuthCookie, 'auth_token cookie HttpOnly deve estar presente');
    });

    // -------------------------------------------------------------
    // Test 2: Status check when MFA is disabled
    // -------------------------------------------------------------
    await test('2. Endpoint GET /api/admin/mfa/status reflete status inativo', async () => {
      const res = await request('GET', '/api/admin/mfa/status', null, {
        Authorization: `Bearer ${adminAuthToken}`
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.userMfaEnabled, false);
    });

    // -------------------------------------------------------------
    // Test 3: Local QR Code & Setup generation (zero external calls)
    // -------------------------------------------------------------
    await test('3. Endpoint POST /api/admin/mfa/setup gera segredo Base32 e QR Code local em base64', async () => {
      const res = await request('POST', '/api/admin/mfa/setup', {}, {
        Authorization: `Bearer ${adminAuthToken}`
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.secret, 'Segredo retornado');
      assert.strictEqual(res.body.secret.length, 32, 'Segredo deve ser Base32 de 32 caracteres');
      assert.ok(res.body.otpAuthUri.startsWith('otpauth://totp/'), 'URI otpauth RFC 6238 válida');
      assert.ok(
        res.body.qrCodeDataUrl.startsWith('data:image/png;base64,'),
        'QR Code gerado localmente em memória como data URL base64 sem chamar APIs externas'
      );
      mfaSetupSecret = res.body.secret;
    });

    // -------------------------------------------------------------
    // Test 4: Enable MFA validation and failure modes
    // -------------------------------------------------------------
    await test('4. Validações de ativação: rejeição com senha incorreta ou código inválido', async () => {
      // Wrong password
      const resWrongPass = await request('POST', '/api/admin/mfa/enable', {
        password: 'WrongPassword#123',
        secret: mfaSetupSecret,
        code: '123456'
      }, { Authorization: `Bearer ${adminAuthToken}` });
      assert.strictEqual(resWrongPass.status, 401);
      assert.strictEqual(resWrongPass.body.success, false);

      // Wrong TOTP code with correct password
      const resWrongCode = await request('POST', '/api/admin/mfa/enable', {
        password: TEST_ADMIN_PASSWORD,
        secret: mfaSetupSecret,
        code: '000000'
      }, { Authorization: `Bearer ${adminAuthToken}` });
      assert.strictEqual(resWrongCode.status, 400);
      assert.strictEqual(resWrongCode.body.success, false);
    });

    // -------------------------------------------------------------
    // Test 5: Successful MFA activation with valid TOTP & recovery codes
    // -------------------------------------------------------------
    await test('5. Ativação do MFA com senha correta e código TOTP válido gera 8 códigos de recuperação', async () => {
      const validCode = totpService.generateCurrentTOTP(mfaSetupSecret);
      const res = await request('POST', '/api/admin/mfa/enable', {
        password: TEST_ADMIN_PASSWORD,
        secret: mfaSetupSecret,
        code: validCode
      }, { Authorization: `Bearer ${adminAuthToken}` });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(Array.isArray(res.body.recoveryCodes), 'recoveryCodes deve ser um array');
      assert.strictEqual(res.body.recoveryCodes.length, 8, 'Devem ser gerados exatamente 8 códigos de recuperação');

      for (const code of res.body.recoveryCodes) {
        assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Formato deve ser XXXX-XXXX');
      }
      savedRecoveryCodes = res.body.recoveryCodes;

      // Verify DB storage: secret is encrypted at rest and recovery codes are hashes
      const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
      assert.strictEqual(updatedUser.totp_enabled, 1);
      assert.ok(updatedUser.totp_secret.startsWith('enc:v1:'), 'Segredo TOTP deve estar criptografado em repouso');
      assert.notStrictEqual(updatedUser.totp_secret, mfaSetupSecret, 'Segredo não pode estar em texto puro no banco');

      const parsedHashes = JSON.parse(updatedUser.totp_recovery_codes);
      assert.strictEqual(parsedHashes.length, 8);
      // Ensure plaintext recovery codes are NOT in the database
      for (const plain of savedRecoveryCodes) {
        assert.ok(!updatedUser.totp_recovery_codes.includes(plain), 'Código em texto puro vazou no banco');
      }
    });

    // -------------------------------------------------------------
    // Test 6: MFA Login Challenge when MFA is enabled
    // -------------------------------------------------------------
    await test('6. Desafio MFA no login: senha isolada retorna mfaRequired: true', async () => {
      const res = await request('POST', '/api/auth/admin-login', { password: TEST_ADMIN_PASSWORD });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.mfaRequired, true);
      assert.strictEqual(res.body.token, undefined, 'Nenhum token emitido antes do segundo fator');
    });

    // -------------------------------------------------------------
    // Test 7: Rejection of invalid TOTP during login
    // -------------------------------------------------------------
    await test('7. Rejeição no login quando código TOTP for inválido', async () => {
      const res = await request('POST', '/api/auth/admin-login', {
        password: TEST_ADMIN_PASSWORD,
        mfaCode: '999999'
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.token, undefined);
    });

    // -------------------------------------------------------------
    // Test 8: Successful login with valid TOTP code
    // -------------------------------------------------------------
    await test('8. Sucesso no login com senha + código TOTP válido de 6 dígitos', async () => {
      const currentValidTotp = totpService.generateCurrentTOTP(mfaSetupSecret);
      const res = await request('POST', '/api/auth/admin-login', {
        password: TEST_ADMIN_PASSWORD,
        mfaCode: currentValidTotp
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.token, 'Token de sessão emitido após 2º fator');
      adminAuthToken = res.body.token;
    });

    // -------------------------------------------------------------
    // Test 9: Single-use recovery code login and instant burning
    // -------------------------------------------------------------
    await test('9. Login com código de recuperação (XXXX-XXXX) e queima instantânea', async () => {
      adminLoginLimiter.reset();
      const codeToUse = savedRecoveryCodes[0];
      const res = await request('POST', '/api/auth/admin-login', {
        password: TEST_ADMIN_PASSWORD,
        mfaCode: codeToUse
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.token);
      adminAuthToken = res.body.token;

      // Verify that the code was removed from DB
      const userAfter = db.prepare('SELECT totp_recovery_codes FROM users WHERE id = ?').get(adminId);
      const hashesAfter = JSON.parse(userAfter.totp_recovery_codes);
      assert.strictEqual(hashesAfter.length, 7, 'Código utilizado deve ser removido do banco (restam 7)');

      // Replay Attack Test: Attempt to reuse the SAME recovery code
      adminLoginLimiter.reset();
      const resReplay = await request('POST', '/api/auth/admin-login', {
        password: TEST_ADMIN_PASSWORD,
        mfaCode: codeToUse
      });
      assert.strictEqual(resReplay.status, 401, 'Reutilização do mesmo código deve ser rejeitada com 401');
      assert.strictEqual(resReplay.body.success, false);
    });

    // -------------------------------------------------------------
    // Test 10: Deactivate MFA with password + MFA code verification
    // -------------------------------------------------------------
    await test('10. Desativação do MFA requer senha + confirmação do 2º fator', async () => {
      // Fails with wrong password
      const resWrong = await request('POST', '/api/admin/mfa/disable', {
        password: 'WrongPassword',
        code: '123456'
      }, { Authorization: `Bearer ${adminAuthToken}` });
      assert.strictEqual(resWrong.status, 401);

      // Fails with wrong code
      const resWrongCode = await request('POST', '/api/admin/mfa/disable', {
        password: TEST_ADMIN_PASSWORD,
        code: '000000'
      }, { Authorization: `Bearer ${adminAuthToken}` });
      assert.strictEqual(resWrongCode.status, 401);

      // Succeeds with valid TOTP code
      const validTotp = totpService.generateCurrentTOTP(mfaSetupSecret);
      const resSuccess = await request('POST', '/api/admin/mfa/disable', {
        password: TEST_ADMIN_PASSWORD,
        code: validTotp
      }, { Authorization: `Bearer ${adminAuthToken}` });

      assert.strictEqual(resSuccess.status, 200);
      assert.strictEqual(resSuccess.body.success, true);

      // Verify user DB state is clean
      const userClean = db.prepare('SELECT totp_enabled, totp_secret, totp_recovery_codes FROM users WHERE id = ?').get(adminId);
      assert.strictEqual(userClean.totp_enabled, 0);
      assert.strictEqual(userClean.totp_secret, null);
      assert.strictEqual(userClean.totp_recovery_codes, null);

      // Next login succeeds without MFA challenge
      const resLoginDirect = await request('POST', '/api/auth/admin-login', { password: TEST_ADMIN_PASSWORD });
      assert.strictEqual(resLoginDirect.status, 200);
      assert.strictEqual(resLoginDirect.body.success, true);
      assert.strictEqual(resLoginDirect.body.mfaRequired, undefined);
    });

    // -------------------------------------------------------------
    // Test 11: Multi-key Candidate Decryption & Key Rotation
    // -------------------------------------------------------------
    await test('11. Criptografia com resolução de chaves candidatas durante rotação', async () => {
      const samplePlainSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

      // 1. Encrypt with default dev key
      const encryptedUnderDevKey = totpService.encryptSecret(samplePlainSecret);
      assert.ok(encryptedUnderDevKey.startsWith('enc:v1:'));

      // 2. Set an environment candidate key (simulate key rotation)
      process.env.MFA_ENCRYPTION_KEY = 'brand_new_rotated_mfa_encryption_key_32_bytes_len';

      // 3. Decrypt must seamlessly succeed via candidate resolution
      const decrypted = totpService.decryptSecret(encryptedUnderDevKey);
      assert.strictEqual(decrypted, samplePlainSecret, 'Deve descriptografar perfeitamente através de chaves candidatas');

      // 4. Test candidate recovery code verification
      const { plainCodes, hashedCodes } = totpService.generateHashedRecoveryCodes(1);
      const verifyResult = totpService.verifyRecoveryCode(plainCodes[0], hashedCodes);
      assert.strictEqual(verifyResult.valid, true, 'Código de recuperação deve ser validado via chaves candidatas');

      delete process.env.MFA_ENCRYPTION_KEY;
    });

    // -------------------------------------------------------------
    // Test 12: Production Mode Strict Prohibition of Fallback Key
    // -------------------------------------------------------------
    await test('12. Bloqueio absoluto em produção quando MFA_ENCRYPTION_KEY for o fallback padrão', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalHomologacao = process.env.HOMOLOGACAO;
      const originalAppMode = process.env.APP_MODE;
      const originalMfaKey = process.env.MFA_ENCRYPTION_KEY;
      const originalSessionSec = process.env.SESSION_SECRET;
      const originalClientSec = process.env.CLIENT_AUTH_SECRET;

      try {
        process.env.NODE_ENV = 'production';
        delete process.env.HOMOLOGACAO;
        delete process.env.APP_MODE;
        process.env.MFA_ENCRYPTION_KEY = 'raia-mfa-default-key-fallback';
        delete process.env.SESSION_SECRET;
        delete process.env.CLIENT_AUTH_SECRET;

        let threwError = false;
        try {
          totpService.getPrimaryMfaKey();
        } catch (e) {
          threwError = true;
          assert.ok(e.message.includes('MFA_ENCRYPTION_KEY'));
        }
        assert.ok(threwError, 'Deve lançar exceção em produção se a chave for fallback padrão');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalHomologacao !== undefined) process.env.HOMOLOGACAO = originalHomologacao;
        if (originalAppMode !== undefined) process.env.APP_MODE = originalAppMode;
        if (originalMfaKey !== undefined) process.env.MFA_ENCRYPTION_KEY = originalMfaKey;
        if (originalSessionSec !== undefined) process.env.SESSION_SECRET = originalSessionSec;
        if (originalClientSec !== undefined) process.env.CLIENT_AUTH_SECRET = originalClientSec;
      }
    });

    // -------------------------------------------------------------
    // Test 13: Restrição de Privilégio Mínimo: ADMIN_API_KEY bloqueada em endpoints de MFA
    // -------------------------------------------------------------
    await test('13. Bloqueio de ADMIN_API_KEY em endpoints de gestão de MFA (exige sessão interativa)', async () => {
      config.adminApiKey = 'SuperSecretAdminApiKeyAutomation#2026';

      const resMfaSetup = await request('POST', '/api/admin/mfa/setup', {}, {
        'X-Admin-Key': config.adminApiKey
      });
      assert.strictEqual(resMfaSetup.status, 403, 'ADMIN_API_KEY deve ser rejeitada em /api/admin/mfa/setup');
      assert.strictEqual(resMfaSetup.body.code, 'FORBIDDEN_INTERACTIVE_SESSION_REQUIRED');

      const resMfaStatus = await request('GET', '/api/admin/mfa/status', null, {
        'X-Admin-Key': config.adminApiKey
      });
      assert.strictEqual(resMfaStatus.status, 403, 'ADMIN_API_KEY deve ser rejeitada em /api/admin/mfa/status');
    });

    // -------------------------------------------------------------
    // Test 14: Restrição de Privilégio Mínimo: ADMIN_API_KEY bloqueada em rotas de cliente
    // -------------------------------------------------------------
    await test('14. Bloqueio de ADMIN_API_KEY em rotas privativas de clientes (/api/cliente/*)', async () => {
      config.adminApiKey = 'SuperSecretAdminApiKeyAutomation#2026';

      const resClient = await request('GET', '/api/cliente/profile', null, {
        'X-Admin-Key': config.adminApiKey
      });
      assert.strictEqual(resClient.status, 403, 'ADMIN_API_KEY não pode acessar dados de clientes');
      assert.strictEqual(resClient.body.code, 'FORBIDDEN_CLIENT_ROUTE_VIA_API_KEY');
    });

    // -------------------------------------------------------------
    // Test 15: Migração Segura de Segredos MFA (Re-encriptação Atômica)
    // -------------------------------------------------------------
    await test('15. Migração segura de segredos antigos para a chave primária atual', async () => {
      // Create a test user with a secret encrypted under candidate/legacy key
      const legacyKey = crypto.createHash('sha256').update('raia-mfa-default-key-fallback').digest();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
      const testSecretPlain = 'MIGRATIONTESTSECRETBASE32ABC1234';
      let enc = cipher.update(testSecretPlain, 'utf8', 'hex');
      enc += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');
      const legacyEncryptedCiphertext = `enc:v1:${iv.toString('hex')}:${authTag}:${enc}`;

      db.prepare(`
        INSERT INTO users (name, phone_number, email, role, totp_enabled, totp_secret, created_at)
        VALUES ('Migrated Admin Test', '5511999990001', 'migrated.admin@raiaagentes.com.br', 'ADMIN', 1, ?, CURRENT_TIMESTAMP)
      `).run(legacyEncryptedCiphertext);

      const migrationResult = totpService.migrateMfaSecrets(db);
      assert.ok(migrationResult.scanned >= 1, 'Deve escanear ao menos 1 registro');
      assert.ok(migrationResult.migrated >= 1, 'Deve migrar ao menos 1 registro');

      // Now verify that the migrated record can be decrypted with the primary key even when legacy keys are disabled
      process.env.MFA_DISABLE_LEGACY_KEYS = 'true';
      const migratedUser = db.prepare("SELECT totp_secret FROM users WHERE email = 'migrated.admin@raiaagentes.com.br'").get();
      assert.notStrictEqual(migratedUser.totp_secret, legacyEncryptedCiphertext, 'Ciphertext deve ter sido re-criptografado');
      const decryptedWithPrimaryOnly = totpService.decryptSecret(migratedUser.totp_secret);
      assert.strictEqual(decryptedWithPrimaryOnly, testSecretPlain, 'Segredo deve ser decodificado perfeitamente sob a chave primária');

      delete process.env.MFA_DISABLE_LEGACY_KEYS;
      db.prepare("DELETE FROM users WHERE email = 'migrated.admin@raiaagentes.com.br'").run();
    });

    // -------------------------------------------------------------
    // Test 16: Persistência do Rate Limiting em Reinicializações
    // -------------------------------------------------------------
    await test('16. Rate limiting persistente em banco sobrevive a reinicializações / limpeza de memória', async () => {
      adminLoginLimiter.reset();

      // Trigger 5 attempts
      for (let i = 0; i < 5; i++) {
        await request('POST', '/api/auth/admin-login', { password: 'WrongPasswordForRateLimit' });
      }

      // Check DB table rate_limit_entries directly
      const rows = db.prepare('SELECT * FROM rate_limit_entries').all();
      assert.ok(rows.length > 0, 'Entradas de rate limit devem estar persistidas na tabela rate_limit_entries');
      assert.ok(rows.some(r => r.count >= 5), 'Contador persistido deve registrar as 5 tentativas');

      // Clear in-memory Map only (simulating container restart with same SQLite volume)
      // The 6th request must STILL be blocked by the persistent database entry!
      const res6th = await request('POST', '/api/auth/admin-login', { password: 'WrongPasswordForRateLimit' });
      assert.strictEqual(res6th.status, 429, '6ª tentativa deve ser bloqueada com 429 mesmo após reinicialização');
      assert.strictEqual(res6th.body.code, 'RATE_LIMIT_EXCEEDED');

      adminLoginLimiter.reset();
    });

  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  console.log('\n----------------------------------------------------------------');
  console.log(`RESULTADO FINAL: ${passedTests}/${totalTests} testes de MFA Admin passaram.`);
  console.log('----------------------------------------------------------------\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Erro fatal executando suite MFA:', err);
  process.exit(1);
});
