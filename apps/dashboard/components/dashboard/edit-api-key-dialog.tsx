// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  type UpdateApiKeyResult,
  updateApiKeyAction,
} from "../../app/(dashboard)/games/[gameId]/actions";
import type { AdminApiKey } from "../../lib/admin-shared";
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
import { ApiKeyFields } from "./api-key-fields";

interface EditApiKeyDialogProps {
  gameId: string;
  apiKey: AdminApiKey;
}

const INITIAL_STATE: UpdateApiKeyResult = { ok: false };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Save"}
    </Button>
  );
}

export function EditApiKeyDialog({ gameId, apiKey }: EditApiKeyDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(updateApiKeyAction, INITIAL_STATE);
  const router = useRouter();
  const fieldsId = useId();

  useEffect(() => {
    if (state.ok && state.apiKey) {
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs sm:h-9 sm:px-3 sm:text-sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit API key</DialogTitle>
          <DialogDescription>
            Changes the label and namespace preference of key{" "}
            <span className="font-mono">{apiKey.prefix}</span>. The secret stays the same, so
            clients using it keep working. Open event streams pick up a new preference within 30
            seconds.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="gameId" value={gameId} />
          <input type="hidden" name="keyId" value={apiKey.id} />
          <ApiKeyFields
            idPrefix={fieldsId}
            defaultName={apiKey.name}
            defaultNamespaces={apiKey.preferredNamespaces}
          />
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
