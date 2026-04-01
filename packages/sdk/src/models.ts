// === AI Model Constants ===
//
// Single source of truth for model identifiers across all surfaces.
// SDK is Layer 0 (MIT, no deps beyond protocol) — only string constants here.
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

/** Common Ollama models (user can pull any model; these are suggestions). */
export const OLLAMA_SUGGESTED_MODELS = [
  "llama3.2",
  "llama3.1",
  "llama3",
  "mistral",
  "codellama",
  "gemma2",
  "phi3",
  "qwen2",
] as const;

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

/** Default Ollama model. */
export const DEFAULT_OLLAMA_MODEL = "llama3.2";

/** Default proxy model (used when no model is specified). */
export const DEFAULT_PROXY_MODEL = "claude-sonnet-4-6";

// === Type Helpers ===

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];
export type OpenAIModel = (typeof OPENAI_MODELS)[number];
export type GoogleModel = (typeof GOOGLE_MODELS)[number];
export type OllamaSuggestedModel = (typeof OLLAMA_SUGGESTED_MODELS)[number];
export type ProxyModel = (typeof PROXY_MODELS)[number];
