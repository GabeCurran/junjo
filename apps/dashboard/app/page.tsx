// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Mail } from "lucide-react";
import { JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { RoleChip } from "../components/ui/role-chip";

// Public marketing landing page. This is the ONLY route served without the
// Basic Auth gate (see middleware.ts): it is fully static (no runtime env,
// no data fetching), so Next prerenders it at build time and the admin
// dashboard stays private at /overview and friends.

// Code samples only; every other line of text uses the page's family.
const jbMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"] });

export const metadata = {
  title: "Junjo - The social layer for multiplayer games",
  description:
    "Groups, roles, permissions, friends, bans, sanctions and a live event stream for multiplayer games. SDKs for TypeScript, React, Java, Roblox, C++ and Unreal Engine. Works with your existing auth. Self-hostable.",
};

const GITHUB_URL = "https://github.com/GabeCurran/junjo";
const DOCS_URL = "https://docs.junjo.io";
const NPM_URL = "https://www.npmjs.com/package/@junjo.io/sdk";
const CONTACT_MAILTO = "mailto:gabecurran01@gmail.com?subject=Junjo%20hosted%20beta";

// External links open in a new tab; the reader keeps their place here.
const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;

// The client surface from packages/sdk/src/index.ts, in the SDK's words.
const SURFACE: readonly { ns: string; body: string }[] = [
  {
    ns: "groups",
    body: "Guilds, clans, parties and sub-groups, with per-kind limits and batches.",
  },
  { ns: "roles", body: "Roles with grants, denies, inheritance and entries scoped by context." },
  { ns: "members", body: "Rosters, joins, kicks, promotions and bulk import." },
  { ns: "permissions", body: "One check or a hundred, answered by the deciding rule." },
  { ns: "bans", body: "Game and group bans with full history." },
  { ns: "sanctions", body: "Mutes and any other timed restriction your game defines." },
  { ns: "identities", body: "Linked accounts across platforms, and display names." },
  { ns: "friends", body: "Requests, tags, suggestions and blocks." },
  { ns: "invitations", body: "Direct invites and links, with expiry." },
  { ns: "events", body: "One ordered stream of every change, resumable, saying who made it." },
];

const LIVE_FEATURES: readonly { title: string; body: string }[] = [
  {
    title: "One stream for the whole game",
    body: "Every change in order, with a position to resume from. Your servers, your website and your bots see the same thing.",
  },
  {
    title: "Safe when several places write",
    body: "Every group has a version. A write can require the version it read, and a batch applies several changes together or not at all.",
  },
  {
    title: "Knows its own writes",
    body: "Each event says which key and which writer made it, so a server that keeps a local copy skips its own echoes.",
  },
  {
    title: "Permissions with context",
    body: "Grant a permission in one map or mode and deny it in another on the same role. Contexts inherit, nearest first.",
  },
];

const KW = "text-primary";

function Code({ file, children }: { file: string; children: ReactNode }) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-md border border-border bg-card">
      <figcaption
        className={`${jbMono.className} border-b border-border px-4 py-2 text-xs text-muted-foreground`}
      >
        {file}
      </figcaption>
      <pre
        className={`${jbMono.className} overflow-x-auto p-4 text-[13px] leading-6 text-foreground`}
      >
        <code>{children}</code>
      </pre>
    </figure>
  );
}

const ROSTER: readonly { name: string; rank: string; color: string }[] = [
  { name: "aria", rank: "Leader", color: "#E2B44A" },
  { name: "bramble", rank: "Officer", color: "#F76A6A" },
  { name: "kestrel", rank: "Member", color: "#6A9CF7" },
];

