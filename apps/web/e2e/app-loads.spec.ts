import { test, expect } from "@playwright/test";

test.describe("App loads without crashing", () => {
  test("page renders with canvas, chat input, and HUD buttons", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");

    // Canvas exists and has non-zero dimensions
    const canvas = page.locator("#motebit-canvas");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);

    // Chat input exists and is focusable
    const chatInput = page.locator("#chat-input");
    await expect(chatInput).toBeVisible();
    await chatInput.focus();
    await expect(chatInput).toBeFocused();

    // HUD buttons are present
    await expect(page.locator("#settings-btn")).toBeVisible();
    await expect(page.locator("#conversations-btn")).toBeVisible();
    await expect(page.locator("#memory-btn")).toBeVisible();
    await expect(page.locator("#goals-btn")).toBeVisible();
    await expect(page.locator("#agents-btn")).toBeVisible();

    // No uncaught errors during load
    expect(errors).toEqual([]);
  });

  test("dark theme is applied by default on dark-preferring system", async ({ page }) => {
    // Emulate dark color scheme
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");

    const theme = await page.getAttribute("html", "data-theme");
    expect(theme).toBe("dark");
  });

  test("light theme when system prefers light", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    // Clear any stored theme preference
    await page.addInitScript(() => localStorage.removeItem("motebit-theme"));
    await page.goto("/");

    const theme = await page.getAttribute("html", "data-theme");
    // No data-theme attribute means light (the default)
    expect(theme).toBeNull();
  });
});
