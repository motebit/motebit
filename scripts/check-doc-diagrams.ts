#!/usr/bin/env tsx
/**
 * check-doc-diagrams — drift defense for docs-site SVG diagrams.
 *
 * Three assertions, in order of value:
 *
 *   (1) Every <DiagramFigure cites={[...]}> entry in the docs MDX
 *       resolves to a real `## N.` section header in the cited
 *       spec/doctrine file. Catches the rot pattern: a spec is
 *       restructured, section #5 becomes #6, the diagram cite
 *       still says #5 — the link 404s and the diagram's authority
 *       quietly evaporates.
 *
 *   (2) Every committed `apps/docs/public/diagrams/*.svg` carries
 *       a populated `<title>` and `<desc>`. Accessibility floor.
 *
 *   (3) No raw `#hex` colors in committed diagram SVGs. Dark-mode
 *       parity: every stroke/fill must bind to `currentColor` or a
 *       `var(--color-fd-*)` token from `apps/docs/src/app/global.css`.
 *
 * The `src` prop of every <DiagramFigure> must also resolve to a
 * real file under `apps/docs/public/diagrams/`. That fourth check
 * comes for free with (1)+(2): each cite is keyed to a diagram via
 * the `src` prop, and we require both ends to exist.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more violations (the printed report names them)
 *
 * Usage:
 *   pnpm check-doc-diagrams
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DOCS_CONTENT_DIR = join(REPO_ROOT, "apps", "docs", "content", "docs");
const DIAGRAMS_DIR = join(REPO_ROOT, "apps", "docs", "public", "diagrams");

interface CiteEntry {
  /** The MDX file the cite was found in. */
  readonly source: string;
  /** The diagram src= value, used for error attribution. */
  readonly diagramSrc: string;
  /** The cite's display label, used for error attribution. */
  readonly label: string;
  /** Path relative to repo root (e.g. "spec/relay-federation-v1.md"). */
  readonly file: string;
  /** Section number that must appear as `## N.` in the file. */
  readonly section: number;
}

interface DiagramFile {
  readonly path: string;
  readonly basename: string;
  readonly content: string;
}

// ── Walking ──────────────────────────────────────────────────────────────

function walkMdx(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkMdx(full));
    } else if (stat.isFile() && entry.endsWith(".mdx")) {
      out.push(full);
    }
  }
  return out;
}

function loadDiagrams(): DiagramFile[] {
  let entries: string[];
  try {
    entries = readdirSync(DIAGRAMS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".svg"))
    .map((f) => ({
      path: join(DIAGRAMS_DIR, f),
      basename: f,
      content: readFileSync(join(DIAGRAMS_DIR, f), "utf-8"),
    }));
}

// ── DiagramFigure parsing ────────────────────────────────────────────────

/**
 * Parse every <DiagramFigure ...> JSX call in an MDX file. The
 * component is regular JSX, but MDX's tolerant parser permits
 * formatting we have to handle: multi-line props, nested object
 * literals, trailing commas. We use a tag-extractor regex that
 * captures the opening tag's full prop block, then JSON5-shaped
 * literal extraction on the captured text.
 *
 * Failure mode is conservative: a malformed prop block surfaces
 * a violation with the source line, not a thrown error — the gate
 * names the problem so the author fixes the prop, not the gate.
 */
