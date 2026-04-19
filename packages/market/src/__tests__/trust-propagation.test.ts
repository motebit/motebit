import { describe, it, expect } from "vitest";
import type { MotebitId } from "@motebit/protocol";
import {
  propagateTrust,
  buildTrustGraph,
  makeIssuerTrustResolver,
  TRUST_SUPER_SOURCE,
} from "../trust-propagation.js";
import type { CredentialEdge } from "../trust-propagation.js";

const id = (s: string): MotebitId => s as MotebitId;

describe("propagateTrust", () => {
  it("returns empty when roots are empty", () => {
    const result = propagateTrust([], { roots: [] });
    expect(result).toEqual([]);
  });

  it("returns empty when no credentials exist between roots and others", () => {
    const result = propagateTrust([], { roots: [id("root")] });
    expect(result).toEqual([]);
  });

  it("propagates full trust across a single high-weight edge", () => {
    const creds: CredentialEdge[] = [{ issuer: id("root"), subject: id("alice"), weight: 1 }];
    const result = propagateTrust(creds, { roots: [id("root")] });
    expect(result).toHaveLength(1);
    expect(result[0]!.agentId).toBe("alice");
    expect(result[0]!.trust).toBe(1);
    expect(result[0]!.depth).toBe(1);
    expect(result[0]!.path).toEqual(["root", "alice"]);
  });

  it("multiplies edge weights along a chain (TrustSemiring.mul = product)", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("alice"), weight: 0.8 },
      { issuer: id("alice"), subject: id("bob"), weight: 0.5 },
    ];
    const result = propagateTrust(creds, { roots: [id("root")] });
    const bob = result.find((r) => r.agentId === "bob")!;
    expect(bob).toBeDefined();
    expect(bob.trust).toBeCloseTo(0.4, 10); // 0.8 × 0.5
    expect(bob.depth).toBe(2);
    expect(bob.path).toEqual(["root", "alice", "bob"]);
  });

  it("picks the maximum across parallel attestation paths (TrustSemiring.add = max)", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("alice"), weight: 0.9 },
      { issuer: id("root"), subject: id("bob"), weight: 0.4 },
      { issuer: id("alice"), subject: id("target"), weight: 0.5 }, // 0.9 × 0.5 = 0.45
      { issuer: id("bob"), subject: id("target"), weight: 0.95 }, // 0.4 × 0.95 = 0.38
    ];
    const result = propagateTrust(creds, { roots: [id("root")] });
    const target = result.find((r) => r.agentId === "target")!;
    expect(target.trust).toBeCloseTo(0.45, 10);
    expect(target.path).toEqual(["root", "alice", "target"]);
  });

  it("merges duplicate parallel edges between the same pair (max aggregation)", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("alice"), weight: 0.4 },
      { issuer: id("root"), subject: id("alice"), weight: 0.9 }, // stronger credential wins
    ];
    const result = propagateTrust(creds, { roots: [id("root")] });
    expect(result[0]!.trust).toBe(0.9);
  });

  it("drops edges with non-positive or non-finite weight", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("alice"), weight: 0 },
      { issuer: id("root"), subject: id("bob"), weight: -0.3 },
      { issuer: id("root"), subject: id("carol"), weight: Number.NaN },
      { issuer: id("root"), subject: id("dave"), weight: 0.7 },
    ];
    const result = propagateTrust(creds, { roots: [id("root")] });
    expect(result.map((r) => r.agentId).sort()).toEqual(["dave"]);
  });

  it("clamps edge weights greater than 1 to preserve the [0,1] trust bound", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("alice"), weight: 42 },
      { issuer: id("alice"), subject: id("bob"), weight: 0.5 },
    ];
    const result = propagateTrust(creds, { roots: [id("root")] });
    const alice = result.find((r) => r.agentId === "alice")!;
    const bob = result.find((r) => r.agentId === "bob")!;
    expect(alice.trust).toBe(1); // clamped
    expect(bob.trust).toBe(0.5); // 1 × 0.5
  });

  it("excludes roots by default", () => {
    const creds: CredentialEdge[] = [{ issuer: id("root"), subject: id("alice"), weight: 0.6 }];
    const result = propagateTrust(creds, { roots: [id("root")] });
    expect(result.some((r) => r.agentId === "root")).toBe(false);
  });

  it("includes roots when includeRoots: true", () => {
    const creds: CredentialEdge[] = [{ issuer: id("root"), subject: id("alice"), weight: 0.6 }];
    const result = propagateTrust(creds, { roots: [id("root")], includeRoots: true });
    const root = result.find((r) => r.agentId === "root")!;
    expect(root).toBeDefined();
    expect(root.trust).toBe(1);
    expect(root.depth).toBe(0);
  });

  it("filters below minTrust", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("alice"), weight: 0.8 },
      { issuer: id("alice"), subject: id("bob"), weight: 0.1 },
      { issuer: id("bob"), subject: id("carol"), weight: 0.1 }, // 0.8 × 0.1 × 0.1 = 0.008
    ];
    const result = propagateTrust(creds, { roots: [id("root")], minTrust: 0.05 });
    expect(result.find((r) => r.agentId === "carol")).toBeUndefined();
  });

  it("handles multiple roots with different reachability", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root-a"), subject: id("x"), weight: 0.5 },
      { issuer: id("root-b"), subject: id("y"), weight: 0.9 },
    ];
    const result = propagateTrust(creds, { roots: [id("root-a"), id("root-b")] });
    expect(result.find((r) => r.agentId === "x")!.trust).toBe(0.5);
    expect(result.find((r) => r.agentId === "y")!.trust).toBe(0.9);
    expect(result.find((r) => r.agentId === "x")!.path[0]).toBe("root-a");
    expect(result.find((r) => r.agentId === "y")!.path[0]).toBe("root-b");
  });

  it("orders results by descending trust", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("low"), weight: 0.2 },
      { issuer: id("root"), subject: id("high"), weight: 0.9 },
      { issuer: id("root"), subject: id("mid"), weight: 0.5 },
    ];
    const result = propagateTrust(creds, { roots: [id("root")] });
    expect(result.map((r) => r.agentId)).toEqual(["high", "mid", "low"]);
  });

  it("detects unreachable agents — isolated subgraph is excluded", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("reachable"), weight: 0.5 },
      { issuer: id("island-a"), subject: id("island-b"), weight: 0.9 }, // no path from root
    ];
    const result = propagateTrust(creds, { roots: [id("root")] });
    expect(result.map((r) => r.agentId)).toEqual(["reachable"]);
  });

  it("is deterministic for the same input", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("a"), weight: 0.7 },
      { issuer: id("a"), subject: id("b"), weight: 0.6 },
      { issuer: id("root"), subject: id("b"), weight: 0.5 },
    ];
    const r1 = propagateTrust(creds, { roots: [id("root")] });
    const r2 = propagateTrust(creds, { roots: [id("root")] });
    expect(r1).toEqual(r2);
  });
});

