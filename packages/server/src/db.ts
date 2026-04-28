import { PrismaClient } from "@prisma/client";

// Single Prisma client per process. Hot-reload (tsx watch) re-imports this
// file repeatedly, which would leak connections without the globalThis cache.
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