function extractDiagramFigures(
  source: string,
  content: string,
): { cites: CiteEntry[]; srcRefs: { source: string; src: string }[]; errors: string[] } {
  const cites: CiteEntry[] = [];
  const srcRefs: { source: string; src: string }[] = [];
  const errors: string[] = [];

  // Match self-closing or paired <DiagramFigure ... /> openings.
  // The body up to the first `>` of the opening tag is the prop block.
  const tagRegex = /<DiagramFigure\b([\s\S]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    const propBlock = match[1] ?? "";

    const srcMatch = propBlock.match(/\bsrc\s*=\s*"([^"]+)"/);
    if (!srcMatch || !srcMatch[1]) {
      errors.push(`${relative(REPO_ROOT, source)}: <DiagramFigure> missing required \`src\` prop`);
      continue;
    }
    const diagramSrc = srcMatch[1];
    srcRefs.push({ source, src: diagramSrc });

    // Match cites={[ ... ]} — capture the inner array contents up
    // to the matching closing `]}`. Greedy with a lookahead is
    // sufficient because each <DiagramFigure> is self-contained.
    const citesMatch = propBlock.match(/\bcites\s*=\s*\{\s*\[([\s\S]*?)\]\s*\}/);
    if (!citesMatch || !citesMatch[1]) {
      errors.push(
        `${relative(REPO_ROOT, source)}: <DiagramFigure src="${diagramSrc}"> missing \`cites\` array`,
      );
      continue;
    }
    const citesBody = citesMatch[1];

    // Each cite is `{ label: "...", file: "...", section: N, ... }`.
    // Iterate over each `{ ... }` block.
    const citeRegex = /\{([^{}]*)\}/g;
    let citeMatch: RegExpExecArray | null;
    while ((citeMatch = citeRegex.exec(citesBody)) !== null) {
      const body = citeMatch[1] ?? "";
      const labelMatch = body.match(/\blabel\s*:\s*"([^"]+)"/);
      const fileMatch = body.match(/\bfile\s*:\s*"([^"]+)"/);
      const sectionMatch = body.match(/\bsection\s*:\s*(\d+)/);
      if (!labelMatch || !fileMatch || !sectionMatch) {
        errors.push(
          `${relative(REPO_ROOT, source)}: <DiagramFigure src="${diagramSrc}"> ` +
            `cite is missing label/file/section: ${body.trim()}`,
        );
        continue;
      }
      cites.push({
        source,
        diagramSrc,
        label: labelMatch[1]!,
        file: fileMatch[1]!,
        section: Number.parseInt(sectionMatch[1]!, 10),
      });
    }
  }

  return { cites, srcRefs, errors };
}

// ── Section-header resolution ────────────────────────────────────────────

const sectionHeaderCache = new Map<string, Set<number>>();

/**
 * Return the set of section numbers (`## N.` form) defined in the
 * given file. Cached per file because multiple cites resolve to
 * the same target. Missing files surface as an empty set, which
 * the cite-check then reports as "file does not exist."
 */
function sectionsIn(file: string): Set<number> | null {
  if (sectionHeaderCache.has(file)) return sectionHeaderCache.get(file)!;
  const abs = join(REPO_ROOT, file);
  let content: string;
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
  const sections = new Set<number>();
  const headerRegex = /^##\s+(\d+)\./gm;
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(content)) !== null) {
    sections.add(Number.parseInt(match[1]!, 10));
  }
  sectionHeaderCache.set(file, sections);
  return sections;
}

// ── SVG validation ───────────────────────────────────────────────────────

interface SvgViolation {
  readonly diagram: string;
  readonly reason: string;
}

function validateSvg(diagram: DiagramFile): SvgViolation[] {
  const violations: SvgViolation[] = [];
  const { content, basename } = diagram;

  const titleMatch = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/);
  if (!titleMatch || titleMatch[1]!.trim() === "") {
    violations.push({ diagram: basename, reason: "missing or empty <title>" });
  }

  const descMatch = content.match(/<desc\b[^>]*>([\s\S]*?)<\/desc>/);
  if (!descMatch || descMatch[1]!.trim() === "") {
    violations.push({ diagram: basename, reason: "missing or empty <desc>" });
  }

  // Raw hex literal detection.
  //
  // Allowed hex sites (must be filtered out before flagging):
  //   - `url(#fragmentId)` — id reference, not a color
  //   - `var(--name, #hex)` — fallback inside a CSS custom-property
  //     reference. The fallback is only used when the variable is
  //     unresolved (standalone-SVG render path); the embedded path
  //     uses the page's CSS var. Both branches still produce a
  //     theme-bound color.
  //
  // Bad hex sites: any `fill=`/`stroke=`/`style=` attribute value
  // whose top-level color is a hard-coded hex (e.g. `fill="#000"`).
  //
  // Strategy: strip every `var(...)` call (with naive nested-paren
  // handling) from the file content, then scan for color-shaped
  // hex. The strip removes the legal hex sites; whatever remains is
  // a violation.
  const stripped = stripVarCalls(content);
  const hexLiterals = stripped.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g);
  if (hexLiterals) {
    const colorHexes = hexLiterals.filter((token) => {
      // Still exclude any hex that participates in `url(#id)`.
      const isUrl = new RegExp(`url\\(${escapeRegExp(token)}\\)`).test(stripped);
      return !isUrl;
    });
    if (colorHexes.length > 0) {
      violations.push({
        diagram: basename,
        reason:
          `raw hex color literal(s) outside var() fallback: ${[...new Set(colorHexes)].join(", ")} — ` +
          `use var(--color-fd-*, #fallback-hex) so dark mode tracks while standalone render still works`,
      });
    }
  }

  return violations;
}

