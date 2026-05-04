// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Activity } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { ThemeToggle } from "../theme-toggle";
import { SidebarNav } from "./sidebar-nav";

// Mobile-only top bar + drop-down nav. Renders nothing on >=md screens.
// The desktop sidebar in (dashboard)/layout.tsx is hidden below md
// (hidden md:block); this fills the gap. Pattern mirrors ../starworks/src
// /components/Header.tsx: hamburger morphs to X on tap, the menu slides
// down from below the top bar with origin-top scale + max-h transition.
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
      {/* Mobile top bar (visible only below md). Sticky so the hamburger
       * stays reachable as the page scrolls. z-50 sits above the drawer's
       * z-40 so the burger->X morph remains clickable when the menu is
       * open. */}
      <div className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border bg-card px-4 md:hidden">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Activity className="h-4 w-4" aria-hidden />
          </div>
          <span className="text-base font-semibold tracking-tight">Junjo</span>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-transform duration-150 hover:bg-accent hover:text-accent-foreground active:scale-90"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
        >
          {/* SVG path swap matches starworks: hamburger -> X without an icon flicker. */}
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            role="img"
            aria-label={open ? "Close" : "Menu"}
          >
            {open ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            )}
          </svg>
        </button>
        </div>
      </div>

      {/* Backdrop. Click anywhere on the dimmed page below the menu closes
       * it. Always mounted so it can transition; pointer-events-none when
       * closed so it never blocks taps on the page underneath. */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close navigation"
        tabIndex={open ? 0 : -1}
        className={`fixed inset-0 top-14 z-30 bg-background/80 backdrop-blur-sm transition-opacity duration-300 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Drop-down menu. Sits below the sticky top bar (top-14), full
       * width. Outer container clips with overflow-hidden + max-h
       * transitioning from 0 to 80vh - this is the actual "drop down"
       * motion (the menu's bottom edge sweeps downward over ~250ms).
       * The inner panel additionally translates from -8px to 0 to add
       * a subtle slide-in feel as it appears. Opacity removed: it was
       * what made the previous version look like a fade. */}
      <nav
        id="mobile-nav-drawer"
        aria-label="Site navigation"
        className={`fixed left-0 right-0 top-14 z-40 overflow-hidden transition-[max-height] duration-300 ease-out md:hidden ${
          open ? "max-h-[80vh]" : "pointer-events-none max-h-0"
        }`}
      >
        <div
          className={`border-b border-border bg-card shadow-lg transition-transform duration-300 ease-out ${
            open ? "translate-y-0" : "-translate-y-2"
          }`}
        >
          <SidebarNav />
        </div>
      </nav>
    </>
  );
}
