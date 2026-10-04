# 🤖 Assistente Pessoal WhatsApp (Finanças & Google Calendar)

Um assistente inteligente que roda no seu WhatsApp pessoal, interpretando mensagens em **texto**, **áudio de voz** e **fotos de comprovantes/cupons fiscais**, gerenciando suas finanças em um banco de dados local e integrado com o **Google Calendar** com envio de lembretes automáticos.

---

## 🚀 Funcionalidades

### 1. 💰 Gestão Financeira Inteligente
- **Multi-formato de entrada**:
  - **Texto**: *"Gastei 50 no almoço"*, *"120 de gasolina no posto Shell no cartão"*.
  - **Áudio de voz**: Fale naturalmente no WhatsApp e o assistente transcreve e extrai os valores.
  - **Foto / Imagem**: Envie foto de cupom fiscal ou comprovante Pix; a IA lê o total, estabelecimento e data.
- **Categorização Automática**:
  - `Gasolina / Combustível`, `Alimentação`, `Mercado`, `Saúde / Farmácia`, `Transporte`, `Lazer / Diversão`, `Moradia / Contas`, etc.
- **Consultas em Linguagem Natural**:
  - *"Quanto eu gastei de gasolina nos últimos 15 dias?"* ➡️ *"Você teve um gasto de R$ 250,00 de gasolina nos últimos 15 dias."*
  - *"Quanto gastei hoje?"*
  - *"Quais foram meus gastos desse mês no mercado?"*
- **Cancelamento**:
  - *"Apagar último gasto"* (caso você tenha digitado algo errado).

### 2. 📊 Dashboard Financeiro em Tempo Real
- **Acesse pelo navegador**: `http://localhost:3333`
- **Métricas Visuais (KPIs)**: Total no mês, total hoje, gastos em gasolina nos últimos 15 dias, ticket médio.
- **Gráficos Interativos**: Distribuição de gastos por categoria (rosca) e evolução diária (barras).
- **Tabela com Filtros**: Busca instantânea, filtro por categoria, identificação da origem (WhatsApp texto, áudio, foto ou manual).
- **Gerenciamento Completo**: Adicione gastos manualmente, edite ou exclua registros com 1 clique.
- **Exportação**: Baixe seus relatórios em planilha Excel / CSV.

### 2. 📅 Integração com Google Calendar & Lembretes
- **Agendamento por WhatsApp**:
  - *"Marcar reunião com fornecedor amanhã às 14h"*
  - *"Dentista sexta-feira às 10h"*
- **Sistema de Lembretes Proativos (via WhatsApp)**:
  - 🔔 **1 dia antes** (24 horas de antecedência)
  - ⏰ **3 horas antes**
  - 🚨 **1 hora antes**

---

## 🛠️ Configuração Rápida

### 1. Obter a Chave do Google Gemini (Gratuito)
1. Acesse [Google AI Studio](https://aistudio.google.com/).
2. Clique em **"Get API key"** e gere sua chave.
3. Abra o arquivo `.env` na pasta do projeto e cole sua chave:
   ```env
   GEMINI_API_KEY=sua_chave_aqui
   AUTHORIZED_PHONE=5511999999999
   ```
   *(Substitua pelo seu número com código do país 55 e DDD).*

---

### 2. Conectar com o Google Calendar (Opcional para iniciar, necessário para a agenda)
1. Acesse o [Google Cloud Console](https://console.cloud.google.com/).
2. Crie um projeto ou selecione um existente.
3. Ative a **Google Calendar API** no menu *APIs e Serviços > Biblioteca*.
4. Vá em *APIs e Serviços > Credenciais > Criar Credenciais > ID do cliente OAuth*:
   - Tipo de aplicativo: **Aplicativo para Computador (Desktop)** ou **Aplicativo da Web** (com URI `http://localhost:3000/oauth2callback`).
5. Baixe o arquivo JSON gerado e salve na raiz deste projeto com o nome: `google_credentials.json`.
6. No terminal, execute:
   ```powershell
   npm run auth-calendar
   ```
7. O navegador abrirá para você autorizar sua conta do Google. Uma vez aprovado, pronto! Os tokens são salvos automaticamente.

---

### 3. Iniciar o Assistente
No terminal, execute:
```powershell
npm start
```

1. Um **QR Code** será exibido no terminal e também salvo como imagem no arquivo `qrcode.png`.
2. Abra o WhatsApp no celular:
   - Toque em **Aparelhos Conectados** > **Conectar um aparelho**.
   - Aponte a câmera para o QR Code.
3. Pronto! O assistente está online e pronto para receber suas mensagens, áudios e comprovantes.
