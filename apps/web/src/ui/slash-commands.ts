// === Slash Command Autocomplete ===
// Web-specific subset of commands. Desktop-only commands are omitted.

import { addMessage, addExpandableCard } from "./chat";
import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";
import { executeCommand } from "@motebit/runtime";
import type { RelayConfig } from "@motebit/runtime";

/** Build RelayConfig from current web context, or null if not connected. */
async function getRelayConfig(ctx: WebContext): Promise<RelayConfig | null> {
  const syncUrl = loadSyncUrl();
  if (!syncUrl) return null;
  const token = await ctx.app.createSyncToken();
  if (!token) return null;
  return { relayUrl: syncUrl, authToken: token, motebitId: ctx.app.motebitId };
}

/**
 * Execute a shared command and render the result using web UI primitives.
 */
async function trySharedCommand(
  ctx: WebContext,
  name: string,
  args?: string,
  onAudit?: (flags: Map<string, string>) => void,
): Promise<void> {
  const runtime = ctx.app.getRuntime();
  if (!runtime) {
    addMessage("system", "Runtime not initialized.");
    return;
  }

  const relay = await getRelayConfig(ctx);
  try {
    const result = await executeCommand(runtime, name, args, relay ?? undefined);
    if (!result) return;

    if (result.detail) {
      addExpandableCard(result.summary, result.detail);
    } else {
      addMessage("system", result.summary);
    }

    // Special case: audit opens memory panel with flags
    if (name === "audit" && result.data && onAudit) {
      const auditFlags = new Map<string, string>();
      for (const id of (result.data["phantomIds"] as string[]) ?? []) auditFlags.set(id, "phantom");
      for (const id of (result.data["conflictIds"] as string[]) ?? [])
        auditFlags.set(id, "conflict");
      for (const id of (result.data["nearDeathIds"] as string[]) ?? [])
        auditFlags.set(id, "near-death");
      if (auditFlags.size > 0) onAudit(auditFlags);
    }
  } catch (err: unknown) {
    addMessage("system", `${name} error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface SlashCommandDef {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "clear", description: "Clear conversation" },
  { name: "settings", description: "Open settings" },
  { name: "conversations", description: "Browse conversations" },
  { name: "memories", description: "Browse memories" },
  { name: "skills", description: "Browse and install skills" },
  {
    name: "activity",
    description: "View signed deletions, consents, and other audit-grade events",
  },
  { name: "goals", description: "Browse goals" },
  { name: "goal", description: "Quick-add a goal" },
  { name: "computer", description: "Motebit Computer — reveal or hide the slab" },
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
  { name: "audit", description: "Audit memory integrity" },
  { name: "balance", description: "Show account balance" },
  { name: "discover", description: "Discover agents on relay" },
  { name: "delegate", description: "Delegate task to agent" },
  { name: "approvals", description: "Show pending approvals" },
  { name: "deposits", description: "Show deposit history" },
  { name: "withdraw", description: "Request withdrawal" },
  { name: "plan", description: "Break down a complex goal into steps" },
  { name: "propose", description: "Propose collaborative plan" },
  { name: "proposals", description: "List active proposals" },
  { name: "serve", description: "Toggle accepting delegations" },
  { name: "sensitivity", description: "Show or set session sensitivity tier" },
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
  openMemory(auditNodeIds?: Map<string, string>): void;
  openGoals(): void;
  openAgents(): void;
  newConversation(): void;
  /** Toggle the Motebit Computer slab's user-held visibility. */
  toggleSlab(): boolean;
}

export interface SlashCommandsHandle {
  /** Try to execute a slash command from raw input text. Returns true if handled. */
  tryExecute(text: string): boolean;
}

export function initSlashCommands(
  ctx: WebContext,
  callbacks: SlashCommandsCallbacks,
): SlashCommandsHandle {
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

    // Surface-specific commands (UI actions, platform features)
    switch (cmd.name) {
      case "clear":
        chatInput.value = "";
        callbacks.newConversation();
        return;
      case "settings":
        chatInput.value = "";
        callbacks.openSettings();
        return;
      case "conversations":
        chatInput.value = "";
        callbacks.openConversations();
        return;
      case "help":
        chatInput.value = "";
        callbacks.openShortcuts();
        return;
      case "memories":
        chatInput.value = "";
        callbacks.openMemory();
        return;
      case "skills":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:open-skills"));
        return;
      case "activity":
        chatInput.value = "";
        document.dispatchEvent(new CustomEvent("motebit:open-activity"));
        return;
      case "goals":
      case "goal":
        chatInput.value = "";
        callbacks.openGoals();
        return;
      case "agents":
        chatInput.value = "";
        callbacks.openAgents();
        return;
      case "computer":
        chatInput.value = "";
        callbacks.toggleSlab();
        return;
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
        return;
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
        return;
      }
      case "forget": {
        chatInput.value = "";
        callbacks.openMemory();
        addMessage("system", "Use the memory panel to select memories to forget.");
        return;
      }
      case "serve": {
        chatInput.value = "";
        if (ctx.app.isServing()) {
          ctx.app.stopServing();
          addMessage("system", "Stopped serving");
        } else {
          void (async () => {
            const result = await ctx.app.startServing();
            if (result.ok) {
              addMessage("system", "Serving — accepting delegations while this tab is open");
            } else {
              addMessage("system", `Could not start serving: ${result.error}`);
            }
          })();
        }
        return;
      }
    }

    // /plan — decompose goal into steps and execute with auto-routing
    if (cmd.name === "plan") {
      // Leave the command in the input — user types the goal after it
      chatInput.value = "/plan ";
      chatInput.focus();
      return;
    }

    // Shared commands — same data extraction and formatting as all surfaces
    chatInput.value = "";
    void trySharedCommand(ctx, cmd.name, undefined, (flags) => callbacks.openMemory(flags));
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

  return {
    tryExecute(text: string): boolean {
      if (!text.startsWith("/")) return false;
      const name = text.slice(1).split(/\s/)[0]!.toLowerCase();
      const cmd = SLASH_COMMANDS.find((c) => c.name === name);
      if (!cmd) return false;

      // Sensitivity is the first slash command on the web surface that
      // takes an inline arg. Handle it before the autocomplete-select
      // indirection (which discards args by overwriting chatInput.value).
      // User-facing entry point for the runtime sensitivity gate
      // shipped in 4ed47f42 (AI calls) + 98c12730 (outbound tools).
      if (name === "sensitivity") {
        chatInput.value = "";
        const arg = text.slice("/sensitivity".length).trim().toLowerCase();
        const VALID = ["none", "personal", "medical", "financial", "secret"] as const;
        const runtime = ctx.app.getRuntime();
        if (!runtime) {
          addMessage("system", "Runtime not initialized.");
          return true;
        }
        if (arg === "" || arg === "status") {
          addMessage("system", `Session sensitivity: ${runtime.getSessionSensitivity()}`);
          return true;
        }
        if (!(VALID as ReadonlyArray<string>).includes(arg)) {
          addMessage(
            "system",
            `Usage: /sensitivity [<level>] — level ∈ {${VALID.join(", ")}} (current: ${runtime.getSessionSensitivity()})`,
          );
          return true;
        }
        runtime.setSessionSensitivity(arg as import("@motebit/sdk").SensitivityLevel);
        const elevated = arg === "medical" || arg === "financial" || arg === "secret";
        addMessage(
          "system",
          elevated
            ? `Session elevated to ${arg} — outbound tools and external AI will fail-close until you switch to a sovereign (on-device) provider.`
            : `Session sensitivity: ${arg}`,
        );
        return true;
      }

      chatInput.value = "/" + cmd.name;
      selectCommand(cmd);
      return true;
    },
  };
}
