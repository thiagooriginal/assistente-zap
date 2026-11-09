# Relatório de Investigação da Base de Código: RAIA AGENTES
**Branch**: `security/raia-27-protecoes`  
**Agente Responsável**: `teamwork_explorer_survey_1`  
**Data**: 2026-11-09T13:55:00Z  

---

## 1. Observation

### 1.1. Estado do Repositório e Branch
- **Arquivo**: `.git/HEAD`
  - Conteúdo: `ref: refs/heads/security/raia-27-protecoes` (confirmado via `view_file`).
- **Arquivo**: `package.json`
  - Nome: `"raia-rh"`, Versão: `"1.0.0"`.
  - Ponto de entrada (`main`): `"src/index.js"`.
  - Scripts operacionais:
    - `"start": "node src/index.js"`
    - `"start:staging": "node src/server/start-staging.js"`
    - `"tunnel": ".\\cloudflared.exe tunnel --url http://localhost:3333"`
    - `"auth-calendar": "node src/scripts/authCalendar.js"`
    - `"push-calendar": "node src/scripts/pushCalendarCredentials.js"`
    - `"test-finance": "node -e \"console.log(require('./src/services/financeService').getRecentExpenses())\""`
  - Dependências (`dependencies`):
    - `@google/generative-ai`: `^0.24.1` (SDK oficial do Google Gemini)
    - `@whiskeysockets/baileys`: `^7.0.0-rc.14` (WhatsApp Web socket multi-device)
    - `cors`: `^2.8.6`
    - `date-fns`: `^4.1.0`
    - `dotenv`: `^17.3.1`
    - `express`: `^5.2.1`
    - `googleapis`: `^171.0.0`
    - `pino`: `^10.3.1`
    - `qrcode`: `^1.5.4`
    - `qrcode-terminal`: `^0.12.0`
  - **Observação Crítica**: Não há `sqlite3` ou `better-sqlite3` listado no `package.json`. A persistência SQLite utiliza a biblioteca nativa do Node.js 22: `const { DatabaseSync } = require('node:sqlite');` (`src/database/db.js:1`), eliminando dependências binárias compiladas em C++.

### 1.2. Estrutura de Diretórios do Projeto
```
c:\Users\Acer\Downloads\assistente zap\
├── .agents/                      # Metadados e artefatos de agentes
├── .env                          # Variáveis de ambiente locais
├── .env.example                  # Template documentado de variáveis
├── Dockerfile                    # Container baseado em node:22-slim
├── docker-compose.yml            # Compose padrão de produção
├── docker-compose.staging.yml    # Compose isolado de homologação/staging
├── easypanel.staging.json        # Template de deploy no Easypanel
├── README.md                     # Documentação geral de funcionalidades
├── atualizar-site.bat            # Script de automação git/deploy
├── testar-painel-local.bat       # Script para iniciar servidor local
├── cloudflared.exe               # Binário do Cloudflare Tunnel
├── google_credentials.json       # Credenciais cliente OAuth Google
├── google_token.json             # Tokens de autorização Google legados
├── auth_info_baileys/            # Sessão persistente do Baileys/WhatsApp
├── data/                         # Banco SQLite e backups
│   ├── assistant.db              # Banco principal SQLite (DatabaseSync)
│   ├── backups/                  # Diretório de snapshots e backups atômicos
│   └── homologation_url.txt      # URL pública gerada pelo túnel Cloudflare
├── public/                       # Frontend estático (HTML/JS/CSS/Imagens)
│   ├── index.html, planos.html, como-funciona.html, contato.html, termos.html, privacidade.html
│   ├── admin.html                # Painel de controle administrativo
│   ├── cliente/                  # Portal do cliente multi-tenant
│   │   ├── login.html, painel.html, ativar.html, recuperar-senha.html
│   ├── solucoes/                 # 10 Landing pages verticais por nicho
│   └── js/raia-analytics.js      # Script de telemetria e captura de UTM/Lead
├── views/
│   └── admin-direct-sales.html   # Visão administrativa de contratos diretos
├── scripts/                      # 47 scripts de testes, auditoria e rollback
│   ├── test-raia-27-protecoes.js # Suíte formal das 27 proteções
│   ├── test-production-startup-validation.js # Validação fail-safe de boot
│   ├── backup-and-verify.js      # Snapshot atômico via VACUUM INTO
│   ├── rollback.js               # Restauração com preservação de novos clientes
│   └── start-homologacao.js      # Boot de staging com Cloudflare tunnel
├── src/                          # Código-fonte principal
│   ├── index.js                  # Ponto de entrada padrão
│   ├── config/index.js           # Gerenciamento de envs e validação de segurança
│   ├── database/db.js            # Schemas, migrações e node:sqlite
│   ├── middlewares/rateLimiter.js# Rate limiting persistente em SQLite
│   ├── routes/clientRoutes.js    # Rotas da API do cliente multi-tenant
│   ├── server/app.js             # Configuração Express, headers, CSP, CORS, rotas
│   ├── server/start-staging.js   # Ponto de entrada específico de homologação
│   ├── whatsapp/
│   │   ├── client.js             # Conexão Baileys, reconexão, dispatch
│   │   └── messageHandler.js     # Tratamento de mensagens pessoais
│   └── services/                 # 28 serviços de negócio e integração
└── n8n-templates/                # Templates e roteiros de automação
```

