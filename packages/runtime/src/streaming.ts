/**
 * Streaming & Approval flow — stream processing, tool approval lifecycle,
 * quorum voting, timeout management.
 *
 * Extracted from MotebitRuntime to keep the orchestrator focused on
 * wiring rather than stream processing bookkeeping.
 */

import type {
  MotebitState,
  ToolRegistry,
  ToolResult,
  ConversationMessage,
  ApprovalStoreAdapter,
} from "@motebit/sdk";
import type { BehaviorCues } from "@motebit/sdk";
import type { AgenticChunk, TurnResult } from "@motebit/ai-core";
import { extractStateTags, runTurnStreaming } from "@motebit/ai-core";
import type { MotebitLoopDependencies } from "@motebit/ai-core";
import type { SignableToolInvocationReceipt } from "@motebit/crypto";
import { signToolInvocationReceipt, hashToolPayload } from "@motebit/crypto";
import type { StreamChunk } from "./runtime-config.js";

// Re-import the helper — it's file-local in index.ts, so we duplicate it here.
// Exact copy of the function from index.ts.
function stripDisplayTags(text: string): { clean: string; pending: string } {
  const clean = text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/<parameter\s+[^>]*>[\s\S]*?<\/parameter>/g, "")
    .replace(/<\/?(?:artifact|function_calls|invoke|antml)[^>]*>/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\][\s\S]*?\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\][\s\S]*?\[\/MEMORY_DATA\]/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\]/g, "")
    .replace(/\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\]/g, "")
    .replace(/\[\/MEMORY_DATA\]/g, "")
    .replace(/\*{1,3}/g, "")
    .replace(/ {2,}/g, " ");

  for (const tag of ["<memory", "<thinking", "<parameter"]) {
    const lastOpen = clean.lastIndexOf(tag);
    if (lastOpen !== -1) {
      const closeTag = `</${tag.slice(1)}>`;
      const afterOpen = clean.slice(lastOpen);
      if (!afterOpen.includes(closeTag)) {
        return { clean: clean.slice(0, lastOpen), pending: clean.slice(lastOpen) };
      }
    }
  }

  const lastOpen = clean.lastIndexOf("<");
  if (lastOpen !== -1 && !clean.includes(">", lastOpen)) {
    return { clean: clean.slice(0, lastOpen), pending: clean.slice(lastOpen) };
  }
  return { clean, pending: "" };
}

