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
 *      own relay URL, so the URL names the session that issued the act);
 *   V8 nothing throws out of a timer or continuation (a crash on device);
 *   V9 every relay request on the wire when OFF lands is aborted by it — the
 *      one property that tells an adapter on the session's fetch from one on
 *      the global fetch (session credentials alone already stop NEW requests).
 *
 * @motebit/sync-engine is the REAL one (engines, HTTP adapters, encrypting
 * wrappers, WebSocket adapter): only the network (fetch, WebSocket), timers
 * and the AEAD primitive are stand-ins, with a gate at each suspension point
 * — every request in flight, the socket opening, its push ack, and the
 * per-item encrypt inside a push. core-identity, runtime and expo are
 * faithful fakes that issue their requests through the fetch / WebSocket the
 * controller hands them.
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
  socket: { deliver(msg: Record<string, unknown>): void };
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
  /** Exceptions thrown out of a timer or continuation (a crash on device). */
  crashes: string[];
  /** Relay requests on the wire right now (sent, answer pending). */
  inflight: Set<{ label: string; signal?: AbortSignal | null }>;
  /** Requests that were on the wire at an OFF and that OFF did not abort. */
  unaborted: string[];
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
        fetch?: typeof fetch;
      },
    ) => {
      await h.gate("self-test");
      const token = await cfg.mintToken("task:submit");
      // As the real command submits: through the fetch it was handed.
      await (cfg.fetch ?? fetch)(`${cfg.relay.relayUrl}/agent/${cfg.relay.motebitId}/task`, {
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

// The REAL @motebit/sync-engine (engines, HTTP adapters, the encrypting
// wrappers, the WebSocket adapter): only the network (fetch, WebSocket) and
// timers are fake. A fake adapter with no await between its guard and its
// fetch hid the round-3 leak (an encrypting push resuming after OFF).

// Encryption with a gate inside `encrypt`: the per-message await an
// encrypting push suspends at before its inner request. The AEAD primitive is
// a deterministic async stand-in — WebCrypto completes on the REAL event loop,
// which fake timers cannot schedule, so a real cipher made schedules depend on
// wall-clock luck. Every await in the adapters around it is the real one.
vi.mock("@motebit/encryption", async () => {
  const actual = await vi.importActual<typeof import("@motebit/encryption")>("@motebit/encryption");
  return {
    ...actual,
    deriveSyncEncryptionKey: vi.fn(() => Promise.resolve(new Uint8Array(32).fill(7))),
    secureErase: vi.fn(),
    encrypt: vi.fn(async (plaintext: Uint8Array) => {
      const text = new TextDecoder().decode(plaintext);
      // Gate the SECOND message / the plan / the second event: mid-batch.
      if (text.includes("conv-msg-1")) await h.gate("encrypt-msg");
      else if (text === "conv-title") await h.gate("encrypt-conv");
      else if (text.includes("plan-title")) await h.gate("encrypt-plan");
      else if (text.includes("evt-1")) await h.gate("encrypt-event");
      await Promise.resolve();
      return { ciphertext: plaintext.slice(), nonce: new Uint8Array(12), tag: new Uint8Array(16) };
    }),
    decrypt: vi.fn(async (payload: { ciphertext: Uint8Array }) => {
      await Promise.resolve();
      return payload.ciphertext.slice();
    }),
  };
});

/** A WebSocket the relay never sees until the gate opens it. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly fake: FakeWs;
  constructor(readonly url: string) {
    const fake: FakeWs = { url: url.split("?")[0]!, open: false, closed: false, socket: this };
    this.fake = fake;
    h.state.world.sockets.push(fake);
    void (async () => {
      await h.gate("ws-connect");
      if (fake.closed) return;
      this.readyState = 1;
      fake.open = true;
      h.record({ kind: "ws-open", url: fake.url });
      this.onopen?.({});
    })();
  }
  send(data: string): void {
    if (!this.fake.open) throw new Error("WebSocket is not open");
    h.record({ kind: "ws-send", url: this.fake.url, data });
    const msg = JSON.parse(data) as { type?: string; push_id?: string; events?: unknown[] };
    if (msg.type === "auth") {
      queueMicrotask(() => this.deliver({ type: "auth_result", ok: true }));
    } else if (msg.type === "push") {
      // The relay's ack is pending while the gate holds it.
      void h
        .gate("ws-push")
        .then(() =>
          this.deliver({ type: "ack", accepted: msg.events?.length ?? 0, push_id: msg.push_id }),
        );
    }
  }
  deliver(msg: Record<string, unknown>): void {
    if (!this.fake.open) return;
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  close(): void {
    if (this.fake.closed) return;
    this.fake.closed = true;
    this.fake.open = false;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

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

import { InMemoryEventStore } from "@motebit/event-log";
import type { EventLogEntry, SyncConversation, SyncConversationMessage } from "@motebit/sdk";
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
    "self-test-post",
    "pin",
    "ws-connect",
    "encrypt-event",
    "ws-push",
    "encrypt-conv",
    "conv-sync",
    "encrypt-msg",
    "conv-msgs",
    "encrypt-plan",
    "plan-sync",
    "recovery",
  ].map((gate) => ({ trigger: "start" as const, gate })),
  { trigger: "start", gate: "register", refuse: true },
  // A later sync cycle (token refresh, re-pin, new socket). Its events were
  // pushed by the first cycle, so it suspends in the conversation/plan pushes.
  ...["token", "pin", "ws-connect", "encrypt-msg", "conv-msgs", "encrypt-plan", "plan-sync"].map(
    (gate) => ({
      trigger: "cycle" as const,
      gate,
    }),
  ),
  // A user /sync.
  ...["token", "encrypt-event", "sync-push", "sync-pull", "encrypt-msg", "conv-msgs"].map(
    (gate) => ({
      trigger: "syncNow" as const,
      gate,
    }),
  ),
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

/** The relay request a gate holds in flight (sent; its answer pending). */
function requestGate(method: string, url: string): string | null {
  const path = new URL(url).pathname;
  if (path.endsWith("/push-token")) return method === "POST" ? "push-post" : "push-delete";
  if (path.endsWith("/push")) return "sync-push";
  if (path.endsWith("/pull")) return "sync-pull";
  if (method === "POST" && path.endsWith("/conversations")) return "conv-sync";
  if (method === "POST" && path.endsWith("/messages")) return "conv-msgs";
  if (method === "POST" && path.endsWith("/plans")) return "plan-sync";
  if (method === "POST" && path.endsWith("/task")) return "self-test-post";
  return null;
}

/** One body that satisfies every relay route the real adapters parse. */
const RELAY_BODY = JSON.stringify({
  accepted: 1,
  events: [],
  conversations: [],
  messages: [],
  plans: [],
  steps: [],
  next_seq: 0,
  latest_seq: 0,
  has_more: false,
  latest_clock: 0,
  agents: [],
});

/** Local data, so every push has a batch to encrypt and send. */
function makeStorage(): Record<string, unknown> {
  const eventStore = new InMemoryEventStore();
  for (let i = 0; i < 3; i++) {
    void eventStore.append({
      event_id: `evt-${i}`,
      motebit_id: "mote-1",
      timestamp: 1_000 + i,
      event_type: "state_updated",
      payload: { note: `evt-${i}` },
      version_clock: i + 1,
      tombstoned: false,
    } as EventLogEntry);
  }
  const conv: SyncConversation = {
    conversation_id: "conv-1",
    motebit_id: "mote-1",
    started_at: 1,
    last_active_at: Date.now() + 1e12,
    title: "conv-title",
    summary: null,
    message_count: 50,
  } as SyncConversation;
  const messages: SyncConversationMessage[] = Array.from({ length: 50 }, (_, i) => ({
    message_id: `m-${i}`,
    conversation_id: "conv-1",
    motebit_id: "mote-1",
    role: "user",
    content: `conv-msg-${i}`,
    tool_calls: null,
    tool_call_id: null,
    created_at: 1 + i,
    token_estimate: 1,
  })) as SyncConversationMessage[];
  const plan = {
    plan_id: "plan-1",
    goal_id: "goal-1",
    motebit_id: "mote-1",
    title: "plan-title",
    status: "active",
    created_at: 1,
    updated_at: Date.now() + 1e12,
    current_step_index: 0,
    total_steps: 0,
  };
  return {
    eventStore,
    conversationSyncStore: {
      getConversationsSince: () => [conv],
      getMessagesSince: () => messages,
      upsertConversation: () => {},
      upsertMessage: () => {},
    },
    planStore: {
      getPlan: () => null,
      getStep: () => null,
      getStepsForPlan: () => [],
      savePlan: () => {},
      saveStep: () => {},
      listAllPlans: () => [plan],
      listStepsSince: () => [],
    },
  };
}

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
        | {
            config: {
              syncUrl: string;
              authToken: (aud: string) => Promise<string>;
              fetch?: typeof fetch;
            };
          }
        | undefined;
      if (!a) return;
      for (let i = 0; i < 2; i++) {
        await h.gate("recovery");
        let token: string;
        try {
          token = await a.config.authToken("task:query");
        } catch {
          return;
        }
        // As the real adapter polls: through the fetch it was handed.
        try {
          await (a.config.fetch ?? fetch)(`${a.config.syncUrl}/api/v1/tasks/recover`, {
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch {
          return;
        }
        yield { type: "step" };
        await new Promise((r) => setTimeout(r, 2_000));
      }
    },
  };
  return rt;
}

/** Run timers; an exception thrown out of one is a crash, recorded. */
async function advance(ms: number): Promise<void> {
  try {
    await vi.advanceTimersByTimeAsync(ms);
  } catch (err: unknown) {
    h.state.world.crashes.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
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
    crashes: [],
    inflight: new Set(),
    unaborted: [],
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
      const req = { label: `${method} ${input}`, signal: init?.signal };
      world.inflight.add(req);
      try {
        const g = requestGate(method, input);
        if (g) await h.gate(g);
        if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return new Response(RELAY_BODY, { status: 200 });
      } finally {
        world.inflight.delete(req);
      }
    }),
  );
  vi.stubGlobal("WebSocket", FakeWebSocket);

  const runtime = makeRuntime();
  const storage = makeStorage();
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
    getStorage: () => storage,
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
    const off = track(ctrl.disconnectSync());
    // OFF disposes synchronously: every request it found on the wire is cut.
    for (const req of world.inflight) {
      if (req.label.endsWith("/push-token") && req.label.startsWith("DELETE")) continue;
      if (req.signal?.aborted !== true) world.unaborted.push(req.label);
    }
    return off;
  };
  /** Advance time in small steps until `done()` (bounded). */
  async function until(done: () => boolean, maxMs: number): Promise<boolean> {
    for (let t = 0; t < maxMs && !done(); t += 100) await advance(100);
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
    await advance(3_500);
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
        ws?.socket.deliver({
          type: "command_request",
          id: `cmd-${session}`,
          command: "status",
          envelope: {},
        });
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
  await advance(300_000);
  await flush();
  if (on) {
    void doOff();
    await advance(300_000);
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
  for (const c of new Set(world.crashes)) v.add(`V8 uncaught exception: ${c}`);
  for (const r of new Set(world.unaborted))
    v.add(`V9 request on the wire at OFF not aborted: ${r}`);
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
