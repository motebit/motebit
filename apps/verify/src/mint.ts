/**
 * MINT — sign a receipt in this tab with a throwaway Ed25519 key. The key is
 * generated here, used once, and dropped: it is never stored, logged or sent.
 * The motebit_id is derived from the key (`deriveSovereignMotebitId`), so the
 * minted receipt verifies `sovereign` — which is exactly the lesson: sovereign
 * is a math binding a brand-new key gets for free, not a mark of trust.
 */

import {
  bytesToHex,
  deriveSovereignMotebitId,
  getPublicKeyBySuite,
  hash,
  signExecutionReceipt,
  EXECUTION_RECEIPT_SUITE,
  type KeyPair,
} from "@motebit/crypto";

export interface MintInput {
  readonly prompt: string;
  readonly result: string;
}

export interface MintOptions {
  /** Inject a key (tests). Defaults to a fresh throwaway key. */
  readonly keypair?: KeyPair;
  /** Inject the clock (tests). Defaults to `Date.now()`. */
  readonly now?: number;
  /** Inject the task id (tests). Defaults to `crypto.randomUUID()`. */
  readonly taskId?: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A throwaway signing key — NOT a motebit identity (identities are minted only
 * through `bootstrapIdentity()` in @motebit/core-identity, which is why
 * `generateKeypair` is lint-restricted on surfaces). An Ed25519 private key is
 * its 32-byte seed, so this is the same seed → public-key path the committed
 * sample uses (`sample-build.ts`), with the seed from the platform CSPRNG.
 */
async function throwawayKey(): Promise<KeyPair> {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await getPublicKeyBySuite(privateKey, EXECUTION_RECEIPT_SUITE);
  return { privateKey, publicKey };
}

/** Sign a demo receipt; returns pretty JSON ready to verify. */
export async function mintDemoReceipt(input: MintInput, opts: MintOptions = {}): Promise<string> {
  const keypair = opts.keypair ?? (await throwawayKey());
  const now = opts.now ?? Date.now();
  const motebitId = await deriveSovereignMotebitId(bytesToHex(keypair.publicKey));
  const signed = await signExecutionReceipt(
    {
      task_id: opts.taskId ?? crypto.randomUUID(),
      motebit_id: motebitId,
      device_id: "receipt-computer-demo",
      submitted_at: now,
      completed_at: now,
      status: "completed",
      result: input.result,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: await hash(utf8(input.prompt)),
      result_hash: await hash(utf8(input.result)),
    },
    keypair.privateKey,
    keypair.publicKey,
  );
  return JSON.stringify(signed, null, 2);
}