/** Dependencies injected by the runtime. */
export interface StreamingDeps {
  /** Push partial state updates into the state vector. */
  pushStateUpdate(update: Partial<MotebitState>): void;
  /** Set creature speaking activity. */
  setSpeaking(active: boolean): void;
  /** Set creature delegating state. */
  setDelegating(active: boolean): void;
  /** Map of tool names to motebit server names (delegation detection). */
  getMotebitToolServers(): Map<string, string>;
  /** Accumulate behavioral stats from a turn result. */
  accumulateTurnStats(result: TurnResult): void;
  /** Push a user+assistant exchange into conversation history. */
  pushExchange(userMessage: string, assistantResponse: string): void;
  /** Push assistant-only activation into conversation history. */
  pushActivation(assistantResponse: string): void;
  /** Inject intermediate messages (tool call + result) into conversation history. */
  injectIntermediateMessages(assistantMsg: ConversationMessage, userMsg: ConversationMessage): void;
  /** Log a tool usage event. */
  logToolUsed(toolName: string, result: unknown): void;
  /** Get live conversation history (for continuation turns). */
  getLiveHistory(): ConversationMessage[];
  /** Tool registry for executing approved tools. */
  getToolRegistry(): ToolRegistry;
  /** Policy gate — sanitize tool results. */
  sanitizeToolResult(
    result: ToolResult,
    toolName: string,
  ): { result: ToolResult; injectionDetected?: boolean; injectionPatterns?: string[] };
  /** Current loop deps (for continuation turns). */
  getLoopDeps(): MotebitLoopDependencies | null;
  /** Current latest cues (for continuation turns). */
  getLatestCues(): BehaviorCues;
  /** Approval store for quorum persistence. */
  getApprovalStore(): ApprovalStoreAdapter | null;
  /** Approval timeout in ms. */
  approvalTimeoutMs: number;
  /** Redact secrets from arbitrary text (defense-in-depth at the streaming boundary). */
  redactText(text: string): string;
  /** Motebit ID. */
  motebitId: string;
  /**
   * Device ID this runtime is signing with. Embedded on every
   * `ToolInvocationReceipt` the streaming manager emits so per-call
   * receipts are auditable per-device, not just per-motebit. Optional
   * on the type for source-compatibility with legacy deps; absent
   * deps skip receipt emission fail-closed (no unsigned artifact
   * leaves the runtime — downstream subscribers just get no stream
   * from this runtime, and that's the honest signal).
   */
  getDeviceId?: () => string | null;
  /**
   * Ed25519 private key bytes for the active signing identity. Returns
   * `null` when the runtime hasn't unlocked the key (pre-login, sealed).
   * The streaming manager calls this lazily on every receipt emission so
   * a late-arriving unlock starts producing receipts without a restart;
   * a sealed-again transition returns the motebit to fail-closed silence
   * on the same cycle.
   */
  getSigningPrivateKey?: () => Uint8Array | null;
  /**
   * Matching Ed25519 public key (32 bytes). When present, the signer
   * embeds its hex encoding on every emitted receipt so a third-party
   * verifier can validate without a relay lookup — the
   * relay-optional-settlement property extended from task receipts to
   * per-call receipts.
   */
  getSigningPublicKey?: () => Uint8Array | null;
  /**
   * Sink for signed `ToolInvocationReceipt`s. Called exactly once per
   * matched `tool_status.calling` + `tool_status.done` pair, after the
   * receipt has been composed + signed via `signToolInvocationReceipt`.
   *
   * The slab projection subscribes to this (via the runtime's
   * `projectSlabForTurn` wrapper); panels + telemetry subscribe
   * as peers. Subscribers MUST NOT mutate the receipt (frozen by
   * `signToolInvocationReceipt`) or block the generator — they get
   * fire-and-forget delivery and any exception is logged and dropped.
   */
  onToolInvocation?: (receipt: SignableToolInvocationReceipt) => void;
  /**
   * Sink for live tool-invocation activity — the raw args + result
   * bytes the receipt's `args_hash` / `result_hash` commit to. Fires
   * at the same point as `onToolInvocation`, with a payload shaped
   * for rendering (slab items in virtual_browser mode read
   * `args.url` and the fetched content from `result`).
   *
   * Separate channel from `onToolInvocation` on purpose: the receipt
   * is a signed audit artifact that commits to hashes only, so the
   * signed wire stays thin and sensitive content never sits in a
   * persisted receipt. Activity is ephemeral UX context — the slab
   * (via projectSlabForTurn) consumes it to render what the motebit
   * is currently doing, then the next activity event supersedes it.
   * Callers that only want audit use `onToolInvocation`; callers
   * that only want live UX use `onToolActivity`; the slab uses both.
   *
   * Subscribers MUST NOT retain the payload beyond the call — the
   * args and result are not part of the audit trail and may contain
   * sensitive content that is deliberately not signed.
   */
  onToolActivity?: (event: ToolActivityEvent) => void;
}

/**
 * Payload shape for the `onToolActivity` sink. Carries the raw bytes
 * the receipt's hashes commit to, so the slab (in virtual_browser
 * mode) can render live content (e.g. the fetched page of a `read_url` call)
 * without waiting for the signed receipt to be composed.
 *
 * The `invocation_id` matches `ToolInvocationReceipt.invocation_id`
 * for the same call, letting consumers correlate activity rows to
 * audit rows without a separate key.
 */
