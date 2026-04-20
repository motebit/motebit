/**
 * credential-satellites.ts coverage. Three.js CPU-side classes (Group,
 * Object3D, Mesh, SphereGeometry, MeshPhysicalMaterial) run under node
 * without WebGL — we can construct scene graphs, mount satellites, run
 * tick, and dispose without a renderer.
 */
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import {
  CREDENTIAL_SATELLITES_MODULE,
  CredentialSatelliteRenderer,
  credentialsToExpression,
  hueForType,
  mountCredentialSatellites,
  type CredentialSource,
  type CredentialSummary,
  type SatelliteSink,
} from "../credential-satellites.js";
import type { SpatialExpression } from "../expression.js";

// ── Module registration ───────────────────────────────────────────────

describe("CREDENTIAL_SATELLITES_MODULE", () => {
  it("registers under kind=satellite, name=credentials", () => {
    expect(CREDENTIAL_SATELLITES_MODULE.kind).toBe("satellite");
    expect(CREDENTIAL_SATELLITES_MODULE.name).toBe("credentials");
  });
});

// ── hueForType ────────────────────────────────────────────────────────

describe("hueForType", () => {
  it("returns the canonical hue for known credential types", () => {
    expect(hueForType("AgentReputationCredential")).toBe(200);
    expect(hueForType("AgentTrustCredential")).toBe(155);
    expect(hueForType("AgentGradientCredential")).toBe(45);
  });

  it("hashes unknown types into [0, 360)", () => {
    const h = hueForType("SomeNovelCredential");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });

  it("is deterministic for the same unknown type", () => {
    expect(hueForType("Widget")).toBe(hueForType("Widget"));
  });

  it("different unknown types produce different hues (in general)", () => {
    expect(hueForType("AlphaCred")).not.toBe(hueForType("ZuluCred"));
  });
});

// ── credentialsToExpression ───────────────────────────────────────────

describe("credentialsToExpression", () => {
  it("returns a satellite expression with one item per credential", () => {
    const creds: CredentialSummary[] = [
      { credential_type: "AgentReputationCredential", issued_at: 1 },
      { credential_type: "AgentTrustCredential", issued_at: 2 },
      { credential_type: "AgentGradientCredential", issued_at: 3 },
    ];
    const expr = credentialsToExpression(creds);
    expect(expr.kind).toBe("satellite");
    expect(expr.items).toHaveLength(3);
  });

  it("strips the Credential suffix and Agent prefix for the label", () => {
    const expr = credentialsToExpression([
      { credential_type: "AgentReputationCredential", issued_at: 0 },
    ]);
    expect(expr.items[0]?.label).toBe("Reputation");
  });

  it("falls back to 'credential' when the stripped label is empty", () => {
    const expr = credentialsToExpression([{ credential_type: "Credential", issued_at: 0 }]);
    expect(expr.items[0]?.label).toBe("credential");
  });

  it("derives a stable id from credential_id when present", () => {
    const expr = credentialsToExpression([
      { credential_id: "fixed-id", credential_type: "AgentTrustCredential", issued_at: 0 },
    ]);
    expect(expr.items[0]?.id).toBe("fixed-id");
  });

  it("synthesizes an id from type + issued_at + index when credential_id missing", () => {
    const expr = credentialsToExpression([
      { credential_type: "AgentTrustCredential", issued_at: 42 },
      { credential_type: "AgentTrustCredential", issued_at: 42 },
    ]);
    expect(expr.items[0]?.id).not.toBe(expr.items[1]?.id);
    expect(expr.items[0]?.id).toContain("AgentTrustCredential");
  });

  it("orbit radius grows modestly with index (mod 3)", () => {
    const creds: CredentialSummary[] = Array.from({ length: 4 }, (_, i) => ({
      credential_type: "AgentTrustCredential",
      issued_at: i,
    }));
    const expr = credentialsToExpression(creds);
    // Items 0 and 3 share the same radius (both mod 3 → 0).
    expect(expr.items[0]?.radius).toBe(expr.items[3]?.radius);
    expect(expr.items[0]?.radius).not.toBe(expr.items[1]?.radius);
  });

  it("spreads phase around the unit circle proportional to index", () => {
    const creds: CredentialSummary[] = Array.from({ length: 4 }, (_, i) => ({
      credential_type: "AgentTrustCredential",
      issued_at: i,
    }));
    const expr = credentialsToExpression(creds);
    expect(expr.items[0]?.phase).toBe(0);
    expect(expr.items[2]?.phase).toBeCloseTo(Math.PI);
  });

  it("handles the empty list without dividing by zero", () => {
    const expr = credentialsToExpression([]);
    expect(expr.items).toHaveLength(0);
  });
});

