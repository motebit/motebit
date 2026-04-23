/**
 * Hardware-attestation-primitive drift gate (invariant #37).
 *
 * Enforces: the canonical composer (`composeHardwareAttestationCredential`
 * in `@motebit/encryption`) and the canonical verifier
 * (`verifyHardwareAttestationClaim` in `@motebit/crypto`) are the only
 * way anyone builds or parses a `HardwareAttestationClaim`-carrying
 * `AgentTrustCredential`.
 *
 * Why this drift is real: before 2026-04-22 the CLI (`motebit attest`)
 * and the desktop surface (`mintHardwareCredential`) each composed the
 * same self-signed `AgentTrustCredential` envelope themselves — same
 * shape, same signing primitive, two copies. The sibling-boundary audit
 * consolidated them into `composeHardwareAttestationCredential`. A
 * parallel-worktree iOS / Expo surface is about to land as the third
 * consumer. A third inline copy would silently diverge the moment any
 * field on the envelope moved (a future `challenge` binding, a rotated
 * `@context` URI, a signature-scheme flip for PQ). Same for the
 * verifier side: `attestation_receipt` is a JWS-shaped `body.signature`
 * pair — anyone parsing or re-verifying that pair outside
 * `verifyHardwareAttestationClaim` opens the wire-format-vs-verifier
 * drift window.
 *
 * ── Rule A — inline composer ─────────────────────────────────────────
 *
 * A file that composes an `AgentTrustCredential` VC carrying a
 * `hardware_attestation` claim. Distinguishing signal: the literal
 * type-tuple `["VerifiableCredential", "AgentTrustCredential"]` (the
 * W3C VC 2.0 envelope shape used exclusively for hardware-attestation
 * credentials in this codebase) appearing alongside a
 * `hardware_attestation:` property-assignment (not a `?:` type
 * annotation nor a Zod-schema reference). If the file does NOT import
 * `composeHardwareAttestationCredential`, it's drift.
 *
 * Tight scope: the type-tuple pattern is distinctive to the composition
 * shape. Render-engine / market / verifier all handle `AgentTrustCredential`
 * by string match in a `case` or `type` check, never as a literal VC-
 * envelope array. Only the canonical composer + test files emit the
 * literal tuple — tests are excluded by the walker.
 *
 * ── Rule B — inline verifier ─────────────────────────────────────────
 *
 * A file that parses a `HardwareAttestationClaim.attestation_receipt`
 * (splits on `.`, base64url-decodes, verifies a P-256 signature). Any
 * `attestation_receipt` reference combined with a parsing primitive
 * (`.split(".")`, `fromBase64Url`, `verifyP256EcdsaSha256`, `p256.verify`)
 * signals this file is re-implementing the verifier. If it does NOT
 * import `verifyHardwareAttestationClaim`, it's drift.
 *
 * Allowlist is empty at landing (per convention — add entries only when
 * a real exception arises, with a named reason).
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  // Empty at landing. Adding an entry requires a one-line reason and a
  // follow-up pass named (e.g. "migration window — second canonical mint
  // path; to be collapsed by <date>"). A bare path with no reason is the
  // drift shape this gate exists to prevent.
];

interface Violation {
  file: string;
  rule: "A" | "B";
  detail: string;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "__tests__" ||
      entry === ".turbo" ||
      entry === ".next"
    )
      continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walkTypeScript(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      // Generated bundles are opaque minified strings that coincidentally
      // contain type-tuple strings; they cannot drift in a way that
      // matters because the gate-relevant shape is structural source code.
      !entry.endsWith(".generated.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Rule A predicate — a file that composes an `AgentTrustCredential` VC
 * carrying a `hardware_attestation` claim.
 *
 * The type-tuple literal `["VerifiableCredential", "AgentTrustCredential"]`
 * (whitespace-tolerant) is the distinguishing signal of the VC-envelope
 * composition shape. Combined with a `hardware_attestation:` property
 * assignment (where the value is NOT an optional-type marker — we exclude
 * `hardware_attestation?:` which is a TypeScript field declaration, and
 * we exclude Zod-schema assignments by requiring the type-tuple), a file
 * that matches both but does not import the canonical composer is drift.
 */
