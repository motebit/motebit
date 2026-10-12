/**
 * The founder-approved privacy boundary (2026-10-11): with Relay OFF,
 * nothing contacts the relay. Pins the sync controller's half:
 *
 *   - OFF drops every live relay handle — the serving URL/token behind
 *     `discoverAgents`, the runtime's interactive delegation
 *     (`delegate_to_agent` & co.) and the PlanEngine delegation adapter;
 *   - OFF disposes the relay session FIRST, then unregisters the push
 *     token with the URL captured before, and an unreachable relay never
 *     blocks OFF (fail-soft);
 *   - ON fires push registration and the onboarding self-test only once
 *     the relay has ACCEPTED the device — a refusal prompts for nothing;
 *   - device registration is bounded by an abort signal, so a black-holed
 *     network resolves (and the Settings switch re-enables);
 *   - OFF while relay work is IN FLIGHT (a pending registration, a pending
 *     relay-key pin, a pending notification-permission prompt) still wins:
 *     the stale continuation touches nothing once it resumes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  selfTestSpy: vi.fn(() => Promise.resolve({ summary: "ok", data: { status: "passed" } })),
  registerImpl: null as null | ((p: { signal?: AbortSignal }) => Promise<unknown>),
  permissionPrompt: null as null | Promise<{ status: string }>,
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(() => Promise.resolve({ status: "undetermined" })),
  requestPermissionsAsync: vi.fn(
    () => hoisted.permissionPrompt ?? Promise.resolve({ status: "denied" }),
  ),
  getExpoPushTokenAsync: vi.fn(() => Promise.resolve({ data: "expo-push-token" })),
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock("@motebit/runtime", async () => ({
  TaskClaimCoordinator: (
    await vi.importActual<typeof import("@motebit/runtime")>("@motebit/runtime")
  ).TaskClaimCoordinator,
  executeRemoteCommand: vi.fn(),
  cmdSelfTest: hoisted.selfTestSpy,
  servedToolNames: vi.fn(() => []),
  verifyAgentCommandEnvelope: vi.fn(),
  getOrPinRelayKey: vi.fn(() => Promise.resolve(undefined)),
  RelayDelegationAdapter: vi.fn().mockImplementation(function () {
    return { kind: "relay-delegation-adapter" };
  }),
}));

vi.mock("@motebit/sync-engine", () => {
  class Base {
    connectRemote = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    sync = vi.fn(() =>
      Promise.resolve({ pushed: 0, pulled: 0, conversations_pushed: 0, conversations_pulled: 0 }),
    );
    getLastError = vi.fn(() => null);
  }
  class WebSocketEventStoreAdapter {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn(() => vi.fn());
    onCustomMessage = vi.fn(() => vi.fn());
    sendRaw = vi.fn();
  }
  const ctor = () =>
    vi.fn().mockImplementation(function () {
      return {};
    });
  return {
    SyncEngine: Base,
    ConversationSyncEngine: Base,
    PlanSyncEngine: Base,
    HttpEventStoreAdapter: ctor(),
    WebSocketEventStoreAdapter,
    EncryptedEventStoreAdapter: ctor(),
    HttpConversationSyncAdapter: ctor(),
    EncryptedConversationSyncAdapter: ctor(),
    HttpPlanSyncAdapter: ctor(),
    EncryptedPlanSyncAdapter: ctor(),
    decryptEventPayload: vi.fn((e: unknown) => Promise.resolve(e)),
  };
});

vi.mock("@motebit/core-identity", () => ({
  registerDeviceWithRelay: vi.fn((p: { signal?: AbortSignal }) =>
    hoisted.registerImpl
      ? hoisted.registerImpl(p)
      : Promise.resolve({ ok: true, created: false, registered_at: 1 }),
  ),
}));

vi.mock("@motebit/encryption", () => ({
  deriveSyncEncryptionKey: vi.fn(() => Promise.resolve(new Uint8Array(32))),
  secureErase: vi.fn(),
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

import { registerDeviceWithRelay } from "@motebit/core-identity";
import { getOrPinRelayKey } from "@motebit/runtime";
import { MobilePushTokenManager } from "../push-token-manager";
import {
  MobileSyncController,
  PUSH_UNREGISTER_TIMEOUT_MS,
  REGISTRATION_TIMEOUT_MS,
} from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";

const RELAY = "https://relay.test";

function makeRuntime() {
  return {
    getToolRegistry: vi.fn(() => ({ list: () => [] })),
    getPrecision: vi.fn(() => ({ explorationDrive: 0.5 })),
    setDelegationAdapter: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    disableInteractiveDelegation: vi.fn(),
    recoverDelegatedSteps: async function* () {
      /* empty */
    },
    isProcessing: false,
  };
}

