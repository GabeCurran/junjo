// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  type RevokeApiKeyResult,
  revokeApiKeyAction,
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

interface RevokeApiKeyDialogProps {
  gameId: string;
  keyId: string;
  prefix: string;
}

const INITIAL_STATE: RevokeApiKeyResult = { ok: false };

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? "Revoking..." : "Revoke key"}
    </Button>
  );
}

export function RevokeApiKeyDialog({ gameId, keyId, prefix }: RevokeApiKeyDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(revokeApiKeyAction, INITIAL_STATE);
  const router = useRouter();

  // Close on success and refresh the page so the key flips to "Revoked".
  // The Server Action's `revalidatePath` already handles the cache, but
  // `router.refresh()` is the idiomatic post-mutation refresh in Server
  // Component pages.
  useEffect(() => {
    if (state.ok && state.apiKey) {
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Revoke
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke API key</DialogTitle>
          <DialogDescription>
            Any client using this key will be rejected on its next request. Junjo never hard-deletes
            the row so the prefix stays resolvable in audit lookups.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm">
            Revoking key with prefix <span className="font-mono">{prefix}</span>. This cannot be
            undone; you will need to issue a fresh key to replace it.
          </p>
          {state.error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </div>
          ) : null}
        </div>
        <form action={formAction}>
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="keyId" value={keyId} />
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
