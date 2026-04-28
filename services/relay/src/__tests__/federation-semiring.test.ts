import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTaskRouter } from "../task-routing.js";
import type { TaskRouterDeps } from "../task-routing.js";

// ── Mock Helpers ────────────────────────────────────────────────────

function mockDb(
  peers: Array<{ peer_relay_id: string; endpoint_url: string; trust_score: number }>,
) {
  const prepareResults = new Map<
    string,
    {
      all: (...args: unknown[]) => unknown[];
      get: (...args: unknown[]) => unknown;
      run: (...args: unknown[]) => void;
    }
  >();

  const stmt = (key: string) => {
    if (!prepareResults.has(key)) {
      prepareResults.set(key, {
        all: () => [],
        get: () => undefined,
        run: () => {},
      });
    }
    return prepareResults.get(key)!;
  };

  // Match the relay_peers query
  const peerStmt = {
    all: () => peers,
    get: () => undefined,
    run: () => {},
  };

  // Match the delegation_edges query
  const edgesStmt = {
    all: () => [],
    get: () => undefined,
    run: () => {},
  };

  // Circuit breaker update stmts
  const updateStmt = {
    all: () => [],
    get: () => undefined,
    run: () => {},
  };

  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("relay_peers") && sql.includes("SELECT")) return peerStmt;
      if (sql.includes("relay_delegation_edges")) return edgesStmt;
      if (sql.includes("UPDATE")) return updateStmt;
      return stmt(sql);
    }),
  } as unknown as TaskRouterDeps["db"];
}

const RELAY_MOTEBIT_ID = "relay-self-001";

function makeDeps(
  peers: Array<{ peer_relay_id: string; endpoint_url: string; trust_score: number }>,
) {
  return {
    db: mockDb(peers),
    relayIdentity: {
      relayMotebitId: RELAY_MOTEBIT_ID,
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(64),
    },
  } as TaskRouterDeps;
}

// ── Mock fetch for federation discovery ────────────────────────────

