/**
 * #962 — EVERY configured web surface pushes (behavioural matrix).
 *
 * Compaction of the local event log is floored at the relay's ACKNOWLEDGED
 * push cursor (`pushCompactionFloor`). The defect class hunted here: a
 * surface that says sync is configured (`runtime.isSyncConfigured()`) but
 * never gets a push acknowledged — so nothing is ever pushed, compaction
 * holds forever, and the local DB grows silently.
 *
 * Driven through the REAL `WebApp.bootstrap` (real runtime construction,
 * fake-indexeddb storage) and the REAL `WebApp.startSync(relayUrl)` against a
 * REAL in-process relay (`createSyncRelay`, device auth ON) served on a real
 * port so the real WebSocket route runs. File-backed relay DB, so the relay
 * can be stopped and restarted on the same port with its state.
 *
 * Matrix: {fresh, registered} × {up, down→up} × {token, no-token} + refusing.
 *
 * "token" on web: web has no user-configured token — every relay credential
 * is self-minted from the device key (`WebApp.createSyncToken`). The honest
 * "no-token" analog is "the device key cannot be loaded at sync time"
 * (`keyStore.loadPrivateKey()` → null after bootstrap), so no token can be
 * minted. Those cells cannot push by construction; they assert SAFETY and
 * that the failure is SURFACED.
 *
 * Invariant pair per cell:
 *  (1) liveness — relay reachable and accepting ⇒ with NO user action (the
 *      only thing advanced is the SyncEngine's own 30s interval, faked), every
 *      event appended after sync started is held by the relay, the push floor
 *      reaches the latest clock, and `runtime.compact()` deletes > 0.
 *  (2) safety — `runtime.compact()` never deletes an event the relay does not
 *      hold (checked in the down phase and after liveness).
 *  and when (1) cannot hold, the failure is SURFACED on `app.syncStatus`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { EventType } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import { pushCompactionFloor } from "@motebit/sync-engine";
import { registerDeviceWithRelay } from "@motebit/core-identity";
import { mintAudienceToken } from "@motebit/encryption";
import type { MotebitRuntime } from "@motebit/runtime";
import { IDBFactory } from "fake-indexeddb";

// ── Surface harness (as web-app.test.ts / sync-refresh-socket.test.ts) ──

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

/** `broken`: the device key can no longer be loaded (the "no-token" half). */
const keyState = vi.hoisted(() => ({ broken: false }));

vi.mock("../encrypted-keystore.js", () => ({
  EncryptedKeyStore: class {
    private key: string | null = null;
    async storePrivateKey(hex: string) {
      this.key = hex;
    }
    async loadPrivateKey() {
      return keyState.broken ? null : this.key;
    }
  },
}));

vi.mock("../providers.js", () => ({
  createProvider: vi.fn().mockReturnValue({
    generateStream: vi.fn(),
    generate: vi.fn(),
    setModel: vi.fn(),
    getModel: vi.fn().mockReturnValue("mock-model"),
  }),
  WebLLMProvider: class {},
  PROXY_BASE_URL: "https://api.motebit.com",
}));

import { WebApp } from "../web-app.js";

// ── Relay harness (as apps/cli relay-sync-socket.test.ts) ──────────────

const MASTER = "test-token";

async function reservePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

