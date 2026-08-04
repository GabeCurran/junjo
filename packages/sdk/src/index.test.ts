import type { AuthAdapter, GroupId, PermissionKey, UserId } from "@junjo-io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

describe("Junjo.whoami", () => {
  it("delegates to the configured authAdapter and returns its result", async () => {
    const verifyToken = vi.fn(async (_token: string) => ({
      userId: "user_alice" as UserId,
    }));
    const adapter: AuthAdapter = { verifyToken };
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      authAdapter: adapter,
      fetch: vi.fn() as unknown as typeof fetch,
    });

    const result = await junjo.whoami("session.token");

    expect(verifyToken).toHaveBeenCalledOnce();
    expect(verifyToken).toHaveBeenCalledWith("session.token");
    expect(result).toEqual({ userId: "user_alice" });
  });

  it("returns null when the adapter rejects the token", async () => {
    const adapter: AuthAdapter = { verifyToken: async () => null };
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      authAdapter: adapter,
      fetch: vi.fn() as unknown as typeof fetch,
    });

    expect(await junjo.whoami("expired.token")).toBeNull();
  });

  it("throws JunjoError(invalid_config) when no adapter is configured", async () => {
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: vi.fn() as unknown as typeof fetch,
    });

    await expect(junjo.whoami("any.token")).rejects.toMatchObject({
      name: "JunjoError",
      code: "invalid_config",
    });
    await expect(junjo.whoami("any.token")).rejects.toBeInstanceOf(JunjoError);
  });

  it("propagates adapter throws unchanged (e.g. constructor invariant violations)", async () => {
    const adapter: AuthAdapter = {
      verifyToken: async () => {
        throw new Error("upstream verifier exploded");
      },
    };
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      authAdapter: adapter,
      fetch: vi.fn() as unknown as typeof fetch,
    });

    await expect(junjo.whoami("any.token")).rejects.toThrow("upstream verifier exploded");
  });
});

describe("Junjo apiKey shape validation", () => {
  it("throws when apiKey is missing", () => {
    expect(
      () =>
        new Junjo({
          apiKey: "" as unknown as string,
          fetch: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/missing apiKey/);
  });

  it("throws a specific error when an admin token (jadm_*) is passed by mistake", () => {
    expect(
      () =>
        new Junjo({
          apiKey: "jadm_d6f863cd5cf220b06773b57ecb5ea75a118bff3f92f581bbce515a70cb14b62a",
          fetch: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/cross-game admin token/);
  });

  it("accepts a real per-game key shape (jk_<prefix>.<secret>) without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      () =>
        new Junjo({
          apiKey: "jk_kzPNEgg-rEY5nGHF.vYJ-girvGuJfwkO4vM4jwT7stXHFxsbhRrpIYqfsWJY",
          fetch: vi.fn() as unknown as typeof fetch,
        }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("attaches code='invalid_config' on the thrown JunjoError", () => {
    try {
      new Junjo({ apiKey: "jadm_xxx", fetch: vi.fn() as unknown as typeof fetch });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JunjoError);
      expect((err as JunjoError).code).toBe("invalid_config");
    }
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Junjo proxy mode", () => {
  it("sends no authorization header; the proxy injects the credential", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ allowed: true, source: "role" }));
    const junjo = new Junjo({
      proxy: true,
      baseUrl: "https://game.example/api/junjo",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    await junjo.check("user_a" as UserId, "grp_a" as GroupId, "invite_member" as PermissionKey);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("requires baseUrl", () => {
    expect(
      () => new Junjo({ proxy: true, fetch: vi.fn() as unknown as typeof fetch }),
    ).toThrowError(
      expect.objectContaining({ name: "JunjoError", code: "invalid_config" }) as Error,
    );
  });

  it("rejects an apiKey: the credential must never reach the browser", () => {
    expect(
      () =>
        new Junjo({
          proxy: true,
          apiKey: "jk_abc.def",
          baseUrl: "/api/junjo",
          fetch: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/proxy mode does not take an apiKey/);
  });

  it("still requires an apiKey without proxy mode", () => {
    expect(
      () => new Junjo({ baseUrl: "/api/junjo", fetch: vi.fn() as unknown as typeof fetch }),
    ).toThrow(/missing apiKey/);
  });
});

describe("Junjo browser secret-key warning", () => {
  it("warns once when a jk_ key is constructed with a window global present", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (globalThis as { window?: unknown }).window = {};
    try {
      const config = {
        apiKey: "jk_kzPNEgg-rEY5nGHF.vYJ-girvGuJfwkO4vM4jwT7stXHFxsbhRrpIYqfsWJY",
        fetch: vi.fn() as unknown as typeof fetch,
      };
      new Junjo(config);
      new Junjo(config);
      const browserWarnings = warn.mock.calls.filter(
        (c) => typeof c[0] === "string" && c[0].includes("browser"),
      );
      expect(browserWarnings).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(globalThis, "window");
      warn.mockRestore();
    }
  });
});

describe("HttpClient header precedence", () => {
  it("does not let custom request headers clobber authorization", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ allowed: true, source: "role" }));
    const junjo = new Junjo({
      apiKey: "jk_abc.def",
      baseUrl: "https://example.test",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    // No public API passes custom headers today; exercise the layer
    // directly to pin the merge order for future call sites.
    const http = (
      junjo as unknown as { http: { get: (p: string, o?: unknown) => Promise<unknown> } }
    ).http;

    await http.get("/v1/permissions/check?x=1", {
      headers: { authorization: "Bearer attacker", "x-custom": "ok" },
    });

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer jk_abc.def");
    expect(headers["x-custom"]).toBe("ok");
  });
});
