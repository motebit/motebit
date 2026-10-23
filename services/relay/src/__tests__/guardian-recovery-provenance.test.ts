/**
 * A guardian recovery is accepted only under a guardian set with PROVENANCE
 * (docs/design/identity-authority-writers.md I1, §3.2; census Q4).
 *
 * The defect (live on main before this harness): a paired device's token —
 * its OWN key, not the identity's — could `POST /api/v1/agents/register`
 * with `guardian_public_key = G`, where G is a key the attacker controls
 * (the guardian attestation is self-made: G signs it), and get 200. Then
 * `signGuardianRecoverySuccession(G, K0 → K_att)` posted to `/rotate-key`
 * (recovery skips the caller check) moved the identity's key to K_att: a
 * full identity takeover by a paired device, and from there its money
 * destinations.
 *
 * The rule: a guardian has provenance only when the request that set it was
 * proven with the identity's CURRENT key at that moment — the bearer was
 * verified by a device row holding exactly the identity's held key, or the
 * same request recorded the sovereign first key (E-sov) it was proven
 * under. A device token on its own key, the operator's master token (D3),
 * a legacy identity with no held key (D2) and the v42 backfill's transplant
 * set no provenance; a recovery under such a guardian is refused 403
 * `GUARDIAN_NOT_PROVEN`. A recovery is accepted IFF the guardian on file
 * has provenance AND the record is signed by that guardian.
 *
 * Matrix: setter × recovery signer × identity kind, the exact repro as a
 * named cell, the register door's own recovery branch, the replaced-
 * guardian revival, and a differential set — every other /rotate-key and
 * register request answers as on origin/main.
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
import {
  IDENTITY_KEYS_BACKFILL_SQL,
  guardianEvidencePossible,
  guardianProvenance,
} from "../identity-keys.js";
import { GuardianNotProvenError } from "../errors.js";

let relay: SyncRelay;
const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

// ── Doors ──

async function registerSelf(mid: string, deviceId: string, kp: KeyPair): Promise<number> {
  const body = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: deviceId,
      public_key: hex(kp),
      device_name: "test",
      timestamp: Date.now(),
    },
    kp.privateKey,
  );
  const res = await relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return res.status;
}

async function bootstrap(mid: string, deviceId: string, kp: KeyPair): Promise<number> {
  const res = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ motebit_id: mid, device_id: deviceId, public_key: hex(kp) }),
  });
  return res.status;
}

async function bearer(
  mid: string,
  deviceId: string,
  kp: KeyPair,
  aud: TokenAudience = "admin:query",
): Promise<string> {
  const { token } = await mintAudienceToken({ mid, did: deviceId, aud }, kp.privateKey);
  return `Bearer ${token}`;
}

/** Pair a device that keeps its OWN key (no key transfer): a device row of `mid`, key `kd`. */
async function pairDevice(
  mid: string,
  ownerDevice: string,
  owner: KeyPair,
  kd: KeyPair,
): Promise<string> {
  const auth = await bearer(mid, ownerDevice, owner, "device:auth");
  const init = await relay.app.request("/pairing/initiate", {
    method: "POST",
    headers: { Authorization: auth },
  });
  expect(init.ok).toBe(true);
  const { pairing_id, pairing_code } = (await init.json()) as {
    pairing_id: string;
    pairing_code: string;
  };
  const claim = await relay.app.request("/pairing/claim", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ pairing_code, device_name: "Paired", public_key: hex(kd) }),
  });
  expect(claim.ok).toBe(true);
  const approve = await relay.app.request(`/pairing/${pairing_id}/approve`, {
    method: "POST",
    headers: { Authorization: auth },
  });
  expect(approve.ok).toBe(true);
  return ((await approve.json()) as { device_id: string }).device_id;
}

