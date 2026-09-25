// Settings Save writes into the SHARED ~/.motebit/config.json — the file the
// CLI keeps its only identity-key copy in. It once built the file from
// scratch and dropped every field it did not own.
import { describe, it, expect } from "vitest";
import { mergeSettingsIntoConfig } from "../ui/settings-config";

const onDisk = {
  motebit_id: "m-1",
  device_id: "d-1",
  device_public_key: "aa".repeat(32),
  cli_encrypted_key: { ciphertext: "c", nonce: "n", tag: "t", salt: "s" },
  cli_private_key: "legacy-plaintext",
  sync_url: "https://relay.example",
  _identity_file: "---signed---",
  default_provider: "anthropic",
  default_model: "old-model",
  local_server_endpoint: "http://old:11434",
  ollama_endpoint: "http://legacy:11434",
  interior_color_preset: "legacy",
};

describe("mergeSettingsIntoConfig", () => {
  it("carries every identity and key field through a Save", () => {
    const merged = mergeSettingsIntoConfig(onDisk, { default_provider: "openai" });
    for (const k of [
      "motebit_id",
      "device_id",
      "device_public_key",
      "cli_encrypted_key",
      "cli_private_key",
      "sync_url",
      "_identity_file",
    ] as const) {
      expect(merged[k]).toEqual(onDisk[k]);
    }
    expect(merged.default_provider).toBe("openai");
  });

  it("the fields the form owns are overwritten, and cleared ones removed (legacy spellings too)", () => {
    const merged = mergeSettingsIntoConfig(onDisk, { default_provider: "openai" });
    expect(merged).not.toHaveProperty("default_model");
    expect(merged).not.toHaveProperty("local_server_endpoint");
    expect(merged).not.toHaveProperty("ollama_endpoint");
    expect(merged).not.toHaveProperty("interior_color_preset");
    const set = mergeSettingsIntoConfig(onDisk, { default_model: "new-model" });
    expect(set.default_model).toBe("new-model");
  });
});
