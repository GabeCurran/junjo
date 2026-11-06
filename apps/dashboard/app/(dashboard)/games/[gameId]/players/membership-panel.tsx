// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import type { UserId } from "@junjo.io/sdk";
import { X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "../../../../../components/ui/button";
import { RoleChip } from "../../../../../components/ui/role-chip";
import {
  type PlayerActionResult,
  assignRoleAction,
  kickFromGroupAction,
  removeRoleAction,
} from "./actions";

export interface RoleView {
  id: string;
  name: string;
  color: string | null;
}

export interface OverrideView {
  permission: string;
  value: boolean;
  context: string | null;
}

export interface MembershipView {
  groupId: string;
  groupName: string;
  groupHref: string;
  userId: UserId;
  status: string;
  version: number;
  joinedAt: string;
  roles: RoleView[];
  // Every role the group defines, for the add-role picker.
  groupRoles: RoleView[];
  overrides: OverrideView[];
  notesPublic: string | null;
  notesPrivate: string | null;
  // Pretty-printed; "{}" when empty.
  metadata: string;
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

// One group the player belongs to: roles to add or remove, a kick, and
// the membership's overrides, notes and metadata behind a disclosure.
export function MembershipPanel({
  gameId,
  pagePlayerId,
  m,
}: { gameId: string; pagePlayerId: string; m: MembershipView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [kicking, setKicking] = useState(false);
  const [reason, setReason] = useState("");
  const active = m.status === "active";
  const held = new Set(m.roles.map((r) => r.id));
  const addable = m.groupRoles.filter((r) => !held.has(r.id));

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

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href={m.groupHref} className="font-medium hover:underline">
          {m.groupName}
        </Link>
        <span className={active ? "text-sm text-muted-foreground" : "text-sm capitalize text-warn"}>
          {active ? `since ${dateFormat.format(new Date(m.joinedAt))}` : m.status}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {m.roles.map((r) => (
            <span key={r.id} className="inline-flex items-center">
              <RoleChip name={r.name} color={r.color} />
              {active ? (
                <button
                  type="button"
                  aria-label={`Remove ${r.name}`}
                  title={`Remove ${r.name}`}
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      removeRoleAction(gameId, pagePlayerId, m.groupId, m.userId, r.id, m.version),
                    )
                  }
                  className="ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-50"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              ) : null}
            </span>
          ))}
          {active && addable.length > 0 ? (
            <select
              aria-label={`Give a role in ${m.groupName}`}
              value=""
              disabled={pending}
              onChange={(e) => {
                const roleId = e.target.value;
                if (roleId) {
                  run(() =>
                    assignRoleAction(gameId, pagePlayerId, m.groupId, m.userId, roleId, m.version),
                  );
                }
              }}
              className="h-6 rounded-sm border border-input bg-background px-1 text-xs text-muted-foreground"
            >
              <option value="">Give role</option>
              {addable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {active ? (
          <div className="ml-auto">
            {kicking ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(
                    () => kickFromGroupAction(gameId, pagePlayerId, m.groupId, m.userId, reason),
                    () => setKicking(false),
                  );
                }}
              >
                <input
                  aria-label="Kick reason"
                  placeholder="Reason"
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                  className="h-8 w-44 rounded-md border border-input bg-background px-2 text-sm"
                />
                <Button type="submit" size="sm" variant="destructive" disabled={pending}>
                  Kick
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setKicking(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setKicking(true)}>
                Kick from group
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-sm text-destructive">{error}</p> : null}
      <details className="mt-1.5 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          {[
            m.overrides.length > 0
              ? `${m.overrides.length} override${m.overrides.length === 1 ? "" : "s"}`
              : null,
            m.notesPublic || m.notesPrivate ? "notes" : null,
            m.metadata !== "{}" ? "metadata" : null,
          ]
            .filter(Boolean)
            .join(", ") || "Details"}
        </summary>
        <div className="mt-2 grid gap-4 border-l-2 border-border pl-4 lg:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Overrides</p>
            {m.overrides.length === 0 ? (
              <p className="text-muted-foreground">None</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {m.overrides.map((o) => (
                  <li key={`${o.permission}|${o.context ?? ""}`} className="font-mono text-xs">
                    <span className={o.value ? "text-allow" : "text-destructive"}>
                      {o.value ? "allow" : "deny"}
                    </span>{" "}
                    {o.permission}
                    {o.context ? (
                      <span className="text-muted-foreground"> in {o.context}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Notes</p>
            {m.notesPublic || m.notesPrivate ? (
              <div className="mt-1 space-y-1">
                {m.notesPublic ? <p>{m.notesPublic}</p> : null}
                {m.notesPrivate ? (
                  <p className="text-muted-foreground">Private: {m.notesPrivate}</p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">None</p>
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Metadata</p>
            {m.metadata === "{}" ? (
              <p className="text-muted-foreground">None</p>
            ) : (
              <pre className="mt-1 max-h-48 overflow-auto rounded-sm bg-muted/50 p-2 font-mono text-xs">
                {m.metadata}
              </pre>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}
