/**
 * #816 acceptance: the web sync lifecycle (`WebApp.startSync` / `stopSync`)
 * across every interleaving of lifecycle operations (see
 * ./interleaving-harness.ts), compared cell by cell with origin/main's
 * web-app.ts. Each cell boots a fresh WebApp (real runtime, fake-indexeddb)
 * and drives it over the fake relay and fake clock. Commands carry a real
 * signed envelope (the tab's own key); a bailing start is a startSync whose
 * key store returns no key.
 *
 * Baseline: `interleaving-baseline.main.json`. To regenerate: check out
 * origin/main's `apps/web/src/web-app.ts` and
 * `packages/sync-engine/src/ws-adapter.ts`, rebuild `@motebit/sync-engine`,
 * run this file with `INTERLEAVING_RECORD=src/__tests__/interleaving-baseline.main.json`,
 * restore both files and rebuild.
 *
 * Matrix size: by default every sequence of up to 1 operation(s) (the
 * committed baselines cover exactly that). The full matrix — 2 operations,
 * 2,220 cells with four command execution times — is too slow for every
 * test run: `scripts/sync-interleavings-full.sh all web` records origin/main's
 * full baselines (raw and reaped) and runs this file against them
 * (`INTERLEAVING_MAX_OPS=2`, `INTERLEAVING_BASELINE_DIR`). Its result on
 * #816, against main reaped: in two runs, 1 and 2 cells worse and 0 invariant
 * breaks; each of those three cells, re-run alone three times on this
 * controller and on reaped main, is no worse than main (web cells vary with
 * host load; they are jitter).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { WebApp } from "../web-app.js";
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
  runCell,
  sequences,
  type CellResult,
  type Driver,
  type Duration,
  type HarnessEnv,
  type Latency,
  type Op,
} from "./interleaving-harness";

// Stub ThreeJSAdapter — WebApp creates one internally (requires canvas)
vi.mock("@motebit/render-engine", () => {
  class MockThreeJSAdapter {
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
      // Headless tests have no scene graph — mountCredentialSatellites
      // returns null and the web-app renders without satellites.
      return null;
    }
    dispose() {}
  }
  class MockCredentialSatelliteRenderer {
    setExpression() {}
    tick() {}
    dispose() {}
  }
  // Slab default-embodiment mapping is a pure function in spec.ts.
  // SlabController imports it at module load via @motebit/render-engine;
  // the test mock must export it so `createSlabController(...)` (called
  // from MotebitRuntime's constructor) can construct without throwing.
  // Mirrors real behavior — default is tool_result for tool_call / shell /
  // fetch kinds, mind for stream / plan_step / embedding / memory, and
  // peer_viewport for delegation.
  function defaultEmbodimentMode(kind: string): string {
    switch (kind) {
      case "stream":
      case "plan_step":
      case "embedding":
      case "memory":
        return "mind";
      case "tool_call":
      case "shell":
      case "fetch":
        return "tool_result";
      case "delegation":
        return "peer_viewport";
      default:
        return "tool_result";
    }
  }
  // Mode-contract typed const — `SlabController.checkContractAnomaly`
  // looks this up on every terminal-phase transition. The mock must
  // export it (or the lookup fails with "EMBODIMENT_MODE_CONTRACTS
  // is undefined" once the controller exercises a rest/dissolve/
  // detach). Mirror the canonical const from
  // `packages/render-engine/src/spec.ts`; if the canonical value
  // changes, this mock must move with it (sibling discipline).
  const EMBODIMENT_MODE_CONTRACTS = {
    mind: {
      driver: "self",
      observer: "self",
      source: "interior",
      consent: "always-permitted",
      sensitivity: "all-tiers",
      lifecycleDefaults: ["dissolving", "resting", "detached"],
    },
    tool_result: {
      driver: "motebit",
      observer: "user",
      source: "sandboxed-tool",
      consent: "per-action",
      sensitivity: "tier-bounded-by-tool",
      lifecycleDefaults: ["resting", "dissolving"],
    },
    virtual_browser: {
      driver: "motebit",
      observer: "user",
      source: "isolated-browser",
      consent: "session-scoped",
      sensitivity: "tier-bounded-by-source",
      lifecycleDefaults: ["resting", "detached"],
    },
    shared_gaze: {
      driver: "user",
      observer: "motebit",
      source: "user-source",
      consent: "per-source",
      sensitivity: "tier-bounded-by-source",
      lifecycleDefaults: ["resting", "detached", "dissolving"],
    },
    desktop_drive: {
      driver: "motebit",
      observer: "user",
      source: "real-os",
      consent: "per-action",
      sensitivity: "all-tiers",
      lifecycleDefaults: ["resting", "detached"],
    },
    peer_viewport: {
      driver: "peer",
      observer: "motebit",
      source: "peer-receipt",
      consent: "signed-delegation",
      sensitivity: "tier-bounded-by-source",
      lifecycleDefaults: ["resting", "detached"],
    },
  } as const;
  return {
    ThreeJSAdapter: MockThreeJSAdapter,
    NullRenderAdapter: MockThreeJSAdapter,
    CredentialSatelliteRenderer: MockCredentialSatelliteRenderer,
    credentialsToExpression: () => ({ kind: "satellite", items: [] }),
    // Headless tests have no scene graph — the helper returns null and
    // the web-app renders without satellites (same contract as when
    // getCreatureGroup() returns null).
    mountCredentialSatellites: () => null,
    defaultEmbodimentMode,
    EMBODIMENT_MODE_CONTRACTS,
  };
});

// Stub CursorPresence — needs window/document
vi.mock("../cursor-presence.js", () => ({
  CursorPresence: class {
    start() {}
    stop() {}
    getUpdates() {
      return { attention: 0.5, curiosity: 0.3, social_distance: 0.5 };
    }
  },
}));

// Stub EncryptedKeyStore — needs WebCrypto
vi.mock("../encrypted-keystore.js", () => ({
  EncryptedKeyStore: class {
    private key: string | null = null;
    async storePrivateKey(hex: string) {
      this.key = hex;
    }
    async loadPrivateKey() {
      return this.key;
    }
  },
}));

// Mock provider module — avoid importing real WebLLM
// Deterministic crypto: WebCrypto resolves on the host's thread pool, which
// neither the fake clock nor a bounded settle can order, so outcomes would
// depend on host load.
vi.mock("@motebit/encryption", async () => {
  const actual = await vi.importActual<object>("@motebit/encryption");
  return {
    ...actual,
    deriveSyncEncryptionKey: async () => new Uint8Array(32),
    encrypt: async (plaintext: Uint8Array) => ({
      ciphertext: plaintext,
      nonce: new Uint8Array(12),
      tag: new Uint8Array(16),
    }),
    decrypt: async (payload: { ciphertext: Uint8Array }) => payload.ciphertext,
  };
});

// The cell's command execution time; the real executor runs after it.
const cellCommand = vi.hoisted(() => ({ durationMs: 0 }));
vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/runtime");
  const execute = actual["executeRemoteCommand"] as (...a: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    executeRemoteCommand: async (...args: unknown[]) => {
      if (cellCommand.durationMs > 0) {
        await new Promise((r) => setTimeout(r, cellCommand.durationMs));
      }
      return execute(...args);
    },
  };
});

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

const MAX_OPS = Number(harnessEnv["INTERLEAVING_MAX_OPS"] ?? 1);
const RECORD = harnessEnv["INTERLEAVING_RECORD"];
// `INTERLEAVING_BASELINE_DIR`: baselines recorded elsewhere (the full matrix —
// `scripts/sync-interleavings-full.sh` records them as <dir>/web.main.json and
// <dir>/web.main-reaped.json).
const BASELINE_DIR = harnessEnv["INTERLEAVING_BASELINE_DIR"];
const BASELINE = BASELINE_DIR
  ? new URL(`file://${BASELINE_DIR}/web.main.json`)
  : new URL("./interleaving-baseline.main.json", import.meta.url);
const BASELINE_REAPED = BASELINE_DIR
  ? new URL(`file://${BASELINE_DIR}/web.main-reaped.json`)
  : new URL("./interleaving-baseline.main-reaped.json", import.meta.url);

/** Record main with zombie sockets black-holed (see interleaving-harness.ts). */
const REAP = harnessEnv["INTERLEAVING_REAP"] === "1";

