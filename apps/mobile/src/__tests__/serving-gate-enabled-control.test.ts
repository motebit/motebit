/**
 * Positive control for serving-gate-push-wake.test.ts: with the gate forced
 * ON (as the deliberate future flip would do) the same harness DOES reach
 * execution — proving the gate-off assertions are not vacuous.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../serving-gate", () => ({
  MOBILE_SERVING_ENABLED: true,
  MOBILE_SERVING_UNAVAILABLE: "unavailable",
  mobileServingAllowed: () => true,
  canExecuteDelegatedTask: (servingOn: boolean) => servingOn,
}));

// expo's `requireNativeModule` — stubbed so the hardware-attestation
// cascade doesn't try to load real native modules at test-time.
vi.mock("expo", () => ({
  requireNativeModule: (name: string) => {
    if (name === "ExpoAppAttest") {
      return { appAttestAvailable: vi.fn(), appAttestMint: vi.fn() };
    }
    if (name === "ExpoAndroidKeystore") {
      return { androidKeystoreAvailable: vi.fn(), androidKeystoreMint: vi.fn() };
    }
    return { seAvailable: vi.fn(), seMintAttestation: vi.fn() };
  },
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    currentState: "active",
  },
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(() => Promise.resolve({ status: "undetermined" })),
  requestPermissionsAsync: vi.fn(() => Promise.resolve({ status: "denied" })),
  getExpoPushTokenAsync: vi.fn(() => Promise.resolve({ data: "" })),
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  setNotificationHandler: vi.fn(),
}));

// Capture every TaskManager.defineTask registration so the test can fire the
// background push-wake handler exactly as the OS would.
const definedTasks = vi.hoisted(() => new Map<string, () => Promise<void>>());
vi.mock("expo-task-manager", () => ({
  defineTask: vi.fn((name: string, fn: () => Promise<void>) => {
    definedTasks.set(name, fn);
  }),
  isTaskDefined: vi.fn(() => false),
}));

const secureStoreData = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStoreData.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStoreData.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStoreData.delete(key);
    return Promise.resolve();
  }),
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseSync: () => ({
    execSync: vi.fn(),
    runSync: vi.fn(),
    getAllSync: vi.fn(() => []),
    getFirstSync: vi.fn((_sql: string) => {
      if (_sql.includes("user_version")) return { user_version: 3 };
      return null;
    }),
  }),
}));

const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(asyncStoreData.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      asyncStoreData.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      asyncStoreData.delete(key);
      return Promise.resolve();
    }),
  },
}));

vi.mock("expo-three", () => ({
  Renderer: vi.fn().mockImplementation(() => ({
    setSize: vi.fn(),
    setClearColor: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@motebit/encryption", () => ({
  mintAudienceToken: vi.fn(() => Promise.resolve({ token: "mock-signed-token", payload: {} })),
}));

vi.mock("@motebit/core-identity", () => ({
  bootstrapIdentity: vi.fn(
    async (opts: {
      configStore: {
        read(): Promise<{
          motebit_id: string;
          device_id: string;
          device_public_key: string;
        } | null>;
        write(s: {
          motebit_id: string;
          device_id: string;
          device_public_key: string;
        }): Promise<void>;
      };
      keyStore: { storePrivateKey(hex: string): Promise<void> };
    }) => {
      const existing = await opts.configStore.read();
      if (existing && existing.motebit_id) {
        return {
          motebitId: existing.motebit_id,
          deviceId: existing.device_id,
          publicKeyHex: existing.device_public_key,
          isFirstLaunch: false,
        };
      }
      const motebitId = "test-mote-" + crypto.randomUUID().slice(0, 8);
      const deviceId = "test-device-" + crypto.randomUUID().slice(0, 8);
      const publicKeyHex = "ab".repeat(32);
      await opts.keyStore.storePrivateKey("cd".repeat(64));
      await opts.configStore.write({
        motebit_id: motebitId,
        device_id: deviceId,
        device_public_key: publicKeyHex,
      });
      return { motebitId, deviceId, publicKeyHex, isFirstLaunch: true };
    },
  ),
  IdentityManager: vi.fn().mockImplementation(() => ({
    create: vi.fn(() =>
      Promise.resolve({
        motebit_id: "rt-mote",
        created_at: Date.now(),
        owner_id: "rt",
        version_clock: 0,
      }),
    ),
    load: vi.fn(() => Promise.resolve(null)),
    loadByOwner: vi.fn(() => Promise.resolve(null)),
    registerDevice: vi.fn(() => Promise.resolve()),
    incrementClock: vi.fn(() => Promise.resolve(1)),
  })),
  InMemoryIdentityStorage: vi.fn().mockImplementation(() => ({
    save: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve(null)),
    loadByOwner: vi.fn(() => Promise.resolve(null)),
  })),
}));

vi.mock("@motebit/tools/web-safe", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    DuckDuckGoSearchProvider: vi.fn().mockImplementation(() => ({
      search: vi.fn(() => Promise.resolve([])),
    })),
  };
});

vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    embedText: vi.fn(() => Promise.resolve(new Array(384).fill(0))),
  };
});

vi.mock("@motebit/sync-engine", () => ({
  PairingClient: vi.fn().mockImplementation(() => ({
    initiate: vi.fn(),
    claim: vi.fn(),
    getSession: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    pollStatus: vi.fn(),
  })),
  SyncEngine: vi.fn().mockImplementation(() => ({
    connectRemote: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    sync: vi.fn(),
    onStatusChange: vi.fn(() => vi.fn()),
    getStatus: vi.fn(() => "idle"),
    getConflicts: vi.fn(() => []),
    getCursor: vi.fn(() => ({ motebit_id: "", last_event_id: "", last_version_clock: 0 })),
  })),
  HttpEventStoreAdapter: vi.fn().mockImplementation(() => ({})),
  WebSocketEventStoreAdapter: vi.fn().mockImplementation(() => ({})),
  EncryptedEventStoreAdapter: vi.fn().mockImplementation(() => ({})),
}));

import { setBackgroundApp, type MobileApp } from "../mobile-app";

const WAKE = "MOTEBIT_TASK_WAKE";

interface WakeObservation {
  sent: Array<{ type?: string }>;
  sockets: number;
  handleAgentTask: ReturnType<typeof vi.fn>;
}

/**
 * Fire the background push-wake handler with a relay that immediately offers
 * a delegated task. Returns what the handler did: frames sent (a
 * `task_claim` means it claimed the task), sockets opened, and whether the
 * runtime was asked to execute.
 */