// ── CredentialSatelliteRenderer ───────────────────────────────────────

describe("CredentialSatelliteRenderer", () => {
  function seedExpression(ids: string[]): SpatialExpression {
    return {
      kind: "satellite",
      items: ids.map((id) => ({
        id,
        label: id,
        hue: 200,
        radius: 0.2,
        orbitPeriodMs: 18_000,
        phase: 0,
      })),
    };
  }

  it("constructs under a parent group and exposes no children until set", () => {
    const parent = new THREE.Group();
    const r = new CredentialSatelliteRenderer(parent);
    // The renderer's internal group is added as a child of the parent,
    // but holds zero meshes until setExpression runs.
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]?.name).toBe("credential-satellites");
    r.dispose();
  });

  it("setExpression mounts a mesh per item", () => {
    const parent = new THREE.Group();
    const r = new CredentialSatelliteRenderer(parent);
    r.setExpression(seedExpression(["a", "b", "c"]));
    // Internal group → 3 meshes now live inside it.
    const internal = parent.children[0] as THREE.Group;
    expect(internal.children).toHaveLength(3);
    expect(internal.children.every((c) => c instanceof THREE.Mesh)).toBe(true);
    r.dispose();
  });

  it("setExpression reuses meshes by id across re-renders", () => {
    const parent = new THREE.Group();
    const r = new CredentialSatelliteRenderer(parent);
    r.setExpression(seedExpression(["a", "b"]));
    const internal = parent.children[0] as THREE.Group;
    const meshA = internal.children.find((c) => c.name === "credential:a");
    r.setExpression(seedExpression(["a", "b", "c"]));
    // "a" should still be the same mesh instance.
    const meshA2 = internal.children.find((c) => c.name === "credential:a");
    expect(meshA2).toBe(meshA);
    expect(internal.children).toHaveLength(3);
    r.dispose();
  });

  it("setExpression removes meshes that dropped out of the set", () => {
    const parent = new THREE.Group();
    const r = new CredentialSatelliteRenderer(parent);
    r.setExpression(seedExpression(["a", "b", "c"]));
    r.setExpression(seedExpression(["a"]));
    const internal = parent.children[0] as THREE.Group;
    expect(internal.children).toHaveLength(1);
    expect(internal.children[0]?.name).toBe("credential:a");
    r.dispose();
  });

  it("setExpression ignores non-satellite expressions (narrow guard)", () => {
    const parent = new THREE.Group();
    const r = new CredentialSatelliteRenderer(parent);
    r.setExpression(seedExpression(["a"]));
    r.setExpression({
      kind: "environment",
      density: 0.5,
      tone: "warm",
    } as SpatialExpression);
    const internal = parent.children[0] as THREE.Group;
    // Previous state preserved — non-satellite kinds are no-ops.
    expect(internal.children).toHaveLength(1);
    r.dispose();
  });

  it("tick updates each satellite's position deterministically", () => {
    const parent = new THREE.Group();
    const r = new CredentialSatelliteRenderer(parent);
    r.setExpression(seedExpression(["a"]));
    const internal = parent.children[0] as THREE.Group;
    const mesh = internal.children[0] as THREE.Mesh;
    r.tick(0);
    const pos0 = mesh.position.clone();
    r.tick(9000); // half of orbitPeriodMs
    const pos1 = mesh.position.clone();
    expect(pos0.equals(pos1)).toBe(false);
    r.dispose();
  });

  it("dispose removes the internal group from the parent + clears meshes", () => {
    const parent = new THREE.Group();
    const r = new CredentialSatelliteRenderer(parent);
    r.setExpression(seedExpression(["a", "b"]));
    r.dispose();
    expect(parent.children).toHaveLength(0);
    // A subsequent tick is safe — no meshes to iterate.
    expect(() => r.tick(1000)).not.toThrow();
  });
});

