// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";

import { cn } from "../../lib/utils";

// Phase 11.6b + 11.6c + 11.7a-ii + 11.7b-ii + 11.7c-ii: tab navigation
// for the group detail page. Six tabs ship today (Members + Roles +
// Permissions + Audit + Relationships + Sub-groups). The active tab is
// selected via a URL `?tab=` parameter that the page lenient-parses;
// switching is just an anchor `<Link>` so the browser's Back button
// restores prior tab state without per-tab JS state.
//
// Server Component on purpose: tabs do not need interactivity beyond
// navigation, and rendering them server-side keeps the bundle smaller and
// matches the page's overall composition (Suspense boundaries + Server
// Components + occasional Client islands).

export const GROUP_DETAIL_TABS = [
  "members",
  "roles",
  "permissions",
  "audit",
  "relationships",
  "sub-groups",
] as const;
export type GroupDetailTab = (typeof GROUP_DETAIL_TABS)[number];

export const GROUP_DETAIL_DEFAULT_TAB: GroupDetailTab = "members";

interface TabDef {
  value: GroupDetailTab;
  label: string;
  description: string;
}

// `description` populates the topbar when this tab is active. Adding new
// tabs means appending to this array plus extending the union above.
const TAB_DEFS: readonly TabDef[] = [
  {
    value: "members",
    label: "Members",
    description: "Members in this group, with their assigned roles and lifecycle status.",
  },
  {
    value: "roles",
    label: "Roles",
    description: "Roles defined for this group, ordered by priority.",
  },
  {
    value: "permissions",
    label: "Permissions",
    description:
      "Matrix of role permissions. Toggle a cell to grant or revoke a permission key for a role.",
  },
  {
    value: "audit",
    label: "Audit",
    description:
      "Every state change in this group, newest first. Filter by action and page through history.",
  },
  {
    value: "relationships",
    label: "Relationships",
    description:
      "Outgoing directed links from this group to others in the same game. Set, edit, or clear ally / rival / vassal relationships.",
  },
  {
    value: "sub-groups",
    label: "Sub-groups",
    description:
      "This group's place in the hierarchy. View and edit the parent assignment and direct children.",
  },
];

export function getTabDescription(tab: GroupDetailTab): string {
  return TAB_DEFS.find((t) => t.value === tab)?.description ?? "";
}

interface GroupDetailTabsProps {
  gameId: string;
  groupId: string;
  active: GroupDetailTab;
}

// The `Members` tab uses the canonical URL (`?tab=` omitted) so the
// existing bookmarks from Phase 11.5b still resolve to the same view.
// Other tabs append `?tab=<value>`; the URL stays clean for the default
// case.
function buildTabHref(gameId: string, groupId: string, tab: GroupDetailTab): string {
  const base = `/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}`;
  if (tab === GROUP_DETAIL_DEFAULT_TAB) return base;
  return `${base}?tab=${tab}`;
}

export function GroupDetailTabs({ gameId, groupId, active }: GroupDetailTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Group sections"
      className="flex items-center gap-1 border-b border-border"
    >
      {TAB_DEFS.map((tab) => {
        const isActive = tab.value === active;
        return (
          <Link
            key={tab.value}
            role="tab"
            aria-selected={isActive}
            href={buildTabHref(gameId, groupId, tab.value)}
            className={cn(
              "inline-flex items-center px-4 py-2 text-sm font-medium transition-colors",
              "border-b-2 -mb-px",
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
