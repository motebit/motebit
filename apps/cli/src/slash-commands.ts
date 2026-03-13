// --- REPL slash command handler ---

import type { MotebitRuntime, ReflectionResult } from "@motebit/runtime";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import type { MotebitDatabase } from "@motebit/persistence";
import { McpClientAdapter, type McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools";
import { AgentTrustLevel } from "@motebit/sdk";
import { computeReputationScore } from "@motebit/policy";
import type { CliConfig } from "./args.js";
import type { FullConfig } from "./config.js";
import { saveFullConfig } from "./config.js";
import { formatMs, formatTimeAgo } from "./utils.js";
import {
  SqliteConversationSyncStoreAdapter,
  SqlitePlanSyncStoreAdapter,
} from "./runtime-factory.js";
import {
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
} from "@motebit/sync-engine";
import { parseInterval } from "./intervals.js";

export interface ReplContext {
  moteDb: MotebitDatabase;
  motebitId: string;
  mcpAdapters: McpClientAdapter[];
  privateKeyBytes?: Uint8Array;
  deviceId?: string;
}

export function isSlashCommand(input: string): boolean {
  return input.startsWith("/");
}

export function parseSlashCommand(input: string): { command: string; args: string } {
  const spaceIdx = input.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: input.slice(1), args: "" };
  }
  return { command: input.slice(1, spaceIdx), args: input.slice(spaceIdx + 1).trim() };
}

function formatState(state: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    const display = typeof value === "number" ? value.toFixed(3) : String(value);
    lines.push(`  ${key.padEnd(20)} ${display}`);
  }
  return lines.join("\n");
}

