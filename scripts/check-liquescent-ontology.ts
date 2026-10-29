#!/usr/bin/env tsx
/**
 * check-liquescent-ontology — drift defense for "glass-as-ontology" creep
 * across motebit doctrine, brand, and code.
 *
 * Surfaced 2026-05-17. The motebit body is liquescent — held in the
 * becoming-liquid state where surface tension governs form. Glass-physics
 * is borrowed for optical traits only (IOR 1.22, transmission 0.94,
 * attenuation), not ontology. The slab is the body's material flattened
 * into a plane: "one body, one material" per `motebit-computer.md` §291.
 *
 * The 2026-05-17 correction propagated across ~30 files in a single arc:
 * foundational doctrine (DROPLET §V, LIQUESCENTIA, SOVEREIGN_INTERIOR,
 * MUSIC_OF_MEDIUM), brand (TRADEMARK trade dress renamed "Glass Droplet
 * Creature" → "Liquescent Droplet Creature", LICENSING + CLA references),
 * public surfaces (README, CONSTITUTION with **Glass** desktop heading
 * renamed to **Droplet**, creature-compare.tsx), AI identity prompt
 * (ai-core/prompt.ts — every motebit boots with the corrected ontology),
 * render-engine + runtime + apps code comments, and two changesets.
 * Without this defense the correction rots: any future PR that introduces
 * "glass droplet" / "the motebit is glass" / "glass body" / "liquid-glass
 * plane" in body/slab context re-creates the drift.
 *
 * What this probe enforces — forbidden Layer 1 ontological claims:
 *
 *   1. "glass droplet" — the body is liquescent, not a glass object.
 *   2. "the motebit is glass" / "the motebit is a glass" — direct ontology.
 *   3. "made of glass" — material ontology claim.
 *   4. "glass body" / "glass sphere" / "glass creature" — body description
 *      that names the body as glass rather than liquescent.
 *   5. "liquid-glass plane" — slab description that breaks the "one body,
 *      one material" invariant (slab and creature are same material family).
 *   6. "Apple-Liquid-Glass" (the literal hyphenated form) — the original
 *      design-doctrine wording. Reframed to "borrows from Apple's Liquid
 *      Glass design language" — keep the design-language reference, drop
 *      the ontology claim.
 *   7. "glass-droplet trade dress" / "Glass Droplet Creature" — trade
 *      dress reference; renamed to "liquescent-droplet trade dress" /
 *      "Liquescent Droplet Creature" per TRADEMARK.md.
 *
 * What's allowed (Layer 2 physics-borrowing + non-body contexts):
 *
 *   - "glass-like" / "glass-physics" / "Apple's Liquid Glass design
 *     language" — explicit borrowing language that names the optical
 *     ancestor without claiming ontology.
 *   - "wine glass" — analogy in MUSIC_OF_MEDIUM §III.
 *   - "glass without chromatic light is invisible" — general physics
 *     statement about glass-character optical bodies (LIQUESCENTIA §V.1).
 *   - "borosilicate" — chemistry vocabulary referencing the IOR
 *     derivation source, not the body's substance.
 *   - "glasses" (AR form factor) — different word, not a regex match.
 *   - `docs/doctrine/readme-as-glass.md` — different ontology (README as
 *     transmissive-surface metaphor; doctrine deferred).
 *
 * Allowlist by file + exact line text covers the two LIQUESCENTIA Layer 2
 * lines (§II.2.3) which use "a glass droplet" as a physics
 * statement about glass-character optical bodies IN GENERAL — these
 * derive the medium's chromatic gradient from the optical behavior of
 * glass-character bodies, and the motebit is one such body OPTICALLY.
 * Removing them would break the doctrine's own physics derivation.
 *
 * Backtick citations are exempt. Phrases inside markdown inline-code
 * spans (`like this`) are CITATIONS of the forbidden vocabulary — used
 * in this gate's own description, in the drift-defenses inventory entry,
 * in CLAUDE.md/README documentation of what's forbidden. The gate strips
 * backtick-wrapped substrings before matching, so a line that quotes
 * `glass droplet` as part of explaining what's forbidden passes; a line
 * that writes `glass droplet` as ontological prose still fails.
 *
 * CHANGELOG.md files are excluded by path pattern — historical records of
 * shipped behavior at the time, not live doctrine.
 * `corpus-data.ts` is excluded — generated from canonical docs via
 * `pnpm build-self-knowledge`; runs in sync with the upstream sources
 * which this gate already scans.
 *
 * Doctrine: DROPLET.md §V, LIQUESCENTIA.md, motebit-computer.md §291,
 * memory [[liquescent-not-glass]].
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly phrase: string;
  readonly excerpt: string;
}

/**
 * Forbidden Layer 1 ontological claims. Each entry is a regex + a
 * human-readable name describing what the drift IS so the failure message
 * names the doctrine the phrase violates.
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly name: string;
}> = [
  {
    pattern: /\bglass droplet\b/i,
    name: "glass droplet (the body is a liquescent droplet, not glass)",
  },
  {
    pattern: /\bthe motebit is (a )?glass\b/i,
    name: "the motebit is glass (direct ontology claim — body is liquescent)",
  },
  {
    pattern: /\bmade of glass\b/i,
    name: "made of glass (material-ontology claim — body is liquescent)",
  },
  {
    pattern: /\bglass body\b/i,
    name: "glass body (body description — use 'liquescent body' or 'the body')",
  },
  {
    pattern: /\bglass sphere\b/i,
    name: "glass sphere (body description — use 'liquescent sphere' or 'the sphere')",
  },
  {
    pattern: /\bglass creature\b/i,
    name: "glass creature (body description — use 'liquescent creature' or 'the creature')",
  },
  {
    pattern: /\brendered as glass\b/i,
    name: "rendered as glass (ontology claim via rendering framing — use 'rendered with glass-like optical character' or 'optics borrow from glass-physics')",
  },
  {
    pattern: /\bliquid[- ]glass plane\b/i,
    name: "liquid-glass plane (slab description — slab is liquescent; one body, one material)",
  },
  {
    pattern: /\bApple-Liquid-Glass\b/,
    name:
      "Apple-Liquid-Glass (the literal hyphenated form is reframed; use " +
      '"borrows from Apple\'s Liquid Glass design language" instead — ' +
      "space-separated form is acceptable as a design-language reference)",
  },
  {
    pattern: /\bglass[- ]droplet trade dress\b/i,
    name: "glass-droplet trade dress (renamed to liquescent-droplet trade dress per TRADEMARK.md)",
  },
  {
    pattern: /Glass Droplet Creature/,
    name: "Glass Droplet Creature (renamed to Liquescent Droplet Creature per TRADEMARK.md)",
  },
];

/**
 * Files excluded entirely. The script itself contains the forbidden
 * phrases as part of its enforcement vocabulary; `readme-as-glass.md` is
 * a doctrine name with its own ontology (README-as-transmissive-surface);
 * `corpus-data.ts` is regenerated from canonical sources we already scan.
 */
