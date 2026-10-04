/**
 * #962 — "every configured surface pushes": a behavioural matrix for DESKTOP.
 *
 * Compaction is floored at the relay's ACKNOWLEDGED push cursor
 * (`pushCompactionFloor`). That is only half an invariant: a surface that says
 * sync is configured but never gets a push acknowledged holds compaction
 * forever, and the local log grows silently. This matrix drives the surface's
 * REAL construction and REAL startup sync sequence against a REAL relay
 * (`createSyncRelay`, served over a real port so the real `/ws/sync` route
 * works, device auth ON) and asserts, per cell, the INVARIANT PAIR:
 *
 *  (1) liveness — configured + relay reachable & accepting ⇒ within a bounded
 *      time and with NO user action, events appended through the runtime
 *      AFTER sync started are acknowledged: the relay holds them, the push
 *      floor reaches the latest clock, and `runtime.compact()` deletes > 0.
 *  (2) safety — no unacknowledged event is ever deleted: `runtime.compact()`
 *      during the unreachable phase deletes nothing the relay does not hold.
 *  and when (1) cannot hold (relay down or refusing) it is SURFACED — the
 *  sync status goes to error/disconnected, or the startup sequence shows a
 *  line — never silent.
 *
 * What is real: `DesktopApp.bootstrap` (identity mint through the Tauri
 * storage bridge), `DesktopApp.initAI` with `isTauri: true` (Tauri event
 * store, migrations, the runtime's `syncConfigured`), `registerWithRelay`,
 * `startSync` → `SyncController.startSync` (real `@motebit/sync-engine`,
 * real E2E encryption, real WebSocket), the relay.
 *
 * What is a stand-in, named:
 *  - Tauri `invoke`: `db_query`/`db_execute` run on a real SQLite
 *    (better-sqlite3) with main.rs's own SCHEMA; config + keyring are maps.
 *  - The runtime-host election (a unix-socket bind over Tauri IPC) is stubbed
 *    to the coordinator outcome — it decides who owns the runtime, not sync.
 *  - main.ts's `trySyncRegistration` runs `startDesktopSync` (sync-startup.ts),
 *    driven here: register, then startSync; a failure becomes main.ts's
 *    "Sync relay connection failed" action line with a Retry button — which
 *    this harness never clicks (no user action).
 *  - "bootstrapped" = the relay already knows this identity + device key
 *    (seeded through the relay's canonical `/api/v1/devices/register-self`,
 *    as pairing or another client of the same identity would have left it).
 *  - The 30 s SyncEngine interval is faked (`setInterval` only); every other
 *    timer — socket backoff, push deadlines — is real.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { registerDeviceWithRelay } from "@motebit/core-identity";
import { hexToBytes } from "@motebit/encryption";
import { pushCompactionFloor } from "@motebit/sync-engine";
import type { EventStoreAdapter } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { MotebitId } from "@motebit/sdk";

// The runtime-host election binds ~/.motebit/runtime.sock through Tauri IPC.
// Stubbed to "this process is the coordinator" — the outcome a desktop with
// no daemon running gets.
vi.mock("../runtime-host.js", () => ({
  electDesktopRuntimeHost: async () => ({
    role: "coordinator",
    server: { publishEvent: () => {}, close: async () => {} },
  }),
  wireBridgedOrgans: () => {},
}));

import { DesktopApp, type InvokeFn } from "../index";
import { applyConfigPatch } from "../config-update";
import { startDesktopSync } from "../sync-startup";

const MASTER = "zz962-master-token";
const APPENDED = 1005; // runtime.compact() acts only at >= 1000 events (the default threshold)

// ---------------------------------------------------------------------------
// Tauri invoke stand-in: real SQLite with main.rs's schema
// ---------------------------------------------------------------------------

const MAIN_RS = new URL("../../src-tauri/src/main.rs", import.meta.url);
function rustSchema(): string {
  const src = readFileSync(MAIN_RS, "utf8");
  const start = src.indexOf('const SCHEMA: &str = r#"');
  const body = src.slice(start + 'const SCHEMA: &str = r#"'.length);
  return body.slice(0, body.indexOf('"#;'));
}
const SCHEMA = rustSchema();

function bind(params: unknown[] | undefined): unknown[] {
  return (params ?? []).map((p) =>
    typeof p === "boolean" ? (p ? 1 : 0) : p === undefined ? null : p,
  );
}

interface TauriStandIn {
  invoke: InvokeFn;
  config: Record<string, unknown>;
  keyring: Map<string, string>;
  unexpected: string[];
}

// ~/.motebit/motebit.db is SHARED with the CLI: its tables come from
// @motebit/persistence, and main.rs adds its own (`CREATE TABLE IF NOT
// EXISTS`). The desktop migrations assume both (they ALTER persistence-owned
// tables), and `TauriEventStore.append` writes `events.device_id`, a column
// only persistence's schema has — main.rs's alone cannot hold an event.
// Built here in that order: persistence first, then main.rs's SCHEMA.
const PERSISTENCE = new URL("../../../../packages/persistence/dist/index.js", import.meta.url);
async function sharedMotebitDb(file: string): Promise<Database.Database> {
  const { createMotebitDatabase } = (await import(/* @vite-ignore */ PERSISTENCE.href)) as {
    createMotebitDatabase: (p: string) => { close(): void };
  };
  createMotebitDatabase(file).close();
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

