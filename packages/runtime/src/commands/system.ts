/** System commands: state, model, tools, approvals, conversations, summarize. */

import type { MotebitRuntime } from "../index";
import type { CommandResult } from "./types";

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
