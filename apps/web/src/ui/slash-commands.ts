// === Slash Command Autocomplete ===
// Web-specific subset of commands. Desktop-only commands are omitted.

import type { ChatAPI } from "./chat";
import { addMessage } from "./chat";
import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";

// --- Relay fetch helper (inlined from sovereign-panels) ---

async function relayFetch(ctx: WebContext, path: string): Promise<unknown> {
  const syncUrl = loadSyncUrl();
  if (!syncUrl) throw new Error("No relay URL configured — connect in Settings first");
  const token = await ctx.app.createSyncToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${syncUrl}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<unknown>;
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
  { name: "audit", description: "Audit memory integrity" },
  { name: "balance", description: "Show account balance" },
  { name: "discover", description: "Discover agents on relay" },
  { name: "delegate", description: "Delegate task to agent" },
  { name: "approvals", description: "Show pending approvals" },
  { name: "deposits", description: "Show deposit history" },
  { name: "withdraw", description: "Request withdrawal" },
  { name: "propose", description: "Propose collaborative plan" },
  { name: "proposals", description: "List active proposals" },
  { name: "serve", description: "Toggle accepting delegations" },
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
        void (async () => {
          const runtime = ctx.app.getRuntime();
          if (!runtime) {
            addMessage("system", "Runtime not initialized.");
            return;
          }
          const g = runtime.getGradient();
          if (!g) {
            addMessage("system", "No gradient data yet.");
            return;
          }
          const summary = runtime.getGradientSummary();
          const gLines: string[] = [];
          gLines.push(
            `Intelligence gradient: ${g.gradient.toFixed(3)} (delta: ${g.delta >= 0 ? "+" : ""}${g.delta.toFixed(3)})`,
          );
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
          const lastRef = runtime.getLastReflection();
          if (lastRef?.selfAssessment) {
            gLines.push("");
            gLines.push(`Last reflection: ${lastRef.selfAssessment}`);
          }
          addMessage("system", gLines.join("\n"));
        })();
        break;
      }
      case "audit": {
        chatInput.value = "";
        void (async () => {
          const runtime = ctx.app.getRuntime();
          if (!runtime) {
            addMessage("system", "Runtime not initialized.");
            return;
          }
          const result = await runtime.auditMemory();
          const lines: string[] = [];
          lines.push(`Memory audit (${result.nodesAudited} nodes scanned)`);

          if (result.phantomCertainties.length > 0) {
            lines.push("");
            lines.push(`Phantom certainties (${result.phantomCertainties.length}):`);
            for (const p of result.phantomCertainties) {
              const label =
                p.node.content.length > 60 ? p.node.content.slice(0, 60) + "..." : p.node.content;
              lines.push(`  conf=${p.decayedConfidence.toFixed(2)} edges=${p.edgeCount}  ${label}`);
            }
          }

          if (result.conflicts.length > 0) {
            lines.push("");
            lines.push(`Conflicts (${result.conflicts.length}):`);
            for (const c of result.conflicts) {
              const aLabel =
                c.a.content.length > 40 ? c.a.content.slice(0, 40) + "..." : c.a.content;
              const bLabel =
                c.b.content.length > 40 ? c.b.content.slice(0, 40) + "..." : c.b.content;
              lines.push(`  "${aLabel}" vs "${bLabel}"`);
            }
          }

          if (result.nearDeath.length > 0) {
            lines.push("");
            lines.push(`Near-death (${result.nearDeath.length}):`);
            for (const nd of result.nearDeath) {
              const label =
                nd.node.content.length > 60
                  ? nd.node.content.slice(0, 60) + "..."
                  : nd.node.content;
              lines.push(`  conf=${nd.decayedConfidence.toFixed(3)}  ${label}`);
            }
          }

          if (
            result.phantomCertainties.length === 0 &&
            result.conflicts.length === 0 &&
            result.nearDeath.length === 0
          ) {
            lines.push("No integrity issues found.");
          }

          addMessage("system", lines.join("\n"));
        })();
        break;
      }
      case "balance": {
        chatInput.value = "";
        void (async () => {
          try {
            const data = (await relayFetch(ctx, `/api/v1/agents/${ctx.app.motebitId}/balance`)) as {
              balance: number;
              pending_allocations: number;
              currency: string;
            };
            addMessage(
              "system",
              `Balance: ${data.balance} ${data.currency ?? "USDC"}\nPending: ${data.pending_allocations ?? 0}`,
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
        chatInput.value = "";
        void (async () => {
          try {
            const data = (await relayFetch(ctx, `/api/v1/agents/${ctx.app.motebitId}/balance`)) as {
              transactions?: Array<{ type: string; amount: number; created_at: number }>;
            };
            const deposits = (data.transactions ?? []).filter((t) => t.type === "deposit");
            if (deposits.length === 0) {
              addMessage("system", "No deposits yet.");
            } else {
              const lines = deposits
                .slice(0, 10)
                .map((d) => `  ${new Date(d.created_at).toLocaleDateString()} — ${d.amount} USDC`);
              addMessage("system", `Recent deposits:\n${lines.join("\n")}`);
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
      case "withdraw": {
        chatInput.value = "";
        addMessage(
          "system",
          "Withdrawals require the CLI or desktop app for secure signing. Run: motebit withdraw",
        );
        break;
      }
      case "discover": {
        chatInput.value = "";
        void (async () => {
          try {
            const data = (await relayFetch(ctx, "/api/v1/agents/discover")) as {
              agents: Array<{ motebit_id: string; capabilities: string[]; endpoint_url: string }>;
            };
            const agents = data.agents ?? [];
            if (agents.length === 0) {
              addMessage("system", "No agents found on relay.");
            } else {
              const lines = agents
                .slice(0, 15)
                .map(
                  (a) =>
                    `  ${a.motebit_id.slice(0, 8)}... — ${(a.capabilities ?? []).join(", ") || "no caps"}`,
                );
              addMessage("system", `Discovered agents (${agents.length}):\n${lines.join("\n")}`);
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
      case "delegate": {
        chatInput.value = "";
        addMessage(
          "system",
          "Delegation happens transparently during conversation when connected to a relay. " +
            "The AI will delegate to known agents when it lacks a capability locally.\n" +
            "To delegate manually, use the CLI: motebit delegate <agent-id> <prompt>",
        );
        break;
      }
      case "approvals": {
        chatInput.value = "";
        {
          const runtime = ctx.app.getRuntime();
          if (!runtime) {
            addMessage("system", "Runtime not initialized.");
            break;
          }
          const pending = runtime.hasPendingApproval ? runtime.pendingApprovalInfo : null;
          if (!pending) {
            addMessage("system", "No pending approvals.");
          } else {
            addMessage(
              "system",
              `Pending approval: ${pending.toolName}\nArgs: ${JSON.stringify(pending.args, null, 2)}`,
            );
          }
        }
        break;
      }
      case "propose": {
        chatInput.value = "";
        addMessage(
          "system",
          "Collaborative proposals require the CLI. Run: motebit propose <agent-ids> <goal>",
        );
        break;
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
        break;
      }
      case "proposals": {
        chatInput.value = "";
        void (async () => {
          try {
            const data = (await relayFetch(
              ctx,
              `/api/v1/agents/${ctx.app.motebitId}/proposals`,
            )) as {
              proposals: Array<{
                proposal_id: string;
                status: string;
                goal: string;
                created_at: number;
              }>;
            };
            const proposals = data.proposals ?? [];
            if (proposals.length === 0) {
              addMessage("system", "No active proposals.");
            } else {
              const lines = proposals
                .slice(0, 10)
                .map(
                  (p) =>
                    `  ${p.proposal_id.slice(0, 8)}... [${p.status}] — ${(p.goal ?? "").slice(0, 60)}`,
                );
              addMessage("system", `Proposals (${proposals.length}):\n${lines.join("\n")}`);
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
