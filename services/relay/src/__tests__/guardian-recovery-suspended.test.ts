/**
 * P0 containment: guardian recovery is SUSPENDED on this relay
 * (`guardian-recovery-containment.ts`, `GUARDIAN_RECOVERY_ENABLED = false`).
 *
 * On main a guardian recovery re-keys an identity on the proven guardian's
 * signature alone, with no caller check, and guardian provenance takes the
 * newest evidence row whatever key it was set under. Reproduced on main
 * (scratch probe, every step below answered 200 and moved the holder):
 *
 *  - S1: whoever holds the current key K1 registers their own guardian G_a;
 *    it is proven at once, the owner's guardian G_o stops working, and G_a
 *    recovers the identity to an attacker key immediately.
 *  - S2: the owner then rotates K1 → K2 (ordinary rotation); G_a is still
 *    proven and recovers K2 to an attacker key with NO current key — a
 *    persistent backdoor.
 *  - S4: a stale CLI daemon re-sends an OLD guardian attestation under the
 *    current key; the replaced guardian is proven again and recovers.
 *  - S3 (denial, not takeover): a paired device sets an unproven guardian,
 *    and the owner's own guardian recovery is refused GUARDIAN_NOT_PROVEN.
 *
 * Under the containment every one of those recoveries — at `/rotate-key` and
 * through the `/agents/register` succession branch, and at the one writer
 * `applySuccession` — answers 503 GUARDIAN_RECOVERY_SUSPENDED and the identity
 * tables are byte-for-byte unchanged. Ordinary rotation and guardian
 * registration still work.
 *
 * Tampers: `services/relay/tamper/guardian-recovery-suspended.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDeviceRegistration,
  mintAudienceToken,
  signKeySuccession,
  signGuardianRecoverySuccession,
  canonicalJson,
  ed25519Sign,
  deriveSovereignMotebitId,
} from "@motebit/crypto";
import type { KeyPair, KeySuccessionRecord } from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import { createTestRelay, AUTH_HEADER } from "./test-helpers.js";
import { guardianProvenance } from "../identity-keys.js";
import { applySuccession } from "../succession-apply.js";
import { GuardianRecoverySuspendedError } from "../errors.js";
import {
  GUARDIAN_RECOVERY_ENABLED,
  guardianRecoverySuspended,
  isGuardianRecovery,
} from "../guardian-recovery-containment.js";

let relay: SyncRelay;
const J = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

// ── Doors (the probe's setup) ──

async function registerSelf(mid: string, dev: string, kp: KeyPair): Promise<number> {
  const body = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: dev,
      public_key: hex(kp),
      device_name: "t",
      timestamp: Date.now(),
    },
    kp.privateKey,
  );
  return (
    await relay.app.request("/api/v1/devices/register-self", {
      method: "POST",
      headers: J,
      body: JSON.stringify(body),
    })
  ).status;
}

async function bearer(
  mid: string,
  did: string,
  kp: KeyPair,
  aud: TokenAudience = "admin:query",
): Promise<string> {
  const { token } = await mintAudienceToken({ mid, did, aud }, kp.privateKey);
  return `Bearer ${token}`;
}

async function pairDevice(mid: string, ownerDev: string, owner: KeyPair, kd: KeyPair) {
  const auth = await bearer(mid, ownerDev, owner, "device:auth");
  const init = await relay.app.request("/pairing/initiate", {
    method: "POST",
    headers: { Authorization: auth },
  });
  const { pairing_id, pairing_code } = (await init.json()) as {
    pairing_id: string;
    pairing_code: string;
  };
  await relay.app.request("/pairing/claim", {
    method: "POST",
    headers: J,
    body: JSON.stringify({ pairing_code, device_name: "P", public_key: hex(kd) }),
  });
  const ap = await relay.app.request(`/pairing/${pairing_id}/approve`, {
    method: "POST",
    headers: { Authorization: auth },
  });
  return ((await ap.json()) as { device_id: string }).device_id;
}

async function gFields(mid: string, g: KeyPair): Promise<Record<string, string>> {
  return {
    guardian_public_key: hex(g),
    guardian_attestation: bytesToHex(
      await ed25519Sign(
        new TextEncoder().encode(
          canonicalJson({
            action: "guardian_attestation",
            guardian_public_key: hex(g),
            motebit_id: mid,
          }),
        ),
        g.privateKey,
      ),
    ),
  };
}

async function register(
  mid: string,
  auth: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const r = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { ...J, Authorization: auth },
    body: JSON.stringify({
      motebit_id: mid,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: [],
      ...extra,
    }),
  });
  return {
    status: r.status,
    body: (await r.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

async function rotate(
  mid: string,
  auth: string,
  rec: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const r = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
    method: "POST",
    headers: { ...J, Authorization: auth },
    body: JSON.stringify(rec),
  });
  return {
    status: r.status,
    body: (await r.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

/** A stranger's own identity, used to CARRY a recovery (recovery skips the caller check). */
async function stranger(aud: TokenAudience = "rotate-key"): Promise<string> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  const d = `s-${crypto.randomUUID()}`;
  expect(await registerSelf(mid, d, kp)).toBe(201);
  return bearer(mid, d, kp, aud);
}

