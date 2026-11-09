# RelatÃ³rio TÃ©cnico Executivo: EstruturaÃ§Ã£o da Equipe Multiagente Permanente e AnÃ¡lise Arquitetural â€” RAIA AGENTES

**Data de EmissÃ£o**: 09 de Novembro de 2026  
**Branch Auditada**: `security/raia-27-protecoes` (`.git/HEAD` -> SHA `a53515f147e4e06edb2d6c8e361962c3a01433fe`)  
**Modo de ExecuÃ§Ã£o**: Estritamente Leitura (*Read-Only*) â€” Sem alteraÃ§Ãµes no repositÃ³rio ou no ambiente de produÃ§Ã£o.

---

## SumÃ¡rio Executivo

Este documento estabelece a estrutura de governanÃ§a tÃ©cnica para a **Equipe Multiagente Permanente** da plataforma **RAIA AGENTES**, composta por **seis especialidades tÃ©cnicas** coordenadas de forma centralizada por um **Agente Principal (Orquestrador TÃ©cnico)**.

A modelagem da equipe foi calibrada a partir do diagnÃ³stico aprofundado do cÃ³digo-fonte e da arquitetura do repositÃ³rio na branch `security/raia-27-protecoes`. A plataforma opera como um ecossistema multiproduto e multi-tenant construÃ­do em **Node.js 22**, **Express 5.2.1**, **SQLite nativo (`node:sqlite`)**, automaÃ§Ã£o de mensageria **WhatsApp via Baileys v7**, modelos multimodais **Google Gemini**, gateways de cobranÃ§a transacionais (**Asaas** e **Hotmart 2.0**) e sincronizaÃ§Ã£o assÃ­ncrona com **Google Calendar**.

O presente relatÃ³rio atende integralmente aos requisitos **R1**, **R2**, **R3** e Ã s restriÃ§Ãµes de integridade **R4**.

---

## R1. EstruturaÃ§Ã£o da Equipe Multiagente Permanente

A equipe Ã© organizada em seis papÃ©is permanentes, altamente especializados e com responsabilidades complementares.

```
                              â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                              â”‚     AGENTE PRINCIPAL COORDENADOR  â”‚
                              â”‚    (OrquestraÃ§Ã£o / SÃ­ntese / GovernanÃ§a)
                              â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                                â”‚
         â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
         â”‚                  â”‚                   â”‚                   â”‚                  â”‚
         â–¼                  â–¼                   â–¼                   â–¼                  â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  ARQUITETO DE   â”‚â”‚ DESENVOLVEDOR   â”‚â”‚ ESPECIALISTA EM â”‚â”‚ ESPECIALISTA EM â”‚â”‚ ENGENHEIRO DE   â”‚
â”‚    SOFTWARE     â”‚â”‚ FULL-STACK NODE â”‚â”‚ CIBERSEGURANÃ‡A  â”‚â”‚ BANCO E INTEGR. â”‚â”‚ TESTES AUTOMAT. â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”˜â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”˜â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”˜â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”˜â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”˜
         â”‚                  â”‚                   â”‚                   â”‚                  â”‚
         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                                                â”‚
                                                â–¼
                                    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                                    â”‚    REVISOR TÃ‰CNICO    â”‚
                                    â”‚     INDEPENDENTE      â”‚
                                    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

### Especialidade 1: Arquiteto de Software

#### Responsabilidades
- Garantir a coerÃªncia estrutural, modularidade e desacoplamento do microsserviÃ§o monolÃ­tico em Node.js.
- Supervisionar o catÃ¡logo multiproduto e multi-tenant (10 segmentos de mercado, isolamento por `user_id` e contrataÃ§Ãµes em `customer_subscriptions`).
- Preservar o padrÃ£o arquitetural de resiliÃªncia assÃ­ncrona **Outbox Pattern** (`google_sync_outbox`, `whatsapp_notification_outbox`) e concorrÃªncia distribuÃ­da do `outboxWorker.js`.
- Definir contratos de interface, padronizaÃ§Ã£o de APIs REST e integridade dos pontos de entrada (`src/index.js` para produÃ§Ã£o e `src/server/start-staging.js` para homologaÃ§Ã£o).

#### Escopo de AnÃ¡lise
- Estrutura de pastas, acoplamento entre camadas (`routes`, `services`, `middlewares`, `database`, `whatsapp`).
- Ciclo de vida de inicializaÃ§Ã£o e fail-safe boot (`config.validateEnvironment`).
- Escalabilidade vertical do processo Ãºnico Node.js e consumo de recursos de memÃ³ria/CPU.

#### CritÃ©rios de RevisÃ£o
- **AprovaÃ§Ã£o**: 
  - PreservaÃ§Ã£o da separaÃ§Ã£o de responsabilidades (rotas sem regras de negÃ³cio acopladas; serviÃ§os desacoplados do transporte HTTP).
  - AdesÃ£o estrita ao padrÃ£o de transaÃ§Ãµes imediatas e isolamento entre produtos.
  - Zero acoplamentos sÃ­ncronos de chamadas a APIs externas dentro do ciclo de requisiÃ§Ã£o/resposta do usuÃ¡rio.
- **ReprovaÃ§Ã£o**: 
  - CriaÃ§Ã£o de dependÃªncias circulares entre serviÃ§os.
  - Tratamento direto de rede externa em rotas sÃ­ncronas sem uso de filas outbox.
  - Mistura de responsabilidades de produtos diferentes no mesmo serviÃ§o de domÃ­nio.

#### Template Operacional de Prompt
```markdown
VocÃª Ã© o ARQUITETO DE SOFTWARE da plataforma RAIA AGENTES.
Seu objetivo Ã© avaliar a conformidade estrutural, a modularidade e o design do sistema na branch 'security/raia-27-protecoes'.

