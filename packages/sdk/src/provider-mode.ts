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

// === Defaults ===

/** Sensible default when no config has ever been persisted. */
export function defaultProviderConfig(): MotebitCloudProviderConfig {
  return { mode: "motebit-cloud" };
}
