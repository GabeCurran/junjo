import { isIP } from "node:net";

// Delivery-time backstop for webhook SSRF. `webhookUrlGuard` rejects
// obviously-private hosts by name when an endpoint is created or updated,
// but a public-looking hostname can be rebound at delivery time to a
// private or reserved address (DNS rebinding / TOCTOU). This module
// classifies an already-resolved literal IP as public unicast (safe to
// connect to) or not, doing exact prefix math on the parsed address bytes.
// The webhook dispatcher resolves every address for a host, runs each
// through `isPublicUnicastAddress`, and connects only to the validated
// addresses, so a second resolution cannot swap in a private IP.

// Returns true only when `ip` is a public unicast address. Any parse
// failure, or membership in a reserved / private / special-use range,
// returns false (fail closed).
export function isPublicUnicastAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const bytes = parseIpv4(ip);
    return bytes !== null && isPublicUnicastIpv4(bytes);
  }
  if (family === 6) {
    const bytes = parseIpv6(ip);
    return bytes !== null && isPublicUnicastIpv6(bytes);
  }
  return false;
}

function parseIpv4(input: string): [number, number, number, number] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

// Parses a literal IPv6 address into its 16 bytes. Handles "::" zero
// compression and an embedded dotted-quad IPv4 tail (e.g. ::ffff:127.0.0.1
// or 64:ff9b::203.0.113.7). Returns null on any malformed input.
function parseIpv6(input: string): number[] | null {
  let str = input;
  const zone = str.indexOf("%");
  if (zone !== -1) str = str.slice(0, zone);
  if (str.length === 0) return null;

  const doubleColon = str.indexOf("::");
  let hasCompression: boolean;
  let headPart: string;
  let tailPart: string;
  if (doubleColon === -1) {
    hasCompression = false;
    headPart = str;
    tailPart = "";
  } else {
    if (str.indexOf("::", doubleColon + 1) !== -1) return null;
    hasCompression = true;
    headPart = str.slice(0, doubleColon);
    tailPart = str.slice(doubleColon + 2);
  }

  const head: number[] = [];
  const tail: number[] = [];
  if (!pushHextets(headPart, head)) return null;
  if (!pushHextets(tailPart, tail)) return null;

  if (hasCompression) {
    const zeros = 16 - head.length - tail.length;
    if (zeros < 1) return null;
    return [...head, ...new Array(zeros).fill(0), ...tail];
  }
  if (head.length !== 16) return null;
  return head;
}

function pushHextets(part: string, into: number[]): boolean {
  if (part.length === 0) return true;
  const groups = part.split(":");
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group === undefined) return false;
    if (group.includes(".")) {
      // A dotted-quad is only legal as the final group (low 32 bits).
      if (i !== groups.length - 1) return false;
      const v4 = parseIpv4(group);
      if (v4 === null) return false;
      into.push(v4[0], v4[1], v4[2], v4[3]);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
      const n = Number.parseInt(group, 16);
      into.push((n >> 8) & 0xff, n & 0xff);
    }
  }
  return true;
}

// IPv4 reserved / private / special-use ranges that must never be a webhook
// delivery target:
//   0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (CGNAT), 127.0.0.0/8,
//   169.254.0.0/16 (link-local, incl. the 169.254.169.254 metadata IP),
//   172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24,
//   192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
//   224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved, incl.
//   255.255.255.255).
function isPublicUnicastIpv4(bytes: [number, number, number, number]): boolean {
  const [a, b, c] = bytes;
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224 && a <= 239) return false;
  if (a >= 240) return false;
  return true;
}

function allZero(bytes: number[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

// IPv6 reserved / private / special-use ranges. IPv4-mapped and NAT64
// prefixes embed an IPv4 address; those are unmapped and re-checked against
// the IPv4 rules so an attacker cannot reach a private v4 through a v6
// literal.
//   ::/128 (unspecified), ::1/128 (loopback),
//   ::ffff:0:0/96 (IPv4-mapped, unmap + re-check),
//   64:ff9b::/96 and 64:ff9b:1::/48 (NAT64, unmap + re-check),
//   100::/64 (discard), 2001:db8::/32 (documentation), fc00::/7 (ULA),
//   fe80::/10 (link-local), ff00::/8 (multicast).
function isPublicUnicastIpv6(bytes: number[]): boolean {
  if (allZero(bytes, 0, 16)) return false; // ::/128
  if (allZero(bytes, 0, 15) && bytes[15] === 1) return false; // ::1/128

  // ::ffff:0:0/96 IPv4-mapped: low 32 bits carry the real IPv4 address.
  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicUnicastIpv4(embeddedV4(bytes, 12, 13, 14, 15));
  }

  // 64:ff9b::/96 NAT64 well-known prefix: embedded v4 in the low 32 bits.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    allZero(bytes, 4, 12)
  ) {
    return isPublicUnicastIpv4(embeddedV4(bytes, 12, 13, 14, 15));
  }

  // 64:ff9b:1::/48 NAT64 local-use prefix. Per RFC 6052 the embedded v4
  // for a /48 sits in bits 48-63 and 72-87 (bytes 6, 7, 9, 10); byte 8 is
  // the reserved "u" octet.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  ) {
    return isPublicUnicastIpv4(embeddedV4(bytes, 6, 7, 9, 10));
  }

  if (bytes[0] === 0x01 && allZero(bytes, 1, 8)) return false; // 100::/64 discard
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return false; // 2001:db8::/32 documentation
  }
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return false; // fc00::/7 ULA
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if (bytes[0] === 0xff) return false; // ff00::/8 multicast
  return true;
}

// Reads four bytes into an IPv4 tuple. Callers pass indices known to be
// within a 16-byte address; a missing byte coalesces to 0, which the IPv4
// classifier then rejects (the 0.0.0.0/8 rule), keeping the fail-closed
// contract.
function embeddedV4(
  bytes: number[],
  i0: number,
  i1: number,
  i2: number,
  i3: number,
): [number, number, number, number] {
  return [bytes[i0] ?? 0, bytes[i1] ?? 0, bytes[i2] ?? 0, bytes[i3] ?? 0];
}
