// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Check, Copy, Link2, Mail, ShieldAlert, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  type InviteMemberResult,
  type InviteMode,
  inviteMemberAction,
} from "../../app/(dashboard)/games/[gameId]/groups/[groupId]/actions";
import {
  ADMIN_INVITATION_ROLE_ID_MAX_LENGTH,
  ADMIN_INVITATION_USER_ID_MAX_LENGTH,
} from "../../lib/admin-shared";
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

interface InviteMemberDialogProps {
  gameId: string;
  groupId: string;
}

const INITIAL_STATE: InviteMemberResult = { ok: false };

interface TabDef {
  value: InviteMode;
  label: string;
  icon: typeof Mail;
  description: string;
}

const TABS: readonly TabDef[] = [
  {
    value: "userId",
    label: "By user id",
    icon: Mail,
    description:
      "Direct invitation - only the named user can accept. The dev's frontend or auth-adapter integration is responsible for surfacing it to them.",
  },
  {
    value: "code",
    label: "By code",
    icon: ShieldAlert,
    description:
      "Open invitation - anyone with the code can accept. The code is shown once after creation; it stays retrievable from the invitations endpoint afterward.",
  },
  {
    value: "link",
    label: "By link",
    icon: Link2,
    description:
      "Open invitation rendered as a shareable URL. Construct against JUNJO_INVITE_BASE_URL (or JUNJO_BASE_URL when unset).",
  },
];

function SubmitButton({ mode }: { mode: InviteMode }) {
  const { pending } = useFormStatus();
  const idleLabel =
    mode === "userId" ? "Send invitation" : mode === "code" ? "Generate code" : "Generate link";
  const pendingLabel =
    mode === "userId"
      ? "Sending..."
      : mode === "code"
        ? "Generating code..."
        : "Generating link...";
  return (
    <Button type="submit" disabled={pending}>
      {pending ? pendingLabel : idleLabel}
    </Button>
  );
}

export function InviteMemberDialog({ gameId, groupId }: InviteMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<InviteMode>("userId");
  const [state, formAction] = useActionState(inviteMemberAction, INITIAL_STATE);
  const [copied, setCopied] = useState(false);
  const router = useRouter();
  const userIdId = useId();
  const roleIdId = useId();
  const expiresInId = useId();

  const issued =
    state.ok && state.invitation && state.mode
      ? { ...state, invitation: state.invitation, mode: state.mode }
      : null;

  // The by-userId tab has nothing to display after success - the operator
  // has no code to copy and the actual notification to the user is the
  // dev's responsibility. Auto-close so they get back to the table.
  useEffect(() => {
    if (issued && issued.mode === "userId") {
      setOpen(false);
    }
  }, [issued]);

  // Reset the copied flag whenever a new code/url lands so an operator
  // re-opening the dialog after a previous copy does not see a stale
  // "copied" indicator.
  useEffect(() => {
    setCopied(false);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && issued) {
      // Closing after a successful create: refresh the parent so the new
      // invitation row is visible in any pending invitations panel that
      // might appear in a future iteration. The Server Action already
      // calls revalidatePath; router.refresh() belt-and-suspenders the
      // currently rendered page tree.
      router.refresh();
    }
  }

  function handleTabClick(next: InviteMode) {
    if (next === mode) return;
    setMode(next);
    setCopied(false);
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard write can fail in non-secure contexts (HTTP) or under
      // permission denial. The string remains visible on screen for
      // manual copy; no fallback needed.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus className="h-4 w-4" aria-hidden />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {issued && (issued.mode === "code" || issued.mode === "link") ? (
          <ResultPanel
            mode={issued.mode}
            invitation={issued.invitation}
            inviteUrl={issued.inviteUrl}
            copied={copied}
            onCopy={handleCopy}
            onDone={() => handleOpenChange(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite member</DialogTitle>
              <DialogDescription>
                Issue a direct invitation, an open code, or a shareable link for this group. All
                three call the same admin endpoint and produce the same `member.invited` audit
                entry; only the variant differs.
              </DialogDescription>
            </DialogHeader>
            <div
              role="tablist"
              aria-label="Invitation type"
              className="flex gap-1 rounded-md border border-border bg-muted/40 p-1"
            >
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const active = tab.value === mode;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => handleTabClick(tab.value)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {TABS.find((t) => t.value === mode)?.description}
            </p>
            <form action={formAction} className="space-y-4" key={mode}>
              <input type="hidden" name="gameId" value={gameId} />
              <input type="hidden" name="groupId" value={groupId} />
              <input type="hidden" name="mode" value={mode} />
              {mode === "userId" ? (
                <div className="space-y-2">
                  <Label htmlFor={userIdId}>External user id</Label>
                  <Input
                    id={userIdId}
                    name="targetUserId"
                    required
                    maxLength={ADMIN_INVITATION_USER_ID_MAX_LENGTH}
                    placeholder="user_2abc... or 12345"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    The dev-supplied id from your auth provider. Junjo links it to a JunjoUser via
                    ExternalIdentity on first acceptance.
                  </p>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor={roleIdId}>Role id (optional)</Label>
                <Input
                  id={roleIdId}
                  name="roleId"
                  maxLength={ADMIN_INVITATION_ROLE_ID_MAX_LENGTH}
                  placeholder="rl_..."
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Auto-assigned to the new member when the invitation is accepted. Not validated
                  against `Role` on create; an invalid id surfaces at accept time.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={expiresInId}>Expires in (optional)</Label>
                <Input
                  id={expiresInId}
                  name="expiresIn"
                  placeholder="7d"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Format: `&lt;positive integer&gt;&lt;unit&gt;` where unit is s, m, h, or d. Leave
                  blank for no expiry.
                </p>
              </div>
              {state.error ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {state.error}
                </div>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <SubmitButton mode={mode} />
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ResultPanelProps {
  mode: InviteMode;
  invitation: NonNullable<InviteMemberResult["invitation"]>;
  inviteUrl?: string;
  copied: boolean;
  onCopy: (text: string) => void;
  onDone: () => void;
}

function ResultPanel({ mode, invitation, inviteUrl, copied, onCopy, onDone }: ResultPanelProps) {
  const text = mode === "link" && inviteUrl ? inviteUrl : invitation.code;
  const title = mode === "link" ? "Invite link generated" : "Invite code generated";
  const description =
    mode === "link"
      ? "Share this link with the recipient. Anyone who opens it can accept the invitation, so treat it like a one-time secret."
      : "Share this code with the recipient. Anyone who knows it can accept, so treat it like a one-time secret.";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="flex items-stretch gap-2">
          <code
            className="flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs"
            data-testid={mode === "link" ? "invite-url" : "invite-code"}
          >
            {text}
          </code>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => onCopy(text)}
            aria-label={mode === "link" ? "Copy invite link" : "Copy invite code"}
          >
            {copied ? (
              <Check className="h-4 w-4" aria-hidden />
            ) : (
              <Copy className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </div>
        {copied ? <p className="text-xs text-muted-foreground">Copied to clipboard.</p> : null}
        {invitation.expiresAt ? (
          <p className="text-xs text-muted-foreground">
            Expires {new Date(invitation.expiresAt).toLocaleString()}.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No expiry set.</p>
        )}
        {invitation.roleId ? (
          <p className="text-xs text-muted-foreground">
            Role on accept: <span className="font-mono">{invitation.roleId}</span>
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
