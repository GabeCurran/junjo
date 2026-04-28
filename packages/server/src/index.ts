import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.json({ name: "junjo-server", version: "0.0.0" }));
app.get("/healthz", (c) => c.text("ok"));

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`junjo-server listening on http://localhost:${info.port}`);
});
