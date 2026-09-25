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
import {
  isTrulyAbsent,
  mkdirOwnerOnly,
  narrowOnLoad,
  preserveAside,
  withFileLock,
  writeFileAtomic,
} from "./durable-file.js";

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

/**
 * The ONE name a damaged or replaced config is preserved under before
 * anything replaces it: `config.json.clobbered-<time>`. Every writer that
 * sets bytes aside uses it (`saveFullConfig`, create-motebit's twin, the
 * desktop's Rust `write_config`), and every reader that points a user at a
 * backup looks for it (`doctor`, `migrate-keyring`, `identity.ts`'s
 * missing-key remedy). It is the name those readers already shipped with; a
 * second spelling would be a backup nobody is ever told about.
 */
export const CONFIG_BACKUP_INFIX = ".clobbered-";
export const CONFIG_BACKUP_PREFIX = `${path.basename(CONFIG_PATH)}${CONFIG_BACKUP_INFIX}`;

/** Preserved copies of a damaged or replaced config in `CONFIG_DIR`, newest first. Never throws. */
export function listConfigBackups(): string[] {
  return listKeptKeyFiles().filter((f) => f.startsWith(CONFIG_BACKUP_PREFIX));
}

/**
 * Every file in `CONFIG_DIR` that is a kept or stranded copy of key
 * material, newest first: preserved configs (`config.json.clobbered-*`), a
 * rotation `create-motebit` left unfinished (`config.json.pre-rotation-*`
 * holds the OLD key, `config.json.rotation-next-*` the NEW one), set-aside
 * rotation write-aheads (`pending-rotation.json.clobbered-*`), and staging
 * files a crash left behind (`config.json.*.tmp`, `pending-rotation.json.*.tmp`).
 * `doctor` names every one, so no key is ever kept where nobody is told.
 * Never throws.
 */
export function listKeptKeyFiles(): string[] {
  try {
    const cfg = path.basename(CONFIG_PATH);
    return fs
      .readdirSync(CONFIG_DIR)
      .filter(
        (f) =>
          f.startsWith(CONFIG_BACKUP_PREFIX) ||
          f.startsWith(`${cfg}.pre-rotation-`) ||
          f.startsWith(`${cfg}.rotation-next-`) ||
          f.startsWith("pending-rotation.json.clobbered-") ||
          // migrate-keyring's retired PLAINTEXT keyring, and binding files kept
          // aside by export / create-motebit.
          f.startsWith("dev-keyring.json.migrated-") ||
          f.startsWith("motebit.md.clobbered-") ||
          ((f.startsWith(`${cfg}.`) || f.startsWith("pending-rotation.json.")) &&
            f.endsWith(".tmp")),
      )
      .sort()
      .reverse();
  } catch {
    // The directory itself is unreadable — the dominant cause of the damage
    // this is asked about. There is nothing to list, and nothing to throw.
    return [];
  }
}

/**
 * An existing config that cannot be read. Distinct from "no config", and the
 * distinction is load-bearing: this file holds `cli_encrypted_key` — for a
 * CLI identity, the only copy of the private key — and, for anyone who has
 * not migrated, the deprecated `cli_private_key` in plaintext. Reporting
 * damage as absence tells the user they have no identity, and the next save
 * then overwrites whatever was recoverable with a fresh, nearly-empty file.
 */
