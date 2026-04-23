/**
 * CLI argument parser + dispatcher — factored out of `cli.ts` so it can
 * be invoked directly from tests without spawning a child process. The
 * bin script is a thin shim over `runCli(parseArgs(argv))`.
 *
 * The parser is deliberately hand-rolled: this package's surface must
 * install cleanly in a project that depends on nothing else (no yargs,
 * no commander, no third-party arg lib). Verification is a trust primitive;
 * every dep is a trust attack surface we'd have to audit on every
 * upgrade.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactType } from "@motebit/crypto";

import { formatHuman, verifyFile } from "./lib.js";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const DEFAULT_IO: CliIo = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

const EXPECT_VALUES: readonly ArtifactType[] = [
  "identity",
  "receipt",
  "credential",
  "presentation",
];

/**
 * Typed exit-code-carrying error for usage / I/O failures. Regular
 * invalid-signature outcomes are NOT errors — they are a normal
 * `{ valid: false }` return with exit 1.
 */
export class CliError extends Error {
  constructor(
    public readonly code: 2,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}

export interface ParsedArgs {
  readonly mode: "verify" | "help" | "version";
  readonly file?: string;
  readonly json: boolean;
  readonly expectedType?: ArtifactType;
  readonly clockSkewSeconds?: number;
  readonly usageError?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let file: string | undefined;
  let json = false;
  let expectedType: ArtifactType | undefined;
  let clockSkewSeconds: number | undefined;
  let help = false;
  let version = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        i++;
        break;
      case "-V":
      case "--version":
        version = true;
        i++;
        break;
      case "--json":
        json = true;
        i++;
        break;
      case "--expect":
      case "--expected-type": {
        const value = argv[i + 1];
        if (value === undefined) {
          return usage(`${arg} requires a value (one of: ${EXPECT_VALUES.join(", ")})`);
        }
        if (!(EXPECT_VALUES as readonly string[]).includes(value)) {
          return usage(`unknown --expect value "${value}" (valid: ${EXPECT_VALUES.join(", ")})`);
        }
        expectedType = value as ArtifactType;
        i += 2;
        break;
      }
      case "--clock-skew": {
        const value = argv[i + 1];
        if (value === undefined) {
          return usage("--clock-skew requires an integer seconds value");
        }
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) {
          return usage(`--clock-skew must be a non-negative integer (got "${value}")`);
        }
        clockSkewSeconds = n;
        i += 2;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          return usage(`unknown flag: ${arg}`);
        }
        if (file !== undefined) {
          return usage(
            `expected exactly one file argument, got a second: "${arg}" (after "${file}")`,
          );
        }
        file = arg;
        i++;
        break;
    }
  }

  if (help) return { mode: "help", json };
  if (version) return { mode: "version", json };
  if (file === undefined) {
    return usage("missing file argument");
  }
  const result: ParsedArgs = {
    mode: "verify",
    file,
    json,
    ...(expectedType !== undefined && { expectedType }),
    ...(clockSkewSeconds !== undefined && { clockSkewSeconds }),
  };
  return result;
}

function usage(message: string): ParsedArgs {
  return { mode: "help", json: false, usageError: message };
}

export async function runCli(args: ParsedArgs, io: CliIo = DEFAULT_IO): Promise<number> {
  if (args.mode === "version") {
    io.stdout(`${getPackageVersion()}\n`);
    return 0;
  }
  if (args.mode === "help") {
    const help = renderHelp();
    if (args.usageError !== undefined) {
      io.stderr(`motebit-verify: ${args.usageError}\n\n${help}\n`);
      return 2;
    }
    io.stdout(`${help}\n`);
    return 0;
  }

  if (args.file === undefined) {
    // Defensive: parseArgs guarantees file for mode:verify. Keep the guard.
    io.stderr(`motebit-verify: missing file argument\n\n${renderHelp()}\n`);
    return 2;
  }

  let result;
  try {
    result = await verifyFile(args.file, {
      ...(args.expectedType !== undefined && { expectedType: args.expectedType }),
      ...(args.clockSkewSeconds !== undefined && { clockSkewSeconds: args.clockSkewSeconds }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`motebit-verify: cannot read ${args.file}: ${msg}\n`);
    return 2;
  }

  if (args.json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout(`${formatHuman(result)}\n`);
  }
  return result.valid ? 0 : 1;
}

function renderHelp(): string {
  return [
    "motebit-verify — offline third-party verification for Motebit artifacts",
    "",
    "USAGE",
    "  motebit-verify <file> [options]",
    "",
    "ARGUMENTS",
    "  <file>                    Path to an identity file (motebit.md) or signed",
    "                            JSON artifact (receipt, credential, presentation).",
    "",
    "OPTIONS",
    "  --json                    Print structured JSON instead of human-readable.",
    "  --expect <type>           Require the artifact to be of the named type.",
    "                            One of: identity, receipt, credential, presentation.",
    "  --clock-skew <seconds>    Allow N seconds of clock skew when checking",
    "                            credential / presentation validity windows.",
    "  -h, --help                Show this help.",
    "  -V, --version             Print version.",
    "",
    "EXIT CODES",
    "  0  Artifact verified",
    "  1  Artifact invalid (bad signature, expired, mismatched type)",
    "  2  Usage or I/O error",
    "",
    "EXAMPLES",
    "  motebit-verify motebit.md",
    "  motebit-verify receipt.json --json",
    "  motebit-verify credential.json --expect credential --clock-skew 30",
  ].join("\n");
}

/**
 * Injected at build time in published artifacts. For unpublished
 * source-run (tests) we fall back to reading the package.json once
 * lazily.
 */
let cachedVersion: string | undefined;

function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    // Resolve relative to this file; published dist/ lives alongside
    // package.json at ../package.json. Source runs (tests) resolve the
    // same way — src/cli-core.ts → ../package.json.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}
