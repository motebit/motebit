/**
 * Context-trimming harness (offline, deterministic).
 *
 * Drives the PRODUCTION history path — `ConversationManager.load()` then
 * `ConversationManager.trimmed(nonHistoryTokens)` (the call the turn loop
 * makes through `TurnOptions.budgetConversationHistory`) — over a
 * conversation fixture, with the deps wired the way `MotebitRuntime` wires
 * them for a model, and reports, per model:
 *
 *   - which history indices survive and which are dropped,
 *   - the history-token budget used vs. allowed vs. the model's window,
 *   - a recall probe: for every planted fact, whether its message survives.
 *
 * It also reproduces the policy that shipped before the window was consulted
 * (`legacyTrimmed`: a fixed 8,000 − 1,024 budget, drop-oldest that stops at
 * the first message that does not fit) so the floor case can be checked as
 * "no worse than before". See docs/design/context-trimming-parity.md.
 *
 * No model, network or tokenizer calls: token counts use the same ~4 chars per
 * token estimate production uses (`estimateTokens`, @motebit/ai-core).
 */

import { vi } from "vitest";
import {
  estimateTokens,
  historyBudgetForWindow,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  HISTORY_BUDGET_FLOOR_TOKENS,
  type ContextBudget,
} from "@motebit/ai-core";
import type { ConversationMessage, ConversationStoreAdapter } from "@motebit/sdk";
import { SensitivityLevel, sensitivityPermits } from "@motebit/sdk";
import { ConversationManager, type ConversationDeps } from "../../conversation.js";

export { estimateTokens };

/** The budget that shipped before the window was consulted. */
export const LEGACY_BUDGET: ContextBudget = { maxTokens: 8000, reserveForResponse: 1024 };

/** The trim note production prepends when it drops and no summary exists. */
export const GENERIC_TRIM_NOTE =
  "[This conversation continues from earlier. Some messages have been trimmed for context.]";

export interface PlantedFact {
  id: string;
  /** Index in the fixture's history where the fact is stated. */
  messageIndex: number;
  /** A string that appears only in the fact's message (or in a faithful restatement). */
  needle: string;
}

export interface TrimFixture {
  id: string;
  /** Where the fixture's shape comes from. */
  source: string;
  history: ConversationMessage[];
  /** The later question that needs the facts. Not part of the history budget. */
  question: string;
  facts: PlantedFact[];
}

export interface ModelWindow {
  provider: string;
  model: string;
  /** The window production resolves for the model; `undefined` = not known. */
  contextWindowTokens: number | undefined;
}

/**
 * Tokens the rest of a turn needs besides history: system prompt + tool schemas
 * + rendered context pack (~9.5k witnessed in intelligence-pluggability-contract.md
 * "Pre-doctrine", rounded up) and the current user message. Stands in for the
 * value the loop measures per turn (`measureNonHistoryTokens`).
 */
export const NON_HISTORY_OVERHEAD_TOKENS = 12_000;

export interface FactProbe {
  id: string;
  messageIndex: number;
  survives: boolean;
}

export interface TrimReport {
  fixture: string;
  provider: string;
  model: string;
  policy: "production" | "legacy";
  historyMessages: number;
  survivingIndices: number[];
  droppedIndices: number[];
  trimNote: string | null;
  fullHistoryTokens: number;
  keptHistoryTokens: number;
  /** History tokens the policy allows. */
  historyBudgetTokens: number;
  contextWindowTokens: number | undefined;
  /** Whether the full conversation + overhead + output reserve fits the real window. */
  fullConversationFitsWindow: boolean;
  facts: FactProbe[];
}

function fixtureStore(fixture: TrimFixture, summary: string | null): ConversationStoreAdapter {
  const conversationId = `conv-${fixture.id}`;
  return {
    createConversation: () => conversationId,
    appendMessage: () => {},
    loadMessages: () =>
      fixture.history.map((m, i) => ({
        messageId: `${conversationId}-${i}`,
        conversationId,
        motebitId: "mb-harness",
        role: m.role,
        content: m.content,
        toolCalls: null,
        toolCallId: null,
        createdAt: i,
        tokenEstimate: estimateTokens(m.content),
        sensitivity: m.sensitivity,
      })),
    getActiveConversation: () => ({ conversationId, startedAt: 0, lastActiveAt: 0, summary }),
    updateSummary: () => {},
    updateTitle: () => {},
    listConversations: () => [],
    deleteConversation: () => {},
  } as ConversationStoreAdapter;
}

/** Deps as `MotebitRuntime.buildConversationDeps` builds them, minus the runtime. */
export function harnessDeps(
  store: ConversationStoreAdapter | null,
  overrides: Partial<ConversationDeps> = {},
): ConversationDeps {
  return {
    motebitId: "mb-harness",
    summarizeAfterMessages: 20,
    store,
    // The runtime stamps persisted messages at None (buildConversationDeps).
    defaultSensitivity: SensitivityLevel.None,
    // No provider: nothing in the harness can reach a model.
    getProvider: () => null,
    getTaskRouter: () => null,
    generateCompletion: vi.fn(async () => {
      throw new Error("harness makes no model calls");
    }),
    assertSensitivityPermitsAiCall: () => {
      throw new Error("harness makes no model calls");
    },
    ...overrides,
  };
}

export interface RunOptions {
  /** Stored conversation summary, as `summarizeConversation` would have written it. */
  summary?: string | null;
  /** Effective session sensitivity at trim time (read-side filter). */
  effectiveSensitivity?: SensitivityLevel;
}

