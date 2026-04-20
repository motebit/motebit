/**
 * Pure-function coverage for receipt-summary.ts. Zero DOM, zero Three.js —
 * the helpers that every receipt renderer uses to derive display-layer math
 * from an ExecutionReceipt. Kept separate from receipt-artifact.test.ts so
 * this file can run in the default node environment.
 */
import { describe, it, expect } from "vitest";
import type { ExecutionReceipt } from "@motebit/sdk";
import {
  CAPABILITY_PRICES_USD,
  collectKnownKeys,
  displayName,
  formatUsd,
  hexToBytes,
  priceFor,
  receiptSummary,
  shortHash,
} from "../receipt-summary.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeReceipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    spec: "motebit/execution-ledger@1.0",
    motebit_id: "mb_worker",
    task_id: "task_abcdef1234567890",
    relay_task_id: "relay_task_xyz",
    status: "completed",
    started_at: 1_700_000_000_000,
    completed_at: 1_700_000_005_000,
    tools_used: [],
    public_key: "",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "",
    ...overrides,
  } as ExecutionReceipt;
}

// ── formatUsd ─────────────────────────────────────────────────────────

describe("formatUsd", () => {
  it("uses 2-decimal precision for amounts >= 0.01", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.25)).toBe("$0.25");
    expect(formatUsd(1.0)).toBe("$1.00");
    expect(formatUsd(100)).toBe("$100.00");
  });

  it("uses 3-decimal precision for sub-cent amounts", () => {
    expect(formatUsd(0.005)).toBe("$0.005");
    expect(formatUsd(0.003)).toBe("$0.003");
    expect(formatUsd(0.002)).toBe("$0.002");
  });

  it("handles zero", () => {
    expect(formatUsd(0)).toBe("$0.000");
  });

  it("handles threshold boundary at 0.01", () => {
    expect(formatUsd(0.0099)).toBe("$0.010"); // 3-decimal path
    expect(formatUsd(0.01)).toBe("$0.01"); // 2-decimal path
  });
});

// ── priceFor ──────────────────────────────────────────────────────────

describe("priceFor", () => {
  it("returns the first known capability's formatted price", () => {
    expect(priceFor(makeReceipt({ tools_used: ["review_pr"] }))).toBe("$0.01");
    expect(priceFor(makeReceipt({ tools_used: ["research"] }))).toBe("$0.25");
    expect(priceFor(makeReceipt({ tools_used: ["read_url"] }))).toBe("$0.003");
  });

  it("returns '—' when no tools were used", () => {
    expect(priceFor(makeReceipt({ tools_used: [] }))).toBe("—");
  });

  it("returns '—' when no tools match the known price table", () => {
    expect(priceFor(makeReceipt({ tools_used: ["unknown_tool"] }))).toBe("—");
  });

  it("picks the first known price even if an unknown tool comes first", () => {
    expect(priceFor(makeReceipt({ tools_used: ["unknown", "research"] }))).toBe("$0.25");
  });
});

describe("CAPABILITY_PRICES_USD", () => {
  it("exports the canonical per-capability rate table", () => {
    // Guard against accidental silent edits to the pricing table — an
    // explicit snapshot of current shipping atom/molecule prices.
    expect(CAPABILITY_PRICES_USD).toMatchObject({
      review_pr: 0.01,
      research: 0.25,
      read_url: 0.003,
      web_search: 0.005,
      summarize: 0.002,
      connection_search: 0.03,
    });
  });
});

// ── displayName ───────────────────────────────────────────────────────

describe("displayName", () => {
  it("returns the first capability with underscores dashed", () => {
    expect(displayName(makeReceipt({ tools_used: ["web_search"] }))).toBe("web-search");
    expect(displayName(makeReceipt({ tools_used: ["read_url", "summarize"] }))).toBe("read-url");
  });

  it("falls back to motebit_id prefix when no tools were used", () => {
    expect(displayName(makeReceipt({ motebit_id: "mb_longidentifier", tools_used: [] }))).toBe(
      "mb_longide",
    );
  });
});

// ── hexToBytes ────────────────────────────────────────────────────────

