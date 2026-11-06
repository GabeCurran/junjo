// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import type { UserId } from "@junjo.io/sdk";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "../../../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../../../../components/ui/dialog";
import { Input } from "../../../../../components/ui/input";
import { Label } from "../../../../../components/ui/label";
import { Textarea } from "../../../../../components/ui/textarea";
import { until } from "../../../../../lib/moderation";
import {
  type PlayerActionResult,
  addSanctionAction,
  banPlayerAction,
  liftBanAction,
  liftSanctionAction,
  setDisplayNameAction,
} from "./actions";

export interface BanView {
  reason: string | null;
  bannedAt: string;
  expiresAt: string | null;
  issuer: string | null;
}

export interface SanctionView {
  type: string;
  reason: string | null;
  startedAt: string;
  expiresAt: string | null;
  issuer: string | null;
}

// Hours; null is no end.
const DURATIONS: readonly { label: string; hours: number | null }[] = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
  { label: "No end", hours: null },
];

const SANCTION_TYPE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<PlayerActionResult>, onDone?: () => void) => {
    setError(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "The server refused the change.");
        return;
      }
      onDone?.();
      router.refresh();
    });
  };
  return { run, pending, error };
}

function PunishDialog({
  gameId,
  userId,
  version,
  kind,
}: {
  gameId: string;
  userId: UserId;
  version: number;
  kind: "ban" | "sanction";
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("");
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState<number | null>(kind === "ban" ? null : 24);
  const { run, pending, error } = useAction();
  const typeId = useId();
  const reasonId = useId();
  const typeProblem =
    kind === "sanction" && type.length > 0 && (!SANCTION_TYPE.test(type) || type === "ban")
      ? "Use 1 to 32 lowercase letters, digits, dots, dashes or underscores; ban is reserved."
      : null;

  const submit = () =>
    run(
      () =>
        kind === "ban"
          ? banPlayerAction(gameId, userId, { reason, expiresIn: duration, version })
          : addSanctionAction(gameId, userId, { type, reason, expiresIn: duration, version }),
      () => {
        setOpen(false);
        setType("");
        setReason("");
      },
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={kind === "ban" ? "destructive" : "outline"} size="sm">
          {kind === "ban" ? "Ban from game" : "Add sanction"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === "ban" ? "Ban from the game" : "Add a sanction"}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{userId}</span> and every id linked to it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {kind === "sanction" ? (
            <div className="space-y-1.5">
              <Label htmlFor={typeId}>Type</Label>
              <Input
                id={typeId}
                value={type}
                onChange={(e) => setType(e.target.value.toLowerCase())}
                placeholder="mute"
                className="font-mono"
                required
                autoComplete="off"
              />
              {typeProblem ? <p className="text-xs text-destructive">{typeProblem}</p> : null}
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor={reasonId}>Reason</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Length</legend>
            <div className="flex flex-wrap gap-1.5">
              {DURATIONS.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  aria-pressed={duration === d.hours}
                  onClick={() => setDuration(d.hours)}
                  className={
                    duration === d.hours
                      ? "rounded-md border border-foreground/40 bg-secondary px-2.5 py-1 text-sm font-medium"
                      : "rounded-md border border-input px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground"
                  }
                >
                  {d.label}
                </button>
              ))}
            </div>
          </fieldset>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={kind === "ban" ? "destructive" : "default"}
              disabled={
                pending || (kind === "sanction" && (type.length === 0 || typeProblem !== null))
              }
            >
              {pending ? "Saving" : kind === "ban" ? "Ban" : "Add sanction"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The player's standing: an active ban and sanctions with their lift
// buttons, and the actions to add either.
export function PlayerModeration({
  gameId,
  userId,
  version,
  ban,
  sanctions,
}: {
  gameId: string;
  userId: UserId;
  version: number;
  ban: BanView | null;
  sanctions: SanctionView[];
}) {
  const { run, pending, error } = useAction();
  return (
    <div className="flex flex-col gap-3">
      {ban ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold text-destructive">Banned</span> {until(ban.expiresAt)}
            {ban.reason ? <span>: {ban.reason}</span> : null}
            {ban.issuer ? <span className="text-muted-foreground"> by {ban.issuer}</span> : null}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => liftBanAction(gameId, userId, version))}
          >
            Lift ban
          </Button>
        </div>
      ) : null}
      {sanctions.map((s) => (
        <div
          key={s.type}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warn/50 bg-warn/10 px-4 py-2.5"
        >
          <p className="text-sm">
            <span className="font-mono font-semibold">{s.type}</span> {until(s.expiresAt)}
            {s.reason ? <span>: {s.reason}</span> : null}
            {s.issuer ? <span className="text-muted-foreground"> by {s.issuer}</span> : null}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => liftSanctionAction(gameId, userId, s.type, version))}
          >
            Lift {s.type}
          </Button>
        </div>
      ))}
      {!ban && sanctions.length === 0 ? (
        <p className="text-sm text-muted-foreground">In good standing: no ban or sanction.</p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {ban ? null : <PunishDialog gameId={gameId} userId={userId} version={version} kind="ban" />}
        <PunishDialog gameId={gameId} userId={userId} version={version} kind="sanction" />
      </div>
    </div>
  );
}

// A display name that edits in place.
export function DisplayNameField({
  gameId,
  pagePlayerId,
  userId,
  value,
}: {
  gameId: string;
  pagePlayerId: string;
  userId: UserId;
  value: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const { run, pending, error } = useAction();
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-left hover:underline"
        title="Edit display name"
      >
        {value ?? <span className="text-muted-foreground">Set a name</span>}
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const next = draft.trim();
        run(
          () => setDisplayNameAction(gameId, pagePlayerId, userId, next.length > 0 ? next : null),
          () => setEditing(false),
        );
      }}
    >
      <Input
        aria-label={`Display name for ${userId}`}
        value={draft}
        maxLength={64}
        onChange={(e) => setDraft(e.target.value)}
        className="h-8 w-48"
        autoFocus
      />
      <Button type="submit" size="sm" disabled={pending}>
        Save name
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
