import { defineConfig } from "vitest/config";

// DB-backed test files share one TEST_DATABASE_URL and truncate tables
// in `beforeEach`. Running them in parallel races the truncates against
// each other and produces foreign-key failures. Serializing files keeps
// the fixture simple; the suite is small enough that the throughput
// hit is negligible.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
