import { describe, it, expect } from "vitest";
import {
  resolveProviderSpec,
  normalizeLocalServerEndpoint,
  defaultModelForVendor,
  canonicalVendorBaseUrl,
  GOOGLE_OPENAI_COMPAT_URL,
  DEFAULT_MOTEBIT_CLOUD_URL,
  UnsupportedBackendError,
  type ResolverEnv,
  type UnifiedProviderConfig,
  DEFAULT_PROXY_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_OLLAMA_MODEL,
} from "../index";

// === Test fixtures ===

/**
 * A maximally permissive env: every backend supported, no URL substitution,
 * no motebit-cloud overrides. Specific tests override individual fields to
 * exercise the surface-specific behaviors.
 */
function makeEnv(overrides: Partial<ResolverEnv> = {}): ResolverEnv {
  return {
    cloudBaseUrl: (_protocol, canonical) => canonical,
    defaultLocalServerUrl: "http://127.0.0.1:11434",
    supportedBackends: new Set(["webllm", "apple-fm", "mlx", "local-server"]),
    ...overrides,
  };
}

// === defaultModelForVendor ===

describe("defaultModelForVendor", () => {
  it("returns the default model for each vendor", () => {
    expect(defaultModelForVendor("anthropic")).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(defaultModelForVendor("openai")).toBe(DEFAULT_OPENAI_MODEL);
    expect(defaultModelForVendor("google")).toBe(DEFAULT_GOOGLE_MODEL);
  });
});

// === canonicalVendorBaseUrl ===

describe("canonicalVendorBaseUrl", () => {
  it("returns the canonical URL for each vendor", () => {
    expect(canonicalVendorBaseUrl("anthropic")).toBe("https://api.anthropic.com");
    expect(canonicalVendorBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(canonicalVendorBaseUrl("google")).toBe(GOOGLE_OPENAI_COMPAT_URL);
  });
});

// === resolveProviderSpec — motebit-cloud mode ===

describe("resolveProviderSpec — motebit-cloud", () => {
  it("returns a cloud spec speaking the anthropic protocol", () => {
    const spec = resolveProviderSpec(
      { mode: "motebit-cloud", model: "claude-sonnet-4-6", proxyToken: "tok-xxx" },
      makeEnv(),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") {
      expect(spec.wireProtocol).toBe("anthropic");
      expect(spec.apiKey).toBe(""); // relay injects
      expect(spec.model).toBe("claude-sonnet-4-6");
      expect(spec.extraHeaders).toEqual({ "x-proxy-token": "tok-xxx" });
    }
  });
  it("falls back to DEFAULT_PROXY_MODEL when no model is specified", () => {
    const spec = resolveProviderSpec({ mode: "motebit-cloud" }, makeEnv());
    if (spec.kind === "cloud") expect(spec.model).toBe(DEFAULT_PROXY_MODEL);
  });
  it("uses the env's motebitCloudBaseUrl when config.baseUrl is absent", () => {
    const spec = resolveProviderSpec(
      { mode: "motebit-cloud" },
      makeEnv({ motebitCloudBaseUrl: "https://staging.motebit.com" }),
    );
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe("https://staging.motebit.com");
  });
  it("config.baseUrl takes precedence over env.motebitCloudBaseUrl", () => {
    const spec = resolveProviderSpec(
      { mode: "motebit-cloud", baseUrl: "https://override.example.com" },
      makeEnv({ motebitCloudBaseUrl: "https://staging.motebit.com" }),
    );
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe("https://override.example.com");
  });
  it("defaults baseUrl to DEFAULT_MOTEBIT_CLOUD_URL when both absent", () => {
    const spec = resolveProviderSpec({ mode: "motebit-cloud" }, makeEnv());
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe(DEFAULT_MOTEBIT_CLOUD_URL);
  });
  it("merges config proxyToken with env motebitCloudHeaders", () => {
    const spec = resolveProviderSpec(
      { mode: "motebit-cloud", proxyToken: "tok-config" },
      makeEnv({ motebitCloudHeaders: { "x-trace-id": "abc" } }),
    );
    if (spec.kind === "cloud") {
      expect(spec.extraHeaders).toEqual({
        "x-proxy-token": "tok-config",
        "x-trace-id": "abc",
      });
    }
  });
  it("propagates env headers when no proxy token is set", () => {
    const spec = resolveProviderSpec(
      { mode: "motebit-cloud" },
      makeEnv({ motebitCloudHeaders: { "x-session": "s1" } }),
    );
    if (spec.kind === "cloud") expect(spec.extraHeaders).toEqual({ "x-session": "s1" });
  });
  it("uses env.motebitCloudDefaultModel before falling back to DEFAULT_PROXY_MODEL", () => {
    const spec = resolveProviderSpec(
      { mode: "motebit-cloud" },
      makeEnv({ motebitCloudDefaultModel: "claude-haiku-4-5-20251001" }),
    );
    if (spec.kind === "cloud") expect(spec.model).toBe("claude-haiku-4-5-20251001");
  });
});

// === resolveProviderSpec — byok mode ===

describe("resolveProviderSpec — byok anthropic", () => {
  it("returns a cloud spec speaking the anthropic protocol", () => {
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "anthropic", apiKey: "sk-ant-xxx", model: "claude-opus-4-6" },
      makeEnv(),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") {
      expect(spec.wireProtocol).toBe("anthropic");
      expect(spec.apiKey).toBe("sk-ant-xxx");
      expect(spec.model).toBe("claude-opus-4-6");
      expect(spec.baseUrl).toBe("https://api.anthropic.com");
    }
  });
  it("falls back to DEFAULT_ANTHROPIC_MODEL", () => {
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "anthropic", apiKey: "sk-ant-xxx" },
      makeEnv(),
    );
    if (spec.kind === "cloud") expect(spec.model).toBe(DEFAULT_ANTHROPIC_MODEL);
  });
  it("env.cloudBaseUrl can substitute the canonical URL (browser CORS proxy)", () => {
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "anthropic", apiKey: "sk-ant-xxx" },
      makeEnv({
        cloudBaseUrl: (proto, canonical) =>
          proto === "anthropic" ? "https://proxy.example.com" : canonical,
      }),
    );
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe("https://proxy.example.com");
  });
  it("user-supplied baseUrl wins over canonical", () => {
    const spec = resolveProviderSpec(
      {
        mode: "byok",
        vendor: "anthropic",
        apiKey: "sk-ant-xxx",
        baseUrl: "https://my-anthropic-proxy.example.com",
      },
      makeEnv(),
    );
    if (spec.kind === "cloud") {
      expect(spec.baseUrl).toBe("https://my-anthropic-proxy.example.com");
    }
  });
});

