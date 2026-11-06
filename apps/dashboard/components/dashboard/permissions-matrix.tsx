// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Loader2, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  denyRolePermissionAction,
  grantRolePermissionAction,
  revokeRolePermissionAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import {
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  type AdminPermissionDef,
  type AdminPermissionEntry,
  type AdminRole,
  type RoleEntryState,
  formatPermissionContext,
  isContextual,
  permissionEntryId,
  roleContextEntries,
  roleEntries,
  roleEntryState,
} from "../../lib/admin-shared";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RoleChip } from "../ui/role-chip";
import { Notice } from "../ui/section";

interface PermissionsMatrixProps {
  // Sorted by `priority desc, name asc` server-side. We render in this
  // order so the highest-authority role appears at the top.
  roles: AdminRole[];
  // Sorted by `key asc` server-side. Surfaces every permission key
  // currently registered in the per-game `PermissionDef` catalog.
  catalog: AdminPermissionDef[];
  gameId: string;
  groupId: string;
}

// Compose the pending-cell state key. Same convention as the row dialogs
// in `view-permission-overrides-dialog.tsx`.
function cellKey(roleId: string, permission: string): string {
  return `${roleId}::${permission}`;
}

interface CellError {
  roleName: string;
  permission: string;
  error: string;
}

export function PermissionsMatrix({ roles, catalog, gameId, groupId }: PermissionsMatrixProps) {
  // Mirror the roles prop into local state so per-cell toggles can flip
  // optimistically without waiting for the Server Action's `revalidatePath`
  // to flush a fresh server render. The `lastSyncedRolesRef` + size-zero
  // gate ensures we only re-sync from props when (a) the prop actually
  // changed, AND (b) no parallel toggle is mid-flight - otherwise an
  // earlier action's revalidation could briefly clobber a later
  // as-yet-uncompleted optimistic flip on a different cell.
  const [optimisticRoles, setOptimisticRoles] = useState(roles);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [cellError, setCellError] = useState<CellError | null>(null);
  const lastSyncedRolesRef = useRef(roles);

  useEffect(() => {
    if (lastSyncedRolesRef.current === roles) return;
    if (pending.size > 0) return;
    lastSyncedRolesRef.current = roles;
    setOptimisticRoles(roles);
  }, [roles, pending]);

  // Locally-registered permission keys not yet in the server catalog. The
  // catalog endpoint is read-only by design (registering a key without
  // also granting it is intentionally not supported), so the "Register
  // key" inline input adds a transient column locally; the first cell
  // check persists it via the grant endpoint's auto-register-on-first-
  // grant rule.
  const [localKeys, setLocalKeys] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const newKeyInputId = useId();

  const catalogKeys = useMemo(() => catalog.map((c) => c.key), [catalog]);
  // Drop locally-added keys that have since landed in the catalog, which
  // a successful grant does by auto-registering them. The dedupe also
  // protects against an operator entering a key that was registered by
  // some other path between page loads.
  const allKeys = useMemo(() => {
    const seen = new Set(catalogKeys);
    const merged: string[] = [...catalogKeys];
    for (const k of localKeys) {
      if (!seen.has(k)) {
        merged.push(k);
        seen.add(k);
      }
    }
    return merged;
  }, [catalogKeys, localKeys]);

  function stateOf(roleId: string, permission: string): RoleEntryState {
    const r = optimisticRoles.find((row) => row.id === roleId);
    return r ? roleEntryState(r, permission) : "none";
  }

  // Each click moves a cell one step: no entry -> grant -> deny -> no
  // entry.
  async function toggleCell(roleId: string, permission: string, current: RoleEntryState) {
    const next: RoleEntryState =
      current === "none" ? "grant" : current === "grant" ? "deny" : "none";
    const key = cellKey(roleId, permission);
    setPending((p) => {
      const next = new Set(p);
      next.add(key);
      return next;
    });
    setCellError(null);

    // Optimistic flip on local state only. Server Action result will
    // overwrite this with the authoritative post-state below.
    setOptimisticRoles((rs) =>
      rs.map((r) => {
        if (r.id !== roleId) return r;
        // Cells edit the global entry; contextual entries for the key stay.
        const entries = roleEntries(r).filter(
          (e) => e.permission !== permission || isContextual(e),
        );
        if (next !== "none") entries.push({ permission, value: next === "grant" });
        entries.sort((x, y) => (x.permission < y.permission ? -1 : 1));
        return {
          ...r,
          entries,
          permissions: entries.filter((e) => e.value && !isContextual(e)).map((e) => e.permission),
        };
      }),
    );

    const result =
      next === "grant"
        ? await grantRolePermissionAction(gameId, groupId, roleId, permission)
        : next === "deny"
          ? await denyRolePermissionAction(gameId, groupId, roleId, permission)
          : await revokeRolePermissionAction(gameId, groupId, roleId, permission);

    setPending((p) => {
      const next = new Set(p);
      next.delete(key);
      return next;
    });

    if (!result.ok) {
      // Revert by re-syncing this role from props. The other roles'
      // optimistic state stays intact (they may have other in-flight
      // toggles).
      setOptimisticRoles((rs) =>
        rs.map((r) => {
          if (r.id !== roleId) return r;
          const fromProps = roles.find((p) => p.id === roleId);
          return fromProps ?? r;
        }),
      );
      setCellError({
        roleName: roles.find((r) => r.id === roleId)?.name ?? roleId,
        permission,
        error: result.error ?? "The server gave no reason. Try again.",
      });
      return;
    }

    const updatedRole = result.role;
    if (updatedRole) {
      // Sync the row to the authoritative server post-state. The
      // optimistic flip and the server's post-state should agree, but
      // syncing protects against the rare case where a concurrent admin
      // mutation changed the row between read and write.
      setOptimisticRoles((rs) => rs.map((r) => (r.id === roleId ? updatedRole : r)));
      // If this was a grant for a locally-added key, the server has now
      // registered it in the catalog so we can drop it from localKeys.
      // Next revalidation will include the key in `catalog` natively.
      if (next !== "none") {
        setLocalKeys((ks) => ks.filter((k) => k !== permission));
      }
    }
  }

  function handleRegisterKey(e: React.FormEvent) {
    e.preventDefault();
    setKeyError(null);
    const trimmed = newKey.trim();
    if (trimmed.length === 0) {
      setKeyError("Enter a permission key.");
      return;
    }
    if (trimmed.length > ADMIN_PERMISSION_KEY_MAX_LENGTH) {
      setKeyError(`Shorten the key to ${ADMIN_PERMISSION_KEY_MAX_LENGTH} characters or fewer.`);
      return;
    }
    if (allKeys.includes(trimmed)) {
      setKeyError(`${trimmed} is already a column.`);
      return;
    }
    setLocalKeys((ks) => [...ks, trimmed]);
    setNewKey("");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <form onSubmit={handleRegisterKey} className="flex items-center gap-2">
          <Label htmlFor={newKeyInputId} className="sr-only">
            New permission key
          </Label>
          <Input
            id={newKeyInputId}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="New permission key"
            maxLength={ADMIN_PERMISSION_KEY_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            className="w-full font-mono sm:w-72"
          />
          <Button type="submit" variant="outline">
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add column
          </Button>
        </form>
        <Legend />
      </div>
      {keyError ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {keyError}
        </p>
      ) : null}
      {cellError ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not change <span className="font-mono">{cellError.permission}</span> for{" "}
          {cellError.roleName}: {cellError.error}
        </p>
      ) : null}
      {roles.length === 0 ? (
        <Notice title="No roles yet" body="Create a role on the Roles tab first." />
      ) : allKeys.length === 0 ? (
        <Notice
          title="No permission keys yet"
          body="Add a key above. It is saved to the game the first time you grant it."
        />
      ) : (
        <MatrixTable
          roles={optimisticRoles}
          keys={allKeys}
          catalogKeys={catalogKeys}
          pending={pending}
          stateOf={stateOf}
          onToggle={toggleCell}
        />
      )}
    </div>
  );
}

