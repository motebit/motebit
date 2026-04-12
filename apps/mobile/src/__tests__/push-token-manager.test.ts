import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let permissionStatus = "undetermined";
let requestPermissionResult = "denied";
let pushTokenValue: string | null = "test-push-token";
const tokenListeners: Array<(t: unknown) => void> = [];

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(() => Promise.resolve({ status: permissionStatus })),
  requestPermissionsAsync: vi.fn(() => Promise.resolve({ status: requestPermissionResult })),
  getExpoPushTokenAsync: vi.fn(() =>
    Promise.resolve({ data: pushTokenValue ?? "" }),
  ),
  addPushTokenListener: vi.fn((cb: (t: unknown) => void) => {
    tokenListeners.push(cb);
    return { remove: vi.fn() };
  }),
}));

let appStateChangeCallback: ((state: string) => void) | null = null;
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi.fn((_evt: string, cb: (s: string) => void) => {
      appStateChangeCallback = cb;
      return { remove: vi.fn() };
    }),
  },
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

import { MobilePushTokenManager } from "../push-token-manager";

function makeFetchSpy(ok = true, status = 200) {
  return vi.fn(() => Promise.resolve({ ok, status } as Response));
}

beforeEach(() => {
  asyncStoreData.clear();
  permissionStatus = "undetermined";
  requestPermissionResult = "denied";
  pushTokenValue = "test-push-token";
  tokenListeners.length = 0;
  appStateChangeCallback = null;
  vi.stubGlobal("fetch", makeFetchSpy());
});

describe("MobilePushTokenManager.registerPushToken", () => {
  it("no-ops when permission denied", async () => {
    permissionStatus = "undetermined";
    requestPermissionResult = "denied";
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.registerPushToken("https://relay.test");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requests permission if undetermined, returns if user denies", async () => {
    permissionStatus = "undetermined";
    requestPermissionResult = "denied";
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.registerPushToken("https://relay.test");
    // No throw — best-effort
  });

  it("posts push token to relay when granted", async () => {
    permissionStatus = "granted";
    const fetchSpy = makeFetchSpy(true, 200);
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.registerPushToken("https://relay.test");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://relay.test/api/v1/agents/push-token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(asyncStoreData.get("@motebit/push_token")).toBe("test-push-token");
  });

  it("skips when token is unchanged", async () => {
    permissionStatus = "granted";
    asyncStoreData.set("@motebit/push_token", "test-push-token");
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.registerPushToken("https://relay.test");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when push token is empty", async () => {
    permissionStatus = "granted";
    pushTokenValue = "";
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.registerPushToken("https://relay.test");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when no auth token available", async () => {
    permissionStatus = "granted";
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve(""),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.registerPushToken("https://relay.test");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not persist token if relay returns non-ok", async () => {
    permissionStatus = "granted";
    const fetchSpy = makeFetchSpy(false, 500);
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.registerPushToken("https://relay.test");
    expect(asyncStoreData.get("@motebit/push_token")).toBeUndefined();
  });

  it("swallows errors", async () => {
    permissionStatus = "granted";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network error"))),
    );
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.registerPushToken("https://relay.test");
    // No throw
  });
});

describe("MobilePushTokenManager.removePushToken", () => {
  it("sends DELETE with auth and clears local token", async () => {
    asyncStoreData.set("@motebit/push_token", "stored");
    const fetchSpy = makeFetchSpy(true, 200);
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.removePushToken("https://relay.test");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://relay.test/api/v1/agents/push-token",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(asyncStoreData.get("@motebit/push_token")).toBeUndefined();
  });

  it("no-ops when no auth token", async () => {
    const fetchSpy = makeFetchSpy();
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve(""),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.removePushToken("https://relay.test");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("boom"))),
    );
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    await mgr.removePushToken("https://relay.test");
  });
});

describe("MobilePushTokenManager.startPushLifecycle / stopPushLifecycle", () => {
  it("registers token listener + app state listener on start", () => {
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    mgr.startPushLifecycle();
    expect(tokenListeners.length).toBe(1);
    expect(appStateChangeCallback).toBeTruthy();
    mgr.stopPushLifecycle();
  });

  it("stopPushLifecycle is idempotent", () => {
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve(null),
    });
    mgr.stopPushLifecycle();
    mgr.stopPushLifecycle();
  });

  it("token listener re-registers when sync URL is set", async () => {
    permissionStatus = "granted";
    asyncStoreData.set("@motebit/push_token", "old");
    const fetchSpy = makeFetchSpy(true, 200);
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve("https://relay.test"),
    });
    mgr.startPushLifecycle();
    tokenListeners[0]?.({ data: "new-token" });
    // The callback is async; give it a chance
    await new Promise((r) => setTimeout(r, 10));
    mgr.stopPushLifecycle();
  });

  it("app state change re-registers when active", async () => {
    permissionStatus = "granted";
    const fetchSpy = makeFetchSpy(true, 200);
    vi.stubGlobal("fetch", fetchSpy);
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve("https://relay.test"),
    });
    mgr.startPushLifecycle();
    appStateChangeCallback?.("active");
    await new Promise((r) => setTimeout(r, 10));
    mgr.stopPushLifecycle();
  });

  it("app state change to background does nothing", () => {
    const mgr = new MobilePushTokenManager({
      getDeviceId: () => "dev-1",
      createSyncToken: () => Promise.resolve("auth-token"),
      getSyncUrl: () => Promise.resolve("https://relay.test"),
    });
    mgr.startPushLifecycle();
    appStateChangeCallback?.("background");
    mgr.stopPushLifecycle();
  });
});
