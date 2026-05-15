#!/usr/bin/env tsx
/**
 * `check-closed-registry-canonical` — the meta-gate.
 *
 * Watches the *family* of closed-registry-coverage gates, not any
 * individual registry. Same closed-registry / structural-lock pattern
 * as the gates it watches, applied one level up:
 *
 *   1. A closed inventory of REGISTERED REGISTRIES — closed-vocabulary
 *      types in `@motebit/protocol` that motebit treats as interop
 *      law (consumed cross-package, appearing in wire format, gating
 *      cross-implementation interoperability).
 *
 *   2. For each registered registry, the gate verifies the canonical
 *      EIGHT-ARTIFACT SET is present:
 *
 *        (1) closed-type            — `export type` or `export enum`
 *                                     in the protocol source
 *        (2) frozen-iteration-array — `ALL_X` exported, `Object.freeze`d
 *        (3) type-guard             — `isX(value: unknown): value is X`
 *        (4) test-file              — `__tests__/X*.test.ts` exercising
 *                                     `ALL_X` + `isX`
 *        (5) drift-gate             — per-registry coverage gate at
 *                                     `scripts/check-X-canonical.ts`
 *                                     (or equivalent)
 *        (6) gate-registration      — entry in `GATES` in
 *                                     `scripts/check.ts`
 *        (7) perturbation-probe     — entry in
 *                                     `scripts/check-gates-effective.ts`
 *                                     proving the gate catches its drift
 *        (8) inventory-entry        — row in `docs/drift-defenses.md`
 *                                     referencing the gate's filename
 *
 *      Plus one SOFT check: at least one doctrine memo or package
 *      CLAUDE.md cites the registry by name. The soft check warns but
 *      does not fail (motebit treats some doctrine homes as package-
 *      CLAUDE.md rather than `docs/doctrine/*.md`, and the
 *      `check-doctrine-citations` gate already enforces citation-link
 *      integrity in the other direction).
 *
 *   3. Sibling-alignment with `docs/drift-defenses.md`: every
 *      registered registry's gate MUST appear in the drift-defenses
 *      inventory. The gate is the lockset for the lockset.
 *
 * **What the meta-gate does NOT replace.** Per-registry coverage gates
 * (`check-suite-declared`, `check-audience-canonical`,
 * `check-artifact-type-canonical`, `check-routing-decision-coverage`,
 * `check-sensitivity-canonical`) carry domain-specific enforcement
 * (literal-typo scans, consumer-shape verification, per-(consumer ×
 * decision-kind) coverage matrices). The meta-gate watches that those
 * gates EXIST and that their supporting artifacts are in lockstep —
 * not what they enforce. Two layers of lock: per-registry gates lock
 * the registry; the meta-gate locks the gates.
 *
 * **The closed registries that AREN'T here.** A type union being
 * closed-shaped (`export type X = "a" | "b" | "c"`) does not make it a
 * REGISTERED registry. Registration is an intentional protocol-level
 * commitment: the type is interop law, the consumer set is closed, a
 * drift would break cross-implementation correctness. Sub-axes of
 * other registries (`SuiteStatus`, `SuiteAlgorithm`), discriminated
 * payload kinds (`DropPayloadKind` — covered by `check-drop-handlers`
 * via a different pattern), and single-file dispatch unions
 * (`DisputeState` and friends today) are NOT registered. Adding a
 * registry here is a deliberate doctrine-level move:
 * `docs/doctrine/registry-pattern-canonical.md`.
 *
 * Same closed-registry / structural-lock shape as the gates it
 * watches. Adding a registry to `REGISTERED_REGISTRIES` is the
 * lattice growing one unit cell.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * A registered closed registry — interop-law typed vocabulary that
 * carries the canonical eight-artifact set. The set evolves only via
 * deliberate addition here + landing all eight artifacts in the same
 * arc.
 */
