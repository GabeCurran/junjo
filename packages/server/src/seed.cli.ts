// Local-dev convenience wrapper around the seed helpers. Creates one
// Game and one ApiKey, prints both to stdout (the plaintext key is
// shown exactly once because it is not recoverable later), then
// disconnects so the process exits cleanly.
//
// Run with: npm run db:seed [-- --name "My Game"]
//
// Intentionally uses `console.log` / `console.error` instead of the
// structured logger from `logger.ts` (Phase 14.2). The output is read
// by a human who copies the API key prefix + secret out of their
// terminal; routing it through pino-pretty's level prefixes (or pino's
// JSON wire shape in production) would make the secret harder to copy
// and could end up in log aggregation as a structured field. The
// runtime server uses the structured logger; this CLI does not.

import { disconnectPrisma, prisma } from "./db.js";
import { createApiKey, createGame } from "./seed.js";

function readNameFromArgs(argv: readonly string[]): string {
  const idx = argv.indexOf("--name");
  if (idx >= 0 && idx + 1 < argv.length) {
    const next = argv[idx + 1];
    if (next && next.length > 0) return next;
  }
  return `Local Dev Game ${new Date().toISOString().slice(0, 10)}`;
}

async function main(): Promise<void> {
  const name = readNameFromArgs(process.argv.slice(2));
  const game = await createGame(name, prisma);
  const { apiKey, raw } = await createApiKey(game.id, prisma);

  console.log("Created game");
  console.log(`  id:   ${game.id}`);
  console.log(`  name: ${game.name}`);
  console.log("");
  console.log("Created API key (copy the full value now; it cannot be recovered later)");
  console.log(`  id:     ${apiKey.id}`);
  console.log(`  prefix: ${raw.prefix}`);
  console.log(`  full:   ${raw.full}`);
}

main()
  .catch((err) => {
    console.error("[junjo-server] db:seed failed");
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
