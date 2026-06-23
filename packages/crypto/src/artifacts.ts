/**
 * Protocol artifact signing — receipts, delegations, successions, collaborative receipts.
 *
 * These functions define the canonical signing format for all Motebit protocol
 * artifacts. A third party needs these to produce valid signed artifacts that
 * any verifier will accept.
 *
 * Moved from BSL @motebit/encryption to the permissive floor in @motebit/crypto (Apache-2.0).
 */

import {
  canonicalJson,
  canonicalSha256,
  toBase64Url,
  fromBase64Url,
  bytesToHex,
  hexToBytes,
  hash,
  isScopeNarrowed,
  signBySuite,
  verifyBySuite,
  base58btcEncode,
} from "./signing.js";

/**
 * Diagnostic flag for cryptographic-artifact debugging. Reads from
 * `process.env.DEBUG_RECEIPT_BYTES` in Node and from
 * `globalThis.__motebit_debug_receipt_bytes` in browsers. When truthy,
 * `signExecutionReceipt` and `verifyExecutionReceipt*` log the canonical
 * SHA-256 and a short preview of the canonical JSON, so a verification
 * mismatch can be byte-diffed against the producer's intended bytes
 * without re-instrumenting either end. Off by default; zero overhead when
 * disabled.
 *
 * Pattern source: NIST SP 800-57 §5.4 — minimum observability for any
 * signed-artifact pipeline that crosses a process boundary.
 */
function isReceiptDebugEnabled(): boolean {
  const g = globalThis as unknown as {
    __motebit_debug_receipt_bytes?: boolean;
    process?: { env?: Record<string, string | undefined> };
  };
  if (g.__motebit_debug_receipt_bytes === true) return true;
  const flag = g.process?.env?.DEBUG_RECEIPT_BYTES;
  return flag === "1" || flag === "true";
}

// === Execution Receipt Signing ===

/**
 * Shape of an execution receipt for signing/verification.
 * Structurally compatible with @motebit/protocol ExecutionReceipt.
 */
export interface SignableReceipt {
  task_id: string;
  motebit_id: string;
  /** Signer's Ed25519 public key (hex). Enables verification without relay lookup. */
  public_key?: string;
  device_id: string;
  submitted_at: number;
  completed_at: number;
  status: "completed" | "failed" | "denied";
  result: string;
  tools_used: string[];
  memories_formed: number;
  prompt_hash: string;
  result_hash: string;
  delegation_receipts?: SignableReceipt[];
  relay_task_id?: string;
  delegated_scope?: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` today —
   * the verification recipe is JCS canonicalization of the unsigned body,
   * Ed25519 primitive, base64url signature encoding. Every ExecutionReceipt
   * on the wire carries this field; verifiers reject missing or unknown
   * values fail-closed. Widening this literal to add a PQ suite is a
   * deliberate registry change (see @motebit/protocol `SuiteId`).
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/** The one suite ExecutionReceipts sign under today. */
export const EXECUTION_RECEIPT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign an execution receipt. Stamps the cryptosuite discriminator into
 * the receipt body, canonicalizes with JCS, dispatches the primitive
 * signature through `signBySuite`, and encodes as base64url per the
 * suite's rules.
 *
 * Callers pass a receipt *without* `signature` or `suite`; the signer
 * owns both. The returned object is a full `SignableReceipt` with
 * `suite` and `signature` set.
 */
export async function signExecutionReceipt<T extends Omit<SignableReceipt, "signature" | "suite">>(
  receipt: T,
  privateKey: Uint8Array,
  publicKey?: Uint8Array,
): Promise<T & { suite: typeof EXECUTION_RECEIPT_SUITE; signature: string }> {
  // Embed the public key for portable verification (no relay lookup needed)
  // and stamp the suite into the signed body.
  const withKey = publicKey ? { ...receipt, public_key: bytesToHex(publicKey) } : receipt;
  const body = { ...withKey, suite: EXECUTION_RECEIPT_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(EXECUTION_RECEIPT_SUITE, message, privateKey);
  const signed = { ...body, signature: toBase64Url(sig) } as T & {
    suite: typeof EXECUTION_RECEIPT_SUITE;
    signature: string;
  };

  if (isReceiptDebugEnabled()) {
    const sha = await canonicalSha256(body);
    // eslint-disable-next-line no-console -- opt-in diagnostic, off by default
    console.debug(
      `[motebit/crypto] signExecutionReceipt canonical_sha256=${sha} chain=${
        Array.isArray((body as Record<string, unknown>).delegation_receipts)
          ? ((body as Record<string, unknown>).delegation_receipts as unknown[]).length
          : 0
      } bytes=${canonical.length}`,
    );
  }

  // Freeze the returned signed receipt. Receipts are immutable evidence by
  // contract — the type system already says `readonly` is the intent. Freeze
  // makes the runtime enforce it: any post-sign mutation throws TypeError
  // at the mutation site (Node 20 strict mode, browser strict by default),
  // catching the bug at the producer instead of as wire-corruption noise on
  // the consumer five hops downstream.
  return Object.freeze(signed);
}

/**
 * Verify an execution receipt's signature by dispatching through the
 * recipe named in `receipt.suite`. Reconstructs the canonical JSON from
 * all fields except `signature` (the suite IS part of the signed body,
 * so tampering with it breaks verification).
 *
 * Fail-closed on:
 *   - unknown suite value (dispatcher rejects)
 *   - suite other than `EXECUTION_RECEIPT_SUITE` (until a PQ variant
 *     lands in the registry, this narrow check rejects any other
 *     value — widens when the union widens)
 *   - base64url decode errors
 *   - primitive-level verification failure
 */
export async function verifyExecutionReceipt(
  receipt: SignableReceipt,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (receipt.suite !== EXECUTION_RECEIPT_SUITE) {
    if (isReceiptDebugEnabled()) {
      // eslint-disable-next-line no-console -- opt-in diagnostic
      console.debug(
        `[motebit/crypto] verifyExecutionReceipt EARLY_RETURN suite_mismatch actual=${JSON.stringify(receipt.suite)} expected=${JSON.stringify(EXECUTION_RECEIPT_SUITE)}`,
      );
    }
    return false;
  }
  const { signature, ...body } = receipt;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);

  let valid = false;
  try {
    const sig = fromBase64Url(signature);
    valid = await verifyBySuite(receipt.suite, message, sig, publicKey);
  } catch {
    valid = false;
  }

  if (isReceiptDebugEnabled()) {
    const sha = await canonicalSha256(body);
    // eslint-disable-next-line no-console -- opt-in diagnostic, off by default
    console.debug(
      `[motebit/crypto] verifyExecutionReceipt canonical_sha256=${sha} valid=${valid} bytes=${canonical.length}`,
    );
  }

  return valid;
}

/**
 * Companion to `verifyExecutionReceipt` that returns diagnostic detail
 * alongside the boolean verdict. Intended for failure-path observability:
 * when verification fails, the caller can log `canonical_sha256` and
 * `canonical_preview` and the producer can byte-diff against its own
 * sign-time hash to localize the mutation. Same canonicalization recipe
 * as the boolean function — the diagnostic is derived from the exact bytes
 * the verifier checked.
 *
 * Cost: one extra `canonicalJson` + SHA-256 per call. Negligible for the
 * verify-failed path (rare); callers on the hot success path should still
 * use `verifyExecutionReceipt` directly.
 */
export interface ReceiptVerifyDetail {
  valid: boolean;
  /** Hex SHA-256 of the canonical bytes the verifier checked. */
  canonical_sha256: string;
  /** First 256 chars of the canonical JSON — enough to spot most field-level diffs. */
  canonical_preview: string;
  /** Reason category if valid is false; `"ok"` if true. */
  reason: "ok" | "wrong_suite" | "bad_base64" | "ed25519_mismatch";
}

export async function verifyExecutionReceiptDetailed(
  receipt: SignableReceipt,
  publicKey: Uint8Array,
): Promise<ReceiptVerifyDetail> {
  if (receipt.suite !== EXECUTION_RECEIPT_SUITE) {
    const { signature: _drop, ...bodyForHash } = receipt;
    return {
      valid: false,
      canonical_sha256: await canonicalSha256(bodyForHash),
      canonical_preview: canonicalJson(bodyForHash).slice(0, 256),
      reason: "wrong_suite",
    };
  }
  const { signature, ...body } = receipt;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(signature);
  } catch {
    return {
      valid: false,
      canonical_sha256: await hash(message),
      canonical_preview: canonical.slice(0, 256),
      reason: "bad_base64",
    };
  }

  const valid = await verifyBySuite(receipt.suite, message, sigBytes, publicKey);
  return {
    valid,
    canonical_sha256: await hash(message),
    canonical_preview: canonical.slice(0, 256),
    reason: valid ? "ok" : "ed25519_mismatch",
  };
}

// === Tool Invocation Receipts ===

/**
 * Shape of a tool-invocation receipt for signing/verification.
 * Structurally compatible with `@motebit/protocol` ToolInvocationReceipt.
 *
 * A per-tool-call signed artifact: one receipt per invocation of a tool
 * during an agent turn. The slab emits these live as tool calls
 * complete. Binding to the enclosing task is by `task_id`; a verifier
 * can gather all invocations for a task by matching it.
 *
 * Commits to structural facts only — tool name, canonical-JSON SHA-256
 * hashes of args and result, timestamps, identities. The raw args and
 * raw result bytes are *not* part of the receipt; a verifier who holds
 * them can recompute the hash and check against the signature.
 */
export interface SignableToolInvocationReceipt {
  invocation_id: string;
  task_id: string;
  motebit_id: string;
  /** Signer's Ed25519 public key (hex). Enables verification without relay lookup. */
  public_key?: string;
  device_id: string;
  tool_name: string;
  started_at: number;
  completed_at: number;
  status: "completed" | "failed" | "denied";
  args_hash: string;
  result_hash: string;
  /** Optional surface-determinism discriminator; signature-bound when present. */
  invocation_origin?: "user-tap" | "ai-loop" | "scheduled" | "agent-to-agent";
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` for
   * this artifact today — same verification recipe as `ExecutionReceipt`.
   * Narrowed to the single suite today so widening requires intentional
   * registry + type change.
   */
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
}

/** The one suite ToolInvocationReceipts sign under today. */
export const TOOL_INVOCATION_RECEIPT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Compute the `args_hash` / `result_hash` for a tool-invocation receipt.
 * JCS-canonicalizes the value, then SHA-256s the UTF-8 bytes. Returns
 * hex. Use on both sides of the wire: the producer computes the hash at
 * sign time; a verifier with the raw value recomputes and matches.
 *
 * For `string` values (e.g., a plain result string), the canonicalization
 * is the value itself wrapped with JSON escaping rules; `canonicalJson`
 * handles both scalar and object inputs uniformly.
 */
export async function hashToolPayload(value: unknown): Promise<string> {
  return canonicalSha256(value);
}

/**
 * Sign a tool-invocation receipt. Mirrors `signExecutionReceipt`:
 * stamps the cryptosuite into the body, canonicalizes with JCS,
 * dispatches through `signBySuite`, and encodes as base64url.
 *
 * Callers pass a receipt *without* `signature` or `suite`; the signer
 * owns both. Also embeds the public key (hex) so the receipt is
 * independently verifiable with no relay lookup.
 */
export async function signToolInvocationReceipt<
  T extends Omit<SignableToolInvocationReceipt, "signature" | "suite">,
>(
  receipt: T,
  privateKey: Uint8Array,
  publicKey?: Uint8Array,
): Promise<T & { suite: typeof TOOL_INVOCATION_RECEIPT_SUITE; signature: string }> {
  const withKey = publicKey ? { ...receipt, public_key: bytesToHex(publicKey) } : receipt;
  const body = { ...withKey, suite: TOOL_INVOCATION_RECEIPT_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(TOOL_INVOCATION_RECEIPT_SUITE, message, privateKey);
  const signed = { ...body, signature: toBase64Url(sig) } as T & {
    suite: typeof TOOL_INVOCATION_RECEIPT_SUITE;
    signature: string;
  };

  if (isReceiptDebugEnabled()) {
    const sha = await canonicalSha256(body);
    // eslint-disable-next-line no-console -- opt-in diagnostic, off by default
    console.debug(
      `[motebit/crypto] signToolInvocationReceipt canonical_sha256=${sha} tool=${
        (body as Record<string, unknown>).tool_name as string
      } bytes=${canonical.length}`,
    );
  }

  return Object.freeze(signed);
}

/**
 * Verify a tool-invocation receipt. Fails closed on unknown suite, bad
 * base64, or signature mismatch — same rules as `verifyExecutionReceipt`.
 */
export async function verifyToolInvocationReceipt(
  receipt: SignableToolInvocationReceipt,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (receipt.suite !== TOOL_INVOCATION_RECEIPT_SUITE) {
    if (isReceiptDebugEnabled()) {
      // eslint-disable-next-line no-console -- opt-in diagnostic
      console.debug(
        `[motebit/crypto] verifyToolInvocationReceipt EARLY_RETURN suite_mismatch actual=${JSON.stringify(receipt.suite)} expected=${JSON.stringify(TOOL_INVOCATION_RECEIPT_SUITE)}`,
      );
    }
    return false;
  }
  const { signature, ...body } = receipt;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);

  let valid = false;
  try {
    const sig = fromBase64Url(signature);
    valid = await verifyBySuite(receipt.suite, message, sig, publicKey);
  } catch {
    valid = false;
  }

  if (isReceiptDebugEnabled()) {
    const sha = await canonicalSha256(body);
    // eslint-disable-next-line no-console -- opt-in diagnostic, off by default
    console.debug(
      `[motebit/crypto] verifyToolInvocationReceipt canonical_sha256=${sha} valid=${valid} bytes=${canonical.length}`,
    );
  }

  return valid;
}

