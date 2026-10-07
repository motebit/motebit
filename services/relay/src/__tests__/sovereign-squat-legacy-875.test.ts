/**
 * #875 review (c61ff603f) — a pre-#875 squat of a SOVEREIGN id is never
 * upgraded to proven, and an exact replay of a proof-of-possession body
 * changes nothing.
 *
 * F1. Before #875, X could plant its own key K_X under V's sovereign id
 * `deriveSovereignMotebitId(K_V)` (an unsigned bootstrap, or a keyed
 * `/agents/register`). After #875, X proves possession of K_X — its own key —
 * through a bearer the planted row verifies. That proves K_X is X's, never
 * that it is V's identity's: for a sovereign-shaped id a key is the
 * identity's only when it is the key the id commits to, or reached from it by
 * a recorded succession. Two planted shapes:
 *  - a holder-less identity row with X's device row (bootstrap's squat);
 *  - a registry row only (register's squat; X signs under a made-up device
 *    id and the auth fallback verifies it under the registry key).
 * In both, X's keyed registration is refused, nothing is recorded as proven,
 * nothing serves K_X, and V's own signed bootstrap wins: it is admitted and
 * the squat rows are parked (X's device rows removed, the registry key moved
 * to V's proven key and delisted), logged.
 *
 * F2. A proof-of-possession body (bootstrap, `key_proof`) carries no
 * audience or nonce, and the wire format is not changed here (clients are
 * released). The relay records each accepted proof; an exact replay is
 * idempotent-only — answered, never written again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  mintAudienceToken,
  signKeySuccession,
  type KeyPair,
} from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { recordRegistryKeyEvidence, servedIdentityKey } from "../identity-keys.js";
import { createTestRelay, keyProof, signedBootstrapBody } from "./test-helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

const db = () => relay.moteDb.db;
const plant = (sql: string, ...args: unknown[]) =>
  db()
    .prepare(sql)
    .run(...args);
const plantIdentity = (mid: string) =>
  plant(
    "INSERT INTO identities (motebit_id, owner_id, created_at, version_clock) VALUES (?, ?, ?, 0)",
    mid,
    mid,
    1,
  );
const plantDevice = (mid: string, device: string, key: string) =>
  plant(
    "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
    device,
    mid,
    crypto.randomUUID(),
    key,
    1,
  );
const plantRegistry = (mid: string, key: string) =>
  plant(
    "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    mid,
    key,
    "http://127.0.0.1:9999/mcp",
    "[]",
    1,
    1,
    Date.now() + 86_400_000,
  );
const evidenceOf = (mid: string) =>
  db()
    .prepare("SELECT public_key, evidence FROM relay_registry_key_evidence WHERE motebit_id = ?")
    .get(mid) as { public_key: string; evidence: string } | undefined;
const deviceKeys = (mid: string) =>
  (
    db().prepare("SELECT public_key FROM devices WHERE motebit_id = ?").all(mid) as Array<{
      public_key: string;
    }>
  ).map((r) => r.public_key);
const registryRow = (mid: string) =>
  db()
    .prepare("SELECT public_key, delisted_at FROM agent_registry WHERE motebit_id = ?")
    .get(mid) as { public_key: string; delisted_at: number | null } | undefined;

async function served(mid: string) {
  const get = async (path: string) =>
    ((await (await relay.app.request(path)).json()) as { public_key?: string }).public_key ?? "";
  return {
    discover: await get(`/api/v1/discover/${mid}`),
    helper: (await servedIdentityKey(db(), mid)) ?? "",
  };
}

async function bootstrap(mid: string, device: string, kp: KeyPair) {
  const body = await signedBootstrapBody(
    { motebit_id: mid, device_id: device, public_key: hex(kp) },
    kp.privateKey,
  );
  const res = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: JSON_HEADERS,
    body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, body };
}

async function registerAs(mid: string, device: string, kp: KeyPair, extra = {}) {
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

async function victimAndSquatter() {
  const vKp = await generateKeypair();
  const xKp = await generateKeypair();
  return { vKp, xKp, v: await deriveSovereignMotebitId(hex(vKp)) };
}

describe("F1 — a pre-#875 squat of a sovereign id is never upgraded to proven", () => {
  it("holder-less identity row + X's device row: X's keyed register is refused, K_X is never served, V's bootstrap wins and parks the squat", async () => {
    const { vKp, xKp, v } = await victimAndSquatter();
    plantIdentity(v);
    plantDevice(v, "x-dev", hex(xKp));

    const x = await registerAs(v, "x-dev", xKp, { public_key: hex(xKp) });
    expect(x.status).toBe(409);
    expect(x.json.code).toBe("SOVEREIGN_ID_KEY_MISMATCH");
    expect(evidenceOf(v)).toBeUndefined();
    expect(await served(v)).toEqual({ discover: "", helper: "" });

    // V's own signed bootstrap is admitted and the squat row is parked.
    const vb = await bootstrap(v, "v-dev", vKp);
    expect(vb.status).toBeLessThan(300);
    expect(deviceKeys(v)).toEqual([hex(vKp)]);
    // X's planted device no longer verifies a token under V's id.
    expect((await registerAs(v, "x-dev", xKp)).status).toBe(401);
    // V's keyless E-sov fills the holder; K_V is what is served.
    expect((await registerAs(v, "v-dev", vKp)).status).toBe(200);
    expect(await served(v)).toEqual({ discover: hex(vKp), helper: hex(vKp) });
  });

  it("registry-only row (X signs under a made-up device id): X's keyed register is refused, V's bootstrap wins, the squatted listing is delisted", async () => {
    const { vKp, xKp, v } = await victimAndSquatter();
    plantRegistry(v, hex(xKp));

    const x = await registerAs(v, "made-up-device", xKp, { public_key: hex(xKp) });
    expect(x.status).toBe(409);
    expect(x.json.code).toBe("SOVEREIGN_ID_KEY_MISMATCH");
    expect(evidenceOf(v)).toBeUndefined();
    expect(await served(v)).toEqual({ discover: "", helper: "" });

    const vb = await bootstrap(v, "v-dev", vKp);
    expect(vb.status).toBeLessThan(300);
    const reg = registryRow(v);
    expect(reg?.public_key).toBe("");
    expect(reg?.delisted_at).not.toBeNull();
    // X's made-up-device bearer no longer verifies under the registry fallback.
    expect((await registerAs(v, "made-up-device", xKp)).status).toBe(401);
    expect((await registerAs(v, "v-dev", vKp, { public_key: hex(vKp) })).status).toBe(200);
    expect(await served(v)).toEqual({ discover: hex(vKp), helper: hex(vKp) });
  });

  it("a recorded 'proven' squat key (or one reached from it by a recorded link) is never served for a sovereign id", async () => {
    const { xKp, v } = await victimAndSquatter();
    plantRegistry(v, hex(xKp));
    recordRegistryKeyEvidence(db(), {
      motebitId: v,
      publicKey: hex(xKp),
      evidence: "bearer",
      now: Date.now(),
    });
    expect(await served(v)).toEqual({ discover: "", helper: "" });

    // X rotates its squat K_X → K_X2 (a link the relay recorded pre-#875).
    const x2 = await generateKeypair();
    const link = await signKeySuccession(
      xKp.privateKey,
      x2.privateKey,
      x2.publicKey,
      xKp.publicKey,
    );
    plant(
      `INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0, NULL)`,
      v,
      link.old_public_key,
      link.new_public_key,
      link.timestamp,
      link.old_key_signature ?? null,
      link.new_key_signature,
    );
    plant("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?", hex(x2), v);
    recordRegistryKeyEvidence(db(), {
      motebitId: v,
      publicKey: hex(x2),
      evidence: "succession",
      now: Date.now(),
    });
    expect(await served(v)).toEqual({ discover: "", helper: "" });
  });

  it("a legitimate sovereign identity is unaffected: genesis served, a recorded rotation from the genesis served", async () => {
    const vKp = await generateKeypair();
    const v = await deriveSovereignMotebitId(hex(vKp));
    expect((await bootstrap(v, "v-dev", vKp)).status).toBe(201);
    expect((await registerAs(v, "v-dev", vKp, { public_key: hex(vKp) })).status).toBe(200);
    expect(await served(v)).toEqual({ discover: hex(vKp), helper: hex(vKp) });
    // Re-bootstrap by the owner on a second machine with the same key.
    expect((await bootstrap(v, "v-dev-2", vKp)).status).toBe(200);
    expect(deviceKeys(v).sort()).toEqual([hex(vKp), hex(vKp)]);
  });
});

describe("F2 — an exact replay of an accepted proof-of-possession body is idempotent-only", () => {
  it("bootstrap: the same signed body twice answers success and writes nothing the second time", async () => {
    const kp = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(kp));
    const first = await bootstrap(mid, "dev-1", kp);
    expect(first.status).toBe(201);
    const snapshot = () => db().prepare("SELECT * FROM devices WHERE motebit_id = ?").all(mid);
    const before = snapshot();
    const replay = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_HEADERS,
      body: first.body,
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { registered: boolean }).registered).toBe(false);
    expect(snapshot()).toEqual(before);
    const seen = db()
      .prepare("SELECT COUNT(*) AS n FROM relay_key_proofs_accepted WHERE motebit_id = ?")
      .get(mid) as { n: number };
    expect(seen.n).toBe(1);
  });

  it("a register-self body replayed at bootstrap is the same proof: answered, nothing written", async () => {
    const kp = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(kp));
    const body = await signedBootstrapBody(
      { motebit_id: mid, device_id: "dev-1", public_key: hex(kp) },
      kp.privateKey,
    );
    const first = await relay.app.request("/api/v1/devices/register-self", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(first.status).toBe(201);
    const before = db().prepare("SELECT * FROM devices WHERE motebit_id = ?").all(mid);
    const replay = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(replay.status).toBe(200);
    expect(db().prepare("SELECT * FROM devices WHERE motebit_id = ?").all(mid)).toEqual(before);
  });

  it("/agents/register: a replayed key_proof re-asserts the key it wrote, and never writes one the registry no longer holds", async () => {
    const aKp = await generateKeypair();
    const bKp = await generateKeypair();
    const mid = `legacy-${crypto.randomUUID()}`;
    expect((await bootstrap(mid, "a-dev", aKp)).status).toBe(201);
    const proof = await keyProof({ motebit_id: mid, public_key: hex(bKp) }, bKp.privateKey);
    const reg = () => registerAs(mid, "a-dev", aKp, { public_key: hex(bKp), key_proof: proof });
    expect((await reg()).status).toBe(200);
    expect(registryRow(mid)?.public_key).toBe(hex(bKp));
    // Same proof again while the registry still holds K_B: a repeat.
    expect((await reg()).status).toBe(200);
    // The registry no longer holds K_B: the replayed proof is not fresh evidence.
    plant("UPDATE agent_registry SET public_key = '' WHERE motebit_id = ?", mid);
    const replay = await reg();
    expect(replay.status).toBe(409);
    expect(replay.json.code).toBe("KEY_PROOF_REPLAYED");
    expect(registryRow(mid)?.public_key).toBe("");
  });
});
