/**
 * Fixtures for the context-trimming characterization harness.
 *
 * Two kinds:
 *   - the intelligence-parity bench's long-context items, read verbatim from
 *     scripts/bench/intelligence-parity/prompts.json (the items that scored
 *     B″ 2.88 vs B 9.00), and
 *   - synthetic conversations of the same shape (a fact planted early, a bulky
 *     paste, many ordinary turns, a late question that needs the fact).
 *
 * Everything is deterministic: no randomness, no clock, no I/O beyond reading
 * the committed bench file.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConversationMessage } from "@motebit/sdk";
import { SensitivityLevel } from "@motebit/sdk";
import {
  ANTHROPIC_MODELS,
  DEEPSEEK_MODELS,
  GOOGLE_MODELS,
  GROQ_MODELS,
  LOCAL_SERVER_SUGGESTED_MODELS,
  OPENAI_MODELS,
} from "@motebit/sdk";
import type { ModelWindow, TrimFixture } from "./context-trimming-harness.js";

// === Model windows ==========================================================

/**
 * Context windows for every model the SDK registry lists.
 *
 * The repo has NO production registry of context windows:
 * `ProviderCapability.contextWindowTokens` (@motebit/protocol routing.ts) is
 * optional and unpopulated, and the runtime never reads a window. These are
 * the vendors' published figures, taken at their CONSERVATIVE (standard-tier)
 * value, as harness fixtures only. Local servers' windows are whatever the
 * server is configured with (`num_ctx` / `--ctx-size`); 8,192 is a typical
 * local default and deliberately the one row where the full long conversation
 * does NOT fit.
 */
const WINDOW_BY_PROVIDER = {
  anthropic: 200_000,
  openai: 400_000,
  google: 1_048_576,
  deepseek: 128_000,
  groq: 131_072,
  "local-server": 8_192,
} as const;

export const MODEL_WINDOWS: ModelWindow[] = [
  ...ANTHROPIC_MODELS.map((model) => ({
    provider: "anthropic",
    model,
    contextWindowTokens: WINDOW_BY_PROVIDER.anthropic,
  })),
  ...OPENAI_MODELS.map((model) => ({
    provider: "openai",
    model,
    contextWindowTokens: WINDOW_BY_PROVIDER.openai,
  })),
  ...GOOGLE_MODELS.map((model) => ({
    provider: "google",
    model,
    contextWindowTokens: WINDOW_BY_PROVIDER.google,
  })),
  ...DEEPSEEK_MODELS.map((model) => ({
    provider: "deepseek",
    model,
    contextWindowTokens: WINDOW_BY_PROVIDER.deepseek,
  })),
  ...GROQ_MODELS.map((model) => ({
    provider: "groq",
    model,
    contextWindowTokens: WINDOW_BY_PROVIDER.groq,
  })),
  ...LOCAL_SERVER_SUGGESTED_MODELS.map((model) => ({
    provider: "local-server",
    model,
    contextWindowTokens: WINDOW_BY_PROVIDER["local-server"],
  })),
];

// === Bench fixtures =========================================================

interface BenchPrompt {
  id: string;
  category: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  prompt: string;
}

const BENCH_PROMPTS = fileURLToPath(
  new URL("../../../../../scripts/bench/intelligence-parity/prompts.json", import.meta.url),
);

function benchPrompt(id: string): BenchPrompt {
  const file = JSON.parse(readFileSync(BENCH_PROMPTS, "utf8")) as { prompts: BenchPrompt[] };
  const p = file.prompts.find((x) => x.id === id);
  if (p == null) throw new Error(`bench prompt ${id} not found in ${BENCH_PROMPTS}`);
  return p;
}

