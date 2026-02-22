import { stripTags } from "@motebit/ai-core";
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
  openGoalsPanel(): void;
  openMemoryPanel(): void;
  speakResponse(text: string): void;
  getMicState(): MicState;
}

export interface ChatAPI {
  handleSend(): Promise<void>;
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
      } else if (item.offsetTop + item.offsetHeight > container.scrollTop + container.clientHeight) {
        container.scrollTop = item.offsetTop + item.offsetHeight - container.clientHeight;
      }
    }
  }

  function selectAutocompleteItem(index: number): void {
    if (index < 0 || index >= filteredItems.length) return;
    const cmd = filteredItems[index]!;
    chatInput.value = `/${cmd.name}${cmd.hasArgs ? " " : ""}`;
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
          void ctx.app.deleteMemory(args).then(() => {
            showToast("Memory deleted");
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            addMessage("system", `Error: ${msg}`);
          });
        }
        break;

      case "export":
        void ctx.app.exportAllData().then(json => {
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `motebit-export-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          showToast("Export downloaded");
        }).catch((err: unknown) => {
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

      case "new":
        ctx.app.startNewConversation();
        chatLog.innerHTML = "";
        break;

      case "help":
        addMessage("system", formatHelpText());
        break;

      default:
        addMessage("system", `Unknown command: /${command}`);
    }
  }

  // === Send Handler ===

  async function handleSend(): Promise<void> {
    const text = chatInput.value.trim();
    if (!text || ctx.app.isProcessing) return;

    chatInput.value = "";
    hideAutocomplete();

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

  function destroy(): void {
    chatInput.removeEventListener("input", handleAutocompleteInput);
    chatInput.removeEventListener("keydown", handleAutocompleteKeydown);
    hideAutocomplete();
  }

  return { handleSend, destroy };
}
