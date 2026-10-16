# syntax=docker/dockerfile:1
#
# KWIK Agentes em container. Suba com `npm run docker:up`: ele acha as contas do Claude Code e do Codex no
# computador e gera o docker-compose.override.yml com as montagens SOMENTE LEITURA. Este Dockerfile sozinho não
# monta nada do computador.
FROM node:24-alpine

ENV NODE_ENV=production \
    KWIK_HOST=0.0.0.0 \
    KWIK_PORT=5945 \
    KWIK_IN_DOCKER=1 \
    HOME=/tmp

WORKDIR /app

# Sem dependências: nada é baixado no build além da imagem do Node.
COPY package.json ./
COPY server ./server
COPY public ./public

# Usuário sem privilégios. No Linux, o docker:up troca pelo seu usuário (para ler os arquivos que só você lê).
USER node
EXPOSE 5945

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5945/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server/index.mjs"]
