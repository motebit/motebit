/**
 * #816 — the 4.5-minute token refresh must RETIRE the adapter it replaces
 * and attach every handler to the replacement.
 *
 * Before the fix the refresh disconnected the FIRST adapter every time and
 * attached `command_request` only to it, so each refresh left one more
 * socket open at the relay, deaf to commands.
 *
 * The real WebApp and real `@motebit/sync-engine` adapters over a fake
 * WebSocket that models the relay side: which sockets are open, which
 * authenticated, what each one received and sent. Only time is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventLogEntry } from "@motebit/sdk";

vi.mock("@motebit/render-engine", async () => {
  const actual = await vi.importActual<object>("@motebit/render-engine");
  class Headless {
    init() {
      return Promise.resolve();
    }
    render() {}
    getSpec() {
      return {};
    }
    resize() {}
    setBackground() {}
    setDarkEnvironment() {}
    setLightEnvironment() {}
    setInteriorColor() {}
    setAudioReactivity() {}
    setTrustMode() {}
    setListeningIndicator() {}
    enableOrbitControls() {}
    getCreatureGroup() {
      return null;
    }
    dispose() {}
  }
  return {
    ...actual,
    ThreeJSAdapter: Headless,
    NullRenderAdapter: Headless,
    mountCredentialSatellites: () => null,
  };
});

vi.mock("../cursor-presence.js", () => ({
  CursorPresence: class {
    start() {}
    stop() {}
    getUpdates() {
      return { attention: 0.5, curiosity: 0.3, social_distance: 0.5 };
    }
  },
}));

vi.mock("../encrypted-keystore.js", () => ({
  EncryptedKeyStore: class {
    private key: string | null = null;
    async storePrivateKey(hex: string) {
      this.key = hex;
    }
    async loadPrivateKey() {
      return this.key;
    }
  },
}));

vi.mock("../providers.js", () => ({
  createProvider: vi.fn(),
  WebLLMProvider: class {},
  PROXY_BASE_URL: "https://api.motebit.com",
}));

import { WebApp } from "../web-app.js";

// ---------------------------------------------------------------------------
// Fake relay
// ---------------------------------------------------------------------------

interface RelayState {
  sockets: FakeSocket[];
  down: boolean;
  pushed: string[];
  responses: Array<{ socket: number; id: string }>;
  /** How long the relay takes to answer `auth`. */
  authDelayMs: number;
}

let relay: RelayState;

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  authed = false;
  readonly index: number;

  constructor(public url: string) {
    this.index = relay.sockets.length;
    relay.sockets.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      if (relay.down) {
        this.readyState = 3;
        this.onclose?.();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    const msg = JSON.parse(data) as {
      type: string;
      id?: string;
      events?: Array<{ event_id: string }>;
    };
    if (msg.type === "auth") {
      setTimeout(() => {
        if (this.readyState !== 1) return;
        this.authed = true;
        this.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) });
      }, relay.authDelayMs);
    } else if (msg.type === "push") {
      for (const e of msg.events ?? []) relay.pushed.push(e.event_id);
      // The relay acknowledges every push frame it processed; the socket
      // adapter resolves an append only on that ack (#914).
      void Promise.resolve().then(() => {
        if (this.readyState !== 1) return;
        this.onmessage?.({
          data: JSON.stringify({ type: "ack", accepted: msg.events?.length ?? 0 }),
        });
      });
    } else if (msg.type === "command_response") {
      relay.responses.push({ socket: this.index, id: msg.id ?? "" });
    }
  }

  /** Client-initiated close (the adapter nulls `onclose` first). */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  /** The relay drops the connection. */
  drop(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** Sockets the relay holds open — what `sockets_open` counts. */
function openSockets(): FakeSocket[] {
  return relay.sockets.filter((s) => s.readyState !== 3);
}

function sendCommand(to: FakeSocket, id: string): void {
  to.deliver({ type: "command_request", id, command: "state" });
}

function entry(id: string, clock: number): EventLogEntry {
  return {
    event_id: id,
    motebit_id: "m",
    timestamp: 0,
    event_type: "state_updated",
    payload: { n: clock },
    version_clock: clock,
    tombstoned: false,
  } as unknown as EventLogEntry;
}

const REFRESH_MS = 4.5 * 60_000;
const realSetTimeout = globalThis.setTimeout;

/**
 * Advance fake time, letting real async work (WebCrypto signing, IndexedDB)
 * finish between steps — fake timers alone do not wait for it.
 */
async function settle(ms = 10): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(ms / 10);
    await new Promise((r) => realSetTimeout(r, 2));
  }
}