export interface ToolActivityEvent {
  invocation_id: string;
  task_id: string | undefined;
  tool_name: string;
  args: Record<string, unknown>;
  result: unknown;
  started_at: number;
  completed_at: number;
}

interface PendingApproval {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  userMessage: string;
  runId?: string;
  quorum?: { required: number; approvers: string[]; collected: string[] };
}

export class StreamingManager {
  private _pendingApproval: PendingApproval | null = null;
  private approvalTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalExpiredCallback: (() => void) | null = null;
  private _isProcessing = false;

  constructor(private readonly deps: StreamingDeps) {}

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  set isProcessing(val: boolean) {
    this._isProcessing = val;
  }

  get hasPendingApproval(): boolean {
    return this._pendingApproval !== null;
  }

  get pendingApprovalInfo(): {
    toolName: string;
    args: Record<string, unknown>;
    quorum?: { required: number; approvers: string[]; collected: string[] };
  } | null {
    if (!this._pendingApproval) return null;
    return {
      toolName: this._pendingApproval.toolName,
      args: this._pendingApproval.args,
      quorum: this._pendingApproval.quorum,
    };
  }

  /** Clear pending approval state (called when starting a new message). */
  clearPendingApproval(): void {
    this._pendingApproval = null;
  }

  /** Shared stream processing — extracts state tags, handles tool/approval/injection chunks. */
  async *processStream(
    stream: AsyncGenerator<AgenticChunk>,
    userMessage: string,
    runId?: string,
    options?: { activationOnly?: boolean; suppressHistory?: boolean },
  ): AsyncGenerator<StreamChunk> {
    let result: TurnResult | null = null;
    let accumulated = "";
    let yieldedCleanLength = 0;

    // State tags are collected during streaming but applied once at the end.
    // The creature's only visible change while speaking is the processing glow
    // and speaking activity. This is the physics of surface tension: perturbation
    // → oscillation → new equilibrium. Not snap-snap-snap.
    let pendingStateUpdates: Partial<MotebitState> = {};

    const motebitToolServers = this.deps.getMotebitToolServers();

    // Per-turn tool-invocation bookkeeping. Maps tool_call_id (from
    // ai-core's AgenticChunk.tool_status) to the "calling" snapshot so
    // the matching "done" can compose a ToolInvocationReceipt. Scoped
    // to this processStream invocation — cleared implicitly when the
    // generator returns. A tool call that never produces a "done" (e.g.
    // the turn aborts) leaves the entry in the map, which is harmless:
    // the map is discarded with the generator.
    const pendingToolCalls = new Map<
      string,
      { toolName: string; args: Record<string, unknown>; startedAt: number }
    >();

    for await (let chunk of stream) {
      // Deferred memory-formation chunks are an internal runtime
      // protocol handled by `MotebitRuntime._catchDeferredFormationChunks`
      // before reaching this streaming wrapper. Guard here as a
      // belt-and-suspenders: if the wrapper path ever shifts, we drop
      // the internal chunk cleanly instead of leaking it to the UI.
      if (chunk.type === "memory_formation_deferred") continue;
      if (chunk.type === "text") {
        accumulated += chunk.text;

        // Collect state updates — don't apply yet
        const stateUpdates = extractStateTags(accumulated);
        if (Object.keys(stateUpdates).length > 0) {
          pendingStateUpdates = { ...pendingStateUpdates, ...stateUpdates };
        }
      }

      // Creature reacts to tool activity
      if (chunk.type === "tool_status") {
        const motebitServer = motebitToolServers.get(chunk.name);
        if (chunk.status === "calling") {
          this.deps.pushStateUpdate({ processing: 0.95 });
          // Snapshot for the ToolInvocationReceipt signer (matched when
          // the corresponding "done" arrives). Skip silently if ai-core
          // omitted the fields — old emitters or hand-built streams.
          if (
            typeof chunk.tool_call_id === "string" &&
            chunk.args !== undefined &&
            typeof chunk.started_at === "number"
          ) {
            pendingToolCalls.set(chunk.tool_call_id, {
              toolName: chunk.name,
              args: chunk.args,
              startedAt: chunk.started_at,
            });
          }
          // Emit delegation_start for motebit MCP tools
          if (motebitServer) {
            this.deps.setDelegating(true);
            yield { type: "delegation_start", server: motebitServer, tool: chunk.name };
          }
        } else if (chunk.status === "done") {
          // Defense-in-depth: redact secrets from tool results at the streaming
          // boundary BEFORE they reach the client. ai-core sanitizes upstream,
          // but the streaming boundary is the last checkpoint before bits leave
          // the droplet. A gap in ai-core must not leak secrets to the UI.
          if (chunk.result != null) {
            const resultText =
              typeof chunk.result === "string" ? chunk.result : JSON.stringify(chunk.result);
            const redacted = this.deps.redactText(resultText);
            if (redacted !== resultText) {
              chunk = { ...chunk, result: redacted };
            }
          }
          this.deps.pushStateUpdate({ processing: 0.6 });
          this.deps.logToolUsed(chunk.name, chunk.result);
          // Per-tool-call signed receipt: match with the earlier
          // "calling" snapshot by tool_call_id, compose, sign, fire
          // the invocation sink. Fail-closed at every branch — no
          // unsigned or half-composed artifact leaves the runtime.
          if (typeof chunk.tool_call_id === "string") {
            const pending = pendingToolCalls.get(chunk.tool_call_id);
            if (pending) {
              pendingToolCalls.delete(chunk.tool_call_id);
              const completedAt = Date.now();
              // Fire the ephemeral activity channel FIRST — slab
              // items in virtual_browser mode respond to this
              // immediately; the signed receipt follows microseconds
              // later. Each sink is independent and fail-closed.
              this.fireToolActivity({
                invocation_id: chunk.tool_call_id,
                task_id: runId,
                tool_name: chunk.name,
                args: pending.args,
                result: chunk.result,
                started_at: pending.startedAt,
                completed_at: completedAt,
              });
              await this.emitToolInvocationReceipt({
                invocation_id: chunk.tool_call_id,
                task_id: runId,
                tool_name: chunk.name,
                args: pending.args,
                result: chunk.result,
                started_at: pending.startedAt,
                completed_at: completedAt,
              });
            }
          }
          // Emit delegation_complete for motebit MCP tools
          if (motebitServer) {
            // Extract receipt summary if this was a motebit_task call with a receipt result.
            // When the full signed receipt is present (motebit_task), also forward it so
            // callers (e.g. the web receipt artifact) can render and verify the chain.
            let receiptSummary:
              | { task_id: string; status: string; tools_used: string[] }
              | undefined;
            let fullReceipt: import("@motebit/sdk").ExecutionReceipt | undefined;
            if (chunk.result != null && typeof chunk.result === "object") {
              const r = chunk.result as Record<string, unknown>;
              if (
                typeof r.task_id === "string" &&
                typeof r.status === "string" &&
                Array.isArray(r.tools_used)
              ) {
                receiptSummary = {
                  task_id: r.task_id,
                  status: r.status,
                  tools_used: r.tools_used as string[],
                };
                // Full receipt discriminator: a motebit signed receipt carries
                // `signature` + `motebit_id`. The summary above uses only the
                // subset that existed before — forwarding the full record is
                // additive.
                if (typeof r.signature === "string" && typeof r.motebit_id === "string") {
                  fullReceipt = r as unknown as import("@motebit/sdk").ExecutionReceipt;
                }
              }
            }
            this.deps.setDelegating(false);
            yield {
              type: "delegation_complete",
              server: motebitServer,
              tool: chunk.name,
              receipt: receiptSummary,
              full_receipt: fullReceipt,
            };
          }
        }
      }

      // Approval request: capture pending state and start timeout
      if (chunk.type === "approval_request") {
        this._pendingApproval = {
          toolCallId: chunk.tool_call_id,
          toolName: chunk.name,
          args: chunk.args,
          userMessage,
          runId,
          quorum: chunk.quorum,
        };

        // Persist quorum metadata to the approval store (source of truth)
        const approvalStore = this.deps.getApprovalStore();
        if (chunk.quorum && approvalStore) {
          approvalStore.setQuorum(
            chunk.tool_call_id,
            chunk.quorum.required,
            chunk.quorum.approvers,
          );
        }

        this.startApprovalTimeout();
        this.deps.pushStateUpdate({ processing: 0.5 });
      }

      // Injection warning — processing dips, personality shifts deferred
      if (chunk.type === "injection_warning") {
        this.deps.pushStateUpdate({ processing: 0.3 });
      }

      // Strip state/memory/action tags from text before yielding to UI
      if (chunk.type === "text") {
        // trimStart: tags before text leave orphaned newlines
        const clean = stripDisplayTags(accumulated).clean.trimStart();
        let delta = clean.slice(yieldedCleanLength);
        if (delta) {
          // Defense-in-depth: redact secrets from AI text at the streaming
          // boundary. Pattern-based redaction works on partial text fragments.
          delta = this.deps.redactText(delta);
          yieldedCleanLength += clean.slice(yieldedCleanLength).length;
          yield { type: "text" as const, text: delta };
        }
      } else {
        yield chunk;
      }
      if (chunk.type === "result") {
        result = chunk.result;
        // Accumulate behavioral stats for the intelligence gradient
        this.deps.accumulateTurnStats(result);
      }
    }

    if (result) {
      // Scheduled runs (suppressHistory) don't appear in the chat
      // conversation at all — they surface through the slab via
      // the projection wrapper and list in the Goals panel. Skipping
      // the chat push keeps recurring background tasks from polluting
      // the dialogue the user is having with the motebit.
      if (options?.suppressHistory) {
        // no history push — scheduled/background run
      } else if (options?.activationOnly) {
        this.deps.pushActivation(result.response);
      } else {
        this.deps.pushExchange(userMessage, result.response);
      }
    }

    // Apply collected state updates as the creature settles into new equilibrium
    if (Object.keys(pendingStateUpdates).length > 0) {
      this.deps.pushStateUpdate(pendingStateUpdates);
    }
  }

