import { Errors } from "./errors.js";

// Lexical (no DNS resolution) check that the webhook URL is not pointed at
// a host the server itself can reach: loopback, link-local (which on AWS /
// GCP / Azure includes the cloud metadata endpoint), and the standard
// IPv4 / IPv6 private ranges. DNS rebinding still wins against this; the
// V1 backstop is operator network policy. The point here is to stop the
// trivial misuse: a tenant who registers
// `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and
// has the worker exfiltrate cloud creds back to them via the response
// body, or who points at `http://localhost:5432` to confirm internal
// services are reachable.
export interface WebhookUrlGuardOptions {
  // Operator escape hatch: self-host devs need to point webhooks at
  // `http://localhost:8080` while testing receivers locally. Set true to
  // skip the private-host check.
  allowPrivateHosts?: boolean;
}

export function assertSafeWebhookUrl(rawUrl: string, opts: WebhookUrlGuardOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw Errors.badRequest("url must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Errors.badRequest("url must be a valid http(s) URL");
  }
  if (opts.allowPrivateHosts) return;
  const hostname = stripIpv6Brackets(parsed.hostname.toLowerCase());
  if (isPrivateHost(hostname)) {
    throw Errors.badRequest(
      `url host ${hostname} resolves to a loopback / link-local / private range; set WEBHOOK_ALLOW_PRIVATE_HOSTS=true on the server to permit (development only)`,
    );
  }
}

export function isPrivateHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost") return true;
  if (hostname.endsWith(".localhost")) return true;
  // Browsers / Node accept hostnames containing literal IPv4-mapped-IPv6
  // (e.g. `::ffff:127.0.0.1`); collapse to the embedded IPv4 first so we
  // do not have to handle both shapes downstream.
  const collapsed = collapseIpv4MappedIpv6(hostname);
  if (looksLikeIpv4(collapsed)) return isPrivateIpv4(collapsed);
  if (collapsed.includes(":")) return isPrivateIpv6(collapsed);
  return false;
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function collapseIpv4MappedIpv6(host: string): string {
  const lower = host.toLowerCase();
  const prefix = "::ffff:";
  if (lower.startsWith(prefix)) {
    const rest = lower.slice(prefix.length);
    if (looksLikeIpv4(rest)) return rest;
  }
  return lower;
}

function looksLikeIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return false;
    if (!/^\d+$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number) as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 is RFC6598 carrier-grade NAT, not strictly private but
  // operators routinely use it for internal traffic; treat as untrusted.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  // ULA: fc00::/7 covers fc00::-fdff::; first byte's high 7 bits are
  // 1111110, so any prefix matching fc.. or fd.. is in-range.
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  return false;
}
