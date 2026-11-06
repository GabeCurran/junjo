import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ContextInheritance,
  canonicalContextKey,
  contextFromQuery,
  normalizeContext,
  normalizeContextInheritance,
} from "./permissionContext.js";
import {
  type PermissionMode,
  type ResolverContextEntry,
  type ResolverRole,
  candidateKeys,
  findRoleCycle,
  normalizePermissionKey,
  resolveMemberPermission,
  validatePermissionKey,
} from "./permissionResolve.js";

type VectorContext = Record<string, string>;
type VectorInheritance = Record<string, { inherit: Record<string, string[]> }>;

interface VectorContextEntry {
  permission: string;
  value: boolean;
  context: VectorContext;
}

interface VectorRole {
  priority: number;
  entries: Record<string, boolean>;
  contextEntries?: VectorContextEntry[];
  parents?: string[];
}

interface VectorCase {
  name: string;
  modes: PermissionMode[];
  contexts?: VectorInheritance;
  roles: Record<string, VectorRole>;
  member: {
    roles: string[];
    overrides?: Record<string, boolean>;
    contextOverrides?: VectorContextEntry[];
  };
  checks: {
    permission: string;
    context?: VectorContext;
    allowed: boolean;
    source: string;
    via?: string;
    decidedContext?: VectorContext;
  }[];
}

