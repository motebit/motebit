/**
 * A request without a usable nonce costs the relay NOTHING for the hold
 * receipt (spec/sync-hold-receipt-v1.md §4.1).
 *
 * A receipt without a nonce answers no request, and a client MUST NOT credit
 * one (§5) — and no shipped client sends a nonce. Building one anyway put
 * readback, a JCS + SHA-256 digest per event and an Ed25519 signature on the
 * event loop of every existing client's push and pull (measured: HTTP push
 * 500 × 1 KB ~1.9×, seq pull 1000 events ~3.5×, +155 KB per 1.39 MB page).
 *
 * Pinned at all three doors through the real routes, by spies rather than
 * wall-clock (deterministic): with no nonce, or an unusable one, the relay
 * performs ZERO readback queries, ZERO event digests and ZERO signatures, and
 * the response carries no `hold_receipt`. The positive control (a nonce) shows
 * the same spies do see the work when it is asked for.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import type { EventLogEntry } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, API_TOKEN, createTestRelay } from "./test-helpers.js";

const work = vi.hoisted(() => ({ digests: 0, signs: 0, readbacks: 0 }));

vi.mock("@motebit/crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("@motebit/crypto")>();
  return {
    ...real,
    computeSyncEventDigestSync: (...a: Parameters<typeof real.computeSyncEventDigestSync>) => {
      work.digests++;
      return real.computeSyncEventDigestSync(...a);
    },
    signSyncHoldReceipt: (...a: Parameters<typeof real.signSyncHoldReceipt>) => {
      work.signs++;
      return real.signSyncHoldReceipt(...a);
    },
  };
});

const NONCE = "hR7c2Vq0tLmZ9xWb4nYp1sKdE6";

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;

beforeAll(async () => {
  relay = await createTestRelay({ enableDeviceAuth: false });
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  port = (server.address() as AddressInfo).port;
  // The push readback is the only query naming a list of event ids.
  const db = relay.moteDb.db;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (/AND event_id IN \(/.test(sql)) work.readbacks++;
    return prepare(sql);
  }) as typeof db.prepare;
}, 60_000);

afterAll(async () => {
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
}, 60_000);

beforeEach(() => {
  work.digests = 0;
  work.signs = 0;
  work.readbacks = 0;
});

let clock = 1;
function entries(mid: string, n: number): EventLogEntry[] {
  return Array.from(
    { length: n },
    () =>
      ({
        event_id: crypto.randomUUID(),
        motebit_id: mid,
        event_type: EventType.StateUpdated,
        payload: { n: clock, blob: "x".repeat(200) },
        version_clock: clock++,
        timestamp: 1_760_000_000_000 + clock,
        tombstoned: false,
      }) as EventLogEntry,
  );
}

async function push(mid: string, events: EventLogEntry[], nonce?: unknown) {
  const res = await relay.app.request(`/sync/${mid}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify(nonce === undefined ? { events } : { events, nonce }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function pullSeq(mid: string, query: string) {
  const res = await relay.app.request(`/sync/${mid}/pull?${query}`, { headers: AUTH_HEADER });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function wsPush(mid: string, frame: Record<string, unknown>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${mid}?token=${API_TOKEN}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const ack = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString("utf8")) as Record<string, unknown>;
        if (m.type === "ack") resolve(m);
      });
    });
    ws.send(JSON.stringify({ type: "push", ...frame }));
    return await ack;
  } finally {
    ws.terminate();
  }
}

const UNUSABLE: Array<string | number | undefined> = [
  undefined,
  "short",
  12345,
  "x".repeat(21),
  "has spaces in it, 22+ chars",
];

function expectNoWork(label: string): void {
  expect(work, label).toEqual({ digests: 0, signs: 0, readbacks: 0 });
}

describe("a nonce-less request performs zero receipt work", () => {
  it("HTTP push: no readback, digest or signature; no hold_receipt", async () => {
    const mid = crypto.randomUUID();
    for (const nonce of UNUSABLE) {
      const body = await push(mid, entries(mid, 20), nonce);
      expect(body.accepted).toBe(20);
      expect("hold_receipt" in body, String(nonce)).toBe(false);
      expectNoWork(`http push nonce=${String(nonce)}`);
    }
  });

  it("seq pull: no digest or signature; no hold_receipt", async () => {
    const mid = crypto.randomUUID();
    await push(mid, entries(mid, 30));
    for (const nonce of UNUSABLE) {
      const q =
        nonce === undefined
          ? "after_seq=0"
          : `after_seq=0&nonce=${encodeURIComponent(String(nonce))}`;
      const page = await pullSeq(mid, q);
      expect((page.events as unknown[]).length).toBe(30);
      expect("hold_receipt" in page, String(nonce)).toBe(false);
      expectNoWork(`seq pull nonce=${String(nonce)}`);
    }
  });

  it("WebSocket push: no readback, digest or signature; ack has no hold_receipt", async () => {
    const mid = crypto.randomUUID();
    for (const nonce of UNUSABLE) {
      const frame: Record<string, unknown> = { push_id: "p1", events: entries(mid, 10) };
      if (nonce !== undefined) frame.nonce = nonce;
      const ack = await wsPush(mid, frame);
      expect(ack.push_id).toBe("p1");
      expect("hold_receipt" in ack, String(nonce)).toBe(false);
      expectNoWork(`ws push nonce=${String(nonce)}`);
    }
  });

  it("positive control: with a nonce, the same spies see the work at every door", async () => {
    const mid = crypto.randomUUID();
    expect("hold_receipt" in (await push(mid, entries(mid, 5), NONCE))).toBe(true);
    expect(work).toEqual({ digests: 5, signs: 1, readbacks: 1 });
    expect("hold_receipt" in (await wsPush(mid, { nonce: NONCE, events: entries(mid, 3) }))).toBe(
      true,
    );
    expect(work).toEqual({ digests: 8, signs: 2, readbacks: 2 });
    expect("hold_receipt" in (await pullSeq(mid, `after_seq=0&nonce=${NONCE}`))).toBe(true);
    expect(work).toEqual({ digests: 16, signs: 3, readbacks: 2 });
  });
});
