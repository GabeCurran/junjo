// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";

const INTERVAL_MS = 5000;

// Re-renders the page's server data on an interval while switched on
// and the tab is visible. Off by default; the choice is remembered.
export function LiveRefresh({ storageKey }: { storageKey: string }) {
  const router = useRouter();
  const [live, setLive] = useState(false);

  useEffect(() => {
    try {
      setLive(window.localStorage.getItem(storageKey) === "1");
    } catch {
      // Storage can be unavailable; live then starts off.
    }
  }, [storageKey]);

  useEffect(() => {
    if (!live) return;
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = window.setInterval(tick, INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [live, router]);

  const toggle = () => {
    const next = !live;
    setLive(next);
    try {
      window.localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      // Not remembered; the toggle still works for this visit.
    }
  };

  return (
    <button
      type="button"
      aria-pressed={live}
      onClick={toggle}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        live
          ? "border-allow/50 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
      title={live ? "Updating every 5 seconds" : "Update this list every 5 seconds"}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          live ? "bg-allow motion-safe:animate-pulse" : "bg-muted-foreground",
        )}
      />
      Live
    </button>
  );
}
