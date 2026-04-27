/**
 * DOCTRINE.md bullet-format drift gate.
 *
 * `DOCTRINE.md` is the canonical index of motebit's nine-document
 * derivation chain. The llms.txt generator parses its bullets at
 * generation time using a strict regex
 *
 *   N. **[FILENAME.md](FILENAME.md)** — derives X.
 *
 * This brittleness is the right tradeoff: a single canonical source
 * with no sibling-list drift between DOCTRINE.md, README, CLAUDE.md,
 * and the LLM-facing surface. The cost is that the format is
 * load-bearing: a contributor editing DOCTRINE.md for prose reasons
 * could break `pnpm build` (which runs the generator's prebuild) with
 * no early warning.
 *
 * This gate moves the failure earlier — every commit touching
 * DOCTRINE.md gets a check that the bullet format the generator
 * expects is still satisfied. Brittle-but-loud is acceptable;
 * brittle-and-late-failure isn't.
 *
 * The gate also enforces two semantic invariants:
 *   1. The chain must contain exactly 9 documents (the canonical
 *      DROPLET → CONFERENCE chain). Adding a tenth requires updating
 *      this gate's expected count, which forces a deliberate review.
 *   2. Each filename in the bullets must exist at the repo root.
 *      Catches typos and renames before the generator throws at
 *      build time.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const DOCTRINE_PATH = resolve(ROOT, "DOCTRINE.md");

/**
 * The generator's parser regex. Kept identical to the one in
 * `scripts/generate-llms-txt.ts` so a change in either location is
 * caught here before it can break the build elsewhere.
 */
const CHAIN_BULLET_RE = /^\d+\.\s+\*\*\[([^\]]+)\]\([^)]+\)\*\*\s+—\s+(.+)$/gm;

/**
 * Expected chain length. If the chain legitimately extends to ten
 * (e.g. a new foundational doc is added), update this value AND
 * append the doc to DOCTRINE.md AND ensure the filename exists at
 * the repo root. The deliberate three-way coupling is the protocol
 * that keeps the chain coherent.
 */
const EXPECTED_CHAIN_LENGTH = 9;

interface ChainEntry {
  readonly filename: string;
  readonly derives: string;
}

function parseChain(raw: string): ChainEntry[] {
  const entries: ChainEntry[] = [];
  for (const match of raw.matchAll(CHAIN_BULLET_RE)) {
    entries.push({ filename: match[1]!, derives: match[2]!.trim() });
  }
  return entries;
}

function main(): void {
  process.stderr.write(
    "▸ check-doctrine-format — DOCTRINE.md bullets match the canonical format the llms.txt generator parses (`N. **[FILENAME.md](FILENAME.md)** — derives X.`); chain length matches the expected 9; every cited filename exists at the repo root\n",
  );

  if (!existsSync(DOCTRINE_PATH)) {
    process.stderr.write(`✗ DOCTRINE.md does not exist at ${DOCTRINE_PATH}.\n`);
    process.exit(1);
  }

  const raw = readFileSync(DOCTRINE_PATH, "utf-8");
  const chain = parseChain(raw);

  const failures: string[] = [];

  // 1. Chain length matches expectation.
  if (chain.length !== EXPECTED_CHAIN_LENGTH) {
    if (chain.length === 0) {
      failures.push(
        `no chain bullets parsed. The generator's regex expects bullets in the form\n` +
          `  N. **[FILENAME.md](FILENAME.md)** — derives X.\n` +
          `Either DOCTRINE.md's bullet format changed, or the chain section is missing.`,
      );
    } else {
      failures.push(
        `parsed ${chain.length} chain bullet(s) but expected ${EXPECTED_CHAIN_LENGTH}. ` +
          `If the chain genuinely extended, update EXPECTED_CHAIN_LENGTH in this gate.`,
      );
    }
  }

  // 2. Each cited filename exists at the repo root.
  for (const entry of chain) {
    const filePath = resolve(ROOT, entry.filename);
    if (!existsSync(filePath)) {
      failures.push(`cited file does not exist at repo root: ${entry.filename}`);
    }
  }

  // 3. No duplicate filenames in the chain.
  const seen = new Set<string>();
  for (const entry of chain) {
    if (seen.has(entry.filename)) {
      failures.push(`duplicate filename in chain: ${entry.filename}`);
    }
    seen.add(entry.filename);
  }

  // 4. Every "derives" description ends with a period (catches accidental
  //    truncation; the generator emits these as bullet descriptions in
  //    llms.txt, where a missing period reads as drift).
  for (const entry of chain) {
    if (!/[.!?]$/.test(entry.derives)) {
      failures.push(
        `chain bullet for ${entry.filename} does not end with sentence punctuation: "${entry.derives.slice(0, 80)}${entry.derives.length > 80 ? "…" : ""}"`,
      );
    }
  }

  if (failures.length === 0) {
    process.stderr.write(
      `✓ check-doctrine-format: ${chain.length} chain bullet(s) match canonical format and reference existing files.\n`,
    );
    return;
  }

  process.stderr.write(`\n✗ check-doctrine-format: ${failures.length} violation(s):\n\n`);
  for (const f of failures) {
    process.stderr.write(`  • ${f}\n`);
  }
  process.stderr.write(
    "\nFix: edit DOCTRINE.md so each chain bullet uses the form\n" +
      "  `N. **[FILENAME.md](FILENAME.md)** — derives X.`\n" +
      "with a real filename and a sentence-ending period. The format is parsed by\n" +
      "scripts/generate-llms-txt.ts at build time; this gate moves the failure earlier.\n",
  );
  process.exit(1);
}

main();
