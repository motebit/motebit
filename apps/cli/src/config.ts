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
import { type UnifiedProviderConfig, type GovernanceConfig } from "@motebit/sdk";

declare const __PKG_VERSION__: string;
export const VERSION: string =
  typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";
/**
 * Config directory — `~/.motebit` by default, overridable via
 * `MOTEBIT_CONFIG_DIR`. The override is what makes scaffolded agents
 * self-contained: `create-motebit --agent` writes the encrypted identity
 * to `<agent>/.motebit/`, and the scaffolded entrypoint sets
 * `MOTEBIT_CONFIG_DIR=<agent>/.motebit` before spawning `motebit serve`.
 * Without honouring the env var here, the spawned runtime would silently
 * fall back to `~/.motebit/` — the operator's identity, not the agent's —
 * and decrypt with the wrong passphrase. See create-motebit's
 * writeAgentConfig + agent-entrypoint template for the matching ends.
 *
 * Operator usage (`motebit relay up`, `motebit run`, etc.) doesn't set
 * the env var, so the default still resolves to `~/.motebit/`.
 */
export const CONFIG_DIR = process.env["MOTEBIT_CONFIG_DIR"] ?? path.join(os.homedir(), ".motebit");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
/** Local-relay state lives in a subdir so `motebit relay up` cannot collide with the CLI-agent's own `motebit.db`. */
export const RELAY_DIR = path.join(CONFIG_DIR, "relay");
export const RELAY_DB_PATH = path.join(RELAY_DIR, "relay.db");

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
   * The relay operator's Ed25519 public key (hex), PINNED at `motebit
   * register` after self-consistency verification of the relay's signed
   * transparency declaration (trust-on-first-use — the same TOFU root
   * `@motebit/state-export-client` uses). Consumed by the P2P delegation
   * path (treasury derived FROM this pin, never from a fetched response)
   * and by receipt/anchor verification. A later mismatch at register
   * time fails loud: a relay that changes identity must be re-pinned
   * deliberately, never silently.
   */
  relay_public_key?: string;
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
  /**
   * @deprecated since 1.0.0, removed in 2.0.0. Use `cli_encrypted_key` instead.
   *
   * Reason: pre-encryption legacy shape. Storing a private key as hex
   * plaintext on disk was a security downgrade; the encrypted replacement
   * derives a key from a user passphrase via scrypt and AES-GCM-encrypts
   * the private bytes.
   *
   * This field is a state-shape migrator slot, not an API surface —
   * readers exist only to consume legacy configs once per machine, then
   * rewrite as `cli_encrypted_key` and delete this field (see
   * `apps/cli/src/index.ts` bootstrap and `subcommands/attest.ts`). Per
   * `docs/doctrine/migration-cleanup.md`: rewrite-on-read shrinks the
   * holder count each launch. At 2.0.0 the migrator is removed; configs
   * that still carry this field will hard-error with a reset instruction.
   */
  cli_private_key?: string;
  /**
   * When the user confirmed transcribing their recovery seed to durable
   * storage (`motebit seed reveal` → explicit ack). Self-reported by design
   * — paper is unverifiable; the field exists so the one-line startup nudge
   * and the doctor check are dismissible by the honest act they ask for
   * (#428). Also set by `motebit restore` (holding the seed IS the backup).
   */
  seed_backed_up_at?: number;
  /**
   * Capability-tiered tool admission override (#501). Default (absent):
   * a minimal-tier model (e.g. a 3B local model) is never OFFERED
   * money-moving tools — the runtime omits them from the model-visible
   * list. Set `true` to restore full exposure: sovereignty preserved,
   * only the footgun default removed. A deliberate config field, not a
   * flag — a per-launch flag invites cargo-culting into scripts.
   */
  offer_money_tools_to_minimal_models?: boolean;
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
  /**
   * Optional governance config. If present, drives PolicyGate budget,
   * approval thresholds (via APPROVAL_PRESET_CONFIGS), and MemoryGovernor
   * settings at runtime construction. Absent means runtime defaults apply.
   *
   * Stored verbatim as camelCase (matching the canonical `GovernanceConfig`
   * shape from `@motebit/sdk`). Other nested objects in FullConfig
   * (e.g. `provider`) already use camelCase internally.
   */
  governance?: GovernanceConfig;
}

/**
 * Runtime validator for a persisted GovernanceConfig blob. Used on load so
 * malformed JSON does not crash the CLI — invalid shapes are dropped and
 * runtime defaults apply instead.
 */
function isValidGovernanceConfig(value: unknown): value is GovernanceConfig {
  if (value == null || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  const presetOk =
    g.approvalPreset === "cautious" ||
    g.approvalPreset === "balanced" ||
    g.approvalPreset === "autonomous";
  return (
    presetOk &&
    typeof g.persistenceThreshold === "number" &&
    typeof g.rejectSecrets === "boolean" &&
    typeof g.maxCallsPerTurn === "number" &&
    typeof g.maxMemoriesPerTurn === "number"
  );
}

/** The scratch name a replacement is staged under, in the same directory so the rename is atomic. */
function stagingPath(): string {
  return `${CONFIG_PATH}.${process.pid}.tmp`;
}

/**
 * An existing config that cannot be read. Distinct from "no config", and
 * the distinction is load-bearing: this file holds `cli_encrypted_key` —
 * for a CLI identity, the only copy of the private key — and, for anyone
 * who has not migrated, the deprecated `cli_private_key` in plaintext.
 * Reporting damage as absence tells the user they have no identity, and
 * the next save then overwrites whatever was recoverable with a fresh,
 * nearly-empty file.
 */
export class ConfigDamagedError extends Error {
  constructor(
    readonly path: string,
    cause?: unknown,
  ) {
    super(
      `${path} exists but could not be read — it may be damaged. It has NOT been changed. ` +
        `If you have your recovery seed you can restore from it; otherwise copy that file aside before running anything that writes config.`,
      { cause },
    );
    this.name = "ConfigDamagedError";
  }
}

export function loadFullConfig(): FullConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    // Absent is a first run, and that is the ONLY reason to answer "empty".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigDamagedError(CONFIG_PATH, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigDamagedError(CONFIG_PATH, err);
  }
  // Valid JSON is not a valid config. `null`, `[]`, `3` and `"x"` all
  // parse: the first throws a raw TypeError below, and the rest read back
  // as a config whose every field is undefined — damage as absence, past
  // the guard above, and overwritten by the next save.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigDamagedError(CONFIG_PATH);
  }
  const config = parsed as FullConfig;
  // Governance: validate the persisted blob. Drop invalid shapes — runtime
  // construction falls back to DEFAULT_GOVERNANCE_CONFIG when absent. A bad
  // governance block is not damage: it is a field we know how to ignore.
  if (config.governance !== undefined && !isValidGovernanceConfig(config.governance)) {
    delete config.governance;
  }
  return config;
}

/**
 * Replace the config atomically, owner-only.
 *
 * `writeFileSync` straight onto the target truncates first, so a crash, a
 * full disk or a kill between the truncate and the completed write leaves
 * the file empty or half-written — and this is the file holding the only
 * copy of the identity's key. Staging beside it and renaming means a
 * reader sees the old file or the new one, never a partial one, because
 * rename within a directory is atomic. The fsync is what makes that true
 * across power loss rather than only across a crashed process.
 */
export function saveFullConfig(config: FullConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const staged = stagingPath();
  try {
    // 0600 from the moment it exists: the contents are key material, and
    // the staged copy is as sensitive as the target.
    fs.writeFileSync(staged, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    // Tighten BEFORE the rename: after it, the save has already succeeded,
    // and a chmod that fails there (network mounts, changed ownership)
    // would be reported to the caller as a failed save that in fact landed.
    fs.chmodSync(staged, 0o600);
    const fd = fs.openSync(staged, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(staged, CONFIG_PATH);
    // The file's bytes are durable after the fsync above; the rename that
    // makes them the config is a DIRECTORY change, and is not, until this.
    try {
      const dirFd = fs.openSync(CONFIG_DIR, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Not every platform allows fsync on a directory. The rename is
      // still atomic; only its durability across power loss is weakened.
    }
  } catch (err) {
    // Never leave the scratch file behind: it holds the same secrets and
    // nothing else would ever clean it up.
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
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
  //
  // @permanent — never remove. Unlike the `--provider ollama` CLI flag
  // alias in args.ts (which is muscle-memory accommodation and sunsets on
  // a major version bump), this migration reads persisted user data we
  // can never crawl and rewrite. It must keep working for every config.json
  // file that has ever existed in the wild.
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
