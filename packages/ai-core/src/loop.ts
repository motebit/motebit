import type {
  BehaviorCues,
  MotebitState,
  MemoryNode,
  MemoryCandidate,
  ToolRegistry,
  ToolDefinition,
  ToolResult,
  ToolRiskProfile,
  PolicyDecision,
  TurnContext,
  ConversationMessage,
} from "@motebit/sdk";
import { EventType, SensitivityLevel, rankSensitivity } from "@motebit/sdk";
import type { SensitivityCleared } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MemoryGraph, ConsolidationProvider } from "@motebit/memory-graph";
import { embedText, formMemoriesFromCandidates } from "@motebit/memory-graph";
import type { StateVectorEngine } from "@motebit/state-vector";
import type { BehaviorEngine } from "@motebit/behavior-engine";
import type { StreamingProvider } from "./index.js";
import { inferStateFromText } from "./infer-state.js";
import { isSelfReferential, withStageTimeout, STAGE_TIMEOUTS_MS } from "./core.js";
import { detectDishonestClosing } from "./dishonest-closing.js";
import type { ToolResultLogEntry } from "./dishonest-closing.js";
import { validateTaskStepNarration } from "./narration-validation.js";

// === Constants ===

const MAX_TOOL_ITERATIONS = 10;

/**
 * Deterministic closing-message synthesis — the runtime hard floor
 * that guarantees every turn ends with at least one visible sentence.
 *
 * Called at the loop's exit when `finalText` is still empty after the
 * existing empty-text safety-net (the re-prompt without tools). Pure
 * function over the loop's exit state; cannot return empty.
 *
 * The four shapes:
 *
 *   - **Failure-only** (`toolCallsFailed > 0 && toolCallsSucceeded === 0`):
 *     no actions landed. Honest about the outcome; invites the user
 *     to redirect.
 *
 *   - **Partial success** (`toolCallsSucceeded > 0 && toolCallsFailed > 0`):
 *     some actions completed, some didn't. Names the count and the
 *     last tool attempted so the user knows where motebit stopped.
 *
 *   - **All success** (`toolCallsSucceeded > 0 && toolCallsFailed === 0`):
 *     everything went through. The model's silence is honest ("nothing
 *     more to say"); the floor just acknowledges and yields the turn
 *     back to the user.
 *
 *   - **Zero actions** (`toolCallsSucceeded === 0 && toolCallsFailed === 0`):
 *     the model emitted no tool calls and no text. Most likely a
 *     model-state weirdness; the floor confesses and invites
 *     redirection.
 *
 * Doctrine: motebit-computer.md §"Typed truth on results" applied to
 * the turn-completion contract. The runtime promises the user a
 * response per message; this is the mechanical floor that enforces
 * the promise even when model behavior drifts.
 */
export function synthesizeClosingFallback(args: {
  readonly toolCallsSucceeded: number;
  readonly toolCallsFailed: number;
  readonly lastToolName: string;
}): string {
  const { toolCallsSucceeded, toolCallsFailed, lastToolName } = args;
  if (toolCallsFailed > 0 && toolCallsSucceeded === 0) {
    return lastToolName
      ? `I tried but \`${lastToolName}\` didn't go through — what would you like me to try next?`
      : "I tried but couldn't complete that — what would you like me to try next?";
  }
  if (toolCallsSucceeded > 0 && toolCallsFailed > 0) {
    return lastToolName
      ? `I got partway through (${toolCallsSucceeded}/${toolCallsSucceeded + toolCallsFailed} succeeded) but \`${lastToolName}\` didn't land. What should I do next?`
      : `I got partway through (${toolCallsSucceeded}/${toolCallsSucceeded + toolCallsFailed} succeeded) but hit an issue. What should I do next?`;
  }
  if (toolCallsSucceeded > 0) {
    return "Done. Let me know what's next.";
  }
  return "I didn't take any action there — what would you like me to do?";
}

// === Missed-memory heuristic detection ===

