// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Trash2 } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  type DeleteRoleResult,
  deleteRoleAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import type { AdminRole } from "../../lib/admin-shared";
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

interface DeleteRoleDialogProps {
  gameId: string;
  groupId: string;
  role: AdminRole;
}

const INITIAL_STATE: DeleteRoleResult = { ok: false };

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? "Deleting..." : "Delete role"}
    </Button>
  );
}

export function DeleteRoleDialog({ gameId, groupId, role }: DeleteRoleDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(deleteRoleAction, INITIAL_STATE);

  useEffect(() => {
    if (state.ok && state.roleId) {
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete role</DialogTitle>
          <DialogDescription>
            Deletes <span className="font-medium text-foreground">{role.name}</span> and its
            permission entries. Move its members to another role first; the server refuses to delete
            a role that is still assigned.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="roleId" value={role.id} />
          <p className="text-sm font-medium text-destructive">
            This cannot be undone. The audit log keeps past assignments.
          </p>
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
