/**
 * Discovery module — relay metadata and agent resolution.
 *
 * Implements motebit/discovery@1.0:
 *   GET /.well-known/motebit.json  — signed RelayMetadata (§3)
 *   GET /api/v1/discover/:motebitId — agent resolution with federation propagation (§5)
 */
import type { Hono } from "hono";
import { sign, canonicalJson, bytesToHex } from "@motebit/encryption";
import type { RelayMetadata, AgentResolutionResult } from "@motebit/protocol";
import type { DatabaseDriver } from "@motebit/persistence";
import type { RelayIdentity, FederationConfig } from "./federation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "discovery" });

// === Constants (§5.4 Convention) ===

/** Default maximum hops for agent resolution. */
const DEFAULT_MAX_HOPS = 3;
/** Positive cache TTL in seconds (found agent). */
const POSITIVE_CACHE_TTL = 300;
/** Negative cache TTL in seconds (agent not found). */
const NEGATIVE_CACHE_TTL = 60;
/** Well-known metadata cache duration in seconds (§3.6). */
const METADATA_CACHE_MAX_AGE = 3600;

// === Agent Resolution Cache ===

interface CachedResolution {
  result: AgentResolutionResult;
  expiresAt: number;
}

const resolutionCache = new Map<string, CachedResolution>();

function getCachedResolution(motebitId: string): AgentResolutionResult | null {
  const entry = resolutionCache.get(motebitId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resolutionCache.delete(motebitId);
    return null;
  }
  return { ...entry.result, cached: true };
}

