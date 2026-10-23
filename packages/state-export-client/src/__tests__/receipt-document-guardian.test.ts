/**
 * verifyReceiptDocument and a guardian named only by the presented identity file.
 *
 * Rule: a guardian supplied only by the artifact being verified may be checked
 * for signature integrity, but can never establish authority. A guardian-
 * recovery link lifts a receipt's binding above `integrity-only` only when the
 * caller supplies the guardian (`options.trustedGuardianPublicKey`).
 *
 * The attack (reproduced by execution before the fix): knowing only a victim's
 * genesis PUBLIC key, an attacker presents an identity file whose own
 * `guardian.public_key` signs a recovery link to the attacker's key, and a
 * receipt signed by that key read `binding: "sovereign"`.
 *
 * Also pinned here, at the consumer level: ordinary rotations, legitimate
 * guardian recoveries with a caller-trusted guardian, previously issued
 * receipts, and delegated receipt chains.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  canonicalJson,
  signBySuite,
  signExecutionReceipt,
  identityLogLeaf,
  deriveSovereignMotebitId,
  type KeyPair,
  type MotebitIdentityFile,
  type SuccessionRecord,
} from "@motebit/crypto";
import type { ExecutionReceipt } from "@motebit/protocol";

import { verifyReceiptDocument, type ReceiptAnchorOptions } from "../receipt-document.js";

const SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const T0 = Date.parse("2026-01-01T00:00:00Z"); // identity created
const T1 = Date.parse("2026-02-01T00:00:00Z"); // first link
const T2 = Date.parse("2026-03-01T00:00:00Z"); // second link
const DAY = 24 * 60 * 60 * 1000;

async function ordinaryLink(oldKp: KeyPair, newKp: KeyPair, timestamp: number) {
  const old_public_key = bytesToHex(oldKp.publicKey);
  const new_public_key = bytesToHex(newKp.publicKey);
  const msg = new TextEncoder().encode(
    canonicalJson({ old_public_key, new_public_key, timestamp, suite: SUITE }),
  );
  return {
    old_public_key,
    new_public_key,
    timestamp,
    suite: SUITE,
    old_key_signature: bytesToHex(await signBySuite(SUITE, msg, oldKp.privateKey)),
    new_key_signature: bytesToHex(await signBySuite(SUITE, msg, newKp.privateKey)),
  } as SuccessionRecord;
}

/** A guardian-recovery link. `oldPublicKey` is all the signer needs of the old key. */
async function recoveryLink(
  oldPublicKey: Uint8Array,
  newKp: KeyPair,
  guardianKp: KeyPair,
  timestamp: number,
) {
  const old_public_key = bytesToHex(oldPublicKey);
  const new_public_key = bytesToHex(newKp.publicKey);
  const reason = "guardian_recovery";
  const msg = new TextEncoder().encode(
    canonicalJson({
      old_public_key,
      new_public_key,
      timestamp,
      suite: SUITE,
      reason,
      recovery: true,
    }),
  );
  return {
    old_public_key,
    new_public_key,
    timestamp,
    suite: SUITE,
    reason,
    recovery: true,
    new_key_signature: bytesToHex(await signBySuite(SUITE, msg, newKp.privateKey)),
    guardian_signature: bytesToHex(await signBySuite(SUITE, msg, guardianKp.privateKey)),
  } as SuccessionRecord;
}

function identityFile(
  motebitId: string,
  currentKeyHex: string,
  succession: SuccessionRecord[],
  guardianKeyHex?: string,
): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(T0).toISOString(),
    owner_id: "owner",
    identity: { algorithm: "Ed25519", public_key: currentKeyHex },
    ...(guardianKeyHex !== undefined
      ? { guardian: { public_key: guardianKeyHex, established_at: new Date(T0).toISOString() } }
      : {}),
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
  } as MotebitIdentityFile;
}

async function receiptBy(
  kp: KeyPair,
  motebitId: string,
  completedAt: number,
  extra: Record<string, unknown> = {},
): Promise<ExecutionReceipt> {
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
    ...extra,
  } as unknown as Parameters<typeof signExecutionReceipt>[0];
  return signExecutionReceipt(unsigned, kp.privateKey);
}

/** Single-leaf log whose root is "on-chain" — the anchored rung's material. */
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

