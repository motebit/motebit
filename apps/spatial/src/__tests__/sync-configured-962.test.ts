/**
 * #962 C2 / P2 — spatial's `syncConfigured` wiring, read from the runtime
 * `SpatialApp.initAI` constructs (the runtime's own answer, read at
 * compaction time). It is exactly the sync controller's own gate: a relay
 * URL AND showNetwork. With showNetwork off, no sync ever connects — so
 * compaction must not wait on a relay; with it on (the default, pointing at
 * relay.motebit.com), compaction waits on that relay's acknowledgment even
 * on an install that never reaches it (the stated cost).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createInMemoryStorage } from "@motebit/runtime";
import { SpatialApp } from "../spatial-app";

async function initialized(): Promise<SpatialApp> {
  const app = new SpatialApp();
  // In-memory storage instead of IndexedDB; everything else is initAI's own.
  (app as unknown as { storage: unknown }).storage = createInMemoryStorage();
  const ok = await app.initAI({
    provider: { mode: "byok", vendor: "anthropic", apiKey: "sk-ant-zz962" },
  });
  expect(ok).toBe(true);
  return app;
}

beforeEach(() => {
  // Node has no localStorage; the MCP manager's key-value store reads it.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#962 — SpatialApp's syncConfigured", () => {
  it("the default network settings (relay.motebit.com, showNetwork on): configured", async () => {
    const app = await initialized();
    expect(app.networkConfig.showNetwork).toBe(true);
    expect(app.networkConfig.relayUrl).not.toBe("");
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(true);
  });

  it("showNetwork off: not configured — and no sync ever connects", async () => {
    const app = await initialized();
    app.setNetworkSettings({ showNetwork: false });
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(false);
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const connect = vi.spyOn(app.getRuntime()!, "connectSync");
    await app.connectRelay();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("no relay URL: not configured", async () => {
    const app = await initialized();
    app.setNetworkSettings({ relayUrl: "" });
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(false);
  });

  it("settings changed after construction are read at compaction time", async () => {
    const app = await initialized();
    app.setNetworkSettings({ showNetwork: false });
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(false);
    app.setNetworkSettings({ showNetwork: true, relayUrl: "https://relay.zz962s.test" });
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(true);
  });
});
