import type { PermissionCheckResult, PermissionMode, RoleId } from "@junjo.io/shared";

// Pure permission resolution over already-loaded data. The server loads
// the rows a check can reach and hands them here; client SDKs that
// resolve locally implement the same algorithm, and both are held to
// the shared conformance vectors in `packages/shared/conformance`.
//
// Precedence, applied in order:
//   1. Layer. The member's own overrides first, then the roles the
//      member holds directly, then their parents, then grandparents.
//      A role reachable through several paths sits at its shortest
//      distance. The first layer with any matching entry decides.
//   2. Specificity, within the deciding layer. The exact key beats the
//      longest matching wildcard, down to the bare wildcard.
//   3. Deny wins between entries of equal layer and specificity.
//
// The mode only changes key matching. In "exact" mode keys are opaque
// and case-sensitive. In "nodes" mode keys are dot-separated, case-
// insensitive, a final `.*` segment matches one or more further
// segments, and a bare `*` matches every key.

export type { PermissionMode };

// Bounds the role-parent walk. Writes are cycle-checked, so this only
// matters against corrupted state.
export const MAX_ROLE_DEPTH = 100;

export interface ResolverRole {
  priority: number;
  entries: ReadonlyMap<string, boolean>;
  parents: readonly string[];
}

export interface ResolverInput {
  mode: PermissionMode;
  overrides: ReadonlyMap<string, boolean>;
  directRoleIds: readonly string[];
  roles: ReadonlyMap<string, ResolverRole>;
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

function bestCandidate(
  entries: ReadonlyMap<string, boolean>,
  candidates: readonly string[],
): number {
  for (let i = 0; i < candidates.length; i++) {
    if (entries.has(candidates[i] as string)) return i;
  }
  return -1;
}

// Higher priority first, then roleId descending: the same tie-break as
// the role layer.
function outranks(a: { id: string; priority: number }, b: { id: string; priority: number }) {
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.id > b.id;
}

// Resolves one member's check. Membership and status gating happen in
// the caller; this answers only from overrides and roles, falling back
// to `default`.
export function resolveMemberPermission(
  input: ResolverInput,
  permission: string,
): PermissionCheckResult {
  const candidates = candidateKeys(input.mode, permission);

  const overrideRank = bestCandidate(input.overrides, candidates);
  if (overrideRank !== -1) {
    const value = input.overrides.get(candidates[overrideRank] as string) as boolean;
    return { allowed: value, source: "override" };
  }

  const visited = new Set<string>();
  let layer = [...new Set(input.directRoleIds)].filter((id) => input.roles.has(id));
  for (let depth = 0; layer.length > 0 && depth <= MAX_ROLE_DEPTH; depth++) {
    for (const id of layer) visited.add(id);

    let rank = -1;
    for (const id of layer) {
      const r = bestCandidate((input.roles.get(id) as ResolverRole).entries, candidates);
      if (r !== -1 && (rank === -1 || r < rank)) rank = r;
    }

    if (rank !== -1) {
      const key = candidates[rank] as string;
      let denier: { id: string; priority: number } | null = null;
      let granter: { id: string; priority: number } | null = null;
      for (const id of layer) {
        const role = input.roles.get(id) as ResolverRole;
        const value = role.entries.get(key);
        if (value === undefined) continue;
        const candidate = { id, priority: role.priority };
        if (value === false) {
          if (!denier || outranks(candidate, denier)) denier = candidate;
        } else if (!granter || outranks(candidate, granter)) {
          granter = candidate;
        }
      }
      const decider = (denier ?? granter) as { id: string };
      return { allowed: denier === null, source: "role", viaRoleId: decider.id as RoleId };
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