describe("verifyReceiptDocument — forged file-named guardian (no victim secret)", () => {
  let victimPub: Uint8Array;
  let sovereignVictimId: string;
  let kAtt: KeyPair;
  let gAtt: KeyPair;

  beforeAll(async () => {
    victimPub = (await generateKeypair()).publicKey; // the attacker holds only this
    sovereignVictimId = await deriveSovereignMotebitId(bytesToHex(victimPub));
    kAtt = await generateKeypair();
    gAtt = await generateKeypair();
  });

  it("a sovereign victim id: the forged file does NOT reach sovereign (plain { identity } call)", async () => {
    const link = await recoveryLink(victimPub, kAtt, gAtt, T1);
    const file = identityFile(
      sovereignVictimId,
      bytesToHex(kAtt.publicKey),
      [link],
      bytesToHex(gAtt.publicKey),
    );
    const receipt = await receiptBy(kAtt, sovereignVictimId, T1 + DAY);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity: file });
    expect(v.integrity).toBe(true);
    expect(v.binding).toBe("integrity-only");
  });

  it("the forged file does NOT reach anchored, even with an on-chain-confirmed log root", async () => {
    const link = await recoveryLink(victimPub, kAtt, gAtt, T1);
    const file = identityFile(
      sovereignVictimId,
      bytesToHex(kAtt.publicKey),
      [link],
      bytesToHex(gAtt.publicKey),
    );
    const receipt = await receiptBy(kAtt, sovereignVictimId, T1 + DAY);
    const anchor = await onchainAnchor(sovereignVictimId, bytesToHex(kAtt.publicKey));
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity: file, anchor });
    expect(v.binding).toBe("integrity-only");
  });

  it("a legacy (random) victim id: the forged file does NOT reach pinned", async () => {
    const link = await recoveryLink(victimPub, kAtt, gAtt, T1);
    const file = identityFile(
      "mote-legacy-victim",
      bytesToHex(kAtt.publicKey),
      [link],
      bytesToHex(gAtt.publicKey),
    );
    const receipt = await receiptBy(kAtt, "mote-legacy-victim", T1 + DAY);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity: file });
    expect(v.binding).toBe("integrity-only");
  });

  it("a caller-trusted guardian that disagrees with the file's wins: still integrity-only", async () => {
    const link = await recoveryLink(victimPub, kAtt, gAtt, T1);
    const file = identityFile(
      sovereignVictimId,
      bytesToHex(kAtt.publicKey),
      [link],
      bytesToHex(gAtt.publicKey),
    );
    const receipt = await receiptBy(kAtt, sovereignVictimId, T1 + DAY);
    const realGuardian = bytesToHex((await generateKeypair()).publicKey);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), {
      identity: file,
      trustedGuardianPublicKey: realGuardian,
    });
    expect(v.binding).toBe("integrity-only");
  });
});

