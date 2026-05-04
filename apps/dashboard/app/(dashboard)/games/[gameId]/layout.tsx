// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { CurrentGameWriter } from "../../../../components/dashboard/current-game-context";
import { AdminDisabledError, fetchAdminGame } from "../../../../lib/admin";

interface GameLayoutProps {
  params: Promise<{ gameId: string }>;
  children: ReactNode;
}

// Server-side gate for every /games/<gameId>/... surface. Resolves the
// game once per request and either:
//   - 404s the entire subtree when the gameId does not map to a real game
//     (so the dashboard chrome no longer "looks normal" on a stale URL); or
//   - mounts <CurrentGameWriter> so the parent layout's SidebarNav can show
//     the actual game name in place of the literal "Current game" label.
//
// On AdminDisabledError or other transient errors we render children
// unchanged (the page itself surfaces a friendlier error card) and skip
// the writer; the sidebar section then hides cleanly instead of showing
// a misleading partial state.
export default async function GameLayout({ params, children }: GameLayoutProps) {
  const { gameId } = await params;
  let gameName: string;
  try {
    const game = await fetchAdminGame(gameId);
    gameName = game.name;
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return <>{children}</>;
    }
    if (err instanceof Error && /not.?found/i.test(err.message)) {
      notFound();
    }
    return <>{children}</>;
  }
  return (
    <>
      <CurrentGameWriter gameName={gameName} />
      {children}
    </>
  );
}
