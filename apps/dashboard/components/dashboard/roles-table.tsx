// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import {
  type AdminRole,
  formatPermissionContext,
  isContextual,
  permissionEntryId,
  roleAffix,
  roleEntries,
} from "../../lib/admin-shared";
import { Badge } from "../ui/badge";
import { RoleChip } from "../ui/role-chip";
import { Notice } from "../ui/section";
import { CreateRoleDialog } from "./create-role-dialog";
import { DeleteRoleDialog } from "./delete-role-dialog";
import { EditRoleDialog } from "./edit-role-dialog";

interface RolesTableProps {
  roles: AdminRole[];
  gameId: string;
  groupId: string;
}

const numberFormatter = new Intl.NumberFormat("en-US");

// Hand-rolled HTML table (no TanStack): the role list arrives sorted by
// priority and has no client-side filter, pagination or column toggles.

export function RolesTable({ roles, gameId, groupId }: RolesTableProps) {
  const byId = new Map(roles.map((r) => [r.id, r]));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {numberFormatter.format(roles.length)} {roles.length === 1 ? "role" : "roles"}, highest
          priority first
        </p>
        <CreateRoleDialog gameId={gameId} groupId={groupId} />
      </div>
      {roles.length === 0 ? (
        <Notice title="No roles yet" body="Create one to start granting permissions." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="py-2 pr-4 text-left font-medium">Role</th>
                <th className="py-2 pr-4 text-right font-medium">Priority</th>
                <th className="py-2 pr-4 text-left font-medium">Default</th>
                <th className="py-2 pr-4 text-left font-medium">Entries</th>
                <th className="py-2 pr-4 text-left font-medium">Inherits from</th>
                <th className="py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const entries = roleEntries(role);
                return (
                  <tr key={role.id} className="border-b border-border/60 hover:bg-accent/40">
                    <td className="py-2.5 pr-4 align-top">
                      <div className="flex flex-col items-start gap-1">
                        <RoleChip name={role.name} color={role.color} />
                        <span className="font-mono text-xs text-muted-foreground">{role.id}</span>
                        {roleAffix(role, "prefix") || roleAffix(role, "suffix") ? (
                          <span className="text-xs text-muted-foreground">
                            <span className="font-mono text-foreground">
                              {roleAffix(role, "prefix")}
                            </span>
                            name
                            <span className="font-mono text-foreground">
                              {roleAffix(role, "suffix")}
                            </span>
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-right align-top tabular-nums">
                      {numberFormatter.format(role.priority)}
                    </td>
                    <td className="py-2.5 pr-4 align-top">
                      {role.isDefault ? (
                        "Default"
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 align-top">
                      {entries.length === 0 ? (
                        <span className="text-muted-foreground">-</span>
                      ) : (
                        <div className="flex max-w-md flex-wrap gap-1">
                          {entries.map((e) => {
                            const where = isContextual(e) ? formatPermissionContext(e.context) : "";
                            return e.value ? (
                              <Badge
                                key={permissionEntryId(e)}
                                variant="muted"
                                className="font-mono text-xs"
                                title={where ? `granted in ${where}` : undefined}
                              >
                                {e.permission}
                                {where ? ` (${where})` : null}
                              </Badge>
                            ) : (
                              <Badge
                                key={permissionEntryId(e)}
                                variant="destructive"
                                className="font-mono text-xs"
                                title={where ? `denied in ${where}` : "denied"}
                              >
                                deny {e.permission}
                                {where ? ` (${where})` : null}
                              </Badge>
                            );
                          })}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 align-top">
                      {role.parents && role.parents.length > 0 ? (
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {role.parents.map((p) => {
                            const parent = byId.get(p);
                            return (
                              <RoleChip key={p} name={parent?.name ?? p} color={parent?.color} />
                            );
                          })}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-2.5 align-top">
                      <div className="flex items-center justify-end gap-1">
                        <EditRoleDialog gameId={gameId} groupId={groupId} role={role} />
                        <DeleteRoleDialog gameId={gameId} groupId={groupId} role={role} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
