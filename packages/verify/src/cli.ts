#!/usr/bin/env node
/**
 * `motebit-verify` CLI — the canonical motebit artifact verifier.
 *
 * Verifies identity files, execution receipts, credentials, and
 * presentations against their embedded signatures. When a credential
 * carries a `hardware_attestation` claim for `device_check` / `tpm` /
 * `play_integrity` / `webauthn`, the bundled platform adapters verify
 * the chain, nonce, bundle, and identity binding end-to-end.
 *
 * ```
 *   motebit-verify <file>                 # auto-detect, print human
 *   motebit-verify <file> --json          # structured output
 *   motebit-verify <file> --expect credential
 *   motebit-verify <file> --clock-skew 30
 *
 *   # Platform-specific overrides (all optional; defaults match
 *   # motebit's canonical identifiers).
 *   motebit-verify <file> \
 *     --bundle-id com.example.app \
 *     --android-package com.example.app \
 *     --rp-id example.com
 * ```
 *
 * Exit codes:
 *   0  artifact verified (including any hardware-attestation channel)
 *   1  artifact detected but signature / hardware-channel invalid
 *   2  usage / I/O error
 *
 * Network-free by design. Every adapter pins its own trust anchor
 * (Apple App Attest Root CA, FIDO roots, TPM vendor roots); Play
 * Integrity's JWKS is fail-closed by default until an operator lands
 * real bytes (see `@motebit/crypto-play-integrity`'s CLAUDE.md).
 *
 * Three-package lineage — mirrors how tools like `git` / `libgit2` or
 * `cargo` / `tokio` separate the verb-tool from the library layer:
 *
 *   @motebit/verify   — this CLI (BSL, bundles all 4 adapters)
 *   @motebit/verifier — MIT library (file I/O, human formatting)
 *   @motebit/crypto   — MIT primitives (verify, sign, suite dispatch)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactType } from "@motebit/crypto";
import { formatHuman, verifyFile } from "@motebit/verifier";

import { buildHardwareVerifiers } from "./adapters.js";

const EXPECT_VALUES: readonly ArtifactType[] = [
  "identity",
  "receipt",
  "credential",
  "presentation",
];

interface ParsedArgs {
  readonly mode: "verify" | "help" | "version";
  readonly file?: string;
  readonly json: boolean;
  readonly expectedType?: ArtifactType;
  readonly clockSkewSeconds?: number;
  readonly bundleId?: string;
  readonly androidPackage?: string;
  readonly rpId?: string;
  readonly usageError?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let file: string | undefined;
  let json = false;
  let expectedType: ArtifactType | undefined;
  let clockSkewSeconds: number | undefined;
  let bundleId: string | undefined;
  let androidPackage: string | undefined;
  let rpId: string | undefined;
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
        if (value === undefined) return usage(`${arg} requires a value`);
        if (!(EXPECT_VALUES as readonly string[]).includes(value)) {
          return usage(`unknown --expect value "${value}" (valid: ${EXPECT_VALUES.join(", ")})`);
        }
        expectedType = value as ArtifactType;
        i += 2;
        break;
      }
      case "--clock-skew": {
        const value = argv[i + 1];
        if (value === undefined) return usage("--clock-skew requires an integer seconds value");
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) {
          return usage(`--clock-skew must be a non-negative integer (got "${value}")`);
        }
        clockSkewSeconds = n;
        i += 2;
        break;
      }
      case "--bundle-id": {
        const value = argv[i + 1];
        if (value === undefined) return usage("--bundle-id requires a value");
        bundleId = value;
        i += 2;
        break;
      }
      case "--android-package": {
        const value = argv[i + 1];
        if (value === undefined) return usage("--android-package requires a value");
        androidPackage = value;
        i += 2;
        break;
      }
      case "--rp-id": {
        const value = argv[i + 1];
        if (value === undefined) return usage("--rp-id requires a value");
        rpId = value;
        i += 2;
        break;
      }
      default:
        if (arg.startsWith("-")) return usage(`unknown flag: ${arg}`);
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
  if (file === undefined) return usage("missing file argument");

  return {
    mode: "verify",
    file,
    json,
    ...(expectedType !== undefined && { expectedType }),
    ...(clockSkewSeconds !== undefined && { clockSkewSeconds }),
    ...(bundleId !== undefined && { bundleId }),
    ...(androidPackage !== undefined && { androidPackage }),
    ...(rpId !== undefined && { rpId }),
  };
}

function usage(message: string): ParsedArgs {
  return { mode: "help", json: false, usageError: message };
}

function renderHelp(): string {
  return [
    "motebit-verify — hardware-attestation-aware verifier for Motebit credentials",
    "",
    "USAGE",
    "  motebit-verify <file> [options]",
    "",
    "OPTIONS",
    "  --json                    Print structured JSON instead of human-readable.",
    "  --expect <type>           Require the artifact to be of the named type.",
    "  --clock-skew <seconds>    Allow N seconds of clock skew.",
    "  --bundle-id <id>          Override the expected iOS bundle ID for App Attest",
    "                            (default: com.motebit.mobile).",
    "  --android-package <name>  Override the expected Android package name for",
    "                            Play Integrity (default: com.motebit.mobile).",
    "  --rp-id <id>              Override the expected WebAuthn Relying Party ID",
    "                            (default: motebit.com).",
    "  -h, --help                Show this help.",
    "  -V, --version             Print version.",
    "",
    "EXIT CODES",
    "  0  Artifact verified (including hardware-attestation channel).",
    "  1  Artifact invalid (signature, expiry, hardware-channel chain / nonce / bundle).",
    "  2  Usage or I/O error.",
    "",
    "PLATFORMS WIRED",
    "  device_check     Apple App Attest (pinned Apple root)",
    "  tpm              TPM 2.0 (pinned Infineon / Nuvoton / STMicro / Intel PTT roots)",
    "  play_integrity   Google Play Integrity (fail-closed; operator pins real JWKS)",
    "  webauthn         WebAuthn packed attestation (pinned Apple / Yubico / Microsoft)",
  ].join("\n");
}

let cachedVersion: string | undefined;
function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "version") {
    process.stdout.write(`${getPackageVersion()}\n`);
    return 0;
  }
  if (args.mode === "help") {
    const help = renderHelp();
    if (args.usageError !== undefined) {
      process.stderr.write(`motebit-verify: ${args.usageError}\n\n${help}\n`);
      return 2;
    }
    process.stdout.write(`${help}\n`);
    return 0;
  }

  if (args.file === undefined) {
    process.stderr.write(`motebit-verify: missing file argument\n\n${renderHelp()}\n`);
    return 2;
  }

  const hardwareAttestation = buildHardwareVerifiers({
    ...(args.bundleId !== undefined && { appAttestBundleId: args.bundleId }),
    ...(args.androidPackage !== undefined && { playIntegrityPackageName: args.androidPackage }),
    ...(args.rpId !== undefined && { webauthnRpId: args.rpId }),
  });

  let result;
  try {
    result = await verifyFile(args.file, {
      ...(args.expectedType !== undefined && { expectedType: args.expectedType }),
      ...(args.clockSkewSeconds !== undefined && { clockSkewSeconds: args.clockSkewSeconds }),
      hardwareAttestation,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`motebit-verify: cannot read ${args.file}: ${msg}\n`);
    return 2;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }
  return result.valid ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`motebit-verify: ${msg}\n`);
    process.exit(2);
  });
