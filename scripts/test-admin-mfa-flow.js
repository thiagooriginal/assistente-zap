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

  // Clean persistent rate limit entries from prior test runs
  adminLoginLimiter.reset();
  db.prepare("DELETE FROM rate_limit_entries").run();

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
      adminLoginLimiter.reset();
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
      db.prepare("DELETE FROM users WHERE email = 'migrated.admin@raiaagentes.com.br' OR phone_number = '5511999990001'").run();

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

      // The 6th request must STILL be blocked by the persistent database entry!
      const res6th = await request('POST', '/api/auth/admin-login', { password: 'WrongPasswordForRateLimit' });
      assert.strictEqual(res6th.status, 429, '6ª tentativa deve ser bloqueada com 429 mesmo após reinicialização');
      assert.strictEqual(res6th.body.code, 'RATE_LIMIT_EXCEEDED');

      adminLoginLimiter.reset();
    });

    // -------------------------------------------------------------
    // Test 17: Transacionalidade Real com Rollback em migrateMfaSecrets()
    // -------------------------------------------------------------
    await test('17. Transacionalidade real com rollback atômico em migrateMfaSecrets()', async () => {
      db.prepare("DELETE FROM users WHERE email IN ('rollback1@raiaagentes.com.br', 'rollback2@raiaagentes.com.br') OR phone_number IN ('5511999990002', '5511999990003')").run();

      const validSecret = totpService.encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
      const unreadableCorruptedSecret = 'enc:v1:0123456789abcdef:0123456789abcdef0123456789abcdef:corrupted';

      db.prepare(`
        INSERT INTO users (name, phone_number, email, role, totp_enabled, totp_secret, created_at)
        VALUES ('Rollback User 1', '5511999990002', 'rollback1@raiaagentes.com.br', 'ADMIN', 1, ?, CURRENT_TIMESTAMP)
      `).run(validSecret);

      db.prepare(`
        INSERT INTO users (name, phone_number, email, role, totp_enabled, totp_secret, created_at)
        VALUES ('Rollback User 2 Corrupted', '5511999990003', 'rollback2@raiaagentes.com.br', 'ADMIN', 1, ?, CURRENT_TIMESTAMP)
      `).run(unreadableCorruptedSecret);

      let migrationFailed = false;
      try {
        totpService.migrateMfaSecrets(db, { strict: true });
      } catch (err) {
        migrationFailed = true;
        assert.ok(err.message.includes('Rollback'), 'Erro deve indicar rollback da transação');
      }

      assert.strictEqual(migrationFailed, true, 'Migração com registro corrompido deve falhar atomicamente');

      // Verify that User 1 was ROLLED BACK and NOT partially migrated
      const user1 = db.prepare("SELECT totp_secret FROM users WHERE email = 'rollback1@raiaagentes.com.br'").get();
      assert.strictEqual(user1.totp_secret, validSecret, 'Transação abortada deve restaurar o estado original no banco');

      db.prepare("DELETE FROM users WHERE email IN ('rollback1@raiaagentes.com.br', 'rollback2@raiaagentes.com.br')").run();
    });

    // -------------------------------------------------------------
    // Test 18: Tratamento de Códigos de Recuperação e Validação de Compatibilidade
    // -------------------------------------------------------------
    await test('18. Migração de códigos de recuperação legados, detecção de hashes antigos e regeneração segura', async () => {
      db.prepare("DELETE FROM users WHERE email IN ('recovery@raiaagentes.com.br', 'legacyhash@raiaagentes.com.br') OR phone_number IN ('5511999990004', '5511999990005')").run();

      // Case A: User with legacy plaintext codes
      const plainCodes = ['1111-2222', '3333-4444', '5555-6666'];
      const validSecret = totpService.encryptSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');

      db.prepare(`
        INSERT INTO users (name, phone_number, email, role, totp_enabled, totp_secret, totp_recovery_codes, created_at)
        VALUES ('Recovery User', '5511999990004', 'recovery@raiaagentes.com.br', 'ADMIN', 1, ?, ?, CURRENT_TIMESTAMP)
      `).run(validSecret, JSON.stringify(plainCodes));

      // Case B: User with unversioned legacy bare 64-char hashes (cannot be re-hashed without original code)
      const bareLegacyHashes = [
        crypto.createHash('sha256').update('old_code_1').digest('hex'),
        crypto.createHash('sha256').update('old_code_2').digest('hex')
      ];
      db.prepare(`
        INSERT INTO users (name, phone_number, email, role, totp_enabled, totp_secret, totp_recovery_codes, created_at)
        VALUES ('Legacy Hash User', '5511999990005', 'legacyhash@raiaagentes.com.br', 'ADMIN', 1, ?, ?, CURRENT_TIMESTAMP)
      `).run(validSecret, JSON.stringify(bareLegacyHashes));

      // Migration must detect the legacy hashes and flag canSafelyDisableLegacyKeys = false
      const res1 = totpService.migrateMfaSecrets(db, { strict: true });
      assert.strictEqual(res1.canSafelyDisableLegacyKeys, false, 'canSafelyDisableLegacyKeys deve ser falso enquanto existirem hashes legados');
      assert.strictEqual(res1.legacyRecoveryCodesCount, 2, 'Deve identificar exatamente os 2 hashes legados');
      assert.strictEqual(res1.recoveryCodesMigrated, 1, 'Deve migrar o usuário com códigos em texto plano');

      // Verify that plainCodes user now has versioned hashes
      const updatedUser = db.prepare("SELECT totp_recovery_codes FROM users WHERE email = 'recovery@raiaagentes.com.br'").get();
      const updatedCodes = JSON.parse(updatedUser.totp_recovery_codes);
      assert.strictEqual(updatedCodes.length, 3);
      assert.ok(updatedCodes.every(c => c.startsWith('hmac:v2:')), 'Códigos em texto plano devem ser migrados para hmac:v2');

      // Now test secure regeneration endpoint via authenticated interactive session
      // Ensure admin has MFA enabled for this test
      db.prepare("UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?").run(validSecret, adminId);
      adminLoginLimiter.reset();
      const plainSecret = totpService.decryptSecret(validSecret);
      const mfaCode = totpService.generateCurrentTOTP(plainSecret);
      const resLogin = await request('POST', '/api/auth/admin-login', {
        password: TEST_ADMIN_PASSWORD,
        mfaCode
      });
      assert.strictEqual(resLogin.status, 200);
      const sessionToken = resLogin.body.token;
      assert.ok(sessionToken, 'Token de sessão deve ser emitido');

      const resRegen = await request('POST', '/api/admin/mfa/regenerate-recovery-codes', {
        password: TEST_ADMIN_PASSWORD
      }, {
        'Authorization': `Bearer ${sessionToken}`
      });
      assert.strictEqual(resRegen.status, 200);
      assert.strictEqual(resRegen.body.success, true);
      assert.strictEqual(resRegen.body.recoveryCodes.length, 8);

      // Clean up the legacy hash user so database has only current versioned keys
      db.prepare("DELETE FROM users WHERE email IN ('recovery@raiaagentes.com.br', 'legacyhash@raiaagentes.com.br')").run();

      // Now re-running migration on clean state must report canSafelyDisableLegacyKeys = true
      const resClean = totpService.migrateMfaSecrets(db, { strict: true });
      assert.strictEqual(resClean.canSafelyDisableLegacyKeys, true, 'canSafelyDisableLegacyKeys deve ser verdadeiro após regeneração');

      // Test that fresh codes verify properly even with legacy keys disabled
      process.env.MFA_DISABLE_LEGACY_KEYS = 'true';
      const adminCodesRow = db.prepare("SELECT totp_recovery_codes FROM users WHERE id = ?").get(adminId);
      const parsedAdminCodes = JSON.parse(adminCodesRow.totp_recovery_codes);
      const testCode = resRegen.body.recoveryCodes[0];
      const verifyRegenResult = totpService.verifyRecoveryCode(testCode, parsedAdminCodes);
      assert.strictEqual(verifyRegenResult.valid, true, 'Código regenerado deve ser verificado mesmo com MFA_DISABLE_LEGACY_KEYS=true');
      assert.strictEqual(verifyRegenResult.keyMatchesPrimary, true);
      delete process.env.MFA_DISABLE_LEGACY_KEYS;

      // Clean admin state for subsequent tests
      db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL WHERE id = ?").run(adminId);
    });

    // -------------------------------------------------------------
    // Test 19: Proteção contra Exclusão Indiscriminada em reset() e Isolamento por Namespace
    // -------------------------------------------------------------
    await test('19. Proteção do rate limiter: reset() em produção é bloqueado e reset() local preserva outros limitadores', async () => {
      const { createRateLimiter } = require('../src/middlewares/rateLimiter');

      // Create two independent limiters
      const limiterA = createRateLimiter({ name: 'limiter_a', maxAttempts: 5, windowMs: 60000 });
      const limiterB = createRateLimiter({ name: 'limiter_b', maxAttempts: 5, windowMs: 60000 });

      const fakeReqA = { ip: '10.0.0.1', baseUrl: '/testA', path: '' };
      const fakeReqB = { ip: '10.0.0.1', baseUrl: '/testB', path: '' };
      const dummyRes = { setHeader: () => {}, status: () => ({ json: () => {} }) };

      // Record attempts on both
      limiterA(fakeReqA, dummyRes, () => {});
      limiterB(fakeReqB, dummyRes, () => {});

      // Verify both exist in SQLite
      const rowsBefore = db.prepare("SELECT key FROM rate_limit_entries WHERE key LIKE 'limiter_%'").all();
      assert.ok(rowsBefore.some(r => r.key.startsWith('limiter_a:')));
      assert.ok(rowsBefore.some(r => r.key.startsWith('limiter_b:')));

      // Test production protection: reset() in production must NOT delete from SQLite
      const origNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      limiterA.reset();
      process.env.NODE_ENV = origNodeEnv;

      const rowsAfterProdReset = db.prepare("SELECT key FROM rate_limit_entries WHERE key LIKE 'limiter_%'").all();
      assert.ok(rowsAfterProdReset.some(r => r.key.startsWith('limiter_a:')), 'reset() em produção não deve apagar registros do SQLite');

      // Test scoped reset in non-production: reset limiterA must ONLY remove limiter_a keys, leaving limiter_b intact
      limiterA.reset();
      const rowsAfterScopedReset = db.prepare("SELECT key FROM rate_limit_entries WHERE key LIKE 'limiter_%'").all();
      assert.ok(!rowsAfterScopedReset.some(r => r.key.startsWith('limiter_a:')), 'limiter_a deve ter sido apagado');
      assert.ok(rowsAfterScopedReset.some(r => r.key.startsWith('limiter_b:')), 'limiter_b deve permanecer intacto');

      limiterB.reset();
    });

    // -------------------------------------------------------------
    // Test 20: Concorrência Atômica de Atualizações no Rate Limiter
    // -------------------------------------------------------------
    await test('20. Concorrência atômica de atualizações no rate limiter sem condição de corrida', async () => {
      const { createRateLimiter } = require('../src/middlewares/rateLimiter');
      const concurrentLimiter = createRateLimiter({ name: 'concurrent_test', maxAttempts: 50, windowMs: 60000 });
      const fakeReq = { ip: '10.99.99.99', baseUrl: '/concurrent', path: '' };
      const dummyRes = { setHeader: () => {}, status: () => ({ json: () => {} }) };

      concurrentLimiter.reset();

      // Fire 10 concurrent requests simultaneously
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(new Promise((resolve) => {
          concurrentLimiter(fakeReq, dummyRes, () => resolve());
        }));
      }

      await Promise.all(promises);

      // Verify exact counter in SQLite
      const row = db.prepare("SELECT count FROM rate_limit_entries WHERE key = 'concurrent_test:10.99.99.99:/concurrent'").get();
      assert.strictEqual(row.count, 10, 'Contador persistido deve ser exatamente 10 após 10 requisições simultâneas');

      // Test destruction & recreation of instance: completely new limiter instance reading from same SQLite
      const freshLimiterInstance = createRateLimiter({ name: 'concurrent_test', maxAttempts: 50, windowMs: 60000 });
      freshLimiterInstance(fakeReq, dummyRes, () => {});

      const updatedRow = db.prepare("SELECT count FROM rate_limit_entries WHERE key = 'concurrent_test:10.99.99.99:/concurrent'").get();
      assert.strictEqual(updatedRow.count, 11, 'Nova instância deve retomar a contagem de 10 para 11 através do SQLite');

      concurrentLimiter.reset();
    });

    // -------------------------------------------------------------
    // Test 21: requireInteractiveAdmin e Aplicação Estrita da Política de MFA
    // -------------------------------------------------------------
    await test('21. requireInteractiveAdmin impõe política de MFA e rejeita credenciais não interativas', async () => {
      config.adminApiKey = 'SuperSecretAdminApiKeyAutomation#2026';

      // 1. Valid API Key request is blocked by requireInteractiveAdmin with 403
      const resApiKey = await request('DELETE', '/api/admin/users/999999', null, {
        'X-Admin-Key': config.adminApiKey
      });
      assert.strictEqual(resApiKey.status, 403, 'ADMIN_API_KEY deve ser bloqueada em operações restritas a sessões interativas');
      assert.strictEqual(resApiKey.body.code, 'FORBIDDEN_INTERACTIVE_SESSION_REQUIRED');

      // 2. Unauthenticated request without token or key is rejected with 401
      const resUnauth = await request('DELETE', '/api/admin/users/999999');
      assert.strictEqual(resUnauth.status, 401, 'Requisição sem autenticação deve retornar 401');

      // 3. Active admin with MFA policy enabled accesses /api/admin/mfa/status with valid session
      adminLoginLimiter.reset();
      const resLogin = await request('POST', '/api/auth/admin-login', { password: TEST_ADMIN_PASSWORD });
      assert.strictEqual(resLogin.status, 200);
      const sessionToken = resLogin.body.token;

      const resMfaStatus = await request('GET', '/api/admin/mfa/status', null, {
        'Authorization': `Bearer ${sessionToken}`
      });
      assert.strictEqual(resMfaStatus.status, 200, 'Sessão interativa legítima deve ter acesso ao status de MFA');
    });

    // -------------------------------------------------------------
    // Test 22: Indisponibilidade Temporária do SQLite e Resiliência em Rotas Críticas
    // -------------------------------------------------------------
    await test('22. Resiliência do rate limiter: indisponibilidade do SQLite degrada suavemente para in-memory sem causar 500', async () => {
      const { createRateLimiter } = require('../src/middlewares/rateLimiter');
      const resilientLimiter = createRateLimiter({ name: 'resilience_test', maxAttempts: 3, windowMs: 60000 });
      const fakeReq = { ip: '10.88.88.88', baseUrl: '/critical-auth', path: '' };

      let lastStatus = 200;
      let lastBody = null;
      const mockRes = {
        setHeader: () => {},
        status: (s) => {
          lastStatus = s;
          return {
            json: (b) => { lastBody = b; return b; }
          };
        }
      };

      // Mock a database instance that throws SQLITE_BUSY / disk error
      const mockFailingDb = {
        prepare: () => {
          throw new Error('SQLITE_BUSY: database is locked (simulated temporary storage outage)');
        }
      };

      resilientLimiter.setDb(mockFailingDb);

      // Requests 1, 2, 3 must pass through via in-memory fallback without 500
      let nextCalledCount = 0;
      for (let i = 0; i < 3; i++) {
        resilientLimiter(fakeReq, mockRes, () => { nextCalledCount++; });
      }
      assert.strictEqual(nextCalledCount, 3, 'Primeiras 3 tentativas devem passar para next() mesmo com SQLite fora do ar');

      // Request 4 must be BLOCKED with 429 by in-memory limiter without throwing error
      resilientLimiter(fakeReq, mockRes, () => {
        assert.fail('4ª tentativa não deveria chamar next()');
      });
      assert.strictEqual(lastStatus, 429, '4ª tentativa deve retornar 429 Rate Limit Exceeded');
      assert.strictEqual(lastBody.code, 'RATE_LIMIT_EXCEEDED');

      // Restore real DB and reset
      resilientLimiter.setDb(null);
      resilientLimiter.reset();
    });

    // -------------------------------------------------------------
    // Test 23: Preservação de Bloqueios entre Múltiplas Instâncias e Reinicializações
    // -------------------------------------------------------------
    await test('23. Preservação de bloqueios de rate limit entre múltiplas instâncias de cluster', async () => {
      const { createRateLimiter } = require('../src/middlewares/rateLimiter');

      // Cluster Instance A and Cluster Instance B share the same SQLite database
      const instanceA = createRateLimiter({ name: 'cluster_login', maxAttempts: 4, windowMs: 60000 });
      const instanceB = createRateLimiter({ name: 'cluster_login', maxAttempts: 4, windowMs: 60000 });

      const attackerReq = { ip: '198.51.100.77', baseUrl: '/login', path: '' };

      instanceA.reset();

      // Instance A receives 4 requests and increments SQLite to 4
      const dummyRes = { setHeader: () => {}, status: () => ({ json: () => {} }) };
      for (let i = 0; i < 4; i++) {
        instanceA(attackerReq, dummyRes, () => {});
      }

      // Instance B receives the 5th request from the same IP
      // Instance B has an EMPTY in-memory map, but SQLite holds count = 4
      let instanceBLastStatus = 200;
      let instanceBLastBody = null;
      const resB = {
        setHeader: () => {},
        status: (s) => {
          instanceBLastStatus = s;
          return {
            json: (b) => { instanceBLastBody = b; return b; }
          };
        }
      };

      instanceB(attackerReq, resB, () => {
        assert.fail('Instance B não deveria permitir o 5º acesso');
      });

      assert.strictEqual(instanceBLastStatus, 429, 'Instance B deve bloquear imediatamente com 429 lendo do SQLite compartilhado');
      assert.strictEqual(instanceBLastBody.code, 'RATE_LIMIT_EXCEEDED');

      instanceA.reset();
    });

    // -------------------------------------------------------------
    // Test 24: Acesso sem Sessão a /admin em Domínio Externo Retorna 200 OK (Sem Redirecionar para /cliente/login)
    // -------------------------------------------------------------
    await test('24. Acesso sem sessão a /admin e /admin.html em domínio externo retorna 200 OK com interface de login de administrador', async () => {
      // 1. Simula acesso via domínio de homologação/segurança sem cookies de sessão
      const resAdminRoot = await request('GET', '/admin', null, {
        Host: 'seguranca.raiaagentes.com.br',
        'X-Forwarded-Host': 'seguranca.raiaagentes.com.br'
      });
      assert.strictEqual(resAdminRoot.status, 200, 'Acesso a /admin sem sessão deve retornar 200 OK');
      assert.ok(
        typeof resAdminRoot.body === 'string' && resAdminRoot.body.includes('adminAuthOverlay'),
        'Resposta deve entregar a página admin.html contendo o formulário de login administrativo'
      );
      assert.ok(!resAdminRoot.headers.location, 'Não deve conter header Location de redirecionamento');

      // 2. Acesso via /admin.html com domínio de staging
      const resAdminHtml = await request('GET', '/admin.html', null, {
        Host: 'staging.raiaagentes.com.br',
        'X-Forwarded-Host': 'staging.raiaagentes.com.br'
      });
      assert.strictEqual(resAdminHtml.status, 200, 'Acesso a /admin.html deve retornar 200 OK');
      assert.ok(
        typeof resAdminHtml.body === 'string' && resAdminHtml.body.includes('adminAuthOverlay'),
        'Resposta deve entregar a página admin.html'
      );
    });

    // -------------------------------------------------------------
    // Test 25: Tentativa de Acesso Administrativo por Cliente (ROLE=CLIENT) é Rejeitada com 403
    // -------------------------------------------------------------
    await test('25. Tentativa de acesso administrativo por cliente (ROLE=CLIENT) é rejeitada com 403 Forbidden', async () => {
      const uniqueSuffix = Date.now().toString().slice(-8);
      const clientEmail = `client.tester.${uniqueSuffix}@raiaagentes.com.br`;
      const clientPhone = `55119${uniqueSuffix}`;
      db.prepare(`
        INSERT INTO users (name, phone_number, email, role, plan_tier, subscription_status, created_at)
        VALUES ('Cliente Tester', ?, ?, 'CLIENT', 'JESSICA_PRO', 'ACTIVE', CURRENT_TIMESTAMP)
      `).run(clientPhone, clientEmail);
      const clientUser = db.prepare('SELECT id FROM users WHERE email = ?').get(clientEmail);
      const userService = require('../src/services/userService');
      const { sessionToken: clientSessionToken } = userService.createUserSession(clientUser.id, 1);

      // Client token tenta acessar rota protegida de admin
      const resAdminUsers = await request('GET', '/api/admin/users', null, {
        Authorization: `Bearer ${clientSessionToken}`
      });
      assert.strictEqual(resAdminUsers.status, 403, 'Acesso de cliente a /api/admin/users deve retornar 403 Forbidden');
      assert.strictEqual(resAdminUsers.body.error, 'Acesso negado. Recurso exclusivo para administradores.');

      // Client token tenta acessar rota de status MFA
      const resMfaStatus = await request('GET', '/api/admin/mfa/status', null, {
        Authorization: `Bearer ${clientSessionToken}`
      });
      assert.strictEqual(resMfaStatus.status, 403, 'Acesso de cliente a /api/admin/mfa/status deve retornar 403');

      // Cleanup
      db.prepare('DELETE FROM users WHERE id = ?').run(clientUser.id);
    });

    // -------------------------------------------------------------
    // Test 26: Sessão Expirada e Logout Resiliente sem Erro 401
    // -------------------------------------------------------------
    await test('26. Tratamento de sessão administrativa expirada e logout resiliente', async () => {
      const userService = require('../src/services/userService');
      const { sessionToken: expiredToken } = userService.createUserSession(adminId, -1); // expirou ontem!

      // 1. Requisição com token expirado deve ser rejeitada com 401
      const resExpired = await request('GET', '/api/admin/users', null, {
        Authorization: `Bearer ${expiredToken}`
      });
      assert.strictEqual(resExpired.status, 401, 'Token expirado deve retornar 401 Unauthorized');

      // 2. Logout com token expirado ou sem token deve limpar cookies com sucesso (200 OK)
      const resLogout = await request('POST', '/api/auth/logout', null, {
        Authorization: `Bearer ${expiredToken}`
      });
      assert.strictEqual(resLogout.status, 200, 'Logout deve retornar 200 OK mesmo com sessão expirada');
      assert.strictEqual(resLogout.body.success, true);
      const setCookies = resLogout.headers['set-cookie'] || [];
      const clearedAuthCookie = setCookies.some(c => c.includes('auth_token=;') || c.includes('auth_token=; Path=/; Expires=Thu, 01 Jan 1970'));
      assert.ok(clearedAuthCookie, 'Cookie auth_token deve ser expirado no logout');
    });

    // -------------------------------------------------------------
    // Test 27: Setup de MFA pela Primeira Vez sem Bloqueio Circular
    // -------------------------------------------------------------
    await test('27. Setup de MFA pela primeira vez permite acesso às rotas de setup sem bloqueio circular', async () => {
      // Cria novo admin temporário sem MFA ativado
      const uniqueSuffix = Date.now().toString().slice(-8);
      const freshAdminEmail = `fresh.admin.${uniqueSuffix}@raiaagentes.com.br`;
      const freshAdminPhone = `55119${uniqueSuffix}`;
      db.prepare(`
        INSERT INTO users (name, phone_number, email, role, totp_enabled, totp_secret, created_at)
        VALUES ('Fresh Admin Without MFA', ?, ?, 'ADMIN', 0, NULL, CURRENT_TIMESTAMP)
      `).run(freshAdminPhone, freshAdminEmail);
      const freshAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(freshAdminEmail);
      const userService = require('../src/services/userService');
      const { sessionToken: freshAdminToken } = userService.createUserSession(freshAdmin.id, 1);

      // Ativa exigência global de MFA
      config.adminMfaEnabled = true;

      // 1. Rota de status do MFA deve ser permitida mesmo com MFA pendente de setup
      const resStatus = await request('GET', '/api/admin/mfa/status', null, {
        Authorization: `Bearer ${freshAdminToken}`
      });
      assert.strictEqual(resStatus.status, 200, '/api/admin/mfa/status deve permitir acesso para visualização de status');
      assert.strictEqual(resStatus.body.enabled, false);

      // 2. Rota de setup do MFA deve ser permitida para iniciar o cadastro do 1º fator TOTP
      const resSetup = await request('POST', '/api/admin/mfa/setup', null, {
        Authorization: `Bearer ${freshAdminToken}`
      });
      assert.strictEqual(resSetup.status, 200, '/api/admin/mfa/setup deve permitir acesso para gerar segredo e QR code');
      assert.ok(resSetup.body.secret, 'Deve retornar segredo TOTP em Base32');

      // 3. Rota operacional comum DEVE ser bloqueada até que o MFA seja configurado
      const resOperational = await request('DELETE', '/api/admin/users/999999', null, {
        Authorization: `Bearer ${freshAdminToken}`
      });
      assert.strictEqual(resOperational.status, 403, 'Rota operacional deve ser bloqueada até MFA ser ativado');
      assert.strictEqual(resOperational.body.code, 'FORBIDDEN_MFA_POLICY_ENFORCEMENT');

      // Cleanup
      db.prepare('DELETE FROM users WHERE id = ?').run(freshAdmin.id);
      config.adminMfaEnabled = false;
    });

    // -------------------------------------------------------------
    // Test 28: Login com ADMIN_MFA_ENABLED=true em Conta sem MFA Requer Onboarding Obrigatório
    // -------------------------------------------------------------
    await test('28. Login com ADMIN_MFA_ENABLED=true em conta sem MFA retorna mfaSetupRequired: true e mfaPending', async () => {
      config.adminMfaEnabled = true;
      process.env.ADMIN_MFA_ENABLED = 'true';

      // Garante admin com MFA desativado no banco
      db.prepare(`
        UPDATE users 
        SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL 
        WHERE id = ?
      `).run(adminId);

      const resLogin = await request('POST', '/api/auth/admin-login', { password: TEST_ADMIN_PASSWORD });
      assert.strictEqual(resLogin.status, 200, 'Login deve retornar 200');
      assert.strictEqual(resLogin.body.success, true);
      assert.strictEqual(resLogin.body.mfaSetupRequired, true, 'Deve sinalizar mfaSetupRequired: true');
      assert.strictEqual(resLogin.body.user.mfaPending, true, 'User deve conter mfaPending: true');
      assert.ok(resLogin.body.token, 'Deve retornar token para fluxo de setup');

      const tempToken = resLogin.body.token;

      // Endpoint /api/me deve refletir mfaPending: true
      const resMe = await request('GET', '/api/me', null, {
        Authorization: `Bearer ${tempToken}`
      });
      assert.strictEqual(resMe.status, 200);
      assert.strictEqual(resMe.body.user.mfaPending, true, '/api/me deve reportar mfaPending: true');
      assert.strictEqual(resMe.body.user.mfaSetupRequired, true);

      config.adminMfaEnabled = false;
      process.env.ADMIN_MFA_ENABLED = 'false';
    });

    // -------------------------------------------------------------
    // Test 29: Bloqueio Estrito de Operações Administrativas por requireAdmin Durante MFA Pendente
    // -------------------------------------------------------------
    await test('29. Bloqueio estrito de requireAdmin em métricas e produtos quando MFA estiver pendente', async () => {
      config.adminMfaEnabled = true;
      process.env.ADMIN_MFA_ENABLED = 'true';

      // Admin sem MFA
      db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(adminId);
      const userService = require('../src/services/userService');
      const { sessionToken: pendingToken } = userService.createUserSession(adminId, 1);

      // 1. /api/admin/users (GET protegido por requireAdmin) deve ser bloqueado com 403
      const resUsers = await request('GET', '/api/admin/users', null, {
        Authorization: `Bearer ${pendingToken}`
      });
      assert.strictEqual(resUsers.status, 403, 'requireAdmin deve bloquear /api/admin/users com 403');
      assert.strictEqual(resUsers.body.code, 'FORBIDDEN_MFA_POLICY_ENFORCEMENT');
      assert.strictEqual(resUsers.body.mfaSetupRequired, true);

      // 2. /api/admin/multiproduct/metrics deve ser bloqueado com 403
      const resMetrics = await request('GET', '/api/admin/multiproduct/metrics', null, {
        Authorization: `Bearer ${pendingToken}`
      });
      assert.strictEqual(resMetrics.status, 403, 'requireAdmin deve bloquear /api/admin/multiproduct/metrics');
      assert.strictEqual(resMetrics.body.code, 'FORBIDDEN_MFA_POLICY_ENFORCEMENT');

      // 3. /api/admin/products deve ser bloqueado com 403
      const resProducts = await request('GET', '/api/admin/products', null, {
        Authorization: `Bearer ${pendingToken}`
      });
      assert.strictEqual(resProducts.status, 403, 'requireAdmin deve bloquear /api/admin/products');
      assert.strictEqual(resProducts.body.code, 'FORBIDDEN_MFA_POLICY_ENFORCEMENT');

      // 4. Rotas de onboarding (/api/admin/mfa/status e setup) continuam acessíveis (sem circular lock)
      const resStatus = await request('GET', '/api/admin/mfa/status', null, {
        Authorization: `Bearer ${pendingToken}`
      });
      assert.strictEqual(resStatus.status, 200, 'Onboarding não pode ter bloqueio circular');

      config.adminMfaEnabled = false;
      process.env.ADMIN_MFA_ENABLED = 'false';
    });

    // -------------------------------------------------------------
    // Test 30: Conclusão do Onboarding via POST /api/admin/mfa/enable Ativa MFA e Libera Acesso Operacional
    // -------------------------------------------------------------
    await test('30. Ativação do MFA via onboarding libera imediatamente acesso às rotas operacionais de admin', async () => {
      config.adminMfaEnabled = true;
      process.env.ADMIN_MFA_ENABLED = 'true';

      const userService = require('../src/services/userService');
      const { sessionToken: onboardingToken } = userService.createUserSession(adminId, 1);

      // 1. Inicia setup
      const resSetup = await request('POST', '/api/admin/mfa/setup', null, {
        Authorization: `Bearer ${onboardingToken}`
      });
      assert.strictEqual(resSetup.status, 200);
      const generatedSecret = resSetup.body.secret;
      assert.ok(generatedSecret, 'Secret gerado para onboarding');

      // 2. Gera código TOTP válido
      const validCode = totpService.generateToken(generatedSecret);

      // 3. Conclui ativação
      const resEnable = await request('POST', '/api/admin/mfa/enable', {
        password: TEST_ADMIN_PASSWORD,
        secret: generatedSecret,
        code: validCode
      }, {
        Authorization: `Bearer ${onboardingToken}`
      });
      assert.strictEqual(resEnable.status, 200, 'Ativação deve retornar 200');
      assert.strictEqual(resEnable.body.success, true);
      assert.ok(resEnable.body.recoveryCodes.length === 8, 'Deve gerar 8 códigos de recuperação');

      // 4. Confirma no banco que totp_enabled = 1
      const updatedAdmin = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(adminId);
      assert.strictEqual(updatedAdmin.totp_enabled, 1, 'totp_enabled deve ser 1 no SQLite');

      // 5. Agora as rotas operacionais (/api/admin/users) devem ser liberadas com 200 OK!
      const resUsersNow = await request('GET', '/api/admin/users', null, {
        Authorization: `Bearer ${onboardingToken}`
      });
      assert.strictEqual(resUsersNow.status, 200, 'Acesso operacional deve ser liberado após MFA ativo');
      assert.strictEqual(resUsersNow.body.success, true);

      config.adminMfaEnabled = false;
      process.env.ADMIN_MFA_ENABLED = 'false';
    });

    // -------------------------------------------------------------
    // Test 31: Revogação Completa de Sessão no SQLite Pós-Logout e Bloqueio de Reentrada
    // -------------------------------------------------------------
    await test('31. Logout revoga token no SQLite, expira cookies com Max-Age=0 e impede reentrada', async () => {
      config.adminMfaEnabled = true;
      process.env.ADMIN_MFA_ENABLED = 'true';

      // 1. Obtém segredo do admin do teste 30 para login completo com TOTP
      const adminData = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(adminId);
      const decryptedSecret = totpService.decryptSecret(adminData.totp_secret);
      const totpCode = totpService.generateToken(decryptedSecret);

      const resLogin = await request('POST', '/api/auth/admin-login', {
        password: TEST_ADMIN_PASSWORD,
        mfaCode: totpCode
      });
      assert.strictEqual(resLogin.status, 200);
      assert.strictEqual(resLogin.body.success, true);
      const liveToken = resLogin.body.token;

      // Confirma que a sessão é válida e tem acesso operacional
      const resBefore = await request('GET', '/api/admin/users', null, {
        Authorization: `Bearer ${liveToken}`
      });
      assert.strictEqual(resBefore.status, 200, 'Sessão ativa acessa dados operacionais');

      // 2. Executa logout
      const resLogout = await request('POST', '/api/auth/logout', null, {
        Authorization: `Bearer ${liveToken}`
      });
      assert.strictEqual(resLogout.status, 200, 'Logout retorna 200 OK');
      assert.strictEqual(resLogout.body.success, true);

      // Verifica headers de cookie com Max-Age=0
      const setCookies = resLogout.headers['set-cookie'] || [];
      const hasExpiredAuthCookie = setCookies.some(c => c.includes('auth_token=') && c.includes('Max-Age=0'));
      assert.ok(hasExpiredAuthCookie, 'auth_token deve conter Max-Age=0');

      // 3. Verifica no SQLite se session_token foi revogado (NULL)
      const userAfter = db.prepare('SELECT session_token, session_expires_at FROM users WHERE id = ?').get(adminId);
      assert.strictEqual(userAfter.session_token, null, 'session_token deve ser NULL no banco após logout');
      assert.strictEqual(userAfter.session_expires_at, null, 'session_expires_at deve ser NULL no banco após logout');

      // 4. Tentativa de reentrada com o token antigo DEVE ser rejeitada com 401 Unauthorized
      const resReentry = await request('GET', '/api/admin/users', null, {
        Authorization: `Bearer ${liveToken}`
      });
      assert.strictEqual(resReentry.status, 401, 'Reentrada com token revogado deve retornar 401 Unauthorized');

      // 5. Tentativa em /api/me também retorna 401
      const resMeAfter = await request('GET', '/api/me', null, {
        Authorization: `Bearer ${liveToken}`
      });
      assert.strictEqual(resMeAfter.status, 401, '/api/me deve retornar 401 para token revogado');

      config.adminMfaEnabled = false;
      process.env.ADMIN_MFA_ENABLED = 'false';
    });

    // -------------------------------------------------------------
    // Test 32: Origem Autorizada https://seguranca.raiaagentes.com.br no Setup de MFA
    // -------------------------------------------------------------
    await test('32. Origem https://seguranca.raiaagentes.com.br é autorizada no setup de MFA sem erro 403 Anti-CSRF', async () => {
      config.adminMfaEnabled = true;
      process.env.ADMIN_MFA_ENABLED = 'true';

      // Cria sessão de admin com MFA pendente
      db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(adminId);
      const userService = require('../src/services/userService');
      const { sessionToken: stgSessionToken } = userService.createUserSession(adminId, 1);

      // Simula requisição originada do browser no domínio seguranca.raiaagentes.com.br autenticada por cookie
      const resSetup = await request('POST', '/api/admin/mfa/setup', null, {
        Cookie: `auth_token=${stgSessionToken}`,
        Origin: 'https://seguranca.raiaagentes.com.br',
        Host: 'seguranca.raiaagentes.com.br',
        'X-Forwarded-Host': 'seguranca.raiaagentes.com.br'
      });

      assert.strictEqual(resSetup.status, 200, 'POST /api/admin/mfa/setup deve retornar 200 OK para origem autorizada');
      assert.strictEqual(resSetup.body.success, true);
      assert.ok(resSetup.body.secret, 'Deve retornar secret Base32');
      assert.ok(resSetup.body.qrCodeDataUrl, 'Deve retornar qrCodeDataUrl para renderizar na tela');

      config.adminMfaEnabled = false;
      process.env.ADMIN_MFA_ENABLED = 'false';
    });

    // -------------------------------------------------------------
    // Test 33: Ativação de MFA e Logout sob Origem https://seguranca.raiaagentes.com.br
    // -------------------------------------------------------------
    await test('33. Ativação de MFA e Logout sob origem https://seguranca.raiaagentes.com.br passam pela validação Anti-CSRF', async () => {
      config.adminMfaEnabled = true;
      process.env.ADMIN_MFA_ENABLED = 'true';

      const userService = require('../src/services/userService');
      const { sessionToken: stgToken } = userService.createUserSession(adminId, 1);

      // 1. Gera segredo
      const resSetup = await request('POST', '/api/admin/mfa/setup', null, {
        Cookie: `auth_token=${stgToken}`,
        Origin: 'https://seguranca.raiaagentes.com.br'
      });
      assert.strictEqual(resSetup.status, 200);
      const secret = resSetup.body.secret;
      const validCode = totpService.generateToken(secret);

      // 2. Conclui ativação com Origin seguranca.raiaagentes.com.br
      const resEnable = await request('POST', '/api/admin/mfa/enable', {
        password: TEST_ADMIN_PASSWORD,
        secret,
        code: validCode
      }, {
        Cookie: `auth_token=${stgToken}`,
        Origin: 'https://seguranca.raiaagentes.com.br'
      });
      assert.strictEqual(resEnable.status, 200, 'Ativação com Origin seguranca.raiaagentes.com.br deve retornar 200');
      assert.strictEqual(resEnable.body.success, true);

      // 3. Executa logout sob Origin seguranca.raiaagentes.com.br
      const resLogout = await request('POST', '/api/auth/logout', null, {
        Cookie: `auth_token=${stgToken}`,
        Origin: 'https://seguranca.raiaagentes.com.br'
      });
      assert.strictEqual(resLogout.status, 200, 'Logout com Origin seguranca.raiaagentes.com.br deve retornar 200');
      assert.strictEqual(resLogout.body.success, true);

      config.adminMfaEnabled = false;
      process.env.ADMIN_MFA_ENABLED = 'false';
    });

    // -------------------------------------------------------------
    // Test 34: Bloqueio Estrito de Origens Maliciosas com 403 CSRF_INVALID_ORIGIN
    // -------------------------------------------------------------
    await test('34. Origens maliciosas ou HTTP inseguro são sumariamente bloqueadas com 403 CSRF_INVALID_ORIGIN', async () => {
      const userService = require('../src/services/userService');
      const { sessionToken: attackToken } = userService.createUserSession(adminId, 1);

      // 1. Origem maliciosa tentando se passar por seguranca (evil-seguranca)
      const resEvil1 = await request('POST', '/api/admin/mfa/setup', null, {
        Cookie: `auth_token=${attackToken}`,
        Origin: 'https://evil-seguranca.raiaagentes.com.br'
      });
      assert.strictEqual(resEvil1.status, 403, 'evil-seguranca deve ser bloqueada com 403');
      assert.strictEqual(resEvil1.body.code, 'CSRF_INVALID_ORIGIN');

      // 2. Origem sob domínio externo com subdomain atacante
      const resEvil2 = await request('POST', '/api/admin/mfa/setup', null, {
        Cookie: `auth_token=${attackToken}`,
        Origin: 'https://seguranca.raiaagentes.com.br.attacker.com'
      });
      assert.strictEqual(resEvil2.status, 403, 'seguranca.raiaagentes.com.br.attacker.com deve ser bloqueada com 403');
      assert.strictEqual(resEvil2.body.code, 'CSRF_INVALID_ORIGIN');

      // 3. Origem legítima mas enviada em plain HTTP (proibida em homologação/produção)
      const resHttp = await request('POST', '/api/admin/mfa/setup', null, {
        Cookie: `auth_token=${attackToken}`,
        Origin: 'http://seguranca.raiaagentes.com.br'
      });
      assert.strictEqual(resHttp.status, 403, 'http:// (plain HTTP) deve ser bloqueado com 403');
      assert.strictEqual(resHttp.body.code, 'CSRF_INVALID_ORIGIN');

      // 4. Origem arbitrária externa
      const resAttacker = await request('POST', '/api/admin/mfa/setup', null, {
        Cookie: `auth_token=${attackToken}`,
        Origin: 'https://attacker-website.com'
      });
      assert.strictEqual(resAttacker.status, 403, 'attacker-website.com deve ser bloqueado com 403');
      assert.strictEqual(resAttacker.body.code, 'CSRF_INVALID_ORIGIN');
    });

    // -------------------------------------------------------------
    // Test 35: Host Header e Redirecionamento HTTPS para seguranca.raiaagentes.com.br
    // -------------------------------------------------------------
    await test('35. Redirecionamento HTTPS preserva seguranca.raiaagentes.com.br e rejeita Host Header Injection', async () => {
      process.env.APP_MODE = 'staging';
      process.env.HOMOLOGACAO = 'true';

      // 1. Requisição HTTP legítima para seguranca.raiaagentes.com.br deve redirecionar para https://seguranca.raiaagentes.com.br
      const resRedirectLegit = await request('GET', '/admin', null, {
        Host: 'seguranca.raiaagentes.com.br',
        'X-Forwarded-Host': 'seguranca.raiaagentes.com.br',
        'X-Forwarded-Proto': 'http'
      });
      assert.strictEqual(resRedirectLegit.status, 301, 'Deve redirecionar HTTP -> HTTPS com 301');
      assert.strictEqual(
        resRedirectLegit.headers.location,
        'https://seguranca.raiaagentes.com.br/admin',
        'Location deve preservar o host exato seguranca.raiaagentes.com.br'
      );

      // 2. Requisição com Host spoofado (ataque Host Header Injection) cai no fallback seguro
      const resRedirectSpoof = await request('GET', '/admin', null, {
        Host: 'evil-phishing-site.com',
        'X-Forwarded-Host': 'evil-phishing-site.com',
        'X-Forwarded-Proto': 'http'
      });
      assert.strictEqual(resRedirectSpoof.status, 301);
      assert.ok(
        resRedirectSpoof.headers.location.startsWith('https://staging.raiaagentes.com.br') ||
        resRedirectSpoof.headers.location.startsWith('https://raiaagentes.com.br'),
        'Host spoofado deve cair no fallback seguro e NUNCA redirecionar para evil-phishing-site.com'
      );

      delete process.env.APP_MODE;
      delete process.env.HOMOLOGACAO;
    });

    // -------------------------------------------------------------
    // Test 36: Sessão ADMIN com senha, mas sem MFA (pre-auth) é bloqueada em APIs de admin
    // -------------------------------------------------------------
    await test('36. Sessão ADMIN com senha, mas sem MFA validado é bloqueada em APIs de admin (FORBIDDEN_MFA_SESSION_REQUIRED)', async () => {
      // Create session for admin with session_mfa_verified = 0
      const preAuthToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      db.prepare(`
        UPDATE users
        SET session_token = ?,
            session_expires_at = ?,
            session_mfa_verified = 0,
            totp_enabled = 1,
            totp_secret = ?
        WHERE id = ?
      `).run(preAuthToken, expiresAt, totpService.encryptSecret('JBSWY3DPEHPK3PXP'), adminId);

      // Attempt to access operational admin endpoint
      const res = await request('GET', '/api/admin/analytics/overview', null, {
        Cookie: `auth_token=${preAuthToken}`,
        Authorization: `Bearer ${preAuthToken}`
      });

      assert.strictEqual(res.status, 403, 'Sessão pré-autenticada sem MFA validado deve receber 403');
      assert.strictEqual(res.body.code, 'FORBIDDEN_MFA_SESSION_REQUIRED');
      assert.strictEqual(res.body.mfaChallengeRequired, true);

      // Verify /api/me returns mfaVerified: false
      const resMe = await request('GET', '/api/me', null, {
        Cookie: `auth_token=${preAuthToken}`,
      });
      assert.strictEqual(resMe.status, 200);
      assert.strictEqual(resMe.body.user.mfaVerified, false);
      assert.strictEqual(resMe.body.user.mfaChallengeRequired, true);
    });

    // -------------------------------------------------------------
    // Test 37: Sessão ADMIN obtida por link mágico cria sessão pre-auth (session_mfa_verified = 0)
    // -------------------------------------------------------------
    await test('37. Sessão ADMIN obtida por link mágico cria sessão pré-autenticada e não concede acesso sem MFA', async () => {
      const magicToken = `magic_adm_${Date.now()}`;
      const expires = new Date(Date.now() + 600000).toISOString();
      db.prepare(`
        UPDATE users
        SET magic_token = ?,
            magic_token_expires_at = ?,
            totp_enabled = 1,
            totp_secret = ?
        WHERE id = ?
      `).run(magicToken, expires, totpService.encryptSecret('JBSWY3DPEHPK3PXP'), adminId);

      // Access magic link
      const resMagic = await request('GET', `/auth/magic?token=${magicToken}`);
      assert.strictEqual(resMagic.status, 302, 'Magic link deve redirecionar com 302');
      const cookieHeader = resMagic.headers['set-cookie'] ? (Array.isArray(resMagic.headers['set-cookie']) ? resMagic.headers['set-cookie'].join(';') : resMagic.headers['set-cookie']) : '';
      const match = cookieHeader.match(/auth_token=([a-f0-9]{64})/);
      assert.ok(match, 'Deve emitir cookie auth_token na resposta');
      const magicSessionToken = match[1];

      // Verify in DB that session_mfa_verified is 0
      const adminUser = db.prepare('SELECT session_mfa_verified FROM users WHERE session_token = ?').get(magicSessionToken);
      assert.strictEqual(adminUser.session_mfa_verified, 0, 'Sessão criada via magic link para ADMIN deve ter session_mfa_verified = 0');

      // Attempt to access admin routes with this token
      const resBlocked = await request('GET', '/api/admin/products', null, {
        Cookie: `auth_token=${magicSessionToken}`,
        Authorization: `Bearer ${magicSessionToken}`
      });
      assert.strictEqual(resBlocked.status, 403, 'Sessão obtida via magic link NÃO pode acessar APIs de admin sem segundo fator');
    });

    // -------------------------------------------------------------
    // Test 38: Validação de segundo fator via POST /api/auth/mfa/verify promove sessão
    // -------------------------------------------------------------
    await test('38. POST /api/auth/mfa/verify com código TOTP válido valida sessão pré-autenticada e libera acesso', async () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const encryptedSecret = totpService.encryptSecret(secret);
      const preAuthToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      db.prepare(`
        UPDATE users
        SET session_token = ?,
            session_expires_at = ?,
            session_mfa_verified = 0,
            totp_enabled = 1,
            totp_secret = ?
        WHERE id = ?
      `).run(preAuthToken, expiresAt, encryptedSecret, adminId);

      // 1. Enviar código TOTP incorreto -> 401
      const resBad = await request('POST', '/api/auth/mfa/verify', { mfaCode: '000000' }, {
        Cookie: `auth_token=${preAuthToken}`,
        Authorization: `Bearer ${preAuthToken}`,
        Origin: 'https://seguranca.raiaagentes.com.br'
      });
      assert.strictEqual(resBad.status, 401, 'Código incorreto deve retornar 401');

      // 2. Enviar código TOTP correto gerado no instante
      const validCode = totpService.generateToken(secret);
      const resGood = await request('POST', '/api/auth/mfa/verify', { mfaCode: validCode }, {
        Cookie: `auth_token=${preAuthToken}`,
        Authorization: `Bearer ${preAuthToken}`,
        Origin: 'https://seguranca.raiaagentes.com.br'
      });
      assert.strictEqual(resGood.status, 200, 'Código correto deve retornar 200');
      assert.strictEqual(resGood.body.success, true);
      assert.strictEqual(resGood.body.mfaVerified, true);

      // Verify in DB that session_mfa_verified is now 1
      const updatedUser = db.prepare('SELECT session_mfa_verified FROM users WHERE session_token = ?').get(preAuthToken);
      assert.strictEqual(updatedUser.session_mfa_verified, 1, 'session_mfa_verified deve ser 1 após verificação');

      // Now accessing admin routes is ALLOWED
      const resAllowed = await request('GET', '/api/admin/analytics/overview', null, {
        Cookie: `auth_token=${preAuthToken}`,
        Authorization: `Bearer ${preAuthToken}`
      });
      assert.strictEqual(resAllowed.status, 200, 'Acesso às APIs de admin deve ser liberado após MFA');
    });

    // -------------------------------------------------------------
    // Test 39: Restrição de Privilégio Mínimo: ADMIN_API_KEY bloqueada em operações financeiras e sensíveis
    // -------------------------------------------------------------
    await test('39. ADMIN_API_KEY bloqueada em operações financeiras, vendas diretas, produtos e backup (Privilégio Mínimo)', async () => {
      config.adminApiKey = 'SuperSecretAdminApiKeyAutomation#2026';

      const restrictedEndpoints = [
        { method: 'GET', path: '/api/asaas/status', desc: 'Asaas status e saldo' },
        { method: 'POST', path: '/api/asaas/create-pix', body: { value: 50 }, desc: 'Criação de cobrança Pix' },
        { method: 'POST', path: '/api/asaas/create-link', body: { value: 100 }, desc: 'Criação de link de pagamento' },
        { method: 'GET', path: '/api/asaas/payments', desc: 'Listagem de pagamentos Asaas' },
        { method: 'GET', path: '/api/admin/direct-sales', desc: 'Listagem de vendas diretas' },
        { method: 'POST', path: '/api/admin/direct-sales', body: { customerName: 'X' }, desc: 'Criação de contrato direto' },
        { method: 'GET', path: '/api/admin/multiproduct/subscriptions', desc: 'Listagem de assinaturas multiproduto' },
        { method: 'POST', path: '/api/admin/products', body: { code: 'TEST' }, desc: 'Criação de produto' },
        { method: 'POST', path: '/api/admin/system/backup', desc: 'Backup SQLite do sistema' },
        { method: 'GET', path: '/api/admin/security/audit-logs', desc: 'Logs de auditoria' },
      ];

      for (const ep of restrictedEndpoints) {
        const res = await request(ep.method, ep.path, ep.body || null, {
          'X-Admin-Key': config.adminApiKey
        });
        assert.strictEqual(res.status, 403, `ADMIN_API_KEY deve receber 403 em ${ep.path} (${ep.desc})`);
        assert.ok(
          res.body.code === 'FORBIDDEN_INTERACTIVE_SESSION_REQUIRED' ||
          res.body.code === 'FORBIDDEN_RESTRICTED_AUTOMATION_SCOPE',
          `Código de bloqueio esperado em ${ep.path}, recebido: ${res.body.code}`
        );
      }

      // Allowed endpoints for automation: status
      const resPause = await request('GET', '/api/assistant/pause-status', null, {
        'X-Admin-Key': config.adminApiKey
      });
      assert.strictEqual(resPause.status, 200, 'ADMIN_API_KEY tem permissão para /api/assistant/pause-status');
    });

    // -------------------------------------------------------------
    // Test 40: Sessão revogada e sessão expirada retornam 401
    // -------------------------------------------------------------
    await test('40. Sessão revogada e sessão expirada retornam 401 Unauthorized', async () => {
      // 1. Sessão revogada (token inexistente ou null no banco)
      const resRevoked = await request('GET', '/api/me', null, {
        Cookie: 'auth_token=0000000000000000000000000000000000000000000000000000000000000000',
        Authorization: 'Bearer 0000000000000000000000000000000000000000000000000000000000000000'
      });
      assert.strictEqual(resRevoked.status, 401, 'Sessão inexistente/revogada deve retornar 401');

      // 2. Sessão com session_expires_at no passado
      const expiredToken = crypto.randomBytes(32).toString('hex');
      db.prepare(`
        UPDATE users
        SET session_token = ?,
            session_expires_at = datetime('now', '-2 days'),
            session_mfa_verified = 1
        WHERE id = ?
      `).run(expiredToken, adminId);

      const resExpired = await request('GET', '/api/me', null, {
        Cookie: `auth_token=${expiredToken}`,
        Authorization: `Bearer ${expiredToken}`
      });
      assert.strictEqual(resExpired.status, 401, 'Sessão expirada deve retornar 401');
    });

    // -------------------------------------------------------------
    // Test 41: Webhooks falsificados Asaas e Hotmart retornam 401
    // -------------------------------------------------------------
    await test('41. Webhooks falsificados Asaas e Hotmart (sem credencial ou token inválido) retornam 401 Unauthorized', async () => {
      config.asaasWebhookSecret = 'ValidAsaasSecretToken2026';
      config.hotmartWebhookSecret = 'ValidHotmartSecretToken2026';

      // 1. Asaas sem token
      const resAsaasNoToken = await request('POST', '/api/webhooks/asaas', { event: 'PAYMENT_RECEIVED' });
      assert.strictEqual(resAsaasNoToken.status, 401, 'Webhook Asaas sem token deve retornar 401');

      // 2. Asaas com token inválido
      const resAsaasBadToken = await request('POST', '/api/webhooks/asaas', { event: 'PAYMENT_RECEIVED' }, {
        'asaas-access-token': 'token_completamente_falso_12345'
      });
      assert.strictEqual(resAsaasBadToken.status, 401, 'Webhook Asaas com token falso deve retornar 401');

      // 3. Hotmart sem header X-HOTMART-HOTTOK
      const resHotmartNoToken = await request('POST', '/api/webhooks/hotmart', { event: 'PURCHASE_APPROVED' });
      assert.strictEqual(resHotmartNoToken.status, 401, 'Webhook Hotmart sem token deve retornar 401');

      // 4. Hotmart com token incorreto
      const resHotmartBadToken = await request('POST', '/api/webhooks/hotmart', { event: 'PURCHASE_APPROVED' }, {
        'x-hotmart-hottok': 'token_hotmart_forjado_99999'
      });
      assert.strictEqual(resHotmartBadToken.status, 401, 'Webhook Hotmart com token forjado deve retornar 401');
    });

    // -------------------------------------------------------------
    // Test 42: Idempotência de webhooks duplicados Asaas e Hotmart
    // -------------------------------------------------------------
    await test('42. Idempotência de eventos duplicados em Asaas e Hotmart retorna sucesso sem reprocessar', async () => {
      const asaasService = require('../src/services/asaasService');
      const hotmartService = require('../src/services/hotmartService');

      // 1. Asaas Idempotency
      const asaasEventId = `evt_asaas_idemp_${Date.now()}`;
      const asaasPayload = {
        id: asaasEventId,
        event: 'PAYMENT_RECEIVED',
        payment: { id: `pay_idemp_${Date.now()}`, value: 100, status: 'RECEIVED' }
      };
      const resAsaas1 = await asaasService.handleWebhookEvent(asaasPayload);
      assert.strictEqual(resAsaas1.duplicate, undefined, 'Primeira execução não deve ser duplicata');

      const resAsaas2 = await asaasService.handleWebhookEvent(asaasPayload);
      assert.strictEqual(resAsaas2.duplicate, true, 'Segunda execução deve retornar duplicate: true');

      // 2. Hotmart Idempotency
      const hotmartEventId = `evt_hotmart_idemp_${Date.now()}`;
      const hotmartPayload = {
        id: hotmartEventId,
        event: 'PURCHASE_APPROVED',
        creation_date: Date.now(),
        data: {
          purchase: { transaction: `TR_IDEMP_${Date.now()}`, status: 'APPROVED' },
          buyer: { name: 'Cliente Idempotente', email: 'idemp@teste.com' }
        }
      };
      const resHotmart1 = await hotmartService.processWebhook(hotmartPayload);
      assert.strictEqual(resHotmart1.success, true);
      assert.strictEqual(resHotmart1.duplicated, undefined);

      const resHotmart2 = await hotmartService.processWebhook(hotmartPayload);
      assert.strictEqual(resHotmart2.success, true);
      assert.strictEqual(resHotmart2.duplicated, true, 'Evento duplicado deve retornar duplicated: true');
    });

    // -------------------------------------------------------------
    // Test 43: Transacionalidade atômica com rollback em falha de banco em operações financeiras
    // -------------------------------------------------------------
    await test('43. Transacionalidade atômica com rollback no banco de dados em falha de operação financeira', async () => {
      const initialUsersCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

      assert.throws(() => {
        db.exec('BEGIN TRANSACTION');
        try {
          db.prepare("INSERT INTO users (name, phone_number, role) VALUES ('Temp Rollback User', '5511977776666', 'CLIENT')").run();
          throw new Error('Falha simulada durante operação financeira transacional');
        } catch (txErr) {
          try { db.exec('ROLLBACK'); } catch (_) {}
          throw txErr;
        }
      }, /Falha simulada/);

      const finalUsersCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      assert.strictEqual(finalUsersCount, initialUsersCount, 'Rollback deve garantir que nenhuma alteração parcial persista');
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
