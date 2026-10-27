@echo off
chcp 65001 > nul
title Atualizar RAIA RH - GitHub e Easypanel
echo ========================================================
echo   ATUALIZANDO RAIA RH
echo   - Marca Oficial: RAIA RH
echo   - Novo Logo 3D Oficial em Evidência
echo   - Slogan: "RAIA, um oceano de possibilidades"
echo   - Fundo Tecnológico Oceânico Animado (Oceano Digital)
echo   - Esteira 2 Passos (Storytelling IA + Vídeo WhatsApp)
echo   - Vozes Neurais Google Studio
echo ========================================================
echo.
cd /d "c:\Users\Acer\Downloads\assistente zap"

echo [1/4] Copiando Novo Logo 3D Oficial para a pasta public...
if exist "C:\Users\Acer\.gemini\antigravity\brain\02a81ab1-3f50-4b80-b427-db4dc205d437\.user_uploaded\media_1793058378790_e29fd7f4.jpg" (
  copy /y "C:\Users\Acer\.gemini\antigravity\brain\02a81ab1-3f50-4b80-b427-db4dc205d437\.user_uploaded\media_1793058378790_e29fd7f4.jpg" "c:\Users\Acer\Downloads\assistente zap\public\raia-logo.jpg" > nul
) else (
  copy /y "C:\Users\Acer\.gemini\antigravity\brain\02a81ab1-3f50-4b80-b427-db4dc205d437\raia_logo_variation_b_1793040481330.jpg" "c:\Users\Acer\Downloads\assistente zap\public\raia-logo.jpg" > nul
)

echo [2/4] Adicionando arquivos alterados ao Git...
git add .

echo [3/4] Criando versão oficial RAIA RH...
git commit -m "feat: RAIA, um oceano de possibilidades, novo logo 3D e oceano animado"

echo [4/4] Enviando para o GitHub...
git push

echo.
echo ========================================================
echo   CONCLUIDO COM SUCESSO!
echo   Agora vá no seu Easypanel e clique em 'Implantar' no 'bot'!
echo   Depois no navegador aperte CTRL + F5 para limpar o cache!
echo ========================================================
echo.
pause
