/**
 * Receipt verdict honesty harness — REAL crypto, nothing stubbed.
 *
 * Table-driven over status × signer key × chain nesting, through the real
 * `verifyReceiptChain` and the shared ladder every surface renders (web,
 * desktop, spatial, mobile). The invariant:
 *
 *   The word "verified" as an IDENTITY claim appears in the badge ONLY when
 *   every receipt in the chain verified against an externally supplied key
 *   bound to its claimed signer. Status never outranks binding.
 *
 * ("signature verified" is a byte-integrity claim, not an identity claim, and
 * is allowed on an intact-but-unanchored chain.)
 *
 * The attack this pins: an attacker self-signs a receipt claiming a victim's
 * `motebit_id` with `status: "failed"`. With no trusted anchor (mobile passes
 * none) the badge must not read "verified · …".
 */
import { describe, expect, it } from "vitest";
import type { ExecutionReceipt } from "@motebit/sdk";
import { generateKeypair, signExecutionReceipt } from "@motebit/encryption";
import { RECEIPT_VERDICT_LABELS, verifyReceiptVerdict } from "../receipt-verdict.js";

type Keys = { publicKey: Uint8Array; privateKey: Uint8Array };
type Status = "completed" | "failed" | "denied";
/** How one receipt's signer key relates to the caller's trust anchor. */
type KeyCase = "bound" | "self-keyed" | "foreign" | "tampered" | "unsigned" | "missing-key";
type Nesting = "top-level" | "bound-parent/case-child" | "case-parent/bound-child";

const STATUSES: readonly Status[] = ["completed", "failed", "denied"];
const KEY_CASES: readonly KeyCase[] = [
  "bound",
  "self-keyed",
  "foreign",
  "tampered",
  "unsigned",
  "missing-key",
];
const NESTINGS: readonly Nesting[] = [
  "top-level",
  "bound-parent/case-child",
  "case-parent/bound-child",
];

/** Signature intact under the key the verifier will resolve. */
const SIG_INTACT: Record<KeyCase, boolean> = {
  bound: true,
  "self-keyed": true,
  foreign: false,
  tampered: false,
  unsigned: false,
  "missing-key": false,
};

async function sign(
  kp: Keys,
  motebitId: string,
  status: Status,
  delegations?: ExecutionReceipt[],
): Promise<ExecutionReceipt> {
  const body = {
    task_id: `t-${motebitId}-${Math.random().toString(36).slice(2)}`,
    motebit_id: motebitId,
    device_id: "d",
    submitted_at: 1_700_000_000_000,
    completed_at: 1_700_000_001_000,
    status,
    result: "ok",
    tools_used: [] as string[],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    ...(delegations ? { delegation_receipts: delegations } : {}),
  };
  return (await signExecutionReceipt(
    body as never,
    kp.privateKey,
    kp.publicKey,
  )) as unknown as ExecutionReceipt;
}

/**
 * Build one receipt in the given key case. Returns the receipt and the anchor
 * entries the caller's trusted source would hold for it.
 */
async function node(
  keyCase: KeyCase,
  motebitId: string,
  status: Status,
  delegations?: ExecutionReceipt[],
): Promise<{ receipt: ExecutionReceipt; anchor: Array<[string, Uint8Array]> }> {
  const kp = await generateKeypair();
  const receipt = await sign(kp, motebitId, status, delegations);
  switch (keyCase) {
    case "bound":
      return { receipt, anchor: [[motebitId, kp.publicKey]] };
    case "self-keyed":
      // Attacker's own key, embedded; the anchor knows nothing of this id.
      return { receipt, anchor: [] };
    case "foreign": {
      // The anchor pins the real owner's key; the receipt was signed by another.
      const owner = await generateKeypair();
      return { receipt, anchor: [[motebitId, owner.publicKey]] };
    }
    case "tampered":
      return { receipt: { ...receipt, result: "tampered" }, anchor: [] };
    case "unsigned": {
      const { signature: _sig, ...rest } = receipt as ExecutionReceipt & { signature?: string };
      return { receipt: rest as ExecutionReceipt, anchor: [] };
    }
    case "missing-key": {
      const { public_key: _pk, ...rest } = receipt;
      return { receipt: rest as ExecutionReceipt, anchor: [] };
    }
  }
}

