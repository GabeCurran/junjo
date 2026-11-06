// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  // One short line under the title: ids, counts, where you are.
  meta?: ReactNode;
  actions?: ReactNode;
}

// The first thing on every dashboard page, at every width.
export function PageHeader({ title, meta, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-3 px-6 pb-2 pt-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate font-condensed text-3xl font-semibold tracking-tight">{title}</h1>
        {meta ? <div className="mt-1 text-sm text-muted-foreground">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
