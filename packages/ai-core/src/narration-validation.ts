/**
 * Runtime validation for `task_step_narration` — the third graduation
 * of `runtime-invariants-over-prompt-rules.md`. Sibling of
 * `dishonest-closing.ts`; different shape, same doctrinal pattern.
 *
 * The bug class. The model emits `task_step_narration` as a typed
 * field on its response ("Reading apple.com" / "Filling in the form").
 * The chrome consumes the field and renders it in the slab's
 * `motebit × virtual_browser` register. If the model's narration
 * contradicts wire-level typed truth — claims a URL that doesn't
 * match the last-navigated URL, claims a tool action that
 * contradicts the actual tool call — the chrome would render a lie.
 * The narration register's trust contract is: every line the chrome
 * shows is wire-true, regardless of what the model proposed.
 *
 * The validation. `validateTaskStepNarration` inspects the proposed
 * narration against wire-level typed truth (most recent navigate
 * URL, current tool selection if available). Returns either the
 * narration unchanged (no contradiction detected) OR a runtime-
 * templated fallback (contradiction detected). The chrome consumes
 * the validator's output, never the model's raw narration.
 *
 * Comparison with the dishonest-closing intercept:
 *
 *   - dishonest-closing operates on CLOSING TEXT after the loop
 *     terminates. Append-correction (cannot UNSEND streamed text).
 *     Inspects the model's full closing text for "Done"-class
 *     patterns. Six rules in DISHONESTY_RULES.
 *
 *   - narration-validation operates on AN INDIVIDUAL FIELD before
 *     the chrome reads it. Override-or-pass-through (no streaming
 *     constraint — the field is structured, not text-streamed).
 *     Inspects the proposed narration string for wire-level
 *     contradictions. Currently one rule (URL contradiction); more
 *     emerge as the chrome surfaces real contradictions in
 *     dogfooding.
 *
 * **The single first-rule we ship: URL-mention contradiction.** If
 * the narration mentions a URL or hostname AND that hostname doesn't
 * match the last-navigate result's URL, falsify. This catches the
 * load-bearing case: model says "Reading apple.com" while the page
 * is on google.com. Other rules (action-vs-tool-mismatch, register-
 * vs-claim-mismatch) emerge as the chrome ships and dogfooding
 * surfaces real contradictions.
 *
 * Doctrine: `chrome-as-state-render.md` § "Hybrid narration source
 * as the third typed-truth-perception triple." Wire field on
 * `AIResponse.task_step_narration`; prompt clause in
 * `PERCEPTION_DOCTRINE`; this file is the runtime check.
 */

import type { ToolResultLogEntry } from "./dishonest-closing.js";

/**
 * Result of validating a proposed task-step narration. Either the
 * narration passes through unchanged (validator detected no
 * contradiction) OR the validator falsifies and returns a runtime-
 * templated fallback that the chrome should display instead.
 *
 * The discriminated union makes the override visible at consumption:
 * a `valid: true` result is the model's text; a `valid: false`
 * result is the runtime's correction. Useful for chrome rendering
 * (might style overrides differently for trust calibration) and for
 * audit logs (the runtime can record which narrations were
 * falsified).
 */
export type NarrationValidationResult =
  | { readonly valid: true; readonly narration: string }
  | {
      readonly valid: false;
      readonly narration: string;
      readonly originalProposal: string;
      readonly reason: string;
    };

/**
 * Extract a hostname from a string if one is present. Detects
 * patterns like:
 *   - "apple.com" (bare hostname)
 *   - "https://apple.com/foo" (full URL)
 *   - "www.apple.com" (subdomain)
 *
 * Returns the canonical hostname (lowercase, no protocol, no path,
 * leading "www." stripped) or null if no hostname-shaped token is
 * present. Conservative: prefers no-match over false-match. The
 * regex catches the common cases the narration is likely to mention.
 */
