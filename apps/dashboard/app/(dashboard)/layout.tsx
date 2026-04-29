// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";

import { SidebarBrand, SidebarNav } from "../../components/dashboard/sidebar-nav";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-card md:block">
        <SidebarBrand />
        <SidebarNav />
      </aside>
      <div className="flex min-h-screen flex-1 flex-col">{children}</div>
    </div>
  );
}
