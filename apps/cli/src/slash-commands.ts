// --- REPL slash command handler ---

import type { MotebitRuntime, ReflectionResult, RelayConfig } from "@motebit/runtime";
import { executeCommand } from "@motebit/runtime";
import { narrateEconomicConsequences } from "@motebit/gradient";
import { computeDecayedConfidence } from "@motebit/memory-graph";
import type { MotebitDatabase } from "@motebit/persistence";
import { McpClientAdapter, type McpServerConfig } from "@motebit/mcp-client";
import { InMemoryToolRegistry } from "@motebit/tools";
import { AgentTrustLevel, SensitivityLevel } from "@motebit/sdk";
import type { ExecutionReceipt } from "@motebit/sdk";
import { computeReputationScore } from "@motebit/policy";
import { createSignedToken, verifyExecutionReceipt, hexToBytes } from "@motebit/crypto";
import { McpServerAdapter, wireServerDeps } from "@motebit/mcp-server";
import type { McpServerConfig as McpServerAdapterConfig } from "@motebit/mcp-server";
import { type CliConfig, COMMANDS } from "./args.js";
import type { FullConfig } from "./config.js";
import { saveFullConfig } from "./config.js";
import { formatMs, formatTimeAgo } from "./utils.js";
import { green, yellow, red, dim, cyan, command, success } from "./colors.js";
import {
  SqliteConversationSyncStoreAdapter,
  SqlitePlanSyncStoreAdapter,
} from "./runtime-factory.js";
import {
  ConversationSyncEngine,
  HttpConversationSyncAdapter,
  EncryptedConversationSyncAdapter,
  PlanSyncEngine,
  HttpPlanSyncAdapter,
} from "@motebit/sync-engine";
import { deriveSyncEncryptionKey } from "@motebit/crypto";
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

// Tools excluded from network exposure when /serve is active.
// Internal tools have synthetic counterparts for remote callers:
//   delegate_to_agent → motebit_task (prevents open relay — remote callers go through agentic loop)
//   recall_memories   → motebit_recall (privacy-filtered, sensitivity-capped)
//   list_events       → no remote equivalent needed (event history is internal)
//   read_file         → no remote equivalent (filesystem access)
const LOCAL_ONLY_TOOLS = new Set([
  "read_file",
  "delegate_to_agent",
  "recall_memories",
  "list_events",
  "self_reflect",
]);
let isServing = false;

/** Resolve the relay sync URL from config, env, or saved config. */
function getRelaySyncUrl(
  config: CliConfig,
  fullConfig?: FullConfig,
  fallback?: string,
): string | undefined {
  return config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"] ?? fullConfig?.sync_url ?? fallback;
}

/** Get an auth token for relay API calls — prefers master token, falls back to signed device token. */
async function getRelayToken(
  config: CliConfig,
  repl?: ReplContext,
  aud = "admin:query",
): Promise<string | undefined> {
  const master =
    config.syncToken ?? process.env["MOTEBIT_API_TOKEN"] ?? process.env["MOTEBIT_SYNC_TOKEN"];
  if (master) return master;
  if (repl?.privateKeyBytes && repl?.deviceId) {
    const now = Date.now();
    return createSignedToken(
      {
        mid: repl.motebitId,
        did: repl.deviceId,
        iat: now,
        exp: now + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud,
      },
      repl.privateKeyBytes,
    );
  }
  return undefined;
}

/** Build relay request headers with auth. Optional content-type for POST/PUT. */
async function makeRelayHeaders(
  config: CliConfig,
  repl?: ReplContext,
  opts?: { aud?: string; json?: boolean },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (opts?.json) headers["Content-Type"] = "application/json";
  const token = await getRelayToken(config, repl, opts?.aud);
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** Parse subcommand from args string: "/goal add foo" → { sub: "add", rest: "foo" } */
function parseSub(args: string): { sub: string; rest: string } {
  const m = args.match(/^(\S+)\s*([\s\S]*)$/);
  return m ? { sub: m[1]!, rest: (m[2] ?? "").trim() } : { sub: "", rest: "" };
}

type RelayResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; text: string };

/** Fetch from relay with standardized error handling. Strips trailing slashes from baseUrl. */
async function relayFetch<T>(
  baseUrl: string,
  path: string,
  opts?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<RelayResult<T>> {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const init: RequestInit = { headers: opts?.headers };
  if (opts?.method) init.method = opts.method;
  if (opts?.body != null) init.body = JSON.stringify(opts.body);
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, text: text.slice(0, 200) };
  }
  const data = (await resp.json()) as T;
  return { ok: true, data, status: resp.status };
}

/** Style a usage pattern: command portion in cyan, args in plain text. */
function styleUsage(usage: string): string {
  // Split on first space-followed-by-arg-or-end-of-command-word
  // Commands: /help, /goal add, /mcp list, /agents trust, etc.
  // We color the command tokens (words starting with /) and subcommand words,
  // leave <args>, [opts], "--flags", and quoted strings unstyled.
  return usage.replace(
    /^(\/\S+(?:\s+(?:add|remove|pause|resume|outcomes|list|trust|untrust|block|info))?)(.*)/,
    (_: string, cmd: string, rest: string) => command(cmd) + rest,
  );
}

/** Render the help listing from the command registry. */
function printHelp(): void {
  const col = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2;
  console.log("\nAvailable commands:");
  for (const { usage, desc } of COMMANDS) {
    const gap = " ".repeat(Math.max(1, col - usage.length));
    console.log(`  ${styleUsage(usage)}${gap}${dim(desc)}`);
  }
  console.log(
    `  ${dim("quit, exit")}${" ".repeat(Math.max(1, col - "quit, exit".length))}${dim("Exit")}\n`,
  );
}

/** Build RelayConfig from CLI context for shared command layer. */
async function buildRelayConfig(
  config: CliConfig,
  fullConfig?: FullConfig,
  repl?: ReplContext,
): Promise<RelayConfig | undefined> {
  const relayUrl = getRelaySyncUrl(config, fullConfig);
  if (!relayUrl) return undefined;
  const token = await getRelayToken(config, repl);
  if (!token) return undefined;
  const motebitId = repl?.motebitId ?? "";
  if (!motebitId) return undefined;
  return { relayUrl, authToken: token, motebitId };
}

