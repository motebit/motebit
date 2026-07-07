// === AI Model Constants ===
//
// Single source of truth for model identifiers across all surfaces.
// SDK is Layer 0 (Apache-2.0 permissive floor, no deps beyond protocol) — only string constants here.
// Pricing, routing, and alias resolution live in their respective packages.
//
// 3 tiers per provider: strongest, default, fast.
// When a new model ships, update the arrays — every surface picks it up.

/** Anthropic Claude models: opus (strongest), sonnet (default), haiku (fast). */
export const ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

/** OpenAI models: gpt-5.4 (strongest), gpt-5.4-mini (default), gpt-5.4-nano (fast). */
export const OPENAI_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"] as const;

/** Google models: 2.5 pro (strongest), 2.5 flash (default), 2.5 flash-lite (fast). */
export const GOOGLE_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

/**
 * DeepSeek models served via DeepSeek's OpenAI-compatible hosted API
 * (`https://api.deepseek.com`). The API-facing identifier `deepseek-chat`
 * routes to DeepSeek V3 — the workhorse, tool-use-capable model at
 * roughly Claude-Sonnet-class capability and ~10× cheaper pricing
 * ($0.27/M input · $1.10/M output). DeepSeek-R1 (`deepseek-reasoner`)
 * is reasoning-class but tool-use support is uncertain at the Jan 2026
 * cutoff; deferred to a sibling slice once verified.
 *
 * Single-entry registry today; expandable. The list shape stays
 * symmetric with the other per-vendor `*_MODELS` constants so the
 * settings UIs across surfaces consume them identically.
 */
export const DEEPSEEK_MODELS = ["deepseek-chat"] as const;

/**
 * Groq-hosted models served via Groq's OpenAI-compatible API
 * (`https://api.groq.com/openai/v1`). Groq's pitch is speed + price —
 * the LPU inference hardware delivers ~280 tokens/second on Llama 3.3
 * 70B (roughly 5× faster than typical GPU-served Llama) at $0.59/M
 * input · $0.79/M output (~5× cheaper than Claude Sonnet, ~5× more
 * expensive than DeepSeek). Independent American option in the BYOK
 * registry — post-NVIDIA-licensing-deal (December 2025) Groq remains
 * an independent company under CEO Simon Edwards; the API service
 * continues. Default `llama-3.3-70b-versatile` is the tool-use-
 * capable workhorse; `openai/gpt-oss-120b` is OpenAI's open-weights
 * release (only hosted competitively via Groq, MoE architecture
 * comparable to GPT-4 class on tool benchmarks).
 *
 * The list shape stays symmetric with the other per-vendor
 * `*_MODELS` constants so the settings UIs across surfaces consume
 * them identically.
 */
export const GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] as const;

/**
 * Common open-weights models that any local inference server can run.
 *
 * These identifiers are the model FAMILIES supported by every major local
 * inference server (Ollama, LM Studio, llama.cpp, Jan, vLLM). The names are
 * not Ollama-specific — Llama is Meta's, Mistral is Mistral AI's, Gemma is
 * Google's, Phi is Microsoft's, Qwen is Alibaba's, Codellama is Meta's. Each
 * server pulls them from its own catalog (Ollama from its registry, LM Studio
 * from HuggingFace, llama.cpp from GGUF files, etc.).
 *
 * Use this as the dropdown source for "what model do you want to run" in
 * any on-device / local-server UI. The user can pull any model; these are
 * the safe defaults to surface first.
 */
export const LOCAL_SERVER_SUGGESTED_MODELS = [
  "llama3.2",
  "llama3.1",
  "llama3",
  "mistral",
  "codellama",
  "gemma2",
  "phi3",
  "qwen2",
] as const;

/**
 * @deprecated since 1.0.0, removed in 3.0.0. Use {@link LOCAL_SERVER_SUGGESTED_MODELS} instead.
 *
 * Reason: the old name implied the list was Ollama-specific, but every
 * entry runs on every supported local inference server (Ollama, LM Studio,
 * llama.cpp, vLLM). Vendor-neutral naming matches the runtime's
 * `"local-server"` provider discriminator.
 */
export const OLLAMA_SUGGESTED_MODELS = LOCAL_SERVER_SUGGESTED_MODELS;

/** Models available through the Motebit proxy (all cloud providers). */
export const PROXY_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

// === Default Models ===

/** Default Anthropic model. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

/** Default OpenAI model. */
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

/** Default Google model. */
export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";

