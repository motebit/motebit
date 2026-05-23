/**
 * Prompt-density drift gate.
 *
 * Codifies the doctrine in
 * [`docs/doctrine/runtime-invariants-over-prompt-rules.md`](../docs/doctrine/runtime-invariants-over-prompt-rules.md)
 * into CI as a smoke alarm — NOT a per-clause registry.
 *
 * ## Why
 *
 * Every rule-shaped clause in the system prompt is a conformance ask:
 * the AI is told to behave a certain way at every turn. Each clause
 * is individually justifiable; collectively, accumulation contaminates
 * the §4 emergent-interior thesis from
 * [`THE_EMERGENT_INTERIOR.md`](../THE_EMERGENT_INTERIOR.md) — the
 * prompt becomes a configuration file disguised as teaching and the
 * AI becomes a rule-follower rather than an emergent agent.
 *
 * The doctrine memo names a five-question audit before each new
 * clause and a periodic prompt-prune pass. Without enforcement, the
 * prompt drifts back into accumulation between audits. This gate is
 * the forcing function that makes every addition a doctrine moment.
 *
 * ## What this counts
 *
 * Rule-shaped clauses are heuristically detected as lines starting
 * with `- ` (markdown-style bullets inside the prompt's template
 * literals) or `<digit>. ` (numbered RULES, e.g. INJECTION_DEFENSE).
 * Both shapes carry conformance asks; the union is the count.
 *
 * Coarse on purpose: a smoke alarm, not a lock at every door. False
 * negatives (inline non-bullet rules — "Never narrate physical actions"
 * embedded in a paragraph) are accepted; the most common drift pattern
 * (adding a new bullet) is what gets caught. Friction shape matches
 * motebit's "calm forcing function" register — friction at the moment
 * of growth, not pre-commit-hook noise.
 *
 * ## How to bump the baseline
 *
 * When a new clause is intentional:
 *
 *   1. Run the five-question audit named in the doctrine memo.
 *   2. Grade the clause A (runtime-backed) or B (teaching with named
 *      justification). Land the runtime backing FIRST if A.
 *   3. Bump `BASELINE` in this file in the same commit.
 *   4. The commit message names the clause + grade. The bump itself
 *      IS the doctrine moment.
 *
 * Decreasing the count (prune pass) is allowed without a baseline
 * change; the gate only fails on growth.
 *
 * ## Usage
 *
 *   tsx scripts/check-prompt-density.ts   # exit 1 on growth
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PROMPT_FILE = "packages/ai-core/src/prompt.ts";
const DOCTRINE_PATH = "docs/doctrine/runtime-invariants-over-prompt-rules.md";

/**
 * Local minimum measured on 2026-05-12 after the prompt-prune pass
 * that landed alongside the doctrine memo. New clauses bump this with
 * doctrine justification in the commit message; pruning lowers it
 * (allowed silently — pruning is encouraged).
 *
 * Bump log:
 *   - 2026-05-12 62→63: navigation_triggered typed-truth clause on
 *     click_element + key results. A-grade (wire field exists on
 *     click_element via doClickElement's beforeUrl/afterUrl capture,
 *     extended to key via doKey same shape); gated by
 *     check-typed-truth-perception (#80) as the 12th typed-truth
 *     field. Closes the "AI says done on submit-class action when
 *     the page didn't move" confabulation class witnessed today.
 *   - 2026-05-12 63→64: task_step_narration emission clause —
 *     teaches the model to emit a single first-person present-tense
 *     narration on AIResponse for the chrome's `motebit ×
 *     virtual_browser` register to consume. A-grade (wire field on
 *     AIResponse, runtime validation in
 *     packages/ai-core/src/narration-validation.ts that falsifies
 *     URL-mismatched narrations before the chrome reads them);
 *     gated by check-typed-truth-perception (#80) as the 13th
 *     typed-truth field. Third graduation of
 *     runtime-invariants-over-prompt-rules and first slice of PR 1
 *     of the agent-surface pivot. Doctrine: chrome-as-state-render.
 *
 *   - 64 → 65 (2026-05-23): episodic-eager extraction — a "WHAT TO TAG"
 *     clause inviting interest/trajectory memories tagged Episodic.
 *     **B-grade (knowingly teaching).** Memory-worthiness ("what's worth
 *     remembering about the user") is irreducibly a model judgment — the
 *     runtime cannot guarantee "capture the user's intellectual
 *     trajectory"; it only BOUNDS the result (low confidence 0.5-0.65 +
 *     decay + sensitivity gating), which it already does. The
 *     architecture (Episodic MemoryType, extractMemoryTags episodic
 *     parsing, confidence-decay) was already in place; this clause
 *     teaches the model to use it. Doctrine: memory-architecture.md.
 */
const BASELINE = 65;

function countRuleClauses(source: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    if (/^- /.test(line)) count++;
    else if (/^[0-9]+\. /.test(line)) count++;
  }
  return count;
}

function main(): void {
  const source = readFileSync(resolve(ROOT, PROMPT_FILE), "utf-8");
  const count = countRuleClauses(source);

  if (count > BASELINE) {
    console.error(
      `check-prompt-density: ${PROMPT_FILE} has ${count} rule-shaped clauses, baseline is ${BASELINE} (+${count - BASELINE}).`,
    );
    console.error("");
    console.error("Each rule-shaped clause is a conformance ask. The doctrine names a five-");
    console.error(`question audit before adding any new clause (${DOCTRINE_PATH}):`);
    console.error("");
    console.error("  1. Is this a typed-truth-perception triple? Add the wire field first.");
    console.error("  2. Can the runtime guarantee this outcome instead?");
    console.error("  3. Teaching or conformance? Conformance → look for a runtime path.");
    console.error("  4. Is the prompt growing? Periodic prompt-prune audit needed.");
    console.error(
      "  5. Prefer architecture (wire field, typed reason, invariant) over instruction.",
    );
    console.error("");
    console.error("If the new clauses are runtime-backed (A-grade) or knowingly teaching");
    console.error("(B-grade with named justification), bump BASELINE in this script with");
    console.error("the grade + reasoning in the commit message. If they're accumulated");
    console.error("drift, prune them first.");
    process.exit(1);
  }

  if (count < BASELINE) {
    console.log(
      `✓ check-prompt-density: ${count} rule-shaped clauses (${BASELINE - count} below baseline of ${BASELINE} — prune lowered the floor; consider updating BASELINE)`,
    );
  } else {
    console.log(`✓ check-prompt-density: ${count} rule-shaped clauses (matches baseline)`);
  }
}

main();
