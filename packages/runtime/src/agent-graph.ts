/**
 * Agent Graph Lifecycle — maintains a live WeightedDigraph<RouteWeight>
 * as the runtime's view of the agent network.
 *
 * The graph is rebuilt from stored trust records, service listings, and
 * latency stats. It's updated incrementally as trust changes, receipts
 * arrive, and agents come online/offline.
 *
 * This is the runtime's algebraic routing substrate. Instead of ad-hoc
 * scoring per delegation, the runtime queries the graph.
 */

import type {
  MotebitId,
  AgentTrustRecord,
  AgentServiceListing,
  ExecutionReceipt,
  ReputationCredentialSubject,
} from "@motebit/sdk";
import { trustLevelToScore, AgentTrustLevel, VC_TYPE_REPUTATION } from "@motebit/sdk";
import type { WeightedDigraph } from "@motebit/semiring";
import type { RouteWeight, AgentProfile } from "@motebit/semiring";
import {
  buildAgentGraph,
  addDelegationEdges,
  mostTrustedPath,
  cheapestPath,
  lowestRiskPath,
  rankReachableAgents,
  projectGraph,
  TrustSemiring,
  transitiveClosure,
} from "@motebit/semiring";

// Storage adapter interfaces (matching what the runtime already has)
interface AgentTrustStoreAdapter {
  getAgentTrust(
    motebitId: string,
    remoteMotebitId: string,
  ): AgentTrustRecord | null | Promise<AgentTrustRecord | null>;
  listAgentTrust(motebitId: string): AgentTrustRecord[] | Promise<AgentTrustRecord[]>;
}

interface ServiceListingStoreAdapter {
  get(motebitId: string): AgentServiceListing | null | Promise<AgentServiceListing | null>;
}

interface LatencyStatsStoreAdapter {
  getStats?(
    motebitId: string,
    remoteMotebitId: string,
  ): { avg_ms: number } | null | Promise<{ avg_ms: number } | null>;
}

/** Minimal VC shape for credential aggregation (avoids @motebit/crypto dependency). */
interface CredentialLike {
  type: string[];
  issuer: string;
  validFrom?: string;
  credentialSubject: ReputationCredentialSubject & { id: string };
}

/**
 * Provides access to stored credentials about remote agents.
 * Returns reputation VCs where the credentialSubject.id matches the remote agent.
 */
interface CredentialStoreAdapter {
  getCredentialsForSubject(subjectMotebitId: string): CredentialLike[] | Promise<CredentialLike[]>;
}

// ── Inline Credential Aggregation ───────────────────────────────────
//
// Trust-weighted credential aggregation (one-pass EigenTrust).
// Inlined here to avoid adding @motebit/market as a runtime dependency.
// The canonical implementation lives in packages/market/src/credential-weight.ts.

const FRESHNESS_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // 24h
const SAMPLE_SATURATION_K = 50;
const MIN_ISSUER_TRUST = 0.05;
const MAX_BLEND = 0.5;

function aggregateAndBlend(
  credentials: CredentialLike[],
  getIssuerTrust: (issuerDid: string) => number,
  staticTrust: number,
): number {
  const now = Date.now();
  let wSum = 0;
  let wSuccessRate = 0;
  let wTrustScore = 0;
  const issuers = new Set<string>();

  for (const vc of credentials) {
    if (!vc.type.includes(VC_TYPE_REPUTATION)) continue;
    const subject = vc.credentialSubject;
    const issuerTrust = getIssuerTrust(vc.issuer);
    if (issuerTrust < MIN_ISSUER_TRUST) continue;

    const issuedAt = vc.validFrom ? new Date(vc.validFrom).getTime() : 0;
    const age = Math.max(0, now - issuedAt);
    const freshness = Math.exp((-age * Math.LN2) / FRESHNESS_HALF_LIFE_MS);
    const taskCount = subject.task_count ?? subject.sample_size ?? 1;
    const confidence = Math.min(taskCount, SAMPLE_SATURATION_K) / SAMPLE_SATURATION_K;
    const w = issuerTrust * freshness * confidence;
    if (w <= 0) continue;

    wSum += w;
    wSuccessRate += w * subject.success_rate;
    wTrustScore += w * subject.trust_score;
    issuers.add(vc.issuer);
  }

  if (wSum === 0) return staticTrust;

  // Blend factor: diversity × weight saturation, capped at MAX_BLEND
  const diversityFactor = Math.min(issuers.size, 5) / 5;
  const weightFactor = Math.min(wSum, 3) / 3;
  const blend = MAX_BLEND * diversityFactor * weightFactor;
  const credTrust = (wSuccessRate / wSum) * 0.7 + (wTrustScore / wSum) * 0.3;

  return staticTrust * (1 - blend) + credTrust * blend;
}

