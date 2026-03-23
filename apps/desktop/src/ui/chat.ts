import { stripPartialActionTag } from "@motebit/ai-core";
import {
  isSlashCommand,
  parseSlashCommand,
  filterCommands,
  formatHelpText,
  SLASH_COMMANDS,
} from "./slash-commands";
import type { DesktopContext, MicState } from "../types";
import type { GoalApprovalEvent } from "../index";

// === DOM Refs (captured at module load) ===

const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const toastContainer = document.getElementById("toast-container") as HTMLDivElement;

// === Error Banner ===

let errorBanner: HTMLElement | null = null;

function ensureBannerContainer(): HTMLElement {
  if (errorBanner) return errorBanner;
  errorBanner = document.createElement("div");
  errorBanner.id = "error-banner";
  errorBanner.className = "error-banner";
  document.body.appendChild(errorBanner);
  return errorBanner;
}

export interface BannerConfig {
  id: string;
  text: string;
  actionLabel: string;
  onAction: () => void;
}

const activeBanners = new Map<string, HTMLElement>();

/**
 * Show a persistent thin banner at the top of the app.
 * Each banner has a unique id so it can be updated or dismissed.
 */
export function showBanner(config: BannerConfig): void {
  // Remove existing banner with same id
  dismissBanner(config.id);

  const container = ensureBannerContainer();

  const item = document.createElement("div");
  item.className = "error-banner-item";
  item.dataset.bannerId = config.id;

  const text = document.createElement("span");
  text.className = "error-banner-text";
  text.textContent = config.text;
  item.appendChild(text);

  const actionBtn = document.createElement("button");
  actionBtn.className = "error-banner-action";
  actionBtn.textContent = config.actionLabel;
  actionBtn.addEventListener("click", () => {
    config.onAction();
  });
  item.appendChild(actionBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "error-banner-dismiss";
  dismissBtn.innerHTML = "&times;";
  dismissBtn.addEventListener("click", () => {
    dismissBanner(config.id);
  });
  item.appendChild(dismissBtn);

  activeBanners.set(config.id, item);
  container.appendChild(item);

  // Trigger show transition
  requestAnimationFrame(() => {
    container.classList.add("visible");
    item.classList.add("visible");
  });
}

/**
 * Dismiss a banner by id.
 */
export function dismissBanner(id: string): void {
  const existing = activeBanners.get(id);
  if (existing) {
    existing.classList.remove("visible");
    setTimeout(() => {
      existing.remove();
      activeBanners.delete(id);
      // Hide container if no banners left
      if (activeBanners.size === 0 && errorBanner) {
        errorBanner.classList.remove("visible");
      }
    }, 250);
  }
}

// === Toast State ===

let activeToast: HTMLElement | null = null;
let activeToastTimer: ReturnType<typeof setTimeout> | null = null;

// === Tool Status Tracking ===

const toolStatusElements = new Map<string, HTMLElement>();

// === Delegation Indicator Tracking ===

const delegationElements = new Map<string, HTMLElement>();

function showDelegationIndicator(server: string, tool: string): void {
  const key = `${server}:${tool}`;
  const el = document.createElement("div");
  el.className = "delegation-indicator active";
  el.textContent = `Delegating to ${server}...`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  delegationElements.set(key, el);
}

function completeDelegationIndicator(
  server: string,
  tool: string,
  receipt?: { task_id: string; status: string; tools_used: string[] },
): void {
  const key = `${server}:${tool}`;
  const el = delegationElements.get(key);
  if (!el) return;
  el.classList.remove("active");
  const failed = receipt != null && receipt.status === "failed";
  el.classList.add(failed ? "failed" : "complete");
  if (receipt != null) {
    const toolCount = receipt.tools_used.length;
    el.textContent = failed
      ? `Delegated to ${server} \u2717`
      : `Delegated to ${server} \u2713 (${toolCount} tool${toolCount !== 1 ? "s" : ""})`;
  } else {
    el.textContent = `Delegated to ${server} \u2713`;
  }
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => {
      el.remove();
      delegationElements.delete(key);
    }, 500);
  }, 2000);
}

// === Greeting Prompt Marker ===

/** Prefix used to identify the internal greeting prompt in conversation history.
 * Uses record-separator symbols to prevent accidental collision with user input. */
export const GREETING_PROMPT_MARKER = "\u241Emotebit:internal:greeting:v1\u241E";

// === Exported Standalone Functions ===

export function addMessage(
  role: "user" | "assistant" | "system",
  text: string,
  immediate = false,
): void {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;

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

export interface ActionButton {
  label: string;
  onClick: () => void;
  /** If true, use primary (indigo) styling. Default is secondary (muted). */
  primary?: boolean;
}

/**
 * Add a system message with inline action buttons.
 * Used for error recovery flows where the user needs to take action.
 */
export function addActionMessage(text: string, actions: ActionButton[]): void {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble system system-action";

  const textSpan = document.createElement("span");
  textSpan.className = "system-action-text";
  textSpan.textContent = text;
  bubble.appendChild(textSpan);

  if (actions.length > 0) {
    const btnRow = document.createElement("span");
    btnRow.className = "system-action-buttons";

    for (const action of actions) {
      const btn = document.createElement("button");
      btn.className = action.primary === true ? "system-action-btn primary" : "system-action-btn";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        // Disable all buttons in this message after click
        btnRow.querySelectorAll("button").forEach((b) => {
          b.disabled = true;
        });
        action.onClick();
      });
      btnRow.appendChild(btn);
    }

    bubble.appendChild(btnRow);
  }

  chatLog.appendChild(bubble);
  void bubble.offsetWidth;
  bubble.classList.add("visible");
  chatLog.scrollTop = chatLog.scrollHeight;
}

