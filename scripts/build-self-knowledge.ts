/**
 * Build the interior-knowledge corpus for @motebit/self-knowledge.
 *
 * Walks the four top-level self-description docs, splits each on headings,
 * tokenizes every chunk with the same function the query side uses, and
 * writes `packages/self-knowledge/src/corpus-data.ts` as a TypeScript module
 * exporting `CORPUS_INDEX`.
 *
 * The TypeScript-module output (rather than JSON + import assertion) is
 * deliberate: every bundler in motebit (tsc, vite, esbuild) handles a plain
 * `export const` transparently, and there is no import-attribute ambiguity.
 *
 * Deterministic: identical sources produce byte-identical output. The
 * corpus carries a SHA-256 hash over the concatenated sources so a drift
 * check could later verify the committed corpus matches the tree.
 *
 * Run via `pnpm build-self-knowledge`.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { tokenize } from "../packages/self-knowledge/src/tokenize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

interface RawChunk {
  source: string;
  title: string;
  content: string;
}

interface IndexedChunk {
  id: string;
  source: string;
  title: string;
  content: string;
  termFrequencies: Record<string, number>;
  length: number;
}

// The four sources that describe what a motebit IS, as committed at the repo
// root. Order matters for determinism — the corpus layout follows this array.
const SOURCES = [
  "README.md",
  "DROPLET.md",
  "THE_SOVEREIGN_INTERIOR.md",
  "THE_METABOLIC_PRINCIPLE.md",
] as const;

/** Normalize a heading into a URL-safe slug. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Split a markdown source into heading-delimited chunks. The preamble
 * before the first heading becomes its own chunk using the filename as
 * the title. Code fences are preserved inside chunks — they're still
 * searchable text.
 */
function splitByHeading(source: string, content: string): RawChunk[] {
  const lines = content.split("\n");
  const chunks: RawChunk[] = [];
  let currentTitle = source.replace(/\.md$/, "");
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join("\n").trim();
    if (body.length > 0) {
      chunks.push({ source, title: currentTitle, content: body });
    }
    buffer = [];
  };

  for (const line of lines) {
    // Collapse any level (#, ##, ###, ####) — the first level seen starts a chunk.
    const headingMatch = /^#{1,4}\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[1]!.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

/** Index a raw chunk — pre-compute term frequencies and length. */
function indexChunk(chunk: RawChunk): IndexedChunk {
  const tokens = tokenize(chunk.content);
  const termFrequencies: Record<string, number> = {};
  for (const t of tokens) {
    termFrequencies[t] = (termFrequencies[t] ?? 0) + 1;
  }
  return {
    id: `${chunk.source}#${slugify(chunk.title)}`,
    source: chunk.source,
    title: chunk.title,
    content: chunk.content,
    termFrequencies,
    length: tokens.length,
  };
}

function run(): void {
  // 1. Load all source docs. Fail loud on a missing source — silent omission
  //    would silently shrink the corpus without any signal to the caller.
  const loaded: Array<{ source: string; content: string }> = [];
  for (const source of SOURCES) {
    const path = join(ROOT, source);
    try {
      const content = readFileSync(path, "utf-8");
      loaded.push({ source, content });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`build-self-knowledge: cannot read ${source}: ${msg}`);
    }
  }

  // 2. Chunk + index.
  const chunks: IndexedChunk[] = [];
  for (const { source, content } of loaded) {
    for (const raw of splitByHeading(source, content)) {
      const indexed = indexChunk(raw);
      if (indexed.length === 0) continue; // skip empty-after-stopwords chunks
      chunks.push(indexed);
    }
  }

  // 3. Corpus-wide statistics for BM25.
  const documentFrequencies: Record<string, number> = {};
  for (const chunk of chunks) {
    for (const token of Object.keys(chunk.termFrequencies)) {
      documentFrequencies[token] = (documentFrequencies[token] ?? 0) + 1;
    }
  }
  const averageLength =
    chunks.length === 0 ? 0 : chunks.reduce((acc, c) => acc + c.length, 0) / chunks.length;

  // 4. Source hash — over the concatenation, so any doc edit changes it.
  const hasher = createHash("sha256");
  for (const { source, content } of loaded) {
    hasher.update(`\n--- ${source} ---\n`);
    hasher.update(content);
  }
  const sourceHash = hasher.digest("hex");

  // Deterministic output — freeze timestamp to the source hash. If sources
  // haven't changed, the file is byte-identical, which keeps diffs noise-free
  // and lets check-self-knowledge-corpus (future drift gate) be deterministic.
  const generatedAt = `sha256:${sourceHash.slice(0, 16)}`;

  // 5. Emit TS module.
  const header = [
    "// AUTO-GENERATED by scripts/build-self-knowledge.ts — DO NOT EDIT.",
    "// Regenerate via `pnpm build-self-knowledge` after editing any of:",
    ...SOURCES.map((s) => `//   ${s}`),
    "// The query path in src/index.ts imports CORPUS_INDEX from this module.",
    "",
    'import type { CorpusIndex } from "./types.js";',
    "",
    "export const CORPUS_INDEX: CorpusIndex = ",
  ].join("\n");

  const corpusIndex = {
    chunks,
    documentFrequencies,
    averageLength,
    totalDocuments: chunks.length,
    sourceHash,
    generatedAt,
  };

  // `JSON.stringify` is deterministic for this shape (no Maps, no undefined
  // values inside objects). Trailing semicolon + newline for editor/eslint
  // compatibility.
  const serialized = JSON.stringify(corpusIndex, null, 2);
  const out = `${header}${serialized};\n`;

  const target = join(ROOT, "packages/self-knowledge/src/corpus-data.ts");
  writeFileSync(target, out, "utf-8");

  // eslint-disable-next-line no-console
  console.log(
    `build-self-knowledge: wrote ${chunks.length} chunks, sourceHash=${sourceHash.slice(0, 16)}…`,
  );
}

run();
