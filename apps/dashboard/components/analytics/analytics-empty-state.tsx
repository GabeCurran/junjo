// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { ReactNode } from "react";

import { Notice } from "../ui/section";

// The one-line empty state inside a chart section: what would fill it.
export function ChartEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

interface AnalyticsEmptyStateProps {
  // The docs site base URL; the page only renders this when it is set.
  docsBaseUrl: string;
}

// Shown under the charts when the game has no data in any of them.
export function AnalyticsEmptyState({ docsBaseUrl }: AnalyticsEmptyStateProps) {
  return (
    <Notice
      title="No data yet"
      body={
        <>
          The charts fill as members join, leave and get roles.{" "}
          <a
            href={`${docsBaseUrl}/tutorial`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Open the tutorial
          </a>
        </>
      }
    />
  );
}
