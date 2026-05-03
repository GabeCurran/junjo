import { describe, expect, it } from "vitest";
import { ArgsError, parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("parses --target alone", () => {
    expect(parseArgs(["--target=dashboard"])).toEqual({ target: "dashboard" });
  });

  it("parses --target with --base, --route, --out-dir", () => {
    const result = parseArgs([
      "--target=docs",
      "--base=http://localhost:3000",
      "--route=home",
      "--out-dir=/tmp/out",
    ]);
    expect(result).toEqual({
      target: "docs",
      base: "http://localhost:3000",
      route: "home",
      outDir: "/tmp/out",
    });
  });

  it("rejects missing --target", () => {
    expect(() => parseArgs([])).toThrow(ArgsError);
    expect(() => parseArgs(["--base=x"])).toThrow(/missing required --target/);
  });

  it("rejects positional arguments", () => {
    expect(() => parseArgs(["dashboard"])).toThrow(/unexpected positional/);
  });

  it("rejects flags without =value", () => {
    expect(() => parseArgs(["--target"])).toThrow(/expected --key=value/);
  });

  it("rejects empty flag name", () => {
    expect(() => parseArgs(["--=value"])).toThrow(/empty flag name/);
  });
});
