import type { WebContext } from "../types";
import { hasCeilingBeenShown, markCeilingShown } from "../storage";
import { StreamingTTSQueue } from "@motebit/voice";

// === Streaming TTS ===

/**
 * Thin wrapper around StreamingTTSQueue for the web surface.
 * Adds enable/disable gating, voice selection, and audioPlaying tracking
 * (consumed by main.ts syncTTS loop to detect TTS completion).
 */
class StreamingTTS {
  private _enabled = false;
  /** True when the browser is actually producing audio (from utterance.onstart). */
  audioPlaying = false;
  /** Selected voice name — matched against speechSynthesis.getVoices(). */
  voiceName = "";
  private queue: StreamingTTSQueue;

  constructor() {
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
    const wasActive = this.queue.draining || this.audioPlaying;
    this.queue.cancel();
    this.audioPlaying = false;
    if (wasActive && typeof speechSynthesis !== "undefined") {
      speechSynthesis.cancel();
    }
  }

  private speakOne(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      if (this.voiceName) {
        const match = speechSynthesis.getVoices().find((v) => v.name === this.voiceName);
        if (match) utterance.voice = match;
      }
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      utterance.volume = 0.85;
      utterance.onstart = () => {
        this.audioPlaying = true;
      };
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      speechSynthesis.speak(utterance);
    });
  }
}

