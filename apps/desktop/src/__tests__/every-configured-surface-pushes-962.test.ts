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
 *  - `@tauri-apps/api/core`'s `invoke` forwards to the stand-in, and
 *    `window.__TAURI_INTERNALS__` is stubbed while `loadDesktopConfig` runs,
 *    so the config the cell starts from is the one desktop LOADS, never a
 *    hand-built one.
 *  - `WebSocket` is the real global, subclassed to record every frame the
 *    desktop sends and to deliver one task to the serving desktop (the
 *    relay's `task_request` / `task_claimed` frames, injected; the claim
 *    frame is answered locally). `runtime.handleAgentTask` yields a receipt
 *    without running a model: the RESULT POST to the real relay is what is
 *    under test.
 *
 * The token axis (operator token removed, design 2026-11-20): "token" means
 * the key store's operator slot holds a hand-placed relay operator token
 * (`operator-slot-guard.ts`); "no-token" means it is empty. In every cell no
 * request header and no socket frame carries that token, the slot is never
 * read, and every socket bearer is a `sync` token signed by THIS device's
 * key, so when registration fails at startup (the `down→up` cells) sync
 * starts with a minted device token, never a static one.
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
import { verifySignedToken } from "@motebit/encryption";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { carriesOperatorToken, guardOperatorSlot, OPERATOR_TOKEN } from "./operator-slot-guard";

// `loadDesktopConfig` imports `invoke` from here; it forwards to the cell's
// stand-in (set per cell).
const tauriCore = vi.hoisted(() => ({
  invoke: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (tauriCore.invoke == null) throw new Error("tauri stand-in not installed");
    return tauriCore.invoke(cmd, args);
  },
}));

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
import { loadDesktopConfig } from "../ui/config";

// The relay's own operator (API) token IS the token in the slot: on a tree
// that sent it, the relay would accept it.
const MASTER = OPERATOR_TOKEN;
const APPENDED = 1005; // runtime.compact() acts only at >= 1000 events (the default threshold)

// ---------------------------------------------------------------------------
// Tauri invoke stand-in: real SQLite with main.rs's schema
// ---------------------------------------------------------------------------

// Paths from the package directory, not `new URL(…, import.meta.url)`:
// under a jsdom environment that is not a file URL.
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_RS = join(PKG_DIR, "src-tauri", "src", "main.rs");
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
const PERSISTENCE = new URL(
  `file://${join(PKG_DIR, "..", "..", "packages", "persistence", "dist", "index.js")}`,
);
async function sharedMotebitDb(file: string): Promise<Database.Database> {
  const { createMotebitDatabase } = (await import(/* @vite-ignore */ PERSISTENCE.href)) as {
    createMotebitDatabase: (p: string) => { close(): void };
  };
  createMotebitDatabase(file).close();
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

async function makeTauri(file: string, slotHoldsToken: boolean): Promise<TauriStandIn> {
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
  // "token": the operator slot holds a hand-placed token, and any read of it
  // fails the cell (operator-slot-guard.ts).
  state.invoke = (slotHoldsToken
    ? guardOperatorSlot().wrap(invoke)
    : invoke) as unknown as InvokeFn;
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

/** Every bearer the desktop put on the wire: HTTP Authorization and socket frames. */
interface WireAuth {
  headers: Array<{ route: string; auth: string }>;
  frames: string[];
}

type RecordedSocket = WebSocket & { inject(m: unknown): void };

function authorizationOf(input: string | URL | Request, init?: RequestInit): string {
  const fromInit = init?.headers != null ? new Headers(init.headers).get("authorization") : null;
  if (fromInit != null) return fromInit;
  if (input instanceof Request) return input.headers.get("authorization") ?? "";
  return "";
}

const INJECTED_TASK = "zz962-served-task";

/**
 * The real WebSocket, recording every frame the desktop sends. The relay's
 * task frames for one injected task are delivered through `inject`; the
 * desktop's claim for it is answered here (the relay never saw that task).
 */
function recordingWebSocket(frames: string[], sockets: RecordedSocket[]): typeof WebSocket {
  const Real = globalThis.WebSocket;
  return class RecordingWebSocket extends Real {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this as unknown as RecordedSocket);
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const text = typeof data === "string" ? data : "(binary frame)";
      frames.push(text);
      if (text.includes('"type":"task_claim"') && text.includes(INJECTED_TASK)) {
        this.inject({ type: "task_claimed", task_id: INJECTED_TASK });
        return;
      }
      super.send(data);
    }
    inject(msg: unknown): void {
      const handler = this.onmessage as ((ev: MessageEvent) => void) | null;
      handler?.call(this, new MessageEvent("message", { data: JSON.stringify(msg) }));
    }
  };
}

/**
 * main.ts `trySyncRegistration`: `startDesktopSync`, the sequence it runs
 * after `initAI` at startup (main.ts `onAIReady`) for every Tauri desktop
 * with a relay URL, with the arguments main.ts passes from the LOADED
 * config. The action message main.ts shows on a failure is recorded as
 * surfaced.
 */