async function guardianFields(mid: string, g: KeyPair): Promise<Record<string, string>> {
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

/** `/agents/register` under `authorization` (a device bearer, or the master token). */
async function register(
  mid: string,
  authorization: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: authorization },
    body: JSON.stringify({
      motebit_id: mid,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: [],
      ...extra,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function rotateKey(
  mid: string,
  authorization: string,
  record: KeySuccessionRecord,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: authorization },
    body: JSON.stringify(record),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

/** A stranger's own identity, used to CARRY a recovery (recovery skips the caller check). */
async function stranger(): Promise<string> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  const device = `s-${crypto.randomUUID()}`;
  expect(await registerSelf(mid, device, kp)).toBe(201);
  return bearer(mid, device, kp, "rotate-key");
}

const servedKey = (mid: string): string | null =>
  (
    relay.moteDb.db
      .prepare("SELECT public_key FROM identity_keys WHERE motebit_id = ?")
      .get(mid) as { public_key: string } | undefined
  )?.public_key ?? null;
const registryKey = (mid: string): string | null =>
  (
    relay.moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(mid) as { public_key: string } | undefined
  )?.public_key ?? null;
const successions = (mid: string): number =>
  (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_key_successions WHERE motebit_id = ?")
      .get(mid) as { n: number }
  ).n;

/** A guardian a legacy id got before the register door refused it (a registry write main allowed). */
const plantPreRefusalGuardian = (mid: string, g: KeyPair): void => {
  relay.moteDb.db
    .prepare("UPDATE agent_registry SET guardian_public_key = ? WHERE motebit_id = ?")
    .run(hex(g), mid);
};
const guardianOnFile = (mid: string): string | null =>
  (
    relay.moteDb.db
      .prepare("SELECT guardian_public_key FROM agent_registry WHERE motebit_id = ?")
      .get(mid) as { guardian_public_key: string | null } | undefined
  )?.guardian_public_key ?? null;

// ── P0 containment (guardian-recovery-containment.ts, GUARDIAN_RECOVERY_ENABLED = false) ──
//
// Every guardian recovery is refused 503 GUARDIAN_RECOVERY_SUSPENDED before
// the route reads a guardian, at both doors. The cases below keep their
// setup and assert, in place of the route's verdict, (a) the 503 and an
// unchanged identity, and (b) the PROVENANCE verdict the route would apply
// once recovery is re-enabled (`guardianProvenance`, and the refusal's wording
// from `GuardianNotProvenError` + `guardianEvidencePossible`). Titles carry
// `[recovery suspended]`. Restore the route-level assertions with the gate
// (git show this commit for the originals).

function expectSuspended(res: { status: number; body: unknown }): void {
  expect(res.status).toBe(503);
  expect((res.body as { code?: string } | null)?.code).toBe("GUARDIAN_RECOVERY_SUSPENDED");
}
const provenanceOf = (mid: string): { guardian: string | null; proven: boolean } =>
  guardianProvenance(relay.moteDb.db, mid);
/** The GUARDIAN_NOT_PROVEN wording the route would answer for this identity. */
const notProvenWording = (mid: string): string =>
  new GuardianNotProvenError(guardianEvidencePossible(relay.moteDb.db, mid) ? "provable" : "legacy")
    .message;

// ── Setters: each returns the identity, its current key, and the guardian it set ──

interface Planted {
  mid: string;
  k0: KeyPair;
  guardian: KeyPair;
  /** Whether the guardian was set with proven provenance. */
  proven: boolean;
}

type Kind = "sovereign" | "legacy";

/**
 * Every door that writes guardian_public_key, with the proof it carries.
 *
 *  - identity-key register: a bearer verified by the device row holding the
 *    identity's held key (sovereign: E-sov at register-self; legacy: E-op
 *    holder, then a device row on that same key).
 *  - sovereign bootstrap: bootstrap (no holder), then the FIRST register,
 *    whose bearer proves the genesis key — E-sov and the guardian in one request.
 *  - paired-device token: a device row on its OWN key (the defect).
 *  - operator: the master token (D3 — never raises authority).
 *  - backfill: the v42 E-main transplant of a registry guardian.
 *  - legacy device token, no held key: D2 — no current key exists.
 */
const SETTERS: Record<
  string,
  { kinds: Kind[]; proven: boolean; plant: (kind: Kind) => Promise<Planted> }
> = {
  "identity-key register": {
    kinds: ["sovereign", "legacy"],
    proven: true,
    plant: async (kind) => {
      const k0 = await generateKeypair();
      const guardian = await generateKeypair();
      let mid: string;
      if (kind === "sovereign") {
        mid = await deriveSovereignMotebitId(hex(k0));
        expect(await registerSelf(mid, "laptop", k0)).toBe(201);
      } else {
        mid = `svc-${crypto.randomUUID()}`;
        // E-op: the operator registers a bare service identity — the holder is k0.
        expect(
          (
            await register(mid, AUTH_HEADER.Authorization, {
              public_key: hex(k0),
            })
          ).status,
        ).toBe(200);
        expect(servedKey(mid)).toBe(hex(k0));
        // A device on the held key itself (the seed holder) signs as the identity.
        expect(await registerSelf(mid, "laptop", k0)).toBe(201);
      }
      const r = await register(mid, await bearer(mid, "laptop", k0), {
        public_key: hex(k0),
        ...(await guardianFields(mid, guardian)),
      });
      expect(r.status).toBe(200);
      return { mid, k0, guardian, proven: true };
    },
  },
  "sovereign bootstrap": {
    kinds: ["sovereign"],
    proven: true,
    plant: async () => {
      const k0 = await generateKeypair();
      const guardian = await generateKeypair();
      const mid = await deriveSovereignMotebitId(hex(k0));
      expect(await bootstrap(mid, "laptop", k0)).toBe(201);
      expect(servedKey(mid)).toBeNull();
      const r = await register(mid, await bearer(mid, "laptop", k0), {
        ...(await guardianFields(mid, guardian)),
      });
      expect(r.status).toBe(200);
      expect(servedKey(mid)).toBe(hex(k0));
      return { mid, k0, guardian, proven: true };
    },
  },
  "paired-device token": {
    kinds: ["sovereign", "legacy"],
    proven: false,
    plant: async (kind) => {
      const k0 = await generateKeypair();
      const kd = await generateKeypair();
      const guardian = await generateKeypair();
      let mid: string;
      if (kind === "sovereign") {
        mid = await deriveSovereignMotebitId(hex(k0));
        expect(await registerSelf(mid, "laptop", k0)).toBe(201);
      } else {
        mid = `svc-${crypto.randomUUID()}`;
        expect(
          (await register(mid, AUTH_HEADER.Authorization, { public_key: hex(k0) })).status,
        ).toBe(200);
        expect(await registerSelf(mid, "laptop", k0)).toBe(201);
      }
      const paired = await pairDevice(mid, "laptop", k0, kd);
      // No public_key in the body: the register door fills in the held key.
      const r = await register(mid, await bearer(mid, paired, kd), {
        ...(await guardianFields(mid, guardian)),
      });
      expect(r.status).toBe(200);
      return { mid, k0, guardian, proven: false };
    },
  },
  operator: {
    kinds: ["legacy"],
    proven: false,
    plant: async () => {
      const k0 = await generateKeypair();
      const guardian = await generateKeypair();
      const mid = `svc-${crypto.randomUUID()}`;
      const r = await register(mid, AUTH_HEADER.Authorization, {
        public_key: hex(k0),
        ...(await guardianFields(mid, guardian)),
      });
      expect(r.status).toBe(200);
      expect(servedKey(mid)).toBe(hex(k0));
      return { mid, k0, guardian, proven: false };
    },
  },
  "v42 backfill transplant": {
    kinds: ["sovereign", "legacy"],
    proven: false,
    plant: async (kind) => {
      const k0 = await generateKeypair();
      const guardian = await generateKeypair();
      const mid =
        kind === "sovereign"
          ? await deriveSovereignMotebitId(hex(k0))
          : `legacy-${crypto.randomUUID()}`;
      // A pre-v42 registry row (main's guardian, set by any door), then E-main.
      relay.moteDb.db
        .prepare(
          "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, registered_at, last_heartbeat, expires_at, guardian_public_key) VALUES (?, ?, '', 1000, 1000, 9999999999999, ?)",
        )
        .run(mid, hex(k0), hex(guardian));
      relay.moteDb.db.prepare(IDENTITY_KEYS_BACKFILL_SQL).run(1_000, 1_000);
      expect(servedKey(mid)).toBe(hex(k0));
      return { mid, k0, guardian, proven: false };
    },
  },
  "legacy device token, no held key": {
    kinds: ["legacy"],
    proven: false,
    plant: async () => {
      const k0 = await generateKeypair();
      const guardian = await generateKeypair();
      const mid = crypto.randomUUID();
      expect(await registerSelf(mid, "laptop", k0)).toBe(201);
      expect(
        (await register(mid, await bearer(mid, "laptop", k0), { public_key: hex(k0) })).status,
      ).toBe(200);
      // The register door now REFUSES this guardian (below, "legacy ids"), so
      // it can only be on file from before that refusal: planted as a
      // pre-refusal registry guardian.
      plantPreRefusalGuardian(mid, guardian);
      expect(servedKey(mid)).toBeNull();
      return { mid, k0, guardian, proven: false };
    },
  },
};

describe("guardian recovery is accepted IFF the guardian was set with provenance and signs the record", () => {
  for (const [setter, def] of Object.entries(SETTERS)) {
    for (const kind of def.kinds) {
      for (const signer of ["that guardian", "a different key"] as const) {
        const accept = def.proven && signer === "that guardian";
        it(`[recovery suspended] ${setter} × ${kind} × recovery by ${signer} → 503 (would be ${accept ? "200" : "refused"})`, async () => {
          const p = await def.plant(kind);
          const next = await generateKeypair();
          const signingKey = signer === "that guardian" ? p.guardian : await generateKeypair();
          const record = await signGuardianRecoverySuccession(
            signingKey.privateKey,
            next.privateKey,
            p.k0.publicKey,
            next.publicKey,
          );
          const keyBefore = servedKey(p.mid);
          const res = await rotateKey(p.mid, await stranger(), record);
          // Suspended: nothing moves, whatever the guardian or signer.
          expectSuspended(res);
          expect(servedKey(p.mid)).toBe(keyBefore);
          expect(successions(p.mid)).toBe(0);
          // The verdict the route applies once re-enabled: accepted IFF the
          // guardian on file is proven AND signed the record.
          const gp = provenanceOf(p.mid);
          expect(gp.guardian).toBe(hex(p.guardian));
          expect(gp.proven).toBe(def.proven);
          expect(gp.proven && hex(signingKey) === gp.guardian).toBe(accept);
        });
      }
    }
  }
});

describe("the exact repro: a paired device plants its own guardian and takes the identity", () => {
  it("[recovery suspended] paired-device token sets G it controls (200), then signGuardianRecoverySuccession(G, K0 → K_att) at /rotate-key is refused 503 (would be 403 GUARDIAN_NOT_PROVEN)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    expect(
      (await register(mid, await bearer(mid, "laptop", k0), { public_key: hex(k0) })).status,
    ).toBe(200);

    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    const g = await generateKeypair(); // the attacker's
    // The self-made attestation: G signs that it guards `mid`.
    const plant = await register(mid, await bearer(mid, paired, kd), {
      ...(await guardianFields(mid, g)),
    });
    expect(plant.status).toBe(200);

    const kAtt = await generateKeypair();
    const takeover = await signGuardianRecoverySuccession(
      g.privateKey,
      kAtt.privateKey,
      k0.publicKey,
      kAtt.publicKey,
    );
    const res = await rotateKey(mid, await bearer(mid, paired, kd, "rotate-key"), takeover);
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: false });
    expect(notProvenWording(mid)).toMatch(/identity key/i);
    expect(servedKey(mid)).toBe(hex(k0));
    expect(registryKey(mid)).toBe(hex(k0));
    expect(successions(mid)).toBe(0);
    // The refusal is recorded under the presenter (rule 6).
    const ev = relay.moteDb.db
      .prepare(
        "SELECT reason FROM relay_auth_events WHERE reason = 'succession:guardian_recovery_suspended'",
      )
      .all();
    expect(ev.length).toBe(1);
  });

  it("[recovery suspended] the same attack through the register door's own recovery branch is refused too (503)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    const g = await generateKeypair();
    expect(
      (await register(mid, await bearer(mid, paired, kd), { ...(await guardianFields(mid, g)) }))
        .status,
    ).toBe(200);
    const kAtt = await generateKeypair();
    const succession = await signGuardianRecoverySuccession(
      g.privateKey,
      kAtt.privateKey,
      k0.publicKey,
      kAtt.publicKey,
    );
    const res = await register(mid, await bearer(mid, paired, kd), {
      public_key: hex(kAtt),
      succession,
    });
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: false });
    expect(servedKey(mid)).toBe(hex(k0));
    expect(successions(mid)).toBe(0);
    const ev = relay.moteDb.db
      .prepare(
        "SELECT reason FROM relay_auth_events WHERE reason = 'succession:guardian_recovery_suspended'",
      )
      .all();
    expect(ev.length).toBe(1);
  });

  it("[recovery suspended] the register door's recovery branch refuses even a proven guardian's record (503; would be 200)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const g = await generateKeypair();
    expect(
      (
        await register(mid, await bearer(mid, "laptop", k0), {
          public_key: hex(k0),
          ...(await guardianFields(mid, g)),
        })
      ).status,
    ).toBe(200);
    const k1 = await generateKeypair();
    const succession = await signGuardianRecoverySuccession(
      g.privateKey,
      k1.privateKey,
      k0.publicKey,
      k1.publicKey,
    );
    const res = await register(mid, AUTH_HEADER.Authorization, {
      public_key: hex(k1),
      succession,
    });
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: true });
    expect(servedKey(mid)).toBe(hex(k0));
    expect(registryKey(mid)).toBe(hex(k0));
    expect(successions(mid)).toBe(0);
  });

  it("[recovery suspended] a guardian the owner replaced cannot be revived by a paired device replaying its old attestation (503; would be 403)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const g1 = await generateKeypair();
    const g2 = await generateKeypair();
    const g1Fields = await guardianFields(mid, g1);
    const owner = await bearer(mid, "laptop", k0);
    expect((await register(mid, owner, { public_key: hex(k0), ...g1Fields })).status).toBe(200);
    expect(
      (await register(mid, owner, { public_key: hex(k0), ...(await guardianFields(mid, g2)) }))
        .status,
    ).toBe(200);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    expect((await register(mid, await bearer(mid, paired, kd), g1Fields)).status).toBe(200);
    const kAtt = await generateKeypair();
    const record = await signGuardianRecoverySuccession(
      g1.privateKey,
      kAtt.privateKey,
      k0.publicKey,
      kAtt.publicKey,
    );
    const res = await rotateKey(mid, await stranger(), record);
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g1), proven: false });
    expect(servedKey(mid)).toBe(hex(k0));
  });

  it("[recovery suspended] re-setting the guardian with the identity key restores its provenance; the recovery is still 503 (would be 403, then 200)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    const g = await generateKeypair();
    const fields = await guardianFields(mid, g);
    expect((await register(mid, await bearer(mid, paired, kd), fields)).status).toBe(200);
    const k1 = await generateKeypair();
    const rec = async () =>
      signGuardianRecoverySuccession(g.privateKey, k1.privateKey, k0.publicKey, k1.publicKey);
    expectSuspended(await rotateKey(mid, await stranger(), await rec()));
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: false });
    // The owner re-sets the same guardian under the identity key.
    expect(
      (await register(mid, await bearer(mid, "laptop", k0), { public_key: hex(k0), ...fields }))
        .status,
    ).toBe(200);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: true });
    expectSuspended(await rotateKey(mid, await stranger(), await rec()));
    expect(servedKey(mid)).toBe(hex(k0));
    expect(successions(mid)).toBe(0);
  });

  it("[recovery suspended] a proven guardian survives an ordinary rotation (200); its recovery from the new key is 503 (would be 200)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const g = await generateKeypair();
    expect(
      (
        await register(mid, await bearer(mid, "laptop", k0), {
          public_key: hex(k0),
          ...(await guardianFields(mid, g)),
        })
      ).status,
    ).toBe(200);
    const k1 = await generateKeypair();
    const rot = await signKeySuccession(k0.privateKey, k1.privateKey, k1.publicKey, k0.publicKey);
    expect((await rotateKey(mid, await bearer(mid, "laptop", k0, "rotate-key"), rot)).status).toBe(
      200,
    );
    const k2 = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      g.privateKey,
      k2.privateKey,
      k1.publicKey,
      k2.publicKey,
    );
    expectSuspended(await rotateKey(mid, await stranger(), rec));
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: true });
    expect(servedKey(mid)).toBe(hex(k1));
    expect(successions(mid)).toBe(1);
  });
});