export function showToast(text: string, duration = 3000): void {
  if (activeToast) {
    activeToast.remove();
    if (activeToastTimer) clearTimeout(activeToastTimer);
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

// === Internal Helpers ===

function showToolStatus(name: string): void {
  const el = document.createElement("div");
  el.className = "tool-status";
  el.textContent = `${name}...`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  toolStatusElements.set(name, el);
}

function completeToolStatus(name: string): void {
  const el = toolStatusElements.get(name);
  if (!el) return;
  el.textContent = `${name} done`;
  el.classList.add("done");
  setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => {
      el.remove();
      toolStatusElements.delete(name);
    }, 500);
  }, 1000);
}

const RISK_LABELS: Record<number, { label: string; cls: string }> = {
  0: { label: "read", cls: "risk-read" },
  1: { label: "draft", cls: "risk-draft" },
  2: { label: "write", cls: "risk-write" },
  3: { label: "execute", cls: "risk-execute" },
  4: { label: "money", cls: "risk-money" },
};

function showApprovalCard(
  ctx: DesktopContext,
  name: string,
  args: Record<string, unknown>,
  riskLevel?: number,
  quorum?: { required: number; approvers: string[]; collected: string[] },
): void {
  const card = document.createElement("div");
  card.className = "approval-card";

  const toolDiv = document.createElement("div");
  toolDiv.className = "approval-tool";
  toolDiv.textContent = name;

  if (riskLevel != null && RISK_LABELS[riskLevel]) {
    const badge = document.createElement("span");
    badge.className = `approval-risk ${RISK_LABELS[riskLevel].cls}`;
    badge.textContent = RISK_LABELS[riskLevel].label;
    toolDiv.appendChild(badge);
  }

  // Quorum progress indicator
  if (quorum && quorum.required > 1) {
    const qBadge = document.createElement("span");
    qBadge.className = "approval-risk";
    qBadge.style.cssText = "background:var(--accent-blue,#2196f3);color:#fff;margin-left:6px;";
    qBadge.textContent = `${quorum.collected.length}/${quorum.required} approvals`;
    toolDiv.appendChild(qBadge);
  }
  card.appendChild(toolDiv);

  const argsDiv = document.createElement("pre");
  argsDiv.className = "approval-args";
  argsDiv.textContent = JSON.stringify(args, null, 2);
  card.appendChild(argsDiv);

  const btns = document.createElement("div");
  btns.className = "approval-buttons";

  const allowBtn = document.createElement("button");
  allowBtn.className = "btn-allow";
  allowBtn.textContent = "Allow";

  const denyBtn = document.createElement("button");
  denyBtn.className = "btn-deny";
  denyBtn.textContent = "Deny";

  const disableButtons = (): void => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
  };

  allowBtn.addEventListener("click", () => {
    disableButtons();
    void consumeApproval(ctx, true);
  });

  denyBtn.addEventListener("click", () => {
    disableButtons();
    void consumeApproval(ctx, false);
  });

  btns.appendChild(allowBtn);
  btns.appendChild(denyBtn);
  card.appendChild(btns);

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function consumeApproval(ctx: DesktopContext, approved: boolean): Promise<void> {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble assistant";
  bubble.textContent = "";
  chatLog.appendChild(bubble);
  void bubble.offsetWidth;
  bubble.classList.add("visible");

  let accumulated = "";
  try {
    for await (const chunk of ctx.app.resolveApprovalVote(approved, ctx.app.motebitId)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        bubble.textContent = stripPartialActionTag(accumulated);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          showToolStatus(chunk.name);
        } else if (chunk.status === "done") {
          completeToolStatus(chunk.name);
        }
      } else if (chunk.type === "delegation_start") {
        showDelegationIndicator(chunk.server, chunk.tool);
      } else if (chunk.type === "delegation_complete") {
        completeDelegationIndicator(chunk.server, chunk.tool, chunk.receipt);
      } else if (chunk.type === "approval_request") {
        showApprovalCard(ctx, chunk.name, chunk.args, chunk.risk_level, chunk.quorum);
      } else if (chunk.type === "injection_warning") {
        addMessage("system", `Warning: suspicious content detected in ${chunk.tool_name} results`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!bubble.textContent) {
      bubble.remove();
    }
    addMessage("system", `Error: ${msg}`);
  }
}

