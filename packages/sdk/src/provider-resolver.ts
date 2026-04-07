// === Provider Resolver — pure dispatch logic, shared across all surfaces ===
//
// The four surfaces (web, mobile, desktop, cli) used to each maintain their
// own copy of "given a UnifiedProviderConfig, build a concrete @motebit/ai-core
// provider instance." Four implementations of the same decision tree, with
// only one (web) actually containing the Ollama-vs-OpenAI-compat dispatch
// heuristic. Adding a vendor meant editing four files. Fixing a bug meant
// fixing it four times — and historically, only the surface where the bug
// was reported actually got the fix.
//
// This module extracts the decision tree as a pure function. It takes a
// `UnifiedProviderConfig` and a surface-supplied `ResolverEnv` (which captures
// the only legitimately-divergent concerns: platform URL routing, available
// on-device backends, motebit-cloud session state). It returns a `ProviderSpec`
// — a normalized data shape describing what kind of provider to instantiate
// with what config. The surface still constructs the concrete class itself
// (because @motebit/sdk is Layer 0 and can't import @motebit/ai-core's
// provider classes), but the construction shrinks to a 15-line transport
// switch with no decision logic.
//
// Adding a new vendor: extend ByokVendor, add a case to resolveProviderSpec.
// Fixing a dispatch bug: fix it once here. Tested in one place.
//
// What stays per-surface (and rightly so):
//   - Constructing the actual @motebit/ai-core provider classes
//   - Async init flows (WebLLM model download, native module loading)
//   - API key storage (keyring vs SecureStore vs env vars)
//   - URL substitution that depends on platform (Vite proxy paths, Tauri vs dev)
//
// What moves here (the duplication):
//   - The mode → vendor → transport decision tree
//   - The Ollama-vs-OpenAI-compat endpoint heuristic
//   - The Google "uses OpenAI-compat" fact
//   - Default model fallback per vendor
//   - The supported-backends gate

import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_PROXY_MODEL,
} from "./models.js";
import type { UnifiedProviderConfig, ByokVendor, OnDeviceBackend } from "./provider-mode.js";

// === Constants ===

/**
 * Google's OpenAI-compatible chat completions endpoint. Used when the user
 * picks Google as a BYOK vendor — Google is dispatched as OpenAI-compat
 * because every cloud client (web, mobile, desktop, cli) already understands
 * the OpenAI wire protocol. Single source of truth.
 */
export const GOOGLE_OPENAI_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Canonical Anthropic API base URL. */
export const ANTHROPIC_CANONICAL_URL = "https://api.anthropic.com";

/** Canonical OpenAI API base URL. */
export const OPENAI_CANONICAL_URL = "https://api.openai.com/v1";

/** Default Motebit Cloud relay URL. Surfaces may override via env. */
export const DEFAULT_MOTEBIT_CLOUD_URL = "https://api.motebit.com";

/** Default WebLLM model when none specified — small enough to fit on most devices. */
export const DEFAULT_WEBLLM_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

// === Helpers ===

/**
 * Heuristic: does this endpoint URL look like an Ollama-native server?
 *
 * Ollama listens on port 11434 by default and exposes its own HTTP API
 * (`/api/chat`, `/api/tags`) which is NOT OpenAI-compatible. Other local
 * inference servers (LM Studio, llama.cpp, Jan, vLLM, text-generation-webui)
 * use OpenAI-compatible endpoints (`/v1/chat/completions`).
 *
 * The detection is intentionally simple — port-based — because:
 *   1. Ollama's default port is 11434 with overwhelming convention
 *   2. Users running Ollama on a non-default port can also run it through
 *      its own OpenAI-compat shim, which works either way
 *   3. The alternative (probing /api/tags) requires async I/O, defeating
 *      the purpose of a pure resolver
 *
 * The cost of misclassification is small: a wrong call to `/api/chat` on
 * an OpenAI-compat server returns 404 with a clear error.
 */
export function isOllamaNativeEndpoint(url: string): boolean {
  return /:11434(\b|\/|$)/.test(url);
}

/** Default chat model for a BYOK vendor. */
export function defaultModelForVendor(vendor: ByokVendor): string {
  switch (vendor) {
    case "anthropic":
      return DEFAULT_ANTHROPIC_MODEL;
    case "openai":
      return DEFAULT_OPENAI_MODEL;
    case "google":
      return DEFAULT_GOOGLE_MODEL;
  }
}

/**
 * Canonical (vendor-published) base URL for a BYOK vendor. Surfaces that
 * need to substitute a CORS proxy or dev-mode path receive this canonical
 * URL via the resolver and may rewrite it.
 */
export function canonicalVendorBaseUrl(vendor: ByokVendor): string {
  switch (vendor) {
    case "anthropic":
      return ANTHROPIC_CANONICAL_URL;
    case "openai":
      return OPENAI_CANONICAL_URL;
    case "google":
      return GOOGLE_OPENAI_COMPAT_URL;
  }
}

// === ProviderSpec — normalized output ===

