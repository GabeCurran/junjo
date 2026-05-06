// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { type CreateGameResult, createGameAction } from "../../app/(dashboard)/games/actions";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const INITIAL_STATE: CreateGameResult = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating..." : "Create game"}
    </Button>
  );
}

export function CreateGameDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(createGameAction, INITIAL_STATE);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const nameInputId = useId();

  // Close the dialog and reset the form on successful create. The action's
  // `revalidatePath("/games")` already handles the list refresh; calling
  // `router.refresh()` belt-and-suspenders the case where the dialog stays
  // mounted and the consumer wants the latest data.
  useEffect(() => {
    if (state.ok && state.gameId) {
      setOpen(false);
      formRef.current?.reset();
      router.refresh();
    }
  }, [state, router]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" aria-hidden />
          Create game
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a game</DialogTitle>
          <DialogDescription>
            A game is the top-level tenant on Junjo. Members and groups live inside one game.
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={nameInputId}>Name</Label>
            <Input
              id={nameInputId}
              name="name"
              placeholder="My Game"
              autoComplete="off"
              required
              maxLength={200}
            />
            <p className="text-xs text-muted-foreground">
              1-200 characters. Names do not have to be unique.
            </p>
          </div>
          {state.error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
