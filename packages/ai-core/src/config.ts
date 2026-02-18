export interface MotebitPersonalityConfig {
  name?: string;
  personality_notes?: string;
  default_provider?: "anthropic" | "ollama";
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

export function resolveConfig(partial: MotebitPersonalityConfig): Required<MotebitPersonalityConfig> {
  return { ...DEFAULT_CONFIG, ...partial };
}
