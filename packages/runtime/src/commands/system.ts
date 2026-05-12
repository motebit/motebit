/** System commands: state, model, tools, approvals, conversations, summarize, trust. */

import type { MotebitId } from "@motebit/sdk";
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
 * Five dimensions today, all surface-agnostic. Three cover the
 * **accumulation pillar** (what motebit holds), two cover the
 * **governance + network pillars** (the thesis's other two legs the
 * Phase 1 ship explicitly named as next):
 *
 *   - **memories** — `runtime.memory.exportAll().nodes`. The semantic-
 *     memory graph; nodes accumulate as the user converses and
 *     memories are tagged. Decay applies at retrieval, not at count.
 *   - **conversations** — `runtime.listConversations()`. Every prior
 *     dialog the runtime has persisted.
 *   - **signed receipts** — `runtime.getRecentReceipts()`. The
 *     in-memory ring buffer of ToolInvocationReceipts the runtime has
 *     produced this session and prior (capped at the runtime's
 *     configured ring size — "what motebit can still show," not
 *     "lifetime ever produced").
 *   - **signed deletions** — audit-log rows whose action is a
 *     deletion (`delete_memory`, `delete_conversation`, `flush_record`).
 *     Each carries a signed `DeletionCertificate` per the retention
 *     policy doctrine — the count makes the governance boundary
 *     concrete: every forget operation came with cryptographic proof.
 *   - **federation peers** — `runtime.listTrustedAgents()`. The
 *     agents this motebit has trust records for. The count shows
 *     federation reach without exposing peer identities themselves.
 *
 * Web-only surface state (cookies for the cloud browser, per the
 * cookies arc shipped 2026-05-12) is layered ON TOP of this shared
 * summary by the web slash-command surface — same pattern as
 * `/sensitivity` and `/vision` decorating shared state with web-
 * specific affordances. The shared command stays surface-agnostic.
 *
 * Future dimensions: credentials accumulated, skills installed.
 * Each compounds the visibility; each waits for a clean runtime
 * accessor to surface. The pattern is additive — a new line per
 * dimension, never a re-shape of the existing ones.
 */
export async function cmdTrust(runtime: MotebitRuntime): Promise<CommandResult> {
  const conversations = runtime.listConversations();
  const receipts = runtime.getRecentReceipts();
  // `exportAll` is the public MemoryGraph aggregator; it routes
  // through the storage adapter with the runtime's bound motebitId,
  // so the trust summary is automatically scoped to this identity
  // (sovereign-floor invariant — no cross-motebit leak).
  const { nodes: memoryNodes } = await runtime.memory.exportAll();

  // Governance pillar — count signed deletion certificates from the
  // audit log. Per `docs/doctrine/retention-policy.md`, every
  // user_request deletion produces a signed certificate (mutable_pruning
  // for delete_memory, consolidation_flush for flush_record). Querying
  // with a generous limit; the audit log accrues slowly relative to
  // memory turns, so 10k captures every realistic accumulation. A user
  // who has accumulated more is a use case the audit panel covers.
  const auditRecords = await runtime.auditLog.query(runtime.motebitId as MotebitId, {
    limit: 10000,
  });
  const deletionRecords = auditRecords.filter(
    (r) => r.action.startsWith("delete_") || r.action === "flush_record",
  );
  const deletionCount = deletionRecords.length;

  // Network pillar — federation peers this motebit has accumulated
  // trust records for. `listTrustedAgents` returns the canonical
  // peer-trust view; count is the federation-reach signal without
  // surfacing peer identities at the summary level.
  const peers = await runtime.listTrustedAgents();
  const peerCount = peers.length;

  const memoryCount = memoryNodes.length;
  const conversationCount = conversations.length;
  const receiptCount = receipts.length;

  if (
    memoryCount === 0 &&
    conversationCount === 0 &&
    receiptCount === 0 &&
    deletionCount === 0 &&
    peerCount === 0
  ) {
    return {
      summary:
        "Motebit hasn't accumulated state yet. Trust builds as you converse, share, and act — come back after a few sessions.",
      data: {
        trust: {
          memories: 0,
          conversations: 0,
          receipts: 0,
          deletions: 0,
          peers: 0,
        },
      },
    };
  }

  const memoryLine = `${memoryCount} ${memoryCount === 1 ? "memory" : "memories"}`;
  const convoLine = `${conversationCount} ${conversationCount === 1 ? "conversation" : "conversations"}`;
  const receiptLine = `${receiptCount} signed ${receiptCount === 1 ? "receipt" : "receipts"}`;

  let summary = `Motebit holds ${memoryLine}, ${convoLine}, and ${receiptLine} for you.`;
  if (deletionCount > 0) {
    // Governance pillar surfaced in-line: every deletion came with a
    // signed certificate. Sovereignty made concrete.
    summary += ` ${deletionCount} signed ${deletionCount === 1 ? "deletion" : "deletions"} on the audit trail.`;
  }
  if (peerCount > 0) {
    // Network pillar surfaced in-line: federation reach.
    summary += ` ${peerCount} federation ${peerCount === 1 ? "peer" : "peers"} known.`;
  }

  const detailLines: string[] = [];
  if (memoryCount > 0) {
    // Sensitivity distribution — the governance signal at the memory
    // surface. A user looking at the trust summary should see what
    // kinds of memories motebit holds, not just the count.
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
  if (deletionCount > 0) {
    // Deletion-action breakdown — what KINDS of forget operations the
    // user has driven. delete_memory (specific node), delete_conversation
    // (whole conversation), flush_record (consolidation-cycle compaction).
    const byAction = new Map<string, number>();
    for (const r of deletionRecords) {
      byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
    }
    const actionLine = [...byAction.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([action, count]) => `${count} ${action}`)
      .join(", ");
    detailLines.push(`Deletion breakdown: ${actionLine}`);
  }

  return {
    summary,
    detail: detailLines.length > 0 ? detailLines.join("\n") : undefined,
    data: {
      trust: {
        memories: memoryCount,
        conversations: conversationCount,
        receipts: receiptCount,
        deletions: deletionCount,
        peers: peerCount,
      },
    },
  };
}
