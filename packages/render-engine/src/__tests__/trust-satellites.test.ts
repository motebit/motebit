/**
 * Trust constellation rendering — mirrors receipt-satellites.test.ts. Covers the
 * §6 honesty model behaviorally (proven-only input, blocked excluded, no
 * aggregate, depth-as-inner-band), the pure projection/transform, the renderer
 * lifecycle, and the coordinator state machine (buffer-before-attach, cap).
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  TrustConstellationCoordinator,
  TrustSatelliteRenderer,
  hueForTrustTier,
  tierOf,
  projectTrustPeers,
  peersToExpression,
  type TrustEdgeInput,
} from "../trust-satellites";

function parent(): THREE.Group {
  const g = new THREE.Group();
  g.name = "creature-group";
  return g;
}

function edge(id: string, trust_level: string, last_seen_at = 0): TrustEdgeInput {
  return { remote_motebit_id: id, trust_level, last_seen_at };
}

describe("tierOf", () => {
  it("excludes blocked (not trust held)", () => {
    expect(tierOf("blocked")).toBeNull();
  });

  it("folds unknown and forward-compat levels into the entry tier", () => {
    expect(tierOf("unknown")).toBe("first_contact");
    expect(tierOf("some_future_level")).toBe("first_contact");
  });

  it("maps the earned tiers directly", () => {
    expect(tierOf("first_contact")).toBe("first_contact");
    expect(tierOf("verified")).toBe("verified");
    expect(tierOf("trusted")).toBe("trusted");
  });
});

describe("hueForTrustTier", () => {
  it("assigns a distinct hue to each tier, all inside [0, 360)", () => {
    const hues = [
      hueForTrustTier("first_contact"),
      hueForTrustTier("verified"),
      hueForTrustTier("trusted"),
    ];
    expect(new Set(hues).size).toBe(3);
    for (const h of hues) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("projectTrustPeers", () => {
  it("excludes blocked edges entirely", () => {
    const peers = projectTrustPeers([
      edge("a", "verified"),
      edge("blk", "blocked"),
      edge("b", "trusted"),
    ]);
    expect(peers.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("sorts deepest-trust first, then most-recently-seen", () => {
    const peers = projectTrustPeers([
      edge("fc", "first_contact", 100),
      edge("t", "trusted", 1),
      edge("v-old", "verified", 1),
      edge("v-new", "verified", 999),
    ]);
    expect(peers.map((p) => p.id)).toEqual(["t", "v-new", "v-old", "fc"]);
  });

  it("caps the constellation, keeping the deepest/most-recent tail", () => {
    const many: TrustEdgeInput[] = [];
    for (let i = 0; i < 25; i++) many.push(edge(`fc${i}`, "first_contact", i));
    many.push(edge("trusted-peer", "trusted", 0));
    const peers = projectTrustPeers(many);
    expect(peers.length).toBe(18);
    // The single trusted edge survives the cap (deepest sorts first).
    expect(peers[0]!.id).toBe("trusted-peer");
  });
});

describe("peersToExpression", () => {
  it("produces a satellite-kind expression with one item per peer", () => {
    const expr = peersToExpression(
      projectTrustPeers([edge("a", "verified"), edge("b", "trusted")]),
    );
    expect(expr.kind).toBe("satellite");
    expect(expr.items.length).toBe(2);
  });

  it("carries tier through to hue", () => {
    const expr = peersToExpression(projectTrustPeers([edge("a", "trusted")]));
    expect(expr.items[0]!.hue).toBe(hueForTrustTier("trusted"));
  });

  it("orbits deeper trust closer to the creature (depth = inner band)", () => {
    const expr = peersToExpression(
      projectTrustPeers([edge("fc", "first_contact"), edge("t", "trusted")]),
    );
    const fc = expr.items.find((i) => i.label === "first_contact")!;
    const t = expr.items.find((i) => i.label === "trusted")!;
    expect(t.radius).toBeLessThan(fc.radius);
  });

  it("keeps the whole constellation inside the receipt ring (0.26m)", () => {
    const many: TrustEdgeInput[] = [];
    for (let i = 0; i < 18; i++) many.push(edge(`p${i}`, "first_contact", i));
    const expr = peersToExpression(projectTrustPeers(many));
    for (const item of expr.items) {
      expect(item.radius).toBeLessThan(0.26);
    }
  });

  it("never emits an aggregate item — only per-peer orbs", () => {
    const expr = peersToExpression(
      projectTrustPeers([edge("a", "verified"), edge("b", "verified")]),
    );
    expect(expr.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });
});

describe("TrustSatelliteRenderer", () => {
  it("mounts and disposes a distinctly-named child group", () => {
    const p = parent();
    const r = new TrustSatelliteRenderer(p);
    expect(p.children.find((c) => c.name === "trust-satellites")).toBeDefined();
    r.dispose();
    expect(p.children.find((c) => c.name === "trust-satellites")).toBeUndefined();
  });

  it("adds one mesh per peer and names it trust:<id>", () => {
    const p = parent();
    const r = new TrustSatelliteRenderer(p);
    r.setExpression(
      peersToExpression(projectTrustPeers([edge("a", "verified"), edge("b", "trusted")])),
    );
    const group = p.children.find((c) => c.name === "trust-satellites") as THREE.Group;
    expect(group.children.length).toBe(2);
    expect(group.children.some((c) => c.name === "trust:a")).toBe(true);
    r.dispose();
  });

  it("reuses meshes on re-set (no teardown churn)", () => {
    const p = parent();
    const r = new TrustSatelliteRenderer(p);
    const expr = peersToExpression(projectTrustPeers([edge("a", "verified")]));
    r.setExpression(expr);
    const group = p.children.find((c) => c.name === "trust-satellites") as THREE.Group;
    const before = group.children[0];
    r.setExpression(expr);
    expect(group.children[0]).toBe(before);
    r.dispose();
  });

  it("removes peers that disappear from the expression", () => {
    const p = parent();
    const r = new TrustSatelliteRenderer(p);
    r.setExpression(
      peersToExpression(projectTrustPeers([edge("a", "verified"), edge("b", "trusted")])),
    );
    r.setExpression(peersToExpression(projectTrustPeers([edge("a", "verified")])));
    const group = p.children.find((c) => c.name === "trust-satellites") as THREE.Group;
    expect(group.children.length).toBe(1);
    expect(group.children[0]!.name).toBe("trust:a");
    r.dispose();
  });

  it("tick() moves orbs along their orbit", () => {
    const p = parent();
    const r = new TrustSatelliteRenderer(p);
    r.setExpression(peersToExpression(projectTrustPeers([edge("a", "verified")])));
    const group = p.children.find((c) => c.name === "trust-satellites") as THREE.Group;
    const mesh = group.children[0]!;
    const before = mesh.position.clone();
    r.tick(18_000); // half an orbit at 36s period
    expect(mesh.position.distanceTo(before)).toBeGreaterThan(0);
    r.dispose();
  });

  it("ignores non-satellite expressions", () => {
    const p = parent();
    const r = new TrustSatelliteRenderer(p);
    r.setExpression({ kind: "environment", density: 0.5, tone: "neutral" });
    const group = p.children.find((c) => c.name === "trust-satellites") as THREE.Group;
    expect(group.children.length).toBe(0);
    r.dispose();
  });
});

describe("TrustConstellationCoordinator", () => {
  it("buffers peers set before attach and flushes on attach", () => {
    const c = new TrustConstellationCoordinator();
    c.setPeers([edge("a", "verified"), edge("b", "trusted")]);
    expect(c.size()).toBe(2);
    const p = parent();
    c.attach(p);
    const group = p.children.find((ch) => ch.name === "trust-satellites") as THREE.Group;
    expect(group.children.length).toBe(2);
    c.dispose();
  });

  it("setPeers excludes blocked from the rendered count", () => {
    const c = new TrustConstellationCoordinator();
    c.setPeers([edge("a", "verified"), edge("blk", "blocked")]);
    expect(c.size()).toBe(1);
    c.dispose();
  });

  it("caps a large graph at the constellation tail", () => {
    const c = new TrustConstellationCoordinator();
    const many: TrustEdgeInput[] = [];
    for (let i = 0; i < 30; i++) many.push(edge(`p${i}`, "verified", i));
    c.setPeers(many);
    expect(c.size()).toBe(18);
    c.dispose();
  });

  it("attach is idempotent", () => {
    const c = new TrustConstellationCoordinator();
    const p = parent();
    c.attach(p);
    c.attach(p);
    expect(p.children.filter((ch) => ch.name === "trust-satellites").length).toBe(1);
    c.dispose();
  });

  it("dispose clears state and detaches the renderer", () => {
    const c = new TrustConstellationCoordinator();
    const p = parent();
    c.attach(p);
    c.setPeers([edge("a", "verified")]);
    c.dispose();
    expect(c.size()).toBe(0);
    expect(p.children.find((ch) => ch.name === "trust-satellites")).toBeUndefined();
  });
});
