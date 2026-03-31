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
import type { StreamChunk } from "./index.js";

// Re-import the helper — it's file-local in index.ts, so we duplicate it here.
// Exact copy of the function from index.ts.
function stripDisplayTags(text: string): { clean: string; pending: string } {
  const clean = text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/<parameter\s+[^>]*>[\s\S]*?<\/parameter>/g, "")
    .replace(/<\/?(?:artifact|function_calls|invoke|antml)[^>]*>/g, "")
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
    options?: { activationOnly?: boolean },
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

    for await (let chunk of stream) {
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
          // Emit delegation_complete for motebit MCP tools
          if (motebitServer) {
            // Extract receipt summary if this was a motebit_task call with a receipt result
            let receiptSummary:
              | { task_id: string; status: string; tools_used: string[] }
              | undefined;
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
              }
            }
            this.deps.setDelegating(false);
            yield {
              type: "delegation_complete",
              server: motebitServer,
              tool: chunk.name,
              receipt: receiptSummary,
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
      if (options?.activationOnly) {
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
}
