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
import type { RelayIdentity, FederationConfig } from "./federation.js";

export interface TaskRouterDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any better-sqlite3 db
  db: any;
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
  ): Promise<{ profile: CandidateProfile; _source_relay_endpoint: string }[]>;
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
   * Returns CandidateProfile[] with chain_trust composed from peer relay trust
   * and the reported agent trust. Failures are gracefully ignored (best-effort).
   */
  async function fetchFederatedCandidates(
    requiredCaps: string[],
    _callerMotebitId?: string,
  ): Promise<{ profile: CandidateProfile; _source_relay_endpoint: string }[]> {
    const peers = db
      .prepare(
        "SELECT peer_relay_id, endpoint_url, trust_score FROM relay_peers WHERE state = 'active'",
      )
      .all() as Array<{ peer_relay_id: string; endpoint_url: string; trust_score: number }>;

    if (peers.length === 0) return [];

    const queryId = crypto.randomUUID();
    const visited = [relayIdentity.relayMotebitId];

    const promises = peers.map(async (peer) => {
      try {
        const resp = await fetch(`${peer.endpoint_url}/federation/v1/discover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        if (!data.agents || data.agents.length === 0) return [];

        // Convert discovery results to CandidateProfile with chain trust
        const peerTrust = peer.trust_score ?? 0.5;
        const results: { profile: CandidateProfile; _source_relay_endpoint: string }[] = [];

        for (const agent of data.agents) {
          // Filter to agents matching ALL required capabilities
          if (requiredCaps.length > 1) {
            if (!requiredCaps.every((cap) => agent.capabilities?.includes(cap))) continue;
          }
          // Skip agents that are local (already covered by local candidate search)
          if (agent.source_relay === relayIdentity.relayMotebitId) continue;

          // Compose chain trust: local->peer relay trust x peer relay's trust in agent (default 0.5)
          const agentTrust = 0.5; // Default -- peer relay doesn't expose per-agent trust in discovery
          const chainTrust = peerTrust * agentTrust;

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
              chain_trust: chainTrust,
            },
            _source_relay_endpoint: peer.endpoint_url,
          });
        }
        return results;
      } catch {
        return []; // Best-effort: peer failure doesn't block local routing
      }
    });

    const settled = await Promise.allSettled(promises);
    return settled
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          { profile: CandidateProfile; _source_relay_endpoint: string }[]
        > => r.status === "fulfilled",
      )
      .flatMap((r) => r.value);
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

  return { fetchPeerEdges, buildCandidateProfiles, fetchFederatedCandidates, queryLocalAgents };
}
