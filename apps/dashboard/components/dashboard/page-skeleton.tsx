// @license All Rights Reserved (see apps/dashboard/LICENSE)

// The shape of a dashboard page while it loads: a header in the same
// spacing as PageHeader, a row of figures, and a section of rows. Quiet
// muted blocks only, so a fast page swap does not flash.
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="flex flex-1 flex-col">
      <span className="sr-only">Loading</span>
      <header className="flex flex-col gap-3 px-6 pb-2 pt-8" aria-hidden>
        <div className="h-9 w-64 max-w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      </header>
      <main className="flex-1 px-6 pb-12 pt-4" aria-hidden>
        <div className="flex max-w-screen-xl flex-col gap-10">
          <div className="flex flex-wrap gap-x-12 gap-y-4">
            {["a", "b", "c"].map((k) => (
              <div key={k} className="flex flex-col gap-2">
                <div className="h-7 w-20 animate-pulse rounded bg-muted" />
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <div className="h-6 w-40 animate-pulse rounded bg-muted" />
            <div className="border-b border-border" />
            {["a", "b", "c", "d", "e"].map((k) => (
              <div key={k} className="flex items-center gap-6 border-b border-border/60 py-3">
                <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
                <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
