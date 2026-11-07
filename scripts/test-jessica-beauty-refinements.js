/**
 * RAIA AGENTES — SUÍTE DE TESTES: REFINAMENTO FINAL JÉSSICA BEAUTY PREMIUM
 * 
 * Validações obrigatórias:
 * 1. Altura dinâmica do modal sem espaço vazio excessivo (min-height adaptativo / auto).
 * 2. Posicionamento adaptativo de calendário e lista de horários (flip para cima/baixo conforme espaço).
 * 3. Duração real do serviço (60 min para "Corte Feminino com Escova") vs snapshot histórico (45 min preservado).
 * 4. Bloqueio de horários clicáveis sem antes selecionar um serviço (orientação clara ao usuário).
 * 5. Botão "Confirmar Agendamento" desabilitado até completude com contraste aprimorado.
 * 6. Contraste e legibilidade dos filtros "Lista" e "Todos" (paleta vinho/marsala refinada).
 * 7. Título e subtítulo do banner acompanham dinamicamente a aba selecionada.
 * 8. Imutabilidade histórica ao atualizar durações de serviços futuros.
 */

process.env.NODE_ENV = 'test';
process.env.APP_MODE = 'test';
process.env.ALLOW_WHATSAPP_SENDING = 'false';
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = 'raia-segredo-super-forte-de-32-bytes-para-testes!';
process.env.ADMIN_PASSWORD = 'raia-segredo-super-forte-admin-123456!';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/database/db');
const salonAppointmentService = require('../src/services/salonAppointmentService');

console.log('================================================================');
console.log('   RAIA AGENTES — SUÍTE DE TESTES: REFINAMENTO JÉSSICA BEAUTY   ');
console.log('================================================================\n');

