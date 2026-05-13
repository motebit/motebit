/**
 * Runtime intercept for dishonest closing text — graduates four typed-
 * truth fields from prompt-only teaching to runtime-enforced correction.
 *
 * The bug class. Today's prompt teaches the model to read four typed-
 * truth fields and not claim success when they contradict the claim:
 *
 *   navigation_triggered: false  — submit-class action landed but the
 *     page didn't move (cookie banner intercepted, bot-detection silently
 *     dropped, form submission blocked)
 *   recovery_hint: present       — type-class action ran but text didn't
 *     appear (focus race, the field wasn't actually focused)
 *   bot_detection_detected: true — screenshot/page-load action surfaced
 *     a CAPTCHA/wall, not the intended page content
 *   frame_stale (error reason)   — page navigated underneath the action;
 *     even the one-shot retry caught a stale frame
 *
 * Prompt compliance is probabilistic. Across multiple sessions with
 * multiple fields active, joint failure is non-trivial — somewhere
 * around one in seven sessions today emits a "Done." that the wire-
 * level typed truth contradicts. The user sees the lie; the runtime
 * had the structural fact but did nothing with it.
 *
 * The intercept. After the loop terminates with non-empty `finalText`,
 * scan the text for "Done"-class closing patterns. If matched, walk
 * back through the tool-results log to find the most recent terminal
 * action of the relevant kind (submit, type, view) and inspect its
 * typed-truth. If the typed truth contradicts the claim AND no
 * successful retry of the same kind followed, append a correction
 * text chunk in the same turn so the user sees the truth before they
 * act on the lie.
 *
 * **The LAST-RELEVANT walk-back is load-bearing.** A naive intercept
 * that scans the whole tool log and overrides on the first failure
 * introduces a worse bug: the model fails on attempt one, succeeds on
 * attempt two, drafts an honest "Done", and the runtime contradicts
 * it. Walk back from the most recent action of the relevant kind; if
 * a successful action of the same kind followed the failure, the
 * model isn't lying. Test pin (3) below guards this regression.
 *
 * **Two registers, only one in scope.** Five typed-truth fields ride
 * the wire: the four above (dishonesty-class — each says "the model
 * is about to claim success the wire contradicts") plus
 * `submit_button_id` (affordance-class — a hint pointing at what to
 * click next). Affordance-class fields don't belong in this intercept;
 * conflating them would trigger spurious overrides. Test pin (3) below
 * encodes the register distinction.
 *
 * Doctrine: `runtime-invariants-over-prompt-rules.md` names
 * `synthesizeClosingFallback` as the exemplar. This is that exemplar
 * extended to its full scope. Sync-invariant graduation: four typed-
 * truth fields go from 2-of-3 (wire + prompt) to 3-of-3 (wire +
 * prompt + runtime), the canonical typed-truth-perception triple.
 */

/**
 * What the loop captures per tool call so the intercept can inspect
 * typed-truth at exit time.
 *
 * `data` is the structured tool output dict (e.g.
 * `{ kind: "click", ok: true, navigation_triggered: false }`) — the
 * same shape the slab consumes by field. Captured pre-sanitization so
 * the typed-truth fields are intact (sanitization may strip or wrap
 * for prompt-injection defense, which would defeat this intercept).
 *
 * `errorReason` is the typed `ServiceError.reason` for failed calls
 * (`frame_stale`, `policy_denied`, `session_closed`, etc.) — the
 * same surface the dispatcher reads. Null when the call succeeded.
 */
export interface ToolResultLogEntry {
  readonly name: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly errorReason: string | null;
}

/**
 * What the model is claiming in its closing text. Each kind names a
 * register — the corresponding tool-action class whose typed truth
 * contradicts the claim.
 *
 *   submit  — "Done"/"submitted"/"searched"/"sent" — claims a submit-
 *             class action triggered a navigation. Contradicted by
 *             `navigation_triggered: false` on the most recent
 *             click/double_click/click_element/key action.
 *   type    — "typed it in"/"entered"/"filled in" — claims a type-
 *             class action put text in the field. Contradicted by
 *             `recovery_hint` present on the most recent type action.
 *   view    — "I see..."/"the page shows"/"loaded" — claims a view-
 *             class action surfaced the intended content. Contradicted
 *             by `bot_detection_detected: true` on the most recent
 *             screenshot/screenshot_region action.
 *   action  — generic "Done."/"Done!" with no specific noun. Matches
 *             ANY of the three above on the most recent terminal
 *             action; also matches `frame_stale` errors on the most
 *             recent action regardless of kind.
 *
 * Returns null when the closing text doesn't match any "Done"-class
 * pattern — most closing text isn't a success claim and shouldn't be
 * intercepted (e.g., questions back to the user, narration of next
 * steps, error reports the model wrote itself).
 */