/**
 * Manages the agent network graph for a runtime instance.
 *
 * The graph is lazily built on first query and cached. It's invalidated
 * when trust records change (receipt verification, manual trust update,
 * agent discovery).
 *
 * Usage in runtime:
 *   const mgr = new AgentGraphManager(this.motebitId, stores);
 *   // After trust change:
 *   mgr.invalidate();
 *   // For routing:
 *   const graph = await mgr.getGraph();
 *   const ranked = mgr.rankAgents(weights);
 */
export class AgentGraphManager {
  private _graph: WeightedDigraph<RouteWeight> | null = null;
  private _dirty = true;
  /** Cached credential-blended trust overrides per remote agent. Invalidated with the graph. */
  private _credentialTrustCache = new Map<string, number>();

  constructor(
    private readonly motebitId: MotebitId,
    private readonly trustStore: AgentTrustStoreAdapter | null,
    private readonly listingStore: ServiceListingStoreAdapter | null,
    _latencyStore: LatencyStatsStoreAdapter | null,
    private readonly credentialStore: CredentialStoreAdapter | null = null,
  ) {}

  /** Mark the graph as stale. Next query triggers a rebuild. */
  invalidate(): void {
    this._graph = null;
    this._dirty = true;
    this._credentialTrustCache.clear();
  }

  /** Get or build the current agent graph. */
  async getGraph(): Promise<WeightedDigraph<RouteWeight>> {
    if (this._graph && !this._dirty) return this._graph;

    const agents = await this.buildProfiles();
    this._graph = buildAgentGraph(this.motebitId, agents);
    this._dirty = false;
    return this._graph;
  }

  /**
   * Update the graph with edges from a delegation receipt tree.
   * Called after receipt verification to add multi-hop topology.
   */
  async addReceiptEdges(receipt: ExecutionReceipt): Promise<void> {
    const graph = await this.getGraph();
    const getTrust = (id: string): number => {
      if (!this.trustStore) return 0.1;
      const rec = this.trustStore.getAgentTrust(this.motebitId, id);
      // Handle both sync and async stores — for async, use fallback
      if (rec && typeof (rec as Promise<unknown>).then === "function") return 0.1;
      return (rec as AgentTrustRecord | null)
        ? trustLevelToScore((rec as AgentTrustRecord).trust_level)
        : 0.1;
    };
    const getLatency = (_id: string): number => 3000; // default; real latency comes from stats
    addDelegationEdges(graph, receipt, getTrust, getLatency);
  }

  /** Find the most trusted delegation chain to a target agent. */
  async mostTrustedPath(targetId: string): Promise<{ trust: number; path: string[] } | null> {
    const graph = await this.getGraph();
    return mostTrustedPath(graph, this.motebitId, targetId);
  }

  /** Find the cheapest delegation pipeline to a target agent. */
  async cheapestPath(targetId: string): Promise<{ cost: number; path: string[] } | null> {
    const graph = await this.getGraph();
    return cheapestPath(graph, this.motebitId, targetId);
  }

  /** Find the lowest regulatory risk path to a target agent. */
  async lowestRiskPath(targetId: string): Promise<{ risk: number; path: string[] } | null> {
    const graph = await this.getGraph();
    return lowestRiskPath(graph, this.motebitId, targetId);
  }

