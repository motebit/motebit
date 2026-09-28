/**
 * #885 — on mobile, a money warning (`payment_notice`: a hire's wallet ALSO
 * sent another payment, or a payment could not be recorded) must reach the
 * OWNER as a system message. Chat turns and post-approval resumes both
 * stream through `consumeStream`, so that one consumer is the render site.
 */
import { describe, it, expect, vi } from "vitest";
import type { StreamChunk } from "@motebit/runtime";

// The hook is a thin wrapper around `consumeStream`; outside a React render,
// `useCallback` is just the function itself.
vi.mock("react", () => ({ useCallback: <T>(fn: T): T => fn }));

import { useChatStream } from "../use-chat-stream";
import type { UseChatStreamDeps } from "../use-chat-stream";

async function* stream(chunks: unknown[]): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c as StreamChunk;
}

describe("mobile payment_notice renders as a system message (#885)", () => {
  it("adds the owner-facing line from the payment_notice chunk", async () => {
    const addSystemMessage = vi.fn();
    const { consumeStream } = useChatStream({
      app: {} as UseChatStreamDeps["app"],
      setMessages: vi.fn(),
      addSystemMessage,
      pushTTSChunk: vi.fn(),
      flushTTS: vi.fn(),
      setIsProcessing: vi.fn(),
      pendingApprovalRef: { current: null },
      pendingGoalApprovalRef: { current: false },
      setTaskStepNarration: vi.fn(),
    });
    await consumeStream(
      stream([
        {
          type: "payment_notice",
          notice: "This hire's wallet ALSO sent another payment (tx sigAAAAAAAAAAAA, landed)",
          extra_payments: [{ tx_hash: "sigAAAAAAAAAAAA", status: "landed" }],
        },
      ]),
    );
    const lines = addSystemMessage.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("Your wallet also sent another payment"))).toBe(true);
  });
});
