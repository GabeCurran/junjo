// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { useCurrentGameName } from "./current-game-context";

export interface NavGame {
  id: string;
  name: string;
}

interface NavItem {
  href: string;
  label: string;
  // Exact match only; otherwise nested routes also mark the item active.
  exact?: boolean;
}

const GLOBAL_NAV_ITEMS: readonly NavItem[] = [
  { href: "/overview", label: "Overview" },
  { href: "/games", label: "Games", exact: true },
];

function buildGameNavItems(gameId: string): readonly NavItem[] {
  const base = `/games/${encodeURIComponent(gameId)}`;
  return [
    { href: base, label: "Game overview", exact: true },
    { href: `${base}/players`, label: "Players" },
    { href: `${base}/moderation`, label: "Moderation" },
    { href: `${base}/groups`, label: "Groups" },
    { href: `${base}/audit`, label: "Audit log" },
    { href: `${base}/permissions/check`, label: "Permission check" },
    { href: `${base}/analytics`, label: "Analytics" },
    { href: `${base}/settings`, label: "Settings" },
  ];
}

// The game id of /games/<gameId> and everything under it; null on the
// game list and on every other route.
function gameIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/games\/([^/]+)(?:\/|$)/);
  if (!match || match[1] === undefined) return null;
  return decodeURIComponent(match[1]);
}

function isActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.href) return true;
  return !item.exact && pathname.startsWith(`${item.href}/`);
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative block rounded-sm px-3 py-1.5 text-sm transition-colors",
        active
          ? "font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {item.label}
    </Link>
  );
}

function GameSwitcher({ games, gameId }: { games: readonly NavGame[]; gameId: string | null }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDetailsElement>(null);
  const contextName = useCurrentGameName();
  const current = gameId === null ? undefined : games.find((g) => g.id === gameId);
  const label = current?.name ?? (gameId !== null ? contextName : null);

  // Picking a game navigates; fold the list away when the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not read inside.
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  return (
    <details ref={ref} className="group relative">
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-accent [&::-webkit-details-marker]:hidden"
        aria-label="Switch game"
      >
        <span className={cn("truncate", label ? "font-medium" : "text-muted-foreground")}>
          {label ?? "Choose a game"}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </summary>
      <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
        {games.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No games yet</p>
        ) : (
          games.map((g) => (
            <Link
              key={g.id}
              href={`/games/${encodeURIComponent(g.id)}`}
              className="flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            >
              <span className="truncate">{g.name}</span>
              {g.id === gameId ? (
                <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              ) : null}
            </Link>
          ))
        )}
      </div>
    </details>
  );
}

export function SidebarNav({ games }: { games: readonly NavGame[] }) {
  const pathname = usePathname();
  const gameId = gameIdFromPath(pathname);
  // Set by [gameId]/layout.tsx once the game resolves; null outside a
  // game and on an unknown id, which hides the game's menu.
  const gameName = useCurrentGameName();
  const inGame = gameId !== null && gameName !== null;

  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-5 p-3">
      <div className="flex flex-col gap-0.5">
        {GLOBAL_NAV_ITEMS.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item, pathname)} />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <GameSwitcher games={games} gameId={gameId} />
        {inGame ? (
          <div className="flex flex-col gap-0.5">
            {buildGameNavItems(gameId).map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item, pathname)} />
            ))}
          </div>
        ) : null}
      </div>
    </nav>
  );
}

export function SidebarBrand({ className }: { className?: string }) {
  return (
    <Link
      href="/overview"
      className={cn(
        "flex h-14 items-center gap-2 px-5 font-condensed text-xl font-bold tracking-tight",
        className,
      )}
    >
      <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-primary" />
      Junjo
    </Link>
  );
}
