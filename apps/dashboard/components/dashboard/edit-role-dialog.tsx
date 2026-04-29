// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Pencil } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";

import {
  type UpdateRoleResult,
  updateRoleAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import { ADMIN_ROLE_NAME_MAX_LENGTH, type AdminRole } from "../../lib/admin";
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

interface EditRoleDialogProps {
  gameId: string;
  groupId: string;
  role: AdminRole;
}

const INITIAL_STATE: UpdateRoleResult = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Save changes"}
    </Button>
  );
}

export function EditRoleDialog({ gameId, groupId, role }: EditRoleDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(updateRoleAction, INITIAL_STATE);
  const nameId = useId();
  const priorityId = useId();
  const colorId = useId();
  const isDefaultId = useId();

  useEffect(() => {
    if (state.ok && state.role) {
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit role</DialogTitle>
          <DialogDescription>
            Update <span className="font-mono">{role.name}</span>. Only changed fields land in the
            audit log; supplying a value that matches the stored row is a no-op server-side.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="roleId" value={role.id} />
          <div className="space-y-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              name="name"
              required
              defaultValue={role.name}
              maxLength={ADMIN_ROLE_NAME_MAX_LENGTH}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={priorityId}>Priority</Label>
            <Input
              id={priorityId}
              name="priority"
              type="number"
              required
              defaultValue={role.priority}
              step={1}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={colorId}>Color (optional)</Label>
            <Input
              id={colorId}
              name="color"
              type="text"
              defaultValue={role.color ?? ""}
              placeholder="#6366f1"
              autoComplete="off"
              pattern="^#[0-9a-fA-F]{6}$"
            />
            <p className="text-xs text-muted-foreground">
              Hex value like <code>#6366f1</code>. Clear the field to remove the role's color.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              id={isDefaultId}
              name="isDefault"
              type="checkbox"
              value="true"
              defaultChecked={role.isDefault}
              className="h-4 w-4 rounded border border-input"
            />
            <Label htmlFor={isDefaultId} className="text-sm font-normal">
              Mark as default role
            </Label>
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
            <SubmitButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
