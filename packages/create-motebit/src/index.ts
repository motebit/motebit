/**
 * create-motebit — Scaffold a motebit agent project with identity.
 *
 * Usage:
 *   npm create motebit [dir]         # Guided scaffold with identity generation
 *   npm create motebit [dir] --yes   # Non-interactive (uses defaults + env vars)
 *   npx create-motebit verify [path] # Verify an existing motebit.md
 */

import { verify } from "@motebit/verify";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { generateIdentity } from "./generate.js";
import type { TrustMode, EncryptedKey, ServiceIdentityOptions } from "./generate.js";
import { createRL, input, password, select } from "./prompts.js";

// ---------------------------------------------------------------------------
// Constants (injected by tsup at build time — see tsup.config.ts `define`)
// ---------------------------------------------------------------------------

declare const __PKG_VERSION__: string;
declare const __VERIFY_VERSION__: string;

const VERSION = __PKG_VERSION__;

// ---------------------------------------------------------------------------
// Colors (ANSI — disabled if NO_COLOR is set)
// ---------------------------------------------------------------------------

const noColor = "NO_COLOR" in process.env;
const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[22m`);
const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[39m`);
const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[39m`);
const bold = (s: string) => (noColor ? s : `\x1b[1m${s}\x1b[22m`);
const cyan = (s: string) => (noColor ? s : `\x1b[36m${s}\x1b[39m`);
const yellow = (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[39m`);

// ---------------------------------------------------------------------------
// Config directory
// ---------------------------------------------------------------------------

function configDir(): string {
  return process.env["MOTEBIT_CONFIG_DIR"] ?? join(homedir(), ".motebit");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

interface MotebitConfig {
  name?: string;
  motebit_id?: string;
  device_id?: string;
  device_public_key?: string;
  cli_encrypted_key?: EncryptedKey;
  default_provider?: string;
  [key: string]: unknown;
}

function loadConfig(): MotebitConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf-8")) as MotebitConfig;
  } catch {
    return {};
  }
}

function saveConfig(config: MotebitConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Scaffolded file contents
// ---------------------------------------------------------------------------

function makePackageJson(name: string): string {
  const pkg = {
    name,
    private: true,
    type: "module",
    scripts: {
      verify: "npx create-motebit verify motebit.md",
    },
    dependencies: {
      "@motebit/verify": `^${__VERIFY_VERSION__}`,
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function makeVerifyExample(): string {
  return `import { verify } from "@motebit/verify";
import { readFileSync } from "node:fs";

const content = readFileSync("motebit.md", "utf-8");
const result = await verify(content);

if (result.valid) {
  console.log("Identity verified:", result.identity.motebit_id);
  if (result.did) console.log("DID:", result.did);
  console.log("Public key:", result.identity.identity.public_key.slice(0, 16) + "...");
  console.log("Trust mode:", result.identity.governance.trust_mode);
} else {
  console.error("Verification failed:", result.error);
  process.exit(1);
}
`;
}

function makeEnvExample(provider: string): string {
  if (provider === "ollama") {
    return `# AI provider
OLLAMA_HOST=http://localhost:11434

# Anthropic (optional, for cloud fallback)
# ANTHROPIC_API_KEY=your-key-here

# Key passphrase (prompted interactively if not set)
# MOTEBIT_PASSPHRASE=
`;
  }
  return `# AI provider — set at least one
ANTHROPIC_API_KEY=your-key-here

# Local models (optional, instead of Anthropic)
# OLLAMA_HOST=http://localhost:11434

# Key passphrase (prompted interactively if not set)
# MOTEBIT_PASSPHRASE=
`;
}

const GITIGNORE = `node_modules/
.env
*.key
`;

// ---------------------------------------------------------------------------
// guidedScaffold — interactive identity + project creation
// ---------------------------------------------------------------------------

async function guidedScaffold(
  targetDir: string,
  nonInteractive: boolean,
  serviceMode: boolean,
): Promise<void> {
  console.log();
  console.log(`  ${bold("create-motebit")} ${dim(`v${VERSION}`)}`);
  console.log();

  const absDir = resolve(targetDir);
  let dirName = basename(absDir);

  // Check for existing package.json
  const pkgPath = join(absDir, "package.json");
  if (existsSync(pkgPath)) {
    console.log(`  ${red("!")} ${pkgPath} already exists.`);
    console.log(`    Refusing to scaffold over an existing project.`);
    console.log();
    process.exit(1);
  }

  // Gather options — interactive or defaults
  let provider: string;
  let trustMode: TrustMode;
  let passphrase: string;
  let rl: ReturnType<typeof createRL> | null = null;

  if (nonInteractive) {
    provider = "anthropic";
    trustMode = "guarded";
    passphrase = process.env["MOTEBIT_PASSPHRASE"] ?? "";
    if (!passphrase) {
      console.log(`  ${red("!")} --yes requires MOTEBIT_PASSPHRASE environment variable.`);
      console.log();
      process.exit(1);
    }
    // Prompt for project name if scaffolding in "."
    if (targetDir === ".") {
      dirName = "my-motebit";
    }
  } else {
    rl = createRL();

    // Project name (if scaffolding in ".")
    if (targetDir === ".") {
      dirName = await input(rl, "? Project name", "my-motebit");
    }

    // Provider
    provider = await select(rl, "? AI provider", [
      { label: "Anthropic (requires ANTHROPIC_API_KEY)", value: "anthropic" },
      { label: "Ollama (local, no API key)", value: "ollama" },
    ]);
    console.log();

    // Trust mode
    trustMode = await select<TrustMode>(rl, "? Trust mode", [
      { label: `Guarded ${dim("— moderate autonomy (recommended)")}`, value: "guarded" },
      { label: `Minimal ${dim("— lowest autonomy")}`, value: "minimal" },
      { label: `Full ${dim("— maximum autonomy")}`, value: "full" },
    ]);
    console.log();

    // Check for existing identity
    const existingConfig = loadConfig();
    if (existingConfig.motebit_id) {
      console.log(`  ${yellow("!")} Existing identity found: ${dim(existingConfig.motebit_id)}`);
      const overwrite = await select(rl, "  Overwrite with new identity?", [
        { label: "Yes, create new identity", value: true },
        { label: "No, keep existing", value: false },
      ]);
      console.log();
      if (!overwrite) {
        rl.close();
        console.log(`  ${dim("Aborted.")}`);
        console.log();
        process.exit(0);
      }
    }

    // Passphrase
    const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
    if (envPassphrase) {
      passphrase = envPassphrase;
    } else {
      passphrase = await password(rl, "? Set a passphrase for your agent's key: ");
      if (!passphrase) {
        rl.close();
        console.log(`  ${red("!")} Passphrase cannot be empty.`);
        console.log();
        process.exit(1);
      }
      const confirm = await password(rl, "? Confirm passphrase: ");
      if (confirm !== passphrase) {
        rl.close();
        console.log(`  ${red("!")} Passphrases do not match.`);
        console.log();
        process.exit(1);
      }
    }

    rl.close();
  }

  // Gather service fields if --service
  let serviceOpts: ServiceIdentityOptions | undefined;
  if (serviceMode && !nonInteractive) {
    const rl2 = createRL();
    console.log(`  ${bold("Service identity")}`);
    console.log();

    const serviceName = await input(rl2, "? Service name");
    if (!serviceName) {
      rl2.close();
      console.log(`  ${red("!")} Service name is required with --service.`);
      console.log();
      process.exit(1);
    }

    const serviceDescription = await input(rl2, "? Service description");
    if (!serviceDescription) {
      rl2.close();
      console.log(`  ${red("!")} Service description is required with --service.`);
      console.log();
      process.exit(1);
    }

    const capabilitiesRaw = await input(rl2, "? Capabilities (comma-separated)");
    const capabilities = capabilitiesRaw
      ? capabilitiesRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const serviceUrl = await input(rl2, "? Service URL (optional)");

    rl2.close();
    console.log();

    serviceOpts = {
      type: "service",
      service_name: serviceName,
      service_description: serviceDescription,
      capabilities: capabilities.length > 0 ? capabilities : undefined,
      service_url: serviceUrl || undefined,
    };
  } else if (serviceMode && nonInteractive) {
    // Non-interactive service mode: use env vars or defaults
    const serviceName = process.env["MOTEBIT_SERVICE_NAME"];
    const serviceDescription = process.env["MOTEBIT_SERVICE_DESCRIPTION"];
    if (!serviceName || !serviceDescription) {
      console.log(
        `  ${red("!")} --service with --yes requires MOTEBIT_SERVICE_NAME and MOTEBIT_SERVICE_DESCRIPTION env vars.`,
      );
      console.log();
      process.exit(1);
    }
    const capabilitiesRaw = process.env["MOTEBIT_SERVICE_CAPABILITIES"];
    const capabilities = capabilitiesRaw
      ? capabilitiesRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    serviceOpts = {
      type: "service",
      service_name: serviceName,
      service_description: serviceDescription,
      capabilities: capabilities.length > 0 ? capabilities : undefined,
      service_url: process.env["MOTEBIT_SERVICE_URL"] || undefined,
    };
  }

  // Generate identity
  console.log(`  Generating Ed25519 keypair...`);
  const result = await generateIdentity({
    name: dirName,
    trustMode,
    passphrase,
    service: serviceOpts,
  });
  console.log(`  Signing identity file...`);

  // Create directory if needed
  mkdirSync(absDir, { recursive: true });

  // Write project files
  writeFileSync(pkgPath, makePackageJson(dirName), "utf-8");
  writeFileSync(join(absDir, ".env.example"), makeEnvExample(provider), "utf-8");
  writeFileSync(join(absDir, ".gitignore"), GITIGNORE, "utf-8");
  writeFileSync(join(absDir, "motebit.md"), result.identityFileContent, "utf-8");
  writeFileSync(join(absDir, "verify.js"), makeVerifyExample(), "utf-8");

  // Save identity to config (merge with existing)
  const config = loadConfig();
  config.name = dirName;
  config.motebit_id = result.motebitId;
  config.device_id = result.deviceId;
  config.device_public_key = result.publicKeyHex;
  config.cli_encrypted_key = result.encryptedKey;
  config.default_provider = provider;
  saveConfig(config);

  // Output
  const relDir = targetDir === "." ? `./${dirName}` : `./${dirName}`;
  console.log();
  console.log(`  ${green("+")} Created ${bold(relDir)}`);
  console.log();
  console.log(`    motebit.md         ${dim("Signed agent identity")}`);
  console.log(`    verify.js          ${dim("Verification example")}`);
  console.log(`    package.json       ${dim("Node project")}`);
  console.log(`    .env.example       ${dim("Environment variable template")}`);
  console.log(`    .gitignore         ${dim("Secrets excluded")}`);
  console.log();
  console.log(`  Identity stored in ${dim(configPath())}`);
  console.log(`  Motebit ID: ${cyan(result.motebitId)}`);
  const verifyResult = await verify(result.identityFileContent);
  if (verifyResult.did) {
    console.log(`  DID:        ${dim(verifyResult.did)}`);
  }
  console.log();
  console.log(`  ${bold("Next steps:")}`);
  console.log();
  if (targetDir !== ".") {
    console.log(`    cd ${dirName}`);
  }
  console.log(`    npm install`);
  console.log(`    node verify.js                     ${dim("# Verify your identity")}`);
  console.log(`    npx create-motebit verify           ${dim("# Or use the CLI verifier")}`);
  console.log();
  console.log(`  Full agent:  ${cyan("npm install -g motebit")}`);
  console.log(`  Learn more:  ${dim("https://docs.motebit.com")}`);
  console.log();
  console.log(`  ${bold("What your agent can do:")}`);
  console.log();
  console.log(
    `    ${dim("Credentials")}   Earns verifiable credentials (gradient, reputation, trust)`,
  );
  console.log(`    ${dim("Delegation")}    Submits tasks to other agents with signed receipts`);
  console.log(`    ${dim("Ledger")}        Signed execution audit trail for every goal`);
  console.log(`    ${dim("Budget")}        Economic layer for delegated task settlement`);
  console.log();
  console.log(`  ${bold("Useful commands:")}`);
  console.log();
  console.log(`    motebit credentials                ${dim("# View earned credentials")}`);
  console.log(
    `    motebit credentials --presentation  ${dim("# Generate verifiable presentation")}`,
  );
  console.log(
    `    motebit export                     ${dim("# Export full bundle (identity, credentials, budget, gradient)")}`,
  );
  console.log(`    motebit verify <bundle-dir>        ${dim("# Verify an exported bundle")}`);
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
    if (result.did) {
      console.log(`    did          ${dim(result.did)}`);
    }
    console.log(`    public_key   ${dim(id.identity.public_key.slice(0, 16))}...`);
    console.log(`    trust_mode   ${id.governance.trust_mode}`);
    console.log(`    created      ${dim(id.created_at)}`);

    if (id.type) {
      console.log(`    type         ${id.type}`);
    }
    if (id.service_name) {
      console.log(`    service      ${id.service_name}`);
    }
    if (id.capabilities && id.capabilities.length > 0) {
      console.log(`    capabilities ${id.capabilities.join(", ")}`);
    }

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
  ${bold("create-motebit")} ${dim(`v${VERSION}`)} — Scaffold a motebit agent project

  ${bold("Usage:")}

    npm create motebit [dir]          Guided scaffold with identity generation
    npm create motebit [dir] --yes    Non-interactive (defaults + MOTEBIT_PASSPHRASE)
    npx create-motebit verify [path]  Verify a motebit.md signature

  ${bold("Options:")}

    -y, --yes             Non-interactive mode (requires MOTEBIT_PASSPHRASE env var)
    --service             Create a service motebit identity (prompts for service fields)
    -v, --version         Print version
    -h, --help            Print this help

  ${bold("What happens on scaffold:")}

    1. Generates an Ed25519 keypair and signs a motebit.md identity file
    2. Encrypts your private key and stores it in ~/.motebit/config.json
    3. Scaffolds a project directory with verify.js, package.json, .env.example
    4. Run ${cyan("node verify.js")} to verify your identity

  ${bold("Environment variables:")}

    MOTEBIT_PASSPHRASE    Passphrase for key encryption (required with --yes)
    MOTEBIT_CONFIG_DIR    Override config directory (default: ~/.motebit)

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
  const positional = args.filter((a) => !a.startsWith("-"));
  const command = positional[0];

  if (command === "verify") {
    const filePath = positional[1] ?? "motebit.md";
    await verifyCmd(filePath);
    return;
  }

  // Default: guided scaffold
  const nonInteractive = args.includes("-y") || args.includes("--yes");
  const serviceMode = args.includes("--service");
  const targetDir = command ?? ".";
  await guidedScaffold(targetDir, nonInteractive, serviceMode);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${red("Error:")} ${msg}\n`);
  process.exit(1);
});