interface Row {
  name: string;
  receipt: ExecutionReceipt;
  anchor: Map<string, Uint8Array>;
  status: Status;
  /** Every receipt in the chain is `bound`. */
  allBound: boolean;
  /** Every receipt's signature checks under the resolved key. */
  allIntact: boolean;
}

async function buildRow(status: Status, keyCase: KeyCase, nesting: Nesting): Promise<Row> {
  const name = `status=${status} key=${keyCase} nesting=${nesting}`;
  if (nesting === "top-level") {
    const n = await node(keyCase, "victim-mote", status);
    return {
      name,
      status,
      receipt: n.receipt,
      anchor: new Map(n.anchor),
      allBound: keyCase === "bound",
      allIntact: SIG_INTACT[keyCase],
    };
  }
  if (nesting === "bound-parent/case-child") {
    const child = await node(keyCase, "child-mote", "completed");
    const parent = await node("bound", "victim-mote", status, [child.receipt]);
    return {
      name,
      status,
      receipt: parent.receipt,
      anchor: new Map([...parent.anchor, ...child.anchor]),
      allBound: keyCase === "bound",
      allIntact: SIG_INTACT[keyCase],
    };
  }
  const child = await node("bound", "child-mote", "completed");
  const parent = await node(keyCase, "victim-mote", status, [child.receipt]);
  return {
    name,
    status,
    receipt: parent.receipt,
    anchor: new Map([...parent.anchor, ...child.anchor]),
    allBound: keyCase === "bound",
    allIntact: SIG_INTACT[keyCase],
  };
}

/** "verified" as an identity claim — "signature verified" is integrity only. */
function claimsIdentity(label: string): boolean {
  return /\bverified\b/.test(label.replace(/signature verified/g, ""));
}

describe("receipt verdict honesty — real crypto over status × key × nesting", () => {
  it("never claims identity without every signer bound; status never outranks binding", async () => {
    const violations: string[] = [];
    let rows = 0;
    for (const status of STATUSES) {
      for (const keyCase of KEY_CASES) {
        for (const nesting of NESTINGS) {
          const row = await buildRow(status, keyCase, nesting);
          rows++;
          const verdict = await verifyReceiptVerdict(row.receipt, row.anchor);
          const label = RECEIPT_VERDICT_LABELS[verdict];
          const where = `${row.name} → ${verdict} "${label}"`;

          // 1. The invariant.
          if (claimsIdentity(label) && !row.allBound)
            violations.push(`${where}: identity claimed on an unbound chain`);

          // 2. Any broken signature anywhere is the failed rung, whatever the status.
          if (!row.allIntact && verdict !== "failed")
            violations.push(`${where}: broken signature not fail-closed`);

          if (row.allIntact) {
            // 3. Fully bound ⇒ the identity claim is earned and shown.
            if (row.allBound && !claimsIdentity(label))
              violations.push(`${where}: bound chain under-reported`);
            // 4. Unbound but intact ⇒ honestly says the identity is not anchored.
            if (!row.allBound && !label.includes("identity not anchored"))
              violations.push(`${where}: unbound chain not named as unanchored`);
            // 5. The task outcome is still reported, never hidden by the binding.
            if (row.status === "failed" && !label.includes("completed: failed"))
              violations.push(`${where}: task failure hidden`);
            if (row.status !== "failed" && label.includes("completed: failed"))
              violations.push(`${where}: task failure invented`);
          }
        }
      }
    }
    expect(rows).toBe(STATUSES.length * KEY_CASES.length * NESTINGS.length);
    expect(violations).toEqual([]);
  });

  it("the named attack: self-signed failed receipt claiming a victim's id, no anchor", async () => {
    const attacker = await generateKeypair();
    const forged = await sign(attacker, "019dc3f3-6027-73ca-b877-0cf9141c0b72", "failed");
    const verdict = await verifyReceiptVerdict(forged);
    expect(claimsIdentity(RECEIPT_VERDICT_LABELS[verdict])).toBe(false);
    expect(RECEIPT_VERDICT_LABELS[verdict]).toContain("identity not anchored");
  });

  it("no rung's label claims identity except the fully-bound rungs", () => {
    for (const [rung, label] of Object.entries(RECEIPT_VERDICT_LABELS)) {
      const bound = rung === "verified" || rung === "task-failed";
      expect(claimsIdentity(label), `${rung}: "${label}"`).toBe(bound);
    }
  });
});
