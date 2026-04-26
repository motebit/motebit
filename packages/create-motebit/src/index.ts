/**
 * create-motebit — Scaffold a motebit agent project with identity.
 *
 * Usage:
 *   npm create motebit [dir]         # Guided scaffold with identity generation
 *   npm create motebit [dir] --yes   # Non-interactive (uses defaults + env vars)
 *   npx create-motebit verify [path] # Verify an existing motebit.md
 */

import { verify } from "@motebit/crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { generateIdentity, regenerateIdentityFile, decryptPrivateKey } from "./generate.js";
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

/**
 * Refuse to clobber an existing identity in the non-interactive path.
 *
 * `--yes` mode is what CI smokes, automation, and "I just want to try it"
 * users hit. Without this gate, running `npx create-motebit my-agent --yes`
 * on a developer machine that already has a motebit silently rewrites
 * `~/.motebit/config.json` to point at the throwaway scaffold identity —
 * a data-loss-class bug that the interactive path already prompts about
 * (see guidedScaffold's "Existing identity found" prompt).
 *
 * The gate fires only when:
 *   - non-interactive mode is in use (interactive prompts the user instead)
 *   - an existing config has a populated `motebit_id`
 *   - `--force` was not passed (explicit consent overrides)
 *
 * Error message names both escape hatches: `MOTEBIT_CONFIG_DIR` for
 * isolated smoke tests, and `--force` for explicit replacement.
 */
