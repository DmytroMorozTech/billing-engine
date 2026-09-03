# syntax=docker/dockerfile:1

# The outbox relay. Same shape as the API image, and deliberately a separate
# one: the two scale for different reasons and fail in different ways, and a
# single image running two roles hides which of them is unhealthy.
#
# Build context is the repository root, not this directory — the workspace
# packages the worker depends on live outside it.

FROM node:24-alpine AS build
WORKDIR /app

# Manifests before sources, so editing a handler does not re-resolve the
# dependency tree on every build.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/platform/package.json packages/platform/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
# Present so npm can read the workspace globs; its dependencies are never
# installed, which is the point of scoping the install to @billing/api.
COPY apps/web/package.json apps/web/

RUN npm ci --ignore-scripts --include-workspace-root -w @billing/worker

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker

# Builds the referenced projects too — domain, platform, db.
RUN npx tsc -b apps/worker

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/platform/package.json packages/platform/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/

RUN npm ci --omit=dev --ignore-scripts --include-workspace-root -w @billing/worker

COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/packages/platform/dist packages/platform/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist

# Read at runtime by name, relative to packages/db/dist — not bundled.
COPY packages/db/migrations packages/db/migrations

USER node

# No healthcheck, and no port. A process-liveness probe would only repeat what
# Docker already knows. What says whether the relay is working is the outbox
# backlog — a number for a dashboard, not for a restart policy: a relay behind
# a slow transport is doing its job and must not be killed for it.

CMD ["node", "apps/worker/dist/main.js"]
