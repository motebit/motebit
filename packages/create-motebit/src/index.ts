/**
 * create-motebit — Scaffold a motebit agent project with identity.
 *
 * Usage:
 *   npm create motebit [dir]         # Guided scaffold with identity generation
 *   npm create motebit [dir] --yes   # Non-interactive (uses defaults + env vars)
 *   npx create-motebit verify [path] # Verify an existing motebit.md
 */

import { verify } from "@motebit/crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import {
  CONFIG_BACKUP_INFIX,
  ConfigDamagedError,
  identityFingerprint,
  isTrulyAbsent,
  moveAside,
  pendingRotationPathIn,
  readConfigFile,
  replaceIdentityFile,
  withFileLock,
  writeConfigFile,
} from "./config-file.js";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { generateIdentity, regenerateIdentityFile, decryptPrivateKey } from "./generate.js";
import type { TrustMode, EncryptedKey, ServiceIdentityOptions } from "./generate.js";
import { rotateKey } from "./rotate.js";
import { commitRotation, finishRotationCommand, RotationCommitError } from "./rotate-commit.js";
import { createRL, input, password, select } from "./prompts.js";

// ---------------------------------------------------------------------------
// Constants (injected by tsup at build time — see tsup.config.ts `define`)
// ---------------------------------------------------------------------------

declare const __PKG_VERSION__: string;
declare const __CRYPTO_VERSION__: string;
declare const __SDK_VERSION__: string;
declare const __MOTEBIT_VERSION__: string;

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

/**
 * Absent ⇒ `{}`; damaged ⇒ throws `ConfigDamagedError` (see config-file.ts).
 * Reading damage as `{}` mattered twice over here: the clobber guard below
 * decides from `motebit_id` alone, so an unreadable config looked like a
 * fresh machine and was replaced.
 */
function loadConfig(): MotebitConfig {
  return readConfigFile<MotebitConfig>(configPath());
}

/**
 * The guided scaffold's read — EVERY read it makes goes through here. A
 * damaged config refuses the scaffold unless `--force` was given; with it,
 * the scaffold proceeds from `{}` and the save preserves the damaged bytes as
 * `config.json.clobbered-<time>` before writing (`writeConfigFile`).
 */
let damageAnnounced = false;
function loadConfigForScaffold(force: boolean): MotebitConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigDamagedError)) throw err;
    const keptAs = `${basename(configPath())}${CONFIG_BACKUP_INFIX}<time>`;
    if (!force) {
      throw new Error(
        `${err.message}\n    To replace it anyway, pass --force: the damaged file is kept as ${keptAs}, never deleted.`,
        { cause: err },
      );
    }
    if (!damageAnnounced) {
      damageAnnounced = true;
      console.log(
        `  ${yellow("!")} ${dim(configPath())} could not be read (${err.reason}); --force given, it will be kept as ${keptAs}.`,
      );
    }
    return {};
  }
}

/**
 * Save the operator config. A save that does not change the identity never
 * changes it (another process's newer key is kept); one that does
 * (`identityChange`) keeps whatever key it replaces and is refused if the
 * identity changed since it was read (`config-file.ts`).
 */
function saveConfig(config: MotebitConfig, identityChange?: "preserve-replaced"): void {
  const preservedAs = writeConfigFile(
    configPath(),
    config,
    identityChange != null ? { identityChange } : {},
  );
  if (preservedAs != null) {
    console.log(`  ${yellow("!")} The previous config was kept as ${dim(preservedAs)}.`);
  }
}

/**
 * A `motebit rotate` in flight in `dir` keeps its NEW key in
 * `pending-rotation.json`. When the identity in that directory is replaced,
 * that write-ahead must not stay armed: the next `motebit rotate` would find
 * a write-ahead for another identity. It is moved aside (bytes kept, never
 * deleted — the relay may already hold its key) as
 * `pending-rotation.json.clobbered-<time>`.
 */
function setAsideWriteAhead(dir: string): void {
  const kept = moveAside(pendingRotationPathIn(dir), CONFIG_BACKUP_INFIX);
  if (kept != null) {
    console.log(
      `  ${yellow("!")} A key rotation in flight for the replaced identity was kept as ${dim(kept)}.`,
    );
  }
}

/** Write a signed identity file, keeping another identity's file that was there. */
function writeIdentityFile(path: string, contents: string): void {
  const kept = replaceIdentityFile(path, contents);
  if (kept != null) {
    console.log(`  ${yellow("!")} Another identity's ${basename(path)} was kept as ${dim(kept)}.`);
  }
}

