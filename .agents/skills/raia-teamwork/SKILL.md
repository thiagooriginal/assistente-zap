---
name: raia-teamwork
description: >-
  Procedimento operacional padronizado da equipe multiagente RAIA AGENTES na branch security/raia-27-protecoes.
  Use esta skill quando o usuário solicitar desenvolvimento, refatoração, análise de segurança,
  criação de testes ou auditoria técnica envolvendo a cooperação dos seis especialistas.
---

# Skill Operacional: Orquestração Multiagente — RAIA AGENTES

Este runbook orienta o Coordenador Geral na triagem, distribuição, acompanhamento e consolidação de tarefas entre os seis especialistas da plataforma RAIA AGENTES.

## 1. Passo a Passo da Triagem e Despacho
1. **Identificar a Complexidade e o Escopo da Demanda**:
   - Demanda de Nova Rota / API: Despachar para `raia-arquiteto`, `raia-desenvolvedor` e `raia-seguranca`.
   - Demanda de Banco de Dados / Webhooks: Despachar para `raia-sqlite` e `raia-seguranca`.
   - Demanda de Validação / Qualidade: Despachar para `raia-testes` e `raia-revisor`.
   - Demanda Ampla ou Crítica: Acionar a esteira completa.
   - Demanda Simples: Convoque apenas o especialista estritamente necessário.
2. **Delegação via Ferramenta de Subagente**:
   - Acione cada especialista formalmente via `invoke_subagent` com o nome configurado em `.agents/agents/`.
   - Forneça no prompt da tarefa o objetivo específico, restrições e artefatos de entrada.
3. **Coleta e Confronto de Handoffs**:
   - Aguarde as mensagens de retorno de cada especialista.
   - Aplique a Matriz de Prevalência em caso de divergência técnica.
   - Encaminhe a proposta consolidada para auditoria do `raia-revisor`.
4. **Entrega com Riscos e Evidências**:
   - Apresente ao usuário o relatório final contendo:
     - Diagnóstico e Pareceres dos Especialistas
     - Evidências Técnicas e Testes Executados (Herméticos)
     - Matriz de Riscos Residuais
     - Solicitação de Autorização Explícita para Implementar
