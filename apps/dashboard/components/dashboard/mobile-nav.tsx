// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Activity, Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { SidebarNav } from "./sidebar-nav";

// Mobile-only top bar + slide-out drawer. Renders nothing on >=md screens.
// The desktop sidebar in (dashboard)/layout.tsx is already hidden below md
// (hidden md:block); this fills the gap so mobile users can navigate.
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer on route change so picking a link auto-dismisses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not consumed inside the effect body.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes; body scroll locks while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      {/* Mobile top bar (visible only below md) */}
      <div className="flex h-14 items-center justify-between border-b border-border bg-card px-4 md:hidden">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Activity className="h-4 w-4" aria-hidden />
          </div>
          <span className="text-base font-semibold tracking-tight">Junjo</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {/* Drawer overlay - mounted only when open so transitions are simple.
       * Treated as a navigation region rather than a dialog: it slides in
       * over content but does not trap focus or block the rest of the page
       * the way a modal would. The Escape handler + backdrop-click + body
       * scroll lock provide the modal-ish behavior callers want without
       * needing a full ARIA dialog. */}
      {open && (
        <nav
          id="mobile-nav-drawer"
          className="fixed inset-0 z-50 md:hidden"
          aria-label="Site navigation"
        >
          {/* Backdrop. Click closes the drawer. Labelled via aria-hidden so
           * screen readers focus the panel content, not the dimmer. */}
          <button
            type="button"
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            tabIndex={-1}
          />
          {/* Drawer panel: slides in from the left. Width tops out at 80vw
           * so even on small phones the close button stays in reach. */}
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[80vw] flex-col border-r border-border bg-card shadow-lg">
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Activity className="h-4 w-4" aria-hidden />
                </div>
                <span className="text-base font-semibold tracking-tight">Junjo</span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <SidebarNav />
          </div>
        </nav>
      )}
    </>
  );
}
