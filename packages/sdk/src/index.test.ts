import type { AuthAdapter, UserId } from "@junjo/shared";
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