/** The remote the sync engine currently pushes to. */
function currentRemote(spy: { mock: { calls: unknown[][] } }): {
  append(e: EventLogEntry): Promise<void>;
} {
  const calls = spy.mock.calls;
  return calls[calls.length - 1]![0] as { append(e: EventLogEntry): Promise<void> };
}

async function started() {
  const app = new WebApp();
  await app.init(null as unknown as HTMLCanvasElement);
  await app.bootstrap();
  const connectSync = vi.spyOn(app.getRuntime()!, "connectSync");
  const setDelegationAdapter = vi.spyOn(app.getRuntime()!, "setDelegationAdapter");
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const t0 = Date.now();
  const starting = app.startSync("https://relay.test");
  await settle();
  await starting;
  await settle();
  return { app, connectSync, setDelegationAdapter, t0 };
}

beforeEach(() => {
  localStorage.clear();
  relay = { sockets: [], down: false, pushed: [], responses: [], authDelayMs: 0 };
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "",
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web sync token refresh (#816)", () => {
  it("across five refreshes exactly one socket is open, it is the newest, and it answers a command once", async () => {
    const { app } = await started();
    expect(openSockets()).toHaveLength(1);

    for (let n = 1; n <= 5; n++) {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      await settle();

      const open = openSockets();
      expect(open, `after refresh ${n}`).toHaveLength(1);
      expect(open[0]).toBe(relay.sockets[relay.sockets.length - 1]);
      expect(open[0]!.authed).toBe(true);

      const id = `cmd-${n}`;
      sendCommand(open[0]!, id);
      await settle();
      const answers = relay.responses.filter((r) => r.id === id);
      expect(answers, `command after refresh ${n}`).toHaveLength(1);
      expect(answers[0]!.socket).toBe(open[0]!.index);
    }
    app.stopSync();
    expect(openSockets()).toHaveLength(0);
    app.stop();
  });

  it("an event queued while offline across a refresh reaches the relay on the replacement", async () => {
    const { app, connectSync } = await started();
    // Two refreshes first, so the adapter being replaced is not the first one.
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();

    // #914: the append resolves on the ack; its frame waits a short linger
    // (fake time) after the encryption (real time).
    const before = currentRemote(connectSync).append(entry("e-before", 1));
    let sent = false;
    void before.finally(() => (sent = true));
    for (let i = 0; i < 200 && !sent; i++) {
      await vi.advanceTimersByTimeAsync(5);
      await new Promise((r) => realSetTimeout(r, 1));
    }
    await before;
    await settle();
    expect(relay.pushed).toContain("e-before");

    // Outage: the relay drops the socket; an event is queued offline.
    relay.down = true;
    for (const s of openSockets()) s.drop();
    // Queued offline: it resolves only on an ack, and the refresh hands it
    // to the replacement (#914) — so it is not awaited here.
    void currentRemote(connectSync)
      .append(entry("e-offline", 2))
      .catch(() => {});

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    relay.down = false;
    await settle(60_000);

    expect(relay.pushed).toContain("e-offline");
    expect(relay.pushed.filter((e) => e === "e-offline")).toHaveLength(1);
    expect(openSockets()).toHaveLength(1);
    app.stopSync();
    app.stop();
  });

  it("a refresh that lands during a reconnect's auth handshake leaves one socket", async () => {
    const { app, t0 } = await started();
    // One refresh first, so the adapter being replaced is not the first one.
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();
    relay.authDelayMs = 3_000;
    // The socket drops shortly before the second refresh; its reconnect is
    // still waiting on auth_result when the refresh retires the adapter.
    await vi.advanceTimersByTimeAsync(t0 + 2 * REFRESH_MS - 1_500 - Date.now());
    for (const s of openSockets()) s.drop();
    await vi.advanceTimersByTimeAsync(1_200);
    const handshaking = openSockets();
    expect(handshaking).toHaveLength(1);
    expect(handshaking[0]!.authed).toBe(false);

    await vi.advanceTimersByTimeAsync(300); // the refresh fires
    await settle();
    await settle(60_000);

    const open = openSockets();
    expect(open).toHaveLength(1);
    expect(open[0]).toBe(relay.sockets[relay.sockets.length - 1]);
    expect(open[0]!.authed).toBe(true);
    app.stopSync();
  });

  it("a refresh that retires an adapter still minting its reconnect token leaves one socket", async () => {
    const { app, t0 } = await started();
    // The first adapter mints its socket token per connect ("sync"); hold
    // that mint so its reconnect is still resolving when the refresh (which
    // mints with no audience) retires it.
    const mint = app.createSyncToken.bind(app);
    const held: Array<() => void> = [];
    const release = (): void => {
      for (const go of held.splice(0)) go();
    };
    vi.spyOn(app, "createSyncToken").mockImplementation((aud) =>
      aud === "sync"
        ? new Promise<string | null>((r) => held.push(() => void mint("sync").then(r)))
        : mint(aud),
    );

    await vi.advanceTimersByTimeAsync(t0 + REFRESH_MS - 1_500 - Date.now());
    for (const s of openSockets()) s.drop();
    await vi.advanceTimersByTimeAsync(1_200); // the reconnect is waiting on its token
    expect(openSockets()).toHaveLength(0);

    const made = relay.sockets.length;
    await vi.advanceTimersByTimeAsync(300); // the refresh fires
    for (let i = 0; i < 20 && relay.sockets.length === made; i++) await settle();
    expect(relay.sockets.length).toBe(made + 1); // the refresh opened the replacement
    release();
    await settle(30_000);

    const open = openSockets();
    expect(open).toHaveLength(1);
    expect(open[0]).toBe(relay.sockets[relay.sockets.length - 1]);
    app.stopSync();
    app.stop();
  });

  it("an append already encrypting when the refresh swaps the socket reaches the relay", async () => {
    const { app, connectSync } = await started();
    // One refresh first, so the adapter being replaced is not the first one.
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();

    const mint = app.createSyncToken.bind(app);
    let release: (t: string) => void = () => {};
    vi.spyOn(app, "createSyncToken").mockImplementation((aud) =>
      aud === undefined ? new Promise<string>((r) => (release = r)) : mint(aud),
    );
    await vi.advanceTimersByTimeAsync(REFRESH_MS); // the second refresh waits on its token
    const appending = currentRemote(connectSync).append(entry("e-straddle", 1)); // encrypting
    release("fresh-token");
    // The refresh finishes in microtasks, before the encryption does.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // #914: the append resolves on the relay's ack, which needs the fresh
    // socket to connect (fake time) after the encryption finishes (real time).
    let acked = false;
    void appending.finally(() => (acked = true));
    for (let i = 0; i < 200 && !acked; i++) {
      await vi.advanceTimersByTimeAsync(5);
      await new Promise((r) => realSetTimeout(r, 1));
    }
    await appending;
    await settle();

    expect(relay.pushed.filter((e) => e === "e-straddle")).toHaveLength(1);
    expect(openSockets()).toHaveLength(1);
    app.stopSync();
    app.stop();
  });

  it("a plan-step delegation started after refresh 1 resolves after refresh 2, submitted once", async () => {
    let submissions = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
        if (
          /\/agent\/[^/]+\/task$/.test(String(url)) &&
          init?.method === "POST" &&
          String(init.body).includes("plan_engine")
        ) {
          submissions++;
          return {
            ok: true,
            status: 201,
            headers: new Headers(),
            json: async () => ({ task_id: `plan-${submissions}` }),
            text: async () => "",
          };
        }
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => "",
        };
      }),
    );
    const { app, setDelegationAdapter } = await started();
    const wait = () => settle();
    const setDel = setDelegationAdapter.mock.calls;
    await vi.advanceTimersByTimeAsync(REFRESH_MS); // refresh 1
    await wait();

    // The adapter the runtime's plan engine delegates through now.
    const adapter = setDel[setDel.length - 1]![0] as unknown as {
      delegateStep: (step: unknown, timeoutMs: number) => Promise<unknown>;
    };
    let outcome = "pending";
    void adapter
      .delegateStep(
        { step_id: "s1", description: "d", prompt: "p", required_capabilities: [] },
        300_000,
      )
      .then(
        () => (outcome = "resolved"),
        (e: Error) => (outcome = `rejected: ${e.message}`),
      );
    await wait();
    expect(submissions).toBe(1);

    await vi.advanceTimersByTimeAsync(REFRESH_MS); // refresh 2 retires the submitting socket
    await wait();
    const open = openSockets();
    expect(open).toHaveLength(1);
    // The relay delivers the result on the socket that is open now.
    open[0]!.deliver({
      type: "task_result",
      task_id: "plan-1",
      receipt: { status: "completed", result: "ok", motebit_id: "w" },
    });
    await wait();
    expect(outcome).toBe("resolved");

    await vi.advanceTimersByTimeAsync(310_000); // past the delegation timeout
    await wait();
    expect(submissions).toBe(1);
    app.stopSync();
    app.stop();
  });

  it("a refresh whose token was minting when sync stopped opens nothing", async () => {
    const { app, connectSync } = await started();
    const mint = app.createSyncToken.bind(app);
    let release: (t: string) => void = () => {};
    vi.spyOn(app, "createSyncToken").mockImplementation((aud) =>
      aud === undefined ? new Promise<string>((r) => (release = r)) : mint(aud),
    );
    const connectsBefore = connectSync.mock.calls.length;

    await vi.advanceTimersByTimeAsync(REFRESH_MS); // refresh waits on the token
    app.stopSync();
    release("late-token");
    await settle();

    expect(openSockets()).toHaveLength(0);
    expect(connectSync.mock.calls.length).toBe(connectsBefore);
    app.stop();
  });
});

