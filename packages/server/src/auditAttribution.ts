import { Prisma, type PrismaClient } from "@prisma/client";
import { currentRequestContext } from "./requestContext.js";

// Stamps the acting API key onto every audit row written while serving
// a key-authenticated request, so no audit call site carries it by hand.
// Query extensions run in the caller's async context and apply inside
// interactive and batch transactions started from the extended client.
// An explicit `apiKeyId` in the data wins; outside a request, or for
// dashboard requests, nothing is stamped.
const auditAttribution = Prisma.defineExtension({
  name: "auditAttribution",
  query: {
    auditEntry: {
      create({ args, query }) {
        const apiKeyId = currentRequestContext()?.apiKeyId;
        if (apiKeyId && args.data.apiKeyId === undefined && args.data.apiKey === undefined) {
          (args.data as Prisma.AuditEntryUncheckedCreateInput).apiKeyId = apiKeyId;
        }
        return query(args);
      },
      createMany({ args, query }) {
        const apiKeyId = currentRequestContext()?.apiKeyId;
        if (apiKeyId) {
          const rows = Array.isArray(args.data) ? args.data : [args.data];
          for (const row of rows) row.apiKeyId ??= apiKeyId;
        }
        return query(args);
      },
    },
  },
});

// The extended client keeps PrismaClient's surface; the cast hands it to
// code typed against the base client. Stand-in clients without
// `$extends` pass through unchanged and record no attribution.
export function withAuditAttribution(client: PrismaClient): PrismaClient {
  if (typeof (client as { $extends?: unknown }).$extends !== "function") return client;
  return client.$extends(auditAttribution) as unknown as PrismaClient;
}
