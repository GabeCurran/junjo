import { describe, expect, it } from "vitest";
import type { DiagramSource } from "./discover-sources.ts";
import { RenderPlanError, buildRenderPlan } from "./render-plan.ts";

const SOURCES: DiagramSource[] = [
  { slug: "auth-flow", absPath: "/abs/source/auth-flow.mmd" },
  { slug: "system-architecture", absPath: "/abs/source/system-architecture.mmd" },
  { slug: "webhook-delivery", absPath: "/abs/source/webhook-delivery.mmd" },
];

describe("buildRenderPlan", () => {
  it("emits one task per source with the requested format", () => {
    const tasks = buildRenderPlan({
      sources: SOURCES,
      outDir: "/abs/out",
      format: "png",
    });
    expect(tasks).toHaveLength(3);
    expect(tasks[0]?.slug).toBe("auth-flow");
    expect(tasks[0]?.source).toBe("/abs/source/auth-flow.mmd");
    expect(tasks[0]?.output.replace(/\\/g, "/")).toBe("/abs/out/auth-flow.png");
  });

  it("respects the svg format", () => {
    const tasks = buildRenderPlan({
      sources: SOURCES,
      outDir: "/abs/out",
      format: "svg",
    });
    expect(tasks[1]?.output.replace(/\\/g, "/")).toBe("/abs/out/system-architecture.svg");
  });

  it("filters to a single task when filterSlug matches", () => {
    const tasks = buildRenderPlan({
      sources: SOURCES,
      outDir: "/abs/out",
      format: "png",
      filterSlug: "webhook-delivery",
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.slug).toBe("webhook-delivery");
  });

  it("throws RenderPlanError when filterSlug does not match", () => {
    expect(() =>
      buildRenderPlan({
        sources: SOURCES,
        outDir: "/abs/out",
        format: "png",
        filterSlug: "nope",
      }),
    ).toThrow(RenderPlanError);
  });

  it("includes the known slug list in the error message", () => {
    expect(() =>
      buildRenderPlan({
        sources: SOURCES,
        outDir: "/abs/out",
        format: "png",
        filterSlug: "nope",
      }),
    ).toThrow(/auth-flow.*system-architecture.*webhook-delivery/);
  });

  it("handles an empty source list with no filter as an empty plan", () => {
    expect(buildRenderPlan({ sources: [], outDir: "/abs/out", format: "png" })).toEqual([]);
  });

  it("throws RenderPlanError on empty source list with a filter", () => {
    expect(() =>
      buildRenderPlan({
        sources: [],
        outDir: "/abs/out",
        format: "png",
        filterSlug: "anything",
      }),
    ).toThrow(/Known slugs: \(none\)/);
  });
});
