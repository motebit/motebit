/**
 * Differential probe for #868: the sync pull cursor.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/sync-seq-868.probe.ts --pkg services/relay
 *
 * A real served relay (127.0.0.1) and the REAL client — `@motebit/sync-engine`
 * loaded from each tree's own source, so the base side runs main's client and
 * main's relay, the head side this branch's.
 *
 * Expected:
 *   - SAME: every old-client pull (no `after_seq`) — the response bytes are
 *     identical, so a shipped client is served exactly as before; pushes too.
 *   - DIFF: the real client, two devices of one identity, a sibling event at
 *     an EQUAL clock — main never pulls it, head does. And a raw
 *     `after_seq` pull: main ignores the parameter (clock shape), head
 *     answers by seq.
 *
 * Observations carry role names, never ids.
 */
import { it, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { EventLogEntry } from "@motebit/sdk";
import type { SyncRelay } from "../index.js";
import { createTestRelay, API_TOKEN, AUTH_HEADER, JSON_AUTH } from "./test-helpers.js";

interface SyncEngineModule {
  SyncEngine: new (
    local: EventStoreAdapter,
    motebitId: string,
  ) => {
    connectRemote(r: EventStoreAdapter): void;
    sync(): Promise<{ pushed: number; pulled: number }>;
  };
  HttpEventStoreAdapter: new (cfg: {
    baseUrl: string;
    motebitId: string;
    authToken?: string;
    maxRetries?: number;
  }) => EventStoreAdapter;
}

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let base: string;
let se: SyncEngineModule;
const obs: Record<string, unknown> = {};

beforeAll(async () => {
  se = (await import(
    /* @vite-ignore */ fileURLToPath(
      new URL("../../../../packages/sync-engine/src/index.ts", import.meta.url),
    )
  )) as SyncEngineModule;
  relay = await createTestRelay();
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
}, 120_000);

const ev = (mid: string, id: string, clock: number, device: string): EventLogEntry => ({
  event_id: `${id}-${mid}`,
  motebit_id: mid as EventLogEntry["motebit_id"],
  device_id: device,
  timestamp: 1_700_000_000_000 + clock,
  event_type: "state_snapshot" as EventLogEntry["event_type"],
  payload: { from: device, clock },
  version_clock: clock,
  tombstoned: false,
});

/** Replace the run's identity with a role name so bytes compare across trees. */
const roles = (text: string, mid: string): string => text.split(mid).join("<MID>");

async function push(mid: string, events: EventLogEntry[]): Promise<string> {
  const r = await fetch(`${base}/sync/${mid}/push`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ events }),
  });
  return `${r.status} ${roles(await r.text(), mid)}`;
}

async function raw(mid: string, query: string): Promise<string> {
  const r = await fetch(`${base}/sync/${mid}/pull${query}`, { headers: AUTH_HEADER });
  return `${r.status} ${roles(await r.text(), mid)}`;
}

function client(mid: string): {
  store: InMemoryEventStore;
  engine: InstanceType<SyncEngineModule["SyncEngine"]>;
} {
  const store = new InMemoryEventStore();
  const engine = new se.SyncEngine(store, mid);
  engine.connectRemote(
    new se.HttpEventStoreAdapter({
      baseUrl: base,
      motebitId: mid,
      authToken: API_TOKEN,
      maxRetries: 0,
    }),
  );
  return { store, engine };
}

const held = async (s: InMemoryEventStore, mid: string): Promise<string[]> =>
  (await s.query({})).map((e) => roles(e.event_id, mid).replace("-<MID>", "")).sort();

