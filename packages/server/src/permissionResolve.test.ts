import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type PermissionMode,
  type ResolverRole,
  candidateKeys,
  findRoleCycle,
  normalizePermissionKey,
  resolveMemberPermission,
  validatePermissionKey,
} from "./permissionResolve.js";

interface VectorRole {
  priority: number;
  entries: Record<string, boolean>;
  parents?: string[];
}

interface VectorCase {
  name: string;
  modes: PermissionMode[];
  roles: Record<string, VectorRole>;
  member: { roles: string[]; overrides?: Record<string, boolean> };
  checks: { permission: string; allowed: boolean; source: string; via?: string }[];
}

interface Vectors {
  version: number;
  cases: VectorCase[];
  keys: { mode: PermissionMode; key: string; valid: boolean }[];
  graphs: { name: string; parents: Record<string, string[]>; valid: boolean }[];
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
              parents: r.parents ?? [],
            },
          ]),
        );
        const input = {
          mode,
          overrides: normalizedEntries(mode, vc.member.overrides ?? {}),
          directRoleIds: vc.member.roles,
          roles,
        };
        for (const check of vc.checks) {
          const expected: Record<string, unknown> = {
            allowed: check.allowed,
            source: check.source,
          };
          if (check.via !== undefined) expected.viaRoleId = check.via;
          expect(resolveMemberPermission(input, check.permission), check.permission).toEqual(
            expected,
          );
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
