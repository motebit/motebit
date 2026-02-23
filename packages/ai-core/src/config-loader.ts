/**
 * Node-only config loader. Reads ~/.motebit/config.json from disk.
 * Separated from config.ts so browser bundles can import resolveConfig
 * and DEFAULT_CONFIG without pulling in node:fs/path/os.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveConfig, DEFAULT_CONFIG } from "./config.js";
import type { MotebitPersonalityConfig } from "./config.js";

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
    // eslint-disable-next-line no-console
    console.warn(`Warning: malformed config at ${filePath}, using defaults`);
    return { ...DEFAULT_CONFIG };
  }
}
