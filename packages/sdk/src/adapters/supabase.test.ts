import { describe, expect, it, vi } from "vitest";
import { JunjoError } from "../errors.js";
import {
  type SupabaseClientLike,
  type SupabaseGetUserResult,
  supabaseAdapter,
} from "./supabase.js";

function makeClient(
  getUser: (token: string) => Promise<SupabaseGetUserResult>,
): SupabaseClientLike {
  return { auth: { getUser } };
}

describe("supabaseAdapter happy path", () => {
  it("returns the userId from the id field when getUser resolves with a user", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: "uuid-abc-123" } },
      error: null,
    });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toEqual({ userId: "uuid-abc-123" });
    expect(getUser).toHaveBeenCalledWith("ey.token.here");
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("ignores other fields on the user record and returns only the userId", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: {
        user: {
          id: "uuid-xyz-456",
          email: "alice@example.com",
          phone: "+15555550100",
          aud: "authenticated",
          app_metadata: { provider: "email" },
          user_metadata: { name: "Alice" },
        },
      },
      error: null,
    });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toEqual({ userId: "uuid-xyz-456" });
  });
});

describe("supabaseAdapter token-shape failures", () => {
  it("returns null without invoking getUser when the token is empty", async () => {
    const getUser = vi.fn();
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("")).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("returns null without invoking getUser when the token is non-string", async () => {
    const getUser = vi.fn();
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    // biome-ignore lint/suspicious/noExplicitAny: testing a bad runtime value
    expect(await adapter.verifyToken(undefined as any)).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe("supabaseAdapter verification failures", () => {
  it("returns null when getUser throws (network error, unexpected exception)", async () => {
    const getUser = vi.fn().mockRejectedValue(new Error("network"));
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when getUser resolves with an error envelope", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { message: "JWT expired", status: 401 },
    });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when getUser resolves with data.user null", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: null,
    });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the user record has no id field", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { email: "alice@example.com" } },
      error: null,
    });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the id field is not a string", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: 12345 } },
      error: null,
    });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the id field is an empty string", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: "" } },
      error: null,
    });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the id field is null", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: null } },
      error: null,
    });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when getUser resolves with a missing data envelope", async () => {
    const getUser = vi.fn().mockResolvedValue({ error: null });
    const adapter = supabaseAdapter({ client: makeClient(getUser) });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });
});

describe("supabaseAdapter custom userIdField", () => {
  it("reads the user id from a custom field when userIdField is set", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: "ignored-uuid", app_user_id: "internal-42" } },
      error: null,
    });
    const adapter = supabaseAdapter({
      client: makeClient(getUser),
      userIdField: "app_user_id",
    });

    expect(await adapter.verifyToken("ey.token.here")).toEqual({ userId: "internal-42" });
  });

  it("returns null when the custom field is missing", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: "uuid-abc" } },
      error: null,
    });
    const adapter = supabaseAdapter({
      client: makeClient(getUser),
      userIdField: "app_user_id",
    });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the custom field is not a string", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: "uuid-abc", app_user_id: 99 } },
      error: null,
    });
    const adapter = supabaseAdapter({
      client: makeClient(getUser),
      userIdField: "app_user_id",
    });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });
});

describe("supabaseAdapter configuration validation", () => {
  it("throws JunjoError(invalid_config) when client is undefined", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing a bad runtime value
      supabaseAdapter({ client: undefined as any }),
    ).toThrow(JunjoError);
  });

  it("throws JunjoError(invalid_config) when client.auth is missing", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing a bad runtime value
      supabaseAdapter({ client: {} as any }),
    ).toThrow(JunjoError);
  });

  it("throws JunjoError(invalid_config) when client.auth.getUser is not a function", () => {
    expect(() =>
      supabaseAdapter({
        // biome-ignore lint/suspicious/noExplicitAny: testing a bad runtime value
        client: { auth: { getUser: "nope" as any } } as any,
      }),
    ).toThrow(JunjoError);
  });
});
