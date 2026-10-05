/**
 * #962 round 4 — the harness over EVERY CLI runtime entry point: does a
 * surface that says sync is configured actually get its pushes acknowledged?
 *
 * Twice a review found the same class: a CLI surface configured for sync
 * whose push is never acknowledged (the REPL pushing unauthenticated; the
 * daemons never pushing at all), so compaction — floored at the relay's
 * acknowledged push cursor — never runs and `motebit.db` grows silently.
 * This file enumerates the space instead of one more point test.
 *
 * Entry points, each driven through the SAME function the entry point calls
 * (`cli-event-push.ts`, `cliRuntimeConfig`, `createRuntime`,
 * `createDaemonRelaySync`, `registerWithRelay`), never re-implemented:
 *   repl      createRuntime → replStartupSync (index.ts's startup order)
 *   run       cliRuntimeConfig → createDaemonRelaySync → registerWithRelay
 *             → startRunEventSync (daemon.ts's order)
 *   serve     the same, → startServeEventSync (HTTP transport with a relay)
 *   delegate  cliRuntimeConfig → openDelegateEventSync … close()
 *
 * Dimensions: identity {fresh — never bootstrapped, bootstrapped} × relay
 * {up at start, down at start then up} × token {the configured master token,
 * none}. The relay is a real in-process `services/relay` served on a real
 * port, device auth ON; "down" is the cell's port held open with no relay
 * behind it (every connection reset — see `holdPort`); its
 * database is a file, so a bootstrapped identity survives the restart.
 *
 * The invariant pair, per cell:
 *   (1) liveness — relay reachable and accepting ⇒ within a bounded time and
 *       with no user action (no `/sync`), every event appended AFTER start
 *       is acknowledged (the relay holds it; the push floor reaches the
 *       latest clock) and `compact()` then deletes below the floor;
 *   (2) safety — no unacknowledged event is ever deleted (compaction is
 *       attempted while the relay is down, and after);
 * and while (1) cannot hold (relay down), the failure is SURFACED as a sync
 * line, never silent.
 *
 * Plus, per entry point: a relay REFUSING the push (a wrong configured
 * token) — surfaced, nothing deleted; and for the daemons, NO relay
 * configured (`run` without a sync URL, `serve` over stdio) — then sync is
 * not configured and compaction is not held on a relay that does not exist.
 */
import { mkdtempSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-962h-cfg-"));
  // The cells configure relay and token themselves; the host's must not leak in.
  for (const k of ["MOTEBIT_SYNC_URL", "MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN"])
    delete process.env[k];
});

import { createAdaptorServer } from "@hono/node-server";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  deriveSyncEncryptionKey,
  generateKeypair,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { EventType } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import { pushCompactionFloor } from "@motebit/sync-engine";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import {
  buildStorageAdapters,
  createRuntime,
  InMemoryToolRegistry,
  openMotebitDatabase,
} from "../runtime-factory.js";
import type { MotebitDatabase } from "../runtime-factory.js";
import { parseCliArgs } from "../args.js";
import { cliRuntimeConfig, daemonRelay } from "../sync-configured.js";
import { createDaemonRelaySync } from "../daemon-relay-sync.js";
import { registerWithRelay } from "../relay-registration.js";
import { decryptPrivateKey, fromHex } from "../identity.js";
import {
  bootstrapReplIdentity,
  openDelegateEventSync,
  replStartupSync,
  startRunEventSync,
  startServeEventSync,
} from "../cli-event-push.js";

const MASTER = "master-962h";
/** The harness's push cadence (the entry points' default is 30 s). */
const PUSH_MS = 150;
/** How long the relay stays down after the entry point started. */
const DOWN_MS = 1_200;
/** The liveness bound: acknowledged within this, once the relay is up. */
const LIVE_MS = 20_000;
const CELL_TIMEOUT = 60_000;

const hex = (kp: KeyPair): string => bytesToHex(kp.publicKey);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The REPL's createRuntime prints its "Sync: <url>" line; keep the run quiet.
vi.spyOn(console, "log").mockImplementation(() => {});

// ── the relay ───────────────────────────────────────────────────────────────

interface ServedRelay {
  relay: SyncRelay;
  close(): Promise<void>;
}

