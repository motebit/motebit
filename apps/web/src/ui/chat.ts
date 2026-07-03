import type { WebContext } from "../types";
import { hasCeilingBeenShown, markCeilingShown } from "../storage";
import { StreamingTTSQueue, WebSpeechTTSProvider } from "@motebit/voice";
import type { TTSProvider } from "@motebit/voice";
import { stripInternalTags } from "@motebit/ai-core";
import type { ExecutionReceipt, AccrualBasis } from "@motebit/sdk";
import { buildReceiptArtifact } from "@motebit/render-engine";
import { resolveAccrualAttribution } from "@motebit/panels";
import { installPrUrlChip } from "./pr-url-chip";
import { installHireChip, type HireComposeRequest } from "./hire-chip";

export type { HireComposeRequest };

// === Lightweight Markdown Renderer ===

/** Convert markdown to safe HTML. No external dependencies. */
export function renderMarkdown(raw: string): string {
  const cleaned = stripInternalTags(raw).trim();
  // Escape HTML entities first (prevent XSS)
  const escaped = cleaned.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return (
    escaped
      // Code blocks (``` ... ```)
      .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
      // Inline code
      .replace(
        /`([^`]+)`/g,
        '<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;font-size:0.9em;">$1</code>',
      )
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      // Italic
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      // Headers (keep them subtle — just bold + slightly larger)
      .replace(/^#{3,6}\s+(.+)$/gm, '<div style="font-weight:600;margin:8px 0 4px;">$1</div>')
      .replace(
        /^#{1,2}\s+(.+)$/gm,
        '<div style="font-weight:600;font-size:1.05em;margin:8px 0 4px;">$1</div>',
      )
      // Unordered lists
      .replace(/^[*-]\s+(.+)$/gm, '<div style="padding-left:12px;">• $1</div>')
      // Ordered lists (simple — just indent)
      .replace(/^(\d+)\.\s+(.+)$/gm, '<div style="padding-left:12px;">$1. $2</div>')
      // Line breaks (double newline → paragraph break)
      .replace(/\n\n/g, '<div style="height:8px;"></div>')
      // Single newlines → <br>
      .replace(/\n/g, "<br>")
  );
}

/**
 * Coalesces streaming markdown re-renders to one paint per animation frame.
 *
 * The naive path — `el.innerHTML = renderMarkdown(accumulated)` on every
 * streamed token — is O(n²): each token re-parses and re-lays-out the entire
 * growing message, and a fast token burst (on-device WebLLM, cached cloud
 * replies) fires hundreds of synchronous reflows a second on the main thread.
 * That is the lag felt while a reply streams, and it amplifies the GPU
 * contention on the on-device path.
 *
 * Coalescing decouples token-arrival rate from DOM-render rate: tokens arriving
 * within one frame collapse into a single markdown render + one DOM write + one
 * scroll, capping re-renders at the display refresh rate. `flush()` forces the
 * final paint at turn end so the last tokens (which may have landed mid-frame)
 * are always shown. Markdown needs the whole string for correct parsing (a
 * token can close a code fence or list), so each paint re-renders the full
 * source — but at ~display-refresh rate, not once per token. TTS chunking is
 * unaffected; only the DOM render coalesces.
 */
export class StreamingRenderer {
  private frame: number | null = null;
  private pending: { el: HTMLElement; source: string; onPaint?: () => void } | null = null;

  push(el: HTMLElement, source: string, onPaint?: () => void): void {
    this.pending = { el, source, onPaint };
    if (this.frame === null) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.paint();
      });
    }
  }

  /** Force the pending paint immediately (call at turn end). Idempotent. */
  flush(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.paint();
  }

  private paint(): void {
    const p = this.pending;
    if (p === null) return;
    this.pending = null;
    p.el.innerHTML = renderMarkdown(p.source);
    p.onPaint?.();
  }
}

// === Streaming TTS ===

/**
 * Web surface wrapper around StreamingTTSQueue.
 *
 * Adds enable/disable gating, a swappable TTSProvider (so the surface can
 * promote ElevenLabs / OpenAI / Web Speech behind the same seam), and an
 * audioPlaying flag consumed by main.ts's syncTTS loop to detect when TTS
 * actually ends. The provider itself is a pluggable adapter — never a
 * direct SpeechSynthesis call — so swapping vendors is config, not code.
 */
class StreamingTTS {
  private _enabled = false;
  /** True while the queue is actively draining (first clause → last clause). */
  audioPlaying = false;
  /** Opaque voice identifier — interpreted by whichever provider is active. */
  voiceName = "";
  private provider: TTSProvider;
  private queue: StreamingTTSQueue;

  constructor(provider: TTSProvider) {
    this.provider = provider;
    this.queue = new StreamingTTSQueue(
      (text) => this.speakOne(text),
      () => {
        this.audioPlaying = true;
      },
      () => {
        this.audioPlaying = false;
      },
    );
  }

  /** Swap the underlying TTS provider at runtime. Cancels any in-flight speech. */
  setProvider(provider: TTSProvider): void {
    this.cancel();
    this.provider = provider;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  enable(): void {
    this._enabled = true;
  }

  disable(): void {
    this._enabled = false;
    this.cancel();
  }

  push(delta: string): void {
    if (!this._enabled) return;
    this.queue.push(delta);
  }

  flush(): void {
    if (!this._enabled) return;
    this.queue.flush();
  }

  cancel(): void {
    this.queue.cancel();
    this.audioPlaying = false;
    this.provider.cancel();
  }

  private async speakOne(text: string): Promise<void> {
    // Per-utterance options: voice is the only one we plumb — rate/pitch/volume
    // differ meaningfully across providers and the canonical VoiceConfig keeps
    // them provider-defined.
    const options = this.voiceName ? { voice: this.voiceName } : undefined;
    try {
      await this.provider.speak(text, options);
    } catch {
      // Swallow per-clause failures so the queue keeps draining. A fallback
      // chain (FallbackTTSProvider) should normally absorb these upstream; if
      // all providers fail, silence is honest degradation.
    }
  }
}

const streamingTTS = new StreamingTTS(new WebSpeechTTSProvider());

/** Swap the active TTS provider (e.g. when the user supplies an ElevenLabs key). */
export function setStreamingTTSProvider(provider: TTSProvider): void {
  streamingTTS.setProvider(provider);
}

export function setStreamingTTSEnabled(enabled: boolean): void {
  if (enabled) {
    streamingTTS.enable();
  } else {
    streamingTTS.disable();
  }
}

/** Set the TTS voice by name (matched against speechSynthesis.getVoices()). */
export function setTTSVoice(name: string): void {
  streamingTTS.voiceName = name;
}

/** True when TTS is actually producing audio (browser ground truth). */
export function isTTSAudioPlaying(): boolean {
  return streamingTTS.audioPlaying;
}

// === DOM Refs ===

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const chatInputRow = document.getElementById("chat-input-row") as HTMLDivElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const toastContainer = document.getElementById("toast-container") as HTMLDivElement;

// === Toast State ===

let activeToast: HTMLElement | null = null;
let activeToastTimer: ReturnType<typeof setTimeout> | null = null;

// === Tool Status Tracking ===

const toolStatusElements = new Map<string, HTMLElement>();

// === Ceiling CTA State ===

let userMessageCount = 0;
const CEILING_THRESHOLD = 5;

// === Exported Functions ===

export function addMessage(
  role: "user" | "assistant" | "system",
  text: string,
  immediate = false,
): void {
  if (!text) return; // Skip empty messages (e.g. suppressed errors)
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  if (role === "system") {
    bubble.innerHTML = text;
  } else if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text; // User messages stay plain
  }

  if (immediate) {
    bubble.classList.add("visible");
  }

  chatLog.appendChild(bubble);

  if (!immediate) {
    // Force reflow then animate
    void bubble.offsetWidth;
    bubble.classList.add("visible");
  }

  chatLog.scrollTop = chatLog.scrollHeight;
}

export function setProcessing(active: boolean): void {
  if (active) {
    chatInputRow.classList.add("processing");
    chatInput.disabled = true;
  } else {
    chatInputRow.classList.remove("processing");
    chatInput.disabled = false;
    chatInput.focus();
  }
}

/**
 * Renders a compact expandable card in the chat stream.
 * Summary line always visible; detail revealed on click.
 */
export function addExpandableCard(summary: string, detail: string): void {
  const card = document.createElement("div");
  card.className = "system-card";

  const summaryRow = document.createElement("div");
  summaryRow.className = "system-card-summary";

  const chevron = document.createElement("span");
  chevron.className = "system-card-chevron";
  chevron.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>';
  summaryRow.appendChild(chevron);

  const summaryText = document.createElement("span");
  summaryText.textContent = summary;
  summaryRow.appendChild(summaryText);

  card.appendChild(summaryRow);

  const detailEl = document.createElement("div");
  detailEl.className = "system-card-detail";
  const detailInner = document.createElement("div");
  detailInner.className = "system-card-detail-inner";
  detailInner.innerHTML = renderMarkdown(detail);
  detailEl.appendChild(detailInner);
  card.appendChild(detailEl);

  summaryRow.addEventListener("click", () => {
    card.classList.toggle("expanded");
  });

  chatLog.appendChild(card);
  void card.offsetWidth;
  card.classList.add("visible");
  chatLog.scrollTop = chatLog.scrollHeight;
}

export function showToast(text: string, duration = 3000): void {
  if (activeToast) {
    activeToast.remove();
    if (activeToastTimer != null) clearTimeout(activeToastTimer);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toastContainer.appendChild(el);
  void el.offsetWidth;
  el.classList.add("show");
  activeToast = el;
  activeToastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
    if (activeToast === el) activeToast = null;
  }, duration);
}

/** Human-readable tool names for chat display. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  delegate_to_agent: "Delegating to agent",
  invoke_capability: "Delegating to agent",
  recall_memories: "Searching memory",
  web_search: "Searching the web",
  read_url: "Reading page",
  self_reflect: "Reflecting",
  write_file: "Writing file",
  read_file: "Reading file",
  shell_exec: "Running command",
};

/** Human-readable capability names used by chip-tap invocations. */
const CAPABILITY_DISPLAY_NAMES: Record<string, string> = {
  review_pr: "Review this PR",
};

function capabilityLabel(capability: string): string {
  return CAPABILITY_DISPLAY_NAMES[capability] ?? capability;
}

function formatToolLabel(name: string, context?: string): string {
  const label = TOOL_DISPLAY_NAMES[name] ?? name;
  if (!context) return label;
  return `${label} — ${context}`;
}

/**
 * Build the calm in-flow leverage attribution (felt-accumulation Inc 3) — woven
 * into the assistant message, never a toast. The basis is produced-not-authored
 * by the memory-graph accrual source; `resolveAccrualAttribution` projects it to
 * a sensitivity-bounded phrase. Rendered as a quiet aside on the message bubble,
 * like the cost line — present and glanceable, never grabbing.
 */
export function buildAccrualAttributionEl(basis: AccrualBasis): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "accrual-attribution";
  el.textContent = `↻ ${resolveAccrualAttribution(basis).text}`;
  return el;
}

export function showToolStatus(name: string, context?: string): void {
  const el = document.createElement("div");
  el.className = "tool-status";
  el.textContent = `${formatToolLabel(name, context)}...`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  toolStatusElements.set(name, el);
}

export function completeToolStatus(name: string): void {
  const el = toolStatusElements.get(name);
  if (!el) return;
  // Keep the context in the completed text — just add checkmark
  const current = el.textContent ?? "";
  el.textContent = current.replace(/\.{3}$/, "") + " ✓";
  el.classList.add("done");
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => {
      el.remove();
      toolStatusElements.delete(name);
    }, 500);
  }, 1000);
}

// === Thinking Indicator ===

function showThinkingIndicator(): HTMLElement {
  const el = document.createElement("div");
  el.className = "thinking-indicator";
  el.innerHTML =
    '<div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div>';
  chatLog.appendChild(el);
  void el.offsetWidth;
  el.classList.add("visible");
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function removeThinkingIndicator(el: HTMLElement): void {
  el.remove();
}

// === Approval Card ===

function showApprovalCard(
  name: string,
  args: Record<string, unknown>,
  riskLevel: number | undefined,
  quorum?: { required: number; approvers: string[]; collected: string[] },
): Promise<boolean> {
  return new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "approval-card";

    const title = document.createElement("div");
    title.className = "approval-card-title";
    title.textContent = `Tool: ${name}`;
    card.appendChild(title);

    if (riskLevel != null) {
      const badge = document.createElement("span");
      badge.className = `approval-risk-badge risk-${Math.min(riskLevel, 3)}`;
      badge.textContent = `Risk ${riskLevel}`;
      title.appendChild(badge);
    }

    if (quorum && quorum.required > 1) {
      const qBadge = document.createElement("span");
      qBadge.className = "approval-risk-badge";
      qBadge.style.cssText = "background:#2196f3;color:#fff;margin-left:6px;";
      qBadge.textContent = `${quorum.collected.length}/${quorum.required} approvals`;
      title.appendChild(qBadge);
    }

    if (Object.keys(args).length > 0) {
      const argsEl = document.createElement("pre");
      argsEl.className = "approval-card-args";
      argsEl.textContent = JSON.stringify(args, null, 2);
      card.appendChild(argsEl);
    }

    const actions = document.createElement("div");
    actions.className = "approval-card-actions";

    const allowBtn = document.createElement("button");
    allowBtn.className = "approval-btn approve";
    allowBtn.textContent = "Allow";
    allowBtn.addEventListener("click", () => {
      card.classList.add("decided");
      title.textContent = `${name} — allowed`;
      actions.remove();
      resolve(true);
    });

    const denyBtn = document.createElement("button");
    denyBtn.className = "approval-btn deny";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => {
      card.classList.add("decided");
      title.textContent = `${name} — denied`;
      actions.remove();
      resolve(false);
    });

    actions.appendChild(allowBtn);
    actions.appendChild(denyBtn);
    card.appendChild(actions);

    chatLog.appendChild(card);
    void card.offsetWidth;
    card.classList.add("visible");
    chatLog.scrollTop = chatLog.scrollHeight;
  });
}

// === Ceiling CTA ===

function injectCeilingCTA(): void {
  if (hasCeilingBeenShown()) return;
  markCeilingShown();

  const cta = document.createElement("div");
  cta.className = "ceiling-cta";
  cta.innerHTML = `
    <div class="ceiling-cta-text">Your motebit has a cryptographic identity in this browser.</div>
    <div class="ceiling-cta-text" style="margin-top: 4px;">For hardware-secured identity (OS keyring), download the app.</div>
    <div class="ceiling-cta-actions">
      <a class="ceiling-cta-btn" href="https://github.com/motebit/motebit/releases" target="_blank" rel="noopener">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download App
      </a>
      <button class="ceiling-cta-dismiss">Maybe later</button>
    </div>
  `;

  chatLog.appendChild(cta);
  void cta.offsetWidth;
  cta.classList.add("visible");
  chatLog.scrollTop = chatLog.scrollHeight;

  const dismissBtn = cta.querySelector(".ceiling-cta-dismiss") as HTMLButtonElement;
  dismissBtn.addEventListener("click", () => {
    cta.style.opacity = "0";
    cta.style.transform = "translateY(8px)";
    setTimeout(() => cta.remove(), 250);
  });
}

// === Send Button Visibility ===

function updateSendButton(): void {
  if (chatInput.value.trim()) {
    sendBtn.classList.add("visible");
  } else {
    sendBtn.classList.remove("visible");
  }
}

// === Error Formatting ===

const SETTINGS_LINK = `<a href="#" class="chat-action-link" data-action="open-settings">`;
const RELOAD_LINK = `<a href="#" class="chat-action-link" data-action="reload">`;
const IDENTITY_LINK = `<a href="#" class="chat-action-link" data-action="open-identity">`;

export function formatErrorMessage(msg: string): string {
  // Rate limit — distinguish proxy free-tier from API rate limit
  if (msg.includes("rate_limited") || msg.includes("429")) {
    if (msg.includes("free") || msg.includes("daily")) {
      return `You've used your free messages for today. ${SETTINGS_LINK}Add your own API key</a> for unlimited use, or come back tomorrow.`;
    }
    return "Rate limited — too many requests. Wait a moment and try again.";
  }
  // Invalid API key
  if (msg.includes("401") || msg.includes("authentication_error")) {
    return `Invalid API key. ${SETTINGS_LINK}Check your key in Settings</a>.`;
  }
  // Motebit-cloud balance exhausted — the proxy's OWN 402 (`insufficient_balance`),
  // matched BEFORE the generic provider-billing 402 below. A cloud user has no
  // Anthropic console account, so "add credits at console.anthropic.com" is the
  // wrong instruction for them — they bring their own key (kept on-device) or
  // fund the droplet. The proxy can't distinguish free-preview-exhausted from
  // funded-then-drained (no balance history), so the copy is neutral truth that
  // serves both populations. See docs/doctrine — PR2 of the inference-reliability arc.
  if (msg.includes("insufficient_balance")) {
    return `Motebit Cloud has no balance available. ${SETTINGS_LINK}Add your own model key</a> — kept on this device — or fund your droplet to continue.`;
  }
  // No credits / billing — a BYOK provider's own account is out (e.g. Anthropic
  // console). Distinct from the motebit-cloud balance wall handled just above.
  if (msg.includes("402") || msg.includes("billing")) {
    return `No API credits. Add credits at <a href="https://console.anthropic.com" target="_blank" rel="noopener" class="chat-action-link">console.anthropic.com</a>, or ${SETTINGS_LINK}use a different key</a>.`;
  }
  // Overloaded
  if (msg.includes("529") || msg.includes("overloaded")) {
    return "Claude is overloaded right now. Try again in a moment.";
  }
  // Network failure (browser-level fetch error)
  if (
    msg.includes("Load failed") ||
    msg.includes("Failed to fetch") ||
    msg.includes("NetworkError")
  ) {
    return `Couldn't reach the server. ${SETTINGS_LINK}Connect your own API key</a> to chat directly with Claude.`;
  }
  // Initial-response timeout from @motebit/ai-core's fetchWithConnectionTimeout:
  // the upstream accepted the socket but never returned headers. Distinct from
  // "Failed to fetch" (connection refused) — the server is reachable but stuck.
  if (msg.includes("connection timeout after")) {
    return `The AI server didn't respond in time. ${SETTINGS_LINK}Try a different provider</a> or try again.`;
  }
  // Stage timeout from @motebit/ai-core's withStageTimeout: a specific step
  // in the turn pipeline (persistence, memory graph, embed) hung past its
  // deadline. Caller already knows which stage from structured telemetry;
  // the user-facing copy is intentionally stage-agnostic — "something
  // internal is stuck" is the actionable summary.
  if (msg.includes("timed out after") && msg.includes("stage ")) {
    return `Something internal is stuck — reloading usually clears it. <a href="#" class="chat-action-link" data-action="reload">Reload</a>.`;
  }
  // Safari WebKit noise — suppress known harmless DOM exceptions
  if (msg.includes("did not match the expected pattern")) {
    return ""; // Suppress — Safari IDB/streaming artifact, not a real error
  }
  // Generic fallback — still show the raw error for debugging
  return `Something went wrong: ${msg}`;
}