// === Computer-Session Receipts (v1.5) ===
//
// Sibling of ToolInvocationReceipt. Same JCS+Ed25519+base64url
// pattern; same fail-closed verifier rules. The wire-format type
// (`ComputerSessionReceipt`) lives in `@motebit/protocol`'s
// `computer-use.ts`. The runtime composes the unsigned body via
// `ComputerSessionManager.summarize(...)` and hands it to
// `signComputerSessionReceipt` here.

import type {
  SignableComputerSessionReceipt,
  ComputerSessionActionRecord,
  SettlementAsset,
} from "@motebit/protocol";

/** The one suite ComputerSessionReceipts sign under today. */
export const COMPUTER_SESSION_RECEIPT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Compute the `actions_hash` for a computer-session receipt — JCS-
 * canonicalize the per-action structural roll-up, SHA-256 the UTF-8
 * bytes, return hex. Use on both sides of the wire: the signer
 * computes at session-close time; verifiers with the per-action
 * records recompute and match.
 *
 * The actions array MUST be in dispatch order — different orderings
 * produce different hashes by construction. The signer is the source
 * of truth for ordering; verifiers replaying from per-action receipts
 * sort by `started_at` ascending (ties broken by `completed_at`).
 */
export async function hashComputerSessionActions(
  actions: ReadonlyArray<ComputerSessionActionRecord>,
): Promise<string> {
  return canonicalSha256(actions);
}

/**
 * Sign a computer-session receipt. Mirrors `signToolInvocationReceipt`:
 * stamps the cryptosuite into the body, canonicalizes with JCS,
 * dispatches through `signBySuite`, and encodes as base64url.
 *
 * Caller passes the body without `signature` or `suite`; the signer
 * owns both. Embeds the public key (hex) so the receipt is
 * independently verifiable with no relay lookup.
 */
export async function signComputerSessionReceipt<
  T extends Omit<SignableComputerSessionReceipt, "public_key"> & { public_key?: string },
>(
  receipt: T,
  privateKey: Uint8Array,
  publicKey?: Uint8Array,
): Promise<T & { suite: typeof COMPUTER_SESSION_RECEIPT_SUITE; signature: string }> {
  const withKey = publicKey ? { ...receipt, public_key: bytesToHex(publicKey) } : receipt;
  const body = { ...withKey, suite: COMPUTER_SESSION_RECEIPT_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(COMPUTER_SESSION_RECEIPT_SUITE, message, privateKey);
  const signed = { ...body, signature: toBase64Url(sig) } as T & {
    suite: typeof COMPUTER_SESSION_RECEIPT_SUITE;
    signature: string;
  };

  if (isReceiptDebugEnabled()) {
    const sha = await canonicalSha256(body);
    // eslint-disable-next-line no-console -- opt-in diagnostic, off by default
    console.debug(
      `[motebit/crypto] signComputerSessionReceipt canonical_sha256=${sha} session=${
        (body as Record<string, unknown>).session_id as string
      } actions=${(body as Record<string, unknown>).action_count as number} bytes=${canonical.length}`,
    );
  }

  return Object.freeze(signed);
}

/**
 * Verify a computer-session receipt. Fails closed on unknown suite,
 * bad base64, or signature mismatch — same rules as
 * `verifyToolInvocationReceipt`. Caller passes the receipt verbatim
 * (with signature) and the signer's public key; on success the
 * structural body is committed to as-signed.
 */
export async function verifyComputerSessionReceipt(
  receipt: SignableComputerSessionReceipt & { suite: string; signature: string },
  publicKey: Uint8Array,
): Promise<boolean> {
  if (receipt.suite !== COMPUTER_SESSION_RECEIPT_SUITE) {
    if (isReceiptDebugEnabled()) {
      // eslint-disable-next-line no-console -- opt-in diagnostic
      console.debug(
        `[motebit/crypto] verifyComputerSessionReceipt EARLY_RETURN suite_mismatch actual=${JSON.stringify(receipt.suite)} expected=${JSON.stringify(COMPUTER_SESSION_RECEIPT_SUITE)}`,
      );
    }
    return false;
  }
  const { signature, ...body } = receipt;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);

  let valid = false;
  try {
    const sig = fromBase64Url(signature);
    valid = await verifyBySuite(receipt.suite, message, sig, publicKey);
  } catch {
    valid = false;
  }

  if (isReceiptDebugEnabled()) {
    const sha = await canonicalSha256(body);
    // eslint-disable-next-line no-console -- opt-in diagnostic
    console.debug(
      `[motebit/crypto] verifyComputerSessionReceipt canonical_sha256=${sha} valid=${valid} bytes=${canonical.length}`,
    );
  }

  return valid;
}

// === Sovereign Payment Receipts ===

/**
 * Inputs for a sovereign payment receipt — produced by the *payee* when
 * a counterparty pays them directly via an onchain wallet rail (Solana,
 * future Aptos/Sui), bypassing the relay's settlement gate.
 *
 * The receipt is structurally an `ExecutionReceipt` with:
 *   - `task_id` formatted as `{rail}:tx:{txHash}` so the trust signal
 *     anchors to a specific, globally unique onchain payment.
 *   - `relay_task_id` left undefined (the field is optional precisely
 *     for non-relay execution paths — see protocol/index.ts).
 *   - All cryptography identical to relay-mediated receipts: same
 *     canonical JSON, same Ed25519 sign/verify, same trust ingestion.
 */
export interface SovereignPaymentReceiptInput {
  /** The payee's motebit ID (the worker who is signing this receipt). */
  payee_motebit_id: string;
  /** The payee's device ID. */
  payee_device_id: string;
  /** The payer's motebit ID — recorded in `result` for downstream audit. */
  payer_motebit_id: string;
  /** Onchain payment proof: rail name (e.g., "solana") + transaction signature. */
  rail: string;
  tx_hash: string;
  /** Payment amount in micro-units (6 decimals for USDC). */
  amount_micro: bigint;
  /**
   * Settlement asset this payment cleared in. Closed union — see
   * `SettlementAsset` in `@motebit/protocol`. The value is embedded in
   * the signed receipt's `result` string and is therefore part of the
   * canonical-JSON-signed payload; tightening the input type forces
   * every signer to provide a registered asset before the receipt can
   * be produced.
   */
  asset: SettlementAsset;
  /** Brief human-readable description of the service rendered. */
  service_description: string;
  /** SHA-256 hash of the request payload. */
  prompt_hash: string;
  /** SHA-256 hash of the result payload. */
  result_hash: string;
  /** Tools the payee used to deliver the service. Empty array if pure payment ack. */
  tools_used?: string[];
  /** When the payee accepted the request. */
  submitted_at: number;
  /** When the payee completed the work. */
  completed_at: number;
}

/**
 * Construct, canonicalize, and sign a sovereign payment receipt with
 * the payee's Ed25519 identity key. Returns a fully-formed
 * `ExecutionReceipt` that can be passed to any standard verifier and
 * fed into `bumpTrustFromReceipt` on the payer's runtime.
 *
 * No relay is contacted at any point. The resulting receipt is
 * self-verifiable forever from the embedded `public_key` field.
 */
export async function signSovereignPaymentReceipt(
  input: SovereignPaymentReceiptInput,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<SignableReceipt> {
  const receipt: Omit<SignableReceipt, "signature" | "suite"> = {
    task_id: `${input.rail}:tx:${input.tx_hash}`,
    motebit_id: input.payee_motebit_id,
    device_id: input.payee_device_id,
    submitted_at: input.submitted_at,
    completed_at: input.completed_at,
    status: "completed",
    result: `${input.service_description} | paid by ${input.payer_motebit_id}: ${input.amount_micro.toString()} micro-${input.asset} via ${input.rail}`,
    tools_used: input.tools_used ?? [],
    memories_formed: 0,
    prompt_hash: input.prompt_hash,
    result_hash: input.result_hash,
    // relay_task_id intentionally omitted — sovereign rail, no relay binding
    // suite is stamped by signExecutionReceipt
  };
  return signExecutionReceipt(receipt, privateKey, publicKey);
}

// === Receipt Chain Verification ===

export interface ReceiptVerification {
  task_id: string;
  motebit_id: string;
  verified: boolean;
  /**
   * Where the verifying key came from. `"external"` = resolved from the
   * caller's `knownKeys` map, so identity binding is established by the
   * caller's trusted source. `"embedded"` = fell back to the receipt's own
   * `public_key`, which proves the bytes are internally consistent but NOT
   * that the key belongs to `motebit_id` — a forged receipt can embed any
   * key and still report `verified: true`. Only `"external"` establishes
   * binding. Absent when no key was resolved (`verified: false`,
   * `error: "unknown motebit_id"`). Callers MUST NOT present an `"embedded"`
   * result as proof of identity.
   */
  keySource?: "external" | "embedded";
  error?: string;
  delegations: ReceiptVerification[];
}

/**
 * Known public keys map: motebit_id → Uint8Array public key.
 * Used to look up the correct key for each receipt in the chain.
 */
export type KnownKeys = Map<string, Uint8Array>;

/**
 * Recursively verify an execution receipt and all its delegation receipts.
 * Each receipt is verified against the public key found in `knownKeys` for its `motebit_id`.
 * Returns a tree of verification results mirroring the delegation structure.
 */
export async function verifyReceiptChain(
  receipt: SignableReceipt,
  knownKeys: KnownKeys,
): Promise<ReceiptVerification> {
  const { task_id, motebit_id } = receipt;

  // Resolve the verifying key. Prefer the caller's trusted `knownKeys` map
  // (establishes identity binding); fall back to the receipt's own embedded
  // `public_key` (proves byte-integrity only — NOT that the key belongs to
  // `motebit_id`). `keySource` records which, so callers never mistake an
  // envelope-asserted key for an externally-bound identity.
  let publicKey = knownKeys.get(motebit_id);
  let keySource: "external" | "embedded";
  if (publicKey) {
    keySource = "external";
  } else if (receipt.public_key) {
    publicKey = hexToBytes(receipt.public_key);
    keySource = "embedded";
  } else {
    const delegations = await verifyDelegations(receipt, knownKeys);
    return { task_id, motebit_id, verified: false, error: "unknown motebit_id", delegations };
  }

  let verified: boolean;
  let error: string | undefined;
  try {
    verified = await verifyExecutionReceipt(receipt, publicKey);
  } catch (err: unknown) {
    /* v8 ignore next 3 */
    verified = false;
    error = err instanceof Error ? err.message : String(err);
  }

  const delegations = await verifyDelegations(receipt, knownKeys);

  const result: ReceiptVerification = {
    task_id,
    motebit_id,
    verified,
    keySource,
    delegations,
  };
  if (error) {
    /* v8 ignore next */
    result.error = error;
  }
  return result;
}

async function verifyDelegations(
  receipt: SignableReceipt,
  knownKeys: KnownKeys,
): Promise<ReceiptVerification[]> {
  if (!receipt.delegation_receipts || receipt.delegation_receipts.length === 0) {
    return [];
  }
  return Promise.all(receipt.delegation_receipts.map((dr) => verifyReceiptChain(dr, knownKeys)));
}

// === Receipt Sequence Verification ===

export interface ReceiptChainEntry {
  receipt: SignableReceipt;
  signer_public_key: Uint8Array;
}

/**
 * Verify a flat sequence of execution receipts.
 *
 * A valid sequence means:
 * 1. Each receipt's signature is valid against its signer's public key.
 * 2. Adjacent receipts are temporally ordered: receipt[i].completed_at <= receipt[i+1].submitted_at.
 *
 * An empty sequence is considered valid.
 * Use `verifyReceiptChain` for nested/tree-structured delegation receipts.
 */
export async function verifyReceiptSequence(
  chain: ReceiptChainEntry[],
): Promise<{ valid: boolean; error?: string; index?: number }> {
  if (chain.length === 0) return { valid: true };

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]!;
    const sigValid = await verifyExecutionReceipt(entry.receipt, entry.signer_public_key);
    if (!sigValid) {
      return { valid: false, error: `Receipt ${i} has invalid signature`, index: i };
    }
  }

  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1]!;
    const curr = chain[i]!;
    if (prev.receipt.completed_at > curr.receipt.submitted_at) {
      return {
        valid: false,
        error: `Receipt ${i} submitted_at (${curr.receipt.submitted_at}) is before receipt ${i - 1} completed_at (${prev.receipt.completed_at})`,
        index: i,
      };
    }
  }

  return { valid: true };
}

// === Delegation Tokens ===

