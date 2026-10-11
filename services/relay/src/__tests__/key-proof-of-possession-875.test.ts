/**
 * #875 — the relay's key writers demand proof of possession: the LAWS, ported
 * for identity-authority Inc 2 (docs/design/identity-authority-writers.md §7).
 *
 * Ported from `fix/875-key-pop-v2` @ 373221619. On that branch every cell
 * drives a door (bootstrap, register-self, `/agents/register`) that REFUSES a
 * request this tree admits — unsigned bootstrap, an unproven body key, a
 * sovereign-id squat. Inc 2 refuses nothing new (its hard constraint), so the
 * door cells cannot hold here and are not ported; they return with Inc 3,
 * which wires these functions into the doors. What is ported is each law the
 * door cells exercise, applied to the function that decides it:
 *
 *  - `verifyKeyPossession` — the proof is a device-registration request
 *    signed by the key it names, fresh within ±5 minutes, naming exactly the
 *    identity and key; forged, altered and stale proofs are refused.
 *  - `refuseSovereignIdSquat` / `claimsSovereignId` — an id shaped as a
 *    sovereign commitment (UUIDv8 any case, or a did:key) takes its first key
 *    only when it IS the commitment to that key.
 *  - registry-key provenance (`relay_registry_key_evidence`, v58) — served
 *    only while the registry still equals the proven key.
 *
 * And the Inc 2 side of the ledger, asserted: the doors still admit what
 * main admits (an unsigned bootstrap, a squat-shaped bootstrap).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  hexPublicKeyToDidKey,
  signDeviceRegistration,
  type KeyPair,
} from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { provenRegistryKeyOf, recordRegistryKeyEvidence } from "../identity-keys.js";
import {
  claimsSovereignId,
  refuseSovereignIdSquat,
  verifyKeyPossession,
} from "../device-registration-guard.js";
import { createTestRelay, keyProof } from "./test-helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

async function sovereign() {
  const kp = await generateKeypair();
  return { kp, mid: await deriveSovereignMotebitId(hex(kp)) };
}

describe("verifyKeyPossession — the proof bootstrap / register-self / key_proof carry", () => {
  it("a missing proof, or a body with no signature, is `missing`", async () => {
    const kp = await generateKeypair();
    const mid = crypto.randomUUID();
    expect(await verifyKeyPossession(undefined, { motebitId: mid, publicKey: hex(kp) })).toEqual({
      proven: false,
      reason: "missing",
    });
    expect(
      await verifyKeyPossession(
        { motebit_id: mid, device_id: "d", public_key: hex(kp) },
        { motebitId: mid, publicKey: hex(kp) },
      ),
    ).toEqual({ proven: false, reason: "missing" });
    expect(await verifyKeyPossession([], { motebitId: mid, publicKey: hex(kp) })).toEqual({
      proven: false,
      reason: "malformed",
    });
  });

  it("refuses a FORGED proof — signed by another key over the victim's key", async () => {
    const victim = await generateKeypair();
    const attacker = await generateKeypair();
    const mid = crypto.randomUUID();
    const forged = await signDeviceRegistration(
      { motebit_id: mid, device_id: "d", public_key: hex(victim), timestamp: Date.now() },
      attacker.privateKey,
    );
    expect(await verifyKeyPossession(forged, { motebitId: mid, publicKey: hex(victim) })).toEqual({
      proven: false,
      reason: "bad_signature",
    });
  });

  it("refuses a proof whose signed fields were changed after signing (the id is covered)", async () => {
    const kp = await generateKeypair();
    const signed = await signDeviceRegistration(
      {
        motebit_id: crypto.randomUUID(),
        device_id: "d",
        public_key: hex(kp),
        timestamp: Date.now(),
      },
      kp.privateKey,
    );
    const other = crypto.randomUUID();
    expect(
      await verifyKeyPossession(
        { ...signed, motebit_id: other },
        { motebitId: other, publicKey: hex(kp) },
      ),
    ).toEqual({ proven: false, reason: "bad_signature" });
  });

  it("refuses a STALE proof (outside register-self's ±5-minute window)", async () => {
    const kp = await generateKeypair();
    const mid = crypto.randomUUID();
    const stale = await signDeviceRegistration(
      { motebit_id: mid, device_id: "d", public_key: hex(kp), timestamp: Date.now() - 6 * 60_000 },
      kp.privateKey,
    );
    expect(await verifyKeyPossession(stale, { motebitId: mid, publicKey: hex(kp) })).toEqual({
      proven: false,
      reason: "stale",
    });
  });

  it("a valid proof for another id or another key is refused by name", async () => {
    const kp = await generateKeypair();
    const other = await generateKeypair();
    const mid = crypto.randomUUID();
    const proof = await keyProof({ motebit_id: mid, public_key: hex(kp) }, kp.privateKey);
    expect(
      await verifyKeyPossession(proof, { motebitId: crypto.randomUUID(), publicKey: hex(kp) }),
    ).toEqual({ proven: false, reason: "motebit_id_mismatch" });
    expect(await verifyKeyPossession(proof, { motebitId: mid, publicKey: hex(other) })).toEqual({
      proven: false,
      reason: "public_key_mismatch",
    });
  });

  it("admits a signed proof — legacy and sovereign", async () => {
    const legacy = await generateKeypair();
    const lid = crypto.randomUUID();
    const lp = await keyProof({ motebit_id: lid, public_key: hex(legacy) }, legacy.privateKey);
    expect(await verifyKeyPossession(lp, { motebitId: lid, publicKey: hex(legacy) })).toEqual({
      proven: true,
    });
    const { kp, mid } = await sovereign();
    const sp = await keyProof({ motebit_id: mid, public_key: hex(kp) }, kp.privateKey);
    expect(await verifyKeyPossession(sp, { motebitId: mid, publicKey: hex(kp) })).toEqual({
      proven: true,
    });
  });
});

describe("the pre-registration squat of a sovereign id — refuseSovereignIdSquat", () => {
  it("X, with its OWN key, may not take V's not-yet-registered derive(K_V); V's own key may", async () => {
    const v = await sovereign();
    const x = await generateKeypair();
    const refusal = await refuseSovereignIdSquat(v.mid, hex(x));
    expect(refusal?.code).toBe("SOVEREIGN_ID_KEY_MISMATCH");
    expect(refusal?.error).toContain("sovereign id that is not the commitment");
    expect(await refuseSovereignIdSquat(v.mid, hex(v.kp))).toBeNull();
  });

  it("an upper-case spelling of V's sovereign id is a sovereign claim too — refused under any key", async () => {
    const v = await sovereign();
    const x = await generateKeypair();
    expect(claimsSovereignId(v.mid.toUpperCase())).toBe(true);
    expect((await refuseSovereignIdSquat(v.mid.toUpperCase(), hex(x)))?.code).toBe(
      "SOVEREIGN_ID_KEY_MISMATCH",
    );
    // The commitment is lower-case, so even V's key never matches the upper spelling.
    expect((await refuseSovereignIdSquat(v.mid.toUpperCase(), hex(v.kp)))?.code).toBe(
      "SOVEREIGN_ID_KEY_MISMATCH",
    );
  });

  it("a did:key id claims its key; a legacy UUIDv7 claims nothing", async () => {
    const v = await generateKeypair();
    const x = await generateKeypair();
    const did = hexPublicKeyToDidKey(hex(v));
    expect(claimsSovereignId(did)).toBe(true);
    expect(await refuseSovereignIdSquat(did, hex(v))).toBeNull();
    expect((await refuseSovereignIdSquat(did, hex(x)))?.code).toBe("SOVEREIGN_ID_KEY_MISMATCH");
    const legacy = "019a0000-0000-7000-8000-000000000000";
    expect(claimsSovereignId(legacy)).toBe(false);
    expect(await refuseSovereignIdSquat(legacy, hex(x))).toBeNull();
  });
});

describe("registry-key provenance (v58) is the proven key only while the registry still holds it", () => {
  const plantRegistry = (mid: string, key: string) =>
    relay.moteDb.db
      .prepare(
        `INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at)
         VALUES (?, ?, 'http://127.0.0.1:9999/mcp', '[]', 0, 0, 0)
         ON CONFLICT(motebit_id) DO UPDATE SET public_key = excluded.public_key`,
      )
      .run(mid, key);

  it("a pre-#875 registry row (no provenance) is not proven", async () => {
    const kp = await generateKeypair();
    const mid = crypto.randomUUID();
    plantRegistry(mid, hex(kp));
    expect(provenRegistryKeyOf(relay.moteDb.db, mid)).toBeNull();
  });

  it("evidence for K1 does not survive the registry moving to K2 without evidence", async () => {
    const k1 = await generateKeypair();
    const k2 = await generateKeypair();
    const mid = crypto.randomUUID();
    plantRegistry(mid, hex(k1));
    recordRegistryKeyEvidence(relay.moteDb.db, {
      motebitId: mid,
      publicKey: hex(k1),
      evidence: "key_proof",
      now: Date.now(),
    });
    expect(provenRegistryKeyOf(relay.moteDb.db, mid)).toBe(hex(k1));
    plantRegistry(mid, hex(k2));
    expect(provenRegistryKeyOf(relay.moteDb.db, mid)).toBeNull();
  });

  it("refuses to record evidence for something that is not a 32-byte key", () => {
    expect(() =>
      recordRegistryKeyEvidence(relay.moteDb.db, {
        motebitId: crypto.randomUUID(),
        publicKey: "not-a-key",
        evidence: "bearer",
        now: Date.now(),
      }),
    ).toThrow(/not a 32-byte hex public key/);
  });
});

describe("Inc 2 refuses nothing new — the doors still admit what main admits", () => {
  async function bootstrapRaw(body: unknown): Promise<number> {
    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    return res.status;
  }

  it("an UNSIGNED bootstrap (the published client's wire) is still admitted", async () => {
    const kp = await generateKeypair();
    expect(
      await bootstrapRaw({ motebit_id: crypto.randomUUID(), device_id: "d", public_key: hex(kp) }),
    ).toBe(201);
  });

  it("a squat-shaped bootstrap is still admitted here — refusing it is Inc 3 (refuseSovereignIdSquat wired)", async () => {
    const v = await sovereign();
    const x = await generateKeypair();
    expect(await refuseSovereignIdSquat(v.mid, hex(x))).not.toBeNull();
    expect(await bootstrapRaw({ motebit_id: v.mid, device_id: "x", public_key: hex(x) })).toBe(201);
  });
});