interface RegisteredRegistry {
  /** Human-readable name. Used in error messages. */
  readonly name: string;
  /**
   * Source-of-truth file (the protocol source where the closed type
   * or enum lives). Relative to repo root.
   */
  readonly sourceFile: string;
  /**
   * Where the iteration array + type guard live. Often the same as
   * `sourceFile` (e.g. `audience.ts`), sometimes a sibling
   * (`SensitivityLevel` lives in `index.ts` but its `ALL_*` and `is*`
   * live in `sensitivity.ts`).
   */
  readonly toolingFile: string;
  /** The closed-type/enum identifier (e.g. `SensitivityLevel`). */
  readonly typeName: string;
  /** The frozen iteration array identifier (e.g. `ALL_SENSITIVITY_LEVELS`). */
  readonly arrayName: string;
  /** The type guard identifier (e.g. `isSensitivityLevel`). */
  readonly guardName: string;
  /**
   * Path to the per-registry coverage gate script. Relative to repo
   * root. Per the doctrine, every registered registry has a
   * coverage gate that scans its specific consumer surface.
   */
  readonly gatePath: string;
  /**
   * The gate's registered name in `GATES` in `scripts/check.ts`. The
   * gate must appear by this name in the array.
   */
  readonly gateName: string;
  /**
   * A doctrine home — `docs/doctrine/*.md` or a package CLAUDE.md —
   * that names the registry. Soft check (warning, not failure) per
   * the gate's docstring; multiple paths accepted to handle
   * registries cited in package-CLAUDE.md rather than the doctrine
   * directory.
   */
  readonly doctrinePaths: readonly string[];
}

/**
 * The closed inventory of registered registries. Adding an entry is
 * intentional protocol-level work and requires landing all eight
 * artifacts in the same arc per
 * `docs/doctrine/registry-pattern-canonical.md`.
 */
const REGISTERED_REGISTRIES: ReadonlyArray<RegisteredRegistry> = [
  {
    name: "SuiteId",
    sourceFile: "packages/protocol/src/crypto-suite.ts",
    toolingFile: "packages/protocol/src/crypto-suite.ts",
    typeName: "SuiteId",
    arrayName: "ALL_SUITE_IDS",
    guardName: "isSuiteId",
    gatePath: "scripts/check-suite-declared.ts",
    gateName: "check-suite-declared",
    doctrinePaths: ["docs/doctrine/agility-as-role.md", "docs/doctrine/protocol-model.md"],
  },
  {
    name: "TokenAudience",
    sourceFile: "packages/protocol/src/audience.ts",
    toolingFile: "packages/protocol/src/audience.ts",
    typeName: "TokenAudience",
    arrayName: "ALL_TOKEN_AUDIENCES",
    guardName: "isTokenAudience",
    gatePath: "scripts/check-audience-canonical.ts",
    gateName: "check-audience-canonical",
    doctrinePaths: ["services/relay/CLAUDE.md"],
  },
  {
    name: "ContentArtifactType",
    sourceFile: "packages/protocol/src/artifact-type.ts",
    toolingFile: "packages/protocol/src/artifact-type.ts",
    typeName: "ContentArtifactType",
    arrayName: "ALL_CONTENT_ARTIFACT_TYPES",
    guardName: "isContentArtifactType",
    gatePath: "scripts/check-artifact-type-canonical.ts",
    gateName: "check-artifact-type-canonical",
    doctrinePaths: ["docs/doctrine/nist-alignment.md", "docs/doctrine/goal-results.md"],
  },
  {
    name: "TaskShape",
    sourceFile: "packages/protocol/src/routing.ts",
    toolingFile: "packages/protocol/src/routing.ts",
    typeName: "TaskShape",
    arrayName: "ALL_TASK_SHAPES",
    guardName: "isTaskShape",
    gatePath: "scripts/check-routing-decision-coverage.ts",
    gateName: "check-routing-decision-coverage",
    doctrinePaths: ["docs/doctrine/auto-routing-as-protocol-primitive.md"],
  },
  {
    name: "SensitivityLevel",
    // The enum lives in index.ts (historical), the tooling
    // (ALL_X + isX + algebra) lives in sensitivity.ts. Two-file
    // split is handled by the meta-gate's separate sourceFile vs
    // toolingFile fields.
    sourceFile: "packages/protocol/src/index.ts",
    toolingFile: "packages/protocol/src/sensitivity.ts",
    typeName: "SensitivityLevel",
    arrayName: "ALL_SENSITIVITY_LEVELS",
    guardName: "isSensitivityLevel",
    gatePath: "scripts/check-sensitivity-canonical.ts",
    gateName: "check-sensitivity-canonical",
    doctrinePaths: ["docs/doctrine/retention-policy.md"],
  },
  {
    name: "EventType",
    // Sixth registered registry — landed 2026-05-14, the first
    // template-growth proof of the meta-gate's claim that adding a
    // registry is mechanical. Same two-file split as
    // `SensitivityLevel` (enum in index.ts, tooling in event-type.ts).
    sourceFile: "packages/protocol/src/index.ts",
    toolingFile: "packages/protocol/src/event-type.ts",
    typeName: "EventType",
    arrayName: "ALL_EVENT_TYPES",
    guardName: "isEventType",
    gatePath: "scripts/check-event-type-canonical.ts",
    gateName: "check-event-type-canonical",
    doctrinePaths: ["docs/doctrine/registry-pattern-canonical.md"],
  },
];

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

