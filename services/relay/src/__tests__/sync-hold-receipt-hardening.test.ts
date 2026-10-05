/**
 * Hardening of the relay's sync hold receipt (spec/sync-hold-receipt-v1.md
 * §4.4–§4.6; `sync-hold-receipt.ts`). Inc 1 ships behind a production
 * deploy and must be PURELY ADDITIVE, so these pin, through the real routes:
 *
 *   (1) the receipt is best-effort decoration — a failure anywhere in
 *       producing it (here: an injected signer throw) leaves the HTTP push,
 *       the seq pull and the socket ack exactly as main serves them, minus
 *       `hold_receipt`, with the events stored, and is logged without payload
 *       content;
 *   (2) the `redacted` flag is a property of the STORED ROW, decided once at
 *       write time — push and pull receipts agree when ingress stripped a
 *       field and left no marker;
 *   (3) a push answered by `INSERT OR IGNORE` keeping an OLDER row describes
 *       that older row (its digest and its flag), never the frame;
 *   (4) a legacy row whose redaction status cannot be established from its
 *       stored bytes is never listed (a device can never credit it), while
 *       legacy rows that ARE decidable from their bytes still are.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { SyncHoldReceipt } from "@motebit/protocol";
import { computeSyncEventDigest, verifySyncHoldReceipt } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, API_TOKEN, createTestRelay } from "./test-helpers.js";

const signer = vi.hoisted(() => ({ fail: false }));

vi.mock("@motebit/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/crypto")>();
  return {
    ...actual,
    signSyncHoldReceipt: (...args: Parameters<typeof actual.signSyncHoldReceipt>) => {
      if (signer.fail) throw new Error("injected signer failure");
      return actual.signSyncHoldReceipt(...args);
    },
  };
});

const NONCE = "Zq81vD0pTmL3xWb4nYp1sKdE6a";

/** The full expectation triple a verifying client passes (all three required). */
function pinned(mid: string) {
  return { expectedPublicKey: relayKey, expectedNonce: NONCE, expectedMotebitId: mid };
}

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;
let relayKey: string;

beforeAll(async () => {
  relay = await createTestRelay({ enableDeviceAuth: false });
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  port = (server.address() as AddressInfo).port;
  const ident = (await (await relay.app.request("/federation/v1/identity")).json()) as {
    public_key: string;
  };
  relayKey = ident.public_key;
}, 60_000);

afterAll(async () => {
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
}, 60_000);

afterEach(() => {
  signer.fail = false;
  vi.restoreAllMocks();
});

let clock = 1;
function entry(mid: string, overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: mid,
    event_type: EventType.StateUpdated,
    payload: { n: clock },
    version_clock: clock++,
    timestamp: 1_760_000_000_000 + clock,
    tombstoned: false,
    ...overrides,
  } as EventLogEntry;
}