describe("differential: every non-guardian-recovery request answers as on origin/main", () => {
  it("an ordinary rotation signed by the current key: 200, applied", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const k1 = await generateKeypair();
    const rot = await signKeySuccession(k0.privateKey, k1.privateKey, k1.publicKey, k0.publicKey);
    const res = await rotateKey(mid, await bearer(mid, "laptop", k0, "rotate-key"), rot);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, motebit_id: mid, applied: true });
    expect(servedKey(mid)).toBe(hex(k1));
  });

  it("an ordinary rotation by a paired device on its own key departs from nothing held: 400 as on main", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    const k1 = await generateKeypair();
    const rot = await signKeySuccession(kd.privateKey, k1.privateKey, k1.publicKey, kd.publicKey);
    const res = await rotateKey(mid, await bearer(mid, paired, kd, "rotate-key"), rot);
    expect(res.status).toBe(400);
    expect(servedKey(mid)).toBe(hex(k0));
  });

  it("[recovery suspended] a recovery with no guardian on file: 503 (would be 400 recovery_without_registered_guardian, as on main)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const g = await generateKeypair();
    const k1 = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      g.privateKey,
      k1.privateKey,
      k0.publicKey,
      k1.publicKey,
    );
    const res = await rotateKey(mid, await stranger(), rec);
    expectSuspended(res);
    expect(provenanceOf(mid).guardian).toBeNull();
    expect(servedKey(mid)).toBe(hex(k0));
  });

  it("[recovery suspended] a recovery without guardian_signature: 503 (would be 400, as on main)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const k1 = await generateKeypair();
    const rot = await signKeySuccession(k0.privateKey, k1.privateKey, k1.publicKey, k0.publicKey);
    const res = await rotateKey(mid, await stranger(), { ...rot, recovery: true });
    expectSuspended(res);
    expect(servedKey(mid)).toBe(hex(k0));
  });

  it("register without a guardian, by every setter's credential: 200 and the same body", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    for (const auth of [
      await bearer(mid, "laptop", k0),
      await bearer(mid, paired, kd),
      AUTH_HEADER.Authorization,
    ]) {
      const r = await register(mid, auth, {});
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ registered: true, motebit_id: mid });
    }
    expect(servedKey(mid)).toBe(hex(k0));
  });

  it("register WITH a guardian answers 200 whatever its provenance, and serves the guardian as on main", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    const g = await generateKeypair();
    const r = await register(mid, await bearer(mid, paired, kd), {
      ...(await guardianFields(mid, g)),
    });
    expect(r.status).toBe(200);
    const row = relay.moteDb.db
      .prepare("SELECT guardian_public_key FROM identity_keys WHERE motebit_id = ?")
      .get(mid) as { guardian_public_key: string };
    expect(row.guardian_public_key).toBe(hex(g));
  });

  it("register with an invalid guardian attestation: 400, as on main", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const g = await generateKeypair();
    const r = await register(mid, await bearer(mid, "laptop", k0), {
      public_key: hex(k0),
      guardian_public_key: hex(g),
      guardian_attestation: "00".repeat(64),
    });
    expect(r.status).toBe(400);
  });
});