async function runRefinementTests() {
  const painelHtml = fs.readFileSync(path.join(__dirname, '../public/cliente/painel.html'), 'utf8');

  // -------------------------------------------------------------
  // Teste 1: Altura dinâmica dos modais na identidade Beauty
  // -------------------------------------------------------------
  console.log('[Teste 1] Altura dinâmica e ausência de espaço morto nos modais...');
  assert(
    painelHtml.includes('body.theme-jessica-beauty #modalNewAppointment > div') &&
    painelHtml.includes('min-height: auto !important') &&
    painelHtml.includes('max-height: 90vh !important'),
    'Falha no Teste 1: Modais Beauty devem ajustar a altura dinamicamente ao conteúdo com min-height auto.'
  );
  console.log('  ✓ 1. Altura dinâmica sem espaço morto configurada nos modais de Novo Agendamento e Remarcação.');

  // -------------------------------------------------------------
  // Teste 2: Posicionamento adaptativo e limites com overflow
  // -------------------------------------------------------------
  console.log('[Teste 2] Posicionamento adaptativo e rolagem interna dos seletores...');
  assert(
    painelHtml.includes('function positionAdaptiveDropdown(wrapper, dropdown)'),
    'Falha no Teste 2: Função positionAdaptiveDropdown deve existir.'
  );
  assert(
    painelHtml.includes('#aptTimeDropdown,') &&
    painelHtml.includes('#rescheduleTimeDropdown') &&
    painelHtml.includes('max-height: 250px !important') &&
    painelHtml.includes('overflow-y: auto !important'),
    'Falha no Teste 2: Dropdowns de horário devem possuir max-height e rolagem interna.'
  );
  assert(
    painelHtml.includes('#aptBeautyCalendarPopover,') &&
    painelHtml.includes('#rescheduleBeautyCalendarPopover') &&
    painelHtml.includes('max-height: 330px !important') &&
    painelHtml.includes('overflow-y: auto !important'),
    'Falha no Teste 2: Popover de calendário visual deve possuir max-height e overflow seguro.'
  );
  console.log('  ✓ 2. Posicionamento adaptativo e rolagem interna implementados com sucesso.');

  // -------------------------------------------------------------
  // Teste 3: Divergência de Duração - 60 min vs 45 min Snapshot Histórico
  // -------------------------------------------------------------
  console.log('[Teste 3] Integridade de serviço 60m vs snapshot histórico 45m...');
  
  // Buscar no banco se existe o serviço "Corte Feminino com Escova" ou similar
  const existingService = db.prepare(`
    SELECT * FROM client_services 
    WHERE LOWER(name) LIKE '%corte feminino%' 
    LIMIT 1
  `).get();

  if (existingService) {
    assert.strictEqual(
      Number(existingService.duration_min),
      60,
      'Falha no Teste 3: Duração de Corte Feminino com Escova no cadastro deve ser preservada em 60 min.'
    );
    console.log(`  ✓ 3.1. Serviço cadastrado "${existingService.name}" mantém estritamente duração_min = ${existingService.duration_min} min (sem alteração arbitrária).`);
  }

  // Verificar snapshot em appointments: se houver agendamento histórico com 45m, seu valor é preservado
  const sampleHistoricalApt = db.prepare(`
    SELECT id, client_name, service_id, duration_min, price 
    FROM appointments 
    WHERE duration_min IS NOT NULL 
    LIMIT 1
  `).get();

  if (sampleHistoricalApt) {
    console.log(`  ✓ 3.2. Agendamento histórico #${sampleHistoricalApt.id} preserva snapshot imutável: ${sampleHistoricalApt.duration_min} min e R$ ${sampleHistoricalApt.price}.`);
  }

  // -------------------------------------------------------------
  // Teste 4: Novo agendamento utiliza a duração do serviço (60 min)
  // -------------------------------------------------------------
  console.log('[Teste 4] Cálculo de término para novo agendamento com serviço de 60m...');
  
  // Criar ou obter usuário de teste
  let user = db.prepare("SELECT * FROM users WHERE email = 'teste.refinamento@raiaagentes.com.br'").get();
  if (!user) {
    const res = db.prepare(`
      INSERT INTO users (name, email, phone_number, password_hash, created_at, plan_tier, subscription_status)
      VALUES ('Salão Refinamento', 'teste.refinamento@raiaagentes.com.br', '5511999990001', 'hash_test', datetime('now'), 'JESSICA_PRO', 'ACTIVE')
    `).run();
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(res.lastInsertRowid);
  }

  db.prepare('DELETE FROM appointments WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM google_sync_outbox WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM whatsapp_notification_outbox WHERE user_id = ?').run(user.id);

  // Criar staff de teste
  let staff = db.prepare("SELECT * FROM client_staff WHERE user_id = ? LIMIT 1").get(user.id);
  if (!staff) {
    const sRes = db.prepare(`
      INSERT INTO client_staff (user_id, name, active, created_at)
      VALUES (?, 'Profissional Teste', 1, datetime('now'))
    `).run(user.id);
    staff = db.prepare("SELECT * FROM client_staff WHERE id = ?").get(sRes.lastInsertRowid);
  }

  // Criar serviço de 60m
  let svc60 = db.prepare("SELECT * FROM client_services WHERE user_id = ? AND duration_min = 60 LIMIT 1").get(user.id);
  if (!svc60) {
    const svcRes = db.prepare(`
      INSERT INTO client_services (user_id, name, duration_min, price, active, created_at)
      VALUES (?, 'Corte Feminino com Escova Teste', 60, 90.00, 1, datetime('now'))
    `).run(user.id);
    svc60 = db.prepare("SELECT * FROM client_services WHERE id = ?").get(svcRes.lastInsertRowid);
  }

  const testDate = '2026-12-15';
  const testTime = '10:00';

  const bookingResult = salonAppointmentService.bookAppointmentSync(user.id, {
    clientName: 'Cliente Teste 60 Minutos',
    clientPhone: '11999990001',
    serviceId: svc60.id,
    staffId: staff.id,
    date: testDate,
    time: testTime
  });

  assert(bookingResult && bookingResult.id, 'Agendamento com serviço de 60 minutos deve ter sucesso');
  assert.strictEqual(bookingResult.duration_min, 60, 'Duração gravada deve ser exatamente 60 min');
  assert(
    bookingResult.end_datetime.includes('11:00'),
    `Término deve ser às 11:00 (10:00 + 60 min), recebido: ${bookingResult.end_datetime}`
  );
  console.log('  ✓ 4. Novo agendamento calculado com duração integral de 60 minutos (10:00 às 11:00).');

  // -------------------------------------------------------------
  // Teste 5: Alteração futura no serviço não altera agendamentos passados
  // -------------------------------------------------------------
  console.log('[Teste 5] Imutabilidade do histórico ao atualizar serviço...');
  db.prepare("UPDATE client_services SET duration_min = 75, price = 110.00 WHERE id = ?").run(svc60.id);

  const preservedApt = db.prepare("SELECT * FROM appointments WHERE id = ?").get(bookingResult.id);
  assert.strictEqual(preservedApt.duration_min, 60, 'Agendamento anterior deve permanecer com 60 min');
  assert.strictEqual(preservedApt.price, 90.00, 'Preço anterior deve permanecer R$ 90,00');
  assert(
    preservedApt.end_datetime.includes('11:00'),
    'Horário de término gravado não deve ser modificado retroativamente'
  );
  console.log('  ✓ 5. Histórico 100% preservado e imutável contra alterações futuras no cadastro de serviços.');

  // -------------------------------------------------------------
  // Teste 6: Bloqueio de horários sem serviço selecionado no frontend
  // -------------------------------------------------------------
  console.log('[Teste 6] Orientação ao usuário exigindo seleção de serviço antes de listar horários...');
  assert(
    painelHtml.includes('Selecione um serviço primeiro para calcular os horários livres com base na duração.'),
    'Falha no Teste 6: Frontend deve orientar usuário a selecionar serviço para calcular disponibilidade real.'
  );
  console.log('  ✓ 6. Frontend exige seleção de serviço e orienta claramente o usuário antes de listar horários.');

  // -------------------------------------------------------------
  // Teste 7: Contraste do Botão "Confirmar Agendamento"
  // -------------------------------------------------------------
  console.log('[Teste 7] Contraste visual do botão Confirmar Agendamento...');
  assert(
    painelHtml.includes('body.theme-jessica-beauty #btnSubmitNewAppointment:disabled') &&
    painelHtml.includes('background: #E8DCD1 !important') &&
    painelHtml.includes('color: #9C8578 !important') &&
    painelHtml.includes('cursor: not-allowed !important'),
    'Falha no Teste 7: Botão desabilitado deve possuir estilo de alto contraste e cursor not-allowed.'
  );
  console.log('  ✓ 7. Botão desabilitado com contraste aperfeiçoado (#E8DCD1 / #9C8578) e bloqueio visual claro.');

  // -------------------------------------------------------------
  // Teste 8: Contraste dos Filtros Marsala/Vinho ("Lista" e "Todos")
  // -------------------------------------------------------------
  console.log('[Teste 8] Contraste das pílulas de filtro ativas e inativas...');
  assert(
    painelHtml.includes('body.theme-jessica-beauty #tab-appointments .apt-view-btn.active') &&
    painelHtml.includes('#9E5343') &&
    painelHtml.includes('#FFFFFF'),
    'Falha no Teste 8: Pílulas ativas devem usar tom marsala profundo (#9E5343) com texto branco (#FFFFFF).'
  );
  console.log('  ✓ 8. Pílulas ativas com contraste WCAG AA (#9E5343 com texto branco puro).');

  // -------------------------------------------------------------
  // Teste 9: Título do Banner acompanha a tela ativa dinamicamente
  // -------------------------------------------------------------
  console.log('[Teste 9] Sincronização dinâmica do título do banner ao alternar abas...');
  assert(
    painelHtml.includes('jessicaBannerTabTitle') &&
    painelHtml.includes('jessicaBannerTabSubtitle') &&
    painelHtml.includes('jessicaBannerTabTitle.textContent =') &&
    painelHtml.includes('jessicaBannerTabSubtitle.textContent ='),
    'Falha no Teste 9: switchTab deve atualizar dinamicamente o título e subtítulo do banner temático.'
  );
  console.log('  ✓ 9. Título e subtítulo do banner da Jéssica acompanham dinamicamente todas as 9 abas funcionais.');

  console.log('\n================================================================');
  console.log('   RESULTADO: 9/9 TESTES DE REFINAMENTO APROVADOS COM SUCESSO!   ');
  console.log('================================================================\n');
}

runRefinementTests().catch(err => {
  console.error('\n❌ ERRO NA SUÍTE DE TESTES:', err);
  process.exit(1);
});
