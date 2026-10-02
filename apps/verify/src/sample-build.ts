/**
 * The on-load SAMPLE receipt — built deterministically from FIXED, PUBLIC demo
 * seeds so anyone can regenerate the byte-identical fixture
 * (`scripts/mint-sample.ts` → `src/sample-receipt.json`) and a test asserts the
 * committed file still equals this function's output AND still verifies.
 *
 * Provenance over magic: these seeds are not secrets. They sign nothing but this
 * sample. Ed25519 signing is deterministic (RFC 8032), so the same seed + body
 * always yields the same signature. Signed through the canonical
 * `signExecutionReceipt` — never a hand-rolled signer.
 */

import {
  bytesToHex,
  deriveSovereignMotebitId,
  getPublicKeyBySuite,
  hash,
  signExecutionReceipt,
  EXECUTION_RECEIPT_SUITE,
} from "@motebit/crypto";

/** Seed bytes `start, start+1, …` — a visibly non-random, public demo key. */
function demoSeed(start: number): Uint8Array {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (start + i) & 0xff;
  return seed;
}

/** Root signer seed 0x01..0x20; the delegated worker's seed 0x21..0x40. */
export const SAMPLE_ROOT_SEED = demoSeed(0x01);
export const SAMPLE_WORKER_SEED = demoSeed(0x21);

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

async function demoSigner(seed: Uint8Array) {
  const publicKey = await getPublicKeyBySuite(seed, EXECUTION_RECEIPT_SUITE);
  const motebitId = await deriveSovereignMotebitId(bytesToHex(publicKey));
  return { privateKey: seed, publicKey, motebitId };
}

/** Build the signed sample receipt (root + one delegated receipt). */
export async function buildSampleReceipt(): Promise<Record<string, unknown>> {
  const root = await demoSigner(SAMPLE_ROOT_SEED);
  const worker = await demoSigner(SAMPLE_WORKER_SEED);

  const childPrompt = "Fetch the v2.4 release notes.";
  const childResult = "Fetched 3 sections from the v2.4 release notes (1,412 bytes).";
  const child = await signExecutionReceipt(
    {
      task_id: "019dc500-0000-7000-a000-0000000000c1",
      motebit_id: worker.motebitId,
      device_id: "sample-worker-device",
      submitted_at: 1790000000400,
      completed_at: 1790000001100,
      status: "completed",
      result: childResult,
      tools_used: ["read_url"],
      memories_formed: 0,
      prompt_hash: await hash(utf8(childPrompt)),
      result_hash: await hash(utf8(childResult)),
      delegated_scope: "read_url",
    },
    worker.privateKey,
    worker.publicKey,
  );

  const prompt = "Summarize the three changes in the v2.4 release notes.";
  const result =
    "v2.4 adds offline receipt verification, a shareable link format for receipts, and faster key rotation.";
  const signed = await signExecutionReceipt(
    {
      task_id: "019dc500-0000-7000-a000-0000000000a1",
      motebit_id: root.motebitId,
      device_id: "sample-device",
      submitted_at: 1790000000000,
      completed_at: 1790000002000,
      status: "completed",
      result,
      tools_used: ["delegate_to_agent"],
      memories_formed: 1,
      prompt_hash: await hash(utf8(prompt)),
      result_hash: await hash(utf8(result)),
      delegation_receipts: [child],
    },
    root.privateKey,
    root.publicKey,
  );
  // Plain JSON round-trip — drops the freeze and fixes key order to insertion order.
  return JSON.parse(JSON.stringify(signed)) as Record<string, unknown>;
}

/** The committed fixture's serialization (pretty, trailing newline). */
export function serializeSample(receipt: Record<string, unknown>): string {
  return JSON.stringify(receipt, null, 2) + "\n";
}
