/**
 * `motebit skills` — install, list, enable, disable, remove, verify,
 * trust, and untrust user-installed skills (spec/skills-v1.md).
 *
 * Install is permissive: an unsigned skill (no `motebit.signature`) writes
 * to disk but the selector never auto-loads it until the operator promotes
 * it via `motebit skills trust <name>`. A skill whose envelope signature
 * fails verification is rejected at install — that's a tampered or
 * mis-attributed artifact, not honestly-unsigned.
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  NodeFsSkillStorageAdapter,
  SkillInstallError,
  SkillRegistry,
  resolveDirectorySkillSource,
  type SkillAuditSink,
  type SkillInstallSource,
  type SkillRecord,
  type SkillTrustGrantEvent,
} from "@motebit/skills";
import {
  decodeSkillSignaturePublicKey,
  publicKeyToDidKey,
  hexToBytes,
  verifySkillEnvelope,
} from "@motebit/encryption";
import type { SkillRegistryBundle } from "@motebit/sdk";

import type { CliConfig } from "../args.js";
import { CONFIG_DIR, loadFullConfig } from "../config.js";
import { bold, cyan, dim, error as errorColor, success, warn } from "../colors.js";

const DEFAULT_RELAY_URL = "https://relay.motebit.com";

/**
 * Pattern for the registry addressing tuple: `did:key:z…/<name>@<version>`.
 * The `did:key:` prefix is the unambiguous discriminator that lets us
 * tell a relay address apart from a filesystem path without statting it
 * first — no path on a sane host starts with `did:key:`.
 */
const REGISTRY_ADDRESS_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]+\/[a-z0-9-]+@[^/]+$/;

interface ParsedRegistryAddress {
  submitter_motebit_id: string;
  name: string;
  version: string;
}

function tryParseRegistryAddress(input: string): ParsedRegistryAddress | null {
  if (!REGISTRY_ADDRESS_RE.test(input)) return null;
  const slash = input.indexOf("/");
  const at = input.lastIndexOf("@");
  return {
    submitter_motebit_id: input.slice(0, slash),
    name: input.slice(slash + 1, at),
    version: input.slice(at + 1),
  };
}

function resolveRelayUrl(): string {
  return (
    process.env["MOTEBIT_RELAY_URL"] ??
    process.env["MOTEBIT_SYNC_URL"] ??
    loadFullConfig().sync_url ??
    DEFAULT_RELAY_URL
  );
}

const SKILLS_DIR_NAME = "skills";
const AUDIT_LOG_NAME = "audit.log";

function getSkillsRoot(): string {
  return join(CONFIG_DIR, SKILLS_DIR_NAME);
}

function getAuditLogPath(): string {
  return join(getSkillsRoot(), AUDIT_LOG_NAME);
}

function makeAuditSink(): SkillAuditSink {
  return (event: SkillTrustGrantEvent) => {
    const root = getSkillsRoot();
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    appendFileSync(getAuditLogPath(), JSON.stringify(event) + "\n", "utf-8");
  };
}

function buildRegistry(): SkillRegistry {
  const adapter = new NodeFsSkillStorageAdapter({ root: getSkillsRoot() });
  return new SkillRegistry(adapter, { audit: makeAuditSink() });
}

function provenanceBadge(record: SkillRecord): string {
  switch (record.provenance_status) {
    case "verified":
      return success("[verified]");
    case "trusted_unsigned":
      return warn("[trusted-unsigned]");
    case "unsigned":
      return dim("[unsigned]");
    case "unverified":
      return errorColor("[unverified]");
  }
}

