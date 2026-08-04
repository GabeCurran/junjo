# Unified Junjo image. One Dockerfile, three apps. Each Railway service
# selects which app to build + run by setting the WORKSPACE service
# variable; Railway auto-passes vars matching Dockerfile ARGs as build
# args.
#
#   WORKSPACE=server    -> @junjo/server (Hono API, default)
#   WORKSPACE=dashboard -> @junjo/dashboard (Next.js admin UI)
#   WORKSPACE=docs      -> @junjo/docs (Nextra)
#
# Why one Dockerfile instead of three: Railway's per-service
# RAILWAY_DOCKERFILE_PATH only takes effect when the service's Builder
# is also set to "Dockerfile" (not Railpack) in the dashboard UI, and
# that toggle has reverted to Railpack on us multiple times. With a
# single Dockerfile at the canonical root path, Railway's auto-detect
# always finds the right thing regardless of Builder mode.

ARG WORKSPACE=server

# ----- builder -----
FROM node:20-alpine AS builder
ARG WORKSPACE
WORKDIR /app

RUN apk add --no-cache openssl

# Manifests first for cache reuse on source changes. The server
# postinstall runs `prisma generate`, so the schema must be present
# during install -- copy it before `npm ci`.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
COPY packages/server/prisma packages/server/prisma
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/docs/package.json apps/docs/

# Install only the workspaces this build needs. --include=dev because
# Railway sets NODE_ENV=production at build time, which would otherwise
# make npm skip devDependencies (Prisma CLI, tsc, next, etc.).
RUN if [ "$WORKSPACE" = "server" ]; then \
      npm ci --workspace @junjo.io/shared --workspace @junjo/server --include-workspace-root --include=dev; \
    elif [ "$WORKSPACE" = "dashboard" ]; then \
      npm ci --workspace @junjo.io/shared --workspace @junjo.io/sdk --workspace @junjo/dashboard --include-workspace-root --include=dev; \
    elif [ "$WORKSPACE" = "docs" ]; then \
      npm ci --workspace @junjo/docs --include-workspace-root --include=dev; \
    else echo "unknown WORKSPACE=$WORKSPACE" >&2 && exit 1; fi

# Source. Workspace-specific later steps would need conditional COPYs,
# which Docker can't express cleanly; copy everything and let the
# workspace-scoped build commands pick what they need.
COPY packages/shared packages/shared
COPY packages/sdk packages/sdk
COPY packages/server packages/server
COPY apps/dashboard apps/dashboard
COPY apps/docs apps/docs

RUN if [ "$WORKSPACE" = "server" ]; then \
      npm run build -w @junjo.io/shared && npm run build -w @junjo/server; \
    elif [ "$WORKSPACE" = "dashboard" ]; then \
      npm run build -w @junjo.io/shared && npm run build -w @junjo.io/sdk && npm run build -w @junjo/dashboard; \
    elif [ "$WORKSPACE" = "docs" ]; then \
      npm run build -w @junjo/docs; \
    fi


# ----- runtime -----
FROM node:20-alpine AS runtime
ARG WORKSPACE
WORKDIR /app

RUN apk add --no-cache openssl bash

ENV NODE_ENV=production
# Re-export so the CMD shell sees it (ARGs don't survive into the
# CMD's runtime environment without an explicit ENV).
ENV WORKSPACE=$WORKSPACE
EXPOSE 8787

# Copy the entire built tree. Bloat over a per-workspace prune, but
# avoids the conditional-COPY complexity and is acceptable for v1.
COPY --from=builder /app /app

# Diagnostic boot lines to stderr so a misconfig surfaces in the
# deploy log. Each branch ends in `exec` so the container's PID 1 is
# the real process (signals + Railway's health probe both depend on it).
CMD ["bash", "-c", "echo '[boot] workspace='$WORKSPACE' node='$(node --version) >&2; \
  if [ \"$WORKSPACE\" = \"server\" ]; then \
    echo '[boot] applying migrations' >&2; \
    npx prisma migrate deploy --schema packages/server/prisma/schema.prisma 2>&1; \
    rc=$?; if [ $rc -ne 0 ]; then echo '[boot] migrate failed rc='$rc >&2; exit $rc; fi; \
    echo '[boot] starting server on PORT='$PORT >&2; \
    exec node packages/server/dist/index.js; \
  elif [ \"$WORKSPACE\" = \"dashboard\" ]; then \
    echo '[boot] starting dashboard on PORT='$PORT >&2; \
    cd apps/dashboard && exec node ../../node_modules/next/dist/bin/next start -p $PORT; \
  elif [ \"$WORKSPACE\" = \"docs\" ]; then \
    echo '[boot] starting docs on PORT='$PORT >&2; \
    cd apps/docs && exec node ../../node_modules/next/dist/bin/next start -p $PORT; \
  else echo '[boot] unknown WORKSPACE='$WORKSPACE >&2; exit 1; fi"]
