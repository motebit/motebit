/**
 * Identity authority, Inc 2 (SHADOW) — the single writer, its capability and
 * the guard (docs/design/identity-authority-writers.md §3–§4, §7 Inc 2).
 *
 * The hard constraint of Inc 2: it REFUSES NOTHING NEW. Every request that
 * succeeds on origin/main still succeeds, with the same response. Proven per
 * money door (#1 register, #3 sweep-config, #4–5 listing, #6 withdraw):
 *
 *   (a) without `X-Motebit-Authority`, the response is the one origin/main
 *       gives — compared, normalized, with `authority-doors.golden.json`,
 *       captured from the doors' code as it stands on origin/main
 *       (`CAPTURE_AUTHORITY_GOLDEN=1` re-captures; the door code at capture
 *       was byte-identical to origin/main's);
 *   (c) a device-only write (a token from a device row that is not the
 *       identity's current key) still succeeds and leaves EXACTLY ONE
 *       `authority_write_outside_writer` event — and none once the guard's
 *       triggers are dropped (the event is the guard's, not the door's);
 *   (b) the same change through `writeAuthority` under a `ProvenKey` writes it
 *       and leaves no event;
 *   (d) a header that is malformed, signed by a key that is not the current
 *       key, replayed, for another field / relay / value, or stale never
 *       mints a `ProvenKey`; a forged capability throws at the writer and
 *       writes nothing.
 *
 * The door-level header cells (b)/(d) over HTTP are in
 * `identity-authority-doors.test.ts` (Inc 2 part 2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  encodeAuthorityHeader,
  generateKeypair,
  mintAudienceToken,
  signAuthorityRequest,
  type AuthorityField,
  type KeyPair,
} from "@motebit/crypto";
import type { TokenAudience } from "@motebit/protocol";
import type { SyncRelay } from "../index.js";
import {
  AUTHORITY_COLUMNS,
  AUTHORITY_SHADOW_KIND,
  AuthorityCapabilityRefused,
  AuthorityReplayed,
  ProvenKey,
  proveCurrentKey,
  writeAuthority,
  type AuthorityChange,
} from "../identity-authority.js";
import { requestContext } from "../request-context.js";
import { AUTH_HEADER, JSON_AUTH, createTestRelay, seedBalance, walletOf } from "./test-helpers.js";

const GOLDEN = join(__dirname, "authority-doors.golden.json");
const CAPTURE = process.env["CAPTURE_AUTHORITY_GOLDEN"] === "1";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
beforeEach(async () => {
  relay = await createTestRelay();
});
afterEach(async () => {
  await relay.close();
});

const db = () => relay.moteDb.db;
const relayId = () => relay.relayIdentity.relayMotebitId;

/** V: a sovereign identity whose current key is K (its genesis), plus a second device row P (key K_P). */
async function cast() {
  const owner = await generateKeypair();
  const paired = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(owner));
  const boot = await relay.app.request("/api/v1/agents/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motebit_id: mid, device_id: "owner-dev", public_key: hex(owner) }),
  });
  expect(boot.status).toBe(201);
  // A device row holding a key that is NOT V's current key — what pairing
  // approval (or a pre-#875 squat) leaves. Its token passes dev(=path).
  db()
    .prepare(
      "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("paired-dev", mid, `tok-${crypto.randomUUID()}`, hex(paired), Date.now());
  return { owner, paired, mid, wallet: walletOf(hex(owner)) };
}
type Cast = Awaited<ReturnType<typeof cast>>;

async function token(c: Cast, who: "owner" | "paired", aud: TokenAudience): Promise<string> {
  const kp = who === "owner" ? c.owner : c.paired;
  const { token: t } = await mintAudienceToken(
    { mid: c.mid, did: who === "owner" ? "owner-dev" : "paired-dev", aud },
    kp.privateKey,
  );
  return t;
}

interface Door {
  field: AuthorityField;
  method: "POST" | "PATCH";
  path: (mid: string) => string;
  aud: TokenAudience;
  body: (c: Cast) => Record<string, unknown>;
  /** State the door needs before it can succeed on main. */
  prepare: (c: Cast) => Promise<void>;
  /** The identity's authority values this door writes, read back. */
  read: (c: Cast) => unknown;
  /** The change `writeAuthority` applies for this door's body. */
  change: (c: Cast) => AuthorityChange;
}

