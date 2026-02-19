#!/usr/bin/env node

/**
 * create-motebit — Scaffold a motebit agent project.
 *
 * Usage:
 *   npm create motebit [dir]         # Scaffold a new project
 *   npx create-motebit verify [path] # Verify an existing motebit.md
 */

import { verify } from "@motebit/verify";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = "0.1.0";

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
// Scaffolded file contents
// ---------------------------------------------------------------------------

function makePackageJson(name: string): string {
  const pkg = {
    name,
    private: true,
    type: "module",
    scripts: {
      start: "motebit run --identity motebit.md",
      chat: "motebit",
      verify: "motebit verify motebit.md",
    },
    dependencies: {
      motebit: "0.1.0",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

const ENV_EXAMPLE = `# AI provider — set at least one
ANTHROPIC_API_KEY=your-key-here

# Local models (optional, instead of Anthropic)
# OLLAMA_HOST=http://localhost:11434

# Key passphrase (prompted interactively if not set)
# MOTEBIT_PASSPHRASE=
`;

const GITIGNORE = `node_modules/
.env
*.key
`;

// ---------------------------------------------------------------------------
// scaffold command
// ---------------------------------------------------------------------------

function scaffold(targetDir: string): void {
  console.log();
  console.log(`  ${bold("create-motebit")} ${dim(`v${VERSION}`)}`);
  console.log();

  const absDir = resolve(targetDir);
  const dirName = basename(absDir);

  // Check for existing package.json
  const pkgPath = join(absDir, "package.json");
  if (existsSync(pkgPath)) {
    console.log(`  ${red("!")} ${pkgPath} already exists.`);
    console.log(`    Refusing to scaffold over an existing project.`);
    console.log();
    process.exit(1);
  }

  // Create directory if needed
  mkdirSync(absDir, { recursive: true });

  // Write scaffolded files
  writeFileSync(pkgPath, makePackageJson(dirName), "utf-8");
  writeFileSync(join(absDir, ".env.example"), ENV_EXAMPLE, "utf-8");
  writeFileSync(join(absDir, ".gitignore"), GITIGNORE, "utf-8");

  // Output
  const relDir = targetDir === "." ? "." : `./${dirName}`;
  console.log(`  ${green("+")} Scaffolded in ${bold(relDir)}`);
  console.log();
  console.log(`    package.json       motebit agent project`);
  console.log(`    .env.example       API key configuration`);
  console.log(`    .gitignore         secrets and build artifacts`);
  console.log();
  console.log(`  ${bold("Next steps:")}`);
  console.log();
  if (targetDir !== ".") {
    console.log(`    cd ${dirName}`);
  }
  console.log(`    npm install`);
  console.log(`    cp .env.example .env       ${dim("# add your Anthropic API key")}`);
  console.log(`    npx motebit                ${dim("# identity created on first run")}`);
  console.log();
  console.log(`  ${dim("Run")} ${cyan("npx motebit export")} ${dim("to export a signed motebit.md for daemon mode.")}`);
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
  ${bold("create-motebit")} ${dim(`v${VERSION}`)} — Scaffold a motebit agent project

  ${bold("Usage:")}

    npm create motebit [dir]          Scaffold a new agent project
    npx create-motebit verify [path]  Verify a motebit.md signature

  ${bold("Options:")}

    -v, --version         Print version
    -h, --help            Print this help

  ${bold("What happens on scaffold:")}

    1. Creates project directory with package.json, .env.example, .gitignore
    2. On first ${cyan("npx motebit")}, identity is bootstrapped automatically
    3. Run ${cyan("npx motebit export")} to export a signed motebit.md for daemon mode

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

  // Default: scaffold
  const targetDir = command ?? ".";
  scaffold(targetDir);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${red("Error:")} ${msg}\n`);
  process.exit(1);
});
