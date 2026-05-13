/**
 * Typed-truth-perception drift gate.
 *
 * Mechanically enforces the doctrine in
 * [`docs/doctrine/typed-truth-perception.md`](../docs/doctrine/typed-truth-perception.md):
 * every typed-truth field that the AI branches on MUST be both
 *
 *   1. **Mentioned in `PERCEPTION_DOCTRINE`** (`packages/ai-core/src/prompt.ts`)
 *      so the AI knows to read it.
 *   2. **Emitted by at least one dispatch source** so the AI's reading is
 *      grounded in code that actually produces the field at runtime.
 *
 * Without both halves, the prompt drifts from the dispatch (the AI
 * teaches a field that no source emits, or a field is emitted that
 * no AI knows to read). Either drift breaks the doctrine — the prompt
 * becomes the only protection (and confabulates), or the dispatch
 * truth lands in the result and the AI describes it wrong because it
 * has no reading rule.
 *
 * ## Why a registry, not a free scan
 *
 * Field names are arbitrary strings; "typed-truth-shaped" can't be
 * detected from syntax alone. The closed-registry shape (same as
 * `check-tool-modes`, `check-mode-contract-readers`,
 * `check-drop-handlers`) is the right pattern when the canonical set
 * is curated. Adding a new typed-truth field MUST update both halves
 * AND register here — the registry update is the discipline trigger.
 *
 * The gate's bidirectional drift check (every entry must appear in
 * both halves) catches:
 *   - the prompt clause being silently removed (dispatch keeps
 *     emitting; AI stops reading)
 *   - the dispatch enforcement being silently removed (AI keeps
 *     reading a field nothing emits)
 *
 * ## What this scans
 *
 *   - `packages/ai-core/src/prompt.ts` — the canonical prompt source.
 *     Each registry entry's `promptText` must appear here.
 *   - One or more `dispatchSources` per entry — each entry's `field`
 *     must appear in at least one of the listed source files.
 *
 * Source files explicitly listed per-entry rather than walked to
 * keep the gate's scope tight. A new typed-truth source surface
 * (e.g. a future protocol package emitting structured outcomes)
 * adds to the registry; the registry IS the canonical inventory.
 *
 * ## Usage
 *
 *   tsx scripts/check-typed-truth-perception.ts   # exit 1 on drift
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Field-classification taxonomy for typed-truth-perception fields.
 * Each field belongs to exactly one class; the class governs whether
 * the runtime intercept (`packages/ai-core/src/dishonest-closing.ts`)
 * applies and what shape the intercept takes.
 *
 *   `dishonesty-persistent` — model claims success the wire
 *     contradicts; the typed truth is durable (page IS blank, page
 *     IS access-denied, navigation DID NOT trigger). Walk-back
 *     semantics in the runtime intercept assume persistence — the
 *     last relevant entry's value is the truth. Every entry of this
 *     class MUST appear in `DISHONESTY_RULES` (gate enforces).
 *   `dishonesty-transient` — model claims success the wire might
 *     contradict, but the typed truth is transient (slow_load
 *     resolves; page might finish loading between observation and
 *     draft). The walk-back's persistent-state assumption violates
 *     here; runtime intercept is deferred pending transience-aware
 *     semantics (time-budget / polling-aware design).
 *   `dishonesty-narration` — field is the model's IN-FLIGHT narration
 *     (a typed string the model emits as part of its response, not a
 *     wire field on a tool result). Contradiction-check runs against
 *     wire-level typed truth (last-navigate URL, current tool
 *     selection) BEFORE the chrome consumes the field. Validation
 *     lives in `packages/ai-core/src/narration-validation.ts` rather
 *     than `dishonest-closing.ts`'s DISHONESTY_RULES table — the
 *     shape is different (text-vs-typed-truth, not field-vs-typed-
 *     truth). The third graduation of `runtime-invariants-over-
 *     prompt-rules.md`. Currently single-instance
 *     (`task_step_narration`); when a second narration field ships,
 *     a NARRATION_RULES table emerges to parallel DISHONESTY_RULES.
 *   `affordance` — wire field is a HINT pointing at what to do
 *     next, not a failure signal. Out of scope for the runtime
 *     intercept by design; conflating with dishonesty-class would
 *     trigger spurious overrides.
 *   `positive-signal` — wire field flags SUCCESS the model SHOULD
 *     claim. Out of scope by design; the dishonest negation (when
 *     applicable) is captured by sibling dishonesty-persistent
 *     fields' coverage.
 *   `control-state` — wire field is about authority (who is driving),
 *     not truth (did the action land). Different register; intercept
 *     doesn't apply.
 *   `transparency` — wire field is a logging/transparency signal
 *     about runtime behavior (e.g., why bytes were stripped). Not a
 *     closing-claim signal; intercept doesn't apply.
 *
 * Const-string-union enforces deliberate classification at registry
 * insertion time — adding a new field requires picking a class
 * (compile-time error otherwise), which prevents the next sibling
 * sweep from accidentally landing an affordance hint in the
 * dishonesty rules.
 */
