/**
 * P0 containment: POST /api/v1/agents/accept-migration refuses every arrival.
 *
 * On main the route permits identity takeover: (1) a retired genesis key is
 * re-accepted after a rotation this relay recorded; (2) a FORGED guardian —
 * named inside the presented identity file — signs a "recovery" genesis → X
 * that `verifyMigratingKeyBinding` accepts, so anyone can take over an
 * identity holding no secret of it; and an arrival lifts the identity's
 * revocation. It is reachable with an ORDINARY device token (register-self
 * is free) and a source relay the attacker runs (the TOFU tier fetches
 * self-signed metadata from any URL the token names — also a blind SSRF).
 *
 * Containment (not the fix): the handler's first statement refuses with 503,
 * before body parsing, any DB read or write, and any outbound fetch. Every
 * test here snapshots the five tables an arrival writes and asserts they are
 * byte-for-byte unchanged, and that `fetch` was never called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import {
  canonicalJson,
  deriveSovereignMotebitId,
  ed25519Sign,
  mintAudienceToken,
  signBySuite,
  signCredentialBundle,
  signDeviceRegistration,
  signGuardianRecoverySuccession,
  toBase64Url,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { recordIdentityRevocation } from "../identity-revocation.js";
import { recordIdentityKey } from "../identity-keys.js";

const HEX_SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const B64_SUITE = "motebit-jcs-ed25519-b64-v1" as const;
const DAY = 24 * 60 * 60 * 1000;
const PINNED_SOURCE = "pinned-source";
const PINNED_SOURCE_URL = "http://127.0.0.1:1";

interface Link {
  old_public_key: string;
  new_public_key: string;
  timestamp: number;
  suite: typeof HEX_SUITE;
  old_key_signature: string;
  new_key_signature: string;
}

interface SourceRelay {
  id: string;
  url: string;
  kp: KeyPair;
}

const hex = (kp: KeyPair): string => bytesToHex(kp.publicKey);

async function link(oldKp: KeyPair, newKp: KeyPair, timestamp: number): Promise<Link> {
  const msg = new TextEncoder().encode(
    canonicalJson({
      old_public_key: hex(oldKp),
      new_public_key: hex(newKp),
      timestamp,
      suite: HEX_SUITE,
    }),
  );
  return {
    old_public_key: hex(oldKp),
    new_public_key: hex(newKp),
    timestamp,
    suite: HEX_SUITE,
    old_key_signature: bytesToHex(await signBySuite(HEX_SUITE, msg, oldKp.privateKey)),
    new_key_signature: bytesToHex(await signBySuite(HEX_SUITE, msg, newKp.privateKey)),
  };
}

function identityFile(
  motebitId: string,
  current: string,
  succession: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date(Date.now() - 30 * DAY).toISOString(),
    owner_id: "owner",
    identity: { algorithm: "Ed25519", public_key: current },
    succession,
    ...extra,
  };
}

let tokenSeq = 0;

/** A MigrationPresentation the source relay signs; the agent's key signs the bundle. */
async function presentation(
  source: SourceRelay,
  motebitId: string,
  agent: KeyPair,
  identity_file?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const n = ++tokenSeq;
  const sign = async (b: Record<string, unknown>): Promise<string> =>
    toBase64Url(
      await ed25519Sign(new TextEncoder().encode(canonicalJson(b)), source.kp.privateKey),
    );
  const token = {
    token_id: `tok-${n}-${now}`,
    motebit_id: motebitId,
    source_relay_id: source.id,
    source_relay_url: source.url,
    issued_at: now,
    expires_at: now + DAY,
    suite: B64_SUITE,
  };
  const attestation = {
    attestation_id: `att-${n}-${now}`,
    motebit_id: motebitId,
    source_relay_id: source.id,
    source_relay_url: source.url,
    first_seen: now - DAY,
    last_active: now,
    trust_level: "verified",
    successful_tasks: 0,
    failed_tasks: 0,
    credentials_issued: 0,
    balance_at_departure: 0,
    attested_at: now,
    suite: B64_SUITE,
  };
  const bundle = await signCredentialBundle(
    {
      motebit_id: motebitId,
      exported_at: now,
      credentials: [],
      anchor_proofs: [],
      key_succession: [],
      suite: B64_SUITE,
    },
    agent.privateKey,
  );
  return {
    migration_token: { ...token, signature: await sign(token) },
    departure_attestation: { ...attestation, signature: await sign(attestation) },
    credential_bundle: bundle,
    motebit_id: motebitId,
    public_key: hex(agent),
    ...(identity_file ? { identity_file } : {}),
  };
}

let relay: SyncRelay;
let genesis: KeyPair, k1: KeyPair;
let sid: string;
let gToK1: Link;
/** Every outbound dial the relay attempts; the stub serves an attacker's metadata. */
let fetchSpy: ReturnType<typeof vi.fn>;
let tofuMetadata: { url: string; body: unknown } | null;

