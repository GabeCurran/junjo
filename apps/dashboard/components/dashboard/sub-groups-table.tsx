// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { ChevronUp, ExternalLink, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";

import {
  type ClearParentResult,
  type SetParentResult,
  clearParentAction,
  setParentAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import type { AdminGroup } from "../../lib/admin-shared";
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
import { Notice, Section } from "../ui/section";

interface SubGroupsTableProps {
  group: AdminGroup;
  // Renamed from `children` to avoid shadowing React's reserved children
  // prop; the wire format itself is still `Group[]`.
  childGroups: AdminGroup[];
  gameId: string;
}

const numberFormatter = new Intl.NumberFormat("en-US");
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

// Two stacked sections: the parent (0 or 1 row) and the direct children
// list. Both ultimately call the same `setAdminGroupParent`
// endpoint - "Set parent" mutates this group, "Add child" mutates the
// child group with this group as the new parent. Hand-rolled HTML
// tables (no TanStack); neither section needs client-side filter /
// pagination / sort.
//
// V1 limitations:
// - Children list is direct-only (grandchildren NOT recursed). Click into
//   a child's detail page to see its own sub-tree. Mirrors the per-game
//   route's contract verbatim.
// - Re-targeting the parent is a clear-then-set flow rather than an
//   in-place edit; the `Set parent` dialog re-prompts each time. The
//   underlying PUT is idempotent on no-op so an accidental re-submit is
//   harmless.
// - The parent shows as its id only (no enrichment with the parent's
//   name); the id links to the parent's page.

const INITIAL_SET_STATE: SetParentResult = { ok: false };

interface SetParentDialogProps {
  gameId: string;
  groupId: string;
  // The group whose parent is being set. Equals `groupId` for the "Set
  // parent of this group" flow; equals a child's id for the (currently
  // unused; kept for symmetry with `<AddChildDialog>`) "edit child's
  // parent" flow.
  targetGroupId: string;
  // Pre-fill value when the operator is editing an existing parent
  // assignment. Empty string for the create flow.
  defaultParentId: string;
  // Whether the dialog renders the "Edit parent" flow vs the "Set
  // parent" flow. The body shape is identical; only the copy differs.
  isEdit: boolean;
  trigger: React.ReactNode;
}

function SetParentSubmitButton({ isEdit }: { isEdit: boolean }) {
  const { pending } = useFormStatus();
  const label = isEdit ? "Save parent" : "Set parent";
  const pendingLabel = isEdit ? "Saving..." : "Setting...";
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

// Form-driven dialog for "Set parent of this group". The single text
// input accepts the new parent's id (or blank to clear). PUT semantics
// on the underlying endpoint cover both create-new (no row) and update-
// in-place (different parentGroupId) because the body shape is identical.
function SetParentDialog({
  gameId,
  groupId,
  targetGroupId,
  defaultParentId,
  isEdit,
  trigger,
}: SetParentDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(setParentAction, INITIAL_SET_STATE);
  const parentInputId = useId();

  useEffect(() => {
    if (state.ok && state.group) {
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit parent group" : "Set parent group"}</DialogTitle>
          <DialogDescription>
            Nest this group under another group in the same game. A group cannot sit under itself or
            one of its descendants.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="targetGroupId" value={targetGroupId} />
          <div className="space-y-2">
            <Label htmlFor={parentInputId}>Parent group id</Label>
            <Input
              id={parentInputId}
              name="parentGroupId"
              autoComplete="off"
              defaultValue={defaultParentId}
              placeholder="grp_..."
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Leave blank to clear the parent.</p>
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
            <SetParentSubmitButton isEdit={isEdit} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface AddChildDialogProps {
  gameId: string;
  // The current group (becomes the new parent of the supplied child).
  groupId: string;
}

function AddChildSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Adding..." : "Add child"}
    </Button>
  );
}

// Form-driven dialog for "Add a child group". Same Server Action as
// `<SetParentDialog>` but the form fixes `parentGroupId = groupId` and
// the user supplies `targetGroupId` (the child's id). The Server Action
// rejects self-parenting (`targetGroupId === groupId`) before the wire
// call, so an operator pasting this group's own id gets a clearer error
// than the server's `parent_cycle`.
function AddChildDialog({ gameId, groupId }: AddChildDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(setParentAction, INITIAL_SET_STATE);
  const childInputId = useId();

  useEffect(() => {
    if (state.ok && state.group) {
      setOpen(false);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add child
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add child group</DialogTitle>
          <DialogDescription>
            Nest another group from this game under this one. A group that already has a parent
            moves here. An ancestor of this group cannot become its child.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="parentGroupId" value={groupId} />
          <div className="space-y-2">
            <Label htmlFor={childInputId}>Child group id</Label>
            <Input
              id={childInputId}
              name="targetGroupId"
              required
              autoComplete="off"
              placeholder="grp_..."
              className="font-mono"
            />
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
            <AddChildSubmitButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ClearParentDialogProps {
  gameId: string;
  groupId: string;
  targetGroupId: string;
  // Display copy: the dialog title, its description, and the confirm
  // button's label.
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  // Optional summary rendered between the description and the confirm
  // button.
  summary?: React.ReactNode;
  trigger: React.ReactNode;
}

// Destructive-confirmation modal calling `clearParentAction` imperatively.
// Plain async action invoked from `onClick` via `useTransition`, no
// `useActionState` because there's no form data to validate beyond the
// implicit `targetGroupId` already known to the dialog.
function ClearParentDialog({
  gameId,
  groupId,
  targetGroupId,
  title,
  description,
  confirmLabel,
  summary,
  trigger,
}: ClearParentDialogProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const result: ClearParentResult = await clearParentAction(gameId, groupId, targetGroupId);
      if (result.ok) {
        setOpen(false);
      } else {
        setError(result.error ?? "The server gave no reason. Try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {summary ?? null}
        {error ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                {confirmLabel}
              </>
            ) : (
              confirmLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ParentSection({ group, gameId }: { group: AdminGroup; gameId: string }) {
  const hasParent = group.parentGroupId !== null;
  return (
    <Section
      title="Parent group"
      actions={
        <>
          <SetParentDialog
            gameId={gameId}
            groupId={group.id}
            targetGroupId={group.id}
            defaultParentId={group.parentGroupId ?? ""}
            isEdit={hasParent}
            trigger={
              <Button size="sm" variant={hasParent ? "outline" : "default"}>
                {hasParent ? (
                  <>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    Edit parent
                  </>
                ) : (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                    Set parent
                  </>
                )}
              </Button>
            }
          />
          {hasParent ? (
            <ClearParentDialog
              gameId={gameId}
              groupId={group.id}
              targetGroupId={group.id}
              title="Clear parent"
              description={
                <>
                  This group leaves <span className="font-mono">{group.parentGroupId}</span> and
                  moves to the top of its tree. The parent group is not changed.
                </>
              }
              confirmLabel="Clear parent"
              trigger={
                <Button size="sm" variant="ghost" aria-label="Clear parent">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              }
            />
          ) : null}
        </>
      }
    >
      {hasParent ? (
        <p className="text-sm">
          <Link
            href={`/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(group.parentGroupId ?? "")}`}
            className="break-all font-mono hover:underline"
          >
            {group.parentGroupId}
          </Link>
        </p>
      ) : (
        <Notice title="No parent group" body="This group is at the top of its tree." />
      )}
    </Section>
  );
}

function ChildrenSection({
  group,
  childGroups,
  gameId,
}: {
  group: AdminGroup;
  childGroups: AdminGroup[];
  gameId: string;
}) {
  return (
    <Section
      title="Direct children"
      meta={`${numberFormatter.format(childGroups.length)} ${childGroups.length === 1 ? "group" : "groups"}`}
      actions={<AddChildDialog gameId={gameId} groupId={group.id} />}
    >
      {childGroups.length === 0 ? (
        <Notice title="No child groups" body="Add one to nest another group under this one." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="py-2 pr-4 text-left font-medium">Name</th>
                <th className="py-2 pr-4 text-left font-medium">Kind</th>
                <th className="py-2 pr-4 text-right font-medium">Members</th>
                <th className="py-2 pr-4 text-left font-medium">Created</th>
                <th className="py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {childGroups.map((child) => (
                <tr key={child.id} className="border-b border-border/60 hover:bg-accent/40">
                  <td className="py-2.5 pr-4">
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                      <span className="font-medium">{child.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{child.id}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">{child.kind}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {numberFormatter.format(child.memberCount)}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-muted-foreground">
                    <time dateTime={child.createdAt}>
                      {dateFormatter.format(new Date(child.createdAt))}
                    </time>
                  </td>
                  <td className="py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        href={`/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(child.id)}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                        aria-label="Open child"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                      <ClearParentDialog
                        gameId={gameId}
                        groupId={group.id}
                        targetGroupId={child.id}
                        title="Remove child"
                        description={
                          <>
                            <span className="font-medium text-foreground">{child.name}</span> moves
                            out of this group to the top of its own tree. You can add it back later.
                          </>
                        }
                        confirmLabel="Remove child"
                        summary={
                          <p className="text-sm">
                            <span className="font-medium">{child.name}</span>
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {child.id}
                            </span>
                          </p>
                        }
                        trigger={
                          <Button size="sm" variant="ghost" aria-label="Remove child">
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        }
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export function SubGroupsTable({ group, childGroups, gameId }: SubGroupsTableProps) {
  return (
    <div className="flex flex-col gap-8">
      <ParentSection group={group} gameId={gameId} />
      <ChildrenSection group={group} childGroups={childGroups} gameId={gameId} />
    </div>
  );
}