async function registerByOperator(c: Cast): Promise<void> {
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: c.mid,
      endpoint_url: "http://127.0.0.1:9999/mcp",
      capabilities: ["seed"],
    }),
  });
  expect(res.status).toBe(200);
}

const registryRow = (c: Cast) =>
  db()
    .prepare(
      "SELECT public_key, endpoint_url, capabilities, settlement_address, sweep_threshold FROM agent_registry WHERE motebit_id = ?",
    )
    .get(c.mid);

export const DOORS: Record<string, Door> = {
  register: {
    field: "registration",
    method: "POST",
    path: () => "/api/v1/agents/register",
    aud: "admin:query",
    body: (c) => ({
      endpoint_url: "http://127.0.0.1:9999/mcp",
      capabilities: ["web_search"],
      settlement_address: c.wallet,
      sweep_threshold: 5_000_000,
    }),
    prepare: async () => {},
    read: registryRow,
    change: (c) => ({
      field: "registration",
      motebitId: c.mid,
      sovereignProof: null,
      operatorServiceKey: false,
      publicKey: hex(c.owner),
      endpointUrl: "http://127.0.0.1:9999/mcp",
      capabilities: ["web_search"],
      metadata: null,
      now: Date.now(),
      expiresAt: Date.now() + 1000,
      guardianPublicKey: null,
      federationVisible: 1,
      settlementAddress: c.wallet,
      settlementModes: "relay",
      sweepThreshold: 5_000_000,
      listingDescription: "web_search",
    }),
  },
  sweep_config: {
    field: "sweep_config",
    method: "PATCH",
    path: (mid) => `/api/v1/agents/${mid}/sweep-config`,
    aud: "admin:query",
    body: (c) => ({ sweep_threshold: 7_000_000, settlement_address: c.wallet }),
    prepare: registerByOperator,
    read: registryRow,
    change: (c) => ({
      field: "sweep_config",
      motebitId: c.mid,
      sweepThreshold: 7_000_000,
      settlementAddress: c.wallet,
    }),
  },
  listing: {
    field: "listing",
    method: "POST",
    path: (mid) => `/api/v1/agents/${mid}/listing`,
    aud: "market:listing",
    body: (c) => ({
      capabilities: ["web_search"],
      pricing: [{ capability: "web_search", unit_cost: 0.05, currency: "USD", per: "request" }],
      pay_to_address: c.wallet,
    }),
    prepare: registerByOperator,
    read: (c) =>
      db()
        .prepare(
          "SELECT capabilities, pricing, pay_to_address FROM relay_service_listings WHERE motebit_id = ?",
        )
        .all(c.mid),
    change: (c) => ({
      field: "listing",
      motebitId: c.mid,
      listingId: `ls-${crypto.randomUUID()}`,
      now: Date.now(),
      capabilities: JSON.stringify(["web_search"]),
      pricing: JSON.stringify([
        { capability: "web_search", unit_cost: 0.05, currency: "USD", per: "request" },
      ]),
      slaMaxLatencyMs: 5000,
      slaAvailability: 0.99,
      description: "",
      payToAddress: c.wallet,
      regulatoryRisk: null,
    }),
  },
  withdraw: {
    field: "withdrawal",
    method: "POST",
    path: (mid) => `/api/v1/agents/${mid}/withdraw`,
    aud: "account:withdraw",
    body: (c) => ({ amount: 1, destination: c.wallet }),
    prepare: async (c) => {
      seedBalance(relay, c.mid, 10);
    },
    read: (c) =>
      db()
        .prepare("SELECT amount, destination, status FROM relay_withdrawals WHERE motebit_id = ?")
        .all(c.mid),
    change: (c) => ({
      field: "withdrawal",
      motebitId: c.mid,
      amountMicro: 1_000_000,
      destination: c.wallet,
      idempotencyKey: crypto.randomUUID(),
    }),
  },
};

