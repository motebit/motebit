/**
 * #875 — the relay's key writers demand proof of possession.
 *
 * `POST /api/v1/agents/bootstrap` (public) and `POST /api/v1/agents/register`
 * took a `public_key` on the presenter's word: anyone could create identity
 * rows claiming any key, and — the pre-registration squat — X could bootstrap
 * V's not-yet-registered SOVEREIGN id `deriveSovereignMotebitId(K_V)` under
 * X's own key, then file and revoke V's `did:key` credentials under it and
 * sign delegation revocations in V's name (its key being one the relay held
 * for that id).
 *
 * The law, per door:
 *  - bootstrap: the body is a device-registration request signed by the key
 *    it names (register-self's construction, verifier and ±5-minute window),
 *    verified before any write.
 *  - /agents/register: a body key that is neither the bearer's verified
 *    device key nor already the identity's carries `key_proof` (the same
 *    signed request), or a succession record (whose new-key signature the
 *    route verifies). The operator's master token asserts on its own
 *    authority (as at `/device/register` and E-op).
 *  - every door, for an identity holding no key: an id shaped as a sovereign
 *    commitment (UUIDv8, any case) must be EXACTLY the commitment to the
 *    presented key — proof of possession of X's own key does not make
 *    V's id X's. register-self shares this through the guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  hexPublicKeyToDidKey,
  mintAudienceToken,
  signDeviceRegistration,
  signVerifiableCredential,
  type KeyPair,
  type VerifiableCredential,
} from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { keysHeldBy } from "../identity-keys.js";
import { claimsSovereignId } from "../device-registration-guard.js";
import { JSON_AUTH, createTestRelay, keyProof, signedBootstrapBody } from "./test-helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;

beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

/** Rows under `mid` in every table these doors write. */
function rowsFor(mid: string): Record<string, number> {
  const n = (sql: string) => (relay.moteDb.db.prepare(sql).get(mid) as { n: number }).n;
  return {
    identities: n("SELECT COUNT(*) AS n FROM identities WHERE motebit_id = ?"),
    devices: n("SELECT COUNT(*) AS n FROM devices WHERE motebit_id = ?"),
    registry: n("SELECT COUNT(*) AS n FROM agent_registry WHERE motebit_id = ?"),
    holder: n("SELECT COUNT(*) AS n FROM identity_keys WHERE motebit_id = ?"),
  };
}
const NONE = { identities: 0, devices: 0, registry: 0, holder: 0 };

function authEvents(reason: string): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COUNT(*) AS n FROM relay_auth_events WHERE reason = ?")
      .get(reason) as { n: number }
  ).n;
}