async function push(
  mid: string,
  events: EventLogEntry[],
  /** Defaults to NONCE (a receipt is issued only to a nonce-bearing request); `null` sends none. */
  nonce: unknown = NONCE,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await relay.app.request(`/sync/${mid}/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": "corr-hardening-1",
      ...AUTH_HEADER,
    },
    body: JSON.stringify(nonce === null ? { events } : { events, nonce }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function pullSeq(
  mid: string,
  query: string,
  /** Adds `&nonce=NONCE` to a seq pull unless the query names its own (or this is false). */
  withNonce = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const q =
    withNonce && query.includes("after_seq") && !query.includes("nonce=")
      ? `${query}&nonce=${NONCE}`
      : query;
  const res = await relay.app.request(`/sync/${mid}/pull?${q}`, { headers: AUTH_HEADER });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function wsPush(
  mid: string,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${mid}?token=${API_TOKEN}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const ack = new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no ack within 5s")), 5_000);
      ws.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString("utf8")) as Record<string, unknown>;
        if (m.type === "ack") {
          clearTimeout(t);
          resolve(m);
        }
      });
    });
    // A receipt is issued only to a nonce-bearing frame; `nonce: undefined` sends none.
    ws.send(
      JSON.stringify({ type: "push", ...("nonce" in frame ? {} : { nonce: NONCE }), ...frame }),
    );
    return await ack;
  } finally {
    ws.terminate();
  }
}

function receiptOf(body: Record<string, unknown>): SyncHoldReceipt {
  expect(body.hold_receipt, "response carries a hold_receipt").toBeDefined();
  return body.hold_receipt as SyncHoldReceipt;
}

function heldIn(r: SyncHoldReceipt, eventId: string) {
  return r.events.find((e) => e.event_id === eventId);
}

function servedEntry(page: Record<string, unknown>, eventId: string): EventLogEntry {
  const found = (page.events as Array<EventLogEntry & { seq: number }>).find(
    (e) => e.event_id === eventId,
  );
  expect(found, `page serves ${eventId}`).toBeDefined();
  const { seq: _s, ...e } = found!;
  return e as EventLogEntry;
}

/** Captures the relay's structured log lines written while `fn` runs. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = (stream: NodeJS.WriteStream) => {
    const orig = stream.write.bind(stream);
    return vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  };
  const out = spy(process.stdout);
  const err = spy(process.stderr);
  try {
    await fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return lines;
}

describe("(1) a receipt failure never changes what an existing client sees", () => {
  it("HTTP push: injected signer throw ⇒ 200 with main's body, no hold_receipt, events stored, logged", async () => {
    const mid = crypto.randomUUID();
    const secret = `payload-secret-${crypto.randomUUID()}`;
    const a = entry(mid, { payload: { n: 1, note: secret } });
    const b = entry(mid);
    signer.fail = true;
    let res!: { status: number; body: Record<string, unknown> };
    const logs = await captureLogs(async () => {
      res = await push(mid, [a, b], NONCE);
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ motebit_id: mid, accepted: 2, duplicates: 0 });

    // Logged, structured, with the correlation id — and no payload content.
    const failure = logs.find((l) => l.includes("sync.hold_receipt.failed"));
    expect(failure, "the failure is logged").toBeDefined();
    const parsed = JSON.parse(failure!) as Record<string, unknown>;
    expect(parsed.door).toBe("http_push");
    expect(parsed.correlationId).toBe("corr-hardening-1");
    expect(failure).not.toContain(secret);

    // The events were stored: a later (healthy) pull serves and lists them.
    signer.fail = false;
    const page = await pullSeq(mid, "after_seq=0");
    expect((page.body.events as EventLogEntry[]).map((e) => e.event_id)).toEqual([
      a.event_id,
      b.event_id,
    ]);
    expect(receiptOf(page.body).events.map((e) => e.event_id)).toEqual([a.event_id, b.event_id]);
  });

  it("HTTP push duplicate shape is kept too", async () => {
    const mid = crypto.randomUUID();
    const receipt = { signature: `sig-${crypto.randomUUID()}` };
    await push(mid, [entry(mid, { payload: { receipt } })]);
    signer.fail = true;
    const dup = await push(mid, [entry(mid, { payload: { receipt } })], NONCE);
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({ motebit_id: mid, accepted: 0, duplicate: true });
  });

  it("seq pull: injected signer throw ⇒ 200 with main's page, no hold_receipt", async () => {
    const mid = crypto.randomUUID();
    const a = entry(mid);
    await push(mid, [a]);
    signer.fail = true;
    const page = await pullSeq(mid, `after_seq=0&nonce=${NONCE}`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({
      motebit_id: mid,
      events: [{ ...a, seq: 1 }],
      after_seq: 0,
      next_seq: 1,
      has_more: false,
      latest_seq: 1,
    });
  });

  it("WebSocket push: injected signer throw ⇒ the ack still arrives, unchanged, events stored", async () => {
    const mid = crypto.randomUUID();
    const a = entry(mid);
    signer.fail = true;
    const ack = await wsPush(mid, { push_id: "h1", nonce: NONCE, events: [a] });
    expect(ack).toEqual({ type: "ack", accepted: 1, push_id: "h1" });
    signer.fail = false;
    const page = await pullSeq(mid, "after_seq=0");
    expect((page.body.events as EventLogEntry[]).map((e) => e.event_id)).toEqual([a.event_id]);
  });
});

describe("(2) the redacted flag is the stored row's, read back identically by every door", () => {
  it("an ingress manifest strip (no marker left) is redacted=true on push AND pull, same digest", async () => {
    const mid = crypto.randomUUID();
    const signed = entry(mid, {
      event_type: EventType.ConsolidationReceiptSigned,
      payload: {
        receipt_id: "r1",
        counts: { added: 1 },
        mutation_manifest: [{ digest: "d1", sensitivity: "medical" }],
      },
    });
    const pushed = receiptOf((await push(mid, [signed], NONCE)).body);
    const page = (await pullSeq(mid, `after_seq=0&nonce=${NONCE}`)).body;
    const pulled = receiptOf(page);

    const p = heldIn(pushed, signed.event_id)!;
    const q = heldIn(pulled, signed.event_id)!;
    expect(p.redacted).toBe(true);
    expect(q.redacted).toBe(true);
    expect(q.digest).toBe(p.digest);
    expect(p.digest).toBe(await computeSyncEventDigest(servedEntry(page, signed.event_id)));
    expect(p.digest).not.toBe(await computeSyncEventDigest(signed));
  });
});

describe("(3) INSERT OR IGNORE keeping an older row: the receipt describes the stored row", () => {
  it("memory_formed stored as sensitivity none, re-pushed as medical ⇒ redacted=false, older digest", async () => {
    const mid = crypto.randomUUID();
    const v1 = entry(mid, {
      event_type: EventType.MemoryFormed,
      payload: { node_id: "n1", content: "likes tea", sensitivity: "none" },
    });
    await push(mid, [v1]);
    const v2 = {
      ...v1,
      payload: { node_id: "n1", content: "diagnosis", sensitivity: "medical" },
    } as EventLogEntry;
    const pushed = receiptOf((await push(mid, [v2], NONCE)).body);
    const pulled = receiptOf((await pullSeq(mid, "after_seq=0")).body);

    expect(pushed.events).toEqual([
      { event_id: v1.event_id, digest: await computeSyncEventDigest(v1), redacted: false },
    ]);
    const q = heldIn(pulled, v1.event_id)!;
    expect({ digest: q.digest, redacted: q.redacted }).toEqual({
      digest: await computeSyncEventDigest(v1),
      redacted: false,
    });
  });

  it("the reverse: stored redacted (medical), re-pushed benign ⇒ still redacted=true, stored digest", async () => {
    const mid = crypto.randomUUID();
    const v1 = entry(mid, {
      event_type: EventType.MemoryFormed,
      payload: { node_id: "n2", content: "diagnosis", sensitivity: "medical" },
    });
    await push(mid, [v1]);
    const v2 = { ...v1, payload: { node_id: "n2", content: "x", sensitivity: "none" } };
    const pushed = receiptOf((await push(mid, [v2 as EventLogEntry], NONCE)).body);
    const page = (await pullSeq(mid, "after_seq=0")).body;
    const p = heldIn(pushed, v1.event_id)!;
    expect(p.redacted).toBe(true);
    expect(p.digest).toBe(await computeSyncEventDigest(servedEntry(page, v1.event_id)));
  });
});

describe("(4) legacy rows (written before the flag existed)", () => {
  function insertLegacy(e: EventLogEntry): void {
    // Exactly the pre-flag writer: no redaction column named.
    relay.moteDb.db
      .prepare(
        `INSERT INTO events (event_id, motebit_id, device_id, event_type, payload, version_clock, timestamp, tombstoned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.event_id,
        e.motebit_id,
        e.device_id ?? null,
        e.event_type,
        JSON.stringify(e.payload),
        e.version_clock,
        e.timestamp,
        e.tombstoned ? 1 : 0,
      );
  }

  it("an undecidable legacy row is omitted from push and pull receipts; the page still verifies and serves it", async () => {
    const mid = crypto.randomUUID();
    const before = entry(mid);
    await push(mid, [before]);
    // A consolidation receipt without a manifest: was one stripped at ingress?
    // Its bytes cannot say, so the relay must not sign "unredacted" for it.
    const legacy = entry(mid, {
      event_type: EventType.ConsolidationReceiptSigned,
      payload: { receipt_id: "legacy", counts: { added: 1 } },
    });
    insertLegacy(legacy);

    const pushed = receiptOf((await push(mid, [legacy], NONCE)).body);
    expect(heldIn(pushed, legacy.event_id)).toBeUndefined();

    const page = (await pullSeq(mid, `after_seq=0&nonce=${NONCE}`)).body;
    expect((page.events as EventLogEntry[]).map((e) => e.event_id)).toEqual([
      before.event_id,
      legacy.event_id,
    ]);
    const pulled = receiptOf(page);
    expect(pulled.events.map((e) => e.event_id)).toEqual([before.event_id]);
    expect(pulled.page).toEqual({ after_seq: 0, next_seq: 2, has_more: false, latest_seq: 2 });
    expect(await verifySyncHoldReceipt(pulled, pinned(mid))).toEqual({ valid: true });
  });

  it("legacy rows decidable from their bytes are still listed with the right flag", async () => {
    const mid = crypto.randomUUID();
    const plain = entry(mid);
    const marked = entry(mid, {
      event_type: EventType.MemoryFormed,
      payload: { node_id: "n3", content: "[REDACTED]", redacted: true, sensitivity: "medical" },
    });
    const raw = entry(mid, {
      event_type: EventType.MemoryFormed,
      payload: { node_id: "n4", content: "diagnosis", sensitivity: "medical" },
    });
    for (const e of [plain, marked, raw]) insertLegacy(e);
    const page = (await pullSeq(mid, "after_seq=0")).body;
    const r = receiptOf(page);
    expect(r.events.map((e) => [e.event_id, e.redacted])).toEqual([
      [plain.event_id, false],
      [marked.event_id, true],
      [raw.event_id, true], // egress redacts the raw legacy row
    ]);
  });
});

