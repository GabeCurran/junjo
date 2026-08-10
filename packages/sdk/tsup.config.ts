import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/adapters/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // jose v6 is ESM-only, so leaving it external would make the CJS
  // adapters entry emit require("jose"), which throws ERR_REQUIRE_ESM
  // on Node 20.0-20.18. Bundling it keeps the require path working;
  // jose tree-shakes down to the verify/import helpers we use.
  noExternal: ["jose"],
});
