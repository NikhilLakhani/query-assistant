# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --workspace=@query-assistant/frontend --workspace=@query-assistant/contracts --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY frontend frontend
# Public browser origin only. Secrets are never build arguments.
ARG VITE_API_BASE_URL=https://localhost:8443
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build -w @query-assistant/contracts && npm run build -w @query-assistant/frontend

FROM caddy:2-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5 AS runtime
RUN mkdir -p /data /config /srv && chown -R 10001:10001 /data /config /srv
COPY --from=build /app/frontend/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
USER 10001:10001
EXPOSE 8443
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
