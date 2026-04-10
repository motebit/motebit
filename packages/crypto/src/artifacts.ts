/**
 * Protocol artifact signing — receipts, delegations, successions, collaborative receipts.
 *
 * These functions define the canonical signing format for all Motebit protocol
 * artifacts. A third party needs these to produce valid signed artifacts that
 * any verifier will accept.
 *
 * Moved from BSL @motebit/crypto to MIT @motebit/crypto.
 */

import {
  canonicalJson,
  ed25519Sign,
  ed25519Verify,
  toBase64Url,
  fromBase64Url,
  bytesToHex,
  hexToBytes,
  hash,
  isScopeNarrowed,
} from "./signing.js";

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
  signature: string;
}

/**
 * Sign an execution receipt. Produces a canonical JSON representation
 * of all fields except `signature`, signs it with Ed25519, and sets
 * the `signature` field to the base64url-encoded result.
 */
export async function signExecutionReceipt<T extends Omit<SignableReceipt, "signature">>(
  receipt: T,
  privateKey: Uint8Array,
  publicKey?: Uint8Array,
): Promise<T & { signature: string }> {
  // Embed the public key for portable verification (no relay lookup needed)
  const body = publicKey ? { ...receipt, public_key: bytesToHex(publicKey) } : receipt;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  const sig = await ed25519Sign(message, privateKey);
  return { ...body, signature: toBase64Url(sig) } as T & { signature: string };
}

/**
 * Verify an execution receipt's Ed25519 signature.
 * Reconstructs the canonical JSON from all fields except `signature`
 * and verifies against the provided public key.
 */
export async function verifyExecutionReceipt(
  receipt: SignableReceipt,
  publicKey: Uint8Array,
): Promise<boolean> {
  const { signature, ...body } = receipt;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const sig = fromBase64Url(signature);
    return await ed25519Verify(sig, message, publicKey);
  } catch {
    return false;
  }
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
  /** Asset symbol (e.g., "USDC"). */
  asset: string;
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
  const receipt: Omit<SignableReceipt, "signature"> = {
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
  };
  return signExecutionReceipt(receipt, privateKey, publicKey);
}

// === Receipt Chain Verification ===

export interface ReceiptVerification {
  task_id: string;
  motebit_id: string;
  verified: boolean;
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