  async *resumeAfterApproval(approved: boolean): AsyncGenerator<StreamChunk> {
    // Clear timeout FIRST to prevent the race where timeout fires between
    // our check and the state mutation (timeout sets _pendingApproval = null).
    this.clearApprovalTimeout();

    if (!this._pendingApproval) {
      // Timeout already fired — approval came too late. The timeout handler
      // already injected a denial into conversation history, so this is a no-op.
      return;
    }
    const loopDeps = this.deps.getLoopDeps();
    if (!loopDeps) throw new Error("AI not initialized");

    const pending = this._pendingApproval;
    this._pendingApproval = null;
    this._isProcessing = true;
    this.deps.pushStateUpdate({ processing: 0.9, attention: 0.8 });
    this.deps.setSpeaking(true);

    try {
      if (approved) {
        // Execute the tool directly
        yield { type: "tool_status" as const, name: pending.toolName, status: "calling" as const };
        const toolRegistry = this.deps.getToolRegistry();
        const result = await toolRegistry.execute(pending.toolName, pending.args);

        // Sanitize through policy if available
        const check = this.deps.sanitizeToolResult(result, pending.toolName);
        const sanitized = check.result;
        if (check.injectionDetected) {
          yield {
            type: "injection_warning" as const,
            tool_name: pending.toolName,
            patterns: check.injectionPatterns!,
          };
        }

        yield {
          type: "tool_status" as const,
          name: pending.toolName,
          status: "done" as const,
          result: sanitized.data ?? sanitized.error,
        };
        this.deps.logToolUsed(pending.toolName, sanitized.data ?? sanitized.error);

        // Push tool call + result into conversation history for continuation
        this.deps.injectIntermediateMessages(
          {
            role: "assistant" as const,
            content: `[tool_use: ${pending.toolName}(${JSON.stringify(pending.args)})]`,
          },
          { role: "user" as const, content: `[tool_result: ${JSON.stringify(sanitized)}]` },
        );
      } else {
        // Push denial into conversation history
        this.deps.injectIntermediateMessages(
          {
            role: "assistant" as const,
            content: `[tool_use: ${pending.toolName}(${JSON.stringify(pending.args)})]`,
          },
          {
            role: "user" as const,
            content: `[tool_result: {"ok":false,"error":"User denied this tool call."}]`,
          },
        );
      }

      // Run continuation turn with updated history
      const stream = runTurnStreaming(loopDeps, pending.userMessage, {
        conversationHistory: this.deps.getLiveHistory(),
        previousCues: this.deps.getLatestCues(),
        runId: pending.runId,
      });
      yield* this.processStream(stream, pending.userMessage, pending.runId);
    } finally {
      this.deps.setSpeaking(false);
      this.deps.pushStateUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
    }
  }

