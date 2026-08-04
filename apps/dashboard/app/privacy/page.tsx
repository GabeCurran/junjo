// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft } from "lucide-react";

export const metadata = {
  title: "Privacy - Junjo",
  description: "What the Junjo website and hosted service store, and what they do not.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-screen-md px-6 py-16">
      <a
        href="/"
        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to junjo.io
      </a>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">Privacy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated: August 4, 2026</p>

      <div className="mt-8 space-y-8 text-sm leading-6">
        <section>
          <h2 className="text-lg font-semibold tracking-tight">This website</h2>
          <p className="mt-2 text-muted-foreground">
            junjo.io and docs.junjo.io do not use analytics, advertising, or tracking cookies. If
            you email us, we keep the email to reply to it.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold tracking-tight">The hosted service</h2>
          <p className="mt-2 text-muted-foreground">
            If your studio uses hosted Junjo, we store the data your game sends through the API so
            the service can function: group and roster data, roles, invitations, friend
            relationships, bans, audit history, and the user identifiers your game supplies. Junjo
            does not receive names, emails, or passwords of your players unless you choose to send
            them as identifiers; we recommend opaque ids. We also store your admin account email and
            API keys, and standard server logs (IP addresses, request paths) kept for debugging and
            abuse prevention.
          </p>
          <p className="mt-2 text-muted-foreground">
            Data is stored with our hosting provider (Railway) in the United States. It is never
            sold or shared with third parties, and it is not used for anything except running the
            service. Your studio owns its data: email us and we will export or permanently delete
            it.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold tracking-tight">Self-hosted Junjo</h2>
          <p className="mt-2 text-muted-foreground">
            If you self-host the server, no data reaches us at all. The server does not phone home.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold tracking-tight">Contact</h2>
          <p className="mt-2 text-muted-foreground">
            Questions or data requests:{" "}
            <a href="mailto:gabecurran01@gmail.com" className="text-primary hover:underline">
              gabecurran01@gmail.com
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}
