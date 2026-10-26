@echo off
chcp 65001 > nul
title Atualizar RAIA Agentes - GitHub e Easypanel
echo ========================================================
echo   ATUALIZANDO RAIA AGENTES (LAYOUT PC & SELETOR DE TEMAS)
echo ========================================================
echo.
cd /d "c:\Users\Acer\Downloads\assistente zap"

echo [1/3] Adicionando arquivos alterados...
git add .

echo [2/3] Criando versao com layout desktop PC e seletores de temas...
git commit -m "feat: layout desktop responsivo para PC (12 colunas) e seletor de assistentes no estudio de video"

echo [3/3] Enviando para o GitHub...
git push

echo.
echo ========================================================
echo   CONCLUIDO COM SUCESSO!
echo   Agora va no seu Easypanel e clique em 'Implantar' no 'bot'!
echo ========================================================
echo.
pause
