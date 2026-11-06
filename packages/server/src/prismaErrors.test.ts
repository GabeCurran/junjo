import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { isSerializationFailure } from "./prismaErrors";

function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("failed", {
    code,
    clientVersion: "test",
    meta,
  });
}

describe("isSerializationFailure", () => {
  it("matches the model-query code", () => {
    expect(isSerializationFailure(known("P2034"))).toBe(true);
  });

  it("matches raw-query failures carrying a serialization or deadlock SQLSTATE", () => {
    expect(isSerializationFailure(known("P2010", { code: "40001" }))).toBe(true);
    expect(isSerializationFailure(known("P2010", { code: "40P01" }))).toBe(true);
  });

  it("rejects other raw-query failures and other errors", () => {
    expect(isSerializationFailure(known("P2010", { code: "23505" }))).toBe(false);
    expect(isSerializationFailure(known("P2002"))).toBe(false);
    expect(isSerializationFailure(new Error("40001"))).toBe(false);
  });
});
