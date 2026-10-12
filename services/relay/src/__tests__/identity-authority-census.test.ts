/**
 * Identity-authority census — the §6 operator queries Q1–Q6 of
 * docs/design/identity-authority-writers.md, served read-only on the
 * master-token `GET /api/v1/admin/identity-authority/census`.
 *
 * Each query is seeded with one row that must be found and one that must not,
 * through raw SQL (the shapes production may already hold, whatever door wrote
 * them). The endpoint must answer counts and ids only — no key material beyond
 * an 8-hex prefix, no token, no secret — and must write nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytesToHex, generateKeypair, hexPublicKeyToDidKey } from "@motebit/encryption";
import { deriveSovereignMotebitId } from "@motebit/crypto";
import type { DatabaseDriver } from "@motebit/persistence";

import type { SyncRelay } from "../index.js";
import { initRelayIdentity, type RelayIdentity } from "../federation.js";
import {
  deviceKeyStanding,
  measureIdentityAuthority,
  readOnlyHandle,
} from "../identity-authority-census.js";
import { AUTH_HEADER, createTestRelay, walletOf } from "./test-helpers.js";
import { recordGuardianEvidence } from "../identity-keys.js";

const CENSUS = "/api/v1/admin/identity-authority/census";

type Bucket = "definitely_invalid" | "suspicious" | "legitimate_legacy";
type Buckets = Record<Bucket, number>;
type ByBucket = Record<Bucket, string[]>;

interface Census {
  measured_at: number;
  limit: number;
  q1_planted_device_rows: {
    count: number;
    buckets: Buckets;
    rows: Array<{
      bucket: Bucket;
      paired: boolean;
      motebit_id: string;
      device_id: string;
      registered_at: number;
      current_key_basis: string;
      matches_holder: boolean;
      id_commits_to_device_key: boolean;
    }>;
  };
  q2_sovereign_squats: { count: number; ids: string[]; buckets: Buckets; by_bucket: ByBucket };
  q3_unbound_money_destinations: {
    settlement_address: {
      count: number;
      buckets: Buckets;
      rows: Array<{ motebit_id: string; reason: string; bucket: Bucket }>;
    };
    pay_to_address: {
      count: number;
      buckets: Buckets;
      rows: Array<{ motebit_id: string; reason: string; bucket: Bucket }>;
    };
    withdrawal_destination: {
      count: number;
      buckets: Buckets;
      rows: Array<{ motebit_id: string; reason: string; source: string; bucket: Bucket }>;
    };
  };
  q4_unproven_guardians: {
    identity_keys: { count: number; ids: string[]; buckets: Buckets; by_bucket: ByBucket };
    agent_registry: { count: number; ids: string[]; buckets: Buckets; by_bucket: ByBucket };
  };
  q5_keyless_with_device_rows: {
    count: number;
    ids: string[];
    buckets: Buckets;
    by_bucket: ByBucket;
  };
  q6_v1_peers: {
    count: number;
    by_state: Record<string, number>;
    ids: string[];
    buckets: Buckets;
    by_bucket: ByBucket;
  };
}

const ZERO: Buckets = { definitely_invalid: 0, suspicious: 0, legitimate_legacy: 0 };

async function key(): Promise<string> {
  return bytesToHex((await generateKeypair()).publicKey);
}

let deviceSeq = 0;
function device(db: DatabaseDriver, motebitId: string, publicKey: string): string {
  const deviceId = `dev-${++deviceSeq}-${crypto.randomUUID()}`;
  db.prepare(
    "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
  ).run(deviceId, motebitId, `tok-${deviceId}`, publicKey, 1_000 + deviceSeq);
  return deviceId;
}

function registry(
  db: DatabaseDriver,
  motebitId: string,
  publicKey: string,
  extra: { settlement_address?: string; guardian_public_key?: string } = {},
): void {
  db.prepare(
    `INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at, settlement_address, guardian_public_key)
     VALUES (?, ?, 'http://127.0.0.1:1/mcp', '[]', 1, 1, 1, ?, ?)`,
  ).run(motebitId, publicKey, extra.settlement_address ?? null, extra.guardian_public_key ?? null);
}

function holder(
  db: DatabaseDriver,
  motebitId: string,
  publicKey: string,
  source: string,
  guardian: string | null = null,
): void {
  db.prepare(
    "INSERT INTO identity_keys (motebit_id, public_key, guardian_public_key, source, first_seen, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
  ).run(motebitId, publicKey, guardian, source);
}

function succession(db: DatabaseDriver, motebitId: string, oldKey: string, newKey: string): void {
  db.prepare(
    "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, new_key_signature) VALUES (?, ?, ?, ?, 'sig')",
  ).run(motebitId, oldKey, newKey, Date.now());
}

/** A pairing session that approved `deviceId` for `motebitId`, claiming `claimingKey`. */
function pairing(
  db: DatabaseDriver,
  motebitId: string,
  deviceId: string,
  claimingKey: string,
  transferredKey: string | null = null,
): void {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO pairing_sessions (pairing_id, motebit_id, initiator_device_id, pairing_code, status, claiming_public_key, approved_device_id, key_transfer_payload, created_at, expires_at)
     VALUES (?, ?, 'initiator', ?, 'approved', ?, ?, ?, 1, 2)`,
  ).run(
    id,
    motebitId,
    `code-${id}`,
    claimingKey,
    deviceId,
    transferredKey === null ? null : JSON.stringify({ identity_pubkey_check: transferredKey }),
  );
}

function changes(db: DatabaseDriver): number {
  return (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

async function census(relay: SyncRelay, query = ""): Promise<Census> {
  const res = await relay.app.request(`${CENSUS}${query}`, { headers: AUTH_HEADER });
  expect(res.status).toBe(200);
  return (await res.json()) as Census;
}

describe("identity-authority census (§6 Q1–Q6)", () => {
  let relay: SyncRelay;
  let db: DatabaseDriver;

  beforeEach(async () => {
    relay = await createTestRelay();
    db = relay.moteDb.db;
  });
  afterEach(async () => {
    await relay.close();
  });

  it("is master-token only", async () => {
    expect((await relay.app.request(CENSUS)).status).toBe(401);
    expect(
      (await relay.app.request(CENSUS, { headers: { Authorization: "Bearer not-the-token" } }))
        .status,
    ).toBe(401);
  });

  it("answers zeros on an empty relay", async () => {
    const c = await census(relay);
    expect(c.q1_planted_device_rows.count).toBe(0);
    expect(c.q2_sovereign_squats.count).toBe(0);
    expect(c.q3_unbound_money_destinations.settlement_address.count).toBe(0);
    expect(c.q4_unproven_guardians.identity_keys.count).toBe(0);
    expect(c.q5_keyless_with_device_rows.count).toBe(0);
    expect(c.q6_v1_peers.count).toBe(0);
  });

  it("Q1: a device row whose key is not the sovereign lineage head is planted; the owner's is not", async () => {
    const k0 = await key();
    const k1 = await key();
    const stranger = await key();
    const id = await deriveSovereignMotebitId(k0);
    holder(db, id, k1, "succession");
    succession(db, id, k0, k1);
    const owners = device(db, id, k1);
    const planted = device(db, id, stranger);

    const c = await census(relay);
    const rows = c.q1_planted_device_rows.rows.filter((r) => r.motebit_id === id);
    expect(rows.map((r) => r.device_id)).toEqual([planted]);
    expect(rows[0]!.current_key_basis).toBe("sovereign_lineage");
    expect(rows[0]!.id_commits_to_device_key).toBe(false);
    expect(rows[0]!.matches_holder).toBe(false);
    expect(c.q1_planted_device_rows.rows.some((r) => r.device_id === owners)).toBe(false);
  });

  it("Q1: a legacy id is checked against an evidence-backed holder only", async () => {
    const owner = await key();
    const stranger = await key();
    const evidenced = crypto.randomUUID();
    holder(db, evidenced, owner, "migration");
    device(db, evidenced, owner);
    const plantedOnEvidenced = device(db, evidenced, stranger);
    // A backfilled registry key is not evidence (D2): no current key, so every
    // keyed device row is unproven and listed.
    const unevidenced = crypto.randomUUID();
    holder(db, unevidenced, owner, "backfill:registry");
    const unprovenRow = device(db, unevidenced, owner);

    const c = await census(relay);
    const byDevice = new Map(c.q1_planted_device_rows.rows.map((r) => [r.device_id, r]));
    expect(byDevice.get(plantedOnEvidenced)?.current_key_basis).toBe("holder_evidence");
    expect(byDevice.get(unprovenRow)?.current_key_basis).toBe("none");
    expect(byDevice.get(unprovenRow)?.matches_holder).toBe(true);
    expect(c.q1_planted_device_rows.count).toBe(2);
  });

  it("Q2: a sovereign id whose held keys are off the genesis lineage is a squat", async () => {
    const k0 = await key();
    const squatter = await key();
    const squatted = await deriveSovereignMotebitId(k0);
    registry(db, squatted, squatter);
    holder(db, squatted, squatter, "register");

    // The owner's own registration: the held key IS the genesis key.
    const k0b = await key();
    const owned = await deriveSovereignMotebitId(k0b);
    registry(db, owned, k0b);
    holder(db, owned, k0b, "register-self");

    const c = await census(relay);
    expect(c.q2_sovereign_squats.ids).toEqual([squatted]);
    expect(c.q2_sovereign_squats.count).toBe(1);
  });

  it("Q3: money destinations not derived from the current key are listed with the reason", async () => {
    const k0 = await key();
    const id = await deriveSovereignMotebitId(k0);
    holder(db, id, k0, "register-self");
    registry(db, id, k0, { settlement_address: walletOf(await key()) });
    db.prepare(
      "INSERT INTO relay_service_listings (listing_id, motebit_id, pay_to_address) VALUES (?, ?, ?)",
    ).run("l-1", id, walletOf(k0));

    const legacy = crypto.randomUUID();
    registry(db, legacy, await key(), { settlement_address: "SomeAddr" });
    db.prepare(
      "INSERT INTO relay_withdrawals (withdrawal_id, motebit_id, amount, destination, requested_at) VALUES (?, ?, ?, ?, ?)",
    ).run("w-1", legacy, 5, "AttackerAddr", Date.now());
    db.prepare(
      "INSERT INTO relay_withdrawals (withdrawal_id, motebit_id, amount, destination, requested_at) VALUES (?, ?, ?, ?, ?)",
    ).run("w-old", legacy, 5, "OldAddr", Date.now() - 200 * 24 * 3600_000);

    const c = await census(relay);
    const q3 = c.q3_unbound_money_destinations;
    expect(q3.settlement_address.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ motebit_id: id, reason: "not_derived_from_current_key" }),
        expect.objectContaining({ motebit_id: legacy, reason: "no_current_key" }),
      ]),
    );
    expect(q3.settlement_address.count).toBe(2);
    // The listing pays the current key's derived address: bound, not listed.
    expect(q3.pay_to_address.count).toBe(0);
    // Only the last 90 days of withdrawals.
    expect(q3.withdrawal_destination.rows.map((r) => r.source)).toEqual(["relay_withdrawals"]);
    expect(q3.withdrawal_destination.count).toBe(1);
  });

  it("Q4: every non-NULL guardian is listed as unproven", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    holder(db, a, await key(), "register", await key());
    holder(db, b, await key(), "register");
    registry(db, b, await key(), { guardian_public_key: await key() });

    const c = await census(relay);
    expect(c.q4_unproven_guardians.identity_keys.ids).toEqual([a]);
    expect(c.q4_unproven_guardians.agent_registry.ids).toEqual([b]);
  });

  it("Q4: a guardian is proven only by the identity's latest evidence row naming exactly it — the /rotate-key rule", async () => {
    const proven = crypto.randomUUID();
    const replaced = crypto.randomUUID();
    const g = await key();
    const kp = await key();
    holder(db, proven, kp, "register", g);
    registry(db, proven, kp, { guardian_public_key: g });
    recordGuardianEvidence(db, {
      motebitId: proven,
      guardianPublicKey: g,
      setUnderKey: kp,
      evidence: "holder",
      now: 1,
    });
    // Its guardian was later re-set by an unproven write: g1 is on file, but
    // the latest evidence names g2.
    const g1 = await key();
    const g2 = await key();
    const kr = await key();
    holder(db, replaced, kr, "register", g1);
    for (const gk of [g1, g2]) {
      recordGuardianEvidence(db, {
        motebitId: replaced,
        guardianPublicKey: gk,
        setUnderKey: kr,
        evidence: "holder",
        now: 1,
      });
    }

    const c = await census(relay);
    expect(c.q4_unproven_guardians.identity_keys.ids).toEqual([replaced]);
    expect(c.q4_unproven_guardians.agent_registry.ids).toEqual([]);
  });

  it("Q5: an id with no holder, no registry key and a keyed device row is a first-come candidate", async () => {
    const keyless = crypto.randomUUID();
    device(db, keyless, await key());
    registry(db, keyless, "");
    const held = crypto.randomUUID();
    holder(db, held, await key(), "operator");
    device(db, held, await key());

    const c = await census(relay);
    expect(c.q5_keyless_with_device_rows.ids).toEqual([keyless]);
  });

  it("Q6: peers recorded under a pre-v2 federation protocol are listed by state", async () => {
    const insert = db.prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, state, peered_at, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, 'https://peer.example', ?, ?, 0, 0, 0.5, ?)`,
    );
    insert.run("peer-old", await key(), "active", 1, "motebit/relay-federation@1.4");
    insert.run("peer-unknown", await key(), "suspended", 1, null);
    insert.run("peer-new", await key(), "active", 1, "motebit/relay-federation@1.5");

    const c = await census(relay);
    expect([...c.q6_v1_peers.ids].sort()).toEqual(["peer-old", "peer-unknown"]);
    expect(c.q6_v1_peers.by_state).toEqual({ active: 1, suspended: 1 });
  });

  it("writes nothing and serves no key material beyond an 8-hex prefix", async () => {
    const k0 = await key();
    const stranger = await key();
    const id = await deriveSovereignMotebitId(k0);
    registry(db, id, stranger, { settlement_address: walletOf(stranger) });
    holder(db, id, stranger, "register", await key());
    device(db, id, stranger);

    // The measure itself writes nothing (the route's master-token middleware
    // records the presentation in relay_auth_events — rule 6 — which is the
    // auth layer's write, not the census's).
    const before = changes(db);
    await measureIdentityAuthority(db);
    expect(changes(db)).toBe(before);
    const res = await relay.app.request(CENSUS, { headers: AUTH_HEADER });
    const text = await res.text();
    expect(text).not.toContain(stranger);
    expect(text).not.toContain(stranger.slice(0, 9));
    expect(text).not.toMatch(/tok-dev-/);
    expect(text).not.toMatch(/[0-9a-f]{40,}/i);
  });

  // ── Read-only at the database (item 1) ──

  it("read-only: a write through the census handle is refused by the database itself", async () => {
    const ro = readOnlyHandle(db);
    const id = crypto.randomUUID();
    let err: unknown;
    try {
      ro.prepare(
        "INSERT INTO identity_keys (motebit_id, public_key, source, first_seen, updated_at) VALUES (?, ?, 'register', 1, 1)",
      ).run(id, await key());
    } catch (e) {
      err = e;
    }
    // better-sqlite3's own refusal: PRAGMA query_only makes SQLite answer
    // SQLITE_READONLY ("attempt to write a readonly database").
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("SQLITE_READONLY");
    expect((err as Error).message).toMatch(/readonly database/);
    expect(db.prepare("SELECT 1 FROM identity_keys WHERE motebit_id = ?").get(id)).toBeUndefined();
    // Scoped to the census's statements: the relay's own connection still writes.
    holder(db, id, await key(), "register");
    expect(db.prepare("SELECT 1 FROM identity_keys WHERE motebit_id = ?").get(id)).toBeDefined();
    // No door around it: exec and pragma are refused on the handle outright.
    expect(() => ro.exec("PRAGMA query_only = OFF")).toThrow();
    expect(() => ro.pragma("query_only = OFF")).toThrow();
  });

  it("read-only: every statement the census runs executes with query_only ON", async () => {
    const k0 = await key();
    const id = await deriveSovereignMotebitId(k0);
    holder(db, id, await key(), "register", await key());
    registry(db, id, await key(), { settlement_address: "Addr" });
    device(db, id, await key());
    const seen: number[] = [];
    const probe = (): void => {
      seen.push((db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only);
    };
    const watched: DatabaseDriver = {
      driverName: db.driverName,
      exec: (sql) => db.exec(sql),
      pragma: (sql) => db.pragma(sql),
      close: () => db.close(),
      transaction: (fn) => db.transaction(fn),
      prepare: (sql) => {
        const st = db.prepare(sql);
        return {
          run: (...a: unknown[]) => (probe(), st.run(...a)),
          get: (...a: unknown[]) => (probe(), st.get(...a)),
          all: (...a: unknown[]) => (probe(), st.all(...a)),
        };
      },
    };
    await measureIdentityAuthority(watched);
    expect(seen.length).toBeGreaterThan(10);
    expect(new Set(seen)).toEqual(new Set([1]));
    expect((db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only).toBe(0);
  });

  // ── Three buckets (item 2) ──

  it("buckets: every query answers per-bucket counts that sum to its count", async () => {
    const c = await census(relay);
    for (const b of [
      c.q1_planted_device_rows.buckets,
      c.q2_sovereign_squats.buckets,
      c.q3_unbound_money_destinations.settlement_address.buckets,
      c.q3_unbound_money_destinations.pay_to_address.buckets,
      c.q3_unbound_money_destinations.withdrawal_destination.buckets,
      c.q4_unproven_guardians.identity_keys.buckets,
      c.q4_unproven_guardians.agent_registry.buckets,
      c.q5_keyless_with_device_rows.buckets,
      c.q6_v1_peers.buckets,
    ])
      expect(b).toEqual(ZERO);
  });

  it("buckets Q1: a stranger's key on a sovereign id is definitely_invalid; a no-current-key row is suspicious; a retired legacy key is legitimate_legacy", async () => {
    const k0 = await key();
    const sov = await deriveSovereignMotebitId(k0);
    holder(db, sov, k0, "register-self");
    const invalid = device(db, sov, await key());

    const keyless = crypto.randomUUID();
    holder(db, keyless, await key(), "register");
    const unknown = device(db, keyless, await key());

    const old = await key();
    const cur = await key();
    const legacy = crypto.randomUUID();
    holder(db, legacy, cur, "succession");
    succession(db, legacy, old, cur);
    const retired = device(db, legacy, old);

    const c = await census(relay);
    const q1 = c.q1_planted_device_rows;
    const bucketOf = new Map(q1.rows.map((r) => [r.device_id, r.bucket]));
    expect(bucketOf.get(invalid)).toBe("definitely_invalid");
    expect(bucketOf.get(unknown)).toBe("suspicious");
    expect(bucketOf.get(retired)).toBe("legitimate_legacy");
    expect(q1.buckets).toEqual({ definitely_invalid: 1, suspicious: 1, legitimate_legacy: 1 });
    expect(q1.count).toBe(3);
  });

  it("buckets Q2–Q6: each flagged id carries exactly one bucket", async () => {
    // Q2: K0 is held here (the owner's device) and the registry/holder were
    // written by unproven doors — definitely_invalid. A v8 id with no
    // committing key held anywhere — suspicious.
    const k0 = await key();
    const proven = await deriveSovereignMotebitId(k0);
    device(db, proven, k0);
    const sq = await key();
    registry(db, proven, sq);
    holder(db, proven, sq, "register");
    const shapeOnly = await deriveSovereignMotebitId(await key());
    registry(db, shapeOnly, await key());

    // Q3: derived from a planted key the relay holds — definitely_invalid;
    // an arbitrary address — suspicious; derived from a retired lineage key —
    // legitimate_legacy.
    const a0 = await key();
    const a1 = await key();
    const rotated = await deriveSovereignMotebitId(a0);
    holder(db, rotated, a1, "succession");
    succession(db, rotated, a0, a1);
    registry(db, rotated, a1, { settlement_address: walletOf(a0) });
    const s0 = await key();
    const sovB = await deriveSovereignMotebitId(s0);
    holder(db, sovB, s0, "register-self");
    registry(db, sovB, s0, { settlement_address: "ArbitraryAddr" });
    const planted = await key();
    device(db, proven, planted);
    db.prepare("UPDATE agent_registry SET settlement_address = ? WHERE motebit_id = ?").run(
      walletOf(planted),
      proven,
    );

    const c = await census(relay);
    expect(c.q2_sovereign_squats.by_bucket).toEqual({
      definitely_invalid: [proven],
      suspicious: [shapeOnly],
      legitimate_legacy: [],
    });
    const settle = new Map(
      c.q3_unbound_money_destinations.settlement_address.rows.map((r) => [r.motebit_id, r.bucket]),
    );
    expect(settle.get(proven)).toBe("definitely_invalid");
    expect(settle.get(sovB)).toBe("suspicious");
    expect(settle.get(rotated)).toBe("legitimate_legacy");
  });

  it("buckets Q4/Q5/Q6: guardians and keyless device ids are suspicious; a recorded pre-1.5 peer is legitimate_legacy", async () => {
    const g = crypto.randomUUID();
    holder(db, g, await key(), "register", await key());
    const keyless = crypto.randomUUID();
    device(db, keyless, await key());
    const insert = db.prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, state, peered_at, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, 'https://peer.example', 'active', 1, 0, 0, 0.5, ?)`,
    );
    insert.run("peer-old", await key(), "motebit/relay-federation@1.4");
    insert.run("peer-unknown", await key(), null);

    const c = await census(relay);
    expect(c.q4_unproven_guardians.identity_keys.by_bucket.suspicious).toEqual([g]);
    expect(c.q5_keyless_with_device_rows.by_bucket.suspicious).toEqual([keyless]);
    expect(c.q6_v1_peers.by_bucket).toEqual({
      definitely_invalid: [],
      suspicious: ["peer-unknown"],
      legitimate_legacy: ["peer-old"],
    });
  });

  // ── did:key sovereign ids (item 3) ──

  it("did:key: a did:key id is sovereign exactly as the relay's predicate says", async () => {
    const k0 = await key();
    const id = hexPublicKeyToDidKey(k0);
    const squatter = await key();
    registry(db, id, squatter);
    holder(db, id, squatter, "register");
    const owners = device(db, id, k0);

    const c = await census(relay);
    expect(c.q2_sovereign_squats.ids).toEqual([id]);
    expect(c.q1_planted_device_rows.rows.some((r) => r.device_id === owners)).toBe(false);
    expect(await deviceKeyStanding(db, id, k0)).toEqual({
      on_current_lineage: true,
      id_commits_to_device_key: true,
    });
    expect(await deviceKeyStanding(db, id, squatter)).toEqual({
      on_current_lineage: false,
      id_commits_to_device_key: false,
    });
  });

  // ── Paired devices (item 5) ──

  it("paired: a device approved through pairing is never definitely_invalid — legitimate_legacy on an approved key, suspicious on any other", async () => {
    const k0 = await key();
    const id = await deriveSovereignMotebitId(k0);
    holder(db, id, k0, "register-self");
    // The claiming device registers under its own key; pairing approved it.
    const claimKey = await key();
    const paired = device(db, id, claimKey);
    pairing(db, id, paired, claimKey);
    // Approved through pairing, but the row now holds a key pairing never
    // carried (neither the claiming key nor the transferred identity key).
    const drifted = device(db, id, await key());
    pairing(db, id, drifted, await key(), await key());
    // The control: the same shape with no pairing is definitely_invalid.
    const unpaired = device(db, id, await key());

    const c = await census(relay);
    const byDevice = new Map(c.q1_planted_device_rows.rows.map((r) => [r.device_id, r]));
    expect(byDevice.get(paired)?.bucket).toBe("legitimate_legacy");
    expect(byDevice.get(paired)?.paired).toBe(true);
    expect(byDevice.get(drifted)?.bucket).toBe("suspicious");
    expect(byDevice.get(drifted)?.paired).toBe(true);
    expect(byDevice.get(unpaired)?.bucket).toBe("definitely_invalid");
    expect(byDevice.get(unpaired)?.paired).toBe(false);
  });

  it("refuses a non-numeric limit", async () => {
    const res = await relay.app.request(`${CENSUS}?limit=abc`, { headers: AUTH_HEADER });
    expect(res.status).toBe(400);
  });

  it("caps every list at ?limit= while counts stay whole", async () => {
    for (let i = 0; i < 5; i++) device(db, crypto.randomUUID(), await key());
    const c = await census(relay, "?limit=2");
    expect(c.limit).toBe(2);
    expect(c.q5_keyless_with_device_rows.count).toBe(5);
    expect(c.q5_keyless_with_device_rows.ids).toHaveLength(2);
  });
});

// ── Q6 against a real handshake (item 4) ──

const URLS = {
  a: "http://relay-a.census.test:3000",
  b: "http://relay-b.census.test:3001",
} as const;
type Name = keyof typeof URLS;
const rand = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// Adapted for main: relay-federation@1.5 (which records `handshake_protocol_version`
// at confirm) is not on this tree, so a completed handshake leaves no v2 evidence and
// every peer stays counted — the truth here. The source branch's "1.5 handshake is v2
// evidence" assertion returns with that spec.
describe("identity-authority census Q6 — a handshake on this relay records no v2 evidence", () => {
  let relays: Record<Name, SyncRelay>;
  let ids: Record<Name, RelayIdentity>;
  let ip = 0;

  const post = async (n: Name, path: string, body: unknown): Promise<Response> =>
    relays[n].app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `198.51.100.${++ip}` },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    relays = {} as Record<Name, SyncRelay>;
    ids = {} as Record<Name, RelayIdentity>;
    for (const n of Object.keys(URLS) as Name[]) {
      relays[n] = await createTestRelay({
        enableDeviceAuth: false,
        federation: { endpointUrl: URLS[n], displayName: `Relay ${n}` },
      });
      ids[n] = await initRelayIdentity(relays[n].moteDb.db);
    }
  });
  afterEach(async () => {
    for (const r of Object.values(relays)) await r.close();
  });

  /** A propose exactly as the CLI's runPeerHandshake sends it: no spec_version. */
  async function propose(
    target: Name,
    from: Name,
    nonce: string = rand(),
  ): Promise<{ nonce: string; challenge: string }> {
    const res = await post(target, "/federation/v1/peer/propose", {
      relay_id: ids[from].relayMotebitId,
      public_key: ids[from].publicKeyHex,
      endpoint_url: URLS[from],
      nonce,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { nonce: string; challenge: string };
  }

  /** main's runPeerHandshake: cross-propose, self-propose oracle, confirm both ways. */
  async function handshake(): Promise<void> {
    const aOnB = await propose("b", "a");
    const bOnA = await propose("a", "b");
    const oracleA = await propose("a", "a", aOnB.nonce);
    const oracleB = await propose("b", "b", bOnA.nonce);
    for (const [on, from, challenge] of [
      ["b", "a", oracleA.challenge],
      ["a", "b", oracleB.challenge],
    ] as const) {
      const confirm = await post(on, "/federation/v1/peer/confirm", {
        relay_id: ids[from].relayMotebitId,
        challenge_response: challenge,
      });
      expect(confirm.status).toBe(200);
    }
  }

  it("a CLI-shaped handshake both ways leaves each peer counted, suspicious (no protocol recorded)", async () => {
    await handshake();
    for (const n of Object.keys(URLS) as Name[]) {
      const other: Name = n === "a" ? "b" : "a";
      const peers = relays[n].moteDb.db
        .prepare("SELECT state, peer_protocol_version FROM relay_peers")
        .all() as Array<{ state: string; peer_protocol_version: string | null }>;
      // The CLI proposer sends no spec_version: the claim column stays null.
      expect(peers).toEqual([{ state: "active", peer_protocol_version: null }]);
      const c = await census(relays[n]);
      expect(c.q6_v1_peers.ids).toEqual([ids[other].relayMotebitId]);
      expect(c.q6_v1_peers.by_state).toEqual({ active: 1 });
      expect(c.q6_v1_peers.buckets).toEqual({ ...ZERO, suspicious: 1 });
    }
  });

  it("a peer proposed but never confirmed carries no v2 evidence and is still counted", async () => {
    const propose = await post("b", "/federation/v1/peer/propose", {
      relay_id: ids.a.relayMotebitId,
      public_key: ids.a.publicKeyHex,
      endpoint_url: URLS.a,
      nonce: rand(),
    });
    expect(propose.status).toBe(200);
    const c = await census(relays.b);
    expect(c.q6_v1_peers.ids).toEqual([ids.a.relayMotebitId]);
    expect(c.q6_v1_peers.by_state).toEqual({ pending: 1 });
  });
});
