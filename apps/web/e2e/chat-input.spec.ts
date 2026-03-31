import { test, expect } from "@playwright/test";

test.describe("Chat input", () => {
  test("accepts text and submits a user message", async ({ page }) => {
    await page.goto("/");

    const chatInput = page.locator("#chat-input");
    const chatLog = page.locator("#chat-log");

    // Type a message
    await chatInput.fill("Hello motebit");
    await expect(chatInput).toHaveValue("Hello motebit");

    // Submit with Enter
    await chatInput.press("Enter");

    // User message should appear in chat log
    // The chat adds a .chat-bubble.user element
    const userBubble = chatLog.locator(".chat-bubble.user");
    await expect(userBubble.first()).toBeVisible();
    await expect(userBubble.first()).toContainText("Hello motebit");

    // Input should be cleared after send
    await expect(chatInput).toHaveValue("");
  });

  test("send button submits the message", async ({ page }) => {
    await page.goto("/");

    const chatInput = page.locator("#chat-input");
    await chatInput.fill("Test via button");

    // Click send button
    await page.locator("#send-btn").click();

    const userBubble = page.locator("#chat-log .chat-bubble.user");
    await expect(userBubble.first()).toContainText("Test via button");
  });

  test("empty input does not submit", async ({ page }) => {
    await page.goto("/");

    const chatLog = page.locator("#chat-log");

    // Press enter with empty input
    await page.locator("#chat-input").press("Enter");

    // No user bubble should appear
    const userBubbles = chatLog.locator(".chat-bubble.user");
    await expect(userBubbles).toHaveCount(0);
  });
});
