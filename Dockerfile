FROM node:22-slim

# Configuração de fuso horário brasileiro
RUN apt-get update && apt-get install -y tzdata && rm -rf /var/lib/apt/lists/*
ENV TZ=America/Sao_Paulo

WORKDIR /app

# Instalar dependências de produção
COPY package*.json ./
RUN npm install --omit=dev

# Copiar código-fonte
COPY . .

# Criar diretórios de persistência se não existirem
RUN mkdir -p /app/data /app/auth_info_baileys

EXPOSE 3333
ENV PORT=3333
ENV NODE_ENV=production

CMD ["npm", "start"]
