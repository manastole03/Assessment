# syntax=docker/dockerfile:1.7
# The control plane image: the NestJS API plus the built web UI it serves.
# Build context is the repository root (it needs ui/ as well as backend/):
#   docker build -f backend/Dockerfile -t rote-backend .
#
# Stages: ui (React build) → deps → build (compile; also runs migrations) → prod-deps → runtime.

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------- the web UI
FROM ${NODE_IMAGE} AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# ---------------------------------------------------------------- all dependencies
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------------------------------------------------------------- compile
# Also the image of the one-shot `migrate` job: it has the Prisma CLI and the seed script.
FROM deps AS build
COPY backend/ ./
RUN npx prisma generate && npx nest build
USER node

# ---------------------------------------------------------------- runtime dependencies only
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
# No install scripts needed: argon2 ships prebuilt musl binaries, and the Prisma client is generated in `build`.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    PORT=3000 \
    UI_DIST_PATH=/app/public
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=ui --chown=node:node /ui/dist ./public
COPY --chown=node:node backend/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM so Nest's shutdown hooks run (drain requests, close the pool, release leases).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
