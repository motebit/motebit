import { stripTags } from "@motebit/ai-core";
import { isSlashCommand, parseSlashCommand } from "../index";
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

// === Exported Standalone Functions ===

export function addMessage(role: "user" | "assistant" | "system", text: string): void {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
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
      btn.className = action.primary ? "system-action-btn primary" : "system-action-btn";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        // Disable all buttons in this message after click
        btnRow.querySelectorAll("button").forEach(b => {
          (b as HTMLButtonElement).disabled = true;
        });
        action.onClick();
      });
      btnRow.appendChild(btn);
    }

    bubble.appendChild(btnRow);
  }

  chatLog.appendChild(bubble);
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
    setTimeout(() => { el.remove(); toolStatusElements.delete(name); }, 500);
  }, 1000);
}

function showApprovalCard(ctx: DesktopContext, name: string, args: Record<string, unknown>): void {
  const card = document.createElement("div");
  card.className = "approval-card";

  const toolDiv = document.createElement("div");
  toolDiv.className = "approval-tool";
  toolDiv.textContent = name;
  card.appendChild(toolDiv);

  const argsDiv = document.createElement("div");
  argsDiv.className = "approval-args";
  argsDiv.textContent = JSON.stringify(args).slice(0, 120);
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

  let accumulated = "";
  try {
    for await (const chunk of ctx.app.resumeAfterApproval(approved)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        bubble.textContent = stripTags(accumulated);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          showToolStatus(chunk.name);
        } else if (chunk.status === "done") {
          completeToolStatus(chunk.name);
        }
      } else if (chunk.type === "approval_request") {
        showApprovalCard(ctx, chunk.name, chunk.args);
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
  card.appendChild(toolDiv);

  const argsDiv = document.createElement("div");
  argsDiv.className = "approval-args";
  argsDiv.textContent = JSON.stringify(event.args).slice(0, 120);
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

  let accumulated = "";
  try {
    for await (const chunk of ctx.app.resumeGoalAfterApproval(approved)) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        bubble.textContent = stripTags(accumulated);
        chatLog.scrollTop = chatLog.scrollHeight;
      } else if (chunk.type === "tool_status") {
        if (chunk.status === "calling") {
          showToolStatus(chunk.name);
        } else if (chunk.status === "done") {
          completeToolStatus(chunk.name);
        }
      } else if (chunk.type === "approval_request") {
        showApprovalCard(ctx, chunk.name, chunk.args);
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

// === Chat Init ===

export interface ChatCallbacks {
  openSettings(): void;
  openConversationsPanel(): void;
  speakResponse(text: string): void;
  getMicState(): MicState;
}

export interface ChatAPI {
  handleSend(): Promise<void>;
}

export function initChat(ctx: DesktopContext, callbacks: ChatCallbacks): ChatAPI {
  function handleSlashCommand(command: string, args: string): void {
    switch (command) {
      case "model":
        if (!args) {
          const current = ctx.app.currentModel ?? "none";
          addMessage("system", `Current model: ${current}`);
        } else {
          try {
            ctx.app.setModel(args);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Error: ${msg}`);
          }
        }
        break;
      case "settings":
        callbacks.openSettings();
        break;
      case "conversations":
        callbacks.openConversationsPanel();
        break;
      case "new":
        ctx.app.startNewConversation();
        chatLog.innerHTML = "";
        break;
      case "sync": {
        const config = ctx.getConfig();
        if (config?.syncUrl) {
          void ctx.app.syncConversations(config.syncUrl, config.syncMasterToken).then(result => {
            const total = result.conversations_pushed + result.conversations_pulled + result.messages_pushed + result.messages_pulled;
            showToast(total > 0 ? `Synced (${total} changes)` : "Already up to date");
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Sync failed: ${msg}`);
          });
        } else {
          addMessage("system", "No sync relay configured");
        }
        break;
      }
      case "help":
        addMessage("system",
          "Available commands:\n" +
          "/model — show current model\n" +
          "/model <name> — switch model\n" +
          "/conversations — browse past conversations\n" +
          "/new — start a new conversation\n" +
          "/sync — sync conversations with relay\n" +
          "/settings — open settings panel\n" +
          "/help — show this message"
        );
        break;
      default:
        addMessage("system", `Unknown command: /${command}`);
    }
  }

  async function handleSend(): Promise<void> {
    const text = chatInput.value.trim();
    if (!text || ctx.app.isProcessing) return;

    chatInput.value = "";

    if (isSlashCommand(text)) {
      const { command, args } = parseSlashCommand(text);
      handleSlashCommand(command, args);
      return;
    }

    addMessage("user", text);

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant";
    bubble.textContent = "";
    chatLog.appendChild(bubble);

    let accumulated = "";
    try {
      for await (const chunk of ctx.app.sendMessageStreaming(text)) {
        if (chunk.type === "text") {
          accumulated += chunk.text;
          bubble.textContent = stripTags(accumulated);
          chatLog.scrollTop = chatLog.scrollHeight;
        } else if (chunk.type === "tool_status") {
          if (chunk.status === "calling") {
            showToolStatus(chunk.name);
          } else if (chunk.status === "done") {
            completeToolStatus(chunk.name);
          }
        } else if (chunk.type === "approval_request") {
          showApprovalCard(ctx, chunk.name, chunk.args);
        } else if (chunk.type === "injection_warning") {
          addMessage("system", `Warning: suspicious content detected in ${chunk.tool_name} results`);
        }
      }

      void ctx.app.generateTitleInBackground();

      const micState = callbacks.getMicState();
      if (accumulated && (micState === "ambient" || micState === "off")) {
        callbacks.speakResponse(accumulated);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!bubble.textContent) {
        bubble.remove();
      }
      addMessage("system", `Error: ${msg}`);
    }
  }

  return { handleSend };
}
