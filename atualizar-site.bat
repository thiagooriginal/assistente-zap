@echo off
chcp 65001 > nul
title Atualizar Assistente Zap - GitHub e Easypanel
echo ========================================================
echo   ATUALIZANDO ASSISTENTE ZAP (ESTUDIO DE VIDEOS IA)
echo ========================================================
echo.
cd /d "c:\Users\Acer\Downloads\assistente zap"

echo [1/3] Adicionando arquivos alterados...
git add .

echo [2/3] Criando versao com Criador de Videos WhatsApp e Avatares IA...
git commit -m "feat: adicionar criador de videos whatsapp reels e avatar IA"

echo [3/3] Enviando para o GitHub...
git push

echo.
echo ========================================================
echo   CONCLUIDO COM SUCESSO!
echo   Va no seu Easypanel e clique em 'Implantar' no 'bot'!
echo ========================================================
echo.
pause
