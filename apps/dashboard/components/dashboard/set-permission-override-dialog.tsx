// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";

import {
  type SetPermissionOverrideResult,
  setPermissionOverrideAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import { ADMIN_PERMISSION_KEY_MAX_LENGTH } from "../../lib/admin";
import { cn } from "../../lib/utils";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface SetPermissionOverrideDialogProps {
  gameId: string;
  groupId: string;
  userId: string;
  externalUserId: string;
}

const INITIAL_STATE: SetPermissionOverrideResult = { ok: false };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Save override"}
    </Button>
  );
}

export function SetPermissionOverrideDialog({
  gameId,
  groupId,
  userId,
  externalUserId,
}: SetPermissionOverrideDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(setPermissionOverrideAction, INITIAL_STATE);
  const permissionId = useId();
  const grantId = useId();
  const revokeId = useId();

  useEffect(() => {
    if (state.ok && state.override) {
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Override
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set permission override</DialogTitle>
          <DialogDescription>
            Grant or revoke a single permission for{" "}
            <span className="font-mono">{externalUserId}</span> in this group. Member-level
            overrides beat role-derived defaults; revoke wins over a role-granted permission and
            grant wins over a missing-from-role baseline.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="userId" value={userId} />
          <div className="space-y-2">
            <Label htmlFor={permissionId}>Permission key</Label>
            <Input
              id={permissionId}
              name="permission"
              required
              maxLength={ADMIN_PERMISSION_KEY_MAX_LENGTH}
              placeholder="guild.invite_member"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              1-{ADMIN_PERMISSION_KEY_MAX_LENGTH} characters. New keys auto-register into this
              game's catalog on first use; clearing the override later preserves the catalog row.
            </p>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Override action</legend>
            <div className="grid gap-2">
              <label
                htmlFor={grantId}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border border-input bg-background px-3 py-2",
                  "transition-colors hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <input
                  id={grantId}
                  type="radio"
                  name="grant"
                  value="true"
                  defaultChecked
                  className="mt-1"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Grant</span>
                  <span className="text-xs text-muted-foreground">
                    Allow this permission for this member, even if no role grants it.
                  </span>
                </span>
              </label>
              <label
                htmlFor={revokeId}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border border-input bg-background px-3 py-2",
                  "transition-colors hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <input id={revokeId} type="radio" name="grant" value="false" className="mt-1" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Revoke</span>
                  <span className="text-xs text-muted-foreground">
                    Deny this permission for this member, even if a role would grant it.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
          {state.error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SaveButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
