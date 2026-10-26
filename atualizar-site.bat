@echo off
chcp 65001 > nul
title Atualizar RAIA Agentes - GitHub e Easypanel
echo ========================================================
echo   ATUALIZANDO RAIA AGENTES
echo   - Fluxo Guiado em 2 Passos:
echo     1. Gerar Prompt e Storytelling com IA (A Historia)
echo     2. Pegar as Informacoes e Criar o Video no WhatsApp
echo   - Vozes Neurais de Alta Definicao (Google Studio Neural)
echo ========================================================
echo.
cd /d "c:\Users\Acer\Downloads\assistente zap"

echo [1/3] Adicionando arquivos alterados...
git add .

echo [2/3] Criando versao com esteira de storytelling e video...
git commit -m "feat: esteira em 2 etapas (storytelling com IA -> criar video whatsapp) e vozes neurais google studio"

echo [3/3] Enviando para o GitHub...
git push

echo.
echo ========================================================
echo   CONCLUIDO COM SUCESSO!
echo   Agora va no seu Easypanel e clique em 'Implantar' no 'bot'!
echo ========================================================
echo.
pause
