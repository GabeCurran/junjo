// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { Ban, Sanction } from "@junjo.io/sdk";
import Link from "next/link";

import { PageHeader } from "../../../../../components/dashboard/page-header";
import { Notice, Section } from "../../../../../components/ui/section";
import { AdminDisabledError } from "../../../../../lib/admin";
import { gameClient } from "../../../../../lib/game-client";
import { until } from "../../../../../lib/moderation";

export const metadata = {
  title: "Moderation | Junjo Dashboard",
};

interface PageProps {
  params: Promise<{ gameId: string }>;
}

const PAGE = 100;

export default async function ModerationPage(props: PageProps) {
  const { gameId } = await props.params;
  const players = `/games/${encodeURIComponent(gameId)}/players`;

  let bans: Ban[];
  let sanctions: Sanction[];
  let moreBans: boolean;
  let moreSanctions: boolean;
  try {
    const junjo = gameClient(gameId);
    const [b, s] = await Promise.all([
      junjo.bans.list({ limit: PAGE }),
      junjo.sanctions.list({ limit: PAGE }),
    ]);
    bans = b.items;
    sanctions = s.items;
    moreBans = b.nextCursor !== null;
    moreSanctions = s.nextCursor !== null;
  } catch (err) {
    return (
      <>
        <PageHeader title="Moderation" />
        <main className="flex-1 px-6 pb-12 pt-4">
          <Notice
            title="Could not load moderation"
            body={
              err instanceof AdminDisabledError
                ? "Set JUNJO_ADMIN_TOKEN on the dashboard and the server to see bans and sanctions."
                : err instanceof Error
                  ? err.message
                  : "The moderation request failed."
            }
          />
        </main>
      </>
    );
  }

  const playerLink = (userId: string) => (
    <Link
      href={`${players}/${encodeURIComponent(userId)}`}
      className="break-all font-mono text-xs hover:underline"
    >
      {userId}
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Moderation"
        meta="Ban, sanction or lift from a player's page."
        actions={
          <Link href={players} className="text-sm text-primary hover:underline">
            Find a player
          </Link>
        }
      />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="flex max-w-screen-xl flex-col gap-10">
          <Section title={`Banned from the game (${bans.length}${moreBans ? "+" : ""})`}>
            {bans.length === 0 ? (
              <Notice title="Nobody is banned" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Player</th>
                    <th className="py-2 pr-4 font-medium">Reason</th>
                    <th className="py-2 pr-4 font-medium">Length</th>
                    <th className="hidden py-2 font-medium md:table-cell">By</th>
                  </tr>
                </thead>
                <tbody>
                  {bans.map((b) => (
                    <tr key={b.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2 pr-4">{playerLink(b.userId)}</td>
                      <td className="py-2 pr-4">
                        {b.reason ?? <span className="text-muted-foreground">-</span>}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {until(b.expiresAt?.toISOString() ?? null)}
                      </td>
                      <td className="hidden py-2 text-muted-foreground md:table-cell">
                        {b.issuer ?? b.bannedBy ?? "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title={`Active sanctions (${sanctions.length}${moreSanctions ? "+" : ""})`}>
            {sanctions.length === 0 ? (
              <Notice title="No active sanctions" />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Player</th>
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">Reason</th>
                    <th className="py-2 pr-4 font-medium">Length</th>
                    <th className="hidden py-2 font-medium md:table-cell">By</th>
                  </tr>
                </thead>
                <tbody>
                  {sanctions.map((s) => (
                    <tr key={s.id} className="border-b border-border/60 last:border-0">
                      <td className="py-2 pr-4">{playerLink(s.userId)}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{s.type}</td>
                      <td className="py-2 pr-4">
                        {s.reason ?? <span className="text-muted-foreground">-</span>}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {until(s.expiresAt?.toISOString() ?? null)}
                      </td>
                      <td className="hidden py-2 text-muted-foreground md:table-cell">
                        {s.issuer ?? s.issuedBy ?? "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>
      </main>
    </>
  );
}
