import { afterEach, describe, expect, it } from "vitest";
import { getMaxPageSize, resetMaxPageSize, setMaxPageSize } from "./runtime";

describe("runtime maxPageSize", () => {
  afterEach(() => {
    resetMaxPageSize();
  });

  it("defaults to 100", () => {
    expect(getMaxPageSize()).toBe(100);
  });

  it("setMaxPageSize updates the cap", () => {
    setMaxPageSize(5000);
    expect(getMaxPageSize()).toBe(5000);
  });

  it("rejects non-positive integers", () => {
    expect(() => setMaxPageSize(0)).toThrow(/positive integer/);
    expect(() => setMaxPageSize(-1)).toThrow(/positive integer/);
    expect(() => setMaxPageSize(1.5)).toThrow(/positive integer/);
  });

  it("resetMaxPageSize restores the default", () => {
    setMaxPageSize(500);
    resetMaxPageSize();
    expect(getMaxPageSize()).toBe(100);
  });
});