/**
 * Try executing a command via the shared layer. Returns true if handled.
 * The shared layer handles: state, model (read-only), tools, memories, graph,
 * curious, forget, audit, gradient, reflect, summarize, approvals, conversations,
 * balance, deposits, discover, proposals, withdraw, delegate, propose.
 */
async function trySharedCommand(
  runtime: MotebitRuntime,
  cmd: string,
  args: string,
  config: CliConfig,
  fullConfig?: FullConfig,
  repl?: ReplContext,
): Promise<boolean> {
  const relay = await buildRelayConfig(config, fullConfig, repl);
  const result = await executeCommand(runtime, cmd, args || undefined, relay);
  if (!result) return false;

  // CLI rendering: summary always shown, detail indented below
  console.log(result.summary);
  if (result.detail) {
    for (const line of result.detail.split("\n")) {
      console.log(`  ${line}`);
    }
  }
  return true;
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
    case "help": {
      printHelp();
      break;
    }

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

        const now = Date.now();
        const live = data.nodes.filter(
          (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now),
        );
        console.log(`\nMemories (${live.length} nodes, ${data.edges.length} edges):\n`);
        for (const node of live) {
          const halfDays = Math.round(node.half_life / MS_PER_DAY);
          const defaultDays = 30;
          const compounded = halfDays > defaultDays;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- MemoryType string enum
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
      const now = Date.now();
      const live = graphData.nodes.filter(
        (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now),
      );
      const liveIds = new Set(live.map((n) => n.node_id));
      const liveEdges = graphData.edges.filter(
        (e) => liveIds.has(e.source_id) || liveIds.has(e.target_id),
      );

      if (live.length === 0) {
        console.log("No memories in graph.");
        break;
      }

      const DAY = 86_400_000;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- MemoryType string enum
      const sem = live.filter((n) => (n.memory_type ?? "semantic") === "semantic").length;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- MemoryType string enum
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
      console.log(
        `  Nodes:      ${live.length} (${sem} semantic, ${epi} episodic, ${pinned} pinned)`,
      );
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
      console.log(
        `  Density:    ${live.length > 0 ? (liveEdges.length / live.length).toFixed(2) : "0"} edges/node`,
      );

      const curiosityTargets = runtime.getCuriosityTargets();
      if (curiosityTargets.length > 0) {
        const topScore = curiosityTargets[0]!.curiosityScore.toFixed(3);
        console.log(
          `  Curious:    ${curiosityTargets.length} memories fading (top score: ${topScore})`,
        );
      }

      const gradient = runtime.getGradient();
      if (gradient) {
        const delta =
          gradient.delta >= 0 ? `+${gradient.delta.toFixed(4)}` : gradient.delta.toFixed(4);
        console.log(`\n  Gradient:   ${gradient.gradient.toFixed(4)} (${delta})`);

        // Self-model narrative
        const selfModel = runtime.getGradientSummary();
        if (selfModel.snapshotCount > 0) {
          console.log(`\n  ${selfModel.trajectory}`);
          console.log(`  ${selfModel.overall}`);
          if (selfModel.strengths.length > 0)
            console.log(`  Strengths: ${selfModel.strengths.join("; ")}`);
          if (selfModel.weaknesses.length > 0)
            console.log(`  Weaknesses: ${selfModel.weaknesses.join("; ")}`);
          console.log(`  Posture: ${selfModel.posture}`);
        }

        // Economic consequences (only when struggling)
        const econ = narrateEconomicConsequences(gradient);
        if (econ.length > 0) {
          console.log("\n  Economic position:");
          for (const c of econ) console.log(`    - ${c}`);
        }
      }

      // Cached reflection summary
      const lastReflection = runtime.getLastReflection();
      if (lastReflection?.selfAssessment) {
        console.log(`\n  Last reflection: ${lastReflection.selfAssessment}`);
      }
      break;
    }

    case "state": {
      const state = runtime.getState();
      console.log("\nState vector:\n" + formatState(state as unknown as Record<string, unknown>));
      break;
    }

    case "audit": {
      const auditResult = await runtime.auditMemory();
      console.log(`\nMemory audit (${auditResult.nodesAudited} nodes scanned)\n`);

      if (auditResult.phantomCertainties.length > 0) {
        console.log(`Phantom certainties (${auditResult.phantomCertainties.length}):`);
        for (const p of auditResult.phantomCertainties) {
          const label =
            p.node.content.length > 70 ? p.node.content.slice(0, 70) + "..." : p.node.content;
          console.log(`  conf=${p.decayedConfidence.toFixed(2)} edges=${p.edgeCount}  ${label}`);
        }
      }

      if (auditResult.conflicts.length > 0) {
        console.log(`\nConflicts (${auditResult.conflicts.length}):`);
        for (const c of auditResult.conflicts) {
          const aLabel = c.a.content.length > 40 ? c.a.content.slice(0, 40) + "..." : c.a.content;
          const bLabel = c.b.content.length > 40 ? c.b.content.slice(0, 40) + "..." : c.b.content;
          console.log(`  "${aLabel}" vs "${bLabel}"`);
        }
      }

      if (auditResult.nearDeath.length > 0) {
        console.log(`\nNear-death (${auditResult.nearDeath.length}):`);
        for (const nd of auditResult.nearDeath) {
          const label =
            nd.node.content.length > 70 ? nd.node.content.slice(0, 70) + "..." : nd.node.content;
          console.log(`  conf=${nd.decayedConfidence.toFixed(3)}  ${label}`);
        }
      }

      if (
        auditResult.phantomCertainties.length === 0 &&
        auditResult.conflicts.length === 0 &&
        auditResult.nearDeath.length === 0
      ) {
        console.log("No integrity issues found.");
      }
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
      // Filter out sensitive memories (medical/financial/secret) — only None and Personal are display_allowed
      const displayAllowed = new Set<string>([SensitivityLevel.None, SensitivityLevel.Personal]);
      const totalCount = memories.nodes.length;
      const filteredNodes = memories.nodes.filter((n) => displayAllowed.has(n.sensitivity));
      const redactedCount = totalCount - filteredNodes.length;
      const exportData = { memories: { nodes: filteredNodes, edges: memories.edges }, state };
      console.log(JSON.stringify(exportData, null, 2));
      if (redactedCount > 0) {
        console.error(
          `\n(${redactedCount} sensitive ${redactedCount === 1 ? "memory" : "memories"} redacted from export)`,
        );
      }
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
      // Known models with short aliases
      const MODEL_ALIASES: Record<string, string> = {
        opus: "claude-opus-4-6-20250414",
        sonnet: "claude-sonnet-4-5-latest",
        haiku: "claude-haiku-4-5-20251001",
        "gpt-4o": "gpt-4o",
        "gpt-4": "gpt-4",
        o3: "o3",
        "llama3.2": "llama3.2",
        mistral: "mistral",
      };

      const showModelList = (current: string) => {
        const col = Math.max(...Object.keys(MODEL_ALIASES).map((k) => k.length)) + 2;
        for (const [alias, modelId] of Object.entries(MODEL_ALIASES)) {
          const active = modelId === current || alias === current;
          const marker = active ? green(" ●") : "  ";
          const gap = " ".repeat(Math.max(1, col - alias.length));
          console.log(`${marker} ${cyan(alias)}${gap}${dim(modelId)}`);
        }
      };

      if (!args) {
        const current = runtime.currentModel ?? "unknown";
        console.log(`\nCurrent model: ${cyan(current)}\n`);
        showModelList(current);
        console.log(dim(`\n  /model <name> to switch\n`));
        break;
      }
      const input = args.toLowerCase();
      const resolved = MODEL_ALIASES[input];
      const isFullId = Object.values(MODEL_ALIASES).includes(args);
      if (!resolved && !isFullId) {
        console.log(`\nUnknown model: ${cyan(args)}\n`);
        showModelList(runtime.currentModel ?? "");
        console.log(dim(`\n  /model <name> to switch\n`));
        break;
      }
      const modelId = resolved ?? args;
      runtime.setModel(modelId);
      if (fullConfig) {
        fullConfig.default_model = modelId;
        saveFullConfig(fullConfig);
      }
      console.log();
      showModelList(modelId);
      console.log();
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
        const syncUrl = getRelaySyncUrl(config, fullConfig);
        if (syncUrl != null && syncUrl !== "") {
          try {
            console.log("Syncing conversations...");
            const convStoreAdapter = new SqliteConversationSyncStoreAdapter(
              repl.moteDb.conversationStore,
            );
            const convSyncEngine = new ConversationSyncEngine(convStoreAdapter, repl.motebitId);
            const syncToken = await getRelayToken(config, repl, "sync");
            const httpConvAdapter = new HttpConversationSyncAdapter({
              baseUrl: syncUrl,
              motebitId: repl.motebitId,
              authToken: syncToken,
            });
            // Encrypt conversations — relay stores opaque ciphertext
            const encKey = repl.privateKeyBytes
              ? await deriveSyncEncryptionKey(repl.privateKeyBytes)
              : null;
            convSyncEngine.connectRemote(
              encKey
                ? new EncryptedConversationSyncAdapter({ inner: httpConvAdapter, key: encKey })
                : httpConvAdapter,
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
            const planSyncAdapter = new SqlitePlanSyncStoreAdapter(
              repl.moteDb.planStore,
              repl.motebitId,
            );
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

    case "connect": {
      // /connect <url> — connect to a relay from inside the REPL
      if (!args) {
        console.log("Usage: /connect <relay-url>");
        console.log("  Example: /connect https://motebit-sync.fly.dev");
        break;
      }
      if (!repl?.privateKeyBytes || !repl?.deviceId) {
        console.log("Error: no signing keys available — cannot authenticate with relay.");
        break;
      }

      const connectUrl = args.trim().replace(/\/+$/, ""); // strip trailing slashes
      console.log(dim(`Connecting to ${connectUrl}...`));

      // 1. Register device with relay (bootstrap)
      try {
        const resp = await fetch(`${connectUrl}/api/v1/agents/bootstrap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            motebit_id: repl.motebitId,
            device_id: repl.deviceId,
            public_key: fullConfig?.device_public_key,
          }),
        });
        if (!resp.ok && resp.status !== 409) {
          const body = await resp.text();
          console.log(`  Registration failed: ${resp.status} ${body}`);
          break;
        }
        console.log(success("  Registered with relay."));
      } catch (err: unknown) {
        console.log(`  Cannot reach relay: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }

      // 2. Enable interactive delegation
      const pk = repl.privateKeyBytes;
      const did = repl.deviceId;
      const mid = repl.motebitId;
      runtime.enableInteractiveDelegation({
        syncUrl: connectUrl,
        authToken: async (audience = "task:submit") => {
          const now = Date.now();
          return createSignedToken(
            {
              mid,
              did,
              iat: now,
              exp: now + 5 * 60 * 1000,
              jti: crypto.randomUUID(),
              aud: audience,
            },
            pk,
          );
        },
        routingStrategy: config.routingStrategy,
      });
      console.log(success("  Interactive delegation enabled."));

      // 3. Discover agents
      try {
        const headers = await makeRelayHeaders(config, repl);
        const resp = await fetch(`${connectUrl}/api/v1/agents/discover`, { headers });
        if (resp.ok) {
          const data = (await resp.json()) as {
            agents: Array<{ motebit_id: string; capabilities: string[] }>;
          };
          const others = data.agents.filter(
            (a) => a.motebit_id !== repl.motebitId && a.capabilities.length > 0,
          );
          for (const agent of others) {
            await runtime.registerServiceListing({
              motebit_id: agent.motebit_id,
              capabilities: agent.capabilities,
              pricing: [],
              sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
              description: agent.capabilities.join(", "),
            });
          }
          console.log(
            success(`  Discovered ${others.length} agent${others.length === 1 ? "" : "s"}.`),
          );
        }
      } catch {
        console.log("  Agent discovery skipped (relay may not support it).");
      }

      // 4. Save to config for next launch
      if (fullConfig) {
        fullConfig.sync_url = connectUrl;
        saveFullConfig(fullConfig);
        console.log("  Saved relay URL to config.");
      }

      console.log(green(`  Connected to ${connectUrl}`));
      break;
    }

    case "serve": {
      // /serve [port] — start MCP HTTP server on the running runtime
      const port = args ? parseInt(args, 10) : 3100;
      if (isNaN(port)) {
        console.log("Usage: /serve [port]  (default: 3100)");
        break;
      }
      if (!repl?.privateKeyBytes || !repl?.deviceId) {
        console.log("Error: no signing keys — cannot serve without identity.");
        break;
      }

      const pk = repl.privateKeyBytes;
      const did = repl.deviceId;
      const mid = repl.motebitId;
      const pubHex = fullConfig?.device_public_key;

      // Build MCP server deps from the existing runtime using wireServerDeps
      const serveDeps = wireServerDeps(runtime as Parameters<typeof wireServerDeps>[0], {
        motebitId: mid,
        publicKeyHex: pubHex,
      });

      // Security: exclude local-only tools from network exposure.
      // read_file gives filesystem access — safe for local REPL, dangerous for remote callers.
      const origListTools = serveDeps.listTools.bind(serveDeps);
      serveDeps.listTools = () => origListTools().filter((t) => !LOCAL_ONLY_TOOLS.has(t.name));
      const origFilterTools = serveDeps.filterTools.bind(serveDeps);
      serveDeps.filterTools = (tools) =>
        origFilterTools(tools.filter((t) => !LOCAL_ONLY_TOOLS.has(t.name)));

      // Wire handleAgentTask so the server can execute full agentic tasks
      serveDeps.handleAgentTask = async function* (prompt, options) {
        const task = {
          task_id: crypto.randomUUID(),
          motebit_id: mid,
          prompt,
          submitted_at: Date.now(),
          submitted_by: "mcp_client",
          status: "running" as const,
        };
        if (options?.relayTaskId) {
          (task as Record<string, unknown>).relay_task_id = options.relayTaskId;
        }
        for await (const chunk of runtime.handleAgentTask(
          task as Parameters<typeof runtime.handleAgentTask>[0],
          pk,
          did,
        )) {
          yield chunk;
        }
      };

      try {
        const serverConfig: McpServerAdapterConfig = {
          name: `motebit-${mid.slice(0, 8)}`,
          transport: "http",
          port,
        };
        const mcpServer = new McpServerAdapter(serverConfig, serveDeps);
        await mcpServer.start();
        isServing = true;

        const exposedTools = serveDeps.listTools();
        console.log(success(`  MCP server running on http://localhost:${port}`));
        console.log(dim(`  ${exposedTools.length} tools exposed. Accepting incoming delegations.`));

        // Register with relay if connected
        const syncUrl = getRelaySyncUrl(config, fullConfig);
        if (syncUrl && pubHex) {
          try {
            const headers = await makeRelayHeaders(config, repl, { json: true });
            // Try to extract guardian key from identity file for org trust baseline
            let guardianPubKey: string | undefined;
            try {
              const { parse } = await import("@motebit/identity-file");
              const fs = await import("node:fs");
              const idPath = config.identity ?? "motebit.md";
              const content = fs.readFileSync(idPath, "utf-8");
              guardianPubKey = parse(content).frontmatter.guardian?.public_key;
            } catch {
              // Identity file unavailable — no guardian key, acceptable
            }
            const serveRegBody: Record<string, unknown> = {
              motebit_id: mid,
              endpoint_url: `http://localhost:${port}`,
              public_key: pubHex,
              capabilities: exposedTools.map((t) => t.name),
            };
            if (guardianPubKey) {
              serveRegBody.guardian_public_key = guardianPubKey;
            }
            await fetch(`${syncUrl}/api/v1/agents/register`, {
              method: "POST",
              headers,
              body: JSON.stringify(serveRegBody),
            });
            console.log(success("  Registered as service agent on relay."));
          } catch {
            console.log("  Relay registration skipped (relay unreachable).");
          }
        }
      } catch (err: unknown) {
        console.log(`  Error starting server: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "tools": {
      const tools = runtime.getToolRegistry().list();
      if (tools.length === 0) {
        console.log("No tools registered.");
      } else {
        // Short human descriptions for built-in tools
        const shortDesc: Record<string, string> = {
          read_file: "Read a local file",
          web_search: "Search the web",
          read_url: "Fetch content from a URL",
          recall_memories: "Search memory graph",
          list_events: "Query recent activity",
          create_sub_goal: "Create a child sub-goal",
          complete_goal: "Mark goal as completed",
          report_progress: "Log a progress observation",
          delegate_to_agent: "Delegate a task to a remote agent",
        };
        const networkCount = tools.filter((t) => !LOCAL_ONLY_TOOLS.has(t.name)).length;
        const label = isServing
          ? `\nRegistered tools (${tools.length}, ${networkCount} network-exposed):\n`
          : `\nRegistered tools (${tools.length}):\n`;
        console.log(label);
        const col = Math.max(...tools.map((t) => t.name.length)) + 2;
        for (const tool of tools) {
          const local = LOCAL_ONLY_TOOLS.has(tool.name);
          const marker = isServing
            ? local
              ? dim("\u25CB [local]   ")
              : green("\u25CF [network] ")
            : "  ";
          const gap = " ".repeat(Math.max(1, col - tool.name.length));
          const desc = shortDesc[tool.name] ?? tool.description.split(".")[0] ?? tool.description;
          console.log(`${marker}${cyan(tool.name)}${gap}${dim(desc)}`);
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
      const { sub: goalSub, rest: goalArgs } = parseSub(args);

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

        if (reflection.patterns.length > 0) {
          console.log("\nRecurring patterns:");
          for (const pattern of reflection.patterns) {
            console.log(`  - ${pattern}`);
          }
        }

        if (reflection.selfAssessment) {
          console.log(`\nSelf-assessment: ${reflection.selfAssessment}`);
        }

        const storedCount = reflection.insights.length + reflection.patterns.length;
        if (storedCount > 0) {
          console.log(`\n  [${storedCount} item(s) stored as memories]`);
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
      const { sub: subCmd, rest: serverName } = parseSub(args);

      if (subCmd == null || subCmd === "" || subCmd === "list") {
        const servers = fullConfig.mcp_servers ?? [];
        const trusted = fullConfig.mcp_trusted_servers ?? [];
        if (servers.length === 0) {
          console.log("No MCP servers configured.");
        } else {
          console.log(`\nMCP servers (${servers.length}):\n`);
          const nameCol = Math.max(...servers.map((s) => s.name.length)) + 2;
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
            const nameGap = " ".repeat(Math.max(1, nameCol - s.name.length));
            const trustLabel = isTrusted
              ? green("trusted".padEnd(12))
              : dim("untrusted".padEnd(12));
            const connLabel = connected === "connected" ? green(connected) : dim(connected);
            console.log(
              `  ${cyan(s.name)}${nameGap}${dim(transport.padEnd(8))}${trustLabel} ${connLabel}${dim(motebitStatus)}`,
            );
          }
        }
      } else if (subCmd === "add") {
        if (!repl) {
          console.log("REPL context not available.");
          break;
        }
        // Parse: /mcp add <name> <url> [--motebit]
        const addArgs = serverName.split(/\s+/);
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
          const hint = /ECONNREFUSED/.test(message)
            ? "Is the server running? Check the URL and port."
            : /ENOTFOUND|EAI_AGAIN/.test(message)
              ? "DNS resolution failed. Check the hostname."
              : /ETIMEDOUT|timeout/i.test(message)
                ? "Connection timed out. The server may be unreachable."
                : "Check the URL and ensure the server accepts MCP connections.";
          console.log(`Failed to connect to "${addName}": ${message}`);
          console.log(`  ${hint}`);
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
          const phase = /identity|signature|verification|public.?key/i.test(message)
            ? "Identity verification failed"
            : /manifest|hash|tool/i.test(message)
              ? "Manifest validation failed"
              : "Tool registration failed";
          console.log(`${phase} for "${addName}": ${message}`);
          if (phase === "Identity verification failed") {
            console.log(
              "  The server's identity could not be verified. Use --motebit only with trusted servers.",
            );
          }
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
        const removeName = serverName;
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
      const syncUrl = getRelaySyncUrl(config, fullConfig);
      if (!syncUrl) {
        console.log("No sync URL configured. Set --sync-url or MOTEBIT_SYNC_URL.");
        break;
      }
      try {
        const capParam = discoverArg || undefined;
        const queryStr = capParam ? `?capability=${encodeURIComponent(capParam)}` : "";
        const headers = await makeRelayHeaders(config, repl);
        const discoverResult = await relayFetch<{
          agents: Array<{
            motebit_id: string;
            endpoint_url: string;
            capabilities: string[];
            public_key: string;
          }>;
        }>(syncUrl, `/api/v1/agents/discover${queryStr}`, { headers });
        if (!discoverResult.ok) {
          console.log(`Discovery failed (${discoverResult.status}): ${discoverResult.text}`);
          break;
        }
        const data = discoverResult.data;
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
              `  ${cyan(agent.motebit_id.slice(0, 12).padEnd(14))} ${agent.endpoint_url.padEnd(30)} ${dim("[" + caps + "]")}`,
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
          const levelFn =
            r.trust_level === AgentTrustLevel.Trusted
              ? green
              : r.trust_level === AgentTrustLevel.Verified
                ? yellow
                : r.trust_level === AgentTrustLevel.Blocked
                  ? red
                  : dim;
          console.log(
            `  ${cyan(r.remote_motebit_id.slice(0, 12))}  ${levelFn(r.trust_level.padEnd(13))} ${dim(`rep:${rep.toFixed(2)}`)}  ${dim(taskStr.padEnd(12))} ${dim(`interactions:${r.interaction_count}`)}  ${dim(`last seen ${ago}`)}`,
          );
        }
      } else {
        const { sub: agentSub, rest: agentArgs } = parseSub(args);

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
          console.log(
            `Trust level for ${match.remote_motebit_id.slice(0, 12)} set to: ${trustLevel}`,
          );
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

    case "delegate": {
      if (!repl) {
        console.log("Delegate not available in this context.");
        break;
      }
      // Parse: /delegate <motebit-id-or-prefix> <prompt>
      const delegateSpaceIdx = args.indexOf(" ");
      if (delegateSpaceIdx === -1 || !args.trim()) {
        console.log("Usage: /delegate <motebit-id-or-prefix> <prompt>");
        break;
      }
      const rawTargetId = args.slice(0, delegateSpaceIdx).trim();
      const delegatePrompt = args.slice(delegateSpaceIdx + 1).trim();
      if (!rawTargetId || !delegatePrompt) {
        console.log("Usage: /delegate <motebit-id-or-prefix> <prompt>");
        break;
      }

      const syncUrl = getRelaySyncUrl(config, fullConfig, "https://motebit-sync.fly.dev");

      // Resolve prefix to full motebit ID if needed (UUID is 36 chars)
      let targetMotebitId = rawTargetId;
      const UUID_LENGTH = 36;
      if (rawTargetId.length < UUID_LENGTH) {
        try {
          const discoverHeaders = await makeRelayHeaders(config, repl);
          const discoverResult = await relayFetch<{ agents: Array<{ motebit_id: string }> }>(
            syncUrl!,
            `/api/v1/agents/discover`,
            { headers: discoverHeaders },
          );
          if (!discoverResult.ok) {
            console.log(
              `Failed to resolve agent prefix (${discoverResult.status}): ${discoverResult.text}`,
            );
            break;
          }
          const discoverData = discoverResult.data;
          const matchedAgent = discoverData.agents.find((a) =>
            a.motebit_id.startsWith(rawTargetId),
          );
          if (!matchedAgent) {
            console.log(
              `No agent found matching prefix "${rawTargetId}". Use /discover to list agents.`,
            );
            break;
          }
          targetMotebitId = matchedAgent.motebit_id;
          console.log(`Resolved: ${rawTargetId} → ${targetMotebitId.slice(0, 12)}...`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`Agent resolution failed: ${message}`);
          break;
        }
      }

      const delegateHeaders = await makeRelayHeaders(config, repl, {
        aud: "task:submit",
        json: true,
      });

      // Submit the task
      let taskId: string;
      try {
        console.log(`Delegating to ${targetMotebitId.slice(0, 12)}...`);
        const submitResult = await relayFetch<{ task_id: string }>(
          syncUrl!,
          `/agent/${targetMotebitId}/task`,
          {
            method: "POST",
            headers: delegateHeaders,
            body: { prompt: delegatePrompt, submitted_by: repl.motebitId },
          },
        );
        if (!submitResult.ok) {
          console.log(`Task submission failed (${submitResult.status}): ${submitResult.text}`);
          break;
        }
        taskId = submitResult.data.task_id;
        console.log(`Task submitted: ${taskId.slice(0, 12)}...`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Task submission error: ${message}`);
        break;
      }

      // Poll for result (max 60s, 2s intervals)
      const POLL_INTERVAL_MS = 2000;
      const MAX_POLLS = 30;
      let receipt: ExecutionReceipt | null = null;
      let agentId: string | undefined;

      for (let poll = 0; poll < MAX_POLLS; poll++) {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const pollResp = await fetch(`${syncUrl}/agent/${targetMotebitId}/task/${taskId}`, {
            headers: delegateHeaders,
          });
          if (!pollResp.ok) {
            // Task may not be ready yet — keep polling
            continue;
          }
          const pollData = (await pollResp.json()) as {
            task: { status: string };
            receipt: ExecutionReceipt | null;
          };
          if (pollData.receipt != null) {
            receipt = pollData.receipt;
            agentId = receipt.motebit_id;
            break;
          }
          // Still pending/running
          if (poll === 0) process.stdout.write("Waiting");
          else process.stdout.write(".");
        } catch {
          // Network hiccup — keep polling
        }
      }
      if (receipt === null) {
        console.log("\nTask timed out after 60s. The agent may still be running.");
        break;
      }
      console.log(); // newline after dots

      // Verify the receipt signature if we have the agent's public key
      let receiptVerified = false;
      const agentRecords = await runtime.listTrustedAgents();
      const agentRecord = agentRecords.find((r) => r.remote_motebit_id === targetMotebitId);
      if (agentRecord?.public_key) {
        try {
          const pubKeyBytes = hexToBytes(agentRecord.public_key);
          receiptVerified = await verifyExecutionReceipt(
            receipt as Parameters<typeof verifyExecutionReceipt>[0],
            pubKeyBytes,
          );
        } catch {
          receiptVerified = false;
        }
      }

      // Bump trust on verified receipt
      const prevLevel = agentRecord?.trust_level ?? AgentTrustLevel.FirstContact;
      let newLevel = prevLevel;
      try {
        await runtime.bumpTrustFromReceipt(receipt, receiptVerified);
        const updatedRecords = await runtime.listTrustedAgents();
        const updated = updatedRecords.find((r) => r.remote_motebit_id === targetMotebitId);
        newLevel = updated?.trust_level ?? prevLevel;
      } catch {
        // Best effort — trust bump is non-critical
      }

      // Display result
      const statusIcon = receipt.status === "completed" ? "\u2713" : "\u2717";
      console.log(
        `${statusIcon} Task ${receipt.status} by ${(agentId ?? targetMotebitId).slice(0, 12)}...`,
      );
      if (receipt.result) {
        console.log(`Result: ${receipt.result}`);
      }
      console.log(`Receipt: ${receiptVerified ? "verified" : "unverified"} (Ed25519)`);
      if (prevLevel !== newLevel) {
        console.log(`Trust: ${prevLevel} \u2192 ${newLevel}`);
      } else {
        console.log(`Trust: ${prevLevel}`);
      }
      break;
    }

    case "propose": {
      if (!repl) {
        console.log("Propose not available in this context.");
        break;
      }

      // Parse: /propose <id1,id2,...> <goal text>
      const proposeSpaceIdx = args.indexOf(" ");
      if (proposeSpaceIdx === -1 || !args.trim()) {
        console.log('Usage: /propose <motebit-id,...> "<goal>"');
        break;
      }
      const rawParticipantIds = args.slice(0, proposeSpaceIdx).trim();
      const proposalGoal = args.slice(proposeSpaceIdx + 1).trim();
      if (!rawParticipantIds || !proposalGoal) {
        console.log('Usage: /propose <motebit-id,...> "<goal>"');
        break;
      }

      const participantIds = rawParticipantIds
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      if (participantIds.length === 0) {
        console.log("Error: no participant IDs provided.");
        break;
      }

      const proposeSyncUrl = getRelaySyncUrl(config, fullConfig, "https://motebit-sync.fly.dev");

      const proposeHeaders = await makeRelayHeaders(config, repl, { aud: "proposal", json: true });

      // Simple decomposition: distribute goal steps round-robin across participants.
      // Each participant gets a step: research, implementation, verification, etc.
      const stepTemplates = [
        {
          description: "Research and plan approach",
          prompt: `Research the best approach for: ${proposalGoal}`,
        },
        {
          description: "Implement core functionality",
          prompt: `Implement the core functionality for: ${proposalGoal}`,
        },
        {
          description: "Verify and integrate results",
          prompt: `Verify and integrate all results for: ${proposalGoal}`,
        },
      ];

      // Generate as many steps as participants (one step per participant, min 2 steps)
      const numSteps = Math.max(participantIds.length, 2);
      const steps = Array.from({ length: numSteps }, (_, i) => {
        const template = stepTemplates[i % stepTemplates.length] ?? stepTemplates[0]!;
        const assignedId = participantIds[i % participantIds.length]!;
        return {
          description: template.description,
          prompt: template.prompt,
          assigned_motebit_id: assignedId,
          ordinal: i,
        };
      });

      // Build participants list with assigned step ordinals
      const participantsPayload = participantIds.map((id) => ({
        motebit_id: id,
        assigned_steps: steps.filter((s) => s.assigned_motebit_id === id).map((s) => s.ordinal),
      }));

      const proposalId = crypto.randomUUID();
      const planId = crypto.randomUUID();
      const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour

      try {
        const proposeResult = await relayFetch<{ proposal_id: string; status: string }>(
          proposeSyncUrl!,
          `/api/v1/proposals`,
          {
            method: "POST",
            headers: proposeHeaders,
            body: {
              proposal_id: proposalId,
              plan_id: planId,
              initiator_motebit_id: repl.motebitId,
              participants: participantsPayload,
              plan_snapshot: { goal: proposalGoal, steps },
              expires_at: expiresAt,
            },
          },
        );
        if (!proposeResult.ok) {
          console.log(
            `Proposal submission failed (${proposeResult.status}): ${proposeResult.text}`,
          );
          break;
        }
        const data = proposeResult.data;
        console.log(
          `Proposal ${data.proposal_id.slice(0, 12)}... sent to ${participantIds.length} agent(s). Waiting for responses...`,
        );
        console.log(`  Goal: ${proposalGoal}`);
        console.log(
          `  Steps: ${steps.length} (distributed across ${participantIds.length} participants)`,
        );
        console.log(`  Expires: ${new Date(expiresAt).toISOString()}`);
        console.log(`  Use /proposal ${data.proposal_id.slice(0, 8)} to check status.`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Proposal error: ${message}`);
      }
      break;
    }

    case "proposals": {
      if (!repl) {
        console.log("Proposals not available in this context.");
        break;
      }

      const proposalsSyncUrl = getRelaySyncUrl(config, fullConfig, "https://motebit-sync.fly.dev");

      const proposalsHeaders = await makeRelayHeaders(config, repl, { aud: "proposal" });

      try {
        const listResult = await relayFetch<{
          proposals: Array<{
            proposal_id: string;
            plan_id: string;
            initiator_motebit_id: string;
            status: string;
            created_at: number;
            expires_at: number;
          }>;
        }>(proposalsSyncUrl!, `/api/v1/proposals`, { headers: proposalsHeaders });
        if (!listResult.ok) {
          console.log(`Failed to fetch proposals (${listResult.status}): ${listResult.text}`);
          break;
        }
        const data = listResult.data;

        if (data.proposals.length === 0) {
          console.log("No active proposals.");
          break;
        }

        console.log(`\nProposals (${data.proposals.length}):\n`);
        console.log(
          `${"ID".padEnd(12)}  ${"STATUS".padEnd(10)}  ${"ROLE".padEnd(10)}  ${"CREATED".padEnd(24)}`,
        );
        console.log("-".repeat(62));
        for (const p of data.proposals) {
          const idPrefix = p.proposal_id.slice(0, 10);
          const role = p.initiator_motebit_id === repl.motebitId ? "initiator" : "participant";
          const created = new Date(p.created_at).toISOString().slice(0, 19).replace("T", " ");
          console.log(`${idPrefix}..  ${p.status.padEnd(10)}  ${role.padEnd(10)}  ${created}`);
        }
        console.log("\nUse /proposal <id> to view details or respond.");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Proposals error: ${message}`);
      }
      break;
    }

    case "proposal": {
      if (!repl) {
        console.log("Proposal not available in this context.");
        break;
      }

      const proposalArgParts = args.trim().split(/\s+/);
      const proposalId = proposalArgParts[0];
      const proposalAction = proposalArgParts[1]; // accept | reject | counter | undefined

      if (!proposalId) {
        console.log("Usage: /proposal <id> [accept|reject|counter]");
        break;
      }

      const proposalSyncUrl = getRelaySyncUrl(config, fullConfig, "https://motebit-sync.fly.dev");

      const proposalHeaders = await makeRelayHeaders(config, repl, { aud: "proposal", json: true });

      // First, fetch the proposal details
      type ProposalDetail = {
        proposal_id: string;
        plan_id: string;
        initiator_motebit_id: string;
        status: string;
        plan_snapshot: unknown;
        created_at: number;
        expires_at: number;
        updated_at: number;
        participants: Array<{
          motebit_id: string;
          assigned_steps: number[];
          response: string | null;
          responded_at: number | null;
        }>;
      };
      let proposalData: ProposalDetail | null = null;

      try {
        const detailResult = await relayFetch<ProposalDetail>(
          proposalSyncUrl!,
          `/api/v1/proposals/${proposalId}`,
          { headers: proposalHeaders },
        );
        if (detailResult.ok) {
          proposalData = detailResult.data;
        } else if (detailResult.status === 404) {
          // Try prefix match by listing proposals
          const listResult = await relayFetch<{ proposals: Array<{ proposal_id: string }> }>(
            proposalSyncUrl!,
            `/api/v1/proposals`,
            { headers: proposalHeaders },
          );
          if (listResult.ok) {
            const match = listResult.data.proposals.find((p) =>
              p.proposal_id.startsWith(proposalId),
            );
            if (match) {
              const fullResult = await relayFetch<ProposalDetail>(
                proposalSyncUrl!,
                `/api/v1/proposals/${match.proposal_id}`,
                { headers: proposalHeaders },
              );
              if (fullResult.ok) proposalData = fullResult.data;
            }
          }
          if (!proposalData) {
            console.log(`Proposal not found: ${proposalId}`);
            break;
          }
        } else {
          console.log(`Failed to fetch proposal (${detailResult.status}): ${detailResult.text}`);
          break;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Proposal fetch error: ${message}`);
        break;
      }

      if (proposalData == null) break;

      // No action — display details
      if (!proposalAction) {
        const isInitiator = proposalData.initiator_motebit_id === repl.motebitId;
        console.log(`\nProposal: ${proposalData.proposal_id.slice(0, 12)}...`);
        console.log(`  Status:    ${proposalData.status}`);
        console.log(`  Role:      ${isInitiator ? "initiator" : "participant"}`);
        console.log(`  Initiator: ${proposalData.initiator_motebit_id.slice(0, 12)}...`);
        console.log(`  Created:   ${new Date(proposalData.created_at).toISOString()}`);
        console.log(`  Expires:   ${new Date(proposalData.expires_at).toISOString()}`);

        const snapshot = proposalData.plan_snapshot as Record<string, unknown> | null;
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- Record<string, unknown> value check
        if (snapshot?.goal) {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- snapshot.goal is a string at runtime
          console.log(`  Goal:      ${String(snapshot.goal)}`);
        }

        if (proposalData.participants.length > 0) {
          console.log(`\n  Participants (${proposalData.participants.length}):`);
          for (const p of proposalData.participants) {
            const steps = p.assigned_steps.join(", ") || "none";
            const response = p.response ?? "pending";
            console.log(
              `    ${p.motebit_id.slice(0, 12)}...  steps=[${steps}]  response=${response}`,
            );
          }
        }

        const myParticipant = proposalData.participants.find(
          (p) => p.motebit_id === repl.motebitId,
        );
        if (myParticipant && !myParticipant.response && proposalData.status === "pending") {
          console.log("\n  You have not responded. Use:");
          console.log(`    /proposal ${proposalId} accept`);
          console.log(`    /proposal ${proposalId} reject`);
          console.log(`    /proposal ${proposalId} counter`);
        }
        break;
      }

      // Respond to proposal
      const validActions = ["accept", "reject", "counter"] as const;
      type ValidAction = (typeof validActions)[number];
      if (!validActions.includes(proposalAction as ValidAction)) {
        console.log("Action must be: accept, reject, or counter");
        break;
      }

      const responseMap: Record<ValidAction, string> = {
        accept: "accept",
        reject: "reject",
        counter: "counter",
      };

      const responseBody: {
        responder_motebit_id: string;
        response: string;
        counter_steps?: Array<{ ordinal: number; reason: string; description?: string }>;
      } = {
        responder_motebit_id: repl.motebitId,
        response: responseMap[proposalAction as ValidAction],
      };

      if (proposalAction === "counter") {
        // Simple counter: suggest all steps be assigned to caller
        responseBody.counter_steps = [
          {
            ordinal: 0,
            reason: "Prefer to handle all steps locally",
            description: "Revised step assignment",
          },
        ];
        console.log("Sending counter-proposal (all steps assigned to you)...");
      }

      try {
        const respondResult = await relayFetch<{ status: string; all_responded: boolean }>(
          proposalSyncUrl!,
          `/api/v1/proposals/${proposalData.proposal_id}/respond`,
          { method: "POST", headers: proposalHeaders, body: responseBody },
        );
        if (!respondResult.ok) {
          console.log(`Response failed (${respondResult.status}): ${respondResult.text}`);
          break;
        }
        const respondData = respondResult.data;
        console.log(`Responded: ${proposalAction}. Proposal status: ${respondData.status}`);
        if (respondData.all_responded) {
          console.log("All participants have responded.");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Response error: ${message}`);
      }
      break;
    }

    case "balance": {
      const balSyncUrl = getRelaySyncUrl(config, fullConfig);
      if (!balSyncUrl) {
        console.log("No sync URL configured. Set --sync-url or MOTEBIT_SYNC_URL.");
        break;
      }
      if (!repl) {
        console.log("Balance requires an active REPL session.");
        break;
      }
      try {
        const balHeaders = await makeRelayHeaders(config, repl);
        const balResult = await relayFetch<{
          balance: number;
          currency: string;
          transactions: Array<{ type: string; amount: number; created_at: string }>;
        }>(balSyncUrl, `/api/v1/agents/${repl.motebitId}/balance`, { headers: balHeaders });
        if (!balResult.ok) {
          console.log(`Balance request failed (${balResult.status}): ${balResult.text}`);
          break;
        }
        console.log(`\nBalance: $${balResult.data.balance.toFixed(2)} ${balResult.data.currency}`);
        const recentTx = (balResult.data.transactions ?? []).slice(0, 5);
        if (recentTx.length > 0) {
          console.log("Recent:");
          for (const tx of recentTx) {
            const sign = tx.amount >= 0 ? "+" : "";
            const ago = formatTimeAgo(Date.now() - new Date(tx.created_at).getTime());
            console.log(
              `  ${sign}$${Math.abs(tx.amount).toFixed(2)}  ${tx.type.padEnd(20)} ${ago}`,
            );
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Balance error: ${message}`);
      }
      break;
    }

    case "withdraw": {
      const wdSyncUrl = getRelaySyncUrl(config, fullConfig);
      if (!wdSyncUrl) {
        console.log("No sync URL configured. Set --sync-url or MOTEBIT_SYNC_URL.");
        break;
      }
      if (!repl) {
        console.log("Withdraw requires an active REPL session.");
        break;
      }
      const wdParts = args.split(/\s+/);
      const wdAmountStr = wdParts[0];
      if (!wdAmountStr) {
        console.log("Usage: /withdraw <amount> [destination]");
        break;
      }
      const wdAmount = parseFloat(wdAmountStr);
      if (isNaN(wdAmount) || wdAmount <= 0) {
        console.log("Error: amount must be a positive number.");
        break;
      }
      const wdDest = wdParts[1] ?? undefined;
      try {
        const wdHeaders = await makeRelayHeaders(config, repl, { json: true });
        const wdBody: Record<string, unknown> = { amount: wdAmount };
        if (wdDest) wdBody["destination"] = wdDest;
        const wdResult = await relayFetch<{ withdrawal_id?: string }>(
          wdSyncUrl,
          `/api/v1/agents/${repl.motebitId}/withdraw`,
          { method: "POST", headers: wdHeaders, body: wdBody },
        );
        if (!wdResult.ok) {
          console.log(
            wdResult.status === 402
              ? "Insufficient balance."
              : `Withdrawal failed (${wdResult.status}): ${wdResult.text}`,
          );
          break;
        }
        console.log(`Withdrawal of $${wdAmount.toFixed(2)} submitted.`);
        if (wdResult.data.withdrawal_id != null && wdResult.data.withdrawal_id !== "") {
          console.log(`  ID: ${wdResult.data.withdrawal_id}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Withdrawal error: ${message}`);
      }
      break;
    }

    case "deposits": {
      const depSyncUrl = getRelaySyncUrl(config, fullConfig);
      if (!depSyncUrl) {
        console.log("No sync URL configured. Set --sync-url or MOTEBIT_SYNC_URL.");
        break;
      }
      if (!repl) {
        console.log("Deposits requires an active REPL session.");
        break;
      }
      try {
        const depHeaders = await makeRelayHeaders(config, repl);
        const depResult = await relayFetch<{
          transactions: Array<{
            type: string;
            amount: number;
            created_at: string;
            reference?: string;
            description?: string;
          }>;
        }>(depSyncUrl, `/api/v1/agents/${repl.motebitId}/balance`, { headers: depHeaders });
        if (!depResult.ok) {
          console.log(`Deposits request failed (${depResult.status}): ${depResult.text}`);
          break;
        }
        const depData = depResult.data;
        const deposits = (depData.transactions ?? []).filter((tx) => tx.type === "deposit");
        if (deposits.length === 0) {
          console.log("No deposit transactions found.");
          break;
        }
        console.log(`\nDeposits (${deposits.length}):\n`);
        for (const tx of deposits) {
          const ago = formatTimeAgo(Date.now() - new Date(tx.created_at).getTime());
          const ref = tx.reference ? `  ref=${tx.reference}` : "";
          const desc = tx.description ? `  ${tx.description}` : "";
          console.log(`  +$${Math.abs(tx.amount).toFixed(2)}  ${ago}${ref}${desc}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`Deposits error: ${message}`);
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

    default: {
      // Try the shared command layer before giving up
      const handled = await trySharedCommand(runtime, cmd, args, config, fullConfig, repl);
      if (!handled) {
        console.log(
          `Unknown command: ${command("/" + cmd)}. Type ${command("/help")} for available commands.`,
        );
      }
    }
  }
}
