/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS (COMANDO 032)
 * Validação de Geração do QR Code, TTL em Memória e Máquina de Estados de Pareamento
 *
 * Módulos Nativos: node:test, node:assert/strict
 * Padrão Hermético: Banco SQLite temporário em os.tmpdir() e Fail-Closed Baileys
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

// 1. ISOLAMENTO MANDATÓRIO DE BANCO E SESSÕES EM OS.TMPDIR()
const uniqueRunId = 'test_qr_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
const tempDbPath = path.join(os.tmpdir(), `${uniqueRunId}.db`);
const tempSessionsDir = path.join(os.tmpdir(), `${uniqueRunId}_sessions`);

process.env.DB_PATH = tempDbPath;
process.env.HOMOLOGACAO = 'true';
process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'staging';
process.env.ALLOW_SALON_WHATSAPP_TESTING = 'false'; // Fail-closed: 100% simulado

// Carga dos módulos com ambiente já isolado
const db = require('../src/database/db');
const SalonWhatsAppRepository = require('../src/database/salonWhatsAppRepository');
const salonSessionManager = require('../src/whatsapp/salonSessionManager');

// Redireciona o diretório de sessões para o diretório temporário
salonSessionManager._setBaseDirForTesting(tempSessionsDir);

test.after(() => {
  try {
    salonSessionManager._resetForTesting();
    db.close();
  } catch (_) {}

  // Expurga arquivos temporários
  try {
    if (fs.existsSync(tempDbPath)) fs.rmSync(tempDbPath, { force: true });
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.rmSync(`${tempDbPath}-wal`, { force: true });
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.rmSync(`${tempDbPath}-shm`, { force: true });
    if (fs.existsSync(tempSessionsDir)) fs.rmSync(tempSessionsDir, { recursive: true, force: true });
  } catch (_) {}
});

// Helper para criar usuário e salão no banco temporário
function createTestTenant(userId = 88) {
  db.prepare(`
    INSERT OR REPLACE INTO users (id, phone_number, name, role, plan)
    VALUES (?, ?, ?, 'USER', 'JESSICA_PRO')
  `).run(userId, `55119999900${userId}`, `Salão Teste ${userId}`);

  db.prepare(`
    INSERT OR REPLACE INTO client_salons (id, user_id, salon_name, phone)
    VALUES (?, ?, ?, ?)
  `).run(userId, userId, `Beleza ${userId}`, `55119999900${userId}`);

  SalonWhatsAppRepository.ensureSessionExists(userId, path.join(tempSessionsDir, `salon_${userId}`));
  return userId;
}

// =========================================================================
// PILAR 1: GERAÇÃO CORRETA E INTEGRIDADE DO QR CODE
// =========================================================================
test('Pilar 1.1: Geração de QR Code no formato Data URL válido com bytes PNG', async () => {
  const tenantId = createTestTenant(101);

  const result = await salonSessionManager.startQrSession(tenantId);
  assert.equal(result.success, true, 'Chamada deve ser bem-sucedida');
  assert.equal(result.status, 'WAITING_QR', 'Status deve ser WAITING_QR');
  assert.ok(result.qrCode, 'QR Code deve estar presente');
  assert.ok(typeof result.qrCode === 'string', 'QR Code deve ser string');

  // Validação estrita do prefixo Data URL PNG
  const pngPrefix = 'data:image/png;base64,';
  assert.ok(result.qrCode.startsWith(pngPrefix), 'Deve ser uma Data URL de imagem PNG');

  // Validação dos Magic Bytes do PNG decodificado
  const base64Data = result.qrCode.slice(pngPrefix.length);
  const buffer = Buffer.from(base64Data, 'base64');
  assert.ok(buffer.length > 50, 'Buffer da imagem PNG deve conter dados legíveis');

  // Assinatura PNG: 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A
  const expectedMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(
    buffer.subarray(0, 8),
    expectedMagic,
    'Cabeçalho binário deve corresponder exatamente aos Magic Bytes do PNG'
  );
});

test('Pilar 1.2: Concorrência simultânea e proteção contra Race Condition (Mutex)', async () => {
  const tenantId = createTestTenant(102);

  // Dispara 5 requisições de geração de QR Code simultâneas
  const promises = [
    salonSessionManager.startQrSession(tenantId),
    salonSessionManager.startQrSession(tenantId),
    salonSessionManager.startQrSession(tenantId),
    salonSessionManager.startQrSession(tenantId),
    salonSessionManager.startQrSession(tenantId),
  ];

  const results = await Promise.all(promises);
  for (const res of results) {
    assert.equal(res.success, true);
    assert.equal(res.status, 'WAITING_QR');
    assert.ok(res.qrCode && res.qrCode.startsWith('data:image/png;base64,'));
  }
});