describe("verifyReceiptDocument — legitimate chains (consumer-level regressions)", () => {
  let genesis: KeyPair;
  let mid: KeyPair;
  let recovered: KeyPair;
  let guardian: KeyPair;
  let sid: string;
  let gHex: string;

  beforeAll(async () => {
    genesis = await generateKeypair();
    mid = await generateKeypair();
    recovered = await generateKeypair();
    guardian = await generateKeypair();
    sid = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    gHex = bytesToHex(guardian.publicKey);
  });

  it("ordinary rotation, no guardian: a rotated-key receipt is sovereign, unchanged", async () => {
    const file = identityFile(sid, bytesToHex(mid.publicKey), [
      await ordinaryLink(genesis, mid, T1),
    ]);
    const receipt = await receiptBy(mid, sid, T1 + DAY);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity: file });
    expect(v.binding).toBe("sovereign");
  });

  it("ordinary rotation with a guardian in the file: still sovereign (the guardian is not consulted)", async () => {
    const file = identityFile(
      sid,
      bytesToHex(mid.publicKey),
      [await ordinaryLink(genesis, mid, T1)],
      gHex,
    );
    const receipt = await receiptBy(mid, sid, T1 + DAY);
    const v = await verifyReceiptDocument(JSON.stringify(receipt), { identity: file });
    expect(v.binding).toBe("sovereign");
  });

  it("legitimate guardian recovery: sovereign WITH the caller-trusted guardian, integrity-only without", async () => {
    const chain = [
      await ordinaryLink(genesis, mid, T1),
      await recoveryLink(mid.publicKey, recovered, guardian, T2),
    ];
    const file = identityFile(sid, bytesToHex(recovered.publicKey), chain, gHex);
    const receipt = await receiptBy(recovered, sid, T2 + DAY);
    const text = JSON.stringify(receipt);

    const trusted = await verifyReceiptDocument(text, {
      identity: file,
      trustedGuardianPublicKey: gHex,
    });
    expect(trusted.binding).toBe("sovereign");

    const fileOnly = await verifyReceiptDocument(text, { identity: file });
    expect(fileOnly.binding).toBe("integrity-only");
  });

  it("previously issued receipts across a recovery: genesis-key receipts stay sovereign offline; mid-chain receipts need the trusted guardian", async () => {
    const chain = [
      await ordinaryLink(genesis, mid, T1),
      await recoveryLink(mid.publicKey, recovered, guardian, T2),
    ];
    const file = identityFile(sid, bytesToHex(recovered.publicKey), chain, gHex);

    // Signed by the genesis key the id commits to: receipt-alone sovereign,
    // independent of any identity file — unchanged.
    const genesisReceipt = JSON.stringify(await receiptBy(genesis, sid, T0 + DAY));
    expect((await verifyReceiptDocument(genesisReceipt, { identity: file })).binding).toBe(
      "sovereign",
    );

    // Signed by the since-recovered-away mid key inside its window.
    const midReceipt = JSON.stringify(await receiptBy(mid, sid, T1 + DAY));
    expect(
      (await verifyReceiptDocument(midReceipt, { identity: file, trustedGuardianPublicKey: gHex }))
        .binding,
    ).toBe("sovereign");
    expect((await verifyReceiptDocument(midReceipt, { identity: file })).binding).toBe(
      "integrity-only",
    );

    // The recovered-away key does NOT bind after the recovery, either way.
    const lateMid = JSON.stringify(await receiptBy(mid, sid, T2 + DAY));
    expect(
      (await verifyReceiptDocument(lateMid, { identity: file, trustedGuardianPublicKey: gHex }))
        .binding,
    ).toBe("integrity-only");
  });

  it("delegated receipt chains: integrity and nested results unchanged; root binding follows the guardian rule", async () => {
    const chain = [await recoveryLink(genesis.publicKey, recovered, guardian, T1)];
    const file = identityFile(sid, bytesToHex(recovered.publicKey), chain, gHex);
    const child = await receiptBy(await generateKeypair(), "mote-child", T1 + DAY);
    const parent = await receiptBy(recovered, sid, T1 + DAY, { delegation_receipts: [child] });
    const text = JSON.stringify(parent);

    const trusted = await verifyReceiptDocument(text, {
      identity: file,
      trustedGuardianPublicKey: gHex,
    });
    expect(trusted.integrity).toBe(true);
    expect(trusted.binding).toBe("sovereign");
    expect(trusted.delegations?.[0]?.integrity).toBe(true);
    expect(trusted.delegations?.[0]?.binding).toBe("integrity-only");

    const fileOnly = await verifyReceiptDocument(text, { identity: file });
    expect(fileOnly.integrity).toBe(true);
    expect(fileOnly.binding).toBe("integrity-only");
    expect(fileOnly.delegations?.[0]?.integrity).toBe(true);
  });

  it("prefix key (genesis→k1 ordinary→k3 recovery): a k1 receipt before the recovery is integrity-only without the trusted guardian", async () => {
    const chain = [
      await ordinaryLink(genesis, mid, T1),
      await recoveryLink(mid.publicKey, recovered, guardian, T2),
    ];
    const file = identityFile(sid, bytesToHex(recovered.publicKey), chain, gHex);
    const k1Receipt = JSON.stringify(await receiptBy(mid, sid, T1 + DAY));
    expect(
      (await verifyReceiptDocument(k1Receipt, { identity: file, trustedGuardianPublicKey: gHex }))
        .binding,
    ).toBe("sovereign");
    expect((await verifyReceiptDocument(k1Receipt, { identity: file })).binding).toBe(
      "integrity-only",
    );
  });

  it("a null or empty trustedGuardianPublicKey is treated as not supplied", async () => {
    const chain = [await recoveryLink(genesis.publicKey, recovered, guardian, T1)];
    const file = identityFile(sid, bytesToHex(recovered.publicKey), chain, gHex);
    const text = JSON.stringify(await receiptBy(recovered, sid, T1 + DAY));
    for (const value of [null, ""]) {
      const v = await verifyReceiptDocument(text, {
        identity: file,
        trustedGuardianPublicKey: value as unknown as string,
      });
      expect(v.binding).toBe("integrity-only");
    }
  });
});
