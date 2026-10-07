/**
 * Context-trimming characterization harness (offline, deterministic).
 *
 * Drives the PRODUCTION history path — `ConversationManager.load()` then
 * `ConversationManager.trimmed()` (the exact call `sendMessage*` makes before
 * `runTurn`) — over a conversation fixture, and reports, per model:
 *
 *   - which history indices survive and which are dropped,
 *   - the history-token budget used vs. the budget production allows vs. the
 *     model's real context window,
 *   - a recall probe: for every planted fact, whether its message survives.
 *
 * It also evaluates a CANDIDATE policy (`windowDerivedBudget`) by calling the
 * real `trimConversation` with a budget derived from the model's window. The
 * candidate is simulation only — production trimming is untouched. See
 * docs/design/context-trimming-parity.md.
 *
 * No model, network or tokenizer calls: token counts use the same ~4 chars per
 * token estimate `trimConversation` uses (`packages/ai-core/src/context-window.ts`).
 */

import { vi } from "vitest";
import { trimConversation, type ContextBudget } from "@motebit/ai-core";
import type { ConversationMessage, ConversationStoreAdapter } from "@motebit/sdk";
import { SensitivityLevel, sensitivityPermits } from "@motebit/sdk";
import { ConversationManager, type ConversationDeps } from "../../conversation.js";

/** The estimator `trimConversation` uses (private there; mirrored, not reimplemented differently). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** `CONVERSATION_BUDGET` in packages/runtime/src/conversation.ts, as shipped. */
export const PRODUCTION_BUDGET: ContextBudget = { maxTokens: 8000, reserveForResponse: 1024 };

/** The trim note `trimConversation` prepends when it drops and no summary exists. */
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
  /** Prompt+completion tokens the model accepts — see MODEL_WINDOWS for provenance. */
  contextWindowTokens: number;
}

/**
 * Tokens the rest of a turn needs besides history: system prompt + tool schemas
 * + rendered context pack (~9.5k witnessed in intelligence-pluggability-contract.md
 * "Pre-doctrine", rounded up) and the current user message.
 */
export const NON_HISTORY_OVERHEAD_TOKENS = 12_000;
/** Output reserve for the candidate policy (matches the order of A's max_tokens). */
export const CANDIDATE_OUTPUT_RESERVE_TOKENS = 8_192;

export interface FactProbe {
  id: string;
  messageIndex: number;
  survives: boolean;
}

export interface TrimReport {
  fixture: string;
  provider: string;
  model: string;
  policy: "production" | "window-derived";
  historyMessages: number;
  survivingIndices: number[];
  droppedIndices: number[];
  trimNote: string | null;
  fullHistoryTokens: number;
  keptHistoryTokens: number;
  /** History tokens the policy allows (maxTokens − reserveForResponse). */
  historyBudgetTokens: number;
  contextWindowTokens: number;
  /** Whether the full conversation + overhead + output reserve fits the real window. */
  fullConversationFitsWindow: boolean;
  facts: FactProbe[];
}

/**
 * Candidate: history budget = window − non-history overhead − output reserve,
 * floored at today's history budget (a small window never trims harder than
 * production does). Output reserve is already subtracted, so `reserveForResponse`
 * is 0 here.
 */
export function windowDerivedBudget(window: ModelWindow): ContextBudget {
  const productionHistory = PRODUCTION_BUDGET.maxTokens - PRODUCTION_BUDGET.reserveForResponse;
  const fromWindow =
    window.contextWindowTokens - NON_HISTORY_OVERHEAD_TOKENS - CANDIDATE_OUTPUT_RESERVE_TOKENS;
  return { maxTokens: Math.max(productionHistory, fromWindow), reserveForResponse: 0 };
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

export function harnessDeps(
  store: ConversationStoreAdapter | null,
  overrides: Partial<ConversationDeps> = {},
): ConversationDeps {
  return {
    motebitId: "mb-harness",
    maxHistory: 40,
    summarizeAfterMessages: 20,
    store,
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

/** History as the production path hands it to `runTurn`. */
export function productionTrimmed(
  fixture: TrimFixture,
  options: RunOptions = {},
): { history: ConversationMessage[]; trimmed: ConversationMessage[] } {
  const cm = new ConversationManager(
    harnessDeps(fixtureStore(fixture, options.summary ?? null), {
      getEffectiveSensitivity: () => options.effectiveSensitivity ?? SensitivityLevel.None,
    }),
  );
  cm.load(`conv-${fixture.id}`);
  return { history: cm.getHistory(), trimmed: cm.trimmed() };
}

/**
 * The candidate policy over the same read path: the sensitivity filter exactly
 * as `ConversationManager.trimmed()` applies it (same predicate, same effective
 * tier — a larger window never loosens it), then the real `trimConversation`
 * with the window-derived budget.
 */
export function candidateTrimmed(
  fixture: TrimFixture,
  window: ModelWindow,
  options: RunOptions = {},
): { history: ConversationMessage[]; trimmed: ConversationMessage[] } {
  const effective = options.effectiveSensitivity ?? SensitivityLevel.None;
  const { history } = productionTrimmed(fixture, options);
  const filtered = history.filter(
    (m) => m.sensitivity == null || sensitivityPermits(effective, m.sensitivity),
  );
  return {
    history,
    trimmed: trimConversation(filtered, windowDerivedBudget(window), options.summary ?? null),
  };
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
      fullHistoryTokens +
        estimateTokens(fixture.question) +
        NON_HISTORY_OVERHEAD_TOKENS +
        CANDIDATE_OUTPUT_RESERVE_TOKENS <=
      window.contextWindowTokens,
    facts: fixture.facts.map((f) => ({
      id: f.id,
      messageIndex: f.messageIndex,
      survives:
        survivingSet.has(f.messageIndex) || (trimNote != null && trimNote.includes(f.needle)),
    })),
  };
}

/** Production behaviour for one fixture × model. The model is reported, not consulted. */
export function analyzeProduction(
  fixture: TrimFixture,
  window: ModelWindow,
  options: RunOptions = {},
): TrimReport {
  const { history, trimmed } = productionTrimmed(fixture, options);
  return report(fixture, window, "production", PRODUCTION_BUDGET, history, trimmed);
}

/** Candidate (window-derived budget) behaviour for one fixture × model. */
export function analyzeCandidate(
  fixture: TrimFixture,
  window: ModelWindow,
  options: RunOptions = {},
): TrimReport {
  const { history, trimmed } = candidateTrimmed(fixture, window, options);
  return report(fixture, window, "window-derived", windowDerivedBudget(window), history, trimmed);
}

/** One line per report — printed by the test so the matrix is readable in CI logs. */
export function formatRow(r: TrimReport): string {
  const facts = r.facts.map((f) => `${f.id}@${f.messageIndex}:${f.survives ? "kept" : "LOST"}`);
  return [
    r.policy.padEnd(14),
    `${r.provider}/${r.model}`.padEnd(44),
    `window=${r.contextWindowTokens}`.padEnd(15),
    `budget=${r.historyBudgetTokens}`.padEnd(14),
    `kept=${r.keptHistoryTokens}/${r.fullHistoryTokens}`.padEnd(16),
    `msgs=${r.survivingIndices.length}/${r.historyMessages}`.padEnd(10),
    `fits=${r.fullConversationFitsWindow ? "y" : "n"}`,
    facts.join(" "),
  ].join(" ");
}
