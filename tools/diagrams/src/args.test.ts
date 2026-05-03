import { describe, expect, it } from "vitest";
import { ArgsError, parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("returns an empty object when no args are passed", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("parses --file=<slug>", () => {
    expect(parseArgs(["--file=system-architecture"])).toEqual({
      file: "system-architecture",
    });
  });

  it("parses --source-dir and --out-dir", () => {
    const result = parseArgs(["--source-dir=/tmp/src", "--out-dir=/tmp/out"]);
    expect(result).toEqual({ sourceDir: "/tmp/src", outDir: "/tmp/out" });
  });

  it("parses --format=svg", () => {
    expect(parseArgs(["--format=svg"])).toEqual({ format: "svg" });
  });

  it("parses --format=png", () => {
    expect(parseArgs(["--format=png"])).toEqual({ format: "png" });
  });

  it("rejects invalid --format", () => {
    expect(() => parseArgs(["--format=jpeg"])).toThrow(/--format must be 'png' or 'svg'/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--target=docs"])).toThrow(/unknown flag: --target/);
  });

  it("rejects positional arguments", () => {
    expect(() => parseArgs(["render"])).toThrow(/unexpected positional/);
  });

  it("rejects flags without =value", () => {
    expect(() => parseArgs(["--file"])).toThrow(/expected --key=value/);
  });

  it("rejects empty flag name", () => {
    expect(() => parseArgs(["--=value"])).toThrow(/empty flag name/);
  });

  it("returns ArgsError instances on validation failure", () => {
    expect(() => parseArgs(["--unknown=x"])).toThrow(ArgsError);
  });
});
