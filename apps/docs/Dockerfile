# Junjo docs: Nextra on Next.js 15. Multi-stage Node 20 image.
# No workspace deps -- just bring in the docs app and build.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/docs/package.json apps/docs/

RUN npm ci --workspace @junjo/docs --include-workspace-root --include=dev

COPY apps/docs apps/docs

RUN npm run build -w @junjo/docs


# ----- runtime -----
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache bash

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/apps/docs ./apps/docs

CMD ["bash", "-c", "echo '[boot] docs starting on PORT='$PORT >&2; cd apps/docs && exec node ../../node_modules/next/dist/bin/next start -p $PORT"]