it("old-client pulls are byte-identical; the same-clock sibling event reaches the real client only on head", async () => {
  // ── old clients: raw clock pulls, every shape a shipped client sends ──
  const old = crypto.randomUUID();
  obs["push: three events, two clocks colliding"] = await push(old, [
    ev(old, "x", 1, "a"),
    ev(old, "y", 2, "b"),
    ev(old, "z", 2, "a"),
  ]);
  obs["push: replay of a held event"] = await push(old, [ev(old, "x", 1, "a")]);
  obs["old client: pull after_clock=0"] = await raw(old, "?after_clock=0");
  obs["old client: pull after_clock=1"] = await raw(old, "?after_clock=1");
  obs["old client: pull after_clock=2"] = await raw(old, "?after_clock=2");
  obs["old client: pull with no cursor"] = await raw(old, "");
  obs["old client: pull after_clock=garbage"] = await raw(old, "?after_clock=abc");
  const clock = await fetch(`${base}/sync/${old}/clock`, { headers: AUTH_HEADER });
  obs["clock route"] = `${clock.status} ${roles(await clock.text(), old)}`;

  // ── the #816 trace through the REAL client ────────────────────────────
  const mid = crypto.randomUUID();
  const A = client(mid);
  await A.store.append(ev(mid, "evt-11", 1011, "mobile"));
  await A.store.append(ev(mid, "evt-12", 1012, "mobile"));
  await A.engine.sync();
  // The sibling device of the same identity publishes at the SAME clocks.
  await push(mid, [ev(mid, "in-11", 1011, "desktop"), ev(mid, "in-12", 1012, "desktop")]);
  const r1 = await A.engine.sync();
  const r2 = await A.engine.sync();
  obs["real client: #816 trace — events held after two more syncs"] = await held(A.store, mid);
  obs["real client: #816 trace — pulled counts"] = [r1.pulled, r2.pulled];

  // ── two real devices, equal clock, natural appendWithClock ────────────
  const m2 = crypto.randomUUID();
  const P = client(m2);
  const Q = client(m2);
  const mk = (id: string, device: string) => {
    const { version_clock: _c, ...rest } = ev(m2, id, 0, device);
    return rest;
  };
  await P.store.appendWithClock(mk("p-1", "p"));
  await Q.store.appendWithClock(mk("q-1", "q")); // both at clock 1
  await P.engine.sync();
  await Q.engine.sync();
  await P.engine.sync();
  obs["real clients: P holds after P,Q,P sync"] = await held(P.store, m2);
  obs["real clients: Q holds after P,Q,P sync"] = await held(Q.store, m2);

  // ── the new cursor on the wire (intended DIFF) ────────────────────────
  obs["raw: pull after_seq=0 top-level keys"] = Object.keys(
    JSON.parse((await raw(old, "?after_seq=0")).slice(4)) as object,
  );
});

// ── round 2: the E2E socket catch-up path (every WS surface) ─────────────
interface E2eModule {
  EncryptedEventStoreAdapter: new (cfg: {
    inner: EventStoreAdapter;
    key: Uint8Array;
  }) => EventStoreAdapter;
  WebSocketEventStoreAdapter: new (cfg: {
    url: string;
    motebitId: string;
    httpFallback: EventStoreAdapter;
    localStore: EventStoreAdapter;
    onCatchUp?: (n: number) => void;
  }) => { connect(): void; disconnect(): void };
}

class ProbeSocket {
  static last: ProbeSocket | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    ProbeSocket.last = this;
  }
  send(): void {}
  close(): void {}
}

const K1 = new Uint8Array(32).fill(1);
const K2 = new Uint8Array(32).fill(2);
const KX = new Uint8Array(32).fill(99);

