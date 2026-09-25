// Key-file durability, build 3 (desktop). The Rust side (src-tauri:
// config_file.rs, key_store.rs, durable_file.rs) carries the file rules and
// their tests; these pin the TypeScript half of the contract:
//  * every desktop write of the SHARED config is a field-level
//    `update_config` merge — no JS read→write pair can revert a key the CLI
//    committed in between (inventory X2 / B-r2, C2, C11–C17);
//  * the write-ahead port's `setAside` moves `pending_rotation` out of the
//    active slot without destroying it, and REJECTS when it cannot.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { desktopWriteAhead } from "../key-rotation";
import { applyConfigPatch, updateConfig } from "../config-update";
import { mergeSettingsIntoConfig, settingsPatch } from "../ui/settings-config";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("the shared config is written only by field-level merge", () => {
  it("no desktop source invokes write_config (whole-document write-back)", () => {
    const files = sources(SRC);
    // Aperture: say what was examined, so a green result is not vacuous.
    expect(files.length).toBeGreaterThan(40);
    const offenders = files.filter((f) => /["']write_config["']/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it("updateConfig sends only the patch (and the CAS expectation) to Rust", async () => {
    const invoke = vi.fn(async () => undefined);
    await updateConfig(invoke as never, { theme: "dark", sync_url: null }, { _identity_file: "F" });
    expect(invoke).toHaveBeenCalledWith("update_config", {
      patch: JSON.stringify({ theme: "dark", sync_url: null }),
      expect: JSON.stringify({ _identity_file: "F" }),
    });
  });

  it("a Settings Save patch, applied to any config, equals the merge it replaces", () => {
    const onDisk = {
      motebit_id: "m",
      cli_encrypted_key: { ciphertext: "K" },
      default_model: "old",
      ollama_endpoint: "http://legacy",
      theme: "dark",
    };
    for (const form of [
      { default_provider: "openai" },
      { default_provider: "openai", default_model: "new", local_server_endpoint: undefined },
    ]) {
      const patch = settingsPatch(form);
      // Round-trips through JSON exactly as the IPC does.
      const sent = JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;
      expect(Object.keys(sent).some((k) => k.startsWith("cli_"))).toBe(false);
      expect(applyConfigPatch(onDisk, sent)).toEqual(
        JSON.parse(JSON.stringify(mergeSettingsIntoConfig(onDisk, form))),
      );
    }
  });
});

describe("desktop write-ahead port", () => {
  it("setAside invokes keyring_set_aside and rejects when the store cannot keep the bytes", async () => {
    const ok = vi.fn(async () => undefined);
    await desktopWriteAhead(ok as never).setAside();
    expect(ok).toHaveBeenCalledWith("keyring_set_aside", { key: "pending_rotation" });

    const failing = vi.fn(async () => {
      throw new Error("could not verify the preserved copy of pending_rotation");
    });
    await expect(desktopWriteAhead(failing as never).setAside()).rejects.toThrow(/preserved copy/);
  });

  it("a store that cannot be read loads as 'unreadable', never as nothing held (C8)", async () => {
    const damaged = vi.fn(async () => {
      throw new Error("dev-keyring.json is not a JSON object of strings: damaged");
    });
    await expect(desktopWriteAhead(damaged as never).load()).resolves.toBe("unreadable");
  });
});
