// --- Configuration, types, persistence ---

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { McpServerConfig } from "@motebit/mcp-client";
import type {
  MotebitPersonalityConfig,
  PersonalityProvider,
  PersistedPersonalityProvider,
} from "@motebit/ai-core";
import type { connectMcpServers } from "@motebit/mcp-client";
import { migrateLegacyProvider, type UnifiedProviderConfig } from "@motebit/sdk";

declare const __PKG_VERSION__: string;
export const VERSION: string =
  typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";
export const CONFIG_DIR = path.join(os.homedir(), ".motebit");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export interface FullConfig {
  // Personality (existing)
  name?: string;
  personality_notes?: string;
  /**
   * Legacy flat provider field. Still read and written for backwards compat;
   * if `provider` (the unified shape) is present, that wins. Uses the wider
   * `PersistedPersonalityProvider` to accept the legacy `"ollama"` value
   * from old config.json files; `extractPersonality` migrates it to the
   * modern `"local-server"` name on read.
   */
  default_provider?: PersistedPersonalityProvider;
  default_model?: string;
  /**
   * Canonical three-mode provider config. Populated on load from legacy fields
   * if missing. Persisted alongside `default_provider` so older CLI versions
   * still understand the file.
   */
  provider?: UnifiedProviderConfig;
  temperature?: number;
  max_tokens?: number;
  // Identity (written on first launch)
  motebit_id?: string;
  device_id?: string;
  device_public_key?: string;
  /** @deprecated Plaintext key — migrated to cli_encrypted_key on next launch. */
  cli_private_key?: string;
  cli_encrypted_key?: {
    ciphertext: string; // hex
    nonce: string; // hex
    tag: string; // hex
    salt: string; // hex
  };
  // MCP servers (user-configured)
  mcp_servers?: McpServerConfig[];
  // Trusted MCP server names (tools don't require approval)
  mcp_trusted_servers?: string[];
  // Sync relay URL saved by `motebit register`
  sync_url?: string;
}

export function loadFullConfig(): FullConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as FullConfig;
    // Migration: if the unified `provider` shape is missing but the legacy
    // `default_provider` is present, derive the unified shape from it.
    // Keeps older config files readable without a manual edit.
    if (!parsed.provider && parsed.default_provider) {
      const migrated = migrateLegacyProvider({
        default_provider: parsed.default_provider,
        default_model: parsed.default_model,
      });
      if (migrated) parsed.provider = migrated;
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveFullConfig(config: FullConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/** Persist newly pinned motebit public keys from connected adapters back to config. */
export function persistMotebitPublicKeys(
  adapters: Awaited<ReturnType<typeof connectMcpServers>>,
  fullConfig: FullConfig,
): void {
  let dirty = false;
  const servers = fullConfig.mcp_servers ?? [];
  for (const adapter of adapters) {
    if (!adapter.isMotebit || !adapter.verifiedIdentity?.verified) continue;
    const pinnedKey = adapter.serverConfig.motebitPublicKey;
    if (!pinnedKey) continue;
    // Find matching server config entry
    const serverCfg = servers.find((s) => s.name === adapter.serverName);
    if (serverCfg && !serverCfg.motebitPublicKey) {
      serverCfg.motebitPublicKey = pinnedKey;
      dirty = true;
    }
  }
  if (dirty) {
    saveFullConfig(fullConfig);
  }
}

export function extractPersonality(full: FullConfig): MotebitPersonalityConfig {
  // Migrate the historical "ollama" value to the vendor-agnostic "local-server"
  // name. Old config.json files persist `default_provider: "ollama"`; we read
  // them transparently and present the new name to the rest of the system.
  const provider: PersonalityProvider | undefined =
    full.default_provider === "ollama" ? "local-server" : full.default_provider;
  return {
    name: full.name,
    personality_notes: full.personality_notes,
    default_provider: provider,
    default_model: full.default_model,
    temperature: full.temperature,
  };
}
