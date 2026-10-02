/**
 * #962 — EVERY configured spatial surface pushes (behavioural matrix).
 *
 * Compaction of the local event log is floored at the relay's ACKNOWLEDGED
 * push cursor (`pushCompactionFloor`). The defect class hunted here: a
 * surface that says sync is configured (`runtime.isSyncConfigured()` — for
 * spatial: a relay URL AND showNetwork) but never gets a push acknowledged,
 * so nothing is pushed, compaction holds forever, the local DB grows
 * silently.
 *
 * Driven through spatial's REAL boot sequence (`app.ts` init():
 * `SpatialApp.bootstrap` → `setNetworkSettings` → `initAI` → `connectRelay`,
 * the last fire-and-forget exactly as `connectRelayWithHud` does) against a
 * REAL in-process relay (`createSyncRelay`, device auth ON) served on a real
 * port so the real WebSocket route runs. File-backed relay DB, so the relay
 * can be stopped and restarted on the same port with its state.
 *
 * Matrix: {fresh, registered} × {up, down→up} × {token, no-token} + refusing.
 *
 * "token" on spatial: the controller's `getTokenFactory()` — built in
 * `bootstrap()` only when the device key loads (spatial-app.ts:482-495). No
 * user-configured token exists; "no-token" = the key store cannot load the
 * key at boot, so `tokenFactory` is null. Those cells cannot push by
 * construction; they assert SAFETY and that the failure is SURFACED.
 *
 * Invariant pair per cell: (1) liveness — relay reachable+accepting ⇒ with
 * NO user action (only the SyncEngine's own 30s interval is advanced, faked)
 * every event appended after sync started is held by the relay, the push
 * floor reaches the latest clock, `runtime.compact()` deletes > 0.
 * (2) safety — compaction never deletes an event the relay does not hold.
 * When (1) cannot hold, the failure is SURFACED on `app.syncStatus`.
 */
// Node has no IndexedDB; spatial's `createBrowserStorage` needs one:
// fake-indexeddb, as web's tests use it (apps/web/src/__tests__/setup.ts).
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
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

// Cross-realm ArrayBuffer shim for WebCrypto digest inside vitest workers
// (the one apps/web/src/__tests__/setup.ts installs).
{
  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined) {
    const origDigest = subtle.digest.bind(subtle);
    (
      subtle as unknown as { digest: (alg: string, data: BufferSource) => Promise<ArrayBuffer> }
    ).digest = function digest(algorithm, data) {
      const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      return origDigest(algorithm, view as BufferSource);
    };
  }
}

/**
 * The key store (WebCrypto non-extractable key in IndexedDB in production).
 * ONE store shared by every instance, as the real one is (bootstrap and the
 * app each construct their own). `broken`: the key cannot be loaded.
 */
const keyState = vi.hoisted(() => ({ key: null as string | null, broken: false }));
vi.mock("../encrypted-keystore", () => ({
  EncryptedKeyStore: class {
    async storePrivateKey(hex: string) {
      keyState.key = hex;
    }
    async loadPrivateKey() {
      return keyState.broken ? null : keyState.key;
    }
  },
}));

// The once-per-device adversarial self-test submits paid tasks with a 30s
// poll — orthogonal to event push; stubbed as sync-wiring-928.test.ts does.
vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  };
});

import { SpatialApp } from "../spatial-app";

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

