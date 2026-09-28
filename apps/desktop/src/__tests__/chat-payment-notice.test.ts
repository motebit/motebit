/**
 * @vitest-environment jsdom
 *
 * #885 — on desktop, a money warning (`payment_notice`: a hire's wallet ALSO
 * sent another payment, or a payment could not be recorded) must reach the
 * OWNER as a system message on the chat stream and on the post-approval
 * resume (a paid hire is R4, so that is where it usually lands) — never only
 * as tool text the model may or may not relay.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { DesktopContext } from "../types";

function mountChatDom(): void {
  document.body.innerHTML = `
    <div id="chat-log"></div>
    <div id="chat-input-row"><input id="chat-input" /></div>
    <div id="toast-container"></div>
  `;
}

let chat: typeof import("../ui/chat");

beforeAll(async () => {
  mountChatDom();
  chat = await import("../ui/chat");
});

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
      motebitId: "test-motebit",
      addArtifact: vi.fn(),
      removeArtifact: vi.fn(),
      ...app,
    },
  } as unknown as DesktopContext;
  const callbacks = new Proxy({}, { get: () => vi.fn() }) as unknown as Parameters<
    typeof chat.initChat
  >[1];
  return chat.initChat(ctx, callbacks);
}

describe("desktop payment_notice renders as a system message (#885)", () => {
  it("in the chat stream", async () => {
    const api = start({
      async *sendMessageStreaming() {
        yield NOTICE;
        yield { type: "text", text: "done" };
      },
    });
    (document.getElementById("chat-input") as HTMLInputElement).value = "hire someone";
    await api.handleSend();
    expect(systemTexts().some((t) => t.includes("Your wallet also sent another payment"))).toBe(
      true,
    );
    api.destroy();
  });

  it("in the post-approval resume", async () => {
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
      },
    });
    (document.getElementById("chat-input") as HTMLInputElement).value = "hire someone";
    await api.handleSend();
    const allow = await vi.waitFor(() => {
      const b = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((x) =>
        /allow|approve/i.test(x.textContent ?? ""),
      );
      expect(b).toBeDefined();
      return b!;
    });
    allow.click();
    await vi.waitFor(() => {
      expect(systemTexts().some((t) => t.includes("Your wallet also sent another payment"))).toBe(
        true,
      );
    });
    api.destroy();
  });
});
