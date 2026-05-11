# ─── Build stage ─────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package*.json ./
RUN npm ci --omit=dev

# ─── Runtime stage ───────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache sqlite tini && \
    addgroup -S pratica && adduser -S pratica -G pratica
COPY --from=build /app/node_modules ./node_modules
COPY --chown=pratica:pratica src ./src
COPY --chown=pratica:pratica package.json ./
RUN mkdir -p /app/data && chown -R pratica:pratica /app/data

USER pratica
EXPOSE 3000

# tini handles SIGTERM properly so graceful shutdown works
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health > /dev/null || exit 1
