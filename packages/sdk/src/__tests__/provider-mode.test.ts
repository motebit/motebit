import { describe, it, expect } from "vitest";
import {
  migrateLegacyProvider,
  isLocalServerUrl,
  defaultProviderConfig,
  type UnifiedProviderConfig,
} from "../index";

describe("isLocalServerUrl", () => {
  it("detects localhost variants", () => {
    expect(isLocalServerUrl("http://localhost:11434")).toBe(true);
    expect(isLocalServerUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLocalServerUrl("http://0.0.0.0:8080")).toBe(true);
    expect(isLocalServerUrl("http://motebit.local")).toBe(true);
  });
  it("detects private LAN ranges", () => {
    expect(isLocalServerUrl("http://192.168.1.10:11434")).toBe(true);
    expect(isLocalServerUrl("http://10.0.0.5:8080")).toBe(true);
    expect(isLocalServerUrl("http://172.16.0.1:8080")).toBe(true);
    expect(isLocalServerUrl("http://172.31.255.1:8080")).toBe(true);
  });
  it("rejects public URLs and bad input", () => {
    expect(isLocalServerUrl("https://api.anthropic.com")).toBe(false);
    expect(isLocalServerUrl("http://172.15.0.1")).toBe(false); // outside 16-31
    expect(isLocalServerUrl("http://172.32.0.1")).toBe(false);
    expect(isLocalServerUrl(undefined)).toBe(false);
    expect(isLocalServerUrl(null)).toBe(false);
    expect(isLocalServerUrl("not a url")).toBe(false);
  });
});

describe("defaultProviderConfig", () => {
  it("returns motebit-cloud by default", () => {
    const c = defaultProviderConfig();
    expect(c.mode).toBe("motebit-cloud");
  });
});

describe("migrateLegacyProvider — passthrough", () => {
  it("passes through already-new on-device config", () => {
    const input: UnifiedProviderConfig = {
      mode: "on-device",
      backend: "apple-fm",
      model: "foundation-v1",
    };
    expect(migrateLegacyProvider(input)).toEqual(input);
  });
  it("passes through already-new byok config", () => {
    const input: UnifiedProviderConfig = {
      mode: "byok",
      vendor: "anthropic",
      apiKey: "sk-ant-xxx",
      model: "claude-sonnet-4-6",
    };
    expect(migrateLegacyProvider(input)).toEqual(input);
  });
});

describe("migrateLegacyProvider — web legacy shape", () => {
  it("maps proxy → motebit-cloud", () => {
    const out = migrateLegacyProvider({
      type: "proxy",
      model: "claude-sonnet-4-6",
      proxyToken: "tok-xxx",
    });
    expect(out).toEqual({
      mode: "motebit-cloud",
      model: "claude-sonnet-4-6",
      proxyToken: "tok-xxx",
      baseUrl: undefined,
      maxTokens: undefined,
      temperature: undefined,
    });
  });
  it("maps anthropic → byok/anthropic", () => {
    const out = migrateLegacyProvider({
      type: "anthropic",
      apiKey: "sk-ant-xxx",
      model: "claude-opus-4-6",
    });
    expect(out?.mode).toBe("byok");
    if (out?.mode === "byok") {
      expect(out.vendor).toBe("anthropic");
      expect(out.apiKey).toBe("sk-ant-xxx");
    }
  });
  it("maps openai → byok/openai", () => {
    const out = migrateLegacyProvider({
      type: "openai",
      apiKey: "sk-xxx",
      model: "gpt-5.4",
    });
    expect(out?.mode).toBe("byok");
    if (out?.mode === "byok") expect(out.vendor).toBe("openai");
  });
  it("maps webllm → on-device/webllm", () => {
    const out = migrateLegacyProvider({
      type: "webllm",
      model: "Llama-3.1-8B",
    });
    expect(out?.mode).toBe("on-device");
    if (out?.mode === "on-device") expect(out.backend).toBe("webllm");
  });
  it("maps ollama with localhost URL → on-device/local-server", () => {
    const out = migrateLegacyProvider({
      type: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.2",
    });
    expect(out?.mode).toBe("on-device");
    if (out?.mode === "on-device") {
      expect(out.backend).toBe("local-server");
      expect(out.endpoint).toBe("http://localhost:11434");
    }
  });
});

describe("migrateLegacyProvider — mobile legacy shape", () => {
  it("maps hybrid → motebit-cloud", () => {
    const out = migrateLegacyProvider({ provider: "hybrid", model: "auto" });
    expect(out?.mode).toBe("motebit-cloud");
  });
  it("maps local + apple-fm → on-device/apple-fm", () => {
    const out = migrateLegacyProvider({
      provider: "local",
      localBackend: "apple-fm",
      model: "foundation",
    });
    expect(out?.mode).toBe("on-device");
    if (out?.mode === "on-device") expect(out.backend).toBe("apple-fm");
  });
  it("maps local + mlx → on-device/mlx", () => {
    const out = migrateLegacyProvider({
      provider: "local",
      localBackend: "mlx",
      model: "mlx-llama",
    });
    if (out?.mode === "on-device") expect(out.backend).toBe("mlx");
  });
  it("maps ollama with LAN endpoint → on-device/local-server preserving endpoint", () => {
    const out = migrateLegacyProvider({
      provider: "ollama",
      ollamaEndpoint: "http://192.168.1.42:11434",
      model: "llama3.2",
    });
    if (out?.mode === "on-device") {
      expect(out.backend).toBe("local-server");
      expect(out.endpoint).toBe("http://192.168.1.42:11434");
    }
  });
});

describe("migrateLegacyProvider — CLI legacy shape", () => {
  it("maps default_provider anthropic → byok/anthropic", () => {
    const out = migrateLegacyProvider({
      default_provider: "anthropic",
      default_model: "claude-sonnet-4-6",
    });
    expect(out?.mode).toBe("byok");
    if (out?.mode === "byok") {
      expect(out.vendor).toBe("anthropic");
      expect(out.model).toBe("claude-sonnet-4-6");
    }
  });
  it("maps default_provider ollama → on-device/local-server", () => {
    const out = migrateLegacyProvider({
      default_provider: "ollama",
      default_model: "llama3.2",
    });
    expect(out?.mode).toBe("on-device");
    if (out?.mode === "on-device") expect(out.backend).toBe("local-server");
  });
});

describe("migrateLegacyProvider — edge cases", () => {
  it("returns null for null/undefined", () => {
    expect(migrateLegacyProvider(null)).toBeNull();
    expect(migrateLegacyProvider(undefined)).toBeNull();
  });
  it("returns null when discriminator missing", () => {
    expect(migrateLegacyProvider({ model: "xxx" })).toBeNull();
  });
  it("returns null for unknown kind", () => {
    expect(migrateLegacyProvider({ type: "unknown-future" })).toBeNull();
  });
});