function matchesRuleA(source: string): boolean {
  // Type-tuple literal — whitespace tolerant. Matches:
  //   type: ["VerifiableCredential", "AgentTrustCredential"]
  //   type: [\n  "VerifiableCredential",\n  "AgentTrustCredential",\n]
  const typeTuple = /"VerifiableCredential"\s*,\s*"AgentTrustCredential"/;
  if (!typeTuple.test(source)) return false;

  // A `hardware_attestation:` property assignment. We exclude
  // `hardware_attestation?:` (type annotation, not assignment).
  // Matching `hardware_attestation\s*:` with a negative lookbehind isn't
  // available in ES without the /u flag's full lookbehind support
  // everywhere, so we do the cheap thing and scan lines.
  const lines = source.split("\n");
  let hasAssignment = false;
  for (const line of lines) {
    // Skip lines whose `hardware_attestation` appears only as a type
    // annotation (`?:`) — those are protocol type declarations, not
    // composition.
    if (/\bhardware_attestation\?\s*:/.test(line)) continue;
    if (/\bhardware_attestation\s*:/.test(line)) {
      hasAssignment = true;
      break;
    }
  }
  return hasAssignment;
}

/**
 * Rule B predicate — a file that parses or verifies an
 * `attestation_receipt`.
 *
 * The receipt is a JWS-shape (`body_b64 . signature_b64`). Anyone
 * parsing it will reference `attestation_receipt` AND one of the
 * distinguishing parse/verify primitives.
 */
