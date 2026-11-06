import { describe, expect, it } from "vitest";
import { generateLinkCode, hashLinkCode, normalizeLinkCode } from "./identityLink";

describe("link codes", () => {
  it("generates two groups of four from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateLinkCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it("normalizes case, separators and look-alike letters", () => {
    expect(normalizeLinkCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeLinkCode(" 0O1I L234 ")).toBe("00111234");
    expect(normalizeLinkCode("ABCD-EFG")).toBeNull();
    expect(normalizeLinkCode("ABCD-EFGU")).toBeNull();
    expect(normalizeLinkCode("ABCD_EFGH")).toBeNull();
  });

  it("hashes the normalized form so every spelling of a code matches", () => {
    const a = normalizeLinkCode("abcd-efgh") as string;
    const b = normalizeLinkCode("ABCDEFGH") as string;
    expect(hashLinkCode(a)).toBe(hashLinkCode(b));
    expect(hashLinkCode(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