/**
 * User-visible copy for deterministic invocation failures. Mirrors the
 * failure-mode taxonomy in `docs/doctrine/surface-determinism.md`. One copy
 * string per `DelegationErrorCode` — adding a new code to the runtime MUST
 * come with a new line here (the chat handler never shows a raw code).
 */
function failureCopy(code: string, retryAfterSeconds?: number): string {
  switch (code) {
    case "sync_not_enabled":
      // The device never paired with a relay this session. Common right after
      // site-data clear, dev-stack restart, or first load. Remediation is to
      // open Identity and connect — not "sign in" (no sessions here).
      return `Relay not connected. ${IDENTITY_LINK}Connect in Identity</a> to delegate.`;
    case "network_unreachable":
      return "Relay unreachable — check your connection and try again.";
    case "auth_expired":
      // Motebit has no "session" — the device holds a sovereign key and mints
      // short-lived signed tokens the relay verifies against the registered
      // public key. A 401 here means the relay rejected the signature: either
      // the relay's state rotated (dev restart, key rotation) or the device
      // registration is out of sync. Reloading triggers the bootstrap path
      // which re-registers the device. NO "sign in" — that would be borrowed
      // session-auth vocabulary this protocol does not have.
      return `Relay rejected the device token. ${RELOAD_LINK}Reload</a> to re-register.`;
    case "unauthorized":
      return "Not authorized to invoke that capability.";
    case "rate_limited": {
      const wait = retryAfterSeconds ?? 60;
      return `Too many requests — try again in ${wait}s.`;
    }
    case "insufficient_balance":
      return "Insufficient balance. Open the Sovereign panel to fund the droplet.";
    case "payment_proof_required":
      // Arc 3.5 gate: that agent charges, and paid delegation settles
      // peer-to-peer (the delegator pays the worker and fee onchain in one tx).
      // This surface doesn't sign that payment yet — honest "not yet," not a
      // funding problem. NOT "insufficient balance" (there may well be funds).
      return "Paid delegation to that agent settles peer-to-peer onchain, which this surface can't sign yet.";
    case "p2p_ineligible":
      // The hire path's most common wall: a brand-new agent (no trust history)
      // is paid directly only when the user has consciously opted in. No funds
      // moved (the eligibility pre-flight blocks the broadcast). Remediation is
      // the exact Governance toggle. Calm + actionable, never a dead end.
      return `Paying a new agent directly is off by default. ${SETTINGS_LINK}Turn on "Pay new agents directly"</a> in Settings → Governance to hire them.`;
    case "no_sovereign_rail":
      // A pinned hire settles peer-to-peer, so it needs a funded sovereign
      // wallet. Without one the runtime fails closed rather than substituting a
      // relay-routed worker (surface-determinism).
      return "Hiring a specific agent settles peer-to-peer — fund a sovereign wallet in the Sovereign panel to pay directly.";
    case "worker_not_payable":
      return "That agent isn't set up to be paid right now (no price or settlement address).";
    case "payment_broadcast_failed":
      return "The onchain payment didn't go through — no funds moved. Check your balance and try again.";
    case "trust_threshold_unmet":
      return "Trust below threshold for that capability. Reviews accumulate trust over time.";
    case "no_routing":
      return "No agents available for that capability right now. Try again later.";
    case "malformed_request":
      return "Internal error: malformed delegation request. Please report this.";
    case "timeout":
      return "The review didn't complete in time — the agent may be busy or offline.";
    case "agent_failed":
      return "The agent failed mid-task. Logged for the operator.";
    case "malformed_receipt":
      return "Agent returned a malformed receipt. Logged for the operator.";
    default:
      return `Delegation failed (${code}).`;
  }
}

