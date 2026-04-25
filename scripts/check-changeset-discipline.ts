/**
 * Changeset discipline gate — enforces migration-guide authorship on
 * breaking changes AND non-empty bodies on every changeset.
 *
 * Changesets lets each contributor pick patch/minor/major on the honor
 * system. Once motebit has external consumers of `@motebit/*` packages on
 * npm, a `major` changeset without migration guidance is a broken promise:
 * someone's build breaks and they have no documented upgrade path.
 *
 * Two enforcements, both running over every pending `.changeset/*.md`:
 *
 *   1. Empty-body check (all changesets) — body must contain at least
 *      one substantive sentence after the frontmatter, and must not
 *      match the `auto-generated patch bump` stub. Empty stubs were the
 *      noise that polluted the 2026-04-23 / 24 publish runs; cleaning
 *      them up by hand each time is exactly the drift the gate exists
 *      to make impossible.
 *
 *   2. Migration-section check (major bumps only) — if any frontmatter
 *      entry declares `major`, the body must contain a non-empty
 *      `## Migration` section. Motebit's `.changeset/README.md` documents
 *      the required template (what-before, what-after, why).
 *
 * Companion: check-api-surface.ts is the other half — it fails when the
 * public API surface changes but no `major` changeset was filed. Together
 * they enforce: breaking → major changeset → migration guide. No silent
 * breakage shipped from here on out.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface ParsedChangeset {
  file: string;
  bumps: Array<{ pkg: string; level: "patch" | "minor" | "major" }>;
  body: string;
}

function parseChangeset(filename: string, content: string): ParsedChangeset {
  const bumps: ParsedChangeset["bumps"] = [];
  const frontMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontMatch) {
    return { file: filename, bumps, body: content };
  }
  const front = frontMatch[1] ?? "";
  const body = (frontMatch[2] ?? "").trim();
  for (const line of front.split("\n")) {
    const entry = line.match(/^"([^"]+)":\s*(patch|minor|major)\s*$/);
    if (entry) {
      bumps.push({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        pkg: entry[1]!,
        level: entry[2] as "patch" | "minor" | "major",
      });
    }
  }
  return { file: filename, bumps, body };
}

/**
 * Detect a non-empty Migration section. We accept both `## Migration` and
 * `### Migration` to stay lenient on heading level — what matters is that
 * the author wrote one. The section must have at least one non-whitespace
 * line after the heading, otherwise it's a placeholder that satisfies the
 * regex without teaching the consumer anything.
 */
function hasMigrationSection(body: string): boolean {
  const match = body.match(/^#{2,3}\s+Migration\s*$([\s\S]*?)(?=^#{1,6}\s|$(?![\r\n]))/ims);
  if (!match) return false;
  const section = (match[1] ?? "").trim();
  return section.length > 0;
}

/**
 * A changeset body is substantive if it has at least one non-trivial
 * sentence after the frontmatter. The threshold (30 chars after trim,
 * not just whitespace) is deliberately low — we're not policing prose
 * quality, we're catching the noise patterns that compound into
 * unreadable CHANGELOGs:
 *
 *   - empty body
 *   - "auto-generated patch bump" (changeset CLI stub when run with no input)
 *   - "patch bump" / "version bump" (lazy variants)
 *
 * Anything with a real sentence describing the change passes.
 */
const STUB_PATTERNS: ReadonlyArray<RegExp> = [
  /^auto-generated\s+patch\s+bump\.?$/i,
  /^auto-generated\s+(patch|minor|major)\s+bump\.?$/i,
  /^(patch|minor|major)\s+bump\.?$/i,
  /^version\s+bump\.?$/i,
];

function isEmptyOrStub(body: string): { empty: boolean; reason: string } {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { empty: true, reason: "body is empty" };
  }
  if (trimmed.length < 30) {
    return { empty: true, reason: `body is too short (${trimmed.length} chars; need ≥30)` };
  }
  for (const pattern of STUB_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { empty: true, reason: `body matches stub pattern \`${pattern.source}\`` };
    }
  }
  return { empty: false, reason: "" };
}

function main(): void {
  const dir = resolve(ROOT, ".changeset");
  if (!existsSync(dir)) {
    process.stderr.write("  ✓ no .changeset directory — nothing to check\n");
    return;
  }

  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "README.md" && f !== "CHANGELOG.md",
  );

  if (files.length === 0) {
    process.stderr.write("  ✓ no pending changesets — nothing to check\n");
    return;
  }

  const failures: Array<{ changeset: ParsedChangeset; reason: string }> = [];
  let majorCount = 0;
  let emptyCount = 0;

  for (const filename of files) {
    const content = readFileSync(resolve(dir, filename), "utf-8");
    const parsed = parseChangeset(filename, content);

    // Check 1 — empty/stub body (applies to every changeset).
    const emptiness = isEmptyOrStub(parsed.body);
    if (emptiness.empty) {
      failures.push({
        changeset: parsed,
        reason: `empty changeset body: ${emptiness.reason}`,
      });
      emptyCount += 1;
      continue;
    }

    // Check 2 — major bumps must include a migration section.
    const majors = parsed.bumps.filter((b) => b.level === "major");
    if (majors.length === 0) continue;
    majorCount += 1;

    if (!hasMigrationSection(parsed.body)) {
      failures.push({
        changeset: parsed,
        reason: `${majors.length} \`major\` bump(s) but no non-empty \`## Migration\` section`,
      });
      continue;
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`\nerror: ${failures.length} changeset(s) failed discipline check:\n\n`);
    for (const { changeset, reason } of failures) {
      process.stderr.write(`  .changeset/${changeset.file}\n`);
      process.stderr.write(`    ${reason}\n`);
      if (reason.startsWith("empty")) {
        const pkgs = changeset.bumps.map((b) => `${b.pkg}@${b.level}`);
        process.stderr.write(`    bumps: ${pkgs.join(", ") || "(none parsed)"}\n\n`);
      } else {
        const majors = changeset.bumps.filter((b) => b.level === "major").map((b) => b.pkg);
        process.stderr.write(`    packages: ${majors.join(", ")}\n\n`);
      }
    }
    process.stderr.write(
      "Every changeset must describe what changed in its body (≥30 chars of substance,\n" +
        "no `auto-generated patch bump` stubs). Every `major` changeset must additionally\n" +
        "include a `## Migration` section with before/after examples and a one-paragraph\n" +
        "rationale. See .changeset/README.md for the template.\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `  ✓ ${files.length} pending changeset(s), ${majorCount} with \`major\` bumps, ${emptyCount} empty — all disciplined\n`,
  );
}

main();