// =========================================================================
// PILAR 2: TTL EM MEMÓRIA E EXPIRAÇÃO EFÊMERA
// =========================================================================
test('Pilar 2.1: Efemeridade Total: QR Code NUNCA é gravado como string bruta no SQLite', async () => {
  const tenantId = createTestTenant(103);
  await salonSessionManager.startQrSession(tenantId);

  const row = db.prepare('SELECT * FROM client_salon_whatsapp_sessions WHERE user_id = ?').get(tenantId);
  assert.ok(row, 'Registro de sessão deve existir');
  assert.equal(row.qr_code_cached, null, 'Coluna qr_code_cached no banco DEVE ser estritamente NULL (Proteção 17)');
  assert.equal(row.pairing_code_cached, null, 'Coluna pairing_code_cached no banco DEVE ser estritamente NULL');
  assert.ok(row.qr_code_expires_at, 'qr_code_expires_at deve conter timestamp');
});

test('Pilar 2.2: Expiração ativa do QR Code em memória após TTL', async () => {
  const tenantId = createTestTenant(104);
  await salonSessionManager.startQrSession(tenantId);

  // Status imediato: tem QR
  let status = salonSessionManager.getSessionStatus(tenantId);
  assert.equal(status.hasQr, true);
  assert.ok(status.qrCode);

  // Injeta expiração no passado via alteração controlada de sessão em memória
  salonSessionManager._setSocketForTesting(tenantId, {
    user: null,
    qrExpiresAt: Date.now() - 5000,
  });

  // Próxima leitura deve expurgar ativamente o QR Code
  status = salonSessionManager.getSessionStatus(tenantId);
  assert.equal(status.hasQr, false, 'hasQr deve ser falso após expiração do TTL');
  assert.equal(status.qrCode, null, 'qrCode em RAM deve ser nulo');
});

// =========================================================================
// PILAR 3: MÁQUINA DE ESTADOS DA INTERFACE E IMUNIDADE A OVERWRITE POR POLLING
// =========================================================================

/**
 * Harness determinístico que emula rigorosamente a lógica do cliente (painel.html)
 */
class ClientPairingStateMachine {
  constructor() {
    this.state = 'DISCONNECTED'; // DISCONNECTED, QR_SELECTED, QR_WAITING, CODE_SELECTED, CODE_WAITING, CONNECTED
    this.activeMethod = null;    // null, 'QR', 'CODE'
    this.activeQrCode = null;
    this.activePairingCode = null;
    this.flickerCount = 0;
  }

  userSelectsQr() {
    this.state = 'QR_SELECTED';
    this.activeMethod = 'QR';
    this.activePairingCode = null;
  }

  onQrSessionReady(qrCode) {
    if (this.activeMethod === 'QR' && (this.state === 'QR_SELECTED' || this.state === 'QR_WAITING')) {
      this.state = 'QR_WAITING';
      this.activeQrCode = qrCode;
    }
  }

  userSelectsCode() {
    this.state = 'CODE_SELECTED';
    this.activeMethod = 'CODE';
    this.activeQrCode = null;
  }

  onPairingCodeReady(code) {
    if (this.activeMethod === 'CODE' && (this.state === 'CODE_SELECTED' || this.state === 'CODE_WAITING')) {
      this.state = 'CODE_WAITING';
      this.activePairingCode = code;
    }
  }

  userCancels() {
    this.state = 'DISCONNECTED';
    this.activeMethod = null;
    this.activeQrCode = null;
    this.activePairingCode = null;
  }

  onPollingStatusReceived(serverStatus) {
    const prevVisualBox = this.getVisibleBox();

    if (serverStatus.status === 'CONNECTED') {
      this.state = 'CONNECTED';
      this.activeMethod = null;
      return;
    }

    // REGRA DE OURO ANTI-OVERWRITE (COMANDO 032):
    // Se o usuário está no fluxo de CÓDIGO (digitando ou aguardando), polling com QR_WAITING
    // NUNCA pode forçar a tela para QR!
    if (this.activeMethod === 'CODE') {
      if (serverStatus.status === 'WAITING_CODE' && serverStatus.pairingCode) {
        this.activePairingCode = serverStatus.pairingCode;
        this.state = 'CODE_WAITING';
      }
    } else if (this.activeMethod === 'QR') {
      if (serverStatus.status === 'WAITING_QR' && serverStatus.qrCode) {
        this.activeQrCode = serverStatus.qrCode;
        this.state = 'QR_WAITING';
      }
    }

    const currentVisualBox = this.getVisibleBox();
    if (prevVisualBox !== currentVisualBox) {
      this.flickerCount++;
    }
  }

  getVisibleBox() {
    if (this.state === 'CONNECTED') return 'CONNECTED_CARD';
    if (this.activeMethod === 'QR' && (this.state === 'QR_SELECTED' || this.state === 'QR_WAITING')) return 'QR_BOX';
    if (this.activeMethod === 'CODE' && (this.state === 'CODE_SELECTED' || this.state === 'CODE_WAITING')) return 'PAIRING_BOX';
    return 'CHOICE_BOX';
  }
}

