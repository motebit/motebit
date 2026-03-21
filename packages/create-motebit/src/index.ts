/**
 * create-motebit — Scaffold a motebit agent project with identity.
 *
 * Usage:
 *   npm create motebit [dir]         # Guided scaffold with identity generation
 *   npm create motebit [dir] --yes   # Non-interactive (uses defaults + env vars)
 *   npx create-motebit verify [path] # Verify an existing motebit.md
 */

import { verifyIdentityFile } from "@motebit/verify";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { generateIdentity } from "./generate.js";
import type { TrustMode, EncryptedKey, ServiceIdentityOptions } from "./generate.js";
import { rotateKey } from "./rotate.js";
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

const AGENT_GITIGNORE = `node_modules/
.env
*.key
dist/
`;

function makeAgentPackageJson(name: string): string {
  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      build: "tsc",
      dev: "tsc && npx motebit serve --identity ./motebit.md --tools ./dist/tools.js --serve-transport http --direct",
      start:
        "npx motebit serve --identity ./motebit.md --tools ./dist/tools.js --serve-transport http --direct --self-test",
    },
    dependencies: {
      "@motebit/sdk": "^0.3.0",
    },
    devDependencies: {
      motebit: "^0.3.0",
      typescript: "^5.7.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function makeAgentTools(): string {
  const sdk = "@motebit/sdk";
  return `import type { ToolDefinition, ToolResult } from "${sdk}";

type ToolEntry = {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const tools: ToolEntry[] = [
  {
    definition: {
      name: "echo",
      description: "Echo the input text back. A minimal working tool to prove the agent loop.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to echo back" },
        },
        required: ["text"],
      },
    },
    handler: async (args) => ({
      ok: true,
      data: String(args.text ?? ""),
    }),
  },
];

export default tools;
`;
}

function makeAgentTsconfig(): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      outDir: "dist",
      rootDir: "src",
      strict: true,
      declaration: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src"],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

function makeAgentEnvExample(): string {
  return `# Relay connection (required for network participation)
MOTEBIT_SYNC_URL=https://motebit-sync.fly.dev
MOTEBIT_API_TOKEN=

# Identity passphrase (set during creation)
MOTEBIT_PASSPHRASE=

# Optional: AI provider (for non-direct mode)
# ANTHROPIC_API_KEY=sk-ant-...
`;
}

// ---------------------------------------------------------------------------
// guidedScaffold — interactive identity + project creation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// agentScaffold — generate a runnable agent project
// ---------------------------------------------------------------------------

