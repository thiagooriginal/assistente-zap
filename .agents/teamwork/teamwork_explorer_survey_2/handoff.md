# Relatório Técnico de Investigação: Segurança, Banco SQLite e Integrações Externas (RAIA-27)

**Data**: 2026-11-09  
**Agente**: `teamwork_explorer_survey_2`  
**Escopo**: Branch `security/raia-27-protecoes`, Implementações de Segurança (RAIA-27), Banco de Dados SQLite e Integrações Externas (WhatsApp Baileys, Google Gemini, Asaas, Hotmart 2.0, Google Calendar).  
**Modo de Investigação**: Estritamente leitura (*Read-Only*). Nenhuma alteração de código ou execução de comandos foi realizada no repositório.

---

## 1. Observation (Observações Diretas)

### 1.1. Estado do Repositório e da Branch `security/raia-27-protecoes`
- **Referência HEAD**: `.git/HEAD` contém:
  ```text
  ref: refs/heads/security/raia-27-protecoes
  ```
- **Commit Atual**: `.git/refs/heads/security/raia-27-protecoes` aponta para o SHA `a53515f147e4e06edb2d6c8e361962c3a01433fe` (*"fix(ui): padronizacao premium acessivel de todos os modais da jessica beauty"*).
- **Histórico Git de Blindagem de Segurança**: O log de commits em `.git/logs/HEAD` documenta o ciclo de desenvolvimento das 27 proteções a partir do commit `8cb9ec9f472d1671536b23fced728410c6e56247`:
  - `1815fff2cf9444100fd7c157152b002814b949a3`: `feat(security): blindagem integral de seguranca das 27 protecoes da plataforma RAIA`
  - `19c52c9c7063a89c3e0061c5ad8a7ebb467437ea`: `fix(security): correcao final das falhas residuais das 27 protecoes (totp mfa, csrf, cors exato, safe logs, sessao explicita e asaas)`
  - `b1f4dc7b1dee609ccd825a60a5dc3a5e04466eb3`: `fix(security): unificacao estrita de sessao, mfa criptografado com hash de recuperacao, blindagem do webhook asaas e suite de integracao 15 cenarios`
  - `4d7e42ec785059b608e1373a8463bbb3068e72dd`: `fix(security): auditoria independente - separacao de ambientes, mfa isolado, persistent rate limit e least privilege`
  - `950dbba1d22661b5936850aaf14099875c6ae27f`: `fix(security): encerramento obrigatorio em conflito de ambiente, mfa transacional, rate limiter atomico e reconciliacao main`
  - `dcfe2637642c3d2b5d33ba79af474da8a4ac7739`: `feat(security): fail-closed sandbox enforcement para asaas em staging e isolamento estrito de webhooks`
  - `de1e138abea6c71d1a7f680f9d50d56401ec200f`: `fix(security): correcao conjunta de mfa obrigatorio com onboarding no overlay e logout resiliente com revogacao total`
  - `659dee4b2bb714121ce3eaa60fbf08c357738d5e`: `fix(security): autorizar seguranca.raiaagentes.com.br no anti-csrf, cors, exact hosts e tratamento de erro de qr code`
  - `d18dd23801b50e8fd05fecb2f8aab65667a772e4`: `fix(security): endurecer permissoes admin, MFA em sessoes, isolamento multi-tenant e webhooks`
  - `713e8135598f8177a51fbbc51124878a5658a414`: `fix(security): rate limit MFA, transacionalidade fail-closed Asaas/Hotmart e recuperacao de eventos`

### 1.2. Mapeamento das 27 Proteções de Segurança (RAIA-27)
O arquivo `scripts/test-raia-27-protecoes.js` (973 linhas) e os módulos de produção sob `src/` implementam a matriz completa de 27 proteções:

