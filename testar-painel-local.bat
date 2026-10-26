@echo off
chcp 65001 > nul
title Abrir Painel Assistente Zap Local
echo ========================================================
echo   INICIANDO PAINEL DO ASSISTENTE ZAP (LOCAL)
echo ========================================================
echo.
cd /d "c:\Users\Acer\Downloads\assistente zap"

echo Abrindo o painel no seu navegador...
start http://localhost:3333/

echo Iniciando servidor Node.js...
node src/index.js
pause
