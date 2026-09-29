/**
 * A simulated device network for the #914 liveness harness (fake timers).
 *
 *   - One UPLINK and one DOWNLINK per device: FIFO, one transmission at a
 *     time, `u` ms per event carried (control frames and empty bodies cost
 *     nothing but still queue). A transmission cancelled before it finishes
 *     (its socket closed, its request aborted) is lost and frees the link.
 *   - One RELAY: it stores an event the moment the bytes carrying it arrive
 *     (dedup by event_id, a per-identity seq), and answers after `L` ms — a
 *     push ack / a push response / a pull response's headers. It keeps the
 *     real relay's socket rate limit: 100 inbound messages per 10 s per
 *     device, the excess answered `Rate limit exceeded` and dropped.
 *   - A fake WebSocket and a fake fetch (Node flavour: a streamed body, a
 *     chunk per event as the downlink delivers it) or React Native flavour
 *     (whatwg-fetch over an XHR that delivers at onload, with react-native's
 *     `abort-controller@3.0.0`).
 *
 * The same network carries the branch's real client and the model of main's
 * client, so each cell compares them under identical conditions.
 */
import { createRequire } from "node:module";
import { vi } from "vitest";
import type { EventLogEntry } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface Tx {
  cost: number;
  done: () => void;
  cancelled: boolean;
  link: Link;
}

/** A FIFO link: one transmission at a time. */
export class Link {
  private queue: Tx[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private head: Tx | null = null;

  send(cost: number, done: () => void): Tx {
    const tx: Tx = { cost, done, cancelled: false, link: this };
    this.queue.push(tx);
    this.pump();
    return tx;
  }

  cancel(tx: Tx): void {
    if (tx.cancelled) return;
    tx.cancelled = true;
    if (tx === this.head) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.head = null;
      this.pump();
    } else {
      const i = this.queue.indexOf(tx);
      if (i >= 0) this.queue.splice(i, 1);
    }
  }

  private pump(): void {
    if (this.head) return;
    const next = this.queue.shift();
    if (!next) return;
    this.head = next;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.head = null;
        if (!next.cancelled) next.done();
        this.pump();
      },
      Math.max(0, next.cost),
    );
  }
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

export class SimRelay {
  readonly rows: Array<{ seq: number; event: EventLogEntry }> = [];
  private ids = new Set<string>();
  private rate = new Map<string, number[]>();
  rateRefusals = 0;
  /**
   * The relay fault model (#914 round 8). `echoes`: whether acks echo
   * `push_id` (false = a relay older than round 7). `dropFrame(n)`: the n-th
   * socket push frame this relay receives (1-based) is silently discarded —
   * not stored, never answered.
   */
  echoes = true;
  dropFrame: ((n: number) => boolean) | null = null;
  /** Told each time the relay drops a frame (a harness schedules an adapter swap from it). */
  onDrop: (() => void) | null = null;
  pushFramesSeen = 0;

  constructor(
    readonly mid: string,
    /** Response latency: push ack, push response, pull response headers (ms). */
    readonly latencyMs: number,
  ) {}

  store(events: readonly EventLogEntry[]): void {
    for (const e of events) {
      if (this.ids.has(e.event_id)) continue;
      this.ids.add(e.event_id);
      this.rows.push({ seq: this.rows.length + 1, event: e });
    }
  }

  holds(id: string): boolean {
    return this.ids.has(id);
  }

  /** The real relay's socket limiter: 100 inbound messages per 10 s per device. */
  admit(deviceKey: string): boolean {
    const now = Date.now();
    const recent = (this.rate.get(deviceKey) ?? []).filter((t) => now - t < 10_000);
    if (recent.length >= 100) {
      this.rate.set(deviceKey, recent);
      this.rateRefusals++;
      return false;
    }
    recent.push(now);
    this.rate.set(deviceKey, recent);
    return true;
  }

  page(
    afterSeq: number,
    limit: number,
  ): { events: Array<EventLogEntry & { seq: number }>; body: unknown } {
    const after = this.rows.filter((r) => r.seq > afterSeq);
    const page = after.slice(0, Math.min(limit, 1000));
    const events = page.map((r) => ({ ...r.event, seq: r.seq }));
    return {
      events,
      body: {
        motebit_id: this.mid,
        events,
        after_seq: afterSeq,
        next_seq: page.length > 0 ? page[page.length - 1]!.seq : afterSeq,
        has_more: after.length > page.length,
        latest_seq: this.rows.length,
      },
    };
  }

