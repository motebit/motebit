/**
 * Changeset discipline gate — enforces migration-guide authorship on
 * breaking changes.
 *
 * Changesets lets each contributor pick patch/minor/major on the honor
 * system. Once motebit has external consumers of `@motebit/*` packages on
 * npm, a `major` changeset without migration guidance is a broken promise:
 * someone's build breaks and they have no documented upgrade path.
 *
 * This gate runs over every pending `.changeset/*.md` in the branch and
 * enforces: if any frontmatter entry declares `major`, the body must
 * contain a non-empty `## Migration` section. Motebit's `.changeset/README.md`
 * documents the required template (what-before, what-after, why).
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

  for (const filename of files) {
    const content = readFileSync(resolve(dir, filename), "utf-8");
    const parsed = parseChangeset(filename, content);

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
    process.stderr.write(
      `\nerror: ${failures.length} changeset(s) declare \`major\` bumps without a migration guide:\n\n`,
    );
    for (const { changeset, reason } of failures) {
      process.stderr.write(`  .changeset/${changeset.file}\n`);
      process.stderr.write(`    ${reason}\n`);
      const majors = changeset.bumps.filter((b) => b.level === "major").map((b) => b.pkg);
      process.stderr.write(`    packages: ${majors.join(", ")}\n\n`);
    }
    process.stderr.write(
      "Every \\`major\\` changeset must include a \\`## Migration\\` section with\n" +
        "before/after examples and a one-paragraph rationale. See .changeset/README.md\n" +
        "for the template.\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `  ✓ ${files.length} pending changeset(s), ${majorCount} with \`major\` bumps — all disciplined\n`,
  );
}

main();
