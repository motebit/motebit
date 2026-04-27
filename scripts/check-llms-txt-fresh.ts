/**
 * llms.txt + llms-full.txt freshness drift gate.
 *
 * `apps/docs/public/llms.txt` and `apps/docs/public/llms-full.txt` are
 * the canonical LLM-facing surfaces of this project — the files
 * ChatGPT / Claude / Perplexity etc. fetch to ingest motebit. They
 * are siblings of README.md and CLAUDE.md and need the same
 * sibling-boundary discipline (memory: feedback_llms_txt_as_surface).
 *
 * The pre-existing drift class: any commit that edits source MDX or
 * a foundational document without re-running the generator silently
 * produces stale LLM artifacts. The pre-push hook regenerates them
 * via the docs `prebuild` step, so the developer's working tree
 * shows changes after push — but the change is local-only; nothing
 * forces it into the commit, and the next push starts the drift over.
 *
 * This gate closes that loop. It re-runs the generator's pure logic
 * via the exported `generateLlmsArtifacts` function (no side effects
 * — does not write files), compares the would-be output against the
 * committed bytes on disk, and fails if they differ.
 *
 * The pattern mirrors `check-api-surface`: regenerate the artifact,
 * compare to baseline, fail with explicit "regenerate and commit"
 * guidance. Same shape, different artifact.
 */

import { readFileSync, existsSync } from "node:fs";
import { relative } from "node:path";

import { generateLlmsArtifacts, LLMS_TXT_PATH, LLMS_FULL_TXT_PATH } from "./generate-llms-txt.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

interface CheckResult {
  readonly path: string;
  readonly ok: boolean;
  readonly reason?: string;
}

function checkArtifact(path: string, expected: string): CheckResult {
  if (!existsSync(path)) {
    return {
      path,
      ok: false,
      reason: `does not exist`,
    };
  }
  const committed = readFileSync(path, "utf-8");
  if (committed === expected) {
    return { path, ok: true };
  }
  // Compute the size delta so the operator sees how much would change.
  const committedBytes = Buffer.byteLength(committed, "utf-8");
  const expectedBytes = Buffer.byteLength(expected, "utf-8");
  return {
    path,
    ok: false,
    reason: `committed ${committedBytes} bytes, regeneration would write ${expectedBytes} bytes (delta ${expectedBytes - committedBytes})`,
  };
}

function main(): void {
  process.stderr.write(
    "▸ check-llms-txt-fresh — apps/docs/public/llms.txt and llms-full.txt match what the generator would produce from current source (sibling-surface discipline for the LLM-facing corpus)\n",
  );

  const { llmsTxt, llmsFullTxt, docsPageCount, foundationalDocCount } = generateLlmsArtifacts();

  const results = [
    checkArtifact(LLMS_TXT_PATH, llmsTxt),
    checkArtifact(LLMS_FULL_TXT_PATH, llmsFullTxt),
  ];

  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    process.stderr.write(
      `✓ check-llms-txt-fresh: both artifacts match generator output (${docsPageCount} docs page(s), ${foundationalDocCount} foundational doc(s)).\n`,
    );
    return;
  }

  process.stderr.write(
    `\n✗ check-llms-txt-fresh: ${failures.length} of ${results.length} artifact(s) drifted from generator output:\n\n`,
  );
  for (const f of failures) {
    process.stderr.write(`  ${relative(REPO_ROOT, f.path)} — ${f.reason}\n`);
  }
  process.stderr.write(
    "\nFix: run `pnpm --filter @motebit/docs run regenerate-llms` (or `npx tsx scripts/generate-llms-txt.ts`) and commit the result.\n" +
      "The pre-push hook regenerates these via the docs prebuild step, but the regeneration is not auto-committed —\n" +
      "this gate exists to catch the case where source MDX or a foundational document was edited without rerunning the generator.\n",
  );
  process.exit(1);
}

main();
