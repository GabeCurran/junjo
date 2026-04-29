// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Plus } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  type CreateRoleResult,
  createRoleAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import { ADMIN_ROLE_NAME_MAX_LENGTH } from "../../lib/admin";
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

interface CreateRoleDialogProps {
  gameId: string;
  groupId: string;
}

const INITIAL_STATE: CreateRoleResult = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create role"}
    </Button>
  );
}

export function CreateRoleDialog({ gameId, groupId }: CreateRoleDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createRoleAction, INITIAL_STATE);
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
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add role
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create role</DialogTitle>
          <DialogDescription>
            Roles group permissions and can be assigned to members. Higher priority wins when
            resolving conflicts; the optional color is a visual hint in the members table.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <div className="space-y-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              name="name"
              required
              maxLength={ADMIN_ROLE_NAME_MAX_LENGTH}
              placeholder="Officer"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Up to {ADMIN_ROLE_NAME_MAX_LENGTH} characters. Must be unique within this group.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={priorityId}>Priority</Label>
            <Input
              id={priorityId}
              name="priority"
              type="number"
              required
              defaultValue={0}
              step={1}
            />
            <p className="text-xs text-muted-foreground">
              Integer. Higher values win priority tiebreaks; common values: 0 (member), 50
              (officer), 100 (leader).
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={colorId}>Color (optional)</Label>
            <Input
              id={colorId}
              name="color"
              type="text"
              placeholder="#6366f1"
              autoComplete="off"
              pattern="^#[0-9a-fA-F]{6}$"
            />
            <p className="text-xs text-muted-foreground">
              Hex value like <code>#6366f1</code>. Surfaces as a dot next to the role name in the
              members table. Leave blank for no color.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              id={isDefaultId}
              name="isDefault"
              type="checkbox"
              value="true"
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