const EXCLUDED_FILES = new Set<string>([
  "scripts/check-liquescent-ontology.ts",
  "packages/self-knowledge/src/corpus-data.ts",
  "docs/doctrine/readme-as-glass.md",
]);

/**
 * Paths excluded by pattern: build artifacts, deps, historical changelogs,
 * git internals.
 */
const EXCLUDED_PATTERNS: ReadonlyArray<RegExp> = [
  /\/node_modules\//,
  // An agent's isolated git worktree is a second copy of the repo (gitignored);
  // scanning it re-reports every allowlisted line under a new path.
  /\/\.claude\/worktrees\//,
  /\/dist\//,
  /\/coverage\//,
  /\/\.git\//,
  /\/\.next\//,
  /\/\.turbo\//,
  /\/\.motebit\//,
  /\/CHANGELOG\.md$/,
];

/**
 * Specific allowed occurrences: Layer 2 physics-borrowing references kept
 * by design. Each entry is anchored on the file plus the EXACT text of the
 * allowed line, compared byte-for-byte — never on a line number. An edit
 * anywhere above the line (a heading, a layer declaration) moves it and it
 * still passes; any change to the line itself, even a constant or a comma,
 * makes it a new, unallowed line and the gate fails until a reviewer
 * re-reads it and updates `text` here. An entry whose text no longer occurs
 * in its file is stale and fails the gate too, so the allowlist cannot
 * outlive the sentence it allows. Each entry must match EXACTLY ONE line of
 * its file: a verbatim copy elsewhere in the file is not allowed by the
 * entry (both copies are reported), so one review never covers two
 * placements.
 *
 * Line numbers were the anchor until 2026-10-29: adding one layer line at
 * the top of LIQUESCENTIA.md shifted both sentences by two and broke the
 * gate with no change to either sentence.
 */
