# ── build stage ──────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
# postinstall runs `prisma generate`
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npx nest build && npm prune --omit=dev
# `prisma` is a production dependency (the entrypoint runs migrate deploy / db push),
# so it survives the prune; regenerate the client afterwards so it is guaranteed to be present.
RUN npx prisma generate

# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
# strip Windows line endings (a CRLF entrypoint fails with "not found"), then make it executable
RUN sed -i 's/\r$//' ./scripts/docker-entrypoint.sh && chmod +x ./scripts/docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3000
# Liveness only (no DB): a database outage must not make Docker kill the app.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000,a=process.env.API_PREFIX||'api/v1';require('http').get('http://127.0.0.1:'+p+'/'+a+'/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "./scripts/docker-entrypoint.sh"]