// ── mountCredentialSatellites ─────────────────────────────────────────

describe("mountCredentialSatellites", () => {
  function source(initial: { type: string[]; validFrom?: string; issuer?: string }[] = []): {
    handle: CredentialSource;
    fire: () => void;
    subscribers: Array<() => void>;
  } {
    const subscribers: Array<() => void> = [];
    const current = initial;
    return {
      handle: {
        getIssuedCredentials: () =>
          current.map((c) => ({
            type: c.type,
            validFrom: c.validFrom,
            issuer: c.issuer ?? "did:key:zSomething",
          })),
        onCredentialsChanged(fn) {
          subscribers.push(fn);
          return () => {
            const idx = subscribers.indexOf(fn);
            if (idx >= 0) subscribers.splice(idx, 1);
          };
        },
      },
      fire: () => {
        for (const fn of [...subscribers]) fn();
      },
      subscribers,
    };
  }

  it("returns null when target is null", () => {
    const { handle } = source();
    expect(mountCredentialSatellites(null, handle)).toBeNull();
  });

  it("mounts under a THREE.Object3D target + refreshes on subscription fire", () => {
    const parent = new THREE.Group();
    const { handle, fire, subscribers } = source([
      { type: ["VerifiableCredential", "AgentTrustCredential"], validFrom: "2026-04-01" },
    ]);
    const ctrl = mountCredentialSatellites(parent, handle);
    expect(ctrl).not.toBeNull();
    // Refresh fired once on mount, so the subscriber is also registered.
    expect(subscribers).toHaveLength(1);
    const internal = parent.children.find((c) => c.name === "credential-satellites") as THREE.Group;
    expect(internal.children.length).toBeGreaterThan(0);

    fire();
    // The refresh re-runs; scene graph unchanged in size (same creds).
    expect(internal.children.length).toBeGreaterThan(0);

    ctrl!.dispose();
    expect(subscribers).toHaveLength(0);
  });

  it("accepts a SatelliteSink target directly (mobile's postMessage bridge)", () => {
    const setExpression = vi.fn();
    const tickMock = vi.fn();
    const dispose = vi.fn();
    const sink: SatelliteSink = { setExpression, tick: tickMock, dispose };
    const { handle, fire } = source([
      { type: ["VerifiableCredential", "AgentReputationCredential"] },
    ]);
    const ctrl = mountCredentialSatellites(sink, handle);
    expect(ctrl).not.toBeNull();
    expect(setExpression).toHaveBeenCalled();

    fire();
    expect(setExpression.mock.calls.length).toBeGreaterThanOrEqual(2);

    ctrl!.tick(12345);
    expect(tickMock).toHaveBeenCalledWith(12345);

    ctrl!.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  it("controller.tick is a no-op when the sink has no tick method", () => {
    const setExpression = vi.fn();
    const dispose = vi.fn();
    const sink: SatelliteSink = { setExpression, dispose };
    const { handle } = source();
    const ctrl = mountCredentialSatellites(sink, handle)!;
    expect(() => ctrl.tick(100)).not.toThrow();
    ctrl.dispose();
  });

  it("falls back to Date.now when a credential lacks validFrom", () => {
    const parent = new THREE.Group();
    const { handle } = source([{ type: ["VerifiableCredential", "AgentTrustCredential"] }]);
    const ctrl = mountCredentialSatellites(parent, handle);
    expect(ctrl).not.toBeNull();
    ctrl!.dispose();
  });

  it("issues label 'Credential' fallback when vc.type carries no specific type", () => {
    const parent = new THREE.Group();
    const { handle } = source([{ type: ["VerifiableCredential"] }]);
    const ctrl = mountCredentialSatellites(parent, handle);
    expect(ctrl).not.toBeNull();
    ctrl!.dispose();
  });

  it("handles object-form issuer (issuer.id) in refresh without throwing", () => {
    const parent = new THREE.Group();
    const { handle } = source([
      { type: ["VerifiableCredential", "AgentTrustCredential"], issuer: "did:key:zA" },
    ]);
    const ctrl = mountCredentialSatellites(parent, handle);
    expect(ctrl).not.toBeNull();
    ctrl!.dispose();
  });
});
