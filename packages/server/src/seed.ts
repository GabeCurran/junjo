// Seed helpers for tests + local dev. createGame() inserts a Game row;
// createApiKey() generates a fresh `prefix.secret` pair, stores the
// hashed secret, and returns the plaintext alongside the DB record so
// callers can use the key once and never see it again.

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
