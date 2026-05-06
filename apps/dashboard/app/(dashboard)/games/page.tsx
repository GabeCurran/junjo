// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Suspense } from "react";

import { CreateGameDialog } from "../../../components/dashboard/create-game-dialog";
import { GamesList } from "../../../components/dashboard/games-list";
import { Topbar } from "../../../components/dashboard/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";

export const metadata = {
  title: "Games | Junjo Dashboard",
};

function GamesListSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-40 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-border py-3 last:border-0"
            >
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="flex gap-6">
                <div className="h-4 w-10 rounded bg-muted" />
                <div className="h-4 w-12 rounded bg-muted" />
                <div className="h-4 w-10 rounded bg-muted" />
                <div className="h-4 w-20 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function GamesPage() {
  return (
    <>
      <Topbar
        title="Games"
        description="Every game registered on this Junjo deployment."
        actions={<CreateGameDialog />}
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-screen-2xl">
          <Suspense fallback={<GamesListSkeleton />}>
            <GamesList />
          </Suspense>
        </div>
      </main>
    </>
  );
}
