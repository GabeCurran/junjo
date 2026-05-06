import { describe, expect, it, vi } from "vitest";
import { JunjoError } from "../errors.js";
import { clerkAdapter } from "./clerk.js";

describe("clerkAdapter happy path", () => {
  it("returns the userId from the sub claim when verifyToken resolves with a valid payload", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: "user_2abc" });
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toEqual({ userId: "user_2abc" });
    expect(verifyToken).toHaveBeenCalledWith("ey.token.here");
    expect(verifyToken).toHaveBeenCalledTimes(1);
  });

  it("ignores other claims on the payload and returns only the userId", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      sub: "user_2xyz",
      iat: 1700000000,
      exp: 1700003600,
      iss: "https://clerk.example",
      session_id: "sess_123",
    });
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toEqual({ userId: "user_2xyz" });
  });
});

describe("clerkAdapter token-shape failures", () => {
  it("returns null without invoking verifyToken when the token is empty", async () => {
    const verifyToken = vi.fn();
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("")).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("returns null without invoking verifyToken when the token is non-string", async () => {
    const verifyToken = vi.fn();
    const adapter = clerkAdapter({ verifyToken });

    // biome-ignore lint/suspicious/noExplicitAny: testing a bad runtime value
    expect(await adapter.verifyToken(undefined as any)).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

describe("clerkAdapter verification failures", () => {
  it("returns null when verifyToken throws (Clerk rejects the token)", async () => {
    const verifyToken = vi.fn().mockRejectedValue(new Error("invalid token"));
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when verifyToken resolves with null", async () => {
    const verifyToken = vi.fn().mockResolvedValue(null);
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when verifyToken resolves with undefined", async () => {
    const verifyToken = vi.fn().mockResolvedValue(undefined);
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the payload has no sub claim", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ iss: "https://clerk.example" });
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the sub claim is not a string", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: 12345 });
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the sub claim is an empty string", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: "" });
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the sub claim is null", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: null });
    const adapter = clerkAdapter({ verifyToken });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });
});

describe("clerkAdapter custom userIdClaim", () => {
  it("reads the user id from a custom claim when userIdClaim is set", async () => {
    const verifyToken = vi.fn().mockResolvedValue({
      sub: "ignored_clerk_id",
      app_user_id: "internal_42",
    });
    const adapter = clerkAdapter({ verifyToken, userIdClaim: "app_user_id" });

    expect(await adapter.verifyToken("ey.token.here")).toEqual({ userId: "internal_42" });
  });

  it("returns null when the custom claim is missing", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: "user_2abc" });
    const adapter = clerkAdapter({ verifyToken, userIdClaim: "app_user_id" });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });

  it("returns null when the custom claim is not a string", async () => {
    const verifyToken = vi.fn().mockResolvedValue({ sub: "user_2abc", app_user_id: 99 });
    const adapter = clerkAdapter({ verifyToken, userIdClaim: "app_user_id" });

    expect(await adapter.verifyToken("ey.token.here")).toBeNull();
  });
});

describe("clerkAdapter configuration validation", () => {
  it("throws JunjoError(invalid_config) when verifyToken is not a function", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing a bad runtime value
      clerkAdapter({ verifyToken: undefined as any }),
    ).toThrow(JunjoError);
  });

  it("throws JunjoError(invalid_config) when verifyToken is the wrong type", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing a bad runtime value
      clerkAdapter({ verifyToken: "not a function" as any }),
    ).toThrow(JunjoError);
  });
});
