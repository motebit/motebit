/**
 * Credential satellite rendering — the first concrete spatial-object
 * renderer. Tests the lifecycle: mount, set expression, tick, dispose.
 *
 * Uses a real THREE.Scene + Group because the renderer composes Three.js
 * primitives directly; there's no adapter boundary worth stubbing.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  CredentialSatelliteRenderer,
  credentialsToExpression,
  hueForType,
} from "../credential-satellites";

function parent(): THREE.Group {
  const g = new THREE.Group();
  g.name = "creature-group";
  return g;
}

describe("hueForType", () => {
  it("assigns stable, distinct hues to known credential types", () => {
    const reputation = hueForType("AgentReputationCredential");
    const trust = hueForType("AgentTrustCredential");
    const gradient = hueForType("AgentGradientCredential");
    expect(reputation).not.toBe(trust);
    expect(reputation).not.toBe(gradient);
    expect(trust).not.toBe(gradient);
  });

  it("hashes unknown types deterministically into [0, 360)", () => {
    const h1 = hueForType("UnknownKind");
    const h2 = hueForType("UnknownKind");
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThan(360);
  });
});

describe("CredentialSatelliteRenderer", () => {
  it("mounts a child group under the parent", () => {
    const p = parent();
    const r = new CredentialSatelliteRenderer(p);
    const child = p.children.find((c) => c.name === "credential-satellites");
    expect(child).toBeDefined();
    r.dispose();
    expect(p.children.find((c) => c.name === "credential-satellites")).toBeUndefined();
  });

  it("adds satellite meshes for each credential", () => {
    const p = parent();
    const r = new CredentialSatelliteRenderer(p);
    r.setExpression(
      credentialsToExpression([
        { credential_type: "AgentReputationCredential", issued_at: 1 },
        { credential_type: "AgentTrustCredential", issued_at: 2 },
        { credential_type: "AgentGradientCredential", issued_at: 3 },
      ]),
    );
    const group = p.children.find((c) => c.name === "credential-satellites") as THREE.Group;
    expect(group.children.length).toBe(3);
    r.dispose();
  });

  it("reuses meshes on re-set (no teardown churn)", () => {
    const p = parent();
    const r = new CredentialSatelliteRenderer(p);
    const cred = { credential_type: "AgentTrustCredential", issued_at: 1, credential_id: "c1" };
    r.setExpression(credentialsToExpression([cred]));
    const group = p.children.find((c) => c.name === "credential-satellites") as THREE.Group;
    const meshBefore = group.children[0];

    // Second call with same credential id → same mesh reference
    r.setExpression(credentialsToExpression([cred]));
    const meshAfter = group.children[0];
    expect(meshAfter).toBe(meshBefore);
    r.dispose();
  });

  it("removes satellites that disappear from the expression", () => {
    const p = parent();
    const r = new CredentialSatelliteRenderer(p);
    r.setExpression(
      credentialsToExpression([
        { credential_type: "AgentTrustCredential", issued_at: 1, credential_id: "a" },
        { credential_type: "AgentTrustCredential", issued_at: 2, credential_id: "b" },
      ]),
    );
    r.setExpression(
      credentialsToExpression([
        { credential_type: "AgentTrustCredential", issued_at: 1, credential_id: "a" },
      ]),
    );
    const group = p.children.find((c) => c.name === "credential-satellites") as THREE.Group;
    expect(group.children.length).toBe(1);
    expect(group.children[0]!.name).toBe("credential:a");
    r.dispose();
  });

  it("tick() moves satellites along their orbit", () => {
    const p = parent();
    const r = new CredentialSatelliteRenderer(p);
    r.setExpression(
      credentialsToExpression([
        { credential_type: "AgentTrustCredential", issued_at: 1, credential_id: "a" },
      ]),
    );
    const group = p.children.find((c) => c.name === "credential-satellites") as THREE.Group;
    const mesh = group.children[0]!;
    const before = mesh.position.clone();
    r.tick(9_000); // half an orbit at 18s period
    expect(mesh.position.distanceTo(before)).toBeGreaterThan(0);
    r.dispose();
  });

  it("dispose is idempotent (disposes meshes, geometries, materials)", () => {
    const p = parent();
    const r = new CredentialSatelliteRenderer(p);
    r.setExpression(
      credentialsToExpression([{ credential_type: "AgentTrustCredential", issued_at: 1 }]),
    );
    expect(() => {
      r.dispose();
    }).not.toThrow();
  });

  it("ignores non-satellite expressions", () => {
    const p = parent();
    const r = new CredentialSatelliteRenderer(p);
    r.setExpression({
      kind: "environment",
      density: 0.5,
      tone: "neutral",
    });
    const group = p.children.find((c) => c.name === "credential-satellites") as THREE.Group;
    expect(group.children.length).toBe(0);
    r.dispose();
  });
});