export async function handleSlashCommand(
  cmd: string,
  args: string,
  runtime: MotebitRuntime,
  config: CliConfig,
  fullConfig?: FullConfig,
  repl?: ReplContext,
): Promise<void> {
  switch (cmd) {
    case "help":
      console.log(
        `
Available commands:
  /help              Show this help
  /memories          List all memories
  /graph             Memory graph stats — compounding health
  /curious           Show decaying memories the agent is curious about
  /state             Show current state vector
  /forget <nodeId>   Delete a memory by ID
  /export            Export all memories and state as JSON
  /clear             Clear conversation history
  /summarize         Summarize current conversation
  /conversations     List recent conversations
  /conversation <id> Load a past conversation
  /model <name>      Switch AI model
  /sync              Sync events and conversations with remote server
  /tools             List registered tools
  /goals             List all scheduled goals
  /goal add "<prompt>" --every <interval> [--once]
  /goal remove <id>  Remove a goal
  /goal pause <id>   Pause a goal
  /goal resume <id>  Resume a paused goal
  /goal outcomes <id> Show execution history
  /approvals         Show pending approval queue
  /reflect           Trigger reflection — see what the agent learned
  /mcp list          List MCP servers and trust status
  /mcp add <name> <url> [--motebit]  Add an HTTP MCP server
  /mcp remove <name> Remove an MCP server
  /mcp trust <name>  Trust an MCP server
  /mcp untrust <name> Untrust an MCP server
  /agents            List known agents with trust levels and reputation
  /agents info <id>  Full trust record detail for an agent
  /agents trust <id> <level>  Set trust level (first_contact|verified|trusted|blocked)
  /agents block <id> Shorthand for setting Blocked
  /discover [cap]    Discover agents on the relay (optional capability filter)
  /discover dom.com  Discover motebit at domain via DNS/well-known
  /operator          Show operator mode status
  quit, exit         Exit
`.trim(),
      );
      break;

    case "memories": {
      const data = await runtime.memory.exportAll();
      if (data.nodes.length === 0) {
        console.log("No memories stored yet.");
      } else {
        const MS_PER_DAY = 86_400_000;
        // Build edge count per node
        const edgeCounts = new Map<string, number>();
        for (const edge of data.edges) {
          edgeCounts.set(edge.source_id, (edgeCounts.get(edge.source_id) ?? 0) + 1);
          edgeCounts.set(edge.target_id, (edgeCounts.get(edge.target_id) ?? 0) + 1);
        }

        const live = data.nodes.filter((n) => !n.tombstoned);
        const now = Date.now();
        console.log(`\nMemories (${live.length} nodes, ${data.edges.length} edges):\n`);
        for (const node of live) {
          const halfDays = Math.round(node.half_life / MS_PER_DAY);
          const defaultDays = 30;
          const compounded = halfDays > defaultDays;
          const type = node.memory_type === "episodic" ? "epi" : "sem";
          const edges = edgeCounts.get(node.node_id) ?? 0;
          const pin = node.pinned ? " pin" : "";
          const compound = compounded ? ` \u2191${halfDays}d` : ` ${halfDays}d`;
          // Decay indicator
          const elapsed = now - node.created_at;
          const decayed = computeDecayedConfidence(node.confidence, node.half_life, elapsed);
          const loss = node.confidence - decayed;
          const decay = loss > 0.3 ? " [fading]" : loss > 0.15 ? " [aging]" : "";
          console.log(
            `  ${node.node_id.slice(0, 8)}  [${type} conf=${node.confidence.toFixed(2)}${compound} e=${edges}${pin}${decay}]  ${node.content}`,
          );
        }
      }
      break;
    }

    case "graph": {
      const graphData = await runtime.memory.exportAll();
      const live = graphData.nodes.filter((n) => !n.tombstoned);
      const liveIds = new Set(live.map((n) => n.node_id));
      const liveEdges = graphData.edges.filter(
        (e) => liveIds.has(e.source_id) || liveIds.has(e.target_id),
      );

      if (live.length === 0) {
        console.log("No memories in graph.");
        break;
      }

      const DAY = 86_400_000;
      const sem = live.filter((n) => (n.memory_type ?? "semantic") === "semantic").length;
      const epi = live.filter((n) => n.memory_type === "episodic").length;
      const pinned = live.filter((n) => n.pinned).length;
      const avgHalfLife = live.reduce((s, n) => s + n.half_life, 0) / live.length;
      const compounded = live.filter((n) => n.half_life > 30 * DAY).length;
      const avgConf = live.reduce((s, n) => s + n.confidence, 0) / live.length;

      // Edge breakdown
      const edgeTypes = new Map<string, number>();
      for (const e of liveEdges) {
        edgeTypes.set(e.relation_type, (edgeTypes.get(e.relation_type) ?? 0) + 1);
      }

      console.log("\nMemory Graph:\n");
      console.log(`  Nodes:      ${live.length} (${sem} semantic, ${epi} episodic, ${pinned} pinned)`);
      console.log(`  Edges:      ${liveEdges.length}`);
      if (edgeTypes.size > 0) {
        const parts = Array.from(edgeTypes.entries())
          .map(([t, c]) => `${c} ${t}`)
          .join(", ");
        console.log(`              ${parts}`);
      }
      console.log(`  Avg conf:   ${avgConf.toFixed(2)}`);
      console.log(`  Avg half:   ${Math.round(avgHalfLife / DAY)}d`);
      console.log(`  Compounded: ${compounded} (half-life > 30d)`);
      console.log(`  Density:    ${live.length > 0 ? (liveEdges.length / live.length).toFixed(2) : "0"} edges/node`);

      const curiosityTargets = runtime.getCuriosityTargets();
      if (curiosityTargets.length > 0) {
        const topScore = curiosityTargets[0]!.curiosityScore.toFixed(3);
        console.log(`  Curious:    ${curiosityTargets.length} memories fading (top score: ${topScore})`);
      }

      const gradient = runtime.getGradient();
      if (gradient) {
        const delta = gradient.delta >= 0 ? `+${gradient.delta.toFixed(4)}` : gradient.delta.toFixed(4);
        console.log(`\n  Gradient:   ${gradient.gradient.toFixed(4)} (${delta})`);
      }
      break;
    }

    case "state": {
      const state = runtime.getState();
      console.log("\nState vector:\n" + formatState(state as unknown as Record<string, unknown>));
      break;
    }

    case "forget": {
      if (!args) {
        console.log("Usage: /forget <nodeId>");
        break;
      }
      try {
        await runtime.memory.deleteMemory(args);
        console.log(`Deleted memory: ${args}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to delete memory: ${message}`);
      }
      break;
    }

    case "export": {
      const memories = await runtime.memory.exportAll();
      const state = runtime.getState();
      const exportData = { memories, state };
      console.log(JSON.stringify(exportData, null, 2));
      break;
    }

    case "clear":
      runtime.resetConversation();
      console.log("Conversation history cleared.");
      break;

    case "summarize": {
      try {
        const summary = await runtime.summarizeCurrentConversation();
        if (summary != null && summary !== "") {
          console.log(`\nSummary:\n${summary}`);
        } else {
          console.log("No conversation to summarize (need at least 2 messages).");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Summarization failed: ${message}`);
      }
      break;
    }

    case "model": {
      if (!args) {
        console.log(`Current model: ${runtime.currentModel}`);
        break;
      }
      runtime.setModel(args);
      console.log(`Model switched to: ${args}`);
      break;
    }

    case "sync": {
      try {
        console.log("Syncing events...");
        const result = await runtime.sync.sync();
        console.log(`  Events — pushed: ${result.pushed}, pulled: ${result.pulled}`);
        if (result.conflicts.length > 0) {
          console.log(`  Conflicts: ${result.conflicts.length}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Event sync failed: ${message}`);
      }

      // Conversation sync
      if (repl) {
        const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
        if (syncUrl != null && syncUrl !== "") {
          try {
            console.log("Syncing conversations...");
            const convStoreAdapter = new SqliteConversationSyncStoreAdapter(
              repl.moteDb.conversationStore,
            );
            const convSyncEngine = new ConversationSyncEngine(convStoreAdapter, repl.motebitId);
            const syncToken = config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"];
            convSyncEngine.connectRemote(
              new HttpConversationSyncAdapter({
                baseUrl: syncUrl,
                motebitId: repl.motebitId,
                authToken: syncToken,
              }),
            );
            const convResult = await convSyncEngine.sync();
            console.log(
              `  Conversations — pushed: ${convResult.conversations_pushed}, pulled: ${convResult.conversations_pulled}`,
            );
            console.log(
              `  Messages — pushed: ${convResult.messages_pushed}, pulled: ${convResult.messages_pulled}`,
            );
            // Plan sync
            console.log("Syncing plans...");
            const planSyncAdapter = new SqlitePlanSyncStoreAdapter(repl.moteDb.planStore, repl.motebitId);
            const planSyncEngine = new PlanSyncEngine(planSyncAdapter, repl.motebitId);
            planSyncEngine.connectRemote(
              new HttpPlanSyncAdapter({
                baseUrl: syncUrl,
                motebitId: repl.motebitId,
                authToken: syncToken,
              }),
            );
            const planResult = await planSyncEngine.sync();
            console.log(
              `  Plans — pushed: ${planResult.plans_pushed}, pulled: ${planResult.plans_pulled}`,
            );
            console.log(
              `  Steps — pushed: ${planResult.steps_pushed}, pulled: ${planResult.steps_pulled}`,
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Sync failed: ${message}`);
          }
        } else {
          console.log("  Sync: skipped (no sync URL)");
        }
      }
      break;
    }

    case "tools": {
      const tools = runtime.getToolRegistry().list();
      if (tools.length === 0) {
        console.log("No tools registered.");
      } else {
        console.log(`\nRegistered tools (${tools.length}):\n`);
        for (const tool of tools) {
          console.log(`  ${tool.name.padEnd(24)} ${tool.description.slice(0, 60)}`);
        }
      }
      break;
    }

    case "conversations": {
      const convList = runtime.listConversations(20);
      if (convList.length === 0) {
        console.log("No conversations found.");
      } else {
        console.log(`\nConversations (${convList.length}):\n`);
        for (const c of convList) {
          const id = c.conversationId.slice(0, 8);
          const ago = formatTimeAgo(Date.now() - c.lastActiveAt);
          const title = c.title ?? "(untitled)";
          console.log(
            `  ${id}  ${ago.padEnd(10)} ${String(c.messageCount).padEnd(4)} msgs  ${title}`,
          );
        }
        console.log("\nLoad a conversation: /conversation <id>");
      }
      break;
    }

    case "conversation": {
      if (args == null || args === "") {
        const convId = runtime.getConversationId();
        if (convId != null && convId !== "") {
          console.log(`Active conversation: ${convId.slice(0, 8)}...`);
        } else {
          console.log("No active conversation. Use /conversations to list past ones.");
        }
        break;
      }
      const convList = runtime.listConversations(100);
      const match = convList.find(
        (c) => c.conversationId === args || c.conversationId.startsWith(args),
      );
      if (!match) {
        console.log(`No conversation found matching "${args}".`);
        break;
      }
      runtime.loadConversation(match.conversationId);
      const history = runtime.getConversationHistory();
      console.log(
        `Loaded conversation ${match.conversationId.slice(0, 8)} (${history.length} messages)`,
      );
      break;
    }

    case "operator":
      console.log(`Operator mode: ${config.operator ? "enabled" : "disabled"}`);
      if (!config.operator) {
        console.log("  Start with --operator to enable write/exec tools");
      }
      break;

    case "goals": {
      if (!repl) {
        console.log("Goals not available in this context.");
        break;
      }
      const goals = repl.moteDb.goalStore.list(repl.motebitId);
      if (goals.length === 0) {
        console.log("No goals scheduled. Use /goal add to create one.");
        break;
      }
      console.log(`\nGoals (${goals.length}):\n`);
      for (const g of goals) {
        const id = g.goal_id.slice(0, 8);
        const interval = formatMs(g.interval_ms);
        const statusIcon =
          g.status === "active"
            ? "+"
            : g.status === "paused"
              ? "~"
              : g.status === "completed"
                ? "*"
                : "!";
        const mode = g.mode === "once" ? " (once)" : "";
        const outcomes = repl.moteDb.goalOutcomeStore.listForGoal(g.goal_id, 1);
        const lastOutcome =
          outcomes.length > 0
            ? ` — last: ${outcomes[0]!.status}${outcomes[0]!.summary != null && outcomes[0]!.summary !== "" ? ` "${outcomes[0]!.summary.slice(0, 30)}"` : ""}`
            : "";
        console.log(
          `  [${statusIcon}] ${id}  "${g.prompt.slice(0, 45)}" every ${interval}${mode}${lastOutcome}`,
        );
      }
      console.log(`\n  + active  ~ paused  * completed  ! failed`);
      break;
    }

    case "goal": {
      if (!repl) {
        console.log("Goals not available in this context.");
        break;
      }
      const parts = args.match(/^(\S+)\s*([\s\S]*)$/) ?? [];
      const goalSub = parts[1] ?? "";
      const goalArgs = (parts[2] ?? "").trim();

      if (goalSub === "add") {
        // Parse: /goal add "prompt" --every 30m [--once]
        const promptMatch =
          goalArgs.match(/^["'](.+?)["']\s*(.*)$/) ?? goalArgs.match(/^(\S+)\s*(.*)$/);
        if (!promptMatch) {
          console.log('Usage: /goal add "check emails" --every 30m [--once]');
          break;
        }
        const prompt = promptMatch[1]!;
        const rest = promptMatch[2] ?? "";
        const everyMatch = rest.match(/--every\s+(\S+)/);
        if (!everyMatch) {
          console.log(
            'Error: --every <interval> is required. E.g. /goal add "check emails" --every 30m',
          );
          break;
        }
        let intervalMs: number;
        try {
          intervalMs = parseInterval(everyMatch[1]!);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`Error: ${msg}`);
          break;
        }
        const once = rest.includes("--once");
        let wallClockMs: number | null = null;
        const wallClockMatch = rest.match(/--wall-clock\s+(\S+)/);
        if (wallClockMatch) {
          try {
            wallClockMs = parseInterval(wallClockMatch[1]!);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`Error parsing --wall-clock: ${msg}`);
            break;
          }
        }
        const projectMatch = rest.match(/--project\s+(\S+)/);
        const projectId = projectMatch ? projectMatch[1]! : null;
        const goalId = crypto.randomUUID();
        repl.moteDb.goalStore.add({
          goal_id: goalId,
          motebit_id: repl.motebitId,
          prompt,
          interval_ms: intervalMs,
          last_run_at: null,
          enabled: true,
          created_at: Date.now(),
          mode: once ? "once" : "recurring",
          status: "active",
          parent_goal_id: null,
          max_retries: 3,
          consecutive_failures: 0,
          wall_clock_ms: wallClockMs,
          project_id: projectId,
        });
        const modeLabel = once ? " (one-shot)" : "";
        const wallClockLabel = wallClockMs != null ? ` (wall-clock: ${wallClockMatch![1]})` : "";
        const projectLabel = projectId != null ? ` [project: ${projectId}]` : "";
        console.log(
          `Goal added: ${goalId.slice(0, 8)} — "${prompt}" every ${everyMatch[1]}${modeLabel}${wallClockLabel}${projectLabel}`,
        );
      } else if (goalSub === "remove") {
        if (!goalArgs) {
          console.log("Usage: /goal remove <goal_id>");
          break;
        }
        const goals = repl.moteDb.goalStore.list(repl.motebitId);
        const match = goals.find((g) => g.goal_id === goalArgs || g.goal_id.startsWith(goalArgs));
        if (!match) {
          console.log(`No goal found matching "${goalArgs}".`);
          break;
        }
        repl.moteDb.goalStore.remove(match.goal_id);
        console.log(`Goal removed: ${match.goal_id.slice(0, 8)}`);
      } else if (goalSub === "pause") {
        if (!goalArgs) {
          console.log("Usage: /goal pause <goal_id>");
          break;
        }
        const goals = repl.moteDb.goalStore.list(repl.motebitId);
        const match = goals.find((g) => g.goal_id === goalArgs || g.goal_id.startsWith(goalArgs));
        if (!match) {
          console.log(`No goal found matching "${goalArgs}".`);
          break;
        }
        repl.moteDb.goalStore.setEnabled(match.goal_id, false);
        console.log(`Goal paused: ${match.goal_id.slice(0, 8)}`);
      } else if (goalSub === "resume") {
        if (!goalArgs) {
          console.log("Usage: /goal resume <goal_id>");
          break;
        }
        const goals = repl.moteDb.goalStore.list(repl.motebitId);
        const match = goals.find((g) => g.goal_id === goalArgs || g.goal_id.startsWith(goalArgs));
        if (!match) {
          console.log(`No goal found matching "${goalArgs}".`);
          break;
        }
        repl.moteDb.goalStore.setEnabled(match.goal_id, true);
        console.log(`Goal resumed: ${match.goal_id.slice(0, 8)}`);
      } else if (goalSub === "outcomes") {
        if (!goalArgs) {
          console.log("Usage: /goal outcomes <goal_id>");
          break;
        }
        const goals = repl.moteDb.goalStore.list(repl.motebitId);
        const match = goals.find((g) => g.goal_id === goalArgs || g.goal_id.startsWith(goalArgs));
        if (!match) {
          console.log(`No goal found matching "${goalArgs}".`);
          break;
        }
        const outcomes = repl.moteDb.goalOutcomeStore.listForGoal(match.goal_id, 10);
        if (outcomes.length === 0) {
          console.log(`No outcomes for goal ${match.goal_id.slice(0, 8)}.`);
          break;
        }
        console.log(`\nOutcomes for ${match.goal_id.slice(0, 8)} (${outcomes.length}):\n`);
        for (const o of outcomes) {
          const ago = formatTimeAgo(Date.now() - o.ran_at);
          const detail =
            o.error_message != null && o.error_message !== ""
              ? `[error: ${o.error_message.slice(0, 40)}]`
              : o.summary != null && o.summary !== ""
                ? `"${o.summary.slice(0, 50)}"`
                : "—";
          console.log(
            `  ${ago.padEnd(10)} ${o.status.padEnd(11)} tools:${o.tool_calls_made} mem:${o.memories_formed}  ${detail}`,
          );
        }
      } else {
        console.log("Usage: /goal [add|remove|pause|resume|outcomes] — or /goals to list");
      }
      break;
    }

    case "approvals": {
      if (!repl) {
        console.log("Approvals not available in this context.");
        break;
      }
      const items = repl.moteDb.approvalStore.listAll(repl.motebitId);
      const pending = items.filter((a) => a.status === "pending");
      if (pending.length === 0) {
        console.log("No pending approvals.");
        if (items.length > 0) {
          console.log(`(${items.length} total — use 'motebit approvals list' for full history)`);
        }
        break;
      }
      console.log(`\nPending approvals (${pending.length}):\n`);
      for (const a of pending) {
        const id = a.approval_id.slice(0, 8);
        const ago = formatTimeAgo(Date.now() - a.created_at);
        const goalId = a.goal_id.slice(0, 8);
        console.log(`  ${id}  ${a.tool_name.padEnd(20)} goal:${goalId}  ${ago}`);
        if (a.args_preview) {
          console.log(`         args: ${a.args_preview.slice(0, 60)}`);
        }
      }
      console.log(`\nApprove/deny via: motebit approvals approve/deny <id>`);
      break;
    }

    case "reflect": {
      try {
        console.log("Reflecting...");
        const reflection: ReflectionResult = await runtime.reflect();

        if (reflection.insights.length > 0) {
          console.log("\nInsights:");
          for (const insight of reflection.insights) {
            console.log(`  - ${insight}`);
          }
        }

        if (reflection.planAdjustments.length > 0) {
          console.log("\nAdjustments:");
          for (const adj of reflection.planAdjustments) {
            console.log(`  - ${adj}`);
          }
        }

        if (reflection.selfAssessment) {
          console.log(`\nSelf-assessment: ${reflection.selfAssessment}`);
        }

        if (reflection.insights.length > 0) {
          console.log(`\n  [${reflection.insights.length} insight(s) stored as memories]`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Reflection failed: ${message}`);
      }
      break;
    }

    case "mcp": {
      if (!fullConfig) {
        console.log("MCP config not available.");
        break;
      }
      const [subCmd, ...subArgs] = args.split(/\s+/);
      const serverName = subArgs.join(" ");

      if (subCmd == null || subCmd === "" || subCmd === "list") {
        const servers = fullConfig.mcp_servers ?? [];
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        if (servers.length === 0) {
          console.log("No MCP servers configured.");
        } else {
          console.log(`\nMCP servers (${servers.length}):\n`);
          for (const s of servers) {
            const isTrusted = trusted.includes(s.name);
            const transport = s.transport ?? "stdio";
            const adapter = repl?.mcpAdapters.find((a) => a.serverName === s.name);
            const connected = adapter?.isConnected ? "connected" : "disconnected";
            const motebitStatus = adapter?.isMotebit
              ? adapter.verifiedIdentity?.verified
                ? " motebit:verified"
                : " motebit:unverified"
              : "";
            console.log(
              `  ${s.name.padEnd(20)} ${transport.padEnd(6)} ${(isTrusted ? "trusted" : "untrusted").padEnd(10)} ${connected}${motebitStatus}`,
            );
          }
        }
      } else if (subCmd === "add") {
        if (!repl) {
          console.log("REPL context not available.");
          break;
        }
        // Parse: /mcp add <name> <url> [--motebit]
        const addArgs = subArgs;
        const motebitFlag = addArgs.includes("--motebit");
        const filtered = addArgs.filter((a) => a !== "--motebit");
        const addName = filtered[0];
        const addUrl = filtered[1];
        if (!addName || !addUrl) {
          console.log("Usage: /mcp add <name> <url> [--motebit]");
          break;
        }
        const existing = (fullConfig.mcp_servers ?? []).find((s) => s.name === addName);
        if (existing) {
          console.log(`Server "${addName}" already configured. Use /mcp remove first.`);
          break;
        }
        const serverCfg: McpServerConfig = {
          name: addName,
          transport: "http",
          url: addUrl,
          ...(motebitFlag ? { motebit: true } : {}),
          ...(motebitFlag && repl.privateKeyBytes && repl.deviceId
            ? {
                callerMotebitId: repl.motebitId,
                callerDeviceId: repl.deviceId,
                callerPrivateKey: repl.privateKeyBytes,
              }
            : {}),
        };
        const adapter = new McpClientAdapter(serverCfg);
        try {
          await adapter.connect();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`Failed to connect to "${addName}": ${message}`);
          break;
        }
        // Pin manifest hash, register tools -- cleanup adapter on failure
        let manifest: Awaited<ReturnType<typeof adapter.checkManifest>>;
        try {
          manifest = await adapter.checkManifest();
          const tmpRegistry = new InMemoryToolRegistry();
          adapter.registerInto(tmpRegistry);
          runtime.registerExternalTools(`mcp:${addName}`, tmpRegistry);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            await adapter.disconnect();
          } catch {
            /* best effort */
          }
          console.log(`Failed to register tools from "${addName}": ${message}`);
          break;
        }
        // Track adapter
        repl.mcpAdapters.push(adapter);
        // Persist to config (without transient fields like callerPrivateKey)
        const persistCfg: McpServerConfig = {
          name: addName,
          transport: "http",
          url: addUrl,
          ...(motebitFlag ? { motebit: true } : {}),
        };
        if (adapter.verifiedIdentity?.verified && adapter.serverConfig.motebitPublicKey) {
          persistCfg.motebitPublicKey = adapter.serverConfig.motebitPublicKey;
        }
        fullConfig.mcp_servers = [...(fullConfig.mcp_servers ?? []), persistCfg];
        saveFullConfig(fullConfig);
        // Output
        const verifiedStr = adapter.verifiedIdentity?.verified
          ? ` (motebit: ${adapter.verifiedIdentity.motebit_id?.slice(0, 12)}... verified)`
          : "";
        console.log(`Added "${addName}" — ${manifest.toolCount} tool(s)${verifiedStr}`);
      } else if (subCmd === "remove") {
        if (!repl) {
          console.log("REPL context not available.");
          break;
        }
        const removeName = subArgs[0];
        if (!removeName) {
          console.log("Usage: /mcp remove <name>");
          break;
        }
        // Disconnect adapter if connected
        const adapterIdx = repl.mcpAdapters.findIndex((a) => a.serverName === removeName);
        if (adapterIdx >= 0) {
          const removedAdapter = repl.mcpAdapters[adapterIdx];
          if (removedAdapter) {
            try {
              await removedAdapter.disconnect();
            } catch {
              /* best effort */
            }
          }
          repl.mcpAdapters.splice(adapterIdx, 1);
        }
        // Unregister tools from runtime
        runtime.unregisterExternalTools(`mcp:${removeName}`);
        // Remove from config
        fullConfig.mcp_servers = (fullConfig.mcp_servers ?? []).filter(
          (s) => s.name !== removeName,
        );
        fullConfig.mcp_trusted_servers = (fullConfig.mcp_trusted_servers ?? []).filter(
          (n) => n !== removeName,
        );
        saveFullConfig(fullConfig);
        console.log(`Removed "${removeName}".`);
      } else if (subCmd === "trust") {
        if (!serverName) {
          console.log("Usage: /mcp trust <server-name>");
          break;
        }
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        if (!trusted.includes(serverName)) {
          fullConfig.mcp_trusted_servers = [...trusted, serverName];
          saveFullConfig(fullConfig);
        }
        console.log(`Marked "${serverName}" as trusted. Restart to apply.`);
      } else if (subCmd === "untrust") {
        if (!serverName) {
          console.log("Usage: /mcp untrust <server-name>");
          break;
        }
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        fullConfig.mcp_trusted_servers = trusted.filter((n) => n !== serverName);
        saveFullConfig(fullConfig);
        console.log(`Marked "${serverName}" as untrusted. Restart to apply.`);
      } else {
        console.log(
          "Usage: /mcp [list|add <name> <url>|remove <name>|trust <name>|untrust <name>]",
        );
      }
      break;
    }

    case "discover": {
      const discoverArg = args.trim();

      // Domain-based discovery: argument contains a dot -> DNS/well-known lookup
      if (discoverArg && discoverArg.includes(".")) {
        try {
          const { discoverMotebit } = await import("@motebit/mcp-client");
          const result = await discoverMotebit(discoverArg);
          if (result.identityVerified) {
            console.log(`\nFound motebit at ${result.domain}:`);
            if (result.motebitId) console.log(`  ID: ${result.motebitId}`);
            if (result.motebitType) console.log(`  Type: ${result.motebitType}`);
            if (result.serviceName) console.log(`  Name: ${result.serviceName}`);
            if (result.endpointUrl) console.log(`  Endpoint: ${result.endpointUrl}`);
            console.log(`  Identity: verified \u2713`);
            console.log(`\nUse /mcp add ${result.domain} to connect.`);
          } else {
            console.log(`No motebit found at ${discoverArg}: ${result.error ?? "unknown error"}`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`Discovery error: ${message}`);
        }
        break;
      }

      // Relay-based discovery: no argument or capability filter
      const syncUrl = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"];
      if (!syncUrl) {
        console.log("No sync URL configured. Set --sync-url or MOTEBIT_SYNC_URL.");
        break;
      }
      try {
        const capParam = discoverArg || undefined;
        const queryStr = capParam ? `?capability=${encodeURIComponent(capParam)}` : "";
        const token = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const resp = await fetch(`${syncUrl}/api/v1/agents/discover${queryStr}`, { headers });
        if (!resp.ok) {
          console.log(`Discovery failed: ${resp.status} ${resp.statusText}`);
          break;
        }
        const data = (await resp.json()) as {
          agents: Array<{
            motebit_id: string;
            endpoint_url: string;
            capabilities: string[];
            public_key: string;
          }>;
        };
        if (data.agents.length === 0) {
          console.log(
            capParam ? `No agents found with capability "${capParam}".` : "No agents registered.",
          );
        } else {
          console.log(`\nDiscovered agents (${data.agents.length}):\n`);
          for (const agent of data.agents) {
            const caps =
              agent.capabilities.length > 0 ? agent.capabilities.slice(0, 5).join(", ") : "none";
            console.log(
              `  ${agent.motebit_id.slice(0, 12).padEnd(14)} ${agent.endpoint_url.padEnd(30)} [${caps}]`,
            );
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Discovery error: ${message}`);
      }
      break;
    }

    case "agents": {
      const records = await runtime.listTrustedAgents();
      if (!args || args === "") {
        // /agents — list all
        if (records.length === 0) {
          console.log("No known agents. Interact with an MCP agent to see trust records.");
          break;
        }
        console.log(`\nKnown agents (${records.length}):\n`);
        for (const r of records) {
          const rep = computeReputationScore(r);
          const successful = r.successful_tasks ?? 0;
          const failed = r.failed_tasks ?? 0;
          const totalTasks = successful + failed;
          const taskStr = totalTasks > 0 ? `tasks:${successful}/${totalTasks}` : "tasks:0";
          const ago = formatTimeAgo(Date.now() - r.last_seen_at);
          const levelColor =
            r.trust_level === AgentTrustLevel.Trusted
              ? "\x1b[32m"   // green
              : r.trust_level === AgentTrustLevel.Verified
                ? "\x1b[33m" // yellow
                : r.trust_level === AgentTrustLevel.Blocked
                  ? "\x1b[31m" // red
                  : "\x1b[2m"; // dim
          const reset = "\x1b[0m";
          console.log(
            `  ${r.remote_motebit_id.slice(0, 12)}  ${levelColor}${r.trust_level.padEnd(13)}${reset} rep:${rep.toFixed(2)}  ${taskStr.padEnd(12)} interactions:${r.interaction_count}  last seen ${ago}`,
          );
        }
      } else {
        const parts = args.match(/^(\S+)\s*([\s\S]*)$/) ?? [];
        const agentSub = parts[1] ?? "";
        const agentArgs = (parts[2] ?? "").trim();

        if (agentSub === "info") {
          if (!agentArgs) {
            console.log("Usage: /agents info <id>");
            break;
          }
          const match = records.find(
            (r) => r.remote_motebit_id === agentArgs || r.remote_motebit_id.startsWith(agentArgs),
          );
          if (!match) {
            console.log(`No agent found matching "${agentArgs}".`);
            break;
          }
          const rep = computeReputationScore(match);
          const successful = match.successful_tasks ?? 0;
          const failed = match.failed_tasks ?? 0;
          console.log(`\nAgent: ${match.remote_motebit_id}`);
          console.log(`  Trust level:      ${match.trust_level}`);
          console.log(`  Reputation:       ${rep.toFixed(4)}`);
          console.log(`  Interactions:     ${match.interaction_count}`);
          console.log(`  Tasks succeeded:  ${successful}`);
          console.log(`  Tasks failed:     ${failed}`);
          console.log(`  First seen:       ${new Date(match.first_seen_at).toISOString()}`);
          console.log(`  Last seen:        ${new Date(match.last_seen_at).toISOString()}`);
          if (match.public_key) {
            console.log(`  Public key:       ${match.public_key.slice(0, 16)}...`);
          }
          if (match.notes) {
            console.log(`  Notes:            ${match.notes}`);
          }
        } else if (agentSub === "trust") {
          const trustParts = agentArgs.split(/\s+/);
          const trustId = trustParts[0];
          const trustLevel = trustParts[1];
          if (!trustId || !trustLevel) {
            console.log("Usage: /agents trust <id> <first_contact|verified|trusted|blocked>");
            break;
          }
          const validLevels = Object.values(AgentTrustLevel);
          if (!validLevels.includes(trustLevel as AgentTrustLevel)) {
            console.log(`Invalid trust level. Valid: ${validLevels.join(", ")}`);
            break;
          }
          const match = records.find(
            (r) => r.remote_motebit_id === trustId || r.remote_motebit_id.startsWith(trustId),
          );
          if (!match) {
            console.log(`No agent found matching "${trustId}".`);
            break;
          }
          await runtime.setAgentTrustLevel(match.remote_motebit_id, trustLevel as AgentTrustLevel);
          console.log(`Trust level for ${match.remote_motebit_id.slice(0, 12)} set to: ${trustLevel}`);
        } else if (agentSub === "block") {
          if (!agentArgs) {
            console.log("Usage: /agents block <id>");
            break;
          }
          const match = records.find(
            (r) => r.remote_motebit_id === agentArgs || r.remote_motebit_id.startsWith(agentArgs),
          );
          if (!match) {
            console.log(`No agent found matching "${agentArgs}".`);
            break;
          }
          await runtime.setAgentTrustLevel(match.remote_motebit_id, AgentTrustLevel.Blocked);
          console.log(`Agent ${match.remote_motebit_id.slice(0, 12)} blocked.`);
        } else {
          // Treat as /agents info <id> for convenience
          const match = records.find(
            (r) => r.remote_motebit_id === agentSub || r.remote_motebit_id.startsWith(agentSub),
          );
          if (match) {
            const rep = computeReputationScore(match);
            const successful = match.successful_tasks ?? 0;
            const failed = match.failed_tasks ?? 0;
            console.log(`\nAgent: ${match.remote_motebit_id}`);
            console.log(`  Trust level:      ${match.trust_level}`);
            console.log(`  Reputation:       ${rep.toFixed(4)}`);
            console.log(`  Interactions:     ${match.interaction_count}`);
            console.log(`  Tasks succeeded:  ${successful}`);
            console.log(`  Tasks failed:     ${failed}`);
            console.log(`  First seen:       ${new Date(match.first_seen_at).toISOString()}`);
            console.log(`  Last seen:        ${new Date(match.last_seen_at).toISOString()}`);
          } else {
            console.log("Usage: /agents [info <id>|trust <id> <level>|block <id>]");
          }
        }
      }
      break;
    }

    case "curious": {
      const targets = runtime.getCuriosityTargets();
      if (targets.length === 0) {
        console.log("No curiosity targets — all memories are healthy or too far gone.");
        break;
      }
      const MS_PER_DAY = 86_400_000;
      console.log(`\nCuriosity targets (${targets.length}):\n`);
      for (const t of targets) {
        const ageDays = Math.round((Date.now() - t.node.created_at) / MS_PER_DAY);
        const halfDays = Math.round(t.node.half_life / MS_PER_DAY);
        console.log(
          `  ${t.node.node_id.slice(0, 8)}  score=${t.curiosityScore.toFixed(3)}  conf=${t.node.confidence.toFixed(2)}\u2192${t.decayedConfidence.toFixed(2)}  loss=${t.confidenceLoss.toFixed(2)}  stale=${t.staleness.toFixed(1)}x  age=${ageDays}d  half=${halfDays}d`,
        );
        console.log(`             ${t.node.content}`);
      }
      console.log("\nThese memories are fading. Confirm or update them to reinforce.");
      break;
    }

    default:
      console.log(`Unknown command: /${cmd}. Type /help for available commands.`);
  }
}