describe("hexToBytes", () => {
  it("parses a plain hex string", () => {
    const bytes = hexToBytes("deadbeef");
    expect(Array.from(bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("strips the 0x prefix", () => {
    const bytes = hexToBytes("0xcafe");
    expect(Array.from(bytes)).toEqual([0xca, 0xfe]);
  });

  it("trims trailing whitespace (leading 0x only strips when at absolute start)", () => {
    // `.replace(/^0x/, "").trim()` — strip first, then trim. A leading-
    // whitespace "0x" prefix is *not* stripped but the whitespace is.
    const bytes = hexToBytes("  cafe  ");
    expect(Array.from(bytes)).toEqual([0xca, 0xfe]);
  });

  it("throws on odd-length hex", () => {
    expect(() => hexToBytes("abc")).toThrow("invalid hex");
  });

  it("returns empty array for empty string", () => {
    expect(hexToBytes("").length).toBe(0);
  });
});

// ── shortHash ─────────────────────────────────────────────────────────

describe("shortHash", () => {
  it("truncates with ellipsis when longer than n", () => {
    expect(shortHash("abcdef1234", 4)).toBe("abcd…");
  });

  it("returns the whole string when shorter than or equal to n", () => {
    expect(shortHash("abcd", 4)).toBe("abcd");
    expect(shortHash("ab", 4)).toBe("ab");
  });

  it("strips 0x prefix before counting length", () => {
    expect(shortHash("0xabcdef", 4)).toBe("abcd…");
  });

  it("defaults to n=8", () => {
    expect(shortHash("abcdefghijkl")).toBe("abcdefgh…");
  });
});

// ── collectKnownKeys ──────────────────────────────────────────────────

describe("collectKnownKeys", () => {
  it("collects a single receipt's public_key as bytes", () => {
    const receipt = makeReceipt({
      motebit_id: "mb_root",
      public_key: "deadbeef",
    });
    const keys = collectKnownKeys(receipt);
    expect(keys.size).toBe(1);
    expect(Array.from(keys.get("mb_root") ?? [])).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("walks nested delegation_receipts recursively", () => {
    const leaf = makeReceipt({
      motebit_id: "mb_leaf",
      public_key: "cafe",
    });
    const middle = makeReceipt({
      motebit_id: "mb_middle",
      public_key: "babe",
      delegation_receipts: [leaf],
    });
    const root = makeReceipt({
      motebit_id: "mb_root",
      public_key: "face",
      delegation_receipts: [middle],
    });
    const keys = collectKnownKeys(root);
    expect(keys.size).toBe(3);
    expect(keys.has("mb_root")).toBe(true);
    expect(keys.has("mb_middle")).toBe(true);
    expect(keys.has("mb_leaf")).toBe(true);
  });

  it("skips receipts with empty or missing public_key", () => {
    const receipt = makeReceipt({ motebit_id: "mb_anon", public_key: "" });
    expect(collectKnownKeys(receipt).size).toBe(0);
  });

  it("swallows malformed public_key entries (fail-closed: verify catches later)", () => {
    const receipt = makeReceipt({
      motebit_id: "mb_bad",
      public_key: "not-hex",
    });
    expect(collectKnownKeys(receipt).size).toBe(0);
  });
});

// ── receiptSummary ────────────────────────────────────────────────────

describe("receiptSummary", () => {
  it("produces every derived field from a minimal receipt", () => {
    const receipt = makeReceipt({
      motebit_id: "mb_workerid",
      task_id: "task_abcdef1234567890",
      tools_used: ["research"],
      signature: "sig0xdeadbeef1234",
      suite: "motebit-jcs-ed25519-b64-v1",
      status: "completed",
    });
    const summary = receiptSummary(receipt);
    expect(summary.rootName).toBe("research");
    expect(summary.rootPrice).toBe("$0.25");
    expect(summary.chainDepth).toBe(0);
    expect(summary.toolCount).toBe(1);
    expect(summary.signer).toBe("mb_workerid");
    expect(summary.taskIdShort).toBe("task_abcdef1…");
    expect(summary.signatureShort).toBe("sig0xdeadbeef123…");
    expect(summary.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(summary.status).toBe("completed");
  });

  it("reports chainDepth from delegation_receipts length", () => {
    const root = makeReceipt({
      delegation_receipts: [
        makeReceipt({ motebit_id: "mb_a" }),
        makeReceipt({ motebit_id: "mb_b" }),
        makeReceipt({ motebit_id: "mb_c" }),
      ],
    });
    expect(receiptSummary(root).chainDepth).toBe(3);
  });

  it("falls back to '—' for suite when missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receipt = makeReceipt({ suite: undefined as any });
    expect(receiptSummary(receipt).suite).toBe("—");
  });
});