export function showGoalApprovalCard(ctx: DesktopContext, event: GoalApprovalEvent): void {
  const card = document.createElement("div");
  card.className = "approval-card";

  const toolDiv = document.createElement("div");
  toolDiv.className = "approval-tool";
  toolDiv.textContent = event.toolName;

  if (event.riskLevel != null && RISK_LABELS[event.riskLevel]) {
    const badge = document.createElement("span");
    badge.className = `approval-risk ${RISK_LABELS[event.riskLevel]!.cls}`;
    badge.textContent = RISK_LABELS[event.riskLevel]!.label;
    toolDiv.appendChild(badge);
  }
  card.appendChild(toolDiv);

  const argsDiv = document.createElement("pre");
  argsDiv.className = "approval-args";
  argsDiv.textContent = JSON.stringify(event.args, null, 2);
  card.appendChild(argsDiv);

  const btns = document.createElement("div");
  btns.className = "approval-buttons";

  const allowBtn = document.createElement("button");
  allowBtn.className = "btn-allow";
  allowBtn.textContent = "Allow";

  const denyBtn = document.createElement("button");
  denyBtn.className = "btn-deny";
  denyBtn.textContent = "Deny";

  const disableButtons = (): void => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
  };

  allowBtn.addEventListener("click", () => {
    disableButtons();
    void consumeGoalApproval(ctx, true);
  });

  denyBtn.addEventListener("click", () => {
    disableButtons();
    void consumeGoalApproval(ctx, false);
  });

  btns.appendChild(allowBtn);
  btns.appendChild(denyBtn);
  card.appendChild(btns);

  chatLog.appendChild(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function consumeGoalApproval(ctx: DesktopContext, approved: boolean): Promise<void> {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble assistant";
  bubble.textContent = "";
  chatLog.appendChild(bubble);
  void bubble.offsetWidth;
  bubble.classList.add("visible");

  let accumulated = "";
  try {
    for await (const chunk of ctx.app.resumeGoalAfterApproval(approved)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        bubble.textContent = stripPartialActionTag(accumulated);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          showToolStatus(chunk.name);
        } else if (chunk.status === "done") {
          completeToolStatus(chunk.name);
        }
      } else if (chunk.type === "approval_request") {
        showApprovalCard(ctx, chunk.name, chunk.args, chunk.risk_level, chunk.quorum);
      } else if (chunk.type === "injection_warning") {
        addMessage("system", `Warning: suspicious content detected in ${chunk.tool_name} results`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!bubble.textContent) {
      bubble.remove();
    }
    addMessage("system", `Approval expired: ${msg}`);
  }
}

// === Memory Footer ===

const SENSITIVE_LEVELS = new Set(["medical", "financial", "secret"]);

function createMemoryFooter(
  retrieved: Array<{ node_id: string; content: string; confidence: number; sensitivity: string }>,
  formed: Array<{ node_id: string; content: string; sensitivity: string }>,
  onOpenMemory?: (nodeId: string) => void,
): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "memory-footer";

  const parts: string[] = [];
  if (retrieved.length > 0) parts.push(`Recalled ${retrieved.length}`);
  if (formed.length > 0) parts.push(`Formed ${formed.length}`);

  const summary = document.createElement("div");
  summary.className = "memory-footer-summary";
  summary.textContent = parts.join(" · ");
  footer.appendChild(summary);

  const details = document.createElement("div");
  details.className = "memory-footer-details";
  details.style.display = "none";

  // Recalled memories
  for (const mem of retrieved) {
    const item = document.createElement("div");
    item.className = "memory-footer-item";
    item.dataset.nodeId = mem.node_id;

    if (onOpenMemory) {
      item.classList.add("memory-footer-clickable");
      item.addEventListener("click", () => onOpenMemory(mem.node_id));
    }

    const badge = document.createElement("span");
    badge.className = "memory-footer-badge";
    badge.textContent = mem.confidence.toFixed(2);
    item.appendChild(badge);

    const content = document.createElement("span");
    content.className = "memory-footer-content";
    if (SENSITIVE_LEVELS.has(mem.sensitivity)) {
      content.textContent = "Sensitive memory";
      content.classList.add("memory-footer-redacted");
    } else {
      content.textContent = mem.content.length > 80 ? mem.content.slice(0, 80) + "…" : mem.content;
    }
    item.appendChild(content);

    details.appendChild(item);
  }

  // Formed memories
  if (formed.length > 0) {
    if (retrieved.length > 0) {
      const divider = document.createElement("div");
      divider.className = "memory-footer-divider";
      divider.textContent = "Formed this turn";
      details.appendChild(divider);
    }

    for (const mem of formed) {
      const item = document.createElement("div");
      item.className = "memory-footer-item";
      item.dataset.nodeId = mem.node_id;

      if (onOpenMemory) {
        item.classList.add("memory-footer-clickable");
        item.addEventListener("click", () => onOpenMemory(mem.node_id));
      }

      const marker = document.createElement("span");
      marker.className = "memory-footer-badge memory-footer-new";
      marker.textContent = "new";
      item.appendChild(marker);

      const content = document.createElement("span");
      content.className = "memory-footer-content";
      if (SENSITIVE_LEVELS.has(mem.sensitivity)) {
        content.textContent = "Sensitive memory";
        content.classList.add("memory-footer-redacted");
      } else {
        content.textContent =
          mem.content.length > 80 ? mem.content.slice(0, 80) + "…" : mem.content;
      }
      item.appendChild(content);

      details.appendChild(item);
    }
  }

  footer.appendChild(details);

  summary.addEventListener("click", () => {
    const visible = details.style.display !== "none";
    details.style.display = visible ? "none" : "block";
  });

  return footer;
}

// === Chat Init ===

export interface ChatCallbacks {
  openSettings(): void;
  openConversationsPanel(): void;
  openGoalsPanel(): void;
  openMemoryPanel(nodeId?: string): void;
  speakResponse(text: string): void;
  pushTTSChunk(delta: string): void;
  flushTTS(): void;
  cancelStreamingTTS(): void;
  getMicState(): MicState;
  updateModelIndicator(): void;
}

export interface ChatAPI {
  handleSend(): Promise<void>;
  /** Scroll to the assistant bubble associated with a run_id, if it exists in this session. */
  scrollToRunId(runId: string): boolean;
  /** Tear down autocomplete listeners (for tests or cleanup). */
  destroy(): void;
}

