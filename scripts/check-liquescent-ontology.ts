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
 * Allowlist by file + line number covers the two LIQUESCENTIA Layer 2
 * lines (§II.2.3, lines 49 + 51) which use "a glass droplet" as a physics
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
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

interface Finding {
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
 * by design. Each entry asserts file path + line number + phrase fragment
 * so an unintended change to the line shape fails the gate even at the
 * same line number.
 */
const ALLOWLIST: ReadonlyArray<{
  readonly file: string;
  readonly line: number;
  readonly phrase: RegExp;
}> = [
  {
    file: "LIQUESCENTIA.md",
    line: 49,
    phrase: /A glass droplet in a spectrally uniform medium/,
  },
  {
    file: "LIQUESCENTIA.md",
    line: 51,
    phrase: /A glass droplet in a spectrally varied medium/,
  },
];

const ALLOWED_EXTENSIONS = new Set([".md", ".mdx", ".ts", ".tsx"]);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (EXCLUDED_PATTERNS.some((p) => p.test(full))) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

function isAllowlisted(relPath: string, lineNo: number, line: string): boolean {
  for (const entry of ALLOWLIST) {
    if (relPath === entry.file && lineNo === entry.line && entry.phrase.test(line)) {
      return true;
    }
  }
  return false;
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

function main(): void {
  const files: string[] = [];
  walk(REPO_ROOT, files);

  const findings: Finding[] = [];

  for (const absPath of files) {
    const relPath = path.relative(REPO_ROOT, absPath);
    if (EXCLUDED_FILES.has(relPath)) continue;

    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      const cleaned = stripBacktickCitations(line);

      for (const { pattern, name } of FORBIDDEN_PATTERNS) {
        if (pattern.test(cleaned)) {
          if (isAllowlisted(relPath, lineNo, line)) continue;
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

  if (findings.length === 0) {
    process.stdout.write("✓ check-liquescent-ontology — no glass-as-ontology drift found\n");
    return;
  }

  process.stderr.write(`\nFound ${findings.length} glass-as-ontology drift(s):\n\n`);
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.line}\n`);
    process.stderr.write(`    forbidden: ${f.phrase}\n`);
    process.stderr.write(`    excerpt:   ${f.excerpt}\n\n`);
  }
  process.stderr.write(
    "The motebit body is liquescent — held in the becoming-liquid state where\n" +
      "surface tension governs form. Glass-physics is borrowed for optical traits\n" +
      "only (IOR 1.22, transmission 0.94, attenuation), not ontology. The slab is\n" +
      "the body's material flattened into a plane: one body, one material.\n\n" +
      "Doctrine: DROPLET.md §V, LIQUESCENTIA.md, motebit-computer.md §291.\n" +
      "If a finding is legitimate Layer 2 physics-borrowing (e.g., 'a glass\n" +
      "droplet in a spectrally uniform medium' as a general physics statement\n" +
      "about glass-character optical bodies), add it to ALLOWLIST by file:line.\n",
  );
  process.exit(1);
}

main();