type TypedTruthClass =
  | "dishonesty-persistent"
  | "dishonesty-transient"
  | "dishonesty-narration"
  | "affordance"
  | "positive-signal"
  | "control-state"
  | "transparency";

interface TypedTruthField {
  /**
   * The literal field name as emitted by the dispatch. Matches via
   * word-boundary regex against the dispatch source(s); presence in
   * any source counts.
   */
  readonly field: string;
  /**
   * Field-classification — see `TypedTruthClass` for the semantics.
   * Drives the drift gate's "every dishonesty-persistent field
   * appears in DISHONESTY_RULES" assertion.
   */
  readonly class: TypedTruthClass;
  /**
   * The string the gate greps for in `packages/ai-core/src/prompt.ts`.
   * Usually the same as `field` (the prompt names the literal field).
   * Differs only when the prompt clause uses semantic phrasing rather
   * than the literal name — e.g. `not_in_control` is taught via
   * "control denials" / "Runtime gates" in the prompt rather than
   * the wire-format field name.
   */
  readonly promptText: string;
  /**
   * Source files where the field's dispatch enforcement / emission
   * lives. At least one must contain the field name; this enforces
   * that the wire half of the doctrine pair stays present.
   *
   * For tool-result classes, the dispatch source IS the producer —
   * the action-executor emits the field directly on the result
   * struct. For narration class, the producer is a separate explicit
   * tag parser; `dispatchSources` may be empty and Half-2 is skipped
   * (the field never flows through a wire-level dispatch surface).
   *
   * Repo-relative paths.
   */
  readonly dispatchSources: ReadonlyArray<string>;
  /**
   * Half-4 — explicit producer-source files. REQUIRED for narration-
   * class fields (`dishonesty-narration`); ignored for tool-result
   * classes (their producer is implicit in `dispatchSources`).
   *
   * The producer is the runtime code that populates the field at
   * emission time — for narration, the tag parser that converts
   * model output text into the typed field value (e.g.
   * `extractNarrationTag` in `core.ts` paralleling
   * `extractMemoryTags`). At least one source must exist and contain
   * a reference to the field; missing producerSources for a narration
   * field is the half-shipped pattern witnessed 2026-05-12 in commit
   * `8b1d6605` (shipped wire + prompt + validator with no producer;
   * the validator's pass-through fired 100% of the time).
   *
   * Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md §
   * "The four-part typed-truth structure."
   */
  readonly producerSources?: ReadonlyArray<string>;
  /**
   * Half-5 — explicit validator-source files. REQUIRED for narration-
   * class fields. For dishonesty-persistent fields the validator is
   * the `DISHONESTY_RULES` table (Half-3 enforces inclusion); for
   * transient / affordance / positive-signal / control-state /
   * transparency classes, a validator doesn't apply by design.
   *
   * The validator is the runtime code that checks the field's value
   * against wire-level typed truth BEFORE the chrome/UI consumes it,
   * replacing falsified values with templated fallbacks (e.g.
   * `validateTaskStepNarration` in `narration-validation.ts`). At
   * least one source must exist and contain a reference to the field.
   *
   * Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md §
   * "The four-part typed-truth structure."
   */
  readonly validatorSources?: ReadonlyArray<string>;
  /** Brief why-the-shape note. Useful for forensics + future audits. */
  readonly notes?: string;
}

/**
 * The canonical inventory of typed-truth fields the AI branches on.
 * Adding an entry is the discipline-trigger for any new typed-truth
 * field — the gate forces both prompt and dispatch updates land
 * together.
 *
 * Stale-entry detection: if a registered field's `promptText` no
 * longer appears in `prompt.ts`, OR none of its `dispatchSources`
 * contains the literal field name, the gate fails. Removal requires
 * deleting the registry entry AND the prompt clause AND the dispatch
 * code in one pass.
 */