function mockFederationDiscovery(
  agentsByEndpoint: Record<
    string,
    Array<{ motebit_id: string; capabilities: string[]; source_relay?: string }>
  >,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    for (const [endpoint, agents] of Object.entries(agentsByEndpoint)) {
      if (url.startsWith(endpoint)) {
        return {
          ok: true,
          json: async () => ({ agents }),
          headers: new Headers(),
        } as Response;
      }
    }
    return { ok: false, json: async () => ({}), headers: new Headers() } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Federation → Semiring graph wiring", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = () => {};
  });

  afterEach(() => {
    restore();
  });

  it("returns federation topology edges (peerRelay → agent) from fetchFederatedCandidates", async () => {
    const peers = [
      {
        peer_relay_id: "peer-relay-A",
        endpoint_url: "https://relay-a.example.com",
        trust_score: 0.8,
      },
    ];
    const router = createTaskRouter(makeDeps(peers));

    restore = mockFederationDiscovery({
      "https://relay-a.example.com": [
        { motebit_id: "agent-x", capabilities: ["web_search"] },
        { motebit_id: "agent-y", capabilities: ["web_search", "read_url"] },
      ],
    });

    const result = await router.fetchFederatedCandidates(["web_search"]);

    // Should have 2 candidates
    expect(result.candidates).toHaveLength(2);

    // Should have 2 peerRelay → agent edges
    expect(result.federationEdges).toHaveLength(2);
    expect(result.federationEdges[0]).toEqual({
      from: "peer-relay-A",
      to: "agent-x",
      weight: { trust: 0.5, cost: 0, latency: 0, reliability: 0.99, regulatory_risk: 0 },
    });
    expect(result.federationEdges[1]).toEqual({
      from: "peer-relay-A",
      to: "agent-y",
      weight: { trust: 0.5, cost: 0, latency: 0, reliability: 0.99, regulatory_risk: 0 },
    });

    // Should have 1 peer relay node for selfId → peerRelay edge creation
    expect(result.peerRelayNodes).toHaveLength(1);
    expect(result.peerRelayNodes[0]).toEqual({
      peerRelayId: "peer-relay-A",
      trust: 0.8,
      latency: 200,
      reliability: 0.99,
    });

    // chain_trust should be undefined on federated profiles — graph computes trust
    for (const c of result.candidates) {
      expect(c.profile.chain_trust).toBeUndefined();
    }
  });

  it("trusted relay (0.8) produces higher composed trust than unknown relay (0.1) via graph edges", async () => {
    // Two peer relays: one trusted, one unknown. Each has one agent.
    const peers = [
      {
        peer_relay_id: "trusted-relay",
        endpoint_url: "https://trusted.example.com",
        trust_score: 0.8,
      },
      {
        peer_relay_id: "unknown-relay",
        endpoint_url: "https://unknown.example.com",
        trust_score: 0.1,
      },
    ];
    const router = createTaskRouter(makeDeps(peers));

    restore = mockFederationDiscovery({
      "https://trusted.example.com": [
        { motebit_id: "agent-trusted", capabilities: ["web_search"] },
      ],
      "https://unknown.example.com": [
        { motebit_id: "agent-unknown", capabilities: ["web_search"] },
      ],
    });

    const result = await router.fetchFederatedCandidates(["web_search"]);

    // Both relays should contribute peer relay nodes
    expect(result.peerRelayNodes).toHaveLength(2);

    const trustedNode = result.peerRelayNodes.find((n) => n.peerRelayId === "trusted-relay");
    const unknownNode = result.peerRelayNodes.find((n) => n.peerRelayId === "unknown-relay");
    expect(trustedNode!.trust).toBe(0.8);
    expect(unknownNode!.trust).toBe(0.1);

    // When the caller builds selfId → peerRelay edges and feeds them + federationEdges
    // to the semiring graph, the composed trust is:
    //   trusted path: 0.8 (selfId→trustedRelay) × 0.5 (trustedRelay→agent) = 0.4
    //   unknown path: 0.1 (selfId→unknownRelay) × 0.5 (unknownRelay→agent) = 0.05
    // Verify the edges enable this composition:
    const trustedEdge = result.federationEdges.find((e) => e.to === "agent-trusted");
    const unknownEdge = result.federationEdges.find((e) => e.to === "agent-unknown");
    expect(trustedEdge!.from).toBe("trusted-relay");
    expect(unknownEdge!.from).toBe("unknown-relay");

    // Composed trust: selfId→peerRelay trust × peerRelay→agent trust
    const composedTrusted = trustedNode!.trust * trustedEdge!.weight.trust;
    const composedUnknown = unknownNode!.trust * unknownEdge!.weight.trust;
    expect(composedTrusted).toBe(0.4);
    expect(composedUnknown).toBe(0.05);
    expect(composedTrusted).toBeGreaterThan(composedUnknown);
  });

  it("low-trust relay (0.05) produces composed trust (0.025) below default direct edge (0.1)", async () => {
    const peers = [
      {
        peer_relay_id: "sketchy-relay",
        endpoint_url: "https://sketchy.example.com",
        trust_score: 0.05,
      },
    ];
    const router = createTaskRouter(makeDeps(peers));

    restore = mockFederationDiscovery({
      "https://sketchy.example.com": [
        { motebit_id: "agent-sketchy", capabilities: ["web_search"] },
      ],
    });

    const result = await router.fetchFederatedCandidates(["web_search"]);

    const peerNode = result.peerRelayNodes[0]!;
    const agentEdge = result.federationEdges[0]!;

    // Composed trust via low-trust relay: 0.05 × 0.5 = 0.025
    const composedTrust = peerNode.trust * agentEdge.weight.trust;
    expect(composedTrust).toBe(0.025);

    // Default direct-edge trust for unknown agents is 0.1 (from buildRoutingGraph).
    // The semiring's max-trust path will prefer the direct edge.
    expect(composedTrust).toBeLessThan(0.1);
  });

  it("returns empty arrays when no peers exist", async () => {
    const router = createTaskRouter(makeDeps([]));

    const result = await router.fetchFederatedCandidates(["web_search"]);

    expect(result.candidates).toEqual([]);
    expect(result.federationEdges).toEqual([]);
    expect(result.peerRelayNodes).toEqual([]);
  });
});
