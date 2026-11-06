// @license All Rights Reserved (see apps/dashboard/LICENSE)
import "server-only";

import { Junjo } from "@junjo.io/sdk";

import { AdminDisabledError } from "./admin";
import { getAdminToken, getJunjoBaseUrl } from "./junjo";

// An SDK client that acts as one game through the admin token. Every
// request the SDK makes to `/v1/<path>` goes to
// `/v1/admin/games/<gameId>/as-game/<path>` with the admin token, so the
// typed per-game API works for any game without a key per game.
export function gameClient(gameId: string): Junjo {
  const token = getAdminToken();
  if (!token) throw new AdminDisabledError();
  const base = getJunjoBaseUrl().replace(/\/+$/, "");
  const prefix = `${base}/v1/`;
  const mount = `${base}/v1/admin/games/${encodeURIComponent(gameId)}/as-game/`;

  const adminFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(prefix)) {
      throw new Error(`gameClient: unexpected request URL ${url}`);
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(mount + url.slice(prefix.length), { ...init, headers, cache: "no-store" });
  };

  return new Junjo({ proxy: true, baseUrl: base, fetch: adminFetch });
}
