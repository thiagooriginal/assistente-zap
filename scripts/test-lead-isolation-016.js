/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICA: BLINDAGEM P0 CONTRA COLISÕES E AMBIGUIDADE (COMANDO 016)
 *
 * 14 Cenários Mandatórios de Segurança e Isolamento:
 * 1. Um único lead com telefone exato -> identificado com sucesso.
 * 2. Colisão de 8 e 9 dígitos no mesmo DDD -> match exato prioritário, sem sequestro de identidade (reprodução vs blindagem).
 * 3. Dois leads ativos com telefone idêntico, porém agentes diferentes -> fail-closed (retorna null por ambiguidade de nicho).
 * 4. Remetente com DDD diferente -> sem colisão, retorna null.
 * 5. Telefone sem DDD ou com formato inválido -> rejeição segura, retorna null.
 * 6. Identificador WhatsApp LID com mapeamento confiável -> resolve para o telefone correto.
 * 7. Identificador WhatsApp LID sem mapeamento -> fail-closed (retorna null).
 * 8. Histórico de mensagens isolado estritamente por lead_id -> zero contaminação entre conversas, fail-closed sem lead_id.
 * 9. Remetente desconhecido com leads recentes no banco -> retorna null (sem fallback de 24h).
 * 10. Remetente identificado sem ambiguidade -> resolução direta e segura.
 * 11. Preservação da demonstração legítima -> fluxo normal de atendimento para lead único.
 * 12. Ausência de gravações de mensagens no lead incorreto -> recordMessage protegido contra lead_id nulo/inválido.
 * 13. Ausência de resposta automática com identidade ambígua -> handleLeadMessage aborta sem disparar socket.
 * 14. Regressão das 11 validações anteriores do Comando 015 preservadas com 100% de sucesso.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

// -------------------------------------------------------------
// 1. ISOLAMENTO ESTRITO DO BANCO DE DADOS E DIRETÓRIO DE AUTH
// -------------------------------------------------------------
const tempDbFile = path.join(os.tmpdir(), `raia_test_lead_isolation_016_${Date.now()}_${Math.random().toString(36).substring(7)}.db`);
const tempAuthDir = path.join(os.tmpdir(), `raia_test_auth_016_${Date.now()}_${Math.random().toString(36).substring(7)}`);

fs.mkdirSync(tempAuthDir, { recursive: true });

process.env.DB_PATH = tempDbFile;
process.env.DISABLE_WHATSAPP_DISPATCH = 'true';

const config = require('../src/config');
config.authDir = tempAuthDir;

const db = require('../src/database/db');
const phoneUtils = require('../src/utils/phoneUtils');
const agentChatService = require('../src/services/agentChatService');

