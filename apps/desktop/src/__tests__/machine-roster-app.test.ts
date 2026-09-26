/**
 * DesktopApp's machine-roster lifecycle (machine-roster-surfaces-v1 C-2c):
 * one roster per identity; disposed BEFORE a restore or a pairing touches
 * the key slot; latched off from stop() until start(); read on connect.
 */
import { describe, it, expect, vi } from "vitest";

// Real, except the restore validator (it is not what these tests are about).
vi.mock("@motebit/identity-file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@motebit/identity-file")>()),
  validateRestoreRequest: vi.fn(() => Promise.resolve(null)),
}));

import { DesktopApp, type InvokeFn } from "../index";
import { DISPOSED, type DesktopMachineRoster } from "../machine-roster";

const MID_A = "0190f1a2-0000-7000-8000-00000000000a";
const MID_B = "0190f1a2-0000-7000-8000-00000000000b";

type Internals = {
  identity: { motebitId: string; deviceId: string };
  sync: {
    startSync: (...a: unknown[]) => Promise<void>;
    syncStatus: { status: string };
  };
};
const internals = (app: DesktopApp) => app as unknown as Internals;

function appAs(motebitId: string, deviceId: string): DesktopApp {
  const app = new DesktopApp();
  internals(app).identity.motebitId = motebitId;
  internals(app).identity.deviceId = deviceId;
  return app;
}

/** An invoke that records calls and serves an empty key store / config. */
function recorder(onCall?: (cmd: string, args?: Record<string, unknown>) => void): InvokeFn {
  return (async (cmd: string, args?: Record<string, unknown>) => {
    onCall?.(cmd, args);
    if (cmd === "read_config") return "{}";
    return null;
  }) as InvokeFn;
}

/** A disposed roster refuses every act before any I/O. */
async function disposed(r: DesktopMachineRoster): Promise<boolean> {
  await r.section.retire("some-machine");
  return r.section.getState().notice?.text === DISPOSED;
}

describe("DesktopApp.machineRoster", () => {
  it("is null before bootstrap, and one per identity after", () => {
    const invoke = recorder();
    expect(new DesktopApp().machineRoster(invoke)).toBeNull();
    const app = appAs(MID_A, "desk-1");
    const r = app.machineRoster(invoke);
    expect(r).not.toBeNull();
    expect(app.machineRoster(invoke)).toBe(r);
    app.stop();
  });

  it("stop disposes and latches: none until start()", async () => {
    const invoke = recorder();
    const app = appAs(MID_A, "desk-1");
    const r = app.machineRoster(invoke)!;
    app.stop();
    expect(await disposed(r)).toBe(true);
    expect(app.machineRoster(invoke)).toBeNull();
    app.start();
    const next = app.machineRoster(invoke);
    expect(next).not.toBeNull();
    expect(next).not.toBe(r);
    app.stop();
  });

  it("a restore disposes the roster BEFORE anything is written to the key store, and leaves none until reload", async () => {
    const app = appAs(MID_A, "desk-1");
    const seen: Array<{ cmd: string; key: unknown; live: boolean; disposed: boolean }> = [];
    let r: DesktopMachineRoster | null = null;
    const pending: Array<Promise<void>> = [];
    const invoke = recorder((cmd, args) => {
      if (cmd === "keyring_set") {
        const probe = { cmd, key: args?.key, live: app.machineRoster(invoke) != null };
        pending.push(disposed(r!).then((d) => void seen.push({ ...probe, disposed: d })));
      }
    });
    r = app.machineRoster(invoke)!;
    const out = await app.restoreIdentity(invoke, {
      privateKeyHex: "11".repeat(32),
      metadata: { motebitId: MID_B, publicKey: "22".repeat(32), bornAt: "not-a-date" },
      preserveMemories: false,
    } as unknown as Parameters<DesktopApp["restoreIdentity"]>[1]);
    await Promise.all(pending);
    expect(out.ok).toBe(true);
    // The first key-store write is the switch write-ahead; the key follows.
    expect(seen.map((s) => s.key)).toEqual(["pending_identity_switch", "device_private_key"]);
    expect(seen.every((s) => !s.live && s.disposed)).toBe(true);
    expect(app.machineRoster(invoke)).toBeNull();
    app.stop();
  });

  it("a pairing disposes before the switch, holds none during it, and the next roster is the new identity's", async () => {
    const app = appAs(MID_A, "desk-1");
    const during: boolean[] = [];
    const invoke = recorder((cmd) => {
      if (cmd === "keyring_set") during.push(app.machineRoster(invoke) != null);
    });
    const before = app.machineRoster(invoke)!;
    await app.completePairing(invoke, { motebitId: MID_B, deviceId: "desk-2" });
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((live) => !live)).toBe(true);
    expect(await disposed(before)).toBe(true);
    const after = app.machineRoster(invoke)!;
    expect(after).not.toBe(before);
    expect(after.motebitId).toBe(MID_B);
    expect(after.deviceId).toBe("desk-2");
    app.stop();
  });

  it("a pairing whose switch failed stays latched (no roster until reload)", async () => {
    const app = appAs(MID_A, "desk-1");
    const invoke = (async (cmd: string) => {
      if (cmd === "keyring_set") throw new Error("disk full");
      if (cmd === "read_config") return "{}";
      return null;
    }) as InvokeFn;
    app.machineRoster(invoke);
    await expect(
      app.completePairing(invoke, { motebitId: MID_B, deviceId: "desk-2" }),
    ).rejects.toThrow("disk full");
    expect(app.machineRoster(invoke)).toBeNull();
    app.stop();
  });

  it("S4: a sync connect reads the roster", async () => {
    const invoke = recorder();
    const app = appAs(MID_A, "desk-1");
    const r = app.machineRoster(invoke)!;
    const refresh = vi.spyOn(r.section, "refresh").mockResolvedValue(undefined);
    const sync = internals(app).sync;
    vi.spyOn(sync, "startSync").mockResolvedValue(undefined);
    const status = vi.spyOn(sync, "syncStatus", "get").mockReturnValue({ status: "error" });
    await app.startSync(invoke, "https://relay.test", "MASTER");
    expect(refresh).not.toHaveBeenCalled();
    status.mockReturnValue({ status: "connected" });
    await app.startSync(invoke, "https://relay.test", "MASTER");
    expect(refresh).toHaveBeenCalledTimes(1);
    app.stop();
  });
});