  /**
   * Rank all reachable agents by multi-objective score.
   * Weights default to trust-heavy for sovereign agents.
   */
  async rankAgents(weights?: {
    trust: number;
    cost: number;
    latency: number;
    reliability: number;
  }): Promise<Array<{ motebit_id: string; score: number; route: RouteWeight }>> {
    const graph = await this.getGraph();
    return rankReachableAgents(graph, this.motebitId, weights);
  }

  /**
   * Compute transitive trust closure — effective trust to every reachable agent.
   * Returns Map<motebit_id, trust_score>.
   */
  async trustClosure(): Promise<Map<string, number>> {
    const graph = await this.getGraph();
    const trustGraph = projectGraph(graph, TrustSemiring, (w: RouteWeight) => w.trust);
    const closure = transitiveClosure(trustGraph);
    const selfRow = closure.get(this.motebitId);
    if (!selfRow) return new Map();
    // Filter out self and zero-trust entries
    const result = new Map<string, number>();
    for (const [id, trust] of selfRow) {
      if (id !== this.motebitId && trust > 0) {
        result.set(id, trust);
      }
    }
    return result;
  }

  /** Get the raw graph for external use (admin dashboard, API). */
  async getGraphSnapshot(): Promise<{
    nodes: string[];
    edges: Array<{ from: string; to: string; weight: RouteWeight }>;
  }> {
    const graph = await this.getGraph();
    return {
      nodes: [...graph.nodes()],
      edges: graph.edges(),
    };
  }

  private async buildProfiles(): Promise<AgentProfile[]> {
    if (!this.trustStore) return [];

    const trustRecords = await this.trustStore.listAgentTrust(this.motebitId);

    // Pre-compute issuer trust lookup for credential weighting.
    // Uses static trust levels — avoids circular dependency with the graph.
    const issuerTrustByDid = new Map<string, number>();
    for (const rec of trustRecords) {
      // Map both did:motebit and did:key forms to the trust score
      const score = trustLevelToScore(rec.trust_level);
      issuerTrustByDid.set(`did:motebit:${rec.remote_motebit_id}`, score);
      if (rec.public_key) {
        try {
          const { hexPublicKeyToDidKey } = await import("@motebit/crypto");
          issuerTrustByDid.set(hexPublicKeyToDidKey(rec.public_key), score);
        } catch {
          // public_key may not be valid hex — skip did:key mapping
        }
      }
    }
    const getIssuerTrust = (issuerDid: string): number => issuerTrustByDid.get(issuerDid) ?? 0.1;

    const profiles: AgentProfile[] = [];

    for (const record of trustRecords) {
      // Skip blocked agents at the graph construction level
      if (record.trust_level === AgentTrustLevel.Blocked) continue;

      let listing: AgentServiceListing | null = null;
      if (this.listingStore) {
        listing = (await this.listingStore.get(record.remote_motebit_id)) ?? null;
      }

      const successful = record.successful_tasks ?? 0;
      const failed = record.failed_tasks ?? 0;
      const total = successful + failed;
      const reliability = total > 0 ? successful / total : 0.5;

      // Compute credential-blended trust override if credential store is available.
      // Results are cached per agent — invalidated with the graph.
      let trust_override: number | undefined;
      if (this.credentialStore) {
        const cached = this._credentialTrustCache.get(record.remote_motebit_id);
        if (cached !== undefined) {
          trust_override = cached;
        } else {
          try {
            const creds = await this.credentialStore.getCredentialsForSubject(
              record.remote_motebit_id,
            );
            if (creds.length > 0) {
              const staticTrust = trustLevelToScore(record.trust_level);
              const blended = aggregateAndBlend(creds, getIssuerTrust, staticTrust);
              if (blended !== staticTrust) {
                trust_override = blended;
                this._credentialTrustCache.set(record.remote_motebit_id, blended);
              }
            }
          } catch {
            // Credential aggregation is best-effort — fall back to static trust
          }
        }
      }

      profiles.push({
        motebit_id: record.remote_motebit_id,
        trust_record: record,
        listing,
        latency_ms: null, // populated from latency store if available
        reliability,
        is_online: true, // trust records imply prior contact; liveness checked at delegation time
        trust_override,
      });
    }

    return profiles;
  }
}

// Re-export types for consumers
export type { RouteWeight } from "@motebit/semiring";
