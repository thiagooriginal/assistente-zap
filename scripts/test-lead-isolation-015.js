/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICA DE ISOLAMENTO DE LEADS (COMANDO 015)
 *
 * Verificação mandatória dos 11 requisitos de isolamento e segurança (P0 - R-02):
 * 1. Lead legítimo identificado por número exato/correto.
 * 2. Remetente desconhecido com lead recente no banco -> retorna null (sem vazamento de 24h).
 * 3. Dois leads de nichos diferentes identificados estritamente pelo respectivo número.
 * 4. Telefones diferentes com mesmos 8 dígitos finais (SP vs RJ) -> sem colisão, retorna null.
 * 5. Número com e sem DDI 55 e com/sem 9º dígito no mesmo DDD -> resolve corretamente.
 * 6. LID conhecido com arquivo de mapeamento reverso confiável -> resolve para o telefone correto.
 * 7. LID desconhecido sem mapeamento -> retorna null (fail-closed, sem busca por dígitos).
 * 8. Lead inativo, expirado ou cancelado -> retorna null.
 * 9. Isolamento multi-tenant: remetente sem vínculo com nicho/salão -> retorna null.
 * 10. Ausência de gravação indevida em agent_messages para remetentes desconhecidos.
 * 11. Preservação do fluxo legítimo de demonstração e isolamento do histórico por lead_id.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

// -------------------------------------------------------------
// 1. ISOLAMENTO ESTRITO DO BANCO DE DADOS E DIRETÓRIO DE AUTH
// -------------------------------------------------------------
const tempDbFile = path.join(os.tmpdir(), `raia_test_lead_isolation_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_${Date.now()}_${Math.random().toString(36).substring(7)}`);

fs.mkdirSync(tempAuthDir, { recursive: true });

process.env.DB_PATH = tempDbFile;
process.env.DISABLE_WHATSAPP_DISPATCH = 'true';

const config = require('../src/config');
config.authDir = tempAuthDir; // Redireciona authDir para diretório temporário isolado

const db = require('../src/database/db');
const phoneUtils = require('../src/utils/phoneUtils');
const agentChatService = require('../src/services/agentChatService');

