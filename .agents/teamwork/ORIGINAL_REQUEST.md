# Original User Request

## Initial Request — 2026-11-09T13:28:10Z

Estruturar uma equipe multiagente permanente para o desenvolvimento da RAIA AGENTES, organizada em seis especialidades coordenadas por um agente principal, analisando o projeto na branch `security/raia-27-protecoes` e explicando como configurar e reutilizar esse fluxo sem modificar arquivos ou o ambiente de produção.

Working directory: c:\Users\Acer\Downloads\assistente zap
Integrity mode: demo
The team must NOT: executar scripts externos ou delegar execução a outras ferramentas; alterar arquivos, instalar dependências, realizar deploy ou modificar produção; implementar alterações sem autorização prévia.

## Verification Resources
- Repositório local e arquivos de configuração/código existentes na branch `security/raia-27-protecoes`.

## Requirements

### R1. Estruturação da Equipe Multiagente Permanente
Estruturar e documentar a equipe multiagente organizada em seis especialidades:
1. Arquiteto de software
2. Desenvolvedor full-stack Node.js
3. Especialista em cibersegurança
4. Especialista em banco SQLite e integrações
5. Engenheiro de testes automatizados
6. Revisor técnico independente
Para cada especialidade, definir responsabilidades, escopo de análise, critérios de revisão e templates de instruções/prompts operacionais.

### R2. Protocolo de Coordenação do Agente Principal
Definir o fluxo de coordenação pelo agente principal, estabelecendo como delegar análises independentes aos especialistas, comparar conclusões, resolver divergências e consolidar recomendações finais acompanhadas de riscos identificados e evidências técnicas.

### R3. Análise da Base de Código e Guia de Configuração e Reutilização
Analisar a arquitetura e os componentes do projeto RAIA AGENTES a partir do estado atual da branch `security/raia-27-protecoes`. Explicar de forma passo a passo e reutilizável como configurar, executar e reutilizar esse fluxo de trabalho em demandas futuras do projeto. A entrega deve ser feita integralmente no relatório final de resposta, sem criar ou alterar arquivos no repositório.

### R4. Restrições de Integridade e Ambiente
Não alterar nenhum arquivo existente nem criar arquivos no repositório. Não instalar pacotes ou dependências. Não realizar deploy nem modificar o ambiente de produção. Respeitar estritamente a branch `security/raia-27-protecoes`. Solicitar autorização explícita do usuário antes de qualquer implementação de código.

## Acceptance Criteria

### Estruturação das Especialidades
- [ ] Os 6 papéis especializados possuem definição clara de responsabilidades, escopos de atuação e critérios de revisão.
- [ ] Cada uma das 6 especialidades conta com template operacional de prompt/instruções para uso no fluxo multiagente.

### Protocolo de Coordenação
- [ ] O protocolo define mecanismos para o agente principal delegar tarefas independentes, comparar achados e consolidar recomendações finais com riscos e evidências.

### Análise e Reutilização do Fluxo
- [ ] A análise técnica cobre a estrutura, componentes e estado do repositório na branch `security/raia-27-protecoes`.
- [ ] O relatório final contém o guia passo a passo para configuração e reutilização contínua do fluxo de trabalho multiagente.
- [ ] Nenhuma alteração foi realizada no sistema de arquivos do repositório, nenhuma dependência foi adicionada e nenhum deploy ou alteração de produção ocorreu.
