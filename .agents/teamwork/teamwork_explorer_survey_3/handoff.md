# Relatório de Investigação: Infraestrutura de Testes e Garantia da Qualidade (QA)
**Branch**: `security/raia-27-protecoes`  
**Autor**: Agente Explorer (Survey 3 — Engenheiro de Testes Automatizados & Revisor Técnico)  
**Data**: 2026-11-09T13:55:00Z  
**Localização do Relatório**: `.agents/teamwork/teamwork_explorer_survey_3/handoff.md`

---

## 1. Observação

### 1.1 Configuração de Dependências e Scripts (`package.json`)
A inspeção direta do arquivo `package.json` (linhas 1 a 37) revela:
```json
6:   "scripts": {
7:     "start": "node src/index.js",
8:     "start:staging": "node src/server/start-staging.js",
9:     "tunnel": ".\\cloudflared.exe tunnel --url http://localhost:3333",
10:     "auth-calendar": "node src/scripts/authCalendar.js",
11:     "push-calendar": "node src/scripts/pushCalendarCredentials.js",
12:     "test-finance": "node -e \"console.log(require('./src/services/financeService').getRecentExpenses())\""
13:   },
...
24:   "dependencies": {
25:     "@google/generative-ai": "^0.24.1",
26:     "@whiskeysockets/baileys": "^7.0.0-rc.14",
27:     "cors": "^2.8.6",
28:     "date-fns": "^4.1.0",
29:     "dotenv": "^17.3.1",
30:     "express": "^5.2.1",
31:     "googleapis": "^171.0.0",
32:     "pino": "^10.3.1",
33:     "qrcode": "^1.5.4",
34:     "qrcode-terminal": "^0.12.0"
35:   }
```
- **Inexistência de `devDependencies`**: Não há nenhuma dependência de desenvolvimento declarada.
- **Inexistência de frameworks externos de teste**: Nenhum pacote como `jest`, `mocha`, `vitest`, `supertest`, `cypress`, `playwright`, `chai` ou `sinon` existe no `package.json` ou no `package-lock.json`.
- **Inexistência do script `"test"`**: Executar `npm test` resulta em falha do npm (`npm error Missing script: "test"`). O único comando contendo a palavra test é `"test-finance"`, que executa apenas uma chamada direta de depuração rápida ao `financeService`.

### 1.2 Inventário de Arquivos de Teste no Repositório
A busca pelo sistema de arquivos identificou **41 arquivos de teste em `scripts/`**, **1 arquivo em `raia_multicanal_patch/tests/`**, **1 utilitário de validação estática de sintaxe** e **4 scripts de exploração em `scratch/`**:

| Categoria | Arquivos Identificados | Quantidade | Tamanho Total Aprox. |
| :--- | :--- | :---: | :---: |
| **Segurança e Autenticação** | `test-raia-27-protecoes.js`, `test-admin-mfa-flow.js`, `test-security-audit.js`, `test-integration-security.js`, `test-production-startup-validation.js`, `test-initial-status.js` | 6 | ~227 KB |
| **Isolamento Multi-Tenant & IDOR** | `test-client-isolation.js`, `test-demo-isolation.js`, `test-multiproduct-architecture.js`, `test-portfolio-and-hub.js`, `test-solution-type-filters.js`, `test-staging-client-creation.js` | 6 | ~110 KB |
| **Integrações de Pagamento / Webhooks** | `test-asaas-multichannel.js`, `test-hotmart-2.0-official.js`, `test-hotmart-subscriptions-api.js`, `test-main-sync-reconciliation.js`, `raia_multicanal_patch/tests/test-plan-and-sales.js` | 5 | ~85 KB |
| **Agenda Inteligente & Google Calendar** | `test-smart-schedule-audit.js`, `test-smart-schedule-usability.js`, `test-jessica-smart-schedule.js`, `test-google-calendar-audit.js`, `test-google-calendar-staging-protections.js`, `test-calendar-visual.js`, `test-services-duration.js`, `test-reschedule-status-preservation.js`, `test-reschedule-time-dropdown.js`, `test-intelligent-services.js` | 10 | ~288 KB |
| **Homologação, Regressão & Frontend** | `test-regression-staging-fixes.js`, `test-staging-readiness.js`, `test-phase5-e2e.js`, `test-phase5-http.js`, `test-salon-dashboard-2.0.js`, `test-painel-frontend-fix.js`, `test-modal-suite-010.js`, `test-modal-backdrop.js`, `test-navigation-persistence.js`, `test-anti-flash-jessica.js`, `test-jessica-beauty-theme.js`, `test-jessica-beauty-refinements.js`, `test-theme-transitions.js`, `test-full-lifecycle-audit.js` | 14 | ~310 KB |
| **Validação Estática / Lint Customizado** | `verify-html-syntax.js` | 1 | 0.9 KB |
| **Exploratórios (Ad-hoc Scratchpad)** | `scratch/test_asaas.py`, `scratch/test_tool.py`, `scratch/test_hf_http.py`, `scratch/create_hf_test.py` | 4 | ~3 KB |
| **Total Geral** | — | **46 arquivos** | **> 1.020 KB** |

