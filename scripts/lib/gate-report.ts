/**
 * Gate failure reporting — the repair-instruction contract for drift gates.
 *
 * Every drift gate, WHEN IT FAILS, must tell the reader not just WHAT broke
 * but HOW to fix it: the canonical source of truth AND the concrete edit. This
 * is the agentic-era invariant — an agent (or human) who hits a red gate should
 * be able to close the loop from the failure text alone, without
 * reverse-engineering the gate. A gate that only prints "N violation(s)" makes
 * the reader the parser; a gate that names the canonical file and the exact
 * edit makes the fix self-serviceable.
 *
 * Two surfaces, one contract:
 *
 *   - `hasRepairInstruction(output)` — the CONTRACT, enforced as an OUTCOME.
 *     Given a gate's captured failure output (stdout+stderr), decide whether it
 *     carries a repair instruction. `check-gates-effective` already drives every
 *     gate into failure to prove it bites; it calls this against that real,
 *     probe-induced failure output, so a gate that bites but emits no repair
 *     instruction fails the effectiveness run. New gates comply or CI goes red.
 *     The contract is on the OUTPUT, not the mechanism — a gate may print however
 *     it likes, as long as the text names a canonical source and an action.
 *
 *   - `failWithRepair(report)` — the CONVENIENCE, raising the ceiling. A one-call
 *     way to emit a contract-satisfying failure block and exit non-zero. Not
 *     mandatory, but the house-standard shape; the gates brought up to the
 *     contract route through it. You cannot call it without supplying both a
 *     canonical source and a fix — the repair instruction is structurally
 *     unavoidable.
 *
 * The contract is a FLOOR (points at the source + names an action), not a prose
 * quality bar — that isn't mechanically checkable. `failWithRepair` is how a
 * gate clears the ceiling above the floor. Tighten the floor in one place (the
 * matchers below) if it ever proves too lenient.
 *
 * ## The sibling contract: aperture
 *
 * `hasRepairInstruction` governs what a gate owes its reader WHEN IT FAILS.
 * `hasApertureDisclosure` governs what a scanning gate owes its reader WHEN IT
 * PASSES: how much it actually examined.
 *
 * A green gate makes a claim, and the claim is only as wide as the gate's
 * aperture. `check-affordance-routing` enforced surface determinism while
 * scanning 57 of 322 app source files — six of nine apps saw ZERO files — and
 * printed "9 apps clean" (#545). It was not wrong about what it looked at; it
 * was silent about how little that was. Seven separate instances of the same
 * shape surfaced in a single day: a gate green because it is not looking.
 *
 * The failure is invisible by construction. A gate with a narrow aperture never
 * goes red, so nothing prompts anyone to check it, and a hardcoded candidate
 * list narrows silently every time the repo grows. Disclosure is the cheapest
 * defense: a reader who sees "322 file(s) scanned" can sanity-check the number
 * against the repo; a reader who sees "clean" cannot.
 *
 * Doctrine: docs/doctrine/gate-repair-instructions.md.
 */

/**
 * A canonical-source pointer: a repo path with a known extension, or a
 * `@motebit/<pkg>` package symbol. This is the "where the truth lives" half.
 */
const CANONICAL_POINTER =
  /(?:@motebit\/[a-z][a-z0-9-]*)|(?:\b(?:[\w.@-]+\/){2,}[\w.@-]*)|(?:\b(?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|mdx|json|jsonc|toml|ya?ml|sol|sh|rs|html?))\b/;

/** A runnable command the reader can paste — the strongest directive shape. */
const COMMAND_DIRECTIVE = /\b(?:pnpm|npm|npx|yarn|tsx|node|git)\s+[\w@./:=-]+/;

/** An explicit fix label (`Fix:`, `Resolution:`, …). */
const FIX_LABEL = /\b(?:fix|repair|resolution|remediation|how to fix|to fix)\b\s*:/i;

/**
 * An imperative repair verb. Only counts toward the contract alongside a
 * canonical pointer, so the breadth here can't pass a pointer-less message.
 */
const IMPERATIVE =
  /\b(?:fix|correct|import|re-?export|export|routes? (?:it )?through|wire (?:it )?through|register|replace|add|append|insert|consume|call|declare|annotate|pin|align|move|rename|update|remove|drop|delete|restore|regenerate|run|change|use|inspect|raise|enter|document|mirror|split|include|take|pass|narrow|set|provide)\b/i;

// Strip SGR color codes so the matchers see plain text regardless of whether the
// gate emitted ANSI. Built via RegExp to keep the literal escape byte out of
// source (no-control-regex).
const ANSI = new RegExp("\\u001b\\[[0-9;]*m", "g");

export interface RepairCheck {
  ok: boolean;
  /** Present when `!ok` — which half of the contract the output is missing. */
  reason?: string;
}

/**
 * The repair-instruction contract. Failure output satisfies it iff it names a
 * canonical source pointer AND an actionable directive (a runnable command, a
 * `Fix:`-style label, or an imperative repair verb).
 */