const streamingTTS = new StreamingTTS();

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
const errorBanner = document.getElementById("error-banner") as HTMLDivElement;

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
  // System messages may contain safe HTML (action links); user/assistant use textContent
  if (role === "system") {
    bubble.innerHTML = text;
  } else {
    bubble.textContent = text;
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
  detailInner.textContent = detail;
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

export function showBanner(text: string, action?: { label: string; onClick: () => void }): void {
  const item = document.createElement("div");
  item.className = "error-banner-item";

  const textEl = document.createElement("span");
  textEl.className = "error-banner-text";
  textEl.textContent = text;
  item.appendChild(textEl);

  if (action) {
    const actionBtn = document.createElement("button");
    actionBtn.className = "error-banner-action";
    actionBtn.textContent = action.label;
    actionBtn.addEventListener("click", () => {
      action.onClick();
      removeBannerItem(item);
    });
    item.appendChild(actionBtn);
  }

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "error-banner-dismiss";
  dismissBtn.textContent = "\u00d7";
  dismissBtn.addEventListener("click", () => removeBannerItem(item));
  item.appendChild(dismissBtn);

  errorBanner.appendChild(item);
  errorBanner.classList.add("visible");
  void item.offsetWidth;
  item.classList.add("visible");
}

function removeBannerItem(item: HTMLElement): void {
  item.classList.remove("visible");
  setTimeout(() => {
    item.remove();
    if (errorBanner.children.length === 0) {
      errorBanner.classList.remove("visible");
    }
  }, 250);
}

export function dismissBanner(): void {
  errorBanner.innerHTML = "";
  errorBanner.classList.remove("visible");
}

/** Human-readable tool names for chat display. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  delegate_to_agent: "Delegating to agent",
  recall_memories: "Searching memory",
  web_search: "Searching the web",
  read_url: "Reading page",
  self_reflect: "Reflecting",
};

export function showToolStatus(name: string): void {
  const el = document.createElement("div");
  el.className = "tool-status";
  el.textContent = `${TOOL_DISPLAY_NAMES[name] ?? name}...`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  toolStatusElements.set(name, el);
}

export function completeToolStatus(name: string): void {
  const el = toolStatusElements.get(name);
  if (!el) return;
  el.textContent = `${TOOL_DISPLAY_NAMES[name] ?? name} ✓`;
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

function formatErrorMessage(msg: string): string {
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
  // No credits / billing
  if (msg.includes("402") || msg.includes("billing") || msg.includes("insufficient")) {
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
  // Safari WebKit noise — suppress known harmless DOM exceptions
  if (msg.includes("did not match the expected pattern")) {
    return ""; // Suppress — Safari IDB/streaming artifact, not a real error
  }
  // Generic fallback — still show the raw error for debugging
  return `Something went wrong: ${msg}`;
}

// === Chat Init ===

export interface ChatCallbacks {
  openSettings(): void;
  openConversations?(): void;
  openShortcuts?(): void;
}

export interface ChatAPI {
  handleSend(): Promise<void>;
  /** Voice-initiated send: processes through runtime with TTS response, no chat bubbles. */
  handleVoiceSend(transcript: string): Promise<void>;
  /** Register slash command handler so Enter key executes commands. */
  setSlashCommands(handle: { tryExecute(text: string): boolean }): void;
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
      addMessage("system", "No provider connected. Open settings to configure one.");
      return;
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

    try {
      for await (const chunk of ctx.app.sendMessageStreaming(text)) {
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
            textEl!.textContent = accumulated;
            chatLog.scrollTop = chatLog.scrollHeight;
            streamingTTS.push(chunk.text);
            break;
          }

          case "tool_status": {
            if (chunk.status === "calling") {
              showToolStatus(chunk.name);
            } else if (chunk.status === "done") {
              completeToolStatus(chunk.name);
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
                textEl!.textContent = accumulated;
                chatLog.scrollTop = chatLog.scrollHeight;
                streamingTTS.push(resumeChunk.text);
              } else if (resumeChunk.type === "tool_status") {
                if (resumeChunk.status === "calling") showToolStatus(resumeChunk.name);
                else if (resumeChunk.status === "done") completeToolStatus(resumeChunk.name);
              } else if (resumeChunk.type === "result") {
                streamingTTS.flush();
                void ctx.app.autoTitle();
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

          case "approval_expired": {
            addMessage("system", `Tool "${chunk.tool_name}" approval expired — auto-denied.`);
            break;
          }

          case "result": {
            streamingTTS.flush();
            // Trigger auto-titling in background (best-effort, don't surface errors)
            void ctx.app.autoTitle().catch(() => {});
            break;
          }
        }
      }
      // Post-loop cleanup: unconditionally remove thinking indicator.
      // Covers all edge cases (tag-only responses, tool-only iterations,
      // early break, missing result chunk). Safe to call if already removed.
      removeThinkingIndicator(thinkingEl);
    } catch (err: unknown) {
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
    }
  }

  /** Execute a multi-step plan and stream progress into chat. */
  async function executePlanInChat(goal: string): Promise<void> {
    if (!ctx.app.isProviderConnected) {
      addMessage("system", "No provider connected. Open settings to configure one.");
      return;
    }

    addMessage("user", `/plan ${goal}`);
    setProcessing(true);

    const goalId = crypto.randomUUID();
    let currentBubble: HTMLDivElement | null = null;
    let currentTextEl: HTMLSpanElement | null = null;
    let accumulated = "";

    try {
      for await (const chunk of ctx.app.executeGoal(goalId, goal)) {
        switch (chunk.type) {
          case "plan_created": {
            const stepList = chunk.steps.map((s, i) => `${i + 1}. ${s.description}`).join("\n");
            addMessage("system", `Plan: ${chunk.plan.title}\n${stepList}`);
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
              currentTextEl.textContent = accumulated;
              chatLog.scrollTop = chatLog.scrollHeight;
            }
            break;
          case "step_completed":
            // Step done — bubble stays
            currentBubble = null;
            currentTextEl = null;
            break;
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
            break;
          case "plan_failed":
            addMessage("system", `Plan failed: ${chunk.reason}`);
            break;
          case "plan_retrying":
            addMessage("system", "Retrying with adjusted plan…");
            break;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage("system", `Plan error: ${msg}`);
    } finally {
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

  // Wire up Enter key
  chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
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
    }
  });

  return {
    handleSend,
    handleVoiceSend,
    setSlashCommands(handle: { tryExecute(text: string): boolean }) {
      slashHandle = handle;
    },
  };
}