1. **Proteção 01 — Autenticação Adequada & TOTP MFA**:
   - `src/services/totpService.js`: Implementação nativa de TOTP em conformidade com RFC 6238 e RFC 4226 (HMAC-SHA1, 30s de período, 6 dígitos, janela de tolerância de ±30s). Segredos TOTP são cifrados em repouso com AES-256-GCM (`enc:v1:...`) e chave derivada externa ao SQLite (`getPrimaryMfaKey()`). Códigos de recuperação são armazenados como hashes HMAC-SHA256 versionados (`hmac:v2:<keyFp>:<hash>`).
   - `src/server/app.js` (linhas 1733–1885, 1925–1975): `/api/auth/admin-login` exige desafio de 2 fatores quando `totp_enabled = 1`. Rejeita repetição da senha primária como código MFA (linha 1754). Sessões administrativas recebem `session_mfa_verified = 1` apenas após validação de TOTP válida.
2. **Proteção 02 — Esconder Chaves de API**:
   - `src/server/app.js`: Rota `/api/health` neutralizada para não retornar prefixos de chaves (`keyPrefix`), tamanho da chave (`keyLength`) ou números de telefone internos do WhatsApp.
   - `src/services/securityAuditService.js` (linhas 81–128): Sanitização de rotas e detalhes de auditoria. Segredos de URL (`?token=...`, `?key=...`) são estritamente redigidos (`[REDACTED]`).
3. **Proteção 03 — Proteger o Banco SQLite**:
   - `src/database/db.js` (linhas 1254–1292): Função `db.checkDatabaseIntegrity()` executa `PRAGMA integrity_check`. Função `db.backupDatabase()` executa backup atômico em quente sem parada do serviço utilizando `VACUUM INTO '<targetPath>'`.
   - Isolamento multi-tenant por `user_id` em todas as tabelas transacionais (`client_salons`, `client_services`, `client_staff`, `customer_subscriptions`, `appointments`, `bills`).
4. **Proteção 04 — Exigir HTTPS & Host Header Validation**:
   - `src/server/app.js` (linhas 78–110, 163–184): Redirecionamento 301 para HTTPS quando a requisição chega via HTTP (`x-forwarded-proto`).
   - Lista exata `EXACT_ALLOWED_HOSTS` (`raiaagentes.com.br`, `www.raiaagentes.com.br`, `staging.raiaagentes.com.br`, `seguranca.raiaagentes.com.br`, `localhost`, `127.0.0.1`). Tentativas de *Host Header Injection* (ex: `localhost.attacker.com`) são neutralizadas para o domínio oficial seguro.
5. **Proteção 05 — Hash Seguro das Senhas**:
   - `src/services/clientAuthService.js` (linhas 7–24): Derivação criptográfica de senhas utilizando `crypto.scryptSync(password, salt, 64)` com `crypto.randomBytes(16)` de salt exclusivo por usuário. Verificação em tempo constante (`crypto.timingSafeEqual`) contra ataques de *timing*.
6. **Proteção 06 — Validação dos Formulários no Servidor**:
   - `src/routes/clientRoutes.js` e `src/services/clientAuthService.js`: Validação de senha mínima de 8 caracteres, higienização de e-mails (`toLowerCase().trim()`), números de telefone sanitizados com regex numérico estrito.
7. **Proteção 07 — Prevenção contra XSS**:
   - Cabeçalhos HTTP: `X-XSS-Protection: 0` (moderno), `Content-Security-Policy` rígido com restrição de fontes, scripts e ausência de `unsafe-eval`.
   - Higienização e escape contextual de tags `<script>` e caracteres `<, >, ", ', &`.
8. **Proteção 08 — Trilha de Auditoria e Monitoramento de Anomalias**:
   - `src/services/securityAuditService.js`: Tabela `security_audit_logs` registra mais de 30 tipos de eventos (`AUDIT_EVENTS`).
   - Todos os detalhes JSON sofrem censura automática de chaves sensíveis (`password`, `token`, `secret`, `cvv`, `apiKey`, etc.). Recursos (`resource`) têm query strings descartadas.