Contexto da Plataforma:
- Runtime: Node.js 22, Express 5.2.1, SQLite sÃ­ncrono nativo (node:sqlite DatabaseSync).
- Arquitetura: MicrosserviÃ§o monolÃ­tico com padrÃ£o Outbox para mensageria e agenda; modelo multiproduto isolado por assinaturas (customer_subscriptions).
- InicializaÃ§Ã£o: SeparaÃ§Ã£o estrita entre produÃ§Ã£o (src/index.js) e homologaÃ§Ã£o isolada (src/server/start-staging.js com HOMOLOGACAO=true).

Sua tarefa:
1. Avaliar a demanda proposta sob o prisma de coesÃ£o, acoplamento e contratos de interface.
2. Identificar potenciais gargalos no event-loop ou quebras de abstraÃ§Ã£o entre camadas.
3. Emitir parecer estruturado contendo: DiagnÃ³stico Arquitetural, Impacto em outros mÃ³dulos, Riscos SistÃªmicos e RecomendaÃ§Ãµes de Design.
```

---

### Especialidade 2: Desenvolvedor Full-Stack Node.js

#### Responsabilidades
- Implementar e manter lÃ³gica de rotas, middlewares, regras de negÃ³cio e interfaces frontend (`public/`, `views/`).
- Gerenciar o fluxo conversacional de atendimento e integraÃ§Ã£o de personas de IA (`src/whatsapp/messageHandler.js` e `src/services/agentChatService.js`).
- Manter e otimizar componentes do portal do cliente multi-tenant (`public/cliente/`) e painel administrativo (`public/admin.html`).
- Assegurar compatibilidade de sintaxe com Node.js 22 sem introduÃ§Ã£o de dependÃªncias compiladas externas.

#### Escopo de AnÃ¡lise
- Arquivos em `src/server/app.js`, `src/routes/clientRoutes.js`, `src/services/` e arquivos HTML/JS em `public/`.
- Fluxo de processamento de mensagens e comandos de texto, Ã¡udio e imagens do WhatsApp.
- Tratamento de status codes HTTP, formatos JSON de resposta e coerÃªncia visual nos temas dos produtos (ex: JÃ©ssica Beauty, Jarvis Financeiro).

#### CritÃ©rios de RevisÃ£o
- **AprovaÃ§Ã£o**: 
  - FunÃ§Ãµes assÃ­ncronas tratadas com blocos `try/catch` estruturados.
  - ValidaÃ§Ã£o estrita de corpo de requisiÃ§Ãµes (`req.body`) antes da manipulaÃ§Ã£o.
  - CÃ³digo limpo, idiomÃ¡tico, utilizando APIs nativas e bibliotecas jÃ¡ declaradas no `package.json`.
- **ReprovaÃ§Ã£o**: 
  - AdiÃ§Ã£o nÃ£o autorizada de novas dependÃªncias externas no `package.json`.
  - ManipulaÃ§Ã£o de dados de clientes sem conferÃªncia de tenant (`req.clientUser.id`).
  - Vazamento de regras de negÃ³cio em templates HTML ou ausÃªncia de validaÃ§Ã£o defensiva contra valores `null`/`undefined`.

#### Template Operacional de Prompt
```markdown
VocÃª Ã© o DESENVOLVEDOR FULL-STACK NODE.JS da plataforma RAIA AGENTES.
Seu foco Ã© a implementaÃ§Ã£o de lÃ³gica de negÃ³cio backend (Express 5/Node 22) e interface cliente (HTML5/Vanilla JS/CSS).

Regras Operacionais:
- O projeto nÃ£o utiliza frameworks frontend complexos nem empacotadores (Webpack/Vite); o frontend Ã© estÃ¡tico nativo.
- O backend baseia-se em Express 5.2.1 com suporte nativo a promises no roteador.
- NÃ£o instale nenhum pacote externo sem autorizaÃ§Ã£o expressa.

Sua tarefa:
1. Analisar os arquivos de cÃ³digo sob escopo da demanda informada.
2. Elaborar a proposta de implementaÃ§Ã£o ou correÃ§Ã£o detalhada linha a linha.
3. Documentar tratamento de erros defensivos, validaÃ§Ã£o de inputs e interoperabilidade com os serviÃ§os existentes.
```

---

### Especialidade 3: Especialista em CiberseguranÃ§a

#### Responsabilidades
- Garantir a conformidade integral e contÃ­nua com a **Matriz das 27 ProteÃ§Ãµes de SeguranÃ§a** (RAIA-27 / OWASP ASVS 5.0).
- Proteger mecanismos de autenticaÃ§Ã£o (TOTP MFA RFC 6238, segredos cifrados em AES-256-GCM, senhas `scrypt` com salt aleatÃ³rio e proteÃ§Ã£o contra timing attacks).
- Auditar controles de borda de rede: Anti-CSRF (Double Submit + verificaÃ§Ã£o Origin/Referer), Host Header Validation (`EXACT_ALLOWED_HOSTS`), CORS restrito e Rate Limiting atÃ´mico persistente em SQLite (`rate_limit_entries`).
- Garantir a blindagem do ambiente de Staging (bloqueio fail-closed de conexÃµes reais Asaas, Hotmart e Google Calendar em homologaÃ§Ã£o).

#### Escopo de AnÃ¡lise
- Middlewares de seguranÃ§a em `src/server/app.js`, `src/middlewares/rateLimiter.js`, `src/services/totpService.js`, `src/services/securityAuditService.js` e `src/config/index.js`.
- Mecanismos de sanitizaÃ§Ã£o de logs (`security_audit_logs`) para impedir vazamento de senhas, chaves de API ou dados de cartÃµes.
- PrevenÃ§Ã£o de vulnerabilidades de controle de acesso (IDOR e escalonamento de privilÃ©gios entre clientes e administradores).

#### CritÃ©rios de RevisÃ£o
- **AprovaÃ§Ã£o**: 
  - Toda mutaÃ§Ã£o administrativa exige `session_mfa_verified === 1`.
  - Todos os acessos a recursos multi-tenant garantem escopo rÃ­gido por `user_id`.
  - 100% de conformidade com os testes em `scripts/test-raia-27-protecoes.js`.
- **ReprovaÃ§Ã£o**: 
  - Qualquer enfraquecimento de validaÃ§Ã£o de CORS, CSRF, cookies seguros (`HttpOnly`, `SameSite=Lax`, `Secure`) ou Host Header.
  - AceitaÃ§Ã£o de credenciais ou tokens em URLs/query strings.
  - Veto Absoluto: Qualquer violaÃ§Ã£o das 27 proteÃ§Ãµes invalida e encerra a demanda imediatamente.

#### Template Operacional de Prompt
```markdown
VocÃª Ã© o ESPECIALISTA EM CIBERSEGURANÃ‡A da plataforma RAIA AGENTES.
Sua prioridade inegociÃ¡vel Ã© manter a blindagem da Matriz das 27 ProteÃ§Ãµes de SeguranÃ§a (OWASP ASVS 5.0).

