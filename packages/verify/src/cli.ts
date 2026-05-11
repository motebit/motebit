#!/usr/bin/env node
/**
 * `motebit-verify` CLI — the canonical motebit artifact verifier.
 *
 * Verifies identity files, execution receipts, credentials, and
 * presentations against their embedded signatures. When a credential
 * carries a `hardware_attestation` claim for `device_check` / `tpm` /
 * `android_keystore` / `webauthn`, the bundled platform adapters
 * verify the chain, extension, package binding, and identity binding
 * end-to-end.
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
 *     --android-attestation-application-id ./app-id.bin \
 *     --rp-id example.com
 * ```
 *
 * Exit codes:
 *   0  artifact verified (including any hardware-attestation channel)
 *   1  artifact detected but signature / hardware-channel invalid
 *   2  usage / I/O error
 *
 * Network-free by design. Every adapter pins its own trust anchor
 * (Apple App Attest Root CA, FIDO roots, TPM vendor roots, Google
 * Hardware Attestation roots).
 *
 * Three-package lineage — mirrors how tools like `git` / `libgit2` or
 * `cargo` / `tokio` separate the verb-tool from the library layer:
 *
 *   @motebit/verify   — this CLI (Apache-2.0, bundles all 4 adapters)
 *   @motebit/verifier — Apache-2.0 library (file I/O, human formatting)
 *   @motebit/crypto   — Apache-2.0 primitives (verify, sign, suite dispatch)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactType, ContentArtifactManifest } from "@motebit/crypto";
import { verifyContentArtifact } from "@motebit/crypto";
import type { ContentArtifactType } from "@motebit/protocol";
import { ALL_CONTENT_ARTIFACT_TYPES, isContentArtifactType } from "@motebit/protocol";
import {
  verifyInnerSignedReceipts,
  type InnerReceiptsVerification,
} from "@motebit/state-export-client";
import { formatHuman, verifyFile } from "@motebit/verifier";

import { buildHardwareVerifiers } from "./adapters.js";

const EXPECT_VALUES: readonly ArtifactType[] = [
  "identity",
  "receipt",
  "credential",
  "presentation",
  "skill",
];

/**
 * First positional argument that switches the CLI into content-artifact
 * mode. Verifies a relay-asserted (or motebit-asserted) C2PA-shape
 * manifest against the bytes it covers — the consumer-side primitive
 * for the state-export-signing surface (`docs/doctrine/nist-alignment.md`
 * §8). Stays a subcommand rather than auto-detection because
 * content-artifact mode takes TWO inputs (body + manifest); auto-
 * detection on a single positional cannot distinguish them.
 */
const CONTENT_ARTIFACT_SUBCOMMAND = "content-artifact";

interface ParsedArgs {
  readonly mode: "verify" | "verify-content-artifact" | "help" | "version";
  readonly file?: string;
  readonly json: boolean;
  readonly expectedType?: ArtifactType;
  readonly clockSkewSeconds?: number;
  readonly bundleId?: string;
  readonly androidAttestationApplicationIdPath?: string;
  readonly rpId?: string;
  /** Content-artifact mode: manifest input — either base64url header value or path to JSON file. */
  readonly manifest?: string;
  /** Content-artifact mode: optional pinned producer key (hex, 64 chars). */
  readonly expectedProducerKey?: string;
  /** Content-artifact mode: optional expected artifact-type from the closed registry. */
  readonly expectedArtifactType?: ContentArtifactType;
  readonly usageError?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // Detect content-artifact subcommand at the head of the arg list.
  // The remaining args are parsed in content-artifact mode — a strict
  // subset of the credential-verification flags (no platform-specific
  // overrides) plus content-artifact-specific flags.
  if (argv[0] === CONTENT_ARTIFACT_SUBCOMMAND) {
    return parseContentArtifactArgs(argv.slice(1));
  }

  let file: string | undefined;
  let json = false;
  let expectedType: ArtifactType | undefined;
  let clockSkewSeconds: number | undefined;
  let bundleId: string | undefined;
  let androidAttestationApplicationIdPath: string | undefined;
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
      case "--android-attestation-application-id": {
        // Path to a binary file containing the raw bytes of the leaf
        // cert's `attestationApplicationId` extension value. Operators
        // capture this once at build time (deterministic from the
        // package name + signing-cert SHA-256) and pin the result;
        // the verifier byte-compares against the leaf's KeyDescription
        // extension. File-only intentionally — typical AAID is 50-200
        // bytes, unwieldy on the command line as hex.
        const value = argv[i + 1];
        if (value === undefined) {
          return usage("--android-attestation-application-id requires a path to a binary file");
        }
        androidAttestationApplicationIdPath = value;
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
    ...(androidAttestationApplicationIdPath !== undefined && {
      androidAttestationApplicationIdPath,
    }),
    ...(rpId !== undefined && { rpId }),
  };
}