### 1.3 Padrões Técnicos de Execução dos Testes
1. **Framework e Assertions**: Todos os testes em `scripts/` usam exclusivamente módulos embutidos do Node.js: `const assert = require('assert')` ou `require('node:assert/strict')`. A contagem total de asserções no diretório `scripts/` ultrapassa 2.250 verificações.
2. **Mini Test Runner Embutido**: Cada arquivo declara sua própria função de runner (ex: `function it(name, fn)`, `function test(name, fn)`, contadores `passedTests` e `totalTests`).
3. **Servidor HTTP Efêmero**: Os testes que validam rotas Express sobem uma instância local temporária em porta aleatória do sistema operacional (`const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));`) e realizam requisições com a API global `fetch` do Node.js ou `http.request`.
4. **Isolamento de Banco de Dados**:
   - **Padrão Seguro (Moderno)**: Presente em `scripts/test-raia-27-protecoes.js` (linhas 18-20), `scripts/test-initial-status.js` (linha 28), `scripts/test-google-calendar-staging-protections.js` (linha 29) e `scripts/test-salon-dashboard-2.0.js`. Cria um arquivo descartável via `os.tmpdir()` (`tempDbPath = path.join(os.tmpdir(), ...)`), define `process.env.DB_PATH = tempDbPath` *antes* de carregar `src/config` e remove os arquivos SQLite no final.
   - **Padrão Inseguro (Legado)**: Presente em `scripts/test-client-isolation.js` (linhas 18, 50-60) e `scripts/test-phase5-e2e.js` (linhas 16, 127-135). Importa diretamente `src/database/db` sem redefinir `DB_PATH`, executando comandos `INSERT` e `DELETE` diretamente contra a base operacional configurada (`data/assistant.db`).
5. **Sandbox de Rede Fail-Closed**: Em `scripts/test-google-calendar-staging-protections.js` (linhas 55-70), as funções nativas `http.request` e `https.request` são sobrescritas em memória para disparar exceção imediata caso qualquer teste tente efetuar conexão de rede externa.
6. **Uso de `node:test`**: Em `raia_multicanal_patch/tests/test-plan-and-sales.js` (linhas 2-4), é utilizado o test runner nativo do Node.js (`const { test } = require('node:test')`) com SQLite 100% em memória (`new DatabaseSync(':memory:')`).

### 1.4 Ferramental de Qualidade de Código (QA) e CI/CD
- **Linter**: Não há ESLint, JSHint ou Biome instalado. Não existem arquivos `.eslintrc*` ou `eslint.config.*`. A única checagem de código estático é o script `scripts/verify-html-syntax.js` (linhas 1-33), que lê tags `<script>` de 3 arquivos HTML e usa `new vm.Script(code)` para acusar erros de sintaxe JS.
- **Formatador**: Não há Prettier configurado (nenhum `.prettierrc*` ou `prettier.config.*`).
- **Tipagem Estática**: Não há TypeScript nem `tsconfig.json`. Algumas funções utilizam comentários JSDoc informais, mas não há checagem estática via `tsc --noEmit`.
- **Pipelines de Integração Contínua (CI/CD)**: Não existe o diretório `.github` nem `.github/workflows`. Não há pipeline no GitLab CI, Bitbucket ou CircleCI. A esteira de verificação é 100% manual e descentralizada.