function matchesRuleB(source: string): boolean {
  if (!/\battestation_receipt\b/.test(source)) return false;

  // Splitting on "." is the JWS-shape-parse primitive.
  const splitOnDot = /\battestation_receipt\b[\s\S]{0,200}\.split\s*\(\s*["']\.["']\s*\)/.test(
    source,
  );
  // Alternate signal paths — base64url decode, P-256 verify.
  const base64urlDecode = /\bfromBase64Url\s*\(/.test(source);
  const p256Verify =
    /\bverifyP256EcdsaSha256\s*\(/.test(source) ||
    /\bp256\.verify\s*\(/.test(source) ||
    /\becdsa[_-]?p256[_-]?sha256\b/i.test(source);

  return splitOnDot || (base64urlDecode && /\battestation_receipt\b/.test(source)) || p256Verify;
}

function hasCanonicalComposerImport(source: string): boolean {
  return /\bcomposeHardwareAttestationCredential\b/.test(source);
}

function hasCanonicalVerifierImport(source: string): boolean {
  return /\bverifyHardwareAttestationClaim\b/.test(source);
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const allowSet = new Set(ALLOWLIST.map((e) => e.path));

  // The canonical homes themselves must not trip the gate. They are
  // exempt by path — `packages/encryption/src/hardware-attestation-credential.ts`
  // is where the composer lives (and the file naturally contains the
  // type-tuple and `hardware_attestation:` assignment it is about to
  // sign); `packages/crypto/src/hardware-attestation.ts` is where the
  // verifier lives (and naturally parses `attestation_receipt`);
  // `packages/crypto/src/index.ts` dispatches through the verifier at
  // the VC-verify boundary.
  const canonicalHomes = new Set<string>([
    "packages/encryption/src/hardware-attestation-credential.ts",
    "packages/crypto/src/hardware-attestation.ts",
    "packages/crypto/src/index.ts",
    // `suite-dispatch.ts` is the MIT primitive layer that defines
    // `verifyP256EcdsaSha256` and mentions `attestation_receipt` in a
    // doc comment referencing the receipt's algorithm. Per the
    // @motebit/crypto CLAUDE.md rule, this file is the ONLY place
    // permitted to call raw curve primitives directly — it sits
    // below the canonical verifier, not beside it, and is therefore
    // outside the drift surface this gate defends.
    "packages/crypto/src/suite-dispatch.ts",
    // `@motebit/crypto-appattest` is the canonical App Attest verifier
    // — the BSL leaf `@motebit/crypto` delegates to when a
    // `HardwareAttestationClaim` declares `platform: "device_check"`.
    // Each platform adapter (App Attest today; TPM, Play Integrity
    // tomorrow) is the single canonical home for its platform's
    // receipt-verification policy, by the same principle that exempts
    // the Secure Enclave verifier in `@motebit/crypto/src/hardware-attestation.ts`.
    "packages/crypto-appattest/src/verify.ts",
    "packages/crypto-appattest/src/index.ts",
    "packages/crypto-appattest/src/cbor.ts",
    // `@motebit/crypto-tpm` is the canonical TPM 2.0 verifier — the
    // BSL leaf `@motebit/crypto` delegates to when a
    // `HardwareAttestationClaim` declares `platform: "tpm"`. Same
    // principle as App Attest: each platform adapter is the single
    // canonical home for its platform's receipt-verification policy,
    // exempt from the drift-gate scan by path.
    "packages/crypto-tpm/src/verify.ts",
    "packages/crypto-tpm/src/index.ts",
    "packages/crypto-tpm/src/tpm-parse.ts",
  ]);

  const scanRoots: string[] = [];
  for (const topLevel of ["apps", "packages", "services"]) {
    const top = join(ROOT, topLevel);
    let subs: string[];
    try {
      subs = readdirSync(top);
    } catch {
      continue;
    }
    for (const sub of subs) {
      const srcDir = join(top, sub, "src");
      try {
        const s = statSync(srcDir);
        if (s.isDirectory()) scanRoots.push(srcDir);
      } catch {
        /* no src dir — skip */
      }
    }
  }

  for (const root of scanRoots) {
    const files = walkTypeScript(root);
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (allowSet.has(rel)) continue;
      if (canonicalHomes.has(rel)) continue;

      const source = readFileSync(file, "utf8");

      if (matchesRuleA(source) && !hasCanonicalComposerImport(source)) {
        violations.push({
          file: rel,
          rule: "A",
          detail:
            'composes HardwareAttestationClaim VC (literal type-tuple ["VerifiableCredential", "AgentTrustCredential"] + `hardware_attestation:` subject field) without importing `composeHardwareAttestationCredential` from `@motebit/encryption`. Route the envelope through the canonical composer — it is the single source of truth shared by CLI, desktop, and the landing mobile surface.',
        });
      }

      if (matchesRuleB(source) && !hasCanonicalVerifierImport(source)) {
        violations.push({
          file: rel,
          rule: "B",
          detail:
            "parses/verifies an `attestation_receipt` (JWS-shape split, base64url decode, or P-256 signature verify) without importing `verifyHardwareAttestationClaim` from `@motebit/crypto`. Route receipt verification through the canonical verifier — it enforces body-version, algorithm, identity-key binding, and fail-closed error shape.",
        });
      }
    }
  }

  return violations;
}

function main(): void {
  console.log(
    "▸ check-hardware-attestation-primitives — the canonical composer (`composeHardwareAttestationCredential` in @motebit/encryption) and verifier (`verifyHardwareAttestationClaim` in @motebit/crypto) are the only way to build/parse a HardwareAttestationClaim-carrying AgentTrustCredential (invariant #37, added 2026-04-22 alongside the CLI+desktop consolidation and ahead of the mobile surface landing — extends the protocol-primitive doctrine to hardware-attestation judgment, prevents the third inline copy of the VC envelope and the first inline copy of the receipt parser)",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-hardware-attestation-primitives: no inline composer or verifier reinvention in scanned source (allowlist: ${ALLOWLIST.length}).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-hardware-attestation-primitives: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [Rule ${v.rule}] ${v.file}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    "Fix: delegate to `composeHardwareAttestationCredential` (for composition) or `verifyHardwareAttestationClaim` (for receipt verification). Both are exported from their canonical packages and are the single source of truth across CLI, desktop, and mobile surfaces. Inline composition or parsing diverges silently the moment the envelope shape or the receipt format evolves.",
  );
  console.error(
    "If the file legitimately needs an alternative path that can't be expressed via the canonical primitives, add it to ALLOWLIST in scripts/check-hardware-attestation-primitives.ts with a reason and a named follow-up.",
  );
  process.exit(1);
}

main();
