import { describe, expect, it, vi } from "vitest";
import {
  wireReceiptSignPulse,
  type ReceiptPulseActivity,
  type ReceiptPulseReceipt,
} from "../cobrowse-chrome";

/**
 * The runtime fires the activity bus BEFORE it signs the receipt
 * (`streaming.ts`), and signing is fail-closed: a signing fault drops
 * the receipt. These fake buses reproduce that order so the test can
 * hold the pulse to the invariant — a "signed" pulse only for a call
 * whose receipt was actually signed.
 */
function fakeBuses() {
  const activity = new Set<(e: ReceiptPulseActivity) => void>();
  const receipts = new Set<(r: ReceiptPulseReceipt) => void>();
  return {
    buses: {
      subscribeToolActivity: (l: (e: ReceiptPulseActivity) => void) => {
        activity.add(l);
        return () => activity.delete(l);
      },
      subscribeToolInvocations: (l: (r: ReceiptPulseReceipt) => void) => {
        receipts.add(l);
        return () => receipts.delete(l);
      },
    },
    /** One tool call: activity first, then the receipt only if signing succeeded. */
    toolCall(
      invocationId: string,
      toolName: string,
      args: Record<string, unknown>,
      signed: boolean,
    ) {
      for (const l of activity) l({ invocation_id: invocationId, tool_name: toolName, args });
      if (signed) for (const l of receipts) l({ invocation_id: invocationId, tool_name: toolName });
    },
    listenerCount: () => activity.size + receipts.size,
  };
}

describe("wireReceiptSignPulse — the signed pulse claims only what was signed", () => {
  it("does NOT pulse when receipt signing fails closed", () => {
    const f = fakeBuses();
    const onSigned = vi.fn();
    wireReceiptSignPulse(f.buses, onSigned);
    f.toolCall("call-1", "computer", { kind: "click" }, false);
    expect(onSigned).not.toHaveBeenCalled();
  });

  it("pulses once, with the activity's args, when the receipt is signed", () => {
    const f = fakeBuses();
    const onSigned = vi.fn();
    wireReceiptSignPulse(f.buses, onSigned);
    f.toolCall("call-2", "computer", { kind: "screenshot" }, true);
    expect(onSigned).toHaveBeenCalledTimes(1);
    expect(onSigned).toHaveBeenCalledWith("computer", { kind: "screenshot" });
  });

  it("a failed call never borrows a later call's signature", () => {
    const f = fakeBuses();
    const onSigned = vi.fn();
    wireReceiptSignPulse(f.buses, onSigned);
    f.toolCall("call-a", "computer", { kind: "click" }, false);
    f.toolCall("call-b", "read_page", {}, true);
    expect(onSigned).toHaveBeenCalledTimes(1);
    expect(onSigned).toHaveBeenCalledWith("read_page", {});
  });

  it("unsubscribes from every bus it joined", () => {
    const f = fakeBuses();
    const off = wireReceiptSignPulse(f.buses, vi.fn());
    off();
    expect(f.listenerCount()).toBe(0);
  });
});
