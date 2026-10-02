/**
 * #928 round 2 — web's sync WIRING, through the real WebApp: every event
 * transport `startSync` builds (the catch-up HTTP adapter and each socket,
 * including a refresh's replacement) refuses a plaintext push, so an event
 * that skipped the encrypting wrapper can never reach the relay.
 *
 * Setup shared with sync-refresh-socket.test.ts (#816); the real
 * `@motebit/sync-engine` classes are recorded as they are constructed so the
 * test acts on exactly the instances the app wired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventLogEntry } from "@motebit/sdk";

const built = vi.hoisted(() => ({
  transports: [] as Array<{ append(e: unknown): Promise<void> }>,
}));

vi.mock("@motebit/sync-engine", async () => {
  const a = await vi.importActual<typeof import("@motebit/sync-engine")>("@motebit/sync-engine");
  class HttpEventStoreAdapter extends a.HttpEventStoreAdapter {
    constructor(c: ConstructorParameters<typeof a.HttpEventStoreAdapter>[0]) {
      super(c);
      built.transports.push(this);
    }
  }
  class WebSocketEventStoreAdapter extends a.WebSocketEventStoreAdapter {
    constructor(c: ConstructorParameters<typeof a.WebSocketEventStoreAdapter>[0]) {
      super(c);
      built.transports.push(this);
    }
  }
  return { ...a, HttpEventStoreAdapter, WebSocketEventStoreAdapter };
});

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

import { PlaintextPushRefusedError } from "@motebit/sync-engine";
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

describe("web sync wiring (#928 round 2)", () => {
  it("every event transport startSync builds refuses a plaintext push — including a refresh's socket", async () => {
    built.transports.length = 0;
    const { app } = await started();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle();
    // The catch-up HTTP adapter, the first socket, and the refresh's socket.
    expect(built.transports.length).toBeGreaterThanOrEqual(3);
    for (const t of built.transports) {
      await expect(t.append(entry("plain", 1))).rejects.toBeInstanceOf(PlaintextPushRefusedError);
    }
    app.stopSync();
    app.stop();
  });
});

describe("web catch-up failures reach the sync status (#928 round 3)", () => {
  /** The relay's /sync door; `revoked` refuses every request from then on. */
  let revoked: boolean;
  let pulls: Array<{ refused: boolean }>;

  function stubRelay(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        const path = url.pathname;
        // The relay accepts this device (#962: a registration it does not
        // accept is retried and the status reads "error" until it is).
        if (path === "/api/v1/devices/register-self") {
          return Response.json({ created: false, registered_at: 0 });
        }
        if (!path.startsWith("/sync/")) {
          return new Response("{}", {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        if (path.endsWith("/pull")) pulls.push({ refused: revoked });
        if (revoked) return new Response("Device not authorized", { status: 403 });
        if (path.endsWith("/pull")) {
          return Response.json({ events: [], next_seq: 0, has_more: false, latest_seq: 0 });
        }
        if (path.endsWith("/clock")) return Response.json({ latest_clock: 0 });
        if (path.endsWith("/plans")) return Response.json({ plans: [], accepted: 0 });
        if (path.endsWith("/plan-steps")) return Response.json({ steps: [], accepted: 0 });
        if (path.endsWith("/conversations"))
          return Response.json({ conversations: [], accepted: 0 });
        if (path.endsWith("/messages")) return Response.json({ messages: [], accepted: 0 });
        return Response.json({});
      }),
    );
  }

  async function startedWatching(statuses: string[]) {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();
    app.onSyncStatusChange((st) => statuses.push(st));
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const starting = app.startSync("https://relay.test");
    await settle();
    await starting;
    await settle();
    return app;
  }

  beforeEach(() => {
    revoked = false;
    pulls = [];
    stubRelay();
  });

  it("the FIRST socket's failed catch-up sets the status to error", async () => {
    revoked = true;
    const statuses: string[] = [];
    const app = await startedWatching(statuses);
    await settle(100);
    expect(pulls.some((p) => p.refused)).toBe(true);
    expect(statuses).toContain("error");
    app.stopSync();
    app.stop();
  });

  it("the REFRESH socket's failed catch-up sets the status to error", async () => {
    const statuses: string[] = [];
    const app = await startedWatching(statuses);
    await settle(100);
    expect(pulls.length).toBeGreaterThan(0);
    expect(statuses).not.toContain("error");

    revoked = true; // only the refresh's replacement socket catches up after this
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    await settle(100);
    expect(pulls.some((p) => p.refused)).toBe(true);
    expect(statuses).toContain("error");
    app.stopSync();
    app.stop();
  });
});