/**
 * Write a scaffolded agent's config to its OWN directory (`<agent>/.motebit/`)
 * instead of the global `~/.motebit/`. This is what makes the agent dir
 * self-contained and portable: copy the directory to another machine, set
 * the passphrase, and it runs. The agent's encrypted identity key never
 * touches the operator's global identity store.
 *
 * Pairs with `MOTEBIT_CONFIG_DIR=<agent>/.motebit` in the entrypoint
 * template, which makes the spawned `motebit serve` resolve the same path.
 */
function writeAgentConfig(agentDir: string, config: MotebitConfig): void {
  // The agent's `cli_encrypted_key` is its only key copy — same three rules
  // as the operator's config: atomic, owner-only, damage preserved first.
  // A replaced agent identity (`--force`): its in-flight rotation is set
  // aside first, and its config — key included — is kept by the write.
  setAsideWriteAhead(join(agentDir, ".motebit"));
  const preservedAs = writeConfigFile(join(agentDir, ".motebit", "config.json"), config, {
    identityChange: "preserve-replaced",
  });
  if (preservedAs != null) {
    console.log(`  ${yellow("!")} The previous agent config was kept as ${dim(preservedAs)}.`);
  }
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
  const existing = loadConfigForScaffold(force);
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
      verify: "npx -p @motebit/verify motebit-verify motebit.md",
    },
    dependencies: {
      "@motebit/crypto": `^${__CRYPTO_VERSION__}`,
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

/**
 * README for the default (identity-only) scaffold. The next-steps output
 * also prints these instructions to stdout, but stdout is ephemeral —
 * a user who closes their terminal has nothing to refer back to. The
 * committed README is the durable record.
 */
function makeReadme(name: string, motebitId: string): string {
  return `# ${name}

Your sovereign motebit identity, scaffolded by [\`create-motebit\`](https://www.npmjs.com/package/create-motebit).

\`\`\`txt
motebit_id: ${motebitId}
\`\`\`

## Verify your identity

Two ways, both produce the same result:

\`\`\`bash
node verify.js                                          # In-project verifier (uses @motebit/crypto)
npx -p @motebit/verify motebit-verify motebit.md        # Canonical CLI verifier
\`\`\`

The motebit.md file is a self-attesting document. Anyone with the file and \`@motebit/crypto\` (or the \`motebit-verify\` CLI) can verify the signature without contacting any server.

## What's in this directory

\`\`\`txt
motebit.md         Signed identity — who your agent is
verify.js          Verification example (Node, uses @motebit/crypto)
package.json       Node project (one runtime dep: @motebit/crypto)
.env.example       Environment variable template
.gitignore         Secrets excluded
\`\`\`

Your identity's encrypted private key lives in \`~/.motebit/config.json\` (or \`$MOTEBIT_CONFIG_DIR/config.json\`), unlocked by the passphrase you set during scaffolding.

## Next steps

- **Run an agent** with this identity: \`npm install -g motebit\`, then \`motebit\` from anywhere
- **Inspect your credentials** as they accrue: \`motebit credentials\`
- **Export a verifiable presentation**: \`motebit credentials --presentation\`
- **Rotate your key** if compromised: \`npx create-motebit rotate motebit.md\`

## Learn more

- [docs.motebit.com](https://docs.motebit.com) — concepts, protocol surface, runtime
- [\`docs/doctrine/the-stack-one-layer-up.md\`](https://github.com/motebit/motebit/blob/main/docs/doctrine/the-stack-one-layer-up.md) — where motebit fits relative to hosted agent platforms
`;
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
.motebit/
`;

/**
 * README for the agent (runnable) scaffold. Mirrors the default
 * scaffold's README pattern but documents the agent-specific commands
 * (dev/start/self-test) and the relay-auth model.
 */
function makeAgentReadme(name: string, motebitId: string): string {
  return `# ${name}

A runnable motebit agent, scaffolded by [\`create-motebit\`](https://www.npmjs.com/package/create-motebit) with \`--agent\`.

\`\`\`txt
motebit_id: ${motebitId}
\`\`\`

## First run

\`\`\`bash
npm install
cp .env.example .env     # set MOTEBIT_PASSPHRASE (required) + relay URL
npm run dev              # build + start the agent server
\`\`\`

## What's in this directory

\`\`\`txt
motebit.md         Signed identity — who your agent is
src/index.ts       Entrypoint — starts the agent server (guarded main-module)
src/tools.ts       Tools — what your agent can do
tsconfig.json      TypeScript config (Node16, ES2022, strict)
package.json       Scripts: build, dev, start, self-test, verify
.env.example       MOTEBIT_PASSPHRASE (required), relay URL
\`\`\`

## Scripts

\`\`\`bash
npm run build       # tsc → dist/
npm run dev         # build + start (development loop)
npm start           # start from dist/ (prestart hook builds first)
npm run self-test   # build + start in self-delegation mode
npm run verify      # verify motebit.md signature via @motebit/verify
\`\`\`

## How tools work

Each entry in \`src/tools.ts\` declares a \`definition\` (name, description, JSON schema for inputs) and a \`handler\` (async function). The relay advertises your tool names as your agent's capabilities; other agents discover them and delegate work via signed task requests. Every completed task earns a signed receipt that becomes part of the agent's trust history.

Add your own tools by extending the \`tools\` array. Remove the \`fetch_url\` and \`echo\` examples when you're ready.

## Verifying your identity

\`\`\`bash
npm run verify
# or
npx -p @motebit/verify motebit-verify motebit.md
\`\`\`

The motebit.md is self-attesting — anyone can verify the signature without contacting any server.

## Authentication for the relay

Your agent authenticates to the relay **as itself**: it introduces its key through the relay's public bootstrap endpoint on first boot, then mints a short-lived Ed25519-signed token per call, bound to the audience each route expects. Paid tasks arrive with a relay-signed \`task:dispatch\` admission token that the agent verifies against the relay's pinned key before running. There is no relay API token to hold — the operator's master token never leaves the relay. The local key is encrypted in \`~/.motebit/config.json\` and needs \`MOTEBIT_PASSPHRASE\` (or an interactive prompt) to decrypt on each invocation.

The same passphrase you set during \`create-motebit\` unlocks every CLI command (credentials, export, attest). Set \`MOTEBIT_PASSPHRASE\` in your shell or \`.env\` to skip the prompt.

## Learn more

- [docs.motebit.com](https://docs.motebit.com) — concepts, protocol surface, runtime
- [\`docs/doctrine/the-stack-one-layer-up.md\`](https://github.com/motebit/motebit/blob/main/docs/doctrine/the-stack-one-layer-up.md) — where motebit fits relative to hosted agent platforms
`;
}

function makeAgentPackageJson(name: string): string {
  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      build: "tsc",
      // `prestart` is npm's canonical hook for "build before start" —
      // running `npm start` on a clean checkout (no dist/) used to bail
      // with "Cannot find module dist/index.js"; the prestart hook makes
      // it just work. Keeps `start` itself a single-line invocation
      // suitable for production runners that pre-build separately.
      prestart: "tsc",
      // `--env-file=.env` (Node ≥ 20.6 native, no dependency) is what makes
      // `cp .env.example .env && npm run dev` actually work end-to-end.
      // Without it, MOTEBIT_PASSPHRASE in .env would be a wallpaper file —
      // the runtime never reads it, decrypt fails, motebit_task disabled.
      // The scaffold's whole onboarding chain (.env.example → .env → runtime
      // decrypt) hinges on this flag being present. If a user skips the
      // `cp` step, node errors clearly: "Cannot read /path/.env: no such
      // file or directory" — informative failure, not silent decrypt-fail.
      start: "node --env-file=.env dist/index.js",
      dev: "tsc && node --env-file=.env dist/index.js",
      verify: "npx -p @motebit/verify motebit-verify motebit.md",
      "self-test": "tsc && node --env-file=.env dist/index.js --self-test",
    },
    dependencies: {
      "@motebit/sdk": `^${__SDK_VERSION__}`,
      motebit: `^${__MOTEBIT_VERSION__}`,
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
    // Node ≥ 20.6 for the native `--env-file=.env` flag the dev/start/
    // self-test scripts rely on. Older Node lacks the flag and fails with
    // `unknown or unexpected option`. npm warns the user at install time
    // when their Node is below this floor — clearer than a runtime error.
    engines: {
      node: ">=20.6.0",
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

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tools from "./tools.js";

// Self-contained config: the scaffold wrote the encrypted identity to
// \`<agent>/.motebit/\`. Resolve that path absolutely from this file's
// location so the spawned \`motebit serve\` (below) reads THIS agent's
// identity, not whatever happens to be at \`~/.motebit/\`. This is what
// makes the agent dir portable.
const agentRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentConfigDir = resolve(agentRoot, ".motebit");

// Load the identity file
const identityPath = resolve(agentRoot, "motebit.md");
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
// which re-imports again, forever. So the spawn fires only when this file
// is the process entry point. Compare REALPATHS, not raw strings: launched
// through a symlink (a global bin / npx), process.argv[1] is the link while
// import.meta.url is the realpath — a direct === misses that and the agent
// silently never starts. When motebit serve re-imports this for --tools,
// argv[1] is the motebit binary (a different realpath), so the guard is
// false and recursion is still prevented.
function isEntrypoint(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
const isMainModule = isEntrypoint();

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
      // Pin MOTEBIT_CONFIG_DIR to this agent's own config dir. Without this,
      // the spawned \`motebit serve\` falls back to \`~/.motebit\` and tries
      // to decrypt whatever encrypted key happens to live there — almost
      // never the one the scaffold generated. Self-containment requires
      // explicit pinning.
      env: { ...process.env, MOTEBIT_CONFIG_DIR: agentConfigDir },
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
  return `# REQUIRED — the same passphrase you set during \`npm create motebit\`.
# Used at runtime to decrypt your agent's signing key. Without it, the
# agent boots but the \`motebit_task\` tool stays disabled (decrypt-failed).
# This file is gitignored; never commit a filled-in copy.
MOTEBIT_PASSPHRASE=

# Relay URL — defaults to the public relay if unset.
# Override to point at your own relay or a federation peer.
MOTEBIT_SYNC_URL=https://relay.motebit.com

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

  // Local-config-clobber gate — on BOTH paths. Agent identities live in
  // `<agent>/.motebit/` (self-contained, see writeAgentConfig), and that
  // config holds the agent's only key copy. The package.json check above
  // catches "scaffolding into an existing project"; this catches the
  // partial-state case where `.motebit/config.json` exists in an otherwise
  // empty directory. It once ran only under --yes, so an interactive run
  // replaced a healthy agent key without a word.
  const localConfigPath = join(absDir, ".motebit", "config.json");
  // R1: only ENOENT of the name is "no config" — a dangling symlink or an
  // unreadable one is something there.
  if (!isTrulyAbsent(localConfigPath)) {
    if (!force) {
      console.log();
      console.log(
        `  ${red("!")} An existing motebit agent identity is present at ${dim(localConfigPath)}`,
      );
      console.log();
      console.log(`    Refusing to overwrite without explicit consent.`);
      console.log();
      console.log(`    To intentionally replace it: ${dim("npx create-motebit ... --force")}`);
      console.log(`    ${dim("(the existing config is kept as config.json.clobbered-<time>)")}`);
      console.log();
      process.exit(1);
    }
    // Consent given — still never destroy a key: the replaced config's bytes
    // (and any rotation it had in flight) are kept when the new one is
    // written, after every prompt, so an aborted run changes nothing.
    console.log(
      `  ${yellow("!")} Replacing the existing agent identity; it will be kept as config.json.clobbered-<time>.`,
    );
  }

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

  // The key FIRST. Everything below names it (motebit.md) or blocks a rerun
  // (package.json); written before the key, a failed or refused key write
  // left a signed identity naming a key saved nowhere.
  //
  // Saved to the agent's OWN config dir (`<agent>/.motebit/`), not the
  // global `~/.motebit/`. This makes the agent self-contained: the signed
  // identity (motebit.md), the encrypted private key (.motebit/config.json),
  // the runnable code (src/), and the dependency manifest (package.json)
  // all live under one directory. Copy that directory to another machine,
  // set MOTEBIT_PASSPHRASE, run; identity travels with the agent. The
  // operator's global ~/.motebit/ identity is left untouched so scaffolding
  // never collides with `motebit relay up`.
  const agentConfig: MotebitConfig = {
    name: dirName,
    motebit_id: result.motebitId,
    device_id: result.deviceId,
    device_public_key: result.publicKeyHex,
    cli_encrypted_key: result.encryptedKey,
  };
  writeAgentConfig(absDir, agentConfig);

  writeFileSync(pkgPath, makeAgentPackageJson(dirName), "utf-8");
  writeFileSync(join(absDir, "tsconfig.json"), makeAgentTsconfig(), "utf-8");
  writeFileSync(join(absDir, "src", "index.ts"), makeAgentEntrypoint(agentName), "utf-8");
  writeFileSync(join(absDir, "src", "tools.ts"), makeAgentTools(agentName), "utf-8");
  writeFileSync(join(absDir, ".env.example"), makeAgentEnvExample(), "utf-8");
  writeFileSync(join(absDir, ".gitignore"), AGENT_GITIGNORE, "utf-8");
  writeIdentityFile(join(absDir, "motebit.md"), result.identityFileContent);
  writeFileSync(join(absDir, "README.md"), makeAgentReadme(dirName, result.motebitId), "utf-8");

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
  console.log(`    .env.example       ${dim("Passphrase + relay URL")}`);
  console.log();
  console.log(`  Motebit ID: ${cyan(result.motebitId)}`);
  console.log();
  console.log(`  ${bold("Next steps:")}`);
  console.log();
  if (targetDir !== ".") {
    console.log(`    cd ${dirName}`);
  }
  console.log(`    npm install`);
  console.log(`    npm run verify           ${dim("# Verify your agent's identity signature")}`);
  console.log(
    `    cp .env.example .env     ${dim("# set MOTEBIT_PASSPHRASE (required), relay URL")}`,
  );
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
  let existingConfig = loadConfigForScaffold(force);

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
    existingConfig = loadConfigForScaffold(force);
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
          writeIdentityFile(existingMd, identityFileContent);
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

    // Save identity to config (merge with existing). Replacing an identity is
    // consented to (--force, or the interactive "Overwrite?" prompt) —
    // destroying its key is not. The decision was made on `existingConfig`;
    // if the identity on disk changed since (a `motebit rotate` or restore
    // meanwhile), it no longer describes what would be replaced: refuse.
    const config = loadConfigForScaffold(force);
    if (identityFingerprint(config) !== identityFingerprint(existingConfig)) {
      console.log(
        `  ${red("!")} ${configPath()} changed while create-motebit was running (another motebit process). Nothing was changed — run it again.`,
      );
      console.log();
      process.exit(1);
    }
    // The replaced identity's in-flight rotation is kept aside, and its
    // config — key included — is kept by the save (`preserve-replaced`).
    setAsideWriteAhead(configDir());
    config.name = dirName;
    config.motebit_id = result.motebitId;
    config.device_id = result.deviceId;
    config.device_public_key = result.publicKeyHex;
    config.cli_encrypted_key = result.encryptedKey;
    config.default_provider = provider;
    saveConfig(config, "preserve-replaced");

    // Persist motebit.md to config dir so "keep existing" can reuse it. The
    // replaced identity's signed file is kept, not overwritten.
    writeIdentityFile(join(configDir(), "motebit.md"), result.identityFileContent);
  }

  // Write project files
  writeFileSync(pkgPath, makePackageJson(dirName), "utf-8");
  writeFileSync(join(absDir, ".env.example"), makeEnvExample(provider), "utf-8");
  writeFileSync(join(absDir, ".gitignore"), GITIGNORE, "utf-8");
  if (identityFileContent) {
    // Atomic, and another identity's motebit.md already in the directory is
    // kept, not overwritten (the guard above checks package.json only).
    writeIdentityFile(join(absDir, "motebit.md"), identityFileContent);
  }
  writeFileSync(join(absDir, "verify.js"), makeVerifyExample(), "utf-8");
  // The motebitId is set on both branches above (existing-identity
  // reuse path: line ~871; fresh-generation path: line ~930). It's
  // documentary in the README — never feeds back into runtime.
  writeFileSync(join(absDir, "README.md"), makeReadme(dirName, motebitId), "utf-8");

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
  const refusal = rotateRefusal(config);
  if (refusal != null) {
    console.log(`  ${red("!")} ${refusal}`);
    console.log(`    Nothing was changed.`);
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

  // 5. Verify the rotated file BEFORE anything on disk changes.
  const reVerify = await verify(result.identityFileContent, { expectedType: "identity" });
  if (!reVerify.valid) {
    const errorMessage = reVerify.errors?.[0]?.message ?? "unknown error";
    console.log(`  ${red("!")} Rotated identity failed verification: ${errorMessage}`);
    console.log(`    Nothing was changed.`);
    console.log();
    process.exit(1);
    return;
  }

  // 6. Commit: both keys are held on disk before any file that names or
  // holds one is replaced, so no failure point loses either (rotate-commit.ts).
  const nextConfig: MotebitConfig = {
    ...config,
    device_public_key: result.newPublicKeyHex,
    cli_encrypted_key: result.newEncryptedKey,
  };
  let backupPath: string;
  let oldKeyKeptAt: string;
  try {
    // Held under the config lock the motebit CLI also takes, so no other
    // motebit process can commit a key between the check and the last write.
    ({ backupPath, oldKeyKeptAt } = withFileLock(configPath(), () => {
      // The rotation departs from the key read at step 2. If the identity on
      // disk changed while the passphrases were typed, rotating now would
      // replace a key nobody decided to replace.
      if (identityFingerprint(loadConfig()) !== identityFingerprint(config)) {
        throw new RotationRaceError();
      }
      return commitRotation({
        configPath: configPath(),
        identityPath: filePath,
        previousIdentity: content,
        nextIdentity: result.identityFileContent,
        nextConfig,
      });
    }));
  } catch (err) {
    if (err instanceof RotationRaceError) {
      console.log(`  ${red("!")} ${err.message}`);
      console.log();
      process.exit(1);
      return;
    }
    if (!(err instanceof RotationCommitError)) throw err;
    console.log(`  ${red("!")} ${err.message}`);
    if (err.newKeyAt == null) {
      console.log(`    Nothing was changed; the identity is still on its old key.`);
    } else if (err.identityNames === "old") {
      console.log(`    ${filePath} and ${configPath()} are unchanged (old key).`);
      console.log(`    The new key was never published; its copy can be deleted: ${err.newKeyAt}`);
      console.log(`    The old key is also kept at ${err.oldKeyAt}.`);
    } else {
      console.log(
        `    ${filePath} now names the NEW key, but ${configPath()} still holds the old one.`,
      );
      console.log(`    The new key is held at ${err.newKeyAt} — move it into place:`);
      console.log(`      ${dim(finishRotationCommand(err.newKeyAt, configPath()))}`);
      console.log(`    The old key is kept at ${err.oldKeyAt}.`);
    }
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
  console.log(`  Old key kept at:       ${dim(oldKeyKeptAt)} ${dim("(owner-only)")}`);
  console.log();
  console.log(
    `  ${dim("This command does not tell a relay. The old key is kept so the rotation can be undone")}`,
  );
  console.log(
    `  ${dim("if this identity turns out to be registered with one; for a registered identity use `motebit rotate`.")}`,
  );
  console.log();
}

class RotationRaceError extends Error {
  constructor() {
    super(
      `${configPath()} changed while the rotation was being prepared (another motebit process committed a key or identity). Nothing was changed — run it again.`,
    );
    this.name = "RotationRaceError";
  }
}

/**
 * Why `create-motebit rotate` must not rotate this identity, or null.
 *
 *  - A relay is configured (`sync_url`, a pinned `relay_public_key`, or
 *    `MOTEBIT_SYNC_URL`): this command never talks to a relay, so it would
 *    move the key locally while the relay still holds the old one — the
 *    (local new, relay old) split #709 closed — and the founder's ruling is
 *    that a retired key is erased only after a relay accepted the
 *    succession. `motebit rotate` does that through the relay.
 *  - A `motebit rotate` is in flight here (`pending-rotation.json`, readable
 *    or not): its new key may already be the relay's. Rotating on top of it
 *    would strand it.
 *  - A previous `create-motebit rotate` stopped half-way
 *    (`config.json.rotation-next-*`): the NEW key it held may be the one
 *    `motebit.md` names. Finish or resolve that first.
 */
function rotateRefusal(config: MotebitConfig): string | null {
  const syncUrl = typeof config["sync_url"] === "string" ? config["sync_url"] : "";
  const relayKey = typeof config["relay_public_key"] === "string" ? config["relay_public_key"] : "";
  const envRelay = process.env["MOTEBIT_SYNC_URL"] ?? "";
  if (syncUrl !== "" || relayKey !== "" || envRelay !== "") {
    return `This identity is registered with a relay (${syncUrl || envRelay || "a pinned relay key"}). create-motebit rotate never contacts a relay, so the relay would keep the old key. Rotate with \`motebit rotate\` instead — it records the succession at the relay first.`;
  }
  const pending = pendingRotationPathIn(configDir());
  if (!isTrulyAbsent(pending)) {
    return `A \`motebit rotate\` is in flight (${pending}); its new key may already be the relay's. Finish it with \`motebit rotate\` first.`;
  }
  let unfinished: string | undefined;
  try {
    unfinished = readdirSync(configDir()).find((f) => f.startsWith("config.json.rotation-next-"));
  } catch {
    unfinished = undefined;
  }
  if (unfinished != null) {
    return `An earlier create-motebit rotate stopped before its last step: ${join(configDir(), unfinished)} holds a NEW key that motebit.md may already name. Resolve it first (compare it with motebit.md; \`motebit doctor\` lists it).`;
  }
  return null;
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
