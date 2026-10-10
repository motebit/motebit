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
import { bytesToHex, generateKeypair } from "@motebit/encryption";
import { deriveSovereignMotebitId } from "@motebit/crypto";
import type { DatabaseDriver } from "@motebit/persistence";

import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay, walletOf } from "./test-helpers.js";

const CENSUS = "/api/v1/admin/identity-authority/census";

interface Census {
  measured_at: number;
  limit: number;
  q1_planted_device_rows: {
    count: number;
    rows: Array<{
      motebit_id: string;
      device_id: string;
      registered_at: number;
      current_key_basis: string;
      matches_holder: boolean;
      id_commits_to_device_key: boolean;
    }>;
  };
  q2_sovereign_squats: { count: number; ids: string[] };
  q3_unbound_money_destinations: {
    settlement_address: { count: number; rows: Array<{ motebit_id: string; reason: string }> };
    pay_to_address: { count: number; rows: Array<{ motebit_id: string; reason: string }> };
    withdrawal_destination: {
      count: number;
      rows: Array<{ motebit_id: string; reason: string; source: string }>;
    };
  };
  q4_unproven_guardians: {
    identity_keys: { count: number; ids: string[] };
    agent_registry: { count: number; ids: string[] };
  };
  q5_keyless_with_device_rows: { count: number; ids: string[] };
  q6_v1_peers: { count: number; by_state: Record<string, number>; ids: string[] };
}

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

    const before = changes(db);
    const res = await relay.app.request(CENSUS, { headers: AUTH_HEADER });
    const text = await res.text();
    expect(changes(db)).toBe(before);
    expect(text).not.toContain(stranger);
    expect(text).not.toContain(stranger.slice(0, 9));
    expect(text).not.toMatch(/tok-dev-/);
    expect(text).not.toMatch(/[0-9a-f]{40,}/i);
  });

  it("caps every list at ?limit= while counts stay whole", async () => {
    for (let i = 0; i < 5; i++) device(db, crypto.randomUUID(), await key());
    const c = await census(relay, "?limit=2");
    expect(c.limit).toBe(2);
    expect(c.q5_keyless_with_device_rows.count).toBe(5);
    expect(c.q5_keyless_with_device_rows.ids).toHaveLength(2);
  });
});