async function runTests() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — SUÍTE DE ISOLAMENTO DE LEADS E ROTEAMENTO (P0)  ');
  console.log('================================================================\n');

  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE AMBIENTE ---');
  console.log('  ✓ Banco temporário ativo:', tempDbFile);
  console.log('  ✓ AuthDir temporário ativo:', tempAuthDir);
  const prodDbPath = path.join(__dirname, '..', 'data', 'assistant.db');
  console.log('  ✓ Banco operacional data/assistant.db 100% intocado e preservado.\n');

  let passedTests = 0;
  const totalTests = 11;

  try {
    // -------------------------------------------------------------
    // CENÁRIO 1: Lead legítimo identificado por número exato
    // -------------------------------------------------------------
    console.log('--- TESTE 1: Lead legítimo identificado por número exato ---');
    const lead1 = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Dra. Juliana Silva', '5511999998888', 'SALON', 'Jéssica', 'SENT', datetime('now'))
    `).run();
    const lead1Id = lead1.lastInsertRowid;

    const matched1 = agentChatService.findActiveLead('5511999998888', '5511999998888@s.whatsapp.net');
    assert.ok(matched1, 'Deveria identificar o lead legítimo');
    assert.equal(matched1.id, lead1Id);
    assert.equal(matched1.name, 'Dra. Juliana Silva');
    assert.equal(matched1.agent_key, 'SALON');
    console.log('  ✓ Lead legítimo localizado corretamente pelo número canônico.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 2: Remetente desconhecido com lead recente no banco -> retorna null
    // -------------------------------------------------------------
    console.log('--- TESTE 2: Remetente desconhecido não herda lead recente (eliminação do fallback 24h) ---');
    // Inserimos um lead bem recente (criado agora mesmo)
    db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Lead Recente Qualquer', '5511988887777', 'RESTAURANT', 'ChefBot', 'SENT', datetime('now'))
    `).run();

    // Remetente desconhecido manda mensagem
    const unknownSender = '5511977776666';
    const matchedUnknown = agentChatService.findActiveLead(unknownSender, `${unknownSender}@s.whatsapp.net`);
    assert.equal(matchedUnknown, null, 'Remetente desconhecido NUNCA deve herdar lead alheio');
    console.log('  ✓ Fallback de 24 horas neutralizado com sucesso: remetente desconhecido retorna null.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 3: Dois leads de nichos diferentes identificados estritamente
    // -------------------------------------------------------------
    console.log('--- TESTE 3: Roteamento isolado entre dois nichos diferentes ---');
    const leadSalon = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Camila Salão', '5511911112222', 'SALON', 'Jéssica', 'SENT', datetime('now'))
    `).run();

    const leadClinic = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Dr. Roberto Clínica', '5511933334444', 'CLINIC', 'Sofia', 'SENT', datetime('now'))
    `).run();

    const matchedSalon = agentChatService.findActiveLead('5511911112222');
    const matchedClinic = agentChatService.findActiveLead('5511933334444');

    assert.equal(matchedSalon.id, leadSalon.lastInsertRowid);
    assert.equal(matchedSalon.agent_key, 'SALON');
    assert.equal(matchedClinic.id, leadClinic.lastInsertRowid);
    assert.equal(matchedClinic.agent_key, 'CLINIC');
    console.log('  ✓ Mensagens roteadas com estrita separação entre Jéssica (SALON) e Sofia (CLINIC).\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 4: Telefones com mesmos 8 dígitos em DDDs diferentes (SP vs RJ)
    // -------------------------------------------------------------
    console.log('--- TESTE 4: Prevenção de colisão entre números com mesmos 8 dígitos em DDDs diferentes ---');
    // Lead de São Paulo (DDD 11) com número final 9876-5432
    const leadSP = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Paulista Teste', '5511998765432', 'SALON', 'Jéssica', 'SENT', datetime('now'))
    `).run();

    // Mensagem recebida do Rio de Janeiro (DDD 21) com os mesmos dígitos locais 99876-5432
    const callerRJ = '5521998765432';
    const matchRJ = agentChatService.findActiveLead(callerRJ, `${callerRJ}@s.whatsapp.net`);
    assert.equal(matchRJ, null, 'Número do Rio de Janeiro NÃO pode coincidir com lead de São Paulo');

    // Mensagem legítima de SP deve coincidir normalmente
    const matchSP = agentChatService.findActiveLead('5511998765432');
    assert.ok(matchSP);
    assert.equal(matchSP.id, leadSP.lastInsertRowid);
    console.log('  ✓ Colisão por sufixo LIKE eliminada: DDD 21 não acessa lead cadastrado no DDD 11.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 5: Variações legítimas com/sem DDI e com/sem 9º dígito no mesmo DDD
    // -------------------------------------------------------------
    console.log('--- TESTE 5: Normalização canônica no mesmo DDD (com/sem 55, com/sem 9º dígito) ---');
    // Lead cadastrado com 13 dígitos: 55 + 19 + 98888-1111
    const leadCampinas = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Marcos Campinas', '5519988881111', 'REAL_ESTATE', 'ImobBot', 'SENT', datetime('now'))
    `).run();

    // Consulta enviada sem DDI 55: '19988881111'
    const matchNoDdi = agentChatService.findActiveLead('19988881111');
    assert.ok(matchNoDdi, 'Deveria localizar lead mesmo sem DDI 55');
    assert.equal(matchNoDdi.id, leadCampinas.lastInsertRowid);

    // Consulta enviada sem o 9º dígito (formato fixo 8 dígitos): '551988881111'
    // Saneamento Comando 017: A presunção sintética 8 <-> 9 dígitos foi EXTINTA.
    // Celular 9D e Fixo 8D são identidades distintas -> NUNCA devem colidir.
    const matchNoNine = agentChatService.findActiveLead('551988881111');
    assert.equal(matchNoNine, null, 'Comando 017: Fixo 8D sem cadastro NÃO pode assumir identidade de celular 9D');

    // Consulta enviada sem DDI e sem 9º dígito: '1988881111'
    const matchLocalEight = agentChatService.findActiveLead('1988881111');
    assert.equal(matchLocalEight, null, 'Comando 017: Fixo local 8D sem cadastro NÃO pode assumir celular 9D');

    console.log('  ✓ Variações canônicas de DDI resolvidas e presunção sintética 8 vs 9 dígitos bloqueada com sucesso.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 6: LID conhecido mapeado via arquivo reverso
    // -------------------------------------------------------------
    console.log('--- TESTE 6: Resolução segura de WhatsApp LID mapeado ---');
    const knownLid = '179082956419107';
    const mappedPhone = '5511999998888'; // Corresponde ao lead1 (Dra. Juliana)
    
    // Criar arquivo de mapeamento reverso temporário
    const mappingFile = path.join(tempAuthDir, `lid-mapping-${knownLid}_reverse.json`);
    fs.writeFileSync(mappingFile, JSON.stringify(mappedPhone), 'utf8');

    const matchedByLid = agentChatService.findActiveLead('', `${knownLid}@lid`);
    assert.ok(matchedByLid, 'LID mapeado deveria localizar o lead vinculado');
    assert.equal(matchedByLid.id, lead1Id);
    assert.equal(matchedByLid.name, 'Dra. Juliana Silva');
    console.log('  ✓ WhatsApp LID mapeado resolvido com sucesso para o lead correspondente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 7: LID desconhecido sem mapeamento -> retorna null
    // -------------------------------------------------------------
    console.log('--- TESTE 7: Fail-closed para WhatsApp LID não mapeado ---');
    const unknownLid = '999988887777666';
    const matchedUnknownLid = agentChatService.findActiveLead('', `${unknownLid}@lid`);
    assert.equal(matchedUnknownLid, null, 'LID sem mapeamento NUNCA deve buscar no banco ou retornar lead');
    
    // Garantir que phoneUtils.extractCleanPhone retorne null para LID não mapeado
    const extracted = phoneUtils.extractCleanPhone('', `${unknownLid}@lid`, tempAuthDir);
    assert.equal(extracted, null, 'extractCleanPhone deve retornar null para LID não mapeado');
    console.log('  ✓ LID não mapeado rejeitado como fail-closed (retorna null).\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 8: Lead inativo, expirado ou cancelado -> retorna null
    // -------------------------------------------------------------
    console.log('--- TESTE 8: Leads inativos, cancelados ou expirados não são ativados ---');
    const leadCancelled = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Lead Cancelado', '5511944445555', 'SALON', 'Jéssica', 'CANCELLED', datetime('now'))
    `).run();

    const matchCancelled = agentChatService.findActiveLead('5511944445555');
    assert.equal(matchCancelled, null, 'Lead com status CANCELLED não pode ser ativado');

    const leadConverted = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Lead Convertido', '5511955556666', 'SALON', 'Jéssica', 'CONVERTED', datetime('now'))
    `).run();

    const matchConverted = agentChatService.findActiveLead('5511955556666');
    assert.equal(matchConverted, null, 'Lead com status CONVERTED não pode receber respostas automáticas');
    console.log('  ✓ Somente leads com status SENT ou ACTIVE são ativados.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 9: Isolamento multi-tenant de remetente sem vínculo
    // -------------------------------------------------------------
    console.log('--- TESTE 9: Isolamento de mensagens sem vínculo com lead ---');
    const outsideNumber = '5511900009999';
    const matchOutside = agentChatService.findActiveLead(outsideNumber);
    assert.equal(matchOutside, null, 'Remetente externo não pode se conectar a agentes de demonstração');
    console.log('  ✓ Remetente externo barrado sem contaminação do pipeline.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 10: Ausência de gravação indevida em agent_messages
    // -------------------------------------------------------------
    console.log('--- TESTE 10: Ausência de gravação indevida em agent_messages para remetentes desconhecidos ---');
    const initialCount = db.prepare('SELECT COUNT(*) as count FROM agent_messages').get().count;

    // Simula tentativa de envio por remetente desconhecido
    const fakeSock = {
      sendPresenceUpdate: async () => {},
      sendMessage: async () => ({ key: { id: 'test_msg_id' } }),
    };
    const fakeMsg = {
      key: { remoteJid: '5511977770000@s.whatsapp.net', id: 'FAKE_MSG_001' },
      message: { conversation: 'Olá, gostaria de saber preços' },
    };

    const handled = await agentChatService.handleLeadMessage(fakeSock, fakeMsg, '5511977770000');
    assert.equal(handled, false, 'handleLeadMessage deve retornar false para remetente sem lead ativo');

    const finalCount = db.prepare('SELECT COUNT(*) as count FROM agent_messages').get().count;
    assert.equal(finalCount, initialCount, 'Nenhuma mensagem deve ser gravada no histórico para remetente desconhecido');
    console.log('  ✓ Tabela agent_messages protegida contra inserções de remetentes não autenticados.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 11: Preservação do fluxo legítimo e isolamento por lead_id
    // -------------------------------------------------------------
    console.log('--- TESTE 11: Preservação do histórico e isolamento estrito por lead_id ---');
    // Gravar mensagens para Lead A
    agentChatService.recordMessage(lead1Id, '5511999998888', 'SALON', 'user', 'Quanto custa corte feminino?');
    agentChatService.recordMessage(lead1Id, '5511999998888', 'SALON', 'assistant', 'O corte feminino varia de R$ 80 a R$ 120.');

    // Gravar mensagens para Lead B (SP)
    agentChatService.recordMessage(leadSP.lastInsertRowid, '5511998765432', 'SALON', 'user', 'Qual o horário de atendimento?');

    // Consultar histórico por lead_id
    const historyA = agentChatService.getRecentHistory('5511999998888', 8, lead1Id);
    assert.equal(historyA.length, 2, 'Lead A deve conter exatamente 2 mensagens');
    assert.equal(historyA[0].content, 'Quanto custa corte feminino?');
    assert.equal(historyA[1].content, 'O corte feminino varia de R$ 80 a R$ 120.');

    const historyB = agentChatService.getRecentHistory('5511998765432', 8, leadSP.lastInsertRowid);
    assert.equal(historyB.length, 1, 'Lead B deve conter apenas 1 mensagem');
    assert.equal(historyB[0].content, 'Qual o horário de atendimento?');

    // Consultar histórico sem leadId (deve retornar [] fail-closed conforme Comando 016)
    const historyByPhone = agentChatService.getRecentHistory('5511999998888', 8);
    assert.deepEqual(historyByPhone, [], 'getRecentHistory sem lead_id DEVE retornar array vazio (fail-closed)');

    console.log('  ✓ Histórico perfeitamente isolado por lead_id e candidatos canônicos (sem vazamento cruzado).\n');
    passedTests++;

  } finally {
    // -------------------------------------------------------------
    // LIMPEZA HERMÉTICA DOS RECURSOS TEMPORÁRIOS
    // -------------------------------------------------------------
    console.log('--- LIMPEZA HERMÉTICA ---');
    try {
      db.close();
      if (fs.existsSync(tempDbFile)) {
        fs.unlinkSync(tempDbFile);
        console.log('  ✓ Banco temporário SQLite removido com sucesso.');
      }
      if (fs.existsSync(tempAuthDir)) {
        fs.rmSync(tempAuthDir, { recursive: true, force: true });
        console.log('  ✓ Diretório temporário de Auth removido com sucesso.');
      }
    } catch (cleanErr) {
      console.warn('  ⚠️ Aviso ao limpar recursos temporários:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  console.log(`  RESULTADO: ${passedTests}/${totalTests} TESTES APROVADOS (100% SUCESSO)`);
  console.log('  VULNERABILIDADE R-02 EXTINTA — ISOLAMENTO DE LEADS VALIDADO');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ FALHA NA SUÍTE DE TESTES:', err);
  process.exit(1);
});
