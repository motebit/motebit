/**
 * Disambiguation-primitive drift gate (invariant #32).
 *
 * Enforces: "pick one of several candidates by matching a fuzzy user
 * input against a string-shaped field" (voice command referents,
 * conversation-title lookup, agent-by-name dispatch, tool-name
 * matching) goes through `disambiguate` / `stringSimilaritySignal` /
 * `matchOrAsk` in `@motebit/semiring`. Inline reinvention in apps,
 * services, or sibling packages is a CI failure.
 *
 * ## Why this gate exists
 *
 * Before 2026-04-19 every surface that had to route a voice / chat /
 * REPL referent to one of a typed set of candidates (conversations by
 * title, agents by name, tools by invocation word, memories by subject)
 * wrote its own one-liner: `.find(c => c.title.toLowerCase().includes(keyword))`.
 * That shape has four structural problems:
 *
 *   1. First-match: when two candidates match the same substring, the
 *      list-order wins, not the better match.
 *   2. No exactness weight: "python" matches "python" and "python
 *      advanced" identically.
 *   3. No ambiguity surface: the caller can't distinguish "confident
 *      match" from "two equally plausible candidates" to prompt the
 *      user for clarification.
 *   4. Diverging implementations across sites — exactly the shape the
 *      semiring family of gates exists to prevent.
 *
 * `matchOrAsk` + `stringSimilaritySignal` collapse all four. The gate
 * forbids new sites from reinventing the pattern as soon as disambiguation
 * has a second consumer.
 *
 * ## Heuristic (all three required in one file)
 *
 *   1. A fuzzy-match signature: `.toLowerCase(` + `.includes(` used
 *      against either a title / name / label field. This is the
 *      fingerprint of the ad-hoc "does this candidate match the
 *      keyword" probe that every site wrote.
 *   2. A candidate-list retrieval: the scan finds `list*` / `get*` /
 *      field access returning a collection of typed records, followed
 *      by a `.find(` or `.filter(` call (this is the "pick one"
 *      shape). We look for the specific pair: a `.find(` call whose
 *      body contains `.toLowerCase(` and `.includes(`.
 *   3. No canonical import: the file does not import `matchOrAsk`,
 *      `stringSimilaritySignal`, or `disambiguate` from `@motebit/semiring`.
 *
 * ## Owning package
 *
 *   - `@motebit/semiring` (`packages/semiring/src/disambiguation.ts`).
 *
 * Allowlist empty at landing. Any future exception must add a row
 * here with the reason + follow-up pass named.
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

  // semiring is the owning package. Scan everything else.
  const OWNED = new Set(["semiring"]);
  const scanRoots = [
    join(ROOT, "apps"),
    join(ROOT, "services"),
    ...readdirSync(join(ROOT, "packages"))
      .filter((name) => !OWNED.has(name))
      .map((name) => join(ROOT, "packages", name)),
  ];

  // The heuristic's most discriminating signature: a `.find(` call whose
  // callback calls both `.toLowerCase(` and `.includes(` on a title /
  // name / label field. Multiline-dotall for the `.find(... )` block.
  const ADHOC_PICK =
    /\.find\s*\(\s*\([^)]*\)\s*=>\s*[^)]*\.toLowerCase\s*\(\s*\)[^)]*\.includes\s*\(/s;

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

        if (!ADHOC_PICK.test(source)) continue;

        const importsCanonical =
          /\bmatchOrAsk\b/.test(source) ||
          /\bstringSimilaritySignal\b/.test(source) ||
          /\bdisambiguate\b/.test(source);
        if (importsCanonical) continue;

        violations.push({
          file: rel,
          detail:
            "inline referent disambiguation — file uses `.find(c => c.<field>.toLowerCase().includes(keyword))` to pick one of a candidate list. Replace with `matchOrAsk(candidates, stringSimilaritySignal(keyword, c => c.<field>))` from `@motebit/semiring`. The primitive ranks by exact > substring > fuzzy, returns match / ambiguous / none so the caller can prompt for clarification, and composes with other signals (recency, trust) via the outer disambiguate.",
        });
      }
    }
  }
  return violations;
}

function main(): void {
  console.log(
    "▸ check-disambiguation-primitives — referent disambiguation (pick one candidate from a list by matching a fuzzy user input against a title/name/label field) lives in @motebit/semiring (matchOrAsk + stringSimilaritySignal + disambiguate), not inline in apps/services/sibling-packages (invariant #32, added 2026-04-19 as the fourth non-trivial semiring consumer — completes the endgame map's 'semiring wherever algebra is natural' line item; same drift family as #27/#28/#29/#30 — parallel scoring implementations diverging silently)",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-disambiguation-primitives: no inline referent disambiguation in scanned source (allowlist: ${ALLOWLIST.length}).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-disambiguation-primitives: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    "Fix: import `matchOrAsk` + `stringSimilaritySignal` from `@motebit/semiring` and replace the `.find(…)` call. The primitive returns `{ kind: 'match' | 'ambiguous' | 'none' }` — ambiguous lets the UI prompt the user, which the ad-hoc pattern can't distinguish from a confident single match.",
  );
  console.error(
    "If the file legitimately needs the ad-hoc shape (non-interactive dedupe, etc.), add it to ALLOWLIST in scripts/check-disambiguation-primitives.ts with the reason + follow-up pass named.",
  );
  process.exit(1);
}

main();
