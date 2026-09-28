/**
 * @vitest-environment jsdom
 *
 * #885 — a money warning (a hire's wallet ALSO sent another payment, or a
 * payment could not be recorded) arrives as a typed `payment_notice` chunk
 * and must reach the OWNER as a system message on every web path that can
 * pay: the AI-loop stream, the post-approval resume (a paid hire is R4, so
 * this is where it usually lands), and the deterministic chip invocation.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { WebContext } from "../types";

vi.mock("@motebit/voice", () => ({
  StreamingTTSQueue: class {
    push(): void {}
    flush(): void {}
    clear(): void {}
    cancel(): void {}
  },
  WebSpeechTTSProvider: class {
    cancel(): void {}
    speak(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

function mountChatDom(): void {
  document.body.innerHTML = `
    <div id="chat-log"></div>
    <input id="chat-input" />
    <div id="chat-input-row"></div>
    <button id="send-btn"></button>
    <div id="toast-container"></div>
  `;
}

let initChat: typeof import("../ui/chat").initChat;

// Cold import of the whole chat module under coverage instrumentation can
// exceed the 10s hook default on a loaded CI runner (the desktop sibling
// timed out on main, 2026-09-28) — an explicit budget, not a hang.
const COLD_CHAT_IMPORT_BUDGET_MS = 60_000;

beforeAll(async () => {
  mountChatDom();
  initChat = (await import("../ui/chat")).initChat;
}, COLD_CHAT_IMPORT_BUDGET_MS);

const NOTICE = {
  type: "payment_notice",
  notice: "This hire's wallet ALSO sent another payment (tx sigAAAAAAAAAAAA, landed)",
  extra_payments: [{ tx_hash: "sigAAAAAAAAAAAA", status: "landed" }],
};

function systemTexts(): string[] {
  return Array.from(document.querySelectorAll(".chat-bubble.system")).map(
    (b) => b.textContent ?? "",
  );
}

function start(app: Record<string, unknown>) {
  document.getElementById("chat-log")!.innerHTML = "";
  const ctx = {
    app: {
      isProcessing: false,
      isProviderConnected: true,
      motebitId: "test-motebit",
      setTaskStepNarration: vi.fn(),
      addArtifact: vi.fn(),
      removeArtifact: vi.fn(),
      ...app,
    } as unknown as WebContext["app"],
    showToast: vi.fn(),
    getConfig: () => null,
  } as unknown as WebContext;
  return initChat(ctx, { openSettings: vi.fn() } as unknown as Parameters<typeof initChat>[1]);
}

describe("payment_notice renders as a system message (#885)", () => {
  // First: the PR chip binds to the first chat init's ctx.
  it("in a deterministic chip invocation", async () => {
    start({
      async *invokeCapability() {
        yield NOTICE;
        yield { type: "text", text: "the review" };
      },
    });
    const input = document.getElementById("chat-input") as HTMLInputElement;
    input.value = "https://github.com/acme/repo/pull/7";
    input.dispatchEvent(new Event("input"));
    const chip = document.querySelector<HTMLElement>(".pr-url-chip");
    expect(chip).not.toBeNull();
    chip!.click();
    await vi.waitFor(() => {
      expect(systemTexts().some((t) => t.includes("Your wallet also sent another payment"))).toBe(
        true,
      );
    });
  });

  it("in the AI-loop stream", async () => {
    const api = start({
      async *sendMessageStreaming() {
        yield NOTICE;
        yield { type: "text", text: "done" };
        yield { type: "result" };
      },
    });
    await api.handleSend("hire someone");
    expect(systemTexts().some((t) => t.includes("Your wallet also sent another payment"))).toBe(
      true,
    );
  });

  it("in the post-approval resume (where a paid hire lands)", async () => {
    const api = start({
      // eslint-disable-next-line require-yield -- generator shape is the contract
      async *sendMessageStreaming() {
        yield {
          type: "approval_request",
          name: "delegate_to_agent",
          args: { prompt: "x" },
          risk_level: 4,
        };
      },
      async *resolveApprovalVote() {
        yield NOTICE;
        yield { type: "result" };
      },
    });
    const chatLog = document.getElementById("chat-log")!;
    const done = api.handleSend("hire someone");
    await vi.waitFor(() => {
      const allow = chatLog.querySelector<HTMLButtonElement>(".approval-btn.approve");
      expect(allow).not.toBeNull();
      allow!.click();
    });
    await done;
    expect(systemTexts().some((t) => t.includes("Your wallet also sent another payment"))).toBe(
      true,
    );
  });
});
