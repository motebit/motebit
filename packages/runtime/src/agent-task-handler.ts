/**
 * Agent Task Handler — stateless pipeline for executing delegated agent tasks.
 *
 * Extracted from MotebitRuntime. Receives an AgentTask, executes it via
 * streaming, signs an ExecutionReceipt, bumps trust from nested delegation
 * receipts, and logs events.
 */

import { EventType, AgentTrustLevel } from "@motebit/sdk";
import type {
  AgentTask,
  ExecutionReceipt,
  AgentTrustStoreAdapter,
  LatencyStatsStoreAdapter,
} from "@motebit/sdk";
import { hash, signExecutionReceipt, verifyExecutionReceipt } from "@motebit/encryption";
import { composeDelegationTrust, trustLevelToScore } from "@motebit/semiring";
import type { EventStore } from "@motebit/event-log";
import type { AgentGraphManager } from "./agent-graph.js";
import type { StreamChunk } from "./runtime-config.js";

// === Types ===

/** Dependencies injected by the runtime. */
export interface AgentTaskHandlerDeps {
  motebitId: string;
  events: EventStore;
  agentTrustStore: AgentTrustStoreAdapter | null;
  agentGraph: AgentGraphManager;
  latencyStatsStore: LatencyStatsStoreAdapter | null;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /**
   * Source of `completed_at` for the signed ExecutionReceipt. Defaults to
   * `Date.now`. Sourced from `RuntimeConfig.clock`. Tests that assert
   * byte-identity across runs (e.g. cross-model behavioral equivalence)
   * pin this to a fixed value; production leaves it undefined.
   */
  clock?: () => number;

  /** Send a message through the streaming pipeline, returning chunks. */
  sendMessageStreaming(
    text: string,
    runId?: string,
    options?: {
      delegationScope?: string;
      foreignPrincipal?: boolean;
      /**
       * Receives the task turn's OWN delegation receipts when it ends
       * (#943). The handler has no other way to reach delegation receipts:
       * there is no shared bucket to drain, so the owner's hires cannot be
       * signed into a customer's receipt.
       */
      onDelegationReceipts?: (
        receipts: Array<{ receipt: ExecutionReceipt; trustCredited: boolean }>,
      ) => void;
    },
  ): AsyncGenerator<StreamChunk>;

  /** Bump trust from a verified receipt. */
  bumpTrustFromReceipt(receipt: ExecutionReceipt, verified: boolean): Promise<void>;
}

// === Handler ===

/**
 * Execute a delegated agent task end-to-end: stream the prompt, build and sign
 * the ExecutionReceipt, bump trust from nested delegation receipts, and log events.
 *
 * This is a stateless pipeline — all state is accessed through the deps interface.
 */
