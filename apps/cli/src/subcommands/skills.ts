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

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as readline from "node:readline";

import {
  NodeFsSkillStorageAdapter,
  SkillInstallError,
  SkillRegistry,
  parseSkillFile,
  resolveDirectorySkillSource,
  serializeSkillFile,
  type SkillAuditSink,
  type SkillInstallSource,
  type SkillRecord,
  type SkillTrustGrantEvent,
} from "@motebit/skills";
import {
  canonicalJson,
  decodeSkillSignaturePublicKey,
  hash as sha256Hex,
  hexToBytes,
  publicKeyToDidKey,
  signSkillEnvelope,
  signSkillManifest,
  verifySkillEnvelope,
} from "@motebit/encryption";
import type {
  SkillEnvelope,
  SkillManifest,
  SkillRegistryBundle,
  SkillRegistrySubmitRequest,
  SkillRegistrySubmitResponse,
} from "@motebit/sdk";

import type { CliConfig } from "../args.js";
import { CONFIG_DIR, loadFullConfig } from "../config.js";
import { decryptPrivateKey, fromHex, promptPassphrase } from "../identity.js";
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

// ---------------------------------------------------------------------------
// publish — sign + submit to the relay-hosted registry
// ---------------------------------------------------------------------------

const SKILL_MD_NAME = "SKILL.md";
const SKILL_ENVELOPE_JSON_NAME = "skill-envelope.json";
const AUX_DIRS = ["scripts", "references", "templates", "assets"] as const;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Walk the four conventional aux-file directories and return a flat
 * map of relative paths → bytes. Mirrors the fs-adapter's collector
 * but stays local because we only need it for one CLI flow and
 * pulling it from the BSL package would re-expose internals.
 */
function collectAuxFiles(skillDir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  function walk(current: string, base: string): void {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, base);
      } else if (entry.isFile()) {
        const rel = full
          .slice(base.length + 1)
          .split(/[\\/]+/)
          .join("/");
        out[rel] = readFileSync(full);
      }
    }
  }
  for (const subdir of AUX_DIRS) {
    const subdirPath = join(skillDir, subdir);
    if (existsSync(subdirPath)) walk(subdirPath, skillDir);
  }
  return out;
}

/**
 * Decrypt the user's CLI identity key. Mirrors the resolution order in
 * `attest.ts` so operators see the same passphrase prompt across
 * commands that need to sign.
 */
async function loadIdentityKey(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const fullConfig = loadFullConfig();
  if (!fullConfig.cli_encrypted_key) {
    console.error(
      errorColor("  No CLI identity key found. Run `motebit attest` to bootstrap one."),
    );
    process.exit(1);
  }
  if (fullConfig.device_public_key === undefined || fullConfig.device_public_key === "") {
    console.error(
      errorColor("  device_public_key missing from config — bootstrap an identity first."),
    );
    process.exit(1);
  }

  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;
  if (envPassphrase !== undefined && envPassphrase !== "") {
    passphrase = envPassphrase;
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      escapeCodeTimeout: 50,
    });
    try {
      passphrase = await promptPassphrase(rl, "Passphrase: ");
    } finally {
      rl.close();
    }
  }

  let privateKeyHex: string;
  try {
    privateKeyHex = await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
  } catch {
    console.error(errorColor("  Incorrect passphrase."));
    process.exit(1);
  }

  return {
    privateKey: fromHex(privateKeyHex),
    publicKey: fromHex(fullConfig.device_public_key),
  };
}

/**
 * Sign (or re-sign) a skill directory. Reads SKILL.md, optionally an
 * existing envelope; produces a fresh signed manifest + envelope using
 * the supplied keypair, and writes both back to disk byte-stable. The
 * directory becomes self-contained for re-distribution.
 */
