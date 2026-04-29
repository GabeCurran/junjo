// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { UserMinus } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  type KickMemberResult,
  kickMemberAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import { ADMIN_MEMBER_KICK_REASON_MAX_LENGTH } from "../../lib/admin";
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
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

interface KickMemberDialogProps {
  gameId: string;
  groupId: string;
  userId: string;
  externalUserId: string;
  status: string;
}

const INITIAL_STATE: KickMemberResult = { ok: false };

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? "Kicking..." : "Kick member"}
    </Button>
  );
}

export function KickMemberDialog({
  gameId,
  groupId,
  userId,
  externalUserId,
  status,
}: KickMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(kickMemberAction, INITIAL_STATE);
  const reasonId = useId();
  const isActive = status === "active";

  // The kick endpoint is idempotent on non-active members (the server returns
  // the unchanged row with no audit entry). We still close the dialog and
  // refresh in that case so the dashboard's TanStack Table re-fetches; an
  // operator who clicked Kick on an already-kicked member sees the action
  // succeed without a confusing intermediate state.
  useEffect(() => {
    if (state.ok && state.member) {
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <UserMinus className="h-3.5 w-3.5" aria-hidden />
          Kick
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Kick member</DialogTitle>
          <DialogDescription>
            Remove <span className="font-mono">{externalUserId}</span> from this group. Roles are
            preserved on the row so the audit log retains the membership history; the member can
            rejoin via a fresh invitation later.
          </DialogDescription>
        </DialogHeader>
        {!isActive ? (
          <p className="text-sm text-muted-foreground">
            This member is already <span className="font-medium">{status}</span>. The kick is
            idempotent; clicking through will leave the row in its current state.
          </p>
        ) : null}
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="userId" value={userId} />
          <div className="space-y-2">
            <Label htmlFor={reasonId}>Reason (optional)</Label>
            <Textarea
              id={reasonId}
              name="reason"
              placeholder="Explain why this member is being kicked..."
              maxLength={ADMIN_MEMBER_KICK_REASON_MAX_LENGTH}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              Up to {ADMIN_MEMBER_KICK_REASON_MAX_LENGTH} characters. Stored on the audit entry's
              payload and visible to anyone with audit access.
            </p>
          </div>
          {state.error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <ConfirmButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
