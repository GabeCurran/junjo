// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Pencil } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  type UpdateMemberNotesResult,
  updateMemberNotesAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import { ADMIN_MEMBER_NOTES_MAX_LENGTH } from "../../lib/admin-shared";
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

interface EditMemberNotesDialogProps {
  gameId: string;
  groupId: string;
  userId: string;
  externalUserId: string;
  notesPublic: string | null;
  notesPrivate: string | null;
}

const INITIAL_STATE: UpdateMemberNotesResult = { ok: false };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Save notes"}
    </Button>
  );
}

export function EditMemberNotesDialog({
  gameId,
  groupId,
  userId,
  externalUserId,
  notesPublic,
  notesPrivate,
}: EditMemberNotesDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(updateMemberNotesAction, INITIAL_STATE);
  const publicId = useId();
  const privateId = useId();

  useEffect(() => {
    if (state.ok && state.member) {
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          Notes
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit member notes</DialogTitle>
          <DialogDescription>
            Public and private operator notes for{" "}
            <span className="font-mono">{externalUserId}</span>. Public notes show up in the members
            table preview; private notes are only visible to operators with admin access. Empty
            either field to clear it.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="userId" value={userId} />
          <div className="space-y-2">
            <Label htmlFor={publicId}>Public note</Label>
            <Textarea
              id={publicId}
              name="notesPublic"
              defaultValue={notesPublic ?? ""}
              maxLength={ADMIN_MEMBER_NOTES_MAX_LENGTH}
              rows={3}
              placeholder="Visible to other operators in the members table"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={privateId}>Private note</Label>
            <Textarea
              id={privateId}
              name="notesPrivate"
              defaultValue={notesPrivate ?? ""}
              maxLength={ADMIN_MEMBER_NOTES_MAX_LENGTH}
              rows={3}
              placeholder="Operator-only context, not surfaced in the table"
            />
            <p className="text-xs text-muted-foreground">
              Up to {ADMIN_MEMBER_NOTES_MAX_LENGTH} characters per field. The server normalizes
              empty input to `null` so cleared notes do not linger as empty strings.
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
            <SaveButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
