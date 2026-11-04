/**
 * RAIA AGENTES — Reconciliação dos Commits da Main & Teste de Regressão Comercial
 * 
 * Valida formalmente a incorporação e harmonia dos 3 commits recentes da branch main:
 * - 1dcc615: fix(agent): remover envio de fotos/imagens no agente de salão (Jéssica)
 * - 806b138: fix(pricing): atualizar valor comercial para a partir de R$ 59,00
 * - b0c129b: chore: atualizar comentários de seção de preços para R$ 59
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('================================================================');
console.log('   RAIA AGENTES — SUITE: RECONCILIAÇÃO DE COMMITS DA MAIN (3/3)  ');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function test(description, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] ${totalTests}. ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalTests}. ${description}:`, err.message);
  }
}

// -------------------------------------------------------------
// Test 1: Commit 1dcc615 — NICHE_PHOTOS em agentChatService
// -------------------------------------------------------------
test('Commit 1dcc615: Remoção estrita de fotos/imagens do salão em agentChatService', () => {
  const filePath = path.resolve(__dirname, '../src/services/agentChatService.js');
  const content = fs.readFileSync(filePath, 'utf8');

  // Must NOT contain SALON photos in NICHE_PHOTOS
  assert.ok(!content.includes('SALON: ['), 'NICHE_PHOTOS não deve conter chave SALON');
  assert.ok(!content.includes('Corte Feminino em Camadas & Escova'), 'Fotos de corte feminino devem estar ausentes');
  assert.ok(!content.includes('Corte Masculino Degradê / Fade'), 'Fotos de corte masculino devem estar ausentes');

  // Must contain directive instructing text and audio only
  assert.ok(
    content.includes('ATENDIMENTO POR TEXTO E ÁUDIO: Não envie fotos ou imagens de cabelos ou procedimentos'),
    'Prompt de Jéssica deve proibir envio de fotos de cabelos ou procedimentos'
  );
});

// -------------------------------------------------------------
// Test 2: Commit 806b138 — Preço "A partir de R$ 59,00" na Landing Page Principal
// -------------------------------------------------------------
test('Commit 806b138: Preço comercial atualizado para "A partir de R$ 59,00" em public/index.html', () => {
  const indexPath = path.resolve(__dirname, '../public/index.html');
  const indexContent = fs.readFileSync(indexPath, 'utf8');

  // Verify that old "R$ 39/mês" or "R$ 39" are completely absent from pricing cards
  assert.ok(!indexContent.includes('R$ 39/mês'), 'Não deve conter "R$ 39/mês" em public/index.html');
  assert.ok(!indexContent.includes('R$ 39,00'), 'Não deve conter "R$ 39,00" em public/index.html');

  // Verify that "A partir de R$ 59,00" is present
  const matches = (indexContent.match(/A partir de R\$ 59,00/g) || []).length;
  assert.ok(matches >= 10, `Deve conter ao menos 10 ocorrências de "A partir de R$ 59,00" (encontradas: ${matches})`);
});

// -------------------------------------------------------------
// Test 3: Commit 806b138 — Preço "A partir de R$ 59,00" em todas as 10 Soluções
// -------------------------------------------------------------
test('Commit 806b138: Preço comercial atualizado em todas as 10 páginas de nicho (public/solucoes/*.html)', () => {
  const solutionsDir = path.resolve(__dirname, '../public/solucoes');
  const files = fs.readdirSync(solutionsDir).filter(f => f.endsWith('.html'));

  assert.strictEqual(files.length, 10, 'Devem existir exatamente 10 páginas de soluções');

  for (const file of files) {
    const fullPath = path.join(solutionsDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');

    // Must not have R$ 39
    assert.ok(!content.includes('R$ 39/mês'), `${file} não deve conter "R$ 39/mês"`);
    assert.ok(!content.includes('R$ 39,00'), `${file} não deve conter "R$ 39,00"`);

    // Must have R$ 59
    assert.ok(
      content.includes('A partir de R$ 59,00') || content.includes('R$ 59,00'),
      `${file} deve conter "A partir de R$ 59,00" ou "R$ 59,00"`
    );
  }
});

// -------------------------------------------------------------
// Test 4: Commit b0c129b — Comentários de Seção Atualizados para R$ 59
// -------------------------------------------------------------
test('Commit b0c129b: Comentários HTML de seção de preços atualizados para "A partir de R$ 59"', () => {
  const solutionsDir = path.resolve(__dirname, '../public/solucoes');
  const files = fs.readdirSync(solutionsDir).filter(f => f.endsWith('.html'));

  for (const file of files) {
    const fullPath = path.join(solutionsDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');

    assert.ok(
      content.includes('SECTION: PREÇO & OFERTA TRANSPARENTE (A partir de R$ 59)'),
      `${file} deve conter o comentário de seção atualizado com R$ 59`
    );
    assert.ok(
      !content.includes('SECTION: PREÇO & OFERTA TRANSPARENTE (A partir de R$ 39)'),
      `${file} não deve conter o comentário antigo de R$ 39`
    );
  }
});

// -------------------------------------------------------------
// Test 5: Reconciliação Funcional — Catálogo e Planos em db.js Preservados
// -------------------------------------------------------------
test('Reconciliação Funcional: Catálogo de produtos e planos permanece íntegro e sem regressão', () => {
  const dbPath = path.resolve(__dirname, '../src/database/db.js');
  const dbContent = fs.readFileSync(dbPath, 'utf8');

  assert.ok(dbContent.includes("name: 'Jéssica Entrada'"), 'Plano Jéssica Entrada preservado');
  assert.ok(dbContent.includes("name: 'Jéssica Intermediário'"), 'Plano Jéssica Intermediário preservado');
  assert.ok(dbContent.includes("name: 'Jéssica Pró'"), 'Plano Jéssica Pró preservado');
  assert.ok(dbContent.includes('JARVIS_FINANCEIRO'), 'Produto Jarvis Financeiro preservado');
  assert.ok(dbContent.includes('ASSISTENTE_CLINICA'), 'Produto Dra. Camila Clínica preservado');
});

console.log('\n----------------------------------------------------------------');
console.log(`RESULTADO FINAL: ${passedTests}/${totalTests} testes de reconciliação passaram.`);
console.log('----------------------------------------------------------------\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