describe("resolveProviderSpec — byok openai", () => {
  it("returns a cloud spec speaking the openai protocol", () => {
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "openai", apiKey: "sk-xxx", model: "gpt-5.4" },
      makeEnv(),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") {
      expect(spec.wireProtocol).toBe("openai");
      expect(spec.apiKey).toBe("sk-xxx");
      expect(spec.baseUrl).toBe("https://api.openai.com/v1");
    }
  });
  it("falls back to DEFAULT_OPENAI_MODEL", () => {
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "openai", apiKey: "sk-xxx" },
      makeEnv(),
    );
    if (spec.kind === "cloud") expect(spec.model).toBe(DEFAULT_OPENAI_MODEL);
  });
});

describe("resolveProviderSpec — byok google", () => {
  it("dispatches Google as openai-compat at the Google endpoint", () => {
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "google", apiKey: "AIza-xxx", model: "gemini-2.5-pro" },
      makeEnv(),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") {
      expect(spec.wireProtocol).toBe("openai");
      expect(spec.apiKey).toBe("AIza-xxx");
      expect(spec.baseUrl).toBe(GOOGLE_OPENAI_COMPAT_URL);
    }
  });
  it("falls back to DEFAULT_GOOGLE_MODEL", () => {
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "google", apiKey: "AIza-xxx" },
      makeEnv(),
    );
    if (spec.kind === "cloud") expect(spec.model).toBe(DEFAULT_GOOGLE_MODEL);
  });
});

// === resolveProviderSpec — on-device mode ===

describe("resolveProviderSpec — on-device webllm", () => {
  it("returns a webllm spec", () => {
    const spec = resolveProviderSpec(
      { mode: "on-device", backend: "webllm", model: "Phi-3.5" },
      makeEnv(),
    );
    expect(spec.kind).toBe("webllm");
    if (spec.kind === "webllm") expect(spec.model).toBe("Phi-3.5");
  });
  it("falls back to DEFAULT_WEBLLM_MODEL", () => {
    const spec = resolveProviderSpec({ mode: "on-device", backend: "webllm" }, makeEnv());
    if (spec.kind === "webllm") {
      expect(spec.model).toMatch(/Llama|Phi/);
    }
  });
  it("throws when webllm is not supported on the surface", () => {
    expect(() =>
      resolveProviderSpec(
        { mode: "on-device", backend: "webllm" },
        makeEnv({ supportedBackends: new Set(["local-server"]) }),
      ),
    ).toThrow(UnsupportedBackendError);
  });
});