export async function callDoor(
  c: Cast,
  door: Door,
  opts: { who: "owner" | "paired"; authority?: string; body?: Record<string, unknown> },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await token(c, opts.who, door.aud)}`,
    "Idempotency-Key": crypto.randomUUID(),
  };
  if (opts.authority !== undefined) headers["X-Motebit-Authority"] = opts.authority;
  const res = await relay.app.request(door.path(c.mid), {
    method: door.method,
    headers,
    body: JSON.stringify(opts.body ?? door.body(c)),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text body */
  }
  return { status: res.status, body };
}

/** Replace per-run values (ids, keys, addresses, times) by stable placeholders. */
export function normalize(value: unknown, c: Cast, relayIdValue: string): unknown {
  const names = new Map<string, string>([
    [c.mid, "<V>"],
    [hex(c.owner), "<K>"],
    [hex(c.paired), "<K_P>"],
    [c.wallet, "<WALLET>"],
    [relayIdValue, "<RELAY>"],
  ]);
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") {
      if (names.has(v)) return names.get(v);
      if (/^ls-[0-9a-f-]{36}$/.test(v)) return "<LISTING_ID>";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return "<UUID>";
      if (key !== null && /(_at|_id)$/.test(key)) return `<${key}>`;
      return v;
    }
    if (typeof v === "number" && key !== null && /(_at|^timestamp$|^ts$)/.test(key))
      return `<${key}>`;
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, null);
}

const lastEventId = (): number =>
  (db().prepare("SELECT COALESCE(MAX(id), 0) AS n FROM relay_auth_events").get() as { n: number })
    .n;
const shadowEventsSince = (id: number) =>
  db()
    .prepare(
      "SELECT kind, method, path, motebit_id, reason FROM relay_auth_events WHERE id > ? AND kind = ? ORDER BY id",
    )
    .all(id, AUTHORITY_SHADOW_KIND) as Array<{
    kind: string;
    method: string | null;
    path: string;
    motebit_id: string | null;
    reason: string;
  }>;

async function signedHeader(
  c: Cast,
  field: AuthorityField,
  value: unknown,
  over: { key?: KeyPair; relay?: string; now?: number; motebitId?: string } = {},
): Promise<string> {
  return encodeAuthorityHeader(
    await signAuthorityRequest({
      motebitId: over.motebitId ?? c.mid,
      field,
      value,
      relayId: over.relay ?? relayId(),
      privateKey: (over.key ?? c.owner).privateKey,
      ...(over.now !== undefined ? { now: over.now } : {}),
    }),
  );
}

// ── (a) + (c): no header — main's response, one shadow event ──────────

describe("Inc 2 refuses nothing new — every money door without a header answers as origin/main", () => {
  const golden: Record<string, unknown> = CAPTURE
    ? {}
    : existsSync(GOLDEN)
      ? (JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>)
      : {};

  afterEach(() => {
    if (CAPTURE) {
      const prior = existsSync(GOLDEN)
        ? (JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>)
        : {};
      writeFileSync(GOLDEN, JSON.stringify({ ...prior, ...golden }, null, 2) + "\n");
    }
  });

  for (const [name, door] of Object.entries(DOORS)) {
    for (const who of ["owner", "paired"] as const) {
      it(`${name} — ${who} device, no header: main's status and body; exactly one shadow event`, async () => {
        const c = await cast();
        await door.prepare(c);
        const before = lastEventId();
        const res = await callDoor(c, door, { who });
        const seen = normalize(res, c, relayId());
        const key = `${name}/${who}`;
        if (CAPTURE) golden[key] = seen;
        else expect(seen).toEqual(golden[key]);
        expect(res.status).toBeLessThan(300);
        const events = shadowEventsSince(before);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          kind: AUTHORITY_SHADOW_KIND,
          method: door.method,
          path: door.path(c.mid),
          motebit_id: c.mid,
        });
      });
    }
  }

  it("the golden covers exactly the doors × devices (re-capture with CAPTURE_AUTHORITY_GOLDEN=1)", () => {
    if (CAPTURE) return;
    expect(Object.keys(golden).sort()).toEqual(
      Object.keys(DOORS)
        .flatMap((d) => [`${d}/owner`, `${d}/paired`])
        .sort(),
    );
  });
});

describe("the event is the guard's: with the shadow triggers dropped, a device-only write records nothing", () => {
  for (const [name, door] of Object.entries(DOORS)) {
    it(`${name}: no triggers ⇒ no event (severed-guard proof)`, async () => {
      const c = await cast();
      await door.prepare(c);
      for (const { name: t } of db()
        .prepare(
          "SELECT name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'authority_shadow_%'",
        )
        .all() as Array<{ name: string }>)
        db().exec(`DROP TRIGGER temp."${t}"`);
      const before = lastEventId();
      const res = await callDoor(c, door, { who: "paired" });
      expect(res.status).toBeLessThan(300);
      expect(shadowEventsSince(before)).toEqual([]);
    });
  }
});

