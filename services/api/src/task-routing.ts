/**
 * Task routing functions extracted from index.ts.
 *
 * Provides fetchPeerEdges, buildCandidateProfiles, fetchFederatedCandidates,
 * and queryLocalAgents — all DB-backed helpers used by task submission,
 * market candidate endpoints, graph query endpoints, and federation discovery.
 */

import type { CandidateProfile, TaskRequirements } from "@motebit/market";
import type { CapabilityPrice, AgentTrustRecord } from "@motebit/sdk";
import { asMotebitId, asListingId, AgentTrustLevel } from "@motebit/sdk";
import type { ListingId } from "@motebit/sdk";
import { hexPublicKeyToDidKey } from "@motebit/crypto";
import type { DatabaseDriver } from "@motebit/persistence";
import type { RelayIdentity, FederationConfig } from "./federation.js";

export interface TaskRouterDeps {
  db: DatabaseDriver;
  relayIdentity: RelayIdentity;
  federationConfig?: FederationConfig;
}

export interface TaskRouter {
  fetchPeerEdges(): Array<{
    from: string;
    to: string;
    weight: {
      trust: number;
      cost: number;
      latency: number;
      reliability: number;
      regulatory_risk: number;
    };
  }>;
  buildCandidateProfiles(
    capabilityFilter?: string,
    maxBudget?: number,
    limit?: number,
    callerMotebitId?: string,
  ): { profiles: CandidateProfile[]; requirements: TaskRequirements };
  fetchFederatedCandidates(
    requiredCaps: string[],
    callerMotebitId?: string,
  ): Promise<{
    candidates: { profile: CandidateProfile; _source_relay_endpoint: string }[];
    federationEdges: Array<{
      from: string;
      to: string;
      weight: {
        trust: number;
        cost: number;
        latency: number;
        reliability: number;
        regulatory_risk: number;
      };
    }>;
    peerRelayNodes: Array<{
      peerRelayId: string;
      trust: number;
      latency: number;
      reliability: number;
    }>;
  }>;
  queryLocalAgents(
    capability?: string,
    motebitId?: string,
    limit?: number,
  ): Array<{
    motebit_id: string;
    public_key: string;
    did?: string;
    endpoint_url: string;
    capabilities: string[];
    metadata: Record<string, unknown> | null;
  }>;
  /**
   * Record a federation forward result (success or failure) for circuit breaker evaluation.
   * On failure, increments failed_forwards and suspends the peer if the failure rate
   * exceeds the threshold (3+ consecutive failures or >50% failure rate over last 10).
   */
  recordPeerForwardResult(peerEndpoint: string, success: boolean): void;
}

