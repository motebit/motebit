/**
 * Sovereign binding: `motebit_id` IS the commitment to the genesis key, so the
 * id↔key link verifies offline with no operator. Covers the commitment derivation
 * (deterministic UUIDv8), the round-trip check, and `verifyKeyBindingAtTime`
 * reporting `sovereign: true` for a sovereign-minted identity.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  deriveSovereignMotebitId,
  verifySovereignBinding,
  verifyKeyBindingAtTime,
  type MotebitIdentityFile,
} from "../index.js";

function identity(motebitId: string, currentKeyHex: string): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(1000).toISOString(),
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

describe("sovereign commitment", () => {
  it("derives a deterministic UUIDv8 from the genesis key", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const a = await deriveSovereignMotebitId(key);
    const b = await deriveSovereignMotebitId(key);
    expect(a).toBe(b); // deterministic
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("different keys derive different ids", async () => {
    const k1 = bytesToHex((await generateKeypair()).publicKey);
    const k2 = bytesToHex((await generateKeypair()).publicKey);
    expect(await deriveSovereignMotebitId(k1)).not.toBe(await deriveSovereignMotebitId(k2));
  });

  it("verifySovereignBinding: matches its own key, rejects others", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const other = bytesToHex((await generateKeypair()).publicKey);
    const id = await deriveSovereignMotebitId(key);
    expect(await verifySovereignBinding(id, key)).toBe(true);
    expect(await verifySovereignBinding(id, other)).toBe(false);
    expect(await verifySovereignBinding(id.toUpperCase(), key)).toBe(true); // case-insensitive
  });

  it("a random UUIDv7 is not a sovereign commitment to any key (false)", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const v7 = "0190a1b2-c3d4-7e5f-8a1b-2c3d4e5f6071"; // version nibble 7
    expect(await verifySovereignBinding(v7, key)).toBe(false);
  });

  it("malformed key hex → false, never throws", async () => {
    expect(await verifySovereignBinding("anything", "zz")).toBe(false);
  });
});

describe("verifyKeyBindingAtTime — sovereign flag", () => {
  it("sovereign-minted identity binds with sovereign: true", async () => {
    const kp = await generateKeypair();
    const key = bytesToHex(kp.publicKey);
    const id = await deriveSovereignMotebitId(key); // motebit_id IS the commitment
    const r = await verifyKeyBindingAtTime(identity(id, key), key, 2000);
    expect(r.bound).toBe(true);
    expect(r.sovereign).toBe(true);
  });

  it("a non-sovereign (random-id) identity binds but sovereign is false", async () => {
    const key = bytesToHex((await generateKeypair()).publicKey);
    const r = await verifyKeyBindingAtTime(identity("mote-random-uuid", key), key, 2000);
    expect(r.bound).toBe(true);
    expect(r.sovereign).toBe(false);
  });
});