/**
 * Strip `var(--name, fallback)` calls from a string. Handles one
 * level of nesting (a `var()` whose fallback is itself a `var()`).
 * The output is the input with every `var(...)` token replaced by
 * an empty string — sufficient to remove legitimate hex literals
 * carried as fallbacks.
 */
function stripVarCalls(input: string): string {
  // Two passes is enough for `var(--a, var(--b, #hex))`. Adding
  // more passes is cheap; cap at four for safety.
  let out = input;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/var\([^()]*\)/g, "");
    if (next === out) return out;
    out = next;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Main ─────────────────────────────────────────────────────────────────

function main(): void {
  const violations: string[] = [];

  // ── Phase 1: harvest cites + src refs from every .mdx ───────────────
  const mdxFiles = walkMdx(DOCS_CONTENT_DIR);
  let totalCites = 0;
  let totalDiagrams = 0;
  const diagrams = new Set<string>();

  for (const file of mdxFiles) {
    const content = readFileSync(file, "utf-8");
    const { cites, srcRefs, errors } = extractDiagramFigures(file, content);
    violations.push(...errors);
    totalCites += cites.length;
    for (const ref of srcRefs) {
      diagrams.add(ref.src);
      totalDiagrams++;
    }

    // ── Phase 2: validate each cite ─────────────────────────────────
    //
    // For `spec/*.md` files, section numbers are protocol-binding
    // (every spec uses `## N.` numbered headers); a missing section
    // is a wire-format drift the gate must catch. For doctrine,
    // README, LICENSING, and other prose files, section names
    // evolve freely — there we only verify the file exists.
    for (const cite of cites) {
      const fileExists = cite.file.startsWith("spec/")
        ? sectionsIn(cite.file)
        : (() => {
            try {
              statSync(join(REPO_ROOT, cite.file));
              return new Set<number>();
            } catch {
              return null;
            }
          })();

      if (fileExists === null) {
        violations.push(
          `${relative(REPO_ROOT, cite.source)}: ` +
            `<DiagramFigure src="${cite.diagramSrc}"> cite "${cite.label}" → ` +
            `file does not exist: ${cite.file}`,
        );
        continue;
      }

      // Strict section check for spec/ files only.
      if (cite.file.startsWith("spec/") && !fileExists.has(cite.section)) {
        violations.push(
          `${relative(REPO_ROOT, cite.source)}: ` +
            `<DiagramFigure src="${cite.diagramSrc}"> cite "${cite.label}" → ` +
            `section §${cite.section} not found in ${cite.file} ` +
            `(file has §${[...fileExists].sort((a, b) => a - b).join(", §")})`,
        );
      }
    }

    // ── Phase 3: validate each src= refers to a real diagram file ────
    for (const ref of srcRefs) {
      const expected = join(DIAGRAMS_DIR, `${ref.src}.svg`);
      try {
        statSync(expected);
      } catch {
        violations.push(
          `${relative(REPO_ROOT, ref.source)}: ` +
            `<DiagramFigure src="${ref.src}"> → ` +
            `file not found: apps/docs/public/diagrams/${ref.src}.svg`,
        );
      }
    }
  }

  // ── Phase 4: validate every committed SVG (a11y + theme bind) ──────
  const allDiagrams = loadDiagrams();
  for (const diagram of allDiagrams) {
    const svgViolations = validateSvg(diagram);
    for (const v of svgViolations) {
      violations.push(`apps/docs/public/diagrams/${v.diagram}: ${v.reason}`);
    }
  }

  // ── Report ──────────────────────────────────────────────────────────
  console.log("check-doc-diagrams:");
  console.log(`  ${mdxFiles.length} MDX files scanned`);
  console.log(`  ${totalDiagrams} <DiagramFigure> embeds found (${diagrams.size} unique src)`);
  console.log(`  ${totalCites} cite entries validated`);
  console.log(`  ${allDiagrams.length} committed SVG files validated`);

  if (violations.length === 0) {
    console.log("✓ all checks passed");
    return;
  }

  console.error(`\n✗ ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  console.error(
    `\nFix the above before merging. ` +
      `See \`docs/drift-defenses.md\` for the invariant this gate defends.`,
  );
  process.exit(1);
}

main();
