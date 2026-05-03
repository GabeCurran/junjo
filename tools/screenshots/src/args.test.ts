import { describe, expect, it } from "vitest";
import { ArgsError, parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("parses --target alone", () => {
    expect(parseArgs(["--target=dashboard"])).toEqual({ target: "dashboard" });
  });

  it("parses --target with --base, --route, --viewport, --out-dir", () => {
    const result = parseArgs([
      "--target=docs",
      "--base=http://localhost:3000",
      "--route=home",
      "--viewport=mobile",
      "--out-dir=/tmp/out",
    ]);
    expect(result).toEqual({
      target: "docs",
      base: "http://localhost:3000",
      route: "home",
      viewport: "mobile",
      outDir: "/tmp/out",
    });
  });

  it("parses --viewport on its own", () => {
    expect(parseArgs(["--target=dashboard", "--viewport=mobile"])).toEqual({
      target: "dashboard",
      viewport: "mobile",
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