// === Chat Init ===

export interface ChatCallbacks {
  openSettings(): void;
  /** Open Settings straight to the provider/model (Intelligence) tab — the deferred-setup landing. */
  openProviderSettings?(): void;
  /**
   * Attempt the free "first taste" on motebit cloud — fetch a proxy-token (the
   * relay grants the one-time free credit if enabled) and connect. Resolves true
   * if a provider got connected. Called on the first message of a fresh motebit
   * with no provider, before falling back to the setup guide.
   */
  tryFreeCloud?(): Promise<boolean>;
  openConversations?(): void;
  openShortcuts?(): void;
}

export interface ChatAPI {
  handleSend(): Promise<void>;
  /** Voice-initiated send: processes through runtime with TTS response, no chat bubbles. */
  handleVoiceSend(transcript: string): Promise<void>;
  /** Register slash command handler so Enter key executes commands. */
  setSlashCommands(handle: { tryExecute(text: string): boolean }): void;
  /**
   * Emerge the hire-compose register on the slab, pinned to a specific agent +
   * capability. Called by the Agents panel when the user taps a priced
   * capability — the panel browses, the slab composes + acts.
   */
  emergeHire(req: HireComposeRequest): void;
}

export function initChat(ctx: WebContext, callbacks: ChatCallbacks): ChatAPI {
  let slashHandle: { tryExecute(text: string): boolean } | null = null;

  async function handleSend(textOverride?: string): Promise<void> {
    const text = (textOverride ?? chatInput.value).trim();
    if (!text || ctx.app.isProcessing) return;

    // /plan <goal> — decompose and execute multi-step plan
    if (text.startsWith("/plan ")) {
      const goal = text.slice(6).trim();
      if (goal) {
        chatInput.value = "";
        updateSendButton();
        void executePlanInChat(goal);
        return;
      }
    }

    // Delegate slash commands to the registered handler
    if (text.startsWith("/") && slashHandle?.tryExecute(text)) {
      return;
    }

    chatInput.value = "";
    updateSendButton();

    streamingTTS.cancel(); // Interrupt any ongoing speech
    // Typed sends must not inherit TTS from a previous voice send.
    // handleVoiceSend enables TTS before calling us, so voice sends stay active.
    if (textOverride == null) {
      streamingTTS.disable();
    }

    if (!ctx.app.isProviderConnected) {
      // Activation: the user expressed intent, so try the free "first taste" on
      // motebit cloud before asking them to set anything up. Show the thinking
      // dots so the connect isn't a dead pause; on success we fall through and
      // send. Only guide to Settings if the free cloud isn't available (disabled
      // / exhausted / offline). This is the first (and only, until they sync)
      // moment a fresh motebit contacts the relay — on intent, never on load.
      const connecting = showThinkingIndicator();
      let connected = false;
      try {
        connected = (await callbacks.tryFreeCloud?.()) ?? false;
      } finally {
        connecting.remove();
      }
      if (!connected) {
        addMessage(
          "system",
          "I need a model to think. Choose one in Settings — on-device, your own key, or motebit cloud.",
        );
        (callbacks.openProviderSettings ?? callbacks.openSettings)();
        return;
      }
    }

    addMessage("user", text);
    userMessageCount++;

    // Check ceiling CTA threshold
    if (userMessageCount === CEILING_THRESHOLD) {
      injectCeilingCTA();
    }

    setProcessing(true);
    const thinkingEl = showThinkingIndicator();

    let bubble: HTMLDivElement | null = null;
    let textEl: HTMLSpanElement | null = null;
    let accumulated = "";
    let firstChunkReceived = false;
    const renderer = new StreamingRenderer();
    // Captured from the most recent delegation_complete that carried a full
    // signed receipt. Emerged as a spatial artifact after the result chunk
    // so the review text stays unopposed as the primary content; the receipt
    // bubble is the witness, not the work.
    let capturedReceipt: ExecutionReceipt | null = null;

    try {
      // Stamp the typed-intent attestation onto this turn. The
      // runtime threads it to tools that need to distinguish a
      // user-driven turn from proactive idle work — chiefly
      // `request_control`, which auto-grants control handoffs that
      // originate inside the same gesture as a user-typed message
      // instead of opening the slab band's doorbell. The attestation
      // proves intentional delivery (the user typed and submitted
      // this); content authenticity is not implied. Doctrine:
      // `CLAUDE.md` § UI ("do not confirm what the user can already
      // see") + perception.ts on attestation semantics.
      for await (const chunk of ctx.app.sendMessageStreaming(text, undefined, {
        userActionAttestation: {
          kind: "user-typed-intent",
          timestamp: Date.now(),
          surface: "web",
        },
      })) {
        switch (chunk.type) {
          case "text": {
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              removeThinkingIndicator(thinkingEl);

              bubble = document.createElement("div");
              bubble.className = "chat-bubble assistant";
              textEl = document.createElement("span");
              textEl.className = "bubble-text";
              bubble.appendChild(textEl);
              chatLog.appendChild(bubble);
              void bubble.offsetWidth;
              bubble.classList.add("visible");
            }

            accumulated += chunk.text;
            renderer.push(textEl!, accumulated, () => {
              chatLog.scrollTop = chatLog.scrollHeight;
            });
            streamingTTS.push(chunk.text);
            break;
          }

          case "reasoning": {
            // Interior cognition made legible to the OWNER without cluttering
            // the conversation. The `mind` register is hidden on the slab plane
            // by doctrine and "lives in chat"; this is its calm, opt-in form —
            // a collapsed <details> the sovereign can expand to feel the
            // interior (`felt-interior.md`), never an always-open panel.
            // INTERIOR-ONLY: rendered as ephemeral DOM, never added to
            // `accumulated`, so it is not persisted to (or synced from) the
            // conversation. `textContent` keeps the trace literal — no markdown,
            // no HTML injection from model output.
            if (bubble && chunk.text.trim() !== "") {
              const details = document.createElement("details");
              details.className = "chat-reasoning";
              const summary = document.createElement("summary");
              summary.className = "chat-reasoning-summary";
              summary.textContent = "reasoning";
              const body = document.createElement("div");
              body.className = "chat-reasoning-body";
              body.textContent = chunk.text;
              details.appendChild(summary);
              details.appendChild(body);
              bubble.appendChild(details);
              chatLog.scrollTop = chatLog.scrollHeight;
            }
            break;
          }

          case "tool_status": {
            if (chunk.status === "calling") {
              showToolStatus(chunk.name, chunk.context);
            } else if (chunk.status === "done") {
              completeToolStatus(chunk.name);
            }
            break;
          }

          case "delegation_complete": {
            // When the delegated tool was a motebit_task with a full signed
            // receipt, capture it for emergence as a receipt artifact after
            // the result chunk completes. Multiple delegations in one turn
            // keep the latest — the bubble represents the most consequential
            // result, not the full activity log.
            if (chunk.full_receipt) {
              capturedReceipt = chunk.full_receipt;
            }
            break;
          }

          case "approval_request": {
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              removeThinkingIndicator(thinkingEl);
            }
            const approved = await showApprovalCard(
              chunk.name,
              chunk.args,
              chunk.risk_level,
              chunk.quorum,
            );
            // Resume the stream after approval decision
            for await (const resumeChunk of ctx.app.resolveApprovalVote(
              approved,
              ctx.app.motebitId,
            )) {
              if (resumeChunk.type === "text") {
                if (!bubble) {
                  bubble = document.createElement("div");
                  bubble.className = "chat-bubble assistant";
                  textEl = document.createElement("span");
                  textEl.className = "bubble-text";
                  bubble.appendChild(textEl);
                  chatLog.appendChild(bubble);
                  void bubble.offsetWidth;
                  bubble.classList.add("visible");
                }
                accumulated += resumeChunk.text;
                renderer.push(textEl!, accumulated, () => {
                  chatLog.scrollTop = chatLog.scrollHeight;
                });
                streamingTTS.push(resumeChunk.text);
              } else if (resumeChunk.type === "tool_status") {
                if (resumeChunk.status === "calling")
                  showToolStatus(resumeChunk.name, resumeChunk.context);
                else if (resumeChunk.status === "done") completeToolStatus(resumeChunk.name);
              } else if (resumeChunk.type === "result") {
                streamingTTS.flush();
              }
            }
            break;
          }

          case "injection_warning": {
            addMessage(
              "system",
              `Injection warning from tool "${chunk.tool_name}": ${chunk.patterns.join(", ")}`,
            );
            break;
          }

          case "task_step_narration": {
            // Feed the validated narration into the slab's chrome for
            // the `motebit × virtual_browser` register. The runtime
            // already corrected wire-truth contradictions via
            // `validateTaskStepNarration` before the chunk left the
            // loop, so the chrome renders `text` verbatim. Doctrine:
            // `chrome-as-state-render.md` § "Hybrid narration source."
            ctx.app.setTaskStepNarration(chunk.text);
            break;
          }

          case "approval_expired": {
            addMessage("system", `Tool "${chunk.tool_name}" approval expired — auto-denied.`);
            break;
          }

          case "artifact": {
            if (chunk.action === "add" && chunk.content) {
              const el = document.createElement("div");
              el.className = `spatial-artifact artifact-${chunk.kind}`;
              if (chunk.title) {
                const titleEl = document.createElement("div");
                titleEl.className = "spatial-artifact-title";
                titleEl.textContent = chunk.title;
                el.appendChild(titleEl);
              }
              const bodyEl = document.createElement("div");
              bodyEl.className = "spatial-artifact-body";
              bodyEl.textContent = chunk.content;
              el.appendChild(bodyEl);
              ctx.app.addArtifact({ id: chunk.artifact_id, kind: chunk.kind, element: el });
            } else if (chunk.action === "remove") {
              ctx.app.removeArtifact(chunk.artifact_id);
            }
            break;
          }

          case "result": {
            streamingTTS.flush();
            // Clear the task-step narration at turn end so the
            // chrome's `motebit × virtual_browser` register recedes
            // to its empty state before the next turn begins. A
            // stale narration would otherwise render against an
            // unrelated state on a subsequent /computer interaction.
            ctx.app.setTaskStepNarration(null);
            // Emerge the receipt bubble after the review text settles. 200ms
            // beat preserves the review-as-primary, receipt-as-witness order.
            if (capturedReceipt) {
              const receipt = capturedReceipt;
              const id = `receipt-${receipt.task_id}`;
              window.setTimeout(() => {
                const el = buildReceiptArtifact(receipt, () => {
                  void ctx.app.removeArtifact(id);
                });
                ctx.app.addArtifact({ id, kind: "receipt", element: el });
              }, 200);
            }
            // Show per-message cost for cloud users (calm — subtle, not distracting)
            if (chunk.result.totalTokens != null && chunk.result.totalTokens > 0 && bubble) {
              const costEl = document.createElement("div");
              costEl.className = "message-cost";
              costEl.textContent = `${chunk.result.totalTokens.toLocaleString()} tokens`;
              bubble.appendChild(costEl);
            }
            // Felt accumulation (Inc 3): the leverage moment — a calm in-flow
            // attribution when this turn drew on a recalled memory. Woven into
            // the message, never a toast. Produced-not-authored upstream; absent
            // is the fail-closed default (no consequential recall → nothing).
            if (chunk.result.accrualBasis && bubble) {
              bubble.appendChild(buildAccrualAttributionEl(chunk.result.accrualBasis));
            }
            // TTFT instrumentation: one content-free latency line per turn — the
            // time-to-first-token split (context pipeline vs provider). Console-only
            // (no UI), emitted in every environment so the breakdown is readable from
            // a live session. See @motebit/ai-core TurnLatency. Aggregation is a
            // deliberate later step.
            if (chunk.result.latency) {
              const l = chunk.result.latency;
              // eslint-disable-next-line no-console -- deliberate TTFT instrumentation, one content-free latency line per turn, emitted in every environment so the breakdown is readable from a live session
              console.debug(
                `[ttft] ${l.ttft_ms}ms (pipeline ${l.context_pipeline_ms}ms · provider ${l.provider_ttft_ms}ms · embed ${l.embed_ms} · retrieve ${l.memory_retrieve_ms} · events ${l.event_query_ms} · pinned ${l.pinned_ms})`,
              );
            }
            break;
          }
        }
      }
      // Force the final coalesced paint so the last tokens (which may have
      // landed mid-frame) are always shown before the turn settles.
      renderer.flush();
      // Post-loop cleanup: unconditionally remove thinking indicator.
      // Covers all edge cases (tag-only responses, tool-only iterations,
      // early break, missing result chunk). Safe to call if already removed.
      removeThinkingIndicator(thinkingEl);
    } catch (err: unknown) {
      // Flush before the empty-bubble check below reads textContent — a
      // coalesced paint may still be pending when the error interrupts.
      renderer.flush();
      removeThinkingIndicator(thinkingEl);
      const msg = err instanceof Error ? err.message : String(err);
      if (bubble && !textEl?.textContent) {
        bubble.remove();
      }
      // Map errors to actionable messages
      const systemMsg = formatErrorMessage(msg);
      addMessage("system", systemMsg);
    } finally {
      setProcessing(false);
      // Clear any in-flight narration so an aborted turn doesn't
      // leave the chrome's `motebit × virtual_browser` register
      // claiming motebit is doing something it isn't. Idempotent
      // with the `result` chunk's clear on the success path.
      ctx.app.setTaskStepNarration(null);
    }
  }

  /** Execute a multi-step plan and stream progress into chat. */
  async function executePlanInChat(goal: string): Promise<void> {
    if (!ctx.app.isProviderConnected) {
      addMessage(
        "system",
        "I need a model to think. Choose one in Settings — on-device, your own key, or motebit cloud.",
      );
      (callbacks.openProviderSettings ?? callbacks.openSettings)();
      return;
    }

    addMessage("user", `/plan ${goal}`);
    setProcessing(true);

    const goalId = crypto.randomUUID();
    let currentBubble: HTMLDivElement | null = null;
    let currentTextEl: HTMLSpanElement | null = null;
    let accumulated = "";
    const renderer = new StreamingRenderer();

    try {
      for await (const chunk of ctx.app.executeGoal(goalId, goal)) {
        switch (chunk.type) {
          case "plan_created": {
            addMessage("system", `Plan: ${chunk.plan.title}`);

            // Materialize plan steps as a spatial artifact beside the creature
            const planEl = document.createElement("div");
            planEl.className = "spatial-artifact artifact-plan";
            const titleEl = document.createElement("div");
            titleEl.className = "spatial-artifact-title";
            titleEl.textContent = chunk.plan.title;
            planEl.appendChild(titleEl);
            const bodyEl = document.createElement("div");
            bodyEl.className = "spatial-artifact-body";
            for (let i = 0; i < chunk.steps.length; i++) {
              const stepLine = document.createElement("div");
              stepLine.className = "plan-step-line";
              stepLine.id = `plan-step-${i}`;
              stepLine.textContent = `${i + 1}. ${chunk.steps[i]!.description}`;
              bodyEl.appendChild(stepLine);
            }
            planEl.appendChild(bodyEl);

            // Dismiss button — user controls when artifact leaves
            const closeBtn = document.createElement("button");
            closeBtn.className = "spatial-artifact-close";
            closeBtn.textContent = "×";
            closeBtn.addEventListener("click", () => ctx.app.removeArtifact(`plan-${goalId}`));
            planEl.appendChild(closeBtn);

            ctx.app.addArtifact({
              id: `plan-${goalId}`,
              kind: "plan",
              element: planEl,
            });
            break;
          }
          case "step_started":
            accumulated = "";
            currentBubble = document.createElement("div");
            currentBubble.className = "chat-bubble assistant";
            currentTextEl = document.createElement("span");
            currentTextEl.className = "bubble-text";
            currentTextEl.textContent = `Step: ${chunk.step.description}\n`;
            currentBubble.appendChild(currentTextEl);
            chatLog.appendChild(currentBubble);
            void currentBubble.offsetWidth;
            currentBubble.classList.add("visible");
            break;
          case "step_chunk":
            if (chunk.chunk.type === "text" && currentTextEl) {
              accumulated += chunk.chunk.text;
              renderer.push(currentTextEl, accumulated, () => {
                chatLog.scrollTop = chatLog.scrollHeight;
              });
            }
            break;
          case "step_completed": {
            // Paint this step's final text before its element is released.
            renderer.flush();
            // Update the spatial artifact — mark this step done
            const planArtifact = document.querySelector(`#plan-step-${chunk.step.ordinal}`);
            if (planArtifact) planArtifact.classList.add("step-done");
            // Step done — bubble stays
            currentBubble = null;
            currentTextEl = null;
            break;
          }
          case "step_delegated": {
            const rc = chunk.routing_choice;
            const agentId = rc?.selected_agent ?? chunk.task_id?.slice(0, 8) ?? "network";
            const agentShort = agentId.length > 12 ? agentId.slice(0, 8) + "…" : agentId;
            let detail = `Step ${chunk.step.ordinal + 1} → agent ${agentShort}`;
            if (rc) {
              const parts: string[] = [];
              if (rc.sub_scores.trust != null)
                parts.push(`trust ${(rc.sub_scores.trust * 100).toFixed(0)}%`);
              if (rc.sub_scores.latency != null)
                parts.push(`${rc.sub_scores.latency.toFixed(0)}ms`);
              if (parts.length > 0) detail += ` (${parts.join(", ")})`;
              if (rc.alternatives_considered > 0)
                detail += `\n${rc.alternatives_considered + 1} agents evaluated`;
            }
            addMessage("system", detail);
            break;
          }
          case "step_failed":
            addMessage("system", `Step failed: ${chunk.error}`);
            break;
          case "plan_completed":
            addMessage("system", "Plan complete.");
            // Artifact stays — user dismisses with X button
            break;
          case "plan_failed":
            addMessage("system", `Plan failed: ${chunk.reason}`);
            // Artifact stays so user can see which steps failed
            break;
          case "plan_retrying":
            addMessage("system", "Retrying with adjusted plan…");
            break;
        }
      }
    } catch (err: unknown) {
      renderer.flush();
      const msg = err instanceof Error ? err.message : String(err);
      addMessage("system", `Plan error: ${msg}`);
    } finally {
      renderer.flush();
      setProcessing(false);
    }
  }

  /**
   * Voice-initiated send: enables TTS so the creature speaks the response,
   * then delegates to handleSend for full chat rendering. The conversation
   * is continuous — voice messages appear in the chat log like typed ones.
   */
  async function handleVoiceSend(transcript: string): Promise<void> {
    streamingTTS.enable();
    await handleSend(transcript);
  }

  /**
   * Deterministic chip / affordance → delegation. Opens an assistant bubble,
   * streams the result into it, emerges a receipt artifact on success, and
   * maps `invoke_error` chunks to the failure-mode UX documented in
   * `docs/doctrine/surface-determinism.md`. No AI in the routing path; no
   * fall-through to `handleSend` on failure — honest degradation only.
   */
  async function runChipInvocation(
    capability: string,
    prompt: string,
    pin?: { targetWorkerId?: string },
  ): Promise<void> {
    if (ctx.app.isProcessing) return;

    addMessage("user", `${capabilityLabel(capability)}: ${prompt}`);
    setProcessing(true);

    showToolStatus("invoke_capability", capabilityLabel(capability));

    let bubble: HTMLDivElement | null = null;
    let textEl: HTMLSpanElement | null = null;
    let accumulated = "";
    let capturedReceipt: ExecutionReceipt | null = null;
    const renderer = new StreamingRenderer();

    try {
      // A pinned `targetWorkerId` makes this a deterministic hire of THAT worker
      // (the agent the user tapped) — never a capability-routed substitute. The
      // runtime fails closed if that worker can't be paid P2P (see
      // relay-delegation `selectAndRunDelegation`); no AI in the routing path.
      for await (const chunk of ctx.app.invokeCapability(capability, prompt, pin)) {
        switch (chunk.type) {
          case "delegation_start":
            // Already showing tool_status — no double-indicator.
            break;
          case "text": {
            if (!bubble) {
              bubble = document.createElement("div");
              bubble.className = "chat-bubble assistant";
              textEl = document.createElement("span");
              textEl.className = "bubble-text";
              bubble.appendChild(textEl);
              chatLog.appendChild(bubble);
              void bubble.offsetWidth;
              bubble.classList.add("visible");
            }
            accumulated += chunk.text;
            renderer.push(textEl!, accumulated, () => {
              chatLog.scrollTop = chatLog.scrollHeight;
            });
            break;
          }
          case "delegation_complete": {
            if (chunk.full_receipt) capturedReceipt = chunk.full_receipt;
            completeToolStatus("invoke_capability");
            break;
          }
          case "invoke_error": {
            // Reach the failure taxonomy from docs/doctrine/surface-determinism.md.
            // Each code gets its own copy; we never fall through to the AI loop
            // or hide the failure behind a retry.
            completeToolStatus("invoke_capability");
            if (bubble && !accumulated) bubble.remove();
            addMessage("system", failureCopy(chunk.code, chunk.retryAfterSeconds));
            return;
          }
        }
      }
    } catch (err: unknown) {
      completeToolStatus("invoke_capability");
      if (bubble && !accumulated) bubble.remove();
      const msg = err instanceof Error ? err.message : String(err);
      addMessage("system", `Delegation error: ${msg}`);
      return;
    } finally {
      renderer.flush();
      setProcessing(false);
    }

    // Emerge the receipt artifact after the review text settles. The 200ms
    // beat matches the handleSend path — review as primary, receipt as
    // witness.
    if (capturedReceipt) {
      const receipt = capturedReceipt;
      const id = `receipt-${receipt.task_id}`;
      window.setTimeout(() => {
        const el = buildReceiptArtifact(receipt, () => {
          void ctx.app.removeArtifact(id);
        });
        ctx.app.addArtifact({ id, kind: "receipt", element: el });
      }, 200);
    }
  }

  // === Hire-compose register (the slab hand-organ) ===
  // The roster is browsed in the Agents panel; the hire is composed and
  // performed HERE, on the slab. A Discover-card hire pins {worker, capability,
  // price}; the chat input becomes the compose field; the act-button carries the
  // price (payment-as-act). The pin flows to invokeCapability as
  // `targetWorkerId`, which fails closed (never substitutes) per
  // surface-determinism. Standalone component (sibling of pr-url-chip); we own
  // the single Enter handler below and defer to its isActive()/fire(). See
  // docs/doctrine/agents-as-first-person-trust-graph.md §5 + motebit-computer.md.
  const hireChip = installHireChip({
    input: chatInput,
    row: chatInputRow,
    onRun: (capability, task, workerId) =>
      void runChipInvocation(capability, task, { targetWorkerId: workerId }),
    labelCapability: capabilityLabel,
  });
  const emergeHire = (req: HireComposeRequest): void => hireChip.emerge(req);

  // Wire up the PR-URL paste chip — deterministic `review_pr` invocation.
  // No AI in the routing path; see docs/doctrine/surface-determinism.md.
  installPrUrlChip({
    input: chatInput,
    row: chatInputRow,
    onInvoke: (capability, promptText) => void runChipInvocation(capability, promptText),
  });

  // Wire up Enter key. While a hire is composing, Enter (and the Run button)
  // fire the hire; Escape dismisses the register and restores normal send.
  chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape" && hireChip.isActive()) {
      e.preventDefault();
      hireChip.dismiss();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (hireChip.isActive()) {
        hireChip.fire();
        return;
      }
      void handleSend();
    }
  });

  // Wire up send button
  sendBtn.addEventListener("click", () => {
    void handleSend();
  });

  // Wire up input → send button visibility
  chatInput.addEventListener("input", updateSendButton);

  // Wire up action links in system messages (e.g. "open settings")
  chatLog.addEventListener("click", (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(".chat-action-link");
    if (!link) return;
    e.preventDefault();
    if (link.dataset.action === "open-settings") {
      // Open directly to the Intelligence tab for API key entry
      const settingsModal = document.getElementById("settings-modal");
      if (settingsModal) {
        callbacks.openSettings();
        // Switch to intelligence tab after modal opens
        const intelligenceTab = document.querySelector<HTMLElement>(
          '.settings-tab[data-tab="intelligence"]',
        );
        intelligenceTab?.click();
      } else {
        callbacks.openSettings();
      }
    } else if (link.dataset.action === "reload") {
      // Device-token rejected by the relay — triggers the bootstrap path
      // on reload so the device re-registers against the current relay
      // identity. See failureCopy("auth_expired").
      window.location.reload();
    } else if (link.dataset.action === "open-identity") {
      // Route to Settings → Identity (not Intelligence) for first-connect /
      // device-pairing. See failureCopy("sync_not_enabled").
      callbacks.openSettings();
      const identityTab = document.querySelector<HTMLElement>('.settings-tab[data-tab="identity"]');
      identityTab?.click();
    }
  });

  return {
    handleSend,
    handleVoiceSend,
    setSlashCommands(handle: { tryExecute(text: string): boolean }) {
      slashHandle = handle;
    },
    emergeHire,
  };
}
