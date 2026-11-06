import type {
  PermissionCheckResult,
  PermissionContext,
  PermissionMode,
  RoleId,
} from "@junjo.io/shared";
import {
  type ContextInheritance,
  canonicalContextKey,
  contextChain,
  foldContextValue,
} from "./permissionContext.js";

// Pure permission resolution over already-loaded data. The server loads
// the rows a check can reach and hands them here; client SDKs that
// resolve locally implement the same algorithm, and both are held to
// the shared conformance vectors in `packages/shared/conformance`.
//
// An entry applies to a check when its key is a candidate for the
// permission and its context applies: a global entry always applies,
// and an entry with context E applies when, for every (k, v) in E, the
// check's context C has k and v is in the inheritance chain of C[k].
// Its context score is (number of keys in E, sum of chain distances);
// a global entry scores (0, 0).
//
// Precedence, applied in order:
//   1. Layer. The member's own overrides first, then the roles the
//      member holds directly, then their parents, then grandparents.
//      A role reachable through several paths sits at its shortest
//      distance. The first layer with any applicable entry decides.
//   2. Context, within the deciding layer. More matched keys win, then
//      the smaller distance sum.
//   3. Specificity, among the entries with the best context score. The
//      exact key beats the longest matching wildcard, down to the bare
//      wildcard.
//   4. Deny wins between the entries that remain.
//
// With no check context only global entries apply.
//
// The mode only changes key matching. In "exact" mode keys are opaque
// and case-sensitive. In "nodes" mode keys are dot-separated, case-
// insensitive, a final `.*` segment matches one or more further
// segments, and a bare `*` matches every key. Context values are folded
// in every mode.

export type { PermissionMode };

// Bounds the role-parent walk. Writes are cycle-checked, so this only
// matters against corrupted state.
export const MAX_ROLE_DEPTH = 100;

// An entry or override limited to a context. `permission` is the stored
// (normalized) key; `context` is non-empty.
export interface ResolverContextEntry {
  permission: string;
  value: boolean;
  context: PermissionContext;
}

export interface ResolverRole {
  priority: number;
  // Global entries, by stored key.
  entries: ReadonlyMap<string, boolean>;
  contextEntries?: readonly ResolverContextEntry[];
  parents: readonly string[];
}

export interface ResolverInput {
  mode: PermissionMode;
  // Global overrides, by stored key.
  overrides: ReadonlyMap<string, boolean>;
  contextOverrides?: readonly ResolverContextEntry[];
  directRoleIds: readonly string[];
  roles: ReadonlyMap<string, ResolverRole>;
  // The check's context. Absent or empty: only global entries apply.
  context?: PermissionContext;
  // The game's `permissions.contexts`.
  contexts?: ContextInheritance;
}

const WILDCARD = "*";
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

// Lowercasing is restricted to ASCII so every implementation folds
// identically regardless of platform locale rules.
function asciiLower(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

export function normalizePermissionKey(mode: PermissionMode, key: string): string {
  return mode === "nodes" ? asciiLower(key) : key;
}

// Returns null when the key is acceptable in the mode, else a reason.
// "exact" mode adds no rules beyond the length limit enforced by the
// request schemas.
export function validatePermissionKey(mode: PermissionMode, key: string): string | null {
  if (mode === "exact") return null;
  if (!PRINTABLE_ASCII.test(key)) return "must be printable ASCII with no whitespace";
  if (key.startsWith("-")) return "must not start with '-'; set the entry's value to deny instead";
  if (key === WILDCARD) return null;
  const segments = key.split(".");
  // Segment matching assumes every segment names a node, so a key with
  // an empty segment (leading, trailing or doubled dot) is refused.
  if (segments.some((s) => s.length === 0)) return "must not contain an empty segment";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    if (!segment.includes(WILDCARD)) continue;
    if (segment !== WILDCARD || i !== segments.length - 1) {
      return "'*' is only allowed as the whole final segment or as the whole key";
    }
  }
  return null;
}

// Keys whose entries could decide a check for `permission`, most
// specific first. The index of a key in this list is its specificity
// rank (lower wins).
export function candidateKeys(mode: PermissionMode, permission: string): string[] {
  const key = normalizePermissionKey(mode, permission);
  if (mode === "exact") return [key];
  const out: string[] = [key];
  if (key !== WILDCARD) {
    const segments = key.split(".");
    for (let i = segments.length - 1; i >= 1; i--) {
      out.push(`${segments.slice(0, i).join(".")}.${WILDCARD}`);
    }
    out.push(WILDCARD);
  }
  return [...new Set(out)];
}

type Chains = ReadonlyMap<string, ReadonlyMap<string, number>>;

// The inheritance chain of every key in the check's context.
function contextChains(
  context: PermissionContext | undefined,
  contexts: ContextInheritance | undefined,
): Chains {
  const chains = new Map<string, Map<string, number>>();
  if (!context) return chains;
  for (const [key, value] of Object.entries(context)) {
    chains.set(key, contextChain(contexts, key, foldContextValue(value)));
  }
  return chains;
}

// An applicable entry's place in the precedence: context keys matched,
// chain distance sum, specificity rank.
interface Score {
  keys: number;
  distance: number;
  rank: number;
}

// Negative when `a` decides ahead of `b`.
function compareScore(a: Score, b: Score): number {
  if (a.keys !== b.keys) return b.keys - a.keys;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.rank - b.rank;
}