class RelayHost {
  relay: SyncRelay | null = null;
  private server: ReturnType<typeof serve> | null = null;
  constructor(
    readonly port: number,
    readonly dbPath: string,
  ) {}
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  async start(): Promise<void> {
    this.relay = await createSyncRelay({
      dbPath: this.dbPath,
      apiToken: MASTER,
      x402: {
        payToAddress: "0x0000000000000000000000000000000000000000",
        network: "eip155:84532",
        testnet: true,
      },
      drainGraceMs: 10,
      allowPrivateEndpoints: true,
    });
    const server = serve({ fetch: this.relay.app.fetch, port: this.port, hostname: "127.0.0.1" });
    this.server = server;
    (this.relay.app as unknown as { injectWebSocket: (s: unknown) => void }).injectWebSocket(
      server,
    );
    await new Promise<void>((r) => {
      if (server.listening) r();
      else server.once("listening", () => r());
    });
  }
  async stop(): Promise<void> {
    const relay = this.relay;
    const server = this.server;
    this.relay = null;
    this.server = null;
    if (relay) await relay.close();
    if (server) {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
  /** Event ids the relay holds for `mid` (empty while stopped). */
  async held(mid: string): Promise<Set<string>> {
    if (!this.relay) return new Set();
    const rows = await this.relay.moteDb.eventStore.query({ motebit_id: mid });
    return new Set(rows.map((e) => e.event_id));
  }
}

// ── Cell driver ─────────────────────────────────────────────────────────

type Identity = "fresh" | "registered";
type Reach = "up" | "down→up";
type Token = "token" | "no-token";

const BAD = new Set(["error", "disconnected", "offline"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ADVANCE_EVERY_MS = 2_000;

let relayHost: RelayHost | null = null;
let app: WebApp | null = null;
let dir: string | null = null;

beforeEach(() => {
  // A fresh origin per cell: one browser profile, one identity.
  vi.stubGlobal("indexedDB", new IDBFactory());
  localStorage.clear();
  keyState.broken = false;
});

afterEach(async () => {
  try {
    app?.stopSync?.();
  } catch {
    /* best-effort */
  }
  try {
    app?.stop();
  } catch {
    /* best-effort */
  }
  app = null;
  vi.useRealTimers();
  if (relayHost) await relayHost.stop();
  relayHost = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * Let the surface run: real time passes, and every ADVANCE_EVERY_MS the
 * faked setInterval clock moves 30s (one SyncEngine period). No sync is ever
 * called by the test.
 */
async function runUntil(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
  const start = Date.now();
  let lastAdvance = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    if (Date.now() - lastAdvance >= ADVANCE_EVERY_MS) {
      vi.advanceTimersByTime(30_000);
      lastAdvance = Date.now();
    }
    await sleep(100);
  }
  return pred();
}

interface Booted {
  app: WebApp;
  runtime: MotebitRuntime;
  local: EventStoreAdapter;
  mid: string;
  deviceId: string;
  publicKeyHex: string;
  privateKey: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

async function boot(): Promise<Booted> {
  const a = new WebApp();
  app = a;
  await a.init(null as unknown as HTMLCanvasElement);
  await a.bootstrap();
  const runtime = a.getRuntime()!;
  const internals = a as unknown as {
    _motebitId: string;
    _deviceId: string;
    _publicKeyHex: string;
    keyStore: { loadPrivateKey(): Promise<string | null> };
  };
  const hex = (await internals.keyStore.loadPrivateKey())!;
  // Compaction's threshold (1000 events) is orthogonal to the invariant:
  // lowered so a handful of events exercises the floor.
  (runtime as unknown as { compactionThreshold: number }).compactionThreshold = 1;
  return {
    app: a,
    runtime,
    local: (runtime as unknown as { localEventStore: EventStoreAdapter }).localEventStore,
    mid: internals._motebitId,
    deviceId: internals._deviceId,
    publicKeyHex: internals._publicKeyHex,
    privateKey: hexToBytes(hex),
  };
}

async function appendProbes(b: Booted, n: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `probe-${tag}-${i}-${crypto.randomUUID()}`;
    await b.runtime.events.appendWithClock({
      event_id: id,
      motebit_id: b.mid,
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { probe: tag, i },
      tombstoned: false,
    });
    ids.push(id);
  }
  return ids;
}

async function localIds(b: Booted): Promise<Set<string>> {
  const rows = await b.local.query({ motebit_id: b.mid });
  return new Set(rows.map((e) => e.event_id));
}

/** (2) safety: compact now; every event local before it is still local or held by the relay. */
async function compactSafely(b: Booted, relayHeldWhileDown: Set<string>): Promise<number> {
  const before = await localIds(b);
  const deleted = await b.runtime.compact();
  const after = await localIds(b);
  const held = relayHost?.relay ? await relayHost.held(b.mid) : relayHeldWhileDown;
  const lost = [...before].filter((id) => !after.has(id) && !held.has(id));
  expect(lost, "safety: compaction deleted events the relay never acknowledged").toEqual([]);
  return deleted;
}

async function preRegister(b: Booted, url: string): Promise<void> {
  const reg = await registerDeviceWithRelay({
    motebitId: b.mid,
    deviceId: b.deviceId,
    publicKey: b.publicKeyHex,
    privateKey: b.privateKey,
    syncUrl: url,
    deviceName: "web",
  });
  expect(reg.ok, `pre-registration: ${JSON.stringify(reg)}`).toBe(true);
}

async function revoke(b: Booted): Promise<void> {
  const { token } = await mintAudienceToken(
    { mid: b.mid, did: b.deviceId, aud: "admin:query" },
    b.privateKey,
  );
  const res = await relayHost!.relay!.app.request(`/api/v1/agents/${b.mid}/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status, "relay revoked the identity").toBe(200);
}

/** Start sync the way the surface does (pairing / Connect button / reload), never awaited past a bound. */
function startSync(b: Booted, url: string): { error: () => unknown } {
  let err: unknown = null;
  void b.app.startSync(url).catch((e: unknown) => {
    err = e;
  });
  return { error: () => err };
}

/** What the relay and the local store hold, for a failure message. */
async function diagnose(b: Booted): Promise<string> {
  const local = (await b.local.query({ motebit_id: b.mid }))
    .map((e) => `${e.event_type}@${e.version_clock}`)
    .join(",");
  const held = relayHost?.relay
    ? (await relayHost.relay.moteDb.eventStore.query({ motebit_id: b.mid }))
        .map((e) => `${e.event_type}@${e.version_clock}`)
        .join(",")
    : "(relay down)";
  const err = b.runtime.sync.getLastError();
  return `local=[${local}] relay=[${held}] lastError=${err ? err.message : "none"}`;
}

async function assertLiveness(b: Booted, ids: string[], ms: number): Promise<void> {
  const latest = await b.local.getLatestClock(b.mid);
  let lastSeen = { held: 0, floor: 0 };
  const ok = await runUntil(async () => {
    const held = await relayHost!.held(b.mid);
    const floor = await pushCompactionFloor(b.local, latest, { syncConfigured: true });
    lastSeen = { held: ids.filter((id) => held.has(id)).length, floor };
    return lastSeen.held === ids.length && floor >= latest;
  }, ms);
  expect(
    ok,
    `liveness: within ${ms}ms, no user action — relay holds ${lastSeen.held}/${ids.length} ` +
      `events appended after sync started; push floor ${lastSeen.floor}/${latest}; ` +
      `status=${b.app.syncStatus}; ${await diagnose(b)}`,
  ).toBe(true);
  const deleted = await compactSafely(b, new Set());
  expect(deleted, "liveness: compaction deletes once acknowledged").toBeGreaterThan(0);
}

async function assertSurfaced(b: Booted, ms: number, what: string): Promise<void> {
  const seen = await runUntil(async () => BAD.has(b.app.syncStatus), ms);
  expect(
    seen,
    `surfacing (${what}): sync cannot push, yet status stayed "${b.app.syncStatus}" for ${ms}ms`,
  ).toBe(true);
}

async function cell(identity: Identity, reach: Reach, token: Token): Promise<void> {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dir = mkdtempSync(join(tmpdir(), "zz962-web-"));
  relayHost = new RelayHost(await reservePort(), join(dir, "relay.db"));
  const b = await boot();

  if (identity === "registered") {
    await relayHost.start();
    await preRegister(b, relayHost.url);
    if (reach === "down→up") await relayHost.stop();
  } else if (reach === "up") {
    await relayHost.start();
  }
  if (token === "no-token") keyState.broken = true;

  const started = startSync(b, relayHost.url);
  // startSync's own awaits (registration, key pin) settle on real time.
  await sleep(300);
  expect(await b.runtime.isSyncConfigured(), "the surface says sync is configured").toBe(true);

  const ids = await appendProbes(b, 3, "after-start");

  if (reach === "down→up") {
    // Unreachable: nothing can be acknowledged — compaction must hold, and
    // the failure must be visible.
    const d = await compactSafely(b, new Set());
    expect(d, "safety: nothing unacknowledged compacted while the relay is down").toBe(0);
    await assertSurfaced(b, 20_000, "relay unreachable");
    await relayHost.start();
  }

  if (token === "no-token") {
    // No credential can be minted: pushing is impossible; it must be surfaced
    // and nothing may be compacted.
    await assertSurfaced(b, 20_000, "no device key / no token");
    expect(await compactSafely(b, new Set()), "safety with no token").toBe(0);
    void started;
    return;
  }

  await assertLiveness(b, ids, 45_000);
}

const CELL_TIMEOUT = 90_000;

describe("#962 — every configured WEB surface pushes (matrix)", () => {
  for (const identity of ["fresh", "registered"] as const) {
    for (const reach of ["up", "down→up"] as const) {
      for (const token of ["token", "no-token"] as const) {
        it(
          `web | ${identity} | ${reach} | ${token === "no-token" ? "no-token (device key unloadable)" : "token (self-minted)"}`,
          () => cell(identity, reach, token),
          CELL_TIMEOUT,
        );
      }
    }
  }

  it(
    "web | identity changed on one origin (restore / re-bootstrap) | before sync connects — safety: another identity's acked cursor must not floor this one",
    async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      dir = mkdtempSync(join(tmpdir(), "zz962-web-"));
      relayHost = new RelayHost(await reservePort(), join(dir, "relay.db"));
      // Identity A pushes and is acknowledged on this origin.
      const a = await boot();
      await relayHost.start();
      startSync(a, relayHost.url);
      await sleep(300);
      await assertLiveness(a, await appendProbes(a, 3, "A"), 45_000);
      a.app.stopSync();
      a.app.stop();
      // Same origin (same IndexedDB), a different identity — what
      // `restoreIdentity` + reload, or a cleared config, bootstraps into.
      for (const k of ["motebit:motebit_id", "motebit:device_id", "motebit:device_public_key"]) {
        localStorage.removeItem(k);
      }
      const b = await boot();
      expect(b.mid).not.toBe(a.mid);
      await relayHost.stop();
      // The saved relay URL makes B configured from boot; compaction (the
      // runtime's autoCompact, or any caller) can run before this page's
      // startSync connects — or when startSync fails before connecting (no key).
      expect(await b.runtime.isSyncConfigured()).toBe(true);
      await appendProbes(b, 3, "B");
      // B has never been acknowledged by any relay: nothing of B's may go.
      expect(await compactSafely(b, new Set()), "safety for identity B").toBe(0);
    },
    CELL_TIMEOUT,
  );

  it(
    "web | registered | up | token | relay REFUSING (identity revoked) — surfaced, nothing lost",
    async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      dir = mkdtempSync(join(tmpdir(), "zz962-web-"));
      relayHost = new RelayHost(await reservePort(), join(dir, "relay.db"));
      const b = await boot();
      await relayHost.start();
      await preRegister(b, relayHost.url);
      await revoke(b);

      startSync(b, relayHost.url);
      await sleep(300);
      expect(await b.runtime.isSyncConfigured()).toBe(true);
      const ids = await appendProbes(b, 3, "refused");

      await assertSurfaced(b, 30_000, "relay refuses the device");
      expect(await compactSafely(b, new Set()), "safety under refusal").toBe(0);
      const held = await relayHost.held(b.mid);
      expect(ids.filter((id) => held.has(id))).toEqual([]);
    },
    CELL_TIMEOUT,
  );
});
