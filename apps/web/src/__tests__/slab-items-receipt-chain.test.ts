/**
 * Tests for `summarizeDelegationReceipt` + `truncatePeerId` — the
 * pure helpers behind the peer_viewport slab card's receipt-chain
 * detail. Per slice 3p-2 doctrine (motebit-computer.md
 * §"peer_viewport"), the receipt IS the proof; the chain is the
 * shape of that proof.
 *
 * These are pure-function tests, no DOM. The DOM-side rendering
 * (`applyDelegationPayload` → `makeChainRow` etc.) is exercised by
 * the existing Playwright E2E cadence per `apps/web/vitest.config.ts`'s
 * `coverageExclude: src/ui/**` rule.
 */

import { describe, it, expect } from "vitest";
import {
  summarizeDelegationReceipt,
  truncatePeerId,
  describeOutboundWait,
  type ReceiptSummary,
} from "../ui/slab-items.js";

const SINGLE_HOP_RECEIPT = {
  task_id: "task-abc-123",
  motebit_id: "did:motebit:9d8b7a6c5f4e3d2c1b0a987654321010",
  status: "completed",
  signature: "9d8b7a6c5f4e3d2c1b0a987654321010aabbccddeeff",
  tools_used: ["web_search", "read_url"],
  duration_ms: 1234,
};

const MULTI_HOP_RECEIPT = {
  task_id: "task-outer-1",
  motebit_id: "did:motebit:outerouterouter000000000000000000",
  status: "completed",
  signature: "sig-outer-aaaaa-bbbbb",
  tools_used: ["delegate_to_agent"],
  duration_ms: 4500,
  delegation_receipts: [
    {
      task_id: "task-inner-1",
      motebit_id: "did:motebit:innerinnerinner1111111111111111111",
      status: "completed",
      signature: "sig-inner-1-cccc",
      tools_used: ["web_search"],
      duration_ms: 800,
    },
    {
      task_id: "task-inner-2",
      motebit_id: "did:motebit:innerinnerinner2222222222222222222",
      status: "completed",
      signature: "sig-inner-2-dddd",
      tools_used: ["read_url"],
      duration_ms: 1100,
      delegation_receipts: [
        {
          task_id: "task-grand-1",
          motebit_id: "did:motebit:grandchildgrandchild333333333333",
          status: "completed",
          signature: "sig-grand-1-eeee",
          tools_used: [],
          duration_ms: 200,
        },
      ],
    },
  ],
};

