// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Activity, BarChart3, Gamepad2, Home, ScrollText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "../../lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Home;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/games", label: "Games", icon: Gamepad2 },
  { href: "/audit", label: "Audit", icon: ScrollText },
  { href: "/permissions", label: "Permissions", icon: ShieldCheck },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
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
      })}
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