export function hasRepairInstruction(output: string): RepairCheck {
  const text = output.replace(ANSI, "");
  const pointer = CANONICAL_POINTER.test(text);
  const directive = COMMAND_DIRECTIVE.test(text) || FIX_LABEL.test(text) || IMPERATIVE.test(text);
  if (pointer && directive) return { ok: true };
  const missing: string[] = [];
  if (!pointer)
    missing.push(
      "a canonical-source pointer (a repo path like `packages/x/src/y.ts` or a `@motebit/<pkg>` symbol)",
    );
  if (!directive)
    missing.push(
      "an actionable directive (a runnable `pnpm …`/`npm …` command, a `Fix:` label, or an imperative verb like `import`/`route through`/`add`/`replace`)",
    );
  return { ok: false, reason: `failure output is missing ${missing.join(" and ")}` };
}

/**
 * A stated count of what was examined: "322 file(s) scanned", "63 packages
 * checked", "108 doc(s) scanned", "14 required pair(s) validated".
 *
 * The unit is deliberately open — gates count files, packages, routes, specs,
 * subcommands, exports, waivers — so the contract is A NUMBER BOUND TO A
 * COUNTABLE NOUN, never a fixed phrase. Up to three tokens may sit between them
 * ("17 `/api/v1/admin/*` route(s)", "943 permissive-floor exports"), because
 * real gate output interleaves paths and adjectives.
 *
 * `0` counts as disclosure, deliberately: "0 files scanned" is an honest and
 * alarming statement. What is forbidden is silence, not emptiness.
 *
 * Time units are excluded explicitly. Nearly every gate prints a duration, and
 * "738ms" is a number next to a word ending in `s` — matching it would make the
 * contract vacuous by passing every gate that reports how long it took.
 */
const TIME_UNIT = /^(?:m?s|sec|secs|seconds?|min|mins|minutes?|ms\b)$/i;

/** A word that can plausibly be counted — plural, or an explicit `(s)` form. */
const COUNTABLE = /^(?:[a-z][a-z-]{2,}\(s\)|[a-z][a-z-]{2,}s)$/i;

export interface ApertureCheck {
  ok: boolean;
  /** Present when `!ok` — what the success output failed to state. */
  reason?: string;
}

/**
 * The aperture-disclosure contract, for gates that scan a candidate set.
 *
 * Success output satisfies it iff it states HOW MUCH was examined. This is
 * checked on the PASSING output — the inverse surface to
 * `hasRepairInstruction`, which is checked on the failing output.
 *
 * Like the repair contract, this is a FLOOR: it proves the gate said a number,
 * not that the number is the right one. No mechanical check can know a gate's
 * true candidate set — that is the author's judgement. What it can do is make
 * the aperture visible, so a wrong one is arguable instead of invisible.
 */
export function hasApertureDisclosure(output: string): ApertureCheck {
  const text = output.replace(ANSI, "");
  for (const m of text.matchAll(/\b\d[\d,_]*\b(.{0,48})/gs)) {
    const tokens = (m[1] ?? "")
      .split(/[\s]+/)
      .map((t) => t.replace(/^[^A-Za-z(]+|[^A-Za-z)]+$/g, ""))
      .filter((t) => t.length > 0)
      .slice(0, 4);
    if (tokens.some((t) => !TIME_UNIT.test(t) && COUNTABLE.test(t))) return { ok: true };
  }
  return {
    ok: false,
    reason:
      "success output states no aperture — a reader cannot tell whether 'clean' means " +
      "'examined everything and found nothing' or 'examined nothing'. State the count " +
      "(e.g. `322 file(s) scanned`, `63 packages checked`).",
  };
}

export interface RepairReport {
  /** What broke — the invariant, in one line. */
  invariant: string;
  /**
   * The canonical source of truth: the file (or `@motebit/<pkg>` symbol) that
   * decides what's correct. Must be a real path/symbol — it satisfies the
   * pointer half of the contract.
   */
  canonical: string;
  /** The concrete edit or command that fixes it. Imperative; name the target. */
  fix: string;
  /** The offending sites the gate found, if any (each ideally `file:line`). */
  sites?: string[];
  /** Optional doctrine/spec pointer for the "why". */
  doctrine?: string;
}

/**
 * Print a house-standard failure block (satisfying the repair contract) and
 * exit 1. The required `canonical` + `fix` fields make the repair instruction
 * structurally unavoidable — you cannot call this without supplying both.
 */
export function failWithRepair(report: RepairReport): never {
  process.stderr.write(formatRepair(report));
  process.exit(1);
}

/** The failure block `failWithRepair` prints — exposed for gates that batch findings. */
export function formatRepair(report: RepairReport): string {
  const { invariant, canonical, fix, sites, doctrine } = report;
  let out = `\n✗ ${invariant}\n`;
  if (sites && sites.length > 0) {
    out += `\n  Offending site(s):\n`;
    for (const s of sites) out += `    - ${s}\n`;
  }
  out += `\n  Canonical source: ${canonical}\n`;
  out += `  Fix: ${fix}\n`;
  if (doctrine) out += `  Doctrine: ${doctrine}\n`;
  return out + "\n";
}
