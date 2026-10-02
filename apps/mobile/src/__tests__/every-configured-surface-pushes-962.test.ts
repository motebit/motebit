/**
 * #962 — "every configured surface pushes": a behavioural matrix for MOBILE.
 *
 * Compaction is floored at the relay's ACKNOWLEDGED push cursor
 * (`pushCompactionFloor`). A surface that says sync is configured but never
 * gets a push acknowledged holds compaction forever and the local log grows,
 * silently. This drives the REAL `MobileApp` startup sequence (App.tsx:
 * bootstrap → initAI → start → getSyncUrl → startSync) against a REAL relay
 * (`createSyncRelay`, served over a real port for the real `/ws/sync` route,
 * device auth ON) and asserts per cell the INVARIANT PAIR:
 *
 *  (1) liveness — configured + relay reachable & accepting ⇒ within a bounded
 *      time, with NO user action, events appended through the runtime AFTER
 *      sync started are acknowledged: the relay holds them, the push floor
 *      reaches the latest clock, and `runtime.compact()` deletes > 0.
 *  (2) safety — no unacknowledged event is ever deleted (`runtime.compact()`
 *      during the unreachable phase deletes nothing the relay does not hold).
 *  and when (1) cannot hold (relay down or refusing), it is SURFACED — the
 *  sync status (what App.tsx renders) goes to "error"/"offline" — never silent.
 *
 * Token dimension: N/A. Mobile has no configured-token notion — every relay
 * call mints a device-signed token (`MobileApp.createSyncToken`); there is no
 * master/operator token field anywhere in the mobile config. Each cell runs
 * once and is named `N/A-token`.
 *
 * Real: `MobileApp.bootstrap` (core-identity mint, Expo SQLite storage),
 * `initAI`, `start`, `startSync` → `MobileSyncController` (its own
 * SyncEngine, real E2E encryption, real WebSocket), the relay.
 * Stand-ins, named: `expo-sqlite` is backed by a real SQLite (better-sqlite3)
 * running the adapter's own schema + migrations; `expo-secure-store` and
 * AsyncStorage are maps; `expo`/`react-native`/notifications/task-manager/
 * `expo-three` are inert. "bootstrapped" = the relay already knows this
 * identity + device key (seeded through the relay's canonical
 * `/api/v1/devices/register-self` — what pairing or another client of this
 * identity leaves behind). "fresh" = the relay has no record of it while the
 * phone holds a persisted relay URL (a relay reset; a URL persisted by a
 * `startSync` whose registration never happened). The 30 s sync interval is
 * faked (`setInterval` only) and advanced only between cycles; every other
 * timer is real.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { serve } from "@hono/node-server";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { registerDeviceWithRelay } from "@motebit/core-identity";
import { pushCompactionFloor } from "@motebit/sync-engine";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { MotebitId } from "@motebit/sdk";

// The mobile tsconfig carries no Node types (it targets React Native): Node
// built-ins are loaded through non-literal specifiers.
const nodeImport = <T>(id: string): Promise<T> => import(/* @vite-ignore */ id) as Promise<T>;
const { createRequire } = await nodeImport<{
  createRequire: (path: string) => (id: string) => unknown;
}>("node:module");
const fs = await nodeImport<{
  mkdtempSync(p: string): string;
  rmSync(p: string, o: { recursive: boolean; force: boolean }): void;
}>("node:fs");
const os = await nodeImport<{ tmpdir(): string }>("node:os");
const net = await nodeImport<{
  createServer(): {
    listen(port: number, host: string, cb: () => void): void;
    address(): { port: number };
    close(cb: () => void): void;
  };
}>("node:net");

interface BetterDb {
  exec(sql: string): void;
  prepare(sql: string): {
    reader: boolean;
    run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
  };
}
const requireFromPersistence = createRequire(
  decodeURIComponent(
    new URL("../../../../packages/persistence/package.json", import.meta.url).pathname,
  ),
);
const Database = requireFromPersistence("better-sqlite3") as new (path: string) => BetterDb;

// === Module stand-ins (the same seams mobile-app.test.ts uses) ===

