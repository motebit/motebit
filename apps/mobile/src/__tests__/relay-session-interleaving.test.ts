/**
 * Relay OFF wins — EXHAUSTIVE interleaving harness.
 *
 * Two cold reviews found the same class twice: relay work surviving OFF
 * through an in-flight continuation (a pending registration, permission
 * prompt, Expo token fetch, sync fetch, relay-key pin, command reply, retry
 * timer…). Per-await patches kept missing one. This harness stops sampling:
 * every relay-touching async boundary the sync controller (and the push-token
 * manager it drives) can be suspended at is a controllable gate, and for
 * EVERY boundary × EVERY event × both release timings it
 *
 *   1. drives the controller until that boundary is pending,
 *   2. injects the event (OFF, OFF then ON, a second startSync as pairing
 *      does, syncNow),
 *   3. releases the boundary (immediately, or once the event settled),
 *   4. resolves everything and runs timers for five minutes, ends with OFF
 *      if the relay is still on, and runs timers five more minutes,
 *
 * then asserts the invariant over the recorded log:
 *
 *   V1 after the last OFF: zero relay requests (HTTP, WebSocket open/send,
 *      delegation wiring) — the OFF's own push-token DELETE excepted;
 *   V2 no push token registered at the relay after its DELETE;
 *   V3 no live timers/intervals;
 *   V4 every WebSocket closed;
 *   V5 interactive delegation and the delegation adapter disabled;
 *   V6 no status callback other than "offline" after OFF;
 *   V7 no OLD-session continuation acts in a NEW session: every relay act
 *      after startSync k+1 carries only k+1's handles (each session uses its
 *      own relay URL, so the URL names the session that issued the act).
 *
 * The libraries (sync-engine, core-identity, runtime, expo) are faithful
 * fakes that issue their requests through `fetch` / the WebSocket the
 * controller hands them, with a gate before each suspension point.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── World: the per-schedule log, gates and fake handles ─────────────────

type Entry =
  | { seq: number; kind: "http"; method: string; url: string }
  | { seq: number; kind: "ws-open" | "ws-send"; url: string; data?: string }
  | { seq: number; kind: "act"; what: string; url: string }
  | { seq: number; kind: "status"; status: string }
  | { seq: number; kind: "marker"; what: "OFF" | "ON"; session: number };

interface Gate {
  name: string;
  hit: boolean;
  reached: boolean;
  release: () => void;
  released: Promise<void>;
}

interface FakeWs {
  url: string;
  open: boolean;
  closed: boolean;
  custom: Array<(msg: Record<string, unknown>) => void>;
}

interface World {
  seq: number;
  log: Entry[];
  gate: Gate | null;
  refuseGatedRegistration: boolean;
  sockets: FakeWs[];
  appStateListeners: Set<(s: string) => void>;
  tokenListeners: Set<(t: unknown) => void>;
  expoTokens: number;
}

const h = vi.hoisted(() => {
  const state = { world: null as unknown as World };
  function record(e: Record<string, unknown>): void {
    const w = state.world;
    w.log.push({ ...(e as unknown as Entry), seq: ++w.seq });
  }
  /** Suspend here when this boundary is the one armed (first hit only). */
  async function gate(name: string): Promise<void> {
    const g = state.world.gate;
    if (g && g.name === name && !g.hit) {
      g.hit = true;
      g.reached = true;
      await g.released;
    }
  }
  return { state, record, gate };
});

// ── Library fakes ─────────────────────────────────────────────────────────

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(async () => {
    await h.gate("perm-check");
    return { status: "undetermined" };
  }),
  requestPermissionsAsync: vi.fn(async () => {
    await h.gate("permission");
    return { status: "granted" };
  }),
  getExpoPushTokenAsync: vi.fn(async () => {
    await h.gate("expo-token");
    return { data: `expo-token-${++h.state.world.expoTokens}` };
  }),
  addPushTokenListener: vi.fn((cb: (t: unknown) => void) => {
    const set = h.state.world.tokenListeners;
    set.add(cb);
    return { remove: () => set.delete(cb) };
  }),
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn((_evt: string, cb: (s: string) => void) => {
      const set = h.state.world.appStateListeners;
      set.add(cb);
      return { remove: () => set.delete(cb) };
    }),
  },
}));

