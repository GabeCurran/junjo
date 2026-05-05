// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import {
  ChevronUp,
  ExternalLink,
  GitBranch,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
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

// Two stacked cards: the parent breadcrumb (0 or 1 row) and the direct
// children list. Both ultimately call the same `setAdminGroupParent`
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
// - Parent breadcrumb shows the parent's id only (no enrichment with
//   the parent's name). Operators click "Open" to see full details. A
//   future iteration can add a parallel parent fetch if the UX demands.

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
  // Whether the dialog renders the "Edit parent" flow (button label
  // "Save", title "Edit parent group") vs the "Set parent" flow (button
  // label "Set parent", title "Set parent group"). The body shape is
  // identical; only the copy differs.
  isEdit: boolean;
  trigger: React.ReactNode;
}

function SetParentSubmitButton({ isEdit }: { isEdit: boolean }) {
  const { pending } = useFormStatus();
  const label = isEdit ? "Save" : "Set parent";
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
            Move this group under another group in the hierarchy. Setting the parent to itself or to
            any descendant returns <code>parent_cycle</code>. Leave the field blank to clear the
            parent assignment instead.
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
            <p className="text-xs text-muted-foreground">
              The id of the parent group. Must be in the same game; cross-game references return a
              404 envelope. Leave blank to clear (equivalent to the standalone "Clear parent"
              button).
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
            Move another group under this one. Adding a group that's already an ancestor of this
            group returns <code>parent_cycle</code>; an existing child of a different parent is
            re-parented in place.
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
            <p className="text-xs text-muted-foreground">
              The id of the group to move under this one. Must be in the same game.
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
  // Display copy. The "Clear parent" flow uses {title: "Clear parent",
  // body: "Detach this group from..."}; the per-row "Remove child" flow
  // uses {title: "Remove child", body: "Move <name> out of this group..."}.
  title: string;
  description: React.ReactNode;
  // Optional summary card rendered between the description and the
  // confirm button. Used by the Remove-child flow to show the child's
  // name + kind.
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
        setError(result.error ?? "could not clear parent");
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
        {summary ? <div className="space-y-2">{summary}</div> : null}
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
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                Clearing...
              </>
            ) : (
              "Clear"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ParentCard({ group, gameId }: { group: AdminGroup; gameId: string }) {
  const hasParent = group.parentGroupId !== null;
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:space-y-1.5">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Parent group</CardTitle>
          <CardDescription>
            This group's place in the hierarchy. Each group has at most one parent; cycles are
            rejected by the server.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
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
                  Detach this group from <span className="font-mono">{group.parentGroupId}</span>.
                  Audit history is preserved (the server writes a <code>group.parent.cleared</code>{" "}
                  entry); the parent itself is unaffected.
                </>
              }
              trigger={
                <Button size="sm" variant="ghost" aria-label="Clear parent">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              }
            />
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {hasParent ? (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-card/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-primary">
                <Layers className="h-4 w-4" aria-hidden />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Parent
                </span>
                <span className="break-all font-mono text-sm">{group.parentGroupId}</span>
              </div>
            </div>
            <Link
              href={`/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(group.parentGroupId ?? "")}`}
              className="inline-flex items-center gap-1 self-start rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:self-auto"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              Open parent
            </Link>
          </div>
        ) : (
          <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-8 text-center">
            <ChevronUp className="h-7 w-7 text-muted-foreground" aria-hidden />
            <p className="mt-2 text-sm font-medium">No parent group</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              This group sits at the top of its tree. Use "Set parent" above to move it under
              another group.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChildrenCard({
  group,
  childGroups,
  gameId,
}: {
  group: AdminGroup;
  childGroups: AdminGroup[];
  gameId: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:space-y-1.5">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Direct children</CardTitle>
          <CardDescription>
            Groups whose parent is this one. Direct children only; click into a child to see its own
            sub-tree. {numberFormatter.format(childGroups.length)}{" "}
            {childGroups.length === 1 ? "child" : "children"} total.
          </CardDescription>
        </div>
        <AddChildDialog gameId={gameId} groupId={group.id} />
      </CardHeader>
      <CardContent>
        {childGroups.length === 0 ? (
          <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-10 text-center">
            <GitBranch className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="mt-3 text-sm font-medium">No children yet</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Use "Add child" above to move another group under this one. Removing a child clears
              its <code>parentGroupId</code> back to null.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4 text-left font-medium">Name</th>
                  <th className="py-2 pr-4 text-left font-medium">Kind</th>
                  <th className="py-2 pr-4 text-right font-medium">Members</th>
                  <th className="py-2 pr-4 text-left font-medium">Created</th>
                  <th className="py-2 pr-4 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {childGroups.map((child) => (
                  <tr key={child.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{child.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{child.id}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge variant="muted" className="font-mono">
                        {child.kind}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 text-right font-mono tabular-nums text-sm">
                      {numberFormatter.format(child.memberCount)}
                    </td>
                    <td className="py-3 pr-4 text-xs text-muted-foreground">
                      <time dateTime={child.createdAt}>
                        {dateFormatter.format(new Date(child.createdAt))}
                      </time>
                    </td>
                    <td className="py-3 pr-4">
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
                              Move <span className="font-medium">{child.name}</span> out of this
                              group. Audit history is preserved on the child group (the server
                              writes a <code>group.parent.cleared</code> entry there); the child
                              itself is otherwise unaffected and can be re-added later.
                            </>
                          }
                          summary={
                            <div className="rounded-md border border-border bg-card/50 p-3 text-sm">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{child.name}</span>
                                <Badge variant="muted" className="font-mono">
                                  {child.kind}
                                </Badge>
                              </div>
                              <p className="mt-1 font-mono text-xs text-muted-foreground">
                                {child.id}
                              </p>
                            </div>
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
      </CardContent>
    </Card>
  );
}

export function SubGroupsTable({ group, childGroups, gameId }: SubGroupsTableProps) {
  return (
    <div className="space-y-4">
      <ParentCard group={group} gameId={gameId} />
      <ChildrenCard group={group} childGroups={childGroups} gameId={gameId} />
    </div>
  );
}
