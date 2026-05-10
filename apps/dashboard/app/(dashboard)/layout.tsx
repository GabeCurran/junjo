// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";

// Every dashboard page reads runtime env (JUNJO_BASE_URL, JUNJO_ADMIN_TOKEN,
// JUNJO_ADMIN_API_KEY) via loadDashboardEnv(). With Next's default
// auto-static-detection, the home page would render at build time when
// those vars aren't yet injected by the orchestrator, baking a
// "JUNJO_ADMIN_API_KEY: Required" error into the static HTML that
// ISR-revalidates only every 60s. Forcing dynamic on the layout makes
// every dashboard route render per-request against the live env.
export const dynamic = "force-dynamic";

import { CurrentGameProvider } from "../../components/dashboard/current-game-context";
import { MobileNav } from "../../components/dashboard/mobile-nav";
import { SidebarBrand, SidebarNav } from "../../components/dashboard/sidebar-nav";
import { ThemeToggle } from "../../components/theme-toggle";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <CurrentGameProvider>
      <div className="flex min-h-screen">
        {/* Desktop sidebar (>=md). Mobile users get the drawer in <MobileNav>. */}
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
          <SidebarBrand />
          <div className="flex-1 overflow-y-auto">
            <SidebarNav />
          </div>
          <div className="flex items-center justify-end border-t border-border px-3 py-2">
            <ThemeToggle />
          </div>
        </aside>
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <MobileNav />
          {children}
        </div>
      </div>
    </CurrentGameProvider>
  );
}