async function agentScaffold(targetDir: string, nonInteractive: boolean): Promise<void> {
  console.log();
  console.log(`  ${bold("create-motebit")} ${dim(`v${VERSION}`)} ${dim("--agent")}`);
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

  // Gather options
  let passphrase: string;
  let agentName: string;
  let agentDescription: string;

  if (nonInteractive) {
    passphrase = process.env["MOTEBIT_PASSPHRASE"] ?? "";
    if (!passphrase) {
      console.log(`  ${red("!")} --yes requires MOTEBIT_PASSPHRASE environment variable.`);
      console.log();
      process.exit(1);
    }
    agentName = process.env["MOTEBIT_SERVICE_NAME"] ?? dirName;
    agentDescription = process.env["MOTEBIT_SERVICE_DESCRIPTION"] ?? `${dirName} agent`;
    if (targetDir === ".") dirName = "my-agent";
  } else {
    const rl = createRL();

    if (targetDir === ".") {
      dirName = await input(rl, "? Agent name", "my-agent");
    }
    agentName = await input(rl, "? Agent name (for identity)", dirName);
    agentDescription = await input(rl, "? Agent description", `${agentName} agent`);

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

  // Generate service identity
  console.log(`  Generating Ed25519 keypair...`);
  const result = await generateIdentity({
    name: dirName,
    trustMode: "guarded",
    passphrase,
    service: {
      type: "service",
      service_name: agentName,
      service_description: agentDescription,
    },
  });
  console.log(`  Signing identity file...`);

  // Create directory and files
  mkdirSync(absDir, { recursive: true });
  mkdirSync(join(absDir, "src"), { recursive: true });

  writeFileSync(pkgPath, makeAgentPackageJson(dirName), "utf-8");
  writeFileSync(join(absDir, "tsconfig.json"), makeAgentTsconfig(), "utf-8");
  writeFileSync(join(absDir, "src", "tools.ts"), makeAgentTools(), "utf-8");
  writeFileSync(join(absDir, ".env.example"), makeAgentEnvExample(), "utf-8");
  writeFileSync(join(absDir, ".gitignore"), AGENT_GITIGNORE, "utf-8");
  writeFileSync(join(absDir, "motebit.md"), result.identityFileContent, "utf-8");

  // Save identity to config
  const config = loadConfig();
  config.name = dirName;
  config.motebit_id = result.motebitId;
  config.device_id = result.deviceId;
  config.device_public_key = result.publicKeyHex;
  config.cli_encrypted_key = result.encryptedKey;
  saveConfig(config);

  // Output
  const relDir = targetDir === "." ? "." : `./${dirName}`;
  console.log();
  console.log(`  ${green("+")} Agent created: ${bold(relDir)}`);
  console.log();
  console.log(`    motebit.md         ${dim("Signed agent identity")}`);
  console.log(`    src/tools.ts       ${dim("Tool definitions (edit this)")}`);
  console.log(`    tsconfig.json      ${dim("TypeScript config")}`);
  console.log(`    package.json       ${dim("Node project with dev/start scripts")}`);
  console.log(`    .env.example       ${dim("Environment variable template")}`);
  console.log(`    .gitignore         ${dim("Secrets + dist excluded")}`);
  console.log();
  console.log(`  Motebit ID: ${cyan(result.motebitId)}`);
  console.log();
  console.log(`  ${bold("Next steps:")}`);
  console.log();
  if (targetDir !== ".") {
    console.log(`    cd ${dirName}`);
  }
  console.log(`    npm install`);
  console.log(`    cp .env.example .env   ${dim("# set MOTEBIT_SYNC_URL and MOTEBIT_API_TOKEN")}`);
  console.log(`    npm run dev`);
  console.log();
  console.log(`  Edit ${cyan("src/tools.ts")} to add your own tools.`);
  console.log();
}

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
  let reuseExisting = false;
  let existingConfig = loadConfig();

  if (nonInteractive) {
    provider = "anthropic";
    trustMode = "guarded";
    passphrase = process.env["MOTEBIT_PASSPHRASE"] ?? "";
    if (!passphrase) {
      console.log(`  ${red("!")} --yes requires MOTEBIT_PASSPHRASE environment variable.`);
      console.log(
        `    Set it: ${dim("MOTEBIT_PASSPHRASE=your-passphrase npx create-motebit --yes")}`,
      );
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
    existingConfig = loadConfig();
    if (existingConfig.motebit_id) {
      console.log(`  ${yellow("!")} Existing identity found: ${dim(existingConfig.motebit_id)}`);
      const overwrite = await select(rl, "  Overwrite with new identity?", [
        { label: "Yes, create new identity", value: true },
        { label: "No, keep existing", value: false },
      ]);
      console.log();
      reuseExisting = !overwrite;
    }

    // Passphrase (skip if reusing existing identity)
    if (reuseExisting) {
      passphrase = ""; // not needed — identity already generated
    } else {
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

  // Create directory if needed
  mkdirSync(absDir, { recursive: true });

  // Generate or reuse identity
  let motebitId: string;
  let identityFileContent: string | null = null;

  if (reuseExisting && existingConfig.motebit_id) {
    // Reuse existing identity — scaffold project files without regenerating keypair
    motebitId = existingConfig.motebit_id;
    console.log(`  Using existing identity: ${dim(motebitId)}`);

    // Copy existing motebit.md into the new project
    const existingMd = join(configDir(), "motebit.md");
    if (existsSync(existingMd)) {
      identityFileContent = readFileSync(existingMd, "utf-8");
    } else {
      // Identity was created before motebit.md was persisted to config dir.
      // Regenerate it if we have the encrypted key — requires passphrase.
      console.log(`  ${yellow("!")} No motebit.md found in ${dim(configDir())}`);
      console.log(`    Run ${dim("npx create-motebit rotate")} to regenerate your identity file.`);
    }

    // Update config with project name and provider
    existingConfig.name = dirName;
    existingConfig.default_provider = provider;
    saveConfig(existingConfig);
  } else {
    console.log(`  Generating Ed25519 keypair...`);
    const result = await generateIdentity({
      name: dirName,
      trustMode,
      passphrase,
      service: serviceOpts,
    });
    console.log(`  Signing identity file...`);

    motebitId = result.motebitId;
    identityFileContent = result.identityFileContent;

    // Save identity to config (merge with existing)
    const config = loadConfig();
    config.name = dirName;
    config.motebit_id = result.motebitId;
    config.device_id = result.deviceId;
    config.device_public_key = result.publicKeyHex;
    config.cli_encrypted_key = result.encryptedKey;
    config.default_provider = provider;
    saveConfig(config);

    // Persist motebit.md to config dir so "keep existing" can reuse it
    writeFileSync(join(configDir(), "motebit.md"), result.identityFileContent, "utf-8");
  }

  // Write project files
  writeFileSync(pkgPath, makePackageJson(dirName), "utf-8");
  writeFileSync(join(absDir, ".env.example"), makeEnvExample(provider), "utf-8");
  writeFileSync(join(absDir, ".gitignore"), GITIGNORE, "utf-8");
  if (identityFileContent) {
    writeFileSync(join(absDir, "motebit.md"), identityFileContent, "utf-8");
  }
  writeFileSync(join(absDir, "verify.js"), makeVerifyExample(), "utf-8");

  // Output
  const relDir = targetDir === "." ? "." : `./${dirName}`;
  console.log();
  console.log(`  ${green("+")} Created ${bold(relDir)}`);
  console.log();
  if (identityFileContent) {
    console.log(`    motebit.md         ${dim("Signed agent identity")}`);
  }
  console.log(`    verify.js          ${dim("Verification example")}`);
  console.log(`    package.json       ${dim("Node project")}`);
  console.log(`    .env.example       ${dim("Environment variable template")}`);
  console.log(`    .gitignore         ${dim("Secrets excluded")}`);
  console.log();
  console.log(`  Identity stored in ${dim(configPath())}`);
  console.log(`  Motebit ID: ${cyan(motebitId)}`);
  if (identityFileContent) {
    const verifyResult = await verifyIdentityFile(identityFileContent);
    if (verifyResult.did) {
      console.log(`  DID:        ${dim(verifyResult.did)}`);
    }
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

  const result = await verifyIdentityFile(content);

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
// rotate command
// ---------------------------------------------------------------------------

async function rotateCmd(
  filePath: string,
  nonInteractive: boolean,
  reason?: string,
): Promise<void> {
  console.log();

  // 1. Read and verify the existing identity file
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    console.log(`  ${red("!")} Could not read ${filePath}`);
    console.log();
    process.exit(1);
    return;
  }

  const verifyResult = await verifyIdentityFile(content);
  if (!verifyResult.valid) {
    console.log(`  ${red("!")} Identity file is invalid: ${verifyResult.error}`);
    console.log();
    process.exit(1);
    return;
  }

  // 2. Load config to get encrypted private key
  const config = loadConfig();
  if (!config.cli_encrypted_key) {
    console.log(`  ${red("!")} No encrypted key found in ${configPath()}`);
    console.log(`    The config must contain cli_encrypted_key from the original scaffold.`);
    console.log();
    process.exit(1);
    return;
  }

  // 3. Get the current passphrase
  let oldPassphrase: string;
  let newPassphrase: string;

  if (nonInteractive) {
    oldPassphrase = process.env["MOTEBIT_PASSPHRASE"] ?? "";
    if (!oldPassphrase) {
      console.log(`  ${red("!")} --yes requires MOTEBIT_PASSPHRASE environment variable.`);
      console.log(
        `    Set it: ${dim("MOTEBIT_PASSPHRASE=your-passphrase npx create-motebit --yes")}`,
      );
      console.log();
      process.exit(1);
      return;
    }
    newPassphrase = oldPassphrase; // reuse with --yes
  } else {
    const rl = createRL();
    oldPassphrase = await password(rl, "? Current passphrase: ");
    if (!oldPassphrase) {
      rl.close();
      console.log(`  ${red("!")} Passphrase cannot be empty.`);
      console.log();
      process.exit(1);
      return;
    }

    newPassphrase = await password(rl, "? New passphrase (Enter to reuse current): ");
    if (!newPassphrase) {
      newPassphrase = oldPassphrase;
    } else {
      const confirm = await password(rl, "? Confirm new passphrase: ");
      if (confirm !== newPassphrase) {
        rl.close();
        console.log(`  ${red("!")} Passphrases do not match.`);
        console.log();
        process.exit(1);
        return;
      }
    }
    rl.close();
  }

  // 4. Perform the rotation
  console.log(`  Generating new Ed25519 keypair...`);

  let result;
  try {
    result = await rotateKey({
      identityFileContent: content,
      encryptedOldKey: config.cli_encrypted_key,
      oldPassphrase,
      newPassphrase,
      reason,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      msg.includes("operation-specific") ||
      msg.includes("OperationError") ||
      msg.includes("decrypt")
        ? "\n    Hint: wrong passphrase or corrupted key in config."
        : "";
    console.log(`  ${red("!")} Rotation failed: ${msg}${hint}`);
    console.log();
    process.exit(1);
    return;
  }

  // 5. Backup then write updated identity file
  const backupPath = `${filePath}.backup`;
  writeFileSync(backupPath, content, "utf-8");
  writeFileSync(filePath, result.identityFileContent, "utf-8");

  // 6. Update config
  config.device_public_key = result.newPublicKeyHex;
  config.cli_encrypted_key = result.newEncryptedKey;
  saveConfig(config);

  // 7. Verify the updated file
  const reVerify = await verifyIdentityFile(result.identityFileContent);
  if (!reVerify.valid) {
    console.log(`  ${red("!")} Post-rotation verification failed: ${reVerify.error}`);
    console.log(`    The identity file may be corrupted. Restore from: ${backupPath}`);
    console.log();
    process.exit(1);
    return;
  }

  // 8. Display summary
  console.log(`  Signing identity file...`);
  console.log();
  console.log(`  ${green("+")} Key rotated successfully`);
  console.log();
  console.log(`    old key    ${dim(result.oldPublicKeyHex.slice(0, 16))}...`);
  console.log(`    new key    ${dim(result.newPublicKeyHex.slice(0, 16))}...`);
  console.log(`    rotations  ${result.rotationCount}`);
  if (reason) {
    console.log(`    reason     ${dim(reason)}`);
  }
  console.log();
  console.log(`  Identity file updated: ${dim(filePath)}`);
  console.log(`  Backup saved:          ${dim(backupPath)}`);
  console.log(`  Config updated:        ${dim(configPath())}`);
  console.log();
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
    npx create-motebit rotate [path]  Rotate the key in a motebit.md identity file

  ${bold("Options:")}

    -y, --yes             Non-interactive mode (requires MOTEBIT_PASSPHRASE env var)
    --agent               Create a runnable agent project (tools.ts + MCP server)
    --service             Create a service motebit identity (prompts for service fields)
    --reason "..."        Reason for key rotation (used with rotate)
    -v, --version         Print version
    -h, --help            Print this help

  ${bold("What happens on scaffold:")}

    1. Generates an Ed25519 keypair and signs a motebit.md identity file
    2. Encrypts your private key and stores it in ~/.motebit/config.json
    3. Scaffolds a project directory with verify.js, package.json, .env.example
    4. Run ${cyan("node verify.js")} to verify your identity

  ${bold("What happens on rotate:")}

    1. Verifies the existing motebit.md signature
    2. Decrypts the old private key from ~/.motebit/config.json
    3. Generates a new Ed25519 keypair
    4. Creates a dual-signed succession record (old + new key)
    5. Re-signs the identity file with the new key
    6. Updates config with the new encrypted key

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

  const nonInteractive = args.includes("-y") || args.includes("--yes");

  if (command === "verify") {
    const filePath = positional[1] ?? "motebit.md";
    await verifyCmd(filePath);
    return;
  }

  if (command === "rotate") {
    const filePath = positional[1] ?? "motebit.md";
    // Parse --reason flag
    const reasonIdx = args.indexOf("--reason");
    const reason =
      reasonIdx !== -1 && reasonIdx + 1 < args.length ? args[reasonIdx + 1] : undefined;
    await rotateCmd(filePath, nonInteractive, reason);
    return;
  }

  // Default: guided scaffold
  const agentMode = args.includes("--agent");
  const serviceMode = args.includes("--service");
  const targetDir = command ?? ".";

  if (agentMode) {
    await agentScaffold(targetDir, nonInteractive);
  } else {
    await guidedScaffold(targetDir, nonInteractive, serviceMode);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${red("Error:")} ${msg}\n`);
  process.exit(1);
});
