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
  "claude-opus-4-6",
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
 * @deprecated Use `LOCAL_SERVER_SUGGESTED_MODELS`. The old name implied the
 * list was Ollama-specific; in fact every entry runs on every supported
 * local inference server. Historical alias retained for one release cycle.
 */
export const OLLAMA_SUGGESTED_MODELS = LOCAL_SERVER_SUGGESTED_MODELS;

/** Models available through the Motebit proxy (all cloud providers). */
export const PROXY_MODELS = [
  "claude-opus-4-6",
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
/** @deprecated Use `LocalServerSuggestedModel`. */
export type OllamaSuggestedModel = LocalServerSuggestedModel;
export type ProxyModel = (typeof PROXY_MODELS)[number];
