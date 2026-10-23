/**
 * receipt.computer grades for guardian-recovered identities, after
 * "a guardian named only by the artifact being verified can never establish
 * authority" landed in @motebit/crypto.
 *
 * Since #1115 the page does not grade on the verifier's `binding` value. It
 * binds pinned/anchored only through its own `checkServedChain` (guardian
 * stripped), and its key-commitment rung reads the verifier's receipt-alone
 * `sovereign`. So the library fix changes NO page grade. This file drives the
 * page's real grading pipeline (`main.ts`: verify → resolve → verify with the
 * served identity → `checkServedChain` → `assessVerdict`; revocation omitted,
 * no RPC) and pins every case:
 *
 *   - the page grade is unchanged in every case;
 *   - where the verifier's raw `binding` (an input the page does not grade
 *     on) moved from `sovereign`/`pinned` to `integrity-only`, that is asserted
 *     too, so the shift is visible and cannot hide a regression.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  canonicalJson,
  sha256,
  signBySuite,
  signExecutionReceipt,
  deriveSovereignMotebitId,
  type KeyPair,
  type SuccessionRecord,
} from "@motebit/crypto";
import { verifyReceiptDocument } from "@motebit/state-export-client";
import { resolveReceiptBinding, type IdentityBundle } from "../relay-binding.js";
import { assessVerdict, type BindingEvidence } from "../assess.js";
import { checkServedChain, classifyId, idCommitsToKey } from "../served-chain.js";
import { noncanonicalFields } from "../canonical.js";

const SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const RELAY = "https://relay.example.com";
const T0 = Date.parse("2026-01-01T00:00:00Z");
const T1 = Date.parse("2026-02-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let relay: KeyPair;

beforeAll(async () => {
  relay = await generateKeypair();
});

async function declaration(): Promise<unknown> {
  const payload = {
    spec: "motebit-transparency/draft-2026-04-14",
    declared_at: 1736500000000,
    relay_id: "relay-r",
    relay_public_key: bytesToHex(relay.publicKey),
    content: { purpose: "test", retention: "none" },
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  return {
    ...payload,
    hash: bytesToHex(await sha256(canonical)),
    suite: SUITE,
    signature: bytesToHex(await signBySuite(SUITE, canonical, relay.privateKey)),
  };
}

async function relayServing(b: IdentityBundle): Promise<typeof globalThis.fetch> {
  const decl = await declaration();
  return (async (url: string) => {
    if (url.includes("/.well-known/motebit-transparency.json"))
      return new Response(JSON.stringify(decl), { status: 200 });
    if (url.includes("/api/v1/identity/")) return new Response(JSON.stringify(b), { status: 200 });
    return new Response("?", { status: 500 });
  }) as unknown as typeof globalThis.fetch;
}

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

async function recoveryLink(oldPub: Uint8Array, newKp: KeyPair, g: KeyPair, timestamp: number) {
  const old_public_key = bytesToHex(oldPub);
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
    guardian_signature: bytesToHex(await signBySuite(SUITE, msg, g.privateKey)),
  } as SuccessionRecord;
}

async function receiptText(kp: KeyPair, motebitId: string, completedAt: number): Promise<string> {
  const unsigned = {
    task_id: `t-${completedAt}`,
    motebit_id: motebitId,
    device_id: "d",
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
  return JSON.stringify(await signExecutionReceipt(unsigned, kp.privateKey));
}

/**
 * main.ts's grading pipeline for a pasted receipt once the relay resolves
 * (revocation omitted: no RPC). Returns the page's grade and, separately, the
 * verifier's raw binding (which the page does not grade on).
 */
async function pageGrade(
  text: string,
  b: IdentityBundle,
): Promise<{ page: string; verifier: string }> {
  const receipt = JSON.parse(text) as {
    motebit_id: string;
    public_key: string;
    completed_at: number;
  };
  const offline = await verifyReceiptDocument(text);
  expect(offline.integrity).toBe(true);
  const resolved = await resolveReceiptBinding({
    relayBase: RELAY,
    motebitId: b.motebit_id,
    fetch: await relayServing(b),
  });
  expect(resolved).not.toBeNull();
  const view = await verifyReceiptDocument(text, {
    identity: resolved!.identity,
    ...(resolved!.anchor ? { anchor: resolved!.anchor } : {}),
  });
  const keyEvidence: BindingEvidence = {
    keyCommitsToId: await idCommitsToKey(receipt.motebit_id, receipt.public_key),
    idForm: classifyId(receipt.motebit_id),
    noncanonical: noncanonicalFields(receipt),
    servedChain: await checkServedChain(receipt, resolved!.identity),
  };
  return { page: assessVerdict(view, undefined, keyEvidence).binding, verifier: view.binding };
}