function cacheResolution(
  motebitId: string,
  result: AgentResolutionResult,
  ttlSeconds: number,
): void {
  resolutionCache.set(motebitId, {
    result,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

// === Discovery Deps ===

export interface DiscoveryDeps {
  db: DatabaseDriver;
  app: Hono;
  relayIdentity: RelayIdentity;
  federationConfig?: FederationConfig;
  /** Platform fee rate (e.g. 0.05 for 5%). */
  platformFeeRate?: number;
}

// === Route Registration ===

export function registerDiscoveryRoutes(deps: DiscoveryDeps): void {
  const { db, app, relayIdentity, federationConfig, platformFeeRate } = deps;

  // ── GET /.well-known/motebit.json (§3) ──
  // Unauthenticated. Signed relay metadata.
  app.get("/.well-known/motebit.json", async (c) => {
    // Gather federation peers
    const peers = db
      .prepare("SELECT peer_relay_id, endpoint_url FROM relay_peers WHERE state = 'active'")
      .all() as Array<{ peer_relay_id: string; endpoint_url: string }>;

    // Approximate agent count
    const countRow = db
      .prepare("SELECT COUNT(*) as cnt FROM agent_registry WHERE revoked = 0")
      .get() as { cnt: number } | undefined;
    const agentCount = countRow?.cnt ?? 0;

    // Build capabilities list
    const capabilities: string[] = ["task_routing", "credential_store", "sync"];
    if (federationConfig?.enabled !== false && federationConfig?.endpointUrl) {
      capabilities.push("federation");
    }
    capabilities.push("settlement");

    // Build metadata (without signature)
    const metadata: Omit<RelayMetadata, "signature"> = {
      protocol_version: "1.0",
      relay_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex,
      endpoint_url: federationConfig?.endpointUrl ?? "",
      capabilities,
      fee_rate: platformFeeRate ?? 0.05,
      federation_peers: peers.map((p) => ({
        relay_id: p.peer_relay_id,
        endpoint_url: p.endpoint_url,
      })),
      agent_count: agentCount,
    };

    if (federationConfig?.displayName) {
      metadata.display_name = federationConfig.displayName;
    }

    // Sign with relay's Ed25519 key (§3.3)
    const canonical = canonicalJson(metadata);
    const sig = await sign(new TextEncoder().encode(canonical), relayIdentity.privateKey);
    const signatureHex = bytesToHex(sig);

    const response: RelayMetadata = {
      ...metadata,
      signature: signatureHex,
    };

    c.header("Cache-Control", `public, max-age=${METADATA_CACHE_MAX_AGE}`);
    return c.json(response);
  });

  // ── GET /api/v1/discover/:motebitId (§5) ──
  // Agent resolution with federation propagation.
  app.get("/api/v1/discover/:motebitId", async (c) => {
    const motebitId = c.req.param("motebitId");
    const hopLimit = parseInt(c.req.header("X-Hop-Limit") ?? String(DEFAULT_MAX_HOPS), 10);
    const visitedHeader = c.req.header("X-Visited-Relays") ?? "";
    const visitedRelays = new Set(
      visitedHeader
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const hops = isNaN(hopLimit) ? DEFAULT_MAX_HOPS : hopLimit;

    const result = await resolveAgent(
      db,
      relayIdentity,
      federationConfig,
      motebitId,
      hops,
      visitedRelays,
    );
    return c.json(result);
  });
}

// === Agent Resolution Algorithm (§5.2) ===

async function resolveAgent(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  federationConfig: FederationConfig | undefined,
  motebitId: string,
  hops: number,
  visitedRelays: Set<string>,
): Promise<AgentResolutionResult> {
  const ownRelayId = relayIdentity.relayMotebitId;

  // Step 1: Check local agent registry
  const localAgent = db
    .prepare(
      "SELECT motebit_id, public_key, capabilities, settlement_address, settlement_modes FROM agent_registry WHERE motebit_id = ? AND revoked = 0",
    )
    .get(motebitId) as
    | {
        motebit_id: string;
        public_key: string;
        capabilities: string | null;
        settlement_address: string | null;
        settlement_modes: string | null;
      }
    | undefined;

  if (localAgent) {
    // Check federation_visible opt-out for remote queries
    const isRemoteQuery = visitedRelays.size > 0;
    const agentMeta = db
      .prepare("SELECT federation_visible FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { federation_visible?: number } | undefined;
    const federationVisible = agentMeta?.federation_visible !== 0;

    if (!isRemoteQuery || federationVisible) {
      const caps = localAgent.capabilities ? (JSON.parse(localAgent.capabilities) as string[]) : [];
      const modes = localAgent.settlement_modes
        ? localAgent.settlement_modes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const result: AgentResolutionResult = {
        motebit_id: motebitId,
        found: true,
        relay_id: ownRelayId,
        relay_url: federationConfig?.endpointUrl ?? "",
        capabilities: caps,
        public_key: localAgent.public_key,
        ...(localAgent.settlement_address
          ? { settlement_address: localAgent.settlement_address }
          : {}),
        ...(modes && modes.length > 0 ? { settlement_modes: modes } : {}),
        resolved_via: [ownRelayId],
        cached: false,
        ttl: POSITIVE_CACHE_TTL,
      };
      return result;
    }
  }

  // Step 2: Check resolution cache
  const cached = getCachedResolution(motebitId);
  if (cached) return cached;

  // Step 3: Hop limit reached
  if (hops <= 0) {
    return {
      motebit_id: motebitId,
      found: false,
      resolved_via: [ownRelayId],
      cached: false,
      ttl: NEGATIVE_CACHE_TTL,
    };
  }

  // Step 4: Add own relay_id to visited
  visitedRelays.add(ownRelayId);

  // Step 5: Query federation peers
  const peers = db
    .prepare("SELECT peer_relay_id, endpoint_url FROM relay_peers WHERE state = 'active'")
    .all() as Array<{ peer_relay_id: string; endpoint_url: string }>;

  const visitedList = [...visitedRelays].join(",");

  for (const peer of peers) {
    if (visitedRelays.has(peer.peer_relay_id)) continue;

    try {
      const resp = await fetch(
        `${peer.endpoint_url}/api/v1/discover/${encodeURIComponent(motebitId)}`,
        {
          headers: {
            "X-Hop-Limit": String(hops - 1),
            "X-Visited-Relays": visitedList,
          },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!resp.ok) continue;
      const peerResult = (await resp.json()) as AgentResolutionResult;

      if (peerResult.found) {
        // Prepend own relay_id to resolved_via
        const result: AgentResolutionResult = {
          ...peerResult,
          resolved_via: [ownRelayId, ...peerResult.resolved_via],
          cached: false,
        };
        cacheResolution(motebitId, result, POSITIVE_CACHE_TTL);
        return result;
      }
    } catch (err) {
      logger.debug("discovery.peer_query_failed", {
        peerId: peer.peer_relay_id,
        motebitId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 6: Not found — cache negative result
  const result: AgentResolutionResult = {
    motebit_id: motebitId,
    found: false,
    resolved_via: [ownRelayId],
    cached: false,
    ttl: NEGATIVE_CACHE_TTL,
  };
  cacheResolution(motebitId, result, NEGATIVE_CACHE_TTL);
  return result;
}
