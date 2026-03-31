import { test, expect } from "@playwright/test";

/**
 * Inject a stub provider so chat submission reaches the DOM (user bubble + assistant echo).
 * Without a provider, the app shows "No provider connected" and skips message rendering.
 */
async function injectStubProvider(page: import("@playwright/test").Page): Promise<void> {
  // Wait for async bootstrap (IDB, runtime, renderer) to complete
  await page.waitForFunction(() => window.__motebitReady === true, null, { timeout: 10_000 });

  await page.evaluate(() => {
    const app = window.__motebitApp;
    if (!app) throw new Error("__motebitApp not exposed");

    app.setProviderDirect({
      model: "e2e-stub",
      setModel() {},
      async generate() {
        return {
          text: "stub response",
          confidence: 0.8,
          memory_candidates: [],
          state_updates: {},
        };
      },
      estimateConfidence: async () => 0.8,
      extractMemoryCandidates: async () => [],
      async *generateStream() {
        yield { type: "text" as const, text: "stub response" };
        yield {
          type: "done" as const,
          response: {
            text: "stub response",
            confidence: 0.8,
            memory_candidates: [],
            state_updates: {},
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

test.describe("Chat input", () => {
  test("accepts text and submits a user message", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#chat-input");
    await injectStubProvider(page);

    const chatInput = page.locator("#chat-input");

    // Type and submit
    await chatInput.fill("Hello motebit");
    await chatInput.press("Enter");

    // User message should appear in chat log
    const userBubble = page.locator("#chat-log .chat-bubble.user");
    await expect(userBubble.first()).toBeVisible();
    await expect(userBubble.first()).toContainText("Hello motebit");

    // Input should be cleared after send
    await expect(chatInput).toHaveValue("");
  });

  test("send button submits the message", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#chat-input");
    await injectStubProvider(page);

    const chatInput = page.locator("#chat-input");
    await chatInput.fill("Test via button");

    // Click send button
    await page.locator("#send-btn").click();

    const userBubble = page.locator("#chat-log .chat-bubble.user");
    await expect(userBubble.first()).toContainText("Test via button");
  });

  test("empty input does not submit", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#chat-input");

    const chatLog = page.locator("#chat-log");

    // Press enter with empty input
    await page.locator("#chat-input").press("Enter");

    // No user bubble should appear
    const userBubbles = chatLog.locator(".chat-bubble.user");
    await expect(userBubbles).toHaveCount(0);
  });

  // No "no provider" test — the app auto-detects local Ollama,
  // making this test environment-dependent. The no-provider path is
  // implicitly covered in CI where no local inference is available.
});
