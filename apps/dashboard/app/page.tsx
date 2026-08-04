// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Activity, ArrowDown, ArrowRight, Mail } from "lucide-react";
import { JetBrains_Mono } from "next/font/google";

// Public marketing landing page. This is the ONLY route served without the
// Basic Auth gate (see middleware.ts): it is fully static (no runtime env,
// no data fetching), so Next prerenders it at build time and the admin
// dashboard stays private at /overview and friends.

const jbMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700"] });

export const metadata = {
  title: "Junjo - Guilds, ranks, and permissions for multiplayer games",
  description:
    "A backend and TypeScript SDK for the social features most multiplayer games build from scratch: groups, roles, friends, and invitations. Works with your existing auth. Self-hostable.",
};

const GITHUB_URL = "https://github.com/GabeCurran/junjo";
const DOCS_URL = "https://docs.junjo.io";
const NPM_URL = "https://www.npmjs.com/package/@junjo.io/sdk";
const CONTACT_MAILTO = "mailto:gabecurran01@gmail.com?subject=Junjo%20hosted%20beta";

// External links open in a new tab; the reader keeps their place here.
const EXT = { target: "_blank", rel: "noopener noreferrer" } as const;

// The real client surface from packages/sdk/src/index.ts. The grid below
// renders these verbatim: the page's structure IS the SDK's structure.
const NAMESPACES: readonly { ns: string; body: string }[] = [
  {
    ns: "groups",
    body: "Guilds, clans, parties, and sub-groups with capacity and visibility rules.",
  },
  { ns: "roles", body: "Multi-tier ranks with per-group permission overrides." },
  { ns: "members", body: "Rosters, joins, kicks, and promotions." },
  { ns: "invitations", body: "Direct and bulk invites with expiry and revocation." },
  { ns: "friends", body: "Requests, tags, suggestions, and blocklists." },
  { ns: "bans", body: "Group-level and game-level bans with full history." },
  { ns: "webhooks", body: "Signed delivery with automatic endpoint disabling." },
  { ns: "audit", body: "Every mutation recorded and queryable." },
];

const ROSTER: readonly { name: string; rank: string; lead?: boolean }[] = [
  { name: "aria", rank: "Leader", lead: true },
  { name: "bramble", rank: "Officer" },
  { name: "kestrel", rank: "Member" },
];

function CodePanel() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-muted" aria-hidden />
        <span className="h-2.5 w-2.5 rounded-full bg-muted" aria-hidden />
        <span className="h-2.5 w-2.5 rounded-full bg-primary/70" aria-hidden />
        <span className={`${jbMono.className} ml-2 text-xs text-muted-foreground`}>guilds.ts</span>
      </div>
      <pre className={`${jbMono.className} overflow-x-auto p-4 text-xs leading-6 text-foreground`}>
        <code>
          <span className="text-primary">{"import"}</span>
          {" { Junjo } "}
          <span className="text-primary">{"from"}</span>
          {' "@junjo.io/sdk";\n\n'}
          <span className="text-primary">{"const"}</span>
          {" guild = "}
          <span className="text-primary">{"await"}</span>
          {" junjo.groups.create({\n"}
          {'  kind: "guild",\n'}
          {'  name: "Crimson Dawn",\n'}
          {"});\n\n"}
          <span className="text-primary">{"await"}</span>
          {" junjo.groups\n"}
          {'  .inviteByUserId(guild.id, "user_123");\n\n'}
          <span className="text-primary">{"const"}</span>
          {" allowed = "}
          <span className="text-primary">{"await"}</span>
          {" junjo.can(\n"}
          {'  "user_123", guild.id, "invite_member"\n'}
          {");\n"}
        </code>
      </pre>
    </div>
  );
}

