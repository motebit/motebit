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
import type { CapabilityPrice, AgentTrustRecord, SettlementEligibility } from "@motebit/sdk";
import { asMotebitId, asListingId, AgentTrustLevel } from "@motebit/sdk";
import { trustLevelToScore } from "@motebit/market";
import { verifySovereignBinding } from "@motebit/crypto";
import type { SolanaRpcAdapter } from "@motebit/wallet-solana";
import type { ListingId } from "@motebit/sdk";
import {
  getBestLiveBond,
  workerInFlightP2pCostMicro,
  markBondBacking,
  BOND_BACKING_STALENESS_MS,
} from "./bond-store.js";
import { hexPublicKeyToDidKey, didKeyToPublicKey, bytesToHex } from "@motebit/encryption";
import type { DatabaseDriver } from "@motebit/persistence";
import type { RelayIdentity, FederationConfig } from "./federation.js";
import { signDiscoverBody } from "./federation.js";
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

export /**
 * Pull the self-asserted display name out of registration metadata.
 * Trimmed + capped server-side (64 chars) so a hostile registration can't
 * bloat discover responses; render-side framing (claim, never a verified
 * handle) is the surfaces' job per agents-as-first-person-trust-graph §3.
 */
function extractDisplayName(metadataJson: string | null): string | null {
  if (metadataJson == null || metadataJson.length === 0) return null;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const name = meta["display_name"];
    if (typeof name !== "string") return null;
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 64) : null;
  } catch {
    return null;
  }
}

function computeFreshness(lastSeenAt: number, now: number): AgentFreshness {
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
    candidates: {
      profile: CandidateProfile;
      _source_relay_endpoint: string;
      /**
       * Remote worker's onchain settlement address (Solana base58), null if
       * undeclared. Carried from federated discovery so the origin relay can
       * validate the delegator's direct-P2P payment leg to a cross-relay worker
       * (cross-operator P2P funding — the relay never transmits).
       */
      _settlement_address: string | null;
    }[];
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
          { trust_level: string } | undefined;
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
    candidates: {
      profile: CandidateProfile;
      _source_relay_endpoint: string;
      /**
       * Remote worker's onchain settlement address (Solana base58), null if
       * undeclared. Carried from federated discovery so the origin relay can
       * validate the delegator's direct-P2P payment leg to a cross-relay worker
       * (cross-operator P2P funding — the relay never transmits).
       */
      _settlement_address: string | null;
    }[];
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
        // Originating hop: sign as sender_relay = this relay (== origin_relay
        // here, since we're the query's origin). relay-federation@1.3 §4.1.
        const discoverBody = await signDiscoverBody(
          {
            query: { capability: requiredCaps[0], limit: 20 },
            hop_count: 0,
            max_hops: 1, // Only one hop for task routing candidates
            visited,
            query_id: queryId,
            origin_relay: relayIdentity.relayMotebitId,
          },
          relayIdentity,
        );
        const resp = await fetch(`${peer.endpoint_url}/federation/v1/discover`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-ID": queryId },
          body: JSON.stringify(discoverBody),
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
            // Per-capability pricing from the peer's service listing. The peer's
            // discover handler spreads it from queryLocalAgents; without carrying
            // it here the origin relay can't price (and thus can't settle) a
            // cross-relay paid task — the §7 settlement chain stays inert.
            pricing?: Array<{
              capability: string;
              unit_cost: number;
              currency: string;
              per: "task" | "tool_call" | "token";
            }> | null;
            // Worker's onchain settlement address (the peer's discover handler
            // spreads it from queryLocalAgents). Carried here so the origin relay
            // can validate the delegator's direct-P2P payment leg to this remote
            // worker — the cross-operator P2P funding model (relay never transmits).
            settlement_address?: string | null;
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

        const results: {
          profile: CandidateProfile;
          _source_relay_endpoint: string;
          _settlement_address: string | null;
        }[] = [];

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
                // Synthetic listing from discovery — capabilities AND pricing
                // come from the peer's discover response (queryLocalAgents
                // spreads pricing). Carrying pricing here is what lets the origin
                // relay set a budget and initiate the §7 settlement chain for a
                // cross-relay paid task; an absent listing falls back to [].
                listing_id: `federated-${agent.motebit_id}` as unknown as ListingId,
                motebit_id: asMotebitId(agent.motebit_id),
                capabilities: agent.capabilities ?? [],
                pricing: agent.pricing ?? [],
                sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
                description: "",
                updated_at: Date.now(),
              },
              latency_stats: null, // No local latency data for remote agents
              is_online: true, // Peer discovery returned them, assume available
              chain_trust: undefined, // Let the semiring graph compose trust along paths
            },
            _source_relay_endpoint: peer.endpoint_url,
            _settlement_address: agent.settlement_address ?? null,
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
          {
            profile: CandidateProfile;
            _source_relay_endpoint: string;
            _settlement_address: string | null;
          }[]
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
    /**
     * Worker's onchain settlement address (Solana base58), null if undeclared.
     * Exposed so a delegator's client can build the direct P2P payment leg to a
     * worker discovered cross-relay (the cross-operator P2P funding model — the
     * relay never transmits; the delegator pays the worker directly).
     */
    settlement_address: string | null;
    /**
     * Worker's opted-in settlement modes (comma-joined: "p2p", "relay", or
     * "p2p,relay"), null if undeclared. Surfaced alongside `settlement_address`
     * so a delegator's client can tell which workers accept direct P2P payment
     * — the federated P2P client filters discovery candidates on `p2p` ∈ modes.
     * Without this the client's P2P path never finds a payable worker and
     * silently falls back to relay-mode.
     */
    settlement_modes: string | null;
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
    const descriptionByAgent = new Map<string, string>();
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const listingRows = db
        .prepare(
          `SELECT motebit_id, pricing, description FROM relay_service_listings WHERE motebit_id IN (${placeholders})`,
        )
        .all(...ids) as Array<{ motebit_id: string; pricing: string; description: string | null }>;
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
        // Listing description — "Used in discovery UIs" per the
        // agent-service-listing schema; server-side cap keeps a hostile
        // listing from bloating every discover response.
        if (lr.description != null && lr.description.trim().length > 0) {
          descriptionByAgent.set(lr.motebit_id, lr.description.trim().slice(0, 200));
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
        // Self-asserted display name (registration metadata) + listing
        // description, surfaced top-level so every surface adapter gets
        // them without parsing metadata. Both are CLAIMS (trust-graph §3)
        // — capped server-side; federated peers on older code simply omit
        // them (additive-optional).
        display_name: extractDisplayName(r.metadata as string | null),
        description: descriptionByAgent.get(id) ?? null,
        settlement_address: (r.settlement_address as string | null) ?? null,
        settlement_modes: (r.settlement_modes as string | null) ?? null,
        last_seen_at: lastSeen,
        freshness: computeFreshness(lastSeen, now),
      };
    });
  }

  // Circuit breaker: delegates to the three-state CircuitBreaker class.
  // Also updates DB counters for observability (operator console).

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