function Swatch({ className }: { className: string }) {
  return <span aria-hidden className={cn("inline-block h-3 w-3 rounded-sm border", className)} />;
}

// What the cell fills mean. The cells hold each role's own entries;
// inherited and wildcard access is resolved by the permission check.
function Legend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Swatch className="border-allow bg-allow" />
        Granted
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Swatch className="border-destructive bg-destructive" />
        Denied
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Swatch className="border-input bg-background" />
        No entry
      </span>
      <span>Own entries only, not inherited</span>
    </p>
  );
}

interface MatrixTableProps {
  roles: AdminRole[];
  keys: string[];
  catalogKeys: string[];
  pending: Set<string>;
  stateOf: (roleId: string, permission: string) => RoleEntryState;
  onToggle: (roleId: string, permission: string, current: RoleEntryState) => void;
}

const NEXT_ACTION: Record<RoleEntryState, string> = {
  none: "Grant",
  grant: "Deny",
  deny: "Clear the entry for",
};

function MatrixTable({ roles, keys, catalogKeys, pending, stateOf, onToggle }: MatrixTableProps) {
  const byId = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const catalogSet = useMemo(() => new Set(catalogKeys), [catalogKeys]);
  // The sticky role column needs an opaque fill; its row hover is drawn
  // underneath the cell's content so the text is not dimmed.
  const stickyCell = "sticky left-0 z-10 bg-background";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th
              scope="col"
              className={cn(stickyCell, "min-w-[12rem] py-2 pr-4 text-left font-medium")}
            >
              Role
            </th>
            {keys.map((key) => {
              const inCatalog = catalogSet.has(key);
              return (
                <th
                  key={key}
                  scope="col"
                  className="min-w-[7rem] px-3 py-2 text-center font-medium"
                  title={key}
                >
                  <div className="flex flex-col items-center gap-1">
                    <span className="max-w-[12rem] truncate font-mono text-foreground">{key}</span>
                    {inCatalog ? null : (
                      <Badge variant="outline" className="w-fit text-xs font-normal">
                        Local
                      </Badge>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.id} className="group border-b border-border/60 hover:bg-accent/40">
              <th
                scope="row"
                className={cn(
                  stickyCell,
                  "py-2.5 pr-4 text-left align-top font-normal",
                  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:bg-accent/40 before:opacity-0 group-hover:before:opacity-100",
                )}
              >
                <div className="flex flex-col items-start gap-1">
                  <RoleChip name={role.name} color={role.color} />
                  <span className="text-xs tabular-nums text-muted-foreground">
                    priority {role.priority}
                  </span>
                  {role.parents && role.parents.length > 0 ? (
                    <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      inherits
                      {role.parents.map((p) => {
                        const parent = byId.get(p);
                        return <RoleChip key={p} name={parent?.name ?? p} color={parent?.color} />;
                      })}
                    </span>
                  ) : null}
                </div>
              </th>
              {keys.map((key) => {
                const state = stateOf(role.id, key);
                const isPending = pending.has(cellKey(role.id, key));
                return (
                  <td key={key} className="px-3 py-2.5 text-center align-top">
                    <MatrixCell
                      state={state}
                      pending={isPending}
                      onToggle={() => onToggle(role.id, key, state)}
                      ariaLabel={`${key} for ${role.name}: ${state === "none" ? "no entry" : state === "grant" ? "granted" : "denied"}. ${NEXT_ACTION[state]} ${key} for ${role.name}.`}
                    />
                    <ContextEntries entries={roleContextEntries(role, key)} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Read-only list of a cell's contextual entries.
function ContextEntries({ entries }: { entries: AdminPermissionEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col items-center gap-1">
      {entries.map((e) => (
        <Badge
          key={permissionEntryId(e)}
          variant={e.value ? "outline" : "destructive"}
          className="w-fit font-mono text-[10px]"
          title={`${e.value ? "granted" : "denied"} in ${formatPermissionContext(e.context)}`}
        >
          {e.value ? "" : "deny "}
          {formatPermissionContext(e.context)}
        </Badge>
      ))}
    </div>
  );
}

interface MatrixCellProps {
  state: RoleEntryState;
  pending: boolean;
  onToggle: () => void;
  ariaLabel: string;
}

// A button rather than a checkbox: a cell has three states. The pending
// spinner sits over the button so the focus ring keeps its place.
function MatrixCell({ state, pending, onToggle, ariaLabel }: MatrixCellProps) {
  return (
    <span className="relative inline-flex h-6 w-6 items-center justify-center">
      <button
        type="button"
        onClick={onToggle}
        disabled={pending}
        aria-label={ariaLabel}
        title={state === "none" ? "no entry" : state === "grant" ? "granted" : "denied"}
        className={cn(
          "h-5 w-5 cursor-pointer rounded border transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          state === "grant" && "border-allow bg-allow hover:bg-allow/90",
          state === "deny" && "border-destructive bg-destructive hover:bg-destructive/90",
          state === "none" && "border-input bg-background hover:bg-accent",
          pending && "cursor-wait opacity-60",
        )}
      />
      {pending ? (
        <Loader2
          className="pointer-events-none absolute h-3 w-3 animate-spin text-muted-foreground"
          aria-hidden
        />
      ) : state === "grant" ? (
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="pointer-events-none absolute h-3 w-3 text-background"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <title>granted</title>
          <path d="M2.5 6.5L5 9l4.5-5" />
        </svg>
      ) : state === "deny" ? (
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="pointer-events-none absolute h-3 w-3 text-destructive-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <title>denied</title>
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      ) : null}
    </span>
  );
}
