// Healthcheck endpoint for Railway / orchestrator probes. Public (excluded
// from the basic-auth middleware below) so the orchestrator can reach it
// without credentials. Reports liveness only -- no DB or upstream check
// here because the dashboard is a stateless Next renderer; the actual
// service health is exposed by the Junjo server's /healthz.

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