// ---------------------------------------------------------------------------
// A plan-step delegation in flight when its result frame cannot reach it
// ---------------------------------------------------------------------------

/**
 * The relay's HTTP side for plan-step delegation: admits one task per NEW
 * Idempotency-Key (a repeated key replays the task it admitted), and answers
 * `GET /agent/:id/task/:taskId` with the receipt once the task is done.
 */
function stubRelayTasks() {
  const admitted = new Map<string, string>(); // Idempotency-Key → task_id
  const done = new Set<string>();
  const ok = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        url: string,
        init?: { method?: string; body?: unknown; headers?: Record<string, string> },
      ) => {
        const u = String(url);
        if (/\/agent\/[^/]+\/task$/.test(u) && init?.method === "POST") {
          if (!String(init.body).includes("plan_engine")) return ok({}, 503);
          const key = init.headers?.["Idempotency-Key"] ?? "";
          let id = admitted.get(key);
          if (id == null) {
            id = `plan-${admitted.size + 1}`;
            admitted.set(key, id);
          }
          return ok({ task_id: id }, 201);
        }
        const m = /\/agent\/[^/]+\/task\/([^/]+)$/.exec(u);
        if (m && (init?.method ?? "GET") === "GET") {
          const id = m[1]!;
          if (![...admitted.values()].includes(id)) return ok({}, 404);
          return ok({
            task: { status: done.has(id) ? "completed" : "running" },
            receipt: done.has(id)
              ? { task_id: id, status: "completed", result: "ok", motebit_id: "w" }
              : null,
          });
        }
        return ok({}, 503);
      },
    ),
  );
  return {
    /** Distinct tasks the relay admitted — what it would run and charge for. */
    admitted: () => admitted.size,
    /** The worker finishes: the relay holds the receipt and fans the result out. */
    complete(taskId: string): number {
      done.add(taskId);
      const targets = relay.sockets.filter((s) => s.readyState === 1 && s.authed);
      for (const s of targets)
        s.deliver({
          type: "task_result",
          task_id: taskId,
          receipt: { task_id: taskId, status: "completed", result: "ok", motebit_id: "w" },
        });
      return targets.length;
    },
  };
}

