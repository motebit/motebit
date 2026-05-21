/**
 * verifyKeyBindingAtTime — sovereign-root identity binding with time-windowing.
 * Builds real signed succession chains (genesis → kp2 → kp3) and asserts that a
 * key binds the identity ONLY during its active window: a since-rotated key must
 * not bind a newer receipt, and a future key must not bind an older one. This is
 * the time-windowing failure mode from docs/doctrine/identity-binding-verification.md.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  signBySuite,
  canonicalJson,
  bytesToHex,
  verifyKeyBindingAtTime,
  type KeyPair,
  type MotebitIdentityFile,
  type SuccessionRecord,
} from "../index.js";

const SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const T0 = Date.parse("2026-01-01T00:00:00Z"); // identity created
const T1 = Date.parse("2026-02-01T00:00:00Z"); // rotation kp1 → kp2
const T2 = Date.parse("2026-03-01T00:00:00Z"); // rotation kp2 → kp3
const DAY = 24 * 60 * 60 * 1000;

async function rotation(
  oldKp: KeyPair,
  newKp: KeyPair,
  timestamp: number,
): Promise<SuccessionRecord> {
  const old_public_key = bytesToHex(oldKp.publicKey);
  const new_public_key = bytesToHex(newKp.publicKey);
  const msg = new TextEncoder().encode(
    canonicalJson({ old_public_key, new_public_key, timestamp, suite: SUITE }),
  );
  return {
    old_public_key,
    new_public_key,
    timestamp,
    suite: SUITE,
    old_key_signature: bytesToHex(await signBySuite(SUITE, msg, oldKp.privateKey)),
    new_key_signature: bytesToHex(await signBySuite(SUITE, msg, newKp.privateKey)),
  };
}

function identity(currentKeyHex: string, succession: SuccessionRecord[]): MotebitIdentityFile {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: "mote-test",
    created_at: new Date(T0).toISOString(),
    owner_id: "owner",
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
    succession,
  };
}

describe("verifyKeyBindingAtTime", () => {
  let kp1: KeyPair, kp2: KeyPair, kp3: KeyPair;
  let chain: SuccessionRecord[];
  let id: MotebitIdentityFile;
  let g: string, k2: string, k3: string;

  beforeAll(async () => {
    kp1 = await generateKeypair();
    kp2 = await generateKeypair();
    kp3 = await generateKeypair();
    g = bytesToHex(kp1.publicKey);
    k2 = bytesToHex(kp2.publicKey);
    k3 = bytesToHex(kp3.publicKey);
    chain = [await rotation(kp1, kp2, T1), await rotation(kp2, kp3, T2)];
    id = identity(k3, chain);
  });

  it("single key, no chain → binds at any time after creation", async () => {
    const kp = await generateKeypair();
    const k = bytesToHex(kp.publicKey);
    const r = await verifyKeyBindingAtTime(identity(k, []), k, T2 + DAY);
    expect(r.bound).toBe(true);
    expect(r.genesisPublicKey).toBe(k);
  });

  it("genesis key binds before the first rotation, not after", async () => {
    expect((await verifyKeyBindingAtTime(id, g, T0 + DAY)).bound).toBe(true);
    const after = await verifyKeyBindingAtTime(id, g, T1 + DAY);
    expect(after.bound).toBe(false);
    expect(after.reason).toContain("not active");
  });

  it("middle key binds only within its window [T1, T2)", async () => {
    expect((await verifyKeyBindingAtTime(id, k2, T1 + DAY)).bound).toBe(true);
    expect((await verifyKeyBindingAtTime(id, k2, T1 - DAY)).bound).toBe(false); // before its window
    expect((await verifyKeyBindingAtTime(id, k2, T2 + DAY)).bound).toBe(false); // after rotation away
  });

  it("current key binds from its rotation onward", async () => {
    const r = await verifyKeyBindingAtTime(id, k3, T2 + DAY);
    expect(r.bound).toBe(true);
    expect(r.activeUntil).toBeUndefined(); // still current
    expect(r.genesisPublicKey).toBe(g);
  });

  it("a key not in the chain never binds", async () => {
    const stranger = bytesToHex((await generateKeypair()).publicKey);
    const r = await verifyKeyBindingAtTime(id, stranger, T2 + DAY);
    expect(r.bound).toBe(false);
    expect(r.reason).toContain("not in this identity's succession chain");
  });

  it("a receipt predating identity creation does not bind the genesis key", async () => {
    expect((await verifyKeyBindingAtTime(id, g, T0 - DAY)).bound).toBe(false);
  });

  it("a tampered succession signature invalidates the whole chain", async () => {
    const bad = identity(k3, [{ ...chain[0]!, new_key_signature: "00".repeat(64) }, chain[1]!]);
    const r = await verifyKeyBindingAtTime(bad, k2, T1 + DAY);
    expect(r.bound).toBe(false);
    expect(r.reason).toMatch(/signature verification failed|invalid/);
  });
});
