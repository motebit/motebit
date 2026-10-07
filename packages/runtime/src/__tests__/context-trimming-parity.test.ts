/**
 * Context trimming — characterization of CURRENT behaviour, per provider/model.
 *
 * The intelligence-parity bench (#1076) measured route B″ (neutral prompt +
 * motebit's trimmed messages) at 2.88/10 vs route B (neutral prompt + full
 * conversation) at 9.00 on long-context recall. This suite pins down why,
 * offline: the production history path (`ConversationManager.load` →
 * `trimmed()`) drops the oldest turns against a fixed 8,000-token budget
 * that never consults the model, so a fact planted early is lost even when
 * the model's real window would hold the whole conversation many times over.
 *
 * These assertions describe what ships today, not what should ship. When the
 * policy in docs/design/context-trimming-parity.md lands, the "production"
 * assertions flip and the "candidate" block becomes the production contract.
 */

import { describe, expect, it } from "vitest";
import { SensitivityLevel } from "@motebit/sdk";
import { ConversationManager } from "../conversation.js";
import {
  GENERIC_TRIM_NOTE,
  PRODUCTION_BUDGET,
  analyzeCandidate,
  analyzeProduction,
  formatRow,
  harnessDeps,
  type TrimReport,
} from "./helpers/context-trimming-harness.js";
import {
  BENCH_GOAL_FOLLOWUP,
  BENCH_TURN1_RECALL,
  FIXTURES,
  MODEL_WINDOWS,
  SYNTH_LONG_CHAT,
  SYNTH_PASTE_THEN_ASK,
  SYNTH_SECRET_FACT,
} from "./helpers/context-trimming-fixtures.js";

const ANY_CLOUD = MODEL_WINDOWS.find((w) => w.provider === "anthropic")!;
const LOCAL = MODEL_WINDOWS.find((w) => w.provider === "local-server")!;

function lost(r: TrimReport): string[] {
  return r.facts.filter((f) => !f.survives).map((f) => f.id);
}

