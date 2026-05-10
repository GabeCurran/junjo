// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { type NextRequest, NextResponse } from "next/server";

export const config = {
  // /healthz is excluded so the orchestrator's healthcheck can reach it
  // without credentials. Everything else (including the rest of the
  // dashboard surface) still goes through the basic-auth gate below.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz).*)"],
};

const REALM = "Junjo Dashboard";

export function middleware(req: NextRequest): NextResponse {
  const expectedUser = process.env.DASHBOARD_ADMIN_USER;
  const expectedPassword = process.env.DASHBOARD_ADMIN_PASSWORD;

  if (!expectedUser || !expectedPassword) {
    return unauthorized(
      "dashboard credentials are not configured (set DASHBOARD_ADMIN_USER and DASHBOARD_ADMIN_PASSWORD)",
    );
  }

  const presented = parseBasicAuth(req.headers.get("authorization"));
  if (!presented) {
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