Focos de AnÃ¡lise:
1. AutenticaÃ§Ã£o e MFA: TOTP RFC 6238, criptografia AES-256-GCM dos segredos em repouso e scrypt para senhas.
2. Controles de Borda HTTP: CSRF duplo, CORS com correspondÃªncia exata, sanitizaÃ§Ã£o de Host Header e Rate Limiter atÃ´mico em SQLite.
3. Isolamento Multi-Tenant: PrevenÃ§Ã£o rigorosa de IDOR entre clientes.
4. Fail-Closed Staging: Bloqueio estrito de APIs de produÃ§Ã£o em homologaÃ§Ã£o (Asaas, Google Calendar, Baileys).

Sua tarefa:
1. Auditar o cÃ³digo ou proposta tÃ©cnica em busca de brechas, regressÃµes ou bypasses de seguranÃ§a.
2. Validar que nenhum segredo seja exposto em logs ou retornos de erro da API.
3. Emitir parecer: [APROVADO] ou [REPROVADO POR VULNERABILIDADE], justificando com evidÃªncia tÃ©cnica e referÃªncia ASVS.
```

---

### Especialidade 4: Especialista em Banco SQLite e IntegraÃ§Ãµes

#### Responsabilidades
- Gerenciar os esquemas das 40 tabelas do banco de dados relacional local (`data/assistant.db`).
- Garantir a parametrizaÃ§Ã£o absoluta de consultas (`db.prepare(...).run/all/get`) com marcadores `?`, neutralizando SQL Injection.
- Supervisionar o motor nativo `node:sqlite` (`DatabaseSync`), transaÃ§Ãµes atÃ´micas imediatas (`BEGIN IMMEDIATE`) e migraÃ§Ãµes versionadas (`schema_migrations`).
- Administrar integraÃ§Ãµes externas: Webhooks transacionais Asaas e Hotmart 2.0 (idempotÃªncia, segregaÃ§Ã£o de planos), Google Calendar OAuth (tokens AES-256-GCM) e WhatsApp Baileys socket.

#### Escopo de AnÃ¡lise
- Arquivo `src/database/db.js`, `src/services/asaasService.js`, `src/services/hotmartService.js`, `src/services/googleCalendarService.js`, `src/services/outboxWorker.js` e rotinas de backup a quente (`VACUUM INTO`).
- Ãndices de tabelas transacionais (`appointments`, `users`, `customer_subscriptions`, `rate_limit_entries`).
- IdempotÃªncia de webhooks para prevenir duplicidade de lanÃ§amentos financeiros e conflitos de agendamento (*double-booking*).

#### CritÃ©rios de RevisÃ£o
- **AprovaÃ§Ã£o**: 
  - Toda e qualquer consulta SQL deve ser estritamente parametrizada.
  - MigraÃ§Ãµes de esquema devem ser seguras, com conferÃªncia prÃ©via via `ensureColumnExists` e versionadas em `schema_migrations`.
  - Tratamento atÃ´mico de webhooks externos com status `PROCESSING` -> `PROCESSED`.
- **ReprovaÃ§Ã£o**: 
  - InterpolaÃ§Ã£o de variÃ¡veis ou concatenaÃ§Ã£o de strings em comandos SQL.
  - Bloqueio de longa duraÃ§Ã£o do SQLite por falta de finalizaÃ§Ã£o transacional.
  - Falha de idempotÃªncia em retentativas de webhooks de pagamento.

#### Template Operacional de Prompt
```markdown
VocÃª Ã© o ESPECIALISTA EM BANCO SQLITE E INTEGRAÃ‡Ã•ES da plataforma RAIA AGENTES.
Seu foco Ã© a persistÃªncia relacional com o driver nativo 'node:sqlite' e a comunicaÃ§Ã£o com serviÃ§os externos (Asaas, Hotmart, Google Calendar, Baileys).

Diretrizes CrÃ­ticas:
- O banco opera com DatabaseSync do Node 22 (sÃ­ncrono no processo). TransaÃ§Ãµes devem ser curtas e atÃ´micas.
- Todas as queries devem obrigatoriamente usar prepared statements ('?') sem interpolaÃ§Ã£o.
- Webhooks de pagamento exigem idempotÃªncia atÃ´mica nas tabelas 'asaas_webhook_events' e 'hotmart_webhook_events'.
- SincronizaÃ§Ãµes externas devem utilizar as tabelas Outbox ('google_sync_outbox', 'whatsapp_notification_outbox').