describe("buildTrustGraph", () => {
  it("includes the super-source and every root + issuer + subject", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("alice"), weight: 0.5 },
      { issuer: id("alice"), subject: id("bob"), weight: 0.5 },
    ];
    const graph = buildTrustGraph(creds, [id("root")]);
    const nodes = new Set(graph.nodes());
    expect(nodes.has(TRUST_SUPER_SOURCE)).toBe(true);
    expect(nodes.has("root")).toBe(true);
    expect(nodes.has("alice")).toBe(true);
    expect(nodes.has("bob")).toBe(true);
  });

  it("seeds every root with weight=1 from the super-source", () => {
    const graph = buildTrustGraph([], [id("a"), id("b")]);
    expect(graph.getEdge(TRUST_SUPER_SOURCE, "a")).toBe(1);
    expect(graph.getEdge(TRUST_SUPER_SOURCE, "b")).toBe(1);
  });
});

describe("makeIssuerTrustResolver", () => {
  it("returns trust scores for reachable issuers", () => {
    const creds: CredentialEdge[] = [
      { issuer: id("root"), subject: id("kyb"), weight: 0.9 },
      { issuer: id("kyb"), subject: id("provider"), weight: 0.6 },
    ];
    const resolver = makeIssuerTrustResolver(creds, { roots: [id("root")] });
    expect(resolver("root")).toBe(1); // includeRoots is forced inside the resolver
    expect(resolver("kyb")).toBeCloseTo(0.9, 10);
    expect(resolver("provider")).toBeCloseTo(0.54, 10); // 0.9 × 0.6
  });

  it("returns 0 for unknown issuers so downstream minIssuerTrust filter drops them", () => {
    const resolver = makeIssuerTrustResolver([], { roots: [id("root")] });
    expect(resolver("unknown-did")).toBe(0);
  });
});