// ── (b): through the writer, under a ProvenKey — written, no event ─────

describe("writeAuthority under a ProvenKey writes the change and leaves no shadow event", () => {
  for (const [name, door] of Object.entries(DOORS)) {
    it(`${name}`, async () => {
      const c = await cast();
      await door.prepare(c);
      const value = door.body(c);
      const proven = await proveCurrentKey(db(), {
        header: await signedHeader(c, door.field, value),
        field: door.field,
        motebitId: c.mid,
        value,
        relayId: relayId(),
      });
      expect(proven.ok).toBe(true);
      if (!proven.ok) return;
      const beforeValues = JSON.stringify(door.read(c));
      const before = lastEventId();
      writeAuthority(db(), proven.cap, door.change(c));
      expect(shadowEventsSince(before)).toEqual([]);
      expect(JSON.stringify(door.read(c))).not.toBe(beforeValues);
    });
  }

  it("the same ProvenKey twice: the second write is an exact replay — refused, nothing written", async () => {
    const c = await cast();
    const door = DOORS["sweep_config"]!;
    await door.prepare(c);
    const value = door.body(c);
    const proven = await proveCurrentKey(db(), {
      header: await signedHeader(c, door.field, value),
      field: door.field,
      motebitId: c.mid,
      value,
      relayId: relayId(),
    });
    if (!proven.ok) throw new Error(proven.reason);
    writeAuthority(db(), proven.cap, door.change(c));
    expect(() =>
      writeAuthority(db(), proven.cap, { ...door.change(c), sweepThreshold: 1 } as AuthorityChange),
    ).toThrow(AuthorityReplayed);
    expect((registryRow(c) as { sweep_threshold: number }).sweep_threshold).toBe(7_000_000);
  });

  it("a ProvenKey for one field or identity cannot write another", async () => {
    const c = await cast();
    await registerByOperator(c);
    const value = DOORS["listing"]!.body(c);
    const proven = await proveCurrentKey(db(), {
      header: await signedHeader(c, "listing", value),
      field: "listing",
      motebitId: c.mid,
      value,
      relayId: relayId(),
    });
    if (!proven.ok) throw new Error(proven.reason);
    expect(() => writeAuthority(db(), proven.cap, DOORS["sweep_config"]!.change(c))).toThrow(
      AuthorityCapabilityRefused,
    );
    expect(() =>
      writeAuthority(db(), proven.cap, {
        ...(DOORS["listing"]!.change(c) as AuthorityChange),
        motebitId: crypto.randomUUID(),
      } as AuthorityChange),
    ).toThrow(AuthorityCapabilityRefused);
  });
});

// ── (d): what never mints a ProvenKey ───────────────────────────────────

