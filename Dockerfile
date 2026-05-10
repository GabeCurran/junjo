# Junjo server: multi-stage Node 20 image.
#   builder: install workspace deps, build @junjo/shared, build @junjo/server,
#            generate Prisma client.
#   runtime: copy the materialized build + node_modules and run.
# Migrations apply on boot via the start command (see railway.toml). The
# image is project-agnostic; any consumer points at the deployed URL with
# JUNJO_ADMIN_TOKEN as the security boundary.

FROM node:20-alpine AS builder
WORKDIR /app

# OpenSSL is needed by the Prisma engine binaries on alpine.
RUN apk add --no-cache openssl

# Copy only manifests first so npm ci can be cached when source changes.
# We need every workspace's package.json that participates in the install
# graph plus the prisma schema (postinstall runs `prisma generate`).
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/server/prisma packages/server/prisma

# `npm ci --workspaces` would also walk apps/* and tools/* per the root
# workspaces glob, which we don't ship. The two scoped --workspace flags
# limit install to the runtime graph and skip dashboard/docs/screenshots.
RUN npm ci --workspace @junjo/shared --workspace @junjo/server --include-workspace-root

# Now bring in source for the two workspaces we actually build.
COPY packages/shared packages/shared
COPY packages/server packages/server

# Shared must build first because @junjo/server imports its dist output.
RUN npm run build -w @junjo/shared
RUN npm run build -w @junjo/server


# ----- runtime -----
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl

# bash so the start command can use && + diagnostic echos.
RUN apk add --no-cache bash

ENV NODE_ENV=production
# PORT is overridden by Railway at runtime; the server reads $PORT and
# falls back to 8787 (see env.ts). EXPOSE is a documentation hint -- it
# does not bind anything by itself.
ENV PORT=8787
EXPOSE 8787

# Copy the built workspace tree. npm workspaces hoist deps to the root
# /app/node_modules, including the generated Prisma client at
# .prisma/client + @prisma/client, so we don't copy per-workspace
# node_modules (they don't exist in the builder when everything hoists).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/prisma ./packages/server/prisma
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json

# Default CMD: apply migrations then start the server. railway.toml can
# override via `startCommand`, but baking it here keeps the image
# self-sufficient for any orchestrator. Diagnostic echos surface the
# failure step in the deploy log if either command exits non-zero.
CMD ["bash", "-c", "set -e; echo '[boot] applying migrations'; npx prisma migrate deploy --schema packages/server/prisma/schema.prisma; echo '[boot] migrations done; starting server'; exec node packages/server/dist/index.js"]