interface Vectors {
  version: number;
  cases: VectorCase[];
  keys: { mode: PermissionMode; key: string; valid: boolean }[];
  graphs: { name: string; parents: Record<string, string[]>; valid: boolean }[];
  contextConfigs: { name: string; contexts: VectorInheritance; valid: boolean }[];
  entryContexts: { context: VectorContext; valid: boolean; canonical?: string }[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../shared/conformance/permission-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

// Normalizes entry keys the way the write path does, so a vector's
// as-written keys land in the same shape as stored rows.
function normalizedEntries(mode: PermissionMode, entries: Record<string, boolean>) {
  return new Map(Object.entries(entries).map(([k, v]) => [normalizePermissionKey(mode, k), v]));
}

function folded(context: VectorContext): VectorContext {
  const result = normalizeContext(context);
  if ("error" in result) throw new Error(result.error);
  return result.context;
}

function normalizedContextEntries(
  mode: PermissionMode,
  entries: VectorContextEntry[] | undefined,
): ResolverContextEntry[] {
  return (entries ?? []).map((e) => ({
    permission: normalizePermissionKey(mode, e.permission),
    value: e.value,
    context: folded(e.context),
  }));
}

function normalizedInheritance(contexts: VectorInheritance | undefined): ContextInheritance {
  const result = normalizeContextInheritance(contexts ?? {});
  if ("error" in result) throw new Error(result.error);
  return result.contexts;
}

describe("permission conformance vectors", () => {
  it("is a supported vectors version", () => {
    expect(vectors.version).toBe(1);
  });

  for (const vc of vectors.cases) {
    for (const mode of vc.modes) {
      it(`[${mode}] ${vc.name}`, () => {
        const roles = new Map<string, ResolverRole>(
          Object.entries(vc.roles).map(([id, r]) => [
            id,
            {
              priority: r.priority,
              entries: normalizedEntries(mode, r.entries),
              contextEntries: normalizedContextEntries(mode, r.contextEntries),
              parents: r.parents ?? [],
            },
          ]),
        );
        const input = {
          mode,
          overrides: normalizedEntries(mode, vc.member.overrides ?? {}),
          contextOverrides: normalizedContextEntries(mode, vc.member.contextOverrides),
          directRoleIds: vc.member.roles,
          roles,
          contexts: normalizedInheritance(vc.contexts),
        };
        for (const check of vc.checks) {
          const expected: Record<string, unknown> = {
            allowed: check.allowed,
            source: check.source,
          };
          if (check.via !== undefined) expected.viaRoleId = check.via;
          if (check.decidedContext !== undefined) expected.context = check.decidedContext;
          const label = `${check.permission} ${JSON.stringify(check.context ?? {})}`;
          expect(
            resolveMemberPermission(
              { ...input, context: check.context ? folded(check.context) : undefined },
              check.permission,
            ),
            label,
          ).toEqual(expected);
        }
      });
    }
  }

  for (const kv of vectors.keys) {
    it(`[${kv.mode}] key ${JSON.stringify(kv.key)} is ${kv.valid ? "valid" : "invalid"}`, () => {
      expect(validatePermissionKey(kv.mode, kv.key) === null).toBe(kv.valid);
    });
  }

  for (const gv of vectors.graphs) {
    it(`role graph "${gv.name}" is ${gv.valid ? "acyclic" : "cyclic"}`, () => {
      const cycle = findRoleCycle(new Map(Object.entries(gv.parents)));
      expect(cycle === null).toBe(gv.valid);
    });
  }

  for (const cv of vectors.contextConfigs) {
    it(`context config "${cv.name}" is ${cv.valid ? "accepted" : "refused"}`, () => {
      expect("contexts" in normalizeContextInheritance(cv.contexts)).toBe(cv.valid);
    });
  }

  for (const ev of vectors.entryContexts) {
    it(`context ${JSON.stringify(ev.context)} is ${ev.valid ? "valid" : "invalid"}`, () => {
      const result = normalizeContext(ev.context);
      expect("context" in result).toBe(ev.valid);
      if ("context" in result && ev.canonical !== undefined) {
        expect(canonicalContextKey(result.context)).toBe(ev.canonical);
      }
    });
  }
});

describe("candidateKeys", () => {
  it("lists the exact key then each wildcard from most to least specific", () => {
    expect(candidateKeys("nodes", "A.b.C")).toEqual(["a.b.c", "a.b.*", "a.*", "*"]);
  });

  it("returns only the literal key in exact mode", () => {
    expect(candidateKeys("exact", "A.b.*")).toEqual(["A.b.*"]);
  });

  it("does not repeat a wildcard query", () => {
    expect(candidateKeys("nodes", "a.*")).toEqual(["a.*", "*"]);
    expect(candidateKeys("nodes", "*")).toEqual(["*"]);
  });
});

describe("context precedence", () => {
  const role = (
    priority: number,
    entries: Record<string, boolean>,
    contextEntries: ResolverContextEntry[] = [],
    parents: string[] = [],
  ): ResolverRole => ({
    priority,
    entries: new Map(Object.entries(entries)),
    contextEntries,
    parents,
  });
  const ce = (permission: string, value: boolean, context: Record<string, string>) => ({
    permission,
    value,
    context,
  });
  const resolve = (
    roles: Record<string, ResolverRole>,
    direct: string[],
    permission: string,
    extra: Partial<Parameters<typeof resolveMemberPermission>[0]> = {},
  ) =>
    resolveMemberPermission(
      {
        mode: "nodes",
        overrides: new Map(),
        directRoleIds: direct,
        roles: new Map(Object.entries(roles)),
        ...extra,
      },
      permission,
    );

  it("ignores contextual entries when the check has no context", () => {
    const roles = { r: role(1, { a: true }, [ce("a", false, { world: "x" })]) };
    expect(resolve(roles, ["r"], "a")).toEqual({ allowed: true, source: "role", viaRoleId: "r" });
    expect(resolve(roles, ["r"], "a", { context: {} })).toEqual({
      allowed: true,
      source: "role",
      viaRoleId: "r",
    });
  });

  it("decides by layer before context", () => {
    const roles = {
      child: role(2, { a: true }, [], ["parent"]),
      parent: role(1, {}, [ce("a", false, { world: "x" })]),
    };
    expect(resolve(roles, ["child"], "a", { context: { world: "x" } })).toEqual({
      allowed: true,
      source: "role",
      viaRoleId: "child",
    });
    expect(
      resolve(roles, ["child"], "a", {
        context: { world: "x" },
        overrides: new Map([["a", false]]),
      }),
    ).toEqual({ allowed: false, source: "override" });
  });

  it("ranks context above key specificity inside a layer", () => {
    const roles = { r: role(1, { "a.b": false }, [ce("*", true, { world: "x" })]) };
    expect(resolve(roles, ["r"], "a.b", { context: { world: "x" } })).toEqual({
      allowed: true,
      source: "role",
      viaRoleId: "r",
      context: { world: "x" },
    });
  });

  it("prefers more matched keys, then a smaller distance sum", () => {
    const contexts = { world: { inherit: { child: ["parent"], parent: ["root"] } } };
    const roles = {
      r: role(1, {}, [
        ce("a", true, { world: "root", server: "eu" }),
        ce("a", false, { world: "child" }),
        ce("b", true, { world: "root" }),
        ce("b", false, { world: "parent" }),
      ]),
    };
    const context = { world: "child", server: "eu" };
    expect(resolve(roles, ["r"], "a", { context, contexts })).toMatchObject({
      allowed: true,
      context: { server: "eu", world: "root" },
    });
    expect(resolve(roles, ["r"], "b", { context, contexts })).toMatchObject({
      allowed: false,
      context: { world: "parent" },
    });
  });

  it("uses key specificity among entries with the same context score", () => {
    const roles = {
      r: role(1, {}, [ce("a.*", false, { world: "x" }), ce("a.b", true, { world: "x" })]),
    };
    expect(resolve(roles, ["r"], "a.b", { context: { world: "x" } }).allowed).toBe(true);
    expect(resolve(roles, ["r"], "a.c", { context: { world: "x" } }).allowed).toBe(false);
  });

  it("lets deny win a full tie and keeps the role tie-break", () => {
    const roles = {
      high: role(9, {}, [ce("a", true, { world: "x" })]),
      low: role(1, {}, [ce("a", false, { world: "x" })]),
      low2: role(1, {}, [ce("a", false, { world: "x" })]),
    };
    expect(resolve(roles, ["high", "low", "low2"], "a", { context: { world: "x" } })).toEqual({
      allowed: false,
      source: "role",
      viaRoleId: "low2",
      context: { world: "x" },
    });
    expect(resolve(roles, ["high"], "a", { context: { world: "x" } }).viaRoleId).toBe("high");
  });

  it("folds the check context and reports the deciding context folded", () => {
    const roles = { r: role(1, {}, [ce("a", true, { world: "Nether" })]) };
    expect(resolve(roles, ["r"], "a", { context: { world: "NETHER" } })).toEqual({
      allowed: true,
      source: "role",
      viaRoleId: "r",
      context: { world: "nether" },
    });
  });

  it("applies contextual overrides with the same ordering", () => {
    const overrides = new Map([["a", true]]);
    const contextOverrides = [ce("a", false, { world: "x" })];
    expect(resolve({}, [], "a", { overrides, contextOverrides, context: { world: "x" } })).toEqual({
      allowed: false,
      source: "override",
      context: { world: "x" },
    });
    expect(resolve({}, [], "a", { overrides, contextOverrides, context: { world: "y" } })).toEqual({
      allowed: true,
      source: "override",
    });
  });

  it("terminates on an inheritance cycle in stored state", () => {
    const contexts = { world: { inherit: { a: ["b"], b: ["a"] } } };
    const roles = { r: role(1, {}, [ce("p", true, { world: "b" })]) };
    expect(resolve(roles, ["r"], "p", { context: { world: "a" }, contexts }).allowed).toBe(true);
  });
});

describe("contextFromQuery", () => {
  it("reads context.<key> parameters, folded", () => {
    expect(
      contextFromQuery(new URLSearchParams("userId=u&context.world=Creative&context.server=EU")),
    ).toEqual({ server: "eu", world: "creative" });
    expect(contextFromQuery(new URLSearchParams("userId=u"))).toEqual({});
  });

  it("refuses a repeated or invalid key", () => {
    expect(() =>
      contextFromQuery(new URLSearchParams("context.world=a&context.world=b")),
    ).toThrow();
    expect(() => contextFromQuery(new URLSearchParams("context.=a"))).toThrow();
    expect(() => contextFromQuery(new URLSearchParams("context.World=a"))).toThrow();
  });
});
