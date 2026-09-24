import { test, expect } from "@playwright/test";

test.describe("Sovereign panel — Ledger tab", () => {
  test("empty register is honest without a relay (local-first, #594 Inc 3a)", async ({ page }) => {
    await page.goto("/");

    await page.locator("#sovereign-btn").click();
    await expect(page.locator("#sovereign-panel")).toHaveClass(/open/);

    await page.locator('.sov-tab[data-tab="ledger"]').click();
    await expect(page.locator("#sov-pane-ledger")).toHaveClass(/active/);

    // The Ledger merges local execution rows with relay rows in the
    // controller; a fresh identity with no fires and no relay shows the
    // PASSIVE empty register — it must never demand a relay to display
    // what is locally true (the renderer-relay-gate drift class).
    const empty = page.locator("#ledger-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("Execution history appears here");
    await expect(empty).toContainText("as goals complete");
    await expect(empty).not.toContainText("relay");
  });
});
