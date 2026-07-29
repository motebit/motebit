/**
 * Self-knowledge corpus freshness drift gate.
 *
 * `packages/self-knowledge/src/corpus-data.ts` is the committed BM25
 * corpus the RUNTIME queries as its own self-description
 * (`querySelfKnowledge` — the agent's answer to "what am I?"). It is
 * generated from the four root self-description docs by
 * `scripts/build-self-knowledge.ts`.
 *
 * The pre-existing drift class (found 2026-07-25): editing README.md /
 * DROPLET.md / THE_SOVEREIGN_INTERIOR.md / THE_METABOLIC_PRINCIPLE.md
 * without regenerating silently left the runtime describing itself with
 * OUTDATED text — and a generator↔artifact format mismatch (raw
 * JSON.stringify vs the commit hook's prettier pass) made regeneration an
 * 8k-line phantom reformat, so nothing could byte-compare. The generator
 * now formats its own output with the repo prettier config; this gate
 * regenerates in-process (pure — no writes) and byte-compares against the
 * committed artifact. Same shape as `check-llms-txt-fresh` — the
 * freshness pattern applied to the interior's self-description surface.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { generateCorpusModule, CORPUS_TARGET } from "./build-self-knowledge.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function main(): Promise<void> {
  const target = join(ROOT, CORPUS_TARGET);
  const expected = await generateCorpusModule();

  if (!existsSync(target)) {
    console.error(`✗ check-self-knowledge-corpus-fresh: ${CORPUS_TARGET} does not exist.`);
    console.error(
      `  Canonical source: scripts/build-self-knowledge.ts over the root self-description docs.`,
    );
    console.error(`  Fix: run \`pnpm build-self-knowledge\` and commit ${CORPUS_TARGET}.`);
    process.exit(1);
  }

  const committed = readFileSync(target, "utf-8");
  if (committed === expected) {
    const hash = /sourceHash: "([0-9a-f]{16})/.exec(committed)?.[1] ?? "?";
    console.log(
      `✓ check-self-knowledge-corpus-fresh: ${CORPUS_TARGET} matches regeneration from current sources (sourceHash=${hash}…).`,
    );
    return;
  }

  const committedBytes = Buffer.byteLength(committed, "utf-8");
  const expectedBytes = Buffer.byteLength(expected, "utf-8");
  console.error(
    `✗ check-self-knowledge-corpus-fresh: ${CORPUS_TARGET} is STALE — the runtime's self-description no longer matches its source docs.`,
  );
  console.error(
    `  Committed ${committedBytes} bytes; regeneration from the current root docs would write ${expectedBytes} bytes (delta ${expectedBytes - committedBytes}).`,
  );
  console.error(
    `  Canonical source: scripts/build-self-knowledge.ts over README.md, DROPLET.md, THE_SOVEREIGN_INTERIOR.md, THE_METABOLIC_PRINCIPLE.md.`,
  );
  console.error(
    `  Fix: run \`pnpm build-self-knowledge\` and commit the regenerated ${CORPUS_TARGET}.`,
  );
  process.exit(1);
}

void main();
