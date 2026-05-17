/**
 * Prompt-budget drift gate.
 *
 * Codifies the doctrine in
 * [`docs/doctrine/intelligence-pluggability-contract.md`](../docs/doctrine/intelligence-pluggability-contract.md)
 * into CI as a smoke alarm — paired with `check-prompt-density` (#81).
 *
 * ## The pair
 *
 *   `check-prompt-density` — counts rule-shaped clauses (- bullets,
 *   numbered RULES). Catches conformance-shape accumulation; the lens
 *   from `runtime-invariants-over-prompt-rules`.
 *
 *   `check-prompt-budget` (this gate) — measures byte weight of the
 *   prompt template-literal content. Catches absolute-size growth;
 *   the lens from `intelligence-pluggability-contract`.
 *
 * Different drift modes; both gates needed. A prompt that adds three
 * new bullets within the existing token budget trips density only.
 * A prompt that adds 1,200 tokens of non-bullet prose trips budget
 * only. Neither gate subsumes the other.
 *
 * ## Why byte-weight matters
 *
 * The constitutional claim is that motebit's intelligence is
 * pluggable (`docs/doctrine/protocol-primacy.md` lists on-device
 * inference among the protocol-level properties). Pluggability is
 * structurally true only if the prompt fits the selected model's
 * context window. A 40KB system prompt is ~10k tokens, which
 * overflows a 4k-context model (witnessed 2026-05-17 with WebLLM +
 * Llama-3.2-3B). Density is silent on this — every clause could be
 * grade-A typed-truth teaching and still overflow on size alone.
 *
 * ## What this counts
 *
 * Sum of bytes inside ES-module template literals (backtick strings)
 * declared at module scope in `packages/ai-core/src/prompt.ts`. The
 * template literals are the prompt material; the surrounding TS
 * scaffolding (imports, function bodies, type defs) is not part of
 * what the model sees. Counting only template-literal content keeps
 * the measurement honest under refactors that move scaffolding around
 * without touching the prompt.
 *
 * Note: dynamic `${...}` interpolation segments inside template
 * literals are NOT included — they're per-turn variable, not the
 * static prefix this gate measures. The static prefix is the
 * runtime-invariant cost; dynamic suffix is the per-turn surface
 * model-aware assembly will compress.
 *
 * Coarse on purpose: a smoke alarm, not a tokenizer. Bytes/4 is the
 * standard approximation for tokens across LLM tokenizers; sub-token
 * precision isn't load-bearing for catching drift.
 *
 * ## How to bump the budget
 *
 * When prompt growth is intentional:
 *
 *   1. Run the audit: is the new prose teaching a typed-truth wire
 *      field, or is it conformance pressure?
 *   2. If teaching, can the content compress without losing the wire
 *      field's semantic? (the standing commitment of the doctrine is
 *      that this number trends DOWN over time)
 *   3. If a bump is genuinely warranted, bump
 *      `SYSTEM_PROMPT_BUDGET_BYTES` in
 *      `packages/ai-core/src/prompt.ts` in the same commit.
 *   4. The commit message names what crossed the threshold and why.
 *      The bump itself IS the doctrine moment.
 *
 * Decreasing the count (compression / extraction to typed-truth) is
 * encouraged and never gated. The gate only fires on growth.
 *
 * ## Usage
 *
 *   tsx scripts/check-prompt-budget.ts   # exit 1 on overflow
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PROMPT_FILE = "packages/ai-core/src/prompt.ts";
const DOCTRINE_PATH = "docs/doctrine/intelligence-pluggability-contract.md";
const BUDGET_CONSTANT_NAME = "SYSTEM_PROMPT_BUDGET_BYTES";

/**
 * Read the declared budget from `prompt.ts` itself. Keeping the
 * canonical source IN the file the gate measures (rather than
 * duplicated here) means a bump is a one-place change and the
 * file and the gate cannot drift apart.
 */
