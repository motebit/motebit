/**
 * #816 acceptance: the mobile sync controller across every interleaving of
 * lifecycle operations (see @motebit/sync-engine/testing), compared cell by
 * cell with origin/main's controller.
 *
 * Mobile runs the REAL `@motebit/sync-engine` here (engines, adapters) over
 * the fake relay: events are appended to the local event store and pushed
 * by the engine on its next 30-second cycle, over the socket or HTTP. The
 * harness latency applies to the relay-key fetch every cycle makes. A
 * bailing start is a `startSync` with no storage.
 *
 * Baseline: `interleaving-baseline.main.json`. To regenerate: check out
 * origin/main's `apps/mobile/src/sync-controller.ts` and
 * `packages/sync-engine/src/ws-adapter.ts`, rebuild `@motebit/sync-engine`,
 * run this file with `INTERLEAVING_RECORD=src/__tests__/interleaving-baseline.main.json`,
 * restore both files and rebuild.
 *
 * Matrix size: by default every sequence of up to 2 operation(s) (the
 * committed baselines cover exactly that). The full matrix — 3 operations,
 * 22,220 cells with four command execution times — is too slow for every
 * test run: `scripts/sync-interleavings-full.sh all mobile` records origin/main's
 * full baselines (raw and reaped) and runs this file against them
 * (`INTERLEAVING_MAX_OPS=3`, `INTERLEAVING_BASELINE_DIR`). Its result on
 * #816, against main reaped: 0 cells worse, 0 invariant breaks.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";

const h = vi.hoisted(() => ({ latency: 0 as number | "hung", durationMs: 0 }));

vi.mock("@motebit/runtime", () => ({
  executeRemoteCommand: vi.fn(async (_rt: unknown, command: string) => {
    if (h.durationMs > 0) await new Promise((r) => setTimeout(r, h.durationMs));
    return { summary: `ran ${command}` };
  }),
  cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  verifyAgentCommandEnvelope: vi.fn(async () => ({ ok: true })),
  RelayDelegationAdapter: vi.fn().mockImplementation(function () {
    return {};
  }),
  getOrPinRelayKey: vi.fn(async () => {
    if (h.latency === "hung") await new Promise<void>(() => {});
    else if (h.latency > 0) await new Promise((r) => setTimeout(r, h.latency as number));
    return undefined;
  }),
}));

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

const asyncStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => asyncStore.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      asyncStore.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      asyncStore.delete(k);
    }),
  },
}));

import { MobileSyncController } from "../sync-controller";
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
// `scripts/sync-interleavings-full.sh` records them as <dir>/mobile.main.json and
// <dir>/mobile.main-reaped.json).
const BASELINE_DIR = harnessEnv["INTERLEAVING_BASELINE_DIR"];
const BASELINE = BASELINE_DIR
  ? new URL(`file://${BASELINE_DIR}/mobile.main.json`)
  : new URL("./interleaving-baseline.main.json", import.meta.url);
const BASELINE_REAPED = BASELINE_DIR
  ? new URL(`file://${BASELINE_DIR}/mobile.main-reaped.json`)
  : new URL("./interleaving-baseline.main-reaped.json", import.meta.url);

/** Record main with zombie sockets black-holed (see @motebit/sync-engine/testing). */
const REAP = harnessEnv["INTERLEAVING_REAP"] === "1";

function makeDriver(env: HarnessEnv): Driver {
  h.latency = env.latency;
  env.httpDelivered = new Set<string>();
  const httpDelivered = env.httpDelivered;
  let bailNow = false;
  let motebitId = FIRST_IDENTITY;
  const eventStore = new InMemoryEventStore();
  const storage = {
    eventStore,
    conversationSyncStore: {
      getConversationsSince: () => [],
      getMessagesSince: () => [],
      upsertConversation: () => {},
      upsertMessage: () => {},
    },
    planStore: null,
  };
  const runtime = {
    setDelegationAdapter: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    getPrecision: () => ({ explorationDrive: 0 }),
    getToolRegistry: () => ({ list: () => [] }),
    recoverDelegatedSteps: async function* () {},
  };
  const deps: SyncControllerDeps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getRuntime: () => runtime as any,
    getMotebitId: () => motebitId,
    getDeviceId: () => "device-1",
    getPublicKey: () => "aa".repeat(32),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStorage: () => (bailNow ? null : (storage as any)),
    getLocalEventStore: () => eventStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getKeyring: () => ({ get: vi.fn(async () => null), set: vi.fn(async () => {}) }) as any,
    getPrivKeyBytes: async () => new Uint8Array(32),
    createSyncToken: async () => "auth-token",
    registerPushToken: vi.fn(async () => {}),
    startPushLifecycle: vi.fn(),
    stopPushLifecycle: vi.fn(),
  };
  const ctrl = new MobileSyncController(deps);
  globalThis.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/sync/")) {
      env.httpSyncs.push({ at: Date.now(), url: u });
      if (u.endsWith("/push") && init?.body) {
        const target = /\/sync\/([^/?]+)\//.exec(u)?.[1];
        const body = JSON.parse(init.body) as {
          events?: Array<{ event_id?: string; motebit_id?: string }>;
        };
        for (const e of body.events ?? []) {
          if (e.event_id == null || !e.event_id.startsWith("evt-")) continue;
          if (e.motebit_id !== target) env.httpMisrouted = (env.httpMisrouted ?? 0) + 1;
          else httpDelivered.add(e.event_id);
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          events: u.includes("/pull") ? relayPull(u) : [],
          conversations: [],
          messages: [],
          accepted: 0,
        }),
      };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  }) as unknown as typeof fetch;

  return {
    start(relay, { bail }) {
      bailNow = bail;
      void ctrl.startSync(relay).catch(() => {});
      bailNow = false;
    },
    stop() {
      ctrl.stopSync();
    },
    switchIdentity(next) {
      motebitId = next;
    },
    async appendEvent(eventId, motebit) {
      // The runtime's own append: the next clock above everything local
      // (including events pulled from the relay), as `appendWithClock` does.
      await eventStore.appendWithClock({
        event_id: eventId,
        motebit_id: motebit,
        device_id: "device-1",
        timestamp: 1,
        event_type: "state_updated" as never,
        payload: { n: eventId },
        tombstoned: false,
      });
    },
    async commandFrame(id) {
      return { type: "command_request", id, command: "state" };
    },
    async localEventIds() {
      return (await eventStore.query({ motebit_id: motebitId })).map((e) => e.event_id);
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
          h.durationMs = duration;
          vi.useFakeTimers({
            toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
          });
          asyncStore.clear();
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

describe("mobile sync controller — differential interleaving matrix (#816)", () => {
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
      const opts = { periodicHttp: true };
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
