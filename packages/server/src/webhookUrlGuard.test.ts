import { describe, expect, it } from "vitest";
import { JunjoError } from "./errors";
import { assertSafeWebhookUrl, isPrivateHost } from "./webhookUrlGuard";

describe("isPrivateHost", () => {
  it("rejects loopback names and v4 / v6 forms", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("api.localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.255.0.1")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects link-local (incl. cloud-metadata 169.254.169.254)", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("169.254.0.1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
  });

  it("rejects RFC1918 ranges", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
  });

  it("rejects 0.0.0.0, RFC6598 CGNAT, IPv6 ULA", () => {
    expect(isPrivateHost("0.0.0.0")).toBe(true);
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("fc00::1")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
  });

  it("permits public hostnames and public IPv4", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("api.junjo.io")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.15.0.1")).toBe(false); // adjacent to RFC1918 lower bound
    expect(isPrivateHost("172.32.0.1")).toBe(false); // adjacent to RFC1918 upper bound
    expect(isPrivateHost("169.253.0.1")).toBe(false);
    expect(isPrivateHost("100.63.0.1")).toBe(false);
    expect(isPrivateHost("100.128.0.1")).toBe(false);
  });
});

describe("assertSafeWebhookUrl", () => {
  it("passes a public https URL", () => {
    expect(() => assertSafeWebhookUrl("https://hooks.example.com/incoming")).not.toThrow();
  });

  it("rejects unparseable URL", () => {
    expect(() => assertSafeWebhookUrl("not-a-url")).toThrow(JunjoError);
  });

  it("rejects non-http(s) protocol", () => {
    expect(() => assertSafeWebhookUrl("ftp://example.com/hook")).toThrow(JunjoError);
    expect(() => assertSafeWebhookUrl("file:///etc/passwd")).toThrow(JunjoError);
  });

  it("rejects loopback / private / link-local", () => {
    expect(() => assertSafeWebhookUrl("http://localhost:8080/hook")).toThrow(JunjoError);
    expect(() => assertSafeWebhookUrl("http://127.0.0.1/hook")).toThrow(JunjoError);
    expect(() => assertSafeWebhookUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
      JunjoError,
    );
    expect(() => assertSafeWebhookUrl("http://10.0.0.1/hook")).toThrow(JunjoError);
    expect(() => assertSafeWebhookUrl("http://192.168.1.1/hook")).toThrow(JunjoError);
    expect(() => assertSafeWebhookUrl("http://[::1]/hook")).toThrow(JunjoError);
    expect(() => assertSafeWebhookUrl("http://[fe80::1]/hook")).toThrow(JunjoError);
  });

  it("permits private hosts when escape hatch is set", () => {
    expect(() =>
      assertSafeWebhookUrl("http://localhost:8080/hook", { allowPrivateHosts: true }),
    ).not.toThrow();
    expect(() =>
      assertSafeWebhookUrl("http://127.0.0.1/hook", { allowPrivateHosts: true }),
    ).not.toThrow();
  });

  it("surfaces the operator escape hatch in the rejection message", () => {
    let caught: unknown;
    try {
      assertSafeWebhookUrl("http://localhost/hook");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JunjoError);
    if (caught instanceof JunjoError) {
      expect(caught.message).toContain("WEBHOOK_ALLOW_PRIVATE_HOSTS");
    }
  });
});
