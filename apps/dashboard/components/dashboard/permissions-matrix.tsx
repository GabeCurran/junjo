// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { AlertCircle, Key, Loader2, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  grantRolePermissionAction,
  revokeRolePermissionAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import {
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  type AdminPermissionDef,
  type AdminRole,
} from "../../lib/admin-shared";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

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

const numberFormatter = new Intl.NumberFormat("en-US");

// Compose the pending-cell state key. Same convention as the row dialogs
// in `view-permission-overrides-dialog.tsx`.
function cellKey(roleId: string, permission: string): string {
  return `${roleId}::${permission}`;
}

interface CellError {
  roleId: string;
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
  // Drop locally-added keys that have since landed in the catalog (e.g.
  // after a successful grant that auto-registered them). The dedupe also
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

  function isGranted(roleId: string, permission: string): boolean {
    const r = optimisticRoles.find((row) => row.id === roleId);
    return Boolean(r?.permissions.includes(permission));
  }

  async function toggleCell(roleId: string, permission: string, currentlyGranted: boolean) {
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
        if (currentlyGranted) {
          return { ...r, permissions: r.permissions.filter((p) => p !== permission) };
        }
        const next = [...r.permissions, permission].sort();
        return { ...r, permissions: next };
      }),
    );

    const result = currentlyGranted
      ? await revokeRolePermissionAction(gameId, groupId, roleId, permission)
      : await grantRolePermissionAction(gameId, groupId, roleId, permission);

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
      setCellError({ roleId, permission, error: result.error ?? "could not toggle permission" });
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
      if (!currentlyGranted) {
        setLocalKeys((ks) => ks.filter((k) => k !== permission));
      }
    }
  }

  function handleRegisterKey(e: React.FormEvent) {
    e.preventDefault();
    setKeyError(null);
    const trimmed = newKey.trim();
    if (trimmed.length === 0) {
      setKeyError("permission key is required");
      return;
    }
    if (trimmed.length > ADMIN_PERMISSION_KEY_MAX_LENGTH) {
      setKeyError(`permission key must be at most ${ADMIN_PERMISSION_KEY_MAX_LENGTH} characters`);
      return;
    }
    if (allKeys.includes(trimmed)) {
      setKeyError("that key already exists in the matrix");
      return;
    }
    setLocalKeys((ks) => [...ks, trimmed]);
    setNewKey("");
  }

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-base">Permissions matrix</CardTitle>
        <CardDescription>
          Each cell grants or revokes a permission for a role. Toggling a checkbox is a one-click
          action; the first grant of a never-before-seen key registers it into this game's catalog
          automatically. {numberFormatter.format(roles.length)}{" "}
          {roles.length === 1 ? "role" : "roles"} x {numberFormatter.format(allKeys.length)}{" "}
          {allKeys.length === 1 ? "key" : "keys"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleRegisterKey} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={newKeyInputId}>Register a new permission key</Label>
            <Input
              id={newKeyInputId}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="guild.invite_member"
              maxLength={ADMIN_PERMISSION_KEY_MAX_LENGTH}
              autoComplete="off"
              className="font-mono text-sm"
            />
          </div>
          <Button type="submit" variant="secondary">
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add column
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          New keys appear as a column locally. The key persists into the per-game catalog the first
          time you grant it to a role; until then it lives only in your browser.
        </p>
        {keyError ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {keyError}
          </div>
        ) : null}
        {cellError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="flex-1">
              <p className="font-medium">Could not toggle permission</p>
              <p className="text-xs">
                role <span className="font-mono">{cellError.roleId}</span> /{" "}
                <span className="font-mono">{cellError.permission}</span>: {cellError.error}
              </p>
            </div>
          </div>
        ) : null}
        {roles.length === 0 ? (
          <EmptyState
            title="No roles yet"
            body="Add at least one role in the Roles tab before granting permissions. The matrix needs both rows (roles) and columns (permission keys)."
          />
        ) : allKeys.length === 0 ? (
          <EmptyState
            title="No permission keys yet"
            body="Register your first permission key above. Common patterns: 'guild.invite_member', 'raid.start', 'vault.withdraw'."
          />
        ) : (
          <MatrixTable
            roles={optimisticRoles}
            keys={allKeys}
            catalogKeys={catalogKeys}
            pending={pending}
            isGranted={isGranted}
            onToggle={toggleCell}
          />
        )}
      </CardContent>
    </Card>
  );
}

