/** Market commands: balance, deposits, discover, proposals. */

import type { CommandResult, RelayConfig } from "./types.js";
import { relayFetch } from "./types.js";

export async function cmdBalance(relay: RelayConfig): Promise<CommandResult> {
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

export async function cmdDeposits(relay: RelayConfig): Promise<CommandResult> {
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

export async function cmdDiscover(relay: RelayConfig): Promise<CommandResult> {
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

export async function cmdProposals(relay: RelayConfig): Promise<CommandResult> {
  const data = (await relayFetch(relay, `/api/v1/agents/${relay.motebitId}/proposals`)) as {
    proposals: Array<{
      proposal_id: string;
      status: string;
      goal: string;
      created_at: number;
    }>;
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
