// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { type NextRequest, NextResponse } from "next/server";

export const config = {
  // Everything except static build assets runs through this middleware. The
  // public pages are allowlisted by exact path in `isPublicRequest` below
  // rather than excluded here: a matcher exclusion is a prefix match (it also
  // skipped auth for "/healthzX", "/license-anything", ...), and an excluded
  // path skips the gate for every method, including Server Action POSTs.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

const REALM = "Junjo Dashboard";

// /healthz lets the orchestrator's healthcheck through without credentials;
// /license and /privacy are public legal pages; "/" is the public marketing
// landing page. Every admin surface (/overview, /games, /audit, ...) still
// goes through the basic-auth gate.
const PUBLIC_PATHS = new Set(["/", "/healthz", "/license", "/privacy"]);

// Only plain page reads are public. A Server Action is a POST carrying a
// `Next-Action` header, and Next runs it on whatever route it is posted to,
// so a POST to "/" must not be able to invoke admin actions (createApiKey,
// kickMember, ...) without credentials.
function isPublicRequest(req: NextRequest): boolean {
  if (!PUBLIC_PATHS.has(req.nextUrl.pathname)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return !req.headers.has("next-action");
}

export function middleware(req: NextRequest): NextResponse {
  if (isPublicRequest(req)) {
    return NextResponse.next();
  }

  const expectedUser = process.env.DASHBOARD_ADMIN_USER;
  const expectedPassword = process.env.DASHBOARD_ADMIN_PASSWORD;

  if (!expectedUser || !expectedPassword) {
    return unauthorized(
      "dashboard credentials are not configured (set DASHBOARD_ADMIN_USER and DASHBOARD_ADMIN_PASSWORD)",
    );
  }

  const presented = parseBasicAuth(req.headers.get("authorization"));
  if (!presented) {
    // Router prefetches (e.g. a <Link> to an admin page on a public page)
    // must not carry the Basic challenge, or the browser shows its native
    // sign-in dialog for a request the user never made. Deny quietly.
    const isPrefetch =
      req.headers.get("next-router-prefetch") !== null ||
      req.headers.get("purpose") === "prefetch" ||
      req.headers.get("sec-purpose")?.includes("prefetch") === true;
    if (isPrefetch) {
      return new NextResponse(null, { status: 401 });
    }
    return unauthorized("authentication required");
  }

  const userOk = constantTimeStringEqual(presented.user, expectedUser);
  const passOk = constantTimeStringEqual(presented.password, expectedPassword);
  if (!userOk || !passOk) {
    return unauthorized("invalid credentials");
  }

  return NextResponse.next();
}

function parseBasicAuth(header: string | null): { user: string; password: string } | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("basic ")) return null;
  const encoded = trimmed.slice(6).trim();
  if (!encoded) return null;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

// Constant-time-ish string equality. Edge runtime has no node:crypto, so
// we hand-roll the XOR-OR loop the SDK uses for HMAC verification.
function constantTimeStringEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const length = Math.max(aBytes.length, bBytes.length);
  let mismatch = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i++) {
    const aByte = i < aBytes.length ? aBytes[i] : 0;
    const bByte = i < bBytes.length ? bBytes[i] : 0;
    mismatch |= (aByte ?? 0) ^ (bByte ?? 0);
  }
  return mismatch === 0;
}

function unauthorized(message: string): NextResponse {
  return new NextResponse(message, {
    status: 401,
    headers: {
      "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