export interface AllowlistEntry {
  readonly file: string;
  readonly text: string;
}

export const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  {
    file: "LIQUESCENTIA.md",
    text: "A glass droplet in a spectrally uniform medium is invisible. Transmission at 0.94 means 94% of incident light passes through. If the light entering from every direction has the same color and intensity, the transmitted light is indistinguishable from the ambient field. The droplet vanishes — not because it is absent, but because the medium offers nothing for its optics to differentiate.",
  },
  {
    file: "LIQUESCENTIA.md",
    text: "A glass droplet in a spectrally varied medium is a prism. Light entering from the warm side of the medium refracts differently than light from the cool side. The index of refraction bends the warm light into the cool region and the cool light into the warm region. Iridescence disperses the spectrum at glancing angles. Attenuation tints the transmitted light with the body's characteristic color. The droplet becomes visible precisely because the medium is not uniform.",
  },
];

const ALLOWED_EXTENSIONS = new Set([".md", ".mdx", ".ts", ".tsx"]);

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Match against the path RELATIVE to the repo root: when this checkout is
    // itself an agent worktree, every absolute path contains
    // `/.claude/worktrees/`, and matching the absolute path excluded the whole
    // repo — the gate scanned nothing and passed.
    const rel = "/" + path.relative(root, full);
    if (EXCLUDED_PATTERNS.some((p) => p.test(rel))) continue;
    if (entry.isDirectory()) {
      walk(root, full, out);
    } else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

/** The allowlist entry whose file and exact line text match, if any. */
function allowlistEntry(
  allowlist: ReadonlyArray<AllowlistEntry>,
  relPath: string,
  line: string,
): AllowlistEntry | undefined {
  return allowlist.find((entry) => relPath === entry.file && line === entry.text);
}

/**
 * Strip markdown inline-code spans (`like this`) from a line. Backtick-
 * wrapped occurrences of forbidden phrases are CITATIONS (this gate's
 * own description, drift-defense inventory entries, doctrine examples
 * naming what's forbidden), not USES. Only free-form prose mentions
 * should match the forbidden patterns.
 */
