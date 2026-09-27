/**
 * #816 acceptance: the spatial sync controller across every interleaving of
 * lifecycle operations (see ./interleaving-harness.ts), compared cell by
 * cell with origin/main's controller.
 *
 * Spatial has no relay-key await; the harness latency applies to its
 * pre-socket await instead (the discovery bootstrap POST). A bailing start
 * is a `connectRelay` that returns at its first check (no relay configured
 * at the moment of the call).
 *
 * Baseline: `interleaving-baseline.main.json`. To regenerate: check out
 * origin/main's `apps/spatial/src/sync-controller.ts` and
 * `packages/sync-engine/src/ws-adapter.ts`, rebuild `@motebit/sync-engine`,
 * run this file with `INTERLEAVING_RECORD=src/__tests__/interleaving-baseline.main.json`,
 * restore both files and rebuild.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    verifyAgentCommandEnvelope: vi.fn(async () => ({ ok: true })),
    executeRemoteCommand: vi.fn(async (_rt: unknown, command: string) => ({
      summary: `ran ${command}`,
    })),
    cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  };
});

// Deterministic crypto: real WebCrypto resolves on the real event loop, which
// the fake clock cannot step, so outcomes would depend on host speed.
vi.mock("@motebit/encryption", async () => {
  const actual = await vi.importActual<object>("@motebit/encryption");
  return {
    ...actual,
    deriveSyncEncryptionKey: async () => new Uint8Array(32),
    secureErase: () => {},
    encrypt: async (plaintext: Uint8Array) => ({
      ciphertext: plaintext,
      nonce: new Uint8Array(12),
      tag: new Uint8Array(16),
    }),
    decrypt: async (payload: { ciphertext: Uint8Array }) => payload.ciphertext,
  };
});

import { SpatialSyncController } from "../sync-controller";
import type { SpatialSyncControllerDeps } from "../sync-controller";
import {
  LATENCIES,
  RelaySocket,
  cellKey,
  compare,
  fs,
  unattributed,
  harnessEnv,
  relayKeyDelay,
  relayPull,
  runCell,
  sequences,
  type CellResult,
  type Driver,
  type HarnessEnv,
  type Latency,
  type Op,
} from "./interleaving-harness";

const MAX_OPS = Number(harnessEnv["INTERLEAVING_MAX_OPS"] ?? 3);
const RECORD = harnessEnv["INTERLEAVING_RECORD"];
const BASELINE = new URL("./interleaving-baseline.main.json", import.meta.url);
const BASELINE_REAPED = new URL("./interleaving-baseline.main-reaped.json", import.meta.url);
/** Record main with zombie sockets black-holed (see interleaving-harness.ts). */
const REAP = harnessEnv["INTERLEAVING_REAP"] === "1";

