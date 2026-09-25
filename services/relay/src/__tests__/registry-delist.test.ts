/**
 * Identity key state outlives the discovery row (#703, Increment 1 —
 * docs/proposals/identity-key-state-v1.md §4, §7).
 *
 * Every door that used to DELETE an `agent_registry` row now DELISTS it:
 * deregister, the janitor, `/revoke`, migration departure. Each case below
 * asserts the two halves separately — the identity leaves the SHELF (discover,
 * task routing, A2A card, the serving count) AND the identity's KEY STATE
 * stays (row, public key, guardian, settlement, the identity log). Then the
 * ways back: re-registration re-shelves a delisted row and never a revoked
 * one; migration arrival keeps what the payload does not carry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqlJsDriver, type DatabaseDriver } from "@motebit/persistence";

import type { SyncRelay } from "../index.js";
import { relayMigrations } from "../migrations.js";
import { DELIST_SET, delistExpired, delistRegistration } from "../registry-delist.js";
import { createTaskRouter } from "../task-routing.js";
import type { RelayIdentity } from "../federation.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readIdentityBindings } from "../identity-transparency.js";
import { aggregateHealthSummary } from "../health-summary.js";
import { createTestRelay, AUTH_HEADER } from "./test-helpers.js";

const KEY_A = "a".repeat(64);
const GUARDIAN = "b".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

function insertServing(db: DatabaseDriver, motebitId: string, now: number, capability = "query") {
  db.prepare(
    `INSERT INTO agent_registry
       (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at,
        guardian_public_key, settlement_address, settlement_modes, sweep_threshold, federation_visible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    motebitId,
    KEY_A,
    "https://agent.example/mcp",
    JSON.stringify([capability]),
    now,
    now,
    now + 90 * DAY,
    GUARDIAN,
    "So1anaAddr111111111111111111111111111111111",
    "relay",
    5_000_000,
  );
}

type Row = {
  motebit_id: string;
  public_key: string;
  guardian_public_key: string | null;
  settlement_address: string | null;
  settlement_modes: string | null;
  sweep_threshold: number | null;
  endpoint_url: string;
  capabilities: string;
  delisted_at: number | null;
  revoked: number | null;
};
const row = (db: DatabaseDriver, id: string) =>
  db.prepare("SELECT * FROM agent_registry WHERE motebit_id = ?").get(id) as Row | undefined;

/** The shelf, as every discoverability reader sees it. */
async function onShelf(relay: SyncRelay, id: string): Promise<boolean> {
  const res = await relay.app.request(`/api/v1/discover/${id}`);
  const body = (await res.json()) as { found: boolean };
  return body.found;
}

