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
  verifyMigratingKeyBinding,
  deriveSovereignMotebitId,
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

// A guardian-recovery rotation is the spec's key-compromise mechanism (§3.8.3):
// the guardian signs the rotation away from the compromised key. It's the binding
// ladder's "revocation" — the compromised key's window closes at the recovery, so
// receipts dated after it must not bind. Verifying the recovery link needs the
// guardian key; this exercises reading it from the identity file (the fix).
async function recoveryRotation(
  oldKp: KeyPair,
  newKp: KeyPair,
  guardianKp: KeyPair,
  timestamp: number,
): Promise<SuccessionRecord> {
  const old_public_key = bytesToHex(oldKp.publicKey);
  const new_public_key = bytesToHex(newKp.publicKey);
  const reason = "guardian_recovery";
  const msg = new TextEncoder().encode(
    canonicalJson({
      old_public_key,
      new_public_key,
      timestamp,
      suite: SUITE,
      reason,
      recovery: true,
    }),
  );
  return {
    old_public_key,
    new_public_key,
    timestamp,
    suite: SUITE,
    reason,
    recovery: true,
    new_key_signature: bytesToHex(await signBySuite(SUITE, msg, newKp.privateKey)),
    guardian_signature: bytesToHex(await signBySuite(SUITE, msg, guardianKp.privateKey)),
  };
}

function identityWithGuardian(
  currentKeyHex: string,
  succession: SuccessionRecord[],
  guardianKeyHex: string | undefined,
): MotebitIdentityFile {
  const base = identity(currentKeyHex, succession);
  return guardianKeyHex
    ? {
        ...base,
        guardian: { public_key: guardianKeyHex, established_at: new Date(T0).toISOString() },
      }
    : base;
}

describe("verifyKeyBindingAtTime — guardian-recovery (revocation via succession)", () => {
  let compromised: KeyPair, recovered: KeyPair, guardian: KeyPair;
  let chain: SuccessionRecord[];
  let kComp: string, kRec: string, gKey: string;

  beforeAll(async () => {
    compromised = await generateKeypair();
    recovered = await generateKeypair();
    guardian = await generateKeypair();
    kComp = bytesToHex(compromised.publicKey);
    kRec = bytesToHex(recovered.publicKey);
    gKey = bytesToHex(guardian.publicKey);
    // Genesis key = the (later) compromised key; guardian recovers to a new key at T1.
    chain = [await recoveryRotation(compromised, recovered, guardian, T1)];
  });

  it("with the guardian in the identity file, the recovery chain verifies", async () => {
    const id = identityWithGuardian(kRec, chain, gKey);
    // Recovered key binds after the recovery rotation.
    expect((await verifyKeyBindingAtTime(id, kRec, T1 + DAY)).bound).toBe(true);
  });

  it("the compromised key does NOT bind after the recovery (its window closed)", async () => {
    const id = identityWithGuardian(kRec, chain, gKey);
    const after = await verifyKeyBindingAtTime(id, kComp, T1 + DAY);
    expect(after.bound).toBe(false);
    expect(after.reason).toContain("not active");
    // But receipts it legitimately signed BEFORE the recovery still bind.
    expect((await verifyKeyBindingAtTime(id, kComp, T0 + DAY)).bound).toBe(true);
  });

  it("WITHOUT the guardian (no field, no param), the recovery chain fails to verify", async () => {
    const id = identityWithGuardian(kRec, chain, undefined);
    const r = await verifyKeyBindingAtTime(id, kRec, T1 + DAY);
    expect(r.bound).toBe(false); // the fix is what makes the guardian-in-file case pass
  });

  it("an explicit guardian param still works and overrides the file", async () => {
    const id = identityWithGuardian(kRec, chain, undefined);
    expect((await verifyKeyBindingAtTime(id, kRec, T1 + DAY, gKey)).bound).toBe(true);
  });
});

describe("verifyMigratingKeyBinding (migration §8.2 step 6 — the two-tier bind)", () => {
  let genesis: KeyPair, rotated: KeyPair;
  let gHex: string, rHex: string, sid: string, chain: SuccessionRecord[];

  beforeAll(async () => {
    genesis = await generateKeypair();
    rotated = await generateKeypair();
    gHex = bytesToHex(genesis.publicKey);
    rHex = bytesToHex(rotated.publicKey);
    // motebit_id is the sovereign commitment to the GENESIS key (T1 is past, so
    // the rotated key is the one active "now").
    sid = await deriveSovereignMotebitId(gHex);
    chain = [await rotation(genesis, rotated, T1)];
  });

  it("tier 1: a never-rotated sovereign id binds its own key with no file", async () => {
    const k = bytesToHex((await generateKeypair()).publicKey);
    const id = await deriveSovereignMotebitId(k);
    expect(await verifyMigratingKeyBinding(id, k)).toBe(true);
    // A different key, no file → false (the token-theft substitution).
    expect(await verifyMigratingKeyBinding(id, gHex)).toBe(false);
  });

  it("tier 2: a ROTATED key binds via a sovereign-rooted succession chain", async () => {
    const file: MotebitIdentityFile = { ...identity(rHex, chain), motebit_id: sid };
    // The rotated key is not the sovereign commitment to sid → tier 1 fails…
    expect(await verifyMigratingKeyBinding(sid, rHex)).toBe(false);
    // …but the identity file's chain (sovereign genesis → rotated) re-binds it.
    expect(await verifyMigratingKeyBinding(sid, rHex, file)).toBe(true);
  });

  it("rejects a chain whose genesis is not the sovereign root of the id", async () => {
    const file: MotebitIdentityFile = {
      ...identity(rHex, chain),
      motebit_id: "mote-not-sovereign",
    };
    expect(await verifyMigratingKeyBinding("mote-not-sovereign", rHex, file)).toBe(false);
  });

  it("rejects an identity file issued for a different motebit_id", async () => {
    const file: MotebitIdentityFile = { ...identity(rHex, chain), motebit_id: sid };
    const otherSid = await deriveSovereignMotebitId(
      bytesToHex((await generateKeypair()).publicKey),
    );
    expect(await verifyMigratingKeyBinding(otherSid, rHex, file)).toBe(false);
  });

  it("rejects a key absent from the chain", async () => {
    const file: MotebitIdentityFile = { ...identity(rHex, chain), motebit_id: sid };
    const stranger = bytesToHex((await generateKeypair()).publicKey);
    expect(await verifyMigratingKeyBinding(sid, stranger, file)).toBe(false);
  });
});
