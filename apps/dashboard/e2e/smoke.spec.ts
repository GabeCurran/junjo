// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { expect, test } from "@playwright/test";

interface RouteCheck {
  path: string;
  expectedTitle: RegExp;
}

const TOP_LEVEL_ROUTES: readonly RouteCheck[] = [
  { path: "/overview", expectedTitle: /Dashboard \| Junjo/ },
  { path: "/games", expectedTitle: /Games \| Junjo Dashboard/ },
  { path: "/audit", expectedTitle: /Audit \| Junjo Dashboard/ },
  { path: "/permissions", expectedTitle: /Permissions \| Junjo Dashboard/ },
  { path: "/analytics", expectedTitle: /Analytics \| Junjo Dashboard/ },
];

test.describe("dashboard smoke", () => {
  test("landing page at / is public (no Basic Auth)", async ({ request }) => {
    const res = await request.get("/", { headers: { authorization: "" } });
    expect(res.status()).toBe(200);
  });

  test("Basic Auth gate denies missing credentials on admin paths", async ({ request }) => {
    const res = await request.get("/overview", { headers: { authorization: "" } });
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toContain("Basic");
  });

  test("sidebar brand renders on the dashboard home page", async ({ page }) => {
    await page.goto("/overview");
    await expect(page).toHaveTitle(/Dashboard \| Junjo/);
    await expect(page.getByText("Junjo", { exact: true }).first()).toBeVisible();
  });

  for (const route of TOP_LEVEL_ROUTES) {
    test(`renders ${route.path} without error`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
      expect(response, `no response for ${route.path}`).not.toBeNull();
      expect(response?.status(), `${route.path} returned ${response?.status()}`).toBeLessThan(500);
      await expect(page).toHaveTitle(route.expectedTitle);
      expect(errors, `page errors on ${route.path}: ${errors.join("; ")}`).toEqual([]);
    });
  }

  test("nav exposes the five top-level destinations", async ({ page }) => {
    await page.goto("/overview");
    for (const label of ["Dashboard", "Games", "Audit", "Permissions", "Analytics"]) {
      await expect(page.getByRole("link", { name: label }).first()).toBeVisible();
    }
  });
});
