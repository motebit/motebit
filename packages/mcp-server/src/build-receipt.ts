/**
 * Canonical helper for constructing and signing an `ExecutionReceipt` from
 * inside a service's `handleAgentTask`. Every MCP service yields a
 * `task_result` carrying a signed receipt at the end of each turn; this is
 * the single place receipts are built and signed.
 *
 * The receipt shape is a protocol contract. Any new required field (trust
 * binding, relay binding, additional metadata) is added here and propagates
 * to every service automatically — services call the helper, never rebuild
 * the receipt inline.
 *
 * See CLAUDE.md "Protocol primitives belong in packages, never inline in
 * services" for the doctrine.
 */

import { hash as sha256, signExecutionReceipt, verifyExecutionReceipt } from "@motebit/encryption";
import type { ExecutionReceipt, IntentOrigin } from "@motebit/sdk";

export interface BuildServiceReceiptInput {
  /** Service's motebit identity (same for every receipt this service signs). */
  motebitId: string;
  /** Service's device id / canonical service name in the receipt (e.g. "research-service"). */
  deviceId: string;
  /** Service's Ed25519 private key for signing. */
  privateKey: Uint8Array;
  /** Service's Ed25519 public key bytes — included in the signature material. */
  publicKey: Uint8Array;

  /** The user / delegator prompt that triggered this turn. */
  prompt: string;
  /** Stable task id (usually a crypto.randomUUID generated at turn start). */
  taskId: string;
  /** Start-of-turn timestamp, captured before the work began. */
  submittedAt: number;

  /** Result of the work — string on success, error message on failure. Always present. */
  result: string;
  /** Whether the work succeeded (status: "completed" vs "failed"). */
  ok: boolean;

  /** Names of tools the service used during this turn (for audit). */
  toolsUsed: string[];
  /** Number of memories formed during this turn (default 0 for stateless services). */
  memoriesFormed?: number;

  /** Relay's task id for economic binding, if this turn was relay-mediated. */
  relayTaskId?: string;
  /** Delegated scope, if this service was itself invoked as a sub-delegate. */
  delegatedScope?: string;
  /** Signed sub-receipts from delegated work — the cryptographic citation chain. */
  delegationReceipts?: ExecutionReceipt[];
  /** Explicit completion timestamp override. Defaults to `Date.now()` at call time. */
  completedAt?: number;
  /**
   * How this task was authorized for invocation. Surface determinism (CLAUDE.md
   * principle): user-tap chips/buttons/slash-commands MUST pass `"user-tap"`;
   * AI-loop tool calls MUST pass `"ai-loop"`; cron triggers `"scheduled"`;
   * downstream agent composition `"agent-to-agent"`. Optional and additive
   * — omitted means "unknown origin" on the resulting receipt.
   */
  invocationOrigin?: IntentOrigin;
}

/**
 * Construct the canonical receipt body, compute prompt/result hashes, and
 * sign with the service's Ed25519 key. Returns the signed receipt ready to
 * yield as `{ type: "task_result", receipt }`.
 */
export async function buildServiceReceipt(
  input: BuildServiceReceiptInput,
): Promise<ExecutionReceipt> {
  const enc = new TextEncoder();
  const promptHash = await sha256(enc.encode(input.prompt));
  const resultHash = await sha256(enc.encode(input.result));

  const receipt: Record<string, unknown> = {
    task_id: input.taskId,
    motebit_id: input.motebitId,
    device_id: input.deviceId,
    submitted_at: input.submittedAt,
    completed_at: input.completedAt ?? Date.now(),
    status: input.ok ? "completed" : "failed",
    result: input.result,
    tools_used: input.toolsUsed,
    memories_formed: input.memoriesFormed ?? 0,
    prompt_hash: promptHash,
    result_hash: resultHash,
    ...(input.relayTaskId != null ? { relay_task_id: input.relayTaskId } : {}),
    ...(input.delegatedScope != null ? { delegated_scope: input.delegatedScope } : {}),
    ...(input.delegationReceipts != null && input.delegationReceipts.length > 0
      ? { delegation_receipts: input.delegationReceipts }
      : {}),
    ...(input.invocationOrigin != null ? { invocation_origin: input.invocationOrigin } : {}),
  };

  const signed = (await signExecutionReceipt(
    receipt as Parameters<typeof signExecutionReceipt>[0],
    input.privateKey,
    input.publicKey,
  )) as ExecutionReceipt;

  // Producer self-verify gate. If the receipt we just signed doesn't verify
  // against its own embedded public_key, the bug is at the producer — not
  // somewhere downstream where it would surface as wire corruption five
  // hops later. Throw immediately so the failure points at the actual
  // mutation site (the caller that fed us a body the canonicalizer
  // disagrees with itself about). Fail-loud, fail-now.
  //
  // Cost: one Ed25519 verify per signed receipt (~200 µs) — negligible.
  // The contract: `signExecutionReceipt(body) → verify(returned, embedded_pk) === true`,
  // for ANY body, ALWAYS. If this gate ever throws in production, that IS
  // the bug — diagnose with DEBUG_RECEIPT_BYTES=1 to capture the canonical
  // hash mismatch.
  const selfVerified = await verifyExecutionReceipt(signed, input.publicKey);
  if (!selfVerified) {
    throw new Error(
      `buildServiceReceipt produced a self-invalid receipt for motebit_id=${input.motebitId} ` +
        `task_id=${input.taskId} chain=${input.delegationReceipts?.length ?? 0} — ` +
        `signature verifies false against embedded public_key. This indicates a body mutation ` +
        `between sign and return, OR a bug in the canonicalization recipe. Run with ` +
        `DEBUG_RECEIPT_BYTES=1 to capture the canonical-hash mismatch.`,
    );
  }

  return signed;
}
