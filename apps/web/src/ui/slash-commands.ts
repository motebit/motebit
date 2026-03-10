// === Slash Command Autocomplete ===
// Web-specific subset of commands. Desktop-only commands are omitted.

import type { ChatAPI } from "./chat";
import { addMessage } from "./chat";
import type { WebContext } from "../types";

interface SlashCommandDef {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "clear", description: "Clear conversation" },
  { name: "settings", description: "Open settings" },
  { name: "conversations", description: "Browse conversations" },
  { name: "memories", description: "Browse memories" },
  { name: "state", description: "Show state vector" },
  { name: "tools", description: "List registered tools" },
  { name: "summarize", description: "Summarize conversation" },
  { name: "model", description: "Show current model" },
  { name: "help", description: "Show keyboard shortcuts" },
];

function filterCommands(partial: string): SlashCommandDef[] {
  const query = partial.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
}

// === DOM Refs ===

const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const autocompleteEl = document.getElementById("slash-autocomplete") as HTMLDivElement;

export interface SlashCommandsCallbacks {
  openSettings(): void;
  openConversations(): void;
  openShortcuts(): void;
  openMemory(): void;
}

export function initSlashCommands(
  chatAPI: ChatAPI,
  ctx: WebContext,
  callbacks: SlashCommandsCallbacks,
): void {
  let selectedIndex = 0;
  let visible = false;
  let matches: SlashCommandDef[] = [];

  function show(cmds: SlashCommandDef[]): void {
    matches = cmds;
    selectedIndex = 0;
    visible = true;
    render();
    autocompleteEl.classList.add("open");
  }

  function hide(): void {
    visible = false;
    matches = [];
    autocompleteEl.classList.remove("open");
    autocompleteEl.innerHTML = "";
  }

  function render(): void {
    autocompleteEl.innerHTML = "";
    for (let i = 0; i < matches.length; i++) {
      const cmd = matches[i]!;
      const item = document.createElement("div");
      item.className = "slash-autocomplete-item" + (i === selectedIndex ? " selected" : "");

      const nameSpan = document.createElement("span");
      nameSpan.className = "slash-autocomplete-name";
      nameSpan.textContent = "/" + cmd.name;
      item.appendChild(nameSpan);

      const descSpan = document.createElement("span");
      descSpan.className = "slash-autocomplete-desc";
      descSpan.textContent = cmd.description;
      item.appendChild(descSpan);

      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // Prevent blur
        selectCommand(cmd);
      });

      item.addEventListener("mouseenter", () => {
        selectedIndex = i;
        updateSelection();
      });

      autocompleteEl.appendChild(item);
    }
  }

  function updateSelection(): void {
    const items = autocompleteEl.querySelectorAll(".slash-autocomplete-item");
    items.forEach((el, i) => {
      el.classList.toggle("selected", i === selectedIndex);
    });
  }

  function selectCommand(cmd: SlashCommandDef): void {
    chatInput.value = "/" + cmd.name;
    hide();

    switch (cmd.name) {
      case "clear":
        void chatAPI.handleSend();
        break;
      case "settings":
        chatInput.value = "";
        callbacks.openSettings();
        break;
      case "conversations":
        chatInput.value = "";
        callbacks.openConversations();
        break;
      case "help":
        chatInput.value = "";
        callbacks.openShortcuts();
        break;
      case "memories":
        chatInput.value = "";
        callbacks.openMemory();
        break;
      case "state": {
        chatInput.value = "";
        const runtime = ctx.app.getRuntime();
        if (runtime) {
          const state = runtime.getState();
          const lines = Object.entries(state).map(
            ([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(3) : String(v)}`,
          );
          addMessage("system", lines.join("\n"));
        } else {
          addMessage("system", "Runtime not initialized.");
        }
        break;
      }
      case "tools": {
        chatInput.value = "";
        const runtime = ctx.app.getRuntime();
        if (runtime) {
          const tools = runtime.getToolRegistry().list();
          if (tools.length === 0) {
            addMessage("system", "No tools registered.");
          } else {
            const names = tools.map((t) => t.name).join(", ");
            addMessage("system", `Registered tools: ${names}`);
          }
        } else {
          addMessage("system", "Runtime not initialized.");
        }
        break;
      }
      case "summarize": {
        chatInput.value = "";
        void (async () => {
          const result = await ctx.app.summarize();
          if (result) {
            addMessage("system", `Summary: ${result}`);
          } else {
            addMessage("system", "Nothing to summarize.");
          }
        })();
        break;
      }
      case "model": {
        chatInput.value = "";
        const model = ctx.app.currentModel;
        addMessage("system", model ? `Current model: ${model}` : "No model connected.");
        break;
      }
    }
  }

  // Listen to input changes
  chatInput.addEventListener("input", () => {
    const val = chatInput.value;
    if (val.startsWith("/") && val.length > 1) {
      const partial = val.slice(1);
      const cmds = filterCommands(partial);
      if (cmds.length > 0) {
        show(cmds);
      } else {
        hide();
      }
    } else if (val === "/") {
      show(SLASH_COMMANDS);
    } else {
      hide();
    }
  });

  // Arrow key navigation
  chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (!visible) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % matches.length;
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
      updateSelection();
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (matches[selectedIndex]) {
        selectCommand(matches[selectedIndex]!);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });

  // Hide on blur
  chatInput.addEventListener("blur", () => {
    // Small delay to allow mousedown on autocomplete items
    setTimeout(hide, 150);
  });
}
