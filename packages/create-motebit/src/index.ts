#!/usr/bin/env node

/**
 * create-motebit — Create and verify motebit.md agent identity files.
 *
 * Usage:
 *   npm create motebit            # Generate a new motebit.md
 *   npx create-motebit            # Same
 *   npx create-motebit verify     # Verify an existing motebit.md
 *   npx create-motebit verify path/to/motebit.md
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { verify } from "@motebit/verify";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return Buffer.from(binary, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// YAML serializer — handles only the motebit identity schema
// ---------------------------------------------------------------------------

interface IdentityData {
  spec: string;
  motebit_id: string;
  created_at: string;
  owner_id: string;
  identity: { algorithm: string; public_key: string };
  governance: {
    trust_mode: string;
    max_risk_auto: string;
    require_approval_above: string;
    deny_above: string;
    operator_mode: boolean;
  };
  privacy: {
    default_sensitivity: string;
    retention_days: Record<string, number>;
    fail_closed: boolean;
  };
  memory: {
    half_life_days: number;
    confidence_threshold: number;
    per_turn_limit: number;
  };
  devices: Array<{
    device_id: string;
    name: string;
    public_key: string;
    registered_at: string;
  }>;
}

function serializeYaml(data: IdentityData): string {
  const lines: string[] = [];

  lines.push(`spec: "${data.spec}"`);
  lines.push(`motebit_id: "${data.motebit_id}"`);
  lines.push(`created_at: "${data.created_at}"`);
  lines.push(`owner_id: "${data.owner_id}"`);

  lines.push("identity:");
  lines.push(`  algorithm: "${data.identity.algorithm}"`);
  lines.push(`  public_key: "${data.identity.public_key}"`);

  lines.push("governance:");
  lines.push(`  trust_mode: "${data.governance.trust_mode}"`);
  lines.push(`  max_risk_auto: "${data.governance.max_risk_auto}"`);
  lines.push(`  require_approval_above: "${data.governance.require_approval_above}"`);
  lines.push(`  deny_above: "${data.governance.deny_above}"`);
  lines.push(`  operator_mode: ${data.governance.operator_mode}`);

  lines.push("privacy:");
  lines.push(`  default_sensitivity: "${data.privacy.default_sensitivity}"`);
  lines.push("  retention_days:");
  for (const [k, v] of Object.entries(data.privacy.retention_days)) {
    lines.push(`    ${k}: ${v}`);
  }
  lines.push(`  fail_closed: ${data.privacy.fail_closed}`);

  lines.push("memory:");
  lines.push(`  half_life_days: ${data.memory.half_life_days}`);
  lines.push(`  confidence_threshold: ${data.memory.confidence_threshold}`);
  lines.push(`  per_turn_limit: ${data.memory.per_turn_limit}`);

  if (data.devices.length === 0) {
    lines.push("devices: []");
  } else {
    lines.push("devices:");
    for (const d of data.devices) {
      lines.push(`  - device_id: "${d.device_id}"`);
      lines.push(`    name: "${d.name}"`);
      lines.push(`    public_key: "${d.public_key}"`);
      lines.push(`    registered_at: "${d.registered_at}"`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = "0.1.0";
const SIG_PREFIX = "<!-- motebit:sig:Ed25519:";
const SIG_SUFFIX = " -->";
const KEYS_DIR = join(homedir(), ".motebit", "keys");

// ---------------------------------------------------------------------------
// Colors (ANSI — disabled if NO_COLOR is set)
// ---------------------------------------------------------------------------

const noColor = "NO_COLOR" in process.env;
const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[22m`);
const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[39m`);
const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[39m`);
const bold = (s: string) => (noColor ? s : `\x1b[1m${s}\x1b[22m`);
const cyan = (s: string) => (noColor ? s : `\x1b[36m${s}\x1b[39m`);

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

async function init(outputPath: string): Promise<void> {
  console.log();
  console.log(`  ${bold("create-motebit")} ${dim(`v${VERSION}`)}`);
  console.log();

  // Check if motebit.md already exists
  if (existsSync(outputPath)) {
    console.log(`  ${red("!")} ${outputPath} already exists.`);
    console.log(`    Use ${cyan("create-motebit verify")} to check it.`);
    console.log();
    process.exit(1);
  }

  // Generate Ed25519 keypair
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const publicKeyHex = toHex(publicKey);
  const privateKeyHex = toHex(privateKey);

  // Generate identity
  const motebitId = randomUUID();
  const now = new Date().toISOString();

  const data: IdentityData = {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: now,
    owner_id: "owner",
    identity: {
      algorithm: "Ed25519",
      public_key: publicKeyHex,
    },
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "R1_DRAFT",
      require_approval_above: "R1_DRAFT",
      deny_above: "R4_MONEY",
      operator_mode: false,
    },
    privacy: {
      default_sensitivity: "personal",
      retention_days: { none: 365, personal: 90, medical: 30, financial: 30, secret: 7 },
      fail_closed: true,
    },
    memory: {
      half_life_days: 7,
      confidence_threshold: 0.3,
      per_turn_limit: 5,
    },
    devices: [],
  };

  // Serialize + sign
  const yaml = serializeYaml(data);
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed.signAsync(frontmatterBytes, privateKey);
  const sigB64 = toBase64Url(signature);
  const content = `---\n${yaml}\n---\n${SIG_PREFIX}${sigB64}${SIG_SUFFIX}\n`;

  // Write identity file
  writeFileSync(outputPath, content, "utf-8");

  // Store private key
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  const keyPath = join(KEYS_DIR, `${motebitId}.key`);
  const keyContent = [
    "# motebit private key — DO NOT COMMIT",
    `# motebit_id: ${motebitId}`,
    "# algorithm: Ed25519",
    `# created: ${now}`,
    privateKeyHex,
    "",
  ].join("\n");
  writeFileSync(keyPath, keyContent, { encoding: "utf-8", mode: 0o600 });

  // Restrict permissions (redundant on POSIX, needed for some edge cases)
  try {
    chmodSync(keyPath, 0o600);
    chmodSync(KEYS_DIR, 0o700);
  } catch {
    // Windows — permissions set by writeFileSync mode where supported
  }

  // Output
  console.log(`  ${green("+")} Generated agent identity`);
  console.log();
  console.log(`    motebit_id   ${cyan(motebitId)}`);
  console.log(`    public_key   ${dim(publicKeyHex.slice(0, 16))}...`);
  console.log(`    algorithm    Ed25519`);
  console.log(`    trust_mode   guarded`);
  console.log();
  console.log(`  ${green(">")} ${bold(outputPath)} written ${dim("(signed identity file)")}`);
  console.log(`  ${green(">")} ${dim(keyPath)} ${dim("(private key, chmod 600)")}`);
  console.log();
  console.log(`  ${bold("Next steps:")}`);
  console.log();
  console.log(`    1. ${dim("Add to your repo:")}      git add ${outputPath}`);
  console.log(`    2. ${dim("Verify signature:")}      npx create-motebit verify`);
  console.log(`    3. ${dim("Add to .gitignore:")}     echo '.motebit-keys/' >> .gitignore`);
  console.log();
  console.log(`  ${dim("Never commit your private key.")}`);
  console.log(`  ${dim("Learn more: https://github.com/motebit/motebit/blob/main/spec/identity-v1.md")}`);
  console.log();
}

// ---------------------------------------------------------------------------
// verify command
// ---------------------------------------------------------------------------

async function verifyCmd(filePath: string): Promise<void> {
  console.log();

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    console.log(`  ${red("!")} Could not read ${filePath}`);
    console.log();
    process.exit(1);
    return; // unreachable — hints to TS that content is assigned above
  }

  const result = await verify(content);

  if (result.valid) {
    const id = result.identity!;
    console.log(`  ${green("+")} Signature ${green("valid")}`);
    console.log();
    console.log(`    motebit_id   ${cyan(id.motebit_id)}`);
    console.log(`    public_key   ${dim(id.identity.public_key.slice(0, 16))}...`);
    console.log(`    trust_mode   ${id.governance.trust_mode}`);
    console.log(`    created      ${dim(id.created_at)}`);

    if (id.devices.length > 0) {
      console.log(`    devices      ${id.devices.length}`);
    }

    console.log();
    process.exit(0);
  } else {
    console.log(`  ${red("!")} Signature ${red("invalid")}`);

    if (result.error) {
      console.log(`    ${dim(result.error)}`);
    }

    console.log();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
  ${bold("create-motebit")} ${dim(`v${VERSION}`)} — Agent identity for the motebit/identity@1.0 standard

  ${bold("Usage:")}

    npm create motebit                Create a signed motebit.md identity file
    npx create-motebit verify [path]  Verify a motebit.md signature

  ${bold("Options:")}

    -o, --output <path>   Output path for identity file ${dim("(default: motebit.md)")}
    -v, --version         Print version
    -h, --help            Print this help

  ${bold("What happens on init:")}

    1. Generates an Ed25519 keypair
    2. Writes a signed motebit.md to your project
    3. Stores the private key in ~/.motebit/keys/ (chmod 600)

  ${dim("https://github.com/motebit/motebit")}
`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Flags
  if (args.includes("-v") || args.includes("--version")) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  // Commands
  const command = args[0];

  if (command === "verify") {
    const filePath = args[1] ?? "motebit.md";
    await verifyCmd(filePath);
    return;
  }

  // Default: init
  // Parse --output / -o
  let outputPath = "motebit.md";
  const outputIdx = args.indexOf("--output");
  const outputShortIdx = args.indexOf("-o");
  const idx = outputIdx !== -1 ? outputIdx : outputShortIdx;
  if (idx !== -1 && args[idx + 1]) {
    outputPath = args[idx + 1]!;
  }

  // Skip "init" if explicitly passed
  await init(outputPath);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${red("Error:")} ${msg}\n`);
  process.exit(1);
});