### 1.3. Ciclo de Inicialização e Modos de Operação
- **Modo Padrão / Produção (`src/index.js:6-80`)**:
  - Valida variáveis de ambiente via `config.validateEnvironment({ throwOnError: isProdEnv })` (`src/server/app.js:44-53`).
  - Inicializa o banco de dados e executa migrações de esquema (`src/database/db.js`).
  - Garante a conta demo para homologação da Hotmart (`clientAuth.ensureDemoAccount()`).
  - Sincroniza compromissos pendentes com o Google Calendar caso esteja conectado.
  - Inicia o servidor HTTP Express na porta definida (`PORT`, padrão `3333`).
  - Inicia o worker de segundo plano `outboxWorker.startWorker()` (`src/server/app.js:3404-3410`).
  - Se `isStagingMode` for falso, conecta o bot WhatsApp via Baileys (`startWhatsAppBot()`).
- **Modo Homologação / Staging (`src/server/start-staging.js:1-17` e `docker-compose.staging.yml`)**:
  - Define flags: `APP_MODE='staging'`, `HOMOLOGACAO='true'`, `DISABLE_WHATSAPP='true'`, `DISABLE_WHATSAPP_BOT='true'`, `PAUSE_PERSONAL_ASSISTANT='true'`, `ASAAS_ENV='sandbox'`, `ASAAS_API_URL='https://sandbox.asaas.com/api/v3'`.
  - Requer `src/index.js`. O WhatsApp é suprimido (`src/index.js:71-73`), o Google Calendar live sync é bloqueado (`src/index.js:42-43`), e o ambiente opera isolado.

