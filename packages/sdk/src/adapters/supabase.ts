import type { AuthAdapter } from "@junjo/shared";

interface SupabaseClientLike {
  auth: {
    getUser(token: string): Promise<{ data: { user: { id: string } | null } }>;
  };
}

export function supabaseAdapter(_client: SupabaseClientLike): AuthAdapter {
  return {
    async verifyToken(_token) {
      throw new Error("not implemented");
    },
  };
}