### 1.5 O que ESTÁ Coberto por Testes Automatizados
- **27 Proteções de Segurança OWASP ASVS (`scripts/test-raia-27-protecoes.js`)**:
  - Proteção 01: Autenticação de cliente e administrador com desafio TOTP RFC 6238.
  - Proteção 02: Sanitização de credenciais e chaves de API no `/api/health`.
  - Proteção 03: Integridade SQLite (`PRAGMA integrity_check`) e isolamento por `user_id`.
  - Proteção 04: Redirecionamento HTTPS e neutralização de Host Header Injection.
  - Proteção 05: Derivação de senhas com `scrypt` e salts criptograficamente aleatórios.
  - Proteção 06: Validação de formulários no servidor (tamanho de senhas e sanitização).
  - Proteção 07: Neutralização de XSS em strings e respostas.
  - Proteção 08: Auditoria de segurança sem vazamento de tokens ou segredos em logs.
  - Proteção 09: Barreira estrita de rotas administrativas (401 e 403).
  - Proteção 10: Consultas parametrizadas contra injeção SQL.
  - Proteção 11: Fail-safe boot via `config.validateEnvironment` abortando em produção se segredos faltarem.
  - Proteção 12: Rate limiting com sliding window e resposta HTTP 429 com `Retry-After`.
  - Proteção 13: Restrição de CORS com whitelist de domínios exatos.
  - Proteção 14: Cabeçalhos HTTP de defesa (`nosniff`, `SAMEORIGIN`, CSP Report-Only).
  - Proteção 15: Cookies `HttpOnly` com `SameSite=Lax`.
  - Proteção 16: Proteção anti-CSRF via validação de `Origin`/`Referer` e token duplo.
  - Proteção 17: Links mágicos de uso único com expiração e destruição imediata após consumo.
  - Proteção 18: Inexistência de rotas públicas de upload desprotegidas.
  - Proteção 19: Webhooks Asaas com segregação multiproduto (inadimplência ou cancelamento de um produto não afeta outro).
  - Proteção 20: Desativação de stack traces no handler centralizado de erros em produção.
  - Proteção 21 a 27: Auditoria de dependências, bloqueio de arquivos sensíveis (`.env`, `.git`, `.db`), ausência de credenciais no `.env.example`, rotação e comprovação automatizada.
- **Fluxo de MFA / TOTP Admin (`scripts/test-admin-mfa-flow.js`)**:
  - Geração local de QR Code sem chamadas de rede externas.
  - Setup, confirmação de senha mestra, geração e consumo de 8 códigos de recuperação de uso único.
  - Prevenção contra ataques de replay e criptografia do segredo TOTP em repouso (`enc:v1:`).
- **Isolamento de Dados Multi-Tenant & IDOR (`scripts/test-client-isolation.js`)**:
  - Garantia de que Cliente A não visualiza, altera ou remove dados do Cliente B.
  - Bloqueio de tokens de clientes comuns tentando acessar rotas `/api/admin`.
- **Motor de Agendamento do Salão & Concorrência (`scripts/test-smart-schedule-audit.js`)**:
  - Prevenção de conflito de horários (double-booking).
  - Resiliência das filas `google_sync_outbox` e `whatsapp_notification_outbox`.
  - Reconciliação e recuperação de tarefas abandonadas após reinicialização do container.

### 1.6 O que NÃO ESTÁ Coberto (Gaps Críticos Identificados)
1. **Core do WhatsApp Baileys (`src/whatsapp/client.js`)**: **0 testes automatizados**. Nenhuma verificação de reconexão automática, expiração de QR Code, persistência de credenciais de sessão ou tratamento de queda de socket.
2. **Processador Central de Mensagens (`src/whatsapp/messageHandler.js`)**: **0 testes automatizados**. Trata-se de um arquivo com **2.595 linhas e 123 KB** que processa mensagens recebidas, áudios, imagens, comandos administrativos e transcrições. Não há testes unitários para a extração regex de intenções, emissão de convites, nem simulação de payloads do Baileys.
3. **Serviços de IA e Comportamento dos Agentes (`src/services/aiService.js`, `src/services/agentChatService.js`)**: **0 testes automatizados**. Não há testes de comportamento para avaliar:
   - Respostas geradas pelos modelos Gemini.
   - Tolerância a falhas quando a API da IA falha ou esgota quota.
   - Proteção contra **Prompt Injection** em mensagens enviadas por clientes no WhatsApp.
   - Validação de formato de saída de ferramentas de IA (function calling).