function assertNoExistingIdentity(force: boolean): void {
  if (force) return;
  const existing = loadConfig();
  if (!existing.motebit_id) return;

  console.log();
  console.log(`  ${red("!")} An existing motebit identity is present at ${dim(configPath())}`);
  console.log(`    motebit_id: ${dim(existing.motebit_id)}`);
  console.log();
  console.log(`    Refusing to overwrite without explicit consent.`);
  console.log();
  console.log(`    To run an isolated scaffold (recommended for smoke tests):`);
  console.log(`      ${dim("MOTEBIT_CONFIG_DIR=/tmp/my-test npx create-motebit ...")}`);
  console.log();
  console.log(`    To intentionally replace the existing identity:`);
  console.log(`      ${dim("npx create-motebit ... --force")}`);
  console.log();
  process.exit(1);
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
      "@motebit/crypto": `^${__VERIFY_VERSION__}`,
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function makeVerifyExample(): string {
  return `import { verify } from "@motebit/crypto";
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
      // start expects a prior build; the dev / self-test paths build first.
      // If `npm start` is run on a clean checkout it'll bail with "Cannot
      // find module dist/index.js" — that's a clear-enough error that a
      // build-then-start dance isn't worth scripting in here.
      start: "node dist/index.js",
      dev: "tsc && node dist/index.js",
      verify: "npx -p @motebit/verify motebit-verify motebit.md",
      "self-test": "tsc && node dist/index.js --self-test",
    },
    dependencies: {
      "@motebit/sdk": `^${__VERIFY_VERSION__}`,
      motebit: `^${__VERIFY_VERSION__}`,
    },
    devDependencies: {
      // @types/node is required for the `node:fs`/`node:path`/
      // `node:child_process` imports in src/index.ts. Without it `npm run
      // build` fails immediately with TS2307 — the scaffold has to bring
      // its own type packages because workspace-resolution doesn't carry
      // them across an npx-installed scaffold target.
      "@types/node": "^22.0.0",
      typescript: "^5.7.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function makeAgentTools(name: string): string {
  const sdk = "@motebit/sdk";
  return `import type { ToolDefinition, ToolResult } from "${sdk}";

/**
 * ${name} — tool definitions.
 *
 * Each tool has a definition (name, description, input schema) and a handler.
 * The handler receives validated arguments and returns a result.
 *
 * These tools are what your agent CAN DO. Other agents on the network
 * discover your capabilities via the relay and delegate tasks to you.
 * The tool names become your agent's advertised capabilities.
 *
 * Add your own tools below. Remove the examples when you're ready.
 */

export type ToolEntry = {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const tools: ToolEntry[] = [
  // --- Example: a tool that fetches a URL and returns the text ---
  {
    definition: {
      name: "fetch_url",
      description: "Fetch a URL and return its text content.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
        },
        required: ["url"],
      },
    },
    handler: async (args) => {
      const url = String(args.url ?? "");
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "${name}/0.1.0" },
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        return { ok: true, data: text.slice(0, 50_000) };
      } catch (err) {
        return { ok: false, data: err instanceof Error ? err.message : String(err) };
      }
    },
  },

  // --- Example: a tool that echoes input (useful for testing) ---
  {
    definition: {
      name: "echo",
      description: "Echo the input text back. Useful for verifying the agent loop works.",
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

function makeAgentEntrypoint(name: string): string {
  return `#!/usr/bin/env node
/**
 * ${name} — agent entrypoint.
 *
 * Starts the agent as an MCP server that accepts tasks from the relay.
 * Other agents discover your capabilities and delegate work to you.
 * Every completed task earns a signed receipt and trust credential.
 *
 * Usage:
 *   npm run dev          # Build + start (development)
 *   npm start            # Start from built dist/
 *   npm run self-test    # Start + run self-delegation test
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tools from "./tools.js";

// Load the identity file
const identityPath = resolve("motebit.md");
const identity = readFileSync(identityPath, "utf-8");

// Build the tool definitions for the CLI serve command
const toolDefs = tools.map((t) => ({
  definition: t.definition,
  handler: t.handler,
}));

// Export for motebit serve --tools
export default toolDefs;

// Main-module guard.
//
// \`motebit serve --tools <path>\` re-imports this same file to discover
// the tool definitions. Without this guard, that re-import re-executes
// the spawn block below and recursively spawns another \`motebit serve\`,
// which re-imports again, forever. The guard makes module-level side
// effects fire only when this file is executed directly (npm run dev,
// node dist/index.js).
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const args = process.argv.slice(2);
  const selfTest = args.includes("--self-test");
  const port = process.env["PORT"] ?? "3100";

  const serveArgs = [
    "serve",
    "--identity", identityPath,
    "--tools", fileURLToPath(import.meta.url),
    "--serve-transport", "http",
    "--serve-port", port,
    "--direct",
  ];
  if (selfTest) serveArgs.push("--self-test");

  // Dynamic import to avoid bundling the full CLI.
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("npx", ["motebit", ...serveArgs], {
      stdio: "inherit",
      env: { ...process.env },
    });
  } catch {
    process.exit(1);
  }
}
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
  return `# Relay URL — defaults to the public relay if unset.
# Override to point at your own relay or a federation peer.
MOTEBIT_SYNC_URL=https://relay.motebit.com

# API token — only required to accept paid tasks.
# Anonymous agents can register and serve for free.
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

async function agentScaffold(
  targetDir: string,
  nonInteractive: boolean,
  force: boolean,
): Promise<void> {
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
    // Same identity-clobber gate as guidedScaffold. The agent path also
    // saves config (line ~447) and would silently rewrite an existing
    // motebit's identity without this check.
    assertNoExistingIdentity(force);
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
  writeFileSync(join(absDir, "src", "index.ts"), makeAgentEntrypoint(agentName), "utf-8");
  writeFileSync(join(absDir, "src", "tools.ts"), makeAgentTools(agentName), "utf-8");
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
  console.log(`    motebit.md         ${dim("Signed identity — who your agent is")}`);
  console.log(`    src/index.ts       ${dim("Entrypoint — starts the agent server")}`);
  console.log(`    src/tools.ts       ${dim("Tools — what your agent can do")}`);
  console.log(`    tsconfig.json      ${dim("TypeScript config")}`);
  console.log(`    package.json       ${dim("Scripts: dev, start, self-test, verify")}`);
  console.log(`    .env.example       ${dim("Relay URL + API token")}`);
  console.log();
  console.log(`  Motebit ID: ${cyan(result.motebitId)}`);
  console.log();
  console.log(`  ${bold("Next steps:")}`);
  console.log();
  if (targetDir !== ".") {
    console.log(`    cd ${dirName}`);
  }
  console.log(`    npm install`);
  console.log(`    cp .env.example .env     ${dim("# add your relay URL and API token")}`);
  console.log(`    npm run dev              ${dim("# build + start the agent")}`);
  console.log();
  console.log(`  ${bold("Your agent is a body, not a document.")}`);
  console.log(`  Edit ${cyan("src/tools.ts")} to give it hands.`);
  console.log();
}

// ---------------------------------------------------------------------------
// guidedScaffold — interactive identity + project creation
// ---------------------------------------------------------------------------

async function guidedScaffold(
  targetDir: string,
  nonInteractive: boolean,
  serviceMode: boolean,
  force: boolean,
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
    // Identity-clobber gate. Interactive mode prompts; --yes mode must
    // refuse-or-force to avoid silent data loss when run on a developer
    // machine with an existing motebit.
    assertNoExistingIdentity(force);
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
    } else if (
      existingConfig.cli_encrypted_key &&
      existingConfig.device_public_key &&
      existingConfig.device_id
    ) {
      // No motebit.md on disk — regenerate from encrypted key
      console.log(`  ${dim("Regenerating identity file from existing key...")}`);
      const regenRl = createRL();
      const regenPassphrase = await password(
        regenRl,
        "? Enter your passphrase to regenerate motebit.md: ",
      );
      regenRl.close();
      if (regenPassphrase) {
        try {
          const privateKeyHex = await decryptPrivateKey(
            existingConfig.cli_encrypted_key,
            regenPassphrase,
          );
          identityFileContent = await regenerateIdentityFile({
            motebitId: existingConfig.motebit_id,
            deviceId: existingConfig.device_id,
            name: dirName,
            publicKeyHex: existingConfig.device_public_key,
            privateKeyHex,
            trustMode,
          });
          // Persist for future reuse
          writeFileSync(existingMd, identityFileContent, "utf-8");
        } catch {
          console.log(`  ${yellow("!")} Could not decrypt key — motebit.md will be omitted.`);
          console.log(
            `    Run ${dim("npx create-motebit rotate")} to regenerate your identity file.`,
          );
        }
      }
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
    const verifyResult = await verify(identityFileContent, { expectedType: "identity" });
    if (verifyResult.type === "identity" && verifyResult.did) {
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
  console.log(
    `    node verify.js                                          ${dim("# Verify your identity")}`,
  );
  console.log(
    `    npx -p @motebit/verify motebit-verify motebit.md        ${dim("# Same check via the canonical CLI verifier")}`,
  );
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

  const result = await verify(content, { expectedType: "identity" });

  if (result.type === "identity" && result.valid) {
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

    const errorMessage = result.errors?.[0]?.message;
    if (errorMessage) {
      console.log(`    ${dim(errorMessage)}`);
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

  const verifyResult = await verify(content, { expectedType: "identity" });
  if (!verifyResult.valid) {
    const errorMessage = verifyResult.errors?.[0]?.message ?? "unknown error";
    console.log(`  ${red("!")} Identity file is invalid: ${errorMessage}`);
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
  const reVerify = await verify(result.identityFileContent, { expectedType: "identity" });
  if (!reVerify.valid) {
    const errorMessage = reVerify.errors?.[0]?.message ?? "unknown error";
    console.log(`  ${red("!")} Post-rotation verification failed: ${errorMessage}`);
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
    --force               Replace an existing identity in MOTEBIT_CONFIG_DIR (use with --yes;
                          interactive mode prompts instead)
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
  const force = args.includes("--force");
  const targetDir = command ?? ".";

  if (agentMode) {
    await agentScaffold(targetDir, nonInteractive, force);
  } else {
    await guidedScaffold(targetDir, nonInteractive, serviceMode, force);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${red("Error:")} ${msg}\n`);
  process.exit(1);
});