type StepAdapter = { delegateStep: (step: unknown, timeoutMs: number) => Promise<unknown> };

function delegate(adapter: StepAdapter): { outcome: string } {
  const st = { outcome: "pending" };
  void adapter
    .delegateStep(
      { step_id: "s1", description: "d", prompt: "p", required_capabilities: [] },
      300_000,
    )
    .then(
      () => (st.outcome = "resolved"),
      (e: Error) => (st.outcome = `rejected: ${e.message}`),
    );
  return st;
}

function latestAdapter(spy: { mock: { calls: unknown[][] } }): StepAdapter {
  const c = spy.mock.calls;
  return c[c.length - 1]![0] as StepAdapter;
}

describe("a plan-step delegation whose result frame cannot reach it (#816)", () => {
  it("S1: started before refresh 1, completed after it — resolves, one task", async () => {
    const tasks = stubRelayTasks();
    const { app, setDelegationAdapter } = await started();
    const st = delegate(latestAdapter(setDelegationAdapter));
    await settle();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();
    tasks.complete("plan-1");
    await settle();
    await vi.advanceTimersByTimeAsync(310_000);
    await settle();

    expect(st.outcome).toBe("resolved");
    expect(tasks.admitted()).toBe(1);
    app.stopSync();
    app.stop();
  });

  it("F2: the result lands while the refresh's replacement is still authenticating — recovered, one task", async () => {
    const tasks = stubRelayTasks();
    const { app, setDelegationAdapter } = await started();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();
    const st = delegate(latestAdapter(setDelegationAdapter));
    await settle();
    relay.authDelayMs = 3_000;
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();
    expect(tasks.complete("plan-1")).toBe(0); // no authenticated socket to carry it
    await settle();
    await vi.advanceTimersByTimeAsync(310_000);
    await settle();

    expect(st.outcome).toBe("resolved");
    expect(tasks.admitted()).toBe(1);
    app.stopSync();
    app.stop();
  });

  it("F1: startSync again without stopSync — the old session's socket is retired, its delegation recovered, one task", async () => {
    const tasks = stubRelayTasks();
    const { app, setDelegationAdapter } = await started();
    const st = delegate(latestAdapter(setDelegationAdapter));
    await settle();
    const again = app.startSync("https://relay.test");
    await settle();
    await again;
    await settle();
    expect(openSockets()).toHaveLength(1);
    tasks.complete("plan-1");
    await settle();
    await vi.advanceTimersByTimeAsync(310_000);
    await settle();

    expect(st.outcome).toBe("resolved");
    expect(tasks.admitted()).toBe(1);
    app.stopSync();
    app.stop();
  });

  it("S5: stopSync then startSync mid-delegation — recovered, one task", async () => {
    const tasks = stubRelayTasks();
    const { app, setDelegationAdapter } = await started();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();
    const st = delegate(latestAdapter(setDelegationAdapter));
    await settle();
    app.stopSync();
    const again = app.startSync("https://relay.test");
    await settle();
    await again;
    await settle();
    tasks.complete("plan-1");
    await settle();
    await vi.advanceTimersByTimeAsync(310_000);
    await settle();

    expect(st.outcome).toBe("resolved");
    expect(tasks.admitted()).toBe(1);
    app.stopSync();
    app.stop();
  });

  it("S6: a new session's delegation after a second startSync resolves on its first frame, one task", async () => {
    const tasks = stubRelayTasks();
    const { app, setDelegationAdapter } = await started();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();
    const again = app.startSync("https://relay.test");
    await settle();
    await again;
    await settle();
    const st = delegate(latestAdapter(setDelegationAdapter));
    await settle();
    tasks.complete("plan-1");
    await settle();

    expect(st.outcome).toBe("resolved"); // on the frame, no query needed
    expect(tasks.admitted()).toBe(1);
    app.stopSync();
    app.stop();
  });
});