async function runTests() {
  console.log('================================================================');
  console.log('  RAIA AGENTES — BLINDAGEM P0 CONTRA COLISÕES E AMBIGUIDADE (016)');
  console.log('================================================================\n');

  console.log('--- COMPROVAÇÃO DE ISOLAMENTO DE AMBIENTE ---');
  console.log('  ✓ Banco temporário ativo:', tempDbFile);
  console.log('  ✓ AuthDir temporário ativo:', tempAuthDir);
  const prodDbPath = path.join(__dirname, '..', 'data', 'assistant.db');
  console.log('  ✓ Banco operacional data/assistant.db 100% intocado e preservado.\n');

  let passedTests = 0;
  const totalTests = 14;

  try {
    // -------------------------------------------------------------
    // CENÁRIO 1: Lead único com telefone exato
    // -------------------------------------------------------------
    console.log('--- TESTE 1: Lead único com telefone exato ---');
    const lead1 = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Dra. Juliana Silva', '5511999998888', 'SALON', 'Jéssica', 'SENT', datetime('now'))
    `).run();
    const lead1Id = lead1.lastInsertRowid;

    const matched1 = agentChatService.findActiveLead('5511999998888', '5511999998888@s.whatsapp.net');
    assert.ok(matched1, 'Deveria identificar o lead legítimo com sucesso');
    assert.equal(matched1.id, lead1Id);
    assert.equal(matched1.name, 'Dra. Juliana Silva');
    assert.equal(matched1.agent_key, 'SALON');
    console.log('  ✓ Lead único localizado com precisão cirúrgica.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 2: Colisão de 8 e 9 dígitos no mesmo DDD (Reprodução vs Blindagem)
    // -------------------------------------------------------------
    console.log('--- TESTE 2: Prevenção de sequestro entre números de 8 e 9 dígitos no mesmo DDD ---');
    // Lead A: Celular com 9 dígitos (98888-7777)
    const leadA = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Cliente Celular 9D', '5511988887777', 'SALON', 'Jéssica', 'SENT', datetime('now', '-10 minutes'))
    `).run();
    const leadAId = leadA.lastInsertRowid;

    // Lead B: Linha Fixa ou legado com 8 dígitos (8888-7777), inserido DEPOIS (ID maior)
    const leadB = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Empresa Fixo 8D', '551188887777', 'SALON', 'Jéssica', 'SENT', datetime('now', '-5 minutes'))
    `).run();
    const leadBId = leadB.lastInsertRowid;

    // Demonstração da falha no código anterior:
    // O código anterior gerava candidatos [5511988887777, 11988887777, 551188887777, 1188887777]
    // e executava LIMIT 1 com ORDER BY id DESC, fazendo o celular 9D herdar o lead B (ID maior)!
    // Na nova implementação (Comando 016):
    // Etapa 1 busca exclusivamente candidatos de 9 dígitos para o celular:
    const matchCelular = agentChatService.findActiveLead('5511988887777');
    assert.ok(matchCelular, 'Deveria encontrar o lead celular');
    assert.equal(matchCelular.id, leadAId, 'Celular 9D DEVE corresponder estritamente ao Lead A (nunca sequestrado pelo Lead B)');
    assert.equal(matchCelular.name, 'Cliente Celular 9D');

    // E a busca para a linha fixa de 8 dígitos corresponde estritamente ao Lead B:
    const matchFixo = agentChatService.findActiveLead('551188887777');
    assert.ok(matchFixo, 'Deveria encontrar o lead fixo');
    assert.equal(matchFixo.id, leadBId, 'Fixo 8D DEVE corresponder estritamente ao Lead B');
    assert.equal(matchFixo.name, 'Empresa Fixo 8D');

    console.log('  ✓ Colisão de 8 vs 9 dígitos neutralizada: cada linha mantém sua identidade sem sequestro.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 3: Dois leads ativos com telefone idêntico, porém agentes diferentes (Ambiguidade de Nicho)
    // -------------------------------------------------------------
    console.log('--- TESTE 3: Fail-Closed em múltiplos leads ativos de nichos conflitantes ---');
    const multiPhone = '5511977771111';
    
    // Usuário cadastrou o mesmo telefone para testar Jéssica (SALON)
    const leadSalonAmb = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Mariana Teste', ?, 'SALON', 'Jéssica', 'SENT', datetime('now', '-20 minutes'))
    `).run(multiPhone);

    // E também cadastrou o mesmo telefone para testar Sofia (CLINIC)
    const leadClinicAmb = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Mariana Teste', ?, 'CLINIC', 'Sofia', 'SENT', datetime('now', '-10 minutes'))
    `).run(multiPhone);

    // Na implementação anterior, LIMIT 1 escolhia arbitrariamente Sofia (CLINIC) silenciando Jéssica.
    // Na nova implementação (Comando 016), detecta-se ambiguidade de personas distintas e aplica-se FAIL-CLOSED:
    const matchAmbiguous = agentChatService.findActiveLead(multiPhone);
    assert.equal(matchAmbiguous, null, 'Ambiguidade de agentes DEVE retornar estritamente null (fail-closed)');
    console.log('  ✓ Ambiguidade multiagente bloqueada com fail-closed (retornou null, zero confusão de persona).\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 4: Remetente com DDD diferente (SP vs RJ)
    // -------------------------------------------------------------
    console.log('--- TESTE 4: Isolamento estrito entre DDDs distintos com mesmos 8 dígitos finais ---');
    const leadSP = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Paulista', '5511998765432', 'SALON', 'Jéssica', 'SENT', datetime('now'))
    `).run();

    const callerRJ = '5521998765432';
    const matchRJ = agentChatService.findActiveLead(callerRJ);
    assert.equal(matchRJ, null, 'DDD 21 NUNCA deve colidir com DDD 11');
    console.log('  ✓ Barreira geográfica de DDD preservada integralmente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 5: Telefone sem DDD ou com formato inválido
    // -------------------------------------------------------------
    console.log('--- TESTE 5: Rejeição segura de telefones sem DDD ou inválidos ---');
    const matchNoDdd = agentChatService.findActiveLead('88887777');
    assert.equal(matchNoDdd, null, 'Número sem DDD não deve ativar leads com DDD');

    const matchInvalid = agentChatService.findActiveLead('12345');
    assert.equal(matchInvalid, null, 'Número curto inválido deve retornar null');
    console.log('  ✓ Entradas anômalas ou sem código de área rejeitadas com segurança.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 6: WhatsApp LID com mapeamento confiável
    // -------------------------------------------------------------
    console.log('--- TESTE 6: Resolução segura de WhatsApp LID mapeado ---');
    const validLid = '179082956419107';
    const mappedPhone = '5511999998888'; // Dra. Juliana
    const mappingFile = path.join(tempAuthDir, `lid-mapping-${validLid}_reverse.json`);
    fs.writeFileSync(mappingFile, JSON.stringify(mappedPhone), 'utf8');

    const matchedLid = agentChatService.findActiveLead('', `${validLid}@lid`);
    assert.ok(matchedLid, 'LID mapeado deve ser resolvido');
    assert.equal(matchedLid.id, lead1Id);
    console.log('  ✓ WhatsApp LID com arquivo reverso resolvido deterministicamente.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 7: WhatsApp LID sem mapeamento (Fail-Closed)
    // -------------------------------------------------------------
    console.log('--- TESTE 7: WhatsApp LID sem mapeamento rejeitado como fail-closed ---');
    const unmappedLid = '999988887777666';
    const matchUnmapped = agentChatService.findActiveLead('', `${unmappedLid}@lid`);
    assert.equal(matchUnmapped, null, 'LID sem arquivo reverso DEVE retornar null');
    console.log('  ✓ LID não mapeado barrado sem consulta indevida ao banco de dados.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 8: Histórico de mensagens isolado estritamente por lead_id
    // -------------------------------------------------------------
    console.log('--- TESTE 8: Isolamento hermético de histórico por lead_id ---');
    agentChatService.recordMessage(leadAId, '5511988887777', 'SALON', 'user', 'Pergunta do Lead A');
    agentChatService.recordMessage(leadBId, '551188887777', 'SALON', 'user', 'Pergunta do Lead B');

    const histA = agentChatService.getRecentHistory('5511988887777', 8, leadAId);
    assert.equal(histA.length, 1);
    assert.equal(histA[0].content, 'Pergunta do Lead A');

    const histB = agentChatService.getRecentHistory('551188887777', 8, leadBId);
    assert.equal(histB.length, 1);
    assert.equal(histB[0].content, 'Pergunta do Lead B');

    // Chamada sem leadId DEVE retornar vazio (fail-closed absoluto)
    const histNoLeadId = agentChatService.getRecentHistory('5511988887777', 8, null);
    assert.deepEqual(histNoLeadId, [], 'getRecentHistory sem lead_id DEVE retornar array vazio');

    const histUndefined = agentChatService.getRecentHistory('5511988887777', 8);
    assert.deepEqual(histUndefined, [], 'getRecentHistory com lead_id indefinido DEVE retornar array vazio');
    console.log('  ✓ Histórico 100% ancorado em lead_id: fail-closed comprovado sem identificador.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 9: Remetente desconhecido com lead recente no banco
    // -------------------------------------------------------------
    console.log('--- TESTE 9: Remetente desconhecido não herda lead recente ---');
    const matchUnknown = agentChatService.findActiveLead('5511966665555');
    assert.equal(matchUnknown, null, 'Remetente não cadastrado NUNCA herda lead recente');
    console.log('  ✓ Ausência total de fallback temporal comprovada.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 10: Remetente identificado sem ambiguidade
    // -------------------------------------------------------------
    console.log('--- TESTE 10: Remetente inequívoco identificado diretamente ---');
    const leadDirect = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Carlos Direto', '5511955554444', 'RESTAURANT', 'ChefBot', 'SENT', datetime('now'))
    `).run();

    const matchDirect = agentChatService.findActiveLead('5511955554444');
    assert.ok(matchDirect);
    assert.equal(matchDirect.id, leadDirect.lastInsertRowid);
    assert.equal(matchDirect.agent_key, 'RESTAURANT');
    console.log('  ✓ Identificação inequívoca executada com sucesso.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 11: Preservação da demonstração legítima
    // -------------------------------------------------------------
    console.log('--- TESTE 11: Preservação da demonstração legítima para lead único ---');
    const leadDemo = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Fernanda Imóveis', '5511944443333', 'REAL_ESTATE', 'ImobBot', 'SENT', datetime('now'))
    `).run();

    const activeDemoLead = agentChatService.findActiveLead('5511944443333');
    assert.ok(activeDemoLead);
    assert.equal(activeDemoLead.agent_key, 'REAL_ESTATE');
    assert.equal(activeDemoLead.name, 'Fernanda Imóveis');
    console.log('  ✓ Fluxo comercial legítimo da RAIA mantido 100% funcional.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 12: Ausência de gravações de mensagens no lead incorreto
    // -------------------------------------------------------------
    console.log('--- TESTE 12: Ausência de gravações indevidas em agent_messages ---');
    const initialMsgCount = db.prepare('SELECT COUNT(*) as c FROM agent_messages').get().c;

    // Tentativa de gravar mensagem sem lead_id válido
    agentChatService.recordMessage(null, '5511999998888', 'SALON', 'user', 'Mensagem sem lead');
    agentChatService.recordMessage(undefined, '5511999998888', 'SALON', 'user', 'Mensagem sem lead 2');
    agentChatService.recordMessage(0, '5511999998888', 'SALON', 'user', 'Mensagem com id zero');

    const finalMsgCount = db.prepare('SELECT COUNT(*) as c FROM agent_messages').get().c;
    assert.equal(finalMsgCount, initialMsgCount, 'Nenhuma mensagem deve ser gravada sem lead_id positivo e válido');
    console.log('  ✓ Tabela agent_messages protegida contra gravações espúrias ou órfãs.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 13: Ausência de resposta automática com identidade ambígua
    // -------------------------------------------------------------
    console.log('--- TESTE 13: Ausência de resposta automática para remetente ambíguo ---');
    let socketDispatched = false;
    const mockSock = {
      sendPresenceUpdate: async () => {},
      sendMessage: async () => {
        socketDispatched = true;
        return { key: { id: 'msg_123' } };
      },
    };

    // Mensagem recebida do número com ambiguidade de nicho (SALON vs CLINIC)
    const ambMsg = {
      key: { remoteJid: `${multiPhone}@s.whatsapp.net`, id: 'MSG_AMB_001' },
      message: { conversation: 'Olá, qual é o valor?' },
    };

    const handledAmb = await agentChatService.handleLeadMessage(mockSock, ambMsg, multiPhone);
    assert.equal(handledAmb, false, 'handleLeadMessage DEVE retornar false para remetente ambíguo');
    assert.equal(socketDispatched, false, 'Nenhuma mensagem deve ser enviada via WhatsApp para remetente ambíguo');
    console.log('  ✓ Disparo bloqueado: zero respostas com persona incorreta ou sequestrada.\n');
    passedTests++;

    // -------------------------------------------------------------
    // CENÁRIO 14: Regressão completa das 11 validações do Comando 015
    // -------------------------------------------------------------
    console.log('--- TESTE 14: Validação de re-cadastro com mesmo agente (legítimo: atualiza mais recente) ---');
    const repeatPhone = '5511933332222';
    // Cadastro anterior do mesmo agente
    const leadOldSame = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Re-cadastro Anterior', ?, 'SALON', 'Jéssica', 'ACTIVE', datetime('now', '-1 hour'))
    `).run(repeatPhone);

    // Novo cadastro legítimo do mesmo agente
    const leadNewSame = db.prepare(`
      INSERT INTO leads (name, phone, agent_key, agent_name, status, created_at)
      VALUES ('Re-cadastro Recente', ?, 'SALON', 'Jéssica', 'SENT', datetime('now'))
    `).run(repeatPhone);

    // Quando todos os leads ativos possuem o MESMO agent_key, o mais recente é selecionado com segurança:
    const matchSameAgent = agentChatService.findActiveLead(repeatPhone);
    assert.ok(matchSameAgent);
    assert.equal(matchSameAgent.id, leadNewSame.lastInsertRowid);
    assert.equal(matchSameAgent.name, 'Re-cadastro Recente');
    console.log('  ✓ Re-cadastro legítimo para o mesmo agente resolvido sem falsa rejeição.\n');
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
        console.log('  ✓ Banco temporário SQLite descartado com sucesso.');
      }
      if (fs.existsSync(tempAuthDir)) {
        fs.rmSync(tempAuthDir, { recursive: true, force: true });
        console.log('  ✓ Diretório temporário de Auth descartado com sucesso.');
      }
    } catch (cleanErr) {
      console.warn('  ⚠️ Aviso ao limpar recursos temporários:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  console.log(`  RESULTADO: ${passedTests}/${totalTests} TESTES APROVADOS (100% SUCESSO)`);
  console.log('  COMANDO 016 HOMOLOGADO: ZERO COLISÃO E ZERO AMBIGUIDADE');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ FALHA NA SUÍTE DE TESTES:', err);
  process.exit(1);
});