it("E2E socket catch-up: rotation, poison, raw-then-E2E; and the per-identity seq", async () => {
  const m = se as unknown as E2eModule;
  const g = globalThis as { WebSocket?: unknown };
  const realWs = g.WebSocket;
  g.WebSocket = ProbeSocket;
  const http = (mid: string) =>
    new se.HttpEventStoreAdapter({
      baseUrl: base,
      motebitId: mid,
      authToken: API_TOKEN,
      maxRetries: 0,
    });
  const encPush = (mid: string, key: Uint8Array, e: EventLogEntry) =>
    new m.EncryptedEventStoreAdapter({ inner: http(mid), key }).append(e);
  const catchUp = async (mid: string, store: EventStoreAdapter, key: Uint8Array) => {
    let done = -1;
    const ws = new m.WebSocketEventStoreAdapter({
      url: `ws://127.0.0.1/ws/sync/${mid}`,
      motebitId: mid,
      httpFallback: new m.EncryptedEventStoreAdapter({ inner: http(mid), key }),
      localStore: store,
      onCatchUp: (n) => (done = n),
    });
    ws.connect();
    ProbeSocket.last!.onopen?.();
    for (let i = 0; i < 200 && done < 0; i++) await new Promise((r) => setTimeout(r, 10));
    ws.disconnect();
  };
  const plainHeld = async (s: InMemoryEventStore, mid: string) =>
    (await s.query({}))
      .map((e) => {
        const enc = (e.payload as { _encrypted?: boolean })._encrypted === true;
        return roles(e.event_id, mid).replace("-<MID>", "") + (enc ? " (ciphertext)" : "");
      })
      .sort();
  try {
    // rotatedWs: old-1 held under k1; the identity key rotates; new-2 under k2.
    {
      const mid = crypto.randomUUID();
      const store = new InMemoryEventStore();
      await encPush(mid, K1, ev(mid, "old-1", 1, "a"));
      await catchUp(mid, store, K1);
      await encPush(mid, K2, ev(mid, "new-2", 2, "a"));
      await catchUp(mid, store, K2);
      obs["rotatedWs: held after the post-rotation catch-up"] = await plainHeld(store, mid);
    }
    // rotatedWs (upgrade): old-1 is already held from before this client
    // pulled by seq (so its first seq pull starts at 0); the key rotates;
    // new-2 is written under k2.
    {
      const mid = crypto.randomUUID();
      const store = new InMemoryEventStore();
      const old1 = ev(mid, "old-1", 1, "a");
      await store.append(old1);
      await encPush(mid, K1, old1);
      await encPush(mid, K2, ev(mid, "new-2", 2, "a"));
      await catchUp(mid, store, K2);
      obs["rotatedWs (upgrade, old-1 held before the first seq pull)"] = await plainHeld(
        store,
        mid,
      );
    }
    // poisonWs: this device holds its own events to clock 5; an event no key
    // opens sits at clock 3; a sibling writes sib-9 at clock 9.
    {
      const mid = crypto.randomUUID();
      const store = new InMemoryEventStore();
      for (let c = 1; c <= 5; c++) {
        const e = ev(mid, `own-${c}`, c, "a");
        await store.append(e);
        await encPush(mid, K1, e);
      }
      await encPush(mid, KX, ev(mid, "poison-3", 3, "x"));
      await encPush(mid, K1, ev(mid, "sib-9", 9, "b"));
      await catchUp(mid, store, K1);
      obs["poisonWs: sib-9 held"] = (await plainHeld(store, mid)).includes("sib-9");
    }
    // rawThenEnc: own event at clock 5; an E2E sibling at clock 3. The raw
    // path (mobile syncNow / the CLI daemon's HTTP fallback) pulls first over
    // the SAME store, then the E2E socket catch-up.
    {
      const mid = crypto.randomUUID();
      const store = new InMemoryEventStore();
      const own = ev(mid, "own-5", 5, "a");
      await store.append(own);
      await encPush(mid, K1, own);
      await encPush(mid, K1, ev(mid, "sib", 3, "b"));
      const rawEngine = new se.SyncEngine(store, mid);
      rawEngine.connectRemote(http(mid));
      await rawEngine.sync();
      await catchUp(mid, store, K1);
      const heldList = await plainHeld(store, mid);
      obs["rawThenEnc"] = {
        sibHeld: heldList.some((h) => h.startsWith("sib")),
        sibPayloadEncrypted: heldList.includes("sib (ciphertext)"),
      };
    }
  } finally {
    g.WebSocket = realWs;
  }

  // The seq side channel: A writes, B writes seven, A writes again.
  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  await push(A, [ev(A, "a1", 1, "a")]);
  for (let i = 0; i < 7; i++) await push(B, [ev(B, `b${i}`, i, "b")]);
  await push(A, [ev(A, "a2", 2, "a")]);
  const r = await fetch(`${base}/sync/${A}/pull?after_seq=0`, { headers: AUTH_HEADER });
  const body = (await r.json()) as { events: Array<{ seq?: number }> };
  obs["seq gap: A's seqs around B's seven writes"] = body.events.map((e) => e.seq ?? null);
});
