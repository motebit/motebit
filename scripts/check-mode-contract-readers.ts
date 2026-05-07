/**
 * Mode-contract readers drift gate (invariant #76).
 *
 * Enforces: every field of the `EmbodimentModeContract` interface in
 * `packages/render-engine/src/spec.ts` has at least one runtime reader
 * elsewhere in the codebase, OR sits on an explicit ALLOWLIST with a
 * named reason. Closes the doctrine-to-code asymmetry where a freshly-
 * landed contract declares N invariants but only one is consumed
 * (decorative type vs. load-bearing contract).
 *
 * ## Why this gate exists
 *
 * `EMBODIMENT_MODE_CONTRACTS` declares six invariants per embodiment
 * mode (`driver`, `observer`, `source`, `consent`, `sensitivity`,
 * `lifecycleDefaults`). Compile-time enforcement (the `satisfies
 * Record<EmbodimentMode, EmbodimentModeContract>` clause) prevents
 * field omission per mode, but it can't prevent the contract from
 * growing decorative. A field shipped without a reader is doctrine in
 * code, not driving behavior.
 *
 * The contract's own JSDoc names the canonical readers it expects:
 * "the canonical authority for any consumer (slab controller,
 * tool-policy registry, future drift gates) reasoning about what a
 * mode permits." Today only `lifecycleDefaults` is consumed (the
 * `SlabController` anomaly check, ebb232dd). The other five fields
 * are typed-but-passive. This gate makes that asymmetry observable
 * in CI and forces future field additions to ship with consumers OR
 * an explicit deferral reason.
 *
 * ## What this scans
 *
 * 1. Parses `packages/render-engine/src/spec.ts` for the field set —
 *    every `readonly <name>:` line inside the `interface
 *    EmbodimentModeContract { ... }` body. Dynamic extraction so a
 *    new field can't bypass the gate by being added without a reader.
 *
 * 2. Walks the workspace for files that import `EMBODIMENT_MODE_CONTRACTS`
 *    or `EmbodimentModeContract` (excluding the registry definition
 *    itself, tests, dist, generated bundles, and node_modules).
 *
 * 3. Within each such file, strips block + line comments and counts
 *    occurrences of each field name — both `.<field>` property
 *    accesses and bare `<field>` (covers destructuring like
 *    `const { lifecycleDefaults } = contract`).
 *
 * 4. Each field needs ≥1 file with ≥1 occurrence, OR an `ALLOWLIST`
 *    entry below.
 *
 * ## Allowlist tightening discipline
 *
 * An allowlist entry that GAINS a reader fails the gate ("entry now
 * has consumers; remove from allowlist"). This matches the
 * `check-tool-modes` pattern: the allowlist is visible debt that
 * future PRs eat down, never coast on.
 *
 * ## Usage
 *
 *   tsx scripts/check-mode-contract-readers.ts   # exit 1 on any drift
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SPEC_PATH = join(ROOT, "packages/render-engine/src/spec.ts");

interface AllowlistEntry {
  field: string;
  reason: string;
}

/**
 * Fields that legitimately have no runtime readers today, with the
 * specific consumer each is waiting on. Each entry is visible debt:
 * future PRs add the consumer and drop the entry. The gate fails if
 * an allowlisted field gains a reader (entry is stale) or if a
 * non-allowlisted field has zero readers (decoration shipped).
 *
 * Doctrine: motebit-computer.md §"Mode contract." The contract names
 * each field as a typed declaration; load-bearing-ness is the
 * follow-on work for each.
 */
const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  {
    field: "driver",
    reason:
      "deferred until a UX surface (the slab item card or its hover state) renders the driver — useful when distinguishing user-driven shared_gaze items from motebit-driven tool_result items at a glance",
  },
  {
    field: "observer",
    reason:
      "deferred until the same UX consumer that lights up `driver` lands — driver and observer pair conceptually as 'who acts vs who watches' on the slab item",
  },
  {
    field: "source",
    reason:
      "deferred until the policy gate's per-source consent flow (per the `shared_gaze` mode's `per-source` consent semantics) reads it as the consent key — pairs naturally with the `consent` reader",
  },
  {
    field: "consent",
    reason:
      "deferred until the policy gate cross-references `EMBODIMENT_MODE_CONTRACTS[mode].consent` for slab-item-driven approval decisions; today the gate fires per-tool config, not per-mode contract — unifying the two is the next architectural step but needs a concrete consumer driver to scope correctly",
  },
  // `sensitivity` removed from the allowlist on 2026-05-07 when the
  // runtime's `getEffectiveSessionSensitivity` started consuming
  // `EMBODIMENT_MODE_CONTRACTS[item.mode].sensitivity`. Drops classified
  // by `scanText` tag the slab item with their tier; items in
  // `tier-bounded-by-source` modes contribute to the gate's effective
  // ceiling. The mode contract's sensitivity field is now load-bearing
  // for every AI-call entry in `motebit-runtime.ts`. See
  // `assertSensitivityPermitsAiCall` and the perception substrate
  // commits.
];

interface Violation {
  kind: "missing-reader" | "stale-allowlist";
  field: string;
  detail: string;
}

// ── Field-set extraction from the interface ─────────────────────────