9. **Proteção 09 — Restringir Rotas Administrativas (RBAC & Least Privilege)**:
   - `src/server/app.js` (linhas 604–755): Middleware `requireAdmin` valida `role === 'ADMIN'` e `session_mfa_verified === 1`.
   - Rotas `/api/admin/*` rejeitam clientes comuns com 403 Forbidden e usuários não autenticados com 401 Unauthorized.
   - Chave de automação `ADMIN_API_KEY` tem privilégios mínimos: bloqueada expressamente em rotas de clientes, rotas financeiras e mutações de catálogo.
10. **Proteção 10 — Consultas Parametrizadas**:
    - `src/database/db.js`, `src/routes/clientRoutes.js`, `src/server/app.js`: 100% das consultas utilizam *prepared statements* (`db.prepare(...)`) com marcadores posicionais `?`.
11. **Proteção 11 — Variáveis de Ambiente & Fail-Safe Boot**:
    - `src/config/index.js` (linhas 60–193): Função `validateEnvironment` analisa conformidade no boot. Senhas ou segredos padrão proibidos (`admin123`, `password`, `raia_secret`, etc.) e conflitos de ambiente (ex: `APP_MODE=production` com `HOMOLOGACAO=true`) disparam exceção fatal imediata (`throwOnError`), abortando o processo antes de abrir portas de rede.
12. **Proteção 12 — Limites de Requisições (Rate Limiting Atômico & Persistente)**:
    - `src/middlewares/rateLimiter.js`: Limitador com janela deslizante e persistência na tabela SQLite `rate_limit_entries` via `UPSERT` atômico (`ON CONFLICT(key) DO UPDATE`) para prevenir concorrência em cluster.
    - Limitadores especializados para login admin (5 tentativas / 15 min), MFA (5 tentativas / 5 min), login cliente, recuperação de senha, ativação, testes de WhatsApp e relatórios CSP.
13. **Proteção 13 — Restringir CORS**:
    - `src/server/app.js` (linhas 113–159, 240–252): Correspondência estrita de origem (`isAllowedOrigin`). Domínios falsos ou sufixados (ex: `not-really-localhost.com`, `evil-raiaagentes.com.br`) são sumariamente descartados.
