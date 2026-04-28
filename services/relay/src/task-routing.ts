/**
 * Task routing functions extracted from index.ts.
 *
 * Provides fetchPeerEdges, buildCandidateProfiles, fetchFederatedCandidates,
 * and queryLocalAgents — all DB-backed helpers used by task submission,
 * market candidate endpoints, graph query endpoints, and federation discovery.
 */

import type { CandidateProfile, TaskRequirements } from "@motebit/market";
import { aggregateCredentialReputation, aggregateHardwareAttestation } from "@motebit/market";
import type { ReputationVC, TrustVC } from "@motebit/market";
import type { CapabilityPrice, AgentTrustRecord } from "@motebit/sdk";
import { asMotebitId, asListingId, AgentTrustLevel } from "@motebit/sdk";
import { trustLevelToScore } from "@motebit/market";
import type { ListingId } from "@motebit/sdk";
import { hexPublicKeyToDidKey, didKeyToPublicKey, bytesToHex } from "@motebit/encryption";
import type { DatabaseDriver } from "@motebit/persistence";
import type { RelayIdentity, FederationConfig } from "./federation.js";
import { CircuitBreaker } from "@motebit/circuit-breaker";
import type { CircuitBreakerConfig, CircuitBreakerState } from "@motebit/circuit-breaker";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "task-routing" });
const circuitBreakerLogger = createLogger({ service: "relay", module: "circuit-breaker" });

/**
 * Freshness bands for agent liveness. Computed from `last_heartbeat` age
 * at query time, exposed on every discovery response. Render hint only —
 * routing still considers dormant/cold candidates; wake-on-delegation
 * takes care of reachability. Keep the thresholds as named constants so
 * drift between server, tests, and UI copy stays easy to audit.
 */
export const FRESHNESS_AWAKE_MS = 6 * 60 * 1000; // one heartbeat cycle (5m) + slack
export const FRESHNESS_RECENT_MS = 30 * 60 * 1000; // missed a cycle, still likely reachable
export const FRESHNESS_DORMANT_MS = 24 * 60 * 60 * 1000; // asleep but wakeable

export type AgentFreshness = "awake" | "recently_seen" | "dormant" | "cold";

export function computeFreshness(lastSeenAt: number, now: number): AgentFreshness {
  const ageMs = now - lastSeenAt;
  if (ageMs < FRESHNESS_AWAKE_MS) return "awake";
  if (ageMs < FRESHNESS_RECENT_MS) return "recently_seen";
  if (ageMs < FRESHNESS_DORMANT_MS) return "dormant";
  return "cold";
}

export interface TaskRouterDeps {
  db: DatabaseDriver;
  relayIdentity: RelayIdentity;
  federationConfig?: FederationConfig;
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
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
    federatedOnly?: boolean,
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
  /**
   * Check if forwarding to a peer is allowed by the circuit breaker.
   * Returns false when the circuit is OPEN and the reset timeout hasn't elapsed.
   */
  canForward(peerEndpoint: string): boolean;
  /**
   * Get circuit breaker state for a specific peer (observability).
   */
  getCircuitBreakerState(peerEndpoint: string): CircuitBreakerState;
  /**
   * Get circuit breaker states for all tracked peers (observability).
   */
  getAllCircuitBreakerStates(): Map<string, CircuitBreakerState>;
  /**
   * Reset a peer's circuit breaker state (manual intervention).
   */
  resetCircuitBreaker(peerEndpoint: string): void;
}