function extractHostname(text: string): string | null {
  // First try full URL form (with protocol).
  const urlMatch = /\bhttps?:\/\/([a-zA-Z0-9.-]+)(?:[/:]|$)/i.exec(text);
  if (urlMatch !== null) {
    return canonicalizeHostname(urlMatch[1]!);
  }
  // Bare hostname form: word.word(.word)+ where last segment is a
  // recognizable TLD (2-6 alpha chars). Tight enough to avoid
  // false-matching things like "version 1.2.3" or "step 1.of.2".
  const bareMatch = /\b([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,6})\b/.exec(text);
  if (bareMatch !== null) {
    return canonicalizeHostname(bareMatch[1]!);
  }
  return null;
}

/**
 * Lowercase + strip leading `www.` for comparison. "Apple.com" /
 * "apple.com" / "www.apple.com" all canonicalize to "apple.com".
 * Subdomains otherwise preserved (mail.google.com stays distinct
 * from google.com — the narration should match what the page
 * actually is).
 */
function canonicalizeHostname(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/**
 * Find the most recent navigate-class result in the tool log. Walks
 * back to the most recent successful tool call whose data carries a
 * `url` field — that's the load-bearing typed truth for the URL-
 * mention contradiction check. Returns null when no such entry
 * exists (the validator then short-circuits — without a wire-truth
 * URL to compare against, no contradiction can be proven).
 */
function findLastNavigateUrl(toolResultsLog: readonly ToolResultLogEntry[]): string | null {
  for (let i = toolResultsLog.length - 1; i >= 0; i--) {
    const entry = toolResultsLog[i]!;
    if (!entry.ok) continue;
    const data = entry.data;
    if (data === null || typeof data !== "object") continue;
    const url = (data as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}

/**
 * Validate a proposed task-step narration against the tool-results
 * log. Returns the narration unchanged when no contradiction is
 * detected; returns a runtime-templated fallback when the narration
 * contradicts wire-level typed truth.
 *
 * Pass-through cases (no contradiction detectable):
 *   - Narration is empty / undefined → pass-through (chrome handles
 *     absence by receding to the empty register).
 *   - Narration mentions no hostname → pass-through (no URL claim
 *     to validate).
 *   - Tool log has no navigate result → pass-through (no wire truth
 *     to compare).
 *
 * Falsify cases (contradiction detected):
 *   - Narration mentions a hostname that doesn't match the most
 *     recent navigate URL → falsify with a runtime-templated
 *     fallback that names the actual current URL.
 */
export function validateTaskStepNarration(args: {
  readonly proposedNarration: string | undefined;
  readonly toolResultsLog: readonly ToolResultLogEntry[];
}): NarrationValidationResult {
  const { proposedNarration, toolResultsLog } = args;

  // Empty / undefined narration: pass-through. The chrome handles
  // absence by receding to the empty register; this validator's job
  // is to catch lies, not to synthesize content from nothing.
  if (proposedNarration === undefined || proposedNarration.trim() === "") {
    return { valid: true, narration: proposedNarration ?? "" };
  }

  // URL-mention contradiction check. Extract a hostname from the
  // narration; if found and the tool log has a navigate result,
  // compare. Mismatch → falsify.
  const narrationHost = extractHostname(proposedNarration);
  if (narrationHost !== null) {
    const lastUrl = findLastNavigateUrl(toolResultsLog);
    if (lastUrl !== null) {
      let actualHost: string | null = null;
      try {
        actualHost = canonicalizeHostname(new URL(lastUrl).hostname);
      } catch {
        // Malformed URL on the wire — extraction failed; treat as
        // no-comparison-possible and pass through. (The wire URL
        // being malformed is its own bug class; not this
        // validator's concern.)
      }
      if (actualHost !== null && actualHost !== narrationHost) {
        return {
          valid: false,
          narration: `Reading ${actualHost}`,
          originalProposal: proposedNarration,
          reason: `narration mentioned "${narrationHost}" but current page is "${actualHost}"`,
        };
      }
    }
  }

  // No contradiction detected. Pass-through.
  return { valid: true, narration: proposedNarration };
}