vi.mock("expo", () => ({
  requireNativeModule: (name: string) => {
    if (name === "ExpoAppAttest") return { appAttestAvailable: vi.fn(), appAttestMint: vi.fn() };
    if (name === "ExpoAndroidKeystore") {
      return { androidKeystoreAvailable: vi.fn(), androidKeystoreMint: vi.fn() };
    }
    return { seAvailable: vi.fn(), seMintAttestation: vi.fn() };
  },
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })), currentState: "active" },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(() => Promise.resolve({ status: "denied" })),
  requestPermissionsAsync: vi.fn(() => Promise.resolve({ status: "denied" })),
  getExpoPushTokenAsync: vi.fn(() => Promise.resolve({ data: "" })),
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  setNotificationHandler: vi.fn(),
}));
vi.mock("expo-task-manager", () => ({ defineTask: vi.fn(), isTaskDefined: vi.fn(() => false) }));
vi.mock("expo-three", () => ({
  Renderer: vi.fn().mockImplementation(function () {
    return { setSize: vi.fn(), setClearColor: vi.fn(), render: vi.fn(), dispose: vi.fn() };
  }),
}));

const stores = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  async: new Map<string, string>(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((k: string) => Promise.resolve(stores.secure.get(k) ?? null)),
  setItemAsync: vi.fn((k: string, v: string) => {
    stores.secure.set(k, v);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((k: string) => {
    stores.secure.delete(k);
    return Promise.resolve();
  }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((k: string) => Promise.resolve(stores.async.get(k) ?? null)),
    setItem: vi.fn((k: string, v: string) => {
      stores.async.set(k, v);
      return Promise.resolve();
    }),
    removeItem: vi.fn((k: string) => {
      stores.async.delete(k);
      return Promise.resolve();
    }),
  },
}));

/** expo-sqlite's SQLiteDatabase over a real SQLite. */
function expoHandle(db: BetterDb) {
  const bind = (args: unknown[]): unknown[] => {
    const flat = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    return flat.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p === undefined ? null : p));
  };
  return {
    execSync: (sql: string) => db.exec(sql),
    runSync: (sql: string, ...args: unknown[]) => {
      const stmt = db.prepare(sql);
      if (stmt.reader) {
        stmt.all(...bind(args));
        return { changes: 0, lastInsertRowId: 0 };
      }
      const r = stmt.run(...bind(args));
      return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid) };
    },
    getAllSync: (sql: string, ...args: unknown[]) => db.prepare(sql).all(...bind(args)),
    getFirstSync: (sql: string, ...args: unknown[]) => db.prepare(sql).get(...bind(args)) ?? null,
    prepareSync: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        executeSync: (...args: unknown[]) => ({ changes: stmt.run(...bind(args)).changes }),
        finalizeSync: () => {},
      };
    },
    closeSync: () => {},
  };
}
vi.mock("expo-sqlite", () => ({
  openDatabaseSync: () => expoHandle(new Database(":memory:")),
}));

import { MobileApp } from "../mobile-app";

// ---------------------------------------------------------------------------
// The relay: real, served over a real port, file DB so it can restart
// ---------------------------------------------------------------------------

const MASTER = "zz962-operator-master";
const APPENDED = 1005; // runtime.compact() acts only at >= 1000 events (the default threshold)

class RelayHost {
  readonly dir = fs.mkdtempSync(`${os.tmpdir()}/zz962-mobile-relay-`);
  readonly dbPath = `${this.dir}/relay.db`;
  port = 0;
  relay: SyncRelay | null = null;
  private server: ReturnType<typeof serve> | null = null;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async reserve(): Promise<void> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    this.port = s.address().port;
    await new Promise<void>((r) => s.close(() => r()));
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
    if (this.relay) await this.relay.close();
    const server = this.server;
    if (server) {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
    this.relay = null;
    this.server = null;
  }

  async held(motebitId: string): Promise<Set<string>> {
    if (!this.relay) return new Set();
    const events = await this.relay.moteDb.eventStore.query({
      motebit_id: motebitId as MotebitId,
    });
    return new Set(events.map((e) => e.event_id));
  }

  deviceRows(motebitId: string): string[] {
    if (!this.relay) return [];
    return (
      this.relay.moteDb.db
        .prepare("SELECT device_id FROM devices WHERE motebit_id = ?")
        .all(motebitId) as Array<{ device_id: string }>
    ).map((r) => r.device_id);
  }

