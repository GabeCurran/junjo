// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";

import {
  type CheckPermissionInputs,
  type CheckPermissionResult,
  checkPermissionAction,
} from "../../app/(dashboard)/games/[gameId]/permissions/check/actions";
import {
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  type AdminPermissionCheckResult,
} from "../../lib/admin-shared";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RoleChip } from "../ui/role-chip";

interface PermissionCheckTesterProps {
  gameId: string;
}

const INITIAL_STATE: CheckPermissionResult = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Checking..." : "Check permission"}
    </Button>
  );
}

export function PermissionCheckTester({ gameId }: PermissionCheckTesterProps) {
  const [state, formAction] = useActionState(checkPermissionAction, INITIAL_STATE);
  const userIdId = useId();
  const groupIdId = useId();
  const permissionId = useId();
  const contextId = useId();

  const echoedInputs = state.ok ? state.inputs : (state.inputs ?? null);

  return (
    <div className="flex flex-col gap-8">
      <form
        action={formAction}
        className="grid items-end gap-3 rounded-md border border-border p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
      >
        <input type="hidden" name="gameId" value={gameId} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={userIdId} className="text-xs text-muted-foreground">
            User id
          </label>
          <Input
            id={userIdId}
            name="userId"
            required
            defaultValue={echoedInputs?.userId ?? ""}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={groupIdId} className="text-xs text-muted-foreground">
            Group id
          </label>
          <Input
            id={groupIdId}
            name="groupId"
            required
            defaultValue={echoedInputs?.groupId ?? ""}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={permissionId} className="text-xs text-muted-foreground">
            Permission
          </label>
          <Input
            id={permissionId}
            name="permission"
            required
            maxLength={ADMIN_PERMISSION_KEY_MAX_LENGTH}
            defaultValue={echoedInputs?.permission ?? ""}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={contextId} className="text-xs text-muted-foreground">
            Context (optional)
          </label>
          <Input
            id={contextId}
            name="context"
            placeholder="world=pvp"
            defaultValue={echoedInputs?.context ?? ""}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <SubmitButton />
        {!state.ok && state.error ? (
          <p role="alert" className="text-sm text-destructive md:col-span-2 xl:col-span-5">
            {state.error}
          </p>
        ) : null}
      </form>
      <div aria-live="polite">
        {state.ok ? (
          <ResultPanel result={state.result} inputs={state.inputs} role={state.role} />
        ) : null}
      </div>
    </div>
  );
}

interface ResultPanelProps {
  result: AdminPermissionCheckResult;
  inputs: CheckPermissionInputs;
  role?: { name: string; color: string | null };
}

function ResultPanel({ result, inputs, role }: ResultPanelProps) {
  return (
    <section className="flex flex-col gap-3">
      <p
        className={cn(
          "font-condensed text-4xl font-semibold tracking-tight",
          result.allowed ? "text-allow" : "text-destructive",
        )}
      >
        {result.allowed ? "Allowed" : "Denied"}
      </p>
      <p className="text-sm">{decidedBy(result)}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Source</dt>
        <dd>{SOURCE_LABELS[result.source] ?? result.source}</dd>
        {result.viaRoleId ? (
          <>
            <dt className="text-muted-foreground">Role</dt>
            <dd>
              {role ? (
                <RoleChip name={role.name} color={role.color} title={result.viaRoleId} />
              ) : (
                <span className="break-all font-mono text-xs leading-5">{result.viaRoleId}</span>
              )}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">User</dt>
        <dd className="break-all font-mono text-xs leading-5">{inputs.userId}</dd>
        <dt className="text-muted-foreground">Group</dt>
        <dd className="break-all font-mono text-xs leading-5">{inputs.groupId}</dd>
        <dt className="text-muted-foreground">Permission</dt>
        <dd className="break-all font-mono text-xs leading-5">{inputs.permission}</dd>
        {inputs.context ? (
          <>
            <dt className="text-muted-foreground">Checked in</dt>
            <dd className="break-all font-mono text-xs leading-5">{inputs.context}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Decided by</dt>
        <dd className="break-all text-xs leading-5">
          {result.context ? (
            <span className="font-mono">
              {Object.entries(result.context)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")}
            </span>
          ) : (
            "a global entry"
          )}
        </dd>
      </dl>
    </section>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  role: "Role entry",
  override: "Member override",
  default: "Default",
  none: "No membership",
};

// One line on what decided the result. Roles and overrides can decide in
// either direction, so both branches read the `allowed` flag.
function decidedBy(result: AdminPermissionCheckResult): string {
  switch (result.source) {
    case "role":
      return result.allowed
        ? "A role entry the user holds grants it."
        : "A role entry the user holds denies it.";
    case "override":
      return result.allowed
        ? "A member override grants it, ahead of any role."
        : "A member override denies it, ahead of any role.";
    case "default":
      return "No role entry or override matches, so the default applies.";
    case "none":
      return "The user is not an active member of this group.";
    default:
      return `Decided by ${result.source}.`;
  }
}