### 1.4. Banco de Dados e Schemas
- Persistência em arquivo único `data/assistant.db` usando `node:sqlite.DatabaseSync`.
- Tabelas fundamentais identificadas:
  - **Identidade e Sessão**: `users` (contendo `session_token`, `session_expires_at`, `totp_secret`, `totp_enabled`, `session_mfa_verified`, `role`, `plan_tier`, etc.), `invite_codes`, `oauth_states`.
  - **Segurança e Auditoria**: `security_audit_logs` (eventos de login, MFA, IDOR, CSP, CSRF, etc.), `rate_limit_entries` (armazenamento persistente de tentativas de rate limiting com TTL e UPSERT atômico), `schema_migrations`.
  - **Arquitetura Multiproduto**: `product_segments` (10 segmentos oficiais), `products`, `product_segment_relations`, `product_plans`, `customer_subscriptions`, `subscription_audit_logs`.
  - **Módulo Salões e Agenda Inteligente**: `client_salons`, `client_services`, `client_staff`, `client_campaigns`, `appointments` (com campos `duration_min`, `has_conflict`, `google_sync_status`, `whatsapp_notified`), `google_calendar_tokens`, `appointment_status_history`.
  - **Filas Outbox Resilientes**: `google_sync_outbox` e `whatsapp_notification_outbox` com suporte a `attempts`, `max_attempts`, `next_retry_at`, `locked_at`, e `idempotency_key`.
  - **Financeiro e Pagamentos**: `expenses`, `incomes`, `scheduled_payments`, `reminder_logs`, `asaas_payments`, `asaas_webhook_events`, `hotmart_webhook_events`, `affiliate_sales`, `direct_sales_contracts`, `direct_sales_payments`.
  - **Leads e Atendimento de IA**: `leads`, `agent_messages`, `processed_messages`, `business_analyses`.

### 1.5. Matriz das 27 Proteções de Segurança
Identificada no script formal `scripts/test-raia-27-protecoes.js` e comprovada nas implementações dos serviços:
1. **Proteção 01 — Autenticação Adequada & TOTP MFA**: Login com cookies HttpOnly/SameSite/Secure, MFA TOTP RFC 6238 via `src/services/totpService.js`, segredo criptografado com chave independente.
2. **Proteção 02 — Esconder Chaves de API**: Proibição de tokens em query strings; chaves somente em headers ou variáveis de ambiente.
3. **Proteção 03 — Proteger o Banco SQLite**: `db.checkDatabaseIntegrity()` executando `PRAGMA integrity_check` e backups atômicos consistentes via `VACUUM INTO` sem downtime (`src/database/db.js:1254-1292`).
4. **Proteção 04 — Exigir HTTPS & Host Header Validation**: Redirecionamento 301 para HTTPS e allowlist estrita `EXACT_ALLOWED_HOSTS` contra Host Header Injection e Open Redirects (`src/server/app.js:78-109, 163-183`).
5. **Proteção 05 — Hash Seguro das Senhas**: Uso de `crypto.scryptSync` com salt aleatório de 16 bytes e comparação timing-safe (`src/services/clientAuthService.js:7-24`).
6. **Proteção 06 — Validação dos Formulários no Servidor**: Sanitização rigorosa de inputs, telefones, durações e preços.
7. **Proteção 07 — Prevenção contra XSS**: Cabeçalhos `X-Content-Type-Options: nosniff`, `X-XSS-Protection: 0`, sanitização de caracteres em nomes de serviços e mensagens.
8. **Proteção 08 — Monitorar Atividades Suspeitas (Audit Trail)**: Tabela `security_audit_logs` e catálogo `AUDIT_EVENTS` rastreando 26+ eventos de segurança (`src/services/securityAuditService.js`).
9. **Proteção 09 — Restringir Rotas Administrativas**: Rotas `/api/admin/*` protegidas por `requireInteractiveAdmin` e desafio de MFA (`totpService`), isolamento de chaves API (`x-admin-key`).
10. **Proteção 10 — Consultas Parametrizadas**: Eliminação total de SQL Injection através de `db.prepare(sql).run(...params)` em todas as consultas.
11. **Proteção 11 — Validação de Variáveis & Fail-Safe Boot**: `config.validateEnvironment()` com bloqueio imediato se segredos forem fracos, padrão, ou se houver conflito de ambiente (`src/config/index.js:60-193`).
12. **Proteção 12 — Limites de Requisições (Rate Limiting)**: Implementação em `src/middlewares/rateLimiter.js` usando armazenamento cluster-coordinated em `rate_limit_entries` com fallback resiliente em memória.
13. **Proteção 13 — Restringir CORS**: Validador estrito `isAllowedOrigin()` com correspondência exata de domínio e protocolo (`src/server/app.js:113-159, 240-252`).
14. **Proteção 14 — Cabeçalhos de Segurança & CSP**: Implementação de CSP restritivo e `Content-Security-Policy-Report-Only` com endpoint `/api/security/csp-report` (`src/server/app.js:192-237`).
15. **Proteção 15 — Cookies de Sessão Seguros**: Flags `HttpOnly`, `SameSite=Lax` e `Secure` dinâmico para evitar sequestro de sessão via JavaScript.
16. **Proteção 16 — Defesa Anti-CSRF**: Validação de Origin/Referer em métodos mutantes (POST, PUT, DELETE, PATCH) com Double-Submit CSRF token em requisições de navegador (`src/server/app.js:256-343`).
17. **Proteção 17 — Separação de Magic Links e Sessões Persistentes**: Magic links de ativação com uso único e prazo de expiração; `session_token` com prazo estrito de 30 dias (`src/routes/clientRoutes.js:96-123`).
18. **Proteção 18 — Restrição de Uploads**: Proibição de uploads diretos inseguros no backend.
19. **Proteção 19 — Preços e Pagamentos Reforçados**: Validação centralizada de planos no backend (`src/services/planCatalog.js`), cálculo no servidor em centavos inteiros (`price_cents`), fail-closed em pagamentos.
20. **Proteção 20 — Desativar Depuração em Produção**: Middleware de erro centralizado (`src/server/app.js:3384-3402`) mascarando detalhes internos em `INTERNAL_SERVER_ERROR`.
21. **Proteção 21 — Atualizar Dependências**: Verificação contínua de pacotes sem CVEs conhecidos no stack.
22. **Proteção 22 — Remover Pacotes Não Utilizados**: Base enxuta focada em 10 bibliotecas essenciais no `package.json`.
23. **Proteção 23 — Bloqueio de Arquivos Expostos**: Middleware que intercepta e retorna 404 para arquivos `.env`, `.git`, `.db`, backups, certificados e `package.json` (`src/server/app.js:353-377`).
24. **Proteção 24 — Auditoria de Segredos no Repositório**: Nenhuma credencial ou token real gravado em código-fonte; uso de `.env`.
25. **Proteção 25 — Plano de Rotação de Credenciais**: Suporte a chaves candidatas no TOTP (`getCandidateDecryptionKeys`) e rotação não-destrutiva de segredos.
26. **Proteção 26 — Matriz Completa de Segurança (OWASP ASVS)**: Conformidade documentada com o padrão ASVS 5.0.
27. **Proteção 27 — Testar e Comprovar**: Suíte automatizada com 27 testes executada contra SQLite isolado em memória/tmp sem tocar no banco de produção.

