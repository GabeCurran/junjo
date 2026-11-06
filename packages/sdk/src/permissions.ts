import type {
  GameConfigPermissionContext,
  PermissionConfig,
  PermissionMode,
} from "@junjo.io/shared";
import type { HttpClient } from "./http.js";

export type WireContextInheritance = Record<string, { inherit: Record<string, string[]> }>;

export interface WirePermissionConfig {
  mode: PermissionMode;
  contexts?: WireContextInheritance;
}

// Copies the wire map so callers never share arrays with the parsed
// body. Absent (a server that predates the field) reads as no
// inheritance.
export function deserializeContextInheritance(
  w: WireContextInheritance | undefined,
): Record<string, GameConfigPermissionContext> {
  const out: Record<string, GameConfigPermissionContext> = {};
  for (const [key, value] of Object.entries(w ?? {})) {
    const inherit: Record<string, string[]> = {};
    for (const [contextValue, parents] of Object.entries(value.inherit ?? {})) {
      inherit[contextValue] = [...parents];
    }
    out[key] = { inherit };
  }
  return out;
}

export function deserializePermissionConfig(w: WirePermissionConfig): PermissionConfig {
  return { mode: w.mode, contexts: deserializeContextInheritance(w.contexts) };
}

/** The game's permission settings. Reached as `junjo.permissions`. */
export class PermissionsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Reads the game's permission mode and context value inheritance
   * (GET /v1/permissions/config). `contexts` is empty when the game
   * declares no inheritance. Changes arrive on the game stream as
   * `permissions.config.updated`.
   */
  async config(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<PermissionConfig> {
    const wire = await this.http.get<WirePermissionConfig>("/v1/permissions/config", {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return deserializePermissionConfig(wire);
  }
}