const served = (mid: string): string | null =>
  (
    relay.moteDb.db
      .prepare("SELECT public_key FROM identity_keys WHERE motebit_id = ?")
      .get(mid) as { public_key: string } | undefined
  )?.public_key ?? null;

const recover = async (mid: string, g: KeyPair, from: KeyPair, to: KeyPair) =>
  rotate(
    mid,
    await stranger(),
    await signGuardianRecoverySuccession(g.privateKey, to.privateKey, from.publicKey, to.publicKey),
  );

/** An owner: sovereign id at K1, guardian G_o set under K1 (proven). */
async function owner(): Promise<{ mid: string; k1: KeyPair; go: KeyPair }> {
  const k1 = await generateKeypair();
  const go = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(k1));
  expect(await registerSelf(mid, "laptop", k1)).toBe(201);
  const r = await register(mid, await bearer(mid, "laptop", k1), {
    public_key: hex(k1),
    ...(await gFields(mid, go)),
  });
  expect(r.status).toBe(200);
  return { mid, k1, go };
}

// ── The target identity's rows in every identity table (every column) ──
//
// Scoped to the target: carrying a recovery registers the carrier's OWN
// identity (register-self), which writes that identity's rows.

const IDENTITY_TABLES = [
  "identity_keys",
  "agent_registry",
  "relay_key_successions",
  "devices",
  "relay_guardian_evidence",
  "pairing_sessions",
  "relay_revocation_events",
] as const;

function snapshot(mid: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of IDENTITY_TABLES) {
    out[t] = relay.moteDb.db
      .prepare(`SELECT * FROM ${t} WHERE motebit_id = ? ORDER BY rowid`)
      .all(mid);
  }
  return out;
}

function expectSuspended(res: { status: number; body: Record<string, unknown> | null }): void {
  expect(res.status).toBe(503);
  expect(res.body?.code).toBe("GUARDIAN_RECOVERY_SUSPENDED");
  expect(String(res.body?.error)).toMatch(/temporarily suspended/i);
  expect(String(res.body?.error)).toMatch(/ordinary key rotation/i);
}

const suspendedEvents = (): number =>
  (
    relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_auth_events WHERE reason = 'succession:guardian_recovery_suspended'",
      )
      .get() as { n: number }
  ).n;

describe("the containment switch", () => {
  it("is off, and a recovery is decided by the verifier's own truthiness", () => {
    expect(GUARDIAN_RECOVERY_ENABLED).toBe(false);
    for (const r of [true, 1, "yes", {}]) {
      expect(isGuardianRecovery({ recovery: r })).toBe(true);
      expect(guardianRecoverySuspended({ recovery: r })).toBe(true);
    }
    for (const r of [undefined, false, 0, "", null]) {
      expect(isGuardianRecovery({ recovery: r })).toBe(false);
    }
    expect(isGuardianRecovery(null)).toBe(false);
    expect(isGuardianRecovery("recovery")).toBe(false);
  });
});