describe("proveCurrentKey refuses every header that does not prove the CURRENT key over this change", () => {
  async function refusal(
    c: Cast,
    header: string,
    expect_: { field?: AuthorityField; value?: unknown; motebitId?: string } = {},
  ) {
    const r = await proveCurrentKey(db(), {
      header,
      field: expect_.field ?? "sweep_config",
      motebitId: expect_.motebitId ?? c.mid,
      value: expect_.value ?? { sweep_threshold: 1 },
      relayId: relayId(),
    });
    return r.ok ? "minted" : r.reason;
  }

  it("malformed: not base64url JSON, or not an authority request", async () => {
    const c = await cast();
    expect(await refusal(c, "not a header!")).toBe("malformed");
    expect(await refusal(c, Buffer.from("{}").toString("base64url"))).toBe("malformed");
  });

  it("signed by a device key that is not the current key (the paired row) — bad_signature", async () => {
    const c = await cast();
    const v = { sweep_threshold: 1 };
    expect(
      await refusal(c, await signedHeader(c, "sweep_config", v, { key: c.paired }), { value: v }),
    ).toBe("bad_signature");
  });

  it("another field, another value, another relay, a stale ts — each refused by name", async () => {
    const c = await cast();
    const v = { sweep_threshold: 1 };
    expect(await refusal(c, await signedHeader(c, "listing", v), { value: v })).toBe(
      "field_mismatch",
    );
    expect(
      await refusal(c, await signedHeader(c, "sweep_config", v), { value: { sweep_threshold: 2 } }),
    ).toBe("value_mismatch");
    expect(
      await refusal(c, await signedHeader(c, "sweep_config", v, { relay: "other-relay" }), {
        value: v,
      }),
    ).toBe("wrong_relay");
    expect(
      await refusal(c, await signedHeader(c, "sweep_config", v, { now: Date.now() - 6 * 60_000 }), {
        value: v,
      }),
    ).toBe("stale");
  });

  it("an identity with no current key (a legacy id, no evidence holder) — no_current_key (D2)", async () => {
    const legacy = await generateKeypair();
    const mid = crypto.randomUUID();
    await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motebit_id: mid, device_id: "d", public_key: hex(legacy) }),
    });
    const c = { owner: legacy, paired: legacy, mid, wallet: walletOf(hex(legacy)) };
    const v = { sweep_threshold: 1 };
    expect(await refusal(c, await signedHeader(c, "sweep_config", v), { value: v })).toBe(
      "no_current_key",
    );
  });

  it("an accepted request presented again — replayed", async () => {
    const c = await cast();
    await registerByOperator(c);
    const door = DOORS["sweep_config"]!;
    const value = door.body(c);
    const header = await signedHeader(c, door.field, value);
    const first = await proveCurrentKey(db(), {
      header,
      field: door.field,
      motebitId: c.mid,
      value,
      relayId: relayId(),
    });
    if (!first.ok) throw new Error(first.reason);
    writeAuthority(db(), first.cap, door.change(c));
    expect(await refusal(c, header, { value })).toBe("replayed");
  });
});

describe("ProvenKey is a runtime capability — a forgery throws at the writer and writes nothing", () => {
  it("cast, prototype copy, JSON round-trip, and a direct construction each refuse", async () => {
    const c = await cast();
    await registerByOperator(c);
    const change = DOORS["sweep_config"]!.change(c);
    const forged: unknown[] = [
      { motebitId: c.mid, field: "sweep_config", publicKey: hex(c.owner) },
      Object.create(ProvenKey.prototype) as unknown,
      JSON.parse(JSON.stringify({ motebitId: c.mid, field: "sweep_config" })) as unknown,
    ];
    for (const f of forged) {
      expect(() => writeAuthority(db(), f as ProvenKey, change)).toThrow(
        AuthorityCapabilityRefused,
      );
    }
    expect(
      () =>
        new ProvenKey(
          Symbol("ProvenKey.mint") as never,
          {
            motebitId: c.mid,
            publicKey: hex(c.owner),
            basis: "sovereign_lineage",
            field: "sweep_config",
            signature: "00",
            nonce: "00",
          } as never,
        ),
    ).toThrow();
    expect((registryRow(c) as { sweep_threshold: number | null }).sweep_threshold).toBeNull();
  });
});

// ── The guard itself ────────────────────────────────────────────────────

