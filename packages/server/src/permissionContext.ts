import {
  type GameConfigPermissionContext,
  MAX_CONTEXT_INHERIT_DEPTH,
  MAX_CONTEXT_INHERIT_PARENTS,
  MAX_CONTEXT_INHERIT_VALUES,
  MAX_PERMISSION_CONTEXT_KEYS,
  PERMISSION_CONTEXT_KEY_PATTERN,
  PERMISSION_CONTEXT_VALUE_MAX_LENGTH,
  type PermissionContext,
} from "@junjo.io/shared";
import { z } from "zod";
import { Errors } from "./errors.js";

// Contexts on permission entries: validation, folding, the canonical
// storage key and value inheritance. Pure apart from the request
// helpers at the bottom, which throw `bad_request`.
//
// A context maps game-defined keys to values. Values are folded with
// the same ASCII-only lowercase fold as nodes-mode permission keys, in
// every permission mode, so every implementation compares them
// identically regardless of platform locale rules.

export type ContextInheritance = Readonly<Record<string, GameConfigPermissionContext>>;

const KEY_PATTERN = new RegExp(PERMISSION_CONTEXT_KEY_PATTERN);

// Bounds the number of context keys `permissions.contexts` may declare
// inheritance for, so one config write cannot store an unbounded graph.
export const MAX_CONTEXT_INHERIT_KEYS = 32;

