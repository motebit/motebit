import { describe, it, expect } from "vitest";
import * as keyringKeys from "../ui/keyring-keys";
import {
  DEVICE_PRIVATE_KEY_SLOT,
  ANTHROPIC_API_KEY_SLOT,
  OPENAI_API_KEY_SLOT,
  GOOGLE_API_KEY_SLOT,
  ELEVENLABS_API_KEY_SLOT,
  INWORLD_API_KEY_SLOT,
  DEEPGRAM_API_KEY_SLOT,
  LEGACY_API_KEY_SLOT,
  byokKeyringKey,
} from "../ui/keyring-keys";

describe("keyring-keys constants", () => {
  it("defines stable slot names", () => {
    expect(DEVICE_PRIVATE_KEY_SLOT).toBe("device_private_key");
    expect(ANTHROPIC_API_KEY_SLOT).toBe("anthropic_api_key");
    expect(OPENAI_API_KEY_SLOT).toBe("openai_api_key");
    expect(GOOGLE_API_KEY_SLOT).toBe("google_api_key");
    expect(ELEVENLABS_API_KEY_SLOT).toBe("elevenlabs_api_key");
    expect(INWORLD_API_KEY_SLOT).toBe("inworld_api_key");
    expect(DEEPGRAM_API_KEY_SLOT).toBe("deepgram_api_key");
    expect(LEGACY_API_KEY_SLOT).toBe("api_key");
  });
});

describe("the relay operator token has no slot (removed 2026-11-20)", () => {
  it("no exported constant names the old operator slot", () => {
    expect(Object.values(keyringKeys)).not.toContain("sync_master_token");
    expect(Object.keys(keyringKeys).filter((k) => /master/i.test(k))).toEqual([]);
  });
});

describe("byokKeyringKey", () => {
  it("maps anthropic to ANTHROPIC_API_KEY_SLOT", () => {
    expect(byokKeyringKey("anthropic")).toBe(ANTHROPIC_API_KEY_SLOT);
  });
  it("maps openai to OPENAI_API_KEY_SLOT", () => {
    expect(byokKeyringKey("openai")).toBe(OPENAI_API_KEY_SLOT);
  });
  it("maps google to GOOGLE_API_KEY_SLOT", () => {
    expect(byokKeyringKey("google")).toBe(GOOGLE_API_KEY_SLOT);
  });
  it("returns null for local-server", () => {
    expect(byokKeyringKey("local-server")).toBeNull();
  });
  it("returns null for proxy", () => {
    expect(byokKeyringKey("proxy")).toBeNull();
  });
});