function makeDeps(
  runtime: ReturnType<typeof makeRuntime> | null,
  overrides?: Partial<SyncControllerDeps>,
): SyncControllerDeps {
  return {
    getRuntime: () => runtime as unknown as ReturnType<SyncControllerDeps["getRuntime"]>,
    getMotebitId: () => "mote-1",
    getDeviceId: () => "dev-1",
    getPublicKey: () => "aa".repeat(32),
    getStorage: () =>
      ({
        eventStore: { append: vi.fn(), read: vi.fn(() => []) },
        conversationSyncStore: {},
      }) as unknown as ReturnType<SyncControllerDeps["getStorage"]>,
    getLocalEventStore: () => null,
    getKeyring: () =>
      ({
        get: vi.fn(() => Promise.resolve(null)),
        set: vi.fn(() => Promise.resolve()),
      }) as unknown as ReturnType<SyncControllerDeps["getKeyring"]>,
    getPrivKeyBytes: () => Promise.resolve(new Uint8Array(32)),
    createSyncToken: () => Promise.resolve("auth-token"),
    registerPushToken: vi.fn(() => Promise.resolve()),
    removePushToken: vi.fn(() => Promise.resolve()),
    startPushLifecycle: vi.fn(),
    stopPushLifecycle: vi.fn(),
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  asyncStoreData.clear();
  hoisted.selfTestSpy.mockClear();
  hoisted.registerImpl = null;
  hoisted.permissionPrompt = null;
  vi.mocked(registerDeviceWithRelay).mockClear();
  fetchSpy = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ agents: [] }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** ON, then let the first sync cycle (3 s after start) wire serving + delegation. */
async function connectAndRunFirstCycle(ctrl: MobileSyncController): Promise<void> {
  await ctrl.startSync(RELAY);
  await vi.advanceTimersByTimeAsync(3_100);
}

describe("Relay OFF drops every live relay handle", () => {
  it("connect → first cycle → OFF: discoverAgents makes no relay request", async () => {
    const runtime = makeRuntime();
    const ctrl = new MobileSyncController(makeDeps(runtime));
    await connectAndRunFirstCycle(ctrl);
    expect(runtime.enableInteractiveDelegation).toHaveBeenCalled();
    // While ON, discovery reaches the relay.
    await ctrl.discoverAgents();
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/agents/discover"))).toBe(true);

    await ctrl.disconnectSync();
    fetchSpy.mockClear();

    expect(await ctrl.discoverAgents()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    ctrl.stopSync();
  });

  it("OFF disables the runtime's interactive delegation and clears the plan adapter", async () => {
    const runtime = makeRuntime();
    const ctrl = new MobileSyncController(makeDeps(runtime));
    await connectAndRunFirstCycle(ctrl);

    await ctrl.disconnectSync();

    // delegate_to_agent / discover_agents / retrieve_task_result are gone
    // (pinned at the runtime by disable-interactive-delegation.test.ts).
    expect(runtime.disableInteractiveDelegation).toHaveBeenCalled();
    expect(runtime.setDelegationAdapter).toHaveBeenLastCalledWith(undefined);
  });
});

describe("Relay OFF disposes the session first, then unregisters the push token", () => {
  it("unregisters with the URL captured before dispose, once nothing can re-register", async () => {
    const atRemoval: Array<unknown> = [];
    const ref: { ctrl?: MobileSyncController } = {};
    const runtime = makeRuntime();
    const deps = makeDeps(runtime, {
      removePushToken: vi.fn(async (url: string) => {
        atRemoval.push(
          url,
          ref.ctrl?.syncStatus,
          vi.mocked(deps.stopPushLifecycle).mock.calls.length > 0,
          runtime.disableInteractiveDelegation.mock.calls.length > 0,
          (await ref.ctrl?.getSyncUrl()) ?? null,
        );
      }),
    });
    const ctrl = new MobileSyncController(deps);
    ref.ctrl = ctrl;
    await connectAndRunFirstCycle(ctrl);

    await ctrl.disconnectSync();

    expect(deps.removePushToken).toHaveBeenCalledTimes(1);
    // The captured URL; the session already disposed (offline, push
    // lifecycle and delegation stopped); the saved URL already cleared.
    expect(atRemoval).toEqual([RELAY, "offline", true, true, null]);
    expect(await ctrl.getSyncUrl()).toBeNull();
  });

  it("an unreachable relay does not block OFF (fail-soft)", async () => {
    const deps = makeDeps(makeRuntime(), {
      removePushToken: vi.fn(() => Promise.reject(new Error("offline"))),
    });
    const ctrl = new MobileSyncController(deps);
    await connectAndRunFirstCycle(ctrl);

    await ctrl.disconnectSync();

    expect(await ctrl.getSyncUrl()).toBeNull();
    expect(ctrl.syncStatus).toBe("offline");
  });

  it("a black-holed unregister is abandoned after the timeout", async () => {
    const deps = makeDeps(makeRuntime(), {
      removePushToken: vi.fn(() => new Promise<void>(() => {})),
    });
    const ctrl = new MobileSyncController(deps);
    await connectAndRunFirstCycle(ctrl);

    let done = false;
    const off = ctrl.disconnectSync().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(PUSH_UNREGISTER_TIMEOUT_MS + 10);
    await off;
    expect(done).toBe(true);
    expect(await ctrl.getSyncUrl()).toBeNull();
  });

  it("OFF with nothing connected contacts nothing", async () => {
    const deps = makeDeps(makeRuntime());
    const ctrl = new MobileSyncController(deps);
    await ctrl.disconnectSync();
    expect(deps.removePushToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Relay ON: push + self-test only after the relay accepted the device", () => {
  it("a refused registration fires no push registration and no self-test", async () => {
    hoisted.registerImpl = () =>
      Promise.resolve({ ok: false, code: "network_unreachable", message: "down" });
    const deps = makeDeps(makeRuntime());
    const ctrl = new MobileSyncController(deps);

    await ctrl.startSync(RELAY);
    await vi.advanceTimersByTimeAsync(50);

    expect(ctrl.syncStatus).toBe("error");
    expect(deps.registerPushToken).not.toHaveBeenCalled();
    expect(deps.startPushLifecycle).not.toHaveBeenCalled();
    expect(hoisted.selfTestSpy).not.toHaveBeenCalled();

    // Rolled back (connectRelay calls disconnectSync): still nothing fires.
    await ctrl.disconnectSync();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.registerPushToken).not.toHaveBeenCalled();
    expect(hoisted.selfTestSpy).not.toHaveBeenCalled();
  });

  it("an accepted registration fires push registration and the self-test", async () => {
    const deps = makeDeps(makeRuntime());
    const ctrl = new MobileSyncController(deps);
    await ctrl.startSync(RELAY);
    await vi.advanceTimersByTimeAsync(50);
    // Under the attempt's RelaySession: posts only through its fetch.
    expect(deps.registerPushToken).toHaveBeenCalledWith(
      RELAY,
      expect.objectContaining({ live: true, fetch: expect.any(Function) }),
    );
    expect(deps.startPushLifecycle).toHaveBeenCalled();
    expect(hoisted.selfTestSpy).toHaveBeenCalled();
    ctrl.stopSync();
  });

  it("a launch that is refused first and accepted on retry registers push then", async () => {
    let attempts = 0;
    hoisted.registerImpl = () =>
      Promise.resolve(
        ++attempts === 1
          ? { ok: false, code: "network_unreachable", message: "down" }
          : { ok: true, created: false, registered_at: 1 },
      );
    const deps = makeDeps(makeRuntime());
    const ctrl = new MobileSyncController(deps);
    await ctrl.startSync(RELAY);
    expect(deps.registerPushToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(attempts).toBe(2);
    expect(deps.registerPushToken).toHaveBeenCalledTimes(1);
    ctrl.stopSync();
  });

  it("device registration carries an abort signal; a black-holed relay resolves as error", async () => {
    hoisted.registerImpl = (p) =>
      new Promise((resolve) => {
        p.signal?.addEventListener("abort", () =>
          resolve({ ok: false, code: "network_unreachable", message: "aborted" }),
        );
      });
    const deps = makeDeps(makeRuntime());
    const ctrl = new MobileSyncController(deps);

    let started = false;
    const on = ctrl.startSync(RELAY).then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(REGISTRATION_TIMEOUT_MS + 10);
    await on;

    expect(started).toBe(true);
    const params = vi.mocked(registerDeviceWithRelay).mock.calls[0]![0];
    expect(params.signal).toBeInstanceOf(AbortSignal);
    expect(ctrl.syncStatus).toBe("error");
    expect(deps.registerPushToken).not.toHaveBeenCalled();
    ctrl.stopSync();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** After OFF: nothing reaches the relay, delegation stays off, no timer is left. */
async function expectNothingLiveAfterOff(
  ctrl: MobileSyncController,
  runtime: ReturnType<typeof makeRuntime>,
): Promise<void> {
  // Run out every timer a stale continuation may have armed (first sync, interval).
  await vi.advanceTimersByTimeAsync(120_000);
  expect(ctrl.isSyncConnected).toBe(false);
  expect(ctrl.syncStatus).toBe("offline");
  expect(runtime.enableInteractiveDelegation).not.toHaveBeenCalled();
  expect(await ctrl.discoverAgents()).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
}

describe("Relay OFF while relay work is in flight: stale continuations cannot act", () => {
  it("OFF during a pending device registration: the resumed startSync arms nothing", async () => {
    const registration = deferred<unknown>();
    hoisted.registerImpl = () => registration.promise;
    const runtime = makeRuntime();
    const deps = makeDeps(runtime);
    const ctrl = new MobileSyncController(deps);

    const on = ctrl.startSync(RELAY);
    await vi.advanceTimersByTimeAsync(10);
    await ctrl.disconnectSync();
    fetchSpy.mockClear();

    registration.resolve({ ok: true, created: false, registered_at: 1 });
    await on;

    await expectNothingLiveAfterOff(ctrl, runtime);
    expect(deps.registerPushToken).not.toHaveBeenCalled();
    expect(hoisted.selfTestSpy).not.toHaveBeenCalled();
  });

  it("OFF before the first cycle fires clears its timer (nothing left armed)", async () => {
    const runtime = makeRuntime();
    const ctrl = new MobileSyncController(makeDeps(runtime));
    await ctrl.startSync(RELAY); // first cycle armed 3 s out, interval 30 s
    await ctrl.disconnectSync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("OFF during the relay-key pin: the resumed cycle does not re-enable delegation", async () => {
    const pin = deferred<string | undefined>();
    vi.mocked(getOrPinRelayKey).mockImplementationOnce(() => pin.promise);
    const runtime = makeRuntime();
    const ctrl = new MobileSyncController(makeDeps(runtime));

    await ctrl.startSync(RELAY);
    await vi.advanceTimersByTimeAsync(3_100); // first cycle, now blocked on the pin
    expect(getOrPinRelayKey).toHaveBeenCalled();
    await ctrl.disconnectSync();
    expect(runtime.disableInteractiveDelegation).toHaveBeenCalled();
    fetchSpy.mockClear();
    runtime.enableInteractiveDelegation.mockClear();

    pin.resolve("relay-key-hex");
    await expectNothingLiveAfterOff(ctrl, runtime);
  });

  it("OFF during the notification-permission prompt: no push token is posted or stored", async () => {
    const prompt = deferred<{ status: string }>();
    hoisted.permissionPrompt = prompt.promise;
    const runtime = makeRuntime();
    const ref: { ctrl?: MobileSyncController } = {};
    const pushTokens = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => ref.ctrl?.getSyncUrl() ?? Promise.resolve(null),
    });
    const ctrl = new MobileSyncController(
      makeDeps(runtime, {
        registerPushToken: (...args: Parameters<MobilePushTokenManager["registerPushToken"]>) =>
          pushTokens.registerPushToken(...args),
        removePushToken: (url) => pushTokens.removePushToken(url),
      }),
    );
    ref.ctrl = ctrl;

    await ctrl.startSync(RELAY); // accepted → push registration sits at the prompt
    await ctrl.disconnectSync();
    fetchSpy.mockClear();

    prompt.resolve({ status: "granted" });
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(asyncStoreData.has("@motebit/push_token")).toBe(false);
    await expectNothingLiveAfterOff(ctrl, runtime);
  });
});
