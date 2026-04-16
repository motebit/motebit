/**
 * `/invoke` and `/receipt` command handler tests.
 *
 * THE load-bearing test in this file: the affordance routing invariant.
 * `handleInvokeCommand` MUST call `runtime.invokeCapability` — never
 * `sendMessageStreaming`, `sendMessage`, or any AI-loop entry point.
 * `scripts/check-affordance-routing.ts` is the static gate; this is its
 * dynamic counterpart. Breaking either is a doctrine violation.
 *
 * The receipt command tests lock the archive round-trip (stash →
 * re-render) and the offline-verify pretty-print.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MotebitRuntime } from "@motebit/runtime";
import type { ExecutionReceipt } from "@motebit/sdk";
import { signExecutionReceipt, generateKeypair, bytesToHex } from "@motebit/encryption";

import { handleInvokeCommand, handleReceiptCommand } from "../commands/invoke.js";
import {
  archiveReceipt,
  clearReceiptArchive,
  getArchivedReceipt,
  renderReceipt,
} from "../receipt.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReceiptBody(): Omit<ExecutionReceipt, "signature" | "suite"> {
  return {
    task_id: "task-abc-001",
    motebit_id: "mote-xyz-999",
    device_id: "dev-qqq",
    submitted_at: 1700000000000,
    completed_at: 1700000010000,
    status: "completed",
    result: "Task completed successfully",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
  };
}

async function makeSignedReceipt(
  overrides?: Partial<ExecutionReceipt>,
): Promise<{ receipt: ExecutionReceipt; publicKey: Uint8Array }> {
  const kp = await generateKeypair();
  const body = { ...makeReceiptBody(), ...overrides, public_key: bytesToHex(kp.publicKey) };
  const signed = await signExecutionReceipt(body, kp.privateKey, kp.publicKey);
  return { receipt: signed, publicKey: kp.publicKey };
}

async function* chunks<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// `/invoke` — affordance routing invariant
// ---------------------------------------------------------------------------

describe("handleInvokeCommand — affordance routing", () => {
  beforeEach(() => clearReceiptArchive());

  it("calls runtime.invokeCapability and NEVER runtime.sendMessageStreaming", async () => {
    const invokeCapability = vi.fn(() =>
      chunks([{ type: "delegation_start" as const, server: "relay", tool: "invoke_capability" }]),
    );
    const sendMessageStreaming = vi.fn();
    const sendMessage = vi.fn();

    const runtime = {
      invokeCapability,
      sendMessageStreaming,
      sendMessage,
    } as unknown as MotebitRuntime;

    const out: string[] = [];
    await handleInvokeCommand("review_pr https://github.com/x/y/pull/1", {
      runtime,
      out: (line) => out.push(line),
    });

    // THE invariant: invokeCapability is the dispatch path.
    expect(invokeCapability).toHaveBeenCalledTimes(1);
    expect(invokeCapability).toHaveBeenCalledWith("review_pr", "https://github.com/x/y/pull/1");

    // AI-loop entry points MUST NOT have been called. This is what the
    // surface-determinism doctrine and `check-affordance-routing` gate
    // exist to prevent.
    expect(sendMessageStreaming).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("shows usage on missing args", async () => {
    const runtime = {
      invokeCapability: vi.fn(),
      sendMessageStreaming: vi.fn(),
    } as unknown as MotebitRuntime;

    const out: string[] = [];
    await handleInvokeCommand("", { runtime, out: (line) => out.push(line) });
    expect(runtime.invokeCapability).not.toHaveBeenCalled();
    expect(out.some((l) => l.includes("Usage: /invoke"))).toBe(true);
  });

  it("shows usage on capability with no prompt", async () => {
    const runtime = {
      invokeCapability: vi.fn(),
      sendMessageStreaming: vi.fn(),
    } as unknown as MotebitRuntime;

    const out: string[] = [];
    await handleInvokeCommand("review_pr", { runtime, out: (line) => out.push(line) });
    expect(runtime.invokeCapability).not.toHaveBeenCalled();
    expect(out.some((l) => l.includes("Usage: /invoke"))).toBe(true);
  });

  it("archives the full_receipt on delegation_complete", async () => {
    const { receipt } = await makeSignedReceipt();
    const invokeCapability = vi.fn(() =>
      chunks([
        { type: "delegation_start" as const, server: "relay", tool: "invoke_capability" },
        { type: "text" as const, text: "done" },
        {
          type: "delegation_complete" as const,
          server: "relay",
          tool: "invoke_capability",
          full_receipt: receipt,
        },
      ]),
    );
    const runtime = {
      invokeCapability,
      sendMessageStreaming: vi.fn(),
    } as unknown as MotebitRuntime;

    const out: string[] = [];
    await handleInvokeCommand("web_search hello", { runtime, out: (line) => out.push(line) });

    expect(getArchivedReceipt(receipt.task_id)).toEqual(receipt);
  });

  it("surfaces invoke_error honestly (no AI-loop fallthrough)", async () => {
    const invokeCapability = vi.fn(() =>
      chunks([
        {
          type: "invoke_error" as const,
          code: "insufficient_balance" as const,
          message: "balance too low",
        },
      ]),
    );
    const sendMessageStreaming = vi.fn();
    const runtime = {
      invokeCapability,
      sendMessageStreaming,
    } as unknown as MotebitRuntime;

    const out: string[] = [];
    await handleInvokeCommand("web_search test", { runtime, out: (line) => out.push(line) });

    // Error surfaced, AI loop never called. Honest degradation.
    expect(out.some((l) => l.includes("insufficient_balance"))).toBe(true);
    expect(sendMessageStreaming).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// `/receipt` — read-only re-render from session archive
// ---------------------------------------------------------------------------

describe("handleReceiptCommand", () => {
  beforeEach(() => clearReceiptArchive());

  it("reports missing receipt when archive is empty", async () => {
    const out: string[] = [];
    await handleReceiptCommand("unknown-task-id", { out: (line) => out.push(line) });
    expect(out.some((l) => l.includes("No archived receipt"))).toBe(true);
  });

  it("shows usage on empty args", async () => {
    const out: string[] = [];
    await handleReceiptCommand("", { out: (line) => out.push(line) });
    expect(out.some((l) => l.includes("Usage: /receipt"))).toBe(true);
  });

  it("re-renders an archived receipt with offline verify", async () => {
    const { receipt } = await makeSignedReceipt();
    archiveReceipt(receipt);

    const out: string[] = [];
    await handleReceiptCommand(receipt.task_id, { out: (line) => out.push(line) });

    // Rendered output carries both the receipt task_id (header) and the
    // successful-verify indicator. Glyph characters differ by terminal —
    // we assert on the stable label.
    const joined = out.join("\n");
    expect(joined).toContain(receipt.task_id.slice(0, 12));
    expect(joined).toContain("verified");
  });
});

// ---------------------------------------------------------------------------
// renderReceipt — offline verify + tampered-receipt detection
// ---------------------------------------------------------------------------

describe("renderReceipt", () => {
  it("reports chain verified for a valid single-hop receipt", async () => {
    const { receipt } = await makeSignedReceipt();
    const out: string[] = [];
    const result = await renderReceipt(receipt, (line) => out.push(line));
    expect(result.verified).toBe(true);
    expect(out.join("\n")).toContain("verified");
  });

  it("reports verification failed for a tampered receipt", async () => {
    const { receipt } = await makeSignedReceipt();
    const tampered: ExecutionReceipt = { ...receipt, result: "tampered result" };
    const out: string[] = [];
    const result = await renderReceipt(tampered, (line) => out.push(line));
    expect(result.verified).toBe(false);
    expect(out.join("\n")).toContain("verification failed");
  });

  it("walks nested delegation_receipts and renders each hop", async () => {
    const child = await makeSignedReceipt({ task_id: "child-001", motebit_id: "child-agent" });
    const parent = await makeSignedReceipt({
      task_id: "parent-001",
      delegation_receipts: [child.receipt],
    });
    const out: string[] = [];
    await renderReceipt(parent.receipt, (line) => out.push(line));
    const joined = out.join("\n");
    // Both parent and child task ids appear in the rendering.
    expect(joined).toContain(parent.receipt.task_id.slice(0, 12));
    expect(joined).toContain(child.receipt.task_id.slice(0, 12));
  });
});
