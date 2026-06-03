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
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/protocol";

import type { StreamChunk } from "./runtime-config.js";
import {
  selectAndRunDelegation,
  type DelegationError,
  type DelegationErrorCode,
  type DelegationResult,
} from "./relay-delegation.js";

export type { DelegationError, DelegationErrorCode };

export interface InvokeCapabilityDeps {
  motebitId: string;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Bump trust from a verified receipt. Best-effort. */
  bumpTrustFromReceipt: (receipt: ExecutionReceipt) => Promise<void>;
  /** Stash the receipt so a concurrent AI loop's handleAgentTask can drain it. */
  stashReceipt: (receipt: ExecutionReceipt) => void;
  /**
   * The sovereign rail's atomic multi-leg payment builder, bound by the runtime
   * from its `SovereignWalletRail`. Present only when a sovereign wallet is
   * configured. When present (and a pinned `relayPublicKey` is in the config),
   * a paid cross-agent capability settles peer-to-peer instead of relay-custody;
   * absent → every delegation uses the relay-mediated path.
   */
  buildP2pPayment?: (request: SovereignP2pPaymentRequest) => Promise<P2pPaymentProof>;
}

export interface InvokeCapabilityConfig {
  syncUrl: string;
  authToken: (audience?: string) => Promise<string>;
  timeoutMs?: number;
  routingStrategy?: "cost" | "quality" | "balanced";
  /**
   * The relay's Ed25519 public key (hex), PINNED at pairing. Required for paid
   * P2P delegation: the treasury the fee leg pays is derived from this key
   * (never from a fetched response), so the irreversible onchain payment trusts
   * the pairing root. Absent → P2P is disabled and every delegation uses the
   * relay-mediated path. The surface populates it from its pairing record.
   */
  relayPublicKey?: string;
  /**
   * The user consciously accepts cold-start risk for paying a NEW worker (no
   * trust history) directly. Forwarded to the P2P path as
   * `delegator_acknowledges_no_history_risk` (Arc 3). Without it, a first-time
   * paid P2P delegation to an unknown worker is rejected by the relay's
   * eligibility gate (403) AFTER the payment has already broadcast — so a
   * surface offering paid delegation to new agents MUST set this from an
   * explicit user opt-in. Established pairs ignore it.
   */
  acknowledgeNoHistoryRisk?: boolean;
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
  /**
   * Per-invocation cold-start acknowledgment (overrides the config default).
   * The surface sets this from an explicit user opt-in so a paid delegation to
   * a NEW worker (no trust history) is admitted by the relay's P2P eligibility
   * gate rather than falling back to relay-mode. Read fresh per call so a live
   * preference toggle takes effect without re-enabling the capability. See
   * `InvokeCapabilityConfig.acknowledgeNoHistoryRisk`.
   */
  acknowledgeNoHistoryRisk?: boolean;
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

    const result = await this.resolveDelegation(
      capability,
      prompt,
      invocationOrigin,
      options.signal,
      options.acknowledgeNoHistoryRisk,
    );

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

  /**
   * Pick the settlement path. When a sovereign rail (`buildP2pPayment`) AND a
   * pinned `relayPublicKey` are both configured, a PAID cross-agent capability
   * settles peer-to-peer (`resolveAndSubmitP2pDelegation`) — the relay never
   * custodies the worker's earnings. If no payable P2P worker advertises the
   * capability (a free task, or cold-start before the worker is p2p-eligible),
   * it falls back to the relay-mediated path — but ONLY on the pre-broadcast
   * codes (`no_routing` / `worker_not_payable`). Once a payment may have moved,
   * the P2P result is surfaced verbatim, never silently re-run as a relay-custody
   * task (which would double-charge). Absent rail/key → relay-mode, as before.
   */
  private async resolveDelegation(
    capability: string,
    prompt: string,
    invocationOrigin: IntentOrigin,
    signal: AbortSignal | undefined,
    acknowledgeNoHistoryRisk: boolean | undefined,
  ): Promise<DelegationResult> {
    // Per-invocation opt-in overrides the config default (read fresh so a live
    // surface preference toggle takes effect without re-enabling the capability).
    const ack = acknowledgeNoHistoryRisk ?? this.config.acknowledgeNoHistoryRisk;
    return selectAndRunDelegation({
      motebitId: this.deps.motebitId,
      syncUrl: this.config.syncUrl,
      authToken: this.config.authToken,
      prompt,
      requiredCapabilities: [capability],
      ...(this.deps.buildP2pPayment ? { buildP2pPayment: this.deps.buildP2pPayment } : {}),
      ...(this.config.relayPublicKey != null ? { relayPublicKey: this.config.relayPublicKey } : {}),
      ...(ack === true ? { acknowledgeNoHistoryRisk: true } : {}),
      ...(this.config.routingStrategy ? { routingStrategy: this.config.routingStrategy } : {}),
      invocationOrigin,
      ...(this.config.timeoutMs != null ? { timeoutMs: this.config.timeoutMs } : {}),
      logger: this.deps.logger,
      ...(signal ? { signal } : {}),
    });
  }
}
