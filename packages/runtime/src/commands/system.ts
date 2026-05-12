/** System commands: state, model, tools, approvals, conversations, summarize. */

import type { MotebitRuntime } from "../index.js";
import type { CommandResult } from "./types.js";

export function cmdState(runtime: MotebitRuntime): CommandResult {
  const state = runtime.getState();
  const entries = Object.entries(state).filter(([, v]) => typeof v === "number") as [
    string,
    number,
  ][];
  const summary = `State vector — ${entries.length} dimensions`;
  const detail = entries.map(([k, v]) => `${k}: ${v.toFixed(3)}`).join("\n");
  return { summary, detail, data: { state } };
}

export function cmdModel(runtime: MotebitRuntime): CommandResult {
  const model = runtime.currentModel;
  return { summary: model ? `Current model: ${model}` : "No model connected." };
}

export function cmdTools(runtime: MotebitRuntime): CommandResult {
  const tools = runtime.getToolRegistry().list();
  if (tools.length === 0) return { summary: "No tools registered." };
  const names = tools.map((t) => t.name);
  return {
    summary: `${tools.length} tools registered: ${names.join(", ")}`,
    data: { tools: names },
  };
}

export function cmdApprovals(runtime: MotebitRuntime): CommandResult {
  if (!runtime.hasPendingApproval) return { summary: "No pending approvals." };
  const info = runtime.pendingApprovalInfo;
  if (!info) return { summary: "No pending approvals." };
  return {
    summary: `Pending approval: ${info.toolName}`,
    detail: `Args: ${JSON.stringify(info.args, null, 2)}`,
    data: { toolName: info.toolName, args: info.args },
  };
}

export function cmdConversations(runtime: MotebitRuntime): CommandResult {
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

export async function cmdSummarize(runtime: MotebitRuntime): Promise<CommandResult> {
  const result = await runtime.summarizeCurrentConversation();
  return { summary: result ?? "Nothing to summarize yet." };
}

/**
 * `/trust` — what motebit holds for this identity, at a glance. Phase 1
 * of the trust-accumulation visibility arc: a single calm summary that
 * makes the thesis ("persistent identity + accumulated trust") legible
 * by counting the dimensions a user can already verify exist.
 *
 * Three dimensions today, all surface-agnostic:
 *   - **memories** — `runtime.memory.getAllNodes(motebitId)`. The
 *     semantic-memory graph; nodes accumulate as the user converses and
 *     memories are tagged. Decay applies at retrieval, not at count.
 *   - **conversations** — `runtime.listConversations()`. Every prior
 *     dialog the runtime has persisted. The IDB / SQLite / Expo store
 *     surface decides per-surface; the count is uniform.
 *   - **signed receipts** — `runtime.getRecentReceipts()`. The
 *     in-memory ring buffer of ToolInvocationReceipts the runtime has
 *     produced this session and prior, capped at the runtime's
 *     configured ring size (the count is "what motebit can still
 *     show," not "lifetime ever produced").
 *
 * Web-only surface state (cookies for the cloud browser, per the
 * cookies arc shipped 2026-05-12) is layered ON TOP of this shared
 * summary by the web slash-command surface — same pattern as
 * `/sensitivity` and `/vision` decorating shared state with web-
 * specific affordances. The shared command stays surface-agnostic.
 *
 * Future dimensions: federation peers, credentials accumulated,
 * skills installed. Each compounds the visibility; each waits for
 * a clean runtime accessor to surface. The pattern is additive — a
 * new line per dimension, never a re-shape of the existing ones.
 */
export async function cmdTrust(runtime: MotebitRuntime): Promise<CommandResult> {
  const conversations = runtime.listConversations();
  const receipts = runtime.getRecentReceipts();
  // `exportAll` is the public MemoryGraph aggregator; it routes
  // through the storage adapter with the runtime's bound motebitId,
  // so the trust summary is automatically scoped to this identity
  // (sovereign-floor invariant — no cross-motebit leak).
  const { nodes: memoryNodes } = await runtime.memory.exportAll();

  const memoryCount = memoryNodes.length;
  const conversationCount = conversations.length;
  const receiptCount = receipts.length;

  if (memoryCount === 0 && conversationCount === 0 && receiptCount === 0) {
    return {
      summary:
        "Motebit hasn't accumulated state yet. Trust builds as you converse, share, and act — come back after a few sessions.",
      data: {
        trust: { memories: 0, conversations: 0, receipts: 0 },
      },
    };
  }

  const memoryLine = `${memoryCount} ${memoryCount === 1 ? "memory" : "memories"}`;
  const convoLine = `${conversationCount} ${conversationCount === 1 ? "conversation" : "conversations"}`;
  const receiptLine = `${receiptCount} signed ${receiptCount === 1 ? "receipt" : "receipts"}`;

  const detailLines: string[] = [];
  if (memoryCount > 0) {
    // Sensitivity distribution — the governance signal. A user
    // looking at the trust summary should see what kinds of memories
    // motebit holds, not just the count.
    const bySensitivity = new Map<string, number>();
    for (const node of memoryNodes) {
      const tier = node.sensitivity ?? "none";
      bySensitivity.set(tier, (bySensitivity.get(tier) ?? 0) + 1);
    }
    const tierLine = [...bySensitivity.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tier, count]) => `${count} ${tier}`)
      .join(", ");
    detailLines.push(`Memory sensitivity: ${tierLine}`);
  }
  if (receiptCount > 0) {
    // Recent receipt tool names — the audit signal. The user sees
    // what motebit has been signing for them recently.
    const toolNames = receipts.slice(-5).map((r) => r.tool_name);
    detailLines.push(`Recent receipts: ${toolNames.join(", ")}`);
  }

  return {
    summary: `Motebit holds ${memoryLine}, ${convoLine}, and ${receiptLine} for you.`,
    detail: detailLines.length > 0 ? detailLines.join("\n") : undefined,
    data: {
      trust: {
        memories: memoryCount,
        conversations: conversationCount,
        receipts: receiptCount,
      },
    },
  };
}
