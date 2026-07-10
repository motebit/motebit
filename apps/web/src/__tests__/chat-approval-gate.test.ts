/**
 * @vitest-environment jsdom
 *
 * Regression for #292 — assistant responses must NOT fuse across an
 * approval gate. The pre-gate narration and the post-gate response are
 * distinct assistant turns (separated by the tool_use/tool_result the
 * gate wraps); each must render in its OWN `.chat-bubble.assistant`. The
 * bug appended the post-gate text into the still-live pre-gate bubble.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { WebContext } from "../types";

// chat.ts imports the voice queue at module load — stub it.
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

// The 5 ids chat.ts grabs at module import — must exist BEFORE the import.
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

beforeAll(async () => {
  mountChatDom();
  initChat = (await import("../ui/chat")).initChat;
});

/** A ctx.app that streams: text → approval_request → (resume) text. */
function gateStreamingApp() {
  return {
    isProcessing: false,
    isProviderConnected: true,
    motebitId: "test-motebit",
    setTaskStepNarration: vi.fn(),
    addArtifact: vi.fn(),
    removeArtifact: vi.fn(),
    // eslint-disable-next-line require-yield -- generator shape is the contract
    async *sendMessageStreaming() {
      yield { type: "text", text: "the pre-gate narration" };
      yield {
        type: "approval_request",
        name: "delegate_to_agent",
        args: { prompt: "x" },
        risk_level: 4,
      };
    },
    async *resolveApprovalVote() {
      yield { type: "text", text: "THE-POST-GATE-RESPONSE" };
      yield { type: "result" };
    },
  } as unknown as WebContext["app"];
}

describe("approval gate — no bubble fusion (#292)", () => {
  it("renders the pre-gate and post-gate responses in TWO distinct assistant bubbles", async () => {
    const chatLog = document.getElementById("chat-log")!;
    chatLog.innerHTML = "";

    const ctx = {
      app: gateStreamingApp(),
      showToast: vi.fn(),
      getConfig: () => null,
    } as unknown as WebContext;

    const api = initChat(ctx, { openSettings: vi.fn() } as unknown as Parameters<
      typeof initChat
    >[1]);

    // Start the send; while it awaits the approval card, click Allow.
    const done = api.handleSend("do the thing");
    await vi.waitFor(() => {
      const allow = chatLog.querySelector<HTMLButtonElement>(".approval-btn.approve");
      expect(allow).not.toBeNull();
      allow!.click();
    });
    await done;

    const bubbles = chatLog.querySelectorAll(".chat-bubble.assistant");
    // Two turns, two bubbles — the core regression assertion.
    expect(bubbles.length).toBe(2);

    await vi.waitFor(() => {
      const texts = Array.from(bubbles).map((b) => b.textContent ?? "");
      // Pre-gate text lives only in bubble #1, post-gate only in bubble #2 —
      // neither bubble contains BOTH (that fusion is the bug).
      expect(texts.some((t) => t.includes("pre-gate") && t.includes("POST-GATE"))).toBe(false);
      expect(texts.some((t) => t.includes("pre-gate"))).toBe(true);
      expect(texts.some((t) => t.includes("POST-GATE"))).toBe(true);
    });
  });
});
