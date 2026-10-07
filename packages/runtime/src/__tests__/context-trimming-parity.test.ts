/**
 * Context trimming — acceptance test for the window-derived history budget.
 *
 * The intelligence-parity bench (#1076) measured route B″ (neutral prompt +
 * motebit's trimmed messages) at 2.88/10 vs route B (neutral prompt + full
 * conversation) at 9.00 on long-context recall. The cause was trimming: a
 * fixed 8,000-token budget that never consulted the model, walked
 * drop-oldest and stopped at the first message that did not fit, plus a
 * 40-message count cap on the live path.
 *
 * The policy now (docs/design/context-trimming-parity.md, P1 + skip-not-stop):
 * history budget = clamp(window − measured non-history − output reserve,
 * 6,976, per-tier ceiling); a message that does not fit is skipped, not a
 * stopping point; no count cap. This suite drives the production path
 * (`ConversationManager.load` → `trimmed(n)`) for every model in the SDK
 * registry with the window production resolves for it.
 */

import { describe, expect, it } from "vitest";
import { SensitivityLevel } from "@motebit/sdk";
import { DEFAULT_HISTORY_CEILING_TOKENS } from "@motebit/ai-core";
import { ConversationManager } from "../conversation.js";
import { TurnPrincipal } from "../turn-principal.js";
import {
  GENERIC_TRIM_NOTE,
  HISTORY_BUDGET_FLOOR_TOKENS,
  analyzeLegacy,
  analyzeProduction,
  formatRow,
  harnessDeps,
  type TrimReport,
} from "./helpers/context-trimming-harness.js";
import {
  BENCH_TURN1_RECALL,
  FIXTURES,
  MODEL_WINDOWS,
  SYNTH_LONG_CHAT,
  SYNTH_PASTE_THEN_ASK,
  SYNTH_SECRET_FACT,
} from "./helpers/context-trimming-fixtures.js";

const ANY_CLOUD = MODEL_WINDOWS.find((w) => w.provider === "anthropic")!;
const LOCAL = MODEL_WINDOWS.find((w) => w.provider === "local-server")!;
const UNKNOWN = {
  provider: "unknown",
  model: "some-unlisted-model",
  contextWindowTokens: undefined,
};

function lost(r: TrimReport): string[] {
  return r.facts.filter((f) => !f.survives).map((f) => f.id);
}