// The best-scoring applicable entries of one role, or of the overrides.
// `deny` / `grant` are undefined when no entry of that value has the
// best score; otherwise they hold the context to report for it (null
// for global), the smallest canonical key when several qualify.
interface SourceBest {
  score: Score;
  deny: PermissionContext | null | undefined;
  grant: PermissionContext | null | undefined;
}

function contextScore(
  context: PermissionContext,
  chains: Chains,
): { keys: number; distance: number } | null {
  let keys = 0;
  let distance = 0;
  for (const [key, value] of Object.entries(context)) {
    const d = chains.get(key)?.get(foldContextValue(value));
    if (d === undefined) return null;
    keys++;
    distance += d;
  }
  return { keys, distance };
}

function sourceBest(
  global: ReadonlyMap<string, boolean>,
  contextual: readonly ResolverContextEntry[] | undefined,
  candidates: readonly string[],
  rankOf: ReadonlyMap<string, number>,
  chains: Chains,
): SourceBest | null {
  let best: SourceBest | null = null;
  const consider = (score: Score, value: boolean, context: PermissionContext | null) => {
    if (best) {
      const order = compareScore(score, best.score);
      if (order > 0) return;
      if (order < 0) best = { score, deny: undefined, grant: undefined };
    } else {
      best = { score, deny: undefined, grant: undefined };
    }
    const current: SourceBest = best;
    const held = value ? current.grant : current.deny;
    if (held === undefined || canonicalContextKey(context) < canonicalContextKey(held)) {
      if (value) current.grant = context;
      else current.deny = context;
    }
  };
  // Global entries all score (0, 0), so only the most specific matters.
  for (let i = 0; i < candidates.length; i++) {
    const value = global.get(candidates[i] as string);
    if (value === undefined) continue;
    consider({ keys: 0, distance: 0, rank: i }, value, null);
    break;
  }
  if (contextual && chains.size > 0) {
    for (const entry of contextual) {
      const rank = rankOf.get(entry.permission);
      if (rank === undefined) continue;
      const scored = contextScore(entry.context, chains);
      if (!scored) continue;
      consider({ ...scored, rank }, entry.value, entry.context);
    }
  }
  return best;
}

// Higher priority first, then roleId descending: the same tie-break as
// the role layer.
function outranks(a: { id: string; priority: number }, b: { id: string; priority: number }) {
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.id > b.id;
}

function withContext(
  result: PermissionCheckResult,
  context: PermissionContext | null | undefined,
): PermissionCheckResult {
  if (context && Object.keys(context).length > 0) {
    const folded: PermissionContext = {};
    for (const key of Object.keys(context).sort()) {
      folded[key] = foldContextValue(context[key] as string);
    }
    result.context = folded;
  }
  return result;
}

interface LayerHit {
  id: string;
  priority: number;
  best: SourceBest;
}

// Resolves one member's check. Membership and status gating happen in
// the caller; this answers only from overrides and roles, falling back
// to `default`.
export function resolveMemberPermission(
  input: ResolverInput,
  permission: string,
): PermissionCheckResult {
  const candidates = candidateKeys(input.mode, permission);
  const rankOf = new Map(candidates.map((key, i) => [key, i]));
  const chains = contextChains(input.context, input.contexts);

  const own = sourceBest(input.overrides, input.contextOverrides, candidates, rankOf, chains);
  if (own) {
    const allowed = own.deny === undefined;
    return withContext({ allowed, source: "override" }, allowed ? own.grant : own.deny);
  }

  const visited = new Set<string>();
  let layer = [...new Set(input.directRoleIds)].filter((id) => input.roles.has(id));
  for (let depth = 0; layer.length > 0 && depth <= MAX_ROLE_DEPTH; depth++) {
    for (const id of layer) visited.add(id);

    const hits: LayerHit[] = [];
    let top: Score | null = null;
    for (const id of layer) {
      const role = input.roles.get(id) as ResolverRole;
      const best = sourceBest(role.entries, role.contextEntries, candidates, rankOf, chains);
      if (!best) continue;
      hits.push({ id, priority: role.priority, best });
      if (!top || compareScore(best.score, top) < 0) top = best.score;
    }

    if (top) {
      const at: Score = top;
      let denier: LayerHit | null = null;
      let granter: LayerHit | null = null;
      for (const hit of hits) {
        if (compareScore(hit.best.score, at) !== 0) continue;
        if (hit.best.deny !== undefined && (!denier || outranks(hit, denier))) denier = hit;
        if (hit.best.grant !== undefined && (!granter || outranks(hit, granter))) granter = hit;
      }
      if (denier) {
        return withContext(
          { allowed: false, source: "role", viaRoleId: denier.id as RoleId },
          denier.best.deny,
        );
      }
      const decider = granter as LayerHit;
      return withContext(
        { allowed: true, source: "role", viaRoleId: decider.id as RoleId },
        decider.best.grant,
      );
    }

    const next = new Set<string>();
    for (const id of layer) {
      for (const parent of (input.roles.get(id) as ResolverRole).parents) {
        if (!visited.has(parent) && input.roles.has(parent)) next.add(parent);
      }
    }
    layer = [...next];
  }

  return { allowed: false, source: "default" };
}

// Returns the ids on one cycle in a role-parent graph, or null when the
// graph is acyclic. Parents that are not keys of the map are ignored.
export function findRoleCycle(
  parentsById: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const seen = state.get(id);
    if (seen === "done") return null;
    if (seen === "active") return stack.slice(stack.indexOf(id));
    state.set(id, "active");
    stack.push(id);
    for (const parent of parentsById.get(id) ?? []) {
      if (!parentsById.has(parent)) continue;
      const cycle = visit(parent);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of parentsById.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}
