/**
 * #914 push-side interleaving harness — the REAL relay (served, with its real
 * WebSocket route) and the REAL sync client (`@motebit/sync-engine`, loaded
 * from source), every ordering of a small action alphabet, across every DOOR
 * a surface pushes through. The #868 lesson: enumerate the doors before the
 * orderings.
 *
 * The defect (#914): the push cursor was the local max clock read AFTER the
 * pull, so an event appended during the pull, and every batch after the
 * first of a backlog, never left the device. And the socket door resolved an
 * append on send (or on queue), so no cursor could have waited for the relay.
 *
 * Doors (the remote a surface hands the SyncEngine):
 *   http-raw   HttpEventStoreAdapter — a surface without a sync key
 *   http-e2e   EncryptedEventStoreAdapter(Http, payloads "e2e") — the CLI,
 *              `motebit run`, mobile's syncNow
 *   ws-e2e     EncryptedEventStoreAdapter(live → WebSocketEventStoreAdapter,
 *              payloads "e2e") over a real socket — desktop, web, spatial
 *              (the `live` indirection is theirs verbatim); mobile holds the
 *              socket adapter directly, the same door without the wrapper
 *
 * Alphabet (a sequence of LENGTH actions):
 *   +   the device appends an event (`appendWithClock`, as the runtime does)
 *   S   one `SyncEngine.sync()`
 *   P   one sync during whose PULL the device appends an event (probe A)
 *   F   one sync whose push never reaches the relay: HTTP answers 503; on
 *       the socket the connection drops with the frame on the wire (no ack)
 *   R   restart: a new engine (a new socket adapter on the ws door, the old
 *       one dropped with whatever it held — a process death)
 *   X   crash between the relay's acknowledgment and the push-cursor write:
 *       the write throws, the sync fails, then a restart
 *   T   (ws door only) token refresh: the surfaces' adapter swap, the old
 *       adapter's queue handed to the new one (`takePendingEvents`)
 *
 * batch_size is 2, so three appends between syncs are a backlog larger than
 * a batch (probe B). The local store is a persistence (SQLite) store, which
 * keeps both cursors beside its events.
 *
 * Asserted per run, after ONE more plain sync: the relay holds
 * EVERY event the device appended, each exactly once, and nothing else; the
 * last sync is idle; on an e2e door every stored payload is an envelope.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import type { EventLogEntry } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { SyncRelay } from "../index.js";
import { generateKeypair, bytesToHex, mintAudienceToken } from "@motebit/crypto";
import { createTestRelay, API_TOKEN } from "./test-helpers.js";

// ── the real client, from source ────────────────────────────────────────────
interface CursorStore {
  getSyncSeqCursor(key: string): Promise<number | null>;
  setSyncSeqCursor(key: string, seq: number): Promise<void>;
}
interface SyncEngineLike {
  connectRemote(remote: EventStoreAdapter): void;
  sync(): Promise<{ pushed: number; pulled: number }>;
  getStatus(): string;
}
interface WsAdapterLike extends EventStoreAdapter {
  connect(): void;
  disconnect(): void;
  takePendingEvents(): EventLogEntry[];
  readonly isConnected: boolean;
}
interface SyncEngineModule {
  SyncEngine: new (
    local: EventStoreAdapter,
    motebitId: string,
    config?: { batch_size?: number; seqCursorStore?: CursorStore },
  ) => SyncEngineLike;
  HttpEventStoreAdapter: new (cfg: {
    baseUrl: string;
    motebitId: string;
    authToken?: string;
    maxRetries?: number;
    payloads?: "raw" | "e2e";
  }) => EventStoreAdapter;
  EncryptedEventStoreAdapter: new (cfg: {
    inner: EventStoreAdapter;
    key: Uint8Array;
  }) => EventStoreAdapter;
  WebSocketEventStoreAdapter: new (cfg: {
    url: string;
    motebitId: string;
    authToken?: string;
    payloads?: "raw" | "e2e";
    pushAckTimeoutMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
  }) => WsAdapterLike;
}
const SYNC_ENGINE_SRC = fileURLToPath(
  new URL("../../../../packages/sync-engine/src/index.ts", import.meta.url),
);
let se: SyncEngineModule;

const BASE = "http://relay.zz914.test";
const KEY = new Uint8Array(32).fill(14);
let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let port: number;
/** Per identity: a hook run when a pull request for it reaches the relay. */
const onPull = new Map<string, () => Promise<void>>();
/** Identities whose next push never reaches the relay (HTTP: a 503; socket: the connection drops with the frame). */
const dropNextPush = new Set<string>();
/** How often each disturbance actually fired — a letter that never bites proves nothing. */
const fired = { pull: 0, drop: 0, crash: 0, handoff: 0 };