async function signSkillDirectory(
  skillDir: string,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<{ envelope: SkillEnvelope; manifest: SkillManifest; body: Uint8Array }> {
  const skillMdPath = join(skillDir, SKILL_MD_NAME);
  if (!existsSync(skillMdPath)) {
    console.error(errorColor(`  No SKILL.md at ${skillMdPath}`));
    process.exit(1);
  }
  const text = readFileSync(skillMdPath, "utf-8");
  const parsed = parseSkillFile(text);
  const body = parsed.body;

  // Strip any pre-existing manifest signature so we always re-derive
  // canonically against the supplied keypair. Idempotent re-publishes
  // produce identical bytes when the body and keypair are unchanged.
  const motebitNoSig = { ...parsed.manifest.motebit };
  delete motebitNoSig.signature;
  const unsignedManifest: Omit<SkillManifest, "motebit"> & {
    motebit: Omit<SkillManifest["motebit"], "signature">;
  } = {
    ...parsed.manifest,
    motebit: motebitNoSig,
  };

  const signedManifest = await signSkillManifest(unsignedManifest, privateKey, publicKey, body);

  // content_hash = SHA-256 over JCS(manifest) || 0x0A || lf_body.
  const manifestBytes = new TextEncoder().encode(canonicalJson(signedManifest));
  const fullContent = new Uint8Array(manifestBytes.length + 1 + body.length);
  fullContent.set(manifestBytes, 0);
  fullContent[manifestBytes.length] = 0x0a;
  fullContent.set(body, manifestBytes.length + 1);
  const contentHash = await sha256Hex(fullContent);
  const bodyHash = await sha256Hex(body);

  // Per-file hashes for any aux files. The envelope must pin every
  // byte the directory ships; the relay re-derives and asserts on
  // submit (skills-registry-v1.md §6.1).
  const auxFiles = collectAuxFiles(skillDir);
  const filesEntries = await Promise.all(
    Object.entries(auxFiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([path, bytes]) => ({ path, hash: await sha256Hex(bytes) })),
  );

  const signedEnvelope = await signSkillEnvelope(
    {
      spec_version: "1.0",
      skill: {
        name: signedManifest.name,
        version: signedManifest.version,
        content_hash: contentHash,
      },
      manifest: signedManifest,
      body_hash: bodyHash,
      files: filesEntries,
    },
    privateKey,
    publicKey,
  );

  // Write back the signed artifacts so the directory is self-contained
  // for re-distribution. SKILL.md gets the in-band manifest signature;
  // skill-envelope.json gets the canonical envelope. Both paths are
  // verifiable offline against the embedded public_key (skills-v1.md §5.3).
  const skillMdContent = serializeSkillFile(signedManifest, body);
  writeFileSync(skillMdPath, skillMdContent);
  writeFileSync(
    join(skillDir, SKILL_ENVELOPE_JSON_NAME),
    JSON.stringify(signedEnvelope, null, 2) + "\n",
  );

  return { envelope: signedEnvelope, manifest: signedManifest, body };
}

export async function handleSkillsPublish(config: CliConfig): Promise<void> {
  const sourceArg = requirePositional(config, 2, "<directory-path>");
  const skillDir = isAbsolute(sourceArg) ? sourceArg : resolve(process.cwd(), sourceArg);

  let stat;
  try {
    stat = statSync(skillDir);
  } catch {
    console.error(errorColor(`  No such path: ${skillDir}`));
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(errorColor(`  Source must be a directory containing SKILL.md. Got: ${skillDir}`));
    process.exit(1);
  }

  const { privateKey, publicKey } = await loadIdentityKey();
  const submitterMotebitId = publicKeyToDidKey(publicKey);

  console.log(dim(`  Signing ${skillDir} with ${submitterMotebitId}…`));

  const { envelope, manifest, body } = await signSkillDirectory(skillDir, privateKey, publicKey);

  // Local re-verify before going to the network. A tampered private
  // key (or a dependency drift in the signing chain) would surface
  // here, not at the relay 400.
  const ok = await verifySkillEnvelope(envelope, decodeSkillSignaturePublicKey(envelope.signature));
  if (!ok) {
    console.error(errorColor("  Local re-verify failed after signing — refusing to publish."));
    process.exit(1);
  }

  // Build the submission payload.
  const auxFiles = collectAuxFiles(skillDir);
  const filesPayload: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(auxFiles)) {
    filesPayload[path] = bytesToBase64(bytes);
  }
  const submission: SkillRegistrySubmitRequest = {
    envelope,
    body: bytesToBase64(body),
    ...(Object.keys(filesPayload).length > 0 ? { files: filesPayload } : {}),
  };

  const relayUrl = resolveRelayUrl().replace(/\/$/, "");
  const submitUrl = `${relayUrl}/api/v1/skills/submit`;

  console.log(dim(`  Submitting to ${submitUrl}…`));

  let resp: Response;
  try {
    resp = await fetch(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    console.error(
      errorColor(`  Relay request failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exit(1);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(errorColor(`  Relay returned ${resp.status}: ${text || resp.statusText}`));
    process.exit(1);
  }

  const out = (await resp.json()) as SkillRegistrySubmitResponse;
  const isUpdate = resp.status === 200;

  console.log();
  console.log(`  ${success(isUpdate ? "republished (idempotent)" : "published")}`);
  console.log(`  ${bold(manifest.name)} ${dim(`v${manifest.version}`)}`);
  console.log(`  ${dim("address:")} ${cyan(out.skill_id)}`);
  console.log(`  ${dim("submitter:")} ${out.submitter_motebit_id}`);
  console.log(`  ${dim("content:")}   ${out.content_hash}`);
  console.log();
  console.log(dim(`  Install elsewhere with: motebit skills install ${out.skill_id}`));
  console.log();
}