export class ConfigDamagedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    cause?: unknown,
  ) {
    super(
      `${path} exists but could not be read (${reason}). It has NOT been changed. ` +
        `If you hold your recovery seed, \`motebit restore\` rebuilds it and keeps this one as ` +
        `${path}${CONFIG_BACKUP_INFIX}<time>; otherwise copy it aside before running anything that writes config.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "ConfigDamagedError";
  }
}

/**
 * The identity in `config.json` changed on disk after this command read it —
 * another `motebit` process (`rotate`, `restore`), `create-motebit`, or the
 * desktop app committed a new key or identity meanwhile. Writing this
 * command's copy back would revert that commit and destroy the key it wrote.
 * Nothing was changed; re-run the command.
 */
export class ConfigIdentityChangedError extends Error {
  constructor(readonly path: string) {
    super(
      `the identity in ${path} changed while this command ran (another motebit process, ` +
        `create-motebit, or the desktop app committed a new key or identity). Nothing was changed — ` +
        `re-run the command so it works from the current identity.`,
    );
    this.name = "ConfigIdentityChangedError";
  }
}

/**
 * The fields of `config.json` that ARE the identity: the key (encrypted or
 * legacy plaintext), its public half, the id and device it is bound to, and
 * the embedded signed identity file. A write that changes any of them is an
 * identity change and must say so (`saveFullConfig`'s `identityChange`); a
 * write that does not is never allowed to change them — not even by writing
 * back a stale copy.
 */
const IDENTITY_FIELDS = [
  "motebit_id",
  "device_id",
  "device_public_key",
  "cli_encrypted_key",
  "cli_private_key",
  "_identity_file",
] as const;

/**
 * The identity fields as this process last READ them from disk, carried on
 * the config object itself (an enumerable symbol: object spread copies it,
 * `JSON.stringify` never writes it). It is the compare half of
 * `saveFullConfig`'s compare-and-swap.
 */
const IDENTITY_BASELINE: unique symbol = Symbol("motebit.config.identityBaseline");

type Baselined = FullConfig & { [IDENTITY_BASELINE]?: string };

/** A canonical fingerprint of a config's identity fields (absent ≡ empty). Exported for commands that must compare two reads. */
export function identityFingerprint(config: FullConfig): string {
  const c = config as Record<string, unknown>;
  return JSON.stringify(
    IDENTITY_FIELDS.map((f) => {
      const v = c[f];
      return v === undefined || v === null || v === "" ? null : v;
    }),
  );
}

/** Does `from` hold key or binding material that writing `to` would lose? */
function losesIdentityMaterial(from: FullConfig, to: FullConfig): boolean {
  const f = from as Record<string, unknown>;
  const t = to as Record<string, unknown>;
  // The key (encrypted or legacy plaintext), the embedded signed identity,
  // AND the binding itself: an identity-changing save that replaces a
  // `motebit_id` / `device_id` / `device_public_key` keeps the old one too.
  for (const field of [
    "cli_encrypted_key",
    "cli_private_key",
    "_identity_file",
    "motebit_id",
    "device_id",
    "device_public_key",
  ] as const) {
    const v = f[field];
    if (v === undefined || v === null || v === "") continue;
    if (JSON.stringify(v) !== JSON.stringify(t[field])) return true;
  }
  return false;
}

/**
 * Read the config under the three-way split every config reader obeys:
 * ABSENT (ENOENT of the name itself) is a first run and reads as `{}`;
 * anything else that is unreadable, unparseable, valid JSON that is not an
 * object, or a symlink whose target is missing is DAMAGE and throws
 * `ConfigDamagedError` with the file's bytes untouched. Nothing but absence
 * is ever answered "empty". The file is narrowed to owner-only on EVERY read
 * that finds it — before any damage is reported, since damaged bytes are
 * still key bytes.
 */
function readConfigStrict(): FullConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && isTrulyAbsent(CONFIG_PATH)) return {};
    narrowOnLoad(CONFIG_PATH);
    throw new ConfigDamagedError(
      CONFIG_PATH,
      code === "ENOENT" ? "a symlink whose target is missing" : (code ?? "unreadable"),
      err,
    );
  }
  // A config written before owner-only was the rule is world-readable, and
  // most commands only READ it — tightening on the next save alone would
  // leave read-only users exposed indefinitely.
  narrowOnLoad(CONFIG_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigDamagedError(CONFIG_PATH, "not valid JSON", err);
  }
  // Valid JSON is not a valid config. `null` would throw a raw TypeError at
  // the first field access; `[]`, `3`, `"x"` read back as a config whose every
  // field is undefined — damage wearing absence's clothes.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigDamagedError(CONFIG_PATH, "not a JSON object");
  }
  const config = parsed as Baselined;
  config[IDENTITY_BASELINE] = identityFingerprint(config);
  return config;
}

export function loadFullConfig(): FullConfig {
  const config = readConfigStrict();
  // Governance: validate the persisted blob. Drop invalid shapes — runtime
  // construction falls back to DEFAULT_GOVERNANCE_CONFIG when absent. A bad
  // governance block is not damage: it is a field we know how to ignore.
  if (config.governance !== undefined && !isValidGovernanceConfig(config.governance)) {
    delete config.governance;
  }
  return config;
}

/**
 * How a save that CHANGES the identity fields treats what it replaces.
 *
 *  - `"preserve-replaced"` — the default for every identity change: if the
 *    config on disk holds key or binding material the new one does not
 *    carry (`cli_encrypted_key`, `cli_private_key`, `_identity_file`), its
 *    bytes are kept as `config.json.clobbered-<time>` first, or the save
 *    refuses.
 *  - `"retire-relay-accepted"` — a key rotation whose succession the relay
 *    has RECORDED (or an identity with no relay configured): the retired key
 *    may be erased. The founder's ruling (`docs/proposals/key-file-durability-v1.md`):
 *    a retired key is erased only then; before relay confirmation it is kept.
 *  - `"reencrypt-same-key"` — the SAME private key re-encoded (the legacy
 *    plaintext `cli_private_key` migrated to `cli_encrypted_key`): no key is
 *    replaced, and keeping the plaintext would defeat the migration.
 */
export type IdentityChange = "preserve-replaced" | "retire-relay-accepted" | "reencrypt-same-key";

/**
 * Replace the config atomically and owner-only — never over damage, and
 * never over an identity this caller did not read.
 *
 * Under the config lock (`config.json.lock`, shared with create-motebit):
 *
 *  1. If the file on disk is damaged, its bytes are first preserved as
 *     `CONFIG_BACKUP_PREFIX<time>`, or the save refuses.
 *  2. A save that does NOT declare `identityChange` never changes the
 *     identity fields. If another process changed them since this config
 *     was read (a `motebit rotate` while a REPL was open), the on-disk
 *     identity is kept and only this caller's other fields are written — a
 *     `/model` or `/mcp add` can never revert a rotation. A save that would
 *     change them without declaring it throws.
 *  3. A save that DOES declare an identity change is refused
 *     (`ConfigIdentityChangedError`) if the identity on disk is no longer
 *     the one this config was read with — the caller decided on a state that
 *     no longer exists. Replaced key/binding material is kept first unless
 *     the change is `"retire-relay-accepted"`.
 *
 * Returns the path of a kept copy when one was made.
 */
export function saveFullConfig(
  config: FullConfig,
  opts: { identityChange?: IdentityChange } = {},
): string | null {
  mkdirOwnerOnly(CONFIG_DIR);
  return withFileLock(CONFIG_PATH, () => {
    const write = config as Baselined;
    const baseline = write[IDENTITY_BASELINE];
    let preservedAs: string | null = null;
    let onDisk: FullConfig | null;
    try {
      // Absent (deleted since it was read): nothing on disk to protect or
      // revert — the write lands as given, as it always has.
      onDisk = isTrulyAbsent(CONFIG_PATH) ? null : readConfigStrict();
    } catch (err) {
      if (!(err instanceof ConfigDamagedError)) throw err;
      preservedAs = preserveAside(CONFIG_PATH, CONFIG_BACKUP_INFIX);
      onDisk = null;
    }
    if (onDisk != null && identityFingerprint(onDisk) !== identityFingerprint(write)) {
      const diskPrint = identityFingerprint(onDisk);
      const untouched = baseline !== undefined && identityFingerprint(write) === baseline;
      if (opts.identityChange === undefined && untouched) {
        // The caller never touched the identity; the disk moved under it.
        // The disk's identity wins.
        const w = write as Record<string, unknown>;
        const d = onDisk as Record<string, unknown>;
        for (const f of IDENTITY_FIELDS) {
          if (d[f] === undefined) delete w[f];
          else w[f] = d[f];
        }
      } else {
        // An identity change — declared, or (for a config built without a
        // read) implied. Decided on a state that must still be the state.
        if (baseline !== undefined && baseline !== diskPrint) {
          throw new ConfigIdentityChangedError(CONFIG_PATH);
        }
        const mode = opts.identityChange ?? "preserve-replaced";
        if (mode === "preserve-replaced" && losesIdentityMaterial(onDisk, write)) {
          preservedAs = preserveAside(CONFIG_PATH, CONFIG_BACKUP_INFIX);
        }
      }
    }
    writeFileAtomic(CONFIG_PATH, JSON.stringify(write, null, 2), 0o600);
    write[IDENTITY_BASELINE] = identityFingerprint(write);
    return preservedAs;
  });
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

/**
 * Compare-and-swap for a rotation's commit (key-file durability item 3): the
 * key a rotation departs from must still be the one on disk. If another
 * process (a second `motebit rotate`, `restore`, create-motebit, the desktop)
 * replaced it meanwhile, committing would destroy THAT key — refuse, and the
 * caller's write-ahead (never cleared on a throw) keeps the new key.
 * `after` already holding `newPublicKeyHex` is a retry of this commit.
 */
export function refuseIfKeyReplacedSince(
  before: FullConfig,
  after: FullConfig,
  newPublicKeyHex: string,
): void {
  if (
    JSON.stringify(after.cli_encrypted_key) !== JSON.stringify(before.cli_encrypted_key) &&
    after.device_public_key !== newPublicKeyHex
  ) {
    throw new Error(
      "the key in config.json changed while this rotation ran (another motebit process replaced it); nothing local was changed — the new key stays held in the write-ahead",
    );
  }
}

/**
 * The founder's ruling on a key retired by rotation
 * (docs/proposals/key-file-durability-v1.md): it is erased ONLY once the
 * relay has accepted the succession. A relay that holds no key for this
 * identity ("none") confirmed nothing, so the retired key is kept (0600).
 */
export function retiredKeyChange(relay: "recorded" | "already-held" | "none"): IdentityChange {
  return relay === "none" ? "preserve-replaced" : "retire-relay-accepted";
}