const PREFERENCE_RE = /\b(?:i\s+(?:like|prefer|love|enjoy|hate|dislike|can't stand))\s+(.{3,60})/gi;
const PERSONAL_FACT_RE =
  /\b(?:i(?:'m|\s+am)\s+from|i\s+live\s+in|i\s+work\s+at|my\s+name\s+is|i(?:'m|\s+am)\s+a\b)\s+(.{2,60})/gi;
const GOAL_RE =
  /\b(?:i\s+want\s+to|i(?:'m|\s+am)\s+planning\s+to|i\s+need\s+to|i(?:'m|\s+am)\s+trying\s+to|my\s+goal\s+is)\s+(.{3,80})/gi;
const CORRECTION_RE =
  /\b(?:actually,?\s+i\s+meant|no,?\s+i\s+(?:said|mean)|i\s+meant\s+to\s+say)\s+(.{3,80})/gi;

/**
 * Lightweight heuristic check for memory-worthy patterns in conversation text
 * that the model did not tag with <memory>. For audit/logging only — does NOT
 * create memories (false positive risk is too high for automatic formation).
 */
export function detectUntaggedMemoryPatterns(
  userMessage: string,
  aiResponse: string,
  taggedMemories: MemoryCandidate[],
): string[] {
  const taggedLower = taggedMemories.map((m) => m.content.toLowerCase());

  function isAlreadyCaptured(matchText: string): boolean {
    const lower = matchText.toLowerCase().trim();
    return taggedLower.some((t) => t.includes(lower) || lower.includes(t));
  }

  const patterns: { label: string; re: RegExp; source: string }[] = [
    { label: "preference", re: PREFERENCE_RE, source: userMessage },
    { label: "personal_fact", re: PERSONAL_FACT_RE, source: userMessage },
    { label: "goal", re: GOAL_RE, source: userMessage },
    { label: "correction", re: CORRECTION_RE, source: userMessage },
    // Also scan AI response for preferences/facts it acknowledged but didn't tag
    { label: "preference_in_response", re: PREFERENCE_RE, source: aiResponse },
  ];

  const detected: string[] = [];

  for (const { label, re, source } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const captured = match[1]?.trim();
      if (captured != null && captured !== "" && !isAlreadyCaptured(captured)) {
        detected.push(`${label}: "${match[0].trim()}"`);
      }
    }
  }

  return detected;
}

// === Inline boundary wrapping (no dependency on @motebit/policy) ===

const EXTERNAL_DATA_START = "[EXTERNAL_DATA source=";
const EXTERNAL_DATA_END = "[/EXTERNAL_DATA]";

function wrapExternalData(data: unknown, toolName: string): string {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const escaped = text
    .replace(/\[EXTERNAL_DATA\b/g, "[ESCAPED_DATA")
    .replace(/\[\/EXTERNAL_DATA\]/g, "[/ESCAPED_DATA]");
  const safeName = toolName.replace(/[[\]"\\]/g, "_").slice(0, 100);
  return `${EXTERNAL_DATA_START}"tool:${safeName}"]\n${escaped}\n${EXTERNAL_DATA_END}`;
}

/**
 * Project a tool result into the shape the AI should see in
 * conversation history. The slab and the AI have different needs:
 *
 *   - The slab consumes structured wire shapes by field — it needs
 *     the raw bytes_base64 to render the screenshot iframe.
 *   - The AI consumes the text representation of tool results to
 *     decide its next step. For text content, the AI reads it; for
 *     pixel content, whether the AI receives bytes depends on a
 *     three-gate composition (sovereignty, sensitivity, consent).
 *
 * **Pixel governance (vision-1 slice).** Pixels are governed evidence,
 * not automatic external context. Three gates compose around byte
 * passthrough:
 *
 *   1. Provider sovereignty — `on-device` providers always receive
 *      pixels. The bytes never leave the device, so there is no
 *      external party for the user to consent to.
 *   2. Session sensitivity — medical / financial / secret sessions
 *      with an external provider always strip pixels. Same fail-
 *      closed shape as `assertSensitivityPermitsAiCall` for outbound
 *      text. The session-tier elevation is the user's already-
 *      expressed boundary; the gate composes through.
 *   3. Pixel consent — for external providers at unelevated
 *      sensitivity, the user must explicitly grant pixel passthrough
 *      via the `/vision grant` affordance. Defaults to `denied` for
 *      every fresh session (fail-closed). Surface-determinism
 *      (Principle 90) — the consent gate is a typed affordance, not
 *      an AI prompt asking "may I see?".
 *
 * When pixels are stripped, the `bytes_omitted` directive carries a
 * structured `reason` (`consent_required` / `sensitivity_blocked` /
 * `no_capability`) so the perception doctrine can route the AI to
 * the right remediation surface (the affordance), not bridge to
 * "what's typical from training" — which was the failure mode
 * witnessed before this slice landed (the model bluffing visual
 * properties from training memory and confabulating fail-closed
 * gates that never fired).
 *
 * The redactor-mangling concern (witnessed 2026-05-07: base64 strings
 * matched secret-detection regexes and were wrapped in
 * `[REDACTED:ENCODED_SECRET]`) stays addressed even when bytes pass
 * through — the projection happens before sanitization, and the
 * downstream redactor's content classifier MUST exempt bytes_base64
 * fields. That guard lives in the redactor, not here.
 *
 * Per-kind handling: only screenshot + navigate-frame today. Add
 * other byte-payload kinds (image embedding result, file download
 * result) here when their tools land. The transformation is
 * non-destructive — only fields the AI provably doesn't need
 * text-as-text are gated.
 */
export interface ProjectionContext {
  /** Provider mode at projection time. `null` = unset, treated as external (fail-closed). */
  readonly providerMode: import("@motebit/sdk").ProviderMode | null;
  /** Effective session sensitivity at projection time. */
  readonly sensitivity: SensitivityLevel;
  /** Per-session pixel passthrough consent. `denied` strips bytes; `session` allows when other gates permit. */
  readonly pixelConsent: import("@motebit/sdk").PixelConsentState;
}

const DEFAULT_PROJECTION_CONTEXT: ProjectionContext = {
  providerMode: null,
  sensitivity: SensitivityLevel.None,
  pixelConsent: "denied",
};

/**
 * Compose the three pixel gates and return either `null` (bytes
 * pass) or the structured strip reason. Pure function over the
 * context — testable in isolation, no side effects.
 */
function decidePixelGate(ctx: ProjectionContext): import("@motebit/sdk").PixelOmittedReason | null {
  // Gate 1 — sovereignty bypass. On-device providers never cross a
  // network boundary; the consent gate exists to govern external
  // disclosure, not the user's own machine.
  if (ctx.providerMode === "on-device") return null;
  // Gate 2 — sensitivity fail-closed. Medical / financial / secret
  // sessions with an external provider strip pixels regardless of
  // consent. The user's tier choice is the load-bearing signal.
  if (rankSensitivity(ctx.sensitivity) > rankSensitivity(SensitivityLevel.None)) {
    return "sensitivity_blocked";
  }
  // Gate 3 — explicit pixel consent for external providers at
  // sensitivity=none. Default `denied` is fail-closed; the surface
  // routes the user to `/vision grant` when the AI surfaces a
  // `consent_required` strip.
  if (ctx.pixelConsent !== "session") return "consent_required";
  return null;
}

function projectForAi(
  data: unknown,
  ctx: ProjectionContext = DEFAULT_PROJECTION_CONTEXT,
  onOmissionEmitted?: (reason: import("@motebit/sdk").PixelOmittedReason) => void,
): unknown {
  if (data == null || typeof data !== "object") return data;
  const r = data as Record<string, unknown>;
  // Two kinds carry inline pixel bytes today: the explicit
  // `screenshot` action and the `navigate` action (v1.3 hardening —
  // navigate captures inline so the slab gets a frame without a
  // separate screenshot action). Both compose through the same
  // gate — the privacy contract is provider-mode + sensitivity +
  // consent, not "always strip."
  if (
    (r.kind === "screenshot" || r.kind === "navigate") &&
    typeof r.bytes_base64 === "string" &&
    r.bytes_base64.length > 0
  ) {
    const reason = decidePixelGate(ctx);
    if (reason === null) {
      // Gate permitted — bytes pass through to the AI. The redactor
      // downstream must NOT scan bytes_base64 for secret patterns
      // (witnessed 2026-05-07: it lit base64 up as encoded secrets
      // and corrupted screenshots in transit). That guard lives in
      // the redactor; here we trust the upstream contract.
      return r;
    }
    // Notify the runtime that an omission fired, so the next turn's
    // [Now] block can mark the omission as stale if the gate has
    // since flipped. Same shape as `frame_stale`: typed wire field
    // + prompt clause + dispatch enforcement. Doctrine:
    // `motebit-computer.md` §"Typed truth on results."
    onOmissionEmitted?.(reason);
    const { bytes_base64: _bytes_base64, ...rest } = r;
    return {
      ...rest,
      // Structured reason lets the perception doctrine route to the
      // right remediation surface (slash command / slab band) without
      // parsing human text. Witnessed 2026-05-08: a terse marker ("you
      // have not seen this image") let the AI bluff visual details
      // from training memory ("the little orange Y logo") and
      // confabulate gates that never fired ("there's a sensitivity
      // hold I can't clear"). The directive below names the EXACT
      // remediation per gate so the AI can hand the user a typed
      // affordance instead of inferring.
      bytes_omitted_reason: reason,
      bytes_omitted: pixelOmittedDirective(reason, ctx),
    };
  }
  return data;
}

function pixelOmittedDirective(
  reason: import("@motebit/sdk").PixelOmittedReason,
  ctx: ProjectionContext,
): string {
  switch (reason) {
    case "consent_required":
      return (
        "Image rendered on the user's slab — bytes withheld from your context. " +
        "Reason: pixel passthrough not granted for this session. The user can " +
        "type `/vision grant` to allow you to see images this session. " +
        "Until then, you have NOT seen the image. Do not describe what's " +
        "visible. Do not bridge to 'what's typical' from training. Tell the " +
        "user the affordance, or ask them to be the witness."
      );
    case "sensitivity_blocked":
      return (
        "Image rendered on the user's slab — bytes withheld from your context. " +
        `Reason: session sensitivity is "${ctx.sensitivity}". External AI ` +
        "providers do not receive pixel bytes at elevated sensitivity tiers. " +
        "The user can drop sensitivity via `/sensitivity none` if appropriate. " +
        "Until then, you have NOT seen the image. Do not describe what's " +
        "visible. Do not bridge to 'what's typical' from training."
      );
    case "no_capability":
      return (
        "Image rendered on the user's slab — bytes withheld from your context. " +
        "Reason: the active AI provider does not support vision input. " +
        "You have NOT seen the image. Ask the user to switch providers if " +
        "visual perception is essential, or ask them to be the witness."
      );
  }
}

// === Types ===

/**
 * Minimal policy interface for the agentic loop.
 * ai-core does NOT depend on @motebit/policy — PolicyGate satisfies this
 * through structural typing.
 */
export interface LoopPolicyGate {
  filterTools(tools: ToolDefinition[]): ToolDefinition[];
  validate(tool: ToolDefinition, args: Record<string, unknown>, ctx: TurnContext): PolicyDecision;
  classify(tool: ToolDefinition): ToolRiskProfile;
  sanitizeResult(result: ToolResult, toolName: string): ToolResult;
  sanitizeAndCheck?(
    result: ToolResult,
    toolName: string,
  ): {
    result: ToolResult;
    injectionDetected: boolean;
    injectionPatterns: string[];
    directiveDensity?: number;
    structuralFlags?: string[];
  };
  logInjection?(
    turnId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    injection: {
      detected: boolean;
      patterns: string[];
      directiveDensity?: number;
      structuralFlags?: string[];
    },
    blocked: boolean,
    runId?: string,
  ): void;
  createTurnContext(runId?: string): TurnContext;
  recordToolCall(ctx: TurnContext, cost?: number): TurnContext;
}

/**
 * Duck-typed read of `.reason` from a thrown error. Typed errors
 * like `ComputerDispatcherError` (in `@motebit/runtime`) carry a
 * structured failure category alongside their message — when a
 * tool handler throws one of those instead of returning
 * `{ok: false, ...}`, this lifts the category onto the chunk so
 * downstream slab projection can route by category instead of
 * parsing the human-readable text. Returns `undefined` for plain
 * `Error` and any value without a string `reason` field.
 */
function extractErrorReason(err: unknown): string | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const r = (err as { reason?: unknown }).reason;
  return typeof r === "string" && r.length > 0 ? r : undefined;
}

/**
 * Minimal memory governance interface for the agentic loop.
 * MemoryGovernor from @motebit/policy satisfies this through structural typing.
 */
export interface LoopMemoryGovernor {
  evaluate(
    candidates: MemoryCandidate[],
  ): { candidate: MemoryCandidate; memoryClass: string; reason: string }[];
}

export interface MotebitLoopDependencies {
  motebitId: string;
  eventStore: EventStore;
  memoryGraph: MemoryGraph;
  stateEngine: StateVectorEngine;
  behaviorEngine: BehaviorEngine;
  provider: StreamingProvider;
  tools?: ToolRegistry;
  policyGate?: LoopPolicyGate;
  memoryGovernor?: LoopMemoryGovernor;
  consolidationProvider?: ConsolidationProvider;
  /**
   * Optional getter returning the runtime's effective session
   * sensitivity at memory-formation time — composed from the explicit
   * session tier AND any tier-bounded slab items (drops, classified
   * tool outputs). When provided, the loop floors each memory
   * candidate's sensitivity at this tier before passing the candidate
   * to the governor: a candidate the model assessed as `none` from a
   * `secret`-effective session lands as `secret`, and the governor's
   * `Sensitivity level is SECRET. Never stored.` arm rejects it.
   *
   * Closes the fourth-egress shape (after session-elevated state,
   * drops, and tool outputs): sensitive content from a high-tier turn
   * leaking into the memory graph un-tagged, then retrievable from
   * future low-tier sessions whose `CONTEXT_SAFE_SENSITIVITY` filter
   * sees only the model's chosen tier.
   *
   * Doctrine: `motebit-computer.md` §"Mode contract" + the closure of
   * the `sensitivity` ALLOWLIST entry in `check-mode-contract-readers`.
   * Optional because in-tree tests fixture the loop without a runtime;
   * production wiring threads `runtime.getEffectiveSessionSensitivity`.
   */
  getEffectiveSensitivity?: () => SensitivityLevel;
  /**
   * Provider mode at projection time — composed into `projectForAi`'s
   * pixel gate. `on-device` bypasses pixel stripping entirely (bytes
   * never leave the device); external modes flow through the
   * sensitivity + consent gates. `null` (or omitted getter) is treated
   * as external — fail-closed for surfaces that haven't declared.
   *
   * Doctrine: `pixel-consent.ts` § "Pixel governance composes three
   * gates." Production wiring threads `runtime.getProviderMode`.
   */
  getProviderMode?: () => import("@motebit/sdk").ProviderMode | null;
  /**
   * Per-session pixel passthrough consent — composed into
   * `projectForAi`'s pixel gate. Default `denied` strips bytes for
   * external providers regardless of sensitivity tier. Granted via
   * the `/vision grant` slash command on web (and the future
   * VisionConsentBand on the slab).
   *
   * Doctrine: `pixel-consent.ts` + `surface-determinism.md` (#90 —
   * consent is a typed affordance, not an AI prompt).
   */
  getPixelConsent?: () => import("@motebit/sdk").PixelConsentState;
  /**
   * Notify the runtime that `projectForAi` just emitted a
   * `bytes_omitted_reason` on a screenshot / navigate result.
   * Lets the runtime track "did the gate fire this conversation?"
   * so the next turn's [Now] block can mark the prior omission as
   * stale if the gate has since flipped.
   *
   * The runtime stores the most recent reason and compares against
   * the current gate state at snapshot time — if the same gate
   * would no longer fire (e.g., consent flipped from denied to
   * session, or sensitivity dropped from elevated to none), the
   * snapshot's `staleBytesOmissionReason` carries the prior reason
   * and the prompt teaches the AI to re-take rather than re-
   * recommend the affordance for the stale reason.
   *
   * Doctrine: `motebit-computer.md` §"Typed truth on results."
   */
  onPixelOmissionEmitted?: (reason: import("@motebit/sdk").PixelOmittedReason) => void;
}

export interface TurnResult {
  response: string;
  memoriesFormed: MemoryNode[];
  memoriesRetrieved: MemoryNode[];
  stateAfter: MotebitState;
  cues: BehaviorCues;
  /** Total token usage across all LLM calls in this turn, if available. */
  totalTokens?: number;
  /** Number of agentic loop iterations used in this turn. */
  iterations: number;
  /** Number of tool calls that executed successfully. */
  toolCallsSucceeded: number;
  /** Number of tool calls blocked by policy or requiring approval. */
  toolCallsBlocked: number;
  /** Number of tool calls that failed during execution. */
  toolCallsFailed: number;
}

export interface TurnOptions {
  conversationHistory?: ConversationMessage[];
  previousCues?: BehaviorCues;
  runId?: string;
  /** Session resumption info — set when the runtime loaded a persisted conversation. */
  sessionInfo?: { continued: boolean; lastActiveAt: number };
  /** Fading memories the agent might want to check in about, if relevant to conversation. */
  curiosityHints?: Array<{ content: string; daysSinceDiscussed: number }>;
  /** Known agents this motebit has interacted with — trust context for the AI. */
  knownAgents?: import("@motebit/sdk").AgentTrustRecord[];
  /** Capabilities per agent ID — enriches [Agents I Know] so the AI knows what to delegate. */
  agentCapabilities?: Record<string, string[]>;
  /** Active inference precision context string — injected into system prompt to modulate behavior. */
  precisionContext?: string;
  /** Delegation scope — restricts tool calls to tools within this scope set. */
  delegationScope?: string;
  /** First conversation ever — no prior history exists. */
  firstConversation?: boolean;
  /** System-triggered generation — goes into system prompt, not user message. */
  activationPrompt?: string;
  /**
   * When true, skip the inline memory-formation pass and yield a
   * `memory_formation_deferred` chunk before the final `result` chunk.
   * The runtime catches that chunk and queues formation to run after
   * the turn generator returns — the user sees their response and
   * the next turn can start without waiting on embedding +
   * consolidation.
   *
   * Default `false` — preserves the turn-contains-formation invariant
   * that a lot of existing tests and callers expect. Runtime sets
   * this to `true` when `RuntimeConfig.deferMemoryFormation === true`.
   */
  deferMemoryFormation?: boolean;
  /**
   * Skills resolved by the runtime's `SkillSelectorHook` for this turn
   * (spec/skills-v1.md §7). First iteration only — re-injecting on
   * tool-loop continuations would bloat context and break prompt-cache
   * matching, same shape as `memoryIndex` / `curiosityHints`.
   */
  selectedSkills?: import("@motebit/sdk").SkillInjection[];
  /**
   * Prompt-1 — runtime session-state snapshot composed by
   * `runtime.getSessionStateSnapshot()`. Threaded into the
   * `contextPack.sessionState` field so the prompt builder can emit
   * a `[Session]` block. Populated on every iteration (state can
   * change between tool-loop continuations — pixel consent could be
   * granted mid-turn via `/vision grant`, sensitivity could
   * elevate, the browser could open or close).
   */
  sessionState?: import("@motebit/sdk").SessionStateSnapshot;
}

export type AgenticChunk =
  | { type: "text"; text: string }
  | {
      type: "tool_status";
      name: string;
      status: "calling" | "done";
      result?: unknown;
      context?: string;
      /**
       * Stable identifier for this tool call — assigned by the model and
       * carried on both the "calling" and "done" chunks for the same
       * invocation. Lets downstream consumers (e.g. the runtime streaming
       * manager) match a completion chunk to the call that started it,
       * which the per-tool-call `ToolInvocationReceipt` signer needs in
       * order to commit to a stable invocation identity. Optional on the
       * type to keep legacy emitters source-compatible; new emission
       * sites set it unconditionally.
       */
      tool_call_id?: string;
      /**
       * Arguments the tool was dispatched with. Emitted on the "calling"
       * chunk so a downstream signer can hash them for `args_hash` on
       * the receipt without having to refetch from anywhere. Omitted on
       * "done" chunks (the caller already has them from "calling").
       */
      args?: Record<string, unknown>;
      /**
       * Unix ms when the tool was dispatched. Emitted on "calling" so
       * consumers can pair with `completed_at` (derived at "done" arrival
       * time) to produce a timing window without round-tripping through
       * a separate event. Omitted on "done".
       */
      started_at?: number;
      /**
       * Embodiment mode the slab item should stamp when this tool's
       * activity lands on the slab. Sourced from
       * `ToolDefinition.embodimentMode` at the registration site (e.g.
       * `apps/web/src/computer-tool.ts` registers `computer` with
       * `embodimentMode: "virtual_browser"`; desktop registers with
       * `embodimentMode: "desktop_drive"`). Carried on both `calling`
       * and `done` so the runtime's slab-projection has the mode at
       * open time AND can reaffirm at completion. The runtime's
       * `projectSlabForTurn` picks `chunk.mode` over the generic
       * `tool-policy.ts` floor — same tool name produces the right
       * embodiment per surface. Omitted when the registered tool
       * doesn't declare an embodimentMode.
       */
      mode?: string;
      /**
       * Slab-projection policy for this tool, sourced from
       * `ToolDefinition.slabProjection` at registration time. When
       * `"none"`, the runtime's projection site MUST skip opening a
       * slab item — the tool is state chrome (e.g. `request_control`),
       * not a body act, and its visible representation is a different
       * surface (the slab control band). When `"tool_call"` (default
       * when omitted), the runtime opens a generic `tool_call` slab
       * item. Closed string-literal union — additive (future variants
       * like `"observation"` could narrow further without breaking
       * existing callers).
       */
      slabProjection?: "none" | "tool_call";
      /**
       * Structured failure category, sourced from `ToolResult.reason`
       * (or from a typed error's `.reason` field when the handler
       * threw). Carried on `done` chunks for failures that should be
       * routed by category rather than text.
       *
       * v1 carriers:
       *   - `not_in_control` — Slice 1 co-browse gate denial. The
       *     runtime's slab projection dismisses the body item; the
       *     control band (Slice 2b doorbell) is the canonical
       *     surface for the resolution affordance.
       *
       * Open string-literal — additive. Consumers either route on a
       * value they care about or ignore the field.
       */
      reason?: string;
    }
  | {
      type: "approval_request";
      tool_call_id: string;
      name: string;
      args: Record<string, unknown>;
      risk_level?: number;
      quorum?: { required: number; approvers: string[]; collected: string[] };
    }
  | { type: "injection_warning"; tool_name: string; patterns: string[] }
  | {
      /**
       * Task-step narration — what motebit is currently doing at the
       * supervisor-cares-about granularity. Emitted after each iteration's
       * AIResponse is captured, before tool execution, so the slab's
       * `motebit × virtual_browser` register can render the narration
       * while the act is in flight (not after the turn closes).
       *
       * `text` is the post-validation narration string — already passed
       * through `validateTaskStepNarration` against the per-turn
       * `toolResultsLog`, so a model claim that contradicts wire-level
       * typed truth ("Reading apple.com" while the URL is google.com)
       * arrives at the chrome already corrected, never as raw model
       * output. `valid: false` carriers expose the override to consumers
       * that want to render trust-calibration treatment; `valid: true`
       * means the model's proposal passed through unchanged.
       *
       * Doctrine: `chrome-as-state-render.md` § "Hybrid narration source
       * as the third typed-truth-perception triple." Wire field on
       * `AIResponse.task_step_narration`; this chunk is the in-flight
       * carrier from the loop through the runtime to the chrome.
       */
      type: "task_step_narration";
      text: string;
      valid: boolean;
    }
  | {
      /**
       * Emitted when `options.deferMemoryFormation === true`. Carries the
       * candidates + relevantMemories snapshot the formation pass would
       * have consumed. The runtime catches this chunk and queues formation
       * to run after the turn generator returns, so the user sees the
       * `result` chunk (and the conversation flow completes) without
       * waiting on embedding + consolidation.
       */
      type: "memory_formation_deferred";
      candidates: MemoryCandidate[];
      relevantMemories: MemoryNode[];
    }
  | { type: "result"; result: TurnResult };

// === Clearance projection ===

/**
 * Project the sensitivity-clearance witness from cleared deps onto
 * the deps' `provider` field. **No new gate fires here** — the brand
 * was produced by the runtime's `assertSensitivityPermitsAiCall`
 * that yielded `cleared`; this helper carries the type-level witness
 * from the container to its provider sub-field. Pure type-level
 * no-op at runtime.
 *
 * Use this at every cross-package direct-provider-call site that
 * already has cleared deps (planner per-step decomposition and
 * reflection, runtime housekeeping that fires the gate explicitly).
 * The receiving function declares `provider:
 * SensitivityCleared<StreamingProvider>` (or
 * `SensitivityCleared<IntelligenceProvider>`, since
 * `StreamingProvider extends IntelligenceProvider`), and the brand
 * makes the unbranded `.generate(...)` call site structurally
 * unreachable from any path that didn't fire the gate.
 *
 * Doctrine: `docs/doctrine/security-boundaries.md` (privacy gate),
 * CLAUDE.md ("Medical/financial/secret never reach external AI").
 * Layer 1 promotion arc: closes the cross-package direct-provider-
 * call family that `runTurn` / `runTurnStreaming`'s deps-bundle
 * brand cannot reach (those functions take cleared deps, but
 * housekeeping functions like `summarizeConversation` / `reflect` /
 * `decomposePlan` / `reflectOnPlan` take a bare provider parameter).
 */
export function projectProviderClearance(
  cleared: SensitivityCleared<MotebitLoopDependencies>,
): SensitivityCleared<StreamingProvider> {
  return (cleared as MotebitLoopDependencies).provider as SensitivityCleared<StreamingProvider>;
}

// === Orchestrator ===

export async function runTurn(
  deps: SensitivityCleared<MotebitLoopDependencies>,
  userMessage: string,
  options?: TurnOptions,
): Promise<TurnResult> {
  let result: TurnResult | undefined;

  for await (const chunk of runTurnStreaming(deps, userMessage, options)) {
    switch (chunk.type) {
      case "result":
        result = chunk.result;
        break;
      case "approval_request":
        // Non-streaming callers cannot handle interactive approval — auto-deny.
        // The streaming loop already pushes "Awaiting approval" into conversation
        // history, so the model will see the denial on the next iteration.
        break;
      case "injection_warning":
        // Logged by the streaming loop; nothing to surface in non-streaming mode.
        break;
      // "text" and "tool_status" chunks are intermediate — ignore.
    }
  }

  if (!result) {
    throw new Error("runTurnStreaming ended without producing a result");
  }

  return result;
}

/** Extract a short human-readable context string from tool name + args. */
function toolContext(name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case "recall_memories":
    case "search_memories":
      return typeof args.query === "string" ? `"${args.query.slice(0, 60)}"` : undefined;
    case "web_search":
      return typeof args.query === "string" ? `"${args.query.slice(0, 60)}"` : undefined;
    case "read_url":
    case "fetch_url":
      return typeof args.url === "string" ? args.url.slice(0, 80) : undefined;
    case "read_file":
      return typeof args.path === "string" ? args.path : undefined;
    case "write_file":
      return typeof args.path === "string" ? args.path : undefined;
    case "shell_exec":
      return typeof args.command === "string" ? args.command.slice(0, 60) : undefined;
    case "delegate_to_agent":
      return typeof args.prompt === "string" ? `"${args.prompt.slice(0, 60)}"` : undefined;
    default:
      return undefined;
  }
}

export async function* runTurnStreaming(
  deps: SensitivityCleared<MotebitLoopDependencies>,
  userMessage: string,
  options?: TurnOptions,
): AsyncGenerator<AgenticChunk> {
  const { motebitId, eventStore, memoryGraph, stateEngine, behaviorEngine, provider } = deps;

  // 1. Query recent events, embed user message, and fetch pinned memories in parallel.
  // These are independent — no reason to await sequentially.
  //
  // Each stage gets its own labeled timeout. A hung persistence adapter,
  // stuck remote embed, or wedged memory graph must surface as a specific
  // `StageTimeoutError` in seconds rather than hang the turn silently. See
  // `STAGE_TIMEOUTS_MS` in core.ts for deadlines (single source of truth).
  const CONTEXT_SAFE_SENSITIVITY = [SensitivityLevel.None, SensitivityLevel.Personal];

  const [recentEvents, queryEmbedding, pinnedMemoriesRaw] = await Promise.all([
    withStageTimeout(
      "event_query",
      STAGE_TIMEOUTS_MS.event_query,
      eventStore.query({ motebit_id: motebitId, limit: 10 }),
    ),
    withStageTimeout(
      "embed_user_message",
      STAGE_TIMEOUTS_MS.embed_user_message,
      embedText(userMessage),
    ),
    withStageTimeout(
      "pinned_memories",
      STAGE_TIMEOUTS_MS.pinned_memories,
      memoryGraph.getPinnedMemories(),
    ),
  ]);

  // 2. Similarity retrieval depends on the embedding — runs after parallel batch
  const pinnedMemories = pinnedMemoriesRaw.filter((m) =>
    CONTEXT_SAFE_SENSITIVITY.includes(m.sensitivity),
  );
  const similarityMemories = await withStageTimeout(
    "memory_retrieve",
    STAGE_TIMEOUTS_MS.memory_retrieve,
    memoryGraph.recallRelevant(queryEmbedding, {
      limit: 5,
      strengthenCoRetrieved: true,
      sensitivityFilter: CONTEXT_SAFE_SENSITIVITY,
    }),
  );

  // Merge: pinned first (cap 5), then similarity (deduplicated)
  const pinnedIds = new Set(pinnedMemories.map((m) => m.node_id));
  const dedupedSimilarity = similarityMemories.filter((m) => !pinnedIds.has(m.node_id));
  const relevantMemories = [...pinnedMemories.slice(0, 5), ...dedupedSimilarity];

  // Layer-1 memory index — best-effort; a failure here must not fail the
  // turn. The agent still gets Layer-2 retrieval via `relevant_memories`.
  let memoryIndex: string | undefined;
  try {
    const maybe = await memoryGraph.getMemoryIndex?.();
    if (typeof maybe === "string" && maybe.length > 0) memoryIndex = maybe;
  } catch {
    // Index is a pure projection; a store error is the deps' problem, not
    // the turn's. Swallow and continue.
  }

  // 3. Pack context and stream from provider (agentic loop)
  const currentState = stateEngine.getState();
  const rawToolDefs = deps.tools ? deps.tools.list() : undefined;
  const toolDefs =
    rawToolDefs && deps.policyGate ? deps.policyGate.filterTools(rawToolDefs) : rawToolDefs;

  let turnCtx = deps.policyGate?.createTurnContext(options?.runId);
  if (turnCtx && options?.delegationScope !== undefined) {
    turnCtx = { ...turnCtx, delegationScope: options.delegationScope };
  }

  const conversationHistory: ConversationMessage[] = [...(options?.conversationHistory ?? [])];

  let finalText = "";
  let finalResponse;
  let iteration = 0;
  let toolCallsSucceeded = 0;
  let toolCallsBlocked = 0;
  let toolCallsFailed = 0;
  // Typed-truth log for the dishonest-closing intercept. Captures
  // structured tool result data PRE-sanitization so the typed-truth
  // fields (navigation_triggered, recovery_hint, bot_detection_detected)
  // are intact at intercept time. Failure entries carry `errorReason`
  // so the `frame_stale` register reaches the intercept too. See
  // `dishonest-closing.ts` for the doctrine + walk-back semantics.
  const toolResultsLog: ToolResultLogEntry[] = [];

  // Behavioral constraint: track consecutive identical tool calls to prevent
  // pathological loops (e.g. recall → recall → recall × 10). After 2 consecutive
  // calls to the same tool, that tool is excluded from the next iteration and the
  // LLM is forced to synthesize a response.
  let lastToolName = "";
  let consecutiveSameToolCalls = 0;
  const MAX_CONSECUTIVE_SAME_TOOL = 2;

  // Retrieval tools that should force synthesis after use — the LLM must respond
  // with text after retrieving, not re-enter the planning loop.
  const RETRIEVAL_TOOLS = new Set(["recall_memories"]);
  let forcesynthesis = false;

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;

    // When forced synthesis is active, strip tools so the LLM MUST produce text.
    // This enforces the plan → tool → synthesize → terminate state machine.
    const iterationToolDefs = forcesynthesis ? undefined : toolDefs;
    if (forcesynthesis) {
      forcesynthesis = false; // consume the flag — one forced synthesis per trigger
    }

    const contextPack = {
      recent_events: recentEvents,
      relevant_memories: relevantMemories,
      current_state: currentState,
      user_message: iteration === 1 ? userMessage : "",
      conversation_history:
        iteration === 1
          ? conversationHistory.length > 0
            ? conversationHistory
            : undefined
          : conversationHistory,
      behavior_cues: options?.previousCues,
      tools: iterationToolDefs,
      sessionInfo: options?.sessionInfo,
      curiosityHints: iteration === 1 ? options?.curiosityHints : undefined,
      knownAgents: iteration === 1 ? options?.knownAgents : undefined,
      agentCapabilities: iteration === 1 ? options?.agentCapabilities : undefined,
      precisionContext: iteration === 1 ? options?.precisionContext : undefined,
      firstConversation: iteration === 1 ? options?.firstConversation : undefined,
      activationPrompt: iteration === 1 ? options?.activationPrompt : undefined,
      // Layer-1 memory index: first iteration only. Memory doesn't
      // change mid-turn; re-emitting it on tool-loop continuations
      // would bloat the conversation without benefit and break
      // prompt-cache matching across iterations.
      memoryIndex: iteration === 1 ? memoryIndex : undefined,
      // Skills selected for this turn — first iteration only, same
      // rationale as memoryIndex.
      selectedSkills: iteration === 1 ? options?.selectedSkills : undefined,
      // Prompt-1 — session-state snapshot threaded on EVERY
      // iteration. State can shift mid-turn: `/vision grant` flips
      // consent, control transitions land via the band, the
      // browser opens lazily on first `computer` call. The AI
      // needs the truth on each iteration, not just the first.
      sessionState: options?.sessionState,
    };

    // On continuation turns, the conversation history carries the context
    // (including tool results). user_message stays empty — re-injecting the
    // original prompt would waste context and confuse turn structure.

    let aiResponse;
    for await (const chunk of provider.generateStream(contextPack)) {
      if (chunk.type === "text") {
        yield { type: "text", text: chunk.text };
      } else {
        aiResponse = chunk.response;
      }
    }

    if (!aiResponse) {
      throw new Error("Stream ended without a final response");
    }

    // Accumulate token usage on turn context for budget enforcement
    if (aiResponse.usage && turnCtx) {
      const tokens = aiResponse.usage.input_tokens + aiResponse.usage.output_tokens;
      turnCtx = { ...turnCtx, costAccumulated: turnCtx.costAccumulated + tokens };
    }

    finalText = aiResponse.text;
    finalResponse = aiResponse;

    // Task-step narration — emit per-iteration so the slab's
    // `motebit × virtual_browser` register can render the narration
    // while the act is in flight (not after the turn closes). The
    // model's proposal passes through `validateTaskStepNarration`
    // against the per-turn `toolResultsLog` first: contradictions
    // are corrected at the runtime (this is the third graduation of
    // typed-truth-perception — the chrome never sees the raw model
    // claim). Empty / absent narration is dropped (no chunk emitted)
    // so the chrome recedes to the empty register rather than
    // rendering blank text. Doctrine:
    // `runtime-invariants-over-prompt-rules.md` § "The four-part
    // typed-truth structure" + `chrome-as-state-render.md`.
    if (aiResponse.task_step_narration !== undefined) {
      const narrationResult = validateTaskStepNarration({
        proposedNarration: aiResponse.task_step_narration,
        toolResultsLog,
      });
      if (narrationResult.narration.trim() !== "") {
        yield {
          type: "task_step_narration",
          text: narrationResult.narration,
          valid: narrationResult.valid,
        };
      }
    }

    // If no tool calls or no tool registry, exit the loop
    if (!aiResponse.tool_calls || aiResponse.tool_calls.length === 0 || !deps.tools) {
      break;
    }

    // Preserve user message in history so subsequent iterations can reference it.
    // On iteration 1 it lives only in contextPack.user_message — without this,
    // the model loses the user's input after a tool call.
    if (iteration === 1 && userMessage) {
      conversationHistory.push({ role: "user", content: userMessage });
    }

    // Process tool calls
    const assistantMsg: ConversationMessage = {
      role: "assistant",
      content: aiResponse.text,
      tool_calls: aiResponse.tool_calls,
    };
    conversationHistory.push(assistantMsg);

    const toolDefsMap = new Map((toolDefs ?? []).map((t) => [t.name, t]));

    let allBlocked = true;

    for (const toolCall of aiResponse.tool_calls) {
      const toolDef = toolDefsMap.get(toolCall.name);

      // Policy gate enforcement (when present)
      if (deps.policyGate && toolDef && turnCtx) {
        const decision = deps.policyGate.validate(toolDef, toolCall.args, turnCtx);

        if (!decision.allowed) {
          toolCallsBlocked++;
          yield {
            type: "tool_status",
            name: toolCall.name,
            status: "done",
            result: decision.reason,
            tool_call_id: toolCall.id,
            mode: toolDef.embodimentMode,
            slabProjection: toolDef.slabProjection,
          };
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: decision.reason }),
          });
          continue;
        }

        if (decision.requiresApproval) {
          toolCallsBlocked++;
          const profile = deps.policyGate.classify(toolDef);
          yield {
            type: "approval_request",
            tool_call_id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
            risk_level: profile.risk,
            ...(decision.quorum ? { quorum: decision.quorum } : {}),
          };
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: "Awaiting approval" }),
          });
          continue;
        }

        // Allowed — execute and record
        allBlocked = false;
        yield {
          type: "tool_status",
          name: toolCall.name,
          status: "calling",
          context: toolContext(toolCall.name, toolCall.args),
          tool_call_id: toolCall.id,
          args: toolCall.args,
          started_at: Date.now(),
          mode: toolDef.embodimentMode,
          slabProjection: toolDef.slabProjection,
        };

        let result: ToolResult;
        try {
          result = await deps.tools.execute(toolCall.name, toolCall.args);
        } catch (err: unknown) {
          toolCallsFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          // Thrown errors with a typed `.reason` (e.g.
          // ComputerDispatcherError) propagate the category onto the
          // chunk so motebit-runtime's slab projection can route the
          // failure structurally. Most paths return `{ok:false}` from
          // the handler; this catch covers handlers that throw.
          const thrownReason = extractErrorReason(err);
          yield {
            type: "tool_status",
            name: toolCall.name,
            status: "done",
            result: msg,
            tool_call_id: toolCall.id,
            mode: toolDef.embodimentMode,
            slabProjection: toolDef.slabProjection,
            ...(thrownReason ? { reason: thrownReason } : {}),
          };
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: msg }),
          });
          continue;
        }
        turnCtx = deps.policyGate.recordToolCall(turnCtx);

        // Project the tool result into the AI-visible shape BEFORE
        // sanitization. Byte-payload kinds (screenshots) compose
        // through the three pixel gates (sovereignty / sensitivity /
        // consent) — bytes pass when all gates permit, otherwise the
        // result carries a `bytes_omitted` directive with a structured
        // reason naming the right remediation surface. The slab's
        // chunk path (yielded above) still gets the raw `result.data`.
        const projectionCtx: ProjectionContext = {
          providerMode: deps.getProviderMode?.() ?? null,
          sensitivity: deps.getEffectiveSensitivity?.() ?? SensitivityLevel.None,
          pixelConsent: deps.getPixelConsent?.() ?? "denied",
        };
        const aiProjectedResult: ToolResult = {
          ...result,
          data: projectForAi(result.data, projectionCtx, deps.onPixelOmissionEmitted),
        };

        // Use sanitizeAndCheck if available (duck-typed), otherwise fall back
        let sanitized: ToolResult;
        if (typeof deps.policyGate.sanitizeAndCheck === "function") {
          const check = deps.policyGate.sanitizeAndCheck(aiProjectedResult, toolCall.name);
          sanitized = check.result;
          if (check.injectionDetected) {
            yield {
              type: "injection_warning",
              tool_name: toolCall.name,
              patterns: check.injectionPatterns,
            };

            // Fail-closed: block on high-confidence injection (regex match or structural flag)
            const highConfidence =
              check.injectionPatterns.length > 0 || (check.structuralFlags ?? []).length > 0;
            const injectionData = {
              detected: true,
              patterns: check.injectionPatterns,
              directiveDensity: check.directiveDensity,
              structuralFlags: check.structuralFlags,
            };

            // Log to audit trail
            if (turnCtx != null && typeof deps.policyGate.logInjection === "function") {
              deps.policyGate.logInjection(
                turnCtx.turnId,
                toolCall.id,
                toolCall.name,
                toolCall.args,
                injectionData,
                highConfidence,
                turnCtx.runId,
              );
            }

            if (highConfidence) {
              toolCallsBlocked++;
              const reason = `Injection detected — tool result blocked (${[...check.injectionPatterns, ...(check.structuralFlags ?? [])].join(", ")})`;
              yield {
                type: "tool_status",
                name: toolCall.name,
                status: "done",
                result: reason,
                tool_call_id: toolCall.id,
                mode: toolDef.embodimentMode,
                slabProjection: toolDef.slabProjection,
              };
              conversationHistory.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify({ ok: false, error: reason }),
              });
              continue;
            }
            // Low-confidence (directive density only): warn but allow through (boundary-wrapped)
          }
        } else {
          sanitized = deps.policyGate.sanitizeResult(aiProjectedResult, toolCall.name);
        }

        toolCallsSucceeded++;
        // Two outputs, two audiences:
        //   - The chunk's `result` flows to the slab and the runtime's
        //     UI-facing streaming pipeline. Renderers expect the
        //     STRUCTURED tool output (e.g., the screenshot-observation
        //     dict `{ kind: "screenshot", bytes_base64, ... }`) so they
        //     can route by `kind` and access fields like
        //     `bytes_base64`. Yielding `sanitized.data` here was a
        //     category error — it serializes the dict to a JSON
        //     string, runs the redactor over the bytes_base64 (whose
        //     long base64 matches encoded-secret patterns), and wraps
        //     the whole thing in `[EXTERNAL_DATA]` markers. The slab
        //     loses the screenshot entirely. Witnessed 2026-05-07.
        //   - `conversationHistory` is what the AI reads on its next
        //     turn. That's where boundary-wrapping (prompt-injection
        //     defense) and redaction belong — the AI is the consumer
        //     whose text-as-instructions confusion the boundaries
        //     prevent.
        // So: yield the raw `result.data` to the chunk, push the
        // sanitized JSON to conversation history. Same shape as the
        // fallback (no-PolicyGate) path below.
        yield {
          type: "tool_status",
          name: toolCall.name,
          status: "done",
          result: result.data ?? result.error,
          tool_call_id: toolCall.id,
          mode: toolDef.embodimentMode,
          slabProjection: toolDef.slabProjection,
          // Failure category from the handler (e.g.
          // `not_in_control` from the computer-tool dispatcher's
          // typed error). Routes the slab projection without parsing
          // the human `error` text; absent on success.
          ...(result.reason ? { reason: result.reason } : {}),
        };

        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(sanitized),
        });
        // Typed-truth log — capture the PRE-sanitization data so the
        // dishonest-closing intercept sees the structural fields
        // (navigation_triggered, recovery_hint, bot_detection_detected)
        // intact. Sanitization wraps for prompt-injection defense which
        // would obscure these fields if we read from history.
        toolResultsLog.push({
          name: toolCall.name,
          ok: true,
          data: result.data,
          errorReason: null,
        });
        continue;
      }

      // Policy gate filtered this tool out — do NOT execute.
      // The tool may still exist in the registry, but policy excluded it for a reason.
      if (deps.policyGate && !toolDef) {
        toolCallsBlocked++;
        yield {
          type: "tool_status",
          name: toolCall.name,
          status: "done",
          result: "Tool not available",
          tool_call_id: toolCall.id,
          // No mode — toolDef wasn't found; can't infer embodiment.
        };
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: false, error: "Tool not available" }),
        });
        continue;
      }

      // Fallback: no policy gate — use legacy requiresApproval check
      if (toolDef?.requiresApproval === true) {
        toolCallsBlocked++;
        yield {
          type: "approval_request",
          tool_call_id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
        };
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: false, error: "Awaiting approval" }),
        });
        continue;
      }

      allBlocked = false;
      yield {
        type: "tool_status",
        name: toolCall.name,
        status: "calling",
        context: toolContext(toolCall.name, toolCall.args),
        tool_call_id: toolCall.id,
        args: toolCall.args,
        started_at: Date.now(),
        mode: toolDef?.embodimentMode,
      };
      let result: ToolResult;
      try {
        result = await deps.tools.execute(toolCall.name, toolCall.args);
      } catch (err: unknown) {
        toolCallsFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        const thrownReason = extractErrorReason(err);
        yield {
          type: "tool_status",
          name: toolCall.name,
          status: "done",
          result: msg,
          tool_call_id: toolCall.id,
          mode: toolDef?.embodimentMode,
          ...(thrownReason ? { reason: thrownReason } : {}),
        };
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: false, error: msg }),
        });
        // Typed-truth log — capture the typed error reason so the
        // dishonest-closing intercept can see frame_stale (the one
        // failure-class field that contradicts a "Done" claim). Other
        // reasons fall through the count-based fallback branches and
        // don't need re-correction here.
        toolResultsLog.push({
          name: toolCall.name,
          ok: false,
          data: null,
          errorReason: thrownReason ?? null,
        });
        continue;
      }
      toolCallsSucceeded++;
      yield {
        type: "tool_status",
        name: toolCall.name,
        status: "done",
        result: result.data ?? result.error,
        tool_call_id: toolCall.id,
        mode: toolDef?.embodimentMode,
        ...(result.reason ? { reason: result.reason } : {}),
      };

      // Fallback path: no PolicyGate — wrap in boundaries AND detect injection.
      // Same projection as the PolicyGate path: byte-payload kinds compose
      // through the three pixel gates before the AI sees them.
      const fallbackProjectionCtx: ProjectionContext = {
        providerMode: deps.getProviderMode?.() ?? null,
        sensitivity: deps.getEffectiveSensitivity?.() ?? SensitivityLevel.None,
        pixelConsent: deps.getPixelConsent?.() ?? "denied",
      };
      const aiProjectedData = projectForAi(
        result.data,
        fallbackProjectionCtx,
        deps.onPixelOmissionEmitted,
      );
      let wrappedResult = result;
      if (aiProjectedData != null) {
        const dataStr =
          typeof aiProjectedData === "string" ? aiProjectedData : JSON.stringify(aiProjectedData);
        // Lightweight injection detection (subset of @motebit/policy sanitizer)
        const injectionHints: string[] = [];
        if (/ignore\s+(previous|all|above)\s+(instructions|prompts)/i.test(dataStr))
          injectionHints.push("ignore-instructions");
        if (/you\s+are\s+now|new\s+instructions|system\s*:/i.test(dataStr))
          injectionHints.push("identity-override");
        if (/<\|im_start\|>|<\|im_end\|>/i.test(dataStr))
          injectionHints.push("chat-template-markers");
        if (injectionHints.length > 0) {
          yield {
            type: "injection_warning",
            tool_name: toolCall.name,
            patterns: injectionHints,
          };
        }
        wrappedResult = { ...result, data: wrapExternalData(aiProjectedData, toolCall.name) };
      }
      conversationHistory.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(wrappedResult),
      });
      // Typed-truth log — capture the PRE-wrap data (`result.data`,
      // not `wrappedResult.data` which has been wrapped in
      // `[EXTERNAL_DATA]` markers for the AI). The dishonest-closing
      // intercept reads structured fields, not the wrapped string.
      toolResultsLog.push({
        name: toolCall.name,
        ok: true,
        data: result.data,
        errorReason: null,
      });
    }

    // If all tool calls were blocked (denied or approval-gated), don't loop again
    if (allBlocked) {
      break;
    }

    // Behavioral constraint enforcement: detect consecutive identical tool calls
    // and retrieval tools that should force synthesis.
    const calledTools = aiResponse.tool_calls.map((tc) => tc.name);
    const uniqueTools = new Set(calledTools);

    if (uniqueTools.size === 1 && calledTools.length > 0) {
      const toolName = calledTools[0]!;
      if (toolName === lastToolName) {
        consecutiveSameToolCalls++;
      } else {
        consecutiveSameToolCalls = 1;
        lastToolName = toolName;
      }
      // After MAX_CONSECUTIVE_SAME_TOOL identical iterations, force synthesis
      if (consecutiveSameToolCalls >= MAX_CONSECUTIVE_SAME_TOOL) {
        forcesynthesis = true;
        consecutiveSameToolCalls = 0;
        lastToolName = "";
      }
      // Retrieval tools always force synthesis on next iteration
      if (RETRIEVAL_TOOLS.has(toolName)) {
        forcesynthesis = true;
      }
    } else if (calledTools.length > 0) {
      // Multiple different tools — reset tracking
      consecutiveSameToolCalls = 0;
      lastToolName = "";
      // If any retrieval tool was used, force synthesis
      if (calledTools.some((name) => RETRIEVAL_TOOLS.has(name))) {
        forcesynthesis = true;
      }
    }
  }

  if (!finalResponse) {
    throw new Error("No response generated");
  }

  // Empty-response guard: if the model responded with only tags (memory/state)
  // that got stripped, the user sees nothing. Re-prompt once without tools to
  // force visible text. This typically happens when the model reflects on its
  // own internals after a recall_memories call.
  if (finalText.trim() === "" && toolCallsSucceeded > 0) {
    conversationHistory.push({
      role: "assistant",
      content: finalResponse.text || "",
      ...(finalResponse.tool_calls?.length ? { tool_calls: finalResponse.tool_calls } : {}),
    });
    conversationHistory.push({
      role: "user",
      content:
        "[System: your previous response was empty after tag processing. Respond to the user with visible text. Do not emit only tags.]",
    });

    const nudgeContextPack = {
      recent_events: recentEvents,
      relevant_memories: relevantMemories,
      current_state: currentState,
      user_message: "",
      conversation_history: conversationHistory,
      behavior_cues: options?.previousCues,
      tools: undefined, // no tools — must produce text
      sessionInfo: options?.sessionInfo,
    };

    for await (const chunk of provider.generateStream(nudgeContextPack)) {
      if (chunk.type === "text") {
        yield { type: "text", text: chunk.text };
      } else {
        finalText = chunk.response.text;
        finalResponse = chunk.response;
      }
    }
  }

  // Runtime hard floor — the contract guarantee that every turn ends
  // with at least one visible sentence. The empty-text safety-net
  // above (re-prompt without tools) catches the "model emitted only
  // tags after a successful tool call" case, but two failure modes
  // bypass it:
  //
  //   (1) `toolCallsSucceeded === 0` — the re-prompt is gated on at
  //       least one successful tool call. If every tool call failed
  //       (or none was attempted) AND the model emitted no text, the
  //       safety-net doesn't fire and the user sees silence.
  //
  //   (2) The re-prompt itself returns empty text — possible when
  //       the model is in a state where it consistently emits only
  //       tool_use blocks or only stripped tags. Without a final
  //       fallback, the user sees silence.
  //
  // Witnessed 2026-05-12: user said "type motebit and press enter"
  // on the cloud-browser slab. type_into succeeded; the press-enter
  // action (click_element on search button OR key Enter) hit
  // frame_stale or element_not_found; the AI iterated tool calls
  // without text; the safety-net's re-prompt produced empty text;
  // the user saw a silently-terminated turn with no assistant
  // message at all. The runtime's promise to the user — "if you
  // sent a message, I will respond" — was broken.
  //
  // This floor is a pure-function synthesis over the loop's exit
  // state. It cannot return empty. It is the last line of defense
  // against silent turn termination — model behavior can drift, the
  // safety-net can fail, but this floor is mechanical. Doctrine:
  // motebit-computer.md §"Typed truth on results" applied to the
  // turn-completion contract.
  if (finalText.trim() === "") {
    finalText = synthesizeClosingFallback({
      toolCallsSucceeded,
      toolCallsFailed,
      lastToolName,
    });
    yield { type: "text", text: finalText };
    // Reflect the synthesized text on finalResponse so downstream
    // consumers (memory candidates, conversation persistence, etc.)
    // see a coherent assistant message rather than the empty string
    // they would have seen pre-fix.
    finalResponse = { ...finalResponse, text: finalText };
  }

  // Dishonest-closing intercept — graduates four typed-truth fields
  // from prompt-only teaching to runtime-enforced correction. When
  // the model emits non-empty closing text that claims success
  // ("Done", "submitted", "typed it in", "the page shows...") AND
  // the most recent terminal action's typed truth contradicts the
  // claim AND no successful retry of the same kind followed, append
  // a correction so the user sees the truth before they act on the
  // lie. The streaming model means we cannot UNSEND the model's
  // text; we can only APPEND a correction in the same turn.
  //
  // Fields in scope (dishonesty-class): navigation_triggered,
  // recovery_hint, bot_detection_detected, frame_stale.
  // Out-of-scope (affordance-class): submit_button_id — that's a
  // hint, not a failure signal; including it would trigger spurious
  // overrides.
  //
  // Sync-invariant graduation: each of the four wire fields
  // previously had wire+prompt coverage but no runtime enforcement
  // (2-of-3 of the canonical typed-truth-perception triple). After
  // this intercept, all four are 3-of-3 (wire + prompt + runtime).
  //
  // Doctrine: `runtime-invariants-over-prompt-rules.md` —
  // `synthesizeClosingFallback` was named the exemplar; this is the
  // exemplar extended to its full scope.
  if (finalText.trim() !== "") {
    const correction = detectDishonestClosing({
      finalText,
      toolResultsLog,
    });
    if (correction !== null) {
      yield { type: "text", text: `\n\n${correction}` };
      // Reflect the corrected text on finalResponse so memory
      // candidates / conversation persistence / state inference see
      // the same coherent message the user saw, not the pre-correction
      // claim alone.
      const correctedText = `${finalText}\n\n${correction}`;
      finalText = correctedText;
      finalResponse = { ...finalResponse, text: correctedText };
    }
  }

  // 4. Form memories from candidates (governed if governor present)
  // Cap confidence for tool-derived memories: when tool calls occurred in this turn,
  // memory candidates may be influenced by attacker-controlled tool output.
  const MAX_TOOL_TURN_CONFIDENCE = 0.6;
  const memoriesFormed: MemoryNode[] = [];
  // Defense in depth: filter self-referential memories in the loop, not just in
  // tag parsing. Catches candidates regardless of provider implementation.
  let rawCandidates = finalResponse.memory_candidates.filter((c) => !isSelfReferential(c.content));
  if (toolCallsSucceeded > 0) {
    rawCandidates = rawCandidates.map((c) => ({
      ...c,
      confidence: Math.min(c.confidence, MAX_TOOL_TURN_CONFIDENCE),
    }));
  }
  // Effective-tier floor: when the runtime reports an effective
  // session sensitivity above `none`, every candidate this turn
  // produced is floored to at least that tier. The model classifies
  // candidate sensitivity from content; the runtime knows what
  // sensitive material was in scope (session-elevated state, drops,
  // classified tool outputs). Without this floor, a `secret`-
  // effective turn could emit candidates the model assessed as
  // `none` (because the candidate text itself reads benign), the
  // memory governor's `none` path persists them, and a later
  // none-tier session retrieves the leaked memory. Conservative
  // by design — over-restricting forms recoverable by re-elevating
  // and re-forming, while under-restricting leaks structurally.
  const effectiveTier = deps.getEffectiveSensitivity?.() ?? SensitivityLevel.None;
  if (effectiveTier !== SensitivityLevel.None) {
    // Floor each candidate at the effective tier — keep candidates already
    // at or above the floor; raise the rest. Direct rank comparison reads
    // cleaner than the `sensitivityPermits` wrapper here, since the
    // semantic is "is the candidate at or above the floor?" not "does
    // an upper bound permit a candidate?"
    const effectiveRank = rankSensitivity(effectiveTier);
    rawCandidates = rawCandidates.map((c) =>
      rankSensitivity(c.sensitivity) >= effectiveRank ? c : { ...c, sensitivity: effectiveTier },
    );
  }
  const candidates = deps.memoryGovernor
    ? rawCandidates
        .map((c) => {
          const decisions = deps.memoryGovernor!.evaluate([c]);
          const d = decisions[0];
          if (!d || d.memoryClass !== "persistent") return null;
          // Use the governor's potentially modified candidate (capped confidence,
          // reclassified sensitivity, etc.) — not the original.
          return d.candidate;
        })
        .filter((c): c is MemoryCandidate => c !== null)
    : rawCandidates;

  // Memory formation pass — embed (parallel), consolidate (sequential),
  // link (cosine-threshold). Extracted into @motebit/memory-graph's
  // `formMemoriesFromCandidates` so a future runtime Worker can call
  // the same function off-thread without duplicating the machinery.
  //
  // When `options.deferMemoryFormation === true`, skip the inline pass
  // and yield a deferred chunk carrying the candidates + retrieval
  // snapshot. The runtime catches it, queues formation in the
  // background, and the user sees their response without waiting on
  // embedding + consolidation. See `MotebitRuntime._memoryFormationQueue`.
  if (options?.deferMemoryFormation === true) {
    yield {
      type: "memory_formation_deferred",
      candidates: [...candidates],
      relevantMemories: [...relevantMemories],
    };
  } else {
    const { memoriesFormed: newlyFormed } = await formMemoriesFromCandidates(
      { memoryGraph, consolidationProvider: deps.consolidationProvider },
      candidates,
      relevantMemories,
    );
    for (const n of newlyFormed) memoriesFormed.push(n);
  }

  // 4b. Audit: detect memory-worthy patterns the model missed
  const untaggedPatterns = detectUntaggedMemoryPatterns(
    userMessage,
    finalText,
    finalResponse.memory_candidates,
  );
  if (untaggedPatterns.length > 0) {
    await eventStore.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: motebitId,
      timestamp: Date.now(),
      event_type: EventType.MemoryAudit,
      payload: {
        missed_patterns: untaggedPatterns,
        turn_message: userMessage.slice(0, 200),
      },
      tombstoned: false,
    });
  }

  // 5. Push state updates (explicit tags win; fall back to text inference)
  if (Object.keys(finalResponse.state_updates).length > 0) {
    stateEngine.pushUpdate(finalResponse.state_updates);
  } else {
    const inferred = inferStateFromText(finalResponse.text, stateEngine.getState());
    if (Object.keys(inferred).length > 0) {
      stateEngine.pushUpdate(inferred);
    }
  }
  // Force immediate tick so stateAfter reflects the update (next scheduled
  // tick may be up to 500ms away, but we need current state for display).
  stateEngine.tickNow();

  // 6. Log interaction event
  await eventStore.appendWithClock({
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload: {
      user_message: userMessage,
      response: finalText,
      memories_formed: memoriesFormed.length,
    },
    tombstoned: false,
  });

  // 7. Compute behavior cues
  const stateAfter = stateEngine.getState();
  const cues = behaviorEngine.compute(stateAfter);

  yield {
    type: "result",
    result: {
      response: finalText,
      memoriesFormed,
      memoriesRetrieved: relevantMemories,
      stateAfter,
      cues,
      iterations: iteration,
      toolCallsSucceeded,
      toolCallsBlocked,
      toolCallsFailed,
      ...(turnCtx && turnCtx.costAccumulated > 0 ? { totalTokens: turnCtx.costAccumulated } : {}),
    },
  };
}
