/**
 * Notability-primitive drift gate (invariant #29).
 *
 * Enforces: notability scoring (a weighted combination of decay-of-confidence
 * + graph-isolation + conflict-involvement used to pick which memories the
 * creature should reflect on) lives in `@motebit/memory-graph` (the
 * `NotabilitySemiring` + `rankNotableMemories` primitive). Inline
 * reinvention in apps, services, or sibling packages is a CI failure.
 *
 * Why this drift is real (even before a first offender): the reflection
 * engine previously had three hand-sorted categories (`phantomCertainties`,
 * `conflicts`, `nearDeath`) with hardcoded `.slice(N)` limits and
 * per-category formatting. The unified notability primitive composes
 * those dimensions algebraically via `NotabilitySemiring` (record-shaped
 * TrustSemiring over phantom/conflict/decay) so changing the reflection
 * focus is a weight edit, not a new category. The gate closes the door
 * on re-introducing hand-rolled parallel scoring as soon as a second
 * surface or service wants "which memories matter this tick".
 *
 * Heuristic (all required in one file):
 *   1. References `computeDecayedConfidence(` — the decay half-life primitive.
 *      Consumers of notability scores never call this directly; they read
 *      `NotableMemory.decayedConfidence` off the primitive's output.
 *   2. References at least TWO of: `edgeCount`, `isolated`, `orphan`,
 *      `ConflictsWith`. Two or more signals combined is the weighted-
 *      composition signature; one alone is fine (e.g. housekeeping uses
 *      decay in isolation to prune).
 *   3. Does NOT import `rankNotableMemories` or `NotabilitySemiring`
 *      from `@motebit/memory-graph` — an import indicates a consumer,
 *      not a reinventor.
 *
 * Owning package (allowed to compute notability):
 *   - @motebit/memory-graph (packages/memory-graph/src/notability.ts —
 *     the canonical home, and the existing auditMemoryGraph / retrieval
 *     paths which legitimately use the same substrates for different
 *     purposes (housekeeping pruning, audit categorization)).
 *
 * Allowlist is intentionally empty at landing. Any future exception
 * must add an entry here with the reason + follow-up pass named.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [];

interface Violation {
  file: string;
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
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__" || entry === ".turbo")
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
      !entry.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const allowSet = new Set(ALLOWLIST.map((e) => e.path));

  // memory-graph is the owning package. Everything else is scanned.
  const OWNED = new Set(["memory-graph"]);
  const scanRoots = [
    join(ROOT, "apps"),
    join(ROOT, "services"),
    ...readdirSync(join(ROOT, "packages"))
      .filter((name) => !OWNED.has(name))
      .map((name) => join(ROOT, "packages", name)),
  ];

  for (const root of scanRoots) {
    let subdirs: string[];
    try {
      subdirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      const srcDir = join(root, sub, "src");
      const files = walkTypeScript(srcDir);
      for (const file of files) {
        const rel = relative(ROOT, file);
        if (allowSet.has(rel)) continue;
        const source = readFileSync(file, "utf8");

        // Three-condition heuristic. The distinguishing signal for inline
        // notability is decay-math + multi-dimensional aggregation without
        // the canonical import.
        const refsDecayCall = /computeDecayedConfidence\s*\(/.test(source);
        if (!refsDecayCall) continue;

        const isolationSignals =
          Number(/\bedgeCount\b/.test(source)) +
          Number(/\bisolated\b/i.test(source)) +
          Number(/\borphan(ed)?\b/i.test(source)) +
          Number(/\bConflictsWith\b/.test(source));
        if (isolationSignals < 2) continue;

        const importsCanonical =
          /\brankNotableMemories\b/.test(source) || /\bNotabilitySemiring\b/.test(source);
        if (importsCanonical) continue;

        violations.push({
          file: rel,
          detail:
            "inline notability scoring — file combines decay-of-confidence with two or more of {edgeCount, isolated, orphan, ConflictsWith} without importing the canonical primitive. Use `rankNotableMemories` from `@motebit/memory-graph` instead — it composes the phantom/conflict/decay dimensions via `NotabilitySemiring` (record-shaped TrustSemiring) and returns a ranked `NotableMemory[]`.",
        });
      }
    }
  }
  return violations;
}

function main(): void {
  console.log(
    "▸ check-notability-primitives — notability scoring (weighted combination of decay + graph-isolation + conflict-involvement, used to rank memories for reflection) lives in @motebit/memory-graph (rankNotableMemories + NotabilitySemiring), not inline in apps/services/sibling-packages (invariant #29, added 2026-04-19 when the reflection engine moved from three hand-sorted categories to one algebraic ranking — extends the protocol-primitive doctrine to reflection judgment and closes the door on parallel reinvention as soon as a second consumer wants the shape)",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-notability-primitives: no inline notability scoring in scanned source (allowlist: ${ALLOWLIST.length}).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-notability-primitives: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    "Fix: import `rankNotableMemories` from `@motebit/memory-graph` and pass the live node + edge list plus any weight overrides (phantomWeight / conflictWeight / decayWeight / limit). The primitive composes the three dimensions algebraically — changing emphasis is a weight, not a new code path.",
  );
  console.error(
    "If the file legitimately needs inline scoring that can't be expressed via the canonical primitive, add it to ALLOWLIST in scripts/check-notability-primitives.ts with the reason + follow-up pass named.",
  );
  process.exit(1);
}

main();
