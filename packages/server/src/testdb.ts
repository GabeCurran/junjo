// Resolves the Postgres URL used by server-side tests. Tests that need a
// database import this rather than reading process.env directly so a
// missing fixture surfaces a single clear error instead of a torrent of
// connection failures.

export function getTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || url.length === 0) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Server tests require a local Postgres " +
        "database. See packages/server/README.md (Running tests) for setup.",
    );
  }
  return url;
}
