/** Memory commands: memories, graph, curious, forget, audit. */

import type { MotebitRuntime } from "../index.js";
import type { CommandResult } from "./types.js";

export async function cmdMemories(runtime: MotebitRuntime): Promise<CommandResult> {
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

export async function cmdGraph(runtime: MotebitRuntime): Promise<CommandResult> {
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

export function cmdCurious(runtime: MotebitRuntime): CommandResult {
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

export async function cmdForget(runtime: MotebitRuntime, keyword?: string): Promise<CommandResult> {
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

  // /forget is user-driven (the slash command was typed by the
  // motebit's owner). Route through the privacy layer choke point so
  // the deletion is signed (mutable_pruning cert) and lands a
  // DeleteRequested event on the append-only log — same contract
  // every UI memory-delete affordance honors post-fix.
  await runtime.privacy.deleteMemory(match.node_id, "user_request");
  const snippet = match.content.slice(0, 60);
  return {
    summary: `Forgot: ${snippet}${match.content.length > 60 ? "..." : ""}`,
    data: { deletedId: match.node_id, content: match.content },
  };
}

export async function cmdAudit(runtime: MotebitRuntime): Promise<CommandResult> {
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
