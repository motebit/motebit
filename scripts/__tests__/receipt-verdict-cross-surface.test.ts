/**
 * Cross-surface receipt verdict agreement.
 *
 * Every app surface that badges a receipt must reach the SAME verdict on the
 * SAME receipt + trust anchor. Before this test, mobile fed the receipt's own
 * embedded keys back in as the trust anchor and badged every self-consistent
 * receipt — including a forged self-keyed one — "verified locally · chain
 * intact", while web/desktop/spatial/CLI said "identity not anchored".
 *
 * Surfaces exercised, each through the function its badge actually renders:
 *   web + desktop — render-engine `verifyReceiptVerdict` + `RECEIPT_VERDICT_LABELS`
 *                   (what `buildReceiptArtifact` sets as class + label)
 *   spatial       — `verifyReceiptState` (the satellite orb's state)
 *   mobile        — `deriveReceiptBadge` (the RN card's badge)
 *   CLI           — `renderReceipt` (the printed verify line; the CLI has no
 *                   task-failed rungs, so it is compared on the chain axis)
 *
 * Vectors: every receipt in examples/python-receipt-verifier/fixtures and every
 * `kind: "receipt"` case in spec/conformance/verification-verdict/corpus.json,
 * each run unanchored, anchored to its own key (bound), anchored to a wrong key
 * (forged-as-victim), and tampered; plus synthetic chains (tampered child,
 * partially-anchored chain, forged self-keyed receipt, task-failed).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExecutionReceipt } from "../../packages/sdk/src/index.js";
import {
  generateKeypair,
  signExecutionReceipt,
  verifyReceiptChain,
} from "../../packages/encryption/src/index.js";
import {
  RECEIPT_VERDICT_LABELS,
  receiptVerdictFor,
  verifyReceiptVerdict,
  type ReceiptVerdict,
} from "../../packages/render-engine/src/receipt-verdict.js";
import { verifyReceiptState } from "../../apps/spatial/src/receipt-satellites.js";
import { deriveReceiptBadge } from "../../apps/mobile/src/receipt-badge.js";
import { renderReceipt } from "../../apps/cli/src/receipt.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");

type Anchor = Map<string, Uint8Array>;
interface Vector {
  name: string;
  receipt: ExecutionReceipt;
  anchor?: Anchor;
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));

function loadSharedReceipts(): Array<{ name: string; receipt: ExecutionReceipt }> {
  const out: Array<{ name: string; receipt: ExecutionReceipt }> = [];
  const dir = join(repoRoot, "examples/python-receipt-verifier/fixtures");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    out.push({ name: `python/${f}`, receipt: JSON.parse(readFileSync(join(dir, f), "utf8")) });
  }
  const corpus = JSON.parse(
    readFileSync(join(repoRoot, "spec/conformance/verification-verdict/corpus.json"), "utf8"),
  ) as { cases: Array<{ name: string; kind: string; input: { receipt?: ExecutionReceipt } }> };
  for (const c of corpus.cases) {
    if (c.kind === "receipt" && c.input.receipt) {
      out.push({ name: `corpus/${c.name}`, receipt: c.input.receipt });
    }
  }
  return out;
}

async function synthetic(
  overrides: Partial<ExecutionReceipt>,
  kp?: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<{ receipt: ExecutionReceipt; publicKey: Uint8Array }> {
  const keys = kp ?? (await generateKeypair());
  const body = {
    task_id: `syn-${Math.random().toString(36).slice(2)}`,
    motebit_id: "victim-mote",
    device_id: "d",
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
    keys.privateKey,
    keys.publicKey,
  )) as unknown as ExecutionReceipt;
  return { receipt, publicKey: keys.publicKey };
}

async function buildVectors(): Promise<Vector[]> {
  const vectors: Vector[] = [];
  const wrong = await generateKeypair();
  for (const { name, receipt } of loadSharedReceipts()) {
    vectors.push({ name: `${name} · unanchored`, receipt });
    if (receipt.public_key) {
      vectors.push({
        name: `${name} · bound`,
        receipt,
        anchor: new Map([[receipt.motebit_id, hexBytes(receipt.public_key)]]),
      });
    }
    vectors.push({
      name: `${name} · forged-as-victim (anchor pins a different key)`,
      receipt,
      anchor: new Map([[receipt.motebit_id, wrong.publicKey]]),
    });
    vectors.push({ name: `${name} · tampered`, receipt: { ...receipt, result: "tampered" } });
  }

  const forged = await synthetic({ result: "forged" });
  vectors.push({ name: "synthetic · forged self-keyed", receipt: forged.receipt });

  const child = await synthetic({ motebit_id: "child-mote" });
  const parentKp = await generateKeypair();
  const parentOk = await synthetic({ delegation_receipts: [child.receipt] }, parentKp);
  vectors.push({
    name: "synthetic · chain, root anchored only",
    receipt: parentOk.receipt,
    anchor: new Map([["victim-mote", parentKp.publicKey]]),
  });
  vectors.push({
    name: "synthetic · chain, fully anchored",
    receipt: parentOk.receipt,
    anchor: new Map([
      ["victim-mote", parentKp.publicKey],
      ["child-mote", child.publicKey],
    ]),
  });
  const parentBadChild = await synthetic(
    { delegation_receipts: [{ ...child.receipt, result: "tampered" }] },
    parentKp,
  );
  vectors.push({ name: "synthetic · tampered child", receipt: parentBadChild.receipt });
  const taskFailed = await synthetic({ status: "failed" });
  vectors.push({ name: "synthetic · task failed", receipt: taskFailed.receipt });
  vectors.push({
    name: "synthetic · task failed, bound",
    receipt: taskFailed.receipt,
    anchor: new Map([["victim-mote", taskFailed.publicKey]]),
  });
  return vectors;
}

const CLI_LABEL_TO_CHAIN: Array<
  [string, Exclude<ReceiptVerdict, "task-failed" | "task-failed-unanchored">]
> = [
  ["verified locally · chain intact", "verified"],
  ["signature verified · identity not anchored", "integrity-only"],
  ["verification failed", "failed"],
];

async function cliChainVerdict(receipt: ExecutionReceipt, anchor?: Anchor): Promise<string> {
  const lines: string[] = [];
  await renderReceipt(receipt, (l) => lines.push(l), anchor);
  // Strip ANSI so the label match is color-independent.
  // eslint-disable-next-line no-control-regex
  const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  for (const [label, verdict] of CLI_LABEL_TO_CHAIN) if (text.includes(label)) return verdict;
  return `unrecognised CLI output: ${text}`;
}

describe("receipt verdict — every surface agrees on the shared vectors", () => {
  it("web/desktop, spatial, mobile, and CLI reach the same verdict on every vector", async () => {
    const vectors = await buildVectors();
    expect(vectors.length).toBeGreaterThan(40);
    const disagreements: string[] = [];
    const seen = new Set<ReceiptVerdict>();
    for (const v of vectors) {
      const dom = await verifyReceiptVerdict(v.receipt, v.anchor);
      seen.add(dom);
      const spatial = await verifyReceiptState(v.receipt, v.anchor);
      const mobile = await deriveReceiptBadge(v.receipt, v.anchor);

      if (spatial !== dom) disagreements.push(`${v.name}: spatial=${spatial} web/desktop=${dom}`);
      if (mobile.verdict !== dom)
        disagreements.push(`${v.name}: mobile=${mobile.verdict} web/desktop=${dom}`);
      if (mobile.label !== RECEIPT_VERDICT_LABELS[dom])
        disagreements.push(
          `${v.name}: mobile label "${mobile.label}" ≠ "${RECEIPT_VERDICT_LABELS[dom]}"`,
        );

      // CLI: chain axis (it has no task-failed rungs).
      const tree = await verifyReceiptChain(v.receipt, v.anchor ?? new Map());
      const chain = receiptVerdictFor({ status: "completed" }, tree);
      const cli = await cliChainVerdict(v.receipt, v.anchor);
      if (cli !== chain) disagreements.push(`${v.name}: cli=${cli} chain=${chain}`);

      // Honesty floor: never an identity claim ("verified" / bound task-failed)
      // without an anchor.
      const bound = (x: string): boolean => x === "verified" || x === "task-failed";
      if (!v.anchor && (bound(dom) || bound(mobile.verdict)))
        disagreements.push(`${v.name}: claimed identity binding with no trusted anchor`);
    }
    expect(disagreements).toEqual([]);
    // Coverage of the ladder: every rung is exercised by some vector.
    expect([...seen].sort()).toEqual([
      "failed",
      "integrity-only",
      "task-failed",
      "task-failed-unanchored",
      "verified",
    ]);
  });
});
