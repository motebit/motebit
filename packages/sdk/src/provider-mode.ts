// === Provider Mode (Three-Mode Architecture) ===
//
// User-intent-based provider config — matches the pattern of settlement rails:
// user picks the capability class, the system resolves the concrete vendor.
//
// Flat unions like "ollama" | "anthropic" | "openai" | "hybrid" mix implementation
// details with user intent. "Hybrid" is an implementation detail, not a user choice.
// "Ollama" is a vendor name, not a capability class.
//
// All surfaces (web, mobile, desktop, cli) persist and exchange this shape.
// Platform-specific sub-options live inside each mode's discriminated variant.

/**
 * Top-level provider mode — the user's intent, not the concrete vendor.
 *
 * - `on-device`: the user wants inference to run locally (privacy, offline, latency).
 * - `motebit-cloud`: the user wants the default product experience (subscription, auto-routing).
 * - `byok`: the user brings their own API key to a named vendor.
 */
export type ProviderMode = "on-device" | "motebit-cloud" | "byok";

/**
 * On-device backend kinds. Not every backend is available on every platform:
 *
 * - `apple-fm`: Apple Foundation Models (iOS/macOS 26+ only).
 * - `mlx`: MLX runtime (Apple Silicon, iOS 16+ / macOS).
 * - `webllm`: MLC WebLLM in-browser (web surface + WebGPU only).
 * - `local-server`: auto-detected local OpenAI-compatible server
 *   (Ollama, LM Studio, llama.cpp, Jan, vLLM, …). Vendor-agnostic.
 */
export type OnDeviceBackend = "apple-fm" | "mlx" | "webllm" | "local-server";

/** BYOK vendors — the only ones where the user holds the API key directly. */
export type ByokVendor = "anthropic" | "openai" | "google";

/** On-device mode config. */
export interface OnDeviceProviderConfig {
  mode: "on-device";
  backend: OnDeviceBackend;
  /** Model identifier. Meaning depends on backend (MLX name, WebLLM id, server tag, …). */
  model?: string;
  /** For `local-server`: endpoint URL (e.g., http://localhost:11434). Auto-detected otherwise. */
  endpoint?: string;
  /** Optional temperature override. */
  temperature?: number;
  /** Optional max_tokens override. */
  maxTokens?: number;
}