4. **Ciclo de Vida do Outbox Worker (`src/services/outboxWorker.js`)**: Há testes que inserem e leem linhas da tabela `whatsapp_notification_outbox`, mas o loop assíncrono real de polling/timers sob condições de falha contínua não possui teste de estresse contínuo.
5. **Testes E2E de Interface (Navegador Real)**: Não há testes com Playwright, Cypress ou Selenium. O frontend é testado apenas por via de strings HTML, regex ou parsing de scripts com `vm.Script`. Não há testes de clique, renderização responsiva em navegadores mobile ou integridade visual em tempo real.
6. **Orquestração Geral de Testes (`npm test`)**: Falta um script agregador ou harness para disparar a suíte completa de forma automatizada e retornar um exit code determinístico.

---

## 2. Cadeia Lógica (Logic Chain)

1. **Premissa 1 (Dependências)**: Observou-se em `package.json` a ausência total de dependências em `devDependencies` e a ausência de bibliotecas de teste (Jest, Mocha, Vitest, Chai, Supertest).
   - **Dedução**: O projeto adotou a filosofia intencional de "zero dependências de desenvolvimento adicionais", valendo-se dos recursos nativos do ecossistema Node.js (Node 22 `assert`, `http.createServer`, `DatabaseSync`, `fetch`).

2. **Premissa 2 (Scripts de Teste Descentralizados)**: Observou-se a existência de 41 suítes em `scripts/test-*.js`, totalizando mais de 2.250 asserções, porém nenhuma registrada em `package.json["scripts"]`.
   - **Dedução**: Os testes foram criados incrementalmente por engenheiros de segurança e backend como ferramentas pontuais de homologação para branches específicas (notadamente `security/raia-27-protecoes` e correções de staging), operando de forma desacoplada do ciclo padrão `npm test`.

3. **Premissa 3 (Disparidade de Isolamento do SQLite)**: Observou-se que suítes mais recentes (`test-raia-27-protecoes.js`, `test-google-calendar-staging-protections.js`) isolam estritamente o banco criando arquivos temporários em `os.tmpdir()`, enquanto suítes anteriores (`test-client-isolation.js`, `test-phase5-e2e.js`) realizam operações DML diretamente na conexão default do banco.
   - **Dedução**: A infraestrutura de testes sofreu uma evolução de maturidade arquitetural no decorrer da branch `security/raia-27-protecoes`. A coexistência de testes legados não isolados representa um risco operacional grave: se um desenvolvedor rodar `node scripts/test-client-isolation.js` em ambiente de produção, dados sintéticos serão gravados no banco operacional.

4. **Premissa 4 (Abandono do Core de Mensageria e IA nos Testes)**: O arquivo de maior complexidade de fluxo de negócios do WhatsApp (`src/whatsapp/messageHandler.js`, 2.595 linhas) e os módulos de IA (`src/services/aiService.js`, `src/services/agentChatService.js`) possuem zero referências na suíte de testes.
   - **Dedução**: A equipe focou 95% do esforço de testes na camada HTTP/REST, autenticação, multi-tenant e segurança OWASP, deixando o canal primário de entrada do usuário final (o bot conversacional de WhatsApp e suas regras heurísticas) vulnerável a regressões não detectadas.

5. **Premissa 5 (Ausência de Linters, Tipagem e CI/CD)**: Observou-se ausência de `.github/`, ESLint, Prettier e TypeScript.
   - **Dedução**: A integridade do código depende exclusivamente da revisão manual e da execução voluntária de scripts pelos desenvolvedores antes do push, tornando indispensável o papel do *Revisor Técnico Independente* e a futura implementação de esteira automatizada.

---

## 3. Ressalvas (Caveats)

1. **Execução Read-Only**: Em estrita conformidade com as restrições de integridade, nenhum comando de execução de teste (`node scripts/test-*.js`) foi disparado nesta investigação. As conclusões baseiam-se em análise estática minuciosa do código-fonte, mapeamento de chamadas e leitura de asserções.
2. **Ambiente Node.js**: O código faz uso de recursos como `node:sqlite` (`DatabaseSync`), o que exige Node.js versão 22.5.0 ou superior com a flag experimental habilitada ou versões subsequentes do Node.js.
3. **Scripts em `scratch/`**: Scripts Python e JS na pasta `scratch/` contêm chamadas a APIs externas (algumas com credenciais sandbox) e não devem ser considerados testes automatizados do repositório, mas artefatos descartáveis de exploração manual.