  async dispose(): Promise<void> {
    await this.stop();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll with a deadline; never unbounded. The fake 30 s sync interval is
 * advanced only when the surface is between cycles (`canTick`) — mobile's
 * cycle has no re-entry guard, and a compressed clock must not manufacture
 * overlapping cycles the real 30 s spacing would not — or after 20 s stuck.
 */
async function until(
  pred: () => Promise<boolean> | boolean,
  ms: number,
  canTick: () => boolean,
): Promise<boolean> {
  const start = Date.now();
  let lastTick = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    const since = Date.now() - lastTick;
    if ((since > 2_000 && canTick()) || since > 20_000) {
      lastTick = Date.now();
      vi.advanceTimersByTime(30_000);
    }
    await sleep(100);
  }
  return pred();
}

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch {
      // best-effort teardown
    }
  }
  cleanups = [];
  stores.secure.clear();
  stores.async.clear();
});

type Identity = "fresh" | "bootstrapped";
type Reach = "up" | "down→up" | "refusing";

async function runMobileCell(identity: Identity, reach: Reach, userSync = false): Promise<void> {
  const host = new RelayHost();
  cleanups.push(() => host.dispose());
  await host.reserve();
  // The onboarding self-test is an adversarial probe unrelated to pushing.
  stores.async.set("motebit:self-test-done", "true");

  const app = new MobileApp();
  cleanups.push(() => app.stop());

  // App.tsx: 1. bootstrap
  await app.bootstrap();
  const motebitId = app.motebitId;
  expect(motebitId).not.toBe("mobile-local");

  if (identity === "bootstrapped" || reach !== "down→up") await host.start();
  if (identity === "bootstrapped") {
    const reg = await registerDeviceWithRelay({
      motebitId,
      deviceId: app.deviceId,
      publicKey: app.publicKey,
      privateKey: await app.getPrivKeyBytes(),
      syncUrl: host.url,
      deviceName: "Mobile",
    });
    expect(reg.ok, `seeding the relay's device row: ${JSON.stringify(reg)}`).toBe(true);
  }
  if (identity === "bootstrapped" && reach === "down→up") await host.stop();

  // The relay URL this phone holds (persisted by pairing / an earlier startSync).
  await app.setSyncUrl(host.url);

  // App.tsx: 3. initAI, 6. start
  const ok = await app.initAI({ provider: "local-server" });
  expect(ok).toBe(true);
  app.start();
  const runtime = app.getRuntime()!;
  expect(await runtime.isSyncConfigured()).toBe(true);
  const local = (app as unknown as { _localEventStore: EventStoreAdapter })._localEventStore;

  // App.tsx: 9. auto-start sync from the persisted URL, status wired to the UI.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const statuses: string[] = [];
  app.onSyncStatus((s) => statuses.push(s));
  const syncUrl = await app.getSyncUrl();
  await app.startSync(syncUrl!);
  const canTick = () => app.syncStatus !== "syncing";

  if (reach === "refusing") {
    const res = await host.relay!.app.request(`/api/v1/agents/${motebitId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect(res.status).toBe(200);
  }

  // Events appended through the runtime's event store AFTER sync started.
  const appended: string[] = [];
  for (let i = 0; i < APPENDED; i++) {
    const id = `zz962-m-${identity}-${i}-${crypto.randomUUID()}`;
    await runtime.events.appendWithClock({
      event_id: id,
      motebit_id: motebitId as MotebitId,
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { zz962: i },
      tombstoned: false,
    });
    appended.push(id);
  }
  const lost = async (): Promise<string[]> => {
    const localIds = new Set(
      (await local.query({ motebit_id: motebitId as MotebitId })).map((e) => e.event_id),
    );
    const held = await host.held(motebitId);
    return appended.filter((id) => !localIds.has(id) && !held.has(id));
  };

  // The unreachable / refusing phase: safety, then surfacing. The bound is
  // the surface's own: its first cycle (3 s) plus one push deadline (15 s).
  if (userSync) {
    // The user's /sync (slash-commands.ts): toast "Synced" when `syncNow`
    // resolves, "Sync failed: …" when it rejects.
    let outcome: string;
    try {
      const r = await app.syncNow();
      outcome = `resolved → toast "Synced" (${JSON.stringify(r)})`;
    } catch (err: unknown) {
      outcome = `rejected → "Sync failed: ${err instanceof Error ? err.message : String(err)}"`;
    }
    await runtime.compact();
    expect(await lost(), "safety: compaction deleted unacked events").toEqual([]);
    const heldNow = [...(await host.held(motebitId))].filter((id) => appended.includes(id));
    expect
      .soft(
        outcome.startsWith("rejected") || app.syncStatus === "error",
        `surfacing: relay refused /sync's push (it holds ${heldNow.length}/${appended.length}) ` +
          `but syncNow ${outcome}; status "${app.syncStatus}"`,
      )
      .toBe(true);
    return;
  }
  if (reach !== "up") {
    await runtime.compact();
    expect(await lost(), "safety: compaction deleted unacked events").toEqual([]);
    const errorsBefore = statuses.filter((s) => s === "error" || s === "offline").length;
    const shown = await until(
      () => statuses.filter((s) => s === "error" || s === "offline").length > errorsBefore,
      22_000,
      canTick,
    );
    await runtime.compact();
    expect(await lost(), "safety: compaction deleted unacked events").toEqual([]);
    expect
      .soft(
        shown,
        `surfacing: relay ${reach === "refusing" ? "refusing (identity revoked)" : "down"} but the ` +
          `sync status never went to error/offline (statuses seen: ${[...new Set(statuses)].join(",")}; ` +
          `now "${app.syncStatus}"); relay holds ` +
          `${[...(await host.held(motebitId))].filter((id) => appended.includes(id)).length}/` +
          `${appended.length} appended events`,
      )
      .toBe(true);
  }
  if (reach === "refusing") return;
  if (reach === "down→up") await host.start();

  // Liveness: acknowledged, floored, compactable — no user action.
  const latestClock = await local.getLatestClock(motebitId);
  const acked = await until(
    async () => {
      const held = await host.held(motebitId);
      if (!appended.every((id) => held.has(id))) return false;
      return (
        (await pushCompactionFloor(local, latestClock, { syncConfigured: true })) >= latestClock
      );
    },
    35_000,
    canTick,
  );
  const held = await host.held(motebitId);
  const floor = await pushCompactionFloor(local, latestClock, { syncConfigured: true });
  const deleted = await runtime.compact();
  expect(await lost(), "safety: compaction deleted unacked events").toEqual([]);
  expect
    .soft(
      acked,
      `liveness: relay holds ${appended.filter((id) => held.has(id)).length}/${appended.length} ` +
        `appended events, push floor ${floor}/${latestClock}; sync status "${app.syncStatus}" ` +
        `(seen: ${[...new Set(statuses)].join(",")}); relay device rows for this identity: ` +
        `${JSON.stringify(host.deviceRows(motebitId))} (this device: ${app.deviceId})`,
    )
    .toBe(true);
  expect.soft(deleted, "liveness: runtime.compact() deleted nothing").toBeGreaterThan(0);
  if (!acked) {
    // (1) failed with the relay up: the failure must still be visible.
    expect
      .soft(
        app.syncStatus === "error" || app.syncStatus === "offline",
        `surfacing: nothing acknowledged in 35 s but the sync status reads "${app.syncStatus}" ` +
          `(seen: ${[...new Set(statuses)].join(",")}) — the UI shows a healthy sync`,
      )
      .toBe(true);
  }
}

// ---------------------------------------------------------------------------
// The matrix: {fresh, bootstrapped} × {up, down→up} × {N/A-token} + refusing
// ---------------------------------------------------------------------------

describe("#962 — every configured phone pushes (real MobileApp, real relay)", () => {
  for (const identity of ["fresh", "bootstrapped"] as const) {
    for (const reach of ["up", "down→up"] as const) {
      it(`mobile | ${identity} | ${reach} | N/A-token`, async () => {
        await runMobileCell(identity, reach);
      }, 90_000);
    }
  }

  it("mobile | bootstrapped | refusing (identity revoked) | N/A-token", async () => {
    await runMobileCell("bootstrapped", "refusing");
  }, 60_000);

  it("mobile | bootstrapped | refusing (identity revoked) | N/A-token | user /sync (syncNow)", async () => {
    await runMobileCell("bootstrapped", "refusing", true);
  }, 60_000);
});
