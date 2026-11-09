## 2026-11-09T13:31:47Z
You are teamwork_explorer_survey_3.
Working directory: c:\Users\Acer\Downloads\assistente zap\.agents\teamwork\teamwork_explorer_survey_3\
Original Request path: c:\Users\Acer\Downloads\assistente zap\.agents\teamwork\ORIGINAL_REQUEST.md
Dispatch file: c:\Users\Acer\Downloads\assistente zap\.agents\teamwork\teamwork_explorer_survey_3\DISPATCH.md

STRICT CONSTRAINTS:
- STRICTLY READ-ONLY investigation.
- DO NOT create or modify any repository files (only write to your own directory under .agents/teamwork/teamwork_explorer_survey_3/).
- DO NOT run any scripts, build commands, test commands, or modify production environment.
- Use read-only tools: find_by_name, grep_search, view_file, list_dir.

OBJECTIVES:
1. Read c:\Users\Acer\Downloads\assistente zap\.agents\teamwork\ORIGINAL_REQUEST.md.
2. Investigate the test infrastructure of the repository:
   - Test frameworks used (Jest, Mocha, Vitest, Cypress, Supertest, etc.).
   - Existing test files, unit tests, integration tests, E2E tests.
   - Test configurations (jest.config.js, etc.), mock files, fixtures.
   - npm test scripts and testing conventions.
3. Identify what is currently covered by automated tests (e.g. security tests, route tests, database tests, agent behavior tests) and what gaps exist.
4. Review quality assurance tooling: linters (ESLint), formatters (Prettier), type checking (TypeScript/JSDoc), CI/CD workflows (.github/workflows).
5. Produce a comprehensive report in c:\Users\Acer\Downloads\assistente zap\.agents\teamwork\teamwork_explorer_survey_3\handoff.md.
6. When complete, send a message to orchestrator with send_message summarizing your report path and key findings.
