import { describe, it, expect, vi } from "vitest";

import {
  createWorkstationController,
  type ToolInvocationReceiptLike,
  type WorkstationFetchAdapter,
} from "../controller";

// ── Fixtures ─────────────────────────────────────────────────────────

function makeReceipt(
  overrides: Partial<ToolInvocationReceiptLike> = {},
): ToolInvocationReceiptLike {
  return {
    invocation_id: `inv-${Math.random().toString(36).slice(2, 8)}`,
    task_id: "task-1",
    motebit_id: "mote-abc",
    public_key: "a".repeat(64),
    device_id: "device-1",
    tool_name: "read_url",
    started_at: 1700000000000,
    completed_at: 1700000001500,
    status: "completed",
    args_hash: "b".repeat(64),
    result_hash: "c".repeat(64),
    invocation_origin: "ai-loop",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig-stub",
    ...overrides,
  };
}

function makeAdapter(): WorkstationFetchAdapter & {
  fire(receipt: ToolInvocationReceiptLike): void;
  unsubscribed: boolean;
  listenerCount: number;
} {
  const listeners = new Set<(r: ToolInvocationReceiptLike) => void>();
  let unsubscribed = false;
  return {
    get unsubscribed() {
      return unsubscribed;
    },
    get listenerCount() {
      return listeners.size;
    },
    subscribeToolInvocations(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribed = true;
      };
    },
    fire(receipt) {
      for (const listener of listeners) listener(receipt);
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("createWorkstationController", () => {
  it("starts with empty state", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter);
    const state = controller.getState();
    expect(state.history).toEqual([]);
    expect(state.lastReceiptAt).toBeNull();
    expect(state.receiptCount).toBe(0);
    controller.dispose();
  });

  it("subscribes to the adapter at construction time", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter);
    expect(adapter.listenerCount).toBe(1);
    controller.dispose();
  });

  it("appends receipts to history as they arrive", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter);

    const r1 = makeReceipt({ invocation_id: "tc_1", tool_name: "read_url" });
    const r2 = makeReceipt({ invocation_id: "tc_2", tool_name: "web_search" });
    adapter.fire(r1);
    adapter.fire(r2);

    const s = controller.getState();
    expect(s.history).toHaveLength(2);
    expect(s.history[0]!.invocation_id).toBe("tc_1");
    expect(s.history[1]!.invocation_id).toBe("tc_2");
    expect(s.receiptCount).toBe(2);
    expect(s.lastReceiptAt).toBe(r2.completed_at);
    controller.dispose();
  });

  it("notifies subscribers on each receipt", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter);
    const listener = vi.fn();

    const unsub = controller.subscribe(listener);
    adapter.fire(makeReceipt({ invocation_id: "tc_1" }));
    adapter.fire(makeReceipt({ invocation_id: "tc_2" }));

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]![0].history).toHaveLength(2);
    unsub();
    adapter.fire(makeReceipt({ invocation_id: "tc_3" }));
    expect(listener).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("trims history to maxHistory (FIFO)", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter, { maxHistory: 3 });

    for (let i = 0; i < 5; i++) {
      adapter.fire(makeReceipt({ invocation_id: `tc_${i}` }));
    }
    const s = controller.getState();
    expect(s.history).toHaveLength(3);
    expect(s.history[0]!.invocation_id).toBe("tc_2");
    expect(s.history[2]!.invocation_id).toBe("tc_4");
    // receiptCount reflects all receipts observed, not the trimmed history length
    expect(s.receiptCount).toBe(5);
    controller.dispose();
  });

  it("clearHistory resets visible state but keeps the subscription", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter);

    adapter.fire(makeReceipt({ invocation_id: "tc_1" }));
    adapter.fire(makeReceipt({ invocation_id: "tc_2" }));
    expect(controller.getState().history).toHaveLength(2);

    controller.clearHistory();
    const cleared = controller.getState();
    expect(cleared.history).toEqual([]);
    expect(cleared.lastReceiptAt).toBeNull();
    expect(cleared.receiptCount).toBe(0);

    // Subscription still live — new receipts accumulate normally.
    adapter.fire(makeReceipt({ invocation_id: "tc_3" }));
    expect(controller.getState().history).toHaveLength(1);
    controller.dispose();
  });

  it("dispose unsubscribes from the adapter and stops accepting receipts", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter);

    adapter.fire(makeReceipt({ invocation_id: "tc_1" }));
    controller.dispose();
    expect(adapter.unsubscribed).toBe(true);

    adapter.fire(makeReceipt({ invocation_id: "tc_2" }));
    // State is frozen — no new entry added, no count bump.
    expect(controller.getState().history).toHaveLength(1);
    expect(controller.getState().receiptCount).toBe(1);
  });

  it("isolates listener exceptions", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter);

    const noisy = vi.fn(() => {
      throw new Error("subscriber on fire");
    });
    const calm = vi.fn();
    controller.subscribe(noisy);
    controller.subscribe(calm);

    adapter.fire(makeReceipt({ invocation_id: "tc_1" }));

    expect(noisy).toHaveBeenCalledTimes(1);
    expect(calm).toHaveBeenCalledTimes(1);
    expect(controller.getState().history).toHaveLength(1);
    controller.dispose();
  });

  it("clamps maxHistory to at least 1", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter, { maxHistory: 0 });

    adapter.fire(makeReceipt({ invocation_id: "tc_1" }));
    adapter.fire(makeReceipt({ invocation_id: "tc_2" }));

    expect(controller.getState().history).toHaveLength(1);
    expect(controller.getState().history[0]!.invocation_id).toBe("tc_2");
    controller.dispose();
  });

  it("ignores receipts after dispose is called mid-stream", () => {
    const adapter = makeAdapter();
    const controller = createWorkstationController(adapter);

    adapter.fire(makeReceipt({ invocation_id: "tc_1" }));
    expect(controller.getState().receiptCount).toBe(1);

    controller.dispose();

    // Adapter's unsubscribe should have run; forced-fire still no-ops the
    // state because the dispose flag guards onReceipt.
    adapter.fire(makeReceipt({ invocation_id: "tc_2" }));
    expect(controller.getState().receiptCount).toBe(1);
  });
});
