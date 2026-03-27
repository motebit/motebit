/**
 * Surface-agnostic command layer.
 *
 * Every informational command (state, balance, memories, etc.) is executed here
 * and returns a structured CommandResult. Surfaces render results in their native
 * format — web renders HTML cards, spatial speaks TTS, desktop renders chat bubbles —
 * but the data extraction and formatting logic lives here exactly once.
 *
 * Surface-specific commands (open panel, export file, serve toggle) are NOT here.
 * Those belong in the surface because they require platform APIs.
 */

import type { MotebitRuntime } from "./index";
import { narrateEconomicConsequences } from "@motebit/gradient";

// === Types ===

export interface CommandResult {
  /** One-line summary suitable for TTS or inline display. */
  summary: string;
  /** Extended detail for expandable cards or verbose display. */
  detail?: string;
  /** Structured data for surfaces that want custom rendering. */
  data?: Record<string, unknown>;
}

export interface RelayConfig {
  relayUrl: string;
  authToken: string;
  motebitId: string;
}

// === Relay fetch helper ===

async function relayFetch(
  relay: RelayConfig,
  path: string,
  options?: RequestInit,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${relay.authToken}`,
    ...(options?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${relay.relayUrl}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<unknown>;
}

// === Command definitions ===

/**
 * All commands the shared layer can execute. Surface-specific commands
 * (open panel, export, serve) are not listed here.
 */
export const COMMAND_DEFINITIONS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "state", description: "Show state vector" },
  { name: "model", description: "Show current model" },
  { name: "tools", description: "List registered tools" },
  { name: "mcp", description: "List MCP servers" },
  { name: "memories", description: "Memory summary" },
  { name: "graph", description: "Memory graph stats" },
  { name: "curious", description: "Show curiosity targets" },
  { name: "forget", description: "Delete a memory by keyword" },
  { name: "audit", description: "Audit memory integrity" },
  { name: "gradient", description: "Intelligence gradient" },
  { name: "reflect", description: "Trigger self-reflection" },
  { name: "summarize", description: "Summarize conversation" },
  { name: "approvals", description: "Show pending approvals" },
  { name: "balance", description: "Show account balance" },
  { name: "deposits", description: "Show deposit history" },
  { name: "discover", description: "Discover agents on relay" },
  { name: "proposals", description: "List active proposals" },
  { name: "conversations", description: "List conversations" },
  { name: "withdraw", description: "Request withdrawal" },
  { name: "delegate", description: "Delegate task to agent" },
  { name: "propose", description: "Propose collaborative plan" },
];

// === Command executor ===

/**
 * Execute a runtime command and return a structured result.
 *
 * Returns null if the command is not recognized by this layer (surface should handle it).
 * Throws on runtime errors (caller should catch and display).
 *
 * @param runtime - The MotebitRuntime instance
 * @param command - Command name (e.g. "state", "balance")
 * @param args - Optional argument string (e.g. keyword for "forget")
 * @param relay - Optional relay config for network commands
 */
export async function executeCommand(
  runtime: MotebitRuntime,
  command: string,
  args?: string,
  relay?: RelayConfig,
): Promise<CommandResult | null> {
  switch (command) {
    case "state":
      return cmdState(runtime);
    case "model":
      return cmdModel(runtime);
    case "tools":
      return cmdTools(runtime);
    case "mcp":
      return null; // Surface-specific — each surface manages its own MCP adapters
    case "memories":
      return cmdMemories(runtime);
    case "graph":
      return cmdGraph(runtime);
    case "curious":
      return cmdCurious(runtime);
    case "forget":
      return cmdForget(runtime, args);
    case "audit":
      return cmdAudit(runtime);
    case "gradient":
      return cmdGradient(runtime);
    case "reflect":
      return cmdReflect(runtime);
    case "summarize":
      return cmdSummarize(runtime);
    case "approvals":
      return cmdApprovals(runtime);
    case "conversations":
      return cmdConversations(runtime);
    case "balance":
      return relay ? cmdBalance(relay) : { summary: "Not connected to relay." };
    case "deposits":
      return relay ? cmdDeposits(relay) : { summary: "Not connected to relay." };
    case "discover":
      return relay ? cmdDiscover(relay) : { summary: "Not connected to relay." };
    case "proposals":
      return relay ? cmdProposals(relay) : { summary: "Not connected to relay." };
    case "withdraw":
      return { summary: "Withdrawals require the CLI for secure signing. Run: motebit withdraw" };
    case "delegate":
      return {
        summary:
          "Delegation happens transparently during conversation when connected to a relay. " +
          "To delegate manually, use the CLI: motebit delegate",
      };
    case "propose":
      return { summary: "Collaborative proposals require the CLI. Run: motebit propose" };
    default:
      return null;
  }
}

// === Command handlers ===

function cmdState(runtime: MotebitRuntime): CommandResult {
  const state = runtime.getState();
  const entries = Object.entries(state).filter(([, v]) => typeof v === "number") as [
    string,
    number,
  ][];
  const summary = `State vector — ${entries.length} dimensions`;
  const detail = entries.map(([k, v]) => `${k}: ${v.toFixed(3)}`).join("\n");
  return { summary, detail, data: { state } };
}

function cmdModel(runtime: MotebitRuntime): CommandResult {
  const model = runtime.currentModel;
  return { summary: model ? `Current model: ${model}` : "No model connected." };
}

function cmdTools(runtime: MotebitRuntime): CommandResult {
  const tools = runtime.getToolRegistry().list();
  if (tools.length === 0) return { summary: "No tools registered." };
  const names = tools.map((t) => t.name);
  return {
    summary: `${tools.length} tools registered: ${names.join(", ")}`,
    data: { tools: names },
  };
}

async function cmdMemories(runtime: MotebitRuntime): Promise<CommandResult> {
  const { nodes, edges } = await runtime.memory.exportAll();
  const now = Date.now();
  const active = nodes.filter(
    (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now),
  );
  if (active.length === 0) return { summary: "No memories stored yet." };
  const top = active
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map((n) => n.content.slice(0, 80));
  return {
    summary: `${active.length} active memories, ${edges.length} edges`,
    detail: top.join("\n"),
    data: { active: active.length, edges: edges.length, total: nodes.length },
  };
}

async function cmdGraph(runtime: MotebitRuntime): Promise<CommandResult> {
  const { nodes, edges } = await runtime.memory.exportAll();
  const now = Date.now();
  const active = nodes.filter(
    (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now),
  );
  const pinned = active.filter((n) => n.pinned);

  const edgeTypes = new Map<string, number>();
  for (const e of edges) {
    edgeTypes.set(e.relation_type, (edgeTypes.get(e.relation_type) ?? 0) + 1);
  }

  const summary = `Memory graph — ${active.length} nodes, ${edges.length} edges, ${pinned.length} pinned`;
  const detailLines = [
    `Nodes: ${active.length} active, ${nodes.length - active.length} tombstoned`,
  ];
  detailLines.push(`Edges: ${edges.length} total`);
  for (const [rel, count] of edgeTypes) {
    detailLines.push(`  ${rel}: ${count}`);
  }
  detailLines.push(`Pinned: ${pinned.length}`);

  return {
    summary,
    detail: detailLines.join("\n"),
    data: { active: active.length, edges: edges.length, pinned: pinned.length },
  };
}

function cmdCurious(runtime: MotebitRuntime): CommandResult {
  const targets = runtime.getCuriosityTargets();
  if (targets.length === 0) return { summary: "No curiosity targets — memory graph is stable." };
  const lines = targets.map(
    (t) => `${t.node.content.slice(0, 80)}${t.node.content.length > 80 ? "..." : ""}`,
  );
  return {
    summary: `${targets.length} curiosity targets`,
    detail: lines.join("\n"),
    data: { count: targets.length },
  };
}

async function cmdForget(runtime: MotebitRuntime, keyword?: string): Promise<CommandResult> {
  if (!keyword || keyword.trim() === "") {
    return { summary: "Specify what to forget. Example: forget meeting notes" };
  }
  const k = keyword.trim().toLowerCase();
  const { nodes } = await runtime.memory.exportAll();
  const now = Date.now();
  const active = nodes.filter(
    (n) => !n.tombstoned && (n.valid_until == null || n.valid_until > now),
  );
  const match = active.find((n) => n.content.toLowerCase().includes(k));
  if (!match) return { summary: `No memory matching "${keyword.trim()}".` };

  await runtime.memory.deleteMemory(match.node_id);
  const snippet = match.content.slice(0, 60);
  return {
    summary: `Forgot: ${snippet}${match.content.length > 60 ? "..." : ""}`,
    data: { deletedId: match.node_id, content: match.content },
  };
}

async function cmdAudit(runtime: MotebitRuntime): Promise<CommandResult> {
  const result = await runtime.auditMemory();
  const phantoms = result.phantomCertainties.length;
  const conflicts = result.conflicts.length;
  const nearDeath = result.nearDeath.length;
  const issues = phantoms + conflicts + nearDeath;

  if (issues === 0) {
    return { summary: `Audit clean — ${result.nodesAudited} nodes, no issues.` };
  }

  const parts: string[] = [];
  if (phantoms > 0) parts.push(`${phantoms} phantom`);
  if (conflicts > 0) parts.push(`${conflicts} conflict`);
  if (nearDeath > 0) parts.push(`${nearDeath} near-death`);

  return {
    summary: `Audit: ${parts.join(", ")} in ${result.nodesAudited} nodes`,
    detail: parts.map((p) => `• ${p}`).join("\n"),
    data: {
      phantoms,
      conflicts,
      nearDeath,
      total: result.nodesAudited,
      phantomIds: result.phantomCertainties.map((p) => p.node.node_id),
      conflictIds: result.conflicts.flatMap((c) => [c.a.node_id, c.b.node_id]),
      nearDeathIds: result.nearDeath.map((n) => n.node.node_id),
    },
  };
}

function cmdGradient(runtime: MotebitRuntime): CommandResult {
  const g = runtime.getGradient();
  if (!g) return { summary: "No gradient data yet." };

  const gradientSummary = runtime.getGradientSummary();
  const summary = `Gradient ${g.gradient.toFixed(3)} (${g.delta >= 0 ? "+" : ""}${g.delta.toFixed(3)}) — ${gradientSummary.posture}`;

  const detailLines: string[] = [];
  if (gradientSummary.snapshotCount > 0) {
    detailLines.push(gradientSummary.trajectory);
    detailLines.push(gradientSummary.overall);
    if (gradientSummary.strengths.length > 0)
      detailLines.push(`Strengths: ${gradientSummary.strengths.join("; ")}`);
    if (gradientSummary.weaknesses.length > 0)
      detailLines.push(`Weaknesses: ${gradientSummary.weaknesses.join("; ")}`);
  }

  const econ = narrateEconomicConsequences(g);
  if (econ.length > 0) {
    detailLines.push("");
    detailLines.push("Economic position:");
    for (const c of econ) detailLines.push(`  - ${c}`);
  }

  const lastRef = runtime.getLastReflection();
  if (lastRef?.selfAssessment) {
    detailLines.push("");
    detailLines.push(`Last reflection: ${lastRef.selfAssessment}`);
  }

  return { summary, detail: detailLines.join("\n"), data: { gradient: g } };
}

async function cmdReflect(runtime: MotebitRuntime): Promise<CommandResult> {
  const result = await runtime.reflect();
  const summary = result.selfAssessment || "Reflection complete.";

  const detailLines: string[] = [];
  if (result.insights.length > 0) {
    detailLines.push("Insights:");
    for (const i of result.insights) detailLines.push(`  - ${i}`);
  }
  if (result.planAdjustments.length > 0) {
    detailLines.push("Adjustments:");
    for (const a of result.planAdjustments) detailLines.push(`  - ${a}`);
  }
  if (result.patterns.length > 0) {
    detailLines.push("Recurring patterns:");
    for (const p of result.patterns) detailLines.push(`  - ${p}`);
  }

  return {
    summary,
    detail: detailLines.length > 0 ? detailLines.join("\n") : undefined,
    data: {
      insights: result.insights,
      adjustments: result.planAdjustments,
      patterns: result.patterns,
    },
  };
}

async function cmdSummarize(runtime: MotebitRuntime): Promise<CommandResult> {
  const result = await runtime.summarizeCurrentConversation();
  return { summary: result ?? "Nothing to summarize yet." };
}

function cmdApprovals(runtime: MotebitRuntime): CommandResult {
  if (!runtime.hasPendingApproval) return { summary: "No pending approvals." };
  const info = runtime.pendingApprovalInfo;
  if (!info) return { summary: "No pending approvals." };
  return {
    summary: `Pending approval: ${info.toolName}`,
    detail: `Args: ${JSON.stringify(info.args, null, 2)}`,
    data: { toolName: info.toolName, args: info.args },
  };
}

function cmdConversations(runtime: MotebitRuntime): CommandResult {
  const convs = runtime.listConversations();
  if (convs.length === 0) return { summary: "No previous conversations." };
  const recent = convs.slice(0, 10).map((c) => {
    const title = c.title ?? `Untitled (${new Date(c.startedAt).toLocaleDateString()})`;
    return `${title} (${c.messageCount} messages)`;
  });
  return {
    summary: `${convs.length} conversations`,
    detail: recent.join("\n"),
    data: { conversations: convs },
  };
}

// === Relay commands ===

async function cmdBalance(relay: RelayConfig): Promise<CommandResult> {
  const data = (await relayFetch(relay, `/api/v1/agents/${relay.motebitId}/balance`)) as {
    balance: number;
    pending_allocations: number;
    currency: string;
  };
  return {
    summary: `Balance: ${data.balance} ${data.currency ?? "USDC"}. Pending: ${data.pending_allocations ?? 0}`,
    data: { balance: data.balance, pending: data.pending_allocations, currency: data.currency },
  };
}

async function cmdDeposits(relay: RelayConfig): Promise<CommandResult> {
  const data = (await relayFetch(relay, `/api/v1/agents/${relay.motebitId}/balance`)) as {
    transactions?: Array<{ type: string; amount: number; created_at: number }>;
  };
  const deposits = (data.transactions ?? []).filter((t) => t.type === "deposit");
  if (deposits.length === 0) return { summary: "No deposits yet." };
  const lines = deposits
    .slice(0, 10)
    .map((d) => `${new Date(d.created_at).toLocaleDateString()} — ${d.amount} USDC`);
  return {
    summary: `${deposits.length} deposits`,
    detail: lines.join("\n"),
    data: { deposits },
  };
}

async function cmdDiscover(relay: RelayConfig): Promise<CommandResult> {
  const data = (await relayFetch(relay, "/api/v1/agents/discover", {
    method: "POST",
    body: JSON.stringify({ capability: "web_search" }),
  })) as {
    agents: Array<{ motebit_id: string; capabilities: string[]; endpoint_url: string }>;
  };
  const agents = data.agents ?? [];
  if (agents.length === 0) return { summary: "No agents found on relay." };
  const lines = agents
    .slice(0, 15)
    .map(
      (a) => `${a.motebit_id.slice(0, 8)}... — ${(a.capabilities ?? []).join(", ") || "no caps"}`,
    );
  return {
    summary: `${agents.length} agents discovered`,
    detail: lines.join("\n"),
    data: { agents },
  };
}

async function cmdProposals(relay: RelayConfig): Promise<CommandResult> {
  const data = (await relayFetch(relay, `/api/v1/agents/${relay.motebitId}/proposals`)) as {
    proposals: Array<{ proposal_id: string; status: string; goal: string; created_at: number }>;
  };
  const proposals = data.proposals ?? [];
  if (proposals.length === 0) return { summary: "No active proposals." };
  const lines = proposals
    .slice(0, 10)
    .map((p) => `${p.proposal_id.slice(0, 8)}... [${p.status}] — ${(p.goal ?? "").slice(0, 60)}`);
  return {
    summary: `${proposals.length} proposals`,
    detail: lines.join("\n"),
    data: { proposals },
  };
}
