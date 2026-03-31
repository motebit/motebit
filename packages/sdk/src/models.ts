// === AI Model Constants ===
//
// Single source of truth for model identifiers across all surfaces.
// SDK is Layer 0 (MIT, no deps beyond protocol) — only string constants here.
// Pricing, routing, and alias resolution live in their respective packages.

/** Anthropic Claude models available for direct API or proxy routing. */
export const ANTHROPIC_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-20250115",
] as const;

/** OpenAI models available for direct API. */
export const OPENAI_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"] as const;

/** Google models available for direct API or proxy routing. */
export const GOOGLE_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"] as const;

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
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250115",
  "claude-haiku-4-5-20251001",
  "gpt-4o",
  "gpt-4o-mini",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
] as const;

// === Default Models ===

/** Default Anthropic model. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

/** Default OpenAI model. */
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

/** Default Google model. */
export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-pro";

/** Default Ollama model. */
export const DEFAULT_OLLAMA_MODEL = "llama3.2";

/** Default proxy model (used when no model is specified). */
export const DEFAULT_PROXY_MODEL = "claude-sonnet-4-20250514";

// === Type Helpers ===

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];
export type OpenAIModel = (typeof OPENAI_MODELS)[number];
export type GoogleModel = (typeof GOOGLE_MODELS)[number];
export type OllamaSuggestedModel = (typeof OLLAMA_SUGGESTED_MODELS)[number];
export type ProxyModel = (typeof PROXY_MODELS)[number];
