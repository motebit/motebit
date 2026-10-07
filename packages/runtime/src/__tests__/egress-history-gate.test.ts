/**
 * Static gate: conversation history reaches a provider only through the
 * tier-filtered accessors — `ConversationManager.trimmed` (turns, the
 * owner approval resume) or `egressHistory` (summarization, the AI title,
 * reflection). The raw history (`getHistory`) is for local rendering and
 * counts. Regression lock for the approval-resume leak, where a raw
 * `liveHistory()` accessor carried a Secret exchange to a BYOK provider.
 *
 * Aperture: every non-test `.ts` file under packages/runtime/src.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__") out.push(...sources(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const FILES = sources(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, "utf8") }));

/** `conversationHistory:` values a turn may be given without the filter. */
const ALLOWED_CONVERSATION_HISTORY = [
  /^\[\]/, // no history (activation)
  /^trimmed$/, // `const trimmed = convo.trimmed();` — a normal turn
  /^continuationHistory$/, // the resume: `convo.trimmed()` (owner) or its own pair (foreign)
];

/** Raw-history reads that never leave the device. */
const ALLOWED_RAW_READ = [
  /getHistory\(\)\.length/, // counts
  /^\s*return this\.conversation\.getHistory\(\);/, // public accessor for surface rendering
  /^\s*getHistory\(\): ConversationMessage\[\] \{/, // the definition
  /const history = this\.getHistory\(\);/, // autoTitle: heuristic title (local); AI title reads egressHistory
];

describe("conversation history egress gate", () => {
  it(`scanned ${FILES.length} runtime source files`, () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it("no raw live-history accessor exists", () => {
    const hits = FILES.filter((f) => /\bliveHistory\b/.test(f.text)).map((f) => f.rel);
    expect(hits, "use convo.trimmed(n) (turns) or egressHistory() (completions)").toEqual([]);
  });

  it("every conversationHistory a turn receives is empty or the resume's private pair", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const m of f.text.matchAll(/\bconversationHistory:\s*([^\n,]+)/g)) {
        const value = m[1]!.trim();
        if (/^ConversationMessage\[\]|^"turn_own"/.test(value)) continue; // type / registry
        if (!ALLOWED_CONVERSATION_HISTORY.some((r) => r.test(value)))
          bad.push(`${f.rel}: ${value}`);
      }
    }
    expect(bad, "pass convo.trimmed() (filtered + budgeted) instead").toEqual([]);
  });

  it("those variables are bound only to the filtered view or the private pair", () => {
    const rt = FILES.find((f) => f.rel === "motebit-runtime.ts")!.text;
    for (const m of rt.matchAll(/\bconst trimmed = ([^;]+);/g)) {
      expect(m[1]!.trim()).toBe("convo.trimmed()");
    }
    const streaming = FILES.find((f) => f.rel === "streaming.ts")!.text;
    const assigned = [...streaming.matchAll(/\bcontinuationHistory = ([^;]+);/g)].map((m) =>
      m[1]!.trim(),
    );
    expect(assigned.sort()).toEqual(["[...continuationPair]", "convo.trimmed()"]);
  });

  it("raw history is read only for rendering and counts", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      f.text.split("\n").forEach((line, i) => {
        if (!/getHistory\(\)/.test(line) || /getHistoryCeilingTokens/.test(line)) return;
        if (!ALLOWED_RAW_READ.some((r) => r.test(line)))
          bad.push(`${f.rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, "provider-bound history reads egressHistory() or trimmed()").toEqual([]);
  });

  it("summarization, the AI title and reflection read the filtered history", () => {
    const conv = FILES.find((f) => f.rel === "conversation.ts")!.text;
    for (const m of conv.matchAll(/summarizeConversation\(\s*([^,]+),/g)) {
      expect(["history", "this.egressHistory()"]).toContain(m[1]!.trim());
    }
    expect(conv).toMatch(
      /const history = this\.egressHistory\(\);\s*if \(history\.length < 2\) return null;\s*const existingSummary/,
    );
    expect(conv).toMatch(/tryAiTitle\(this\.egressHistory\(\)\)/);
    const rt = FILES.find((f) => f.rel === "motebit-runtime.ts")!.text;
    expect(rt).toMatch(/getConversationHistory: \(\) => this\.conversation\.egressHistory\(\)/);
  });
});