  /**
   * Record a single approval vote for multi-party (quorum) approval.
   * - If no quorum is configured, delegates to resumeAfterApproval (backward compat).
   * - A deny vote immediately denies (fail-closed).
   * - Duplicate votes are ignored.
   * - Quorum state is persisted in the approval store (source of truth),
   *   not held in mutable runtime memory.
   */
  async *resolveApprovalVote(approved: boolean, approverId: string): AsyncGenerator<StreamChunk> {
    // Clear timeout before checking state — prevents race where timeout
    // fires between our check and the state mutation.
    this.clearApprovalTimeout();

    if (!this._pendingApproval) {
      // Timeout already fired — approval came too late.
      return;
    }

    // No quorum — single-approval behavior
    if (!this._pendingApproval.quorum) {
      yield* this.resumeAfterApproval(approved);
      return;
    }

    // Deny vote = immediate deny (fail-closed)
    if (!approved) {
      yield* this.resumeAfterApproval(false);
      return;
    }

    // Delegate to persistence store — it is the source of truth for quorum state.
    // Runtime is a pure observer: read from store, never mutate local quorum state.
    const approvalStore = this.deps.getApprovalStore();
    if (approvalStore) {
      const result = approvalStore.collectApproval(this._pendingApproval.toolCallId, approverId);

      if (result.met) {
        yield* this.resumeAfterApproval(true);
      }
      // Otherwise: still waiting for more votes — runtime does not touch local state
    } else {
      // Fallback for environments without persistence (tests, in-memory).
      // Still correct: single-process, single-runtime — no drift risk.
      const quorum = this._pendingApproval.quorum;
      if (quorum.collected.includes(approverId)) return;
      quorum.collected.push(approverId);
      if (quorum.collected.length >= quorum.required) {
        yield* this.resumeAfterApproval(true);
      }
    }
  }

