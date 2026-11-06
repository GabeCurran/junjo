// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Link2, Loader2, Pencil, Trash2 } from "lucide-react";
import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import {
  type ClearRelationshipResult,
  type SetRelationshipResult,
  clearRelationshipAction,
  setRelationshipAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import {
  ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH,
  type AdminGroupRelationship,
} from "../../lib/admin-shared";
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
import { Notice } from "../ui/section";

interface RelationshipsTableProps {
  relationships: AdminGroupRelationship[];
  gameId: string;
  groupId: string;
}

const numberFormatter = new Intl.NumberFormat("en-US");
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

// Hand-rolled HTML table (no TanStack) because the relationships list is
// server-sorted by `groupBId` ascending and has no client-side filter /
// pagination / column-toggle requirements. Small lists with a simple
// shape get plain `<table>` markup; the members table reaches for
// TanStack only because it needs debounced search + URL-state pagination.
//
// V1 limitation: the table renders one row per outgoing direction
// (A->B). The server's `GET .../relationships` endpoint returns the
// A-side rows only; the per-game route documents B-side ("incoming") as
// a future `?direction=incoming` filter, and the admin endpoint mirrors
// that contract verbatim. A "mutual" relationship therefore renders as
// two rows when the operator viewing it is on the A-side and walks to
// B's detail page. The dialog's `mutual` checkbox writes both directions
// in one call.

const INITIAL_SET_STATE: SetRelationshipResult = { ok: false };

interface SetRelationshipDialogProps {
  gameId: string;
  groupId: string;
  // Pre-fill values when editing an existing row. When undefined, the
  // dialog renders the create form.
  existing?: AdminGroupRelationship;
  // The trigger element the parent renders inside the `<DialogTrigger>`.
  // Distinct shapes for "Add relationship" (header button) vs per-row
  // "Edit" (smaller icon button) so the consumer controls the affordance.
  trigger: React.ReactNode;
}

function SetRelationshipSubmitButton({ isEdit }: { isEdit: boolean }) {
  const { pending } = useFormStatus();
  const label = isEdit ? "Save relationship" : "Set relationship";
  const pendingLabel = isEdit ? "Saving..." : "Setting...";
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

// Form-driven dialog. PUT semantics on the underlying endpoint cover
// both create-new (no row at the directed key) and edit-type-of-existing
// (different `type` value bumps `since`); the dialog reuses the same
// form for both because the body shape is identical. The `mutual`
// checkbox is only meaningful on create today - editing the type of an
// already-mutual pair from the A-side does not flip the B-side type
// unless the operator re-checks the box (matches the per-game route's
// contract that each direction is independent).
function SetRelationshipDialog({ gameId, groupId, existing, trigger }: SetRelationshipDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(setRelationshipAction, INITIAL_SET_STATE);
  const groupBIdInputId = useId();
  const typeInputId = useId();
  const mutualInputId = useId();

  useEffect(() => {
    if (state.ok && state.relationship) {
      setOpen(false);
    }
  }, [state]);

  const isEdit = existing !== undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit relationship" : "Set relationship"}</DialogTitle>
          <DialogDescription>
            A directed link from this group to another group in the same game.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <div className="space-y-2">
            <Label htmlFor={groupBIdInputId}>Other group id</Label>
            <Input
              id={groupBIdInputId}
              name="groupBId"
              required
              autoComplete="off"
              defaultValue={existing?.groupBId ?? ""}
              readOnly={isEdit}
              placeholder="grp_..."
              className="font-mono"
            />
            {isEdit ? (
              <p className="text-xs text-muted-foreground">
                To point at a different group, clear this relationship and set a new one.
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor={typeInputId}>Type</Label>
            <Input
              id={typeInputId}
              name="type"
              required
              maxLength={ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH}
              autoComplete="off"
              defaultValue={existing?.type ?? ""}
              placeholder="ally"
            />
            <p className="text-xs text-muted-foreground">
              Up to {ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH} characters.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              id={mutualInputId}
              name="mutual"
              type="checkbox"
              value="true"
              className="h-4 w-4 rounded border border-input"
            />
            <Label htmlFor={mutualInputId} className="text-sm font-normal">
              Also set it from the other group back to this one
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
            <SetRelationshipSubmitButton isEdit={isEdit} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ClearRelationshipDialogProps {
  gameId: string;
  groupId: string;
  relationship: AdminGroupRelationship;
}

// Destructive-confirmation modal with an optional `mutual` checkbox so
// operators can clear both directions in one shot. The plain-async
// `clearRelationshipAction` is called imperatively from `onClick` so we
// can read the checkbox state at the moment of the call (a
// `useActionState` shape would force the checkbox into the form contract,
// which is fine but heavier than needed for a single-button confirm).
function ClearRelationshipDialog({ gameId, groupId, relationship }: ClearRelationshipDialogProps) {
  const [open, setOpen] = useState(false);
  const [mutual, setMutual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const mutualInputId = useId();

  useEffect(() => {
    if (open) {
      setMutual(false);
      setError(null);
    }
  }, [open]);

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const result: ClearRelationshipResult = await clearRelationshipAction(
        gameId,
        groupId,
        relationship.groupBId,
        mutual,
      );
      if (result.ok) {
        setOpen(false);
      } else {
        setError(result.error ?? "The server gave no reason. Try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="Clear relationship">
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clear relationship</DialogTitle>
          <DialogDescription>
            Removes the {relationship.type} link from this group to{" "}
            <span className="font-mono">{relationship.groupBId}</span>, set{" "}
            {dateFormatter.format(new Date(relationship.since))}. The audit log keeps a record.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              id={mutualInputId}
              type="checkbox"
              checked={mutual}
              onChange={(e) => setMutual(e.target.checked)}
              className="h-4 w-4 rounded border border-input"
            />
            <Label htmlFor={mutualInputId} className="text-sm font-normal">
              Also clear the link from <span className="font-mono">{relationship.groupBId}</span>{" "}
              back to this group
            </Label>
          </div>
          {error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Clearing...
              </>
            ) : (
              "Clear relationship"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RelationshipsTable({ relationships, gameId, groupId }: RelationshipsTableProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {numberFormatter.format(relationships.length)} outgoing{" "}
          {relationships.length === 1 ? "relationship" : "relationships"}
        </p>
        <SetRelationshipDialog
          gameId={gameId}
          groupId={groupId}
          trigger={
            <Button size="sm">
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              Add relationship
            </Button>
          }
        />
      </div>
      {relationships.length === 0 ? (
        <Notice
          title="No relationships yet"
          body="Add one to record this group's stance toward another group."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="py-2 pr-4 text-left font-medium">Other group</th>
                <th className="py-2 pr-4 text-left font-medium">Type</th>
                <th className="py-2 pr-4 text-left font-medium">Since</th>
                <th className="py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {relationships.map((rel) => (
                <tr
                  key={`${rel.groupAId}::${rel.groupBId}`}
                  className="border-b border-border/60 hover:bg-accent/40"
                >
                  <td className="py-2.5 pr-4">
                    <span className="font-mono">{rel.groupBId}</span>
                  </td>
                  <td className="py-2.5 pr-4 font-medium">{rel.type}</td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-muted-foreground">
                    <time dateTime={rel.since}>{dateFormatter.format(new Date(rel.since))}</time>
                  </td>
                  <td className="py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <SetRelationshipDialog
                        gameId={gameId}
                        groupId={groupId}
                        existing={rel}
                        trigger={
                          <Button size="sm" variant="ghost" aria-label="Edit relationship">
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        }
                      />
                      <ClearRelationshipDialog
                        gameId={gameId}
                        groupId={groupId}
                        relationship={rel}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