/** Motebit Cloud mode config — the subscription-backed product. */
export interface MotebitCloudProviderConfig {
  mode: "motebit-cloud";
  /** Optional preferred model. When omitted, the relay picks. */
  model?: string;
  /** Signed proxy token — included as x-proxy-token for authenticated requests. */
  proxyToken?: string;
  /** Override proxy base URL (dev/staging). */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/** BYOK mode config — user supplies the API key. */
export interface ByokProviderConfig {
  mode: "byok";
  vendor: ByokVendor;
  apiKey: string;
  model?: string;
  /**
   * Optional custom base URL. Used e.g. for Google via the OpenAI-compatible
   * endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`).
   */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Union of all three modes. Surfaces persist this shape. */
export type UnifiedProviderConfig =
  | OnDeviceProviderConfig
  | MotebitCloudProviderConfig
  | ByokProviderConfig;

// === Migration ===
//
// Legacy shapes, in order of historical appearance:
//
//   Web (apps/web/src/storage.ts):
//     { type: "anthropic" | "openai" | "ollama" | "webllm" | "proxy",
//       apiKey?, model, baseUrl?, proxyToken?, maxTokens?, temperature? }
//
//   Mobile (apps/mobile/src/mobile-app.ts):
//     { provider: "ollama" | "anthropic" | "openai" | "hybrid" | "proxy" | "local",
//       localBackend?: "apple-fm" | "mlx",
//       model?, apiKey?, ollamaEndpoint?, maxTokens? }
//
//   Desktop (apps/desktop/src/index.ts):
//     { provider: "anthropic" | "ollama" | "openai" | "proxy" | "hybrid",
//       model?, apiKey?, maxTokens? }
//
//   CLI (apps/cli/src/config.ts):
//     { default_provider?: "anthropic" | "openai" | "ollama",
//       default_model?, api_key? (in keyring) }

/**
 * Heuristic: is this URL pointing at a local inference server?
 * Shared across all surfaces so the migration behaves identically everywhere.
 */
export function isLocalServerUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Legacy provider config shape — a superset of every surface's historical fields.
 * Used only as the input to `migrateLegacyProvider`.
 */
export interface LegacyProviderConfig {
  // Web shape
  type?: string;
  // Mobile/desktop shape
  provider?: string;
  apiKey?: string;
  api_key?: string;
  model?: string;
  baseUrl?: string;
  base_url?: string;
  proxyToken?: string;
  proxy_token?: string;
  maxTokens?: number;
  max_tokens?: number;
  temperature?: number;
  // Mobile-specific
  localBackend?: string;
  ollamaEndpoint?: string;
  // CLI shape
  default_provider?: string;
  default_model?: string;
  // Already-new shape (identity passthrough)
  mode?: string;
  backend?: string;
  vendor?: string;
  endpoint?: string;
}

/**
 * Migrate any legacy provider config shape to `UnifiedProviderConfig`.
 *
 * Rules:
 * - `hybrid` and `proxy` map to `motebit-cloud` (the product).
 * - `ollama` with a localhost URL maps to `on-device/local-server`.
 * - `ollama` with a remote URL maps to `on-device/local-server` with that endpoint preserved.
 * - `anthropic` / `openai` / `google` map to `byok` with that vendor.
 * - Mobile `local` with `localBackend` maps to `on-device` with that backend.
 * - If input is already a `UnifiedProviderConfig` (has `mode`), it passes through.
 *
 * Returns `null` only if the input is entirely unrecognizable.
 */
export function migrateLegacyProvider(
  legacy: LegacyProviderConfig | null | undefined,
): UnifiedProviderConfig | null {
  if (!legacy) return null;

  // Already-new shape — passthrough with light validation.
  if (legacy.mode === "on-device" || legacy.mode === "motebit-cloud" || legacy.mode === "byok") {
    return legacy as unknown as UnifiedProviderConfig;
  }

  const apiKey = legacy.apiKey ?? legacy.api_key;
  const baseUrl = legacy.baseUrl ?? legacy.base_url;
  const proxyToken = legacy.proxyToken ?? legacy.proxy_token;
  const maxTokens = legacy.maxTokens ?? legacy.max_tokens;
  const temperature = legacy.temperature;
  const model = legacy.model ?? legacy.default_model;

  // Normalize the discriminator across shapes.
  const kind = legacy.type ?? legacy.provider ?? legacy.default_provider;

  if (!kind) return null;

  switch (kind) {
    case "proxy":
    case "hybrid":
    case "motebit-cloud":
      return {
        mode: "motebit-cloud",
        model,
        proxyToken,
        baseUrl,
        maxTokens,
        temperature,
      };

    case "anthropic":
      return {
        mode: "byok",
        vendor: "anthropic",
        apiKey: apiKey ?? "",
        model,
        baseUrl,
        maxTokens,
        temperature,
      };

    case "openai":
      return {
        mode: "byok",
        vendor: "openai",
        apiKey: apiKey ?? "",
        model,
        baseUrl,
        maxTokens,
        temperature,
      };

    case "google":
      return {
        mode: "byok",
        vendor: "google",
        apiKey: apiKey ?? "",
        model,
        baseUrl,
        maxTokens,
        temperature,
      };

    case "ollama": {
      // Ollama is always a local server — endpoint may or may not be localhost.
      const endpoint = baseUrl ?? legacy.ollamaEndpoint ?? legacy.endpoint;
      return {
        mode: "on-device",
        backend: "local-server",
        model,
        endpoint,
        maxTokens,
        temperature,
      };
    }

    case "webllm":
      return {
        mode: "on-device",
        backend: "webllm",
        model,
        maxTokens,
        temperature,
      };

    case "local": {
      // Mobile legacy: `local` with `localBackend` sub-option.
      const backend = ((): OnDeviceBackend => {
        switch (legacy.localBackend) {
          case "apple-fm":
            return "apple-fm";
          case "mlx":
            return "mlx";
          case "local-server":
            return "local-server";
          default:
            return "mlx";
        }
      })();
      return {
        mode: "on-device",
        backend,
        model,
        endpoint: legacy.ollamaEndpoint ?? legacy.endpoint,
        maxTokens,
        temperature,
      };
    }

    default:
      return null;
  }
}

// === Defaults ===

/** Sensible default when no config has ever been persisted. */
export function defaultProviderConfig(): MotebitCloudProviderConfig {
  return { mode: "motebit-cloud" };
}
