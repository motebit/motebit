/**
 * #914 round 5.
 *
 *   1. A bound must never make progress impossible where an unbounded request
 *      made it. On React Native, fetch (whatwg-fetch over XHR) resolves only
 *      when the WHOLE response has arrived, so the first-byte deadline bounds
 *      the total transfer. A pull halves its page down to one event, and at
 *      one event a timeout stretches the deadline instead — so a slow link
 *      still pulls everything.
 *   2. The surfaces' socket indirection forwards wire activity to the stall
 *      watchdog, structurally (`liveAdapter`).
 *   3. The frame size grows back after the link recovers; the linger's cap
 *      sends a frame even while appends keep arriving.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  SyncEngine,
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  liveAdapter,
} from "../index.js";
import { FakeRelay } from "./fake-relay.js";

const MID = "motebit-zz914-r5";

function entry(id: string, clock: number): EventLogEntry {
  return {
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: 1_700_000_000_000 + clock,
    event_type: EventType.StateUpdated,
    payload: { id },
    version_clock: clock,
    tombstoned: false,
  };
}

// ---------------------------------------------------------------------------
// 1. React Native: whatwg-fetch over an XHR that delivers only at onload
// ---------------------------------------------------------------------------

interface WhatwgFetch {
  fetch: typeof fetch;
  Response: typeof Response;
  Headers: typeof Headers;
}
function loadWhatwgFetch(): WhatwgFetch {
  const fromMobile = createRequire(
    new URL("../../../../apps/mobile/package.json", import.meta.url),
  );
  const fromRn = createRequire(fromMobile.resolve("react-native/package.json"));
  return fromRn("whatwg-fetch") as WhatwgFetch;
}
const W = loadWhatwgFetch();
const NativeResponse = globalThis.Response;

/**
 * An XHR on a slow link: the relay's answer arrives whole, `msPerEvent` per
 * event it carries, and only then does `onload` fire — exactly as React
 * Native's networking delivers to whatwg-fetch.
 */
function slowXhr(relay: FakeRelay, msPerEvent: number, pushMs = 0): unknown {
  return class SlowXhr {
    status = 0;
    statusText = "";
    responseText = "";
    responseURL = "";
    readyState = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    onreadystatechange: (() => void) | null = null;
    withCredentials = false;
    private method = "GET";
    private url = "";
    private headers: Record<string, string> = {};
    private timer: ReturnType<typeof setTimeout> | null = null;
    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }
    getAllResponseHeaders(): string {
      return "content-type: application/json\r\n";
    }
    send(body: string | null): void {
      globalThis.Response = NativeResponse;
      const pending = relay.fetch(this.url, {
        method: this.method,
        headers: this.headers,
        ...(body !== null ? { body } : {}),
      });
      globalThis.Response = W.Response;
      void pending.then(async (res) => {
        const text = await res.text();
        const events = (JSON.parse(text) as { events?: unknown[] }).events?.length ?? 0;
        this.timer = setTimeout(
          () => {
            this.status = res.status;
            this.statusText = res.statusText;
            this.responseText = text;
            this.responseURL = this.url;
            this.readyState = 4;
            this.onreadystatechange?.();
            this.onload?.();
          },
          1 + msPerEvent * events + (this.url.endsWith("/push") ? pushMs : 0),
        );
      });
    }
    abort(): void {
      if (this.timer) clearTimeout(this.timer);
      this.readyState = 4;
      this.onreadystatechange?.();
      this.onabort?.();
    }
  };
}