describe("context trimming — window-derived budget (acceptance)", () => {
  it("the window comes from the production registry; unknown windows get the 6,976 floor", () => {
    expect(ANY_CLOUD.contextWindowTokens).toBeGreaterThan(100_000);
    for (const w of [...MODEL_WINDOWS, UNKNOWN]) {
      const r = analyzeProduction(BENCH_TURN1_RECALL, w);
      if (w.contextWindowTokens == null) {
        expect(r.historyBudgetTokens, w.model).toBe(HISTORY_BUDGET_FLOOR_TOKENS);
      }
      expect(r.historyBudgetTokens, w.model).toBeGreaterThanOrEqual(HISTORY_BUDGET_FLOOR_TOKENS);
      expect(r.historyBudgetTokens, w.model).toBeLessThanOrEqual(DEFAULT_HISTORY_CEILING_TOKENS);
    }
  });

  it("every planted fact survives on every model whose window holds the conversation", () => {
    const rows: string[] = [];
    let holding = 0;
    for (const fixture of FIXTURES) {
      // The fixtures sit under the default ceiling, so the window decides.
      expect(analyzeLegacy(fixture, ANY_CLOUD).fullHistoryTokens).toBeLessThan(
        DEFAULT_HISTORY_CEILING_TOKENS,
      );
      for (const w of MODEL_WINDOWS) {
        const r = analyzeProduction(fixture, w);
        rows.push(formatRow(r));
        if (r.fullConversationFitsWindow) {
          holding++;
          expect(r.droppedIndices, `${fixture.id} on ${w.model}`).toEqual([]);
          expect(r.trimNote, `${fixture.id} on ${w.model}`).toBeNull();
          expect(lost(r), `${fixture.id} on ${w.model}`).toEqual([]);
        }
      }
    }
    // Guard against a vacuous pass: the cloud rows must actually hold them.
    expect(holding).toBeGreaterThan(FIXTURES.length * 10);
    process.stdout.write(`\n[context-trimming] production policy\n${rows.join("\n")}\n`);
  });

  it("bench longctx-turn1-recall: turn 0 (all planted facts) reaches every model with a known large window", () => {
    for (const w of MODEL_WINDOWS.filter((x) => (x.contextWindowTokens ?? 0) > 100_000)) {
      const r = analyzeProduction(BENCH_TURN1_RECALL, w);
      expect(r.survivingIndices[0], w.model).toBe(0);
      expect(lost(r), w.model).toEqual([]);
    }
  });

  it("floor case (unknown or small window): no worse than the old policy — kept set is a superset", () => {
    const floorModels = [...MODEL_WINDOWS, UNKNOWN].filter(
      (w) =>
        analyzeProduction(BENCH_TURN1_RECALL, w).historyBudgetTokens ===
        HISTORY_BUDGET_FLOOR_TOKENS,
    );
    expect(floorModels.some((w) => w.provider === "local-server")).toBe(true);
    expect(floorModels).toContain(UNKNOWN);
    for (const fixture of [...FIXTURES, SYNTH_SECRET_FACT]) {
      for (const w of floorModels) {
        const prod = analyzeProduction(fixture, w);
        const legacy = analyzeLegacy(fixture, w);
        for (const i of legacy.survivingIndices) {
          expect(prod.survivingIndices, `${fixture.id} on ${w.model}: index ${i}`).toContain(i);
        }
        const legacyKept = legacy.facts.filter((f) => f.survives).map((f) => f.id);
        const prodKept = prod.facts.filter((f) => f.survives).map((f) => f.id);
        expect(prodKept).toEqual(expect.arrayContaining(legacyKept));
      }
    }
  });

  it("skip-not-stop: at the floor, the paste is skipped and the fact before it survives", () => {
    const r = analyzeProduction(SYNTH_PASTE_THEN_ASK, UNKNOWN);
    expect(r.droppedIndices).toEqual([2]); // only the ~6k-token paste
    expect(r.trimNote).toBe(GENERIC_TRIM_NOTE);
    expect(lost(r)).toEqual([]);
    const bench = analyzeProduction(BENCH_TURN1_RECALL, UNKNOWN);
    expect(bench.droppedIndices).toEqual([2]); // the CSV paste
    expect(lost(bench)).toEqual([]);
  });

  it("small local windows still trim (the floor is a floor, not a promise)", () => {
    const r = analyzeProduction(SYNTH_LONG_CHAT, LOCAL);
    expect(r.fullConversationFitsWindow).toBe(false);
    expect(r.droppedIndices.length).toBeGreaterThan(0);
    expect(r.historyBudgetTokens).toBe(HISTORY_BUDGET_FLOOR_TOKENS);
  });

  it("a stored summary still replaces the generic note when anything is dropped", () => {
    const r = analyzeProduction(SYNTH_LONG_CHAT, LOCAL, {
      summary: "The user's daughter is Ines.",
    });
    expect(r.trimNote).toBe("[Earlier in this conversation: The user's daughter is Ines.]");
  });

  it("live path: no message-count cap — a fact 42 messages back survives, as on a resumed load", () => {
    const cm = new ConversationManager(harnessDeps(null));
    cm.pushExchange("Remember: my locker code is 2291.", "Noted.");
    for (let i = 0; i < 20; i++) cm.pushExchange(`q${i}`, `a${i}`);
    expect(cm.getHistory()).toHaveLength(42);
    expect(cm.trimmed().some((m) => m.content.includes("2291"))).toBe(true);
  });

  it("live and resumed paths hold the same history under the token bound", () => {
    const big = "x".repeat(40_000); // 10k tokens per message
    const stored: Array<{ role: "user" | "assistant"; content: string }> = [];
    const store = {
      createConversation: () => "c1",
      appendMessage: (
        _c: string,
        _m: string,
        msg: { role: "user" | "assistant"; content: string },
      ) => {
        stored.push(msg);
      },
      loadMessages: () =>
        stored.map((m, i) => ({
          messageId: `m${i}`,
          conversationId: "c1",
          motebitId: "mb-harness",
          role: m.role,
          content: m.content,
          toolCalls: null,
          toolCallId: null,
          createdAt: i,
          tokenEstimate: 0,
        })),
      getActiveConversation: () => ({
        conversationId: "c1",
        startedAt: 0,
        lastActiveAt: 0,
        summary: null,
      }),
      updateSummary: () => {},
      updateTitle: () => {},
      listConversations: () => [],
      deleteConversation: () => {},
    } as unknown as import("@motebit/sdk").ConversationStoreAdapter;
    const live = new ConversationManager(harnessDeps(store, { historyBoundTokens: 55_000 }));
    for (let i = 0; i < 6; i++) live.pushExchange(`${i}:${big}`, `${i}:${big}`);
    const resumed = new ConversationManager(harnessDeps(store, { historyBoundTokens: 55_000 }));
    resumed.load("c1");
    expect(live.getHistory().map((m) => m.content)).toEqual(
      resumed.getHistory().map((m) => m.content),
    );
    expect(live.getHistory()).toHaveLength(5);
  });

  it("an explicitly configured count cap applies to loaded conversations too", () => {
    const cm = new ConversationManager(harnessDeps(null, { maxHistory: 4 }));
    for (let i = 0; i < 5; i++) cm.pushExchange(`q${i}`, `a${i}`);
    expect(cm.getHistory().map((m) => m.content)).toEqual(["q3", "a3", "q4", "a4"]);
  });
});