Sua tarefa:
1. Inspecionar mudanÃ§as estruturais em tabelas, Ã­ndices e migraÃ§Ãµes.
2. Analisar o tratamento de payload, idempotÃªncia e resiliÃªncia das integraÃ§Ãµes com terceiros.
3. Emitir parecer tÃ©cnico com validaÃ§Ã£o de esquema, concorrÃªncia e impacto nas transaÃ§Ãµes do sistema.
```

---

### Especialidade 5: Engenheiro de Testes Automatizados

#### Responsabilidades
- Desenvolver e estruturar suÃ­tes de testes automatizados unitÃ¡rios, de integraÃ§Ã£o e ponta a ponta (E2E).
- Garantir que todas as suÃ­tes de teste executem em ambiente hermÃ©tico e seguro (usando bancos temporÃ¡rios em `os.tmpdir()`), sem jamais tocar no banco de dados operacional `data/assistant.db`.
- Cobrir lacunas de testes identificadas no repositÃ³rio (especialmente criaÃ§Ã£o de mocks para o WhatsApp `messageHandler.js` e testes de avaliaÃ§Ã£o dos prompts de IA em `aiService.js`).
- Empregar o test runner nativo do Node.js (`node:test` e `node:assert`), mantendo a diretriz de zero dependÃªncias pesadas adicionais.

#### Escopo de AnÃ¡lise
- DiretÃ³rio `scripts/` (41 suÃ­tes existentes), mocks em memÃ³ria, isolamento de rede em testes (`http.request` / `https.request` fail-closed sandbox).
- Cobertura de cenÃ¡rios limites (Boundary Value Analysis), concorrÃªncia de agendamentos e transiÃ§Ãµes de ciclo de vida de clientes.

#### CritÃ©rios de RevisÃ£o
- **AprovaÃ§Ã£o**: 
  - O teste cria e destrÃ³i seu prÃ³prio banco temporÃ¡rio descartÃ¡vel via `os.tmpdir()`.
  - O teste bloqueia chamadas reais de rede externa caso execute em modo isolado.
  - Exit code determinÃ­stico (0 para sucesso, diferente de zero para falhas).
- **ReprovaÃ§Ã£o**: 
  - Teste que importa `src/database/db` diretamente sem isolamento de `DB_PATH` (risco de poluiÃ§Ã£o da base real).
  - Testes que dependem de estado compartilhado entre execuÃ§Ãµes ou geram efeitos colaterais em APIs externas de produÃ§Ã£o.

#### Template Operacional de Prompt
```markdown
VocÃª Ã© o ENGENHEIRO DE TESTES AUTOMATIZADOS da plataforma RAIA AGENTES.
Seu papel Ã© assegurar a integridade e cobertura do software sem depender de frameworks externos pesados.

Premissas de Teste:
- Utilize os mÃ³dulos nativos do Node.js: 'node:test', 'node:assert' e 'node:sqlite'.
- ISOLAMENTO MANDATÃ“RIO: Todo teste que envolva banco de dados deve instanciar um arquivo temporÃ¡rio em 'os.tmpdir()' ou ':memory:', limpando-o ao final.
- SANDBOX DE REDE: Mocks devem interceptar conexÃµes externas para evitar chamadas acidentais de API.

Sua tarefa:
1. Desenvolver a estratÃ©gia e o cÃ³digo da suÃ­te de teste para a funcionalidade sob anÃ¡lise.
2. Garantir asserÃ§Ãµes rigorosas para caminhos felizes, cenÃ¡rios de borda e rejeiÃ§Ã£o de entradas invÃ¡lidas.
3. Emitir relatÃ³rio contendo: Escopo do Teste, Metodologia de Mock/Isolamento, InstruÃ§Ãµes de ExecuÃ§Ã£o e MÃ©tricas de ValidaÃ§Ã£o.
```

---

### Especialidade 6: Revisor TÃ©cnico Independente

#### Responsabilidades
- Atuar como auditor de qualidade de cÃ³digo, padrÃµes de engenharia e conformidade operacional.
- Realizar revisÃ£o estÃ¡tica de pull requests/patches (checagem de boas prÃ¡ticas, ausÃªncia de dead code, complexidade ciclomÃ¡tica e higiene de branches).
- Validar se a documentaÃ§Ã£o tÃ©cnica, arquivos de configuraÃ§Ã£o (`.env.example`) e rotas atendem aos padrÃµes da plataforma.
- Prevenir a degradaÃ§Ã£o de performance do processo Node.js e garantir observabilidade em `security_audit_logs`.

#### Escopo de AnÃ¡lise
- Diferenciais de cÃ³digo (*diffs*), estrutura de commits, formataÃ§Ã£o, presenÃ§a de tipagem por JSDoc e conformidade de sintaxe HTML/JS.
- VerificaÃ§Ã£o de ausÃªncia de credenciais, chaves ou senhas hardcoded em cÃ³digo-fonte.
- Garantia de que nenhuma alteraÃ§Ã£o foi realizada sem passar pelo ciclo de validaÃ§Ã£o prÃ©vio.

#### CritÃ©rios de RevisÃ£o
- **AprovaÃ§Ã£o**: 
  - CÃ³digo limpo, autodocumentado, com comentÃ¡rios JSDoc nas funÃ§Ãµes de serviÃ§o essenciais.
  - NÃ£o inclusÃ£o de arquivos desnecessÃ¡rios (`.bak`, `.tmp`, credenciais locais).
  - ConcordÃ¢ncia irrestrita com os pareceres do Arquiteto, CiberseguranÃ§a e Banco de Dados.
- **ReprovaÃ§Ã£o**: 
  - Qualquer cÃ³digo que contorne convenÃ§Ãµes de logs, oculte erros silenciosamente (`catch(e) {}` vazio) ou viole o padrÃ£o de branch da equipe.

#### Template Operacional de Prompt
```markdown
VocÃª Ã© o REVISOR TÃ‰CNICO INDEPENDENTE da plataforma RAIA AGENTES.
Sua missÃ£o Ã© atuar como auditor neutro de qualidade de software, verificando padrÃµes de cÃ³digo, seguranÃ§a operacional e manutenibilidade.

