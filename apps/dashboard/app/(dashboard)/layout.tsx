// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";

import { MobileNav } from "../../components/dashboard/mobile-nav";
import { SidebarBrand, SidebarNav } from "../../components/dashboard/sidebar-nav";
import { ThemeToggle } from "../../components/theme-toggle";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
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
  );
}
