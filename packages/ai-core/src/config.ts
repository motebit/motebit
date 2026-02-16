import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

export function loadConfig(configPath?: string): Required<MotebitPersonalityConfig> {
  const filePath = configPath ?? path.join(os.homedir(), ".motebit", "config.json");

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const parsed = JSON.parse(raw) as MotebitPersonalityConfig;
    return resolveConfig(parsed);
  } catch {
    console.warn(`Warning: malformed config at ${filePath}, using defaults`);
    return { ...DEFAULT_CONFIG };
  }
}
