// @license All Rights Reserved (see apps/dashboard/LICENSE)
import "server-only";

import { Junjo } from "@junjo.io/sdk";
import { loadDashboardEnv } from "./env";

let cached: Junjo | null = null;

// Server-side Junjo SDK singleton. Lazily constructs the client on first
// use so the env var validation only runs when a Server Component or
// Server Action actually reaches into Junjo's API. The singleton is safe
// to share across requests because it holds only configuration; HTTP
// requests are issued through the platform's fetch.
export function getJunjo(): Junjo {
  if (cached) return cached;
  const env = loadDashboardEnv();
  cached = new Junjo({
    apiKey: env.JUNJO_ADMIN_API_KEY,
    baseUrl: env.JUNJO_BASE_URL,
  });
  return cached;
}

// The cross-game admin token. Used directly via fetch from Server
// Components for endpoints the per-game SDK does not expose, e.g.
// GET /v1/users/:junjoUserId/games. Returns null when the env var is
// absent so callers can render a "not enabled" empty state instead of
// crashing the request.
export function getAdminToken(): string | null {
  const env = loadDashboardEnv();
  return env.JUNJO_ADMIN_TOKEN ?? null;
}

// The base URL the dashboard talks to. Useful for cross-game admin
// endpoints that we hit with hand-rolled fetch instead of the SDK.
export function getJunjoBaseUrl(): string {
  return loadDashboardEnv().JUNJO_BASE_URL;
}

// The URL prefix used when the invite-member dialog constructs
// invite-link URLs. Falls back to JUNJO_BASE_URL when the dedicated
// env var is unset; trailing slashes are trimmed so the resulting URL
// has a single `/invite/<code>` segment regardless of whether the
// operator wrote `https://app.example.com` or `https://app.example.com/`.
export function getInviteBaseUrl(): string {
  const env = loadDashboardEnv();
  const raw = env.JUNJO_INVITE_BASE_URL ?? env.JUNJO_BASE_URL;
  return raw.replace(/\/+$/, "");
}

// The Junjo docs base URL. Used by the analytics empty state to link
// operators at the 5-minute tutorial. Returns null when the env var
// is absent so callers can render a "no link" empty state instead of
// a broken URL. Trailing slashes are trimmed.
export function getDocsBaseUrl(): string | null {
  const env = loadDashboardEnv();
  if (!env.JUNJO_DOCS_BASE_URL) return null;
  return env.JUNJO_DOCS_BASE_URL.replace(/\/+$/, "");
}