/** Minimum trust score for established-pair eligibility (verified = 0.6). */
const P2P_MIN_TRUST_SCORE = 0.6;
/** Minimum completed interactions for established-pair eligibility. */
const P2P_MIN_INTERACTIONS = 5;

/**
 * Reduced cold-start bar for a sovereign-bound worker (first_contact = 0.3,
 * 2 interactions). A sovereign `motebit_id` cryptographically commits to its
 * signing key (~2^122 to grind an id matching a target), so the worker cannot
 * be a cheap throwaway — the sybil risk the established-pair bar exists to
 * mitigate. This is the additive-binding pattern from
 * `docs/doctrine/hardware-attestation.md`: stronger identity assurance raises
 * standing, it never gates. The branch is placed AFTER the strict branch and
 * keyed on an offline sovereign check, so it only ever ADDS a way to qualify —
 * unbound workers never reach it and see byte-identical behavior. Real history
 * is still required (first_contact trust + ≥2 completed interactions with this
 * specific worker); sovereignty relaxes the cold-start floor, it does not
 * fabricate trust.
 */
const P2P_SOVEREIGN_MIN_TRUST_SCORE = 0.3;
const P2P_SOVEREIGN_MIN_INTERACTIONS = 2;

/**
 * Bonded-worker cold-start bar. Tiered WITH sovereign-binding, **never below**
 * it (`P2P_BONDED_MIN_* ≥ P2P_SOVEREIGN_MIN_*`): a commitment bond is a costly
 * signal in the SAME justification class as sovereign-binding (both raise the
 * cost of a disposable identity), so it earns the same modest relaxation — and
 * no more. A bond never buys a LOWER trust/interaction floor than sovereignty;
 * what it adds is a capital-based path to that floor for a worker, gated by the
 * same real-history requirement (first_contact trust + ≥2 completed
 * interactions). The bond never fabricates trust and is NEVER recourse (phase-1
 * signal only — docs/doctrine/commitment-bond.md).
 */