/**
 * The real `ws` client, except that a push frame for an identity in
 * `dropNextPush` is never delivered: the connection drops with it on the wire.
 */
/** Relay refusals for rate, per identity — a push over the limit is dropped by the relay. */
const rateLimited = new Map<string, number>();

class DroppingWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    const mid = /\/ws\/sync\/([^/?]+)/.exec(String(args[0]))?.[1] ?? "";
    this.on("message", (d: Buffer) => {
      if (d.toString("utf8").includes("Rate limit exceeded")) {
        rateLimited.set(mid, (rateLimited.get(mid) ?? 0) + 1);
      }
    });
  }
  send(data: unknown, ...rest: unknown[]): void {
    const mid = /\/ws\/sync\/([^/?]+)/.exec(this.url)?.[1] ?? "";
    if (dropNextPush.has(mid) && typeof data === "string" && data.startsWith('{"type":"push"')) {
      dropNextPush.delete(mid);
      fired.drop++;
      this.terminate();
      return;
    }
    (super.send as (...a: unknown[]) => void)(data, ...rest);
  }
}

beforeAll(async () => {
  se = (await import(/* @vite-ignore */ SYNC_ENGINE_SRC)) as SyncEngineModule;
  relay = await createTestRelay({ enableDeviceAuth: true });
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => {
    if (server.listening) r();
    else server.once("listening", () => r());
  });
  port = (server.address() as AddressInfo).port;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const mid = url.pathname.split("/")[2] ?? "";
    const hook = onPull.get(mid);
    if (hook && url.pathname.endsWith("/pull")) {
      onPull.delete(mid);
      fired.pull++;
      await hook();
    }
    if (dropNextPush.has(mid) && url.pathname.endsWith("/push")) {
      dropNextPush.delete(mid);
      fired.drop++;
      return new Response("unavailable", { status: 503 });
    }
    return relay.app.request(url.pathname + url.search, init);
  });
  vi.stubGlobal("WebSocket", DroppingWebSocket);
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
}, 60_000);

