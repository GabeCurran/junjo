// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

interface SectionProps {
  title: ReactNode;
  // One line under the title, only when the section needs it.
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

// A titled block of a page. Sections sit on the page itself; a bordered
// panel is kept for things that are one object, such as a form.
export function Section({ title, meta, actions, className, children }: SectionProps) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border pb-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-tight">{title}</h2>
          {meta ? <p className="mt-0.5 text-sm text-muted-foreground">{meta}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

// An empty or failed state inside a section: what is going on, and what to do.
export function Notice({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm">
      <p className="font-medium">{title}</p>
      {body ? <p className="mt-1 text-muted-foreground">{body}</p> : null}
    </div>
  );
}