describe("installAuthorityGuards — the census's full authority-column list, recorded never aborted", () => {
  // AUTHORITY_COLUMNS ↔ the committed census is checked by
  // check-identity-authority-inventory (scripts/), which reads docs/ — a relay
  // test must not (the pre-push hook scopes docs/ changes out of package tests).

  it("every declared table carries INSERT / UPDATE OF / DELETE shadow triggers on a booted relay", () => {
    const triggers = new Set(
      (
        db()
          .prepare(
            "SELECT name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'authority_shadow_%'",
          )
          .all() as Array<{ name: string }>
      ).map((t) => t.name),
    );
    for (const table of Object.keys(AUTHORITY_COLUMNS))
      for (const op of ["insert", "update", "delete"])
        expect(triggers.has(`authority_shadow_${table}_${op}`), `${table} ${op}`).toBe(true);
  });

  it("a raw write outside any request is RECORDED (grouped per subject per hour) and still lands; a non-authority column records nothing", async () => {
    const c = await cast();
    await registerByOperator(c);
    const internal = () =>
      db()
        .prepare(
          "SELECT id, reason FROM relay_auth_events WHERE kind = ? AND motebit_id = ? AND path = '(internal)'",
        )
        .all(AUTHORITY_SHADOW_KIND, c.mid) as Array<{ id: number; reason: string }>;
    // cast() planted the paired device row with a raw INSERT, outside any request.
    expect(internal()).toHaveLength(1);
    expect(internal()[0]!.reason).toBe("devices:INSERT");
    const snapshot = JSON.stringify(internal());
    db()
      .prepare("UPDATE agent_registry SET last_heartbeat = ? WHERE motebit_id = ?")
      .run(Date.now(), c.mid);
    expect(JSON.stringify(internal())).toBe(snapshot);
    db()
      .prepare("UPDATE agent_registry SET settlement_address = ? WHERE motebit_id = ?")
      .run(c.wallet, c.mid);
    expect(internal()).toHaveLength(1);
    expect(internal()[0]!.reason.split(",")).toEqual(["devices:INSERT", "agent_registry:UPDATE"]);
    expect((registryRow(c) as { settlement_address: string }).settlement_address).toBe(c.wallet);
    // Another subject outside a request is its own event.
    const other = crypto.randomUUID();
    const before = lastEventId();
    db()
      .prepare(
        "INSERT INTO relay_service_listings (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, updated_at) VALUES (?, ?, '[]', '[]', 1, 1, '', 1)",
      )
      .run(`ls-${crypto.randomUUID()}`, other);
    expect(shadowEventsSince(before)).toEqual([
      expect.objectContaining({
        motebit_id: other,
        path: "(internal)",
        reason: "relay_service_listings:INSERT",
      }),
    ]);
  });

  it("never aborts: repeated authority writes in ONE request, under every outer conflict policy, land and record one event", async () => {
    // A trigger's INSERT OR IGNORE takes the OUTER statement's conflict policy
    // (SQLite), so a second write in one request once aborted rotate-key with
    // a UNIQUE violation on the guard's own bookkeeping. Every policy, twice.
    const c = await cast();
    await registerByOperator(c);
    const before = lastEventId();
    requestContext.run(
      { correlationId: "corr", startedAt: Date.now(), method: "POST", path: "/probe" },
      () => {
        for (const policy of [
          "",
          "OR ABORT",
          "OR FAIL",
          "OR IGNORE",
          "OR REPLACE",
          "OR ROLLBACK",
        ]) {
          for (let i = 0; i < 2; i++) {
            db()
              .prepare(
                `UPDATE ${policy} agent_registry SET sweep_threshold = ? WHERE motebit_id = ?`,
              )
              .run(i + 1, c.mid);
            db()
              .prepare(
                // Same device_id each round: REPLACE rewrites it; ABORT /
                // FAIL / ROLLBACK / IGNORE meet the primary key — only
                // IGNORE and REPLACE may run that second insert.
                `INSERT ${policy === "" || !["OR IGNORE", "OR REPLACE"].includes(policy) ? "OR REPLACE" : policy} INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)`,
              )
              .run(`probe-${i}`, c.mid, `t-${crypto.randomUUID()}`, hex(c.paired), Date.now());
          }
        }
      },
    );
    const events = shadowEventsSince(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ motebit_id: c.mid, path: "/probe" });
    expect(events[0]!.reason.split(",").sort()).toEqual([
      "agent_registry:UPDATE",
      "devices:INSERT",
    ]);
  });

  it("one request touching several authority tables is ONE event naming each table:op", async () => {
    const c = await cast();
    const before = lastEventId();
    const res = await callDoor(c, DOORS["register"]!, { who: "owner" });
    expect(res.status).toBe(200);
    const events = shadowEventsSince(before);
    expect(events).toHaveLength(1);
    expect(events[0]!.reason.split(",")).toEqual(
      expect.arrayContaining(["agent_registry:INSERT", "relay_service_listings:INSERT"]),
    );
  });
});

// ── The doors: X-Motebit-Authority over HTTP (Inc 2, part 2) ────────────