describe("resolveProviderSpec — on-device apple-fm", () => {
  it("returns an apple-fm spec", () => {
    const spec = resolveProviderSpec({ mode: "on-device", backend: "apple-fm" }, makeEnv());
    expect(spec.kind).toBe("apple-fm");
  });
  it("throws when apple-fm is not supported (web/desktop/cli)", () => {
    expect(() =>
      resolveProviderSpec(
        { mode: "on-device", backend: "apple-fm" },
        makeEnv({ supportedBackends: new Set(["local-server"]) }),
      ),
    ).toThrow(UnsupportedBackendError);
  });
});

describe("resolveProviderSpec — on-device mlx", () => {
  it("returns an mlx spec", () => {
    const spec = resolveProviderSpec(
      { mode: "on-device", backend: "mlx", model: "mlx-llama-3-8b" },
      makeEnv(),
    );
    expect(spec.kind).toBe("mlx");
    if (spec.kind === "mlx") expect(spec.model).toBe("mlx-llama-3-8b");
  });
});

describe("resolveProviderSpec — on-device local-server (always OpenAI-compat)", () => {
  it("dispatches Ollama as OpenAI-compat with /v1 appended", () => {
    const spec = resolveProviderSpec(
      {
        mode: "on-device",
        backend: "local-server",
        endpoint: "http://localhost:11434",
        model: "llama3.2",
      },
      makeEnv(),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") {
      expect(spec.wireProtocol).toBe("openai");
      expect(spec.baseUrl).toBe("http://localhost:11434/v1");
      expect(spec.model).toBe("llama3.2");
      expect(spec.apiKey).toBe("local"); // sentinel for local servers
    }
  });
  it("dispatches LM Studio (port 1234) as OpenAI-compat with /v1", () => {
    const spec = resolveProviderSpec(
      {
        mode: "on-device",
        backend: "local-server",
        endpoint: "http://localhost:1234",
        model: "phi-3",
      },
      makeEnv(),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") {
      expect(spec.wireProtocol).toBe("openai");
      expect(spec.baseUrl).toBe("http://localhost:1234/v1");
      expect(spec.model).toBe("phi-3");
    }
  });
  it("dispatches llama.cpp (port 8080) as OpenAI-compat", () => {
    const spec = resolveProviderSpec(
      { mode: "on-device", backend: "local-server", endpoint: "http://localhost:8080" },
      makeEnv(),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe("http://localhost:8080/v1");
  });
  it("dispatches Jan (port 1337) as OpenAI-compat", () => {
    const spec = resolveProviderSpec(
      { mode: "on-device", backend: "local-server", endpoint: "http://localhost:1337" },
      makeEnv(),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe("http://localhost:1337/v1");
  });
  it("does not double-append /v1 when the user already includes it", () => {
    const spec = resolveProviderSpec(
      { mode: "on-device", backend: "local-server", endpoint: "http://localhost:11434/v1" },
      makeEnv(),
    );
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe("http://localhost:11434/v1");
  });
  it("falls back to env.defaultLocalServerUrl when no endpoint specified", () => {
    const spec = resolveProviderSpec(
      { mode: "on-device", backend: "local-server" },
      makeEnv({ defaultLocalServerUrl: "http://192.168.1.50:11434" }),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe("http://192.168.1.50:11434/v1");
  });
  it("preserves LAN endpoints (not just localhost)", () => {
    const spec = resolveProviderSpec(
      {
        mode: "on-device",
        backend: "local-server",
        endpoint: "http://192.168.1.42:11434",
      },
      makeEnv(),
    );
    if (spec.kind === "cloud") {
      expect(spec.baseUrl).toBe("http://192.168.1.42:11434/v1");
    }
  });
  it("falls back to DEFAULT_OLLAMA_MODEL when no model specified", () => {
    const spec = resolveProviderSpec(
      { mode: "on-device", backend: "local-server", endpoint: "http://localhost:11434" },
      makeEnv(),
    );
    if (spec.kind === "cloud") expect(spec.model).toBe(DEFAULT_OLLAMA_MODEL);
  });
  it("env.localServerBaseUrl substitution applied before /v1 normalization", () => {
    // Desktop dev-mode pattern: env rewrites the endpoint to a Vite proxy
    // path. The resolver still appends /v1 to that path so the upstream
    // proxy delivers requests to {ollama}/v1/chat/completions.
    const spec = resolveProviderSpec(
      { mode: "on-device", backend: "local-server", model: "llama3.2" },
      makeEnv({
        defaultLocalServerUrl: "http://127.0.0.1:11434",
        localServerBaseUrl: () => "/api/ollama",
      }),
    );
    expect(spec.kind).toBe("cloud");
    if (spec.kind === "cloud") {
      expect(spec.wireProtocol).toBe("openai");
      expect(spec.baseUrl).toBe("/api/ollama/v1");
      expect(spec.model).toBe("llama3.2");
    }
  });
});

describe("normalizeLocalServerEndpoint", () => {
  it("appends /v1 to a bare host", () => {
    expect(normalizeLocalServerEndpoint("http://localhost:11434")).toBe(
      "http://localhost:11434/v1",
    );
  });
  it("strips trailing slash before appending", () => {
    expect(normalizeLocalServerEndpoint("http://localhost:11434/")).toBe(
      "http://localhost:11434/v1",
    );
  });
  it("is idempotent — preserves existing /v1", () => {
    expect(normalizeLocalServerEndpoint("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
    expect(normalizeLocalServerEndpoint("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434/v1",
    );
  });
  it("preserves longer /v1 paths", () => {
    expect(
      normalizeLocalServerEndpoint("https://generativelanguage.googleapis.com/v1beta/openai"),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/openai/v1");
    // Note: Google's URL is special — surfaces should pass it untransformed,
    // not through this normalizer. The normalizer is for local-server only.
  });
  it("works on dev proxy paths", () => {
    expect(normalizeLocalServerEndpoint("/api/ollama")).toBe("/api/ollama/v1");
  });
});

// === Realistic per-surface env scenarios (integration smoke tests) ===

describe("resolveProviderSpec — surface scenarios", () => {
  it("web env: anthropic byok routes through CORS proxy", () => {
    const webEnv: ResolverEnv = {
      cloudBaseUrl: (proto, canonical) =>
        proto === "anthropic" ? "https://api.motebit.com" : canonical,
      defaultLocalServerUrl: "http://127.0.0.1:11434",
      supportedBackends: new Set(["webllm", "local-server"]),
    };
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "anthropic", apiKey: "sk-ant-xxx" },
      webEnv,
    );
    if (spec.kind === "cloud") {
      expect(spec.baseUrl).toBe("https://api.motebit.com");
    }
  });
  it("desktop dev env: anthropic byok goes through Vite proxy path", () => {
    const desktopDevEnv: ResolverEnv = {
      cloudBaseUrl: (proto) => (proto === "anthropic" ? "/api/anthropic" : "/api/openai"),
      defaultLocalServerUrl: "/api/ollama",
      supportedBackends: new Set(["local-server"]),
    };
    const spec = resolveProviderSpec(
      { mode: "byok", vendor: "anthropic", apiKey: "sk-ant-xxx" },
      desktopDevEnv,
    );
    if (spec.kind === "cloud") expect(spec.baseUrl).toBe("/api/anthropic");
  });
  it("mobile env: apple-fm allowed, webllm blocked", () => {
    const mobileEnv: ResolverEnv = {
      cloudBaseUrl: (_, canonical) => canonical,
      defaultLocalServerUrl: "http://127.0.0.1:11434",
      supportedBackends: new Set(["apple-fm", "mlx", "local-server"]),
    };
    expect(resolveProviderSpec({ mode: "on-device", backend: "apple-fm" }, mobileEnv).kind).toBe(
      "apple-fm",
    );
    expect(() => resolveProviderSpec({ mode: "on-device", backend: "webllm" }, mobileEnv)).toThrow(
      UnsupportedBackendError,
    );
  });
  it("cli env: only local-server backend, no on-device native", () => {
    const cliEnv: ResolverEnv = {
      cloudBaseUrl: (_, canonical) => canonical,
      defaultLocalServerUrl: "http://127.0.0.1:11434",
      supportedBackends: new Set(["local-server"]),
    };
    expect(() => resolveProviderSpec({ mode: "on-device", backend: "apple-fm" }, cliEnv)).toThrow(
      UnsupportedBackendError,
    );
    expect(() => resolveProviderSpec({ mode: "on-device", backend: "webllm" }, cliEnv)).toThrow(
      UnsupportedBackendError,
    );
    expect(
      resolveProviderSpec(
        { mode: "on-device", backend: "local-server", endpoint: "http://localhost:11434" },
        cliEnv,
      ).kind,
    ).toBe("cloud");
  });
});

// === Type-level invariants (compile-time) ===

describe("type invariants", () => {
  it("UnifiedProviderConfig accepts every combination", () => {
    // This is a compile-time check; the runtime body is just a sanity assertion.
    const configs: UnifiedProviderConfig[] = [
      { mode: "motebit-cloud" },
      { mode: "motebit-cloud", model: "x", proxyToken: "y" },
      { mode: "byok", vendor: "anthropic", apiKey: "k" },
      { mode: "byok", vendor: "openai", apiKey: "k" },
      { mode: "byok", vendor: "google", apiKey: "k" },
      { mode: "on-device", backend: "webllm" },
      { mode: "on-device", backend: "apple-fm" },
      { mode: "on-device", backend: "mlx" },
      { mode: "on-device", backend: "local-server" },
    ];
    expect(configs.length).toBe(9);
  });
});