function extractContractFields(specSource: string): string[] {
  // Find the interface declaration body. Tolerant to whitespace and
  // single-line vs multi-line declarations.
  const ifaceMatch = specSource.match(/interface\s+EmbodimentModeContract\s*\{([\s\S]+?)\n\}/);
  if (!ifaceMatch) {
    throw new Error(
      "check-mode-contract-readers: could not locate `interface EmbodimentModeContract` in spec.ts — has the contract moved or been renamed?",
    );
  }
  const body = ifaceMatch[1]!;
  // Strip JSDoc block comments + line comments so a doc comment
  // mentioning a field name doesn't count.
  const stripped = stripComments(body);
  const fieldRe = /readonly\s+(\w+)\s*:/g;
  const fields: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(stripped)) !== null) {
    fields.push(m[1]!);
  }
  if (fields.length === 0) {
    throw new Error(
      "check-mode-contract-readers: parsed the EmbodimentModeContract body but found no `readonly <name>:` fields — extraction regex needs an update",
    );
  }
  return fields;
}

// ── Workspace walk + reader detection ───────────────────────────────

const SCAN_ROOTS = ["packages", "apps", "services"] as const;
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo", "__tests__"]);

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;
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
      !entry.endsWith(".generated.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Files that import `EMBODIMENT_MODE_CONTRACTS` or `EmbodimentModeContract`.
 * Only files in this set count toward reader detection — narrows the scope
 * so common identifier names (`source`, `sensitivity`) don't false-positive
 * via unrelated code.
 */
function findContractImporters(): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  for (const root of SCAN_ROOTS) {
    const rootDir = join(ROOT, root);
    const files = walkTypeScript(rootDir);
    for (const file of files) {
      // Skip the registry definition itself.
      if (file === SPEC_PATH) continue;
      const source = readFileSync(file, "utf8");
      const stripped = stripComments(source);
      if (
        !/\bEMBODIMENT_MODE_CONTRACTS\b/.test(stripped) &&
        !/\bEmbodimentModeContract\b/.test(stripped)
      ) {
        continue;
      }
      out.push({ path: file, source: stripped });
    }
  }
  return out;
}

/**
 * Detect reads of `field` within a single (already-stripped) source.
 * Two patterns:
 *
 *   1. Property access: `.field` (covers `contract.field`,
 *      `EMBODIMENT_MODE_CONTRACTS[mode].field`, etc.)
 *
 *   2. Destructuring: `{ field }` or `{ field,` or `{ field:` —
 *      `const { field } = contract`. Word-boundary anchored so partial
 *      matches don't trip.
 */
function fileReadsField(source: string, field: string): boolean {
  const propRe = new RegExp(`\\.${field}\\b`);
  if (propRe.test(source)) return true;
  // Destructuring: detect `field` inside `{ ... }` adjacent context.
  // Simpler heuristic: a bare `field` followed by `,` `}` or whitespace
  // and assignment, AND the file mentions a contract identifier.
  const destructureRe = new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}`);
  return destructureRe.test(source);
}

// ── Main ────────────────────────────────────────────────────────────

function scan(): { fields: string[]; violations: Violation[]; readerCounts: Map<string, number> } {
  const specSource = readFileSync(SPEC_PATH, "utf8");
  const fields = extractContractFields(specSource);
  const importers = findContractImporters();
  const allowlistFields = new Set(ALLOWLIST.map((e) => e.field));
  const readerCounts = new Map<string, number>();
  const violations: Violation[] = [];

  for (const field of fields) {
    let readerFiles = 0;
    for (const { source } of importers) {
      if (fileReadsField(source, field)) readerFiles++;
    }
    readerCounts.set(field, readerFiles);

    if (readerFiles === 0 && !allowlistFields.has(field)) {
      violations.push({
        kind: "missing-reader",
        field,
        detail: `field "${field}" has no runtime readers — contract decoration. Either wire a consumer or add an ALLOWLIST entry with a "deferred until X" reason.`,
      });
    }
    if (readerFiles > 0 && allowlistFields.has(field)) {
      violations.push({
        kind: "stale-allowlist",
        field,
        detail: `field "${field}" is on the ALLOWLIST but has ${readerFiles} runtime reader(s) — drop the allowlist entry. Visible debt has been paid.`,
      });
    }
  }

  return { fields, violations, readerCounts };
}

function main(): void {
  console.log(
    "▸ check-mode-contract-readers — every field of the `EmbodimentModeContract` interface (driver / observer / source / consent / sensitivity / lifecycleDefaults) has ≥1 runtime reader OR an explicit ALLOWLIST entry with a `deferred until X` reason; closes the doctrine-to-code asymmetry where the contract's six invariants are compile-time enforced but only `lifecycleDefaults` is actually consumed (slab-controller anomaly check). Allowlist entries are visible debt; future PRs eat them down as concrete consumers arrive (invariant #76, added 2026-05-07 as the load-bearing-ness gate paired with the EMBODIMENT_MODE_CONTRACTS landing in commit c947ff15)",
  );
  const { fields, violations, readerCounts } = scan();

  if (violations.length === 0) {
    const breakdown = fields.map((f) => `${f}=${readerCounts.get(f) ?? 0}`).join(", ");
    console.log(
      `✓ check-mode-contract-readers: every contract field has a reader or allowlist entry. Reader counts: ${breakdown}. Allowlist size: ${ALLOWLIST.length} (visible debt to pay down).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-mode-contract-readers: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.detail}`);
  }
  console.error("\nFix path:");
  console.error(
    "  - missing-reader: either add a real consumer reading `EMBODIMENT_MODE_CONTRACTS[mode].<field>` (or `contract.<field>`), or add the field to ALLOWLIST in scripts/check-mode-contract-readers.ts with a one-line reason naming the consumer it's deferred for.",
  );
  console.error(
    "  - stale-allowlist: remove the ALLOWLIST entry — the field has earned its consumer.",
  );
  process.exit(1);
}

main();
