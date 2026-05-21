/**
 * Identity-transparency log producer ↔ verifier loop. A proof emitted by
 * buildIdentityLog must verify via @motebit/crypto's verifyIdentityBindingAnchored
 * — they share the leaf convention and Merkle algorithm by construction. Also
 * asserts the forgery defense: a wrong-key identity file can't ride a real proof.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  verifyIdentityBindingAnchored,
  type MotebitIdentityFile,
} from "@motebit/crypto";
import { buildIdentityLog } from "../identity-log.js";

const CREATED = Date.parse("2026-01-01T00:00:00Z");
const NOW = CREATED + 24 * 60 * 60 * 1000;

function identity(motebitId: string, currentKeyHex: string): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(CREATED).toISOString(),
    owner_id: "o",
    identity: { algorithm: "Ed25519", public_key: currentKeyHex },
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "0",
      require_approval_above: "0",
      deny_above: "0",
      operator_mode: false,
    },
    privacy: { default_sensitivity: "none", retention_days: {}, fail_closed: true },
    memory: { half_life_days: 30, confidence_threshold: 0.5, per_turn_limit: 5 },
    devices: [],
    succession: [],
  };
}

async function key(): Promise<string> {
  return bytesToHex((await generateKeypair()).publicKey);
}

describe("buildIdentityLog", () => {
  it("a proof built by the log verifies via verifyIdentityBindingAnchored (producer↔verifier loop)", async () => {
    const [a, b, c] = [await key(), await key(), await key()];
    const log = await buildIdentityLog([
      { motebit_id: "mote-a", public_key: a },
      { motebit_id: "mote-b", public_key: b },
      { motebit_id: "mote-c", public_key: c },
    ]);
    expect(log.motebitCount).toBe(3);
    expect(log.root).toMatch(/^[0-9a-f]{64}$/);

    const proof = log.proofFor("mote-b");
    expect(proof).not.toBeNull();
    const r = await verifyIdentityBindingAnchored(identity("mote-b", b), b, NOW, proof!);
    expect(r.bound).toBe(true);
  });

  it("a single-binding log verifies", async () => {
    const a = await key();
    const log = await buildIdentityLog([{ motebit_id: "mote-a", public_key: a }]);
    const r = await verifyIdentityBindingAnchored(
      identity("mote-a", a),
      a,
      NOW,
      log.proofFor("mote-a")!,
    );
    expect(r.bound).toBe(true);
  });

  it("a forged identity file (wrong current key) cannot ride a real proof", async () => {
    const b = await key();
    const forged = await key();
    const log = await buildIdentityLog([
      { motebit_id: "mote-b", public_key: b },
      { motebit_id: "mote-a", public_key: await key() },
    ]);
    const proof = log.proofFor("mote-b")!; // proof for the REAL b leaf
    // The forged file claims mote-b but with a different key → its leaf differs →
    // the proof won't reconstruct the root → not included.
    const r = await verifyIdentityBindingAnchored(identity("mote-b", forged), forged, NOW, proof);
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("not included in the anchored transparency log");
  });

  it("proofFor an unknown motebit is null", async () => {
    const log = await buildIdentityLog([{ motebit_id: "mote-a", public_key: await key() }]);
    expect(log.proofFor("mote-unknown")).toBeNull();
  });

  it("an empty log has no root and no proofs", async () => {
    const log = await buildIdentityLog([]);
    expect(log.root).toBe("");
    expect(log.motebitCount).toBe(0);
    expect(log.proofFor("mote-a")).toBeNull();
  });
});
