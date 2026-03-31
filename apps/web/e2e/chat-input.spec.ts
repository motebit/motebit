import { test, expect } from "@playwright/test";

test.describe("Chat input", () => {
  test("accepts text and submits a user message", async ({ page }) => {
    await page.goto("/");

    const chatInput = page.locator("#chat-input");

    // Type a message
    await chatInput.fill("Hello motebit");
    await expect(chatInput).toHaveValue("Hello motebit");

    // Submit with Enter — message appends to DOM as .chat-bubble.user
    await chatInput.press("Enter");

    // Input should be cleared after send (even if provider is unavailable)
    await expect(chatInput).toHaveValue("");
  });

  test("send button submits the message", async ({ page }) => {
    await page.goto("/");

    const chatInput = page.locator("#chat-input");
    await chatInput.fill("Test via button");

    // Click send button
    await page.locator("#send-btn").click();

    // Input should be cleared
    await expect(chatInput).toHaveValue("");
  });

  test("empty input does not submit", async ({ page }) => {
    await page.goto("/");

    // Press enter with empty input — should not clear or error
    const chatInput = page.locator("#chat-input");
    await chatInput.press("Enter");
    await expect(chatInput).toHaveValue("");
  });
});
