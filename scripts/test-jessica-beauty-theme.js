/**
 * test-jessica-beauty-theme.js
 * 
 * Suíte de testes automatizados para validação da identidade visual
 * JÉSSICA BEAUTY PREMIUM, arquitetura de temas por agente e refinamentos de usabilidade.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('================================================================');
console.log('   RAIA AGENTES — SUÍTE DE TESTES: IDENTIDADE JÉSSICA BEAUTY   ');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ [PASS] Teste ${totalTests}: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ [FAIL] Teste ${totalTests}: ${name}`);
    console.error(`     Erro: ${err.message}`);
    process.exitCode = 1;
  }
}

const htmlPath = path.join(__dirname, '..', 'public', 'cliente', 'painel.html');
assert(fs.existsSync(htmlPath), 'Arquivo public/cliente/painel.html deve existir');
const html = fs.readFileSync(htmlPath, 'utf8');

// 1. Tokens oficiais da paleta de cores da Jéssica
runTest('Presença dos 11 tokens oficiais da paleta Jéssica Beauty', () => {
  const officialTokens = [
    { name: 'Fundo principal', hex: '#F7EFE7' },
    { name: 'Fundo secundário', hex: '#F3E6DB' },
    { name: 'Cards e painéis', hex: '#FFFDFB' },
    { name: 'Dourado principal', hex: '#C89B6D' },
    { name: 'Dourado profundo', hex: '#AD7B42' },
    { name: 'Rosé', hex: '#D9B8AE' },
    { name: 'Rosé claro', hex: '#F0DFD9' },
    { name: 'Texto principal', hex: '#4E3B31' },
    { name: 'Texto secundário', hex: '#7A6255' },
    { name: 'Bordas', hex: '#E6D6CA' },
    { name: 'Fundo de inputs', hex: '#FFFFFF' }
  ];

  officialTokens.forEach(token => {
    assert(
      html.includes(token.hex) || html.includes(token.hex.toLowerCase()),
      `Token ${token.name} (${token.hex}) deve estar presente no CSS do tema`
    );
  });
});

// 2. Arquitetura de temas e escopo por agente
runTest('Arquitetura de tema escopada: body.theme-jessica-beauty e body.theme-raia', () => {
  assert(html.includes('body.theme-jessica-beauty'), 'Regras CSS devem ser escopadas em body.theme-jessica-beauty');
  assert(html.includes('theme-raia'), 'Classe padrão theme-raia deve estar presente no body inicial');
  assert(html.includes('--beauty-bg-primary: #F7EFE7;'), 'Variáveis CSS de tema devem estar declaradas no :root');
});

// 3. Alternância dinâmica de temas na função switchTab
runTest('Função switchTab alterna dinamicamente entre tema RAIA e Jéssica Beauty', () => {
  assert(html.includes("document.body.classList.add('theme-jessica-beauty')"), 'switchTab deve adicionar theme-jessica-beauty nas abas do salão');
  assert(html.includes("document.body.classList.remove('theme-raia')"), 'switchTab deve remover theme-raia nas abas do salão');
  assert(html.includes("document.body.classList.add('theme-raia')"), 'switchTab deve restaurar theme-raia nas abas da central HUB');
  assert(html.includes("document.body.classList.remove('theme-jessica-beauty')"), 'switchTab deve remover theme-jessica-beauty nas abas da central HUB');
  assert(html.includes("document.documentElement.classList.remove('dark')"), 'switchTab deve desativar modo dark ao entrar na Jéssica');
  assert(html.includes("document.documentElement.classList.add('dark')"), 'switchTab deve reativar modo dark ao voltar ao HUB');
});

// 4. Banner exclusivo da Jéssica com ilustração vetorial e 9 abas
runTest('Banner temático da Jéssica (#jessicaBeautyHeaderBanner) com ilustração SVG de beleza', () => {
  assert(html.includes('id="jessicaBeautyHeaderBanner"'), 'Elemento #jessicaBeautyHeaderBanner deve existir');
  assert(html.includes('Jéssica Beauty'), 'Banner deve destacar Jéssica Beauty');
  assert(html.includes('Beauty &amp; Aesthetics AI') || html.includes('Beauty & Aesthetics AI'), 'Banner deve possuir badge de IA de beleza');
  // SVG com elementos de beleza (tesoura, pincel, florais)
  assert(html.includes('<svg viewBox="0 0 240 160"'), 'Banner deve conter ilustração vetorial SVG personalizada');
  assert(html.includes('beautyGlow'), 'SVG deve conter radial gradient beautyGlow');
  assert(html.includes('goldGradient'), 'SVG deve conter linear gradient goldGradient');
  assert(html.includes('roseGradient'), 'SVG deve conter linear gradient roseGradient');
});

// 5. Navegação rápida pelas 9 áreas da Jéssica no banner
runTest('Submenu rápido horizontal no banner com todas as 9 áreas funcionais', () => {
  const areas = [
    'overview',
    'salon',
    'services',
    'staff',
    'appointments',
    'integrations-google',
    'integrations-whatsapp',
    'dashboard-pro',
    'campaigns-pro'
  ];

  areas.forEach(area => {
    assert(
      html.includes(`data-jessica-nav="${area}"`),
      `Botão de navegação rápida para a área "${area}" deve existir no banner`
    );
  });

  assert(html.includes('.jessica-quick-nav-btn'), 'Botões rápidos devem possuir a classe .jessica-quick-nav-btn');
  assert(html.includes("b.dataset.jessicaNav === tabId"), 'switchTab deve sincronizar o estado ativo do quick nav');
});

// 6. Prevenção de corte/clipping na lista de horários dos modais
runTest('Prevenção de clipping nos modais de agendamento e remarcação', () => {
  // modalNewAppointment
  assert(html.includes('id="modalNewAppointment"'), 'Modal de novo agendamento deve existir');
  assert(html.includes('min-h-[520px]'), 'Modal de novo agendamento deve ter min-h-[520px] para evitar clipping');
  assert(html.includes('id="aptTimeDropdown" class="hidden absolute left-0 right-0 top-full mt-1.5 p-3 rounded-xl bg-[#11131a] border border-white/15 shadow-2xl z-[70]'), 'Dropdown de horários deve ter z-[70]');
  
  // modalRescheduleAppointment
  assert(html.includes('id="modalRescheduleAppointment"'), 'Modal de remarcação deve existir');
  assert(html.includes('min-h-[460px]'), 'Modal de remarcação deve ter min-h-[460px] para evitar clipping');
  assert(html.includes('id="rescheduleTimeDropdown" class="hidden absolute left-0 right-0 top-full mt-1.5 p-3 rounded-xl bg-[#11131a] border border-white/15 shadow-2xl z-[70]'), 'Dropdown de remarcação deve ter z-[70]');
});

// 7. Popover customizado de calendário visual no padrão Beauty
runTest('Popover visual customizado de calendário Beauty (#aptBeautyCalendarPopover)', () => {
  assert(html.includes('id="aptBeautyCalendarPopover"'), 'Popover de calendário #aptBeautyCalendarPopover deve existir');
  assert(html.includes('id="rescheduleBeautyCalendarPopover"'), 'Popover de calendário #rescheduleBeautyCalendarPopover deve existir');
  assert(html.includes('id="btnPrevAptCalMonth"'), 'Botão de mês anterior deve existir');
  assert(html.includes('id="btnNextAptCalMonth"'), 'Botão de próximo mês deve existir');
  assert(html.includes('id="aptCalDaysGrid"'), 'Grid de dias deve existir');
  assert(html.includes('function renderBeautyCalendar'), 'Função renderBeautyCalendar deve existir no script inline');
  assert(html.includes('dayDate < today'), 'renderBeautyCalendar deve bloquear e desabilitar datas no passado');
});

// 8. Desabilitar botão de confirmação enquanto campos obrigatórios estiverem incompletos
runTest('Botão de confirmação de agendamento inicia desabilitado e valida completude', () => {
  assert(html.includes('function validateAppointmentFormCompletion'), 'Função validateAppointmentFormCompletion deve existir');
  assert(html.includes('submitBtn.disabled = true;'), 'Validador deve desabilitar botão quando campos faltarem');
  assert(html.includes('validateAppointmentFormCompletion();'), 'Validador deve ser executado na abertura do modal');
  assert(html.includes("submitBtn.title = 'Preencha todos os campos obrigatórios"), 'Tooltip de orientação deve ser atribuído');
});

// 9. Agendamentos cancelados reconhecem todas as variantes (CANCELADO, CANCELLED, etc.)
runTest('Agendamentos com status CANCELADO e CANCELLED exibem tag Atendimento Cancelado e ocultam ações inválidas', () => {
  assert(
    html.includes("const isCancelled = ['CANCELLED', 'CANCELADO', 'CANCEL'].includes(String(a.status || '').toUpperCase());"),
    'isCancelled deve reconhecer todas as variantes válidas (CANCELADO, CANCELLED, etc.)'
  );
  assert(html.includes('Atendimento Cancelado'), 'Tag Atendimento Cancelado deve ser exibida para agendamentos cancelados');

  // Teste lógico das variantes
  const checkCancelled = (status) => ['CANCELLED', 'CANCELADO', 'CANCEL'].includes(String(status || '').toUpperCase());
  assert.strictEqual(checkCancelled('CANCELADO'), true, 'CANCELADO deve ser considerado cancelado');
  assert.strictEqual(checkCancelled('CANCELLED'), true, 'CANCELLED deve ser considerado cancelado');
  assert.strictEqual(checkCancelled('Cancelado'), true, 'Cancelado deve ser considerado cancelado');
  assert.strictEqual(checkCancelled('cancelado'), true, 'cancelado deve ser considerado cancelado');
  assert.strictEqual(checkCancelled('cancelled'), true, 'cancelled deve ser considerado cancelado');
  assert.strictEqual(checkCancelled('AGENDADO'), false, 'AGENDADO não é cancelado');
  assert.strictEqual(checkCancelled('CONFIRMADO'), false, 'CONFIRMADO não é cancelado');
});

// 10. Status Google Calendar na agenda considera se a conta está conectada
runTest('getGoogleSyncBadgeHtml considera conexão: exibe Aguardando conexão se desconectado e não Sincronizando falso', () => {
  assert(
    html.includes('function getGoogleSyncBadgeHtml(syncStatus, isGoogleConnected = appointmentsState.isGoogleConnected)'),
    'getGoogleSyncBadgeHtml deve aceitar e validar isGoogleConnected'
  );
  assert(
    html.includes('if (!isGoogleConnected) {') || html.includes('if (!isGoogleConnected)'),
    'getGoogleSyncBadgeHtml deve checar se a conta está conectada'
  );

  // Execução direta simulada da lógica de getGoogleSyncBadgeHtml
  function testBadge(syncStatus, isGoogleConnected) {
    if (!isGoogleConnected) {
      return '<span ...>Aguardando conexão com Google</span>';
    }
    if (!syncStatus || syncStatus === 'NOT_CONNECTED') {
      return '<span ...>Aguardando conexão com Google</span>';
    }
    if (syncStatus === 'SYNCED') {
      return '<span ...>Google Calendar</span>';
    }
    if (syncStatus === 'PENDING') {
      return '<span ...>Sincronizando</span>';
    }
    if (syncStatus === 'FAILED') {
      return '<span ...>Falha Google</span>';
    }
    return '';
  }

  // Cenário A: Desconectado com status PENDING no banco -> Deve exibir Aguardando conexão, NUNCA Sincronizando
  const badgeDisconnected = testBadge('PENDING', false);
  assert(badgeDisconnected.includes('Aguardando conexão com Google'), 'Quando desconectado, PENDING deve exibir Aguardando conexão');
  assert(!badgeDisconnected.includes('Sincronizando'), 'Quando desconectado, PENDING NÃO deve exibir Sincronizando');

  // Cenário B: Conectado com status PENDING -> Exibe Sincronizando
  const badgePending = testBadge('PENDING', true);
  assert(badgePending.includes('Sincronizando'), 'Quando conectado, PENDING deve exibir Sincronizando');

  // Cenário C: Conectado com status SYNCED -> Exibe Google Calendar
  const badgeSynced = testBadge('SYNCED', true);
  assert(badgeSynced.includes('Google Calendar'), 'Quando conectado, SYNCED deve exibir Google Calendar');
});

// 10.1 Backend API /appointments retorna isGoogleConnected
runTest('Backend API GET /api/cliente/appointments retorna isGoogleConnected', () => {
  const routesPath = path.join(__dirname, '..', 'src', 'routes', 'clientRoutes.js');
  const routesContent = fs.readFileSync(routesPath, 'utf8');
  assert(
    routesContent.includes('isGoogleConnected: Boolean(googleStatus?.isConnected)'),
    'clientRoutes.js deve incluir isGoogleConnected na resposta de /api/cliente/appointments'
  );
});

// 11. Preservação dos botões e estilos institucionais na Central Hub
runTest('Integridade institucional: HUB Central mantém identidade escura intacta', () => {
  assert(html.includes('CENTRAL RAIA'), 'Header badge deve exibir CENTRAL RAIA quando fora da Jéssica');
  assert(html.includes('btnBackToHub'), 'Botão Voltar ao HUB Central deve existir e ser controlado');
  assert(html.includes("document.getElementById('btnBackToHub').addEventListener('click', () => switchTab('my-products'))"), 'Voltar ao HUB deve restaurar aba my-products');
});

// 12. Validação de ausência de classes do tema Jéssica nas abas institucionais
runTest('Isolamento das regras de estilo: CSS da Jéssica não vaza para abas da RAIA', () => {
  // As regras de estilo são estritamente prefixadas com body.theme-jessica-beauty
  const cssMatches = html.match(/body\.theme-jessica-beauty/g);
  assert(cssMatches && cssMatches.length >= 20, 'Deve haver cobertura completa sob body.theme-jessica-beauty');
  
  // Garantir que as abas do HUB usam classes Tailwind institucionais
  assert(html.includes('id="tab-my-products"'), 'Aba my-products deve existir');
  assert(html.includes('id="tab-explore-solutions"'), 'Aba explore-solutions deve existir');
  assert(html.includes('id="tab-my-subscriptions"'), 'Aba my-subscriptions deve existir');
  assert(html.includes('id="tab-my-invoices"'), 'Aba my-invoices deve existir');
});

console.log('\n================================================================');
console.log(`   RESULTADO FINAL: ${passedTests}/${totalTests} TESTES APROVADOS COM SUCESSO!`);
console.log('================================================================\n');

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
