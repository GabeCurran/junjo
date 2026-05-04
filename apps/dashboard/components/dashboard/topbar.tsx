// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";

interface TopbarProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

// Topbar is mobile-only. On desktop the sidebar carries nav identity
// AND a ThemeToggle in its footer, so the topbar's role (page title +
// page-level actions + theme toggle) collapses into the page body's
// inline H1 (when needed) and the sidebar. Rendering this at >= md
// would just create a redundant horizontal strip.
export function Topbar({ title, description, actions }: TopbarProps) {
  return (
    <header className="flex min-h-14 flex-col gap-2 border-b border-border bg-background/80 px-6 py-3 backdrop-blur md:hidden">
      <div className="flex min-w-0 flex-col">
        <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