describe("the probe's takeovers: every recovery is 503 and the identity is unchanged", () => {
  it("S1 — a K1-holder plants guardian G_a; G_a's immediate recovery to an attacker key is 503", async () => {
    const { mid, k1 } = await owner();
    const ga = await generateKeypair();
    const kt = await generateKeypair();
    // Guardian REGISTRATION is unchanged: the K1-holder's G_a is accepted
    // and (on main's provenance model) proven.
    const setA = await register(mid, await bearer(mid, "laptop", k1), {
      public_key: hex(k1),
      ...(await gFields(mid, ga)),
    });
    expect(setA.status).toBe(200);
    expect(guardianProvenance(relay.moteDb.db, mid)).toEqual({ guardian: hex(ga), proven: true });

    const before = snapshot(mid);
    expectSuspended(await recover(mid, ga, k1, kt));
    expect(snapshot(mid)).toEqual(before);
    expect(served(mid)).toBe(hex(k1));
    expect(suspendedEvents()).toBe(1);
  });

  it("S2 — after the owner's ordinary rotation K1 → K2 (200), G_a's recovery of K2 is 503: no backdoor", async () => {
    const { mid, k1, go } = await owner();
    const ga = await generateKeypair();
    const k2 = await generateKeypair();
    const kt2 = await generateKeypair();
    expect(
      (
        await register(mid, await bearer(mid, "laptop", k1), {
          public_key: hex(k1),
          ...(await gFields(mid, ga)),
        })
      ).status,
    ).toBe(200);
    // The owner's own guardian G_o is refused too (S1's lock-out half).
    const beforeGo = snapshot(mid);
    expectSuspended(await recover(mid, go, k1, k2));
    expect(snapshot(mid)).toEqual(beforeGo);

    // Ordinary rotation is UNCHANGED: 200, applied, holder moves.
    const rot = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    const r2 = await rotate(mid, await bearer(mid, "laptop", k1, "rotate-key"), rot);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ ok: true, motebit_id: mid, applied: true });
    expect(served(mid)).toBe(hex(k2));
    // G_a is still the proven guardian on main's model — the backdoor's precondition.
    expect(guardianProvenance(relay.moteDb.db, mid)).toEqual({ guardian: hex(ga), proven: true });

    const before = snapshot(mid);
    expectSuspended(await recover(mid, ga, k2, kt2));
    expect(snapshot(mid)).toEqual(before);
    expect(served(mid)).toBe(hex(k2));
  });

  it("S4 — a stale daemon revives a replaced guardian; its recovery is 503", async () => {
    const { mid, k1, go } = await owner();
    const goFields = await gFields(mid, go);
    const gn = await generateKeypair();
    const kx = await generateKeypair();
    expect(
      (
        await register(mid, await bearer(mid, "laptop", k1), {
          public_key: hex(k1),
          ...(await gFields(mid, gn)),
        })
      ).status,
    ).toBe(200);
    // daemon.ts:745 shape: keyless body, the guardian from a stale identity file.
    expect((await register(mid, await bearer(mid, "laptop", k1), goFields)).status).toBe(200);
    expect(guardianProvenance(relay.moteDb.db, mid)).toEqual({ guardian: hex(go), proven: true });

    const before = snapshot(mid);
    expectSuspended(await recover(mid, go, k1, kx));
    expect(snapshot(mid)).toEqual(before);
    expect(served(mid)).toBe(hex(k1));
  });

  it("S3 — a paired device's unproven guardian: the owner's recovery is 503 too (suspended, not GUARDIAN_NOT_PROVEN)", async () => {
    const { mid, k1, go } = await owner();
    const kd = await generateKeypair();
    const gd = await generateKeypair();
    const k2 = await generateKeypair();
    const dev = await pairDevice(mid, "laptop", k1, kd);
    expect((await register(mid, await bearer(mid, dev, kd), await gFields(mid, gd))).status).toBe(
      200,
    );
    const before = snapshot(mid);
    expectSuspended(await recover(mid, go, k1, k2));
    expect(snapshot(mid)).toEqual(before);
  });

  it("the register door's succession branch: a recovery is 503 under the owner's token, the master token, and a stranger's", async () => {
    const { mid, k1, go } = await owner();
    const k2 = await generateKeypair();
    const succession = await signGuardianRecoverySuccession(
      go.privateKey,
      k2.privateKey,
      k1.publicKey,
      k2.publicKey,
    );
    const before = snapshot(mid);
    for (const auth of [
      await bearer(mid, "laptop", k1),
      AUTH_HEADER.Authorization,
      await stranger("admin:query"),
    ]) {
      const res = await register(mid, auth, { public_key: hex(k2), succession });
      expectSuspended(res);
    }
    expect(snapshot(mid)).toEqual(before);
    expect(served(mid)).toBe(hex(k1));
    expect(suspendedEvents()).toBe(3);
  });

  it("a non-boolean truthy `recovery` is a recovery too (the verifier takes the guardian branch on truthiness)", async () => {
    const { mid, k1, go } = await owner();
    const k2 = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      go.privateKey,
      k2.privateKey,
      k1.publicKey,
      k2.publicKey,
    );
    const before = snapshot(mid);
    expectSuspended(await rotate(mid, await stranger(), { ...rec, recovery: 1 }));
    expectSuspended(await rotate(mid, await stranger(), { ...rec, recovery: "yes" }));
    expect(snapshot(mid)).toEqual(before);
  });
});