function usage(message: string): ParsedArgs {
  return { mode: "help", json: false, usageError: message };
}

/**
 * Parse args for the `content-artifact` subcommand. Accepts:
 *
 *   motebit-verify content-artifact <body-file> --manifest <header-or-path>
 *                                    [--expect <artifact-type>]
 *                                    [--producer-key <hex>]
 *                                    [--json]
 *
 * `--manifest` accepts EITHER a base64url-encoded canonical-JSON value
 * (as emitted in the `X-Motebit-Content-Manifest` HTTP header) OR a
 * filesystem path to a JSON file. Auto-detected by checking if the
 * value parses as JSON when treated as a path; on filesystem read
 * failure, falls back to base64url-header interpretation.
 *
 * `--producer-key` (optional) pins the expected producer's hex public
 * key (32 bytes / 64 hex chars). When set, the CLI rejects with
 * `producer_key_mismatch` if the manifest's declared key differs —
 * the offline trust-anchor primitive (a verifier who has pinned the
 * relay's pubkey from `/.well-known/motebit-transparency.json` can
 * confirm the producer matches).
 *
 * `--expect` (optional) narrows to a member of the `ContentArtifactType`
 * registry; mirrors the closed-registry pattern of the credential-
 * mode `--expect`.
 */
function parseContentArtifactArgs(argv: readonly string[]): ParsedArgs {
  let file: string | undefined;
  let manifest: string | undefined;
  let expectedArtifactType: ContentArtifactType | undefined;
  let expectedProducerKey: string | undefined;
  let json = false;
  let help = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        i++;
        break;
      case "--json":
        json = true;
        i++;
        break;
      case "--manifest": {
        const value = argv[i + 1];
        if (value === undefined) return usage("--manifest requires a value (header or file path)");
        manifest = value;
        i += 2;
        break;
      }
      case "--expect":
      case "--expected-type": {
        const value = argv[i + 1];
        if (value === undefined) return usage(`${arg} requires a value`);
        if (!isContentArtifactType(value)) {
          return usage(
            `unknown --expect value "${value}" (valid: ${ALL_CONTENT_ARTIFACT_TYPES.join(", ")})`,
          );
        }
        expectedArtifactType = value;
        i += 2;
        break;
      }
      case "--producer-key": {
        const value = argv[i + 1];
        if (value === undefined) return usage("--producer-key requires a hex value");
        if (!/^[0-9a-fA-F]{64}$/.test(value)) {
          return usage("--producer-key must be 64 hex characters (32-byte Ed25519 public key)");
        }
        expectedProducerKey = value.toLowerCase();
        i += 2;
        break;
      }
      default:
        if (arg.startsWith("-")) return usage(`unknown flag: ${arg}`);
        if (file !== undefined) {
          return usage(
            `expected exactly one body-file argument, got a second: "${arg}" (after "${file}")`,
          );
        }
        file = arg;
        i++;
        break;
    }
  }

  if (help) return { mode: "help", json };
  if (file === undefined) return usage("content-artifact: missing body-file argument");
  if (manifest === undefined) return usage("content-artifact: --manifest is required");

  return {
    mode: "verify-content-artifact",
    file,
    manifest,
    json,
    ...(expectedArtifactType !== undefined && { expectedArtifactType }),
    ...(expectedProducerKey !== undefined && { expectedProducerKey }),
  };
}