async function until(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

// ── one device, one door ───────────────────────────────────────────────────
type Door = "http-raw" | "http-e2e" | "ws-e2e";
const BATCH = 2;

class Device {
  readonly db: MotebitDatabase = createMotebitDatabase(":memory:");
  own: string[] = [];
  engine!: SyncEngineLike;
  private ws: WsAdapterLike | null = null;
  /** The surfaces' indirection: whichever socket adapter is current. */
  private liveWs: EventStoreAdapter;
  private crashNextPushCursorWrite = false;
  /** The cursor store the engine is given: the local store, with a crash switch. */
  private cursors: CursorStore;

  /** Lose the persisted push cursor on the next read (a wiped or never-migrated store). */
  forgetPushCursor = false;

  constructor(
    readonly door: Door,
    readonly mid: string = crypto.randomUUID(),
    private readonly token: string = API_TOKEN,
    private readonly pushAckTimeoutMs = 1_000,
    private readonly batchSize = BATCH,
  ) {
    const store = this.db.eventStore as unknown as CursorStore;
    this.cursors = {
      getSyncSeqCursor: (k) =>
        this.forgetPushCursor && k.startsWith("push:")
          ? Promise.resolve(null)
          : store.getSyncSeqCursor(k),
      setSyncSeqCursor: (k, v) => {
        if (this.crashNextPushCursorWrite && k.startsWith("push:")) {
          this.crashNextPushCursorWrite = false;
          fired.crash++;
          return Promise.reject(new Error("the process died before the cursor write"));
        }
        return store.setSyncSeqCursor(k, v);
      },
    };
    this.liveWs = {
      append: (e) => this.ws!.append(e),
      query: (f) => {
        // The socket door's engine pull is this query (a no-op read): the
        // probe-A hook fires here, while the sync awaits it.
        const hook = onPull.get(this.mid);
        onPull.delete(this.mid);
        if (hook) fired.pull++;
        return (hook ? hook() : Promise.resolve()).then(() => this.ws!.query(f));
      },
      getLatestClock: (id) => this.ws!.getLatestClock(id),
      tombstone: (id, m) => this.ws!.tombstone(id, m),
    };
  }

  private socket(): WsAdapterLike {
    return new se.WebSocketEventStoreAdapter({
      url: `ws://127.0.0.1:${port}/ws/sync/${this.mid}`,
      motebitId: this.mid,
      authToken: this.token,
      payloads: "e2e",
      pushAckTimeoutMs: this.pushAckTimeoutMs,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
    });
  }

  async boot(): Promise<void> {
    this.engine = new se.SyncEngine(this.db.eventStore, this.mid, {
      batch_size: this.batchSize,
      seqCursorStore: this.cursors,
    });
    if (this.door === "ws-e2e") {
      this.ws?.disconnect(); // a process death: nothing is handed on
      this.ws = this.socket();
      this.ws.connect();
      this.engine.connectRemote(
        new se.EncryptedEventStoreAdapter({ inner: this.liveWs, key: KEY }),
      );
      await until(() => this.ws!.isConnected, "socket connected");
      return;
    }
    const http = new se.HttpEventStoreAdapter({
      baseUrl: BASE,
      motebitId: this.mid,
      authToken: this.token,
      maxRetries: 0,
      payloads: this.door === "http-e2e" ? "e2e" : "raw",
    });
    this.engine.connectRemote(
      this.door === "http-e2e"
        ? new se.EncryptedEventStoreAdapter({ inner: http, key: KEY })
        : http,
    );
  }

  /** The surfaces' token refresh: retire the socket, hand its queue on, swap. */
  async refreshToken(): Promise<void> {
    const replaced = this.ws!;
    replaced.disconnect();
    const fresh = this.socket();
    const handed = replaced.takePendingEvents();
    fired.handoff += handed.length;
    for (const queued of handed) void fresh.append(queued);
    this.ws = fresh;
    fresh.connect();
    await until(() => fresh.isConnected, "refreshed socket connected");
  }

  async append(): Promise<void> {
    // `event_id` is the relay's GLOBAL primary key, so it carries the run's identity.
    const id = `e${this.own.length + 1}-${this.mid}`;
    this.own.push(id);
    await this.db.eventStore.appendWithClock({
      event_id: id,
      motebit_id: this.mid as EventLogEntry["motebit_id"],
      timestamp: 1_700_000_000_000 + this.own.length,
      event_type: "state_snapshot" as EventLogEntry["event_type"],
      payload: { n: this.own.length },
      tombstoned: false,
    });
  }

  async sync(): Promise<string> {
    if (this.ws) await until(() => this.ws!.isConnected, "socket connected");
    await this.engine.sync();
    return this.engine.getStatus();
  }

  async syncWithAppendDuringPull(): Promise<void> {
    onPull.set(this.mid, () => this.append());
    await this.sync();
    onPull.delete(this.mid);
  }

  async syncWithPushLost(): Promise<void> {
    dropNextPush.add(this.mid);
    await this.sync();
    dropNextPush.delete(this.mid); // nothing to push: the drop is not carried over
  }

  async crashAfterAck(): Promise<void> {
    this.crashNextPushCursorWrite = true;
    await this.sync();
    this.crashNextPushCursorWrite = false;
    await this.boot();
  }

  relayRows(): Array<{ event_id: string; payload: string }> {
    return relay.moteDb.db
      .prepare("SELECT event_id, payload FROM events WHERE motebit_id = ? ORDER BY event_id")
      .all(this.mid) as Array<{ event_id: string; payload: string }>;
  }

  close(): void {
    this.ws?.disconnect();
    this.db.close();
  }
}

type Letter = "+" | "S" | "P" | "F" | "R" | "X" | "T";
/**
 * One plain sync must deliver everything: a run appends at most LENGTH events,
 * far below MAX_PUSH_BATCHES_PER_SYNC × batch_size, so a correct client
 * drains the whole backlog in the next sync. (A client that pushes one batch
 * per sync would need more — and is caught here.)
 */
const FINAL_ROUNDS = 1;

function sequences(letters: Letter[], n: number): Letter[][] {
  let out: Letter[][] = [[]];
  for (let i = 0; i < n; i++) out = out.flatMap((s) => letters.map((l) => [...s, l]));
  return out;
}

async function run(door: Door, seq: Letter[]): Promise<{ ok: boolean; why?: string }> {
  const dev = new Device(door);
  try {
    await dev.boot();
    for (const l of seq) {
      if (l === "+") await dev.append();
      else if (l === "S") await dev.sync();
      else if (l === "P") await dev.syncWithAppendDuringPull();
      else if (l === "F") await dev.syncWithPushLost();
      else if (l === "R") await dev.boot();
      else if (l === "X") await dev.crashAfterAck();
      else await dev.refreshToken();
    }
    let status = "";
    for (let round = 0; round < FINAL_ROUNDS; round++) status = await dev.sync();
    if (status !== "idle") return { ok: false, why: `last sync ${status}` };

    const rows = dev.relayRows();
    const held = rows.map((r) => r.event_id);
    const own = [...dev.own].sort();
    if (JSON.stringify(held) !== JSON.stringify(own)) {
      return { ok: false, why: `relay holds [${held.join(",")}] ≠ appended [${own.join(",")}]` };
    }
    if (door !== "http-raw") {
      const plain = rows.filter((r) => !r.payload.includes('"_encrypted":true'));
      if (plain.length > 0)
        return { ok: false, why: `${plain.length} plaintext payload(s) stored` };
    }
    return { ok: true };
  } finally {
    dev.close();
  }
}

describe("#914 push interleaving matrix: real relay × real SyncEngine × every door", () => {
  const HTTP_LEN = Number(process.env.ZZ914_LEN ?? 4);
  const WS_LEN = Number(process.env.ZZ914_WS_LEN ?? 4);
  const MATRIX: Array<{ door: Door; letters: Letter[]; len: number }> = [
    { door: "http-raw", letters: ["+", "S", "P", "F", "R", "X"], len: HTTP_LEN },
    { door: "http-e2e", letters: ["+", "S", "P", "F", "R", "X"], len: HTTP_LEN },
    { door: "ws-e2e", letters: ["+", "S", "P", "F", "R", "X", "T"], len: WS_LEN },
  ];

  for (const { door, letters, len } of MATRIX) {
    const all = sequences(letters, len);
    it(`${door}: all ${all.length} orderings of length ${len} deliver every event exactly once`, async () => {
      const failures: string[] = [];
      const before = { ...fired };
      for (const seq of all) {
        const r = await run(door, seq);
        if (!r.ok) failures.push(`${seq.join(" ")}: ${r.why}`);
      }
      expect(failures.slice(0, 5), `${failures.length} failing orderings`).toEqual([]);
      // Every disturbance bit at least once on this door.
      expect(fired.pull - before.pull, "probe-A appends during a pull").toBeGreaterThan(0);
      expect(fired.drop - before.drop, "pushes lost on the wire").toBeGreaterThan(0);
      expect(fired.crash - before.crash, "crashes before the cursor write").toBeGreaterThan(0);
    }, 600_000);
  }

  it("the orderings include both issue probes and the crash window", () => {
    const joined = sequences(["+", "S", "P", "F", "R", "X"], HTTP_LEN).map((s) => s.join(""));
    expect(joined).toContain("+PSS"); // probe A: appended during the pull
    expect(joined).toContain("+++R"); // probe B: a backlog > batch_size, then a restart
    expect(joined).toContain("++XS"); // acknowledged, cursor never written
    expect(joined).toContain("++FS"); // pushed, never acknowledged
  });
});

describe("#914 a re-push is harmless — under E2E envelopes and #846 identity binding", () => {
  /** A real identity with its own signed `sync` token (never the master token). */
  async function signedIdentity(device: string): Promise<{ id: string; tok: string }> {
    const kp = await generateKeypair();
    const id = crypto.randomUUID();
    const res = await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: id,
        device_id: device,
        public_key: bytesToHex(kp.publicKey),
      }),
    });
    expect(res.status).toBeLessThan(300);
    const tok = (await mintAudienceToken({ mid: id, did: device, aud: "sync" }, kp.privateKey))
      .token;
    return { id, tok };
  }

  for (const door of ["http-e2e", "ws-e2e"] as const) {
    it(`${door}: every event pushed twice (the cursor lost) is stored once, first write kept, no refusal`, async () => {
      const who = await signedIdentity(`dev-${door}`);
      const dev = new Device(door, who.id, who.tok);
      try {
        await dev.boot();
        for (let i = 0; i < 3; i++) await dev.append();
        expect(await dev.sync()).toBe("idle");
        const first = dev.relayRows();
        expect(first.map((r) => r.event_id)).toEqual([...dev.own].sort());

        // The push cursor is lost: the whole log goes out again — fresh
        // ciphertext under the same event_ids, bound to the same identity.
        dev.forgetPushCursor = true;
        await dev.boot();
        expect(await dev.sync()).toBe("idle");
        dev.forgetPushCursor = false;

        const again = dev.relayRows();
        expect(again).toEqual(first); // one row each; the first write kept byte for byte
        const refusals = relay.moteDb.db
          .prepare(
            "SELECT COUNT(*) AS n FROM relay_auth_events WHERE motebit_id = ? AND kind <> 'master_token'",
          )
          .get(who.id) as { n: number };
        expect(refusals.n).toBe(0);
      } finally {
        dev.close();
      }
    });
  }
});