// The signature: the state the code above just wrote. A guild roster with
// ranks, the invited player arriving, and the permission check resolving.
function GuildCard() {
  return (
    <div className="relative rounded-lg border border-border bg-card shadow-lg">
      <p
        className={`${jbMono.className} border-b border-border px-4 py-2.5 text-xs text-muted-foreground`}
      >
        {"// state after running guilds.ts"}
      </p>
      <div className="px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-base font-semibold tracking-tight">Crimson Dawn</h3>
          <span className={`${jbMono.className} text-xs text-muted-foreground`}>guild - 4/25</span>
        </div>
        <ul className="mt-3 space-y-2">
          {ROSTER.map((m) => (
            <li key={m.name} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${m.lead ? "bg-primary" : "bg-muted-foreground/50"}`}
                  aria-hidden
                />
                <span className={jbMono.className}>{m.name}</span>
              </span>
              <span
                className={`rounded border px-1.5 py-0.5 text-xs ${
                  m.lead ? "border-primary/40 text-primary" : "border-border text-muted-foreground"
                }`}
              >
                {m.rank}
              </span>
            </li>
          ))}
          <li className="landing-join flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
              <span className={jbMono.className}>user_123</span>
              <span className={`${jbMono.className} text-xs text-primary`}>joined via invite</span>
            </span>
            <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              Member
            </span>
          </li>
        </ul>
        <p
          className={`${jbMono.className} landing-check mt-3 border-t border-border pt-3 text-xs text-muted-foreground`}
        >
          {'can("user_123", "invite_member") '}
          <span className="text-primary">{"-> true"}</span>
        </p>
      </div>
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
              {...EXT}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Docs
            </a>
            <a
              href={GITHUB_URL}
              {...EXT}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              GitHub
            </a>
            <a
              href="/license"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              License
            </a>
            {/* Plain anchor on purpose: a next/link here prefetches the
                authed route and the 401 challenge pops the browser's
                native sign-in dialog on the public page. */}
            <a
              href="/overview"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Admin
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero: full-width text, then code -> resulting state side by side */}
        <section className="mx-auto max-w-screen-lg px-6 pt-16 md:pt-20">
          <p className={`${jbMono.className} text-xs uppercase tracking-widest text-primary`}>
            Backend for multiplayer games
          </p>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
            <h1
              className={`${jbMono.className} max-w-xl text-3xl font-bold leading-tight tracking-tight md:text-5xl`}
            >
              Guilds, ranks, and permissions
            </h1>
            <p className="max-w-xs text-base leading-7 text-muted-foreground">
              A backend and TypeScript SDK for your game&apos;s social layer. Works with your
              existing auth. Self-hostable.
            </p>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-4">
            <a
              href={DOCS_URL}
              {...EXT}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Read the docs
              <ArrowRight className="h-4 w-4" aria-hidden />
            </a>
            <a
              href={GITHUB_URL}
              {...EXT}
              className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              View on GitHub
            </a>
            <a
              href={NPM_URL}
              {...EXT}
              className={`${jbMono.className} text-sm text-muted-foreground transition-colors hover:text-foreground`}
              title="View @junjo.io/sdk on npm"
            >
              <span className="select-none text-primary">$ </span>
              npm install @junjo.io/sdk
            </a>
          </div>
        </section>
        <section className="mx-auto max-w-screen-lg px-6 pb-16 pt-10 md:pb-20">
          <div className="grid items-center gap-4 md:grid-cols-[1fr_auto_1fr]">
            <CodePanel />
            <div className="flex justify-center text-primary" aria-hidden>
              <ArrowRight className="hidden h-6 w-6 md:block" />
              <ArrowDown className="h-6 w-6 md:hidden" />
            </div>
            <GuildCard />
          </div>
        </section>

        {/* API surface */}
        <section className="border-t border-border bg-card/50">
          <div className="mx-auto max-w-screen-lg px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">The client surface</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Same shape in the HTTP API, the SDK, and the React hooks.
            </p>
            <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
              {NAMESPACES.map((f) => (
                <div key={f.ns} className="bg-card p-5">
                  <h3 className={`${jbMono.className} text-sm font-medium`}>
                    <span className="text-muted-foreground">junjo.</span>
                    <span className="text-primary">{f.ns}</span>
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{f.body}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Plus server-sent events for live roster updates.
            </p>
          </div>
        </section>

        {/* Auth adapters */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-screen-lg px-6 py-16">
            <div className="grid items-center gap-10 md:grid-cols-2">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  Works with your existing auth
                </h2>
                <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                  Junjo never touches your login flow. It takes a user id from the auth you already
                  run and manages the group data under it. Clerk, Supabase, and plain JWT adapters
                  are built in.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <pre className={`${jbMono.className} overflow-x-auto text-[13px] leading-6`}>
                  <code>
                    <span className="text-primary">{"import"}</span>
                    {" { clerkAdapter } "}
                    <span className="text-primary">{"from"}</span>
                    {' "@junjo.io/sdk/adapters";\n\n'}
                    <span className="text-primary">{"const"}</span>
                    {" junjo = "}
                    <span className="text-primary">{"new"}</span>
                    {
                      " Junjo({\n  apiKey: process.env.JUNJO_API_KEY,\n  authAdapter: clerkAdapter(clerk),\n});"
                    }
                  </code>
                </pre>
              </div>
            </div>
          </div>
        </section>

        {/* Self-host / hosted beta */}
        <section className="border-t border-border bg-card/50">
          <div className="mx-auto max-w-screen-lg px-6 py-16">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-lg border border-border bg-card p-6">
                <h2 className="text-lg font-semibold tracking-tight">Self-host it</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Source-available (ELv2), free to run for your own game. One Docker image, one
                  Postgres, same API as hosted.
                </p>
                <a
                  href={`${DOCS_URL}/self-host`}
                  {...EXT}
                  className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                >
                  Self-hosting guide
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </a>
              </div>
              <div className="rounded-lg border border-primary/40 bg-card p-6">
                <h2 className="text-lg font-semibold tracking-tight">Or use the hosted beta</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Dashboard and Postgres included. Free while in beta. Email me and I&apos;ll set
                  you up.
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
          <p>Junjo. MIT SDK, source-available server.</p>
          <nav className="flex items-center gap-5">
            <a href={DOCS_URL} {...EXT} className="transition-colors hover:text-foreground">
              docs.junjo.io
            </a>
            <a href={GITHUB_URL} {...EXT} className="transition-colors hover:text-foreground">
              GitHub
            </a>
            <a href={NPM_URL} {...EXT} className="transition-colors hover:text-foreground">
              npm
            </a>
            <a href="/license" className="transition-colors hover:text-foreground">
              License
            </a>
            <a href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
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
