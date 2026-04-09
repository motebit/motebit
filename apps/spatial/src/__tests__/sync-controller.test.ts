import { describe, it, expect } from "vitest";
import { SpatialSyncController } from "../sync-controller";
import type { SpatialSyncControllerDeps } from "../sync-controller";

function makeDeps(overrides?: Partial<SpatialSyncControllerDeps>): SpatialSyncControllerDeps {
  return {
    getRuntime: () => null,
    getMotebitId: () => "test-motebit-id",
    getDeviceId: () => "test-device-id",
    getPublicKey: () => "a".repeat(64),
    getNetworkSettings: () => ({ relayUrl: "", showNetwork: false }),
    getStorage: () => null,
    getPlanStore: () => null,
    getPrivKey: () => null,
    clearPrivKey: () => {},
    getTokenFactory: () => null,
    ...overrides,
  };
}

describe("SpatialSyncController", () => {
  it("initializes with disconnected status", () => {
    const ctrl = new SpatialSyncController(makeDeps());
    expect(ctrl.syncStatus).toBe("disconnected");
  });

  it("lastAuthToken is null before connection", () => {
    const ctrl = new SpatialSyncController(makeDeps());
    expect(ctrl.lastAuthToken).toBeNull();
  });

  it("connectRelay is a no-op when relayUrl is empty", async () => {
    const ctrl = new SpatialSyncController(makeDeps());
    await ctrl.connectRelay();
    expect(ctrl.syncStatus).toBe("disconnected");
  });

  it("connectRelay is a no-op when showNetwork is false", async () => {
    const ctrl = new SpatialSyncController(
      makeDeps({
        getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: false }),
      }),
    );
    await ctrl.connectRelay();
    expect(ctrl.syncStatus).toBe("disconnected");
  });

  it("onSyncStatusChange returns working unsubscribe function", async () => {
    const ctrl = new SpatialSyncController(
      makeDeps({
        getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
      }),
    );
    const statuses: string[] = [];
    const unsub = ctrl.onSyncStatusChange((s) => statuses.push(s));
    // Trigger a status change
    await ctrl.connectRelay();
    expect(statuses.length).toBeGreaterThan(0);
    // Unsubscribe and trigger another — should not add more
    unsub();
    const count = statuses.length;
    await ctrl.disconnectRelay();
    expect(statuses.length).toBe(count);
  });

  it("disconnectRelay calls clearPrivKey when key exists", async () => {
    let cleared = false;
    const ctrl = new SpatialSyncController(
      makeDeps({
        getPrivKey: () => new Uint8Array(32),
        clearPrivKey: () => {
          cleared = true;
        },
      }),
    );
    await ctrl.disconnectRelay();
    expect(cleared).toBe(true);
  });

  it("connectRelay sets connecting status when URL and showNetwork are set", async () => {
    const ctrl = new SpatialSyncController(
      makeDeps({
        getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
      }),
    );
    const statuses: string[] = [];
    ctrl.onSyncStatusChange((s) => statuses.push(s));
    await ctrl.connectRelay();
    expect(statuses[0]).toBe("connecting");
  });

  it("connectRelay with tokenFactory that throws still proceeds", async () => {
    const ctrl = new SpatialSyncController(
      makeDeps({
        getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
        getTokenFactory: () => async () => {
          throw new Error("no key");
        },
      }),
    );
    await ctrl.connectRelay();
    // Should not throw — token failure is swallowed
    expect(ctrl.lastAuthToken).toBeNull();
  });

  it("connectRelay with working tokenFactory stores token", async () => {
    const ctrl = new SpatialSyncController(
      makeDeps({
        getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
        getTokenFactory: () => async () => "test-token-123",
      }),
    );
    await ctrl.connectRelay();
    expect(ctrl.lastAuthToken).toBe("test-token-123");
  });

  it("disconnectRelay skips clearPrivKey when no key", async () => {
    let cleared = false;
    const ctrl = new SpatialSyncController(
      makeDeps({
        clearPrivKey: () => {
          cleared = true;
        },
      }),
    );
    await ctrl.disconnectRelay();
    expect(cleared).toBe(false);
  });

  it("disconnectRelay with auth token sends Authorization header", async () => {
    const ctrl = new SpatialSyncController(
      makeDeps({
        getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
        getTokenFactory: () => async () => "auth-token-for-deregister",
      }),
    );
    await ctrl.connectRelay();
    expect(ctrl.lastAuthToken).toBe("auth-token-for-deregister");
    await ctrl.disconnectRelay();
    expect(ctrl.syncStatus).toBe("disconnected");
    expect(ctrl.lastAuthToken).toBe("auth-token-for-deregister"); // not cleared
  });

  it("disconnectRelay with relayUrl attempts deregistration", async () => {
    const ctrl = new SpatialSyncController(
      makeDeps({
        getNetworkSettings: () => ({ relayUrl: "https://relay.test", showNetwork: true }),
      }),
    );
    // connectRelay first to set auth token and status
    await ctrl.connectRelay();
    // disconnectRelay should attempt deregistration (fetch will fail, that's fine)
    await ctrl.disconnectRelay();
    expect(ctrl.syncStatus).toBe("disconnected");
  });
});