---

## 4. Conclusão

1. **Robustez na Camada de Segurança e Backend**: O repositório possui uma base substancial de testes automatizados unitários e de integração embutidos (>2.250 asserções em 41 suítes), cobrindo com excelência as 27 proteções OWASP ASVS, MFA com TOTP, isolamento multi-tenant (IDOR), webhooks transacionais (Asaas e Hotmart) e concorrência na agenda.
2. **Vulnerabilidade Arquitetural nos Testes Legados**: Existe heterogeneidade na forma de execução: suítes legadas não usam banco descartável, podendo contaminar a base local se executadas sem os devidos cuidados.
3. **Ponto Cego Crítico no Produto Final**: O motor de recepção de mensagens do WhatsApp (`src/whatsapp/messageHandler.js`) e os prompts de IA (`src/services/aiService.js`) não possuem nenhum teste automatizado. Uma alteração inadvertida nessas regras pode quebrar o atendimento ao cliente sem que nenhum teste em `scripts/` aponte a falha.
4. **Recomendações Imediatas para a Equipe Permanente**:
   - **Para o Engenheiro de Testes Automatizados**:
     - Padronizar a execução de testes através de um runner unificado baseado no `node:test` nativo (ex: `node --test tests/**/*.test.js`), sem necessidade de adicionar dependências externas pesadas.
     - Migrar suítes legadas (`test-client-isolation.js`, `test-phase5-e2e.js`) para o padrão seguro de `os.tmpdir()` adotado em `test-raia-27-protecoes.js`.
     - Criar uma suíte de testes com mocks do Baileys para validar os fluxos conversacionais e comandos de `src/whatsapp/messageHandler.js`.
     - Implementar testes de avaliação de prompts e mitigação de Prompt Injection para os serviços de IA.
   - **Para o Revisor Técnico Independente**:
     - Estabelecer checklist de revisão estrita para garantir que nenhuma suíte acesse `data/assistant.db` diretamente.
     - Propor configuração mínima de linter (ESLint) e workflow de CI via GitHub Actions para travar pull requests que introduzam quebras ou falhas sintáticas em scripts HTML.

---

## 5. Método de Verificação Independente

Qualquer membro da equipe técnica pode verificar de forma independente as observações e conclusões deste relatório seguindo os passos abaixo:

1. **Verificar Ausência de Frameworks Externos e Scripts de Teste**:
   - Inspecione `package.json` linhas 6 a 35: comprove que não há `devDependencies` e que não há script `"test"`.
   - Inspecione `package-lock.json`: busque por `"jest"`, `"mocha"`, `"vitest"`, `"supertest"` e constate 0 ocorrências.

2. **Verificar os 41 Arquivos de Teste em `scripts/`**:
   - Liste o diretório `scripts/` filtrando por `test-*.js`: comprove a existência das 41 suítes catalogadas.

3. **Inspecionar a Suíte das 27 Proteções**:
   - Abra `scripts/test-raia-27-protecoes.js`:
     - Verifique linhas 18-20: criação de `tempDbPath` com `os.tmpdir()` e definição de `process.env.DB_PATH`.
     - Verifique linhas 142 a 945: estrutura sequencial validando as 27 proteções de segurança.
     - Verifique linhas 951 a 962: limpeza obrigatória do banco temporário no encerramento.

4. **Inspecionar a Disparidade de Isolamento (Testes Legados)**:
   - Abra `scripts/test-client-isolation.js` linhas 18 e 50-60: constate a chamada direta a `require('../src/database/db')` e a inserção de registros em tabela sem isolamento de arquivo `os.tmpdir()`.

5. **Verificar a Ausência de Testes no WhatsApp e IA**:
   - Efetue busca global por `messageHandler` dentro de `scripts/`: constate 0 referências em asserções de teste.
   - Efetue busca global por `aiService` dentro de `scripts/`: constate 0 testes de chamadas à IA.

6. **Verificar Ausência de CI/CD**:
   - Verifique a raiz do projeto e constate a não existência do diretório `.github` ou arquivos de automação CI.