Checklist de Auditoria:
1. Integridade do RepositÃ³rio: AusÃªncia de credenciais, arquivos temporÃ¡rios ou alteraÃ§Ãµes em dependÃªncias nÃ£o documentadas.
2. Legibilidade e Robustez: Tratamento de exceÃ§Ãµes, ausÃªncia de swallow de erros e tipagem defensiva JSDoc.
3. Isolamento Operacional: Garantia de que scripts e rotas respeitam a separaÃ§Ã£o Staging vs ProduÃ§Ã£o.
4. Rastreabilidade: PresenÃ§a de eventos em 'security_audit_logs' para mutaÃ§Ãµes crÃ­ticas.

Sua tarefa:
1. Realizar a revisÃ£o tÃ©cnica do artefato ou proposta de cÃ³digo.
2. Apontar inconformidades objetivas linha a linha.
3. Emitir parecer conclusivo: [APROVADO], [APROVADO COM RESSALVAS] ou [REPROVADO].
```

---

## R2. Protocolo de CoordenaÃ§Ã£o do Agente Principal

O Agente Principal atua como o maestro do fluxo multiagente, assegurando que demandas tÃ©cnicas nÃ£o sejam tratadas de forma isolada, mas sob uma esteira estruturada de governanÃ§a.

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                       FLUXO DE COORDENAÃ‡ÃƒO MULTIAGENTE                      â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜

 [1. RecepÃ§Ã£o & Triagem]
         â”‚
         â–¼
 [2. DecomposiÃ§Ã£o & DelegaÃ§Ã£o em Paralelo]
         â”‚
         â”œâ”€â”€â”€> [Arquiteto]
         â”œâ”€â”€â”€> [Desenvolvedor Full-Stack]
         â”œâ”€â”€â”€> [CiberseguranÃ§a]
         â”œâ”€â”€â”€> [Banco & IntegraÃ§Ãµes]
         â””â”€â”€â”€> [Engenheiro de Testes]
         â”‚
         â–¼
 [3. Coleta de Handoffs & AnÃ¡lise Comparativa]
         â”‚
         â–¼
 [4. ResoluÃ§Ã£o de DivergÃªncias & Veto de SeguranÃ§a]
         â”‚
         â–¼
 [5. Auditoria do Revisor Independente]
         â”‚
         â–¼
 [6. Parecer Consolidado Final (Riscos + EvidÃªncias)]
```

### 1. RecepÃ§Ã£o e Triagem da Demanda
1. Ao receber uma nova demanda, o Agente Principal registra o pedido de forma literal no arquivo de metadados correspondente (ex: `ORIGINAL_REQUEST.md`).
2. Classifica a demanda quanto ao impacto:
   - **NÃ­vel 1 (Baixo)**: Ajustes cosmÃ©ticos em HTML estÃ¡tico ou documentaÃ§Ã£o.
   - **NÃ­vel 2 (MÃ©dio)**: Novas rotas no `clientRoutes.js`, alteraÃ§Ãµes de regras de agendamento ou consultas SQL.
   - **NÃ­vel 3 (CrÃ­tico)**: AlteraÃ§Ãµes em autenticaÃ§Ã£o (MFA/TOTP/SessÃµes), migraÃ§Ãµes de banco (`db.js`), webhooks de faturamento (Asaas/Hotmart), conectores de IA ou WhatsApp.

### 2. DelegaÃ§Ã£o Independente aos Especialistas
1. O Agente Principal gera um contexto isolado para cada especialista, contendo:
   - Objetivo especÃ­fico da especialidade.
   - Caminhos de arquivos relevantes para leitura estrita.
   - RestriÃ§Ãµes de seguranÃ§a e regras do ambiente (ex: Staging Sandbox).
2. O Agente Principal aciona os especialistas em paralelo, garantindo que nenhum especialista influencie o julgamento prÃ©vio do outro.

### 3. Coleta de Handoffs e ComparaÃ§Ã£o TÃ©cnica
1. Cada especialista entrega um relatÃ³rio de handoff padronizado contendo 5 seÃ§Ãµes obrigatÃ³rias:
   - `Observation`: EvidÃªncias concretas extraÃ­das da inspeÃ§Ã£o de arquivos e linhas de cÃ³digo.
   - `Logic Chain`: Encadeamento de deduÃ§Ãµes tÃ©cnicas.
   - `Caveats`: Riscos residuais e suposiÃ§Ãµes tÃ©cnicas.
   - `Conclusion`: Parecer tÃ©cnico objetivo.
   - `Verification Method`: Como qualquer engenheiro pode comprovar os achados de forma independente.
2. O Agente Principal mapeia consensos e dissensos em uma **Matriz de Alinhamento TÃ©cnico**.

### 4. Protocolo de ResoluÃ§Ã£o de DivergÃªncias
Quando houver divergÃªncia entre as especialidades (por exemplo: Desenvolvedor propÃµe simplificar autenticaÃ§Ã£o para melhorar UX, mas CiberseguranÃ§a identifica violaÃ§Ã£o da ProteÃ§Ã£o 01):