  latestClock(): number {
    return Math.max(0, ...this.rows.map((r) => r.event.version_clock));
  }
}

// ---------------------------------------------------------------------------
// A device's network: links + fake WebSocket + fake fetch
// ---------------------------------------------------------------------------

export interface NetConfig {
  /** Uplink ms per event. */
  upMs: number;
  /** Downlink ms per event. */
  downMs: number;
}

/** The platform Response, captured before a React Native cell stubs the global. */
const NativeResponse = globalThis.Response;

const REPLY_MS = 20; // small control replies (auth, rate refusal, socket open)

export class SimNet {
  readonly up = new Link();
  readonly down = new Link();
  sockets: SimSocket[] = [];
  /**
   * Per event, the socket push frames carrying it that are on the wire and
   * not yet answered (acked, refused, or lost with a closed socket).
   */
  readonly framesInFlight = new Map<string, number>();
  /** Socket push frames that carried an event already in flight in another frame (#914 r7). */
  resentInFlight = 0;
  /**
   * An outage: until this time, every HTTP request is BLACK-HOLED — accepted
   * and never answered (a dead connection), ended only by its own abort.
   */
  blackholeUntil = 0;
  /** Per event, the HTTP push requests carrying it that are on the wire; `hung` if black-holed. */
  private readonly httpPushes = new Map<string, Array<{ hung: boolean }>>();
  /** HTTP pushes that re-sent an event while a request carrying it was on the wire and NOT black-holed. */
  httpResentLive = 0;
  /** HTTP pushes that re-sent an event while its only requests on the wire were black-holed (the exception). */
  httpResentHung = 0;