function fromBench(id: string, facts: TrimFixture["facts"]): TrimFixture {
  const p = benchPrompt(id);
  return {
    id,
    source: "scripts/bench/intelligence-parity/prompts.json",
    history: (p.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    question: p.prompt,
    facts,
  };
}

/** The bench item behind B″ 2.88 vs B 9.00: facts in turn 0, a ~5k-token CSV in turn 2. */
export const BENCH_TURN1_RECALL = fromBench("longctx-turn1-recall", [
  { id: "codename", messageIndex: 0, needle: "BLUEHERON" },
  { id: "launch-date", messageIndex: 0, needle: "14 March" },
  { id: "eu-residency", messageIndex: 0, needle: "never leaves the EU" },
]);

/** The short long-context item: fits the production budget, nothing trimmed. */
export const BENCH_GOAL_FOLLOWUP = fromBench("longctx-goal-followup", [
  { id: "goal", messageIndex: 0, needle: "20-minute conversation" },
  { id: "no-flashcards", messageIndex: 2, needle: "hate flashcards" },
]);

// === Synthetic fixtures =====================================================

/** Deterministic filler text of roughly `chars` characters. */
function filler(label: string, chars: number): string {
  const sentence = `${label}: the team reviewed the open items, agreed owners, and noted follow-ups for next week. `;
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
}

function exchanges(count: number, chars: number, startAt = 0): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ role: "user", content: filler(`Question ${startAt + i}`, Math.floor(chars / 4)) });
    out.push({ role: "assistant", content: filler(`Answer ${startAt + i}`, chars) });
  }
  return out;
}

/** Fact, then a bulky paste (~6k tokens), then ten ordinary exchanges, then the question. */
export const SYNTH_PASTE_THEN_ASK: TrimFixture = {
  id: "synth-paste-then-ask",
  source: "synthetic (bench long-context shape)",
  history: [
    {
      role: "user",
      content: "Remember: the vendor contract number is KX-4471 and renewal is 2 June.",
    },
    { role: "assistant", content: "Noted: contract KX-4471, renewal 2 June." },
    { role: "user", content: `Here is the full log export:\n${filler("log row", 24_000)}` },
    { role: "assistant", content: "Read it. Mostly retries and pool exhaustion." },
    ...exchanges(10, 700),
  ],
  question: "What was the vendor contract number and when is renewal?",
  facts: [
    { id: "contract", messageIndex: 0, needle: "KX-4471" },
    { id: "renewal", messageIndex: 0, needle: "2 June" },
  ],
};

/**
 * Long ordinary chat, no paste: 30 exchanges of ~1.1k tokens each (~33k tokens),
 * facts planted at turns 0, 20 and 50. Shows drop-oldest bites on plain
 * conversation length, well inside every cloud window.
 */
export const SYNTH_LONG_CHAT: TrimFixture = (() => {
  const history = exchanges(30, 3_600);
  history[0] = { role: "user", content: `My daughter's name is Ines. ${history[0]!.content}` };
  history[20] = { role: "user", content: `I'm allergic to penicillin. ${history[20]!.content}` };
  history[50] = { role: "user", content: `Our budget cap is $40k. ${history[50]!.content}` };
  return {
    id: "synth-long-chat",
    source: "synthetic",
    history,
    question: "Summarize what you know about me and the budget cap.",
    facts: [
      { id: "daughter", messageIndex: 0, needle: "Ines" },
      { id: "allergy", messageIndex: 20, needle: "penicillin" },
      { id: "budget", messageIndex: 50, needle: "$40k" },
    ],
  };
})();

/**
 * Governance probe: the fact is tagged Secret. At a None-tier session it must be
 * filtered out under ANY budget; a larger window never loosens the filter.
 */
export const SYNTH_SECRET_FACT: TrimFixture = {
  id: "synth-secret-fact",
  source: "synthetic (sensitivity)",
  history: [
    {
      role: "user",
      content: "My recovery phrase hint is ORCHID-SEVEN.",
      sensitivity: SensitivityLevel.Secret,
    },
    { role: "assistant", content: "Understood.", sensitivity: SensitivityLevel.Secret },
    ...exchanges(4, 400).map((m) => ({ ...m, sensitivity: SensitivityLevel.None })),
  ],
  question: "What was my recovery phrase hint?",
  facts: [{ id: "secret-hint", messageIndex: 0, needle: "ORCHID-SEVEN" }],
};

export const FIXTURES: TrimFixture[] = [
  BENCH_TURN1_RECALL,
  BENCH_GOAL_FOLLOWUP,
  SYNTH_PASTE_THEN_ASK,
  SYNTH_LONG_CHAT,
];
