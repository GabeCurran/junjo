# Junjo dashboard: Next.js 15 admin UI. Multi-stage Node 20 image.
#   builder: installs the dashboard's workspace graph (shared + sdk +
#            dashboard), builds shared & sdk (next consumes their dist
#            output), then runs `next build`.
#   runtime: copies node_modules + built artifacts and runs `next start`.
# Reaches the Junjo server via JUNJO_BASE_URL; admin actions use
# JUNJO_ADMIN_TOKEN. Build context is the repo root (not apps/dashboard)
# because npm workspaces resolve from the root package.json.

FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY apps/dashboard/package.json apps/dashboard/

# --include=dev for typescript / postcss / tailwind / etc that next build needs.
RUN npm ci \
  --workspace @junjo/shared \
  --workspace @junjo/sdk \
  --workspace @junjo/dashboard \
  --include-workspace-root \
  --include=dev

COPY packages/shared packages/shared
COPY packages/sdk packages/sdk
COPY apps/dashboard apps/dashboard

# Build chain: shared first (sdk consumes), sdk second (dashboard consumes
# via the @junjo/sdk workspace import), dashboard last.
RUN npm run build -w @junjo/shared
RUN npm run build -w @junjo/sdk
RUN npm run build -w @junjo/dashboard


# ----- runtime -----
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl bash

ENV NODE_ENV=production
# Next defaults to 3000; Railway overrides via $PORT. The next start CLI
# reads $PORT automatically.
ENV PORT=3000
EXPOSE 3000

# Full node_modules + built shared/sdk + the dashboard tree (next start
# reads from .next inside the cwd so we keep the apps/dashboard layout).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=builder /app/apps/dashboard ./apps/dashboard

# Diagnostic boot lines to stderr so a misconfig surfaces in the deploy
# log (matches the server image's pattern).
CMD ["bash", "-c", "echo '[boot] dashboard starting on PORT='$PORT >&2; cd apps/dashboard && exec node ../../node_modules/next/dist/bin/next start -p $PORT"]