function requirePositional(config: CliConfig, idx: number, label: string): string {
  const value = config.positionals[idx];
  if (!value) {
    console.error(`Missing argument: ${label}`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export async function handleSkillsInstall(config: CliConfig): Promise<void> {
  const sourceArg = requirePositional(config, 2, "<directory-path | did:key:…/name@version>");

  const registryAddress = tryParseRegistryAddress(sourceArg);
  if (registryAddress !== null) {
    await installFromRelay(config, sourceArg, registryAddress);
    return;
  }

  await installFromDirectory(config, sourceArg);
}

async function installFromDirectory(config: CliConfig, sourceArg: string): Promise<void> {
  const path = isAbsolute(sourceArg) ? sourceArg : resolve(process.cwd(), sourceArg);

  let stat;
  try {
    stat = statSync(path);
  } catch {
    console.error(errorColor(`No such path: ${path}`));
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(
      errorColor(
        `Source must be a directory containing SKILL.md and skill-envelope.json. Got: ${path}`,
      ),
    );
    console.error(dim("(git+ssh install sources land in phase 2.)"));
    process.exit(1);
  }

  let installSource;
  try {
    installSource = resolveDirectorySkillSource(path);
  } catch (err: unknown) {
    console.error(errorColor(`Failed to read skill at ${path}:`));
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  await runInstall(config, installSource, `directory:${path}`, path);
}

async function installFromRelay(
  config: CliConfig,
  rawAddress: string,
  parsed: ParsedRegistryAddress,
): Promise<void> {
  const relayUrl = resolveRelayUrl().replace(/\/$/, "");
  const submitterPath = encodeURIComponent(parsed.submitter_motebit_id);
  const namePath = encodeURIComponent(parsed.name);
  const versionPath = encodeURIComponent(parsed.version);
  const url = `${relayUrl}/api/v1/skills/${submitterPath}/${namePath}/${versionPath}`;

  console.log(dim(`  Resolving ${rawAddress} from ${relayUrl}…`));

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: unknown) {
    console.error(
      errorColor(`  Relay request failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  if (resp.status === 404) {
    console.error(errorColor(`  Not found on relay: ${rawAddress}`));
    process.exit(1);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(errorColor(`  Relay returned ${resp.status}: ${body || resp.statusText}`));
    process.exit(1);
  }

  let bundle: SkillRegistryBundle;
  try {
    bundle = (await resp.json()) as SkillRegistryBundle;
  } catch (err: unknown) {
    console.error(
      errorColor(
        `  Relay returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    process.exit(1);
  }

  // Re-verify everything the relay claimed. The relay is a convenience
  // surface, never a trust root (services/relay/CLAUDE.md rule 6) —
  // re-verifying here is what makes that doctrine real.
  try {
    const publicKey = decodeSkillSignaturePublicKey(bundle.envelope.signature);
    const ok = await verifySkillEnvelope(bundle.envelope, publicKey);
    if (!ok) {
      console.error(
        errorColor("  Envelope signature failed local verification — refusing to install."),
      );
      process.exit(1);
    }
    const derivedSubmitter = publicKeyToDidKey(hexToBytes(bundle.envelope.signature.public_key));
    if (derivedSubmitter !== parsed.submitter_motebit_id) {
      console.error(
        errorColor(
          `  Relay returned a bundle whose signer (${derivedSubmitter}) does not match the requested submitter (${parsed.submitter_motebit_id}). Refusing to install.`,
        ),
      );
      process.exit(1);
    }
    if (
      bundle.envelope.skill.name !== parsed.name ||
      bundle.envelope.skill.version !== parsed.version
    ) {
      console.error(
        errorColor(
          `  Relay returned ${bundle.envelope.skill.name}@${bundle.envelope.skill.version}, expected ${parsed.name}@${parsed.version}.`,
        ),
      );
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error(
      errorColor(`  Local verification threw: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  const bodyBytes = base64Decode(bundle.body);
  const fileBytes: Record<string, Uint8Array> = {};
  if (bundle.files) {
    for (const [path, b64] of Object.entries(bundle.files)) {
      fileBytes[path] = base64Decode(b64);
    }
  }

  const installSource: SkillInstallSource = {
    kind: "in_memory",
    manifest: bundle.envelope.manifest,
    envelope: bundle.envelope,
    body: bodyBytes,
    files: fileBytes,
  };

  await runInstall(config, installSource, `registry:${rawAddress}`, rawAddress);
}

function base64Decode(s: string): Uint8Array {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function runInstall(
  config: CliConfig,
  installSource: SkillInstallSource,
  sourceLabel: string,
  displaySource: string,
): Promise<void> {
  const registry = buildRegistry();
  try {
    const result = await registry.install(installSource, {
      force: config.force === true,
      source_label: sourceLabel,
    });
    console.log();
    console.log(`  ${bold(result.name)} ${dim(`v${result.version}`)}`);
    console.log(`  ${dim("provenance:")} ${provenanceStatusText(result.provenance_status)}`);
    console.log(`  ${dim("from:")} ${displaySource}`);
    if (result.provenance_status !== "verified") {
      console.log();
      console.log(dim("  This skill is unsigned. The selector will NOT auto-load it"));
      console.log(dim(`  until you grant trust: ${cyan(`motebit skills trust ${result.name}`)}`));
    }
    console.log();
  } catch (err: unknown) {
    if (err instanceof SkillInstallError) {
      console.error();
      console.error(errorColor(`  Install rejected: ${err.message}`));
      if (err.reason === "duplicate_name") {
        console.error(dim(`  Pass ${bold("--force")} to overwrite the existing version.`));
      }
      console.error();
      process.exit(1);
    }
    throw err;
  }
}

function provenanceStatusText(status: string): string {
  switch (status) {
    case "verified":
      return success("verified (signed by author)");
    case "trusted_unsigned":
      return warn("trusted (operator-attested, not cryptographic)");
    case "unsigned":
      return dim("unsigned (selector will skip until trusted)");
    case "unverified":
      return errorColor("unverified (signature failed)");
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function handleSkillsList(config: CliConfig): Promise<void> {
  const registry = buildRegistry();
  const records = await registry.list();

  if (config.json) {
    console.log(
      JSON.stringify(
        records.map((r) => ({
          name: r.manifest.name,
          version: r.manifest.version,
          enabled: r.index.enabled,
          trusted: r.index.trusted,
          provenance_status: r.provenance_status,
          sensitivity: r.manifest.motebit.sensitivity ?? "none",
          installed_at: r.index.installed_at,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (records.length === 0) {
    console.log();
    console.log(dim("  No skills installed."));
    console.log();
    console.log(`  ${dim("Install a skill:")} ${cyan("motebit skills install <directory>")}`);
    console.log();
    return;
  }

  console.log();
  for (const record of records) {
    const enabled = record.index.enabled ? "" : dim(" [disabled]");
    const sensitivity = record.manifest.motebit.sensitivity ?? "none";
    const sensTag = sensitivity === "none" ? "" : dim(` [${sensitivity}]`);
    console.log(
      `  ${bold(record.manifest.name)} ${dim(`v${record.manifest.version}`)} ${provenanceBadge(record)}${sensTag}${enabled}`,
    );
    console.log(`    ${dim(record.manifest.description)}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

export async function handleSkillsEnable(config: CliConfig): Promise<void> {
  const name = requirePositional(config, 2, "<skill-name>");
  const registry = buildRegistry();
  const record = await registry.get(name);
  if (!record) {
    console.error(errorColor(`Skill not installed: ${name}`));
    process.exit(1);
  }
  await registry.enable(name);
  console.log(`  ${success("enabled")} ${bold(name)}`);
}

export async function handleSkillsDisable(config: CliConfig): Promise<void> {
  const name = requirePositional(config, 2, "<skill-name>");
  const registry = buildRegistry();
  const record = await registry.get(name);
  if (!record) {
    console.error(errorColor(`Skill not installed: ${name}`));
    process.exit(1);
  }
  await registry.disable(name);
  console.log(`  ${dim("disabled")} ${bold(name)}`);
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export async function handleSkillsRemove(config: CliConfig): Promise<void> {
  const name = requirePositional(config, 2, "<skill-name>");
  const registry = buildRegistry();
  const record = await registry.get(name);
  if (!record) {
    console.error(errorColor(`Skill not installed: ${name}`));
    process.exit(1);
  }
  await registry.remove(name);
  console.log(`  ${dim("removed")} ${bold(name)} ${dim(`v${record.manifest.version}`)}`);
  console.log(dim(`  Audit event written to ${getAuditLogPath()}`));
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export async function handleSkillsVerify(config: CliConfig): Promise<void> {
  const name = requirePositional(config, 2, "<skill-name>");
  const registry = buildRegistry();
  const status = await registry.verify(name);
  if (status === "not_installed") {
    console.error(errorColor(`Skill not installed: ${name}`));
    process.exit(1);
  }
  console.log();
  console.log(`  ${bold(name)}`);
  console.log(`  ${dim("provenance:")} ${provenanceStatusText(status)}`);
  console.log();
}

// ---------------------------------------------------------------------------
// trust / untrust
// ---------------------------------------------------------------------------

export async function handleSkillsTrust(config: CliConfig): Promise<void> {
  const name = requirePositional(config, 2, "<skill-name>");
  const registry = buildRegistry();
  const record = await registry.get(name);
  if (!record) {
    console.error(errorColor(`Skill not installed: ${name}`));
    process.exit(1);
  }
  await registry.trust(name);
  console.log();
  console.log(`  ${success("trusted")} ${bold(name)}`);
  console.log(dim("  This is an operator attestation, NOT cryptographic provenance. The skill"));
  console.log(
    dim("  remains tagged unverified everywhere it surfaces. Auto-load eligibility only."),
  );
  console.log(dim(`  Audit event written to ${getAuditLogPath()}`));
  console.log();
}

export async function handleSkillsUntrust(config: CliConfig): Promise<void> {
  const name = requirePositional(config, 2, "<skill-name>");
  const registry = buildRegistry();
  const record = await registry.get(name);
  if (!record) {
    console.error(errorColor(`Skill not installed: ${name}`));
    process.exit(1);
  }
  await registry.untrust(name);
  console.log(`  ${dim("untrusted")} ${bold(name)}`);
}