describe("context trimming — production policy (characterization)", () => {
  it("the budget is a fixed 8,000 tokens with 1,024 reserved: 6,976 history tokens for every model", () => {
    expect(PRODUCTION_BUDGET).toEqual({ maxTokens: 8000, reserveForResponse: 1024 });
    const budgets = new Set(
      MODEL_WINDOWS.map((w) => analyzeProduction(BENCH_TURN1_RECALL, w).historyBudgetTokens),
    );
    expect([...budgets]).toEqual([6976]);
  });

  it("bench longctx-turn1-recall: turn 0 (all planted facts) is dropped; a generic trim note replaces it", () => {
    const r = analyzeProduction(BENCH_TURN1_RECALL, ANY_CLOUD);
    expect(r.fullHistoryTokens).toBeGreaterThan(r.historyBudgetTokens);
    // Drop-oldest stops at the ~5k-token CSV paste (index 2): it and everything before it go.
    expect(r.droppedIndices).toEqual([0, 1, 2]);
    expect(r.survivingIndices[0]).toBe(3);
    expect(r.trimNote).toBe(GENERIC_TRIM_NOTE);
    expect(lost(r)).toEqual(["codename", "launch-date", "eu-residency"]);
  });

  it("bench longctx-goal-followup fits the budget: nothing trimmed, every fact survives", () => {
    const r = analyzeProduction(BENCH_GOAL_FOLLOWUP, ANY_CLOUD);
    expect(r.droppedIndices).toEqual([]);
    expect(r.trimNote).toBeNull();
    expect(lost(r)).toEqual([]);
  });

  it("long plain chat: only the newest ~6 exchanges survive; facts at turns 0 and 20 are lost, 50 kept", () => {
    const r = analyzeProduction(SYNTH_LONG_CHAT, ANY_CLOUD);
    expect(r.survivingIndices.length).toBeLessThanOrEqual(12);
    expect(lost(r)).toEqual(["daughter", "allergy"]);
  });

  it("matrix: the outcome is identical for every provider/model — the window is never consulted", () => {
    const rows: string[] = [];
    for (const fixture of FIXTURES) {
      const reference = analyzeProduction(fixture, MODEL_WINDOWS[0]!);
      for (const w of MODEL_WINDOWS) {
        const r = analyzeProduction(fixture, w);
        rows.push(formatRow(r));
        expect(r.survivingIndices).toEqual(reference.survivingIndices);
        expect(r.facts).toEqual(reference.facts);
      }
    }
    process.stdout.write(`\n[context-trimming] production policy\n${rows.join("\n")}\n`);
  });

  it("the expected failure: early facts are dropped although every cloud model's window holds the whole conversation", () => {
    for (const fixture of [BENCH_TURN1_RECALL, SYNTH_PASTE_THEN_ASK, SYNTH_LONG_CHAT]) {
      for (const w of MODEL_WINDOWS.filter((x) => x.provider !== "local-server")) {
        const r = analyzeProduction(fixture, w);
        expect(r.fullConversationFitsWindow, `${fixture.id} on ${w.model}`).toBe(true);
        expect(lost(r).length, `${fixture.id} on ${w.model}`).toBeGreaterThan(0);
      }
    }
  });

  it("a stored summary replaces the generic note; recall then depends on what the summary kept", () => {
    const withFacts = analyzeProduction(BENCH_TURN1_RECALL, ANY_CLOUD, {
      summary: "The user set codename BLUEHERON, launch 14 March, data never leaves the EU region.",
    });
    expect(withFacts.trimNote).toMatch(/^\[Earlier in this conversation: /);
    expect(lost(withFacts)).toEqual([]);
    // The summarizer is asked for 2–4 sentences of topics; a summary that omits the fact loses it.
    const vague = analyzeProduction(BENCH_TURN1_RECALL, ANY_CLOUD, {
      summary: "The user asked planning questions about a product launch and shared incident logs.",
    });
    expect(lost(vague)).toEqual(["codename", "launch-date", "eu-residency"]);
  });

  it("a second dropper on the live path: pushExchange caps in-memory history at maxHistory (40) messages", () => {
    const cm = new ConversationManager(harnessDeps(null));
    cm.pushExchange("Remember: my locker code is 2291.", "Noted.");
    for (let i = 0; i < 20; i++) cm.pushExchange(`q${i}`, `a${i}`);
    const history = cm.getHistory();
    expect(history).toHaveLength(40);
    expect(history.some((m) => m.content.includes("2291"))).toBe(false);
    // Tiny messages, far under the token budget — the count cap alone dropped the fact.
    expect(cm.trimmed().some((m) => m.content.includes("2291"))).toBe(false);
  });
});

describe("context trimming — candidate: budget derived from the model's window (simulation)", () => {
  it("every planted fact survives on every model whose window holds the conversation", () => {
    const rows: string[] = [];
    for (const fixture of FIXTURES) {
      for (const w of MODEL_WINDOWS) {
        const r = analyzeCandidate(fixture, w);
        rows.push(formatRow(r));
        if (r.fullConversationFitsWindow) {
          expect(r.droppedIndices, `${fixture.id} on ${w.model}`).toEqual([]);
          expect(lost(r), `${fixture.id} on ${w.model}`).toEqual([]);
        }
      }
    }
    process.stdout.write(`\n[context-trimming] window-derived candidate\n${rows.join("\n")}\n`);
  });

  it("small local windows still trim (the candidate is a ceiling, not a promise)", () => {
    const r = analyzeCandidate(BENCH_TURN1_RECALL, LOCAL);
    expect(r.fullConversationFitsWindow).toBe(false);
    expect(r.droppedIndices.length).toBeGreaterThan(0);
  });

  it("governance: a larger window never loosens the sensitivity filter", () => {
    const opts = { effectiveSensitivity: SensitivityLevel.None };
    for (const w of MODEL_WINDOWS) {
      const prod = analyzeProduction(SYNTH_SECRET_FACT, w, opts);
      const cand = analyzeCandidate(SYNTH_SECRET_FACT, w, opts);
      expect(prod.droppedIndices).toContain(0);
      expect(cand.droppedIndices).toContain(0);
      expect(lost(cand)).toEqual(["secret-hint"]);
    }
    // At a Secret-tier session both policies may carry it.
    const elevated = analyzeCandidate(SYNTH_SECRET_FACT, ANY_CLOUD, {
      effectiveSensitivity: SensitivityLevel.Secret,
    });
    expect(lost(elevated)).toEqual([]);
  });
});