  private httpPushOut(ids: readonly string[], hung: boolean): () => void {
    const mine = { hung };
    for (const id of ids) {
      const on = this.httpPushes.get(id) ?? [];
      if (on.some((r) => !r.hung)) this.httpResentLive++;
      else if (on.length > 0) this.httpResentHung++;
      on.push(mine);
      this.httpPushes.set(id, on);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const id of ids) {
        const on = (this.httpPushes.get(id) ?? []).filter((r) => r !== mine);
        if (on.length > 0) this.httpPushes.set(id, on);
        else this.httpPushes.delete(id);
      }
    };
  }

  frameOut(ids: readonly string[]): void {
    for (const id of ids) {
      const n = this.framesInFlight.get(id) ?? 0;
      if (n > 0) this.resentInFlight++;
      this.framesInFlight.set(id, n + 1);
    }
  }

  frameAnswered(ids: readonly string[]): void {
    for (const id of ids) {
      const n = (this.framesInFlight.get(id) ?? 1) - 1;
      if (n > 0) this.framesInFlight.set(id, n);
      else this.framesInFlight.delete(id);
    }
  }

  constructor(
    readonly relay: SimRelay,
    readonly cfg: NetConfig,
  ) {}

  /** Further relays on this network, by URL host (a relay switch, #914 round 8). */
  readonly hosts = new Map<string, SimRelay>();

  /** The relay a URL reaches: by host, else the network's own. */
  relayFor(url: string): SimRelay {
    return this.hosts.get(new URL(url).host) ?? this.relay;
  }

  /** A relay restart: every open socket closed by the server (the client sees a close). */
  restart(): void {
    for (const sock of this.sockets) sock.serverClose();
  }

  /** Every `ms`, a sibling's event is fanned out to every open socket (inbound traffic). */
  inboundEvery(ms: number): () => void {
    let k = 0;
    const t = setInterval(() => {
      const e = {
        event_id: `inbound-${++k}`,
        motebit_id: this.relay.mid,
        device_id: "sibling",
        timestamp: Date.now(),
        event_type: "state_updated",
        payload: {},
        version_clock: 0,
        tombstoned: false,
      };
      for (const sock of this.sockets) sock.inbound({ type: "event", event: e });
    }, ms);
    return () => clearInterval(t);
  }

  /** A WebSocket class bound to this network (install as globalThis.WebSocket). */
  socketClass(): typeof WebSocket {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the class closes over its network
    const net = this;
    class S extends SimSocket {
      constructor(url: string) {
        super(net, url);
      }
    }
    return S as unknown as typeof WebSocket;
  }

  /** The Node-flavour fetch: streamed bodies, standard AbortSignal. */
  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const signal = init?.signal ?? undefined;
    const path = url.pathname;
    const tag = `${path.split("/").pop()}${url.search}`;
    const relay = this.relayFor(String(input));
    trace(`fetch ${tag} start`);
    return new Promise<Response>((resolve, reject) => {
      const abortError = (): Error => new DOMException("aborted", "AbortError");
      if (signal?.aborted) return reject(abortError());
      let dead = false;
      const pending: Tx[] = [];
      let bodyCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
      let replyTimer: ReturnType<typeof setTimeout> | null = null;
      const isPush = path.endsWith("/push") && init?.method === "POST";
      const hung = Date.now() < this.blackholeUntil;
      const pushDone = isPush
        ? this.httpPushOut(
            (JSON.parse(init.body as string) as { events: EventLogEntry[] }).events.map(
              (e) => e.event_id,
            ),
            hung,
          )
        : (): void => {};
      signal?.addEventListener("abort", () => {
        trace(`fetch ${tag} ABORT`);
        pushDone();
        dead = true;
        for (const tx of pending) tx.link.cancel(tx);
        if (replyTimer) clearTimeout(replyTimer);
        try {
          bodyCtl?.error(abortError());
        } catch {
          // already closed
        }
        reject(abortError());
      });
      const later = (ms: number, fn: () => void): void => {
        replyTimer = setTimeout(() => {
          if (!dead) fn();
        }, ms);
      };
      if (hung) return; // black-holed: never answered; only its abort ends it
      if (isPush) {
        const events = (JSON.parse(init.body as string) as { events: EventLogEntry[] }).events;
        pending.push(
          this.up.send(this.cfg.upMs * events.length, () => {
            relay.store(events);
            later(relay.latencyMs, () => {
              pushDone();
              resolve(NativeResponse.json({ motebit_id: relay.mid, accepted: events.length }));
            });
          }),
        );
        return;
      }
      if (path.endsWith("/clock")) {
        pending.push(
          this.up.send(0, () =>
            later(relay.latencyMs, () =>
              resolve(
                NativeResponse.json({
                  motebit_id: relay.mid,
                  latest_clock: relay.latestClock(),
                }),
              ),
            ),
          ),
        );
        return;
      }
      if (path.endsWith("/pull")) {
        const afterSeq = Number(url.searchParams.get("after_seq") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "1000");
        pending.push(
          this.up.send(0, () =>
            later(relay.latencyMs, () => {
              const { events, body } = relay.page(afterSeq, limit);
              const text = new TextEncoder().encode(JSON.stringify(body));
              // One chunk per event, each as the downlink delivers it.
              const n = Math.max(1, events.length);
              const size = Math.ceil(text.length / n);
              const stream = new ReadableStream<Uint8Array>({
                start: (ctl) => {
                  bodyCtl = ctl;
                  for (let i = 0; i < n; i++) {
                    const chunk = text.slice(i * size, (i + 1) * size);
                    pending.push(
                      this.down.send(events.length > 0 ? this.cfg.downMs : 0, () => {
                        if (dead) return;
                        ctl.enqueue(chunk);
                        if (i === n - 1) {
                          trace(`fetch ${tag} body done (${events.length})`);
                          ctl.close();
                        }
                      }),
                    );
                  }
                },
              });
              resolve(
                new NativeResponse(stream, {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              );
            }),
          ),
        );
        return;
      }
      resolve(new NativeResponse("not found", { status: 404 }));
    });
  };

  /**
   * The React Native flavour: whatwg-fetch over an XHR that delivers the
   * whole response at onload, and react-native's AbortController.
   */
  installReactNative(): void {
    const rn = reactNative();
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the XHR class closes over its network
    const net = this;
    class SimXhr {
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
      private ctl = new AbortController();
      open(method: string, url: string): void {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(): void {}
      getAllResponseHeaders(): string {
        return "content-type: application/json\r\n";
      }
      send(body: string | null): void {
        // Reuse the Node-flavour network, then deliver only at the end.
        void net
          .fetch(this.url, {
            method: this.method,
            ...(body !== null ? { body } : {}),
            signal: this.ctl.signal,
          })
          .then(async (res) => {
            const text = await res.text();
            this.status = res.status;
            this.responseText = text;
            this.responseURL = this.url;
            this.readyState = 4;
            this.onreadystatechange?.();
            this.onload?.();
          })
          .catch(() => {});
      }
      abort(): void {
        this.ctl.abort();
        this.readyState = 4;
        this.onreadystatechange?.();
        this.onabort?.();
      }
    }
    vi.stubGlobal("Response", rn.Response);
    vi.stubGlobal("Headers", rn.Headers);
    vi.stubGlobal("XMLHttpRequest", SimXhr);
    vi.stubGlobal("fetch", rn.fetch);
    vi.stubGlobal("AbortController", rn.AbortController);
  }
}

/** A socket on the simulated network. */
export class SimSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  private inflight: Tx[] = [];
  /** Push frames sent on this socket and not yet answered: their event ids. */
  private unanswered = new Set<string[]>();
  private deviceKey: string;
  private relay: SimRelay;

  constructor(
    private net: SimNet,
    public url: string,
  ) {
    net.sockets.push(this);
    this.relay = net.relayFor(url);
    this.deviceKey = new URL(url).searchParams.get("device_id") ?? `anon-${net.sockets.length}`;
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    }, REPLY_MS);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    const msg = JSON.parse(data) as { type: string; events?: EventLogEntry[]; push_id?: string };
    const events = msg.type === "push" ? (msg.events ?? []) : [];
    if (msg.type === "push")
      trace(`ws push ${msg.push_id ?? "-"} n=${events.length} sent [${events[0]?.event_id ?? ""}]`);
    const ids = events.map((e) => e.event_id);
    if (msg.type === "push") {
      this.net.frameOut(ids);
      this.unanswered.add(ids);
    }
    const answered = (): void => {
      if (msg.type === "push" && this.unanswered.delete(ids)) this.net.frameAnswered(ids);
    };
    const tx = this.net.up.send(this.net.cfg.upMs * events.length, () => {
      this.inflight.splice(this.inflight.indexOf(tx), 1);
      if (this.readyState !== 1) return;
      if (!this.relay.admit(this.deviceKey)) {
        answered();
        this.reply({ type: "error", message: "Rate limit exceeded" }, REPLY_MS);
        return;
      }
      if (msg.type === "auth") {
        this.reply({ type: "auth_result", ok: true }, REPLY_MS);
        return;
      }
      if (msg.type !== "push") return;
      if (this.relay.dropFrame?.(++this.relay.pushFramesSeen)) {
        // Silently discarded: never stored, never answered — no longer in flight.
        trace(`ws push ${msg.push_id ?? "-"} n=${events.length} DROPPED by the relay`);
        answered();
        this.relay.onDrop?.();
        return;
      }
      this.relay.store(events);
      trace(`ws push ${msg.push_id ?? "-"} n=${events.length} stored`);
      this.reply(
        {
          type: "ack",
          accepted: events.length,
          ...(msg.push_id !== undefined && this.relay.echoes ? { push_id: msg.push_id } : {}),
        },
        this.relay.latencyMs,
        answered,
      );
    });
    this.inflight.push(tx);
  }

  private reply(msg: unknown, ms: number, onDelivered?: () => void): void {
    setTimeout(() => {
      onDelivered?.();
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) });
    }, ms);
  }

  /** A message from the relay not answering anything (fan-out). */
  inbound(msg: unknown): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The relay closes the connection (a restart): the client sees `onclose`. */
  serverClose(): void {
    if (this.readyState === 3) return;
    this.close();
    this.onclose?.();
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    trace(`ws close (${this.inflight.length} unsent)`);
    // Frames not yet answered are lost with the connection: no longer in flight.
    for (const ids of this.unanswered) this.net.frameAnswered(ids);
    this.unanswered.clear();
    // Bytes not yet sent are lost with the connection.
    for (const tx of this.inflight.splice(0)) this.net.up.cancel(tx);
  }
}

interface ReactNativeFetch {
  fetch: typeof fetch;
  Response: typeof Response;
  Headers: typeof Headers;
  AbortController: typeof AbortController;
}

let rnCache: ReactNativeFetch | null = null;
/** MOTEBIT_LIVENESS_TRACE=1: a timeline of the simulated wire, for debugging one cell. */
export function trace(msg: string): void {
  if (process.env.MOTEBIT_LIVENESS_TRACE)
    process.stdout.write(`[${(Date.now() / 1000).toFixed(1)}s] ${msg}\n`);
}

/** whatwg-fetch and abort-controller, resolved through react-native as the mobile app gets them. */
export function reactNative(): ReactNativeFetch {
  if (rnCache) return rnCache;
  const fromMobile = createRequire(
    new URL("../../../../apps/mobile/package.json", import.meta.url),
  );
  const fromRn = createRequire(fromMobile.resolve("react-native/package.json"));
  const w = fromRn("whatwg-fetch") as Omit<ReactNativeFetch, "AbortController">;
  const ac = fromRn("abort-controller") as { AbortController: typeof AbortController };
  rnCache = { ...w, AbortController: ac.AbortController };
  return rnCache;
}
