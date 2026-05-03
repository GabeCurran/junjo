// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { ListChecks, ShieldOff, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  clearMemberPermissionOverrideAction,
  listMemberPermissionOverridesAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import type { AdminMemberPermissionOverride } from "../../lib/admin-shared";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

interface ViewPermissionOverridesDialogProps {
  gameId: string;
  groupId: string;
  userId: string;
  externalUserId: string;
}

interface DialogData {
  status: "idle" | "loading" | "loaded" | "error";
  overrides: AdminMemberPermissionOverride[];
  error?: string;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function ViewPermissionOverridesDialog({
  gameId,
  groupId,
  userId,
  externalUserId,
}: ViewPermissionOverridesDialogProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DialogData>({ status: "idle", overrides: [] });
  // Per-row clearing state. Keyed by permission so multiple in-flight clears
  // don't fight over a single boolean.
  const [clearing, setClearing] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<{ permission: string; error: string } | null>(null);

  const refetch = useCallback(async () => {
    setData((d) => ({ ...d, status: "loading" }));
    const result = await listMemberPermissionOverridesAction(gameId, groupId, userId);
    if (result.ok) {
      setData({ status: "loaded", overrides: result.overrides ?? [] });
    } else {
      setData({
        status: "error",
        overrides: [],
        error: result.error ?? "could not load overrides",
      });
    }
  }, [gameId, groupId, userId]);

  // Fetch on open; reset on close so a subsequent re-open shows a fresh
  // skeleton rather than the previous (potentially stale) snapshot.
  useEffect(() => {
    if (open) {
      void refetch();
    } else {
      setData({ status: "idle", overrides: [] });
      setRowError(null);
      setClearing({});
    }
  }, [open, refetch]);

  async function handleClear(permission: string) {
    setClearing((c) => ({ ...c, [permission]: true }));
    setRowError(null);
    const result = await clearMemberPermissionOverrideAction(gameId, groupId, userId, permission);
    setClearing((c) => {
      const next = { ...c };
      delete next[permission];
      return next;
    });
    if (result.ok) {
      await refetch();
    } else {
      setRowError({ permission, error: result.error ?? "could not clear override" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <ListChecks className="h-3.5 w-3.5" aria-hidden />
          Overrides
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Permission overrides</DialogTitle>
          <DialogDescription>
            Member-level overrides for <span className="font-mono">{externalUserId}</span>. Clearing
            an override falls back to the role-derived default; the override row is hard-deleted but
            the permission key stays in this game's catalog for reuse.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-[120px]">
          {data.status === "idle" || data.status === "loading" ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-md border border-border bg-card/50 px-3 py-2"
                >
                  <div className="h-4 w-1/2 rounded bg-muted" />
                  <div className="h-6 w-16 rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : null}
          {data.status === "error" ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {data.error}
            </div>
          ) : null}
          {data.status === "loaded" && data.overrides.length === 0 ? (
            <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-8 text-center">
              <ShieldOff className="h-7 w-7 text-muted-foreground" aria-hidden />
              <p className="mt-2 text-sm font-medium">No overrides set</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                This member resolves permissions purely from their assigned roles. Use the Override
                action on the row to grant or revoke a single permission.
              </p>
            </div>
          ) : null}
          {data.status === "loaded" && data.overrides.length > 0 ? (
            <ul className="space-y-2">
              {data.overrides.map((o) => (
                <li
                  key={o.permission}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 px-3 py-2"
                >
                  <div className="flex flex-col gap-1 overflow-hidden">
                    <span className="truncate font-mono text-sm" title={o.permission}>
                      {o.permission}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Set {dateFormatter.format(new Date(o.setAt))}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={o.grant ? "secondary" : "destructive"}>
                      {o.grant ? "Grant" : "Revoke"}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleClear(o.permission)}
                      disabled={Boolean(clearing[o.permission])}
                      aria-label={`Clear override for ${o.permission}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {clearing[o.permission] ? "Clearing..." : "Clear"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {rowError ? (
            <div className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Could not clear <span className="font-mono">{rowError.permission}</span>:{" "}
              {rowError.error}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