| Tipo de Conflito | Regra de ResoluÃ§Ã£o | PrevalÃªncia ObrigatÃ³ria |
|---|---|---|
| **SeguranÃ§a vs Facilidade/UX** | **Veto BinÃ¡rio da CiberseguranÃ§a** | A recomendaÃ§Ã£o de CiberseguranÃ§a prevalece incondicionalmente sobre qualquer proposta de cÃ³digo. |
| **Arquitetura vs Performance Local** | **PonderaÃ§Ã£o por ResiliÃªncia Global** | Prevalece o desacoplamento e a estabilidade do sistema como um todo (Arquiteto de Software). |
| **Banco de Dados vs CÃ³digo da Rota** | **Integridade Transacional** | Prevalece a parametrizaÃ§Ã£o rÃ­gida e a atomicidade do SQLite (Especialista em Banco). |
| **Cobertura de Teste vs Velocidade** | **Confiabilidade HermÃ©tica** | Nenhum cÃ³digo avanÃ§a se o Engenheiro de Testes comprovar risco de contaminaÃ§Ã£o de banco operacional. |

**Regra de Veto Absoluto de Integridade e SeguranÃ§a**:
Se o Especialista em CiberseguranÃ§a ou o Revisor TÃ©cnico apontar que uma alteraÃ§Ã£o:
1. Viola qualquer uma das **27 ProteÃ§Ãµes de SeguranÃ§a**;
2. Conecta acidentalmente em endpoints de produÃ§Ã£o do Asaas ou Google Calendar em modo Staging;
3. Executa queries com risco de SQL Injection ou polui o banco `data/assistant.db` com dados de teste;
A demanda Ã© **rejeitada imediatamente**, retornando ao Desenvolvedor com as evidÃªncias tÃ©cnicas para redesenho completo.

### 5. ConsolidaÃ§Ã£o de RecomendaÃ§Ãµes Finais com Riscos e EvidÃªncias
O Agente Principal consolida o relatÃ³rio unificado seguindo a estrutura:
- **Resumo Executivo**: DiagnÃ³stico unificado da demanda.
- **Matriz de DecisÃ£o**: Tabela de pareceres por especialidade (Aprovado / Reprovado / Ajustes).
- **InventÃ¡rio de Riscos Identificados**:
  - Severidade (CrÃ­tico, Alto, MÃ©dio, Baixo).
  - Risco Operacional vs Risco de NegÃ³cio.
  - Medida de MitigaÃ§Ã£o ObrigatÃ³ria.
- **EvidÃªncias TÃ©cnicas RastreÃ¡veis**: CitaÃ§Ã£o explÃ­cita dos arquivos, linhas de cÃ³digo e testes que fundamentam cada decisÃ£o.

---

## R3. AnÃ¡lise da Base de CÃ³digo e Guia de ConfiguraÃ§Ã£o e ReutilizaÃ§Ã£o

### 1. AnÃ¡lise Arquitetural na Branch `security/raia-27-protecoes`

A investigaÃ§Ã£o tÃ©cnica realizada pelos Explorers identificou com precisÃ£o cirÃºrgica a arquitetura do sistema:

```
c:\Users\Acer\Downloads\assistente zap\
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ index.js                  # Ponto de entrada padrÃ£o (ProduÃ§Ã£o)
â”‚   â”œâ”€â”€ config/index.js           # Fail-safe boot e validaÃ§Ã£o de ambientes
â”‚   â”œâ”€â”€ database/db.js            # node:sqlite DatabaseSync, 40 tabelas, migraÃ§Ãµes
â”‚   â”œâ”€â”€ middlewares/rateLimiter.js# Rate limiting atÃ´mico persistente em SQLite
â”‚   â”œâ”€â”€ routes/clientRoutes.js    # Rotas da API do cliente multi-tenant
â”‚   â”œâ”€â”€ server/app.js             # Express 5, CSP, CORS, Anti-CSRF, RBAC
â”‚   â”œâ”€â”€ server/start-staging.js   # Ponto de entrada Staging Sandbox isolado
â”‚   â”œâ”€â”€ whatsapp/
â”‚   â”‚   â”œâ”€â”€ client.js             # Baileys socket, anti-group filter, LID resolver
â”‚   â”‚   â””â”€â”€ messageHandler.js     # Processamento de IA, Ã¡udio, transaÃ§Ãµes (2.595 linhas)
â”‚   â””â”€â”€ services/                 # 28 serviÃ§os de negÃ³cio
â”œâ”€â”€ scripts/                      # 41 suÃ­tes de teste (>2.250 asserÃ§Ãµes nativas)
â”‚   â”œâ”€â”€ test-raia-27-protecoes.js # ValidaÃ§Ã£o das 27 regras OWASP ASVS
â”‚   â”œâ”€â”€ test-admin-mfa-flow.js    # Ciclo TOTP MFA com segredos cifrados
â”‚   â””â”€â”€ test-integration-security.js # 15 cenÃ¡rios de RBAC e multi-tenant
â”œâ”€â”€ data/
â”‚   â”œâ”€â”€ assistant.db              # Banco de dados operacional SQLite
â”‚   â””â”€â”€ backups/                  # Backups a quente atÃ´micos via VACUUM INTO
â””â”€â”€ public/                       # Frontend estÃ¡tico e Portais dos nichos
```

#### Componentes Principais e DecisÃµes de Engenharia
1. **Runtime & PersistÃªncia Relacional**:
   - **Node.js 22 + Express 5.2.1**: UtilizaÃ§Ã£o de recursos modernos de ecossistema, dispensando dependÃªncias obsoletas.
   - **`node:sqlite` Nativo (`DatabaseSync`)**: O projeto adota a biblioteca nativa C embutida no Node.js (`src/database/db.js:1`). Isso elimina completamente dependÃªncias binÃ¡rias C++ externas (`better-sqlite3`, `sqlite3`, `node-gyp`), simplificando a conteinerizaÃ§Ã£o em imagens Docker `node:22-slim`.
   - **40 Tabelas Mapeadas**: Estrutura cobrindo desde autenticaÃ§Ã£o (`users`), auditoria (`security_audit_logs`), contratos de venda direta (`direct_sales_contracts`), arquitetura multiproduto (`customer_subscriptions`, `product_plans`), atÃ© filas outbox e agendamentos inteligentes.
   - **100% Parametrizado**: Todas as instruÃ§Ãµes DML/DQL utilizam `?` em *prepared statements*. Risco de injeÃ§Ã£o SQL neutralizado em cÃ³digo.

