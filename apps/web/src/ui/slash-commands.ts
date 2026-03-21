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
  { name: "goals", description: "Browse goals" },
  { name: "goal", description: "Quick-add a goal" },
  { name: "mcp", description: "MCP server management" },
  { name: "state", description: "Show state vector" },
  { name: "tools", description: "List registered tools" },
  { name: "summarize", description: "Summarize conversation" },
  { name: "model", description: "Show current model" },
  { name: "help", description: "Show keyboard shortcuts" },
  { name: "agents", description: "List known agents" },
  { name: "graph", description: "Memory graph stats" },
  { name: "curious", description: "Show curiosity targets" },
  { name: "reflect", description: "Trigger self-reflection" },
  { name: "export", description: "Export identity + memories" },
  { name: "forget", description: "Delete a memory by keyword" },
  { name: "gradient", description: "Intelligence gradient" },
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
  openGoals(): void;
  openAgents(): void;
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
      case "goals":
        chatInput.value = "";
        callbacks.openGoals();
        break;
      case "goal": {
        // "/goal <prompt>" — quick-add a goal without opening the panel
        // The full input was already consumed by autocomplete selection,
        // so this just opens the goals panel for the user to type there.
        chatInput.value = "";
        callbacks.openGoals();
        break;
      }
      case "mcp": {
        chatInput.value = "";
        const servers = ctx.app.getMcpServers();
        if (servers.length === 0) {
          addMessage("system", "No MCP servers connected. Use Settings to add one.");
        } else {
          const lines = servers.map(
            (s) =>
              `${s.connected ? "●" : "○"} ${s.name} — ${s.url} (${s.toolCount} tools${s.trusted ? ", trusted" : ""})`,
          );
          addMessage("system", `MCP servers:\n${lines.join("\n")}`);
        }
        break;
      }
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
      case "agents": {
        chatInput.value = "";
        callbacks.openAgents();
        break;
      }
      case "graph": {
        chatInput.value = "";
        void (async () => {
          const runtime = ctx.app.getRuntime();
          if (!runtime) {
            addMessage("system", "Runtime not initialized.");
            return;
          }
          const { nodes, edges } = await runtime.memory.exportAll();
          const active = nodes.filter((n) => !n.tombstoned);
          const pinned = active.filter((n) => n.pinned);
          addMessage(
            "system",
            `Memory graph: ${active.length} nodes, ${edges.length} edges, ${pinned.length} pinned`,
          );
        })();
        break;
      }
      case "curious": {
        chatInput.value = "";
        const rt = ctx.app.getRuntime();
        if (!rt) {
          addMessage("system", "Runtime not initialized.");
          break;
        }
        const targets = rt.getCuriosityTargets();
        if (targets.length === 0) {
          addMessage("system", "No curiosity targets — memory graph is stable.");
        } else {
          const lines = targets.map(
            (t) => `  ${t.node.content.slice(0, 80)}${t.node.content.length > 80 ? "..." : ""}`,
          );
          addMessage("system", `Curiosity targets (${targets.length}):\n${lines.join("\n")}`);
        }
        break;
      }
      case "reflect": {
        chatInput.value = "";
        void (async () => {
          const runtime = ctx.app.getRuntime();
          if (!runtime) {
            addMessage("system", "Runtime not initialized.");
            return;
          }
          addMessage("system", "Reflecting...");
          const result = await runtime.reflect();
          addMessage(
            "system",
            `Reflection complete.\nSelf-assessment: ${result.selfAssessment}\nInsights: ${result.insights.length}`,
          );
        })();
        break;
      }
      case "export": {
        chatInput.value = "";
        void (async () => {
          const json = await ctx.app.exportData();
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `motebit-export-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          addMessage("system", "Export downloaded.");
        })();
        break;
      }
      case "forget": {
        chatInput.value = "";
        void (async () => {
          const runtime = ctx.app.getRuntime();
          if (!runtime) {
            addMessage("system", "Runtime not initialized.");
            return;
          }
          const { nodes } = await runtime.memory.exportAll();
          const active = nodes.filter((n) => !n.tombstoned);
          if (active.length === 0) {
            addMessage("system", "No memories to forget.");
            return;
          }
          // Delete the oldest non-pinned memory as a simple default behavior
          // (real keyword-based forget would require input parsing)
          callbacks.openMemory();
          addMessage("system", "Use the memory panel to select memories to forget.");
        })();
        break;
      }
      case "gradient": {
        chatInput.value = "";
        const runtime = ctx.app.getRuntime();
        if (!runtime) {
          addMessage("system", "Runtime not initialized.");
          break;
        }
        const g = runtime.getGradient();
        if (!g) {
          addMessage("system", "No gradient data yet.");
          break;
        }
        const metrics = [
          `kd: ${g.knowledge_density.toFixed(2)}`,
          `kq: ${g.knowledge_quality.toFixed(2)}`,
          `gc: ${g.graph_connectivity.toFixed(2)}`,
          `ts: ${g.temporal_stability.toFixed(2)}`,
          `rq: ${g.retrieval_quality.toFixed(2)}`,
          `ie: ${g.interaction_efficiency.toFixed(2)}`,
          `te: ${g.tool_efficiency.toFixed(2)}`,
          `cp: ${g.curiosity_pressure.toFixed(2)}`,
        ];
        addMessage(
          "system",
          `Intelligence gradient (${g.gradient.toFixed(2)}):\n${metrics.join("  ")}`,
        );
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