describe("summarizeDelegationReceipt", () => {
  describe("null / malformed inputs", () => {
    it("returns null for null", () => {
      expect(summarizeDelegationReceipt(null)).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(summarizeDelegationReceipt(undefined)).toBeNull();
    });

    it("returns null for non-object", () => {
      expect(summarizeDelegationReceipt("a string")).toBeNull();
      expect(summarizeDelegationReceipt(42)).toBeNull();
    });
  });

  describe("single-hop receipt", () => {
    let summary: ReceiptSummary;

    it("populates outer fields", () => {
      summary = summarizeDelegationReceipt(SINGLE_HOP_RECEIPT)!;
      expect(summary.outer.taskId).toBe("task-abc-123");
      expect(summary.outer.peerId).toBe("did:motebit:9d…");
      expect(summary.outer.status).toBe("completed");
      expect(summary.outer.toolsUsed).toEqual(["web_search", "read_url"]);
      expect(summary.outer.durationMs).toBe(1234);
    });

    it("truncates the signature prefix to 12 chars", () => {
      summary = summarizeDelegationReceipt(SINGLE_HOP_RECEIPT)!;
      expect(summary.outer.signaturePrefix).toBe("9d8b7a6c5f4e");
    });

    it("returns an empty chain when delegation_receipts is absent", () => {
      summary = summarizeDelegationReceipt(SINGLE_HOP_RECEIPT)!;
      expect(summary.chain).toEqual([]);
    });
  });

  describe("multi-hop receipt", () => {
    let summary: ReceiptSummary;

    it("flattens delegation_receipts depth-first", () => {
      summary = summarizeDelegationReceipt(MULTI_HOP_RECEIPT)!;
      // Order: inner-1, inner-2, grand-1 (depth-first)
      expect(summary.chain.length).toBe(3);
      expect(summary.chain[0]?.peerId).toBe("did:motebit:in…");
      expect(summary.chain[0]?.toolsUsed).toEqual(["web_search"]);
      expect(summary.chain[0]?.signaturePrefix).toBe("sig-inner-1-");
      expect(summary.chain[1]?.toolsUsed).toEqual(["read_url"]);
      expect(summary.chain[2]?.toolsUsed).toEqual([]);
      expect(summary.chain[2]?.signaturePrefix).toBe("sig-grand-1-");
    });

    it("retains the outer hop's data alongside the chain", () => {
      summary = summarizeDelegationReceipt(MULTI_HOP_RECEIPT)!;
      expect(summary.outer.taskId).toBe("task-outer-1");
      expect(summary.outer.toolsUsed).toEqual(["delegate_to_agent"]);
    });
  });

  describe("missing-field tolerance", () => {
    it("defaults status to 'returned' when absent", () => {
      const r = summarizeDelegationReceipt({ motebit_id: "x" });
      expect(r?.outer.status).toBe("returned");
    });

    it("returns null signaturePrefix when no signature", () => {
      const r = summarizeDelegationReceipt({ motebit_id: "x", task_id: "t1" });
      expect(r?.outer.signaturePrefix).toBeNull();
    });

    it("returns null durationMs when absent", () => {
      const r = summarizeDelegationReceipt({ motebit_id: "x" });
      expect(r?.outer.durationMs).toBeNull();
    });

    it("filters non-string entries from tools_used", () => {
      const r = summarizeDelegationReceipt({
        motebit_id: "x",
        tools_used: ["good", 42, null, "also-good"] as readonly unknown[] as string[],
      });
      expect(r?.outer.toolsUsed).toEqual(["good", "also-good"]);
    });

    it("skips non-object entries inside delegation_receipts", () => {
      const r = summarizeDelegationReceipt({
        motebit_id: "outer",
        delegation_receipts: [
          null,
          "not-an-object",
          { motebit_id: "valid", tools_used: ["only_one"] },
        ] as readonly unknown[],
      });
      expect(r?.chain.length).toBe(1);
      expect(r?.chain[0]?.toolsUsed).toEqual(["only_one"]);
    });
  });
});

describe("describeOutboundWait", () => {
  it("uses the truncated peer id when present", () => {
    expect(
      describeOutboundWait("did:motebit:9d8b7a6c5f4e3d2c1b0a987654321010", "fly.example.com"),
    ).toBe("Waiting for did:motebit:9d…");
  });

  it("falls back to the server name when peer id is empty", () => {
    expect(describeOutboundWait("", "research.fly.dev")).toBe("Waiting for research.fly.dev…");
  });

  it("falls back to a generic peer when neither is present", () => {
    expect(describeOutboundWait("", undefined)).toBe("Waiting for peer…");
    expect(describeOutboundWait("", "")).toBe("Waiting for peer…");
  });
});

describe("truncatePeerId", () => {
  it("returns the input unchanged when shorter than the cutoff", () => {
    expect(truncatePeerId("short")).toBe("short");
    expect(truncatePeerId("a".repeat(14))).toBe("a".repeat(14));
  });

  it("truncates and ellipsizes longer ids", () => {
    expect(truncatePeerId("did:motebit:abcdefghijklmnop")).toBe("did:motebit:ab…");
  });

  it("respects a custom head length", () => {
    expect(truncatePeerId("0123456789abcdef", 6)).toBe("012345…");
  });
});
