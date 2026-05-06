/**
 * Mobile slash command dispatcher — pure functional handler for the
 * 30+ `/command` shortcuts the user can type into the chat input.
 *
 * The dispatcher has no internal state; every side effect lands via
 * injected setter callbacks (`setMessages`, `setShowXxxPanel`,
 * `showToast`, `addSystemMessage`, `setCurrentModel`).
 *
 * The handler is a plain async function rather than a custom hook
 * because there's nothing to memoize or store — it's invoked once per
 * user keypress. App.tsx wraps it in a `useCallback` so the deps
 * closure is stable across renders.
 *
 * Commands grouped by purpose:
 *   - Chat navigation: /model, /conversations, /new, /clear, /settings, /help
 *   - Memory: /memories, /graph, /curious, /forget, /audit, /summarize
 *   - Observability: /state, /reflect, /gradient, /tools, /operator
 *   - Agents: /agents, /discover, /serve
 *   - Goals: /goals, /plan
 *   - Economy: /balance, /deposits, /approvals, /proposals, /withdraw
 *   - Federation: /sync, /export, /delegate, /propose
 */

import { MemoryType } from "@motebit/sdk";
import type { MobileApp } from "./mobile-app";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "approval" | "receipt";
  content: string;
  timestamp: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  riskLevel?: number;
  approvalResolved?: boolean;
  receipt?: import("@motebit/sdk").ExecutionReceipt;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export interface SlashCommandDeps {
  app: MobileApp;
  addSystemMessage: (content: string) => void;
  showToast: (msg: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setCurrentModel: (model: string) => void;
  setShowConversationPanel: (show: boolean) => void;
  setShowMemoryPanel: (show: boolean) => void;
  setShowGoalsPanel: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setShowSkillsPanel: (show: boolean) => void;
  setShowActivityPanel: (show: boolean) => void;
}

export function runSlashCommand(command: string, args: string, deps: SlashCommandDeps): void {
  const {
    app: a,
    addSystemMessage,
    showToast,
    setMessages,
    setCurrentModel,
    setShowConversationPanel,
    setShowMemoryPanel,
    setShowGoalsPanel,
    setShowSettings,
    setShowSkillsPanel,
    setShowActivityPanel,
  } = deps;

  switch (command) {
    case "model":
      if (!args) {
        addSystemMessage(`Current model: ${a.currentModel ?? "none"}`);
      } else {
        try {
          a.setModel(args);
          setCurrentModel(args);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`Error: ${msg}`);
        }
      }
      break;
    case "conversations":
      setShowConversationPanel(true);
      break;
    case "new":
      a.startNewConversation();
      setMessages([]);
      break;
    case "memories":
      setShowMemoryPanel(true);
      break;
    case "sync":
      void a
        .syncNow()
        .then(() => {
          showToast("Synced");
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`Sync failed: ${msg}`);
        });
      break;
    case "export":
      void a.exportAllData().then((data) => {
        addSystemMessage(`Exported data:\n${data}`);
      });
      break;
    case "settings":
      setShowSettings(true);
      break;
    case "summarize":
      void (async () => {
        try {
          const summary = await a.summarizeConversation();
          if (summary != null && summary !== "") {
            addSystemMessage(`Summary:\n${summary}`);
          } else {
            addSystemMessage("No conversation to summarize (need at least 2 messages).");
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`Summarization failed: ${msg}`);
        }
      })();
      break;
    case "state": {
      const st = a.getState();
      if (st) {
        const lines = Object.entries(st)
          .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(2) : String(v)}`)
          .join("\n");
        addSystemMessage(`State vector:\n${lines}`);
      } else {
        addSystemMessage("State not available (runtime not initialized)");
      }
      break;
    }
    case "forget":
      if (!args) {
        addSystemMessage("Usage: /forget <nodeId>");
      } else {
        void a.deleteMemory(args).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`Error: ${msg}`);
        });
      }
      break;
    case "clear":
      a.startNewConversation();
      setMessages([]);
      break;
    case "tools": {
      const mcpServers = a.getMcpServers();
      const serverCount = mcpServers.length;
      let toolCount = 0;
      const serverLines: string[] = [];
      for (const srv of mcpServers) {
        toolCount += srv.toolCount;
        serverLines.push(`  ${srv.name}: ${srv.toolCount} tools${srv.trusted ? " (trusted)" : ""}`);
      }
      addSystemMessage(
        `Tools: ${toolCount} from ${serverCount} MCP server${serverCount !== 1 ? "s" : ""}\n` +
          (serverLines.length > 0 ? serverLines.join("\n") : "  No MCP servers connected"),
      );
      break;
    }
    case "operator":
      break;
    case "graph":
      void (async () => {
        try {
          const { nodes, edges } = await a.getMemoryGraphStats();
          const live = nodes.filter((n) => !n.tombstoned);
          if (live.length === 0) {
            addSystemMessage("No memories in graph.");
            return;
          }
          const DAY = 86_400_000;
          const liveIds = new Set(live.map((n) => n.node_id));
          const liveEdges = edges.filter(
            (e) => liveIds.has(e.source_id) || liveIds.has(e.target_id),
          );
          const sem = live.filter(
            (n) => (n.memory_type ?? MemoryType.Semantic) === MemoryType.Semantic,
          ).length;
          const epi = live.filter((n) => n.memory_type === MemoryType.Episodic).length;
          const pinned = live.filter((n) => n.pinned).length;
          const avgHalfLife = live.reduce((s, n) => s + n.half_life, 0) / live.length;
          const compounded = live.filter((n) => n.half_life > 30 * DAY).length;
          const avgConf = live.reduce((s, n) => s + n.confidence, 0) / live.length;
          const edgeTypes = new Map<string, number>();
          for (const e of liveEdges) {
            edgeTypes.set(e.relation_type, (edgeTypes.get(e.relation_type) ?? 0) + 1);
          }
          let msg =
            `Memory Graph:\n` +
            `  Nodes: ${live.length} (${sem} semantic, ${epi} episodic, ${pinned} pinned)\n` +
            `  Edges: ${liveEdges.length}`;
          if (edgeTypes.size > 0) {
            const parts = Array.from(edgeTypes.entries())
              .map(([t, c]) => `${c} ${t}`)
              .join(", ");
            msg += `\n           ${parts}`;
          }
          msg +=
            `\n  Avg conf: ${avgConf.toFixed(2)}` +
            `\n  Avg half: ${Math.round(avgHalfLife / DAY)}d` +
            `\n  Compounded: ${compounded} (half-life > 30d)` +
            `\n  Density: ${(liveEdges.length / live.length).toFixed(2)} edges/node`;
          const gradient = a.getGradient();
          if (gradient) {
            const delta =
              gradient.delta >= 0 ? `+${gradient.delta.toFixed(4)}` : gradient.delta.toFixed(4);
            msg += `\n  Gradient: ${gradient.gradient.toFixed(4)} (${delta})`;
          }
          addSystemMessage(msg);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`Error: ${msg}`);
        }
      })();
      break;
    case "curious": {
      const targets = a.getCuriosityTargets();
      if (targets.length === 0) {
        addSystemMessage("No curiosity targets — all memories are healthy or too far gone.");
      } else {
        const DAY_MS = 86_400_000;
        const lines = targets.map((t) => {
          const ageDays = Math.round((Date.now() - t.node.created_at) / DAY_MS);
          const halfDays = Math.round(t.node.half_life / DAY_MS);
          return (
            `  ${t.node.node_id.slice(0, 8)}  score=${t.curiosityScore.toFixed(3)}  ` +
            `conf=${t.node.confidence.toFixed(2)}\u2192${t.decayedConfidence.toFixed(2)}  ` +
            `age=${ageDays}d  half=${halfDays}d\n` +
            `             ${t.node.content}`
          );
        });
        addSystemMessage(
          `Curiosity targets (${targets.length}):\n\n` +
            lines.join("\n") +
            "\n\nThese memories are fading. Confirm or update them to reinforce.",
        );
      }
      break;
    }
    case "reflect":
      void (async () => {
        try {
          addSystemMessage("Reflecting...");
          const reflection = await a.reflect();
          let msg = "";
          if (reflection.insights.length > 0) {
            msg += "Insights:\n" + reflection.insights.map((i) => `  - ${i}`).join("\n");
          }
          if (reflection.planAdjustments.length > 0) {
            msg +=
              (msg ? "\n\n" : "") +
              "Adjustments:\n" +
              reflection.planAdjustments.map((adj) => `  - ${adj}`).join("\n");
          }
          if (reflection.patterns.length > 0) {
            msg +=
              (msg ? "\n\n" : "") +
              "Recurring patterns:\n" +
              reflection.patterns.map((p) => `  - ${p}`).join("\n");
          }
          if (reflection.selfAssessment) {
            msg += (msg ? "\n\n" : "") + `Self-assessment: ${reflection.selfAssessment}`;
          }
          const storedCount = reflection.insights.length + reflection.patterns.length;
          if (storedCount > 0) {
            msg += `\n\n  [${storedCount} item(s) stored as memories]`;
          }
          if (msg) {
            addSystemMessage(msg);
          } else {
            addSystemMessage("Reflection completed with no insights.");
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`Reflection failed: ${msg}`);
        }
      })();
      break;
    case "gradient":
      void (async () => {
        const grad = a.getGradient();
        if (!grad) {
          addSystemMessage("No gradient data yet (computed during housekeeping).");
          return;
        }
        const summary = a.getGradientSummary();
        const gLines: string[] = [];
        gLines.push(
          `Intelligence Gradient: ${grad.gradient.toFixed(4)} (${grad.delta >= 0 ? "+" : ""}${grad.delta.toFixed(4)})`,
        );
        if (summary.snapshotCount > 0) {
          gLines.push("");
          gLines.push(summary.trajectory);
          gLines.push(summary.overall);
          if (summary.strengths.length > 0)
            gLines.push(`Strengths: ${summary.strengths.join("; ")}`);
          if (summary.weaknesses.length > 0)
            gLines.push(`Weaknesses: ${summary.weaknesses.join("; ")}`);
          gLines.push(`Posture: ${summary.posture}`);
        }
        const { narrateEconomicConsequences } = await import("@motebit/gradient");
        const econ = narrateEconomicConsequences(grad);
        if (econ.length > 0) {
          gLines.push("");
          gLines.push("Economic position:");
          for (const c of econ) gLines.push(`  - ${c}`);
        }
        const lastRef = a.getLastReflection();
        if (lastRef?.selfAssessment) {
          gLines.push("");
          gLines.push(`Last reflection: ${lastRef.selfAssessment}`);
        }
        addSystemMessage(gLines.join("\n"));
      })();
      break;
    case "audit":
      void (async () => {
        try {
          const auditResult = await a.auditMemory();
          const aLines: string[] = [`Memory audit (${auditResult.nodesAudited} nodes scanned)`];
          if (auditResult.phantomCertainties.length > 0) {
            aLines.push("");
            aLines.push(`Phantom certainties (${auditResult.phantomCertainties.length}):`);
            for (const p of auditResult.phantomCertainties) {
              const label =
                p.node.content.length > 50 ? p.node.content.slice(0, 50) + "..." : p.node.content;
              aLines.push(
                `  conf=${p.decayedConfidence.toFixed(2)} edges=${p.edgeCount}  ${label}`,
              );
            }
          }
          if (auditResult.conflicts.length > 0) {
            aLines.push("");
            aLines.push(`Conflicts (${auditResult.conflicts.length}):`);
            for (const c of auditResult.conflicts) {
              aLines.push(`  "${c.a.content.slice(0, 30)}..." vs "${c.b.content.slice(0, 30)}..."`);
            }
          }
          if (auditResult.nearDeath.length > 0) {
            aLines.push("");
            aLines.push(`Near-death (${auditResult.nearDeath.length}):`);
            for (const nd of auditResult.nearDeath) {
              aLines.push(
                `  conf=${nd.decayedConfidence.toFixed(3)}  ${nd.node.content.slice(0, 50)}...`,
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
          addSystemMessage(aLines.join("\n"));
        } catch (err: unknown) {
          addSystemMessage(`Audit failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      break;
    case "agents":
      void (async () => {
        try {
          const agents = await a.listTrustedAgents();
          if (agents.length === 0) {
            addSystemMessage("No known agents.");
          } else {
            const lines = agents.map(
              (ag) =>
                `  ${ag.motebit_id.slice(0, 8)}... [${ag.trust_level}] — ${ag.successful_tasks ?? 0}/${(ag.successful_tasks ?? 0) + (ag.failed_tasks ?? 0)} tasks`,
            );
            addSystemMessage(`Known agents (${agents.length}):\n${lines.join("\n")}`);
          }
        } catch (err: unknown) {
          addSystemMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      break;
    case "discover":
      void (async () => {
        try {
          const data = (await a.relayFetch("/api/v1/agents/discover")) as {
            agents: Array<{
              motebit_id: string;
              capabilities: string[];
              trust_level?: string;
              interaction_count?: number;
              pricing?: Array<{
                capability: string;
                unit_cost: number;
                currency: string;
                per: string;
              }> | null;
              last_seen_at?: number;
            }>;
          };
          const agents = data.agents ?? [];
          if (agents.length === 0) {
            addSystemMessage("No agents found on relay.");
          } else {
            const lines = agents.slice(0, 15).map((ag) => {
              // Index pricing by capability — "web_search · $0.05/search" per desktop pattern
              const priceByCapability = new Map<
                string,
                { unit_cost: number; currency: string; per: string }
              >();
              if (Array.isArray(ag.pricing)) {
                for (const p of ag.pricing) {
                  priceByCapability.set(p.capability, {
                    unit_cost: p.unit_cost,
                    currency: p.currency,
                    per: p.per,
                  });
                }
              }
              const caps = (ag.capabilities ?? []).map((cap) => {
                const price = priceByCapability.get(cap);
                if (price && price.unit_cost > 0) {
                  return `${cap} · $${price.unit_cost.toFixed(2)}/${price.per}`;
                }
                return cap;
              });
              const capsPart = caps.length > 0 ? caps.join(", ") : "no caps";
              const trustPart =
                ag.trust_level != null && ag.trust_level !== ""
                  ? typeof ag.interaction_count === "number" && ag.interaction_count > 0
                    ? ` [${ag.trust_level.replace(/_/g, " ")} · ${ag.interaction_count} interaction${ag.interaction_count === 1 ? "" : "s"}]`
                    : ` [${ag.trust_level.replace(/_/g, " ")}]`
                  : "";
              const seenPart =
                typeof ag.last_seen_at === "number" && ag.last_seen_at > 0
                  ? ` — seen ${formatTimeAgo(ag.last_seen_at)}`
                  : "";
              return `  ${ag.motebit_id.slice(0, 8)}...${trustPart} — ${capsPart}${seenPart}`;
            });
            addSystemMessage(`Discovered agents (${agents.length}):\n${lines.join("\n")}`);
          }
        } catch (err: unknown) {
          addSystemMessage(`Discovery error: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      break;
    case "serve":
      void (async () => {
        if (a.isServing()) {
          a.stopServing();
          addSystemMessage("Stopped serving");
        } else {
          const result = await a.startServing();
          if (result.ok) {
            addSystemMessage("Serving — accepting delegations");
          } else {
            addSystemMessage(`Could not start serving: ${result.error}`);
          }
        }
      })();
      break;
    case "goals":
      setShowGoalsPanel(true);
      break;
    case "skills":
      setShowSkillsPanel(true);
      break;
    case "activity":
      setShowActivityPanel(true);
      break;
    case "plan":
      if (!args.trim()) {
        addSystemMessage("Usage: /plan <goal description>");
        break;
      }
      void (async () => {
        try {
          const goalId = crypto.randomUUID();
          addSystemMessage(`Planning: ${args.trim()}`);
          const runtime = a.getRuntime();
          if (!runtime) {
            addSystemMessage("Runtime not initialized");
            return;
          }
          for await (const chunk of runtime.executePlan(goalId, args.trim())) {
            switch (chunk.type) {
              case "plan_created":
                addSystemMessage(`Plan: ${chunk.plan.title} (${chunk.steps.length} steps)`);
                break;
              case "step_started":
                addSystemMessage(`Step ${chunk.step.ordinal + 1}: ${chunk.step.description}`);
                break;
              case "step_completed":
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
                    detail += ` · ${rc.alternatives_considered + 1} agents evaluated`;
                }
                addSystemMessage(detail);
                break;
              }
              case "step_failed":
                addSystemMessage(`Step failed: ${chunk.error}`);
                break;
              case "plan_completed":
                addSystemMessage("Plan completed");
                break;
              case "plan_failed":
                addSystemMessage(`Plan failed: ${chunk.reason}`);
                break;
            }
          }
        } catch (err: unknown) {
          addSystemMessage(`Plan error: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      break;
    case "balance":
      void (async () => {
        try {
          const data = (await a.relayFetch(`/api/v1/agents/${a.motebitId}/balance`)) as {
            balance: number;
            pending_allocations: number;
            currency: string;
          };
          addSystemMessage(
            `Balance: ${data.balance} ${data.currency ?? "USDC"}\nPending: ${data.pending_allocations ?? 0}`,
          );
        } catch (err: unknown) {
          addSystemMessage(`Balance error: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      break;
    case "deposits":
      void (async () => {
        try {
          const data = (await a.relayFetch(`/api/v1/agents/${a.motebitId}/balance`)) as {
            transactions?: Array<{ type: string; amount: number; created_at: number }>;
          };
          const deposits = (data.transactions ?? []).filter((t) => t.type === "deposit");
          if (deposits.length === 0) {
            addSystemMessage("No deposits yet.");
          } else {
            const lines = deposits
              .slice(0, 10)
              .map((d) => `  ${new Date(d.created_at).toLocaleDateString()} — ${d.amount} USDC`);
            addSystemMessage(`Recent deposits:\n${lines.join("\n")}`);
          }
        } catch (err: unknown) {
          addSystemMessage(`Deposits error: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      break;
    case "approvals": {
      const pending = a.hasPendingApproval ? a.pendingApprovalInfo : null;
      if (!pending) {
        addSystemMessage("No pending approvals.");
      } else {
        addSystemMessage(
          `Pending approval: ${pending.toolName}\nArgs: ${JSON.stringify(pending.args, null, 2)}`,
        );
      }
      break;
    }
    case "proposals":
      void (async () => {
        try {
          const data = (await a.relayFetch(`/api/v1/agents/${a.motebitId}/proposals`)) as {
            proposals: Array<{ proposal_id: string; status: string; goal: string }>;
          };
          const proposals = data.proposals ?? [];
          if (proposals.length === 0) {
            addSystemMessage("No active proposals.");
          } else {
            const lines = proposals
              .slice(0, 10)
              .map(
                (p) =>
                  `  ${p.proposal_id.slice(0, 8)}... [${p.status}] — ${(p.goal ?? "").slice(0, 60)}`,
              );
            addSystemMessage(`Proposals (${proposals.length}):\n${lines.join("\n")}`);
          }
        } catch (err: unknown) {
          addSystemMessage(`Proposals error: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      break;
    case "withdraw":
      addSystemMessage("Withdrawals require secure signing. Use CLI: motebit withdraw");
      break;
    case "delegate":
      addSystemMessage(
        "Delegation happens transparently during conversation when connected to a relay. " +
          "To delegate manually, use CLI: motebit delegate <agent-id> <prompt>",
      );
      break;
    case "propose":
      addSystemMessage("Collaborative proposals use CLI: motebit propose <agent-ids> <goal>");
      break;
    case "sensitivity": {
      // User-facing entry point for the runtime sensitivity gate.
      // Mirrors apps/cli + apps/desktop semantics: /sensitivity with
      // no arg shows current; with an arg, sets the tier and reports
      // the consequence on elevation.
      const arg = args.trim().toLowerCase();
      const VALID = ["none", "personal", "medical", "financial", "secret"] as const;
      if (arg === "" || arg === "status") {
        addSystemMessage(`Session sensitivity: ${a.getSessionSensitivity() ?? "none"}`);
        break;
      }
      if (!(VALID as ReadonlyArray<string>).includes(arg)) {
        addSystemMessage(
          `Usage: /sensitivity [<level>] — level ∈ {${VALID.join(", ")}} (current: ${a.getSessionSensitivity() ?? "none"})`,
        );
        break;
      }
      a.setSessionSensitivity(arg as import("@motebit/sdk").SensitivityLevel);
      const elevated = arg === "medical" || arg === "financial" || arg === "secret";
      addSystemMessage(
        elevated
          ? `Session elevated to ${arg} — outbound tools and external AI will fail-close until you switch to a sovereign (on-device) provider.`
          : `Session sensitivity: ${arg}`,
      );
      break;
    }
    case "help":
      addSystemMessage(
        "Available commands:\n" +
          "/model — show current model\n" +
          "/model <name> — switch model\n" +
          "/conversations — browse past conversations\n" +
          "/new — start a new conversation\n" +
          "/memories — browse memories\n" +
          "/state — show current state vector\n" +
          "/graph — memory graph stats\n" +
          "/curious — curiosity targets\n" +
          "/reflect — trigger reflection\n" +
          "/gradient — intelligence gradient\n" +
          "/agents — list known agents\n" +
          "/discover — discover agents on relay\n" +
          "/serve — toggle accepting delegations\n" +
          "/goals — browse goals\n" +
          "/plan <goal> — decompose into steps\n" +
          "/balance — show account balance\n" +
          "/deposits — show deposit history\n" +
          "/approvals — pending approvals\n" +
          "/proposals — active proposals\n" +
          "/forget <nodeId> — delete a memory\n" +
          "/clear — clear conversation\n" +
          "/tools — list registered tools\n" +
          "/operator — show operator mode status\n" +
          "/summarize — summarize current conversation\n" +
          "/sync — sync with relay\n" +
          "/export — export all data\n" +
          "/settings — open settings\n" +
          "/delegate — delegate to agent (CLI)\n" +
          "/propose — propose collab plan (CLI)\n" +
          "/withdraw — request withdrawal (CLI)\n" +
          "/sensitivity [<level>] — show or set session sensitivity\n" +
          "/help — show this message",
      );
      break;
    default:
      addSystemMessage(`Unknown command: /${command}`);
  }
}