/**
 * A cell's relay port, BOUND for the cell's whole life. Each connection is
 * handed to the relay currently up on it, or reset while none is ("down").
 *
 * The port is never released between "down" and "up": a port reserved and
 * then closed is free for any other relay — another cell, another test file
 * in the same vitest run — to bind while this cell's relay is down. The
 * cell's pushes then reached THAT relay at the cell's URL, it acknowledged
 * and held them, compaction rightly deleted them, and the safety check —
 * reading only this cell's relay — reported them lost (#962 down→up flake,
 * traced 2026-10-05: the "lost" events sat in the other cell's relay.db).
 */
interface CellPort {
  port: number;
  /** Route connections to `server` (a relay up), or reset them (`undefined`, down). */
  route(server: HttpServer | undefined): void;
  close(): Promise<void>;
}

async function holdPort(): Promise<CellPort> {
  let target: HttpServer | undefined;
  /** Connections handed to the current relay — dropped when it goes down. */
  let routed = new Set<Socket>();
  const all = new Set<Socket>();
  const srv = createServer((socket) => {
    all.add(socket);
    socket.once("close", () => all.delete(socket));
    if (!target) {
      socket.resetAndDestroy();
      return;
    }
    routed.add(socket);
    target.emit("connection", socket);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return {
    port: (srv.address() as AddressInfo).port,
    route(server) {
      target = server;
      for (const s of routed) s.destroy();
      routed = new Set();
    },
    async close() {
      target = undefined;
      for (const s of all) s.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

/** Event-sync requests the relay refused (401/403), per cell. */
interface Refusals {
  count: number;
}

async function startRelay(
  port: CellPort,
  dbPath: string,
  refusals: Refusals = { count: 0 },
): Promise<ServedRelay> {
  const relay = await createSyncRelay({
    dbPath,
    apiToken: MASTER,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
  const server = createAdaptorServer({
    fetch: async (req: Request, env: unknown) => {
      const res = await relay.app.fetch(req, env);
      if (/\/sync\//.test(new URL(req.url).pathname) && (res.status === 401 || res.status === 403))
        refusals.count++;
      return res;
    },
  }) as HttpServer;
  (relay.app as unknown as { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  port.route(server);
  return {
    relay,
    async close() {
      port.route(undefined);
      await relay.close();
    },
  };
}

async function bootstrap(base: string, mid: string, deviceId: string, kp: KeyPair): Promise<void> {
  const resp = await fetch(`${base}/api/v1/agents/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motebit_id: mid, device_id: deviceId, public_key: hex(kp) }),
  });
  expect(resp.ok).toBe(true);
}

// ── an entry point under test ───────────────────────────────────────────────

interface CellCtx {
  base: string;
  mid: string;
  deviceId: string;
  kp: KeyPair;
  /** The configured long-lived token, when the cell configures one. */
  token: string | undefined;
  dir: string;
  lines: string[];
}

interface Started {
  runtime: MotebitRuntime;
  store: EventStoreAdapter;
  db: MotebitDatabase;
  /** delegate only: the command finishes (the relay is up by then). */
  finish?(): Promise<void>;
  stop(): Promise<void>;
}

type Entry = "repl" | "run" | "serve" | "delegate";

function daemonRuntime(ctx: CellCtx, db: MotebitDatabase, syncUrl: string | undefined) {
  return new MotebitRuntime(cliRuntimeConfig({ motebitId: ctx.mid }, { syncUrl }), {
    storage: buildStorageAdapters(db),
    renderer: new NullRenderer(),
  });
}

const device = (ctx: CellCtx) => ({
  motebitId: ctx.mid,
  deviceId: ctx.deviceId,
  publicKeyHex: hex(ctx.kp),
});

async function startDaemon(ctx: CellCtx, which: "run" | "serve"): Promise<Started> {
  const db = await openMotebitDatabase(join(ctx.dir, "motebit.db"));
  const runtime = daemonRuntime(ctx, db, ctx.base);
  const relaySync = await createDaemonRelaySync({
    syncUrl: ctx.base,
    motebitId: ctx.mid,
    deviceId: ctx.deviceId,
    privateKey: () => ctx.kp.privateKey,
    ...(ctx.token != null ? { configuredToken: ctx.token } : {}),
  });
  // Both daemons register (bootstrap → register) before their push starts.
  const registration = await registerWithRelay({
    syncUrl: ctx.base,
    identity: { ...device(ctx), privateKey: ctx.kp.privateKey },
    registration: {
      motebit_id: ctx.mid,
      endpoint_url: ctx.base,
      capabilities: [],
      metadata: { name: `962h-${which}` },
    },
    toolNames: [],
    description: `962h-${which}`,
    log: () => {},
  });
  const opts = {
    syncUrl: ctx.base,
    log: (l: string) => ctx.lines.push(l),
    device: device(ctx),
    pushIntervalMs: PUSH_MS,
  };
  const push =
    which === "run"
      ? startRunEventSync(runtime, relaySync, opts)
      : startServeEventSync(runtime, relaySync, opts);
  return {
    runtime,
    store: db.eventStore,
    db,
    async stop() {
      push.stop();
      registration.stop();
      runtime.stop();
    },
  };
}

const ENTRIES: Record<Entry, (ctx: CellCtx) => Promise<Started>> = {
  async repl(ctx) {
    const { runtime, moteDb } = await createRuntime(
      {
        ...parseCliArgs([]),
        provider: "local-server",
        syncUrl: ctx.base,
        syncToken: ctx.token,
        dbPath: join(ctx.dir, "motebit.db"),
      },
      ctx.mid,
      new InMemoryToolRegistry(),
      [],
      undefined,
      await deriveSyncEncryptionKey(ctx.kp.privateKey),
      undefined,
      { deviceId: ctx.deviceId, privateKey: () => ctx.kp.privateKey },
    );
    const push = await replStartupSync({
      runtime,
      syncUrl: ctx.base,
      motebitId: ctx.mid,
      eventStore: moteDb.eventStore,
      device: { deviceId: ctx.deviceId, publicKeyHex: hex(ctx.kp) },
      log: (l) => ctx.lines.push(l),
      warn: (l) => ctx.lines.push(l),
      pushIntervalMs: PUSH_MS,
    });
    return {
      runtime,
      store: moteDb.eventStore,
      db: moteDb,
      async stop() {
        push.stop();
        runtime.stop();
      },
    };
  },
  run: (ctx) => startDaemon(ctx, "run"),
  serve: (ctx) => startDaemon(ctx, "serve"),
  async delegate(ctx) {
    const db = await openMotebitDatabase(join(ctx.dir, "motebit.db"));
    const runtime = daemonRuntime(ctx, db, ctx.base);
    const sync = await openDelegateEventSync(runtime, {
      syncUrl: ctx.base,
      log: (l) => ctx.lines.push(l),
      device: device(ctx),
      privateKey: () => ctx.kp.privateKey,
      ...(ctx.token != null ? { configuredToken: ctx.token } : {}),
      pushIntervalMs: PUSH_MS,
    });
    return {
      runtime,
      store: db.eventStore,
      db,
      finish: () => sync.close(),
      async stop() {
        await sync.close();
        runtime.stop();
      },
    };
  },
};

/**
 * Compaction runs from 1 000 events by default (every entry point's); the
 * harness appends a dozen, so it lowers the threshold — the only knob it
 * turns. What compaction may delete is still decided by the runtime's floor.
 */
function lowerCompactionThreshold(runtime: MotebitRuntime): void {
  (runtime as unknown as { compactionThreshold: number }).compactionThreshold = 5;
}

// ── the checks ──────────────────────────────────────────────────────────────

async function appendEvents(store: EventStoreAdapter, mid: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    await store.appendWithClock!({
      event_id: id,
      motebit_id: mid as never,
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { i },
      tombstoned: false,
    });
  }
  return ids;
}

async function localIds(store: EventStoreAdapter, mid: string): Promise<Set<string>> {
  return new Set((await store.query({ motebit_id: mid as never })).map((e) => e.event_id));
}

async function relayIds(relay: ServedRelay | undefined, mid: string): Promise<Set<string>> {
  if (!relay) return new Set();
  const held = await relay.relay.moteDb.eventStore.query({ motebit_id: mid as never });
  return new Set(held.map((e) => e.event_id));
}

/** Safety: every appended event is still local, or the relay holds it. */
async function assertNothingUnacknowledgedLost(
  s: Started,
  relay: ServedRelay | undefined,
  mid: string,
  appended: string[],
): Promise<void> {
  const local = await localIds(s.store, mid);
  const held = await relayIds(relay, mid);
  const lost = appended.filter((id) => !local.has(id) && !held.has(id));
  expect(lost, "events deleted before any relay acknowledged them").toEqual([]);
}

/** A sync line naming a failure — the surfaced refusal. */
const SURFACED = /sync|push/i;
const FAILED = /fail|refus|unreachable|offline|could not|401|403/i;
const surfaced = (lines: string[]): boolean =>
  lines.some((l) => SURFACED.test(l) && FAILED.test(l));

async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await sleep(100);
  }
  return pred();
}

// ── the matrix ──────────────────────────────────────────────────────────────

type Identity = "fresh" | "bootstrapped";
type Reach = "up" | "down→up";
type Token = "token" | "no-token";

const ENTRY_NAMES: Entry[] = ["repl", "run", "serve", "delegate"];
const IDENTITIES: Identity[] = ["fresh", "bootstrapped"];
const REACHES: Reach[] = ["up", "down→up"];
const TOKENS: Token[] = ["token", "no-token"];

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

async function newCell(token: string | undefined): Promise<{
  ctx: CellCtx;
  port: CellPort;
  relayDb: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "motebit-962h-"));
  const port = await holdPort();
  cleanups.push(() => port.close());
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  return {
    ctx: {
      base: `http://127.0.0.1:${port.port}`,
      mid,
      deviceId: `${mid}-dev`,
      kp,
      token,
      dir,
      lines: [],
    },
    port,
    relayDb: join(dir, "relay.db"),
  };
}

describe("#962 — every configured CLI entry point gets its pushes acknowledged", () => {
  const cells: Array<[Entry, Identity, Reach, Token]> = [];
  for (const e of ENTRY_NAMES)
    for (const i of IDENTITIES)
      for (const r of REACHES) for (const t of TOKENS) cells.push([e, i, r, t]);

  it.concurrent.each(cells)(
    "%s | %s | %s | %s",
    async (entry, identity, reach, token) => {
      const { ctx, port, relayDb } = await newCell(token === "token" ? MASTER : undefined);
      const refusals: Refusals = { count: 0 };
      let relay: ServedRelay | undefined;
      cleanups.push(async () => {
        await relay?.close();
      });
      if (identity === "bootstrapped") {
        relay = await startRelay(port, relayDb, refusals);
        await bootstrap(ctx.base, ctx.mid, ctx.deviceId, ctx.kp);
        if (reach === "down→up") {
          await relay.close();
          relay = undefined;
        }
      } else if (reach === "up") {
        relay = await startRelay(port, relayDb, refusals);
      }

      const s = await ENTRIES[entry](ctx);
      cleanups.push(() => s.stop());
      lowerCompactionThreshold(s.runtime);
      const appended = await appendEvents(s.store, ctx.mid, 12);

      if (reach === "down→up") {
        await sleep(DOWN_MS);
        // Safety while nothing can be acknowledged: compaction deletes nothing.
        await s.runtime.compact();
        await assertNothingUnacknowledgedLost(s, undefined, ctx.mid, appended);
        // …and the failure is surfaced, never silent.
        expect(
          await waitFor(async () => surfaced(ctx.lines), LIVE_MS),
          `no sync failure surfaced while the relay was down; lines: ${JSON.stringify(ctx.lines)}`,
        ).toBe(true);
        relay = await startRelay(port, relayDb, refusals);
      }
      await s.finish?.();

      // Liveness: acknowledged within the bound, with no user action.
      const latest = await s.store.getLatestClock(ctx.mid);
      const acked = await waitFor(async () => {
        const held = await relayIds(relay, ctx.mid);
        if (!appended.every((id) => held.has(id))) return false;
        return (await pushCompactionFloor(s.store, latest, { syncConfigured: true })) >= latest;
      }, LIVE_MS);
      expect(
        acked,
        `events never acknowledged by the relay; lines: ${JSON.stringify(ctx.lines)}`,
      ).toBe(true);
      // Compaction runs below the floor, and loses nothing unacknowledged.
      expect(await s.runtime.compact()).toBeGreaterThan(0);
      await assertNothingUnacknowledgedLost(s, relay, ctx.mid, appended);
      // Order: a relay reachable from the start never refuses a push — the
      // device's key is introduced (bootstrap / registration) BEFORE the
      // first push (#962 round 3 C2).
      if (reach === "up") expect(refusals.count, "a push refused for want of a bootstrap").toBe(0);
    },
    CELL_TIMEOUT,
  );

  it.concurrent.each(ENTRY_NAMES)(
    "%s | bootstrapped | up | REFUSED (wrong token): surfaced, nothing deleted",
    async (entry) => {
      const { ctx, port, relayDb } = await newCell("wrong-token-962h");
      const relay = await startRelay(port, relayDb);
      cleanups.push(() => relay.close());
      await bootstrap(ctx.base, ctx.mid, ctx.deviceId, ctx.kp);
      const s = await ENTRIES[entry](ctx);
      cleanups.push(() => s.stop());
      lowerCompactionThreshold(s.runtime);
      const appended = await appendEvents(s.store, ctx.mid, 12);
      await s.finish?.();
      expect(
        await waitFor(async () => surfaced(ctx.lines), LIVE_MS),
        `the refusal was never surfaced; lines: ${JSON.stringify(ctx.lines)}`,
      ).toBe(true);
      expect(await s.runtime.compact()).toBe(0);
      await assertNothingUnacknowledgedLost(s, relay, ctx.mid, appended);
    },
    CELL_TIMEOUT,
  );

  it.concurrent.each([
    ["run", "no sync URL", undefined, "run"],
    ["serve", "stdio transport, no relay named anywhere", undefined, "stdio"],
  ] as const)(
    "%s | no relay configured (%s): sync is not configured, compaction is not held",
    async (_entry, _why, flag, transport) => {
      const { ctx } = await newCell(undefined);
      const db = await openMotebitDatabase(join(ctx.dir, "motebit.db"));
      // The relay each daemon resolves (none), passed as the daemons pass it.
      const relay = daemonRelay({ syncUrl: flag }, {}, transport);
      expect(relay.syncUrl).toBeUndefined();
      const runtime = new MotebitRuntime(cliRuntimeConfig({ motebitId: ctx.mid }, relay), {
        storage: buildStorageAdapters(db),
        renderer: new NullRenderer(),
      });
      cleanups.push(async () => runtime.stop());
      lowerCompactionThreshold(runtime);
      await appendEvents(db.eventStore, ctx.mid, 12);
      expect(await runtime.isSyncConfigured()).toBe(false);
      expect(await runtime.compact()).toBeGreaterThan(0);
    },
  );

  // #962 round 5: `serve` over stdio pushes to no relay, but a relay NAMED
  // for it (flag, env or config.json) makes the identity configured — its
  // events wait for a relay's acknowledgment (another process pushes them).
  it.concurrent.each([
    ["--sync-url", { syncUrl: "http://relay.zz962h.test" }, {}],
    ["config.json sync_url", { syncUrl: undefined }, { sync_url: "http://relay.zz962h.test" }],
  ] as const)(
    "serve | stdio transport with a relay named (%s): the identity is configured, compaction is held",
    async (_why, flags, fullConfig) => {
      const { ctx } = await newCell(undefined);
      const db = await openMotebitDatabase(join(ctx.dir, "motebit.db"));
      const relay = daemonRelay(flags, fullConfig, "stdio");
      // It reaches no relay itself…
      expect(relay.syncUrl).toBeUndefined();
      const runtime = new MotebitRuntime(cliRuntimeConfig({ motebitId: ctx.mid }, relay), {
        storage: buildStorageAdapters(db),
        renderer: new NullRenderer(),
      });
      cleanups.push(async () => runtime.stop());
      lowerCompactionThreshold(runtime);
      await appendEvents(db.eventStore, ctx.mid, 12);
      // …but nothing it wrote is deleted before a relay acknowledged it.
      expect(await runtime.compact()).toBe(0);
    },
  );
});

// ── #962 round 5: sync intent belongs to the DATABASE, across processes ─────
//
// Rounds 2–4 decided "is sync configured?" per PROCESS; the events it
// protects belong to the database's identity. Here two processes share ONE
// `motebit.db` — process A writes (and compacts, as `runtime.stop()` does),
// then process B, another entry point, writes and compacts — with the relay
// unreachable throughout; the relay comes up later and the REPL pushes. The
// law: once ANY process for this identity was configured for a relay, no
// event is deleted before a relay acknowledged it. Only a database whose
// identity was NEVER configured compacts freely.

/** The processes of the cross-process dimension. */
type Proc = "repl" | "repl-bootstrap" | "serve-stdio" | "run" | "delegate";
/** Does the identity's config.json name a relay? */
type Cfg = "config-sync_url" | "no-config";

interface XCell {
  ctx: CellCtx;
  port: CellPort;
  relayDb: string;
  dbPath: string;
  fullConfig: { sync_url?: string };
}

const PASS = "pass-962x";

/**
 * One process on the cell's `motebit.db`: runs, writes, compacts, exits.
 * Returns every event id of the identity the database held BEFORE this
 * process compacted — what the safety check accounts for.
 */
async function runProcess(x: XCell, proc: Proc): Promise<string[]> {
  const { ctx } = x;
  if (proc === "repl-bootstrap") {
    // The REPL's first launch: the identity is minted into motebit.db
    // before any runtime or sync (and the REPL may then attach to a running
    // daemon as a frontend, never connecting sync itself).
    const full = { ...x.fullConfig } as import("../config.js").FullConfig;
    const { motebitId } = await bootstrapReplIdentity({
      dbPath: x.dbPath,
      fullConfig: full,
      passphrase: PASS,
    });
    const priv = fromHex(await decryptPrivateKey(full.cli_encrypted_key!, PASS));
    ctx.mid = motebitId;
    ctx.deviceId = full.device_id!;
    ctx.kp = { publicKey: fromHex(full.device_public_key!), privateKey: priv };
    return [...(await dbIds(x.dbPath, ctx.mid))];
  }
  let s: Started;
  if (proc === "repl" || proc === "delegate") {
    s = await ENTRIES[proc](ctx);
  } else {
    const db = await openMotebitDatabase(x.dbPath);
    // Exactly the relay wiring the daemon resolves from its flags + config.
    const relay = daemonRelay(
      { syncUrl: undefined },
      x.fullConfig,
      proc === "run" ? "run" : "stdio",
    );
    const runtime = new MotebitRuntime(cliRuntimeConfig({ motebitId: ctx.mid }, relay), {
      storage: buildStorageAdapters(db),
      renderer: new NullRenderer(),
    });
    let push: { stop(): void } | undefined;
    if (relay.syncUrl) {
      const relaySync = await createDaemonRelaySync({
        syncUrl: relay.syncUrl,
        motebitId: ctx.mid,
        deviceId: ctx.deviceId,
        privateKey: () => ctx.kp.privateKey,
      });
      push = startRunEventSync(runtime, relaySync, {
        syncUrl: relay.syncUrl,
        log: (l) => ctx.lines.push(l),
        device: device(ctx),
        pushIntervalMs: PUSH_MS,
      });
    }
    s = {
      runtime,
      store: db.eventStore,
      db,
      async stop() {
        push?.stop();
        runtime.stop();
      },
    };
  }
  lowerCompactionThreshold(s.runtime);
  await appendEvents(s.store, ctx.mid, 10);
  await s.finish?.();
  const written = [...(await localIds(s.store, ctx.mid))];
  // What `runtime.stop()`'s autoCompact would do, awaited.
  await s.runtime.compact();
  await s.stop();
  await sleep(50);
  s.db.close();
  return written;
}

/** Every event id of the identity the database holds now. */
async function dbIds(dbPath: string, mid: string): Promise<Set<string>> {
  const db = await openMotebitDatabase(dbPath);
  try {
    return await localIds(db.eventStore, mid);
  } finally {
    db.close();
  }
}

/** Is this process configured for a relay for this identity (in its own right)? */
function configures(proc: Proc, cfg: Cfg): boolean {
  if (proc === "repl" || proc === "repl-bootstrap" || proc === "delegate") return true;
  // A daemon whose identity's config names a relay: `run` pushes to it; a
  // stdio `serve` does not reach it, but the identity is configured.
  return cfg === "config-sync_url";
}

/** The REPL, the relay reachable at last: pushes; everything local reaches the relay. */
async function replPushesLater(x: XCell): Promise<{ relay: ServedRelay; held: Set<string> }> {
  const relay = await startRelay(x.port, x.relayDb);
  cleanups.push(() => relay.close());
  const s = await ENTRIES.repl(x.ctx);
  cleanups.push(() => s.stop());
  const latest = await s.store.getLatestClock(x.ctx.mid);
  const done = await waitFor(
    async () => (await pushCompactionFloor(s.store, latest, { syncConfigured: true })) >= latest,
    LIVE_MS,
  );
  expect(done, `the REPL's push was never acknowledged; ${JSON.stringify(x.ctx.lines)}`).toBe(true);
  const held = await relayIds(relay, x.ctx.mid);
  await s.stop();
  return { relay, held };
}

async function newXCell(cfg: Cfg): Promise<XCell> {
  const { ctx, port, relayDb } = await newCell(undefined);
  return {
    ctx,
    port,
    relayDb,
    dbPath: join(ctx.dir, "motebit.db"),
    fullConfig: cfg === "config-sync_url" ? { sync_url: ctx.base } : {},
  };
}

describe.sequential("#962 round 5 — sync intent is the database's, across processes", () => {
  const PROCS_A: Proc[] = ["repl", "repl-bootstrap", "serve-stdio", "run", "delegate"];
  const PROCS_B: Proc[] = ["repl", "serve-stdio", "run", "delegate"];
  const CFGS: Cfg[] = ["config-sync_url", "no-config"];
  const xcells: Array<[Proc, Proc, Cfg]> = [];
  for (const a of PROCS_A)
    for (const b of PROCS_B) if (a !== b) for (const c of CFGS) xcells.push([a, b, c]);

  it.each(xcells)(
    "A=%s writes, then B=%s writes + compacts | %s | relay reachable later",
    async (a, b, cfg) => {
      const x = await newXCell(cfg);
      // The events the law protects: everything on the database from the
      // moment the first configured process for this identity started. An
      // unconfigured process that compacted BEFORE any was configured
      // compacted a never-configured database — allowed.
      const appended = new Set<string>();
      let configuredYet = false;
      for (const proc of [a, b]) {
        configuredYet ||= configures(proc, cfg);
        const before = proc === "repl-bootstrap" ? [] : [...(await dbIds(x.dbPath, x.ctx.mid))];
        const written = await runProcess(x, proc);
        if (configuredYet) for (const id of [...before, ...written]) appended.add(id);
      }
      const configured = configuredYet;
      if (!configured) {
        // Never configured: compaction ran free (and nothing to push).
        expect((await dbIds(x.dbPath, x.ctx.mid)).size).toBeLessThan(20);
        return;
      }
      const { held } = await replPushesLater(x);
      const local = await dbIds(x.dbPath, x.ctx.mid);
      const lost = [...appended].filter((id) => !local.has(id) && !held.has(id));
      expect(lost, "events deleted before any relay acknowledged them").toEqual([]);
      expect(appended.size).toBeGreaterThanOrEqual(10);
    },
    CELL_TIMEOUT,
  );

  // The round-4 cold reviewer's exact probe P6: the REPL's first launch
  // mints the identity (config.json naming a relay, or the REPL's default
  // relay) without connecting sync; then a no-relay daemon — `serve` over
  // stdio — writes 20 events and compacts; later the REPL pushes. On
  // a00b5a298 compaction deleted 19 of 20 and the relay held 1.
  it.each(["config-sync_url", "no-config"] as const)(
    "P6 | REPL first launch (%s), stdio serve writes 20 + compacts, REPL pushes later: the relay holds all 20",
    async (cfg) => {
      const x = await newXCell(cfg);
      await runProcess(x, "repl-bootstrap");
      const db = await openMotebitDatabase(x.dbPath);
      const relay = daemonRelay({ syncUrl: undefined }, x.fullConfig, "stdio");
      const runtime = new MotebitRuntime(cliRuntimeConfig({ motebitId: x.ctx.mid }, relay), {
        storage: buildStorageAdapters(db),
        renderer: new NullRenderer(),
      });
      lowerCompactionThreshold(runtime);
      const twenty = await appendEvents(db.eventStore, x.ctx.mid, 20);
      // What `runtime.stop()`'s autoCompact would do, awaited.
      await runtime.compact();
      runtime.stop();
      await sleep(50);
      db.close();
      const { held } = await replPushesLater(x);
      expect(
        twenty.filter((id) => held.has(id)).length,
        "events the relay holds of the 20 the daemon wrote",
      ).toBe(20);
    },
    CELL_TIMEOUT,
  );
});