export type ClosingClaimKind = "submit" | "type" | "view" | "action";

/**
 * Tool names whose results carry each typed-truth field. Used by the
 * walk-back to find the most recent action of the relevant kind. The
 * `computer` tool wraps all browser actions; the dispatcher routes by
 * `action.kind`, so we inspect `data.kind` to disambiguate.
 */
const SUBMIT_KINDS = new Set(["click", "double_click", "click_element", "key"]);
const TYPE_KINDS = new Set(["type"]);
const VIEW_KINDS = new Set(["screenshot", "screenshot_region", "read_page"]);

/**
 * Classify the model's closing text into one of the four registers,
 * or null if the text isn't a "Done"-class claim. Pattern set is
 * intentionally tight — false positives here would intercept honest
 * model text. The bias is to MISS some confabulations (which the
 * existing prompt-clause may still catch) rather than to OVER-FIRE
 * (which would erode trust in the runtime intercept itself).
 *
 * The patterns are anchored at sentence boundaries to avoid matching
 * the same phrases inside a longer narration ("I almost said Done but
 * checked first" should NOT classify as a submit claim).
 */
export function classifyClosingClaim(text: string): ClosingClaimKind | null {
  // Take the first sentence-shaped span — closing claims live there,
  // not in the middle of a longer paragraph. Cheap proxy: split on
  // sentence enders, take the first non-empty span.
  const firstSentence = text
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (firstSentence === undefined) return null;
  const lower = firstSentence.toLowerCase();

  // Submit-class — claims a form submission / search / navigation
  // landed. Anchored on the action verb at sentence start to avoid
  // matching mid-sentence references.
  if (
    /^(?:i(?:'ve| have)?\s+)?(?:submitted|sent|searched(?:\s+for)?|hit\s+(?:enter|search|submit))\b/.test(
      lower,
    )
  ) {
    return "submit";
  }

  // Type-class — claims text was entered into a field.
  if (
    /^(?:i(?:'ve| have)?\s+)?(?:typed|entered|filled(?:\s+in)?|put\s+(?:in|that))\b/.test(lower)
  ) {
    return "type";
  }

  // View-class — claims a page or content was loaded / observed.
  if (
    /^(?:i\s+(?:see|can\s+see)|the\s+page\s+(?:shows?|has)|loaded|here(?:'s| is)\s+(?:the|what))\b/.test(
      lower,
    )
  ) {
    return "view";
  }

  // Action-class — generic "Done." with no specific verb. Most
  // common confabulation shape. Matches ANY recent terminal action.
  if (/^done(?:[!.,\s]|$)/.test(lower) || /^all\s+set(?:[!.,\s]|$)/.test(lower)) {
    return "action";
  }

  return null;
}

/**
 * Extract the action kind from a tool result's `data`. Returns null
 * for non-browser tools or malformed results. Defensive against the
 * many shapes that flow through the loop's tool-result path.
 */
function extractActionKind(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const kind = (data as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

/**
 * Walk back through the tool-results log to find the most recent
 * action whose kind belongs to `relevantKinds`. Returns null when no
 * such action exists in the log — the intercept then returns null
 * (no contradiction possible).
 *
 * Errors with `errorReason` matching the relevant kind ALSO count —
 * a `frame_stale` error on the most recent submit-class action is
 * still the most recent submit-class action, just one that failed.
 */
function findMostRecentRelevantEntry(
  log: readonly ToolResultLogEntry[],
  relevantKinds: ReadonlySet<string>,
  matchAnyKind: boolean,
): ToolResultLogEntry | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]!;
    if (matchAnyKind) {
      // Action-class: any browser tool counts. Use `extractActionKind`
      // to filter out non-browser tools (recall_memories, web_search,
      // etc.) — those don't carry navigation/CAPTCHA/typing semantics.
      const kind = extractActionKind(entry.data);
      if (
        kind !== null &&
        (SUBMIT_KINDS.has(kind) || TYPE_KINDS.has(kind) || VIEW_KINDS.has(kind))
      ) {
        return entry;
      }
      // Failed call with no data — match if the name is `computer`
      // (the umbrella tool for all browser actions). This catches
      // frame_stale errors that surface as failures with no kind.
      if (!entry.ok && entry.name === "computer") return entry;
      continue;
    }
    const kind = extractActionKind(entry.data);
    if (kind !== null && relevantKinds.has(kind)) return entry;
    // Failed `computer` call — count for action-class but not for
    // specific kinds (we don't know what kind the failed action was
    // without successful data).
  }
  return null;
}

/**
 * Dishonesty-class field check — returns true when the value
 * contradicts a "Done"-class claim. Each rule binds one typed-truth
 * field to its contradiction predicate.
 */
type FieldCheck = (value: unknown) => boolean;

/**
 * One row of the dishonesty-rule table. Encodes the four parallel
 * checks (claim register, tool-action register, field name, value
 * predicate) and the honest-line correction text as data.
 *
 * The table replaces what would otherwise be 5+ parallel if-blocks
 * doing the same five things (claim guard, kind guard, field
 * extraction, value check, return string). At three rules the
 * branches were tolerable; at five they are not. Refactoring at this
 * boundary serves three structural ends:
 *
 *   - The dishonesty-class registry is auditable as data — the
 *     `check-typed-truth-perception` drift gate can assert "every
 *     dishonesty-class-persistent registry entry MUST appear in
 *     `DISHONESTY_RULES`," catching the next sweep's "you forgot a
 *     sibling" drift mechanically rather than by reviewer eyeball.
 *   - Adding the next field is one row of data, not a 30-line copy-
 *     paste of the inspection logic.
 *   - The 28-test pin matrix parameterizes against the table (each
 *     rule × three pins: triggers-on-failure, retry-doesnt-trigger,
 *     register-distinction-holds), so coverage grows linearly with
 *     data instead of quadratically with maintenance.
 *
 * Failure-class rule (`errorReason: "frame_stale"`) doesn't fit the
 * field-on-data shape — it inspects `entry.errorReason` not
 * `entry.data.<field>`. Kept as a separate early-return in
 * `inspectDishonesty` for clarity; the data-driven shape only
 * generalizes well over the success-result rules.
 */
interface DishonestyRule {
  /**
   * Claim registers this rule fires for. `action` is always present
   * — generic "Done" claims should be checked against every register.
   */
  readonly claims: ReadonlyArray<ClosingClaimKind>;
  /** Tool-action kinds whose results carry the field. */
  readonly toolKinds: ReadonlySet<string>;
  /** The typed-truth field name on `entry.data`. */
  readonly field: string;
  /** Returns true when the field's value contradicts the claim. */
  readonly check: FieldCheck;
  /** Honest correction text appended after the model's draft. */
  readonly honest: string;
}

/**
 * The full set of dishonesty-class success-result rules. Editing this
 * array is the canonical way to add a new typed-truth runtime check;
 * the drift gate enforces the registry-to-rules sync.
 *
 * Ordering note: rules iterate in declaration order. When two rules
 * could match the same entry (e.g. a hypothetical type result with
 * both `recovery_hint` and a CAPTCHA flag), the earlier rule wins.
 * Today no entry shape supports two simultaneous matches, but the
 * deterministic order keeps the contract closed.
 */
const DISHONESTY_RULES: readonly DishonestyRule[] = [
  {
    claims: ["submit", "action"],
    toolKinds: SUBMIT_KINDS,
    field: "navigation_triggered",
    check: (v) => v === false,
    honest:
      "Actually wait — the click/keystroke landed but the page didn't move. The submission may have been intercepted by an overlay (cookie banner, bot detection) or silently dropped. Let me re-read the page.",
  },
  {
    claims: ["type", "action"],
    toolKinds: TYPE_KINDS,
    field: "recovery_hint",
    check: (v) => typeof v === "string" && v.length > 0,
    honest:
      "Actually wait — I typed but the text didn't appear in the field (likely a focus race). Let me re-read the page and try clicking the field first, then retyping.",
  },
  {
    claims: ["view", "action"],
    toolKinds: VIEW_KINDS,
    field: "bot_detection_detected",
    check: (v) => v === true,
    honest:
      "Actually wait — what loaded looks like a CAPTCHA or bot-detection wall, not the intended content. The page may need a manual challenge before I can continue.",
  },
  {
    // Sibling sweep — `blank_page_detected` is the dishonesty-class
    // sibling that fires when the navigate result heuristic detected
    // an empty page (no visible text, near-blank pixels). Model
    // claiming "the page shows X" / "loaded" while the page is blank
    // is the same dishonesty shape as the bot_detection case, just a
    // different content failure.
    claims: ["view", "action"],
    toolKinds: VIEW_KINDS,
    field: "blank_page_detected",
    check: (v) => v === true,
    honest:
      "Actually wait — the page that loaded appears blank (no visible content). The navigation may have completed but rendered nothing useful. Let me re-read the page or try a different URL.",
  },
  {
    // Sibling sweep — `access_denied_detected` fires when the
    // navigate result surfaced a 403/login-wall/access-denied page.
    // Distinct from `bot_detection_detected` (which is challenge-
    // humanness) — this is page-blocked outright; recovery is "try
    // elsewhere" not "solve the CAPTCHA."
    claims: ["view", "action"],
    toolKinds: VIEW_KINDS,
    field: "access_denied_detected",
    check: (v) => v === true,
    honest:
      "Actually wait — what loaded looks like an access-denied or login-wall page, not the intended content. The site is blocking this request; let me try a different approach.",
  },
];

/**
 * Inspect a single log entry for typed-truth dishonesty. Returns the
 * honest correction sentence when the entry contradicts a "Done"-
 * class claim of the given kind, or null when the entry is honest
 * (no contradiction).
 *
 * Two phases:
 *   1. Failure-class check — `frame_stale` lives on `entry.errorReason`,
 *      not on `entry.data`. Early-return.
 *   2. Success-result table walk — iterate `DISHONESTY_RULES` and
 *      return the first rule whose claim, tool-kind, and field-value
 *      checks all match. Deterministic by declaration order.
 */
function inspectDishonesty(entry: ToolResultLogEntry, claim: ClosingClaimKind): string | null {
  // Failure-class — `frame_stale` is the dishonesty-class error.
  // Other failure reasons (policy_denied, session_closed) are
  // surfaced via the count-based fallback branches and don't need
  // re-correction here. Kept outside the table because it inspects
  // `errorReason`, not `data.<field>` — different shape than the
  // data-driven rules.
  if (!entry.ok) {
    if (entry.errorReason === "frame_stale") {
      return "Actually wait — the page navigated underneath the last action and even the one-shot retry caught a stale frame. Let me re-read the current page state before reporting.";
    }
    return null;
  }

  // Successful tool result — inspect typed-truth fields by walking
  // the rule table.
  const data = entry.data;
  if (data === null || typeof data !== "object") return null;

  const kind = extractActionKind(data);
  if (kind === null) return null;

  for (const rule of DISHONESTY_RULES) {
    if (!rule.claims.includes(claim)) continue;
    if (!rule.toolKinds.has(kind)) continue;
    const value = (data as Record<string, unknown>)[rule.field];
    if (rule.check(value)) return rule.honest;
  }

  return null;
}

/**
 * Test-only export so the drift gate (`check-typed-truth-perception`)
 * can assert that every dishonesty-class-persistent registry entry
 * appears in `DISHONESTY_RULES`. NOT part of the public API; the
 * underscore prefix marks it.
 */
export const __DISHONESTY_RULE_FIELDS: ReadonlySet<string> = new Set(
  DISHONESTY_RULES.map((r) => r.field),
);

/**
 * Top-level intercept. Returns the correction sentence to append to
 * the model's closing text, or null when no contradiction is found.
 *
 * Walk-back semantics for the LAST-RELEVANT guard:
 *   - Find the most recent entry of the relevant kind for this claim.
 *   - Inspect THAT entry for typed-truth dishonesty.
 *   - If a successful action of the same kind FOLLOWED the failure
 *     in the log (i.e., the model retried and recovered), the
 *     dishonesty inspection naturally returns null (the most recent
 *     entry IS the successful retry, not the original failure).
 *
 * The walk-back's "most recent" semantics is the regression guard
 * the reviewer flagged. Test pin (2) exercises the retry-and-recover
 * case explicitly.
 */
export function detectDishonestClosing(args: {
  readonly finalText: string;
  readonly toolResultsLog: readonly ToolResultLogEntry[];
}): string | null {
  const claim = classifyClosingClaim(args.finalText);
  if (claim === null) return null;

  // Pick the relevant-kind set for this claim. Action-class matches
  // any kind via the `matchAnyKind: true` flag.
  let relevantKinds: ReadonlySet<string>;
  let matchAnyKind = false;
  switch (claim) {
    case "submit":
      relevantKinds = SUBMIT_KINDS;
      break;
    case "type":
      relevantKinds = TYPE_KINDS;
      break;
    case "view":
      relevantKinds = VIEW_KINDS;
      break;
    case "action":
      relevantKinds = new Set();
      matchAnyKind = true;
      break;
  }

  const lastRelevant = findMostRecentRelevantEntry(
    args.toolResultsLog,
    relevantKinds,
    matchAnyKind,
  );
  if (lastRelevant === null) return null;

  return inspectDishonesty(lastRelevant, claim);
}