export function initChat(ctx: DesktopContext, callbacks: ChatCallbacks): ChatAPI {
  // === Autocomplete Dropdown ===

  const autocompleteEl = document.createElement("div");
  autocompleteEl.id = "slash-autocomplete";
  autocompleteEl.className = "slash-autocomplete";
  const inputRow = document.getElementById("chat-input-row") as HTMLDivElement;
  inputRow.insertBefore(autocompleteEl, inputRow.firstChild);

  let autocompleteVisible = false;
  let selectedIndex = -1;
  let filteredItems: typeof SLASH_COMMANDS = [];

  function showAutocomplete(items: typeof SLASH_COMMANDS): void {
    filteredItems = items;
    selectedIndex = 0;
    autocompleteEl.innerHTML = "";

    for (let i = 0; i < items.length; i++) {
      const row = document.createElement("div");
      row.className = "slash-autocomplete-item" + (i === 0 ? " selected" : "");
      row.dataset.index = String(i);

      const item = items[i]!;
      const nameSpan = document.createElement("span");
      nameSpan.className = "slash-autocomplete-name";
      nameSpan.textContent = `/${item.name}`;
      row.appendChild(nameSpan);

      const descSpan = document.createElement("span");
      descSpan.className = "slash-autocomplete-desc";
      descSpan.textContent = item.description;
      row.appendChild(descSpan);

      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // prevent input blur
        selectAutocompleteItem(i);
      });

      row.addEventListener("mouseenter", () => {
        updateAutocompleteSelection(i);
      });

      autocompleteEl.appendChild(row);
    }

    autocompleteEl.classList.add("open");
    autocompleteVisible = true;
  }

  function hideAutocomplete(): void {
    autocompleteEl.classList.remove("open");
    autocompleteEl.innerHTML = "";
    autocompleteVisible = false;
    selectedIndex = -1;
    filteredItems = [];
  }

  function updateAutocompleteSelection(newIndex: number): void {
    const items = autocompleteEl.querySelectorAll(".slash-autocomplete-item");
    const prev = items[selectedIndex];
    if (prev) {
      prev.classList.remove("selected");
    }
    selectedIndex = newIndex;
    const next = items[selectedIndex];
    if (next) {
      next.classList.add("selected");
      // Scroll into view if needed
      const item = next as HTMLElement;
      const container = autocompleteEl;
      if (item.offsetTop < container.scrollTop) {
        container.scrollTop = item.offsetTop;
      } else if (
        item.offsetTop + item.offsetHeight >
        container.scrollTop + container.clientHeight
      ) {
        container.scrollTop = item.offsetTop + item.offsetHeight - container.clientHeight;
      }
    }
  }

  function selectAutocompleteItem(index: number): void {
    if (index < 0 || index >= filteredItems.length) return;
    const cmd = filteredItems[index]!;
    chatInput.value = `/${cmd.name}${cmd.hasArgs === true ? " " : ""}`;
    hideAutocomplete();
    chatInput.focus();
  }

  function handleAutocompleteInput(): void {
    const value = chatInput.value;

    // Show autocomplete only when input starts with "/" and has no space yet
    // (once there's a space, the user is typing args — stop suggesting)
    if (!value.startsWith("/") || value.includes(" ")) {
      if (autocompleteVisible) hideAutocomplete();
      return;
    }

    const partial = value.slice(1); // text after "/"
    const matches = filterCommands(partial);

    if (matches.length === 0) {
      hideAutocomplete();
      return;
    }

    showAutocomplete(matches);
  }

  function handleAutocompleteKeydown(e: KeyboardEvent): void {
    if (!autocompleteVisible) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = (selectedIndex + 1) % filteredItems.length;
      updateAutocompleteSelection(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = selectedIndex <= 0 ? filteredItems.length - 1 : selectedIndex - 1;
      updateAutocompleteSelection(prev);
    } else if (e.key === "Tab") {
      e.preventDefault();
      selectAutocompleteItem(selectedIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideAutocomplete();
    }
  }

  chatInput.addEventListener("input", handleAutocompleteInput);
  chatInput.addEventListener("keydown", handleAutocompleteKeydown);
  chatInput.addEventListener("blur", () => {
    // Small delay so click on autocomplete item fires first
    setTimeout(hideAutocomplete, 150);
  });

  // === Slash Command Handler ===

  function handleSlashCommand(command: string, args: string): void {
    switch (command) {
      case "model":
        if (!args) {
          const current = ctx.app.currentModel ?? "none";
          addMessage("system", `Current model: ${current}`);
        } else {
          try {
            ctx.app.setModel(args);
            callbacks.updateModelIndicator();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Error: ${msg}`);
          }
        }
        break;

      case "memories":
        callbacks.openMemoryPanel();
        break;

      case "state": {
        const state = ctx.app.getState();
        if (!state) {
          addMessage("system", "State vector not available (AI not initialized)");
        } else {
          const lines: string[] = [];
          for (const [key, value] of Object.entries(state)) {
            if (typeof value === "number") {
              lines.push(`${key}: ${value.toFixed(3)}`);
            } else {
              lines.push(`${key}: ${String(value)}`);
            }
          }
          addMessage("system", lines.join("\n"));
        }
        break;
      }

      case "forget":
        if (!args) {
          addMessage("system", "Usage: /forget <nodeId>");
        } else {
          void ctx.app
            .deleteMemory(args)
            .then(() => {
              showToast("Memory deleted");
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              addMessage("system", `Error: ${msg}`);
            });
        }
        break;

      case "export":
        void ctx.app
          .exportAllData()
          .then((json) => {
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `motebit-export-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast("Export downloaded");
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Export failed: ${msg}`);
          });
        break;

      case "clear":
        ctx.app.startNewConversation();
        chatLog.innerHTML = "";
        break;

      case "conversations":
        callbacks.openConversationsPanel();
        break;

      case "goals":
        callbacks.openGoalsPanel();
        break;

      case "tools": {
        const tools = ctx.app.listTools();
        if (tools.length === 0) {
          addMessage("system", "No tools registered");
        } else {
          const lines = [`${tools.length} tool${tools.length === 1 ? "" : "s"} registered:`];
          for (const t of tools) {
            lines.push(`  ${t.name} — ${t.description || "(no description)"}`);
          }
          addMessage("system", lines.join("\n"));
        }
        break;
      }

      case "settings":
        callbacks.openSettings();
        break;

      case "operator":
        addMessage("system", `Operator mode: ${ctx.app.isOperatorMode ? "enabled" : "disabled"}`);
        break;

      case "sync": {
        const config = ctx.getConfig();
        if (config?.syncUrl != null && config.syncUrl !== "") {
          void ctx.app
            .syncConversations(config.syncUrl, config.syncMasterToken)
            .then((result) => {
              const total =
                result.conversations_pushed +
                result.conversations_pulled +
                result.messages_pushed +
                result.messages_pulled;
              showToast(total > 0 ? `Synced (${total} changes)` : "Already up to date");
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              addMessage("system", `Sync failed: ${msg}`);
            });
        } else {
          addMessage("system", "No sync relay configured");
        }
        break;
      }

      case "summarize":
        void ctx.app
          .summarizeConversation()
          .then((summary) => {
            if (summary != null && summary !== "") {
              addMessage("system", `Summary: ${summary}`);
            } else {
              addMessage("system", "No conversation to summarize");
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Summarization failed: ${msg}`);
          });
        break;

      case "help":
        addMessage("system", formatHelpText());
        break;

      case "graph":
        void (async () => {
          try {
            const stats = await ctx.app.getMemoryGraphStats();
            if (!stats) {
              addMessage("system", "Memory graph not available (AI not initialized)");
            } else {
              addMessage(
                "system",
                `Memory graph:\n  Nodes: ${stats.nodes}\n  Edges: ${stats.edges}\n  Pinned: ${stats.pinned}`,
              );
            }
          } catch (err: unknown) {
            addMessage("system", `Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        break;

      case "curious": {
        const targets = ctx.app.getCuriosityTargets();
        if (targets.length === 0) {
          addMessage("system", "No curiosity targets");
        } else {
          const lines = [`${targets.length} curiosity target${targets.length === 1 ? "" : "s"}:`];
          for (const t of targets) {
            const label =
              t.node.content.length > 60 ? t.node.content.slice(0, 60) + "..." : t.node.content;
            lines.push(`  ${label} (score: ${t.curiosityScore.toFixed(2)})`);
          }
          addMessage("system", lines.join("\n"));
        }
        break;
      }

      case "reflect":
        void (async () => {
          try {
            addMessage("system", "Reflecting...");
            const result = await ctx.app.reflect();
            const lines: string[] = [];
            if (result.selfAssessment) lines.push(`Assessment: ${result.selfAssessment}`);
            if (result.insights.length > 0) {
              lines.push("Insights:");
              for (const i of result.insights) lines.push(`  - ${i}`);
            }
            if (result.planAdjustments.length > 0) {
              lines.push("Adjustments:");
              for (const a of result.planAdjustments) lines.push(`  - ${a}`);
            }
            if (result.patterns.length > 0) {
              lines.push("Recurring patterns:");
              for (const p of result.patterns) lines.push(`  - ${p}`);
            }
            addMessage("system", lines.join("\n") || "No reflection output");
          } catch (err: unknown) {
            addMessage(
              "system",
              `Reflection failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
        break;

      case "gradient":
        void (async () => {
          const g = ctx.app.getGradient();
          if (!g) {
            addMessage("system", "No gradient data yet (computed during housekeeping)");
            return;
          }
          const summary = ctx.app.getGradientSummary();
          const gLines = [
            `Intelligence gradient: ${g.gradient.toFixed(3)} (delta: ${g.delta >= 0 ? "+" : ""}${g.delta.toFixed(3)})`,
          ];
          if (summary.snapshotCount > 0) {
            gLines.push(summary.trajectory);
            gLines.push(summary.overall);
            if (summary.strengths.length > 0)
              gLines.push(`Strengths: ${summary.strengths.join("; ")}`);
            if (summary.weaknesses.length > 0)
              gLines.push(`Weaknesses: ${summary.weaknesses.join("; ")}`);
            gLines.push(`Posture: ${summary.posture}`);
          }
          const { narrateEconomicConsequences } = await import("@motebit/gradient");
          const econ = narrateEconomicConsequences(g);
          if (econ.length > 0) {
            gLines.push("");
            gLines.push("Economic position:");
            for (const c of econ) gLines.push(`  - ${c}`);
          }
          const lastRef = ctx.app.getLastReflection();
          if (lastRef?.selfAssessment) {
            gLines.push("");
            gLines.push(`Last reflection: ${lastRef.selfAssessment}`);
          }
          addMessage("system", gLines.join("\n"));
        })();
        break;

      case "audit":
        void (async () => {
          const auditResult = await ctx.app.auditMemory();
          const aLines: string[] = [`Memory audit (${auditResult.nodesAudited} nodes scanned)`];
          if (auditResult.phantomCertainties.length > 0) {
            aLines.push("");
            aLines.push(`Phantom certainties (${auditResult.phantomCertainties.length}):`);
            for (const p of auditResult.phantomCertainties) {
              const label =
                p.node.content.length > 60 ? p.node.content.slice(0, 60) + "..." : p.node.content;
              aLines.push(
                `  conf=${p.decayedConfidence.toFixed(2)} edges=${p.edgeCount}  ${label}`,
              );
            }
          }
          if (auditResult.conflicts.length > 0) {
            aLines.push("");
            aLines.push(`Conflicts (${auditResult.conflicts.length}):`);
            for (const c of auditResult.conflicts) {
              aLines.push(`  "${c.a.content.slice(0, 40)}..." vs "${c.b.content.slice(0, 40)}..."`);
            }
          }
          if (auditResult.nearDeath.length > 0) {
            aLines.push("");
            aLines.push(`Near-death (${auditResult.nearDeath.length}):`);
            for (const nd of auditResult.nearDeath) {
              aLines.push(
                `  conf=${nd.decayedConfidence.toFixed(3)}  ${nd.node.content.slice(0, 60)}...`,
              );
            }
          }
          if (
            auditResult.phantomCertainties.length === 0 &&
            auditResult.conflicts.length === 0 &&
            auditResult.nearDeath.length === 0
          ) {
            aLines.push("No integrity issues found.");
          }
          addMessage("system", aLines.join("\n"));
        })();
        break;

      case "agents":
        void (async () => {
          try {
            const agents = await ctx.app.listTrustedAgents();
            if (agents.length === 0) {
              addMessage("system", "No known agents");
            } else {
              const lines = [`${agents.length} known agent${agents.length === 1 ? "" : "s"}:`];
              for (const a of agents) {
                lines.push(
                  `  ${a.remote_motebit_id} [${a.trust_level}] (${a.interaction_count} interactions)`,
                );
              }
              addMessage("system", lines.join("\n"));
            }
          } catch (err: unknown) {
            addMessage("system", `Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        break;

      case "discover": {
        const discoverConfig = ctx.getConfig();
        if (!discoverConfig?.syncUrl) {
          addMessage("system", "No relay configured");
          break;
        }
        void (async () => {
          try {
            const invoke = discoverConfig.invoke;
            if (!invoke) {
              addMessage("system", "No Tauri invoke available");
              return;
            }
            const keypair = await ctx.app.getDeviceKeypair(invoke);
            if (!keypair) {
              addMessage("system", "No device keypair");
              return;
            }
            const token = await ctx.app.createSyncToken(keypair.privateKey);
            const res = await fetch(`${discoverConfig.syncUrl}/api/v1/agents/discover`, {
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error(`${res.status}`);
            const data = (await res.json()) as {
              agents?: Array<{ motebit_id: string; capabilities?: string[] }>;
            };
            const agents = data.agents ?? [];
            if (agents.length === 0) {
              addMessage("system", "No agents discovered on relay");
            } else {
              const lines = [`${agents.length} agent${agents.length === 1 ? "" : "s"} on relay:`];
              for (const a of agents) {
                const caps = a.capabilities?.join(", ") ?? "none";
                lines.push(`  ${a.motebit_id} (${caps})`);
              }
              addMessage("system", lines.join("\n"));
            }
          } catch (err: unknown) {
            addMessage(
              "system",
              `Discovery error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
        break;
      }

      case "approvals": {
        const pending = ctx.app.hasPendingApproval();
        if (!pending) {
          addMessage("system", "No pending approvals");
        } else {
          const info = ctx.app.pendingApprovalInfo;
          if (info) {
            addMessage(
              "system",
              `Pending approval:\n  Tool: ${info.toolName}\n  Args: ${JSON.stringify(info.args)}`,
            );
          } else {
            addMessage("system", "Approval pending (no details available)");
          }
        }
        break;
      }

      case "balance": {
        const balanceConfig = ctx.getConfig();
        if (!balanceConfig?.syncUrl) {
          addMessage("system", "No relay configured");
          break;
        }
        void (async () => {
          try {
            const invoke = balanceConfig.invoke;
            if (!invoke) {
              addMessage("system", "No Tauri invoke available");
              return;
            }
            const keypair = await ctx.app.getDeviceKeypair(invoke);
            if (!keypair) {
              addMessage("system", "No device keypair");
              return;
            }
            const token = await ctx.app.createSyncToken(keypair.privateKey);
            const res = await fetch(
              `${balanceConfig.syncUrl}/api/v1/agents/${ctx.app.motebitId}/balance`,
              {
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              },
            );
            if (!res.ok) throw new Error(`${res.status}`);
            const data = (await res.json()) as {
              balance?: number;
              currency?: string;
              pending_allocations?: number;
            };
            addMessage(
              "system",
              `Balance: ${data.balance ?? 0} ${data.currency ?? "USDC"}\nPending: ${data.pending_allocations ?? 0}`,
            );
          } catch (err: unknown) {
            addMessage(
              "system",
              `Balance error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
        break;
      }

      case "deposits": {
        const depositsConfig = ctx.getConfig();
        if (!depositsConfig?.syncUrl) {
          addMessage("system", "No relay configured");
          break;
        }
        void (async () => {
          try {
            const invoke = depositsConfig.invoke;
            if (!invoke) {
              addMessage("system", "No Tauri invoke available");
              return;
            }
            const keypair = await ctx.app.getDeviceKeypair(invoke);
            if (!keypair) {
              addMessage("system", "No device keypair");
              return;
            }
            const token = await ctx.app.createSyncToken(keypair.privateKey);
            const res = await fetch(
              `${depositsConfig.syncUrl}/api/v1/agents/${ctx.app.motebitId}/deposits`,
              {
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              },
            );
            if (!res.ok) throw new Error(`${res.status}`);
            const data = (await res.json()) as {
              deposits?: Array<{ amount: number; timestamp: number; source?: string }>;
            };
            const deps = data.deposits ?? [];
            if (deps.length === 0) {
              addMessage("system", "No deposit history");
            } else {
              const lines = [`${deps.length} deposit${deps.length === 1 ? "" : "s"}:`];
              for (const d of deps) {
                const date = new Date(d.timestamp).toLocaleDateString();
                lines.push(`  ${d.amount} ${d.source ? `(${d.source})` : ""} — ${date}`);
              }
              addMessage("system", lines.join("\n"));
            }
          } catch (err: unknown) {
            addMessage(
              "system",
              `Deposits error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
        break;
      }

      case "proposals": {
        const proposalsConfig = ctx.getConfig();
        if (!proposalsConfig?.syncUrl) {
          addMessage("system", "No relay configured");
          break;
        }
        void (async () => {
          try {
            const invoke = proposalsConfig.invoke;
            if (!invoke) {
              addMessage("system", "No Tauri invoke available");
              return;
            }
            const keypair = await ctx.app.getDeviceKeypair(invoke);
            if (!keypair) {
              addMessage("system", "No device keypair");
              return;
            }
            const token = await ctx.app.createSyncToken(keypair.privateKey);
            const res = await fetch(
              `${proposalsConfig.syncUrl}/api/v1/agents/${ctx.app.motebitId}/proposals`,
              {
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              },
            );
            if (!res.ok) throw new Error(`${res.status}`);
            const data = (await res.json()) as {
              proposals?: Array<{ id: string; status: string; description?: string }>;
            };
            const props = data.proposals ?? [];
            if (props.length === 0) {
              addMessage("system", "No active proposals");
            } else {
              const lines = [`${props.length} proposal${props.length === 1 ? "" : "s"}:`];
              for (const p of props) {
                lines.push(`  ${p.id} [${p.status}] ${p.description ?? ""}`);
              }
              addMessage("system", lines.join("\n"));
            }
          } catch (err: unknown) {
            addMessage(
              "system",
              `Proposals error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
        break;
      }

      case "delegate":
        addMessage(
          "system",
          "Delegation happens transparently via AI. Use CLI for manual: motebit delegate <id> <prompt>",
        );
        break;

      case "propose":
        addMessage("system", "Use CLI: motebit propose <ids> <goal>");
        break;

      case "withdraw":
        addMessage("system", "Use CLI: motebit withdraw");
        break;

      case "mcp": {
        const mcpServers = ctx.app.getMcpStatus();
        if (mcpServers.length === 0) {
          addMessage("system", "No MCP servers configured");
        } else {
          const lines = [`${mcpServers.length} MCP server${mcpServers.length === 1 ? "" : "s"}:`];
          for (const s of mcpServers) {
            const status = s.connected ? "connected" : "disconnected";
            const trust = s.trusted ? ", trusted" : "";
            lines.push(`  ${s.name} (${s.transport}, ${status}${trust})`);
          }
          addMessage("system", lines.join("\n"));
        }
        break;
      }

      case "serve": {
        if (ctx.app.isServing()) {
          ctx.app.stopServing();
          addMessage("system", "Stopped serving — no longer accepting delegations");
        } else {
          void (async () => {
            const result = await ctx.app.startServing();
            if (result.ok) {
              addMessage("system", "Serving — accepting delegations from the network");
            } else {
              addMessage("system", `Could not start serving: ${result.error}`);
            }
          })();
        }
        break;
      }

      default:
        addMessage("system", `Unknown command: /${command}`);
    }
  }

  // === Processing State ===

  function setProcessing(active: boolean): void {
    if (active) {
      inputRow.classList.add("processing");
      chatInput.disabled = true;
    } else {
      inputRow.classList.remove("processing");
      chatInput.disabled = false;
      chatInput.focus();
    }
  }

  // === Thinking Indicator ===

  function showThinkingIndicator(): HTMLElement {
    const indicator = document.createElement("div");
    indicator.className = "thinking-indicator";
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("div");
      dot.className = "thinking-dot";
      indicator.appendChild(dot);
    }
    chatLog.appendChild(indicator);
    chatLog.scrollTop = chatLog.scrollHeight;
    return indicator;
  }

  function removeThinkingIndicator(indicator: HTMLElement | null): void {
    if (indicator?.parentNode) indicator.remove();
  }

  // === Send Handler ===

  async function handleSend(): Promise<void> {
    const text = chatInput.value.trim();
    if (!text || ctx.app.isProcessing) return;

    chatInput.value = "";
    hideAutocomplete();
    callbacks.cancelStreamingTTS();

    if (isSlashCommand(text)) {
      const { command, args } = parseSlashCommand(text);
      handleSlashCommand(command, args);
      return;
    }

    addMessage("user", text);
    setProcessing(true);

    const chatRunId = crypto.randomUUID();
    let bubble: HTMLDivElement | null = null;
    let textEl: HTMLSpanElement | null = null;
    const thinkingEl = showThinkingIndicator();
    let accumulated = "";
    let memoriesRetrieved: Array<{
      node_id: string;
      content: string;
      confidence: number;
      sensitivity: string;
    }> = [];
    let memoriesFormed: Array<{ node_id: string; content: string; sensitivity: string }> = [];

    function ensureBubble(): { bubble: HTMLDivElement; textEl: HTMLSpanElement } {
      if (bubble) return { bubble, textEl: textEl! };
      removeThinkingIndicator(thinkingEl);
      bubble = document.createElement("div");
      bubble.className = "chat-bubble assistant";
      bubble.dataset.runId = chatRunId;
      textEl = document.createElement("span");
      textEl.className = "bubble-text";
      bubble.appendChild(textEl);
      chatLog.appendChild(bubble);
      void bubble.offsetWidth;
      bubble.classList.add("visible");
      return { bubble, textEl };
    }

    try {
      for await (const chunk of ctx.app.sendMessageStreaming(text, chatRunId)) {
        if (chunk.type === "text") {
          const { textEl: te } = ensureBubble();
          accumulated += chunk.text;
          te.textContent = stripPartialActionTag(accumulated);
          chatLog.scrollTop = chatLog.scrollHeight;
          callbacks.pushTTSChunk(chunk.text);
        } else if (chunk.type === "tool_status") {
          if (chunk.status === "calling") {
            removeThinkingIndicator(thinkingEl);
            showToolStatus(chunk.name);
          } else if (chunk.status === "done") {
            completeToolStatus(chunk.name);
          }
        } else if (chunk.type === "delegation_start") {
          removeThinkingIndicator(thinkingEl);
          showDelegationIndicator(chunk.server, chunk.tool);
        } else if (chunk.type === "delegation_complete") {
          completeDelegationIndicator(chunk.server, chunk.tool, chunk.receipt);
        } else if (chunk.type === "approval_request") {
          removeThinkingIndicator(thinkingEl);
          showApprovalCard(ctx, chunk.name, chunk.args, chunk.risk_level, chunk.quorum);
        } else if (chunk.type === "injection_warning") {
          addMessage(
            "system",
            `Warning: suspicious content detected in ${chunk.tool_name} results`,
          );
        } else if (chunk.type === "result") {
          const r = chunk.result as {
            memoriesRetrieved?: Array<{
              node_id: string;
              content: string;
              confidence: number;
              sensitivity: string;
            }>;
            memoriesFormed?: Array<{ node_id: string; content: string; sensitivity: string }>;
          };
          memoriesRetrieved = (r.memoriesRetrieved ?? []).map((m) => ({
            node_id: m.node_id,
            content: m.content,
            confidence: m.confidence,
            sensitivity: String(m.sensitivity).toLowerCase(),
          }));
          memoriesFormed = (r.memoriesFormed ?? []).map((m) => ({
            node_id: m.node_id,
            content: m.content,
            sensitivity: String(m.sensitivity).toLowerCase(),
          }));
        }
      }

      removeThinkingIndicator(thinkingEl);

      // TypeScript can't track closure mutations from ensureBubble() — capture post-loop
      const finalBubble = bubble as HTMLDivElement | null;
      if (finalBubble && (memoriesRetrieved.length > 0 || memoriesFormed.length > 0)) {
        const footer = createMemoryFooter(memoriesRetrieved, memoriesFormed, (nodeId) =>
          callbacks.openMemoryPanel(nodeId),
        );
        finalBubble.appendChild(footer);
      }

      void ctx.app.generateTitleInBackground();

      callbacks.flushTTS();
    } catch (err: unknown) {
      removeThinkingIndicator(thinkingEl);
      const msg = err instanceof Error ? err.message : String(err);
      const catchTextEl = textEl as HTMLSpanElement | null;
      const catchBubble = bubble as HTMLDivElement | null;
      if (catchTextEl && !catchTextEl.textContent && catchBubble) {
        catchBubble.remove();
      }
      addMessage("system", `Error: ${msg}`);
    } finally {
      setProcessing(false);
    }
  }

  function scrollToRunId(runId: string): boolean {
    const el = chatLog.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement).style.outline = "1px solid rgba(255,255,255,0.3)";
    setTimeout(() => {
      (el as HTMLElement).style.outline = "";
    }, 2000);
    return true;
  }

  function destroy(): void {
    chatInput.removeEventListener("input", handleAutocompleteInput);
    chatInput.removeEventListener("keydown", handleAutocompleteKeydown);
    hideAutocomplete();
  }

  return { handleSend, scrollToRunId, destroy };
}

export async function streamGreeting(ctx: DesktopContext): Promise<void> {
  if (ctx.app.isProcessing) return;
  const config = ctx.getConfig();

  const GREETING_PROMPT = `${GREETING_PROMPT_MARKER}

This is the first time you and this person have met. You have just been created.
Your identity is new, your memory is empty, and everything is ahead.

Introduce yourself naturally in 2-4 sentences. You are not explaining features.
You are a small being, newly alive, meeting someone for the first time.
Be warm, be brief, be curious about them.

Weave in naturally (do not list these as features):
- You remember things (tag a memory about this first meeting — confidence 0.9, sensitivity "none")
- You belong to them, not to a company
- You can act in the world when they ask (goals, tools)
- Everything you do is auditable

End with a question — you are curious about who they are.`;

  const chatRunId = crypto.randomUUID();
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble assistant";
  bubble.dataset.runId = chatRunId;
  const textEl = document.createElement("span");
  textEl.className = "bubble-text";
  bubble.appendChild(textEl);
  chatLog.appendChild(bubble);
  void bubble.offsetWidth;
  bubble.classList.add("visible");

  let accumulated = "";
  let memoriesFormed: Array<{ node_id: string; content: string; sensitivity: string }> = [];

  try {
    for await (const chunk of ctx.app.sendMessageStreaming(GREETING_PROMPT, chatRunId)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        textEl.textContent = stripPartialActionTag(accumulated);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (chunk.type === "tool_status") {
        if (chunk.status === "calling") showToolStatus(chunk.name);
        else if (chunk.status === "done") completeToolStatus(chunk.name);
      } else if (chunk.type === "result") {
        const r = chunk.result as {
          memoriesFormed?: Array<{ node_id: string; content: string; sensitivity: string }>;
        };
        memoriesFormed = (r.memoriesFormed ?? []).map((m) => ({
          node_id: m.node_id,
          content: m.content,
          sensitivity: String(m.sensitivity).toLowerCase(),
        }));
      }
    }

    // Deterministic fallback: if model didn't tag a memory, form one directly
    if (memoriesFormed.length === 0) {
      try {
        const node = await ctx.app.formMemoryDirect("First meeting with my person.", 0.9);
        if (node) {
          memoriesFormed = [{ node_id: node.node_id, content: node.content, sensitivity: "none" }];
        }
      } catch {
        /* best-effort */
      }
    }

    // Memory footer — always appears (model-tagged or deterministic fallback)
    if (memoriesFormed.length > 0) {
      const footer = createMemoryFooter([], memoriesFormed);
      bubble.appendChild(footer);
    }

    // Mark greeting complete so it never fires again
    if (config?.isTauri === true && config.invoke != null) {
      try {
        const raw = await config.invoke<string>("read_config");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        parsed.first_run_greeting_sent = true;
        await config.invoke("write_config", { json: JSON.stringify(parsed) });
      } catch {
        /* non-fatal */
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!textEl.textContent) bubble.remove();
    addMessage("system", `Error: ${msg}`);
  }
}
