@echo off
chcp 65001 > nul
title Atualizar Assistente Zap - GitHub e Easypanel
echo ========================================================
echo   ATUALIZANDO ASSISTENTE ZAP NO GITHUB / EASYPANEL
echo ========================================================
echo.
cd /d "c:\Users\Acer\Downloads\assistente zap"

echo [1/3] Adicionando arquivos alterados...
git add .

echo [2/3] Criando versao com Estudio de Marketing e Login Admin...
git commit -m "feat: ativar estudio de marketing e acesso admin"

echo [3/3] Enviando para o GitHub...
git push

echo.
echo ========================================================
echo   CONCLUIDO COM SUCESSO!
echo   O Easypanel esta atualizando seu site agora.
echo   Aguarde cerca de 1 minuto e recarregue o site!
echo ========================================================
echo.
pause