async function makeTauri(file: string): Promise<TauriStandIn> {
  const db = await sharedMotebitDb(file);
  const keyring = new Map<string, string>();
  const state: TauriStandIn = {
    invoke: null as unknown as InvokeFn,
    config: {},
    keyring,
    unexpected: [],
  };
  const invoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    switch (cmd) {
      case "db_query":
        return db.prepare(args!.sql as string).all(...bind(args!.params as unknown[]));
      case "db_execute": {
        const stmt = db.prepare(args!.sql as string);
        if (stmt.reader) {
          stmt.all(...bind(args!.params as unknown[]));
          return 0;
        }
        return stmt.run(...bind(args!.params as unknown[])).changes;
      }
      case "read_config":
        return JSON.stringify(state.config);
      case "update_config": {
        const patch = JSON.parse(args!.patch as string) as Record<string, unknown>;
        state.config = applyConfigPatch(state.config, patch);
        return undefined;
      }
      case "write_config":
        state.config = JSON.parse(args!.json as string) as Record<string, unknown>;
        return undefined;
      case "keyring_get":
        return keyring.get(args!.key as string) ?? null;
      case "keyring_set":
        keyring.set(args!.key as string, args!.value as string);
        return undefined;
      case "keyring_set_aside":
      case "keyring_delete":
        keyring.delete(args!.key as string);
        return undefined;
      case "keyring_retired_copies":
        return [];
      default:
        state.unexpected.push(cmd);
        throw new Error(`tauri stand-in: no command ${cmd}`);
    }
  };
  state.invoke = invoke as unknown as InvokeFn;
  return state;
}

// ---------------------------------------------------------------------------
// The relay: real, served over a real port, file DB so it can restart
// ---------------------------------------------------------------------------

class RelayHost {
  readonly dir = mkdtempSync(join(tmpdir(), "zz962-desktop-relay-"));
  readonly dbPath = join(this.dir, "relay.db");
  port = 0;
  relay: SyncRelay | null = null;
  private server: ReturnType<typeof serve> | null = null;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Reserve a port nothing listens on (listen on 0, read it, close). */
  async reserve(): Promise<void> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    this.port = (s.address() as AddressInfo).port;
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

