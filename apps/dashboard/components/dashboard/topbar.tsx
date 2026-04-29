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
    <header className="flex h-14 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur">
      <div className="flex flex-col">
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}
