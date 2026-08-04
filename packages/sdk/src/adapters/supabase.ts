import type { AuthAdapter, UserId } from "@junjo.io/shared";
import { JunjoError } from "../errors.js";

// The minimum shape of a Supabase user record the adapter cares about.
// `id` is Supabase's user UUID; `userIdField` selects which top-level
// field to read. Every other field on the record is ignored.
export interface SupabaseUserLike {
  id?: string | null;
  [field: string]: unknown;
}

// The shape `client.auth.getUser(token)` returns. Mirrors the documented
// envelope from `@supabase/supabase-js` v2: a `data.user` payload plus
// an optional `error` field.
export interface SupabaseGetUserResult {
  data?: { user?: SupabaseUserLike | null } | null;
  error?: unknown;
}

// Structural shape of the `@supabase/supabase-js` client the adapter
// depends on. Any object with a matching `auth.getUser(token)` method
// works; Junjo never imports `@supabase/supabase-js` directly so callers
// without Supabase pay no install cost.
export interface SupabaseClientLike {
  auth: {
    getUser(token: string): Promise<SupabaseGetUserResult>;
  };
}

export interface SupabaseAdapterOptions {
  // The Supabase client. Construct it at app startup with your service
  // role or anon key, then pass it in:
  //
  //   import { createClient } from "@supabase/supabase-js";
  //   const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  //   supabaseAdapter({ client });
  client: SupabaseClientLike;
  // Which top-level field of the User record to read the user id from.
  // Defaults to "id" (Supabase's user UUID). Override only if you store
  // an internal id under a different top-level field. Nested fields
  // under `app_metadata` or `user_metadata` are not supported in V1;
  // wrap the client yourself if you need them.
  userIdField?: string;
}

export function supabaseAdapter(opts: SupabaseAdapterOptions): AuthAdapter {
  if (opts === undefined || opts === null || opts.client === undefined || opts.client === null) {
    throw new JunjoError("supabaseAdapter: `client` is required", "invalid_config");
  }
  if (opts.client.auth === undefined || opts.client.auth === null) {
    throw new JunjoError("supabaseAdapter: `client.auth` is missing", "invalid_config");
  }
  if (typeof opts.client.auth.getUser !== "function") {
    throw new JunjoError(
      "supabaseAdapter: `client.auth.getUser` must be a function",
      "invalid_config",
    );
  }

  const userIdField = opts.userIdField ?? "id";
  const client = opts.client;

  return {
    async verifyToken(token) {
      if (typeof token !== "string" || token.length === 0) return null;

      let result: SupabaseGetUserResult;
      try {
        result = await client.auth.getUser(token);
      } catch {
        return null;
      }

      if (result === null || result === undefined) return null;
      if (result.error !== undefined && result.error !== null) return null;
      if (result.data === null || result.data === undefined) return null;

      const user = result.data.user;
      if (user === null || user === undefined) return null;

      const raw = user[userIdField];
      if (typeof raw !== "string" || raw.length === 0) return null;
      return { userId: raw as UserId };
    },
  };
}
