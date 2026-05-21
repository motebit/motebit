#!/usr/bin/env tsx
/**
 * check-property-test-floor — every package on the safety-critical
 * floor carries property-based / fuzz / mutation test coverage.
 *
 * The motebit thesis claims architectural integrity at four boundaries
 * that hand-written tests structurally cannot exhaust:
 *
 *   1. Money path — conservation invariants must hold across arbitrary
 *      operation sequences, not just hand-picked cases.
 *   2. Hardware-attestation verifiers — any single mutation in a
 *      verified receipt must yield `valid: false`; the universal
 *      cryptographic property.
 *   3. Parser boundaries — arbitrary text input must surface as a
 *      typed error, never as an untyped throw or undefined behavior.
 *   4. Semiring algebra — laws (associativity, identity, distributivity)
 *      must hold across arbitrary weighted-digraph inputs.
 *
 * For each listed package this gate enforces TWO conditions:
 *
 *   (a) `package.json` `devDependencies` declares `fast-check`.
 *   (b) at least one `.test.ts` file under `src/__tests__/` imports
 *       from `"fast-check"`.
 *
 * Pure structural check; runs in <100ms. The list is motebit-canonical
 * and additive — promoting a new safety-critical package = one entry
 * here + one properties.test.ts in the package + one fast-check
 * devDependency. Sibling shape to `check-skills-cross-surface` (#73)
 * and `check-typed-truth-perception` (#80) — closed-registry-with-list,
 * additive growth.
 *
 * Doctrine: `docs/doctrine/evals-as-attestations.md` § "What ships now"
 * (property-based tests on high-consequence surfaces); root CLAUDE.md
 * sibling-boundary rule (the four crypto-* verifiers move together);
 * `feedback_legibility_ratio` memory (every commitment ships in three
 * artifacts: code + drift gate + doctrine — this gate is the third).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

interface PackageRequirement {
  readonly path: string;
  readonly reason: string;
}

const PACKAGES_REQUIRING_PROPERTY_TESTS: ReadonlyArray<PackageRequirement> = [
  {
    path: "packages/protocol",
    reason:
      "semiring algebra (`semiring-laws.test.ts`) — laws must hold across arbitrary weighted-digraph inputs; the foundational property motebit's routing/trust/reputation algebras inherit",
  },
  {
    path: "packages/virtual-accounts",
    reason:
      "money path — conservation invariant (Σcredits − Σdebits − Σfees = Σbalances) must hold across arbitrary credit/debit/withdrawal sequences; CLAUDE.md Rules 1, 2, 6",
  },
  {
    path: "packages/skills",
    reason:
      "SKILL.md parsing — `parseSkillFile` typed-error envelope (`SkillParseError`) must hold across arbitrary input bytes including Unicode, mutations, and YAML-shaped adversarial content",
  },
  {
    path: "packages/crypto-appattest",
    reason:
      "Apple App Attest verifier — any single mutation in a verified receipt MUST yield `valid: false`; universal cryptographic property covering CBOR + chain + identity-binding segments",
  },
  {
    path: "packages/crypto-android-keystore",
    reason:
      "Android Keystore verifier — any single mutation in a verified receipt MUST yield `valid: false`; covers leaf + intermediates segments + body identity-binding",
  },
  {
    path: "packages/crypto-webauthn",
    reason:
      "WebAuthn packed-attestation verifier — any single mutation in a verified receipt MUST yield `valid: false`; covers attestation-object + clientDataJSON segments",
  },
  {
    path: "packages/crypto-tpm",
    reason:
      "TPM 2.0 quote verifier — any single mutation in a verified receipt MUST yield `valid: false`; covers all four segments (attest, signature, leaf-cert, intermediate-cert)",
  },
];

interface Failure {
  readonly pkg: string;
  readonly reason: string;
  readonly detail: string;
}

function findTestFiles(testsDir: string): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(testsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(join(testsDir, entry.name));
    }
  }
  return out;
}

function checkPackage(req: PackageRequirement): Failure | null {
  const pkgJsonPath = join(REPO_ROOT, req.path, "package.json");
  let pkgJson: { devDependencies?: Record<string, string> };
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as typeof pkgJson;
  } catch (err) {
    return {
      pkg: req.path,
      reason: req.reason,
      detail: `cannot read ${req.path}/package.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!pkgJson.devDependencies || !("fast-check" in pkgJson.devDependencies)) {
    return {
      pkg: req.path,
      reason: req.reason,
      detail: `${req.path}/package.json: devDependencies missing "fast-check"`,
    };
  }
  const testsDir = join(REPO_ROOT, req.path, "src", "__tests__");
  const testFiles = findTestFiles(testsDir);
  const hasFcImport = testFiles.some((f) => {
    try {
      return /from\s+["']fast-check["']/.test(readFileSync(f, "utf-8"));
    } catch {
      return false;
    }
  });
  if (!hasFcImport) {
    return {
      pkg: req.path,
      reason: req.reason,
      detail: `${req.path}/src/__tests__/: no .test.ts file imports from "fast-check" (devDep is declared but unused — property suite likely deleted or never landed)`,
    };
  }
  return null;
}

function main(): void {
  const failures: Failure[] = [];
  for (const req of PACKAGES_REQUIRING_PROPERTY_TESTS) {
    const f = checkPackage(req);
    if (f) failures.push(f);
  }
  console.log(
    `check-property-test-floor — ${PACKAGES_REQUIRING_PROPERTY_TESTS.length} package(s) on the safety-critical floor audited`,
  );
  if (failures.length === 0) {
    console.log("\n✓ Every listed package carries property-based / fuzz / mutation test coverage.");
    return;
  }
  console.log(`\n✗ ${failures.length} package(s) missing required property-based coverage:\n`);
  for (const f of failures) {
    console.log(`  ${f.pkg}`);
    console.log(`    why this package: ${f.reason}`);
    console.log(`    what's missing:   ${f.detail}\n`);
  }
  console.log(
    "Fix: add a property test (or fast-check fuzz test) under " +
      "<pkg>/src/__tests__/ covering the listed invariant. Canonical " +
      "templates:\n" +
      "  - state-machine invariants: packages/virtual-accounts/src/__tests__/properties.test.ts\n" +
      "  - cryptographic-mutation:   packages/crypto-appattest/src/__tests__/properties.test.ts\n" +
      "  - parser typed-envelope:    packages/skills/src/__tests__/parse-properties.test.ts\n" +
      "  - algebraic laws:           packages/protocol/src/__tests__/semiring-laws.test.ts\n" +
      "\n" +
      "Demoting a package from the safety-critical floor is a doctrine " +
      "moment — edit `PACKAGES_REQUIRING_PROPERTY_TESTS` in this script " +
      "with a commit message naming WHY the package no longer carries " +
      "that promise.",
  );
  process.exit(1);
}

main();