function stripBacktickCitations(line: string): string {
  return line.replace(/`[^`]+`/g, "");
}

export interface OntologyReport {
  scanned: number;
  findings: Finding[];
  /** Allowlist entries that do not match exactly one line, with the count they do match. */
  badEntries: { entry: AllowlistEntry; count: number }[];
}

/** The whole check over the tree at `root`; pure apart from reading files. */
export function checkLiquescentOntology(
  root: string,
  allowlist: ReadonlyArray<AllowlistEntry> = ALLOWLIST,
): OntologyReport {
  const files: string[] = [];
  walk(root, root, files);

  const findings: Finding[] = [];
  /** Lines in each entry's file whose text equals the entry's text. */
  const matchCount = new Map<AllowlistEntry, number>(allowlist.map((e) => [e, 0]));
  let scanned = 0;

  for (const absPath of files) {
    const relPath = path.relative(root, absPath);
    if (EXCLUDED_FILES.has(relPath)) continue;

    scanned++;
    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    for (const entry of allowlist) {
      if (entry.file !== relPath) continue;
      matchCount.set(entry, lines.filter((l) => l === entry.text).length);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      const cleaned = stripBacktickCitations(line);

      for (const { pattern, name } of FORBIDDEN_PATTERNS) {
        if (pattern.test(cleaned)) {
          const allowed = allowlistEntry(allowlist, relPath, line);
          // Allowed only while the entry pins exactly one line.
          if (allowed && matchCount.get(allowed) === 1) continue;
          findings.push({
            file: relPath,
            line: lineNo,
            phrase: name,
            excerpt: line.trim().slice(0, 200),
          });
        }
      }
    }
  }

  // An entry must match exactly one line. Zero: its sentence was edited or
  // removed, so the allowance points at nothing (stale). Two or more: a
  // verbatim copy appeared, which one reviewed entry must not cover.
  const badEntries = allowlist
    .filter((entry) => matchCount.get(entry) !== 1)
    .map((entry) => ({ entry, count: matchCount.get(entry) ?? 0 }));
  return { scanned, findings, badEntries };
}

function main(): void {
  const { scanned, findings, badEntries: stale } = checkLiquescentOntology(REPO_ROOT);

  if (findings.length === 0 && stale.length === 0) {
    process.stdout.write(
      `✓ check-liquescent-ontology — no glass-as-ontology drift found: ${scanned} file(s) scanned, ${ALLOWLIST.length} of ${ALLOWLIST.length} allowlisted line(s) matched exactly once by exact text\n`,
    );
    return;
  }

  if (findings.length > 0) {
    process.stderr.write(
      `\nFound ${findings.length} glass-as-ontology drift(s) across ${scanned} file(s) scanned:\n\n`,
    );
  }
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.line}\n`);
    process.stderr.write(`    forbidden: ${f.phrase}\n`);
    process.stderr.write(`    excerpt:   ${f.excerpt}\n\n`);
  }
  if (stale.length > 0) {
    process.stderr.write(
      `\n${stale.length} ALLOWLIST entr(ies) in scripts/check-liquescent-ontology.ts do not match exactly one line:\n\n`,
    );
    for (const { entry, count } of stale) {
      process.stderr.write(
        `  ${entry.file} — ${count} line(s) with this exact text (must be exactly 1)\n    text: ${entry.text.slice(0, 200)}\n\n`,
      );
    }
    process.stderr.write(
      "Fix: 0 lines — if the sentence was edited on purpose and is still Layer 2 physics-borrowing,\n" +
        "update the entry's `text` to the new line exactly; if it was removed, delete the entry.\n" +
        "2+ lines — remove the verbatim copy, or reword it so each placement is reviewed on its own.\n\n",
    );
  }
  process.stderr.write(
    "The motebit body is liquescent — held in the becoming-liquid state where\n" +
      "surface tension governs form. Glass-physics is borrowed for optical traits\n" +
      "only (IOR 1.22, transmission 0.94, attenuation), not ontology. The slab is\n" +
      "the body's material flattened into a plane: one body, one material.\n\n" +
      "Doctrine: DROPLET.md §V, LIQUESCENTIA.md, motebit-computer.md §291.\n" +
      "If a finding is legitimate Layer 2 physics-borrowing (e.g., 'a glass\n" +
      "droplet in a spectrally uniform medium' as a general physics statement\n" +
      "about glass-character optical bodies), add it to ALLOWLIST in\n" +
      "scripts/check-liquescent-ontology.ts by file + the line's exact text.\n",
  );
  process.exit(1);
}

// Run only when invoked directly; the unit test imports checkLiquescentOntology.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
