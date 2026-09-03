# syntax=docker/dockerfile:1

# The API, and the migration runner: one image, two commands. The schema a
# deploy applies is then by construction the one its code was built against.
#
# Build context is the repository root, not this directory — the workspace
# packages the API depends on live outside it.

FROM node:24-alpine AS build
WORKDIR /app

# Manifests before sources, so editing a handler does not re-resolve the
# dependency tree on every build.
COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/platform/package.json packages/platform/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
# Present so npm can read the workspace globs; its dependencies are never
# installed, which is the point of scoping the install to @billing/api.
COPY apps/web/package.json apps/web/

RUN npm ci --ignore-scripts --include-workspace-root -w @billing/api

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api

# Builds the referenced projects too — domain, platform, db.
RUN npx tsc -b apps/api

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/platform/package.json packages/platform/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --omit=dev --ignore-scripts --include-workspace-root -w @billing/api

COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/packages/platform/dist packages/platform/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/api/dist apps/api/dist

# Read at runtime by name, relative to packages/db/dist — not bundled.
COPY packages/db/migrations packages/db/migrations

USER node
EXPOSE 8080

# Asks the application, not the process table. /health touches PostgreSQL on
# purpose: a container that is up but cannot reach the database is not healthy,
# and saying otherwise wastes an on-call hour.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
