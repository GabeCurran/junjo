// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Plus } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  type CreateRoleResult,
  createRoleAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import { ADMIN_ROLE_NAME_MAX_LENGTH } from "../../lib/admin-shared";
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
          Create role
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create role</DialogTitle>
          <DialogDescription>
            Higher priority wins when a member's roles disagree.
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
              Unique in this group, up to {ADMIN_ROLE_NAME_MAX_LENGTH} characters.
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
            <p className="text-xs text-muted-foreground">A whole number. Higher wins ties.</p>
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
              A six-digit hex color. The role shows in it everywhere. Leave blank for none.
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
