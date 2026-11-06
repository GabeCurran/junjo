import type { PermissionContext } from "@junjo.io/shared";

// ASCII-only lowercase fold, the same one the server applies to context
// values on write and on check.
function foldContextValue(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/**
 * The canonical form of a permission context, as the server computes it
 * for storage and for its answer cache: `""` for a global (empty or
 * absent) context, otherwise `JSON.stringify` of the `[key, value]`
 * pairs sorted by key, with values folded to ASCII lowercase. Two
 * contexts the server treats as the same produce the same string.
 */
export function permissionContextKey(context: PermissionContext | undefined): string {
  if (!context) return "";
  const keys = Object.keys(context).sort();
  if (keys.length === 0) return "";
  return JSON.stringify(keys.map((k) => [k, foldContextValue(context[k] as string)]));
}

// Appends one `context.<key>=<value>` query parameter per context key.
export function appendContextParams(
  params: URLSearchParams,
  context: PermissionContext | undefined,
): void {
  if (!context) return;
  for (const key of Object.keys(context).sort()) {
    params.set(`context.${key}`, context[key] as string);
  }
}

// `?context.<key>=<value>...` for a delete that targets a contextual
// entry, or "" for the global one.
export function contextQuery(context: PermissionContext | undefined): string {
  const params = new URLSearchParams();
  appendContextParams(params, context);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// Copies a wire `context` onto a decoded value only when it is a
// non-empty object of strings, so a global entry carries no field.
export function wireContext(raw: unknown): PermissionContext | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: PermissionContext = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// True when a request should carry `context`: present and non-empty.
export function hasContext(context: PermissionContext | undefined): context is PermissionContext {
  return context !== undefined && Object.keys(context).length > 0;
}
