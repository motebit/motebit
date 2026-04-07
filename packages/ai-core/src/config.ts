/**
 * CLI/personality provider union. Flat shape matching historical `config.json`
 * files on disk. Maps onto `UnifiedProviderConfig` in `@motebit/sdk`:
 *   motebit-cloud → "proxy"
 *   byok          → "anthropic" | "openai" | "google"
 *   on-device     → "ollama" (local-server)
 */
export type PersonalityProvider = "anthropic" | "openai" | "google" | "ollama" | "proxy";

export interface MotebitPersonalityConfig {
  name?: string;
  personality_notes?: string;
  default_provider?: PersonalityProvider;
  default_model?: string;
  temperature?: number;
}

export const DEFAULT_CONFIG: Required<MotebitPersonalityConfig> = {
  name: "Motebit",
  personality_notes: "",
  default_provider: "anthropic",
  default_model: "",
  temperature: 0.7,
};

export function resolveConfig(
  partial: MotebitPersonalityConfig,
): Required<MotebitPersonalityConfig> {
  return { ...DEFAULT_CONFIG, ...partial };
}