export function foldContextValue(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

// Unicode control characters (general category Cc): C0, DEL and C1.
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

// Returns null when `key` is a valid context key, else a reason.
export function contextKeyProblem(key: string): string | null {
  if (!KEY_PATTERN.test(key)) {
    return `context key ${JSON.stringify(key)} must match ${PERMISSION_CONTEXT_KEY_PATTERN}`;
  }
  return null;
}

// Returns null when `value` is a valid context value, else a reason.
// Length is counted in UTF-16 code units, like permission keys.
export function contextValueProblem(value: string): string | null {
  if (value.length < 1 || value.length > PERMISSION_CONTEXT_VALUE_MAX_LENGTH) {
    return `context value ${JSON.stringify(value)} must be 1 to ${PERMISSION_CONTEXT_VALUE_MAX_LENGTH} characters`;
  }
  if (hasControlCharacter(value)) {
    return `context value ${JSON.stringify(value)} must not contain control characters`;
  }
  return null;
}

// Validates a context and returns its folded form, or a reason. Keys
// are not folded: they must already match the key pattern.
export function normalizeContext(
  raw: Readonly<Record<string, string>>,
): { context: PermissionContext } | { error: string } {
  const keys = Object.keys(raw);
  if (keys.length > MAX_PERMISSION_CONTEXT_KEYS) {
    return { error: `context may have at most ${MAX_PERMISSION_CONTEXT_KEYS} keys` };
  }
  const context: PermissionContext = {};
  for (const key of keys.sort()) {
    const keyProblem = contextKeyProblem(key);
    if (keyProblem) return { error: keyProblem };
    const value = raw[key] as string;
    const valueProblem = contextValueProblem(value);
    if (valueProblem) return { error: valueProblem };
    context[key] = foldContextValue(value);
  }
  return { context };
}

// The canonical form used for storage and uniqueness: "" for a global
// context, otherwise the JSON array of [key, value] pairs sorted by key.
// Expects a context already folded by `normalizeContext`.
export function canonicalContextKey(
  context: Readonly<PermissionContext> | null | undefined,
): string {
  if (!context) return "";
  const keys = Object.keys(context).sort();
  if (keys.length === 0) return "";
  return JSON.stringify(keys.map((k) => [k, context[k]]));
}

// The stored `context` column value for a folded context: null when
// global, so global rows keep the shape they had before contexts.
export function storedContext(context: Readonly<PermissionContext>): PermissionContext | null {
  return Object.keys(context).length === 0 ? null : { ...context };
}

// Reads a stored `context` column back. Anything but a non-empty object
// of strings is treated as global.
export function contextFromStored(value: unknown): PermissionContext | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: PermissionContext = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// The wire `context` field of a stored entry or override row: present
// only for a contextual row.
export function rowContextField(row: { context: unknown; contextKey: string }): {
  context?: PermissionContext;
} {
  if (row.contextKey === "") return {};
  const context = contextFromStored(row.context);
  return context ? { context } : {};
}

// Every value reachable from `value` through the key's inheritance,
// mapped to its shortest distance: `value` itself is 0, its parents 1,
// and so on. `value` must already be folded. Breadth-first with a
// visited set, so a cycle in corrupted state still terminates; the
// depth bound applies for the same reason.
export function contextChain(
  inheritance: ContextInheritance | undefined,
  key: string,
  value: string,
): Map<string, number> {
  const chain = new Map<string, number>([[value, 0]]);
  const inherit = inheritance && Object.hasOwn(inheritance, key) ? inheritance[key]?.inherit : null;
  if (!inherit) return chain;
  let frontier = [value];
  for (let distance = 1; frontier.length > 0 && distance <= MAX_CONTEXT_INHERIT_DEPTH; distance++) {
    const next: string[] = [];
    for (const v of frontier) {
      const parents = Object.hasOwn(inherit, v) ? inherit[v] : undefined;
      for (const parent of parents ?? []) {
        const folded = foldContextValue(parent);
        if (chain.has(folded)) continue;
        chain.set(folded, distance);
        next.push(folded);
      }
    }
    frontier = next;
  }
  return chain;
}

// Validates `permissions.contexts` and returns its folded form, or a
// reason. Refused: an invalid key or value, a value listed twice after
// folding, more than `MAX_CONTEXT_INHERIT_VALUES` values declaring
// parents under one key, more than `MAX_CONTEXT_INHERIT_PARENTS`
// parents on one value, a cycle, or a chain longer than
// `MAX_CONTEXT_INHERIT_DEPTH` steps. Repeated parents collapse to one.
export function normalizeContextInheritance(
  raw: Readonly<Record<string, { inherit: Readonly<Record<string, readonly string[]>> }>>,
): { contexts: Record<string, GameConfigPermissionContext> } | { error: string } {
  const keys = Object.keys(raw);
  if (keys.length > MAX_CONTEXT_INHERIT_KEYS) {
    return { error: `at most ${MAX_CONTEXT_INHERIT_KEYS} context keys may declare inheritance` };
  }
  const contexts: Record<string, GameConfigPermissionContext> = {};
  for (const key of keys.sort()) {
    const keyProblem = contextKeyProblem(key);
    if (keyProblem) return { error: keyProblem };
    const source = (raw[key] as { inherit: Readonly<Record<string, readonly string[]>> }).inherit;
    const values = Object.keys(source);
    if (values.length > MAX_CONTEXT_INHERIT_VALUES) {
      return {
        error: `context key ${JSON.stringify(key)} may list at most ${MAX_CONTEXT_INHERIT_VALUES} values`,
      };
    }
    const inherit: Record<string, string[]> = {};
    for (const value of values) {
      const valueProblem = contextValueProblem(value);
      if (valueProblem) return { error: valueProblem };
      const folded = foldContextValue(value);
      if (Object.hasOwn(inherit, folded)) {
        return {
          error: `context key ${JSON.stringify(key)} lists value ${JSON.stringify(folded)} twice ignoring case`,
        };
      }
      const parents = source[value] as readonly string[];
      if (parents.length > MAX_CONTEXT_INHERIT_PARENTS) {
        return {
          error: `context value ${JSON.stringify(folded)} may have at most ${MAX_CONTEXT_INHERIT_PARENTS} parents`,
        };
      }
      const folds: string[] = [];
      for (const parent of parents) {
        const parentProblem = contextValueProblem(parent);
        if (parentProblem) return { error: parentProblem };
        const f = foldContextValue(parent);
        if (!folds.includes(f)) folds.push(f);
      }
      inherit[folded] = folds;
    }
    const shapeProblem = inheritanceShapeProblem(inherit);
    if (shapeProblem) return { error: `context key ${JSON.stringify(key)}: ${shapeProblem}` };
    contexts[key] = { inherit };
  }
  return { contexts };
}

// Null when the value graph is acyclic and no chain is longer than the
// depth limit, else a reason. Values without an entry have no parents.
function inheritanceShapeProblem(
  inherit: Readonly<Record<string, readonly string[]>>,
): string | null {
  const state = new Map<string, "active" | "done">();
  const longest = new Map<string, number>();
  const visit = (value: string, path: string[]): string | null => {
    const seen = state.get(value);
    if (seen === "done") return null;
    if (seen === "active") {
      const cycle = [...path.slice(path.indexOf(value)), value];
      return `inheritance has a cycle: ${cycle.map((v) => JSON.stringify(v)).join(" -> ")}`;
    }
    state.set(value, "active");
    let best = 0;
    for (const parent of Object.hasOwn(inherit, value) ? (inherit[value] ?? []) : []) {
      const problem = visit(parent, [...path, value]);
      if (problem) return problem;
      best = Math.max(best, (longest.get(parent) ?? 0) + 1);
    }
    longest.set(value, best);
    state.set(value, "done");
    if (best > MAX_CONTEXT_INHERIT_DEPTH) {
      return `inheritance is deeper than ${MAX_CONTEXT_INHERIT_DEPTH} steps`;
    }
    return null;
  };
  for (const value of Object.keys(inherit)) {
    const problem = visit(value, []);
    if (problem) return problem;
  }
  return null;
}

// Request bodies: a context object of string values, validated and
// folded. An empty object is the global context.
export const permissionContextSchema = z.record(z.string(), z.string()).transform((raw, ctx) => {
  const result = normalizeContext(raw);
  if ("error" in result) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
    return z.NEVER;
  }
  return result.context;
});

const CONTEXT_QUERY_PREFIX = "context.";

// Reads a check's or a delete's context from `context.<key>=<value>`
// query parameters. A key given more than once is refused rather than
// resolved by position.
export function contextFromQuery(params: URLSearchParams): PermissionContext {
  const raw = new Map<string, string>();
  for (const [name, value] of params) {
    if (!name.startsWith(CONTEXT_QUERY_PREFIX)) continue;
    const key = name.slice(CONTEXT_QUERY_PREFIX.length);
    if (raw.has(key)) {
      throw Errors.badRequest(`query parameter ${JSON.stringify(name)} is given more than once`);
    }
    raw.set(key, value);
  }
  const result = normalizeContext(Object.fromEntries(raw));
  if ("error" in result) throw Errors.badRequest(result.error);
  return result.context;
}

export function contextFromRequestUrl(url: string): PermissionContext {
  return contextFromQuery(new URL(url).searchParams);
}
