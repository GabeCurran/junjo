// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { CheckCircle2, MinusCircle, ShieldOff, UserX, XCircle } from "lucide-react";
import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";

import {
  type CheckPermissionResult,
  checkPermissionAction,
} from "../../app/(dashboard)/games/[gameId]/permissions/check/actions";
import {
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  type AdminPermissionCheckResult,
  type AdminPermissionSource,
} from "../../lib/admin-shared";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface PermissionCheckTesterProps {
  gameId: string;
}

const INITIAL_STATE: CheckPermissionResult = { ok: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Resolving..." : "Run check"}
    </Button>
  );
}

export function PermissionCheckTester({ gameId }: PermissionCheckTesterProps) {
  const [state, formAction] = useActionState(checkPermissionAction, INITIAL_STATE);
  const userIdId = useId();
  const groupIdId = useId();
  const permissionId = useId();

  const echoedInputs = state.ok ? state.inputs : (state.inputs ?? null);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resolve a (user, group, permission) triple</CardTitle>
          <CardDescription>
            Returns the same answer the dev's runtime <code className="font-mono">junjo.can()</code>{" "}
            call sees. Reads through the same in-process cache mutations invalidate, so a recent
            grant or revoke shows up immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="gameId" value={gameId} />
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor={userIdId}>External user id</Label>
                <Input
                  id={userIdId}
                  name="userId"
                  required
                  defaultValue={echoedInputs?.userId ?? ""}
                  placeholder="user_2abc..."
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={groupIdId}>Group id</Label>
                <Input
                  id={groupIdId}
                  name="groupId"
                  required
                  defaultValue={echoedInputs?.groupId ?? ""}
                  placeholder="grp_..."
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={permissionId}>Permission key</Label>
                <Input
                  id={permissionId}
                  name="permission"
                  required
                  maxLength={ADMIN_PERMISSION_KEY_MAX_LENGTH}
                  defaultValue={echoedInputs?.permission ?? ""}
                  placeholder="invite_member"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </div>
            </div>
            {!state.ok && state.error ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {state.error}
              </div>
            ) : null}
            <div className="flex justify-end">
              <SubmitButton />
            </div>
          </form>
        </CardContent>
      </Card>
      {state.ok ? <ResultPanel result={state.result} inputs={state.inputs} /> : null}
    </div>
  );
}

interface ResultPanelProps {
  result: AdminPermissionCheckResult;
  inputs: { userId: string; groupId: string; permission: string };
}

function ResultPanel({ result, inputs }: ResultPanelProps) {
  const explanation = explainResult(result);
  const SourceIcon = sourceIcon(result.source);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Result</CardTitle>
          <Badge variant={result.allowed ? "default" : "destructive"}>
            {result.allowed ? "Allowed" : "Denied"}
          </Badge>
          <Badge variant="muted">
            <SourceIcon className="mr-1 h-3 w-3" aria-hidden />
            source: {result.source}
          </Badge>
          {result.viaRoleId ? (
            <Badge variant="outline" className="font-mono">
              viaRoleId: {result.viaRoleId}
            </Badge>
          ) : null}
        </div>
        <CardDescription>{explanation}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-xs md:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">External user id</dt>
            <dd className="mt-1 break-all font-mono">{inputs.userId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Group id</dt>
            <dd className="mt-1 break-all font-mono">{inputs.groupId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Permission key</dt>
            <dd className="mt-1 break-all font-mono">{inputs.permission}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function sourceIcon(source: AdminPermissionSource) {
  switch (source) {
    case "role":
      return CheckCircle2;
    case "override":
      return ShieldOff;
    case "default":
      return MinusCircle;
    case "none":
      return UserX;
    default:
      return XCircle;
  }
}

// Plain-English explanation rendered next to the result badge. The
// `role` and `override` branches surface the `allowed` flag because
// overrides can resolve in either direction ("Revoked by member-level
// override" needs to be distinct from "Granted by member-level
// override"); role grants are always positive in V1.
function explainResult(result: AdminPermissionCheckResult): string {
  switch (result.source) {
    case "role":
      return result.viaRoleId
        ? `Granted by role ${result.viaRoleId} (the highest-priority role this member has that grants the permission).`
        : "Granted by a role this member has.";
    case "override":
      return result.allowed
        ? "Granted by member-level override (the override sits above any role-derived rule)."
        : "Revoked by member-level override (the override sits above any role-derived rule).";
    case "default":
      return "Active member with no role-derived grant and no override - permission denied by default.";
    case "none":
      return "Not a member of the group, or member is not in active status. The user has no effective standing here.";
    default:
      return "Unknown source.";
  }
}
