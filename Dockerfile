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
# --include=dev is required because Railway sets NODE_ENV=production at
# build time, which would otherwise make npm skip devDependencies (and
# we need the `prisma` CLI from devDeps for migrate deploy at runtime).
RUN npm ci --workspace @junjo/shared --workspace @junjo/server --include-workspace-root --include=dev

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

# Default CMD: apply migrations then start the server. Diagnostic echos
# go to stderr (>&2) AND stdout so they survive any logger config; pino
# in Junjo writes to stdout but won't appear until the server actually
# boots. railway.toml's startCommand intentionally does NOT override
# this -- if it does, none of these echos surface.
CMD ["bash", "-c", "echo '[boot] container started, node='$(node --version) >&2; echo '[boot] checking prisma availability' >&2; ls -la node_modules/.bin/prisma >&2 || echo '[boot] prisma binary missing!' >&2; echo '[boot] applying migrations' >&2; npx prisma migrate deploy --schema packages/server/prisma/schema.prisma 2>&1; rc=$?; echo '[boot] migrate exit='$rc >&2; if [ $rc -ne 0 ]; then exit $rc; fi; echo '[boot] starting server on PORT='$PORT >&2; exec node packages/server/dist/index.js"]
