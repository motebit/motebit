// --- Configuration, types, persistence ---

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { McpServerConfig } from "@motebit/mcp-client";
import type { MotebitPersonalityConfig } from "@motebit/ai-core";
import type { connectMcpServers } from "@motebit/mcp-client";

export const VERSION = "0.1.0";
export const CONFIG_DIR = path.join(os.homedir(), ".motebit");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export interface FullConfig {
  // Personality (existing)
  name?: string;
  personality_notes?: string;
  default_provider?: "anthropic" | "ollama";
  default_model?: string;
  temperature?: number;
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
}

export function loadFullConfig(): FullConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as FullConfig;
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
  return {
    name: full.name,
    personality_notes: full.personality_notes,
    default_provider: full.default_provider,
    default_model: full.default_model,
    temperature: full.temperature,
  };
}