describe("registry-delist — off the shelf, never forgotten", () => {
  let relay: SyncRelay;
  let db: DatabaseDriver;
  const now = Date.now();

  beforeEach(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    db = relay.moteDb.db;
  });
  afterEach(async () => {
    await relay.close();
  });

  it("delistRegistration clears the discovery fields and keeps every key and settlement column", async () => {
    insertServing(db, "mote-a", now);
    expect(await onShelf(relay, "mote-a")).toBe(true);

    delistRegistration(db, "mote-a", now + 1);

    const r = row(db, "mote-a");
    expect(r).toBeDefined();
    expect(r!.delisted_at).toBe(now + 1);
    expect(r!.endpoint_url).toBe("");
    expect(JSON.parse(r!.capabilities)).toEqual([]);
    // The second lifetime, intact:
    expect(r!.public_key).toBe(KEY_A);
    expect(r!.guardian_public_key).toBe(GUARDIAN);
    expect(r!.settlement_address).toBe("So1anaAddr111111111111111111111111111111111");
    expect(r!.settlement_modes).toBe("relay");
    expect(r!.sweep_threshold).toBe(5_000_000);
    expect(r!.revoked ?? 0).toBe(0);

    expect(await onShelf(relay, "mote-a")).toBe(false);
    expect(readIdentityBindings(db).map((b) => b.motebit_id)).toContain("mote-a");
  });

  it("every shelf reader excludes a delisted row: discover list, the A2A card, the relay card count — and the key reader still answers", async () => {
    insertServing(db, "mote-shelf", now, "summarize");
    delistRegistration(db, "mote-shelf", now);

    const list = await relay.app.request("/api/v1/agents/discover?capability=summarize", {
      headers: AUTH_HEADER,
    });
    expect(((await list.json()) as { agents: unknown[] }).agents).toHaveLength(0);

    // GET /agents/:id is a KEY reader (mcp-server's last-resort caller-key
    // lookup): it keeps answering for a delisted row.
    const one = await relay.app.request("/api/v1/agents/mote-shelf", { headers: AUTH_HEADER });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { public_key: string }).public_key).toBe(KEY_A);

    const card = await relay.app.request("/a2a/agents/mote-shelf/agent.json");
    expect(card.status).toBe(404);

    const relayInfo = await relay.app.request("/.well-known/motebit-relay.json");
    if (relayInfo.status === 200) {
      const info = (await relayInfo.json()) as { agent_count?: number };
      if (info.agent_count !== undefined) expect(info.agent_count).toBe(0);
    }
  });

  it("the janitor delists lapsed leases and never deletes; a second sweep changes nothing", () => {
    insertServing(db, "mote-lapsed", now - 100 * DAY);
    insertServing(db, "mote-live", now);
    db.prepare("UPDATE agent_registry SET expires_at = ? WHERE motebit_id = ?").run(
      now - DAY,
      "mote-lapsed",
    );

    expect(delistExpired(db, now)).toBe(1);
    const lapsed = row(db, "mote-lapsed");
    expect(lapsed).toBeDefined();
    expect(lapsed!.delisted_at).toBe(now);
    expect(lapsed!.public_key).toBe(KEY_A);
    expect(lapsed!.guardian_public_key).toBe(GUARDIAN);
    expect(row(db, "mote-live")!.delisted_at).toBeNull();

    // Idempotent: the first delisting time is the record, not the last sweep.
    expect(delistExpired(db, now + 5 * DAY)).toBe(0);
    expect(row(db, "mote-lapsed")!.delisted_at).toBe(now);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_registry").get()).toEqual({ n: 2 });
  });

  it("re-registration re-shelves a delisted row and clears delisted_at", async () => {
    insertServing(db, "mote-back", now);
    delistRegistration(db, "mote-back", now);
    expect(await onShelf(relay, "mote-back")).toBe(false);

    const res = await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: "mote-back",
        public_key: KEY_A,
        endpoint_url: "https://agent.example/mcp",
        capabilities: ["query"],
      }),
    });
    expect(res.status).toBe(200);
    const r = row(db, "mote-back")!;
    expect(r.delisted_at).toBeNull();
    expect(r.guardian_public_key).toBe(GUARDIAN); // COALESCE kept it
    expect(await onShelf(relay, "mote-back")).toBe(true);
  });

  it("/revoke delists in the same write, keeps the row, and re-registration never un-delists a revoked identity", async () => {
    insertServing(db, "mote-revoked", now);

    const revoke = await relay.app.request("/api/v1/agents/mote-revoked/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    expect(revoke.status).toBe(200);

    const r = row(db, "mote-revoked")!;
    expect(r.revoked).toBe(1);
    expect(r.delisted_at).not.toBeNull();
    expect(r.endpoint_url).toBe("");
    expect(r.public_key).toBe(KEY_A);
    expect(await onShelf(relay, "mote-revoked")).toBe(false);
    // D3: identity ≠ discovery — the binding and its end stay in the log.
    expect(readIdentityBindings(db).map((b) => b.motebit_id)).toContain("mote-revoked");

    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: "mote-revoked",
        public_key: KEY_A,
        endpoint_url: "https://agent.example/mcp",
        capabilities: ["query"],
      }),
    });
    const after = row(db, "mote-revoked")!;
    expect(after.revoked).toBe(1);
    expect(after.delisted_at).toBe(r.delisted_at);
    expect(await onShelf(relay, "mote-revoked")).toBe(false);
  });

  it("health-summary: total_registered and the active windows are the shelf, total_known is every row", () => {
    insertServing(db, "mote-h1", now);
    insertServing(db, "mote-h2", now);
    delistRegistration(db, "mote-h2", now);
    const out = aggregateHealthSummary(db, now);
    expect(out.motebits.total_registered).toBe(1);
    expect(out.motebits.total_known).toBe(2);
    expect(out.motebits.active_24h).toBe(1);
  });

  it("a heartbeat from a delisted identity is 'not registered', as it was when the row was deleted", async () => {
    insertServing(db, "mote-hb", now);
    delistRegistration(db, "mote-hb", now);
    const res = await relay.app.request("/api/v1/agents/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ motebit_id: "mote-hb" }),
    });
    expect(res.status).toBe(404);
    expect(row(db, "mote-hb")!.delisted_at).toBe(now);
  });

  it("the scored routing path over listings drops a delisted or revoked agent's listing", async () => {
    const idRow = db.prepare("SELECT * FROM relay_identity").get() as {
      relay_motebit_id: string;
      public_key: string;
      private_key_hex: string;
      did: string;
    };
    const relayIdentity: RelayIdentity = {
      relayMotebitId: idRow.relay_motebit_id,
      publicKey: Uint8Array.from(Buffer.from(idRow.public_key, "hex")),
      privateKey: Uint8Array.from(Buffer.from(idRow.private_key_hex, "hex")),
      publicKeyHex: idRow.public_key,
      did: idRow.did,
    };
    const router = createTaskRouter({ db, relayIdentity });
    const listing = db.prepare(
      "INSERT INTO relay_service_listings (listing_id, motebit_id, capabilities, pricing, updated_at) VALUES (?, ?, ?, '[]', ?)",
    );
    insertServing(db, "mote-l-serving", now, "translate");
    insertServing(db, "mote-l-delisted", now, "translate");
    insertServing(db, "mote-l-revoked", now, "translate");
    listing.run("lst-1", "mote-l-serving", JSON.stringify(["translate"]), now);
    listing.run("lst-2", "mote-l-delisted", JSON.stringify(["translate"]), now);
    listing.run("lst-3", "mote-l-revoked", JSON.stringify(["translate"]), now);
    delistRegistration(db, "mote-l-delisted", now);
    db.prepare("UPDATE agent_registry SET revoked = 1 WHERE motebit_id = ?").run("mote-l-revoked");

    const ids = (cap?: string) =>
      router
        .buildCandidateProfiles(cap, undefined, 20)
        .profiles.map((p) => p.motebit_id)
        .sort();
    expect(ids("translate")).toEqual(["mote-l-serving"]);
    expect(ids()).toEqual(["mote-l-serving"]);
  });

  it("the operator's revoke-listing is a hold: off the shelf, fields kept; restore-listing puts it straight back", async () => {
    insertServing(db, "mote-op", now, "query");
    const revoke = await relay.app.request("/api/v1/agents/mote-op/revoke-listing", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(revoke.status).toBe(200);
    const op = row(db, "mote-op")!;
    expect(op.revoked).toBe(1);
    expect(op.delisted_at).not.toBeNull();
    expect(op.endpoint_url).toBe("https://agent.example/mcp"); // a hold keeps the fields
    expect(await onShelf(relay, "mote-op")).toBe(false);

    const restore = await relay.app.request("/api/v1/agents/mote-op/restore-listing", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({}),
    });
    expect(restore.status).toBe(200);
    expect(row(db, "mote-op")!.revoked).toBe(0);
    expect(row(db, "mote-op")!.delisted_at).toBeNull();
    expect(await onShelf(relay, "mote-op")).toBe(true);
  });

  it("re-registration of a REVOKED identity restores no discovery field — the endpoint a task could be forwarded to stays blank", async () => {
    insertServing(db, "mote-rr", now);
    await relay.app.request("/api/v1/agents/mote-rr/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    });
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: "mote-rr",
        public_key: KEY_A,
        endpoint_url: "https://attacker.example/mcp",
        capabilities: ["query"],
      }),
    });
    const r = row(db, "mote-rr")!;
    expect(r.revoked).toBe(1);
    expect(r.delisted_at).not.toBeNull();
    expect(r.endpoint_url).toBe("");
    expect(JSON.parse(r.capabilities)).toEqual([]);
  });

  it("the revocation doors spell DELIST_SET exactly — a synchronization invariant, pinned", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const door of ["key-rotation.ts", "migration.ts"]) {
      const src = readFileSync(resolve(here, "..", door), "utf-8");
      expect(src, `${door} must write revoked = 1 together with DELIST_SET verbatim`).toContain(
        `revoked = 1, ${DELIST_SET}`,
      );
    }
    // The operator's hold writes the delisted_at half and keeps the fields.
    const half = DELIST_SET.split(", endpoint_url")[0];
    expect(readFileSync(resolve(here, "..", "agents.ts"), "utf-8")).toContain(
      `revoked = 1, ${half} WHERE`,
    );
  });
});