describe("structure: one guarded producer, one writer, one unmarked-type registry", () => {
  it("the raw signer is reachable only through tryHoldReceipt", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "__tests__") walk(p);
        } else if (name.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const isProducer = f.endsWith(`${"/"}sync-hold-receipt.ts`);
      if (!isProducer && /\b(signSyncHoldReceipt|signHeldEvents)\b/.test(src)) offenders.push(f);
      if (isProducer && /export\s+(async\s+)?function\s+signHeldEvents\b/.test(src)) {
        offenders.push(`${f} exports signHeldEvents`);
      }
      // A door that attaches a receipt obtains it from the guard.
      if (!isProducer && /\bhold_receipt\b/.test(src) && !/\btryHoldReceipt\(/.test(src)) {
        offenders.push(`${f} attaches hold_receipt without tryHoldReceipt`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the push door stores exactly the row SqliteEventStore.append stores, plus the flag", async () => {
    const { SqliteEventStore } = await import("@motebit/persistence");
    const mid = crypto.randomUUID();
    const db = relay.moteDb.db;
    const store = new SqliteEventStore(db);
    const shapes: EventLogEntry[] = [
      entry(mid, { device_id: "d1", payload: { a: [1, { b: "é" }], n: null } }),
      entry(mid, { tombstoned: true }),
      { ...entry(mid), version_clock: "7" as never, timestamp: 1.5 },
    ];
    const cols =
      "event_id, motebit_id, device_id, event_type, payload, version_clock, timestamp, tombstoned";
    for (const [k, e] of shapes.entries()) {
      // The same entry under two ids: one through persistence's writer, one
      // through the relay's push door (appendBoundEvent).
      const viaStore = { ...e, event_id: `${e.event_id}-s` };
      const viaRelay = { ...e, event_id: `${e.event_id}-r` };
      await store.append(viaStore);
      expect((await push(mid, [viaRelay])).status, `shape ${k}`).toBe(200);
      const a = db.prepare(`SELECT ${cols} FROM events WHERE event_id = ?`).get(viaStore.event_id);
      const b = db
        .prepare(`SELECT ${cols}, relay_ingress_redacted FROM events WHERE event_id = ?`)
        .get(viaRelay.event_id) as Record<string, unknown>;
      const { relay_ingress_redacted, ...rest } = b;
      expect({ ...rest, event_id: viaStore.event_id }, `shape ${k}`).toEqual(a);
      expect(relay_ingress_redacted).toBe(0);
    }
  });

  it("every ingress redaction outside UNMARKED_INGRESS_REDACTION_TYPES leaves the marker", async () => {
    const { redactSensitiveEvents, UNMARKED_INGRESS_REDACTION_TYPES } =
      await import("../redaction.js");
    const probes: Array<Record<string, unknown>> = [
      { content: "x", sensitivity: "medical" },
      { mutation_manifest: [1], counts: {} },
      { turn_message: "t", missed_patterns: ["m"] },
      { reason: "r", action: "ADD" },
    ];
    for (const type of Object.values(EventType)) {
      for (const payload of probes) {
        const e = entry("m", { event_type: type, payload });
        const [out] = redactSensitiveEvents([e]);
        if (out === e) continue; // untouched
        const marked = (out!.payload as Record<string, unknown>).redacted === true;
        expect(marked || UNMARKED_INGRESS_REDACTION_TYPES.has(type), `${type}`).toBe(true);
      }
    }
  });
});
