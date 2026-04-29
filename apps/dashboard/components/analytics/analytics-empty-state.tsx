// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowUpRight, BarChart3 } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

interface AnalyticsEmptyStateProps {
  // The base URL for the docs site, or null when the operator has not set
  // JUNJO_DOCS_BASE_URL. When null, the empty state renders a text hint
  // pointing at `/tutorial` rather than a broken hyperlink.
  docsBaseUrl: string | null;
}

// "No data yet" shell shown by the analytics surface in Phase 12.1 before any
// chart components land in 12.2 - 12.5. The shell is intentionally
// chart-shaped (header + body + tutorial CTA) so that swapping in a real
// chart in a later iteration only requires replacing the body, not the
// surrounding card. The page server decides which empty state to render
// (this generic one when the game has zero audit entries; chart-specific
// empty states later when individual queries return zero rows).
export function AnalyticsEmptyState({ docsBaseUrl }: AnalyticsEmptyStateProps) {
  return (
    <Card className="border-dashed">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary">
          <BarChart3 className="h-4 w-4 text-secondary-foreground" aria-hidden />
        </div>
        <div className="flex-1 space-y-1.5">
          <CardTitle className="text-base">No data yet</CardTitle>
          <CardDescription>
            Analytics charts populate from this game's audit log and group / member tables. They
            turn on automatically the first time real members join, leave, or change roles.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-border bg-muted/30 p-4 text-sm leading-6 text-muted-foreground">
          <p className="font-medium text-foreground">Charts that land in 12.2 - 12.5</p>
          <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs">
            <li>Group churn distribution (kicked + left members, binned by tenure)</li>
            <li>Group growth over time (cumulative active member count, top 5)</li>
            <li>Member activity heatmap (24 x 7 grid of audit-entry density)</li>
            <li>Role distribution + most-used permission keys</li>
          </ul>
        </div>
        {docsBaseUrl !== null ? (
          <a
            href={`${docsBaseUrl}/tutorial`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Follow the 5-minute tutorial
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set{" "}
            <span className="rounded bg-muted px-1 font-mono text-[11px]">JUNJO_DOCS_BASE_URL</span>{" "}
            on this dashboard to deep-link operators at the 5-minute tutorial. Until then, see the{" "}
            <span className="font-mono">/tutorial</span> page on your docs site.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