describe("migration v41 — rows already revoked are backfilled as delisted", () => {
  const m41 = relayMigrations.find((m) => m.version === 41)!;
  const KEY = "a".repeat(64);
  let db: DatabaseDriver;
  beforeEach(async () => {
    db = await SqlJsDriver.open(":memory:");
    db.exec(`CREATE TABLE agent_registry (
      motebit_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, endpoint_url TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]', registered_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER DEFAULT 0
    )`);
  });
  afterEach(() => db.close());

  it("adds the column and sets delisted_at on revoked rows only", () => {
    const t = 1_700_000_000_000;
    const ins = db.prepare(
      "INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, registered_at, last_heartbeat, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    ins.run("mote-old-revoked", KEY, "https://x", t, t, t, 1);
    ins.run("mote-old-live", KEY, "https://x", t, t, t, 0);

    m41.up(db);

    const get = (id: string) =>
      (
        db.prepare("SELECT delisted_at FROM agent_registry WHERE motebit_id = ?").get(id) as {
          delisted_at: number | null;
        }
      ).delisted_at;
    expect(get("mote-old-revoked")).not.toBeNull();
    expect(get("mote-old-live")).toBeNull();
  });

  it("does not throw when the column already exists (a partially applied run)", () => {
    db.exec("ALTER TABLE agent_registry ADD COLUMN delisted_at INTEGER");
    expect(() => m41.up(db)).not.toThrow();
  });

  it("is followed by v42 (identity_keys), so a fresh database gets both", () => {
    expect(Math.max(...relayMigrations.map((m) => m.version))).toBe(42);
  });
});