async function fireWake(servingOn: boolean): Promise<WakeObservation> {
  const sent: Array<{ type?: string }> = [];
  let sockets = 0;
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(_url: string) {
      sockets++;
      queueMicrotask(() => {
        this.onopen?.();
        this.onmessage?.({
          data: JSON.stringify({
            type: "task_request",
            task: { task_id: "t-1", prompt: "do work", delegated_scope: undefined },
          }),
        });
      });
    }
    send(raw: string): void {
      const frame = JSON.parse(raw) as { type?: string; task_id?: string };
      sent.push(frame);
      // The relay grants a claim (one task, one body): the phone runs the
      // task only on this grant, as it does against a real relay.
      if (frame.type === "task_claim") {
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify({ type: "task_claimed", task_id: frame.task_id }),
          }),
        );
      }
    }
    close(): void {
      queueMicrotask(() => this.onclose?.());
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))),
  );

  const handleAgentTask = vi.fn(async function* () {
    // yields nothing — the point is whether execution was entered at all
  });
  const fakeApp = {
    motebitId: "mote-1",
    deviceId: "device-1",
    getRuntime: () => ({ handleAgentTask }),
    getSyncUrl: () => Promise.resolve("https://relay.example"),
    createSyncToken: () => Promise.resolve("tok"),
    getPrivKeyBytes: () => Promise.resolve(new Uint8Array(32)),
    isServing: () => servingOn,
  } as unknown as MobileApp;
  setBackgroundApp(fakeApp);
  try {
    const handler = definedTasks.get(WAKE);
    expect(handler, "background push-wake task must be registered").toBeDefined();
    await handler!();
  } finally {
    setBackgroundApp(null);
    vi.unstubAllGlobals();
  }
  return { sent, sockets, handleAgentTask };
}

describe("background push wake — serving gate forced ON (control)", () => {
  it("executes when the gate is on AND serving is on", async () => {
    const obs = await fireWake(true);
    expect(obs.sent.some((f) => f.type === "task_claim")).toBe(true);
    expect(obs.handleAgentTask).toHaveBeenCalledTimes(1);
  });

  it("still refuses when the gate is on but serving is off", async () => {
    const obs = await fireWake(false);
    expect(obs.handleAgentTask).not.toHaveBeenCalled();
    expect(obs.sockets).toBe(0);
  });
});
