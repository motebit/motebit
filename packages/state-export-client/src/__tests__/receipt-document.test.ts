/**
 * verifyReceiptDocument projects a pasted ExecutionReceipt into an honest view
 * model. The contract under test: a valid offline check is INTEGRITY-ONLY (never
 * "bound") because it verifies against the receipt's own embedded key; bad input
 * surfaces typed reasons rather than throwing. The crypto primitive itself is
 * exhaustively tested in @motebit/crypto — this pins the document-level bridge.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  identityLogLeaf,
  type MotebitIdentityFile,
} from "@motebit/crypto";
import type { ExecutionReceipt } from "@motebit/protocol";

import { verifyReceiptDocument, type ReceiptAnchorOptions } from "../receipt-document.js";

// A minimal identity file whose current key (no rotations) is `currentKeyHex`,
// created before any test receipt's completed_at (2000). Genesis = current key.
function identityFor(motebitId: string, currentKeyHex: string): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(1000).toISOString(),
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
    succession: [],
  };
}

async function signedReceipt(overrides: Partial<ExecutionReceipt> = {}): Promise<ExecutionReceipt> {
  const kp = await generateKeypair();
  const unsigned = {
    task_id: overrides.task_id ?? "task-1",
    motebit_id: overrides.motebit_id ?? "mote-worker",
    device_id: "device-1",
    submitted_at: 1000,
    completed_at: 2000,
    status: overrides.status ?? "completed",
    result: "ok",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "0".repeat(64),
    result_hash: "1".repeat(64),
    public_key: bytesToHex(kp.publicKey),
  } as unknown as Parameters<typeof signExecutionReceipt>[0];
  return signExecutionReceipt(unsigned, kp.privateKey);
}

describe("verifyReceiptDocument", () => {
  it("a valid receipt is integrity-only, never bound (verified against its own embedded key)", async () => {
    const receipt = await signedReceipt({ task_id: "t-abc", motebit_id: "mote-x" });
    const v = await verifyReceiptDocument(JSON.stringify(receipt));
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("integrity-only"); // the whole point: no anchor ⇒ not bound
    expect(v.signerDid).toMatch(/^did:key:/);
    expect(v.motebitId).toBe("mote-x");
    expect(v.taskId).toBe("t-abc");
    expect(v.reason).toBeUndefined();
  });

  it("a matching identity file upgrades the binding to pinned", async () => {
    const receipt = await signedReceipt({ task_id: "t-pin", motebit_id: "mote-x" });
    const identity = identityFor("mote-x", receipt.public_key!);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity });
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("pinned");
  });

  it("an identity file for a DIFFERENT motebit does not pin (stays integrity-only)", async () => {
    const receipt = await signedReceipt({ task_id: "t-x", motebit_id: "mote-x" });
    const identity = identityFor("mote-someone-else", receipt.public_key!);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity });
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("integrity-only");
  });

  it("an identity file whose current key isn't the receipt's key does not pin", async () => {
    const receipt = await signedReceipt({ task_id: "t-y", motebit_id: "mote-x" });
    const otherKey = bytesToHex((await generateKeypair()).publicKey);
    const identity = identityFor("mote-x", otherKey); // right motebit, wrong key
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity });
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("integrity-only");
  });

  it("a tampered signature → integrity false, binding unverified, signature_invalid", async () => {
    const receipt = await signedReceipt();
    const tampered = { ...receipt, signature: receipt.signature.slice(0, -2) + "AA" };
    const v = await verifyReceiptDocument(JSON.stringify(tampered));
    expect(v.integrity).toBe(false);
    expect(v.binding).toBe("unverified");
    expect(v.reason).toBe("signature_invalid");
  });

  it("a receipt without an embedded public_key → missing_public_key", async () => {
    const receipt = await signedReceipt();
    const { public_key: _drop, ...noKey } = receipt;
    const v = await verifyReceiptDocument(JSON.stringify(noKey));
    expect(v.integrity).toBe(false);
    expect(v.binding).toBe("unverified");
    expect(v.reason).toBe("missing_public_key");
  });

  it("malformed JSON → malformed_json (no throw)", async () => {
    const v = await verifyReceiptDocument("{ not json ");
    expect(v.integrity).toBe(false);
    expect(v.binding).toBe("unverified");
    expect(v.reason).toBe("malformed_json");
  });

  it("valid JSON that isn't a receipt → not_a_receipt", async () => {
    const v = await verifyReceiptDocument(JSON.stringify({ hello: "world" }));
    expect(v.integrity).toBe(false);
    expect(v.reason).toBe("not_a_receipt");
  });

  // ── anchored rung ──
  // Single-leaf transparency log: the root IS the leaf, so the inclusion proof is
  // {index:0, siblings:[], layerSizes:[1], anchoredRoot: leaf} (mirrors how the
  // relay's buildIdentityLog would emit a one-binding log). A mock Solana RPC
  // decides whether that root is "on-chain".
  async function singleLeafAnchor(
    motebitId: string,
    keyHex: string,
    onchain: boolean,
  ): Promise<ReceiptAnchorOptions> {
    const root = await identityLogLeaf(motebitId, keyHex);
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: onchain
            ? [
                {
                  signature: "anchor-tx",
                  slot: 1,
                  err: null,
                  memo: `motebit:anchor:v1:${root}:1`,
                  blockTime: null,
                },
              ]
            : [],
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
    return {
      proof: { index: 0, siblings: [], layerSizes: [1], anchoredRoot: root },
      relayAnchorAddress: "RelayPinnedAddr",
      lookup: { fetch },
    };
  }

  it("identity + on-chain-confirmed anchor upgrades the binding to anchored", async () => {
    const receipt = await signedReceipt({ task_id: "t-anch", motebit_id: "mote-x" });
    const identity = identityFor("mote-x", receipt.public_key!);
    const anchor = await singleLeafAnchor("mote-x", receipt.public_key!, true);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity, anchor });
    expect(v.binding).toBe("anchored");
    expect(v.anchorTxHash).toBe("anchor-tx");
  });

  it("a valid inclusion proof whose root is NOT on-chain degrades to pinned", async () => {
    const receipt = await signedReceipt({ task_id: "t-noch", motebit_id: "mote-x" });
    const identity = identityFor("mote-x", receipt.public_key!);
    const anchor = await singleLeafAnchor("mote-x", receipt.public_key!, false);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity, anchor });
    expect(v.binding).toBe("pinned"); // inclusion holds, but the on-chain cross-check failed
    expect(v.anchorTxHash).toBeUndefined();
  });

  it("an anchor proof for the wrong key does not anchor (degrades to pinned)", async () => {
    const receipt = await signedReceipt({ task_id: "t-wrong", motebit_id: "mote-x" });
    const identity = identityFor("mote-x", receipt.public_key!);
    // Proof built over a DIFFERENT key → inclusion fails inside verifyIdentityBindingAnchored.
    const otherKey = bytesToHex((await generateKeypair()).publicKey);
    const anchor = await singleLeafAnchor("mote-x", otherKey, true);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity, anchor });
    expect(v.binding).toBe("pinned");
  });

  it("anchor without identity is ignored (anchored requires the identity file too)", async () => {
    const receipt = await signedReceipt({ task_id: "t-noid", motebit_id: "mote-x" });
    const anchor = await singleLeafAnchor("mote-x", receipt.public_key!, true);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { anchor });
    expect(v.binding).toBe("integrity-only");
  });

  // ── revoked rung (B) ──
  // The signing key's revocation memo at the relay address poisons the binding,
  // overriding pinned/anchored/integrity-only. Mock fetch decides the memo.
  function revocationFetch(keyHex: string, revokedAt: number | null): typeof globalThis.fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result:
            revokedAt === null
              ? []
              : [
                  {
                    signature: "rev-tx",
                    slot: 1,
                    err: null,
                    memo: `motebit:revocation:v1:${keyHex}:${revokedAt}`,
                    blockTime: null,
                  },
                ],
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;
  }

  it("a key revoked at/before completed_at → binding revoked (overrides pinned)", async () => {
    const receipt = await signedReceipt({ task_id: "t-rev", motebit_id: "mote-x" }); // completed_at 2000
    const identity = identityFor("mote-x", receipt.public_key!);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), {
      identity, // would otherwise be pinned
      revocation: {
        relayAnchorAddress: "RelayAddr",
        lookup: { fetch: revocationFetch(receipt.public_key!, 1500) },
      },
    });
    expect(v.integrity).toBe(true); // signature is still valid
    expect(v.binding).toBe("revoked"); // but the key is poisoned
    expect(v.revokedAt).toBe(1500);
  });

  it("a key revoked AFTER completed_at does not revoke (receipt predates revocation)", async () => {
    const receipt = await signedReceipt({ task_id: "t-pre", motebit_id: "mote-x" }); // completed_at 2000
    const identity = identityFor("mote-x", receipt.public_key!);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), {
      identity,
      revocation: {
        relayAnchorAddress: "RelayAddr",
        lookup: { fetch: revocationFetch(receipt.public_key!, 3000) }, // revoked later
      },
    });
    expect(v.binding).toBe("pinned"); // legitimately signed before the revocation
  });

  it("an unknown revocation status (RPC fail) does not falsely revoke", async () => {
    const receipt = await signedReceipt({ task_id: "t-unk", motebit_id: "mote-x" });
    const identity = identityFor("mote-x", receipt.public_key!);
    const failFetch = (async () => {
      throw new Error("rpc down");
    }) as unknown as typeof globalThis.fetch;
    const v = await verifyReceiptDocument(JSON.stringify(receipt), {
      identity,
      revocation: { relayAnchorAddress: "RelayAddr", lookup: { fetch: failFetch } },
    });
    expect(v.binding).toBe("pinned"); // can't prove revoked ⇒ don't claim it
  });

  it("carries a verified delegation through as a nested integrity-only result", async () => {
    const child = await signedReceipt({ task_id: "t-child", motebit_id: "mote-child" });
    // Sign the parent WITH the child embedded so the parent's signature covers
    // the delegation (signing after-the-fact would invalidate it).
    const kp = await generateKeypair();
    const parentUnsigned = {
      task_id: "t-parent",
      motebit_id: "mote-parent",
      device_id: "device-1",
      submitted_at: 1000,
      completed_at: 2000,
      status: "completed",
      result: "ok",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "0".repeat(64),
      result_hash: "1".repeat(64),
      public_key: bytesToHex(kp.publicKey),
      delegation_receipts: [child],
    } as unknown as Parameters<typeof signExecutionReceipt>[0];
    const parent = await signExecutionReceipt(parentUnsigned, kp.privateKey);
    const v = await verifyReceiptDocument(JSON.stringify(parent));
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("integrity-only");
    expect(v.delegations).toBeDefined();
    expect(v.delegations![0]!.taskId).toBe("t-child");
    expect(v.delegations![0]!.binding).toBe("integrity-only");
  });
});