const BAD = new Set(["error", "disconnected"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ADVANCE_EVERY_MS = 2_000;

let relayHost: RelayHost | null = null;
let app: SpatialApp | null = null;
let dir: string | null = null;

beforeEach(() => {
  // A fresh origin per cell: one browser profile, one identity.
  vi.stubGlobal("indexedDB", new IDBFactory());
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
  keyState.key = null;
  keyState.broken = false;
});

afterEach(async () => {
  try {
    app?.dispose();
  } catch {
    /* best-effort */
  }
  app = null;
  vi.useRealTimers();
  await sleep(50);
  if (relayHost) await relayHost.stop();
  relayHost = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  vi.unstubAllGlobals();
});

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
  app: SpatialApp;
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

/** app.ts init(): bootstrap → setNetworkSettings → initAI (connectRelay is the caller's). */
async function boot(relayUrl: string): Promise<Booted> {
  const a = new SpatialApp();
  app = a;
  await a.bootstrap();
  a.setNetworkSettings({ relayUrl, showNetwork: true });
  const ok = await a.initAI({
    provider: { mode: "byok", vendor: "anthropic", apiKey: "sk-ant-zz962" },
  });
  expect(ok).toBe(true);
  const runtime = a.getRuntime()!;
  // Compaction's threshold (1000 events) is orthogonal to the invariant:
  // lowered so a handful of events exercises the floor.
  (runtime as unknown as { compactionThreshold: number }).compactionThreshold = 1;
  const internals = a as unknown as { motebitId: string; deviceId: string; publicKey: string };
  return {
    app: a,
    runtime,
    local: (runtime as unknown as { localEventStore: EventStoreAdapter }).localEventStore,
    mid: internals.motebitId,
    deviceId: internals.deviceId,
    publicKeyHex: internals.publicKey,
    privateKey: hexToBytes(keyState.key!),
  };
}

/** app.ts connectRelayWithHud(): fire-and-forget. Returns whether it resolved. */
function connect(b: Booted): { settled: () => boolean } {
  let settled = false;
  void b.app.connectRelay().then(
    () => (settled = true),
    () => (settled = true),
  );
  return { settled: () => settled };
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

async function compactSafely(b: Booted): Promise<number> {
  const before = await localIds(b);
  const deleted = await b.runtime.compact();
  const after = await localIds(b);
  const held = relayHost?.relay ? await relayHost.held(b.mid) : new Set<string>();
  const lost = [...before].filter((id) => !after.has(id) && !held.has(id));
  expect(lost, "safety: compaction deleted events the relay never acknowledged").toEqual([]);
  return deleted;
}

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
  const deleted = await compactSafely(b);
  expect(deleted, "liveness: compaction deletes once acknowledged").toBeGreaterThan(0);
}

async function assertSurfaced(b: Booted, ms: number, what: string): Promise<void> {
  const seen = await runUntil(async () => BAD.has(b.app.syncStatus), ms);
  expect(
    seen,
    `surfacing (${what}): sync cannot push, yet status stayed "${b.app.syncStatus}" for ${ms}ms`,
  ).toBe(true);
}

async function preRegister(b: Booted): Promise<void> {
  const reg = await registerDeviceWithRelay({
    motebitId: b.mid,
    deviceId: b.deviceId,
    publicKey: b.publicKeyHex,
    privateKey: b.privateKey,
    syncUrl: relayHost!.url,
    deviceName: "spatial",
  });
  expect(reg.ok, `pre-registration: ${JSON.stringify(reg)}`).toBe(true);
}

async function cell(identity: Identity, reach: Reach, token: Token): Promise<void> {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dir = mkdtempSync(join(tmpdir(), "zz962-spatial-"));
  relayHost = new RelayHost(await reservePort(), join(dir, "relay.db"));
  if (token === "no-token") keyState.broken = true;
  const b = await boot(relayHost.url);

  if (identity === "registered") {
    await relayHost.start();
    await preRegister(b);
    if (reach === "down→up") await relayHost.stop();
  } else if (reach === "up") {
    await relayHost.start();
  }

  connect(b);
  await sleep(300);
  expect(await b.runtime.isSyncConfigured(), "the surface says sync is configured").toBe(true);

  const ids = await appendProbes(b, 3, "after-start");

  if (reach === "down→up") {
    expect(await compactSafely(b), "safety while the relay is down").toBe(0);
    await assertSurfaced(b, 20_000, "relay unreachable");
    await relayHost.start();
  }

  if (token === "no-token") {
    await assertSurfaced(b, 20_000, "no device key / no token");
    expect(await compactSafely(b), "safety with no token").toBe(0);
    return;
  }

  await assertLiveness(b, ids, 45_000);
}

const CELL_TIMEOUT = 90_000;

describe("#962 — every configured SPATIAL surface pushes (matrix)", () => {
  for (const identity of ["fresh", "registered"] as const) {
    for (const reach of ["up", "down→up"] as const) {
      for (const token of ["token", "no-token"] as const) {
        it(
          `spatial | ${identity} | ${reach} | ${token === "no-token" ? "no-token (device key unloadable → no tokenFactory)" : "token (tokenFactory)"}`,
          () => cell(identity, reach, token),
          CELL_TIMEOUT,
        );
      }
    }
  }

  it(
    "spatial | registered | up | token | relay REFUSING (identity revoked) — surfaced, nothing lost",
    async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      dir = mkdtempSync(join(tmpdir(), "zz962-spatial-"));
      relayHost = new RelayHost(await reservePort(), join(dir, "relay.db"));
      const b = await boot(relayHost.url);
      await relayHost.start();
      await preRegister(b);
      const { token } = await mintAudienceToken(
        { mid: b.mid, did: b.deviceId, aud: "admin:query" },
        b.privateKey,
      );
      const res = await relayHost.relay!.app.request(`/api/v1/agents/${b.mid}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status, "relay revoked the identity").toBe(200);

      connect(b);
      await sleep(300);
      expect(await b.runtime.isSyncConfigured()).toBe(true);
      const ids = await appendProbes(b, 3, "refused");

      await assertSurfaced(b, 30_000, "relay refuses the device");
      expect(await compactSafely(b), "safety under refusal").toBe(0);
      const held = await relayHost.held(b.mid);
      expect(ids.filter((id) => held.has(id))).toEqual([]);
    },
    CELL_TIMEOUT,
  );
});