interface EmptyStateProps {
  title: string;
  body: string;
}

function EmptyState({ title, body }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-10 text-center">
      <Key className="h-8 w-8 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

interface MatrixTableProps {
  roles: AdminRole[];
  keys: string[];
  catalogKeys: string[];
  pending: Set<string>;
  isGranted: (roleId: string, permission: string) => boolean;
  onToggle: (roleId: string, permission: string, currentlyGranted: boolean) => void;
}

function MatrixTable({ roles, keys, catalogKeys, pending, isGranted, onToggle }: MatrixTableProps) {
  const catalogSet = useMemo(() => new Set(catalogKeys), [catalogKeys]);
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th
              scope="col"
              className="sticky left-0 z-10 min-w-[12rem] bg-muted/40 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Role
            </th>
            {keys.map((key) => {
              const inCatalog = catalogSet.has(key);
              return (
                <th
                  key={key}
                  scope="col"
                  className="min-w-[8rem] border-l border-border px-3 py-2 text-left text-xs font-medium"
                  title={key}
                >
                  <div className="flex flex-col gap-1">
                    <span className="truncate font-mono text-xs text-foreground">{key}</span>
                    {inCatalog ? null : (
                      <Badge variant="outline" className="w-fit text-[10px] uppercase">
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
            <tr key={role.id} className="border-b border-border last:border-0">
              <th
                scope="row"
                className="sticky left-0 z-10 bg-background px-3 py-3 text-left align-top"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {role.color ? (
                      <span
                        aria-hidden
                        className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
                        style={{ backgroundColor: role.color }}
                      />
                    ) : null}
                    <span className="text-sm font-medium">{role.name}</span>
                  </div>
                  <span className="font-mono tabular-nums text-xs text-muted-foreground">
                    priority {role.priority}
                  </span>
                </div>
              </th>
              {keys.map((key) => {
                const granted = isGranted(role.id, key);
                const isPending = pending.has(cellKey(role.id, key));
                return (
                  <td key={key} className="border-l border-border px-3 py-3 align-top">
                    <MatrixCell
                      granted={granted}
                      pending={isPending}
                      onToggle={() => onToggle(role.id, key, granted)}
                      ariaLabel={`${granted ? "Revoke" : "Grant"} ${key} for ${role.name}`}
                    />
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

interface MatrixCellProps {
  granted: boolean;
  pending: boolean;
  onToggle: () => void;
  ariaLabel: string;
}

// Native `<input type="checkbox">` for semantics + free keyboard-navigation
// support. The pending overlay ships as a sibling icon positioned over the
// checkbox; we keep the checkbox in the DOM (just disabled) so the focus
// ring keeps its place.
function MatrixCell({ granted, pending, onToggle, ariaLabel }: MatrixCellProps) {
  return (
    <label
      className={cn(
        "relative inline-flex h-6 w-6 cursor-pointer items-center justify-center",
        pending && "cursor-wait",
      )}
    >
      <input
        type="checkbox"
        checked={granted}
        disabled={pending}
        onChange={onToggle}
        aria-label={ariaLabel}
        className={cn(
          "h-5 w-5 cursor-pointer appearance-none rounded border transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          granted
            ? "border-primary bg-primary hover:bg-primary/90"
            : "border-input bg-background hover:bg-accent",
          pending && "cursor-wait opacity-60",
        )}
      />
      {pending ? (
        <Loader2
          className="pointer-events-none absolute h-3 w-3 animate-spin text-muted-foreground"
          aria-hidden
        />
      ) : granted ? (
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="pointer-events-none absolute h-3 w-3 text-primary-foreground"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <title>granted</title>
          <path d="M2.5 6.5L5 9l4.5-5" />
        </svg>
      ) : null}
    </label>
  );
}
