/**
 * `buildServiceReceipt` — canonical helper for constructing and signing an
 * `ExecutionReceipt` from inside a service's `handleAgentTask`.
 *
 * Every MCP service (code-review, read-url, research, summarize, web-search,
 * and any future motebit service) yields a `task_result` carrying a signed
 * `ExecutionReceipt` at the end of each `handleAgentTask` turn. Before this
 * helper existed, each service duplicated ~30 lines of receipt construction
 * + signing. The shape of the receipt is a protocol contract; duplication
 * means a new required field (trust binding, relay binding, etc.) has to be
 * updated in every service.
 *
 * This is the protocol primitive. Services call it; never rebuild inline.
 *
 * Doctrine (see CLAUDE.md "Protocol primitives belong in packages, never
 * inline in services"): when a service needs protocol-shaped plumbing —
 * signing, receipts, MCP transport, delegation — the primitive lives in a
 * shared package. If the primitive doesn't exist yet, add it to the
 * appropriate package. Never ship it inline in a service.
 */

import { hash as sha256, signExecutionReceipt } from "@motebit/encryption";
import type { ExecutionReceipt } from "@motebit/sdk";

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
  };

  return signExecutionReceipt(
    receipt as Parameters<typeof signExecutionReceipt>[0],
    input.privateKey,
    input.publicKey,
  ) as Promise<ExecutionReceipt>;
}