export async function* handleAgentTask(
  deps: AgentTaskHandlerDeps,
  task: AgentTask,
  privateKey: Uint8Array,
  deviceId: string,
  publicKey?: Uint8Array,
  options?: { delegatedScope?: string },
): AsyncGenerator<StreamChunk> {
  // #943 round 10: no save / clear / restore of the owner's conversation.
  // The task's turn is FOREIGN (`foreignPrincipal: true` below), so it sees
  // and writes the conversation only through `forTurn(FOREIGN)` — an inert
  // view. Swapping the owner's live history out for the task's duration
  // blanked the OWNER's own concurrent reads (live history, conversation id,
  // reflection), and the restore in `finally` discarded owner writes made
  // meanwhile (an approval timeout, a `resetConversation()`).

  const wallClockMs = task.wall_clock_ms ?? 60_000;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), wallClockMs);

  let responseText = "";
  const toolsUsed: string[] = [];
  let memoriesFormed = 0;
  let status: "completed" | "failed" | "denied" = "completed";
  // Governance-refusal signal from the loop's terminal result. A delegated task
  // that completed zero successful tool calls but was hard-denied by policy at
  // least once is a refusal, not a completion — we mint an agent-signed
  // `status:"denied"` receipt for it below. Approval-gates / injection /
  // tool-not-found are NOT counted here (see TurnResult.toolCallsDenied).
  let toolCallsSucceeded = 0;
  let toolCallsDenied = 0;

  // #943: the receipts of the hires THIS task's turn made — delivered by the
  // turn itself when it ends, never drained from a shared bucket.
  const delegationEntries: Array<{ receipt: ExecutionReceipt; trustCredited: boolean }> = [];

  try {
    // The prompt is another principal's (a customer's, a caller's), so the
    // turn is foreign: it is offered no `localOnly` tool — the owner's
    // filesystem, shell, memory and transcripts stay out of a task's reach,
    // and out of its signed receipt (#880).
    const stream = deps.sendMessageStreaming(task.prompt, undefined, {
      delegationScope: options?.delegatedScope,
      foreignPrincipal: true,
      onDelegationReceipts: (entries) => {
        delegationEntries.push(...entries);
      },
    });

    for await (const chunk of stream) {
      if (abortController.signal.aborted) {
        status = "failed";
        responseText = responseText || "Task timed out";
        break;
      }

      if (chunk.type === "text") {
        responseText += chunk.text;
      } else if (chunk.type === "tool_status" && chunk.status === "done") {
        if (!toolsUsed.includes(chunk.name)) {
          toolsUsed.push(chunk.name);
        }
      } else if (chunk.type === "payment_notice") {
        // #885: serving another principal's task, this motebit's own wallet
        // sent another payment (or a payment could not be recorded). The
        // owner is not watching this stream — the serving surfaces read only
        // the task_result — so it is logged loudly here, once for every
        // serving surface; the owed payment is already in the ledger.
        deps.logger.warn("delegation.payment_notice", {
          task_id: task.task_id,
          notice: chunk.notice,
          ...(chunk.extra_payments != null ? { extra_payments: chunk.extra_payments } : {}),
          ...(chunk.ledger_write_failed === true ? { ledger_write_failed: true } : {}),
        });
      } else if (chunk.type === "result") {
        responseText = chunk.result.response;
        // The owner's own log keeps the count; the signed receipt reports
        // 0 (#943) — a task's turn is another principal's, and a formation
        // count is a fact about the owner's memory.
        memoriesFormed = chunk.result.memoriesFormed.length;
        toolCallsSucceeded = chunk.result.toolCallsSucceeded;
        // Optional + additive on TurnResult — absent on legacy producers ⇒ 0 ⇒
        // never spuriously denies.
        toolCallsDenied = chunk.result.toolCallsDenied ?? 0;
      }

      yield chunk;
    }
  } catch (err: unknown) {
    status = "failed";
    responseText = responseText || (err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }

  // Delegation policy refusal path. A task that did NO successful work and was
  // hard-denied by governance at least once is a refusal — surface it as an
  // agent-signed `status:"denied"` receipt instead of a misleading `completed`.
  // Only downgrades from `completed` (never overrides a `failed` from a thrown
  // provider error / timeout): a crash is a failure, a policy block is a denial,
  // and the two must not be confused on the signed record. The agent signs its
  // OWN refusal here (the relay cannot — it holds no agent key), which is what
  // makes "the agent refuses itself" a verifiable fact rather than the relay's
  // word for it. See docs/doctrine/delegation.md.
  if (status === "completed" && toolCallsSucceeded === 0 && toolCallsDenied > 0) {
    status = "denied";
    responseText =
      `Task refused by governance: ${toolCallsDenied} action(s) exceeded this motebit's policy ` +
      `(deny_above / denylist / delegated scope) and no permitted action completed.` +
      (responseText ? ` Model note: ${responseText}` : "");
  }

  const delegationReceipts = delegationEntries.map((e) => e.receipt);

  // Credit the hires this task's turn made: trust, chain trust, graph
  // edges, latency (best-effort). The owner's own hires get the same credit
  // at owner-record intake (#943) — never through a task.
  // The flag survives from where each hire was made: one credit per hire.
  await absorbDelegationReceipts(deps, delegationEntries);

  // Hash prompt and result
  const promptHash = await hash(new TextEncoder().encode(task.prompt));
  const resultHash = await hash(new TextEncoder().encode(responseText));

  // Build and sign receipt
  const receiptBody: Record<string, unknown> = {
    task_id: task.task_id,
    motebit_id: task.motebit_id,
    device_id: deviceId,
    submitted_at: task.submitted_at,
    completed_at: (deps.clock ?? Date.now)(),
    status,
    result: responseText,
    tools_used: toolsUsed,
    memories_formed: 0,
    prompt_hash: promptHash,
    result_hash: resultHash,
    // Relay task ID binding — task.task_id IS the relay-assigned ID for WebSocket tasks.
    // Including it explicitly as relay_task_id enables the relay's binding check.
    relay_task_id: task.task_id,
  };
  if (delegationReceipts.length > 0) {
    receiptBody.delegation_receipts = delegationReceipts;
  }
  // Propagate the surface-determinism discriminator from the task envelope
  // onto the signed receipt. Signature-bound; see IntentOrigin in
  // @motebit/protocol and docs/doctrine/surface-determinism.md.
  if (task.invocation_origin) {
    receiptBody.invocation_origin = task.invocation_origin;
  }

  const receipt = await signExecutionReceipt(
    receiptBody as Omit<ExecutionReceipt, "signature">,
    privateKey,
    publicKey,
  );

  // Producer self-verify gate. Mirrors the gate in
  // packages/mcp-server/src/build-receipt.ts. If the signed receipt does
  // not verify against its own embedded public_key, throw at the producer
  // — the failure points at the actual mutation site (the body shape we
  // fed signExecutionReceipt) rather than surfacing as wire corruption
  // five hops downstream. Run with DEBUG_RECEIPT_BYTES=1 to dump canonical
  // hashes when this fires. Skipped when publicKey was not provided (the
  // signing flow itself omits embedding it, so there's nothing to verify
  // against without a separate key lookup).
  if (publicKey) {
    const selfVerified = await verifyExecutionReceipt(receipt, publicKey);
    if (!selfVerified) {
      throw new Error(
        `agent-task-handler produced a self-invalid receipt for motebit_id=${deps.motebitId} ` +
          `task_id=${task.task_id} chain=${delegationReceipts.length} — signature verifies false ` +
          `against embedded public_key. Body mutation between sign and return, OR canonicalization ` +
          `bug. Run with DEBUG_RECEIPT_BYTES=1 to capture the canonical-hash mismatch.`,
      );
    }
  }

  // Log event
  const eventTypeMap: Record<string, EventType> = {
    completed: EventType.AgentTaskCompleted,
    denied: EventType.AgentTaskDenied,
    failed: EventType.AgentTaskFailed,
  };
  const eventType = eventTypeMap[status] ?? EventType.AgentTaskFailed;

  try {
    await deps.events.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: deps.motebitId,
      device_id: deviceId,
      timestamp: Date.now(),
      event_type: eventType,
      payload: {
        task_id: task.task_id,
        status,
        tools_used: toolsUsed,
        memories_formed: memoriesFormed,
        receipt: {
          motebit_id: receipt.motebit_id,
          device_id: receipt.device_id,
          completed_at: receipt.completed_at,
          signature: receipt.signature.slice(0, 16),
          delegation_receipts: receipt.delegation_receipts?.map(function summarize(
            dr: ExecutionReceipt,
          ): Record<string, unknown> {
            return {
              task_id: dr.task_id,
              motebit_id: dr.motebit_id,
              device_id: dr.device_id,
              status: dr.status,
              completed_at: dr.completed_at,
              tools_used: dr.tools_used,
              memories_formed: dr.memories_formed,
              signature: dr.signature.slice(0, 16),
              delegation_receipts: dr.delegation_receipts?.map(summarize),
            };
          }),
        },
      },
      tombstoned: false,
    });
  } catch {
    // Event logging is best-effort
  }

  yield { type: "task_result", receipt };
}

