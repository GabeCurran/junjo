// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { ShieldCheck } from "lucide-react";

import type { AdminRole } from "../../lib/admin-shared";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { CreateRoleDialog } from "./create-role-dialog";
import { DeleteRoleDialog } from "./delete-role-dialog";
import { EditRoleDialog } from "./edit-role-dialog";

interface RolesTableProps {
  roles: AdminRole[];
  gameId: string;
  groupId: string;
}

const numberFormatter = new Intl.NumberFormat("en-US");

// Hand-rolled HTML table (no TanStack) because the role list is server-
// sorted by priority desc + has no client-side filter / pagination /
// column-toggle requirements. The members table needs TanStack for the
// 350ms-debounced search + URL-state-driven pagination; the roles table
// has neither, so the simpler primitive wins. Phase 11.6c (Permissions
// matrix) will reach for a 2D grid that is a different shape entirely
// (rows = roles, cols = permission keys) so introducing TanStack here for
// the sake of consistency would not pay off.

export function RolesTable({ roles, gameId, groupId }: RolesTableProps) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:space-y-1.5">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Roles</CardTitle>
          <CardDescription>
            Roles defined for this group, ordered by priority (highest first). Higher priority wins
            tiebreaks when a member has multiple roles. {numberFormatter.format(roles.length)}{" "}
            {roles.length === 1 ? "role" : "roles"} total.
          </CardDescription>
        </div>
        <CreateRoleDialog gameId={gameId} groupId={groupId} />
      </CardHeader>
      <CardContent>
        {roles.length === 0 ? (
          <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-10 text-center">
            <ShieldCheck className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">No roles yet</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Add a role to start granting permissions. Roles assigned to members appear in their
              row in the Members tab.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4 text-left font-medium">Name</th>
                  <th className="py-2 pr-4 text-left font-medium">Priority</th>
                  <th className="py-2 pr-4 text-left font-medium">Color</th>
                  <th className="py-2 pr-4 text-left font-medium">Default</th>
                  <th className="py-2 pr-4 text-left font-medium">Permissions</th>
                  <th className="py-2 pr-4 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{role.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{role.id}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 font-mono tabular-nums text-sm">
                      {numberFormatter.format(role.priority)}
                    </td>
                    <td className="py-3 pr-4">
                      {role.color ? (
                        <span className="inline-flex items-center gap-2 text-xs">
                          <span
                            aria-hidden
                            className="inline-block h-4 w-4 rounded border border-border"
                            style={{ backgroundColor: role.color }}
                          />
                          <span className="font-mono text-muted-foreground">{role.color}</span>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">no color</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {role.isDefault ? (
                        <Badge variant="secondary">Default</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {role.permissions.length === 0 ? (
                        <span className="text-xs text-muted-foreground">no permissions</span>
                      ) : (
                        <div className="flex max-w-md flex-wrap gap-1">
                          {role.permissions.map((p) => (
                            <Badge key={p} variant="muted" className="font-mono text-xs">
                              {p}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <EditRoleDialog gameId={gameId} groupId={groupId} role={role} />
                        <DeleteRoleDialog gameId={gameId} groupId={groupId} role={role} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