const P2P_BONDED_MIN_TRUST_SCORE = P2P_SOVEREIGN_MIN_TRUST_SCORE;
const P2P_BONDED_MIN_INTERACTIONS = P2P_SOVEREIGN_MIN_INTERACTIONS;

/**
 * How many multiples of the at-risk ticket value a worker must have committed
 * (and unexposed) to qualify at the bonded bar. A fixed anti-sybil coefficient
 * — NOT a per-agent trust threshold and NOT a stored cross-agent rank, so it
 * carries the `REFERENCE_` discipline (a tunable reference constant, never an
 * inward score). `bond ≥ k × (ticket + in-flight)` means a $1 ticket needs $10
 * of committed-and-unexposed backing: a serious signal, not a throwaway.
 */
const REFERENCE_BOND_COVERAGE_MULTIPLE = 10n;

/**
 * The committed-and-unexposed backing a worker must show to take on a ticket of
 * `atRiskMicro` — `k × atRiskMicro`, a pure local predicate over the ticket
 * value alone (never a stored cross-agent quantity).
 */
function requiredBondForTicket(atRiskMicro: bigint): bigint {
  return atRiskMicro * REFERENCE_BOND_COVERAGE_MULTIPLE;
}

/**
 * Opt-in context for the additive bonded-eligibility branch. When OMITTED the
 * branch is skipped entirely and `evaluateSettlementEligibility` is
 * byte-identical to its pre-bond behavior — only the submission gate, which
 * knows the ticket value, opts in. Convenience reads (e.g. agents.ts) omit it.
 */
export interface BondEligibilityContext {
  /** At-risk ticket value (worker's net unit cost), micro-USDC. */
  unitCostMicro: bigint;
  /**
   * Optional read-only RPC adapter for accept-time re-verification: when the
   * worker's freshest backing read is older than {@link BOND_BACKING_STALENESS_MS},
   * a synchronous `getUsdcBalanceOf` re-checks backing rather than trusting a
   * stale "backed". OMITTED → a stale read simply does not qualify (fail-closed,
   * never accept on stale). The verifier loop keeps most reads fresh; this seam
   * is the belt-and-suspenders for the exact-staleness edge.
   */
  adapter?: Pick<SolanaRpcAdapter, "getUsdcBalanceOf">;
  /** Clock injection (tests). */
  now?: () => number;
}

/** Outcome of the bond-coverage check, carrying the numbers for the reason. */
interface BondCoverage {
  qualifies: boolean;
  usableMicro: bigint;
  requiredMicro: bigint;
  inFlightMicro: bigint;
}

/**
 * Does the worker hold a verified, currently-backed commitment bond large
 * enough to cover this ticket PLUS its in-flight p2p exposure, at the
 * {@link REFERENCE_BOND_COVERAGE_MULTIPLE}? Two orthogonal anti-reuse defenses
 * compose here:
 *
 *   - **Cross-identity reuse** is defeated upstream by the §2 address binding
 *     (`verifyBondCommitment` at record time): the bonded capital sits at the
 *     worker's OWN sovereign address, so one wallet cannot back many identities.
 *   - **Cross-ticket reuse** is defeated here by subtracting the worker's
 *     in-flight (pending) p2p value from available backing — a worker cannot
 *     lean on one bond to back unbounded concurrent tickets.
 *
 * Backing is a LIVE fact, never a stored "backed" trusted blindly: a reading
 * older than the staleness bound is re-verified synchronously (when an adapter
 * is supplied) or treated as not-currently-backed (fail-closed). The usable
 * amount is `min(committed, observed)` — never more capital than is actually
 * present at the address right now.
 */
async function bondCoversTicket(
  db: DatabaseDriver,
  workerId: string,
  bondEval: BondEligibilityContext,
): Promise<BondCoverage> {
  const nowFn = bondEval.now ?? Date.now;
  const nowMs = nowFn();
  const inFlightMicro = workerInFlightP2pCostMicro(db, workerId);
  const requiredMicro = requiredBondForTicket(bondEval.unitCostMicro + inFlightMicro);

  const bond = getBestLiveBond(db, workerId, nowMs);
  if (!bond) {
    return { qualifies: false, usableMicro: 0n, requiredMicro, inFlightMicro };
  }

  const committed = BigInt(bond.bond_amount_micro);

  // Resolve the OBSERVED backing — fresh cache, else synchronous re-verify.
  const fresh =
    bond.last_checked_at != null && nowMs - bond.last_checked_at <= BOND_BACKING_STALENESS_MS;
  let observedMicro: bigint | null;
  if (fresh && bond.backed_amount_micro != null) {
    observedMicro = BigInt(bond.backed_amount_micro);
  } else if (bondEval.adapter) {
    // Stale or never-checked — re-read at decision time (spec/bond-v1.md §6).
    try {
      const balance = await bondEval.adapter.getUsdcBalanceOf(bond.bonded_address);
      const state = balance >= committed ? "backed" : "underbacked";
      try {
        markBondBacking(db, bond.bond_id, state, Number(balance), nowMs);
      } catch {
        // Cache refresh is best-effort; the decision uses the fresh read regardless.
      }
      observedMicro = balance;
    } catch {
      observedMicro = null; // RPC failure → fail-closed, never accept on stale
    }
  } else {
    observedMicro = null; // stale + no adapter → fail-closed
  }

  if (observedMicro === null) {
    return { qualifies: false, usableMicro: 0n, requiredMicro, inFlightMicro };
  }

  const usableMicro = observedMicro < committed ? observedMicro : committed;
  return {
    qualifies: usableMicro >= requiredMicro,
    usableMicro,
    requiredMicro,
    inFlightMicro,
  };
}

