import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { JunjoError } from "../errors";
import { errorHandler } from "./error";

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/junjo", () => {
    throw new JunjoError("not_found", 404, "group not found");
  });
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  return app;
}

describe("errorHandler", () => {
  it("renders JunjoError as JSON with the right status", async () => {
    const res = await buildApp().request("/junjo");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      code: "not_found",
      status: 404,
      message: "group not found",
    });
  });

  it("renders unknown errors as a 500 with a generic body", async () => {
    const res = await buildApp().request("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      code: "internal",
      status: 500,
      message: "internal error",
    });
  });
});
