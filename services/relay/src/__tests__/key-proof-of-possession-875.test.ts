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

  it("needs no proof for the bearer's own key, the identity's PROVEN holder key, or a keyless registration", async () => {
    const x = await legacyDevice();
    expect((await registerAsDevice(x.mid, "own", x.kp, { public_key: hex(x.kp) })).status).toBe(
      200,
    );
    expect((await registerAsDevice(x.mid, "own", x.kp, {})).status).toBe(200);
    // A sovereign identity with a proven holder (E-sov): a second device of it
    // may name the holder key it does not itself hold.
    const s = await sovereign();
    expect((await bootstrap(s.mid, "s-own", s.kp)).status).toBe(201);
    expect((await registerAsDevice(s.mid, "s-own", s.kp, { public_key: hex(s.kp) })).status).toBe(
      200,
    );
    expect(rowsFor(s.mid).holder).toBe(1);
    const paired = await generateKeypair();
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("s-paired", s.mid, "tok-s-paired", hex(paired), 1);
    expect(
      (await registerAsDevice(s.mid, "s-paired", paired, { public_key: hex(s.kp) })).status,
    ).toBe(200);
  });

  it("a key that is merely a DEVICE ROW is not evidence — pairing cannot launder V's key into X's registry (#875 review)", async () => {
    // The repro: X bootstraps its own key, pairs itself claiming V's key
    // (claim is unsigned), approves, then registers V's key as its registry key.
    const x = await legacyDevice();
    const v = await generateKeypair();
    const dt = (
      await mintAudienceToken({ mid: x.mid, did: "own", aud: "device:auth" }, x.kp.privateKey)
    ).token;
    const post = async (path: string, body: unknown, auth?: string) => {
      const res = await relay.app.request(path, {
        method: "POST",
        headers: { ...JSON_HEADERS, ...(auth != null ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        json: (await res.json().catch(() => null)) as Record<string, unknown>,
      };
    };
    const init = await post("/pairing/initiate", {}, dt);
    expect(init.status).toBeLessThan(300);
    expect(
      (
        await post("/pairing/claim", {
          pairing_code: init.json.pairing_code,
          device_name: "fake",
          public_key: hex(v),
        })
      ).status,
    ).toBe(200);
    expect((await post(`/pairing/${String(init.json.pairing_id)}/approve`, {}, dt)).status).toBe(
      200,
    );
    expect(
      keysHeldBy(relay.moteDb.db, x.mid).has(hex(v)),
      "arrange: V's key is a device row of X",
    ).toBe(true);
    const reg = await registerAsDevice(x.mid, "own", x.kp, { public_key: hex(v) });
    expect(reg.status).toBe(400);
    expect(reg.json.reason).toBe("key_proof_missing");
    expect(rowsFor(x.mid).registry).toBe(0);
  });

  it("pairing approve drops a key transfer whose identity_pubkey_check is not the approver's own key", async () => {
    const x = await legacyDevice();
    const v = await generateKeypair();
    const dt = (
      await mintAudienceToken({ mid: x.mid, did: "own", aud: "device:auth" }, x.kp.privateKey)
    ).token;
    const req = async (path: string, body: unknown, auth?: string) => {
      const res = await relay.app.request(path, {
        method: "POST",
        headers: { ...JSON_HEADERS, ...(auth != null ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        json: (await res.json().catch(() => null)) as Record<string, unknown>,
      };
    };
    const transfer = (check: string) => ({
      x25519_pubkey: "11".repeat(32),
      encrypted_seed: "22".repeat(48),
      nonce: "33".repeat(12),
      tag: "44".repeat(16),
      identity_pubkey_check: check,
    });
    const storedTransfer = (pairingId: string) =>
      (
        relay.moteDb.db
          .prepare("SELECT key_transfer_payload FROM pairing_sessions WHERE pairing_id = ?")
          .get(pairingId) as { key_transfer_payload: string | null }
      ).key_transfer_payload;
    for (const [check, kept] of [
      [hex(v), false],
      [hex(x.kp), true],
    ] as const) {
      const claimer = await generateKeypair();
      const init = await req("/pairing/initiate", {}, dt);
      await req("/pairing/claim", {
        pairing_code: init.json.pairing_code,
        device_name: "b",
        public_key: hex(claimer),
      });
      const pid = String(init.json.pairing_id);
      expect(
        (await req(`/pairing/${pid}/approve`, { key_transfer: transfer(check) }, dt)).status,
      ).toBe(200);
      expect(storedTransfer(pid) != null, `identity_pubkey_check=${kept ? "own" : "V's"}`).toBe(
        kept,
      );
    }
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

describe("a device row is never evidence of the identity's key (#875 review round 2)", () => {
  /** X (legacy, register-self K_X) pairs itself claiming K_V unsigned and approves it. */
  async function launder() {
    const xKp = await generateKeypair();
    const vKp = await generateKeypair();
    const x = `legacy-${crypto.randomUUID()}`;
    expect((await registerSelf(x, "x-own", xKp)).status).toBe(201);
    const dt = (
      await mintAudienceToken({ mid: x, did: "x-own", aud: "device:auth" }, xKp.privateKey)
    ).token;
    const post = async (path: string, body: unknown, auth?: string) => {
      const res = await relay.app.request(path, {
        method: "POST",
        headers: { ...JSON_HEADERS, ...(auth != null ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        json: (await res.json().catch(() => null)) as Record<string, unknown>,
      };
    };
    const init = await post("/pairing/initiate", {}, dt);
    await post("/pairing/claim", {
      pairing_code: init.json.pairing_code,
      device_name: "fake",
      public_key: hex(vKp),
    });
    expect((await post(`/pairing/${String(init.json.pairing_id)}/approve`, {}, dt)).status).toBe(
      200,
    );
    // Re-register X's own row so the laundered row is listed FIRST (INSERT OR
    // REPLACE moves X's row to the end) — main's "first-listed" read.
    expect((await registerSelf(x, "x-own", xKp)).status).toBeLessThan(300);
    return { x, xKp, vKp };
  }
  const registryKey = (mid: string) =>
    (
      relay.moteDb.db
        .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
        .get(mid) as { public_key: string } | undefined
    )?.public_key;

  it("keyless /agents/register introduces no key — never the laundered device row; discover never serves V's key", async () => {
    const { x, xKp, vKp } = await launder();
    const first = relay.moteDb.db
      .prepare("SELECT public_key FROM devices WHERE motebit_id = ? AND public_key != '' LIMIT 1")
      .get(x) as { public_key: string };
    expect(first.public_key, "arrange: V's key is the first-listed row").toBe(hex(vKp));
    expect((await registerAsDevice(x, "x-own", xKp, {})).status).toBe(200);
    expect(registryKey(x)).toBe("");
    const disc = (await (await relay.app.request(`/api/v1/discover/${x}`)).json()) as {
      public_key?: string;
    };
    expect(disc.public_key).not.toBe(hex(vKp));
  });

  it("a paired device's keyless registration FIRST cannot pin the registry: the owner's keyed registration afterwards succeeds (#875 review round 3)", async () => {
    const aKp = await generateKeypair();
    const bKp = await generateKeypair();
    const id = `legacy-${crypto.randomUUID()}`;
    expect((await registerSelf(id, "a-dev", aKp)).status).toBe(201);
    // B: a device paired without key transfer (its own key on its own row).
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("b-dev", id, "tok-b", hex(bKp), 1);
    expect((await registerAsDevice(id, "b-dev", bKp, {})).status).toBe(200);
    expect(registryKey(id)).toBe("");
    expect((await registerAsDevice(id, "a-dev", aKp, { public_key: hex(aKp) })).status).toBe(200);
    expect(registryKey(id)).toBe(hex(aKp));
  });

  it("GET /api/v1/discover/:id, GET /api/v1/agents/:id, the discover list and the A2A card never serve an unproven registry key (a pre-#875 row)", async () => {
    const vKp = await generateKeypair();
    const x = `legacy-${crypto.randomUUID()}`;
    // X's registry row carrying V's key, as a relay before #875 admitted it.
    relay.moteDb.db
      .prepare(
        "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        x,
        hex(vKp),
        "http://127.0.0.1:9999/mcp",
        JSON.stringify(["svc"]),
        Date.now(),
        Date.now(),
        Date.now() + 86_400_000,
      );
    const get = async (path: string) => (await relay.app.request(path)).json();
    expect(((await get(`/api/v1/discover/${x}`)) as { public_key?: string }).public_key).toBe("");
    expect(
      (
        (await (await relay.app.request(`/api/v1/agents/${x}`, { headers: JSON_AUTH })).json()) as {
          public_key: string;
        }
      ).public_key,
    ).toBe("");
    const list = (await (
      await relay.app.request(`/api/v1/agents/discover?motebit_id=${x}&include=all`)
    ).json()) as { agents: Array<{ motebit_id: string; public_key: string; did?: string }> };
    const row = list.agents.find((a) => a.motebit_id === x);
    expect(row?.public_key).toBe("");
    expect(row?.did).toBeUndefined();
    const card = (await get(`/a2a/agents/${x}/agent.json`)) as {
      "x-motebit": { public_key: string; did: string };
    };
    expect(card["x-motebit"].public_key).toBe("");
    expect(card["x-motebit"].did).toBe(`did:motebit:${x}`);
    // The capabilities route answers only for an identity the relay knows.
    relay.moteDb.db
      .prepare(
        "INSERT INTO identities (motebit_id, owner_id, created_at, version_clock) VALUES (?, ?, ?, 0)",
      )
      .run(x, `self:${x}`, 1);
    const caps = (await get(`/agent/${x}/capabilities`)) as { public_key: string };
    expect(caps.public_key).toBe("");
  });

  it("the federation discover response serves the same key — never the bare registry column", async () => {
    await relay.close();
    relay = await createTestRelay({
      // The unsigned-discover rollout window: this test is about the KEY the
      // response serves, not about peer authentication.
      federation: {
        endpointUrl: "https://home.example",
        displayName: "Home",
        requireDiscoverSignature: false,
      },
    });
    const vKp = await generateKeypair();
    const x = `legacy-${crypto.randomUUID()}`;
    relay.moteDb.db
      .prepare(
        "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        x,
        hex(vKp),
        "http://127.0.0.1:9999/mcp",
        JSON.stringify(["svc"]),
        Date.now(),
        Date.now(),
        Date.now() + 86_400_000,
      );
    const res = await relay.app.request("/federation/v1/discover", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        query: { motebit_id: x },
        hop_count: 0,
        max_hops: 1,
        visited: [],
        query_id: `q-${crypto.randomUUID()}`,
        origin_relay: "peer-relay-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{ motebit_id: string; public_key: string }>;
    };
    const row = body.agents.find((a) => a.motebit_id === x);
    expect(row, JSON.stringify(body)).toBeDefined();
    expect(row!.public_key).toBe("");
  });

  it("a sovereign identity's key on file is served when it has no holder — the id commits to it", async () => {
    const s = await sovereign();
    // A device row for the genesis key, as a relay before the holder existed left it.
    relay.moteDb.db
      .prepare(
        "INSERT INTO identities (motebit_id, owner_id, created_at, version_clock) VALUES (?, ?, ?, 0)",
      )
      .run(s.mid, `self:${s.mid}`, 1);
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("s-dev", s.mid, "tok-s", hex(s.kp), 1);
    const caps = (await (await relay.app.request(`/agent/${s.mid}/capabilities`)).json()) as {
      public_key: string;
    };
    expect(caps.public_key).toBe(hex(s.kp));
  });

  it("the operator's keyless registration writes '' rather than any device row", async () => {
    const { x, vKp } = await launder();
    expect((await registerAsOperator(x, {})).status).toBe(200);
    expect(registryKey(x)).toBe("");
    expect(registryKey(x)).not.toBe(hex(vKp));
  });

  it("GET /agent/:id/capabilities never serves a device row as the identity's public_key or did", async () => {
    const { x, vKp } = await launder();
    const caps = (await (await relay.app.request(`/agent/${x}/capabilities`)).json()) as {
      public_key: string;
      did?: string;
    };
    expect(caps.public_key).not.toBe(hex(vKp));
    expect(caps.did).not.toBe(hexPublicKeyToDidKey(hex(vKp)));
  });

  it("revoke-credential as ISSUER needs the key the caller's token verified under — a laundered device row does not make X the issuer of V's credentials", async () => {
    const { x, xKp, vKp } = await launder();
    const subject = `subj-${crypto.randomUUID()}`;
    const credId = `urn:uuid:${crypto.randomUUID()}`;
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credId,
        subject,
        hexPublicKeyToDidKey(hex(vKp)),
        "AgentReputationCredential",
        "{}",
        Date.now(),
      );
    const revokeAs = async (mid: string, did: string, kp: KeyPair) => {
      const { token } = await mintAudienceToken({ mid, did, aud: "admin:query" }, kp.privateKey);
      return relay.app.request(`/api/v1/agents/${subject}/revoke-credential`, {
        method: "POST",
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ credential_id: credId }),
      });
    };
    expect((await revokeAs(x, "x-own", xKp)).status).toBe(403);
    // V itself — the real issuer, its token verified under K_V — may.
    const v = `legacy-${crypto.randomUUID()}`;
    expect((await registerSelf(v, "v-own", vKp)).status).toBe(201);
    expect((await revokeAs(v, "v-own", vKp)).status).toBe(200);
  });

  it("the relay's own reputation credential names the subject by evidence (holder or did:motebit), never a device row", async () => {
    await relay.close();
    relay = await createTestRelay({ issueCredentials: true });
    const { x, vKp } = await launder();
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`s-${crypto.randomUUID()}`, "a", "t", x, "h", null, 0, 0, 0.05, "completed", Date.now());
    const res = await relay.app.request(`/api/v1/credentials/${x}/reputation`, {
      method: "POST",
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);
    const vc = ((await res.json()) as { credential: { credentialSubject: { id: string } } })
      .credential;
    expect(vc.credentialSubject.id).toBe(`did:motebit:${x}`);
    expect(vc.credentialSubject.id).not.toBe(hexPublicKeyToDidKey(hex(vKp)));
  });

  it("the bearer-fallback clause: a service identity with no device row registers the registry key its token verified under", async () => {
    const kp = await generateKeypair();
    const svc = `svc-${crypto.randomUUID()}`;
    relay.moteDb.db
      .prepare(
        "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at) VALUES (?, ?, ?, '[]', 1, 1, ?)",
      )
      .run(svc, hex(kp), "http://127.0.0.1:9999/mcp", Date.now() + 86_400_000);
    // No device row for this did: the middleware verifies under the registry
    // (holder-else-registry fallback), and that is the bearer's verified key.
    const res = await registerAsDevice(svc, "svc-no-row", kp, { public_key: hex(kp) });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  });
});