describe("what is NOT suspended", () => {
  it("an ordinary rotation at /rotate-key: 200, applied", async () => {
    const { mid, k1 } = await owner();
    const k2 = await generateKeypair();
    const rot = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    const res = await rotate(mid, await bearer(mid, "laptop", k1, "rotate-key"), rot);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, motebit_id: mid, applied: true });
    expect(served(mid)).toBe(hex(k2));
    expect(suspendedEvents()).toBe(0);
  });

  it("an ordinary succession through the register door: 200, applied", async () => {
    const { mid, k1 } = await owner();
    const k2 = await generateKeypair();
    const succession = await signKeySuccession(
      k1.privateKey,
      k2.privateKey,
      k2.publicKey,
      k1.publicKey,
    );
    const res = await register(mid, await bearer(mid, "laptop", k1), {
      public_key: hex(k2),
      succession,
    });
    expect(res.status).toBe(200);
    expect(served(mid)).toBe(hex(k2));
    expect(suspendedEvents()).toBe(0);
  });

  it("guardian registration: 200, the guardian is on file", async () => {
    const { mid, k1 } = await owner();
    const g = await generateKeypair();
    const res = await register(mid, await bearer(mid, "laptop", k1), {
      public_key: hex(k1),
      ...(await gFields(mid, g)),
    });
    expect(res.status).toBe(200);
    expect(guardianProvenance(relay.moteDb.db, mid).guardian).toBe(hex(g));
  });
});

describe("the one writer refuses a recovery as a backstop", () => {
  it("applySuccession throws GuardianRecoverySuspendedError for a recovery record and writes nothing, even when no door gated it", async () => {
    const { mid, k1, go } = await owner();
    const k2 = await generateKeypair();
    const rec: KeySuccessionRecord = await signGuardianRecoverySuccession(
      go.privateKey,
      k2.privateKey,
      k1.publicKey,
      k2.publicKey,
    );
    const before = snapshot(mid);
    let retired = 0;
    expect(() =>
      applySuccession(relay.moteDb.db, mid, rec, () => {
        retired++;
      }),
    ).toThrow(GuardianRecoverySuspendedError);
    expect(snapshot(mid)).toEqual(before);
    expect(retired).toBe(0);
  });

  it("and still applies an ordinary record", async () => {
    const { mid, k1 } = await owner();
    const k2 = await generateKeypair();
    const rot = await signKeySuccession(k1.privateKey, k2.privateKey, k2.publicKey, k1.publicKey);
    const out = applySuccession(relay.moteDb.db, mid, rot, () => {});
    expect(out.applied).toBe(true);
    expect(served(mid)).toBe(hex(k2));
  });
});