async function desktopStartupSync(
  app: DesktopApp,
  invoke: InvokeFn,
  syncUrl: string,
  surfaced: string[],
): Promise<void> {
  await startDesktopSync(app, invoke, syncUrl, (message) => {
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

  const tauri = await makeTauri(join(host.dir, "motebit.db"), withToken);
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

  // 3. initAI — the Tauri runtime, relay configured, from the config desktop
  // LOADS (main.ts `bootstrap` → `loadDesktopConfig`).
  await tauri.invoke("update_config", {
    patch: JSON.stringify({ sync_url: host.url }),
  });
  tauriCore.invoke = tauri.invoke as unknown as typeof tauriCore.invoke;
  const w = globalThis as unknown as { window?: unknown };
  const hadWindow = "window" in w;
  const priorWindow = w.window;
  w.window = { __TAURI_INTERNALS__: {} };
  let config: Awaited<ReturnType<typeof loadDesktopConfig>>;
  try {
    config = await loadDesktopConfig();
  } finally {
    if (hadWindow) w.window = priorWindow;
    else delete w.window;
  }
  expect(config.isTauri).toBe(true);
  expect(config.syncUrl).toBe(host.url);
  // Soft: on a tree that loads the token the cell runs on, so what it SENDS
  // is seen too.
  expect.soft(JSON.stringify(config), "the loaded config").not.toContain(OPERATOR_TOKEN);
  const ok = await app.initAI(config);
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
  // Pass-through recorder: what the startup sequence's HTTP calls got back,
  // and every bearer the desktop sent.
  const wire: string[] = [];
  const auth: WireAuth = { headers: [], frames: [] };
  const sockets: RecordedSocket[] = [];
  vi.stubGlobal("WebSocket", recordingWebSocket(auth.frames, sockets));
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    auth.headers.push({
      route: `${init?.method ?? (input instanceof Request ? input.method : "GET")} ${path}`,
      auth: authorizationOf(input, init),
    });
    // Stand-in, named: desktop registers to serve with the placeholder
    // `endpoint_url: wss://<motebit_id>`, which the relay's outbound-URL rule
    // refuses (`scheme_not_allowed`) for every desktop, with or without a
    // token — a separate defect. Only that one body field is rewritten, to a
    // loopback http URL the relay accepts and never calls, so serving starts
    // and the bearers of the registration and the result POST can be seen.
    if (path === "/api/v1/agents/register" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      body.endpoint_url = "http://127.0.0.1:9/zz962-desktop-serves-over-its-socket";
      init = { ...init, body: JSON.stringify(body) };
    }
    try {
      const res = await realFetch(input, init);
      if (!path.startsWith("/sync/")) wire.push(`${init?.method ?? "GET"} ${path} → ${res.status}`);
      return res;
    } catch (err: unknown) {
      wire.push(`${init?.method ?? "GET"} ${path} → threw`);
      throw err;
    }
  });
  await desktopStartupSync(app, config.invoke!, config.syncUrl!, surfaced);

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
  if (reach === "refusing") {
    await expectDeviceBearersOnly(app, invoke, auth);
    return { appended, surfaced };
  }

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

  // 8. Serving: registration, then one task delivered and its result posted.
  await serveOneTask(app, motebitId, sockets, auth);

  await expectDeviceBearersOnly(app, invoke, auth);
  return { appended, surfaced };
}

/**
 * Start serving and deliver one task: the registration and the result POST
 * go to the real relay with whatever bearer the desktop chose.
 */
async function serveOneTask(
  app: DesktopApp,
  motebitId: string,
  sockets: RecordedSocket[],
  auth: WireAuth,
): Promise<void> {
  const served = await app.startServing();
  expect(served, `serving: ${JSON.stringify(served)}`).toEqual({ ok: true });
  const runtime = app.getRuntime()!;
  (runtime as unknown as { handleAgentTask: unknown }).handleAgentTask =
    async function* (): AsyncGenerator<{ type: string; receipt: unknown }> {
      yield { type: "task_result", receipt: { task_id: INJECTED_TASK, status: "completed" } };
    };
  const open = [...sockets].reverse().find((s) => s.readyState === WebSocket.OPEN);
  expect(open, "an open sync socket to deliver the task on").toBeDefined();
  open!.inject({
    type: "task_request",
    task: { task_id: INJECTED_TASK, motebit_id: motebitId, prompt: "zz962", status: "pending" },
  });
  const resultRoute = `POST /agent/${motebitId}/task/${INJECTED_TASK}/result`;
  const posted = await until(
    () => auth.headers.some((h) => h.route === resultRoute),
    10_000,
    false,
  );
  expect(
    posted,
    `the task result was posted (routes: ${auth.headers.map((h) => h.route).join(", ")})`,
  ).toBe(true);
}

/**
 * No bearer the desktop sent carries the operator token, and every socket
 * bearer is a `sync` token signed by THIS device's key: minted, never a
 * static token (test 2: also when registration failed at startup).
 */
async function expectDeviceBearersOnly(
  app: DesktopApp,
  invoke: InvokeFn,
  auth: WireAuth,
): Promise<void> {
  const leaked = [
    ...auth.headers.filter((h) => carriesOperatorToken(h.auth)).map((h) => h.route),
    ...auth.frames
      .filter((f) => carriesOperatorToken(f))
      .map((f) => `socket frame ${f.slice(0, 40)}`),
  ];
  expect(leaked, "requests or socket frames carrying the operator token").toEqual([]);
  const kp = await app.getDeviceKeypair(invoke);
  const socketBearers = auth.frames
    .map((f) => JSON.parse(f) as { type?: string; token?: string })
    .filter((f) => f.type === "auth")
    .map((f) => f.token ?? "");
  expect(socketBearers.length, "the socket authenticated at least once").toBeGreaterThan(0);
  for (const token of socketBearers) {
    const payload = await verifySignedToken(token, hexToBytes(kp!.publicKey));
    expect(payload, `socket bearer is not a device token: ${token.slice(0, 24)}…`).toMatchObject({
      mid: app.motebitId,
      aud: "sync",
    });
  }
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
