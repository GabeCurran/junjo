import { PrismaClient } from "@prisma/client";

// `globalThis` cache survives the repeated re-imports under `tsx watch`,
// which would otherwise leak a connection pool per file change.
declare global {
  var __junjoPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient = globalThis.__junjoPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__junjoPrisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  globalThis.__junjoPrisma = undefined;
}