const TYPED_TRUTH_FIELDS: ReadonlyArray<TypedTruthField> = [
  {
    field: "already_there",
    class: "positive-signal",
    promptText: "already_there",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "navigate-noop short-circuit; doNavigate returns the field when urlsAreEquivalent matches the current page url. Shipped 2026-05-09. Positive-signal: model SHOULD claim 'already there' when this fires; no dishonest negation to intercept.",
  },
  {
    field: "not_in_control",
    class: "control-state",
    promptText: "control denials",
    dispatchSources: [
      "services/browser-sandbox/src/action-executor.ts",
      "packages/runtime/src/cloud-browser-dispatcher.ts",
    ],
    notes:
      "Co-browse Slice 1 gate refusal. The prompt clause uses semantic phrasing ('Runtime gates ... arrive as typed errors ... control denials') because the doctrine is gate-pattern, not field-name-shaped — but the dispatch emits the literal `not_in_control` reason. promptText pins the semantic clause. Control-state: about authority (who is driving), not truth (did the action land); different register from dishonesty intercept.",
  },
  {
    field: "text_appeared",
    class: "positive-signal",
    promptText: "text_appeared",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "type-action truth-snapshot: did the typed text actually land in a focused element. Closes the action-truth gap witnessed 2026-05-08. Positive-signal: model SHOULD claim 'typed it' when true; the dishonest-false case is captured by `recovery_hint` (which fires precisely when text_appeared: false) and intercepted there.",
  },
  {
    field: "bytes_omitted_reason",
    class: "transparency",
    promptText: "bytes_omitted_reason",
    dispatchSources: ["packages/ai-core/src/loop.ts"],
    notes:
      "Pixel-consent gate: stripped bytes carry a reason field so the AI describes the gate honestly instead of inferring from missing image content. Transparency-class: a logging signal about runtime behavior, not a closing-claim contradiction.",
  },
  {
    field: "slow_load",
    class: "dishonesty-transient",
    promptText: "slow_load",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Navigate timeout that fell through to the heuristic + screenshot path; ok:true with hedge. Shipped 2026-05-09. Dishonesty-transient: model claiming 'loaded' when slow_load: true is a contradiction, BUT the typed-truth is transient (page may finish loading between observation and draft). The dishonest-closing intercept's walk-back assumes the last-relevant entry's value is the durable state; that assumption violates here. Runtime intercept deferred pending transience-aware semantics (time-budget / polling-aware design).",
  },
  {
    field: "visual_content_detected",
    class: "positive-signal",
    promptText: "visual_content_detected",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Positive-signal: model SHOULD claim 'I see X' when true. The dishonest-false case is structurally equivalent to (`blank_page_detected: true || access_denied_detected: true || bot_detection_detected: true`) per the producer derivation at action-executor.ts:653 — all three sibling fields are dishonesty-persistent and intercepted, so the negation is covered without a separate rule. The producer derivation is pinned by a unit test in action-executor.test.ts to catch the future regression where someone changes the heuristic but forgets to maintain the invariant.",
  },
  {
    field: "blank_page_detected",
    class: "dishonesty-persistent",
    promptText: "blank_page_detected",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Sibling of bot_detection_detected and access_denied_detected. Persistent-state dishonesty: page IS blank, doesn't self-resolve. Intercepted in DISHONESTY_RULES as of 2026-05-12 sweep.",
  },
  {
    field: "access_denied_detected",
    class: "dishonesty-persistent",
    promptText: "access_denied_detected",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Sibling of bot_detection_detected and blank_page_detected. Persistent-state dishonesty: page IS access-denied, doesn't self-resolve. Distinct recovery from bot_detection (try elsewhere vs solve challenge). Intercepted in DISHONESTY_RULES as of 2026-05-12 sweep.",
  },
  {
    field: "bot_detection_detected",
    class: "dishonesty-persistent",
    promptText: "bot_detection_detected",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Sibling of access_denied_detected with distinct recovery semantics: access_denied is page-blocked (try elsewhere); bot_detection is page-challenges-humanness (recovery depends on intent — search → web_search fallback, site-interaction → user handoff). Shipped 2026-05-12 to convert the prompt-only CAPTCHA-fallback teaching from search-routing clause into a runtime-enforced typed reason. Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md.",
  },
  {
    field: "submit_button_id",
    class: "affordance",
    promptText: "submit_button_id",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Form-submission typed-truth hint: the dispatcher detects the page's primary submit button (HTML input_type='submit' first, label heuristic — Search/Submit/Send/Sign in/Continue — as fallback) and surfaces its element_id on read_page results. Converted the click_element-over-key('Enter') prompt clause from B-grade (pure teaching) to A-grade (wire field + dispatch + thin teaching). Shipped 2026-05-12; doctrine exemplar of B→A graduation per docs/doctrine/runtime-invariants-over-prompt-rules.md — the doctrine being applied to itself. Affordance-class: a hint pointing at what to click next, not a failure signal; out of scope for the dishonesty intercept by design.",
  },
  {
    field: "recovery_hint",
    class: "dishonesty-persistent",
    promptText: "recovery_hint",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Type-action recovery hint when text_appeared is false. Dispatcher attaches `recovery_hint: \"read_page_then_type_into\"` to the type result so the AI's natural next step is the durable element-addressed path (read_page → type_into, atomic focus + type) instead of coordinate click + retype (which hits the same focus race). Closes the 2026-05-12 witnessed bug where the AI saw text_appeared: false, said 'Clicking it first, then typing. Done.' — the coordinate remediation failed the same way and the AI confabulated success. Shipped 2026-05-12; doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md § typed-truth-perception triple.",
  },
  {
    field: "navigation_triggered",
    class: "dishonesty-persistent",
    promptText: "navigation_triggered",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "click_element + key truth-feedback: did the action cause the page URL to change? Dispatcher captures page.url() before + after the action; result carries `navigation_triggered: true` when URL moved, false when click/keystroke landed but page didn't navigate. Closes the 2026-05-12 witnessed bug where the AI called click_element(submit_button_id), got ok: true, said 'Done' — but the form submission was blocked by Google's promo overlay and the page stayed on the homepage. The wire field had been emitted on click_element since the action shipped, but neither the prompt taught reading it nor was it registered here, so the AI ignored the false flag and confabulated completion. The drift class this gate (#80) exists to catch — silent typed truth (the wire carries the answer but the AI describes it wrong because no reading rule). Extended to key results 2026-05-12 to cover the form-submit-via-Enter path. Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md § typed-truth-perception triple.",
  },
  {
    field: "task_step_narration",
    class: "dishonesty-narration",
    promptText: "task_step_narration",
    // No wire dispatch — narration is not emitted on a tool result;
    // it flows from model text → producer (extractNarrationTag) →
    // AIResponse field → validator → chrome. Half-2 skips for
    // narration class; producer + validator are the load-bearing
    // pair (Half-4 + Half-5).
    dispatchSources: [],
    producerSources: ["packages/ai-core/src/core.ts"],
    validatorSources: ["packages/ai-core/src/narration-validation.ts"],
    notes:
      "In-flight narration field — the model emits `<narration>...</narration>` tags in its response text; the producer `extractNarrationTag` (in core.ts paralleling `extractMemoryTags`) parses the tag into the typed `task_step_narration` field on AIResponse. The chrome's `motebit × virtual_browser` register consumes the field; runtime validation in `validateTaskStepNarration` runs BEFORE the chrome reads it, replacing falsified narrations with runtime-templated fallbacks. Currently one rule (URL-mention contradiction). Third graduation of runtime-invariants-over-prompt-rules — the typed-truth-perception triple applied to in-flight motebit-voiced text. Doctrine: docs/doctrine/chrome-as-state-render.md § Hybrid narration source + docs/doctrine/runtime-invariants-over-prompt-rules.md § The four-part typed-truth structure. Producer-gap bug class (commit 8b1d6605: wire + prompt + validator shipped with no producer; validator pass-through fired 100% of the time) caught by user intuition before push, fixed in cf1227d0; Half-4 + Half-5 now structurally enforce the four-part shape for narration class.",
  },
];

