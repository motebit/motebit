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

interface TypedTruthField {
  /**
   * The literal field name as emitted by the dispatch. Matches via
   * word-boundary regex against the dispatch source(s); presence in
   * any source counts.
   */
  readonly field: string;
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
   * Repo-relative paths.
   */
  readonly dispatchSources: ReadonlyArray<string>;
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
    promptText: "already_there",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "navigate-noop short-circuit; doNavigate returns the field when urlsAreEquivalent matches the current page url. Shipped 2026-05-09.",
  },
  {
    field: "not_in_control",
    promptText: "control denials",
    dispatchSources: [
      "services/browser-sandbox/src/action-executor.ts",
      "packages/runtime/src/cloud-browser-dispatcher.ts",
    ],
    notes:
      "Co-browse Slice 1 gate refusal. The prompt clause uses semantic phrasing ('Runtime gates ... arrive as typed errors ... control denials') because the doctrine is gate-pattern, not field-name-shaped — but the dispatch emits the literal `not_in_control` reason. promptText pins the semantic clause.",
  },
  {
    field: "text_appeared",
    promptText: "text_appeared",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "type-action truth-snapshot: did the typed text actually land in a focused element. Closes the action-truth gap witnessed 2026-05-08.",
  },
  {
    field: "bytes_omitted_reason",
    promptText: "bytes_omitted_reason",
    dispatchSources: ["packages/ai-core/src/loop.ts"],
    notes:
      "Pixel-consent gate: stripped bytes carry a reason field so the AI describes the gate honestly instead of inferring from missing image content.",
  },
  {
    field: "slow_load",
    promptText: "slow_load",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Navigate timeout that fell through to the heuristic + screenshot path; ok:true with hedge. Shipped 2026-05-09.",
  },
  {
    field: "visual_content_detected",
    promptText: "visual_content_detected",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
  },
  {
    field: "blank_page_detected",
    promptText: "blank_page_detected",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
  },
  {
    field: "access_denied_detected",
    promptText: "access_denied_detected",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
  },
  {
    field: "bot_detection_detected",
    promptText: "bot_detection_detected",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Sibling of access_denied_detected with distinct recovery semantics: access_denied is page-blocked (try elsewhere); bot_detection is page-challenges-humanness (recovery depends on intent — search → web_search fallback, site-interaction → user handoff). Shipped 2026-05-12 to convert the prompt-only CAPTCHA-fallback teaching from search-routing clause into a runtime-enforced typed reason. Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md.",
  },
  {
    field: "submit_button_id",
    promptText: "submit_button_id",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Form-submission typed-truth hint: the dispatcher detects the page's primary submit button (HTML input_type='submit' first, label heuristic — Search/Submit/Send/Sign in/Continue — as fallback) and surfaces its element_id on read_page results. Converted the click_element-over-key('Enter') prompt clause from B-grade (pure teaching) to A-grade (wire field + dispatch + thin teaching). Shipped 2026-05-12; doctrine exemplar of B→A graduation per docs/doctrine/runtime-invariants-over-prompt-rules.md — the doctrine being applied to itself.",
  },
  {
    field: "recovery_hint",
    promptText: "recovery_hint",
    dispatchSources: ["services/browser-sandbox/src/action-executor.ts"],
    notes:
      "Type-action recovery hint when text_appeared is false. Dispatcher attaches `recovery_hint: \"read_page_then_type_into\"` to the type result so the AI's natural next step is the durable element-addressed path (read_page → type_into, atomic focus + type) instead of coordinate click + retype (which hits the same focus race). Closes the 2026-05-12 witnessed bug where the AI saw text_appeared: false, said 'Clicking it first, then typing. Done.' — the coordinate remediation failed the same way and the AI confabulated success. Shipped 2026-05-12; doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md § typed-truth-perception triple.",
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

  for (const entry of TYPED_TRUTH_FIELDS) {
    // Half 1: prompt clause must contain promptText.
    if (!promptSource.includes(entry.promptText)) {
      violations.push({
        field: entry.field,
        reason: `prompt clause missing — promptText "${entry.promptText}" not found in packages/ai-core/src/prompt.ts`,
        remediation: `Restore the PERCEPTION_DOCTRINE clause that teaches the AI to read \`${entry.field}\`. Either re-add the prompt clause OR remove the registry entry in scripts/check-typed-truth-perception.ts (and update docs/doctrine/typed-truth-perception.md instances list to match).`,
      });
    }

    // Half 2: at least one dispatch source must contain the literal field name.
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
  return violations;
}

function main(): void {
  console.log(
    "▸ check-typed-truth-perception — every registered typed-truth field appears in BOTH the AI's PERCEPTION_DOCTRINE clause (packages/ai-core/src/prompt.ts) AND at least one dispatch source. Closes the doctrine drift class where one half quietly disappears: prompt teaches a field nothing emits (confabulation), or dispatch emits a field the AI doesn't know to read (silent typed truth). Doctrine: docs/doctrine/typed-truth-perception.md; principle in CLAUDE.md `Typed truth on results, prompt for interpretation`",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-typed-truth-perception: ${TYPED_TRUTH_FIELDS.length} field(s) registered, all paired (prompt clause + dispatch source).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-typed-truth-perception: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.field}] ${v.reason}`);
    console.error(`    fix: ${v.remediation}\n`);
  }
  console.error(
    "Doctrine: every typed-truth field travels with its pair — prompt clause + dispatch enforcement. New fields ship with both. See docs/doctrine/typed-truth-perception.md.",
  );
  process.exit(1);
}

main();
