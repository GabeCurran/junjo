// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import {
  Activity,
  ArrowLeft,
  BarChart3,
  FolderTree,
  Gamepad2,
  Home,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "../../lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Home;
}

const GLOBAL_NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/games", label: "Games", icon: Gamepad2 },
];

function buildGameNavItems(gameId: string): readonly NavItem[] {
  const safe = encodeURIComponent(gameId);
  return [
    { href: `/games/${safe}`, label: "Game overview", icon: Users },
    { href: `/games/${safe}/groups`, label: "Groups", icon: FolderTree },
    { href: `/games/${safe}/audit`, label: "Audit log", icon: ScrollText },
    { href: `/games/${safe}/analytics`, label: "Analytics", icon: BarChart3 },
    { href: `/games/${safe}/permissions/check`, label: "Permission check", icon: ShieldCheck },
  ];
}

// Extract gameId when on /games/<gameId> or /games/<gameId>/...
// Returns null on /games (the list view) and on every non-game route.
function gameIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/games\/([^/]+)(?:\/|$)/);
  if (!match || match[1] === undefined) return null;
  return decodeURIComponent(match[1]);
}

interface NavLinkProps {
  item: NavItem;
  active: boolean;
}

function NavLink({ item, active }: NavLinkProps) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {item.label}
    </Link>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const gameId = gameIdFromPath(pathname);

  return (
    <nav className="flex flex-col gap-1 p-3">
      {GLOBAL_NAV_ITEMS.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        // Suppress the Games top-level highlight when inside a specific
        // game - the per-game section below carries the active context
        // and a doubly-highlighted sidebar reads as broken.
        const suppressed = item.href === "/games" && gameId !== null;
        return <NavLink key={item.href} item={item} active={active && !suppressed} />;
      })}

      {gameId !== null ? (
        <>
          <div className="mt-4 mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            Current game
          </div>
          {buildGameNavItems(gameId).map((item) => {
            // Exact-match active for game overview to avoid highlighting
            // it on every nested route; prefix-match for the rest.
            const overviewHref = `/games/${encodeURIComponent(gameId)}`;
            const active =
              item.href === overviewHref
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return <NavLink key={item.href} item={item} active={active} />;
          })}
          <NavLink item={{ href: "/games", label: "All games", icon: ArrowLeft }} active={false} />
        </>
      ) : null}
    </nav>
  );
}

export function SidebarBrand() {
  return (
    <div className="flex h-14 items-center gap-2 border-b border-border px-5">
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Activity className="h-4 w-4" aria-hidden />
      </div>
      <span className="text-base font-semibold tracking-tight">Junjo</span>
    </div>
  );
}