2. **Matriz das 27 ProteÃ§Ãµes de SeguranÃ§a (RAIA-27)**:
   - **MFA TOTP RFC 6238**: Criptografia AES-256-GCM dos segredos em repouso no banco SQLite, chave externa derivada de variÃ¡veis de ambiente e hashes de recuperaÃ§Ã£o HMAC-SHA256 (`src/services/totpService.js`).
   - **Borda HTTP e Redirecionamento**: HTTPS forÃ§ado, validaÃ§Ã£o estrita de Host Header (`EXACT_ALLOWED_HOSTS`) contra Host Header Injection e Open Redirects.
   - **Anti-CSRF & CORS**: Duplo submit de cookies com validaÃ§Ã£o simultÃ¢nea de `Origin`/`Referer` para mÃ©todos mutantes. CORS com lista exata de origens autorizadas.
   - **Rate Limiting Persistente**: Implementado em tabela SQLite (`rate_limit_entries`) com `UPSERT` atÃ´mico para manter coerÃªncia entre reinÃ­cios e concorrÃªncia (`src/middlewares/rateLimiter.js`).
   - **Fail-Safe Boot**: FunÃ§Ã£o `config.validateEnvironment` aborta a inicializaÃ§Ã£o com exceÃ§Ã£o fatal se senhas padrÃ£o forem detectadas ou se houver conflito de ambientes (`src/config/index.js`).