  /** Event ids the relay holds for this identity. */
  async held(motebitId: string): Promise<Set<string>> {
    if (!this.relay) return new Set();
    const events = await this.relay.moteDb.eventStore.query({
      motebit_id: motebitId as MotebitId,
    });
    return new Set(events.map((e) => e.event_id));
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll with a deadline; never unbounded. The fake 30 s interval is advanced while waiting. */
async function until(
  pred: () => Promise<boolean> | boolean,
  ms: number,
  tickIntervals = true,
): Promise<boolean> {
  const start = Date.now();
  let lastTick = 0;
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    if (tickIntervals && Date.now() - lastTick > 2_000) {
      lastTick = Date.now();
      vi.advanceTimersByTime(30_000); // one SyncEngine period
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
  vi.unstubAllGlobals();
});

type Identity = "fresh" | "bootstrapped";
type Reach = "up" | "down→up" | "refusing";

interface CellResult {
  appended: string[];
  surfaced: string[];
}

/**
 * main.ts `trySyncRegistration`: `startDesktopSync`, the sequence it runs
 * after `initAI` at startup (main.ts ~680) for every Tauri desktop with a
 * relay URL; the token is `config.syncMasterToken ?? ""`. The action message
 * main.ts shows on a failure is recorded as surfaced.
 */
async function desktopStartupSync(
  app: DesktopApp,
  invoke: InvokeFn,
  syncUrl: string,
  masterToken: string,
  surfaced: string[],
): Promise<void> {
  await startDesktopSync(app, invoke, syncUrl, masterToken, (message) => {
    surfaced.push(message);
  });
}

async function runDesktopCell(
  identity: Identity,
  reach: Reach,
  withToken: boolean,
): Promise<CellResult> {
  const host = new RelayHost();
  cleanups.push(() => host.dispose());
  await host.reserve();

  // localStorage (relay-key pin; the onboarding self-test flag). The
  // self-test is an adversarial probe unrelated to pushing: marked done.
  const ls = new Map<string, string>([["motebit:self-test-done", "true"]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
    clear: () => ls.clear(),
  });

  const tauri = await makeTauri(join(host.dir, "motebit.db"));
  const invoke = tauri.invoke;
  const app = new DesktopApp();
  cleanups.push(() => {
    app.stopSync();
    app.stop();
  });

  // 1. Identity bootstrap (main.ts tryBootstrapIdentity).
  await app.bootstrap(invoke);
  const motebitId = app.motebitId;
  expect(motebitId).not.toBe("");

  // 2. The relay's prior knowledge of this identity.
  if (identity === "bootstrapped" || reach === "up" || reach === "refusing") await host.start();
  if (identity === "bootstrapped") {
    const kp = await app.getDeviceKeypair(invoke);
    const reg = await registerDeviceWithRelay({
      motebitId,
      deviceId: app.deviceId,
      publicKey: kp!.publicKey,
      privateKey: hexToBytes(kp!.privateKey),
      syncUrl: host.url,
      deviceName: "Desktop",
    });
    expect(reg.ok, `seeding the relay's device row: ${JSON.stringify(reg)}`).toBe(true);
  }
  if (reach === "down→up") await host.stop();

  // 3. initAI — the Tauri runtime, relay configured.
  await tauri.invoke("update_config", {
    patch: JSON.stringify({ sync_url: host.url }),
  });
  const masterToken = withToken ? MASTER : "";
  const ok = await app.initAI({
    provider: "local-server",
    isTauri: true,
    invoke,
    syncUrl: host.url,
    ...(withToken ? { syncMasterToken: MASTER } : {}),
  } as Parameters<DesktopApp["initAI"]>[0]);
  expect(ok).toBe(true);
  const runtime = app.getRuntime()!;
  expect(await runtime.isSyncConfigured()).toBe(true);
  const local = (app as unknown as { _localEventStore: EventStoreAdapter })._localEventStore;

  // 4. The startup sync sequence (main.ts ~680, after initAI).
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const surfaced: string[] = [];
  const statuses: string[] = [];
  app.onSyncStatus((e) => {
    statuses.push(e.status);
    if (e.status === "error" && e.error) surfaced.push(`status:error ${e.error}`);
  });
  // Pass-through recorder: what the startup sequence's HTTP calls got back.
  const wire: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    try {
      const res = await realFetch(input, init);
      if (!path.startsWith("/sync/")) wire.push(`${init?.method ?? "GET"} ${path} → ${res.status}`);
      return res;
    } catch (err: unknown) {
      wire.push(`${init?.method ?? "GET"} ${path} → threw`);
      throw err;
    }
  });
  await desktopStartupSync(app, invoke, host.url, masterToken, surfaced);

