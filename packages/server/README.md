# @junjo/server

The Junjo HTTP API, SSE event stream, and webhook dispatcher. Hono on Node, Postgres via Prisma. Cloud and self-host run the same binary; configure with `DATABASE_URL` and an auth-adapter env var.

Self-host:

```
docker run -e DATABASE_URL=postgres://... -p 8787:8787 ghcr.io/junjo/server:latest
```

Local dev:

```
npm run dev
```

The Prisma schema lives at `prisma/schema.prisma`. No migrations yet; the schema is still moving.
