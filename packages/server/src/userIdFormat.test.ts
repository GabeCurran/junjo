import { describe, expect, it } from "vitest";
import { JunjoError } from "./errors";
import { pickRenderedId } from "./identity";
import {
  assertUserIdWellFormed,
  isUserIdWellFormed,
  matchesUserIdFormat,
  userIdNamespace,
} from "./userIdFormat";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("userIdNamespace", () => {
  it("is the text before the first colon", () => {
    expect(userIdNamespace(`mc:${UUID}`)).toBe("mc");
    expect(userIdNamespace("web:a:b")).toBe("web");
  });

  it("is null without a colon or with an empty prefix", () => {
    expect(userIdNamespace("user_alice")).toBeNull();
    expect(userIdNamespace(":x")).toBeNull();
  });
});

describe("matchesUserIdFormat uuid", () => {
  it("accepts the lowercase hyphenated form only", () => {
    expect(matchesUserIdFormat("uuid", UUID)).toBe(true);
    expect(matchesUserIdFormat("uuid", UUID.toUpperCase())).toBe(false);
    expect(matchesUserIdFormat("uuid", UUID.replaceAll("-", ""))).toBe(false);
    expect(matchesUserIdFormat("uuid", `${UUID} `)).toBe(false);
    expect(matchesUserIdFormat("uuid", "")).toBe(false);
  });
});

describe("isUserIdWellFormed", () => {
  const formats = { mc: "uuid" } as const;

  it("checks ids in a declared namespace", () => {
    expect(isUserIdWellFormed(formats, `mc:${UUID}`)).toBe(true);
    expect(isUserIdWellFormed(formats, `mc:${UUID.toUpperCase()}`)).toBe(false);
    expect(isUserIdWellFormed(formats, "mc:")).toBe(false);
  });

  it("ignores ids outside declared namespaces", () => {
    expect(isUserIdWellFormed(formats, "web:ABC")).toBe(true);
    expect(isUserIdWellFormed(formats, "user_alice")).toBe(true);
    expect(isUserIdWellFormed({}, "mc:ABC")).toBe(true);
  });

  it("does not treat inherited object keys as namespaces", () => {
    expect(isUserIdWellFormed(formats, "constructor:x")).toBe(true);
    expect(isUserIdWellFormed(formats, "__proto__:x")).toBe(true);
  });

  it("rejects with invalid_user_id", () => {
    try {
      assertUserIdWellFormed(formats, "mc:ABC");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JunjoError);
      expect((err as JunjoError).code).toBe("invalid_user_id");
      expect((err as JunjoError).status).toBe(400);
    }
  });
});

describe("pickRenderedId", () => {
  const ordered = ["mc:1", "web:2", "discord:3", "mc:4"];

  it("takes the earliest id in the first preferred namespace present", () => {
    expect(pickRenderedId(ordered, ["discord", "mc"])).toBe("discord:3");
    expect(pickRenderedId(ordered, ["mc"])).toBe("mc:1");
    expect(pickRenderedId(ordered, ["steam", "web"])).toBe("web:2");
  });

  it("falls back to the earliest id overall", () => {
    expect(pickRenderedId(ordered, [])).toBe("mc:1");
    expect(pickRenderedId(ordered, ["steam"])).toBe("mc:1");
    expect(pickRenderedId(["plain", "web:2"], ["mc"])).toBe("plain");
  });
});
