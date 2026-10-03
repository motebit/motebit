/**
 * L8 — mobile's receipt badge must never claim identity binding from the
 * receipt's own embedded keys.
 *
 * Mobile used to verify against `collectKnownKeys(receipt)` (the receipt's
 * self-declared keys fed back in as the trust anchor) and badge any
 * self-consistent receipt "verified locally · chain intact" — including a
 * forged one signed by an attacker's key claiming someone else's motebit_id.
 * Real signatures, real `verifyReceiptChain` — nothing stubbed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExecutionReceipt } from "@motebit/sdk";
import { generateKeypair, signExecutionReceipt } from "@motebit/encryption";
import { RECEIPT_VERDICT_LABELS } from "@motebit/render-engine";
import { deriveReceiptBadge } from "../receipt-badge";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

const VICTIM_ID = "019dc3f3-6027-73ca-b877-0cf9141c0b72";

async function signed(
  overrides: Partial<ExecutionReceipt> = {},
  keys?: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<{ receipt: ExecutionReceipt; publicKey: Uint8Array }> {
  const kp = keys ?? (await generateKeypair());
  const body = {
    task_id: "task-" + Math.random().toString(36).slice(2),
    motebit_id: VICTIM_ID,
    device_id: "device-1",
    submitted_at: 1_700_000_000_000,
    completed_at: 1_700_000_001_000,
    status: "completed",
    result: "ok",
    tools_used: [] as string[],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    ...overrides,
  };
  const receipt = (await signExecutionReceipt(
    body as never,
    kp.privateKey,
    kp.publicKey,
  )) as unknown as ExecutionReceipt;
  return { receipt, publicKey: kp.publicKey };
}

describe("mobile receipt badge — verdict ladder (L8)", () => {
  it("(i) valid receipt, embedded key only → integrity-only, never 'verified'", async () => {
    const { receipt } = await signed();
    const badge = await deriveReceiptBadge(receipt);
    expect(badge.verdict).toBe("integrity-only");
    expect(badge.label).toBe("signature verified · identity not anchored");
    expect(badge.label).not.toBe(RECEIPT_VERDICT_LABELS.verified);
  });

  it("(ii) forged self-keyed receipt claiming another motebit_id → NOT 'verified'", async () => {
    // The victim's real key is pinned; the attacker signs with their own key
    // and embeds it, claiming the victim's motebit_id.
    const victim = await generateKeypair();
    const { receipt: forged } = await signed({ result: "forged" });
    const anchored = await deriveReceiptBadge(forged, new Map([[VICTIM_ID, victim.publicKey]]));
    expect(anchored.verdict).toBe("failed");
    // Without an anchor the forgery is at best integrity-only — never bound.
    const unanchored = await deriveReceiptBadge(forged);
    expect(unanchored.verdict).not.toBe("verified");
    expect(unanchored.label).not.toContain("chain intact");
  });

  it("(iii) signer bound via an independent trusted anchor → verified", async () => {
    const { receipt, publicKey } = await signed();
    const badge = await deriveReceiptBadge(receipt, new Map([[VICTIM_ID, publicKey]]));
    expect(badge.verdict).toBe("verified");
    expect(badge.label).toBe("verified locally · chain intact");
  });

  it("tampered body → failed", async () => {
    const { receipt, publicKey } = await signed();
    const tampered = { ...receipt, result: "tampered" };
    expect((await deriveReceiptBadge(tampered)).verdict).toBe("failed");
    expect((await deriveReceiptBadge(tampered, new Map([[VICTIM_ID, publicKey]]))).verdict).toBe(
      "failed",
    );
  });

  it("tampered delegation child fails the whole chain", async () => {
    const { receipt: child } = await signed({ motebit_id: "child-mote" });
    const parentKeys = await generateKeypair();
    const { receipt: parent } = await signed(
      { delegation_receipts: [{ ...child, result: "tampered" }] },
      parentKeys,
    );
    expect((await deriveReceiptBadge(parent)).verdict).toBe("failed");
  });

  it("partially anchored chain is integrity-only, not verified", async () => {
    const { receipt: child } = await signed({ motebit_id: "child-mote" });
    const parentKeys = await generateKeypair();
    const { receipt: parent } = await signed({ delegation_receipts: [child] }, parentKeys);
    const badge = await deriveReceiptBadge(parent, new Map([[VICTIM_ID, parentKeys.publicKey]]));
    expect(badge.verdict).toBe("integrity-only");
  });

  it("status=failed with intact signatures → task-failed", async () => {
    const { receipt } = await signed({ status: "failed" });
    expect((await deriveReceiptBadge(receipt)).verdict).toBe("task-failed");
  });

  it("shared python-verifier fixtures (all self-keyed) are integrity-only without an anchor, verified with one", async () => {
    const dir = join(repoRoot, "examples/python-receipt-verifier/fixtures");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as ExecutionReceipt;
      const plain = await deriveReceiptBadge(r);
      expect(plain.verdict, f).not.toBe("verified");
      if (r.status !== "failed") expect(plain.verdict, f).toBe("integrity-only");
      const anchor = new Map([[r.motebit_id, Uint8Array.from(Buffer.from(r.public_key!, "hex"))]]);
      const bound = await deriveReceiptBadge(r, anchor);
      expect(bound.verdict, f).toBe(r.status === "failed" ? "task-failed" : "verified");
    }
  });

  it("ReceiptArtifact.tsx routes through the shared ladder and never self-anchors", () => {
    const src = readFileSync(join(here, "../components/ReceiptArtifact.tsx"), "utf8");
    expect(src).not.toMatch(/collectKnownKeys/);
    expect(src).not.toMatch(/verifyReceiptChain/);
    expect(src).toMatch(/deriveReceiptBadge\(/);
  });
});
