// Centralized so a missing fixture surfaces one clear error instead of a
// torrent of connection failures.

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
