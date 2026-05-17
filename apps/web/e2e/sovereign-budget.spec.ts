import { test, expect } from "@playwright/test";

test.describe("Sovereign panel — Budget tab", () => {
  test("renders balances without skeleton on cold-load (substrate-honest default)", async ({
    page,
  }) => {
    await page.goto("/");

    await page.locator("#sovereign-btn").click();
    await expect(page.locator("#sovereign-panel")).toHaveClass(/open/);

    await page.locator('.sov-tab[data-tab="budget"]').click();
    const budgetPane = page.locator("#sov-pane-budget");
    await expect(budgetPane).toHaveClass(/active/);

    // The doctrine: skeleton was the "Loading…" anti-pattern in another
    // shape — hedging "we don't know yet" over the truth that an unfunded
    // motebit IS at $0. Cold-load must show the substrate-honest default,
    // never the shimmer.
    await expect(budgetPane.locator(".sov-hero-skeleton")).toHaveCount(0);

    // Both hero cards must render with a visible value (the $0 default,
    // a real number once a fetch resolves, or the failure-explicit "—"
    // paired with the error row above).
    const valueSlots = budgetPane.locator(".sov-hero-card .sov-hero-value");
    await expect(valueSlots).toHaveCount(2);
    for (const slot of await valueSlots.all()) {
      const text = (await slot.textContent())?.trim() ?? "";
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