  if (reach === "refusing") {
    // The operator revokes this identity: every signed token refused from here.
    const res = await host.relay!.app.request(`/api/v1/agents/${motebitId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    expect([200, 404]).toContain(res.status);
  }

  // 5. Events appended through the runtime's event store AFTER sync started.
  const appended: string[] = [];
  for (let i = 0; i < APPENDED; i++) {
    const id = `zz962-d-${identity}-${i}-${crypto.randomUUID()}`;
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
  const everyEventLocalOrHeld = async (): Promise<string[]> => {
    const localIds = new Set(
      (await local.query({ motebit_id: motebitId as MotebitId })).map((e) => e.event_id),
    );
    const held = await host.held(motebitId);
    return appended.filter((id) => !localIds.has(id) && !held.has(id));
  };

  // 6. The unreachable / refusing phase: safety, then surfacing.
  if (reach !== "up") {
    await runtime.compact();
    expect(await everyEventLocalOrHeld(), "safety: compaction deleted unacked events").toEqual([]);
    const shown = await until(
      () =>
        surfaced.length > 0 ||
        app.syncStatus.status === "error" ||
        app.syncStatus.status === "disconnected",
      20_000,
    );
    await runtime.compact();
    expect(await everyEventLocalOrHeld(), "safety: compaction deleted unacked events").toEqual([]);
    expect
      .soft(
        shown,
        `surfacing: relay ${reach === "refusing" ? "refusing" : "down"} but sync status stayed ` +
          `"${app.syncStatus.status}" (statuses seen: ${statuses.join(",")}) and no line was shown`,
      )
      .toBe(true);
  }
  if (reach === "refusing") return { appended, surfaced };

  if (reach === "down→up") await host.start();

  // 7. Liveness: acknowledged, floored, compactable — no user action.
  const latestClock = await local.getLatestClock(motebitId);
  const acked = await until(async () => {
    const held = await host.held(motebitId);
    if (!appended.every((id) => held.has(id))) return false;
    return (await pushCompactionFloor(local, latestClock, { syncConfigured: true })) >= latestClock;
  }, 35_000);
  const held = await host.held(motebitId);
  const floor = await pushCompactionFloor(local, latestClock, { syncConfigured: true });
  const deviceRows = host.relay
    ? (
        host.relay.moteDb.db
          .prepare("SELECT device_id FROM devices WHERE motebit_id = ?")
          .all(motebitId) as Array<{ device_id: string }>
      ).map((r) => r.device_id)
    : [];
  const deleted = await runtime.compact();
  expect(await everyEventLocalOrHeld(), "safety: compaction deleted unacked events").toEqual([]);
  expect
    .soft(
      acked,
      `liveness: relay holds ${appended.filter((id) => held.has(id)).length}/${appended.length} ` +
        `appended events, push floor ${floor}/${latestClock}; sync status "${app.syncStatus.status}" ` +
        `(seen: ${[...new Set(statuses)].join(",")}); surfaced: ${JSON.stringify([...new Set(surfaced)])}; ` +
        `relay device rows for this identity: ${JSON.stringify(deviceRows)} (this device: ${app.deviceId}); ` +
        `startup wire: ${JSON.stringify(wire.slice(0, 6))}`,
    )
    .toBe(true);
  expect.soft(deleted, "liveness: runtime.compact() deleted nothing").toBeGreaterThan(0);
  if (!acked) {
    // (1) failed: the failure must still be visible.
    expect
      .soft(
        surfaced.length > 0 ||
          app.syncStatus.status === "error" ||
          app.syncStatus.status === "disconnected",
        `surfacing: nothing acknowledged but the sync status reads "${app.syncStatus.status}" and no line was shown`,
      )
      .toBe(true);
  }
  return { appended, surfaced };
}

// ---------------------------------------------------------------------------
// The matrix: {fresh, bootstrapped} × {up, down→up} × {token, no-token} + refusing
// ---------------------------------------------------------------------------

describe("#962 — every configured desktop pushes (real DesktopApp, real relay)", () => {
  for (const identity of ["fresh", "bootstrapped"] as const) {
    for (const reach of ["up", "down→up"] as const) {
      for (const token of [true, false]) {
        it(`desktop | ${identity} | ${reach} | ${token ? "token" : "no-token"}`, async () => {
          await runDesktopCell(identity, reach, token);
        }, 90_000);
      }
    }
  }

  it("desktop | bootstrapped | refusing (identity revoked) | no-token", async () => {
    await runDesktopCell("bootstrapped", "refusing", false);
  }, 60_000);
});