/** History as the production path hands it to the turn, for one model. */
export function productionTrimmed(
  fixture: TrimFixture,
  window: ModelWindow,
  options: RunOptions = {},
): { history: ConversationMessage[]; trimmed: ConversationMessage[] } {
  const cm = new ConversationManager(
    harnessDeps(fixtureStore(fixture, options.summary ?? null), {
      getEffectiveSensitivity: () => options.effectiveSensitivity ?? SensitivityLevel.None,
      getContextWindowTokens: () => window.contextWindowTokens,
    }),
  );
  cm.load(`conv-${fixture.id}`);
  return { history: cm.getHistory(), trimmed: cm.trimmed(NON_HISTORY_OVERHEAD_TOKENS) };
}

/**
 * The policy that shipped before this change, reproduced for comparison: the
 * same sensitivity filter, then a fixed 6,976-token budget walked newest →
 * oldest that STOPS at the first message that does not fit.
 */
export function legacyTrimmed(
  fixture: TrimFixture,
  options: RunOptions = {},
): { history: ConversationMessage[]; trimmed: ConversationMessage[] } {
  const effective = options.effectiveSensitivity ?? SensitivityLevel.None;
  const history = fixture.history.map((m) => ({ ...m }));
  const filtered = history.filter(
    (m) => m.sensitivity == null || sensitivityPermits(effective, m.sensitivity),
  );
  const available = LEGACY_BUDGET.maxTokens - LEGACY_BUDGET.reserveForResponse;
  let total = 0;
  let cutoff = 0;
  for (let i = filtered.length - 1; i >= 0; i--) {
    const t = estimateTokens(filtered[i]!.content);
    if (total + t > available) {
      cutoff = i + 1;
      break;
    }
    total += t;
  }
  const kept = filtered.slice(cutoff);
  if (cutoff === 0) return { history, trimmed: kept };
  const note =
    options.summary != null && options.summary !== ""
      ? `[Earlier in this conversation: ${options.summary}]`
      : GENERIC_TRIM_NOTE;
  return { history, trimmed: [{ role: "user", content: note }, ...kept] };
}

/** The budget production computes for this model at the harness overhead. */
export function productionBudget(window: ModelWindow): ContextBudget {
  return historyBudgetForWindow({
    contextWindowTokens: window.contextWindowTokens,
    nonHistoryTokens: NON_HISTORY_OVERHEAD_TOKENS,
  });
}

function report(
  fixture: TrimFixture,
  window: ModelWindow,
  policy: TrimReport["policy"],
  budget: ContextBudget,
  history: ConversationMessage[],
  trimmed: ConversationMessage[],
): TrimReport {
  const surviving = trimmed.map((m) => history.indexOf(m)).filter((i) => i >= 0);
  const survivingSet = new Set(surviving);
  const dropped = history.map((_, i) => i).filter((i) => !survivingSet.has(i));
  const head = trimmed[0];
  const trimNote =
    head != null && history.indexOf(head) < 0 && head.content.startsWith("[") ? head.content : null;
  const fullHistoryTokens = history.reduce((n, m) => n + estimateTokens(m.content), 0);
  return {
    fixture: fixture.id,
    provider: window.provider,
    model: window.model,
    policy,
    historyMessages: history.length,
    survivingIndices: surviving,
    droppedIndices: dropped,
    trimNote,
    fullHistoryTokens,
    keptHistoryTokens: surviving.reduce((n, i) => n + estimateTokens(history[i]!.content), 0),
    historyBudgetTokens: budget.maxTokens - budget.reserveForResponse,
    contextWindowTokens: window.contextWindowTokens,
    fullConversationFitsWindow:
      window.contextWindowTokens != null &&
      fullHistoryTokens +
        estimateTokens(fixture.question) +
        NON_HISTORY_OVERHEAD_TOKENS +
        DEFAULT_OUTPUT_RESERVE_TOKENS <=
        window.contextWindowTokens,
    facts: fixture.facts.map((f) => ({
      id: f.id,
      messageIndex: f.messageIndex,
      survives:
        survivingSet.has(f.messageIndex) || (trimNote != null && trimNote.includes(f.needle)),
    })),
  };
}

/** Production behaviour for one fixture × model. */
export function analyzeProduction(
  fixture: TrimFixture,
  window: ModelWindow,
  options: RunOptions = {},
): TrimReport {
  const { history, trimmed } = productionTrimmed(fixture, window, options);
  return report(fixture, window, "production", productionBudget(window), history, trimmed);
}

/** The pre-change policy for one fixture × model (the model is reported, not consulted). */
export function analyzeLegacy(
  fixture: TrimFixture,
  window: ModelWindow,
  options: RunOptions = {},
): TrimReport {
  const { history, trimmed } = legacyTrimmed(fixture, options);
  return report(fixture, window, "legacy", LEGACY_BUDGET, history, trimmed);
}

export { HISTORY_BUDGET_FLOOR_TOKENS };

/** One line per report — printed by the test so the matrix is readable in CI logs. */
export function formatRow(r: TrimReport): string {
  const facts = r.facts.map((f) => `${f.id}@${f.messageIndex}:${f.survives ? "kept" : "LOST"}`);
  return [
    r.policy.padEnd(11),
    `${r.provider}/${r.model}`.padEnd(44),
    `window=${r.contextWindowTokens ?? "unknown"}`.padEnd(15),
    `budget=${r.historyBudgetTokens}`.padEnd(14),
    `kept=${r.keptHistoryTokens}/${r.fullHistoryTokens}`.padEnd(16),
    `msgs=${r.survivingIndices.length}/${r.historyMessages}`.padEnd(10),
    `fits=${r.fullConversationFitsWindow ? "y" : "n"}`,
    facts.join(" "),
  ].join(" ");
}
