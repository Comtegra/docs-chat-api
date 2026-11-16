# syntax=docker/dockerfile:1.7
# docs-chat-api — wielo-tenantowy asystent dokumentacji (RAG, pg-vector).
# Bez Nexta, bez .env w obrazie, node jako PID 1.
# USER root (nie node): wolumeny CGC montują się root-owned — użytkownik node nie ma prawa
# napisać prompt.md (default tworzy go serwis przy 1. boocie, PUT /api/v1/admin/prompt pisze
# go w locie). Kontener na CGC jest i tak nieuprzywilejowany, single-tenant app compute —
# konwencja platformy (jupyter/hermes biegają jako root).
ARG NODE_IMAGE=node:22.23.2-alpine3.24

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=3001 HOST=0.0.0.0
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node server ./server
COPY --chown=node:node db ./db
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/docs-chat-api.mjs"]
