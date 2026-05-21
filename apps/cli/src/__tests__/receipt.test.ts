/**
 * renderReceipt prints an offline-verified receipt tree and a single status
 * line. The status must distinguish signature integrity from identity binding:
 * a receipt verified against its own embedded key is integrity-only, never
 * "verified" in the identity sense. verifyReceiptChain is stubbed so each
 * binding outcome is driven deterministically.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReceipt } from "@motebit/sdk";

const verifyReceiptChainMock = vi.fn();
vi.mock("@motebit/encryption", () => ({
  verifyReceiptChain: (...args: unknown[]) => verifyReceiptChainMock(...args),
}));

const { renderReceipt } = await import("../receipt.js");

function makeReceipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    spec: "motebit/execution-ledger@1.0",
    motebit_id: "mb_worker_abc",
    task_id: "task_xyz",
    status: "completed",
    tools_used: ["research"],
    public_key: "",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig_0x0123456789abcdef",
    ...overrides,
  } as ExecutionReceipt;
}

async function capture(tree: unknown, anchor?: Map<string, Uint8Array>): Promise<string> {
  verifyReceiptChainMock.mockResolvedValue(tree);
  const lines: string[] = [];
  await renderReceipt(makeReceipt(), (l) => lines.push(l), anchor);
  return lines.join("\n");
}

afterEach(() => verifyReceiptChainMock.mockReset());

describe("renderReceipt — identity binding status", () => {
  it("bound (external key) → 'verified locally · chain intact'", async () => {
    const out = await capture({ verified: true, keySource: "external", delegations: [] });
    expect(out).toContain("verified locally · chain intact");
    expect(out).not.toContain("identity not anchored");
  });

  it("integrity-only (embedded key, no anchor) → 'signature verified · identity not anchored'", async () => {
    const out = await capture({ verified: true, keySource: "embedded", delegations: [] });
    expect(out).toContain("signature verified · identity not anchored");
    expect(out).not.toContain("chain intact");
  });

  it("missing keySource is treated as integrity-only", async () => {
    const out = await capture({ verified: true, delegations: [] });
    expect(out).toContain("signature verified · identity not anchored");
  });

  it("a delegation verified only by embedded key downgrades the whole chain", async () => {
    const out = await capture({
      verified: true,
      keySource: "external",
      delegations: [{ verified: true, keySource: "embedded", delegations: [] }],
    });
    expect(out).toContain("signature verified · identity not anchored");
    expect(out).not.toContain("chain intact");
  });

  it("unverified → 'verification failed'", async () => {
    const out = await capture({ verified: false, error: "bad signature", delegations: [] });
    expect(out).toContain("verification failed");
  });
});
