import { test, expect } from "@playwright/test";

test.describe("Settings panel", () => {
  test("opens and closes", async ({ page }) => {
    await page.goto("/");

    // Settings modal starts closed
    const modal = page.locator("#settings-modal");
    await expect(modal).not.toHaveClass(/open/);

    // Click settings button to open
    await page.locator("#settings-btn").click();
    await expect(modal).toHaveClass(/open/);

    // Backdrop is also open
    await expect(page.locator("#settings-backdrop")).toHaveClass(/open/);

    // Close by clicking cancel
    await page.locator("#settings-cancel").click();
    await expect(modal).not.toHaveClass(/open/);
  });

  test("theme toggle persists across reload", async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem("motebit-theme"));
    await page.goto("/");

    // Open settings
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-modal")).toHaveClass(/open/);

    // Click the "Dark" theme option
    await page.locator('[data-theme="dark"]').click();

    // Save settings
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-modal")).not.toHaveClass(/open/);

    // Dark theme should now be applied
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // Reload the page
    await page.reload();

    // Theme should persist
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("tab navigation works", async ({ page }) => {
    await page.goto("/");
    await page.locator("#settings-btn").click();

    // Default tab is appearance
    await expect(page.locator("#pane-appearance")).toHaveClass(/active/);

    // Click intelligence tab
    await page.locator("#tab-intelligence").click();
    await expect(page.locator("#pane-intelligence")).toHaveClass(/active/);
    await expect(page.locator("#pane-appearance")).not.toHaveClass(/active/);

    // Click governance tab
    await page.locator("#tab-governance").click();
    await expect(page.locator("#pane-governance")).toHaveClass(/active/);

    // Click identity tab
    await page.locator("#tab-identity").click();
    await expect(page.locator("#pane-identity")).toHaveClass(/active/);
  });
});
