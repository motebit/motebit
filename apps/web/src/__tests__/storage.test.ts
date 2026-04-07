/**
 * Storage module tests — localStorage persistence for provider config,
 * soul color, sync URL, governance, voice, proxy token, balance,
 * and legacy conversation migration.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveProviderConfig,
  loadProviderConfig,
  clearProviderConfig,
  saveSoulColor,
  loadSoulColor,
  saveSyncUrl,
  loadSyncUrl,
  clearSyncUrl,
  saveGovernanceConfig,
  loadGovernanceConfig,
  saveVoiceConfig,
  loadVoiceConfig,
  hasCeilingBeenShown,
  markCeilingShown,
  saveProxyToken,
  loadProxyToken,
  clearProxyToken,
  saveBalance,
  loadBalance,
  needsMigration,
  loadLegacyConversations,
  markMigrationDone,
  type ProviderConfig,
  type GovernanceConfig,
  type VoiceConfig,
  type ProxyTokenData,
} from "../storage.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("ProviderConfig persistence (UnifiedProviderConfig)", () => {
  it("saves and loads BYOK anthropic config", () => {
    const config: ProviderConfig = {
      mode: "byok",
      vendor: "anthropic",
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
    };
    saveProviderConfig(config);
    expect(loadProviderConfig()).toEqual(config);
  });

  it("returns null when no config saved", () => {
    expect(loadProviderConfig()).toBeNull();
  });

  it("clears provider config", () => {
    saveProviderConfig({ mode: "byok", vendor: "anthropic", apiKey: "k" });
    clearProviderConfig();
    expect(loadProviderConfig()).toBeNull();
  });

  it("returns null on corrupt JSON in localStorage", () => {
    localStorage.setItem("motebit-provider", "{bad json!!!");
    expect(loadProviderConfig()).toBeNull();
  });

  it("round-trips BYOK openai config", () => {
    const config: ProviderConfig = {
      mode: "byok",
      vendor: "openai",
      apiKey: "sk-openai",
      model: "gpt-5.4-mini",
    };
    saveProviderConfig(config);
    expect(loadProviderConfig()).toEqual(config);
  });

  it("round-trips on-device/local-server config", () => {
    const config: ProviderConfig = {
      mode: "on-device",
      backend: "local-server",
      model: "llama3",
      endpoint: "http://localhost:11434",
    };
    saveProviderConfig(config);
    expect(loadProviderConfig()).toEqual(config);
  });

  it("round-trips on-device/webllm config", () => {
    const config: ProviderConfig = {
      mode: "on-device",
      backend: "webllm",
      model: "Llama-3-8B-Instruct-q4f16_1",
    };
    saveProviderConfig(config);
    expect(loadProviderConfig()).toEqual(config);
  });

  it("round-trips motebit-cloud config with proxyToken", () => {
    const config: ProviderConfig = {
      mode: "motebit-cloud",
      model: "claude-sonnet-4-6",
      proxyToken: "tok_abc",
    };
    saveProviderConfig(config);
    expect(loadProviderConfig()).toEqual(config);
  });

  it("migrates legacy web proxy config on load", () => {
    localStorage.setItem(
      "motebit-provider",
      JSON.stringify({ type: "proxy", model: "claude-sonnet-4-6", proxyToken: "tok_abc" }),
    );
    const loaded = loadProviderConfig();
    expect(loaded?.mode).toBe("motebit-cloud");
    if (loaded?.mode === "motebit-cloud") {
      expect(loaded.model).toBe("claude-sonnet-4-6");
      expect(loaded.proxyToken).toBe("tok_abc");
    }
  });

  it("migrates legacy ollama config to on-device/local-server", () => {
    localStorage.setItem(
      "motebit-provider",
      JSON.stringify({
        type: "ollama",
        model: "llama3.2",
        baseUrl: "http://localhost:11434",
      }),
    );
    const loaded = loadProviderConfig();
    expect(loaded?.mode).toBe("on-device");
    if (loaded?.mode === "on-device") {
      expect(loaded.backend).toBe("local-server");
      expect(loaded.endpoint).toBe("http://localhost:11434");
    }
  });

  it("migrates legacy anthropic BYOK config", () => {
    localStorage.setItem(
      "motebit-provider",
      JSON.stringify({ type: "anthropic", apiKey: "sk-xxx", model: "claude-opus-4-6" }),
    );
    const loaded = loadProviderConfig();
    expect(loaded?.mode).toBe("byok");
    if (loaded?.mode === "byok") {
      expect(loaded.vendor).toBe("anthropic");
      expect(loaded.apiKey).toBe("sk-xxx");
    }
  });

  it("preserves optional fields (maxTokens, temperature, baseUrl)", () => {
    const config: ProviderConfig = {
      mode: "byok",
      vendor: "openai",
      apiKey: "k",
      model: "gpt-5.4-mini",
      baseUrl: "https://custom.api",
      maxTokens: 2048,
      temperature: 0.5,
    };
    saveProviderConfig(config);
    expect(loadProviderConfig()).toEqual(config);
  });
});

describe("SoulColor persistence", () => {
  it("saves and loads soul color", () => {
    const config = { preset: "violet", customHue: 270, customSaturation: 0.8 };
    saveSoulColor(config);
    expect(loadSoulColor()).toEqual(config);
  });

  it("returns null when no color saved", () => {
    expect(loadSoulColor()).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    localStorage.setItem("motebit-soul-color", "not-json");
    expect(loadSoulColor()).toBeNull();
  });
});

describe("SyncUrl persistence", () => {
  it("saves and loads sync URL", () => {
    saveSyncUrl("https://relay.motebit.com");
    expect(loadSyncUrl()).toBe("https://relay.motebit.com");
  });

  it("clears sync URL", () => {
    saveSyncUrl("https://relay.motebit.com");
    clearSyncUrl();
    expect(loadSyncUrl()).toBeNull();
  });
});

describe("GovernanceConfig persistence", () => {
  it("round-trips governance config", () => {
    const gov: GovernanceConfig = {
      approvalPreset: "balanced",
      persistenceThreshold: 0.7,
      rejectSecrets: true,
      maxCallsPerTurn: 10,
    };
    saveGovernanceConfig(gov);
    expect(loadGovernanceConfig()).toEqual(gov);
  });

  it("returns null when nothing saved", () => {
    expect(loadGovernanceConfig()).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    localStorage.setItem("motebit-governance", "{{");
    expect(loadGovernanceConfig()).toBeNull();
  });
});

describe("VoiceConfig persistence", () => {
  it("round-trips voice config", () => {
    const voice: VoiceConfig = { ttsVoice: "Samantha", autoSend: true, voiceResponse: false };
    saveVoiceConfig(voice);
    expect(loadVoiceConfig()).toEqual(voice);
  });

  it("returns null when nothing saved", () => {
    expect(loadVoiceConfig()).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    localStorage.setItem("motebit-voice", "[broken");
    expect(loadVoiceConfig()).toBeNull();
  });
});

describe("ProxyToken persistence", () => {
  const token: ProxyTokenData = {
    token: "signed.jwt.token",
    balance: 5_000_000,
    balanceUsd: 5.0,
    expiresAt: Date.now() + 86400000,
    motebitId: "mb_test123",
  };

  it("round-trips proxy token", () => {
    saveProxyToken(token);
    expect(loadProxyToken()).toEqual(token);
  });

  it("returns null when nothing saved", () => {
    expect(loadProxyToken()).toBeNull();
  });

  it("clearProxyToken removes saved token", () => {
    saveProxyToken(token);
    clearProxyToken();
    expect(loadProxyToken()).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    localStorage.setItem("motebit-proxy-token", "corrupt");
    expect(loadProxyToken()).toBeNull();
  });
});

describe("Balance persistence", () => {
  it("round-trips balance", () => {
    saveBalance(12.34);
    expect(loadBalance()).toBe(12.34);
  });

  it("returns 0 when nothing saved", () => {
    expect(loadBalance()).toBe(0);
  });
});

describe("Ceiling CTA", () => {
  it("tracks session-scoped ceiling display", () => {
    expect(hasCeilingBeenShown()).toBe(false);
    markCeilingShown();
    expect(hasCeilingBeenShown()).toBe(true);
  });
});

describe("Legacy conversation migration", () => {
  it("reports no migration needed when no legacy data exists", () => {
    expect(needsMigration()).toBe(false);
  });

  it("reports migration needed when legacy index exists", () => {
    localStorage.setItem(
      "motebit-conv-index",
      JSON.stringify([{ id: "c1", title: "Test", lastActiveAt: Date.now(), messageCount: 2 }]),
    );
    expect(needsMigration()).toBe(true);
  });

  it("reports no migration needed after migration is done", () => {
    localStorage.setItem("motebit-conv-index", JSON.stringify([]));
    markMigrationDone();
    expect(needsMigration()).toBe(false);
  });

  it("loads legacy conversations from localStorage", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: "hi", timestamp: 1001 },
    ];
    localStorage.setItem(
      "motebit-conv-index",
      JSON.stringify([{ id: "c1", title: "Chat 1", lastActiveAt: 1001, messageCount: 2 }]),
    );
    localStorage.setItem("motebit-conv-c1", JSON.stringify(messages));

    const legacy = loadLegacyConversations();
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.title).toBe("Chat 1");
    expect(legacy[0]!.messages).toHaveLength(2);
    expect(legacy[0]!.messages[0]!.content).toBe("hello");
  });

  it("returns empty array for corrupted index", () => {
    localStorage.setItem("motebit-conv-index", "not json");
    expect(loadLegacyConversations()).toEqual([]);
  });
});