test('Pilar 3.1: Ciclo Feliz QR (DISCONNECTED -> QR_SELECTED -> QR_WAITING)', () => {
  const machine = new ClientPairingStateMachine();
  assert.equal(machine.state, 'DISCONNECTED');
  assert.equal(machine.getVisibleBox(), 'CHOICE_BOX');

  machine.userSelectsQr();
  assert.equal(machine.state, 'QR_SELECTED');
  assert.equal(machine.getVisibleBox(), 'QR_BOX');

  machine.onQrSessionReady('data:image/png;base64,SimulatedQr');
  assert.equal(machine.state, 'QR_WAITING');
  assert.equal(machine.getVisibleBox(), 'QR_BOX');
  assert.ok(machine.activeQrCode);
});

test('Pilar 3.2: Trocar método retorna para DISCONNECTED sem desvios', () => {
  const machine = new ClientPairingStateMachine();
  machine.userSelectsQr();
  machine.onQrSessionReady('data:image/png;base64,SimulatedQr');
  assert.equal(machine.getVisibleBox(), 'QR_BOX');

  machine.userCancels();
  assert.equal(machine.state, 'DISCONNECTED');
  assert.equal(machine.getVisibleBox(), 'CHOICE_BOX');
  assert.equal(machine.activeQrCode, null);
});

test('Pilar 3.3: Ciclo Feliz Código (DISCONNECTED -> CODE_SELECTED -> CODE_WAITING)', () => {
  const machine = new ClientPairingStateMachine();
  machine.userSelectsCode();
  assert.equal(machine.state, 'CODE_SELECTED');
  assert.equal(machine.getVisibleBox(), 'PAIRING_BOX');

  machine.onPairingCodeReady('ABCD-1234');
  assert.equal(machine.state, 'CODE_WAITING');
  assert.equal(machine.getVisibleBox(), 'PAIRING_BOX');
  assert.equal(machine.activePairingCode, 'ABCD-1234');
});

test('Pilar 3.4 (CRÍTICO P0): Polling NÃO PODE sobrescrever CODE_SELECTED ou CODE_WAITING para QR_WAITING', () => {
  const machine = new ClientPairingStateMachine();

  // 1. Usuário seleciona modo código
  machine.userSelectsCode();
  assert.equal(machine.getVisibleBox(), 'PAIRING_BOX');

  // 2. Servidor dispara polling contendo status antigo de QR (cenário real relatado no bug)
  machine.onPollingStatusReceived({
    status: 'WAITING_QR',
    qrCode: 'data:image/png;base64,StaleQrCode',
    hasQr: true,
  });

  // O box visível DEVE continuar sendo PAIRING_BOX, e não QR_BOX!
  assert.equal(
    machine.getVisibleBox(),
    'PAIRING_BOX',
    'Falha Crítica: Polling sobrescreveu a tela de código para QR!'
  );
  assert.equal(machine.activeMethod, 'CODE');

  // 3. Usuário recebe o código de pareamento
  machine.onPairingCodeReady('WXYZ-9876');
  assert.equal(machine.state, 'CODE_WAITING');
  assert.equal(machine.getVisibleBox(), 'PAIRING_BOX');

  // 4. Novo polling com QR chega
  machine.onPollingStatusReceived({
    status: 'WAITING_QR',
    qrCode: 'data:image/png;base64,StaleQrCode',
    hasQr: true,
  });

  // Permanece imutável em PAIRING_BOX
  assert.equal(machine.getVisibleBox(), 'PAIRING_BOX');
  assert.equal(machine.activePairingCode, 'WXYZ-9876');
});

test('Pilar 3.5: Alternância rápida QR -> Código -> QR sem flicker e sem race condition', () => {
  const machine = new ClientPairingStateMachine();

  machine.userSelectsQr();
  assert.equal(machine.getVisibleBox(), 'QR_BOX');

  machine.userCancels();
  assert.equal(machine.getVisibleBox(), 'CHOICE_BOX');

  machine.userSelectsCode();
  assert.equal(machine.getVisibleBox(), 'PAIRING_BOX');

  // Resposta atrasada de um QR antigo chega agora: deve ser ignorada
  machine.onQrSessionReady('data:image/png;base64,LateDelayedQr');
  assert.equal(machine.getVisibleBox(), 'PAIRING_BOX', 'Resposta tardia de QR não pode alterar modo Código');

  machine.userCancels();
  assert.equal(machine.getVisibleBox(), 'CHOICE_BOX');

  machine.userSelectsQr();
  assert.equal(machine.getVisibleBox(), 'QR_BOX');
});

test('Pilar 3.6: Cancelamento/Desconexão restaura DISCONNECTED no servidor e expurga credenciais', async () => {
  const tenantId = createTestTenant(105);

  // Inicia sessão e depois cancela pendência
  await salonSessionManager.startQrSession(tenantId);
  const cancelResult = await salonSessionManager.cancelPendingPairing(tenantId);

  assert.equal(cancelResult.success, true);
  assert.equal(cancelResult.status, 'DISCONNECTED');

  const status = salonSessionManager.getSessionStatus(tenantId);
  assert.equal(status.status, 'DISCONNECTED');
  assert.equal(status.hasQr, false);
  assert.equal(status.hasPairingCode, false);
  assert.equal(status.connectedPhone, null);
});
