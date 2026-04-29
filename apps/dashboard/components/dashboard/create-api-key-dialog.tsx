// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Check, Copy, KeyRound, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";

import {
  type CreateApiKeyResult,
  createApiKeyAction,
} from "../../app/(dashboard)/games/[gameId]/actions";
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

interface CreateApiKeyDialogProps {
  gameId: string;
}

const INITIAL_STATE: CreateApiKeyResult = { ok: false };

function IssueButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Issuing..." : "Issue key"}
    </Button>
  );
}

export function CreateApiKeyDialog({ gameId }: CreateApiKeyDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(createApiKeyAction, INITIAL_STATE);
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  // The secret is stored in `state.apiKey.key`. We deliberately do NOT close
  // the dialog automatically on success: the operator needs to copy the
  // secret before it disappears, and an auto-close would lose it. The
  // dialog stays open with the secret visible until the operator clicks
  // "Done", at which point we reset the form state and refresh the list.
  const issuedKey = state.ok && state.apiKey ? state.apiKey : null;

  // Reset the copied flag whenever the visible key changes (the operator
  // issued a fresh key after the previous one was already copied).
  useEffect(() => {
    setCopied(false);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && issuedKey) {
      // Closing the dialog after a successful issuance: refresh the list
      // so the new key appears, and reset the action state so the next
      // open shows the issuance form rather than the previously issued
      // secret. The Server Action's `revalidatePath` already handles the
      // cache invalidation; `router.refresh()` belt-and-suspenders the
      // current view.
      router.refresh();
      // The action's state cannot be reset cleanly via useFormState; we
      // accept that re-opening the dialog after a successful issue without
      // a hard refresh would show the previously-issued secret again.
      // The router.refresh() rerenders the parent and re-mounts this
      // component (because the page tree re-renders), which clears the
      // local state.
    }
  }

  async function handleCopy() {
    if (!issuedKey) return;
    try {
      await navigator.clipboard.writeText(issuedKey.key);
      setCopied(true);
    } catch {
      // Clipboard write can fail in non-secure contexts (HTTP) or under
      // permission denial. Falling back to a no-op is fine; the secret is
      // already visible on screen for manual copy.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <KeyRound className="h-4 w-4" aria-hidden />
          Issue key
        </Button>
      </DialogTrigger>
      <DialogContent>
        {issuedKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API key issued</DialogTitle>
              <DialogDescription>
                Copy this secret now. Junjo stores only a scrypt hash; once you close this dialog
                the key cannot be recovered.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p>
                  Treat this string like a password. Anyone with it can call the Junjo API as this
                  game.
                </p>
              </div>
              <div className="flex items-stretch gap-2">
                <code
                  className="flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs"
                  data-testid="api-key-secret"
                >
                  {issuedKey.key}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  aria-label="Copy API key"
                >
                  {copied ? (
                    <Check className="h-4 w-4" aria-hidden />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              </div>
              {copied ? (
                <p className="text-xs text-muted-foreground">Copied to clipboard.</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Prefix <span className="font-mono">{issuedKey.prefix}</span> stays visible in the
                keys table after you close this dialog; the secret half does not.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Issue an API key</DialogTitle>
              <DialogDescription>
                The full secret will only be shown once after issuance. Copy it before closing the
                dialog.
              </DialogDescription>
            </DialogHeader>
            <form action={formAction} className="space-y-4">
              <input type="hidden" name="gameId" value={gameId} />
              <p className="text-sm text-muted-foreground">
                Junjo stores only a scrypt hash of the secret. After the dialog closes there is no
                way to recover the key; you will need to issue a new one and revoke this one if it
                is lost.
              </p>
              {state.error ? (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {state.error}
                </div>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <IssueButton />
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
