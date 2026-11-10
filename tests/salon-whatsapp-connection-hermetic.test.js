/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS: COMANDO 027
 * Validação automatizada da conexão WhatsApp Multi-Tenant (QR Code e Código de Pareamento)
 *
 * Em conformidade com:
 * - OWASP ASVS 5.0 (Proteções 01, 03, 11, 12, 17, 23)
 * - Framework nativo Node.js 22 (node:test, node:assert/strict)
 * - Isolamento em os.tmpdir() (zero contaminação de data/assistant.db)
 *
 * @module tests/salon-whatsapp-connection-hermetic.test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Configura banco temporário descartável ANTES de importar módulos do sistema
const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raia_test_027_'));
const tmpDbPath = path.join(tmpTestDir, `test_db_${Date.now()}.db`);
process.env.DB_PATH = tmpDbPath;
process.env.APP_MODE = 'test';
process.env.NODE_ENV = 'test';

// Carrega módulos do projeto
const phoneUtils = require('../src/utils/phoneUtils');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');
const db = require('../src/database/db');
const SalonWhatsAppRepository = require('../src/database/salonWhatsAppRepository');

// Hash de segurança para comprovar inviolabilidade de data/assistant.db
function getProdDbHash() {
  const prodDbPath = path.resolve(__dirname, '../data/assistant.db');
  if (!fs.existsSync(prodDbPath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex');
}

const prodHashBefore = getProdDbHash();

test.describe('COMANDO 027 — SUÍTE HERMÉTICA DE CONEXÃO WHATSAPP MULTI-TENANT', () => {

  test.before(() => {
    // Aponta a raiz de sessões do manager para a pasta temporária
    salonSessionManager._setBaseDirForTesting(path.join(tmpTestDir, 'sessions'));
    salonSessionManager._resetForTesting();

    // Semente dos salões de teste
    db.prepare(`INSERT OR REPLACE INTO users (id, name, phone_number) VALUES (1, 'Salão Bela Mulher', '5511999990001')`).run();
    db.prepare(`INSERT OR REPLACE INTO users (id, name, phone_number) VALUES (2, 'Salão Studio VIP', '5511999990002')`).run();
    db.prepare(`INSERT OR REPLACE INTO client_salons (user_id, salon_name, phone) VALUES (1, 'Salão Bela Mulher', '5511999990001')`).run();
    db.prepare(`INSERT OR REPLACE INTO client_salons (user_id, salon_name, phone) VALUES (2, 'Salão Studio VIP', '5511999990002')`).run();
  });

  test.after(() => {
    salonSessionManager._resetForTesting();
    try {
      if (fs.existsSync(tmpTestDir)) {
        fs.rmSync(tmpTestDir, { recursive: true, force: true });
      }
    } catch (_) {}

    // Verifica que o banco de produção jamais foi tocado
    const prodHashAfter = getProdDbHash();
    if (prodHashBefore !== null && prodHashAfter !== null) {
      assert.equal(prodHashBefore, prodHashAfter, 'VIOLAÇÃO GRAVE: data/assistant.db foi modificado durante os testes!');
    }
  });

  // =========================================================================
  // PILAR 1: Validação E.164 e Normalização
  // =========================================================================
  test('TC-UNI-01: Validação de número móvel brasileiro (13 dígitos com DDI 55 e 9º dígito)', () => {
    const validInputs = [
      '+55 (11) 98765-4321',
      '5511987654321',
      '11987654321',
      '+55 11 98765 4321',
      '(21) 99999-8888',
      '85988887777',
    ];

    for (const input of validInputs) {
      const normalized = salonSessionManager.validateBrazilianPhoneForPairing(input);
      assert.ok(normalized.startsWith('55'), `Deveria começar com 55: ${normalized}`);
      assert.ok(normalized.length === 13, `Deveria ter 13 dígitos: ${normalized}`);
      const ddd = normalized.slice(2, 4);
      assert.ok(phoneUtils.isValidBrazilianDdd(ddd), `DDD deveria ser válido: ${ddd}`);
      assert.equal(normalized.slice(4, 5), '9', 'Celular deveria iniciar com 9');
    }
  });

  test('TC-UNI-02: Rejeição de números com DDD inválido, tamanho incorreto ou sem 9º dígito', () => {
    // DDDs inválidos
    assert.throws(
      () => salonSessionManager.validateBrazilianPhoneForPairing('10987654321'),
      /INVALID_BRAZILIAN_DDD/,
      'Deveria rejeitar DDD 10'
    );
    assert.throws(
      () => salonSessionManager.validateBrazilianPhoneForPairing('00987654321'),
      /INVALID_BRAZILIAN_DDD/,
      'Deveria rejeitar DDD 00'
    );

    // Comprimento inválido
    assert.throws(
      () => salonSessionManager.validateBrazilianPhoneForPairing('11987'),
      /INVALID_PHONE_LENGTH/,
      'Deveria rejeitar número curto'
    );
    assert.throws(
      () => salonSessionManager.validateBrazilianPhoneForPairing('55119999999999999'),
      /INVALID_PHONE_LENGTH/,
      'Deveria rejeitar número excessivamente longo'
    );

    // Celular de 13 dígitos sem o 9 inicial
    assert.throws(
      () => salonSessionManager.validateBrazilianPhoneForPairing('11887654321'),
      /INVALID_MOBILE_NINTH_DIGIT/,
      'Deveria rejeitar celular que não inicia com 9'
    );
  });

  // =========================================================================
  // PILAR 2: Máscara de Privacidade LGPD / ASVS 5.0
  // =========================================================================
  test('TC-UNI-03: phoneUtils.maskPhoneNumber deve mascarar dígitos centrais', () => {
    assert.equal(phoneUtils.maskPhoneNumber('5511987654321'), '+55 (11) 9****-4321');
    assert.equal(phoneUtils.maskPhoneNumber('11999998888'), '+55 (11) 9****-8888');
    assert.equal(phoneUtils.maskPhoneNumber(''), '');
    assert.equal(phoneUtils.maskPhoneNumber(null), '');
  });

  // =========================================================================
  // PILAR 3: Defesa contra Path Traversal (Proteção 23)
  // =========================================================================
  test('TC-SEC-01: salonSessionManager.getSalonSessionDir deve impedir Path Traversal', () => {
    const validDir = salonSessionManager.getSalonSessionDir(1);
    assert.ok(validDir.endsWith('salon_1'), `Caminho deveria terminar com salon_1: ${validDir}`);

    // Tentativas de injeção ou navegação para diretório pai
    assert.throws(() => salonSessionManager.getSalonSessionDir('../admin'), /INVALID_TENANT_ID/);
    assert.throws(() => salonSessionManager.getSalonSessionDir('0'), /INVALID_TENANT_ID/);
    assert.throws(() => salonSessionManager.getSalonSessionDir('-5'), /INVALID_TENANT_ID/);
    assert.throws(() => salonSessionManager.getSalonSessionDir('1; DROP TABLE'), /INVALID_TENANT_ID/);
    assert.throws(() => salonSessionManager.getSalonSessionDir(NaN), /INVALID_TENANT_ID/);
  });

  // =========================================================================
  // PILAR 4: Isolamento Multi-Tenant das Sessões
  // =========================================================================
  test('TC-TEN-01: Salão 1 e Salão 2 devem possuir diretórios e estados de sessão totalmente isolados', async () => {
    const dir1 = salonSessionManager.getSalonSessionDir(1);
    const dir2 = salonSessionManager.getSalonSessionDir(2);

    assert.notEqual(dir1, dir2);
    assert.ok(fs.existsSync(dir1));
    assert.ok(fs.existsSync(dir2));

    // Inicializa QR Code para Salão 1
    const qrResult1 = await salonSessionManager.startQrSession(1);
    assert.equal(qrResult1.success, true);
    assert.equal(qrResult1.status, 'WAITING_QR');
    assert.ok(qrResult1.qrCode.startsWith('data:image/png;base64,'));

    // Salão 2 ainda deve estar DESCONECTADO
    const status2 = salonSessionManager.getSessionStatus(2);
    assert.equal(status2.status, 'DISCONNECTED');
    assert.equal(status2.hasQr, false);
    assert.equal(status2.qrCode, null);

    // Inicializa Pairing Code para Salão 2
    const codeResult2 = await salonSessionManager.requestPairingCode(2, '11987654321');
    assert.equal(codeResult2.success, true);
    assert.equal(codeResult2.status, 'WAITING_CODE');
    assert.ok(codeResult2.pairingCode.length >= 8);

    // Salão 1 ainda deve estar com QR Code e sem pairing code
    const status1 = salonSessionManager.getSessionStatus(1);
    assert.equal(status1.status, 'WAITING_QR');
    assert.equal(status1.hasQr, true);
    assert.equal(status1.hasPairingCode, false);
    assert.equal(status1.pairingCode, null);

    // Desconecta Salão 1
    const disc1 = await salonSessionManager.disconnect(1);
    assert.equal(disc1.success, true);

    // Salão 1 agora está DISCONNECTED
    assert.equal(salonSessionManager.getSessionStatus(1).status, 'DISCONNECTED');

    // Salão 2 permanece com código ativo e inalterado
    const status2After = salonSessionManager.getSessionStatus(2);
    assert.equal(status2After.status, 'WAITING_CODE');
    assert.equal(status2After.pairingCode, codeResult2.pairingCode);
  });

  // =========================================================================
  // PILAR 5: Persistência no Repositório SQLite e Transições de Estado
  // =========================================================================
  test('TC-REP-01: SalonWhatsAppRepository deve persistir estados e auditar transições', () => {
    const userId = 1;

    // 1. Ensure exists
    const session = SalonWhatsAppRepository.ensureSessionExists(userId, 'data/sessions/salon_1');
    assert.equal(session.user_id, userId);
    assert.equal(session.session_status, 'DISCONNECTED');

    // 2. Mark Connected
    SalonWhatsAppRepository.markSessionConnected(userId, {
      phone: '5511999990001',
      phoneJid: '5511999990001@s.whatsapp.net',
      pairingMethod: 'QR',
    });

    const connSession = SalonWhatsAppRepository.getSessionByUserId(userId);
    assert.equal(connSession.session_status, 'CONNECTED');
    assert.equal(connSession.connected_phone, '5511999990001');
    assert.equal(connSession.pairing_method, 'QR');
    assert.ok(connSession.connected_at !== null);

    // Verifica que client_salons também foi sincronizado
    const salonRow = db.prepare('SELECT whatsapp_status, whatsapp_phone FROM client_salons WHERE user_id = ?').get(userId);
    assert.equal(salonRow.whatsapp_status, 'CONNECTED');
    assert.equal(salonRow.whatsapp_phone, '5511999990001');

    // 3. Mark Disconnected
    SalonWhatsAppRepository.markSessionDisconnected(userId, { status: 'DISCONNECTED', resetCredentials: true });
    const discSession = SalonWhatsAppRepository.getSessionByUserId(userId);
    assert.equal(discSession.session_status, 'DISCONNECTED');
    assert.equal(discSession.connected_phone, null);

    // 4. Logs de Auditoria
    SalonWhatsAppRepository.createLog(userId, {
      eventType: 'CONNECTED',
      newStatus: 'CONNECTED',
      reason: 'Teste de auditoria',
      ipAddress: '127.0.0.1',
    });

    const logs = SalonWhatsAppRepository.getRecentLogs(userId, 5);
    assert.ok(logs.length >= 1);
    assert.equal(logs[0].event_type, 'CONNECTED');
    assert.equal(logs[0].reason, 'Teste de auditoria');
  });

  // =========================================================================
  // PILAR 6: Hard Staging Lock e Simulação Limpa
  // =========================================================================
  test('TC-SEC-02: Hard Staging Lock deve assegurar geração simulada local sem tráfego externo', async () => {
    // Com APP_MODE=test e NODE_ENV=test, isRealWhatsAppTransportAllowed retorna false
    const qrResult = await salonSessionManager.startQrSession(1);
    assert.equal(qrResult.success, true);
    assert.equal(qrResult.status, 'WAITING_QR');
    assert.ok(qrResult.qrCode.startsWith('data:image/png;base64,'));

    const codeResult = await salonSessionManager.requestPairingCode(1, '11988887777');
    assert.equal(codeResult.success, true);
    assert.equal(codeResult.status, 'WAITING_CODE');
    assert.ok(codeResult.pairingCode.length >= 8);
    assert.ok(codeResult.expiresAt > Date.now());
  });

});
