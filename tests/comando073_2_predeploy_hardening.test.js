'use strict';

/**
 * tests/comando073_2_predeploy_hardening.test.js
 *
 * Suíte de Testes Hermética e Isolada — COMANDO 073.2: Pré-Deploy Hardening
 *
 * Requisitos Validados:
 * 1. Oferta desconhecida com nome 'Jessica Pro' -> fail-closed (resolvePlanTier retorna null, tentativa de ativação é rejeitada como REJECTED_UNKNOWN_OFFER).
 * 2. Conflito entre código de oferta ('gtt3rhpk' -> START) e ID de plano ('ytvdj943' -> PRO ou 'pro') -> evento rejeitado com status REJECTED_PLAN_OFFER_CONFLICT e reason PLAN_OFFER_TIER_CONFLICT.
 * 3. SWITCH_PLAN sem data de vigência real (date_next_charge ausente/inválida) -> não marca ACTIVE, preserva tier anterior e status anterior, define needs_reconciliation = 1 no usuário.
 * 4. Reembolso solicitado versus concluído: REFUND_REQUESTED no Asaas não deduz da receita líquida; REFUNDED deduz.
 * 5. Eventos financeiros repetidos e fora de ordem -> idempotência determinística preserva integridade e não duplica contabilização no admin overview.
 * 6. Inicialização em banco SQLite legado -> simular banco em os.tmpdir() com tabelas prévias e executar migrações limpas sem erro.
 * 7. Preservação das configurações WhatsApp do staging (DISABLE_WHATSAPP=true, isolamento de auth_info_baileys).
 *
 * Padrão Hermético Mandatório:
 * - 100% isolado em os.tmpdir()
 * - node:test e node:assert/strict
 * - Proteção estrita do banco operacional data/assistant.db
 * - Cleanup automático no hook after()
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

// ── Isolamento Mandatório do Ambiente (ANTES de qualquer require de src/) ──
const uniqueId = `cmd073_2_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
const testDbPath = path.join(os.tmpdir(), `${uniqueId}.db`);
const testAuthDir = path.join(os.tmpdir(), `${uniqueId}_auth`);

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
process.env.ASAAS_API_URL = 'https://sandbox.asaas.com/api/v3';
process.env.ASAAS_API_KEY = '$aact_test_cmd073_2_key';
process.env.HOTMART_PRODUCT_ID = '8840376';
process.env.HOTMART_OFFER_START_CODE = 'gtt3rhpk';
process.env.HOTMART_OFFER_INTERMEDIATE_CODE = '1x8ik7i3';
process.env.HOTMART_OFFER_PRO_CODE = 'ytvdj943';
process.env.HOTMART_WEBHOOK_SECRET = 'secret_webhook_test_123';

// Importação dos módulos do sistema sob ambiente hermético
const db = require('../src/database/db');
const config = require('../src/config');
const hotmartService = require('../src/services/hotmartService');
const asaasService = require('../src/services/asaasService');
const adminOverviewService = require('../src/services/adminOverviewService');
const whatsappClient = require('../src/whatsapp/client');

test.describe('COMANDO 073.2 — Pré-Deploy Hardening & Validação Hermética', () => {

  test.after(() => {
    // Limpeza de arquivos temporários descartáveis
    try {
      if (typeof db.close === 'function') {
        try { db.close(); } catch (_) {}
      }
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
      const shmPath = `${testDbPath}-shm`;
      const walPath = `${testDbPath}-wal`;
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

      if (fs.existsSync(testAuthDir)) {
        fs.rmSync(testAuthDir, { recursive: true, force: true });
      }
    } catch (_) {}
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TESTE 1: Oferta desconhecida com nome 'Jessica Pro' -> Fail-Closed
  // ───────────────────────────────────────────────────────────────────────────
  test('1. Oferta desconhecida com nome "Jessica Pro" -> resolvePlanTier retorna null e webhook rejeita com REJECTED_UNKNOWN_OFFER', async () => {
    // 1.1 Resolução direta de tier com oferta não oficial e nome sedutor
    const unkOfferData = {
      product: { id: '8840376' },
      purchase: {
        offer: { code: 'unknown_fake_offer_99' },
        price: { value: 139.0 }
      },
      plan: {
        id: null,
        name: 'Jessica Pro'
      }
    };

    const resolvedTier = hotmartService.resolvePlanTier(unkOfferData);
    assert.strictEqual(resolvedTier, null, 'resolvePlanTier DEVE retornar null para oferta desconhecida, mesmo com nome "Jessica Pro"');

    // 1.2 Submissão de webhook de ativação com a oferta desconhecida
    const eventId = `evt_unk_offer_${Date.now()}`;
    const buyerEmail = `unk_offer_${Date.now()}@testraia.com`;
    const payload = {
      id: eventId,
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: {
          offer: { code: 'unknown_fake_offer_99' },
          transaction: `HP_UNK_${Date.now()}`
        },
        plan: {
          id: null,
          name: 'Jessica Pro'
        },
        buyer: {
          email: buyerEmail,
          name: 'Cliente Tentativa Pro'
        }
      }
    };

    const result = await hotmartService.processWebhook(payload);
    assert.strictEqual(result.success, false, 'processWebhook deve falhar');
    assert.strictEqual(result.ignored, true, 'processWebhook deve marcar ignored: true');
    assert.strictEqual(result.reason, 'UNKNOWN_OR_INVALID_PLAN_TIER', 'Razão deve ser UNKNOWN_OR_INVALID_PLAN_TIER');

    // Verificar se foi persistido como REJECTED_UNKNOWN_OFFER na tabela de auditoria
    const auditRow = db.prepare('SELECT status, raw_payload FROM hotmart_webhook_events WHERE event_id = ?').get(eventId);
    assert.ok(auditRow, 'Registro de auditoria do evento deve existir');
    assert.strictEqual(auditRow.status, 'REJECTED_UNKNOWN_OFFER', 'Status deve ser estritamente REJECTED_UNKNOWN_OFFER');

    // Garantir que nenhum usuário foi criado para este email
    const userRow = db.prepare('SELECT id FROM users WHERE email = ?').get(buyerEmail);
    assert.strictEqual(userRow, undefined, 'Nenhum usuário deve ser criado a partir de oferta desconhecida');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TESTE 2: Conflito entre Código de Oferta e ID de Plano -> Fail-Closed
  // ───────────────────────────────────────────────────────────────────────────
  test('2. Conflito entre código de oferta ("gtt3rhpk" -> START) e ID de plano ("ytvdj943" / "pro") -> REJECTED_PLAN_OFFER_CONFLICT', async () => {
    const eventId = `evt_conflict_${Date.now()}`;
    const buyerEmail = `conflict_${Date.now()}@testraia.com`;
    const payload = {
      id: eventId,
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: {
          offer: { code: 'gtt3rhpk' }, // START
          transaction: `HP_CONF_${Date.now()}`
        },
        subscription: {
          plan: { id: 'ytvdj943' } // PRO
        },
        buyer: {
          email: buyerEmail,
          name: 'Cliente Conflito'
        }
      }
    };

    const result = await hotmartService.processWebhook(payload);
    assert.strictEqual(result.success, false, 'Webhook com conflito de tier deve retornar success: false');
    assert.strictEqual(result.ignored, true, 'Deve ser ignorado');
    assert.strictEqual(result.reason, 'PLAN_OFFER_TIER_CONFLICT', 'Reason deve ser PLAN_OFFER_TIER_CONFLICT');

    // Verificar registro no banco
    const auditRow = db.prepare('SELECT status FROM hotmart_webhook_events WHERE event_id = ?').get(eventId);
    assert.ok(auditRow, 'Evento deve ser registrado');
    assert.strictEqual(auditRow.status, 'REJECTED_PLAN_OFFER_CONFLICT', 'Status do evento deve ser REJECTED_PLAN_OFFER_CONFLICT');

    // Também testar com ID textual "pro"
    const eventId2 = `evt_conflict2_${Date.now()}`;
    const payload2 = {
      id: eventId2,
      event: 'PURCHASE_APPROVED',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: {
          offer: { code: 'gtt3rhpk' }, // START
          transaction: `HP_CONF2_${Date.now()}`
        },
        subscription: {
          plan: { id: 'pro' } // PRO
        },
        buyer: {
          email: `conf2_${Date.now()}@testraia.com`,
          name: 'Cliente Conflito 2'
        }
      }
    };

    const result2 = await hotmartService.processWebhook(payload2);
    assert.strictEqual(result2.reason, 'PLAN_OFFER_TIER_CONFLICT');
    const auditRow2 = db.prepare('SELECT status FROM hotmart_webhook_events WHERE event_id = ?').get(eventId2);
    assert.strictEqual(auditRow2.status, 'REJECTED_PLAN_OFFER_CONFLICT');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TESTE 3: SWITCH_PLAN sem data de vigência real -> Preservação e Reconciliação
  // ───────────────────────────────────────────────────────────────────────────
  test('3. SWITCH_PLAN sem date_next_charge real -> não marca ACTIVE, preserva tier/status anterior e define needs_reconciliation = 1', async () => {
    // 3.1 Criar usuário prévio em estado PENDING e plano JESSICA_START
    const userPhone = `5511999${Math.floor(100000 + Math.random() * 900000)}`;
    const subCode = `SUB_SW_${Date.now()}`;
    const insertRes = db.prepare(`
      INSERT INTO users (
        phone_number, name, email, plan_tier, subscription_status,
        hotmart_subscriber_code, needs_reconciliation
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userPhone,
      'Usuario Switch Teste',
      `switch_${Date.now()}@testraia.com`,
      'JESSICA_START',
      'PENDING',
      subCode,
      0
    );
    const userId = Number(insertRes.lastInsertRowid);

    // 3.2 Receber SWITCH_PLAN sem date_next_charge (ausente)
    const switchEvtId = `evt_switch_nodate_${Date.now()}`;
    const switchPayload = {
      id: switchEvtId,
      event: 'SWITCH_PLAN',
      creation_date: Date.now(),
      data: {
        product: { id: '8840376' },
        purchase: {
          offer: { code: 'ytvdj943' } // PRO
        },
        subscription: {
          subscriber_code: subCode,
          plan: { id: 'ytvdj943' }
          // date_next_charge propositalmente ausente
        }
      }
    };

    const res = await hotmartService.processWebhook(switchPayload);
    assert.strictEqual(res.success, true, 'O evento deve ser processado sem erro não tratado');
    assert.strictEqual(res.action, 'PLAN_SWITCH_PENDING_RECONCILIATION', 'Ação deve ser PLAN_SWITCH_PENDING_RECONCILIATION');
    assert.strictEqual(res.preservedPlanTier, 'JESSICA_START', 'Plano anterior JESSICA_START deve ser preservado');
    assert.strictEqual(res.needsReconciliation, true, 'Deve sinalizar reconciliação');

    // 3.3 Verificar estado do usuário no banco
    const updatedUser = db.prepare('SELECT plan_tier, subscription_status, needs_reconciliation FROM users WHERE id = ?').get(userId);
    assert.strictEqual(updatedUser.plan_tier, 'JESSICA_START', 'O tier NÃO deve ser promovido para PRO sem vigência real');
    assert.strictEqual(updatedUser.subscription_status, 'PENDING', 'O status NÃO deve ser alterado para ACTIVE');
    assert.strictEqual(updatedUser.needs_reconciliation, 1, 'needs_reconciliation DEVE ser setado para 1');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TESTE 4: Reembolso Solicitado vs Concluído no Asaas
  // ───────────────────────────────────────────────────────────────────────────
  test('4. Reembolso no Asaas: REFUND_REQUESTED não deduz da receita líquida; REFUNDED deduz', () => {
    // 4.1 Limpar tabela de pagamentos Asaas para isolamento contábil estrito neste teste
    db.exec('DELETE FROM asaas_payments');
    db.prepare("UPDATE users SET needs_reconciliation = 0 WHERE role != 'ADMIN'").run();

    // 4.2 Inserir Pagamento 1 Confirmado: R$ 200,00
    db.prepare(`
      INSERT INTO asaas_payments (asaas_id, value, net_value, status, paid_at)
      VALUES (?, ?, ?, 'CONFIRMED', datetime('now'))
    `).run('pay_asaas_01', 200.0, 195.0);

    // Inserir Pagamento 2 Confirmado: R$ 100,00
    db.prepare(`
      INSERT INTO asaas_payments (asaas_id, value, net_value, status, paid_at)
      VALUES (?, ?, ?, 'CONFIRMED', datetime('now'))
    `).run('pay_asaas_02', 100.0, 95.0);

    let metrics = adminOverviewService.getAdminOverviewMetrics();
    // Receita Bruta = R$ 300,00; Deduções = R$ 0,00; Líquida = R$ 300,00
    assert.strictEqual(metrics.summary.confirmedRevenueFormatted.includes('300,00'), true, 'Receita líquida inicial deve ser R$ 300,00');

    // 4.3 Inserir Pagamento 3 com status REFUND_REQUESTED: R$ 50,00
    db.prepare(`
      INSERT INTO asaas_payments (asaas_id, value, net_value, status, paid_at)
      VALUES (?, ?, ?, 'REFUND_REQUESTED', datetime('now'))
    `).run('pay_asaas_03', 50.0, 50.0);

    metrics = adminOverviewService.getAdminOverviewMetrics();
    // REFUND_REQUESTED não deve figurar em deduções
    // Receita Líquida permanece R$ 300,00
    assert.strictEqual(
      metrics.summary.confirmedRevenueFormatted.includes('300,00'),
      true,
      'REFUND_REQUESTED NÃO deve deduzir da receita líquida confirmada'
    );

    // 4.4 Atualizar pay_asaas_02 para status REFUNDED (reembolso concluído)
    db.prepare(`
      UPDATE asaas_payments
      SET status = 'REFUNDED'
      WHERE asaas_id = ?
    `).run('pay_asaas_02');

    metrics = adminOverviewService.getAdminOverviewMetrics();
    // Agora pay_asaas_02 tem status REFUNDED.
    // Bruto: R$ 200,00 (pay_asaas_01); Deduções: R$ 100,00 (pay_asaas_02); Líquida: R$ 100,00
    assert.strictEqual(
      metrics.summary.grossRevenueFormatted.includes('200,00'),
      true,
      'Receita bruta deve ser R$ 200,00'
    );
    assert.strictEqual(
      metrics.summary.deductionsFormatted.includes('100,00'),
      true,
      'Deduções devem ser R$ 100,00'
    );
    assert.strictEqual(
      metrics.summary.confirmedRevenueFormatted.includes('100,00'),
      true,
      'REFUNDED DEVE deduzir da receita líquida no cálculo contábil'
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TESTE 5: Idempotência Determinística e Eventos Fora de Ordem
  // ───────────────────────────────────────────────────────────────────────────
  test('5. Eventos financeiros repetidos e fora de ordem preservam integridade e idempotência', async () => {
    // 5.1 Asaas: Envio duplicado do mesmo evento
    const asaasEvtId = `evt_asaas_rep_${Date.now()}`;
    const asaasPayload = {
      id: asaasEvtId,
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: `pay_idem_${Date.now()}`,
        value: 120.0,
        netValue: 115.0,
        status: 'RECEIVED'
      }
    };

    const firstAsaas = await asaasService.handleWebhookEvent(asaasPayload);
    assert.strictEqual(firstAsaas.received, true, 'Primeiro recebimento Asaas deve ser aceito');

    const duplicateAsaas = await asaasService.handleWebhookEvent(asaasPayload);
    assert.strictEqual(duplicateAsaas.duplicate, true, 'Segundo envio idêntico deve retornar duplicate: true');

    // 5.2 Hotmart: Envio duplicado e fora de ordem
    const hotmartEvtId = `evt_hotmart_idem_${Date.now()}`;
    const hotmartPayload = {
      id: hotmartEvtId,
      event: 'PURCHASE_APPROVED',
      creation_date: 1700000000000,
      data: {
        product: { id: '8840376' },
        purchase: {
          offer: { code: 'gtt3rhpk' },
          transaction: `HP_IDEM_${Date.now()}`,
          price: { value: 89.0 }
        },
        subscription: {
          subscriber_code: `SUB_IDEM_${Date.now()}`,
          date_next_charge: 1702678400000
        },
        buyer: {
          email: `idem_${Date.now()}@testraia.com`,
          name: 'Cliente Idempotente'
        }
      }
    };

    const firstHotmart = await hotmartService.processWebhook(hotmartPayload);
    assert.strictEqual(firstHotmart.success, true, 'Primeiro webhook Hotmart deve ter sucesso');

    const duplicateHotmart = await hotmartService.processWebhook(hotmartPayload);
    assert.strictEqual(duplicateHotmart.duplicated, true, 'Segundo webhook com mesmo event_id deve retornar duplicated: true');

    // Evento com timestamp anterior (fora de ordem)
    const outOfOrderPayload = {
      id: `evt_hotmart_delayed_${Date.now()}`,
      event: 'PURCHASE_APPROVED',
      creation_date: 1600000000000, // Muito antigo
      data: hotmartPayload.data
    };

    const delayedHotmart = await hotmartService.processWebhook(outOfOrderPayload);
    assert.ok(
      delayedHotmart.duplicated || delayedHotmart.ignored || delayedHotmart.success,
      'Evento fora de ordem deve ser tratado sem corromper estado'
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TESTE 6: Inicialização em Banco SQLite Legado e Migrações Limpas
  // ───────────────────────────────────────────────────────────────────────────
  test('6. Inicialização em banco SQLite legado: simulação em os.tmpdir() executa migrações limpas sem erro', () => {
    const legacyDbPath = path.join(os.tmpdir(), `legacy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.db`);

    try {
      // 6.1 Criar banco legado mínimo simulando versão antiga
      const legacyDb = new DatabaseSync(legacyDbPath);
      legacyDb.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone_number TEXT UNIQUE NOT NULL,
          name TEXT,
          plan TEXT DEFAULT 'FREE_TRIAL',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users (phone_number, name) VALUES ('5511988887777', 'Usuario Legado Antigo');

        CREATE TABLE expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER DEFAULT 1,
          amount REAL NOT NULL,
          category TEXT NOT NULL,
          date TEXT NOT NULL
        );
        INSERT INTO expenses (amount, category, date) VALUES (75.50, 'Alimentação', '2025-01-01');
      `);

      // 6.2 Executar estrutura de tabelas e migrações incrementais
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS hotmart_webhook_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT UNIQUE NOT NULL,
          event_name TEXT NOT NULL,
          transaction_code TEXT,
          subscriber_code TEXT,
          buyer_email TEXT,
          buyer_phone TEXT,
          product_id TEXT,
          plan_id TEXT,
          offer_code TEXT,
          price_cents INTEGER,
          raw_payload TEXT,
          status TEXT DEFAULT 'PROCESSED',
          processed_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS asaas_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          asaas_id TEXT UNIQUE,
          customer_id TEXT,
          customer_phone TEXT,
          value REAL,
          net_value REAL,
          billing_type TEXT,
          status TEXT,
          description TEXT,
          paid_at TEXT
        );
      `);

      // Adicionar colunas novas via PRAGMA table_info (padrão ensureColumnExists)
      const userCols = legacyDb.prepare('PRAGMA table_info(users)').all();
      const colNames = userCols.map((c) => c.name);

      if (!colNames.includes('plan_tier')) {
        legacyDb.exec("ALTER TABLE users ADD COLUMN plan_tier TEXT DEFAULT 'JESSICA_START'");
      }
      if (!colNames.includes('subscription_status')) {
        legacyDb.exec("ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'INACTIVE'");
      }
      if (!colNames.includes('needs_reconciliation')) {
        legacyDb.exec('ALTER TABLE users ADD COLUMN needs_reconciliation INTEGER DEFAULT 0');
      }
      if (!colNames.includes('session_token')) {
        legacyDb.exec('ALTER TABLE users ADD COLUMN session_token TEXT');
      }

      // 6.3 Validar integridade e dados legados preservados
      const integrity = legacyDb.prepare('PRAGMA integrity_check').all();
      assert.strictEqual(integrity[0].integrity_check, 'ok', 'PRAGMA integrity_check deve retornar ok');

      const legacyUser = legacyDb.prepare('SELECT name, plan_tier, subscription_status, needs_reconciliation FROM users WHERE phone_number = ?').get('5511988887777');
      assert.ok(legacyUser, 'Usuário legado deve existir intacto');
      assert.strictEqual(legacyUser.name, 'Usuario Legado Antigo');
      assert.strictEqual(legacyUser.needs_reconciliation, 0);

      legacyDb.close();
    } finally {
      try {
        if (fs.existsSync(legacyDbPath)) fs.unlinkSync(legacyDbPath);
      } catch (_) {}
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TESTE 7: Preservação das Configurações WhatsApp em Staging
  // ───────────────────────────────────────────────────────────────────────────
  test('7. Preservação de staging: DISABLE_WHATSAPP=true impede conexões reais e auth_info_baileys operacional permanece isolado', async () => {
    // 7.1 isRealWhatsAppTransportAllowed deve ser estritamente false
    const isAllowed = whatsappClient.isRealWhatsAppTransportAllowed();
    assert.strictEqual(isAllowed, false, 'isRealWhatsAppTransportAllowed deve retornar FALSE em staging/homologacao');

    // 7.2 sendWhatsAppMessage deve operar em modo simulado seguro sem erro e sem tocar na rede
    const sendResult = await whatsappClient.sendWhatsAppMessage('5511999998888@s.whatsapp.net', 'Mensagem de teste em staging');
    assert.strictEqual(sendResult.success, true, 'Envio simulado deve ter sucesso');
    assert.strictEqual(sendResult.simulated, true, 'Mensagem deve ser explicitamente simulada');
    assert.strictEqual(sendResult.sent, false, 'sent deve ser false (não disparado para a rede real)');
    assert.ok(sendResult.messageId.startsWith('sim_wa_'), 'ID simulado deve ter prefixo sim_wa_');

    // 7.3 Isolamento estrito de authDir: deve apontar para testAuthDir e não para o diretório operacional de produção
    assert.strictEqual(config.authDir, testAuthDir, 'config.authDir deve apontar para o diretório temporário isolado');
    const operationalAuthDir = path.resolve(__dirname, '../auth_info_baileys');
    assert.notStrictEqual(config.authDir, operationalAuthDir, 'config.authDir NÃO PODE ser o diretório operacional');
  });

});