  // Use embedded public key if available, otherwise look up from known keys.
  let publicKey = knownKeys.get(motebit_id);
  if (!publicKey && receipt.public_key) {
    publicKey = hexToBytes(receipt.public_key);
  }
  if (!publicKey) {
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

  const result: ReceiptVerification = { task_id, motebit_id, verified, delegations };
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
 * A signed delegation token authorizing one entity to act on behalf of another.
 * The delegator signs (delegator_id, delegate_id, scope, issued_at, expires_at)
 * with their private key, proving they authorized the delegate.
 */
export interface DelegationToken {
  delegator_id: string;
  delegator_public_key: string; // base64url-encoded Ed25519 public key
  delegate_id: string;
  delegate_public_key: string; // base64url-encoded Ed25519 public key
  scope: string; // what the delegate is authorized to do
  issued_at: number;
  expires_at: number;
  signature: string; // base64url-encoded Ed25519 signature
}

/**
 * Sign a delegation token. The delegator authorizes the delegate to act
 * within the given scope. The signature covers all fields except `signature`.
 */
export async function signDelegation(
  delegation: Omit<DelegationToken, "signature">,
  delegatorPrivateKey: Uint8Array,
): Promise<DelegationToken> {
  const canonical = canonicalJson(delegation);
  const message = new TextEncoder().encode(canonical);
  const sig = await ed25519Sign(message, delegatorPrivateKey);
  return { ...delegation, signature: toBase64Url(sig) };
}

/**
 * Verify a delegation token's signature and (optionally) expiration.
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
  const checkExpiry = options?.checkExpiry ?? true;
  if (checkExpiry) {
    const now = options?.now ?? Date.now();
    if (delegation.expires_at < now) return false;
  }

  const { signature, ...body } = delegation;
  const canonical = canonicalJson(body);
  const message = new TextEncoder().encode(canonical);
  try {
    const pubKey = fromBase64Url(delegation.delegator_public_key);
    const sig = fromBase64Url(signature);
    return await ed25519Verify(sig, message, pubKey);
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

// === Key Succession (Rotation) ===

/**
 * A key succession record proving that one Ed25519 key has been replaced by another.
 * Normal rotation: both old and new keys sign. Guardian recovery: guardian + new key sign.
 */
export interface KeySuccessionRecord {
  old_public_key: string; // hex
  new_public_key: string; // hex
  timestamp: number;
  reason?: string;
  old_key_signature?: string; // hex — present in normal rotation, absent in guardian recovery
  new_key_signature: string; // hex, new key signs the canonical payload
  /** True when succession was authorized by guardian, not old key. */
  recovery?: boolean;
  /** Guardian signature — present only when recovery is true. */
  guardian_signature?: string; // hex
}

/**
 * Build the canonical payload for key succession signing.
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

  const oldSig = await ed25519Sign(message, oldPrivateKey);
  const newSig = await ed25519Sign(message, newPrivateKey);

  return {
    old_public_key: oldPublicKeyHex,
    new_public_key: newPublicKeyHex,
    timestamp,
    ...(reason !== undefined ? { reason } : {}),
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

  const guardianSig = await ed25519Sign(message, guardianPrivateKey);
  const newSig = await ed25519Sign(message, newPrivateKey);

  return {
    old_public_key: oldPublicKeyHex,
    new_public_key: newPublicKeyHex,
    timestamp,
    reason: effectiveReason,
    new_key_signature: bytesToHex(newSig),
    recovery: true,
    guardian_signature: bytesToHex(guardianSig),
  };
}

/**
 * Verify a key succession record. For normal rotation, checks old_key_signature + new_key_signature.
 * For guardian recovery (recovery: true), checks guardian_signature + new_key_signature.
 */
export async function verifyKeySuccession(
  record: KeySuccessionRecord,
  guardianPublicKeyHex?: string,
): Promise<boolean> {
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
    const newValid = await ed25519Verify(newSig, message, newPubKey);
    if (!newValid) return false;

    if (record.recovery) {
      if (!record.guardian_signature || !guardianPublicKeyHex) return false;
      const guardianPubKey = hexToBytes(guardianPublicKeyHex);
      const guardianSig = hexToBytes(record.guardian_signature);
      return await ed25519Verify(guardianSig, message, guardianPubKey);
    } else {
      if (!record.old_key_signature) return false;
      const oldPubKey = hexToBytes(record.old_public_key);
      const oldSig = hexToBytes(record.old_key_signature);
      return await ed25519Verify(oldSig, message, oldPubKey);
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

/**
 * Sign a guardian revocation payload — requires BOTH identity and guardian keys.
 * Neither party can unilaterally dissolve the custody relationship.
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
  const payload = canonicalJson({ action: "guardian_revoked", timestamp: ts });
  const message = new TextEncoder().encode(payload);

  const identitySig = await ed25519Sign(message, identityPrivateKey);
  const guardianSig = await ed25519Sign(message, guardianPrivateKey);

  return {
    payload,
    identity_signature: bytesToHex(identitySig),
    guardian_signature: bytesToHex(guardianSig),
    timestamp: ts,
  };
}

/**
 * Verify a guardian revocation proof — both signatures must be valid.
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
  const payload = canonicalJson({ action: "guardian_revoked", timestamp: revocation.timestamp });
  const message = new TextEncoder().encode(payload);

  try {
    const identityPub = hexToBytes(identityPublicKeyHex);
    const guardianPub = hexToBytes(guardianPublicKeyHex);
    const identitySig = hexToBytes(revocation.identity_signature);
    const guardianSig = hexToBytes(revocation.guardian_signature);

    const identityValid = await ed25519Verify(identitySig, message, identityPub);
    const guardianValid = await ed25519Verify(guardianSig, message, guardianPub);

    return identityValid && guardianValid;
  } catch {
    return false;
  }
}

// === Collaborative Receipt ===

export interface SignableCollaborativeReceipt {
  proposal_id: string;
  plan_id: string;
  participant_receipts: SignableReceipt[];
  content_hash: string;
  initiator_signature: string;
}

/**
 * Sign a collaborative receipt. Computes a content hash over the canonical
 * JSON of all participant receipts, then signs the aggregate with the
 * initiator's Ed25519 private key.
 */
export async function signCollaborativeReceipt(
  receipt: Omit<SignableCollaborativeReceipt, "content_hash" | "initiator_signature">,
  initiatorPrivateKey: Uint8Array,
): Promise<SignableCollaborativeReceipt> {
  const receiptsCanonical = canonicalJson(receipt.participant_receipts);
  const receiptsBytes = new TextEncoder().encode(receiptsCanonical);
  const contentHash = await hash(receiptsBytes);

  const sigPayload = canonicalJson({
    proposal_id: receipt.proposal_id,
    plan_id: receipt.plan_id,
    content_hash: contentHash,
  });
  const sigMessage = new TextEncoder().encode(sigPayload);
  const sig = await ed25519Sign(sigMessage, initiatorPrivateKey);

  return {
    ...receipt,
    content_hash: contentHash,
    initiator_signature: toBase64Url(sig),
  };
}

/**
 * Verify a collaborative receipt:
 * 1. Recomputes content hash from participant receipts and checks it matches.
 * 2. Verifies the initiator's Ed25519 signature over the aggregate.
 * 3. Optionally verifies each participant receipt against known keys.
 */
export async function verifyCollaborativeReceipt(
  receipt: SignableCollaborativeReceipt,
  initiatorPublicKey: Uint8Array,
  participantKeys?: KnownKeys,
): Promise<{ valid: boolean; error?: string }> {
  // 1. Recompute content hash
  const receiptsCanonical = canonicalJson(receipt.participant_receipts);
  const receiptsBytes = new TextEncoder().encode(receiptsCanonical);
  const expectedHash = await hash(receiptsBytes);

  if (expectedHash !== receipt.content_hash) {
    return { valid: false, error: "Content hash mismatch" };
  }

  // 2. Verify initiator signature
  const sigPayload = canonicalJson({
    proposal_id: receipt.proposal_id,
    plan_id: receipt.plan_id,
    content_hash: receipt.content_hash,
  });
  const sigMessage = new TextEncoder().encode(sigPayload);
  try {
    const sig = fromBase64Url(receipt.initiator_signature);
    const sigValid = await ed25519Verify(sig, sigMessage, initiatorPublicKey);
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