beforeEach(async () => {
  relay = await createTestRelay();
  genesis = await generateKeypair();
  k1 = await generateKeypair();
  sid = await deriveSovereignMotebitId(hex(genesis));
  gToK1 = await link(genesis, k1, Date.now() - 20 * DAY);
  tofuMetadata = null;
  fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (tofuMetadata && u === `${tofuMetadata.url}/.well-known/motebit.json`) {
      return new Response(JSON.stringify(tofuMetadata.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await relay.close();
});

async function pinnedSource(): Promise<SourceRelay> {
  const kp = await generateKeypair();
  relay.moteDb.db
    .prepare(
      `INSERT OR REPLACE INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, ?, ?, 'active', ?, 0, 0, 0.5, ?)`,
    )
    .run(PINNED_SOURCE, hex(kp), PINNED_SOURCE_URL, "Source", null, "1.0");
  return { id: PINNED_SOURCE, url: PINNED_SOURCE_URL, kp };
}

/** A source relay the ATTACKER runs: self-signed metadata at a URL of its choosing (TOFU). */
async function attackerRunSource(): Promise<SourceRelay> {
  const kp = await generateKeypair();
  const id = `attacker-relay-${++tokenSeq}`;
  const url = "http://127.0.0.1:3";
  const body = {
    protocol_version: "1.0",
    relay_id: id,
    public_key: hex(kp),
    endpoint_url: url,
    suite: HEX_SUITE,
  };
  const signature = bytesToHex(
    await signBySuite(HEX_SUITE, new TextEncoder().encode(canonicalJson(body)), kp.privateKey),
  );
  tofuMetadata = { url, body: { ...body, signature } };
  return { id, url, kp };
}

/** An ORDINARY credential: a device token for an identity the attacker registered itself. */
async function ordinaryAttackerToken(): Promise<Record<string, string>> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  const reg = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: "attacker-device",
      public_key: hex(kp),
      device_name: "attacker",
      timestamp: Date.now(),
    },
    kp.privateKey,
  );
  const res = await relay.app.request("/api/v1/devices/register-self", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reg),
  });
  expect(res.status).toBe(201);
  const { token } = await mintAudienceToken(
    { mid, did: "attacker-device", aud: "admin:query" },
    kp.privateKey,
  );
  return { Authorization: `Bearer ${token}` };
}

/** The identity as this relay holds it — seeded directly, never through the route. */
function establish(key: KeyPair): void {
  const now = Date.now();
  relay.moteDb.db
    .prepare(
      "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at) VALUES (?, ?, '', '[]', ?, ?, ?)",
    )
    .run(sid, hex(key), now, now, now + 365 * DAY);
  recordIdentityKey(relay.moteDb.db, {
    motebitId: sid,
    publicKey: hex(key),
    source: "succession",
    now,
  });
}

/** The relay's own record of a rotation (what `/rotate-key` writes). */
function recordSuccession(l: Link): void {
  relay.moteDb.db
    .prepare(
      "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, old_key_signature, new_key_signature) VALUES (?,?,?,?,?,?)",
    )
    .run(
      sid,
      l.old_public_key,
      l.new_public_key,
      l.timestamp,
      l.old_key_signature,
      l.new_key_signature,
    );
}

/** Every row of every table an arrival writes (whole tables, not one identity). */
function snapshot(): string {
  const db = relay.moteDb.db;
  return JSON.stringify(
    [
      "identity_keys",
      "agent_registry",
      "relay_key_successions",
      "relay_identity_revocations",
      "relay_accepted_migrations",
    ].map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
  );
}

async function post(
  body: string | undefined,
  auth: Record<string, string> = AUTH_HEADER,
): Promise<Response> {
  return relay.app.request("/api/v1/agents/accept-migration", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    ...(body === undefined ? {} : { body }),
  });
}

/** The containment: 503, nothing written, nothing dialled. */
async function refusedUntouched(
  body: string | undefined,
  auth: Record<string, string> = AUTH_HEADER,
): Promise<void> {
  const before = snapshot();
  const res = await post(body, auth);
  const text = await res.text();
  expect.soft({ status: res.status, text }).toEqual({
    status: 503,
    text: expect.stringContaining("Migration arrivals are temporarily disabled") as unknown,
  });
  expect.soft(snapshot()).toBe(before);
  expect.soft(fetchSpy).not.toHaveBeenCalled();
}