function readDeclaredBudget(source: string): number {
  const match = source.match(
    new RegExp(`export\\s+const\\s+${BUDGET_CONSTANT_NAME}\\s*=\\s*([0-9_]+)`),
  );
  if (!match) {
    throw new Error(
      `${PROMPT_FILE} does not declare \`export const ${BUDGET_CONSTANT_NAME}\`. ` +
        `The gate reads its budget from the file under measurement so the two cannot drift. ` +
        `Add the constant per ${DOCTRINE_PATH}.`,
    );
  }
  return Number.parseInt(match[1].replaceAll("_", ""), 10);
}

/**
 * Sum bytes of static (non-interpolated) content inside top-level
 * template literals in `prompt.ts`. `${...}` placeholders within a
 * template literal are excluded — they're per-turn variable, not
 * static prefix.
 *
 * The parser is intentionally coarse: it scans for backtick-delimited
 * segments and strips interpolation. Edge cases (backtick inside a
 * regular string literal, nested template literals) would require a
 * real TS parser; the prompt file's actual shape doesn't hit them,
 * and the gate is smoke-alarm precision — false positives are
 * acceptable, false negatives on large prose blocks are not.
 */
function measureTemplateLiteralBytes(source: string): number {
  let total = 0;
  let inTemplate = false;
  let inInterpolation = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString: '"' | "'" | null = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString !== null) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (!inTemplate) {
      if (ch === "/" && next === "/") {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === "`") {
        inTemplate = true;
        continue;
      }
    } else {
      if (inInterpolation > 0) {
        if (ch === "{") inInterpolation++;
        else if (ch === "}") inInterpolation--;
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
        continue;
      }
      if (ch === "$" && next === "{") {
        inInterpolation = 1;
        i++;
        continue;
      }
      if (ch === "\\") {
        i++;
        total++;
        continue;
      }
      total++;
    }
  }

  return total;
}

function main(): void {
  const source = readFileSync(resolve(ROOT, PROMPT_FILE), "utf-8");
  const budget = readDeclaredBudget(source);
  const measured = measureTemplateLiteralBytes(source);
  const approxTokens = Math.round(measured / 4);
  const budgetTokens = Math.round(budget / 4);

  if (measured > budget) {
    const overflow = measured - budget;
    console.error(
      `check-prompt-budget: ${PROMPT_FILE} static prompt is ${measured} bytes (~${approxTokens} tokens), ` +
        `declared ${BUDGET_CONSTANT_NAME} is ${budget} bytes (~${budgetTokens} tokens) — over by ${overflow}.`,
    );
    console.error("");
    console.error(`Per ${DOCTRINE_PATH}: prompt growth is the failure mode where intelligence`);
    console.error("stops being pluggable. Each byte added to the static prefix is paid by every");
    console.error("model on every turn, and small-context models overflow first.");
    console.error("");
    console.error("Before bumping the budget, run the audit:");
    console.error("");
    console.error(
      "  1. Is the new prose teaching a typed-truth wire field, or conformance pressure?",
    );
    console.error("  2. Can the content compress without losing the wire field's semantic?");
    console.error("  3. Is there a sibling clause that subsumes this one?");
    console.error("");
    console.error("If a bump is genuinely warranted, raise SYSTEM_PROMPT_BUDGET_BYTES in");
    console.error(`${PROMPT_FILE} in the same commit with what crossed the threshold and why.`);
    console.error("The standing commitment is that this number trends DOWN over time as");
    console.error("PERCEPTION_DOCTRINE prose subtracts into typed-truth wire fields.");
    process.exit(1);
  }

  const headroom = budget - measured;
  if (headroom < 1_000) {
    console.log(
      `✓ check-prompt-budget: ${measured} bytes (~${approxTokens} tokens) of ${budget} budget — ${headroom} bytes headroom (tight; prune candidate)`,
    );
  } else {
    console.log(
      `✓ check-prompt-budget: ${measured} bytes (~${approxTokens} tokens) of ${budget} budget`,
    );
  }
}

main();