interface Remote {
  append(e: unknown): Promise<void>;
}

async function makeDriver(env: HarnessEnv): Promise<Driver> {
  const app = new WebApp();
  await app.init(null as unknown as HTMLCanvasElement);
  await app.bootstrap();
  const inner = app as unknown as {
    runtime: { connectSync(r: Remote): void; sync: { stop(): void } };
    keyStore: { loadPrivateKey(): Promise<string | null> };
  };
  const privHex = (await inner.keyStore.loadPrivateKey())!;
  const { signAgentCommandEnvelope, hexToBytes } = await import("@motebit/crypto");

  let stopped = true;
  const remotes: Remote[] = [];
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
  const realConnect = inner.runtime.connectSync.bind(inner.runtime);
  inner.runtime.connectSync = (r: Remote) => {
    realConnect(r);
    remotes.push(r);
    void flush();
  };

  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.endsWith("/.well-known/motebit.json")) {
      await relayKeyDelay(env.latency);
      return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/sync/")) {
      env.httpSyncs.push({ at: Date.now(), url: u });
      return new Response(
        JSON.stringify({
          events: u.includes("/pull") ? relayPull(u) : [],
          conversations: [],
          messages: [],
          plans: [],
          steps: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const setMotebitId = (id: string) => {
    (app as unknown as { _motebitId: string })._motebitId = id;
  };
  return {
    initialIdentity: app.motebitId,
    start(relay, { bail }) {
      if (bail) {
        const load = vi.spyOn(inner.keyStore, "loadPrivateKey").mockResolvedValueOnce(null);
        void app.startSync(relay).catch(() => {});
        load.mockRestore();
        return;
      }
      stopped = false;
      void app.startSync(relay).catch(() => {});
    },
    stop() {
      stopped = true;
      remotes.length = 0;
      app.stopSync();
    },
    switchIdentity(next) {
      // A pairing (completePairing) adopts another identity, then startSync.
      setMotebitId(next);
      unsynced.length = 0; // the old identity's log goes with it
      remotes.length = 0; // and the runtime rebinds: no push to the old identity's remote
    },
    async appendEvent(eventId, motebit) {
      unsynced.push({ id: eventId, motebit });
      await flush();
    },
    async commandFrame(id) {
      const envelope = await signAgentCommandEnvelope({
        command: "state",
        motebitId: app.motebitId,
        identityPrivateKey: hexToBytes(privHex),
      });
      return { type: "command_request", id, command: "state", envelope };
    },
    async localEventIds() {
      const local = (
        app as unknown as {
          _localEventStore: {
            query(f: { motebit_id: string }): Promise<Array<{ event_id: string }>>;
          } | null;
        }
      )._localEventStore;
      if (!local) return [];
      return (await local.query({ motebit_id: app.motebitId })).map((e) => e.event_id);
    },
  };
}

const timing = { boot: 0, run: 0 };

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
          cellCommand.durationMs = duration;
          localStorage.clear();
          // A fresh database per cell: the app's identity, keys and event
          // store must not carry over (a store holding an earlier cell's
          // events asks the relay only for what came after them).
          (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
          const env: HarnessEnv = { latency, duration, httpSyncs: [] };
          vi.useFakeTimers({
            toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
          });
          const bootStarted = performance.now();
          const driverP = makeDriver(env);
          // Booting touches fake-indexeddb and timers; step until it settles.
          let driver: Driver | null = null;
          let bootError: unknown = null;
          void driverP.then(
            (d) => (driver = d),
            (e: unknown) => (bootError = e),
          );
          for (let i = 0; i < 2000 && driver == null && bootError == null; i++) {
            await vi.advanceTimersByTimeAsync(10);
          }
          if (driver == null) {
            throw new Error(`WebApp did not boot under the fake clock (${key})`, {
              cause: bootError,
            });
          }
          env.httpSyncs.length = 0;
          const runStarted = performance.now();
          results[key] = await runCell(seq, env, driver, {
            reap: REAP,
            // fake-indexeddb and the real runtime do real async work per step.
            settleTurns: Number(harnessEnv["INTERLEAVING_SETTLE_TURNS"] ?? 10),
            settleAfterOpTurns: Number(harnessEnv["INTERLEAVING_SETTLE_OP_TURNS"] ?? 400),
          });
          timing.boot += runStarted - bootStarted;
          timing.run += performance.now() - runStarted;
          (driver as Driver).stop();
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

describe("web sync lifecycle — differential interleaving matrix (#816)", () => {
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
      // Web's cells are not bit-for-bit reproducible (see the harness's
      // CompareOptions). Two runs of the default matrix on one host differed
      // in 3 of 220 cells: two by 1 s of HTTP overdue time, one by 4 s of
      // overdue time and 5 s of first sync (a cell where this controller
      // still leads main by more than that). The allowance is 1 s and no
      // command: a cell that jitters further against main fails, loudly.
      const opts = {
        periodicHttp: true,
        tolerance: { commands: 0, overdueMs: 1_000, firstHttpMs: 1_000 },
      };
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
    60 * 60_000,
  );
});
