// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import { type GroupId, type Junjo, JunjoError, type UserId } from "@junjo.io/sdk";
import { revalidatePath } from "next/cache";

import { AdminDisabledError, kickAdminGroupMember } from "../../../../../lib/admin";
import { gameClient } from "../../../../../lib/game-client";

type RoleId = Parameters<Junjo["members"]["assignRole"]>[2];

export interface PlayerActionResult {
  ok: boolean;
  error?: string;
}

// Who the server records as having issued a ban or sanction made here.
const ISSUER = "dashboard";

function playerPath(gameId: string, userId: string): string {
  return `/games/${encodeURIComponent(gameId)}/players/${encodeURIComponent(userId)}`;
}

function failure(err: unknown): PlayerActionResult {
  if (err instanceof AdminDisabledError) {
    return { ok: false, error: "Set JUNJO_ADMIN_TOKEN on the dashboard to change players." };
  }
  if (err instanceof JunjoError && err.code === "precondition_failed") {
    return {
      ok: false,
      error:
        "Someone changed this player's moderation since the page loaded. Reload and try again.",
    };
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// `expiresIn` is a number of hours, or null for no end.
function expiry(expiresIn: number | null): Date | null {
  return expiresIn === null ? null : new Date(Date.now() + expiresIn * 60 * 60 * 1000);
}

export async function banPlayerAction(
  gameId: string,
  userId: UserId,
  input: { reason: string; expiresIn: number | null; version: number },
): Promise<PlayerActionResult> {
  try {
    await gameClient(gameId).bans.add(
      {
        userId,
        reason: input.reason.trim() || null,
        expiresAt: expiry(input.expiresIn),
        issuer: ISSUER,
      },
      { ifMatch: input.version },
    );
  } catch (err) {
    return failure(err);
  }
  revalidatePath(playerPath(gameId, userId));
  return { ok: true };
}

export async function liftBanAction(
  gameId: string,
  userId: UserId,
  version: number,
): Promise<PlayerActionResult> {
  try {
    await gameClient(gameId).bans.remove(userId, { ifMatch: version });
  } catch (err) {
    return failure(err);
  }
  revalidatePath(playerPath(gameId, userId));
  return { ok: true };
}

export async function addSanctionAction(
  gameId: string,
  userId: UserId,
  input: { type: string; reason: string; expiresIn: number | null; version: number },
): Promise<PlayerActionResult> {
  try {
    await gameClient(gameId).sanctions.add(
      userId,
      {
        type: input.type.trim(),
        reason: input.reason.trim() || null,
        expiresAt: expiry(input.expiresIn),
        issuer: ISSUER,
      },
      { ifMatch: input.version },
    );
  } catch (err) {
    return failure(err);
  }
  revalidatePath(playerPath(gameId, userId));
  return { ok: true };
}

export async function liftSanctionAction(
  gameId: string,
  userId: UserId,
  type: string,
  version: number,
): Promise<PlayerActionResult> {
  try {
    await gameClient(gameId).sanctions.remove(userId, type, { ifMatch: version });
  } catch (err) {
    return failure(err);
  }
  revalidatePath(playerPath(gameId, userId));
  return { ok: true };
}

export async function setDisplayNameAction(
  gameId: string,
  pagePlayerId: string,
  userId: UserId,
  displayName: string | null,
): Promise<PlayerActionResult> {
  try {
    await gameClient(gameId).identities.setDisplayName(userId, displayName);
  } catch (err) {
    return failure(err);
  }
  revalidatePath(playerPath(gameId, pagePlayerId));
  return { ok: true };
}

// Membership writes carry the member version the page loaded, so a
// change made elsewhere in the meantime is refused, not overwritten.
export async function assignRoleAction(
  gameId: string,
  pagePlayerId: string,
  groupId: string,
  userId: UserId,
  roleId: string,
  version: number,
): Promise<PlayerActionResult> {
  try {
    await gameClient(gameId).members.assignRole(groupId as GroupId, userId, roleId as RoleId, {
      ifMatch: version,
    });
  } catch (err) {
    return failure(err);
  }
  revalidatePath(playerPath(gameId, pagePlayerId));
  return { ok: true };
}

export async function removeRoleAction(
  gameId: string,
  pagePlayerId: string,
  groupId: string,
  userId: UserId,
  roleId: string,
  version: number,
): Promise<PlayerActionResult> {
  try {
    await gameClient(gameId).members.removeRole(groupId as GroupId, userId, roleId as RoleId, {
      ifMatch: version,
    });
  } catch (err) {
    return failure(err);
  }
  revalidatePath(playerPath(gameId, pagePlayerId));
  return { ok: true };
}

export async function kickFromGroupAction(
  gameId: string,
  pagePlayerId: string,
  groupId: string,
  userId: UserId,
  reason: string,
): Promise<PlayerActionResult> {
  try {
    const trimmed = reason.trim();
    await kickAdminGroupMember(gameId, groupId, userId, trimmed ? { reason: trimmed } : {});
  } catch (err) {
    return failure(err);
  }
  revalidatePath(playerPath(gameId, pagePlayerId));
  return { ok: true };
}
