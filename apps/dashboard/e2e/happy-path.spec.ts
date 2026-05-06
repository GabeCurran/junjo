// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { expect, test } from "@playwright/test";

const JUNJO_BASE_URL = process.env.JUNJO_BASE_URL ?? "http://127.0.0.1:8787";

// The full happy path needs a live Junjo server reachable at
// JUNJO_BASE_URL with admin credentials wired through to the dashboard's
// `next dev` process (see playwright.config.ts). When the server is not
// reachable the page renders a degraded state, so we gate the test on a
// pre-flight ping instead of letting it fail with cryptic UI assertions.
test.describe("dashboard happy path", () => {
  test.beforeAll(async ({ request }) => {
    let reachable = false;
    try {
      const res = await request.get(`${JUNJO_BASE_URL}/`, { timeout: 3_000 });
      reachable = res.ok();
    } catch {
      reachable = false;
    }
    test.skip(
      !reachable,
      `Junjo server at ${JUNJO_BASE_URL} is not reachable; bring it up with \`npm run dev -w @junjo/server\` and re-run.`,
    );
  });

  test("create game, issue key, seed group, walk into it", async ({ page, request }) => {
    const gameName = `E2E Game ${Date.now().toString()}`;

    await page.goto("/games");
    await expect(page.getByRole("heading", { name: /Games/ }).first()).toBeVisible();

    await page.getByRole("button", { name: "Create game" }).click();
    await page.getByLabel("Name").fill(gameName);
    await page.getByRole("button", { name: "Create game" }).nth(1).click();

    const gameRow = page.getByRole("row").filter({ hasText: gameName }).first();
    await expect(gameRow).toBeVisible({ timeout: 15_000 });
    await gameRow.getByRole("link").first().click();

    await expect(page.getByRole("heading", { name: gameName }).first()).toBeVisible();

    await page.getByRole("button", { name: "Issue key" }).click();
    await page.getByRole("button", { name: "Issue key" }).nth(1).click();
    const secret = (await page.getByTestId("api-key-secret").innerText()).trim();
    expect(secret).toMatch(/^jk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await page.getByRole("button", { name: "Done" }).click();

    const createGroupRes = await request.post(`${JUNJO_BASE_URL}/v1/groups`, {
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      data: { kind: "guild", name: "E2E Seeded Group" },
    });
    expect(createGroupRes.status(), await createGroupRes.text()).toBe(201);
    const created = (await createGroupRes.json()) as { id: string; name: string };
    expect(created.name).toBe("E2E Seeded Group");

    const gameUrl = page.url();
    const gameIdMatch = gameUrl.match(/\/games\/([^/?#]+)/);
    expect(gameIdMatch?.[1], "expected /games/<id> in URL after navigation").toBeTruthy();
    const gameId = gameIdMatch?.[1] ?? "";

    await page.goto(`/games/${gameId}/groups`);
    const groupRow = page.getByRole("row").filter({ hasText: "E2E Seeded Group" }).first();
    await expect(groupRow).toBeVisible({ timeout: 15_000 });
    await groupRow.getByRole("link").first().click();

    await expect(page.getByRole("heading", { name: /E2E Seeded Group/ }).first()).toBeVisible();
    const tabs = page.getByRole("link", { name: /Members|Roles|Permissions|Audit/ });
    await expect(tabs.first()).toBeVisible();
  });
});