export function createTaskRouter(deps: TaskRouterDeps): TaskRouter {
  const { db, relayIdentity } = deps;
  const circuitBreaker = new CircuitBreaker({
    config: deps.circuitBreakerConfig,
    logger: circuitBreakerLogger,
  });

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

    // Query service listings, optionally filtered by capability.
    // `last_heartbeat` is pulled so the candidate's freshness can drive
    // `is_online` instead of the old `expires_at > now` gate (which
    // created a visibility deadlock with Fly.io auto_stop).
    let listingRows: Array<Record<string, unknown>>;
    if (capabilityFilter) {
      listingRows = db
        .prepare(
          `SELECT l.*, r.public_key, r.last_heartbeat, r.guardian_public_key, r.endpoint_url AS agent_endpoint_url
           FROM relay_service_listings l
           LEFT JOIN agent_registry r ON l.motebit_id = r.motebit_id
           WHERE EXISTS (SELECT 1 FROM json_each(l.capabilities) WHERE value = ?)
           LIMIT ?`,
        )
        .all(capabilityFilter, limit) as Array<Record<string, unknown>>;
    } else {
      listingRows = db
        .prepare(
          `SELECT l.*, r.public_key, r.last_heartbeat, r.guardian_public_key, r.endpoint_url AS agent_endpoint_url
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

    // Credential aggregation: fetch peer-issued reputation VCs for each candidate.
    // The issuer trust callback resolves did:key URIs to trust scores from agent_trust.
    const credStmt = db.prepare(
      `SELECT credential_json FROM relay_credentials
       WHERE subject_motebit_id = ? AND credential_type = 'AgentReputationCredential'
       ORDER BY issued_at DESC LIMIT 50`,
    );
    // Hardware-attestation aggregation: peer-issued AgentTrustCredentials carrying
    // `hardware_attestation` claims. Phase 1 of the hardware-attestation peer flow.
    // The aggregator filters self-issued claims (issuer === subject.id) by the same
    // rule the reputation aggregator uses; only peer-verified claims drive routing.
    const trustCredStmt = db.prepare(
      `SELECT credential_json FROM relay_credentials
       WHERE subject_motebit_id = ? AND credential_type = 'AgentTrustCredential'
       ORDER BY issued_at DESC LIMIT 50`,
    );
    const issuerTrustStmt = callerMotebitId
      ? db.prepare(
          `SELECT trust_level FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = (
             SELECT motebit_id FROM agent_registry WHERE public_key = ? LIMIT 1
           )`,
        )
      : null;

    // Revocation check for credential aggregation — filters out revoked VCs.
    const revokedStmt = db.prepare(
      "SELECT 1 FROM relay_revoked_credentials WHERE credential_id = ?",
    );
    function checkRevoked(credentialId: string): boolean {
      return revokedStmt.get(credentialId) != null;
    }

    function getIssuerTrust(issuerDid: string): number {
      if (!callerMotebitId || !issuerTrustStmt) return 0.3;
      try {
        const pubBytes = didKeyToPublicKey(issuerDid);
        const pubHex = bytesToHex(pubBytes);
        const row = issuerTrustStmt.get(callerMotebitId, pubHex) as
          | { trust_level: string }
          | undefined;
        if (!row) return 0.1;
        return trustLevelToScore(row.trust_level as AgentTrustLevel);
      } catch {
        return 0.3; // Fallback for non-did:key issuers or lookup failures
      }
    }

    const profiles: CandidateProfile[] = listingRows.map((row) => {
      const mid = row.motebit_id as string;
      // `is_online` now means "is this candidate's freshness good enough
      // to route without a wake delay?" — awake/recently_seen pass as
      // online; dormant/cold fall through but remain rankable. Wake-on-
      // delegation (see `forwardTaskViaMcp`) will wake them before MCP
      // init if selected.
      const lastHeartbeat = row.last_heartbeat as number | null;
      const isOnline =
        lastHeartbeat != null &&
        (computeFreshness(lastHeartbeat, now) === "awake" ||
          computeFreshness(lastHeartbeat, now) === "recently_seen");

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

      // Aggregate peer-issued credentials for this candidate
      let credential_reputation: CandidateProfile["credential_reputation"];
      try {
        const credRows = credStmt.all(mid) as Array<{ credential_json: string }>;
        if (credRows.length > 0) {
          const vcs = credRows
            .map((r) => {
              try {
                return JSON.parse(r.credential_json) as ReputationVC;
              } catch {
                return null;
              }
            })
            .filter((vc): vc is ReputationVC => vc != null);
          if (vcs.length > 0) {
            credential_reputation =
              aggregateCredentialReputation(vcs, getIssuerTrust, { checkRevoked }) ?? undefined;
          }
        }
      } catch {
        // Best-effort: credential aggregation failure doesn't block routing
      }

      // Aggregate peer-issued AgentTrustCredentials carrying hardware_attestation.
      // Drives the hardware-attestation dimension of routing edges via
      // graph-routing.ts:setEdge — peer-verified claims dominate self-attestation.
      let hardware_attestation_aggregate: CandidateProfile["hardware_attestation_aggregate"];
      try {
        const trustRows = trustCredStmt.all(mid) as Array<{ credential_json: string }>;
        if (trustRows.length > 0) {
          const vcs = trustRows
            .map((r) => {
              try {
                return JSON.parse(r.credential_json) as TrustVC;
              } catch {
                return null;
              }
            })
            .filter((vc): vc is TrustVC => vc != null);
          if (vcs.length > 0) {
            hardware_attestation_aggregate =
              aggregateHardwareAttestation(vcs, getIssuerTrust, { checkRevoked }) ?? undefined;
          }
        }
      } catch {
        // Best-effort: hardware-attestation aggregation failure doesn't block routing
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
          pay_to_address: (row.pay_to_address as string | null) ?? undefined,
          regulatory_risk: (row.regulatory_risk as number | null) ?? undefined,
          updated_at: row.updated_at as number,
        },
        latency_stats: latencyStats,
        is_online: isOnline,
        credential_reputation,
        hardware_attestation_aggregate,
        guardian_public_key: (row.guardian_public_key as string | null) ?? undefined,
        endpoint_url: (row.agent_endpoint_url as string | null) ?? undefined,
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
      // Skip peers whose circuit breaker is OPEN (not yet ready for probing)
      if (!circuitBreaker.canForward(peer.endpoint_url)) {
        logger.info("federation.discover.circuit_open", {
          peerRelay: peer.endpoint_url,
          peerId: peer.peer_relay_id,
        });
        return [];
      }

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
  //
  // Returns the canonical "marketplace card" shape: identity + capabilities +
  // pricing (when a service listing exists) + last_seen_at. Trust info is layered
  // in by the discover endpoint based on the authenticated caller; queryLocalAgents
  // itself is caller-agnostic so federation peers receive consistent data.
  function queryLocalAgents(
    capability?: string,
    motebitId?: string,
    limit = 20,
    /** When true, exclude agents with federation_visible = 0 (cross-relay privacy opt-out). */
    federatedOnly = false,
  ): Array<{
    motebit_id: string;
    public_key: string;
    did?: string;
    endpoint_url: string;
    capabilities: string[];
    metadata: Record<string, unknown> | null;
    /** Per-capability pricing (from relay_service_listings), null if no listing exists. */
    pricing: Array<{ capability: string; unit_cost: number; currency: string; per: string }> | null;
    /** Last heartbeat timestamp from agent_registry. */
    last_seen_at: number;
    /**
     * Liveness discriminant derived from `last_heartbeat` age at query time.
     * - `awake` — within one heartbeat cycle + slack (< 6 min)
     * - `recently_seen` — missed a cycle, still likely reachable (< 30 min)
     * - `dormant` — asleep but wake-on-delegation should reach it (< 24 h)
     * - `cold` — long asleep, wake latency uncertain (≥ 24 h)
     * Render hint only; routing still considers dormant/cold candidates.
     */
    freshness: "awake" | "recently_seen" | "dormant" | "cold";
  }> {
    const now = Date.now();
    // Filter out revoked entries and federation opt-outs when appropriate.
    // No `expires_at > now` filter: discoverability is a protocol property,
    // not a heartbeat property. `last_heartbeat` drives the freshness
    // discriminant below, which is a render hint for the caller.
    const revokedFilter = " AND (revoked IS NULL OR revoked = 0)";
    const fedFilter = federatedOnly
      ? " AND (federation_visible IS NULL OR federation_visible != 0)"
      : "";

    let rows: Array<Record<string, unknown>>;

    if (capability && motebitId) {
      rows = db
        .prepare(
          `
        SELECT * FROM agent_registry
        WHERE motebit_id = ?
          AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)${revokedFilter}${fedFilter}
        LIMIT ?
      `,
        )
        .all(motebitId, capability, limit) as Array<Record<string, unknown>>;
    } else if (capability) {
      rows = db
        .prepare(
          `
        SELECT * FROM agent_registry
        WHERE EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)${revokedFilter}${fedFilter}
        LIMIT ?
      `,
        )
        .all(capability, limit) as Array<Record<string, unknown>>;
    } else if (motebitId) {
      rows = db
        .prepare(
          `
        SELECT * FROM agent_registry WHERE motebit_id = ?${revokedFilter}${fedFilter} LIMIT ?
      `,
        )
        .all(motebitId, limit) as Array<Record<string, unknown>>;
    } else {
      rows = db
        .prepare(
          `
        SELECT * FROM agent_registry WHERE 1=1${revokedFilter}${fedFilter} LIMIT ?
      `,
        )
        .all(limit) as Array<Record<string, unknown>>;
    }

    // Batch-fetch service listings for these agents in one query — avoids N+1
    const ids = rows.map((r) => r.motebit_id as string);
    const listingByAgent = new Map<
      string,
      Array<{ capability: string; unit_cost: number; currency: string; per: string }>
    >();
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const listingRows = db
        .prepare(
          `SELECT motebit_id, pricing FROM relay_service_listings WHERE motebit_id IN (${placeholders})`,
        )
        .all(...ids) as Array<{ motebit_id: string; pricing: string }>;
      for (const lr of listingRows) {
        try {
          const parsed = JSON.parse(lr.pricing) as Array<{
            capability: string;
            unit_cost: number;
            currency: string;
            per: string;
          }>;
          listingByAgent.set(lr.motebit_id, parsed);
        } catch {
          // Malformed listing — skip; agent will appear with pricing=null
        }
      }
    }

    return rows.map((r) => {
      const pk = r.public_key as string;
      let agentDid: string | undefined;
      try {
        if (pk) agentDid = hexPublicKeyToDidKey(pk);
      } catch {
        // Non-fatal
      }
      const id = r.motebit_id as string;
      const lastSeen = (r.last_heartbeat as number | null) ?? (r.registered_at as number);
      return {
        motebit_id: id,
        public_key: pk,
        did: agentDid,
        endpoint_url: r.endpoint_url as string,
        capabilities: JSON.parse(r.capabilities as string) as string[],
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- DB row field is untyped
        metadata: r.metadata ? (JSON.parse(r.metadata as string) as Record<string, unknown>) : null,
        pricing: listingByAgent.get(id) ?? null,
        last_seen_at: lastSeen,
        freshness: computeFreshness(lastSeen, now),
      };
    });
  }

  // Circuit breaker: delegates to the three-state CircuitBreaker class.
  // Also updates DB counters for observability (admin dashboard).

  function recordPeerForwardResult(peerEndpoint: string, success: boolean): void {
    const col = success ? "successful_forwards" : "failed_forwards";
    db.prepare(`UPDATE relay_peers SET ${col} = ${col} + 1 WHERE endpoint_url = ?`).run(
      peerEndpoint,
    );

    if (success) {
      circuitBreaker.recordSuccess(peerEndpoint);
      // Reset failed_forwards counter on success for DB-level observability.
      db.prepare(
        "UPDATE relay_peers SET failed_forwards = 0 WHERE endpoint_url = ? AND state = 'active'",
      ).run(peerEndpoint);
    } else {
      circuitBreaker.recordFailure(peerEndpoint);

      // Sync DB state: when circuit opens, mark peer as suspended in DB
      // so heartbeat and other DB-querying code sees the suspension.
      const cbState = circuitBreaker.getState(peerEndpoint);
      if (cbState.state === "open") {
        const peer = db
          .prepare(
            "SELECT peer_relay_id FROM relay_peers WHERE endpoint_url = ? AND state = 'active'",
          )
          .get(peerEndpoint) as { peer_relay_id: string } | undefined;
        if (peer) {
          db.prepare("UPDATE relay_peers SET state = 'suspended' WHERE peer_relay_id = ?").run(
            peer.peer_relay_id,
          );
          logger.warn("circuit_breaker.peer_suspended", {
            peerId: peer.peer_relay_id,
            peerEndpoint,
          });
        }
      }
    }
  }

  function canForward(peerEndpoint: string): boolean {
    return circuitBreaker.canForward(peerEndpoint);
  }

  function getCircuitBreakerState(peerEndpoint: string): CircuitBreakerState {
    return circuitBreaker.getState(peerEndpoint);
  }

  function getAllCircuitBreakerStates(): Map<string, CircuitBreakerState> {
    return circuitBreaker.getAllStates();
  }

  function resetCircuitBreaker(peerEndpoint: string): void {
    circuitBreaker.reset(peerEndpoint);
    // Re-activate the peer in DB if it was suspended by the circuit breaker.
    db.prepare(
      "UPDATE relay_peers SET state = 'active', failed_forwards = 0 WHERE endpoint_url = ? AND state = 'suspended'",
    ).run(peerEndpoint);
  }

  return {
    fetchPeerEdges,
    buildCandidateProfiles,
    fetchFederatedCandidates,
    queryLocalAgents,
    recordPeerForwardResult,
    canForward,
    getCircuitBreakerState,
    getAllCircuitBreakerStates,
    resetCircuitBreaker,
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

  // Wake-on-delegation: Fly.io `auto_stop_machines = "stop"` services
  // require an HTTP GET to trigger auto-start. MCP POSTs don't wake
  // them — a cold machine returns 503 and the task fails. Hit `/health`
  // first (5s budget — Fly cold-start is ~3-5s). Fail-open: if the
  // wake call errors we still try MCP init, whose 30s timeout absorbs
  // residual cold-start latency. The service's /health handler also
  // calls `ensureRegistered()` (packages/mcp-server/src/index.ts:1110),
  // so a successful wake also refreshes the registry entry.
  try {
    await fetch(`${endpointUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
  } catch (wakeErr) {
    logger.warn("task.agent_wake_attempted", {
      correlationId: taskId,
      agent: agentId,
      endpoint: endpointUrl,
      error: wakeErr instanceof Error ? wakeErr.message : String(wakeErr),
    });
  }

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
      // 30s timeout: Fly.io auto_stop machines need ~3-5s cold start before
      // the MCP server is ready. 10s was too tight for cold start + TLS + init.
      signal: AbortSignal.timeout(30000),
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
            taskQueue.set(taskId, qEntry); // Persist to durable queue
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

// === P2P Settlement Eligibility (policy-based) ===

/** Minimum trust score for p2p settlement (verified = 0.6). */
const P2P_MIN_TRUST_SCORE = 0.6;
/** Minimum completed interactions between the pair. */
const P2P_MIN_INTERACTIONS = 5;

/**
 * Evaluate whether a delegator→worker pair qualifies for p2p settlement.
 *
 * Policy checks:
 * 1. Both parties advertise "p2p" in settlement_modes
 * 2. Worker has a declared settlement_address
 * 3. Trust score ≥ threshold (default: 0.6 / "verified")
 * 4. Interaction count ≥ minimum (default: 5)
 * 5. No active disputes between this pair
 */
export function evaluateSettlementEligibility(
  db: DatabaseDriver,
  delegatorId: string,
  workerId: string,
): { allowed: boolean; mode: "relay" | "p2p"; reason: string } {
  // Check worker has declared settlement address
  const worker = db
    .prepare("SELECT settlement_address, settlement_modes FROM agent_registry WHERE motebit_id = ?")
    .get(workerId) as
    | { settlement_address: string | null; settlement_modes: string | null }
    | undefined;

  if (!worker?.settlement_address) {
    return { allowed: false, mode: "relay", reason: "Worker has no declared settlement address" };
  }

  // Check worker supports p2p (trim each mode for whitespace safety)
  const workerModes = (worker.settlement_modes ?? "relay").split(",").map((m) => m.trim());
  if (!workerModes.includes("p2p")) {
    return { allowed: false, mode: "relay", reason: "Worker does not support p2p settlement" };
  }

  // Check delegator supports p2p
  const delegator = db
    .prepare("SELECT settlement_modes FROM agent_registry WHERE motebit_id = ?")
    .get(delegatorId) as { settlement_modes: string | null } | undefined;

  const delegatorModes = (delegator?.settlement_modes ?? "relay").split(",").map((m) => m.trim());
  if (!delegatorModes.includes("p2p")) {
    return {
      allowed: false,
      mode: "relay",
      reason: "Delegator does not support p2p settlement",
    };
  }

  // Check trust level
  const trustRow = db
    .prepare(
      "SELECT trust_level, interaction_count FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
    )
    .get(delegatorId, workerId) as { trust_level: string; interaction_count: number } | undefined;

  if (!trustRow) {
    return { allowed: false, mode: "relay", reason: "No trust history between agents" };
  }

  const score = trustLevelToScore(trustRow.trust_level as AgentTrustLevel);
  if (score < P2P_MIN_TRUST_SCORE) {
    return {
      allowed: false,
      mode: "relay",
      reason: `Trust score ${score} below minimum ${P2P_MIN_TRUST_SCORE}`,
    };
  }

  // Check interaction count
  if (trustRow.interaction_count < P2P_MIN_INTERACTIONS) {
    return {
      allowed: false,
      mode: "relay",
      reason: `Interaction count ${trustRow.interaction_count} below minimum ${P2P_MIN_INTERACTIONS}`,
    };
  }

  // Check no active disputes between this pair
  try {
    const activeDispute = db
      .prepare(
        `SELECT dispute_id FROM relay_disputes
         WHERE ((filed_by = ? AND respondent = ?) OR (filed_by = ? AND respondent = ?))
           AND state NOT IN ('final', 'expired')
         LIMIT 1`,
      )
      .get(delegatorId, workerId, workerId, delegatorId) as { dispute_id: string } | undefined;

    if (activeDispute) {
      return {
        allowed: false,
        mode: "relay",
        reason: `Active dispute ${activeDispute.dispute_id} between agents`,
      };
    }
  } catch {
    // relay_disputes table may not exist — no disputes, allow
  }

  return {
    allowed: true,
    mode: "p2p",
    reason: `Trust ${score}, ${trustRow.interaction_count} interactions, both parties opted in`,
  };
}