/**
 * Evaluate whether a delegator→worker pair qualifies to transact at all.
 *
 * After Arc 3 of the off-ramp arc, P2P is the only worker-settlement
 * path — there is no relay-custody fallback. This gate is the
 * delegation-eligibility check, not a settlement-routing check.
 *
 * **Disjunctive eligibility** per [`docs/doctrine/off-ramp-as-user-action.md`](../../../docs/doctrine/off-ramp-as-user-action.md):
 *
 *   eligible = established_pair OR new_pair_with_acknowledgment
 *
 * Where:
 *
 *   established_pair = trust ≥ 0.6 AND interactions ≥ 5
 *   new_pair_with_acknowledgment = delegator_acknowledges_no_history_risk
 *
 * Both branches additionally require:
 *   - worker has a declared settlement_address (else no destination)
 *   - no active disputes between this pair (structural safety)
 *
 * The `mutual opt-in via settlement_modes` check from the pre-Arc-3
 * gate collapses post-Arc-3: a worker with `settlement_address`
 * declared implicitly accepts P2P (it's the only path). The
 * `agent_registry.settlement_modes` field becomes vestigial; a future
 * cleanup arc can deprecate it.
 *
 * **Trust as economic membrane** per [[trust_as_economic_membrane]]:
 * the established-pair branch is the trust-as-fast-path; the new-pair
 * branch unlocks cold-start with explicit delegator consent. Workers
 * who abuse the bootstrap path get trust-downgraded via the existing
 * verifier loop (failed onchain verification → trust demotion). The
 * trust graph closes the residual economic gap the structural type
 * system can't reach.
 *
 * Returns the disjunctive `SettlementEligibility` shape — `allowed:
 * true` carries `mode: "p2p"` (the only `WritableSettlementMode`);
 * `allowed: false` has no `mode` field because there's no fallback
 * rail. The shape forces callers to handle the false case explicitly.
 */
