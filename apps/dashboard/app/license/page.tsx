// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft } from "lucide-react";
import { JetBrains_Mono } from "next/font/google";

const jbMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"] });

export const metadata = {
  title: "Licensing - Junjo",
  description:
    "How Junjo is licensed: MIT client packages, Elastic License 2.0 server, proprietary cloud dashboard.",
};

const ROWS: readonly { pkg: string; license: string; note: string }[] = [
  { pkg: "@junjo.io/sdk", license: "MIT", note: "TypeScript client SDK" },
  { pkg: "@junjo.io/react", license: "MIT", note: "React hooks" },
  { pkg: "@junjo.io/shared", license: "MIT", note: "Shared types" },
  { pkg: "sdk-roblox", license: "MIT", note: "Roblox Luau client" },
  { pkg: "server", license: "ELv2", note: "The Junjo server" },
  { pkg: "dashboard", license: "Proprietary", note: "The cloud admin dashboard" },
];

export default function LicensePage() {
  return (
    <main className="mx-auto max-w-screen-md px-6 py-16">
      <a
        href="/"
        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to junjo.io
      </a>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">Licensing</h1>
      <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
        Junjo uses two licenses. The client packages are MIT: use them in any game, commercial or
        not, no strings attached. The server is source-available under the Elastic License 2.0
        (ELv2): you can read it, run it, and self-host it for your own games, but you may not offer
        it to third parties as a hosted or managed service.
      </p>
      <div className="mt-8 overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-card text-left">
              <th className="px-4 py-2.5 font-medium">Package</th>
              <th className="px-4 py-2.5 font-medium">License</th>
              <th className="px-4 py-2.5 font-medium">What it is</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.pkg} className="border-b border-border last:border-b-0">
                <td className={`${jbMono.className} px-4 py-2.5 text-xs`}>{r.pkg}</td>
                <td className="px-4 py-2.5">{r.license}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-6 text-sm leading-6 text-muted-foreground">
        The authoritative text is the LICENSE file in each package's directory in the{" "}
        <a
          href="https://github.com/GabeCurran/junjo"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          GitHub repository
        </a>
        . Questions about commercial licensing:{" "}
        <a href="mailto:gabecurran01@gmail.com" className="text-primary hover:underline">
          gabecurran01@gmail.com
        </a>
        .
      </p>
    </main>
  );
}
