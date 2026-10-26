@echo off
chcp 65001 > nul
title Atualizar RAIA Agentes - GitHub e Easypanel
echo ========================================================
echo   ATUALIZANDO RAIA AGENTES
echo   - Vitrine Publica dos Agentes na Raiz (raiaagentes.com.br)
echo   - Painel do Administrador Protegido em /admin
echo   - Motor de Vozes Neurais Naturais e Seletor de Ritmo
echo ========================================================
echo.
cd /d "c:\Users\Acer\Downloads\assistente zap"

echo [1/3] Adicionando arquivos alterados...
git add .

echo [2/3] Criando versao com vitrine publica e painel admin...
git commit -m "feat: vitrine publica dos agentes na raiz e painel administrativo protegido em /admin com vozes neurais"

echo [3/3] Enviando para o GitHub...
git push

echo.
echo ========================================================
echo   CONCLUIDO COM SUCESSO!
echo   Agora va no seu Easypanel e clique em 'Implantar' no 'bot'!
echo ========================================================
echo.
pause
