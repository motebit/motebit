/**
 * identity-keys — the ONE holder and the ONE resolver (#703 Inc 2, proposal
 * identity-key-state-v1 §5). The holders are set against each other and the
 * resolver's precedence is pinned; every door that proves a key is shown to
 * write it; the backfill fills only the unambiguous; and the three readers
 * that used to hand-roll the answer (auth's service fallback, verify-receipt,
 * departureFrom) are shown to agree with the identity log and the bundle.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseDriver } from "@motebit/persistence";

import type { SyncRelay } from "../index.js";
import {
  IDENTITY_KEYS_BACKFILL_SQL,
  identityKeyFor,
  keyHeldByEveryDevice,
  recordIdentityKey,
} from "../identity-keys.js";
import { applySuccession, departureFrom, keyOnFile } from "../succession-apply.js";
import { readIdentityBindings } from "../identity-transparency.js";
import { createTestRelay, AUTH_HEADER } from "./test-helpers.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

function plantRegistry(
  db: DatabaseDriver,
  mid: string,
  key: string,
  guardian: string | null = null,
) {
  db.prepare(
    "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, registered_at, last_heartbeat, expires_at, guardian_public_key) VALUES (?, ?, '', ?, ?, ?, ?)",
  ).run(mid, key, 1_000, 1_000, 9_999_999_999_999, guardian);
}
function plantChain(db: DatabaseDriver, mid: string, from: string, to: string) {
  db.prepare(
    "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, new_key_signature) VALUES (?, ?, ?, ?, 'sig')",
  ).run(mid, from, to, 2_000);
}
function plantDevice(db: DatabaseDriver, mid: string, id: string, key: string) {
  db.prepare(
    "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, mid, `tok-${id}`, key, 3_000);
}

describe("identityKeyFor — the one resolver, holders set against each other", () => {
  let relay: SyncRelay;
  let db: DatabaseDriver;
  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    db = relay.moteDb.db;
  });
  afterEach(async () => {
    await relay.close();
  });

  it("holder > registry > chain head > agreeing devices > null", () => {
    const mid = "mote-prec";
    plantRegistry(db, mid, B);
    plantChain(db, mid, B, C);
    plantDevice(db, mid, "d1", D);
    plantDevice(db, mid, "d2", D);
    recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "register", now: 5 });
    expect(identityKeyFor(db, mid)?.publicKey).toBe(A);

    db.prepare("DELETE FROM identity_keys WHERE motebit_id = ?").run(mid);
    expect(identityKeyFor(db, mid)).toMatchObject({ publicKey: B, source: "registry" });

    db.prepare("UPDATE agent_registry SET public_key = '' WHERE motebit_id = ?").run(mid);
    expect(identityKeyFor(db, mid)).toMatchObject({ publicKey: C, source: "chain" });

    db.prepare("DELETE FROM relay_key_successions WHERE motebit_id = ?").run(mid);
    expect(identityKeyFor(db, mid)).toMatchObject({ publicKey: D, source: "devices" });

    // Disagreeing device rows answer nothing — a guess is a planted binding (D5).
    db.prepare("UPDATE devices SET public_key = ? WHERE device_id = 'd2'").run(E);
    expect(identityKeyFor(db, mid)).toBeNull();
    expect(identityKeyFor(db, "mote-unknown")).toBeNull();
  });

  it("recordIdentityKey upserts the key, keeps the guardian unless given one, and refuses a non-key", () => {
    const mid = "mote-rec";
    recordIdentityKey(db, {
      motebitId: mid,
      publicKey: A,
      guardianPublicKey: E,
      source: "register",
      now: 1,
    });
    recordIdentityKey(db, { motebitId: mid, publicKey: B, source: "succession", now: 2 });
    expect(identityKeyFor(db, mid)).toMatchObject({
      publicKey: B,
      guardianPublicKey: E,
      source: "succession",
      firstSeen: 1,
    });
    expect(() =>
      recordIdentityKey(db, { motebitId: mid, publicKey: "not-a-key", source: "register", now: 3 }),
    ).toThrow(/not a 32-byte hex public key/);
    expect(identityKeyFor(db, mid)?.publicKey).toBe(B);
  });

  it("the backfill fills registry, chain and agreeing-device identities, and leaves the ambiguous alone", () => {
    plantRegistry(db, "bf-reg", A, E);
    plantDevice(db, "bf-reg", "r1", D); // registry wins even with a device row
    plantChain(db, "bf-chain", A, C);
    plantDevice(db, "bf-dev", "v1", D);
    plantDevice(db, "bf-dev", "v2", D);
    plantDevice(db, "bf-amb", "m1", D);
    plantDevice(db, "bf-amb", "m2", E);
    plantDevice(db, "bf-none", "n1", "");
    db.prepare(IDENTITY_KEYS_BACKFILL_SQL).run(7, 7);

    const rows = db
      .prepare(
        "SELECT motebit_id, public_key, guardian_public_key, source FROM identity_keys ORDER BY motebit_id",
      )
      .all() as Array<{
      motebit_id: string;
      public_key: string;
      guardian_public_key: string | null;
      source: string;
    }>;
    expect(rows).toEqual([
      {
        motebit_id: "bf-chain",
        public_key: C,
        guardian_public_key: null,
        source: "backfill:chain",
      },
      {
        motebit_id: "bf-dev",
        public_key: D,
        guardian_public_key: null,
        source: "backfill:devices",
      },
      { motebit_id: "bf-reg", public_key: A, guardian_public_key: E, source: "backfill:registry" },
    ]);
    // Idempotent: a second run adds nothing and moves nothing.
    db.prepare(IDENTITY_KEYS_BACKFILL_SQL).run(8, 8);
    expect((db.prepare("SELECT COUNT(*) AS n FROM identity_keys").get() as { n: number }).n).toBe(
      3,
    );
  });

  it("the doors write the holder: /agents/register records the key it proved, with its guardian", async () => {
    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: "mote-door",
        public_key: A,
        endpoint_url: "https://agent.example/mcp",
        capabilities: ["query"],
      }),
    });
    expect(res.status).toBe(200);
    expect(identityKeyFor(db, "mote-door")).toMatchObject({ publicKey: A, source: "register" });
  });

  it("the three readers agree with the holder: keyOnFile, the identity log, and the §7.6 bundle", async () => {
    const mid = "mote-agree";
    plantRegistry(db, mid, B);
    recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "bootstrap", now: 4 });
    expect(keyOnFile(db, mid).held).toBe(A);
    expect(readIdentityBindings(db).find((b) => b.motebit_id === mid)?.public_key).toBe(A);
    const bundle = await relay.app.request(`/api/v1/identity/${mid}`);
    expect(bundle.status).toBe(200);
    expect(((await bundle.json()) as { current_public_key: string }).current_public_key).toBe(A);

    // An identity with NO registry row at all — the 42-of-51 production shape —
    // is in the log and answers §7.6 once a door has recorded its key.
    recordIdentityKey(db, {
      motebitId: "mote-rowless",
      publicKey: C,
      source: "register-self",
      now: 4,
    });
    expect(readIdentityBindings(db).map((b) => b.motebit_id)).toContain("mote-rowless");
    expect((await relay.app.request("/api/v1/identity/mote-rowless")).status).toBe(200);
  });

  it("keys are stored as given — an uppercase registrant's own spelling is what the holder answers", () => {
    const upper = "ABCDEF" + "0".repeat(58);
    recordIdentityKey(db, {
      motebitId: "mote-upper",
      publicKey: upper,
      source: "register",
      now: 1,
    });
    expect(identityKeyFor(db, "mote-upper")?.publicKey).toBe(upper);
    expect(departureFrom(db, "mote-upper", upper)).toMatchObject({
      admissible: true,
      rung: "holder",
    });
    expect(departureFrom(db, "mote-upper", upper.toLowerCase())).toMatchObject({
      admissible: false,
    });
  });

  it("keyHeldByEveryDevice: no keyed rows, or all rows this key — never a key some row does not hold", () => {
    expect(keyHeldByEveryDevice(db, "mote-none", A)).toBe(true);
    plantDevice(db, "mote-one", "o1", A);
    expect(keyHeldByEveryDevice(db, "mote-one", A)).toBe(true);
    expect(keyHeldByEveryDevice(db, "mote-one", B)).toBe(false);
    plantDevice(db, "mote-one", "o2", B);
    expect(keyHeldByEveryDevice(db, "mote-one", A)).toBe(false);
  });

  it("/agents/register: a first key contradicted by a device row is NOT recorded; a differing key without a succession is refused", async () => {
    // Personal identity: device A holds K1 and a paired device holds its own K2; no holder yet.
    plantDevice(db, "mote-reg-c", "dA", A);
    plantDevice(db, "mote-reg-c", "dB", B);
    const first = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: "mote-reg-c",
        public_key: B,
        endpoint_url: "https://x/mcp",
        capabilities: ["query"],
      }),
    });
    expect(first.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM identity_keys WHERE motebit_id = ?").get("mote-reg-c"),
    ).toBeUndefined();

    // A rowless identity whose holder says A: registering under an unproven C
    // is a key change, and the succession rule now compares against the holder.
    recordIdentityKey(db, { motebitId: "mote-reg-h", publicKey: A, source: "bootstrap", now: 1 });
    const change = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: "mote-reg-h",
        public_key: C,
        endpoint_url: "https://x/mcp",
        capabilities: ["query"],
      }),
    });
    expect(change.status).toBe(400);
    expect(identityKeyFor(db, "mote-reg-h")?.publicKey).toBe(A);
  });

  it("the legacy /device/register (operator bearer) proves nothing and writes nothing to the holder", async () => {
    recordIdentityKey(db, { motebitId: "mote-legacy", publicKey: A, source: "bootstrap", now: 1 });
    const res = await relay.app.request("/device/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ motebit_id: "mote-legacy", device_name: "x", public_key: B }),
    });
    expect(res.status).toBeLessThan(500);
    expect(identityKeyFor(db, "mote-legacy")?.publicKey).toBe(A);
  });

  it("a re-presented head link does not drag a holder that has moved on back to an older key", () => {
    const mid = "mote-replay";
    plantDevice(db, mid, "r1", A);
    plantRegistry(db, mid, A);
    recordIdentityKey(db, { motebitId: mid, publicKey: A, source: "register", now: 1 });
    const link = {
      old_public_key: A,
      new_public_key: B,
      timestamp: 2,
      reason: null,
      old_key_signature: "s1",
      new_key_signature: "s2",
      recovery: false,
      guardian_signature: null,
    } as unknown as Parameters<typeof applySuccession>[2];
    applySuccession(db, mid, link);
    expect(identityKeyFor(db, mid)?.publicKey).toBe(B);
    // The holder moves on (another door) …
    recordIdentityKey(db, { motebitId: mid, publicKey: C, source: "register", now: 3 });
    // … and the same link presented again is a no-op for the holder.
    applySuccession(db, mid, link);
    expect(identityKeyFor(db, mid)?.publicKey).toBe(C);
  });
});
