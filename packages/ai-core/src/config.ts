/**
 * CLI/personality provider union. Flat shape matching historical `config.json`
 * files on disk. Maps onto `UnifiedProviderConfig` in `@motebit/sdk`:
 *   motebit-cloud → "proxy"
 *   byok          → "anthropic" | "openai" | "google"
 *   on-device     → "local-server"
 *
 * The historical value `"ollama"` was renamed to `"local-server"` to honor
 * vendor neutrality. CLI accepts `--provider ollama` as an ergonomic alias,
 * and `extractPersonality` (in `apps/cli/src/config.ts`) migrates persisted
 * `"ollama"` values transparently. New code must not write `"ollama"`.
 */
export type PersonalityProvider = "anthropic" | "openai" | "google" | "local-server" | "proxy";

/**
 * Wider on-disk representation that accepts the legacy `"ollama"` value
 * alongside the modern `PersonalityProvider` shape. Read from `config.json`
 * directly; narrow to `PersonalityProvider` via the migration in
 * `extractPersonality`. Do not write this shape — only read.
 */
export type PersistedPersonalityProvider = PersonalityProvider | "ollama";

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