/**
 * Credit delegation receipts to THIS motebit (the one that made the hires):
 * verify + bump trust (unless already credited at production), compose and
 * emit `ChainTrustComputed`, add agent-graph edges, record latency. All
 * best-effort. Used by `handleAgentTask` for its own turn's hires, and by
 * the runtime's owner-record intake for the owner's hires (#943) — the two
 * consumers are disjoint, so no receipt is credited twice.
 */
export async function absorbDelegationReceipts(
  deps: Pick<
    AgentTaskHandlerDeps,
    | "motebitId"
    | "events"
    | "agentTrustStore"
    | "agentGraph"
    | "latencyStatsStore"
    | "logger"
    | "bumpTrustFromReceipt"
  >,
  entries: Array<{ receipt: ExecutionReceipt; trustCredited: boolean }>,
  opts: {
    /**
     * Credit trust only for a receipt whose signature VERIFIES — under the
     * delegatee's stored key, or else its embedded `public_key` (#943 round
     * 5, the owner record's intake). Without it, a receipt with no stored
     * key keeps the old first-contact credit (the task path, unchanged).
     */
    requireVerifiable?: boolean;
  } = {},
): Promise<void> {
  // Bump trust from verified delegation receipts (best-effort)
  const delegationReceipts = entries.map((e) => e.receipt);
  if (delegationReceipts.length > 0 && deps.agentTrustStore != null) {
    try {
      // Pre-fetch trust scores for all agents in receipt trees into a sync map
      const collectIds = (r: ExecutionReceipt): string[] => {
        const ids = [r.motebit_id];
        for (const sub of r.delegation_receipts ?? []) ids.push(...collectIds(sub));
        return ids;
      };
      const allIds = [...new Set(delegationReceipts.flatMap(collectIds))];
      const trustMap = new Map<string, number>();
      for (const id of allIds) {
        const rec = await deps.agentTrustStore.getAgentTrust(deps.motebitId, id);
        trustMap.set(
          id,
          rec ? trustLevelToScore(rec.trust_level) : trustLevelToScore(AgentTrustLevel.Unknown),
        );
      }

      for (const { receipt: dr, trustCredited } of entries) {
        // Look up stored public key for the delegatee
        const trustRecord = await deps.agentTrustStore.getAgentTrust(deps.motebitId, dr.motebit_id);
        if (trustCredited) {
          // Trust was already credited where the hire was made.
        } else if (trustRecord?.public_key) {
          const fromHex = (hex: string): Uint8Array => {
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < hex.length; i += 2) {
              bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
            }
            return bytes;
          };
          const pubKey = fromHex(trustRecord.public_key);
          const verified = await verifyExecutionReceipt(dr, pubKey);
          await deps.bumpTrustFromReceipt(dr, verified);
        } else if (opts.requireVerifiable === true) {
          // No stored key: credit only a receipt that verifies under its
          // own embedded key; a shape-checked receipt earns nothing.
          const embedded = typeof dr.public_key === "string" ? dr.public_key : "";
          const verified =
            /^[0-9a-f]{64}$/i.test(embedded) &&
            (await verifyExecutionReceipt(
              dr,
              Uint8Array.from(embedded.match(/../g)!.map((h) => parseInt(h, 16))),
            ));
          if (verified) await deps.bumpTrustFromReceipt(dr, true);
        } else {
          // No stored key — record as unverified first contact
          await deps.bumpTrustFromReceipt(dr, true);
        }

        // Compose chain trust through delegation tree (best-effort)
        const directTrust =
          trustMap.get(dr.motebit_id) ?? trustLevelToScore(AgentTrustLevel.Unknown);
        const chainTrust = composeDelegationTrust(
          directTrust,
          dr,
          (id: string) => trustMap.get(id) ?? trustLevelToScore(AgentTrustLevel.Unknown),
        );

        // Emit chain trust event for gradient/audit consumption
        try {
          await deps.events.appendWithClock({
            event_id: crypto.randomUUID(),
            motebit_id: deps.motebitId,
            timestamp: Date.now(),
            event_type: EventType.ChainTrustComputed,
            payload: {
              delegatee: dr.motebit_id,
              direct_trust: directTrust,
              chain_trust: chainTrust,
              delegation_depth: (dr.delegation_receipts ?? []).length,
            },
            tombstoned: false,
          });
        } catch {
          // Event emission is best-effort
        }
      }
    } catch (err: unknown) {
      // Trust bumping is best-effort — don't break the task
      deps.logger.warn("trust bump failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Update agent graph with delegation receipt edges
  for (const dr of delegationReceipts) {
    try {
      await deps.agentGraph.addReceiptEdges(dr);
    } catch (err: unknown) {
      deps.logger.warn("graph edge update failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Record latency for delegation receipts (best-effort)
  if (delegationReceipts.length > 0 && deps.latencyStatsStore != null) {
    for (const dr of delegationReceipts) {
      try {
        const latency = dr.completed_at - dr.submitted_at;
        if (latency > 0) {
          await deps.latencyStatsStore.record(deps.motebitId, dr.motebit_id, latency);
        }
      } catch (err: unknown) {
        deps.logger.warn("latency recording failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
