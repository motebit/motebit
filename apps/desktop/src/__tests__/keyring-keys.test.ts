import { describe, it, expect } from "vitest";
import {
  DEVICE_PRIVATE_KEY_SLOT,
  ANTHROPIC_API_KEY_SLOT,
  OPENAI_API_KEY_SLOT,
  GOOGLE_API_KEY_SLOT,
  WHISPER_API_KEY_SLOT,
  SYNC_MASTER_TOKEN_SLOT,
  LEGACY_API_KEY_SLOT,
  byokKeyringKey,
} from "../ui/keyring-keys";

describe("keyring-keys constants", () => {
  it("defines stable slot names", () => {
    expect(DEVICE_PRIVATE_KEY_SLOT).toBe("device_private_key");
    expect(ANTHROPIC_API_KEY_SLOT).toBe("anthropic_api_key");
    expect(OPENAI_API_KEY_SLOT).toBe("openai_api_key");
    expect(GOOGLE_API_KEY_SLOT).toBe("google_api_key");
    expect(WHISPER_API_KEY_SLOT).toBe("whisper_api_key");
    expect(SYNC_MASTER_TOKEN_SLOT).toBe("sync_master_token");
    expect(LEGACY_API_KEY_SLOT).toBe("api_key");
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