interface Violation {
  field: string;
  reason: string;
  remediation: string;
}

function readFile(path: string): string {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch (err) {
    return "";
  }
}

function fieldAppearsIn(field: string, source: string): boolean {
  // Word-boundary match — accidental substring matches (e.g. a JS
  // identifier starting with "already_there_v2") shouldn't bypass.
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(source);
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const promptSource = readFile("packages/ai-core/src/prompt.ts");
  if (promptSource === "") {
    return [
      {
        field: "(N/A)",
        reason: "could not read packages/ai-core/src/prompt.ts",
        remediation: "Verify the prompt source exists and is readable.",
      },
    ];
  }

  // Half 3 source: parse the runtime intercept's DISHONESTY_RULES
  // table to confirm every dishonesty-class-persistent registry entry
  // has a corresponding rule. The table lives in
  // `packages/ai-core/src/dishonest-closing.ts` as a `const
  // DISHONESTY_RULES: readonly DishonestyRule[] = [...]`. Read once
  // here, parse the `field: "..."` strings, compare against the
  // registry's dishonesty-persistent entries.
  //
  // Why parse vs import: this script runs at gate time, not in the
  // application; importing across package boundaries from a script
  // is brittle (build state, ESM resolution). Greppy parse is
  // cheaper and the contract — `field: "<name>"` rows in the table
  // — is stable.
  const interceptSource = readFile("packages/ai-core/src/dishonest-closing.ts");
  const interceptFieldRegex = /field:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g;
  const interceptedFields = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = interceptFieldRegex.exec(interceptSource)) !== null) {
    interceptedFields.add(match[1]!);
  }

  for (const entry of TYPED_TRUTH_FIELDS) {
    // Half 1: prompt clause must contain promptText.
    if (!promptSource.includes(entry.promptText)) {
      violations.push({
        field: entry.field,
        reason: `prompt clause missing — promptText "${entry.promptText}" not found in packages/ai-core/src/prompt.ts`,
        remediation: `Restore the PERCEPTION_DOCTRINE clause that teaches the AI to read \`${entry.field}\`. Either re-add the prompt clause OR remove the registry entry in scripts/check-typed-truth-perception.ts (and update docs/doctrine/typed-truth-perception.md instances list to match).`,
      });
    }

    // Half 2: at least one dispatch source must contain the literal
    // field name. Skipped for narration class (no wire dispatch —
    // narration flows from model text through an explicit producer,
    // not through a wire-format emission surface; Half-4 covers the
    // producer side).
    if (entry.class !== "dishonesty-narration") {
      const dispatchHits = entry.dispatchSources.filter((path) => {
        const src = readFile(path);
        return src !== "" && fieldAppearsIn(entry.field, src);
      });
      if (dispatchHits.length === 0) {
        violations.push({
          field: entry.field,
          reason: `dispatch enforcement missing — \`${entry.field}\` not found in any of: ${entry.dispatchSources.join(", ")}`,
          remediation: `Restore the dispatch-side emission of \`${entry.field}\` in one of the listed source files OR update the dispatchSources array in scripts/check-typed-truth-perception.ts to point at the new home (then update docs/doctrine/typed-truth-perception.md to match).`,
        });
      }
    }

    // Half 3 (sync-invariant): every dishonesty-persistent field MUST
    // appear in the runtime intercept's DISHONESTY_RULES table. This
    // is the meta-pattern that catches the next sibling sweep's "you
    // forgot a sibling" drift mechanically rather than by reviewer
    // eyeball — the canonical typed-truth-perception triple (wire +
    // prompt + runtime) becomes structurally enforceable. Other
    // classes (transient, affordance, positive-signal, control-state,
    // transparency) are out of scope by design and don't appear in
    // the table; the gate doesn't assert their absence (the rule is
    // append-only enforcement, not exhaustive class enforcement).
    if (entry.class === "dishonesty-persistent" && !interceptedFields.has(entry.field)) {
      violations.push({
        field: entry.field,
        reason: `dishonesty-persistent field missing from runtime intercept — \`${entry.field}\` not found in DISHONESTY_RULES table at packages/ai-core/src/dishonest-closing.ts`,
        remediation: `Add a DISHONESTY_RULES entry for \`${entry.field}\` so the runtime intercept catches model claims that contradict it. The rule shape: { claims, toolKinds, field: "${entry.field}", check: <predicate>, honest: "<correction text>" }. Mirror the existing rules; the test surface in dishonest-closing.test.ts will need three new pins (triggers-on-failure / retry-recovers / register-distinction).`,
      });
    }

    // Half 4 + Half 5 (four-part-triple structural enforcement): every
    // narration-class field MUST declare an explicit producer source
    // AND an explicit validator source, each containing the field
    // name. The doctrine names the four-part structure (wire + prompt
    // + producer + validator) and the producer-gap bug class — commit
    // 8b1d6605 shipped wire + prompt + validator for `task_step_
    // narration` with no producer; the validator's pass-through fired
    // 100% of the time. The triple was structurally complete on the
    // registry side, inert at runtime. These halves graduate the
    // doctrine's "deferred reviewer-discipline check" to mechanical
    // enforcement for narration class (where the producer is
    // explicit, not folded into dispatch).
    //
    // Why only narration class. Tool-result classes have implicit
    // producer = dispatch (Half-2 covers); dishonesty-persistent has
    // implicit validator = DISHONESTY_RULES (Half-3 covers).
    // Narration is the class where both producer + validator are
    // explicit separate code paths the registry must name.
    //
    // Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md
    // § "The four-part typed-truth structure."
    if (entry.class === "dishonesty-narration") {
      const producerSources = entry.producerSources ?? [];
      if (producerSources.length === 0) {
        violations.push({
          field: entry.field,
          reason: `producer source missing — narration-class field \`${entry.field}\` must declare \`producerSources\` (the runtime code that populates the field from model output text)`,
          remediation: `Add \`producerSources: ["<path>"]\` to the \`${entry.field}\` registry entry, pointing at the file containing the tag parser (e.g. \`extractNarrationTag\` in packages/ai-core/src/core.ts). The half-shipped pattern this catches: shipping wire + prompt + validator without a producer means the validator's pass-through branch fires 100% of the time (witnessed 2026-05-12 in commit 8b1d6605). Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md § The four-part typed-truth structure.`,
        });
      } else {
        const producerHits = producerSources.filter((path) => {
          const src = readFile(path);
          return src !== "" && fieldAppearsIn(entry.field, src);
        });
        if (producerHits.length === 0) {
          violations.push({
            field: entry.field,
            reason: `producer source declared but field not found — \`${entry.field}\` not present in any of: ${producerSources.join(", ")}`,
            remediation: `Either restore the producer (tag parser) that populates \`${entry.field}\` in one of the listed sources OR update \`producerSources\` in scripts/check-typed-truth-perception.ts to point at the new home.`,
          });
        }
      }

      const validatorSources = entry.validatorSources ?? [];
      if (validatorSources.length === 0) {
        violations.push({
          field: entry.field,
          reason: `validator source missing — narration-class field \`${entry.field}\` must declare \`validatorSources\` (the runtime code that checks the field against wire-level typed truth before the consumer reads)`,
          remediation: `Add \`validatorSources: ["<path>"]\` to the \`${entry.field}\` registry entry, pointing at the file containing the validator (e.g. \`validateTaskStepNarration\` in packages/ai-core/src/narration-validation.ts). The validator's job is catching falsified narrations before the chrome consumes them; without it the chrome renders model claims that contradict wire-level truth. Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md § The four-part typed-truth structure.`,
        });
      } else {
        const validatorHits = validatorSources.filter((path) => {
          const src = readFile(path);
          return src !== "" && fieldAppearsIn(entry.field, src);
        });
        if (validatorHits.length === 0) {
          violations.push({
            field: entry.field,
            reason: `validator source declared but field not found — \`${entry.field}\` not present in any of: ${validatorSources.join(", ")}`,
            remediation: `Either restore the validator that checks \`${entry.field}\` in one of the listed sources OR update \`validatorSources\` in scripts/check-typed-truth-perception.ts to point at the new home.`,
          });
        }
      }
    }
  }
  return violations;
}