function bundleFor(
  motebitId: string,
  current: KeyPair,
  succession: SuccessionRecord[],
  guardian?: KeyPair,
): IdentityBundle {
  return {
    motebit_id: motebitId,
    created_at: new Date(T0).toISOString(),
    current_public_key: bytesToHex(current.publicKey),
    ...(guardian ? { guardian_public_key: bytesToHex(guardian.publicKey) } : {}),
    succession,
    anchored: null,
  };
}

const LEGACY_ID = "019dc500-0000-7abc-8000-0000000000bb"; // canonical UUIDv7

describe("receipt.computer grades — guardian recovery (no page grade changes)", () => {
  it("ordinary rotation, rotated-key receipt: page pinned, verifier sovereign — both unchanged", async () => {
    const genesis = await generateKeypair();
    const rotated = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    const b = bundleFor(id, rotated, [await ordinaryLink(genesis, rotated, T1)]);
    expect(await pageGrade(await receiptText(rotated, id, T1 + DAY), b)).toEqual({
      page: "pinned",
      verifier: "sovereign",
    });
  });

  it("ordinary rotation with a relay-served guardian: unchanged (the guardian is not consulted)", async () => {
    const genesis = await generateKeypair();
    const rotated = await generateKeypair();
    const guardian = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    const b = bundleFor(id, rotated, [await ordinaryLink(genesis, rotated, T1)], guardian);
    expect(await pageGrade(await receiptText(rotated, id, T1 + DAY), b)).toEqual({
      page: "pinned",
      verifier: "sovereign",
    });
  });

  it("legacy id, ordinary rotation: page pinned, verifier pinned — unchanged", async () => {
    const genesis = await generateKeypair();
    const rotated = await generateKeypair();
    const b = bundleFor(LEGACY_ID, rotated, [await ordinaryLink(genesis, rotated, T1)]);
    expect(await pageGrade(await receiptText(rotated, LEGACY_ID, T1 + DAY), b)).toEqual({
      page: "pinned",
      verifier: "pinned",
    });
  });

  it("genesis-key receipt of a recovered identity: page key-commitment, verifier sovereign (receipt-alone) — unchanged", async () => {
    const genesis = await generateKeypair();
    const recovered = await generateKeypair();
    const guardian = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    const b = bundleFor(
      id,
      recovered,
      [await recoveryLink(genesis.publicKey, recovered, guardian, T1)],
      guardian,
    );
    expect(await pageGrade(await receiptText(genesis, id, T0 + DAY), b)).toEqual({
      page: "key-commitment",
      verifier: "sovereign",
    });
  });

  it("legitimate recovery, recovered-key receipt: page integrity-only (unchanged); verifier sovereign → integrity-only", async () => {
    const genesis = await generateKeypair();
    const recovered = await generateKeypair();
    const guardian = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    const b = bundleFor(
      id,
      recovered,
      [await recoveryLink(genesis.publicKey, recovered, guardian, T1)],
      guardian,
    );
    expect(await pageGrade(await receiptText(recovered, id, T1 + DAY), b)).toEqual({
      page: "integrity-only",
      verifier: "integrity-only",
    });
  });

  it("forged guardian + recovery for a victim id: page integrity-only (unchanged); verifier sovereign → integrity-only", async () => {
    const victimPub = (await generateKeypair()).publicKey; // no victim secret
    const kAtt = await generateKeypair();
    const gAtt = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(victimPub));
    const b = bundleFor(id, kAtt, [await recoveryLink(victimPub, kAtt, gAtt, T1)], gAtt);
    expect(await pageGrade(await receiptText(kAtt, id, T1 + DAY), b)).toEqual({
      page: "integrity-only",
      verifier: "integrity-only",
    });
  });

  it("legacy id through a recovery: page integrity-only (unchanged); verifier pinned → integrity-only", async () => {
    const genesis = await generateKeypair();
    const recovered = await generateKeypair();
    const guardian = await generateKeypair();
    const b = bundleFor(
      LEGACY_ID,
      recovered,
      [await recoveryLink(genesis.publicKey, recovered, guardian, T1)],
      guardian,
    );
    expect(await pageGrade(await receiptText(recovered, LEGACY_ID, T1 + DAY), b)).toEqual({
      page: "integrity-only",
      verifier: "integrity-only",
    });
  });

  it("prefix key (genesis→k1 ordinary→k3 recovery), k1 receipt before the recovery: page integrity-only (unchanged); verifier sovereign → integrity-only", async () => {
    const genesis = await generateKeypair();
    const k1 = await generateKeypair();
    const k3 = await generateKeypair();
    const guardian = await generateKeypair();
    const id = await deriveSovereignMotebitId(bytesToHex(genesis.publicKey));
    const b = bundleFor(
      id,
      k3,
      [
        await ordinaryLink(genesis, k1, T1),
        await recoveryLink(k1.publicKey, k3, guardian, T1 + 2 * DAY),
      ],
      guardian,
    );
    expect(await pageGrade(await receiptText(k1, id, T1 + DAY), b)).toEqual({
      page: "integrity-only",
      verifier: "integrity-only",
    });
  });
});