describe("accept-migration is disabled (P0 containment)", () => {
  it("(a) forged-guardian takeover with an ORDINARY device token + attacker-run source → 503, state unchanged, no fetch", async () => {
    establish(genesis);
    const auth = await ordinaryAttackerToken();
    const tofu = await attackerRunSource();
    // The attacker holds NO key of the identity: it names its own guardian in
    // the file and signs a "recovery" genesis → attacker with it.
    const fakeGuardian = await generateKeypair();
    const attacker = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      fakeGuardian.privateKey,
      attacker.privateKey,
      genesis.publicKey,
      attacker.publicKey,
    );
    const file = identityFile(sid, hex(attacker), [rec], {
      guardian: { public_key: hex(fakeGuardian) },
    });
    await refusedUntouched(JSON.stringify(await presentation(tofu, sid, attacker, file)), auth);
  });

  it("(a') the same forged guardian on a relay that never saw the identity → 503, nothing planted", async () => {
    const auth = await ordinaryAttackerToken();
    const tofu = await attackerRunSource();
    const fakeGuardian = await generateKeypair();
    const attacker = await generateKeypair();
    const rec = await signGuardianRecoverySuccession(
      fakeGuardian.privateKey,
      attacker.privateKey,
      genesis.publicKey,
      attacker.publicKey,
    );
    const file = identityFile(sid, hex(attacker), [rec], {
      guardian: { public_key: hex(fakeGuardian) },
    });
    await refusedUntouched(JSON.stringify(await presentation(tofu, sid, attacker, file)), auth);
  });

  it("(b) retired GENESIS key after a rotation this relay recorded → 503, holder/registry stay at K1", async () => {
    establish(k1);
    recordSuccession(gToK1);
    const source = await pinnedSource();
    await refusedUntouched(JSON.stringify(await presentation(source, sid, genesis)));
  });

  it("(c) an arrival never lifts a revocation → 503, the revocation stands", async () => {
    establish(k1);
    recordSuccession(gToK1);
    recordIdentityRevocation(relay.moteDb.db, sid, Date.now(), hex(k1));
    const source = await pinnedSource();
    await refusedUntouched(JSON.stringify(await presentation(source, sid, genesis)));
  });

  it("a legitimate never-rotated first arrival is refused too (arrivals are off, not filtered)", async () => {
    const source = await pinnedSource();
    await refusedUntouched(JSON.stringify(await presentation(source, sid, genesis)));
  });

  it("refuses before body parsing: no body, malformed JSON, and an internal source_relay_url all → 503 with no dial", async () => {
    await refusedUntouched(undefined);
    await refusedUntouched("{not json");
    const tofu = await attackerRunSource();
    const body = await presentation(
      { ...tofu, url: "http://169.254.169.254/latest/meta-data" },
      sid,
      genesis,
    );
    await refusedUntouched(JSON.stringify(body));
  });
});

/**
 * The gate is the handler's first statement, so it runs AFTER the middleware
 * the route mounts. What runs first, and what it may write, is measured here
 * over EVERY table in the database (not only the identity tables): the only
 * write any credential causes before the 503 is the agent-route door's one
 * `relay_auth_events` row — for a master-token presentation or a refused
 * token. An ordinary device token that verifies writes nothing at all.
 */
describe("what runs before the gate (the agent-route door), measured over every table", () => {
  /** Every row of every table, keyed by table, with `relay_auth_events` separated out. */
  function wholeDb(): { authEvents: unknown[]; rest: string } {
    const db = relay.moteDb.db;
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    const dump: Record<string, unknown> = {};
    for (const t of tables) {
      if (t === "relay_auth_events") continue;
      // The auth-event table's AUTOINCREMENT counter moves with its row.
      dump[t] =
        t === "sqlite_sequence"
          ? db.prepare("SELECT * FROM sqlite_sequence WHERE name != 'relay_auth_events'").all()
          : db.prepare(`SELECT * FROM "${t}"`).all();
    }
    return {
      authEvents: db
        .prepare("SELECT kind, method, path, reason FROM relay_auth_events ORDER BY id")
        .all(),
      rest: JSON.stringify(dump),
    };
  }

  async function body(): Promise<string> {
    return JSON.stringify(await presentation(await pinnedSource(), sid, genesis));
  }

  it("no credential → 401 at the door (the gate is never reached); one auth-event row, nothing else", async () => {
    const payload = await body();
    const before = wholeDb();
    const res = await post(payload, {});
    expect(res.status).toBe(401);
    const after = wholeDb();
    expect(after.rest).toBe(before.rest);
    expect(after.authEvents.slice(before.authEvents.length)).toEqual([
      {
        kind: "agent_token_rejected",
        method: "POST",
        path: "/api/v1/agents/accept-migration",
        reason: "missing_token",
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a token that does not verify → 401 at the door; one auth-event row, nothing else", async () => {
    const payload = await body();
    const stranger = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(stranger));
    const { token } = await mintAudienceToken(
      { mid, did: "no-such-device", aud: "admin:query" },
      stranger.privateKey,
    );
    const before = wholeDb();
    const res = await post(payload, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const after = wholeDb();
    expect(after.rest).toBe(before.rest);
    expect(after.authEvents.length).toBe(before.authEvents.length + 1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the master token → 503; the door records the presentation (one auth-event row), nothing else", async () => {
    const payload = await body();
    const before = wholeDb();
    const res = await post(payload, AUTH_HEADER);
    expect(res.status).toBe(503);
    const after = wholeDb();
    expect(after.rest).toBe(before.rest);
    expect(after.authEvents.slice(before.authEvents.length)).toEqual([
      {
        kind: "master_token",
        method: "POST",
        path: "/api/v1/agents/accept-migration",
        reason: null,
      },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an ordinary device token that verifies → 503; no row written in ANY table", async () => {
    const auth = await ordinaryAttackerToken();
    const payload = await body();
    const before = wholeDb();
    const res = await post(payload, auth);
    expect(res.status).toBe(503);
    const after = wholeDb();
    expect(after.rest).toBe(before.rest);
    expect(after.authEvents).toEqual(before.authEvents);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
