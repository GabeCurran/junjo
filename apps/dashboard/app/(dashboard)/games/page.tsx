// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Suspense } from "react";

import { CreateGameDialog } from "../../../components/dashboard/create-game-dialog";
import { GamesList } from "../../../components/dashboard/games-list";
import { PageHeader } from "../../../components/dashboard/page-header";

export const metadata = {
  title: "Games | Junjo Dashboard",
};

export default function GamesPage() {
  return (
    <>
      <PageHeader title="Games" actions={<CreateGameDialog />} />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="mx-auto max-w-screen-xl">
          <Suspense fallback={<div className="h-48 animate-pulse rounded bg-muted" />}>
            <GamesList />
          </Suspense>
        </div>
      </main>
    </>
  );
}