function main(): void {
  console.log(
    "▸ check-typed-truth-perception — every registered typed-truth field travels with its full four-part structure: wire + prompt + producer + validator. Half 1 asserts the PERCEPTION_DOCTRINE clause (packages/ai-core/src/prompt.ts). Half 2 asserts dispatch presence (the implicit producer for tool-result classes). Half 3 asserts DISHONESTY_RULES inclusion for dishonesty-persistent fields. Half 4 + Half 5 assert explicit producer + validator sources for narration-class fields (closing the producer-gap bug class witnessed in commit 8b1d6605 where wire + prompt + validator shipped without a producer). Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md § The four-part typed-truth structure + docs/doctrine/typed-truth-perception.md; principle in CLAUDE.md `Typed truth on results, prompt for interpretation`",
  );
  const violations = scan();
  if (violations.length === 0) {
    const narrationCount = TYPED_TRUTH_FIELDS.filter(
      (f) => f.class === "dishonesty-narration",
    ).length;
    console.log(
      `✓ check-typed-truth-perception: ${TYPED_TRUTH_FIELDS.length} field(s) registered, all four-part-complete (prompt + dispatch + class-specific producer/validator; ${narrationCount} narration-class field(s) with explicit producer + validator).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-typed-truth-perception: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.field}] ${v.reason}`);
    console.error(`    fix: ${v.remediation}\n`);
  }
  console.error(
    "Doctrine: every typed-truth field travels with its full four-part structure — wire + prompt + producer + validator. New fields ship with all four. See docs/doctrine/runtime-invariants-over-prompt-rules.md § The four-part typed-truth structure + docs/doctrine/typed-truth-perception.md.",
  );
  process.exit(1);
}

main();