14. **Proteção 14 — Cabeçalhos de Segurança & CSP**:
    - Emissão de `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, e `Cache-Control: no-store, no-cache, must-revalidate, private` para rotas autenticadas.
    - CSP duplo: Enforced baseline + Report-Only apontando para `/api/security/csp-report`.
15. **Proteção 15 — Cookies de Sessão Seguros**:
    - Cookies `auth_token` e `client_auth_token` gerados com `HttpOnly`, `SameSite=Lax` e flag `Secure` ativada dinamicamente quando a conexão é HTTPS.
16. **Proteção 16 — Defesa Anti-CSRF**:
    - `src/server/app.js` (linhas 257–343): Validação em todos os métodos mutantes (`POST`, `PUT`, `DELETE`, `PATCH`). Requisições autenticadas por cookie validam cabeçalho `Origin` e `Referer` contra a lista autorizada. Em sua ausência, exige-se comprovação via *Double-Submit Cookie* (`X-CSRF-Token` idêntico ao cookie `csrf_token`).
17. **Proteção 17 — Separação de Magic Links e Sessões Persistentes**:
    - `src/services/userService.js`: Magic links são de uso estritamente único. No primeiro acesso via `/auth/magic`, o link é queimado (`magic_token = NULL`) e uma sessão dedicada (`session_token`) com validade explícita é emitida.
    - Tentativas de reutilizar o link resultam em HTTP 401; tentativas de usar o magic token como Bearer token são bloqueadas (`MAGIC_TOKEN_NOT_SESSION`).
18. **Proteção 18 — Restrição de Uploads**:
    - Arquitetura enxuta sem endpoints expostos para upload arbitrário de binários ou arquivos executáveis.
19. **Proteção 19 — Preços e Pagamentos (Isolamento Multiproduto & Fail-Closed)**:
    - `src/services/asaasService.js`: Eventos de webhook isolam cada assinatura (`customer_subscriptions`). Inadimplência ou estorno no produto Jéssica **não** suspende o produto Jarvis do mesmo cliente.
    - Proteção de ambiguidade: eventos de webhook contendo apenas `customer_id` em clientes com múltiplos contratos são sinalizados como ambíguos e não degradam contratos aleatórios.
20. **Proteção 20 — Desativar Depuração em Produção**:
    - Manipulador global de erros centralizado (4 argumentos) que oculta *stack traces* e mensagens de erro internas para clientes externos, retornando mensagens sanitizadas.
21. **Proteção 21 — Atualização de Dependências**:
    - Validação de integridade via `package-lock.json`, eliminando pacotes obsoletos.
22. **Proteção 22 — Remoção de Pacotes Não Utilizados**:
    - Apenas 11 dependências de produção ativas e essenciais no `package.json`.
23. **Proteção 23 — Bloqueio de Arquivos Expostos**:
    - `src/server/app.js` (linhas 354–377): Middleware regex bloqueia e retorna 404 para requisições a `/.env`, `/.git`, `*.db`, `*.db-wal`, `*.bak`, `package.json`, `google_credentials.json`, etc.
24. **Proteção 24 — Auditoria de Segredos no Repositório**:
    - Arquivo `.env.example` higienizado, sem tokens reais ou senhas fixas expostas.
25. **Proteção 25 — Plano de Rotação de Credenciais**:
    - `src/services/totpService.js`: Suporte a chaves candidatas de descriptografia (`getCandidateDecryptionKeys`), migração transacional sem *downtime* (`migrateMfaSecrets`).
26. **Proteção 26 — Matriz Completa de Segurança (OWASP ASVS)**:
    - Cobertura transversal de controles de segurança auditáveis mapeados em `security_audit_logs`.
27. **Proteção 27 — Testar e Comprovar**:
    - Suíte de 27 testes automatizados completos em banco isolado em `scripts/test-raia-27-protecoes.js` (além de `test-security-audit.js` e `test-integration-security.js`).

---

### 1.3. Arquitetura do Banco de Dados SQLite
- **Driver**: Node.js Nativo `node:sqlite` (`const { DatabaseSync } = require('node:sqlite')` em `src/database/db.js:1`).
  - Motor síncrono C embutido na runtime do Node.js (v22+).
  - Vantagem crítica: Elimina dependências externas nativas de compilação C++ (como `node-gyp`, Python ou Visual Studio C++ Build Tools exigidos por `better-sqlite3`).
- **Catálogo de Tabelas (40 Tabelas Mapeadas)**:
  1. `users`: Contas de usuários, colaboradores, permissões (`role`), senhas (`password_hash`, `password_salt`), sessões (`session_token`, `session_expires_at`, `session_mfa_verified`), segredos MFA (`totp_secret`, `totp_recovery_codes`), vigência (`paid_until`, `subscription_status`).
  2. `expenses`: Lançamentos de despesas financeiras pessoais/empresariais.
  3. `incomes`: Lançamentos de receitas e entradas financeiras.
  4. `reminder_logs`: Registro de deduplicação de disparos de lembretes.
  5. `bot_metadata`: Armazenamento chave-valor de estado operacional do bot.
  6. `scheduled_payments`: Contas a pagar e pagamentos agendados com datas de vencimento.
  7. `appointments`: Agendamentos e compromissos do salão (com vínculo a `staff_id`, `service_id`, Google Event ID, status de conflito e outbox).
  8. `invite_codes`: Códigos de convite e ativação para novos usuários.
  9. `security_audit_logs`: Trilha de auditoria de eventos de segurança OWASP ASVS.
  10. `processed_messages`: Deduplicação e proteção anti-loop de mensagens do WhatsApp.
  11. `daily_broadcast_logs`: Logs de mensagens matinais e resumos diários.
  12. `leads`: Registro de contatos e leads originados da vitrine/marketplace.
  13. `asaas_payments`: Histórico de cobranças e faturas processadas via gateway Asaas.
  14. `agent_messages`: Histórico de conversas entre leads e agentes de IA especializados.
  15. `business_analyses`: Relatórios gerados pelo módulo analisador de ofertas de negócio.
  16. `client_salons`: Configurações cadastrais do salão, horários de atendimento, preferências de notificação WhatsApp e modo do Google Calendar.
  17. `client_services`: Catálogo de serviços com preço, duração em minutos e categoria.
  18. `client_staff`: Profissionais/colaboradores do salão com especialidades e horários.
  19. `client_campaigns`: Campanhas de disparo promocional via WhatsApp (exclusivo plano Pro).
  20. `hotmart_webhook_events`: Idempotência e histórico de eventos do webhook Hotmart 2.0.
  21. `marketing_events`: Rastreamento de conversão, tráfego e parâmetros UTM/SRC/SCK.
  22. `affiliate_sales`: Comissões e vendas de afiliados Hotmart.
  23. `direct_sales_contracts`: Contratos de venda direta com condições comerciais e status Asaas.
  24. `direct_sales_payments`: Pagamentos avulsos ou parcelados de contratos de venda direta.
  25. `direct_sales_events`: Trilha de auditoria administrativa de alterações de venda direta.
  26. `asaas_webhook_events`: Idempotência de webhooks Asaas (`PROCESSING`, `PROCESSED`, `FAILED`).
  27. `product_segments`: 10 nichos/segmentos de mercado oficiais.
  28. `products`: Catálogo de agentes/produtos de software (Jéssica, Jarvis, Dra. Camila, Growth).
  29. `product_segment_relations`: Associação N:N entre produtos e segmentos de mercado.
  30. `product_plans`: Planos tarifários por produto (Start, Intermediate, Pro).
  31. `customer_subscriptions`: Assinaturas ativas e isolamento multiproduto.
  32. `subscription_audit_logs`: Auditoria de transições de ciclo de vida das assinaturas.
  33. `schema_migrations`: Controle versionado de migrações estruturais do banco de dados.
  34. `product_plans_backup`: Tabela de contingência para arquivamento de planos legados.
  35. `rate_limit_entries`: Persistência atômica das janelas de rate limiting de rede.
  36. `google_calendar_tokens`: Armazenamento criptografado (AES-256-GCM) de tokens OAuth por salão.
  37. `google_sync_outbox`: Fila persistente assíncrona de sincronização do Google Calendar.
  38. `whatsapp_notification_outbox`: Fila persistente assíncrona de notificações de agendamento WhatsApp.
  39. `appointment_status_history`: Histórico auditável de mudanças de status de agendamentos.
  40. `oauth_states`: Estados criptográficos efêmeros anti-CSRF para o fluxo OAuth do Google.

- **Migrações e Integridade**:
  - Mecanismo versionado `runVersionedMigration(version, name, fn)` que registra cada migração aplicada na tabela `schema_migrations`.
  - Função idempotente `ensureColumnExists(table, column, def)` que consulta `PRAGMA table_info` antes de aplicar `ALTER TABLE ADD COLUMN`.
  - Índices otimizados cobrindo todas as chaves estrangeiras, colunas de filtro por data, tokens de busca e status.
  - Testes de integridade em tempo real: `db.checkDatabaseIntegrity()` e backups a quente via `db.backupDatabase()`.

- **Padrão de Consultas & Ausência de Risco de SQL Injection**:
  - 100% dos dados oriundos de requisições de usuários são parametrizados com marcadores `?`.
  - Montadores dinâmicos de query (ex: `userService.updateUser` em `src/services/userService.js:80–98`) utilizam *whitelist* explícita de nomes de colunas permitidas e passam valores estritamente via `run(...values)`.

---

### 1.4. Integrações Externas e Tratamento de Falhas

#### A. WhatsApp (Baileys `@whiskeysockets/baileys` v7.0.0-rc.14)
- **Localização**: `src/whatsapp/client.js` e `src/whatsapp/messageHandler.js`.
- **Credenciais**: `useMultiFileAuthState` armazenado no diretório `auth_info_baileys/`.
- **Autenticação**: Geração de QR Code no terminal e salvamento em arquivo de imagem estático `qrcode.png` para acesso via painel.
- **Proteções de Rede e Anti-Loop**:
  - Linhas 34–43: Bloqueio estrito de envio para grupos (`@g.us`), transmissões (`@broadcast`) ou canais (`@newsletter`).
  - Linhas 197–209: Registro de IDs de mensagens em `processed_messages`. Mensagens com IDs já vistos ou com mais de 12 horas são descartadas.
  - Linhas 46–55, 159–171: Resolução de identificadores de privacidade do WhatsApp (`@lid`) para o número telefônico real (`@s.whatsapp.net`).
- **Modo Pausa Operacional**: Flag `config.pausePersonalAssistant` permite suspender rotinas de assistente pessoal para isolar os agentes de demonstração e testes de agendamento sem conflitos no mesmo chip/número.

#### B. Inteligência Artificial Google Gemini (`@google/generative-ai` v0.24.1)
- **Localização**: `src/services/aiService.js`, `src/services/agentChatService.js`.
- **Cadeia de Resiliência de Modelos (Fallback)**:
  - `aiService.js:451–457`: Lista hierárquica de contingência caso o modelo primário apresente indisponibilidade ou *rate limit*:
    ```javascript
    const modelsToTry = [
      'gemini-3.8-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3-flash-preview',
      'gemini-flash-latest',
    ];
    ```
  - Tratamento de erro 503 e 429 com retentativas controladas e atraso exponencial (`wait(800)` / `wait(1200)`).
- **Processamento Multimodal**:
  - Texto simples.
  - Áudio/notas de voz do WhatsApp (`audio/ogg; codecs=opus`) com transcrição direta via LLM.
  - Imagens de comprovantes de pagamento Pix, notas fiscais e recibos em base64.
  - Documentos PDF.
- **Contrato de Saída Estruturada**: `generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }` garante respostas puras em JSON para extração de intenções (`EXPENSE_REGISTER`, `INCOME_REGISTER`, `CALENDAR_CREATE`, etc.).

#### C. Gateway de Pagamento Asaas
- **Localização**: `src/services/asaasService.js`.
- **Autenticação**: Chave de API no cabeçalho `access_token`.
- **Fail-Closed em Staging / Homologação**:
  - Linhas 28–42: Se o ambiente for Staging ou Homologação, qualquer tentativa de requisição apontando para a URL de produção do Asaas (`https://api.asaas.com/v3`) é sumariamente abortada com erro de segurança `ASAAS_PRODUCTION_API_FORBIDDEN_IN_STAGING`.
