/**
 * #816 acceptance: the desktop sync controller across every interleaving of
 * lifecycle operations (see @motebit/sync-engine/testing), compared cell by
 * cell with origin/main's controller.
 *
 * Baseline: `interleaving-baseline.main.json` holds main's per-cell results.
 * To regenerate it: check out origin/main's `apps/desktop/src/sync-controller.ts`
 * and `packages/sync-engine/src/ws-adapter.ts` into this tree, rebuild
 * `@motebit/sync-engine`, and run this file with
 * `INTERLEAVING_RECORD=src/__tests__/interleaving-baseline.main.json`; then
 * restore both files and rebuild. The harness drives only the controller's
 * public API, so the same file runs against either version.
 *
 * Matrix size: by default every sequence of up to 2 operation(s) (the
 * committed baselines cover exactly that). The full matrix — 3 operations,
 * 22,220 cells with four command execution times — is too slow for every
 * test run: `scripts/sync-interleavings-full.sh all desktop` records origin/main's
 * full baselines (raw and reaped) and runs this file against them
 * (`INTERLEAVING_MAX_OPS=3`, `INTERLEAVING_BASELINE_DIR`). Its result on
 * #816, against main reaped: 0 cells worse, 0 invariant breaks.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";

// The cell's command execution time; the executor below waits it out.
const cellCommand = vi.hoisted(() => ({ durationMs: 0 }));

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    verifyAgentCommandEnvelope: vi.fn(async () => ({ ok: true })),
    executeRemoteCommand: vi.fn(async (_rt: unknown, command: string) => {
      if (cellCommand.durationMs > 0) {
        await new Promise((r) => setTimeout(r, cellCommand.durationMs));
      }
      return { summary: `ran ${command}` };
    }),
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

import { SyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";
import {
  DURATIONS,
  LATENCIES,
  RelaySocket,
  cellKey,
  compare,
  fs,
  unattributed,
  harnessEnv,
  relayKeyDelay,
  relayPull,
  FIRST_IDENTITY,
  runCell,
  sequences,
  type CellResult,
  type Driver,
  type Duration,
  type HarnessEnv,
  type Latency,
  type Op,
  useVitest,
} from "@motebit/sync-engine/testing";

useVitest(vi);

const MAX_OPS = Number(harnessEnv["INTERLEAVING_MAX_OPS"] ?? 2);
const RECORD = harnessEnv["INTERLEAVING_RECORD"];
// `INTERLEAVING_BASELINE_DIR`: baselines recorded elsewhere (the full matrix —
// `scripts/sync-interleavings-full.sh` records them as <dir>/desktop.main.json and
// <dir>/desktop.main-reaped.json).
const BASELINE_DIR = harnessEnv["INTERLEAVING_BASELINE_DIR"];
const BASELINE = BASELINE_DIR
  ? new URL(`file://${BASELINE_DIR}/desktop.main.json`)
  : new URL("./interleaving-baseline.main.json", import.meta.url);
const BASELINE_REAPED = BASELINE_DIR
  ? new URL(`file://${BASELINE_DIR}/desktop.main-reaped.json`)
  : new URL("./interleaving-baseline.main-reaped.json", import.meta.url);

/** Record main with zombie sockets black-holed (see @motebit/sync-engine/testing). */
const REAP = harnessEnv["INTERLEAVING_REAP"] === "1";

