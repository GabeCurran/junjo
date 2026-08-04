// @license All Rights Reserved (see apps/dashboard/LICENSE)
import {
  Activity,
  ArrowRight,
  FolderTree,
  KeyRound,
  Mail,
  Radio,
  ScrollText,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import Link from "next/link";

// Public marketing landing page. This is the ONLY route served without the
// Basic Auth gate (see middleware.ts): it is fully static (no runtime env,
// no data fetching), so Next prerenders it at build time and the admin
// dashboard stays private at /overview and friends.

export const metadata = {
  title: "Junjo - Guilds, ranks, and permissions for multiplayer games",
  description:
    "A drop-in social-organization layer for multiplayer games. Groups, guilds, ranks, permissions, friends, and invitations over one TypeScript SDK. Plugs into your existing auth. Self-hostable.",
};

const GITHUB_URL = "https://github.com/GabeCurran/junjo";
const DOCS_URL = "https://docs.junjo.io";
const CONTACT_MAILTO = "mailto:gabecurran01@gmail.com?subject=Junjo%20cloud%20beta";

interface Feature {
  icon: typeof Users;
  title: string;
  body: string;
}

const FEATURES: readonly Feature[] = [
  {
    icon: FolderTree,
    title: "Groups and guilds",
    body: "Guilds, clans, factions, parties, and sub-groups with capacity rules and lifecycle events built in.",
  },
  {
    icon: ShieldCheck,
    title: "Ranks and permissions",
    body: "A role and permission model designed for games. One junjo.can() call answers who may kick, invite, or promote.",
  },
  {
    icon: Users,
    title: "Friends and blocklists",
    body: "Friend requests, tags, suggestions, and blocklists so your social graph ships with the game, not after it.",
  },
  {
    icon: UserPlus,
    title: "Invitations",
    body: "Invite by user id or bulk invite whole rosters, with expiry and revocation handled server-side.",
  },
  {
    icon: Radio,
    title: "Real-time via SSE",
    body: "Subscribe to membership and roster changes over server-sent events. No websocket infrastructure to babysit.",
  },
  {
    icon: ScrollText,
    title: "Audit log",
    body: "Every mutation is recorded and queryable, so moderation disputes end with a log line instead of a shrug.",
  },
];

function CodePanel() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-muted" aria-hidden />
        <span className="h-2.5 w-2.5 rounded-full bg-muted" aria-hidden />
        <span className="h-2.5 w-2.5 rounded-full bg-primary/70" aria-hidden />
        <span className="ml-2 font-mono text-xs text-muted-foreground">guilds.ts</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-foreground">
        <code>
          <span className="text-muted-foreground">{"// npm install @junjo-io/sdk\n"}</span>
          <span className="text-primary">{"import"}</span>
          {" { Junjo } "}
          <span className="text-primary">{"from"}</span>
          {' "@junjo-io/sdk";\n\n'}
          <span className="text-primary">{"const"}</span>
          {" junjo = "}
          <span className="text-primary">{"new"}</span>
          {" Junjo({ apiKey: process.env.JUNJO_API_KEY });\n\n"}
          <span className="text-primary">{"const"}</span>
          {" guild = "}
          <span className="text-primary">{"await"}</span>
          {' junjo.groups.create({ kind: "guild", name: "Crimson Dawn" });\n'}
          <span className="text-primary">{"await"}</span>
          {' junjo.groups.inviteByUserId(guild.id, "user_123");\n\n'}
          <span className="text-muted-foreground">
            {"// one call answers every permission question\n"}
          </span>
          <span className="text-primary">{"const"}</span>
          {" allowed = "}
          <span className="text-primary">{"await"}</span>
          {' junjo.can("user_123", guild.id, "invite_member");\n'}
        </code>
      </pre>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Top nav */}
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-screen-lg items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Activity className="h-4 w-4" aria-hidden />
            </div>
            <span className="text-base font-semibold tracking-tight">Junjo</span>
          </div>
          <nav className="flex items-center gap-5 text-sm">
            <a
              href={DOCS_URL}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Docs
            </a>
            <a
              href={GITHUB_URL}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              GitHub
            </a>
            <Link
              href="/overview"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Admin
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto grid max-w-screen-lg items-center gap-10 px-6 py-16 md:grid-cols-2 md:py-24">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-primary">
              Open-source social layer for multiplayer games
            </p>
            <h1 className="mt-4 text-4xl font-bold tracking-tight md:text-5xl">
              Guilds, ranks, and permissions. Drop-in.
            </h1>
            <p className="mt-4 max-w-md text-base leading-7 text-muted-foreground">
              Junjo gives indie TypeScript and Node studios the social-organization layer every
              multiplayer game rebuilds: groups, roles, friends, and invitations behind one typed
              SDK. It plugs into the auth you already have and never replaces it.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={DOCS_URL}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Read the docs
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
              <a
                href={GITHUB_URL}
                className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                Star on GitHub
              </a>
            </div>
            <p className="mt-6 font-mono text-sm text-muted-foreground">
              <span className="select-none text-primary">$ </span>
              npm install @junjo-io/sdk
            </p>
          </div>
          <CodePanel />
        </section>

        {/* Feature grid */}
        <section className="border-t border-border bg-card/50">
          <div className="mx-auto max-w-screen-lg px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">
              The parts every multiplayer game rebuilds
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Stop hand-rolling roster tables three weeks before launch. These primitives ship in
              the SDK, the React hooks, and the HTTP API.
            </p>
            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => {
                const Icon = feature.icon;
                return (
                  <div key={feature.title} className="rounded-lg border border-border bg-card p-5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary text-primary">
                      <Icon className="h-4 w-4" aria-hidden />
                    </div>
                    <h3 className="mt-4 text-sm font-semibold">{feature.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Auth adapters */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-screen-lg px-6 py-16">
            <div className="grid items-center gap-10 md:grid-cols-2">
              <div>
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary text-primary">
                  <KeyRound className="h-4 w-4" aria-hidden />
                </div>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight">
                  Keeps your auth. All of it.
                </h2>
                <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                  Junjo never owns your users. Adapters for Clerk, Supabase, and plain JWT ship in
                  the box, and a small interface covers any custom setup. Your identity provider
                  stays the source of truth; Junjo only organizes the players it is handed.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <pre className="overflow-x-auto font-mono text-[13px] leading-6">
                  <code>
                    <span className="text-primary">{"import"}</span>
                    {" { clerkAdapter } "}
                    <span className="text-primary">{"from"}</span>
                    {' "@junjo-io/sdk/adapters";\n\n'}
                    <span className="text-primary">{"const"}</span>
                    {" junjo = "}
                    <span className="text-primary">{"new"}</span>
                    {
                      " Junjo({\n  apiKey: process.env.JUNJO_API_KEY,\n  authAdapter: clerkAdapter(clerk),\n});"
                    }
                  </code>
                </pre>
                <p className="mt-3 text-xs text-muted-foreground">
                  Also ships: supabaseAdapter, jwtAdapter, or bring your own.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Self-host / cloud beta */}
        <section className="border-t border-border bg-card/50">
          <div className="mx-auto max-w-screen-lg px-6 py-16">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-lg border border-border bg-card p-6">
                <h2 className="text-lg font-semibold tracking-tight">Self-host it</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  The server is MIT licensed: Hono on Node with Postgres. One Docker image, one
                  database, and the same API the cloud runs.
                </p>
                <a
                  href={`${DOCS_URL}/self-host`}
                  className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                >
                  Self-hosting guide
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </a>
              </div>
              <div className="rounded-lg border border-primary/40 bg-card p-6">
                <h2 className="text-lg font-semibold tracking-tight">Or join the cloud beta</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Hosted Junjo with the admin dashboard, managed Postgres, and zero ops. Free while
                  in beta; early studios get a direct line to the roadmap.
                </p>
                <a
                  href={CONTACT_MAILTO}
                  className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  <Mail className="h-4 w-4" aria-hidden />
                  Request access
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-screen-lg flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground">
          <p>Junjo. MIT-licensed SDK and server.</p>
          <nav className="flex items-center gap-5">
            <a href={DOCS_URL} className="transition-colors hover:text-foreground">
              docs.junjo.io
            </a>
            <a href={GITHUB_URL} className="transition-colors hover:text-foreground">
              GitHub
            </a>
            <a href={CONTACT_MAILTO} className="transition-colors hover:text-foreground">
              Contact
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
