/**
 * #962 C2 / P3 — desktop's `syncConfigured` wiring, read from the runtime
 * `DesktopApp.initAI` constructs (the runtime's own answer, as compaction
 * reads it). A configured relay — in the config, or started later this
 * session (pairing, settings) — holds compaction at its acked push cursor;
 * no relay compacts as before.
 */
import { describe, it, expect, afterEach } from "vitest";
import { DesktopApp, type InvokeFn } from "../index";

describe("#962 — DesktopApp's syncConfigured", () => {
  let app: DesktopApp | null = null;

  afterEach(() => {
    app?.stop();
    app = null;
  });

  it("no relay configured: not configured", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "local-server", isTauri: false });
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(false);
  });

  it("a relay in the config: configured", async () => {
    app = new DesktopApp();
    await app.initAI({
      provider: "local-server",
      isTauri: false,
      syncUrl: "https://relay.zz962d.test",
    });
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(true);
  });

  it("an empty relay URL: not configured", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "local-server", isTauri: false, syncUrl: "" });
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(false);
  });

  it("P3: a relay started later this session is read at compaction time", async () => {
    app = new DesktopApp();
    await app.initAI({ provider: "local-server", isTauri: false });
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(false);
    // No keypair in this harness: sync reports an error and stops — the relay
    // was still started, and may hold this store's pushes from here on.
    const invoke = (async () => null) as unknown as InvokeFn;
    await app.startSync(invoke, "https://relay.zz962d.test").catch(() => {});
    expect(await app.getRuntime()!.isSyncConfigured()).toBe(true);
  });
});
