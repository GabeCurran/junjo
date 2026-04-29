// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Topbar } from "../../../components/dashboard/topbar";

export const metadata = {
  title: "Games | Junjo Dashboard",
};

export default function GamesPage() {
  return (
    <>
      <Topbar title="Games" description="Every game registered on this Junjo deployment." />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-5xl rounded-lg border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="text-lg font-semibold">Games list lands in Phase 11.3</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This page will let you create games, browse them, and rotate API keys.
          </p>
        </div>
      </main>
    </>
  );
}
