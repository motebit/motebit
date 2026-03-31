import { test, expect } from "@playwright/test";

test.describe("Keyboard shortcuts", () => {
  test("Escape closes open panels", async ({ page }) => {
    await page.goto("/");

    // Open settings
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-modal")).toHaveClass(/open/);

    // Escape should close it
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-modal")).not.toHaveClass(/open/);
  });

  test("Cmd+K focuses chat input", async ({ page }) => {
    await page.goto("/");

    // Click somewhere else first so input is not focused
    await page.locator("#motebit-canvas").click();

    // Cmd+K should focus the input
    await page.keyboard.press("Meta+k");
    await expect(page.locator("#chat-input")).toBeFocused();
  });

  test("? opens shortcut help dialog", async ({ page }) => {
    await page.goto("/");

    // Click canvas to ensure we're not in an input
    await page.locator("#motebit-canvas").click();

    const backdrop = page.locator("#shortcut-backdrop");
    await expect(backdrop).not.toHaveClass(/open/);

    await page.keyboard.press("?");
    await expect(backdrop).toHaveClass(/open/);

    // Escape closes it
    await page.keyboard.press("Escape");
    await expect(backdrop).not.toHaveClass(/open/);
  });

  test("Cmd+, opens settings", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Meta+,");
    await expect(page.locator("#settings-modal")).toHaveClass(/open/);
  });

  test("Cmd+J opens conversations panel", async ({ page }) => {
    await page.goto("/");

    const panel = page.locator("#conversations-panel");
    await page.keyboard.press("Meta+j");
    await expect(panel).toHaveClass(/open/);
  });
});