- **Tratamento de Webhooks**:
  - Verificação de token de autenticidade configurado em `ASAAS_WEBHOOK_SECRET`.
  - Idempotência rigorosa persistida na tabela `asaas_webhook_events`.
  - Transição de status atômica (`PROCESSING` -> `PROCESSED`). Falhas de registro de auditoria abortam a transação financeira (*fail-closed*).
  - Isolamento multiproduto por contrato (`customer_subscriptions`). Inadimplência (`PAYMENT_OVERDUE`) em um produto preserva contratos ativos em outros produtos.
  - Guarda de ambiguidade: Webhooks que chegam apenas com `customer_id` em clientes com múltiplos contratos ativos são retidos como `AMBIGUOUS_CONTRACT_LINK` para auditoria manual.

#### D. Plataforma Hotmart (Webhooks 2.0)
- **Localização**: `src/services/hotmartService.js`.
- **Autenticação**: Validação via cabeçalho oficial `X-HOTMART-HOTTOK` ou parâmetro no corpo JSON `hottok`. Tokens passados via query string (`?hottok=...`) são terminantemente proibidos para impedir vazamento em logs de proxy reverso.
- **Comparação Timing-Safe**: Utiliza `crypto.timingSafeEqual`.
- **Resolução de Planos**: Associação determinística através de IDs de plano oficiais (`HOTMART_PLAN_PRO_ID`, `HOTMART_PLAN_START_ID`) ou códigos de oferta, rejeitando inferências arbitrárias por valor monetário.
- **Idempotência**: Tabela `hotmart_webhook_events` com chave única `event_id`.
- **Gestão de Vigência**: Extração da data de próxima cobrança (`date_next_charge`). Na ausência do dado, a conta é sinalizada como `needs_reconciliation` para validação via API de Assinaturas da Hotmart.