describe("context trimming — governance invariants", () => {
  it("a larger window never loosens the sensitivity filter", () => {
    const opts = { effectiveSensitivity: SensitivityLevel.None };
    for (const w of [...MODEL_WINDOWS, UNKNOWN]) {
      const r = analyzeProduction(SYNTH_SECRET_FACT, w, opts);
      expect(r.droppedIndices, w.model).toEqual([0, 1]);
      expect(lost(r), w.model).toEqual(["secret-hint"]);
    }
    // At a Secret-tier session the session's own messages are permitted.
    const elevated = analyzeProduction(SYNTH_SECRET_FACT, ANY_CLOUD, {
      effectiveSensitivity: SensitivityLevel.Secret,
    });
    expect(lost(elevated)).toEqual([]);
  });

  it("which messages are permitted is independent of the window", () => {
    for (const tier of [
      SensitivityLevel.None,
      SensitivityLevel.Personal,
      SensitivityLevel.Secret,
    ]) {
      const permitted = new Set(
        analyzeProduction(SYNTH_SECRET_FACT, ANY_CLOUD, { effectiveSensitivity: tier })
          .survivingIndices,
      );
      for (const w of MODEL_WINDOWS) {
        const r = analyzeProduction(SYNTH_SECRET_FACT, w, { effectiveSensitivity: tier });
        for (const i of r.survivingIndices)
          expect(permitted.has(i), `${w.model} ${tier}`).toBe(true);
      }
    }
  });

  it("a foreign principal's view stays empty whatever the window", () => {
    const cm = new ConversationManager(
      harnessDeps(null, { getContextWindowTokens: () => 1_000_000 }),
    );
    cm.pushExchange("owner secret context", "ok");
    const foreign = cm.forTurn(TurnPrincipal.of(true));
    expect(foreign.trimmed()).toEqual([]);
    expect(foreign.trimmed(0)).toEqual([]);
  });
});