  /**
   * Register a callback invoked when a pending approval expires.
   * Apps should use this to auto-deny and update UI (e.g. dismiss dialog, show toast).
   */
  onApprovalExpired(cb: () => void): void {
    this.approvalExpiredCallback = cb;
  }

  startApprovalTimeout(): void {
    this.clearApprovalTimeout();
    if (this.deps.approvalTimeoutMs <= 0) return;
    this.approvalTimer = setTimeout(() => {
      if (!this._pendingApproval) return;
      const expired = this._pendingApproval;
      this._pendingApproval = null;
      // Push denial into conversation history so LLM sees it on next turn
      this.deps.injectIntermediateMessages(
        {
          role: "assistant" as const,
          content: `[tool_use: ${expired.toolName}(${JSON.stringify(expired.args)})]`,
        },
        {
          role: "user" as const,
          content: `[tool_result: {"ok":false,"error":"Approval timed out after ${this.deps.approvalTimeoutMs}ms"}]`,
        },
      );
      this.deps.pushStateUpdate({ processing: 0.1, attention: 0.3 });
      this._isProcessing = false;
      this.approvalExpiredCallback?.();
    }, this.deps.approvalTimeoutMs);
  }

  clearApprovalTimeout(): void {
    if (this.approvalTimer) {
      clearTimeout(this.approvalTimer);
      this.approvalTimer = null;
    }
  }

