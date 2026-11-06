// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";

import { cn } from "../../lib/utils";

// Tab navigation for the group detail page. The active tab is selected
// via a URL `?tab=` parameter that the page lenient-parses; switching is
// just an anchor `<Link>` so the browser's Back button restores prior
// tab state without per-tab JS state.
//
// Server Component on purpose: tabs do not need interactivity beyond
// navigation.

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
}

// Adding a tab means appending here plus extending the union above.
const TAB_DEFS: readonly TabDef[] = [
  { value: "members", label: "Members" },
  { value: "roles", label: "Roles" },
  { value: "permissions", label: "Permissions" },
  { value: "audit", label: "Audit" },
  { value: "relationships", label: "Relationships" },
  { value: "sub-groups", label: "Sub-groups" },
];

interface GroupDetailTabsProps {
  gameId: string;
  groupId: string;
  active: GroupDetailTab;
}

// The default tab uses the canonical URL (`?tab=` omitted) so the
// default view stays clean. Other tabs append `?tab=<value>`.
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
      className="flex items-center gap-6 overflow-x-auto whitespace-nowrap border-b border-border"
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
              "-mb-px inline-flex items-center border-b-2 pb-2 pt-1 text-sm font-medium transition-colors",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