/**
 * Discriminated union describing what concrete provider class the surface
 * should instantiate, with all decision logic already resolved. The surface's
 * job is reduced to a transport switch + class construction.
 */
export type ProviderSpec =
  | CloudProviderSpec
  | OllamaProviderSpec
  | WebLLMProviderSpec
  | AppleFoundationModelsSpec
  | MlxProviderSpec;

/**
 * Cloud HTTP provider — used for Anthropic, OpenAI, Google (via OpenAI-compat),
 * Motebit Cloud (anthropic protocol via relay), and OpenAI-compat local
 * servers (LM Studio, llama.cpp, etc.).
 *
 * The `wireProtocol` discriminates between Anthropic's messages API and
 * OpenAI's chat completions API. The surface uses this to pick the right
 * `provider` field on its `CloudProviderConfig` constructor argument.
 */
export interface CloudProviderSpec {
  kind: "cloud";
  /** Wire protocol family this client speaks. */
  wireProtocol: "anthropic" | "openai";
  /** API key to use. Empty string for motebit-cloud (server injects). */
  apiKey: string;
  model: string;
  /** Already-resolved base URL — env.cloudBaseUrl has been applied. */
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  /** Extra HTTP headers (e.g., x-proxy-token for motebit-cloud). */
  extraHeaders?: Record<string, string>;
}

/** Ollama-native HTTP provider — uses /api/chat, not OpenAI-compat. */
export interface OllamaProviderSpec {
  kind: "ollama";
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/** Browser-only WebLLM provider — runs in-browser via WebGPU. */
export interface WebLLMProviderSpec {
  kind: "webllm";
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/** Apple Foundation Models — iOS 26+ / macOS 26+ only. */
export interface AppleFoundationModelsSpec {
  kind: "apple-fm";
  model?: string;
  maxTokens?: number;
}

/** MLX runtime — Apple Silicon only. */
export interface MlxProviderSpec {
  kind: "mlx";
  model?: string;
  maxTokens?: number;
}

// === ResolverEnv — surface-injected I/O concerns ===

/**
 * Per-surface environment that captures the only things the resolver can't
 * decide on its own: platform-specific URL routing, which on-device backends
 * are physically supported, and motebit-cloud session state.
 *
 * Each surface constructs one of these once (or per call if the session
 * state changes) and passes it to `resolveProviderSpec`. The interface is
 * intentionally narrow — anything that can be computed from a
 * `UnifiedProviderConfig` alone stays inside the resolver.
 */
export interface ResolverEnv {
  /**
   * Resolve the actual base URL for a cloud provider given its canonical
   * vendor URL. Most surfaces return `canonical` unchanged. Browser surfaces
   * substitute a CORS proxy for vendors that block direct browser calls.
   * Tauri dev mode substitutes a Vite proxy path.
   *
   * The function form (rather than a static map) lets surfaces compute the
   * substitution lazily based on runtime state (e.g., `isTauri`).
   */
  cloudBaseUrl(wireProtocol: "anthropic" | "openai", canonical: string): string;

  /**
   * Default LOGICAL URL for the on-device local-server backend when the
   * user hasn't supplied an endpoint. The dispatch heuristic
   * (`isOllamaNativeEndpoint`) runs on this logical URL — surfaces should
   * provide the canonical Ollama form (`http://127.0.0.1:11434`) here even
   * when their actual transport URL differs (e.g., Vite proxy path).
   *
   * Use `localServerBaseUrl` to translate the logical URL into the actual
   * URL the constructed provider should call.
   */
  defaultLocalServerUrl: string;

  /**
   * Optional translator from a logical local-server URL into the actual URL
   * the provider should call. Most surfaces return the input unchanged.
   * Desktop dev mode substitutes the Vite proxy path `/api/ollama` for any
   * Ollama-shaped logical URL — but the dispatch decision (Ollama-native vs
   * OpenAI-compat) is made BEFORE this substitution, on the logical URL.
   *
   * This separation lets surfaces use proxy/rewrite paths without losing
   * the resolver's ability to dispatch on the user's intent.
   */
  localServerBaseUrl?(logical: string): string;

  /**
   * Which on-device backends this surface can physically run.
   *   - web: webllm, local-server
   *   - mobile: apple-fm, mlx, local-server
   *   - desktop: local-server (today; could grow)
   *   - cli: local-server
   */
  supportedBackends: ReadonlySet<OnDeviceBackend>;

  /**
   * Base URL for motebit-cloud requests. Each surface resolves this from
   * its own session state / env (proxy session, VITE_PROXY_URL, etc.).
   * Falls back to `DEFAULT_MOTEBIT_CLOUD_URL` if absent.
   */
  motebitCloudBaseUrl?: string;

  /**
   * Extra HTTP headers to attach to motebit-cloud requests. Typically
   * `{ "x-proxy-token": "..." }` from the surface's proxy session state.
   */
  motebitCloudHeaders?: Record<string, string>;