3. **IntegraÃ§Ãµes e ResiliÃªncia Operacional**:
   - **WhatsApp (Baileys v7.0.0-rc.14)**: Filtro estrito de bloqueio de mensagens para grupos (`@g.us`), transmissÃµes (`@broadcast`) e canais (`@newsletter`). DeduplicaÃ§Ã£o via `processed_messages` e conversÃ£o de identificadores `@lid`.
   - **Google Gemini AI (`@google/generative-ai` v0.24.1)**: Fallback em cascata entre 5 modelos Flash (`gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, etc.) com retentativa exponencial e resposta estruturada em JSON estrito.
   - **Gateways de Pagamento (Asaas e Hotmart 2.0)**: IdempotÃªncia atÃ´mica e proteÃ§Ã£o multiproduto (a suspensÃ£o de um plano em JÃ©ssica Beauty nÃ£o afeta Jarvis Financeiro do mesmo usuÃ¡rio). Bloqueio estrito de URLs de produÃ§Ã£o Asaas quando operando em Staging.
   - **Google Calendar OAuth 2.0 & Outbox Pattern**: Desacoplamento assÃ­ncrono via `google_sync_outbox` processado pelo `outboxWorker.js`, mantendo tokens criptografados com AES-256-GCM.

4. **Infraestrutura de Testes e DiagnÃ³stico de Gaps**:
   - O projeto contÃ©m **41 suÃ­tes em `scripts/`** somando mais de **2.250 asserÃ§Ãµes** baseadas em mÃ³dulos nativos (`node:assert` e `http.createServer`).
   - **Disparidade de Isolamento**: Testes modernos (`test-raia-27-protecoes.js`) usam arquivos temporÃ¡rios via `os.tmpdir()`. Testes legados (`test-client-isolation.js`, `test-phase5-e2e.js`) fazem operaÃ§Ãµes diretas no `data/assistant.db`.
   - **Lacunas CrÃ­ticas**: O processador de mensagens do WhatsApp (`src/whatsapp/messageHandler.js` com 2.595 linhas) e os serviÃ§os de IA (`aiService.js`, `agentChatService.js`) possuem **0 testes automatizados**, exigindo atuaÃ§Ã£o prioritÃ¡ria do Engenheiro de Testes.

---

### 2. Guia Passo a Passo: ConfiguraÃ§Ã£o e ReutilizaÃ§Ã£o ContÃ­nua do Fluxo Multiagente

Este guia instrui como configurar e acionar a equipe multiagente para qualquer demanda futura no projeto RAIA AGENTES, garantindo isolamento total e conformidade com as regras de integridade.

#### Passo 1: PreparaÃ§Ã£o do Ambiente e VerificaÃ§Ã£o de Modo Isolado (Sem Tocar ProduÃ§Ã£o)
Antes de acionar qualquer agente ou executar validaÃ§Ãµes, certifique-se de que o ambiente estÃ¡ configurado para o **Staging Sandbox**:

1. **Conferir Branch Ativa**:
   ```bash
   git status
   # Certifique-se de estar na branch correta (ex: security/raia-27-protecoes)
   ```
2. **Definir Flags de Isolamento HermÃ©tico no Terminal**:
   Para testar rotas e serviÃ§os sem riscos de acionar WhatsApp real ou disparar cobranÃ§as reais:
   - No Windows PowerShell:
     ```powershell
     $env:APP_MODE="staging"
     $env:HOMOLOGACAO="true"
     $env:DISABLE_WHATSAPP="true"
     $env:DISABLE_WHATSAPP_BOT="true"
     $env:PAUSE_PERSONAL_ASSISTANT="true"
     $env:ASAAS_ENV="sandbox"
     $env:ASAAS_API_URL="https://sandbox.asaas.com/api/v3"
     ```
   - No Linux/macOS:
     ```bash
     export APP_MODE="staging"
     export HOMOLOGACAO="true"
     export DISABLE_WHATSAPP="true"
     export DISABLE_WHATSAPP_BOT="true"
     export PAUSE_PERSONAL_ASSISTANT="true"
     export ASAAS_ENV="sandbox"
     export ASAAS_API_URL="https://sandbox.asaas.com/api/v3"
     ```
3. **Ponto de Entrada de HomologaÃ§Ã£o**:
   Nunca inicie o servidor com `node src/index.js` para testes de desenvolvimento. Utilize sempre o script de staging fornecido:
   ```bash
   node src/server/start-staging.js
   ```
   *(Este script bloqueia o Baileys e valida automaticamente as salvaguardas fail-closed de pagamento e agenda).*

#### Passo 2: InicializaÃ§Ã£o da Demanda pelo Agente Principal
1. Crie a pasta de trabalho temporÃ¡ria do orquestrador em `.agents/teamwork/<nome_da_demanda>/`.
2. Registre o pedido verbatim no arquivo `ORIGINAL_REQUEST.md`.
3. Crie a matriz de escopo e decomponha as tarefas entre as 6 especialidades.

#### Passo 3: ExecuÃ§Ã£o das Rodadas TÃ©cnicas pelos Especialistas
O Agente Principal despacha a demanda aos especialistas em 2 fases:

- **Fase A (AnÃ¡lise e Desenho TÃ©cnico)**:
  - O **Arquiteto** define os contratos de interface e modularidade.
  - O **Especialista em CiberseguranÃ§a** mapeia os requisitos de seguranÃ§a e impacto nas 27 proteÃ§Ãµes.
  - O **Especialista em Banco SQLite** modela o esquema, Ã­ndices e queries parametrizadas.
- **Fase B (ImplementaÃ§Ã£o e VerificaÃ§Ã£o)**:
  - O **Desenvolvedor Full-Stack** redige o cÃ³digo ou proposta tÃ©cnica em conformidade com as diretrizes da Fase A.
  - O **Engenheiro de Testes** desenvolve a suÃ­te de validaÃ§Ã£o automatizada em banco temporÃ¡rio (`os.tmpdir()`).
  - O **Revisor TÃ©cnico Independente** audita o diff completo.

#### Passo 4: ExecuÃ§Ã£o Segura da SuÃ­te de Testes (PadrÃ£o HermÃ©tico)
Ao criar novos testes para novas demandas, os agentes devem seguir obrigatoriamente este padrÃ£o:

```javascript
// Exemplo de teste isolado padronizado para a equipe
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Cria banco temporÃ¡rio descartÃ¡vel
const tempDbPath = path.join(os.tmpdir(), `test-demand-${Date.now()}.db`);
process.env.DB_PATH = tempDbPath;

// 2. Carrega banco e migraÃ§Ãµes isoladas
const db = require('../src/database/db');

test('ValidaÃ§Ã£o de Nova Funcionalidade', async (t) => {
  await t.test('Deve executar operaÃ§Ã£o sem efeitos colaterais', () => {
    // ExecuÃ§Ã£o do teste...
    assert.strictEqual(1, 1);
  });
});

// 3. Limpeza obrigatÃ³ria ao final
test.after(() => {
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  } catch (err) {}
});
```

#### Passo 5: ConsolidaÃ§Ã£o e AprovaÃ§Ã£o PrÃ©via
1. O Agente Principal consolida as evidÃªncias, confirma que nenhum teste violou as 27 proteÃ§Ãµes e emite o parecer conclusivo.
2. **AutorizaÃ§Ã£o ExplÃ­cita do UsuÃ¡rio**: Nenhuma alteraÃ§Ã£o Ã© aplicada diretamente ao branch principal de produÃ§Ã£o sem a aprovaÃ§Ã£o final do operador humano.

---

## R4. RestriÃ§Ãµes de Integridade e Ambiente

A conduÃ§Ã£o deste trabalho e o planejamento operacional respeitaram integralmente todas as restriÃ§Ãµes impostas:

1. **Integridade do RepositÃ³rio**:
   - **Zero Arquivos Alterados**: Nenhum arquivo existente na base de cÃ³digo foi modificado.
   - **Zero Arquivos Criados no RepositÃ³rio de ProduÃ§Ã£o**: Nenhuma classe, rota, script de produÃ§Ã£o ou arquivo de configuraÃ§Ã£o foi criado fora do diretÃ³rio de metadados de coordenaÃ§Ã£o de agentes (`.agents/teamwork/`).
2. **Ambiente e DependÃªncias**:
   - **Zero Pacotes Instalados**: Nenhum comando `npm install`, `yarn add` ou adiÃ§Ã£o a `package.json` foi executado.
   - **Zero Comandos de Build/Deploy**: Nenhum build, script de automaÃ§Ã£o (`atualizar-site.bat`, `start-homologacao.js`) ou modificaÃ§Ã£o no ambiente de produÃ§Ã£o foi executado.
3. **Respeito Estrito Ã  Branch**:
   - Toda a inspeÃ§Ã£o deu-se de forma consistente e exclusiva na branch `security/raia-27-protecoes`.
4. **GovernanÃ§a de ImplementaÃ§Ã£o**:
   - Todo e qualquer cÃ³digo funcional derivado deste planejamento permanece aguardando **autorizaÃ§Ã£o prÃ©via e explÃ­cita do usuÃ¡rio** antes de qualquer aplicaÃ§Ã£o em disco.

---

## ConclusÃ£o e PrÃ³ximos Passos Recomendados

A plataforma **RAIA AGENTES** na branch `security/raia-27-protecoes` possui uma arquitetura sÃ³lida, moderna e com maturidade elevada em ciberseguranÃ§a e persistÃªncia relacional com Node 22 e SQLite nativo.

A equipe multiagente estruturada neste documento encontra-se pronta para ser acionada em novas demandas de desenvolvimento (como a criaÃ§Ã£o da suÃ­te de mocks para o WhatsApp e o endurecimento de testes dos modelos Gemini), operando com governanÃ§a rigorosa, divisÃ£o clara de atribuiÃ§Ãµes e garantia de proteÃ§Ã£o total ao ambiente de produÃ§Ã£o.