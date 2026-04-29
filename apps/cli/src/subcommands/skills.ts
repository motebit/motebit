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
  type SkillRecord,
  type SkillTrustGrantEvent,
} from "@motebit/skills";

import type { CliConfig } from "../args.js";
import { CONFIG_DIR } from "../config.js";
import { bold, cyan, dim, error as errorColor, success, warn } from "../colors.js";

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
  const sourceArg = requirePositional(config, 2, "<directory-path>");

  // v1 only supports directory sources. git/url install land in phase 2.
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
    console.error(dim("(git+ssh and https:// install sources land in phase 2.)"));
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

  const registry = buildRegistry();
  try {
    const result = await registry.install(installSource, {
      force: config.force === true,
      source_label: `directory:${path}`,
    });
    console.log();
    console.log(`  ${bold(result.name)} ${dim(`v${result.version}`)}`);
    console.log(`  ${dim("provenance:")} ${provenanceStatusText(result.provenance_status)}`);
    console.log(`  ${dim("from:")} ${path}`);
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