async function bootstrapRaw(body: unknown) {
  const res = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: JSON_HEADERS,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function bootstrap(mid: string, device: string, kp: KeyPair) {
  return bootstrapRaw(
    await signedBootstrapBody(
      { motebit_id: mid, device_id: device, public_key: hex(kp) },
      kp.privateKey,
    ),
  );
}

async function registerSelf(mid: string, device: string, kp: KeyPair) {
  const body = await signDeviceRegistration(
    { motebit_id: mid, device_id: device, public_key: hex(kp), timestamp: Date.now() },
    kp.privateKey,
  );
  const res = await relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function registerAsDevice(
  mid: string,
  device: string,
  kp: KeyPair,
  extra: Record<string, unknown>,
) {
  const { token } = await mintAudienceToken(
    { mid, did: device, aud: "admin:query" },
    kp.privateKey,
  );
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [], ...extra }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function registerAsOperator(mid: string, extra: Record<string, unknown>) {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: mid,
      endpoint_url: "http://127.0.0.1:9999/mcp",
      capabilities: [],
      ...extra,
    }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function sovereign() {
  const kp = await generateKeypair();
  return { kp, mid: await deriveSovereignMotebitId(hex(kp)) };
}

describe("bootstrap: proof of possession, before any write", () => {
  it("refuses an UNSIGNED bootstrap — the pre-#875 wire — with a repair instruction, writing nothing", async () => {
    const kp = await generateKeypair();
    const mid = crypto.randomUUID();
    const { status, json } = await bootstrapRaw({
      motebit_id: mid,
      device_id: "d",
      public_key: hex(kp),
    });
    expect(status).toBe(400);
    expect(json.code).toBe("KEY_PROOF_REQUIRED");
    expect(json.reason).toBe("missing");
    expect(String(json.remediation)).toContain("signDeviceRegistration");
    expect(rowsFor(mid)).toEqual(NONE);
  });

  it("refuses a FORGED proof — signed by another key over the victim's key", async () => {
    const victim = await generateKeypair();
    const attacker = await generateKeypair();
    const mid = crypto.randomUUID();
    const forged = await signDeviceRegistration(
      { motebit_id: mid, device_id: "d", public_key: hex(victim), timestamp: Date.now() },
      attacker.privateKey,
    );
    const { status, json } = await bootstrapRaw(forged);
    expect(status).toBe(400);
    expect(json.reason).toBe("bad_signature");
    expect(rowsFor(mid)).toEqual(NONE);
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
    const { status, json } = await bootstrapRaw({ ...signed, motebit_id: other });
    expect(status).toBe(400);
    expect(json.reason).toBe("bad_signature");
    expect(rowsFor(other)).toEqual(NONE);
  });

  it("refuses a STALE proof (outside register-self's ±5-minute window)", async () => {
    const kp = await generateKeypair();
    const mid = crypto.randomUUID();
    const stale = await signDeviceRegistration(
      { motebit_id: mid, device_id: "d", public_key: hex(kp), timestamp: Date.now() - 6 * 60_000 },
      kp.privateKey,
    );
    const { status, json } = await bootstrapRaw(stale);
    expect(status).toBe(400);
    expect(json.reason).toBe("stale");
    expect(rowsFor(mid)).toEqual(NONE);
  });

  it("admits a signed bootstrap — legacy and sovereign — and stays idempotent on (id, key)", async () => {
    const legacy = await generateKeypair();
    const lid = crypto.randomUUID();
    expect((await bootstrap(lid, "d", legacy)).status).toBe(201);
    expect((await bootstrap(lid, "d", legacy)).status).toBe(200);
    const { kp, mid } = await sovereign();
    expect((await bootstrap(mid, "d2", kp)).status).toBe(201);
  });
});

describe("the pre-registration squat of a sovereign id", () => {
  it("bootstrap: X, signing with its OWN key, cannot take V's not-yet-registered derive(K_V); V then arrives", async () => {
    const v = await sovereign();
    const x = await generateKeypair();
    const { status, json } = await bootstrap(v.mid, "x-dev", x);
    expect(status).toBe(409);
    expect(String(json.error)).toContain("sovereign id that is not the commitment");
    expect(rowsFor(v.mid)).toEqual(NONE);
    // X's key is not a key the relay holds for V — so it signs no delegation
    // revocation in V's name (bindByDelegationRevocation reads keysHeldBy).
    expect(keysHeldBy(relay.moteDb.db, v.mid).size).toBe(0);
    expect((await bootstrap(v.mid, "v-dev", v.kp)).status).toBe(201);
  });

  it("an upper-case spelling of V's sovereign id is a sovereign claim too — refused under X's key", async () => {
    const v = await sovereign();
    const x = await generateKeypair();
    expect(claimsSovereignId(v.mid.toUpperCase())).toBe(true);
    expect((await bootstrap(v.mid.toUpperCase(), "x-dev", x)).status).toBe(409);
    expect(rowsFor(v.mid.toUpperCase())).toEqual(NONE);
  });

  it("register-self (the sibling public door) refuses the same squat through the shared guard", async () => {
    const v = await sovereign();
    const x = await generateKeypair();
    const { status, json } = await registerSelf(v.mid, "x-dev", x);
    expect(status).toBe(409);
    expect(json.code).toBe("SOVEREIGN_ID_KEY_MISMATCH");
    expect(rowsFor(v.mid)).toEqual(NONE);
    expect((await registerSelf(v.mid, "v-dev", v.kp)).status).toBe(201);
  });

  it("/agents/register under the master token: the operator cannot squat derive(K_V) with another key either (no registry, no E-op holder)", async () => {
    const v = await sovereign();
    const x = await generateKeypair();
    const { status, json } = await registerAsOperator(v.mid, { public_key: hex(x) });
    expect(status).toBe(409);
    expect(json.code).toBe("SOVEREIGN_ID_KEY_MISMATCH");
    expect(rowsFor(v.mid)).toEqual(NONE);
    expect(authEvents("register:sovereign_id_key_mismatch")).toBe(1);
    // V's own key under V's id is the operator's to register (E-op).
    expect((await registerAsOperator(v.mid, { public_key: hex(v.kp) })).status).toBe(200);
  });

  it("the squat's consequence is gone: V's did:key credential binds to V; X holds no token for V's id", async () => {
    const v = await sovereign();
    const x = await generateKeypair();
    expect((await bootstrap(v.mid, "x-dev", x)).status).toBe(409);
    // X cannot authenticate as V's id: no device row carries X's key there.
    const { token } = await mintAudienceToken(
      { mid: v.mid, did: "x-dev", aud: "admin:query" },
      x.privateKey,
    );
    const asX = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [] }),
    });
    expect(asX.status).toBe(401);
    // V's credential about itself binds under V's id (the sovereign commitment).
    const issuer = await generateKeypair();
    const vc = await signVerifiableCredential(
      {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        id: `urn:uuid:${crypto.randomUUID()}`,
        type: ["VerifiableCredential", "AgentReputationCredential"],
        issuer: hexPublicKeyToDidKey(hex(issuer)),
        validFrom: new Date().toISOString(),
        credentialSubject: { id: hexPublicKeyToDidKey(hex(v.kp)), success_rate: 1 },
      } as unknown as Omit<VerifiableCredential, "proof">,
      issuer.privateKey,
      issuer.publicKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${v.mid}/credentials/submit`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ credentials: [vc] }),
    });
    expect(((await res.json()) as { accepted: number }).accepted).toBe(1);
  });
});

describe("/agents/register: a body key the request does not prove never enters", () => {
  async function legacyDevice() {
    const kp = await generateKeypair();
    const mid = `legacy-${crypto.randomUUID()}`;
    expect((await bootstrap(mid, "own", kp)).status).toBe(201);
    return { kp, mid };
  }

  it("refuses X's bearer naming V's key as X's registry key — the first registration took any key", async () => {
    const x = await legacyDevice();
    const v = await generateKeypair();
    const { status, json } = await registerAsDevice(x.mid, "own", x.kp, { public_key: hex(v) });
    expect(status).toBe(400);
    expect(json.code).toBe("KEY_PROOF_REQUIRED");
    expect(json.reason).toBe("key_proof_missing");
    expect(rowsFor(x.mid).registry).toBe(0);
    expect(keysHeldBy(relay.moteDb.db, x.mid).has(hex(v))).toBe(false);
    expect(authEvents("register:key_proof_missing")).toBe(1);
  });

  it("refuses a key_proof that is forged, names another id or key, or is stale", async () => {
    const x = await legacyDevice();
    const v = await generateKeypair();
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        await keyProof({ motebit_id: x.mid, public_key: hex(v) }, x.kp.privateKey),
        "key_proof_bad_signature",
      ],
      [
        await keyProof({ motebit_id: "someone-else", public_key: hex(v) }, v.privateKey),
        "key_proof_motebit_id_mismatch",
      ],
      [
        await keyProof(
          { motebit_id: x.mid, public_key: hex(await generateKeypair()) },
          v.privateKey,
        ),
        "key_proof_bad_signature",
      ],
      [
        await signDeviceRegistration(
          {
            motebit_id: x.mid,
            device_id: "p",
            public_key: hex(v),
            timestamp: Date.now() - 6 * 60_000,
          },
          v.privateKey,
        ),
        "key_proof_stale",
      ],
    ];
    for (const [proof, reason] of cases) {
      const { status, json } = await registerAsDevice(x.mid, "own", x.kp, {
        public_key: hex(v),
        key_proof: proof,
      });
      expect(status, reason).toBe(400);
      expect(json.reason).toBe(reason);
    }
    // A proof naming a DIFFERENT key than the body's: signed validly by that key.
    const w = await generateKeypair();
    const mismatch = await registerAsDevice(x.mid, "own", x.kp, {
      public_key: hex(v),
      key_proof: await keyProof({ motebit_id: x.mid, public_key: hex(w) }, w.privateKey),
    });
    expect(mismatch.json.reason).toBe("key_proof_public_key_mismatch");
    expect(rowsFor(x.mid).registry).toBe(0);
  });

  it("admits a body key carrying its own valid key_proof", async () => {
    const x = await legacyDevice();
    const v = await generateKeypair();
    const { status } = await registerAsDevice(x.mid, "own", x.kp, {
      public_key: hex(v),
      key_proof: await keyProof({ motebit_id: x.mid, public_key: hex(v) }, v.privateKey),
    });
    expect(status).toBe(200);
  });

  it("needs no proof for the bearer's own key, a key the identity already holds, or a keyless registration", async () => {
    const x = await legacyDevice();
    expect((await registerAsDevice(x.mid, "own", x.kp, { public_key: hex(x.kp) })).status).toBe(
      200,
    );
    expect((await registerAsDevice(x.mid, "own", x.kp, {})).status).toBe(200);
    // A device paired without key transfer registers the identity key it does not hold.
    const paired = await generateKeypair();
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("paired", x.mid, "tok-paired", hex(paired), 1);
    expect(
      (await registerAsDevice(x.mid, "paired", paired, { public_key: hex(x.kp) })).status,
    ).toBe(200);
  });

  it("legacy + sovereign lifecycle: signed bootstrap, then register with the device's own key", async () => {
    const x = await legacyDevice();
    expect((await registerAsDevice(x.mid, "own", x.kp, { public_key: hex(x.kp) })).status).toBe(
      200,
    );
    const s = await sovereign();
    expect((await bootstrap(s.mid, "s-own", s.kp)).status).toBe(201);
    expect((await registerAsDevice(s.mid, "s-own", s.kp, { public_key: hex(s.kp) })).status).toBe(
      200,
    );
    // E-sov (bearer possession + sovereign commitment) fills the holder, as before.
    expect(rowsFor(s.mid).holder).toBe(1);
  });

  it("the operator's master token registers a legacy service identity's key on its own authority (E-op), unchanged", async () => {
    const kp = await generateKeypair();
    const svc = `svc-${crypto.randomUUID()}`;
    expect((await registerAsOperator(svc, { public_key: hex(kp) })).status).toBe(200);
    expect(rowsFor(svc)).toMatchObject({ registry: 1, holder: 1 });
  });
});