  /**
   * Default model for motebit-cloud when the config doesn't specify.
   * Most surfaces leave this undefined (resolver falls back to
   * `DEFAULT_PROXY_MODEL`); the relay session may override based on tier.
   */
  motebitCloudDefaultModel?: string;
}

// === Errors ===

/**
 * Thrown when the user picks an on-device backend that the current surface
 * doesn't physically support (e.g., apple-fm on web). Surfaces should
 * present a graceful error rather than letting it propagate.
 */
export class UnsupportedBackendError extends Error {
  constructor(public backend: OnDeviceBackend) {
    super(`On-device backend "${backend}" is not supported on this surface`);
    this.name = "UnsupportedBackendError";
  }
}

// === The resolver ===

/**
 * Resolve a `UnifiedProviderConfig` (the user's choice) against a surface's
 * `ResolverEnv` (its physical capabilities) to produce a normalized
 * `ProviderSpec` (what the surface should instantiate).
 *
 * Pure function. No I/O. No side effects. Tested once, used everywhere.
 *
 * @throws {UnsupportedBackendError} if the chosen on-device backend isn't
 *   in `env.supportedBackends`. Surfaces should catch and present a
 *   user-facing message.
 */
export function resolveProviderSpec(config: UnifiedProviderConfig, env: ResolverEnv): ProviderSpec {
  switch (config.mode) {
    case "motebit-cloud": {
      // Motebit Cloud speaks the Anthropic wire protocol via the relay.
      // The relay injects the real key server-side, so the spec carries
      // an empty apiKey — every cloud client knows to handle that case.
      const baseUrl = config.baseUrl ?? env.motebitCloudBaseUrl ?? DEFAULT_MOTEBIT_CLOUD_URL;
      const extraHeaders =
        config.proxyToken !== undefined
          ? { "x-proxy-token": config.proxyToken, ...(env.motebitCloudHeaders ?? {}) }
          : env.motebitCloudHeaders;
      return {
        kind: "cloud",
        wireProtocol: "anthropic",
        apiKey: "",
        model: config.model ?? env.motebitCloudDefaultModel ?? DEFAULT_PROXY_MODEL,
        baseUrl,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        extraHeaders,
      };
    }

    case "byok": {
      // Google is dispatched as OpenAI-compat — its public API is OpenAI-
      // compatible at the canonical Google URL. Anthropic and OpenAI use
      // their own canonical wire protocols.
      const wireProtocol: "anthropic" | "openai" =
        config.vendor === "anthropic" ? "anthropic" : "openai";
      const canonical = config.baseUrl ?? canonicalVendorBaseUrl(config.vendor);
      return {
        kind: "cloud",
        wireProtocol,
        apiKey: config.apiKey,
        model: config.model ?? defaultModelForVendor(config.vendor),
        baseUrl: env.cloudBaseUrl(wireProtocol, canonical),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      };
    }

    case "on-device": {
      if (!env.supportedBackends.has(config.backend)) {
        throw new UnsupportedBackendError(config.backend);
      }
      switch (config.backend) {
        case "webllm":
          return {
            kind: "webllm",
            model: config.model ?? DEFAULT_WEBLLM_MODEL,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
          };
        case "apple-fm":
          return {
            kind: "apple-fm",
            model: config.model,
            maxTokens: config.maxTokens,
          };
        case "mlx":
          return {
            kind: "mlx",
            model: config.model,
            maxTokens: config.maxTokens,
          };
        case "local-server": {
          // The dispatch heuristic: port 11434 → Ollama native API,
          // anything else → OpenAI-compat (LM Studio, llama.cpp, Jan,
          // vLLM, text-generation-webui, …).
          //
          // The DECISION is made on the logical endpoint (the canonical URL
          // form). The spec carries the ACTUAL endpoint (after surface URL
          // rewriting), which may be a proxy path that doesn't itself match
          // the heuristic. This separation lets desktop dev mode use
          // `/api/ollama` as the transport URL while still being recognized
          // as Ollama for dispatch purposes.
          //
          // This is the line of logic that used to live only in web's
          // providers.ts and was missing from mobile, desktop, and CLI.
          // After this extraction, every surface gets it for free.
          const logicalEndpoint = config.endpoint ?? env.defaultLocalServerUrl;
          const actualEndpoint = env.localServerBaseUrl?.(logicalEndpoint) ?? logicalEndpoint;
          if (isOllamaNativeEndpoint(logicalEndpoint)) {
            return {
              kind: "ollama",
              baseUrl: actualEndpoint,
              model: config.model ?? DEFAULT_OLLAMA_MODEL,
              maxTokens: config.maxTokens,
              temperature: config.temperature,
            };
          }
          return {
            kind: "cloud",
            wireProtocol: "openai",
            // Local OpenAI-compat servers don't validate the API key, but
            // most clients require a non-empty string. Use a sentinel.
            apiKey: "local",
            model: config.model ?? "local",
            baseUrl: actualEndpoint,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
          };
        }
      }
    }
  }
}