export function createTaskRouter(deps: TaskRouterDeps): TaskRouter {
  const { db, relayIdentity } = deps;

  // Helper: fetch recent delegation edges for multi-hop routing.
  function fetchPeerEdges(): Array<{
    from: string;
    to: string;
    weight: {
      trust: number;
      cost: number;
      latency: number;
      reliability: number;
      regulatory_risk: number;
    };
  }> {
    try {
      const rows = db
        .prepare(
          `SELECT from_motebit_id, to_motebit_id, trust, cost, latency_ms, reliability, regulatory_risk
           FROM relay_delegation_edges
           WHERE recorded_at > ?
           ORDER BY recorded_at DESC LIMIT 500`,
        )
        .all(Date.now() - 30 * 24 * 60 * 60 * 1000) as Array<{
        from_motebit_id: string;
        to_motebit_id: string;
        trust: number;
        cost: number;
        latency_ms: number;
        reliability: number;
        regulatory_risk: number;
      }>;
      return rows.map((row) => ({
        from: row.from_motebit_id,
        to: row.to_motebit_id,
        weight: {
          trust: row.trust,
          cost: row.cost,
          latency: row.latency_ms,
          reliability: row.reliability,
          regulatory_risk: row.regulatory_risk,
        },
      }));
    } catch {
      return [];
    }
  }

  function buildCandidateProfiles(
    capabilityFilter?: string,
    maxBudget?: number,
    limit = 20,
    callerMotebitId?: string,
  ): { profiles: CandidateProfile[]; requirements: TaskRequirements } {
    const now = Date.now();

    // Query service listings, optionally filtered by capability
    let listingRows: Array<Record<string, unknown>>;
    if (capabilityFilter) {
      listingRows = db
        .prepare(
          `SELECT l.*, r.public_key, r.expires_at
           FROM relay_service_listings l
           LEFT JOIN agent_registry r ON l.motebit_id = r.motebit_id
           WHERE EXISTS (SELECT 1 FROM json_each(l.capabilities) WHERE value = ?)
           LIMIT ?`,
        )
        .all(capabilityFilter, limit) as Array<Record<string, unknown>>;
    } else {
      listingRows = db
        .prepare(
          `SELECT l.*, r.public_key, r.expires_at
           FROM relay_service_listings l
           LEFT JOIN agent_registry r ON l.motebit_id = r.motebit_id
           LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
    }

    // Batch-fetch latency stats for all candidates in one query
    const latencyStmt = db.prepare(
      `SELECT latency_ms FROM relay_latency_stats
       WHERE remote_motebit_id = ?
       ORDER BY recorded_at DESC LIMIT 100`,
    );

    const profiles: CandidateProfile[] = listingRows.map((row) => {
      const mid = row.motebit_id as string;
      const isOnline =
        (row.expires_at as number | null) != null && (row.expires_at as number) > now;

      const latencyRows = latencyStmt.all(mid) as Array<{ latency_ms: number }>;
      let latencyStats: { avg_ms: number; p95_ms: number; sample_count: number } | null = null;
      if (latencyRows.length > 0) {
        const vals = latencyRows.map((r) => r.latency_ms);
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sorted = [...vals].sort((a, b) => a - b);
        const p95Idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
        latencyStats = { avg_ms: avg, p95_ms: sorted[p95Idx]!, sample_count: vals.length };
      }

      const capabilities = JSON.parse(row.capabilities as string) as string[];
      const pricing = JSON.parse(row.pricing as string) as CapabilityPrice[];

      // Fetch caller's trust record for this candidate (enables semiring routing).
      // Uses raw DB query (sync) to stay in the synchronous .map() context.
      let trust_record: AgentTrustRecord | null = null;
      if (callerMotebitId) {
        const trustRow = db
          .prepare(`SELECT * FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?`)
          .get(callerMotebitId, mid) as Record<string, unknown> | undefined;
        if (trustRow) {
          trust_record = {
            motebit_id: asMotebitId(trustRow.motebit_id as string),
            remote_motebit_id: asMotebitId(trustRow.remote_motebit_id as string),
            trust_level: trustRow.trust_level as string as AgentTrustLevel,
            public_key: trustRow.public_key as string | undefined,
            first_seen_at: trustRow.first_seen_at as number,
            last_seen_at: trustRow.last_seen_at as number,
            interaction_count: trustRow.interaction_count as number,
            successful_tasks: (trustRow.successful_tasks as number | null) ?? 0,
            failed_tasks: (trustRow.failed_tasks as number | null) ?? 0,
            notes: trustRow.notes as string | undefined,
          };
        }
      }

      return {
        motebit_id: asMotebitId(mid),
        trust_record,
        listing: {
          listing_id: asListingId(row.listing_id as string),
          motebit_id: asMotebitId(mid),
          capabilities,
          pricing,
          sla: {
            max_latency_ms: row.sla_max_latency_ms as number,
            availability_guarantee: row.sla_availability as number,
          },
          description: row.description as string,
          regulatory_risk: (row.regulatory_risk as number | null) ?? undefined,
          updated_at: row.updated_at as number,
        },
        latency_stats: latencyStats,
        is_online: isOnline,
      } satisfies CandidateProfile;
    });

    const requirements: TaskRequirements = {
      required_capabilities: capabilityFilter ? [capabilityFilter] : [],
      max_budget: maxBudget,
    };

    return { profiles, requirements };
  }

  /**
   * Fetch candidate profiles from active peer relays via federation discovery.
   * Returns candidates, federation topology edges (peerRelay → agent), and peer
   * relay node metadata so the caller can build selfId → peerRelay edges.
   * The semiring graph composes trust multiplicatively along paths automatically —
   * chain_trust is left undefined on federated profiles.
   */
  async function fetchFederatedCandidates(
    requiredCaps: string[],
    _callerMotebitId?: string,
  ): Promise<{
    candidates: { profile: CandidateProfile; _source_relay_endpoint: string }[];
    federationEdges: Array<{
      from: string;
      to: string;
      weight: {
        trust: number;
        cost: number;
        latency: number;
        reliability: number;
        regulatory_risk: number;
      };
    }>;
    peerRelayNodes: Array<{
      peerRelayId: string;
      trust: number;
      latency: number;
      reliability: number;
    }>;
  }> {
    const peers = db
      .prepare(
        "SELECT peer_relay_id, endpoint_url, trust_score FROM relay_peers WHERE state = 'active'",
      )
      .all() as Array<{ peer_relay_id: string; endpoint_url: string; trust_score: number }>;

    if (peers.length === 0) return { candidates: [], federationEdges: [], peerRelayNodes: [] };

    const queryId = crypto.randomUUID();
    const visited = [relayIdentity.relayMotebitId];

    // Collect peer relay nodes for the caller to create selfId → peerRelayId edges
    const peerRelayNodes: Array<{
      peerRelayId: string;
      trust: number;
      latency: number;
      reliability: number;
    }> = [];

    const allFederationEdges: Array<{
      from: string;
      to: string;
      weight: {
        trust: number;
        cost: number;
        latency: number;
        reliability: number;
        regulatory_risk: number;
      };
    }> = [];

    const promises = peers.map(async (peer) => {
      try {
        const resp = await fetch(`${peer.endpoint_url}/federation/v1/discover`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-ID": queryId },
          body: JSON.stringify({
            query: { capability: requiredCaps[0], limit: 20 },
            hop_count: 0,
            max_hops: 1, // Only one hop for task routing candidates
            visited,
            query_id: queryId,
            origin_relay: relayIdentity.relayMotebitId,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];
        const data = (await resp.json()) as {
          agents: Array<{
            motebit_id: string;
            capabilities: string[];
            public_key?: string;
            endpoint_url?: string;
            source_relay?: string;
          }>;
        };
        if (data.agents == null || data.agents.length === 0) return [];

        const MAX_CANDIDATES_PER_PEER = 50;
        const agents = (data.agents ?? []).slice(0, MAX_CANDIDATES_PER_PEER);

        const peerTrust = peer.trust_score ?? 0.5;

        // Register this peer relay as a node for the topology
        peerRelayNodes.push({
          peerRelayId: peer.peer_relay_id,
          trust: peerTrust,
          latency: 200, // Default cross-relay latency estimate
          reliability: 0.99,
        });

        const results: { profile: CandidateProfile; _source_relay_endpoint: string }[] = [];

        for (const agent of agents) {
          // Filter to agents matching ALL required capabilities
          if (requiredCaps.length > 1) {
            if (!requiredCaps.every((cap) => agent.capabilities?.includes(cap))) continue;
          }
          // Skip agents that are local (already covered by local candidate search)
          if (agent.source_relay === relayIdentity.relayMotebitId) continue;

          // Create peerRelayId → agentId edge for the semiring graph.
          // Default agent trust 0.5 since peer relay doesn't expose per-agent trust in discovery.
          allFederationEdges.push({
            from: peer.peer_relay_id,
            to: agent.motebit_id,
            weight: {
              trust: 0.5,
              cost: 0,
              latency: 0,
              reliability: 0.99,
              regulatory_risk: 0,
            },
          });

          results.push({
            profile: {
              motebit_id: asMotebitId(agent.motebit_id),
              trust_record: null, // No local trust record for remote agents
              listing: {
                // Synthetic listing from discovery -- capabilities are known, pricing is not
                listing_id: `federated-${agent.motebit_id}` as unknown as ListingId,
                motebit_id: asMotebitId(agent.motebit_id),
                capabilities: agent.capabilities ?? [],
                pricing: [],
                sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
                description: "",
                updated_at: Date.now(),
              },
              latency_stats: null, // No local latency data for remote agents
              is_online: true, // Peer discovery returned them, assume available
              chain_trust: undefined, // Let the semiring graph compose trust along paths
            },
            _source_relay_endpoint: peer.endpoint_url,
          });
        }
        return results;
      } catch {
        // Record discover failure for circuit breaker evaluation
        recordPeerForwardResult(peer.endpoint_url, false);
        return []; // Best-effort: peer failure doesn't block local routing
      }
    });

    const settled = await Promise.allSettled(promises);
    const MAX_TOTAL_FEDERATED = 100;
    const candidates = settled
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          { profile: CandidateProfile; _source_relay_endpoint: string }[]
        > => r.status === "fulfilled",
      )
      .flatMap((r) => r.value)
      .slice(0, MAX_TOTAL_FEDERATED);

    return { candidates, federationEdges: allFederationEdges, peerRelayNodes };
  }

  // Helper: query local agent_registry -- shared by discover endpoint and federation handler
  function queryLocalAgents(
    capability?: string,
    motebitId?: string,
    limit = 20,
  ): Array<{
    motebit_id: string;
    public_key: string;
    did?: string;
    endpoint_url: string;
    capabilities: string[];
    metadata: Record<string, unknown> | null;
  }> {
    const now = Date.now();

    let rows: Array<Record<string, unknown>>;

    if (capability && motebitId) {
      rows = db
        .prepare(
          `
        SELECT * FROM agent_registry
        WHERE expires_at > ? AND motebit_id = ?
          AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)
        LIMIT ?
      `,
        )
        .all(now, motebitId, capability, limit) as Array<Record<string, unknown>>;
    } else if (capability) {
      rows = db
        .prepare(
          `
        SELECT * FROM agent_registry
        WHERE expires_at > ?
          AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)
        LIMIT ?
      `,
        )
        .all(now, capability, limit) as Array<Record<string, unknown>>;
    } else if (motebitId) {
      rows = db
        .prepare(
          `
        SELECT * FROM agent_registry WHERE expires_at > ? AND motebit_id = ? LIMIT ?
      `,
        )
        .all(now, motebitId, limit) as Array<Record<string, unknown>>;
    } else {
      rows = db
        .prepare(
          `
        SELECT * FROM agent_registry WHERE expires_at > ? LIMIT ?
      `,
        )
        .all(now, limit) as Array<Record<string, unknown>>;
    }

    return rows.map((r) => {
      const pk = r.public_key as string;
      let agentDid: string | undefined;
      try {
        if (pk) agentDid = hexPublicKeyToDidKey(pk);
      } catch {
        // Non-fatal
      }
      return {
        motebit_id: r.motebit_id as string,
        public_key: pk,
        did: agentDid,
        endpoint_url: r.endpoint_url as string,
        capabilities: JSON.parse(r.capabilities as string) as string[],
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- DB row field is untyped
        metadata: r.metadata ? (JSON.parse(r.metadata as string) as Record<string, unknown>) : null,
      };
    });
  }

  // Circuit breaker: track per-peer forward results and suspend peers exceeding failure thresholds.
  const CIRCUIT_BREAKER_CONSECUTIVE_FAILURES = 3;
  const CIRCUIT_BREAKER_MIN_SAMPLE = 6;
  const CIRCUIT_BREAKER_FAILURE_RATE = 0.5;

  function recordPeerForwardResult(peerEndpoint: string, success: boolean): void {
    const col = success ? "successful_forwards" : "failed_forwards";
    db.prepare(`UPDATE relay_peers SET ${col} = ${col} + 1 WHERE endpoint_url = ?`).run(
      peerEndpoint,
    );

    if (!success) {
      // Evaluate circuit breaker: suspend peer if failure rate exceeds threshold.
      const peer = db
        .prepare(
          "SELECT peer_relay_id, state, successful_forwards, failed_forwards FROM relay_peers WHERE endpoint_url = ? AND state = 'active'",
        )
        .get(peerEndpoint) as
        | {
            peer_relay_id: string;
            state: string;
            successful_forwards: number;
            failed_forwards: number;
          }
        | undefined;

      if (peer) {
        const total = peer.successful_forwards + peer.failed_forwards;
        const shouldSuspend =
          // Consecutive failures: if last N forwards all failed
          peer.failed_forwards >= CIRCUIT_BREAKER_CONSECUTIVE_FAILURES &&
          total >= CIRCUIT_BREAKER_MIN_SAMPLE &&
          peer.failed_forwards / total > CIRCUIT_BREAKER_FAILURE_RATE;

        if (shouldSuspend) {
          db.prepare("UPDATE relay_peers SET state = 'suspended' WHERE peer_relay_id = ?").run(
            peer.peer_relay_id,
          );
        }
      }
    } else {
      // On success, reset failed_forwards to prevent stale failures from accumulating.
      // This gives the peer a clean slate after recovering.
      db.prepare(
        "UPDATE relay_peers SET failed_forwards = 0 WHERE endpoint_url = ? AND state = 'active'",
      ).run(peerEndpoint);
    }
  }

  return {
    fetchPeerEdges,
    buildCandidateProfiles,
    fetchFederatedCandidates,
    queryLocalAgents,
    recordPeerForwardResult,
  };
}

// ---------------------------------------------------------------------------
// HTTP MCP Task Forwarding
// ---------------------------------------------------------------------------

/** JSON-RPC response shape from MCP tool calls. */
interface McpJsonRpcResponse {
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

/** Minimal receipt fields needed to validate ingestion. */
export interface ReceiptCandidate {
  motebit_id: string;
  signature: string;
  task_id?: string;
  status?: string;
  result?: string;
  [key: string]: unknown;
}

function isReceiptCandidate(v: unknown): v is ReceiptCandidate {
  if (v == null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.signature === "string" && typeof r.motebit_id === "string";
}

/**
 * Forward a task to an agent's MCP endpoint via HTTP StreamableHTTP.
 * Called as fire-and-forget when no WebSocket connection is available.
 * On success, stores the receipt in the task queue for polling.
 */
export async function forwardTaskViaMcp(
  endpointUrl: string,
  taskId: string,
  prompt: string,
  agentId: string,
  taskQueue: Map<string, { task: { status: string }; receipt?: unknown }>,
  logger: {
    info: (msg: string, ctx: Record<string, unknown>) => void;
    warn: (msg: string, ctx: Record<string, unknown>) => void;
  },
  apiToken?: string,
  onReceipt?: (receipt: ReceiptCandidate) => Promise<void>,
): Promise<void> {
  const mcpEndpoint = endpointUrl.endsWith("/mcp") ? endpointUrl : `${endpointUrl}/mcp`;
  const mcpHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (apiToken) mcpHeaders["Authorization"] = `Bearer ${apiToken}`;

  try {
    // Step 1: Initialize MCP session
    const initResp = await fetch(mcpEndpoint, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "relay-forward", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const sessionId = initResp.headers.get("mcp-session-id");
    if (sessionId) mcpHeaders["Mcp-Session-Id"] = sessionId;

    // Step 2: Send initialized notification
    await fetch(mcpEndpoint, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(5000),
    });

    // Step 3: Call motebit_task
    const taskResp = await fetch(mcpEndpoint, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        id: 2,
        params: { name: "motebit_task", arguments: { prompt, relay_task_id: taskId } },
      }),
      signal: AbortSignal.timeout(120000),
    });

    // Step 4: Parse JSON-RPC response (SSE or plain JSON)
    const mcpResult = await parseMcpResponse(taskResp, 2);

    // Step 5: Extract and ingest receipt
    if (mcpResult?.result?.content) {
      const textContent = mcpResult.result.content.find((c) => c.type === "text");
      if (textContent?.text) {
        const receiptData = extractReceipt(textContent.text);
        if (receiptData) {
          const qEntry = taskQueue.get(taskId);
          if (qEntry) {
            qEntry.task.status = "completed";
            qEntry.receipt = receiptData;
            logger.info("task.mcp_forward_completed", {
              correlationId: taskId,
              agent: agentId,
              endpoint: mcpEndpoint,
            });
            // Invoke settlement callback (orchestration layer handles economics)
            if (onReceipt) {
              try {
                await onReceipt(receiptData);
              } catch (settlementErr) {
                logger.warn("task.mcp_forward_settlement_failed", {
                  correlationId: taskId,
                  agent: agentId,
                  error:
                    settlementErr instanceof Error ? settlementErr.message : String(settlementErr),
                });
              }
            }
          }
        } else {
          logger.warn("task.mcp_forward_receipt_invalid", {
            correlationId: taskId,
            agent: agentId,
            endpoint: mcpEndpoint,
            textPreview: textContent.text.slice(0, 200),
          });
        }
      }
    }
  } catch (err: unknown) {
    logger.warn("task.mcp_forward_failed", {
      correlationId: taskId,
      agent: agentId,
      endpoint: mcpEndpoint,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function parseMcpResponse(
  resp: Response,
  expectedId: number,
): Promise<McpJsonRpcResponse | null> {
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6)) as McpJsonRpcResponse;
          if (parsed.id === expectedId) return parsed;
        } catch {
          /* skip malformed SSE line */
        }
      }
    }
    return null;
  }
  if (resp.ok) {
    return (await resp.json()) as McpJsonRpcResponse;
  }
  return null;
}

function extractReceipt(text: string): ReceiptCandidate | null {
  // Strip identity tag appended by formatResult (e.g. "\n[motebit:019d03fd key:7e08e3c0]")
  const stripped = text.replace(/\n\[motebit:[^\]]*\]\s*$/, "").trim();
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (parsed == null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    // Receipt may be nested under .receipt or at top level
    const candidate = obj.receipt != null && typeof obj.receipt === "object" ? obj.receipt : obj;
    return isReceiptCandidate(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
