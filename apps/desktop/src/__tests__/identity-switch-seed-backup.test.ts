/**
 * The desktop's identity switch (restore, key-transfer pairing) rewrites
 * `motebit_id` in the SHARED ~/.motebit/config.json. A seed-backup
 * acknowledgment the CLI recorded there for the outgoing identity must never
 * be carried as the incoming identity's backup, and must never be deleted:
 * it is moved aside into `seed_backup_prior` (the one rule,
 * `setAsideReplacedSeedBackup` in @motebit/surface-kit).
 */
import { describe, it, expect } from "vitest";
import { applyConfigPatch } from "../config-update";
import {
  finishInterruptedIdentitySwitch,
  seedBackupSwitchPatch,
  switchIdentity,
} from "../identity-manager";
import type { InvokeFn } from "../tauri-storage";

/** Rust's side, in memory: the shared config, `update_config`'s merge + compare-and-swap, and the key store. */
function fakeTauri(config: Record<string, unknown>) {
  const state = { config: { ...config }, keyring: new Map<string, string>() };
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "read_config":
        return JSON.stringify(state.config);
      case "update_config": {
        const patch = JSON.parse(args!["patch"] as string) as Record<string, unknown>;
        if (args!["expect"] !== undefined) {
          const expected = JSON.parse(args!["expect"] as string) as Record<string, unknown>;
          for (const [k, v] of Object.entries(expected)) {
            const onDisk = state.config[k] ?? null;
            if (JSON.stringify(onDisk) !== JSON.stringify(v)) throw new Error(`conflict on ${k}`);
          }
        }
        state.config = applyConfigPatch(state.config, patch);
        return undefined;
      }
      case "keyring_set":
        state.keyring.set(args!["key"] as string, args!["value"] as string);
        return undefined;
      case "keyring_get":
        return state.keyring.get(args!["key"] as string) ?? null;
      case "keyring_set_aside":
        state.keyring.delete(args!["key"] as string);
        return undefined;
      default:
        throw new Error(`unexpected invoke ${cmd}`);
    }
  }) as InvokeFn;
  return { state, invoke };
}

const ACK = {
  seed_backed_up_at: 1_000,
  seed_backed_up_key: "aa".repeat(32),
  seed_backed_up_motebit_id: "X",
};

describe("desktop identity switch — the outgoing identity's seed backup is set aside, never carried", () => {
  it("switching X → Y moves X's acknowledgment into seed_backup_prior; nothing is current", async () => {
    const { state, invoke } = fakeTauri({ motebit_id: "X", device_id: "dx", ...ACK });
    await switchIdentity(invoke, { motebit_id: "Y", device_id: "dy" });
    expect(state.config["motebit_id"]).toBe("Y");
    expect(state.config["seed_backed_up_at"]).toBeUndefined();
    expect(state.config["seed_backed_up_key"]).toBeUndefined();
    expect(state.config["seed_backed_up_motebit_id"]).toBeUndefined();
    expect(state.config["seed_backup_prior"]).toEqual([
      { at: 1_000, key: "aa".repeat(32), motebit_id: "X" },
    ]);
  });

  it("an unbound (legacy) acknowledgment is kept aside the same way", async () => {
    const { state, invoke } = fakeTauri({ motebit_id: "X", device_id: "dx", seed_backed_up_at: 7 });
    await switchIdentity(invoke, { motebit_id: "Y", device_id: "dy" });
    expect(state.config["seed_backed_up_at"]).toBeUndefined();
    expect(state.config["seed_backup_prior"]).toEqual([{ at: 7, key: null, motebit_id: "X" }]);
  });

  it("re-applying an interrupted switch moves nothing twice and loses nothing", async () => {
    const { state, invoke } = fakeTauri({ motebit_id: "X", device_id: "dx", ...ACK });
    await switchIdentity(invoke, { motebit_id: "Y", device_id: "dy" });
    // The write-ahead survived (a crash before it was set aside): finished again.
    await invoke("keyring_set", {
      key: "pending_identity_switch",
      value: JSON.stringify({ motebit_id: "Y", device_id: "dy" }),
    });
    await finishInterruptedIdentitySwitch(invoke);
    expect(state.config["seed_backup_prior"]).toEqual([
      { at: 1_000, key: "aa".repeat(32), motebit_id: "X" },
    ]);
  });

  it("a switch that keeps the identity leaves its acknowledgment current", () => {
    const current = { motebit_id: "X", device_id: "dx", ...ACK };
    expect(seedBackupSwitchPatch(current, { motebit_id: "X", device_id: "dx2" })).toEqual({
      patch: {},
    });
  });
});
