// @license All Rights Reserved (see apps/dashboard/LICENSE)

// Server-safe helpers extracted from `game-audit-feed.tsx`. The audit page
// is a Server Component but the feed itself is a Client Component, so any
// shared pure helper has to live outside the `"use client"` boundary -
// Next.js refuses to invoke a client export from server code at runtime.

// Convert a `datetime-local` input value (e.g. "2026-04-01T12:30") to the
// ISO 8601 form the server expects. The browser parses datetime-local in
// the user's local timezone; rendering through `new Date()` then calling
// `.toISOString()` produces the canonical UTC form.
export function datetimeLocalToIso(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

// Conflict-resolution rule for the wire `before` value: pagination cursor
// wins over the user-supplied `endDate` filter while paging is active.
export function resolveBefore(cursor: string | undefined, endDate: string): string | undefined {
  if (cursor !== undefined && cursor.length > 0) return cursor;
  return datetimeLocalToIso(endDate);
}

export function resolveSince(since: string): string | undefined {
  return datetimeLocalToIso(since);
}
