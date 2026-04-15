/**
 * Invoke Capability — deterministic surface-affordance → delegation path.
 *
 * Sibling of `interactive-delegation.ts`. Where that path lets the AI loop
 * decide whether to delegate, this one takes an explicit capability name and
 * submits directly. No model in the routing path. No fall-through to the AI
 * loop on failure. Honest degradation: the failure is surfaced verbatim.
 *
 * See `docs/doctrine/surface-determinism.md` for the principle and
 * `plan/cuddly-dancing-sunset.md` for the failure-mode taxonomy this
 * implements.
 */

import type { ExecutionReceipt, IntentOrigin } from "@motebit/sdk";

import type { StreamChunk } from "./index.js";
import {
  submitAndPollDelegation,
  type DelegationError,
  type DelegationErrorCode,
} from "./relay-delegation.js";

export type { DelegationError, DelegationErrorCode };

export interface InvokeCapabilityDeps {
  motebitId: string;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Bump trust from a verified receipt. Best-effort. */
  bumpTrustFromReceipt: (receipt: ExecutionReceipt) => Promise<void>;
  /** Stash the receipt so a concurrent AI loop's handleAgentTask can drain it. */
  stashReceipt: (receipt: ExecutionReceipt) => void;
}

export interface InvokeCapabilityConfig {
  syncUrl: string;
  authToken: (audience?: string) => Promise<string>;
  timeoutMs?: number;
  routingStrategy?: "cost" | "quality" | "balanced";
}

export interface InvokeCapabilityOptions {
  /**
   * Invocation provenance. Default `"user-tap"` — that's the surface this
   * primitive exists to serve. Schedulers and agent-to-agent composers MAY
   * pass other values.
   */
  invocationOrigin?: IntentOrigin;
  /** Abort the in-flight poll. The relay continues processing server-side. */
  signal?: AbortSignal;
}

/**
 * New `StreamChunk` variant (additive to the union in `./index.ts`). Emitted
 * by this path when a failure is surfaced to the UI. The chat layer maps each
 * code to its user-visible copy — no string parsing.
 */
export interface InvokeErrorChunk {
  type: "invoke_error";
  code: DelegationErrorCode;
  /** Not user-facing verbatim — the UI renders copy per code. */
  message: string;
  retryAfterSeconds?: number;
  status?: number;
}

export class InvokeCapabilityManager {
  constructor(
    private readonly deps: InvokeCapabilityDeps,
    private readonly config: InvokeCapabilityConfig,
  ) {}

  /**
   * Submit a single-capability task to the relay and yield the deterministic
   * `StreamChunk` sequence the chat layer already knows how to render:
   *
   *   delegation_start → delegation_complete (full_receipt) → result
   *
   * On failure, yields an `invoke_error` chunk and stops. No fall-through.
   */
  async *invokeCapability(
    capability: string,
    prompt: string,
    options: InvokeCapabilityOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const invocationOrigin = options.invocationOrigin ?? "user-tap";
    const server = "relay";
    const tool = "invoke_capability";

    // Mirrors the `delegation_start` shape the AI-loop path emits for
    // motebit_task tool calls. The UI shows the standard "Delegating to X"
    // indicator; no special casing required.
    yield { type: "delegation_start", server, tool };

    const result = await submitAndPollDelegation({
      motebitId: this.deps.motebitId,
      syncUrl: this.config.syncUrl,
      authToken: this.config.authToken,
      prompt,
      requiredCapabilities: [capability],
      routingStrategy: this.config.routingStrategy,
      invocationOrigin,
      timeoutMs: this.config.timeoutMs,
      logger: this.deps.logger,
      signal: options.signal,
    });

    if (!result.ok) {
      yield { type: "invoke_error", ...result.error } as StreamChunk;
      return;
    }

    const receipt = result.receipt;

    // Bump trust (best-effort — trust accrual shouldn't block the UX).
    try {
      await this.deps.bumpTrustFromReceipt(receipt);
    } catch {
      // Best-effort.
    }

    // Stash for any concurrent AI-loop handleAgentTask to drain into its
    // parent receipt's delegation_receipts chain. Preserves composition: a
    // user-tap delegation made during an ongoing AI conversation is still
    // part of the same execution manifest.
    this.deps.stashReceipt(receipt);

    // Yield the result text as a single text chunk so the bubble body has
    // content — matches the AI-loop path where the delegation_complete is
    // preceded by streamed text.
    if (receipt.result != null && receipt.result.length > 0) {
      yield { type: "text", text: receipt.result };
    }

    yield {
      type: "delegation_complete",
      server,
      tool,
      receipt: {
        task_id: result.taskId,
        status: receipt.status,
        tools_used: receipt.tools_used ?? [],
      },
      full_receipt: receipt,
    };

    // No `result` chunk. The AI-loop path emits one because `runTurnStreaming`
    // wraps a full conversational turn; this path wraps a single capability
    // invocation. The chat-layer chip handler emerges the receipt bubble on
    // `delegation_complete` and exits its `for await` when the generator ends.
  }
}