export async function evaluateSettlementEligibility(
  db: DatabaseDriver,
  delegatorId: string,
  workerId: string,
  delegatorAcknowledgesNoHistoryRisk: boolean = false,
  bondEval?: BondEligibilityContext,
): Promise<SettlementEligibility> {
  // Worker must have a settlement address (both branches require it —
  // there's no destination without it). `public_key` feeds the offline
  // sovereign-binding check used by the reduced-bar branch below.
  const worker = db
    .prepare("SELECT settlement_address, public_key FROM agent_registry WHERE motebit_id = ?")
    .get(workerId) as { settlement_address: string | null; public_key: string | null } | undefined;

  if (!worker?.settlement_address) {
    return { allowed: false, reason: "Worker has no declared settlement address" };
  }

  // No active disputes between this pair (both branches require it).
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
        reason: `Active dispute ${activeDispute.dispute_id} between agents`,
      };
    }
  } catch {
    // relay_disputes table may not exist — treat as no disputes
  }

  // Worker not blocked (defensive — though this is a trust-level concept,
  // a blocked worker should never receive routing regardless of branch).
  const trustRow = db
    .prepare(
      "SELECT trust_level, interaction_count FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
    )
    .get(delegatorId, workerId) as { trust_level: string; interaction_count: number } | undefined;

  if (trustRow?.trust_level === "blocked") {
    return { allowed: false, reason: "Worker is blocked by this delegator" };
  }

  // Established-pair branch — trust + interactions accumulated.
  if (trustRow) {
    const score = trustLevelToScore(trustRow.trust_level as AgentTrustLevel);
    if (score >= P2P_MIN_TRUST_SCORE && trustRow.interaction_count >= P2P_MIN_INTERACTIONS) {
      return {
        allowed: true,
        mode: "p2p",
        reason: `Established pair — trust ${score}, ${trustRow.interaction_count} interactions`,
      };
    }
  }

  // Sovereign-bound branch — additive, never a gate. A sovereign worker's
  // `motebit_id` commits to its signing key, so it cannot be a throwaway sybil
  // and the cold-start bar relaxes (first_contact + 2 interactions). Placed
  // after the strict branch and keyed on an offline check, so it only ADDS a
  // qualification path; unbound workers never reach it. See
  // `docs/doctrine/hardware-attestation.md` (binding strength is additive
  // scoring) and `docs/doctrine/identity-binding-verification.md`.
  if (
    trustRow &&
    worker.public_key &&
    (await verifySovereignBinding(workerId, worker.public_key))
  ) {
    const score = trustLevelToScore(trustRow.trust_level as AgentTrustLevel);
    if (
      score >= P2P_SOVEREIGN_MIN_TRUST_SCORE &&
      trustRow.interaction_count >= P2P_SOVEREIGN_MIN_INTERACTIONS
    ) {
      return {
        allowed: true,
        mode: "p2p",
        reason: `Sovereign-bound worker (motebit_id commits to key) — trust ${score}, ${trustRow.interaction_count} interactions (reduced bar ${P2P_SOVEREIGN_MIN_TRUST_SCORE}/${P2P_SOVEREIGN_MIN_INTERACTIONS})`,
      };
    }
  }

  // Bonded-worker branch — additive, never a gate. A worker that has posted a
  // verified, currently-backed commitment bond at its OWN sovereign identity
  // address (the §2 anti-sybil binding) has tied up real, ticket-sized capital
  // it cannot reuse across identities — a costly signal in the same class as
  // sovereign-binding, so it relaxes the SAME cold-start floor (and no lower).
  // Placed AFTER the strict + sovereign branches and gated on `bondEval` (the
  // opt-in the caller sets only when it knows the ticket value), so it ONLY
  // adds a qualification path — flows that don't opt in are byte-identical.
  // Still requires real history (the bonded bar ≥ the sovereign bar); the bond
  // never fabricates trust and is NEVER recourse (phase-1 signal only). See
  // docs/doctrine/commitment-bond.md + spec/bond-v1.md.
  if (bondEval && trustRow && bondEval.unitCostMicro > 0n) {
    const score = trustLevelToScore(trustRow.trust_level as AgentTrustLevel);
    if (
      score >= P2P_BONDED_MIN_TRUST_SCORE &&
      trustRow.interaction_count >= P2P_BONDED_MIN_INTERACTIONS
    ) {
      const cover = await bondCoversTicket(db, workerId, bondEval);
      if (cover.qualifies) {
        return {
          allowed: true,
          mode: "p2p",
          reason: `Bonded worker — backing ${cover.usableMicro} ≥ required ${cover.requiredMicro} (ticket ${bondEval.unitCostMicro} + in-flight ${cover.inFlightMicro}, ${REFERENCE_BOND_COVERAGE_MULTIPLE}×) at trust ${score}, ${trustRow.interaction_count} interactions (reduced bar ${P2P_BONDED_MIN_TRUST_SCORE}/${P2P_BONDED_MIN_INTERACTIONS}); anti-sybil signal, not recourse`,
        };
      }
    }
  }

  // New-pair branch — delegator explicitly acknowledges cold-start risk.
  // This is the Arc 3 bootstrap mechanism: workers with no trust history
  // can transact when the delegator consciously accepts the risk. Trust
  // accumulates from real transactions; failures downgrade trust via
  // the existing verifier loop. See `trust_as_economic_membrane` memory.
  if (delegatorAcknowledgesNoHistoryRisk) {
    return {
      allowed: true,
      mode: "p2p",
      reason: "New pair — delegator acknowledged no-history risk",
    };
  }

  // Neither branch satisfied — reject. The disallowed return has no
  // `mode` field because there's no relay-custody fallback to route to.
  const score = trustRow ? trustLevelToScore(trustRow.trust_level as AgentTrustLevel) : 0;
  const interactions = trustRow?.interaction_count ?? 0;
  return {
    allowed: false,
    reason: trustRow
      ? `Trust ${score} / ${interactions} interactions below established-pair threshold (${P2P_MIN_TRUST_SCORE} / ${P2P_MIN_INTERACTIONS}); delegator did not acknowledge cold-start risk`
      : "No trust history between agents; delegator did not acknowledge cold-start risk",
  };
}
