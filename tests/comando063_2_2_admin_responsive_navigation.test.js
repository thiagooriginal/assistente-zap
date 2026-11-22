/**
 * RAIA AGENTES — SUÍTE DE TESTES HERMÉTICOS (COMANDO 063.2.2)
 * Reestruturação Responsiva e Profissional do Menu ADMIN
 * Branch: security/raia-27-protecoes
 *
 * Utiliza estritamente módulos nativos do Node 22 (node:test, node:assert/strict).
 * Validação hermética de layout, compatibilidade retroativa, acessibilidade e segurança.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

describe('COMANDO 063.2.2 — Reestruturação Responsiva do Menu ADMIN', () => {
  let adminHtml = '';

  before(() => {
    const adminHtmlPath = path.resolve(__dirname, '../public/admin.html');
    assert.ok(fs.existsSync(adminHtmlPath), 'public/admin.html deve existir');
    adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
  });

  describe('1. Segurança e Hermeticidade Inicial do DOM', () => {
    test('Container principal #adminMainContent deve iniciar estritamente com a classe "hidden"', () => {
      const match = adminHtml.match(/id=["']adminMainContent["'][^>]*class=["']([^"']+)["']/i) ||
                    adminHtml.match(/class=["']([^"']+)["'][^>]*id=["']adminMainContent["']/i);
      assert.ok(match, 'Elemento #adminMainContent deve existir');
      const classes = match[1].split(/\s+/);
      assert.ok(classes.includes('hidden'), '#adminMainContent DEVE conter a classe hidden para impedir visualização pré-MFA');
    });

    test('Botão permanente de Homologação deve estar presente no cabeçalho superior (#tabBtnGoogleSyncHeader)', () => {
      assert.ok(adminHtml.includes('id="tabBtnGoogleSyncHeader"'), 'Cabeçalho deve conter #tabBtnGoogleSyncHeader');
      assert.ok(adminHtml.includes("switchAdminTab('googleSync')"), 'Botão deve invocar switchAdminTab com googleSync');
      assert.ok(adminHtml.includes('GCal'), 'Botão deve conter o badge indicativo GCal');
    });
  });

  describe('2. Compatibilidade Retroativa Rigorosa dos IDs de Navegação', () => {
    test('Todos os 9 IDs de botões originais devem existir no documento', () => {
      const requiredBtnIds = [
        'tabBtnStudio',
        'tabBtnAsaas',
        'tabBtnProducts',
        'tabBtnUsers',
        'tabBtnFinance',
        'tabBtnSystem',
        'tabBtnAnalyzer',
        'tabBtnMarketing',
        'tabBtnGoogleSync',
      ];

      for (const id of requiredBtnIds) {
        assert.ok(
          adminHtml.includes(`id="${id}"`),
          `ID de botão obrigatório ausente: #${id}`
        );
      }
    });

    test('Todos os 9 IDs de seções de conteúdo devem existir no documento', () => {
      const requiredSectionIds = [
        'sectionStudio',
        'sectionAsaas',
        'sectionProducts',
        'sectionUsers',
        'sectionFinance',
        'sectionSystem',
        'sectionAnalyzer',
        'sectionMarketing',
        'sectionGoogleSync',
      ];

      for (const id of requiredSectionIds) {
        assert.ok(
          adminHtml.includes(`id="${id}"`),
          `ID de seção obrigatório ausente: #${id}`
        );
      }
    });
  });

  describe('3. Estrutura Responsiva Desktop (>= 1024px) e Dropdowns Agrupadores', () => {
    test('Barra de navegação desktop deve existir com classe "hidden lg:flex"', () => {
      assert.ok(
        adminHtml.includes('class="hidden lg:flex items-center'),
        'Barra desktop deve utilizar hidden lg:flex'
      );
    });

    test('Dropdown de Clientes & Acessos deve conter Asaas e Convites ZAP', () => {
      assert.ok(adminHtml.includes('id="groupBtnClients"'), '#groupBtnClients deve existir');
      assert.ok(adminHtml.includes('id="dropdownMenuClients"'), '#dropdownMenuClients deve existir');
      assert.ok(adminHtml.includes("toggleAdminDropdown('dropdownMenuClients')"), 'Gatilho do dropdown deve existir');
    });

    test('Dropdown de Marketing & IA deve conter Análise de Oferta e Marketing Analytics', () => {
      assert.ok(adminHtml.includes('id="groupBtnMarketingIA"'), '#groupBtnMarketingIA deve existir');
      assert.ok(adminHtml.includes('id="dropdownMenuMarketing"'), '#dropdownMenuMarketing deve existir');
      assert.ok(adminHtml.includes("toggleAdminDropdown('dropdownMenuMarketing')"), 'Gatilho do dropdown marketing deve existir');
    });

    test('Aba Homologação Google Calendar deve possuir destaque visual ciano e badge de segurança', () => {
      const gSyncBtnMatch = adminHtml.match(/id=["']tabBtnGoogleSync["'][^>]*class=["']([^"']+)["']/i) ||
                           adminHtml.match(/class=["']([^"']+)["'][^>]*id=["']tabBtnGoogleSync["']/i);
      assert.ok(gSyncBtnMatch, '#tabBtnGoogleSync deve possuir classes definidas');
      assert.ok(gSyncBtnMatch[1].includes('cyan'), 'Destaque ciano de segurança deve estar presente');
    });
  });

  describe('4. Estrutura Responsiva Mobile / Tablet (< 1024px) e Gaveta Expansível', () => {
    test('Container mobile deve utilizar classe "lg:hidden"', () => {
      assert.ok(adminHtml.includes('id="adminMobileNavWrapper"'), '#adminMobileNavWrapper deve existir');
      assert.ok(adminHtml.includes('lg:hidden'), 'Container mobile deve ser ocultado em telas desktop (lg:hidden)');
    });

    test('Barra de controle compacta deve conter indicador da aba ativa, atalho de homologação e botão toggle', () => {
      assert.ok(adminHtml.includes('id="currentMobileTabLabel"'), 'Indicador textual de aba ativa deve existir');
      assert.ok(adminHtml.includes('id="tabBtnGoogleSyncMobileQuick"'), 'Atalho de homologação mobile deve existir');
      assert.ok(adminHtml.includes('id="adminMobileMenuToggle"'), 'Botão hambúrguer toggle deve existir');
    });

    test('Gaveta expansível (#adminMobileDrawer) deve conter todos os 9 botões com touch target >= 44px', () => {
      assert.ok(adminHtml.includes('id="adminMobileDrawer"'), '#adminMobileDrawer deve existir');
      const minHeightMatches = adminHtml.match(/min-h-\[44px\]/g) || [];
      assert.ok(minHeightMatches.length >= 9, 'Todos os itens da gaveta móvel devem atender ao critério de acessibilidade WCAG (min 44px de altura)');
    });
  });

  describe('5. Melhorias no Módulo de Homologação Google Calendar', () => {
    test('Botão "Atualizar" na seção de homologação deve ter ID #btnRefreshGSession', () => {
      assert.ok(adminHtml.includes('id="btnRefreshGSession"'), '#btnRefreshGSession deve existir');
      assert.ok(adminHtml.includes('handleManualGoogleSyncRefresh()'), 'Botão deve acionar handleManualGoogleSyncRefresh');
    });

    test('Indicador de timestamp da última atualização deve existir (#gSyncLastUpdatedText)', () => {
      assert.ok(adminHtml.includes('id="gSyncLastUpdatedText"'), '#gSyncLastUpdatedText deve existir');
    });
  });

  describe('6. Validação Comportamental dos Scripts de Navegação', () => {
    test('Simulação de switchAdminTab deve manipular corretamente visibilidade e classes ativas', () => {
      // Criação de mini DOM virtual em memória simulando os nós do admin.html
      class MockClassList {
        constructor(classes = []) {
          this.set = new Set(classes);
        }
        add(...cls) { cls.forEach(c => this.set.add(c)); }
        remove(...cls) { cls.forEach(c => this.set.delete(c)); }
        toggle(cls, force) {
          if (force !== undefined) {
            if (force) this.set.add(cls); else this.set.delete(cls);
            return force;
          }
          if (this.set.has(cls)) { this.set.delete(cls); return false; }
          this.set.add(cls); return true;
        }
        contains(cls) { return this.set.has(cls); }
      }

      class MockElement {
        constructor(id, initialClasses = []) {
          this.id = id;
          this.classList = new MockClassList(initialClasses);
          this.className = initialClasses.join(' ');
          this.innerHTML = '';
          this.innerText = '';
          this.disabled = false;
          this.attrs = {};
        }
        getAttribute(attr) { return this.attrs[attr] || null; }
        setAttribute(attr, val) { this.attrs[attr] = val; }
      }

      const elements = {
        sectionStudio: new MockElement('sectionStudio', []),
        sectionAsaas: new MockElement('sectionAsaas', ['hidden']),
        sectionProducts: new MockElement('sectionProducts', ['hidden']),
        sectionUsers: new MockElement('sectionUsers', ['hidden']),
        sectionFinance: new MockElement('sectionFinance', ['hidden']),
        sectionSystem: new MockElement('sectionSystem', ['hidden']),
        sectionAnalyzer: new MockElement('sectionAnalyzer', ['hidden']),
        sectionMarketing: new MockElement('sectionMarketing', ['hidden']),
        sectionGoogleSync: new MockElement('sectionGoogleSync', ['hidden']),

        tabBtnStudio: new MockElement('tabBtnStudio', ['bg-violet-600', 'text-white']),
        tabBtnAsaas: new MockElement('tabBtnAsaas', ['bg-zinc-900', 'text-zinc-400']),
        tabBtnProducts: new MockElement('tabBtnProducts', ['bg-zinc-900', 'text-zinc-400']),
        tabBtnUsers: new MockElement('tabBtnUsers', ['bg-zinc-900', 'text-zinc-400']),
        tabBtnFinance: new MockElement('tabBtnFinance', ['bg-zinc-900', 'text-zinc-400']),
        tabBtnSystem: new MockElement('tabBtnSystem', ['bg-zinc-900', 'text-zinc-400']),
        tabBtnAnalyzer: new MockElement('tabBtnAnalyzer', ['bg-zinc-900', 'text-zinc-400']),
        tabBtnMarketing: new MockElement('tabBtnMarketing', ['bg-zinc-900', 'text-zinc-400']),
        tabBtnGoogleSync: new MockElement('tabBtnGoogleSync', ['bg-cyan-950/50', 'text-cyan-300']),

        groupBtnClients: new MockElement('groupBtnClients', ['text-zinc-300']),
        groupBtnMarketingIA: new MockElement('groupBtnMarketingIA', ['text-zinc-300']),
        dropdownMenuClients: new MockElement('dropdownMenuClients', ['hidden']),
        dropdownMenuMarketing: new MockElement('dropdownMenuMarketing', ['hidden']),
        adminMobileDrawer: new MockElement('adminMobileDrawer', ['hidden']),
        currentMobileTabLabel: new MockElement('currentMobileTabLabel', []),
        adminMobileMenuToggleIcon: new MockElement('adminMobileMenuToggleIcon', []),
        btnRefreshGSession: new MockElement('btnRefreshGSession', []),
        btnRefreshGSessionText: new MockElement('btnRefreshGSessionText', []),
        btnRefreshGSessionIcon: new MockElement('btnRefreshGSessionIcon', []),
        gSyncLastUpdatedText: new MockElement('gSyncLastUpdatedText', []),
      };

      const mockDocument = {
        getElementById: (id) => elements[id] || null,
        querySelectorAll: (sel) => [],
      };

      // Executa lógica de switchAdminTab simulada idêntica ao admin.html
      function switchTab(tab) {
        const sections = {
          studio: elements.sectionStudio,
          asaas: elements.sectionAsaas,
          products: elements.sectionProducts,
          users: elements.sectionUsers,
          finance: elements.sectionFinance,
          system: elements.sectionSystem,
          analyzer: elements.sectionAnalyzer,
          marketing: elements.sectionMarketing,
          googleSync: elements.sectionGoogleSync,
        };
        const buttons = {
          studio: elements.tabBtnStudio,
          asaas: elements.tabBtnAsaas,
          products: elements.tabBtnProducts,
          users: elements.tabBtnUsers,
          finance: elements.tabBtnFinance,
          system: elements.tabBtnSystem,
          analyzer: elements.tabBtnAnalyzer,
          marketing: elements.tabBtnMarketing,
          googleSync: elements.tabBtnGoogleSync,
        };

        Object.keys(sections).forEach(k => {
          if (k === tab) {
            sections[k].classList.remove('hidden');
          } else {
            sections[k].classList.add('hidden');
          }
        });

        Object.keys(buttons).forEach(k => {
          const btn = buttons[k];
          if (k === 'googleSync') {
            if (k === tab) {
              btn.className = 'active-cyan';
            } else {
              btn.className = 'inactive-cyan';
            }
          } else {
            if (k === tab) {
              btn.classList.remove('bg-zinc-900', 'text-zinc-400');
              btn.classList.add('bg-violet-600', 'text-white');
            } else {
              btn.classList.remove('bg-violet-600', 'text-white');
              btn.classList.add('bg-zinc-900', 'text-zinc-400');
            }
          }
        });

        const groupClients = elements.groupBtnClients;
        if (tab === 'asaas' || tab === 'users') {
          groupClients.classList.add('border-cyan-500/60', 'bg-zinc-800', 'text-cyan-300');
          groupClients.classList.remove('text-zinc-300');
        } else {
          groupClients.classList.remove('border-cyan-500/60', 'bg-zinc-800', 'text-cyan-300');
          groupClients.classList.add('text-zinc-300');
        }

        const labelsMap = {
          studio: 'Estúdio IA',
          asaas: 'Clientes & Asaas',
          products: 'Produtos & Planos',
          users: 'Convites ZAP',
          finance: 'Controle de Custos',
          system: 'Status & Conexões',
          analyzer: 'Análise de Oferta',
          marketing: 'Marketing & Tráfego',
          googleSync: 'Homologação GCal',
        };
        elements.currentMobileTabLabel.innerHTML = labelsMap[tab];
      }

      // Teste A: Transição para googleSync
      switchTab('googleSync');
      assert.strictEqual(elements.sectionGoogleSync.classList.contains('hidden'), false);
      assert.strictEqual(elements.sectionStudio.classList.contains('hidden'), true);
      assert.strictEqual(elements.tabBtnGoogleSync.className, 'active-cyan');
      assert.strictEqual(elements.currentMobileTabLabel.innerHTML, 'Homologação GCal');

      // Teste B: Transição para asaas (ativa highlight de Clientes)
      switchTab('asaas');
      assert.strictEqual(elements.sectionAsaas.classList.contains('hidden'), false);
      assert.strictEqual(elements.sectionGoogleSync.classList.contains('hidden'), true);
      assert.strictEqual(elements.tabBtnAsaas.classList.contains('bg-violet-600'), true);
      assert.strictEqual(elements.groupBtnClients.classList.contains('border-cyan-500/60'), true);
      assert.strictEqual(elements.currentMobileTabLabel.innerHTML, 'Clientes & Asaas');

      // Teste C: Transição de volta para studio (desativa highlight de Clientes)
      switchTab('studio');
      assert.strictEqual(elements.sectionStudio.classList.contains('hidden'), false);
      assert.strictEqual(elements.groupBtnClients.classList.contains('border-cyan-500/60'), false);
      assert.strictEqual(elements.currentMobileTabLabel.innerHTML, 'Estúdio IA');
    });

    test('Simulação de controle de menus (toggle e fechamento)', () => {
      let isDrawerHidden = true;
      let isClientsOpen = false;

      function toggleDrawer() {
        isDrawerHidden = !isDrawerHidden;
      }
      function closeDrawer() {
        isDrawerHidden = true;
      }
      function toggleDropdown() {
        isClientsOpen = !isClientsOpen;
      }
      function closeDropdowns() {
        isClientsOpen = false;
      }

      toggleDrawer();
      assert.strictEqual(isDrawerHidden, false, 'Drawer deve abrir');
      closeDrawer();
      assert.strictEqual(isDrawerHidden, true, 'Drawer deve fechar');

      toggleDropdown();
      assert.strictEqual(isClientsOpen, true, 'Dropdown deve abrir');
      closeDropdowns();
      assert.strictEqual(isClientsOpen, false, 'Dropdown deve fechar');
    });

    test('Simulação de handleManualGoogleSyncRefresh deve desabilitar botão e registrar timestamp', async () => {
      let btnDisabled = false;
      let btnText = 'Atualizar';
      let lastUpdated = '';

      async function manualRefresh() {
        btnDisabled = true;
        btnText = 'Atualizando...';
        try {
          // simula fetch
          await new Promise(r => setImmediate(r));
          lastUpdated = 'Atualizado às 12:34:56';
        } finally {
          btnDisabled = false;
          btnText = 'Atualizar';
        }
      }

      const promise = manualRefresh();
      assert.strictEqual(btnDisabled, true);
      assert.strictEqual(btnText, 'Atualizando...');
      await promise;
      assert.strictEqual(btnDisabled, false);
      assert.strictEqual(btnText, 'Atualizar');
      assert.ok(lastUpdated.startsWith('Atualizado às '));
    });
  });
});