describe("#914 r5: React Native slow link — every pull still completes", () => {
  let relay: FakeRelay;
  function onRn(n: number, msPerEvent: number, pushMs = 0): void {
    relay = new FakeRelay();
    for (let i = 1; i <= n; i++) relay.ingest(entry(`p${i}`, i));
    vi.stubGlobal("Response", W.Response);
    vi.stubGlobal("Headers", W.Headers);
    vi.stubGlobal("XMLHttpRequest", slowXhr(relay, msPerEvent, pushMs));
    vi.stubGlobal("fetch", W.fetch);
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function pullAll(n: number, requestTimeoutMs: number, maxSyncs: number): Promise<number> {
    const engine = new SyncEngine(new InMemoryEventStore(), MID);
    engine.connectRemote(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        maxRetries: 0,
        requestTimeoutMs,
      }),
    );
    let pulled = 0;
    for (let s = 0; s < maxSyncs && pulled < n; s++) pulled += (await engine.sync()).pulled;
    return pulled;
  }

  it("the reviewer's cell (1000 ms/event against 20 s, scaled 1:100): all 60 pulled", async () => {
    onRn(60, 10);
    expect(await pullAll(60, 200, 3)).toBe(60);
  });

  it("a link where 25 events can never cross but one can: the page shrinks to one event, all pulled in one sync", async () => {
    onRn(20, 30); // 30 ms/event against a 40 ms deadline
    expect(await pullAll(20, 40, 1)).toBe(20);
  });

  it("a push whose round trip exceeds the deadline: the next push's deadline stretches, and it goes through", async () => {
    onRn(0, 0, 60); // a push takes 60 ms against a 40 ms deadline
    const local = new InMemoryEventStore();
    await local.appendWithClock({
      event_id: "slow-push",
      motebit_id: MID as EventLogEntry["motebit_id"],
      timestamp: 0,
      event_type: EventType.StateUpdated,
      payload: {},
      tombstoned: false,
    });
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        maxRetries: 0,
        requestTimeoutMs: 40,
      }),
    );
    for (let s = 0; s < 3 && engine.getCursor().last_version_clock < 1; s++) await engine.sync();
    expect(relay.heldIds(MID)).toEqual(["slow-push"]);
    expect(engine.getCursor().last_version_clock).toBe(1);
  });

  it("a link where even ONE event cannot cross in the deadline: the deadline stretches, all pulled in one sync", async () => {
    onRn(3, 60); // 60 ms/event against a 40 ms deadline
    expect(await pullAll(3, 40, 1)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. The surfaces' socket indirection forwards wire activity
// ---------------------------------------------------------------------------

describe("#914 r5: liveAdapter forwards to the current adapter, activity included", () => {
  function reporter(): EventStoreAdapter & { onActivity(l: () => void): () => void; fire(): void } {
    const ls = new Set<() => void>();
    return {
      append: () => Promise.resolve(),
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: () => Promise.resolve(),
      onActivity: (l) => {
        ls.add(l);
        return () => ls.delete(l);
      },
      fire: () => {
        for (const l of ls) l();
      },
    };
  }

  it("activity of the current adapter reaches the listener, and follows a swap", async () => {
    const a = reporter();
    const b = reporter();
    let current: EventStoreAdapter = a;
    const live = liveAdapter(() => current);
    let seen = 0;
    live.onActivity(() => seen++);
    a.fire();
    expect(seen).toBe(1);
    current = b; // a token refresh swaps the socket adapter
    await live.append(entry("x", 1)); // the next call notices the swap
    a.fire();
    b.fire();
    expect(seen).toBe(2); // the retired adapter is no longer heard
  });

  it("the engine's watchdog sees a slow push through liveAdapter as progress", async () => {
    const local = new InMemoryEventStore();
    for (let i = 0; i < 6; i++) {
      await local.appendWithClock({
        event_id: `lv${i}`,
        motebit_id: MID as EventLogEntry["motebit_id"],
        timestamp: 0,
        event_type: EventType.StateUpdated,
        payload: {},
        tombstoned: false,
      });
    }
    // One slow frame for all six (a socket halving on a slow link): the
    // appends settle only at the end, and only wire activity shows life.
    const r = reporter();
    let release!: () => void;
    const done = new Promise<void>((res) => (release = res));
    r.append = () => done;
    const live = liveAdapter(() => r);
    const engine = new SyncEngine(local, MID, { stall_timeout_ms: 100 });
    engine.connectRemote(live);
    const syncing = engine.sync();
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 40));
      r.fire();
    }
    release();
    const result = await syncing;
    expect(engine.getStatus()).toBe("idle");
    expect(result.pushed).toBe(6);
  });

  it("desktop, web and spatial build their socket indirection with liveAdapter (never a hand-built object)", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    for (const f of [
      "apps/desktop/src/sync-controller.ts",
      "apps/web/src/web-app.ts",
      "apps/spatial/src/sync-controller.ts",
    ]) {
      const src = readFileSync(root + f, "utf8");
      expect(src, f).toMatch(/liveAdapter\(\s*\(\)\s*=>\s*currentWs\s*\)/);
      expect(src, f).not.toMatch(/append:\s*\(e\)\s*=>\s*currentWs\.append\(e\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Frame regrowth; the linger's cap
// ---------------------------------------------------------------------------

class TunableLink {
  static all: TunableLink[] = [];
  static msPerEvent = 3;
  static busyUntil = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  frames: number[] = [];
  sentAt: number[] = [];
  constructor(public url: string) {
    TunableLink.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string; events?: unknown[] };
    if (msg.type !== "push") return;
    const n = msg.events?.length ?? 0;
    this.frames.push(n);
    this.sentAt.push(Date.now());
    const start = Math.max(Date.now(), TunableLink.busyUntil);
    TunableLink.busyUntil = start + TunableLink.msPerEvent * n;
    setTimeout(
      () => {
        if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ type: "ack" }) });
      },
      TunableLink.busyUntil - Date.now() + 1,
    );
  }
  close(): void {
    this.readyState = 3;
  }
}

describe("#914 r5: socket frame size and linger cap", () => {
  let original: typeof globalThis.WebSocket;
  beforeEach(() => {
    vi.useFakeTimers();
    TunableLink.all = [];
    TunableLink.msPerEvent = 3;
    TunableLink.busyUntil = 0;
    original = globalThis.WebSocket;
    globalThis.WebSocket = TunableLink as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = original;
    vi.useRealTimers();
  });

  it("after a slow spell halves the frame, a fast link grows it back to full batches", async () => {
    const ws = new WebSocketEventStoreAdapter({
      url: "ws://r/ws/sync/regrow",
      motebitId: MID,
      pushAckTimeoutMs: 200,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    ws.connect();
    await vi.advanceTimersByTimeAsync(1);
    const push = async (from: number, n: number): Promise<void> => {
      const acks = Array.from({ length: n }, (_, i) => ws.append(entry(`g${from + i}`, from + i)));
      let settled = false;
      void Promise.allSettled(acks).then(() => (settled = true));
      for (let i = 0; i < 4_000 && !settled; i++) await vi.advanceTimersByTimeAsync(5);
    };
    await push(0, 100); // 3 ms/event: a 100-event frame misses the 200 ms deadline — halved
    TunableLink.msPerEvent = 0; // the link recovers
    for (let b = 0; b < 12; b++) await push(1_000 + b * 100, 100);
    const all = TunableLink.all.flatMap((s) => s.frames);
    expect(Math.min(...all.slice(0, 3))).toBeLessThan(100); // it did halve
    expect(all[all.length - 1]).toBe(100); // …and grew back to whole batches
    ws.disconnect();
  });

  it("appends that never pause still go out: the linger's cap sends a frame within ~100 ms", async () => {
    TunableLink.msPerEvent = 0;
    const ws = new WebSocketEventStoreAdapter({ url: "ws://r/ws/sync/cap", motebitId: MID });
    ws.connect();
    await vi.advanceTimersByTimeAsync(1);
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) {
      void ws.append(entry(`c${i}`, i + 1)).catch(() => {});
      await vi.advanceTimersByTimeAsync(10); // always inside the 15 ms idle linger
    }
    const firstFrameAt = TunableLink.all[0]!.sentAt[0];
    expect(firstFrameAt).toBeDefined();
    expect(firstFrameAt! - t0).toBeLessThanOrEqual(110);
    ws.disconnect();
  });
});
