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
  ConversationMessage,
} from "@motebit/sdk";
import { hash, signExecutionReceipt, verifyExecutionReceipt } from "@motebit/crypto";
import { composeDelegationTrust, trustLevelToScore } from "@motebit/semiring";
import type { EventStore } from "@motebit/event-log";
import type { AgentGraphManager } from "./agent-graph.js";
import type { StreamChunk } from "./index.js";

/** Saved conversation context for restore after task execution. */
export type SavedConversationContext = { history: ConversationMessage[]; id: string | null };

// === Types ===

type McpClientAdapterForTask = {
  getAndResetDelegationReceipts?(): ExecutionReceipt[];
};

/** Dependencies injected by the runtime. */
export interface AgentTaskHandlerDeps {
  motebitId: string;
  events: EventStore;
  agentTrustStore: AgentTrustStoreAdapter | null;
  agentGraph: AgentGraphManager;
  latencyStatsStore: LatencyStatsStoreAdapter | null;
  logger: { warn(message: string, context?: Record<string, unknown>): void };

  /** Send a message through the streaming pipeline, returning chunks. */
  sendMessageStreaming(
    text: string,
    runId?: string,
    options?: { delegationScope?: string },
  ): AsyncGenerator<StreamChunk>;

  /** Save current conversation context for later restoration. */
  saveConversationContext(): SavedConversationContext;
  /** Clear conversation for the task. */
  clearConversationForTask(): void;
  /** Restore conversation context after the task completes. */
  restoreConversationContext(ctx: SavedConversationContext): void;

  /** Drain delegation receipts from motebit MCP adapters. */
  getMcpAdapters(): McpClientAdapterForTask[];
  /** Drain interactive delegation receipts. */
  getAndResetInteractiveDelegationReceipts(): ExecutionReceipt[];

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
  // Save current conversation context
  const savedCtx = deps.saveConversationContext();
  deps.clearConversationForTask();

  const wallClockMs = task.wall_clock_ms ?? 60_000;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), wallClockMs);

  let responseText = "";
  const toolsUsed: string[] = [];
  let memoriesFormed = 0;
  let status: "completed" | "failed" | "denied" = "completed";

  try {
    const stream = deps.sendMessageStreaming(task.prompt, undefined, {
      delegationScope: options?.delegatedScope,
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
      } else if (chunk.type === "result") {
        responseText = chunk.result.response;
        memoriesFormed = chunk.result.memoriesFormed.length;
      }

      yield chunk;
    }
  } catch (err: unknown) {
    status = "failed";
    responseText = responseText || (err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);

    // Restore user conversation context
    deps.restoreConversationContext(savedCtx);
  }

  // Drain delegation receipts from motebit MCP adapters + interactive delegation tool
  const delegationReceipts: ExecutionReceipt[] = [];
  for (const adapter of deps.getMcpAdapters()) {
    if (adapter.getAndResetDelegationReceipts) {
      delegationReceipts.push(...adapter.getAndResetDelegationReceipts());
    }
  }
  delegationReceipts.push(...deps.getAndResetInteractiveDelegationReceipts());

  // Bump trust from verified delegation receipts (best-effort)
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

      for (const dr of delegationReceipts) {
        // Look up stored public key for the delegatee
        const trustRecord = await deps.agentTrustStore.getAgentTrust(deps.motebitId, dr.motebit_id);
        if (trustRecord?.public_key) {
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

  // Hash prompt and result
  const promptHash = await hash(new TextEncoder().encode(task.prompt));
  const resultHash = await hash(new TextEncoder().encode(responseText));

  // Build and sign receipt
  const receiptBody: Record<string, unknown> = {
    task_id: task.task_id,
    motebit_id: task.motebit_id,
    device_id: deviceId,
    submitted_at: task.submitted_at,
    completed_at: Date.now(),
    status,
    result: responseText,
    tools_used: toolsUsed,
    memories_formed: memoriesFormed,
    prompt_hash: promptHash,
    result_hash: resultHash,
    // Relay task ID binding — task.task_id IS the relay-assigned ID for WebSocket tasks.
    // Including it explicitly as relay_task_id enables the relay's binding check.
    relay_task_id: task.task_id,
  };
  if (delegationReceipts.length > 0) {
    receiptBody.delegation_receipts = delegationReceipts;
  }

  const receipt = await signExecutionReceipt(
    receiptBody as Omit<ExecutionReceipt, "signature">,
    privateKey,
    publicKey,
  );

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