function makeDriver(env: HarnessEnv): Driver {
  let relayUrl = "";
  let stopped = true;
  const remotes: Array<{ append(e: unknown): Promise<void> }> = [];
  const unsynced: string[] = [];
  const flush = async () => {
    const remote = remotes[remotes.length - 1];
    if (stopped || !remote) return;
    while (unsynced.length > 0) {
      const eventId = unsynced.shift()!;
      await remote.append({
        event_id: eventId,
        motebit_id: "motebit-1",
        device_id: "device-1",
        timestamp: 1,
        event_type: "state_updated",
        payload: { n: eventId },
        version_clock: 1,
        tombstoned: false,
      });
    }
  };
  const runtime = {
    getToolRegistry: () => ({ list: () => [] }),
    setDelegationAdapter: vi.fn(),
    connectSync: vi.fn((r: { append(e: unknown): Promise<void> }) => {
      remotes.push(r);
      void flush();
    }),
    startSync: vi.fn(),
    sync: { onStatusChange: vi.fn(() => () => {}), stop: vi.fn() },
    getPrecision: () => ({ explorationDrive: 0 }),
    recoverDelegatedSteps: async function* () {},
  };
  const store = new InMemoryEventStore();
  let minted = 0;
  let bootstrapCalls = 0;
  const deps: SpatialSyncControllerDeps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRuntime: () => runtime as any,
    getMotebitId: () => "motebit-1",
    getDeviceId: () => "device-1",
    getPublicKey: () => "a".repeat(64),
    getNetworkSettings: () => ({ relayUrl, showNetwork: true }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStorage: () => ({ eventStore: store }) as any,
    getPlanStore: () => null,
    getPrivKey: () => new Uint8Array(32).fill(7),
    clearPrivKey: () => {},
    getTokenFactory: () => async () => `minted-${++minted}`,
  };
  const ctrl = new SpatialSyncController(deps);
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/v1/agents/bootstrap")) {
      bootstrapCalls++;
      await relayKeyDelay(env.latency);
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    }
    if (u.includes("/sync/")) {
      env.httpSyncs.push({ at: Date.now(), url: u });
      const events = u.includes("/pull") ? relayPull(u) : [];
      return { ok: true, status: 200, text: async () => "", json: async () => ({ events }) };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  }) as unknown as typeof fetch;
  void bootstrapCalls;

  return {
    start(relay, { bail }) {
      if (bail) {
        // A start that returns at its first (synchronous) check: no relay
        // configured at the moment of the call.
        const saved = relayUrl;
        relayUrl = "";
        void ctrl.connectRelay().catch(() => {});
        relayUrl = saved;
        return;
      }
      relayUrl = relay;
      stopped = false;
      void ctrl.connectRelay().catch(() => {});
    },
    stop() {
      stopped = true;
      remotes.length = 0;
      void ctrl.disconnectRelay().catch(() => {});
    },
    async appendEvent(eventId) {
      unsynced.push(eventId);
      await flush();
    },
    async commandFrame(id) {
      return { type: "command_request", id, command: "state" };
    },
    async localEventIds() {
      return (await store.query({ motebit_id: "motebit-1" })).map((e) => e.event_id);
    },
  };
}

async function runMatrix(): Promise<Record<string, CellResult>> {
  const results: Record<string, CellResult> = {};
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = RelaySocket as unknown as typeof WebSocket;
  try {
    for (const seq of sequences(MAX_OPS) as Op[][]) {
      for (const latency of LATENCIES as readonly Latency[]) {
        const only = harnessEnv["INTERLEAVING_ONLY"];
        if (only && cellKey(seq, latency) !== only) continue;
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
        });
        const env: HarnessEnv = { latency, httpSyncs: [] };
        const driver = makeDriver(env);
        results[cellKey(seq, latency)] = await runCell(seq, env, driver, { reap: REAP });
        driver.stop();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
  return results;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("spatial sync controller — differential interleaving matrix (#816)", () => {
  it(
    "is never worse than origin/main (reaped) in any cell, opens no zombie socket, and every raw-main win is a zombie's",
    async () => {
      const results = await runMatrix();
      const io = await fs();
      if (RECORD) {
        io.writeFileSync(RECORD, JSON.stringify(results, null, 1) + "\n");
        return;
      }
      const load = (url: URL) =>
        JSON.parse(io.readFileSync(url, "utf-8")) as Record<string, CellResult>;
      const mainReaped = load(BASELINE_REAPED);
      const mainRaw = load(BASELINE);
      const opts = { periodicHttp: false };
      const cmp = compare(results, mainReaped, opts);
      const rawWinsWithoutZombie = unattributed(results, mainRaw, opts);
      if (harnessEnv["INTERLEAVING_REPORT"]) {
        const raw = compare(results, mainRaw, opts);
        io.writeFileSync(
          harnessEnv["INTERLEAVING_REPORT"],
          JSON.stringify(
            {
              cells: cmp.cells,
              reaped: { mainBetter: cmp.mainBetter, branchBetter: cmp.branchBetter.length },
              raw: { mainBetter: raw.mainBetter, branchBetter: raw.branchBetter.length },
              rawWinsWithoutZombie,
              invariantBreaks: cmp.invariantBreaks,
            },
            null,
            1,
          ),
        );
      }
      expect(cmp.cells).toBe(Object.keys(mainReaped).length);
      expect(cmp.invariantBreaks).toEqual([]);
      expect(cmp.mainBetter).toEqual([]);
      expect(rawWinsWithoutZombie).toEqual([]);
    },
    30 * 60_000,
  );
});