// The state the code beside it just wrote: the guild's roster in its own
// rank colors, the invited player arriving, and the check resolving.
function GuildState() {
  return (
    <div className="min-w-0 rounded-md border border-border bg-card">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
        <h3 className="font-condensed text-xl font-semibold tracking-tight">Crimson Dawn</h3>
        <span className="text-xs text-muted-foreground">guild, 4 of 25</span>
      </div>
      <ul className="divide-y divide-border/60 px-4">
        {ROSTER.map((m) => (
          <li key={m.name} className="flex items-center justify-between py-2 text-sm">
            <span>{m.name}</span>
            <RoleChip name={m.rank} color={m.color} />
          </li>
        ))}
        <li className="landing-join flex items-center justify-between py-2 text-sm">
          <span>
            nova <span className="ml-1 text-xs text-muted-foreground">joined by invite</span>
          </span>
          <RoleChip name="Member" color="#6A9CF7" />
        </li>
      </ul>
      <p className="landing-check border-t border-border px-4 py-2.5 text-sm">
        nova can invite: <span className="font-semibold text-allow">yes</span>
        <span className="text-muted-foreground">, from Member</span>
      </p>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-screen-lg items-center justify-between px-6">
          <span className="flex items-center gap-2 font-condensed text-xl font-bold tracking-tight">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-primary" />
            Junjo
          </span>
          <nav className="flex items-center gap-4 text-sm sm:gap-5">
            <a href={DOCS_URL} {...EXT} className="text-muted-foreground hover:text-foreground">
              Docs
            </a>
            <a href={GITHUB_URL} {...EXT} className="text-muted-foreground hover:text-foreground">
              GitHub
            </a>
            <a
              href="/license"
              className="hidden text-muted-foreground hover:text-foreground sm:inline"
            >
              License
            </a>
            {/* Plain anchor on purpose: a next/link here prefetches the
                authed route and the 401 challenge pops the browser's
                native sign-in dialog on the public page. */}
            <a
              href="/overview"
              className="hidden text-muted-foreground hover:text-foreground sm:inline"
            >
              Admin
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-screen-lg px-6 pt-14 md:pt-20">
          <h1 className="max-w-3xl font-condensed text-5xl font-semibold leading-[0.95] tracking-tight md:text-7xl">
            The social layer for multiplayer games
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            One API for groups, roles, friends, moderation and a live stream of every change. SDKs
            for TypeScript, React, Java, Roblox, C++ and Unreal Engine.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
            <a
              href={DOCS_URL}
              {...EXT}
              className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Read the docs
            </a>
            <a
              href={GITHUB_URL}
              {...EXT}
              className="inline-flex items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm font-medium hover:bg-accent"
            >
              View on GitHub
            </a>
            <a
              href={NPM_URL}
              {...EXT}
              className={`${jbMono.className} mt-1 text-sm text-muted-foreground hover:text-foreground sm:ml-2 sm:mt-0`}
              title="View @junjo.io/sdk on npm"
            >
              npm install @junjo.io/sdk
            </a>
          </div>
        </section>

        <section className="mx-auto max-w-screen-lg px-6 pb-16 pt-12">
          <div className="grid items-start gap-6 md:grid-cols-2">
            <Code file="guild.ts">
              <span className={KW}>const</span>
              {" guild = "}
              <span className={KW}>await</span>
              {' junjo.groups.create({\n  kind: "guild",\n  name: "Crimson Dawn",\n});\n\n'}
              <span className={KW}>await</span>
              {' junjo.groups.inviteByUserId(guild.id, "nova");\n\n'}
              <span className={KW}>const</span>
              {" ok = "}
              <span className={KW}>await</span>
              {' junjo.can("nova", guild.id, "invite");'}
            </Code>
            <GuildState />
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto max-w-screen-lg px-6 py-16">
            <div className="grid items-center gap-10 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
              <div>
                <h2 className="font-condensed text-4xl font-semibold leading-none tracking-tight">
                  Built for live games
                </h2>
                <p className="mt-4 max-w-md text-muted-foreground">
                  Game servers, your website and your bots read and write the same groups, and every
                  one of them sees every change, on any platform an SDK covers.
                </p>
              </div>
              <Code file="handover.ts">
                <span className={KW}>const</span>
                {" guild = "}
                <span className={KW}>await</span>
                {" junjo.groups.get(guildId);\n\n"}
                <span className="text-muted-foreground">
                  {"// hand over the lead in one step,\n// only if nobody changed the guild since"}
                </span>
                {"\n"}
                <span className={KW}>await</span>
                {" junjo.groups.batch(guildId, [\n"}
                {'  { op: "member.role.add", userId: "nova", roleId: lead },\n'}
                {'  { op: "member.role.remove", userId: "aria", roleId: lead },\n'}
                {'  { op: "member.role.add", userId: "aria", roleId: officer },\n'}
                {"], { ifMatch: guild?.version });"}
              </Code>
            </div>
            <dl className="mt-12 grid gap-x-10 gap-y-6 border-t border-border pt-8 sm:grid-cols-2 lg:grid-cols-4">
              {LIVE_FEATURES.map((f) => (
                <div key={f.title}>
                  <dt className="font-semibold">{f.title}</dt>
                  <dd className="mt-1 text-sm leading-6 text-muted-foreground">{f.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto max-w-screen-lg px-6 py-16">
            <h2 className="font-condensed text-4xl font-semibold leading-none tracking-tight">
              The whole surface
            </h2>
            <p className="mt-4 max-w-xl text-muted-foreground">
              The same names in the HTTP API, every SDK and the React hooks.
            </p>
            <dl className="mt-8 grid border-t border-border sm:grid-cols-2 sm:gap-x-12">
              {SURFACE.map((f) => (
                <div key={f.ns} className="flex gap-4 border-b border-border py-3.5">
                  <dt className={`${jbMono.className} w-28 shrink-0 text-sm text-primary`}>
                    {f.ns}
                  </dt>
                  <dd className="text-sm leading-6 text-muted-foreground">{f.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto grid max-w-screen-lg items-center gap-10 px-6 py-16 md:grid-cols-2">
            <div>
              <h2 className="font-condensed text-4xl font-semibold leading-none tracking-tight">
                Keeps your auth
              </h2>
              <p className="mt-4 max-w-md text-muted-foreground">
                Junjo never touches your login. It takes the user id your auth already issues and
                links ids across platforms when a player connects a second account. Clerk, Supabase
                and plain JWT adapters are built in.
              </p>
            </div>
            <Code file="junjo.ts">
              <span className={KW}>const</span>
              {" junjo = "}
              <span className={KW}>new</span>
              {
                " Junjo({\n  apiKey: process.env.JUNJO_API_KEY,\n  authAdapter: clerkAdapter(clerk),\n});"
              }
            </Code>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto grid max-w-screen-lg gap-10 px-6 py-16 md:grid-cols-2 md:divide-x md:divide-border">
            <div>
              <h2 className="font-condensed text-3xl font-semibold leading-none tracking-tight">
                Run it yourself
              </h2>
              <p className="mt-3 max-w-sm text-muted-foreground">
                Source-available (ELv2) and free to run for your own game: one Docker image and one
                Postgres, the same API as hosted.
              </p>
              <a
                href={`${DOCS_URL}/self-host`}
                {...EXT}
                className="mt-5 inline-block text-sm font-medium text-primary hover:underline"
              >
                Self-hosting guide
              </a>
            </div>
            <div className="md:pl-10">
              <h2 className="font-condensed text-3xl font-semibold leading-none tracking-tight">
                Or let me host it
              </h2>
              <p className="mt-3 max-w-sm text-muted-foreground">
                Dashboard and database included, free during the beta. Email me and I will set up
                your game.
              </p>
              <a
                href={CONTACT_MAILTO}
                className="mt-5 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <Mail className="h-4 w-4" aria-hidden />
                Request access
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-screen-lg flex-col gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <p>Junjo. MIT SDKs, source-available server.</p>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <a href={DOCS_URL} {...EXT} className="hover:text-foreground">
              Docs
            </a>
            <a href={GITHUB_URL} {...EXT} className="hover:text-foreground">
              GitHub
            </a>
            <a href={NPM_URL} {...EXT} className="hover:text-foreground">
              npm
            </a>
            <a href="/license" className="hover:text-foreground">
              License
            </a>
            <a href="/privacy" className="hover:text-foreground">
              Privacy
            </a>
            <a href={CONTACT_MAILTO} className="hover:text-foreground">
              Contact
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
