// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";

import { ThemeToggle } from "../theme-toggle";

interface TopbarProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function Topbar({ title, description, actions }: TopbarProps) {
  return (
    <header className="flex min-h-14 flex-col gap-2 border-b border-border bg-background/80 px-6 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-0">
      <div className="flex min-w-0 flex-col">
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}