  /**
   * Fire the raw activity event to the live UX channel (if wired).
   * No signing, no hashing — this is the ephemeral "what the motebit
   * is doing right now" stream the slab (in virtual_browser mode)
   * consumes. Subscribers that throw are isolated from each other
   * and from the signed-receipt path.
   */
  private fireToolActivity(event: ToolActivityEvent): void {
    const sink = this.deps.onToolActivity;
    if (!sink) return;
    try {
      sink(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- diagnostic on consumer fault
      console.warn(`[streaming] onToolActivity sink threw: ${msg}`);
    }
  }

  /**
   * Compose and sign a `ToolInvocationReceipt` for one matched
   * calling→done pair, then deliver it to the invocation sink.
   *
   * Fail-closed at every dependency boundary:
   *   - no `onToolInvocation` sink → drop silently (consumer opted out)
   *   - no device_id, private key, or motebit_id → drop silently (key
   *     not yet unlocked, or this deps shape predates the hook)
   *   - signing throws → log a warning and drop (never leak partial)
   *   - sink throws → log and swallow (receipt is delivered; the
   *     consumer's handler fault is theirs)
   *
   * Hashing is via `hashToolPayload` (JCS canonical + SHA-256) on the
   * args and on the result bytes that will actually ship to the UI —
   * i.e. post-redaction. A verifier holding the same bytes recomputes
   * and matches; a verifier holding the pre-redaction bytes will not
   * match, which is the honest signal that redaction happened.
   */
  private async emitToolInvocationReceipt(params: {
    invocation_id: string;
    task_id: string | undefined;
    tool_name: string;
    args: Record<string, unknown>;
    result: unknown;
    started_at: number;
    completed_at: number;
  }): Promise<void> {
    const sink = this.deps.onToolInvocation;
    if (!sink) return;
    const deviceId = this.deps.getDeviceId?.() ?? null;
    const privateKey = this.deps.getSigningPrivateKey?.() ?? null;
    const publicKey = this.deps.getSigningPublicKey?.() ?? null;
    if (!deviceId || !privateKey || !this.deps.motebitId) return;

    try {
      const argsHash = await hashToolPayload(params.args);
      const resultHash = await hashToolPayload(params.result === undefined ? null : params.result);
      const unsigned: Omit<SignableToolInvocationReceipt, "signature" | "suite"> = {
        invocation_id: params.invocation_id,
        task_id: params.task_id ?? params.invocation_id,
        motebit_id: this.deps.motebitId,
        device_id: deviceId,
        tool_name: params.tool_name,
        started_at: params.started_at,
        completed_at: params.completed_at,
        // status is "completed" for any tool that yielded a "done" chunk;
        // finer-grained discrimination (failed / denied) lands when
        // ai-core threads an explicit status through the chunk shape.
        status: "completed",
        args_hash: argsHash,
        result_hash: resultHash,
        invocation_origin: "ai-loop",
      };
      const signed = await signToolInvocationReceipt(unsigned, privateKey, publicKey ?? undefined);
      try {
        sink(signed);
      } catch (err) {
        // The sink is a consumer's handler; its failure must not
        // poison the streaming generator. Log and move on.
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console -- diagnostic on consumer fault
        console.warn(`[streaming] onToolInvocation sink threw: ${msg}`);
      }
    } catch (err) {
      // Signing failure: no partial artifact leaks. Log and drop.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- diagnostic on sign fault
      console.warn(`[streaming] tool-invocation-receipt sign failed: ${msg}`);
    }
  }
}
