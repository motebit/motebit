/**
 * verifyReceiptDocument never throws on bad input — including an identity file
 * whose `succession` is not an array of records.
 *
 * The binding path reads `identity.succession` through @motebit/crypto's
 * `verifyKeyBindingAtTime`. A `succession` that is a string, an object, or an
 * array holding a non-object made that primitive throw (`chain.some is not a
 * function`, or a property read on `null`), and the throw escaped
 * verifyReceiptDocument, breaking its documented contract ("never throws on bad
 * input or a crypto failure"). A malformed chain must read as UNBOUND
 * (fail-closed), never as an exception and never as a bound key.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  identityLogLeaf,
  deriveSovereignMotebitId,
  type KeyPair,
  type MotebitIdentityFile,
} from "@motebit/crypto";
import type { ExecutionReceipt } from "@motebit/protocol";

import { verifyReceiptDocument, type ReceiptAnchorOptions } from "../receipt-document.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const T1 = Date.parse("2026-02-01T00:00:00Z");

/** Every malformed `succession` shape: not an array, or an array of non-records. */
const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
  ["a string", "not-an-array"],
  ["an object", {}],
  ["an array-like object", { length: 1, 0: {} }],
  ["a number", 7],
  ["true", true],
  ["[null]", [null]],
  ["[1]", [1]],
  ['["x"]', ["x"]],
  ["[[]]", [[]]],
];

function identityWith(motebitId: string, currentKeyHex: string, succession: unknown) {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(T0).toISOString(),
    owner_id: "owner",
    identity: { algorithm: "Ed25519", public_key: currentKeyHex },
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "0",
      require_approval_above: "0",
      deny_above: "0",
      operator_mode: false,
    },
    privacy: { default_sensitivity: "none", retention_days: {}, fail_closed: true },
    memory: { half_life_days: 30, confidence_threshold: 0.5, per_turn_limit: 5 },
    devices: [],
    succession,
  } as unknown as MotebitIdentityFile;
}

async function receiptBy(kp: KeyPair, motebitId: string, completedAt: number) {
  const unsigned = {
    task_id: `t-${completedAt}`,
    motebit_id: motebitId,
    device_id: "device-1",
    submitted_at: completedAt - 10,
    completed_at: completedAt,
    status: "completed",
    result: "ok",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "0".repeat(64),
    result_hash: "1".repeat(64),
    public_key: bytesToHex(kp.publicKey),
  } as unknown as Parameters<typeof signExecutionReceipt>[0];
  return (await signExecutionReceipt(unsigned, kp.privateKey)) as ExecutionReceipt;
}

async function onchainAnchor(motebitId: string, keyHex: string): Promise<ReceiptAnchorOptions> {
  const root = await identityLogLeaf(motebitId, keyHex);
  const fetch = (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: [
          {
            signature: "anchor-tx",
            slot: 1,
            err: null,
            memo: `motebit:anchor:v1:${root}:1`,
            blockTime: null,
          },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof globalThis.fetch;
  return {
    proof: { index: 0, siblings: [], layerSizes: [1], anchoredRoot: root },
    relayAnchorAddress: "RelayPinnedAddr",
    lookup: { fetch },
  };
}

describe("verifyReceiptDocument — a malformed succession never throws and never binds", () => {
  let id: string;
  let signer: KeyPair;
  let guardianHex: string;

  beforeAll(async () => {
    // The id commits to a genesis key the receipt's signer is NOT, so only a
    // chain could bind the signer — and a malformed chain must not.
    const genesis = await generateKeypair();
    id = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    signer = await generateKeypair();
    guardianHex = bytesToHex((await generateKeypair()).publicKey);
  });

  it("an identity object whose fields throw when read: resolves integrity-only, never throws", async () => {
    // No shape check in the primitive can stop a hostile getter; the consumer's
    // per-rung containment is what keeps the "never throws" contract here.
    const receipt = await receiptBy(signer, id, T1);
    const file = identityWith(id, bytesToHex(signer.publicKey), []);
    Object.defineProperty(file, "succession", {
      get() {
        throw new Error("hostile getter");
      },
    });
    const v = await verifyReceiptDocument(JSON.stringify(receipt), {
      identity: file,
      anchor: await onchainAnchor(id, bytesToHex(signer.publicKey)),
    });
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("integrity-only");
  });

  for (const [label, succession] of MALFORMED) {
    it(`succession is ${label}: { identity } resolves integrity-only`, async () => {
      const receipt = await receiptBy(signer, id, T1);
      const file = identityWith(id, bytesToHex(signer.publicKey), succession);
      const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity: file });
      expect(v.integrity).toBe(true);
      expect(v.binding).toBe("integrity-only");
    });

    it(`succession is ${label}: with a trusted guardian and an anchor it still resolves integrity-only`, async () => {
      const receipt = await receiptBy(signer, id, T1);
      const file = identityWith(id, bytesToHex(signer.publicKey), succession);
      const v = await verifyReceiptDocument(JSON.stringify(receipt), {
        identity: file,
        trustedGuardianPublicKey: guardianHex,
        anchor: await onchainAnchor(id, bytesToHex(signer.publicKey)),
      });
      expect(v.integrity).toBe(true);
      expect(v.binding).toBe("integrity-only");
    });
  }
});
