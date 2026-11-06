// @license All Rights Reserved (see apps/dashboard/LICENSE)

// Turns an audit entry into a short sentence. Pure and client-safe, so
// server feeds and client tables share it.

export type ActivityPart =
  | { kind: "text"; text: string }
  | { kind: "who"; text: string }
  | { kind: "place"; text: string; struck?: boolean }
  | { kind: "code"; text: string };

export interface ActivityInput {
  action: string;
  targetId: string | null;
  groupName?: string | null;
  groupSoftDeleted?: boolean;
  gameName?: string;
  payload: Record<string, unknown>;
}

const text = (t: string): ActivityPart => ({ kind: "text", text: t });

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// "Steve was kicked from House Vex": the subject, a verb phrase, then
// the place. Unknown actions fall back to the raw action name.
export function describeActivity(entry: ActivityInput): ActivityPart[] {
  const p = entry.payload;
  const who: ActivityPart = { kind: "who", text: entry.targetId ?? "someone" };
  const group: ActivityPart = {
    kind: "place",
    text: entry.groupName ?? "a group",
    struck: entry.groupSoftDeleted === true,
  };
  const game: ActivityPart = { kind: "place", text: entry.gameName ?? "the game" };
  const permission = str(p, "permission");
  const roleName = str(p, "roleName") ?? str(p, "name");

  switch (entry.action) {
    case "member.joined":
      return [who, text(" joined "), group];
    case "member.left":
      return [who, text(" left "), group];
    case "member.kicked":
      return [who, text(" was kicked from "), group];
    case "member.banned":
      return [who, text(" was banned from "), group];
    case "member.unbanned":
      return [who, text(" was unbanned from "), group];
    case "member.invited":
    case "invitation.created":
      return [who, text(" was invited to "), group];
    case "member.metadata.updated":
      return [text("Metadata changed for "), who, text(" in "), group];
    case "member.notes.updated":
      return [text("Notes changed for "), who, text(" in "), group];
    case "role.assigned":
    case "member.role.assigned":
      return [who, text(" was given a role in "), group];
    case "role.unassigned":
    case "member.role.unassigned":
      return [who, text(" lost a role in "), group];
    case "role.created":
      return roleName
        ? [text("Role "), { kind: "who", text: roleName }, text(" was created in "), group]
        : [text("A role was created in "), group];
    case "role.updated":
      return [text("A role was edited in "), group];
    case "role.deleted":
      return [text("A role was deleted in "), group];
    case "role.entries.changed":
      return [text("Role permissions changed in "), group];
    case "role.parents.set":
      return [text("Role inheritance changed in "), group];
    case "permission.granted":
    case "role.permission.granted":
      return permission
        ? [{ kind: "code", text: permission }, text(" was granted in "), group]
        : [text("A permission was granted in "), group];
    case "permission.revoked":
    case "role.permission.revoked":
      return permission
        ? [{ kind: "code", text: permission }, text(" was revoked in "), group]
        : [text("A permission was revoked in "), group];
    case "permission.override.set":
    case "member.permission.override.set":
      return [text("Override set for "), who, text(" in "), group];
    case "permission.override.cleared":
    case "member.permission.override.cleared":
      return [text("Override cleared for "), who, text(" in "), group];
    case "group.created":
      return [group, text(" was created")];
    case "group.updated":
      return [group, text(" was edited")];
    case "group.deleted":
      return [group, text(" was deleted")];
    case "group.restored":
      return [group, text(" was restored")];
    case "group.relationship.set":
      return [text("A relationship was set for "), group];
    case "group.relationship.cleared":
      return [text("A relationship was cleared for "), group];
    case "group.parent.set":
      return [group, text(" got a parent group")];
    case "group.parent.cleared":
      return [group, text(" lost its parent group")];
    case "game.user.banned":
      return [who, text(" was banned from "), game];
    case "game.user.unbanned":
      return [who, text(" was unbanned from "), game];
    case "game.user.sanctioned": {
      const type = str(p, "type");
      return [who, text(type ? ` got a ${type} sanction in ` : " was sanctioned in "), game];
    }
    case "game.user.unsanctioned": {
      const type = str(p, "type");
      return [
        who,
        text(type ? ` had a ${type} sanction lifted in ` : " had a sanction lifted in "),
        game,
      ];
    }
    case "identity.linked":
      return [who, text(" linked an identity in "), game];
    case "identity.unlinked":
      return [who, text(" unlinked an identity in "), game];
    case "game.permissions.mode.set":
      return [text("Permission mode changed for "), game];
    default:
      return [{ kind: "code", text: entry.action }, text(" in "), entry.groupName ? group : game];
  }
}

// The reason a moderator gave, for the actions that take one.
export function activityReason(entry: ActivityInput): string | null {
  if (
    entry.action === "member.kicked" ||
    entry.action === "member.banned" ||
    entry.action === "game.user.banned" ||
    entry.action === "game.user.sanctioned"
  ) {
    return str(entry.payload, "reason");
  }
  return null;
}

// Moderation actions get the danger tone in feeds.
export function isModerationAction(action: string): boolean {
  return (
    action === "member.kicked" ||
    action === "member.banned" ||
    action === "game.user.banned" ||
    action === "game.user.sanctioned"
  );
}

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto", style: "short" });
const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

// The largest unit that fits, or "now" under a minute.
export function relativeTime(iso: string, now = Date.now()): string {
  const delta = new Date(iso).getTime() - now;
  for (const { unit, ms } of UNITS) {
    if (Math.abs(delta) >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return "now";
}