vi.mock("@motebit/runtime", async () => ({
  TaskClaimCoordinator: (
    await vi.importActual<typeof import("@motebit/runtime")>("@motebit/runtime")
  ).TaskClaimCoordinator,
  executeRemoteCommand: vi.fn(async () => {
    await h.gate("cmd-exec");
    return { summary: "done" };
  }),
  cmdSelfTest: vi.fn(
    async (
      _rt: unknown,
      cfg: {
        relay: { relayUrl: string; motebitId: string };
        mintToken: (a: string) => Promise<string>;
      },
    ) => {
      await h.gate("self-test");
      const token = await cfg.mintToken("task:submit");
      await fetch(`${cfg.relay.relayUrl}/agent/${cfg.relay.motebitId}/task`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      return { summary: "ok", data: { status: "auth_verified" } };
    },
  ),
  servedToolNames: vi.fn(() => []),
  verifyAgentCommandEnvelope: vi.fn(async () => {
    await h.gate("cmd-verify");
    return { ok: true };
  }),
  getOrPinRelayKey: vi.fn(async (url: string, deps: { fetchImpl?: typeof fetch }) => {
    await h.gate("pin");
    const f = deps.fetchImpl ?? fetch;
    await f(`${url}/.well-known/motebit.json`);
    return "relay-public-key";
  }),
  RelayDelegationAdapter: vi.fn().mockImplementation(function (
    this: { config: unknown },
    config: unknown,
  ) {
    this.config = config;
  }),
}));

vi.mock("@motebit/sync-engine", () => {
  const RESULT = { pushed: 0, pulled: 0, conversations_pushed: 0, conversations_pulled: 0 };
  type Remote = Record<string, (() => Promise<unknown>) | undefined>;
  class Engine {
    protected remote: Remote | null = null;
    private lastError: Error | null = null;
    protected steps: Array<[gate: string, method: string]> = [];
    connectRemote(r: Remote): void {
      this.remote = r;
    }
    start(): void {}
    stop(): void {}
    getLastError(): Error | null {
      return this.lastError;
    }
    /** Never rejects (the real engines record the failure). */
    async sync(): Promise<typeof RESULT> {
      this.lastError = null;
      try {
        for (const [g, m] of this.steps) {
          await h.gate(g);
          if (this.remote) await this.remote[m]!.call(this.remote);
        }
      } catch (err: unknown) {
        this.lastError = err instanceof Error ? err : new Error(String(err));
      }
      return RESULT;
    }
  }
  class SyncEngine extends Engine {
    protected override steps: Array<[string, string]> = [
      ["sync-push", "pushEvents"],
      ["sync-pull", "pullEvents"],
    ];
  }
  class ConversationSyncEngine extends Engine {
    protected override steps: Array<[string, string]> = [["conv-sync", "push"]];
  }
  class PlanSyncEngine extends Engine {
    protected override steps: Array<[string, string]> = [["plan-sync", "push"]];
  }
  interface Creds {
    getCredential: () => Promise<string>;
  }
  class HttpEventStoreAdapter {
    constructor(private o: { baseUrl: string; credentialSource: Creds }) {}
    async pushEvents(): Promise<void> {
      const t = await this.o.credentialSource.getCredential();
      await fetch(`${this.o.baseUrl}/sync/push`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}` },
      });
    }
    async pullEvents(): Promise<void> {
      const t = await this.o.credentialSource.getCredential();
      await fetch(`${this.o.baseUrl}/sync/pull`, { headers: { Authorization: `Bearer ${t}` } });
    }
  }
  class Delegating {
    constructor(protected o: { inner: Remote }) {}
    pushEvents(): Promise<unknown> {
      return this.o.inner.pushEvents!.call(this.o.inner);
    }
    pullEvents(): Promise<unknown> {
      return this.o.inner.pullEvents!.call(this.o.inner);
    }
    push(): Promise<unknown> {
      return this.o.inner.push!.call(this.o.inner);
    }
  }
  class WebSocketEventStoreAdapter {
    private ws: FakeWs;
    constructor(private o: { url: string; credentialSource: Creds; httpFallback: Remote }) {
      this.ws = { url: o.url, open: false, closed: false, custom: [] };
      h.state.world.sockets.push(this.ws);
    }
    connect(): void {
      void (async () => {
        try {
          await this.o.credentialSource.getCredential();
        } catch {
          return;
        }
        await h.gate("ws-connect");
        if (this.ws.closed) return;
        this.ws.open = true;
        h.record({ kind: "ws-open", url: this.o.url });
      })();
    }
    disconnect(): void {
      this.ws.closed = true;
      this.ws.open = false;
    }
    onEvent(): () => void {
      return () => {};
    }
    onCustomMessage(cb: (m: Record<string, unknown>) => void): () => void {
      this.ws.custom.push(cb);
      return () => {
        this.ws.custom = this.ws.custom.filter((c) => c !== cb);
      };
    }
    sendRaw(data: string): void {
      if (!this.ws.open) return;
      h.record({ kind: "ws-send", url: this.o.url, data });
    }
    pushEvents(): Promise<unknown> {
      return this.o.httpFallback.pushEvents!.call(this.o.httpFallback);
    }
    pullEvents(): Promise<unknown> {
      return this.o.httpFallback.pullEvents!.call(this.o.httpFallback);
    }
  }
  class HttpStaticTokenAdapter {
    constructor(
      private o: { baseUrl: string; authToken?: string },
      private path: string,
    ) {}
    async push(): Promise<void> {
      await fetch(`${this.o.baseUrl}${this.path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.o.authToken ?? ""}` },
      });
    }
  }
  class HttpConversationSyncAdapter extends HttpStaticTokenAdapter {
    constructor(o: { baseUrl: string; authToken?: string }) {
      super(o, "/sync/conversations");
    }
  }
  class HttpPlanSyncAdapter extends HttpStaticTokenAdapter {
    constructor(o: { baseUrl: string; authToken?: string }) {
      super(o, "/sync/plans");
    }
  }
  return {
    SyncEngine,
    ConversationSyncEngine,
    PlanSyncEngine,
    HttpEventStoreAdapter,
    WebSocketEventStoreAdapter,
    EncryptedEventStoreAdapter: Delegating,
    HttpConversationSyncAdapter,
    EncryptedConversationSyncAdapter: Delegating,
    HttpPlanSyncAdapter,
    EncryptedPlanSyncAdapter: Delegating,
    decryptEventPayload: vi.fn((e: unknown) => Promise.resolve(e)),
  };
});

vi.mock("@motebit/core-identity", () => ({
  registerDeviceWithRelay: vi.fn(async (p: { syncUrl: string; signal?: AbortSignal }) => {
    const refuse = h.state.world.gate?.name === "register" && !h.state.world.gate.hit;
    await h.gate("register");
    await fetch(`${p.syncUrl}/api/v1/devices/register`, { method: "POST", signal: p.signal });
    return refuse && h.state.world.refuseGatedRegistration
      ? { ok: false, code: "refused", message: "not accepted" }
      : { ok: true, created: false, registered_at: 1 };
  }),
}));

vi.mock("@motebit/encryption", () => ({
  deriveSyncEncryptionKey: vi.fn(() => Promise.resolve(new Uint8Array(32))),
  secureErase: vi.fn(),
}));

const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(asyncStoreData.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      asyncStoreData.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      asyncStoreData.delete(key);
      return Promise.resolve();
    }),
  },
}));

import { MobilePushTokenManager } from "../push-token-manager";
import { MobileSyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";

// ── Schedules ─────────────────────────────────────────────────────────────

type Trigger = "start" | "cycle" | "syncNow" | "foreground" | "rotate" | "command" | "off";
type EventKind = "off" | "off-on" | "restart" | "syncNow";
type Release = "immediate" | "settled";

interface Boundary {
  trigger: Trigger;
  gate: string;
  refuse?: boolean;
}

const BOUNDARIES: Boundary[] = [
  // Armed before startSync: everything a fresh session suspends at.
  ...[
    "register",
    "perm-check",
    "permission",
    "expo-token",
    "push-post",
    "self-test",
    "pin",
    "ws-connect",
    "sync-push",
    "sync-pull",
    "conv-sync",
    "plan-sync",
    "recovery",
  ].map((gate) => ({ trigger: "start" as const, gate })),
  { trigger: "start", gate: "register", refuse: true },
  // A later sync cycle (token refresh, re-pin, new socket).
  ...["token", "pin", "ws-connect", "sync-push", "conv-sync"].map((gate) => ({
    trigger: "cycle" as const,
    gate,
  })),
  // A user /sync.
  ...["token", "sync-push", "sync-pull", "conv-sync"].map((gate) => ({
    trigger: "syncNow" as const,
    gate,
  })),
  // Push lifecycle listeners (foreground refresh, token rotation).
  ...["perm-check", "permission", "expo-token", "push-post"].map((gate) => ({
    trigger: "foreground" as const,
    gate,
  })),
  ...["perm-check", "expo-token", "push-post"].map((gate) => ({
    trigger: "rotate" as const,
    gate,
  })),
  // A relay-forwarded command_request on the socket.
  ...["cmd-verify", "cmd-exec"].map((gate) => ({ trigger: "command" as const, gate })),
  // OFF itself, with its push-token DELETE pending.
  { trigger: "off", gate: "push-delete" },
];

const EVENTS: EventKind[] = ["off", "off-on", "restart", "syncNow"];
const RELEASES: Release[] = ["immediate", "settled"];

const relayUrl = (k: number): string => `https://relay-${k}.test`;
const sessionOf = (url: string): number => Number(/relay-(\d+)\.test/.exec(url)?.[1] ?? -1);

// ── One schedule ──────────────────────────────────────────────────────────

interface FakeRuntime {
  adapter: unknown;
  interactive: unknown;
}

function makeRuntime(): FakeRuntime & Record<string, unknown> {
  const rt = {
    adapter: undefined as unknown,
    interactive: null as unknown,
    getToolRegistry: () => ({ list: () => [] }),
    getPrecision: () => ({ explorationDrive: 0.5 }),
    setDelegationAdapter(a: { config?: { syncUrl: string } } | undefined) {
      rt.adapter = a;
      if (a?.config) h.record({ kind: "act", what: "setDelegationAdapter", url: a.config.syncUrl });
    },
    enableInteractiveDelegation(c: { syncUrl: string }) {
      rt.interactive = c;
      h.record({ kind: "act", what: "enableInteractiveDelegation", url: c.syncUrl });
    },
    disableInteractiveDelegation() {
      rt.interactive = null;
    },
    /** Polls with the adapter captured at its start, as a recovery does. */
    async *recoverDelegatedSteps() {
      const a = rt.adapter as
        { config: { syncUrl: string; authToken: (aud: string) => Promise<string> } } | undefined;
      if (!a) return;
      for (let i = 0; i < 2; i++) {
        await h.gate("recovery");
        let token: string;
        try {
          token = await a.config.authToken("task:query");
        } catch {
          return;
        }
        await fetch(`${a.config.syncUrl}/api/v1/tasks/recover`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        yield { type: "step" };
        await new Promise((r) => setTimeout(r, 2_000));
      }
    },
  };
  return rt;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function runSchedule(b: Boundary, event: EventKind, release: Release): Promise<string[]> {
  vi.clearAllTimers();
  asyncStoreData.clear();
  let releaseFn: () => void = () => {};
  const released = new Promise<void>((r) => (releaseFn = r));
  const world: World = {
    seq: 0,
    log: [],
    gate: null,
    refuseGatedRegistration: b.refuse === true,
    sockets: [],
    appStateListeners: new Set(),
    tokenListeners: new Set(),
    expoTokens: 0,
  };
  h.state.world = world;
  const arm = (): void => {
    world.gate = { name: b.gate, hit: false, reached: false, release: releaseFn, released };
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const method = init?.method ?? "GET";
      h.record({ kind: "http", method, url: input });
      if (input.endsWith("/push-token"))
        await h.gate(method === "POST" ? "push-post" : "push-delete");
      return new Response(JSON.stringify({ agents: [] }), { status: 200 });
    }),
  );

  const runtime = makeRuntime();
  const box: { ctrl: MobileSyncController | null } = { ctrl: null };
  const push = new MobilePushTokenManager({
    getDeviceId: () => "dev-1",
    createSyncToken: (aud) => mint(aud),
    getSyncUrl: () => box.ctrl?.getSyncUrl() ?? Promise.resolve(null),
  });
  async function mint(aud?: string): Promise<string> {
    await h.gate("token");
    return `tok-${aud ?? "sync"}`;
  }
  type Loose = (...args: unknown[]) => unknown;
  const deps = {
    getRuntime: () => runtime,
    getMotebitId: () => "mote-1",
    getDeviceId: () => "dev-1",
    getPublicKey: () => "aa".repeat(32),
    getStorage: () => ({
      eventStore: { append: vi.fn(), read: vi.fn(() => []) },
      conversationSyncStore: {},
      planStore: {},
    }),
    getLocalEventStore: () => null,
    getKeyring: () => ({ get: () => Promise.resolve(null), set: () => Promise.resolve() }),
    getPrivKeyBytes: () => Promise.resolve(new Uint8Array(32)),
    createSyncToken: (aud?: string) => mint(aud),
    // Wired exactly as MobileApp wires them, whatever the argument shape.
    registerPushToken: (...a: unknown[]) => (push.registerPushToken.bind(push) as Loose)(...a),
    removePushToken: (url: string) => push.removePushToken(url),
    startPushLifecycle: (...a: unknown[]) => (push.startPushLifecycle.bind(push) as Loose)(...a),
    stopPushLifecycle: () => push.stopPushLifecycle(),
  } as unknown as SyncControllerDeps;
  const ctrl = new MobileSyncController(deps);
  box.ctrl = ctrl;
  ctrl.onSyncStatus((status) => h.record({ kind: "status", status }));

  let session = 0;
  let on = false;
  const pending: Array<Promise<unknown>> = [];
  const track = (p: Promise<unknown>): Promise<unknown> => {
    const q = p.catch(() => {});
    pending.push(q);
    return q;
  };
  const doOn = (): Promise<unknown> => {
    session++;
    on = true;
    h.record({ kind: "marker", what: "ON", session });
    return track(ctrl.setSyncUrl(relayUrl(session)).then(() => ctrl.startSync(relayUrl(session))));
  };
  const doOff = (): Promise<unknown> => {
    on = false;
    h.record({ kind: "marker", what: "OFF", session });
    return track(ctrl.disconnectSync());
  };
  /** Advance time in small steps until `done()` (bounded). */
  async function until(done: () => boolean, maxMs: number): Promise<boolean> {
    for (let t = 0; t < maxMs && !done(); t += 100) await vi.advanceTimersByTimeAsync(100);
    await flush();
    return done();
  }
  async function settle(p: Promise<unknown>): Promise<void> {
    let settled = false;
    void p.then(() => (settled = true));
    await until(() => settled, 10_000);
  }

  // 1. Drive to the boundary.
  if (b.trigger === "start") arm();
  void doOn();
  if (b.trigger !== "start") {
    await vi.advanceTimersByTimeAsync(3_500);
    await flush();
    arm();
    switch (b.trigger) {
      case "cycle":
        break; // the next 30 s cycle reaches it
      case "syncNow":
        void track(ctrl.syncNow());
        break;
      case "foreground":
        for (const l of [...world.appStateListeners]) l("active");
        break;
      case "rotate":
        for (const l of [...world.tokenListeners]) l("rotated");
        break;
      case "command": {
        const ws = world.sockets.filter((s) => s.open).at(-1);
        for (const cb of ws?.custom ?? []) {
          cb({ type: "command_request", id: `cmd-${session}`, command: "status", envelope: {} });
        }
        break;
      }
      case "off":
        void doOff();
        break;
    }
  }
  const reached = await until(() => world.gate?.reached === true, 60_000);
  if (!reached) return [`UNREACHED boundary ${b.trigger}/${b.gate}`];

  // 2. Inject the event while the boundary is pending.
  let injected: Promise<unknown>;
  switch (event) {
    case "off":
      injected = doOff();
      break;
    case "off-on": {
      const off = doOff();
      if (release === "immediate") releaseFn();
      await settle(off);
      injected = doOn();
      break;
    }
    case "restart":
      injected = doOn();
      break;
    case "syncNow":
      injected = track(ctrl.syncNow());
      break;
  }

  // 3. Release the boundary.
  if (release === "settled") await settle(injected);
  releaseFn();

  // 4. Resolve everything, run timers 5 min; end OFF; 5 more min.
  await vi.advanceTimersByTimeAsync(300_000);
  await flush();
  if (on) {
    void doOff();
    await vi.advanceTimersByTimeAsync(300_000);
    await flush();
  }

  return checkInvariant(world, runtime);
}

function checkInvariant(world: World, runtime: FakeRuntime): string[] {
  const v = new Set<string>();
  const lastOff = world.log.filter((e) => e.kind === "marker" && e.what === "OFF").at(-1)?.seq ?? 0;
  let phase = 0;
  let pushRegistered = false;
  for (const e of world.log) {
    if (e.kind === "marker") {
      if (e.what === "ON") phase = e.session;
      continue;
    }
    if (e.kind === "status") {
      if (e.seq > lastOff && e.status !== "offline") v.add(`V6 status "${e.status}" after OFF`);
      continue;
    }
    const label =
      e.kind === "http"
        ? `${e.method} ${e.url}`
        : e.kind === "act"
          ? `${e.what} ${e.url}`
          : `${e.kind} ${e.url}`;
    const isDelete = e.kind === "http" && e.method === "DELETE" && e.url.endsWith("/push-token");
    if (e.kind === "http" && e.url.endsWith("/push-token")) pushRegistered = e.method === "POST";
    if (e.seq > lastOff && !isDelete) v.add(`V1 relay act after OFF: ${label}`);
    if (sessionOf(e.url) < phase && !isDelete)
      v.add(`V7 session-${sessionOf(e.url)} act in session ${phase}: ${label}`);
    if (e.kind === "ws-send" && e.data) {
      const id = (JSON.parse(e.data) as { id?: string }).id ?? "";
      const cmdSession = Number(/^cmd-(\d+)$/.exec(id)?.[1] ?? sessionOf(e.url));
      if (cmdSession !== sessionOf(e.url)) {
        v.add(
          `V7 command reply for session ${cmdSession} sent on session-${sessionOf(e.url)} socket`,
        );
      }
    }
  }
  if (pushRegistered) v.add("V2 push token registered at the relay after its DELETE");
  const timers = vi.getTimerCount();
  if (timers > 0) v.add(`V3 ${timers} live timer(s) after OFF`);
  if (world.sockets.some((s) => s.open)) v.add("V4 WebSocket open after OFF");
  if (runtime.interactive != null || runtime.adapter != null)
    v.add("V5 delegation enabled after OFF");
  return [...v];
}

// ── The sweep ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Relay OFF wins over every in-flight relay continuation (exhaustive interleavings)", () => {
  it("holds the invariant over every boundary × event × release timing", async () => {
    const failures: string[] = [];
    let schedules = 0;
    for (const b of BOUNDARIES) {
      for (const event of EVENTS) {
        for (const release of RELEASES) {
          schedules++;
          const violations = await runSchedule(b, event, release);
          for (const msg of violations) {
            failures.push(
              `[${b.trigger}/${b.gate}${b.refuse ? "(refused)" : ""} × ${event} × ${release}] ${msg}`,
            );
          }
        }
      }
    }
    process.stdout.write(
      `[interleaving] ${schedules} schedules, ${failures.length} violation(s)\n` +
        failures.map((f) => `  ${f}\n`).join(""),
    );
    expect(schedules).toBe(BOUNDARIES.length * EVENTS.length * RELEASES.length);
    expect(failures).toEqual([]);
  }, 600_000);
});
