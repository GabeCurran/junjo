import type { Member, RoleChangedEvent } from "@junjo.io/shared";

// Member-row updates shared by the hooks that keep a member list in step
// with a group stream. Rows patched from an event take the event's
// `memberVersion`, so the `version` a caller reads is the one a
// conditional write expects.

// Inserts or replaces the row for `member`. The snapshot inside
// `member.joined` carries no `displayName`, so a replaced row keeps the
// name already loaded rather than losing it until the next refetch.
export function upsertJoined(members: readonly Member[], member: Member): Member[] {
  const idx = members.findIndex((m) => m.userId === member.userId);
  if (idx < 0) return [...members, member];
  const previous = members[idx];
  const next = members.slice();
  next[idx] =
    member.displayName !== undefined || previous?.displayName === undefined
      ? member
      : { ...member, displayName: previous.displayName };
  return next;
}

// The row after a `role.changed` event: removed roles dropped, added
// roles appended once.
export function withRoleChange(member: Member, event: RoleChangedEvent): Member {
  const removed = new Set<string>(event.removed);
  const remaining = member.roles.filter((r) => !removed.has(r));
  const additions = event.added.filter((r) => !remaining.includes(r));
  return { ...member, roles: [...remaining, ...additions], version: event.memberVersion };
}
