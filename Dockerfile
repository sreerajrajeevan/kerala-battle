# Task 11: production Docker image for Kerala Battle.
#
# Multi-stage build:
#   1. build  — full toolchain, compiles shared + web + server
#   2. runtime — production dependencies only, non-root user, single command
#
# Architecture note (single instance): SQLite + in-memory realtime state
# means exactly ONE backend container may be active. Do NOT scale this
# service horizontally (no replicas, no autoscaling) — see DEPLOYMENT.md.
#
# Build with version metadata:
#   docker build --build-arg APP_VERSION=0.2.0 --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) -t kerala-battle .

ARG APP_VERSION=0.1.0
ARG GIT_COMMIT=unknown

# ---------------------------------------------------------------- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY . .
RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data \
    SERVE_STATIC=true
WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output only (no source, no dev tooling).
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json

# Build metadata for GET /api/version.
ARG APP_VERSION
ARG GIT_COMMIT
ENV APP_VERSION=${APP_VERSION} \
    GIT_COMMIT=${GIT_COMMIT}

# Persistent SQLite storage. Never bake the database into the image.
VOLUME /data
RUN mkdir -p /data && useradd --system --uid 1001 --home /app appuser \
    && chown -R appuser:appuser /app /data
USER appuser

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# One production command.
CMD ["node", "apps/server/dist/index.js"]
