// Run with: npm run db:seed [-- --name "My Game"]
//
// Intentionally uses `console.*` rather than the structured logger:
// the plaintext API key is read off the terminal by a human and routing
// it through pino-pretty (or pino's JSON in production) would make the
// secret hard to copy and risk leaking it into log aggregation as a
// structured field.

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