/**
 * A legacy (non-sovereign) id with no held key can never get guardian
 * evidence: `holderKeyOf` is null for it and `recordFirstIdentityKey`
 * refuses its id (D2 — the evidence path for legacy ids is not built). So the
 * register door refuses to set its guardian, and a recovery under one set
 * before that refusal names no fix that cannot work. Prod measured Q4 = 0
 * (no guardians at all), so no existing user is affected by the refusal.
 */
describe("legacy ids: a guardian that can never be proven is refused, and the refusal says so", () => {
  it("legacy id, its own device token sets a guardian → 400 GUARDIAN_REQUIRES_SOVEREIGN_IDENTITY, nothing stored, recorded", async () => {
    const k0 = await generateKeypair();
    const mid = crypto.randomUUID();
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const g = await generateKeypair();
    const r = await register(mid, await bearer(mid, "laptop", k0), {
      public_key: hex(k0),
      ...(await guardianFields(mid, g)),
    });
    expect(r.status).toBe(400);
    const body = r.body as { code?: string; error?: string } | null;
    expect(body?.code).toBe("GUARDIAN_REQUIRES_SOVEREIGN_IDENTITY");
    expect(String(body?.error)).toMatch(/legacy/i);
    expect(String(body?.error)).toMatch(/sovereign identity/i);
    // Refused before any write: no registry row, no guardian, no holder.
    expect(registryKey(mid)).toBeNull();
    expect(guardianOnFile(mid)).toBeNull();
    expect(servedKey(mid)).toBeNull();
    const ev = relay.moteDb.db
      .prepare("SELECT reason FROM relay_auth_events WHERE reason = 'register:guardian_unprovable'")
      .all();
    expect(ev.length).toBe(1);
  });

  it("legacy id with a device row, the master token sets a guardian (no E-op possible) → 400", async () => {
    const k0 = await generateKeypair();
    const mid = crypto.randomUUID();
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const g = await generateKeypair();
    const r = await register(mid, AUTH_HEADER.Authorization, {
      public_key: hex(k0),
      ...(await guardianFields(mid, g)),
    });
    expect(r.status).toBe(400);
    expect((r.body as { code?: string } | null)?.code).toBe("GUARDIAN_REQUIRES_SOVEREIGN_IDENTITY");
    expect(guardianOnFile(mid)).toBeNull();
  });

  it("legacy id, register WITHOUT a guardian still answers 200 (only the guardian is refused)", async () => {
    const k0 = await generateKeypair();
    const mid = crypto.randomUUID();
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const r = await register(mid, await bearer(mid, "laptop", k0), { public_key: hex(k0) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ registered: true, motebit_id: mid });
  });

  it("legacy service id the operator registers with a key (E-op in the same request) may still set a guardian: 200", async () => {
    const k0 = await generateKeypair();
    const mid = `svc-${crypto.randomUUID()}`;
    const g = await generateKeypair();
    const r = await register(mid, AUTH_HEADER.Authorization, {
      public_key: hex(k0),
      ...(await guardianFields(mid, g)),
    });
    expect(r.status).toBe(200);
    expect(servedKey(mid)).toBe(hex(k0));
    expect(guardianOnFile(mid)).toBe(hex(g));
  });

  it("[recovery suspended] legacy id, recovery under a pre-refusal guardian → 503 (would be 403 GUARDIAN_NOT_PROVEN with the legacy wording, no re-set instruction)", async () => {
    const k0 = await generateKeypair();
    const mid = crypto.randomUUID();
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    expect(
      (await register(mid, await bearer(mid, "laptop", k0), { public_key: hex(k0) })).status,
    ).toBe(200);
    const g = await generateKeypair();
    plantPreRefusalGuardian(mid, g);
    const k1 = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      g.privateKey,
      k1.privateKey,
      k0.publicKey,
      k1.publicKey,
    );
    const res = await rotateKey(mid, await stranger(), rec);
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: false });
    expect(notProvenWording(mid)).toMatch(/legacy/i);
    expect(notProvenWording(mid)).toMatch(/not available/i);
    expect(notProvenWording(mid)).not.toMatch(/re-set/i);
    expect(registryKey(mid)).toBe(hex(k0));
    expect(successions(mid)).toBe(0);
  });

  it("[recovery suspended] legacy id, the same recovery through the register door's succession branch → 503 (would be 403 with the legacy wording)", async () => {
    const k0 = await generateKeypair();
    const mid = crypto.randomUUID();
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    expect(
      (await register(mid, await bearer(mid, "laptop", k0), { public_key: hex(k0) })).status,
    ).toBe(200);
    const g = await generateKeypair();
    plantPreRefusalGuardian(mid, g);
    const k1 = await generateKeypair();
    const succession = await signGuardianRecoverySuccession(
      g.privateKey,
      k1.privateKey,
      k0.publicKey,
      k1.publicKey,
    );
    const res = await register(mid, AUTH_HEADER.Authorization, {
      public_key: hex(k1),
      succession,
    });
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: false });
    expect(notProvenWording(mid)).toMatch(/legacy/i);
    expect(notProvenWording(mid)).not.toMatch(/re-set/i);
    expect(registryKey(mid)).toBe(hex(k0));
    expect(successions(mid)).toBe(0);
  });

  it("[recovery suspended] a provable identity's refusal keeps the fix (503; the would-be wording names the re-set)", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    const g = await generateKeypair();
    expect(
      (await register(mid, await bearer(mid, paired, kd), { ...(await guardianFields(mid, g)) }))
        .status,
    ).toBe(200);
    const k1 = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      g.privateKey,
      k1.privateKey,
      k0.publicKey,
      k1.publicKey,
    );
    const res = await rotateKey(mid, await stranger(), rec);
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: false });
    expect(notProvenWording(mid)).toMatch(
      /re-set the guardian with a request proven by the current identity key/,
    );
    expect(notProvenWording(mid)).not.toMatch(/legacy/i);
    expect(servedKey(mid)).toBe(hex(k0));
  });
});

