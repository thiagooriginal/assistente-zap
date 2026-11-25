/**
 * Testes Herméticos de Vendas Diretas e Auditoria de Preços - COMANDO 073 Fase 2
 *
 * Validações:
 * 1. public/planos.html contém os 3 planos comerciais oficiais com valores e ofertas corretas.
 * 2. public/solucoes/saloes-e-beleza.html atualizado para R$ 89,00.
 * 3. public/index.html atualizado para R$ 89,00 no nicho de salões e preservando outras soluções.
 * 4. hotmartService resolve perfeitamente as três ofertas com valores e tiers oficiais.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Isolamento hermético de banco temporário
const tempDbPath = path.join(os.tmpdir(), `test_cmd073_fase2_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.db`);
process.env.DB_PATH = tempDbPath;
process.env.NODE_ENV = 'test';
process.env.HOMOLOGACAO = 'true';
process.env.APP_MODE = 'staging';

const hotmartService = require('../src/services/hotmartService');
const db = require('../src/database/db');

describe('COMANDO 073 — FASE 2: Vendas Diretas pelo Site e Preços Jéssica', () => {
  after(() => {
    try {
      db.close();
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    } catch (_) {}
  });

  test('1. public/planos.html deve conter os 3 cards completos com preços e códigos de oferta corretos', () => {
    const planosPath = path.resolve(__dirname, '../public/planos.html');
    const content = fs.readFileSync(planosPath, 'utf8');

    // Jéssica Start
    assert.match(content, /Jéssica Start/i);
    assert.match(content, /R\$\s*89/);
    assert.match(content, /gtt3rhpk/);

    // Jéssica Intermediário
    assert.match(content, /Jéssica Intermediário/i);
    assert.match(content, /R\$\s*109/);
    assert.match(content, /1x8ik7i3/);

    // Jéssica Pro
    assert.match(content, /Jéssica Pro/i);
    assert.match(content, /R\$\s*139/);
    assert.match(content, /ytvdj943/);

    // Sem links de checkout inventados que quebram em erro 005
    assert.doesNotMatch(content, /off=jessica_start/);
    assert.doesNotMatch(content, /off=jessica_pro/);
  });

  test('2. public/solucoes/saloes-e-beleza.html não deve ter preços de R$ 59 para a Jéssica', () => {
    const salaoPath = path.resolve(__dirname, '../public/solucoes/saloes-e-beleza.html');
    const content = fs.readFileSync(salaoPath, 'utf8');

    assert.doesNotMatch(content, /R\$\s*59,00/);
    assert.match(content, /R\$\s*89,00/);
  });

  test('3. public/index.html deve referenciar R$ 89 para Salões & Beleza preservando outras ofertas', () => {
    const indexPath = path.resolve(__dirname, '../public/index.html');
    const content = fs.readFileSync(indexPath, 'utf8');

    // Nicho Salões de Beleza
    assert.match(content, /A partir de R\$ 89,00<\/span>[\s\S]*?\/solucoes\/saloes-e-beleza/);

    // Outros nichos devem manter ofertas existentes
    assert.match(content, /A partir de R\$ 59,00<\/span>[\s\S]*?\/solucoes\/saude-e-odontologia/);
  });

  test('4. hotmartService deve mapear as três ofertas oficiais da Hotmart para os tiers corretos', () => {
    const tierStart = hotmartService.resolvePlanTier({ purchase: { offer: { code: 'gtt3rhpk' } } });
    assert.equal(tierStart, 'JESSICA_START');

    const tierIntermediate = hotmartService.resolvePlanTier({ purchase: { offer: { code: '1x8ik7i3' } } });
    assert.equal(tierIntermediate, 'JESSICA_INTERMEDIATE');

    const tierPro = hotmartService.resolvePlanTier({ purchase: { offer: { code: 'ytvdj943' } } });
    assert.equal(tierPro, 'JESSICA_PRO');

    const status = hotmartService.getIntegrationStatus();
    assert.equal(status.offerCodes.start, 'gtt3rhpk');
    assert.equal(status.offerCodes.intermediate, '1x8ik7i3');
    assert.equal(status.offerCodes.pro, 'ytvdj943');

    const startPlan = status.planMapping.find(p => p.tier === 'JESSICA_START');
    const interPlan = status.planMapping.find(p => p.tier === 'JESSICA_INTERMEDIATE');
    const proPlan = status.planMapping.find(p => p.tier === 'JESSICA_PRO');

    assert.equal(startPlan.price, 89.0);
    assert.equal(interPlan.price, 109.0);
    assert.equal(proPlan.price, 139.0);
  });
});