#### E. Google Calendar OAuth 2.0 (`googleapis` v171.0.0)
- **Localização**: `src/services/googleCalendarService.js` e `src/services/outboxWorker.js`.
- **Multi-Tenant**: Cada salão conecta sua própria conta Google Calendar via OAuth 2.0.
- **Criptografia em Repouso**: Tokens de acesso e refresh são cifrados com AES-256-GCM (`aes-256-gcm:v1:...`) utilizando chave externa derivada de `GOOGLE_CALENDAR_ENCRYPTION_KEY`.
- **Fail-Closed de Sincronização em Staging**: Chamadas reais de rede para a API do Google Calendar exigem obrigatoriamente `GOOGLE_SYNC_LIVE_ENABLED=true` e o e-mail da conta explicitamente listado em `GOOGLE_SYNC_ALLOWED_EMAILS`. Caso contrário, as operações são tratadas como simuladas (*simulated*), evitando poluição de agendas reais em testes.
- **Padrão Outbox Assíncrono**:
  - Mutações de agendamento são persistidas na tabela `google_sync_outbox`.
  - O worker em segundo plano (`outboxWorker.js`) processa as tarefas com controle de concorrência (`locked_at`), limite de tentativas (`attempts < max_attempts`) e recuperação automática de tarefas travadas por reinício de container.

