// `createApiKey` returns the plaintext secret alongside the DB record;
// the hash is what's stored, so callers must use the plaintext at hand
// (it cannot be recovered later).

import type { ApiKey, Game, PrismaClient } from "@prisma/client";
import { type RawApiKey, generateApiKey } from "./apiKey.js";
import { prisma as defaultPrisma } from "./db.js";

export interface SeededApiKey {
  apiKey: ApiKey;
  raw: RawApiKey;
}

export async function createGame(
  name: string,
  client: PrismaClient = defaultPrisma,
): Promise<Game> {
  return client.game.create({ data: { name } });
}

export async function createApiKey(
  gameId: string,
  client: PrismaClient = defaultPrisma,
): Promise<SeededApiKey> {
  const raw = await generateApiKey();
  const apiKey = await client.apiKey.create({
    data: { gameId, prefix: raw.prefix, hashedSecret: raw.hashedSecret },
  });
  return { apiKey, raw };
}