describe("#914 round 2: a first-sync backlog over the socket stays under the relay's rate limit", () => {
  it("5000 events: one sync, no 'Rate limit exceeded', idle, all held once", async () => {
    // Production settings: the default batch_size (100) and ack deadline (15 s).
    const dev = new Device("ws-e2e", crypto.randomUUID(), API_TOKEN, 15_000, 100);
    try {
      await dev.boot();
      for (let i = 0; i < 5000; i++) await dev.append();
      const status = await dev.sync();
      expect(rateLimited.get(dev.mid) ?? 0).toBe(0);
      expect(status).toBe("idle");
      const held = dev.relayRows().map((r) => r.event_id);
      expect(held).toHaveLength(5000);
      expect(held).toEqual([...dev.own].sort());
    } finally {
      dev.close();
    }
  }, 120_000);
});

describe("#914 round 7: the relay echoes a push frame's `push_id` in its ack (additive)", () => {
  async function rawSocket(mid: string): Promise<{ ws: WebSocket; recv: string[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync/${mid}?token=${API_TOKEN}`);
    const recv: string[] = [];
    ws.on("message", (d: Buffer) => recv.push(d.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return { ws, recv };
  }
  function event(mid: string, n: number): EventLogEntry {
    return {
      event_id: `echo${n}-${mid}`,
      motebit_id: mid as EventLogEntry["motebit_id"],
      timestamp: 1_700_000_000_000 + n,
      event_type: "state_snapshot" as EventLogEntry["event_type"],
      payload: { n },
      version_clock: n,
      tombstoned: false,
    };
  }

  it("a frame naming itself gets its id back; a frame without one gets the unchanged ack", async () => {
    const mid = crypto.randomUUID();
    const { ws, recv } = await rawSocket(mid);
    try {
      const acks = (): Array<Record<string, unknown>> =>
        recv.map((m) => JSON.parse(m) as Record<string, unknown>).filter((m) => m.type === "ack");
      ws.send(JSON.stringify({ type: "push", push_id: "f1", events: [event(mid, 1)] }));
      await until(() => acks().length === 1, "ack for f1");
      ws.send(JSON.stringify({ type: "push", events: [event(mid, 2)] }));
      await until(() => acks().length === 2, "ack for the unnamed frame");
      ws.send(JSON.stringify({ type: "push", push_id: 7, events: [event(mid, 3)] }));
      await until(() => acks().length === 3, "ack for a non-string id");
      // The signed `hold_receipt` rides beside every ack (sync-hold-receipt.ts,
      // additive); every field a shipped client reads is unchanged.
      const all = acks();
      expect(all.every((a) => typeof a.hold_receipt === "object")).toBe(true);
      expect(all.map(({ hold_receipt: _r, ...rest }) => rest)).toEqual([
        { type: "ack", accepted: 1, push_id: "f1" },
        { type: "ack", accepted: 1 },
        { type: "ack", accepted: 1 },
      ]);
    } finally {
      ws.terminate();
    }
  });
});