describe("the bearer's key is the one the middleware verified, never re-read in the handler", () => {
  it("[recovery suspended] a device row rewritten to the identity key between auth and handler does not make a paired device's guardian proven", async () => {
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await registerSelf(mid, "laptop", k0)).toBe(201);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    const g = await generateKeypair();
    const auth = await bearer(mid, paired, kd);
    const fields = await guardianFields(mid, g);

    // The first read of the paired device's row is the middleware's (it
    // verifies the token under kd). Right after it returns, the row is
    // rewritten to the identity key k0 — the window a pairing update-key or
    // a rotation landing mid-request opens. Any later read sees k0.
    const storage = relay.moteDb.identityStorage as unknown as {
      loadDevice: (id: string) => Promise<{ public_key: string } | null>;
    };
    const original = storage.loadDevice.bind(storage);
    let rewritten = false;
    storage.loadDevice = async (id: string) => {
      const row = await original(id);
      if (id === paired && !rewritten) {
        rewritten = true;
        relay.moteDb.db
          .prepare("UPDATE devices SET public_key = ? WHERE device_id = ?")
          .run(hex(k0), paired);
      }
      return row;
    };
    try {
      expect((await register(mid, auth, fields)).status).toBe(200);
    } finally {
      storage.loadDevice = original;
    }
    expect(rewritten).toBe(true);

    // The token was verified under kd, so the guardian has no provenance.
    const k1 = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      g.privateKey,
      k1.privateKey,
      k0.publicKey,
      k1.publicKey,
    );
    const res = await rotateKey(mid, await stranger(), rec);
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: false });
    expect(servedKey(mid)).toBe(hex(k0));
  });

  it("[recovery suspended] no holder: a device row rewritten to the genesis key between auth and handler records no E-sov and no evidence for a paired device's guardian", async () => {
    // A sovereign id with NO holder (bootstrap proves nothing), and a paired
    // device on its own key kd. If the handler re-read the bearer's device
    // row after its awaits, it would see the genesis key k0, "prove" E-sov
    // for k0 under kd's token, and record the paired device's guardian G as
    // sovereign-proven — then recovery under G would take the identity.
    const k0 = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(k0));
    expect(await bootstrap(mid, "laptop", k0)).toBe(201);
    const kd = await generateKeypair();
    const paired = await pairDevice(mid, "laptop", k0, kd);
    expect(servedKey(mid)).toBeNull();
    const g = await generateKeypair();
    const auth = await bearer(mid, paired, kd);
    const fields = await guardianFields(mid, g);

    const storage = relay.moteDb.identityStorage as unknown as {
      loadDevice: (id: string) => Promise<{ public_key: string } | null>;
    };
    const original = storage.loadDevice.bind(storage);
    let rewritten = false;
    storage.loadDevice = async (id: string) => {
      const row = await original(id);
      if (id === paired && !rewritten) {
        rewritten = true;
        relay.moteDb.db
          .prepare("UPDATE devices SET public_key = ? WHERE device_id = ?")
          .run(hex(k0), paired);
      }
      return row;
    };
    try {
      expect((await register(mid, auth, fields)).status).toBe(200);
    } finally {
      storage.loadDevice = original;
    }
    expect(rewritten).toBe(true);

    // The token was verified under kd: no holder recorded from the rewritten
    // key, and no evidence row for G.
    expect(servedKey(mid)).toBeNull();
    expect(
      relay.moteDb.db
        .prepare("SELECT COUNT(*) AS n FROM relay_guardian_evidence WHERE motebit_id = ?")
        .get(mid),
    ).toEqual({ n: 0 });

    const k1 = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      g.privateKey,
      k1.privateKey,
      k0.publicKey,
      k1.publicKey,
    );
    const res = await rotateKey(mid, await stranger(), rec);
    expectSuspended(res);
    expect(provenanceOf(mid)).toEqual({ guardian: hex(g), proven: false });
    expect(successions(mid)).toBe(0);
  });
});
