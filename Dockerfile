FROM node:22-slim

# Configuracao de fuso horario brasileiro
RUN apt-get update && apt-get install -y tzdata && rm -rf /var/lib/apt/lists/*
ENV TZ=America/Sao_Paulo

WORKDIR /app

# Instalar dependencias de producao
COPY package*.json ./
RUN npm install --omit=dev

# Copiar codigo-fonte (respeitando .dockerignore rigoroso)
COPY . .

# Criar diretorios de persistencia isolados
RUN mkdir -p /app/data /app/auth_info_baileys

EXPOSE 3333
ENV PORT=3333
ENV NODE_ENV=production

# Verificacao de saude nativa Docker contra o endpoint de readiness
HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3333/api/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
