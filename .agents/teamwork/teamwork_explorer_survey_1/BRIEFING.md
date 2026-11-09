# BRIEFING — 2026-11-09T13:54:30Z

## Mission
Investigate and survey the RAIA AGENTES codebase: directory structure, dependencies, configuration, entry points, architecture, execution flows, and integration points.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigator, synthesizer
- Working directory: c:\Users\Acer\Downloads\assistente zap\.agents\teamwork\teamwork_explorer_survey_1\
- Original parent: d79e4fda-8f0a-422c-8af2-064d55825207
- Milestone: codebase-survey

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Strictly read-only investigation: do NOT modify codebase files outside working directory
- Do NOT run scripts, build commands, or test commands

## Current Parent
- Conversation ID: d79e4fda-8f0a-422c-8af2-064d55825207
- Updated: not yet

## Investigation State
- **Explored paths**:
  - Root: package.json, Dockerfile, docker-compose.yml, docker-compose.staging.yml, easypanel.staging.json, .env.example, README.md, .git/HEAD
  - Core Source: src/index.js, src/config/index.js, src/database/db.js, src/server/app.js, src/server/start-staging.js, src/routes/clientRoutes.js
  - Services: aiService.js, agentChatService.js, clientAuthService.js, totpService.js, securityAuditService.js, googleCalendarService.js, outboxWorker.js, asaasService.js, hotmartService.js, directSalesService.js, productService.js, planCatalog.js, salonDashboardService.js, salonAppointmentService.js, salonNotificationService.js, serviceCatalog.js
  - WhatsApp: src/whatsapp/client.js, src/whatsapp/messageHandler.js
  - Scripts: test-raia-27-protecoes.js, test-production-startup-validation.js, backup-and-verify.js, rollback.js, start-homologacao.js
- **Key findings**:
  - Repository branch: `security/raia-27-protecoes` (Git HEAD verified).
  - Runtime: Node.js 22 with built-in synchronous SQLite (`node:sqlite DatabaseSync`), Express 5.2.1, Baileys 7.0.0-rc.14, Google Generative AI 0.24.1.
  - Multi-product Architecture: 10 market segments, core products (JÉSSICA - Beauty/Salon, JARVIS - Finance, DRA. CAMILA - Clinic, GROWTH ASSISTANT VIP), subscription isolation.
  - 27 Security Protections verified across auth (TOTP MFA RFC 6238, AES-256-GCM token encryption), RBAC, anti-CSRF, rate limiting, host header validation, fail-closed staging sandbox, audit trail.
  - Multi-tenant Google Calendar with outbox resilience and WhatsApp outbox dispatch.
- **Unexplored areas**: None for codebase survey scope. Ready to compile handoff report.

## Key Decisions Made
- Fully documented the 5-component handoff report.

## Artifact Index
- DISPATCH.md — incoming dispatch instructions
- BRIEFING.md — persistent state memory
- progress.md — liveness and step progress
- handoff.md — final survey report
