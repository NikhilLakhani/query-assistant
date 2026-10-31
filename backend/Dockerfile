# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false

FROM base AS build
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY backend/tsconfig.json backend/prisma.config.ts backend/
COPY backend/prisma backend/prisma
COPY backend/src backend/src
RUN npm run build -w @query-assistant/contracts && npm run build -w @query-assistant/backend

# One-shot schema deployment image. Tooling stays out of the application runtime.
FROM build AS tooling
USER node
CMD ["npm", "run", "db:migrate", "-w", "@query-assistant/backend"]

FROM base AS production-dependencies
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true
RUN npm ci --omit=dev --omit=peer --omit=optional --workspace=@query-assistant/backend --workspace=@query-assistant/contracts \
    && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/backend/dist ./backend/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "backend/dist/server.js"]