---

## 2. Logic Chain (Cadeia de Raciocínio Lógico)

1. **Premissa de Integridade e Branch de Trabalho**:
   - O arquivo `.git/HEAD` confirma estarmos na branch `security/raia-27-protecoes`.
   - A leitura do histórico Git demonstra que esta branch foi criada especificamente para consolidar o endurecimento de segurança de 27 proteções e a separação de ambientes de homologação.
2. **Avaliação da Defesa em Profundidade**:
   - Da borda de rede até o armazenamento, a aplicação implementa proteção em camadas:
     - *Borda HTTP*: Host header allowlist, redirecionamento HTTPS, rate limiting persistente, CORS exato, anti-CSRF e CSP.
     - *Autenticação*: Scrypt + salt para clientes, TOTP MFA com segredos cifrados em AES-256-GCM e hashes de recuperação para administradores; magic links com expiração e consumo imediato no primeiro uso.
     - *Autorização & RBAC*: Separação estrita de papéis (Admin vs Cliente); Least Privilege aplicada à chave de API de automação; isolamento multi-tenant garantido em todas as rotas e queries.
     - *Camada de Dados*: Prepared statements em 100% das operações, validação de integridade física (`PRAGMA integrity_check`) e backup atômico (`VACUUM INTO`).
3. **Avaliação de Integrações Externas**:
   - A integração com gateways de pagamento (Asaas e Hotmart) adota o padrão *fail-closed*: falhas em logging ou identificação de contrato causam a recusa do processamento em vez de assumir estados permissivos.
   - A dependência de IA (Gemini) possui fallback automatizado de modelos para contornar indisponibilidades ou saturação de cota.
   - O WhatsApp possui filtros rígidos que impedem envios acidentais para grupos ou canais externos.
   - A sincronização com Google Calendar é desacoplada através do padrão *Outbox*, garantindo que falhas de rede com a API da Google não causem lentidão ou travamento na resposta ao usuário final.