/**
 * Re-export `DelegationToken` from the canonical protocol type package.
 * The interface body lives in `@motebit/protocol` because `DelegationToken`
 * is a wire-format type (per the synchronization-invariant doctrine,
 * every spec-declared wire type must be exported from `@motebit/protocol`).
 *
 * Two statements so check-deps sees the `import type` prefix on the one
 * line that references another workspace package — a bare
 * `export type { X } from "..."` is technically type-only by TypeScript
 * semantics, but the drift probe's regex only recognizes `import type`.
 */
import type {
  DelegationToken,
  StandingDelegation,
  DelegationRevocation,
  SubjectBindingV1,
} from "@motebit/protocol";
export type { DelegationToken, StandingDelegation, DelegationRevocation, SubjectBindingV1 };

/** The one suite DelegationTokens sign under today. */
export const DELEGATION_TOKEN_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a delegation token. The delegator authorizes the delegate to act
 * within the given scope. Stamps the cryptosuite into the signed body,
 * dispatches the primitive signature through `signBySuite`.
 *
 * Callers pass the token without `signature` or `suite`; the signer owns
 * both. Public keys must already be hex-encoded — this signer does not
 * transcode, so the input carries the same encoding the output will.
 */
export async function signDelegation(
  delegation: Omit<DelegationToken, "signature" | "suite">,
  delegatorPrivateKey: Uint8Array,
): Promise<DelegationToken> {
  const body = { ...delegation, suite: DELEGATION_TOKEN_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(DELEGATION_TOKEN_SUITE, message, delegatorPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a delegation token's signature and (optionally) expiration.
 *
 * Rejects fail-closed on:
 *   - missing or unknown `suite` value (anything other than `DELEGATION_TOKEN_SUITE`)
 *   - expired token (unless `options.checkExpiry === false`)
 *   - malformed hex public key or base64url signature
 *   - primitive-level verification failure
 *
 * @param delegation - The delegation token to verify
 * @param options.checkExpiry - If true (default), reject expired tokens. Pass false
 *   only when verifying historical chains where expiration is irrelevant.
 * @param options.now - Current time in ms (default: Date.now()). For testing.
 */
export async function verifyDelegation(
  delegation: DelegationToken,
  options?: { checkExpiry?: boolean; now?: number },
): Promise<boolean> {
  if (delegation.suite !== DELEGATION_TOKEN_SUITE) return false;

  const checkExpiry = options?.checkExpiry ?? true;
  if (checkExpiry) {
    const now = options?.now ?? Date.now();
    if (delegation.expires_at < now) return false;
    // Activation time: a pre-minted future-slot tick must not verify before its
    // slot (standing-delegation@1.0 §3). Absent ⇒ active from issued_at. Gated
    // under checkExpiry so historical chain verification skips it like expiry.
    if (delegation.not_before !== undefined && now < delegation.not_before) return false;
  }

  const { signature, ...body } = delegation;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const pubKey = hexToBytes(delegation.delegator_public_key);
    const sig = fromBase64Url(signature);
    return await verifyBySuite(delegation.suite, message, sig, pubKey);
  } catch {
    return false;
  }
}

/**
 * Verify a chain of delegation tokens.
 *
 * A valid chain means:
 * 1. Each delegation's signature is valid (signed by the delegator's key).
 * 2. Adjacent delegations are linked: delegation[i].delegate_id === delegation[i+1].delegator_id
 *    and delegation[i].delegate_public_key === delegation[i+1].delegator_public_key.
 *
 * An empty chain is considered valid (no delegations to verify).
 */
export async function verifyDelegationChain(
  chain: DelegationToken[],
): Promise<{ valid: boolean; error?: string }> {
  if (chain.length === 0) return { valid: true };

  for (let i = 0; i < chain.length; i++) {
    const delegation = chain[i]!;
    // Chain verification is historical — don't reject expired tokens in the chain
    const sigValid = await verifyDelegation(delegation, { checkExpiry: false });
    if (!sigValid) {
      return { valid: false, error: `Delegation ${i} has invalid signature` };
    }

    if (i > 0) {
      const prev = chain[i - 1]!;
      if (prev.delegate_id !== delegation.delegator_id) {
        return {
          valid: false,
          error: `Chain break at ${i}: delegate_id "${prev.delegate_id}" !== delegator_id "${delegation.delegator_id}"`,
        };
      }
      if (prev.delegate_public_key !== delegation.delegator_public_key) {
        return {
          valid: false,
          error: `Chain break at ${i}: delegate_public_key mismatch`,
        };
      }
      // Scope narrowing: each delegation must not widen scope beyond its parent
      if (!isScopeNarrowed(prev.scope, delegation.scope)) {
        return {
          valid: false,
          error: `Delegation ${i} widens scope: parent="${prev.scope}", child="${delegation.scope}"`,
        };
      }
    }
  }

  return { valid: true };
}

// === Standing Delegation (standing-delegation@1.0) ===
//
// A standing grant authorizes minting short-lived per-tick DelegationTokens
// within a fixed scope ceiling and cadence, for a long-but-finite revocable
// lifetime. Same suite + JCS + Ed25519 + base64url-sig conventions as
// `signDelegation`; self-verifiable per crypto rule 4 (third party verifies
// with this package + the signer's public key, no relay contact).

/** Sign a `StandingDelegation` grant with the delegator's private key. */
export async function signStandingDelegation(
  grant: Omit<StandingDelegation, "signature" | "suite">,
  delegatorPrivateKey: Uint8Array,
): Promise<StandingDelegation> {
  const body = { ...grant, suite: DELEGATION_TOKEN_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(DELEGATION_TOKEN_SUITE, message, delegatorPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a `StandingDelegation`'s INTRINSIC validity: suite, signature (against
 * `delegator_public_key`), activation (`not_before`), and expiry.
 *
 * REVOCATION IS NOT CHECKED unless you wire the `isRevoked` seam. This function
 * is I/O-free by contract — it cannot fetch the revocation feed — so revocation
 * is the caller's responsibility. **Omitting `isRevoked` means a revoked grant
 * verifies as valid.** A complete verification (per spec/standing-delegation-v1
 * §3.1, item 4) MUST include the revocation check: precompute the revoked set
 * with `findGrantRevocation`, then pass a `(grant_id) => boolean` lookup.
 *
 * Fail-closed on: unknown suite, malformed key/sig, primitive failure, not-yet-
 * active, expired (unless `checkExpiry === false`), and — when wired — revoked.
 *
 * @param options.isRevoked - Injected revocation lookup (the I/O-free seam,
 *   mirroring `isAgentRevoked`). Build it from the signed revocation feed via
 *   `findGrantRevocation`. Omit ⇒ revocation NOT checked (see above).
 */
export async function verifyStandingDelegation(
  grant: StandingDelegation,
  options?: { checkExpiry?: boolean; now?: number; isRevoked?: (grantId: string) => boolean },
): Promise<boolean> {
  if (grant.suite !== DELEGATION_TOKEN_SUITE) return false;

  const now = options?.now ?? Date.now();
  if (grant.not_before != null && now < grant.not_before) return false;
  const checkExpiry = options?.checkExpiry ?? true;
  if (checkExpiry && grant.expires_at < now) return false;
  if (options?.isRevoked?.(grant.grant_id) === true) return false;

  const { signature, ...body } = grant;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const pubKey = hexToBytes(grant.delegator_public_key);
    const sig = fromBase64Url(signature);
    return await verifyBySuite(grant.suite, message, sig, pubKey);
  } catch {
    return false;
  }
}

/**
 * Compute the canonical digest of a detached subject-scope artifact, for a
 * a `SubjectBindingV1.digest`. `jcs-sha256-hex`:
 * `hex(SHA-256(canonicalJson(artifact)))` — the same primitive as
 * `SignedRequestEnvelope.payload_digest`. The artifact MUST carry its own
 * `schema` tag; the typed parameter is the blessed-helper guard against
 * accidentally digesting an arbitrary/wrong-shaped object.
 */
export async function subjectBindingDigest(artifact: { schema: string }): Promise<string> {
  return canonicalSha256(artifact);
}

/**
 * Verify a presented detached artifact matches a grant's `subject_binding`,
 * fail-closed. Checks, in order: (1) `digest_method` is the one supported value;
 * (2) the artifact's own `schema` equals `binding.artifact_schema` (so a
 * different artifact type cannot be substituted under the bound digest);
 * (3) the recomputed digest equals `binding.digest`.
 *
 * This is the binding-MATCH check — separate from `verifyStandingDelegation`,
 * which proves the grant (and therefore the bound digest) is delegator-signed.
 * Compose both: verify the grant, then verify the artifact matches the signed
 * digest. AUTHORITY-only: it does NOT enforce subject COMPLETENESS ("every
 * signed subject was attempted") — that is a monitor receipt-profile rule built
 * on top, never a property of the generic binding.
 */
export async function verifySubjectBinding(
  binding: SubjectBindingV1,
  artifact: { schema: string },
): Promise<{ valid: boolean; error?: string }> {
  // `digest_method` is typed as the one literal, but the value arrives over the
  // wire — treat it as untrusted and fail closed on anything else.
  if ((binding.digest_method as string) !== "jcs-sha256-hex") {
    return { valid: false, error: `unsupported digest_method: ${String(binding.digest_method)}` };
  }
  if (artifact.schema !== binding.artifact_schema) {
    return {
      valid: false,
      error: `artifact schema "${artifact.schema}" != binding artifact_schema "${binding.artifact_schema}"`,
    };
  }
  const recomputed = await subjectBindingDigest(artifact);
  if (recomputed !== binding.digest) {
    return { valid: false, error: "digest mismatch — presented artifact is not the bound scope" };
  }
  return { valid: true };
}

/**
 * Verify a per-tick `DelegationToken` against its `StandingDelegation`.
 *
 * A token is a valid tick of a grant iff ALL hold:
 *   1. the token's own signature + expiry verify (`verifyDelegation`),
 *   2. `token.grant_id === grant.grant_id`,
 *   3. the grant verifies (signature, active, not expired, not revoked),
 *   4. the parties match (both delegator AND delegate id + key equal the grant's),
 *   5. the token's scope narrows within the grant's ceiling,
 *   6. the token's TTL does not exceed `grant.max_token_ttl_ms`.
 *
 * Cadence (the minimum interval between ticks) is NOT checked here — it is a
 * mint-time / relay-side rate limit, not derivable from a single token. Returns
 * `{ valid, error? }` for debuggability.
 */
export async function verifyTokenAgainstGrant(
  token: DelegationToken,
  grant: StandingDelegation,
  options?: { now?: number; isRevoked?: (grantId: string) => boolean },
): Promise<{ valid: boolean; error?: string }> {
  const now = options?.now ?? Date.now();

  if (!(await verifyDelegation(token, { now }))) {
    return { valid: false, error: "token signature or expiry invalid" };
  }
  if (token.grant_id !== grant.grant_id) {
    return { valid: false, error: "token.grant_id does not match grant" };
  }
  if (!(await verifyStandingDelegation(grant, { now, isRevoked: options?.isRevoked }))) {
    return { valid: false, error: "grant invalid, expired, or revoked" };
  }
  if (
    token.delegator_id !== grant.delegator_id ||
    token.delegator_public_key !== grant.delegator_public_key ||
    token.delegate_id !== grant.delegate_id ||
    token.delegate_public_key !== grant.delegate_public_key
  ) {
    return { valid: false, error: "token parties do not match grant" };
  }
  if (!isScopeNarrowed(grant.scope, token.scope)) {
    return {
      valid: false,
      error: `token widens scope beyond grant: grant="${grant.scope}", token="${token.scope}"`,
    };
  }
  if (token.expires_at - token.issued_at > grant.max_token_ttl_ms) {
    return { valid: false, error: "token TTL exceeds grant.max_token_ttl_ms" };
  }
  return { valid: true };
}

/** Sign a `DelegationRevocation`. Only the grant's delegator may sign one. */
export async function signDelegationRevocation(
  revocation: Omit<DelegationRevocation, "signature" | "suite">,
  delegatorPrivateKey: Uint8Array,
): Promise<DelegationRevocation> {
  const body = { ...revocation, suite: DELEGATION_TOKEN_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(DELEGATION_TOKEN_SUITE, message, delegatorPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a `DelegationRevocation`'s signature (against its own
 * `delegator_public_key`). Fail-closed on unknown suite / malformed key+sig.
 *
 * NOTE: this proves the revocation is a well-formed signed statement. To accept
 * it as authority over a specific grant, the caller MUST also check that it
 * targets that grant and was signed by THAT grant's delegator — i.e.
 * `rev.grant_id === grant.grant_id && rev.delegator_public_key ===
 * grant.delegator_public_key`. (A revocation is only as authoritative as the
 * key matching the grant it claims to revoke.)
 */
export async function verifyDelegationRevocation(
  revocation: DelegationRevocation,
): Promise<boolean> {
  if (revocation.suite !== DELEGATION_TOKEN_SUITE) return false;
  const { signature, ...body } = revocation;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const pubKey = hexToBytes(revocation.delegator_public_key);
    const sig = fromBase64Url(signature);
    return await verifyBySuite(revocation.suite, message, sig, pubKey);
  } catch {
    return false;
  }
}

/**
 * The consumer-side revocation check, done correctly. Returns the revocation
 * that authoritatively revokes `grant` from a set of candidate revocations, or
 * `null` if none does.
 *
 * A `DelegationRevocation` is authoritative over a grant ONLY when it (1) targets
 * the grant's `grant_id`, (2) is signed by the grant's `delegator_public_key`,
 * and (3) its signature verifies (spec/standing-delegation-v1 §5). Matching
 * `grant_id` alone is the foot-gun — a revocation signed by any other key is not
 * authoritative and is ignored here. Use this to build the `isRevoked` seam for
 * `verifyStandingDelegation` / `verifyTokenAgainstGrant`: precompute the revoked
 * set once, then provide the sync lookup. Pure and offline — no relay contact.
 */
export async function findGrantRevocation(
  grant: Pick<StandingDelegation, "grant_id" | "delegator_public_key">,
  revocations: readonly DelegationRevocation[],
): Promise<DelegationRevocation | null> {
  for (const rev of revocations) {
    if (rev.grant_id !== grant.grant_id) continue;
    if (rev.delegator_public_key !== grant.delegator_public_key) continue;
    if (await verifyDelegationRevocation(rev)) return rev;
  }
  return null;
}

// === Signed Request Envelope (signed-request-envelope@1.0) ===
//
// Stateless request authentication from a registered identity: Ed25519 over
// canonicalJson(envelope minus signature), verified against the identity's
// REGISTERED public key — never a key the request carries. The payload travels
// detached, bound by `payload_digest = hex(SHA-256(canonicalJson(payload)))`.
// Same suite + JCS + base64url-sig conventions as the rest of the identity
// family; self-verifiable per crypto rule 4. Spec: signed-request-envelope-v1.

import type { SignedRequestEnvelope } from "@motebit/protocol";
export type { SignedRequestEnvelope };

/** The one suite a SignedRequestEnvelope signs under today. */
export const SIGNED_REQUEST_ENVELOPE_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a request envelope. Computes the payload digest, assembles the body
 * ({@link SignedRequestEnvelope} minus `signature`), and signs it. The caller
 * supplies the identity fields; the signer owns `payload_digest` and `suite`.
 */
export async function signRequestEnvelope(
  payload: unknown,
  fields: { motebit_id: string; ts: number; aud: string; nonce?: string },
  identityPrivateKey: Uint8Array,
): Promise<SignedRequestEnvelope> {
  const payload_digest = await canonicalSha256(payload);
  const body: Omit<SignedRequestEnvelope, "signature"> = {
    motebit_id: fields.motebit_id,
    ts: fields.ts,
    payload_digest,
    aud: fields.aud,
    ...(fields.nonce !== undefined ? { nonce: fields.nonce } : {}),
    suite: SIGNED_REQUEST_ENVELOPE_SUITE,
  };
  const message = new TextEncoder().encode(canonicalJson(body));
  const sig = await signBySuite(SIGNED_REQUEST_ENVELOPE_SUITE, message, identityPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a request envelope against the identity's REGISTERED public key —
 * the single trust move (a key carried by the request is never trusted, so the
 * caller MUST resolve `registeredPublicKey` from its registry by
 * `envelope.motebit_id`, never from the envelope).
 *
 * Always checks the suite + the signature. Freshness (`|now − ts| ≤ windowMs`)
 * is checked **by default** — `now` defaults to `Date.now()`, `windowMs` to
 * 300s — because a request-auth envelope verified without a freshness bound is a
 * forever replay window. Opt out explicitly with `checkFreshness: false` (e.g.
 * verifying a historical envelope), mirroring `verifyDelegation`'s `checkExpiry`.
 * Audience (exact-match) and the payload digest are checked when their option is
 * supplied. Nonce replay-dedup is stateful and stays the consumer's concern.
 * Fail-closed on unknown suite / malformed signature / staleness / any
 * supplied-check mismatch.
 */
export async function verifyRequestEnvelope(
  envelope: SignedRequestEnvelope,
  registeredPublicKey: Uint8Array,
  options?: {
    payload?: unknown;
    expectedAud?: string;
    checkFreshness?: boolean;
    now?: number;
    windowMs?: number;
  },
): Promise<boolean> {
  if (envelope.suite !== SIGNED_REQUEST_ENVELOPE_SUITE) return false;
  if (options?.expectedAud !== undefined && envelope.aud !== options.expectedAud) return false;
  // Freshness is fail-closed by default: a forever replay window is never a safe
  // default for request auth. Skip only when a consumer explicitly opts out.
  const checkFreshness = options?.checkFreshness ?? true;
  if (checkFreshness) {
    const now = options?.now ?? Date.now();
    const windowMs = options?.windowMs ?? 300_000;
    if (Math.abs(now - envelope.ts) > windowMs) return false;
  }
  if (options?.payload !== undefined) {
    const recomputed = await canonicalSha256(options.payload);
    if (recomputed !== envelope.payload_digest) return false;
  }

  const { signature, ...body } = envelope;
  const message = new TextEncoder().encode(canonicalJson(body));
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(envelope.suite, message, sig, registeredPublicKey);
  } catch {
    return false;
  }
}

// === Dispute Resolution + Adjudicator Votes (dispute §6.4 + §6.5) ===
// === Dispute Request / Evidence / Appeal (dispute §4.2 + §5.2 + §8.2) ===

// prettier-ignore
import type { AdjudicatorVote, DisputeAppeal, DisputeEvidence, DisputeRequest, DisputeResolution } from "@motebit/protocol";
export type { AdjudicatorVote, DisputeAppeal, DisputeEvidence, DisputeRequest, DisputeResolution };

/** The one suite AdjudicatorVotes sign under today — matches spec/dispute-v1.md §6.4. */
export const ADJUDICATOR_VOTE_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/** The one suite DisputeResolutions sign under today — matches spec/dispute-v1.md §6.4. */
export const DISPUTE_RESOLUTION_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/** The one suite DisputeRequest filings sign under today — spec/dispute-v1.md §4.2. */
export const DISPUTE_REQUEST_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/** The one suite DisputeEvidence submissions sign under today — spec/dispute-v1.md §5.2. */
export const DISPUTE_EVIDENCE_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/** The one suite DisputeAppeal filings sign under today — spec/dispute-v1.md §8.2. */
export const DISPUTE_APPEAL_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a federation peer's adjudication vote. The `dispute_id` IS part
 * of the signed body — spec §6.5 Foundation Law: "Each AdjudicatorVote
 * signature MUST cover its `dispute_id`. Votes are not portable across
 * disputes — a malicious adjudicator collecting old votes from other
 * disputes cannot stuff them into a new resolution because the
 * dispute_id binding breaks the signature."
 *
 * Callers pass the body without `signature` or `suite`; the signer owns
 * both.
 */
export async function signAdjudicatorVote(
  vote: Omit<AdjudicatorVote, "signature" | "suite">,
  peerPrivateKey: Uint8Array,
): Promise<AdjudicatorVote> {
  const body = { ...vote, suite: ADJUDICATOR_VOTE_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(ADJUDICATOR_VOTE_SUITE, message, peerPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify an adjudicator vote against the voting peer's public key.
 * Fail-closed on unknown suite, base64url decode error, and primitive
 * verification failure. Matching of `peer_id` to a legitimate federation
 * peer is the caller's responsibility (this function verifies the
 * signature; peer-membership is a trust decision).
 */
export async function verifyAdjudicatorVote(
  vote: AdjudicatorVote,
  peerPublicKey: Uint8Array,
): Promise<boolean> {
  if (vote.suite !== ADJUDICATOR_VOTE_SUITE) return false;
  const { signature, ...body } = vote;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(vote.suite, message, sig, peerPublicKey);
  } catch {
    return false;
  }
}

// === Approval Decisions (human-consent over a governance-gated tool call) ===

// prettier-ignore
import type { ApprovalDecision } from "@motebit/protocol";
export type { ApprovalDecision };

/** The one suite ApprovalDecisions sign under today. */
export const APPROVAL_DECISION_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a human-consent decision over a governance-gated tool call. Signed by
 * the APPROVER's key — consent is the approver's own assertion, the same way the
 * worker signs its own refusal. The `approval_id` (the gated call's
 * `tool_call_id`) and `args_hash` are part of the signed body, so a verdict is
 * non-portable: it cannot be replayed onto a different call or different args
 * without breaking the signature.
 *
 * Callers pass the body without `signature` or `suite`; the signer owns both.
 * When `publicKey` is supplied it is embedded as `public_key` (hex) so a third
 * party can verify offline without a separate key lookup — same portability
 * contract as `signExecutionReceipt`.
 */
export async function signApprovalDecision<T extends Omit<ApprovalDecision, "signature" | "suite">>(
  decision: T,
  approverPrivateKey: Uint8Array,
  publicKey?: Uint8Array,
): Promise<T & { suite: typeof APPROVAL_DECISION_SUITE; signature: string }> {
  const withKey = publicKey ? { ...decision, public_key: bytesToHex(publicKey) } : decision;
  const body = { ...withKey, suite: APPROVAL_DECISION_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(APPROVAL_DECISION_SUITE, message, approverPrivateKey);
  const signed = { ...body, signature: toBase64Url(sig) } as T & {
    suite: typeof APPROVAL_DECISION_SUITE;
    signature: string;
  };
  // Immutable evidence by contract — freeze so any post-sign mutation throws at
  // the producer rather than surfacing as wire corruption downstream.
  return Object.freeze(signed);
}

/**
 * Verify an approval decision against the approver's public key. Reconstructs
 * the canonical JSON from every field except `signature` (the suite IS part of
 * the signed body, so tampering with it breaks verification). Fail-closed on
 * unknown suite, base64url decode error, and primitive verification failure.
 */
export async function verifyApprovalDecision(
  decision: ApprovalDecision,
  approverPublicKey: Uint8Array,
): Promise<boolean> {
  if (decision.suite !== APPROVAL_DECISION_SUITE) return false;
  const { signature, ...body } = decision;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(decision.suite, message, sig, approverPublicKey);
  } catch {
    return false;
  }
}

/**
 * Sign a dispute resolution. For single-relay adjudication
 * (`adjudicator_votes: []`) the relay signs with its own identity key.
 * For federation resolutions, the leader collects signed
 * `AdjudicatorVote` entries, then signs the aggregate.
 *
 * Callers pass the body without `signature` or `suite`; the signer
 * owns both.
 *
 * Per spec §6.5 Foundation Law, a federation resolution MUST include
 * individual `AdjudicatorVote` entries — aggregated-only verdicts are
 * rejected. This signer does not enforce that at sign time (the
 * orchestrator decides whether federation is required); the verifier
 * re-checks every embedded vote signature when the array is non-empty.
 */
export async function signDisputeResolution(
  resolution: Omit<DisputeResolution, "signature" | "suite">,
  adjudicatorPrivateKey: Uint8Array,
): Promise<DisputeResolution> {
  const body = { ...resolution, suite: DISPUTE_RESOLUTION_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(DISPUTE_RESOLUTION_SUITE, message, adjudicatorPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a dispute resolution. Two layers:
 *   1. Outer signature verifies against `adjudicatorPublicKey`.
 *   2. When `adjudicator_votes.length > 0`, every embedded
 *      AdjudicatorVote's signature is re-checked against the
 *      corresponding `peerKeys` entry (lookup by `peer_id`). Per §6.5,
 *      aggregated-only verdicts without individual peer signatures are
 *      rejected — a missing peer key in the lookup is treated as a
 *      verification failure.
 *
 * Fail-closed on unknown suite, decode errors, primitive verification
 * failures, any missing peer key, and any invalid embedded vote.
 */
export async function verifyDisputeResolution(
  resolution: DisputeResolution,
  adjudicatorPublicKey: Uint8Array,
  peerKeys?: Map<string, Uint8Array>,
): Promise<boolean> {
  if (resolution.suite !== DISPUTE_RESOLUTION_SUITE) return false;
  const { signature, ...body } = resolution;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    const outerValid = await verifyBySuite(resolution.suite, message, sig, adjudicatorPublicKey);
    if (!outerValid) return false;
  } catch {
    return false;
  }

  // Federation resolutions must carry signed peer votes. Verify every
  // one against the caller-supplied peer-key map. Missing map or
  // missing peer entry is a verification failure, not a pass-through.
  if (resolution.adjudicator_votes.length > 0) {
    if (!peerKeys) return false;
    for (const vote of resolution.adjudicator_votes) {
      if (vote.dispute_id !== resolution.dispute_id) return false;
      const peerKey = peerKeys.get(vote.peer_id);
      if (!peerKey) return false;
      const voteValid = await verifyAdjudicatorVote(vote, peerKey);
      if (!voteValid) return false;
    }
  }
  return true;
}

/**
 * Sign a DisputeRequest. Filing party signs over canonical JSON of
 * every field except `signature`. The relay verifies against the
 * filer's registered public key before accepting the filing — without
 * the signature, anyone could file a dispute as anyone (foundation
 * law §4.4: filing party must be a direct party to the task; without
 * the signature binding, the relay cannot enforce that). Callers pass
 * the body without `signature` or `suite`; the signer owns both.
 */
export async function signDisputeRequest(
  request: Omit<DisputeRequest, "signature" | "suite">,
  filerPrivateKey: Uint8Array,
): Promise<DisputeRequest> {
  const body = { ...request, suite: DISPUTE_REQUEST_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(DISPUTE_REQUEST_SUITE, message, filerPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a DisputeRequest against the filing party's public key.
 * Fail-closed on unknown suite, base64url decode error, and primitive
 * verification failure. Eligibility checks (`filed_by` is a real party
 * to `task_id`, trust threshold, evidence_refs non-empty) are the
 * caller's responsibility — this verifies the signature only.
 */
export async function verifyDisputeRequest(
  request: DisputeRequest,
  filerPublicKey: Uint8Array,
): Promise<boolean> {
  if (request.suite !== DISPUTE_REQUEST_SUITE) return false;
  const { signature, ...body } = request;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(request.suite, message, sig, filerPublicKey);
  } catch {
    return false;
  }
}

// === Commitment Bonds (anti-sybil staked signal — docs/doctrine/commitment-bond.md) ===

// prettier-ignore
import type { BondCommitment } from "@motebit/protocol";
export type { BondCommitment };

/** The one suite BondCommitments sign under today — spec/bond-v1.md §4. */
export const BOND_COMMITMENT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a commitment bond. The bond is **self-signed by the bonded public key**
 * — the agent's own identity key, whose base58btc encoding IS `bonded_address`.
 * Signing with that key proves control of the address the bond names. Callers
 * pass the body without `signature` or `suite`; the signer owns both.
 *
 * The caller is responsible for passing a `commitment` whose `bonded_address`
 * already equals `deriveSolanaAddress(bonded_public_key)`; `verifyBondCommitment`
 * rejects a mismatch, so signing one is producing an unverifiable bond.
 */
export async function signBondCommitment(
  commitment: Omit<BondCommitment, "signature" | "suite">,
  bondedPrivateKey: Uint8Array,
): Promise<BondCommitment> {
  const body = { ...commitment, suite: BOND_COMMITMENT_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(BOND_COMMITMENT_SUITE, message, bondedPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a commitment bond. Two checks, both fail-closed:
 *
 *   1. **The anti-sybil address binding (the whole justification).**
 *      `bonded_address` MUST equal `base58btcEncode(bonded_public_key)` — the
 *      Solana address derivation. A bond whose backing address is not the
 *      agent's OWN sovereign identity address is rejected, so one wallet cannot
 *      back many identities (each identity's address is distinct and must
 *      independently hold the capital). `check-bond-address-binding` locks that
 *      this check cannot be silently removed.
 *   2. **The self-signature.** The bond is signed by `bonded_public_key`, which
 *      (by check 1) IS the bonded address — proving control of the address it
 *      names. No external key argument: the key is embedded and self-anchoring.
 *
 * This verifies the artifact STANDALONE. It does NOT bind the bond to a claimed
 * `motebit_id` (that the `bonded_public_key` is the registry key for
 * `commitment.motebit_id`) — that key→id check is the verifying relay's
 * separate responsibility (the `verifySovereignBinding` shape), exactly as
 * other verifiers leave party-membership to the caller. And it does NOT prove
 * the address is solvent NOW — backing is the relay's live RPC read.
 *
 * Fail-closed on unknown suite, malformed hex key, wrong key length, a broken
 * address binding, base64url decode error, and primitive verification failure.
 */
export async function verifyBondCommitment(commitment: BondCommitment): Promise<boolean> {
  if (commitment.suite !== BOND_COMMITMENT_SUITE) return false;

  let bondedKey: Uint8Array;
  try {
    bondedKey = hexToBytes(commitment.bonded_public_key);
  } catch {
    return false;
  }
  // A Solana address is base58btc of the 32-byte Ed25519 public key. Anything
  // else cannot be a sovereign identity address.
  if (bondedKey.length !== 32) return false;
  // THE ANTI-SYBIL BINDING — bonded_address must be the agent's OWN sovereign
  // address (see check-bond-address-binding).
  if (commitment.bonded_address !== base58btcEncode(bondedKey)) return false;

  const { signature, ...body } = commitment;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(commitment.suite, message, sig, bondedKey);
  } catch {
    return false;
  }
}

/**
 * Sign a DisputeEvidence submission. The submitting party — either
 * the dispute's filer or respondent — signs over the canonical JSON
 * of every field except `signature`. The relay verifies against the
 * submitter's registered public key (foundation law §5.4: evidence
 * must be cryptographically verifiable; unsigned/tampered evidence
 * is rejected).
 */
export async function signDisputeEvidence(
  evidence: Omit<DisputeEvidence, "signature" | "suite">,
  submitterPrivateKey: Uint8Array,
): Promise<DisputeEvidence> {
  const body = { ...evidence, suite: DISPUTE_EVIDENCE_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(DISPUTE_EVIDENCE_SUITE, message, submitterPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a DisputeEvidence submission against the submitting party's
 * public key. Inner `evidence_data` validation against its own per-
 * type schema (e.g. ExecutionReceiptSchema for `execution_receipt`)
 * is the adjudicator's responsibility — this verifies the outer
 * envelope signature only.
 */
export async function verifyDisputeEvidence(
  evidence: DisputeEvidence,
  submitterPublicKey: Uint8Array,
): Promise<boolean> {
  if (evidence.suite !== DISPUTE_EVIDENCE_SUITE) return false;
  const { signature, ...body } = evidence;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(evidence.suite, message, sig, submitterPublicKey);
  } catch {
    return false;
  }
}

/**
 * Sign a DisputeAppeal. The appealing party — filer or respondent —
 * signs over the canonical JSON of every field except `signature`.
 * Foundation law §8.4: one appeal per dispute; the post-appeal state
 * is terminal. The relay verifies against the appealer's registered
 * public key before transitioning the dispute to `appealed`.
 */
export async function signDisputeAppeal(
  appeal: Omit<DisputeAppeal, "signature" | "suite">,
  appealerPrivateKey: Uint8Array,
): Promise<DisputeAppeal> {
  const body = { ...appeal, suite: DISPUTE_APPEAL_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(DISPUTE_APPEAL_SUITE, message, appealerPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a DisputeAppeal against the appealing party's public key.
 * Fail-closed on unknown suite, base64url decode error, and primitive
 * verification failure.
 */
export async function verifyDisputeAppeal(
  appeal: DisputeAppeal,
  appealerPublicKey: Uint8Array,
): Promise<boolean> {
  if (appeal.suite !== DISPUTE_APPEAL_SUITE) return false;
  const { signature, ...body } = appeal;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(appeal.suite, message, sig, appealerPublicKey);
  } catch {
    return false;
  }
}

// === Consolidation Receipts (proactive interior — `docs/doctrine/proactive-interior.md`) ===

import type { ConsolidationReceipt } from "@motebit/protocol";
export type { ConsolidationReceipt };

/** The one suite ConsolidationReceipts sign under today. */
export const CONSOLIDATION_RECEIPT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a consolidation receipt. The motebit's Ed25519 identity key
 * commits to the structural counts of work performed during a
 * consolidation cycle. Receipt is self-attesting: any holder of the
 * signer's public key verifies without contacting any relay.
 *
 * Callers pass the body without `signature` or `suite`; the signer
 * owns both. Pass `publicKey` to embed it in the receipt for portable
 * verification (recommended — third parties verify from the receipt
 * alone).
 *
 * The signed receipt is `Object.freeze`d before return so any
 * post-sign mutation throws synchronously at the producer instead of
 * surfacing as wire-corruption noise on a downstream verifier.
 */
export async function signConsolidationReceipt(
  receipt: Omit<ConsolidationReceipt, "signature" | "suite" | "public_key">,
  privateKey: Uint8Array,
  publicKey?: Uint8Array,
): Promise<ConsolidationReceipt> {
  const withKey: Omit<ConsolidationReceipt, "signature" | "suite"> = publicKey
    ? { ...receipt, public_key: bytesToHex(publicKey) }
    : receipt;
  const body = { ...withKey, suite: CONSOLIDATION_RECEIPT_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(CONSOLIDATION_RECEIPT_SUITE, message, privateKey);
  return Object.freeze({ ...body, signature: toBase64Url(sig) });
}

/**
 * Verify a consolidation receipt against the signer's public key.
 * Fail-closed on unknown `suite`, base64url decode error, primitive
 * verification failure. The caller is responsible for matching
 * `motebit_id` to whoever they expect signed; the cryptographic
 * property here is "this body was signed by the holder of this key."
 */
export async function verifyConsolidationReceipt(
  receipt: ConsolidationReceipt,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (receipt.suite !== CONSOLIDATION_RECEIPT_SUITE) return false;
  const { signature, ...body } = receipt;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(receipt.suite, message, sig, publicKey);
  } catch {
    return false;
  }
}

// === Consolidation Mutation Manifest (felt-interior) ===

import type { ConsolidationMutationManifest } from "@motebit/protocol";
export type { ConsolidationMutationManifest };

/** Same JCS+Ed25519+b64 recipe as the receipt; domain separation is the
 *  `artifact_type` in the signed body, so a receipt signature can never
 *  verify as a manifest. No fresh SuiteId is minted. */
export const CONSOLIDATION_MUTATION_MANIFEST_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/** Canonical SHA-256 (hex) of a signed `ConsolidationReceipt` — the value a
 *  manifest's `receipt_digest` binds to. Producer and verifier MUST use this
 *  exact function so the link is reproducible. */
export async function consolidationReceiptDigest(receipt: ConsolidationReceipt): Promise<string> {
  return canonicalSha256(receipt);
}

/** SHA-256 (hex) of a memory node's content — the value a commitment's
 *  `content_sha256` binds to. Shared so producer and verifier never drift. */
export async function consolidationContentDigest(content: string): Promise<string> {
  return hash(new TextEncoder().encode(content));
}

/**
 * Sign a consolidation mutation manifest — the owner-facing adjunct that
 * commits to the exact formed/refined mutations of a cycle, joined to its
 * counts-only receipt by id + digest (spec/consolidation-mutation-manifest-v1.md).
 * Callers pass the body without `signature`/`suite`; the signer stamps both
 * and embeds `public_key` for portable verification. `mutations` MUST already
 * be sorted by `node_id` so the canonical form is deterministic.
 */
export async function signConsolidationMutationManifest(
  manifest: Omit<ConsolidationMutationManifest, "signature" | "suite" | "public_key">,
  privateKey: Uint8Array,
  publicKey?: Uint8Array,
): Promise<ConsolidationMutationManifest> {
  const withKey: Omit<ConsolidationMutationManifest, "signature" | "suite"> = publicKey
    ? { ...manifest, public_key: bytesToHex(publicKey) }
    : manifest;
  const body = { ...withKey, suite: CONSOLIDATION_MUTATION_MANIFEST_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(CONSOLIDATION_MUTATION_MANIFEST_SUITE, message, privateKey);
  return Object.freeze({ ...body, signature: toBase64Url(sig) });
}

/**
 * Verify a consolidation mutation manifest against the signer's public key.
 * Fail-closed on unknown `suite`, wrong `artifact_type`, base64url decode
 * error, or primitive failure. This proves only "this body was signed by the
 * holder of this key"; receipt linkage and per-mutation content matching are
 * the caller's separate, equally-required checks
 * (spec/consolidation-mutation-manifest-v1.md §6).
 */
export async function verifyConsolidationMutationManifest(
  manifest: ConsolidationMutationManifest,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (manifest.suite !== CONSOLIDATION_MUTATION_MANIFEST_SUITE) return false;
  if (manifest.manifest_type !== "consolidation_mutation_manifest") return false;
  const { signature, ...body } = manifest;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(manifest.suite, message, sig, publicKey);
  } catch {
    return false;
  }
}

// === Balance Waivers (migration §7.2) ===

import type { BalanceWaiver } from "@motebit/protocol";
export type { BalanceWaiver };

/** The one suite BalanceWaivers sign under today — matches spec/migration-v1.md §7.2. */
export const BALANCE_WAIVER_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a balance waiver. The agent forfeits a named micro-unit amount to
 * expedite departure from a relay (spec/migration-v1.md §7.2 + §7.3 — a
 * waiver is one of the two terminal authorizations the depart route will
 * accept, the other being a confirmed withdrawal).
 *
 * Callers pass the body without `signature` or `suite`; the signer owns
 * both. The agent's identity key signs canonical JSON of the unsigned
 * body (with `suite` stamped in), base64url-encoded.
 */
export async function signBalanceWaiver(
  waiver: Omit<BalanceWaiver, "signature" | "suite">,
  agentPrivateKey: Uint8Array,
): Promise<BalanceWaiver> {
  const body = { ...waiver, suite: BALANCE_WAIVER_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(BALANCE_WAIVER_SUITE, message, agentPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a balance waiver against the agent's public key. Rejects
 * fail-closed on unknown `suite`, base64url decode error, and primitive
 * verification failure. Matching of `motebit_id` to the authorizing
 * agent, and `waived_amount` to the actual virtual-account balance, is
 * the caller's responsibility (neither is a cryptographic property).
 */
export async function verifyBalanceWaiver(
  waiver: BalanceWaiver,
  agentPublicKey: Uint8Array,
): Promise<boolean> {
  if (waiver.suite !== BALANCE_WAIVER_SUITE) return false;
  const { signature, ...body } = waiver;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(waiver.suite, message, sig, agentPublicKey);
  } catch {
    return false;
  }
}

// === Settlement Records ===

import type { SettlementRecord, FederationSettlementRecord } from "@motebit/protocol";
export type { SettlementRecord, FederationSettlementRecord };

/** The one suite SettlementRecords sign under today. */
export const SETTLEMENT_RECORD_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a settlement record. The issuing relay commits to the (amount,
 * fee, rate, status) tuple; a malicious relay therefore cannot issue
 * inconsistent records to different observers.
 *
 * Callers pass the record without `signature` or `suite`; the signer
 * owns both.
 *
 * Foundation Law (services/relay/CLAUDE.md rule 6): every truth the
 * relay asserts is independently verifiable. Per-agent settlements
 * deliver this through the signature; federation settlements
 * additionally get Merkle-batched and onchain-anchored.
 */
export async function signSettlement(
  settlement: Omit<SettlementRecord, "signature" | "suite">,
  issuerPrivateKey: Uint8Array,
): Promise<SettlementRecord> {
  const body = { ...settlement, suite: SETTLEMENT_RECORD_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(SETTLEMENT_RECORD_SUITE, message, issuerPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a settlement record's signature. Reconstructs canonical JSON
 * over all fields except `signature` and verifies Ed25519 against the
 * issuing relay's public key.
 *
 * The caller supplies the public key — typically resolved from the
 * `issuer_relay_id` via the federation peer registry or a known-keys
 * store. The signature alone proves the record was issued by the
 * holder of `issuerPublicKey`; trust in that key is a separate
 * concern (federation membership, key rotation chain, etc).
 *
 * Fail-closed on:
 *   - missing or unknown `suite` value
 *   - base64url decode errors
 *   - primitive-level verification failure
 */
export async function verifySettlement(
  settlement: SettlementRecord,
  issuerPublicKey: Uint8Array,
): Promise<boolean> {
  if (settlement.suite !== SETTLEMENT_RECORD_SUITE) return false;
  const { signature, ...body } = settlement;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(settlement.suite, message, sig, issuerPublicKey);
  } catch {
    return false;
  }
}

/** The one suite FederationSettlementRecords sign under today. */
export const FEDERATION_SETTLEMENT_RECORD_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Sign a federation settlement record. Each relay signs its OWN copy of a
 * federated settlement (the issuer is the booking relay), committing to the
 * (gross, fee, net, rate) tuple so it cannot issue inconsistent records to
 * different observers — the per-agent `signSettlement` move applied to the
 * inter-relay stream (relay-federation-v1.md §7.6).
 *
 * The signed record is the verbatim-artifact whose canonical bytes become the
 * Merkle leaf (spec/agent-settlement-anchor-v1.md §9.1): the relay persists
 * `canonicalJson(record)` and anchors `canonicalLeaf(record)`, so a peer that
 * holds the record reproduces the leaf with `@motebit/crypto` alone.
 *
 * Callers pass the record without `signature` or `suite`; the signer owns both.
 */
export async function signFederationSettlement(
  settlement: Omit<FederationSettlementRecord, "signature" | "suite">,
  issuerPrivateKey: Uint8Array,
): Promise<FederationSettlementRecord> {
  const body = { ...settlement, suite: FEDERATION_SETTLEMENT_RECORD_SUITE };
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(FEDERATION_SETTLEMENT_RECORD_SUITE, message, issuerPrivateKey);
  return { ...body, signature: toBase64Url(sig) };
}

/**
 * Verify a federation settlement record's signature. Reconstructs canonical
 * JSON over all fields except `signature` and verifies Ed25519 against the
 * issuing relay's public key (resolved from `issuer_relay_id` via the
 * federation peer registry).
 *
 * Fail-closed on missing/unknown `suite`, base64url decode errors, or
 * primitive-level verification failure.
 */
export async function verifyFederationSettlement(
  settlement: FederationSettlementRecord,
  issuerPublicKey: Uint8Array,
): Promise<boolean> {
  if (settlement.suite !== FEDERATION_SETTLEMENT_RECORD_SUITE) return false;
  const { signature, ...body } = settlement;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await verifyBySuite(settlement.suite, message, sig, issuerPublicKey);
  } catch {
    return false;
  }
}

// === Key Succession (Rotation) ===

/** The one suite KeySuccessionRecords sign under today. */
export const KEY_SUCCESSION_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/**
 * A key succession record proving that one Ed25519 key has been replaced by another.
 * Normal rotation: both old and new keys sign. Guardian recovery: guardian + new key sign.
 */
export interface KeySuccessionRecord {
  old_public_key: string; // hex
  new_public_key: string; // hex
  timestamp: number;
  reason?: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-hex-v1"` —
   * JCS canonicalization of the unsigned payload, Ed25519 primitive,
   * hex signature encoding, hex public-key encoding. Structurally
   * compatible with `@motebit/protocol` `KeySuccessionRecord`.
   */
  suite: typeof KEY_SUCCESSION_SUITE;
  old_key_signature?: string; // hex — present in normal rotation, absent in guardian recovery
  new_key_signature: string; // hex, new key signs the canonical payload
  /** True when succession was authorized by guardian, not old key. */
  recovery?: boolean;
  /** Guardian signature — present only when recovery is true. */
  guardian_signature?: string; // hex
}

/**
 * Build the canonical payload for key succession signing. The `suite`
 * field is stamped into the signed body so verifiers dispatch the
 * primitive via `verifyBySuite` rather than assuming Ed25519 implicitly.
 */
function keySuccessionPayload(
  oldPublicKeyHex: string,
  newPublicKeyHex: string,
  timestamp: number,
  reason?: string,
  recovery?: boolean,
): string {
  const obj: Record<string, unknown> = {
    old_public_key: oldPublicKeyHex,
    new_public_key: newPublicKeyHex,
    timestamp,
    suite: KEY_SUCCESSION_SUITE,
  };
  if (reason !== undefined) {
    obj.reason = reason;
  }
  if (recovery) {
    obj.recovery = true;
  }
  return canonicalJson(obj);
}

/**
 * Create a key succession record signed by both the old and new keys.
 * Dispatches primitive signing through `signBySuite` per the
 * `motebit-jcs-ed25519-hex-v1` suite.
 */
export async function signKeySuccession(
  oldPrivateKey: Uint8Array,
  newPrivateKey: Uint8Array,
  newPublicKey: Uint8Array,
  oldPublicKey: Uint8Array,
  reason?: string,
): Promise<KeySuccessionRecord> {
  const timestamp = Date.now();
  const oldPublicKeyHex = bytesToHex(oldPublicKey);
  const newPublicKeyHex = bytesToHex(newPublicKey);

  const payload = keySuccessionPayload(oldPublicKeyHex, newPublicKeyHex, timestamp, reason);
  const message = new TextEncoder().encode(payload);

  const oldSig = await signBySuite(KEY_SUCCESSION_SUITE, message, oldPrivateKey);
  const newSig = await signBySuite(KEY_SUCCESSION_SUITE, message, newPrivateKey);

  return {
    old_public_key: oldPublicKeyHex,
    new_public_key: newPublicKeyHex,
    timestamp,
    ...(reason !== undefined ? { reason } : {}),
    suite: KEY_SUCCESSION_SUITE,
    old_key_signature: bytesToHex(oldSig),
    new_key_signature: bytesToHex(newSig),
  };
}

/**
 * Sign a guardian recovery succession record (§3.8.3).
 * The guardian key signs instead of the compromised old key.
 * Reason MUST include "guardian_recovery".
 */
export async function signGuardianRecoverySuccession(
  guardianPrivateKey: Uint8Array,
  newPrivateKey: Uint8Array,
  oldPublicKey: Uint8Array,
  newPublicKey: Uint8Array,
  reason?: string,
): Promise<KeySuccessionRecord> {
  const timestamp = Date.now();
  const oldPublicKeyHex = bytesToHex(oldPublicKey);
  const newPublicKeyHex = bytesToHex(newPublicKey);

  const effectiveReason = reason ?? "guardian_recovery";
  const payload = keySuccessionPayload(
    oldPublicKeyHex,
    newPublicKeyHex,
    timestamp,
    effectiveReason,
    true,
  );
  const message = new TextEncoder().encode(payload);

  const guardianSig = await signBySuite(KEY_SUCCESSION_SUITE, message, guardianPrivateKey);
  const newSig = await signBySuite(KEY_SUCCESSION_SUITE, message, newPrivateKey);

  return {
    old_public_key: oldPublicKeyHex,
    new_public_key: newPublicKeyHex,
    timestamp,
    reason: effectiveReason,
    suite: KEY_SUCCESSION_SUITE,
    new_key_signature: bytesToHex(newSig),
    recovery: true,
    guardian_signature: bytesToHex(guardianSig),
  };
}

/**
 * Verify a key succession record. For normal rotation, checks
 * old_key_signature + new_key_signature. For guardian recovery
 * (recovery: true), checks guardian_signature + new_key_signature.
 * Rejects records whose `suite` is missing or not the succession suite.
 */
export async function verifyKeySuccession(
  record: KeySuccessionRecord,
  guardianPublicKeyHex?: string,
): Promise<boolean> {
  if (record.suite !== KEY_SUCCESSION_SUITE) return false;
  const payload = keySuccessionPayload(
    record.old_public_key,
    record.new_public_key,
    record.timestamp,
    record.reason,
    record.recovery,
  );
  const message = new TextEncoder().encode(payload);

  try {
    const newPubKey = hexToBytes(record.new_public_key);
    const newSig = hexToBytes(record.new_key_signature);
    const newValid = await verifyBySuite(record.suite, message, newSig, newPubKey);
    if (!newValid) return false;

    if (record.recovery) {
      if (!record.guardian_signature || !guardianPublicKeyHex) return false;
      const guardianPubKey = hexToBytes(guardianPublicKeyHex);
      const guardianSig = hexToBytes(record.guardian_signature);
      return await verifyBySuite(record.suite, message, guardianSig, guardianPubKey);
    } else {
      if (!record.old_key_signature) return false;
      const oldPubKey = hexToBytes(record.old_public_key);
      const oldSig = hexToBytes(record.old_key_signature);
      return await verifyBySuite(record.suite, message, oldSig, oldPubKey);
    }
  } catch {
    /* v8 ignore next */
    return false;
  }
}

// === Succession Chain Verification ===

/** Result of verifying a key succession chain. */
export interface SuccessionChainResult {
  valid: boolean;
  genesis_public_key: string;
  current_public_key: string;
  length: number;
  error?: { index: number; message: string };
}

/**
 * Verify a full key succession chain — an ordered array of KeySuccessionRecords
 * representing a sequence of key rotations from a genesis key to the current active key.
 */
export async function verifySuccessionChain(
  chain: KeySuccessionRecord[],
  guardianPublicKeyHex?: string,
): Promise<SuccessionChainResult> {
  if (chain.length === 0) {
    return {
      valid: false,
      genesis_public_key: "",
      current_public_key: "",
      length: 0,
      error: { index: 0, message: "Empty succession chain" },
    };
  }

  const genesisKey = chain[0]!.old_public_key;
  const currentKey = chain[chain.length - 1]!.new_public_key;

  for (let i = 0; i < chain.length; i++) {
    const record = chain[i]!;

    if (record.recovery && !guardianPublicKeyHex) {
      return {
        valid: false,
        genesis_public_key: genesisKey,
        current_public_key: currentKey,
        length: chain.length,
        error: {
          index: i,
          message: `Record ${i} is a guardian recovery but no guardian public key provided`,
        },
      };
    }
    const sigValid = await verifyKeySuccession(record, guardianPublicKeyHex);
    if (!sigValid) {
      return {
        valid: false,
        genesis_public_key: genesisKey,
        current_public_key: currentKey,
        length: chain.length,
        error: { index: i, message: `Record ${i} has invalid signature` },
      };
    }

    if (i < chain.length - 1) {
      const next = chain[i + 1]!;
      if (record.new_public_key !== next.old_public_key) {
        return {
          valid: false,
          genesis_public_key: genesisKey,
          current_public_key: currentKey,
          length: chain.length,
          error: {
            index: i + 1,
            message: `Chain break at ${i + 1}: expected old_public_key "${record.new_public_key}", got "${next.old_public_key}"`,
          },
        };
      }
    }

    if (i < chain.length - 1) {
      const next = chain[i + 1]!;
      if (record.timestamp >= next.timestamp) {
        return {
          valid: false,
          genesis_public_key: genesisKey,
          current_public_key: currentKey,
          length: chain.length,
          error: {
            index: i + 1,
            message: `Temporal ordering violation at ${i + 1}: timestamp ${next.timestamp} is not after ${record.timestamp}`,
          },
        };
      }
    }
  }

  return {
    valid: true,
    genesis_public_key: genesisKey,
    current_public_key: currentKey,
    length: chain.length,
  };
}

// === Guardian Revocation (§3.3.2) ===

/** Guardian revocation shares the identity-file suite (JCS + hex). */
export const GUARDIAN_REVOCATION_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/**
 * Sign a guardian revocation payload — requires BOTH identity and guardian keys.
 * Neither party can unilaterally dissolve the custody relationship.
 * Dispatches the primitive through `signBySuite`.
 */
export async function signGuardianRevocation(
  identityPrivateKey: Uint8Array,
  guardianPrivateKey: Uint8Array,
  timestamp?: number,
): Promise<{
  payload: string;
  identity_signature: string;
  guardian_signature: string;
  timestamp: number;
}> {
  const ts = timestamp ?? Date.now();
  const payload = canonicalJson({
    action: "guardian_revoked",
    timestamp: ts,
    suite: GUARDIAN_REVOCATION_SUITE,
  });
  const message = new TextEncoder().encode(payload);

  const identitySig = await signBySuite(GUARDIAN_REVOCATION_SUITE, message, identityPrivateKey);
  const guardianSig = await signBySuite(GUARDIAN_REVOCATION_SUITE, message, guardianPrivateKey);

  return {
    payload,
    identity_signature: bytesToHex(identitySig),
    guardian_signature: bytesToHex(guardianSig),
    timestamp: ts,
  };
}

/**
 * Verify a guardian revocation proof — both signatures must be valid.
 * Dispatches primitive verification through `verifyBySuite`.
 */
export async function verifyGuardianRevocation(
  revocation: {
    identity_signature: string;
    guardian_signature: string;
    timestamp: number;
  },
  identityPublicKeyHex: string,
  guardianPublicKeyHex: string,
): Promise<boolean> {
  const payload = canonicalJson({
    action: "guardian_revoked",
    timestamp: revocation.timestamp,
    suite: GUARDIAN_REVOCATION_SUITE,
  });
  const message = new TextEncoder().encode(payload);

  try {
    const identityPub = hexToBytes(identityPublicKeyHex);
    const guardianPub = hexToBytes(guardianPublicKeyHex);
    const identitySig = hexToBytes(revocation.identity_signature);
    const guardianSig = hexToBytes(revocation.guardian_signature);

    const identityValid = await verifyBySuite(
      GUARDIAN_REVOCATION_SUITE,
      message,
      identitySig,
      identityPub,
    );
    const guardianValid = await verifyBySuite(
      GUARDIAN_REVOCATION_SUITE,
      message,
      guardianSig,
      guardianPub,
    );

    return identityValid && guardianValid;
  } catch {
    return false;
  }
}

// === Collaborative Receipt ===

/** The one suite CollaborativeReceipts sign under today. */
export const COLLABORATIVE_RECEIPT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

export interface SignableCollaborativeReceipt {
  proposal_id: string;
  plan_id: string;
  participant_receipts: SignableReceipt[];
  content_hash: string;
  /**
   * Cryptosuite discriminator. Always `"motebit-jcs-ed25519-b64-v1"` —
   * JCS canonicalization over the signing payload, Ed25519 primitive,
   * base64url signature encoding. Same recipe as ExecutionReceipt.
   */
  suite: typeof COLLABORATIVE_RECEIPT_SUITE;
  initiator_signature: string;
}

/**
 * Sign a collaborative receipt. Computes a content hash over the canonical
 * JSON of all participant receipts, then signs the aggregate through
 * `signBySuite` under `motebit-jcs-ed25519-b64-v1`.
 */
export async function signCollaborativeReceipt(
  receipt: Omit<SignableCollaborativeReceipt, "content_hash" | "initiator_signature" | "suite">,
  initiatorPrivateKey: Uint8Array,
): Promise<SignableCollaborativeReceipt> {
  const receiptsCanonical = canonicalJson(receipt.participant_receipts);
  const receiptsBytes = new TextEncoder().encode(receiptsCanonical);
  const contentHash = await hash(receiptsBytes);

  const sigPayload = canonicalJson({
    proposal_id: receipt.proposal_id,
    plan_id: receipt.plan_id,
    content_hash: contentHash,
    suite: COLLABORATIVE_RECEIPT_SUITE,
  });
  const sigMessage = new TextEncoder().encode(sigPayload);
  const sig = await signBySuite(COLLABORATIVE_RECEIPT_SUITE, sigMessage, initiatorPrivateKey);

  return {
    ...receipt,
    content_hash: contentHash,
    suite: COLLABORATIVE_RECEIPT_SUITE,
    initiator_signature: toBase64Url(sig),
  };
}

/**
 * Verify a collaborative receipt:
 * 1. Rejects any record whose `suite` is missing or not the collaborative suite.
 * 2. Recomputes content hash from participant receipts and checks it matches.
 * 3. Verifies the initiator's Ed25519 signature over the aggregate via `verifyBySuite`.
 * 4. Optionally verifies each participant receipt against known keys.
 */
export async function verifyCollaborativeReceipt(
  receipt: SignableCollaborativeReceipt,
  initiatorPublicKey: Uint8Array,
  participantKeys?: KnownKeys,
): Promise<{ valid: boolean; error?: string }> {
  // 0. Suite discriminator check
  if (receipt.suite !== COLLABORATIVE_RECEIPT_SUITE) {
    return { valid: false, error: "Unknown or missing cryptosuite" };
  }

  // 1. Recompute content hash
  const receiptsCanonical = canonicalJson(receipt.participant_receipts);
  const receiptsBytes = new TextEncoder().encode(receiptsCanonical);
  const expectedHash = await hash(receiptsBytes);

  if (expectedHash !== receipt.content_hash) {
    return { valid: false, error: "Content hash mismatch" };
  }

  // 2. Verify initiator signature (suite stamped into the signed payload)
  const sigPayload = canonicalJson({
    proposal_id: receipt.proposal_id,
    plan_id: receipt.plan_id,
    content_hash: receipt.content_hash,
    suite: receipt.suite,
  });
  const sigMessage = new TextEncoder().encode(sigPayload);
  try {
    const sig = fromBase64Url(receipt.initiator_signature);
    const sigValid = await verifyBySuite(receipt.suite, sigMessage, sig, initiatorPublicKey);
    if (!sigValid) {
      return { valid: false, error: "Initiator signature invalid" };
    }
  } catch {
    return { valid: false, error: "Initiator signature decode failed" };
  }

  // 3. Verify participant receipts if keys provided
  if (participantKeys) {
    for (let i = 0; i < receipt.participant_receipts.length; i++) {
      const pr = receipt.participant_receipts[i]!;
      const pubKey = participantKeys.get(pr.motebit_id);
      if (!pubKey) {
        return {
          valid: false,
          error: `Unknown participant key for receipt ${i} (${pr.motebit_id})`,
        };
      }
      const prValid = await verifyExecutionReceipt(pr, pubKey);
      if (!prValid) {
        return {
          valid: false,
          error: `Participant receipt ${i} (${pr.motebit_id}) signature invalid`,
        };
      }
    }
  }

  return { valid: true };
}

// === Device Self-Registration ===
//
// Self-attesting registration: the device proves it controls a private key
// by signing a canonical-JSON serialization of its own registration request.
// The relay verifies against the public_key carried in the same request — no
// prior trust anchor required. Wire format and verification recipe are
// foundation law in `spec/device-self-registration-v1.md`.
//
// Trust posture: a self-registered device starts at trust zero. Trust accrues
// through receipts, credentials, and onchain anchors — never through
// registration alone. See `docs/doctrine/protocol-model.md`.

/** The one suite device-registration requests sign under today. */
export const DEVICE_REGISTRATION_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Shape of a device-registration request for signing/verification.
 * Structurally compatible with @motebit/protocol `DeviceRegistrationRequest`.
 */
export interface SignableDeviceRegistration {
  motebit_id: string;
  device_id: string;
  public_key: string;
  device_name?: string;
  owner_id?: string;
  timestamp: number;
  suite: typeof DEVICE_REGISTRATION_SUITE;
  signature: string;
}

/**
 * Sign a device-registration request. Stamps the cryptosuite into the body,
 * canonicalizes with JCS, dispatches the primitive signature through
 * `signBySuite`, and encodes as base64url per the suite's rules.
 *
 * Callers pass the body without `signature` and (optionally) without `suite`;
 * the signer owns both. The returned object is a complete signed request
 * ready to POST to a relay's self-register endpoint.
 */
export async function signDeviceRegistration<
  T extends Omit<SignableDeviceRegistration, "signature" | "suite">,
>(
  body: T,
  privateKey: Uint8Array,
): Promise<T & { suite: typeof DEVICE_REGISTRATION_SUITE; signature: string }> {
  const withSuite = { ...body, suite: DEVICE_REGISTRATION_SUITE };
  const canonical = canonicalJson(withSuite);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(DEVICE_REGISTRATION_SUITE, message, privateKey);
  return { ...withSuite, signature: toBase64Url(sig) } as T & {
    suite: typeof DEVICE_REGISTRATION_SUITE;
    signature: string;
  };
}

/**
 * Verify a device-registration request's signature against the public key
 * carried in the request itself. The `now` parameter (defaulting to
 * `Date.now()`) lets tests pin the clock for replay-window assertions; in
 * production callers pass the relay's wall-clock at request receipt.
 *
 * Returns a discriminated reason on failure so callers can map to wire-level
 * status codes (per `spec/device-self-registration-v1.md` §5.1).
 */
export type DeviceRegistrationVerifyResult =
  | { valid: true }
  | { valid: false; reason: "malformed" | "stale" | "unsupported_suite" | "bad_signature" };

/** Maximum drift between the signer's claimed timestamp and the verifier's clock. */
export const DEVICE_REGISTRATION_MAX_AGE_MS = 5 * 60 * 1000;

export async function verifyDeviceRegistration(
  body: SignableDeviceRegistration,
  now: number = Date.now(),
): Promise<DeviceRegistrationVerifyResult> {
  // Step 1 — shape validation. Any missing / mistyped field is "malformed".
  if (
    typeof body.motebit_id !== "string" ||
    typeof body.device_id !== "string" ||
    typeof body.public_key !== "string" ||
    !/^[0-9a-f]{64}$/i.test(body.public_key) ||
    typeof body.timestamp !== "number" ||
    typeof body.suite !== "string" ||
    typeof body.signature !== "string"
  ) {
    return { valid: false, reason: "malformed" };
  }
  // Step 2 — replay window.
  if (Math.abs(now - body.timestamp) > DEVICE_REGISTRATION_MAX_AGE_MS) {
    return { valid: false, reason: "stale" };
  }
  // Step 3 — suite check. Only the registered suite is acceptable today;
  // future suites add a dispatch arm in suite-dispatch.ts.
  if (body.suite !== DEVICE_REGISTRATION_SUITE) {
    return { valid: false, reason: "unsupported_suite" };
  }
  // Step 4–7 — canonicalize, decode, verify.
  const { signature, ...bodyForSig } = body;
  const canonical = canonicalJson(bodyForSig);
  const message = new TextEncoder().encode(canonical);
  let sigBytes: Uint8Array;
  let pkBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(signature);
    pkBytes = hexToBytes(body.public_key);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  const ok = await verifyBySuite(body.suite, message, sigBytes, pkBytes);
  return ok ? { valid: true } : { valid: false, reason: "bad_signature" };
}

// === Motebit announcement (sovereign-funnel intake) ===
//
// A self-signed declaration that a freshly-minted motebit is announcing
// itself to a specific relay's durable intake ledger — the metabolic-intake
// half of the boundary. Distinct from device-registration: registration
// makes a device serve under an identity; an announcement is the identity's
// one-time "I exist, count me" against a named relay. Same JCS+Ed25519+
// base64url suite and 5-minute replay window as device-registration.
//
// `audience` binds the signed record to the target relay's sovereign id
// (`relay_id`) so an announcement signed for relay A cannot be replayed as
// intake — i.e. as consent-to-join — on relay B. Token binding per
// `docs/doctrine/security-boundaries.md`. The signature is the auth; there
// is no bearer token. Trust posture: an announced motebit starts at trust
// zero, exactly like a self-registered device.

/** The one suite motebit announcements sign under today (shared with device-registration). */
export const MOTEBIT_ANNOUNCEMENT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/** Maximum drift between the signer's claimed timestamp and the verifier's clock. */
export const MOTEBIT_ANNOUNCEMENT_MAX_AGE_MS = 5 * 60 * 1000;

/** The intake source a motebit announces from — one arm per client surface. */
export type AnnouncementSurface = "web" | "desktop" | "mobile" | "cli" | "spatial";

/** The closed set of valid surfaces, for runtime validation on the auth-less endpoint. */
const ANNOUNCEMENT_SURFACES: ReadonlySet<string> = new Set([
  "web",
  "desktop",
  "mobile",
  "cli",
  "spatial",
]);

/** Runtime guard: is `s` a known `AnnouncementSurface`? Keeps the wire validation and the type from drifting. */
export function isAnnouncementSurface(s: unknown): s is AnnouncementSurface {
  return typeof s === "string" && ANNOUNCEMENT_SURFACES.has(s);
}

/**
 * Shape of a motebit announcement for signing/verification.
 *
 * `audience` is the target relay's `relay_id` (its `relayMotebitId`); the
 * relay rejects an announcement whose `audience` is not its own id.
 */
export interface SignableMotebitAnnouncement {
  motebit_id: string;
  public_key: string;
  surface: AnnouncementSurface;
  audience: string;
  timestamp: number;
  suite: typeof MOTEBIT_ANNOUNCEMENT_SUITE;
  signature: string;
}

/**
 * Sign a motebit announcement. Stamps the cryptosuite into the body,
 * canonicalizes with JCS, dispatches the primitive signature through
 * `signBySuite`, and encodes as base64url per the suite's rules.
 *
 * Callers pass the body without `signature` and (optionally) without `suite`;
 * the signer owns both. The returned object is a complete signed announcement
 * ready to POST to a relay's `/api/v1/motebits/announce` endpoint.
 */
export async function signMotebitAnnouncement<
  T extends Omit<SignableMotebitAnnouncement, "signature" | "suite">,
>(
  body: T,
  privateKey: Uint8Array,
): Promise<T & { suite: typeof MOTEBIT_ANNOUNCEMENT_SUITE; signature: string }> {
  const withSuite = { ...body, suite: MOTEBIT_ANNOUNCEMENT_SUITE };
  const canonical = canonicalJson(withSuite);
  const message = new TextEncoder().encode(canonical);
  const sig = await signBySuite(MOTEBIT_ANNOUNCEMENT_SUITE, message, privateKey);
  return { ...withSuite, signature: toBase64Url(sig) } as T & {
    suite: typeof MOTEBIT_ANNOUNCEMENT_SUITE;
    signature: string;
  };
}

/**
 * Verify a motebit announcement's signature against the public key carried
 * in the announcement itself, AND that its `audience` matches the verifying
 * relay's expected id. The `now` parameter (defaulting to `Date.now()`) lets
 * tests pin the clock for replay-window assertions.
 *
 * Returns a discriminated reason on failure so the relay can map to a
 * wire-level status. `wrong_audience` is its own arm: a structurally valid,
 * correctly-signed announcement that was bound to a different relay — the
 * cross-relay replay this binding exists to reject.
 *
 * This is the *integrity* check (the signing key controls the body). It does
 * NOT establish that `public_key` is the genesis key `motebit_id` commits to —
 * that is the orthogonal *binding* check (`verifySovereignBinding`), which the
 * relay runs separately before recording intake. Both are portable and offline;
 * a third party verifying a stored announcement runs both. See
 * `docs/doctrine/identity-binding-verification.md` (integrity vs binding).
 */
export type MotebitAnnouncementVerifyResult =
  | { valid: true }
  | {
      valid: false;
      reason: "malformed" | "stale" | "unsupported_suite" | "wrong_audience" | "bad_signature";
    };

export async function verifyMotebitAnnouncement(
  body: SignableMotebitAnnouncement,
  opts: { expectedAudience: string; now?: number },
): Promise<MotebitAnnouncementVerifyResult> {
  const now = opts.now ?? Date.now();
  // Step 1 — shape validation. Any missing / mistyped field is "malformed".
  if (
    typeof body.motebit_id !== "string" ||
    typeof body.public_key !== "string" ||
    !/^[0-9a-f]{64}$/i.test(body.public_key) ||
    // Surface is validated against its closed set, not just `typeof string`:
    // the endpoint is auth-less, and an unconstrained value would let a caller
    // store arbitrary text (data poisoning / bloat) in the intake ledger.
    !isAnnouncementSurface(body.surface) ||
    typeof body.audience !== "string" ||
    typeof body.timestamp !== "number" ||
    typeof body.suite !== "string" ||
    typeof body.signature !== "string"
  ) {
    return { valid: false, reason: "malformed" };
  }
  // Step 2 — replay window.
  if (Math.abs(now - body.timestamp) > MOTEBIT_ANNOUNCEMENT_MAX_AGE_MS) {
    return { valid: false, reason: "stale" };
  }
  // Step 3 — suite check. Only the registered suite is acceptable today.
  if (body.suite !== MOTEBIT_ANNOUNCEMENT_SUITE) {
    return { valid: false, reason: "unsupported_suite" };
  }
  // Step 4 — audience binding. Reject an announcement signed for another
  // relay before spending a signature verification on it.
  if (body.audience !== opts.expectedAudience) {
    return { valid: false, reason: "wrong_audience" };
  }
  // Step 5–7 — canonicalize, decode, verify.
  const { signature, ...bodyForSig } = body;
  const canonical = canonicalJson(bodyForSig);
  const message = new TextEncoder().encode(canonical);
  let sigBytes: Uint8Array;
  let pkBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(signature);
    pkBytes = hexToBytes(body.public_key);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  const ok = await verifyBySuite(body.suite, message, sigBytes, pkBytes);
  return ok ? { valid: true } : { valid: false, reason: "bad_signature" };
}

// === Goal Execution Manifest (execution-ledger spec §6) ===

import type { GoalExecutionManifest, ExecutionTimelineEntry } from "@motebit/protocol";

/**
 * Canonical content hash for an execution-ledger manifest: SHA-256 (hex) over
 * the newline-joined canonical-JSON of each timeline entry. THE single source
 * of this hash (spec/execution-ledger-v1.md §6); the runtime's `replayGoal`
 * signs over it and delegates here so signer + verifier never drift on
 * canonical-JSON edge cases (e.g. `undefined` object values).
 */
export async function computeExecutionTimelineHash(
  timeline: ExecutionTimelineEntry[],
): Promise<string> {
  const lines = timeline.map((entry) => canonicalJson(entry)).join("\n");
  return hash(new TextEncoder().encode(lines));
}

export type GoalExecutionManifestVerification =
  | { valid: true }
  | {
      valid: false;
      reason: "content_hash_mismatch" | "signature_missing" | "signature_invalid" | "malformed";
    };

/**
 * Verify a `GoalExecutionManifest` (execution-ledger spec §6) against the
 * motebit's public key, with no relay contact — closes the self-attesting
 * consumer side for the manifest `replayGoal` signs.
 *
 * Two independent checks: (1) the `content_hash` recomputes from the timeline
 * (integrity of the proof-of-work record); (2) the Ed25519 `signature` over
 * the raw 32-byte hash verifies against `publicKey`. The signer signs the hash
 * bytes directly (spec §6) — not a canonical body — so verification routes the
 * hash bytes through `verifyBySuite` (every Ed25519 suite arm verifies the
 * given bytes directly; the manifest carries no `suite` field, so the canonical
 * b64 suite is used as the dispatch key). Fail-closed on every mismatch. Inner
 * `signed_receipts` are verified separately by `verifyInnerSignedReceipts`.
 */
export async function verifyGoalExecutionManifest(
  manifest: GoalExecutionManifest,
  publicKey: Uint8Array,
): Promise<GoalExecutionManifestVerification> {
  const recomputed = await computeExecutionTimelineHash(manifest.timeline);
  if (recomputed !== manifest.content_hash)
    return { valid: false, reason: "content_hash_mismatch" };
  if (manifest.signature === undefined) return { valid: false, reason: "signature_missing" };
  let sig: Uint8Array;
  let hashBytes: Uint8Array;
  try {
    sig = fromBase64Url(manifest.signature);
    hashBytes = hexToBytes(manifest.content_hash);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  const ok = await verifyBySuite("motebit-jcs-ed25519-b64-v1", hashBytes, sig, publicKey);
  return ok ? { valid: true } : { valid: false, reason: "signature_invalid" };
}

// === Migration artifacts (spec/migration-v1.md) ===

import type {
  MigrationRequest,
  MigrationToken,
  DepartureAttestation,
  CredentialBundle,
  MigrationPresentation,
  SuiteId,
} from "@motebit/protocol";

/**
 * Verify a detached base64url Ed25519 signature over the JCS canonicalization
 * of the artifact minus its `signature` field, under the body's declared
 * `suite`. The shared shape for the migration family: every artifact signs
 * `canonicalJson(body \ signature)` and base64url-encodes the result (the
 * suite the schema declares, `motebit-jcs-ed25519-b64-v1`). Generic over the
 * body so all fields except `signature` enter the canonical form. Fail-closed
 * on unknown suite / malformed signature.
 */
async function verifyDetachedB64Signature<
  T extends { readonly suite: SuiteId; readonly signature: string },
>(body: T, publicKey: Uint8Array): Promise<boolean> {
  const { signature, ...rest } = body;
  const message = new TextEncoder().encode(canonicalJson(rest));
  try {
    return await verifyBySuite(body.suite, message, fromBase64Url(signature), publicKey);
  } catch {
    return false;
  }
}

/** Verify a `MigrationRequest` (agent-signed declaration of intent). */
export function verifyMigrationRequest(
  request: MigrationRequest,
  publicKey: Uint8Array,
): Promise<boolean> {
  return verifyDetachedB64Signature(request, publicKey);
}

/**
 * Sign a `MigrationRequest` — the agent's declaration of intent to leave a relay
 * (spec/migration-v1.md §4.1). The agent signs `canonicalJson(request \ signature)`
 * with its identity key, base64url. Producer for {@link verifyMigrationRequest}:
 * the source relay's `/migrate` verifies this against the agent's registered
 * public key, so only the agent (holding its private key) can initiate its own
 * departure — the request's signature IS the authorization.
 */
export async function signMigrationRequest(
  request: Omit<MigrationRequest, "signature">,
  privateKey: Uint8Array,
): Promise<MigrationRequest> {
  const sig = await signBySuite(
    request.suite,
    new TextEncoder().encode(canonicalJson(request)),
    privateKey,
  );
  return { ...request, signature: toBase64Url(sig) };
}

/** Verify a `MigrationToken` (source-relay-signed authorization). */
export function verifyMigrationToken(
  token: MigrationToken,
  publicKey: Uint8Array,
): Promise<boolean> {
  return verifyDetachedB64Signature(token, publicKey);
}

/** Verify a `DepartureAttestation` (source-relay-signed history snapshot). */
export function verifyDepartureAttestation(
  attestation: DepartureAttestation,
  publicKey: Uint8Array,
): Promise<boolean> {
  return verifyDetachedB64Signature(attestation, publicKey);
}

/** Verify a `MigrationPresentation` envelope's own signature (agent-signed).
 *  The nested token / attestation / bundle verify via their own verifiers. */
export function verifyMigrationPresentation(
  presentation: MigrationPresentation,
  publicKey: Uint8Array,
): Promise<boolean> {
  return verifyDetachedB64Signature(presentation, publicKey);
}

/**
 * Verify a `CredentialBundle` (agent-signed export of portable reputation).
 * Two checks: (1) `bundle_hash` recomputes as SHA-256 (hex) of
 * `canonicalJson(body \ {bundle_hash, signature})`; (2) the base64url Ed25519
 * `signature` over `canonicalJson(body \ signature)` (which commits to
 * `bundle_hash`) verifies against `publicKey`. Fail-closed.
 */
export async function verifyCredentialBundle(
  bundle: CredentialBundle,
  publicKey: Uint8Array,
): Promise<boolean> {
  const { signature, bundle_hash, ...rest } = bundle;
  const recomputed = await hash(new TextEncoder().encode(canonicalJson(rest)));
  if (recomputed !== bundle_hash) return false;
  const message = new TextEncoder().encode(canonicalJson({ ...rest, bundle_hash }));
  try {
    return await verifyBySuite(bundle.suite, message, fromBase64Url(signature), publicKey);
  } catch {
    return false;
  }
}

// === Relay discovery metadata (spec/discovery, /.well-known/motebit.json) ===

import type { RelayMetadata } from "@motebit/protocol";

/**
 * Verify a `RelayMetadata` discovery document against `publicKey`. Unlike the
 * migration family, RelayMetadata's declared suite is `motebit-jcs-ed25519-hex-v1`
 * — a HEX signature — so the signature is hex-decoded. Verifies the Ed25519
 * signature over `canonicalJson(body \ signature)`. Fail-closed.
 *
 * Trust note: this proves "the metadata was signed by the holder of `publicKey`,"
 * not that `publicKey` is the relay's real key. A consumer with a pinned /
 * anchored key (a federation peer key, or a key cross-checked against the
 * relay's onchain-anchored transparency declaration) passes that key for an
 * anti-MITM check; a trust-on-first-use bootstrap passes the embedded
 * `metadata.public_key` to confirm integrity only.
 */
export async function verifyRelayMetadata(
  metadata: RelayMetadata,
  publicKey: Uint8Array,
): Promise<boolean> {
  const { signature, ...rest } = metadata;
  const message = new TextEncoder().encode(canonicalJson(rest));
  try {
    return await verifyBySuite(metadata.suite, message, hexToBytes(signature), publicKey);
  } catch {
    return false;
  }
}

/**
 * Sign a `CredentialBundle` for migration export (spec/migration-v1.md §6 —
 * "the agent signs the bundle; the relay does not," so the agent controls what
 * it presents to a destination). The relay exports the bundle unsigned; the
 * agent computes `bundle_hash` = SHA-256 (hex) of `canonicalJson(body)` and
 * signs `canonicalJson(body + bundle_hash)` with its identity key, base64url.
 * Producer for {@link verifyCredentialBundle}.
 */
export async function signCredentialBundle(
  bundle: Omit<CredentialBundle, "bundle_hash" | "signature">,
  privateKey: Uint8Array,
): Promise<CredentialBundle> {
  const bundle_hash = await hash(new TextEncoder().encode(canonicalJson(bundle)));
  const withHash = { ...bundle, bundle_hash };
  const sig = await signBySuite(
    bundle.suite,
    new TextEncoder().encode(canonicalJson(withHash)),
    privateKey,
  );
  return { ...withHash, signature: toBase64Url(sig) };
}