function makeDriver(env: HarnessEnv): Driver {
  let bailNext = false;
  let stopped = true;
  let motebitId = FIRST_IDENTITY;
  const remotes: Array<{ append(e: unknown): Promise<void> }> = [];
  // The runtime's local event log, as its SyncEngine sees it: an event is
  // pushed (the cursor advances past it) the moment its remote's append
  // resolves; with no remote, or a stopped engine, it waits for the next one.
  const unsynced: Array<{ id: string; motebit: string }> = [];
  const flush = async () => {
    const remote = remotes[remotes.length - 1];
    if (stopped || !remote) return;
    while (unsynced.length > 0) {
      const { id: eventId, motebit } = unsynced.shift()!;
      await remote.append({
        event_id: eventId,
        motebit_id: motebit,
        device_id: "device-1",
        timestamp: 1,
        event_type: "state_updated",
        payload: { n: eventId },
        version_clock: 1,
        tombstoned: false,
      });
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtime: any = {
    connectSync: vi.fn((r: { append(e: unknown): Promise<void> }) => {
      remotes.push(r);
      void flush();
    }),
    startSync: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    sync: { onStatusChange: vi.fn(() => () => {}), getConflicts: vi.fn(() => []), stop: vi.fn() },
    getToolRegistry: vi.fn(() => ({ list: () => [] })),
    events: { append: vi.fn(async () => {}), getLatestClock: vi.fn(async () => 0) },
  };
  const store = new InMemoryEventStore();
  let minted = 0;
  const deps: SyncControllerDeps = {
    getRuntime: () => runtime,
    getMotebitId: () => motebitId,
    getDeviceId: () => "device-1",
    getConversationStore: () => null,
    getPlanStore: () => null,
    getLocalEventStore: () => store,
    getDeviceKeypair: async () => {
      if (bailNext) {
        bailNext = false;
        return null;
      }
      return { publicKey: "a".repeat(64), privateKey: "b".repeat(64) };
    },
    createSyncToken: async () => `minted-${++minted}.sig`,
  };
  const ctrl = new SyncController(deps);
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/.well-known/motebit.json")) {
      await relayKeyDelay(env.latency);
      return { ok: false, status: 503, text: async () => "", json: async () => ({}) };
    }
    if (u.includes("/sync/")) {
      env.httpSyncs.push({ at: Date.now(), url: u });
      const events = u.includes("/pull") ? relayPull(u) : [];
      return { ok: true, status: 200, text: async () => "", json: async () => ({ events }) };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  }) as unknown as typeof fetch;

  return {
    start(relay, { bail }) {
      bailNext = bail;
      if (!bail) stopped = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void ctrl.startSync(vi.fn() as any, relay).catch(() => {});
    },
    stop() {
      stopped = true;
      remotes.length = 0; // a stopped engine drops its remote
      ctrl.stopSync();
    },
    switchIdentity(next) {
      motebitId = next;
      unsynced.length = 0; // the old identity's log goes with it
      remotes.length = 0; // and the runtime rebinds: no push to the old identity's remote
    },
    async appendEvent(eventId, motebit) {
      unsynced.push({ id: eventId, motebit });
      await flush();
    },
    async commandFrame(id) {
      return { type: "command_request", id, command: "state" };
    },
    async localEventIds() {
      return (await store.query({ motebit_id: motebitId })).map((e) => e.event_id);
    },
  };
}

/** `INTERLEAVING_SHARD=i/n`: run only cells whose index ≡ i (mod n) — for parallel recording. */
let cellIndex = 0;
function inShard(_key: string): boolean {
  const spec = harnessEnv["INTERLEAVING_SHARD"];
  const i = cellIndex++;
  if (!spec) return true;
  const [k, n] = spec.split("/").map(Number);
  return i % n! === k;
}

async function runMatrix(): Promise<Record<string, CellResult>> {
  const results: Record<string, CellResult> = {};
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = RelaySocket as unknown as typeof WebSocket;
  try {
    for (const seq of sequences(MAX_OPS) as Op[][]) {
      for (const latency of LATENCIES as readonly Latency[]) {
        for (const duration of DURATIONS as readonly Duration[]) {
          const key = cellKey(seq, latency, duration);
          const only = harnessEnv["INTERLEAVING_ONLY"];
          if (only && key !== only) continue;
          if (!inShard(key)) continue;
          cellCommand.durationMs = duration;
          vi.useFakeTimers({
            toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
          });
          store.clear();
          const env: HarnessEnv = { latency, duration, httpSyncs: [] };
          const driver = makeDriver(env);
          results[key] = await runCell(seq, env, driver, { reap: REAP });
          driver.stop();
          vi.clearAllTimers();
          vi.useRealTimers();
        }
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

describe("desktop sync controller — differential interleaving matrix (#816)", () => {
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
      expect(cmp.cells).toBeGreaterThan(0);
      expect(cmp.invariantBreaks).toEqual([]);
      expect(cmp.mainBetter).toEqual([]);
      expect(rawWinsWithoutZombie).toEqual([]);
    },
    30 * 60_000,
  );
});