interface Violation {
  readonly registry: string;
  readonly kind:
    | "missing_source_file"
    | "missing_type_declaration"
    | "missing_tooling_file"
    | "missing_array_export"
    | "missing_guard_export"
    | "missing_test_file"
    | "missing_gate_file"
    | "missing_gate_registration"
    | "missing_perturbation_probe"
    | "missing_inventory_entry";
  readonly detail?: string;
}

interface SoftWarning {
  readonly registry: string;
  readonly kind: "no_doctrine_citation";
  readonly detail: string;
}

function gateBasename(gatePath: string): string {
  return gatePath.split("/").pop() ?? gatePath;
}

function main(): void {
  const violations: Violation[] = [];
  const warnings: SoftWarning[] = [];

  // Load the shared sibling-alignment sources once.
  const checkTsSource = readFile("scripts/check.ts");
  const gatesEffectiveSource = readFile("scripts/check-gates-effective.ts");
  const driftDefensesSource = readFile("docs/drift-defenses.md");
  if (checkTsSource === null || gatesEffectiveSource === null || driftDefensesSource === null) {
    console.error(
      "check-closed-registry-canonical: could not read scripts/check.ts, scripts/check-gates-effective.ts, or docs/drift-defenses.md.",
    );
    console.error("Sibling-alignment cannot be validated.");
    process.exit(1);
  }

  for (const registry of REGISTERED_REGISTRIES) {
    // (1) Source file exists + contains the type declaration.
    const source = readFile(registry.sourceFile);
    if (source === null) {
      violations.push({
        registry: registry.name,
        kind: "missing_source_file",
        detail: registry.sourceFile,
      });
      continue;
    }
    // Match either `export type X` or `export enum X`.
    const typePattern = new RegExp(`^export (?:type|enum) ${registry.typeName}\\b`, "m");
    if (!typePattern.test(source)) {
      violations.push({
        registry: registry.name,
        kind: "missing_type_declaration",
        detail: `${registry.typeName} not declared in ${registry.sourceFile}`,
      });
    }

    // (2) Tooling file exists + contains ALL_X frozen export.
    const tooling =
      registry.toolingFile === registry.sourceFile ? source : readFile(registry.toolingFile);
    if (tooling === null) {
      violations.push({
        registry: registry.name,
        kind: "missing_tooling_file",
        detail: registry.toolingFile,
      });
      continue;
    }
    // Look for `export const ALL_X` followed by an `Object.freeze` call
    // somewhere in the same statement (multi-line tolerated).
    const arrayPattern = new RegExp(
      `export const ${registry.arrayName}\\b[\\s\\S]{0,200}Object\\.freeze`,
    );
    if (!arrayPattern.test(tooling)) {
      violations.push({
        registry: registry.name,
        kind: "missing_array_export",
        detail: `${registry.arrayName} not exported as a frozen array in ${registry.toolingFile}`,
      });
    }

    // (3) Guard export.
    const guardPattern = new RegExp(`export function ${registry.guardName}\\s*\\(`);
    if (!guardPattern.test(tooling)) {
      violations.push({
        registry: registry.name,
        kind: "missing_guard_export",
        detail: `${registry.guardName} not exported as a type guard in ${registry.toolingFile}`,
      });
    }

    // (4) Test file. Scan the protocol's __tests__ dir for any
    // *.test.ts file that exercises ALL_X + isX (textual scan — the
    // test filename is not enforced, only that some test exercises
    // both identifiers). Globbing the directory rather than
    // hardcoding paths so a new registry's test file is picked up
    // automatically as long as it lives in __tests__/.
    const testsDir = "packages/protocol/src/__tests__";
    let testFiles: string[] = [];
    try {
      testFiles = readdirSync(resolve(ROOT, testsDir))
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => `${testsDir}/${name}`);
    } catch {
      testFiles = [];
    }
    const testFound = testFiles.some((tf) => {
      const tsrc = readFile(tf);
      if (tsrc === null) return false;
      return tsrc.includes(registry.arrayName) && tsrc.includes(registry.guardName);
    });
    if (!testFound) {
      violations.push({
        registry: registry.name,
        kind: "missing_test_file",
        detail: `no __tests__/*.test.ts file exercises both ${registry.arrayName} and ${registry.guardName}`,
      });
    }

    // (5) Gate file exists.
    const gateSource = readFile(registry.gatePath);
    if (gateSource === null) {
      violations.push({
        registry: registry.name,
        kind: "missing_gate_file",
        detail: registry.gatePath,
      });
    }

    // (6) Gate is registered in scripts/check.ts.
    const checkRegistrationPattern = new RegExp(`name:\\s*["']${registry.gateName}["']`);
    if (!checkRegistrationPattern.test(checkTsSource)) {
      violations.push({
        registry: registry.name,
        kind: "missing_gate_registration",
        detail: `${registry.gateName} not registered in scripts/check.ts GATES`,
      });
    }

    // (7) Perturbation probe in check-gates-effective.
    const probePattern = new RegExp(`script:\\s*["']${registry.gateName}["']`);
    if (!probePattern.test(gatesEffectiveSource)) {
      violations.push({
        registry: registry.name,
        kind: "missing_perturbation_probe",
        detail: `${registry.gateName} has no perturbation probe in scripts/check-gates-effective.ts`,
      });
    }

    // (8) Drift-defenses inventory entry.
    const inventoryPattern = new RegExp(
      `\\b${gateBasename(registry.gatePath).replace(/\./g, "\\.")}`,
    );
    if (!inventoryPattern.test(driftDefensesSource)) {
      violations.push({
        registry: registry.name,
        kind: "missing_inventory_entry",
        detail: `${gateBasename(registry.gatePath)} not referenced in docs/drift-defenses.md inventory`,
      });
    }

    // SOFT: doctrine citation — at least one of the registry's named
    // doctrine homes must reference the registry by name.
    const doctrineCited = registry.doctrinePaths.some((path) => {
      const doctrine = readFile(path);
      if (doctrine === null) return false;
      return doctrine.includes(registry.typeName) || doctrine.includes(registry.arrayName);
    });
    if (!doctrineCited) {
      warnings.push({
        registry: registry.name,
        kind: "no_doctrine_citation",
        detail: `none of ${registry.doctrinePaths.join(", ")} reference ${registry.typeName} or ${registry.arrayName}`,
      });
    }
  }

  if (violations.length > 0) {
    console.error(
      `check-closed-registry-canonical: ${violations.length} artifact-set violation(s) across ${REGISTERED_REGISTRIES.length} registered registr${REGISTERED_REGISTRIES.length === 1 ? "y" : "ies"}:`,
    );
    const byRegistry = new Map<string, Violation[]>();
    for (const v of violations) {
      const list = byRegistry.get(v.registry) ?? [];
      list.push(v);
      byRegistry.set(v.registry, list);
    }
    for (const [name, list] of byRegistry) {
      console.error("");
      console.error(`  ${name}:`);
      for (const v of list) {
        console.error(`    - [${v.kind}] ${v.detail ?? "(no detail)"}`);
      }
    }
    console.error("");
    console.error("Every registered closed registry MUST have the canonical eight-artifact set.");
    console.error('Doctrine: docs/doctrine/registry-pattern-canonical.md § "The eight artifacts."');
    process.exit(1);
  }

  // Soft warnings — print but don't fail.
  if (warnings.length > 0) {
    console.error(
      `check-closed-registry-canonical: ${warnings.length} soft warning(s) (doctrine-citation, non-blocking):`,
    );
    for (const w of warnings) {
      console.error(`  - ${w.registry}: ${w.detail}`);
    }
    console.error("");
  }

  console.log(
    `✓ check-closed-registry-canonical: ${REGISTERED_REGISTRIES.length} registered registr${REGISTERED_REGISTRIES.length === 1 ? "y" : "ies"} × 8 artifact(s) — lattice meta-invariant satisfied.`,
  );
}

main();