function renderHelp(): string {
  return [
    "motebit-verify — verify any signed Motebit artifact offline.",
    "",
    "USAGE",
    "  motebit-verify <path> [options]",
    "  motebit-verify content-artifact <body-file> --manifest <header-or-path> [options]",
    "",
    "  <path> may be a single file (identity, receipt, credential, presentation,",
    "  or a skill envelope JSON) OR a skill directory containing SKILL.md +",
    "  skill-envelope.json (plus any auxiliary files declared in",
    "  envelope.files[]). Skill directories run the full envelope-sig +",
    "  body-hash + per-file-hash cross-check; single-file inputs run the",
    "  artifact's own signature check.",
    "",
    "  `content-artifact` mode verifies a C2PA-shape relay-asserted",
    "  manifest (e.g. the `X-Motebit-Content-Manifest` HTTP header emitted",
    "  on every state-export endpoint) against the response-body bytes",
    "  it covers. Two-step check: SHA-256 content-hash recomputation +",
    "  Ed25519 signature verification against the manifest's declared",
    "  producer key. Offline by design; pin the producer key with",
    `  --producer-key from /.well-known/motebit-transparency.json.`,
    "",
    "OPTIONS",
    "  --json                    Print structured JSON instead of human-readable.",
    "  --expect <type>           Require the artifact to be of the named type.",
    "  --clock-skew <seconds>    Allow N seconds of clock skew.",
    "  --bundle-id <id>          Override the expected iOS bundle ID for App Attest",
    "                            (default: com.motebit.mobile).",
    "  --android-attestation-application-id <path>",
    "                            Path to a binary file containing the raw bytes",
    "                            of the leaf cert's `attestationApplicationId`",
    "                            extension value. REQUIRED to verify any",
    "                            `android_keystore` credential — without it,",
    "                            the Android Keystore arm is not wired and",
    "                            the dispatcher reports 'verifier not wired'.",
    "                            Capture once at build time from the registered",
    "                            Android package + signing-cert hash; commit",
    "                            alongside other pinned config.",
    "  --rp-id <id>              Override the expected WebAuthn Relying Party ID",
    "                            (default: motebit.com).",
    "",
    "  CONTENT-ARTIFACT MODE — `motebit-verify content-artifact <body> ...`",
    "  --manifest <header-or-path>",
    "                            Either a base64url-encoded canonical-JSON",
    "                            manifest value (the form emitted in the",
    "                            X-Motebit-Content-Manifest HTTP header) OR a",
    "                            filesystem path to a JSON manifest file.",
    "                            Auto-detected.",
    "  --producer-key <hex>      Pin the expected producer's Ed25519 public",
    "                            key (64 hex chars). When set, rejects with",
    "                            producer_key_mismatch if the manifest's",
    "                            declared key differs. Pair with a key fetched",
    "                            from /.well-known/motebit-transparency.json",
    "                            for offline trust-anchor enforcement.",
    "  --expect <artifact-type>  In content-artifact mode, narrows to a member",
    "                            of the ContentArtifactType registry",
    `                            (${ALL_CONTENT_ARTIFACT_TYPES.length} types today; see @motebit/protocol).`,
    "",
    "  -h, --help                Show this help.",
    "  -V, --version             Print version.",
    "",
    "EXIT CODES",
    "  0  Artifact verified (including hardware-attestation channel).",
    "  1  Artifact invalid (signature, expiry, hardware-channel chain / nonce / bundle).",
    "  2  Usage or I/O error.",
    "",
    "PLATFORMS WIRED (canonical)",
    "  device_check       Apple App Attest (pinned Apple root)",
    "  tpm                TPM 2.0 (pinned Infineon / Nuvoton / STMicro / Intel PTT roots)",
    "  android_keystore   Android Hardware-Backed Keystore Attestation",
    "                     (pinned Google attestation roots; requires",
    "                     --android-attestation-application-id)",
    "  webauthn           WebAuthn packed attestation (pinned Apple / Yubico / Microsoft)",
    "",
    "PLATFORMS REMOVED",
    "  play_integrity     Google Play Integrity adapter was removed 2026-05-03.",
    "                     Credentials carrying this platform now hit the canonical",
    "                     dispatcher's fail-closed 'verifier not wired' branch.",
    "                     Use @motebit/crypto-android-keystore instead — see",
    "                     docs/doctrine/hardware-attestation.md § 'Three",
    "                     architectural categories' for the structural reason.",
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

/**
 * Decode the `--manifest` argument. Tries the value as a filesystem
 * path first; if the file exists and parses as JSON, returns that.
 * Otherwise, treats it as a base64url-encoded canonical-JSON
 * representation (the form `services/relay/src/state-export.ts` emits
 * in the `X-Motebit-Content-Manifest` HTTP header). Returns the
 * parsed manifest object or a usage error.
 *
 * Auto-detect order matters: a base64url string could in principle be
 * a legal path on disk, but the path-first try is bounded (readFileSync
 * + JSON.parse) and falls through silently to header-decode. The
 * inverse — treating every input as header bytes — would accidentally
 * succeed on JSON files whose contents happen to base64-decode as
 * arbitrary bytes, returning malformed garbage.
 */
export function decodeManifestInput(
  value: string,
): { ok: true; manifest: ContentArtifactManifest } | { ok: false; error: string } {
  // Path-first: if the value looks like a path and readable as JSON, use that.
  try {
    const fileContents = readFileSync(value, "utf-8");
    const parsed = JSON.parse(fileContents) as ContentArtifactManifest;
    return { ok: true, manifest: parsed };
  } catch {
    // Fall through to header-decode.
  }

  // Header-form: base64url → UTF-8 → JSON. Buffer is available because
  // the CLI runs in Node ≥20 (per repo engines).
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf-8");
    if (decoded === "") {
      return { ok: false, error: "--manifest is empty or undecodable as base64url" };
    }
    const parsed = JSON.parse(decoded) as ContentArtifactManifest;
    return { ok: true, manifest: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `--manifest is neither a readable JSON file nor a valid base64url-encoded manifest: ${msg}`,
    };
  }
}

/** Failure-reason → human-readable phrase for the human-mode CLI output. */
export function describeContentArtifactReason(reason: string): string {
  switch (reason) {
    case "content_hash_mismatch":
      return "body bytes do not match the manifest's content_hash (the artifact was tampered, OR the manifest was issued for different bytes)";
    case "signature_invalid":
      return "signature does not verify against the declared producer key (manifest tampered, OR signed by a different key than the one declared)";
    case "malformed_public_key":
      return "manifest's producer_public_key is not 64 hex characters (32-byte Ed25519)";
    case "malformed_signature":
      return "manifest's signature is not valid base64url";
    case "unsupported_suite":
      return "manifest's cryptosuite is not yet implemented by this verifier (post-quantum migration pending)";
    case "producer_key_mismatch":
      return "manifest's declared producer key does not match the value pinned via --producer-key";
    case "artifact_type_mismatch":
      return "manifest's artifact_type does not match the value required via --expect";
    default:
      return reason;
  }
}

async function verifyContentArtifactCli(args: ParsedArgs, json: boolean): Promise<number> {
  if (args.file === undefined) {
    process.stderr.write(`motebit-verify: content-artifact missing body-file argument\n`);
    return 2;
  }
  if (args.manifest === undefined) {
    process.stderr.write(`motebit-verify: content-artifact requires --manifest\n`);
    return 2;
  }

  let bodyBytes: Uint8Array;
  try {
    const buf = readFileSync(args.file);
    bodyBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`motebit-verify: cannot read body-file ${args.file}: ${msg}\n`);
    return 2;
  }

  const decoded = decodeManifestInput(args.manifest);
  if (!decoded.ok) {
    process.stderr.write(`motebit-verify: ${decoded.error}\n`);
    return 2;
  }
  const manifest = decoded.manifest;

  // Pre-crypto policy checks: producer-key pin and artifact-type narrow.
  // Both bounded to bytes-level comparison — no new crypto in this
  // package per CLAUDE.md Rule 1. The primitive's failure modes stay
  // pristine; these CLI-layer rejections carry their own typed reasons.
  if (
    args.expectedProducerKey !== undefined &&
    manifest.producer_public_key.toLowerCase() !== args.expectedProducerKey
  ) {
    const result = {
      valid: false,
      reason: "producer_key_mismatch",
      expected_producer_public_key: args.expectedProducerKey,
      actual_producer_public_key: manifest.producer_public_key.toLowerCase(),
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `✗ content-artifact INVALID — ${describeContentArtifactReason(result.reason)}\n`,
      );
    }
    return 1;
  }
  if (
    args.expectedArtifactType !== undefined &&
    manifest.artifact_type !== args.expectedArtifactType
  ) {
    const result = {
      valid: false,
      reason: "artifact_type_mismatch",
      expected_artifact_type: args.expectedArtifactType,
      actual_artifact_type: manifest.artifact_type,
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `✗ content-artifact INVALID — ${describeContentArtifactReason(result.reason)}\n`,
      );
    }
    return 1;
  }

  const result = await verifyContentArtifact(manifest, bodyBytes);

  // v1.1 inner-receipt recursive verification — only when the outer
  // manifest already verified (no point auditing the inside of bytes
  // we don't trust were assembled by the relay we expected). Auto-on
  // when applicable; no flag to remember. Calm-software register:
  // surfaces a per-inner-receipt summary only when v1.1 bodies are
  // detected. Per `spec/execution-ledger-v1.md` §4.3 + closure of the
  // operator-trust gap (`docs/doctrine/nist-alignment.md` §8).
  let innerVerification: InnerReceiptsVerification | undefined;
  if (result.valid && manifest.artifact_type === "execution-ledger") {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown;
      const inner = await verifyInnerSignedReceipts(parsed);
      if (inner.applicable) innerVerification = inner;
    } catch {
      // Body parsed earlier for the outer manifest, but if v1.1 inner
      // recursion can't parse it (somehow), silently skip — the outer
      // check has already verified the bytes. v1.0 bodies and bodies
      // without `signed_receipts` set `applicable: false` and don't
      // surface a section.
    }
  }
  const innerFailed = innerVerification !== undefined && !innerVerification.allValid;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          valid: result.valid && !innerFailed,
          ...(result.reason !== undefined && { reason: result.reason }),
          manifest: {
            suite: manifest.suite,
            artifact_type: manifest.artifact_type,
            producer: manifest.producer,
            producer_public_key: manifest.producer_public_key,
            claim_generator: manifest.claim_generator,
            produced_at: manifest.produced_at,
            content_hash: manifest.content_hash,
            ...(manifest.invocation !== undefined && { invocation: manifest.invocation }),
          },
          ...(innerVerification !== undefined && { inner_receipts: innerVerification }),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (result.valid) {
      process.stdout.write(
        [
          `✓ content-artifact VERIFIED`,
          `  artifact_type    ${manifest.artifact_type}`,
          `  producer         ${manifest.producer}`,
          `  producer_key     ${manifest.producer_public_key}`,
          `  claim_generator  ${manifest.claim_generator}`,
          `  produced_at      ${manifest.produced_at}`,
          `  suite            ${manifest.suite}`,
          `  content_hash     ${manifest.content_hash}`,
          ``,
        ].join("\n"),
      );
      if (innerVerification !== undefined) {
        const allOk = innerVerification.allValid;
        process.stdout.write(
          [
            `${allOk ? "✓" : "✗"} inner receipts ${innerVerification.verifiedCount}/${innerVerification.totalCount} VERIFIED (spec: motebit/execution-ledger@1.1)`,
            ...innerVerification.results.map((r) => {
              if (r.valid) {
                return `  ✓ ${r.taskId}  motebit=${r.motebitId}${r.signerDid !== undefined ? `  signer=${r.signerDid}` : ""}`;
              }
              return `  ✗ ${r.taskId}  motebit=${r.motebitId}  reason=${r.reason ?? "unknown"}${r.detail !== undefined ? `  detail=${r.detail}` : ""}`;
            }),
            ``,
          ].join("\n"),
        );
      }
    } else {
      process.stdout.write(
        `✗ content-artifact INVALID — ${describeContentArtifactReason(result.reason ?? "unknown")}\n`,
      );
    }
  }
  // Overall validity gates on outer AND inner — a v1.1 bundle where any
  // inner receipt fails is not a clean verification, even if the relay's
  // outer signature checks out (the relay is correctly attesting bytes
  // it assembled, but those bytes contain falsified inner claims).
  return result.valid && !innerFailed ? 0 : 1;
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

  if (args.mode === "verify-content-artifact") {
    return verifyContentArtifactCli(args, args.json);
  }

  if (args.file === undefined) {
    process.stderr.write(`motebit-verify: missing file argument\n\n${renderHelp()}\n`);
    return 2;
  }

  let androidKeystoreExpectedAttestationApplicationId: Uint8Array | undefined;
  if (args.androidAttestationApplicationIdPath !== undefined) {
    try {
      const bytes = readFileSync(args.androidAttestationApplicationIdPath);
      androidKeystoreExpectedAttestationApplicationId = new Uint8Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `motebit-verify: cannot read --android-attestation-application-id at ${args.androidAttestationApplicationIdPath}: ${msg}\n`,
      );
      return 2;
    }
  }

  const hardwareAttestation = buildHardwareVerifiers({
    ...(args.bundleId !== undefined && { appAttestBundleId: args.bundleId }),
    ...(androidKeystoreExpectedAttestationApplicationId !== undefined && {
      androidKeystoreExpectedAttestationApplicationId,
    }),
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

// Entry-point guard: only run when invoked as the binary, not when
// imported by tests or programmatic consumers. Mirrors the standard
// Node ESM pattern `if (import.meta.url === pathToFileURL(argv[1]))`.
// Without this, importing cli.ts to test the pure-function helpers
// triggers main() with vitest's argv and exits the test process.
const invokedAsBinary = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    const argvFileUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === argvFileUrl;
  } catch {
    return false;
  }
})();

if (invokedAsBinary) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`motebit-verify: ${msg}\n`);
      process.exit(2);
    });
}