describe("X-Motebit-Authority on the money doors — valid writes through writeAuthority, invalid is 401", () => {
  const golden = existsSync(GOLDEN)
    ? (JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>)
    : {};
  const refusalsSince = (id: number) =>
    (
      db()
        .prepare(
          "SELECT reason FROM relay_auth_events WHERE id > ? AND kind = 'agent_token_rejected' AND reason LIKE 'authority:%' ORDER BY id",
        )
        .all(id) as Array<{ reason: string }>
    ).map((r) => r.reason);

  for (const [name, door] of Object.entries(DOORS)) {
    for (const who of ["owner", "paired"] as const) {
      it(`${name} — valid header, ${who} device token: main's response, the change written, no shadow event`, async () => {
        const c = await cast();
        await door.prepare(c);
        const value = door.body(c);
        const beforeValues = JSON.stringify(door.read(c));
        const before = lastEventId();
        const res = await callDoor(c, door, {
          who,
          authority: await signedHeader(c, door.field, value),
          body: value,
        });
        expect(normalize(res, c, relayId())).toEqual(golden[`${name}/${who}`]);
        expect(shadowEventsSince(before)).toEqual([]);
        expect(refusalsSince(before)).toEqual([]);
        expect(JSON.stringify(door.read(c))).not.toBe(beforeValues);
      });
    }

    const INVALID: Array<{
      variant: string;
      reason: string;
      header: (c: Cast, value: Record<string, unknown>) => Promise<string>;
    }> = [
      { variant: "malformed", reason: "malformed", header: async () => "!!not-a-header!!" },
      {
        variant: "signed by the paired device's key (not the current key)",
        reason: "bad_signature",
        header: (c, v) => signedHeader(c, door.field, v, { key: c.paired }),
      },
      {
        variant: "for another field",
        reason: "field_mismatch",
        header: (c, v) => signedHeader(c, door.field === "listing" ? "sweep_config" : "listing", v),
      },
      {
        variant: "over another value",
        reason: "value_mismatch",
        header: (c, v) => signedHeader(c, door.field, { ...v, tampered: true }),
      },
      {
        variant: "for another relay",
        reason: "wrong_relay",
        header: (c, v) => signedHeader(c, door.field, v, { relay: "another-relay" }),
      },
      {
        variant: "stale",
        reason: "stale",
        header: (c, v) => signedHeader(c, door.field, v, { now: Date.now() - 6 * 60_000 }),
      },
    ];
    for (const bad of INVALID) {
      it(`${name} — header ${bad.variant}: 401 ${bad.reason}, nothing written, refusal recorded, no shadow event`, async () => {
        const c = await cast();
        await door.prepare(c);
        const value = door.body(c);
        const beforeValues = JSON.stringify(door.read(c));
        const before = lastEventId();
        const res = await callDoor(c, door, {
          who: "owner",
          authority: await bad.header(c, value),
          body: value,
        });
        expect(res.status).toBe(401);
        expect(JSON.stringify(door.read(c))).toBe(beforeValues);
        expect(shadowEventsSince(before)).toEqual([]);
        expect(refusalsSince(before)).toEqual([`authority:${bad.reason}`]);
      });
    }

    it(`${name} — the same header replayed: the first writes, the replay is 401 replayed and writes nothing`, async () => {
      const c = await cast();
      await door.prepare(c);
      const value = door.body(c);
      const header = await signedHeader(c, door.field, value);
      const first = await callDoor(c, door, { who: "owner", authority: header, body: value });
      expect(first.status).toBeLessThan(300);
      const afterFirst = JSON.stringify(door.read(c));
      const before = lastEventId();
      const replay = await callDoor(c, door, { who: "owner", authority: header, body: value });
      expect(replay.status).toBe(401);
      expect(JSON.stringify(door.read(c))).toBe(afterFirst);
      expect(shadowEventsSince(before)).toEqual([]);
      expect(refusalsSince(before)).toEqual(["authority:replayed"]);
    });
  }

  it("an identity with no current key presenting a header: 401 no_current_key; without one it still succeeds (D2 freezes nothing in Inc 2)", async () => {
    const legacy = await generateKeypair();
    const mid = crypto.randomUUID();
    await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motebit_id: mid, device_id: "owner-dev", public_key: hex(legacy) }),
    });
    const c: Cast = { owner: legacy, paired: legacy, mid, wallet: walletOf(hex(legacy)) };
    const door = DOORS["register"]!;
    const value = door.body(c);
    const refused = await callDoor(c, door, {
      who: "owner",
      authority: await signedHeader(c, door.field, value),
      body: value,
    });
    expect(refused.status).toBe(401);
    const ok = await callDoor(c, door, { who: "owner", body: value });
    expect(ok.status).toBe(200);
  });
});
void AUTH_HEADER;
