/**
 * #962 C1 — the default REPL (no MOTEBIT_API_TOKEN, no --sync-token) against
 * a REAL relay with device auth on (`enableDeviceAuth` defaults true).
 *
 * The REPL's event remote presented only the configured token — none — so
 * the relay refused every push (401), the push cursor never left 0, and with
 * compaction floored at that cursor `motebit.db` grew without bound. It now
 * authenticates like the daemon: a `sync` device token minted from the
 * identity key per request, after the device's key is introduced to the relay.
 *
 * Driven through what the REPL runs: `createRuntime` (the runtime and the
 * remote it connects), `bootstrapReplDevice`, `syncFailureLine`, and
 * `createReplEventRemote` under a real `MotebitRuntime` over SQLite.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-962-cfg-"));
});

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
import { createMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import { pushCompactionFloor } from "@motebit/sync-engine";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import {
  createRuntime,
  createReplEventRemote,
  bootstrapReplDevice,
  syncFailureLine,
  buildStorageAdapters,
  InMemoryToolRegistry,
} from "../runtime-factory.js";
import { parseCliArgs } from "../args.js";

const MASTER = "test-token-962";
const BASE = "http://relay.zz962.test";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay | undefined;
let realFetch: typeof globalThis.fetch | undefined;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
  if (relay) await relay.close();
  relay = undefined;
  vi.restoreAllMocks();
});

/** An in-process relay; every fetch to BASE reaches it. Device auth is ON (the default). */
async function startRelay(): Promise<void> {
  relay = await createSyncRelay({
    apiToken: MASTER,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return relay!.app.request(url.replace(BASE, ""), init);
  }) as typeof globalThis.fetch;
}

async function identity(): Promise<{ mid: string; deviceId: string; kp: KeyPair }> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  return { mid, deviceId: `${mid}-repl`, kp };
}

/** The bootstrap the REPL sends before its first push (index.ts). */
async function bootstrap(mid: string, deviceId: string, kp: KeyPair): Promise<void> {
  const resp = await fetch(`${BASE}/api/v1/agents/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motebit_id: mid, device_id: deviceId, public_key: hex(kp) }),
  });
  expect(resp.ok).toBe(true);
}

async function appendEvents(db: MotebitDatabase, mid: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.eventStore.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: mid as never,
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { i },
      tombstoned: false,
    });
  }
}

describe("#962 C1 — the default REPL's push is accepted by a relay with device auth", () => {
  it("createRuntime's remote authenticates with a device token: the push cursor advances", async () => {
    await startRelay();
    const { mid, deviceId, kp } = await identity();
    await bootstrap(mid, deviceId, kp);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = {
      ...parseCliArgs([]),
      provider: "local-server" as const,
      syncUrl: BASE,
      syncToken: undefined,
      dbPath: join(mkdtempSync(join(tmpdir(), "motebit-962-db-")), "motebit.db"),
    };
    const { runtime, moteDb } = await createRuntime(
      config,
      mid,
      new InMemoryToolRegistry(),
      [],
      undefined,
      await deriveSyncEncryptionKey(kp.privateKey),
      undefined,
      { deviceId, privateKey: () => kp.privateKey },
    );
    cleanups.push(() => moteDb.close());

    await appendEvents(moteDb, mid, 20);
    const latest = await moteDb.eventStore.getLatestClock(mid);
    await runtime.sync.sync();

    // What compaction reads: the relay acknowledged every event.
    expect(await pushCompactionFloor(moteDb.eventStore, latest, { syncConfigured: true })).toBe(
      latest,
    );
    expect(syncFailureLine(runtime.sync)).toBeNull();
  });

  it("three cycles of 50 appends -> sync -> compact(): each cycle compacts, the log stays bounded", async () => {
    await startRelay();
    const { mid, deviceId, kp } = await identity();
    await bootstrap(mid, deviceId, kp);
    const db = createMotebitDatabase(":memory:");
    cleanups.push(() => db.close());
    const runtime = new MotebitRuntime(
      { motebitId: mid, compactionThreshold: 10, syncConfigured: true },
      { storage: buildStorageAdapters(db), renderer: new NullRenderer() },
    );
    // The remote the REPL connects, with the credentials the REPL passes.
    const { remote } = createReplEventRemote({
      syncUrl: BASE,
      motebitId: mid,
      syncToken: undefined,
      encKey: await deriveSyncEncryptionKey(kp.privateKey),
      deviceId,
      privateKey: () => kp.privateKey,
    });
    runtime.connectSync(remote);

    const counts: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await appendEvents(db, mid, 50);
      await runtime.sync.sync();
      const deleted = await runtime.compact();
      expect(deleted).toBeGreaterThan(0);
      counts.push(await db.eventStore.countEvents(mid));
    }
    // Compaction keeps the latest event; the log does not grow 50 -> 100 -> 150.
    expect(Math.max(...counts)).toBeLessThan(50);
  });

  it("a device the relay refuses still pins compaction, and the refusal is one line, never silent", async () => {
    await startRelay();
    // Never introduced to the relay: its device tokens do not verify.
    const { mid, deviceId, kp } = await identity();
    const db = createMotebitDatabase(":memory:");
    cleanups.push(() => db.close());
    const runtime = new MotebitRuntime(
      { motebitId: mid, compactionThreshold: 10, syncConfigured: true },
      { storage: buildStorageAdapters(db), renderer: new NullRenderer() },
    );
    const { remote } = createReplEventRemote({
      syncUrl: BASE,
      motebitId: mid,
      syncToken: undefined,
      encKey: await deriveSyncEncryptionKey(kp.privateKey),
      deviceId,
      privateKey: () => kp.privateKey,
    });
    runtime.connectSync(remote);

    await appendEvents(db, mid, 50);
    await runtime.sync.sync();
    // Nothing the relay has not acknowledged is deleted…
    expect(await runtime.compact()).toBe(0);
    expect(await db.eventStore.countEvents(mid)).toBe(50);
    // …and the refusal is surfaced as the one line the REPL prints.
    const line = syncFailureLine(runtime.sync);
    expect(line).toMatch(/^Sync failed \(continuing offline\): Push failed: 40[13]/);
  });

  it("bootstrapReplDevice introduces the key the REPL's device tokens are verified against", async () => {
    await startRelay();
    const { mid, deviceId, kp } = await identity();
    expect(
      await bootstrapReplDevice({ syncUrl: BASE, motebitId: mid, deviceId, publicKeyHex: hex(kp) }),
    ).toBeNull();
    const db = createMotebitDatabase(":memory:");
    cleanups.push(() => db.close());
    const runtime = new MotebitRuntime(
      { motebitId: mid, compactionThreshold: 10, syncConfigured: true },
      { storage: buildStorageAdapters(db), renderer: new NullRenderer() },
    );
    const { remote } = createReplEventRemote({
      syncUrl: BASE,
      motebitId: mid,
      syncToken: undefined,
      encKey: undefined,
      deviceId,
      privateKey: () => kp.privateKey,
    });
    runtime.connectSync(remote);
    await appendEvents(db, mid, 12);
    await runtime.sync.sync();
    expect(syncFailureLine(runtime.sync)).toBeNull();
    expect(await runtime.compact()).toBeGreaterThan(0);
  });
});
