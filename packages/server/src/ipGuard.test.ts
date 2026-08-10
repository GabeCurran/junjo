import { describe, expect, it } from "vitest";
import { isPublicUnicastAddress } from "./ipGuard";

describe("isPublicUnicastAddress", () => {
  it("permits public IPv4", () => {
    expect(isPublicUnicastAddress("8.8.8.8")).toBe(true);
    expect(isPublicUnicastAddress("1.1.1.1")).toBe(true);
    expect(isPublicUnicastAddress("172.15.0.1")).toBe(true); // just below 172.16/12
    expect(isPublicUnicastAddress("172.32.0.1")).toBe(true); // just above 172.16/12
    expect(isPublicUnicastAddress("100.63.255.255")).toBe(true); // just below CGNAT
    expect(isPublicUnicastAddress("100.128.0.1")).toBe(true); // just above CGNAT
    expect(isPublicUnicastAddress("169.253.0.1")).toBe(true);
    expect(isPublicUnicastAddress("198.20.0.1")).toBe(true); // just above 198.18/15
    expect(isPublicUnicastAddress("223.255.255.255")).toBe(true); // just below multicast
  });

  it("permits public IPv6", () => {
    expect(isPublicUnicastAddress("2606:4700:4700::1111")).toBe(true); // cloudflare dns
    expect(isPublicUnicastAddress("2001:4860:4860::8888")).toBe(true); // google dns
    expect(isPublicUnicastAddress("64:ff9b::8.8.8.8")).toBe(true); // NAT64 -> public v4
  });

  it("rejects the cloud metadata IP", () => {
    expect(isPublicUnicastAddress("169.254.169.254")).toBe(false);
  });

  it("rejects IPv4 0.0.0.0/8", () => {
    expect(isPublicUnicastAddress("0.0.0.0")).toBe(false);
    expect(isPublicUnicastAddress("0.1.2.3")).toBe(false);
  });

  it("rejects IPv4 private / CGNAT / loopback ranges", () => {
    expect(isPublicUnicastAddress("10.0.0.1")).toBe(false);
    expect(isPublicUnicastAddress("10.255.255.255")).toBe(false);
    expect(isPublicUnicastAddress("100.64.0.1")).toBe(false);
    expect(isPublicUnicastAddress("100.127.255.255")).toBe(false);
    expect(isPublicUnicastAddress("127.0.0.1")).toBe(false);
    expect(isPublicUnicastAddress("127.255.255.255")).toBe(false);
    expect(isPublicUnicastAddress("169.254.0.1")).toBe(false);
    expect(isPublicUnicastAddress("172.16.0.1")).toBe(false);
    expect(isPublicUnicastAddress("172.31.255.255")).toBe(false);
    expect(isPublicUnicastAddress("192.168.0.1")).toBe(false);
    expect(isPublicUnicastAddress("192.168.255.255")).toBe(false);
  });

  it("rejects IETF special-use IPv4 blocks", () => {
    expect(isPublicUnicastAddress("192.0.0.1")).toBe(false); // 192.0.0/24
    expect(isPublicUnicastAddress("192.0.2.5")).toBe(false); // TEST-NET-1
    expect(isPublicUnicastAddress("192.88.99.1")).toBe(false); // 6to4 relay anycast
    expect(isPublicUnicastAddress("198.18.0.1")).toBe(false); // benchmarking
    expect(isPublicUnicastAddress("198.19.255.255")).toBe(false); // benchmarking
    expect(isPublicUnicastAddress("198.51.100.7")).toBe(false); // TEST-NET-2
    expect(isPublicUnicastAddress("203.0.113.7")).toBe(false); // TEST-NET-3
  });

  it("rejects IPv4 multicast and reserved", () => {
    expect(isPublicUnicastAddress("224.0.0.1")).toBe(false); // multicast lower
    expect(isPublicUnicastAddress("239.255.255.255")).toBe(false); // multicast upper
    expect(isPublicUnicastAddress("240.0.0.1")).toBe(false); // reserved lower
    expect(isPublicUnicastAddress("255.255.255.255")).toBe(false); // limited broadcast
  });

  it("rejects IPv6 unspecified / loopback", () => {
    expect(isPublicUnicastAddress("::")).toBe(false);
    expect(isPublicUnicastAddress("::1")).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 by unmapping to the v4 rules", () => {
    expect(isPublicUnicastAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicUnicastAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicUnicastAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicUnicastAddress("::ffff:192.168.1.1")).toBe(false);
    // A public v4 mapped into v6 is still public.
    expect(isPublicUnicastAddress("::ffff:8.8.8.8")).toBe(true);
  });

  it("rejects NAT64-embedded private v4", () => {
    expect(isPublicUnicastAddress("64:ff9b::10.0.0.1")).toBe(false); // /96 well-known
    expect(isPublicUnicastAddress("64:ff9b::127.0.0.1")).toBe(false);
    expect(isPublicUnicastAddress("64:ff9b::169.254.169.254")).toBe(false);
    // /48 local-use prefix embeds v4 in bytes 6,7,9,10 (RFC 6052).
    expect(isPublicUnicastAddress("64:ff9b:1:a00:0:0:0:0")).toBe(false); // 10.0.0.0
    expect(isPublicUnicastAddress("64:ff9b:1:c0a8:0:1:0:0")).toBe(false); // 192.168.0.0
  });

  it("rejects IPv6 discard / documentation / ULA / link-local / multicast", () => {
    expect(isPublicUnicastAddress("100::1")).toBe(false); // discard-only
    expect(isPublicUnicastAddress("2001:db8::1")).toBe(false); // documentation
    expect(isPublicUnicastAddress("fc00::1")).toBe(false); // ULA
    expect(isPublicUnicastAddress("fd12:3456::1")).toBe(false); // ULA
    expect(isPublicUnicastAddress("fe80::1")).toBe(false); // link-local
    expect(isPublicUnicastAddress("febf::1")).toBe(false); // link-local upper
    expect(isPublicUnicastAddress("ff02::1")).toBe(false); // multicast
  });

  it("fails closed on malformed input", () => {
    expect(isPublicUnicastAddress("")).toBe(false);
    expect(isPublicUnicastAddress("not-an-ip")).toBe(false);
    expect(isPublicUnicastAddress("999.1.1.1")).toBe(false);
    expect(isPublicUnicastAddress("example.com")).toBe(false);
  });
});