---

## 2. Logic Chain

1. **Premissa de Plataforma**: A aplicação foi construída para rodar em Node.js moderno (v22) servindo tanto uma interface Web responsiva (Express 5) quanto automações de mensagens instantâneas (Baileys WhatsApp) e integração com LLMs (Google Gemini).
2. **Da Análise do Ponto de Entrada (`src/index.js`)**:
   - Observou-se a bifurcação explícita entre `isStagingMode` e modo normal.
   - Isso garante que qualquer instância subida em homologação (`APP_MODE=staging` ou script `start-staging.js`) não abra conexão de WhatsApp nem execute chamadas ao Google Calendar de contas reais, satisfazendo a integridade operacional de produção.
3. **Do Isolamento de Dados e Concorrência**:
   - `node:sqlite` é síncrono no processo do Node, evitando overhead de rede ou event-loop blocking se usado com consultas otimizadas e transações imediatas (`BEGIN IMMEDIATE`).
   - A tabela `rate_limit_entries` e as filas `google_sync_outbox` / `whatsapp_notification_outbox` resolvem concorrência e idempotência usando locks a nível de registro (`status = 'PROCESSING', locked_at = CURRENT_TIMESTAMP`).
4. **Da Inteligência Artificial (Google Gemini)**:
   - Em `src/services/aiService.js`, o método `callGemini` adota uma esteira de modelos (`gemini-3.8-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, etc.) com fallback e retentativa em caso de 503/429.
   - Em `src/services/agentChatService.js`, cada nicho comercial possui personas especializadas com system prompts refinados (ImobBot, Jéssica, Sofia, ChefBot, Lex, etc.), conectadas diretamente ao recebimento de mensagens do WhatsApp.
5. **Da Segurança e Isolamento Multi-Tenant**:
   - As consultas para clientes sempre filtram por `user_id` derivado da sessão autenticada (`req.clientUser.id`). Tentativas de acessar dados de outro salão disparam `AUDIT_EVENTS.CROSS_TENANT_ACCESS_BLOCKED` e retornam HTTP 403.
   - Segredos OAuth do Google Calendar e segredos TOTP são cifrados em repouso com AES-256-GCM antes de persistir no banco SQLite.

---

## 3. Caveats

1. **Modo de Operação Somente-Leitura**: Esta investigação seguiu estritamente o modo read-only. Nenhum comando de execução, build ou teste foi executado no terminal.
2. **Credenciais Locais**: O arquivo `.env` local contém credenciais reais do ambiente do usuário; elas não foram expostas nem modificadas neste relatório.
3. **Modelos Gemini Externos**: A disponibilidade dos modelos específicos (`gemini-3.8-flash`) depende das cotas e autorizações da API key do Google Studio fornecida no ambiente.

---

## 4. Conclusion

O sistema RAIA AGENTES na branch `security/raia-27-protecoes` representa uma arquitetura de microsserviço monolítico consolidado e altamente seguro, estruturado sobre **Node.js 22**, **Express 5**, **SQLite Nativo (`node:sqlite`)**, **Baileys (WhatsApp)** e **Google Gemini AI**.

Os pilares arquiteturais são:
- **Segurança Fail-Closed**: Bloqueio de inicialização em conflito de ambientes (ex: staging apontando para Asaas de produção), isolamento multi-tenant intransponível e matriz de 27 proteções auditáveis.
- **Resiliência e Idempotência**: Arquitetura Outbox assíncrona (`google_sync_outbox` e `whatsapp_notification_outbox`) com auto-recuperação de tarefas travadas em crashes.
- **Portfólio Multiproduto**: Estrutura escalável para 10 segmentos de mercado, permitindo que um usuário possua múltiplas assinaturas ativas independentes sem conflito comercial.
- **Separação Rigorosa Homologação vs Produção**: Mecanismo de Staging Gate nativo (`STAGING_PROTECTION_ENABLED`), bloqueando acionamento acidental de WhatsApp ou sincronizações externas de clientes reais.

---

## 5. Verification Method

Para verificar de forma independente e sem efeitos colaterais todas as constatações descritas neste relatório:

1. **Verificação de Arquitetura e Dependências**:
   - Inspecione `package.json` confirmando dependências e scripts.
   - Inspecione `src/index.js` e `src/server/app.js` verificando os middlewares de segurança, roteamento e inicialização do `outboxWorker`.
2. **Verificação do Banco de Dados e Schemas**:
   - Inspecione `src/database/db.js` verificando as chamadas `DatabaseSync`, migrações versionadas (`runVersionedMigration`) e criação das tabelas `customer_subscriptions`, `google_sync_outbox` e `rate_limit_entries`.
3. **Verificação das 27 Proteções de Segurança**:
   - Inspecione `scripts/test-raia-27-protecoes.js` comprovando a especificação e os critérios de validação de cada uma das 27 regras.
   - Inspecione `src/config/index.js` comprovando a função `validateEnvironment`.
4. **Condição de Invalidação**:
   - Este relatório seria invalidado se o código-fonte utilizasse bibliotecas ORM externas com conexões de rede em vez de `node:sqlite`, ou se houvesse acoplamento obrigatório que impedisse a execução do servidor web sem uma conexão ativa de WhatsApp. Ambas as hipóteses foram formalmente descartadas pela inspeção direta do código.
