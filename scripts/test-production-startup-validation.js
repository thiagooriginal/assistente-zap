/**
 * RAIA AGENTES — Production Startup & Environment Validation Test Suite
 * 
 * Verifies:
 * 1. Startup with valid production environment variables.
 * 2. Blocking when required secrets are missing (SESSION_SECRET, CLIENT_AUTH_SECRET, ADMIN_PASSWORD).
 * 3. Rejection of weak or default secrets.
 * 4. Staging compatibility (HOMOLOGACAO=true or APP_MODE=staging bypasses strict prod exit).
 * 5. Zero leakage of secret values in console output / error logs.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const ROOT_DIR = path.resolve(__dirname, '..');
const NODE_BIN = process.execPath;

console.log('================================================================');
console.log('   RAIA AGENTES — SUITE DE TESTES: VALIDAÇÃO DE AMBIENTE PROD   ');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function runValidationProcess(envOverrides) {
  // Clear inherited process.env from .env file by running an isolated one-liner
  const runnerScript = `
    // Do not load .env file
    delete process.env.DOTENV_CONFIG_PATH;
    const config = require('./src/config/index.js');
    const res = config.validateEnvironment({ throwOnError: true });
    console.log('RESULT:' + JSON.stringify(res));
  `;

  // Start with clean minimal env
  const cleanEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    NODE_ENV: 'production',
    ...envOverrides
  };

  const proc = spawnSync(NODE_BIN, ['-e', runnerScript], {
    cwd: ROOT_DIR,
    env: cleanEnv,
    encoding: 'utf8'
  });

  return {
    status: proc.status,
    stdout: proc.stdout || '',
    stderr: proc.stderr || '',
    error: proc.error
  };
}

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}:`, err.message);
  }
}

// -------------------------------------------------------------
// Test 1: Valid Production Environment
// -------------------------------------------------------------
test('1. Inicialização com variáveis de produção válidas e seguras', () => {
  const res = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'SuperSecretAdminPassword#2026',
    SESSION_SECRET: 'production_session_secret_32_characters_long_123',
    CLIENT_AUTH_SECRET: 'production_client_auth_secret_32_characters_456',
    MFA_ENCRYPTION_KEY: 'production_mfa_encryption_key_32_chars_long_789',
    DB_PATH: 'data/assistant.db'
  });

  assert.strictEqual(res.status, 0, `Process should exit with 0. Stderr: ${res.stderr}`);
  assert.ok(res.stdout.includes('"valid":true'), 'Validation result must be valid: true');
  assert.ok(!res.stderr.includes('Violação de segurança'), 'Must not report security violations');
});

// -------------------------------------------------------------
// Test 2: Missing SESSION_SECRET
// -------------------------------------------------------------
test('2. Bloqueio imediato quando SESSION_SECRET estiver ausente em produção', () => {
  const res = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'SuperSecretAdminPassword#2026',
    SESSION_SECRET: '',
    CLIENT_AUTH_SECRET: 'production_client_auth_secret_32_characters_456',
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(res.status, 0, 'Process must exit with non-zero status code');
  assert.ok(
    res.stderr.includes('SESSION_SECRET não configurado') || res.stderr.includes('SESSION_SECRET'),
    'Stderr must indicate SESSION_SECRET is missing'
  );
});

// -------------------------------------------------------------
// Test 3: Missing CLIENT_AUTH_SECRET
// -------------------------------------------------------------
test('3. Bloqueio imediato quando CLIENT_AUTH_SECRET estiver ausente em produção', () => {
  const res = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'SuperSecretAdminPassword#2026',
    SESSION_SECRET: 'production_session_secret_32_characters_long_123',
    CLIENT_AUTH_SECRET: '',
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(res.status, 0, 'Process must exit with non-zero status code');
  assert.ok(
    res.stderr.includes('CLIENT_AUTH_SECRET não configurado') || res.stderr.includes('CLIENT_AUTH_SECRET'),
    'Stderr must indicate CLIENT_AUTH_SECRET is missing'
  );
});

// -------------------------------------------------------------
// Test 4: Missing or Weak ADMIN_PASSWORD
// -------------------------------------------------------------
test('4. Bloqueio quando ADMIN_PASSWORD for fraca ou padrão em produção', () => {
  const resWeak = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'admin',
    SESSION_SECRET: 'production_session_secret_32_characters_long_123',
    CLIENT_AUTH_SECRET: 'production_client_auth_secret_32_characters_456',
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(resWeak.status, 0, 'Weak admin password must fail startup');
  assert.ok(
    resWeak.stderr.includes('ADMIN_PASSWORD'),
    'Stderr must indicate ADMIN_PASSWORD is weak or short'
  );

  const resDefault = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'password',
    SESSION_SECRET: 'production_session_secret_32_characters_long_123',
    CLIENT_AUTH_SECRET: 'production_client_auth_secret_32_characters_456',
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(resDefault.status, 0, 'Default password must fail startup');
  assert.ok(resDefault.stderr.includes('ADMIN_PASSWORD'));
});

// -------------------------------------------------------------
// Test 5: Rejection of Default Secret Values
// -------------------------------------------------------------
test('5. Rejeição de valores padrão conhecidos (segredo_padrao_trocar_em_producao)', () => {
  const res = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'SuperSecretAdminPassword#2026',
    SESSION_SECRET: 'segredo_padrao_trocar_em_producao',
    CLIENT_AUTH_SECRET: 'production_client_auth_secret_32_characters_456',
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(res.status, 0, 'Default secret value must fail startup');
  assert.ok(
    res.stderr.includes('SESSION_SECRET configurado com valor padrão') || res.stderr.includes('SESSION_SECRET'),
    'Stderr must report default secret value rejection'
  );
});

// -------------------------------------------------------------
// Test 6: MFA Encryption Key Enforcement in Production
// -------------------------------------------------------------
test('6. Bloqueio quando ADMIN_MFA_ENABLED=true e chave de criptografia MFA for fraca', () => {
  const res = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'SuperSecretAdminPassword#2026',
    SESSION_SECRET: 'segredo_producao_forte_1234567890',
    CLIENT_AUTH_SECRET: 'segredo_cliente_forte_1234567890',
    ADMIN_MFA_ENABLED: 'true',
    MFA_ENCRYPTION_KEY: 'raia-mfa-default-key-fallback', // known fallback
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(res.status, 0, 'Weak MFA encryption key must fail startup');
  assert.ok(
    res.stderr.includes('MFA_ENCRYPTION_KEY'),
    'Stderr must report MFA_ENCRYPTION_KEY failure'
  );
});

// -------------------------------------------------------------
// Test 7: Staging Compatibility (HOMOLOGACAO=true e APP_MODE=staging)
// -------------------------------------------------------------
test('7. Compatibilidade com APP_MODE=staging e HOMOLOGACAO=true em domínio de staging', () => {
  const resHomolog = runValidationProcess({
    NODE_ENV: 'production',
    HOMOLOGACAO: 'true',
    APP_MODE: 'staging',
    BASE_URL: 'https://staging.raiaagentes.com.br',
    ADMIN_PASSWORD: 'StagingAdminPassword#2026',
    DB_PATH: 'data/assistant.db'
  });

  // In staging mode with valid staging domain, missing production secrets should not throw/exit with fatal error
  assert.strictEqual(resHomolog.status, 0, `Staging should start without throwing fatal prod errors. Stderr: ${resHomolog.stderr}`);
  assert.ok(resHomolog.stdout.includes('"environment":"staging"'), 'Environment must be recognized as staging');
});

// -------------------------------------------------------------
// Test 8: Absence of Secret Leakage in Logs
// -------------------------------------------------------------
test('8. Ausência de vazamento de segredos nos logs de inicialização e erro', () => {
  const canaryAdminPassword = 'CanaryAdminPassword$SuperConfidential999';
  const canarySessionSecret = 'CanarySessionSecret$DoNotLeakUnderAnyCircumstance999';
  const canaryClientSecret = 'CanaryClientSecret$TopSecretClientKey999';

  const res = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: canaryAdminPassword,
    SESSION_SECRET: canarySessionSecret,
    CLIENT_AUTH_SECRET: canaryClientSecret,
    DB_PATH: 'data/assistant.db'
  });

  const fullOutput = (res.stdout + '\n' + res.stderr);

  assert.ok(!fullOutput.includes(canaryAdminPassword), 'ADMIN_PASSWORD canary leaked in output!');
  assert.ok(!fullOutput.includes(canarySessionSecret), 'SESSION_SECRET canary leaked in output!');
  assert.ok(!fullOutput.includes(canaryClientSecret), 'CLIENT_AUTH_SECRET canary leaked in output!');

  // Now trigger an error with canary secrets to verify error handlers don't leak them
  const resErr = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'admin', // triggers error
    SESSION_SECRET: canarySessionSecret,
    CLIENT_AUTH_SECRET: canaryClientSecret,
    DB_PATH: 'data/assistant.db'
  });

  const errOutput = (resErr.stdout + '\n' + resErr.stderr);
  assert.ok(!errOutput.includes(canarySessionSecret), 'SESSION_SECRET canary leaked during error handling!');
  assert.ok(!errOutput.includes(canaryClientSecret), 'CLIENT_AUTH_SECRET canary leaked during error handling!');
});

// -------------------------------------------------------------
// Test 9: Conflicting Environment Flags (APP_MODE=production vs HOMOLOGACAO=true)
// -------------------------------------------------------------
test('9. Bloqueio de combinações conflitantes (APP_MODE=production com HOMOLOGACAO=true)', () => {
  const res = runValidationProcess({
    NODE_ENV: 'production',
    APP_MODE: 'production',
    HOMOLOGACAO: 'true',
    ADMIN_PASSWORD: 'SuperSecretAdminPassword#2026',
    SESSION_SECRET: 'production_session_secret_32_characters_long_123',
    CLIENT_AUTH_SECRET: 'production_client_auth_secret_32_characters_456',
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(res.status, 0, 'Must abort when APP_MODE=production conflicts with HOMOLOGACAO=true');
  assert.ok(res.stderr.includes('CONFLITO DE AMBIENTE'), 'Stderr must identify environment conflict');
});

// -------------------------------------------------------------
// Test 10: Canonical Production Domain Conflict with Staging Flag
// -------------------------------------------------------------
test('10. Bloqueio de tentativa de ativar staging no domínio canônico de produção', () => {
  const res = runValidationProcess({
    NODE_ENV: 'production',
    BASE_URL: 'https://raiaagentes.com.br',
    HOMOLOGACAO: 'true',
    APP_MODE: 'staging',
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(res.status, 0, 'Must abort when staging flag points to canonical production domain');
  assert.ok(
    res.stderr.includes('CONFLITO CRÍTICO DE AMBIENTE') || res.stderr.includes('domínio canônico de produção'),
    'Stderr must indicate critical domain conflict'
  );
});

// -------------------------------------------------------------
// Test 11: Weak Password Rejection Even with Staging Flag
// -------------------------------------------------------------
test('11. Rejeição de senha fraca mesmo quando flag de homologação estiver ativa', () => {
  const res = runValidationProcess({
    NODE_ENV: 'production',
    HOMOLOGACAO: 'true',
    APP_MODE: 'staging',
    BASE_URL: 'https://staging.raiaagentes.com.br',
    ADMIN_PASSWORD: 'admin',
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(res.status, 0, 'Weak password must be rejected even in staging');
  assert.ok(res.stderr.includes('ADMIN_PASSWORD'), 'Stderr must flag weak ADMIN_PASSWORD');
});

// -------------------------------------------------------------
// Test 12: Independent MFA Key Enforcement (Cannot Reuse Session Secret)
// -------------------------------------------------------------
test('12. Bloqueio quando MFA_ENCRYPTION_KEY reutilizar SESSION_SECRET em produção', () => {
  const sharedSecret = 'shared_secret_between_mfa_and_session_123456';
  const res = runValidationProcess({
    NODE_ENV: 'production',
    ADMIN_PASSWORD: 'SuperSecretAdminPassword#2026',
    SESSION_SECRET: sharedSecret,
    CLIENT_AUTH_SECRET: 'production_client_auth_secret_32_characters_456',
    ADMIN_MFA_ENABLED: 'true',
    MFA_ENCRYPTION_KEY: sharedSecret, // reused secret!
    DB_PATH: 'data/assistant.db'
  });

  assert.notStrictEqual(res.status, 0, 'Reusing session secret as MFA key must fail');
  assert.ok(
    res.stderr.includes('MFA_ENCRYPTION_KEY deve ser uma chave independente') || res.stderr.includes('MFA_ENCRYPTION_KEY'),
    'Stderr must report MFA key independence violation'
  );
});

console.log('\n----------------------------------------------------------------');
console.log(`RESULTADO FINAL: ${passedTests}/${totalTests} testes de inicialização passaram.`);
console.log('----------------------------------------------------------------\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