/**
 * Default DeepSeek model — V3 via the `deepseek-chat` API identifier.
 * The tool-use-capable workhorse; matches the per-vendor "default tier"
 * convention used by `DEFAULT_ANTHROPIC_MODEL` / `DEFAULT_OPENAI_MODEL` /
 * `DEFAULT_GOOGLE_MODEL`.
 */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

/**
 * Default Groq model — Llama 3.3 70B served at ~280 tok/sec via the
 * Groq LPU inference stack. Tool-use-capable; matches the per-vendor
 * "default tier" convention used by the other `DEFAULT_*_MODEL`
 * constants.
 */
export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

/** Default Ollama model — used as the `local-server` default too. */
export const DEFAULT_OLLAMA_MODEL = "llama3.2";

/**
 * Canonical default model for the on-device `local-server` backend.
 * Currently aliased to `DEFAULT_OLLAMA_MODEL` — Ollama's `llama3.2` is
 * the sensible first-run default even for users who end up running
 * LM Studio / llama.cpp / vLLM. Prefer this name in new code; the
 * Ollama-specific alias is retained for places that genuinely mean
 * the Ollama model identifier.
 */
export const DEFAULT_LOCAL_SERVER_MODEL = DEFAULT_OLLAMA_MODEL;

/** Default proxy model (used when no model is specified). */
export const DEFAULT_PROXY_MODEL = "claude-sonnet-4-6";

// === Type Helpers ===

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];
export type OpenAIModel = (typeof OPENAI_MODELS)[number];
export type GoogleModel = (typeof GOOGLE_MODELS)[number];
export type LocalServerSuggestedModel = (typeof LOCAL_SERVER_SUGGESTED_MODELS)[number];
/**
 * @deprecated since 1.0.0, removed in 3.0.0. Use {@link LocalServerSuggestedModel} instead.
 *
 * Reason: paired with {@link OLLAMA_SUGGESTED_MODELS}. Vendor-neutral
 * naming for the same underlying model set.
 */
export type OllamaSuggestedModel = LocalServerSuggestedModel;
export type ProxyModel = (typeof PROXY_MODELS)[number];

// === Provider ↔ model coherence ===
//
// Born live, 2026-07-06: `--provider anthropic` with a config-resident
// `default_model: llama3.2:latest` composed an Anthropic provider around
// an Ollama model id — the banner printed the illegal pairing and the
// failure deferred to the first API call. The intelligence-pluggability
// contract's first commitment is PRE-FLIGHT admission: the selected
// model must fit the selected provider BEFORE any turn runs. These two
// helpers are that check's canonical home (the registry already knows
// the vendors).

/** Best-effort vendor attribution for a model id. Registry membership
 *  first, then naming-signature heuristics for ids the registry hasn't
 *  caught up to (new dated releases must not brick startup — an
 *  `"unknown"` verdict is deliberately permissive). */
export function modelVendorHint(
  model: string,
): "anthropic" | "openai" | "google" | "deepseek" | "groq" | "local" | "unknown" {
  const m = model.trim().toLowerCase();
  if ((ANTHROPIC_MODELS as readonly string[]).includes(m)) return "anthropic";
  if ((OPENAI_MODELS as readonly string[]).includes(m)) return "openai";
  if ((GOOGLE_MODELS as readonly string[]).includes(m)) return "google";
  if ((DEEPSEEK_MODELS as readonly string[]).includes(m)) return "deepseek";
  if ((GROQ_MODELS as readonly string[]).includes(m)) return "groq";
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt-") || /^o[0-9]/.test(m)) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("deepseek")) return "deepseek";
  // Ollama-style tags and the common local families.
  if (m.includes(":") || /^(llama|mistral|qwen|phi|gemma|smollm)/.test(m)) return "local";
  return "unknown";
}

/**
 * Pre-flight admission: may `model` be served by `provider`?
 * Permissive where honesty demands it — `local-server` runs whatever the
 * user's server hosts, the proxy routes multiple vendors, and an
 * `"unknown"` vendor hint never blocks (the registry lags new releases).
 * It answers `false` only for a KNOWN cross-vendor mismatch — exactly
 * the class that fails opaquely at the API otherwise.
 */
export function providerAcceptsModel(provider: string, model: string): boolean {
  if (provider === "local-server" || provider === "ollama") return true;
  const hint = modelVendorHint(model);
  if (hint === "unknown") return true;
  if (provider === "proxy") return hint === "anthropic" || hint === "openai" || hint === "google";
  if (provider === "groq") return hint === "groq" || hint === "local"; // groq serves open models
  return hint === provider;
}