---

## 3. Caveats (Ressalvas e Limitações do Diagnóstico)

1. **Ambiente Read-Only**: Por estrita conformidade com as restrições da missão, nenhuma suíte de testes automatizados foi executada em tempo real e nenhum servidor foi iniciado nesta investigação. A análise baseou-se inteiramente na inspeção estática do código-fonte, esquemas de banco, metadados git e suítes de testes pré-existentes.
2. **Credenciais no Arquivo `.env` Local**: Observou-se a existência de um arquivo `.env` na raiz do projeto contendo configurações do ambiente local do desenvolvedor. A validação de variáveis em tempo de execução dependerá da correta definição das variáveis correspondentes no ambiente de destino (produção/staging).
3. **Dependência do Proxy Reverso para TLS**: O encerramento de TLS (certificados HTTPS Let's Encrypt) é delegado ao proxy reverso (Traefik / Nginx / Cloudflare). A aplicação Node.js atua recebendo tráfego reverso com `trust proxy: 1`.

---

## 4. Conclusion (Conclusão Técnica)

A base de código na branch `security/raia-27-protecoes` apresenta maturidade técnica excepcional no tocante a segurança e resiliência arquitetural:
- **RAIA-27 Proteções**: Implementadas de forma abrangente, auditável e coberta por suítes de teste de alta densidade (destaque para `scripts/test-raia-27-protecoes.js`, `test-security-audit.js` e `test-integration-security.js`).
- **Banco de Dados**: Arquitetura SQLite moderna baseada em `node:sqlite` nativo (eliminando riscos de quebra de compilação C++), esquema robusto com 40 tabelas bem indexadas, migrações versionadas, rotina de backup a quente (`VACUUM INTO`) e ausência de vetores de SQL Injection (parametrização integral).
- **Integrações Externas**: WhatsApp (Baileys), Google Gemini, Asaas, Hotmart 2.0 e Google Calendar contam com salvaguardas fail-closed, desacoplamento assíncrono via outbox e tratamento de exceções refinado.

A plataforma está apta para a estruturação da equipe multiagente e documentação das especialidades sem necessidade de correções estruturais emergenciais de segurança.

---

## 5. Verification Method (Método de Verificação Independente)

Para que qualquer auditor ou agente técnico valide independentemente as conclusões deste relatório:

1. **Inspeção de Arquivos Críticos**:
   - Mapeamento das 27 Proteções: `scripts/test-raia-27-protecoes.js`
   - Configurações e Fail-Safe Boot: `src/config/index.js`
   - Motor SQLite e Esquemas: `src/database/db.js`
   - Proteções de Borda HTTP, Anti-CSRF e RBAC: `src/server/app.js`
   - TOTP MFA e Criptografia AES-GCM: `src/services/totpService.js`
   - Rate Limiter Persistente: `src/middlewares/rateLimiter.js`
   - Isolamento de Webhooks Asaas/Hotmart: `src/services/asaasService.js` e `src/services/hotmartService.js`
   - Fila Outbox e Resiliência Google Calendar: `src/services/outboxWorker.js` e `src/services/googleCalendarService.js`

2. **Comando de Teste Recomendado (quando autorizado em ambiente isolado)**:
   - Suíte de 27 Proteções (executada em SQLite temporário volátil):
     ```bash
     node scripts/test-raia-27-protecoes.js
     ```
   - Auditoria Independente de Segurança (15 cenários de RBAC e autenticação):
     ```bash
     node scripts/test-integration-security.js
     ```
   - Condição de Invalidação: Qualquer falha ou erro asserção nos testes acima invalida a conformidade da proteção correspondente.
