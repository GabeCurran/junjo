import { describe, expect, it } from "vitest";
import { renderIndexMd } from "./index-md.ts";
import type { CapturedScreenshot } from "./types.ts";

const sample: CapturedScreenshot[] = [
  {
    area: "dashboard",
    routeSlug: "home",
    routePath: "/",
    routeDescription: "landing page",
    viewport: "desktop",
    filePath: "/abs/tools/screenshots/output/dashboard/home.desktop.png",
  },
  {
    area: "dashboard",
    routeSlug: "home",
    routePath: "/",
    routeDescription: "landing page",
    viewport: "mobile",
    filePath: "/abs/tools/screenshots/output/dashboard/home.mobile.png",
  },
];

describe("renderIndexMd", () => {
  it("renders a header and table with one row per capture", () => {
    const md = renderIndexMd("dashboard", sample);
    expect(md).toMatch(/^# dashboard screenshot catalog/);
    expect(md).toContain("| Route slug | Viewport | Path | File | Description |");
    expect(md).toContain("`home`");
    expect(md).toContain("`/`");
    expect(md).toContain("desktop");
    expect(md).toContain("mobile");
  });

  it("sorts captures by route slug then viewport", () => {
    const out = renderIndexMd("dashboard", [
      {
        area: "dashboard",
        routeSlug: "z-last",
        routePath: "/z",
        routeDescription: "z",
        viewport: "mobile",
        filePath: "out/dashboard/z-last.mobile.png",
      },
      {
        area: "dashboard",
        routeSlug: "a-first",
        routePath: "/a",
        routeDescription: "a",
        viewport: "desktop",
        filePath: "out/dashboard/a-first.desktop.png",
      },
    ]);
    const aIndex = out.indexOf("a-first");
    const zIndex = out.indexOf("z-last");
    expect(aIndex).toBeGreaterThan(0);
    expect(zIndex).toBeGreaterThan(aIndex);
  });

  it("escapes pipe characters in descriptions", () => {
    const md = renderIndexMd("dashboard", [
      {
        area: "dashboard",
        routeSlug: "x",
        routePath: "/x",
        routeDescription: "left | right",
        viewport: "desktop",
        filePath: "out/dashboard/x.desktop.png",
      },
    ]);
    expect(md).toContain("left \\| right");
  });

  it("uses a 2-segment relative path so links resolve next to INDEX.md", () => {
    const md = renderIndexMd("dashboard", sample);
    expect(md).toContain("[`dashboard/home.desktop.png`](./dashboard/home.desktop.png)");
  });
});
